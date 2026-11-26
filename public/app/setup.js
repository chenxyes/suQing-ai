/* 溪语 AI · 配置向导主逻辑（从 setup.html 拆分） */
'use strict';
// ─── Provider 元信息 ──────────────────────────────────────────────────────
const PROVIDER_META = {
  deepseek:  { link: 'https://platform.deepseek.com/api_keys',           note: '' },
  openai:    { link: 'https://platform.openai.com/api-keys',             note: '' },
  anthropic: { link: 'https://console.anthropic.com/',                   note: '' },
  gemini:    { link: 'https://aistudio.google.com/apikey',               note: '默认模型 gemini-2.5-flash，可在 .env 中用 CHAT_MODEL 覆盖' },
  zhipu:     { link: 'https://open.bigmodel.cn/usercenter/apikeys',      note: '' },
  qwen:      { link: 'https://dashscope.console.aliyun.com/apiKey',      note: '' },
  kimi:      { link: 'https://platform.moonshot.cn/console/api-keys',    note: '' },
  doubao:    { link: 'https://console.volcengine.com/ark',               note: '⚠ 需填火山方舟接入点 ID（CHAT_MODEL=ep-xxx）' },
  wenxin:    { link: 'https://qianfan.cloud.baidu.com/',                 note: '' },
  xai:       { link: 'https://console.x.ai/',                            note: '' },
  'openai-compatible': { link: '', note: '通用 OpenAI 兼容网关（OpenRouter / SiliconFlow / One API / LiteLLM 等），需自定义 Base URL + Model' },
};

