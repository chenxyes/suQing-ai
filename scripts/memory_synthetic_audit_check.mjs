import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memory-synthetic-audit-'));
const source=path.join(dir,'source.db');
process.env.DB_PATH=source;process.env.LOG_DIR=path.join(dir,'logs');
const m=await import('../src/db.mjs');const db=m.getDb();db.pragma('foreign_keys=OFF');
if(!db.pragma('table_info(companion_memories)').some(c=>c.name==='memory_origin'))db.exec("ALTER TABLE companion_memories ADD COLUMN memory_origin TEXT DEFAULT 'unknown'");
for(const [cid,uid] of [[1,11],[2,22]])db.prepare('INSERT INTO companions(id,user_id,bot_id) VALUES(?,?,?)').run(cid,uid,`fixture-${cid}`);
const add=(cid,uid,content)=>m.saveMemory({companionId:cid,userId:uid,memoryType:'event',content});
const candidate=add(1,11,'雨天送伞（3 天前发生）');
const otherScope=add(1,11,'异处话题（3 天前发生）');
const missingFormat=add(1,11,'雨天送伞');
const ordinary=add(1,11,'我喜欢游泳');
const wrongOwner=add(1,99,'雨天送伞（3 天前发生）');
const derived=m.saveMemory({companionId:1,userId:11,memoryType:'weekly_summary',content:'来源摘要',sourceMemoryIds:[candidate]});
const observed=add(1,11,'雨天送伞（3 天前发生）');
db.prepare("UPDATE companion_memories SET memory_origin='observed' WHERE id=?").run(observed);
const second=add(2,22,'异处话题（2 天前发生）');
const importedTopic=add(1,11,'导入者声称的话题（4 天前发生）');
m.bulkInsertSyntheticTurns(1,[{role:'assistant',content:'合成对话甲',topic:'雨天送伞',created_at:'2026-01-01T00:00:00Z'}]);
m.bulkInsertSyntheticTurns(2,[{role:'assistant',content:'合成对话乙',topic:'异处话题',created_at:'2026-01-01T00:00:00Z'}]);
db.prepare('INSERT INTO companion_conversation_turns(companion_id,role,content,topic,synthetic,import_unverified) VALUES(?,?,?,?,1,1)')
 .run(1,'assistant','未核实的导入话语','导入者声称的话题');
