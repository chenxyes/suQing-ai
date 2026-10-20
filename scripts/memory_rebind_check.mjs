import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = mkdtempSync(path.join(tmpdir(), 'memory-rebind-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.LOG_DIR = path.join(temp, 'logs');
const m = await import('../src/db.mjs');
const db = m.getDb();

function setup(oldUser, newUser, companionId, { revoke = true } = {}) {
  db.prepare('INSERT INTO user_accounts(id,username,email,password_hash) VALUES(?,?,?,?)')
    .run(oldUser, `fixture-${oldUser}`, `fixture-${oldUser}@example.invalid`, 'synthetic-password-hash');
  db.prepare('INSERT INTO users(id,wechat_user_id) VALUES(?,?)').run(oldUser, `synthetic-old-${oldUser}`);
  db.prepare('INSERT INTO users(id,wechat_user_id) VALUES(?,?)').run(newUser, `synthetic-new-${newUser}`);
  db.prepare('INSERT INTO companions(id,user_id,bot_id) VALUES(?,?,?)').run(companionId, oldUser, `fixture-bot-${companionId}`);
  m.upsertUserProfile(oldUser, companionId, { notes: '仅用于回归的旧画像标记' });
  const source = m.saveMemory({ companionId, userId: oldUser, memoryType: 'fact', content: '仅用于回归的旧画像标记' });
  db.prepare("INSERT INTO companion_conversation_turns(companion_id,role,content) VALUES(?,'user','旧会话合成标记')").run(companionId);
  if (revoke) m.softDeleteMemory(source, companionId);
  return m.getMemoryRecallBarrier(companionId, oldUser);
}
function rebind(oldUser, newUser, companionId) {
  return m.rebindWechatAccount({ accountId: oldUser, wechatUserId: `synthetic-new-${newUser}`,
    botId: `fixture-bot-${companionId}`, botToken: 'synthetic-token' });
}
try {
  await test('actual rebind carries the recall barrier when memories and profiles move to another user ID', () => {
    const oldUser = 92711, newUser = 92712, companionId = 92713;
    const before = setup(oldUser, newUser, companionId);
    assert.equal(m.getUserProfileForRecall(oldUser, companionId), null);
    assert.ok(before.revision > 0 && before.turn_id_cutoff > 0);
    const result = rebind(oldUser, newUser, companionId);
    assert.equal(result.companionId, companionId);
    assert.equal(db.prepare('SELECT user_id FROM companions WHERE id=?').get(companionId).user_id, newUser);
    assert.equal(m.getUserProfileForRecall(newUser, companionId), null, 'rebind must not resurrect the withheld old profile');
    const after = m.getMemoryRecallBarrier(companionId, newUser);
    assert.ok(after.revision >= before.revision, 'moved scope retains revocation revision');
    assert.ok(after.turn_id_cutoff >= before.turn_id_cutoff, 'moved scope retains conversation cutoff');
    assert.equal(m.getUserProfile(newUser, companionId).notes, '仅用于回归的旧画像标记', 'management still owns the moved profile');
    assert.deepEqual(m.getConversationTurnsBetween(companionId, '2000-01-01', '2100-01-01'), []);
  });
  await test('rebind merges an existing destination barrier without lowering its revision or cutoff', () => {
    const oldUser = 92721, newUser = 92722, companionId = 92723;
    const before = setup(oldUser, newUser, companionId);
    db.prepare('INSERT INTO memory_recall_barriers(companion_id,user_id,revision,revoked_at,turn_id_cutoff) VALUES(?,?,?,?,?)')
      .run(companionId, String(newUser), before.revision + 5, '2026-10-19T00:00:00Z', before.turn_id_cutoff + 7);
    rebind(oldUser, newUser, companionId);
    const after = m.getMemoryRecallBarrier(companionId, newUser);
    assert.ok(after.revision >= before.revision + 5);
    assert.ok(after.turn_id_cutoff >= before.turn_id_cutoff + 7);
    assert.equal(m.getUserProfileForRecall(newUser, companionId), null);
  });
  await test('matching source and destination revisions do not approve old conversation-derived summaries', () => {
    const oldUser = 92731, newUser = 92732, companionId = 92733;
    const before = setup(oldUser, newUser, companionId);
    const daily = m.saveMemory({ companionId, userId: oldUser, memoryType: 'daily_summary', content: '迁移前合成日摘要',
      sourceMemoryIds: [], expectedRecallRevision: before.revision });
    const weekly = m.saveMemory({ companionId, userId: oldUser, memoryType: 'weekly_summary', content: '迁移前合成周摘要',
      sourceMemoryIds: [daily], expectedRecallRevision: before.revision });
    assert.ok(m.getRecallableMemories(companionId, oldUser).some(row => row.id === weekly));
    db.prepare('INSERT INTO memory_recall_barriers(companion_id,user_id,revision,revoked_at,turn_id_cutoff) VALUES(?,?,?,?,?)')
      .run(companionId, String(newUser), before.revision, before.revoked_at, before.turn_id_cutoff);
    rebind(oldUser, newUser, companionId);
    const after = m.getMemoryRecallBarrier(companionId, newUser);
    assert.ok(after.revision > before.revision, 'owner migration creates a fresh revision beyond both matching counters');
    assert.equal(m.getMemoryRecallBarrier(companionId, oldUser).revision, before.revision, 'old scope tombstone is retained');
    for (const id of [daily, weekly]) {
      const row = db.prepare('SELECT user_id,recall_blocked FROM companion_memories WHERE id=?').get(id);
      assert.equal(row.user_id, newUser);
      assert.equal(row.recall_blocked, 1, 'old derived rows remain withheld after moving');
      assert.ok(!m.getRecallableMemories(companionId, newUser).some(memory => memory.id === id));
    }
  });
  for (const revoke of [true, false]) {
    await test('late generation from the old owner is rejected after rebind, revoked=' + revoke, () => {
      const oldUser = revoke ? 92741 : 92751, newUser = oldUser + 1, companionId = oldUser + 2;
      const before = setup(oldUser, newUser, companionId, { revoke });
      const stale = { companionId, userId: oldUser, memoryType: 'fact', content: '旧scope迟到生成', expectedRecallRevision: before.revision };
      rebind(oldUser, newUser, companionId);
      assert.equal(m.saveMemory(stale), null, 'old owner cannot save even if its unchanged revision still matches');
      assert.deepEqual(m.saveMemories([stale]), [null], 'bulk generation uses the same owner guard');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM companion_memories WHERE companion_id=? AND user_id=?').get(companionId,oldUser).n, 0);
      const revision = m.getMemoryRecallBarrier(companionId, newUser).revision;
      assert.ok(m.saveMemory({ companionId, userId: newUser, memoryType: 'fact', content: '迁移后新事实', expectedRecallRevision: revision }),
        'current owner generation remains usable');
    });
  }
} finally {
  db.close();
  process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
}
