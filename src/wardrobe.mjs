/**
 * 数字衣橱与发图送礼试穿领域服务
 *
 * 覆盖：
 *   1. 意图识别：即时云试穿 / 下单等快递 / 立即送礼穿戴 / 文本点名换装
 *   2. Vision 结构化商品解析 + 商品原图安全落盘
 *   3. 槽位唯一穿搭状态 + ≤80 token 常驻 Prompt 注入块
 *   4. 按品类自动机位路由（杜绝送鞋只拍大头）与多图换装 Prompt 组装
 */

import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  WARDROBE_SLOTS,
  createWardrobeItem,
  listWardrobeItems,
  wearWardrobeItem,
  updateWardrobeItem,
  listDueWardrobeDeliveries,
  getCompanionById,
  getActiveWechatBinding,
  saveConversationTurn,
  saveMessage,
  getAppSetting,
} from './db.mjs';
import { recognizeImage, generateImage } from './ai.mjs';
import { ensureVisualIdentity, buildIdentityPrompt } from './visual_identity.mjs';
import { ANTI_COLLAGE_PROMPT } from './photo_sender.mjs';
import { getPoseById } from './pose_outfit_library.mjs';
import { readAssetBuffer, mirrorBufferToR2Quietly } from './storage.mjs';
import { log } from './logger.mjs';

const DEFAULT_VISUAL_ROOT = path.resolve(
  process.env.PHOTO_VISUAL_IDENTITY_DIR
  || path.join(process.env.XIYU_DATA_DIR || path.join(process.cwd(), 'data'), 'companion_visuals'),
);

const SLOT_LABELS = Object.freeze({
  outerwear: '外套',
  top: '上衣',
  bottom_or_dress: '下装/裙子',
  shoes: '鞋袜',
  bag: '包包',
  accessory: '配饰',
});

const FASHION_WORDS_RE = /衣服|外套|大衣|羽绒服|卫衣|毛衣|针织|开衫|衬衫|上衣|T恤|短袖|连衣裙|半身裙|裙子|百褶裙|牛仔裤|裤子|鞋子?|小白鞋|帆布鞋|运动鞋|板鞋|短靴|长靴|靴子|马丁靴|高跟鞋|乐福鞋|袜子|包包?|斜挎包|腋下包|单肩包|手提包|双肩包|背包|围巾|帽子|发卡|发夹|耳环|耳钉|项链|手链|戒指|眼镜|穿搭/u;

const ORDER_DELIVERY_RE = /(?:刚|已经|刚刚)?(?:给你|帮你|替你)?(?:下单|拍了|买好了|寄了|寄过去|发货)|等快递|快递到了|几天后到|过两天到|寄给你/u;
const TRYON_NOW_RE = /试穿|试试看?|穿(?:上|起来|给我)?看看|上身(?:效果)?|搭不搭|配不配|合不合适|这件(?:好不好看|怎么样|咋样)|这双(?:好不好看|怎么样|咋样)|这个包(?:好不好看|怎么样|咋样)/u;
const GIFT_INSTANT_RE = /(?:送你|送给(?:你|小晴|宝贝)|给你买(?:了|的)?|买给你|挑了(?:一件|一双|一个|条)|这是你的新|新(?:衣服|外套|裙子|鞋|靴子|包|围巾|帽子))/u;
const WEAR_REQUEST_RE = /(?:今天|明天|出门|待会儿?|一会儿?|现在)?(?:穿|换上|换|背|拎|戴)(?:上|着)?(?:我|哥哥)?(?:之前|上次|刚)?(?:送|买)?(?:你|的)?(?:那件|那双|那个|那条|这套|这件|这双|这个)?/u;

export function detectGiftOrTryonIntent(text, { hasInboundImage = false } = {}) {
  const raw = String(text || '').trim();
  if (!raw && !hasInboundImage) return { kind: null, reason: 'empty' };

  if (hasInboundImage) {
    if (ORDER_DELIVERY_RE.test(raw)) return { kind: 'order_delivery', reason: 'image_with_order_delivery' };
    if (TRYON_NOW_RE.test(raw)) return { kind: 'tryon_now', reason: 'image_with_tryon_request' };
    if (GIFT_INSTANT_RE.test(raw)) return { kind: 'gift_instant', reason: 'image_with_gift_phrase' };
    if (FASHION_WORDS_RE.test(raw)) return { kind: 'tryon_now', reason: 'image_with_fashion_keyword' };
    return { kind: null, reason: 'image_without_wardrobe_intent' };
  }

  if (WEAR_REQUEST_RE.test(raw) && FASHION_WORDS_RE.test(raw)) {
    return { kind: 'wear_request', reason: 'text_wear_request' };
  }
  return { kind: null, reason: 'no_match' };
}

export function normalizeWardrobeSlot(rawSlot, category = '', name = '') {
  const s = String(rawSlot || '').trim().toLowerCase();
  if (WARDROBE_SLOTS.includes(s)) return s;
  const text = `${rawSlot || ''} ${category || ''} ${name || ''}`;
  if (/外套|大衣|羽绒服|风衣|夹克|棉服|西装|开衫|冲锋衣/u.test(text)) return 'outerwear';
  if (/裙|裤|连衣裙|半身裙|百褶裙|牛仔裤|短裤/u.test(text)) return 'bottom_or_dress';
  if (/鞋|靴|袜|拖鞋|凉鞋|乐福|帆布|板鞋/u.test(text)) return 'shoes';
  if (/包|挎包|手提|双肩|背包|托特|腋下/u.test(text)) return 'bag';
  if (/围巾|帽|耳环|耳钉|项链|手链|戒指|发卡|发夹|发圈|眼镜|墨镜|胸针|手表/u.test(text)) return 'accessory';
  return 'top';
}

