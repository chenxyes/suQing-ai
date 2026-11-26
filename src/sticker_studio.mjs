/**
 * 表情包工坊与心愿收藏箱管理器（Sticker Studio）
 *
 * 职责：
 *   1. 管理 assets/stickers/manifest.json（列表、手动上传导入、标签/禁用编辑、删除、热重载）
 *   2. 精选开源表情包库（ChineseBQB）按人设推荐与一键安全拉取
 *   3. 复用项目图像生成能力 + 视觉身份（visual_identity）定制角色专属 Q 版表情包
 *   4. 按需「心愿收藏箱」：记录聊天中缺失的 [STICKER:tag]，异步从精选源或 AI 生图收集候选，
 *      支持人工审核入库或开启自动入库。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { log } from './logger.mjs';
import { reloadStickers } from './stickers.mjs';

const STICKERS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'stickers',
);
const CANDIDATES_DIR = path.join(STICKERS_DIR, 'candidates');
const MANIFEST_PATH = path.join(STICKERS_DIR, 'manifest.json');
const WISHLIST_PATH = path.join(STICKERS_DIR, 'wishlist.json');

const GH_CONTENTS_BASE = 'https://api.github.com/repos/zhaoolee/ChineseBQB/contents/';
const GH_RAW_BASE = 'https://raw.githubusercontent.com/zhaoolee/ChineseBQB/master/';
const MAX_UPLOAD_BYTES = 1.5 * 1024 * 1024; // 1.5MB（兼容动图 GIF）
const MAX_REMOTE_BYTES = 500 * 1024;        // 500KB（与 fetch_stickers.py 一致）

export const CURATED_PACKS = [
  {
    id: 'cat_everyday',
    name: '猫咪日常',
    emoji: '🐱',
    desc: '软萌百搭的日常猫咪反应，适合温柔、治愈、日常陪伴型人设',
    repoDir: '049CatEveryday_猫咪日常BQB',
    baseTags: ['cat', 'cute'],
    defaultEmotion: 'cute',
    risk: 'low',
    riskLabel: '萌宠 · 低风险',
    traits: ['温柔', '治愈', '粘人', '软萌', '猫', '邻家', '甜美'],
  },
  {
    id: 'mur_cat',
    name: 'Mur 猫',
    emoji: '😺',
    desc: '自带一点呆萌与小无语的猫猫表情，俏皮可爱不失礼貌',
    repoDir: '060MurCat_Mur猫😺BQB',
    baseTags: ['cat', 'cute', 'silly'],
    defaultEmotion: 'cute',
    risk: 'low',
    riskLabel: '萌宠 · 低风险',
    traits: ['俏皮', '可爱', '搞怪', '幽默', '猫', '元气'],
  },
  {
    id: 'cat_star',
    name: '喵星人日常',
    emoji: '🐈',
    desc: '更多撒娇、蹭蹭、打盹的猫猫表情，高频聊天不重样',
    repoDir: '010Cat_是喵星人啦🐱BQB',
    baseTags: ['cat', 'love'],
    defaultEmotion: 'cute',
    risk: 'low',
    riskLabel: '萌宠 · 低风险',
    traits: ['撒娇', '温柔', '粘人', '猫', '甜'],
  },
  {
    id: 'happy_duck',
    name: '开心鸭',
    emoji: '🐥',
    desc: '元气满满、加油打气与开心庆祝类小鸭子',
    repoDir: '008HappyDuck_开心鸭🐥BQB',
    baseTags: ['duck', 'cute', 'happy'],
    defaultEmotion: 'happy',
    risk: 'low',
    riskLabel: '萌宠 · 低风险',
    traits: ['元气', '乐观', '活泼', '阳光', '开朗', '学妹'],
  },
  {
    id: 'hamster',
    name: '小仓鼠',
    emoji: '🐹',
    desc: '吃东西、害羞、委屈巴巴的小仓鼠，软萌系必备',
    repoDir: '006Hamster_仓鼠🐹BQB',
    baseTags: ['hamster', 'cute', 'shy'],
    defaultEmotion: 'cute',
    risk: 'low',
    riskLabel: '萌宠 · 低风险',
    traits: ['害羞', '吃货', '软萌', '乖巧', '邻家'],
  },
  {
    id: 'penguin',
    name: '沙雕企鹅',
    emoji: '🐧',
    desc: '轻松逗比、日常互怼与接梗的沙雕企鹅',
    repoDir: '031Penguin_沙雕企鹅🐧BQB',
    baseTags: ['penguin', 'silly', 'happy'],
    defaultEmotion: 'happy',
    risk: 'low',
    riskLabel: '萌宠 · 低风险',
    traits: ['搞笑', '沙雕', '幽默', '活泼', '青梅竹马', '话痨'],
  },
  {
    id: 'chicken',
    name: '小幺鸡',
    emoji: '🐔',
    desc: '经典搞怪小鸡，适合撒泼打滚、日常闹腾',
    repoDir: '026Chicken_小幺鸡🐔BQB',
    baseTags: ['chicken', 'cute'],
    defaultEmotion: 'cute',
    risk: 'low',
    riskLabel: '萌宠 · 低风险',
    traits: ['活泼', '闹腾', '傲娇', '元气'],
  },
  {
    id: 'turtle',
    name: '慢悠悠小乌龟',
    emoji: '🐢',
    desc: '佛系、摸鱼、发呆、困困的小乌龟',
    repoDir: '027Turtle_乌龟🐢BQB',
    baseTags: ['turtle', 'cute', 'sleepy'],
    defaultEmotion: 'cute',
    risk: 'low',
    riskLabel: '萌宠 · 低风险',
    traits: ['佛系', '安静', '文艺', '慢热', '熬夜'],
  },
  {
    id: 'cute_girl',
    name: '可爱少女',
    emoji: '🎀',
    desc: '二次元卡通少女表情，害羞、比心、生气、晚安一应俱全',
    repoDir: '002CuteGirl_可爱的女孩纸👧BQB',
    baseTags: ['cute', 'girl'],
    defaultEmotion: 'cute',
    risk: 'medium',
    riskLabel: '卡通 · 建议自用',
    traits: ['二次元', '少女', '甜美', '学姐', '大小姐', '傲娇', '温柔'],
  },
  {
    id: 'panda_sarcasm',
    name: '反讽吐槽熊猫头',
    emoji: '🐼',
    desc: '无语、翻白眼、嘲讽、敷衍专用 meme（适合互怼与傲娇人设）',
    repoDir: '015Golden_Curator_Panda金馆长熊猫🐼BQB',
    baseTags: ['panda', 'meme', 'sarcasm', 'mock', 'dismissive', 'eyeroll', 'whatever', 'speechless'],
    defaultEmotion: 'mock',
    risk: 'meme',
    riskLabel: '网络梗图 · 仅个人自用',
    traits: ['傲娇', '毒舌', '吐槽', '高冷', '御姐', '幽默', '青梅竹马'],
  },
];

const KEYWORD_MAP = {
  笑: ['happy'], 嘻嘻: ['happy'], 哈哈: ['happy'], 开心: ['happy'], 乐: ['happy'],
  害羞: ['shy'], 脸红: ['shy'], 羞: ['shy'],
  哭: ['sad', 'cry'], 委屈: ['sad', 'pout'], 难过: ['sad'],
  困: ['sleepy'], 睡: ['sleepy', 'sleep'], 晚安: ['night', 'sleepy'],
  生气: ['angry'], 气: ['angry'], 凶: ['angry'], 怒: ['angry'],
  爱: ['love'], 喜欢: ['love'], 心动: ['love'], 比心: ['love'],
  亲: ['kiss'], mua: ['kiss'],
  抱: ['hug'], 拥抱: ['hug'],
  想你: ['love', 'think'], 想: ['think'], 思考: ['think'],
  嘟嘴: ['pout'], 撒娇: ['cute'], 萌: ['cute'], 可爱: ['cute'],
  惊: ['shock'], 震惊: ['shock'],
  得意: ['proud'], 骄傲: ['proud'], 傲娇: ['proud'],
  耶: ['cheer'], 加油: ['cheer'], ok: ['ok'], 好的: ['ok'],
  不要: ['no'], 拒绝: ['no'],
  无语: ['whatever', 'speechless'], 翻白眼: ['eyeroll', 'dismissive'], 白眼: ['eyeroll', 'dismissive'],
  嘲: ['mock', 'sarcasm'], 讽刺: ['sarcasm'], 哼: ['dismissive', 'tsun'],
  呵呵: ['sarcasm', 'dismissive'], 尴尬: ['awkward'], 随便: ['dismissive', 'whatever'],
  算了: ['dismissive'], 无奈: ['resigned', 'tired'], 鄙视: ['mock', 'dismissive'],
  傻: ['mock', 'tease'], 笨: ['tease', 'mock'], 牛: ['impressed', 'praise'],
  酸: ['jealous'], 怀疑: ['suspicious'], 啥: ['confused'],
  拜拜: ['wave'], 再见: ['wave'], 吃: ['eat'], 饿: ['eat', 'hungry'],
  喝: ['drink'], 奶茶: ['drink'], 摸头: ['cute'], 送花: ['flower', 'love'],
  早安: ['morning'], 早上好: ['morning'], 晚上: ['night'], 周末: ['weekend'],
  生日: ['birthday', 'cake'], 咖啡: ['coffee'],
};

const EMOTION_PRIORITY = [
  'love', 'kiss', 'hug', 'happy', 'shy', 'proud', 'cheer',
  'sad', 'angry', 'jealous',
  'mock', 'sarcasm', 'dismissive', 'eyeroll', 'whatever', 'speechless', 'awkward', 'tsun',
  'sleepy', 'tired', 'shock', 'confused', 'pout', 'cute', 'wave', 'meme',
];

const EMOTION_PROMPT_CN = {
  happy: 'happy smiling joyfully, sparkling eyes, cheerful pose',
  shy: 'blushing shyly, covering cheeks with hands, bashful cute expression',
  love: 'making a heart gesture with hands, floating small pink hearts, affectionate smile',
  angry: 'pouting cutely with puffed cheeks, mildly annoyed tsundere look, tiny anger vein',
  sad: 'teary puppy eyes, slightly drooping shoulders, cute aggrieved expression',
  sleepy: 'yawning sleepily, hugging a pillow, cozy nightcap or drowsy eyes',
  night: 'waving goodnight gently with a crescent moon and tiny stars, warm cozy vibe',
  morning: 'stretching awake cheerfully with a morning coffee cup and sunshine, fresh vibe',
  hug: 'opening arms wide for a warm comforting hug, gentle smiling expression',
  mock: 'smug playful teasing grin, raised eyebrow, cheeky half-closed eyes',
  speechless: 'deadpan speechless expression, tiny sweat drop, comic silence vibe',
  proud: 'hands on hips proudly, confident smug cute smile, little sparkles',
  kiss: 'blowing a cute kiss with a wink and floating tiny heart',
  cheer: 'raising both fists cheering enthusiastically, bright encouraging smile',
  cute: 'tilting head adorably, sparkling eyes, sweet lovable pose',
};

const STYLE_PROMPTS = {
  chibi: 'Japanese anime chibi sticker illustration, clean bold dark outline, cel shading, expressive kawaii proportions, centered on a pure solid white background, white die-cut sticker border, no text, no watermark',
  pastel: 'soft pastel hand-drawn watercolor doodle sticker, warm delicate ink lines, gentle blush tones, cozy storybook charm, centered on a pure solid white background, no text, no watermark',
  pixel: 'cute retro 16-bit pixel art emoji sticker, crisp pixel edges, vibrant sakura pastel palette, expressive face, centered on a pure solid white background, no text, no watermark',
};

function ensureDirs() {
  if (!existsSync(STICKERS_DIR)) mkdirSync(STICKERS_DIR, { recursive: true });
  if (!existsSync(CANDIDATES_DIR)) mkdirSync(CANDIDATES_DIR, { recursive: true });
}

export function safeFilename(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== name || !/^[a-zA-Z0-9._-]+$/.test(base) || base.startsWith('.')) return null;
  return base;
}

export function resolveStickerFilePath(fname, { candidate = false } = {}) {
  const safe = safeFilename(fname);
  if (!safe) return null;
  const dir = candidate ? CANDIDATES_DIR : STICKERS_DIR;
  const full = path.join(dir, safe);
  if (!full.startsWith(dir) || !existsSync(full)) return null;
  return full;
}

function readManifestRaw() {
  ensureDirs();
  if (!existsSync(MANIFEST_PATH)) return { stickers: [] };
  try {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    return { stickers: Array.isArray(raw.stickers) ? raw.stickers : [] };
  } catch {
    return { stickers: [] };
  }
}

function writeManifestRaw(data) {
  ensureDirs();
  writeFileSync(MANIFEST_PATH, JSON.stringify({ stickers: data.stickers || [] }, null, 2) + '\n', 'utf-8');
  reloadStickers();
}

function readWishlistRaw() {
  ensureDirs();
  if (!existsSync(WISHLIST_PATH)) return { auto_approve: false, wishes: [] };
  try {
    const raw = JSON.parse(readFileSync(WISHLIST_PATH, 'utf-8'));
    return {
      auto_approve: Boolean(raw.auto_approve),
      wishes: Array.isArray(raw.wishes) ? raw.wishes : [],
    };
  } catch {
    return { auto_approve: false, wishes: [] };
  }
}

function writeWishlistRaw(data) {
  ensureDirs();
  writeFileSync(WISHLIST_PATH, JSON.stringify({
    auto_approve: Boolean(data.auto_approve),
    wishes: Array.isArray(data.wishes) ? data.wishes : [],
  }, null, 2) + '\n', 'utf-8');
}

export function normalizeTags(input) {
  const arr = Array.isArray(input)
    ? input
    : String(input || '').split(/[,，、\s]+/);
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const t = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_\u4e00-\u9fa5-]/g, '');
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function deriveTagsFromName(name, baseTags = []) {
  const found = new Set(baseTags.map(t => String(t).toLowerCase()));
  const lower = String(name || '').toLowerCase();
  for (const [kw, tags] of Object.entries(KEYWORD_MAP)) {
    if (lower.includes(kw.toLowerCase())) {
      for (const t of tags) found.add(t);
    }
  }
  return [...found];
}

function pickPrimaryEmotion(tags, fallback = 'cute') {
  for (const p of EMOTION_PRIORITY) {
    if (tags.includes(p)) return p;
  }
  return fallback;
}

function slugifyAscii(str, fallback = 'item') {
  const cleaned = String(str || '').replace(/[^\x20-\x7E]+/g, '').replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return cleaned || fallback;
}

// ─── 1. 列表 & CRUD & 手动上传 ───────────────────────────────────────────────

export function getStickerStudioState() {
  const manifest = readManifestRaw();
  const wishlist = readWishlistRaw();
  const items = manifest.stickers
    .filter(s => s?.file && existsSync(path.join(STICKERS_DIR, s.file)))
    .map(s => ({
      id: s.id,
      file: s.file,
      url: `/api/stickers/file/${encodeURIComponent(s.file)}`,
      tags: Array.isArray(s.tags) ? s.tags : [],
      emotion: s.emotion || 'cute',
      description: s.description || '',
      source: s.source || 'local',
      disabled: s.disabled === true,
      created_at: s.created_at || null,
    }));

  const tagCounts = {};
  let activeCount = 0;
  for (const s of items) {
    if (!s.disabled) activeCount++;
    const all = new Set([...(s.tags || []), s.emotion].filter(Boolean));
    for (const t of all) tagCounts[t] = (tagCounts[t] || 0) + 1;
  }

  const wishes = wishlist.wishes.map(w => ({
    ...w,
    candidate: w.candidate && w.candidate.file && existsSync(path.join(CANDIDATES_DIR, w.candidate.file))
      ? { ...w.candidate, url: `/api/stickers/candidate/${encodeURIComponent(w.candidate.file)}` }
      : null,
  }));

  return {
    total: items.length,
    active_count: activeCount,
    disabled_count: items.length - activeCount,
    tags: Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count })),
    stickers: items,
    curated_packs: CURATED_PACKS.map(p => ({
      id: p.id,
      name: p.name,
      emoji: p.emoji,
      desc: p.desc,
      base_tags: p.baseTags,
      default_emotion: p.defaultEmotion,
      risk: p.risk,
      risk_label: p.riskLabel,
    })),
    wishlist: {
      auto_approve: wishlist.auto_approve,
      items: wishes,
    },
  };
}

async function tryAutoTagWithVision(buf, mime) {
  try {
    const { visionRecognize } = await import('./providers/vision.mjs');
    const prompt = '请看这张表情包，只输出一行合法 JSON（不要 markdown）：{"emotion":"happy|love|sad|sleepy|shy|angry|shock|cute|mock|kiss|cheer|hug|wave|speechless|proud|other","tags":["2-4个英文小写情绪或场景标签"],"description":"8字以内中文简述"}';
    const raw = await visionRecognize(buf, mime, prompt);
    const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return {
      emotion: String(parsed.emotion || '').toLowerCase() || null,
      tags: normalizeTags(parsed.tags || []),
      description: String(parsed.description || '').slice(0, 40),
    };
  } catch (e) {
    log('debug', `[StickerStudio] vision auto-tag skipped: ${e.message}`);
    return null;
  }
}

export async function importStickerFromBase64({
  imageBase64,
  filename = '',
  tags = [],
  emotion = '',
  description = '',
  autoTag = false,
} = {}) {
  const dataUrl = String(imageBase64 || '');
  const m = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/i);
  if (!m) throw new Error('图片格式无效，仅支持 PNG / JPG / WebP / GIF');

  const mime = m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 100) throw new Error('图片数据异常或为空');
  if (buf.length > MAX_UPLOAD_BYTES) throw new Error('单张图片不能超过 1.5MB');

  const ext = mime.split('/')[1].replace('jpeg', 'jpg');
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  const id = `custom_${stamp}_${rand}`;
  const outName = `${id}.${ext}`;

  ensureDirs();
  writeFileSync(path.join(STICKERS_DIR, outName), buf);

  let finalTags = normalizeTags(tags);
  let finalEmotion = String(emotion || '').trim().toLowerCase();
  let finalDesc = String(description || '').trim() || String(filename || '').replace(/\.[^.]+$/, '').slice(0, 40);

  if (autoTag && mime !== 'image/gif') {
    const aiTag = await tryAutoTagWithVision(buf, mime);
    if (aiTag) {
      finalTags = normalizeTags([...finalTags, ...aiTag.tags]);
      if (!finalEmotion && aiTag.emotion) finalEmotion = aiTag.emotion;
      if (!finalDesc && aiTag.description) finalDesc = aiTag.description;
    }
  }

  if (!finalTags.length && filename) {
    finalTags = deriveTagsFromName(filename, ['cute']);
  }
  if (!finalEmotion) {
    finalEmotion = pickPrimaryEmotion(finalTags, 'cute');
  }
  if (!finalTags.includes(finalEmotion)) finalTags.unshift(finalEmotion);

  const entry = {
    id,
    file: outName,
    tags: finalTags,
    emotion: finalEmotion,
    description: finalDesc,
    source: 'manual-upload',
    disabled: false,
    created_at: new Date().toISOString(),
  };

  const manifest = readManifestRaw();
  manifest.stickers.unshift(entry);
  writeManifestRaw(manifest);
  log('info', `[StickerStudio] uploaded id=${id} file=${outName} tags=${finalTags.join(',')}`);
  return { ...entry, url: `/api/stickers/file/${encodeURIComponent(outName)}` };
}

export function updateStickerMeta(id, patch = {}) {
  const manifest = readManifestRaw();
  const idx = manifest.stickers.findIndex(s => s.id === id);
  if (idx === -1) return null;

  const item = { ...manifest.stickers[idx] };
  if (patch.tags !== undefined) item.tags = normalizeTags(patch.tags);
  if (patch.emotion !== undefined) {
    const emo = String(patch.emotion || '').trim().toLowerCase();
    if (emo) item.emotion = emo;
  }
  if (patch.description !== undefined) item.description = String(patch.description || '').trim().slice(0, 80);
  if (patch.disabled !== undefined) item.disabled = Boolean(patch.disabled);

  manifest.stickers[idx] = item;
  writeManifestRaw(manifest);
  return { ...item, url: `/api/stickers/file/${encodeURIComponent(item.file)}` };
}

export function deleteSticker(id) {
  const manifest = readManifestRaw();
  const idx = manifest.stickers.findIndex(s => s.id === id);
  if (idx === -1) return false;
  const [removed] = manifest.stickers.splice(idx, 1);
  writeManifestRaw(manifest);
  const full = resolveStickerFilePath(removed?.file);
  if (full) {
    try { unlinkSync(full); } catch { /* ignore */ }
  }
  log('info', `[StickerStudio] deleted id=${id} file=${removed?.file || ''}`);
  return true;
}

