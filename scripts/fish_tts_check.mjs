import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'fish-tts-'));
mkdirSync(path.join(dir, 'logs'));
writeFileSync(path.join(dir, 'logs', 'bot.log'), '');
Object.assign(process.env, {
  DB_PATH: path.join(dir, 'bot.db'),
  LOG_DIR: path.join(dir, 'logs'),
  TTS_PROVIDER: 'fish',
  TTS_MODEL: '  s2.1-pro-free  ',
  TTS_VOICE_ID: ' voice-fixture ',
  FISH_API_KEY: 'fish-secret-fixture',
});

let requests = [];
let responseMode = 'audio';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  if (responseMode === 'http-error') return new Response('PRIVATE_UPSTREAM_ERROR', { status: 402 });
  if (responseMode === 'empty') return new Response(Buffer.alloc(0), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  if (responseMode === 'wrong-content-type') return new Response('not audio', { status: 200, headers: { 'content-type': 'application/json' } });
  if (responseMode === 'timeout') return await new Promise((resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(options.signal.reason || new Error('aborted')), { once: true });
  });
  return new Response(Buffer.alloc(128, 7), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
};

try {
  const { getAppSetting, setAppSetting } = await import('../src/db.mjs');
  const { getTtsStatus, ttsSynthesize } = await import('../src/providers/tts.mjs');

  assert.equal(getTtsStatus().active, 'fish');
  assert.equal(getTtsStatus().configured, true);
  const result = await ttsSynthesize('你好', { speed: 1.2 });
  assert.equal(result.format, 'mp3');
  assert.equal(result.audio.length, 128);
  assert.equal(requests[0].url, 'https://api.fish.audio/v1/tts');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fish-secret-fixture');
  assert.equal(requests[0].options.headers.model, 's2.1-pro-free');
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body, {
    text: '你好',
    reference_id: 'voice-fixture',
    format: 'mp3',
    prosody: { speed: 1.2 },
    normalize: true,
    latency: 'normal',
  });
  assert.ok(!('input' in body));
  assert.ok(!('voice' in body));

  setAppSetting('TTS_VOICE_ID', '', { secret: 0 });
  requests = [];
  await ttsSynthesize('默认声音');
  const optionalBody = JSON.parse(requests[0].options.body);
  assert.ok(!('reference_id' in optionalBody));

  process.env.FISH_API_KEY = '';
  assert.equal(getTtsStatus().configured, false);
  process.env.FISH_API_KEY = 'fish-secret-fixture';
  assert.equal(getTtsStatus().configured, true);

  for (const mode of ['http-error', 'empty', 'wrong-content-type', 'timeout']) {
    responseMode = mode;
    await assert.rejects(() => ttsSynthesize('失败测试', mode === 'timeout' ? { timeoutMs: 10 } : {}), error => {
      assert.ok(!error.message.includes('PRIVATE_UPSTREAM_ERROR'));
      return true;
    });
  }

  assert.equal(getAppSetting('TTS_VOICE_ID'), '');
  console.log('fish tts: native request, optional reference_id, status and safe failures passed');
} finally {
  globalThis.fetch = originalFetch;
  try { (await import('../src/db.mjs')).getDb().close(); } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
  rmSync(dir, { recursive: true, force: true });
}
