/* 溪语 AI · 模型设置抽屉逻辑（Master-Detail：一竖列能力 + 点击弹出配置详情与连通性测试） */
(function () {
  const CAP_META = {
    chat: {
      title: '💬 对话模型 Chat',
      desc: '核心对话大模型（必配）。支持主流云厂商及 OpenAI 兼容中转网关。',
    },
    vision: {
      title: '🖼️ 图片理解 Vision',
      desc: '让 AI 看懂你发来的照片与截图。不配也能正常聊天，只是发图时无法识别。',
      options: [
        ['', '不启用'],
        ['custom', '自定义 OpenAI 兼容中转'],
        ['zhipu', '智谱 GLM-4V'],
        ['openai', 'OpenAI gpt-4o-mini'],
        ['qwen', '通义千问 VL'],
        ['doubao', '豆包视觉 (Ark)'],
        ['anthropic', 'Anthropic Claude'],
        ['kimi', 'Kimi（Moonshot）vision'],
        ['stepfun', 'StepFun step-1v'],
        ['minimax', 'MiniMax abab vision（key 与 TTS 复用）'],
      ],
    },
    asr: {
      title: '🎙️ 语音识别 ASR',
      desc: '让 AI 听懂你发来的语音消息，自动转为文字并理解情绪。',
      options: [
        ['', '不启用'],
        ['custom', '自定义 OpenAI 兼容中转'],
        ['gemini', 'Google Gemini'],
        ['openai', 'OpenAI Whisper / gpt-4o-transcribe'],
        ['qwen', '通义千问 paraformer'],
        ['groq', 'Groq Whisper-large-v3（速度快 · 免费额度）'],
        ['minimax', 'MiniMax ASR（key 与 TTS 复用）'],
        ['azure', 'Azure Speech-to-Text（需 Region）'],
        ['doubao', '豆包 ASR 一句话识别（需 AppID + Cluster）'],
      ],
      modelHints: {
        openai: '默认 whisper-1；可填 gpt-4o-mini-transcribe / gpt-4o-transcribe',
        groq: '默认 whisper-large-v3；可填 whisper-large-v3-turbo',
        qwen: '默认 paraformer-v2',
        azure: '填语言代码，默认 zh-CN；可改 en-US / ja-JP',
        doubao: '豆包一句话识别无 model 概念',
        minimax: '默认 speech-01',
        gemini: '默认 gemini-2.5-flash',
      },
    },
    tts: {
      title: '🔊 语音合成 TTS',
      desc: '开启后她在网页 / Playground / 日记里的回复都可以朗读播放。',
      options: [
        ['', '不启用'],
        ['custom', '自定义 OpenAI 兼容中转'],
        ['minimax', 'MiniMax speech-02-turbo（推荐）'],
        ['openai', 'OpenAI tts-1 / tts-1-hd'],
        ['azure', 'Azure Speech（需 Region）'],
        ['doubao', '豆包 TTS（需 AppID + Cluster）'],
        ['qwen', '通义 CosyVoice / Qwen-TTS'],
        ['fish', 'Fish Audio（原生 TTS · 需 API Key）'],
      ],
      voiceHints: {
        minimax: 'MiniMax 默认 female-tianmei；可填克隆音色 ID',
        openai: '可选 alloy / echo / fable / onyx / nova / shimmer（默认 nova）',
        azure: '如 zh-CN-XiaoxiaoNeural / zh-CN-YunxiNeural',
        doubao: '如 BV700_streaming / BV001_streaming',
        qwen: '如 longxiaochun / longjingjing / longwan',
        fish: 'Fish reference_id（可选）；留空使用默认声音行为',
      },
      modelHints: {
        fish: '默认 s2.1-pro-free；也可填 s2.1-pro、s1 等模型 ID',
      },
      keyLabels: {
        minimax: 'MiniMax API Key',
        openai: 'OpenAI API Key（sk-...）',
        azure: 'Azure Speech Key',
        doubao: '豆包 Access Token',
        qwen: 'DashScope API Key（sk-...）',
        fish: 'Fish Audio API Key',
      },
    },
    image: {
      title: '🎨 图片生成 Image',
      desc: '用于头像精选、场景照与日常自拍生成。支持 OpenAI 兼容中转或 .env 默认配置。',
      options: [
        ['', '使用现有环境配置'],
        ['custom', '自定义 OpenAI 兼容中转'],
      ],
    },
    embedding: {
      title: '🧭 语义向量 Embedding',
      desc: '用于长期记忆的语义召回与去重。支持 OpenAI 兼容中转或 .env 默认配置。',
      options: [
        ['', '使用现有环境配置'],
        ['custom', '自定义 OpenAI 兼容中转'],
      ],
    },
    search: {
      title: '🌐 联网搜索 Search',
      desc: '开启后，遇到「最近 / 今天的 xxx」类问题时会自动联网查询后再回复。',
      options: [
        ['', '不启用'],
        ['tavily', 'Tavily · 推荐（送 1000 次/月）'],
        ['brave', 'Brave Search（送 2000 次/月）'],
        ['serpapi', 'SerpAPI（送 100 次/月）'],
        ['searxng', 'SearXNG · 自托管'],
      ],
    },
  };

  const MS = {
    data: null,
    providers: {},
    activeChat: '',
    activeChatModel: '',
    selectedCap: null,
  };

  const layoutEl    = document.getElementById('ms-layout');
  const detailEl    = document.getElementById('ms-detail');
  const detailClose = document.getElementById('ms-detail-close');
  const navItems    = Array.from(document.querySelectorAll('#ms-cap-list .ms-nav-item'));

  if (!layoutEl || !detailEl) return;

  function placeDetailForViewport() {
    if (!MS.selectedCap) {
      if (detailEl.parentNode !== layoutEl) layoutEl.appendChild(detailEl);
      return;
    }
    // 手风琴展开：始终紧贴当前点击项的正下方原地展开，再次点击折叠
    const activeBtn = navItems.find(b => b.dataset.cap === MS.selectedCap);
    if (activeBtn && detailEl.previousElementSibling !== activeBtn) {
      activeBtn.insertAdjacentElement('afterend', detailEl);
    }
  }

  function tokenHeaders() {
    const token = localStorage.getItem('xiyu_token') || '';
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  }

  function isCustomChat(id) { return id === 'openai-compatible'; }

  detailClose?.addEventListener('click', () => selectCap(null));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && MS.selectedCap) selectCap(null);
  });

  navItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      const cap = btn.dataset.cap;
      selectCap(MS.selectedCap === cap ? null : cap);
    });
  });

  function selectCap(cap) {
    MS.selectedCap = cap || null;
    navItems.forEach((btn) => {
      const active = btn.dataset.cap === MS.selectedCap;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-expanded', active ? 'true' : 'false');
    });
    if (!MS.selectedCap) {
      detailEl.hidden = true;
      placeDetailForViewport();
      return;
    }
    placeDetailForViewport();
    detailEl.hidden = false;
    renderDetail(MS.selectedCap);
    setTimeout(() => {
      const r = detailEl.getBoundingClientRect();
      if (r.top < 80 || r.top > window.innerHeight - 100) {
        detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 40);
  }

  function setMsg(elId, text, kind = 'info') {
    const el = document.getElementById(elId);
    if (!el) return;
    el.className = 'mt-3 ms-msg-' + kind;
    el.textContent = text;
  }

  function setNavStatus(cap, subText, configured) {
    const sub = document.getElementById('ms-nav-sub-' + cap);
    const dot = document.getElementById('ms-nav-dot-' + cap);
    if (sub) sub.textContent = subText;
    if (dot) dot.classList.toggle('on', Boolean(configured));
  }

  function capStatusInfo(cap) {
    const d = MS.data || {};
    if (cap === 'chat') {
      const activeInfo = MS.providers[MS.activeChat];
      const ok = Boolean(activeInfo?.configured);
      const label = activeInfo?.label || MS.activeChat || '未配置';
      const sub = ok ? (d.chat_model ? `${label} · ${d.chat_model}` : label) : '未配置';
      return { ok, sub, badge: ok ? '已配置' : '未配置' };
    }
    const sec = d[cap] || {};
    if (cap === 'tts') {
      const ok = Boolean(sec.configured);
      const sub = ok
        ? `${sec.active}${sec.voice_id || sec.model ? ' · ' + (sec.voice_id || sec.model) : ''}`
        : (sec.active ? `${sec.active}（未配齐）` : '未启用');
      return { ok, sub, badge: ok ? '已启用' : '未启用' };
    }
    if (cap === 'image' || cap === 'embedding') {
      const ok = Boolean(sec.active_configured);
      const sub = sec.active ? `${sec.active}${ok ? ' · 已配置' : ''}` : '默认环境 / 未配置';
      return { ok, sub, badge: ok ? '已配置' : '默认/未配' };
    }
    const ok = Boolean(sec.active_configured);
    const sub = ok ? `${sec.active}${sec.active_model ? ' · ' + sec.active_model : ''}` : '未启用';
    return { ok, sub, badge: ok ? '已启用' : '未启用' };
  }

  function refreshNavBadges() {
    for (const cap of ['chat', 'vision', 'asr', 'tts', 'image', 'embedding', 'search']) {
      const info = capStatusInfo(cap);
      setNavStatus(cap, info.sub, info.ok);
    }
  }

  async function refreshAll() {
    try {
      const r = await fetch('/api/setup/provider-status', { headers: tokenHeaders() });
      const d = await r.json();
      if (!d.ok) {
        if (MS.selectedCap === 'chat') setMsg('ms-chat-msg', '加载失败：' + (d.message || ''), 'err');
        return;
      }
      MS.data = d.data || {};
      MS.providers = MS.data.providers || {};
      MS.activeChat = MS.data.chat_provider || '';
      MS.activeChatModel = MS.data.chat_model_override || '';
      refreshNavBadges();
      if (MS.selectedCap) renderDetail(MS.selectedCap);
    } catch (e) {
      if (MS.selectedCap === 'chat') setMsg('ms-chat-msg', '加载失败：' + e.message, 'err');
    }
  }

  window.XiyuModelPanel = { refresh: refreshAll };

  function renderDetail(cap) {
    const meta = CAP_META[cap];
    if (!meta) return;
    const status = capStatusInfo(cap);
    document.getElementById('ms-detail-title').textContent = meta.title;
    document.getElementById('ms-detail-desc').textContent = meta.desc;
    const badge = document.getElementById('ms-detail-badge');
    badge.textContent = status.badge;
    badge.className = 'ms-status-chip ' + (status.ok ? 'ms-status-ok' : 'ms-status-off');

    const chatPane = document.getElementById('ms-pane-chat');
    const optPane  = document.getElementById('ms-pane-opt');
    if (cap === 'chat') {
      chatPane.classList.remove('hidden');
      optPane.classList.add('hidden');
      renderChatSection();
    } else {
      chatPane.classList.add('hidden');
      optPane.classList.remove('hidden');
      renderOptionalDetail(cap);
    }
  }

  // ─── Chat Detail ──────────────────────────────────────────────────────────
  function renderChatSection() {
    const sel = document.getElementById('ms-chat-provider');
    sel.innerHTML = '<option value="">请选择…</option>';
    for (const [id, info] of Object.entries(MS.providers)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = info.label + (id === MS.activeChat ? ' · 当前' : '');
      sel.appendChild(opt);
    }
    sel.value = MS.activeChat || '';
    renderChatModelRow(MS.activeChat, MS.activeChatModel);
    if (isCustomChat(MS.activeChat)) {
      const activeInfo = MS.providers[MS.activeChat];
      document.getElementById('ms-chat-baseurl').value = activeInfo?.base_url || '';
      document.getElementById('ms-chat-custom-model').value = activeInfo?.model || '';
    }
    document.getElementById('ms-chat-key').value = '';
    setMsg('ms-chat-msg', '', 'info');
  }

  function renderChatModelRow(providerId, presetModel) {
    const modelRow = document.getElementById('ms-chat-model-row');
    const customRow = document.getElementById('ms-chat-custom-row');
    modelRow.classList.add('hidden');
    customRow.classList.add('hidden');
    if (!providerId) return;
    if (isCustomChat(providerId)) {
      customRow.classList.remove('hidden');
      return;
    }
    const info = MS.providers[providerId] || {};
    const models = Array.isArray(info.models) ? info.models : [];
    const defaultModel = info.default_model || '';
    const sel = document.getElementById('ms-chat-model-select');
    const input = document.getElementById('ms-chat-model-custom');
    sel.innerHTML = '';
    const optD = document.createElement('option');
    optD.value = '__default__';
    optD.textContent = defaultModel ? `使用默认（${defaultModel}）` : '使用默认';
    sel.appendChild(optD);
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m === defaultModel ? `${m} · 默认` : m;
      sel.appendChild(o);
    }
    const optC = document.createElement('option');
    optC.value = '__custom__';
    optC.textContent = '自定义模型 ID…';
    sel.appendChild(optC);

    if (presetModel && presetModel !== defaultModel) {
      if (models.includes(presetModel)) {
        sel.value = presetModel;
        input.value = '';
        input.classList.add('hidden');
      } else {
        sel.value = '__custom__';
        input.value = presetModel;
        input.classList.remove('hidden');
      }
    } else {
      sel.value = '__default__';
      input.value = '';
      input.classList.add('hidden');
    }
    modelRow.classList.remove('hidden');
  }

  document.getElementById('ms-chat-provider').addEventListener('change', (e) => {
    const id = e.target.value;
    renderChatModelRow(id, '');
    if (isCustomChat(id)) {
      const info = MS.providers[id] || {};
      document.getElementById('ms-chat-baseurl').value = info.base_url || '';
      document.getElementById('ms-chat-custom-model').value = info.model || '';
    }
  });

  document.getElementById('ms-chat-model-select').addEventListener('change', (e) => {
    const input = document.getElementById('ms-chat-model-custom');
    if (e.target.value === '__custom__') {
      input.classList.remove('hidden');
      input.focus();
    } else {
      input.classList.add('hidden');
    }
  });

  function readChosenChatModel() {
    const sel = document.getElementById('ms-chat-model-select');
    if (sel.parentElement.classList.contains('hidden')) return undefined;
    const v = sel.value;
    if (v === '__default__') return '';
    if (v === '__custom__') return document.getElementById('ms-chat-model-custom').value.trim();
    return v;
  }

  document.getElementById('ms-chat-save').addEventListener('click', async () => {
    const provider = document.getElementById('ms-chat-provider').value;
    if (!provider) { setMsg('ms-chat-msg', '请先选 Provider', 'err'); return; }
    const apiKey = document.getElementById('ms-chat-key').value;
    const payload = { chat_provider: provider, api_key: apiKey };
    if (isCustomChat(provider)) {
      const baseUrl = document.getElementById('ms-chat-baseurl').value.trim();
      const model = document.getElementById('ms-chat-custom-model').value.trim();
      if (!baseUrl) { setMsg('ms-chat-msg', '请填 Base URL', 'err'); return; }
      if (!/^https?:\/\//i.test(baseUrl)) { setMsg('ms-chat-msg', 'Base URL 必须 http(s)://', 'err'); return; }
      if (!model) { setMsg('ms-chat-msg', '请填 Model', 'err'); return; }
      payload.base_url = baseUrl;
      payload.model = model;
    } else {
      const chosen = readChosenChatModel();
      if (chosen !== undefined) {
        payload.model = chosen;
        if (chosen === '') payload.clear_model = true;
      }
    }
    setMsg('ms-chat-msg', '保存中…', 'info');
    try {
      const r = await fetch('/api/setup/provider-config', {
        method: 'POST', headers: tokenHeaders(), body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (d.ok) {
        const parts = [d.data?.label || provider];
        if (d.data?.key_saved) parts.push('含 Key');
        if (d.data?.base_url_saved) parts.push('Base URL');
        if (d.data?.model_saved) parts.push('Model');
        setMsg('ms-chat-msg', `✅ 已保存 ${parts.join(' · ')}`, 'ok');
        await refreshAll();
      } else {
        setMsg('ms-chat-msg', '❌ ' + (d.error || d.message || '保存失败'), 'err');
      }
    } catch (e) { setMsg('ms-chat-msg', '❌ ' + e.message, 'err'); }
  });

  document.getElementById('ms-chat-test').addEventListener('click', async () => {
    const provider = document.getElementById('ms-chat-provider').value;
    if (!provider) { setMsg('ms-chat-msg', '请先选 Provider', 'err'); return; }
    setMsg('ms-chat-msg', '测试中…', 'info');
    try {
      const r = await fetch('/api/setup/test-provider', {
        method: 'POST', headers: tokenHeaders(),
        body: JSON.stringify({ provider, capability: 'chat' }),
      });
      const d = await r.json();
      if (d.ok && d.data?.ok) {
        setMsg('ms-chat-msg', `✅ 连通成功！${d.data.label || provider} ${d.data.latency_ms ?? '--'}ms`, 'ok');
      } else {
        setMsg('ms-chat-msg', '❌ ' + (d.data?.error || d.error || d.message || '连通失败').slice(0, 120), 'err');
      }
    } catch (e) { setMsg('ms-chat-msg', '❌ ' + e.message, 'err'); }
  });

  // ─── Optional Capabilities Detail (vision/asr/tts/image/embedding/search) ─
  function syncOptVisibility(cap, provider) {
    const meta = CAP_META[cap] || {};
    const isSearch = cap === 'search';
    const isSearxng = isSearch && provider === 'searxng';
    const isCustom = !isSearch && provider === 'custom';

    const baseRow   = document.getElementById('ms-opt-base-row');
    const baseLabel = document.getElementById('ms-opt-base-label');
    const baseHint  = document.getElementById('ms-opt-base-hint');
    const modelRow  = document.getElementById('ms-opt-model-row');
    const modelLbl  = document.getElementById('ms-opt-model-label');
    const modelHint = document.getElementById('ms-opt-model-hint');
    const voiceRow  = document.getElementById('ms-opt-voice-row');
    const voiceLbl  = document.getElementById('ms-opt-voice-label');
    const voiceHint = document.getElementById('ms-opt-voice-hint');
    const azureRow  = document.getElementById('ms-opt-azure-row');
    const doubaoRow = document.getElementById('ms-opt-doubao-row');
    const keyRow    = document.getElementById('ms-opt-key-row');
    const keyLbl    = document.getElementById('ms-opt-key-label');

    baseRow.classList.toggle('hidden', !(isCustom || isSearxng));
    if (isSearxng) {
      baseLabel.textContent = 'SearXNG Base URL';
      document.getElementById('ms-opt-base').placeholder = 'https://your-searxng.example.com';
      baseHint.textContent = 'SearXNG 实例必须开启 JSON 格式输出。';
    } else {
      baseLabel.textContent = 'Base URL（自定义必填）';
      document.getElementById('ms-opt-base').placeholder = 'https://relay.example/v1';
      baseHint.textContent = '填写 API 根地址（通常含 /v1），不要附带具体接口路径。';
    }

    modelRow.classList.toggle('hidden', isSearch);
    modelLbl.textContent = (cap === 'image' || cap === 'embedding') ? 'Model（自定义必填）' : 'Model（选填）';
    modelHint.textContent = (meta.modelHints && meta.modelHints[provider]) || '';

    voiceRow.classList.toggle('hidden', cap !== 'tts');
    voiceLbl.textContent = provider === 'fish' ? 'Reference ID（可选）' : 'Voice ID（选填）';
    voiceHint.textContent = (meta.voiceHints && meta.voiceHints[provider]) || '';

    azureRow.classList.toggle('hidden', !((cap === 'tts' || cap === 'asr') && provider === 'azure'));
    doubaoRow.classList.toggle('hidden', !((cap === 'tts' || cap === 'asr') && provider === 'doubao'));
    keyRow.classList.toggle('hidden', isSearxng);
    keyLbl.textContent = (meta.keyLabels && meta.keyLabels[provider]) || 'API Key（选填，已有可留空）';
  }

  function renderOptionalDetail(cap) {
    const meta = CAP_META[cap];
    const sec = (MS.data && MS.data[cap]) || {};
    const sel = document.getElementById('ms-opt-provider');
    sel.innerHTML = '';
    for (const [val, text] of (meta.options || [])) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = text;
      sel.appendChild(opt);
    }

    const active = (cap === 'image' || cap === 'embedding')
      ? (sec.active === 'custom' ? 'custom' : '')
      : (sec.active || '');
    sel.value = sel.querySelector(`option[value="${active}"]`) ? active : '';

    const customObj = cap === 'tts' ? sec.custom : sec.providers?.custom;
    document.getElementById('ms-opt-base').value = cap === 'search'
      ? (sec.providers?.searxng?.base_url || '')
      : (customObj?.base_url || '');
    document.getElementById('ms-opt-model').value = cap === 'tts'
      ? (sec.model || '')
      : ((cap === 'image' || cap === 'embedding') ? (customObj?.model || '') : (sec.active_model || ''));
    document.getElementById('ms-opt-voice').value = cap === 'tts' ? (sec.voice_id || '') : '';
    document.getElementById('ms-opt-azure-region').value = sec.extras?.region || '';
    document.getElementById('ms-opt-doubao-appid').value = sec.extras?.appid || '';
    document.getElementById('ms-opt-doubao-cluster').value = sec.extras?.cluster || '';
    document.getElementById('ms-opt-key').value = '';
    setMsg('ms-opt-msg', '', 'info');
    syncOptVisibility(cap, sel.value);
  }

  document.getElementById('ms-opt-provider').addEventListener('change', (e) => {
    if (!MS.selectedCap || MS.selectedCap === 'chat') return;
    syncOptVisibility(MS.selectedCap, e.target.value);
  });

  document.getElementById('ms-opt-save').addEventListener('click', async () => {
    const cap = MS.selectedCap;
    if (!cap || cap === 'chat') return;
    const provider = document.getElementById('ms-opt-provider').value;
    if (!provider) {
      setMsg('ms-opt-msg', '请先选择 Provider，或点击「恢复默认 / 清除」', 'err');
      return;
    }

    const payload = { capability: cap, provider };
    if (cap === 'search') {
      if (provider === 'searxng') {
        const baseUrl = document.getElementById('ms-opt-base').value.trim();
        if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
          setMsg('ms-opt-msg', '请填写以 http(s):// 开头的 Base URL', 'err');
          return;
        }
        payload.base_url = baseUrl;
      } else {
        payload.api_key = document.getElementById('ms-opt-key').value;
      }
    } else {
      payload.model = document.getElementById('ms-opt-model').value.trim();
      payload.base_url = document.getElementById('ms-opt-base').value.trim();
      payload.api_key = document.getElementById('ms-opt-key').value;
      payload.voice_id = cap === 'tts' ? document.getElementById('ms-opt-voice').value.trim() : '';
      const extras = {};
      if ((cap === 'tts' || cap === 'asr') && provider === 'azure') {
        extras.region = document.getElementById('ms-opt-azure-region').value.trim();
        if (cap === 'tts' && !extras.region) {
          setMsg('ms-opt-msg', '请填 Azure Region（如 eastasia）', 'err');
          return;
        }
      } else if ((cap === 'tts' || cap === 'asr') && provider === 'doubao') {
        extras.appid = document.getElementById('ms-opt-doubao-appid').value.trim();
        extras.cluster = document.getElementById('ms-opt-doubao-cluster').value.trim();
        if (!extras.appid) { setMsg('ms-opt-msg', '请填豆包 AppID', 'err'); return; }
        if (!extras.cluster) { setMsg('ms-opt-msg', '请填 Cluster', 'err'); return; }
      }
      payload.extras = extras;
    }

    setMsg('ms-opt-msg', '保存中…', 'info');
    try {
      const r = await fetch('/api/setup/provider-config', {
        method: 'POST', headers: tokenHeaders(), body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (d.ok) {
        document.getElementById('ms-opt-key').value = '';
        const parts = [d.data?.label || provider];
        if (d.data?.model_saved) parts.push('含 Model');
        if (d.data?.key_saved) parts.push('含 API Key');
        setMsg('ms-opt-msg', `✅ 已保存 ${parts.join(' · ')}`, 'ok');
        await refreshAll();
      } else {
        setMsg('ms-opt-msg', '❌ ' + (d.error || d.message || '保存失败'), 'err');
      }
    } catch (e) { setMsg('ms-opt-msg', '❌ ' + e.message, 'err'); }
  });

  document.getElementById('ms-opt-test').addEventListener('click', async () => {
    const cap = MS.selectedCap;
    if (!cap || cap === 'chat') return;
    const provider = document.getElementById('ms-opt-provider').value;
    if (!provider) { setMsg('ms-opt-msg', '请先选择并保存 Provider', 'err'); return; }
    const btn = document.getElementById('ms-opt-test');
    btn.disabled = true;
    setMsg('ms-opt-msg', '正在测试已保存配置…', 'info');
    try {
      const r = await fetch('/api/setup/test-provider', {
        method: 'POST', headers: tokenHeaders(),
        body: JSON.stringify({ capability: cap, provider }),
      });
      const d = await r.json();
      if (d.ok && d.data?.ok) {
        setMsg('ms-opt-msg', `✅ 连通成功！${d.data.label || provider} ${d.data.latency_ms ?? '--'}ms`, 'ok');
      } else {
        setMsg('ms-opt-msg', '❌ ' + (d.data?.error || d.error || d.message || '连通失败').slice(0, 120), 'err');
      }
    } catch (e) {
      setMsg('ms-opt-msg', '❌ 测试失败：' + e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('ms-opt-clear').addEventListener('click', async () => {
    const cap = MS.selectedCap;
    if (!cap || cap === 'chat') return;
    setMsg('ms-opt-msg', '清除中…', 'info');
    try {
      const r = await fetch('/api/setup/provider-config', {
        method: 'POST', headers: tokenHeaders(),
        body: JSON.stringify({ capability: cap, clear: true }),
      });
      const d = await r.json();
      if (d.ok) {
        setMsg('ms-opt-msg', '✅ 已恢复默认 / 清除', 'ok');
        await refreshAll();
      } else {
        setMsg('ms-opt-msg', '❌ ' + (d.error || d.message || '清除失败'), 'err');
      }
    } catch (e) { setMsg('ms-opt-msg', '❌ ' + e.message, 'err'); }
  });

  // dashboard 加载完后异步刷新一次，让 header 显示当前 provider
  setTimeout(refreshAll, 800);
})();
