import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-vector-backfill-'));
const root = process.cwd();
const source = path.join(temp, 'source.db'), output = path.join(temp, 'copy.db');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function child(code, extraEnv = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, encoding: 'utf8', env: { ...process.env, DB_PATH: source, LOG_DIR: path.join(temp, 'logs'), ...extraEnv },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout.split('\n').find(line => line.startsWith('RESULT:')).slice(7));
}
const toolUrl = new URL('./memory_vector_backfill.mjs', import.meta.url).href;
const fixture = `
 const m = await import('./src/db.mjs'); const db=m.getDb();
 db.prepare("INSERT INTO users(id,wechat_user_id) VALUES(771,'synthetic-vector-fixture')").run();
 db.prepare("INSERT INTO companions(id,user_id,bot_id) VALUES(772,771,'synthetic-vector-fixture')").run();
 const ids=[];
 for(const content of ['我喜欢周末骑自行车','我喜欢喝绿茶','我喜欢去公园散步','我喜欢看科幻电影']) {
   const t=m.saveConversationTurn(772,'user',content);
   ids.push(m.saveGroundedMemory({companionId:772,userId:771,memoryType:'fact',subject:'user',
     evidence:[{turn_id:t.id,quote:t.content}],allowedTurnIds:[t.id],expectedRecallRevision:0}).memory.id);
 }
 m.patchMemory(ids[3],772,{do_not_mention:1});
 m.saveMemory({companionId:772,userId:771,memoryType:'fact',content:'旧记录的未知归属'});
 const unsupported=m.saveMemory({companionId:772,userId:771,memoryType:'fact',content:'我有一条未证明的事实'});
 db.prepare("UPDATE companion_memories SET memory_subject='user',memory_evidence=? WHERE id=?").run(JSON.stringify([{turn_id:999999,quote:'我有一条未证明的事实'}]),unsupported);
 db.pragma('wal_checkpoint(TRUNCATE)');db.close();console.log('RESULT:'+JSON.stringify(ids));
`;
const provider = `
 const {createHash}=await import('node:crypto');
 let calls=0;
 const space={version:1,provider:'custom',model:'fixture',dimension:2,endpointId:'a'.repeat(64)};
 const embed=async text=>{calls++;return {vector:[1,2],descriptor:space,contentHash:createHash('sha256').update(text).digest('hex')};};
`;
const run = body => child(`const {backfillMemoryVectors}=await import(${JSON.stringify(toolUrl)});${provider}${body}`);
const args = JSON.stringify({ dbPath: source, outputDb: output, apply: true });
try {
  {
    const ids = child(fixture);
    const before = hash(source);
    await test('dry run keeps old schema and source bytes intact and never invokes provider', () => {
      const legacy = path.join(temp, 'legacy.db');
      const db = new Database(legacy);
      db.exec("CREATE TABLE companion_memories(id INTEGER PRIMARY KEY,content TEXT); INSERT INTO companion_memories(content) VALUES('synthetic legacy');");
      db.close(); const legacyHash = hash(legacy);
      const result = run(`const result=await backfillMemoryVectors({dbPath:${JSON.stringify(legacy)},embed:()=>{throw new Error('network forbidden');}});console.log('RESULT:'+JSON.stringify(result));`);
      assert.equal(result.mode, 'dry-run'); assert.equal(result.total, 1); assert.equal(result.eligible, 0);
      assert.equal(hash(legacy), legacyHash); assert.ok(!fs.existsSync(legacy + '-wal'));
      const runtimeTrap = path.join(temp, 'must-not-create-runtime.db');
      const cli = spawnSync(process.execPath, ['scripts/memory_vector_backfill.mjs', '--db', legacy], {
        cwd: root, encoding: 'utf8', env: { ...process.env, DB_PATH: runtimeTrap },
      });
      assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).providerCalls, 0);
      assert.ok(!fs.existsSync(runtimeTrap)); assert.equal(hash(legacy), legacyHash);
    });
    await test('explicit new copy writes eligible canonical facts only and failed rows remain retryable', () => {
      const result = run(`const result=await backfillMemoryVectors({...${args},spaceConfig:()=>space,embed:async text=>text.includes('绿茶')?null:embed(text)});console.log('RESULT:'+JSON.stringify({...result,calls}));`);
      assert.equal(result.written, 2); assert.equal(result.failed, 1); assert.equal(result.eligible, 3);
      assert.equal(hash(source), before);
      const db = new Database(output, { readonly: true });
      assert.equal(db.prepare('SELECT COUNT(*) n FROM companion_memories WHERE embedding_meta IS NOT NULL').get().n, 2);
      assert.equal(db.prepare('SELECT embedding FROM companion_memories WHERE id=?').get(ids[3]).embedding, null);
      db.close();
    });
    await test('explicit resume retries failures and skips same-space vectors without another call', () => {
      const result = run(`const result=await backfillMemoryVectors({...${args},resume:true,spaceConfig:()=>space,embed});console.log('RESULT:'+JSON.stringify({...result,calls}));`);
      assert.equal(result.written, 1); assert.equal(result.skipped, 2); assert.equal(result.calls, 1);
      assert.equal(hash(source), before);
    });
    await test('endpoint and dimension changes each force new embeddings', () => {
      for (const change of [{ dimension: 3, endpointId: 'a'.repeat(64) }, { dimension: 3, endpointId: 'b'.repeat(64) }, { dimension: 2, endpointId: 'a'.repeat(64) }]) {
        const result = run(`Object.assign(space,${JSON.stringify(change)});const result=await backfillMemoryVectors({...${args},resume:true,spaceConfig:()=>space,
          embed:async text=>({...await embed(text),vector:Array(space.dimension).fill(1)})});console.log('RESULT:'+JSON.stringify({...result,calls}));`);
        assert.equal(result.written, 3); assert.equal(result.calls, 3); assert.equal(result.skipped, 0);
      }
    });
    await test('unknown custom dimension requires one observed response before skipping matching rows', () => {
      const result = run(`const result=await backfillMemoryVectors({...${args},resume:true,spaceConfig:()=>({...space,dimension:null}),embed});console.log('RESULT:'+JSON.stringify({...result,calls}));`);
      assert.equal(result.written, 1); assert.equal(result.skipped, 2); assert.equal(result.calls, 1);
    });
    await test('bounded resume advances past failures and invalid config has zero provider calls', () => {
      const bounded = JSON.stringify({ dbPath: source, outputDb: path.join(temp, 'bounded-copy.db'), apply: true, batchSize: 1 });
      const first = run(`const result=await backfillMemoryVectors({...${bounded},spaceConfig:()=>space,embed:async()=>{throw new Error('SENSITIVE_UPSTREAM_MARKER');}});console.log('RESULT:'+JSON.stringify(result));`);
      assert.equal(first.providerCalls, 1); assert.equal(first.failed, 1);
      assert.ok(!JSON.stringify(first).includes('SENSITIVE_UPSTREAM_MARKER'));
      const next = run(`const result=await backfillMemoryVectors({...${bounded},resume:true,spaceConfig:()=>space,embed});console.log('RESULT:'+JSON.stringify(result));`);
      assert.equal(next.written, 1);
      const db = new Database(path.join(temp, 'bounded-copy.db'), { readonly: true });
      assert.equal(db.prepare('SELECT embedding FROM companion_memories WHERE id=?').get(ids[0]).embedding, null);
      assert.ok(db.prepare('SELECT embedding FROM companion_memories WHERE id=?').get(ids[1]).embedding); db.close();
      const invalid = run(`const result=await backfillMemoryVectors({...${bounded},resume:true,spaceConfig:()=>null,embed});console.log('RESULT:'+JSON.stringify({...result,calls}));`);
      assert.equal(invalid.calls, 0); assert.equal(invalid.errors[0].code, 'invalid_embedding_config');
      assert.equal(hash(source), before);
    });
    await test('space changes re-embed and a content change while awaiting embedding cannot receive stale vector', () => {
      const result = run(`space.model='changed-fixture';let editedId=null;const result=await backfillMemoryVectors({...${args},resume:true,spaceConfig:()=>space,
        embed:async text=>{if(!editedId){const m=await import('./src/db.mjs');editedId=m.getDb().prepare('SELECT id FROM companion_memories WHERE content=?').get(text).id;m.patchMemory(editedId,772,{content:'我喜欢夜间骑车'});}return embed(text);}});console.log('RESULT:'+JSON.stringify({...result,calls,editedId}));`);
      assert.equal(result.written, 2); assert.equal(result.stale, 1); assert.equal(result.calls, 3);
      const db = new Database(output, { readonly: true });
      assert.equal(db.prepare('SELECT embedding FROM companion_memories WHERE id=?').get(result.editedId).embedding, null); db.close();
    });
    await test('revocation during a pending embedding is not undone', () => {
      const result = run(`space.model='third-fixture';let revoked=false;const result=await backfillMemoryVectors({...${args},resume:true,spaceConfig:()=>space,
        embed:async text=>{if(!revoked){revoked=true;const m=await import('./src/db.mjs');m.patchMemory(${ids[1]},772,{do_not_mention:1});}return embed(text);}});console.log('RESULT:'+JSON.stringify(result));`);
      assert.ok(result.stale >= 1);
      const db = new Database(output, { readonly: true });
      assert.equal(db.prepare('SELECT do_not_mention FROM companion_memories WHERE id=?').get(ids[1]).do_not_mention, 1); db.close();
    });
    await test('resume rejects unmarked targets and existing copies require explicit resume', () => {
      const unmarked = path.join(temp, 'unmarked.db'); fs.copyFileSync(source, unmarked);
      const result = run(`const errors=[];for(const opts of [{...${args},resume:false},{...${args},outputDb:${JSON.stringify(unmarked)},resume:true},{...${args},outputDb:${JSON.stringify(source)},resume:true}]){try{await backfillMemoryVectors({...opts,embed,spaceConfig:()=>space});errors.push(false);}catch{errors.push(true);}}console.log('RESULT:'+JSON.stringify({errors,calls}));`);
      assert.deepEqual(result.errors, [true, true, true]); assert.equal(result.calls, 0);
      assert.equal(hash(source), before);
    });
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
