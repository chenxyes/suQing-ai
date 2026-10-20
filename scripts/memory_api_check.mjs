import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const temp = mkdtempSync(path.join(tmpdir(), 'memory-api-'));
Object.assign(process.env, { DB_PATH: path.join(temp, 'db.sqlite'), LOG_DIR: path.join(temp, 'logs'),
  AUTH_SECRET: 'memory-fixture-secret-'.repeat(4), AUTH_MODE: 'local', HOSTED_MODE: 'false', SINGLE_USER: 'false' });
const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const child = spawn(process.execPath, ['--input-type=module', '-e', 'const {startApiServer}=await import("./src/api.mjs");startApiServer();'],
  { cwd: root, env: { ...process.env, API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', token = '', db;
child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
async function request(route, method = 'GET', body = undefined) {
  const res = await fetch(`http://127.0.0.1:${port}/api/${route}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await request('setup/status')).status === 200) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, output);
  const account = await request('setup/local-account', 'POST', { username: 'memorytest', password: 'fixture-password' });
  assert.equal(account.status, 201); token = account.body.token;
  const m = await import('../src/db.mjs'); db = m.getDb();
  const uid = db.prepare('SELECT id FROM user_accounts WHERE username=?').get('memorytest').id;
  db.prepare('INSERT OR IGNORE INTO users(id,wechat_user_id) VALUES (?,?)').run(uid, 'fixture-wechat');
  const cid = Number(db.prepare("INSERT INTO companions(user_id,bot_id,name) VALUES (?,'fixture-bot','测试角色')").run(uid).lastInsertRowid);
  const id = m.saveMemory({ companionId: cid, userId: uid, memoryType: 'fact', content: '旧记录', memoryLayer: 'user_fact' });
  m.softDeleteMemory(id, cid);
  const route = `companions/${cid}/memories`;
  const secret = '密码是：synthetic-private-marker';
  const rejected = await request(route, 'POST', { content: secret, memory_layer: 'emotion' });
  assert.equal(rejected.status, 400, 'privacy rejection must be reported, not create success');
  assert.ok(!JSON.stringify(rejected).includes(secret));
  const previous = db.prepare('SELECT * FROM companion_memories WHERE id=?').get(id);
  assert.equal(previous.memory_status, 'deleted', 'rejected create cannot resurrect previous last row');
  assert.equal(previous.memory_layer, 'user_fact');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_relations WHERE companion_id=?').get(cid).n, 0);
  const create = await request(route, 'POST', { content: '电话13812345678', memory_layer: 'user_fact' });
  assert.equal(create.status, 201);
  assert.ok(!JSON.stringify(create).includes('13812345678'), 'response must use stored redacted content');
  const newId = db.prepare('SELECT MAX(id) AS id FROM companion_memories WHERE companion_id=?').get(cid).id;
  assert.equal((await request(`${route}/${newId}`, 'PUT', { content: secret })).status, 400);
  assert.ok(!db.prepare('SELECT content FROM companion_memories WHERE id=?').get(newId).content.includes(secret));
  const before = m.getMemoryRecallBarrier(cid,uid).revision;
  assert.equal((await request(route, 'DELETE')).status, 200);
  assert.ok(m.getMemoryRecallBarrier(cid,uid).revision > before, 'bulk clear must record recall barrier');
  const all = await request(`${route}?status=all`);
  assert.equal(all.body.data.total, 2, 'management keeps both soft-deleted rows');
  m.upsertUserProfile(uid,cid,{ notes: '撤销前的画像标记' });
  const prompt = await request(`companions/${cid}/prompt`);
  assert.ok(!prompt.body.data.prompt.includes('撤销前的画像标记'), 'debug prompt follows the same profile recall gate');
  console.log('memory API: rejected create/update, no resurrection, redaction, bulk barrier, management and prompt gate passed');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  db?.close(); rmSync(temp, { recursive: true, force: true });
}
