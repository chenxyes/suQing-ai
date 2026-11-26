/**
 * Persona JSON Import / Export
 *
 * Exports companion persona data to a portable JSON format.
 * Never exports account_id, user_id, email, bot_token, or API keys.
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { getDb } from './db.mjs';
import { readMemoryTransfer, validateMemoryTransfer, importMemoryTransfer } from './persona_memory_transfer.mjs';
import { filterForStorage } from './privacy_filter.mjs';

const EXPORT_SCHEMA = 'xiyu_companion_export_v2';
const LEGACY_SCHEMA = 'xiyu_companion_export_v1';
const MAX_IMPORT_BYTES = 32 * 1024 * 1024;

const PERSONA_FIELDS = [
  'name', 'age', 'role_title',
  'hair_color', 'hair_style', 'eye_color', 'body_type', 'height', 'clothing_style',
  'personality_tags', 'mbti', 'introvert_level',
  'intimacy_level',
  'speech_styles', 'use_emoji_level', 'use_kaomoji', 'reply_length',
  'can_joke', 'avoid_cheesy', 'no_pressure', 'occasional_tantrum', 'encouraging', 'nsfw_level',
  'hobbies', 'favorite_food', 'favorite_music', 'pet_preference', 'dislikes',
  'how_met', 'relationship_status', 'shared_memory',
  'memory_priorities',
  'proactive_enabled', 'proactive_frequency', 'proactive_time_window', 'proactive_daily_target',
  'attachment_style', 'first_love', 'locale',
  'voice_reply_enabled', 'sticker_reply_enabled',
  'call_user_as', 'user_call_her_as',
  'persona_prompt', 'forbidden_topics',
  'memory_enabled',
  'relationship_stage',
  'current_scene',
  'backstory', 'family_background', 'education',
  'voice_style', 'voice_speed',
  'chat_modes', 'chat_mode_active',
  'temperature', 'max_tokens', 'top_p',
];

// Fields intentionally excluded from export (security / privacy / runtime state)
// account_id, user_id, bot_id, email, bot_token, secrets, avatar_url,
// voice_id (provider 绑定资源，跨部署不通用),
// silent_mode / current_mood / affection_level / scene_history (运行时状态，导入后应重新开始)
// 新增人格字段时必须同步 PERSONA_FIELDS + IMPORT_*_FIELDS + DEFAULTS，
// 漂移由 scripts/persona_export_drift_check.mjs 在 CI 拦截。
const IMPORT_STRING_FIELDS = new Set([
  'name', 'role_title', 'hair_color', 'hair_style', 'eye_color', 'body_type',
  'clothing_style', 'intimacy_level', 'mbti', 'reply_length', 'favorite_food',
  'favorite_music', 'pet_preference', 'how_met', 'relationship_status', 'shared_memory',
  'call_user_as', 'user_call_her_as', 'persona_prompt', 'relationship_stage',
  'current_scene', 'backstory', 'family_background', 'education',
  'voice_style', 'chat_mode_active', 'proactive_frequency', 'proactive_time_window',
  'attachment_style', 'locale',
]);
const IMPORT_INT_FIELDS = new Set([
  'age', 'height', 'introvert_level', 'use_emoji_level', 'use_kaomoji',
  'can_joke', 'avoid_cheesy', 'no_pressure', 'occasional_tantrum', 'encouraging',
  'nsfw_level', 'memory_enabled', 'proactive_enabled', 'voice_reply_enabled',
  'sticker_reply_enabled', 'max_tokens', 'first_love', 'proactive_daily_target',
]);
const IMPORT_FLOAT_FIELDS = new Set(['temperature', 'top_p', 'voice_speed']);
const IMPORT_JSON_FIELDS = new Set([
  'personality_tags', 'speech_styles', 'hobbies', 'memory_priorities',
  'forbidden_topics', 'chat_modes', 'dislikes',
]);
// 枚举字段：导入值不在白名单内时丢弃，落回 DEFAULTS（防垃圾值进 prompt）
const IMPORT_ENUM_VALUES = new Map([
  ['attachment_style', new Set(['secure', 'anxious', 'avoidant'])],
  ['locale', new Set(['zh', 'en'])],
]);

// Patterns that suggest injected credentials / prompts
const SENSITIVE_PATTERN = /api[_-]?key|secret|token|password|bearer\s+[a-z0-9]/i;

/**
 * Build an exportable JSON payload for a companion.
 * @param {number} companionId
 * @param {{ includeMemories?: boolean }} options
 */
export function buildCompanionExport(companionId, options = {}) {
  return buildCompanionExportFromDb(getDb(), companionId, options);
}

