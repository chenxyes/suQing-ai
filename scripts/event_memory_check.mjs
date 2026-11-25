import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashMemoryContent } from '../src/memory_vectors.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'event-memory-'));
process.env.DB_PATH = path.join(tmp, 'bot.db');
process.env.LOG_DIR = tmp;
globalThis.fetch = async () => {
  throw Error('unexpected network');
};
const m = await import('../src/db.mjs');
const { updateEventsFromTurn, checkFollowup, followupStillCurrent } = await import('../src/event_memory.mjs');
const db = m.getDb();
db.pragma('foreign_keys = OFF');
const c = { id: 71, user_id: 51, memory_enabled: 1 };
db.prepare('INSERT INTO companions(id,user_id,bot_id) VALUES(?,?,?)').run(c.id, c.user_id, 'fixture');
const day = m.shanghaiDateKey();
const add = (title, dueAt = day) =>
  m.saveOpenLoop({ companionId: c.id, title, loopKind: 'appointment', dueAt });
const turn = (text) => m.saveConversationTurn(c.id, 'user', text);
const get = (id) => db.prepare('SELECT * FROM companion_open_loops WHERE id=?').get(id);
const fixtureVector = async (text) => ({
  vector: [1, 0],
  contentHash: hashMemoryContent(text),
  descriptor: { version: 1, provider: 'fixture', model: 'test', dimension: 2, endpointId: 'a'.repeat(64) },
});
const deps = (response, matches = []) => ({
  embed: fixtureVector,
  judge: async (_sys, json) => {
    return JSON.stringify(JSON.parse(json).candidates ? { matches } : response);
  },
});
let passed = 0;
async function check(name, fn) {
  await fn();
  console.log('ok', ++passed, name);
}
try {
  const a = add('约了晚上一起吃KFC'),
    b = add('约了放学先去逛，逛完一起去KFC');
  const next = add('约了晚上一起吃KFC', '2099-12-31');
  turn('历史边界之前的消息');
  const row = turn('逛完去KFC我可记得去了');
  const change = (id, state, t) => ({ id, state, turn: t.id, quote: t.content });
  // Legacy rows have no source id. This revocation predates both the plans and their evidence.
  db.prepare(
    "INSERT INTO memory_recall_barriers(companion_id,user_id,revision,revoked_at,turn_id_cutoff) VALUES(?,?,1,'2000-01-01',1)",
  ).run(c.id, String(c.user_id));
  await check('同一次的两种说法共同结案并记录来源；不同日期保留', async () => {
    await updateEventsFromTurn(c, row.id, deps({ changes: [change(b, 'completed', row)] }, [a, next]));
    for (const id of [a, b]) {
      assert.equal(get(id).status, 'resolved');
      assert.equal(get(id).resolved_turn_id, row.id);
    }
    assert.equal(get(next).status, 'open');
  });
  await check('主动核验能在没有向量时找回多轮前的用户证据，旧事件不会发送', async () => {
    db.prepare("UPDATE companion_open_loops SET status='open',resolved_turn_id=NULL WHERE id IN (?,?)").run(
      a,
      b,
    );
    for (let i = 0; i < 20; i++) turn('今天话题换成了音乐');
    const result = await checkFollowup(c, get(a), {
      embed: async () => {
        throw Error('offline');
      },
      judge: async (_s, json) => {
        const p = JSON.parse(json);
        if (p.candidates) return '{"matches":[]}';
        assert.ok(p.turns.some((t) => t.id === row.id));
        return JSON.stringify({ changes: [change(a, 'completed', row), change(b, 'completed', row)] });
      },
    });
    assert.equal(result, null);
    assert.equal(get(a).status, 'resolved');
    assert.equal(get(b).status, 'resolved');
  });
  await check('待办未发生、证据错误、引用助手原话均不得结案', async () => {
    for (const text of ['还没吃，晚些再说', '等吃完饭再去店里', '准备去吃饭']) {
      const t = turn(text);
      await updateEventsFromTurn(c, t.id, deps({ changes: [change(next, 'completed', t)] }));
    }
    const t = turn('晚上再看');
    await updateEventsFromTurn(
      c,
      t.id,
      deps({ changes: [{ ...change(next, 'completed', t), quote: '我吃过了' }] }),
    );
    const bot = m.saveConversationTurn(c.id, 'assistant', '那你已经吃完了');
    await updateEventsFromTurn(c, bot.id, deps({ changes: [change(next, 'completed', bot)] }));
    assert.equal(get(next).status, 'open');
  });
  await check('新安排建向量；同次改述及重试不再建项；取消保留证据', async () => {
    const t = turn('周末我们约去公园散步');
    const item = { title: '周末相约逛公园', due_at: '2099-01-02', kind: 'date', quote: t.content };
    await updateEventsFromTurn(c, t.id, deps({ changes: [], create: [item] }));
    const plan = db.prepare('select * from companion_open_loops where source_message_id=?').get(String(t.id));
    assert.ok(plan.embedding?.length && plan.embedding_meta);
    await updateEventsFromTurn(c, t.id, deps({ changes: [], create: [item] }));
    const repeat = turn('说好了，周末公园见');
    const variant = { ...item, title: '约好周末公园见面', quote: repeat.content };
    await updateEventsFromTurn(c, repeat.id, deps({ changes: [], create: [variant] }, [plan.id]));
    assert.equal(
      db.prepare('select count(*) n from companion_open_loops where due_at=?').get(item.due_at).n,
      1,
    );
    const cancel = turn('那天公园就不去了');
    await updateEventsFromTurn(c, cancel.id, deps({ changes: [change(plan.id, 'cancelled', cancel)] }));
    assert.equal(get(plan.id).status, 'dismissed');
    assert.equal(get(plan.id).resolved_turn_id, cancel.id);
  });
  await check('有用户证据才可追问；新回复使已生成的追问失效', async () => {
    const pending = turn('这周末会去，我们还在准备');
    const token = await checkFollowup(c, get(next), deps({ changes: [change(next, 'planned', pending)] }));
    assert.equal(token, pending.id);
    assert.ok(followupStillCurrent(c.id, next, token));
    turn('行程变了');
    assert.equal(followupStillCurrent(c.id, next, token), false);
    assert.equal(await checkFollowup(c, get(next), { embed: async () => null, judge: async () => '{}' }), null);
    assert.equal(
      await checkFollowup(c, get(next), {
        embed: async () => null,
        judge: async () => {
          throw Error('offline');
        },
      }),
      null,
    );
  });
  await check('撤回屏障和未验证导入的消息不能作为证据', async () => {
    const imported = turn('已经去了');
    db.prepare('update companion_conversation_turns set import_unverified=1 where id=?').run(imported.id);
    await updateEventsFromTurn(c, imported.id, deps({ changes: [change(next, 'completed', imported)] }));
    const rev = turn('去过了');
    const options = deps({ changes: [change(next, 'completed', rev)] });
    const decide = options.judge;
    options.judge = async (...args) => {
      db.prepare(
        'insert or replace into memory_recall_barriers(companion_id,user_id,revision,revoked_at,turn_id_cutoff) values(?,?,1,CURRENT_TIMESTAMP,?)',
      ).run(c.id, String(c.user_id), rev.id);
      return decide(...args);
    };
    await updateEventsFromTurn(c, rev.id, options);
    assert.equal(m.getMemoryRecallBarrier(c.id, c.user_id).turn_id_cutoff, rev.id);
    assert.equal(get(next).status, 'open');
  });
} finally {
  await new Promise((resolve) => setTimeout(resolve, 5));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