// ─── OpenAI Compatible 快捷预设 ────────────────────────────────────────────
// 仅预填 Base URL 和示例 Model；API Key 仍需用户自己粘贴。
// 示例 Model 选有免费/低价额度的，便于跑通；用户随时可改。
const OAI_COMPAT_PRESETS = [
  { id: 'openrouter',   label: 'OpenRouter',   baseURL: 'https://openrouter.ai/api/v1',                model: 'deepseek/deepseek-chat' },
  { id: 'siliconflow',  label: 'SiliconFlow',  baseURL: 'https://api.siliconflow.cn/v1',               model: 'deepseek-ai/DeepSeek-V3' },
  { id: 'groq',         label: 'Groq',         baseURL: 'https://api.groq.com/openai/v1',              model: 'llama-3.3-70b-versatile' },
  { id: 'together',     label: 'Together',     baseURL: 'https://api.together.xyz/v1',                 model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { id: 'mistral',      label: 'Mistral',      baseURL: 'https://api.mistral.ai/v1',                   model: 'mistral-small-latest' },
  { id: 'lmstudio',     label: 'LM Studio',    baseURL: 'http://localhost:1234/v1',                    model: 'local-model' },
  { id: 'ollama',       label: 'Ollama',       baseURL: 'http://localhost:11434/v1',                   model: 'llama3.2' },
];

// ─── 全局状态 ─────────────────────────────────────────────────────────────
const S = {
  authMode:      'local',   // 'local' | 'email'
  initialized:   false,     // 系统是否已有账号
  authenticated: false,     // 当前会话是否已登录
  user:          null,      // { id, display_name }
  providerSaved: false,     // provider 配置是否已保存
  activeProvider:'',        // 当前活跃 provider id
  testPassed:    false,     // 连通性测试是否通过
  testSkipped:   false,     // 用户是否选择跳过测试
  currentStep:   2,         // wizard 当前步骤（2-5）
};

// ─── Token 存取（兼容 xiyu_token 与旧版 auth_token）─────────────────────
function getToken() {
  return localStorage.getItem('xiyu_token')
    || localStorage.getItem('auth_token')
    || sessionStorage.getItem('auth_token')
    || '';
}
function saveToken(token) {
  localStorage.setItem('xiyu_token', token);
}
function saveUser(user) {
  // 让 /app/create.html / dashboard.html 等页面的 token + user 检查通过
  if (user) localStorage.setItem('xiyu_user', JSON.stringify(user));
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────
function setMsg(id, text, type = 'info') {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'mt-3 msg-' + type;
  el.textContent = text;
}
function show(id)   { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
function hide(id)   { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }
function authHeaders(extra = {}) {
  const token = getToken();
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra }
    : { 'Content-Type': 'application/json', ...extra };
}

// ─── 视图切换 ─────────────────────────────────────────────────────────────
function showView(viewId) {
  for (const id of ['view-loading','view-local-init','view-need-login','view-email-mode','view-wizard']) {
    document.getElementById(id).classList.toggle('hidden', id !== viewId);
  }
}

function renderView() {
  if (S.authenticated) {
    showView('view-wizard');
    // 显示用户名
    const uEl = document.getElementById('wizard-username');
    if (uEl) uEl.textContent = S.user?.display_name || '（未知）';
    // 进入合适步骤
    const startStep = S.providerSaved ? 3 : 2;
    goStep(startStep);
    return;
  }
  if (S.authMode === 'email') { showView('view-email-mode'); return; }
  if (S.initialized)           { showView('view-need-login'); return; }
  showView('view-local-init');
}

// ─── Wizard 步骤路由 ───────────────────────────────────────────────────────
function canGoStep(n) {
  if (n <= 2) return S.authenticated;
  if (n === 3) return S.authenticated && S.providerSaved;
  if (n === 4) return S.authenticated && (S.testPassed || S.testSkipped);
  if (n === 5) return S.authenticated;
  return false;
}

function updateTabs() {
  for (let i = 2; i <= 5; i++) {
    const tab = document.getElementById(`tab-${i}`);
    if (!tab) continue;
    tab.classList.remove('active', 'done', 'locked');
    if (i === S.currentStep) {
      tab.classList.add('active');
    } else if (i < S.currentStep) {
      tab.classList.add('done');
    } else {
      if (!canGoStep(i)) tab.classList.add('locked');
    }
  }
}

function goStep(n) {
  if (n < 2 || n > 5) return;
  if (!canGoStep(n)) return;
  S.currentStep = n;
  document.querySelectorAll('.panel').forEach(p => {
    p.classList.toggle('active', Number(p.dataset.panel) === n);
  });
  updateTabs();
  if (n === 2) refreshStep2();
  if (n === 3) refreshStep3();
}

// Tab 点击（仅 done 的 tab 允许点击）
document.querySelectorAll('.step-tab[data-step]').forEach(tab => {
  tab.addEventListener('click', () => {
    const n = Number(tab.dataset.step);
    if (n >= 2 && tab.classList.contains('done')) goStep(n);
  });
});

// ─── Step 2 ───────────────────────────────────────────────────────────────
async function refreshStep2() {
  try {
    const r = await fetch('/api/setup/provider-status', { headers: { Authorization: `Bearer ${getToken()}` } });
    const d = await r.json();
    if (!d.ok) return;
    // 把后端返回的 models / default_model 灌入前端缓存
    for (const [pid, info] of Object.entries(d.data.providers || {})) {
      if (Array.isArray(info.models)) PROVIDER_MODELS[pid] = info.models;
      if (info.default_model)         PROVIDER_DEFAULT_MODEL[pid] = info.default_model;
    }
    const active = d.data.chat_provider;
    const pInfo  = d.data.providers?.[active];
    const activeModel = d.data.chat_model_override || d.data.chat_model || '';
    S.activeProvider = active || '';
    const cur = document.getElementById('s2-current');
    if (pInfo?.configured) {
      S.providerSaved = true;
      cur.classList.remove('hidden');
      document.getElementById('s2-cur-label').textContent = pInfo.label || active;
      // masked_key 和 source 仅登录时返回，缺失时降级显示
      const detailEl = document.getElementById('s2-cur-detail');
      const segs = [];
      if (pInfo.source === 'env')           segs.push('来源：环境变量');
      else if (pInfo.source === 'app_settings') segs.push('来源：数据库');
      if (pInfo.masked_key) segs.push(`Key：${pInfo.masked_key}`);
      if (pInfo.base_url)   segs.push(`Base URL：${pInfo.base_url}`);
      if (pInfo.model)      segs.push(`Model：${pInfo.model}`);
      detailEl.textContent = segs.length ? ' · ' + segs.join(' · ') : ' · 已配置';
      // 预选 & 同步自定义字段
      const sel = document.getElementById('s2-provider');
      if (sel.querySelector(`option[value="${active}"]`)) sel.value = active;
      toggleCustomRow(active);
      if (isCustomProvider(active)) {
        if (pInfo.base_url) document.getElementById('s2-base-url').value = pInfo.base_url;
        if (pInfo.model)    document.getElementById('s2-model').value    = pInfo.model;
      } else {
        renderModelRow(active, activeModel);
      }
      updateStep2NextBtn(true);
    } else {
      // 即便未完全配置，也回显已填字段（仅限自定义 provider）
      const sel = document.getElementById('s2-provider');
      if (active && sel.querySelector(`option[value="${active}"]`)) sel.value = active;
      toggleCustomRow(active);
      if (active && isCustomProvider(active) && pInfo) {
        if (pInfo.base_url) document.getElementById('s2-base-url').value = pInfo.base_url;
        if (pInfo.model)    document.getElementById('s2-model').value    = pInfo.model;
      } else if (active && !isCustomProvider(active)) {
        renderModelRow(active, activeModel);
      }
      updateStep2NextBtn(false);
    }
  } catch {}
  // 顺带刷新可选能力区域
  refreshOptional();
}

function updateStep2NextBtn(enabled) {
  const btn  = document.getElementById('s2-btn-next');
  const hint = document.getElementById('s2-next-hint');
  btn.disabled = !enabled;
  hint.style.display = enabled ? 'none' : 'inline';
  if (enabled) S.providerSaved = true;
}

function isCustomProvider(id) { return id === 'openai-compatible'; }

function toggleCustomRow(id) {
  const customRow = document.getElementById('s2-custom-row');
  if (!customRow) return;
  const show = isCustomProvider(id);
  customRow.classList.toggle('hidden', !show);
  if (show) renderOaiPresets();
}

// 用 provider-status 返回的 models 数组渲染下拉
// PROVIDER_MODELS 在 init() 拉 provider-status 时填充：{ deepseek: ['deepseek-chat', ...], ... }
const PROVIDER_MODELS = Object.create(null);
const PROVIDER_DEFAULT_MODEL = Object.create(null);

function renderModelRow(providerId, presetActiveModel) {
  const row = document.getElementById('s2-model-row');
  if (!row) return;
  // openai-compatible 走自己的 base_url + model 输入，不显示通用 model 行
  if (!providerId || isCustomProvider(providerId)) {
    row.classList.add('hidden');
    return;
  }
  const models = PROVIDER_MODELS[providerId] || [];
  const defaultModel = PROVIDER_DEFAULT_MODEL[providerId] || '';
  const sel = document.getElementById('s2-model-select');
  const input = document.getElementById('s2-model-custom');
  sel.innerHTML = '';

  // 第一项：使用默认
  const optDefault = document.createElement('option');
  optDefault.value = '__default__';
  optDefault.textContent = defaultModel ? `使用默认（${defaultModel}）` : '使用默认';
  sel.appendChild(optDefault);

  // 预设模型
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m === defaultModel ? `${m} · 默认` : m;
    sel.appendChild(o);
  }
  // 自定义
  const optCustom = document.createElement('option');
  optCustom.value = '__custom__';
  optCustom.textContent = '自定义模型 ID…';
  sel.appendChild(optCustom);

  // 选中：尽量匹配 presetActiveModel
  if (presetActiveModel && presetActiveModel !== defaultModel) {
    if (models.includes(presetActiveModel)) {
      sel.value = presetActiveModel;
      input.value = '';
      input.classList.add('hidden');
    } else {
      sel.value = '__custom__';
      input.value = presetActiveModel;
      input.classList.remove('hidden');
    }
  } else {
    sel.value = '__default__';
    input.value = '';
    input.classList.add('hidden');
  }

  row.classList.remove('hidden');
}

document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 's2-model-select') {
    const input = document.getElementById('s2-model-custom');
    if (e.target.value === '__custom__') {
      input.classList.remove('hidden');
      input.focus();
    } else {
      input.classList.add('hidden');
    }
  }
});

// 把 select+input 解析为发送给后端的 model 字符串
//   __default__ → '' (清空 CHAT_MODEL，让 chat.mjs 用 default)
//   __custom__  → input 的值（trim 过）
//   其它       → 选中的模型 ID
function readChosenModel() {
  const sel = document.getElementById('s2-model-select');
  if (!sel || sel.classList.contains('hidden') && sel.parentElement.classList.contains('hidden')) return undefined;
  const v = sel.value;
  if (v === '__default__') return '';
  if (v === '__custom__') return document.getElementById('s2-model-custom').value.trim();
  return v;
}

