import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashMemoryContent } from '../src/memory_vectors.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-indexing-'));
process.env.DB_PATH = path.join(temp, 'fixture.db');
process.env.LOG_DIR = path.join(temp, 'logs');
process.env.EMBEDDING_PROVIDER = 'offline-fixture';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const m = await import('../src/db.mjs');
const { indexMemory } = await import('../src/memory_indexing.mjs');
const db = m.getDb(); db.pragma('foreign_keys=OFF');
let cid = 94000; const uid = 94000;
const vector = text => ({ vector: [1, 0], contentHash: hashMemoryContent(text),
  descriptor: { version: 1, provider: 'fixture', model: 'fixture', dimension: 2, endpointId: 'a'.repeat(64) } });
function scope() {
  cid++;
  db.prepare('INSERT INTO companions(id,user_id,bot_id) VALUES(?,?,?)').run(cid, uid, `fixture-${cid}`);
  return m.saveMemory({ companionId: cid, userId: uid, memoryType: 'fact', content: '我喜欢骑自行车', pinned: false });
}
const row = id => db.prepare('SELECT * FROM companion_memories WHERE id=?').get(id);
try {
  await test('indexes exact stored text and keeps provenance fields untouched', async () => {
    const id = scope(), before = row(id);
    assert.equal(await indexMemory(id, cid, uid, { embed: async text => {
      assert.equal(text, before.content); return vector(text);
    } }), true);
    const after = row(id);
    assert.ok(after.embedding_meta);
    for (const key of ['content', 'memory_subject', 'memory_evidence', 'memory_status', 'use_count']) assert.equal(after[key], before[key]);
  });
  for (const action of ['edit', 'delete', 'revoke-source', 'rebind']) {
    await test(`indexing result cannot write after ${action} during provider await`, async () => {
      let id = scope();
      const source = id;
      if (action === 'revoke-source') id = m.saveMemory({ companionId: cid, userId: uid,
        memoryType: 'monthly_summary', content: '骑车摘要', sourceMemoryIds: [source], expectedRecallRevision: 0 });
      const indexed = await indexMemory(id, cid, uid, { embed: async text => {
        await Promise.resolve();
        if (action === 'edit') m.patchMemory(id, cid, { content: '我喜欢游泳' });
        if (action === 'delete') m.softDeleteMemory(id, cid);
        if (action === 'revoke-source') m.softDeleteMemory(source, cid);
        if (action === 'rebind') db.prepare('UPDATE companions SET user_id=? WHERE id=?').run(uid + 1, cid);
        return vector(text);
      } });
      assert.equal(indexed, false); assert.equal(row(id).embedding, null);
    });
  }
  await test('invalid and unavailable vectors preserve fact; hidden/foreign rows never call provider', async () => {
    const id = scope();
    assert.equal(await indexMemory(id, cid, uid, { embed: async () => { throw new Error('unavailable'); } }), false);
    assert.equal(await indexMemory(id, cid, uid, { embed: async text => ({ ...vector(text), vector: [0, 0] }) }), false);
    assert.equal(row(id).memory_status, 'active');
    let calls = 0; const embed = async text => { calls++; return vector(text); };
    assert.equal(await indexMemory(id, cid, uid + 1, { embed }), false);
    m.softDeleteMemory(id, cid);
    assert.equal(await indexMemory(id, cid, uid, { embed }), false); assert.equal(calls, 0);
  });
} finally {
  db.close(); process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));
}
