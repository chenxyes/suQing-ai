/**
 * memory.mjs
 * 长期记忆 / 情绪状态 / 好感度 / 用户画像 自动处理
 *
 * 所有 extract* 函数调用 DeepSeek，应在回复发送后异步执行（非阻塞）。
 * 所有 update* 规则函数是同步的，可直接调用。
  *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { indexMemory } from './memory_indexing.mjs';
import {
  saveGroundedMemories, getMemoryEvidenceTurns, getRecallableMemories,
  patchCompanion, upsertUserProfile,
  saveStageMilestone, shanghaiDateKey, getDb, getMemoryRecallBarrier,
} from './db.mjs';
import { extractStructuredInfo } from './ai.mjs';
import { tryAchievement } from './achievements.mjs';
import { processMemoryForGraph } from './event_graph.mjs';

// ─── 关系阶段阈值 ─────────────────────────────────────────────────────────────
export function computeRelationshipStage(affection) {
  if (affection >= 80) return '深爱';
  if (affection >= 55) return '恋人';
  if (affection >= 30) return '暧昧';
  if (affection >= 15) return '朋友';
  return '陌生人';
}

// ─── 关系节奏（参考真实关系，偏真实/慢；env 可调）──────────────────────────
// 暧昧→恋人：affection≥LOVER + 已表白 + 认识≥DAYS_TO_LOVER 天
// 恋人→深爱：affection≥DEEP + 当恋人≥DAYS_AS_LOVER_TO_DEEP 天
// 好感每日上限 DAILY_CAP，55 分以上增幅衰减 —— 防一次聊天无脑刷到恋人/深爱。
export const AFFECTION_LOVER = Number(process.env.AFFECTION_LOVER) || 55;
export const AFFECTION_DEEP  = Number(process.env.AFFECTION_DEEP)  || 80;
export const DAYS_TO_LOVER         = Number(process.env.DAYS_TO_LOVER ?? 5);   // v1.16.x: 14→5（重度用户第一周能尝到恋人；仍需"已表白+好感≥55"防秒升）
export const DAYS_AS_LOVER_TO_DEEP = Number(process.env.DAYS_AS_LOVER_TO_DEEP ?? 30);
export const AFFECTION_DAILY_CAP   = Number(process.env.AFFECTION_DAILY_CAP ?? 8);  // 恋人段基准（env 兼容）

// v1.16.x: 好感日上限改为「按当前好感动态」—— 新人期升温快（热恋期效应），越接近恋人/深爱越慢
// （老夫老妻效应）。解决"重度用户聊几十条被固定 cap=8 压到陌生人、头一周没奔头就流失"。
// 仍防一天无脑刷到顶：一天最多 +25，到恋人需 5 天 + 表白 + 好感≥55。
export function affectionDailyCap(curAff = 0) {
  const a = Number(curAff) || 0;
  if (a < 30)              return Number(process.env.AFFECTION_DAILY_CAP_NEW  ?? 25); // 陌生→暧昧前：新人期最快
  if (a < AFFECTION_LOVER) return Number(process.env.AFFECTION_DAILY_CAP_AMBI ?? 15); // 暧昧→恋人前：还能较快
  if (a < AFFECTION_DEEP)  return AFFECTION_DAILY_CAP;                                 // 恋人：原值 8，放缓
  return Number(process.env.AFFECTION_DAILY_CAP_DEEP ?? 5);                            // 深爱：最慢、最珍贵
}

const STAGE_RANK = ['陌生人', '朋友', '暧昧', '恋人', '深爱'];
const stageRank = (s) => Math.max(0, STAGE_RANK.indexOf(s));

function daysFromTs(ts) {
  if (!ts) return 0;
  const d = new Date(String(ts).replace(' ', 'T') + (String(ts).includes('Z') ? '' : 'Z'));
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400_000));
}
export const daysSinceMeet = (c) => daysFromTs(c?.created_at);
export const daysAsLover   = (c) => daysFromTs(c?.became_lover_at);

/**
 * 用户表白时是否该"接住"升恋人：好感够 + 认识够久。
 * 不够 → bot 端走"端着婉拒"，关系不升级（见 bot.mjs）。
 */