export function wardrobeDirFor(companionId, visualRoot = DEFAULT_VISUAL_ROOT) {
  const dir = path.join(visualRoot, String(companionId), 'wardrobe');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveWardrobeProductImage(companionId, buffer, mime = 'image/jpeg', visualRoot = DEFAULT_VISUAL_ROOT) {
  if (!companionId || !Buffer.isBuffer(buffer) || buffer.length < 64) return null;
  const dir = wardrobeDirFor(companionId, visualRoot);
  const ext = /png/i.test(mime) ? 'png' : /webp/i.test(mime) ? 'webp' : 'jpg';
  const fname = `item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const fullPath = path.join(dir, fname);
  writeFileSync(fullPath, buffer);
  return fullPath;
}

export function resolveWardrobeImagePath(companionId, storedPath, visualRoot = DEFAULT_VISUAL_ROOT) {
  if (!companionId || !storedPath || typeof storedPath !== 'string') return null;
  const resolved = path.resolve(storedPath);
  const allowedRoots = [
    path.resolve(visualRoot, String(companionId)),
    path.resolve(process.cwd(), 'public', 'avatars', 'scenes'),
    path.resolve(process.env.XIYU_DATA_DIR || path.join(process.cwd(), 'data'), 'companion_visuals', 'scenes'),
  ];
  const inside = allowedRoots.some(root => resolved === root || resolved.startsWith(root + path.sep));
  if (!inside || !existsSync(resolved)) return null;
  return resolved;
}

const WARDROBE_VISION_PROMPT = `你是时尚穿搭单品解析助手。查看这张图片，判断图中主要物品是否是可穿戴的服饰、鞋袜、包包或配饰。
只输出严格 JSON（不要 markdown 代码围栏，不要额外解释）：
{
  "is_fashion_item": true,
  "slot": "outerwear|top|bottom_or_dress|shoes|bag|accessory",
  "category": "外套|上衣|裙子|裤子|鞋子|袜子|包包|配饰",
  "name": "6-16字中文单品名，如奶白色针织开衫、复古黑色腋下包、厚底小白鞋",
  "color": "主色调中文",
  "material": "材质中文，看不清留空",
  "style_tags": ["风格词1", "风格词2"],
  "visual_prompt": "concise detailed English visual description of this exact fashion item (color, cut, silhouette, fabric texture, key details like buttons/straps/sole) for photorealistic virtual try-on",
  "reaction_detail": "1句中文亮点描述，方便女孩夸奖细节"
}
如果图片不是服饰/鞋袜/包包/配饰（比如风景、食物、聊天截图），返回 {"is_fashion_item":false}。`;

function parseVisionJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

export async function analyzeWardrobeItem(buffer, mime = 'image/jpeg', userText = '', { recognize = recognizeImage } = {}) {
  const fallbackName = String(userText || '').match(FASHION_WORDS_RE)?.[0] || '新单品';
  try {
    const raw = await recognize(buffer, mime, { prompt: WARDROBE_VISION_PROMPT });
    const parsed = parseVisionJson(raw);
    if (parsed) {
      if (parsed.is_fashion_item === false) return { isFashionItem: false };
      const slot = normalizeWardrobeSlot(parsed.slot, parsed.category, parsed.name);
      return {
        isFashionItem: true,
        slot,
        category: String(parsed.category || SLOT_LABELS[slot] || '衣服').trim().slice(0, 30),
        name: String(parsed.name || fallbackName).trim().slice(0, 80),
        color: String(parsed.color || '').trim().slice(0, 30),
        material: String(parsed.material || '').trim().slice(0, 40),
        styleTags: Array.isArray(parsed.style_tags) ? parsed.style_tags.map(String).slice(0, 6) : [],
        visualPrompt: String(parsed.visual_prompt || parsed.name || fallbackName).trim().slice(0, 480),
        reactionDetail: String(parsed.reaction_detail || '').trim().slice(0, 120),
      };
    }
    // Vision 返回了纯文本描述：按关键词兜底解析，不丢单品
    const prose = String(raw || '').trim();
    const combined = `${prose} ${userText}`;
    if (!FASHION_WORDS_RE.test(combined)) return { isFashionItem: false };
    const slot = normalizeWardrobeSlot('', '', combined);
    return {
      isFashionItem: true,
      slot,
      category: SLOT_LABELS[slot] || '衣服',
      name: fallbackName,
      color: '',
      material: '',
      styleTags: [],
      visualPrompt: prose.slice(0, 400) || fallbackName,
      reactionDetail: prose.slice(0, 100),
    };
  } catch (e) {
    log('warn', `[Wardrobe] Vision 解析失败，走文本兜底: ${e.message}`);
    if (!FASHION_WORDS_RE.test(String(userText || ''))) return { isFashionItem: false };
    const slot = normalizeWardrobeSlot('', '', userText);
    return {
      isFashionItem: true,
      slot,
      category: SLOT_LABELS[slot] || '衣服',
      name: fallbackName,
      color: '',
      material: '',
      styleTags: [],
      visualPrompt: `${SLOT_LABELS[slot] || 'fashion item'} (${fallbackName})`,
      reactionDetail: '',
    };
  }
}

/**
 * 计算自然的快递送达时间：默认 6~18 小时后，并避开北京时间 00:00~09:00 深夜时段。
 */
export function computeDeliveryEta(now = new Date(), { minHours = 6, maxHours = 18 } = {}) {
  const span = Math.max(0, maxHours - minHours);
  const offsetHours = minHours + (span ? Math.random() * span : 0);
  const eta = new Date(now.getTime() + offsetHours * 3_600_000);
  const shHour = (eta.getUTCHours() + 8) % 24;
  if (shHour < 9) {
    // 顺延到当天北京时间 10:15 左右
    eta.setTime(eta.getTime() + (10 - shHour) * 3_600_000 + 15 * 60_000);
  } else if (shHour >= 22) {
    // 顺延到次日北京时间 10:30 左右
    eta.setTime(eta.getTime() + (34 - shHour) * 3_600_000 + 30 * 60_000);
  }
  return eta.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * 生成 ≤80 token 的精简数字衣橱 Prompt 块（严格遵守称呼红线：用“他”不用“用户”）。
 */
export function buildWardrobePromptBlock(companionId, { maxChars = 240 } = {}) {
  if (!companionId) return '';
  try {
    const items = listWardrobeItems(companionId, {
      status: ['wearing', 'owned', 'in_transit'],
      limit: 20,
    });
    if (!items.length) return '';
    const wearing = items.filter(it => it.status === 'wearing');
    const inTransit = items.filter(it => it.status === 'in_transit').slice(0, 2);
    const owned = items.filter(it => it.status === 'owned').slice(0, 4);

    const lines = ['【你的数字衣橱】'];
    if (wearing.length) {
      const desc = wearing
        .map(it => `${SLOT_LABELS[it.slot] || it.category}「${it.name}」${it.gifted_by === 'user' ? '(他送的)' : ''}`)
        .join('、');
      lines.push(`今日穿搭：${desc}`);
      try {
        const rawNote = getAppSetting(`wardrobe_stylist_note:${companionId}`);
        if (rawNote) {
          const parsedNote = JSON.parse(rawNote);
          const noteText = String(parsedNote?.note || '').trim().slice(0, 56);
          if (noteText) lines.push(`搭配小心思：${noteText}`);
        }
      } catch { /* non-blocking */ }
    }
    if (inTransit.length) {
      const desc = inTransit.map(it => `「${it.name}」`).join('、');
      lines.push(`在途快递：${desc}（他刚买还在路上）`);
    }
    if (owned.length) {
      const desc = owned.map(it => `${it.name}${it.gifted_by === 'user' ? '(他送的)' : ''}`).join('、');
      lines.push(`衣橱珍藏：${desc}`);
    }
    const block = lines.join('\n');
    return block.length > maxChars ? block.slice(0, maxChars - 1) + '…' : block;
  } catch {
    return '';
  }
}

/**
 * 按礼物部位自动选择最佳拍摄机位与试穿生图 Prompt。
 */
export function buildTryonPhotoPlan(item, companion = {}) {
  const slot = normalizeWardrobeSlot(item?.slot, item?.category, item?.name);
  const itemDesc = String(item?.visual_prompt || item?.name || 'casual fashion item').trim();
  const itemName = String(item?.name || item?.category || '新单品').trim();

  let shotMode;
  let framingPrompt;
  let caption;

  if (slot === 'shoes') {
    shotMode = 'FULL_BODY_LOW_MIRROR';
    framingPrompt = `full-body mirror selfie angled slightly downward in a cozy dorm room so both feet and the footwear (${itemDesc}) are completely visible and clearly in focus, wearing matching casual student outfit`;
    caption = `刚试穿了这双${itemName}，上脚还挺显腿长的吧`;
  } else if (slot === 'bag') {
    shotMode = 'SIDE_CARRY_HALF_BODY';
    framingPrompt = `natural waist-up mirror selfie turning slightly sideways in a bright bedroom, carrying and showcasing the exact bag (${itemDesc}) prominently on her shoulder or in hand, wearing neat casual daily wear`;
    caption = `背上这个${itemName}给你瞅瞅，百搭得不行`;
  } else if (slot === 'accessory') {
    shotMode = 'CLOSE_SELFIE';
    framingPrompt = `natural close chest-up smartphone selfie by a sunny window clearly showcasing the exact accessory (${itemDesc}) she is wearing, warm genuine smile`;
    caption = `戴上这个${itemName}啦，是不是挺衬我的`;
  } else {
    shotMode = 'MIRROR_SELFIE';
    framingPrompt = `full-body or three-quarter mirror selfie in a cozy sunlit dorm bedroom trying on the exact garment (${itemDesc}), natural relaxed pose holding a smartphone, authentic casual try-on photo`;
    caption = `刚换上${itemName}对着镜子拍了一张，你帮我看看`;
  }

  const editInstruction = item?.source_image_path
    ? `Wear the EXACT ${item?.category || 'fashion item'} shown in the product reference photo (${itemDesc}), preserving its color, cut, texture and details accurately.`
    : `Wearing ${itemDesc}.`;

  return {
    slot,
    aspect: '3:4',
    shotMode,
    caption: caption.slice(0, 30),
    activity: `试穿${itemName}`,
    imagePrompt: `${framingPrompt}. ${editInstruction} Keep natural everyday room lighting and realistic candid phone texture.`,
    extraReferenceImagePaths: item?.source_image_path ? [item.source_image_path] : [],
    companionName: companion?.name || '',
  };
}

export function matchWardrobeItemByText(companionId, text) {
  const raw = String(text || '').trim();
  if (!companionId || !raw) return null;
  const items = listWardrobeItems(companionId, { status: ['owned', 'wearing', 'tryon_only'], limit: 40 });
  if (!items.length) return null;

  let best = null;
  let bestScore = 0;
  for (const it of items) {
    let score = 0;
    if (it.name && raw.includes(it.name)) score += 10;
    if (it.color && raw.includes(it.color)) score += 3;
    if (it.category && raw.includes(it.category)) score += 2;
    const slotGuess = normalizeWardrobeSlot('', '', raw);
    if (slotGuess === it.slot) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return bestScore >= 2 ? best : null;
}

/**
 * 微信单轮消息的衣橱协调器：
 *  - 发图 + 试穿/送礼/下单 → 解析单品、存档原图、入库，并返回给文本模型与试穿生图任务的上下文；
 *  - 纯文本点名换穿 → 匹配衣橱单品并切换当前槽位。
 */
export async function handleInboundWardrobeTurn({
  companion,
  userText,
  inboundImages = [],
  recognize = recognizeImage,
  visualRoot = DEFAULT_VISUAL_ROOT,
} = {}) {
  if (!companion?.id) return null;
  const hasInboundImage = Array.isArray(inboundImages) && inboundImages.length > 0;
  if (!hasInboundImage) {
    try {
      const {
        detectAutonomousStyleRequest,
        detectTodayOotdPhotoRequest,
        decideSuQingOutfitAndPose,
        getWardrobeStylistNote,
      } = await import('./wardrobe_stylist.mjs');
      const autoReq = detectAutonomousStyleRequest(userText);
      if (autoReq) {
        const picked = await decideSuQingOutfitAndPose(companion, {
          occasion: autoReq.occasion,
          allowPresets: true,
        });
        if (picked?.items?.length) {
          const names = picked.items.map(i => i.name).join(' + ');
          const poseLbl = picked.pose?.label ? `，拍照姿势选了「${picked.pose.label}」` : '';
          const noteLine = picked.stylistNote?.note ? `（你的搭配想法：${picked.stylistNote.note}）` : '';
          return {
            intent: 'autonomous_style',
            item: picked.items[0],
            items: picked.items,
            poseId: picked.pose?.id || null,
            stylistNote: picked.stylistNote,
            shouldSendTryonPhoto: autoReq.wantPhoto,
            contextNote: `[系统提示：作为衣橱主理人，你刚刚自己挑好了今天的穿搭「${names}」${poseLbl}${noteLine}。用你自己的第一人称自然和他分享你的搭配小心思。]`,
          };
        }
      }
      const ootdReq = detectTodayOotdPhotoRequest(userText);
      if (ootdReq) {
        const wearing = listWardrobeItems(companion.id, { status: 'wearing', limit: 6 }) || [];
        if (wearing.length) {
          const stylistNote = getWardrobeStylistNote(companion.id);
          const names = wearing.map(i => i.name).join(' + ');
          return {
            intent: 'today_ootd_photo',
            item: wearing[0],
            items: wearing,
            poseId: stylistNote?.poseId || null,
            stylistNote,
            shouldSendTryonPhoto: true,
            contextNote: `[系统提示：他想看你今天身上这身穿搭「${names}」，系统马上会自动发一张你的今日穿搭照给他，自然聊聊这身穿搭和感受即可，不用口头说回头再拍。]`,
          };
        }
      }
    } catch (e) {
      log('warn', `[Wardrobe] autonomous/ootd style turn failed companion=${companion.id}: ${e.message}`);
    }
  }

  const intent = detectGiftOrTryonIntent(userText, { hasInboundImage });
  if (!intent.kind) return null;

  if (intent.kind === 'wear_request') {
    const matched = matchWardrobeItemByText(companion.id, userText);
    if (!matched) return null;
    const worn = wearWardrobeItem(companion.id, matched.id);
    if (!worn) return null;
    return {
      intent: 'wear_request',
      item: worn,
      shouldSendTryonPhoto: /拍|看看|自拍|照片|上身/u.test(userText),
      contextNote: `[系统提示：你已把衣橱里他送的「${worn.name}」换上了，自然回应并表达喜欢。]`,
    };
  }

  const img = inboundImages[inboundImages.length - 1];
  if (!img?.buffer) return null;
  const parsed = await analyzeWardrobeItem(img.buffer, img.mime || 'image/jpeg', userText, { recognize });
  if (!parsed?.isFashionItem) return null;

  const sourceImagePath = saveWardrobeProductImage(companion.id, img.buffer, img.mime || 'image/jpeg', visualRoot);
  const status = intent.kind === 'order_delivery'
    ? 'in_transit'
    : intent.kind === 'gift_instant'
      ? 'wearing'
      : 'tryon_only';
  const etaAt = status === 'in_transit' ? computeDeliveryEta() : null;

  const item = createWardrobeItem({
    companionId: companion.id,
    slot: parsed.slot,
    category: parsed.category,
    name: parsed.name,
    color: parsed.color,
    material: parsed.material,
    styleTags: parsed.styleTags,
    visualPrompt: parsed.visualPrompt,
    sourceImagePath,
    giftedBy: 'user',
    giftedNote: userText,
    status,
    etaAt,
  });

  const detail = parsed.reactionDetail ? `亮点：${parsed.reactionDetail}。` : '';
  const statusLine = status === 'in_transit'
    ? `他刚给你下单买了「${item.name}」（快递在途，预计很快送到），表达开心和期待拆快递的心情。`
    : status === 'wearing'
      ? `他刚送了你「${item.name}」并已收入你的衣橱穿上了，夸夸细节并自然撒娇。`
      : `他发来「${item.name}」想让你试试看/参谋一下，结合细节给出真实评价。`;

  return {
    intent: intent.kind,
    item,
    shouldSendTryonPhoto: intent.kind === 'tryon_now' || intent.kind === 'gift_instant',
    contextNote: `[系统提示：${statusLine}${detail}]`,
  };
}

/**
 * 快递拆箱定时巡检（零 LLM 成本）：
 * 到点的 in_transit 包裹自动签收并切为 wearing；若有活跃微信绑定则推送拆箱消息 + 试穿返图。
 */
export async function runWardrobeDeliveryTick(now = new Date(), deps = {}) {
  const nowSql = now.toISOString().replace('T', ' ').slice(0, 19);
  const dueItems = listDueWardrobeDeliveries(nowSql, 10);
  if (!dueItems.length) return { delivered: 0, notified: 0 };

  let delivered = 0;
  let notified = 0;
  for (const row of dueItems) {
    try {
      const worn = wearWardrobeItem(row.companion_id, row.id);
      if (!worn) continue;
      delivered++;
      const text = `快递到啦！我刚去驿站把你买的「${worn.name}」抱回来拆开了，这就换上试试看～`;

      if (!row.wechat_user_id || !row.bot_id) continue;
      const binding = getActiveWechatBinding(row.wechat_user_id, row.bot_id);
      if (!binding?.bot_token) continue;

      const sendText = deps.sendText || (await import('./ilink.mjs')).sendTextMessage;
      const sendPhoto = deps.sendPhoto || (await import('./photo_sender.mjs')).sendCompanionPhoto;
      const ctx = { token: binding.bot_token, botId: row.bot_id };
      const contextToken = null;
      const okText = await sendText(ctx, row.wechat_user_id, text, contextToken);
      if (okText) {
        notified++;
        try {
          saveMessage({
            msgId: `wardrobe_delivery_${row.companion_id}_${row.id}_${Date.now()}`,
            fromUser: row.bot_id,
            toUser: row.wechat_user_id,
            msgType: 'text',
            content: text,
            direction: 'out',
          });
          saveConversationTurn(row.companion_id, 'assistant', text, row.chat_mode_active || '日常聊天');
        } catch { /* non-blocking */ }
      }

      // 尽力补发高保真试穿买家秀，失败不影响已签收状态
      try {
        const companion = getCompanionById(row.companion_id);
        if (companion) {
          const plan = buildTryonPhotoPlan(worn, companion);
          let preGeneratedImagePath = null;
          if (!deps.sendPhoto) {
            try {
              const genOut = await generateWardrobeTryonImage(companion, worn, { composeWithWearing: true });
              preGeneratedImagePath = genOut?.filePath || null;
            } catch (e) {
              log('warn', `[Wardrobe] 拆箱高保真试穿图生成降级 companion=${row.companion_id}: ${e.message}`);
            }
          }
          const photoRes = await sendPhoto({
            companion: { ...companion, wechat_user_id: row.wechat_user_id },
            user: { wechat_user_id: row.wechat_user_id },
            context: ctx,
            contextToken,
            activity: plan.activity,
            imagePrompt: plan.imagePrompt,
            caption: plan.caption,
            trigger: 'wardrobe_delivery_unbox',
            source: 'proactive',
            aspect: plan.aspect,
            shotMode: plan.shotMode,
            extraReferenceImagePaths: plan.extraReferenceImagePaths,
            preGeneratedImagePath,
            force: true,
          });
          if (photoRes?.ok && (preGeneratedImagePath || photoRes.filePath)) {
            updateWardrobeItem(row.companion_id, worn.id, { tryonImagePath: preGeneratedImagePath || photoRes.filePath });
          }
        }
      } catch (e) {
        log('warn', `[Wardrobe] 拆箱试穿图发送失败 companion=${row.companion_id} item=#${worn.id}: ${e.message}`);
      }
    } catch (e) {
      log('warn', `[Wardrobe] 快递拆箱处理异常 item=#${row.id}: ${e.message}`);
    }
  }
  if (delivered > 0) log('info', `[Wardrobe] 快递拆箱巡检完成 delivered=${delivered} notified=${notified}`);
  return { delivered, notified };
}

