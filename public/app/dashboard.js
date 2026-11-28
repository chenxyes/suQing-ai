/* 溪语 AI · 控制台主逻辑（从 dashboard.html 拆分） */
lucide.createIcons({ attrs: { 'stroke-width': 1.8, 'aria-hidden': 'true' } });

let user = JSON.parse(localStorage.getItem('xiyu_user') || 'null');
const token = localStorage.getItem('xiyu_token') || '';
// v1.10.28: companionId 升到 script 顶层全局，让 sleep/wake/reset handler 等
// 在 load() 外定义的函数能访问。原先在 load() 内 let，是 latent ReferenceError
// —— 之前 sleep-card 默认 hidden 没人点保存所以没暴露。
let companionId = null;
if (!token) { location.href = '/app/auth.html'; }
// 兼容老 setup wizard 漏存 xiyu_user 的场景：从 /api/auth/me 回填
if (token && !user) {
  user = { id: 0, username: '账号' };
  fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
    .then(r => r.json())
    .then(d => {
      if (d.ok && d.data?.authenticated && d.data?.user) {
        const u = { id: d.data.user.id, username: d.data.user.display_name };
        localStorage.setItem('xiyu_user', JSON.stringify(u));
        user.id = u.id; user.username = u.username;
        const nameEl = document.getElementById('user-name');
        const greetEl = document.getElementById('greet-name');
        if (nameEl)  nameEl.textContent  = u.username;
        if (greetEl) greetEl.textContent = u.username;
      } else {
        localStorage.removeItem('xiyu_token');
        location.href = '/app/auth.html';
      }
    })
    .catch(() => { /* 网络瞬时失败先不弹 */ });
}

// 全局 fetch 包装：自动加 Authorization + 处理 401 → 跳登录
const _origFetch = window.fetch;
window.fetch = function(url, init = {}) {
  const isApi = typeof url === 'string' && url.startsWith('/api/');
  if (isApi) {
    init.headers = { ...(init.headers || {}), Authorization: `Bearer ${token}` };
  }
  return _origFetch(url, init).then(res => {
    if (isApi && res.status === 401) {
      localStorage.removeItem('xiyu_token');
      localStorage.removeItem('xiyu_user');
      location.href = '/app/auth.html';
    }
    return res;
  });
};

document.getElementById('user-name').textContent = user.username;
document.getElementById('greet-name').textContent = user.username;
const params = new URLSearchParams(location.search);
if (params.get('rebind') === 'true') {
  const toast = document.getElementById('toast');
  toast.textContent = '已切换到新微信';
  toast.classList.remove('hidden');
  history.replaceState(null, '', location.pathname);
}
document.getElementById('btn-logout').addEventListener('click', () => {
  localStorage.clear();
  location.href = '/app/auth.html';
});
// v1.5.1: SINGLE_USER 模式下隐藏"登出"按钮（登出后自动又会被登回，按钮无意义）
// v1.10.20: HOSTED_MODE 下隐藏"模型设置"入口 + provider 名 + "开源版"徽章（部署版不应暴露技术栈）
fetch('/api/setup/status').then(r => r.json()).then(d => {
  if (d?.data?.single_user) {
    const btn = document.getElementById('btn-logout');
    if (btn) btn.style.display = 'none';
  }
  if (d?.data?.hosted_mode) {
    const openBtn = document.getElementById('btn-open-model');
    if (openBtn) openBtn.remove();
    const drawer = document.getElementById('model-drawer');
    if (drawer) drawer.remove();
    const mask = document.getElementById('model-mask');
    if (mask) mask.remove();
    const modelTabBtn = document.querySelector('.dash-tab[data-dash-tab="models"]');
    if (modelTabBtn) modelTabBtn.remove();
    const modelTabPanel = document.getElementById('dash-tab-models');
    if (modelTabPanel) modelTabPanel.remove();
    const badge = document.getElementById('plan-badge');
    if (badge) badge.remove();
  }
}).catch(() => {});

// 主动消息：用户拖动滑块直接定每天目标条数（与 proactive.mjs ±20% 抖动一致）
function refreshProactiveQuota(target) {
  const quota = document.getElementById('proactive-quota');
  if (!quota) return;
  const t = Number.isFinite(target) ? target : 10;
  if (t === 0) { quota.textContent = '· 静默模式：不主动找你，只响应你的消息'; return; }
  const lo = Math.max(0, Math.floor(t * 0.8));
  const hi = Math.max(lo, Math.ceil(t * 1.2));
  quota.textContent = `· 每天约 ${lo}-${hi} 条 · 23:00 主动晚安`;
}
refreshProactiveQuota();

function getRecommendedChatMode(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hour12: false,
  }).format(now));

  if (hour >= 6 && hour < 9) return '早安问候';
  if (hour >= 9 && hour < 12) return '日常聊天';
  if (hour >= 12 && hour < 14) return '午间陪伴';
  if (hour >= 14 && hour < 18) return '日常聊天';
  if (hour >= 18 && hour < 21) return '晚间陪伴';
  if (hour >= 21 && hour < 23) return '睡前故事';
  return '深夜陪伴';
}

function clearCompanionCache() {
  for (const store of [localStorage, sessionStorage]) {
    store.removeItem('xiyu_companion_id');
    store.removeItem('xiyu_companion_summary');
    store.removeItem('xiyu_pending_companion');
    store.removeItem('xiyu_wechat_user_id');
  }
}

