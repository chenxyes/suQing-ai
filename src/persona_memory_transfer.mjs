/** Portable memory records. JSON declares history; only explicit offline review trusts it. */
import { validateMemoryEvidence } from './memory_provenance.mjs';
import { filterForStorage } from './privacy_filter.mjs';
import { isMemoryRecallable, memorySourceIds, filterRecallableMemoryRows } from './memory_admission.mjs';

export const MEMORY_FIELDS = ['id', 'memory_type', 'memory_layer', 'content', 'importance', 'memory_weight', 'memory_status',
  'memory_source', 'memory_subject', 'memory_evidence', 'memory_origin', 'origin_metadata', 'pinned', 'locked',
  'do_not_mention', 'recall_blocked', 'sensitive_flag', 'created_at', 'updated_at', 'last_used_at', 'use_count',
  'decay_score', 'keywords', 'source_memory_ids', 'source_recall_revision', 'conflict_of', 'compacted_into', 'embedding', 'embedding_meta'];
const TURN_FIELDS = ['id', 'role', 'content', 'topic', 'created_at', 'synthetic', 'import_unverified'];
const TYPES = new Set(['fact', 'preference', 'event', 'emotion', 'image', 'daily_summary', 'weekly_summary', 'monthly_summary']);
const FLAGS = ['pinned', 'locked', 'do_not_mention', 'recall_blocked', 'sensitive_flag'];
const INTEGER_FIELDS = ['importance', 'memory_weight', 'use_count', 'source_recall_revision', 'conflict_of', 'compacted_into'];
const privateKey = key => /^(?:accountid|userid|companionid|botid|email|authorization)$|(?:apikey|token|secrets?|password)$/
  .test(key.replace(/[_-]/g, '').toLowerCase());
const privateText = text => {
  const filtered = filterForStorage(text);
  return !filtered.store || filtered.text !== text
    || /api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|\btoken\s*[:=]|password|secrets?|authorization|bearer\s|(?:account|user|companion|bot)[_-]?id|\bemail\b|\bsk-[a-z0-9]/i.test(text);
};
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const metadata = value => {
  try { const parsed = parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { declared: parsed }; }
  catch { return { declared: value }; }
};
function safeMetadata(value) {
  if (Array.isArray(value)) return value.map(safeMetadata);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !privateKey(key) && !['__proto__', 'prototype', 'constructor'].includes(key))
    .map(([key, item]) => [key, safeMetadata(item)]));
  return typeof value === 'string' && privateText(value) ? '[redacted]' : value;
}
function safeMetadataText(value) {
  if (value == null) return null;
  try { return JSON.stringify(safeMetadata(parse(value))); }
  catch { return privateText(String(value)) ? JSON.stringify({ redacted: true }) : String(value); }
}
function safeEvidenceText(value) {
  if (value == null) return null;
  try {
    const items = parse(value);
    if (!Array.isArray(items)) return safeMetadataText(value);
    return JSON.stringify(items.map(item => item && typeof item === 'object'
      ? { turn_id: item.turn_id, ...(['user', 'assistant'].includes(item.role) ? { role: item.role } : {}), quote: item.quote }
      : null));
  } catch { return safeMetadataText(value); }
}
const reference = value => value == null || (Number.isSafeInteger(value) && value !== 0);
function ids(value) {
  if (value == null) return null;
  const list = parse(value);
  if (!Array.isArray(list) || !list.every(id => Number.isSafeInteger(id) && id !== 0)) throw new Error('invalid_memory_references');
  return list;
}
function evidence(value) {
  if (value == null) return null;
  const list = parse(value);
  if (!Array.isArray(list) || !list.every(item => item && reference(item.turn_id) && item.turn_id != null && typeof item.quote === 'string')) {
    throw new Error('invalid_memory_evidence');
  }
  return list;
}

function selectedColumns(db, table, fields, defaults = {}) {
  const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
  return fields.map(field => present.has(field) ? field : `${Object.hasOwn(defaults, field) ? defaults[field] : 'NULL'} AS ${field}`).join(',');
}
const hasTable = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);

