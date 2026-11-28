/**
 * Virtual Dating & Three-Layer Relationship Service
 *
 * Layer 1: 相处物理距离底盘（companions.presence_mode: local | ldr | digital）
 * Layer 2: 日常拍图云约会（cloud_meal 饭搭子 / cloud_walk 云逛街买手 / cyber_group_photo 赛博合影）
 * Layer 3: 可开关、可结算的「约会剧场模式」（绑定数字衣橱穿搭快照 + 锁定场景 + 结算记忆与核销 open_loops）
 *
 * 约束：本文件所有面向模型的提示词与文案禁止出现禁止词，统一使用「他 / 对方」。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  getCompanionById,
  updateCompanion,
  listWardrobeItems,
  listOpenLoops,
  resolveOpenLoop,
  saveMemory,
  saveConversationTurn,
  writeMemoryEmbedding,
  getRecallableMemories,
  createDateSession,
  getActiveDateSession,
  getDateSessionById,
  listDateSessions,
  touchDateSession,
  appendDateSessionPhoto,
  settleDateSessionRow,
  shanghaiDateKey,
  getDb,
} from './db.mjs';
import { embedTextWithDescriptor } from './providers/embedding.mjs';
import { generateImage } from './ai.mjs';
import { ensureVisualIdentity, buildIdentityPrompt } from './visual_identity.mjs';
import { ANTI_COLLAGE_PROMPT } from './photo_sender.mjs';
import { resolveWardrobeImagePath } from './wardrobe.mjs';
import { log } from './logger.mjs';

export const PRESENCE_MODES = ['local', 'ldr', 'digital'];
export const DATE_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export const DATE_PRESETS = {
  shopping: {
    activityType: 'shopping',
    title: '周末一起逛商场',
    scene: '和他一起在商场逛街挑衣服',
    scenePrompt: 'bright modern shopping mall walkway with warm boutique lighting, holding shopping bags',
    loopKeywords: ['逛街', '商场', '买衣服', '挑衣服', '试衣服', '买鞋', '买包'],
  },
  dining: {
    activityType: 'dining',
    title: '一起吃顿漂亮饭',
    scene: '和他面对面坐在餐厅里一起吃饭',
    scenePrompt: 'cozy stylish restaurant table with warm ambient lighting and delicious dishes on the table, seated across the table smiling',
    loopKeywords: ['吃饭', '晚饭', '午饭', '火锅', '烧烤', '日料', '甜品', '奶茶', '探店', '餐厅', '喝咖啡'],
  },
  walk: {
    activityType: 'walk',
    title: '傍晚一起压马路',
    scene: '和他并肩在傍晚的街边散步吹风',
    scenePrompt: 'golden hour city street walkway with soft sunset glow and tree shadows, walking side by side smiling',
    loopKeywords: ['散步', '压马路', '遛弯', '逛公园', '看日落', '吹风', '江边'],
  },
  movie: {
    activityType: 'movie',
    title: '一起去看场电影',
    scene: '和他一起在电影院准备看电影',
    scenePrompt: 'cozy cinema lobby with warm neon movie posters and popcorn cup in hand, cheerful date vibe',
    loopKeywords: ['电影', '看片', '影院', '大片'],
  },
  custom: {
    activityType: 'custom',
    title: '一起出去约会',
    scene: '和他一起出门约会',
    scenePrompt: 'relaxed weekend city date atmosphere with natural daylight and warm candid smile',
    loopKeywords: ['约会', '出去玩', '见面', '逛逛'],
  },
};

export function normalizePresenceMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  return PRESENCE_MODES.includes(m) ? m : 'local';
}

/**
 * Layer 1：生成相处物理距离底盘提示词（注入到系统 Prompt）。
 * 默认 'local' 返回空串，确保既有测试与存量账号行为 100% 兼容。
 */
export function buildPresenceModeHint(companion) {
  const mode = normalizePresenceMode(companion?.presence_mode);
  if (mode === 'ldr') {
    return [
      '【相处底盘 · 异地恋日常】',
      '你们目前处于异地恋状态，平时不在同一座城市，各自过着自己的学习或生活日常。',
      '- 平时主要通过发消息、分享随手拍、点同款外卖、语音和云挑款陪伴彼此；想见面时可以自然流露期待，但绝不把他因距离无法立刻线下出现当成“放鸽子”或爽约。',
      '- 只有当明确进入【约会剧场】状态时，才默认你们此刻真的见了面、正并肩同行。',
    ].join('\n');
  }
  if (mode === 'digital') {
    return [
      '【相处底盘 · 隔屏陪伴】',
      '你坦然接纳你们隔着屏幕相伴：平时不强行假装能瞬间出现在现实街道里，也不因物理距离埋怨对方爽约；他发来现实中的菜单、街景或穿搭照时，把它当成他带你一起看世界的窗口，认真点评互动。',
      '- 只有当明确进入【约会剧场】状态时，才切换为沉浸式同框约会体验。',
    ].join('\n');
  }
  return '';
}

