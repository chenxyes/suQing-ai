/**
 * current_works.mjs — current_works「她手头的事」档案 + 真实性验证双闸（v1.21.4 PR-W1）。
 *
 * 设计 docs/V1214_DESIGN.md §5/§6/§7/§13。背景（2026-06-12 生产实锤）：她声称在看
 * 《她总在转角处等我》——用户实搜无此书，纯 LLM 虚构。本模块把"她在看/在做的事"
 * 从 LLM 即兴收成一张表，作品类入档前过 webSearch 真实性验证，搜不到宁可降级
 * "泛读态"（"最近在看一本推理小说"）也绝不带虚构名入档。
 *
 * 验证双闸（评审拍板：字符串级，不加 LLM 判定）：
 *   闸1 kind 兜底——title 含书名号《》→ 强制按作品类验证（防 LLM 自报 craft 绕过）
 *   闸2 webSearch 字符串判定——某结果 title+snippet 同含作品名与作者才 verified
 * 缓存只缓 verified（作品存在性是单调正事实，永不过期）；负结果不缓存、每次重验。
 * 参数全 env 可调（§13，评审拍板为"观察值"）：48h/周3/生命周期天数都是纯推理值。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { webSearch } from './web_search.mjs';
import { extractStructuredInfo, embedText } from './ai.mjs';
import { findVerifiedWork, getActiveCurrentWorks, insertCurrentWork, setCurrentWorkStatus, setCurrentWorkProgress, getAppSetting, setAppSetting, saveMemory, getRecentWorkTitles } from './db.mjs';
import { log } from './logger.mjs';

const VERIFIABLE = new Set(['book', 'series', 'anime', 'game']);   // craft 免验

/** §13 参数速查：全部 env 可调（评审拍板为"观察值"，上线后按手感调、不写死）。 */
export function worksConfig(env = process.env) {
  const num = (k, d) => { const n = Number(env[k]); return Number.isFinite(n) ? n : d; };
  return {
    maxActive: num('WORKS_MAX_ACTIVE', 2),
    verifyRetries: num('WORKS_VERIFY_RETRIES', 2),
    verifyDailyCap: num('WORKS_VERIFY_DAILY_CAP', 50),
    mentionCooldownH: num('WORK_MENTION_COOLDOWN_HOURS', 48),
    weeklyMentionCap: num('WORK_WEEKLY_MENTION_CAP', 3),
    bookDaysMin: num('WORKS_BOOK_DAYS_MIN', 10), bookDaysMax: num('WORKS_BOOK_DAYS_MAX', 21),
    seriesDaysMin: num('WORKS_SERIES_DAYS_MIN', 7), seriesDaysMax: num('WORKS_SERIES_DAYS_MAX', 14),
    craftDaysMin: num('WORKS_CRAFT_DAYS_MIN', 7), craftDaysMax: num('WORKS_CRAFT_DAYS_MAX', 30),
    dropProb: num('WORKS_DROP_PROB', 0.15),
  };
}

function stripBrackets(s) { return String(s || '').replace(/[《》]/g, '').trim(); }

function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const kind = typeof candidate.kind === 'string' ? candidate.kind.trim().toLowerCase() : '';
  if ((!VERIFIABLE.has(kind) && kind !== 'craft')
    || typeof candidate.title !== 'string' || !stripBrackets(candidate.title)
    || (candidate.creator != null && typeof candidate.creator !== 'string')) return null;
  return { ...candidate, kind, title: candidate.title.trim(), creator: candidate.creator?.trim() || null,
    progressNote: typeof candidate.progressNote === 'string' ? candidate.progressNote.trim() : null };
}

/** 闸1：是否必须按作品类验证。title 含《》→ 强制（确定性兜底，不靠 LLM 自报 kind）。 */
export function requiresVerification(kind, title) {
  if (/《[^》]+》/.test(String(title || ''))) return true;
  // Only an explicitly recognized handcraft is exempt; unknown model output is not trusted.
  return String(kind || '').trim().toLowerCase() !== 'craft';
}

