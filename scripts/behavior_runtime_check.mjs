import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isBehaviorEnabled, prepareBehaviorContext, buildBehaviorPlanningHint,
  resolveBehaviorPlan, buildBehaviorReplyHint,
} from '../src/behavior_runtime.mjs';

const saved = { enabled: process.env.BEHAVIOR_ENABLED, directory: process.env.BEHAVIOR_LIBRARY_DIR };
const companion = { id: 7, proactive_enabled: 1, safe_mode: 0, silent_mode: 0 };
const context = (userText, extra = {}) => prepareBehaviorContext({ companion, userText, channel: 'wechat', ...extra });
const plan = (userText, extra = {}, raw = null) => resolveBehaviorPlan(context(userText, extra), raw);
let count = 0;
const check = (label, fn) => { fn(); count++; console.log(`✓ ${label}`); };

try {
  delete process.env.BEHAVIOR_LIBRARY_DIR;
  delete process.env.BEHAVIOR_ENABLED;
  check('feature is opt-in, including the pure entry point', () => {
    assert.equal(isBehaviorEnabled(), false);
    assert.equal(context('今天工作搞砸了，好难受'), null);
  });
  process.env.BEHAVIOR_ENABLED = 'true';
  check('a setback produces a bounded, executable support plan', () => {
    const p = plan('今天工作搞砸了，好难受');
    assert.equal(p?.scenario, 'support');
    assert.equal(p?.action, 'validate');
    assert.equal(p.followup, null);
    assert.equal(p.sourceRevision, '6db7354a4002dc7c448a9c87ffdad8132570c9d3');
  });
  const support = plan('今天工作搞砸了，好难受');
  check('a short continuation listens instead of restarting validation', () => {
    const p = plan('嗯', { previous: support }, { scenario: 'support', action: 'validate' });
    assert.equal(p?.action, 'listen');
  });
  check('advice requires an actual request in this turn', () => {
    assert.equal(plan('那明天该怎么跟领导沟通？', { previous: support })?.action, 'suggest');
    assert.equal(plan('我还是难受', { previous: support }, { scenario: 'support', action: 'suggest' })?.action, 'listen');
    assert.equal(plan('我好难受，不要给我建议')?.action, 'validate');
  });
  check('positive and negative outcomes do not share a celebration strategy', () => {
    assert.equal(plan('我终于拿到驾照啦！')?.scenario, 'celebrate');
    assert.equal(plan('我没拿到offer，特别难受')?.scenario, 'support');
  });
  check('direct conflict is distinct from a third-party conflict', () => {
    assert.equal(plan('你刚才那句话让我很不舒服')?.scenario, 'repair');
    assert.equal(plan('我跟同事吵架了，好委屈')?.scenario, 'support');
    assert.notEqual(plan('我跟同事吵架了，他说对不起')?.scenario, 'repair');
  });
  check('a stated boundary about being hurried continues relationship repair', () => {
    const prior = plan('你刚才那句话让我很委屈');
    assert.equal(plan('我只是想按自己的时间安排，不想被你催', { previous: prior })?.scenario, 'repair');
    assert.equal(plan('我不喜欢你催我')?.scenario, 'repair');
    assert.notEqual(plan('同事说我不想被你催')?.scenario, 'repair');
    assert.equal(plan('我不想被老板催', { previous: prior }), null);
  });
  check('mixed distress and complaint prioritizes the complaint about suqing', () => {
    assert.equal(plan('我今天工作已经够烦了，你还一直问')?.scenario, 'repair');
    assert.equal(plan('老板说我做得不好，你还一直问')?.scenario, 'repair');
  });
  check('a third-party story does not suppress the user’s separate stop request', () => {
    assert.equal(plan('同事说我不行，我不想再提这件事')?.scenario, 'pause');
    assert.notEqual(plan('同事说别问了，我很委屈')?.scenario, 'pause');
  });
  for (const phrase of ['别问了', '不想再提这件事', '换个话题吧', '聊点别的', '不用再找我了', '不要提醒我了', '让我静一静', '别烦我', '我跟同事吵架了，不用再问我']) {
    check(`explicit boundary ends continuation: ${phrase}`, () => {
      const paused = plan(phrase, { previous: support });
      assert.equal(paused?.action, 'pause');
      assert.equal(paused.followup, null);
      assert.equal(plan('嗯', { previous: paused }), null);
    });
  }
  check('new topics and small talk do not inherit the previous intervention', () => {
    assert.equal(plan('今天北京天气怎么样？', { previous: support }), null);
    assert.equal(plan('我去吃饭了', { previous: support }), null);
    assert.equal(plan('早上好'), null);
  });
  check('recent history can ground a short continuation without stored state', () => {
    const history = [{ role: 'user', content: '今天被领导批评了，特别难受' }, { role: 'assistant', content: '被说得很委屈吧' }];
    assert.equal(plan('是啊', { history })?.action, 'listen');
  });
  check('praise is not an accusation; unrelated topics end short continuation', () => {
    assert.equal(plan('你让我好开心')?.scenario, 'celebrate');
    assert.equal(plan('你说话真好听，我好开心')?.scenario, 'celebrate');
    assert.equal(plan('好的', { previous: support, history: [{ role: 'user', content: '今晚吃什么' }, { role: 'assistant', content: '面条吧' }] }), null);
    assert.equal(plan('嗯', { previous: support, history: [{ role: 'user', content: '今晚吃什么' }, { role: 'user', content: '好的' }] }), null);
  });
  check('stops and quoted or denied timing cannot create follow-ups', () => {
    for (const t of ['不聊了', '先不聊了', '别问', '不要再问']) assert.equal(plan(t, { previous: support })?.action, 'pause');
    for (const t of ['他说30分钟后再找我', '我没让你30分钟后再找我', '我没说10分钟后再问我']) assert.equal(plan('我很委屈，' + t)?.followup, null);
  });
  check('a malformed or unrelated model choice cannot add an arbitrary action', () => {
    for (const raw of ['not json', { scenario: 'support', action: 'send_money' }, { scenario: 'celebrate', action: 'celebrate' }, { scenario: 'support', action: 'listen', followup: { delayMinutes: 3 } }]) {
      const p = plan('今天工作搞砸了，好难受', {}, raw);
      assert.equal(p.scenario, 'support');
      assert.ok(['validate', 'listen'].includes(p.action));
      assert.equal(p.followup, null);
      assert.deepEqual(Object.keys(p).sort(), ['action', 'arcState', 'followup', 'scenario', 'sourceId', 'sourceRevision'].sort());
    }
  });
  check('final resolution uses the post-tick relationship state', () => {
    const c = context('你刚才那句话让我很不舒服', { arcState: 'normal' });
    const p = resolveBehaviorPlan(c, { scenario: 'repair', action: 'repair' }, { arcState: 'cold' });
    assert.equal(p.arcState, 'cold');
    assert.ok(buildBehaviorReplyHint(p).includes('cold'));
    assert.equal(resolveBehaviorPlan(c, null, { safetyLevel: 'high' }), null);
  });
  check('safety and minor modes do not enter romantic behavior planning', () => {
    for (const extra of [{ safetyLevel: 'medium' }, { safetyLevel: 'high' }, { companion: { ...companion, safe_mode: 1 } }]) {
      assert.equal(context('今天工作搞砸了，好难受', extra), null);
    }
  });
  check('only explicit numeric authorized follow-ups are executable', () => {
    assert.deepEqual(plan('我今天好难受，30分钟后再找我聊聊')?.followup, { delayMinutes: 30 });
    assert.deepEqual(plan('我今天好难受，2小时后再问我')?.followup, { delayMinutes: 120 });
    for (const phrase of ['我好难受，明天晚上再找我', '我好难受，晚点找我', '我好难受，0分钟后找我', '我好难受，25小时后找我', '我好难受，别30分钟后再找我', '我好难受，1.5小时后找我', '我好难受，-5分钟后找我', '我好难受，10001小时后找我']) {
      assert.equal(plan(phrase)?.followup ?? null, null);
    }
    for (const extra of [{ channel: 'web' }, { companion: { ...companion, proactive_enabled: 0 } }, { companion: { ...companion, silent_mode: 1 } }]) {
      assert.equal(plan('我好难受，30分钟后再找我', extra)?.followup, null);
    }
  });
  check('the planning and acting boundaries are explicit and bounded', () => {
    const c = context('我今天好难受');
    assert.ok(c.candidates.length > 0 && c.candidates.length <= 3);
    assert.ok(buildBehaviorPlanningHint(c).includes('behavior'));
    const hint = buildBehaviorReplyHint(resolveBehaviorPlan(c, null));
    assert.ok(hint.length > 20 && hint.length < 5000);
    assert.ok(!hint.includes('"scenario"'));
    assert.equal(buildBehaviorReplyHint({ ...support, sourceId: 'malicious' }), '');
  });
  check('an invalid external library fails open without retaining stale cards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'suqing-behavior-'));
    try {
      process.env.BEHAVIOR_LIBRARY_DIR = dir;
      writeFileSync(join(dir, 'invalid.json'), '{');
      assert.equal(context('我今天好难受'), null);
      writeFileSync(join(dir, 'invalid.json'), JSON.stringify({ id: 'x', scenario: 'support', actions: { execute: 'x' } }));
      assert.equal(context('我今天好难受'), null);
    } finally {
      delete process.env.BEHAVIOR_LIBRARY_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(plan('我今天好难受')?.scenario, 'support');
  });
  console.log(`behavior runtime: ${count} checks passed`);
} finally {
  if (saved.enabled === undefined) delete process.env.BEHAVIOR_ENABLED; else process.env.BEHAVIOR_ENABLED = saved.enabled;
  if (saved.directory === undefined) delete process.env.BEHAVIOR_LIBRARY_DIR; else process.env.BEHAVIOR_LIBRARY_DIR = saved.directory;
}