async function deleteCurrentCompanion() {
  const companionId = localStorage.getItem('xiyu_companion_id');
  const name = document.getElementById('c-name').textContent || '她';
  if (!companionId) {
    alert('缺少 companion_id，无法删除');
    return;
  }
  if (!confirm(`确定要删除${name}吗？删除后无法恢复，所有记忆也会清空。`)) return;

  const btn = document.getElementById('btn-delete-companion');
  btn.disabled = true;
  btn.textContent = '删除中...';
  try {
    const res = await fetch('/api/companions/' + encodeURIComponent(companionId) + '?user_id=' + encodeURIComponent(user.id), {
      method: 'DELETE',
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) {
      throw new Error(payload.message || payload.error || '删除失败');
    }
    clearCompanionCache();
    location.href = '/app/create.html';
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '删除她';
    alert(e.message || '删除失败');
  }
}

async function fetchWechatBinding() {
  try {
    const r = await fetch('/api/me/wechat?user_id=' + encodeURIComponent(user.id));
    const d = await r.json();
    if (r.ok && d.ok && d.data?.wechat_user_id) return d.data;
  } catch {}
  return null;
}

async function tryCreateCompanionFromDraft(binding) {
  const draft = JSON.parse(localStorage.getItem('xiyu_pending_companion') || 'null');
  if (!draft || !binding?.wechat_user_id) return null;
  try {
    const payload = { wechat_user_id: binding.wechat_user_id, ...draft };
    if (binding.bot_id) payload.bot_id = binding.bot_id;
    const cr = await fetch('/api/companions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const cd = await cr.json().catch(() => ({}));
    if (!cr.ok || !cd.ok || !cd.data?.id) {
      console.warn('兜底创建人设失败：', cd);
      return null;
    }
    localStorage.removeItem('xiyu_pending_companion');
    return cd.data.id;
  } catch (e) {
    console.warn('兜底创建人设异常：', e);
    return null;
  }
}

// v1.4.2: 全局能力探测，决定 TTS 按钮是否可见
let CAPS = { tts: false };
async function loadCapabilities() {
  try {
    const r = await fetch('/api/me/capabilities', { headers: { Authorization: 'Bearer ' + token } });
    const d = await r.json();
    if (d?.ok) CAPS = d.data || CAPS;
  } catch {}
}
function applyVoiceVisibility() {
  // TTS 没配 → 隐藏所有语音按钮，避免点了报错
  const ttsOk = !!CAPS.tts;
  const setHide = (el, hide) => { if (el) el.style.display = hide ? 'none' : ''; };
  setHide(document.getElementById('btn-thought-play'), !ttsOk);
  setHide(document.getElementById('btn-voice-preview'), !ttsOk);
  // 「网页语音体验」卡片整体在 TTS 未配时也隐藏（避免 toggle 没意义）
  const voiceCard = document.getElementById('btn-voice-preview')?.closest('.card');
  // 不隐藏整卡，但把 toggle 改成"未配置"提示
  const t = document.getElementById('t-voice');
  if (t && !ttsOk) { t.disabled = true; t.title = '请先去 setup 配置 TTS provider'; }
  const msg = document.getElementById('voice-preview-msg');
  if (msg && !ttsOk) msg.textContent = '未配置 TTS · 去 /app/setup.html 设置';
}

async function load() {
  // v1.10.28: companionId 已在 script 顶层声明，这里只赋值
  companionId = null;
  let c = null;

  try {
    const meRes = await fetch('/api/me/companion?user_id=' + encodeURIComponent(user.id));
    const mePayload = await meRes.json();
    if (!meRes.ok || !mePayload.ok) {
      throw new Error(mePayload.message || mePayload.error || 'companion 加载失败');
    }

    if (!mePayload.data) {
      // 有 binding 但缺 companion，且本地还有 draft，则兜底创建一次
      const wechatBinding = await fetchWechatBinding();
      if (wechatBinding) {
        const newId = await tryCreateCompanionFromDraft(wechatBinding);
        if (newId) {
          companionId = String(newId);
        }
      }
      if (!companionId) {
        clearCompanionCache();
      }
    } else {
      companionId = String(mePayload.data.companion_id);
      c = mePayload.data.companion;
      localStorage.setItem('xiyu_companion_id', companionId);
      localStorage.setItem('xiyu_companion_summary', JSON.stringify(c));
      if (mePayload.data.binding?.wechat_user_id) {
        localStorage.setItem('xiyu_wechat_user_id', mePayload.data.binding.wechat_user_id);
      }
    }
  } catch (e) {
    console.warn(e);
    companionId = localStorage.getItem('xiyu_companion_id');
  }

  document.getElementById('loading').classList.add('hidden');

  if (!companionId) {
    document.getElementById('no-companion').classList.remove('hidden');
    return;
  }

  if (!c) {
    const summaryRes = await fetch('/api/companions/' + companionId + '/summary');
    const summaryPayload = await summaryRes.json();
    if (!summaryRes.ok || !summaryPayload.ok) {
      localStorage.removeItem('xiyu_companion_id');
      localStorage.removeItem('xiyu_companion_summary');
      throw new Error(summaryPayload.error || 'companion 加载失败');
    }
    c = summaryPayload.data;
    localStorage.setItem('xiyu_companion_summary', JSON.stringify(c));
  }

  document.getElementById('has-companion').classList.remove('hidden');
  document.getElementById('c-name').textContent  = c.name || '溪语';
  document.getElementById('c-avatar').src = c.avatar_url || '/default-avatar.webp';
  document.getElementById('c-mood').textContent  = (c.mood || '平静');
  document.getElementById('c-meta').textContent  =
    `${c.age || 20} 岁 · ${c.role_title || c.persona || '邻家女孩'}`;
  const stageNames = ['陌生人','朋友','暧昧','恋人','深爱'];
  const curStage = c.relationship_stage || '陌生人';
  document.getElementById('c-stage').textContent = '💕 ' + curStage;

  const aff = c.affection ?? 0;
  document.getElementById('aff-val').textContent = aff;
  document.getElementById('aff-bar').style.width = aff + '%';
  // 5 段式
  const stageIdx = stageNames.indexOf(curStage);
  for (let i = 0; i < 5; i++) {
    const seg = document.getElementById('stage-seg-' + i);
    seg.classList.remove('on', 'cur');
    if (i < stageIdx) seg.classList.add('on');
    if (i === stageIdx) seg.classList.add('cur');
  }

  // c-scene 初始用 logo placeholder "—"，loadNowCard 会覆盖为当前活动
  // c-mode 已在 HTML 中渲染为"✨ 自适应"，无需改
  document.getElementById('c-mem').textContent   = (c.memory_count ?? 0) + ' 条';

  // greeting subtitle 个性化
  const sub = document.getElementById('greet-subtitle');
  if (sub) sub.textContent = `${c.name || '她'}今天的心情：${c.mood || '平静'} · 关系：${curStage}`;

  document.getElementById('btn-edit-companion').href =
    '/app/create.html?edit=true&id=' + encodeURIComponent(companionId);

  // 初始化 toggles
  const tProactive = document.getElementById('t-proactive');
  const tSticker = document.getElementById('t-sticker');
  const tMemory = document.getElementById('t-memory');
  const tVoice = document.getElementById('t-voice');
  const tSilent = document.getElementById('t-silent');
  const tFirstLove = document.getElementById('t-first-love');
  const silentOrb = document.getElementById('silent-orb');
  tProactive.checked = !!c.proactive_enabled;
  tSticker.checked = !!c.sticker_reply_enabled;
  tMemory.checked = c.memory_enabled !== false;   // 默认开
  tVoice.checked = !!c.voice_reply_enabled;        // v1.4.0 默认关
  if (tSilent) tSilent.checked = !!c.silent_mode;
  // v1.19.3 初恋默认开：undefined/null/1 都算开，与 buildSystemPrompt 一致
  if (tFirstLove) tFirstLove.checked = !(c.first_love === 0 || c.first_love === false);

  // v1.20 安全模式横幅 + 年龄声明解除（解除只走专用端点，不走通用 PATCH）
  (function initSafeMode(){
    const banner = document.getElementById('safe-mode-banner');
    const btn = document.getElementById('btn-age-attest');
    if (!banner || !btn) return;
    banner.style.display = (c.safe_mode === 1) ? '' : 'none';
    btn.addEventListener('click', async () => {
      const y = prompt('请输入你的出生年份（4 位数字）。\n虚假声明由声明者自行承担责任。');
      if (!y) return;
      const birthYear = parseInt(y, 10);
      if (!Number.isFinite(birthYear)) { alert('请输入有效年份'); return; }
      if (!confirm('我郑重声明：我已年满 18 周岁。')) return;
      try {
        const r = await fetch('/api/companions/' + companionId + '/age-attestation', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ birth_year: birthYear, confirm_adult: true }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || '声明失败');
        if (d.data.released) { showToast('安全模式已解除'); banner.style.display = 'none'; }
        else { alert('根据你填写的出生年份，安全模式将保持开启。'); }
      } catch (e) { alert(e.message); }
    });
  })();
  function paintSilentOrb(on) {
    if (silentOrb) silentOrb.style.display = on ? '' : 'none';
  }
  paintSilentOrb(!!c.silent_mode);

  async function patchCompanion(field, value) {
    try {
      const r = await fetch('/api/companions/' + companionId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value ? 1 : 0 }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || '保存失败');
      showToast('已保存');
    } catch (e) {
      alert(e.message);
    }
  }

  tProactive.addEventListener('change', () => {
    // v1.13.x：用户想「关掉」时先给一个"调低频率"的下台阶，而不是一刀关掉整个功能
    if (!tProactive.checked) { showProactiveOffRamp(); return; }
    patchCompanion('proactive_enabled', true);
    syncSliderEnabled();
  });
  tSticker.addEventListener('change', () => patchCompanion('sticker_reply_enabled', tSticker.checked));
  tMemory.addEventListener('change', () => patchCompanion('memory_enabled', tMemory.checked));
  tVoice.addEventListener('change', () => patchCompanion('voice_reply_enabled', tVoice.checked));
  if (tFirstLove) {
    tFirstLove.addEventListener('change', async () => {
      await patchCompanion('first_love', tFirstLove.checked);
      showToast(tFirstLove.checked ? '已开启 · 你是她的初恋' : '已关闭 · 她谈过恋爱');
    });
  }
  if (tSilent) {
    tSilent.addEventListener('change', async () => {
      await patchCompanion('silent_mode', tSilent.checked);
      paintSilentOrb(tSilent.checked);
    });
  }
  if (silentOrb) {
    silentOrb.addEventListener('click', async () => {
      if (tSilent) tSilent.checked = false;
      await patchCompanion('silent_mode', false);
      paintSilentOrb(false);
      showToast && showToast('已退出沉默陪伴模式');
    });
  }

  // 语音试听：调 /tts-preview 拿 mp3 字节，浏览器 Audio 直接播
  const btnVoicePreview = document.getElementById('btn-voice-preview');
  const voicePreviewMsg = document.getElementById('voice-preview-msg');
  let voicePreviewAudio = null;
  btnVoicePreview.addEventListener('click', async () => {
    if (btnVoicePreview.disabled) return;
    btnVoicePreview.disabled = true;
    voicePreviewMsg.textContent = '合成中…';
    try {
      const r = await fetch(`/api/companions/${companionId}/tts-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '你好呀，我是' + (c.name || '溪语') + '，今天过得怎么样？' }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + r.status));
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (voicePreviewAudio) { voicePreviewAudio.pause(); URL.revokeObjectURL(voicePreviewAudio.src); }
      voicePreviewAudio = new Audio(url);
      voicePreviewAudio.onended = () => { voicePreviewMsg.textContent = '播放完毕'; };
      await voicePreviewAudio.play();
      voicePreviewMsg.textContent = '播放中…';
    } catch (e) {
      voicePreviewMsg.textContent = '失败：' + e.message;
    } finally {
      setTimeout(() => { btnVoicePreview.disabled = false; }, 800);
    }
  });

  // ─── 时光胶囊（v1.5）─────────────────────────────────────────────────
  const capsuleTitle = document.getElementById('capsule-title');
  const capsuleBody = document.getElementById('capsule-body');
  const capsuleUnlock = document.getElementById('capsule-unlock');
  const btnCapsuleCreate = document.getElementById('btn-capsule-create');
  const btnCapsuleRefresh = document.getElementById('btn-capsule-refresh');
  const capsuleMsg = document.getElementById('capsule-msg');
  const capsuleList = document.getElementById('capsule-list');
  function escapeHtmlSafe(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function formatCapsuleTime(sec) {
    if (!sec) return '';
    const d = new Date(sec * 1000);
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
      + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  }
  function formatCountdown(unlockSec) {
    const nowSec = Math.floor(Date.now() / 1000);
    const diff = unlockSec - nowSec;
    if (diff <= 0) return '可解封';
    const days = Math.floor(diff / 86400);
    const hours = Math.floor((diff % 86400) / 3600);
    if (days >= 1) return `${days} 天 ${hours} 小时后`;
    const mins = Math.floor((diff % 3600) / 60);
    return `${hours} 小时 ${mins} 分钟后`;
  }
  async function refreshCapsules() {
    try {
      const tk = localStorage.getItem('jwt_token') || sessionStorage.getItem('jwt_token') || '';
      const r = await fetch(`/api/companions/${companionId}/time-capsules?status=all`, {
        headers: { Authorization: 'Bearer ' + tk },
      });
      const d = await r.json();
      if (!d.ok) { capsuleList.innerHTML = `<div class="text-mute">加载失败：${escapeHtmlSafe(d.error || d.message || '')}</div>`; return; }
      const items = d.data?.capsules || [];
      if (!items.length) { capsuleList.innerHTML = '<div class="text-mute">还没有胶囊。封一个吧 ↑</div>'; return; }
      capsuleList.innerHTML = items.map(cap => {
        const opened = !!cap.opened_at;
        const titleLine = cap.title ? `<div class="font-semibold mb-1">${escapeHtmlSafe(cap.title)}</div>` : '';
        const bodySnippet = cap.body.length > 80 ? escapeHtmlSafe(cap.body.slice(0, 80)) + '…' : escapeHtmlSafe(cap.body);
        if (opened) {
          const reactionHtml = cap.her_reaction
            ? `<div class="mt-2 p-2 rounded-lg bg-sakura-soft/60 text-ink/90 leading-relaxed">${escapeHtmlSafe(cap.her_reaction)}</div>`
            : `<div class="mt-2 text-mute italic">她还在写感想…</div>`;
          return `
            <div class="p-3 rounded-xl border border-line bg-white/60">
              ${titleLine}
              <div class="text-mute leading-relaxed whitespace-pre-wrap">${escapeHtmlSafe(cap.body)}</div>
              ${reactionHtml}
              <div class="mt-2 text-[11px] text-mute/70">封存：${formatCapsuleTime(cap.created_at)} · 解封：${formatCapsuleTime(cap.opened_at)}</div>
            </div>`;
        }
        const canOpenNow = cap.unlock_at <= Math.floor(Date.now() / 1000);
        return `
          <div class="p-3 rounded-xl border border-dashed border-line bg-white/40">
            ${titleLine}
            <div class="text-mute leading-relaxed">${bodySnippet}</div>
            <div class="mt-2 flex items-center justify-between gap-2 text-[11px]">
              <span class="text-sakura-deep font-semibold">${formatCountdown(cap.unlock_at)}（${formatCapsuleTime(cap.unlock_at)}）</span>
              <div class="flex gap-2">
                ${canOpenNow ? `<button data-cap-open="${cap.id}" class="text-sakura-deep hover:underline">让她现在打开</button>` : ''}
                <button data-cap-del="${cap.id}" class="text-mute hover:text-ink">删除</button>
              </div>
            </div>
          </div>`;
      }).join('');
      // bind delete
      capsuleList.querySelectorAll('[data-cap-del]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('删除这个胶囊？（仅未开封的可删）')) return;
          const cid = btn.dataset.capDel;
          const r = await fetch(`/api/companions/${companionId}/time-capsules/${cid}`, {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + (localStorage.getItem('jwt_token') || sessionStorage.getItem('jwt_token') || '') },
          });
          if (r.ok) refreshCapsules();
        });
      });
      // bind open-now
      capsuleList.querySelectorAll('[data-cap-open]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const cid = btn.dataset.capOpen;
          btn.textContent = '生成中…'; btn.disabled = true;
          const r = await fetch(`/api/companions/${companionId}/time-capsules/${cid}/open-now`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + (localStorage.getItem('jwt_token') || sessionStorage.getItem('jwt_token') || '') },
          });
          if (r.ok) refreshCapsules(); else { btn.textContent = '让她现在打开'; btn.disabled = false; alert('解封失败'); }
        });
      });
    } catch (e) {
      capsuleList.innerHTML = `<div class="text-mute">加载失败：${escapeHtmlSafe(e.message)}</div>`;
    }
  }
  if (btnCapsuleRefresh) btnCapsuleRefresh.addEventListener('click', refreshCapsules);
  if (btnCapsuleCreate) {
    btnCapsuleCreate.addEventListener('click', async () => {
      const body = (capsuleBody?.value || '').trim();
      const title = (capsuleTitle?.value || '').trim() || null;
      const delta = Number(capsuleUnlock?.value);
      if (body.length < 5) { capsuleMsg.textContent = '内容太短（至少 5 字）'; return; }
      if (!Number.isFinite(delta) || delta < 60) { capsuleMsg.textContent = '解锁时间无效'; return; }
      btnCapsuleCreate.disabled = true;
      capsuleMsg.textContent = '封存中…';
      try {
        const unlockAt = Math.floor(Date.now() / 1000) + delta;
        const tk = localStorage.getItem('jwt_token') || sessionStorage.getItem('jwt_token') || '';
        const r = await fetch(`/api/companions/${companionId}/time-capsules`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk },
          body: JSON.stringify({ body, title, unlock_at: unlockAt }),
        });
        const d = await r.json();
        if (!d.ok) { capsuleMsg.textContent = '失败：' + (d.error || d.message || ''); return; }
        capsuleMsg.textContent = '✓ 已封存';
        if (capsuleTitle) capsuleTitle.value = '';
        if (capsuleBody) capsuleBody.value = '';
        refreshCapsules();
      } catch (e) {
        capsuleMsg.textContent = '失败：' + e.message;
      } finally {
        setTimeout(() => { btnCapsuleCreate.disabled = false; }, 800);
      }
    });
  }
  // 初次加载
  if (capsuleList) refreshCapsules();

  // ─── 离线留言胶囊（v1.5）─────────────────────────────────────────────
  const btnLetter = document.getElementById('btn-letter-generate');
  const letterMsg = document.getElementById('letter-msg');
  const letterHintEl = document.getElementById('letter-hint');
  if (btnLetter) {
    btnLetter.addEventListener('click', async () => {
      if (btnLetter.disabled) return;
      btnLetter.disabled = true;
      letterMsg.textContent = '她在写…大约 5-10 秒';
      try {
        const hint = (letterHintEl?.value || '').trim();
        const tk = localStorage.getItem('jwt_token') || sessionStorage.getItem('jwt_token') || '';
        const r = await fetch(`/api/companions/${companionId}/offline-letter`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk },
          body: JSON.stringify({ hint }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || ('HTTP ' + r.status));
        }
        const blob = await r.blob();
        // 文件名从响应头取，取不到就用默认
        const cd = r.headers.get('Content-Disposition') || '';
        const m = cd.match(/filename="([^"]+)"/);
        const filename = m ? m[1] : `xiyu-letter-${Date.now()}.txt`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        letterMsg.textContent = '✓ 已下载 ' + filename;
        if (letterHintEl) letterHintEl.value = '';
      } catch (e) {
        letterMsg.textContent = '失败：' + e.message;
      } finally {
        setTimeout(() => { btnLetter.disabled = false; }, 2000);
      }
    });
  }

  // 主动消息：用户拖动滑块直接调每天目标条数 (proactive_daily_target, 0-30)
  const slider = document.getElementById('proactive-target-slider');
  const valEl  = document.getElementById('proactive-target-val');
  const initTarget = (Number.isFinite(Number(c.proactive_daily_target)) ? Number(c.proactive_daily_target) : 4);
  function paintSliderFill(v) {
    slider.style.setProperty('--fill', ((v - slider.min) / (slider.max - slider.min) * 100) + '%');
  }
  function syncSliderEnabled() {
    slider.disabled = !tProactive.checked;
  }
  slider.value = String(initTarget);
  valEl.textContent = String(initTarget);
  paintSliderFill(initTarget);
  syncSliderEnabled();
  refreshProactiveQuota(initTarget);

  // 拖动时实时显示数字 + 染色；松开手才写后端（debounce 替代）
  let pendingSave = null;
  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    valEl.textContent = String(v);
    paintSliderFill(v);
    refreshProactiveQuota(v);
  });
  slider.addEventListener('change', async () => {
    const v = Number(slider.value);
    if (pendingSave) clearTimeout(pendingSave);
    pendingSave = setTimeout(async () => {
      try {
        const r = await fetch('/api/companions/' + companionId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proactive_daily_target: v }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || '保存失败');
        showToast('已保存 · 每天 ' + v + ' 条');
      } catch (e) { alert(e.message); }
    }, 200);
  });

  // ── v1.13.x 主动消息「先调低再关」下台阶 ──
  const offModal   = document.getElementById('proactive-off-modal');
  const offLower   = document.getElementById('proactive-off-lower');
  const offDisable = document.getElementById('proactive-off-disable');
  const offCancel  = document.getElementById('proactive-off-cancel');
  const OFF_RAMP_TARGET = 2;   // "调低"落到每天 2 条
  function showProactiveOffRamp() {
    if (!offModal) {           // 兜底：没有弹窗就按原行为直接关
      patchCompanion('proactive_enabled', false);
      syncSliderEnabled();
      return;
    }
    offModal.classList.remove('hidden');
  }
  function hideProactiveOffRamp() { if (offModal) offModal.classList.add('hidden'); }
  // 取消 / 点遮罩 → 维持开启，什么都不改
  function cancelProactiveOffRamp() {
    tProactive.checked = true;
    syncSliderEnabled();
    hideProactiveOffRamp();
  }
  async function applyProactiveTarget(v) {
    slider.value = String(v);
    valEl.textContent = String(v);
    paintSliderFill(v);
    refreshProactiveQuota(v);
    const r = await fetch('/api/companions/' + companionId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proactive_daily_target: v }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || '保存失败');
  }
  if (offCancel)  offCancel.addEventListener('click', cancelProactiveOffRamp);
  if (offModal)   offModal.addEventListener('click', (e) => { if (e.target === offModal) cancelProactiveOffRamp(); });
  if (offLower)   offLower.addEventListener('click', async () => {
    hideProactiveOffRamp();
    tProactive.checked = true;          // 保持开启
    syncSliderEnabled();
    try { await applyProactiveTarget(OFF_RAMP_TARGET); showToast('已调低 · 每天 ' + OFF_RAMP_TARGET + ' 条'); }
    catch (e) { alert(e.message); }
  });
  if (offDisable) offDisable.addEventListener('click', () => {
    hideProactiveOffRamp();
    tProactive.checked = false;
    patchCompanion('proactive_enabled', false);
    syncSliderEnabled();
  });

  // 头像点击 → 弹换头像
  const cAvatarEl = document.getElementById('c-avatar');
  cAvatarEl.style.cursor = 'pointer';
  cAvatarEl.title = '点击更换头像';
  cAvatarEl.addEventListener('click', () => openAvatarModal(companionId));

  // 加载"我们的故事"时间轴
  loadTimeline(companionId, c);

  // M3 共建留痕卡片
  (function initShaping(){
    const card = document.getElementById('shaping-card');
    const body = document.getElementById('shaping-body');
    if (!card || !body) return;
    const LABEL = { nickname:'她这样叫你', style:'说话风格', pact:'你们的约定', taboo:'雷区', fact:'她记得你', lexicon:'专属梗' };
    const esc = s => String(s).replace(/[<>&]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[c]));
    fetch('/api/companions/' + companionId + '/shaping').then(r => r.json()).then(d => {
      const sh = ((d && d.data) || d || {}).shaping || {};
      let html = '', total = 0;
      for (const k of ['nickname','style','pact','taboo','fact','lexicon']) {
        const items = sh[k] || [];
        if (!items.length) continue;
        total += items.length;
        html += '<div class="flex gap-2 text-[12px] leading-relaxed"><span class="text-mute font-medium shrink-0 w-[68px]">' + LABEL[k] + '</span><span class="font-bold text-sakura-deep flex-1">' + items.map(i => esc(i.content)).join('、') + '</span></div>';
      }
      if (!total) html = '<p class="text-[12px] text-mute leading-relaxed">还没有痕迹——在聊天里教教她吧:「以后叫我…」「说话皮一点」「我不吃香菜」「答应我…」，她会记住并照做。</p>';
      body.innerHTML = html;
      card.style.display = '';
    }).catch(() => {});
  })();

  // v1.14: 依恋风格选择器
  (function initAttach(){
    const DESC = {
      secure:   '安全型：受了委屈会直说"我有点难过"，不憋着也不闹。别扭来得慢、好得快，哄一句真心的就过去了。',
      anxious:  '焦虑型：心思重、在乎得快，一点冷落就胡思乱想。但她软得也快，你一句正经道歉就忍不住原谅你。',
      avoidant: '回避型：受伤不说，先把自己收起来装不在意。冷得久、解冻慢，和好后还会别扭一阵子才真正回暖。',
    };
    const opts = document.querySelectorAll('.attach-opt');
    const descEl = document.getElementById('attach-desc');
    if (!opts.length) return;
    let cur = (c.attachment_style || 'secure');
    function paint(v){
      opts.forEach(b => {
        const on = b.dataset.val === v;
        b.classList.toggle('bg-sakura', on);
        b.classList.toggle('text-white', on);
        b.classList.toggle('border-sakura', on);
        b.classList.toggle('text-mute', !on);
        b.classList.toggle('border-sakura-soft', !on);
      });
      if (descEl) descEl.textContent = DESC[v] || '';
    }
    paint(cur);
    opts.forEach(b => b.addEventListener('click', async () => {
      const v = b.dataset.val;
      if (v === cur) return;
      const prev = cur; cur = v; paint(v);
      try {
        const r = await fetch('/api/companions/' + companionId, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attachment_style: v }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || '保存失败');
        showToast('已切换 · ' + b.textContent.trim());
      } catch (e) { cur = prev; paint(prev); alert(e.message); }
    }));
  })();

  // 加载"她现在"实时状态
  loadNowCard(companionId);

  // 加载情绪趋势 + AI 用量
  loadTrendSection(companionId);

  // v1.4.1: 加载今天她想你 + 想念度小条
  // v1.4.2: 先探测 TTS 能力，再加载（loadDailyThought 内部会按 CAPS 决定是否显示 🔊）
  await loadCapabilities();
  applyVoiceVisibility();
  loadDailyThought(companionId);

  // 加载 P2 成就 & 备份区
  loadP2Section(companionId);

  // v1.9.8: AI 用量卡片

  // reveal in
  document.querySelectorAll('.reveal').forEach((el, i) => {
    setTimeout(() => el.classList.add('in'), 80 * i);
  });
}

// ─── 她现在（实时状态）────────────────────────────────────────────
async function loadNowCard(companionId) {
  const sceneEl = document.getElementById('c-scene');
  try {
    const r = await fetch('/api/companions/' + companionId + '/today');
    const d = await r.json();
    if (!r.ok || !d.ok) {
      if (sceneEl) sceneEl.textContent = '今天日程加载中…';
      return;
    }
    const x = d.data;
    if (!x.has_schedule) {
      // v1.9.9: 后端会异步触发日程生成，几秒后刷新就有。文案改更拟人。
      if (sceneEl) sceneEl.textContent = '她还在想今天要做点什么…过会儿再看';
      return;
    }
    const card = document.getElementById('now-card');
    document.getElementById('now-time').textContent = x.now;
    const actText = x.current_activity ? x.current_activity.activity : '正在等今天的日程开始...';
    document.getElementById('now-activity').textContent = actText;
    // 同步 profile 顶部的"她在做"
    if (sceneEl) sceneEl.textContent = x.current_activity ? x.current_activity.activity : '今天还没开始活动';
    document.getElementById('now-mood').textContent = x.segment_mood || x.mood_arc || '';
    const prevBlock = document.getElementById('now-prev-block');
    const prevEl = document.getElementById('now-prev');
    if (x.previous_activity && prevEl) {
      prevEl.textContent = `${x.previous_activity.time} · ${x.previous_activity.activity}`;
      prevBlock?.classList.remove('hidden');
    } else {
      prevBlock?.classList.add('hidden');
    }
    card.classList.remove('hidden');
  } catch (e) {
    console.warn('today:', e.message);
    if (sceneEl) sceneEl.textContent = '今天日程加载失败';
  }
}

// ─── 头像更换 ─────────────────────────────────────────────────
let _pendingAvatarBase64 = null;
function openAvatarModal(companionId) {
  _pendingAvatarBase64 = null;
  document.getElementById('avatar-preview').src = document.getElementById('c-avatar').src;
  document.getElementById('btn-upload-avatar').classList.add('hidden');
  document.getElementById('avatar-msg').classList.add('hidden');
  document.getElementById('avatar-modal').classList.remove('hidden');
  document.getElementById('avatar-modal').dataset.companionId = companionId;
  lucide.createIcons({ attrs: { 'stroke-width': 1.8, 'aria-hidden': 'true' } });
}
document.getElementById('avatar-close').addEventListener('click', () => {
  document.getElementById('avatar-modal').classList.add('hidden');
});
document.getElementById('avatar-modal').addEventListener('click', (e) => {
  if (e.target.id === 'avatar-modal') document.getElementById('avatar-modal').classList.add('hidden');
});
document.getElementById('btn-pick-file').addEventListener('click', () => {
  document.getElementById('avatar-file').click();
});

// 从精选池为我匹配 4 张
document.getElementById('btn-ai-suggest').addEventListener('click', async () => {
  const btn = document.getElementById('btn-ai-suggest');
  const cid = document.getElementById('avatar-modal').dataset.companionId;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2" class="inline w-4 h-4 align-[-3px]" style="animation:spin .8s linear infinite"></i> 正在匹配...';
  lucide.createIcons({ attrs: { 'stroke-width': 1.8, 'aria-hidden': 'true' } });
  document.getElementById('ai-candidates').classList.add('hidden');
  try {
    const r = await fetch('/api/companions/' + cid + '/avatar/suggest');
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || '匹配失败');
    const grid = document.getElementById('ai-grid');
    grid.innerHTML = d.data.matches.map(m => `
      <button class="ai-cand relative aspect-square rounded-2xl overflow-hidden border-2 border-line hover:border-sakura-deep transition-all" data-file="${m.file_name}">
        <img src="${m.url}" class="w-full h-full object-cover" loading="lazy" />
        <div class="absolute inset-0 bg-black/0 hover:bg-black/30 transition-all flex items-center justify-center opacity-0 hover:opacity-100">
          <span class="text-white text-[13px] font-semibold bg-sakura-deep px-3 py-1 rounded-full">选这张</span>
        </div>
        <span class="absolute bottom-1.5 left-1.5 px-2 py-0.5 bg-white/90 rounded-full text-[10px] font-semibold text-sakura-deep">${m.vibe}</span>
      </button>
    `).join('');
    document.getElementById('ai-candidates').classList.remove('hidden');
    grid.querySelectorAll('.ai-cand').forEach(b => {
      b.addEventListener('click', () => selectPresetAvatar(cid, b.dataset.file));
    });
    showAvatarMsg(`从 ${d.data.pool_size} 张精选池里挑了 4 张最贴合她`, 'ok');
  } catch (e) {
    showAvatarMsg(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
    lucide.createIcons({ attrs: { 'stroke-width': 1.8, 'aria-hidden': 'true' } });
  }
});

async function selectPresetAvatar(cid, fileName) {
  showAvatarMsg('正在保存...', 'ok');
  try {
    const r = await fetch('/api/companions/' + cid + '/avatar/select-preset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: fileName }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || '保存失败');
    document.getElementById('c-avatar').src = d.data.avatar_url + '?t=' + Date.now();
    showAvatarMsg('头像已更新 ✓', 'ok');
    setTimeout(() => document.getElementById('avatar-modal').classList.add('hidden'), 800);
  } catch (e) {
    showAvatarMsg(e.message, 'error');
  }
}
document.getElementById('avatar-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showAvatarMsg('文件过大（>5MB）', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    _pendingAvatarBase64 = reader.result;
    document.getElementById('avatar-preview').src = reader.result;
    document.getElementById('btn-upload-avatar').classList.remove('hidden');
    showAvatarMsg('点确认上传以保存', 'ok');
  };
  reader.readAsDataURL(file);
});
document.getElementById('btn-upload-avatar').addEventListener('click', async () => {
  if (!_pendingAvatarBase64) return;
  const btn = document.getElementById('btn-upload-avatar');
  const cid = document.getElementById('avatar-modal').dataset.companionId;
  btn.disabled = true; btn.textContent = '上传中...';
  try {
    const r = await fetch('/api/companions/' + cid + '/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: _pendingAvatarBase64 }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || '上传失败');
    document.getElementById('c-avatar').src = d.data.avatar_url + '?t=' + Date.now();
    showAvatarMsg('头像已更新 ✓', 'ok');
    setTimeout(() => document.getElementById('avatar-modal').classList.add('hidden'), 800);
  } catch (e) {
    showAvatarMsg(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '确认上传';
  }
});
function showAvatarMsg(text, kind) {
  const el = document.getElementById('avatar-msg');
  el.textContent = text;
  el.className = 'mt-3 text-[12px] font-medium text-center px-3 py-2 rounded-xl ' +
    (kind === 'error' ? 'bg-red-50 text-red-500' : 'bg-emerald-50 text-emerald-600');
}
// 复制提示词
document.querySelectorAll('[data-copy]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const t = document.getElementById(btn.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(t);
      const orig = btn.textContent;
      btn.textContent = '已复制 ✓';
      setTimeout(() => btn.textContent = orig, 1200);
    } catch {
      alert('复制失败，请手动选中文本');
    }
  });
});

// ─── 我们的故事 ─────────────────────────────────────────────────
let _storyData = null;
async function loadTimeline(companionId, summary) {
  try {
    const r = await fetch('/api/companions/' + companionId + '/timeline');
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || '加载失败');
    _storyData = { ...d.data, summary };
    renderTimeline(_storyData);
    document.getElementById('story-section').classList.remove('hidden');
  } catch (e) {
    console.warn('timeline:', e.message);
  }
}

function renderTimeline(data) {
  const { companion, events } = data;
  document.getElementById('story-subtitle').innerHTML =
    `你和 <span class="font-semibold text-ink">${escapeHtml(companion.name)}</span> 已经认识 <span class="font-bold text-sakura-deep">${companion.days_together}</span> 天 · ${escapeHtml(companion.relationship_stage)} · 好感度 ${companion.affection_level}/100`;

  // 同步顶部"已认识 X 天"
  const dEl = document.getElementById('c-days');
  if (dEl) dEl.textContent = `· 认识 ${companion.days_together} 天`;

  const container = document.getElementById('story-timeline');
  if (!events || events.length === 0) {
    container.innerHTML = `
      <div class="text-center py-12">
        <div class="inline-block text-[40px] mb-3 opacity-50">✿</div>
        <p class="text-mute text-[14px] font-medium">故事刚刚开始</p>
        <p class="text-mute text-[12px] mt-1">多和她聊聊，这里会慢慢丰富起来</p>
      </div>
    `;
    return;
  }
  const rows = events.map(e => {
    const at = formatDateShort(e.at);
    const dotClass = e.kind === 'stage' ? 'tl-dot stage' : 'tl-dot';
    return `
      <div class="tl-item">
        <div class="${dotClass}">${e.icon || '·'}</div>
        <div class="flex items-baseline gap-2 flex-wrap">
          <span class="text-[14px] font-semibold">${escapeHtml(e.title)}</span>
          <span class="text-[11px] text-mute font-medium">${at}</span>
        </div>
        <div class="text-[13px] text-mute mt-1 leading-relaxed">${escapeHtml(e.detail || '')}</div>
      </div>
    `;
  }).join('');
  container.innerHTML = rows;
}

// ─── v1.4.1: 今天她想你 + 想念度小条 ──────────────────────────────────────
async function loadDailyThought(companionId) {
  try {
    const r = await fetch('/api/companions/' + companionId + '/daily-thought', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return;
    const d = await r.json();
    if (!d?.ok) return;
    const { thought, missing } = d.data || {};

    // 想念度条
    const meterRow = document.getElementById('missing-meter-row');
    const meterBar = document.getElementById('missing-bar');
    const meterLabel = document.getElementById('missing-label');
    if (missing && typeof missing.level === 'number') {
      meterRow.style.display = '';
      const pct = Math.round((missing.level / 4) * 100);
      meterBar.style.width = pct + '%';
      meterLabel.textContent = missing.label || '—';
    }

    // 今天她想对你说的话
    const card = document.getElementById('daily-thought-card');
    const contentEl = document.getElementById('daily-thought-content');
    const emptyEl = document.getElementById('daily-thought-empty');
    const btnPlay = document.getElementById('btn-thought-play');
    card.style.display = '';
    if (thought && thought.content) {
      contentEl.style.display = '';
      emptyEl.style.display = 'none';
      contentEl.textContent = thought.content;
      // v1.4.2: TTS 没配就不显示 🔊
      btnPlay.style.display = CAPS.tts ? '' : 'none';
      if (CAPS.tts) btnPlay.onclick = () => playThoughtAsVoice(thought.content, btnPlay);
    } else {
      contentEl.style.display = 'none';
      emptyEl.style.display = '';
      btnPlay.style.display = 'none';
    }
  } catch (e) {
    // 静默：dashboard 加载失败不打扰用户
  }
}
let _thoughtAudio = null;
async function playThoughtAsVoice(text, btnEl) {
  if (!text) return;
  try {
    if (_thoughtAudio) { _thoughtAudio.pause(); _thoughtAudio = null; }
    if (btnEl) btnEl.style.opacity = '0.4';
    const r = await fetch('/api/companions/' + companionId + '/tts-preview', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 100) }),
    });
    if (!r.ok) { showToast('朗读失败'); return; }
    const blob = await r.blob();
    _thoughtAudio = new Audio(URL.createObjectURL(blob));
    _thoughtAudio.onended = _thoughtAudio.onerror = () => { if (btnEl) btnEl.style.opacity = ''; };
    await _thoughtAudio.play();
  } catch (e) {
    if (btnEl) btnEl.style.opacity = '';
  }
}

// ─── 情绪趋势 ─────────────────────────────────────────────────────────────
async function loadTrendSection(companionId) {
  try {
    const token = localStorage.getItem('jwt_token') || sessionStorage.getItem('jwt_token') || '';
    const emotionResp = await fetch(`/api/companions/${companionId}/emotion-trend?days=7`, { headers: { Authorization: `Bearer ${token}` } });
    const emotionData = emotionResp.ok ? (await emotionResp.json()).data : null;

    document.getElementById('trend-section').classList.remove('hidden');
    document.getElementById('link-debug-prompt').href = `/app/debug-prompt.html?id=${companionId}`;

    // Emotion chart
    if (emotionData && emotionData.points && emotionData.points.length > 0) {
      document.getElementById('emotion-empty').classList.add('hidden');
      renderEmotionChart(emotionData.points);
      const lastPoint = emotionData.points[emotionData.points.length - 1];
      document.getElementById('current-mood-pill').textContent = lastPoint.mood || '平静';
    } else {
      document.getElementById('emotion-canvas').style.display = 'none';
      document.getElementById('emotion-empty').classList.remove('hidden');
    }
  } catch (e) {
    console.warn('[TrendSection]', e.message);
  }
}

function renderEmotionChart(points) {
  window.__lastEmotionPoints = points;
  const canvas = document.getElementById('emotion-canvas');
  if (!canvas) return;
  const W = canvas.offsetWidth || 400;
  canvas.width = W;
  const H = 140;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const DIMS = [
    { key: 'affection',  label: '好感',  color: '#FFB6D9' },
    { key: 'trust',      label: '信任',  color: '#74B9FF' },
    { key: 'security',   label: '安全感', color: '#55EFC4' },
    { key: 'energy',     label: '精力',  color: '#FDCB6E' },
  ];

  const pad = { l: 8, r: 8, t: 12, b: 8 };
  const chartW = W - pad.l - pad.r;
  const chartH = H - pad.t - pad.b;
  const n = points.length;
  if (n < 2) return;

  DIMS.forEach(({ key, color }) => {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    points.forEach((p, i) => {
      const x = pad.l + (i / (n - 1)) * chartW;
      const val = Math.min(100, Math.max(0, p[key] ?? 50));
      const y = pad.t + chartH - (val / 100) * chartH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  // Render legend
  const legend = document.getElementById('emotion-legend');
  legend.innerHTML = DIMS.map(d =>
    `<span class="flex items-center gap-1 text-[11px] text-mute">
       <span style="width:12px;height:3px;background:${d.color};display:inline-block;border-radius:99px"></span>
       ${d.label}
     </span>`
  ).join('');
}


function formatDateShort(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return '今天 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return diffDays + ' 天前';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ─── CP 卡片生成 ─────────────────────────────────────────────────
document.getElementById('btn-make-card').addEventListener('click', () => {
  if (!_storyData) return;
  drawCpCard(_storyData);
  document.getElementById('card-modal').classList.remove('hidden');
});
document.getElementById('card-close').addEventListener('click', () => {
  document.getElementById('card-modal').classList.add('hidden');
});
document.getElementById('card-modal').addEventListener('click', (e) => {
  if (e.target.id === 'card-modal') document.getElementById('card-modal').classList.add('hidden');
});
document.getElementById('btn-download-card').addEventListener('click', () => {
  const canvas = document.getElementById('cp-canvas');
  const a = document.createElement('a');
  a.download = `xiyu-cp-${Date.now()}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
});
document.getElementById('btn-share-card').addEventListener('click', async () => {
  const canvas = document.getElementById('cp-canvas');
  canvas.toBlob(async blob => {
    if (!blob) return;
    const file = new File([blob], 'xiyu-cp.png', { type: 'image/png' });
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: '溪语 AI · 我们的关系' });
      } catch {}
    } else {
      // fallback: 触发下载
      document.getElementById('btn-download-card').click();
    }
  });
});

