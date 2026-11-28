/**
 * 截图一键扒同款（去人物 + 去背景 → 电商平铺图）& 姿势参考图智能解析（Phase 4-A+）
 *
 * 支持双模式成本控制：
 *   - raw 模式：仅跑一次 Vision 拆解识别，零生图费用，直接将原图存库；
 *   - flatlay 模式：调用独立低价模型 GARMENT_EXTRACT_MODEL（未配则复用 IMAGE_MODEL 的轻量 1024x1024 档），
 *     将原穿搭截图中的指定单品去除人物与背景，重构为纯白底电商平铺商品图后存入 R2/本地。
 */
import sharp from 'sharp';
import { recognizeImage } from './ai.mjs';
import { imageGenerate } from './providers/image.mjs';
import { readProviderSetting } from './providers/custom.mjs';
import { normalizeWardrobeSlot } from './wardrobe.mjs';
import { log } from './logger.mjs';

function parseLooseJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch { /* ignore */ }
  }
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch { /* ignore */ }
  }
  return null;
}

const SCREENSHOT_DECOMPOSE_PROMPT = [
  '你是专业时尚买手与服装拆解助手。请仔细观察这张穿搭截图或商品图，拆解出画面里清晰可见、值得单独立项的服饰/鞋包/配饰单品（最多 5 件）。',
  '只返回严格 JSON，不要任何额外解释：',
  '{',
  '  "items": [',
  '    {',
  '      "slot": "top|outerwear|bottom_or_dress|shoes|bag|accessory",',
  '      "category": "中文短分类，如 外套/上衣/裙子/裤子/鞋子/包包/配饰",',
  '      "name": "简短好记的中文款式名（6-16字，如 焦糖双排扣毛呢大衣）",',
  '      "color": "主色调中文（2-6字）",',
  '      "material": "面料或材质（2-8字）",',
  '      "swatch": "#HEX主色码，如 #C99E72",',
  '      "style_tags": ["2-3个中文风格词"],',
  '      "desc_zh": "15-30字中文款式亮点描述",',
  '      "visual_prompt": "Detailed English e-commerce garment description ONLY describing the garment itself (color, silhouette, collar, buttons, print, texture; NO person/model/background)"',
  '    }',
  '  ]',
  '}',
  '要求：外套和内搭请分成 outerwear 和 top 两个条目；裙装或裤装归入 bottom_or_dress；同一槽位只保留最显眼的一件；绝不输出任何人物面部或无关文字。',
].join('\n');

const POSE_ANALYZE_PROMPT = (kind = 'solo') => [
  `你是人像摄影构图师。请分析这张${kind === 'couple' ? '双人合影' : '单人穿搭'}参考图的姿势、动作、手势与拍摄景别。`,
  '只返回严格 JSON，不要任何额外解释：',
  '{',
  '  "label": "4-8字中文姿势名（如 对镜叉腰甜笑 / 双人挽手回眸）",',
  '  "tag": "3-5字风格标签（如 氛围感 / 甜酷街拍 / 高甜合影）",',
  '  "framing_label": "3-5字景别（如 全身街拍 / 半身特写 / 对镜半身 / 双人近景）",',
  '  "shot_mode": "MIRROR_SELFIE|FULL_BODY_MIRROR|SIDE_CARRY_HALF_BODY|CLOSE_SELFIE",',
  '  "desc_zh": "16-32字中文姿势与手势说明（只描述动作、身体朝向与表情氛围，不提原图具体人物长相）",',
  '  "pose_prompt": "Concise English pose & body posture description ONLY (limb angles, hand gesture, head tilt, stance, camera framing; NO identity/face/clothing)",',
  '  "expression_prompt": "Concise English facial expression vibe (e.g. warm candid smile looking at camera)"',
  '}',
].join('\n');