export function readMemoryTransfer(db, companionId) {
  const owner = db.prepare('SELECT user_id FROM companions WHERE id=?').get(companionId);
  const rows = [], turns = [];
  const memoryColumns = selectedColumns(db, 'companion_memories', MEMORY_FIELDS, {
    memory_type: "'fact'", memory_layer: "'event'", memory_weight: 3, importance: 5,
    memory_status: "'active'", memory_subject: "'unknown'", memory_origin: "'unknown'", memory_source: "'auto'",
    pinned: 0, locked: 0, do_not_mention: 0, recall_blocked: 0, sensitive_flag: 0, use_count: 0, decay_score: 1,
  });
  const page = db.prepare(`SELECT ${memoryColumns} FROM companion_memories WHERE companion_id=? AND user_id=? AND id>? ORDER BY id LIMIT 256`);
  let after = 0;
  for (;;) {
    const batch = page.all(companionId, owner.user_id, after);
    if (!batch.length) break;
    for (const row of batch) {
      row.embedding = row.embedding == null ? null : { encoding: 'base64', data: row.embedding.toString('base64') };
      row.embedding_meta = safeMetadataText(row.embedding_meta);
      row.origin_metadata = safeMetadataText(row.origin_metadata);
      row.memory_evidence = safeEvidenceText(row.memory_evidence);
      rows.push(row);
    }
    after = batch.at(-1).id;
  }
  if (hasTable(db, 'companion_conversation_turns')) {
    const turnColumns = selectedColumns(db, 'companion_conversation_turns', TURN_FIELDS, { synthetic: 0, import_unverified: 0 });
    const turnPage = db.prepare(`SELECT ${turnColumns} FROM companion_conversation_turns WHERE companion_id=? AND id>? ORDER BY id LIMIT 256`);
    after = 0;
    for (;;) {
      const batch = turnPage.all(companionId, after);
      if (!batch.length) break;
      turns.push(...batch);
      after = batch.at(-1).id;
    }
  }
  const barrier = (hasTable(db, 'memory_recall_barriers') && db.prepare('SELECT revision,revoked_at,turn_id_cutoff FROM memory_recall_barriers WHERE companion_id=? AND user_id=?')
    .get(companionId, String(owner.user_id))) || { revision: 0, revoked_at: null, turn_id_cutoff: 0 };
  return { core_memories: rows, evidence_turns: turns, recall_barrier: barrier };
}

export function validateMemoryTransfer(payload) {
  try {
    const rows = payload.core_memories || [], turns = payload.evidence_turns || [];
    if (!Array.isArray(turns)) throw new Error('evidence_turns_must_be_array');
    for (const list of [rows, turns]) {
      const unique = new Set();
      for (const row of list) {
        if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || unique.has(row.id)) throw new Error('invalid_or_duplicate_transfer_id');
        unique.add(row.id);
      }
    }
    for (const turn of turns) {
      if (!['user', 'assistant', 'system'].includes(turn.role) || typeof turn.content !== 'string'
        || ![0, 1].includes(turn.synthetic) || ![0, 1, null, undefined].includes(turn.import_unverified)
        || (turn.created_at != null && typeof turn.created_at !== 'string') || (turn.topic != null && typeof turn.topic !== 'string')) throw new Error('invalid_evidence_turn');
    }
    for (const row of rows) {
      if (!TYPES.has(row.memory_type) || typeof row.content !== 'string' || !row.content.trim()
        || !['user', 'companion', 'shared', 'unknown'].includes(row.memory_subject || 'unknown')) throw new Error('invalid_memory_record');
      if (FLAGS.some(key => row[key] != null && ![0, 1].includes(row[key]))) throw new Error('invalid_memory_flag');
      if (INTEGER_FIELDS.some(key => row[key] != null && !Number.isSafeInteger(row[key]))) throw new Error('invalid_memory_integer');
      if (row.importance != null && (row.importance < 1 || row.importance > 10)) throw new Error('invalid_memory_importance');
      if (row.decay_score != null && (typeof row.decay_score !== 'number' || !Number.isFinite(row.decay_score))) throw new Error('invalid_memory_decay');
      for (const key of MEMORY_FIELDS.filter(key => !['id', 'embedding', ...FLAGS, ...INTEGER_FIELDS, 'decay_score'].includes(key))) {
        if (row[key] != null && typeof row[key] !== 'string') throw new Error('invalid_memory_text_field');
      }
      // Legacy malformed evidence/reference JSON is kept as inert text, never silently approved.
      if (row.embedding != null && (row.embedding.encoding !== 'base64' || typeof row.embedding.data !== 'string'
        || Buffer.from(row.embedding.data, 'base64').toString('base64') !== row.embedding.data)) throw new Error('invalid_embedding_encoding');
    }
    const barrier = payload.recall_barrier;
    if (barrier && (!Number.isSafeInteger(barrier.revision) || barrier.revision < 0
      || !Number.isSafeInteger(barrier.turn_id_cutoff) || barrier.turn_id_cutoff < 0
      || (barrier.revoked_at != null && typeof barrier.revoked_at !== 'string'))) throw new Error('invalid_recall_barrier');
    return null;
  } catch (error) { return error.message; }
}

