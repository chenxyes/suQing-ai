import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashMemoryContent } from '../src/memory_vectors.mjs';
const temp = mkdtempSync(path.join(tmpdir(), 'memory-synthetic-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.LOG_DIR = path.join(temp, 'logs');
const m = await import('../src/db.mjs');
const db = m.getDb(); db.pragma('foreign_keys = OFF');
let cid = 99000; const uid = 97000;
function scope() { cid++; db.prepare('INSERT INTO companions(id,user_id,bot_id) VALUES(?,?,?)').run(cid,uid,`fixture-${cid}`); }
const memory = (content, extra = {}) => m.saveMemory({ companionId:cid,userId:uid,memoryType:'event',content,...extra });
const row = id => db.prepare('SELECT * FROM companion_memories WHERE id=?').get(id);
const synthetic = (extra = {}) => m.saveSyntheticHistory({companionId:cid,userId:uid,tier:'thin',expectedRecallRevision:0,
  turns:[{role:'user',content:'我送过你一把雨伞',topic:'雨伞',created_at:'2026-01-01 00:00:00'}],
  memoryEvents:[{content:'雨天送伞（3 天前发生）',importance:7}],...extra});
try {
  await test('synthetic turns cannot crowd real turns out of chat context', () => {
    scope(); const real = m.saveConversationTurn(cid,'user','我喜欢骑车');
    m.bulkInsertSyntheticTurns(cid,Array.from({length:60},()=>({role:'user',content:'我喜欢游戏',created_at:'2099-01-01 00:00:00'})));
    assert.deepEqual(m.getConversationContext(cid,10).map(t=>t.id),[real.id]);
  });
  await test('synthetic memory is manageable but never recalled or used as derivative evidence', () => {
    scope(); const id = memory('模拟事件',{memoryOrigin:'synthetic',originMetadata:{generator:'test'}});
    assert.equal(row(id).memory_origin,'synthetic');
    assert.equal(m.getRecallableMemories(cid,uid).length,0);
    assert.equal(memory('派生摘要',{sourceMemoryIds:[id]}),null);
    assert.equal(m.getMemoriesV2(cid).memories[0].memory_origin,'synthetic');
    m.patchMemory(id,cid,{memory_source:'user',content:'手动编辑模拟事件'});
    assert.equal(m.getRecallableMemories(cid,uid).length,0);
  });
  await test('grounded evidence has conversation origin; legacy remains unknown', () => {
    scope(); assert.equal(row(memory('旧记录')).memory_origin,'unknown');
    const t = m.saveConversationTurn(cid,'user','我喜欢游泳');
    const r = m.saveGroundedMemory({companionId:cid,userId:uid,memoryType:'fact',subject:'user',evidence:[{turn_id:t.id,quote:t.content}],allowedTurnIds:[t.id],expectedRecallRevision:0});
    assert.equal(r.memory.memory_origin,'conversation');
  });
  await test('synthetic persistence is atomic, counted, provenance-tagged and affection-neutral', () => {
    scope(); m.upsertEmotionState(cid,{affection:12}); const before=m.getEmotionState(cid);
    assert.deepEqual(synthetic(),{turnCount:1,memoryCount:1});
    const stored = m.getMemoriesV2(cid).memories[0];
    assert.equal(stored.memory_origin,'synthetic'); assert.equal(stored.memory_subject,'unknown');
    const meta = JSON.parse(stored.origin_metadata);
    assert.equal(meta.generator,'backfill_history'); assert.equal(meta.turn_ids.length,1);
    assert.equal(db.prepare('SELECT synthetic FROM companion_conversation_turns WHERE id=?').get(meta.turn_ids[0]).synthetic,1);
    assert.deepEqual(m.getEmotionState(cid),before); assert.equal(m.getRecallableMemories(cid,uid).length,0);
    assert.equal(synthetic(),null); assert.deepEqual(synthetic({force:true}),{turnCount:1,memoryCount:1});
  });
  await test('stale epoch, foreign owner and empty synthetic batches write nothing', () => {
    scope(); assert.equal(synthetic({userId:uid+1}),null); assert.equal(synthetic({expectedRecallRevision:1}),null);
    assert.equal(synthetic({turns:[]}),null);
    assert.equal(m.getCompanionBackfillStatus(cid).syntheticCount,0);
    assert.equal(m.getCompanionBackfillStatus(cid).backfilledAt,null);
  });
  await test('reviewed quarantine verifies complete batch then revokes derivatives without deleting rows', () => {
    scope(); const id=memory('旧模拟事件'); const dependent=memory('旧摘要',{sourceMemoryIds:[id]});
    const entry={id,contentHash:hashMemoryContent(row(id).content)};
    assert.equal(m.quarantineSyntheticMemories(cid,uid,[entry,{id:dependent,contentHash:'bad'}],{expectedRecallRevision:0}),null);
    assert.equal(row(id).memory_origin,'unknown');
    assert.equal(m.quarantineSyntheticMemories(cid,uid+1,[entry],{expectedRecallRevision:0}),null);
    assert.equal(m.quarantineSyntheticMemories(cid,uid,[entry],{expectedRecallRevision:0}),1);
    assert.equal(row(id).memory_origin,'synthetic'); assert.ok(row(dependent));
    assert.equal(m.getRecallableMemories(cid,uid).length,0);
  });
  await test('profile statistics and topic inference ignore synthetic user assertions', async () => {
    scope(); m.saveConversationTurn(cid,'user','今天下雨了');
    m.bulkInsertSyntheticTurns(cid,[{role:'user',content:'游戏游戏电脑游戏',created_at:'2026-01-01 00:00:00'}]);
    const p = await import('../src/user_profile.mjs');
    // Other fixtures use the same owner, so compare totals to real stored turns.
    const count=db.prepare('SELECT COUNT(*) n FROM companion_conversation_turns t JOIN companions c ON c.id=t.companion_id WHERE c.user_id=? AND COALESCE(t.synthetic,0)=0').get(uid).n;
    assert.equal(p.computeMessageStats(uid).total,count);
    assert.equal(p.computeTopicTendency(uid).topics.hobby_game.hits,0);
  });
} finally { db.close(); process.on('exit',()=>rmSync(temp,{recursive:true,force:true})); }
