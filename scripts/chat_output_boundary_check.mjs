import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CHAT_FALLBACK, isChatFallback } from '../src/chat_response.mjs';

const photo = readFileSync(new URL('../src/photo_sender.mjs', import.meta.url), 'utf8');
const caption = /async function generateNaturalCaption\([\s\S]*?\n\}/.exec(photo)?.[0];
assert.ok(caption);
for (const text of [CHAT_FALLBACK, '刚拍的，给你看看']) {
  let sanitized = 0;
  const run = vm.runInNewContext(`${caption}; generateNaturalCaption`, {
    generateReply: async () => text, isChatFallback,
    sanitizeCaption: value => { sanitized++; return value; },
    pickPhotoCaption: () => 'default caption', log() {},
  });
  assert.equal(await run({}, { activity: '', source: 'request' }), text === CHAT_FALLBACK ? 'default caption' : text);
  assert.equal(sanitized, text === CHAT_FALLBACK ? 0 : 1);
}

const api = readFileSync(new URL('../src/api.mjs', import.meta.url), 'utf8');
const start = api.indexOf('    (async () => {', api.indexOf("router.post('/companions/:id/sleep/wake'"));
assert.ok(start > 0);
const wake = api.slice(start, api.indexOf('    return ok(res, { woken_today:', start)).replaceAll('import(', 'fixtureImport(');
for (const text of [CHAT_FALLBACK, '刚醒']) {
  const sent = [], saved = [];
  const deps = {
    generateReply: async () => text,
    getCompanionById: () => ({ name: 'fixture', wechat_user_id: 'fixture-user' }),
    getBotContextForCompanion: () => ({ token: 'fixture-token' }),
    sendTextMessage: async (_ctx, _user, value) => sent.push(value),
    saveConversationTurn: (...args) => saved.push(args),
  };
  await vm.runInNewContext(wake, {
    fixtureImport: async () => deps, isChatFallback, id: 1, r: { prompt_hint: '' },
    log() {}, setTimeout: callback => callback(),
  });
  assert.deepEqual(sent, text === CHAT_FALLBACK ? [] : [text]);
  assert.equal(saved.length, text === CHAT_FALLBACK ? 0 : 1);
}
console.log('chat output boundaries: failed caption uses default; wake failure skips send/history; successful outputs retained');