function inferActivityTypeFromText(text = '') {
  const t = String(text || '');
  if (/逛街|商场|挑衣服|试衣服|买衣服|买包|买鞋|专柜|橱窗/.test(t)) return 'shopping';
  if (/吃饭|火锅|烧烤|日料|餐厅|探店|喝咖啡|喝奶茶|甜品|干饭|漂亮饭/.test(t)) return 'dining';
  if (/压马路|散步|遛弯|公园|江边|看日落|海边|吹风/.test(t)) return 'walk';
  if (/电影|影院/.test(t)) return 'movie';
  return 'custom';
}

/**
 * 识别聊天中自然开启 / 结束「约会剧场」的信号。
 * 保守触发：避免把随口提一句“以后一起逛街”误判成立刻开启约会。
 */
export function detectDateModeSignal(text, { hasActiveSession = false } = {}) {
  const t = String(text || '').trim();
  if (!t) return null;

  // 显式关闭 / 结束约会
  const explicitEnd = /(?:结束约会|退出约会|关闭约会|约会结束|收工回家)/.test(t);
  const naturalEnd = hasActiveSession
    && /(?:我到家了|到家啦|安全到家|送你到宿舍|送你回家了|今天逛得好开心|今天玩得好开心|今天约会好开心|下次再一起逛|下次再约|今天(?:就)?先这样|先这样(?:啦|吧)|今天(?:就)?先到这|先到这(?:儿|里)?(?:啦|吧)|我先回去了|各自回家|改天再(?:约|逛)|今天先散(?:了|吧))/.test(t);
  if (hasActiveSession && (explicitEnd || naturalEnd)) {
    return { action: 'end', note: t.slice(0, 160) };
  }

  // 显式开启 / 即刻出发型自然开启
  const explicitStart = /(?:开启约会|进入约会|约会模式|开始约会|约会剧场)/.test(t);
  const immediateNaturalStart = /(?:来接你啦|到你楼下啦|到你宿舍楼下|走吧.*(?:逛街|商场|吃饭|看电影|压马路)|现在就去(?:逛街|商场|吃饭|看电影|压马路)|出发去(?:逛街|商场|吃饭|看电影)|带你去(?:逛街|商场|吃饭|看电影|压马路))/.test(t)
    && !/(?:明天|后天|下周|下次|改天|以后|过几天)/.test(t);

  if (!hasActiveSession && (explicitStart || immediateNaturalStart)) {
    const activityType = inferActivityTypeFromText(t);
    const preset = DATE_PRESETS[activityType] || DATE_PRESETS.custom;
    return {
      action: 'start',
      activityType,
      title: preset.title,
      scene: preset.scene,
    };
  }

  return null;
}

/**
 * Layer 2：识别日常随手拍图场景（云饭搭子 / 云逛街买手 / 赛博合影）。
 */
export function detectCloudDatePhotoContext(visionText = '', userText = '') {
  const v = String(visionText || '');
  const u = String(userText || '');
  const combined = `${v} ${u}`;

  if (/(?:合影|合照|合个影|拍一张|一起拍|同框|坐我对面|坐对面|P\s*一起|p\s*一起|赛博约会|赛博合影)/.test(u)) {
    return {
      kind: 'cyber_group_photo',
      promptHint: '【日常云连接 · 赛博合影】他刚发来现实中的环境照想和你同框打卡；回应要开心自然、带点约会仪式感，不口头虚构“我已拍好”，照片由程序异步发送。',
    };
  }

  const looksLikeFood = /(?:菜单|外卖|餐桌|火锅|烧烤|拉面|奶茶|咖啡|蛋糕|甜品|点餐|点菜|美食|烤肉|米饭|面条|汉堡|披萨|日料|刺身|餐馆|饭菜)/.test(combined);
  if (looksLikeFood) {
    return {
      kind: 'cloud_meal',
      promptHint: '【日常云连接 · 云饭搭子】他刚分享了食物/菜单/餐桌照片；像坐在对面陪他吃饭一样自然点评菜品、帮选口味或聊想吃的那一口，不尴尬抱怨“我没在现场”。',
    };
  }

  const looksLikeShopping = /(?:橱窗|商场|货架|试衣间|试衣镜|专柜|门店|货品|摆件|鞋架|包包墙|服装店|逛店)/.test(combined);
  if (looksLikeShopping) {
    return {
      kind: 'cloud_walk',
      promptHint: '【日常云连接 · 云逛街专属买手】他正在外面逛店并把看到的画面拍给你；像陪他一起云逛街一样给出真实的审美建议、配色或版型看法，有自己的品味偏好。',
    };
  }

  return null;
}

