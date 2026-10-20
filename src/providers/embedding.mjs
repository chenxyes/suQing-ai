/**
 * 文本 embedding：统一解析运行配置、校验凭据/向量，失败返回 null。
 * configured 仅表示本地校验通过；health 表示当前进程、当前配置的调用结果。
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */
import { createHash } from 'node:crypto';
import { log } from '../logger.mjs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { customConfig, readProviderSetting as setting } from './custom.mjs';

const NATIVE = {
  gemini: { key: 'GEMINI_API_KEY', model: 'gemini-embedding-001', baseURL: 'https://generativelanguage.googleapis.com/v1beta' },
  openai: { key: 'OPENAI_API_KEY', model: 'text-embedding-3-small', baseURL: 'https://api.openai.com/v1' },
  zhipu: { key: 'ZHIPU_API_KEY', model: 'embedding-3', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
  qwen: { key: 'QWEN_API_KEY', model: 'text-embedding-v3', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
};

class EmbeddingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const problem = (code, message) => new EmbeddingError(code, message);

function resolveConfig() {
  const id = (setting('EMBEDDING_PROVIDER') || 'gemini').trim().toLowerCase();
  const native = NATIVE[id];
  const rawDim = setting('EMBEDDING_DIM');
  const config = {
    id, model: setting('EMBEDDING_MODEL') || native?.model || '',
    dim: id === 'custom' ? null : (rawDim === '' ? 768 : Number(rawDim)),
    apiKey: setting(id === 'custom' ? 'EMBEDDING_API_KEY' : native?.key || 'EMBEDDING_API_KEY'),
    baseURL: id === 'custom' ? setting('EMBEDDING_BASE_URL') : native?.baseURL,
  };
  let error = null;
  try {
    if (id === 'custom') {
      try { Object.assign(config, customConfig('embedding')); }
      catch { throw problem('invalid_custom_config', '自定义向量配置不完整或格式错误，请检查地址、模型和 API Key'); }
    } else {
      if (!Object.hasOwn(NATIVE, id)) throw problem('unknown_provider', '不支持的 Embedding provider');
      if (!config.apiKey) throw problem('missing_key', `${native.key} 未配置`);
      if (!/^[\x21-\x7e]+$/.test(config.apiKey)) {
        throw problem('invalid_key', `${native.key} 只能包含无空白的 ASCII 字符，请替换占位文字或错误密钥`);
      }
      if (!Number.isSafeInteger(config.dim) || config.dim < 1 || config.dim > 65536) {
        throw problem('invalid_dimension', 'EMBEDDING_DIM 必须是 1–65536 的整数，并受所选模型支持');
      }
      if (!config.model.trim() || /[\x00-\x1f\x7f]/.test(config.model)) {
        throw problem('invalid_model', 'EMBEDDING_MODEL 不能为空或包含控制字符');
      }
      config.model = config.model.trim();
    }
  } catch (err) { error = err; }
  // Identity includes credentials privately: a changed key must not inherit the old success.
  const identity = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  return { config, error, identity };
}

let currentHealth;
function healthFor(identity) {
  if (currentHealth?.identity !== identity) {
    currentHealth = { identity, state: 'unverified', attempts: 0, successes: 0, failures: 0, blocked: 0,
      last_error: null, last_success_at: null, last_failure_at: null };
  }
  return currentHealth;
}
function safeError(err) {
  if (err instanceof EmbeddingError) return { code: err.code, message: err.message };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return { code: 'timeout', message: '向量请求超时，请检查网络或服务状态' };
  }
  // Google SDK errors may contain response bodies/URLs. Retain only a numeric HTTP code.
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599) {
    return { code: `http_${err.status}`, message: `向量服务返回 HTTP ${err.status}，请检查凭据、模型、额度或服务状态` };
  }
  return { code: 'request_failed', message: '向量请求失败，请检查网络、模型与服务配置' };
}
function validateVector(vector, dim) {
  if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite) || !vector.some(v => v !== 0)) {
    throw problem('invalid_vector', '向量服务未返回有效的非零数值向量');
  }
  if (dim !== null && vector.length !== dim) {
    throw problem('dimension_mismatch', '向量响应维度与 EMBEDDING_DIM 不一致，请检查模型支持的维度');
  }
  return vector;
}
async function requestVector(config, text, timeoutMs) {
  const { id, apiKey, model, dim, baseURL } = config;
  if (id === 'gemini') {
    const client = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model }, { signal: AbortSignal.timeout(timeoutMs) });
    const result = await client.embedContent({ content: { parts: [{ text }] }, outputDimensionality: dim });
    return result?.embedding?.values;
  }
  const response = await fetch(`${baseURL}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text, ...(dim === null ? {} : { dimensions: dim }) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw problem(`http_${response.status}`, `向量服务返回 HTTP ${response.status}，请检查凭据、模型、额度或服务状态`);
  }
  return (await response.json())?.data?.[0]?.embedding;
}

function descriptorFor(config, dimension = config.dim) {
  return { version: 1, provider: config.id, model: config.model, dimension,
    endpointId: createHash('sha256').update(config.baseURL).digest('hex') };
}

/** Public space configuration; custom dimensions are only known after a response. */
export function getEmbeddingSpaceConfig() {
  const { config, error } = resolveConfig();
  return error ? null : descriptorFor(config);
}

async function runEmbedding(text, timeoutMs) {
  const { config, error, identity } = resolveConfig();
  const health = healthFor(identity);
  try {
    if (error) { health.blocked++; throw error; }
    health.attempts++;
    const vector = validateVector(await requestVector(config, text.trim().slice(0, 2000), timeoutMs), config.dim);
    health.state = 'ok'; health.successes++; health.last_error = null;
    health.last_success_at = new Date().toISOString();
    return { vector, descriptor: descriptorFor(config, vector.length),
      contentHash: createHash('sha256').update(text).digest('hex') };
  } catch (err) {
    const safe = safeError(err);
    health.state = error ? 'blocked' : 'error';
    health.failures++; health.last_error = safe; health.last_failure_at = new Date().toISOString();
    log('warn', `[embedding] ${safe.code}: ${safe.message}`);
    throw problem(safe.code, safe.message);
  }
}

export async function embedText(text) {
  return (await embedTextWithDescriptor(text))?.vector ?? null;
}

/** Descriptor and content hash come from this request, never from later settings. */
export async function embedTextWithDescriptor(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try { return await runEmbedding(text, 30_000); }
  catch { return null; }
}

export function getActiveEmbeddingProvider() {
  const { config, error, identity } = resolveConfig();
  const { identity: _identity, ...health } = healthFor(identity);
  return { id: config.id, model: config.model, dim: Number.isFinite(config.dim) ? config.dim : null,
    configured: !error, config_error: error ? safeError(error) : null,
    health: { ...health, state: error ? 'blocked' : health.state } };
}

/** Explicit, authenticated setup action; never run a network probe merely to show status. */
export async function testEmbeddingProvider(provider) {
  if (provider !== getActiveEmbeddingProvider().id) throw problem('provider_mismatch', '请先保存所选向量 provider，再测试当前配置');
  const started = Date.now();
  const { vector } = await runEmbedding('connection test', 15_000);
  return { ok: true, provider, dim: vector.length, latency_ms: Date.now() - started };
}