/** Offline export accepts a read-only connection and never runs runtime migrations. */
export function buildCompanionExportFromDb(db, companionId, options = {}) {
  return db.transaction(() => {
  const available = new Set(db.prepare('PRAGMA table_info(companions)').all().map(column => column.name));
  const columns = PERSONA_FIELDS.map(field => available.has(field) ? field : `NULL AS ${field}`);
  const c = db.prepare(`SELECT ${columns.join(', ')} FROM companions WHERE id = ?`).get(companionId);
  if (!c) throw Object.assign(new Error('Companion not found'), { status: 404 });

  const facts = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_persona_facts'").get() ? db.prepare(
    `SELECT category, content, sort_order FROM companion_persona_facts WHERE companion_id = ? ORDER BY sort_order, id`
  ).all(companionId) : [];

  const payload = {
    schema: EXPORT_SCHEMA,
    exported_at: new Date().toISOString(),
    companion: c,
    persona_facts: facts,
    core_memories: [],
    settings: {},
  };

  if (options.includeMemories) Object.assign(payload, readMemoryTransfer(db, companionId));
  return payload;
  })();
}

/**
 * Validate a raw parsed import payload.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function validateCompanionImport(payload, { maxBytes = MAX_IMPORT_BYTES } = {}) {
  if (!payload || typeof payload !== 'object') return { valid: false, error: 'payload must be an object' };
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) return { valid: false, error: 'invalid import size limit' };
  try { if (Buffer.byteLength(JSON.stringify(payload)) > maxBytes) return { valid: false, error: `payload exceeds ${maxBytes / 1024 / 1024} MiB` }; }
  catch { return { valid: false, error: 'payload must be serializable JSON' }; }
  if (![EXPORT_SCHEMA, LEGACY_SCHEMA].includes(payload.schema)) return { valid: false, error: 'unsupported schema' };
  if (!payload.companion || typeof payload.companion !== 'object') return { valid: false, error: 'missing companion object' };
  if (typeof payload.companion.name !== 'string' || !payload.companion.name.trim()) {
    return { valid: false, error: 'companion.name is required' };
  }
  if (payload.persona_facts !== undefined && !Array.isArray(payload.persona_facts)) {
    return { valid: false, error: 'persona_facts must be an array' };
  }
  if (payload.core_memories !== undefined && !Array.isArray(payload.core_memories)) {
    return { valid: false, error: 'core_memories must be an array' };
  }
  const invalidText = text => { const result = filterForStorage(text); return !result.store || result.text !== text; };
  for (const row of payload.core_memories || []) {
    if (!row || typeof row.content !== 'string' || !row.content.trim() || invalidText(row.content)) return { valid: false, error: 'invalid or private memory content' };
    if (row.memory_evidence != null && typeof row.memory_evidence === 'string' && invalidText(row.memory_evidence)) return { valid: false, error: 'private evidence content' };
    for (const key of ['keywords', 'origin_metadata', 'embedding_meta']) {
      if (typeof row[key] === 'string' && invalidText(row[key])) return { valid: false, error: 'private memory metadata' };
    }
  }
  if (payload.evidence_turns !== undefined && !Array.isArray(payload.evidence_turns)) return { valid: false, error: 'evidence_turns must be an array' };
  for (const turn of payload.evidence_turns || []) {
    if (typeof turn?.content === 'string' && invalidText(turn.content)) return { valid: false, error: 'private conversation content' };
    if (typeof turn?.topic === 'string' && invalidText(turn.topic)) return { valid: false, error: 'private conversation topic' };
  }
  for (const fact of payload.persona_facts || []) {
    if (!fact || typeof fact.content !== 'string' || invalidText(fact.content)) return { valid: false, error: 'invalid or private persona fact' };
  }
  if (payload.schema === EXPORT_SCHEMA) {
    const error = validateMemoryTransfer(payload);
    if (error) return { valid: false, error };
  }
  return { valid: true };
}

/**
 * Strip sensitive patterns and unknown fields from a raw import payload.
 * Returns a sanitized { companionFields, personaFacts, coreMemories }.
 */
export function sanitizeImportedCompanion(payload) {
  const raw = payload.companion || {};
  const companionFields = {};

  for (const [key, val] of Object.entries(raw)) {
    if (IMPORT_ENUM_VALUES.has(key)) {
      const s = String(val ?? '');
      if (IMPORT_ENUM_VALUES.get(key).has(s)) companionFields[key] = s;
    } else if (IMPORT_STRING_FIELDS.has(key)) {
      const s = String(val ?? '').slice(0, 4000);
      companionFields[key] = SENSITIVE_PATTERN.test(s) ? '' : s;
    } else if (IMPORT_INT_FIELDS.has(key)) {
      const n = parseInt(val, 10);
      companionFields[key] = Number.isFinite(n) ? n : undefined;
    } else if (IMPORT_FLOAT_FIELDS.has(key)) {
      const f = parseFloat(val);
      companionFields[key] = Number.isFinite(f) ? f : undefined;
    } else if (IMPORT_JSON_FIELDS.has(key)) {
      try {
        const arr = Array.isArray(val) ? val : JSON.parse(String(val));
        if (Array.isArray(arr)) {
          companionFields[key] = JSON.stringify(arr.map(v => String(v).slice(0, 200)));
        }
      } catch {
        // skip malformed JSON
      }
    }
    // All other fields (account_id, user_id, bot_id, secrets…) are silently dropped
  }

  const personaFacts = (Array.isArray(payload.persona_facts) ? payload.persona_facts : [])
    .map(f => ({
      category: String(f.category ?? 'general'),
      content: String(f.content ?? ''),
      sort_order: parseInt(f.sort_order, 10) || 0,
    }));

  const coreMemories = (Array.isArray(payload.core_memories) ? payload.core_memories : []).map(row => ({ ...row }));

  return { companionFields, personaFacts, coreMemories };
}

