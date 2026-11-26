/** Real refresh wiring + SQLite, with only model/search/log boundaries replaced. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'works-runtime-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.LOG_DIR = path.join(temp, 'logs');
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const m = await import('../src/db.mjs');
const db = m.getDb(); db.pragma('foreign_keys=OFF');
const companion = { id: 990100, user_id: 990100, name: '合成角色' };
db.prepare('INSERT INTO companions(id,user_id,bot_id,name) VALUES(?,?,?,?)')
  .run(companion.id, companion.user_id, 'works-runtime', companion.name);
let searchCalls = 0, modelCalls = 0;
const context = vm.createContext({ console, process: { env: {
  WORKS_MAX_ACTIVE: '1', WORKS_SERIES_DAYS_MIN: '10', WORKS_SERIES_DAYS_MAX: '10', WORKS_DROP_PROB: '0',
} } });
const deps = {
  './db.mjs': m,
  './logger.mjs': { log() {} },
  './web_search.mjs': { webSearch: async () => { searchCalls++; return { ok: false, error: 'no_provider' }; } },
  './ai.mjs': {
    extractStructuredInfo: async () => { modelCalls++; return JSON.stringify({
      kind: ' Game ', title: '未证实游戏甲', creator: '未证实制作方', progressNote: '第三关已通关',
    }); },
    embedText: async () => null,
  },
};
const mod = new vm.SourceTextModule(fs.readFileSync(new URL('../src/current_works.mjs', import.meta.url), 'utf8'), { context });
await mod.link(specifier => {
  const exports = deps[specifier]; assert.ok(exports);
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context });
});
await mod.evaluate();
const { refreshCurrentWorks } = mod.namespace;
const rows = () => m.getActiveCurrentWorks(companion.id);
const start = new Date('2026-10-01T04:00:00Z');
try {
  await test('production refresh persists a generic game with no unverified name or progress', async () => {
    const out = await refreshCurrentWorks(companion, { now: start });
    assert.equal(out.added, 1); assert.equal(out.fallbackReason, 'no_provider');
    const [row] = rows();
    assert.equal(row.kind, 'game'); assert.equal(row.title, '游戏');
    assert.equal(row.verify_status, 'generic'); assert.equal(row.creator, null); assert.equal(row.verify_evidence, null);
    assert.match(row.progress_note, /玩/); assert.doesNotMatch(row.progress_note, /第三关|通关/);
    assert.equal(modelCalls, 1); assert.equal(searchCalls, 1);
  });
  await test('later refresh advances persisted ordinary activity once per stage', async () => {
    const id = rows()[0].id, before = rows()[0].progress_note;
    const out = await refreshCurrentWorks(companion, { now: new Date('2026-10-07T04:00:00Z') });
    assert.equal(out.progressed, 1); assert.equal(rows()[0].id, id); assert.notEqual(rows()[0].progress_note, before);
    assert.doesNotMatch(rows()[0].progress_note, /章节|集数|关卡|通关/);
    const repeat = await refreshCurrentWorks(companion, { now: new Date('2026-10-07T05:00:00Z') });
    assert.equal(repeat.progressed, 0); assert.equal(modelCalls, 1); assert.equal(searchCalls, 1);
  });
  await test('expired generic activity archives without invented completion and replenishes its slot', async () => {
    const id = rows()[0].id;
    const out = await refreshCurrentWorks(companion, { now: new Date('2026-10-12T04:00:00Z') });
    assert.equal(out.finished, 1); assert.equal(out.added, 1); assert.notEqual(rows()[0].id, id);
    const saved = db.prepare('SELECT * FROM companion_memories WHERE companion_id=?').all(companion.id);
    assert.equal(saved.length, 1); assert.match(saved[0].content, /玩过一款游戏/);
    assert.doesNotMatch(saved[0].content, /未证实游戏甲|第三关|通关|看完/);
    assert.equal(saved[0].memory_type, 'event');
    assert.equal(modelCalls, 2); assert.equal(searchCalls, 2);
  });
} finally {
  db.close(); process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));
}