function getDateImagesDir(companionId) {
  const dataDir = process.env.XIYU_DATA_DIR || path.resolve(process.cwd(), 'data');
  const dir = path.join(dataDir, 'companion_visuals', String(companionId), 'dates');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getUserPortraitDir(companionId) {
  const dataDir = process.env.XIYU_DATA_DIR || path.resolve(process.cwd(), 'data');
  const dir = path.join(dataDir, 'companion_visuals', String(companionId), 'user_reference');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 保存/读取「我的形象照」（用于双人同框约会合影锁脸）。
 */
export function saveUserPortraitReference(companionId, buffer, mime = 'image/jpeg') {
  if (!companionId || !buffer || !Buffer.isBuffer(buffer) || buffer.length < 64) return null;
  const dir = getUserPortraitDir(companionId);
  // 清理旧图，保持唯一最新形象照
  for (const f of fs.readdirSync(dir)) {
    if (/^self\.(?:jpg|jpeg|png|webp)$/i.test(f)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  }
  const ext = /png/i.test(mime) ? '.png' : /webp/i.test(mime) ? '.webp' : '.jpg';
  const fullPath = path.join(dir, `self${ext}`);
  fs.writeFileSync(fullPath, buffer);
  return { fullPath, fileName: `self${ext}` };
}

export function getUserPortraitReference(companionId) {
  if (!companionId) return null;
  const dataDir = process.env.XIYU_DATA_DIR || path.resolve(process.cwd(), 'data');
  const dir = path.join(dataDir, 'companion_visuals', String(companionId), 'user_reference');
  if (!fs.existsSync(dir)) return null;
  for (const name of ['self.jpg', 'self.png', 'self.webp', 'self.jpeg']) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return { fullPath: full, fileName: name };
  }
  return null;
}

export function clearUserPortraitReference(companionId) {
  const cur = getUserPortraitReference(companionId);
  if (!cur) return false;
  try { fs.unlinkSync(cur.fullPath); return true; } catch { return false; }
}

export function saveDateSceneImage(companionId, buffer, mime = 'image/jpeg', prefix = 'scene') {
  if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) return null;
  const dir = getDateImagesDir(companionId);
  const ext = /png/i.test(mime) ? '.png' : /webp/i.test(mime) ? '.webp' : '.jpg';
  const name = `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}${ext}`;
  const fullPath = path.join(dir, name);
  fs.writeFileSync(fullPath, buffer);
  return {
    fileName: name,
    fullPath,
    relativePath: path.join('companion_visuals', String(companionId), 'dates', name),
  };
}

export function resolveDateImagePath(companionId, fileNameOrRelPath) {
  if (!fileNameOrRelPath) return null;
  const base = path.basename(String(fileNameOrRelPath));
  if (!base || base !== String(fileNameOrRelPath).split(/[\\/]/).pop()) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(base)) return null;
  const fullPath = path.join(getDateImagesDir(companionId), base);
  return fs.existsSync(fullPath) ? fullPath : null;
}

