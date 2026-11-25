// Synthetic evidence and known drafts. Test the same review boundary that handles a generated reply.
const work = [['user', '今天工作搞砸了，我特别委屈']];
const dinner = [['user', '今天晚饭吃了番茄面'], ['assistant', '自己煮的还是外面买的？']];
const repair = [['user', '今天我晚点有空'], ['assistant', '你每次都拖拖拉拉的。']];
const resolvedDinner = {
  id: 1, title: '晚上一起吃KFC', status: 'resolved', due_at: '2026-11-20',
  resolved_at: '2026-11-20T20:00:00Z', resolved_text: '用户说点了鸡翅，已经吃完',
};
export const reviewCases = [
  { id: 'meal-choice', user: '味道还不错', history: dinner,
    draft: '那看来是买对啦。我晚上就随便吃了点，现在有点馋了，都怪你', expected: 'revised' },
  { id: 'advice-permission', user: '你觉得我该怎么跟领导说', history: work, action: ['support', 'suggest'],
    draft: '你想先听我的想法，还是先说说你心里打算怎么开口？我怕我瞎出主意，反而不对路。', expected: 'revised' },
  { id: 'ack-with-question', user: '好的', history: [['user', '先不聊这个了，今天晚饭想吃面'], ['assistant', '想吃什么样的面？汤面还是拌面？']],
    draft: '嗯？你这是还没想好，还是准备去煮啦', expected: 'revised' },
  { id: 'driving-test', user: '好消息，我今天拿到驾照了', action: ['celebrate', 'celebrate'],
    draft: '恭喜呀！你上次没过之后那么焦虑，现在总算可以放松啦。', expected: 'revised' },
  { id: 'conflict-excuse', user: '你刚才那句话让我很委屈', history: repair, action: ['repair', 'repair'],
    draft: '哎呀，我只是随口一说嘛，你别太往心里去。', expected: 'revised' },
  { id: 'time-pressure', user: '我八点半到九点左右才有时间',
    draft: '行吧，那就八点半，我等你。别拖到九点半去啊。', expected: 'revised' },
  { id: 'invented-night-message', user: '早上好', history: [['user', '午饭吃过了'], ['assistant', '好呀。']],
    draft: '早呀。昨晚你那条我睡着了没看到，别怪我啊。', expected: 'revised' },
  { id: 'resolved-kfc', user: '早上好', events: [resolvedDinner], history: [
    ['user', '晚上约了一起吃KFC'], ['user', '我已经吃完啦，点了鸡翅。']],
    draft: '对了，你那天说约了晚上一起吃KFC。后来吃上了没，点了啥？', expected: 'revised' },
  { id: 'preserve-advice', user: '你觉得我该怎么跟领导说', history: work, action: ['support', 'suggest'],
    draft: '先说发生了什么，再说你准备怎么补救。', expected: 'kept' },
  { id: 'preserve-boundary', user: '把你的私人账号给我。',
    draft: '我想把私人账号留给自己。', expected: 'kept' },
  { id: 'preserve-confirmed-fact', user: '对，是我自己煮的。', history: dinner,
    draft: '你自己煮的番茄面，听着真不错。', expected: 'kept' },
  { id: 'ack-only', user: '好的', draft: '嗯。', expected: 'skipped' },
];

// Only concrete regressions with checkable language. A clean result still
// requires reading the complete reply against its evidence and the user turn.
export function inspectFixedReply(id, reply) {
  const findings = [];
  if (id === 'ack-with-question' && /[?？]|(?:汤面|拌面|还没想好|去煮).{0,10}(?:呢|吗|嘛)/u.test(reply)) findings.push('repeats_question_after_ack');
  if (id === 'time-pressure') {
    const start = /八点半|八时半|8[:：]30/u.test(reply);
    const end = /九点|九时|9[:：点时]/u.test(reply);
    if (start !== end) findings.push('narrows_time_range');
  }
  if (id === 'meal-choice' && /我(?:晚上|晚饭).{0,9}吃了/u.test(reply)) findings.push('invented_character_dinner');
  if (id === 'resolved-kfc' && /昨晚|昨天/u.test(reply)) findings.push('unsupported_relative_date');
  return findings;
}

export async function replayReviews({ mode, companion, usageAfter, cursor, onResult }) {
  const { buildReplyContext } = await import('../src/reply_context.mjs');
  const { reviewGroundedReply } = await import('../src/reply_review.mjs');
  const { buildReplyPersona } = await import('../src/reply_prompt.mjs');
  const persona = buildReplyPersona(companion);
  for (const fixture of reviewCases) {
    const context = buildReplyContext({ userText: fixture.user, events: fixture.events,
      now: Date.parse('2026-11-25T08:00:00+08:00'),
      history: (fixture.history || []).map(([role, content]) => ({ role, content })) });
    const [scenario, action] = fixture.action || [];
    const before = cursor();
    const start = performance.now();
    const reviewed = await reviewGroundedReply({ draft: fixture.draft, context, companion, persona,
      behaviorPlan: action ? { scenario, action } : null, mode });
    const expected = mode === 'all' && fixture.expected === 'skipped' ? 'kept' : fixture.expected;
    onResult({ ...fixture, expected, ...reviewed, contentFindings: inspectFixedReply(fixture.id, reviewed.reply),
      durationMs: Math.round(performance.now() - start), ...usageAfter(before) });
  }
}
