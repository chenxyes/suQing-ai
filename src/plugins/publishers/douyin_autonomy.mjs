/**
 * src/plugins/publishers/douyin_autonomy.mjs — suQing 自主发抖音 & 自主巡检回复评论引擎
 *
 * 设计红线：
 *  - 全程运行在 public_mode 公域隔离层，零读取 1v1 私人记忆/好感度/关系弧，零修改 companion_emotion_state
 *  - safe_mode=1 或未满 18 岁人设强制锁定，绝不自主发文、绝不自动回评论
 *  - 自主发稿采用「非机械随机窗口 + 她自己决定 skip/post + 硬日上限」，拒绝定时机器人感
 *  - 评论巡检严格按 external_comment_id 去重 + 提示词注入/骚扰拦截 + 出站双闸清洗 + 硬日上限
 *  - 遇到 LOGIN_REQUIRED / CAPTCHA_REQUIRED 时立即优雅暂停并写 sidecar_alert，绝不绕过验证码或刷屏重试
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from '../../logger.mjs';
import {
  getAllActiveCompanions,
  getDailySchedule,
  getActiveCurrentWorks,
  listCompanionFeedItems,
  getSocialAutonomyState,
  upsertSocialAutonomyState,
  getSocialDraftById,
  updateSocialDraft,
  getSocialReplyLogById,
  hasSocialReplyLogForComment,
  updateSocialReplyLog,
  shanghaiDateKey,
} from '../../db.mjs';
import { isSleepingNow } from '../../sleep.mjs';
import { extractStructuredInfo } from '../../ai.mjs';
import { isChatFallback } from '../../chat_response.mjs';
import {
  isPublicStudioAllowed,
  buildPublicPersonaPrompt,
  sanitizePublicOutboundText,
} from '../../public_persona.mjs';
import { isBusyActivity } from '../surf_engine.mjs';
import {
  generateDouyinDraft,
  renderDouyinDraftAssets,
  suggestPublicReplies,
  markDraftPublishedWithBackflow,
} from './douyin_studio.mjs';
import {
  getDouyinSidecarConfig,
  publishDraftViaSidecar,
  fetchUnrepliedCommentsViaSidecar,
  replyCommentViaSidecar,
} from './sidecar_bridge.mjs';

function parseJsonObject(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    const m = cleaned.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

function randomMsBetween(minMin, maxMin) {
  const mins = minMin + Math.floor(Math.random() * Math.max(1, maxMin - minMin + 1));
  return mins * 60_000;
}

function currentActivityText(schedule, now = new Date()) {
  if (!schedule || !Array.isArray(schedule.items) || !schedule.items.length) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const nowMin = Number(parts.find(p => p.type === 'hour')?.value || 0) * 60
    + Number(parts.find(p => p.type === 'minute')?.value || 0);
  let current = null;
  for (const it of schedule.items) {
    const m = String(it?.time || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const t = Number(m[1]) * 60 + Number(m[2]);
    if (t <= nowMin && (!current || t > current._t)) current = { ...it, _t: t };
  }
  return String(current?.activity || '');
}

/**
 * 手动通过 Sidecar 推送一条已有草稿（如未合成素材则自动先合成）。
 */
export async function publishExistingDraftViaSidecar(companion, draftId, { draftOnly, deps = {} } = {}) {
  const gate = isPublicStudioAllowed(companion);
  if (!gate.allowed) {
    throw Object.assign(new Error(gate.message || '当前人设不允许使用公域发布'), { code: 'FORBIDDEN' });
  }
  const sidecar = getDouyinSidecarConfig(companion.id);
  if (!sidecar.configured) {
    throw Object.assign(new Error('尚未配置外部 Sidecar 发布器（请先填写 HTTP 地址或 sau 账号）'), { code: 'NOT_CONFIGURED' });
  }
  let draft = getSocialDraftById(draftId);
  if (!draft || Number(draft.companion_id) !== Number(companion.id)) {
    throw Object.assign(new Error('草稿不存在'), { code: 'NOT_FOUND' });
  }
  if (!draft.video_path && !(draft.media_paths && draft.media_paths.length)) {
    const rendered = await renderDouyinDraftAssets(companion, draft, { deps });
    draft = rendered.draft;
  }

  try {
    const pub = await publishDraftViaSidecar(companion, draft, sidecar.config, { draftOnly, deps });
    updateSocialDraft(draft.id, {
      external_item_id: pub.external_item_id || null,
      publish_mode: pub.draft_only ? 'sidecar_draft' : 'sidecar_publish',
      publish_error: null,
    });
    upsertSocialAutonomyState(companion.id, { sidecar_alert: null });
    if (!pub.draft_only) {
      const done = markDraftPublishedWithBackflow(companion, draft.id, { backflow: true });
      return { ...pub, draft: done.draft, backflow_memory: done.backflow_memory };
    }
    return { ...pub, draft: getSocialDraftById(draft.id), backflow_memory: null };
  } catch (e) {
    updateSocialDraft(draft.id, { publish_error: String(e.message || 'Sidecar 发布失败').slice(0, 240) });
    if (e.needs_human_action) {
      upsertSocialAutonomyState(companion.id, { sidecar_alert: String(e.message || '').slice(0, 240) });
    }
    throw e;
  }
}