db.close();
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originalHash=hash(source);
const originalFiles=fs.readdirSync(dir).filter(name=>name.startsWith('source.db'));
let sequence=0,report;
function run(args=[],input=source){return spawnSync(process.execPath,['scripts/memory_synthetic_audit.mjs','--db',input,...args],{encoding:'utf8',env:{...process.env,LOG_DIR:path.join(dir,'child-logs')}});}
function manifestFor(ids=[candidate]){
 return {version:1,source_identity:report.source_identity,entries:ids.map(id=>{
  const row=report.rows.find(row=>row.memory_id===id);
  return {memory_id:id,companion_id:row.companion_id,user_id:row.user_id,content_sha256:row.content_sha256,
   expected_recall_revision:row.recall_revision,action:'quarantine_synthetic'};
 })};
}
function apply(manifest,output=path.join(dir,`copy-${++sequence}.db`),input=source){
 const file=path.join(dir,`manifest-${++sequence}.json`);fs.writeFileSync(file,JSON.stringify(manifest));
 return {result:run(['--manifest',file,'--output-db',output],input),output};
}
try{
 await test('default audit is read-only, includes every unknown row, and only flags exact scoped synthetic patterns',()=>{
  const reportFile=path.join(dir,'audit.json');const result=run(['--report',reportFile]);assert.equal(result.status,0,result.stderr);
  report=JSON.parse(fs.readFileSync(reportFile,'utf8'));
  assert.equal(report.mode,'read-only');assert.equal(report.total,9);assert.equal(report.unknown,8);assert.equal(report.rows.length,8);
  assert.deepEqual(report.rows.filter(row=>row.suspected).map(row=>row.memory_id),[candidate,second]);
  for(const id of [otherScope,missingFormat,ordinary,wrongOwner,derived,importedTopic])assert.equal(report.rows.find(row=>row.memory_id===id).suspected,false);
  assert.ok(!JSON.stringify(report).includes('雨天送伞'));assert.ok(!result.stdout.includes('合成对话'));assert.equal(hash(source),originalHash);
  assert.deepEqual(fs.readdirSync(dir).filter(name=>name.startsWith('source.db')),originalFiles,'audit must not create source WAL/SHM');
 });
 await test('legacy audit never initializes the app or adds migration columns',()=>{
  const file=path.join(dir,'legacy.db');const legacy=new Database(file);
  legacy.exec("CREATE TABLE companions(id INTEGER,user_id INTEGER);CREATE TABLE companion_memories(id INTEGER,companion_id INTEGER,user_id INTEGER,content TEXT);CREATE TABLE companion_conversation_turns(id INTEGER,companion_id INTEGER,synthetic INTEGER,topic TEXT);INSERT INTO companions VALUES(1,11);INSERT INTO companion_memories VALUES(1,1,11,'旧事（1 天前发生）');INSERT INTO companion_conversation_turns VALUES(1,1,1,'旧事')");legacy.close();
  const before=hash(file);const result=run([],file);assert.equal(result.status,0,result.stderr);assert.equal(hash(file),before);
  const inspect=new Database(file,{readonly:true});assert.ok(!inspect.pragma('table_info(companion_memories)').some(c=>c.name==='memory_origin'));inspect.close();
 });
 await test('reviewed manifest creates a private new copy and quarantines selected rows with dependent invalidation',()=>{
  const {result,output}=apply(manifestFor([candidate,second]));assert.equal(result.status,0,result.stderr);
  const copied=new Database(output,{readonly:true});
  for(const id of [candidate,second])assert.equal(copied.prepare('SELECT memory_origin FROM companion_memories WHERE id=?').get(id).memory_origin,'synthetic');
  assert.equal(copied.prepare('SELECT recall_blocked FROM companion_memories WHERE id=?').get(derived).recall_blocked,1);
  assert.equal(copied.prepare('SELECT memory_origin FROM companion_memories WHERE id=?').get(ordinary).memory_origin,'unknown');
  assert.equal(copied.pragma('integrity_check',{simple:true}),'ok');copied.close();
  assert.equal(fs.statSync(output).mode & 0o077,0);assert.equal(hash(source),originalHash);
 });
 await test('existing output, source path and source symlink cannot be overwritten',()=>{
  const existing=path.join(dir,'existing.db');fs.writeFileSync(existing,'untouched');
  assert.notEqual(apply(manifestFor(),existing).result.status,0);assert.equal(fs.readFileSync(existing,'utf8'),'untouched');
  assert.notEqual(apply(manifestFor(),source).result.status,0);
  const link=path.join(dir,'source-link.db');fs.symlinkSync(source,link);assert.notEqual(apply(manifestFor(),link).result.status,0);
  assert.equal(hash(source),originalHash);
 });
 await test('source sidecar paths cannot be selected for output databases or reports',()=>{
  for(const suffix of ['-wal','-shm','-journal']){
   const file=source+suffix;
   assert.notEqual(apply(manifestFor(),file).result.status,0);
   assert.equal(fs.existsSync(file),false,'rejected output must not create a source sidecar');
   assert.notEqual(run(['--report',file]).status,0);
   assert.equal(fs.existsSync(file),false,'report must not create a source sidecar');
  }
  assert.equal(hash(source),originalHash);
 });
 for(const mode of ['report','output-db']){
  await test(`configured and default runtime database paths and sidecars reject ${mode} output`,()=>{
   const script=path.resolve('scripts/memory_synthetic_audit.mjs');
   const manifest=path.join(dir,`runtime-${mode}-manifest.json`);fs.writeFileSync(manifest,JSON.stringify(manifestFor()));
   for(const configured of [true,false]){
    const cwd=path.join(dir,`runtime-${mode}-${configured}`);fs.mkdirSync(path.join(cwd,'data'),{recursive:true});
    const runtime=path.join(cwd,configured?'runtime.db':'data/bot.db');fs.copyFileSync(source,runtime);
    const alias=path.join(cwd,'alias');fs.symlinkSync(path.dirname(runtime),alias);
    const env={...process.env,LOG_DIR:path.join(cwd,'logs')};
    if(configured)env.DB_PATH=runtime;else delete env.DB_PATH;
    for(const suffix of ['-wal','-shm','-journal','']){
     const output=path.join(alias,path.basename(runtime)+suffix);
     const args=['--db',source,...(mode==='report'?['--report',output]:['--manifest',manifest,'--output-db',output])];
     const result=spawnSync(process.execPath,[script,...args],{cwd,env,encoding:'utf8'});
     assert.notEqual(result.status,0,`${mode} must reject runtime ${suffix || 'main file'}`);
     assert.match(result.stderr,/database_or_sidecar_output_forbidden/);
     assert.equal(hash(runtime),originalHash);
     if(suffix)assert.equal(fs.existsSync(runtime+suffix),false,'rejection must leave runtime sidecars absent');
    }
   }
   assert.equal(hash(source),originalHash);
  });
 }
 await test('stale source identity, row hash, scope and recall revision reject the complete manifest',()=>{
  for(const mutate of [
   manifest=>{manifest.source_identity={...manifest.source_identity,database_sha256:'0'.repeat(64)};},
   manifest=>{manifest.entries[1].content_sha256='0'.repeat(64);},
   manifest=>{manifest.entries[1].user_id=999;},
   manifest=>{manifest.entries[1].companion_id=1;},
   manifest=>{manifest.entries[1].expected_recall_revision++;},
  ]){
   const manifest=manifestFor([candidate,second]);mutate(manifest);
   const {result,output}=apply(manifest);assert.notEqual(result.status,0,'stale manifest accepted');
   if(fs.existsSync(output)){
    const copied=new Database(output,{readonly:true});assert.equal(copied.prepare('SELECT memory_origin FROM companion_memories WHERE id=?').get(candidate).memory_origin,'unknown');copied.close();
   }
   assert.equal(hash(source),originalHash);
  }
 });
 await test('wrong-owner rows and duplicate IDs cannot be quarantined',()=>{
  assert.notEqual(apply(manifestFor([wrongOwner])).result.status,0);
  const duplicate=manifestFor();duplicate.entries.push({...duplicate.entries[0]});assert.notEqual(apply(duplicate).result.status,0);
  assert.equal(hash(source),originalHash);
 });
 await test('a suspicion report does not authorize applying changes without a manifest and new destination',()=>{
  assert.notEqual(run(['--output-db',path.join(dir,'no-manifest.db')]).status,0);
  const file=path.join(dir,'no-destination.json');fs.writeFileSync(file,JSON.stringify(manifestFor()));
  assert.notEqual(run(['--manifest',file]).status,0);assert.equal(hash(source),originalHash);
 });
 await test('readonly audit includes uncheckpointed WAL data without touching source sidecars',()=>{
  const file=path.join(dir,'wal-source.db');const writer=new Database(file);writer.pragma('journal_mode=WAL');writer.pragma('wal_autocheckpoint=0');
  writer.exec("CREATE TABLE companions(id INTEGER,user_id INTEGER);CREATE TABLE companion_memories(id INTEGER,companion_id INTEGER,user_id INTEGER,content TEXT);CREATE TABLE companion_conversation_turns(id INTEGER,companion_id INTEGER,synthetic INTEGER,topic TEXT);INSERT INTO companions VALUES(1,11);INSERT INTO companion_memories VALUES(1,1,11,'WAL旧事（1 天前发生）');INSERT INTO companion_conversation_turns VALUES(1,1,1,'WAL旧事')");
  try{
   const files=[file,file+'-wal',file+'-shm'];const before=files.map(hash);
   const output=path.join(dir,'wal-report.json');const result=run(['--report',output],file);assert.equal(result.status,0,result.stderr);
   const data=JSON.parse(fs.readFileSync(output));assert.equal(data.total,1);assert.equal(data.suspected,1);assert.ok(data.source_identity.wal_sha256);
   assert.deepEqual(files.map(hash),before);
  }finally{writer.close();}
 });
 await test('failure in a later scope rolls back all earlier quarantines in the new copy',()=>{
  const file=path.join(dir,'trigger-source.db');fs.copyFileSync(source,file);const triggerDb=new Database(file);
  triggerDb.exec("CREATE TRIGGER synthetic_audit_failure BEFORE UPDATE OF memory_origin ON companion_memories WHEN OLD.companion_id=2 BEGIN SELECT RAISE(ABORT,'fixture failure'); END");triggerDb.close();
  const before=hash(file);const reportFile=path.join(dir,'trigger-report.json');const audited=run(['--report',reportFile],file);assert.equal(audited.status,0,audited.stderr);
  const manifest=manifestFor([candidate,second]);manifest.source_identity=JSON.parse(fs.readFileSync(reportFile)).source_identity;
  const {result,output}=apply(manifest,path.join(dir,'rollback-copy.db'),file);assert.notEqual(result.status,0);
  const copied=new Database(output,{readonly:true});
  for(const id of [candidate,second])assert.equal(copied.prepare('SELECT memory_origin FROM companion_memories WHERE id=?').get(id).memory_origin,'unknown');
  assert.equal(copied.prepare('SELECT COUNT(*) n FROM memory_recall_barriers').get().n,0);copied.close();
  assert.equal(hash(file),before);assert.equal(hash(source),originalHash);
 });
}finally{fs.rmSync(dir,{recursive:true,force:true});}
