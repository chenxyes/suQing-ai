/**
 * memory_v2.mjs
 * Memory v3 utilities: layer normalization, sensitivity filter,
 * decay scoring, recall ranking, and deduplication.
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { getRecallableMemories, getMemoryRecallBarrier } from './db.mjs';
import { isMemoryRecallable } from './memory_admission.mjs';
import { embedTextWithDescriptor } from './ai.mjs';
import { memoryDecayScore } from './memory_retrieval.mjs';
import { validMemoryVector, storedMemoryVector, sameEmbeddingSpace, memoryCosine } from './memory_vectors.mjs';

// ─── Allowed enumerations ──────────────────────────────────────────────────────

export const MEMORY_LAYERS = [
  'core_persona', 'relationship_rule', 'user_fact',
  'preference', 'event', 'emotion', 'summary',
];

export const MEMORY_STATUSES = ['active', 'archived', 'contradicted', 'deleted'];

export const MEMORY_SOURCES = ['auto', 'user', 'system', 'summary', 'reflection', 'imported'];

// Map legacy memory_type → memory_layer for backward compat display
const LEGACY_TYPE_TO_LAYER = {
  fact:            'user_fact',
  preference:      'preference',
  event:           'event',
  emotion:         'emotion',
  image:           'event',
  daily_summary:   'summary',
  weekly_summary:  'summary',
  monthly_summary: 'summary',
};

export function normalizeMemoryLayer(layer) {
  if (MEMORY_LAYERS.includes(layer)) return layer;
  if (LEGACY_TYPE_TO_LAYER[layer]) return LEGACY_TYPE_TO_LAYER[layer];
  return 'event';
}

export function normalizeMemoryWeight(weight) {
  const n = Number(weight);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(0, Math.round(n)));
}

// ─── Sensitive content filter ─────────────────────────────────────────────────
// v1.20 (PR2): 单一真源迁移到 src/privacy_filter.mjs（身份证 GB 校验 / 银行卡
// Luhn / 手机号·住址·学校班级脱敏），这里 re-export 保持既有调用方
// （diary / relational_diary / thoughts / reflection）零改动。
export { isSensitiveMemoryContent, sanitizeMemoryContent } from './privacy_filter.mjs';

// ─── Decay score ──────────────────────────────────────────────────────────────

/**
 * Compute a decay score in [0, 1] for a memory row.
 * locked=1 or pinned=1 → always 1.0
 * weight >= 4 → slow decay (half-life 90 days)
 * weight <= 1 → fast decay (half-life 14 days)
 * others → half-life 45 days
 */
export function computeMemoryDecay(memory, now = new Date()) {
  return memoryDecayScore(memory, now);
}

// ─── Recall ranking ───────────────────────────────────────────────────────────

/**
 * Re-rank a list of recalled memories using weight, decay, recency, and context match.
 * Returns sorted array (highest relevance first).
 */