/** 闸2：搜索结果里有没有"同时含作品名与作者"的证据。返回命中 snippet（≤300）或 null。 */
export function evidenceFromResults(results, title, creator) {
  const t = stripBrackets(title);
  const c = String(creator || '').trim();
  if (!t) return null;
  for (const r of (Array.isArray(results) ? results : [])) {
    const hay = `${r?.title || ''} ${r?.snippet || ''}`;
    if (hay.includes(t) && (!c || hay.includes(c))) {
      return hay.replace(/\s+/g, ' ').trim().slice(0, 300);
    }
  }
  return null;
}

/**
 * 单候选验证（§6 双闸）。
 * @returns {{status:'verified'|'generic'|'retry'|'skip', evidence:string|null, reason?:string}}
 *   verified=入档具体名 / skip=craft 免验 / retry=无证据换一部 / generic=降级泛读态
 * deps（全注入，纯逻辑可测）：{ search, findCached, dailyUsed, dailyCap }
 */
export async function verifyWorkCandidate(candidate, deps = {}) {
  const normalized = normalizeCandidate(candidate);
  if (!normalized) return { status: 'generic', evidence: null, reason: 'invalid_candidate' };
  const { kind, title, creator } = normalized;
  const search = deps.search || ((q) => webSearch(q));
  const findCached = deps.findCached || findVerifiedWork;
  const dailyCap = deps.dailyCap ?? worksConfig().verifyDailyCap;
  const dailyUsed = deps.dailyUsed ?? 0;

  if (!requiresVerification(kind, title)) return { status: 'skip', evidence: null };

  // 缓存：只缓 verified、永不过期；负结果不缓存。
  // ⚠ 缓存键 normalize 约定：key 必先 stripBrackets（与入库口径一致）——详见 db.findVerifiedWork 注释。
  const cached = findCached(stripBrackets(title), creator || null);
  if (cached) return { status: 'verified', evidence: cached.verify_evidence || null };

  // 日上限：异常循环防烧 Tavily 配额
  if (dailyUsed >= dailyCap) {
    log('warn', `[CurrentWorks] 作品验证日上限 ${dailyCap} 到顶 → 降级 generic`);
    return { status: 'generic', evidence: null, reason: 'daily_cap' };
  }

  let res;
  try {
    const q = `《${stripBrackets(title)}》 ${creator || ''} ${kind === 'book' ? '书' : ''}`.replace(/\s+/g, ' ').trim();
    res = await search(q);
  } catch (e) {
    log('warn', `[CurrentWorks] 作品验证失败（异常 ${e.message}）→ 降级 generic`);
    return { status: 'generic', evidence: null, reason: 'provider_error' };
  }
  // provider 故障 ≠ 书是假的：降级 generic、不计作品失败、不重试
  if (!res || res.ok === false) {
    log('warn', `[CurrentWorks] 作品验证失败（provider ${res?.error || 'down'}）→ 降级 generic（不判真书为假）`);
    return { status: 'generic', evidence: null, reason: res?.error === 'no_provider' ? 'no_provider' : 'provider_error' };
  }
  const evidence = evidenceFromResults(res.results, title, creator);
  if (evidence) return { status: 'verified', evidence };
  return { status: 'retry', evidence: null };   // ok 但无证据 → 换一部
}

/** kind → 生命周期天数（§13），用 started_at 派生确定性抖动（同一档案每次判定一致）。 */
export function lifecycleDays(kind, startedAt, cfg = worksConfig()) {
  const k = String(kind || '').toLowerCase();
  const [lo, hi] = k === 'book' ? [cfg.bookDaysMin, cfg.bookDaysMax]
    : (k === 'series' || k === 'anime' || k === 'game') ? [cfg.seriesDaysMin, cfg.seriesDaysMax]
      : [cfg.craftDaysMin, cfg.craftDaysMax];
  const seed = Number(new Date(startedAt).getTime()) || 0;
  const span = Math.max(1, hi - lo + 1);
  return lo + (Math.abs(seed) % span);
}

/** 该作品是否到完结点（now - started_at ≥ 生命周期天数）。 */
export function isWorkFinished(work, now = new Date(), cfg = worksConfig()) {
  const days = lifecycleDays(work.kind, work.started_at, cfg);
  return now.getTime() - new Date(work.started_at).getTime() >= days * 86400_000;
}

