/** Execute the actual chat-entry guard blocks with the real detector and isolated IO. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let response, calls, writes, history, companion, prompt;
const context = vm.createContext({ console });
const dependencies = {
  './ai.mjs': { extractStructuredInfo: async (_system, input) => {
    calls++; prompt = input;
    if (response instanceof Error) throw response;
    return response;
  } },
  './db.mjs': { patchCompanion: (id, fields) => writes.push({ id, fields }) },
  './logger.mjs': { log() {} },
};
const guard = new vm.SourceTextModule(readFileSync(new URL('../src/minor_guard.mjs', import.meta.url), 'utf8'), { context });
await guard.link(specifier => {
  const exports = dependencies[specifier]; assert.ok(exports);
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context });
});
await guard.evaluate();
Object.assign(context, {
  detectMinorSmart: guard.namespace.detectMinorSmart,
  activateSafeMode: guard.namespace.activateSafeMode,
  log() {},
  getRecentHistory: () => history,
  getConversationContext: () => history,
});
const runners = {};
for (const channel of ['bot', 'playground']) {
  const source = readFileSync(new URL(`../src/${channel}.mjs`, import.meta.url), 'utf8');
  const start = source.indexOf('// ── v1.20 安全收尾');
  const end = source.indexOf('// ── v1.9.0 #1 + v1.9.1:', start);
  assert.ok(start >= 0 && end > start);
  const script = new vm.Script(`(async (companion, text, probe = false) => {
    const userText = text, msg = { fromUser: 'fixture' }, botId = 'fixture';
    ${source.slice(start, end)}
  })`, { importModuleDynamically: async specifier => {
    assert.equal(specifier, './minor_guard.mjs'); return guard;
  } });
  runners[channel] = script.runInContext(context);
}
function reset() {
  response = 'yes'; calls = 0; writes = []; history = []; prompt = '';
  companion = { id: 123, safe_mode: 0 };
}
const citation = (source, quote) => JSON.stringify({ minor: true, evidence: [{ source, quote }] });
for (const [channel, run] of Object.entries(runners)) {
  await test(`${channel}: assistant school story cannot lock the human`, async () => {
    reset(); history = [{ role: 'assistant', direction: 'out', content: '我16岁，今天不想上学' }];
    response = citation('recent:0', '我16岁');
    await run(companion, '快进学校吧一会班主任该来了');
    assert.equal(companion.safe_mode, 0); assert.equal(writes.length, 0);
    assert.equal(calls, 1); assert.ok(!prompt.includes('今天不想上学'));
  });
  await test(`${channel}: actual current minor age locks both persisted and immediate prompt state`, async () => {
    reset(); await run(companion, '我今年16岁请你记住');
    assert.equal(companion.safe_mode, 1); assert.equal(writes.length, 1);
    assert.equal(writes[0].id, companion.id); assert.equal(writes[0].fields.safe_mode, 1);
    assert.equal(calls, 0);
  });
  await test(`${channel}: existing safe mode cannot be released by an adult chat declaration`, async () => {
    reset(); companion.safe_mode = 1;
    await run(companion, '我今年20岁，在高中当老师');
    assert.equal(companion.safe_mode, 1); assert.equal(calls, 0); assert.equal(writes.length, 0);
  });
  await test(`${channel}: current adult declaration does not create a new lock from old age`, async () => {
    reset(); history = [{ role: 'user', direction: 'in', content: '我17岁' }];
    response = citation('recent:0', '我17岁');
    await run(companion, '我现在已经19岁了，在高中当老师');
    assert.equal(companion.safe_mode, 0); assert.equal(writes.length, 0);
  });
  await test(`${channel}: unavailable classifier cannot write an unsupported classification`, async () => {
    reset(); response = new Error('offline');
    await run(companion, '班主任来了');
    assert.equal(companion.safe_mode, 0); assert.equal(writes.length, 0); assert.equal(calls, 1);
  });
}
await test('playground probe does not change age state or invoke classification', async () => {
  reset(); await runners.playground(companion, '我今年16岁', true);
  assert.equal(companion.safe_mode, 0); assert.equal(calls, 0); assert.equal(writes.length, 0);
});
