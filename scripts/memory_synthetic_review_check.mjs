/** Independent Task7 review. Offline Node22 --experimental-vm-modules. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Readable, PassThrough } from 'node:stream';
import express from 'express';

const temp = mkdtempSync(path.join(tmpdir(), 'synthetic-review-'));
process.env.DB_PATH = path.join(temp, 'review.db');
process.env.LOG_DIR = path.join(temp, 'logs');
globalThis.fetch = () => { throw new Error('Network forbidden in offline review'); };
const m = await import('../src/db.mjs');
const p = await import('../src/user_profile.mjs');
const graph = await import('../src/event_graph.mjs');
const { MAX_IMPORT_BYTES } = await import('../src/persona_export.mjs');
const db = m.getDb();
db.pragma('foreign_keys = OFF');
let cid = 89000;
const uid = 88000;
function scope() {
  cid++;
  db.prepare('INSERT INTO companions(id,user_id,bot_id) VALUES(?,?,?)').run(cid, uid, `review-${cid}`);
}
const memory = (content, extra = {}) => m.saveMemory({ companionId: cid, userId: uid, memoryType: 'fact', content, ...extra });
const get = id => db.prepare('SELECT * FROM companion_memories WHERE id=?').get(id);
const counts = () => ({
  turns: db.prepare('SELECT COUNT(*) n FROM companion_conversation_turns WHERE companion_id=?').get(cid).n,
  memories: db.prepare('SELECT COUNT(*) n FROM companion_memories WHERE companion_id=?').get(cid).n,
  status: m.getCompanionBackfillStatus(cid),
});
const synthetic = () => m.saveSyntheticHistory({
  companionId: cid, userId: uid, tier: 'full', expectedRecallRevision: 0,
  turns: [{ role: 'user', content: '虚构第一句', created_at: '2026-01-01 12:00:00' },
    { role: 'assistant', content: '虚构第二句', created_at: '2026-01-01 12:00:30' }],
  memoryEvents: [{ content: '虚构第一件事' }, { content: '虚构第二件事' }],
});
const api = readFileSync(new URL('../src/api.mjs', import.meta.url), 'utf8');

try {
  await test('unverified imported turns cannot become context, reflection input, evidence or profile facts', () => {
    scope();
    const real = m.saveConversationTurn(cid, 'user', '今天下雨');
    const imported = db.prepare(`INSERT INTO companion_conversation_turns
      (companion_id,role,content,synthetic,import_unverified,created_at) VALUES (?,'user','我喜欢游戏电脑',0,1,'2099-01-01 00:00:00')`)
      .run(cid).lastInsertRowid;
    assert.deepEqual(m.getConversationContext(cid, 10).map(t => t.id), [real.id]);
    assert.deepEqual(m.getConversationTurnsBetween(cid, '2000-01-01', '2100-01-01').map(t => t.id), [real.id]);
    assert.equal(m.countRealUserTurns(cid), 1);
    assert.deepEqual(m.getMemoryEvidenceTurns(cid, uid, [Number(imported)]), []);
    assert.equal(m.saveGroundedMemory({ companionId: cid, userId: uid, subject: 'user', memoryType: 'fact',
      evidence: [{ turn_id: Number(imported), quote: '我喜欢游戏电脑' }], allowedTurnIds: [Number(imported)],
      expectedRecallRevision: 0 }).action, 'rejected');
    assert.equal(p.computeMessageStats(uid).total, 1);
    assert.equal(p.computeActivityHeatmap(uid).total, 1);
    assert.equal(p.computeInitiationRatio(uid).total_user_messages, 1);
    assert.equal(p.computeUsagePattern(uid).active_days, 1);
    assert.equal(p.computeReplyLength(uid).user_avg, real.content.length);
    assert.equal(p.computeTopicTendency(uid).topics.hobby_game.hits, 0);
    // These query tables without synthetic/import columns and must remain executable.
    assert.doesNotThrow(() => p.computeRelationshipProgress(uid));
    assert.doesNotThrow(() => p.computeOpenLoopStats(uid));
    assert.doesNotThrow(() => p.computeSafetyStats(uid));
  });

  await test('legacy synthetic source cannot be laundered by patching source, content or origin', () => {
    scope();
    const id = memory('我喜欢虚构咖啡', { memorySource: 'synthetic' });
    assert.equal(get(id).memory_origin, 'unknown');
    m.patchMemory(id, cid, { memory_source: 'user', content: '我喜欢虚构茶叶', memory_origin: 'conversation' });
    assert.equal(get(id).memory_origin, 'synthetic');
    assert.equal(get(id).memory_source, 'user');
    assert.equal(m.getRecallableMemories(cid, uid).length, 0);
    assert.equal(memory('派生虚构摘要', { sourceMemoryIds: [id] }), null);
    graph.processMemoryForGraph(cid, get(id).content, id, { memory_origin: 'conversation' });
    assert.deepEqual(graph.getCompanionEventGraph(cid), { entities: [], relations: [] });
  });

  await test('annotation export excludes synthetic and unverified replies as well as their context', () => {
    scope();
    m.saveConversationTurn(cid, 'user', '真实通道问候');
    const real = m.saveConversationTurn(cid, 'assistant', '真实通道回应');
    const insert = db.prepare(`INSERT INTO companion_conversation_turns
      (companion_id,role,content,synthetic,import_unverified,created_at) VALUES (?,'assistant',?,?,?,'2026-01-01 00:00:00')`);
    const syntheticId = Number(insert.run(cid, '虚构标注回应', 1, 0).lastInsertRowid);
    const importedId = Number(insert.run(cid, '导入标注回应', 0, 1).lastInsertRowid);
    for (const id of [real.id, syntheticId, importedId]) {
      m.upsertAnnotation({ companionId: cid, turnId: id, label: 'good' });
    }
    assert.deepEqual(m.listAnnotatableTurns({ companionId: cid }).map(t => t.id), [real.id]);
    assert.deepEqual(m.listAnnotationsForExport().map(r => r.reply), [real.content]);
  });

  for (const stage of ['turns', 'memories']) {
    await test(`mid-${stage} insert failure rolls back the full synthetic batch and history marker`, () => {
      scope();
      const before = counts();
      m.upsertEmotionState(cid, { affection: 23 });
      const emotion = m.getEmotionState(cid);
      const table = stage === 'turns' ? 'companion_conversation_turns' : 'companion_memories';
      const content = stage === 'turns' ? '虚构第二句' : '虚构第二件事';
      db.exec(`CREATE TEMP TRIGGER fail_synthetic_review BEFORE INSERT ON ${table}
        WHEN NEW.content='${content}' BEGIN SELECT RAISE(ABORT,'review_injected_failure'); END`);
      try { assert.throws(synthetic, /review_injected_failure/); }
      finally { db.exec('DROP TRIGGER fail_synthetic_review'); }
      assert.deepEqual(counts(), before);
      assert.deepEqual(m.getEmotionState(cid), emotion);
      assert.deepEqual(synthetic(), { turnCount: 2, memoryCount: 2 });
      assert.equal(m.getRecallableMemories(cid, uid).length, 0);
    });
  }

  await test('actual API handler demands strict consent, forwards it, and returns conflict for stale generation', async () => {
    const start = api.indexOf("router.post('/companions/:id/backfill-history',");
    const end = api.indexOf('\n);', start) + 3;
    assert.ok(start > 0 && end > start);
    let route, imports = 0, opts, outcome = { skipped: 'stale-or-duplicate' };
    const admin = () => {};
    const context = vm.createContext({
      router: { post: (...args) => { route = args; } }, rateLimit: () => () => {}, requireAdmin: admin,
      intId: Number, getCompanionById: () => ({ id: 5, user_id: uid }),
      err: (_res, message, status = 400) => ({ status, message }), ok: (_res, data) => ({ status: 200, data }), log() {},
    });
    const generator = new vm.SyntheticModule(['backfillTimelineForCompanion'], function () {
      this.setExport('backfillTimelineForCompanion', async (_companion, options) => { opts = options; return outcome; });
    }, { context });
    await generator.link(() => {}); await generator.evaluate();
    const routeModule = new vm.SourceTextModule(api.slice(start, end), { context,
      importModuleDynamically: async () => { imports++; return generator; } });
    await routeModule.link(() => {}); await routeModule.evaluate();
    assert.equal(route[2], admin);
    const handler = route.at(-1);
    for (const consent of [undefined, false, 1, 'true']) {
      const result = await handler({ params: { id: '5' }, body: { force: true, confirm_synthetic: consent } }, {});
      assert.equal(result.status, 400); assert.equal(imports, 0);
    }
    const conflict = await handler({ params: { id: '5' }, body: { confirm_synthetic: true } }, {});
    assert.equal(conflict.status, 409); assert.equal(opts.confirmSynthetic, true);
    outcome = { ok: true, synthetic: true, turnCount: 2, memoryCount: 1 };
    const success = await handler({ params: { id: '5' }, body: { confirm_synthetic: true } }, {});
    assert.equal(success.status, 200); assert.equal(success.data.synthetic, true);
  });

  await test('actual import parser registration authenticates first and enforces its byte boundary', async () => {
    const start = api.indexOf("app.post('/api/companions/import', requireAuth, express.json");
    const end = api.indexOf("app.use(express.urlencoded", start);
    assert.ok(start > 0 && end > start);
    let dedicated, general;
    const auth = () => {};
    vm.runInNewContext(api.slice(start, end), {
      app: { post: (...args) => { dedicated = args; }, use: middleware => { general = middleware; } },
      requireAuth: auth, express, MAX_IMPORT_BYTES,
    });
    assert.equal(dedicated[0], '/api/companions/import');
    assert.equal(dedicated[1], auth);
    const parse = async (size, parser, req = null) => {
      if (!req) {
        const body = JSON.stringify({ payload: 'x'.repeat(size - 14) });
        req = Readable.from([Buffer.from(body)]);
        req.complete = false; req.socket = new PassThrough();
        req.once('end', () => { req.complete = true; });
        req.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
        req.method = 'POST'; req.url = '/api/companions/import';
      }
      const error = await new Promise(resolve => parser(req, {}, err => resolve(err)));
      return { error, req };
    };
    const accepted = await parse(MAX_IMPORT_BYTES, dedicated[2]);
    assert.equal(accepted.error, undefined);
    assert.ok(accepted.req.body.payload);
    assert.equal((await parse(0, general, accepted.req)).error, undefined);
    assert.equal((await parse(MAX_IMPORT_BYTES + 1, dedicated[2])).error?.status, 413);
    assert.equal((await parse(2 * 1024 * 1024 + 1, general)).error?.status, 413);
  });
} finally {
  db.close();
  process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
}