function renderOaiPresets() {
  const row = document.getElementById('s2-preset-row');
  if (!row || row.dataset.rendered === '1') return;
  row.dataset.rendered = '1';
  row.innerHTML = '';
  for (const p of OAI_COMPAT_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = p.label;
    b.addEventListener('click', () => {
      document.getElementById('s2-base-url').value = p.baseURL;
      document.getElementById('s2-model').value    = p.model;
      setMsg('s2-msg', `已填入 ${p.label} 的 Base URL 和示例 Model，再粘贴 API Key 即可保存。`, 'info');
    });
    row.appendChild(b);
  }
}

document.getElementById('s2-provider').addEventListener('change', (e) => {
  const id   = e.target.value;
  const meta = PROVIDER_META[id];
  const linkRow = document.getElementById('s2-link-row');
  if (meta && id) {
    // 自定义网关没有官方申请链接，只显示说明
    if (meta.link) {
      linkRow.classList.remove('hidden');
      document.getElementById('s2-link').href = meta.link;
      document.getElementById('s2-link').textContent = meta.link.replace('https://', '');
      document.getElementById('s2-note').textContent = meta.note || '';
    } else if (meta.note) {
      linkRow.classList.remove('hidden');
      document.getElementById('s2-link').removeAttribute('href');
      document.getElementById('s2-link').textContent = '';
      document.getElementById('s2-note').textContent = meta.note;
    } else {
      linkRow.classList.add('hidden');
    }
  } else {
    linkRow.classList.add('hidden');
  }
  toggleCustomRow(id);
  // 同步刷新 Model 下拉
  renderModelRow(id, '');
});

document.getElementById('s2-btn-save').addEventListener('click', async () => {
  const provider = document.getElementById('s2-provider').value;
  const apiKey   = document.getElementById('s2-apikey').value;
  if (!provider) { setMsg('s2-msg', '请选择 Provider', 'err'); return; }
  const payload = { chat_provider: provider, api_key: apiKey };
  if (isCustomProvider(provider)) {
    const baseUrl = document.getElementById('s2-base-url').value.trim();
    const model   = document.getElementById('s2-model').value.trim();
    if (!baseUrl) { setMsg('s2-msg', '请填写 Base URL', 'err'); return; }
    if (!/^https?:\/\//i.test(baseUrl)) {
      setMsg('s2-msg', 'Base URL 必须是 http(s):// 开头', 'err'); return;
    }
    if (!model) { setMsg('s2-msg', '请填写 Model', 'err'); return; }
    payload.base_url = baseUrl;
    payload.model    = model;
  } else {
    // 通用 provider：把 Model 下拉选择带上
    const chosen = readChosenModel();
    if (chosen !== undefined) {
      payload.model = chosen;
      if (chosen === '') payload.clear_model = true;  // 让后端删除 CHAT_MODEL
    }
  }
  const token = getToken();
  if (!token) { setMsg('s2-msg', '会话已失效，请刷新页面重新登录', 'err'); return; }
  setMsg('s2-msg', '保存中…', 'info');
  try {
    const r = await fetch('/api/setup/provider-config', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    if (r.status === 401 || r.status === 403) {
      setMsg('s2-msg', '会话已失效，请刷新页面重新登录', 'err');
      return;
    }
    const d = await r.json();
    if (d.ok) {
      const parts = [];
      if (d.data.key_saved) parts.push('含 API Key');
      else parts.push('未修改旧 Key');
      if (d.data.base_url_saved) parts.push('Base URL');
      if (d.data.model_saved)    parts.push('Model');
      setMsg('s2-msg', `✅ 已保存 ${d.data.label}（${parts.join('、')}）`, 'ok');
      S.providerSaved = true;
      S.activeProvider = provider;
      await refreshStep2();
    } else {
      setMsg('s2-msg', '❌ ' + (d.error || d.message || '保存失败'), 'err');
    }
  } catch (e) { setMsg('s2-msg', '❌ ' + e.message, 'err'); }
});

document.getElementById('s2-btn-next').addEventListener('click', () => {
  if (S.providerSaved) goStep(3);
});

// ─── Step 2 Master-Detail：先全部一竖列，点击某项在右侧/下方弹出对应配置 ──
S.selectedCap = null;
const s2MainEl = document.getElementById('main-content');
const s2MdEl   = document.getElementById('s2-master-detail');
const s2WrapEl = document.getElementById('s2-detail-wrap');
const s2CapBtns = Array.from(document.querySelectorAll('#s2-cap-list .s2-cap-item'));
const s2Panes   = Array.from(document.querySelectorAll('#s2-detail-wrap .s2-detail-pane'));

function placeS2DetailForViewport() {
  if (!s2WrapEl || !s2MdEl) return;
  if (!S.selectedCap) {
    if (s2WrapEl.parentNode !== s2MdEl) s2MdEl.appendChild(s2WrapEl);
    return;
  }
  // 手风琴展开：始终紧贴当前点击项的正下方原地展开，再次点击折叠
  const activeBtn = s2CapBtns.find(b => b.dataset.s2Cap === S.selectedCap);
  if (activeBtn && s2WrapEl.previousElementSibling !== activeBtn) {
    activeBtn.insertAdjacentElement('afterend', s2WrapEl);
  }
}

function selectS2Cap(cap) {
  S.selectedCap = cap || null;
  s2CapBtns.forEach((btn) => {
    const active = btn.dataset.s2Cap === S.selectedCap;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-expanded', active ? 'true' : 'false');
  });
  s2Panes.forEach((pane) => {
    pane.classList.toggle('hidden', pane.dataset.s2Pane !== S.selectedCap);
  });
  const open = Boolean(S.selectedCap);
  placeS2DetailForViewport();
  if (s2WrapEl) s2WrapEl.hidden = !open;
  if (open && s2WrapEl) {
    setTimeout(() => s2WrapEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 40);
  }
}

s2CapBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const cap = btn.dataset.s2Cap;
    selectS2Cap(S.selectedCap === cap ? null : cap);
  });
});
document.getElementById('s2-detail-close')?.addEventListener('click', () => selectS2Cap(null));

function setS2CapSummary(cap, subText, ok) {
  const sub = document.getElementById(`s2-cap-sub-${cap}`);
  const dot = document.getElementById(`s2-cap-dot-${cap}`);
  if (sub) sub.textContent = subText;
  if (dot) dot.classList.toggle('on', Boolean(ok));
}

