/** Isolated execution ledger; delivery means sent, never psychological success. */
import { randomUUID } from 'node:crypto';
import { getDb, getCompanionById, getActiveWechatBinding } from './db.mjs';
import { filterForStorage } from './privacy_filter.mjs';
import { isBehaviorEnabled as enabled, isBehaviorStopRequested, parseBehaviorFollowupDelay } from './behavior_runtime.mjs';
import { BEHAVIOR_ACTIONS as actions } from './behavior_library.mjs';

const STATE_TTL = 6 * 3600_000;
const LEASE_MS = 5 * 60_000;
const RETRY_MS = 10 * 60_000;
const TASK_GRACE_MS = 6 * 3600_000;
function safeText(value, limit) {
  const result = filterForStorage(value);
  return result.store ? result.text.trim().slice(0, limit) : null;
}
function companionValid(id) {
  return Number.isSafeInteger(Number(id)) && Number(id) > 0 && getCompanionById(id);
}
function canPush(id) {
  const c = companionValid(id);
  if (!c || !Number(c.proactive_enabled) || Number(c.silent_mode) || Number(c.safe_mode)) return false;
  const user = getDb().prepare('SELECT wechat_user_id FROM users WHERE id=?').get(c.user_id);
  if (!user?.wechat_user_id) return false;
  const binding = getActiveWechatBinding(user.wechat_user_id, c.bot_id);
  return !!binding && Number(binding.companion_id) === Number(id);
}
function cleanPlan(plan) {
  if (!plan || !(plan.scenario === 'pause' ? plan.action === 'pause' : actions[plan.scenario]?.includes(plan.action))) return null;
  if (!['normal', 'hurt', 'cold', 'withdrawing', 'repairing', 'normal_with_scar'].includes(plan.arcState)) return null;
  const sourceId = safeText(plan.sourceId, 100), sourceRevision = safeText(plan.sourceRevision, 100);
  if (!sourceId || !sourceRevision) return null;
  return { scenario: plan.scenario, action: plan.action, sourceId, sourceRevision, arcState: plan.arcState, followup: null };
}

export function readBehaviorState(companionId, { now = Date.now() } = {}) {
  if (!enabled() || !companionValid(companionId)) return null;
  const row = getDb().prepare(`SELECT d.* FROM behavior_deliveries d
    LEFT JOIN behavior_state_resets r ON r.companion_id=d.companion_id
    WHERE d.companion_id=? AND d.created_at>? AND d.created_at<=?
      AND (r.reset_at IS NULL OR d.created_at>r.reset_at)
    ORDER BY d.created_at DESC,d.id DESC LIMIT 1`).get(companionId, now - STATE_TTL, now);
  if (!row) {
    // Keep an explicit boundary so short acknowledgments cannot revive an older
    // scenario through the runtime's history fallback. A new scenario supersedes it.
    const reset = getDb().prepare('SELECT reset_at FROM behavior_state_resets WHERE companion_id=? AND reset_at<=?').get(companionId, now);
    return reset ? { scenario: 'pause', action: 'pause', sourceId: 'suqing.pause', sourceRevision: '1', arcState: 'normal', followup: null } : null;
  }
  try { return cleanPlan(JSON.parse(row.plan_json)); } catch { return null; }
}

export function observeBehaviorInput(companionId, userText, { probe = false, safetyLevel = 'none', now = Date.now() } = {}) {
  const unsafe = safetyLevel && safetyLevel !== 'none';
  if (probe || !enabled() || !companionValid(companionId) || (!unsafe && !isBehaviorStopRequested(userText))) return false;
  const db = getDb();
  db.transaction(() => {
    db.prepare(`INSERT INTO behavior_state_resets(companion_id,reset_at) VALUES(?,?)
      ON CONFLICT(companion_id) DO UPDATE SET reset_at=excluded.reset_at`).run(companionId, now);
    db.prepare(`UPDATE behavior_followup_tasks SET status='cancelled',reason=?,lease_token=NULL,lease_until=NULL,updated_at=?
      WHERE companion_id=? AND status IN ('pending','claimed')`).run(unsafe ? 'safety' : 'user_stopped', now, companionId);
  })();
  return true;
}