/**
 * 单角色一次「不定时自主发抖音」决策与执行周期。
 */
export async function runAutonomousDouyinPostForCompanion(companion, {
  now = new Date(),
  force = false,
  deps = {},
} = {}) {
  const gate = isPublicStudioAllowed(companion);
  if (!gate.allowed) {
    return { action: 'blocked', reason: gate.reason };
  }
  const sidecar = getDouyinSidecarConfig(companion.id);
  if (!force && (!sidecar.enabled || !sidecar.config.auto_post)) {
    return { action: 'skipped', reason: 'disabled' };
  }

  const nowMs = now.getTime();
  const todayKey = shanghaiDateKey(now);
  const state = getSocialAutonomyState(companion.id);
  const countToday = state?.post_count_date === todayKey ? (state.post_count_today || 0) : 0;

  if (!force && countToday >= sidecar.config.daily_post_cap) {
    upsertSocialAutonomyState(companion.id, {
      next_post_check_at: nowMs + randomMsBetween(180, 300),
      last_post_note: `今日自主发稿已达上限 (${countToday}/${sidecar.config.daily_post_cap})`,
    });
    return { action: 'skipped', reason: 'daily_cap' };
  }
  if (!force && state?.next_post_check_at && nowMs < state.next_post_check_at) {
    return { action: 'skipped', reason: 'not_due' };
  }
  if (!force && isSleepingNow(companion.id, nowMs)) {
    upsertSocialAutonomyState(companion.id, { next_post_check_at: nowMs + randomMsBetween(60, 120) });
    return { action: 'skipped', reason: 'sleeping' };
  }

  let dailySchedule = null;
  try { dailySchedule = getDailySchedule(companion.id, todayKey); } catch {}
  const act = currentActivityText(dailySchedule, now);
  if (!force && isBusyActivity(act)) {
    upsertSocialAutonomyState(companion.id, {
      next_post_check_at: nowMs + randomMsBetween(60, 150),
      last_post_note: `正在「${act.slice(0, 20)}」，暂不发抖音`,
    });
    return { action: 'skipped', reason: 'busy' };
  }

  // 公域隔离决策：由她自己决定此刻要不要发（skip vs post）
  let currentWorks = [];
  try { currentWorks = getActiveCurrentWorks(companion.id) || []; } catch {}
  let feedItems = [];
  try { feedItems = listCompanionFeedItems(companion.id, { status: 'fresh', limit: 4, includeExpired: false }); } catch {}

  const sysPrompt = buildPublicPersonaPrompt(companion, {
    platform: 'douyin',
    dailySchedule,
    currentWorks,
    feedItems,
  });
  const decPrompt = `现在你要决定此刻要不要发一条个人抖音日常动态（你今天已经发了 ${countToday} 条，每天最多 ${sidecar.config.daily_post_cap} 条）。
当前正在做的事：${act || '空闲放松中'}。
如果没有特别想分享的灵感，可以直接选 skip；如果有想随手记录的日常或刷到的趣事，选 post 并给出简短主题与载体（image_post 图文 或 voice_video 配音短视频）。
严格输出 JSON：
{
  "decision": "post" | "skip",
  "format": "image_post" | "voice_video",
  "topic_hint": "15-40字灵感方向（skip时可空）",
  "source_feed_id": null,
  "reason": "一句话内心理由"
}`;

  const rawDec = deps.decisionLlm
    ? await deps.decisionLlm(sysPrompt, decPrompt)
    : await extractStructuredInfo(sysPrompt, decPrompt, { maxTokens: 260, temperature: 0.85, role: 'aux' });

  const dec = parseJsonObject(rawDec);
  if (!dec || (!force && dec.decision !== 'post')) {
    const note = dec?.reason ? `决定暂不发：${String(dec.reason).slice(0, 80)}` : '这次没有发动态的冲动';
    upsertSocialAutonomyState(companion.id, {
      next_post_check_at: nowMs + randomMsBetween(120, 260),
      last_post_note: note,
    });
    return { action: 'skip', reason: note };
  }

  const format = dec.format === 'voice_video' ? 'voice_video' : 'image_post';
  const topicHint = String(dec.topic_hint || '').trim().slice(0, 100);
  const sourceFeedId = dec.source_feed_id ? Number(dec.source_feed_id) : (feedItems[0]?.id || null);

  // 1. 生成草稿
  const { draft } = await generateDouyinDraft(companion, {
    format,
    topicHint,
    sourceFeedId,
    deps: deps.draftDeps || deps,
  });

  // 2. 合成素材（配图 / 配音 / 可选 ffmpeg 9:16 MP4）
  const rendered = await renderDouyinDraftAssets(companion, draft, { deps: deps.renderDeps || deps });
  let finalDraft = rendered.draft;
  let publishResult = null;
  let backflowMemory = null;

  // 3. 若开启自动推送 Sidecar 且已配置，则自动推送
  if (sidecar.config.auto_publish && sidecar.configured && (finalDraft.video_path || finalDraft.media_paths?.length)) {
    try {
      publishResult = await publishDraftViaSidecar(companion, finalDraft, sidecar.config, {
        draftOnly: sidecar.config.draft_only,
        deps: deps.sidecarDeps || deps,
      });
      updateSocialDraft(finalDraft.id, {
        external_item_id: publishResult.external_item_id || null,
        publish_mode: publishResult.draft_only ? 'sidecar_draft' : 'sidecar_publish',
        publish_error: null,
      });
      if (!publishResult.draft_only) {
        const done = markDraftPublishedWithBackflow(companion, finalDraft.id, { backflow: true });
        finalDraft = done.draft;
        backflowMemory = done.backflow_memory;
      } else {
        finalDraft = getSocialDraftById(finalDraft.id);
      }
      upsertSocialAutonomyState(companion.id, { sidecar_alert: null });
    } catch (e) {
      log('warn', `[DouyinAutonomy] Sidecar 自动发布暂停 companion=${companion.id} draft=${finalDraft.id}: ${e.message}`);
      updateSocialDraft(finalDraft.id, { publish_error: String(e.message || 'Sidecar 发布失败').slice(0, 240) });
      upsertSocialAutonomyState(companion.id, {
        next_post_check_at: nowMs + randomMsBetween(180, 360),
        last_post_note: `草稿 #${finalDraft.id} 已备好，但 Sidecar 暂停：${String(e.message || '').slice(0, 80)}`,
        ...(e.needs_human_action ? { sidecar_alert: String(e.message || '').slice(0, 240) } : {}),
      });
      return {
        action: 'paused_needs_human',
        draft: getSocialDraftById(finalDraft.id),
        error: e.message,
        needs_human_action: Boolean(e.needs_human_action),
      };
    }
  }

  const nextCount = countToday + 1;
  const note = publishResult
    ? (publishResult.draft_only ? `已自主上传草稿 #${finalDraft.id} 至抖音草稿箱` : `已自主发布作品 #${finalDraft.id} 到抖音`)
    : `已自主构思并备好素材草稿 #${finalDraft.id}（待你审核）`;

  upsertSocialAutonomyState(companion.id, {
    next_post_check_at: nowMs + randomMsBetween(180, 360),
    last_post_at: nowMs,
    post_count_today: nextCount,
    post_count_date: todayKey,
    last_post_note: note,
  });

  log('info', `[DouyinAutonomy] companion=${companion.id} ${note}`);
  return {
    action: publishResult ? (publishResult.draft_only ? 'uploaded_draft' : 'published') : 'draft_ready',
    draft: finalDraft,
    publish: publishResult,
    backflow_memory: backflowMemory,
    notices: rendered.notices || [],
  };
}