// ─── 2. 人设智能推荐 + 精选开源表情库一键拉取 ──────────────────────────────

export function recommendPacksForCompanion(companion = null) {
  const text = [
    companion?.name,
    companion?.persona_summary,
    companion?.persona_prompt,
    companion?.background,
    companion?.personality,
    companion?.tone,
  ].filter(Boolean).join(' ');

  const scored = CURATED_PACKS.map(pack => {
    let score = pack.risk === 'low' ? 1 : 0;
    const matched = [];
    for (const trait of pack.traits) {
      if (text && text.includes(trait)) {
        score += 3;
        matched.push(trait);
      }
    }
    return { pack, score, matched };
  }).sort((a, b) => b.score - a.score);

  const hasMatch = scored.some(s => s.matched.length > 0);
  const picks = hasMatch
    ? scored.slice(0, 3)
    : scored.filter(s => ['cat_everyday', 'happy_duck', 'cute_girl'].includes(s.pack.id));

  const name = companion?.name || '她';
  const reason = hasMatch
    ? `结合「${name}」的人设关键词（${[...new Set(picks.flatMap(p => p.matched))].slice(0, 5).join('、')}），为你挑了这 ${picks.length} 套最贴合她性格的表情包：`
    : `为「${name}」推荐一套百搭起手组合（软萌猫咪 + 元气小鸭 + 可爱少女），涵盖开心、撒娇、害羞、晚安等高频聊天场景：`;

  return {
    companion_name: name,
    pack_ids: picks.map(p => p.pack.id),
    reason,
    details: picks.map(p => ({
      id: p.pack.id,
      name: p.pack.name,
      emoji: p.pack.emoji,
      matched_traits: p.matched,
    })),
  };
}