export function recordBehaviorDelivery({ companionId, turnKey, plan, userText, deliveredText, channel, probe = false, now = Date.now(), inputStartedAt = now } = {}) {
  if (probe || !enabled() || !companionValid(companionId) || !['wechat', 'web'].includes(channel)) return null;
  const clean = cleanPlan(plan);
  const key = safeText(turnKey, 180), context = safeText(userText, 500), text = safeText(deliveredText, 2000);
  if (!clean || !key || context === null || !text || !Number.isFinite(now) || !Number.isFinite(inputStartedAt)) return null;
  const requested = parseBehaviorFollowupDelay(userText);
  if (channel === 'wechat' && requested && requested === plan.followup?.delayMinutes && canPush(companionId) && clean.scenario !== 'pause') {
    clean.followup = { delayMinutes: requested };
  }
  const db = getDb();
  return db.transaction(() => {
    // A newer incoming stop/safety boundary wins over an older in-flight reply.
    // Chat history remains the caller's responsibility; no new plan or timer here.
    const reset = db.prepare('SELECT reset_at FROM behavior_state_resets WHERE companion_id=?').get(companionId);
    if (reset && reset.reset_at >= inputStartedAt) return null;
    const prior = db.prepare('SELECT * FROM behavior_deliveries WHERE companion_id=? AND turn_key=?').get(companionId, key);
    if (prior) return prior;
    const result = db.prepare(`INSERT INTO behavior_deliveries(companion_id,turn_key,plan_json,context_text,delivered_text,channel,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(companionId, key, JSON.stringify(clean), context, text, channel, now);
    if (clean.followup) {
      // An explicit new request replaces the older outstanding request for this companion.
      db.prepare(`UPDATE behavior_followup_tasks SET status='cancelled',reason='superseded',lease_token=NULL,lease_until=NULL,updated_at=?
        WHERE companion_id=? AND status IN ('pending','claimed')`).run(now, companionId);
      const dueAt = now + requested * 60_000;
      db.prepare(`INSERT INTO behavior_followup_tasks(companion_id,delivery_id,due_at,expires_at,updated_at) VALUES(?,?,?,?,?)`)
        .run(companionId, result.lastInsertRowid, dueAt, dueAt + TASK_GRACE_MS, now);
    }
    return db.prepare('SELECT * FROM behavior_deliveries WHERE id=?').get(result.lastInsertRowid);
  })();
}

export function claimDueBehaviorTask(companionId, { now = Date.now() } = {}) {
  if (!enabled() || !companionValid(companionId)) return null;
  const db = getDb();
  return db.transaction(() => {
    db.prepare(`UPDATE behavior_followup_tasks SET status='expired',reason='expired',lease_token=NULL,lease_until=NULL,updated_at=?
      WHERE companion_id=? AND status IN ('pending','claimed') AND expires_at<=?`).run(now, companionId, now);
    if (!canPush(companionId)) {
      db.prepare(`UPDATE behavior_followup_tasks SET status='cancelled',reason='push_disabled',lease_token=NULL,lease_until=NULL,updated_at=?
        WHERE companion_id=? AND status IN ('pending','claimed')`).run(now, companionId);
      return null;
    }
    const row = db.prepare(`SELECT t.*,d.context_text,d.delivered_text AS original_text,d.plan_json
      FROM behavior_followup_tasks t JOIN behavior_deliveries d ON d.id=t.delivery_id
      WHERE t.companion_id=? AND t.due_at<=? AND t.expires_at>? AND t.retry_at<=?
      AND (t.status='pending' OR (t.status='claimed' AND t.lease_until<=?)) ORDER BY t.due_at,t.id LIMIT 1`)
      .get(companionId, now, now, now, now);
    if (!row) return null;
    const token = randomUUID();
    db.prepare(`UPDATE behavior_followup_tasks SET status='claimed',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?`)
      .run(token, now + LEASE_MS, now, row.id);
    return { ...row, status: 'claimed', lease_token: token, lease_until: now + LEASE_MS, attempts: row.attempts + 1 };
  }).immediate();
}

export function isBehaviorTaskCurrent(task, { now = Date.now() } = {}) {
  if (!task || !enabled() || !canPush(task.companion_id)) return false;
  return !!getDb().prepare(`SELECT 1 FROM behavior_followup_tasks WHERE id=? AND companion_id=? AND status='claimed'
    AND lease_token=? AND lease_until>? AND expires_at>?`).get(task.id, task.companion_id, task.lease_token, now, now);
}

export function finishBehaviorTask(task, { status, deliveredText = '', reason = '', now = Date.now() } = {}) {
  if (!task || !['sent', 'partial', 'skipped', 'failed', 'cancelled'].includes(status)) return false;
  const delivered = status === 'sent' || status === 'partial';
  if (delivered && !String(deliveredText).trim()) return false;
  // Privacy rejection must not turn a real send into a retry (duplicate delivery).
  const text = safeText(deliveredText, 2000) || '';
  const finalStatus = delivered ? status : status === 'cancelled' ? status : 'pending';
  return getDb().prepare(`UPDATE behavior_followup_tasks SET status=?,delivered_text=?,reason=?,retry_at=?,lease_token=NULL,lease_until=NULL,updated_at=?
    WHERE id=? AND companion_id=? AND status='claimed' AND lease_token=?`)
    .run(finalStatus, text, safeText(reason, 120) || '', now + RETRY_MS, now, task.id, task.companion_id, task.lease_token).changes === 1;
}
