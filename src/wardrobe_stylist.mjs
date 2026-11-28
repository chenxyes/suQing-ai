/**
 * 衣橱主理人自主搭配引擎（SuQing Wardrobe Stylist Autonomy）
 *
 * 衣橱属于苏晴本人——她不仅能响应你的送礼换装，还能作为主理人自己决定：
 *   1. 穿什么衣服 / 怎么叠穿（结合当前季节、今日日程、心情、场合与久未穿的宝贝）
 *   2. 摆什么姿势（从单人姿势库里挑选最契合当天穿搭与情绪的姿势）
 *   3. 说出她的第一人称「今日搭配小心思」并写入主理人穿搭笔记
 *
 * 严格零禁用称谓（绝不出现“用户”字眼）。
 */
import {
  listWardrobeItems,
  createWardrobeItem,
  wearWardrobeItem,
  findWardrobeItemByPreset,
  getAppSetting,
  setAppSetting,
  getDailySchedule,
  shanghaiDateKey,
  getAllActiveCompanions,
} from './db.mjs';
import { extractStructuredInfo } from './ai.mjs';
import { listPoses, listOutfitPresets, getPoseById, getOutfitPresetById } from './pose_outfit_library.mjs';
import { isFullOutfitItem, saveWardrobeProductImage, normalizeWardrobeSlot } from './wardrobe.mjs';
import { readAssetBuffer } from './storage.mjs';
import { log } from './logger.mjs';

const STYLIST_NOTE_KEY = (companionId) => `wardrobe_stylist_note:${companionId}`;