async function fetchJsonWithTimeout(url, ms = 15000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'xiyuai-sticker-studio', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchBufferWithLimit(url, maxBytes = MAX_REMOTE_BYTES, ms = 20000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'xiyuai-sticker-studio' },
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`file too large (${buf.length} bytes)`);
  if (buf.length < 100) throw new Error('empty image');
  return buf;
}

const CURATED_LIST_TTL_MS = 30 * 60 * 1000;
const CURATED_LIST_CACHE = new Map(); // packId -> { ts, items }
const CURATED_IMG_CACHE = new Map();  // `${packId}/${name}` -> { buffer, contentType }
const MAX_PREVIEW_IMG_CACHE = 120;

const EXT_TO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

async function listCuratedPackFiles(pack, { fetcher = fetchJsonWithTimeout } = {}) {
  const cached = CURATED_LIST_CACHE.get(pack.id);
  if (cached && (Date.now() - cached.ts) < CURATED_LIST_TTL_MS) {
    return cached.items;
  }
  const raw = await fetcher(GH_CONTENTS_BASE + encodeURIComponent(pack.repoDir));
  if (!Array.isArray(raw)) throw new Error('返回列表异常');
  const filtered = raw.filter(
    it => it?.type === 'file'
      && /\.(png|jpe?g|gif|webp)$/i.test(it.name || '')
      && (it.size || 0) <= MAX_REMOTE_BYTES,
  );
  CURATED_LIST_CACHE.set(pack.id, { ts: Date.now(), items: filtered });
  return filtered;
}

