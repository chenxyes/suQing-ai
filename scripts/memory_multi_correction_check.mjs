/** Offline production extraction/reflection regression; requires --experimental-vm-modules. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = mkdtempSync(path.join(tmpdir(), 'memory-multi-correction-'));
process.env.DB_PATH = path.join(temp, 'fixture.db');
process.env.LOG_DIR = path.join(temp, 'logs');
process.env.EMBEDDING_PROVIDER = 'offline-fixture';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const m = await import('../src/db.mjs');
const reflection = await import('../src/reflection.mjs');
const db = m.getDb();
db.pragma('foreign_keys = OFF');
const context = vm.createContext({ console, process, Buffer });
let output = {}, onModel = () => {};
const modules = new Map();
const dependencies = {
  './db.mjs': m,
  './logger.mjs': { log() {} },
  './ai.mjs': { async extractStructuredInfo() { onModel(); return JSON.stringify(output); }, async embedTextWithDescriptor() { return null; } },
  './event_graph.mjs': { processMemoryForGraph() {} },
  './achievements.mjs': { tryAchievement() {} },
};
async function load(file) {
  if (modules.has(file)) return modules.get(file);
  const mod = new vm.SourceTextModule(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), { context });
  modules.set(file, mod);
  await mod.link(async spec => {
    if (spec === './memory_indexing.mjs') return load(spec.slice(2));
    if (!dependencies[spec]) throw new Error(`Unexpected dependency: ${spec}`);
    const values = dependencies[spec];
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  return mod;
}
const extraction = await load('memory.mjs');
await extraction.evaluate();
let sequence = 993000;
function fixture() {
  const cid = ++sequence, uid = cid;
  db.prepare('INSERT INTO companions(id,user_id,bot_id) VALUES(?,?,?)').run(cid, uid, 'fixture');
  const turn = text => m.saveConversationTurn(cid, 'user', text);
  const add = text => {
    const t = turn(text);
    return m.saveGroundedMemory({ companionId: cid, userId: uid, memoryType: 'fact', content: text,
      importance: 5, pinned: false, subject: 'user', evidence: [{ turn_id: t.id, quote: text }],
      allowedTurnIds: [t.id], expectedRecallRevision: m.getMemoryRecallBarrier(cid, uid).revision }).memory.id;
  };
  const a = add('我有一个妹妹'), b = add('我喜欢游泳');
  output = {}; onModel = () => {};
  return { cid, uid, a, b, add, turn, rows: () => m.getRecallableMemories(cid, uid) };
}
function candidate(turn, quote, target) {
  return { subject: 'user', memory_type: 'fact', memory_layer: 'user_fact', memory_weight: 3,
    content: quote, importance: 5, evidence: [{ turn_id: turn.id, quote }], replaces_memory_ids: [target] };
}
async function extract(f, turns, candidates) {
  output = { memories: candidates };
  return extraction.namespace.extractAndSaveMemories(f.cid, f.uid, '', '', { turnIds: turns.map(t => t.id) });
}
function reflectionOptions(f, turns, sources = [f.a, f.b]) {
  return { userId: f.uid, expectedRecallRevision: m.getMemoryRecallBarrier(f.cid, f.uid).revision,
    shownMemoryIds: [f.a, f.b], sourceMemoryIds: sources, allowedTurnIds: turns.map(t => t.id) };
}
function assertCorrected(f) {
  const texts = f.rows().map(row => row.content);
  assert.ok(texts.includes('我没有妹妹'));
  assert.ok(texts.includes('我已经不再喜欢游泳'));
  assert.ok(!texts.includes('我有一个妹妹'));
  assert.ok(!texts.includes('我喜欢游泳'));
  for (const id of [f.a, f.b]) assert.equal(db.prepare('SELECT memory_status FROM companion_memories WHERE id=?').get(id).memory_status, 'contradicted');
}

try {
  await test('extraction applies both explicit corrections from one real message', async () => {
    const f = fixture(), t = f.turn('我没有妹妹，我已经不再喜欢游泳');
    assert.equal(await extract(f, [t], [candidate(t, '我没有妹妹', f.a), candidate(t, '我已经不再喜欢游泳', f.b)]), 2);
    assertCorrected(f);
  });
  for (const mode of ['new_memories', 'updated_memories']) await test(`reflection ${mode} applies corrections from two turns`, async () => {
    const f = fixture(), a = f.turn('我没有妹妹'), b = f.turn('我已经不再喜欢游泳');
    const candidates = [candidate(a, a.content, f.a), candidate(b, b.content, f.b)];
    const updates = mode === 'new_memories' ? candidates : candidates.map(c => ({ ...c, memory_id: c.replaces_memory_ids[0], new_content: c.content }));
    const result = await reflection.applyReflectionMemoryUpdates(f.cid, { [mode]: updates }, reflectionOptions(f, [a, b]));
    assert.equal(mode === 'new_memories' ? result.inserted : result.updated, 2);
    assertCorrected(f);
  });
  await test('external revocation while extraction model waits rejects the complete stale batch', async () => {
    const f = fixture(), unrelated = f.add('我住在杭州'), t = f.turn('我没有妹妹，我已经不再喜欢游泳');
    onModel = () => m.softDeleteMemory(unrelated, f.cid);
    assert.equal(await extract(f, [t], [candidate(t, '我没有妹妹', f.a), candidate(t, '我已经不再喜欢游泳', f.b)]), 0);
    assert.ok(f.rows().some(row => row.id === f.a));
    assert.ok(f.rows().some(row => row.id === f.b));
  });
  await test('reflection rejects an externally invalidated generation revision', async () => {
    const f = fixture(), unrelated = f.add('我住在杭州'), a = f.turn('我没有妹妹'), b = f.turn('我已经不再喜欢游泳');
    const options = reflectionOptions(f, [a, b]);
    m.softDeleteMemory(unrelated, f.cid);
    const result = await reflection.applyReflectionMemoryUpdates(f.cid,
      { new_memories: [candidate(a, a.content, f.a), candidate(b, b.content, f.b)] }, options);
    assert.equal(result.inserted, 0);
    assert.ok(f.rows().some(row => row.id === f.a));
    assert.ok(f.rows().some(row => row.id === f.b));
  });
  await test('multi-correction preserves unrelated provenance and cannot revive prior summaries', async () => {
    const f = fixture(), dependency = f.add('我住在杭州');
    const oldSummary = m.saveMemory({ companionId: f.cid, userId: f.uid, memoryType: 'daily_summary', content: '旧摘要', sourceMemoryIds: [], expectedRecallRevision: 0 });
    const a = f.turn('我没有妹妹'), b = f.turn('我已经不再喜欢游泳');
    await reflection.applyReflectionMemoryUpdates(f.cid,
      { new_memories: [candidate(a, a.content, f.a), candidate(b, b.content, f.b)] }, reflectionOptions(f, [a, b], [f.a, f.b, dependency]));
    assertCorrected(f);
    const corrected = f.rows().filter(row => ['我没有妹妹', '我已经不再喜欢游泳'].includes(row.content));
    assert.equal(corrected.length, 2);
    for (const row of corrected) assert.deepEqual(JSON.parse(row.source_memory_ids), [dependency]);
    assert.ok(!f.rows().some(row => row.id === oldSummary));
    m.softDeleteMemory(dependency, f.cid);
    for (const row of corrected) assert.ok(!f.rows().some(remaining => remaining.id === row.id));
  });
  await test('new extraction fact after a correction survives only within its originating batch', async () => {
    const f = fixture(), t = f.turn('我没有妹妹，我住在杭州');
    const fresh = { ...candidate(t, '我住在杭州', f.b), replaces_memory_ids: [] };
    assert.equal(await extract(f, [t], [candidate(t, '我没有妹妹', f.a), fresh]), 2);
    assert.ok(f.rows().some(row => row.content === '我住在杭州'));
    assert.deepEqual(m.getMemoryEvidenceTurns(f.cid, f.uid, [t.id]), [], 'old evidence cannot be replayed in a later generation');
  });
  await test('fresh conversation-derived reflection facts survive the batch without upgrading old rows', async () => {
    const f = fixture(), old = m.saveMemory({ companionId: f.cid, userId: f.uid, memoryType: 'daily_summary', content: '旧摘要', sourceMemoryIds: [], expectedRecallRevision: 0 });
    const t = f.turn('我没有妹妹，我住在杭州');
    const fresh = { ...candidate(t, '我住在杭州', f.b), replaces_memory_ids: [] };
    const result = await reflection.applyReflectionMemoryUpdates(f.cid,
      { new_memories: [candidate(t, '我没有妹妹', f.a), fresh] }, reflectionOptions(f, [t], []));
    assert.equal(result.inserted, 2);
    const row = f.rows().find(item => item.content === '我住在杭州');
    assert.ok(row);
    assert.deepEqual(JSON.parse(row.source_memory_ids), []);
    assert.ok(!f.rows().some(item => item.id === old));
    m.softDeleteMemory(f.b, f.cid);
    assert.ok(!f.rows().some(item => item.id === row.id), 'subsequent external revocation still invalidates conversation-derived facts');
  });
  for (const method of ['clearMemories', 'softClearMemories']) await test(`${method} invalidates in-flight extraction even when no rows change`, async () => {
    const f = fixture();
    m.clearMemories(f.cid, f.uid);
    const t = f.turn('我住在杭州');
    const revision = m.getMemoryRecallBarrier(f.cid, f.uid).revision;
    const other = fixture(), otherRevision = m.getMemoryRecallBarrier(other.cid, other.uid).revision;
    onModel = () => m[method](f.cid, f.uid);
    assert.equal(await extract(f, [t], [{ ...candidate(t, t.content, f.a), replaces_memory_ids: [] }]), 0);
    assert.ok(m.getMemoryRecallBarrier(f.cid, f.uid).revision > revision);
    assert.equal(f.rows().length, 0);
    assert.equal(m.getMemoryRecallBarrier(other.cid, other.uid).revision, otherRevision);
  });
  await test('empty clear cannot create a foreign-owner barrier on the same companion', () => {
    const f = fixture(), t = f.turn('我住在杭州');
    for (const method of ['clearMemories', 'softClearMemories']) {
      assert.equal(m[method](f.cid, f.uid + 10000), 0);
      assert.equal(m.getMemoryRecallBarrier(f.cid, f.uid + 10000).revision, 0);
    }
    assert.ok(m.getConversationTurnsBetween(f.cid, '2000-01-01', '2100-01-01').some(row => row.id === t.id));
  });
} finally {
  db.close();
  process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
}