function drawCpCard(data) {
  const { companion, summary } = data;
  const canvas = document.getElementById('cp-canvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // 背景：樱花渐变
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#FFF5FA');
  bg.addColorStop(0.5, '#FFE8F2');
  bg.addColorStop(1, '#FFD3E5');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 半透明花瓣装饰
  ctx.fillStyle = 'rgba(255, 182, 217, 0.25)';
  for (let i = 0; i < 18; i++) {
    const x = Math.random() * W, y = Math.random() * H, r = 20 + Math.random() * 40;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 标题
  ctx.fillStyle = '#1D1D1F';
  ctx.font = 'bold 56px -apple-system, "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('溪语 · 我们的故事', W / 2, 140);

  // 主标 "你 ❤ 她名字"
  ctx.font = 'bold 80px -apple-system, "PingFang SC", sans-serif';
  ctx.fillStyle = '#FF8FB8';
  const username = (summary && summary.name) || 'TA';
  // 这里 summary 实际是 companion summary，没有 username。改用 localStorage 拿
  const me = JSON.parse(localStorage.getItem('xiyu_user') || '{}').username || '你';
  ctx.fillText(`${me}  ❤  ${companion.name}`, W / 2, 350);

  // 关系阶段大字
  ctx.font = 'bold 96px -apple-system, "PingFang SC", sans-serif';
  ctx.fillStyle = '#1D1D1F';
  ctx.fillText(companion.relationship_stage, W / 2, 530);

  // 相识天数
  ctx.font = '36px -apple-system, "PingFang SC", sans-serif';
  ctx.fillStyle = '#86868B';
  ctx.fillText(`相识第 ${companion.days_together} 天`, W / 2, 610);

  // 好感度进度条
  const barX = 120, barY = 720, barW = W - 240, barH = 32;
  ctx.fillStyle = '#F0F0F2';
  roundRect(ctx, barX, barY, barW, barH, 16);
  ctx.fill();
  const fillW = barW * (companion.affection_level / 100);
  const fillGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  fillGrad.addColorStop(0, '#FFB6D9');
  fillGrad.addColorStop(1, '#FF8FB8');
  ctx.fillStyle = fillGrad;
  roundRect(ctx, barX, barY, fillW, barH, 16);
  ctx.fill();
  ctx.fillStyle = '#1D1D1F';
  ctx.font = '28px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(`好感度 ${companion.affection_level} / 100`, W / 2, barY + barH + 50);

  // 心心
  ctx.font = '80px sans-serif';
  ctx.fillText('💕', W / 2, 920);

  // 底部
  ctx.font = 'bold 32px -apple-system, "PingFang SC", sans-serif';
  ctx.fillStyle = '#FF8FB8';
  ctx.fillText(location.host, W / 2, 1080);
  ctx.font = '22px -apple-system, "PingFang SC", sans-serif';
  ctx.fillStyle = '#86868B';
  ctx.fillText('溪语 AI · 你的微信 AI 女友', W / 2, 1130);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ─── P2A: 关系里程碑 & 角色备份 ───────────────────────────────────────────
async function loadP2Section(companionId) {
  const token = localStorage.getItem('jwt_token') || sessionStorage.getItem('jwt_token') || '';
  try {
    const r = await fetch(`/api/companions/${companionId}/achievements`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return;
    const payload = await r.json();
    const achievements = payload.data?.achievements || [];
    document.getElementById('p2-section').classList.remove('hidden');
    const listEl = document.getElementById('achievements-list');
    if (!achievements.length) {
      listEl.innerHTML = '<p class="text-[12px] text-mute text-center py-4">还没有里程碑，继续聊天吧</p>';
    } else {
      const recent = achievements.slice(0, 5);
      listEl.innerHTML = recent.map(a => `
        <div class="flex items-start gap-2.5 py-2 border-b border-line/50 last:border-0">
          <span class="text-base">🏅</span>
          <div class="flex-1 min-w-0">
            <p class="text-[13px] font-semibold leading-snug truncate">${escapeHtml(a.title)}</p>
            <p class="text-[11px] text-mute">${escapeHtml(a.description || '')} · ${(a.unlocked_at || '').slice(0, 10)}</p>
          </div>
        </div>`).join('');
    }
  } catch (e) {
    console.warn('[P2 Achievements]', e.message);
  }

  // Wire export button
  const exportBtn = document.getElementById('btn-export-persona');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      try {
        exportBtn.disabled = true;
        exportBtn.textContent = '导出中...';
        const includeMemories = document.getElementById('transfer-include-memories')?.checked;
        const r = await fetch(`/api/companions/${companionId}/export${includeMemories ? '?include_memories=1' : ''}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) throw new Error('导出失败');
        const json = await r.json();
        const name = (json.data?.companion?.name || '角色').replace(/[/\\:*?"<>|]/g, '_');
        const blob = new Blob([JSON.stringify(json.data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${name}_export.json`; a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        alert(e.message);
      } finally {
        exportBtn.disabled = false;
        exportBtn.innerHTML = '<i data-lucide="download" class="inline w-4 h-4 align-[-3px]"></i> 导出角色 JSON';
        if (window.lucide) lucide.createIcons();
      }
    });
  }

  // Wire import input
  const importInput = document.getElementById('input-import-persona');
  const importStatus = document.getElementById('import-status');
  if (importInput) {
    importInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      importStatus.classList.remove('hidden');
      importStatus.textContent = '解析中...';
      try {
        if (file.size > 32 * 1024 * 1024) throw new Error('网页导入最大支持 32 MiB；更大的备份请使用本地迁移工具');
        const text = await file.text();
        JSON.parse(text);
        const includeMemories = document.getElementById('transfer-include-memories')?.checked;
        const r = await fetch('/api/companions/import' + (includeMemories ? '?include_memories=1' : ''), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: text,
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || '导入失败');
        importStatus.textContent = `✓ 导入成功，角色 ID: ${d.data.companion_id}`;
        if (includeMemories) importStatus.textContent += `；${d.data.quarantined_memories || 0} 条记忆及导入历史已保留待审阅，暂不用于聊天`;
        showToast('导入成功！');
      } catch (e2) {
        importStatus.textContent = '✗ ' + e2.message;
      }
      importInput.value = '';
    });
  }
}

function showToast(text) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 2000);
}

document.getElementById('btn-open-wechat').addEventListener('click', (e) => {
  e.preventDefault();
  const fallback = document.getElementById('wechat-fallback');
  fallback.classList.add('hidden');
  location.href = 'weixin://';
  setTimeout(() => {
    if (!document.hidden) fallback.classList.remove('hidden');
  }, 1200);
});
document.getElementById('btn-delete-companion').addEventListener('click', deleteCurrentCompanion);

// v1.4.2: 一键拨回暗恋初心
document.getElementById('btn-reset-crush').addEventListener('click', async () => {
  if (!confirm('把好感度/关系/情绪拨回「她暗恋你」的默认起步状态？\n（聊天记录、记忆、日记都保留，只是关系档位回到暧昧 35/100）')) return;
  try {
    const r = await fetch('/api/companions/' + companionId + '/reset-to-crush', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || '重置失败');
    showToast('✓ 已重置为暗恋初心');
    setTimeout(() => location.reload(), 800);
  } catch (e) { alert('重置失败：' + e.message); }
});