export async function previewCuratedPack(packId, { limit = 12, offset = 0, fetcher } = {}) {
  const pack = CURATED_PACKS.find(p => p.id === packId);
  if (!pack) throw new Error('未知的精选表情包');
  const safeLimit = Math.max(1, Math.min(24, Number(limit) || 12));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const files = await listCuratedPackFiles(pack, fetcher ? { fetcher } : {});
  const slice = files.slice(safeOffset, safeOffset + safeLimit).map(it => {
    const tags = deriveTagsFromName(it.name, pack.baseTags);
    const emotion = pickPrimaryEmotion(tags, pack.defaultEmotion);
    return {
      name: it.name,
      label: String(it.name || '').replace(/\.[^.]+$/, '').slice(0, 40),
      size: it.size || 0,
      tags,
      emotion,
      preview_url: `/api/stickers/curated-preview/${encodeURIComponent(pack.id)}/${encodeURIComponent(it.name)}`,
    };
  });
  return {
    pack: {
      id: pack.id,
      name: pack.name,
      emoji: pack.emoji,
      desc: pack.desc,
      risk: pack.risk,
      risk_label: pack.riskLabel,
      base_tags: pack.baseTags,
    },
    total_in_pack: files.length,
    offset: safeOffset,
    limit: safeLimit,
    has_more: safeOffset + slice.length < files.length,
    items: slice,
  };
}

