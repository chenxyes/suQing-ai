/**
 * 溪语 AI · 前端公共工具层 (window.XiyuUI)
 *
 * 提供跨页面复用的基础工具：
 *   - token 读取与 Bearer 请求头构造
 *   - HTML 转义 (escapeHtml)
 *   - Lucide 图标安全渲染（自动补 aria-hidden="true"）
 *   - 轻量 toast 提示与 Service Worker 注册
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */
(function (global) {
  'use strict';

  function getToken() {
    try {
      return localStorage.getItem('xiyu_token') || localStorage.getItem('auth_token') || '';
    } catch {
      return '';
    }
  }

  function setToken(token) {
    try {
      if (token) {
        localStorage.setItem('xiyu_token', token);
      } else {
        localStorage.removeItem('xiyu_token');
        localStorage.removeItem('auth_token');
      }
    } catch {}
  }

  function authHeaders(extra) {
    const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    const t = getToken();
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderIcons(root) {
    if (typeof global.lucide === 'undefined' || !global.lucide.createIcons) return;
    try {
      const opts = { attrs: { 'stroke-width': 1.8, 'aria-hidden': 'true' } };
      if (root) opts.root = root;
      global.lucide.createIcons(opts);
    } catch {}
  }

  function registerSW() {
    if ('serviceWorker' in navigator) {
      global.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js').catch(function () {});
      });
    }
  }

  global.XiyuUI = {
    getToken,
    setToken,
    authHeaders,
    escapeHtml,
    renderIcons,
    registerSW,
  };
})(window);
