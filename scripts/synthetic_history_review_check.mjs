/** Real generator + real temporary DB + actual API handler, mocked model only. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-history-review-'));
process.env.DB_PATH=path.join(temp,'fixture.db');process.env.LOG_DIR=path.join(temp,'logs');
const m=await import('../src/db.mjs');const db=m.getDb();db.pragma('foreign_keys=OFF');
let calls=0,hook=()=>{},handler;
const context=vm.createContext({console});
const generation=new vm.SourceTextModule(fs.readFileSync(new URL('../src/backfill_history.mjs',import.meta.url),'utf8'),{context});
await generation.link(async name=>{
 const values=name==='./db.mjs'?m:name==='./logger.mjs'?{log:()=>{}}:{extractStructuredInfo:async()=>{
  calls++;hook();return JSON.stringify({events:[{days_ago:5,hour:12,topic:'虚构约定',memorable:true,
   turns:[{role:'user',content:'我有一个妹妹'},{role:'assistant',content:'这是虚构回应'}]}]});
 }};
 return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);},{context});
});
await generation.evaluate();
Object.assign(context,{router:{post:(...args)=>{handler=args.at(-1);}},rateLimit:()=>()=>{},requireAdmin:()=>{},
 intId:value=>Number(value),getCompanionById:id=>db.prepare('SELECT * FROM companions WHERE id=?').get(id),
 err:(_res,message,status=400)=>({status,message}),ok:(_res,data)=>({status:200,data}),log:()=>{}});
const api=fs.readFileSync(new URL('../src/api.mjs',import.meta.url),'utf8');
const start=api.indexOf("router.post('/companions/:id/backfill-history'");
const end=api.indexOf('\n);',start)+4;
assert.ok(start>0 && end>start);
const route=new vm.SourceTextModule(api.slice(start,end),{context,importModuleDynamically:async name=>{
 assert.equal(name,'./backfill_history.mjs');return generation;
}});await route.link(()=>assert.fail('unexpected static route import'));await route.evaluate();
let sequence=99900;
function fixture(){
 calls=0;hook=()=>{};const cid=++sequence,uid=cid;
 db.prepare('INSERT INTO companions(id,user_id,bot_id,name) VALUES(?,?,?,?)').run(cid,uid,'fixture','合成角色');
 return {cid,uid,request:body=>handler({params:{id:String(cid)},body},{})};
}
try{
 await test('actual route refuses missing explicit fictional confirmation without model calls',async()=>{
  const f=fixture();const result=await f.request({force:true});assert.equal(result.status,400);assert.equal(calls,0);
 });
 await test('real generator/helper stores fictional history but chat and evidence retain only genuine turns',async()=>{
  const f=fixture();const real=m.saveConversationTurn(f.cid,'user','我喜欢骑车');
  const result=await f.request({confirm_synthetic:true});assert.equal(result.status,200);assert.equal(result.data.ok,true);
  const generated=db.prepare('SELECT * FROM companion_conversation_turns WHERE companion_id=? AND synthetic=1').all(f.cid);assert.equal(generated.length,2);
  assert.deepEqual(m.getConversationContext(f.cid,50).map(row=>row.id),[real.id]);
  assert.equal(m.getMemoryEvidenceTurns(f.cid,f.uid,generated.map(row=>row.id)).length,0);
  assert.equal(m.getRecallableMemories(f.cid,f.uid).length,0);
  assert.equal(m.getMemoriesV2(f.cid).memories[0].memory_origin,'synthetic');
 });
 await test('a recall revocation during model generation produces API 409 and no fictional writes',async()=>{
  const f=fixture();const memory=m.saveMemory({companionId:f.cid,userId:f.uid,memoryType:'fact',content:'撤销对象'});
  hook=()=>m.softDeleteMemory(memory,f.cid);
  const result=await f.request({confirm_synthetic:true});assert.equal(result.status,409);
  assert.equal(m.getCompanionBackfillStatus(f.cid).syntheticCount,0);
  assert.equal(m.getCompanionBackfillStatus(f.cid).backfilledAt,null);
 });
 await test('owner change during model generation produces API 409 instead of success',async()=>{
  const f=fixture();hook=()=>db.prepare('UPDATE companions SET user_id=? WHERE id=?').run(f.uid+1000,f.cid);
  const result=await f.request({confirm_synthetic:true});assert.equal(result.status,409);
  assert.equal(m.getCompanionBackfillStatus(f.cid).syntheticCount,0);
 });
}finally{db.close();fs.rmSync(temp,{recursive:true,force:true});}