export function importMemoryTransfer(db, companionId, userId, payload, { trustReviewedHistory = false } = {}) {
  const isV2 = payload.schema === 'xiyu_companion_export_v2';
  const turnMap = new Map(), memoryMap = new Map(), importedTurns = new Map();
  const verifiedIds = new Set(), derivedCandidates = new Set();
  const rows = payload.core_memories || [], now = new Date().toISOString();
  let quarantined = 0;
  if (isV2) {
    const insertTurn = db.prepare(`INSERT INTO companion_conversation_turns(companion_id,role,content,topic,created_at,synthetic,import_unverified) VALUES(?,?,?,?,?,?,?)`);
    for (const turn of [...(payload.evidence_turns || [])].sort((a, b) => a.id - b.id)) {
      const unverified = trustReviewedHistory ? (turn.import_unverified || 0) : 1;
      const id = Number(insertTurn.run(companionId, turn.role, turn.content, turn.topic ?? null, turn.created_at ?? now, turn.synthetic, unverified).lastInsertRowid);
      turnMap.set(turn.id, id); importedTurns.set(id, { ...turn, id, import_unverified: unverified });
    }
  }
  const insert = db.prepare('INSERT INTO companion_memories(companion_id,user_id,memory_type,content) VALUES(?,?,?,?)');
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], oldId = isV2 ? row.id : index + 1;
    memoryMap.set(oldId, Number(insert.run(companionId, userId, isV2 ? row.memory_type : 'fact', row.content).lastInsertRowid));
  }
  const columns = MEMORY_FIELDS.filter(key => key !== 'id');
  const update = db.prepare(`UPDATE companion_memories SET ${columns.map(key => `${key}=@${key}`).join(',')} WHERE id=@id`);
  for (let index = 0; index < rows.length; index++) {
    const original = rows[index], oldId = isV2 ? original.id : index + 1;
    const row = Object.fromEntries(columns.map(key => [key, original[key] ?? null]));
    Object.assign(row, { id: memoryMap.get(oldId), memory_type: isV2 ? original.memory_type : 'fact',
      memory_subject: isV2 ? original.memory_subject || 'unknown' : 'unknown',
      memory_status: original.memory_status || 'active', memory_origin: isV2 ? original.memory_origin || 'unknown' : 'unknown',
      memory_source: original.memory_source || 'import', memory_layer: original.memory_layer || 'event',
      importance: original.importance ?? 5, memory_weight: original.memory_weight ?? 3,
      created_at: original.created_at ?? now, embedding: isV2 && original.embedding ? Buffer.from(original.embedding.data, 'base64') : null,
      embedding_meta: isV2 ? safeMetadataText(original.embedding_meta) : null });
    let unresolved = false, checked = null;
    const remap = (id, map) => {
      if (id == null) return null;
      if (map.has(id)) return map.get(id);
      unresolved = true; return id < 0 ? id : -id;
    };
    try {
      const sourceIds = ids(original.source_memory_ids);
      row.source_memory_ids = sourceIds == null ? null : JSON.stringify(sourceIds.map(id => remap(id, memoryMap)));
    } catch { unresolved = true; }
    row.conflict_of = remap(original.conflict_of, memoryMap);
    row.compacted_into = remap(original.compacted_into, memoryMap);
    if (isV2) {
      try {
        const originalEvidence = evidence(original.memory_evidence);
        const remapped = originalEvidence?.map(item => ({ turn_id: remap(item.turn_id, turnMap),
          ...(['user', 'assistant'].includes(item.role) ? { role: item.role } : {}), quote: item.quote }));
        row.memory_evidence = remapped == null ? null : JSON.stringify(remapped);
        const turns = (remapped || []).map(item => importedTurns.get(item.turn_id)).filter(turn => turn && !turn.import_unverified);
        checked = validateMemoryEvidence({ subject: row.memory_subject, evidence: remapped, turns });
      } catch { unresolved = true; }
    } else row.memory_evidence = null;
    const unproven = row.memory_subject !== 'unknown' && (!checked || checked.content !== row.content);
    const blocked = !isV2 || !trustReviewedHistory || unresolved || unproven;
    row.recall_blocked = original.recall_blocked || blocked ? 1 : 0;
    const originMetadata = safeMetadata(metadata(original.origin_metadata));
    if (Array.isArray(originMetadata.turn_ids)) {
      originMetadata.declared_turn_ids = originMetadata.turn_ids;
      originMetadata.turn_ids = originMetadata.turn_ids.map(id => remap(id, turnMap));
      if (unresolved) row.recall_blocked = 1;
    }
    row.origin_metadata = JSON.stringify({ ...originMetadata,
      transfer_import: { schema: payload.schema, trust: trustReviewedHistory ? 'reviewed' : 'unverified',
        declared_recall_blocked: original.recall_blocked ?? 0, unresolved_references: unresolved,
        evidence_validated: !!checked && checked.content === row.content } });
    if (checked?.content === row.content) verifiedIds.add(row.id);
    // Compacted summaries retain their subject but are not verbatim quotes.
    // Defer proof until every mapped source has been imported and checked.
    if (isV2 && trustReviewedHistory && !original.recall_blocked && !unresolved && unproven
      && row.memory_evidence == null && (row.memory_layer === 'summary' || /_summary$/.test(row.memory_type))
      && memorySourceIds(row.source_memory_ids)?.length) derivedCandidates.add(row.id);
    if (row.recall_blocked) quarantined++;
    update.run(row);
  }
  const barrier = isV2 ? payload.recall_barrier : null;
  const revision = barrier?.revision ?? 0;
  const cutoff = [...turnMap].reduce((highest, [oldId, id]) => oldId <= (barrier?.turn_id_cutoff ?? 0) ? Math.max(highest, id) : highest, 0);
  if (barrier) db.prepare('INSERT INTO memory_recall_barriers(companion_id,user_id,revision,revoked_at,turn_id_cutoff) VALUES(?,?,?,?,?)')
    .run(companionId, String(userId), revision, barrier.revoked_at ?? now, cutoff);
  if (derivedCandidates.size) {
    const records = db.prepare('SELECT * FROM companion_memories WHERE companion_id=? AND user_id=?').all(companionId, userId)
      .map(row => derivedCandidates.has(row.id) ? { ...row, recall_blocked: 0 } : row);
    const byId = new Map(records.map(row => [row.id, row]));
    const admitted = new Set(filterRecallableMemoryRows(records, {
      recallRevision: revision, hasRevocations: revision > 0 || records.some(row => !isMemoryRecallable(row)),
    }).map(row => row.id));
    const memo = new Map(), visiting = new Set();
    const proven = (id, subject) => {
      const row = byId.get(id);
      if (!admitted.has(id) || row?.memory_subject !== subject || subject === 'unknown' || visiting.has(id)) return false;
      if (memo.has(id)) return memo.get(id);
      if (!verifiedIds.has(id) && !derivedCandidates.has(id)) return false;
      visiting.add(id);
      const sources = memorySourceIds(row.source_memory_ids);
      const valid = sources !== false && (sources || []).every(sourceId => proven(sourceId, subject));
      visiting.delete(id); memo.set(id, valid);
      return valid;
    };
    for (const id of derivedCandidates) {
      const row = byId.get(id);
      if (!proven(id, row.memory_subject)) continue;
      const origin = JSON.parse(row.origin_metadata);
      origin.transfer_import.derived_sources_validated = true;
      db.prepare('UPDATE companion_memories SET recall_blocked=0,origin_metadata=? WHERE id=?')
        .run(JSON.stringify(origin), id);
      quarantined--;
    }
  }
  return { importedMemories: rows.length, importedEvidenceTurns: turnMap.size, quarantinedMemories: quarantined,
    warnings: quarantined ? ['Imported history contains quarantined records; declared subjects are not proof of historical truth.'] : [] };
}
