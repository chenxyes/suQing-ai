import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CHAT_FALLBACK, isChatFallback } from '../src/chat_response.mjs';

const innerSource = readFileSync(new URL('../src/inner_os.mjs', import.meta.url), 'utf8');
const innerFunction = innerSource.slice(innerSource.indexOf('export async function generateInnerMonologue(')).replace(/^export /, '');
let parsed = 0;
let reply = CHAT_FALLBACK;
const inner = vm.runInNewContext(`${innerFunction}\ngenerateInnerMonologue`, {
  isInnerOsEnabled: () => true, shouldRunInnerOs: () => true, buildInnerSystemPrompt: () => 'fixture',
  generateReply: async () => reply, MAX_INNER_TOKENS: 160, isChatFallback,
  parseInnerStruct: () => { parsed++; return null; }, log() {},
});
assert.equal(await inner({ companion: { id: 1 }, userText: 'fixture' }), null, 'failed inner reply must not become a thought');
assert.equal(parsed, 0, 'failed inner reply must stop before parsing');
reply = '这是一条真实的内心想法';
assert.equal((await inner({ companion: { id: 1 }, userText: 'fixture' })).thought, reply, 'valid inner thought must remain usable');

const planSource = readFileSync(new URL('../src/plan_tasks.mjs', import.meta.url), 'utf8');
const summaryFunctions = planSource.slice(planSource.indexOf('async function compactOldEpisodicMemories('), planSource.indexOf('// ─── 文件存储'));
const originals = Array.from({ length: 5 }, (_, id) => ({ id, content: `真实记忆 ${id}`, created_at: '2025-01-01' }));
const writes = [], deletes = [];
reply = CHAT_FALLBACK;
const { summarize, compactOldEpisodicMemories } = vm.runInNewContext(`${summaryFunctions}\n({ summarize, compactOldEpisodicMemories })`, {
  process, Date, Map, Math, isChatFallback,
  generateReply: async () => reply,
  listEpisodicMemoriesOlderThan: () => originals,
  summaryMemoryExists: () => false,
  saveMemory: value => writes.push(value),
  deleteMemoriesByIds: ids => { deletes.push(...ids); return ids.length; },
  log() {},
});
await assert.rejects(summarize('日记忆', 'fixture', 'fixture'), error => error.message === 'summary chat unavailable');
await compactOldEpisodicMemories({ id: 1, user_id: 1 });
assert.equal(writes.length, 0, 'failed summary must not persist fallback');
assert.equal(deletes.length, 0, 'failed compaction must preserve originals');
reply = '有效总结';
await compactOldEpisodicMemories({ id: 1, user_id: 1 });
assert.equal(writes.length, 1, 'successful summary still persists');
assert.ok(writes[0].content.endsWith(reply));
assert.deepEqual(deletes, originals.map(row => row.id), 'successful compaction still follows existing behavior');
console.log('auxiliary chat failures: no fallback thought or summary, originals preserved; valid results unchanged');