function mimeFromFilePath(filePath) {
  const ext = String(filePath || '').toLowerCase().match(/\.(png|jpe?g|webp|gif)$/)?.[1];
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

async function persistGeneratedImage(urlOrDataUrl, companionId, filePrefix, visualRoot = DEFAULT_VISUAL_ROOT) {
  const dir = wardrobeDirFor(companionId, visualRoot);
  let buf;
  let ext = 'png';
  if (typeof urlOrDataUrl === 'string' && /^data:image\//i.test(urlOrDataUrl)) {
    const m = urlOrDataUrl.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i);
    if (!m) throw new Error('invalid generated data url');
    ext = m[1].includes('jpeg') || m[1].includes('jpg') ? 'jpg' : m[1].includes('webp') ? 'webp' : 'png';
    buf = Buffer.from(m[2], 'base64');
  } else if (typeof urlOrDataUrl === 'string' && /^https?:\/\//i.test(urlOrDataUrl)) {
    const resp = await fetch(urlOrDataUrl, { signal: AbortSignal.timeout(45_000) });
    if (!resp.ok) throw new Error(`download generated image HTTP ${resp.status}`);
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpg';
    else if (ct.includes('webp')) ext = 'webp';
    buf = Buffer.from(await resp.arrayBuffer());
  } else {
    throw new Error('unsupported image output');
  }
  if (!buf || buf.length < 128) throw new Error('generated image too small');
  const outPath = path.join(dir, `${filePrefix}_${Date.now()}.${ext}`);
  writeFileSync(outPath, buf);
  const mirrored = await mirrorBufferToR2Quietly(`companions/${companionId}/wardrobe/${path.basename(outPath)}`, buf, mimeFromFilePath(outPath));
  return { filePath: outPath, publicUrl: mirrored?.publicUrl || null };
}

