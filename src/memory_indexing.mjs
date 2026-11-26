import { embedTextWithDescriptor } from './ai.mjs';
import { getRecallableMemories, getMemoryRecallBarrier, writeMemoryEmbedding } from './db.mjs';
import { log } from './logger.mjs';

// Index canonical admitted text only. Provider failure must never undo a saved fact.
export async function indexMemory(memoryId, companionId, userId, { embed = embedTextWithDescriptor } = {}) {
  const revision = getMemoryRecallBarrier(companionId, userId).revision;
  const memory = getRecallableMemories(companionId, userId).find(row => row.id === memoryId);
  if (!memory) return false;
  try {
    const vector = await embed(memory.content);
    return !!vector && writeMemoryEmbedding(memoryId, companionId, userId, vector, {
      expectedContent: memory.content, expectedRecallRevision: revision,
    });
  } catch {
    log('warn', `[Memory] vector indexing unavailable id=${memoryId}`);
    return false;
  }
}
