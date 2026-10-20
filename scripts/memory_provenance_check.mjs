import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const temp=mkdtempSync(path.join(tmpdir(),'memory-provenance-'));
process.env.DB_PATH=path.join(temp,'test.db'); process.env.LOG_DIR=path.join(temp,'logs');
const m=await import('../src/db.mjs'); const db=m.getDb();
db.pragma('foreign_keys = OFF');
let cid=98000; const uid=97000;
function scope(){cid++;db.prepare('INSERT INTO companions(id,user_id,bot_id) VALUES(?,?,?)').run(cid,uid,`fixture-${cid}`);}
function turn(role,content,synthetic=0){const t=m.saveConversationTurn(cid,role,content);if(synthetic)db.prepare('UPDATE companion_conversation_turns SET synthetic=1 WHERE id=?').run(t.id);return t;}
function save(t,subject='user',extra={}){
 const input={companionId:cid,userId:uid,memoryType:'fact',content:'他有一个妹妹',subject,evidence:[{turn_id:t.id,quote:t.content}],allowedTurnIds:[t.id],expectedRecallRevision:m.getMemoryRecallBarrier(cid,uid).revision,...extra};
 return m.saveGroundedMemory ? m.saveGroundedMemory(input) : {action:'inserted',memory:{id:m.saveMemory(input)}};
}
try{
 await test('assistant assertion cannot be stored as user fact; genuine speaker identity is retained',()=>{
  scope();const t=turn('assistant','我有一个妹妹');assert.equal(save(t).action,'rejected');
  const own=save(t,'companion');assert.equal(own.action,'inserted');assert.equal(own.memory.memory_subject,'companion');assert.equal(own.memory.content,'我有一个妹妹');
  assert.equal(JSON.parse(own.memory.memory_evidence)[0].role,'assistant');
 });
 await test('canonical source wording prevents model polarity inversion and exact duplicates',()=>{
  scope();const t=turn('user','我没有妹妹');const a=save(t);assert.equal(a.memory.content,'我没有妹妹');
  const b=save(turn('user','我没有妹妹。'));assert.equal(b.action,'duplicate');assert.equal(a.memory.id,b.memory.id);
  const other=save(turn('assistant','我没有妹妹'),'companion');assert.notEqual(other.memory.id,a.memory.id);
 });
 await test('quotes, hypotheses, questions and bare assent never become personal facts',()=>{
  scope();for(const text of ['你刚才说你有一个妹妹','如果我有一个妹妹就好了','“我有一个妹妹”是你说的','我有一个妹妹吗？','对呀','我觉得你有一个妹妹']) assert.equal(save(turn('user',text)).action,'rejected',text);
  const t=turn('user','如果我有一个妹妹就好了');assert.equal(save(t,'user',{evidence:[{turn_id:t.id,quote:'我有一个妹妹'}]}).action,'rejected');
 });
 await test('evidence requires real supplied same-scope non-synthetic messages and complete assertion',()=>{
  scope();const valid=turn('user','我喜欢骑自行车');const foreign=m.saveConversationTurn(cid+1,'user','我喜欢骑自行车');
  for(const input of [{allowedTurnIds:[]},{evidence:[{turn_id:valid.id,quote:'我喜欢徒步'}]},{evidence:[{turn_id:foreign.id,quote:foreign.content}],allowedTurnIds:[foreign.id]},{evidence:[{turn_id:valid.id,quote:'我喜欢'}]}])assert.equal(save(valid,'user',input).action,'rejected');
  assert.equal(save(turn('user','我喜欢骑自行车',1)).action,'rejected');
  assert.equal(save(valid,'user',{userId:uid+1}).action,'rejected');
 });
 await test('shared facts require explicit statements from both actual speakers',()=>{
  scope();const a=turn('user','我们约好周末一起看电影');const b=turn('assistant','我们约好周末一起看电影');
  assert.equal(save(a,'shared').action,'rejected');
  const result=save(a,'shared',{allowedTurnIds:[a.id,b.id],evidence:[{turn_id:a.id,quote:a.content},{turn_id:b.id,quote:b.content}]});assert.equal(result.action,'inserted');
 });
 await test('explicit correction replaces only related user facts, invalidates derivatives and keeps history',()=>{
  scope();const old=save(turn('user','我有一个妹妹')).memory;
  const derived=m.saveMemory({companionId:cid,userId:uid,memoryType:'weekly_summary',content:'家人旧摘要',sourceMemoryIds:[old.id]});
  const corrected=save(turn('user','我没有妹妹，是你记错了'),'user',{replacesMemoryIds:[old.id]});assert.equal(corrected.action,'corrected');
  const visible=m.getRecallableMemories(cid,uid);assert.ok(visible.some(r=>r.id===corrected.memory.id));assert.ok(!visible.some(r=>r.id===old.id||r.id===derived));
  assert.equal(db.prepare('SELECT memory_status FROM companion_memories WHERE id=?').get(old.id).memory_status,'contradicted');
  const unrelated=save(turn('user','我喜欢骑自行车')).memory;
  assert.equal(save(turn('user','我没有妹妹'),'user',{replacesMemoryIds:[unrelated.id]}).action,'rejected');
 });
 await test('revocation rejects stale extraction and old turn reuse, leaving new direct assertions usable',()=>{
  scope();const old=turn('user','我喜欢骑自行车');const stored=save(old).memory;m.softDeleteMemory(stored.id,cid);
  assert.equal(save(old).action,'rejected');
  const fresh=turn('user','我喜欢游泳');assert.equal(save(fresh,'user',{expectedRecallRevision:0}).action,'rejected');assert.equal(save(fresh).action,'inserted');
 });
 await test('manual content edits cannot retain earlier verified ownership/evidence',()=>{
  scope();const row=save(turn('user','我喜欢游泳')).memory;
  const edited=m.patchMemory(row.id,cid,{content:'她有一个妹妹'});assert.equal(edited.memory_subject,'unknown');assert.equal(edited.memory_evidence,null);
 });
 await test('profile recall admits only manual fields or currently verified user sources',()=>{
  scope();m.upsertUserProfile(uid,cid,{notes:'旧的未经证明画像'});assert.equal(m.getUserProfileForRecall(uid,cid),null);
  const source=save(turn('user','我喜欢骑自行车')).memory;
  m.upsertUserProfile(uid,cid,{notes:source.content},{sourceMemoryIds:[source.id],expectedRecallRevision:0});assert.equal(m.getUserProfileForRecall(uid,cid).notes,source.content);
  m.softDeleteMemory(source.id,cid);assert.equal(m.getUserProfileForRecall(uid,cid),null);
  m.upsertUserProfile(uid,cid,{user_name:'测试昵称'},{manual:true});assert.equal(m.getUserProfileForRecall(uid,cid).user_name,'测试昵称');
  assert.ok(!m.getUserProfileForRecall(uid,cid).notes);
 });
}finally{db.close();process.on('exit',()=>rmSync(temp,{recursive:true,force:true}));}