export function canAcceptConfession(companion) {
  return (companion?.affection_level ?? 0) >= AFFECTION_LOVER && daysSinceMeet(companion) >= DAYS_TO_LOVER;
}

// ─── 心情关键词 ──────────────────────────────────────────────────────────────
const MOOD_MAP = [
  { mood: '兴奋', words: ['哇', '不会吧', '真的吗', '天啊', '居然', '牛', '超厉害', '！！', '!!', '🎉', '🤩', '😱'] },
  { mood: '开心', words: ['哈哈', '嘻嘻', '好耶', '太好了', '棒', '开心', '高兴', '喜欢', '爱', '可爱', '😊', '😁', '😄', '❤', '🥰'] },
  { mood: '想念', words: ['想你', '好想', '想念', '思念', '好久不见', '许久'] },
  { mood: '委屈', words: ['委屈', '难过', '伤心', '哭', '不开心', '难受', '😢', '😭', '🥺', '呜呜'] },
  { mood: '平静', words: [] }, // 默认
];

/**
 * 规则：根据对话内容推断新心情
 */
export function detectMood(userMsg, botReply) {
  const text = (userMsg + botReply).toLowerCase();
  for (const { mood, words } of MOOD_MAP) {
    if (words.length === 0) continue;
    if (words.some(w => text.includes(w))) return mood;
  }
  return null; // 无变化
}

/**
 * 规则：根据消息计算好感度增量
 */
export function calcAffectionDelta(userMsg) {
  if (!userMsg) return 1;
  let delta = 1; // 基础 +1（维持联系）

  if (userMsg.length > 50)  delta += 1; // 认真在聊
  if (userMsg.length > 150) delta += 1; // 说了很多

  const strong = ['很喜欢', '超喜欢', '爱你', '最爱', '太可爱了', '喜欢你', '爱死你'];
  const positive = ['喜欢', '谢谢', '感谢', '棒', '开心', '可爱', '好'];
  const negative = ['讨厌', '烦死', '滚', '差劲', '垃圾', '无聊', '笨'];

  for (const w of strong)    if (userMsg.includes(w)) { delta += 2; break; }  // v1.x: 3→2 降速
  for (const w of positive)  if (userMsg.includes(w)) { delta += 1; break; }
  for (const w of negative)  if (userMsg.includes(w)) { delta -= 2; break; }

  // v1.x: 单条封顶 +3（防强词+长消息叠加冲太快），负向仍可到 -3
  return Math.max(Math.min(delta, 3), -3);
}

/**
 * 同步更新好感度 + 心情 + 关系阶段
 * 关系阶段升级时记录里程碑（用于"我们的故事"展示 + CP 卡片）
 */