// v1.10.0 作息与睡眠
async function loadSleep() {
  const pill = document.getElementById('sleep-status-pill');
  try {
    if (!companionId) {
      if (pill) { pill.textContent = '未绑定'; pill.className = 'text-[11px] font-bold px-2 py-1 rounded-full bg-gray-100 text-gray-500'; }
      return;
    }
    const r = await fetch('/api/companions/' + companionId + '/sleep', { headers: { Authorization: 'Bearer ' + token } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      // v1.10.27: 即使 API 失败也保留 card 可见 + 给错误 pill 而不是隐藏整个卡片
      if (pill) {
        pill.textContent = '加载失败 (' + r.status + ')';
        pill.className = 'text-[11px] font-bold px-2 py-1 rounded-full bg-red-50 text-red-600';
      }
      return;
    }
    const s = d.data;
    const card = document.getElementById('sleep-card');
    if (card) card.style.display = 'block';
    if (window._sleepDial) window._sleepDial.set(s.bed_time, s.wake_time);
    document.getElementById('sleep-enabled').checked = !!s.enabled;
    const pill = document.getElementById('sleep-status-pill');
    if (!s.enabled) {
      pill.textContent = '已关闭';
      pill.className = 'text-[11px] font-bold px-2 py-1 rounded-full bg-gray-100 text-gray-500';
    } else if (s.is_sleeping) {
      pill.textContent = '💤 睡眠中';
      pill.className = 'text-[11px] font-bold px-2 py-1 rounded-full bg-indigo-50 text-indigo-600';
    } else {
      pill.textContent = '清醒';
      pill.className = 'text-[11px] font-bold px-2 py-1 rounded-full bg-emerald-50 text-emerald-600';
    }
    document.getElementById('btn-sleep-call').disabled = !s.is_sleeping;
    const note = document.getElementById('sleep-learn-note');
    if (s.learn_state === 'observing') {
      note.textContent = `学习期：已采样 ${s.learn_samples}/7 天，满 7 天后会自动按你的实际作息调整。`;
    } else if (s.user_set) {
      note.textContent = '已使用你手动设置的作息。';
    } else {
      note.textContent = `已根据你最近 7 天作息固化（${s.bed_time} 入睡 / ${s.wake_time} 起床）。`;
    }
  } catch (e) { console.warn('loadSleep failed', e); }
}
// v1.10.8: iOS 风格圆形作息拨盘
(function initSleepDial(){
  const SVG = document.getElementById('sleep-dial');
  if (!SVG) return;
  const CX = 120, CY = 120, R = 92;
  let bedMin = 30, wakeMin = 450;
  const arc = document.getElementById('dial-arc');
  const hBed = document.getElementById('dial-bed');
  const hWake = document.getElementById('dial-wake');
  const durEl = document.getElementById('dial-duration');
  const bedTimeEl = document.getElementById('dial-bed-time');
  const wakeTimeEl = document.getElementById('dial-wake-time');
  const bedInput = document.getElementById('sleep-bed');
  const wakeInput = document.getElementById('sleep-wake');
  const pad = n => String(n).padStart(2, '0');
  const fmt = min => pad(Math.floor(min / 60) % 24) + ':' + pad(min % 60);
  const hhmmToMin = s => { const [h, m] = String(s || '0:0').split(':').map(n => parseInt(n, 10) || 0); return (h * 60 + m) % 1440; };
  const pos = (min, r = R) => { const a = (min / 1440) * 2 * Math.PI; return { x: CX + r * Math.sin(a), y: CY - r * Math.cos(a) }; };
  function render() {
    const b = pos(bedMin), w = pos(wakeMin);
    hBed.setAttribute('transform', 'translate(' + b.x + ',' + b.y + ')');
    hWake.setAttribute('transform', 'translate(' + w.x + ',' + w.y + ')');
    const dur = (wakeMin - bedMin + 1440) % 1440;
    const large = dur > 720 ? 1 : 0;
    arc.setAttribute('d', 'M ' + b.x + ' ' + b.y + ' A ' + R + ' ' + R + ' 0 ' + large + ' 1 ' + w.x + ' ' + w.y);
    const dh = Math.floor(dur / 60), dm = dur % 60;
    durEl.textContent = dh + '小时' + (dm ? ' ' + dm + '分' : '');
    bedTimeEl.textContent = fmt(bedMin);
    wakeTimeEl.textContent = fmt(wakeMin);
    bedInput.value = fmt(bedMin);
    wakeInput.value = fmt(wakeMin);
  }
  function evtToMin(e) {
    const rect = SVG.getBoundingClientRect();
    const sx = 240 / rect.width, sy = 240 / rect.height;
    const px = (e.clientX - rect.left) * sx - CX, py = (e.clientY - rect.top) * sy - CY;
    let a = Math.atan2(px, -py); if (a < 0) a += 2 * Math.PI;
    return (Math.round((a / (2 * Math.PI)) * 1440 / 5) * 5) % 1440;
  }
  let dragging = null;
  const startDrag = which => e => { e.preventDefault(); dragging = which; try { SVG.setPointerCapture(e.pointerId); } catch (_) {} };
  hBed.addEventListener('pointerdown', startDrag('bed'));
  hWake.addEventListener('pointerdown', startDrag('wake'));
  SVG.addEventListener('pointermove', e => { if (!dragging) return; const m = evtToMin(e); if (dragging === 'bed') bedMin = m; else wakeMin = m; render(); });
  function endDrag() { if (dragging) { dragging = null; if (window._onSleepDialChange) window._onSleepDialChange(); } }
  SVG.addEventListener('pointerup', endDrag);
  SVG.addEventListener('pointercancel', endDrag);
  window._sleepDial = { set: (b, w) => { bedMin = hhmmToMin(b); wakeMin = hhmmToMin(w); render(); } };
  render();
})();
async function saveSleep(silent) {
  const body = {
    enabled: document.getElementById('sleep-enabled').checked,
    bed_time: document.getElementById('sleep-bed').value,
    wake_time: document.getElementById('sleep-wake').value,
  };
  try {
    const r = await fetch('/api/companions/' + companionId + '/sleep', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || '保存失败');
    if (!silent) showToast('✓ 作息已保存');
    loadSleep();
  } catch (e) { alert('保存失败：' + e.message); }
}
// 拖动松手自动保存；保存按钮显式保存；启用开关切换即存
window._onSleepDialChange = () => saveSleep(true);
document.getElementById('btn-sleep-save').addEventListener('click', () => saveSleep(false));
document.getElementById('sleep-enabled').addEventListener('change', () => saveSleep(true));
document.getElementById('btn-sleep-call').addEventListener('click', async () => {
  if (!confirm('确认打电话叫醒她？她会有起床气，annoyance 增加。')) return;
  try {
    const r = await fetch('/api/companions/' + companionId + '/sleep/wake', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || '叫醒失败');
    showToast('📞 已叫醒她（今天第 ' + d.data.woken_today + ' 次）');
    loadSleep();
  } catch (e) { alert('叫醒失败：' + e.message); }
});
document.getElementById('btn-sleep-reset-learn').addEventListener('click', async () => {
  if (!confirm('重置学习期：作息回到 23:00 / 07:30 默认，清空已观察的样本，重新跟随你的作息学习 7 天？')) return;
  try {
    const r = await fetch('/api/companions/' + companionId + '/sleep/reset-learn', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || '重置失败');
    showToast('✓ 已重置学习期');
    loadSleep();
  } catch (e) { alert('重置失败：' + e.message); }
});

// v1.10.43/46: 重生形象 — 4 候选选 1 锁定
let regenCandidates = [];
let regenTimer = null;
function startRegenProgress(etaSec) {
  const eta = etaSec || 90;
  const startT = Date.now();
  document.getElementById('regen-eta').textContent = String(eta);
  if (regenTimer) clearInterval(regenTimer);
  regenTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startT) / 1000);
    const pct = Math.min(95, Math.round(elapsed / eta * 100));
    const elEl = document.getElementById('regen-elapsed');
    const prEl = document.getElementById('regen-progress');
    if (elEl) elEl.textContent = String(elapsed);
    if (prEl) prEl.style.width = pct + '%';
    if (elapsed >= eta + 60) { clearInterval(regenTimer); regenTimer = null; }
  }, 500);
}
function stopRegenProgress(done) {
  if (regenTimer) { clearInterval(regenTimer); regenTimer = null; }
  const prEl = document.getElementById('regen-progress');
  if (prEl && done) prEl.style.width = '100%';
}
function openRegenModal() {
  const m = document.getElementById('regen-modal'); if (m) m.classList.remove('hidden');
  document.getElementById('regen-loading').classList.remove('hidden');
  document.getElementById('regen-grid').classList.add('hidden');
  document.getElementById('regen-msg').classList.add('hidden');
  document.getElementById('regen-refresh').classList.add('hidden');
  document.getElementById('regen-progress').style.width = '0%';
  regenCandidates = [];
  startRegenProgress(90);
  fetchRegenCandidates();
}
function closeRegenModal() {
  const m = document.getElementById('regen-modal'); if (m) m.classList.add('hidden');
  stopRegenProgress(false);
}
async function fetchRegenCandidates() {
  try {
    // v1.10.47: 显式 180s timeout — iOS Safari 默认 60s 会在后端 115s 时砍连接
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 180_000);
    let r;
    try {
      r = await fetch('/api/companions/' + companionId + '/visual-identity/generate-candidates', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        signal: ac.signal,
      });
    } finally { clearTimeout(to); }
    // v1.10.47: 改用 text() → 手动 parse，错误时把 status + 前 120 字 raw 给用户看
    const raw = await r.text();
    let d;
    try { d = JSON.parse(raw); }
    catch { throw new Error('HTTP ' + r.status + ' · 响应非 JSON: ' + raw.slice(0, 120)); }
    if (!r.ok || !d.ok) throw new Error(d.message || ('HTTP ' + r.status));
    regenCandidates = (d.data && d.data.candidates) || [];
    stopRegenProgress(true);
    if (!regenCandidates.length) throw new Error('候选图全部生成失败');
    renderRegenGrid();
  } catch (e) {
    stopRegenProgress(false);
    document.getElementById('regen-loading').classList.add('hidden');
    const msg = document.getElementById('regen-msg');
    msg.textContent = '生成失败：' + (e.message || '未知错误');
    msg.className = 'text-[12px] text-center px-3 py-2 rounded-xl bg-red-50 text-red-600';
    msg.classList.remove('hidden');
    document.getElementById('regen-refresh').classList.remove('hidden');
  }
}
function renderRegenGrid() {
  document.getElementById('regen-loading').classList.add('hidden');
  const grid = document.getElementById('regen-grid');
  grid.innerHTML = '';
  for (const c of regenCandidates) {
    const div = document.createElement('div');
    div.className = 'relative rounded-2xl overflow-hidden cursor-pointer border-2 border-line hover:border-sakura-deep transition-colors bg-cloud';
    // 占位 + 异步 fetch with Bearer token → blob URL → <img>
    div.innerHTML = '<div class="w-full aspect-square flex items-center justify-center text-[11px] text-mute">加载中…</div><div class="absolute inset-x-0 bottom-0 bg-black/50 text-white text-[11px] text-center py-1.5 font-medium">选这张</div>';
    div.addEventListener('click', () => lockRegen(c));
    grid.appendChild(div);
    // v1.10.49: 异步加载图片 — 把真实错误暴露出来方便诊断
    (async () => {
      const url = '/api/companions/' + companionId + '/visual-identity/candidate-image/' + encodeURIComponent(c.fname);
      try {
        const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
        if (!r.ok) {
          const txt = await r.text().catch(() => '');
          throw new Error('HTTP ' + r.status + ' ' + txt.slice(0, 60));
        }
        const blob = await r.blob();
        if (blob.size < 256) throw new Error('blob size ' + blob.size);
        const imgUrl = URL.createObjectURL(blob);
        div.querySelector('div:first-child').outerHTML = '<img src="' + imgUrl + '" class="w-full aspect-square object-cover"/>';
      } catch (e) {
        const placeholder = div.querySelector('div:first-child');
        if (placeholder) {
          placeholder.textContent = '加载失败: ' + (e.message || e.name || '未知').slice(0, 100);
          placeholder.style.padding = '8px';
          placeholder.style.fontSize = '10px';
          placeholder.style.lineHeight = '1.3';
          placeholder.style.wordBreak = 'break-all';
          placeholder.style.color = '#b91c1c';
        }
      }
    })();
  }
  grid.classList.remove('hidden');
  document.getElementById('regen-refresh').classList.remove('hidden');
}
async function lockRegen(candidate) {
  const msg = document.getElementById('regen-msg');
  msg.textContent = '锁定中…';
  msg.className = 'text-[12px] text-center px-3 py-2 rounded-xl bg-blue-50 text-blue-600';
  msg.classList.remove('hidden');
  try {
    const r = await fetch('/api/companions/' + companionId + '/visual-identity/lock', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fname: candidate.fname }),
    });
    const d = await r.json().catch(() => ({ ok: false, message: 'JSON 解析失败' }));
    if (!r.ok || !d.ok) throw new Error(d.message || ('HTTP ' + r.status));
    msg.textContent = '✓ 已锁定为基准形象。下次她发自拍就按这张走。';
    msg.className = 'text-[12px] text-center px-3 py-2 rounded-xl bg-emerald-50 text-emerald-700';
    setTimeout(closeRegenModal, 1800);
  } catch (e) {
    msg.textContent = '锁定失败：' + e.message;
    msg.className = 'text-[12px] text-center px-3 py-2 rounded-xl bg-red-50 text-red-600';
  }
}
document.getElementById('btn-regen-identity')?.addEventListener('click', openRegenModal);
document.getElementById('regen-close')?.addEventListener('click', closeRegenModal);
document.getElementById('regen-cancel')?.addEventListener('click', closeRegenModal);
document.getElementById('regen-refresh')?.addEventListener('click', openRegenModal);

// Keyboard accessibility: Escape closes open modals; Enter/Space activates silent-orb
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const regen = document.getElementById('regen-modal');
  if (regen && !regen.classList.contains('hidden')) { closeRegenModal(); return; }
  const av = document.getElementById('avatar-modal');
  if (av && !av.classList.contains('hidden')) { av.classList.add('hidden'); return; }
  const card = document.getElementById('card-modal');
  if (card && !card.classList.contains('hidden')) { card.classList.add('hidden'); return; }
  const pro = document.getElementById('proactive-off-modal');
  if (pro && !pro.classList.contains('hidden')) { document.getElementById('proactive-off-cancel')?.click(); }
});
document.getElementById('silent-orb')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); }
});

