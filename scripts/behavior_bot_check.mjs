import { generateGroundedReply as realGroundedReply, usesGroundedReplies } from '../src/reply_pipeline.mjs';
import { availabilityWindowForReply, preserveAvailabilityWindow, reviewPressureTail } from '../src/pressure_tail.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as behavior from '../src/behavior_runtime.mjs';
import { buildInnerOsHint } from '../src/inner_os.mjs';
import { CHAT_FALLBACK, isChatFallback } from '../src/chat_response.mjs';

// Exercise the production pipeline and sender with deterministic IO boundaries.
// Runtime selection is real; persistence/HTTP/delays are observable test doubles.
process.env.BEHAVIOR_ENABLED = 'true';
const source = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
const pipeline = source.slice(source.indexOf('async function processUserTurn('), source.indexOf('async function handleBindCodeMessage('))
  .replace("import('./backfill_history.mjs')", 'Promise.resolve({maybeAutoBackfill(){}})');
const sender = source.slice(source.indexOf('async function sendAndRecord('), source.indexOf('async function sendStickerAndRecord('));
const companion = { id: 1, user_id: 1, name: '素晴', proactive_enabled: 1, relationship_stage: '朋友', memory_enabled: 0 };
for (const test of ['sent', 'failed', 'partial', 'throw', 'fallback', 'discard', 'review_failed', 'revised', 'off', 'safe', 'cold']) {
  process.env.BEHAVIOR_ENABLED = test === 'off' ? 'false' : 'true';
  const seen = { plans: [], sends: [], turns: [], prompts: [], errors: [], post: [] };
  const pendingBursts = new Map();
  let generation = 0;
  const context = {
    availabilityWindowForReply, preserveAvailabilityWindow, reviewPressureTail, usesGroundedReplies,
    generateGroundedReply: opts => realGroundedReply({ ...opts, events: [] }, {
      generate: (...args) => context.generateReply(...args),
      review: async ({ draft }) => {
        if (test === 'review_failed') return { reply: CHAT_FALLBACK, status: 'fallback', reasons: ['invalid_review'] };
        if (test === 'revised') return { reply: '可以慢慢说。', status: 'revised', reasons: ['unsupported_fact'] };
        return { reply: draft, status: 'kept', reasons: [] };
      },
    }), touchRecalledMemories() {},
    ...behavior, buildInnerOsHint, randomUUID, process, Date, Math, Set, Map, clearTimeout,
    inflightUsers: new Set(), inflightPhoto: new Set(), pendingBursts,
    log: (level, text) => { if (level === 'error') seen.errors.push(text); },
    clearProactiveUnanswered() {}, observeBehaviorInput() {}, readBehaviorState: () => null,
    detectPhotoIntentSmart: async () => ({ type: 'none' }), getRecentHistory: () => [],
    detectMinorSmart: async () => ({ level: 'none' }), detectSafetyRisk: () => ({ level: 'none' }),
    getUserProfileForRecall: () => ({}), getConversationContext: () => [], buildLongTermDigest: async () => '',
    shanghaiDateKey: () => '2026-11-17', getDailySchedule: () => null, getRecentSchedules: () => [], getPersonaFacts: () => null,
    getEmotionStateWithDefaults: () => ({}), escalationLevel: () => ({ level: 0 }),
    updateEmotionFromUserMessage: () => ({}), stripCurrentTurnFromHistory: h => h,
    detectCrisisLevel: () => 'none', getOpenRelationshipEvent: () => null,
    getArcExpressionContext: () => ({ arcState: 'normal' }),
    generateInnerMonologue: async opts => {
      seen.planning = opts.context.behaviorPlanningHint;
      return { thought: '有点烦但我想好好听', struct: { user_tone: 'neutral' }, behavior: { scenario: 'support', action: 'validate' } };
    },
    getActivePeriodContext: () => null,
    runArcSignalTick: () => ({ arcState: test === 'cold' ? 'cold' : 'normal', active: test === 'cold', directive: test === 'cold' ? 'ONLY_COLD_TEMPLATE' : '' }),
    applyCrisisOverride: c => c, hasStickers: () => false, buildStickerPromptHint: () => '',
    getMissingLevel: () => 0, getNeglectStage: () => 0, buildReunionHint: () => '', buildEmotionPromptHint: () => '',
    isPeriodHeavyWindow: () => false, isPmsActive: () => false,
    getCompanionPreferencesForPrompt: () => '', detectTeaching: () => [], buildShapingConfirmHint: () => '',
    listShaping: () => [], buildShapingPromptHint: () => '', getActiveCurrentWorks: () => [], buildWorksPromptHint: () => '',
    buildOpenLoopsHint: () => '', buildSystemPrompt: () => { assert.ok(test === 'off' || test === 'safe', 'grounded replies cannot assemble the legacy template'); return 'PERSONA'; }, escalationDirective: () => '',
    recentIntentEvents: () => [], buildIntentDedupHint: () => '', buildRealityFacts: () => '', isNightShanghai: () => false,
    buildFirstTurnHint: () => '', consumePendingCelebration: () => null, detectIntimacyOvereach: () => ({ has: false }), detectUserConfession: () => false,
    generateReply: async prompt => {
      generation++; seen.prompts.push(prompt);
      if (test === 'discard' && generation === 1) pendingBursts.set('fixture', { parts: ['我终于拿到驾照了'], turn: { ...turn } });
      return test === 'fallback' ? CHAT_FALLBACK : `先听你说${generation} || 慢慢来${generation}`;
    }, isChatFallback,
    safeOutboundReply: t => t, scrubPersonaLeak: t => t, scrubConflictRedline: t => t,
    scrubPhotoImpersonation: t => t, getActiveLifeStates: () => [], scrubFabricatedIllness: t => t, scrubPeriodDisclosure: t => t,
    applyPersonaGuard: async () => ({ guarded: false }), recordUserReplied() {}, updateEmotionFromAssistantReply() {},
    splitReplySegments: t => t.split(' || '), dedupSegments: a => ({ kept: a, dropped: [] }), isAck: () => false,
    computeIcebreakerDelay: () => 0, parseStickerMarkers: text => ({ text, stickers: [] }), computeReplyDelay: () => 0,
    sendTyping: async () => {}, sleep: async () => {}, randInt: () => 0,
    sendTextMessage: async (ctx, user, text, token, opts) => {
      seen.sends.push({ text, opts });
      if (test === 'throw' && seen.sends.length === 2) throw new Error('fixture send failure');
      return test !== 'failed' && !(test === 'partial' && seen.sends.length === 2);
    },
    saveMessage() {}, saveConversationTurn: (id, role, text) => { seen.turns.push({ role, text }); return { id: seen.turns.length, content: text, role }; },
    recordBehaviorDelivery: event => seen.plans.push(event), detectPhotoPromise: () => ({ promised: false }),
    postProcess: async (c, text, reply) => seen.post.push(reply),
  };
  const run = vm.runInNewContext(`${sender}\n${pipeline}\nprocessUserTurn`, context);
  const turn = { companion: { ...companion, safe_mode: test === 'safe' ? 1 : 0 }, binding: {}, ctx: {}, botId: 'b', fromUser: 'fixture', userText: '工作搞砸了，我特别委屈，10分钟后再问我', contextToken: 'fixture' };
  await run(turn);
  assert.deepEqual(seen.errors, [], `${test}: production pipeline must reach delivery, not silently catch a wiring error`);
  if (test === 'failed' || test === 'fallback' || test === 'review_failed') {
    assert.equal(seen.plans.length, 0, test);
    assert.equal(seen.turns.filter(t => t.role === 'assistant').length, 0, test);
  } else if (test === 'off' || test === 'safe') {
    assert.equal(seen.plans.length, 0, test);
    assert.equal(seen.planning, '', test);
  } else {
    assert.equal(seen.plans.length, 1, test);
    assert.ok(Number.isFinite(seen.plans[0].inputStartedAt), 'cancellation race token is passed');
    assert.equal(seen.plans[0].deliveredText, seen.post[0]);
    assert.ok(seen.sends.every(s => s.opts?._allowQueue === false), 'behavior delivery must not be an unconfirmed queue receipt');
    if (test === 'revised') {
      assert.deepEqual(seen.sends.map(s => s.text), ['可以慢慢说。']);
      assert.equal(seen.plans[0].deliveredText, '可以慢慢说。');
      assert.equal(seen.turns.at(-1).text, '可以慢慢说。');
    }
    if (test === 'partial' || test === 'throw') assert.equal(seen.plans[0].deliveredText, '先听你说1');
    if (test === 'discard') {
      assert.equal(generation, 2);
      assert.ok(seen.sends.every(s => s.text.endsWith('2')), 'discarded burst draft is never sent or recorded');
    }
    if (test === 'cold') {
      assert.equal(seen.plans[0].plan.arcState, 'cold', 'validate after arc tick');
      assert.ok(!seen.prompts[0].includes('ONLY_COLD_TEMPLATE'));
      assert.ok(seen.prompts[0].includes('关系状态仍是 cold'));
    }
  }
}
console.log('behavior bot: actual pipeline sent/failed/partial/throw/fallback/burst discard/off/minor/cold checks passed');
