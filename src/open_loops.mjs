/**
 * v1.8.0 #4: Open Loops —— 她记得"未完成的事"
 *
 * 用户提到 "明天去招聘会"、"周末搬家" 这类**有未来或未确定结果**的事，
 * AI 抽取并存表。proactive 在 due_at 临近时优先级飙升，让她主动问：
 *   "对了，你今天不是去招聘会吗？有人要你没？"
 *
 * 真人陪伴感最强的瞬间之一。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { listOpenLoops, markStaleOpenLoops, shanghaiDateKey } from './db.mjs';
import { log } from './logger.mjs';

/**
 * #324 失忆修：把"还没了结的事/约定"拼成 reply prompt 注入串——**无条件注入**，不靠易失的
 * immediate 16 行窗口兜着（密聊下"约了一起吃晚饭"这类共同约定最容易被长对话挤出窗口而失忆）。
 * 约定/约会(appointment)置顶。纯读、bounded（≤4 条），无则返回 ''。
 */
export function buildOpenLoopsHint(companionId) {
  try {
    const today = shanghaiDateKey();
    const loops = listOpenLoops(companionId, { status: 'open', limit: 20 })
      .filter(l => !l.due_at || l.due_at.slice(0,10) >= today);
    if (!loops.length) return '';
    // appointment（你俩的约定）置顶，其余保持 listOpenLoops 既有排序(emotional_weight/due_at)
    const sorted = [...loops].sort((a, b) =>
      (b.loop_kind === 'appointment' ? 1 : 0) - (a.loop_kind === 'appointment' ? 1 : 0));
    const lines = sorted.slice(0, 4).map(l =>
      `- ${String(l.title).slice(0, 60)}${l.loop_kind === 'appointment' ? '（你俩的约定）' : ''}`);
    return `\n【你记得这些安排】（进展以他最新说的为准）\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

/**
 * 定时清理过期 stale loops。给 plan_tasks.mjs 调。
 */
export function cleanupStaleOpenLoops() {
  try {
    const n = markStaleOpenLoops();
    if (n > 0) log('info', `[OpenLoop] cleanup: ${n} loops → stale`);
    return n;
  } catch (e) {
    log('warn', `[OpenLoop] cleanup 失败: ${e.message}`);
    return 0;
  }
}