// ════════════════════════════════════════════════════════════════════════════
// 日程结构化（PR-W5；设计 §7「进行中」）：让日程消费 works 档案 + progress 可推进。
// 把日程从「LLM 每天即兴重画」改造成「消费结构化档案、状态可推进」——这是 v1.22
// life_state（生病/疲惫/生理期）的物理前置：works 是第一个「档案驱动日程」实现，
// 结构上为 life_state 留好同样的「状态源→日程」注入位（见 buildScheduleWorksHint 注释）。
// ════════════════════════════════════════════════════════════════════════════

/** 在档进度比例 0~1（elapsed / 生命周期天数；确定性，与 isWorkFinished 同尺）。 */
export function workProgressRatio(work, now = new Date(), cfg = worksConfig()) {
  const days = lifecycleDays(work.kind, work.started_at, cfg);
  const r = (now.getTime() - new Date(work.started_at).getTime()) / Math.max(1, days * 86400_000);
  return r < 0 ? 0 : r > 1 ? 1 : r;
}

// 渐进进度文案（按 kind × 阶段；跨阶段才变=低频不跳，与生命周期换档天然衔接）
const PROGRESS_STAGES = {
  book:   ['才翻开没几页', '看了几章了', '看到一半了', '快读完了'],
  series: ['刚追了一两集', '追了几集了', '追到一半了', '就剩最后几集'],
  anime:  ['刚开番', '追了几话了', '过半了', '快完结了'],
  game:   ['刚开个头', '玩了一阵了', '玩到中段了', '快通关了'],
  craft:  ['才起了个头', '做了一点了', '做了一半了', '快收尾了'],
};

/** kind × ratio → 渐进进度文案（确定性；ratio 单调↑则文案单调推进，绝不跳级/回退）。 */
export function progressStageNote(kind, ratio) {
  const k = ['book', 'series', 'anime', 'game', 'craft'].includes(String(kind || '').toLowerCase())
    ? String(kind).toLowerCase() : 'book';
  const stages = PROGRESS_STAGES[k] || PROGRESS_STAGES.book;
  const idx = ratio < 0.2 ? 0 : ratio < 0.5 ? 1 : ratio < 0.8 ? 2 : 3;
  return stages[idx];
}

// generic 只保留活动类别，不把未验证的题材/名称当成作品。
const GENERIC_LABELS = { book: '书', series: '剧集', anime: '动画', game: '游戏', craft: '手工' };
const GENERIC_PROGRESS = {
  book: ['刚开始闲时翻翻', '最近有空会接着读', '这阵子还在读', '最近偶尔翻翻'],
  series: ['刚开始闲时看看剧', '最近有空会接着追剧', '这阵子还在追剧', '最近偶尔看看剧'],
  anime: ['刚开始闲时看看动画', '最近有空会接着看动画', '这阵子还在看动画', '最近偶尔看看动画'],
  game: ['刚开始闲时玩一会儿', '最近有空会接着玩', '这阵子还在玩', '最近偶尔玩一会儿'],
  craft: ['刚开始闲时做点手工', '最近有空会接着做手工', '这阵子还在做手工', '最近偶尔做点手工'],
};

function genericSubject(work) {
  const kind = String(work?.kind || '').toLowerCase();
  // 新 generic 档案只存类别占位；兼容旧泛读题材记录，不把它包成作品名。
  if (kind === 'book') return '一本' + (stripBrackets(work.title) || '书');
  return { series: '一部剧', anime: '一部动画', game: '一款游戏', craft: '一些手工' }[kind] || '一本书';
}

/** 当前活动文案；同阶段返回 null，避免重复写库。 */
export function advanceWorkProgress(work, now = new Date(), cfg = worksConfig()) {
  if (!work) return null;
  const ratio = workProgressRatio(work, now, cfg);
  const stages = GENERIC_PROGRESS[String(work.kind || '').toLowerCase()] || GENERIC_PROGRESS.book;
  // generic 只描述普通活动的延续，不推断具体章节、关卡、集数或通关。
  const note = work.verify_status === 'generic'
    ? stages[ratio < 0.2 ? 0 : ratio < 0.5 ? 1 : ratio < 0.8 ? 2 : 3]
    : progressStageNote(work.kind, ratio);
  return (note && note !== work.progress_note) ? note : null;
}