function updateCompanionSceneQuietly(companionId, sceneText, now = new Date()) {
  try {
    getDb().prepare(`
      UPDATE companions
      SET current_scene = ?, scene_recorded_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(String(sceneText || '日常').slice(0, 80), now.toISOString(), companionId);
  } catch (e) {
    log('warn', `[DateMode] update scene failed companion=${companionId}: ${e.message}`);
  }
}

/**
 * 读取当前有效约会会话；若超过 8 小时未活动则自动归档为 abandoned，避免长期卡死状态。
 */
export function getFreshActiveDateSession(companionId, { now = new Date() } = {}) {
  const active = getActiveDateSession(companionId);
  if (!active) return null;
  const updatedMs = Date.parse(active.updated_at || active.started_at || '');
  if (Number.isFinite(updatedMs) && (now.getTime() - updatedMs) > DATE_SESSION_MAX_AGE_MS) {
    settleDateSessionRow(companionId, active.id, {
      status: 'abandoned',
      notes: active.notes || '超过 8 小时未继续，已自动收尾',
      nowIso: now.toISOString(),
    });
    updateCompanionSceneQuietly(companionId, '日常', now);
    return null;
  }
  return active;
}

/**
 * Layer 3：开启约会剧场（自动关联数字衣橱当前穿搭快照 + 锁定 current_scene）。
 */
export function startDateSession(companionId, {
  activityType = 'custom',
  title = '',
  scene = '',
  now = new Date(),
} = {}) {
  const safeType = DATE_PRESETS[activityType] ? activityType : 'custom';
  const preset = DATE_PRESETS[safeType];
  const finalTitle = String(title || '').trim().slice(0, 60) || preset.title;
  const finalScene = String(scene || '').trim().slice(0, 60) || preset.scene;

  // 自动联动数字衣橱：优先取当前 wearing 单品，否则挑最新收到的 1 件已到货礼物作为今日搭配参考
  let outfitSnapshot = [];
  try {
    const wearing = listWardrobeItems(companionId, { status: 'wearing', limit: 6 }) || [];
    if (wearing.length > 0) {
      outfitSnapshot = wearing.map(it => ({
        id: it.id,
        slot: it.slot,
        name: it.name,
        color: it.color || '',
        visual_prompt: it.visual_prompt || '',
        source_image_path: it.source_image_path || null,
        gifted_by: it.gifted_by || 'user',
      }));
    } else {
      const owned = listWardrobeItems(companionId, { status: 'owned', limit: 4 }) || [];
      const gifted = owned.find(it => it.gifted_by === 'user') || owned[0];
      if (gifted) {
        outfitSnapshot = [{
          id: gifted.id,
          slot: gifted.slot,
          name: gifted.name,
          color: gifted.color || '',
          visual_prompt: gifted.visual_prompt || '',
          source_image_path: gifted.source_image_path || null,
          gifted_by: gifted.gifted_by || 'user',
        }];
      }
    }
  } catch { /* fail-open */ }

  const session = createDateSession(companionId, {
    title: finalTitle,
    activity_type: safeType,
    scene: finalScene,
    outfit_snapshot: outfitSnapshot,
    started_at: now.toISOString(),
  });

  updateCompanionSceneQuietly(companionId, finalScene, now);
  return session;
}

/**
 * 生成约会剧场 Prompt 块（供 companion.mjs / reply_prompt.mjs 注入）。
 */
export function buildDateSessionPromptBlock(session) {
  if (!session || session.status !== 'active') return '';
  const outfitNames = Array.isArray(session.outfit_snapshot)
    ? session.outfit_snapshot.map(it => [it.color, it.name].filter(Boolean).join('')).filter(Boolean)
    : [];
  const photoCount = Array.isArray(session.photo_paths) ? session.photo_paths.length : 0;
  const lines = [
    `【当前正在约会剧场：${session.title}】`,
    `此刻场景：${session.scene}。`,
    outfitNames.length
      ? `今日赴约穿搭：${outfitNames.join('、')}（自然记得并可偶尔呼应这身穿搭或他送的礼物）。`
      : '今日赴约穿搭：按你平时偏爱的风格轻松赴约。',
    photoCount > 0
      ? `本场约会已拍合影：你们已经一起拍好并看过了 ${photoCount} 张合影/打卡照（你已经看到照片了，不要说“我还没看”或催他补发刚才拍的照片）。`
      : '',
    '剧场规则：顺着两人此刻在一起的画面自然互动（挑款、点菜、并肩逛街、分享小细节），不要突然跳回独自日程或推翻此刻正在一起的设定；若对方表示到家或结束约会，温柔收尾。',
  ].filter(Boolean);
  return lines.join('\n');
}

function matchesDateLoop(loopTitle = '', session) {
  const title = String(loopTitle || '');
  if (!title) return false;
  const preset = DATE_PRESETS[session?.activity_type] || DATE_PRESETS.custom;
  const keywords = new Set([
    ...(preset.loopKeywords || []),
    '约会', '一起逛', '一起吃', '陪我逛', '陪你逛', '见面',
  ]);
  for (const kw of keywords) {
    if (kw && title.includes(kw)) return true;
  }
  return false;
}

/**
 * Layer 3：结束约会剧场并自动结算：
 * 1. 核销匹配的 companion_open_loops -> resolved
 * 2. 写入高权重共同记忆（companion_memories, importance=8）并尽力生成向量索引
 * 3. 重置 companions.current_scene = '日常'
 */
export async function settleDateSession(companionId, {
  sessionId = null,
  userNote = '',
  now = new Date(),
  skipEmbedding = false,
} = {}) {
  const session = sessionId
    ? getDateSessionById(companionId, sessionId)
    : getActiveDateSession(companionId);
  if (!session || session.status !== 'active') {
    return { settled: false, session: null, resolvedLoops: [], memoryId: null, summary: '' };
  }

  const companion = getCompanionById(companionId);
  const dateKey = shanghaiDateKey(now);
  const resolvedLoops = [];

  // 1. 核销关联 open_loops
  try {
    const openLoops = listOpenLoops(companionId, { status: 'open', limit: 30 }) || [];
    for (const loop of openLoops) {
      if (matchesDateLoop(loop.title, session)) {
        resolveOpenLoop(loop.id, `${dateKey} 已一起完成「${session.title}」`);
        resolvedLoops.push(loop.title);
      }
    }
  } catch (e) {
    log('warn', `[DateMode] resolve loops failed companion=${companionId}: ${e.message}`);
  }

  // 2. 组装结算摘要 & 写入长期共同记忆
  const outfitNames = (session.outfit_snapshot || [])
    .map(it => [it.color, it.name].filter(Boolean).join(''))
    .filter(Boolean);
  const parts = [`${dateKey} 和他一起完成了约会「${session.title}」（${session.scene}）`];
  if (outfitNames.length) parts.push(`那天穿戴了${outfitNames.join('、')}`);
  if (session.photo_paths?.length) parts.push(`拍了 ${session.photo_paths.length} 张合照/打卡照`);
  const cleanNote = String(userNote || '').trim().slice(0, 80);
  if (cleanNote) parts.push(`收尾感受：${cleanNote}`);
  const summary = parts.join('，').slice(0, 180) + '。';

  let memoryId = null;
  if (companion?.user_id) {
    try {
      memoryId = saveMemory({
        companionId,
        userId: companion.user_id,
        memoryType: 'event',
        content: summary,
        importance: 8,
        keywords: [session.title, session.activity_type, '约会', ...outfitNames].slice(0, 6),
        memoryLayer: 'event',
        memorySource: 'date_session',
        memoryOrigin: 'conversation',
      });
      if (memoryId && !skipEmbedding) {
        const stored = getRecallableMemories(companionId, companion.user_id).find(r => r.id === memoryId);
        if (stored) {
          const emb = await embedTextWithDescriptor(stored.content).catch(() => null);
          if (emb) {
            writeMemoryEmbedding(memoryId, companionId, companion.user_id, emb, {
              expectedContent: stored.content,
            });
          }
        }
      }
    } catch (e) {
      log('warn', `[DateMode] save date memory failed companion=${companionId}: ${e.message}`);
    }
  }

  // 3. 更新会话状态并温和还原 current_scene
  const updated = settleDateSessionRow(companionId, session.id, {
    status: 'settled',
    notes: summary,
    resolvedLoops,
    nowIso: now.toISOString(),
  });
  updateCompanionSceneQuietly(companionId, '日常', now);

  return {
    settled: true,
    session: updated,
    resolvedLoops,
    memoryId,
    summary,
  };
}

function mimeFromFilePath(filePath = '') {
  if (/\.png$/i.test(filePath)) return 'image/png';
  if (/\.webp$/i.test(filePath)) return 'image/webp';
  return 'image/jpeg';
}

async function decodeImageUrlToBuffer(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const dm = rawUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (dm) {
    return { buffer: Buffer.from(dm[2], 'base64'), mime: dm[1].toLowerCase() };
  }
  const resp = await fetch(rawUrl);
  if (!resp.ok) throw new Error(`download generated photo HTTP ${resp.status}`);
  const mime = (resp.headers.get('content-type') || 'image/png').split(';')[0].trim().toLowerCase();
  return { buffer: Buffer.from(await resp.arrayBuffer()), mime };
}

const DATE_EXPRESSION_POOL = [
  'genuine bright laughing smile with happily crinkled eyes, candid lively date atmosphere',
  'sweet playful slight head tilt with a warm dimpled smile and relaxed hand gesture (like a casual peace sign or holding a drink)',
  'soft affectionate gaze toward the camera with a natural shy rosy smile, warm golden candid vibe',
  'cheerful relaxed candid smile caught mid-conversation, breezy authentic everyday energy',
];

/**
 * 构造高保真约会打卡照 / 双人同框赛博合影 Prompt：
 * - Image 1 严格锁死伴侣本人五官、发型与身材（完整未裁切原图，兼容三视图设定图）
 * - 若已上传本人形象照，Image 2 严格锁死对方本人五官与体态，生成真实双人同框合影
 * - 若上传现实环境照，明确绑定背景图编号，把两人（或她）自然融入真实场景光线与透视中
 * - 表情与日常淡妆自然灵动，不僵硬复刻参考图固定表情
 */
export function buildDatePhotoPrompt({
  mode = 'date_scene',
  hasCompanionRef = false,
  hasUserRef = false,
  sceneRefIndex = null,
  outfitRefIndex = null,
  fallbackCharPrompt = '',
  outfitPrompt = '',
  presetScenePrompt = '',
  userText = '',
} = {}) {
  const expressionCue = DATE_EXPRESSION_POOL[Math.floor(Math.random() * DATE_EXPRESSION_POOL.length)];
  const parts = [];
  if (hasCompanionRef) {
    parts.push(
      'WOMAN IDENTITY LOCK (HIGHEST PRIORITY): Image 1 shows the EXACT young woman to photograph (if Image 1 is a multi-view reference sheet, ignore the sheet layout and text labels and extract ONLY the real young woman). Strictly preserve 100% of her face shape, eyes, eyelids, eyebrows, nose, lips, skin tone, hair color, wispy bangs, hairstyle, and natural proportions from Image 1. Never alter her face into a generic model, yet allow her facial expression, gaze, and light date makeup to look naturally lively and varied rather than copying Image 1\'s neutral stare.',
    );
  } else if (fallbackCharPrompt) {
    parts.push(`SUBJECT: ${fallbackCharPrompt}.`);
  }

  parts.push(`EXPRESSION & DATE MAKEUP: ${expressionCue}; fresh light everyday date makeup with natural glow and soft rosy tint.`);

  if (hasUserRef) {
    parts.push(
      'PARTNER IDENTITY LOCK (HIGHEST PRIORITY): Image 2 shows the EXACT partner/boyfriend who is on the date with her. Strictly preserve 100% of his facial features, face shape, eyes, hair, glasses (if any), skin tone, and build from Image 2. Both the woman from Image 1 AND the man from Image 2 MUST appear clearly together in the same frame as a natural happy couple.',
    );
  }

  if (sceneRefIndex) {
    parts.push(
      hasUserRef
        ? `BACKGROUND SCENE BINDING: Image ${sceneRefIndex} is the exact real-world location/background. Place BOTH the woman from Image 1 AND the man from Image 2 naturally standing or sitting closely side-by-side in the real-world scene from Image ${sceneRefIndex} (smiling warmly toward the camera like a real couple travel/date photo), strictly matching Image ${sceneRefIndex}'s ambient lighting, sky/interior colors, perspective, and depth of field.`
        : `BACKGROUND SCENE BINDING: Image ${sceneRefIndex} is the exact real-world location/background. Place the woman from Image 1 naturally into the scene from Image ${sceneRefIndex} (seated across the table or standing naturally at the spot), strictly matching Image ${sceneRefIndex}'s ambient lighting, color temperature, perspective, and depth of field.`,
    );
  } else {
    parts.push(
      hasUserRef
        ? `COUPLE DATE SCENE: Candid warm couple selfie / date snapshot of the woman from Image 1 and the man from Image 2 happily together at: ${presetScenePrompt}. Natural close couple framing, genuine relaxed smiles.`
        : `DATE SCENE: Candid warm boyfriend-POV smartphone date photo of the woman from Image 1 at: ${presetScenePrompt}. Natural genuine smile looking toward the camera.`,
    );
  }

  if (outfitRefIndex) {
    parts.push(
      `OUTFIT BINDING: Image ${outfitRefIndex} is the exact garment/outfit the woman from Image 1 is wearing today${outfitPrompt ? ` (${outfitPrompt})` : ''}. Dress her in the exact outfit from Image ${outfitRefIndex} (ignore any model or background in Image ${outfitRefIndex}).`,
    );
  } else if (outfitPrompt) {
    parts.push(`WOMAN'S OUTFIT: She is wearing ${outfitPrompt}.`);
  }

  if (userText) {
    parts.push(`MOMENT NOTE: ${String(userText).slice(0, 120)}.`);
  }

  parts.push(
    'PHOTO REALISM: Authentic unfiltered smartphone photograph, realistic natural lighting and shadows, genuine skin texture, zero plastic AI smoothness.',
    ANTI_COLLAGE_PROMPT,
  );
  return parts.filter(Boolean).join('\n');
}

