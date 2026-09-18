/** Safe chat response classification shared by providers and conversation callers. */
export const CHAT_FALLBACK = '嗯…我刚刚有点走神，等我一下下，再跟你说～';
export const isChatFallback = text => typeof text === 'string' && text.trim() === CHAT_FALLBACK;

export function boundedNumber(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

export function normalizeChatResponse({ text, finishReason = null, refusal = false, usage = null } = {}) {
  const reason = typeof finishReason === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(finishReason) ? finishReason : null;
  const lower = reason?.toLowerCase();
  let code, retryable = false;
  if (refusal || ['content_filter', 'safety', 'recitation', 'blocklist', 'prohibited_content', 'spii', 'refusal'].includes(lower)) {
    code = 'response_refused';
  } else {
    if (Array.isArray(text)) text = text.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
    if (text != null && typeof text !== 'string') code = 'invalid_content';
    else if (typeof text === 'string' && text.trim()) return { text: text.trim(), usage, finish_reason: reason };
    else if (['length', 'max_tokens'].includes(lower)) code = 'token_limit';
    else if (['tool_calls', 'function_call'].includes(lower)) code = 'unsupported_tool_call';
    else { code = 'empty_response'; retryable = true; }
  }
  const error = new Error(`chat ${code}`);
  error.code = code;
  error.retryable = retryable;
  error.finish_reason = reason;
  error.usage = usage;
  throw error;
}

/** Never include upstream messages, response bodies, keys, prompts or reasoning. */
export function chatFailureMetadata(error) {
  const allowed = ['response_refused', 'invalid_content', 'token_limit', 'unsupported_tool_call', 'empty_response'];
  const status = Number.isInteger(error?.status) ? error.status : Number(/HTTP\s+(\d{3})/i.exec(String(error?.message || ''))?.[1]) || null;
  const timeout = /abort|timeout|timed out/i.test(`${error?.name || ''} ${error?.message || ''}`);
  const code = allowed.includes(error?.code) ? error.code : timeout ? 'timeout' : status ? 'http_error' : 'request_error';
  return { code, status, finish_reason: /^[a-zA-Z0-9_]{1,64}$/.test(error?.finish_reason || '') ? error.finish_reason : null };
}