export async function fetchCuratedPreviewImage(packId, filename, { fetcher = fetchBufferWithLimit } = {}) {
  const pack = CURATED_PACKS.find(p => p.id === packId);
  if (!pack) return null;
  const rawName = String(filename || '').trim();
  if (!rawName || rawName.includes('/') || rawName.includes('\\') || rawName.includes('..') || rawName.startsWith('.')) {
    return null;
  }
  const ext = path.extname(rawName).toLowerCase();
  const contentType = EXT_TO_MIME[ext];
  if (!contentType) return null;

  const cacheKey = `${pack.id}/${rawName}`;
  const hit = CURATED_IMG_CACHE.get(cacheKey);
  if (hit) return hit;

  const rawUrl = GH_RAW_BASE + encodeURIComponent(pack.repoDir) + '/' + encodeURIComponent(rawName);
  const buffer = await fetcher(rawUrl, MAX_REMOTE_BYTES);
  const entry = { buffer, contentType };
  if (CURATED_IMG_CACHE.size >= MAX_PREVIEW_IMG_CACHE) {
    const firstKey = CURATED_IMG_CACHE.keys().next().value;
    if (firstKey !== undefined) CURATED_IMG_CACHE.delete(firstKey);
  }
  CURATED_IMG_CACHE.set(cacheKey, entry);
  return entry;
}

