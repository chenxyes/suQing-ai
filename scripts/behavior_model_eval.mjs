#!/usr/bin/env node
// Opt-in real-model replay through the web chat entry point, with synthetic data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const scenarios = [
  { id: 'support', turns: [
    ['今天工作搞砸了，我特别委屈', 'support'],
    ['嗯', 'support'],
    ['你觉得我该怎么跟领导说', 'support', 'suggest'],
    ['先不聊这个了，今天晚饭想吃面', 'pause'],
    ['好的', null],
  ] },
  { id: 'celebrate', turns: [
    ['好消息，我今天拿到驾照了', 'celebrate'],
    ['谢谢', 'celebrate'],
    ['今晚我准备煮番茄面', null],
  ] },
  { id: 'repair', seed: [
    ['user', '今天我晚点有空'], ['assistant', '你每次都拖拖拉拉的。'],
  ], turns: [
    ['你刚才那句话让我很委屈', 'repair'],
    ['我只是想按自己的时间安排，不想被你催', 'repair'],
    ['别再问这件事了', 'pause'],
    ['嗯', null],
  ] },
  { id: 'ordinary', turns: [
    ['今天晚饭吃了番茄面', null],
    ['味道还不错', null],
    ['我八点半到九点左右才有时间', null],
  ] },
];
const args = process.argv.slice(2);
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const selected = value('--scenario') ? scenarios.filter(s => s.id === value('--scenario')) : scenarios;
const variant = value('--variant') || 'both';
if (!selected.length || !['on', 'off', 'both'].includes(variant)) throw Error('invalid evaluation scenario or variant');
if (args.includes('--dry-run')) {
  console.log(JSON.stringify({ variant, scenarios: selected }, null, 2));
  process.exit(0);
}
const output = value('--output');
if (!output || output.startsWith('--')) throw Error('pass --output with a report path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'suqing-behavior-model-'));
Object.assign(process.env, {
  DB_PATH: path.join(directory, 'test.db'), LOG_DIR: path.join(directory, 'logs'), LOG_LEVEL: 'error',
  INNER_OS_ENABLED: 'true', INNER_OS_MODE: 'always', SEARCH_PROVIDER: '',
});
delete process.env.BEHAVIOR_LIBRARY_DIR;
const report = { createdAt: new Date().toISOString(), fixture: 'synthetic-adult-web', usageScope: 'ai_usage_events only; excludes existing direct provider calls such as pressure-tail review; latency includes the full request', scenarios: [], findings: [] };
let db;
try {
  const database = await import('../src/db.mjs');
  db = database.getDb();
  const { REGISTRY, getActiveChatProvider } = await import('../src/providers/chat.mjs');
  // Optional read-only settings source. Copy only chat-provider settings into this
  // process; production tables, credentials and conversation history stay out of reports.
  const settingsPath = value('--settings-db');
  if (settingsPath) {
    const { default: Database } = await import('better-sqlite3');
    const source = new Database(settingsPath, { readonly: true, fileMustExist: true });
    try {
      const setting = key => source.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value;
      const provider = setting('CHAT_PROVIDER') || process.env.CHAT_PROVIDER || 'deepseek';
      const entry = REGISTRY[provider.toLowerCase()];
      if (!entry) throw Error('unsupported chat provider');
      for (const key of ['CHAT_PROVIDER', 'CHAT_MODEL', entry.apiKeyEnv, entry.baseURLEnv, entry.modelEnv].filter(Boolean)) {
        const stored = setting(key);
        if (stored) process.env[key] = stored;
      }
    } finally { source.close(); }
  }
  report.provider = getActiveChatProvider();
  const { playgroundChat } = await import('../src/playground.mjs');
  const { setUserSchedule } = await import('../src/sleep.mjs');
  const { isChatFallback } = await import('../src/chat_response.mjs');
  const modes = variant === 'both' ? ['off', 'on'] : [variant];
  let id = 0;
  for (const scenario of selected) {
    for (const mode of modes) {
      process.env.BEHAVIOR_ENABLED = String(mode === 'on');
      id++;
      db.prepare('INSERT INTO users(id,wechat_user_id) VALUES(?,?)').run(id, 'model-eval-' + id);
      db.prepare(`INSERT INTO companions(id,user_id,bot_id,name,age,memory_enabled,proactive_enabled,no_pressure,
        relationship_stage,affection_level,temperature,max_tokens,reply_length,persona_prompt)
        VALUES(?,?,'evaluation','苏晴',24,0,0,1,'恋人',65,0.6,400,'简短(1-2句)',?)`)
        .run(id, id, '自然简短地聊天。关心时直接问，不在句尾追加催促或说教。尊重对方给出的时间范围。');
      setUserSchedule(id, { enabled: false });
      for (const [role, content] of scenario.seed || []) database.saveConversationTurn(id, role, content);
      const result = { scenario: scenario.id, mode, turns: [] };
      report.scenarios.push(result);
      for (const [user, expectedScenario, expectedAction] of scenario.turns) {
        const usageBefore = db.prepare('SELECT COALESCE(max(id),0) id FROM ai_usage_events').get().id;
        const deliveryBefore = db.prepare('SELECT COALESCE(max(id),0) id FROM behavior_deliveries').get().id;
        const started = performance.now();
        const response = await playgroundChat(database.getCompanionById(id), user);
        await new Promise(resolve => setImmediate(resolve));
        const usage = db.prepare(`SELECT count(*) loggedCalls,COALESCE(sum(prompt_tokens),0) inputTokens,
          COALESCE(sum(completion_tokens),0) outputTokens FROM ai_usage_events WHERE id>?`).get(usageBefore);
        const delivery = db.prepare('SELECT plan_json FROM behavior_deliveries WHERE companion_id=? AND id>? ORDER BY id DESC LIMIT 1').get(id, deliveryBefore);
        const plan = delivery ? JSON.parse(delivery.plan_json) : null;
        const reset = db.prepare('SELECT 1 FROM behavior_state_resets WHERE companion_id=?').get(id);
        const observed = plan?.scenario || (expectedScenario === 'pause' && reset ? 'pause' : null);
        const findings = [];
        if (isChatFallback(response.reply) || !response.reply) findings.push('generation_failed');
        if (/\b(?:scenario|sourceRevision|sourceId|behavior)\s*[":：]|本轮相处行动|goutoujunshi/.test(response.reply)) findings.push('internal_metadata');
        if (mode === 'on' && observed !== expectedScenario) findings.push('scenario_mismatch');
        if (mode === 'on' && expectedAction && plan?.action !== expectedAction) findings.push('action_mismatch');
        const turn = { user, reply: response.reply, expectedScenario, plan, durationMs: Math.round(performance.now() - started), ...usage, findings };
        result.turns.push(turn);
        for (const finding of findings) report.findings.push({ scenario: scenario.id, mode, turn: result.turns.length, finding });
        console.log(JSON.stringify({ scenario: scenario.id, mode, turn: result.turns.length, durationMs: turn.durationMs, findings }));
        fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        if (findings.includes('generation_failed')) throw Error('model generation failed');
      }
    }
  }
  report.backgroundTasks = db.prepare('SELECT count(*) n FROM behavior_followup_tasks').get().n;
  if (report.backgroundTasks) report.findings.push({ finding: 'unexpected_web_followup' });
  report.summary = Object.fromEntries(modes.map(mode => {
    const turns = report.scenarios.filter(s => s.mode === mode).flatMap(s => s.turns);
    const durations = turns.map(t => t.durationMs).sort((a, b) => a - b);
    const sum = key => turns.reduce((total, turn) => total + turn[key], 0);
    return [mode, { turns: turns.length, loggedCalls: sum('loggedCalls'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
      meanLatencyMs: Math.round(sum('durationMs') / turns.length), p95LatencyMs: durations[Math.ceil(durations.length * .95) - 1] }];
  }));
  console.log(JSON.stringify({ provider: report.provider, summary: report.summary, findings: report.findings }));
  process.exitCode = report.findings.length ? 1 : 0;
} catch (error) {
  report.error = { name: error.name };
  console.error('behavior model evaluation failed (' + error.name + ')');
  process.exitCode = 1;
} finally {
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  db?.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
