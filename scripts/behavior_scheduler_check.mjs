import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Execute the complete production scheduler+sender over a real temporary SQLite.
// Only the LLM and external WeChat sends are replaced. No real account or key.
const dir = mkdtempSync(join(tmpdir(), 'suqing-behavior-scheduler-'));
process.env.DB_PATH = join(dir, 'fixture.db');
process.env.BEHAVIOR_ENABLED = 'true';
process.env.LOG_LEVEL = 'error';
let db;
try {
  const database = await import('../src/db.mjs');
  db = database.getDb();
  db.prepare("INSERT INTO users(id,wechat_user_id) VALUES(1,'fixture')").run();
  db.prepare("INSERT INTO companions(id,user_id,bot_id,proactive_enabled,proactive_time_window,memory_enabled) VALUES(1,1,'fixture-bot',1,'00:00-24:00',0)").run();
  db.prepare("INSERT INTO wechat_accounts(wechat_user_id,bot_id,bot_token,is_active,companion_id) VALUES('fixture','fixture-bot','test',1,1)").run();
  const { rememberContextToken } = await import('../src/ilink.mjs');
  rememberContextToken('fixture-bot', 'fixture', 'test');
  const runtime = await import('../src/behavior_runtime.mjs');
  const tasks = await import('../src/behavior_tasks.mjs');
  const now = Date.now();
  const before = new Date(now - 90_000);
  for (const time of [before, new Date(now)]) database.saveDailySchedule(1, database.shanghaiDateKey(time), [], '平静');
  const userText = '我今天很难受，1分钟后再问我';
  const plan = runtime.resolveBehaviorPlan(runtime.prepareBehaviorContext({ companion: database.getCompanionById(1), userText, channel: 'wechat' }));
  assert.ok(plan?.followup);
  tasks.recordBehaviorDelivery({ companionId: 1, turnKey: 'fixture', plan, userText, deliveredText: '我在听。', channel: 'wechat', now: now - 120_000 });
  let generated = 0;
  let scenario = 'sent';
  const sends = [];
  globalThis.__behaviorSchedulerIO = {
    generateReply: async (system, _history, prompt) => {
      generated++;
      assert.ok(system.includes('本轮相处行动'));
      assert.ok(prompt.includes('明确请求的后续关心'));
      if (scenario === 'cancel') tasks.observeBehaviorInput(1, '不要再问我了');
      return scenario === 'failed' ? '刚才的委屈还想跟我聊聊吗？' : scenario === 'cancel' ? '我回来了，愿意的话就慢慢讲。' : '现在想说说刚才的事吗？我在听。';
    },
    sendTextMessage: async (_ctx, _recipient, text, _token, opts) => {
      assert.equal(opts?._allowQueue, false);
      if (scenario === 'failed') return false;
      sends.push(text);
      return true;
    },
    sendMessageItem: async () => { throw new Error('followup must not send stickers'); },
  };
  const url = new URL('../src/proactive.mjs', import.meta.url);
  let source = readFileSync(url, 'utf8');
  source = source.replace("import { generateReply } from './ai.mjs';", 'const { generateReply } = globalThis.__behaviorSchedulerIO;');
  source = source.replace('import { sendTextMessage, sendMessageItem, recallContextToken, peekSendQuota }', 'const { sendTextMessage, sendMessageItem } = globalThis.__behaviorSchedulerIO;\nimport { recallContextToken, peekSendQuota }');
  source = source.replace(/from (['"])(\.\/[^'"]+)\1/g, (_all, _quote, relative) => `from ${JSON.stringify(new URL(relative, url).href)}`);
  source += '\nexport { tick as fixtureTick, schedules as fixtureSchedules };';
  const scheduler = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  // No random slots: due promise must dispatch independently of them.
  scheduler.fixtureSchedules.set(1, { dateKey: database.shanghaiDateKey(before), items: [] });
  await scheduler.fixtureTick(before);
  assert.equal(generated, 0, 'must not generate before due');
  scheduler.fixtureSchedules.set(1, { dateKey: database.shanghaiDateKey(new Date(now)), items: [] });
  await scheduler.fixtureTick(new Date(now));
  assert.equal(generated, 1, 'due task invokes existing sender without a random slot');
  assert.equal(sends.length, 1);
  const task = db.prepare('SELECT status,delivered_text FROM behavior_followup_tasks').get();
  assert.equal(task.status, 'sent');
  assert.equal(task.delivered_text, sends[0]);
  await scheduler.fixtureTick(new Date(now + 1000));
  assert.equal(sends.length, 1, 'next tick cannot redeliver completed task');
  assert.ok(database.getConversationContext(1, 10).some(t => t.content === sends[0]));
  for (const next of ['sleeping', 'failed', 'cancel']) {
    scenario = next;
    db.prepare('DELETE FROM behavior_deliveries').run();
    db.prepare('DELETE FROM behavior_state_resets').run();
    db.prepare('UPDATE companions SET last_proactive_sent_at=0 WHERE id=1').run();
    database.upsertSleepSchedule(1, { is_sleeping: next === 'sleeping' ? 1 : 0 });
    const at = Date.now();
    tasks.recordBehaviorDelivery({ companionId: 1, turnKey: next, plan, userText, deliveredText: '我在听。', channel: 'wechat', now: at - 120_000 });
    generated = 0;
    const count = sends.length;
    await scheduler.fixtureTick(new Date(at));
    assert.equal(sends.length, count, next + ' must not deliver');
    const row = db.prepare('SELECT status FROM behavior_followup_tasks').get();
    assert.equal(row.status, next === 'cancel' ? 'cancelled' : 'pending');
    assert.equal(generated, next === 'sleeping' ? 0 : 1);
  }
  console.log('behavior scheduler: real SQLite + complete production tick/sender, no early generation, independent due dispatch, actual sent ledger/history and no duplicate passed');
} finally {
  delete globalThis.__behaviorSchedulerIO;
  db?.close();
  rmSync(dir, { recursive: true, force: true });
}