// Step 2 对话模型直接测试连通性
document.getElementById('s2-chat-test')?.addEventListener('click', async () => {
  const provider = document.getElementById('s2-provider').value;
  if (!provider) { setMsg('s2-msg', '请先选择并保存 Provider', 'err'); return; }
  const btn = document.getElementById('s2-chat-test');
  btn.disabled = true;
  setMsg('s2-msg', '正在测试已保存的对话模型配置…', 'info');
  try {
    const r = await fetch('/api/setup/test-provider', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ capability: 'chat', provider }),
    });
    const d = await r.json();
    if (d.ok && d.data?.ok) {
      setMsg('s2-msg', `✅ 连通成功！${d.data.label || provider} · ${d.data.latency_ms ?? '--'}ms`, 'ok');
      S.testPassed = true;
      updateTabs();
    } else {
      setMsg('s2-msg', '❌ ' + (d.data?.error || d.error || d.message || '连接失败').slice(0, 120), 'err');
    }
  } catch (e) {
    setMsg('s2-msg', '❌ 连接测试失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

// ─── Step 2 可选能力：vision / asr ────────────────────────────────────────
// 每个能力独立保存到 app_settings；不阻塞主流程；Step 3 测试会一并 ping。
S.visionConfigured = false;
S.asrConfigured    = false;
S.ttsConfigured    = false;
S.visionProvider   = '';
S.asrProvider      = '';
S.ttsProvider      = '';

async function refreshOptional() {
  try {
    const r = await fetch('/api/setup/provider-status', { headers: authHeaders() });
    const d = await r.json();
    if (!d.ok) return;
    const v = d.data?.vision;
    const a = d.data?.asr;
    if (v) {
      S.visionConfigured = Boolean(v.active_configured);
      S.visionProvider   = v.active || '';
      const sel = document.getElementById('s2-vision-provider');
      if (sel.querySelector(`option[value="${v.active}"]`)) sel.value = v.active;
      document.getElementById('s2-vision-model').value = v.active_model || '';
      document.getElementById('s2-vision-state').textContent =
        v.active_configured ? `已启用：${v.active}（${v.active_model || '默认模型'}）` : '未配置';
      setS2CapSummary('vision', v.active_configured ? `${v.active}${v.active_model ? ' · ' + v.active_model : ''}` : '未配置', v.active_configured);
    }
    if (a) {
      S.asrConfigured = Boolean(a.active_configured);
      S.asrProvider   = a.active || '';
      const sel = document.getElementById('s2-asr-provider');
      if (sel.querySelector(`option[value="${a.active}"]`)) sel.value = a.active;
      document.getElementById('s2-asr-model').value = a.active_model || '';
      // 回填 ASR extras（azure region / doubao appid+cluster）
      if (a.extras) {
        if (a.extras.region)  document.getElementById('s2-asr-azure-region').value  = a.extras.region;
        if (a.extras.appid)   document.getElementById('s2-asr-doubao-appid').value  = a.extras.appid;
        if (a.extras.cluster) document.getElementById('s2-asr-doubao-cluster').value = a.extras.cluster;
      }
      document.getElementById('s2-asr-state').textContent =
        a.active_configured ? `已启用：${a.active}（${a.active_model || '默认模型'}）` : '未配置';
      setS2CapSummary('asr', a.active_configured ? `${a.active}${a.active_model ? ' · ' + a.active_model : ''}` : '未配置', a.active_configured);
      updateAsrProviderHints(sel.value);
    }
    for (const cap of ['vision', 'asr', 'tts', 'image', 'embedding']) {
      const section = d.data?.[cap];
      const custom = cap === 'tts' ? section?.custom : section?.providers?.custom;
      document.getElementById(`s2-${cap}-base`).value = custom?.base_url || '';
      if (cap === 'image' || cap === 'embedding') {
        document.getElementById(`s2-${cap}-provider`).value = section?.active === 'custom' ? 'custom' : '';
        document.getElementById(`s2-${cap}-model`).value = custom?.model || '';
        document.getElementById(`s2-${cap}-state`).textContent = `当前：${section?.active || '未启用'}${section?.active_configured ? ' · 已配置' : ''}`;
        setS2CapSummary(cap, section?.active ? `${section.active}${section.active_configured ? ' · 已配置' : ''}` : '默认 / 未配置', section?.active_configured);
      }
    }
    const s = d.data?.search;
    if (s) {
      refreshSearchUI(s.active, s.active_configured, s.providers);
      setS2CapSummary('search', s.active_configured ? `${s.active}` : '未配置', s.active_configured);
    }
    const t = d.data?.tts;
    if (t) {
      S.ttsConfigured = Boolean(t.configured);
      S.ttsProvider   = t.active || '';
      const sel = document.getElementById('s2-tts-provider');
      if (sel.querySelector(`option[value="${t.active}"]`)) sel.value = t.active;
      document.getElementById('s2-tts-model').value = t.model || '';
      document.getElementById('s2-tts-voice-id').value = t.voice_id || '';
      // 回填额外字段（azure region / doubao appid+cluster）
      if (t.extras) {
        if (t.extras.region) document.getElementById('s2-tts-azure-region').value = t.extras.region;
        if (t.extras.appid)  document.getElementById('s2-tts-doubao-appid').value = t.extras.appid;
        if (t.extras.cluster) document.getElementById('s2-tts-doubao-cluster').value = t.extras.cluster;
      }
      document.getElementById('s2-tts-state').textContent =
        t.configured ? `已启用：${t.active}（${t.model || '默认'} · ${t.voice_id || 'default'}）` : '未配置';
      setS2CapSummary('tts', t.configured ? `${t.active}${t.voice_id || t.model ? ' · ' + (t.voice_id || t.model) : ''}` : '未配置', t.configured);
      updateTtsProviderHints(sel.value);
    }
    // 同步 Chat 摘要
    const chatInfo = d.data?.providers?.[d.data?.chat_provider];
    const chatOk = Boolean(chatInfo?.configured);
    setS2CapSummary('chat', chatOk ? `${chatInfo.label}${d.data?.chat_model ? ' · ' + d.data.chat_model : ''}` : '未配置', chatOk);
    for (const cap of ['vision', 'asr', 'tts', 'image', 'embedding']) updateCustomFields(cap);
  } catch {}
}

// ─── TTS Provider 切换：显示对应 provider 的额外字段 + 占位提示 ──────────────
const TTS_VOICE_HINTS = {
  minimax: 'MiniMax 默认 female-tianmei；可改 male-* 或克隆音色 ID',
  openai:  '6 选：alloy / echo / fable / onyx / nova / shimmer（默认 nova）',
  azure:   '如 zh-CN-XiaoxiaoNeural / zh-CN-YunxiNeural（默认 Xiaoxiao）',
  doubao:  '如 BV700_streaming / BV001_streaming（火山引擎控制台音色列表）',
  qwen:    '如 longxiaochun / longjingjing / longwan（CosyVoice 音色）',
  fish:    'Fish reference_id（可选）；留空时使用 Fish 默认声音行为',
};
const TTS_MODEL_HINTS = {
  fish: '默认 s2.1-pro-free；也可填 s2.1-pro、s1 或 Fish 账户可用的其他模型 ID',
};
const TTS_KEY_LABELS = {
  minimax: 'MiniMax API Key',
  openai:  'OpenAI API Key（sk-...）',
  azure:   'Azure Speech Key',
  doubao:  '豆包 Access Token',
  qwen:    'DashScope API Key（sk-...）',
  fish:    'Fish Audio API Key',
};
function updateTtsProviderHints(provider) {
  const azureRow  = document.getElementById('s2-tts-azure-row');
  const doubaoRow = document.getElementById('s2-tts-doubao-row');
  const hintEl    = document.getElementById('s2-tts-voice-hint');
  const modelHint = document.getElementById('s2-tts-model-hint');
  const voiceLabel = document.getElementById('s2-tts-voice-label');
  const keyLabel  = document.getElementById('s2-tts-key-label');
  azureRow.classList.toggle('hidden',  provider !== 'azure');
  doubaoRow.classList.toggle('hidden', provider !== 'doubao');
  hintEl.textContent = TTS_VOICE_HINTS[provider] || '';
  modelHint.textContent = TTS_MODEL_HINTS[provider] || '';
  voiceLabel.textContent = provider === 'fish' ? 'Reference ID（可选）' : 'Voice ID（选填）';
  keyLabel.textContent = TTS_KEY_LABELS[provider] || 'API Key';
}
document.getElementById('s2-tts-provider').addEventListener('change', e => {
  updateTtsProviderHints(e.target.value);
});

// ─── ASR Provider 切换：显示额外字段 + model 占位提示 ────────────────────────
const ASR_MODEL_HINTS = {
  openai:  '默认 whisper-1；可填 gpt-4o-mini-transcribe / gpt-4o-transcribe（更准）',
  groq:    '默认 whisper-large-v3；可填 whisper-large-v3-turbo 等',
  qwen:    '默认 paraformer-v2',
  azure:   '此处填语言代码，默认 zh-CN；可改 en-US / ja-JP 等',
  doubao:  '豆包一句话识别无 model 概念',
  minimax: '默认 speech-01',
  gemini:  '默认 gemini-2.5-flash',
};
function updateAsrProviderHints(provider) {
  const azureRow  = document.getElementById('s2-asr-azure-row');
  const doubaoRow = document.getElementById('s2-asr-doubao-row');
  const hintEl    = document.getElementById('s2-asr-model-hint');
  azureRow.classList.toggle('hidden',  provider !== 'azure');
  doubaoRow.classList.toggle('hidden', provider !== 'doubao');
  hintEl.textContent = ASR_MODEL_HINTS[provider] || '';
}
document.getElementById('s2-asr-provider').addEventListener('change', e => {
  updateAsrProviderHints(e.target.value);
});

async function saveOptional(capability) {
  const prefix = `s2-${capability}`;
  const provider = document.getElementById(`${prefix}-provider`).value;
  const model    = document.getElementById(`${prefix}-model`).value.trim();
  const apiKey   = document.getElementById(`${prefix}-key`).value;
  const baseUrl = document.getElementById(`${prefix}-base`).value.trim();
  const voiceId  = capability === 'tts' ? document.getElementById('s2-tts-voice-id').value.trim() : '';
  const msgId    = `${prefix}-msg`;
  if (!provider) {
    setMsg(msgId, '请选择 Provider，或恢复环境配置', 'err');
    return;
  }
  // 各 provider 的额外字段（azure region / doubao appid+cluster），按 capability 取对应输入框
  const extras = {};
  if (capability === 'tts' || capability === 'asr') {
    if (provider === 'azure') {
      const regionId = capability === 'tts' ? 's2-tts-azure-region' : 's2-asr-azure-region';
      extras.region = document.getElementById(regionId).value.trim();
      // ASR azure 允许留空——后端会 fallback 到 TTS_AZURE_REGION（同 env var）
      if (capability === 'tts' && !extras.region) {
        setMsg(msgId, '请填 Azure Region（如 eastasia）', 'err'); return;
      }
    } else if (provider === 'doubao') {
      const appidId   = capability === 'tts' ? 's2-tts-doubao-appid'   : 's2-asr-doubao-appid';
      const clusterId = capability === 'tts' ? 's2-tts-doubao-cluster' : 's2-asr-doubao-cluster';
      extras.appid   = document.getElementById(appidId).value.trim();
      extras.cluster = document.getElementById(clusterId).value.trim();
      const defaultCluster = capability === 'tts' ? 'volcano_tts' : 'volcengine_input_common';
      if (!extras.appid)   { setMsg(msgId, '请填豆包 AppID', 'err'); return; }
      if (!extras.cluster) { setMsg(msgId, `请填 Cluster（一般 ${defaultCluster}）`, 'err'); return; }
    }
  }
  setMsg(msgId, '保存中…', 'info');
  try {
    const r = await fetch('/api/setup/provider-config', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ capability, provider, model, base_url: baseUrl, api_key: apiKey, voice_id: voiceId, extras }),
    });
    const d = await r.json();
    if (d.ok) {
      document.getElementById(`${prefix}-key`).value = '';
      const parts = [d.data.label || provider];
      if (d.data.model_saved) parts.push('含 Model');
      if (d.data.key_saved)   parts.push('含 API Key');
      setMsg(msgId, `✅ 已保存 ${parts.join(' · ')}`, 'ok');
      await refreshOptional();
    } else {
      setMsg(msgId, '❌ ' + (d.error || d.message || '保存失败'), 'err');
    }
  } catch (e) {
    setMsg(msgId, '❌ ' + e.message, 'err');
  }
}

