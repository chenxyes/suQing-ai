/**
 * 内置 Feed 插件 #1：热点/兴趣冲浪（复用现有 web_search.mjs，零新 API Key）
 *
 * 严格约束：
 *  - 未配置 SEARCH_PROVIDER 时静默返回空数组（fail-open）
 *  - 仅保留 https:// 链接（丢弃 http:// 等非 HTTPS URL）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import crypto from 'node:crypto';
import { getActiveSearchProvider, webSearch } from '../../web_search.mjs';
import { assertHttpsUrl } from '../../security/netguard.mjs';
import { sanitizeExternalText } from '../registry.mjs';

function parseHobbies(companion) {
  if (!companion) return [];
  if (Array.isArray(companion.hobbies)) return companion.hobbies.filter(Boolean).map(String);
  try {
    const parsed = JSON.parse(companion.hobbies || '[]');
    if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
  } catch {}
  return [];
}

function safeHttpsOrNull(raw) {
  if (!raw) return null;
  try {
    return assertHttpsUrl(String(raw)).toString();
  } catch {
    return null;
  }
}

export default {
  id: 'feed.web_trends',
  name: '热点兴趣冲浪',
  kind: 'feed',
  description: '复用联网搜索按她的兴趣自主搜新鲜话题与热梗（无需额外 Key）',
  defaultEnabled: true,
  cooldownHours: 4,
  timeoutMs: 6_000,

  async fetch(companion, ctx = {}) {
    const searchFn = ctx.search || ((q, opts) => webSearch(q, opts));
    if (!ctx.search && !getActiveSearchProvider().configured) {
      return [];
    }

    const hobbies = parseHobbies(companion);
    const chosenHobby = hobbies.length
      ? hobbies[Math.floor(Math.random() * hobbies.length)]
      : '有趣 新鲜事';
    const rawQuery = typeof ctx.query === 'string' && ctx.query.trim()
      ? ctx.query.trim().slice(0, 60)
      : `最近 热门 ${chosenHobby}`;

    const sr = await searchFn(rawQuery, { maxResults: 5, timeoutMs: 5500 });
    if (!sr || !sr.ok || !Array.isArray(sr.results)) return [];

    const out = [];
    for (const r of sr.results) {
      const title = sanitizeExternalText(r?.title, 120);
      const summary = sanitizeExternalText(r?.snippet, 280);
      if (!title || title.length < 4) continue;
      const url = safeHttpsOrNull(r?.url);
      const hash = crypto.createHash('sha1').update(`${title}|${url || ''}`).digest('hex').slice(0, 14);
      out.push({
        externalKey: `trend:${hash}`,
        title,
        summary,
        source: 'web_trends',
        url,
        tags: [chosenHobby].filter(Boolean),
      });
      if (out.length >= 4) break;
    }
    return out;
  },
};