function sanitizeHexColor(raw, fallback = '#F4D8E6') {
  const s = String(raw || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : fallback;
}

/**
 * Step 1：用 Vision 识别穿搭截图中的所有可拆解服饰单品（零生图成本）。
 */
export async function detectOutfitsInScreenshot(buffer, mime = 'image/jpeg', deps = {}) {
  const recognize = deps.recognize || recognizeImage;
  let parsed = null;
  try {
    const raw = await recognize(buffer, mime, { prompt: SCREENSHOT_DECOMPOSE_PROMPT });
    parsed = parseLooseJson(raw);
  } catch (e) {
    log('warn', `[GarmentExtractor] Vision 拆解截图失败: ${e.message}`);
  }

  const rawList = Array.isArray(parsed?.items) ? parsed.items : (Array.isArray(parsed) ? parsed : []);
  const bySlot = new Map();
  for (const it of rawList) {
    if (!it || typeof it !== 'object') continue;
    const slot = normalizeWardrobeSlot(it.slot, it.category, it.name);
    if (bySlot.has(slot)) continue;
    const category = String(it.category || '').trim().slice(0, 12) || (
      slot === 'outerwear' ? '外套' : slot === 'top' ? '上衣' : slot === 'bottom_or_dress' ? '裙装' : slot === 'shoes' ? '鞋子' : slot === 'bag' ? '包包' : '配饰'
    );
    const name = String(it.name || '').trim().slice(0, 40) || `精选${category}`;
    const color = String(it.color || '').trim().slice(0, 16);
    const material = String(it.material || '').trim().slice(0, 16);
    const descZh = String(it.desc_zh || it.descZh || '').trim().slice(0, 80) || `${color}${name}`.trim();
    const visualPrompt = String(it.visual_prompt || it.visualPrompt || '').trim().slice(0, 260)
      || `${color} ${name}`.trim();
    const styleTags = Array.isArray(it.style_tags)
      ? it.style_tags.map(t => String(t || '').trim().slice(0, 12)).filter(Boolean).slice(0, 4)
      : [];
    bySlot.set(slot, {
      slot,
      category,
      name,
      color,
      material,
      swatch: sanitizeHexColor(it.swatch),
      styleTags: styleTags.length ? styleTags : [category],
      descZh,
      visualPrompt,
    });
  }

  if (bySlot.size === 0) {
    bySlot.set('top', {
      slot: 'top',
      category: '穿搭单品',
      name: '截图收藏穿搭',
      color: '',
      material: '',
      swatch: '#F5D8E6',
      styleTags: ['精选穿搭'],
      descZh: '从穿搭截图提取的服饰灵感单品',
      visualPrompt: 'stylish casual fashion garment from reference photo',
    });
  }
  return [...bySlot.values()];
}

export function buildFlatlayExtractionPrompt(itemSpec = {}) {
  const nameOrDesc = String(itemSpec.visualPrompt || itemSpec.visual_prompt || itemSpec.name || 'the garment').trim();
  const slot = String(itemSpec.slot || 'top');
  const itemType = slot === 'shoes'
    ? 'pair of shoes/footwear'
    : slot === 'bag'
      ? 'handbag/bag'
      : slot === 'accessory'
        ? 'fashion accessory'
        : 'garment';
  return [
    `GHOST-MANNEQUIN / E-COMMERCE FLAT-LAY EXTRACTION: Extract ONLY the ${itemType} described as "${nameOrDesc}" from Image 1.`,
    'STRICT REMOVAL RULES: Completely remove ALL human anatomy (no head, no face, no neck, no hair, no hands, no arms, no legs, no skin), remove all other garments not specified above, and remove the entire original background.',
    'PRODUCT PRESENTATION: Render ONLY the isolated single item neatly laid flat or on an invisible ghost mannequin, centered with generous clean margin on a pure solid white studio background (#FFFFFF).',
    'DETAIL FIDELITY: Preserve 100% of the exact color, fabric texture, cut, collar, buttons, zippers, stitching, pattern, and proportions from Image 1; cleanly reconstruct any small area previously occluded by hair or arms.',
    'Clean high-resolution commercial catalog product photography, soft even shadowless studio lighting, no text, no watermark, no collage, single item only.',
  ].join('\n');
}

async function decodeGeneratedToBuffer(rawUrl) {
  if (typeof rawUrl === 'string' && /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.test(rawUrl)) {
    const m = rawUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    return { buffer: Buffer.from(m[2], 'base64'), contentType: m[1].toLowerCase() };
  }
  if (typeof rawUrl === 'string' && /^https?:\/\//i.test(rawUrl)) {
    const resp = await fetch(rawUrl, { signal: AbortSignal.timeout(45_000) });
    if (!resp.ok) throw new Error(`download extracted image HTTP ${resp.status}`);
    const contentType = (resp.headers.get('content-type') || 'image/png').split(';')[0].trim().toLowerCase();
    return { buffer: Buffer.from(await resp.arrayBuffer()), contentType };
  }
  throw new Error('unsupported extracted image output');
}

/**
 * Step 2：把穿搭截图中的指定单品去除人物与背景，重构为纯白底电商平铺商品图。
 * 优先使用 GARMENT_EXTRACT_MODEL（低价轻量编辑模型），未配置时回落 IMAGE_MODEL 的 1024x1024 轻量档。
 */
export async function extractGarmentFlatlayImage(buffer, mime = 'image/jpeg', itemSpec = {}, deps = {}) {
  const gen = deps.generateImage || imageGenerate;
  const extractModel = readProviderSetting('GARMENT_EXTRACT_MODEL').trim() || undefined;
  const refDataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
  const prompt = buildFlatlayExtractionPrompt(itemSpec);

  const rawUrl = await gen(prompt, {
    size: '1024x1024',
    referenceImage: refDataUrl,
    model: extractModel,
    inputFidelity: 'low',
    skipBeautify: true,
  });

  const decoded = await decodeGeneratedToBuffer(rawUrl);
  try {
    const normalized = await sharp(decoded.buffer)
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
    return { buffer: normalized, contentType: 'image/jpeg', ext: 'jpg', modelUsed: extractModel || 'default' };
  } catch {
    return { buffer: decoded.buffer, contentType: decoded.contentType || 'image/png', ext: 'png', modelUsed: extractModel || 'default' };
  }
}

/**
 * 解析上传的自定义姿势参考实图，自动产出中文姿势名、景别与英文控姿描述。
 */
export async function analyzePoseReferencePhoto(buffer, mime = 'image/jpeg', {
  kind = 'solo',
  label = '',
  tag = '',
  descZh = '',
} = {}, deps = {}) {
  const recognize = deps.recognize || recognizeImage;
  const cleanKind = kind === 'couple' ? 'couple' : 'solo';
  let parsed = null;
  try {
    const raw = await recognize(buffer, mime, { prompt: POSE_ANALYZE_PROMPT(cleanKind) });
    parsed = parseLooseJson(raw);
  } catch (e) {
    log('warn', `[GarmentExtractor] Vision 解析姿势图失败: ${e.message}`);
  }

  const validShots = new Set(['MIRROR_SELFIE', 'FULL_BODY_MIRROR', 'SIDE_CARRY_HALF_BODY', 'CLOSE_SELFIE']);
  const shotMode = validShots.has(parsed?.shot_mode) ? parsed.shot_mode : 'MIRROR_SELFIE';
  return {
    kind: cleanKind,
    label: String(label || parsed?.label || '').trim().slice(0, 16) || (cleanKind === 'couple' ? '自定义双人姿势' : '自定义试穿姿势'),
    tag: String(tag || parsed?.tag || '').trim().slice(0, 12) || '收藏参考',
    framingLabel: String(parsed?.framing_label || '').trim().slice(0, 10) || (cleanKind === 'couple' ? '双人实图' : '实图姿势'),
    shotMode,
    descZh: String(descZh || parsed?.desc_zh || '').trim().slice(0, 80) || '按收藏的参考实图动作与构图摆拍',
    posePrompt: String(parsed?.pose_prompt || '').trim().slice(0, 260)
      || (cleanKind === 'couple'
        ? 'natural warm couple pose matching the posture, spacing, and framing of the pose reference image'
        : 'natural stylish fashion pose matching the stance, arm placement, head angle, and framing of the pose reference image'),
    expressionPrompt: String(parsed?.expression_prompt || '').trim().slice(0, 140)
      || 'natural warm candid smile matching the mood of the pose reference',
  };
}