const SLOT_ORDER = ['top', 'bottom_or_dress', 'outerwear', 'shoes', 'bag', 'accessory'];
const SLOT_LAYER_ROLE = {
  top: 'INNER TOP / UPPER GARMENT (worn close to the body as the base top layer)',
  bottom_or_dress: 'BOTTOM / SKIRT / DRESS (worn on the lower body or full dress base)',
  outerwear: 'OUTERWEAR / JACKET / CARDIGAN (layered OVER the inner top so both layers are clearly visible)',
  shoes: 'FOOTWEAR / SHOES / SOCKS (worn on both feet, clearly visible)',
  bag: 'BAG / HANDBAG (carried naturally on her shoulder or in hand)',
  accessory: 'ACCESSORY (worn naturally as an accent)',
};

/**
 * 判断单品是否为整套穿搭（如 posewear 四季全身搭配、含“+”的组合套装、或连衣裙/礼服）。
 */
export function isFullOutfitItem(item = {}) {
  const id = String(item?.id || '');
  const name = String(item?.name || '');
  const prompt = String(item?.visual_prompt || item?.visualPrompt || '');
  const note = String(item?.gifted_note || item?.giftedNote || '');
  if (id.startsWith('pw_cos_')) return true;
  if (/\+|套装|整套|礼服/.test(name) || /\b(spring|summer|autumn|winter|party)\s+outfit\b/i.test(prompt)) return true;
  if (/整套穿搭/.test(note)) return true;
  return false;
}

