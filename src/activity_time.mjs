// Chat history and schedule times use the same Shanghai clock, regardless of the host timezone.
const formatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function shanghaiMessageTime(value) {
  if (typeof value !== 'string') return null;
  const sql = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value);
  if (!sql && !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const date = new Date(sql ? value.replace(' ', 'T') + 'Z' : value);
  return Number.isFinite(date.getTime()) ? formatter.format(date) : null;
}

export function dayPeriod(hour) {
  if (hour < 5) return '凌晨';
  if (hour < 9) return '清晨';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 22) return '晚上';
  return '深夜';
}

function periodOf(time) { return dayPeriod(Number(time.slice(0, 2))); }

export function inActivityWindow(recorded, { localTime, period, scheduled }) {
  return !!recorded && recorded <= localTime && recorded.slice(0, 10) === localTime.slice(0, 10)
    && periodOf(recorded.slice(11)) === period && (!scheduled || recorded.slice(11) >= scheduled.time);
}

export function activityAt(companion, schedule, now, userText = '') {
  const localTime = formatter.format(now);
  const day = localTime.slice(0, 10), time = localTime.slice(11);
  const period = periodOf(time);
  const items = [];
  if (schedule?.date_key === day && Array.isArray(schedule.items)) {
    for (const entry of schedule.items) {
      const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(entry?.time);
      if (!match || typeof entry.activity !== 'string' || !entry.activity.trim()) continue;
      items.push({ time: match[1].padStart(2, '0') + ':' + match[2], activity: entry.activity.trim().slice(0, 100) });
    }
    items.sort((a, b) => a.time.localeCompare(b.time));
  }
  const latest = items.findLast(item => item.time <= time);
  const slot = latest && periodOf(latest.time) === period ? latest : null;
  const recorded = shanghaiMessageTime(companion?.scene_recorded_at);
  const scene = companion?.current_scene;
  const clock = { localTime, period, scheduled: slot };
  const fresh = inActivityWindow(recorded, clock);
  const asksForPlan = /日程|课表|时间表|安排|计划|(?:早上|上午|中午|午后|下午|傍晚|晚上|刚才|今天|待会儿?|接下来).{0,10}(?:干嘛|做什么|做了什么|在做啥|干了啥|忙什么|吃什么|吃了什么|要做|打算)|(?:几点|什么时候).{0,8}(?:课|吃|去|开始|结束)/u.test(userText);
  return { ...clock, scene: fresh && scene && scene !== '日常' ? { text: scene, at: recorded } : null,
    ...(asksForPlan && items.length ? { dayPlan: items.slice(0, 24) } : {}) };
}
