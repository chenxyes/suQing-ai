import assert from 'node:assert/strict';
import { buildReplyContext } from '../src/reply_context.mjs';

const scope = { companionId: 4, userId: 9 };
const memory = (id, fields = {}) => ({ id, companion_id: 4, user_id: 9, memory_status: 'active',
  memory_type: 'fact', memory_layer: 'user_fact', memory_origin: 'conversation', memory_subject: 'user',
  content: '不能因为模型改写内容而多出买面事实', created_at: '2026-11-24 07:00:00',
  memory_evidence: JSON.stringify([{ turn_id: id + 100, role: 'user', quote: '我今晚吃了番茄面。' }]), ...fields });

// A fact must be the attributed source assertion, never a free-form model paraphrase.
const proven = buildReplyContext({ ...scope, userText: '味道还不错', memories: [memory(1)] });
assert.equal(proven.facts.length, 1);
assert.equal(proven.facts[0].text, '我今晚吃了番茄面。');
assert.equal(proven.facts[0].subject, 'user');
assert.equal(proven.facts[0].id, 'memory:1');
assert.equal(proven.facts[0].evidence[0].turn_id, 101);
assert.equal(proven.current.text, '味道还不错');
assert.ok(!JSON.stringify(proven).includes('不能因为模型改写'));

const mixed = buildReplyContext({ ...scope, userText: '味道还不错', history: [
  { id: 1, role: 'user', content: '今天晚饭吃了番茄面' },
  { id: 2, role: 'assistant', content: '自己煮的还是外面买的？' },
  { id: 3, role: 'user', content: '嗯' },
  { id: 4, direction: 'out', content: '你之前练车很辛苦。' },
  { id: 5, role: 'assistant', content: '合成历史不能作事实', synthetic: 1 },
  { id: 6, role: 'user', content: '未知导入不作事实', import_unverified: 1 },
  { id: 7, content: '无归属不默认当用户' },
] });
assert.deepEqual(mixed.history.map(t => t.role), ['user', 'assistant', 'user', 'assistant']);
assert.equal(mixed.history[1].text, '自己煮的还是外面买的？');
assert.equal(mixed.facts.length, 0, 'questions, acknowledgments and assistant guesses remain utterances');
assert.ok(!JSON.stringify(mixed).includes('合成历史不能作事实'));
assert.ok(!JSON.stringify(mixed).includes('未知导入不作事实'));

const rejected = buildReplyContext({ ...scope, userText: '继续', memories: [
  memory(2, { memory_status: 'deleted' }), memory(3, { memory_status: 'contradicted' }),
  memory(4, { do_not_mention: 1 }), memory(5, { recall_blocked: 1 }),
  memory(6, { memory_origin: 'synthetic' }), memory(7, { memory_source: 'synthetic' }),
  memory(8, { memory_layer: 'summary' }), memory(9, { memory_type: 'daily_summary' }),
  memory(10, { memory_subject: 'unknown' }), memory(11, { memory_evidence: null }),
  memory(12, { memory_evidence: '{broken' }),
  memory(13, { memory_evidence: [{ turn_id: 9, role: 'assistant', quote: '我今晚吃了番茄面。' }] }),
  memory(14, { companion_id: 40 }), memory(15, { user_id: 90 }),
  memory(16, { source_memory_ids: '[2]' }), memory(17, { source_memory_ids: 'not-json' }),
  memory(18, { memory_evidence: [{ turn_id: 8, role: 'user', quote: '如果我买了番茄面，我会告诉你。' }] }),
  memory(19, { memory_evidence: [{ turn_id: 9, role: 'user', quote: '你说我买了番茄面。' }] }),
] });
assert.equal(rejected.facts.length, 0, 'unproven, revoked, synthetic and foreign evidence cannot become facts');
assert.ok(rejected.unknown.every(item => typeof item.id === 'string' && typeof item.reason === 'string'));
assert.ok(!JSON.stringify(rejected).includes('我今晚吃了番茄面'), 'rejected evidence is not copied through diagnostics');

