/* 溪语 AI · 表情包工坊可复用模块（同时支持控制台内嵌 Tab 与独立 /app/stickers.html） */
(function (global) {
  'use strict';

  const GEN_EMOTIONS = [
    ['happy', '😊 开心'],
    ['shy', '😳 害羞'],
    ['love', '💕 比心'],
    ['cute', '🥺 撒娇'],
    ['angry', '😤 生气'],
    ['sad', '😢 委屈'],
    ['sleepy', '😴 困困'],
    ['night', '🌙 晚安'],
    ['morning', '☀️ 早安'],
    ['hug', '🫂 抱抱'],
    ['mock', '😏 吐槽'],
    ['speechless', '😑 无语'],
    ['cheer', '🎉 加油'],
  ];

  const TEMPLATE = `
    <div class="stk-studio">
      <div id="stk-toast" role="status" aria-live="polite" class="hidden fixed top-16 left-1/2 -translate-x-1/2 z-[10002] px-5 py-2.5 rounded-full text-[13px] font-semibold shadow-card"></div>

      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <div class="flex items-center gap-2.5 flex-wrap">
            <h3 class="text-[16px] font-bold">😊 表情包工坊</h3>
            <span id="stk-summary-pill" class="glass-chip text-[11px]">加载中…</span>
          </div>
          <p class="text-[12px] text-mute mt-1">支持手动批量导入、精选图库人设推荐拉取、AI 定制 Q 版专属贴纸与心愿收藏箱。</p>
        </div>
        <a id="stk-standalone-link" href="/app/stickers.html" class="hidden text-[12px] font-semibold text-sakura-deep hover:underline whitespace-nowrap shrink-0">独立全屏打开 ↗</a>
      </div>

      <div class="stk-tabs mb-5" role="tablist" aria-label="表情包管理分区">
        <button type="button" role="tab" class="stk-tab active" data-tab="library" aria-selected="true">
          <span aria-hidden="true">🎨</span> 我的表情库 <span id="tab-count-lib" class="stk-badge">0</span>
        </button>
        <button type="button" role="tab" class="stk-tab" data-tab="curated" aria-selected="false">
          <span aria-hidden="true">📦</span> 精选图库
        </button>
        <button type="button" role="tab" class="stk-tab" data-tab="generate" aria-selected="false">
          <span aria-hidden="true">✨</span> AI 定制 Q 版
        </button>
        <button type="button" role="tab" class="stk-tab" data-tab="wishlist" aria-selected="false">
          <span aria-hidden="true">💌</span> 心愿收藏箱 <span id="tab-count-wish" class="stk-badge">0</span>
        </button>
      </div>

      <!-- Tab 1: 我的表情库 -->
      <section id="panel-library" class="stk-panel">
        <div class="glass rounded-3xl p-5 mb-5">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 mb-3.5">
            <div>
              <h4 class="text-[14px] font-bold">📤 手动导入表情包</h4>
              <p class="text-[12px] text-mute mt-0.5">支持 PNG / JPG / WebP / GIF（单张 ≤ 1.5MB），可一次拖入多张并立即生效。</p>
            </div>
            <label class="inline-flex items-center gap-2 text-[12px] font-medium text-mute cursor-pointer select-none">
              <input id="upload-autotag" type="checkbox" class="w-4 h-4 accent-sakura-deep" />
              <span>视觉模型自动打标（静图）</span>
            </label>
          </div>

          <div class="grid sm:grid-cols-2 gap-3 mb-3">
            <div>
              <label for="upload-emotion" class="block text-[12px] font-semibold mb-1">默认情绪</label>
              <select id="upload-emotion" class="stk-input">
                <option value="">自动识别（按文件名 / 视觉模型）</option>
                <option value="happy">happy · 开心</option>
                <option value="shy">shy · 害羞</option>
                <option value="love">love · 喜欢 / 比心</option>
                <option value="cute">cute · 撒娇 / 可爱</option>
                <option value="sad">sad · 委屈 / 难过</option>
                <option value="angry">angry · 生气</option>
                <option value="sleepy">sleepy · 困困</option>
                <option value="night">night · 晚安</option>
                <option value="morning">morning · 早安</option>
                <option value="hug">hug · 抱抱</option>
                <option value="mock">mock · 吐槽 / 嘲讽</option>
                <option value="speechless">speechless · 无语</option>
                <option value="proud">proud · 得意</option>
                <option value="wave">wave · 拜拜</option>
              </select>
            </div>
            <div>
              <label for="upload-tags" class="block text-[12px] font-semibold mb-1">附加标签（逗号或空格分隔）</label>
              <input id="upload-tags" type="text" class="stk-input" placeholder="如：cat, cute, 撒娇" autocomplete="off" />
            </div>
          </div>

          <div id="drop-zone" class="stk-dropzone" tabindex="0" role="button" aria-label="点击或拖拽图片到这里上传">
            <i data-lucide="upload-cloud" class="w-7 h-7 text-sakura-deep mx-auto mb-1.5"></i>
            <p class="text-[13px] font-semibold text-ink">点击选择图片，或直接拖拽到这里</p>
            <p class="text-[11px] text-mute mt-0.5">支持批量选择，上传后立即写入本地库并热重载</p>
            <input id="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple class="hidden" />
          </div>
          <p id="upload-status" class="mt-2 text-[12px] text-mute min-h-[16px]" role="status" aria-live="polite"></p>
        </div>

        <div class="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between mb-3.5">
          <div class="relative flex-1 max-w-sm">
            <input id="lib-search" type="search" class="stk-input" placeholder="搜索标签、情绪或备注…" aria-label="搜索表情包" />
          </div>
          <div class="flex items-center gap-2 text-[12px]">
            <button type="button" class="stk-filter-btn active" data-state-filter="all">全部</button>
            <button type="button" class="stk-filter-btn" data-state-filter="active">仅已启用</button>
            <button type="button" class="stk-filter-btn" data-state-filter="disabled">仅已停用</button>
          </div>
        </div>

        <div id="lib-tag-bar" class="flex flex-wrap gap-1.5 mb-4"></div>
        <div id="lib-grid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3.5"></div>
        <div id="lib-empty" class="hidden glass rounded-3xl p-8 text-center">
          <div class="text-3xl mb-2.5" aria-hidden="true">🫧</div>
          <p class="text-[14px] font-bold">还没有表情包</p>
          <p class="text-[12px] text-mute mt-1 mb-4">可以拖几张喜欢的图进来，或者去「精选图库」一键挑几套可爱的！</p>
          <div class="flex justify-center gap-2.5 flex-wrap">
            <button type="button" id="btn-empty-go-curated" class="stk-btn-primary">📦 去精选图库挑一套</button>
            <button type="button" id="btn-empty-go-gen" class="stk-btn-outline">✨ AI 画一张 Q 版专属</button>
          </div>
        </div>
      </section>

      <!-- Tab 2: 精选开源图库 -->
      <section id="panel-curated" class="stk-panel hidden">
        <div class="glass rounded-3xl p-5 mb-4">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h4 class="text-[15px] font-bold">📦 精选开源表情包库</h4>
              <p class="text-[12px] text-mute mt-1 leading-relaxed">
                来自开源社区 ChineseBQB 白名单精选包（已排除敏感与影视截图包），单张 ≤ 500KB，拉回后自动打标，随时可单张开关。
              </p>
            </div>
            <button type="button" id="btn-recommend-packs" class="stk-btn-outline shrink-0">✨ 让 xiyu 按人设帮我挑</button>
          </div>
          <div id="recommend-banner" class="hidden mt-3.5 p-3 rounded-2xl bg-sakura-soft/60 border border-sakura/50 text-[12px] leading-relaxed"></div>
          <div class="mt-4 pt-3.5 border-t border-line flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-2 text-[12px]">
              <label for="curated-per-pack" class="text-mute font-medium">每套拉取数量</label>
              <select id="curated-per-pack" class="stk-input !w-auto !py-1.5 !px-3 text-[12px]">
                <option value="6">6 张 / 套</option>
                <option value="8" selected>8 张 / 套（推荐）</option>
                <option value="12">12 张 / 套</option>
              </select>
            </div>
            <div class="flex items-center gap-3">
              <span id="curated-selected-count" class="text-[12px] text-mute">已选 0 套</span>
              <button type="button" id="btn-fetch-packs" class="stk-btn-primary" disabled>一键拉取选中</button>
            </div>
          </div>
          <p id="curated-status" class="mt-2 text-[12px] text-mute" role="status" aria-live="polite"></p>
        </div>
        <div id="curated-grid" class="grid sm:grid-cols-2 gap-3"></div>
      </section>

      <!-- Tab 3: AI 定制 Q 版 -->
      <section id="panel-generate" class="stk-panel hidden">
        <div class="grid md:grid-cols-[1.15fr_0.85fr] gap-4 items-start">
          <div class="glass rounded-3xl p-5">
            <h4 class="text-[15px] font-bold">✨ AI 为她定制专属 Q 版表情包</h4>
            <p class="text-[12px] text-mute mt-1 mb-4 leading-relaxed">
              复用生图模型与她的外貌设定，生成 100% 契合人设的专属贴纸并直接入库。
            </p>
            <div class="mb-3.5">
              <label class="block text-[12px] font-semibold mb-2">选择情绪 / 场景</label>
              <div id="gen-emotion-chips" class="flex flex-wrap gap-1.5"></div>
            </div>
            <div class="grid sm:grid-cols-2 gap-3 mb-3.5">
              <div>
                <label for="gen-custom-emotion" class="block text-[12px] font-semibold mb-1">情绪标签（可自定义）</label>
                <input id="gen-custom-emotion" type="text" class="stk-input font-mono" value="happy" placeholder="如：shy / love / sleepy" />
              </div>
              <div>
                <label for="gen-style" class="block text-[12px] font-semibold mb-1">画风</label>
                <select id="gen-style" class="stk-input">
                  <option value="chibi">日系 Q 版白边贴纸（推荐）</option>
                  <option value="pastel">软萌手绘水彩风</option>
                  <option value="pixel">复古像素小表情</option>
                </select>
              </div>
            </div>
            <div class="mb-4">
              <label for="gen-hint" class="block text-[12px] font-semibold mb-1">画面补充描述（选填）</label>
              <input id="gen-hint" type="text" class="stk-input" placeholder="如：抱着一杯奶茶偷偷笑、戴着猫耳发箍" />
            </div>
            <button type="button" id="btn-gen-sticker" class="stk-btn-primary w-full sm:w-auto">✨ 生成并加入表情库</button>
            <p id="gen-status" class="mt-2.5 text-[12px] text-mute" role="status" aria-live="polite"></p>
          </div>
          <div class="glass rounded-3xl p-5 text-center">
            <h4 class="text-[14px] font-bold mb-3">生成预览</h4>
            <div id="gen-preview-box" class="stk-gen-preview">
              <span class="text-[12px] text-mute">点击左侧生成后，会在这里展示最新作品</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Tab 4: 心愿收藏箱 -->
      <section id="panel-wishlist" class="stk-panel hidden">
        <div class="glass rounded-3xl p-5 mb-4">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h4 class="text-[15px] font-bold">💌 她的心愿收藏箱</h4>
              <p class="text-[12px] text-mute mt-1 leading-relaxed">
                聊天时她想发某个情绪表情但本地库里没有，会悄悄记在这里并异步寻找候选图，不卡当次回复。
              </p>
            </div>
            <label class="inline-flex items-center gap-2.5 shrink-0 cursor-pointer select-none">
              <span class="text-[12px] font-semibold">收集到后自动入库</span>
              <span class="stk-toggle">
                <input id="wish-auto-approve" type="checkbox" />
                <span class="stk-slider"></span>
              </span>
            </label>
          </div>
          <form id="wish-add-form" class="mt-4 pt-3.5 border-t border-line flex flex-col sm:flex-row gap-2.5">
            <input id="wish-tag-input" type="text" class="stk-input flex-1" placeholder="手动帮她许愿一个想收集的表情标签，如：hug / 晚安 / eyeroll" required />
            <button type="submit" class="stk-btn-primary shrink-0">加入心愿箱并去收集</button>
          </form>
          <p id="wish-status" class="mt-2 text-[12px] text-mute" role="status" aria-live="polite"></p>
        </div>
        <div id="wish-list" class="space-y-3"></div>
        <div id="wish-empty" class="hidden glass rounded-3xl p-8 text-center">
          <div class="text-3xl mb-2" aria-hidden="true">✨</div>
          <p class="text-[14px] font-bold">心愿收藏箱目前是空的</p>
          <p class="text-[12px] text-mute mt-1">聊天中缺表情会自动记入这里，也可以在上方手动输入一个标签让她去找。</p>
        </div>
      </section>

      <!-- 编辑标签弹窗 -->
      <div id="stk-edit-modal" role="dialog" aria-modal="true" aria-label="编辑表情包标签" class="hidden fixed inset-0 bg-black/45 backdrop-blur-sm z-[10001] flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl max-w-[420px] w-full p-6 shadow-card">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-[16px] font-bold">编辑表情包信息</h3>
            <button type="button" id="stk-edit-close" class="text-mute hover:text-ink text-xl leading-none p-1" aria-label="关闭弹窗">×</button>
          </div>
          <div class="flex justify-center mb-4">
            <img id="stk-edit-preview" src="" alt="" class="w-28 h-28 object-contain rounded-2xl border border-line bg-cloud p-2" />
          </div>
          <div class="space-y-3">
            <div>
              <label for="stk-edit-emotion" class="block text-[12px] font-semibold mb-1">主情绪</label>
              <input id="stk-edit-emotion" type="text" class="stk-input font-mono" placeholder="如：happy / shy / mock" />
            </div>
            <div>
              <label for="stk-edit-tags" class="block text-[12px] font-semibold mb-1">标签（逗号分隔）</label>
              <input id="stk-edit-tags" type="text" class="stk-input" placeholder="如：cat, cute, happy" />
            </div>
            <div>
              <label for="stk-edit-desc" class="block text-[12px] font-semibold mb-1">备注说明</label>
              <input id="stk-edit-desc" type="text" class="stk-input" placeholder="简短描述画面" />
            </div>
          </div>
          <div class="mt-5 flex justify-end gap-2">
            <button type="button" id="stk-edit-cancel" class="stk-btn-ghost">取消</button>
            <button type="button" id="stk-edit-save" class="stk-btn-primary">保存修改</button>
          </div>
        </div>
      </div>

      <!-- 精选图库预览弹窗 -->
      <div id="stk-pack-preview-modal" role="dialog" aria-modal="true" aria-label="预览精选表情包图集" class="hidden fixed inset-0 bg-black/50 backdrop-blur-sm z-[10001] flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl max-w-[680px] w-full max-h-[86vh] flex flex-col shadow-card overflow-hidden">
          <div class="px-6 py-4 border-b border-line flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 id="stk-pv-title" class="text-[16px] font-bold flex items-center gap-2">预览表情包</h3>
              <p id="stk-pv-desc" class="text-[12px] text-mute mt-0.5"></p>
            </div>
            <button type="button" id="stk-pv-close" class="text-mute hover:text-ink text-xl leading-none p-1 shrink-0" aria-label="关闭预览">×</button>
          </div>
          <div class="p-5 overflow-y-auto flex-1 space-y-3">
            <p id="stk-pv-status" class="text-[12px] text-mute"></p>
            <div id="stk-pv-grid" class="grid grid-cols-3 sm:grid-cols-4 gap-3"></div>
            <div class="text-center pt-1">
              <button type="button" id="stk-pv-more" class="hidden stk-btn-outline text-[12px]">加载更多示例</button>
            </div>
          </div>
          <div class="px-6 py-3.5 border-t border-line bg-cloud/60 flex items-center justify-between gap-2 flex-wrap">
            <span id="stk-pv-count" class="text-[12px] text-mute"></span>
            <div class="flex items-center gap-2">
              <button type="button" id="stk-pv-toggle" class="stk-btn-outline text-[12px]">勾选此套</button>
              <button type="button" id="stk-pv-fetch" class="stk-btn-primary text-[12px]">一键拉取这一套</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  function mount(target, opts = {}) {
    const root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!root || root.dataset.stkMounted === '1') return;
    root.dataset.stkMounted = '1';

    const token = (global.XiyuUI ? global.XiyuUI.getToken() : localStorage.getItem('xiyu_token')) || '';
    if (!token) {
      if (opts.standalone) location.href = '/app/auth.html';
      return;
    }

    root.innerHTML = TEMPLATE;
    const $ = (sel) => root.querySelector(sel);
    const $$ = (sel) => Array.from(root.querySelectorAll(sel));

    if (!opts.standalone) {
      $('#stk-standalone-link')?.classList.remove('hidden');
    }

    const esc = global.XiyuUI ? global.XiyuUI.escapeHtml : (s) => String(s || '');
    const headers = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token });

    const S = {
      tab: 'library',
      data: null,
      search: '',
      stateFilter: 'all',
      tagFilter: '',
      selectedPacks: new Set(),
      recommendedPacks: new Set(),
      editingId: null,
    };

    function toast(msg, kind = 'ok') {
      const el = $('#stk-toast');
      if (!el) return;
      el.textContent = msg;
      el.className = 'fixed top-16 left-1/2 -translate-x-1/2 z-[10002] px-5 py-2.5 rounded-full text-[13px] font-semibold shadow-card ' + (
        kind === 'err' ? 'bg-rose-50 text-rose-600 border border-rose-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
      );
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.add('hidden'), 2600);
    }

    async function api(url, fetchOpts = {}) {
      const res = await fetch(url, {
        ...fetchOpts,
        headers: { ...headers(), ...(fetchOpts.headers || {}) },
      });
      if (res.status === 401) {
        localStorage.removeItem('xiyu_token');
        location.href = '/app/auth.html';
        return null;
      }
      return res.json();
    }

    function companionIdParam() {
      const cid = Number(localStorage.getItem('xiyu_companion_id') || 0);
      return cid > 0 ? cid : undefined;
    }

    // ─── Tabs ────────────────────────────────────────────────────────────────
    const tabBtns = $$('.stk-tab');
    function switchTab(name) {
      S.tab = name;
      tabBtns.forEach(b => {
        const active = b.dataset.tab === name;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      for (const p of ['library', 'curated', 'generate', 'wishlist']) {
        $('#panel-' + p)?.classList.toggle('hidden', p !== name);
      }
    }
    tabBtns.forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('#btn-empty-go-curated')?.addEventListener('click', () => switchTab('curated'));
    $('#btn-empty-go-gen')?.addEventListener('click', () => switchTab('generate'));

    // ─── Load & Render ───────────────────────────────────────────────────────
    async function loadAll() {
      const d = await api('/api/stickers');
      if (!d?.ok) {
        toast(d?.error || d?.message || '加载表情包失败', 'err');
        return;
      }
      S.data = d.data;
      const summary = `已启用 ${S.data.active_count || 0} / ${S.data.total || 0} 张 · ${(S.data.tags || []).length} 个标签`;
      const pill = $('#stk-summary-pill');
      if (pill) pill.textContent = summary;
      const pagePill = document.getElementById('stk-page-summary-pill');
      if (pagePill) pagePill.textContent = summary;
      $('#tab-count-lib').textContent = String(S.data.total || 0);
      $('#tab-count-wish').textContent = String((S.data.wishlist?.items || []).length);
      renderLibrary();
      renderCurated();
      renderWishlist();
      if (global.XiyuUI) global.XiyuUI.renderIcons(root);
    }

    function renderLibrary() {
      const d = S.data || {};
      const tagBar = $('#lib-tag-bar');
      const tags = (d.tags || []).slice(0, 24);
      tagBar.innerHTML = [
        `<button type="button" class="stk-tag-pill ${S.tagFilter === '' ? 'active' : ''}" data-tag="">全部标签</button>`,
        ...tags.map(t => `<button type="button" class="stk-tag-pill ${S.tagFilter === t.tag ? 'active' : ''}" data-tag="${esc(t.tag)}">#${esc(t.tag)} <span class="opacity-65">${t.count}</span></button>`),
      ].join('');
      tagBar.querySelectorAll('.stk-tag-pill').forEach(btn => {
        btn.addEventListener('click', () => { S.tagFilter = btn.dataset.tag || ''; renderLibrary(); });
      });

      const q = S.search.trim().toLowerCase();
      const filtered = (d.stickers || []).filter(s => {
        if (S.stateFilter === 'active' && s.disabled) return false;
        if (S.stateFilter === 'disabled' && !s.disabled) return false;
        if (S.tagFilter) {
          const all = new Set([...(s.tags || []), s.emotion]);
          if (!all.has(S.tagFilter)) return false;
        }
        if (q) {
          const hay = [s.emotion, ...(s.tags || []), s.description, s.source].join(' ').toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      const grid = $('#lib-grid');
      const empty = $('#lib-empty');
      if (!filtered.length) {
        grid.innerHTML = '';
        empty.classList.remove('hidden');
        return;
      }
      empty.classList.add('hidden');
      grid.innerHTML = filtered.map(s => `
        <article class="stk-card ${s.disabled ? 'is-disabled' : ''}" data-id="${esc(s.id)}">
          <div class="stk-thumb"><img src="${esc(s.url)}" alt="${esc(s.description || s.emotion)}" loading="lazy" /></div>
          <div class="flex items-center justify-between gap-1">
            <span class="pill text-[11px]">${esc(s.emotion || 'cute')}</span>
            <label class="stk-toggle" title="${s.disabled ? '已停用，点击启用' : '已启用，点击停用'}">
              <input type="checkbox" class="js-toggle-stk" data-id="${esc(s.id)}" ${s.disabled ? '' : 'checked'} aria-label="启用或停用此表情包" />
              <span class="stk-slider"></span>
            </label>
          </div>
          <div class="flex flex-wrap gap-1 min-h-[20px]">
            ${(s.tags || []).slice(0, 4).map(t => `<span class="text-[10px] px-1.5 py-0.5 rounded-md bg-cloud text-mute">#${esc(t)}</span>`).join('')}
          </div>
          <div class="flex items-center justify-between pt-1 border-t border-line/60 text-[11px]">
            <button type="button" class="js-edit-stk text-mute hover:text-sakura-deep font-semibold" data-id="${esc(s.id)}">编辑标签</button>
            <button type="button" class="js-del-stk text-mute hover:text-danger font-semibold" data-id="${esc(s.id)}">删除</button>
          </div>
        </article>
      `).join('');

      grid.querySelectorAll('.js-toggle-stk').forEach(inp => {
        inp.addEventListener('change', async () => {
          const r = await api('/api/stickers/' + encodeURIComponent(inp.dataset.id), {
            method: 'PATCH', body: JSON.stringify({ disabled: !inp.checked }),
          });
          if (r?.ok) { toast(inp.checked ? '已启用该表情包' : '已停用该表情包'); await loadAll(); }
          else { inp.checked = !inp.checked; toast(r?.error || '更新失败', 'err'); }
        });
      });
      grid.querySelectorAll('.js-edit-stk').forEach(btn => {
        btn.addEventListener('click', () => {
          const item = (S.data?.stickers || []).find(x => x.id === btn.dataset.id);
          if (item) openEditModal(item);
        });
      });
      grid.querySelectorAll('.js-del-stk').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('确认删除这张表情包吗？')) return;
          const r = await api('/api/stickers/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
          if (r?.ok) { toast('已删除'); await loadAll(); }
          else toast(r?.error || '删除失败', 'err');
        });
      });
    }

    $('#lib-search')?.addEventListener('input', (e) => { S.search = e.target.value; renderLibrary(); });
    $$('.stk-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        S.stateFilter = btn.dataset.stateFilter || 'all';
        $$('.stk-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
        renderLibrary();
      });
    });

    // ─── Upload ──────────────────────────────────────────────────────────────
    const dropZone = $('#drop-zone');
    const fileInput = $('#file-input');
    const uploadStatus = $('#upload-status');
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.length) handleFiles(fileInput.files);
      fileInput.value = '';
    });

    function readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error('读取文件失败'));
        fr.readAsDataURL(file);
      });
    }

    async function handleFiles(fileList) {
      const files = Array.from(fileList);
      const emotion = $('#upload-emotion').value;
      const tags = $('#upload-tags').value.trim();
      const autoTag = $('#upload-autotag').checked;
      let okCount = 0;
      const errs = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        uploadStatus.textContent = `正在导入 ${i + 1} / ${files.length}：${f.name}…`;
        try {
          const dataUrl = await readAsDataUrl(f);
          const r = await api('/api/stickers/upload', {
            method: 'POST',
            body: JSON.stringify({ image_base64: dataUrl, filename: f.name, emotion, tags, auto_tag: autoTag }),
          });
          if (r?.ok) okCount++;
          else errs.push(`${f.name}: ${r?.error || '失败'}`);
        } catch (e) { errs.push(`${f.name}: ${e.message}`); }
      }
      uploadStatus.textContent = errs.length
        ? `导入完成：成功 ${okCount} 张，失败 ${errs.length} 张（${errs[0]}）`
        : `✅ 成功导入 ${okCount} 张表情包并已生效！`;
      if (okCount > 0) { toast(`已导入 ${okCount} 张表情包`); await loadAll(); }
    }

    // ─── Edit Modal ──────────────────────────────────────────────────────────
    const editModal = $('#stk-edit-modal');
    function openEditModal(item) {
      S.editingId = item.id;
      $('#stk-edit-preview').src = item.url;
      $('#stk-edit-emotion').value = item.emotion || '';
      $('#stk-edit-tags').value = (item.tags || []).join(', ');
      $('#stk-edit-desc').value = item.description || '';
      editModal.classList.remove('hidden');
    }
    function closeEditModal() { S.editingId = null; editModal.classList.add('hidden'); }
    $('#stk-edit-close')?.addEventListener('click', closeEditModal);
    $('#stk-edit-cancel')?.addEventListener('click', closeEditModal);
    editModal?.addEventListener('click', (e) => { if (e.target === editModal) closeEditModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && editModal && !editModal.classList.contains('hidden')) closeEditModal();
    });
    $('#stk-edit-save')?.addEventListener('click', async () => {
      if (!S.editingId) return;
      const r = await api('/api/stickers/' + encodeURIComponent(S.editingId), {
        method: 'PATCH',
        body: JSON.stringify({
          emotion: $('#stk-edit-emotion').value.trim(),
          tags: $('#stk-edit-tags').value.trim(),
          description: $('#stk-edit-desc').value.trim(),
        }),
      });
      if (r?.ok) { toast('已保存标签修改'); closeEditModal(); await loadAll(); }
      else toast(r?.error || '保存失败', 'err');
    });

    // ─── Curated Packs ───────────────────────────────────────────────────────
    let previewState = { packId: null, offset: 0, total: 0, hasMore: false, items: [] };
    const pvModal = $('#stk-pack-preview-modal');

    function closePackPreview() {
      pvModal?.classList.add('hidden');
      previewState = { packId: null, offset: 0, total: 0, hasMore: false, items: [] };
    }
    $('#stk-pv-close')?.addEventListener('click', closePackPreview);
    pvModal?.addEventListener('click', (e) => { if (e.target === pvModal) closePackPreview(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pvModal && !pvModal.classList.contains('hidden')) closePackPreview();
    });

    function syncPreviewToggleBtn() {
      const btn = $('#stk-pv-toggle');
      if (!btn || !previewState.packId) return;
      const sel = S.selectedPacks.has(previewState.packId);
      btn.textContent = sel ? '✓ 已勾选此套（点击取消）' : '勾选此套';
    }

    async function loadPackPreviewPage(packId, { append = false } = {}) {
      const statusEl = $('#stk-pv-status');
      const gridEl = $('#stk-pv-grid');
      const moreBtn = $('#stk-pv-more');
      const countEl = $('#stk-pv-count');
      const offset = append ? previewState.offset : 0;
      if (!append) {
        gridEl.innerHTML = '';
        statusEl.textContent = '正在加载该图集的真实表情预览…';
        moreBtn.classList.add('hidden');
      } else {
        moreBtn.disabled = true;
        moreBtn.textContent = '加载中…';
      }
      const r = await api(`/api/stickers/curated/${encodeURIComponent(packId)}/preview?limit=12&offset=${offset}`);
      moreBtn.disabled = false;
      moreBtn.textContent = '加载更多示例';
      if (!r?.ok) {
        statusEl.textContent = '❌ 预览加载失败：' + (r?.error || r?.message || '请稍后重试');
        return;
      }
      const d = r.data || {};
      const items = Array.isArray(d.items) ? d.items : [];
      previewState = {
        packId,
        offset: offset + items.length,
        total: d.total_in_pack || items.length,
        hasMore: Boolean(d.has_more),
        items: append ? [...previewState.items, ...items] : items,
      };
      if (d.pack) {
        $('#stk-pv-title').textContent = `${d.pack.emoji || '📦'} ${d.pack.name || packId}`;
        $('#stk-pv-desc').textContent = d.pack.desc || '';
      }
      statusEl.textContent = items.length
        ? `以下为图集内真实表情示例（点击下方按钮可直接勾选或拉取入库）：`
        : '该图集暂无可预览图片';
      countEl.textContent = `已展示 ${previewState.items.length} / 共 ${previewState.total} 张`;
      moreBtn.classList.toggle('hidden', !previewState.hasMore);

      const html = items.map(it => `
        <div class="rounded-2xl border border-line bg-cloud p-2 flex flex-col gap-1.5">
          <div class="aspect-square rounded-xl bg-white border border-line/60 flex items-center justify-center overflow-hidden p-1">
            <img src="${esc(it.preview_url)}" alt="${esc(it.label)}" loading="lazy" class="w-full h-full object-contain" />
          </div>
          <div class="text-[11px] text-ink font-medium truncate" title="${esc(it.label)}">${esc(it.label)}</div>
          <div class="flex flex-wrap gap-1">
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-sakura-soft/70 text-sakura-deep">${esc(it.emotion || 'cute')}</span>
          </div>
        </div>
      `).join('');
      if (append) gridEl.insertAdjacentHTML('beforeend', html);
      else gridEl.innerHTML = html;
      syncPreviewToggleBtn();
    }

    function openPackPreview(packId) {
      const pack = (S.data?.curated_packs || []).find(p => p.id === packId);
      $('#stk-pv-title').textContent = pack ? `${pack.emoji} ${pack.name}` : '预览表情包';
      $('#stk-pv-desc').textContent = pack?.desc || '';
      $('#stk-pv-count').textContent = '';
      previewState = { packId, offset: 0, total: 0, hasMore: false, items: [] };
      syncPreviewToggleBtn();
      pvModal?.classList.remove('hidden');
      loadPackPreviewPage(packId, { append: false });
    }

    $('#stk-pv-more')?.addEventListener('click', () => {
      if (previewState.packId && previewState.hasMore) {
        loadPackPreviewPage(previewState.packId, { append: true });
      }
    });
    $('#stk-pv-toggle')?.addEventListener('click', () => {
      if (!previewState.packId) return;
      if (S.selectedPacks.has(previewState.packId)) S.selectedPacks.delete(previewState.packId);
      else S.selectedPacks.add(previewState.packId);
      renderCurated();
      syncPreviewToggleBtn();
    });
    $('#stk-pv-fetch')?.addEventListener('click', async () => {
      if (!previewState.packId) return;
      const pid = previewState.packId;
      const btn = $('#stk-pv-fetch');
      const perPack = Number($('#curated-per-pack')?.value) || 8;
      btn.disabled = true;
      btn.textContent = '拉取中…';
      const r = await api('/api/stickers/fetch-packs', {
        method: 'POST', body: JSON.stringify({ pack_ids: [pid], per_pack: perPack }),
      });
      btn.disabled = false;
      btn.textContent = '一键拉取这一套';
      if (r?.ok) {
        toast(`已拉取：新增 ${r.data.added} 张，跳过 ${r.data.skipped} 张`);
        closePackPreview();
        await loadAll();
        switchTab('library');
      } else {
        toast(r?.error || '拉取失败', 'err');
      }
    });

    function renderCurated() {
      const packs = S.data?.curated_packs || [];
      const grid = $('#curated-grid');
      grid.innerHTML = packs.map(p => {
        const sel = S.selectedPacks.has(p.id);
        const rec = S.recommendedPacks.has(p.id);
        return `
          <div role="button" tabindex="0" class="stk-pack-card ${sel ? 'selected' : ''} ${rec ? 'recommended' : ''}" data-pack="${esc(p.id)}" aria-pressed="${sel ? 'true' : 'false'}">
            <span class="text-2xl leading-none shrink-0 mt-0.5" aria-hidden="true">${esc(p.emoji)}</span>
            <span class="flex-1 min-w-0">
              <span class="flex items-center gap-2 flex-wrap">
                <span class="text-[14px] font-bold text-ink">${esc(p.name)}</span>
                ${rec ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sakura-deep text-white">她推荐</span>' : ''}
                <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full ${p.risk === 'low' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}">${esc(p.risk_label)}</span>
              </span>
              <span class="block text-[12px] text-mute mt-1 leading-relaxed">${esc(p.desc)}</span>
              <span class="flex items-center justify-between gap-2 flex-wrap mt-2">
                <span class="flex flex-wrap gap-1">
                  ${(p.base_tags || []).slice(0, 5).map(t => `<span class="text-[10px] px-1.5 py-0.5 rounded bg-cloud text-mute">#${esc(t)}</span>`).join('')}
                </span>
                <button type="button" class="js-preview-pack text-[11px] font-semibold px-2.5 py-1 rounded-full bg-white border border-sakura/60 text-sakura-deep hover:bg-sakura-soft/50 transition-colors shrink-0" data-pack="${esc(p.id)}">👀 预览图集</button>
              </span>
            </span>
          </div>
        `;
      }).join('');
      grid.querySelectorAll('.stk-pack-card').forEach(card => {
        const toggle = () => {
          const id = card.dataset.pack;
          if (S.selectedPacks.has(id)) S.selectedPacks.delete(id);
          else S.selectedPacks.add(id);
          renderCurated();
        };
        card.addEventListener('click', toggle);
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
      });
      grid.querySelectorAll('.js-preview-pack').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openPackPreview(btn.dataset.pack);
        });
      });
      const count = S.selectedPacks.size;
      $('#curated-selected-count').textContent = `已选 ${count} 套`;
      $('#btn-fetch-packs').disabled = count === 0;
    }

    $('#btn-recommend-packs')?.addEventListener('click', async () => {
      const btn = $('#btn-recommend-packs');
      btn.disabled = true;
      const r = await api('/api/stickers/recommend-packs', {
        method: 'POST', body: JSON.stringify({ companion_id: companionIdParam() }),
      });
      btn.disabled = false;
      if (!r?.ok) { toast(r?.error || '推荐失败', 'err'); return; }
      S.recommendedPacks = new Set(r.data.pack_ids || []);
      S.selectedPacks = new Set(r.data.pack_ids || []);
      const banner = $('#recommend-banner');
      banner.innerHTML = `<b>✨ ${esc(r.data.companion_name || '她')}的挑选建议：</b>${esc(r.data.reason)}`;
      banner.classList.remove('hidden');
      renderCurated();
      toast('已按人设勾选推荐表情包');
    });

    $('#btn-fetch-packs')?.addEventListener('click', async () => {
      const packIds = [...S.selectedPacks];
      if (!packIds.length) return;
      const btn = $('#btn-fetch-packs');
      const status = $('#curated-status');
      const perPack = Number($('#curated-per-pack').value) || 8;
      btn.disabled = true;
      status.textContent = `正在从精选开源库拉取 ${packIds.length} 套表情包（每套最多 ${perPack} 张），请稍候…`;
      const r = await api('/api/stickers/fetch-packs', {
        method: 'POST', body: JSON.stringify({ pack_ids: packIds, per_pack: perPack }),
      });
      btn.disabled = false;
      if (r?.ok) {
        const d = r.data;
        status.textContent = `✅ 拉取完成：新增 ${d.added} 张，跳过已有 ${d.skipped} 张，当前总库 ${d.total} 张。` + (d.errors?.length ? `（部分失败：${d.errors[0]}）` : '');
        toast(`新增 ${d.added} 张表情包`);
        await loadAll();
      } else {
        status.textContent = '❌ 拉取失败：' + (r?.error || r?.message || '请检查网络');
        toast('拉取失败', 'err');
      }
    });

    // ─── AI Generator ────────────────────────────────────────────────────────
    const genWrap = $('#gen-emotion-chips');
    const genInput = $('#gen-custom-emotion');
    genWrap.innerHTML = GEN_EMOTIONS.map(([key, label]) =>
      `<button type="button" class="stk-tag-pill ${key === 'happy' ? 'active' : ''}" data-emo="${key}">${label}</button>`
    ).join('');
    genWrap.querySelectorAll('.stk-tag-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        genInput.value = btn.dataset.emo;
        genWrap.querySelectorAll('.stk-tag-pill').forEach(b => b.classList.toggle('active', b === btn));
      });
    });

    $('#btn-gen-sticker')?.addEventListener('click', async () => {
      const emotion = genInput.value.trim() || 'happy';
      const style = $('#gen-style').value;
      const promptHint = $('#gen-hint').value.trim();
      const btn = $('#btn-gen-sticker');
      const status = $('#gen-status');
      const preview = $('#gen-preview-box');
      btn.disabled = true;
      status.textContent = '🎨 正在按她的形象绘制专属 Q 版贴纸（大约 10–30 秒）…';
      preview.innerHTML = '<div class="w-8 h-8 rounded-full border-2 border-sakura-soft border-t-sakura-deep animate-spin mb-2"></div><span class="text-[12px] text-mute">绘制中…</span>';
      const r = await api('/api/stickers/generate', {
        method: 'POST', body: JSON.stringify({ companion_id: companionIdParam(), emotion, style, prompt_hint: promptHint }),
      });
      btn.disabled = false;
      if (r?.ok) {
        const item = r.data;
        status.textContent = `✅ 生成成功并已自动加入表情库（标签：#${item.emotion}）！`;
        preview.innerHTML = `<img src="${esc(item.url)}" alt="${esc(item.description || item.emotion)}" class="w-44 h-44 object-contain rounded-2xl mb-3" /><span class="pill">#${esc(item.emotion)}</span><p class="text-[12px] text-mute mt-1.5">${esc(item.description || '')}</p>`;
        toast('已生成专属表情包并入库');
        await loadAll();
      } else {
        status.textContent = '❌ ' + (r?.error || r?.message || '生成失败');
        preview.innerHTML = '<span class="text-[12px] text-rose-500">生成未完成，请确认已配置生图模型</span>';
      }
    });

    // ─── Wishlist ────────────────────────────────────────────────────────────
    function renderWishlist() {
      const wl = S.data?.wishlist || { auto_approve: false, items: [] };
      $('#wish-auto-approve').checked = Boolean(wl.auto_approve);
      const listEl = $('#wish-list');
      const emptyEl = $('#wish-empty');
      const items = wl.items || [];
      if (!items.length) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); return; }
      emptyEl.classList.add('hidden');
      listEl.innerHTML = items.map(w => `
        <div class="glass rounded-2xl p-4 flex flex-col sm:flex-row gap-3.5 items-start sm:items-center justify-between">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-14 h-14 rounded-2xl bg-cloud border border-line flex items-center justify-center shrink-0 overflow-hidden">
              ${w.candidate?.url ? `<img src="${esc(w.candidate.url)}" alt="${esc(w.tag)}" class="w-full h-full object-contain p-1" />` : '<span class="text-2xl opacity-60" aria-hidden="true">💭</span>'}
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-bold text-[14px]">#${esc(w.tag)}</span>
                <span class="text-[11px] px-2 py-0.5 rounded-full bg-sakura-soft text-sakura-deep font-semibold">想用 ${w.count || 1} 次</span>
                <span class="text-[11px] px-2 py-0.5 rounded-full ${w.candidate ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-mute'} font-semibold">${w.candidate ? '已找到候选' : '待收集'}</span>
              </div>
              <p class="text-[12px] text-mute mt-1 truncate">${esc(w.context || '聊天中触发的表情心愿')}</p>
            </div>
          </div>
          <div class="flex items-center gap-2 flex-wrap shrink-0">
            ${w.candidate ? `<button type="button" class="js-wish-approve stk-btn-primary !py-1.5 !px-3.5 text-[12px]" data-id="${esc(w.id)}">✅ 收下入库</button>` : ''}
            <button type="button" class="js-wish-collect stk-btn-outline !py-1.5 !px-3 text-[12px]" data-id="${esc(w.id)}" data-strategy="curated">🔍 ${w.candidate ? '换一张' : '精选库找'}</button>
            <button type="button" class="js-wish-collect stk-btn-outline !py-1.5 !px-3 text-[12px]" data-id="${esc(w.id)}" data-strategy="ai">✨ AI 画</button>
            <button type="button" class="js-wish-dismiss stk-btn-ghost text-[12px]" data-id="${esc(w.id)}">忽略</button>
          </div>
        </div>
      `).join('');

      listEl.querySelectorAll('.js-wish-collect').forEach(btn => {
        btn.addEventListener('click', async () => {
          const status = $('#wish-status');
          btn.disabled = true;
          status.textContent = btn.dataset.strategy === 'ai' ? '✨ 正在为这个心愿画一张候选表情…' : '🔍 正在精选图库寻找候选表情…';
          const r = await api(`/api/stickers/wishlist/${encodeURIComponent(btn.dataset.id)}/collect`, {
            method: 'POST', body: JSON.stringify({ strategy: btn.dataset.strategy, companion_id: companionIdParam() }),
          });
          btn.disabled = false;
          if (r?.ok) {
            status.textContent = r.data?.auto_approved ? '✅ 已自动收下并加入表情库！' : '✅ 已找到候选图，可预览后点「收下入库」。';
            toast(r.data?.auto_approved ? '已自动入库' : '已找到候选表情');
            await loadAll();
          } else status.textContent = '❌ ' + (r?.error || r?.message || '收集失败');
        });
      });
      listEl.querySelectorAll('.js-wish-approve').forEach(btn => {
        btn.addEventListener('click', async () => {
          const r = await api(`/api/stickers/wishlist/${encodeURIComponent(btn.dataset.id)}/approve`, { method: 'POST', body: '{}' });
          if (r?.ok) { toast('已收下并加入表情库'); await loadAll(); }
          else toast(r?.error || '入库失败', 'err');
        });
      });
      listEl.querySelectorAll('.js-wish-dismiss').forEach(btn => {
        btn.addEventListener('click', async () => {
          const r = await api(`/api/stickers/wishlist/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
          if (r?.ok) { toast('已移除心愿'); await loadAll(); }
        });
      });
    }

    $('#wish-auto-approve')?.addEventListener('change', async (e) => {
      const r = await api('/api/stickers/wishlist/settings', {
        method: 'POST', body: JSON.stringify({ auto_approve: e.target.checked }),
      });
      if (r?.ok) toast(e.target.checked ? '已开启自动入库' : '已切换为手动审核');
    });

    $('#wish-add-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#wish-tag-input');
      const tag = input.value.trim();
      if (!tag) return;
      const status = $('#wish-status');
      status.textContent = `正在把 #${tag} 加入心愿箱并尝试收集…`;
      const r = await api('/api/stickers/wishlist', {
        method: 'POST', body: JSON.stringify({ tag, companion_id: companionIdParam(), auto_collect: false }),
      });
      if (r?.ok) {
        input.value = '';
        const c = await api(`/api/stickers/wishlist/${encodeURIComponent(r.data.id)}/collect`, {
          method: 'POST', body: JSON.stringify({ strategy: 'curated', companion_id: companionIdParam() }),
        });
        status.textContent = c?.ok
          ? (c.data?.auto_approved ? `✅ #${tag} 已找到并自动入库！` : `✅ #${tag} 已找到候选图！`)
          : `已加入心愿箱（#${tag}），可点「✨ AI 画」为她定制一张。`;
        await loadAll();
      } else status.textContent = '❌ ' + (r?.error || '添加失败');
    });

    loadAll();
  }

  global.XiyuStickerStudio = { mount };

  // 独立 /app/stickers.html 自动挂载
  const standaloneRoot = document.getElementById('sticker-studio-standalone');
  if (standaloneRoot) mount(standaloneRoot, { standalone: true });
})(window);
