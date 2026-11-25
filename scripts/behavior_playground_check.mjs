import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real chat pipeline, real SQLite, and the actual provider adapter. Only the
// upstream LLM HTTP service is replaced; no production functions are mocked.
const directory = mkdtempSync(join(tmpdir(), 'suqing-behavior-playground-'));
const environment = {
  DB_PATH: join(directory, 'test.db'), LOG_DIR: join(directory, 'logs'), LOG_LEVEL: 'error',
  CHAT_PROVIDER: 'openai-compatible', CHAT_MODEL: 'behavior-fixture',
  OPENAI_COMPATIBLE_API_KEY: 'local-fixture', BEHAVIOR_ENABLED: 'true',
  INNER_OS_MODE: 'always', INNER_OS_ENABLED: 'true',
  PROVIDER_RETRY_MAX: '0', PROVIDER_RETRY_BASE_DELAY_MS: '0', SEARCH_PROVIDER: '',
};
const saved = Object.fromEntries([...Object.keys(environment), 'OPENAI_COMPATIBLE_BASE_URL', 'BEHAVIOR_LIBRARY_DIR'].map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
delete process.env.BEHAVIOR_LIBRARY_DIR;
let requests = [], failFinal = false;
let reviewResponse = { decision: 'keep', reasons: [] };
let candidate = { scenario: 'support', action: 'validate' };
const inventedThought = '之前你路考挂过，让我有点担心。';
const finalText = '我听见了，你可以慢慢说。';
const isInner = request => request.messages.some(message => message.role === 'system' && message.content.includes('现在不是写回复'));
const server = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  requests.push(payload);
  const inner = isInner(payload);
  const reviewing = payload.messages.some(message => message.role === 'system' && message.content.includes('revise') && message.content.includes('decision'));
  if (!inner && failFinal) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'fixture unavailable' } }));
    return;
  }
  const content = reviewing ? JSON.stringify(reviewResponse) : inner ? inventedThought + '\n' + JSON.stringify({
    user_tone: 'neutral', perceived_hurt: 0, is_apology: false,
    reply_energy: 'mid', behavior: candidate,
  }) : finalText;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.OPENAI_COMPATIBLE_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
