import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/companion.mjs';
import { generateGroundedReply } from '../src/reply_pipeline.mjs';
import { reviewGroundedReply } from '../src/reply_review.mjs';
import { buildReplyContext } from '../src/reply_context.mjs';
import { activityAt } from '../src/activity_time.mjs';

process.env.BEHAVIOR_ENABLED = 'true';
const base = { id: 12, name: '苏晴', current_scene: '第一节英语课', scene_recorded_at: '2026-11-18 00:05:00' };
const dailySchedule = { date_key: '2026-11-18', items: [
  { time: '18:05', activity: '晚间整理书包' }, { time: '08:00', activity: '早读背单词' },
  { time: '10:00', activity: '数学课订正错题' }, { time: '12:10', activity: '食堂吃午饭' },
] };
const history = [{ id: 1, role: 'assistant', content: '我在早读。', created_at: '2026-11-18 00:01:02' }];
for (const [iso, expected] of [
  ['2026-11-18T02:59:00Z', '数学课订正错题'], ['2026-11-18T04:10:00Z', '食堂吃午饭'],
  ['2026-11-18T11:00:00Z', '晚间整理书包'], ['2026-11-18T16:01:00Z', null],
]) {
  const now = new Date(iso);
  for (const promptMode of ['reply', 'proactive']) {
    const prompt = buildSystemPrompt(base, { now, dailySchedule, promptMode, recentTurns: history });
    assert.ok(!prompt.includes(base.current_scene), iso + ': stale stored scene');
    assert.ok(!prompt.includes('✓ 是已经做过的'));
    if (expected) assert.ok(prompt.includes(expected));
    assert.ok(!prompt.includes('早读背单词'), iso + ': morning plan in ordinary prompt');
    if (expected !== '食堂吃午饭') assert.ok(!prompt.includes('食堂吃午饭'));
    assert.ok(prompt.includes('2026-11-18 08:01'), 'timestamp of the historical message');
  }
  let generation = false, review = false;
  await generateGroundedReply({ companion: base, dailySchedule, history, userText: '你在做什么？', now }, {
    search: async () => '',
    generate: async (system, turns) => {
      generation = true;
      if (expected) assert.ok(system.includes(expected));
      assert.ok(!system.includes('早读背单词') && !system.includes('第一节英语课'));
      if (expected !== '食堂吃午饭') assert.ok(!system.includes('食堂吃午饭'));
      assert.equal(turns[0].created_at, history[0].created_at);
      return '在呢。';
    },
    review: async ({context, persona, draft}) => {
      review = true;
      const payload = JSON.stringify([context.state, persona]);
      if (expected) assert.ok(payload.includes(expected));
      assert.ok(!payload.includes('早读背单词'));
      return {reply: draft, status: 'kept', reasons: []};
    },
  });
  assert.ok(generation && review);
}
const now = new Date('2026-11-18T11:00:00Z');
const plan = buildSystemPrompt(base, { dailySchedule, now, userText: '你今天有哪些安排？' });
assert.ok(plan.includes('早读背单词') && plan.includes('晚间整理书包'), 'preserve whole-day plan on request');
for (const scene_recorded_at of [null, 'bad', '2026-11-18 11:25:00']) {
  assert.ok(!buildSystemPrompt({...base, scene_recorded_at}, {dailySchedule, now}).includes(base.current_scene));
}

const review = async (input, draft, extra = {}, prior = history) => {
  const context = buildReplyContext({ userText: input, history: prior, now });
  context.state = {activity: activityAt({...base,...extra}, dailySchedule, now, input)};
  return (await reviewGroundedReply({draft, context, companion:base, probe:true},
    async () => ({ text: '{"decision":"keep","reasons":[]}', finish_reason: 'stop' }))).reply;
};
assert.equal(await review('你现在在干嘛？', '刚整理完作业本，在宿舍歇一会儿。'), '我今天 18:05 的安排是晚间整理书包。');
assert.equal(await review('你现在在干嘛？', '还没开始呢。'), '我今天 18:05 的安排是晚间整理书包。');
const arrival = '我已经到教室了，早读铃快响了。';
assert.equal(await review('还没到啊？', arrival), '你是说到哪儿？');
const recent = [{role:'user',content:'我在等快递',created_at:'2026-11-18 10:55:00'}];
assert.equal(await review('还没到啊？', '快递进度我也不清楚。', {}, recent), '快递进度我也不清楚。');
for (const query of ['你现在在干嘛？顺便帮我看看作业。','中午原本安排了什么？','你觉得我现在该做什么？','做什么？']) {
  assert.equal(await review(query, '可以聊聊。'), '可以聊聊。');
}

console.log('Activity time: dated history, schedule, scenes, generation and review passed.');
