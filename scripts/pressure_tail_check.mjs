import assert from 'node:assert/strict';
import { availabilityWindowForReply, preserveAvailabilityWindow, reviewPressureTail } from '../src/pressure_tail.mjs';

const context = { enabled: true, userText: '我八点半到九点有空' };
const drop = async () => ({ text: '1' });
const draft = '好，八点半到九点我等你。别拖到九点半去啊。';
assert.equal(await reviewPressureTail(draft, context, drop), '好，八点半到九点我等你。');
for (const delimiter of ['，', ' || ', '\n']) {
  assert.equal(await reviewPressureTail('吃早饭了吗'+delimiter+'别又随便糊弄一口', context, drop), '吃早饭了吗');
}
const agreement = '好，我等你。';
const twoClauses = agreement + '不过你可得说话算话，别又临时喊困。';
assert.equal(await reviewPressureTail(twoClauses, context, async input => {
  const { options } = JSON.parse(input.messages[0].content);
  assert.deepEqual(options.map(o => o.text), [agreement, agreement+'不过你可得说话算话']);
  return { text: '1' };
}), agreement);
let calls = 0;
const counted = async () => { calls++; return { text: '1' }; };
for (const [text, options] of [
  [draft, { enabled: false }], [draft, { ...context, safetyLevel: 'high' }],
  ['你有空喊我。', context], ['别碰带电的线！', context], ['特别好。', context],
  ['我还要做作业，别到时候你上号了我自己还没写完。', context],
]) assert.equal(await reviewPressureTail(text, options, counted), text);
assert.equal(calls, 0);
const boundary = '可以聊这个。别替我答应。';
assert.equal(await reviewPressureTail(boundary, context, async () => ({ text: 'KEEP' })), boundary);
for (const failed of [async () => ({ text: '自由改写' }), async () => { throw Error('timeout'); }]) {
  assert.equal(await reviewPressureTail(draft, context, failed), draft);
}
const window = availabilityWindowForReply('我八点半到九点左右才有时间');
const incident = '行吧，那就八点半，我等你。别拖到九点半去啊。';
assert.equal(preserveAvailabilityWindow(await reviewPressureTail(incident, context, drop), window), '行吧，那就八点半到九点左右，我等你。');
assert.equal(preserveAvailabilityWindow('那就九点，可以吗？', window), '那就九点，可以吗？');
assert.equal(preserveAvailabilityWindow('那就八点半到九点，我等你。', window), '那就八点半到九点，我等你。');
for (const user of ['八点半到九点有空，你选一个', '八点半到九点有空，就约在八点半', '八点半到九点没空，之后才有时间', '八点半有空']) {
  assert.equal(availabilityWindowForReply(user), null);
}
assert.equal(availabilityWindowForReply('20:30 到 21:00 有空').text, '20:30 到 21:00');
console.log('pressure_tail_check passed');
