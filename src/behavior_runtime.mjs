import { BEHAVIOR_ACTIONS, loadBehaviorLibrary } from './behavior_library.mjs';

const ARC_STATES = new Set(['normal', 'hurt', 'cold', 'withdrawing', 'repairing', 'normal_with_scar']);
const PAUSE_SOURCE = 'suqing.pause';
const PAUSE_REVISION = '1';
const STOP = /(?:别|不要|不用|不想|不愿意)(?:再|继续)?(?:问|提|聊|说)(?:了|这|下去|这个|那件|我|我的|吧|$)|(?:先)?不(?:聊|说)(?:了|这个|这件|$)|(?:别|不要|不用)(?:再)?(?:找我|提醒我|联系我|烦我)|让我(?:静一静|静静|一个人待会)|换(?:个|一个)?话题|聊点别的|先不说这个|到此为止/;
const CONTINUE = /^(?:嗯+|哦+|是啊|是的|对|好|好的|谢谢|还有呢|然后呢|继续|就是|确实|唉|哎|那怎么办|怎么办)[。！？!?.…～~，,\s]*$/;
const ADVICE = /(?:怎么(?:办|做|跟|和|说|沟通)|该(?:怎么|不该)|能不能(?:帮|给)|帮我(?:想|分析)|给我(?:建议|出个)|有什么(?:办法|建议)|你觉得我该)/;
const SUPPORT = /难受|委屈|焦虑|担心|害怕|沮丧|自责|没用|搞砸|失败|被(?:领导|老板|同事|老师)?(?:批评|骂)|压力|累坏|好累|好烦|太烦|崩溃|失落|没(?:拿到|考过|通过)|吵架|受挫/;
const CELEBRATE = /好开心|太开心|好高兴|太高兴|好消息|成功了|做成了|升职|获奖|拿到.{0,8}(?:驾照|奖|offer)|考过了|考试通过|终于.{0,12}(?:通过|考过|完成|做好)/i;
const DIRECT_CONFLICT = /你(?:刚才|刚刚|之前)?(?:伤到|惹我|不理|一直问|还.{0,5}问|总是.{0,8}(?:问|逼|催))|你(?:刚才|刚刚|之前)?(?:那句话|这样说|说话|让我).{0,16}(?:难受|委屈|不舒服|伤心|生气|烦|失望|受伤|不开心)|你(?:刚才|刚刚).{0,8}(?:凶|吼|骂)|我们(?:刚才|刚刚|又)?(?:吵|闹)|跟你(?:吵|闹)|我(?:刚才|刚刚)?(?:不该|不应该).{0,8}(?:你|凶)|(?:不想|不愿意|不喜欢)(?:被你(?:催|逼)|你(?:催|逼)我)|我错了|对不起.{0,15}你/;
const THIRD_PARTY = /(?:他|她|同事|朋友|领导|老板|家人|妈妈|爸爸|对象)(?:跟我)?(?:说|问|道歉)|跟(?:同事|朋友|领导|老板|家人|妈妈|爸爸|对象)(?:吵|闹)/;
const DELAY_REQUEST = /(?<![\d.\-])(\d{1,4})\s*(分钟|小时)后(?:再|请|你|能不能|可以|能|来|主动|就|\s){0,8}(?:找我|问我|陪我|跟我聊|和我聊)/;

export function isBehaviorEnabled() {
  return String(process.env.BEHAVIOR_ENABLED || '').trim().toLowerCase() === 'true';
}

function arc(value) { return ARC_STATES.has(value) ? value : 'normal'; }
function blocked(companion, safetyLevel) {
  return !!Number(companion?.safe_mode) || (safetyLevel && safetyLevel !== 'none');
}
function userClauses(text) {
  return text.split(/[，,。！？!?；;\n]/).filter(clause => !THIRD_PARTY.test(clause));
}
function wantsAdvice(text) {
  return ADVICE.test(text) && !/(?:别|不要|不用|不需要|不想要).{0,12}(?:建议|办法|分析|怎么做)/.test(text);
}
function directScenario(text) {
  if (userClauses(text).some(clause => DIRECT_CONFLICT.test(clause))) return 'repair';
  if (SUPPORT.test(text)) return 'support';
  if (CELEBRATE.test(text)) return 'celebrate';
  return null;
}
export function isBehaviorStopRequested(userText) {
  const text = String(userText || '').trim().slice(0, 4000);
  return userClauses(text).some(clause => STOP.test(clause));
}