/**
 * 给日程生成的「档案驱动」hint（§7 进行中）：active works 注入，日程里「读书/看番/
 * 打游戏/做手工」类活动必须引用这些真实条目，杜绝日程层重新漂移出档案外书名。
 * ★ life_state 预留位：未来 life_state（生病/疲惫/生理期）作为同类「影响今日日程的状态源」
 *   在此并列注入（works 是第一个实现）——本任务只落 works，结构留位、不写 life_state 代码。
 */
export function buildScheduleWorksHint(works) {
  const list = (Array.isArray(works) ? works : []).filter(w => w && w.title);
  if (!list.length) return '';
  const verb = (k) => { const x = String(k || '').toLowerCase();
    return (x === 'series' || x === 'anime') ? '在追' : x === 'game' ? '在玩' : x === 'craft' ? '在做' : '在看'; };
  const lines = list.map(w => {
    const t = w.verify_status === 'generic' ? genericSubject(w)
      : String(w.kind || '').toLowerCase() === 'craft' ? stripBrackets(w.title)
        : `《${stripBrackets(w.title)}》`;
    return `${verb(w.kind)}${t}${w.progress_note ? `（${w.progress_note}）` : ''}`;
  });
  return `
【她正在进行的事（来自档案 · 注意验证状态）】她${lines.join('；')}。
今天日程里「读书/看剧/看番/打游戏/做手工」类活动优先延续上面的档案；已验证作品可以引用原名，generic 只是未验证的普通活动，不能把类别或题材当作真实作品名，也不能声称搜索验证成功。**绝不另编新书名/剧名/游戏名**；generic 可以接着读、追剧或玩一会儿，不能编造章节、集数、关卡、剧情或通关。
（★ 结构预留：未来 life_state 身体状态——生病/疲惫/生理期——同样作为"影响今日日程的状态源"在此并列注入，本任务先落 works。）`;
}

// ════════════════════════════════════════════════════════════════════════════
// 表达层（PR-W2；设计 docs/V1214_DESIGN.md §8 + §7 存量退场规则）。全纯函数：
// hint 由调用方拼好传入 buildSystemPrompt（shapingHint 先例，保持 companion.mjs 零依赖）。
// 红线：对话召回永不挂冷却（他问起永放行）；冷却只锁她「主动」提（proactive + 闲聊自荐）。
// ════════════════════════════════════════════════════════════════════════════

function clipNote(s, n = 30) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

/** 素材账本命名空间（mem:/loop:/pref: 同模式；48h 冷却 + 周上限的计数单位）。 */
export function workMaterialId(id) { return `work:${id}`; }

/** 单条 work → 事实式短语（verified 指名《》/ generic 不指名 / craft 自由文本）。 */
function renderWork(w) {
  const status = String(w?.verify_status || '');
  const kind = String(w?.kind || '').toLowerCase();
  const prog = w?.progress_note ? `（${clipNote(w.progress_note)}）` : '';
  if (status === 'generic') {
    const verb = (kind === 'series' || kind === 'anime') ? '在追' : kind === 'game' ? '在玩' : kind === 'craft' ? '在做' : '在看';
    return `${verb}${genericSubject(w)}${prog}`;
  }
  if (kind === 'craft' || status === 'skip') {
    return `手上在${stripBrackets(w.title)}${prog}`;       // "给外婆织围巾（快收尾了）"
  }
  const verb = (kind === 'series' || kind === 'anime') ? '在追' : kind === 'game' ? '在玩' : '在看';
  return `${verb}《${stripBrackets(w.title)}》${prog}`;
}

/**
 * 注入段（§8）：active works 事实行 + 三条行为约束。
 * 约束①他问起永放行（对话召回不挂冷却）②她别每条自荐（克制；冷却的语义侧）
 * ③档案外旧作品状态未确认，不凭空宣称完成，也不沿用未证实的进度/剧情。
 * works 为空 → 返回 ''（不注入）。纯函数，零 IO。
 */
