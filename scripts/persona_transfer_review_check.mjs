import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'persona-transfer-review-'));
process.env.DB_PATH=path.join(temp,'fixture.db');process.env.LOG_DIR=path.join(temp,'logs');
const m=await import('../src/db.mjs');const t=await import('../src/persona_export.mjs');const db=m.getDb();db.pragma('foreign_keys=OFF');
db.prepare('INSERT INTO companions(id,user_id,bot_id,name) VALUES(1,2,?,?)').run('fixture','导出审查角色');
const id=m.saveMemory({companionId:1,userId:2,memoryType:'fact',content:'合成测试事实'});
function exportedMetadata(value){
 db.prepare('UPDATE companion_memories SET origin_metadata=? WHERE id=?').run(value,id);
 return t.buildCompanionExport(1,{includeMemories:true}).core_memories[0].origin_metadata;
}
try{
 await test('camelCase credentials and owner identifiers are excluded from nested portable metadata',()=>{
  const output=exportedMetadata(JSON.stringify({source:'fixture',nested:{accessToken:'CREDENTIAL_FIXTURE_DO_NOT_EXPORT',userId:9876543,accountId:9876544}}));
  assert.ok(!output.includes('CREDENTIAL_FIXTURE_DO_NOT_EXPORT'));
  assert.ok(!output.includes('9876543'));assert.ok(!output.includes('9876544'));assert.ok(output.includes('fixture'));
 });
 await test('malformed legacy metadata cannot export a plaintext credential through the parse fallback',()=>{
  const output=exportedMetadata('token=ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  assert.ok(!String(output).includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
 });
 await test('extra credential and owner fields inside evidence JSON are not portable proof metadata',()=>{
  db.prepare('UPDATE companion_memories SET memory_evidence=? WHERE id=?').run(JSON.stringify([
   {turn_id:123,role:'user',quote:'合成证据',api_key:'EVIDENCE_CREDENTIAL_FIXTURE',user_id:7891234},
  ]),id);
  const output=JSON.stringify(t.buildCompanionExport(1,{includeMemories:true}));
  assert.ok(!output.includes('EVIDENCE_CREDENTIAL_FIXTURE'));
  assert.ok(!output.includes('7891234'));
 });
}finally{db.close();fs.rmSync(temp,{recursive:true,force:true});}
