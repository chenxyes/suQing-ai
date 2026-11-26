import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {rankMemoryCandidates} from '../src/memory_retrieval.mjs';
import {hashMemoryContent} from '../src/memory_vectors.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'memory-retrieval-review-'));
process.env.DB_PATH=path.join(temp,'fixture.db');process.env.LOG_DIR=path.join(temp,'logs');
const m=await import('../src/db.mjs');const db=m.getDb();db.pragma('foreign_keys=OFF');
const descriptor={version:1,provider:'fixture',model:'fixture',dimension:2,endpointId:'a'.repeat(64)};
function setup(cid,uid){db.prepare('INSERT INTO companions(id,user_id,bot_id) VALUES(?,?,?)').run(cid,uid,`fixture-${cid}`);}
function add(cid,uid,content){return m.saveMemory({companionId:cid,userId:uid,memoryType:'fact',content,pinned:false});}
try {
 await test('pin fallback budget must not discard matching pinned facts for unrelated rows',()=>{
  const rows=[1,2,3].map(id=>({id,content:`骑自行车路线${id}`,pinned:1}));
  rows.push({id:4,content:'今天午餐吃饺子',pinned:0});
 assert.deepEqual(new Set(rankMemoryCandidates(rows,'骑自行车',{limit:3}).map(row=>row.id)),new Set([1,2,3]));
 });
 await test('hybrid ignores an embedding computed for a different query text',()=>{
  const content='讨论摄影构图';
  const row={id:1,content,embedding:Buffer.from(new Float32Array([1,0]).buffer),
    embedding_meta:JSON.stringify({descriptor,contentHash:hashMemoryContent(content)})};
  const queryEmbedding={vector:[1,0],descriptor,contentHash:hashMemoryContent('摄影构图')};
  const [result]=rankMemoryCandidates([row],'周末骑自行车',{queryEmbedding});
  assert.equal(result.similarity,null);
  assert.equal(result._relevant,false);
 });
 await test('vector CAS rejects foreign owner and deletion of a dependency after inference',()=>{
  setup(99601,99600);setup(99602,99603);
  const source=add(99601,99600,'骑自行车');
  const target=m.saveMemory({companionId:99601,userId:99600,memoryType:'weekly_summary',content:'运动摘要',sourceMemoryIds:[source]});
  const result={vector:[1,0],descriptor,contentHash:hashMemoryContent('运动摘要')};
  const expected={expectedContent:'运动摘要',expectedRecallRevision:0};
  assert.equal(m.writeMemoryEmbedding(target,99601,99603,result,expected),false);
  assert.equal(m.writeMemoryEmbedding(target,99602,99603,result,expected),false);
  m.softDeleteMemory(source,99601);
  assert.equal(m.writeMemoryEmbedding(target,99601,99600,result,expected),false);
  assert.equal(db.prepare('SELECT embedding FROM companion_memories WHERE id=?').get(target).embedding,null);
 });
 await test('compaction retains dependency graph and admits source fallback after summary removal',()=>{
  setup(99604,99600);
  const ids=['骑自行车','游泳锻炼','散步锻炼'].map(text=>add(99604,99600,text));
  const prior=m.saveMemory({companionId:99604,userId:99600,memoryType:'weekly_summary',content:'来源既有摘要',sourceMemoryIds:[ids[0]]});
  const summary=m.compactMemories({companionId:99604,userId:99600,sourceIds:ids,content:'压缩运动经历',expectedRecallRevision:0});
  assert.ok(summary);
  assert.ok(m.getRecallableMemories(99604,99600).some(row=>row.id===prior));
  m.softDeleteMemory(summary.id,99604);
  for(const id of ids)assert.ok(m.recallMemoriesHybrid(99604,99600,'锻炼',{limit:20}).some(row=>row.id===id));
  assert.ok(m.getRecallableMemories(99604,99600).some(row=>row.id===prior));
 });
}finally{db.close();process.on('exit',()=>fs.rmSync(temp,{recursive:true,force:true}));}
