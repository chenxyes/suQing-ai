import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(tmpdir(), 'custom-provider-'));
const env = { ...process.env, DB_PATH: path.join(temp, 'bot.db'), LOG_DIR: path.join(temp, 'logs'), AUTH_SECRET: 'test-only-secret-'.repeat(4), AUTH_MODE: 'local', HOSTED_MODE: 'false', IMAGE_BEAUTIFY_ENABLED: 'false' };
Object.assign(process.env, env);
const caps = ['vision', 'asr', 'tts', 'image', 'embedding'];
const seen = [];
let failureStatus = 0, imageUrl = false;
const relay = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  seen.push({ path: req.url, auth: req.headers.authorization, body, type: req.headers['content-type'] });
  if (failureStatus) { res.writeHead(failureStatus); res.end('private-upstream-secret'); return; }
  if (req.url.endsWith('/audio/speech')) { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(Buffer.alloc(64, 1)); return; }
  res.setHeader('content-type', 'application/json');
  const value = req.url.endsWith('/chat/completions') ? { choices: [{ message: { content: 'vision ok' } }] }
    : req.url.endsWith('/audio/transcriptions') ? { text: 'asr ok' }
    : req.url.endsWith('/images/generations') ? { data: [imageUrl ? { url: 'https://example.com/image.png' } : { b64_json: 'cG5n' }] }
    : { data: [{ embedding: [0.1, 0.2, 0.3] }] };
  res.end(JSON.stringify(value));
});
await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
// Reserve an ephemeral API port, then release it immediately before spawning.
const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const child = spawn(process.execPath, ['--input-type=module', '-e', 'const {startApiServer}=await import("./src/api.mjs");startApiServer();'], { cwd: root, env: { ...env, API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let childOutput = ''; child.stdout.on('data', b => childOutput += b); child.stderr.on('data', b => childOutput += b);
let token = '', db;
async function api(route, body, authed = true) {
  const r = await fetch(`http://127.0.0.1:${port}/api/setup/${route}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(authed && token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await api('status')).status === 200) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 50)); }
  assert.ok(ready, childOutput);
  const account = await api('local-account', { username: 'relaytest', password: 'fixture-password' });
  assert.equal(account.status, 201, JSON.stringify(account)); token = account.body.token;
  assert.equal((await api('provider-config', { capability: 'vision', provider: 'custom' }, false)).status, 401);
  const dbModule = await import('../src/db.mjs'); db = dbModule.getDb();
  for (const cap of caps) {
    const config = { capability: cap, provider: 'custom', base_url: `http://127.0.0.1:${relay.address().port}/v1/${cap}/`, model: `${cap}-relay-model`, api_key: `test-${cap}-independent-key`, voice_id: 'custom-voice' };
    const save = await api('provider-config', config); assert.equal(save.body.ok, true, JSON.stringify(save));
    assert.equal(dbModule.getAppSetting(`${cap.toUpperCase()}_BASE_URL`), config.base_url.replace(/\/$/, ''), `${cap} saved base URL`);
    const status = (await api('provider-status')).body.data;
    assert.equal(status[cap].active, 'custom');
    assert.equal(status[cap].providers?.custom?.base_url || status[cap].custom?.base_url, config.base_url.replace(/\/$/, ''));
    assert.ok(!JSON.stringify(status).includes(config.api_key));
    assert.equal((await api('provider-config', { ...config, api_key: '' })).body.ok, true);
    assert.equal(dbModule.getAppSetting(`${cap.toUpperCase()}_API_KEY`), config.api_key);
    const before = db.prepare('SELECT key,value FROM app_settings ORDER BY key').all();
    for (const invalid of [{ base_url: 'https://user:pass@example.com/v1' }, { api_key: '中文占位密钥' }, { base_url: 'https://example.com/v1?key=secret' }, { model: '' }]) {
      assert.equal((await api('provider-config', { ...config, ...invalid })).body.ok, false, `${cap} rejects invalid config`);
      assert.deepEqual(db.prepare('SELECT key,value FROM app_settings ORDER BY key').all(), before, 'invalid config must not partially persist');
    }
    const probe = await api('test-provider', { capability: cap, provider: 'custom' }); assert.equal(probe.body.data?.ok, true, JSON.stringify(probe));
  }
  const anonymous = await api('provider-status', undefined, false);
  assert.ok(!JSON.stringify(anonymous.body).includes('127.0.0.1'), 'anonymous must not see private URLs');
  // Conflicting environment values must not override values saved in the settings UI.
  for (const cap of caps) { process.env[`${cap.toUpperCase()}_PROVIDER`] = 'openai'; process.env[`${cap.toUpperCase()}_BASE_URL`] = 'https://invalid.example/v1'; }
  const { visionRecognize } = await import('../src/providers/vision.mjs');
  const { asrRecognize } = await import('../src/providers/asr.mjs');
  const { ttsSynthesize } = await import('../src/providers/tts.mjs');
  const { imageGenerate } = await import('../src/providers/image.mjs');
  const { embedText } = await import('../src/providers/embedding.mjs');
  assert.equal(await visionRecognize(Buffer.from('fixture')), 'vision ok');
  assert.equal(await asrRecognize(Buffer.from('fixture'), 'audio/wav'), 'asr ok');
  assert.equal((await ttsSynthesize('hello')).audio.length, 64);
  assert.equal(await imageGenerate('hello'), 'data:image/png;base64,cG5n');
  imageUrl = true; assert.equal(await imageGenerate('hello'), 'https://example.com/image.png');
  assert.deepEqual(await embedText('hello'), [0.1, 0.2, 0.3]);
  assert.equal((await import('../src/photo_planner.mjs')).isImageProviderConfigured(), true);
  for (const req of seen) {
    const cap = req.path.split('/')[2]; assert.ok(caps.includes(cap));
    assert.equal(req.auth, `Bearer test-${cap}-independent-key`);
    if (cap === 'asr') { assert.match(req.type, /multipart\/form-data/); assert.ok(req.body.includes('asr-relay-model')); }
    else assert.equal(JSON.parse(req.body).model, `${cap}-relay-model`);
  }
  failureStatus = 503;
  const fail = await api('test-provider', { capability: 'image', provider: 'custom' });
  assert.equal(fail.body.ok, false); assert.ok(!JSON.stringify(fail).includes('private-upstream-secret'));
  console.log('custom providers: authenticated save/status/probe, independent runtime endpoints, secret handling, atomic validation and photo gate passed');
} finally {
  child.kill('SIGTERM'); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve));
  db?.close(); rmSync(temp, { recursive: true, force: true });
}
