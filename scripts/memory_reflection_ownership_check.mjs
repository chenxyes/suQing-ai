/** Offline integration: Node22 scripts/memory_reflection_ownership_check.mjs */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = mkdtempSync(path.join(tmpdir(), 'reflection-ownership-'));
process.env.DB_PATH = path.join(temp, 'fixture.db');
process.env.LOG_DIR = path.join(temp, 'logs');
process.env.EMBEDDING_PROVIDER = 'offline-fixture';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const dbApi = await import('../src/db.mjs');
const reflection = await import('../src/reflection.mjs');
const memory = await import('../src/memory_v2.mjs');
const db = dbApi.getDb();
db.pragma('foreign_keys = OFF');
let sequence = 910000, passed = 0, failed = 0;
function fixture() {
  const companionId = ++sequence, userId = sequence;
  db.prepare('INSERT INTO companions(id,user_id,bot_id,name) VALUES(?,?,?,?)').run(companionId, userId, 'fixture', '合成角色');
  const turn = (role, content) => dbApi.saveConversationTurn(companionId, role, content);
  const rows = () => dbApi.getRecallableMemories(companionId, userId);
  const options = (turns, shown = []) => ({ userId, expectedRecallRevision: dbApi.getMemoryRecallBarrier(companionId, userId).revision,
    sourceMemoryIds: shown, shownMemoryIds: shown, allowedTurnIds: turns.map(row => row.id) });
  const add = (content, subject = 'user', extra = {}) => {
    const id = dbApi.saveMemory({ companionId, userId, content, memoryType: 'fact', memoryLayer: 'user_fact', pinned: false, ...extra });
    if (db.prepare('PRAGMA table_info(companion_memories)').all().some(row => row.name === 'memory_subject')) {
      db.prepare('UPDATE companion_memories SET memory_subject=? WHERE id=?').run(subject, id);
    }
    return id;
  };
  return { companionId, userId, turn, rows, options, add };
}
const candidate = (turn, subject = 'user', content = turn.content) => ({ memory_layer: 'user_fact', memory_weight: 3,
  content, confidence: 0.95, subject, evidence: [{ turn_id: turn.id, quote: turn.content }], replaces_memory_ids: [] });
async function check(name, fn) {
  try { await fn(); passed++; } catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}
