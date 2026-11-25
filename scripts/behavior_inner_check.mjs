import assert from 'node:assert/strict';
import * as inner from '../src/inner_os.mjs';

// Regression: nested action JSON must not erase existing conflict signals.
const raw = '我有点委屈，但愿意听她把话说完。\n' + JSON.stringify({
  user_tone: 'harsh', perceived_hurt: 2, is_apology: false,
  behavior: { scenario: 'repair', action: 'clarify' },
});
assert.equal(inner.parseInnerStruct(raw)?.user_tone, 'harsh', 'nested behavior must preserve arc signals');
const result = inner.parseInnerResponse(raw);
assert.equal(result.thought, '我有点委屈，但愿意听她把话说完。');
assert.deepEqual(result.behavior, { scenario: 'repair', action: 'clarify' });
assert.equal(result.struct.perceived_hurt, 2);
assert.equal(inner.parseInnerStruct('{"user_tone":"warm","is_apology":false}')?.is_apology, false);
assert.equal(inner.parseInnerStruct('{"user_tone":"warm","is_apology":"false"}')?.is_apology, false, 'string false must not count as an apology');

for (const broken of [
  '我想听听。\n{"user_tone":"neutral","behavior":{"scenario":"support"',
  '```json\n{"behavior":{"scenario":"support"',
  '{"behavior":{"scenario":"support","action":"listen"}}',
]) {
  const parsed = inner.parseInnerResponse(broken);
  assert.ok(!/[{}]|scenario|behavior/.test(parsed.thought), 'internal metadata cannot become a thought on malformed output');
}
const quoted = inner.parseInnerResponse('想安慰。\n{"user_tone":"neutral","intent":"他说\\\"{难受}\\\"","behavior":{"scenario":"support","action":"listen"}}');
assert.equal(quoted.struct.user_tone, 'neutral', 'quoted braces do not terminate JSON');
assert.equal(quoted.thought, '想安慰。');
assert.equal(inner.parseInnerResponse('只是想陪陪她').thought, '只是想陪陪她', 'legacy plain thought still works');
console.log('behavior inner protocol: nested signals, strict boolean, truncation isolation and legacy output passed');

// Exercise generateReply's actual purpose gate. Only the provider/search/usage
// boundaries are replaced, so conversation cleanup cannot corrupt internal JSON.
const { readFileSync } = await import('node:fs');
const { default: vm } = await import('node:vm');
const aiSource = readFileSync(new URL('../src/ai.mjs', import.meta.url), 'utf8');
const functions = aiSource.slice(aiSource.indexOf('function stripActionNarration('), aiSource.indexOf('export async function extractStructuredInfo(')).replaceAll('export async function', 'async function');
let searched = 0, usage = 0;
const wireOutput = '（想先听听）\n{"user_tone":"neutral","behavior":{"scenario":"support","action":"listen"}}';
const generate = vm.runInNewContext(`${functions}\ngenerateReply`, {
  Date, Math, log() {}, resolveReplyTemperature: t => t, isChatFallback: () => false, CHAT_FALLBACK: 'unavailable',
  shouldSearch: () => ({ search: true }), webSearch: async () => { searched++; return { ok: false }; }, formatSearchContext: () => '',
  chatCompleteWithRetry: async () => ({ text: wireOutput }), recordAiUsageEvent: () => usage++,
});
assert.equal(await generate('fixture', [], '今天有什么新闻？', {}, { purpose: 'internal', probe: true }), wireOutput);
assert.equal(searched, 0, 'internal reasoning must not perform a web search');
assert.equal(usage, 0, 'probe must not create usage writes');
const ordinary = await generate('fixture', [], '今天有什么新闻？');
assert.equal(searched, 1, 'normal reply still has search behavior');
assert.equal(usage, 1, 'normal reply keeps usage accounting');
assert.ok(!ordinary.includes('（想先听听）'), 'normal reply still cleans action narration');
console.log('behavior inner purpose: no search or destructive cleaning, probe zero usage writes, normal reply unchanged');
