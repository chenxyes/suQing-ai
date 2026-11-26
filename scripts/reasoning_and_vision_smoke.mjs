/**
 * Phase 1 Smoke Test:
 *  - 主/辅模型路由（primary vs aux）与推理模型 max_tokens 保底
 *  - reasoning_content 捕获、严格隔离（绝不进入出站回复、对话历史或日志）与敏感脱敏
 *  - app_settings 覆盖 .env 的 shadowing 诊断
 *  - 统一“懂梗视神经” vision prompt（chat / social_screenshot 模式）与 customVision / deepseek 透传
 *  - debug-prompt.html 内联脚本语法校验
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const dir = mkdtempSync(path.join(tmpdir(), 'liveness-phase1-'));
Object.assign(process.env, {
  DB_PATH: path.join(dir, 'bot.db'),
  LOG_DIR: path.join(dir, 'logs'),
  CHAT_PROVIDER: 'openai-compatible',
  CHAT_MODEL: 'deepseek-reasoner',
  OPENAI_COMPATIBLE_API_KEY: 'fixture-key',
  CHAT_REASONING_MAX_TOKENS: '4096',
  CHAT_REASONING_CAPTURE: 'false',
  PROVIDER_RETRY_MAX: '0',
  INNER_OS_MODE: 'always',
});

let queue = [];
let requests = [];
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const parsed = raw ? JSON.parse(raw) : {};
  requests.push({ url: req.url, body: parsed });
  const next = queue.shift() || {
    body: {
      choices: [{ message: { content: '默认回复', reasoning_content: '内部思考链' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    },
  };
  res.writeHead(next.status || 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(next.body));
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
process.env.OPENAI_COMPATIBLE_BASE_URL = baseURL;

let db;
const realFetch = globalThis.fetch;
try {
  const { getDb, setAppSetting, deleteAppSetting } = await import('../src/db.mjs');
  db = getDb();
  const { chatComplete, getActiveChatProvider, getActiveAuxChatProvider, isReasoningModel } = await import('../src/providers/chat.mjs');
  const { generateReply, extractStructuredInfo, activityToPhotoPrompt, recognizeImage } = await import('../src/ai.mjs');
  const { generateInnerMonologue } = await import('../src/inner_os.mjs');
  const { getReasoningTraces, clearReasoningTraces } = await import('../src/reasoning_debug.mjs');
  const { buildVisionPrompt, REGISTRY: VISION_REGISTRY } = await import('../src/providers/vision.mjs');

  // 1. Reasoning model detection + aux inheritance
  assert.equal(isReasoningModel('deepseek-reasoner'), true);
  assert.equal(isReasoningModel('deepseek-chat'), false);
  assert.equal(getActiveAuxChatProvider().inherited, true);
  assert.equal(getActiveAuxChatProvider().model, 'deepseek-reasoner');

  // 2. Separate aux model routing + reasoning max_tokens floor
  process.env.CHAT_AUX_MODEL = 'deepseek-chat';
  const auxInfo = getActiveAuxChatProvider();
  assert.equal(auxInfo.inherited, false);
  assert.equal(auxInfo.model, 'deepseek-chat');

  requests = [];
  queue = [
    { body: { choices: [{ message: { content: '嗯哼||刚忙完', reasoning_content: 'SECRET_THOUGHT_DO_NOT_LEAK sk-1234567890abcdef' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 15 } } },
    { body: { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] } },
    { body: { choices: [{ message: { content: 'A sunny desk snapshot' }, finish_reason: 'stop' }] } },
    { body: { choices: [{ message: { content: '他怎么又来了\n{"intent":"打招呼","user_tone":"warm","perceived_hurt":0,"is_apology":false,"apology_target":"","reply_energy":"mid"}' }, finish_reason: 'stop' }] } },
  ];

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let reply;
  try {
    reply = await generateReply('你是测试角色', [], '在干嘛呀今天', { max_tokens: 1000 }, { companionId: 101 });
  } finally {
    console.log = origLog;
  }

  assert.equal(reply, '嗯哼||刚忙完', 'generateReply must return only text, never reasoning_content');
  assert.ok(!reply.includes('SECRET_THOUGHT_DO_NOT_LEAK'));
  assert.ok(!logs.join('\n').includes('SECRET_THOUGHT_DO_NOT_LEAK'), 'logs must never contain reasoning_content');
  assert.equal(requests[0].body.model, 'deepseek-reasoner');
  assert.ok(requests[0].body.max_tokens >= 4096, 'reasoning primary call must enforce CHAT_REASONING_MAX_TOKENS floor');
  assert.equal(getReasoningTraces(101).length, 0, 'capture=false must not record traces');

  const extracted = await extractStructuredInfo('json only', 'input', { maxTokens: 300 });
  assert.equal(extracted, '{"ok":true}');
  assert.equal(requests[1].body.model, 'deepseek-chat', 'extractStructuredInfo must route to aux model');
  assert.equal(requests[1].body.max_tokens, 300, 'aux non-reasoning model keeps compact max_tokens');

  const photoPrompt = await activityToPhotoPrompt('喝咖啡');
  assert.equal(photoPrompt, 'A sunny desk snapshot');
  assert.equal(requests[2].body.model, 'deepseek-chat', 'activityToPhotoPrompt must route to aux model');

  const innerRes = await generateInnerMonologue({ companion: { id: 101, name: '素清' }, userText: '今天过得怎么样呀想你了' });
  assert.ok(innerRes?.thought?.includes('他怎么又来了'));
  assert.equal(requests[3].body.model, 'deepseek-chat', 'Inner OS must route to aux model');

  // 3. Reasoning capture enabled + secret redaction + reasoning-only token_limit guard
  process.env.CHAT_REASONING_CAPTURE = 'true';
  clearReasoningTraces();
  queue = [
    { body: { choices: [{ message: { content: '好呀', reasoning_content: '内心独白测试 key=sk-secret987654321' }, finish_reason: 'stop' }] } },
    { body: { choices: [{ message: { content: '', reasoning_content: '耗尽了全部token' }, finish_reason: 'length' }] } },
  ];
  const reply2 = await generateReply('你是测试角色', [], '晚上吃啥', {}, { companionId: 101 });
  assert.equal(reply2, '好呀');
  const traces = getReasoningTraces(101, 5);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].model, 'deepseek-reasoner');
  assert.ok(traces[0].reasoning.includes('内心独白测试'));
  assert.ok(!traces[0].reasoning.includes('sk-secret987654321'), 'reasoning trace must redact secret patterns');
  assert.ok(traces[0].reasoning.includes('[REDACTED]'));

  await assert.rejects(
    chatComplete({ system: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    err => err.code === 'token_limit',
    'reasoning-only empty content on length must throw token_limit',
  );

  // 4. Native Anthropic & Gemini reasoning extraction
  process.env.CHAT_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'fixture-anth';
  globalThis.fetch = async () => Response.json({
    content: [
      { type: 'thinking', thinking: 'anthropic inner thought' },
      { type: 'text', text: 'anthropic final reply' },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 6 },
  });
  const anthRes = await chatComplete({ system: 's', messages: [{ role: 'user', content: 'u' }] });
  assert.equal(anthRes.text, 'anthropic final reply');
  assert.equal(anthRes.reasoning, 'anthropic inner thought');

  process.env.CHAT_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'fixture-gem';
  globalThis.fetch = async () => Response.json({
    candidates: [{
      content: { parts: [{ thought: true, text: 'gemini thought' }, { text: 'gemini reply' }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
  });
  const gemRes = await chatComplete({ system: 's', messages: [{ role: 'user', content: 'u' }] });
  assert.equal(gemRes.text, 'gemini reply');
  assert.equal(gemRes.reasoning, 'gemini thought');
  globalThis.fetch = realFetch;

  // 5. Effective config source & app_settings shadowing detection
  process.env.CHAT_PROVIDER = 'deepseek';
  process.env.CHAT_MODEL = 'deepseek-flash';
  setAppSetting('CHAT_MODEL', 'deepseek-chat', { secret: 0 });
  const activeMeta = getActiveChatProvider();
  assert.equal(activeMeta.model, 'deepseek-chat');
  assert.equal(activeMeta.model_source, 'app_settings');
  assert.equal(activeMeta.shadowed_env.model, 'deepseek-flash');
  deleteAppSetting('CHAT_MODEL');

  // 6. Unified vision prompts (chat & social_screenshot) across custom & deepseek
  assert.ok(VISION_REGISTRY.deepseek, 'vision registry must include deepseek preset');
  assert.match(buildVisionPrompt('chat'), /表情包|弹幕|文字/);
  assert.match(buildVisionPrompt('social_screenshot'), /评论区|私信/);

  process.env.VISION_PROVIDER = 'custom';
  process.env.VISION_BASE_URL = baseURL;
  process.env.VISION_API_KEY = 'fixture-vis-key';
  process.env.VISION_MODEL = 'deepseek-flash';
  requests = [];
  queue = [
    { body: { choices: [{ message: { content: '这是一张橘猫表情包，配字：周一不想上班' } }] } },
    { body: { choices: [{ message: { content: '评论1(小明)：求耳环链接' } }] } },
  ];
  const visChat = await recognizeImage(Buffer.from('fake-img'), 'image/jpeg');
  assert.equal(visChat, '这是一张橘猫表情包，配字：周一不想上班');
  const sentChatPrompt = requests[0].body.messages[0].content.find(p => p.type === 'text')?.text || '';
  assert.equal(sentChatPrompt, buildVisionPrompt('chat'));

  const visSocial = await recognizeImage(Buffer.from('fake-img'), 'image/png', { mode: 'social_screenshot' });
  assert.equal(visSocial, '评论1(小明)：求耳环链接');
  const sentSocialPrompt = requests[1].body.messages[0].content.find(p => p.type === 'text')?.text || '';
  assert.equal(sentSocialPrompt, buildVisionPrompt('social_screenshot'));

  // 7. debug-prompt.html inline JS syntax check
  const debugHtml = readFileSync(new URL('../public/app/debug-prompt.html', import.meta.url), 'utf8');
  for (const [, script] of debugHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (script.trim()) new vm.Script(script);
  }
  assert.match(debugHtml, /reasoning-debug/);

  console.log('phase 1 smoke: primary/aux routing, reasoning capture & isolation, shadow detection, unified vision prompts & debug UI passed');
} finally {
  globalThis.fetch = realFetch;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  db?.close();
  rmSync(dir, { recursive: true, force: true });
}
