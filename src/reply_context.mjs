/** Pure evidence packet shared by generation and review. No inferred facts or IO. */
import { isMemoryRecallable, memorySourceIds } from './memory_admission.mjs';
import { readStoredMemoryEvidence, MEMORY_SUBJECTS } from './memory_provenance.mjs';
import { filterForStorage } from './privacy_filter.mjs';

const EVENT_STATES = new Set(['open', 'resolved', 'stale', 'dismissed', 'cancelled', 'completed', 'pending']);
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value.trim() : '';
const id = value => Number.isSafeInteger(value) && value > 0 ? String(value)
  : typeof value === 'string' && /^[\w.-]{1,120}$/.test(value) ? value : null;
const stamp = value => typeof value === 'string' && value.length <= 40 ? value : null;

function sameScope(row, companionId, userId, requireOwner = false) {
  if (companionId != null && (requireOwner || row.companion_id != null)
      && String(row.companion_id) !== String(companionId)) return false;
  if (userId != null && (requireOwner || row.user_id != null)
      && String(row.user_id) !== String(userId)) return false;
  return true;
}

function eventPastDue(value, now) {
  if (!value) return null;
  // A YYYY-MM-DD request covers that entire Shanghai day; midnight is not its deadline.
  const due = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? Date.parse(`${value}T23:59:59.999+08:00`)
    : Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value.replace(' ', 'T') + 'Z');
  return Number.isFinite(due) ? due < now : null;
}

/**
 * Callers pass admitted recall/profile rows, not management-reader results.
 * Optional scope IDs defensively reject mixed-tenant rows. Historical quotes are
 * attributed assertions, not certification that their contents are objectively true.
 */