export async function fetchCuratedPacks(packIds = [], { perPack = 8 } = {}) {
  const limit = Math.max(1, Math.min(20, Number(perPack) || 8));
  const selected = CURATED_PACKS.filter(p => packIds.includes(p.id));
  if (!selected.length) throw new Error('请至少选择一个精选表情包');

  ensureDirs();
  const manifest = readManifestRaw();
  const existingFiles = new Set(manifest.stickers.map(s => s.file));
  const existingIds = new Set(manifest.stickers.map(s => s.id));

  let added = 0;
  let skipped = 0;
  const errors = [];
  const addedItems = [];

  for (const pack of selected) {
    let candidates;
    try {
      const files = await listCuratedPackFiles(pack);
      candidates = files.slice(0, limit);
    } catch (e) {
      errors.push(`${pack.name}: ${e.message}`);
      continue;
    }

    const slugBase = slugifyAscii(pack.id, 'pack');
    for (let i = 0; i < candidates.length; i++) {
      const it = candidates[i];
      const origName = it.name;
      const ext = path.extname(origName).toLowerCase() || '.png';
      const id = `${slugBase}_${String(i + 1).padStart(2, '0')}`;
      const outName = `${id}${ext}`;

      if (existingFiles.has(outName) || existingIds.has(id) || existsSync(path.join(STICKERS_DIR, outName))) {
        skipped++;
        continue;
      }

      const rawUrl = GH_RAW_BASE + encodeURIComponent(pack.repoDir) + '/' + encodeURIComponent(origName);
      try {
        const buf = await fetchBufferWithLimit(rawUrl, MAX_REMOTE_BYTES);
        writeFileSync(path.join(STICKERS_DIR, outName), buf);
        const tags = deriveTagsFromName(origName, pack.baseTags);
        const emotion = pickPrimaryEmotion(tags, pack.defaultEmotion);
        const entry = {
          id,
          file: outName,
          tags,
          emotion,
          description: origName.replace(/\.[^.]+$/, '').slice(0, 50),
          source: `ChineseBQB/${pack.id}`,
          disabled: false,
          created_at: new Date().toISOString(),
        };
        manifest.stickers.push(entry);
        existingFiles.add(outName);
        existingIds.add(id);
        addedItems.push({ ...entry, url: `/api/stickers/file/${encodeURIComponent(outName)}` });
        added++;
      } catch (e) {
        errors.push(`${pack.name}/${origName}: ${e.message}`);
      }
    }
  }

  writeManifestRaw(manifest);
  log('info', `[StickerStudio] fetched packs=${selected.map(p => p.id).join(',')} added=${added} skipped=${skipped} errors=${errors.length}`);
  return { added, skipped, total: manifest.stickers.length, errors: errors.slice(0, 6), items: addedItems };
}

// ─── 3. AI 按人设/外貌生成专属 Q 版表情包 ───────────────────────────────────

async function generateStickerImageBuffer({ companion = null, emotion = 'happy', promptHint = '', style = 'chibi' }) {
  const { imageGenerate } = await import('./providers/image.mjs');
  const { getVisualIdentity, buildIdentityPrompt, selectReferenceImage } = await import('./visual_identity.mjs');
  const { downloadImageWithGuards } = await import('./security/netguard.mjs');

  let subjectDesc = 'a charming young East Asian woman with warm expressive eyes';
  let refImage = null;
  if (companion?.id) {
    try {
      const vi = getVisualIdentity(companion.id);
      if (vi) {
        subjectDesc = buildIdentityPrompt(vi) || subjectDesc;
      } else if (companion.persona_summary) {
        subjectDesc = `a cute anime character matching: ${String(companion.persona_summary).slice(0, 120)}`;
      }
      refImage = selectReferenceImage(companion.id) || null;
    } catch { /* fallback to generic subject */ }
  }

  const emoKey = String(emotion || 'happy').trim().toLowerCase();
  const emoPrompt = EMOTION_PROMPT_CN[emoKey] || `expressing "${emoKey}" emotion clearly`;
  const stylePrompt = STYLE_PROMPTS[style] || STYLE_PROMPTS.chibi;
  const extra = String(promptHint || '').trim() ? `, extra details: ${String(promptHint).trim().slice(0, 140)}` : '';

  const fullPrompt = `${stylePrompt}. Character: ${subjectDesc}. Pose & expression: ${emoPrompt}${extra}. Upper body portrait, cute sticker composition.`;
  const result = await imageGenerate(fullPrompt, { size: '1024x1024', referenceImage: refImage });
  if (!result) throw new Error('未配置生图模型（请先在模型设置里配置 Image Provider 或智谱/通义/OpenAI Key）');

  let buf = null;
  let ext = 'png';
  if (typeof result === 'string') {
    const dataMatch = result.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (dataMatch) {
      buf = Buffer.from(dataMatch[2], 'base64');
      ext = dataMatch[1].toLowerCase().replace('jpeg', 'jpg');
    } else if (/^https?:\/\//i.test(result)) {
      const dl = await downloadImageWithGuards(result, { maxBytes: 5 * 1024 * 1024 });
      buf = dl.buffer;
      if (/webp/i.test(dl.contentType || '')) ext = 'webp';
      else if (/jpe?g/i.test(dl.contentType || '')) ext = 'jpg';
    }
  } else if (result.b64) {
    buf = Buffer.from(result.b64, 'base64');
  } else if (result.url) {
    const dl = await downloadImageWithGuards(result.url, { maxBytes: 5 * 1024 * 1024 });
    buf = dl.buffer;
    if (/webp/i.test(dl.contentType || '')) ext = 'webp';
    else if (/jpe?g/i.test(dl.contentType || '')) ext = 'jpg';
  }
  if (!buf || buf.length < 100) throw new Error('生图返回内容为空');

  // 如果装了 sharp，压缩到 512x512 webp，微信发送更快
  try {
    const { default: sharp } = await import('sharp');
    buf = await sharp(buf).resize(512, 512, { fit: 'cover' }).webp({ quality: 86 }).toBuffer();
    ext = 'webp';
  } catch { /* sharp unavailable on this arch; keep raw buffer */ }

  return { buf, ext, emotion: emoKey };
}

