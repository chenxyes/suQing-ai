/**
 * 内置 Feed 插件 #2：B 站公开热门冲浪（零登录态，严格 HTTPS-Only + SSRF 防护）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { fetchHttpsTextWithGuards } from '../../security/netguard.mjs';
import { sanitizeExternalText } from '../registry.mjs';

const BILI_POPULAR_URL = 'https://api.bilibili.com/x/web-interface/popular?ps=12&pn=1';

function parseHobbies(companion) {
  if (!companion) return [];
  if (Array.isArray(companion.hobbies)) return companion.hobbies.filter(Boolean).map(String);
  try {
    const parsed = JSON.parse(companion.hobbies || '[]');
    if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
  } catch {}
  return [];
}

function scoreMatch(item, keywords) {
  if (!keywords.length) return 0;
  const hay = `${item.title} ${item.summary} ${(item.tags || []).join(' ')}`.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (kw && hay.includes(kw.toLowerCase())) score += 1;
  }
  return score;
}

export default {
  id: 'feed.bilibili_hot',
  name: 'B站热门冲浪',
  kind: 'feed',
  description: '零登录抓取 B 站公开热门视频标题与简介，按她的兴趣挑选新鲜槽点',
  defaultEnabled: false,
  cooldownHours: 6,
  timeoutMs: 6_000,

  async fetch(companion, ctx = {}) {
    const fetcher = ctx.fetcher || ((u, o) => fetchHttpsTextWithGuards(u, o));
    const res = await fetcher(BILI_POPULAR_URL, {
      timeoutMs: 5500,
      maxBytes: 256 * 1024,
      headers: {
        Referer: 'https://www.bilibili.com/',
        Accept: 'application/json',
      },
    });
    const parsed = JSON.parse(res.text || '{}');
    const list = Array.isArray(parsed?.data?.list) ? parsed.data.list : [];
    if (!list.length) return [];

    const mapped = list
      .filter(v => v && v.bvid && v.title)
      .map(v => {
        const bvid = String(v.bvid).replace(/[^A-Za-z0-9]/g, '');
        const title = sanitizeExternalText(v.title, 120);
        const owner = sanitizeExternalText(v.owner?.name || '', 32);
        const tname = sanitizeExternalText(v.tname || '', 24);
        const desc = sanitizeExternalText(v.desc || v.rcmd_reason?.content || '', 220);
        const parts = [
          tname ? `分区：${tname}` : '',
          owner ? `UP主：${owner}` : '',
          desc,
        ].filter(Boolean);
        return {
          externalKey: `bili:${bvid}`,
          title,
          summary: parts.join('；').slice(0, 300),
          source: 'bilibili',
          url: `https://www.bilibili.com/video/${bvid}`,
          tags: [tname].filter(Boolean),
        };
      });

    const keywords = [
      ...parseHobbies(companion),
      ...(typeof ctx.query === 'string' && ctx.query.trim() ? ctx.query.trim().split(/\s+/) : []),
    ].filter(Boolean);

    if (keywords.length) {
      mapped.sort((a, b) => scoreMatch(b, keywords) - scoreMatch(a, keywords));
    }
    return mapped.slice(0, 5);
  },
};