// ─── 控制台 5 分区原生 Tab + 手风琴折叠交互（全部原地切换，不割裂跳页） ──────
// ─── 数字衣橱 · 精品玻璃展示柜（Tab 3） ────────────────────────────────────────
(function initWardrobePanel() {
  const refInput = document.getElementById('input-upload-ref-portrait');
  const refStatus = document.getElementById('wardrobe-ref-status');
  const refDot = document.getElementById('wardrobe-ref-dot');
  const subEl = document.getElementById('acc-sub-wardrobe');
  const drawer = document.getElementById('wardrobe-add-drawer');
  const toggleAddBtn = document.getElementById('btn-wardrobe-toggle-add');
  const closeAddBtn = document.getElementById('btn-wardrobe-close-add');
  const fileInput = document.getElementById('wardrobe-file-input');
  const fileNameEl = document.getElementById('wardrobe-file-name');
  const nameInput = document.getElementById('wardrobe-item-name');
  const slotSelect = document.getElementById('wardrobe-item-slot');
  const statusSelect = document.getElementById('wardrobe-item-status');
  const noteInput = document.getElementById('wardrobe-item-note');
  const addBtn = document.getElementById('btn-wardrobe-add');
  const refreshBtn = document.getElementById('btn-wardrobe-refresh');
  const suqingPickBtn = document.getElementById('btn-wardrobe-suqing-pick');
  const togglePresetsBtn = document.getElementById('btn-wardrobe-toggle-presets');
  const closePresetsBtn = document.getElementById('btn-wardrobe-close-presets');
  const presetDrawer = document.getElementById('wardrobe-preset-drawer');
  const storageBadgeEl = document.getElementById('wardrobe-storage-badge');
  const toggleExtractBtn = document.getElementById('btn-wardrobe-toggle-extract');
  const extractBoxEl = document.getElementById('wardrobe-extract-box');
  const extractFileInput = document.getElementById('extract-file-input');
  const extractStatusMsg = document.getElementById('extract-status-msg');
  const extractPreviewWrap = document.getElementById('extract-preview-wrap');
  const extractSourceThumb = document.getElementById('extract-source-thumb');
  const extractItemsListEl = document.getElementById('extract-items-list');
  const extractAlsoWearEl = document.getElementById('extract-also-wear');
  const extractSaveBtn = document.getElementById('btn-extract-save');
  const soloPoseUploadInput = document.getElementById('input-upload-solo-pose');
  const presetFiltersEl = document.getElementById('wardrobe-preset-filters');
  const presetGridEl = document.getElementById('wardrobe-preset-grid');
  const poseBarEl = document.getElementById('wardrobe-pose-bar');
  const poseHintEl = document.getElementById('wardrobe-pose-hint');
  const msgEl = document.getElementById('wardrobe-status-msg');
  const ootdEl = document.getElementById('wardrobe-ootd-stage');
  const shelfBarEl = document.getElementById('wardrobe-shelf-bar');
  const listEl = document.getElementById('wardrobe-list');
  const lightboxEl = document.getElementById('wardrobe-lightbox');
  const lbImg = document.getElementById('wardrobe-lb-img');
  const lbTitle = document.getElementById('wardrobe-lb-title');
  const lbMeta = document.getElementById('wardrobe-lb-meta');
  const lbTabs = document.getElementById('wardrobe-lb-tabs');
  const lbClose = document.getElementById('wardrobe-lb-close');
  if (!listEl) return;

  let pendingImageDataUrl = '';
  let pendingExtractDataUrl = '';
  let detectedExtractItems = [];
  let cachedItems = [];
  let cachedStylistNote = null;
  let activeShelf = 'all';
  let selectedSoloPoseId = '';
  let activePresetSlot = 'all';
  let catalogCache = null;
  const blobUrlCache = new Map();
  const cellViewMode = new Map(); // itemId -> 'tryon' | 'source'

  // 共享姿势库与精选服装预设目录加载器（供衣橱与约会剧场复用；force=true 时强制拉最新）
  let catalogPromise = null;
  window.__loadPoseOutfitCatalog = function loadPoseOutfitCatalog(force = false) {
    if (force) {
      catalogCache = null;
      catalogPromise = null;
    }
    if (catalogCache) return Promise.resolve(catalogCache);
    if (!catalogPromise) {
      catalogPromise = fetch('/api/wardrobe/catalog', {
        headers: { Authorization: 'Bearer ' + token },
      })
        .then(r => r.json().catch(() => ({})))
        .then(d => {
          if (d && d.ok && d.data) {
            catalogCache = d.data;
            return catalogCache;
          }
          catalogPromise = null;
          return null;
        })
        .catch(() => {
          catalogPromise = null;
          return null;
        });
    }
    return catalogPromise;
  };

  const escHtml = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const STATUS_TEXT = {
    wearing: '✨ 在穿',
    in_transit: '📦 在途',
    owned: '💎 珍藏',
    tryon_only: '🪞 试穿',
    archived: '已收起',
  };
  const SLOT_TEXT = {
    outerwear: '外套',
    top: '上衣',
    bottom_or_dress: '裙装/下装',
    shoes: '鞋袜',
    bag: '包包',
    accessory: '配饰',
  };
  const SLOT_EMOJI = {
    outerwear: '🧥',
    top: '👚',
    bottom_or_dress: '👗',
    shoes: '👟',
    bag: '👜',
    accessory: '🎀',
  };
  const SHELVES = [
    { key: 'all', label: '全部藏品', match: () => true },
    { key: 'wearing', label: '✨ 今日在穿', match: it => it.status === 'wearing' },
    { key: 'tops', label: '🧥 上衣外套', match: it => it.slot === 'top' || it.slot === 'outerwear' },
    { key: 'dress', label: '👗 裙装下装', match: it => it.slot === 'bottom_or_dress' },
    { key: 'shoes', label: '👟 鞋袜', match: it => it.slot === 'shoes' },
    { key: 'bag', label: '👜 包包', match: it => it.slot === 'bag' },
    { key: 'accessory', label: '🎀 配饰', match: it => it.slot === 'accessory' },
    { key: 'transit', label: '📦 快递在途', match: it => it.status === 'in_transit' },
  ];

  function fileToCompressedDataUrl(file, maxEdge = 1280) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => resolve(String(reader.result || ''));
        img.onload = () => {
          const scale = Math.min(1, maxEdge / Math.max(img.width || 1, img.height || 1));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.88));
        };
        img.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    });
  }

  async function fetchAuthedBlobUrl(url) {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (blobUrlCache.has(url)) return blobUrlCache.get(url);
    try {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return '';
      const ct = String(r.headers.get('content-type') || '').toLowerCase();
      if (ct && !ct.startsWith('image/') && !ct.includes('octet-stream')) return '';
      const blob = await r.blob();
      if (blob.size < 64) return '';
      const objUrl = URL.createObjectURL(blob);
      blobUrlCache.set(url, objUrl);
      return objUrl;
    } catch {
      return '';
    }
  }

  function itemImageUrl(it, kind, { forceProxy = false } = {}) {
    if (kind === 'tryon' && (it.tryon_public_url || it.tryon_image_path)) {
      if (!forceProxy && it.tryon_public_url && /^https?:\/\//i.test(it.tryon_public_url)) {
        return it.tryon_public_url;
      }
      if (it.tryon_image_path) {
        return '/api/companions/' + companionId + '/wardrobe/' + it.id + '/image?kind=tryon&t=' + encodeURIComponent(it.updated_at || '');
      }
    }
    if (kind === 'source' && (it.source_public_url || it.source_image_path)) {
      if (!forceProxy && it.source_public_url && /^https?:\/\//i.test(it.source_public_url)) {
        return it.source_public_url;
      }
      if (it.source_image_path) {
        return '/api/companions/' + companionId + '/wardrobe/' + it.id + '/image?kind=source';
      }
    }
    return '';
  }

  async function openLightbox(it, initialKind) {
    if (!lightboxEl || !lbImg) return;
    const hasTryon = !!it.tryon_image_path;
    const hasSource = !!it.source_image_path;
    let activeKind = initialKind || (hasTryon ? 'tryon' : 'source');
    if (activeKind === 'tryon' && !hasTryon) activeKind = 'source';
    if (activeKind === 'source' && !hasSource) activeKind = 'tryon';

    lbTitle.textContent = it.name;
    lbMeta.textContent = [
      SLOT_TEXT[it.slot] || it.category,
      it.color,
      '穿戴 ' + Number(it.wear_count || 0) + ' 次',
      it.gifted_note ? '· ' + it.gifted_note : '',
    ].filter(Boolean).join(' · ');

    async function showKind(kind) {
      const url = itemImageUrl(it, kind);
      const blobUrl = await fetchAuthedBlobUrl(url);
      if (blobUrl) lbImg.src = blobUrl;
      Array.from(lbTabs.querySelectorAll('button')).forEach(b => {
        const on = b.dataset.kind === kind;
        b.className = on
          ? 'text-[11px] font-semibold px-3 py-1 rounded-full bg-sakura-deep text-white'
          : 'text-[11px] font-semibold px-3 py-1 rounded-full bg-white/10 text-white/80 hover:bg-white/20';
      });
    }

    lbTabs.innerHTML = '';
    if (hasTryon) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.kind = 'tryon';
      btn.textContent = '✨ 试穿照';
      btn.addEventListener('click', () => showKind('tryon'));
      lbTabs.appendChild(btn);
    }
    if (hasSource) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.kind = 'source';
      btn.textContent = '🛍️ 原图';
      btn.addEventListener('click', () => showKind('source'));
      lbTabs.appendChild(btn);
    }

    lightboxEl.classList.remove('hidden');
    await showKind(activeKind);
  }

  lbClose?.addEventListener('click', () => lightboxEl?.classList.add('hidden'));
  lightboxEl?.addEventListener('click', (e) => { if (e.target === lightboxEl) lightboxEl.classList.add('hidden'); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightboxEl && !lightboxEl.classList.contains('hidden')) {
      lightboxEl.classList.add('hidden');
    }
  });

  async function loadRefStatus() {
    if (!companionId || !refStatus) return;
    try {
      const r = await fetch('/api/companions/' + companionId + '/visual-identity/status', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const d = await r.json();
      if (r.ok && d.ok && d.data) {
        refDot?.classList.toggle('is-locked', !!d.data.locked);
        refStatus.textContent = d.data.locked
          ? '已锁脸（' + d.data.reference_count + ' 张定妆照）'
          : '未上传人物定妆参考图';
      }
    } catch { /* ignore */ }
  }

  function renderOotdStage(items) {
    if (!ootdEl) return;
    const wearing = items.filter(it => it.status === 'wearing');
    if (!wearing.length) {
      ootdEl.classList.add('hidden');
      ootdEl.innerHTML = '';
      return;
    }
    const hero = wearing.find(it => it.tryon_image_path) || wearing.find(it => it.source_image_path) || wearing[0];
    const heroKind = hero.tryon_image_path ? 'tryon' : 'source';
    ootdEl.classList.remove('hidden');
    ootdEl.innerHTML =
      '<div class="wardrobe-ootd-thumb" data-role="ootd-thumb">' +
        '<img data-role="ootd-img" class="hidden" alt="今日上身" />' +
      '</div>' +
      '<div class="min-w-0 flex-1 space-y-1.5">' +
        '<div class="flex items-center justify-between gap-2 flex-wrap">' +
          '<div class="flex items-center gap-1.5">' +
            '<span class="text-[11px] font-bold text-sakura-deep">✨ 今日上身展示台</span>' +
            '<span class="text-[10.5px] text-mute">共 ' + wearing.length + ' 件（不同部位可自由叠穿）</span>' +
          '</div>' +
          '<button type="button" data-act="outfit-tryon" class="text-[11px] font-semibold text-white bg-gradient-to-r from-sakura to-sakura-deep rounded-full px-3 py-1 hover:shadow-sakura transition-all">' +
            (wearing.length > 1 ? '✨ 拍整套叠穿大片' : '📸 拍今日穿搭照') +
          '</button>' +
        '</div>' +
        '<div class="flex flex-wrap gap-1.5">' +
          wearing.map(it =>
            '<span class="text-[11px] font-medium px-2 py-0.5 rounded-full bg-white/85 border border-sakura/35 text-ink">' +
              escHtml((SLOT_EMOJI[it.slot] || '👗') + ' ' + (SLOT_TEXT[it.slot] || it.category) + ' · ' + it.name) +
            '</span>'
          ).join('') +
        '</div>' +
        (cachedStylistNote?.note
          ? '<div class="text-[11px] text-ink/85 bg-white/65 dark:bg-white/10 rounded-xl px-2.5 py-1.5 border border-sakura/25 leading-snug">' +
              '<span class="font-bold text-sakura-deep">👑 主理人搭配笔记：</span>' +
              escHtml(cachedStylistNote.note) +
              (cachedStylistNote.poseLabel ? ' <span class="text-[10px] text-mute">（自选姿势：' + escHtml(cachedStylistNote.poseLabel) + '）</span>' : '') +
            '</div>'
          : '') +
      '</div>';
    const imgEl = ootdEl.querySelector('img[data-role="ootd-img"]');
    const thumbBox = ootdEl.querySelector('[data-role="ootd-thumb"]');
    const heroUrl = itemImageUrl(hero, heroKind);
    if (imgEl && heroUrl) {
      fetchAuthedBlobUrl(heroUrl).then(blobUrl => {
        if (blobUrl) { imgEl.src = blobUrl; imgEl.classList.remove('hidden'); }
      });
      thumbBox?.addEventListener('click', () => openLightbox(hero, heroKind));
    }
    ootdEl.querySelector('[data-act="outfit-tryon"]')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = '合拍中…';
      const activePose = (catalogCache?.soloPoses || []).find(p => p.id === selectedSoloPoseId);
      const poseTip = activePose ? ' · 姿势「' + activePose.label + '」' : '';
      msgEl.textContent = '正在锁定人物定妆照并合成「' + wearing.map(i => i.name).join(' + ') + '」叠穿大片' + poseTip + '（约 30-90 秒）…';
      try {
        const resp = await fetch('/api/companions/' + companionId + '/wardrobe/outfit-tryon', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            item_ids: wearing.map(i => i.id),
            pose_id: selectedSoloPoseId || undefined,
          }),
        });
        const out = await resp.json().catch(() => ({}));
        if (!resp.ok || !out.ok) throw new Error(out.error || out.message || ('HTTP ' + resp.status));
        cellViewMode.set(wearing[0].id, 'tryon');
        msgEl.textContent = '✓ 整套叠穿大片' + poseTip + '已生成并上架展柜！';
        await loadWardrobe();
      } catch (e) {
        msgEl.textContent = '叠穿合拍失败：' + e.message;
        btn.disabled = false;
        btn.textContent = wearing.length > 1 ? '✨ 拍整套叠穿大片' : '📸 拍今日穿搭照';
      }
    });
  }

  function buildPosePreviewCard(p, isActive, kind, onPick, onDelete) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pose-card' + (kind === 'couple' ? ' is-couple' : '') + (isActive ? ' is-active' : '');
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
    btn.title = p.descZh || p.tag || p.label;
    const previewHtml = p.previewUrl
      ? '<img data-role="pose-img" alt="' + escHtml(p.label) + '" loading="lazy" ' + (p.authRequired ? 'class="hidden"' : 'src="' + escHtml(p.previewUrl) + '"') + ' />'
      : (typeof window.renderPosePreviewSvg === 'function'
          ? window.renderPosePreviewSvg(p.id, kind)
          : '<span class="text-[24px]">' + escHtml(p.emoji || '✨') + '</span>');
    const badge = p.framingLabel || p.tag || '';
    btn.innerHTML =
      '<div class="pose-card-stage">' +
        '<span class="pose-card-check" aria-hidden="true">✓</span>' +
        (p.isCustom ? '<span class="custom-asset-del" data-del-pose="' + escHtml(p.id) + '" title="删除此自定义姿势">×</span>' : '') +
        (badge ? '<span class="pose-card-badge">' + escHtml(badge) + '</span>' : '') +
        previewHtml +
      '</div>' +
      '<div class="pose-card-meta">' +
        '<div class="pose-card-name">' + escHtml(p.label) + '</div>' +
        '<div class="pose-card-tag">' + escHtml(p.tag || '') + '</div>' +
      '</div>';
    if (p.previewUrl && p.authRequired) {
      const imgEl = btn.querySelector('img[data-role="pose-img"]');
      fetchAuthedBlobUrl(p.previewUrl).then(blobUrl => {
        if (blobUrl && imgEl) { imgEl.src = blobUrl; imgEl.classList.remove('hidden'); }
      });
    }
    btn.querySelector('[data-del-pose]')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (typeof onDelete === 'function') onDelete(p);
    });
    btn.addEventListener('click', onPick);
    return btn;
  }

  function renderSoloPoseBar() {
    if (!poseBarEl || !catalogCache?.soloPoses) return;
    const poses = catalogCache.soloPoses;
    const selected = poses.find(p => p.id === selectedSoloPoseId) || null;
    if (poseHintEl) {
      poseHintEl.textContent = selected
        ? '已选「' + selected.label + '」· ' + (selected.descZh || selected.tag)
        : '当前：随机自然（按心情与穿搭款式自动发挥）';
    }
    poseBarEl.innerHTML = '';
    const allOpts = [
      { id: '', emoji: '🎲', label: '随机自然', tag: '自动适配', framingLabel: '自动', descZh: '根据当前心情与服装风格自动发挥自然姿势' },
      ...poses,
    ];
    for (const p of allOpts) {
      poseBarEl.appendChild(buildPosePreviewCard(p, selectedSoloPoseId === p.id, 'solo', () => {
        selectedSoloPoseId = p.id;
        renderSoloPoseBar();
      }, async (target) => {
        try {
          const r = await fetch('/api/wardrobe/catalog/poses/' + encodeURIComponent(target.id), {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + token },
          });
          if (r.ok) {
            if (selectedSoloPoseId === target.id) selectedSoloPoseId = '';
            msgEl.textContent = '已删除自定义姿势「' + target.label + '」';
            await window.__loadPoseOutfitCatalog(true);
            renderSoloPoseBar();
          }
        } catch (e) {
          msgEl.textContent = '删除失败：' + e.message;
        }
      }));
    }
  }

  function findCabinetItemForPreset(preset) {
    if (!preset || !Array.isArray(cachedItems) || !cachedItems.length) return null;
    const pid = String(preset.id || '').trim();
    const pname = String(preset.name || '').trim();
    const pslot = String(preset.slot || '').trim();
    const pprompt = String(preset.visualPrompt || '').trim().slice(0, 500);
    return cachedItems.find(it => {
      if (!it || it.status === 'archived') return false;
      const itemPid = String(it.preset_id || '').trim();
      // 藏品已绑定 preset_id 时，严格只按 preset_id 精确匹配，绝不按名称模糊撞车
      if (itemPid) return Boolean(pid && itemPid === pid);
      // 迁移前的旧藏品（preset_id 为空）：必须 slot + name + visual_prompt 全一致
      return Boolean(
        pname && pslot && pprompt &&
        String(it.name || '').trim() === pname &&
        String(it.slot || '').trim() === pslot &&
        String(it.visual_prompt || '').trim().slice(0, 500) === pprompt
      );
    }) || null;
  }

  function renderPresetDrawer() {
    if (!presetGridEl || !presetFiltersEl || !catalogCache?.outfitPresets) return;
    if (storageBadgeEl) {
      const st = catalogCache.storage || {};
      storageBadgeEl.textContent = st.driver === 'r2'
        ? '☁️ Cloudflare R2 · ' + (st.bucket || '已连接')
        : '💾 本地存储（配置 R2 即可自动上云）';
    }
    const presets = catalogCache.outfitPresets;
    const filterTabs = [
      { key: 'all', label: '全部 (' + presets.length + ')' },
      { key: 'top', label: '👚 上衣' },
      { key: 'outerwear', label: '🧥 外套' },
      { key: 'bottom_or_dress', label: '👗 裙装/下装' },
      { key: 'shoes', label: '👟 鞋袜' },
      { key: 'bag', label: '👜 包包' },
      { key: 'accessory', label: '🎀 配饰' },
    ];
    presetFiltersEl.innerHTML = '';
    for (const tab of filterTabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-filter-btn' + (activePresetSlot === tab.key ? ' is-active' : '');
      btn.textContent = tab.label;
      btn.addEventListener('click', () => {
        activePresetSlot = tab.key;
        renderPresetDrawer();
      });
      presetFiltersEl.appendChild(btn);
    }

    const visible = activePresetSlot === 'all'
      ? presets
      : presets.filter(p => p.slot === activePresetSlot);

    presetGridEl.innerHTML = '';
    for (const p of visible) {
      const card = document.createElement('div');
      card.className = 'preset-card';
      const garmentVisual = p.previewUrl
        ? '<img data-role="preset-img" alt="' + escHtml(p.name) + '" loading="lazy" ' + (p.authRequired ? 'class="hidden"' : 'src="' + escHtml(p.previewUrl) + '"') + ' />'
        : (typeof window.renderOutfitPresetSvg === 'function'
            ? window.renderOutfitPresetSvg(p.id, p.slot)
            : '<span class="text-[30px]">' + escHtml(p.emoji || '👗') + '</span>');
      const slotBadgeText = (p.isCustom && p.extractedMode === 'flatlay' ? '✨平铺 · ' : '') + (SLOT_TEXT[p.slot] || p.category);
      const existingCabinetItem = findCabinetItemForPreset(p);
      const isInCabinet = Boolean(existingCabinetItem);
      const isWearingNow = existingCabinetItem?.status === 'wearing';
      card.innerHTML =
        '<div class="preset-stage">' +
          (p.isCustom ? '<button type="button" class="custom-asset-del" data-del-preset="' + escHtml(p.id) + '" title="删除此收藏预设">×</button>' : '') +
          '<span class="preset-stage-slot">' + escHtml(slotBadgeText) + '</span>' +
          '<span class="preset-swatch-dot" style="background:' + escHtml(p.swatch || '#FFF0F7') + '" title="' + escHtml(p.color || '') + '"></span>' +
          garmentVisual +
        '</div>' +
        '<div class="preset-body">' +
          '<div>' +
            '<div class="text-[11.5px] font-bold text-ink truncate" title="' + escHtml(p.name) + '">' + escHtml(p.name) + '</div>' +
            '<div class="text-[10px] text-mute truncate">' + escHtml((p.color || '') + (p.material ? ' · ' + p.material : '')) + '</div>' +
          '</div>' +
          (p.descZh ? '<p class="preset-desc" title="' + escHtml(p.descZh) + '">' + escHtml(p.descZh) + '</p>' : '') +
          '<div class="flex flex-wrap gap-1">' +
            (p.styleTags || []).slice(0, 3).map(t => '<span class="preset-tag">' + escHtml(t) + '</span>').join('') +
          '</div>' +
          '<div class="flex items-center gap-1.5 mt-auto pt-1">' +
            (isWearingNow
              ? '<button type="button" disabled class="wardrobe-mini-btn is-wearing-now" title="苏晴正在穿这件，换其他款式或脱下后可再次选择">✨ 穿着中</button>'
              : '<button type="button" data-preset-status="wearing" class="wardrobe-mini-btn is-primary">👗 立即穿上</button>') +
            (isInCabinet
              ? '<button type="button" disabled class="wardrobe-mini-btn is-done" title="已收入玻璃展柜，从展柜移除后可重新收入">✓ 已入展柜</button>'
              : '<button type="button" data-preset-status="owned" class="wardrobe-mini-btn is-ghost">💎 收入展柜</button>') +
          '</div>' +
        '</div>';

      if (p.previewUrl && p.authRequired) {
        const imgEl = card.querySelector('img[data-role="preset-img"]');
        fetchAuthedBlobUrl(p.previewUrl).then(blobUrl => {
          if (blobUrl && imgEl) { imgEl.src = blobUrl; imgEl.classList.remove('hidden'); }
        });
      }

      card.querySelector('[data-del-preset]')?.addEventListener('click', async () => {
        try {
          const r = await fetch('/api/wardrobe/catalog/presets/' + encodeURIComponent(p.id), {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + token },
          });
          if (r.ok) {
            msgEl.textContent = '已从服装灵感库移除「' + p.name + '」';
            await window.__loadPoseOutfitCatalog(true);
            renderPresetDrawer();
          }
        } catch (e) {
          msgEl.textContent = '移除失败：' + e.message;
        }
      });

      card.querySelectorAll('button[data-preset-status]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!companionId) return;
          const st = btn.dataset.presetStatus || 'wearing';
          btn.disabled = true;
          const prevText = btn.textContent;
          btn.textContent = st === 'wearing' ? '换装中…' : '入柜中…';
          msgEl.textContent = st === 'wearing'
            ? '正在为她换上「' + p.name + '」…'
            : '正在将精选灵感「' + p.name + '」收入展示柜…';
          try {
            const resp = await fetch('/api/companions/' + companionId + '/wardrobe/preset', {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                preset_id: p.id,
                status: st,
                replace_wearing: st === 'wearing' ? true : undefined,
              }),
            });
            const d = await resp.json().catch(() => ({}));
            if (!resp.ok || !d.ok) throw new Error(d.error || d.message || ('HTTP ' + resp.status));
            const createdItem = d.data?.item || null;
            activeShelf = 'all';
            await loadWardrobe();

            if (st === 'wearing' && createdItem?.id) {
              const activePose = (catalogCache?.soloPoses || []).find(x => x.id === selectedSoloPoseId);
              const poseTip = activePose ? ' · 姿势「' + activePose.label + '」' : '';
              btn.textContent = '拍试穿中…';
              msgEl.textContent = '✓ 旧穿搭已自动脱下并换上「' + p.name + '」，正在自动拍摄试穿大片' + poseTip + '（约 30-90 秒）…';
              try {
                const tryResp = await fetch('/api/companions/' + companionId + '/wardrobe/' + createdItem.id + '/tryon', {
                  method: 'POST',
                  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    compose_with_wearing: true,
                    pose_id: selectedSoloPoseId || undefined,
                  }),
                });
                const tryOut = await tryResp.json().catch(() => ({}));
                if (!tryResp.ok || !tryOut.ok) throw new Error(tryOut.error || tryOut.message || ('HTTP ' + tryResp.status));
                cellViewMode.set(createdItem.id, 'tryon');
                msgEl.textContent = '✓ 「' + p.name + '」试穿买家秀' + poseTip + '已生成并同步到左侧人物舞台！';
                await loadWardrobe();
              } catch (tryErr) {
                msgEl.textContent = '✓ 已换上「' + p.name + '」，但自动试穿生图失败：' + tryErr.message + '（可在展柜点「📸 试穿」重试）';
              }
            } else {
              msgEl.textContent = d.data?.already_in_cabinet
                ? '✓ 「' + p.name + '」已经在展柜珍藏里啦！'
                : '✓ 已将「' + p.name + '」收入展柜珍藏！';
            }
          } catch (e) {
            msgEl.textContent = '添加预设失败：' + e.message;
          } finally {
            if (btn.isConnected) {
              btn.disabled = false;
              btn.textContent = prevText;
            }
          }
        });
      });
      presetGridEl.appendChild(card);
    }
  }

  function renderShelfBar(items) {
    if (!shelfBarEl) return;
    shelfBarEl.innerHTML = '';
    for (const shelf of SHELVES) {
      const count = items.filter(shelf.match).length;
      if (shelf.key !== 'all' && count === 0) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wardrobe-shelf-tab' + (activeShelf === shelf.key ? ' active' : '');
      btn.textContent = shelf.label + ' ' + count;
      btn.addEventListener('click', () => {
        activeShelf = shelf.key;
        renderCabinet();
      });
      shelfBarEl.appendChild(btn);
    }
  }

  function renderCabinet() {
    const items = cachedItems;
    if (subEl) {
      const wearingCount = items.filter(it => it.status === 'wearing').length;
      subEl.textContent = items.length
        ? '已珍藏 ' + items.length + ' 件藏品 · 今日在穿 ' + wearingCount + ' 件'
        : '精品玻璃陈列柜 · 衣服/包包/鞋子收藏与试穿买家秀';
    }
    renderOotdStage(items);
    renderShelfBar(items);

    const shelfDef = SHELVES.find(s => s.key === activeShelf) || SHELVES[0];
    const visible = items.filter(shelfDef.match);
    listEl.innerHTML = '';

    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'wardrobe-empty-slot';
      empty.innerHTML = items.length
        ? '<p>这层展架暂时空着，换个分类看看或放一件新礼物进来～</p>'
        : '<div class="text-[24px] mb-1">🪞</div><p class="font-semibold text-ink mb-1">展示柜还是空的</p><p>点击右上角「＋ 放入新礼物」，把衣服、包包或鞋子摆进玻璃柜吧～</p>';
      listEl.appendChild(empty);
      return;
    }

    for (const it of visible) {
      const hasTryon = !!it.tryon_image_path;
      const hasSource = !!it.source_image_path;
      const defaultMode = hasTryon ? 'tryon' : 'source';
      const curMode = cellViewMode.get(it.id) || defaultMode;
      const otherMode = curMode === 'tryon' ? 'source' : 'tryon';
      const canSwap = hasTryon && hasSource;

      const cell = document.createElement('div');
      cell.className = 'wardrobe-cell' + (it.status === 'wearing' ? ' is-wearing' : '');
      const statusCls = it.status === 'wearing'
        ? 'is-wearing'
        : it.status === 'in_transit' ? 'is-transit' : 'is-owned';
      const modeTag = curMode === 'tryon' && hasTryon
        ? '试穿照'
        : hasSource ? '商品图' : '';

      const matchedPreset = (!hasTryon && !hasSource && catalogCache?.outfitPresets)
        ? catalogCache.outfitPresets.find(p => p.name === it.name)
        : null;
      const placeholderVisual = (!hasTryon && !hasSource && typeof window.renderOutfitPresetSvg === 'function')
        ? window.renderOutfitPresetSvg(matchedPreset?.id || '', it.slot)
        : '<span class="text-[28px]">' + (SLOT_EMOJI[it.slot] || '👗') + '</span>';
      const placeholderCaption = (hasTryon || hasSource)
        ? '展灯加载中…'
        : '点下方「📸 试穿」生成买家秀';

      cell.innerHTML =
        '<div class="wardrobe-stage">' +
          '<span class="wardrobe-status-pill ' + statusCls + '">' + escHtml(STATUS_TEXT[it.status] || it.status) + '</span>' +
          (modeTag ? '<span class="wardrobe-mode-tag">' + modeTag + '</span>' : '') +
          '<img data-role="main-img" class="wardrobe-stage-img hidden" alt="' + escHtml(it.name) + '" />' +
          '<div data-role="placeholder" class="wardrobe-stage-placeholder">' +
            placeholderVisual +
            '<span>' + placeholderCaption + '</span>' +
          '</div>' +
          (canSwap
            ? '<button type="button" data-act="swap" class="wardrobe-swap-pip" title="切换查看' + (otherMode === 'source' ? '原商品图' : '试穿照') + '">' +
                '<img data-role="pip-img" alt="切换对比" />' +
              '</button>'
            : '') +
        '</div>' +
        '<div class="wardrobe-plaque">' +
          '<div class="wardrobe-plaque-title" title="' + escHtml(it.name) + '">' + escHtml(it.name) + '</div>' +
          '<div class="wardrobe-plaque-meta flex items-center justify-between gap-1">' +
            '<select data-act="slot" title="调整部位（不同部位可自由叠穿）" class="bg-transparent text-[10.5px] text-mute hover:text-sakura-deep focus:outline-none cursor-pointer max-w-[92px]">' +
              Object.entries(SLOT_TEXT).map(([k, lbl]) =>
                '<option value="' + k + '"' + (it.slot === k ? ' selected' : '') + '>' + (SLOT_EMOJI[k] || '') + ' ' + lbl + '</option>'
              ).join('') +
            '</select>' +
            '<span class="shrink-0">穿 ' + Number(it.wear_count || 0) + ' 次</span>' +
          '</div>' +
          '<div class="wardrobe-plaque-actions">' +
            (it.status !== 'wearing'
              ? '<button type="button" data-act="wear" class="wardrobe-mini-btn is-primary">👗 穿上</button>'
              : '<button type="button" data-act="unwear" class="wardrobe-mini-btn is-primary" title="脱下此部位（不影响其他叠穿部位）">↩ 脱下</button>') +
            '<button type="button" data-act="tryon" class="wardrobe-mini-btn is-ghost" title="结合当前其他在穿部位进行局部换装/叠穿">' + (hasTryon ? '📸 重拍' : '📸 试穿') + '</button>' +
            '<button type="button" data-act="del" class="wardrobe-del-btn" title="移出展示柜">🗑</button>' +
          '</div>' +
        '</div>';

      const mainImg = cell.querySelector('img[data-role="main-img"]');
      const placeholder = cell.querySelector('[data-role="placeholder"]');
      const mainUrl = itemImageUrl(it, curMode);
      if (mainImg && mainUrl) {
        const bindDisplay = (srcUrl, allowFallback) => {
          mainImg.onload = () => {
            mainImg.classList.remove('hidden');
            placeholder?.classList.add('hidden');
          };
          mainImg.onerror = () => {
            if (allowFallback) {
              const proxyUrl = itemImageUrl(it, curMode, { forceProxy: true });
              if (proxyUrl && proxyUrl !== srcUrl) {
                fetchAuthedBlobUrl(proxyUrl).then(fb => { if (fb) bindDisplay(fb, false); });
                return;
              }
            }
            mainImg.classList.add('hidden');
            placeholder?.classList.remove('hidden');
          };
          mainImg.src = srcUrl;
        };
        fetchAuthedBlobUrl(mainUrl).then(resolvedUrl => {
          if (resolvedUrl) bindDisplay(resolvedUrl, /^https?:\/\//i.test(resolvedUrl));
        });
        mainImg.addEventListener('click', () => openLightbox(it, curMode));
      }

      if (canSwap) {
        const pipImg = cell.querySelector('img[data-role="pip-img"]');
        const pipUrl = itemImageUrl(it, otherMode);
        if (pipImg && pipUrl) {
          fetchAuthedBlobUrl(pipUrl).then(blobUrl => { if (blobUrl) pipImg.src = blobUrl; });
        }
        cell.querySelector('[data-act="swap"]')?.addEventListener('click', (ev) => {
          ev.stopPropagation();
          cellViewMode.set(it.id, otherMode);
          renderCabinet();
        });
      }

      cell.querySelector('[data-act="slot"]')?.addEventListener('change', async (ev) => {
        const newSlot = ev.currentTarget.value;
        msgEl.textContent = '已调整「' + it.name + '」部位为 ' + (SLOT_TEXT[newSlot] || newSlot) + '…';
        const resp = await fetch('/api/companions/' + companionId + '/wardrobe/' + it.id, {
          method: 'PATCH',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ slot: newSlot }),
        });
        if (resp.ok) { msgEl.textContent = '✓ 已调整部位（不同部位可自由叠穿）'; loadWardrobe(); }
      });

      cell.querySelector('[data-act="wear"]')?.addEventListener('click', async () => {
        msgEl.textContent = '正在换上「' + it.name + '」…';
        const resp = await fetch('/api/companions/' + companionId + '/wardrobe/' + it.id, {
          method: 'PATCH',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'wear' }),
        });
        if (resp.ok) { msgEl.textContent = '✓ 已换上「' + it.name + '」（其他部位自动保留叠穿）'; loadWardrobe(); }
      });

      cell.querySelector('[data-act="unwear"]')?.addEventListener('click', async () => {
        msgEl.textContent = '正在脱下「' + it.name + '」…';
        const resp = await fetch('/api/companions/' + companionId + '/wardrobe/' + it.id, {
          method: 'PATCH',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'unwear' }),
        });
        if (resp.ok) { msgEl.textContent = '✓ 已将「' + it.name + '」收回展柜珍藏'; loadWardrobe(); }
      });

      cell.querySelector('[data-act="tryon"]')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        btn.textContent = '拍摄中…';
        const activePose = (catalogCache?.soloPoses || []).find(p => p.id === selectedSoloPoseId);
        const poseTip = activePose ? ' · 姿势「' + activePose.label + '」' : '';
        msgEl.textContent = '正在结合人物定妆照与商品图拍摄「' + it.name + '」试穿照' + poseTip + '（约 30-90 秒）…';
        try {
          const resp = await fetch('/api/companions/' + companionId + '/wardrobe/' + it.id + '/tryon', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ pose_id: selectedSoloPoseId || undefined }),
          });
          const out = await resp.json().catch(() => ({}));
          if (!resp.ok || !out.ok) throw new Error(out.error || out.message || ('HTTP ' + resp.status));
          cellViewMode.set(it.id, 'tryon');
          msgEl.textContent = '✓ 「' + it.name + '」试穿买家秀' + poseTip + '已上架展柜！';
          await loadWardrobe();
        } catch (e) {
          msgEl.textContent = '试穿生图失败：' + e.message;
          btn.disabled = false;
          btn.textContent = hasTryon ? '📸 重拍' : '📸 试穿';
        }
      });

      cell.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
        const resp = await fetch('/api/companions/' + companionId + '/wardrobe/' + it.id, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + token },
        });
        if (resp.ok) { msgEl.textContent = '已移出展示柜'; loadWardrobe(); }
      });

      listEl.appendChild(cell);
    }
  }

  async function loadWardrobe() {
    if (!companionId) return;
    loadRefStatus();
    window.__loadPoseOutfitCatalog().then(cat => {
      if (cat) {
        renderSoloPoseBar();
        renderPresetDrawer();
        if (cachedItems.length) renderCabinet();
      }
    });
    if (!cachedItems.length) {
      listEl.innerHTML = '<div class="wardrobe-empty-slot">正在点亮展示柜…</div>';
    }
    try {
      const r = await fetch('/api/companions/' + companionId + '/wardrobe', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || d.message || '加载失败');
      cachedItems = (d.data && d.data.items) || [];
      cachedStylistNote = (d.data && d.data.stylist_note) || null;
      renderCabinet();
      if (catalogCache?.outfitPresets) renderPresetDrawer();
      if (typeof window.__refreshHeroStage === 'function') window.__refreshHeroStage();
    } catch (e) {
      listEl.innerHTML = '<div class="wardrobe-empty-slot text-red-600">加载展示柜失败：' + escHtml(e.message) + '</div>';
    }
  }

  toggleAddBtn?.addEventListener('click', () => {
    presetDrawer?.classList.add('hidden');
    drawer?.classList.toggle('hidden');
  });
  closeAddBtn?.addEventListener('click', () => drawer?.classList.add('hidden'));
  togglePresetsBtn?.addEventListener('click', () => {
    drawer?.classList.add('hidden');
    presetDrawer?.classList.toggle('hidden');
    if (presetDrawer && !presetDrawer.classList.contains('hidden')) {
      if (!catalogCache && presetGridEl) {
        presetGridEl.innerHTML = '<div class="col-span-full text-center text-[11px] text-mute py-6">正在加载精选服装灵感库…</div>';
      }
      window.__loadPoseOutfitCatalog().then(cat => {
        if (cat) renderPresetDrawer();
        else if (presetGridEl) {
          presetGridEl.innerHTML = '<div class="col-span-full text-center text-[11px] text-rose-500 py-6">加载服装灵感库失败，请确认已重启最新后端服务后重试</div>';
        }
      });
    }
  });
  closePresetsBtn?.addEventListener('click', () => presetDrawer?.classList.add('hidden'));
  toggleExtractBtn?.addEventListener('click', () => extractBoxEl?.classList.toggle('hidden'));

  // ── 👑 衣橱主理人自主搭配（由苏晴自己决定穿什么、摆什么姿势） ───────────────
  suqingPickBtn?.addEventListener('click', async () => {
    if (!companionId) return;
    suqingPickBtn.disabled = true;
    const prevTxt = suqingPickBtn.textContent;
    suqingPickBtn.textContent = '苏晴挑衣服中…';
    msgEl.textContent = '👑 苏晴正在翻看她的衣橱与灵感库，结合今天的心情、季节与安排自己选穿搭和姿势（含自动试穿约 30-90 秒）…';
    try {
      const r = await fetch('/api/companions/' + companionId + '/wardrobe/stylist-pick', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_tryon: true, allow_presets: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || d.message || ('HTTP ' + r.status));
      const pickedItems = d.data?.items || [];
      const pose = d.data?.pose || null;
      const note = d.data?.stylist_note?.note || '';
      if (pose?.id) {
        selectedSoloPoseId = pose.id;
        renderSoloPoseBar();
      }
      if (pickedItems[0]?.id && d.data?.tryon_image_url) {
        cellViewMode.set(pickedItems[0].id, 'tryon');
      }
      const names = pickedItems.map(i => i.name).join(' + ');
      msgEl.textContent = '👑 苏晴选好了「' + names + '」' + (pose?.label ? ' · 姿势「' + pose.label + '」' : '') + (note ? ' — “' + note + '”' : '') + (d.data?.tryon_error ? '（试穿生图失败：' + d.data.tryon_error + '）' : '');
      activeShelf = 'all';
      await loadWardrobe();
    } catch (e) {
      msgEl.textContent = '苏晴自主搭配失败：' + e.message;
    } finally {
      suqingPickBtn.disabled = false;
      suqingPickBtn.textContent = prevTxt;
    }
  });

  // ── 上传自定义单人姿势参考图 ────────────────────────────────────────────────
  soloPoseUploadInput?.addEventListener('change', async () => {
    const file = soloPoseUploadInput.files && soloPoseUploadInput.files[0];
    if (!file) return;
    msgEl.textContent = '正在解析姿势参考图并上传至存储库…';
    try {
      const dataUrl = await fileToCompressedDataUrl(file, 1024);
      const r = await fetch('/api/wardrobe/catalog/poses', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'solo', image: dataUrl }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || d.message || ('HTTP ' + r.status));
      const newPose = d.data?.pose;
      if (newPose?.id) selectedSoloPoseId = newPose.id;
      await window.__loadPoseOutfitCatalog(true);
      renderSoloPoseBar();
      msgEl.textContent = '✓ 已收藏姿势参考图「' + (newPose?.label || '自定义姿势') + '」（' + (d.data?.storageDriver === 'r2' ? '已存 R2 云端' : '已存本地') + '），拍试穿照时将直接按该图摆拍！';
    } catch (e) {
      msgEl.textContent = '上传姿势参考图失败：' + e.message;
    } finally {
      soloPoseUploadInput.value = '';
    }
  });

  // ── 截图一键扒同款：Step 1 拆解识别 ─────────────────────────────────────────
  extractFileInput?.addEventListener('change', async () => {
    const file = extractFileInput.files && extractFileInput.files[0];
    if (!file) return;
    if (extractStatusMsg) extractStatusMsg.textContent = '正在用视觉模型拆解截图中的全部单品（零生图费）…';
    extractPreviewWrap?.classList.add('hidden');
    try {
      pendingExtractDataUrl = await fileToCompressedDataUrl(file, 1280);
      if (extractSourceThumb) extractSourceThumb.src = pendingExtractDataUrl;
      const r = await fetch('/api/wardrobe/catalog/extract-preview', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: pendingExtractDataUrl }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || d.message || ('HTTP ' + r.status));
      detectedExtractItems = Array.isArray(d.data?.items) ? d.data.items : [];
      if (extractItemsListEl) {
        extractItemsListEl.innerHTML = detectedExtractItems.map((it, idx) =>
          '<div class="flex items-center gap-2 rounded-xl border border-line bg-white/80 dark:bg-white/10 px-2.5 py-1.5">' +
            '<input type="checkbox" data-ex-idx="' + idx + '" checked class="cursor-pointer" />' +
            '<span class="w-3 h-3 rounded-full shrink-0 border border-black/15" style="background:' + escHtml(it.swatch || '#F5D8E6') + '"></span>' +
            '<span class="text-[11px] shrink-0">' + escHtml(SLOT_EMOJI[it.slot] || '👗') + '</span>' +
            '<input type="text" data-ex-name="' + idx + '" value="' + escHtml(it.name) + '" maxlength="40" title="可自由修改单品名称" class="text-[11px] font-semibold text-ink bg-transparent border-b border-transparent focus:border-sakura-deep focus:outline-none flex-1 min-w-0" />' +
            '<span class="text-[10px] text-mute shrink-0">' + escHtml(SLOT_TEXT[it.slot] || it.category) + '</span>' +
          '</div>'
        ).join('');
      }
      extractPreviewWrap?.classList.remove('hidden');
      const hadFallback = detectedExtractItems.some(x => x.visionFallback);
      if (extractStatusMsg) {
        extractStatusMsg.textContent = hadFallback
          ? '⚠️ 视觉识别暂时超时，已按整套穿搭预选；直接保持勾选「✨ 去人去背景透明平铺 PNG」点击提取即可自动抠出无人透明服装图！'
          : '✓ 已识别 ' + detectedExtractItems.length + ' 件单品！勾选想扒的单品并点击下方提取（默认去除人物与背景生成透明平铺 PNG）：';
      }
    } catch (e) {
      pendingExtractDataUrl = '';
      if (extractStatusMsg) extractStatusMsg.textContent = '识别截图失败：' + e.message;
    } finally {
      extractFileInput.value = '';
    }
  });

  // ── 截图一键扒同款：Step 2 提取并存入 R2/灵感库 ──────────────────────────────
  extractSaveBtn?.addEventListener('click', async () => {
    if (!pendingExtractDataUrl || !detectedExtractItems.length) return;
    const checkedIndices = Array.from(extractItemsListEl?.querySelectorAll('input[data-ex-idx]:checked') || [])
      .map(el => Number(el.dataset.exIdx))
      .filter(n => Number.isInteger(n) && detectedExtractItems[n]);
    if (!checkedIndices.length) {
      if (extractStatusMsg) extractStatusMsg.textContent = '请至少勾选一件要提取的单品';
      return;
    }
    const chosenItems = checkedIndices.map(i => {
      const base = detectedExtractItems[i];
      const editedName = (extractItemsListEl?.querySelector('input[data-ex-name="' + i + '"]')?.value || '').trim();
      return editedName ? { ...base, name: editedName } : base;
    });
    const mode = document.querySelector('input[name="extract-mode"]:checked')?.value === 'flatlay' ? 'flatlay' : 'raw';
    const alsoWear = Boolean(extractAlsoWearEl?.checked && companionId);

    extractSaveBtn.disabled = true;
    extractSaveBtn.textContent = mode === 'flatlay' ? '正在去人去背景生成平铺图…' : '正在入库…';
    if (extractStatusMsg) {
      extractStatusMsg.textContent = mode === 'flatlay'
        ? '正在逐件去除人物与背景生成纯白底电商平铺图（每件约 15-35 秒）…'
        : '正在快速入库服装灵感库并上传云端…';
    }
    try {
      const r = await fetch('/api/wardrobe/catalog/extract-save', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: pendingExtractDataUrl,
          items: chosenItems,
          mode,
          companion_id: alsoWear ? companionId : undefined,
          also_add_to_wardrobe: alsoWear,
          wardrobe_status: 'wearing',
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || d.message || ('HTTP ' + r.status));
      const cnt = (d.data?.presets || []).length;
      const warnList = Array.isArray(d.data?.flatlay_warnings) ? d.data.flatlay_warnings : [];
      pendingExtractDataUrl = '';
      detectedExtractItems = [];
      extractPreviewWrap?.classList.add('hidden');
      extractBoxEl?.classList.add('hidden');
      await window.__loadPoseOutfitCatalog(true);
      renderPresetDrawer();
      msgEl.textContent = warnList.length
        ? '⚠️ 已入库 ' + cnt + ' 件，但透明平铺图提取失败已回落原图（' + warnList.join('；') + '）'
        : '✓ 已成功提取并入库 ' + cnt + ' 件' + (mode === 'flatlay' ? '透明背景平铺单品' : '单品') + '到精选服装库' + (alsoWear ? '，并同步为苏晴换上！' : '！');
      if (alsoWear) await loadWardrobe();
    } catch (e) {
      if (extractStatusMsg) extractStatusMsg.textContent = '提取入库失败：' + e.message;
    } finally {
      extractSaveBtn.disabled = false;
      extractSaveBtn.textContent = '✨ 确认提取入库';
    }
  });

  refInput?.addEventListener('change', async () => {
    const file = refInput.files && refInput.files[0];
    if (!file || !companionId) return;
    refStatus.textContent = '正在锁定人物参考图…';
    try {
      const dataUrl = await fileToCompressedDataUrl(file, 1280);
      const r = await fetch('/api/companions/' + companionId + '/visual-identity/upload-reference', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, replace: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || (!d.ok && !d.success)) throw new Error(d.error || d.message || ('HTTP ' + r.status));
      msgEl.textContent = '✓ 人物定妆参考图已锁定';
      await loadRefStatus();
    } catch (e) {
      msgEl.textContent = '参考图上传失败：' + e.message;
      await loadRefStatus();
    } finally {
      refInput.value = '';
    }
  });

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) { pendingImageDataUrl = ''; fileNameEl.textContent = '未选择图片'; return; }
    fileNameEl.textContent = '处理中：' + file.name;
    try {
      pendingImageDataUrl = await fileToCompressedDataUrl(file, 1280);
      fileNameEl.textContent = '✓ 已选：' + file.name;
    } catch (e) {
      pendingImageDataUrl = '';
      fileNameEl.textContent = '图片读取失败：' + e.message;
    }
  });

  addBtn?.addEventListener('click', async () => {
    if (!companionId) return;
    const name = (nameInput?.value || '').trim();
    if (!name && !pendingImageDataUrl) {
      msgEl.textContent = '请至少上传一张商品图，或填写单品名称';
      return;
    }
    addBtn.disabled = true;
    msgEl.textContent = pendingImageDataUrl && !name ? '正在识别商品图并上架展示柜…' : '正在上架展示柜…';
    try {
      const r = await fetch('/api/companions/' + companionId + '/wardrobe', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          slot: slotSelect?.value || undefined,
          status: statusSelect?.value || 'wearing',
          gifted_note: (noteInput?.value || '').trim(),
          image: pendingImageDataUrl || undefined,
          auto_analyze: true,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || (!d.ok && !d.success)) throw new Error(d.error || d.message || ('HTTP ' + r.status));
      const createdItem = (d.data && d.data.item) || d.item || null;
      if (nameInput) nameInput.value = '';
      if (noteInput) noteInput.value = '';
      pendingImageDataUrl = '';
      if (fileInput) fileInput.value = '';
      if (fileNameEl) fileNameEl.textContent = '未选择图片（上传后可自动识别名称与款式）';
      drawer?.classList.add('hidden');
      activeShelf = 'all';
      msgEl.textContent = '✓ 已摆进展示柜：「' + (createdItem ? createdItem.name : '新藏品') + '」';
      await loadWardrobe();
    } catch (e) {
      msgEl.textContent = '上架失败：' + e.message;
    } finally {
      addBtn.disabled = false;
    }
  });

  refreshBtn?.addEventListener('click', loadWardrobe);
  document.querySelector('[data-acc="wardrobe"] .dash-acc-head')?.addEventListener('click', () => {
    setTimeout(() => {
      const body = document.querySelector('[data-acc="wardrobe"] .dash-acc-body');
      if (body && !body.hidden) loadWardrobe();
    }, 30);
  });
})();

