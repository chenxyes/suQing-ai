import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = mkdtempSync(path.join(tmpdir(), 'memory-admission-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.LOG_DIR = path.join(temp, 'logs');
const m = await import('../src/db.mjs');
const db = m.getDb();
db.pragma('foreign_keys = OFF'); // Deliberately minimal independent scope fixtures.
let companionId = 800;
const userId = 'fixture-owner';
const row = id => db.prepare('SELECT * FROM companion_memories WHERE id=?').get(id);
function add(content, extra = {}) {
  m.saveMemory({ companionId, userId, content, memoryType: 'fact', importance: 6, pinned: false, ...extra });
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}
try {
  await test('all recall readers exclude non-active and forbidden rows, even pinned or semantic matches', () => {
    companionId++;
    const visible = add('保留的运动偏好', { embedding: [1, 0] });
    for (const status of ['deleted', 'archived', 'contradicted']) {
      const id = add('受限制的运动偏好', { importance: 10, pinned: true, embedding: [1, 0] });
      db.prepare('UPDATE companion_memories SET memory_status=? WHERE id=?').run(status, id);
    }
    const forbidden = add('禁止提及的运动偏好', { importance: 10, pinned: true, embedding: [1, 0] });
    db.prepare('UPDATE companion_memories SET do_not_mention=1 WHERE id=?').run(forbidden);
    assert.deepEqual(m.recallMemories(companionId, userId, '运动偏好', 20).map(r => r.id), [visible]);
    assert.deepEqual(m.recallMemoriesSemantic(companionId, userId, [1, 0], 20).map(r => r.id), [visible]);
    assert.deepEqual(m.getMemories(companionId, userId, 20).map(r => r.id), [visible]);
    assert.equal(m.getMemoriesV2(companionId, { status: null }).total, 5, 'management retains restricted records');
    assert.equal(m.getMemoriesV2(companionId, { status: 'deleted' }).total, 1);
  });
  await test('semantic recall preserves sensitivity/layer/permission fields for downstream guards', () => {
    companionId++;
    const id = add('需要谨慎处理的情绪', { embedding: [1, 0], memoryLayer: 'emotion' });
    db.prepare('UPDATE companion_memories SET sensitive_flag=1 WHERE id=?').run(id);
    const [result] = m.recallMemoriesSemantic(companionId, userId, [1, 0]);
    assert.equal(result.sensitive_flag, 1);
    assert.equal(result.memory_layer, 'emotion');
    assert.equal(result.do_not_mention, 0);
  });
  await test('legacy summaries are withheld after revocation; traced unaffected summaries remain usable', () => {
    companionId++;
    const source = add('想撤销的旧事实');
    const unaffected = add('独立的新事实');
    const legacy = add('2026-10-01 日记忆：含旧事实', { memoryType: 'daily_summary' });
    const derived = add('2026-10-02 周记忆：旧事实的转述', { memoryType: 'weekly_summary', sourceMemoryIds: [source] });
    const descendant = add('2026-10 月记忆：另一种转述', { memoryType: 'monthly_summary', sourceMemoryIds: [derived] });
    const safe = add('2026-10-03 日记忆：独立事实', { memoryType: 'daily_summary', sourceMemoryIds: [unaffected] });
    m.softDeleteMemory(source, companionId);
    const ids = m.getMemories(companionId, userId, 30).map(r => r.id);
    for (const id of [source, legacy, derived, descendant]) assert.ok(!ids.includes(id), `revoked lineage ${id}`);
    assert.ok(ids.includes(safe));
    assert.deepEqual(m.getRecentSummaries(companionId, userId, 'daily_summary').map(r => r.id), [safe]);
    assert.equal(m.summaryMemoryExists(companionId, userId, 'daily_summary', '2026-10-01'), true, 'no automatic regeneration of hidden prefix');
    assert.equal(m.getMemoriesV2(companionId, { status: null }).total, 6);
    m.patchMemory(source, companionId, { memory_status: 'active' });
    assert.ok(!m.getMemories(companionId, userId, 30).some(r => r.id === derived), 'restoring source must not implicitly approve old derivative');
  });
  await test('hard deletion retains revocation barrier; no cross-user or cross-companion source links', () => {
    companionId++;
    const source = add('待硬删除事实');
    const legacy = add('旧周摘要', { memoryType: 'weekly_summary' });
    const stranger = add('别人的事实', { userId: 'another-owner' });
    const neighbor = add('其他角色事实', { companionId: companionId + 100 });
    m.deleteMemory(source, companionId);
    assert.ok(!m.getMemories(companionId, userId).some(r => r.id === legacy));
    assert.ok(!m.getMemories(companionId, userId).some(r => r.id === stranger || r.id === neighbor));
    assert.equal(m.saveMemory({ companionId, userId, memoryType: 'weekly_summary', content: '越界依赖', sourceMemoryIds: [stranger] }), null);
    assert.equal(m.saveMemory({ companionId, userId, memoryType: 'weekly_summary', content: '失效依赖', sourceMemoryIds: [source] }), null);
  });
  await test('single, bulk and patch share privacy guard; rejected patch cannot change flags', () => {
    companionId++;
    const secret = '密码是：synthetic-secret-123';
    assert.equal(m.saveMemory({ companionId, userId, memoryType: 'fact', content: secret }), null);
    m.saveMemories([{ companionId, userId, memoryType: 'fact', content: secret },
      { companionId, userId, memoryType: 'fact', content: '他喜欢散步', keywords: [secret] },
      { companionId, userId, memoryType: 'fact', content: '电话13812345678', embedding: [1, 0], keywords: ['13812345678'] }]);
    const stored = db.prepare('SELECT * FROM companion_memories WHERE companion_id=?').all(companionId);
    assert.equal(stored.length, 1);
    assert.ok(!stored[0].content.includes('13812345678'));
    assert.ok(!stored[0].keywords.includes('13812345678'));
    assert.equal(stored[0].embedding, null, 'redaction invalidates embedding of original text');
    const id = stored[0].id;
    m.softDeleteMemory(id, companionId);
    assert.equal(m.patchMemory(id, companionId, { content: secret, memory_status: 'active' }), null);
    assert.equal(row(id).memory_status, 'deleted');
    assert.ok(!row(id).content.includes(secret));
  });
  await test('content edits invalidate old embeddings and dependent summaries atomically', () => {
    companionId++;
    const id = add('原来的事实', { embedding: [1, 0] });
    const summary = add('原来的概括', { memoryType: 'weekly_summary', sourceMemoryIds: [id] });
    m.patchMemory(id, companionId, { content: '更正后的事实' });
    assert.equal(row(id).embedding, null);
    assert.equal(row(id).content, '更正后的事实');
    assert.ok(!m.getMemories(companionId, userId).some(r => r.id === summary));
  });
  await test('old profile and conversation-derived input cannot replay revoked facts; management still reads profile', () => {
    companionId++;
    const id = add('要撤销的职业');
    m.upsertUserProfile(userId, companionId, { user_occupation: '旧职业' });
    db.prepare("INSERT INTO companion_conversation_turns(companion_id,role,content) VALUES (?, 'user', '旧消息')").run(companionId);
    m.softDeleteMemory(id, companionId);
    db.prepare("INSERT INTO companion_conversation_turns(companion_id,role,content) VALUES (?, 'user', '新消息')").run(companionId);
    assert.equal(m.getUserProfile(userId, companionId).user_occupation, '旧职业');
    assert.equal(m.getUserProfileForRecall(userId, companionId), null);
    const turns = m.getConversationTurnsBetween(companionId, '2000-01-01', '2100-01-01');
    assert.deepEqual(turns.map(t => t.content), ['新消息']);
    assert.equal(m.getConversationContext(companionId).length, 2, 'chat history remains a separate user-controlled record');
  });
  await test('generation started before revocation cannot save after it, and soft-clear advances barrier', () => {
    companionId++;
    const source = add('待撤销素材');
    const before = m.getMemoryRecallBarrier(companionId, userId).revision;
    m.softClearMemories(companionId, userId);
    const after = m.getMemoryRecallBarrier(companionId, userId).revision;
    assert.ok(after > before);
    assert.equal(m.saveMemory({ companionId, userId, memoryType: 'fact', content: '迟到的生成', expectedRecallRevision: before }), null);
    assert.equal(m.patchMemory(source, companionId, { content: '迟到的修改' }, { expectedRecallRevision: before }), null);
    assert.ok(m.saveMemory({ companionId, userId, memoryType: 'daily_summary', content: '来自撤销后的新对话', sourceMemoryIds: [], expectedRecallRevision: after }));
    assert.equal(m.getRecentSummaries(companionId, userId, 'daily_summary').length, 1);
  });
  await test('numeric SQLite user IDs address the same durable barrier as textual IDs', () => {
    companionId++;
    const numericUserId = 41;
    const id = add('数字ID所属事实', { userId: numericUserId });
    m.upsertUserProfile(numericUserId, companionId, { notes: '撤销前的画像' });
    // Migration inserts INTEGER source IDs into TEXT storage, while JS binds numbers as REAL.
    db.prepare(`INSERT INTO memory_recall_barriers(companion_id,user_id,revision,revoked_at,turn_id_cutoff)
      SELECT companion_id,user_id,1,CURRENT_TIMESTAMP,0 FROM companion_memories WHERE id=?`).run(id);
    assert.equal(m.getMemoryRecallBarrier(companionId, numericUserId).revision, 1);
    assert.equal(m.getMemoryRecallBarrier(companionId, String(numericUserId)).revision, 1);
    assert.equal(m.getUserProfileForRecall(numericUserId, companionId), null);
    m.softDeleteMemory(id, companionId);
    assert.equal(m.getMemoryRecallBarrier(companionId, numericUserId).revision, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_recall_barriers WHERE companion_id=?').get(companionId).n, 1);
  });
  await test('retention keeps source evidence needed by a surviving summary; explicit deletion still revokes it', () => {
    companionId++;
    const owner = 42;
    db.prepare("INSERT INTO users(id,wechat_user_id,plan) VALUES (?, 'retention-fixture', 'pro')").run(owner);
    const daily = add('旧日摘要', { userId: owner, memoryType: 'daily_summary' });
    db.prepare("UPDATE companion_memories SET created_at='2025-01-01' WHERE id=?").run(daily);
    const weekly = add('仍在保留期的周摘要', { userId: owner, memoryType: 'weekly_summary', sourceMemoryIds: [daily] });
    m.cleanupPlanMemories(new Date('2026-10-19T00:00:00Z'));
    assert.ok(row(daily), 'source of a surviving derived memory must not be purged by retention');
    assert.ok(m.getRecentSummaries(companionId,owner,'weekly_summary').some(r => r.id === weekly));
    m.deleteMemory(daily,companionId);
    assert.ok(!m.getRecentSummaries(companionId,owner,'weekly_summary').some(r => r.id === weekly));
  });
} finally {
  db.close();
  process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
}