export function syncUpdateCompanionState(companion, userMsg, botReply) {
  const fields = {};

  // ── 好感度增量：基础规则 → 55+ 衰减 → 每日上限（防一次聊天无脑刷）──
  const curAff = companion.affection_level ?? 0;
  let delta = calcAffectionDelta(userMsg);
  if (delta > 0 && curAff >= AFFECTION_LOVER) delta = Math.max(1, Math.round(delta * 0.5)); // 恋人后增幅减半，深爱更慢
  const today = shanghaiDateKey();
  const gainedToday = (companion.affection_day === today) ? (companion.affection_today || 0) : 0; // 跨天自动重置
  const dailyCap = affectionDailyCap(curAff);                                                     // v1.16.x 动态上限：新人期快、亲密后慢
  if (delta > 0) delta = Math.min(delta, Math.max(0, dailyCap - gainedToday));                    // 每日上限只限正向
  fields.affection_day   = today;
  fields.affection_today = gainedToday + Math.max(0, delta);

  const newAff = Math.min(Math.max(curAff + delta, 0), 100);
  fields.affection_level = newAff;

  // ── 关系阶段：真实节奏闸门（表白 + 时间），只拦升级、不动存量 ──
  // 暧昧→恋人：affection≥55 + 已表白 + 认识≥14天；恋人→深爱：affection≥80 + 当恋人≥30天
  const oldStage = companion.relationship_stage || '陌生人';
  const rawStage = computeRelationshipStage(newAff);
  const hasConfession = Boolean(companion.confessed_at || companion.user_confessed_at);
  let newStage = rawStage;
  if (stageRank(rawStage) > stageRank(oldStage)) {            // 仅"想升级"时套闸门
    if (rawStage === '恋人' && !(hasConfession && daysSinceMeet(companion) >= DAYS_TO_LOVER)) {
      newStage = oldStage;                                   // 没表白 / 认识太短 → 卡住
    } else if (rawStage === '深爱' && !(daysAsLover(companion) >= DAYS_AS_LOVER_TO_DEEP)) {
      newStage = oldStage;                                   // 当恋人时间不够 → 卡住
    }
  }
  // 非升级（含掉好感的自然降级）按 rawStage，不因新闸门强制降级老用户（存量不动）
  // v1.20 安全收尾：安全模式下关系阶段钳到「朋友」封顶（DB 层硬钳，不只 prompt 层）
  if (Number(companion.safe_mode) && stageRank(newStage) > stageRank('朋友')) {
    newStage = '朋友';
  }
  fields.relationship_stage = newStage;
  if (newStage === '恋人' && oldStage !== '恋人' && !companion.became_lover_at) {
    fields.became_lover_at = new Date().toISOString();       // 升恋人时间戳 → 深爱时间门槛计时
  }

  // 心情（有变化才更新）
  const newMood = detectMood(userMsg, botReply);
  if (newMood && newMood !== companion.current_mood) {
    fields.current_mood    = newMood;
    fields.mood_updated_at = new Date().toISOString();
  }

  patchCompanion(companion.id, fields);

  // 阶段升级 → 记里程碑
  if (newStage !== oldStage) {
    try {
      // 算"认识"天数：用 companion.created_at 距今
      let daysSinceMeet = 0;
      if (companion.created_at) {
        const created = new Date(String(companion.created_at).replace(' ', 'T') + (String(companion.created_at).includes('Z') ? '' : 'Z'));
        daysSinceMeet = Math.max(0, Math.floor((Date.now() - created.getTime()) / 86400_000));
      }
      saveStageMilestone({
        companionId: companion.id,
        fromStage: oldStage,
        toStage: newStage,
        affection: newAff,
        daysSinceMeet,
      });
      // 通知 bot 下条 reply 时带个庆祝
      pendingCelebration.set(companion.id, { from: oldStage, to: newStage, ts: Date.now() });
    } catch (e) { /* 不阻断主流程 */ }
  }
  return fields;
}

// ─── 表白意图检测 ─────────────────────────────────────────────────────────
const CONFESSION_PATTERNS = [
  // 直接告白（中文）
  /我(?:好|超|很|真的)?(?:喜欢|爱|心动|动心|想)(?:你|妳)/,
  /(?:做|当|是)我(?:的)?(?:女朋友|男朋友|对象|女友|男友|老婆|老公)/,
  /(?:和|跟)我在一起/,
  /我们(?:在一起|交往|谈恋爱)(?:吧|好不好|可以吗|怎么样)?/,
  // 暗示性表白
  /(?:我对你|对你)有(?:感觉|意思|好感)/,
  /(?:我)?喜欢上(?:你|妳)了?/,
  /(?:我)?爱上(?:你|妳)了?/,
  /我心(?:动|跳|里只有你)/,                              // 我心动了/我心跳了/我心里只有你
  /我离不开你/,
  /(?:可不可以|可以)做我(?:女朋友|对象|女友|男朋友|男友)/,
  /我爱你/, /愛你/,
  // 英文（不去空格保留单词边界）
  /\b(?:i\s*love\s*(?:you|u))\b/i,
];

/**
 * 检测用户消息是否是"表白"。返回 boolean。
 */
