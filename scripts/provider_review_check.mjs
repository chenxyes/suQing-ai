import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const dir = mkdtempSync(path.join(tmpdir(), 'provider-review-'));
process.env.DB_PATH = path.join(dir, 'bot.db');
process.env.LOG_DIR = path.join(dir, 'logs');
const { getDb, deleteAppSetting } = await import('../src/db.mjs');
const { embedText, getActiveEmbeddingProvider } = await import('../src/providers/embedding.mjs');
const { getActiveImageProvider } = await import('../src/providers/image.mjs');
const { testCustomProvider, saveCustomProviderConfig } = await import('../src/providers/custom.mjs');
const realFetch = globalThis.fetch;
try {
  await test('custom embedding keeps full vectors; existing comparison rejects unequal dimensions', async () => {
    saveCustomProviderConfig('embedding', { base_url: 'https://fixture.invalid/v1', api_key: 'fixture', model: 'fixture' });
    for (const dimensions of [768, 1536, 3072]) {
      const vector = Array.from({ length: dimensions }, (_, i) => (i + 1) / dimensions);
      globalThis.fetch = async () => Response.json({ data: [{ embedding: vector }] });
      assert.deepEqual(await embedText('fixture'), vector);
    }
    const source = readFileSync(new URL('../src/db.mjs', import.meta.url), 'utf8');
    const cosine = vm.runInNewContext(`(${/function cosineSimilarity\([\s\S]*?\n\}/.exec(source)[0]})`);
    assert.equal(cosine([1, 1], [1, 1, 1]), 0, 'mismatched dimensions must not compare a common prefix');
    assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-10);
  });
  await test('ASR probe sends usable spoken WAV and checks transcription', async () => {
    saveCustomProviderConfig('asr', { base_url: 'https://fixture.invalid/v1', api_key: 'fixture', model: 'fixture' });
    let responseText = 'Hello, this is a speech recognition test.';
    globalThis.fetch = async (_url, options) => {
      const wav = Buffer.from(await options.body.get('file').arrayBuffer());
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
      let format, pcm;
      for (let offset = 12; offset + 8 <= wav.length;) {
        const size = wav.readUInt32LE(offset + 4), name = wav.toString('ascii', offset, offset + 4);
        const chunk = wav.subarray(offset + 8, offset + 8 + size);
        if (name === 'fmt ') format = chunk;
        if (name === 'data') pcm = chunk;
        offset += 8 + size + (size % 2);
      }
      assert.equal(format.readUInt16LE(0), 1);
      assert.equal(format.readUInt16LE(2), 1);
      assert.equal(format.readUInt16LE(14), 16);
      assert.ok(pcm.length / format.readUInt32LE(8) >= 2, 'probe audio must last at least two seconds');
      assert.ok(pcm.some(value => value !== 0), 'probe must not be silent');
      return Response.json({ text: responseText });
    };
    assert.equal((await testCustomProvider('asr')).ok, true);
    for (responseText of ['', 'unrelated words']) await assert.rejects(testCustomProvider('asr'), /transcription/i);
  });
  await test('native provider status follows runtime credentials and required model', () => {
    for (const capability of ['image', 'embedding']) {
      const getter = capability === 'image' ? getActiveImageProvider : getActiveEmbeddingProvider;
      const prefix = capability.toUpperCase(); deleteAppSetting(`${prefix}_PROVIDER`);
      const providers = capability === 'image'
        ? { zhipu: 'ZHIPU_API_KEY', qwen: 'QWEN_API_KEY', doubao: 'DOUBAO_API_KEY', wenxin: 'WENXIN_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY', '302ai': 'AI302_API_KEY' }
        : { gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', zhipu: 'ZHIPU_API_KEY', qwen: 'QWEN_API_KEY' };
      process.env.DASHSCOPE_API_KEY = '';
      for (const [provider, key] of Object.entries(providers)) {
        process.env[`${prefix}_PROVIDER`] = provider; process.env[key] = ''; process.env[`${prefix}_MODEL`] = 'fixture-model';
        assert.equal(getter().configured, false, `${capability}/${provider} missing key`);
        process.env[key] = 'fixture-key'; assert.equal(getter().configured, true, `${capability}/${provider} configured`);
      }
      process.env[`${prefix}_PROVIDER`] = 'unknown'; assert.equal(getter().configured, false);
    }
    process.env.IMAGE_PROVIDER = 'doubao'; process.env.IMAGE_MODEL = '';
    assert.equal(getActiveImageProvider().configured, false, 'Doubao requires endpoint ID');
    process.env.IMAGE_PROVIDER = 'qwen'; process.env.QWEN_API_KEY = ''; process.env.DASHSCOPE_API_KEY = 'fixture-key';
    assert.equal(getActiveImageProvider().configured, true, 'image accepts DashScope fallback key');
  });
} finally {
  globalThis.fetch = realFetch; getDb().close(); rmSync(dir, { recursive: true, force: true });
}
