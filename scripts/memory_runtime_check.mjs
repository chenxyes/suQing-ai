import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { buildSystemPrompt as realPrompt } from '../src/companion.mjs';
import { filterRecentlyUsed, materialDedupDays } from '../src/proactive_material.mjs';
import { applyCrisisOverride, userRaisedMemoryTopic } from '../src/relationship_arc.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-runtime-'));
process.env.DB_PATH = path.join(temp, 'fixture.db');
process.env.LOG_DIR = path.join(temp, 'logs');
const m = await import('../src/db.mjs');
const db = m.getDb();
const uid = 99001;
db.prepare('INSERT INTO users(id,wechat_user_id) VALUES(?,?)').run(uid, 'synthetic-runtime');
let nextCid = 99100;
const space = { version: 1, provider: 'fixture', model: 'runtime-fixture', dimension: 2, endpointId: 'a'.repeat(64) };
const embedding = text => ({ vector: [1, 0], descriptor: space, contentHash: createHash('sha256').update(text).digest('hex') });

// Execute contiguous production code from retrieval through the first actual generation.
// The slices preserve statement order (including intervening awaits and safety filters).
// Transport, unrelated persona helpers, and external models are isolated; DB ranking,
// memory eligibility, prompt rendering, material filtering and touches remain real.
function section(file, start, end) {
  const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `${file} execution boundaries must still exist`);
  return source.slice(a, b);
}
const sections = {
  bot: section('bot.mjs', '    let memories = [];', '    // A delivery failure is not an assistant conversation turn'),
  playground: section('playground.mjs', '  // ── v1.9.0 #1 + v1.9.1:', '  if (isChatFallback(reply))'),
  proactive: section('proactive.mjs', '  if (!companion.wechat_user_id) {', "  if (isChatFallback(reply)) throw new Error('proactive chat unavailable');"),
};
function fixture() {
  const cid = ++nextCid;
  db.prepare('INSERT INTO companions(id,user_id,bot_id,name) VALUES(?,?,?,?)').run(cid, uid, `fixture-${cid}`, '测试角色');
  const add = (content, extra = {}) => m.saveMemory({ companionId: cid, userId: uid, memoryType: 'fact',
    content, importance: 5, pinned: false, ...extra });
  const lexical = add('我周末骑车经过海边');
  const semantic = add('我喜欢黄昏去河堤');
  const sensitive = add('我难过时会想起旧事', { memoryLayer: 'emotion' });
  const hidden = add('我周末骑车经过山路');
  db.prepare("UPDATE companion_memories SET memory_subject='user' WHERE companion_id=?").run(cid);
  for (const id of [semantic, sensitive]) {
    const row = db.prepare('SELECT * FROM companion_memories WHERE id=?').get(id);
    assert.equal(m.writeMemoryEmbedding(id, cid, uid, embedding(row.content), { expectedContent: row.content, expectedRecallRevision: 0 }), true);
  }
  m.patchMemory(hidden, cid, { do_not_mention: 1 });
  return { cid, lexical, semantic, sensitive, hidden,
    companion: { id: cid, user_id: uid, bot_id: `fixture-${cid}`, wechat_user_id: 'synthetic-runtime', name: '测试角色',
      memory_enabled: 1, relationship_stage: '朋友', affection_level: 20, safe_mode: 1 } };
}
const uses = id => db.prepare('SELECT use_count FROM companion_memories WHERE id=?').get(id).use_count || 0;
async function execute(kind, f, { probe = false, provider = 'ok', crisis = 'none', arc = 'normal',
  cooled = [], windowOpen = true, throwBeforeGeneration = false, source = sections[kind] } = {}) {
  const events = [], generated = [], prompts = [], query = '周末骑车';
  const sandbox = {
    console, Set, Date, companion: f.companion, userText: query, text: query, probe,
    ctx: {}, msg: { fromUser: 'synthetic-runtime' }, botId: 'fixture', userParts: null,
    binding: {}, userMsgSafetyLevel: 'none', kind: 'normal', account: { bot_token: 'fixture-token', bot_id: 'fixture' }, opts: {},
    log: () => {},
    embedTextWithDescriptor: async text => {
      events.push('embed');
      if (provider === 'throw') throw new Error('synthetic embedding outage');
      return provider === 'null' ? null : embedding(text);
    },
    recallMemoriesHybrid: (...args) => { events.push('recall'); return m.recallMemoriesHybrid(...args); },
    recallMemories: (...args) => { events.push('recall'); return m.recallMemories(...args); },
    touchRecalledMemories: (...args) => { events.push('touch'); return m.touchRecalledMemories(...args); },
    buildSystemPrompt: (companion, extras) => {
      events.push('prompt'); prompts.push(extras.memories.map(row => row.id));
      for (const id of [f.lexical, f.semantic, f.sensitive, f.hidden]) assert.equal(uses(id), 0, 'retrieval and prompt construction must not touch');
      return realPrompt(companion, extras);
    },
    generateReply: async (prompt, history, text) => {
      events.push('generate'); generated.push({ prompt, text });
      for (const id of prompts.at(-1) || []) assert.equal(uses(id), probe ? 0 : 1, 'touch must happen before actual generation and respect probe');
      return 'synthetic reply';
    },
    buildLongTermDigest: async () => { events.push('digest'); if (throwBeforeGeneration) throw new Error('synthetic preparation failure'); return ''; },
    getUserProfileForRecall: () => null, getConversationContext: () => [], getRecentHistory: () => [{ role: 'assistant', direction: 'out', content: 'previous' }],
    getDailySchedule: () => null, getRecentSchedules: () => [], getPersonaFacts: () => [], shanghaiDateKey: () => '2026-10-20',
    getEmotionStateWithDefaults: () => ({}), updateEmotionFromUserMessage: (_id, state) => state,
    getMissingLevel: () => 0, getNeglectStage: () => 'none', getCompanionPreferencesForPrompt: () => ({}),
    hasStickers: () => false, consumePendingCelebration: () => null, detectIntimacyOvereach: () => ({ has: false }), detectUserConfession: () => false,
    generateInnerMonologue: async () => null, detectSafetyRisk: () => ({ level: 'none' }), recordSafetyEvent: () => {},
    sendTyping: async () => {}, escalationLevel: () => ({ level: 0 }), stripCurrentTurnFromHistory: history => history,
    detectCrisisLevel: () => crisis, buildCrisisReply: () => { events.push('crisis-reply'); return 'synthetic crisis resources'; },
    getOpenRelationshipEvent: () => null, getActivePeriodContext: () => null,
    runArcSignalTick: () => ({ arcState: arc, active: arc !== 'normal', directive: '' }), applyCrisisOverride, userRaisedMemoryTopic,
    isPeriodHeavyWindow: () => false, isPmsActive: () => false, detectTeaching: () => [], listShaping: () => [], getActiveCurrentWorks: () => [],
    recentIntentEvents: () => [], isNightShanghai: () => false, canAcceptConfession: () => false,
    recallContextToken: () => windowOpen ? 'fixture-window' : null, buildTimeContext: () => ({ searchText: query, specialText: '' }),
    getDueReminders: () => [], formatDateKey: () => '2026-10-20', getRecentlyUsedMaterialIds: () => new Set(cooled.map(id => `mem:${id}`)),
    materialDedupDays, filterRecentlyUsed, getArcExpressionContext: () => ({ active: false, arcState: 'normal' }),
    listDueOpenLoops: () => [], getRecentProactiveTexts: () => [], worksConfig: () => ({ mentionCooldownH: 48 }),
    pickProactiveWork: () => null, getActiveWechatBinding: () => null,
  };
  for (const name of ['buildStickerPromptHint', 'buildEmotionPromptHint', 'buildInnerOsHint', 'buildReunionHint', 'buildShapingConfirmHint',
    'buildShapingPromptHint', 'buildWorksPromptHint', 'buildOpenLoopsHint', 'escalationDirective', 'buildIntentDedupHint', 'buildRealityFacts',
    'buildFirstTurnHint', 'buildRecentProactiveHint']) sandbox[name] = () => '';
  // Playground's prefix declares this binding locally; other selected sections use an enclosing one.
  if (kind === 'playground') delete sandbox.userMsgSafetyLevel;
  const context = vm.createContext(sandbox);
  const code = `(async () => {${source}\nreturn {memories,reply,systemPrompt};})()`;
  const result = await new vm.Script(code, { filename: `runtime-${kind}.mjs` }).runInContext(context);
  return { ...result, events, generated, prompts };
}
function assertMixed(result, f) {
  const ids = result.memories.map(row => row.id);
  assert.ok(ids.includes(f.lexical), 'unembedded lexical fact reaches chat');
  assert.ok(ids.includes(f.semantic), 'same-space semantic fact reaches chat');
  assert.ok(!ids.includes(f.hidden), 'hidden fact never reaches chat');
  assert.ok(result.generated[0].prompt.includes('我周末骑车经过海边'));
  assert.ok(result.generated[0].prompt.includes('我喜欢黄昏去河堤'));
}
try {
  for (const kind of ['bot', 'playground']) {
    await test(`${kind}: real hybrid recall injects lexical and semantic facts and touches only before generation`, async () => {
      const f = fixture(), result = await execute(kind, f);
      assertMixed(result, f);
      assert.ok(result.events.indexOf('prompt') < result.events.indexOf('touch'));
      assert.ok(result.events.indexOf('touch') < result.events.indexOf('generate'));
      assert.equal(uses(f.hidden), 0);
    });
    await test(`${kind}: null and throwing embedding providers retain lexical recall`, async () => {
      for (const provider of ['null', 'throw']) {
        const f = fixture(), result = await execute(kind, f, { provider });
        assert.ok(result.memories.some(row => row.id === f.lexical));
        assert.ok(result.generated[0].prompt.includes('我周末骑车经过海边'));
      }
    });
    await test(`${kind}: preparation failure never touches retrieved facts`, async () => {
      const f = fixture();
      await assert.rejects(() => execute(kind, f, { throwBeforeGeneration: true }), /preparation failure/);
      for (const id of [f.lexical, f.semantic, f.sensitive, f.hidden]) assert.equal(uses(id), 0);
    });
  }
  await test('playground probe generates with real recalled facts and leaves recall timestamps/counts unchanged', async () => {
    const f = fixture(), result = await execute('playground', f, { probe: true }); assertMixed(result, f);
    assert.ok(!result.events.includes('touch'));
    for (const row of db.prepare('SELECT use_count,last_used_at FROM companion_memories WHERE companion_id=?').all(f.cid)) {
      assert.equal(row.use_count || 0, 0); assert.equal(row.last_used_at, null);
    }
  });
  await test('bot direct crisis response skips generation and all memory touches', async () => {
    const f = fixture(), result = await execute('bot', f, { crisis: 'high' });
    assert.equal(result.reply, 'synthetic crisis resources'); assert.equal(result.generated.length, 0);
    assert.ok(!result.events.includes('touch'));
    for (const id of [f.lexical, f.semantic, f.sensitive, f.hidden]) assert.equal(uses(id), 0);
  });
  await test('bot conflict safety filter removes sensitive unrelated facts before prompt and touch', async () => {
    const f = fixture(), result = await execute('bot', f, { arc: 'cold' }); assertMixed(result, f);
    assert.ok(!result.memories.some(row => row.id === f.sensitive));
    assert.ok(!result.generated[0].prompt.includes('我难过时会想起旧事')); assert.equal(uses(f.sensitive), 0);
  });
  await test('proactive material cooldown filters before prompt and touch; closed window does neither', async () => {
    const f = fixture(), result = await execute('proactive', f, { cooled: [f.semantic] });
    assert.ok(result.memories.some(row => row.id === f.lexical));
    assert.ok(!result.memories.some(row => row.id === f.semantic));
    assert.equal(uses(f.semantic), 0); assert.equal(uses(f.lexical), 1);
    const closed = fixture(), skipped = await execute('proactive', closed, { windowOpen: false });
    assert.equal(skipped.generated.length, 0); assert.equal(uses(closed.lexical), 0);
  });
  await test('runtime assertions detect lost lexical candidates and missing touch in isolated source mutations', async () => {
    const filtered = sections.bot.replace('const userProfile =', 'memories = memories.filter(row => row.embedding);\nconst userProfile =');
    const f = fixture(), result = await execute('bot', f, { source: filtered });
    assert.throws(() => assertMixed(result, f), /unembedded lexical fact/);
    const noTouch = sections.playground.replace('if (!probe) touchRecalledMemories(companion.id, companion.user_id, memories.map(row => row.id));', '');
    await assert.rejects(() => execute('playground', fixture(), { source: noTouch }), /touch must happen before actual generation/);
  });
} finally {
  db.close();
  process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));
}
