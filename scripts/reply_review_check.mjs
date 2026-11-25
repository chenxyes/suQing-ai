/** Real review protocol and SQLite accounting; replace only the remote provider. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const directory = mkdtempSync(join(tmpdir(), 'suqing-reply-review-'));
process.env.DB_PATH = join(directory, 'test.db');
process.env.LOG_DIR = join(directory, 'logs');
process.env.LOG_LEVEL = 'error';
// Exercise migration against an existing production-shaped ledger, including a row.
const old = new Database(process.env.DB_PATH);
old.exec(`CREATE TABLE ai_usage_events(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id INTEGER,companion_id INTEGER,
  provider TEXT,model TEXT,capability TEXT NOT NULL,prompt_tokens INTEGER DEFAULT 0,completion_tokens INTEGER DEFAULT 0,
  images INTEGER DEFAULT 0,audio_seconds INTEGER DEFAULT 0,latency_ms INTEGER,status TEXT DEFAULT 'ok',estimated_cost REAL,currency TEXT,created_at INTEGER NOT NULL);
  INSERT INTO ai_usage_events(provider,model,capability,prompt_tokens,created_at) VALUES('fixture','old','chat',7,1);`);
old.close();
let db;
try {
  const { reviewGroundedReply: review } = await import('../src/reply_review.mjs');
  const { CHAT_FALLBACK } = await import('../src/chat_response.mjs');
  const context = {
    version: 1, current: { id: 'current', role: 'user', text: '味道还不错' },
    history: [{ id: 'turn:1', role: 'user', text: '今天吃了番茄面', at: '2026-11-24' },
      { id: 'turn:2', role: 'assistant', text: '自己煮的还是买的？', at: '2026-11-24' }],
    facts: [], events: [], unknown: [],
  };
  const companion = { id: 1, name: '测试角色', relationship_stage: '朋友', no_pressure: true, max_tokens: 400,
    bot_token: 'MUST_NOT_LEAVE_PROCESS', private_test_secret: 'MUST_NOT_LEAVE_PROCESS' };
  const draft = '那看来是买对啦。';
  const input = { draft, context, companion, accountId: 17 };
  // Regression: a malformed reviewer must not leak the unverified factual claim.
  const bad = await review(input, async () => ({ text: '{"decision":"revise"', provider: 'fixture', model: 'judge', usage: { prompt_tokens: 12, completion_tokens: 4 } }));
  assert.equal(bad.reply, CHAT_FALLBACK, 'invalid review cannot fall open to an unsupported draft');
  assert.equal(bad.status, 'fallback');

  const database = await import('../src/db.mjs');
  db = database.getDb();
  assert.deepEqual(db.prepare('SELECT purpose,prompt_tokens FROM ai_usage_events WHERE id=1').get(), { purpose: 'reply', prompt_tokens: 7 }, 'migration preserves old usage rows');
  assert.equal(db.prepare("SELECT status FROM ai_usage_events WHERE purpose='review' ORDER BY id DESC LIMIT 1").get().status, 'fallback');
  const callsBefore = db.prepare('SELECT count(*) n FROM ai_usage_events').get().n;
  let calls = 0;
  const revised = await review({ ...input, persona: { personaFacts: [{ category: 'hobbies', content: '喜欢画画' }],
    dailySchedule: { date_key: '2026-11-24', items: [{ time: '18:00', activity: '准备画画' }] }, apiKey: 'MUST_NOT_LEAVE_PROCESS' } }, async request => {
    calls++;
    assert.ok(request.timeout_ms > 0 && request.timeout_ms <= 10000, 'one review request is time bounded');
    assert.ok(request.max_tokens >= 400 && request.max_tokens <= 1600, 'review response budget is bounded');
    const payload = JSON.parse(request.messages[0].content);
    assert.equal(payload.context.history[1].role, 'assistant');
    assert.equal(payload.context.history[1].text, '自己煮的还是买的？', 'actual question reaches semantic review');
    assert.equal(payload.context.current.text, '味道还不错');
    assert.equal(payload.draft, draft);
    assert.ok(JSON.stringify(payload).includes('喜欢画画'), 'self-background is available for legitimate personal statements');
    assert.ok(!JSON.stringify(payload).includes('MUST_NOT_LEAVE_PROCESS'), 'raw companion/provider fields never enter review');
    return { text: JSON.stringify({ decision: 'revise', reply: '好吃就好。', reasons: ['unsupported_fact'] }), provider: 'fixture', model: 'judge',
      usage: { prompt_tokens: 30, completion_tokens: 10 }, finish_reason: 'stop' };
  });
  assert.deepEqual(revised, { reply: '好吃就好。', status: 'revised', reasons: ['unsupported_fact'] });
  assert.equal(calls, 1, 'review never adds a second repair generation');
  assert.equal(db.prepare('SELECT count(*) n FROM ai_usage_events').get().n, callsBefore + 1);
  assert.deepEqual(db.prepare('SELECT purpose,account_id,companion_id,prompt_tokens,completion_tokens,status FROM ai_usage_events ORDER BY id DESC LIMIT 1').get(),
    { purpose: 'review', account_id: 17, companion_id: 1, prompt_tokens: 30, completion_tokens: 10, status: 'ok' });

  const keep = async () => ({ text: '{"decision":"keep","reasons":[]}', provider: 'fixture', model: 'judge', usage: { prompt_tokens: 3, completion_tokens: 2 } });
  const followup = await review({ ...input, probe: true, draft: '现在方便聊聊吗？', context: { ...context,
    current: { id: 'current', role: 'user', text: '' },
    task: { kind: 'followup', topic: '我很委屈，30分钟后再问我', dueAt: 1234, status: 'claimed' } } }, async request => {
    const data = JSON.parse(request.messages[0].content);
    assert.equal(data.context.current.text, '');
    assert.equal(data.context.task.kind, 'followup');
    assert.equal(data.context.task.status, 'claimed');
    return keep();
  });
  assert.equal(followup.status, 'kept', 'authorized scheduled followup retains its separate context');
  const kept = await review({ ...input, draft: '好吃就好。' }, keep);
  assert.deepEqual(kept, { reply: '好吃就好。', status: 'kept', reasons: [] });
  assert.equal((await review({ ...input, draft: 'sourceId: memory:1', probe: true }, keep)).reply, CHAT_FALLBACK, 'KEEP cannot authorize leaked internal metadata');
  for (const reply of ['【STICKER:happy】', '[STICKER:happy】', '我这就拍给你。']) {
    const decision = await review({ ...input, probe: true }, async () => ({ text: JSON.stringify({ decision:'revise', reply, reasons:['style'] }) }));
    assert.equal(decision.reply, CHAT_FALLBACK, 'review cannot create a media action');
  }
  const approved = async (user, history, reply) => review({ ...input, probe:true, draft:reply, context:{ ...context,
    current:{role:'user',text:user}, history } }, keep);
  assert.equal((await approved('好的', [{role:'user',text:'先不聊这个了，今天想吃面'}], '那你想吃什么面呢？')).reply, '好。');
  assert.equal((await approved('我八点半到九点左右才有时间', [], '就八点半，我等你。')).reply, '好，你有空的时候聊。');
  assert.equal((await approved('我八点半到九点有空，你选个时间？', [], '那就八点半吧。')).reply, '那就八点半吧。');
  const aside = '味道不错就好～我晚上随便吃了点，现在也有点馋了。';
  assert.equal((await review({ ...input, draft:aside, probe:true }, keep)).reply, '味道不错就好～');
  const supportedSelf = { ...context, facts:[{subject:'companion',text:'我晚上随便吃了点。'}] };
  assert.equal((await review({ ...input, context:supportedSelf, draft:aside, probe:true }, keep)).reply, aside);
  let skippedCalls = 0;
  const ack = { ...input, draft: '嗯。', context: { ...context, current: { id: 'current', role: 'user', text: '好的' } } };
  assert.equal((await review(ack, async () => { skippedCalls++; return keep(); })).status, 'skipped');
  assert.equal(skippedCalls, 0, 'only a harmless confirmation is allowed to bypass');
  for (const extra of [
    { context },
    { context: { ...context, current: { id: 'current', role: 'user', text: '你觉得我该怎么办？' } } },
    { behaviorPlan: { scenario: 'support', action: 'suggest' } },
    { behaviorPlan: { scenario: 'pause', action: 'pause' } },
    { mode: 'all' },
    { mode: 'invalid-mode' },
    { draft: '嗯，你又迟到了。' },
  ]) {
    const result = await review({ ...ack, ...extra }, keep);
    assert.notEqual(result.status, 'skipped', 'requests, action plans and factual text cannot use confirmation bypass');
  }

  for (const response of [
    { text: '```json\n{"decision":"keep","reasons":[]}\n```' },
    { text: '{"decision":"keep","reply":"偷偷改写","reasons":[]}' },
    { text: '{"decision":"revise","reply":"","reasons":["unsupported_fact"]}' },
    { text: '{"decision":"revise","reply":"[STICKER:surprise]","reasons":["unsupported_fact"]}' },
    { text: '{"decision":"revise","reply":"[STICKER:surprise","reasons":["unsupported_fact"]}' },
    { text: '{"decision":"revise","reply":"sourceId: memory:1","reasons":["unsupported_fact"]}' },
    { text: '{"decision":"revise","reply":"那也不错。","reasons":["arbitrary_tool"]}' },
    { text: '{"decision":"keep","reasons":[],"schedule":{"minutes":10}}' },
    { text: '{"decision":"keep","reasons":[]}', finish_reason: 'length' },
    { text: JSON.stringify({ decision: 'revise', reply: '长'.repeat(7000), reasons: ['unsupported_fact'] }) },
  ]) {
    const result = await review({ ...input, probe: true }, async () => response);
    assert.equal(result.status, 'fallback');
    assert.equal(result.reply, CHAT_FALLBACK, 'invalid, truncated or metadata-bearing review must not reach delivery');
  }
  let attempts = 0;
  const unavailable = await review(input, async () => { attempts++; const error = new Error('provider secret detail'); error.provider = 'fixture'; error.model = 'judge'; throw error; });
  assert.equal(attempts, 1, 'no recursive regeneration or provider retry');
  assert.equal(unavailable.reply, CHAT_FALLBACK);
  assert.equal(db.prepare('SELECT status,purpose FROM ai_usage_events ORDER BY id DESC LIMIT 1').get().status, 'error');

  const writes = db.prepare('SELECT total_changes() n').get().n;
  await review({ ...input, probe: true }, keep);
  await review({ ...input, probe: true }, async () => { throw Error('fixture'); });
  assert.equal(db.prepare('SELECT total_changes() n').get().n, writes, 'probe must not write event or daily accounting');
  let invalidCalls = 0;
  for (const extra of [{ draft: '长'.repeat(7000) }, { context: null }, { draft: '' }, { draft: CHAT_FALLBACK }]) {
    const result = await review({ ...input, ...extra }, async () => { invalidCalls++; return keep(); });
    assert.equal(result.reply, CHAT_FALLBACK);
  }
  assert.equal(invalidCalls, 0, 'invalid/fallback input never consumes a judge request');
  const start = Date.now();
  assert.equal((await review({ ...input, probe: true }, () => new Promise(() => {}))).status, 'fallback');
  assert.ok(Date.now() - start < 11000, 'a stuck provider cannot hold the reply indefinitely');
  console.log('reply review: grounded protocol, bounded review, exact bypass, fail-closed, migration, accounting and probe isolation passed');
} finally {
  db?.close();
  rmSync(directory, { recursive: true, force: true });
}