export function buildWorksPromptHint(works) {
  const list = (Array.isArray(works) ? works : []).filter(w => w && w.title);
  if (!list.length) return '';
  const line = list.map(renderWork).join('；');
  // 当前档案提供可用活动，缺席不等于已完成；旧对话里的作品也不能据此续编。
  return `\n【手头的事】你最近${line}。这是当前档案中记录的活动，不代表你全部的过往经历。
- 他问起这些（"那本书看到哪了""最近在看啥"）你**永远正常接、聊得起来**——这是你的生活，不是不能说的秘密。
- 但别每条消息都自己往上贴这些书/剧，尤其最近刚主动提过的就先放一放（真人不会逮着一本书天天念）。
- generic 是未验证的普通活动，允许自然延续读书、追剧、玩游戏；类别/题材不是作品名，不要编造具体名称、章节、关卡、集数、剧情或验证成功。
- 档案外的作品状态未确认，不能仅因不在当前档案就声称已完成或看完。他问起旧名时，结合可靠记录回答；没有依据就自然说明记不准具体进度，不续编剧情，也不否认确实说过的话。`;
}

/** 主动话题复用对话中的类别/验证状态表达，避免消费者自行按书拼接。 */
export function buildProactiveWorkHint(work) {
  if (!work) return '';
  const sample = { book: '闲时翻了会儿书', series: '闲时看了会儿剧', anime: '闲时看了会儿动画', game: '闲时玩了一会儿', craft: '闲时做了点手工' }[String(work.kind || '').toLowerCase()] || '最近有空还在接着做';
  const genericGuard = work.verify_status === 'generic'
    ? '这只是未验证的普通活动，不要编造作品名、章节、集数、关卡、剧情或通关。' : '';
  return `\n\n【★ 可选话题 · 手头的事】这次**可以**很自然地聊一句你最近${renderWork(work)}（随口说说活动近况，像"${sample}"），也可以不聊、说你更想说的。${genericGuard}别硬贴、一句带过就好。`;
}

/** generic 没有已确认实物，不能占照片槽位或替换原场景。 */
export function isWorkPhotoEligible(work) {
  return Boolean(work && work.verify_status !== 'generic'
    && (work.verify_status === 'verified' || String(work.kind || '').toLowerCase() === 'craft'));
}

/** 照片 activity_pov 品类的 works sceneSeed（无脸 POV 拍手头的事；复用既有品类，不另起 kind）。 */
export function worksSceneSeed(work) {
  if (!work || work.verify_status === 'generic') return '';
  const kind = String(work.kind || '').toLowerCase();
  const t = stripBrackets(work.title);
  const prog = work.progress_note ? `，可顺带一句进度/感想（${clipNote(work.progress_note, 24)}）` : '';
  if (kind === 'craft') {
    return `此刻你手上在做的手工「${t}」——first-person POV 低头俯拍那件半成品/材料/工具（毛线织针、做了一半的东西），`
      + `**不出现脸、不出现人**。caption 像随手分享你在做这个${prog || '，别太用力'}。`;
  }
  if (kind === 'series' || kind === 'anime' || kind === 'game') {
    return `此刻你在追/在玩的《${t}》——拍屏幕一角/手柄/沙发毯子的氛围 POV（屏幕画面朦胧带过、不拍清晰版权画面），`
      + `**不出现脸**。caption 像随手分享你在追这个${prog || '，别剧透'}。`;
  }
  // book（默认）：真实出版物护栏在 sceneSeed 层也写死一遍（与 planner 临时护栏冗余兜底）
  return `此刻你正在看的《${t}》——first-person POV 低头俯拍摊开的书页/书脊一角/压在书上的手，**不出现脸**。`
    + `**真实出版物护栏**：只拍摊开内页或书脊/封面一角的局部，绝不拍完整正面封面（生成封面=伪造、复刻=版权，两条都死）。`
    + `caption 像随手分享你在读这本书${prog || '，别念书评腔'}。`;
}

/**
 * 从 active works 里挑一件「现在可以主动提/拍」的（§8 冷却 + 周上限双闸）。
 * 对话召回不走这里（他问起永放行）——这只服务 proactive 自荐。
 * @param works getActiveCurrentWorks 结果
 * @param o.usedIds      Set<string> 近 cooldown 窗内已用素材 id（48h 冷却 = 存在性）
 * @param o.weeklyCount  (workMatId)=>number 近 7 天该 work 已主动出场次数（周上限 = 计数）
 * @param o.eligible     (work)=>bool 额外资格（照片侧只拍 verified/craft，文本侧放行 generic）
 * @returns 命中的 work 或 null（全冷却/超限/无资格）
 */
