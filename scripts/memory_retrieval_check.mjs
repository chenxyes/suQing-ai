import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'memory-retrieval-'));process.env.DB_PATH=path.join(tmp,'test.db');process.env.LOG_DIR=path.join(tmp,'logs');
const m=await import('../src/db.mjs');const db=m.getDb();db.pragma('foreign_keys=OFF');let cid=99000;const uid=90000;
const descriptor={version:1,provider:'fixture',model:'model-a',dimension:2,endpointId:'a'.repeat(64)};
const hash=t=>crypto.createHash('sha256').update(t).digest('hex');
const bundle=(content,vector=[1,0],patch={})=>({vector,descriptor:{...descriptor,...patch},contentHash:hash(content)});
function scope(){cid++;db.prepare('INSERT INTO companions(id,user_id,bot_id) VALUES(?,?,?)').run(cid,uid,`fixture-${cid}`);}
function add(content,extra={}){return m.saveMemory({companionId:cid,userId:uid,memoryType:'fact',content,pinned:false,importance:5,...extra});}
const row=id=>db.prepare('SELECT * FROM companion_memories WHERE id=?').get(id);
const index=(id,result,extra={})=>m.writeMemoryEmbedding?.(id,cid,uid,result,{expectedContent:row(id).content,expectedRecallRevision:m.getMemoryRecallBarrier(cid,uid).revision,...extra}) ?? false;
const hybrid=(query,options={})=>m.recallMemoriesHybrid?m.recallMemoriesHybrid(cid,uid,query,options):m.recallMemories(cid,uid,query,options.limit??7);
try{
 await test('untagged vectors and bare query arrays cannot enter semantic similarity',()=>{scope();add('旧向量没有模型来源',{embedding:[1,0]});assert.deepEqual(m.recallMemoriesSemantic(cid,uid,[1,0]),[]);});
 await test('semantic comparisons require same provider model endpoint dimension and unchanged content hash',()=>{
 scope();const keep=add('自行车通勤');assert.equal(index(keep,bundle(row(keep).content)),true);
 for(const patch of [{model:'model-b'},{provider:'other'},{endpointId:'b'.repeat(64)},{dimension:3}]){const id=add('别的向量空间');assert.equal(index(id,bundle(row(id).content,patch.dimension===3?[1,0,0]:[1,0],patch)),true);}
 assert.deepEqual(m.recallMemoriesSemantic(cid,uid,bundle('骑车')).map(r=>r.id),[keep]);
 db.prepare('UPDATE companion_memories SET content=? WHERE id=?').run('外部修改正文',keep);assert.deepEqual(m.recallMemoriesSemantic(cid,uid,bundle('骑车')),[]);
 });
 await test('vector compare-and-set rejects malformed vectors, stale content, hidden rows and revocation races',()=>{
 scope();const id=add('新事实');for(const result of [bundle('新事实',[NaN,0]),bundle('新事实',[0,0]),bundle('新事实',[1]),bundle('另一个正文'),bundle('新事实',[1,0],{endpointId:'secret-url'})])assert.equal(index(id,result),false);
 assert.equal(index(id,bundle('新事实'),{expectedContent:'旧内容'}),false);
 m.patchMemory(id,cid,{content:'已改事实'});assert.equal(index(id,bundle('已改事实'),{expectedRecallRevision:0}),false);
 m.softDeleteMemory(id,cid);assert.equal(index(id,bundle('已改事实')),false);assert.equal(row(id).embedding,null);
 });
 await test('Chinese queries prefer matching facts over pinned unrelated summaries and use bounded pin fallback',()=>{
 scope();for(let i=0;i<9;i++)add(`无关的旧月总结编号${i}`,{memoryType:'monthly_summary',importance:10,pinned:true});const bike=add('我喜欢周末骑自行车');const film=add('我喜欢看科幻电影');
 const a=hybrid('周末一起骑自行车吗',{limit:7});const b=hybrid('喜欢什么科幻电影',{limit:7});assert.equal(a[0].id,bike);assert.equal(b[0].id,film);assert.ok(a.filter(r=>r.pinned).length<=2);
 });
 await test('mixed retrieval includes matching no-vector facts even when semantic results exist',()=>{
 scope();const semantic=add('工作日通勤路线');assert.equal(index(semantic,bundle(row(semantic).content)),true);const lexical=add('我想周末骑自行车');
 const rows=hybrid('周末骑自行车',{queryEmbedding:bundle('周末骑自行车'),limit:3});assert.ok(rows.some(r=>r.id===semantic));assert.ok(rows.some(r=>r.id===lexical));
 });
 await test('recency decay affects equal relevance and previews never touch; explicit touch isolates scope',()=>{
 scope();const old=add('我喜欢骑自行车');const fresh=add('我喜欢骑自行车');db.prepare("UPDATE companion_memories SET created_at='2020-01-01 00:00:00' WHERE id=?").run(old);
 const selected=hybrid('骑自行车',{limit:1});assert.equal(selected[0].id,fresh);assert.equal(row(fresh).use_count,0);
 assert.equal(typeof m.touchRecalledMemories,'function');m.touchRecalledMemories(cid,uid,[fresh]);assert.equal(row(fresh).use_count,1);assert.equal(row(old).use_count,0);m.touchRecalledMemories(cid,uid+1,[old]);assert.equal(row(old).use_count,0);
 });
 await test('compaction is atomic, keeps source evidence, skips locked records and invalidates with source',()=>{
 scope();const ids=['我喜欢骑车','我喜欢游泳','我喜欢散步'].map(t=>add(t));const input={companionId:cid,userId:uid,sourceIds:ids,content:'老记忆压缩 fixture：运动偏好',expectedRecallRevision:0};
 assert.equal(typeof m.compactMemories,'function');db.exec("CREATE TRIGGER reject_compact BEFORE UPDATE OF compacted_into ON companion_memories BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");assert.throws(()=>m.compactMemories(input));assert.equal(db.prepare('SELECT COUNT(*) n FROM companion_memories WHERE companion_id=?').get(cid).n,3);db.exec('DROP TRIGGER reject_compact');
 m.patchMemory(ids[0],cid,{locked:1});assert.equal(m.compactMemories(input),null);m.patchMemory(ids[0],cid,{locked:0});const summary=m.compactMemories(input);assert.ok(summary);assert.ok(summary.importance<=10);assert.deepEqual(JSON.parse(summary.source_memory_ids),ids);assert.equal(m.compactMemories(input).id,summary.id);
 for(const id of ids)assert.equal(row(id).compacted_into,summary.id);assert.ok(!hybrid('骑车',{limit:20}).some(r=>ids.includes(r.id)));
 m.softDeleteMemory(ids[0],cid);assert.ok(!m.getRecallableMemories(cid,uid).some(r=>r.id===summary.id));assert.ok(hybrid('游泳',{limit:20}).some(r=>r.id===ids[1]));
 });
}finally{db.close();process.on('exit',()=>fs.rmSync(tmp,{recursive:true,force:true}));}