export function detectUserConfession(userMsg) {
  if (!userMsg || typeof userMsg !== 'string' || userMsg.length < 2) return false;
  const original = userMsg;
  const compact = userMsg.replace(/\s+/g, '');
  // 排除"我喜欢你画的画/你的猫/这个歌"这种非告白
  if (/喜欢你(?:发|画|说|做|的|那|这|@|分享)/.test(compact)) return false;
  for (const re of CONFESSION_PATTERNS) {
    if (re.test(compact) || re.test(original)) return true;
  }
  return false;
}

/**
 * v1.10.32: 检测 AI 回复是否含"她在表白"语义。返回 boolean。
 * 跟 detectUserConfession 同模式但排除常见"接住用户告白"的回应（"我也是" / "我等你"
 * 这种不算独立的告白事件 — 那是用户告白触发的）。
 */
export function detectCompanionConfession(botReply) {
  if (!botReply || typeof botReply !== 'string' || botReply.length < 2) return false;
  const original = botReply;
  const compact = botReply.replace(/\s+/g, '');
  // 排除"也"类回应（接住用户告白），不是独立告白事件
  if (/^(?:我)?也(?:喜欢|爱|是)/.test(compact)) return false;
  if (/喜欢你(?:发|画|说|做|的|那|这|@|分享)/.test(compact)) return false;
  for (const re of CONFESSION_PATTERNS) {
    if (re.test(compact) || re.test(original)) return true;
  }
  return false;
}

// ─── 亲密称呼检测（用户使用过早的亲密词）──────────────────────────────────
const INTIMATE_TERMS_RE = /(?:^|[^a-zA-Z])(宝宝|宝贝|宝儿|亲爱的|老婆|老公|baby|honey|sweetie|心肝|小可爱|乖乖)(?:[^a-zA-Z]|$)/i;
const FLIRT_PHRASES_RE = /(?:抱抱|抱一下|亲亲|亲一口|蹭蹭|摸摸头|想睡你|想亲你|想抱你|抱回家|带你回家)/;

/**
 * 检测用户消息中是否含 "过早的亲密词"。
 * 返回 { has, kind } 其中 kind = 'address'(称呼) | 'flirt'(肢体亲密) | null
 */
export function detectIntimacyOvereach(userMsg) {
  if (!userMsg || typeof userMsg !== 'string') return { has: false, kind: null };
  // 排除"我宝宝"作为反问/玩笑——简化先不处理 corner case
  if (INTIMATE_TERMS_RE.test(userMsg)) return { has: true, kind: 'address' };
  if (FLIRT_PHRASES_RE.test(userMsg)) return { has: true, kind: 'flirt' };
  return { has: false, kind: null };
}

// 阶段升级临时挂起的"庆祝"标记。bot.mjs 检查这个 map 决定要不要在 prompt 里加一句
// "你们刚刚升级了关系阶段，可以在这条回复里自然地体现这种变化"
const pendingCelebration = new Map();
export function consumePendingCelebration(companionId) {
  const v = pendingCelebration.get(companionId);
  if (!v) return null;
  // 30 分钟内才有效
  if (Date.now() - v.ts > 30 * 60_000) {
    pendingCelebration.delete(companionId);
    return null;
  }
  pendingCelebration.delete(companionId);
  return v;
}

// ─── 图片描述记忆提取（同步规则，不依赖视觉模型）──────────────────────────────
const PET_PATTERNS = [
  { word: '橘猫', memory: '他养了一只橘猫', pet: '橘猫' },
  { word: '猫', memory: '他家里有猫', pet: '猫' },
  { word: '小猫', memory: '他家里有猫', pet: '小猫' },
  { word: '狗', memory: '他家里有狗', pet: '狗' },
  { word: '小狗', memory: '他家里有狗', pet: '小狗' },
  { word: '宠物', memory: '他家里有宠物', pet: '宠物' },
];

const FOOD_WORDS = ['饭', '面', '火锅', '烧烤', '甜点', '蛋糕', '奶茶', '咖啡', '披萨', '寿司', '食物', '早餐', '午餐', '晚餐'];
const ROOM_WORDS = ['房间', '卧室', '客厅', '书桌', '阳台', '厨房', '家里'];