/**
 * 单角色一次「抖音评论区巡检与回复」周期。
 * 红线：绝不修改 1v1 情绪/好感度；恶意/注入评论强制忽略；按 external_comment_id 幂等去重。
 */
export async function runAutonomousCommentPatrolForCompanion(companion, {
  now = new Date(),
  force = false,
  limit = 6,
  deps = {},
} = {}) {
  const gate = isPublicStudioAllowed(companion);
  if (!gate.allowed) {
    return { action: 'blocked', reason: gate.reason, processed: 0 };
  }
  const sidecar = getDouyinSidecarConfig(companion.id);
  if (!force && (!sidecar.enabled || !sidecar.config.comment_patrol_enabled)) {
    return { action: 'skipped', reason: 'disabled', processed: 0 };
  }

  const nowMs = now.getTime();
  const todayKey = shanghaiDateKey(now);
  const state = getSocialAutonomyState(companion.id);
  const repliedToday = state?.reply_count_date === todayKey ? (state.reply_count_today || 0) : 0;

  if (!force && repliedToday >= sidecar.config.daily_reply_cap) {
    upsertSocialAutonomyState(companion.id, {
      next_comment_check_at: nowMs + randomMsBetween(60, 120),
      last_comment_note: `今日评论回复已达上限 (${repliedToday}/${sidecar.config.daily_reply_cap})`,
    });
    return { action: 'skipped', reason: 'daily_cap', processed: 0 };
  }
  if (!force && state?.next_comment_check_at && nowMs < state.next_comment_check_at) {
    return { action: 'skipped', reason: 'not_due', processed: 0 };
  }

  let fetched;
  try {
    fetched = await fetchUnrepliedCommentsViaSidecar(sidecar.config, { limit, deps: deps.sidecarDeps || deps });
  } catch (e) {
    if (e.needs_human_action) {
      upsertSocialAutonomyState(companion.id, {
        sidecar_alert: String(e.message || '').slice(0, 240),
        next_comment_check_at: nowMs + randomMsBetween(60, 120),
        last_comment_note: `评论巡检暂停：${String(e.message || '').slice(0, 80)}`,
      });
    }
    throw e;
  }

  if (!fetched.supported) {
    upsertSocialAutonomyState(companion.id, {
      next_comment_check_at: nowMs + randomMsBetween(60, 120),
      last_comment_note: fetched.reason,
    });
    return { action: 'unsupported', reason: fetched.reason, processed: 0 };
  }

  let sentCount = 0;
  let pendingCount = 0;
  let ignoredCount = 0;
  let dedupSkipped = 0;
  const details = [];
  let runningTotal = repliedToday;

  for (const cm of fetched.items) {
    if (hasSocialReplyLogForComment(companion.id, cm.comment_id)) {
      dedupSkipped++;
      continue;
    }
    if (sidecar.config.auto_reply_comments && runningTotal >= sidecar.config.daily_reply_cap) {
      break;
    }

    const inboundLine = cm.item_title
      ? `（作品《${cm.item_title}》下）${cm.author_name}：${cm.text}`
      : `${cm.author_name}：${cm.text}`;

    const sug = await suggestPublicReplies(companion, {
      inboundKind: 'comment',
      inboundText: inboundLine,
      deps: deps.replyDeps || deps,
    });

    if (sug.advisory === 'ignore_or_block') {
      if (sug.log_id) {
        updateSocialReplyLog(sug.log_id, {
          external_comment_id: cm.comment_id,
          external_item_id: cm.item_id,
          author_name: cm.author_name,
          reply_status: 'ignored',
        });
      }
      ignoredCount++;
      details.push({ comment_id: cm.comment_id, status: 'ignored', reason: sug.warning });
      continue;
    }

    const preferredTone = sidecar.config.reply_tone || 'friendly';
    const picked = (sug.suggestions || []).find(s => s.tone === preferredTone) || sug.suggestions?.[0];
    const cleanReply = sanitizePublicOutboundText(picked?.text || '').text;

    if (!cleanReply || isChatFallback(cleanReply)) {
      if (sug.log_id) {
        updateSocialReplyLog(sug.log_id, {
          external_comment_id: cm.comment_id,
          external_item_id: cm.item_id,
          author_name: cm.author_name,
          reply_status: 'pending',
        });
      }
      pendingCount++;
      continue;
    }

    if (sidecar.config.auto_reply_comments) {
      try {
        await replyCommentViaSidecar(sidecar.config, {
          comment_id: cm.comment_id,
          item_id: cm.item_id,
          text: cleanReply,
        }, { deps: deps.sidecarDeps || deps });
        if (sug.log_id) {
          updateSocialReplyLog(sug.log_id, {
            external_comment_id: cm.comment_id,
            external_item_id: cm.item_id,
            author_name: cm.author_name,
            chosen_reply: cleanReply,
            sent_reply_text: cleanReply,
            reply_status: 'sent',
          });
        }
        sentCount++;
        runningTotal++;
        details.push({ comment_id: cm.comment_id, status: 'sent', reply: cleanReply });
      } catch (e) {
        if (sug.log_id) {
          updateSocialReplyLog(sug.log_id, {
            external_comment_id: cm.comment_id,
            external_item_id: cm.item_id,
            author_name: cm.author_name,
            chosen_reply: cleanReply,
            reply_status: 'failed',
          });
        }
        if (e.needs_human_action) {
          upsertSocialAutonomyState(companion.id, { sidecar_alert: String(e.message || '').slice(0, 240) });
          break;
        }
      }
    } else {
      if (sug.log_id) {
        updateSocialReplyLog(sug.log_id, {
          external_comment_id: cm.comment_id,
          external_item_id: cm.item_id,
          author_name: cm.author_name,
          chosen_reply: cleanReply,
          reply_status: 'pending',
        });
      }
      pendingCount++;
      details.push({ comment_id: cm.comment_id, status: 'pending', reply: cleanReply });
    }
  }

  const note = `巡检 ${fetched.items.length} 条：已自动回 ${sentCount}、待审批 ${pendingCount}、安全拦截 ${ignoredCount}、跳过已处理 ${dedupSkipped}`;
  upsertSocialAutonomyState(companion.id, {
    next_comment_check_at: nowMs + randomMsBetween(20, 50),
    last_comment_check_at: nowMs,
    reply_count_today: runningTotal,
    reply_count_date: todayKey,
    last_comment_note: note,
    ...(sentCount > 0 || fetched.items.length >= 0 ? { sidecar_alert: null } : {}),
  });

  log('info', `[DouyinComments] companion=${companion.id} ${note}`);
  return {
    action: 'patrolled',
    processed: sentCount + pendingCount + ignoredCount,
    sent: sentCount,
    pending: pendingCount,
    ignored: ignoredCount,
    dedup_skipped: dedupSkipped,
    details,
  };
}