async function clearOptional(capability) {
  const msgId = `s2-${capability}-msg`;
  setMsg(msgId, '清除中…', 'info');
  try {
    const r = await fetch('/api/setup/provider-config', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ capability, clear: true }),
    });
    const d = await r.json();
    if (d.ok) {
      setMsg(msgId, '✅ 已清除', 'ok');
      const prefix = `s2-${capability}`;
      document.getElementById(`${prefix}-provider`).value = '';
      document.getElementById(`${prefix}-model`).value = '';
      document.getElementById(`${prefix}-key`).value = '';
      if (capability === 'tts') {
        document.getElementById('s2-tts-voice-id').value = '';
        document.getElementById('s2-tts-azure-region').value = '';
        document.getElementById('s2-tts-doubao-appid').value = '';
        document.getElementById('s2-tts-doubao-cluster').value = '';
        updateTtsProviderHints('');
      } else if (capability === 'asr') {
        document.getElementById('s2-asr-azure-region').value = '';
        document.getElementById('s2-asr-doubao-appid').value = '';
        document.getElementById('s2-asr-doubao-cluster').value = '';
        updateAsrProviderHints('');
      }
      await refreshOptional();
    } else {
      setMsg(msgId, '❌ ' + (d.error || d.message || '清除失败'), 'err');
    }
  } catch (e) { setMsg(msgId, '❌ ' + e.message, 'err'); }
}