export function pickProactiveWork(works, { usedIds = new Set(), weeklyCount = () => 0, eligible = () => true, cfg = worksConfig(), rng = Math.random } = {}) {
  const used = usedIds instanceof Set ? usedIds : new Set();
  const pool = (Array.isArray(works) ? works : []).filter(w => {
    if (!w || w.id == null || !eligible(w)) return false;
    const id = workMaterialId(w.id);
    if (used.has(id)) return false;                                    // 48h 冷却（存在性）
    if ((Number(weeklyCount(id)) || 0) >= cfg.weeklyMentionCap) return false;   // 周上限（计数）
    return true;
  });
  if (!pool.length) return null;
  return pool[Math.floor(rng() * pool.length)];
}

/** 完结/弃读归档为一条记忆（§7；对话里"你之前看的那本"靠它召回接住）。纯函数返回字段。 */
export function buildWorkArchiveMemory(work, dropped, now = new Date()) {
  const status = String(work?.verify_status || '');
  const monthLabel = `${new Date(now.getTime() + 8 * 3600_000).getUTCMonth() + 1}月`;
  const note = work?.progress_note ? `，${clipNote(work.progress_note, 24)}` : '';
  let content;
  if (status === 'generic') {
    const kind = String(work?.kind || '').toLowerCase();
    const verb = kind === 'game' ? '玩过' : kind === 'craft' ? '做过' : '看过';
    content = `${monthLabel}${verb}${genericSubject(work)}，${dropped ? '暂时放下了' : '这阵子的活动告一段落'}${note}`;
  } else if (String(work?.kind || '').toLowerCase() === 'craft' || status === 'skip') {
    const t = stripBrackets(work?.title);
    content = dropped ? `${monthLabel}${t}做了一半放下了` : `${monthLabel}${t}做完了${note}`;
  } else if (String(work?.kind || '').toLowerCase() === 'game') {
    const t = stripBrackets(work?.title);
    content = `${monthLabel}玩过《${t}》，${dropped ? '暂时放下了' : '这阵子的游玩告一段落'}${note}`;
  } else {
    const t = stripBrackets(work?.title);
    content = dropped ? `${monthLabel}《${t}》看了一半弃了，看不下去` : `${monthLabel}看完了《${t}》${note}`;
  }
  return { memoryType: 'event', content: content.slice(0, 80), importance: 5 };
}

/**
 * 一个 companion 的档案换档（§7 PR-W1：完结→换新 + 槽位不满→建档）。
 * deps（全注入，可测）：{ generate, search, findCached, dailyUsed, dailyCap, now, rng,
 *   getActive, insert, setStatus, archiveFinished }
 *   generate(companion, existingTitles) → {kind,title,creator,genre,progressNote}
 * @returns 诊断 { finished, dropped, added, statusOfAdded }
 */
