import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'chat-response-'));
Object.assign(process.env, { DB_PATH: path.join(dir, 'bot.db'), LOG_DIR: path.join(dir, 'logs'), CHAT_PROVIDER: 'openai-compatible',
  CHAT_MODEL: 'relay-model', OPENAI_COMPATIBLE_API_KEY: 'fake-chat-secret', PROVIDER_RETRY_MAX: '1', PROVIDER_RETRY_BASE_DELAY_MS: '0' });
let queue = [], requests = [];
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const b of req) raw += b;
  requests.push(JSON.parse(raw));
  const next = queue.shift() || { body: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] } };
  if (next.hang) return;
  res.writeHead(next.status || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(next.body));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.OPENAI_COMPATIBLE_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
let db;
try {
  const { generateReply } = await import('../src/ai.mjs');
  const { chatComplete } = await import('../src/providers/chat.mjs');
  db = (await import('../src/db.mjs')).getDb();
  const good = { body: { choices: [{ message: { content: '你好' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } } };
  const empty = { body: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] } };
  queue = [empty, good]; requests = [];
  assert.equal(await generateReply('test', [], 'hello'), '你好', 'empty response should retry and recover');
  assert.equal(requests.length, 2);
  const { CHAT_FALLBACK, normalizeChatResponse, chatFailureMetadata, boundedNumber } = await import('../src/chat_response.mjs');
  const cases = [
    [empty, 2], [{ body: { choices: [] } }, 2],
    [{ body: { choices: [{ message: { content: null, reasoning_content: 'private reasoning' }, finish_reason: 'length' }] } }, 1],
    [{ body: { choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }] } }, 1],
    [{ body: { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] } }, 1],
    [{ status: 401, body: { error: { message: 'secret upstream error', type: 'invalid_api_key' } } }, 1],
    [{ status: 429, body: { error: { message: 'rate limited', type: 'rate_limit' } } }, 2],
  ];
  for (const [response, attempts] of cases) {
    queue = Array.from({ length: 5 }, () => response); requests = [];
    assert.equal(await generateReply('test', [], 'hello'), CHAT_FALLBACK);
    assert.equal(requests.length, attempts, JSON.stringify(response));
  }
  queue = [good]; requests = [];
  await generateReply('test', [{ role: 'assistant', content: CHAT_FALLBACK }, { role: 'user', content: 'retain me' }], 'hello');
  assert.ok(requests[0].messages.some(m => m.content === 'retain me'));
  assert.ok(!requests[0].messages.some(m => m.role === 'assistant' && m.content === CHAT_FALLBACK));
  queue = [{ hang: true }];
  await assert.rejects(chatComplete({ system: 'test', messages: [], timeout_ms: 1000 }));
  assert.equal(normalizeChatResponse({ text: [{ type: 'text', text: ' answer ' }], finishReason: 'stop' }).text, 'answer');
  assert.throws(() => normalizeChatResponse({ text: {}, finishReason: 'stop' }), /invalid_content/);
  assert.throws(() => normalizeChatResponse({ text: '', finishReason: 'STOP' }), /empty_response/);
  assert.equal(boundedNumber(Infinity, 2, 0, 4), 2);
  assert.equal(boundedNumber(-1, 2, 0, 4), 0);
  assert.equal(boundedNumber(100, 2, 0, 4), 4);
  const metadata = chatFailureMetadata({ message: 'secret upstream error', status: 401 });
  assert.ok(!JSON.stringify(metadata).includes('secret'));
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO users (id, wechat_user_id) VALUES (98001, 'chat-fixture')").run();
  db.prepare("INSERT INTO companions (id, user_id, bot_id, name, safe_mode, memory_enabled) VALUES (98001,98001,'fixture','测试',1,0)").run();
  const { setUserSchedule } = await import('../src/sleep.mjs');
  setUserSchedule(98001, { enabled: false });
  const companion = (await import('../src/db.mjs')).getCompanionById(98001);
  const { playgroundChat } = await import('../src/playground.mjs');
  queue = Array.from({ length: 30 }, () => empty);
  const failed = await playgroundChat(companion, '这是一条回归测试消息');
  assert.equal(failed.reply, CHAT_FALLBACK);
  const turns = db.prepare('SELECT role, content FROM companion_conversation_turns WHERE companion_id = 98001').all();
  assert.deepEqual(turns.map(t => t.role), ['user'], 'failed reply must not persist an assistant turn');
  assert.equal(db.prepare('SELECT count(*) AS n FROM companion_memories WHERE companion_id = 98001').get().n, 0);
  console.log('chat response: transient recovery, bounded attempts, refusal, truncation, auth/rate limit, timeout, history and redaction passed');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  db?.close(); rmSync(dir, { recursive: true, force: true });
}