function updateCustomFields(cap) {
  document.getElementById(`s2-${cap}-base-row`).classList.toggle('hidden', document.getElementById(`s2-${cap}-provider`).value !== 'custom');
}
async function testOptional(cap) {
  const provider = document.getElementById(`s2-${cap}-provider`).value;
  const msgId = `s2-${cap}-msg`;
  if (!provider) { setMsg(msgId, '请先选择并保存 Provider', 'err'); return; }
  const button = document.getElementById(`s2-${cap}-test`);
  button.disabled = true;
  setMsg(msgId, '正在测试已保存配置（会实际调用服务）…', 'info');
  try {
    const response = await fetch('/api/setup/test-provider', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ capability: cap, provider }) });
    const result = await response.json();
    const success = result.ok && result.data?.ok;
    setMsg(msgId, success ? `✅ 连接成功 · ${result.data.latency_ms || 0} ms` : `❌ ${result.error || result.message || '连接失败'}`, success ? 'ok' : 'err');
  } catch { setMsg(msgId, '连接测试失败，请检查网络后重试', 'err'); }
  finally { button.disabled = false; }
}
for (const cap of ['vision', 'asr', 'tts', 'image', 'embedding']) {
  document.getElementById(`s2-${cap}-save`).addEventListener('click', () => saveOptional(cap));
  document.getElementById(`s2-${cap}-clear`).addEventListener('click', () => clearOptional(cap));
  document.getElementById(`s2-${cap}-test`).addEventListener('click', () => testOptional(cap));
  document.getElementById(`s2-${cap}-provider`).addEventListener('change', () => updateCustomFields(cap));
}

// ─── 联网搜索（search） ───────────────────────────────────────────────────
S.searchConfigured = false;
S.searchProvider   = '';

function refreshSearchUI(activeProvider, configured, providersMap) {
  S.searchConfigured = Boolean(configured);
  S.searchProvider   = activeProvider || '';
  const sel = document.getElementById('s2-search-provider');
  if (sel && sel.querySelector(`option[value="${activeProvider}"]`)) sel.value = activeProvider;
  document.getElementById('s2-search-state').textContent =
    configured ? `已启用：${activeProvider}` : '未配置';
  toggleSearchInputs(sel?.value || '');
  // 回显 base_url（已登录时返回）
  if (activeProvider === 'searxng' && providersMap?.searxng?.base_url) {
    document.getElementById('s2-search-baseurl').value = providersMap.searxng.base_url;
  }
}

function toggleSearchInputs(providerId) {
  const isSearxng = providerId === 'searxng';
  document.getElementById('s2-search-baseurl-row').classList.toggle('hidden', !isSearxng);
  // SearXNG 不需要 API key
  document.getElementById('s2-search-key-row').classList.toggle('hidden', isSearxng);
}

document.getElementById('s2-search-provider').addEventListener('change', (e) => {
  toggleSearchInputs(e.target.value);
});

async function saveSearch() {
  const provider = document.getElementById('s2-search-provider').value;
  if (!provider) {
    setMsg('s2-search-msg', '请选择 Provider，或点"清除"关闭', 'err');
    return;
  }
  const payload = { capability: 'search', provider };
  if (provider === 'searxng') {
    const baseUrl = document.getElementById('s2-search-baseurl').value.trim();
    if (!baseUrl) { setMsg('s2-search-msg', '请填写 Base URL', 'err'); return; }
    if (!/^https?:\/\//i.test(baseUrl)) { setMsg('s2-search-msg', 'Base URL 必须 http(s):// 开头', 'err'); return; }
    payload.base_url = baseUrl;
  } else {
    payload.api_key = document.getElementById('s2-search-key').value;
  }
  setMsg('s2-search-msg', '保存中…', 'info');
  try {
    const r = await fetch('/api/setup/provider-config', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (d.ok) {
      document.getElementById('s2-search-key').value = '';
      const parts = [d.data.label || provider];
      if (d.data.key_saved)      parts.push('含 API Key');
      if (d.data.base_url_saved) parts.push('Base URL');
      setMsg('s2-search-msg', `✅ 已保存 ${parts.join(' · ')}`, 'ok');
      await refreshOptional();
    } else {
      setMsg('s2-search-msg', '❌ ' + (d.error || d.message || '保存失败'), 'err');
    }
  } catch (e) { setMsg('s2-search-msg', '❌ ' + e.message, 'err'); }
}

async function clearSearch() {
  setMsg('s2-search-msg', '清除中…', 'info');
  try {
    const r = await fetch('/api/setup/provider-config', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ capability: 'search', clear: true }),
    });
    const d = await r.json();
    if (d.ok) {
      document.getElementById('s2-search-provider').value = '';
      document.getElementById('s2-search-baseurl').value = '';
      document.getElementById('s2-search-key').value = '';
      toggleSearchInputs('');
      setMsg('s2-search-msg', '✅ 已清除', 'ok');
      await refreshOptional();
    } else {
      setMsg('s2-search-msg', '❌ ' + (d.error || d.message || '清除失败'), 'err');
    }
  } catch (e) { setMsg('s2-search-msg', '❌ ' + e.message, 'err'); }
}

document.getElementById('s2-search-save').addEventListener('click', saveSearch);
document.getElementById('s2-search-clear').addEventListener('click', clearSearch);
document.getElementById('s2-search-test')?.addEventListener('click', async () => {
  const provider = document.getElementById('s2-search-provider').value;
  if (!provider) { setMsg('s2-search-msg', '请先选择并保存 Provider', 'err'); return; }
  const btn = document.getElementById('s2-search-test');
  btn.disabled = true;
  setMsg('s2-search-msg', '正在测试联网搜索连通性…', 'info');
  try {
    const r = await fetch('/api/setup/test-provider', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ capability: 'search', provider }),
    });
    const d = await r.json();
    if (d.ok && d.data?.ok) {
      setMsg('s2-search-msg', `✅ 连接成功 · ${d.data.latency_ms ?? 0} ms`, 'ok');
    } else {
      setMsg('s2-search-msg', '❌ ' + (d.data?.error || d.error || d.message || '连接失败'), 'err');
    }
  } catch {
    setMsg('s2-search-msg', '❌ 连接测试失败，请检查网络后重试', 'err');
  } finally {
    btn.disabled = false;
  }
});

