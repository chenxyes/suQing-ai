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
        if (d.released) { showToast('安全模式已解除'); banner.style.display = 'none'; }
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
        const r = await fetch(`/api/companions/${companionId}/export`, {
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
        const text = await file.text();
        const payload = JSON.parse(text);
        const r = await fetch('/api/companions/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: text,
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || '导入失败');
        importStatus.textContent = `✓ 导入成功，角色 ID: ${d.data.companion_id}`;
        showToast('导入成功！');
      } catch (e2) {
        importStatus.textContent = '✗ ' + e2.message;
      }
      importInput.value = '';
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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

load().catch(e => {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('no-companion').classList.remove('hidden');
  console.error(e);
}).then(() => { if (companionId) loadSleep(); });

if (window.XiyuUI) window.XiyuUI.registerSW();