function pickLayeredFraming(items) {
  const slots = new Set(items.map(it => normalizeWardrobeSlot(it.slot, it.category, it.name)));
  if (items.some(isFullOutfitItem) || slots.has('shoes') || (slots.has('bottom_or_dress') && slots.size >= 2)) {
    return {
      shotMode: 'FULL_BODY_MIRROR',
      framing: 'Full-body standing mirror selfie in a cozy sunlit bedroom, head-to-toe framing so her face, entire layered outfit, and shoes/legs are all clearly visible.',
    };
  }
  if (slots.size === 1 && slots.has('accessory')) {
    return {
      shotMode: 'CLOSE_SELFIE',
      framing: 'Natural chest-up smartphone portrait by a bright window so her face and the accessory are sharply in focus.',
    };
  }
  if (slots.size === 1 && slots.has('bag')) {
    return {
      shotMode: 'SIDE_CARRY_HALF_BODY',
      framing: 'Three-quarter waist-up mirror selfie turning slightly sideways in a bright room, clearly showcasing the bag on her shoulder or in hand.',
    };
  }
  return {
    shotMode: 'MIRROR_SELFIE',
    framing: 'Three-quarter or full-body casual mirror selfie in a softly lit cozy bedroom, relaxed natural posture holding a phone, clearly showing the full outfit.',
  };
}