export function extractImageMemories(imageDescription, userMessage = '') {
  const desc = String(imageDescription || '').trim();
  const msg = String(userMessage || '').trim();
  const text = `${desc} ${msg}`;
  const memories = [];

  const add = (memoryType, content, importance) => {
    if (!content || memories.some(m => m.content === content)) return;
    memories.push({ memory_type: memoryType, content, importance });
  };

  const ownershipHint = /(我家|我的|家里|养了|养的|我养|这是我|我们家)/.test(msg);
  for (const pet of PET_PATTERNS) {
    if (!text.includes(pet.word)) continue;
    add('image', ownershipHint ? pet.memory : `他分享过${pet.pet}的照片`, ownershipHint ? 8 : 5);
    if (/(拍|照片|看看|分享|发你|给你看)/.test(msg)) {
      add('preference', `他喜欢拍${pet.pet}`, 6);
    }
    break;
  }

  const food = FOOD_WORDS.find(w => text.includes(w));
  if (food) {
    if (/(我做|自己做|我煮|我烤|我买|我点|我吃|想吃|爱吃|喜欢)/.test(msg)) {
      add('preference', `他对${food}感兴趣`, 5);
    } else {
      add('image', `他分享过${food}照片`, 4);
    }
  }

  const room = ROOM_WORDS.find(w => text.includes(w));
  if (room) {
    if (/(我家|我的|家里|房间|卧室|客厅)/.test(text)) {
      add('image', `他分享过自己的${room}`, 5);
    }
  }

  if (/(生日|聚会|旅行|约会|毕业|搬家|纪念日)/.test(text)) {
    add('event', `他分享过照片事件：${desc.slice(0, 30)}`, 6);
  }

  return memories.slice(0, 5);
}

export function buildImageReactionText(memories, imageDescription) {
  const first = memories[0];
  if (first?.content.includes('橘猫')) return '它看起来好乖呀，我记住啦，你家有一只橘猫。';
  if (first?.content.includes('猫')) return '这只猫看起来好可爱呀，我记住啦，你家里有猫。';
  if (first?.content.includes('狗')) return '它看起来很亲人呢，我记住啦，你家里有狗。';
  if (first?.content.includes('食') || first?.content.includes('饭') || first?.content.includes('奶茶')) {
    return '看起来很好吃呀，我记住啦，你也会把这些好吃的分享给我。';
  }
  if (first?.content.includes('房间') || first?.content.includes('客厅') || first?.content.includes('卧室')) {
    return '这个画面很有生活感，我记住啦，这是和你生活空间有关的小细节。';
  }
  return `我看到啦：${String(imageDescription || '').slice(0, 40)}。我会把这次照片里的重要信息记住。`;
}

// ─── 记忆提取（异步，调用 AI）────────────────────────────────────────────────
const MEMORY_SYSTEM_PROMPT = `你是记忆候选提取助手。输入是已落库的真实对话 turns，id 是消息ID，role 是真实说话人；existing_memories 是本次允许更正的已有记录。
不要把 assistant 自述当作 user 的事实。subject=user 只取对方本人的明确第一人称陈述；subject=companion 只取角色自己的明确自述；subject=shared 需要双方明确支持同一共同事实。
引述、转述、假设、问题和简短附和不是个人事实证明；没有完整明确证据就不生成候选。证据 quote 必须逐字引用原消息中的完整、自足陈述，不能从假设或引号内摘半句来断言为真。
只返回 JSON：
{
  "current_scene": "仅本轮明确的当前场景/地点变化；过去事件不算，没有就空字符串",
  "memories": [{
    "subject": "user|companion|shared",
    "memory_type": "fact|preference|event|emotion",
    "content": "简短候选描述，不增加证据未说的事实",
    "evidence": [{"turn_id": 真实消息ID, "quote": "完整原话"}],
    "replaces_memory_ids": [],
    "importance": 1,
    "keywords": []
  }]
}
replaces_memory_ids 只在对方明确纠正已有错误、且确实是同一事实时填写 existing_memories 中的真实ID；普通补充、不同主体或无关事实不得替换。很短的明确纠错也要处理。不能编造消息ID或记忆ID。
importance 1-10：身份/家庭/稳定偏好7-9，日常事实5-6，临时情绪3-4，噪音1-2。无可靠候选返回 memories=[]。不要输出无证据的专属梗、画像或隐私信息。`;

