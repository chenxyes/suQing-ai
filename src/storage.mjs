/**
 * 对象存储双模抽象层：Cloudflare R2（零依赖 AWS SigV4 S3 API）+ 本地磁盘自动兜底
 *
 * 环境变量（支持通过 .env 或 app_settings 配置）：
 *   R2_ENDPOINT          形如 https://<account_id>.r2.cloudflarestorage.com（末尾带不带 /<bucket> 均自动兼容）
 *   R2_BUCKET            存储桶名称（如 suqing-assets）
 *   R2_ACCESS_KEY_ID     R2 API Token Access Key ID
 *   R2_SECRET_ACCESS_KEY R2 API Token Secret Access Key
 *   R2_PUBLIC_URL        可选：开启 r2.dev 或自定义域名后的公开访问前缀（不填则走后端鉴权代理）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAppSetting } from './db.mjs';
import { log } from './logger.mjs';

const DEFAULT_LOCAL_ASSETS_ROOT = path.resolve(
  process.env.PHOTO_VISUAL_IDENTITY_DIR || path.join(process.cwd(), 'data', 'visuals'),
  '_assets',
);

function readSetting(key) {
  try {
    const dbVal = getAppSetting(key);
    if (dbVal !== undefined && dbVal !== null && String(dbVal).trim() !== '') {
      return String(dbVal).trim();
    }
  } catch { /* db may not be initialized in isolated unit tests */ }
  return String(process.env[key] || '').trim();
}

/**
 * 规范化 R2 配置：若用户在 R2_ENDPOINT 末尾贴了 /<bucket>，自动剥离避免路径重复。
 */
export function getR2Config() {
  const bucket = readSetting('R2_BUCKET');
  const accessKeyId = readSetting('R2_ACCESS_KEY_ID');
  const secretAccessKey = readSetting('R2_SECRET_ACCESS_KEY');
  const publicUrl = readSetting('R2_PUBLIC_URL').replace(/\/+$/, '');
  let endpoint = readSetting('R2_ENDPOINT').replace(/\/+$/, '');

  if (endpoint && bucket) {
    const suffix = `/${bucket}`;
    if (endpoint.endsWith(suffix)) {
      endpoint = endpoint.slice(0, -suffix.length);
    }
  }

  const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
  return { configured, endpoint, bucket, accessKeyId, secretAccessKey, publicUrl };
}

export function isR2Configured() {
  return getR2Config().configured;
}