export function getWardrobeStylistNote(companionId) {
  if (!companionId) return null;
  try {
    const raw = getAppSetting(STYLIST_NOTE_KEY(companionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveWardrobeStylistNote(companionId, payload) {
  if (!companionId || !payload) return null;
  const record = {
    note: String(payload.note || '').trim().slice(0, 140),
    poseId: payload.poseId || null,
    poseLabel: String(payload.poseLabel || '').trim().slice(0, 24),
    itemIds: Array.isArray(payload.itemIds) ? payload.itemIds : [],
    itemNames: Array.isArray(payload.itemNames) ? payload.itemNames.slice(0, 6) : [],
    occasion: String(payload.occasion || '').trim().slice(0, 40),
    decidedAt: payload.decidedAt || new Date().toISOString(),
  };
  setAppSetting(STYLIST_NOTE_KEY(companionId), JSON.stringify(record));
  return record;
}

/**
 * 识别对话中“把穿搭/姿势决定权交给苏晴自己”的自然意图（微信 + 网页共享）。
 */
export function detectAutonomousStyleRequest(text = '') {
  const s = String(text || '').trim();
  if (!s || s.length > 120) return null;
  const hit = /(今天穿什么|穿什么|怎么搭|换[身套件].{0,6}(?:衣服|穿搭)).{0,8}(你自己决定|你决定|你看着办|你随便挑|你自己挑|你自己搭|按你心情|由你决定)/u.test(s)
    || /(你自己|你来|按你心情|随便).{0,6}(挑|选|搭|搭配|换).{0,8}(衣服|穿搭|造型|OOTD|ootd|裙子|外套)/u.test(s)
    || /衣橱主理人|今天想穿什么自己换|换一身你喜欢的/u.test(s);
  if (!hit) return null;
  return {
    kind: 'autonomous_style',
    wantPhoto: /拍|看看|自拍|照片|上身|发我|给我看|晒/u.test(s),
    occasion: s.slice(0, 40),
  };
}

/**
 * 识别对话中“想看她今日穿搭照片”的自然口令（微信 + 网页双端共享）。
 */
export function detectTodayOotdPhotoRequest(text = '') {
  const s = String(text || '').trim();
  if (!s || s.length > 100) return null;
  const hit = /(拍|发|给|看看|瞅瞅|晒).{0,10}(今日穿搭|今天穿[的了啥什么]|今天这身|OOTD|ootd)/u.test(s)
    || /(今日穿搭|今天穿[的了啥什么]|今天这身|OOTD|ootd).{0,10}(拍|发|照片|自拍|看看|给我看)/u.test(s);
  if (!hit) return null;
  return { kind: 'today_ootd_photo' };
}

function currentSeasonZh(now = new Date()) {
  const month = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', month: 'numeric' }).format(now));
  if (month >= 3 && month <= 5) return '春季';
  if (month >= 6 && month <= 8) return '夏季';
  if (month >= 9 && month <= 11) return '秋季';
  return '冬季';
}

function pickFallbackOutfitAndPose({ wardrobeItems, presets, poses, season, mood }) {
  // 优先从衣橱已有且当前没在穿的单品中挑一套新鲜组合；若衣橱单品 < 2 件则从应季灵感库挑一套新衣服
  const ownedPool = wardrobeItems.filter(it => it.status === 'owned');
  let chosenWardrobeIds = [];
  let chosenPresetId = null;

  if (ownedPool.length >= 2) {
    // 优先选不同槽位且最少穿过的 1-2 件叠穿（若是整套穿搭则单选它）
    const sorted = [...ownedPool].sort((a, b) => (Number(a.wear_count || 0) - Number(b.wear_count || 0)));
    const first = sorted[0];
    if (isFullOutfitItem(first)) {
      chosenWardrobeIds = [first.id];
    } else {
      chosenWardrobeIds = [first.id];
      const second = sorted.find(x => x.id !== first.id && x.slot !== first.slot && !isFullOutfitItem(x));
      if (second) chosenWardrobeIds.push(second.id);
    }
  } else if (presets.length > 0) {
    const seasonal = presets.filter(p => p.color === season || (p.styleTags || []).includes(season));
    const pool = seasonal.length ? seasonal : presets;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    chosenPresetId = pick.id;
  } else if (wardrobeItems.length > 0) {
    chosenWardrobeIds = [wardrobeItems[0].id];
  }

  const chosenPose = poses.length ? poses[Math.floor(Math.random() * poses.length)] : null;
  const moodWord = mood || '轻松';
  const note = chosenPresetId
    ? `今天是${season}，心情${moodWord}，我想试试衣橱灵感库里这身新搭配，再摆个「${chosenPose?.label || '自然'}」姿势拍给你看～`
    : `今天想换个新鲜感觉，自己从衣橱里挑了这身搭配，配上「${chosenPose?.label || '自然'}」姿势应该挺出片的！`;

  return { chosenWardrobeIds, chosenPresetId, poseId: chosenPose?.id || null, note };
}

function parseStylistJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { /* ignore */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* ignore */ }
  }
  return null;
}

/**
 * 由苏晴作为衣橱主理人自主决策今天的穿搭组合、拍照姿势与搭配笔记，并立即换上生效。
 */
export async function decideSuQingOutfitAndPose(companion, {
  occasion = '',
  allowPresets = true,
  now = new Date(),
} = {}, deps = {}) {
  if (!companion?.id) throw new Error('missing companion');
  const season = currentSeasonZh(now);
  const mood = String(companion.current_mood || '开心').trim();
  const wardrobeItems = listWardrobeItems(companion.id, { status: ['wearing', 'owned'], limit: 40 }) || [];
  const allPresets = allowPresets ? listOutfitPresets() : [];
  const allPoses = listPoses({ kind: 'solo' });

  // 采样候选控制上下文体积（保持 LLM 响应快且多样）
  const seasonalPresets = allPresets.filter(p => p.color === season || (p.styleTags || []).includes(season));
  const presetPool = [...seasonalPresets.slice(0, 14), ...allPresets.filter(p => !seasonalPresets.includes(p)).slice(0, 10)].slice(0, 20);
  const posePool = allPoses.slice(0, 28);

  let todayScheduleText = '';
  try {
    const sched = getDailySchedule(companion.id, shanghaiDateKey(now));
    if (Array.isArray(sched?.items) && sched.items.length) {
      todayScheduleText = sched.items.slice(0, 4).map(it => `${it.time || ''} ${it.activity || ''}`.trim()).join('；');
    }
  } catch { /* non-blocking */ }

  let decision = null;
  const askLlm = deps.extractJson || extractStructuredInfo;
  if (wardrobeItems.length > 0 || presetPool.length > 0) {
    const closetSummary = wardrobeItems.slice(0, 20).map(it =>
      `id:${it.id} [${it.slot}/${it.status}/穿${it.wear_count || 0}次${it.gifted_by === 'user' ? '/他送的' : ''}] ${it.name}${it.color ? `(${it.color})` : ''}`,
    ).join('\n');
    const presetSummary = presetPool.map(p =>
      `preset:${p.id} [${p.slot}/${p.color || p.category}] ${p.name}`,
    ).join('\n');
    const poseSummary = posePool.map(p =>
      `pose:${p.id} [${p.framingLabel || p.tag}] ${p.label}`,
    ).join('\n');

    const prompt = [
      `你是${companion.name || '苏晴'}，现在是你自己衣橱的主理人。请结合当前季节（${season}）、你现在的心情（${mood}）${todayScheduleText ? `、今日安排（${todayScheduleText}）` : ''}${occasion ? `、对方提到的场景需求（${occasion}）` : ''}，自主决定今天要穿哪一套衣服（可从已有衣橱挑 1-3 件不同槽位叠穿，也可以直接从灵感库挑一套新衣服），并选一个最搭的拍照姿势！`,
      '原则：尽量换一身和当前在穿不同的新鲜造型；如果有他送过但好久没穿的宝贝可以优先宠幸。',
      closetSummary ? `【你已有衣橱】\n${closetSummary}` : '【你已有衣橱】暂时空着，请直接从灵感库选一套。',
      presetSummary ? `【服装灵感库】\n${presetSummary}` : '',
      poseSummary ? `【姿势库】\n${poseSummary}` : '',
      '只返回严格 JSON：',
      '{"source":"wardrobe|preset","wardrobe_ids":[数字ID],"preset_id":"预设ID或空字符串","pose_id":"姿势ID","stylist_note":"用第一人称自然口吻写20-55字今日搭配小心思（像发朋友圈或跟对象撒娇分享穿搭）"}',
    ].filter(Boolean).join('\n\n');

    try {
      const raw = await askLlm(prompt, { maxTokens: 280 });
      const parsed = parseStylistJson(typeof raw === 'string' ? raw : JSON.stringify(raw || ''));
      if (parsed && typeof parsed === 'object') {
        const validIds = Array.isArray(parsed.wardrobe_ids)
          ? parsed.wardrobe_ids.map(Number).filter(id => wardrobeItems.some(w => w.id === id))
          : [];
        const validPreset = typeof parsed.preset_id === 'string' && presetPool.some(p => p.id === parsed.preset_id)
          ? parsed.preset_id
          : null;
        const validPose = typeof parsed.pose_id === 'string' && getPoseById(parsed.pose_id)
          ? parsed.pose_id
          : null;
        if (validIds.length > 0 || validPreset) {
          decision = {
            chosenWardrobeIds: parsed.source === 'preset' && validPreset ? [] : validIds,
            chosenPresetId: (parsed.source === 'preset' || !validIds.length) ? validPreset : null,
            poseId: validPose || posePool[0]?.id || null,
            note: String(parsed.stylist_note || '').trim().slice(0, 120),
          };
        }
      }
    } catch (e) {
      log('warn', `[WardrobeStylist] LLM 自主搭配降级本地策略 companion=${companion.id}: ${e.message}`);
    }
  }

  if (!decision) {
    decision = pickFallbackOutfitAndPose({
      wardrobeItems,
      presets: presetPool,
      poses: posePool,
      season,
      mood,
    });
  }

  // 执行换装落地（确保旧在穿衣服干净脱下，换上苏晴自己选好的造型）
  let appliedItems = [];
  if (decision.chosenPresetId) {
    const preset = getOutfitPresetById(decision.chosenPresetId);
    if (preset) {
      const existing = findWardrobeItemByPreset(companion.id, preset);
      if (existing) {
        const worn = wearWardrobeItem(companion.id, existing.id, { replaceAllWearing: true });
        if (worn) appliedItems = [worn];
      } else {
        let sourceImagePath = null;
        if (preset.imageRef) {
          try {
            const asset = await readAssetBuffer(preset.imageRef);
            if (asset?.buffer?.length) {
              sourceImagePath = saveWardrobeProductImage(companion.id, asset.buffer, asset.contentType || 'image/jpeg');
            }
          } catch { /* non-blocking */ }
        }
        const created = createWardrobeItem({
          companionId: companion.id,
          slot: preset.slot,
          category: preset.category,
          name: preset.name,
          color: preset.color,
          material: preset.material,
          styleTags: preset.styleTags,
          visualPrompt: preset.visualPrompt,
          sourceImagePath,
          sourcePublicUrl: preset.publicUrl || null,
          presetId: preset.id,
          giftedBy: 'self',
          giftedNote: `${companion.name || '苏晴'}自己挑的今日穿搭`,
          status: 'wearing',
          replaceAllWearing: true,
        });
        appliedItems = [created];
      }
    }
  } else if (decision.chosenWardrobeIds.length > 0) {
    const bySlot = new Map();
    for (const wid of decision.chosenWardrobeIds) {
      const found = wardrobeItems.find(w => w.id === wid);
      if (found) bySlot.set(normalizeWardrobeSlot(found.slot, found.category, found.name), found);
    }
    const picked = [...bySlot.values()].slice(0, 3);
    for (let i = 0; i < picked.length; i++) {
      const worn = wearWardrobeItem(companion.id, picked[i].id, {
        replaceAllWearing: i === 0, // 第一件先脱下旧穿搭，后续件叠加在上面
      });
      if (worn) appliedItems.push(worn);
    }
  }

  const chosenPose = decision.poseId ? getPoseById(decision.poseId) : (posePool[0] || null);
  const finalNote = decision.note
    || `今天选了「${appliedItems.map(i => i.name).join(' + ') || '今日穿搭'}」，搭个「${chosenPose?.label || '自然'}」姿势刚刚好～`;

  const stylistRecord = saveWardrobeStylistNote(companion.id, {
    note: finalNote,
    poseId: chosenPose?.id || null,
    poseLabel: chosenPose?.label || '',
    itemIds: appliedItems.map(i => i.id),
    itemNames: appliedItems.map(i => i.name),
    occasion,
    decidedAt: now.toISOString(),
  });

  log('info', `[WardrobeStylist] autonomous pick companion=${companion.id} items=[${appliedItems.map(i => i.id).join(',')}] pose=${chosenPose?.id || 'auto'}`);
  return {
    items: appliedItems,
    pose: chosenPose,
    stylistNote: stylistRecord,
  };
}

/**
 * 每日晨间自主换装定时任务（由 plan_tasks.mjs 每天 07:30 触发，零生图成本）：
 * 苏晴早上起床后自己看今天日程和季节挑好今天要穿的衣服。
 */
export async function runDailyMorningOotdTick(now = new Date(), deps = {}) {
  const companions = getAllActiveCompanions();
  let styled = 0;
  for (const c of companions) {
    try {
      const existing = listWardrobeItems(c.id, { status: ['wearing', 'owned'], limit: 5 });
      if (!existing.length) continue; // 还没有建立衣橱的角色不打扰
      await decideSuQingOutfitAndPose(c, { occasion: '今日晨间日常穿搭', allowPresets: false, now }, deps);
      styled++;
    } catch (e) {
      log('warn', `[WardrobeStylist] 晨间自主换装跳过 companion=${c.id}: ${e.message}`);
    }
  }
  if (styled > 0) log('info', `[WardrobeStylist] 每日晨间自主穿搭完成 styled=${styled}`);
  return { styled };
}