const EXPRESSION_POOL_BY_MOOD = {
  开心: [
    'bright cheerful smile with crinkled happy eyes, slight playful head tilt, relaxed lively energy',
    'candid laughing half-smile looking into the mirror, one hand resting lightly on her hip, breezy cheerful vibe',
    'sweet radiant grin flashing a subtle cute peace sign near her cheek, upbeat everyday joy',
  ],
  害羞: [
    'soft bashful smile with a slight shy glance toward the mirror, tucking a wisp of hair behind her ear, gentle rosy cheeks',
    'subtle blushing half-smile with eyes glancing slightly sideways, cozy shy charm',
  ],
  撒娇: [
    'playful pouting cute half-smile tilting her head slightly, endearing lively gaze toward the camera',
    'sweet mischievous smile with a playful wink and relaxed shoulder tilt',
  ],
  平静: [
    'effortless natural candid half-smile, relaxed chic posture turning slightly sideways, soft everyday calm',
    'gentle warm closed-mouth smile, slightly turned three-quarter angle, relaxed natural poise',
    'light curious smile examining her outfit in the mirror, natural candid hand placement',
  ],
};

function pickTryonExpressionAndStyling(companion = {}, items = []) {
  const mood = String(companion?.current_mood || '').trim();
  const pool = EXPRESSION_POOL_BY_MOOD[mood] || [
    ...EXPRESSION_POOL_BY_MOOD.开心,
    ...EXPRESSION_POOL_BY_MOOD.平静,
    ...EXPRESSION_POOL_BY_MOOD.害羞,
  ];
  const expression = pool[Math.floor(Math.random() * pool.length)];

  const combinedDesc = items.map(it => `${it.name || ''} ${it.color || ''} ${it.visual_prompt || ''}`).join(' ').toLowerCase();
  let makeupCue = 'fresh everyday light Korean/Chinese campus makeup with soft dewy skin and natural peach lip gloss';
  if (/黑|酷|皮衣|机车|工装|羽绒|dark|black|leather|street/.test(combinedDesc)) {
    makeupCue = 'clean chic everyday makeup with subtle defined eyeliner, natural matte-satin skin, and muted rose-berry lip tint';
  } else if (/粉|白|奶|jk|裙|蕾丝|甜|cream|pastel|pink|pleated/.test(combinedDesc)) {
    makeupCue = 'soft sweet light makeup with gentle apricot-pink blush on the apples of her cheeks and sheer glossy peach-pink lips';
  }
  return { expression, makeupCue };
}

/**
 * 构造高保真多参考图换装/局部换装/多件叠穿 Prompt：
 * - Image 1 严格锚定为人物身份唯一事实源（锁脸、发型、肤色、年龄、体态，绝不被通用文本或商品图模特覆盖）
 * - Image 2..N 逐一编号绑定对应穿搭部位与叠穿层级
 * - 表情、姿态与日常淡妆随心情与穿搭自然变化，不再僵硬照搬参考图固定表情
 */
