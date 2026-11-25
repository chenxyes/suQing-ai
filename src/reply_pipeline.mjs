/** The shared V1 generation/review boundary. It never sends or saves turns. */
import { generateReply, resolveReplySearchContext } from './ai.mjs';
import { activityAt } from './activity_time.mjs';
import { listReplyEvents } from './event_memory.mjs';
import { CHAT_FALLBACK, isChatFallback } from './chat_response.mjs';
import { isBehaviorEnabled } from './behavior_runtime.mjs';
import { buildReplyContext } from './reply_context.mjs';
import { buildReplyPersona, buildGroundedReplyPrompt } from './reply_prompt.mjs';
import { reviewGroundedReply } from './reply_review.mjs';

export function usesGroundedReplies(companion, safetyLevel = 'none') {
  return isBehaviorEnabled() && !!companion && !Number(companion.safe_mode) && safetyLevel === 'none';
}

export async function generateGroundedReply(options, { generate = generateReply, review = reviewGroundedReply, search = resolveReplySearchContext } = {}) {
  const { companion, userText, history = [], memories = [], userProfile = null, events = null,
    behaviorPlan = null, arcState = 'normal', accountId = null, probe = false, channel = 'web',
    personaFacts = [], preferences = null, dailySchedule = null, shapingHint = '',
    mode = 'reply', followup = null, relationshipEvent = null, safetyLevel = 'none', now = new Date() } = options;
  if (!usesGroundedReplies(companion, safetyLevel)) return { reply: CHAT_FALLBACK, review: { status: 'ineligible', reasons: [] } };
  const recallEnabled = !!Number(companion.memory_enabled);
  let eventRecords = recallEnabled ? events : [];
  if (eventRecords == null) {
    try { eventRecords = listReplyEvents(companion.id); }
    catch { eventRecords = []; }
  }
  const context = buildReplyContext({ userText, history, now, memories: recallEnabled ? memories : [],
    userProfile: recallEnabled ? userProfile : null, events: eventRecords, companionId: companion.id, userId: companion.user_id });
  if (context.unknown.some(item => item.id === 'current')) return { reply: CHAT_FALLBACK, review: { status: 'invalid_context', reasons: [] } };
  if (mode === 'followup') context.task = { kind: 'followup', topic: followup?.topic || '', dueAt: followup?.dueAt || null, status: 'claimed' };
  context.state = { activity: activityAt(companion, dailySchedule, now, userText), timeZone: 'Asia/Shanghai',
    mood: companion.current_mood || '平静', arcState, relationshipEvent, channel,
    shaping: String(shapingHint || '').slice(0, 1600) };
  const searchContext = mode === 'followup' ? '' : await search(context.current.text);
  if (searchContext) context.webSearch = searchContext;
  const persona = buildReplyPersona(companion, { personaFacts, preferences });
  const prompt = buildGroundedReplyPrompt(companion, { context, behaviorPlan, persona, mode, followup });
  const currentInput = mode === 'followup' ? '执行本轮已授权的跟进任务。当前没有新来信。' : context.current.text;
  const draft = await generate(prompt, context.history.map(turn => ({ role: turn.role, content: turn.text, ...(turn.at ? { created_at: turn.at } : {}) })), currentInput, {
    temperature: companion.temperature, max_tokens: companion.max_tokens, top_p: companion.top_p,
  }, { accountId, companionId: companion.id, probe, purpose: 'reply', searchContext });
  if (isChatFallback(draft)) return { reply: draft, review: { status: 'generation_failed', reasons: [] } };
  const reviewed = await review({ draft, context, companion, behaviorPlan, persona, accountId, probe,
    mode: process.env.BEHAVIOR_REVIEW_MODE === 'all' ? 'all' : 'adaptive' });
  return { reply: reviewed.reply, review: { status: reviewed.status, reasons: reviewed.reasons } };
}