export async function generateCustomSticker({
  companion = null,
  emotion = 'happy',
  tags = [],
  promptHint = '',
  style = 'chibi',
  saveAsCandidate = false,
} = {}) {
  const { buf, ext, emotion: emoKey } = await generateStickerImageBuffer({ companion, emotion, promptHint, style });
  ensureDirs();
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(2).toString('hex');
  const slug = slugifyAscii(emoKey, 'emo');
  const id = `ai_${slug}_${stamp}_${rand}`;
  const outName = `${id}.${ext}`;
  const destDir = saveAsCandidate ? CANDIDATES_DIR : STICKERS_DIR;
  writeFileSync(path.join(destDir, outName), buf);

  const finalTags = normalizeTags([emoKey, 'ai', style, ...normalizeTags(tags)]);
  const desc = promptHint ? String(promptHint).slice(0, 40) : `AI 定制 · ${emoKey}`;

  if (saveAsCandidate) {
    return {
      file: outName,
      url: `/api/stickers/candidate/${encodeURIComponent(outName)}`,
      tags: finalTags,
      emotion: emoKey,
      description: desc,
      source: 'ai-generated',
    };
  }

  const entry = {
    id,
    file: outName,
    tags: finalTags,
    emotion: emoKey,
    description: desc,
    source: 'ai-generated',
    disabled: false,
    created_at: new Date().toISOString(),
  };
  const manifest = readManifestRaw();
  manifest.stickers.unshift(entry);
  writeManifestRaw(manifest);
  log('info', `[StickerStudio] AI generated sticker id=${id} emotion=${emoKey}`);
  return { ...entry, url: `/api/stickers/file/${encodeURIComponent(outName)}` };
}

// ─── 4. 心愿收藏箱（聊天缺标签时后台异步记录 & 收集候选） ───────────────────

const activeWishJobs = new Set();

export function setWishlistAutoApprove(enabled) {
  const wl = readWishlistRaw();
  wl.auto_approve = Boolean(enabled);
  writeWishlistRaw(wl);
  return { auto_approve: wl.auto_approve };
}

export function recordStickerWish({ tag, companionId = null, context = '', autoCollect = true } = {}) {
  const cleanTag = String(tag || '').trim().toLowerCase().replace(/[^a-z0-9_\u4e00-\u9fa5-]/g, '');
  if (!cleanTag) return null;

  const wl = readWishlistRaw();
  const now = new Date().toISOString();
  let wish = wl.wishes.find(w => w.tag === cleanTag && w.status !== 'approved' && w.status !== 'dismissed');
  if (wish) {
    wish.count = (wish.count || 1) + 1;
    wish.updated_at = now;
    if (context) wish.context = String(context).slice(0, 80);
  } else {
    wish = {
      id: `wish_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`,
      tag: cleanTag,
      count: 1,
      companion_id: companionId || null,
      context: String(context || '').slice(0, 80),
      status: 'pending',
      candidate: null,
      created_at: now,
      updated_at: now,
    };
    wl.wishes.unshift(wish);
    if (wl.wishes.length > 60) wl.wishes = wl.wishes.slice(0, 60);
  }
  writeWishlistRaw(wl);

  if (autoCollect && !wish.candidate && !activeWishJobs.has(wish.id)) {
    activeWishJobs.add(wish.id);
    fulfillStickerWish(wish.id, { strategy: 'auto' })
      .catch(err => log('debug', `[StickerWish] async collect failed tag=${cleanTag}: ${err.message}`))
      .finally(() => activeWishJobs.delete(wish.id));
  }
  return wish;
}

