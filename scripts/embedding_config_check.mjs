import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'embedding-config-'));
process.env.DB_PATH = path.join(dir, 'bot.db');
process.env.LOG_DIR = path.join(dir, 'logs');
process.env.EMBEDDING_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'fixture-env-key';
process.env.EMBEDDING_MODEL = '';
process.env.EMBEDDING_DIM = '768';
const { getDb, setAppSetting } = await import('../src/db.mjs');
const embedding = await import('../src/providers/embedding.mjs');
const { embedText, getActiveEmbeddingProvider } = embedding;
const { saveCustomProviderConfig } = await import('../src/providers/custom.mjs');
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const logged = [];
console.log = (...parts) => { logged.push(parts.join(' ')); };
let calls = [];
function reset() {
  getDb().prepare('DELETE FROM app_settings').run();
  calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), ...options });
    return Response.json({ data: [{ embedding: Array(768).fill(0.1) }] });
  };
}
try {
  await test('invalid native credentials are unconfigured and blocked before any network call', async () => {
    for (const key of ['', 'ab用', 'bad key', 'line\nbreak', ' padded ', 'é-key']) {
      reset();
      setAppSetting('OPENAI_API_KEY', key);
      assert.equal(getActiveEmbeddingProvider().configured, false, 'invalid DB key must not fall back to env');
      assert.equal(await embedText('test memory'), null);
      assert.equal(calls.length, 0);
      const status = getActiveEmbeddingProvider();
      assert.ok(status.config_error?.code);
      assert.equal(status.health.state, 'blocked');
      if (key) assert.ok(!JSON.stringify(status).includes(key));
    }
    reset();
    setAppSetting('EMBEDDING_PROVIDER', 'gemini');
    setAppSetting('GEMINI_API_KEY', 'ab用');
    assert.equal(await embedText('test memory'), null);
    assert.equal(calls.length, 0, 'Gemini must validate before SDK request construction');
  });
  await test('native runtime reads database provider/key/model/dim overrides consistently', async () => {
    reset();
    setAppSetting('EMBEDDING_PROVIDER', 'qwen');
    setAppSetting('QWEN_API_KEY', 'fixture-db-key');
    setAppSetting('EMBEDDING_MODEL', 'text-embedding-v3');
    setAppSetting('EMBEDDING_DIM', '256');
    globalThis.fetch = async (url, options) => {
      calls.push({ url, ...options });
      return Response.json({ data: [{ embedding: Array(256).fill(0.25) }] });
    };
    assert.equal(getActiveEmbeddingProvider().model, 'text-embedding-v3');
    assert.equal(getActiveEmbeddingProvider().dim, 256);
    assert.equal((await embedText('hello')).length, 256);
    assert.equal(calls[0].headers.Authorization, 'Bearer fixture-db-key');
    assert.match(calls[0].url, /dashscope/);
    assert.deepEqual(JSON.parse(calls[0].body), { model: 'text-embedding-v3', input: 'hello', dimensions: 256 });
    assert.equal(getActiveEmbeddingProvider().health.state, 'ok');
    setAppSetting('QWEN_API_KEY', 'new-valid-fixture-key');
    assert.equal(getActiveEmbeddingProvider().health.state, 'unverified', 'changing key invalidates success');
  });
  await test('Gemini SDK uses resolved key/model/output dimensionality and validates its response', async () => {
    reset();
    setAppSetting('EMBEDDING_PROVIDER', 'gemini');
    setAppSetting('GEMINI_API_KEY', 'fixture-google-key');
    setAppSetting('EMBEDDING_MODEL', 'gemini-embedding-001');
    setAppSetting('EMBEDDING_DIM', '256');
    globalThis.fetch = async (url, options) => {
      calls.push({ url, ...options });
      return Response.json({ embedding: { values: Array(256).fill(0.5) } });
    };
    assert.equal((await embedText('hello gemini')).length, 256);
    assert.match(String(calls[0].url), /models\/gemini-embedding-001:embedContent$/);
    assert.equal(calls[0].headers.get('x-goog-api-key'), 'fixture-google-key');
    const body = JSON.parse(calls[0].body);
    assert.equal(body.outputDimensionality, 256);
    assert.equal(body.content.parts[0].text, 'hello gemini');
    assert.equal(getActiveEmbeddingProvider().health.state, 'ok');
  });
  await test('unknown provider and invalid native dimension/model fail closed', async () => {
    for (const [key, value] of [['EMBEDDING_PROVIDER', 'unknown'], ['EMBEDDING_DIM', '-1'], ['EMBEDDING_DIM', '0'],
      ['EMBEDDING_DIM', '1.5'], ['EMBEDDING_DIM', 'NaN'], ['EMBEDDING_MODEL', 'bad\nmodel']]) {
      reset(); setAppSetting(key, value);
      assert.equal(getActiveEmbeddingProvider().configured, false, `${key}=${value}`);
      assert.equal(await embedText('memory'), null);
      assert.equal(calls.length, 0);
    }
  });
  await test('native response must be finite, nonzero and exact length; no silent truncation', async () => {
    for (const vector of [[], [1, 2], Array(769).fill(1), Array(768).fill(null), Array(768).fill(0)]) {
      reset();
      globalThis.fetch = async () => Response.json({ data: [{ embedding: vector }] });
      assert.equal(await embedText('memory'), null);
      assert.equal(getActiveEmbeddingProvider().health.state, 'error');
    }
  });
  await test('upstream failures expose safe codes and counts without response/error/key contents', async () => {
    reset();
    const secret = 'SENSITIVE_UPSTREAM_MARKER';
    setAppSetting('OPENAI_API_KEY', secret);
    globalThis.fetch = async () => new Response(secret, { status: 401 });
    assert.equal(await embedText('private conversation'), null);
    let status = getActiveEmbeddingProvider();
    assert.equal(status.configured, true, 'syntactically valid does not imply remote authentication success');
    assert.equal(status.health.state, 'error');
    assert.equal(status.health.failures, 1);
    assert.equal(status.health.last_error.code, 'http_401');
    globalThis.fetch = async () => { throw new Error(secret); };
    assert.equal(await embedText('private conversation'), null);
    status = getActiveEmbeddingProvider();
    assert.equal(status.health.failures, 2);
    assert.ok(!JSON.stringify(status).includes(secret));
    assert.ok(!logged.join('\n').includes(secret));
    assert.ok(!logged.join('\n').includes('private conversation'));
  });
  await test('custom vectors keep complete dimensions and report validated request success', async () => {
    reset();
    saveCustomProviderConfig('embedding', { base_url: 'https://fixture.invalid/v1', api_key: 'fixture-custom-key', model: 'fixture' });
    const vector = Array(1536).fill(0.5);
    globalThis.fetch = async () => Response.json({ data: [{ embedding: vector }] });
    assert.equal(getActiveEmbeddingProvider().dim, null);
    assert.deepEqual(await embedText('memory'), vector);
    assert.equal(getActiveEmbeddingProvider().health.state, 'ok');
  });
  await test('explicit probe checks selected provider and validates real returned vector', async () => {
    reset();
    assert.equal(typeof embedding.testEmbeddingProvider, 'function');
    await assert.rejects(() => embedding.testEmbeddingProvider('qwen'), /保存|当前/);
    assert.equal(calls.length, 0);
    const probe = await embedding.testEmbeddingProvider('openai');
    assert.equal(probe.ok, true);
    assert.equal(probe.dim, 768);
    assert.equal(getActiveEmbeddingProvider().health.state, 'ok');
  });
} finally {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  getDb().close();
  // logger owns its stream until process exit; defer deletion of its temporary directory.
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
}