export async function ensureCurrentWorks(companion, deps = {}) {
  const cfg = deps.cfg || worksConfig();
  const now = deps.now || new Date();
  const rng = deps.rng || Math.random;
  const getActive = deps.getActive;     // (companionId) => rows
  const insert = deps.insert;           // ({...}) => id
  const setStatus = deps.setStatus;     // (workId, status)
  const out = { finished: 0, dropped: 0, added: 0, progressed: 0, statusOfAdded: null, fallbackReason: null };
  if (!getActive || !insert || !setStatus) throw new Error('ensureCurrentWorks 缺 db 注入');

  let active = getActive(companion.id) || [];
  // 1) 完结到点 → finished（小概率 dropped，真人不是每本都看完）
  for (const w of active) {
    if (isWorkFinished(w, now, cfg)) {
      const dropped = rng() < cfg.dropProb;
      setStatus(w.id, dropped ? 'dropped' : 'finished');
      if (deps.archiveFinished) { try { await deps.archiveFinished(companion, w, dropped); } catch {} }
      dropped ? out.dropped++ : out.finished++;
    }
  }
  active = getActive(companion.id) || [];

  // 2) 槽位不满 → 生成候选 + 验证 + 入档（验证≤retries 次换候选，仍无→generic）
  if (active.length < cfg.maxActive && typeof deps.generate === 'function') {
    const existing = active.map(w => w.title);
    const recentTitles = deps.recentTitles || [];   // #1 多样性：他人近期已选（降权避雷同）
    let chosen = null, evidence = null, statusFinal = 'generic', fallbackKind = 'book';
    let fallbackReason = 'generation_failed';
    for (let attempt = 0; attempt <= cfg.verifyRetries; attempt++) {
      const generated = await deps.generate(companion, existing, { recentTitles });
      if (!generated) break;
      const cand = normalizeCandidate(generated);
      if (!cand) { fallbackReason = 'invalid_candidate'; break; }
      fallbackKind = cand.kind;
      const v = await verifyWorkCandidate(cand, {
        search: deps.search, findCached: deps.findCached,
        dailyUsed: deps.dailyUsed, dailyCap: cfg.verifyDailyCap,
      });
      if (v.status === 'verified' || v.status === 'skip') {
        chosen = cand; evidence = v.evidence; statusFinal = v.status; break;
      }
      if (v.status === 'generic') { fallbackReason = v.reason; break; }   // provider 故障/日上限：止损
      fallbackReason = 'insufficient_evidence';
      existing.push(stripBrackets(cand.title));   // retry：换一部（剥《》与入库口径一致）
    }
    if (chosen) {
      insert(companion.id, {
        // #2 入库统一剥《》：与 findVerifiedWork 缓存查询（用 stripBrackets）口径一致，
        // 修缓存命中 bug（存《活着》查"活着"对不上→同书每次重搜）；表达层 renderWork 再包《》。
        kind: chosen.kind, title: stripBrackets(chosen.title), creator: chosen.creator,
        verifyStatus: statusFinal, verifyEvidence: evidence,
        progressNote: chosen.progressNote || null, startedAt: now.toISOString(),
      });
      out.statusOfAdded = statusFinal;
    } else {
      // 保留候选类别；title 必填但只存类别占位，不存未验证名称或题材。
      const g = GENERIC_LABELS[fallbackKind];
      insert(companion.id, {
        kind: fallbackKind, title: g, creator: null, verifyStatus: 'generic',
        verifyEvidence: null, progressNote: null, startedAt: now.toISOString(),
      });
      out.statusOfAdded = 'generic';
      out.fallbackReason = fallbackReason;
    }
    out.added++;
  }

  // 3) 进度推进（PR-W5 §7 进行中）：对剩余 active works 按在档时长渐进推进 progress_note
  //    （跨阶段才写库=低频不跳；推到"快读完"后由 isWorkFinished 接力换档归档，天然衔接）。
  if (deps.setProgress) {
    for (const w of (getActive(companion.id) || [])) {
      if (isWorkFinished(w, now, cfg)) continue;   // 到点的本趟已 finished 处理
      const note = advanceWorkProgress(w, now, cfg);
      if (note) { try { deps.setProgress(w.id, note); w.progress_note = note; out.progressed++; } catch {} }
    }
  }
  return out;
}

// ─── 生产接线：真 LLM 生成候选 + 验证日上限计数 + 单 companion 换档 ───────────
function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/**
 * 换档生成 prompt（纯函数，便于 smoke 断言人设软提示/多样性约束真在场）。
 * #1 多样性：existing(自己) + recentTitles(他人近期) 合并去重作"避免雷同"清单。
 * #3 人设软提示：年龄/性格 → 品味倾向（不拦真书，只调品味，案例 #8 瑾选《金瓶梅》）。
 * #2 源头：明令 title 不加书名号（入库再 stripBrackets 兜底，双保险）。
 */