let db;
try {
  const database = await import('../src/db.mjs');
  db = database.getDb();
  const { playgroundChat } = await import('../src/playground.mjs');
  const { setUserSchedule } = await import('../src/sleep.mjs');
  const { CHAT_FALLBACK } = await import('../src/chat_response.mjs');
  const { detectSafetyRisk } = await import('../src/moderation.mjs');
  const { readBehaviorState } = await import('../src/behavior_tasks.mjs');
  db.prepare("INSERT INTO users(id,wechat_user_id) VALUES(1,'behavior-web'),(2,'behavior-safe'),(3,'behavior-probe')").run();
  db.prepare(`INSERT INTO companions(id,user_id,bot_id,name,memory_enabled,proactive_enabled,safe_mode)
    VALUES(1,1,'fixture','素晴',0,1,0),(2,2,'fixture','素晴',0,1,1),(3,3,'fixture','素晴',0,1,0)`).run();
  setUserSchedule(1, { enabled: false });
  setUserSchedule(2, { enabled: false });
  const count = table => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  const last = () => JSON.parse(db.prepare('SELECT plan_json FROM behavior_deliveries ORDER BY id DESC LIMIT 1').get().plan_json);
  const hasHint = (request, marker) => request.messages.some(message => message.role === 'system' && message.content.includes(marker));
  const call = async (text, options = {}, id = 1) => {
    requests = [];
    const result = await playgroundChat(database.getCompanionById(id), text, options);
    // memory is explicitly disabled, so successful post-processing is synchronous.
    await new Promise(resolve => setImmediate(resolve));
    return result;
  };
  const assertPipelineCalls = () => {
    assert.equal(requests.length, process.env.BEHAVIOR_ENABLED === 'true' && !failFinal ? 3 : 2, 'V1 plans, generates, then reviews a substantive reply; failed drafts/off skip review');
    assert.equal(isInner(requests[0]), true);
    assert.equal(isInner(requests[1]), false);
  };

  const supported = await call('今天工作搞砸了，我特别委屈');
  assert.equal(supported.reply, finalText);
  assertPipelineCalls();
  assert.ok(hasHint(requests[0], '本轮相处行为候选'));
  assert.ok(hasHint(requests[1], '本轮相处行动'));
  assert.ok(requests[1].messages[0].content.length < 6000, 'V1 must not stack the old long persona template');
  assert.ok(!hasHint(requests[1], '内心和嘴上'));
  assert.equal(db.prepare("SELECT count(*) n FROM ai_usage_events WHERE purpose='review'").get().n, 1, 'the output review has a separately visible usage purpose');
  assert.ok(!hasHint(requests[1], inventedThought), 'unverified inner narrative must not become reply evidence');
  assert.deepEqual([last().scenario, last().action], ['support', 'validate']);
  assert.ok(!hasHint(requests[1], '每 5-8 条回复里'), 'support must not compete with compulsory criticism');
  assert.ok(!hasHint(requests[1], '【你也会逗他】'), 'support does not request teasing at the same time');
  assert.equal(db.prepare('SELECT delivered_text FROM behavior_deliveries ORDER BY id DESC LIMIT 1').get().delivered_text, supported.reply);

  await call('嗯');
  assertPipelineCalls();
  assert.deepEqual([last().scenario, last().action], ['support', 'listen']);
  await call('今晚我想吃一碗面条');
  assert.ok(!hasHint(requests.at(-1), inventedThought), 'ordinary turns also discard unverified inner narrative when V1 is enabled');
  const afterNewTopic = count('behavior_deliveries');
  await call('嗯');
  assert.equal(count('behavior_deliveries'), afterNewTopic, 'ack after an ordinary new topic cannot resurrect support');
  await call('今天工作搞砸了，我特别委屈');
  await call('别再问这件事了');
  assertPipelineCalls();
  assert.equal(readBehaviorState(1).scenario, 'pause', 'stop tombstone takes precedence over delivered support');
  assert.ok(db.prepare('SELECT reset_at FROM behavior_state_resets WHERE companion_id=1').get());
  const afterStop = count('behavior_deliveries');
  await call('嗯');
  assert.equal(count('behavior_deliveries'), afterStop, 'ack after pause does not restart old support');
  assert.ok(!requests.some(request => hasHint(request, '本轮相处行为候选')));
  await call('今天晚上我想吃面条');
  assert.equal(count('behavior_deliveries'), afterStop, 'new unrelated topic does not inherit old behavior');

  candidate = { scenario: 'celebrate', action: 'celebrate' };
  await call('我终于拿到驾照啦，真是好消息');
  assertPipelineCalls();
  assert.equal(last().scenario, 'celebrate');
  candidate = { scenario: 'repair', action: 'repair' };
  await call('你刚才那句话让我很不舒服');
  assertPipelineCalls();
  assert.deepEqual([last().scenario, last().action], ['repair', 'repair']);

  candidate = { scenario: 'support', action: 'validate', followup: { delayMinutes: 10 } };
  await call('我很委屈，10分钟后再找我聊聊');
  assertPipelineCalls();
  assert.equal(last().followup, null, 'web cannot schedule even when user explicitly asks');
  assert.equal(count('behavior_followup_tasks'), 0);

  const revised = '这件事让你受委屈了。';
  reviewResponse = { decision: 'revise', reply: revised, reasons: ['style'] };
  const revisedResult = await call('今天工作搞砸了，我特别委屈');
  assert.equal(revisedResult.reply, revised);
  assert.equal(revisedResult.segments.map(s => s.text).join(''), revised);
  const lastAssistant = () => db.prepare("SELECT content FROM companion_conversation_turns WHERE role='assistant' ORDER BY id DESC LIMIT 1").get().content;
  assert.equal(lastAssistant(), revised);
  assert.equal(db.prepare('SELECT delivered_text FROM behavior_deliveries ORDER BY id DESC LIMIT 1').get().delivered_text, revised);
  const beforeFailure = count('behavior_deliveries');
  const beforeAssistant = db.prepare("SELECT count(*) n FROM companion_conversation_turns WHERE role='assistant'").get().n;
  reviewResponse = { decision: 'missing' };
  assert.equal((await call('我很委屈，10分钟后再找我聊聊')).reply, CHAT_FALLBACK);
  assertPipelineCalls();
  assert.equal(lastAssistant(), revised, 'unchecked draft cannot become future history');
  assert.equal(count('behavior_deliveries'), beforeFailure);
  assert.equal(count('behavior_followup_tasks'), 0);
  assert.equal(db.prepare("SELECT status FROM ai_usage_events WHERE purpose='review' ORDER BY id DESC LIMIT 1").get().status, 'fallback');
  reviewResponse = { decision: 'keep', reasons: [] };
  failFinal = true;
  assert.equal((await call('今天工作搞砸了，我还是很委屈')).reply, CHAT_FALLBACK);
  assertPipelineCalls();
  failFinal = false;
  assert.equal(count('behavior_deliveries'), beforeFailure, 'failed final generation cannot record a delivery');
  assert.equal(db.prepare("SELECT count(*) n FROM companion_conversation_turns WHERE role='assistant'").get().n, beforeAssistant);

  await call('今天工作搞砸了，我特别委屈', {}, 2);
  assert.equal(count('behavior_deliveries'), beforeFailure, 'minor safe mode bypasses behavior');
  assert.ok(!requests.some(request => hasHint(request, '本轮相处行为候选') || hasHint(request, '本轮相处行动')));
  const risky = '我想自杀，真的不想活了';
  assert.notEqual(detectSafetyRisk(risky).level, 'none', 'fixture must exercise real safety detection');
  await call(risky);
  assert.equal(count('behavior_deliveries'), beforeFailure, 'safety intervention bypasses behavior');
  assert.ok(!requests.some(request => hasHint(request, '本轮相处行为候选') || hasHint(request, '本轮相处行动')));
  assert.ok(count('safety_events') > 0);

  for (const text of ['今天工作搞砸了，我特别委屈', '别再问这件事了', '我现在特别难受', risky]) {
    const before = db.prepare('SELECT total_changes() n').get().n;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const snapshot = () => Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
    const rows = snapshot();
    await call(text, { probe: true }, 3);
    if (text === '今天工作搞砸了，我特别委屈') {
      assertPipelineCalls();
      assert.ok(hasHint(requests[0], '本轮相处行为候选'));
      assert.ok(hasHint(requests[1], '本轮相处行动'));
    }
    if (text === '我现在特别难受' || text === risky) {
      assert.notEqual(detectSafetyRisk(text).level, 'none');
      assert.ok(!requests.some(request => hasHint(request, '本轮相处行为候选') || hasHint(request, '本轮相处行动')));
    }
    assert.equal(db.prepare('SELECT total_changes() n').get().n, before, `probe must execute zero SQLite writes: ${text}`);
    assert.deepEqual(snapshot(), rows, 'probe preserves every table including usage, arc, emotion, behavior, turns and safety');
  }

  process.env.BEHAVIOR_ENABLED = 'false';
  const beforeOff = count('behavior_deliveries');
  const beforeResets = count('behavior_state_resets');
  await call('今天工作搞砸了，我特别委屈');
  assertPipelineCalls();
  assert.ok(hasHint(requests.at(-1), inventedThought), 'feature-off retains the legacy inner thought contract');
  await call('别再问这件事了');
  assert.equal(count('behavior_deliveries'), beforeOff);
  assert.equal(count('behavior_state_resets'), beforeResets);
  assert.ok(!requests.some(request => hasHint(request, '本轮相处行为候选') || hasHint(request, '本轮相处行动')));
  console.log('behavior playground: HTTP/SQLite generation, review, revision and persistence, multi-turn scenes, stop, failures, safe mode, safety, web gates, probe zero-write and feature-off passed');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  db?.close();
  rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