export function rankMemoriesForRecall(memories, context = '') {
  const ctx = (context || '').toLowerCase();

  return memories
    .filter(isMemoryRecallable)
    .map(m => {
      const decay   = computeMemoryDecay(m);
      const weight  = normalizeMemoryWeight(m.memory_weight ?? 3) / 5;
      const imp     = ((m.importance ?? 5) / 10);
      const pin     = m.pinned  ? 0.15 : 0;
      const locked  = m.locked  ? 0.10 : 0;

      // context keyword boost
      let ctxBoost = 0;
      if (ctx && m.content) {
        const words = ctx.replace(/[^一-龥a-zA-Z0-9]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
        if (words.some(w => m.content.includes(w))) ctxBoost = 0.20;
      }

      const score = weight * 0.3 + imp * 0.2 + decay * 0.2 + pin + locked + ctxBoost;
      return { ...m, _recall_score: score };
    })
    .sort((a, b) => b._recall_score - a._recall_score);
}

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Simple deduplication: returns a subset where content is not "too similar".
 * Only identical content with the same explicit subject and scope can collapse.
 * Unknown legacy ownership is never inferred from textual similarity.
 */
export function dedupeMemories(memories) {
  const keep = [];
  for (const m of memories.filter(isMemoryRecallable)) {
    const isDup = keep.some(k => {
      if (k.companion_id !== m.companion_id || k.user_id !== m.user_id) return false;
      if (k.memory_layer !== m.memory_layer) return false;
      if (!sameKnownSubject(k, m)) return false;
      return Boolean(k.content) && k.content === m.content;
    });
    if (!isDup) keep.push(m);
  }
  return keep;
}

function knownSubject(memory) {
  const subject = memory.memory_subject ?? memory.subject;
  return ['user', 'companion', 'shared'].includes(subject) ? subject : null;
}

function sameKnownSubject(a, b) {
  const subject = knownSubject(a);
  return subject !== null && subject === knownSubject(b);
}

function tokenSimilarity(a, b) {
  if (!a || !b) return 0;
  const ta = new Set(a.replace(/[^一-龥a-zA-Z0-9]/g, ' ').split(/\s+/).filter(Boolean));
  const tb = new Set(b.replace(/[^一-龥a-zA-Z0-9]/g, ' ').split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) { if (tb.has(t)) common++; }
  return common / Math.max(ta.size, tb.size);
}

// ─── Decay writeback ──────────────────────────────────────────────────────────

/**
 * Returns true if the new decay score differs enough to be worth writing back.
 */
export function shouldWriteBackDecay(memory, newDecay) {
  if (memory.locked || memory.pinned) return false;
  const stored = typeof memory.decay_score === 'number' ? memory.decay_score : 1.0;
  return Math.abs(stored - newDecay) >= 0.02;
}

/**
 * Batch-compute and write back decay scores to the DB.
 * Processes up to batchSize active, non-locked, non-pinned memories at a time.
 */
export function applyMemoryDecayBatch(db, options = {}) {
  const batchSize = Math.min(1000, Math.max(1, Math.trunc(Number(options.batchSize) || 200)));
  const afterId = options.afterId ?? 0;
  const upperId = options.upperId ?? Number.MAX_SAFE_INTEGER;
  const now = options.now ?? new Date();

  const rows = db.prepare(`
    SELECT id, companion_id, memory_weight, memory_status, locked, pinned,
           last_used_at, created_at, decay_score
    FROM companion_memories
    WHERE memory_status = 'active'
      AND id > ? AND id <= ?
      AND COALESCE(do_not_mention, 0) = 0
      AND COALESCE(recall_blocked, 0) = 0
      AND (locked IS NULL OR locked = 0)
      AND (pinned IS NULL OR pinned = 0)
    ORDER BY id ASC
    LIMIT ?
  `).all(afterId, upperId, batchSize);

  const update = db.prepare(`
    UPDATE companion_memories SET decay_score = ?, updated_at = ? WHERE id = ?
  `);

  const runBatch = db.transaction((rows) => {
    let written = 0;
    for (const row of rows) {
      const newDecay = computeMemoryDecay(row, now);
      if (shouldWriteBackDecay(row, newDecay)) {
        update.run(newDecay, now.toISOString(), row.id);
        written++;
      }
    }
    return written;
  });

  try {
    const written = runBatch(rows);
    log('info', `[MemoryDecay] 批次衰减写回 checked=${rows.length} written=${written}`);
    const nextCursor = rows.at(-1)?.id ?? afterId;
    return { checked: rows.length, written, nextCursor, done: rows.length < batchSize || nextCursor >= upperId };
  } catch (e) {
    log('error', `[MemoryDecay] 批次写回失败: ${e.message}`);
    throw e;
  }
}

// ─── Semantic dedup ───────────────────────────────────────────────────────────

const EMBEDDING_SIM_THRESHOLD = Number(process.env.MEMORY_EMBEDDING_SIM_THRESHOLD) || 0.86;

/**
 * Find an existing memory whose embedding is cosine-similar to the given content.
 * Falls back to token similarity if embedding unavailable.
 * Returns the matching memory row or null.
 */
export async function findSimilarMemoryByEmbedding(companionId, content, options = {}) {
  const layer = options.layer;
  const threshold = options.threshold ?? EMBEDDING_SIM_THRESHOLD;
  const subject = knownSubject(options);

  if (!content || !companionId || !subject) return null;
  const revision = options.expectedRecallRevision ?? getMemoryRecallBarrier(companionId, options.userId).revision;

  let queryEmb = null;
  try {
    queryEmb = await embedTextWithDescriptor(content);
  } catch { /* embedding unavailable → use token fallback */ }
  if (getMemoryRecallBarrier(companionId, options.userId).revision !== revision) return null;

  const candidates = getRecallableMemories(companionId, options.userId)
    .filter(row => knownSubject(row) === subject)
    .filter(row => !layer || row.memory_layer === layer)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 500);

  if (candidates.length === 0) return null;

  if (validMemoryVector(queryEmb, content)) {
    let bestSim = -1, bestRow = null;
    for (const row of candidates) {
      const rowEmb = storedMemoryVector(row);
      if (!rowEmb || !sameEmbeddingSpace(queryEmb.descriptor, rowEmb.descriptor)) continue;
      const sim = memoryCosine(queryEmb.vector, rowEmb.vector);
      if (sim == null) continue;
      if (sim > bestSim) { bestSim = sim; bestRow = row; }
    }
    if (bestSim >= threshold) return bestRow;
  }

  // Token fallback
  for (const row of candidates) {
    if (tokenSimilarity(row.content || '', content) > 0.7) return row;
  }
  return null;
}

/**
 * Compatibility helper: prepare a candidate without modifying an existing fact.
 * Grounded DB admission owns canonical exact dedup and evidence validation.
 */
export async function addOrMergeMemory(companionId, memoryInput, options = {}) {
  const expectedRecallRevision = options.expectedRecallRevision
    ?? getMemoryRecallBarrier(companionId, options.userId).revision;
  const layer = normalizeMemoryLayer(memoryInput.memory_layer || memoryInput.memoryType || 'event');
  const content = memoryInput.content;

  if (!content) return { action: 'skip', reason: 'empty_content' };

  if (getMemoryRecallBarrier(companionId, options.userId).revision !== expectedRecallRevision) {
    return { action: 'skip', reason: 'recall_revision_changed' };
  }

  return { action: 'insert', memory: { ...memoryInput, memory_layer: layer } };
}

/**
 * Preserve candidates for grounded admission. Pre-validation fuzzy filtering can
 * swallow a different subject's fact or strengthen unsupported legacy content.
 */
export function filterNewMemoriesAgainstExisting(newMemories) {
  return [...newMemories];
}
