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

async function shrinkForVision(buffer, mime) {
  try {
    const out = await sharp(buffer)
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { buffer: out, mime: 'image/jpeg' };
  } catch {
    return { buffer, mime };
  }
}

/**
 * Step 1：用 Vision 识别穿搭截图中的所有可拆解服饰单品（零生图成本；先压缩至 768px 防止大图中转超时）。
 */
export async function detectOutfitsInScreenshot(buffer, mime = 'image/jpeg', deps = {}) {
  const recognize = deps.recognize || recognizeImage;
  const slim = await shrinkForVision(buffer, mime);
  let parsed = null;
  let visionFailed = false;
  try {
    const raw = await recognize(slim.buffer, slim.mime, { prompt: SCREENSHOT_DECOMPOSE_PROMPT, timeoutMs: 55_000 });
    if (typeof raw === 'string' && raw.includes('[图片识别失败]')) visionFailed = true;
    else parsed = parseLooseJson(raw);
  } catch (e) {
    visionFailed = true;
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
      descZh: '从穿搭截图提取的透明平铺单品',
      visualPrompt: 'the complete main fashion garment outfit worn by the person in Image 1 (preserving exact colors, collar, bow/buttons, fabric, and cut)',
      visionFallback: visionFailed,
    });
  }
  return [...bySlot.values()];
}

/**
 * 将纯白/浅灰影棚底的商品平铺图转为真正透明背景 RGBA PNG：
 *   - 若模型已原生返回带透明通道的图片（边界已有明显透明像素），直接裁边保留；
 *   - 否则从四条边框发起 4-连通 Flood-Fill，精准去除与边缘连通的纯白/浅灰背景并柔和羽化 1px 过渡边缘，
 *     绝不误伤服装内部白色衬衫/领口/图案！
 */
export async function removeWhiteBackgroundToTransparentPng(inputBuffer) {
  const { data, info } = await sharp(inputBuffer)
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const total = width * height;
  if (total < 16) return inputBuffer;

  // 1. 检查边缘是否已有原生透明通道（如 gpt-image-2 background=transparent）
  let borderCount = 0;
  let borderTransparent = 0;
  for (let x = 0; x < width; x++) {
    borderCount += 2;
    if (data[(x) * 4 + 3] < 180) borderTransparent++;
    if (data[((height - 1) * width + x) * 4 + 3] < 180) borderTransparent++;
  }
  for (let y = 1; y < height - 1; y++) {
    borderCount += 2;
    if (data[(y * width) * 4 + 3] < 180) borderTransparent++;
    if (data[(y * width + width - 1) * 4 + 3] < 180) borderTransparent++;
  }
  if (borderTransparent / Math.max(1, borderCount) >= 0.25) {
    return sharp(data, { raw: { width, height, channels: 4 } })
      .png({ compressionLevel: 8 })
      .toBuffer();
  }

  // 2. 采样四角背景基色（容忍轻微米白/浅灰影棚色温）
  const corners = [0, width - 1, (height - 1) * width, (height - 1) * width + width - 1];
  let bgR = 250; let bgG = 250; let bgB = 250;
  let whiteCorners = 0;
  for (const idx of corners) {
    const r = data[idx * 4]; const g = data[idx * 4 + 1]; const b = data[idx * 4 + 2];
    if (r >= 215 && g >= 215 && b >= 215 && (Math.max(r, g, b) - Math.min(r, g, b)) <= 28) {
      whiteCorners++;
      bgR = Math.round((bgR + r) / 2);
      bgG = Math.round((bgG + g) / 2);
      bgB = Math.round((bgB + b) / 2);
    }
  }
  if (whiteCorners < 2) {
    return sharp(data, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 8 }).toBuffer();
  }

  const isBg = (p) => {
    const o = p * 4;
    const r = data[o]; const g = data[o + 1]; const b = data[o + 2];
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    const dist = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
    return dist <= 72 && spread <= 26 && r >= 210 && g >= 210 && b >= 210;
  };

  // 3. 边界 4-连通泛洪去背（只去外部背景，保护衣物内部白色领口/衬衫）
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  const pushIfBg = (p) => {
    if (!visited[p] && isBg(p)) {
      visited[p] = 1;
      queue[tail++] = p;
    }
  };
  for (let x = 0; x < width; x++) {
    pushIfBg(x);
    pushIfBg((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    pushIfBg(y * width);
    pushIfBg(y * width + width - 1);
  }

  while (head < tail) {
    const p = queue[head++];
    data[p * 4 + 3] = 0;
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) pushIfBg(p - 1);
    if (x + 1 < width) pushIfBg(p + 1);
    if (y > 0) pushIfBg(p - width);
    if (y + 1 < height) pushIfBg(p + width);
  }

  // 4. 对紧邻透明区的 1px 过渡抗锯齿亮边做柔和半透明羽化
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      if (visited[p]) continue;
      if (visited[p - 1] || visited[p + 1] || visited[p - width] || visited[p + width]) {
        const o = p * 4;
        const lum = (data[o] + data[o + 1] + data[o + 2]) / 3;
        if (lum >= 220) {
          data[o + 3] = Math.max(0, Math.min(255, Math.round((255 - lum) * 6.5)));
        }
      }
    }
  }

  return sharp(data, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 8 })
    .toBuffer();
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
    'STRICT REMOVAL RULES: Completely remove ALL human anatomy (no head, no face, no neck, no hair, no hands, no arms, no legs, no skin), remove all watermarks/text/logos from social media, remove all other garments not specified above, and remove the entire original background.',
    'PRODUCT PRESENTATION: Render ONLY the isolated single item neatly laid flat or on an invisible ghost mannequin, centered with generous clean margin on a pure transparent or solid pure-white studio background (#FFFFFF).',
    'DETAIL FIDELITY: Preserve 100% of the exact color, fabric texture, cut, collar, ribbon/bow, buttons, zippers, stitching, pattern, and proportions from Image 1; cleanly reconstruct any small area previously occluded by hair or arms.',
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
 * Step 2：把穿搭截图中的指定单品去除人物与背景，重构为透明背景电商平铺 PNG 商品图。
 * 优先请求原生 background=transparent，并通过 sharp 边界泛洪去背确保输出真透明通道 PNG。
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
    background: 'transparent',
    skipBeautify: true,
  });

  const decoded = await decodeGeneratedToBuffer(rawUrl);
  try {
    const transparentPng = await removeWhiteBackgroundToTransparentPng(decoded.buffer);
    return { buffer: transparentPng, contentType: 'image/png', ext: 'png', modelUsed: extractModel || 'default', transparent: true };
  } catch {
    return { buffer: decoded.buffer, contentType: decoded.contentType || 'image/png', ext: 'png', modelUsed: extractModel || 'default', transparent: false };
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
