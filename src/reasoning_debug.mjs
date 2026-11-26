/**
 * 后台思考流（reasoning_content）内存调试缓冲（Phase 1）
 *
 * 硬红线：
 *  - 仅在 CHAT_REASONING_CAPTURE=true 时记录
 *  - 仅存进程内存环形缓冲（不落盘、不写入对话历史、不发送进聊天会话框）
 *  - 自动脱敏常见密钥格式并截断长度，防止敏感信息泄露
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { getAppSetting } from './db.mjs';

const MAX_TRACES_PER_COMPANION = 20;
const MAX_COMPANIONS_TRACKED = 200;
const MAX_REASONING_CHARS = 1200;
const MAX_PREVIEW_CHARS = 80;

const _tracesByCompanion = new Map();

function readSetting(key) {
  try {
    const value = getAppSetting(key);
    if (value !== null && value !== undefined && value !== '') return String(value);
  } catch {}
  return String(process.env[key] || '');
}

export function isReasoningCaptureEnabled() {
  return /^(1|true|yes|on)$/i.test(readSetting('CHAT_REASONING_CAPTURE').trim());
}

function sanitizeText(raw, maxLen) {
  const s = String(raw || '')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})\b/g, '[REDACTED]')
    .trim();
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

export function recordReasoningTrace({
  companionId,
  provider = '',
  model = '',
  role = 'primary',
  reasoning = '',
  replyPreview = '',
} = {}) {
  if (!isReasoningCaptureEnabled()) return false;
  if (companionId === null || companionId === undefined) return false;
  const cleanReasoning = sanitizeText(reasoning, MAX_REASONING_CHARS);
  if (!cleanReasoning) return false;

  const key = String(companionId);
  if (!_tracesByCompanion.has(key)) {
    if (_tracesByCompanion.size >= MAX_COMPANIONS_TRACKED) {
      const oldestKey = _tracesByCompanion.keys().next().value;
      if (oldestKey !== undefined) _tracesByCompanion.delete(oldestKey);
    }
    _tracesByCompanion.set(key, []);
  }

  const list = _tracesByCompanion.get(key);
  list.push({
    ts: new Date().toISOString(),
    provider: String(provider || ''),
    model: String(model || ''),
    role: String(role || 'primary'),
    reasoning: cleanReasoning,
    reply_preview: sanitizeText(replyPreview, MAX_PREVIEW_CHARS),
  });
  while (list.length > MAX_TRACES_PER_COMPANION) list.shift();
  return true;
}

export function getReasoningTraces(companionId, limit = 10) {
  if (companionId === null || companionId === undefined) return [];
  const list = _tracesByCompanion.get(String(companionId));
  if (!list || !list.length) return [];
  const n = Math.max(1, Math.min(MAX_TRACES_PER_COMPANION, Number(limit) || 10));
  return list.slice(-n).reverse();
}

export function clearReasoningTraces(companionId = null) {
  if (companionId === null || companionId === undefined) {
    _tracesByCompanion.clear();
    return;
  }
  _tracesByCompanion.delete(String(companionId));
}