export function parseBehaviorFollowupDelay(userText) {
  const text = String(userText || '').trim().slice(0, 4000);
  if (/(?:别|不要|不用|不必).{0,20}(?:找我|问我|陪我|跟我聊|和我聊)/.test(text)) return null;
  // A quoted promise or denial is not permission for suqing to contact later.
  if (/(?:他|她|同事|朋友|领导|老板).{0,6}(?:说|让|要|会)|[“”「」『』"]|(?:没|没有|不曾)(?:有)?(?:让|叫|要求|要|请|说)|(?:不是|并非).{0,8}(?:让|叫|要求|要|请|说)/.test(text)) return null;
  const match = text.match(DELAY_REQUEST);
  if (!match) return null;
  const delayMinutes = Number(match[1]) * (match[2] === '小时' ? 60 : 1);
  return delayMinutes >= 1 && delayMinutes <= 1440 ? delayMinutes : null;
}

function permittedFollowup(text, companion, channel) {
  if (channel !== 'wechat' || !Number(companion?.proactive_enabled) || Number(companion?.silent_mode)) return null;
  const delayMinutes = parseBehaviorFollowupDelay(text);
  return delayMinutes === null ? null : { delayMinutes };
}

/** Select a small relevant policy set; no model calls, writes, or user profiling. */
export function prepareBehaviorContext({ companion, userText, history = [], previous = null, arcState = 'normal', safetyLevel = 'none', channel = 'web' } = {}) {
  if (!isBehaviorEnabled() || !companion || blocked(companion, safetyLevel)) return null;
  const text = String(userText || '').trim().slice(0, 4000);
  if (!text) return null;
  if (isBehaviorStopRequested(text)) {
    return { candidates: [], scenario: 'pause', defaultAction: 'pause', userText: text, previous, arcState: arc(arcState), safetyLevel, channel, followup: null };
  }
  const cards = loadBehaviorLibrary();
  if (!cards.length) return null;
  let prior = previous?.scenario === 'pause' ? null : previous;
  // Ground continuation in the latest meaningful user turn, not a six-hour-old
  // delivery. Scan through short acknowledgments so unrelated topics stay ended.
  const latestTopic = history.slice(-10).reverse().find(h =>
    (h.direction === 'in' || h.role === 'user') && !CONTINUE.test(String(h.content || '')));
  if (prior && latestTopic) {
    const lastText = String(latestTopic.content || '');
    if (isBehaviorStopRequested(lastText) || (!directScenario(lastText) && !wantsAdvice(lastText) && !parseBehaviorFollowupDelay(lastText))) prior = null;
  }
  if (!previous && CONTINUE.test(text)) {
    const lastUser = history.slice(-4).reverse().find(h => (h.direction === 'in' || h.role === 'user') && h.content !== text);
    const scenario = directScenario(String(lastUser?.content || ''));
    if (scenario) prior = { scenario, action: scenario === 'support' ? 'validate' : scenario === 'repair' ? 'clarify' : 'celebrate' };
  }
  const followup = permittedFollowup(text, companion, channel);
  let scenario = directScenario(text);
  if (!scenario && prior && (CONTINUE.test(text) || wantsAdvice(text) || followup)) scenario = prior.scenario;
  if (!scenario || !BEHAVIOR_ACTIONS[scenario]) return null;
  const candidates = cards.filter(c => c.scenario === scenario);
  if (!candidates.length) return null;
  const defaultAction = scenario === 'support'
    ? (wantsAdvice(text) ? 'suggest' : prior?.scenario === 'support' ? 'listen' : 'validate')
    : scenario === 'repair' ? 'clarify' : 'celebrate';
  return { candidates, scenario, defaultAction, userText: text, previous: prior, arcState: arc(arcState), safetyLevel, channel, followup };
}

export function buildBehaviorPlanningHint(context) {
  if (!context) return '';
  const actions = context.scenario === 'pause' ? ['pause'] : BEHAVIOR_ACTIONS[context.scenario];
  if (!actions) return '';
  const cards = context.candidates.map(card => `${card.title}\n${card.when.join('；')}\n${Object.entries(card.actions).map(([key, value]) => `${key}: ${value}`).join('\n')}\n避免：${card.avoid.join('；')}`).join('\n');
  return `\n【本轮相处行为候选】\n执行者是你，不是教对方怎么对待另一个人。保留内心感受，但把感受和行动选择分开。\n${cards}\n本轮 scenario 只能是 ${context.scenario}，action 只能从 ${actions.join(' / ')} 中选择；默认 ${context.defaultAction}。\n在结构化 JSON 中增加 behavior 字段：{"scenario":"${context.scenario}","action":"${context.defaultAction}"}。没有依据不要增加动作，不生成工具、定时器或任意新字段。原有冲突信号仍如实填写。`;
}

/** Treat model output as a proposal; hard boundaries and timing remain code-owned. */
export function resolveBehaviorPlan(context, rawBehavior, { arcState = context?.arcState, safetyLevel = context?.safetyLevel } = {}) {
  if (!isBehaviorEnabled() || !context || (safetyLevel && safetyLevel !== 'none')) return null;
  if (context.scenario === 'pause') return { scenario: 'pause', action: 'pause', sourceId: PAUSE_SOURCE, sourceRevision: PAUSE_REVISION, arcState: arc(arcState), followup: null };
  const card = context.candidates?.find(c => c.scenario === context.scenario);
  if (!card) return null;
  let action = context.defaultAction;
  if (rawBehavior && typeof rawBehavior === 'object' && !Array.isArray(rawBehavior)
      && rawBehavior.scenario === context.scenario && BEHAVIOR_ACTIONS[context.scenario]?.includes(rawBehavior.action)) action = rawBehavior.action;
  if (context.scenario === 'support') {
    if (wantsAdvice(context.userText)) action = 'suggest';
    else if (action === 'suggest' || (action === 'validate' && context.previous?.scenario === 'support')) action = context.defaultAction;
  }
  return { scenario: context.scenario, action, sourceId: card.id, sourceRevision: card.source.revision, arcState: arc(arcState), followup: context.followup ? { ...context.followup } : null };
}

export function buildBehaviorReplyHint(plan) {
  if (!isBehaviorEnabled() || !plan) return '';
  if (plan.scenario === 'pause' && plan.action === 'pause' && plan.sourceId === PAUSE_SOURCE && plan.sourceRevision === PAUSE_REVISION) {
    return '\n【本轮相处行动：尊重暂停】\n对方明确要求停止或换话题。简短接住这个边界，停止追问和分析旧事，不安排后续追问。可以自然转向对方新提的话题；不把暂停当成不爱你，不要求解释，也不要念出内部行动名称。';
  }
  const card = loadBehaviorLibrary().find(c => c.id === plan.sourceId && c.scenario === plan.scenario && c.source.revision === plan.sourceRevision);
  if (!card || !BEHAVIOR_ACTIONS[plan.scenario]?.includes(plan.action)) return '';
  const state = arc(plan.arcState);
  const stateHint = state === 'normal' ? '保留你的性格和自然的聊天节奏。'
    : `关系状态仍是 ${state}，没有因此升级或恢复。你可以保留不舒服和边界，同时执行下面的倾听或沟通动作；不要同时套用“只能嗯哦”的固定冷淡模板，也不要突然撒娇、宣布原谅。`;
  return `\n【本轮相处行动】\n你亲自采用下面的方法与对方相处，不向对方讲解方法、不教对方怎样回复别人。${stateHint}\n${card.actions[plan.action]}\n避免：${card.avoid.join('；')}。\n资料只是方法，例子不是你们发生过的事；不虚构经历，不凭空认错，不替对方宣布情绪好转。只生成你会说的话，不输出方案名、字段、来源或内部规划。\n${plan.followup ? '对方请求了稍后联系；后续投递由程序安排，当前不宣称已经设置提醒、不保证准确送达时间。' : '本轮没有已确认的后台联系安排，不承诺稍后或明天主动发消息。'}\n对方停止或转题就结束这段行动，不为了完成流程强行追问。`;
}
