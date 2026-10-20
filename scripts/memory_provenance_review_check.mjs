import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = mkdtempSync(path.join(tmpdir(), 'memory-provenance-review-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.LOG_DIR = path.join(temp, 'logs');
const m = await import('../src/db.mjs');
const db = m.getDb();
db.pragma('foreign_keys = OFF');
let companionId = 99500;
const userId = 99400;
function scope() {
  companionId++;
  db.prepare('INSERT INTO companions(id,user_id,bot_id) VALUES(?,?,?)').run(companionId,userId,`review-${companionId}`);
}
function save(text, quote = text, extra = {}) {
  const turn = m.saveConversationTurn(companionId,'user',text);
  return m.saveGroundedMemory({companionId,userId,memoryType:'fact',subject:'user',content:quote,
    evidence:[{turn_id:turn.id,quote}],allowedTurnIds:[turn.id],
    expectedRecallRevision:m.getMemoryRecallBarrier(companionId,userId).revision,...extra});
}
try {
  await test('a negated source cannot establish an affirmative profile hobby by substring', () => {
    scope();
    const source = save('我不喜欢游泳').memory;
    assert.ok(source);
    m.upsertUserProfile(userId,companionId,{user_hobbies:['游泳']},
      {sourceMemoryIds:[source.id],expectedRecallRevision:0});
    assert.ok(!m.getUserProfileForRecall(userId,companionId)?.user_hobbies?.includes('游泳'));
  });
  await test('a surrounding retraction cannot be dropped by selecting its earlier clause', () => {
    scope();
    assert.equal(save('我有一个妹妹，这句话是假的','我有一个妹妹').action,'rejected');
    assert.equal(save('我有一个妹妹，这是你的原话','我有一个妹妹').action,'rejected');
  });
  await test('mentioning an old claim elsewhere does not authorize an unrelated replacement', () => {
    scope();
    const old = save('我有一个妹妹').memory;
    const result = save('更正，旧记忆里的我有一个妹妹不是真的，我喜欢骑车','我喜欢骑车',
      {replacesMemoryIds:[old.id]});
    assert.equal(result.action,'rejected');
    assert.ok(m.getRecallableMemories(companionId,userId).some(row=>row.id===old.id));
  });
} finally {
  db.close();
  process.on('exit',()=>rmSync(temp,{recursive:true,force:true}));
}