/**
 * 生成约会打卡照或双人赛博合影（高保真完整原图锁脸 + 支持双人同框 + 多参考图编辑）。
 */
export async function generateDatePhoto(companion, session = null, {
  mode = 'date_scene', // 'date_scene' | 'cyber_group' | 'couple_date'
  sceneImageBuffer = null,
  sceneMime = 'image/jpeg',
  includeUser = true,
  userText = '',
} = {}, deps = {}) {
  if (!companion?.id) return { ok: false, error: 'companion_missing' };

  const gen = deps.generateImage || generateImage;
  let visual = null;
  try {
    visual = await ensureVisualIdentity({
      companion,
      context: { scene: session?.title || 'date', source: 'date_mode', trigger: mode },
    });
  } catch (e) {
    log('warn', `[DateMode] visual identity unavailable companion=${companion.id}: ${e.message}`);
  }

  const refDataUrls = [];
  let hasCompanionRef = false;
  if (visual?.referenceImagePath && fs.existsSync(visual.referenceImagePath)) {
    try {
      // 传完整未裁切人物定妆照（杜绝三视图/全身图被裁成侧脸导致不像！）
      const rawFace = fs.readFileSync(visual.referenceImagePath);
      refDataUrls.push(`data:${mimeFromFilePath(visual.referenceImagePath)};base64,${rawFace.toString('base64')}`);
      hasCompanionRef = true;
    } catch (e) {
      log('warn', `[DateMode] read companion ref failed: ${e.message}`);
    }
  }

  // 若开启双人合影且已上传「我的形象照」，把本人作为 Image 2 传入锁脸
  let hasUserRef = false;
  if (includeUser) {
    const userRef = getUserPortraitReference(companion.id);
    if (userRef?.fullPath && fs.existsSync(userRef.fullPath)) {
      try {
        const rawUser = fs.readFileSync(userRef.fullPath);
        refDataUrls.push(`data:${mimeFromFilePath(userRef.fullPath)};base64,${rawUser.toString('base64')}`);
        hasUserRef = true;
      } catch (e) {
        log('warn', `[DateMode] read user ref failed: ${e.message}`);
      }
    }
  }

  let sceneRefIndex = null;
  if (sceneImageBuffer && Buffer.isBuffer(sceneImageBuffer) && sceneImageBuffer.length) {
    saveDateSceneImage(companion.id, sceneImageBuffer, sceneMime, 'env');
    refDataUrls.push(`data:${sceneMime};base64,${sceneImageBuffer.toString('base64')}`);
    sceneRefIndex = refDataUrls.length;
  }

  // 读取当前穿搭描述与参考图（若总参考图 < 4 张，同步把她今天穿的主打衣橱单品原图带进去！）
  let wearingItems = [];
  try {
    wearingItems = listWardrobeItems(companion.id, { status: 'wearing', limit: 4 }) || [];
  } catch { /* fail-open */ }
  const outfitPrompt = wearingItems.length
    ? wearingItems.map(it => it.visual_prompt || `${it.color} ${it.name}`).filter(Boolean).join(', ')
    : (session?.outfit_snapshot || []).map(it => it.visual_prompt || it.name).filter(Boolean).join(', ');

  let outfitRefIndex = null;
  if (refDataUrls.length < 4 && wearingItems.length) {
    // 优先选带商品原图的 outerwear / top / bottom_or_dress
    const sortedW = [...wearingItems].sort((a, b) => {
      const rank = s => (s === 'outerwear' ? 0 : s === 'top' ? 1 : s === 'bottom_or_dress' ? 2 : 3);
      return rank(a.slot) - rank(b.slot);
    });
    const itemRef = sortedW.map(it => resolveWardrobeImagePath(companion.id, it.source_image_path)).find(Boolean);
    if (itemRef && fs.existsSync(itemRef)) {
      try {
        const buf = fs.readFileSync(itemRef);
        refDataUrls.push(`data:${mimeFromFilePath(itemRef)};base64,${buf.toString('base64')}`);
        outfitRefIndex = refDataUrls.length;
      } catch { /* ignore */ }
    }
  }

  const preset = DATE_PRESETS[session?.activity_type] || DATE_PRESETS.custom;
  const prompt = buildDatePhotoPrompt({
    mode,
    hasCompanionRef,
    hasUserRef,
    sceneRefIndex,
    outfitRefIndex,
    fallbackCharPrompt: hasCompanionRef ? '' : (buildIdentityPrompt(visual?.identity) || `a ${companion.age || 20}-year-old East Asian young woman`),
    outfitPrompt,
    presetScenePrompt: preset.scenePrompt,
    userText,
  });

  const referenceImage = refDataUrls.length > 1 ? refDataUrls : (refDataUrls[0] || null);
  const rawUrl = await gen(prompt, {
    size: sceneRefIndex ? '1024x1024' : '1024x1536',
    referenceImage,
    inputFidelity: 'high',
  });
  const decoded = await decodeImageUrlToBuffer(rawUrl);
  if (!decoded?.buffer?.length) {
    return { ok: false, error: 'image_generation_failed' };
  }

  const saved = saveDateSceneImage(
    companion.id,
    decoded.buffer,
    decoded.mime || 'image/png',
    hasUserRef ? 'couple' : (mode === 'cyber_group' ? 'cyber' : 'date'),
  );
  if (session?.id && saved?.fileName) {
    appendDateSessionPhoto(companion.id, session.id, saved.fileName);
  }
  // 写入一条对话留痕，让她在下一轮聊天里明确知道合影已经拍好并一起看过了（不再追问“照片发我看看”）
  try {
    const turnNote = hasUserRef
      ? `[已一起拍好并看过了本次约会双人合影${session?.title ? `：${session.title}` : ''}]`
      : `[已拍好并看过了本次约会打卡照${session?.title ? `：${session.title}` : ''}]`;
    saveConversationTurn(companion.id, 'assistant', turnNote, companion.chat_mode_active || '日常聊天');
  } catch { /* non-blocking */ }

  log('info', `[DateMode] photo generated companion=${companion.id} mode=${mode} refs=${refDataUrls.length} companionRef=${hasCompanionRef} userRef=${hasUserRef} sceneRef=${!!sceneRefIndex}`);
  return {
    ok: true,
    buffer: decoded.buffer,
    mime: decoded.mime || 'image/png',
    fileName: saved?.fileName || null,
    filePath: saved?.fullPath || null,
    imageUrl: saved?.fileName ? `/api/companions/${companion.id}/date-mode/image/${encodeURIComponent(saved.fileName)}` : null,
    usedMultiRef: refDataUrls.length > 0,
    hasCompanionRef,
    hasUserRef,
  };
}

