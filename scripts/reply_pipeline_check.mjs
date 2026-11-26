import assert from 'node:assert/strict';
import { generateGroundedReply, usesGroundedReplies } from '../src/reply_pipeline.mjs';
import { CHAT_FALLBACK } from '../src/chat_response.mjs';

process.env.BEHAVIOR_ENABLED = 'true';
const companion = { id: 2, user_id: 3, name: '苏晴', age: 24, memory_enabled: 1, relationship_stage: '恋人', first_love: 1,
  personality_tags: ['安静', '直接'], hobbies: ['摄影'], no_pressure: true, reply_length: '简短(1-2句)',
  persona_prompt: '喜欢雨天，表达自然。', max_tokens: 400 };
const options = { companion, userText: '味道还不错', events: [],
  history: [{ id: 1, role: 'user', content: '今晚吃了番茄面' }, { id: 2, role: 'assistant', content: '自己煮的还是买的？' }],
  memories: [{ id: 1, companion_id: 2, user_id: 3, content: '不可靠的历史摘要', memory_type: 'daily_summary' }],
  shapingHint: '询问就直接问，不追加训话。' };
let generations = 0, reviews = 0;
const result = await generateGroundedReply(options, {
  search: async () => '检索资料：番茄面',
  generate: async (system, history, input, params, ctx) => {
    generations++;
    assert.equal(input, options.userText);
    assert.deepEqual(history, options.history.map(({ role, content }) => ({ role, content })));
    assert.ok(!system.includes('不可靠的历史摘要'));
    assert.ok(!system.includes(options.userText), 'current input is not duplicated in the system prompt');
    assert.ok(!system.includes('自己煮的还是买的'), 'history is passed as actual role messages, not repeated in system');
    for (const fragment of ['苏晴', '摄影', '喜欢雨天', '询问就直接问']) assert.ok(system.includes(fragment));
    assert.ok(!system.includes('最突出的特质之一'), 'legacy persona narrative is replaced');
    assert.equal(ctx.companionId, companion.id);
    assert.equal(ctx.purpose, 'reply');
    assert.equal(ctx.searchContext, '检索资料：番茄面');
    assert.equal(params.max_tokens, 400);
    return '那看来是买对了。';
  },
  review: async ({ draft, context, persona }) => {
    reviews++;
    assert.equal(draft, '那看来是买对了。');
    assert.equal(context.current.text, options.userText);
    assert.equal(context.history[1].role, 'assistant');
    assert.equal(context.facts.length, 0, 'unanswered choice and summary cannot become user facts');
    assert.equal(persona.name, '苏晴');
    assert.equal(context.webSearch, '检索资料：番茄面');
    assert.equal(context.state.shaping, options.shapingHint);
    return { reply: '好吃就好。', status: 'revised', reasons: ['unsupported_fact'] };
  },
});
assert.equal(result.reply, '好吃就好。');
assert.deepEqual(result.review, { status: 'revised', reasons: ['unsupported_fact'] });
assert.equal(generations, 1); assert.equal(reviews, 1);

const degraded = await generateGroundedReply(options, {
  generate: async () => '那看来是买对了。',
  review: async () => ({ reply: CHAT_FALLBACK, status: 'fallback', reasons: ['review_timeout'] }),
});
assert.equal(degraded.reply, CHAT_FALLBACK, 'a failed review cannot publish the original draft');
const failedDraft = await generateGroundedReply(options, {
  generate: async () => CHAT_FALLBACK,
  review: async () => { throw Error('review must not run after failed generation'); },
});
assert.equal(failedDraft.review.status, 'generation_failed');
await generateGroundedReply({ ...options, userText: '', mode: 'followup', followup: { topic: '30分钟后再问我', dueAt: 123 } }, {
  generate: async (system, history, input) => {
    assert.ok(system.includes('30分钟后再问我'));
    assert.ok(input.includes('没有新来信'));
    return '现在愿意聊聊吗？';
  },
  review: async ({ context, draft }) => {
    assert.equal(context.current.text, '');
    assert.equal(context.task.kind, 'followup');
    assert.equal(context.task.topic, '30分钟后再问我');
    return { reply: draft, status: 'kept', reasons: [] };
  },
});
assert.equal(usesGroundedReplies(companion), true);
assert.equal(usesGroundedReplies({ ...companion, safe_mode: 1 }), false);
assert.equal(usesGroundedReplies(companion, 'medium'), false);
await generateGroundedReply({ ...options, companion: { ...companion, memory_enabled: 0 },
  events: [{ id: 4, title: '私密约定', status: 'open' }], userProfile: { user_name: '私密资料' } }, {
  generate: async () => '嗯。',
  review: async ({ context, draft }) => {
    assert.equal(context.events.length, 0);
    assert.equal(context.facts.length, 0);
    return { reply: draft, status: 'kept', reasons: [] };
  },
});
process.env.BEHAVIOR_ENABLED = 'false';
assert.equal(usesGroundedReplies(companion), false);
console.log('reply pipeline: one evidence packet, bounded generation/review, persona, source separation, followup and fail-closed passed');
