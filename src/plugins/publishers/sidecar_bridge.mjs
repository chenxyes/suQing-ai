/**
 * src/plugins/publishers/sidecar_bridge.mjs — 路线 1 外部抖音发布/评论 Sidecar 桥接器
 *
 * 定位：
 *  - 主程序不内置 500MB Chromium，而是通过标准 Sidecar 契约对接社区成熟工具：
 *      1) `http` 模式：对接独立 HTTP Sidecar（如 liaogx/douyin-mcp REST、sau-mcp 桥接服务、
 *         wenyg/douyin-creator-tools 桥接、或未来企业号官方 Open API 网关）
 *      2) `sau_cli` 模式：直接调用本机安装的 dreammis/social-auto-upload (`sau`) CLI
 *  - 严格安全守卫：仅允许 https:// 或本机回环 http://127.0.0.1 / http://localhost；
 *    拒绝外网明文 http://、含凭据 URL 与云元数据地址；CLI 调用使用 execFile 杜绝命令注入。
 *  - 遇登录失效或图形/短信验证（LOGIN_REQUIRED / CAPTCHA_REQUIRED），显式返回
 *    needs_human_action=true，交由人工处理，绝不尝试绕过验证码。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { getCompanionPluginConfig, upsertCompanionPluginConfig } from '../../db.mjs';
import { getStudioMediaDir } from './douyin_studio.mjs';

const execFileAsync = promisify(execFile);

export const DOUYIN_SIDECAR_PLUGIN_ID = 'publisher.douyin_sidecar';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const BLOCKED_META_HOSTS = new Set(['169.254.169.254', '169.254.170.2', 'metadata.google.internal']);
const SAFE_ACCOUNT_RE = /^[a-zA-Z0-9._-]{1,48}$/;
const SAFE_BIN_RE = /^[a-zA-Z0-9._/-]{1,120}$/;

const DEFAULT_CONFIG = {
  mode: 'http',             // 'http' | 'sau_cli'
  base_url: '',             // 例如 http://127.0.0.1:8788 或 https://sidecar.example.com
  auth_token: '',           // 可选 Bearer Token
  sau_bin: 'sau',           // sau_cli 模式的命令名或绝对路径
  sau_account: 'default',   // sau douyin --account 名称
  auto_post: false,         // 是否允许她不定时自主构思并生成/发布抖音
  auto_publish: false,      // true=自主构思后直发 Sidecar；false=仅生成并合成到待审核
  draft_only: true,         // true=推送到抖音创作者中心存草稿箱；false=直接点发布
  daily_post_cap: 1,        // 每日自主发稿硬上限（1-3）
  auto_reply_comments: false, // true=巡检未回复评论并自动回复；false=仅拟稿待批
  comment_patrol_enabled: false, // 是否开启不定时评论区巡检
  daily_reply_cap: 15,      // 每日自动回评论硬上限（1-50）
  reply_tone: 'friendly',   // 'friendly' | 'playful' | 'brief'
};

export function assertSidecarUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) throw new Error('Sidecar 地址不能为空');
  let u;
  try { u = new URL(s); } catch { throw new Error('Sidecar 地址格式无效'); }
  if (u.username || u.password) throw new Error('Sidecar 地址不允许包含内嵌凭据');
  const host = u.hostname.toLowerCase();
  if (BLOCKED_META_HOSTS.has(host)) throw new Error('禁止访问云元数据地址');
  if (u.protocol === 'https:') {
    return u.toString().replace(/\/+$/, '');
  }
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(host)) {
    return u.toString().replace(/\/+$/, '');
  }
  throw new Error('外部 Sidecar 必须使用 https://（仅本机 127.0.0.1 / localhost 允许 http://）');
}

function clampInt(val, def, lo, hi) {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

export function normalizeSidecarConfig(raw = {}, existing = {}) {
  const src = { ...DEFAULT_CONFIG, ...existing, ...raw };
  const mode = src.mode === 'sau_cli' ? 'sau_cli' : 'http';
  const baseUrl = String(src.base_url || '').trim();
  if (baseUrl) assertSidecarUrl(baseUrl);
  const sauAccount = String(src.sau_account || 'default').trim() || 'default';
  if (!SAFE_ACCOUNT_RE.test(sauAccount)) throw new Error('sau 账号名仅允许字母、数字、点、下划线与连字符');
  const sauBin = String(src.sau_bin || 'sau').trim() || 'sau';
  if (!SAFE_BIN_RE.test(sauBin) || sauBin.includes('..')) throw new Error('sau 可执行路径格式无效');
  const tone = ['friendly', 'playful', 'brief'].includes(src.reply_tone) ? src.reply_tone : 'friendly';
  const authToken = raw.auth_token !== undefined
    ? (String(raw.auth_token || '').trim() || (raw.clear_auth_token ? '' : String(existing.auth_token || '')))
    : String(existing.auth_token || '');

  return {
    mode,
    base_url: baseUrl ? assertSidecarUrl(baseUrl) : '',
    auth_token: authToken,
    sau_bin: sauBin,
    sau_account: sauAccount,
    auto_post: Boolean(src.auto_post),
    auto_publish: Boolean(src.auto_publish),
    draft_only: src.draft_only !== false,
    daily_post_cap: clampInt(src.daily_post_cap, 1, 1, 3),
    comment_patrol_enabled: Boolean(src.comment_patrol_enabled),
    auto_reply_comments: Boolean(src.auto_reply_comments),
    daily_reply_cap: clampInt(src.daily_reply_cap, 15, 1, 50),
    reply_tone: tone,
  };
}

export function getDouyinSidecarConfig(companionId) {
  const row = getCompanionPluginConfig(companionId, DOUYIN_SIDECAR_PLUGIN_ID);
  const envFallback = {
    base_url: process.env.DOUYIN_SIDECAR_URL || '',
    auth_token: process.env.DOUYIN_SIDECAR_TOKEN || '',
    sau_account: process.env.DOUYIN_SAU_ACCOUNT || 'default',
  };
  let cfg;
  try {
    cfg = normalizeSidecarConfig(row?.config || {}, envFallback);
  } catch {
    cfg = { ...DEFAULT_CONFIG };
  }
  return {
    enabled: Boolean(row?.enabled),
    config: cfg,
    configured: cfg.mode === 'sau_cli' ? Boolean(cfg.sau_account) : Boolean(cfg.base_url),
  };
}

export function sanitizeSidecarConfigForClient(state) {
  const cfg = state?.config || DEFAULT_CONFIG;
  return {
    enabled: Boolean(state?.enabled),
    configured: Boolean(state?.configured),
    config: {
      mode: cfg.mode,
      base_url: cfg.base_url,
      auth_token_set: Boolean(cfg.auth_token),
      sau_bin: cfg.sau_bin,
      sau_account: cfg.sau_account,
      auto_post: cfg.auto_post,
      auto_publish: cfg.auto_publish,
      draft_only: cfg.draft_only,
      daily_post_cap: cfg.daily_post_cap,
      comment_patrol_enabled: cfg.comment_patrol_enabled,
      auto_reply_comments: cfg.auto_reply_comments,
      daily_reply_cap: cfg.daily_reply_cap,
      reply_tone: cfg.reply_tone,
    },
  };
}

export function saveDouyinSidecarConfig(companionId, { enabled, config = {} } = {}) {
  const prev = getDouyinSidecarConfig(companionId);
  const nextCfg = normalizeSidecarConfig(config, prev.config);
  const nextEnabled = enabled !== undefined ? Boolean(enabled) : prev.enabled;
  upsertCompanionPluginConfig(companionId, DOUYIN_SIDECAR_PLUGIN_ID, {
    enabled: nextEnabled,
    config: nextCfg,
  });
  return getDouyinSidecarConfig(companionId);
}

function buildAuthHeaders(config, extra = {}) {
  const h = { ...extra };
  if (config?.auth_token) h.Authorization = `Bearer ${config.auth_token}`;
  return h;
}

function classifySidecarError(status, bodyObj, rawText) {
  const code = String(bodyObj?.code || bodyObj?.error_code || '').toUpperCase();
  const msg = String(bodyObj?.error || bodyObj?.message || rawText || `HTTP ${status}`).slice(0, 240);
  if (code === 'LOGIN_REQUIRED' || /login[_\s-]?required|未登录|登录已过期|cookie.*expired/i.test(msg)) {
    return { code: 'LOGIN_REQUIRED', needs_human_action: true, message: `抖音登录态已失效，请在 Sidecar 端重新扫码登录：${msg}` };
  }
  if (code === 'CAPTCHA_REQUIRED' || /captcha|滑块|验证码|二次验证|verify/i.test(msg)) {
    return { code: 'CAPTCHA_REQUIRED', needs_human_action: true, message: `触发抖音安全验证，请人工完成验证后再继续：${msg}` };
  }
  return { code: code || 'SIDECAR_ERROR', needs_human_action: false, message: msg };
}

async function sidecarJsonRequest(config, endpoint, { method = 'GET', body = null, timeoutMs = 20_000, fetchImpl = fetch } = {}) {
  const base = assertSidecarUrl(config.base_url);
  const headers = buildAuthHeaders(config, body ? { 'Content-Type': 'application/json' } : {});
  const resp = await fetchImpl(`${base}${endpoint}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch {}
  if (!resp.ok || json?.ok === false) {
    const info = classifySidecarError(resp.status, json, text);
    throw Object.assign(new Error(info.message), info);
  }
  return json || {};
}

export async function checkSidecarHealth(config, { deps = {} } = {}) {
  if (config.mode === 'sau_cli') {
    const runExec = deps.execFile || execFileAsync;
    try {
      const { stdout, stderr } = await runExec(config.sau_bin || 'sau', ['douyin', 'check', '--account', config.sau_account], { timeout: 20_000 });
      const out = `${stdout || ''} ${stderr || ''}`.trim();
      const expired = /expired|invalid|未登录|失败|login/i.test(out);
      return {
        ok: true,
        mode: 'sau_cli',
        logged_in: !expired,
        needs_login: expired,
        account_name: config.sau_account,
        supports_comments: false,
        detail: out.slice(0, 180) || 'sau CLI 可用',
      };
    } catch (e) {
      return {
        ok: false,
        mode: 'sau_cli',
        logged_in: false,
        needs_login: false,
        account_name: config.sau_account,
        supports_comments: false,
        detail: e.code === 'ENOENT' ? `未找到命令 ${config.sau_bin}（请先安装 social-auto-upload）` : String(e.message || e).slice(0, 180),
      };
    }
  }

  if (!config.base_url) {
    return { ok: false, mode: 'http', logged_in: false, needs_login: false, supports_comments: false, detail: '尚未配置 Sidecar 地址' };
  }
  try {
    const data = await sidecarJsonRequest(config, '/health', { timeoutMs: 8000, fetchImpl: deps.fetch || fetch });
    const loggedIn = data.logged_in !== false;
    return {
      ok: true,
      mode: 'http',
      logged_in: loggedIn,
      needs_login: !loggedIn,
      account_name: data.account_name || data.nickname || null,
      supports_comments: data.supports_comments !== false,
      detail: data.detail || data.message || (loggedIn ? 'Sidecar 在线且抖音会话有效' : 'Sidecar 在线，但抖音尚未登录'),
    };
  } catch (e) {
    return {
      ok: false,
      mode: 'http',
      logged_in: false,
      needs_login: e.code === 'LOGIN_REQUIRED',
      supports_comments: false,
      detail: String(e.message || 'Sidecar 连接失败').slice(0, 200),
    };
  }
}

export async function publishDraftViaSidecar(companion, draft, config, { draftOnly, deps = {} } = {}) {
  const effectiveDraftOnly = draftOnly !== undefined ? Boolean(draftOnly) : Boolean(config.draft_only);
  const mediaDir = getStudioMediaDir(companion.id, draft.id);
  const mediaFiles = (Array.isArray(draft.media_paths) ? draft.media_paths : [])
    .map(name => ({ name, absPath: path.join(mediaDir, path.basename(String(name))) }))
    .filter(f => existsSync(f.absPath));
  const videoAbs = draft.video_path ? path.join(mediaDir, path.basename(String(draft.video_path))) : null;
  const hasVideo = Boolean(videoAbs && existsSync(videoAbs));
  const audioAbs = draft.audio_path ? path.join(mediaDir, path.basename(String(draft.audio_path))) : null;
  const hasAudio = Boolean(audioAbs && existsSync(audioAbs));

  if (!hasVideo && !mediaFiles.length) {
    throw Object.assign(new Error('草稿尚未合成配图或视频，请先合成素材再推送'), { code: 'NO_MEDIA' });
  }

  if (config.mode === 'sau_cli') {
    const runExec = deps.execFile || execFileAsync;
    const tagsCsv = (Array.isArray(draft.hashtags) ? draft.hashtags : []).join(',');
    const args = hasVideo
      ? [
          'douyin', 'upload-video',
          '--account', config.sau_account,
          '--file', videoAbs,
          '--title', String(draft.title || '').slice(0, 60),
          '--desc', String(draft.caption || '').slice(0, 500),
          ...(tagsCsv ? ['--tags', tagsCsv] : []),
        ]
      : [
          'douyin', 'upload-note',
          '--account', config.sau_account,
          '--images', ...mediaFiles.map(f => f.absPath),
          '--title', String(draft.title || '').slice(0, 60),
          '--note', String(draft.caption || '').slice(0, 500),
          ...(tagsCsv ? ['--tags', tagsCsv] : []),
        ];
    try {
      const { stdout } = await runExec(config.sau_bin || 'sau', args, { timeout: 120_000 });
      return {
        ok: true,
        mode: 'sau_cli',
        draft_only: effectiveDraftOnly,
        external_item_id: null,
        detail: String(stdout || 'sau CLI 上传完成').trim().slice(0, 200),
      };
    } catch (e) {
      const info = classifySidecarError(500, null, `${e.message || ''} ${e.stderr || ''}`);
      throw Object.assign(new Error(info.message), info);
    }
  }

  const payload = {
    platform: 'douyin',
    draft_id: draft.id,
    format: hasVideo ? 'voice_video' : 'image_post',
    title: draft.title || '',
    caption: draft.caption || '',
    hashtags: Array.isArray(draft.hashtags) ? draft.hashtags : [],
    voice_script: draft.voice_script || '',
    media_files: mediaFiles.map(f => ({ name: f.name, path: f.absPath })),
    audio_file: hasAudio ? { name: draft.audio_path, path: audioAbs } : null,
    video_file: hasVideo ? { name: draft.video_path, path: videoAbs } : null,
    draft_only: effectiveDraftOnly,
  };
  const res = await sidecarJsonRequest(config, '/publish', {
    method: 'POST',
    body: payload,
    timeoutMs: 120_000,
    fetchImpl: deps.fetch || fetch,
  });
  return {
    ok: true,
    mode: 'http',
    draft_only: Boolean(res.draft_only ?? effectiveDraftOnly),
    external_item_id: res.item_id ? String(res.item_id).slice(0, 120) : null,
    detail: String(res.detail || res.message || (effectiveDraftOnly ? '已推送至抖音草稿箱' : '已通过 Sidecar 发布到抖音')).slice(0, 200),
  };
}

export async function fetchUnrepliedCommentsViaSidecar(config, { limit = 10, deps = {} } = {}) {
  if (config.mode !== 'http' || !config.base_url) {
    return {
      supported: false,
      items: [],
      reason: config.mode === 'sau_cli'
        ? 'sau CLI 模式仅支持作品上传，自动巡检/回复评论请切换到 HTTP Sidecar 模式'
        : '尚未配置 Sidecar 地址',
    };
  }
  const safeLim = clampInt(limit, 10, 1, 30);
  const res = await sidecarJsonRequest(config, `/comments/unreplied?limit=${safeLim}`, {
    method: 'GET',
    timeoutMs: 20_000,
    fetchImpl: deps.fetch || fetch,
  });
  const rawList = Array.isArray(res.comments) ? res.comments : (Array.isArray(res.items) ? res.items : []);
  const items = rawList
    .filter(it => it && (it.comment_id || it.id) && String(it.text || it.content || '').trim())
    .map(it => ({
      comment_id: String(it.comment_id || it.id).slice(0, 120),
      item_id: it.item_id ? String(it.item_id).slice(0, 120) : null,
      item_title: it.item_title ? String(it.item_title).slice(0, 120) : '',
      author_name: it.author_name ? String(it.author_name).slice(0, 60) : '网友',
      text: String(it.text || it.content || '').trim().slice(0, 500),
      created_at: it.created_at || null,
    }));
  return { supported: true, items };
}

export async function replyCommentViaSidecar(config, { comment_id, item_id = null, text }, { deps = {} } = {}) {
  if (config.mode !== 'http' || !config.base_url) {
    throw Object.assign(new Error('自动回复评论需要配置 HTTP Sidecar 地址'), { code: 'UNSUPPORTED' });
  }
  const cleanText = String(text || '').trim();
  if (!comment_id || !cleanText) throw Object.assign(new Error('评论 ID 与回复内容不能为空'), { code: 'BAD_INPUT' });
  const res = await sidecarJsonRequest(config, '/comments/reply', {
    method: 'POST',
    body: { comment_id: String(comment_id), item_id: item_id ? String(item_id) : null, text: cleanText },
    timeoutMs: 25_000,
    fetchImpl: deps.fetch || fetch,
  });
  return {
    ok: true,
    reply_id: res.reply_id ? String(res.reply_id).slice(0, 120) : null,
    detail: String(res.detail || res.message || '已回复').slice(0, 200),
  };
}

// 作为标准插件注册到 Phase 2/3 插件注册表，便于在 /app/plugins.html 统一可见
export default {
  id: DOUYIN_SIDECAR_PLUGIN_ID,
  name: '抖音 Sidecar 发布与评论桥接',
  kind: 'publisher',
  description: '路线 1 外部发布器桥接（支持 HTTP Sidecar 与 social-auto-upload CLI），支持她自主发抖音与巡检回复评论。',
  defaultEnabled: false,
};
