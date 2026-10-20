import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const botSource = fs.readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
const start = botSource.indexOf('const MAX_SEGMENTS =');
const end = botSource.indexOf('// 同一用户已有', start);
assert.ok(start >= 0 && end > start, 'production reply function boundaries exist');
const { postProcessReply, splitReplySegments, stripKaomoji } = vm.runInNewContext(
  botSource.slice(start, end) + '\n({postProcessReply,splitReplySegments,stripKaomoji});',
);
const split = value => Array.from(splitReplySegments(value));

await test('five-plus sentences keep the entire requested explanation including the closing sentence', () => {
  const text = '我先把经过讲清楚。我们周五约好了见面。后来下雨改到了周六。临出门时我又确认了一遍。你说不用着急。最后我们在咖啡店碰面。';
  assert.equal(split(text).join(''), text, 'no fourth-sentence cutoff');
  assert.deepEqual(split(text), [text], 'one supplied paragraph remains one message');
});

await test('long Unicode paragraph stays whole rather than being expanded by character thresholds', () => {
  const text = '我把𠮷字和家人的👨‍👩‍👧‍👦合照放在同一页，也保留了原来的 café 与 e\u0301。这样等你翻到后面，就能完整看到当时的故事，而不用被拆开的短句打断。';
  assert.deepEqual(split(text), [text]);
  assert.equal(split(text)[0].normalize('NFC'), text.normalize('NFC'));
  const url = '链接在这里：https://example.invalid/a/long/path?chapter=5&lang=zh#完整段落，打开后可以直接看到后半段。';
  assert.deepEqual(split(url), [url], 'URL query punctuation is not a message boundary');
});

await test('explicit separators and paragraphs retain their boundaries regardless of paragraph length', () => {
  const long = '我想先把这段话完整地讲给你听，因为当时我们都还有很多来不及解释的细节，也不想让一句完整的话因为字符数被拆开';
  assert.deepEqual(split(`${long}\n\n第二段先留在这里。\n第三段也完整保留。`), [long, '第二段先留在这里。', '第三段也完整保留。']);
  assert.deepEqual(split('第一句话。｜｜第二句话。｜｜第三句话。｜｜第四句话。｜｜第五句话。'),
    ['第一句话。', '第二句话。', '第三句话。', '第四句话。\n第五句话。']);
  assert.deepEqual(split('明天见||好呀'), ['明天见', '好呀'], 'short explicit reply remains intentional');
});

await test('more than four explicit messages merge the remainder without dropping text or sticker markers', () => {
  const parts = ['先把窗户关好', '然后泡一杯热茶', '我们坐下来慢慢说', '我记得那次旅行', '[STICKER:happy]', '还有你一直没听完的后半段', '最后这一句话也要发出来'];
  const segments = split(parts.join('||'));
  assert.equal(segments.length, 4);
  assert.deepEqual(segments.slice(0, 3), parts.slice(0, 3));
  assert.equal(segments[3], parts.slice(3).join('\n'));
});

await test('kaomoji policy and existing punctuation and whitespace cleanup remain unchanged', () => {
  assert.equal(stripKaomoji('等你回来（带伞） (≧ω≦) /♡'), '等你回来（带伞）');
  assert.equal(postProcessReply('  嗨!!!\t  你呢???......～～~~  '), '嗨！ 你呢？…～~');
  assert.deepEqual(split(' \t '), ['']); assert.deepEqual(split(null), ['']);
  assert.deepEqual(split(' 先喝茶 || \n 再聊天 ｜｜ 最后散步 '), ['先喝茶', '再聊天', '最后散步']);
});

await test('proactive explicit burst cap preserves all existing content without a separate length limit', () => {
  const source = fs.readFileSync(new URL('../src/proactive.mjs', import.meta.url), 'utf8');
  const a = source.indexOf('const PROACTIVE_MAX_SEGMENTS ='), b = source.indexOf('function buildTimeContext(', a);
  assert.ok(a >= 0 && b > a);
  const proactiveSplit = vm.runInNewContext(source.slice(a, b) + '\nsplitReplySegments;');
  const parts = ['第一段保留', '第二段保留', '第三段保留', '第四段保留', '第五段保留', '最后结尾保留'];
  const segments = Array.from(proactiveSplit(parts.join('||')));
  assert.equal(segments.length, 4);
  for (const part of parts) assert.ok(segments.join('\n').includes(part));
});
