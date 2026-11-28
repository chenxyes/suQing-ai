/** Independent OpenAI-compatible endpoints for optional model capabilities. */
import { readFile } from 'node:fs/promises';
import { getAppSetting, getDb, setAppSetting } from '../db.mjs';
import { log } from '../logger.mjs';
export const CUSTOM_CAPABILITIES = ['vision', 'asr', 'tts', 'image', 'embedding'];
export function readProviderSetting(key) {
  const stored = getAppSetting(key);
  return stored !== undefined && stored !== null ? String(stored) : process.env[key] || '';
}
function prefixFor(capability) {
  const cap = String(capability).toLowerCase();
  if (!CUSTOM_CAPABILITIES.includes(cap)) throw new Error('Unknown custom capability');
  return cap.toUpperCase();
}
export function validateCustomConfig({ baseURL, apiKey, model }) {
  let url;
  try { url = new URL(baseURL); } catch { throw new Error('Base URL 必须是完整的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 只允许 HTTP(S)，不能包含用户名、密码、查询参数或片段');
  }
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]+$/.test(apiKey)) throw new Error('API Key 不能为空，且只能包含无空白的 ASCII 字符');
  if (typeof model !== 'string' || !model.trim() || /[\x00-\x1f\x7f]/.test(model)) throw new Error('Model 不能为空或包含控制字符');
  return { baseURL: url.toString().replace(/\/+$/, ''), apiKey, model: model.trim() };
}
export function customConfig(capability) {
  const p = prefixFor(capability);
  return validateCustomConfig({ baseURL: readProviderSetting(`${p}_BASE_URL`).trim(), apiKey: readProviderSetting(`${p}_API_KEY`).trim(), model: readProviderSetting(`${p}_MODEL`) });
}
export function customProviderStatus(capability, authenticated = false) {
  const p = prefixFor(capability);
  let configured = false;
  try { customConfig(capability); configured = true; } catch { /* incomplete configuration is normal during setup */ }
  const result = { label: '自定义 OpenAI 兼容中转', configured };
  if (authenticated) {
    result.base_url = readProviderSetting(`${p}_BASE_URL`);
    result.model = readProviderSetting(`${p}_MODEL`);
    result.key_configured = Boolean(readProviderSetting(`${p}_API_KEY`));
  }
  return result;
}
export function saveCustomProviderConfig(capability, input) {
  const p = prefixFor(capability);
  const rawKey = typeof input.api_key === 'string' ? input.api_key.trim() : '';
  const config = validateCustomConfig({
    baseURL: typeof input.base_url === 'string' ? input.base_url.trim() : '',
    apiKey: rawKey || readProviderSetting(`${p}_API_KEY`),
    model: input.model,
  });
  const voice = typeof input.voice_id === 'string' ? input.voice_id.trim() : '';
  if (/[\x00-\x1f\x7f]/.test(voice)) throw new Error('Voice ID 不能包含控制字符');
  getDb().transaction(() => {
    setAppSetting(`${p}_PROVIDER`, 'custom');
    setAppSetting(`${p}_BASE_URL`, config.baseURL);
    setAppSetting(`${p}_MODEL`, config.model);
    if (rawKey) setAppSetting(`${p}_API_KEY`, rawKey, { secret: 1 });
    if (p === 'TTS' && voice) setAppSetting('TTS_VOICE_ID', voice);
  })();
  return { capability, provider: 'custom', base_url_saved: true, model_saved: true, key_saved: Boolean(rawKey) };
}
async function post(capability, endpoint, build, { signal, timeoutMs = 30_000 } = {}) {
  const config = customConfig(capability);
  const body = build(config);
  const headers = { Authorization: `Bearer ${config.apiKey}` };
  if (!(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${config.baseURL}${endpoint}`, {
    method: 'POST', headers, body: body instanceof FormData ? body : JSON.stringify(body),
    signal: signal || AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`custom ${capability} HTTP ${response.status}`);
  return response;
}
async function readJson(response, capability) {
  try { return await response.json(); }
  catch { throw new Error(`custom ${capability} invalid JSON response`); }
}
const DEFAULT_CUSTOM_VISION_PROMPT = [
  '请用中文简洁转述这张图，帮助对方自然接话（不超过 220 字）：',
  '1. 画面主体与场景氛围（如日常照片、风景、食物、自拍等）；',
  '2. 如果图里有清晰文字、字幕、弹幕、聊天记录或表情包配字，务必摘录关键原话；',
  '3. 如果有明显的笑点、槽点、反差或情绪氛围，一并点出。',
  '直接用 2-4 句自然描述，不要分点报告体，绝不编造看不清的字。',
].join('\n');

export async function customVision(buffer, mime = 'image/jpeg', options = {}) {
  const prompt = typeof options?.prompt === 'string' && options.prompt.trim()
    ? options.prompt.trim()
    : DEFAULT_CUSTOM_VISION_PROMPT;
  const response = await post('vision', '/chat/completions', c => ({ model: c.model, messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } },
    { type: 'text', text: prompt },
  ] }] }), options);
  const text = (await readJson(response, 'vision')).choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('custom vision empty or invalid response');
  return text.trim();
}
export async function customAsr(buffer, mime = 'audio/wav', options = {}) {
  const extensions = { 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/flac': 'flac' };
  const response = await post('asr', '/audio/transcriptions', c => {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), `audio.${extensions[mime] || 'wav'}`);
    form.append('model', c.model);
    return form;
  }, options);
  const text = (await readJson(response, 'asr')).text;
  if (typeof text !== 'string') throw new Error('custom asr invalid response');
  return text.trim();
}
export async function customTts(text, options = {}) {
  const response = await post('tts', '/audio/speech', c => ({ model: options.model || c.model, input: text,
    voice: options.voice || readProviderSetting('TTS_VOICE_ID') || 'alloy', speed: options.speed ?? 1,
    response_format: 'mp3' }), options);
  const type = response.headers.get('content-type') || '';
  if (!/^(audio\/|application\/octet-stream)/i.test(type)) throw new Error('custom tts returned non-audio response');
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) throw new Error('custom tts empty audio');
  return audio;
}
function dataUrlToBlob(dataUrl, fallbackName = 'ref.png') {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length) return null;
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
  return { blob: new Blob([buf], { type: mime }), filename: fallbackName.replace(/\.[^.]+$/, '') + `.${ext}` };
}

function normalizeReferenceImages(refInput) {
  if (!refInput) return [];
  if (typeof refInput === 'string') return [refInput];
  if (Array.isArray(refInput)) return refInput.filter(x => typeof x === 'string' && x.trim());
  return [];
}

function extractCustomImageOutput(payload) {
  const data = payload?.data?.[0];
  if (typeof data?.b64_json === 'string' && data.b64_json) return `data:image/png;base64,${data.b64_json}`;
  if (typeof data?.url === 'string' && /^https?:\/\//i.test(data.url)) return data.url;
  return null;
}

export async function customImage(prompt, size = '1024x1024', optionsOrRef = {}) {
  const isRefArg = typeof optionsOrRef === 'string' || Array.isArray(optionsOrRef);
  const options = isRefArg ? {} : (optionsOrRef || {});
  const refs = normalizeReferenceImages(isRefArg ? optionsOrRef : options.referenceImage);
  const editEnabled = String(process.env.IMAGE_EDIT_ENABLED ?? 'true').toLowerCase() !== 'false';

  if (refs.length > 0 && editEnabled) {
    const blobs = refs.map((r, i) => dataUrlToBlob(r, `ref_${i + 1}.png`)).filter(Boolean);
    if (blobs.length > 0) {
      const tryEdit = async (withHighFidelity) => {
        const editResp = await post('image', '/images/edits', c => {
          const form = new FormData();
          form.append('model', c.model);
          form.append('prompt', prompt);
          form.append('size', size);
          form.append('n', '1');
          if (withHighFidelity) form.append('input_fidelity', 'high');
          const fieldName = blobs.length > 1 ? 'image[]' : 'image';
          for (const item of blobs) form.append(fieldName, item.blob, item.filename);
          return form;
        }, { timeoutMs: 120_000, ...options });
        return extractCustomImageOutput(await readJson(editResp, 'image'));
      };
      const wantFidelity = options.inputFidelity === 'high'
        || String(process.env.IMAGE_EDIT_FIDELITY || 'high').toLowerCase() === 'high';
      try {
        const editUrl = await tryEdit(wantFidelity);
        if (editUrl) return editUrl;
      } catch (err) {
        if (wantFidelity) {
          try {
            log('info', `[image] custom /images/edits(input_fidelity=high) 未被上游接受(${err.message.slice(0, 90)})，重试标准 /images/edits`);
            const retryUrl = await tryEdit(false);
            if (retryUrl) return retryUrl;
          } catch (retryErr) {
            log('warn', `[image] custom /images/edits 不可用(${retryErr.message.slice(0, 120)})，降级 /images/generations`);
          }
        } else {
          log('warn', `[image] custom /images/edits 不可用(${err.message.slice(0, 120)})，降级 /images/generations`);
        }
      }
    }
  }

  const response = await post('image', '/images/generations', c => ({ model: c.model, prompt, size, n: 1 }), { timeoutMs: 90_000, ...options });
  const url = extractCustomImageOutput(await readJson(response, 'image'));
  if (url) return url;
  throw new Error('custom image empty or invalid response');
}
export async function customEmbedding(text, options = {}) {
  const response = await post('embedding', '/embeddings', c => ({ model: c.model, input: text }), options);
  const vector = (await readJson(response, 'embedding')).data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every(Number.isFinite)) throw new Error('custom embedding invalid vector');
  return vector;
}
export async function testCustomProvider(capability) {
  const started = Date.now();
  const options = { timeoutMs: 15_000 };
  if (capability === 'vision') await customVision(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'), 'image/png', options);
  else if (capability === 'asr') {
    const wav = await readFile(new URL('./fixtures/asr-probe.wav', import.meta.url));
    const transcript = await customAsr(wav, 'audio/wav', options);
    const words = transcript.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
    if (!words.includes('speech recognition test')) throw new Error('custom asr probe transcription did not match the spoken test phrase');
  } else if (capability === 'tts') await customTts('你好', options);
  else if (capability === 'image') await customImage('A simple blue circle on a white background', '1024x1024', options);
  else if (capability === 'embedding') await customEmbedding('connection test', options);
  else throw new Error('Unknown custom capability');
  return { ok: true, provider: 'custom', latency_ms: Date.now() - started };
}
