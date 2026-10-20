/** Offline: Node22 --experimental-vm-modules scripts/synthetic_history_generation_check.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let modelCalls=0, embeddings=0, emotions=0, writes=[], revision=2, response, status=null, prompt='', rejectSave=false;
let onModel=()=>{};
const companion={id:7,user_id:10,name:'合成角色',how_met:'角色自己的相遇设定',personality_tags:'["温柔"]',hobbies:'["阅读"]'};
const valid=()=>({events:[{days_ago:5,hour:12,topic:'虚构雨天闲聊',memorable:true,turns:[
  {role:'user',content:'这是虚构的问候。'},{role:'assistant',content:'这是角色的虚构回应。'},
]}],ending_affection:99});
function reset(){modelCalls=0;embeddings=0;emotions=0;writes=[];revision=2;response=valid();status=null;prompt='';rejectSave=false;onModel=()=>{};}
const db={
  getCompanionBackfillStatus:()=>status,
  getMemoryRecallBarrier:()=>({revision}),
  saveSyntheticHistory:input=>{writes.push(input);return rejectSave||input.expectedRecallRevision!==revision?null:{turnCount:input.turns.length,memoryCount:input.memoryEvents.length};},
  bulkInsertSyntheticTurns:(_id,turns)=>writes.push({turns}),
  markCompanionBackfilled:()=>{},saveMemory:()=>writes.push({legacy:true}),
  upsertEmotionState:()=>emotions++,countRealUserTurns:()=>50,
};
const ai={extractStructuredInfo:async (_system,input)=>{modelCalls++;prompt=input;onModel();return typeof response==='string'?response:JSON.stringify(response);},
  embedText:async()=>{embeddings++;return[1,0];}};
const context=vm.createContext({console,Date,Math,Set,Map,Number,JSON});
const source=readFileSync(new URL('../src/backfill_history.mjs',import.meta.url),'utf8');
const module=new vm.SourceTextModule(source,{context});
await module.link(spec=>{
  const values=spec==='./db.mjs'?db:spec==='./ai.mjs'?ai:{log(){}};
  return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value);},{context});
});
await module.evaluate();const generator=module.namespace;
let passed=0,failed=0;
async function check(name,fn){reset();try{await fn();passed++;}catch(error){failed++;console.error(`FAIL ${name}: ${error.message}`);}}
for(const confirmSynthetic of [undefined,false,'true',1])await check(`strict opt-in rejects ${String(confirmSynthetic)} before generation`,async()=>{
  const result=await generator.backfillTimelineForCompanion(companion,{confirmSynthetic,force:true});
  assert.equal(modelCalls,0);assert.equal(writes.length,0);assert.equal(result.skipped,'confirmation-required');
});
await check('explicit opt-in uses one atomic synthetic writer and preserves persona background',async()=>{
  const result=await generator.backfillTimelineForCompanion(companion,{confirmSynthetic:true});
  assert.equal(result.ok,true);assert.equal(modelCalls,1);assert.equal(writes.length,1);
  assert.equal(writes[0].companionId,7);assert.equal(writes[0].userId,10);assert.equal(writes[0].expectedRecallRevision,2);
  assert.equal(writes[0].turns.length,2);assert.equal(writes[0].memoryEvents.length,1);
  assert.ok(prompt.includes(companion.how_met));assert.ok(prompt.includes('虚构'));
  assert.equal(embeddings,0);assert.equal(emotions,0);assert.equal(result.endingAffection,undefined);
});
await check('automatic exports remain inert even after binding and message threshold',async()=>{
  assert.equal(generator.decideBackfillAction({tier:null,userTurns:99,justBound:true}),null);
  await generator.maybeAutoBackfill(companion,{justBound:true});
  assert.equal(modelCalls,0);assert.equal(writes.length,0);
});
for(const mode of ['revoked','concurrent-duplicate'])await check(`${mode} during generation rejects cleanly`,async()=>{
  onModel=()=>{if(mode==='revoked')revision++;else rejectSave=true;};
  const result=await generator.backfillTimelineForCompanion(companion,{confirmSynthetic:true});
  assert.equal(result.ok,undefined);assert.equal(result.skipped,'stale-or-duplicate');
  assert.equal(emotions,0);assert.equal(embeddings,0);
  assert.equal(writes[0].expectedRecallRevision,2);
});
for(const mode of ['role','too-many-events','too-many-turns','days','hour','duplicate-days','long-content','long-topic'])await check(`malformed ${mode} is rejected before persistence`,async()=>{
  const event=response.events[0];
  if(mode==='role')event.turns[0].role='system';
  if(mode==='too-many-events')response.events=Array.from({length:61},(_,i)=>({...event,days_ago:i+3}));
  if(mode==='too-many-turns')event.turns=Array.from({length:4},()=>({role:'user',content:'fiction'}));
  if(mode==='days')event.days_ago=999;
  if(mode==='hour')event.hour=-1;
  if(mode==='duplicate-days')response.events.push({...event});
  if(mode==='long-content')event.turns[0].content='甲'.repeat(401);
  if(mode==='long-topic')event.topic='甲'.repeat(101);
  const result=await generator.backfillTimelineForCompanion(companion,{confirmSynthetic:true});
  assert.ok(result.error);assert.equal(writes.length,0);assert.equal(emotions,0);
});
await check('thin to full appends only older fictional dates',async()=>{
  status={tier:'thin',backfilledAt:1};response.events[0].days_ago=3;
  const result=await generator.backfillTimelineForCompanion(companion,{confirmSynthetic:true,tier:'full'});
  assert.ok(result.error);assert.equal(writes.length,0);
});
await check('manual confirmation still honors duplicate guard',async()=>{
  status={tier:'full',backfilledAt:1};const result=await generator.backfillTimelineForCompanion(companion,{confirmSynthetic:true});
  assert.equal(result.skipped,'already-backfilled');assert.equal(modelCalls,0);
});
await check('admin confirmation sends explicit fictional append authorization',async()=>{
  const html=readFileSync(new URL('../public/app/admin.html',import.meta.url),'utf8');
  const start=html.indexOf('window.adminBackfill =');const end=html.indexOf('\n    };',start)+7;
  let body,confirmation;const el={textContent:''};
  const ui={window:{},document:{getElementById:()=>el},confirm:text=>{confirmation=text;return true;},
    fetch:async(_url,options)=>{body=JSON.parse(options.body);return{json:async()=>({ok:true,data:{ok:true,turnCount:2,memoryCount:1}})};},
    localStorage:{getItem:()=>null},TOKEN_KEY:'fixture'};
  vm.runInNewContext(html.slice(start,end),ui);await ui.window.adminBackfill(7);
  assert.equal(body.confirm_synthetic,true);assert.ok(confirmation.includes('虚构')&&confirmation.includes('追加'));
  assert.ok(!confirmation.includes('覆盖'));assert.ok(el.textContent.includes('虚构'));
});
console.log(`synthetic_history_generation_check: ${passed} passed, ${failed} failed`);
process.exitCode=failed?1:0;