export function buildReplyContext({ userText = '', history = [], memories = [], userProfile = null,
  events = [], now = Date.now(), companionId = null, userId = null } = {}) {
  const unknown = [];
  const note = (source, reason) => { if (unknown.length < 40) unknown.push({ id: source, reason }); };
  const currentText = text(userText);
  if (currentText.length > 8000) note('current', 'input_too_long');
  const date = new Date(now);
  const day = Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) : null;
  const result = { version: 1, day, current: { id: 'current', role: 'user', text: currentText.slice(0, 8000) },
    history: [], facts: [], events: [], unknown };

  // Never manufacture facts from acknowledgments or an assistant's unanswered question.
  // Keep whole utterances where possible so a clipped negation cannot reverse meaning.
  let historyBudget = 12000;
  const recent = list(history).slice(-24);
  for (let i = recent.length - 1; i >= 0; i--) {
    const row = recent[i];
    if (!row || typeof row !== 'object') continue;
    const source = `turn:${id(row.id ?? row.msg_id) || `recent-${i + 1}`}`;
    if (!sameScope(row, companionId, userId) || Number(row.synthetic || 0) !== 0
        || Number(row.import_unverified || 0) !== 0 || row.memory_origin === 'synthetic') {
      note(source, 'untrusted_history'); continue;
    }
    const role = row.direction === 'in' ? 'user' : row.direction === 'out' ? 'assistant' : row.role;
    const content = text(row.content ?? row.text);
    if (!['user', 'assistant'].includes(role) || !content) { note(source, 'unknown_speaker_or_empty'); continue; }
    if (content.length > 4000 || content.length > historyBudget || result.history.length >= 16) {
      note(source, 'history_budget'); continue;
    }
    result.history.unshift({ id: source, role, text: content, at: stamp(row.created_at ?? row.at) });
    historyBudget -= content.length;
  }

  const rows = list(memories).slice(0, 100).filter(row => row && typeof row === 'object');
  const byId = new Map(rows.map(row => [Number(row.id), row]));
  for (const row of rows) {
    for (const source of list(row.recallSources)) {
      if (!byId.has(source.id) && sameScope(source, companionId, userId, true)) byId.set(source.id, source);
    }
  }
  function admitted(row, visiting = new Set()) {
    if (!isMemoryRecallable(row) || !sameScope(row, companionId, userId, companionId != null || userId != null)) return false;
    const sourceIds = memorySourceIds(row.source_memory_ids);
    if (sourceIds === false || visiting.has(row.id)) return false;
    const next = new Set(visiting).add(row.id);
    // Missing dependencies are withheld rather than silently treated as independent.
    return !sourceIds || sourceIds.every(sourceId => {
      const source = byId.get(sourceId);
      return source && String(source.companion_id) === String(row.companion_id)
        && String(source.user_id) === String(row.user_id) && admitted(source, next);
    });
  }
  let factBudget = 6000;
  const seen = new Set();
  for (const row of rows) {
    const source = `memory:${id(row.id) || 'invalid'}`;
    if (!id(row.id) || seen.has(source)) { note(source, 'invalid_or_duplicate_id'); continue; }
    seen.add(source);
    if (!admitted(row)) { note(source, 'not_admitted'); continue; }
    if (row.memory_layer === 'summary' || /_summary$/.test(row.memory_type || '')) {
      note(source, 'derived_summary'); continue;
    }
    if (!MEMORY_SUBJECTS.has(row.memory_subject)) { note(source, 'unknown_subject'); continue; }
    const evidence = readStoredMemoryEvidence(row);
    if (!evidence) { note(source, 'missing_or_invalid_evidence'); continue; }
    const content = evidence.map(e => row.memory_subject === 'shared' ? `${e.role}：${e.quote}` : e.quote).join('；');
    if (content.length > factBudget || result.facts.length >= 12) { note(source, 'fact_budget'); continue; }
    result.facts.push({ id: source, subject: row.memory_subject, text: content,
      kind: /^[a-z_]{1,40}$/.test(row.memory_type || '') ? row.memory_type : 'fact', at: stamp(row.updated_at ?? row.created_at), evidence });
    factBudget -= content.length;
  }

  // This argument is exclusively the output of getUserProfileForRecall. Preserve
  // its distinct, possibly manual provenance; do not invent quotation evidence.
  if (userProfile && typeof userProfile === 'object' && !Array.isArray(userProfile)) {
    const fields = { user_name: '名字', user_occupation: '职业', user_birthday: '生日',
      user_hobbies: '爱好', important_dates: '重要日期', notes: '对方资料原文' };
    for (const [field, label] of Object.entries(fields)) {
      const value = userProfile[field];
      let content;
      if (field === 'user_hobbies') content = list(value).slice(0, 12).filter(v => typeof v === 'string' && v.length <= 80).join('、');
      else if (field === 'important_dates') content = list(value).slice(0, 12)
        .filter(v => v && text(v.label).length <= 80 && text(v.date).length <= 40)
        .map(v => `${text(v.label)}(${text(v.date)})`).join('、');
      else content = text(value);
      if (!content) continue;
      if (content.length > 1000 || content.length > factBudget) { note(`profile:${field}`, 'profile_budget'); continue; }
      result.facts.push({ id: `profile:${field}`, subject: 'user', text: `${label}：${content}`,
        kind: 'profile', at: null, evidence: [] });
      factBudget -= content.length;
    }
  }

  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  for (const row of list(events).slice(0, 20)) {
    if (!row || typeof row !== 'object') continue;
    const source = `event:${id(row.id) || 'invalid'}`;
    if (!id(row.id) || !sameScope(row, companionId, userId)
        || !EVENT_STATES.has(row.status) || Number(row.synthetic || 0) !== 0) {
      note(source, 'untrusted_event'); continue;
    }
    const title = filterForStorage(text(row.title)).text;
    if (!title || title.length > 500) { note(source, 'invalid_event_title'); continue; }
    const dueAt = stamp(row.due_at ?? row.dueAt);
    result.events.push({ id: source, title, kind: text(row.loop_kind ?? row.kind).slice(0, 50),
      status: row.status, dueAt, createdAt: stamp(row.created_at), resolvedAt: stamp(row.resolved_at),
      resolvedText: filterForStorage(text(row.resolved_text)).text.slice(0, 500), sourceMessageId: id(row.source_message_id),
      overdue: Number.isFinite(nowMs) ? eventPastDue(dueAt, nowMs) : null,
      evidenceStatus: 'event_record_not_user_confirmation' });
  }
  return result;
}
