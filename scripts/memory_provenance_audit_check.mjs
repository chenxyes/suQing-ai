import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {contentHash} from './memory_provenance_audit.mjs';
const dir=fs.mkdtempSync(path.join(tmpdir(),'memory-audit-check-'));
const source=path.join(dir,'source.db');process.env.DB_PATH=source;process.env.LOG_DIR=path.join(dir,'logs');
const m=await import('../src/db.mjs');const db=m.getDb();db.pragma('foreign_keys = OFF');
db.prepare('INSERT INTO companions(id,user_id,bot_id) VALUES(1,2,?)').run('fixture');
const t=m.saveConversationTurn(1,'user','我喜欢骑自行车');
const id=m.saveMemory({companionId:1,userId:2,memoryType:'fact',content:'他喜欢骑自行车'});
const hidden=m.saveMemory({companionId:1,userId:2,memoryType:'fact',content:'旧的隐藏事实'});
db.prepare("UPDATE companion_memories SET memory_status='deleted' WHERE id=?").run(hidden);
// Keep a clean scope for attribute test; migrate seeds restricted scopes, so use another companion for hidden record.
db.prepare('INSERT INTO companions(id,user_id,bot_id) VALUES(3,2,?)').run('hidden-fixture');
db.prepare('UPDATE companion_memories SET companion_id=3 WHERE id=?').run(hidden);
db.close();const hash=contentHash(fs.readFileSync(source));
function run(args){return spawnSync(process.execPath,['scripts/memory_provenance_audit.mjs','--db',source,...args],{encoding:'utf8',env:{...process.env,LOG_DIR:path.join(dir,'child-logs')}});}
try{
 const report=path.join(dir,'audit.json');const audit=run(['--report',report]);assert.equal(audit.status,0,audit.stderr);
 const data=JSON.parse(fs.readFileSync(report));assert.equal(data.total,2);assert.equal(data.unknown,2);assert.equal(data.restricted,1);assert.ok(!JSON.stringify(data).includes('骑自行车'));assert.equal(contentHash(fs.readFileSync(source)),hash);
 const manifest=path.join(dir,'manifest.json');fs.writeFileSync(manifest,JSON.stringify([{memory_id:id,content_sha256:contentHash('他喜欢骑自行车'),action:'attribute',subject:'user',evidence:[{turn_id:t.id,quote:t.content}]}]));
 const copy=path.join(dir,'approved.db');const applied=run(['--manifest',manifest,'--output-db',copy]);assert.equal(applied.status,0,applied.stderr);assert.equal(contentHash(fs.readFileSync(source)),hash);
 const checked=new Database(copy,{readonly:true});const row=checked.prepare('SELECT * FROM companion_memories WHERE id=?').get(id);assert.equal(row.memory_subject,'user');assert.equal(row.content,t.content);assert.equal(row.embedding,null);assert.equal(checked.pragma('integrity_check',{simple:true}),'ok');checked.close();
 assert.notEqual(run(['--manifest',manifest,'--output-db',copy]).status,0,'existing destination never overwritten');assert.notEqual(run(['--manifest',manifest,'--output-db',source]).status,0,'source never overwritten');
 fs.writeFileSync(manifest,JSON.stringify([{memory_id:hidden,content_sha256:contentHash('旧的隐藏事实'),action:'attribute',subject:'user',evidence:[{turn_id:t.id,quote:t.content}]}]));
 assert.notEqual(run(['--manifest',manifest,'--output-db',path.join(dir,'refused.db')]).status,0,'restricted row cannot be promoted');
 assert.equal(contentHash(fs.readFileSync(source)),hash);
 console.log('memory audit: read-only stats, no plaintext report, explicit new-copy attribution, source unchanged, existing-output and restricted-row rejection passed');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
