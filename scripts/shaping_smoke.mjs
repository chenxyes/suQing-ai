/**
 * shaping_smoke.mjs — 共建独特性（教她 / 专属梗 / 塑造留痕）护栏
 * 用独立临时 DB 跑 detectTeaching 准确性 + 端到端读写/注入。
 * 跑：node scripts/shaping_smoke.mjs
 */
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';

const TMP = `/tmp/shaping_smoke_${Date.now()}.db`;
process.env.DB_PATH = TMP;
const sh = await import('../src/shaping.mjs');
const dbm = await import('../src/db.mjs');
dbm.getDb().pragma('foreign_keys = OFF');

let pass = 0, fail = 0;
const ck = (n, c) => c ? pass++ : (fail++, console.error('  ✗', n));

// 1) detectTeaching 准确性（含反例不误判）
const dcases = [
  ['以后叫我老大', 'nickname'], ['喊我哥', 'nickname'], ['你说话皮一点', 'style'],
  ['别太正经放开点', 'style'], ['少发表情包', 'style'], ['我不吃香菜', 'taboo'],
  ['我最烦别人迟到', 'taboo'], ['别叫我宝', 'taboo'], ['答应我别查岗', 'pact'],
  ['我们说好不冷战', 'pact'], ['我是程序员', 'fact'],
  // 真实 token 压测挖出的回归用例
  ['我对花生过敏你记住', 'taboo'], ['我属狗的别忘了', 'fact'], ['咱俩约定好每天都要说晚安', 'pact'],
  ['今天天气不错', null], ['他叫我去开会', null], ['你叫我等一下', null], ['', null], ['哈哈哈你真可爱', null],
  ['你过敏吗', null], ['他属狗', null],
];
for (const [t, k] of dcases) {
  const r = sh.detectTeaching(t);
  ck(`detect ${JSON.stringify(t)} → ${k}`, k === null ? r.length === 0 : r.some(x => x.kind === k));
}

const feedback = `嗯嗯
坏例子：你吃早饭了没呀，别又随便糊弄一口
好例子：吃早饭了吗？

坏例子：别熬夜了，对身体不好哦
好例子：现在 12 点了，要睡吗？`;
const rules = sh.detectTeaching(feedback);
assert.deepEqual(rules.map(rule => rule.kind), ['style']);
const correctionHint = sh.buildShapingPromptHint(rules);
for (const text of ['吃早饭了吗？', '现在 12 点了，要睡吗？']) assert.ok(correctionHint.includes(text));
for (const text of ['糊弄一口', '身体不好哦']) assert.ok(!correctionHint.includes(text));

for (const text of ['不允许再任何话后面跟 别xxxx\n是不允许 禁止🚫', '不要在每句话后面加“别……”']) {
  assert.equal(sh.detectTeaching(text)[0]?.kind, 'pact');
}
for (const text of ['昨天他在最后跟我说别走', '不要在每句话后面加别致的表情', '老师给我的作文批注是：\n坏例子：以后叫我老大\n好例子：早安',
  '坏例子：以后叫我老大', '好例子：以后叫我老大']) assert.deepEqual(sh.detectTeaching(text), []);
assert.deepEqual(sh.detectTeaching('以后叫我老大'), [{ kind: 'nickname', content: '老大' }]);

// 2) 端到端：教她 → 写库 → singleton 覆盖 → 去重 → 注入
const cid = 993001;
for (const t of sh.detectTeaching('以后叫我老大')) dbm.upsertShaping({ companionId: cid, kind: t.kind, content: t.content });
dbm.upsertShaping({ companionId: cid, kind: 'taboo', content: '不吃香菜' });
dbm.upsertShaping({ companionId: cid, kind: 'pact', content: '别查岗' });
dbm.upsertShaping({ companionId: cid, kind: 'nickname', content: '宝' });        // singleton 应覆盖"老大"
dbm.upsertShaping({ companionId: cid, kind: 'taboo', content: '不吃香菜' });      // UNIQUE 去重
const list = dbm.listShaping(cid);
ck('nickname singleton(只留最新"宝")', list.filter(x => x.kind === 'nickname').length === 1 && list.find(x => x.kind === 'nickname').content === '宝');
ck('taboo 去重(1 条)', list.filter(x => x.kind === 'taboo').length === 1);
ck('pact 累积', list.filter(x => x.kind === 'pact').length === 1);
const hint = sh.buildShapingPromptHint(list);
ck('注入 hint 含 宝/香菜/别查岗', hint.includes('宝') && hint.includes('香菜') && hint.includes('别查岗'));
ck('lexicon 注入', sh.buildShapingPromptHint([{ kind: 'lexicon', content: '摸鱼三连' }]).includes('摸鱼三连'));
ck('空输入不崩', sh.buildShapingPromptHint([]) === '' && sh.buildShapingConfirmHint([]) === '');
ck('deleteShaping 生效', (dbm.deleteShaping(cid, list[0].id), dbm.listShaping(cid).length === list.length - 1));

try { unlinkSync(TMP); } catch {}
console.log(`\nshaping_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
