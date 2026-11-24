import assert from 'node:assert/strict';
import {test} from 'node:test';
process.env.DB_PATH=':memory:';
globalThis.fetch=async()=>{throw new Error('Network forbidden in works review');};
const w=await import('../src/current_works.mjs');
const candidate={kind:'game ',title:'未经证实的游戏甲',creator:'未知制作方'};
const noProvider={search:async()=>({ok:false,error:'no_provider'}),findCached:()=>null};
await test('whitespace in model kind cannot skip verification and turn a game into a handcraft',async()=>{
 const records=[];
 await w.ensureCurrentWorks({id:1},{...noProvider,
  cfg:{...w.worksConfig({}),maxActive:1,verifyRetries:0},
  getActive:()=>[],insert:(_id,row)=>records.push(row),setStatus:()=>{},generate:async()=>candidate,
 });
 assert.equal(records.length,1);
 assert.equal(records[0].kind,'game');
 assert.equal(records[0].verifyStatus,'generic');
 assert.notEqual(records[0].title,candidate.title);
});
await test('unknown model kinds are not automatically trusted as exempt handcrafts',async()=>{
 const result=await w.verifyWorkCandidate({kind:'video_game',title:'未经证实的游戏乙'},noProvider);
 assert.notEqual(result.status,'skip');
});
await test('verified game lifecycle archive uses game activity rather than reading completion',()=>{
 const game={kind:'game',title:'测试游戏',verify_status:'verified'};
 for(const dropped of [false,true]){
  const content=w.buildWorkArchiveMemory(game,dropped,new Date('2026-10-20T00:00:00Z')).content;
  assert.ok(/玩|通关/.test(content),content);
  assert.ok(!/看完|看了一半|读完/.test(content),content);
 }
});
await test('malformed retry cannot erase the last known valid activity kind',async()=>{
 const records=[];let attempt=0;
 await w.ensureCurrentWorks({id:1},{
  cfg:{...w.worksConfig({}),maxActive:1,verifyRetries:1},
  getActive:()=>[],insert:(_id,row)=>records.push(row),setStatus:()=>{},
  generate:async()=>attempt++===0?{kind:'game',title:'无搜索证据的游戏'}:{kind:'invalid_kind',title:'第二个无效候选'},
  search:async()=>({ok:true,results:[]}),findCached:()=>null,
 });
 assert.equal(records[0].kind,'game');
 assert.equal(records[0].verifyStatus,'generic');
 assert.ok(!records[0].title.includes('候选'));
});
await test('provider failure and quota exhaustion have distinct truthful fallback diagnostics',async()=>{
 const input={kind:'series',title:'测试剧集'};
 const failure=await w.verifyWorkCandidate(input,{findCached:()=>null,search:async()=>{throw new Error('synthetic offline');}});
 assert.equal(failure.status,'generic');assert.equal(failure.reason,'provider_error');
 let searched=false;
 const quota=await w.verifyWorkCandidate(input,{findCached:()=>null,dailyUsed:2,dailyCap:2,search:async()=>{searched=true;return {ok:true,results:[]};}});
 assert.equal(quota.status,'generic');assert.equal(quota.reason,'daily_cap');assert.equal(searched,false);
});
await test('generic game lifecycle retains archive behavior without claiming specific completion',async()=>{
 const row={id:1,kind:'game',title:'游戏',verify_status:'generic',status:'active',started_at:'2020-01-01T00:00:00Z'};
 let archive=null;
 const result=await w.ensureCurrentWorks({id:1},{cfg:w.worksConfig({}),now:new Date('2026-10-20T00:00:00Z'),rng:()=>0.99,
  getActive:()=>row.status==='active'?[row]:[],insert:()=>assert.fail('no generator'),
  setStatus:(_id,status)=>{row.status=status;},archiveFinished:async(_comp,work,dropped)=>{archive=w.buildWorkArchiveMemory(work,dropped);},
 });
 assert.equal(result.finished,1);assert.equal(row.status,'finished');
 assert.ok(archive.content.includes('玩过一款游戏'));
 assert.ok(!/看完|通关|读完/.test(archive.content));
});