/**
 * 微信 / 网页单轮入站统一钩子（fail-open，绝不阻断正常对话）：
 * - 维护约会剧场的自然开启、活跃刷新、自然结算；
 * - 识别日常随手拍图的云约会上下文（云饭搭子 / 云逛街 / 赛博合影）；
 * - 若微信触发赛博合影，返回 triggerCyberPhoto 供调用方异步生图发图。
 */
export async function handleInboundDateTurn({
  companion,
  userText = '',
  inboundImages = [],
  wardrobeHandled = false,
  now = new Date(),
} = {}) {
  if (!companion?.id) return null;
  let activeSession = getFreshActiveDateSession(companion.id, { now });
  const signal = detectDateModeSignal(userText, { hasActiveSession: !!activeSession });

  let contextNote = '';
  let settledResult = null;
  let triggerCyberPhoto = null;
  let triggerDatePhoto = null;
  let savedUserPortrait = false;

  if (signal?.action === 'start') {
    activeSession = startDateSession(companion.id, {
      activityType: signal.activityType,
      title: signal.title,
      scene: signal.scene,
      now,
    });
    contextNote = `【系统状态变更：已进入约会剧场「${activeSession.title}」】此刻你们已经见到面并开始约会，顺着现场氛围开心接话。`;
  } else if (signal?.action === 'end' && activeSession) {
    settledResult = await settleDateSession(companion.id, {
      sessionId: activeSession.id,
      userNote: signal.note,
      now,
    });
    activeSession = null;
    const loopTip = settledResult.resolvedLoops?.length
      ? `（同时你们之前约定的「${settledResult.resolvedLoops.slice(0, 2).join('、')}」已经圆满完成）`
      : '';
    contextNote = `【系统状态变更：本次约会剧场已圆满结束并存入共同记忆】${loopTip}自然温柔地收尾，回味一下今天一起玩的小细节。`;
  } else if (activeSession) {
    // 约会进行中：每轮刷新时间戳与场景记录，防止 2h 场景过期或 8h 会话超时
    touchDateSession(companion.id, activeSession.id, { nowIso: now.toISOString() });
    updateCompanionSceneQuietly(companion.id, activeSession.scene, now);
  }

  // Layer 2：若本轮带图片且未被数字衣橱抢占（非送礼/试穿商品图）
  const hasImage = Array.isArray(inboundImages) && inboundImages.length > 0;
  if (!wardrobeHandled && hasImage && /(?:这是我的照片|我的形象照|锁定我的照片|保存我的照片|合影用我这张|记住我的样子|本人照片)/.test(userText)) {
    const lastImg = inboundImages[inboundImages.length - 1];
    const saved = saveUserPortraitReference(companion.id, lastImg.buffer, lastImg.mime || 'image/jpeg');
    if (saved) {
      savedUserPortrait = true;
      contextNote = [
        contextNote,
        '【系统状态变更：已记下他的本人形象照】以后约会合影或赛博同框时，可以把你们两个人画在同一画面里；开心夸一句他的照片并记在心里。',
      ].filter(Boolean).join('\n');
    }
  } else if (!wardrobeHandled && (hasImage || /\[他发了一张图片/.test(userText))) {
    const cloud = detectCloudDatePhotoContext(userText, userText);
    if (cloud) {
      contextNote = [contextNote, cloud.promptHint].filter(Boolean).join('\n');
      if (cloud.kind === 'cyber_group_photo' && hasImage) {
        const lastImg = inboundImages[inboundImages.length - 1];
        triggerCyberPhoto = {
          sceneImageBuffer: lastImg.buffer,
          sceneMime: lastImg.mime || 'image/jpeg',
          userText,
        };
      }
    }
  } else if (activeSession && !hasImage && /(?:(?:拍|来)(?:个|张|一张)?(?:约会)?(?:合影|合照|打卡照|照(?:片)?留念)|咱俩(?:合个影|合影|拍一张|拍张照)|一起(?:合个影|拍张照|拍合影|合照|留个影)|合个影吧?|合影吧)/.test(userText)) {
    triggerDatePhoto = { mode: 'date_scene', userText };
    contextNote = [
      contextNote,
      '【约会剧场 · 拍合影】他想在当前约会场景和你拍一张合影/打卡照；开心接话，照片由程序异步生成发送，不要口头虚构已经拍好。',
    ].filter(Boolean).join('\n');
  }

  return {
    activeSession,
    settledResult,
    contextNote,
    triggerCyberPhoto,
    triggerDatePhoto,
    savedUserPortrait,
  };
}

/**
 * 任务 1 × 任务 2 联动彩蛋：周末日程数字衣橱穿戴回访提示（供 plan_tasks.mjs generateScheduleFor 注入）。
 */
export function buildWeekendWardrobeBoomerangHint(companionId, { isWeekend = false } = {}) {
  if (!isWeekend || !companionId) return '';
  try {
    const items = listWardrobeItems(companionId, { limit: 20 }) || [];
    const gifted = items.filter(it => it.gifted_by === 'user' && (it.status === 'owned' || it.status === 'wearing'));
    if (!gifted.length) return '';
    // 优先选穿戴次数较少或最新收到的单品，增加自然惊喜感
    const picked = [...gifted].sort((a, b) => (a.wear_count || 0) - (b.wear_count || 0) || (b.id - a.id))[0];
    const label = [picked.color, picked.name].filter(Boolean).join('');
    return `\n【周末衣橱回访彩蛋（可选轻提）】今天是周末，如果安排出门逛逛或喝咖啡，可以自然提到打算穿/背他送的「${label}」，增加生活延续感。`;
  } catch {
    return '';
  }
}

export function getDateModeOverview(companionId) {
  const companion = getCompanionById(companionId);
  if (!companion) return null;
  const activeSession = getFreshActiveDateSession(companionId);
  const recentSessions = listDateSessions(companionId, { limit: 8 });
  const userPortrait = getUserPortraitReference(companionId);
  return {
    presence_mode: normalizePresenceMode(companion.presence_mode),
    activeSession,
    recentSessions,
    hasUserPortrait: !!userPortrait,
    userPortraitUrl: userPortrait ? `/api/companions/${companionId}/user-visual-reference/image?t=${Date.now()}` : null,
    presets: Object.values(DATE_PRESETS).map(({ activityType, title, scene }) => ({ activityType, title, scene })),
  };
}

export function setCompanionPresenceMode(companionId, mode) {
  const normalized = normalizePresenceMode(mode);
  updateCompanion(companionId, { presence_mode: normalized });
  return normalized;
}
