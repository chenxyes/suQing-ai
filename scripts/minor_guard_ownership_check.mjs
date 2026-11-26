/** Offline regression: evaluate the real guard, stub only network/DB/log boundaries.
 * Run: node --experimental-vm-modules scripts/minor_guard_ownership_check.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

let reply = 'yes';
let calls = 0;
let lastPrompt = '';
const writes = [];
const context = vm.createContext({ console });
const dependencies = {
  './ai.mjs': { extractStructuredInfo: async (_system, prompt) => {
    calls++;
    lastPrompt = prompt;
    if (reply instanceof Error) throw reply;
    return reply;
  } },
  './db.mjs': { patchCompanion: (...args) => writes.push(args) },
  './logger.mjs': { log: () => {} },
};
const guard = new vm.SourceTextModule(await readFile(new URL('../src/minor_guard.mjs', import.meta.url), 'utf8'), { context });
await guard.link(async name => {
  const exports = dependencies[name];
  assert.ok(exports, `unexpected dependency: ${name}`);
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context });
});
await guard.evaluate();
const { detectMinorSignal, detectMinorSmart, activateSafeMode, deactivateSafeMode, isSafeMode } = guard.namespace;
let pass = 0;
let fail = 0;
async function check(name, run) {
  try { await run(); pass++; } catch (error) { fail++; console.error(`FAIL ${name}: ${error.message}`); }
}
const evidence = (source, quote) => JSON.stringify({ minor: true, evidence: [{ source, quote }] });
const scenario = [{ role: 'assistant', content: '我不想进校门' }];
const latest = '快进学校吧一会班主任该来了';
await check('bare yes cannot turn assistant school scene into user age', async () => {
  reply = 'yes';
  assert.notEqual((await detectMinorSmart(latest, scenario)).level, 'strong');
});
await check('assistant citation is not user evidence', async () => {
  reply = evidence('recent:0', '我16岁，今天班主任找我');
  assert.notEqual((await detectMinorSmart('班主任来了', [{ role: 'assistant', content: '我16岁，今天班主任找我' }])).level, 'strong');
});
await check('user telling character to enter school is not self disclosure', async () => {
  reply = evidence('latest', latest);
  assert.notEqual((await detectMinorSmart(latest, scenario)).level, 'strong');
});
for (const text of [
  '你刚才说“我16岁”，是真的吗', '他说我16岁', '假如我16岁就好了',
  '以前我16岁时也这样', '我扮演的角色说我16岁', '小说里我读高一',
  '我弟弟还没满18', '你还有两年才成年', '我想起我读高一的时候',
  '他说：“我16岁”', '如果我未成年，你会怎么回答',
  '朋友说我16岁', '```text\n我16岁\n```', '小明：我16岁',
  '我老师说我16岁', '我同学说：我读高一',
]) {
  await check(`exclude non-current/non-user disclosure: ${text}`, async () => {
    assert.notEqual(detectMinorSignal(text).level, 'strong');
    reply = evidence('latest', text.includes('我16岁') ? '我16岁' : text);
    assert.notEqual((await detectMinorSmart(text)).level, 'strong');
  });
}
await check('genuine explicit age stays direct without classifier', async () => {
  const before = calls;
  assert.equal((await detectMinorSmart('我今年16岁')).level, 'strong');
  assert.equal(calls, before);
});
await check('multiple user school-life disclosures remain detectable', async () => {
  reply = JSON.stringify({ minor: true, evidence: [
    { source: 'recent:0', quote: '我在准备中考' },
    { source: 'latest', quote: '我们班主任让我去上晚自习' },
  ] });
  assert.equal((await detectMinorSmart('我们班主任让我去上晚自习', [{ direction: 'in', content: '我在准备中考' }])).level, 'strong');
});
await check('real recent direct age can support weak latest message', async () => {
  reply = evidence('recent:0', '我17岁');
  assert.equal((await detectMinorSmart('今天班主任拖堂了', [{ direction: 'in', content: '我17岁' }])).level, 'strong');
});
for (const response of ['yes', 'yes because school', '{bad json', '{}', evidence('recent:99', '我17岁'), evidence('latest', '我17岁'), JSON.stringify({ minor: 'yes', evidence: [] }), new Error('offline')]) {
  await check(`reject unsupported/malformed evidence ${String(response)}`, async () => {
    reply = response;
    assert.notEqual((await detectMinorSmart('班主任来了')).level, 'strong');
  });
}
for (const text of ['我在大学准备月考', '我是一位初中老师', '我陪你准备中考', '我在成人培训班等班主任']) {
  await check('reject adult/professional/other-person school context: ' + text, async () => {
    reply = evidence('latest', text);
    assert.notEqual((await detectMinorSmart(text)).level, 'strong');
  });
}
await check('unknown role is not usable as user evidence', async () => {
  reply = evidence('recent:0', '我17岁');
  assert.notEqual((await detectMinorSmart('班主任来了', [{ content: '我17岁' }])).level, 'strong');
});
await check('one valid quote cannot rescue another invalid citation', async () => {
  reply = JSON.stringify({ minor: true, evidence: [
    { source: 'recent:0', quote: '我17岁' }, { source: 'latest', quote: '我17岁' },
  ] });
  assert.notEqual((await detectMinorSmart('班主任来了', [{ role: 'user', content: '我17岁' }])).level, 'strong');
});
await check('independent current disclosure survives preceding hypothetical sentence', async () => {
  assert.equal((await detectMinorSmart('假如我能变小就好了。我今年16岁。')).level, 'strong');
});
await check('source truncation cannot erase a later role-play qualifier', async () => {
  reply = evidence('recent:0', '我17岁');
  const message = '我17岁' + '啊'.repeat(1100) + '这是角色台词';
  assert.notEqual((await detectMinorSmart('班主任来了', [{ role: 'user', content: message }])).level, 'strong');
  assert.ok(!lastPrompt.includes('这是角色台词'), 'qualifier is beyond the actual 1000-character prompt budget');
});
await check('conflicting role metadata cannot become user evidence', async () => {
  reply = evidence('recent:0', '我17岁');
  assert.notEqual((await detectMinorSmart('班主任来了', [{ direction: 'out', role: 'user', content: '我17岁' }])).level, 'strong');
});
await check('detection never mutates existing safe mode', () => assert.equal(writes.length, 0));
await check('safe mode remains sticky until explicit deactivation', () => {
  assert.equal(isSafeMode({ safe_mode: 1 }), true);
  activateSafeMode('synthetic-companion', 'test');
  assert.equal(writes.at(-1)[1].safe_mode, 1);
  assert.equal(writes.at(-1)[1].safe_mode_attested_at, undefined);
  deactivateSafeMode('synthetic-companion');
  assert.equal(writes.at(-1)[1].safe_mode, 0);
  assert.ok(Number.isFinite(Date.parse(writes.at(-1)[1].safe_mode_attested_at)));
});
// Run the existing regex smoke without importing real DB/network modules.
await check('existing regex smoke in isolated module graph', async () => {
  const smokeContext = context;
  smokeContext.process = { exit: code => assert.equal(code, 0, 'regex smoke failed') };
  const smoke = new vm.SourceTextModule(await readFile(new URL('./minor_guard_smoke.mjs', import.meta.url), 'utf8'), { context: smokeContext });
  await smoke.link(name => {
    assert.equal(name, '../src/minor_guard.mjs');
    return guard;
  });
  await smoke.evaluate();
});
console.log(`minor_guard_ownership_check: passed ${pass}, failed ${fail}`);
process.exitCode = fail ? 1 : 0;
