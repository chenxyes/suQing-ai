/**
 * 内置 Resolver 插件 #1：HTTPS 链接速览（严格仅允许 https://，拒绝 http://）
 *
 * 场景：用户发来一条 B 站视频链接或公开 HTTPS 网页链接，程序侧确定性解析标题与简介
 * 注入本轮参考上下文，让她像真的点开看了一眼一样自然接话。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { assertHttpsUrl, fetchHttpsTextWithGuards } from '../../security/netguard.mjs';
import { sanitizeExternalText } from '../registry.mjs';

const HTTPS_URL_RE = /\bhttps:\/\/[^\s<>"{}|\\^`[\]]+/gi;
const BILI_BVID_RE = /\/video\/(BV[0-9A-Za-z]{6,20})/i;

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export function extractHttpsUrls(text) {
  const matches = String(text || '').match(HTTPS_URL_RE) || [];
  const urls = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[),.;!?，。！？；：）\]】》"']+$/g, '');
    try {
      urls.push(assertHttpsUrl(cleaned).toString());
    } catch {
      // 忽略无效或非 https 链接
    }
  }
  return urls;
}

function parseHtmlMeta(html) {
  const text = String(html || '');
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const ogTitle = text.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const ogDesc = text.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
    || text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
  const metaDesc = text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);

  const title = sanitizeExternalText(decodeHtmlEntities(ogTitle?.[1] || titleMatch?.[1] || ''), 120);
  const summary = sanitizeExternalText(decodeHtmlEntities(ogDesc?.[1] || metaDesc?.[1] || ''), 240);
  return { title, summary };
}

export default {
  id: 'resolver.link_preview',
  name: 'HTTPS 链接速览',
  kind: 'resolver',
  description: '识别聊天中的 https:// 链接（拒绝 http://），提取网页或 B 站视频标题与简介供自然接梗',
  defaultEnabled: true,
  timeoutMs: 8_000,

  match(userText) {
    return extractHttpsUrls(userText).length > 0;
  },

  async resolve(userText, ctx = {}) {
    const urls = extractHttpsUrls(userText);
    if (!urls.length) return null;
    const targetUrl = urls[0];
    const parsed = assertHttpsUrl(targetUrl);
    const fetcher = ctx.fetcher || ((u, o) => fetchHttpsTextWithGuards(u, o));

    const host = parsed.hostname.toLowerCase();
    const bvMatch = (host === 'www.bilibili.com' || host === 'm.bilibili.com' || host === 'bilibili.com')
      ? parsed.pathname.match(BILI_BVID_RE)
      : null;

    // 1. 优先直接抓取原始 HTTPS 页面前 192KB 解析 <title> / <meta>（单次往返，最快且不触发 api.bilibili.com 412）
    try {
      const res = await fetcher(targetUrl, {
        timeoutMs: 6_000,
        maxBytes: 192 * 1024,
        truncateOnLimit: true,
      });
      const { title, summary } = parseHtmlMeta(res.text);
      if (title || summary) {
        return {
          title: title || parsed.hostname,
          summary,
          source: bvMatch ? 'bilibili' : parsed.hostname,
        };
      }
    } catch (htmlErr) {
      if (!bvMatch) throw htmlErr;
    }

    // 2. B 站页面若未提取到标题，再尝试公开 view API 兜底
    if (bvMatch) {
      const bvid = bvMatch[1];
      const apiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
      const res = await fetcher(apiUrl, {
        timeoutMs: 4_000,
        maxBytes: 128 * 1024,
        headers: { Referer: 'https://www.bilibili.com/', Accept: 'application/json' },
      });
      const data = JSON.parse(res.text || '{}')?.data;
      if (data?.title) {
        const owner = sanitizeExternalText(data.owner?.name || '', 32);
        const desc = sanitizeExternalText(data.desc || '', 200);
        return {
          title: sanitizeExternalText(data.title, 120),
          summary: [owner ? `UP主：${owner}` : '', desc].filter(Boolean).join('；'),
          source: 'bilibili',
        };
      }
    }
    return null;
  },
};
