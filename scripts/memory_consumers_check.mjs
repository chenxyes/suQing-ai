/** Run offline: node --experimental-vm-modules scripts/memory_consumers_check.mjs */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { filterRecallableMemoryRows } from '../src/memory_admission.mjs';
import vm from 'node:vm';
import path from 'node:path';
import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec(`CREATE TABLE companions (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT);
INSERT INTO companions VALUES (1,10,'合成角色');
CREATE TABLE companion_memories (id INTEGER PRIMARY KEY, companion_id INTEGER, user_id INTEGER,
 memory_type TEXT, memory_layer TEXT, memory_subject TEXT DEFAULT 'user', memory_weight INTEGER DEFAULT 3, content TEXT, embedding BLOB,
 memory_status TEXT DEFAULT 'active', do_not_mention INTEGER DEFAULT 0, recall_blocked INTEGER DEFAULT 0,
 pinned INTEGER DEFAULT 0, locked INTEGER DEFAULT 0, importance INTEGER DEFAULT 5,
 sensitive_flag INTEGER DEFAULT 0, source_memory_ids TEXT, created_at TEXT DEFAULT '2026-10-18', updated_at TEXT, memory_source TEXT);`);
let revision = 0, saved = [], files = [], graph = [], prompts = [], logs = [], rejectSave = false, rejectPatch = false;
let onModel = () => {}, onEmbed = () => {}, modelResult = '合成摘要', embedResult = null;
let turnFixture = [1, 2, 3].map(id => ({ id, role: 'user', content: '我喜欢蓝色。' }));
const basic = row => row && (!row.memory_status || row.memory_status === 'active') && !Number(row.do_not_mention) && !Number(row.recall_blocked);
const scopeRows = (cid, uid) => filterRecallableMemoryRows(db.prepare('SELECT * FROM companion_memories WHERE companion_id=? AND user_id=? ORDER BY importance DESC, created_at DESC').all(cid, uid ?? 10), { hasRevocations: revision > 0 });
const dbFns = {
  getDb: () => db,
  getAllActiveCompanions: () => [{ id: 1, user_id: 10, name: '合成角色' }],
  getRecallableMemories: scopeRows,
  getMemoryRecallBarrier: () => ({ revision, revoked_at: revision ? '2026-10-18' : null, turn_id_cutoff: 0 }),
  getConversationTurnsBetween: () => turnFixture,
  getMemoriesV2: () => ({ memories: db.prepare("SELECT * FROM companion_memories WHERE companion_id=1 AND memory_status='active'").all(), total: 1 }),
  summaryMemoryExists: () => false,
  shanghaiDateKey: date => date ? date.toISOString().slice(0, 10) : '2026-10-19', shanghaiBoundsForDateKey: () => ({ startSql: '2026-10-18', endSql: '2026-10-19' }),
  cleanupProcessedMessages: () => 0, cleanupAiUsageEvents: () => 0,
  cleanupPlanMemories: () => ({ freeDaily: 0, proDaily: 0, proWeekly: 0 }),
  listEpisodicMemoriesOlderThan: () => [],
  saveMemory: input => {
    saved.push(input);
    if (rejectSave || (input.expectedRecallRevision != null && input.expectedRecallRevision !== revision)) return null;
    return addRow({ content: input.content, memory_type: input.memoryType, memory_layer: input.memoryLayer || 'summary',
      memory_subject: input.subject ?? 'unknown', source_memory_ids: input.sourceMemoryIds == null ? null : JSON.stringify(input.sourceMemoryIds) });
  },
  saveGroundedMemory: input => {
    assert.ok(['user', 'companion', 'shared'].includes(input.subject));
    assert.ok(input.allowedTurnIds.includes(input.evidence[0].turn_id));
    const id = dbFns.saveMemory({ ...input, content: input.evidence[0].quote });
    return { action: id ? 'inserted' : 'rejected', memory: id ? db.prepare('SELECT * FROM companion_memories WHERE id=?').get(id) : null };
  },
  patchMemory: (id, cid, fields, options = {}) => {
    if (rejectPatch || (options.expectedRecallRevision != null && options.expectedRecallRevision !== revision)) return null;
    const row = scopeRows(cid).find(r => r.id === id);
    if (!row) return null;
    const keys = Object.keys(fields);
    db.prepare(`UPDATE companion_memories SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(fields), id);
    return db.prepare('SELECT * FROM companion_memories WHERE id=?').get(id);
  },
  touchMemory: () => {},
  legacyTypeForLayer: layer => ({ user_fact: 'fact', event: 'event', preference: 'preference', emotion: 'emotion' }[layer] || null),
};
function addRow(fields = {}) {
  const row = { companion_id: 1, user_id: 10, content: '合成记忆', memory_type: 'fact', memory_layer: 'user_fact', ...fields };
  return Number(db.prepare(`INSERT INTO companion_memories (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row)).lastInsertRowid);
}
function reset() {
  db.prepare('DELETE FROM companion_memories').run();
  revision = 0; saved = []; files = []; graph = []; prompts = []; logs = []; rejectSave = false; rejectPatch = false;
  onModel = () => {}; onEmbed = () => {}; modelResult = '合成摘要'; embedResult = null;
  turnFixture = [1, 2, 3].map(id => ({ id, role: 'user', content: '我喜欢蓝色。' }));
}
const context = vm.createContext({ console, process: { env: {}, cwd: () => '/unused' }, Buffer, URL, setInterval, clearInterval });
const modules = new Map();
async function load(file) {
  if (modules.has(file)) return modules.get(file);
  let source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  if (file === 'plan_tasks.mjs') source += '\nexport { runDaily, runWeekly, runMonthly };';
  const mod = new vm.SourceTextModule(source, { context, identifier: file });
  modules.set(file, mod);
  await mod.link(async spec => {
    if (spec === './memory_v2.mjs') return load('memory_v2.mjs');
    if (spec === './privacy_filter.mjs') return load('privacy_filter.mjs');
    if (['./memory_vectors.mjs', './memory_retrieval.mjs', './memory_indexing.mjs'].includes(spec)) return load(spec.slice(2));
    if (spec === './memory_admission.mjs') {
      try { return await load('memory_admission.mjs'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const matches = [...source.matchAll(/(?:import|export)\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)]
      .filter(match => match[2] === spec).flatMap(match => match[1].replace(/\/\/[^\n]*/g, '').split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
    const values = {};
    for (const key of matches) values[key] = () => { throw new Error(`unexpected boundary ${spec}:${key}`); };
    if (spec.startsWith('node:')) Object.assign(values, await import(spec));
    if (spec === './db.mjs') Object.assign(values, dbFns);
    if (spec === './memory_admission.mjs') Object.assign(values, { isMemoryRecallable: basic, filterRecallableMemoryRows: rows => rows.filter(basic) });
    if (spec === './ai.mjs') Object.assign(values, {
      embedText: async () => { onEmbed(); return embedResult; },
      embedTextWithDescriptor: async () => { onEmbed(); return embedResult; },
      generateReply: async (_system, _history, input) => { prompts.push(input); onModel(); return modelResult; },
      extractStructuredInfo: async (_system, input) => { prompts.push(input); onModel(); return modelResult; },
    });
    if (spec === './logger.mjs') values.log = (...args) => logs.push(args.join(' '));
    if (spec === './event_graph.mjs') values.processMemoryForGraph = (...args) => graph.push(args);
    if (spec === './reflection_heartbeat.mjs') for (const key of matches) values[key] = () => 'reflection fixture';
    if (spec === './chat_response.mjs') values.isChatFallback = () => false;
    if (spec === './achievements.mjs') values.tryAchievement = () => {};
    if (spec === 'node:fs/promises') Object.assign(values, { mkdir: async () => {}, writeFile: async (...args) => files.push(args) });
    if (spec === 'node:path') values.default = path;
    return new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
  });
  return mod;
}
const plan = await load('plan_tasks.mjs'); await plan.evaluate();
const reflection = await load('reflection.mjs'); await reflection.evaluate();
const mem = modules.get('memory_v2.mjs').namespace;
let pass = 0, fail = 0;
async function check(name, fn) { reset(); try { await fn(); pass++; } catch (error) { fail++; console.error(`FAIL ${name}: ${error.message}`); } }
await check('weekly excludes revoked sources and registers actual source IDs', async () => {
  const id = addRow({ memory_type: 'daily_summary', content: '2026-10-18 ALLOWED' });
  addRow({ memory_type: 'daily_summary', content: '2026-10-17 HIDDEN', do_not_mention: 1 });
  addRow({ memory_type: 'daily_summary', content: '2026-10-16 DELETED', memory_status: 'deleted' });
  await plan.namespace.runWeekly('2026-10-19');
  assert.equal(prompts.length, 1); assert.ok(!/HIDDEN|DELETED/.test(prompts[0]));
  assert.deepEqual(Array.from(saved[0].sourceMemoryIds || []), [id]); assert.equal(saved[0].expectedRecallRevision, 0);
});
await check('monthly preserves source IDs', async () => {
  const id = addRow({ memory_type: 'weekly_summary', content: '2026-09-10 ALLOWED' });
  await plan.namespace.runMonthly('2026-10-01');
  assert.deepEqual(Array.from(saved[0].sourceMemoryIds || []), [id]);
});
await check('reflection runner bounds evidence to displayed turns and memories', async () => {
  turnFixture = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, role: i % 2 ? 'assistant' : 'user', content: '我喜欢蓝色。' }));
  for (let i = 0; i < 25; i++) addRow({ content: `VISIBLE ${i}`, importance: 30 - i });
  modelResult = JSON.stringify({ new_memories: [{ memory_layer: 'event', content: 'model paraphrase', memory_weight: 3, confidence: 0.9,
    subject: 'user', evidence: [{ turn_id: 99, quote: '我喜欢蓝色。' }] }] });
  await reflection.namespace.runDailyReflectionForCompanion(1, { userId: 10 });
  assert.equal(saved.length, 1);
  assert.deepEqual(Array.from(saved[0].allowedTurnIds), Array.from({ length: 80 }, (_, i) => i + 21));
  assert.equal(saved[0].sourceMemoryIds.length, 20);
  assert.ok(prompts[0].includes('"turn_id":21')); assert.ok(!prompts[0].includes('"turn_id":20,'));
  assert.ok(!prompts[0].includes('VISIBLE 20'));
});
await check('daily marks post-barrier turns as explicit no-memory source', async () => {
  revision = 2; await plan.namespace.runDaily('2026-10-19');
  assert.ok(Array.isArray(saved[0].sourceMemoryIds)); assert.equal(saved[0].sourceMemoryIds.length, 0);
  assert.equal(saved[0].expectedRecallRevision, 2);
});
for (const method of ['runDaily', 'runWeekly', 'runMonthly']) {
  await check(`${method} stops publication when revoke happens during LLM`, async () => {
    addRow({ memory_type: 'daily_summary', content: '2026-10-18 SOURCE' });
    addRow({ memory_type: 'weekly_summary', content: '2026-09-18 SOURCE' });
    onModel = () => revision++;
    await plan.namespace[method](method === 'runMonthly' ? '2026-10-01' : '2026-10-19');
    assert.equal(files.length, 0); assert.ok(!logs.some(line => /generated companion/.test(line)));
  });
}
await check('rejected summary never writes Markdown', async () => {
  rejectSave = true; await plan.namespace.runDaily('2026-10-19'); assert.equal(files.length, 0);
});
await check('reflection prompt excludes hidden records defensively', () => {
  const prompt = reflection.namespace.buildReflectionPrompt({ name: '角色' }, [], [{ content: 'HIDDEN', do_not_mention: 1 }]);
  assert.ok(!prompt.includes('HIDDEN'));
});
await check('reflection run uses recall reader and records its evidence IDs', async () => {
  const id = addRow({ content: 'VISIBLE' }); addRow({ content: 'HIDDEN', do_not_mention: 1 });
  modelResult = JSON.stringify({ new_memories: [{ memory_layer: 'event', content: '全新的合成事实', memory_weight: 3, confidence: 0.9,
    subject: 'user', evidence: [{ turn_id: 3, quote: '我喜欢蓝色。' }] }] });
  await reflection.namespace.runDailyReflectionForCompanion(1, { userId: 10 });
  assert.ok(!prompts[0].includes('HIDDEN'));
  assert.deepEqual(Array.from(saved[0].sourceMemoryIds || []), [id]);
  assert.equal(graph.length, 1); assert.equal(graph[0][1], '我喜欢蓝色。');
  assert.equal(graph[0][2], db.prepare("SELECT id FROM companion_memories WHERE content='我喜欢蓝色。'").get().id);
});
for (const subject of ['companion', 'shared']) await check(`${subject} memory is stored without attributing it to the user graph`, async () => {
  turnFixture = [{ id: 1, role: 'user', content: '我们喜欢蓝色。' }, { id: 2, role: 'assistant', content: '我们喜欢蓝色。' }];
  const evidence = subject === 'shared' ? turnFixture.map(turn => ({ turn_id: turn.id, quote: turn.content }))
    : [{ turn_id: 2, quote: '我喜欢蓝色。' }];
  const result = await reflection.namespace.applyReflectionMemoryUpdates(1, { new_memories: [{ memory_layer: 'event', content: '模型转述',
    subject, evidence }] }, { userId: 10, sourceMemoryIds: [], shownMemoryIds: [], allowedTurnIds: [1, 2], expectedRecallRevision: 0 });
  assert.equal(result.inserted, 1); assert.equal(saved.length, 1); assert.equal(graph.length, 0);
});
await check('reflection stale revision cannot write', async () => {
  revision = 2;
  const result = await reflection.namespace.applyReflectionMemoryUpdates(1, { new_memories: [{ content: 'new fact', memory_layer: 'event' }] }, { userId: 10, allowedTurnIds: [1], sourceMemoryIds: [], expectedRecallRevision: 1 });
  assert.equal(saved.length, 0); assert.equal(result.inserted, 0); assert.ok(result.rejected > 0);
});
await check('reflection rejected insert has no graph side effect or success count', async () => {
  rejectSave = true;
  const result = await reflection.namespace.applyReflectionMemoryUpdates(1, { new_memories: [{ content: 'new fact', memory_layer: 'event',
    subject: 'user', evidence: [{ turn_id: 1, quote: '我喜欢蓝色。' }] }] }, { userId: 10, allowedTurnIds: [1], sourceMemoryIds: [], expectedRecallRevision: 0 });
  assert.equal(saved.length, 1);
  assert.equal(graph.length, 0); assert.equal(result.inserted, 0); assert.equal(result.rejected, 1);
});
await check('reflection cannot rewrite hidden or other-user memory', async () => {
  const hidden = addRow({ content: 'HIDDEN', do_not_mention: 1 }); const other = addRow({ content: 'OTHER', user_id: 20 });
  await reflection.namespace.applyReflectionMemoryUpdates(1, { updated_memories: [{ memory_id: hidden, new_content: 'rewritten' }, { memory_id: other, new_content: 'rewritten' }] }, { userId: 10, allowedTurnIds: [1], shownMemoryIds: [hidden, other], sourceMemoryIds: [], expectedRecallRevision: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM companion_memories WHERE content='rewritten'").get().n, 0);
});
await check('semantic duplicate search excludes hidden and cross-user rows', async () => {
  addRow({ content: 'same fact', do_not_mention: 1 }); addRow({ content: 'same fact', user_id: 20 });
  assert.equal(await mem.findSimilarMemoryByEmbedding(1, 'same fact', { userId: 10, subject: 'user' }), null);
});
await check('merge does not report success when patch is rejected', async () => {
  addRow({ content: 'same fact' }); rejectPatch = true;
  const result = await mem.addOrMergeMemory(1, { content: 'same fact', memory_layer: 'user_fact' }, { userId: 10, expectedRecallRevision: 0 });
  assert.notEqual(result.action, 'merged');
});
await check('dedupe does not let hidden records swallow visible candidates', () => {
  const result = mem.dedupeMemories([{ content: 'same', memory_layer: 'event', do_not_mention: 1 }, { content: 'same', memory_layer: 'event' }]);
  assert.equal(result.length, 1); assert.equal(result[0].do_not_mention, undefined);
});
await check('legacy similarity reader rejects a revision changed while embedding waits', async () => {
  addRow({ content: 'same fact' }); onEmbed = () => revision++;
  const result = await mem.findSimilarMemoryByEmbedding(1, 'same fact', { layer: 'user_fact', subject: 'user', userId: 10, expectedRecallRevision: 0 });
  assert.equal(result, null);
  assert.equal(db.prepare('SELECT memory_weight FROM companion_memories').get().memory_weight, 3);
});
await check('dedupe reader excludes a derivative of a hidden source', async () => {
  const source = addRow({ content: 'source', do_not_mention: 1 });
  addRow({ content: 'derived fact', source_memory_ids: JSON.stringify([source]) });
  assert.equal(await mem.findSimilarMemoryByEmbedding(1, 'derived fact', { userId: 10, subject: 'user' }), null);
});
await check('filter-new does not merge into hidden or another-user records', () => {
  addRow({ content: 'same fact', do_not_mention: 1 }); addRow({ content: 'same fact', user_id: 20 });
  const result = mem.filterNewMemoriesAgainstExisting([{ content: 'same fact', memoryType: 'fact', userId: 10 }],
    db.prepare('SELECT * FROM companion_memories').all(), db, 1);
  assert.equal(result.length, 1);
  assert.equal(db.prepare('SELECT SUM(memory_weight) AS n FROM companion_memories').get().n, 6);
});
db.close();

// Integration with the actual DB admission contract; no live model/network is allowed.
const temp = mkdtempSync(path.join(tmpdir(), 'memory-consumers-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.LOG_DIR = path.join(temp, 'logs');
process.env.EMBEDDING_PROVIDER = 'unconfigured-offline-fixture';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network forbidden in consumer regression'); };
const realDb = await import('../src/db.mjs');
const realMem = await import('../src/memory_v2.mjs');
const realReflection = await import('../src/reflection.mjs');
const database = realDb.getDb();
database.pragma('foreign_keys = OFF');
async function realCheck(name, fn) {
  try { await fn(); pass++; } catch (error) { fail++; console.error(`FAIL real DB ${name}: ${error.message}`); }
}
try {
  const companionId = 880001, userId = 'synthetic-owner';
  database.prepare('INSERT INTO companions(id,user_id,bot_id,name) VALUES(?,?,?,?)').run(companionId,userId,'fixture','合成角色');
  const add = (content, extra = {}) => {
    const id = realDb.saveMemory({ companionId, userId, memoryType: 'fact', memoryLayer: 'user_fact', content, pinned: false, ...extra });
    database.prepare("UPDATE companion_memories SET memory_subject='user' WHERE id=?").run(id);
    return id;
  };
  const evidenceTurn = content => realDb.saveConversationTurn(companionId, 'user', content);
  const proof = turn => ({ subject: 'user', evidence: [{ turn_id: turn.id, quote: turn.content }] });
  const visible = add('相同的合成事实');
  const hidden = add('隐藏的合成事实');
  realDb.patchMemory(hidden, companionId, { do_not_mention: 1 });
  add('其他人的合成事实', { userId: 'another-owner' });
  await realCheck('similarity reader honors user scope and do_not_mention', async () => {
    assert.equal(await realMem.findSimilarMemoryByEmbedding(companionId, '隐藏的合成事实', { userId, subject: 'user' }), null);
    assert.equal(await realMem.findSimilarMemoryByEmbedding(companionId, '其他人的合成事实', { userId, subject: 'user' }), null);
    assert.equal((await realMem.findSimilarMemoryByEmbedding(companionId, '相同的合成事实', { userId, subject: 'user' })).id, visible);
  });
  await realCheck('reflection-derived insert becomes unavailable when its source is revoked', async () => {
    const { revision: expectedRecallRevision } = realDb.getMemoryRecallBarrier(companionId, userId);
    const turn = evidenceTurn('我喜欢蓝色。');
    const result = await realReflection.applyReflectionMemoryUpdates(companionId,
      { new_memories: [{ content: '一个独立的反思结果', memory_layer: 'event', memory_weight: 3, ...proof(turn) }] },
      { userId, sourceMemoryIds: [visible], shownMemoryIds: [visible], allowedTurnIds: [turn.id], expectedRecallRevision });
    assert.equal(result.inserted, 1);
    const derived = realDb.getRecallableMemories(companionId, userId).find(row => row.content === '我喜欢蓝色。');
    assert.ok(derived); assert.deepEqual(JSON.parse(derived.source_memory_ids), [visible]);
    realDb.softDeleteMemory(visible, companionId);
    assert.ok(!realDb.getRecallableMemories(companionId, userId).some(row => row.id === derived.id));
    assert.ok(realDb.getMemoriesV2(companionId, { status: null }).memories.some(row => row.id === derived.id));
  });
  await realCheck('turn-derived empty-source summaries expire on later revocations', async () => {
    const firstFact = add('下一次要撤销的合成事实');
    let barrier = realDb.getMemoryRecallBarrier(companionId, userId);
    const oldSummary = add('2026-10-19 日记忆：旧对话汇总', {
      memoryType: 'daily_summary', memoryLayer: 'summary', sourceMemoryIds: [], expectedRecallRevision: barrier.revision,
    });
    assert.ok(realDb.getRecallableMemories(companionId, userId).some(row => row.id === oldSummary));
    realDb.softDeleteMemory(firstFact, companionId);
    assert.ok(!realDb.getRecallableMemories(companionId, userId).some(row => row.id === oldSummary));
    barrier = realDb.getMemoryRecallBarrier(companionId, userId);
    const freshSummary = add('2026-10-20 日记忆：撤销后新对话汇总', {
      memoryType: 'daily_summary', memoryLayer: 'summary', sourceMemoryIds: [], expectedRecallRevision: barrier.revision,
    });
    assert.ok(realDb.getRecallableMemories(companionId, userId).some(row => row.id === freshSummary));
    const secondFact = add('再次要撤销的合成事实');
    realDb.softDeleteMemory(secondFact, companionId);
    assert.ok(!realDb.getRecallableMemories(companionId, userId).some(row => row.id === freshSummary));
  });
  await realCheck('single-memory reflection replacement stays recallable with empty remaining dependencies', async () => {
    const target = add('我喜欢红色。');
    const turn = evidenceTurn('我不再喜欢红色，我喜欢蓝色。');
    const { revision: expectedRecallRevision } = realDb.getMemoryRecallBarrier(companionId, userId);
    const result = await realReflection.applyReflectionMemoryUpdates(companionId,
      { updated_memories: [{ memory_id: target, new_content: turn.content, ...proof(turn) }] },
      { userId, sourceMemoryIds: [target], shownMemoryIds: [target], allowedTurnIds: [turn.id], expectedRecallRevision });
    assert.equal(result.updated, 1);
    assert.ok(realDb.getRecallableMemories(companionId, userId).some(row => row.id !== target && row.content === turn.content));
    assert.equal(database.prepare('SELECT memory_status FROM companion_memories WHERE id=?').get(target).memory_status, 'contradicted');
  });
  await realCheck('reflection replacement excludes old vector, preserves other dependencies, and fences stale updates', async () => {
    const target = add('我喜欢咖啡。', { embedding: [1, 0] });
    const turn = evidenceTurn('我不再喜欢咖啡，我喜欢茶。');
    const source = add('合成的独立参考事实');
    const later = add('同轮后续事实');
    const { revision: expectedRecallRevision } = realDb.getMemoryRecallBarrier(companionId, userId);
    const result = await realReflection.applyReflectionMemoryUpdates(companionId, { updated_memories: [
      { memory_id: target, new_content: turn.content, ...proof(turn) }, { memory_id: later, new_content: '不应继续更新', ...proof(turn) },
    ] }, { userId, sourceMemoryIds: [target, source], shownMemoryIds: [target, source, later], allowedTurnIds: [turn.id], expectedRecallRevision });
    assert.equal(result.updated, 1); assert.equal(result.rejected, 1);
    const row = realDb.getRecallableMemories(companionId, userId).find(item => item.content === turn.content);
    assert.ok(row && row.id !== target);
    assert.equal(database.prepare('SELECT memory_status FROM companion_memories WHERE id=?').get(target).memory_status, 'contradicted');
    assert.equal(row.embedding, null); assert.deepEqual(JSON.parse(row.source_memory_ids), [source]);
    assert.equal(database.prepare('SELECT content FROM companion_memories WHERE id=?').get(later).content, '同轮后续事实');
    realDb.softDeleteMemory(source, companionId);
    assert.ok(!realDb.getRecallableMemories(companionId, userId).some(item => item.id === row.id));
  });
} finally {
  globalThis.fetch = originalFetch;
  database.close();
  process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
}
console.log(`memory_consumers_check: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