const MEMORY_MIN_IMPORTANCE = 4;
const CORRECTION_CANDIDATE_LIMIT = 20;

export async function extractAndSaveMemories(companionId, userId, _userMsg, _botReply, options = {}) {
  const expectedRecallRevision = getMemoryRecallBarrier(companionId, userId).revision;
  const turns = getMemoryEvidenceTurns(companionId, userId, options.turnIds || []);
  if (!turns.length) return 0;
  const allowedTurnIds = turns.map(turn => turn.id);
  const existing = getRecallableMemories(companionId, userId).slice(0, CORRECTION_CANDIDATE_LIMIT);
  const shownIds = new Set(existing.map(memory => memory.id));
  const input = JSON.stringify({
    turns: turns.map(turn => ({ id: turn.id, role: turn.role, content: turn.content })),
    existing_memories: existing.map(memory => ({ id: memory.id, subject: memory.memory_subject || 'unknown', content: memory.content })),
  });

  try {
    const raw = await extractStructuredInfo(MEMORY_SYSTEM_PROMPT, input);
    if (getMemoryRecallBarrier(companionId, userId).revision !== expectedRecallRevision) return 0;
    const obj = safeParseObject(raw);
    // Scene is a separate mutable state. Preserve its existing update/empty/failure behavior.
    applySceneUpdate(companionId, obj.current_scene);
    const candidates = Array.isArray(obj.memories) ? obj.memories : [];
    const inputs = [];
    for (const candidate of candidates) {
      if (!candidate || !['fact', 'preference', 'event', 'emotion'].includes(candidate.memory_type)) continue;
      const replacesMemoryIds = candidate.replaces_memory_ids ?? [];
      if (!Array.isArray(replacesMemoryIds)
        || replacesMemoryIds.some(id => !Number.isSafeInteger(id) || !shownIds.has(id))) continue;
      const importance = Math.min(Math.max(Number(candidate.importance) || 5, 1), 10);
      if (importance < MEMORY_MIN_IMPORTANCE && !replacesMemoryIds.length) continue;
      inputs.push({
        companionId, userId, expectedRecallRevision, allowedTurnIds,
        memoryType: candidate.memory_type, subject: candidate.subject,
        content: typeof candidate.content === 'string' ? candidate.content : '',
        evidence: candidate.evidence, replacesMemoryIds, importance,
        keywords: Array.isArray(candidate.keywords) ? candidate.keywords.slice(0, 5).map(keyword => String(keyword).slice(0, 12)) : [],
      });
    }
    const saved = saveGroundedMemories(inputs)
      .filter(result => ['inserted', 'corrected'].includes(result.action) && result.memory)
      .map(result => result.memory);
    if (!saved.length) return 0;
    log('info', `[Memory] +${saved.length} grounded 记忆 companion=${companionId}`);
    tryAchievement(companionId, 'first_memory_saved');
    for (const memory of saved) {
      // The existing graph always uses the user as its subject. Keep other subjects in memories only.
      if (memory.memory_subject !== 'user') continue;
      try { processMemoryForGraph(companionId, memory.content, memory.id, memory); } catch { /* 非阻塞 */ }
    }
    // Finish synchronous fact consumers before provider awaits can edit/revoke their inputs.
    for (const memory of saved) await indexMemory(memory.id, companionId, userId);
    return saved.length;
  } catch (error) {
    log('warn', `[Memory] 记忆提取失败: ${error.message}`);
    applySceneUpdate(companionId, null, { extractionFailed: true });
    return 0;
  }
}

