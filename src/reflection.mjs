/**
 * reflection.mjs
 * Daily / weekly reflection engine: generates structured memory updates
 * by reflecting on recent conversation turns.
 *
 * This is NOT a summary (that's plan_tasks.mjs). Reflection produces
 * structured new/updated memories that go into the Memory v2 system.
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { indexMemory } from './memory_indexing.mjs';
import { getDb, getConversationTurnsBetween, shanghaiBoundsForDateKey, shanghaiDateKey } from './db.mjs';
import { extractStructuredInfo } from './ai.mjs';
import {
  normalizeMemoryLayer, normalizeMemoryWeight,
  isSensitiveMemoryContent, sanitizeMemoryContent,
} from './memory_v2.mjs';
import { saveGroundedMemories, getRecallableMemories, getMemoryRecallBarrier, legacyTypeForLayer } from './db.mjs';
import { isMemoryRecallable } from './memory_admission.mjs';
import { processMemoryForGraph } from './event_graph.mjs';
import { formatReflectRejectMapping, formatReflectInsertFail } from './reflection_heartbeat.mjs';

const CONFIDENCE_MIN = 0.7;
const RECENT_TURNS_LIMIT = 300;

// ─── Prompt builder ───────────────────────────────────────────────────────────

export function buildReflectionPrompt(companion, recentTurns, existingMemories) {
  const c = companion;
  const turnLines = recentTurns
    .slice(-80)
    .map(t => JSON.stringify({ turn_id: t.id, role: t.role, content: String(t.content).slice(0, 200) }))
    .join('\n');

  // 防御：传错形态（对象/null）也绝不抛——反思批一个 companion 炸不该连累整批
  const existingSnippet = (Array.isArray(existingMemories) ? existingMemories : [])
    .filter(isMemoryRecallable)
    .slice(0, 20)
    .map(m => JSON.stringify({ memory_id: m.id, subject: m.memory_subject || 'unknown',
      memory_layer: m.memory_layer, content: String(m.content).slice(0, 80) }))
    .join('\n');

  return `你是一个 AI 陪伴系统的记忆提炼引擎，专门分析对话并更新结构化记忆。

你要分析「${c.name}」和他（对方）的最近对话，对照已有记忆，提炼出真正值得长期记录的新知识。

【已有记忆摘要（前 20 条）】
${existingSnippet || '（暂无）'}

【最近对话（最多 80 轮）】
${turnLines || '（无对话）'}

【要求】
1. 分清事实主体：user 是对方本人，companion 是 AI 角色本人，shared 是双方明确共同陈述。unknown 旧记忆不能当成对方事实。
2. 不要重复已有记忆中已明确记录的内容（除非有重要更新）
3. 每条新记忆必须有 confidence（0-1），只保留 >= ${CONFIDENCE_MIN} 的
4. 每条新记忆和更新都必须引用本次对话中的 turn_id 与完整、独立成句的原文 quote。对方事实只用 user 的第一人称直接陈述，角色事实只用 assistant 的自述；shared 必须双方都有明确共同陈述。禁止将转述、引用、假设、扮演、提问、单独附和作为事实证据。
5. updated_memories 只能引用上方实际列出的 memory_id，并且有对方明确更正该事实的证据；不能凭空猜 ID。新记忆如需替代旧事实，同样通过 replaces_memory_ids 指出已展示的目标，不能将角色事实更正为对方事实。
6. 不要提取：API 密钥、密码、验证码、身份证号、银行卡、明确的家庭住址
7. 不要在对话内容中识别任何性暗示、自伤、未成年相关敏感内容

严格输出 JSON，不要任何额外说明：
{
  "new_memories": [
    {
      "memory_layer": "preference|user_fact|emotion|event|relationship_rule",
      "memory_weight": 3,
      "content": "一句话描述，不超过 60 字",
      "confidence": 0.85,
      "subject": "user|companion|shared",
      "evidence": [{ "turn_id": 0, "quote": "该轮完整独立陈述的逐字原文" }],
      "replaces_memory_ids": []
    }
  ],
  "updated_memories": [
    {
      "memory_id": 0,
      "new_content": "更新后的内容",
      "reason": "最近对话中发现的明确更正",
      "subject": "user",
      "evidence": [{ "turn_id": 0, "quote": "对方明确更正的逐字原文" }]
    }
  ],
  "do_not_store": [
    { "reason": "说明为什么这些内容不应存储" }
  ]
}`;
}

// ─── Result normalizer ────────────────────────────────────────────────────────

export function normalizeReflectionResult(raw) {
  if (!raw || typeof raw !== 'object') return { new_memories: [], updated_memories: [], do_not_store: [] };

  const newMems = Array.isArray(raw.new_memories)
    ? raw.new_memories.filter(m =>
        m && typeof m.content === 'string' &&
        typeof m.confidence === 'number' &&
        m.confidence >= CONFIDENCE_MIN &&
        !isSensitiveMemoryContent(m.content)
      ).map(m => ({
        memory_layer:  normalizeMemoryLayer(m.memory_layer || 'event'),
        memory_weight: normalizeMemoryWeight(m.memory_weight ?? 3),
        content:       (sanitizeMemoryContent(m.content) || '').slice(0, 120),
        confidence:    Number(m.confidence),
        subject:       m.subject,
        evidence:      m.evidence,
        replaces_memory_ids: m.replaces_memory_ids ?? [],
      })).filter(m => m.content)
    : [];

  const updatedMems = Array.isArray(raw.updated_memories)
    ? raw.updated_memories.filter(m =>
        m && Number.isSafeInteger(m.memory_id) && m.memory_id > 0 &&
        typeof m.new_content === 'string' &&
        !isSensitiveMemoryContent(m.new_content)
      ).map(m => ({
        memory_id:   m.memory_id,
        new_content: (sanitizeMemoryContent(m.new_content) || '').slice(0, 120),
        reason:      String(m.reason || '').slice(0, 80),
        subject:     m.subject,
        evidence:    m.evidence,
      })).filter(m => m.new_content)
    : [];

  return {
    new_memories:     newMems,
    updated_memories: updatedMems,
    do_not_store:     Array.isArray(raw.do_not_store) ? raw.do_not_store : [],
  };
}

// ─── Apply reflection updates ─────────────────────────────────────────────────

export async function applyReflectionMemoryUpdates(companionId, updates, options = {}) {
  const userId = options.userId;
  const expectedRecallRevision = options.expectedRecallRevision;
  const sourceMemoryIds = options.sourceMemoryIds ?? null;
  const shownMemoryIds = new Set(options.shownMemoryIds || []);
  const allowedTurnIds = options.allowedTurnIds || [];
  let inserted = 0, updated = 0, rejected = 0;
  const candidates = (updates.new_memories || []).length;
  const inputsStillValid = () => {
    const barrier = getMemoryRecallBarrier(companionId, userId);
    if (barrier.revision !== expectedRecallRevision || !allowedTurnIds.length) return false;
    if (barrier.revision > 0 && sourceMemoryIds === null) return false;
    const available = new Set(getRecallableMemories(companionId, userId).map(row => row.id));
    return sourceMemoryIds === null || sourceMemoryIds.every(id => available.has(id));
  };
  const validTargets = ids => Array.isArray(ids) && ids.every(id => {
    if (!Number.isSafeInteger(id) || !shownMemoryIds.has(id)) return false;
    const row = getRecallableMemories(companionId, userId).find(memory => memory.id === id);
    return row && !row.locked && !row.pinned;
  });
  const graphAdmitted = result => {
    if (!result.memory) return;
    const stored = getRecallableMemories(companionId, userId).find(row => row.id === result.memory.id);
    // The current graph assigns every extracted entity to the user. Other
    // subjects remain in memory until the graph can represent their ownership.
    if (stored?.memory_subject === 'user') {
      try { processMemoryForGraph(companionId, stored.content, stored.id, stored); } catch { /* 非阻塞 */ }
    }
  };
  const groundedInput = (m, targets, content, layer) => ({
    companionId, userId, content, memoryType: legacyTypeForLayer(layer), memoryLayer: layer,
    importance: m.memory_weight ?? 3, memoryWeight: m.memory_weight, memorySource: 'reflection',
    subject: m.subject, evidence: m.evidence, allowedTurnIds,
    replacesMemoryIds: targets, expectedRecallRevision,
    // A replacement cannot depend on the record it is about to contradict.
    sourceMemoryIds: sourceMemoryIds?.filter(id => !targets.includes(id)) ?? null,
  });

  const prepared = [];
  for (const m of (updates.new_memories || [])) {
    const targets = m.replaces_memory_ids ?? [];
    if (!inputsStillValid() || !validTargets(targets)) { rejected++; continue; }
    try {
      if (!legacyTypeForLayer(m.memory_layer)) {
        rejected++; log('warn', formatReflectRejectMapping(companionId, m.memory_layer)); continue;
      }
      prepared.push({ kind: 'insert', input: groundedInput(m, targets, m.content, m.memory_layer) });
    } catch (e) {
      rejected++; log('warn', formatReflectInsertFail(companionId, e.message));
    }
  }

  for (const u of (updates.updated_memories || [])) {
    if (!inputsStillValid() || !validTargets([u.memory_id])) { rejected++; continue; }
    try {
      const existing = getRecallableMemories(companionId, userId).find(row => row.id === u.memory_id);
      const input = groundedInput(u, [u.memory_id], u.new_content, existing.memory_layer);
      const priorSources = Array.isArray(existing.source_memory_ids)
        ? existing.source_memory_ids : JSON.parse(existing.source_memory_ids || '[]');
      input.sourceMemoryIds = [...new Set([...priorSources, ...(input.sourceMemoryIds || [])])]
        .filter(id => id !== u.memory_id);
      prepared.push({ kind: 'update', input });
    } catch (e) {
      rejected++; log('warn', '[Reflection] grounded update 失败 id=' + u.memory_id + ': ' + e.message);
    }
  }

  // Validate and save the complete generation before its own corrections move
  // the evidence cutoff. No provider awaits occur inside the transaction.
  const indexed = [];
  try {
    const results = saveGroundedMemories(prepared.map(entry => entry.input));
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.action === 'inserted' || result.action === 'corrected') {
        if (prepared[i].kind === 'update') updated++;
        else inserted++;
        graphAdmitted(result);
        indexed.push(result.memory.id);
      } else if (result.action !== 'duplicate') rejected++;
    }
  } catch (e) {
    rejected += prepared.length;
    log('warn', formatReflectInsertFail(companionId, e.message));
  }
  for (const id of indexed) await indexMemory(id, companionId, userId);

  const merged = 0; // Exact duplicates are inert; they never strengthen a prior fact.
  log('info', '[Reflection] companion=' + companionId + ' candidates=' + candidates + ' inserted=' + inserted + ' merged=0 rejected=' + rejected + ' updated=' + updated);
  return { candidates, inserted, merged, rejected, updated };
}