export function getStorageStatus() {
  const cfg = getR2Config();
  let endpointHost = '';
  if (cfg.endpoint) {
    try { endpointHost = new URL(cfg.endpoint).host; } catch { /* ignore */ }
  }
  return {
    driver: cfg.configured ? 'r2' : 'local',
    configured: cfg.configured,
    bucket: cfg.configured ? cfg.bucket : null,
    endpointHost: cfg.configured ? endpointHost : null,
    hasPublicUrl: Boolean(cfg.configured && cfg.publicUrl),
    publicUrl: cfg.configured && cfg.publicUrl ? cfg.publicUrl : null,
  };
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function encodeS3Key(key) {
  return String(key || '')
    .replace(/^\/+/, '')
    .split('/')
    .map(seg => encodeURIComponent(seg).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

/**
 * 构造标准 AWS Signature Version 4 签名请求头（兼容 Cloudflare R2 / MinIO / AWS S3）。
 */
export function signS3Request({
  method,
  endpoint,
  bucket,
  key,
  accessKeyId,
  secretAccessKey,
  region = 'auto',
  body = Buffer.alloc(0),
  contentType = '',
  now = new Date(),
}) {
  const cleanKey = encodeS3Key(key);
  const url = new URL(`${endpoint.replace(/\/+$/, '')}/${encodeURIComponent(bucket)}/${cleanKey}`);
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  const payloadHash = sha256Hex(payload);

  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = url.host;

  const headerPairs = [
    ['host', host],
    ['x-amz-content-sha256', payloadHash],
    ['x-amz-date', amzDate],
  ];
  if (contentType) headerPairs.push(['content-type', contentType]);
  headerPairs.sort((a, b) => a[0].localeCompare(b[0]));

  const canonicalHeaders = headerPairs.map(([k, v]) => `${k}:${v.trim()}\n`).join('');
  const signedHeaders = headerPairs.map(([k]) => k).join(';');
  const canonicalRequest = [
    method.toUpperCase(),
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const headers = {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (contentType) headers['content-type'] = contentType;
  return { url: url.toString(), headers };
}

export async function r2PutObject(key, buffer, contentType = 'application/octet-stream', cfg = getR2Config()) {
  if (!cfg.configured) throw new Error('Cloudflare R2 未配置');
  const { url, headers } = signS3Request({
    method: 'PUT',
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
    key,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    body: buffer,
    contentType,
  });
  const resp = await fetch(url, {
    method: 'PUT',
    headers,
    body: buffer,
    signal: AbortSignal.timeout(45_000),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`R2 PUT HTTP ${resp.status}: ${errBody.slice(0, 180)}`);
  }
  const cleanKey = String(key).replace(/^\/+/, '');
  return {
    key: cleanKey,
    storageRef: `r2://${cleanKey}`,
    publicUrl: cfg.publicUrl ? `${cfg.publicUrl}/${encodeS3Key(cleanKey)}` : null,
  };
}

export async function r2GetObject(key, cfg = getR2Config()) {
  if (!cfg.configured) throw new Error('Cloudflare R2 未配置');
  const { url, headers } = signS3Request({
    method: 'GET',
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
    key,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });
  const resp = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    throw new Error(`R2 GET HTTP ${resp.status}`);
  }
  const contentType = (resp.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { buffer, contentType };
}

export async function r2DeleteObject(key, cfg = getR2Config()) {
  if (!cfg.configured) return false;
  const { url, headers } = signS3Request({
    method: 'DELETE',
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
    key,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });
  const resp = await fetch(url, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  return resp.ok || resp.status === 404;
}

export async function testR2Connection(cfg = getR2Config()) {
  if (!cfg.configured) {
    return { ok: false, error: '未配置 R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY' };
  }
  const probeKey = `_health/probe_${Date.now()}.txt`;
  const payload = Buffer.from(`xiyu-r2-probe:${new Date().toISOString()}`, 'utf8');
  const started = Date.now();
  try {
    await r2PutObject(probeKey, payload, 'text/plain; charset=utf-8', cfg);
    const got = await r2GetObject(probeKey, cfg);
    await r2DeleteObject(probeKey, cfg).catch(() => {});
    if (got.buffer.toString('utf8') !== payload.toString('utf8')) {
      return { ok: false, error: 'R2 读写校验内容不一致' };
    }
    return {
      ok: true,
      bucket: cfg.bucket,
      latency_ms: Date.now() - started,
      hasPublicUrl: Boolean(cfg.publicUrl),
    };
  } catch (e) {
    return { ok: false, bucket: cfg.bucket, error: e.message };
  }
}

export function mimeFromFilename(name = '') {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

function safeLocalAssetPath(key, localRoot = DEFAULT_LOCAL_ASSETS_ROOT) {
  const clean = String(key || '').replace(/^\/+/, '').replace(/\.\./g, '');
  const full = path.resolve(localRoot, clean);
  const root = path.resolve(localRoot);
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new Error('invalid asset path');
  }
  return full;
}

/**
 * 统一存储图片 Buffer：
 *  - 配置了 R2 时上传至 Cloudflare R2（同时在 R2 短暂失败时 fail-open 回落本地磁盘）；
 *  - 未配置 R2 时直接安全落盘到本地 `_assets/<key>`。
 */
export async function storeAssetBuffer(key, buffer, {
  contentType = 'image/png',
  localRoot = DEFAULT_LOCAL_ASSETS_ROOT,
} = {}) {
  const cleanKey = String(key || '').replace(/^\/+/, '');
  const cfg = getR2Config();
  if (cfg.configured) {
    try {
      const out = await r2PutObject(cleanKey, buffer, contentType, cfg);
      return {
        driver: 'r2',
        key: out.key,
        imageRef: out.storageRef,
        publicUrl: out.publicUrl,
      };
    } catch (e) {
      log('warn', `[Storage] R2 上传失败，降级本地存储 key=${cleanKey}: ${e.message}`);
    }
  }
  const localPath = safeLocalAssetPath(cleanKey, localRoot);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, buffer);
  return {
    driver: 'local',
    key: cleanKey,
    imageRef: localPath,
    publicUrl: null,
  };
}

/**
 * 读取统一资产引用（支持 `r2://<key>`、本地文件路径、`https://...`）。
 */
export async function readAssetBuffer(imageRef) {
  const ref = String(imageRef || '').trim();
  if (!ref) return null;
  if (ref.startsWith('r2://')) {
    const key = ref.slice('r2://'.length);
    return r2GetObject(key);
  }
  if (/^https?:\/\//i.test(ref)) {
    const resp = await fetch(ref, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) throw new Error(`fetch asset HTTP ${resp.status}`);
    const contentType = (resp.headers.get('content-type') || 'image/png').split(';')[0].trim();
    return { buffer: Buffer.from(await resp.arrayBuffer()), contentType };
  }
  if (fs.existsSync(ref)) {
    return { buffer: fs.readFileSync(ref), contentType: mimeFromFilename(ref) };
  }
  return null;
}

/**
 * 删除统一资产引用（忽略不存在）。
 */
export async function deleteAsset(imageRef) {
  const ref = String(imageRef || '').trim();
  if (!ref) return false;
  if (ref.startsWith('r2://')) {
    const key = ref.slice('r2://'.length);
    return r2DeleteObject(key).catch(() => false);
  }
  if (!/^https?:\/\//i.test(ref) && fs.existsSync(ref)) {
    try {
      fs.unlinkSync(ref);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 镜像上传已有本地图片到 R2（静默 fail-open，不阻塞主链路）。
 */
export async function mirrorBufferToR2Quietly(key, buffer, contentType = 'image/png') {
  if (!isR2Configured() || !buffer?.length) return null;
  try {
    return await r2PutObject(key, buffer, contentType);
  } catch (e) {
    log('warn', `[Storage] R2 镜像备份失败 key=${key}: ${e.message}`);
    return null;
  }
}
