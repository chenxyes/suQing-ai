/** Explicit opt-in and inert automatic entry points; real temporary DB, no model. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const temp = mkdtempSync(path.join(tmpdir(), 'backfill-smoke-'));
process.env.DB_PATH = path.join(temp, 'fixture.db');
process.env.LOG_DIR = path.join(temp, 'logs');
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const { getDb, markCompanionBackfilled, getCompanionBackfillStatus, countRealUserTurns,
  bulkInsertSyntheticTurns, saveConversationTurn } = await import('../src/db.mjs');
const { decideBackfillAction, maybeAutoBackfill, backfillTimelineForCompanion } = await import('../src/backfill_history.mjs');
const db = getDb(); db.pragma('foreign_keys = OFF');
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; } catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}
try {
  db.prepare("INSERT INTO users(id,wechat_user_id) VALUES(1,'fixture')").run();
  db.prepare("INSERT INTO companions(id,user_id,bot_id,name) VALUES(5,1,'fixture','角色'),(6,1,'fixture','角色二')").run();
  for (const state of [
    { tier: null, userTurns: 0 }, { tier: null, userTurns: 99 },
    { tier: 'thin', userTurns: 10 }, { tier: 'thin', justBound: true }, { tier: 'full', justBound: true },
  ]) await check(`automatic decision remains disabled: ${JSON.stringify(state)}`, () => assert.equal(decideBackfillAction(state), null));
  await check('automatic entry does not generate or persist anything', async () => {
    assert.equal(maybeAutoBackfill({ id: 5, user_id: 1 }, { justBound: true }).skipped, 'automatic-disabled');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM companion_conversation_turns').get().n, 0);
    assert.equal(getCompanionBackfillStatus(5).backfilledAt, null);
  });
  await check('force is not synthetic consent', async () => {
    const result = await backfillTimelineForCompanion({ id: 5, user_id: 1 }, { force: true });
    assert.equal(result.skipped, 'confirmation-required');
  });
  await check('manual duplicate guards still honor persisted tier', async () => {
    markCompanionBackfilled(5, 'thin'); assert.equal(getCompanionBackfillStatus(5).tier, 'thin');
    markCompanionBackfilled(5, 'full');
    const result = await backfillTimelineForCompanion({ id: 5, user_id: 1 }, { confirmSynthetic: true, tier: 'full' });
    assert.equal(result.skipped, 'already-backfilled');
    const thin = await backfillTimelineForCompanion({ id: 5, user_id: 1 }, { confirmSynthetic: true, tier: 'thin' });
    assert.equal(thin.skipped, 'already-backfilled');
  });
  await check('legacy persisted history status is retained without generating more', () => {
    db.prepare('UPDATE companions SET history_backfilled_at=123, history_backfill_tier=NULL WHERE id=6').run();
    assert.equal(getCompanionBackfillStatus(6).tier, 'full');
    assert.equal(decideBackfillAction({ tier: getCompanionBackfillStatus(6).tier, userTurns: 50 }), null);
  });
  await check('real message counter excludes synthetic turns', () => {
    saveConversationTurn(5, 'user', '合成测试中的真实通道消息');
    saveConversationTurn(5, 'user', '合成测试中的另一条消息');
    saveConversationTurn(5, 'assistant', '回应');
    bulkInsertSyntheticTurns(5, [{ created_at: '2026-05-01 12:00:00', role: 'user', content: '虚构互动片段', topic: null }]);
    assert.equal(countRealUserTurns(5), 2);
  });
} finally { db.close(); process.on('exit', () => rmSync(temp, { recursive: true, force: true })); }
console.log(`backfill_auto_smoke: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
