import { reviewPressureTail } from '../src/pressure_tail.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isChatFallback } from '../src/chat_response.mjs';

// Run the actual production sender and guarded wrapper with isolated IO boundaries.
// No DB, provider, or messaging requests are made by this fixture.
const source = readFileSync(new URL('../src/proactive.mjs', import.meta.url), 'utf8');
const guarded = source.slice(source.indexOf('async function sendProactiveMessageGuarded('), source.indexOf('\nfunction parseTimeWindow('));
const sender = source.slice(source.indexOf('async function sendProactiveMessage('), source.indexOf('\nexport async function', source.indexOf('async function sendProactiveMessage(')));

for (const scenario of ['missing_binding', 'expired_context', 'first_failed', 'partial', 'sent', 'empty', 'cancelled', 'sleeping', 'history_error', 'late_cancel', 'behavior_sent', 'behavior_retry', 'safety', 'source_removed']) {
  const collisionRetry = scenario === 'behavior_retry';
  const behaviorCase = ['cancelled', 'sleeping', 'late_cancel', 'behavior_sent', 'behavior_retry', 'safety', 'source_removed'].includes(scenario);
  const calls = { generated: 0, transformed: [], sent: 0, history: 0, accounted: 0, turns: [] };
  const inFlight = new Set();
  const recentText = '刚看完一本很有意思的书';
  const context = {
    reviewPressureTail, touchRecalledMemories() {},
    console, Date, Math, Set, process, setTimeout: (fn) => { fn(); },
    isBehaviorTaskCurrent: () => scenario !== 'cancelled' && !(scenario === 'late_cancel' && calls.generated),
    getSleepRow: () => ({ is_sleeping: scenario === 'sleeping' }),
    getCompanionById: () => ({ id: 1, proactive_enabled: 1, safe_mode: 0, silent_mode: 0 }),
    buildBehaviorReplyHint: () => scenario === 'source_removed' ? '' : 'VALIDATED_BEHAVIOR_HINT',
    _proactiveInFlight: inFlight, PROACTIVE_HARD_GAP_SECONDS: 0,
    isChatFallback,
    log() {},
    getRecentSafetyRisk: () => ({ level: scenario === 'safety' ? 'high' : 'none' }),
    getArcProactivePolicy: () => ({ arcState: 'normal' }),
    getProactiveLastSent: () => ({ lastAt: 0 }),
    recallContextToken: () => scenario === 'expired_context' ? null : 'fixture-token',
    getUserProfileForRecall: () => ({}), getDueReminders: () => [], formatDateKey: () => '2026-09-18',
    buildTimeContext: () => ({ searchText: '', specialText: '' }),
    getConversationContext: () => collisionRetry ? [{ role: 'assistant', content: recentText }] : [],
    getRecentlyUsedMaterialIds: () => new Set(), materialDedupDays: () => 1,
    filterRecentlyUsed: values => values, getRecentHistory: () => [], buildLongTermDigest: async () => '',
    buildStickerPromptHint: () => '', shanghaiDateKey: () => '2026-09-18',
    getDailySchedule: () => null, getRecentSchedules: () => [], getPersonaFacts: () => null,
    getEmotionStateWithDefaults: () => ({}), getMissingLevel: () => 0, getNeglectStage: () => 0,
    getArcExpressionContext: () => ({ active: behaviorCase, arcState: behaviorCase ? 'cold' : 'normal', directive: 'LEGACY_COLD_DIRECTIVE' }),
    getActivePeriodContext: () => null, getCompanionPreferencesForPrompt: () => '',
    getActiveCurrentWorks: () => [], buildWorksPromptHint: () => '', buildSystemPrompt: () => 'fixture',
    listShaping: () => [], buildShapingPromptHint: () => '', buildRealityFacts: () => '', isNightShanghai: () => false,
    getRecentProactiveTexts: () => [], buildRecentProactiveHint: () => '',
    getActiveWechatBinding: () => null,
    generateReply: async (system,_history,prompt) => { calls.generated++; if (behaviorCase) { assert.ok(system.includes('VALIDATED_BEHAVIOR_HINT'), 'behavior belongs in system priority'); assert.ok(!system.includes('LEGACY_COLD_DIRECTIVE'), 'no contradictory legacy cold instruction'); assert.ok(!system.includes('换全新的话题')); assert.ok(!prompt.includes('换一个完全不同的话题')); } return scenario === 'empty' ? '' : collisionRetry && calls.generated === 1 ? recentText : '现在好些了吗||我在这里'; },
    safeOutboundReply: text => { calls.transformed.push(text); return text; },
    scrubPhotoImpersonation: text => text,
    findCollision: text => text === recentText ? { text: recentText, sim: 1 } : null,
    scrubFabricatedIllness: text => text, scrubPeriodDisclosure: text => text,
    splitReplySegments: text => text.split('||'), dedupSegments: texts => ({ kept: texts, dropped: [] }),
    parseStickerMarkers: text => ({ text, stickers: [] }),
    sendTextMessage: async (_ctx,_user,_text,_token,opts) => { assert.equal(opts?._allowQueue, false, 'proactive must confirm transport, not queue'); calls.sent++; return scenario !== 'first_failed' && !(scenario === 'partial' && calls.sent === 2); },
    saveMessage: () => { if (scenario === 'history_error') throw new Error('disk'); calls.history++; }, saveConversationTurn: (_id,_role,text) => { calls.history++; calls.turns.push(text); },
    recordProactiveSentTimestamp: () => calls.accounted++, bumpProactiveHealth: () => calls.accounted++,
    recordProactiveSent: () => calls.accounted++, bumpProactiveUnanswered: () => calls.accounted++,
    tryAchievement() {}, classifyIntent: () => 'other', topicKey: () => '', recentIntentEvents: () => [], trailingAckStreak: () => 0, isIntentCooled: () => ({cooled:false}), extractMaterialRefs: () => [],
  };
  const run = vm.runInNewContext(`${guarded}\n${sender}\nsendProactiveMessageGuarded`, context);
  const result = await run({ id: 1, user_id: 1, wechat_user_id: scenario === 'missing_binding' ? null : 'fixture', bot_id: 'fixture', safe_mode: 1 },
    behaviorCase ? 'behavior_followup' : 'reminder', { bot_token: 'fixture', bot_id: 'fixture' }, behaviorCase ? { behaviorTask: { id: 1, context_text: '工作受挫', original_text: '我在听', plan_json: '{}' } } : {});
  const status = result?.status || result;
  if (['sent', 'partial', 'history_error', 'behavior_sent', 'behavior_retry'].includes(scenario)) {
    assert.equal(status, scenario === 'partial' ? 'partial' : 'sent', scenario + ' reports actual delivery');
    assert.equal(calls.turns[0], scenario === 'partial' ? '现在好些了吗' : '现在好些了吗 || 我在这里', 'history includes only delivered segments');
    assert.ok(calls.accounted > 0);
  } else {
    assert.notEqual(status, 'sent', scenario + ' must not claim delivery');
    assert.equal(calls.history, 0, scenario + ' must not save unsent text');
    assert.equal(calls.accounted, 0, scenario + ' must not consume sent accounting');
  }
  assert.equal(inFlight.size, 0);
}
console.log('proactive delivery: missing binding, expired context, failure, partial, empty, cancellation, sleep, history failure, source removal, safety, cold priority and topic-preserving retry passed');
