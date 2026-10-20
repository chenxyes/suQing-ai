/** Offline prompt-payload regression. Does not claim deterministic model reply length. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemPrompt, buildFirstTurnHint } from '../src/companion.mjs';

const base = { id: 19, name: '风格测试角色', age: 24, user_id: 1, relationship_stage: '朋友', first_love: 0,
  personality_tags: ['温和'], speech_styles: ['自然'], hobbies: ['阅读'], current_mood: '平静' };
const settings = [
  { value: '简短(1-2句)', sentences: /1\s*[-~～—至到]\s*2\s*句/ },
  { value: '适中(3-4句)', sentences: /3\s*[-~～—至到]\s*4\s*句/ },
  { value: '喜欢长聊', sentences: /5\s*(?:句(?:或|及)?以上|\+\s*句|句起)/ },
];
const realDate = Date;
function at(iso, fn) {
  globalThis.Date = class extends realDate {
    constructor(...args) { super(...(args.length ? args : [iso])); }
    static now() { return new realDate(iso).getTime(); }
  };
  try { return fn(); } finally { globalThis.Date = realDate; }
}
function prompt(value, extras = {}, fields = {}) {
  return at('2026-10-20T04:00:00.000Z', () => buildSystemPrompt({ ...base, reply_length: value, ...fields }, extras));
}
function noHardCaps(text) {
  assert.doesNotMatch(text, /(?:不能|严格不|不)超过\s*(?:15|20|25)\s*(?:个)?字/, 'no arbitrary per-bubble character cap');
  assert.doesNotMatch(text, /(?:必须|强制)[^\n]{0,15}\|\||用\s*\|\|\s*分成\s*[2-4]-[2-4]\s*条/, 'segmentation must not be compulsory');
  assert.doesNotMatch(text, /每次回复至少\s*1\s*条，最多\s*4\s*条/, 'one universal bubble count must not override the preference');
}

for (const { value, sentences } of settings) {
  await test(`configured ${value} reaches the real prompt as sentence guidance`, () => {
    const text = prompt(value);
    assert.match(text, sentences);
    assert.match(text, /(?:偏好|通常|一般|参考|默认)/, 'sentence target is guidance, not a guaranteed output count');
    noHardCaps(text);
  });
}

await test('unknown and inherited-property reply_length values safely use medium guidance', () => {
  for (const value of [undefined, null, '', 'not-a-length', 'toString', 'constructor', '__proto__']) {
    const text = prompt(value);
    assert.match(text, settings[1].sentences, `fallback for ${String(value)}`);
    assert.doesNotMatch(text, /\[object Object\]|function (?:toString|Object)\(/);
    noHardCaps(text);
  }
});

await test('burst delimiter remains available without requiring multiple bubbles', () => {
  const text = prompt('喜欢长聊');
  const delimiterLines = text.split('\n').filter(line => line.includes('||'));
  assert.ok(delimiterLines.some(line => /可以|可按|可用|可选|需要时|合适时/.test(line)), 'optional delimiter guidance must exist');
  noHardCaps(text);
  assert.doesNotMatch(text, /两三句说完就停|不超过\s*2-3\s*句/, 'universal short limit must not undo long preference');
});

await test('time and mood retain length preference while proactive brevity is explicitly scoped', () => {
  for (const iso of ['2026-10-20T00:00:00Z', '2026-10-20T04:00:00Z', '2026-10-20T16:00:00Z']) {
    for (const mode of ['reply', 'proactive']) {
      const text = at(iso, () => buildSystemPrompt({ ...base, reply_length: '喜欢长聊', current_mood: '委屈' }, {
        promptMode: mode,
        dailySchedule: { date_key: '2026-10-20', items: [{ time: '07:00', activity: '处理手头的事情' }],
          mood_segments: { morning: '合成早间状态', afternoon: '合成午后状态', evening: '合成夜间状态' } },
      }));
      assert.match(text, settings[2].sentences);
      noHardCaps(text);
      if (mode === 'reply') assert.doesNotMatch(text, /不超过\s*2-3\s*句|两三句说完就停/);
      assert.ok(text.includes('你今天的安排'));
      if (mode === 'proactive') {
        const active = text.slice(text.indexOf('【主动消息模式】'));
        assert.ok(active.includes('主动'));
        assert.match(active, /一个(?:相关)?话题|单个话题|单一话题/);
        assert.match(active, /简短|短一些|精简|短一点/);
      }
    }
  }
});

await test('natural style never requires rhetorical quotas or intentional false recollection', () => {
  const text = prompt('喜欢长聊');
  assert.doesNotMatch(text, /每\s*5-8\s*条回复里，至少\s*1\s*条/);
  assert.doesNotMatch(text, /陈述句\s*\/\s*感叹\s*\/\s*疑问\s*=\s*4:1:1/);
  assert.doesNotMatch(text, /可以偶尔记岔一点|记岔[^\n]{0,25}更真/);
});

await test('low-energy and first-turn hints keep context without requiring every reply to split', () => {
  let lowEnergy;
  for (let id = 1; id < 80; id++) {
    const text = prompt('喜欢长聊', {}, { id });
    if (text.includes('低电量')) { lowEnergy = text; break; }
  }
  assert.ok(lowEnergy, 'fixture must exercise an actual low-energy branch');
  assert.match(lowEnergy, settings[2].sentences);
  noHardCaps(lowEnergy);
  const combined = prompt('喜欢长聊') + buildFirstTurnHint(base);
  noHardCaps(combined);
  assert.doesNotMatch(combined, /短消息（\|\| 分段）/, 'onboarding should not reintroduce unconditional short/burst guidance');
});

await test('reply-style changes preserve subject evidence, uncertain history and synthetic exclusion', () => {
  const memories = [
    { memory_type: 'fact', memory_subject: 'user', content: '用户证据甲' },
    { memory_type: 'fact', memory_subject: 'companion', content: '角色证据乙' },
    { memory_type: 'event', memory_subject: 'shared', content: '共同陈述丙' },
    { memory_type: 'fact', memory_subject: 'unknown', content: '未知记录丁' },
    { memory_type: 'event', memory_origin: 'synthetic', content: '不可进入提示词的虚构戊' },
  ];
  for (const { value } of settings) {
    const text = prompt(value, { memories, longTermDigest: '历史摘要己' });
    for (const [label, content] of [['对方本人的陈述', '用户证据甲'], ['角色自身的陈述', '角色证据乙'],
      ['双方共同陈述', '共同陈述丙'], ['归属待核实', '未知记录丁']]) {
      assert.ok(text.indexOf(label) >= 0 && text.indexOf(label) < text.indexOf(content));
    }
    assert.ok(!text.includes('不可进入提示词的虚构戊'));
    assert.ok(text.includes('不能把角色自己的经历安到对方身上'));
    assert.ok(text.includes('不能据此推断对方的家庭、身份或偏好'));
    assert.ok(text.includes('不要自己编造拍摄进度'));
  }
});

await test('style settings do not erase safe-mode or dangerous-request boundaries', () => {
  for (const { value } of settings) {
    const text = prompt(value, {}, { safe_mode: 1, relationship_stage: '恋人', call_user_as: '宝贝' });
    assert.ok(text.includes('安全模式'));
    assert.ok(text.includes('是他的**朋友**'));
    assert.ok(!text.includes('你叫对方"宝贝"'));
    assert.ok(!text.includes('【初恋'));
    assert.ok(text.includes('违法') && text.includes('伤人'));
  }
});