// ─── 三层相处框架：相处底盘 & 可结算约会剧场 & 赛博合影 ────────────────────────
(function initDateModePanel() {
  const escHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const pmodeBtns = Array.from(document.querySelectorAll('#presence-mode-options .pmode-opt'));
  const pmodeDesc = document.getElementById('presence-mode-desc');
  const pmodeMsg = document.getElementById('presence-mode-msg');
  const badgeEl = document.getElementById('datemode-badge');
  const subEl = document.getElementById('acc-sub-datemode');
  const activeBox = document.getElementById('datemode-active-box');
  const idleBox = document.getElementById('datemode-idle-box');
  const activeTitle = document.getElementById('datemode-active-title');
  const activeScene = document.getElementById('datemode-active-scene');
  const activeOutfit = document.getElementById('datemode-active-outfit');
  const activePhotos = document.getElementById('datemode-active-photos');
  const endNoteInput = document.getElementById('datemode-end-note');
  const customTitleInput = document.getElementById('datemode-custom-title');
  const statusMsg = document.getElementById('datemode-status-msg');
  const historyEl = document.getElementById('datemode-history');
  const cyberFile = document.getElementById('cyber-photo-file');
  const cyberFname = document.getElementById('cyber-photo-fname');
  const cyberNote = document.getElementById('cyber-photo-note');
  const cyberBtn = document.getElementById('btn-cyber-photo-gen');
  const cyberResult = document.getElementById('cyber-photo-result');
  const userRefInput = document.getElementById('input-upload-user-portrait');
  const userRefStatus = document.getElementById('user-ref-status');
  const userRefThumb = document.getElementById('user-ref-thumb');
  const couplePoseBar = document.getElementById('datemode-pose-bar');
  const couplePoseHint = document.getElementById('datemode-pose-hint');
  const couplePoseUploadInput = document.getElementById('input-upload-couple-pose');

  const PMODE_DESC = {
    ldr: '异地恋日常（推荐）：保留校园/生活烟火气，自然接受平时不在同一座城市，不把物理距离当爽约；想沉浸约会时再开剧场。',
    digital: '清醒跨次元：坦然接纳隔着屏幕相伴，发现实菜单/街景照时像带你一起看世界，无违和感。',
    local: '经典同城模式：保持原有默认叙事逻辑，不注入额外距离提示。',
  };

  let pendingCyberDataUrl = '';
  let currentActiveSessionId = null;
  let selectedCouplePoseId = '';
  let couplePosesList = [];

  function renderCouplePoseBar() {
    if (!couplePoseBar || !couplePosesList.length) return;
    const selected = couplePosesList.find(p => p.id === selectedCouplePoseId) || null;
    if (couplePoseHint) {
      couplePoseHint.textContent = selected
        ? '已选「' + selected.label + '」· ' + (selected.descZh || selected.tag)
        : '当前：自动自然（按约会场景自由发挥）';
    }
    couplePoseBar.innerHTML = '';
    const opts = [
      { id: '', emoji: '🎲', label: '自动自然', tag: '场景自适配', framingLabel: '自动', descZh: '根据当前约会场景与背景照自动构图' },
      ...couplePosesList,
    ];
    for (const p of opts) {
      const btn = document.createElement('button');
      const isActive = selectedCouplePoseId === p.id;
      btn.type = 'button';
      btn.className = 'pose-card is-couple' + (isActive ? ' is-active' : '');
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
      btn.title = p.descZh || p.tag || p.label;
      const previewHtml = p.previewUrl
        ? '<img data-role="cpose-img" alt="' + escHtml(p.label) + '" loading="lazy" ' + (p.authRequired ? 'class="hidden"' : 'src="' + escHtml(p.previewUrl) + '"') + ' />'
        : (typeof window.renderPosePreviewSvg === 'function'
            ? window.renderPosePreviewSvg(p.id, 'couple')
            : '<span class="text-[24px]">' + escHtml(p.emoji || '💕') + '</span>');
      const badge = p.framingLabel || p.tag || '';
      btn.innerHTML =
        '<div class="pose-card-stage">' +
          '<span class="pose-card-check" aria-hidden="true">✓</span>' +
          (p.isCustom ? '<span class="custom-asset-del" data-del-cpose="' + escHtml(p.id) + '" title="删除此自定义双人姿势">×</span>' : '') +
          (badge ? '<span class="pose-card-badge">' + escHtml(badge) + '</span>' : '') +
          previewHtml +
        '</div>' +
        '<div class="pose-card-meta">' +
          '<div class="pose-card-name">' + escHtml(p.label) + '</div>' +
          '<div class="pose-card-tag">' + escHtml(p.tag || '') + '</div>' +
        '</div>';
      if (p.previewUrl && p.authRequired) {
        const imgEl = btn.querySelector('img[data-role="cpose-img"]');
        if (imgEl) loadAuthedDateImg(imgEl, null, p.previewUrl);
      }
      btn.querySelector('[data-del-cpose]')?.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          const r = await fetch('/api/wardrobe/catalog/poses/' + encodeURIComponent(p.id), {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + token },
          });
          if (r.ok && typeof window.__loadPoseOutfitCatalog === 'function') {
            if (selectedCouplePoseId === p.id) selectedCouplePoseId = '';
            const cat = await window.__loadPoseOutfitCatalog(true);
            couplePosesList = cat?.couplePoses || [];
            renderCouplePoseBar();
          }
        } catch { /* ignore */ }
      });
      btn.addEventListener('click', () => {
        selectedCouplePoseId = p.id;
        renderCouplePoseBar();
      });
      couplePoseBar.appendChild(btn);
    }
  }

  couplePoseUploadInput?.addEventListener('change', async () => {
    const file = couplePoseUploadInput.files && couplePoseUploadInput.files[0];
    if (!file) return;
    statusMsg.textContent = '正在解析双人合影姿势图并上传存储…';
    try {
      const dataUrl = await compressImageToDataUrl(file, 1024);
      const r = await fetch('/api/wardrobe/catalog/poses', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'couple', image: dataUrl }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || d.message || ('HTTP ' + r.status));
      const newPose = d.data?.pose;
      if (newPose?.id) selectedCouplePoseId = newPose.id;
      if (typeof window.__loadPoseOutfitCatalog === 'function') {
        const cat = await window.__loadPoseOutfitCatalog(true);
        couplePosesList = cat?.couplePoses || [];
        renderCouplePoseBar();
      }
      statusMsg.textContent = '✓ 已收藏双人姿势图「' + (newPose?.label || '自定义双人姿势') + '」（' + (d.data?.storageDriver === 'r2' ? '已存 R2 云端' : '已存本地') + '）！';
    } catch (e) {
      statusMsg.textContent = '上传双人姿势图失败：' + e.message;
    } finally {
      couplePoseUploadInput.value = '';
    }
  });

  async function loadAuthedDateImg(imgEl, linkEl, url) {
    try {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return;
      const blob = await r.blob();
      const objUrl = URL.createObjectURL(blob);
      imgEl.src = objUrl;
      imgEl.classList.remove('hidden');
      if (linkEl) linkEl.href = objUrl;
    } catch { /* ignore */ }
  }

  function compressImageToDataUrl(file, maxEdge = 1280) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => resolve(String(reader.result || ''));
        img.onload = () => {
          const ratio = Math.min(1, maxEdge / Math.max(img.width, img.height, 1));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * ratio));
          canvas.height = Math.max(1, Math.round(img.height * ratio));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.86));
        };
        img.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    });
  }

  function renderPresenceMode(mode) {
    const m = PMODE_DESC[mode] ? mode : 'local';
    pmodeBtns.forEach(btn => {
      const active = btn.dataset.pmode === m;
      btn.classList.toggle('bg-sakura-soft', active);
      btn.classList.toggle('border-sakura-deep', active);
      btn.classList.toggle('text-sakura-deep', active);
      btn.classList.toggle('text-mute', !active);
    });
    if (pmodeDesc) pmodeDesc.textContent = PMODE_DESC[m];
  }

  function renderDateOverview(data) {
    if (!data) return;
    renderPresenceMode(data.presence_mode || 'local');
    if (userRefStatus) {
      userRefStatus.textContent = data.hasUserPortrait
        ? '✓ 已锁定本人形象（双人同框已就绪）'
        : '未上传本人形象照（上传后合影将包含你）';
    }
    if (userRefThumb) {
      if (data.hasUserPortrait && data.userPortraitUrl) {
        loadAuthedDateImg(userRefThumb, null, data.userPortraitUrl);
      } else {
        userRefThumb.classList.add('hidden');
      }
    }
    const active = data.activeSession || null;
    currentActiveSessionId = active?.id || null;

    if (active) {
      badgeEl.textContent = '约会中';
      badgeEl.className = 'text-[11px] px-2 py-0.5 rounded-full bg-sakura-deep text-white font-semibold';
      if (subEl) subEl.textContent = `正在约会中：${active.title}`;
      activeBox?.classList.remove('hidden');
      idleBox?.classList.add('hidden');
      if (activeTitle) activeTitle.textContent = active.title;
      if (activeScene) activeScene.textContent = '场景：' + active.scene;
      const outfits = (active.outfit_snapshot || []).map(it => (it.color || '') + (it.name || '')).filter(Boolean);
      if (activeOutfit) {
        activeOutfit.textContent = outfits.length
          ? '👗 本次联动衣橱穿搭：' + outfits.join('、')
          : '👗 衣橱暂未选定单品，按平时风格赴约';
      }
      if (activePhotos) {
        const photos = Array.isArray(active.photo_paths) ? active.photo_paths : [];
        activePhotos.innerHTML = '';
        for (const fn of photos) {
          const url = '/api/companions/' + companionId + '/date-mode/image/' + encodeURIComponent(fn.split(/[\\/]/).pop());
          const a = document.createElement('a');
          a.target = '_blank';
          a.className = 'block w-16 h-16 rounded-xl overflow-hidden border border-sakura/30 bg-white';
          const img = document.createElement('img');
          img.alt = '约会照';
          img.className = 'hidden w-full h-full object-cover';
          a.appendChild(img);
          activePhotos.appendChild(a);
          loadAuthedDateImg(img, a, url);
        }
      }
    } else {
      badgeEl.textContent = '未开启';
      badgeEl.className = 'text-[11px] px-2 py-0.5 rounded-full bg-white/80 text-mute';
      if (subEl) subEl.textContent = '异地恋防内耗底盘、可结算逛街吃饭剧场与赛博合影';
      activeBox?.classList.add('hidden');
      idleBox?.classList.remove('hidden');
    }

    if (historyEl) {
      const list = (data.recentSessions || []).filter(s => s.status !== 'active').slice(0, 5);
      if (!list.length) {
        historyEl.innerHTML = '<p class="text-mute/80">还没有已结算的约会记录。</p>';
      } else {
        historyEl.innerHTML = list.map(s => {
          const loops = Array.isArray(s.resolved_loops) && s.resolved_loops.length
            ? ` · 核销约定 ${s.resolved_loops.length} 条`
            : '';
          const tag = s.status === 'settled' ? '已存记忆' : '已结束';
          const dateStr = String(s.started_at || '').slice(0, 10);
          return `<div class="rounded-lg bg-white/60 border border-line px-2.5 py-1.5 flex items-center justify-between gap-2">
            <span class="text-ink font-medium truncate">${escHtml(s.title)}</span>
            <span class="text-mute shrink-0">${escHtml(dateStr)} · ${tag}${loops}</span>
          </div>`;
        }).join('');
      }
    }
  }

  async function loadDateMode() {
    if (!companionId) return;
    if (typeof window.__loadPoseOutfitCatalog === 'function') {
      window.__loadPoseOutfitCatalog().then(cat => {
        if (cat && Array.isArray(cat.couplePoses)) {
          couplePosesList = cat.couplePoses;
          renderCouplePoseBar();
        }
      });
    }
    try {
      const r = await fetch('/api/companions/' + companionId + '/date-mode', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok && d.data) {
        renderDateOverview(d.data);
        if (typeof window.__refreshHeroStage === 'function') window.__refreshHeroStage();
      }
    } catch (e) {
      if (statusMsg) statusMsg.textContent = '加载失败：' + e.message;
    }
  }

  pmodeBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!companionId) return;
      const mode = btn.dataset.pmode;
      pmodeMsg.textContent = '保存中…';
      try {
        const r = await fetch('/api/companions/' + companionId + '/presence-mode', {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ presence_mode: mode }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || d.message || ('HTTP ' + r.status));
        renderPresenceMode(d.data?.presence_mode || mode);
        pmodeMsg.textContent = '✓ 已切换';
      } catch (e) {
        pmodeMsg.textContent = '切换失败：' + e.message;
      }
    });
  });

  async function startDate(payload) {
    if (!companionId) return;
    statusMsg.textContent = '正在开启约会剧场…';
    try {
      const r = await fetch('/api/companions/' + companionId + '/date-mode/start', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || d.message || ('HTTP ' + r.status));
      statusMsg.textContent = '✓ 已进入约会剧场，快去和她聊天吧！';
      if (customTitleInput) customTitleInput.value = '';
      await loadDateMode();
    } catch (e) {
      statusMsg.textContent = '开启失败：' + e.message;
    }
  }

  document.querySelectorAll('#datemode-presets .dtype-btn').forEach(btn => {
    btn.addEventListener('click', () => startDate({ activity_type: btn.dataset.dtype || 'custom' }));
  });

  document.getElementById('btn-datemode-custom-start')?.addEventListener('click', () => {
    const title = (customTitleInput?.value || '').trim();
    if (!title) { statusMsg.textContent = '请输入约会主题或直接点上面的快捷场景'; return; }
    startDate({ activity_type: 'custom', title, scene: '和他一起' + title });
  });

  document.getElementById('btn-datemode-end')?.addEventListener('click', async () => {
    if (!companionId) return;
    statusMsg.textContent = '正在结算约会记忆与核销约定…';
    try {
      const r = await fetch('/api/companions/' + companionId + '/date-mode/end', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentActiveSessionId,
          note: (endNoteInput?.value || '').trim(),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || d.message || ('HTTP ' + r.status));
      if (endNoteInput) endNoteInput.value = '';
      const resolved = d.data?.resolvedLoops || [];
      const loopTip = resolved.length ? `，并核销了 ${resolved.length} 条关联约定` : '';
      statusMsg.textContent = `✓ 已圆满结算并写入长期记忆${loopTip}`;
      await loadDateMode();
    } catch (e) {
      statusMsg.textContent = '结算失败：' + e.message;
    }
  });

  document.getElementById('btn-datemode-photo')?.addEventListener('click', async (ev) => {
    if (!companionId) return;
    const btn = ev.currentTarget;
    btn.disabled = true;
    const poseObj = couplePosesList.find(p => p.id === selectedCouplePoseId);
    const poseTip = poseObj ? ' · 姿势「' + poseObj.label + '」' : '';
    statusMsg.textContent = '正在结合人物参考图与衣橱穿搭拍约会打卡照' + poseTip + '…';
    try {
      const r = await fetch('/api/companions/' + companionId + '/date-mode/photo', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          note: (endNoteInput?.value || '').trim(),
          pose_id: selectedCouplePoseId || undefined,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || d.message || ('HTTP ' + r.status));
      statusMsg.textContent = '✓ 约会打卡照' + poseTip + '已生成';
      await loadDateMode();
    } catch (e) {
      statusMsg.textContent = '打卡照生成失败：' + e.message;
    } finally {
      btn.disabled = false;
    }
  });

  cyberFile?.addEventListener('change', async () => {
    const file = cyberFile.files && cyberFile.files[0];
    if (!file) { pendingCyberDataUrl = ''; cyberFname.textContent = '未选择图片'; return; }
    cyberFname.textContent = '处理中：' + file.name;
    try {
      pendingCyberDataUrl = await compressImageToDataUrl(file, 1280);
      cyberFname.textContent = '✓ 已选：' + file.name;
    } catch (e) {
      pendingCyberDataUrl = '';
      cyberFname.textContent = '读取失败：' + e.message;
    }
  });

  cyberBtn?.addEventListener('click', async () => {
    if (!companionId) return;
    if (!pendingCyberDataUrl) { statusMsg.textContent = '请先选择一张现实环境照（如餐桌空座/街景）'; return; }
    cyberBtn.disabled = true;
    const poseObj = couplePosesList.find(p => p.id === selectedCouplePoseId);
    const poseTip = poseObj ? ' · 姿势「' + poseObj.label + '」' : '';
    statusMsg.textContent = '正在合成赛博合影' + poseTip + '（结合人物参考图 + 当前衣橱穿搭）…';
    try {
      const r = await fetch('/api/companions/' + companionId + '/date-mode/cyber-photo', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: pendingCyberDataUrl,
          note: (cyberNote?.value || '').trim(),
          pose_id: selectedCouplePoseId || undefined,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || d.message || ('HTTP ' + r.status));
      statusMsg.textContent = '✓ 赛博合影' + poseTip + '已生成！';
      const imgUrl = d.data?.image_url;
      if (cyberResult && imgUrl) {
        cyberResult.classList.remove('hidden');
        cyberResult.innerHTML = '';
        const a = document.createElement('a');
        a.target = '_blank';
        a.className = 'inline-block rounded-xl overflow-hidden border border-sakura/40 max-w-[220px]';
        const img = document.createElement('img');
        img.alt = '赛博合影';
        img.className = 'hidden w-full h-auto block';
        a.appendChild(img);
        cyberResult.appendChild(a);
        loadAuthedDateImg(img, a, imgUrl);
      }
      await loadDateMode();
    } catch (e) {
      statusMsg.textContent = '赛博合影失败：' + e.message;
    } finally {
      cyberBtn.disabled = false;
    }
  });

  userRefInput?.addEventListener('change', async () => {
    const file = userRefInput.files && userRefInput.files[0];
    if (!file || !companionId) return;
    if (userRefStatus) userRefStatus.textContent = '正在上传并锁定本人形象照…';
    try {
      const dataUrl = await compressImageToDataUrl(file, 1280);
      const r = await fetch('/api/companions/' + companionId + '/user-visual-reference', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || d.message || ('HTTP ' + r.status));
      statusMsg.textContent = '✓ 本人形象照已锁定，现在拍约会照/赛博合影就会双人同框啦！';
      await loadDateMode();
    } catch (e) {
      if (userRefStatus) userRefStatus.textContent = '上传失败：' + e.message;
    } finally {
      userRefInput.value = '';
    }
  });

  document.getElementById('btn-datemode-refresh')?.addEventListener('click', loadDateMode);
  document.querySelector('[data-acc="datemode"] .dash-acc-head')?.addEventListener('click', () => {
    setTimeout(() => {
      const body = document.querySelector('[data-acc="datemode"] .dash-acc-body');
      if (body && !body.hidden) loadDateMode();
    }, 30);
  });
})();