// ─── Step 3 ───────────────────────────────────────────────────────────────
function refreshStep3() {
  // 刷新 provider 名称
  const nameEl = document.getElementById('s3-provider-name');
  if (nameEl && S.activeProvider) nameEl.textContent = S.activeProvider;
  // 显示"跳过"按钮（provider 已保存才显示）
  const skipBtn = document.getElementById('s3-btn-skip');
  if (skipBtn) skipBtn.style.display = S.providerSaved ? 'inline-block' : 'none';
  // 重置测试按钮状态
  document.getElementById('s3-btn-test').disabled = false;
  // 如果已通过则解锁下一步
  updateStep3NextBtn();
}

function updateStep3NextBtn() {
  const can  = S.testPassed || S.testSkipped;
  const btn  = document.getElementById('s3-btn-next');
  const hint = document.getElementById('s3-next-hint');
  btn.disabled  = !can;
  hint.style.display = can ? 'none' : 'inline';
}

document.getElementById('s3-btn-test').addEventListener('click', async () => {
  const btn = document.getElementById('s3-btn-test');
  btn.disabled = true;
  setMsg('s3-msg', '测试中（向 provider 发一次 ping）…', 'info');

  const token = getToken();
  if (!token) {
    setMsg('s3-msg', '会话已失效，请刷新页面重新登录', 'err');
    btn.disabled = false;
    return;
  }
  // 收集所有要测试的项：chat（必测）+ 已配 vision + 已配 asr
  const items = [];
  let provider = S.activeProvider;
  if (!provider) {
    try {
      const sr = await fetch('/api/setup/status');
      const sd = await sr.json();
      provider = sd.data?.chat_provider || 'deepseek';
      S.activeProvider = provider;
    } catch {}
  }
  items.push({ capability: 'chat', provider, label: 'Chat（' + provider + '）' });
  if (S.visionConfigured && S.visionProvider) {
    items.push({ capability: 'vision', provider: S.visionProvider, label: '图片理解（' + S.visionProvider + '）' });
  }
  if (S.asrConfigured && S.asrProvider) {
    items.push({ capability: 'asr', provider: S.asrProvider, label: '语音识别（' + S.asrProvider + '）' });
  }
  if (S.searchConfigured && S.searchProvider) {
    items.push({ capability: 'search', provider: S.searchProvider, label: '联网搜索（' + S.searchProvider + '）' });
  }

  // 渲染待测项
  const resultsEl = document.getElementById('s3-results');
  resultsEl.innerHTML = '';
  const rowEls = items.map((it) => {
    const row = document.createElement('div');
    row.className = 'p-3 rounded-xl bg-cloud text-[13px] flex items-center justify-between';
    row.innerHTML = `<span><b>${it.label}</b></span><span class="text-mute">⏳ 测试中…</span>`;
    resultsEl.appendChild(row);
    return row;
  });

  let allChatOk = false;
  let anyFail   = false;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      const r = await fetch('/api/setup/test-provider', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ provider: it.provider, capability: it.capability }),
      });
      if (r.status === 401 || r.status === 403) {
        setMsg('s3-msg', '会话已失效，请刷新页面重新登录。', 'err');
        btn.disabled = false;
        return;
      }
      const d = await r.json();
      const okFlag = d.ok && d.data?.ok;
      const detail = okFlag
        ? `✅ ${d.data.latency_ms ?? '--'}ms${d.data.warn ? ' (' + d.data.warn + ')' : ''}`
        : '❌ ' + (d.data?.error || d.error || d.message || '失败').slice(0, 80);
      rowEls[i].lastElementChild.textContent = detail;
      rowEls[i].lastElementChild.className = okFlag ? 'msg-ok' : 'msg-err';
      if (okFlag && it.capability === 'chat') allChatOk = true;
      if (!okFlag) anyFail = true;
    } catch (e) {
      rowEls[i].lastElementChild.textContent = '❌ ' + e.message;
      rowEls[i].lastElementChild.className = 'msg-err';
      anyFail = true;
    }
  }

  if (allChatOk) {
    S.testPassed = true;
    setMsg('s3-msg', anyFail
      ? '主 Chat Provider 连通成功；个别可选能力失败，可回 Step 2 修一下或继续。'
      : '✅ 全部连通成功！', anyFail ? 'warn' : 'ok');
    updateStep3NextBtn();
  } else {
    setMsg('s3-msg', '❌ Chat Provider 连通失败，请检查 API Key 或点击"跳过测试"。', 'err');
  }
  btn.disabled = false;
});

document.getElementById('s3-btn-skip').addEventListener('click', () => {
  if (!S.providerSaved) return;
  S.testSkipped = true;
  setMsg('s3-msg', '已跳过测试，将继续创建角色。', 'warn');
  updateStep3NextBtn();
});

document.getElementById('s3-btn-back').addEventListener('click', () => goStep(2));
document.getElementById('s3-btn-next').addEventListener('click', () => {
  if (S.testPassed || S.testSkipped) goStep(4);
});

// ─── Step 4 ───────────────────────────────────────────────────────────────
// 检查是否已有角色
async function checkExistingRole() {
  try {
    const r = await fetch('/api/me/companion', { headers: { Authorization: `Bearer ${getToken()}` } });
    const d = await r.json();
    if (d.ok && d.data?.companion) {
      show('s4-existing');
    }
  } catch {}
}

document.getElementById('s4-btn-back').addEventListener('click', () => goStep(3));
document.getElementById('s4-btn-done').addEventListener('click', () => goStep(5));
document.getElementById('s4-btn-skip').addEventListener('click', () => goStep(5));

