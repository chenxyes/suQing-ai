/**
 * P0–P2 回归测试：苏晴记忆连续性、日程约定对齐、时间戳去泄漏与场景照目录韧性。
 * 纯本地零网络零 LLM。
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmpDir = mkdtempSync(join(tmpdir(), 'suqing-continuity-check-'));
process.env.DB_PATH = join(tmpDir, 'test.db');
process.env.LOG_DIR = join(tmpDir, 'logs');
process.env.LOG_LEVEL = 'error';
process.env.BEHAVIOR_ENABLED = 'true';

let db;
try {
  const { buildReplyContext } = await import('../src/reply_context.mjs');
  const { activityAt } = await import('../src/activity_time.mjs');
  const { reviewGroundedReply } = await import('../src/reply_review.mjs');
  const { stripTimestampPrefix } = await import('../src/ai.mjs');
  const { resolveWritablePhotoDir } = await import('../src/photo_sender.mjs');
  const database = await import('../src/db.mjs');
  const { buildScheduleCommitmentsHint } = await import('../src/plan_tasks.mjs');

  // ── 1. P0: 当前时段内刚聊完“一起逛商场”，问“在干嘛呀”绝不能被硬覆写为“约闺蜜” ──
  const now = new Date('2026-11-28T07:32:43Z'); // 北京时间 2026-11-28 15:32
  const companion = { id: 1, user_id: 1, name: '苏晴', current_scene: '日常', scene_recorded_at: '2026-11-25 14:42:11' };
  const dailySchedule = {
    date_key: '2026-11-28',
    items: [
      { time: '14:00', activity: '约闺蜜去商场试新到的冬款外套' },
      { time: '16:00', activity: '奶茶店坐着吐槽数学作业太难' },
    ],
  };
  const activeHistory = [
    { id: 1, role: 'user', content: '到咯 走吧去选选', created_at: '2026-11-28 07:03:37' },
    { id: 2, role: 'assistant', content: '到啦！走，去挑挑看～哥哥待会儿帮我参谋参谋哪件好看', created_at: '2026-11-28 07:04:01' },
    { id: 3, role: 'assistant', content: '诶哥哥，你看那家店橱窗里那件外套，是不是有点好看', created_at: '2026-11-28 07:05:12' },
  ];
  const activeCtx = buildReplyContext({ userText: '在干嘛呀', history: activeHistory, now });
  activeCtx.state = { activity: activityAt(companion, dailySchedule, now, '在干嘛呀') };
  const keepJudge = async () => ({ text: '{"decision":"keep","reasons":[]}', finish_reason: 'stop' });
  const resActive = await reviewGroundedReply(
    { draft: '在看橱窗里那件外套呢，快进来一起挑嘛～', context: activeCtx, companion, probe: true },
    keepJudge,
  );
  assert.equal(resActive.status, 'kept');
  assert.equal(resActive.reply, '在看橱窗里那件外套呢，快进来一起挑嘛～', '当前时段有活跃逛街对话时，不得被硬覆写为约闺蜜模板');

  // 对比红验：若历史是早上的过期消息（不在 14:00 后的当前时段），仍保留计划语气兜底
  const staleHistory = [{ id: 1, role: 'assistant', content: '早上吃包子呢', created_at: '2026-11-28 00:25:43' }];
  const staleCtx = buildReplyContext({ userText: '在干嘛呀', history: staleHistory, now });
  staleCtx.state = { activity: activityAt(companion, dailySchedule, now, '在干嘛呀') };
  const resStale = await reviewGroundedReply(
    { draft: '刚试完外套歇着呢', context: staleCtx, companion, probe: true },
    keepJudge,
  );
  assert.equal(resStale.reply, '我今天 14:00 的安排是约闺蜜去商场试新到的冬款外套。', '无当前时段对话证据时仍维持原计划口径');

  // ── 2. P0: checkPersonalAnecdote 认领当前时段对话历史中已建立的动作，不再误杀 ──
  const histWithSelf = [
    ...activeHistory,
    { id: 4, role: 'assistant', content: '我刚才逛了一圈鞋店，看中一双小白鞋', created_at: '2026-11-28 07:10:00' },
  ];
  const ctxSelf = buildReplyContext({ userText: '挑中哪双啦', history: histWithSelf, now });
  ctxSelf.state = { activity: activityAt(companion, dailySchedule, now, '挑中哪双啦') };
  const resSelf = await reviewGroundedReply(
    { draft: '我刚才逛了一圈鞋店，就那双小白鞋最好看。', context: ctxSelf, companion, probe: true },
    keepJudge,
  );
  assert.equal(resSelf.status, 'kept', '当前时段历史中已提及的自述动作不应被 checkPersonalAnecdote 误截');

  // ── 3. P1: buildScheduleCommitmentsHint 注入当日约定与昨日摘要 ──
  db = database.getDb();
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO users (id, wechat_user_id) VALUES (1, 'wxu_test')").run();
  db.prepare("INSERT INTO companions (id, user_id, bot_id, name) VALUES (1, 1, 'bot1', '苏晴')").run();
  database.saveOpenLoop({
    companionId: 1,
    title: '约了这周末他陪我去挑袜子和裙子',
    loopKind: 'appointment',
    dueAt: '2026-11-28',
    emotionalWeight: 60,
  });
  database.saveMemory({
    companionId: 1,
    userId: 1,
    memoryType: 'daily_summary',
    memorySource: 'summary',
    content: '2026-11-27 日记忆：约好明天下午一起逛街挑裙子，逛完吃漂亮饭。',
    importance: 8,
  });
  const hint = buildScheduleCommitmentsHint(1, 1, '2026-11-28', { isWeekend: true });
  assert.ok(hint.includes('约了这周末他陪我去挑袜子和裙子'), '日程约束必须包含当日到期约定');
  assert.ok(hint.includes('绝不要在同一时段凭空编造'), '日程约束必须包含防冲突规则');
  assert.ok(hint.includes('逛完吃漂亮饭'), '日程约束应携带昨日日记忆上下文');

  // ── 4. P2: stripTimestampPrefix 清洗单段及多段 || 水印，不误伤正文 ──
  assert.equal(
    stripTimestampPrefix('[北京时间 2026-11-28 14:36] 好啦好啦，随时能出门～'),
    '好啦好啦，随时能出门～',
  );
  assert.equal(
    stripTimestampPrefix('[北京时间 2026-11-28 14:36] [北京时间 2026-11-28 14:37] 到啦！ || 【北京时间 2026-11-28 14:38】走吧～'),
    '到啦！ || 走吧～',
  );
  assert.equal(stripTimestampPrefix('普通消息保持不变'), '普通消息保持不变');

  // ── 5. P2: resolveWritablePhotoDir 在主目录不可写时降级到可写备选目录 ──
  const readonlyParent = join(tmpDir, 'readonly_root');
  const fallbackScenes = join(tmpDir, 'fallback_scenes');
  mkdirSync(readonlyParent, { recursive: true });
  chmodSync(readonlyParent, 0o555);
  try {
    const chosen = resolveWritablePhotoDir(join(readonlyParent, 'scenes'), fallbackScenes);
    assert.equal(chosen, fallbackScenes, '主目录只读/无权限时应降级到可写备选目录');
  } finally {
    chmodSync(readonlyParent, 0o755);
  }

  console.log('suqing_memory_continuity_check: all P0-P2 assertions passed');
} finally {
  db?.close();
  rmSync(tmpDir, { recursive: true, force: true });
}