/**
 * Import a companion payload for a given user.
 * Creates a new companion owned by userId.
 * @param {number} userId
 * @param {number} accountId
 * @param {string} botId
 * @param {object} payload  parsed + validated import JSON
 * @param {{ importMemories?: boolean }} options
 */
export async function importCompanionForUser(userId, accountId, botId, payload, options = {}) {
  const validation = validateCompanionImport(payload, { maxBytes: options.maxImportBytes ?? MAX_IMPORT_BYTES });
  if (!validation.valid) throw Object.assign(new Error(validation.error), { status: 400 });
  const db = getDb();
  const { companionFields, personaFacts, coreMemories } = sanitizeImportedCompanion(payload);

  const now = new Date().toISOString();
  // 列清单从 PERSONA_FIELDS 派生（全部是代码内白名单常量，无注入面）：
  // 新增人格字段只需改 PERSONA_FIELDS + IMPORT_*_FIELDS + DEFAULTS 三处，INSERT 不会再漂移
  const insertCols = ['user_id', 'bot_id', ...PERSONA_FIELDS, 'created_at', 'updated_at'];
  const insertCompanion = db.prepare(`
    INSERT INTO companions (${insertCols.join(', ')})
    VALUES (${insertCols.map(col => '@' + col).join(', ')})
  `);

  const defaults = {
    age: 20, role_title: '邻家女孩',
    hair_color: '黑色', hair_style: '长发', eye_color: '棕色', body_type: '匀称',
    height: 165, clothing_style: '甜美',
    personality_tags: '["温柔","体贴"]', mbti: null, introvert_level: 5,
    intimacy_level: '慢慢熟悉',
    speech_styles: '["自然口语"]', use_emoji_level: 5, use_kaomoji: 0, reply_length: '适中(3-4句)',
    can_joke: 1, avoid_cheesy: 0, no_pressure: 0, occasional_tantrum: 0, encouraging: 1, nsfw_level: 0,
    hobbies: '[]', favorite_food: null, favorite_music: null, pet_preference: null, dislikes: '[]',
    how_met: null, relationship_status: '普通朋友', shared_memory: null,
    memory_priorities: '["我的喜好","情绪变化"]',
    proactive_enabled: 1, proactive_frequency: '适中', proactive_time_window: '07:30-24:00',
    proactive_daily_target: 4,
    attachment_style: 'secure', first_love: 1, locale: 'zh',
    voice_reply_enabled: 0, sticker_reply_enabled: 0,
    call_user_as: '你', user_call_her_as: null,
    persona_prompt: '', forbidden_topics: '[]',
    memory_enabled: 1,
    relationship_stage: '陌生人', current_scene: '在家',
    backstory: null, family_background: null, education: null,
    voice_style: '温柔', voice_speed: 1.0,
    chat_modes: '["日常聊天"]', chat_mode_active: '日常聊天',
    temperature: 0.7, max_tokens: 2000, top_p: 0.9,
  };

  const row = { ...defaults, ...companionFields, user_id: userId, bot_id: botId, created_at: now, updated_at: now };
  return db.transaction(() => {
  const result = insertCompanion.run(row);
  const companionId = result.lastInsertRowid;

  if (personaFacts.length) {
    const insertFact = db.prepare(
      `INSERT INTO companion_persona_facts (companion_id, category, content, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    for (const f of personaFacts) {
      insertFact.run(companionId, f.category, f.content, f.sort_order, now);
    }
  }

  const memoryResult = options.importMemories
    ? importMemoryTransfer(db, companionId, userId, { ...payload, core_memories: coreMemories }, { trustReviewedHistory: options.trustReviewedHistory === true })
    : { importedMemories: 0, importedEvidenceTurns: 0, quarantinedMemories: 0, warnings: [] };
  return { companionId, ...memoryResult };
  })();
}

export {
  EXPORT_SCHEMA, MAX_IMPORT_BYTES,
  // 供 scripts/persona_export_drift_check.mjs 对账（CI 防字段漂移）
  PERSONA_FIELDS, IMPORT_STRING_FIELDS, IMPORT_INT_FIELDS,
  IMPORT_FLOAT_FIELDS, IMPORT_JSON_FIELDS, IMPORT_ENUM_VALUES,
};
