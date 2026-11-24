import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual photo transport/bookkeeping block, with network and
// deliberately failing persistence boundaries. Generation/upload are upstream.
const senderSource = readFileSync(new URL('../src/photo_sender.mjs', import.meta.url), 'utf8');
const transportBlock = senderSource.slice(senderSource.indexOf('  try {\n    const sent = await sendMessageItem'));
for (const failure of ['saveMessage', 'markPhotoSent', 'saveConversationTurn', 'tryAchievement']) {
  const context = {
    sendMessageItem: async () => true, context: {}, toUserId: 'fixture', item: {}, contextToken: 'test',
    source: 'proactive', companion: { id: 1 }, finalCaption: '喏', finalActivity: '咖啡', recordTurn: true,
    generated: {}, trigger: 'proactive', converted: { outName: 'fixture.png' }, log() {},
    saveMessage() {}, markPhotoSent() {}, saveConversationTurn() {}, tryAchievement() {},
  };
  context[failure] = () => { throw new Error('disk failure'); };
  const run = vm.runInNewContext(`(async function(){\n${transportBlock})`, context);
  assert.equal((await run()).ok, true, 'confirmed photo must remain delivered after ' + failure);
}

const proactiveSource = readFileSync(new URL('../src/proactive.mjs', import.meta.url), 'utf8');
const scene = proactiveSource.slice(proactiveSource.indexOf('async function sendScenePhoto('), proactiveSource.indexOf('// 撞车检测：'));
for (const failure of ['material', 'caption_history']) {
  const context = {
    getPhotoGateState: () => ({ allowed: true }), getRecentHistory: () => [], getEmotionStateWithDefaults: () => ({}),
    getCategorySendCounts: () => ({}), cappedCategoryIds: () => [], pickProactiveCategory: () => ({ id: 'thought_of_you' }),
    listPreferences: () => [], listShaping: () => [], getMemories: () => [], getRecentlyUsedMaterialIds: () => new Set(), materialDedupDays: () => 1,
    selectThoughtMaterial: () => ({ id: 'fixture-material' }), thoughtSceneSeed: () => '',
    planPhotoMessage: async () => ({ shouldSendPhoto: true, caption: '喏', delayCaptionMs: 1 }),
    sendCompanionPhoto: async () => ({ ok: true, caption: '喏', activity: '咖啡' }),
    insertProactiveMaterialLog: () => { if (failure === 'material') throw new Error('disk'); },
    peekSendQuota: () => true, sendTextMessage: async () => true,
    saveMessage: () => { if (failure === 'caption_history') throw new Error('disk'); },
    setTimeout: fn => fn(), log() {},
  };
  const run = vm.runInNewContext(`${scene}\nsendScenePhoto`, context);
  assert.equal((await run({ id: 1, wechat_user_id: 'fixture' }, { botId: 'fixture' })).status, 'sent');
}
console.log('photo delivery: confirmed transport remains sent after history, photo-state, turn, achievement, material and caption-history failures');