// ─── Per-companion reflection runners ────────────────────────────────────────

async function runReflectionForCompanion(companionId, userId, turnsRange, kind, options = {}) {
  const db = getDb();
  try {
    const companion = db.prepare('SELECT * FROM companions WHERE id = ?').get(companionId);
    if (!companion) return;

    userId = userId ?? companion.user_id;
    if (userId !== companion.user_id) return;
    const { revision } = getMemoryRecallBarrier(companionId, userId);
    const { startSql, endSql } = turnsRange;
    const turns = getConversationTurnsBetween(companionId, startSql, endSql, RECENT_TURNS_LIMIT);
    if (turns.length < 3) {
      log('info', `[Reflection] companion=${companionId} ${kind} 跳过（对话轮次 ${turns.length} < 3）`);
      return;
    }

    // Dedicated model reader; management listings intentionally retain hidden rows.
    const existingMemories = getRecallableMemories(companionId, userId).slice(0, 20);

    const displayedTurns = turns.slice(-80);
    const prompt = buildReflectionPrompt(companion, displayedTurns, existingMemories);
    const raw = await extractStructuredInfo(
      '你是结构化记忆提炼引擎，只输出 JSON，无其他内容。',
      prompt,
      { maxTokens: 1500 },
    );

    let parsed;
    try {
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
      parsed = JSON.parse(cleaned);
    } catch {
      log('warn', `[Reflection] ${kind} companion=${companionId} JSON 解析失败`);
      return;
    }

    const updates = normalizeReflectionResult(parsed);
    const counts = await applyReflectionMemoryUpdates(companionId, updates, {
      userId, expectedRecallRevision: revision, sourceMemoryIds: existingMemories.map(row => row.id),
      shownMemoryIds: existingMemories.map(row => row.id), allowedTurnIds: displayedTurns.map(turn => turn.id),
    });

    log('info', `[Reflection] ${kind} companion=${companionId} new=${updates.new_memories.length} updated=${updates.updated_memories.length}`);
    return counts;   // 上抛给批级 rollup 汇总（正向心跳）；跳过/异常路径返回 undefined
  } catch (e) {
    log('error', `[Reflection] ${kind} companion=${companionId} 异常: ${e.message}`);
  }
}

function addDaysSh(dateKey, delta) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return shanghaiDateKey(new Date(Date.UTC(y, m - 1, d + delta, 12)));
}

export async function runDailyReflectionForCompanion(companionId, options = {}) {
  const now = new Date();
  const todayKey = shanghaiDateKey(now);
  const yesterdayKey = addDaysSh(todayKey, -1);
  const { startSql, endSql } = shanghaiBoundsForDateKey(yesterdayKey);
  const userId = options.userId;
  return runReflectionForCompanion(companionId, userId, { startSql, endSql }, 'daily', options);
}

export async function runWeeklyReflectionForCompanion(companionId, options = {}) {
  const now = new Date();
  const todayKey = shanghaiDateKey(now);
  const endKey = addDaysSh(todayKey, -1);
  const startKey = addDaysSh(endKey, -6);
  const { startSql: startSql0 } = shanghaiBoundsForDateKey(startKey);
  const { endSql: endSql0 } = shanghaiBoundsForDateKey(endKey);
  const userId = options.userId;
  return runReflectionForCompanion(companionId, userId, { startSql: startSql0, endSql: endSql0 }, 'weekly', options);
}