const actors = buildReplyContext({ ...scope, memories: [
  memory(20, { memory_subject: 'companion', memory_evidence: [{ turn_id: 200, role: 'assistant', quote: '我喜欢蓝色。' }] }),
  memory(21, { memory_subject: 'shared', memory_evidence: [
    { turn_id: 201, role: 'user', quote: '我们周六再聊。' },
    { turn_id: 202, role: 'assistant', quote: '我们周六再聊。' },
  ] }),
  memory(22, { memory_subject: 'shared', memory_evidence: [{ turn_id: 203, role: 'assistant', quote: '我们周六再聊。' }] }),
] });
assert.deepEqual(actors.facts.map(f => f.subject), ['companion', 'shared']);
assert.deepEqual(actors.facts[1].evidence.map(e => e.role), ['user', 'assistant']);

const profile = buildReplyContext({ userProfile: { user_name: '小陈', user_hobbies: ['游泳'],
  important_dates: [{ label: '纪念日', date: '11-24' }], notes: '我不吃辣。', password: 'never-copy' } });
assert.ok(profile.facts.every(f => f.kind === 'profile' && f.subject === 'user' && f.id.startsWith('profile:')));
assert.ok(profile.facts.some(f => f.text.includes('小陈')));
assert.ok(!JSON.stringify(profile).includes('never-copy'));

const input = { ...scope, userText: '我八点半到九点左右才有时间', now: Date.parse('2026-11-24T08:00:00Z'), events: [
  { id: 1, companion_id: 4, title: '约好昨天吃饭', status: 'open', due_at: '2026-11-23', source_message_id: 'msg-1' },
  { id: 2, companion_id: 4, title: '吃过KFC', status: 'resolved', due_at: '2026-11-23', resolved_at: '2026-11-23 12:00:00', resolved_text: '吃上了' },
  { id: 3, companion_id: 4, title: '周末计划', status: 'dismissed' },
  { id: 4, companion_id: 4, title: '今晚吃饭', status: 'open', due_at: '2026-11-24' },
  { id: 5, companion_id: 40, title: 'another companion event', status: 'open' },
] };
const snapshot = JSON.stringify(input);
const events = buildReplyContext(input);
assert.equal(events.current.text, '我八点半到九点左右才有时间');
assert.deepEqual(events.events.map(e => e.status), ['open', 'resolved', 'dismissed', 'open']);
assert.equal(events.events[0].overdue, true);
assert.equal(events.events[3].overdue, false, 'date-only due time includes the stated Shanghai day');
assert.equal(events.events[1].resolvedText, '吃上了');
assert.equal(events.facts.length, 0, 'an event register is not a confirmed user assertion or permission to contact');
const privateEvent = buildReplyContext({ events: [{id:1, title:'吃饭', status:'resolved', resolved_text:'已吃过，密码是fake-fixture'}] });
assert.equal(privateEvent.events[0].resolvedText, '', 'legacy event outcomes are filtered before reaching either model');
assert.equal(JSON.stringify(input), snapshot, 'context construction is pure');

const bounded = buildReplyContext({ userText: 'x'.repeat(9000), history: Array.from({ length: 1000 }, (_, id) =>
  ({ id: id + 1, role: 'user', content: 'x'.repeat(3000) })), memories: Array.from({ length: 1000 }, (_, i) => memory(i + 1000, { memory_type: 'x'.repeat(10000) })) });
assert.ok(JSON.stringify(bounded).length < 60000, 'inputs cannot create an unbounded model payload');
assert.ok(bounded.unknown.some(item => item.id === 'current' && item.reason === 'input_too_long'));
assert.equal(buildReplyContext({ history: null, memories: null, events: null }).facts.length, 0);
console.log('reply context: evidence attribution, recall admission, ownership, profile scope, event state and bounded pure inputs passed');