export function buildLayeredTryonPrompt({
  items = [],
  hasFaceRef = false,
  fallbackIdentityPrompt = '',
  imageBindings = [],
  singlePartPreserveRest = false,
  companion = {},
  poseId = null,
  poseRefIndex = null,
} = {}) {
  const chosenPose = poseId ? getPoseById(poseId) : null;
  const fallbackFrame = pickLayeredFraming(items);
  const shotMode = chosenPose?.shotMode || fallbackFrame.shotMode;
  const framing = chosenPose?.framingPrompt || fallbackFrame.framing;
  const autoStyling = pickTryonExpressionAndStyling(companion, items);
  const expression = chosenPose?.expressionPrompt || autoStyling.expression;
  const makeupCue = chosenPose?.makeupCue || autoStyling.makeupCue;
  const parts = [];

  if (hasFaceRef) {
    parts.push(
      'IDENTITY LOCK (HIGHEST PRIORITY): Image 1 is the EXACT young woman to photograph (if Image 1 is a multi-view reference sheet, ignore the sheet layout and text labels). Strictly preserve 100% of Image 1\'s facial bone structure and likeness — identical face shape, eyes, eyelids, eyebrows, nose, lips, jawline, skin tone, hair color, hairstyle, and natural body proportions. NEVER replace her with any model face from Image 2+. However, do NOT freeze or copy Image 1\'s stiff neutral expression or pose.',
    );
  } else if (fallbackIdentityPrompt) {
    parts.push(`SUBJECT: ${fallbackIdentityPrompt}.`);
  }

  if (poseRefIndex) {
    parts.push(
      `POSE & FRAMING REFERENCE ONLY (Image ${poseRefIndex}): Replicate ONLY the body posture, arm/hand gesture, head tilt, and camera framing angle from Image ${poseRefIndex}${chosenPose?.posePrompt ? ` (${chosenPose.posePrompt})` : ''}. STRICTLY IGNORE and NEVER copy the person's face, identity, hair, clothing, or background from Image ${poseRefIndex}. Expression: ${expression}. Makeup: ${makeupCue}.`,
    );
  } else {
    parts.push(
      chosenPose?.posePrompt
        ? `POSE, EXPRESSION & STYLING (${chosenPose.label}): Pose: ${chosenPose.posePrompt}. Expression: ${expression}. Makeup: ${makeupCue}. Keep her posture and expression vivid and natural.`
        : `EXPRESSION, POSE & STYLING VARIATION: ${expression}. Makeup: ${makeupCue}. Keep her expression natural, vivid, and alive rather than a rigid ID-photo stare.`,
      `COMPOSITION: ${framing}`,
    );
  }

  if (imageBindings.length > 0) {
    const bindingLines = imageBindings.map(({ imageIndex, item }) => {
      const slot = normalizeWardrobeSlot(item.slot, item.category, item.name);
      const role = SLOT_LAYER_ROLE[slot] || 'FASHION ITEM';
      const desc = String(item.visual_prompt || item.name || item.category || 'fashion item').trim();
      return `- Image ${imageIndex} = ${role}: "${desc}". Transfer ONLY this exact item (preserving exact color, fabric texture, cut, print, buttons/details) onto the woman from Image 1; completely ignore any person, face, mannequin, hanger, or background in Image ${imageIndex}.`;
    });
    parts.push(`GARMENT & LAYERING BINDINGS:\n${bindingLines.join('\n')}`);
  }

  const boundIds = new Set(imageBindings.map(b => b.item.id));
  const textOnlyItems = items.filter(it => !boundIds.has(it.id));
  if (textOnlyItems.length > 0) {
    const descList = textOnlyItems.map(it => {
      const slot = normalizeWardrobeSlot(it.slot, it.category, it.name);
      return `${SLOT_LAYER_ROLE[slot] || it.category}: ${it.visual_prompt || it.name}`;
    });
    parts.push(`ADDITIONAL WORN ITEMS: ${descList.join('; ')}.`);
  }

  if (items.length === 1 && isFullOutfitItem(items[0])) {
    parts.push(
      hasFaceRef && imageBindings.length > 0
        ? 'FULL OUTFIT TRANSFER RULE: Dress the woman from Image 1 in the COMPLETE head-to-toe outfit shown in Image 2 (accurately transferring every garment layer, top, outerwear, skirt/pants, socks, and shoes from Image 2), while strictly keeping 100% of Image 1\'s face, hair, and identity (NEVER copy any face or hair from Image 2).'
        : 'FULL OUTFIT RULE: Wear the complete described outfit cohesively from head to toe with natural realistic draping and fit.',
    );
  } else if (singlePartPreserveRest && hasFaceRef && items.length === 1) {
    const onlySlot = normalizeWardrobeSlot(items[0].slot, items[0].category, items[0].name);
    parts.push(
      `SINGLE-PART SWAP RULE: Change ONLY her ${SLOT_LABELS[onlySlot] || onlySlot} to match Image 2; keep the rest of her outfit on unchanged body parts consistent and harmonious with Image 1's natural look.`,
    );
  } else if (items.length > 1) {
    parts.push(
      'LAYERING RULE: Wear ALL listed garments and accessories simultaneously as one cohesive layered outfit (e.g., outer jacket/cardigan worn naturally over the inner top, bag carried on shoulder/hand, shoes on feet). Ensure realistic cloth draping, natural shadows between layers, and physically accurate fit.',
    );
  }

  parts.push(
    'PHOTO REALISM: Candid authentic smartphone snapshot, natural room daylight, realistic fabric folds and natural skin texture, zero plastic AI smoothness.',
    ANTI_COLLAGE_PROMPT,
  );

  return {
    shotMode,
    prompt: parts.filter(Boolean).join('\n'),
  };
}

/**
 * 网页端多件自由叠穿 / 单部位局部换装试穿生图：
 *  - Image 1 传完整未裁切的人物定妆照（杜绝盲裁切毁脸/毁发型）；
 *  - Image 2..N 依次传单品原图（最多 4 张总参考图，按内搭/裙装/外套/鞋/包/配饰层级排序）；
 *  - 支持单件局部换装与多件整套 OOTD 叠穿合拍。
 */
