import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CHAT_FALLBACK, isChatFallback } from '../src/chat_response.mjs';

// Run the actual production sender and guarded wrapper with isolated IO boundaries.
// No DB, provider, or messaging requests are made by this fixture.
const source = readFileSync(new URL('../src/proactive.mjs', import.meta.url), 'utf8');
const guarded = source.slice(source.indexOf('async function sendProactiveMessageGuarded('), source.indexOf('\nfunction parseTimeWindow('));
const sender = source.slice(source.indexOf('async function sendProactiveMessage('), source.indexOf('\nexport async function', source.indexOf('async function sendProactiveMessage(')));

for (const collisionRetry of [false, true]) {
  const calls = { generated: 0, transformed: [], sent: 0, history: 0, accounted: 0 };
  const inFlight = new Set();
  const recentText = '刚看完一本很有意思的书';
  const context = {
    console, Date, Math, Set, process,
    _proactiveInFlight: inFlight, PROACTIVE_HARD_GAP_SECONDS: 0,
    isChatFallback,
    log() {},
    getRecentSafetyRisk: () => ({ level: 'low' }),
    getArcProactivePolicy: () => ({ arcState: 'normal' }),
    getProactiveLastSent: () => ({ lastAt: 0 }),
    recallContextToken: () => 'fixture-token',
    getUserProfile: () => ({}), getDueReminders: () => [], formatDateKey: () => '2026-09-18',
    buildTimeContext: () => ({ searchText: '', specialText: '' }),
    getConversationContext: () => collisionRetry ? [{ role: 'assistant', content: recentText }] : [],
    getRecentlyUsedMaterialIds: () => new Set(), materialDedupDays: () => 1,
    filterRecentlyUsed: values => values, getRecentHistory: () => [], buildLongTermDigest: async () => '',
    buildStickerPromptHint: () => '', shanghaiDateKey: () => '2026-09-18',
    getDailySchedule: () => null, getRecentSchedules: () => [], getPersonaFacts: () => null,
    getEmotionStateWithDefaults: () => ({}), getMissingLevel: () => 0, getNeglectStage: () => 0,
    getArcExpressionContext: () => ({ active: false, arcState: 'normal' }),
    getActivePeriodContext: () => null, getCompanionPreferencesForPrompt: () => '',
    getActiveCurrentWorks: () => [], buildWorksPromptHint: () => '', buildSystemPrompt: () => 'fixture',
    listShaping: () => [], buildShapingPromptHint: () => '', buildRealityFacts: () => '', isNightShanghai: () => false,
    getRecentProactiveTexts: () => [], buildRecentProactiveHint: () => '',
    getActiveWechatBinding: () => null,
    generateReply: async () => (++calls.generated === 1 && collisionRetry) ? recentText : CHAT_FALLBACK,
    safeOutboundReply: text => { calls.transformed.push(text); return text; },
    scrubPhotoImpersonation: text => text,
    findCollision: text => text === recentText ? { text: recentText, sim: 1 } : null,
    scrubFabricatedIllness: text => text, scrubPeriodDisclosure: text => text,
    splitReplySegments: text => [text], dedupSegments: texts => ({ kept: texts, dropped: [] }),
    parseStickerMarkers: text => ({ text, stickers: [] }),
    sendTextMessage: async () => { calls.sent++; return true; },
    saveMessage: () => calls.history++, saveConversationTurn: () => calls.history++,
    recordProactiveSentTimestamp: () => calls.accounted++, bumpProactiveHealth: () => calls.accounted++,
    recordProactiveSent: () => calls.accounted++, bumpProactiveUnanswered: () => calls.accounted++,
    tryAchievement() {},
  };
  const run = vm.runInNewContext(`${guarded}\n${sender}\nsendProactiveMessageGuarded`, context);
  await assert.rejects(run({ id: 1, user_id: 1, wechat_user_id: 'fixture', bot_id: 'fixture', safe_mode: 1 },
    'reminder', { bot_token: 'fixture', bot_id: 'fixture' }), error => error.message === 'proactive chat unavailable');
  assert.equal(calls.generated, collisionRetry ? 2 : 1, 'exercise the requested generation failure');
  assert.deepEqual(calls.transformed, collisionRetry ? [recentText] : [], 'fallback must never reach transformations');
  assert.equal(calls.sent, 0, 'must not send fallback');
  assert.equal(calls.history, 0, 'must not save fallback history');
  assert.equal(calls.accounted, 0, 'guarded sender must not record sent');
  assert.equal(inFlight.size, 0, 'failure must release in-flight guard');
}
console.log('proactive chat failures: initial and collision retry stop before transformation, send, history and sent accounting');
