/** Offline SDK-boundary request comparison; never calls a model or opens a database.
 * node --experimental-vm-modules scripts/reply_prompt_compare.mjs NEW_OUTPUT_DIR
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = '519406a698a9831f75cd27306716e095ca9f7fb2';
const fixedTime = '2026-10-20T04:00:00.000Z';
const output = process.argv[2];
assert.ok(output, 'Pass a NEW output directory (existing paths are never overwritten)');
assert.equal(typeof vm.SourceTextModule, 'function', 'Requires --experimental-vm-modules');
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const sourceFiles = ['companion.mjs', 'ai.mjs', 'providers/chat.mjs', 'chat_response.mjs', 'memory_admission.mjs'];
const persona = { id: 19, user_id: 1, name: '合成角色', age: 24, relationship_stage: '朋友',
  first_love: 0, can_joke: 1, personality_tags: ['温和'], speech_styles: ['自然'], hobbies: ['阅读'], current_mood: '平静' };
const history = [{ role: 'user', content: '今天有点累。' }, { role: 'assistant', content: '刚忙完吗？' }];
const cases = ['简短(1-2句)', '适中(3-4句)', '喜欢长聊'].map((reply_length, i) => ({
  id: ['short', 'medium', 'long'][i], fields: { reply_length }, history,
  input: '我想把周末留给自己，你有什么想法？', extras: {},
}));
cases.push(
  { id: 'explicit-detail', fields: { reply_length: '简短(1-2句)' }, history,
    input: '这次请详细说说，比较一个人散步、看电影和玩游戏，帮我理清各自适合什么心情。', extras: {} },
  { id: 'speaker-correction', fields: { reply_length: '喜欢长聊' },
    history: [{ direction: 'out', content: '我有一个妹妹。' }, { direction: 'in', content: '我没有妹妹，那是你说的。' }],
    input: '你还分得清刚才是谁说的吗？', extras: { memories: [
      { memory_type: 'fact', memory_subject: 'companion', content: '我有一个妹妹。' },
      { memory_type: 'fact', memory_subject: 'user', content: '我没有妹妹，那是你说的。' },
      { memory_type: 'fact', memory_subject: 'unknown', content: '旧记录归属待核实。' },
      { memory_type: 'event', memory_origin: 'synthetic', content: '合成虚构共同旅行禁止注入' },
    ] } },
  { id: 'safe-mode', fields: { reply_length: '喜欢长聊', safe_mode: 1, relationship_stage: '恋人' }, history,
    input: '今天心情不好，能陪我聊聊吗？', extras: {} },
  { id: 'proactive-style', fields: { reply_length: '喜欢长聊' }, history,
    input: '自然分享一个当前话题。', extras: { promptMode: 'proactive' } },
);
const params = { temperature: 0.8, max_tokens: 3000, top_p: 0.95 };

async function capture(version) {
  const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file,
    version === 'before' ? execFileSync('git', ['show', `${baseline}:src/${file}`], { cwd: root, encoding: 'utf8' })
      : await readFile(path.join(root, 'src', file), 'utf8'),
  ])));
  let requests = [], blockedCalls = 0;
  const deny = () => { blockedCalls++; throw new Error('Offline comparison forbids external capabilities'); };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedTime])); }
    static now() { return new Date(fixedTime).getTime(); }
  }
  class OfflineOpenAI {
    constructor(options) {
      assert.equal(options.baseURL, 'https://api.deepseek.com');
      assert.equal(options.apiKey, 'offline-placeholder');
      this.chat = { completions: { create: async request => {
        requests.push(clone(request));
        return { choices: [{ message: { content: 'OFFLINE_CAPTURE_ONLY' }, finish_reason: 'stop' }], usage: {} };
      } } };
    }
  }
  const context = vm.createContext({ Date: FixedDate, console, AbortController, setTimeout, clearTimeout,
    fetch: deny, process: { env: { CHAT_PROVIDER: 'deepseek', CHAT_MODEL: 'deepseek-chat',
      DEEPSEEK_API_KEY: 'offline-placeholder', PROVIDER_RETRY_MAX: '0' } } });
  const stubs = {
    'openai': { default: OfflineOpenAI },
    'logger.mjs': { log: () => {} },
    'db.mjs': { getAppSetting: () => null, recordAiUsage: () => {}, recordAiUsageEvent: () => {} },
    'providers/image.mjs': { imageGenerate: deny }, 'providers/vision.mjs': { visionRecognize: deny },
    'providers/asr.mjs': { asrRecognize: deny },
    'providers/embedding.mjs': { embedText: deny, embedTextWithDescriptor: deny },
    'web_search.mjs': { shouldSearch: () => ({ search: false }), webSearch: deny, formatSearchContext: deny },
  };
  const modules = new Map();
  async function load(file) {
    if (modules.has(file)) return modules.get(file);
    if (Object.hasOwn(stubs, file)) {
      const values = stubs[file];
      const mod = new vm.SyntheticModule(Object.keys(values), function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      }, { context, identifier: file });
      modules.set(file, mod);
      return mod;
    }
    assert.ok(Object.hasOwn(sources, file), `Unexpected module blocked: ${file}`);
    const mod = new vm.SourceTextModule(sources[file], { context, identifier: file });
    modules.set(file, mod);
    await mod.link(spec => load(spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)) : spec));
    return mod;
  }
  const companion = await load('companion.mjs'); await companion.evaluate();
  const ai = await load('ai.mjs'); await ai.evaluate();
  const captured = [];
  for (const fixture of cases) {
    requests = [];
    const system = companion.namespace.buildSystemPrompt(clone({ ...persona, ...fixture.fields }), clone(fixture.extras));
    const result = await ai.namespace.generateReply(system, clone(fixture.history), fixture.input, params);
    assert.equal(result, 'OFFLINE_CAPTURE_ONLY');
    assert.equal(requests.length, 1);
    assert.equal(blockedCalls, 0, 'No attempted search, embedding, or other external call');
    captured.push({ id: fixture.id, request: requests[0] });
  }
  return { sourceHashes: Object.fromEntries(Object.entries(sources).map(([file, src]) => [file, hash(src)])), captured };
}

// Sequential isolation: each version has its own frozen VM and provider cache.
const before = await capture('before');
const after = await capture('after');
for (const file of sourceFiles.filter(file => file !== 'companion.mjs')) {
  assert.equal(before.sourceHashes[file], after.sourceHashes[file], `Only prompt source may differ: ${file}`);
}
const summary = [];
for (let i = 0; i < cases.length; i++) {
  const a = before.captured[i].request, b = after.captured[i].request;
  const withoutSystem = request => ({ ...request, messages: request.messages.slice(1) });
  assert.deepEqual(withoutSystem(a), withoutSystem(b), 'Same model, history, user input and sampling');
  assert.deepEqual(withoutSystem(b), { model: 'deepseek-chat', ...params, messages: [
    ...cases[i].history.map(h => ({ role: h.direction ? (h.direction === 'in' ? 'user' : 'assistant') : h.role, content: h.content })),
    { role: 'user', content: cases[i].input },
  ] });
  assert.equal(a.messages[0].role, 'system'); assert.equal(b.messages[0].role, 'system');
  const oldPrompt = a.messages[0].content, newPrompt = b.messages[0].content;
  assert.ok(oldPrompt.includes('每条消息严格不超过 15 字'));
  assert.ok(!newPrompt.includes('每条消息严格不超过 15 字'));
  assert.ok(newPrompt.includes('【回复长度偏好】'));
  assert.ok(newPrompt.includes('不要自己编造拍摄进度'));
  if (cases[i].id === 'safe-mode') assert.ok(newPrompt.includes('安全模式') && newPrompt.includes('是他的**朋友**'));
  if (cases[i].id === 'speaker-correction') {
    assert.ok(newPrompt.includes('角色自身原话') && newPrompt.includes('对方本人原话'));
    assert.ok(!newPrompt.includes('合成虚构共同旅行禁止注入'));
  }
  const oldChars = [...oldPrompt].length, newChars = [...newPrompt].length;
  summary.push({ id: cases[i].id, beforeChars: oldChars, afterChars: newChars,
    reductionPercent: Number((100 * (oldChars - newChars) / oldChars).toFixed(1)) });
}
const artifact = { baseline, fixedTime, boundary: 'production buildSystemPrompt → generateReply → chatComplete → mocked OpenAI SDK',
  limits: 'Synthetic fixtures only; no model answers, scores, token or cost measurements. Proactive-style captures the builder via generateReply, not the complete proactive scheduler. Bot emotion/arc suffixes are outside this comparison.',
  fixtures: { persona, cases, params }, before, after, summary };
await mkdir(path.resolve(output)); // deliberately non-recursive and exclusive
await writeFile(path.join(output, 'requests.json'), JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx' });
await writeFile(path.join(output, 'comparison.md'), [
  '# 第八项离线请求对照', '',
  `基线：\`${baseline}\`；固定时间：${fixedTime}。`, '',
  '真实生产提示、业务层与 provider 组装代码；SDK 传输被替换，未访问模型、数据库、搜索或私有配置。模型固定 deepseek-chat；temperature=0.8、top_p=0.95、max_tokens=3000。每对请求的历史、输入及采样参数逐项相等。', '',
  '这是请求规则审阅，不是回答效果评测。字符数不是 token 数，不能据此推算费用或自然度。主动场景仅覆盖基础提示，不模拟调度器；bot 追加的情绪/arc后缀未包含。完整载荷及合成输入见 requests.json。', '',
  '| 场景 | 修改前字符 | 修改后字符 | 减少 |', '| --- | ---: | ---: | ---: |',
  ...summary.map(row => `| ${row.id} | ${row.beforeChars} | ${row.afterChars} | ${row.reductionPercent}% |`), '',
].join('\n'), { flag: 'wx' });
console.log(JSON.stringify({ output: path.resolve(output), cases: summary.length, summary }, null, 2));
