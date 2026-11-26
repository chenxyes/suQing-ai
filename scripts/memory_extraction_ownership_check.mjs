import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashMemoryContent } from '../src/memory_vectors.mjs';

const temp = mkdtempSync(path.join(tmpdir(), 'memory-extraction-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.LOG_DIR = path.join(temp, 'logs');
const fixture = { output: {}, calls: [], graph: [], achievements: [], onModel: () => {}, embeds: [], onEmbed: () => null };
// VM modules are available on the CI Node 20 runtime with --experimental-vm-modules.
// Keep the database and provenance implementation real; replace only external boundaries.
const m = await import('../src/db.mjs');
const logger = await import('../src/logger.mjs');
const context = vm.createContext({ console, process, Buffer });
const dependencies = new Map(Object.entries({
  './db.mjs': m,
  './logger.mjs': logger,
  './ai.mjs': {
    async extractStructuredInfo(system, input) {
      fixture.calls.push({ system, input }); fixture.onModel(); return JSON.stringify(fixture.output);
    },
    async embedText() { throw new Error('No embedding calls are allowed in this fixture'); },
    async embedTextWithDescriptor(text) { fixture.embeds.push(text); return fixture.onEmbed(text); },
  },
  './event_graph.mjs': { processMemoryForGraph(...args) { fixture.graph.push(args); } },
  './achievements.mjs': { tryAchievement(...args) { fixture.achievements.push(args); } },
}));
const modules = new Map();
const sourceUrl = new URL('../src/memory.mjs', import.meta.url);
const memoryModule = new vm.SourceTextModule(readFileSync(sourceUrl, 'utf8'), {
  context, identifier: sourceUrl.href,
});
const link = async specifier => {
  if (specifier === './memory_indexing.mjs') {
    if (!modules.has(specifier)) {
      const mod = new vm.SourceTextModule(readFileSync(new URL('../src/memory_indexing.mjs', import.meta.url), 'utf8'), { context });
      modules.set(specifier, mod);
      await mod.link(link);
    }
    return modules.get(specifier);
  }
  if (!dependencies.has(specifier)) throw new Error(`Unexpected extraction dependency: ${specifier}`);
  if (!modules.has(specifier)) {
    const exports = dependencies.get(specifier);
    modules.set(specifier, new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context, identifier: specifier }));
  }
  return modules.get(specifier);
};
await memoryModule.link(link);
await memoryModule.evaluate();
const { extractAndSaveMemories: extract, extractAndUpdateUserProfile: profile } = memoryModule.namespace;
const db = m.getDb(), uid = 97001;
db.prepare('INSERT INTO users(id,wechat_user_id) VALUES(?,?)').run(uid, 'synthetic-extraction-owner');
let cid = 98100;
function scope() {
  cid++;
  db.prepare('INSERT INTO companions(id,user_id,bot_id) VALUES(?,?,?)').run(cid, uid, `synthetic-extraction-${cid}`);
  fixture.output = {}; fixture.calls = []; fixture.graph = []; fixture.achievements = []; fixture.onModel = () => {};
  fixture.embeds = []; fixture.onEmbed = () => null;
}
const turn = (role, content) => m.saveConversationTurn(cid, role, content);
const rows = () => db.prepare('SELECT * FROM companion_memories WHERE companion_id=?').all(cid);
function candidate(t, subject = 'user', extra = {}) {
  return { subject, evidence: [{ turn_id: t.id, quote: t.content }], memory_type: 'fact', content: '模型自由改写的事实', importance: 8, ...extra };
}
async function run(user, assistant, memories, ids = [user.id, assistant.id]) {
  fixture.output = { memories, current_scene: '' };
  return extract(cid, uid, user.content, assistant.content, { turnIds: ids });
}
try {
  await test('new facts index canonical text once; duplicate or rejected evidence never calls embeddings', async () => {
    scope(); const user = turn('user', '我喜欢在周末骑自行车'), assistant = turn('assistant', '我有一个妹妹');
    fixture.onEmbed = text => ({ vector: [1, 0], contentHash: hashMemoryContent(text),
      descriptor: { version: 1, provider: 'fixture', model: 'fixture', dimension: 2, endpointId: 'a'.repeat(64) } });
    assert.equal(await run(user, assistant, [candidate(user), candidate(user), candidate(assistant)]), 1);
    assert.deepEqual(fixture.embeds, [user.content]);
    assert.ok(rows()[0].embedding_meta);
    assert.equal(await run(user, assistant, [candidate(user)]), 0);
    assert.equal(fixture.embeds.length, 1);
  });
  await test('embedding failure preserves admitted fact and successful extraction count', async () => {
    scope(); const user = turn('user', '我喜欢在周末骑自行车'), assistant = turn('assistant', '好的');
    fixture.onEmbed = () => { throw new Error('fixture unavailable'); };
    assert.equal(await run(user, assistant, [candidate(user)]), 1);
    assert.equal(rows().length, 1); assert.equal(rows()[0].embedding, null);
  });
  await test('graph admission completes before asynchronous indexing can invalidate saved text', async () => {
    scope(); const user = turn('user', '我喜欢在周末骑自行车'), assistant = turn('assistant', '好的');
    const graphCounts = [];
    fixture.onEmbed = () => {
      graphCounts.push(fixture.graph.length);
      m.patchMemory(rows()[0].id, cid, { content: '我喜欢游泳' });
      return null;
    };
    assert.equal(await run(user, assistant, [candidate(user)]), 1);
    assert.deepEqual(graphCounts, [1], 'no graph write of stale content after the provider await');
    assert.equal(fixture.graph.length, 1);
  });
  await test('assistant statement cannot become user fact; companion ownership remains usable', async () => {
    scope(); const user = turn('user', '你刚才说的是你自己的妹妹吧'); const assistant = turn('assistant', '我有一个妹妹');
    assert.equal(await run(user, assistant, [candidate(assistant)]), 0);
    assert.equal(rows().length, 0);
    assert.equal(await run(user, assistant, [candidate(assistant, 'companion')]), 1);
    const [row] = rows(); assert.equal(row.memory_subject, 'companion'); assert.equal(row.content, assistant.content);
    assert.equal(fixture.graph.length, 0, 'user-only graph cannot receive companion claims');
  });
  await test('real turn IDs and roles reach extraction; canonical self assertion deduplicates without graph replay', async () => {
    scope(); const user = turn('user', '我喜欢在周末骑自行车'); const assistant = turn('assistant', '听起来很开心');
    const input = candidate(user, 'user', { content: '他不喜欢骑自行车' });
    assert.equal(await run(user, assistant, [input, input]), 1);
    const [row] = rows(); assert.equal(row.content, user.content); assert.equal(row.memory_subject, 'user');
    const supplied = JSON.parse(fixture.calls[0].input);
    assert.deepEqual(supplied.turns.map(t => [t.id, t.role, t.content]), [[user.id, 'user', user.content], [assistant.id, 'assistant', assistant.content]]);
    assert.equal(await run(user, assistant, [input]), 0); assert.equal(rows().length, 1);
    assert.equal(fixture.graph.length, 1); assert.equal(fixture.graph[0][1], user.content);
  });
  await test('quoted, hypothetical, question and assent evidence is rejected', async () => {
    for (const text of ['你刚才说你有一个妹妹', '如果我有一个妹妹就好了', '“我有一个妹妹”是你说的', '我有一个妹妹吗？', '对呀']) {
      scope(); const user = turn('user', text), assistant = turn('assistant', '我有一个妹妹');
      assert.equal(await run(user, assistant, [candidate(user)]), 0, text); assert.equal(rows().length, 0);
    }
  });
  await test('missing, forged, foreign and synthetic evidence cannot save a fact', async () => {
    scope(); const user = turn('user', '我喜欢在周末骑自行车'), assistant = turn('assistant', '好的');
    assert.equal(await run(user, assistant, [candidate(user)], []), 0); assert.equal(fixture.calls.length, 0);
    assert.equal(await run(user, assistant, [candidate(user, 'user', { evidence: [] })]), 0);
    assert.equal(await run(user, assistant, [candidate(user, 'user', { evidence: [{ turn_id: user.id + 9000, quote: user.content }] })]), 0);
    db.prepare('INSERT INTO companions(id,user_id,bot_id) VALUES(?,?,?)').run(cid + 500, uid, 'foreign-evidence');
    const foreign = m.saveConversationTurn(cid + 500, 'user', user.content);
    assert.equal(await run(user, assistant, [candidate(foreign)], [foreign.id]), 0);
    db.prepare('UPDATE companion_conversation_turns SET synthetic=1 WHERE id=?').run(user.id);
    assert.equal(await run(user, assistant, [candidate(user)]), 0); assert.equal(rows().length, 0);
  });
  await test('short explicit correction receives actual candidate IDs and retracts only shown records', async () => {
    scope(); const user = turn('user', '我有一个妹妹'), assistant = turn('assistant', '我记住了');
    assert.equal(await run(user, assistant, [candidate(user)]), 1);
    const old = rows()[0]; const correction = turn('user', '我没有妹妹'), reply = turn('assistant', '之前记错了');
    assert.equal(await run(correction, reply, [candidate(correction, 'user', { replaces_memory_ids: [old.id] })]), 1);
    assert.equal(db.prepare('SELECT memory_status FROM companion_memories WHERE id=?').get(old.id).memory_status, 'contradicted');
    const supplied = JSON.parse(fixture.calls.at(-1).input);
    assert.ok(supplied.existing_memories.some(row => row.id === old.id && row.subject === 'user'));
    const currentCount = rows().length;
    const next = turn('user', '我喜欢在周末骑自行车');
    assert.equal(await run(next, reply, [candidate(next, 'user', { replaces_memory_ids: [999999] })]), 0);
    assert.equal(rows().length, currentCount);
  });
  await test('a valid but undisplayed correction target cannot be selected by the model', async () => {
    scope();
    const original = turn('user', '我有一个妹妹');
    const grounded = (t, importance) => m.saveGroundedMemory({ companionId: cid, userId: uid, memoryType: 'fact',
      subject: 'user', evidence: [{ turn_id: t.id, quote: t.content }], allowedTurnIds: [t.id],
      content: t.content, importance, expectedRecallRevision: 0 });
    const hidden = grounded(original, 4).memory;
    for (let i = 0; i < 20; i++) assert.equal(grounded(turn('user', '我喜欢合成活动' + i), 8).action, 'inserted');
    const correction = turn('user', '我没有妹妹'), reply = turn('assistant', '明白了');
    assert.equal(await run(correction, reply, [candidate(correction, 'user', { replaces_memory_ids: [hidden.id] })]), 0);
    const supplied = JSON.parse(fixture.calls.at(-1).input);
    assert.equal(supplied.existing_memories.length, 20);
    assert.ok(!supplied.existing_memories.some(row => row.id === hidden.id));
    assert.equal(db.prepare('SELECT memory_status FROM companion_memories WHERE id=?').get(hidden.id).memory_status, 'active');
  });
  await test('scene updates remain separate from fact acceptance and retain empty/failure behavior', async () => {
    scope(); const user = turn('user', '我们现在去咖啡馆吧'), assistant = turn('assistant', '好');
    const options = { turnIds: [user.id, assistant.id] };
    fixture.output = { memories: [], current_scene: '咖啡馆' };
    assert.equal(await extract(cid, uid, user.content, assistant.content, options), 0);
    assert.equal(m.getCompanionById(cid).current_scene, '咖啡馆');
    fixture.output = { memories: [], current_scene: '' };
    await extract(cid, uid, user.content, assistant.content, options);
    assert.equal(m.getCompanionById(cid).current_scene, '咖啡馆');
    fixture.onModel = () => { throw new Error('synthetic model unavailable'); };
    await extract(cid, uid, user.content, assistant.content, options);
    assert.equal(m.getCompanionById(cid).current_scene, '日常');
  });
  await test('revocation while extraction is pending rejects results and raw jokes cannot bypass evidence', async () => {
    scope(); const user = turn('user', '我喜欢在周末骑自行车'), assistant = turn('assistant', '好的');
    const old = m.saveMemory({ companionId: cid, userId: uid, memoryType: 'fact', content: '合成旧事实' });
    fixture.onModel = () => m.softDeleteMemory(old, cid);
    assert.equal(await run(user, assistant, [candidate(user)]), 0);
    assert.equal(rows().length, 1); assert.equal(fixture.graph.length, 0);
    fixture.onModel = () => {};
    const fresh = turn('user', '我们聊个不一样的话题吧');
    assert.equal(await run(fresh, assistant, [{ memory_type: 'inside_joke', content: '无证据的暗号', importance: 8 }]), 0);
  });
  await test('fresh profile notes derive only from verified user evidence in the supplied turns', async () => {
    scope(); const user = turn('user', '我喜欢在周末骑自行车'), assistant = turn('assistant', '我有一个妹妹');
    m.upsertUserProfile(uid, cid, { notes: '旧的未证明画像' });
    await run(user, assistant, [candidate(user), candidate(assistant, 'companion')]);
    const before = fixture.calls.length;
    fixture.output = { notes: '模型想写的角色妹妹' };
    await profile(cid, uid, user.content, { turnIds: [user.id, assistant.id] });
    assert.equal(fixture.calls.length, before, 'profile must not make another unsupported inference call');
    const recalled = m.getUserProfileForRecall(uid, cid);
    assert.equal(recalled.notes, user.content);
    assert.ok(!recalled.notes.includes('妹妹') && !recalled.notes.includes('旧的'));
  });
} finally {
  db.close();
  process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
}
