/** Offline mixed-clause regression: real detector, isolated model/DB boundaries. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

let reply = '';
let calls = 0;
const context = vm.createContext({ console });
const dependencies = {
  './ai.mjs': { extractStructuredInfo: async () => { calls++; return reply; } },
  './db.mjs': { patchCompanion: () => { throw new Error('No database writes allowed'); } },
  './logger.mjs': { log() {} },
};
const guard = new vm.SourceTextModule(await readFile(new URL('../src/minor_guard.mjs', import.meta.url), 'utf8'), { context });
await guard.link(name => {
  const values = dependencies[name]; assert.ok(values, `Unexpected dependency ${name}`);
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context });
});
await guard.evaluate();
const { detectMinorSignal, detectMinorSmart } = guard.namespace;
const cite = (source, quote) => JSON.stringify({ minor: true, evidence: [{ source, quote }] });

for (const text of [
  '我今年16岁，喜欢看小说',
  '我今年16岁，过去一直住北京',
  '我今年16岁，你说我该怎么办',
  '我今年16岁，如果周末下雨就不出门',
  '我今年16岁；喜欢看小说',
  '我今年16岁，我在看小说',
  '我今年16岁，我喜欢的书是小说',
]) {
  await test(`explicit current age survives unrelated later clause: ${text}`, async () => {
    const before = calls;
    reply = cite('latest', '我今年16岁');
    assert.equal(detectMinorSignal(text).level, 'strong');
    assert.equal((await detectMinorSmart(text)).level, 'strong');
    assert.equal(calls, before, 'explicit age needs no model confirmation');
  });
}

await test('mixed prior self disclosure remains valid evidence for a later weak message', async () => {
  reply = cite('recent:0', '我今年16岁');
  assert.equal((await detectMinorSmart('今天班主任找我', [
    { role: 'user', content: '我今年16岁，喜欢看小说' },
  ])).level, 'strong');
});

for (const text of [
  '假如这样，我今年16岁，喜欢看小说',
  '小说里，我今年16岁',
  '朋友说，我今年16岁',
  '你说，我今年16岁',
  '我弟弟说，我今年16岁',
  '我扮演一个角色，我今年16岁',
  '“我今年16岁”，这句是小说台词',
  '我今年16岁，这句话是小说角色的台词',
  '我今年16岁，只是在角色扮演',
  '我今年16岁，是小说里的台词',
  '我今年16岁，这是一个假设',
  '我今年16岁，我是在引用小说',
  '我今年16岁，刚才那句话是小说台词',
  '我今年16岁，其实刚才是在引用台词',
  '我今年16岁，前一句是在角色扮演',
  '我今年16岁，其实前一句只是小说台词',
  '我16岁，那时候喜欢看小说',
  '我今年16岁吗，喜欢看小说？',
]) {
  await test(`later clause does not lose quotation or hypothetical scope: ${text}`, async () => {
    reply = cite('latest', '我今年16岁');
    assert.notEqual(detectMinorSignal(text).level, 'strong');
    assert.notEqual((await detectMinorSmart(text)).level, 'strong');
  });
}