async function searchCuratedCandidateForTag(tag) {
  const lower = String(tag || '').toLowerCase();
  // 匹配最相关的精选包
  const rankedPacks = [...CURATED_PACKS].sort((a, b) => {
    const am = a.baseTags.includes(lower) || a.defaultEmotion === lower ? 1 : 0;
    const bm = b.baseTags.includes(lower) || b.defaultEmotion === lower ? 1 : 0;
    return bm - am;
  });

  // 反向找匹配这个 tag 的中文关键词
  const matchKeywords = [lower];
  for (const [kw, tags] of Object.entries(KEYWORD_MAP)) {
    if (tags.includes(lower) || kw.toLowerCase() === lower) matchKeywords.push(kw.toLowerCase());
  }

  for (const pack of rankedPacks.slice(0, 3)) {
    let items;
    try {
      items = await fetchJsonWithTimeout(GH_CONTENTS_BASE + encodeURIComponent(pack.repoDir), 12000);
    } catch { continue; }
    if (!Array.isArray(items)) continue;
    const valid = items.filter(it => it?.type === 'file' && /\.(png|jpe?g|gif|webp)$/i.test(it.name || '') && (it.size || 0) <= MAX_REMOTE_BYTES);
    if (!valid.length) continue;

    // 优先挑文件名命中关键字的
    const matched = valid.find(it => matchKeywords.some(kw => it.name.toLowerCase().includes(kw))) || valid[Math.floor(Math.random() * Math.min(valid.length, 15))];
    if (!matched) continue;

    const rawUrl = GH_RAW_BASE + encodeURIComponent(pack.repoDir) + '/' + encodeURIComponent(matched.name);
    const buf = await fetchBufferWithLimit(rawUrl, MAX_REMOTE_BYTES, 15000);
    const ext = path.extname(matched.name).toLowerCase() || '.png';
    const fname = `cand_${slugifyAscii(lower, 'tag')}_${Date.now().toString(36)}${ext}`;
    ensureDirs();
    writeFileSync(path.join(CANDIDATES_DIR, fname), buf);
    const tags = normalizeTags([lower, ...deriveTagsFromName(matched.name, pack.baseTags)]);
    return {
      file: fname,
      url: `/api/stickers/candidate/${encodeURIComponent(fname)}`,
      tags,
      emotion: pickPrimaryEmotion(tags, lower),
      description: matched.name.replace(/\.[^.]+$/, '').slice(0, 50),
      source: `ChineseBQB/${pack.id}`,
    };
  }
  return null;
}

export async function fulfillStickerWish(wishId, { strategy = 'auto', companion = null } = {}) {
  const wl = readWishlistRaw();
  const wish = wl.wishes.find(w => w.id === wishId);
  if (!wish) throw new Error('心愿记录不存在');

  let candidate;
  if (strategy === 'ai') {
    candidate = await generateCustomSticker({ companion, emotion: wish.tag, tags: [wish.tag], saveAsCandidate: true });
  } else if (strategy === 'curated') {
    candidate = await searchCuratedCandidateForTag(wish.tag);
    if (!candidate) throw new Error('精选图源暂未找到匹配候选，可试试「AI 画一张」');
  } else {
    candidate = await searchCuratedCandidateForTag(wish.tag).catch(() => null);
    if (!candidate) {
      candidate = await generateCustomSticker({ companion, emotion: wish.tag, tags: [wish.tag], saveAsCandidate: true });
    }
  }

  // 删除旧候选图避免残留
  if (wish.candidate?.file && wish.candidate.file !== candidate.file) {
    const oldPath = resolveStickerFilePath(wish.candidate.file, { candidate: true });
    if (oldPath) { try { unlinkSync(oldPath); } catch { /* ignore */ } }
  }

  wish.candidate = {
    file: candidate.file,
    tags: candidate.tags,
    emotion: candidate.emotion,
    description: candidate.description,
    source: candidate.source,
  };
  wish.status = 'ready';
  wish.updated_at = new Date().toISOString();
  writeWishlistRaw(wl);

  if (wl.auto_approve) {
    const approved = approveStickerWish(wish.id);
    return { auto_approved: true, sticker: approved };
  }

  return {
    auto_approved: false,
    wish: { ...wish, candidate: { ...wish.candidate, url: `/api/stickers/candidate/${encodeURIComponent(candidate.file)}` } },
  };
}

export function approveStickerWish(wishId, overrides = {}) {
  const wl = readWishlistRaw();
  const idx = wl.wishes.findIndex(w => w.id === wishId);
  if (idx === -1) throw new Error('心愿记录不存在');
  const wish = wl.wishes[idx];
  if (!wish.candidate?.file) throw new Error('该心愿还没有候选表情图，请先收集一张');

  const candPath = resolveStickerFilePath(wish.candidate.file, { candidate: true });
  if (!candPath) throw new Error('候选图片已丢失，请重新收集');

  const ext = path.extname(wish.candidate.file) || '.png';
  const id = `wish_${slugifyAscii(wish.tag, 'tag')}_${Date.now().toString(36)}`;
  const destName = `${id}${ext}`;
  renameSync(candPath, path.join(STICKERS_DIR, destName));

  const tags = normalizeTags(overrides.tags || wish.candidate.tags || [wish.tag]);
  const emotion = String(overrides.emotion || wish.candidate.emotion || wish.tag || 'cute').toLowerCase();
  const entry = {
    id,
    file: destName,
    tags: tags.includes(emotion) ? tags : [emotion, ...tags],
    emotion,
    description: String(overrides.description || wish.candidate.description || wish.tag).slice(0, 60),
    source: wish.candidate.source || 'wishlist',
    disabled: false,
    created_at: new Date().toISOString(),
  };

  const manifest = readManifestRaw();
  manifest.stickers.unshift(entry);
  writeManifestRaw(manifest);

  wl.wishes.splice(idx, 1);
  writeWishlistRaw(wl);
  log('info', `[StickerWish] approved wish=${wishId} -> sticker=${id}`);
  return { ...entry, url: `/api/stickers/file/${encodeURIComponent(destName)}` };
}

export function dismissStickerWish(wishId) {
  const wl = readWishlistRaw();
  const idx = wl.wishes.findIndex(w => w.id === wishId);
  if (idx === -1) return false;
  const [removed] = wl.wishes.splice(idx, 1);
  writeWishlistRaw(wl);
  if (removed?.candidate?.file) {
    const full = resolveStickerFilePath(removed.candidate.file, { candidate: true });
    if (full) { try { unlinkSync(full); } catch { /* ignore */ } }
  }
  return true;
}
