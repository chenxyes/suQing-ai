/** Explicitly requested fictional relationship scenes; never real shared history. */
import { log } from './logger.mjs';
import { getCompanionBackfillStatus, getMemoryRecallBarrier, saveSyntheticHistory } from './db.mjs';
import { extractStructuredInfo } from './ai.mjs';

function buildBackfillPrompt(companion, { daysBack, eventCount, minDaysAgo }) {
  let personality = '', hobbies = '';
  try { personality = JSON.parse(companion.personality_tags || '[]').join('、'); } catch {}
  try { hobbies = JSON.parse(companion.hobbies || '[]').join('、'); } catch {}
  return `为虚拟角色创作明确标注为虚构的互动设定。这些片段没有真实发生，不是对方的真实陈述，也不能作为共同经历或对方事实的证据。
仅追加虚构设定，不覆盖真实聊天或角色原有背景，不改变真实关系和情绪数值。

【角色原有背景】
姓名：${companion.name}
年龄：${companion.age || 22}
身份：${companion.role_title || '邻家女孩'}
性格：${personality || '温柔'}
爱好：${hobbies || '阅读、音乐'}
相遇设定：${companion.how_met || '未设定'}

【虚构创作边界】
最多 ${eventCount} 个事件，days_ago 必须是 ${minDaysAgo} 到 ${daysBack} 之间的不重复整数，hour 是 0 到 23 的整数。
每个事件 1 到 3 条片段，只能使用 user 或 assistant 角色，每种角色最多 2 条。user 也是虚构台词，不能当成真实对方说过的话。
每条 content 为 1 到 400 字，topic 为 1 到 100 字；memorable 为布尔值。不输出亲密度或情绪数值。
按 days_ago 从大到小排列。不得编造真实身份、隐私或安全判定证据。不要 emoji 或动作旁白。

严格只输出 JSON，无注释或围栏：
{"events":[{"days_ago":${minDaysAgo},"hour":12,"topic":"虚构的雨天闲聊","memorable":true,"turns":[{"role":"assistant","content":"这是虚构设定中的一句台词。"}]}]}`;
}

function validEvents(events, { daysBack, eventCount, minDaysAgo }) {
  if (!Array.isArray(events) || !events.length || events.length > eventCount) return false;
  const days = new Set();
  for (const event of events) {
    if (!event || !Number.isInteger(event.days_ago) || event.days_ago < minDaysAgo || event.days_ago > daysBack
      || days.has(event.days_ago) || !Number.isInteger(event.hour) || event.hour < 0 || event.hour > 23
      || typeof event.topic !== 'string' || !event.topic.trim() || event.topic.length > 100
      || (event.memorable != null && typeof event.memorable !== 'boolean')
      || !Array.isArray(event.turns) || !event.turns.length || event.turns.length > 3) return false;
    days.add(event.days_ago);
    const roles = { user: 0, assistant: 0 };
    for (const turn of event.turns) {
      if (!turn || !['user', 'assistant'].includes(turn.role) || ++roles[turn.role] > 2
        || typeof turn.content !== 'string' || !turn.content.trim() || turn.content.length > 400) return false;
    }
  }
  return true;
}

export async function backfillTimelineForCompanion(companion, opts = {}) {
  // This gate must precede DB reads and every model invocation, including force.
  if (opts.confirmSynthetic !== true) return { skipped: 'confirmation-required' };
  if (!companion?.id || companion.user_id == null) return { error: 'invalid-companion' };
  if (opts.tier != null && !['thin', 'full'].includes(opts.tier)) return { error: 'invalid-options' };
  if ([opts.daysBack, opts.eventCount].some(value => value != null && !Number.isSafeInteger(value))) return { error: 'invalid-options' };
  const tier = opts.tier === 'thin' ? 'thin' : 'full';
  const force = opts.force === true;
  const status = getCompanionBackfillStatus(companion.id);
  if (status?.backfilledAt && !force && (status.tier === 'full' || status.tier === tier)) {
    return { skipped: 'already-backfilled', backfilledAt: status.backfilledAt, tier: status.tier };
  }
  const daysBack = tier === 'thin' ? 7 : Math.max(30, Math.min(180, opts.daysBack ?? 90));
  const minDaysAgo = tier === 'thin' ? 1 : status?.tier === 'thin' ? 8 : 3;
  const eventCount = Math.min(daysBack - minDaysAgo + 1, tier === 'thin' ? 6 : Math.max(20, Math.min(60, opts.eventCount ?? 35)));
  const bounds = { daysBack, minDaysAgo, eventCount };
  const { revision } = getMemoryRecallBarrier(companion.id, companion.user_id);
  let parsed;
  try {
    const raw = await extractStructuredInfo('仅创作虚构互动设定，只输出 JSON。', buildBackfillPrompt(companion, bounds),
      { maxTokens: 6000, temperature: 0.85, accountId: opts.accountId ?? null });
    parsed = JSON.parse(String(raw || '').trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, ''));
  } catch {
    log('warn', '[Backfill] fictional generation failed companion=' + companion.id);
    return { error: 'generation-failed' };
  }
  if (!validEvents(parsed?.events, bounds)) return { error: 'invalid-events' };
  const now = Date.now(), turns = [], memoryEvents = [];
  for (const event of parsed.events) {
    const date = new Date(now - event.days_ago * 86400_000);
    date.setUTCHours(event.hour, 0, 0, 0);
    event.turns.forEach((turn, index) => turns.push({
      created_at: new Date(date.getTime() + index * 30_000).toISOString().replace('T', ' ').slice(0, 19),
      role: turn.role, content: turn.content.trim(), topic: event.topic.trim(),
    }));
    if (event.memorable === true) memoryEvents.push({
      content: '虚构互动：' + event.topic.trim() + '（设定为 ' + event.days_ago + ' 天前）', importance: 5,
    });
  }
  turns.sort((a, b) => a.created_at.localeCompare(b.created_at));
  try {
    const stored = saveSyntheticHistory({ companionId: companion.id, userId: companion.user_id,
      tier, turns, memoryEvents, expectedRecallRevision: revision, force });
    if (!stored) return { skipped: 'stale-or-duplicate' };
    log('info', '[Backfill] fictional append companion=' + companion.id + ' tier=' + tier + ' turns=' + stored.turnCount + ' memories=' + stored.memoryCount);
    return { ok: true, ...stored, daysBack, eventCount: parsed.events.length, synthetic: true };
  } catch {
    log('warn', '[Backfill] fictional append failed companion=' + companion.id);
    return { error: 'storage-failed' };
  }
}

/** Compatibility exports: creation, binding and message counts never opt in. */
export function decideBackfillAction() { return null; }
export function maybeAutoBackfill() { return { skipped: 'automatic-disabled' }; }