// ─── 清透极光 / 暗夜液态玻璃切换 + 左侧角色光影大舞台 ──────────────────────────
(function initAuroraThemeAndHeroStage() {
  const themeBtn = document.getElementById('btn-dash-theme');
  function syncThemeLabel() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (themeBtn) themeBtn.textContent = isDark ? '🌌 暗夜玻璃' : '✨ 极光玻璃';
  }
  syncThemeLabel();
  themeBtn?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('xiyu_theme', next); } catch {}
    syncThemeLabel();
  });

  async function refreshHeroStage() {
    const stage = document.getElementById('dash-hero-stage');
    const imgEl = document.getElementById('dash-hero-img');
    const badgeEl = document.getElementById('dash-hero-badge');
    const capEl = document.getElementById('dash-hero-caption');
    const chipsEl = document.getElementById('dash-hero-chips');
    if (!stage || !imgEl || !companionId || !token) return;

    try {
      const [wRes, dRes] = await Promise.all([
        fetch('/api/companions/' + companionId + '/wardrobe', { headers: { Authorization: 'Bearer ' + token } }),
        fetch('/api/companions/' + companionId + '/date-mode', { headers: { Authorization: 'Bearer ' + token } }),
      ]);
      const wJson = await wRes.json().catch(() => ({}));
      const dJson = await dRes.json().catch(() => ({}));
      const items = (wJson.ok && wJson.data && wJson.data.items) || [];
      const wearing = items.filter(it => it.status === 'wearing');
      const heroItem = wearing.find(it => it.tryon_image_path)
        || wearing.find(it => it.source_image_path)
        || items.find(it => it.tryon_image_path)
        || null;
      const activeDate = (dJson.ok && dJson.data && dJson.data.activeSession) || null;

      let directCdnUrl = '';
      let imgUrl = '';
      if (heroItem && (heroItem.tryon_public_url || heroItem.tryon_image_path)) {
        if (heroItem.tryon_public_url && /^https?:\/\//i.test(heroItem.tryon_public_url)) {
          directCdnUrl = heroItem.tryon_public_url;
        }
        imgUrl = '/api/companions/' + companionId + '/wardrobe/' + heroItem.id + '/image?kind=tryon&t=' + Date.now();
      } else if (heroItem && (heroItem.source_public_url || heroItem.source_image_path)) {
        if (heroItem.source_public_url && /^https?:\/\//i.test(heroItem.source_public_url)) {
          directCdnUrl = heroItem.source_public_url;
        }
        imgUrl = '/api/companions/' + companionId + '/wardrobe/' + heroItem.id + '/image?kind=source&t=' + Date.now();
      } else {
        imgUrl = '/api/companions/' + companionId + '/visual-identity/reference-image?t=' + Date.now();
      }

      if (directCdnUrl) {
        imgEl.src = directCdnUrl;
        stage.classList.remove('hidden');
      } else {
        const imgResp = await fetch(imgUrl, { headers: { Authorization: 'Bearer ' + token } });
        if (!imgResp.ok) return;
        const blob = await imgResp.blob();
        if (blob.size < 64) return;
        if (imgEl.dataset.blobUrl) {
          try { URL.revokeObjectURL(imgEl.dataset.blobUrl); } catch {}
        }
        const nextBlobUrl = URL.createObjectURL(blob);
        imgEl.dataset.blobUrl = nextBlobUrl;
        imgEl.src = nextBlobUrl;
        stage.classList.remove('hidden');
      }

      if (badgeEl) {
        if (activeDate) {
          badgeEl.textContent = '💕 约会中 · ' + activeDate.title;
          badgeEl.classList.add('is-dating');
        } else {
          badgeEl.textContent = heroItem ? '✨ 今日穿搭大片' : '✨ 人物定妆照';
          badgeEl.classList.remove('is-dating');
        }
      }
      if (capEl) {
        capEl.textContent = wearing.length
          ? '今日在穿：' + wearing.map(i => i.name).join(' + ')
          : (heroItem ? '最近试穿：' + heroItem.name : '点击进入展示柜为她挑新穿搭');
      }
      if (chipsEl) {
        chipsEl.innerHTML = wearing.slice(0, 4).map(i =>
          '<span class="text-[10px] px-2 py-0.5 rounded-full bg-white/20 backdrop-blur border border-white/25">' +
          String(i.name || '').replace(/[&<>"']/g, '') + '</span>'
        ).join('');
      }
    } catch { /* ignore */ }
  }

  document.getElementById('dash-hero-stage')?.addEventListener('click', () => {
    document.querySelector('.dash-tab[data-dash-tab="tools"]')?.click();
    const acc = document.querySelector('[data-acc="wardrobe"]');
    const body = acc?.querySelector('.dash-acc-body');
    if (body && body.hidden) acc.querySelector('.dash-acc-head')?.click();
  });

  window.__refreshHeroStage = refreshHeroStage;

  // 延迟等待 load() 拿到 companionId 后自动点亮角色大舞台
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (companionId) { clearInterval(timer); refreshHeroStage(); }
    else if (tries > 25) clearInterval(timer);
  }, 200);
})();