/**
 * 更新 companion.current_scene —— #324 失忆修。
 *
 * current_scene 是「**可变当前态**」（patch、覆盖），与 episodic 记忆的"过去事件"措辞严格区分：
 * episodic 记"他提议去图书馆"(发生过的事)，current_scene 记"图书馆"(此刻在哪)。它被 §6 无条件
 * 注入 prompt（companion.mjs「你现在在：X」），所以必须**跨轮持久**——一旦设定就留住到下次场景
 * 切换，否则密聊下真场景滑出 16 行窗口后又回到注入"在家"的老 bug。
 *
 * 语义（拍板）：
 *   · 本轮抽到明确场景        → patch 覆盖（场景切换/确认）
 *   · 本轮无场景信号(空)      → **保留现值**（场景跨轮持久＝修复要害，别被非场景轮清掉）
 *   · 抽取失败(extractionFailed) → **回落「日常」**（fail-open 反转：过期值反客为主是本 bug 根因，
 *                                 旧值比空值危险；宁可退回§6"随意聊"也不留可能过期的旧场景）
 *   · 跨日陈旧 → 由 plan_tasks 次日 00:30 TTL 批清场（不在此处）
 */
export function applySceneUpdate(companionId, scene, { extractionFailed = false } = {}) {
  try {
    if (extractionFailed) {
      patchCompanion(companionId, { current_scene: '日常' });
      return;
    }
    const s = String(scene ?? '').trim().slice(0, 30);
    // 本轮无明确场景信号 → 保留现值（场景跨轮持久）。注意"在家"是真实场景(到家了)不跳过；
    // 仅空串/占位词不更新。prompt 已约束"只在明确场景时才填"，防止把"图书馆"误覆盖成默认。
    if (!s || s === '无' || s === '日常') return;
    patchCompanion(companionId, { current_scene: s });
  } catch (e) {
    log('debug', `[Scene] current_scene 更新跳过 companion=${companionId}: ${e.message}`);
  }
}

/**
 * #324 TTL：次日 00:30 批清场——把所有 companion 的 current_scene 回落"日常"，防"昨天的图书馆"
 * 漏到今天（场景是**当日态**，跨日必清）。纯批量 UPDATE、幂等。约定类(open_loop)靠其自身生命周期
 * （履约关闭 / markStaleOpenLoops），不在此清。
 */
export function resetScenesForNewDay() {
  try {
    const r = getDb().prepare(
      "UPDATE companions SET current_scene = '日常' WHERE current_scene IS NOT NULL AND current_scene NOT IN ('日常','在家')",
    ).run();
    if (r.changes) log('info', `[Scene] 次日清场：${r.changes} 个 companion 的 current_scene 回落"日常"`);
    return r.changes;
  } catch (e) {
    log('warn', `[Scene] 次日清场失败（已忽略）: ${e.message}`);
    return 0;
  }
}

// ─── 用户画像：只从本轮已验证的用户记忆派生，不另做无证据推断 ───────────────
export async function extractAndUpdateUserProfile(companionId, userId, _userMsg, options = {}) {
  try {
    const expectedRecallRevision = getMemoryRecallBarrier(companionId, userId).revision;
    const turns = getMemoryEvidenceTurns(companionId, userId, options.turnIds || []);
    if (!turns.length) return;
    const turnIds = new Set(turns.filter(turn => turn.role === 'user').map(turn => turn.id));
    const sources = getRecallableMemories(companionId, userId).filter(memory => {
      if (memory.memory_subject !== 'user') return false;
      try {
        const evidence = JSON.parse(memory.memory_evidence || '[]');
        return Array.isArray(evidence) && evidence.length > 0
          && evidence.every(item => turnIds.has(item.turn_id));
      } catch { return false; }
    });
    if (!sources.length) return;
    upsertUserProfile(userId, companionId, { notes: sources.map(memory => memory.content).join('\n') }, {
      sourceMemoryIds: sources.map(memory => memory.id), expectedRecallRevision,
    });
  } catch (error) {
    log('warn', `[Memory] 有证据画像更新失败: ${error.message}`);
  }
}

// ─── 召回记忆（同步） ─────────────────────────────────────────────────────────
export { recallMemories } from './db.mjs';

// ─── 工具 ────────────────────────────────────────────────────────────────────
function safeParseObject(text) {
  if (!text) return {};
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try { const v = JSON.parse(m[0]); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
  catch { return {}; }
}