// ─── Step 5：微信绑定（嵌入式扫码） ───────────────────────────────────────
// 与 /app/bind.html 走同一套 API：POST /api/wechat/bind-session（rebind=true，
// 兼容首次绑定与重新绑定）；轮询 GET /api/wechat/bind-session/:id 拿 status。
const Bind = {
  sessionId: null,
  pollTimer: null,
  expireTimer: null,
  expireAtMs: 0,
};
function bindShow(state) {
  for (const id of ['s5-idle','s5-active','s5-done']) {
    document.getElementById(id).classList.toggle('hidden', `s5-${state}` !== id);
  }
}
function bindStopTimers() {
  if (Bind.pollTimer)   { clearTimeout(Bind.pollTimer);    Bind.pollTimer = null; }
  if (Bind.expireTimer) { clearInterval(Bind.expireTimer); Bind.expireTimer = null; }
}
function bindMsg(text, kind = 'info') {
  const el = document.getElementById('s5-status');
  el.className = 'mt-3 msg-' + kind;
  el.textContent = text;
}
function bindUpdateExpire() {
  const el = document.getElementById('s5-expire');
  if (!Bind.expireAtMs) { el.textContent = ''; return; }
  const sec = Math.max(0, Math.floor((Bind.expireAtMs - Date.now()) / 1000));
  el.textContent = sec > 0 ? `二维码 ${sec}s 后过期` : '二维码已过期，请刷新';
  if (sec <= 0) bindStopTimers();
}
async function bindStart() {
  bindStopTimers();
  const userId = S.user?.id;
  if (!userId) {
    bindShow('idle');
    setMsg('init-msg', '请先登录后再绑定微信', 'err');
    return;
  }
  bindShow('active');
  bindMsg('生成二维码中…', 'info');
  try {
    const r = await fetch('/api/wechat/bind-session', {
      method: 'POST',
      headers: authHeaders({ 'x-user-id': String(userId) }),
      cache: 'no-store',
      body: JSON.stringify({ user_id: userId, rebind: true }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      // 服务端未配 iLink 时给一个友好提示，让用户跳过
      const msg = d.message || d.error || '生成失败';
      bindShow('idle');
      const idle = document.getElementById('s5-idle');
      const hint = document.createElement('p');
      hint.className = 'mt-2 msg-err';
      hint.textContent = '微信功能未启用或暂不可用：' + msg + '。建议跳过此步骤，直接进入控制台。';
      // 避免重复
      idle.querySelectorAll('.msg-err').forEach(n => n.remove());
      idle.appendChild(hint);
      return;
    }
    const p = d.data || d;
    Bind.sessionId   = p.session_id;
    Bind.expireAtMs  = Date.now() + Number(p.expires_in || 300) * 1000;
    document.getElementById('s5-qr-img').src = p.qr_base64 || p.qr_url || '';
    bindMsg('扫码并在手机上点「确认登录」', 'info');
    bindUpdateExpire();
    Bind.expireTimer = setInterval(bindUpdateExpire, 1000);
    bindPoll();
  } catch (e) {
    bindShow('idle');
    setMsg('init-msg', '微信绑定请求失败：' + e.message, 'err');
  }
}
async function bindPoll() {
  if (!Bind.sessionId) return;
  try {
    const r = await fetch('/api/wechat/bind-session/' + encodeURIComponent(Bind.sessionId) + '?rebind=true',
      { headers: authHeaders(), cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    const status = d.data?.status || 'pending';
    if (status === 'success') {
      bindStopTimers();
      bindShow('done');
      return;
    }
    if (status === 'scanned') bindMsg('已扫码，等待手机确认…', 'info');
    else if (status === 'expired') { bindStopTimers(); bindShow('idle'); return; }
    Bind.pollTimer = setTimeout(bindPoll, 2500);
  } catch {
    Bind.pollTimer = setTimeout(bindPoll, 4000);
  }
}
document.getElementById('s5-btn-back').addEventListener('click', () => { bindStopTimers(); goStep(4); });
document.getElementById('s5-btn-start').addEventListener('click', bindStart);
document.getElementById('s5-btn-refresh').addEventListener('click', bindStart);
document.getElementById('s5-btn-skip').addEventListener('click', () => {
  bindStopTimers();
  window.location.href = '/app/dashboard.html';
});

// ─── 状态 A：创建本地账号 ─────────────────────────────────────────────────
document.getElementById('init-btn').addEventListener('click', async () => {
  const username = document.getElementById('init-username').value.trim();
  const password = document.getElementById('init-password').value;
  if (!username) { setMsg('init-msg', '请填写用户名', 'err'); return; }
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    setMsg('init-msg', '用户名只能包含字母、数字、下划线（3–32 位）', 'err');
    return;
  }
  if (password.length < 6) { setMsg('init-msg', '本地登录密码至少 6 位', 'err'); return; }
  setMsg('init-msg', '创建中…', 'info');
  document.getElementById('init-btn').disabled = true;
  try {
    const r = await fetch('/api/setup/local-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const d = await r.json();
    if (d.ok && d.token) {
      saveToken(d.token);
      saveUser(d.user);  // ← 让 /app/create.html 等页面不会以为没登录而跳 auth
      setMsg('init-msg', '✅ 账号创建成功，即将进入配置向导…', 'ok');
      // 更新状态，不刷新页面
      S.authenticated = true;
      S.initialized   = true;
      S.user          = d.user;
      setTimeout(() => renderView(), 600);
    } else {
      setMsg('init-msg', '❌ ' + (d.message || '创建失败'), 'err');
      document.getElementById('init-btn').disabled = false;
    }
  } catch (e) {
    setMsg('init-msg', '❌ ' + e.message, 'err');
    document.getElementById('init-btn').disabled = false;
  }
});

// ─── 初始化：加载状态 ─────────────────────────────────────────────────────
(async function init() {
  showView('view-loading');
  try {
    const token = getToken();
    const meHeaders = token ? { Authorization: `Bearer ${token}` } : {};
    const [statusRes, meRes] = await Promise.all([
      fetch('/api/setup/status'),
      fetch('/api/auth/me', { headers: meHeaders }),
    ]);
    const statusData = await statusRes.json();
    const meData     = await meRes.json();

    // 解析 setup/status（auth_mode、initialized 由本轮 api.mjs 新增）
    S.authMode      = statusData.data?.auth_mode || 'local';
    S.initialized   = statusData.data?.initialized || false;
    S.providerSaved = statusData.data?.configured || false;
    S.activeProvider= statusData.data?.chat_provider || '';

    // 解析 auth/me
    S.authenticated = meData.data?.authenticated || false;
    S.user          = meData.data?.user || null;
  } catch {
    // 网络异常时降级：显示加载错误
    document.getElementById('view-loading').textContent = '加载失败，请刷新页面重试。';
    return;
  }
  renderView();
  // 如果进入向导且 Step 4，顺带检查角色
  if (S.authenticated) checkExistingRole();
})();