(function initDashboardWorkspace() {
  const tabs = Array.from(document.querySelectorAll('.dash-tab[data-dash-tab]'));
  const ALL_TABS = ['settings', 'stories', 'tools', 'stickers', 'models'];
  function switchDashTab(name) {
    tabs.forEach((btn) => {
      const active = btn.dataset.dashTab === name;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    for (const k of ALL_TABS) {
      document.getElementById('dash-tab-' + k)?.classList.toggle('hidden', k !== name);
    }
    const tabScroller = document.querySelector('#dash-workspace .dash-tab-scroll');
    if (tabScroller) tabScroller.scrollTop = 0;
    if (name === 'stories' && window.__lastEmotionPoints) {
      requestAnimationFrame(() => renderEmotionChart(window.__lastEmotionPoints));
    }
    if (name === 'stickers' && window.XiyuStickerStudio) {
      window.XiyuStickerStudio.mount('#dash-sticker-root', { standalone: false });
    }
    if (name === 'models' && window.XiyuModelPanel) {
      window.XiyuModelPanel.refresh();
    }
  }
  tabs.forEach((btn) => btn.addEventListener('click', () => switchDashTab(btn.dataset.dashTab)));
  document.querySelectorAll('[data-jump-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.jumpTab;
      if (!target) return;
      switchDashTab(target);
      if (window.innerWidth < 860) {
        document.getElementById('dash-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // 手风琴项：点击标题行展开/折叠；点行内 toggle 或链接不触发折叠
  const accItems = Array.from(document.querySelectorAll('.dash-acc-item'));
  accItems.forEach((item) => {
    const head = item.querySelector('.dash-acc-head');
    const body = item.querySelector('.dash-acc-body');
    if (!head || !body) return;

    item.querySelectorAll('.dash-acc-stop').forEach((el) => {
      el.addEventListener('click', (e) => e.stopPropagation());
    });

    function toggleItem() {
      const willOpen = body.hidden;
      // 同一个列表内手风琴互斥展开，保持页面简洁
      const list = item.parentElement;
      if (willOpen && list) {
        list.querySelectorAll('.dash-acc-item.open').forEach((other) => {
          if (other === item) return;
          other.classList.remove('open');
          const ob = other.querySelector('.dash-acc-body');
          const oh = other.querySelector('.dash-acc-head');
          if (ob) ob.hidden = true;
          if (oh) oh.setAttribute('aria-expanded', 'false');
        });
      }
      item.classList.toggle('open', willOpen);
      body.hidden = !willOpen;
      head.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    }

    head.addEventListener('click', toggleItem);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleItem(); }
    });
  });

  // 实时同步折叠行摘要（作息时间 / 主动找你条数）
  const syncSummaries = () => {
    const bed = document.getElementById('dial-bed-time')?.textContent;
    const wake = document.getElementById('dial-wake-time')?.textContent;
    const sleepSub = document.getElementById('acc-sub-sleep');
    if (sleepSub && bed && wake) sleepSub.textContent = `${bed} – ${wake} · 点击调整作息`;
    const target = document.getElementById('proactive-target-val')?.textContent;
    const proOn = document.getElementById('t-proactive')?.checked;
    const proSub = document.getElementById('acc-sub-proactive');
    if (proSub) proSub.textContent = proOn ? `已开启 · 每天约 ${target || 4} 条` : '已关闭 · 点击调整频率';
  };
  document.getElementById('proactive-target-slider')?.addEventListener('input', syncSummaries);
  document.getElementById('t-proactive')?.addEventListener('change', syncSummaries);
  document.getElementById('btn-sleep-save')?.addEventListener('click', () => setTimeout(syncSummaries, 200));
  setTimeout(syncSummaries, 900);
})();

load().catch(e => {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('no-companion').classList.remove('hidden');
  console.error(e);
}).then(() => { if (companionId) loadSleep(); });

if (window.XiyuUI) window.XiyuUI.registerSW();