export function buildWorkGenPrompt(companion, { existingTitles = [], recentTitles = [] } = {}) {
  let hobbies = '';
  try { hobbies = JSON.parse(companion?.hobbies || '[]').join('、'); } catch {}
  let persona = '';
  try { persona = JSON.parse(companion?.personality_tags || '[]').join('、'); } catch {}
  const age = Number(companion?.age) || 22;
  // 多样性 avoid：existing(自己)+recentTitles(他人)合并去重。**必 normalize(stripBrackets)后比对**——
  // 否则"小王子"与曾经入库的"《小王子》"会被当两本书（2026-06-13 维护者 normalize 半笔，与缓存键同源）。
  const avoid = [...new Set([...(existingTitles || []), ...(recentTitles || [])].map(t => stripBrackets(t)).filter(Boolean))];
  const system = '你给一个 AI 伴侣生成"她最近在看/在做的一件真实存在的事"。只返回合法 JSON，不解释。';
  const prompt = `她的兴趣：${hobbies || '阅读、看剧'}。她 ${age} 岁，性格：${persona || '温和'}。
请按她这个**年龄和性格的真实品味倾向**来选（如年轻文静→治愈/成长/经典文学；外向活泼→热门剧/悬疑；不同人品味不同）。**必须真实存在**，但别选明显不符她年龄气质的（如清纯文静的年轻女生通常不会主动在读情色或过于艰深沉重的书）。
**避免雷同**（这些最近已被选过，请换不一样的）：${avoid.join('、') || '无'}。
生成一件她最近在看的**真实存在**的书/剧/番/游戏，或在做的手工(craft)。书优先填作者，剧/番填出品方。
返回 {"kind":"book|series|anime|game|craft","title":"真实存在的作品名(不加书名号《》、不要编)","creator":"作者或出品方(craft 填 null)","genre":"题材如 推理/科幻/治愈","progressNote":"进度一句话如 看到第三章"}`;
  return { system, prompt };
}

/** 真 LLM 生成候选（题材从 hobbies 取 + 人设品味 + 多样性）。返回 {kind,title,creator,genre,progressNote} 或 null。 */
export async function generateWorkCandidate(companion, existingTitles = [], { recentTitles = [] } = {}) {
  const { system, prompt } = buildWorkGenPrompt(companion, { existingTitles, recentTitles });
  try {
    const raw = await extractStructuredInfo(system, prompt, { accountId: companion?.user_id || null, maxTokens: 200, temperature: 0.8 });
    return extractJson(raw);
  } catch (e) {
    log('warn', `[CurrentWorks] 候选生成失败 companion=${companion?.id}: ${e.message}`);
    return null;
  }
}

// 验证日上限计数（app_settings，按上海日期 key；防异常循环烧 Tavily 配额）
function worksDailyKey(now) { return `works_verify_${new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)}`; }
function worksDailyUsed(now) { try { return Number(getAppSetting(worksDailyKey(now))) || 0; } catch { return 0; } }
function bumpWorksDaily(now) { try { setAppSetting(worksDailyKey(now), String(worksDailyUsed(now) + 1)); } catch {} }

/**
 * 完结/弃读 → 归档一条 event 记忆（PR-W2 对话召回：他问"你之前看的那本"靠它接住）。
 * fail-open：embed/落库失败绝不阻断换档。需 companion.user_id（plan_tasks SELECT 已带）。
 */
async function archiveFinishedWork(companion, work, dropped, now) {
  if (!companion?.user_id) return;   // 无 user_id 无法落记忆——静默跳过（不阻断换档）
  const m = buildWorkArchiveMemory(work, dropped, now);
  let embedding = null;
  try { embedding = await embedText(m.content); } catch { /* 无 embedding 仍可关键词召回 */ }
  saveMemory({ companionId: companion.id, userId: companion.user_id, memoryType: m.memoryType, content: m.content, importance: m.importance, embedding });
  log('info', `[CurrentWorks] 归档完结记忆 companion=${companion.id} ${dropped ? '弃读' : '完结'} "${m.content}"`);
}

/** 单 companion 换档（00:30 日程批顺路调；全程 fail-open，绝不阻断日程生成）。 */
export async function refreshCurrentWorks(companion, { now = new Date() } = {}) {
  let recentTitles = [];
  try { recentTitles = getRecentWorkTitles(companion.id, { now: now.getTime() }); } catch { /* fail-open：无多样性降权 */ }
  const out = await ensureCurrentWorks(companion, {
    now,
    getActive: getActiveCurrentWorks, insert: insertCurrentWork, setStatus: setCurrentWorkStatus,
    generate: generateWorkCandidate,
    search: (q) => webSearch(q),
    findCached: findVerifiedWork,
    dailyUsed: worksDailyUsed(now),
    recentTitles,                                                  // #1 多样性降权
    archiveFinished: (comp, w, dropped) => archiveFinishedWork(comp, w, dropped, now),
    setProgress: setCurrentWorkProgress,                           // W5 §7 进度推进
  });
  if (out.added && out.statusOfAdded !== 'skip') bumpWorksDaily(now);   // 计一次验证额度（上限语义）
  return out;
}