/**
 * 人工审批后，把一条 pending 评论回复通过 Sidecar 发出。
 */
export async function sendPendingCommentReply(companion, logId, { replyText = '', deps = {} } = {}) {
  const gate = isPublicStudioAllowed(companion);
  if (!gate.allowed) throw Object.assign(new Error(gate.message || '当前人设不允许使用公域回复'), { code: 'FORBIDDEN' });

  const row = getSocialReplyLogById(logId);
  if (!row || Number(row.companion_id) !== Number(companion.id)) {
    throw Object.assign(new Error('评论记录不存在'), { code: 'NOT_FOUND' });
  }
  if (!row.external_comment_id) {
    throw Object.assign(new Error('该条记录不是 Sidecar 抓取的抖音评论，请复制后手动回复'), { code: 'BAD_INPUT' });
  }
  const sidecar = getDouyinSidecarConfig(companion.id);
  const textToSend = sanitizePublicOutboundText(replyText || row.chosen_reply || row.suggestions?.[0]?.text || '').text;
  if (!textToSend) throw Object.assign(new Error('回复内容不能为空'), { code: 'BAD_INPUT' });

  const res = await replyCommentViaSidecar(sidecar.config, {
    comment_id: row.external_comment_id,
    item_id: row.external_item_id,
    text: textToSend,
  }, { deps });

  const updated = updateSocialReplyLog(row.id, {
    chosen_reply: textToSend,
    sent_reply_text: textToSend,
    reply_status: 'sent',
  });
  upsertSocialAutonomyState(companion.id, { sidecar_alert: null });
  return { log: updated, ...res };
}

let _tickBusy = false;
/**
 * 挂入 plan_tasks.mjs 的轻量心跳（仅处理显式开启了 publisher.douyin_sidecar 的角色）。
 */
export async function runAutonomousDouyinTick(now = new Date()) {
  if (_tickBusy) return { skipped: 'busy' };
  _tickBusy = true;
  try {
    const companions = getAllActiveCompanions();
    for (const comp of companions) {
      try {
        const sidecar = getDouyinSidecarConfig(comp.id);
        if (!sidecar.enabled) continue;
        if (sidecar.config.auto_post) {
          await runAutonomousDouyinPostForCompanion(comp, { now });
        }
        if (sidecar.config.comment_patrol_enabled) {
          await runAutonomousCommentPatrolForCompanion(comp, { now });
        }
      } catch (e) {
        log('warn', `[DouyinAutonomy] tick companion=${comp.id} failed: ${e.message}`);
      }
    }
  } finally {
    _tickBusy = false;
  }
}
