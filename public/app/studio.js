/* 溪语 AI · 个人抖音工作台（3-Tab 分栏工作台） */
(function () {
  'use strict';

  let companionId = '';
  let studioAllowed = true;
  let screenshotDataUrl = '';
  let screenshotMime = 'image/jpeg';
  let allDrafts = [];
  let activeFilter = 'all';
  let sidecarConfigured = false;
  const previewObjectUrls = [];
  let modalDownloadCtx = null;

  const params = new URLSearchParams(location.search);
  const initialFeedId = params.get('feedId') || '';

  const $ = (id) => document.getElementById(id);

  function getToken() {
    return localStorage.getItem('xiyu_token') || localStorage.getItem('jwt_token') || sessionStorage.getItem('jwt_token') || '';
  }

  function authHeaders(extra = {}) {
    const t = getToken();
    return { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...extra };
  }

  function showMsg(text, kind = 'info') {
    const el = $('msgBox');
    el.textContent = text;
    el.className = 'rounded-xl px-4 py-2.5 text-xs font-medium ' + (
      kind === 'err' ? 'bg-red-50 text-red-700 border border-red-200'
        : kind === 'ok' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
        : 'bg-sakura-soft text-sakura-deep border border-sakura/30'
    );
    el.classList.remove('hidden');
  }

  // ─── 3-Tab 切换 ─────────────────────────────────────────────────────────────
  function switchStudioTab(tabName) {
    const valid = ['works', 'comments', 'autonomy'].includes(tabName) ? tabName : 'works';
    document.querySelectorAll('[data-studio-tab]').forEach(btn => {
      const on = btn.dataset.studioTab === valid;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    for (const key of ['works', 'comments', 'autonomy']) {
      $('panel-' + key)?.classList.toggle('hidden', key !== valid);
    }
    try { localStorage.setItem('xiyu_studio_tab', valid); } catch {}
  }

  document.querySelectorAll('[data-studio-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchStudioTab(btn.dataset.studioTab));
  });

  const savedTab = params.get('tab') || (function () { try { return localStorage.getItem('xiyu_studio_tab'); } catch { return ''; } })();
  if (savedTab && !initialFeedId) switchStudioTab(savedTab);

  // ─── 鉴权媒体预览与下载 ─────────────────────────────────────────────────────
  function clearPreviewUrls() {
    while (previewObjectUrls.length) {
      try { URL.revokeObjectURL(previewObjectUrls.pop()); } catch {}
    }
  }

  async function fetchAuthedMediaBlobUrl(draftId, fileName) {
    const r = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/media/${encodeURIComponent(draftId)}/${encodeURIComponent(fileName)}`, {
      headers: authHeaders(),
    });
    if (!r.ok) throw new Error(`加载失败 (${r.status})`);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    previewObjectUrls.push(url);
    return url;
  }

  async function downloadAuthedMedia(draftId, fileName) {
    try {
      const r = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/media/${encodeURIComponent(draftId)}/${encodeURIComponent(fileName)}?download=1`, {
        headers: authHeaders(),
      });
      if (!r.ok) throw new Error(`下载失败 (${r.status})`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `draft_${draftId}_${fileName}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      showMsg(e.message || '文件下载失败', 'err');
    }
  }

  function openImageLightbox(blobUrl, draftId, fileName) {
    $('imgPreviewTarget').src = blobUrl;
    modalDownloadCtx = { draftId, fileName };
    $('imgPreviewModal').classList.remove('hidden');
  }

  function closeImageLightbox() {
    $('imgPreviewModal').classList.add('hidden');
    $('imgPreviewTarget').src = '';
    modalDownloadCtx = null;
  }

  $('imgPreviewClose').addEventListener('click', closeImageLightbox);
  $('imgPreviewModal').addEventListener('click', (e) => {
    if (e.target.id === 'imgPreviewModal') closeImageLightbox();
  });
  $('imgPreviewDownload').addEventListener('click', () => {
    if (modalDownloadCtx) downloadAuthedMedia(modalDownloadCtx.draftId, modalDownloadCtx.fileName);
  });

  // ─── 作品草稿筛选与渲染 ─────────────────────────────────────────────────────
  $('draftFilterBar').addEventListener('click', (e) => {
    const btn = e.target.closest('.draft-filter-btn');
    if (!btn) return;
    activeFilter = btn.dataset.filter || 'all';
    document.querySelectorAll('.draft-filter-btn').forEach(b => {
      const on = b.dataset.filter === activeFilter;
      b.className = 'draft-filter-btn px-3 py-1 text-xs rounded-full border ' + (
        on ? 'border-sakura bg-sakura-soft text-sakura-deep font-semibold' : 'border-line bg-white text-mute'
      );
    });
    renderDrafts(allDrafts);
  });

  function renderDrafts(drafts) {
    clearPreviewUrls();
    const box = $('draftList');
    box.innerHTML = '';
    const allList = Array.isArray(drafts) ? drafts : [];
    const activeList = allList.filter(d => d.status !== 'published' && d.status !== 'discarded');
    const pubList = allList.filter(d => d.status === 'published');
    $('cntAll').textContent = String(allList.length);
    $('cntActive').textContent = String(activeList.length);
    $('cntPublished').textContent = String(pubList.length);
    $('tabCntWorks').textContent = String(allList.length);

    const visible = activeFilter === 'published' ? pubList
      : activeFilter === 'active' ? activeList
      : allList;

    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'lg:col-span-2 card p-8 text-center text-xs text-mute';
      empty.textContent = activeFilter === 'published'
        ? '还没有已发布的作品归档。完成发布后点「标记已发布并回流日常」，就会归档到这里并写入她的记忆。'
        : '还没有抖音草稿，点上方「✨ 让她想一条」生成第一条吧。';
      box.appendChild(empty);
      return;
    }

    for (const d of visible) {
      const card = document.createElement('div');
      card.className = 'card p-4 flex flex-col gap-2.5';

      const head = document.createElement('div');
      head.className = 'flex items-center justify-between gap-2 flex-wrap';
      const title = document.createElement('div');
      title.className = 'font-bold text-ink text-[13.5px]';
      title.textContent = `#${d.id} · ${d.title || '无标题'}`;
      const statusLabel = d.status === 'published' ? '已发布'
        : d.status === 'ready' ? '素材就绪'
        : d.status === 'discarded' ? '已丢弃'
        : '草稿';
      const badge = document.createElement('span');
      badge.className = 'pill ' + (
        d.status === 'published' ? 'bg-emerald-50 text-emerald-700'
          : d.status === 'ready' ? 'bg-blue-50 text-blue-700'
          : d.status === 'discarded' ? 'bg-gray-100 text-mute'
          : 'bg-sakura-soft text-sakura-deep'
      );
      badge.textContent = `${d.format === 'voice_video' ? '配音视频' : '图文'} · ${statusLabel}`;
      head.append(title, badge);

      const caption = document.createElement('p');
      caption.className = 'text-xs text-ink whitespace-pre-wrap bg-cloud p-2.5 rounded-xl border border-line leading-relaxed';
      const tagsStr = (d.hashtags || []).map(t => `#${t}`).join(' ');
      caption.textContent = `${d.caption || ''}${tagsStr ? `\n\n${tagsStr}` : ''}`;

      const previewWrap = document.createElement('div');
      previewWrap.className = 'space-y-2';

      if ((d.media_paths || []).length) {
        const imgGrid = document.createElement('div');
        imgGrid.className = 'grid grid-cols-2 sm:grid-cols-3 gap-2';
        for (const imgFile of d.media_paths) {
          const tile = document.createElement('div');
          tile.className = 'bg-cloud rounded-xl border border-line overflow-hidden flex flex-col';
          const thumbBox = document.createElement('div');
          thumbBox.className = 'aspect-square bg-gray-50 flex items-center justify-center text-[11px] text-mute cursor-pointer overflow-hidden';
          thumbBox.textContent = '加载中…';
          const foot = document.createElement('div');
          foot.className = 'px-2 py-1 flex items-center justify-between text-[10px] border-t border-line bg-white';
          const lbl = document.createElement('span');
          lbl.className = 'text-mute truncate';
          lbl.textContent = imgFile;
          const dlBtn = document.createElement('button');
          dlBtn.type = 'button';
          dlBtn.className = 'text-sakura-deep font-semibold hover:underline shrink-0';
          dlBtn.textContent = '下载';
          dlBtn.addEventListener('click', () => downloadAuthedMedia(d.id, imgFile));
          foot.append(lbl, dlBtn);
          tile.append(thumbBox, foot);
          imgGrid.appendChild(tile);

          fetchAuthedMediaBlobUrl(d.id, imgFile)
            .then((blobUrl) => {
              thumbBox.innerHTML = '';
              const im = document.createElement('img');
              im.src = blobUrl;
              im.alt = imgFile;
              im.className = 'w-full h-full object-cover hover:scale-[1.03] transition-transform';
              thumbBox.title = '点击查看大图';
              thumbBox.addEventListener('click', () => openImageLightbox(blobUrl, d.id, imgFile));
              thumbBox.appendChild(im);
            })
            .catch(() => { thumbBox.textContent = '加载失败'; });
        }
        previewWrap.appendChild(imgGrid);
      }

      if (d.audio_path) {
        const audioRow = document.createElement('div');
        audioRow.className = 'p-2 rounded-xl bg-cloud border border-line flex items-center gap-2 flex-wrap';
        const audioEl = document.createElement('audio');
        audioEl.controls = true;
        audioEl.className = 'h-8 flex-1 min-w-[160px]';
        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'px-2.5 py-1 text-[11px] rounded-full border border-line bg-white hover:border-sakura';
        dlBtn.textContent = `🔊 ${d.audio_path}`;
        dlBtn.addEventListener('click', () => downloadAuthedMedia(d.id, d.audio_path));
        audioRow.append(audioEl, dlBtn);
        previewWrap.appendChild(audioRow);
        fetchAuthedMediaBlobUrl(d.id, d.audio_path).then((u) => { audioEl.src = u; }).catch(() => {});
      }

      if (d.video_path) {
        const videoBox = document.createElement('div');
        videoBox.className = 'p-2.5 rounded-xl bg-cloud border border-emerald-200 space-y-2';
        const videoEl = document.createElement('video');
        videoEl.controls = true;
        videoEl.playsInline = true;
        videoEl.className = 'w-full max-h-[280px] rounded-lg bg-black';
        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'px-3 py-1 text-[11px] rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold';
        dlBtn.textContent = `🎬 下载 9:16 视频 (${d.video_path})`;
        dlBtn.addEventListener('click', () => downloadAuthedMedia(d.id, d.video_path));
        videoBox.append(videoEl, dlBtn);
        previewWrap.appendChild(videoBox);
        fetchAuthedMediaBlobUrl(d.id, d.video_path).then((u) => { videoEl.src = u; }).catch(() => {});
      }

      const actions = document.createElement('div');
      actions.className = 'flex items-center gap-1.5 flex-wrap pt-1 mt-auto border-t border-line/60';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'px-2.5 py-1 text-[11px] rounded-full border border-line bg-white hover:border-sakura';
      copyBtn.textContent = '📋 复制文案';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(`${d.title}\n\n${caption.textContent}`);
          copyBtn.textContent = '已复制 ✓';
          setTimeout(() => { copyBtn.textContent = '📋 复制文案'; }, 1500);
        } catch {}
      });
      actions.appendChild(copyBtn);

      if (d.status !== 'discarded') {
        const renderBtn = document.createElement('button');
        renderBtn.type = 'button';
        renderBtn.className = 'px-2.5 py-1 text-[11px] rounded-full border border-sakura text-sakura-deep bg-white hover:bg-sakura-soft/40';
        renderBtn.textContent = (d.media_paths?.length || d.video_path) ? '🔄 重新合成' : '🎨 合成素材';
        renderBtn.addEventListener('click', async () => {
          renderBtn.disabled = true;
          renderBtn.textContent = '合成中…';
          try {
            const r = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/drafts/${d.id}/render`, {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
            });
            const j = await r.json();
            if (!r.ok || !j.ok) throw new Error(j.error || '合成失败');
            const notes = (j.data?.notices || []).join('；');
            showMsg(`草稿 #${d.id} 合成完成${notes ? `（提示：${notes}）` : ''}`, 'ok');
            await loadStudio();
          } catch (e) {
            showMsg(e.message || '合成失败', 'err');
          } finally {
            renderBtn.disabled = false;
          }
        });
        actions.appendChild(renderBtn);
      }

      if (d.status !== 'published' && d.status !== 'discarded') {
        if (sidecarConfigured) {
          const scPubBtn = document.createElement('button');
          scPubBtn.type = 'button';
          scPubBtn.className = 'px-2.5 py-1 text-[11px] rounded-full bg-indigo-50 text-indigo-600 border border-indigo-200 font-semibold hover:bg-indigo-100';
          scPubBtn.textContent = '🚀 Sidecar 推送';
          scPubBtn.addEventListener('click', async () => {
            scPubBtn.disabled = true;
            scPubBtn.textContent = '推送中…';
            try {
              const r = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/drafts/${d.id}/publish-sidecar`, {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({}),
              });
              const j = await r.json();
              if (!r.ok || !j.ok) throw new Error(j.error || 'Sidecar 推送失败');
              showMsg(`草稿 #${d.id}：${j.data?.detail || '已通过 Sidecar 推送'}`, 'ok');
              await loadStudio();
            } catch (e) {
              showMsg(e.message || 'Sidecar 推送失败', 'err');
              await loadAutonomy();
            } finally {
              scPubBtn.disabled = false;
              scPubBtn.textContent = '🚀 Sidecar 推送';
            }
          });
          actions.appendChild(scPubBtn);
        }

        const pubBtn = document.createElement('button');
        pubBtn.type = 'button';
        pubBtn.className = 'px-2.5 py-1 text-[11px] rounded-full bg-emerald-500 text-white hover:bg-emerald-600';
        pubBtn.textContent = '✅ 标记已发布';
        pubBtn.addEventListener('click', async () => {
          pubBtn.disabled = true;
          try {
            const r = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/drafts/${d.id}/mark-published`, {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ backflow: true }),
            });
            const j = await r.json();
            if (!r.ok || !j.ok) throw new Error(j.error || '操作失败');
            showMsg(`草稿 #${d.id} 已归档为已发布，并回流一条私聊日常记忆`, 'ok');
            await loadStudio();
          } catch (e) {
            showMsg(e.message || '标记失败', 'err');
          } finally {
            pubBtn.disabled = false;
          }
        });
        actions.appendChild(pubBtn);

        const discBtn = document.createElement('button');
        discBtn.type = 'button';
        discBtn.className = 'ml-auto px-2 py-1 text-[11px] text-mute hover:text-red-600';
        discBtn.textContent = '丢弃';
        discBtn.addEventListener('click', async () => {
          await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/drafts/${d.id}/discard`, {
            method: 'POST',
            headers: authHeaders(),
          });
          await loadStudio();
        });
        actions.appendChild(discBtn);
      } else if (d.status === 'published') {
        const pubInfo = document.createElement('span');
        pubInfo.className = 'text-[11px] text-emerald-700';
        const at = d.published_at ? String(d.published_at).replace('T', ' ').slice(0, 16) : '';
        pubInfo.innerHTML = `✅ 已发布${at ? ` (${at})` : ''}${d.backflow_done ? ' · <a href="/app/memories.html" class="underline font-semibold">查看记忆 →</a>' : ''}`;
        actions.appendChild(pubInfo);
      }

      card.append(head, caption);
      if (d.voice_script) {
        const sc = document.createElement('p');
        sc.className = 'text-[11px] text-mute';
        sc.textContent = `🎙️ 口播：${d.voice_script}`;
        card.appendChild(sc);
      }
      if (d.publish_error) {
        const er = document.createElement('p');
        er.className = 'text-[11px] text-amber-700 bg-amber-50 px-2.5 py-1 rounded-lg';
        er.textContent = `⚠️ ${d.publish_error}`;
        card.appendChild(er);
      }
      if (previewWrap.children.length) card.appendChild(previewWrap);
      card.appendChild(actions);
      box.appendChild(card);
    }
  }

  // ─── 评论巡检记录渲染 ───────────────────────────────────────────────────────
  function renderCommentLogs(logs) {
    const box = $('commentLogsList');
    box.innerHTML = '';
    const list = Array.isArray(logs) ? logs : [];
    $('tabCntComments').textContent = String(list.length);
    if (!list.length) {
      box.textContent = '暂无巡检或拟稿记录。';
      return;
    }
    for (const row of list) {
      const card = document.createElement('div');
      card.className = 'p-3 rounded-xl bg-cloud border border-line space-y-1.5';
      const top = document.createElement('div');
      top.className = 'flex items-center justify-between gap-2 flex-wrap';
      const who = document.createElement('span');
      who.className = 'font-semibold text-ink';
      who.textContent = `#${row.id} · ${row.author_name || (row.inbound_kind === 'dm' ? '私信网友' : '评论网友')}`;
      const st = row.reply_status || 'draft';
      const pill = document.createElement('span');
      pill.className = 'pill ' + (
        st === 'sent' ? 'bg-emerald-50 text-emerald-700'
          : st === 'ignored' ? 'bg-red-50 text-red-600'
          : st === 'pending' ? 'bg-amber-50 text-amber-700'
          : st === 'failed' ? 'bg-rose-50 text-rose-600'
          : 'bg-gray-100 text-mute'
      );
      pill.textContent = st === 'sent' ? '已回复'
        : st === 'ignored' ? '已拦截'
        : st === 'pending' ? '待审批'
        : st === 'failed' ? '发送失败'
        : '仅拟稿';
      top.append(who, pill);

      const inbound = document.createElement('div');
      inbound.className = 'text-ink leading-relaxed';
      inbound.textContent = `原话：${row.inbound_summary || '—'}`;
      card.append(top, inbound);

      if (row.sent_reply_text || row.chosen_reply) {
        const rep = document.createElement('div');
        rep.className = 'text-emerald-700';
        rep.textContent = `回复：${row.sent_reply_text || row.chosen_reply}`;
        card.appendChild(rep);
      }

      const rowActs = document.createElement('div');
      rowActs.className = 'flex items-center gap-2 flex-wrap pt-0.5';
      if (st === 'pending' && row.external_comment_id) {
        const sendBtn = document.createElement('button');
        sendBtn.type = 'button';
        sendBtn.className = 'px-2.5 py-1 rounded-full bg-emerald-500 text-white hover:bg-emerald-600 text-[11px]';
        sendBtn.textContent = '✅ 批准发送';
        sendBtn.addEventListener('click', async () => {
          sendBtn.disabled = true;
          try {
            const r = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/comments/${row.id}/send`, {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ reply_text: row.chosen_reply || '' }),
            });
            const j = await r.json();
            if (!r.ok || !j.ok) throw new Error(j.error || '发送失败');
            showMsg(`评论 #${row.id} 已通过 Sidecar 回复`, 'ok');
            await loadAutonomy();
          } catch (e) {
            showMsg(e.message || '发送失败', 'err');
            sendBtn.disabled = false;
          }
        });
        rowActs.appendChild(sendBtn);
      }
      if (!row.backflow_done && st !== 'ignored') {
        const bf = document.createElement('button');
        bf.type = 'button';
        bf.className = 'px-2.5 py-1 rounded-full border border-line bg-white hover:border-sakura text-[11px] text-ink';
        bf.textContent = '📌 回流趣事';
        bf.addEventListener('click', async () => {
          bf.disabled = true;
          const r = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/replies/${row.id}/backflow`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({}),
          });
          if (r.ok) await loadAutonomy();
          else bf.disabled = false;
        });
        rowActs.appendChild(bf);
      }
      if (rowActs.children.length) card.appendChild(rowActs);
      box.appendChild(card);
    }
  }

  // ─── 加载角色、草稿与 Sidecar 状态 ─────────────────────────────────────────
  async function resolveCompanionId() {
    const q = params.get('id');
    if (q) return q;
    const cached = localStorage.getItem('xiyu_companion_id');
    if (cached) return cached;
    const r = await fetch('/api/me/companion', { headers: authHeaders() });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok && j.data?.companion_id) {
      localStorage.setItem('xiyu_companion_id', String(j.data.companion_id));
      return String(j.data.companion_id);
    }
    return '';
  }

  function toggleSidecarModeFields() {
    const mode = $('scMode').value;
    $('scHttpFields').classList.toggle('hidden', mode !== 'http');
    $('scSauFields').classList.toggle('hidden', mode !== 'sau_cli');
  }
  $('scMode').addEventListener('change', toggleSidecarModeFields);

  async function loadAutonomy() {
    if (!companionId) return;
    try {
      const r = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/autonomy`, { headers: authHeaders() });
      const j = await r.json();
      if (!r.ok || !j.ok) return;
      const d = j.data || {};
      const sc = d.sidecar || {};
      const cfg = sc.config || {};
      sidecarConfigured = Boolean(sc.configured);

      $('scEnabled').checked = Boolean(sc.enabled);
      $('scMode').value = cfg.mode || 'http';
      $('scBaseUrl').value = cfg.base_url || '';
      $('scToken').placeholder = cfg.auth_token_set ? '已保存 Token（留空保持不变）' : '可选 Bearer Token';
      $('scSauBin').value = cfg.sau_bin || 'sau';
      $('scSauAccount').value = cfg.sau_account || 'default';
      $('scAutoPost').checked = Boolean(cfg.auto_post);
      $('scAutoPublish').checked = Boolean(cfg.auto_publish);
      $('scDraftOnly').checked = cfg.draft_only !== false;
      $('scDailyPostCap').value = String(cfg.daily_post_cap || 1);
      $('scCommentPatrol').checked = Boolean(cfg.comment_patrol_enabled);
      $('scAutoReply').checked = Boolean(cfg.auto_reply_comments);
      $('scReplyTone').value = cfg.reply_tone || 'friendly';
      $('scDailyReplyCap').value = String(cfg.daily_reply_cap || 15);
      toggleSidecarModeFields();

      const pill = $('sidecarStatusPill');
      if (sc.enabled && sc.configured) {
        pill.className = 'pill bg-emerald-50 text-emerald-700';
        pill.textContent = cfg.mode === 'sau_cli' ? 'Sidecar · sau CLI' : 'Sidecar · 在线运行';
      } else if (sc.configured) {
        pill.className = 'pill bg-blue-50 text-blue-700';
        pill.textContent = 'Sidecar · 手动模式';
      } else {
        pill.className = 'pill bg-gray-100 text-mute';
        pill.textContent = '未配置 Sidecar';
      }

      const st = d.state || {};
      const alertBox = $('sidecarAlertBox');
      if (st.sidecar_alert) {
        alertBox.textContent = `⚠️ ${st.sidecar_alert}`;
        alertBox.classList.remove('hidden');
      } else {
        alertBox.classList.add('hidden');
      }
      $('scPostStateNote').textContent = st.last_post_note
        ? `最近状态（今日已发 ${st.post_count_today || 0}）：${st.last_post_note}`
        : '尚未触发过自主发稿。';
      $('scCommentStateNote').textContent = st.last_comment_note
        ? `最近巡检（今日已回 ${st.reply_count_today || 0}）：${st.last_comment_note}`
        : '尚未巡检过评论区。';
      renderCommentLogs(d.comment_logs || []);
    } catch {}
  }

  async function loadStudio() {
    if (!getToken()) { location.href = '/app/auth.html'; return; }
    companionId = await resolveCompanionId();
    if (!companionId) { showMsg('未找到角色，请先创建 AI 角色。', 'err'); return; }
    $('companionBadge').textContent = `角色 #${companionId}`;
    try {
      const r = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/drafts`, { headers: authHeaders() });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || '加载失败');
      const data = j.data || {};
      studioAllowed = Boolean(data.studio_allowed);
      const ffBadge = $('ffmpegBadge');
      if (data.ffmpeg?.available) {
        ffBadge.className = 'hidden md:inline-flex pill bg-emerald-50 text-emerald-700';
        ffBadge.textContent = '✅ ffmpeg 就绪';
      } else {
        ffBadge.className = 'hidden md:inline-flex pill bg-amber-50 text-amber-700';
        ffBadge.textContent = '⚠️ 无 ffmpeg（图文+MP3）';
      }
      const lockEl = $('lockBanner');
      if (!studioAllowed) {
        lockEl.textContent = data.studio_lock_reason || '当前人设安全策略已锁定公域工作台。';
        lockEl.classList.remove('hidden');
        $('btnGenDraft').disabled = true;
        $('btnSuggest').disabled = true;
      } else {
        lockEl.classList.add('hidden');
      }
      allDrafts = data.drafts || [];
      await loadAutonomy();
      renderDrafts(allDrafts);
    } catch (e) {
      showMsg(e.message || '加载失败', 'err');
    }
  }

  // ─── 交互按钮事件 ───────────────────────────────────────────────────────────
  $('btnGenDraft').addEventListener('click', async () => {
    const btn = $('btnGenDraft');
    btn.disabled = true;
    btn.textContent = '构思中…';
    try {
      const body = {
        format: $('draftFormat').value,
        topic_hint: $('draftTopic').value.trim(),
      };
      if (initialFeedId) body.source_feed_id = Number(initialFeedId);
      const r = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/drafts/generate`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || '生成失败');
      showMsg('✨ 新草稿已生成（已完成公域隐私清洗）', 'ok');
      $('draftTopic').value = '';
      await loadStudio();
    } catch (e) {
      showMsg(e.message || '生成失败', 'err');
    } finally {
      btn.disabled = !studioAllowed;
      btn.textContent = '✨ 让她想一条';
    }
  });

  async function triggerAutonomousPost(btn, idleLabel) {
    btn.disabled = true;
    btn.textContent = '构思合成中…';
    try {
      const r = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/autonomy/run-post`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || '自主发稿试跑失败');
      const a = j.data?.action;
      showMsg(
        a === 'published' ? '🚀 她已自主构思、合成并发布到抖音！'
          : a === 'uploaded_draft' ? '📤 她已自主构思、合成并上传至抖音草稿箱！'
          : a === 'draft_ready' ? '✨ 她已自主构思并备好素材草稿，等待你审核。'
          : a === 'paused_needs_human' ? `⚠️ 草稿已备好，但 Sidecar 暂停：${j.data?.error || '需人工处理'}`
          : `这次她决定暂不发动态：${j.data?.reason || ''}`,
        a === 'paused_needs_human' ? 'err' : 'ok',
      );
      await loadStudio();
    } catch (e) {
      showMsg(e.message || '试跑失败', 'err');
    } finally {
      btn.disabled = !studioAllowed;
      btn.textContent = idleLabel;
    }
  }
  $('btnQuickAutoPost').addEventListener('click', () => triggerAutonomousPost($('btnQuickAutoPost'), '🚀 自主试跑'));
  $('btnRunAutoPost').addEventListener('click', () => triggerAutonomousPost($('btnRunAutoPost'), '试跑一次'));

  $('replyScreenshot').addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    const info = $('screenshotInfo');
    if (!file) { screenshotDataUrl = ''; info.textContent = ''; return; }
    if (file.size > 4 * 1024 * 1024) {
      showMsg('截图不能超过 4MB', 'err');
      ev.target.value = '';
      return;
    }
    screenshotMime = file.type || 'image/jpeg';
    const reader = new FileReader();
    reader.onload = () => {
      screenshotDataUrl = String(reader.result || '');
      info.textContent = `已选：${file.name} (${Math.round(file.size / 1024)} KB)`;
    };
    reader.readAsDataURL(file);
  });

  $('btnSuggest').addEventListener('click', async () => {
    const btn = $('btnSuggest');
    const box = $('suggestResult');
    btn.disabled = true;
    btn.textContent = '拟稿中…';
    try {
      const r = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/reply-suggest`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          inbound_kind: $('replyKind').value,
          inbound_text: $('replyInbound').value.trim(),
          screenshot_base64: screenshotDataUrl || undefined,
          screenshot_mime: screenshotMime,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || '拟稿失败');
      const d = j.data || {};
      box.innerHTML = '';
      box.classList.remove('hidden');

      if (d.extracted_text) {
        const ext = document.createElement('div');
        ext.className = 'text-[11px] text-mute bg-cloud p-2 rounded-lg border border-line';
        ext.textContent = `📷 截图识读：${d.extracted_text}`;
        box.appendChild(ext);
      }

      if (d.advisory === 'ignore_or_block') {
        const warn = document.createElement('div');
        warn.className = 'p-2.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 font-medium';
        warn.textContent = `🛡️ ${d.warning || '检测到可疑内容，建议忽略或拉黑。'}`;
        box.appendChild(warn);
        return;
      }

      for (const s of (d.suggestions || [])) {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between gap-2 p-2.5 rounded-xl bg-cloud border border-line text-xs';
        const left = document.createElement('div');
        const tag = document.createElement('span');
        tag.className = 'pill bg-sakura-soft text-sakura-deep mr-1.5';
        tag.textContent = s.label || s.tone;
        const txt = document.createElement('span');
        txt.className = 'text-ink';
        txt.textContent = s.text;
        left.append(tag, txt);

        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'px-2.5 py-1 text-[11px] rounded-full bg-white border border-line hover:border-sakura whitespace-nowrap';
        copy.textContent = '复制';
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(s.text);
            copy.textContent = '已复制 ✓';
            setTimeout(() => { copy.textContent = '复制'; }, 1500);
          } catch {}
        });
        row.append(left, copy);
        box.appendChild(row);
      }

      if (d.log_id) {
        const bfBtn = document.createElement('button');
        bfBtn.type = 'button';
        bfBtn.className = 'mt-1 px-3 py-1 text-[11px] rounded-full border border-sakura text-sakura-deep hover:bg-sakura-soft/40';
        bfBtn.textContent = '📌 把这条有趣互动单向记入她的今日生活';
        bfBtn.addEventListener('click', async () => {
          bfBtn.disabled = true;
          const br = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/replies/${d.log_id}/backflow`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({}),
          });
          const bj = await br.json().catch(() => ({}));
          if (br.ok && bj.ok) bfBtn.textContent = '✅ 已回流到她的今日生活记忆';
          else { bfBtn.disabled = false; showMsg(bj.error || '回流失败', 'err'); }
        });
        box.appendChild(bfBtn);
      }
      await loadAutonomy();
    } catch (e) {
      showMsg(e.message || '拟稿失败', 'err');
    } finally {
      btn.disabled = !studioAllowed;
      btn.textContent = '生成 3 档候选回复';
    }
  });

  $('btnSaveSidecar').addEventListener('click', async () => {
    const btn = $('btnSaveSidecar');
    btn.disabled = true;
    try {
      const tokenVal = $('scToken').value.trim();
      const payload = {
        enabled: $('scEnabled').checked,
        config: {
          mode: $('scMode').value,
          base_url: $('scBaseUrl').value.trim(),
          ...(tokenVal ? { auth_token: tokenVal } : {}),
          sau_bin: $('scSauBin').value.trim() || 'sau',
          sau_account: $('scSauAccount').value.trim() || 'default',
          auto_post: $('scAutoPost').checked,
          auto_publish: $('scAutoPublish').checked,
          draft_only: $('scDraftOnly').checked,
          daily_post_cap: Number($('scDailyPostCap').value) || 1,
          comment_patrol_enabled: $('scCommentPatrol').checked,
          auto_reply_comments: $('scAutoReply').checked,
          reply_tone: $('scReplyTone').value,
          daily_reply_cap: Number($('scDailyReplyCap').value) || 15,
        },
      };
      const r = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/autonomy`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || '保存失败');
      $('scToken').value = '';
      showMsg('✅ Sidecar 与自主运行配置已保存', 'ok');
      await loadAutonomy();
      renderDrafts(allDrafts);
    } catch (e) {
      showMsg(e.message || '保存失败', 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('btnTestSidecar').addEventListener('click', async () => {
    const msg = $('sidecarHealthMsg');
    msg.textContent = '正在检测 Sidecar 连通性与抖音登录态…';
    try {
      const r = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/sidecar/health`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const j = await r.json();
      const h = j.data || {};
      msg.className = 'text-xs ' + (h.ok && h.logged_in ? 'text-emerald-700 font-semibold' : 'text-amber-700');
      msg.textContent = `${h.ok && h.logged_in ? '✅' : '⚠️'} ${h.detail || j.error || '检测失败'}${h.account_name ? `（账号：${h.account_name}）` : ''}`;
    } catch (e) {
      msg.className = 'text-xs text-red-600';
      msg.textContent = `❌ ${e.message || '请求失败'}`;
    }
  });

  $('btnRunComments').addEventListener('click', async () => {
    const btn = $('btnRunComments');
    btn.disabled = true;
    btn.textContent = '巡检中…';
    try {
      const r = await fetch(`/api/companions/${encodeURIComponent(companionId)}/social/autonomy/run-comments`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ limit: 6 }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || '巡检失败');
      const d = j.data || {};
      showMsg(
        d.action === 'unsupported'
          ? `⚠️ ${d.reason}`
          : `🔍 巡检完成：自动回复 ${d.sent || 0} 条，待批 ${d.pending || 0} 条，拦截 ${d.ignored || 0} 条`,
        d.action === 'unsupported' ? 'err' : 'ok',
      );
      await loadAutonomy();
    } catch (e) {
      showMsg(e.message || '巡检失败', 'err');
    } finally {
      btn.disabled = !studioAllowed;
      btn.textContent = '🔍 立即巡检';
    }
  });

  if (initialFeedId) {
    $('draftTopic').placeholder = `已关联冲浪素材 #${initialFeedId}，可直接点「让她想一条」`;
  }

  loadStudio();
})();
