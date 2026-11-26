/**
 * src/plugins/builtins.mjs — 注册 Phase 2 首批内置插件（幂等）
 *
 * 首批确认范围（docs/LIVENESS_CONFIG_DESIGN.md §7）：
 *   1. feed.web_trends      — 热点兴趣冲浪（复用 web_search）
 *   2. feed.bilibili_hot    — B 站公开热门冲浪（零登录，HTTPS-only）
 *   3. resolver.link_preview — HTTPS 链接速览（拒绝 http://）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { registerPlugin, getPlugin } from './registry.mjs';
import webTrendsPlugin from './feeds/web_trends.mjs';
import bilibiliHotPlugin from './feeds/bilibili_hot.mjs';
import linkPreviewPlugin from './resolvers/link_preview.mjs';

const BUILTINS = [
  webTrendsPlugin,
  bilibiliHotPlugin,
  linkPreviewPlugin,
];

export function ensureBuiltinPluginsRegistered() {
  for (const p of BUILTINS) {
    if (!getPlugin(p.id)) registerPlugin(p);
  }
}

// 模块加载即自动注册内置插件
ensureBuiltinPluginsRegistered();