export async function generateOutfitTryonImage(companion, targetItems = [], options = {}, deps = {}) {
  if (!companion?.id) throw new Error('missing companion');
  const rawList = Array.isArray(targetItems) ? targetItems.filter(Boolean) : [];
  if (!rawList.length) throw new Error('至少需要一件衣橱单品才能生成穿搭照');

  const bySlot = new Map();
  for (const it of rawList) {
    const slot = normalizeWardrobeSlot(it.slot, it.category, it.name);
    bySlot.set(slot, it);
  }
  const ordered = [...bySlot.entries()]
    .sort((a, b) => SLOT_ORDER.indexOf(a[0]) - SLOT_ORDER.indexOf(b[0]))
    .map(([, it]) => it);

  const visualRoot = deps.visualRoot || DEFAULT_VISUAL_ROOT;
  const gen = deps.generateImage || generateImage;

  let visual = null;
  try {
    visual = await ensureVisualIdentity({
      companion,
      context: { scene: ordered.map(i => i.name).join('+'), source: 'web_tryon', trigger: 'wardrobe_tryon' },
    });
  } catch (e) {
    log('warn', `[Wardrobe] visual identity unavailable companion=${companion.id}: ${e.message}`);
  }

  const refs = [];
  let hasFaceRef = false;
  if (visual?.referenceImagePath && existsSync(visual.referenceImagePath)) {
    try {
      const rawFace = readFileSync(visual.referenceImagePath);
      refs.push(`data:${mimeFromFilePath(visual.referenceImagePath)};base64,${rawFace.toString('base64')}`);
      hasFaceRef = true;
    } catch (e) {
      log('warn', `[Wardrobe] 读取人物参考图失败: ${e.message}`);
    }
  }

  const chosenPose = options.poseId ? getPoseById(options.poseId) : null;
  let poseRefBuffer = null;
  if (chosenPose?.imageRef) {
    try {
      poseRefBuffer = await readAssetBuffer(chosenPose.imageRef);
    } catch (e) {
      log('warn', `[Wardrobe] 读取姿势参考图失败 pose=${chosenPose.id}: ${e.message}`);
    }
  }

  const imageBindings = [];
  const reservedForPose = poseRefBuffer?.buffer ? 1 : 0;
  const maxItemRefs = Math.max(1, (hasFaceRef ? 3 : 4) - reservedForPose);
  const primaryId = options.primaryItemId || ordered[0]?.id;
  const refCandidates = [...ordered].sort((a, b) => (a.id === primaryId ? -1 : b.id === primaryId ? 1 : 0));
  for (const it of refCandidates) {
    if (imageBindings.length >= maxItemRefs) break;
    if (it.source_image_path && existsSync(it.source_image_path)) {
      try {
        const rawItem = readFileSync(it.source_image_path);
        refs.push(`data:${mimeFromFilePath(it.source_image_path)};base64,${rawItem.toString('base64')}`);
        imageBindings.push({ imageIndex: refs.length, item: it });
      } catch (e) {
        log('warn', `[Wardrobe] 读取商品参考图失败 item=#${it.id}: ${e.message}`);
      }
    }
  }

  let poseRefIndex = null;
  if (poseRefBuffer?.buffer && refs.length < 4) {
    refs.push(`data:${poseRefBuffer.contentType || 'image/jpeg'};base64,${poseRefBuffer.buffer.toString('base64')}`);
    poseRefIndex = refs.length;
  }

  const { shotMode, prompt: finalPrompt } = buildLayeredTryonPrompt({
    items: ordered,
    hasFaceRef,
    fallbackIdentityPrompt: hasFaceRef ? '' : buildIdentityPrompt(visual?.identity),
    imageBindings,
    singlePartPreserveRest: ordered.length === 1,
    companion,
    poseId: options.poseId || null,
    poseRefIndex,
  });

  const referenceImage = refs.length > 1 ? refs : (refs[0] || null);
  const rawUrl = await gen(finalPrompt, {
    size: '1024x1536',
    referenceImage,
    inputFidelity: 'high',
  });
  const filePrefix = options.filePrefix || (ordered.length > 1 ? 'outfit' : `tryon_${ordered[0].id}`);
  const persisted = await persistGeneratedImage(rawUrl, companion.id, filePrefix, visualRoot);
  const filePath = persisted.filePath;
  const tryonPublicUrl = persisted.publicUrl;

  const primaryItem = ordered.find(it => it.id === primaryId) || ordered[0];
  let updatedPrimary = primaryItem;
  if (primaryItem?.id && options.persistToPrimary !== false) {
    updatedPrimary = updateWardrobeItem(companion.id, primaryItem.id, {
      tryonImagePath: filePath,
      ...(tryonPublicUrl ? { tryonPublicUrl } : {}),
    }) || primaryItem;
  }

  const caption = ordered.length > 1
    ? `把${ordered.map(it => it.name).join(' + ')}叠穿在一起拍了一张，这套搭配怎么样？`
    : buildTryonPhotoPlan(primaryItem, companion).caption;

  log('info', `[Wardrobe] outfit try-on generated companion=${companion.id} items=[${ordered.map(i => i.id).join(',')}] refs=${refs.length} faceRef=${hasFaceRef} shot=${shotMode}`);
  return {
    item: updatedPrimary,
    items: ordered,
    filePath,
    fileName: path.basename(filePath),
    publicUrl: tryonPublicUrl,
    caption,
    shotMode,
    refCount: refs.length,
    hasFaceRef,
  };
}

/**
 * 网页端直接触发单品试穿返图（默认自动叠穿当前其他已穿部位，无其他部位时做单部位局部换装）。
 */
export async function generateWardrobeTryonImage(companion, item, deps = {}) {
  if (!companion?.id || !item?.id) throw new Error('missing companion or wardrobe item');
  const composeWithWearing = deps.composeWithWearing !== false;
  const targetSlot = normalizeWardrobeSlot(item.slot, item.category, item.name);

  const combo = [item];
  if (composeWithWearing) {
    try {
      const wearing = listWardrobeItems(companion.id, { status: 'wearing', limit: 6 }) || [];
      for (const w of wearing) {
        const wSlot = normalizeWardrobeSlot(w.slot, w.category, w.name);
        if (w.id !== item.id && wSlot !== targetSlot) combo.push(w);
      }
    } catch { /* fail-open */ }
  }

  return generateOutfitTryonImage(
    companion,
    combo,
    { primaryItemId: item.id, filePrefix: `tryon_${item.id}`, poseId: deps.poseId || null },
    deps,
  );
}