try {
  await check('prompt exposes actual roles, turn IDs and memory IDs with subject', () => {
    const prompt = reflection.buildReflectionPrompt({ name: '角色' }, [{ id: 44321, role: 'assistant', content: '我喜欢红色。' }],
      [{ id: 55678, memory_layer: 'user_fact', memory_subject: 'unknown', content: '旧记录' }]);
    assert.ok(prompt.includes('44321') && prompt.includes('assistant'));
    assert.ok(prompt.includes('55678') && prompt.includes('unknown'));
  });
  await check('normalization preserves evidence and correction metadata', () => {
    const row = candidate({ id: 73, content: '我喜欢蓝色。' }); row.replaces_memory_ids = [91];
    const normalized = reflection.normalizeReflectionResult({ new_memories: [row], updated_memories: [
      { memory_id: 91, new_content: '我现在喜欢蓝色。', subject: 'user', evidence: row.evidence },
    ] });
    assert.equal(normalized.new_memories[0].subject, 'user');
    assert.deepEqual(normalized.new_memories[0].evidence, row.evidence);
    assert.deepEqual(normalized.new_memories[0].replaces_memory_ids, [91]);
    assert.deepEqual(normalized.updated_memories[0].evidence, row.evidence);
  });
  for (const [name, role, quote, subject] of [
    ['assistant statement cannot become user fact', 'assistant', '我喜欢红色。', 'user'],
    ['third-party quote cannot become user fact', 'user', '我的朋友说：“我喜欢红色。”', 'user'],
    ['hypothetical cannot become user fact', 'user', '假如我喜欢红色，那会怎样？', 'user'],
    ['bare assent cannot ground fact', 'user', '是的。', 'user'],
  ]) await check(name, async () => {
    const f = fixture(), turn = f.turn(role, quote);
    const result = await reflection.applyReflectionMemoryUpdates(f.companionId, { new_memories: [candidate(turn, subject, '他喜欢红色。')] }, f.options([turn]));
    assert.equal(result.inserted, 0); assert.equal(f.rows().length, 0);
  });
  await check('validated self assertion stores canonical evidence and duplicate is inert', async () => {
    const f = fixture(), turn = f.turn('user', '我喜欢蓝色。');
    const updates = { new_memories: [candidate(turn, 'user', '他喜欢橙色。')] };
    const first = await reflection.applyReflectionMemoryUpdates(f.companionId, updates, f.options([turn]));
    assert.equal(first.inserted, 1); const row = f.rows()[0];
    assert.equal(row.memory_subject, 'user'); assert.ok(row.content.includes('蓝色')); assert.ok(!row.content.includes('橙色'));
    const second = await reflection.applyReflectionMemoryUpdates(f.companionId, updates, f.options([turn]));
    assert.equal(second.inserted, 0); assert.equal(second.merged, 0); assert.equal(f.rows().length, 1);
    assert.equal(f.rows()[0].memory_weight, row.memory_weight);
  });
  await check('actual allowed turn list is required', async () => {
    const f = fixture(), turn = f.turn('user', '我喜欢蓝色。');
    const result = await reflection.applyReflectionMemoryUpdates(f.companionId, { new_memories: [candidate(turn)] }, f.options([]));
    assert.equal(result.inserted, 0); assert.equal(f.rows().length, 0);
  });
  for (const mode of ['forged', 'missing', 'foreign', 'synthetic', 'stale']) await check(`${mode} evidence cannot write`, async () => {
    const f = fixture(); let turn = f.turn('user', '我喜欢蓝色。');
    if (mode === 'foreign') turn = fixture().turn('user', '我喜欢蓝色。');
    if (mode === 'synthetic') db.prepare('UPDATE companion_conversation_turns SET synthetic=1 WHERE id=?').run(turn.id);
    const row = candidate(turn), options = f.options([turn]);
    if (mode === 'forged') row.evidence[0].turn_id = 999999999;
    if (mode === 'missing') delete row.evidence;
    if (mode === 'stale') options.expectedRecallRevision++;
    const result = await reflection.applyReflectionMemoryUpdates(f.companionId, { new_memories: [row] }, options);
    assert.equal(result.inserted, 0); assert.equal(f.rows().length, 0);
  });
  await check('companion self assertion retains its subject', async () => {
    const f = fixture(), turn = f.turn('assistant', '我喜欢蓝色。');
    const result = await reflection.applyReflectionMemoryUpdates(f.companionId, { new_memories: [candidate(turn, 'companion')] }, f.options([turn]));
    assert.equal(result.inserted, 1); assert.equal(f.rows()[0].memory_subject, 'companion');
    const correction = f.turn('user', '我不再喜欢蓝色，我喜欢红色。');
    const result2 = await reflection.applyReflectionMemoryUpdates(f.companionId, { updated_memories: [{ memory_id: f.rows()[0].id,
      new_content: correction.content, ...candidate(correction) }] }, f.options([correction], [f.rows()[0].id]));
    assert.equal(result2.updated, 0); assert.equal(f.rows()[0].memory_subject, 'companion');
  });
  await check('shared assertion requires both real roles', async () => {
    const f = fixture(), user = f.turn('user', '我们喜欢蓝色。'), assistant = f.turn('assistant', '我们喜欢蓝色。');
    const row = candidate(user, 'shared');
    const one = await reflection.applyReflectionMemoryUpdates(f.companionId, { new_memories: [row] }, f.options([user, assistant]));
    assert.equal(one.inserted, 0);
    row.evidence.push({ turn_id: assistant.id, quote: assistant.content });
    const both = await reflection.applyReflectionMemoryUpdates(f.companionId, { new_memories: [row] }, f.options([user, assistant]));
    assert.equal(both.inserted, 1); assert.equal(f.rows()[0].memory_subject, 'shared');
  });
  await check('unshown update target and unshown replacement are rejected', async () => {
    const f = fixture(), target = f.add('我喜欢红色。');
    const turn = f.turn('user', '我不再喜欢红色，我喜欢蓝色。');
    const update = { memory_id: target, new_content: turn.content, subject: 'user', evidence: candidate(turn).evidence };
    const result = await reflection.applyReflectionMemoryUpdates(f.companionId, { updated_memories: [update],
      new_memories: [{ ...candidate(turn), replaces_memory_ids: [target] }] }, f.options([turn]));
    assert.equal(result.updated, 0); assert.equal(result.inserted, 0);
    assert.equal(f.rows().find(row => row.id === target).content, '我喜欢红色。');
  });
  await check('shown correction replaces identity and protects old record', async () => {
    const f = fixture(), original = f.turn('user', '我喜欢红色。');
    await reflection.applyReflectionMemoryUpdates(f.companionId, { new_memories: [candidate(original)] }, f.options([original]));
    const target = f.rows()[0]; assert.ok(target);
    const turn = f.turn('user', '我不再喜欢红色，我喜欢蓝色。');
    const result = await reflection.applyReflectionMemoryUpdates(f.companionId, { updated_memories: [{ memory_id: target.id,
      new_content: turn.content, subject: 'user', evidence: candidate(turn).evidence }] }, f.options([turn], [target.id]));
    assert.equal(result.updated, 1);
    const old = db.prepare('SELECT * FROM companion_memories WHERE id=?').get(target.id);
    assert.equal(old.memory_status, 'contradicted'); assert.equal(old.content, target.content);
    assert.ok(f.rows().some(row => row.id !== target.id && row.content.includes('蓝色')));
  });
  for (const field of ['locked', 'pinned']) await check(`${field} target cannot be corrected`, async () => {
    const f = fixture(), target = f.add('我喜欢红色。');
    db.prepare(`UPDATE companion_memories SET ${field}=1 WHERE id=?`).run(target);
    const turn = f.turn('user', '我不再喜欢红色，我喜欢蓝色。');
    const result = await reflection.applyReflectionMemoryUpdates(f.companionId, { new_memories: [{ ...candidate(turn), replaces_memory_ids: [target] }],
      updated_memories: [{ memory_id: target, new_content: turn.content, subject: 'user', evidence: candidate(turn).evidence }] }, f.options([turn], [target]));
    assert.equal(result.inserted, 0); assert.equal(result.updated, 0); assert.equal(f.rows().length, 1);
  });
  await check('pure dedupe retains cross-subject and unknown records', () => {
    const common = { companion_id: 1, user_id: 1, memory_layer: 'user_fact', content: 'likes green tea every morning' };
    const rows = ['user', 'companion', 'unknown', 'unknown'].map(memory_subject => ({ ...common, memory_subject }));
    assert.equal(memory.dedupeMemories(rows).length, 4);
  });
  await check('known-subject candidate never fuzzily merges or bumps legacy record', async () => {
    const f = fixture(), target = f.add('user likes green tea every morning', 'unknown');
    const result = await memory.addOrMergeMemory(f.companionId, { content: 'user likes green tea every morning', memory_layer: 'user_fact', subject: 'user' }, { userId: f.userId });
    assert.equal(result.action, 'insert'); assert.equal(f.rows().find(row => row.id === target).memory_weight, 3);
  });
  await check('legacy similarity query cannot mix subjects or unknown ownership', async () => {
    const f = fixture(); f.add('likes green tea every morning', 'companion'); f.add('likes green tea every morning', 'unknown');
    assert.equal(await memory.findSimilarMemoryByEmbedding(f.companionId, 'likes green tea every morning', { userId: f.userId, subject: 'user' }), null);
    assert.equal(await memory.findSimilarMemoryByEmbedding(f.companionId, 'likes green tea every morning', { userId: f.userId }), null);
  });
} finally {
  db.close(); process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
}
console.log(`memory_reflection_ownership_check: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
