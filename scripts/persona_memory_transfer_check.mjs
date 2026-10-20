import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-memory-transfer-'));
process.env.DB_PATH = path.join(temp, 'fixture.db');
process.env.LOG_DIR = path.join(temp, 'logs');
const m = await import('../src/db.mjs');
const transfer = await import('../src/persona_export.mjs');
const db = m.getDb(), uid = 88001, cid = 88002;
db.prepare('INSERT INTO users(id,wechat_user_id) VALUES(?,?)').run(uid, 'synthetic-persona-transfer');
db.prepare('INSERT INTO companions(id,user_id,bot_id,name) VALUES(?,?,?,?)').run(cid, uid, 'fixture', '完整迁移角色');
const memories = [];
for (let i = 0; i < 310; i++) memories.push(m.saveMemory({ companionId: cid, userId: uid, memoryType: 'fact', content: `旧记录编号${i}`, importance: 5, pinned: false }));
const userTurn = m.saveConversationTurn(cid, 'user', '我喜欢周末骑自行车');
const assistantTurn = m.saveConversationTurn(cid, 'assistant', '我有一个妹妹');
const syntheticTurn = m.saveConversationTurn(cid, 'user', '我曾经去过虚构城市');
for (let i = 0; i < 270; i++) m.saveConversationTurn(cid, i % 2 ? 'assistant' : 'user', `无记忆引用的历史对话${i}`);
db.prepare('UPDATE companion_conversation_turns SET synthetic=1 WHERE id=?').run(syntheticTurn.id);
function proof(id, turn, subject, origin = 'conversation') {
  db.prepare('UPDATE companion_memories SET content=?,memory_subject=?,memory_evidence=?,memory_origin=? WHERE id=?')
    .run(turn.content, subject, JSON.stringify([{ turn_id: turn.id, role: turn.role, quote: turn.content }]), origin, id);
}
proof(memories[0], userTurn, 'user'); proof(memories[1], assistantTurn, 'companion'); proof(memories[2], syntheticTurn, 'user', 'synthetic');
db.prepare("UPDATE companion_memories SET memory_status='deleted',pinned=1,locked=1,do_not_mention=1,recall_blocked=1,sensitive_flag=1,created_at='2020-01-02 03:04:05',updated_at='2020-03-04 05:06:07',last_used_at='2020-02-03 04:05:06',use_count=19,decay_score=0.35 WHERE id=?").run(memories[3]);
db.prepare("UPDATE companion_memories SET memory_type='monthly_summary',memory_layer='summary',source_memory_ids=?,source_recall_revision=7 WHERE id=?")
  .run(JSON.stringify([memories[3], memories[4]]), memories[5]);
db.prepare('UPDATE companion_memories SET conflict_of=?,compacted_into=? WHERE id=?').run(memories[1], memories[5], memories[4]);
db.prepare('UPDATE companion_memories SET embedding=?,embedding_meta=? WHERE id=?').run(Buffer.from([0, 1, 2, 3, 255]), '{"legacy_unknown":true}', memories[0]);
db.prepare('UPDATE companion_memories SET origin_metadata=? WHERE id=?').run(JSON.stringify({ source: 'fixture', turn_ids: [syntheticTurn.id], user_id: 123, api_key: 'DO_NOT_EXPORT_FIXTURE' }), memories[2]);
db.prepare('INSERT INTO memory_recall_barriers(companion_id,user_id,revision,revoked_at,turn_id_cutoff) VALUES(?,?,?,?,?)')
  .run(cid, String(uid), 7, '2021-01-01T00:00:00.000Z', userTurn.id);
const load = id => db.prepare('SELECT * FROM companion_memories WHERE companion_id=? ORDER BY id').all(id);
const importPayload = (payload, options = {}) => transfer.importCompanionForUser(uid, 1, 'fixture-import', payload, { importMemories: true, ...options });
try {
  await test('v2 export pages every status beyond 200 rows and excludes account or credential metadata', () => {
    const payload = transfer.buildCompanionExport(cid, { includeMemories: true });
    assert.equal(payload.schema, 'xiyu_companion_export_v2'); assert.equal(payload.core_memories.length, 310);
    assert.equal(payload.evidence_turns.length, 273); assert.equal(payload.recall_barrier.revision, 7);
    assert.equal(payload.core_memories[3].memory_status, 'deleted');
    assert.ok(!JSON.stringify(payload).includes('DO_NOT_EXPORT_FIXTURE'));
    assert.ok(!JSON.stringify(payload).includes('"user_id"'));
    assert.equal(transfer.buildCompanionExport(cid).core_memories.length, 0);
  });
  await test('reviewed v2 migration remaps memory and proof IDs and keeps restrictions, timestamps and raw vectors', async () => {
    const payload = transfer.buildCompanionExport(cid, { includeMemories: true });
    const result = await importPayload(payload, { trustReviewedHistory: true }), rows = load(result.companionId);
    assert.equal(rows.length, 310);
    const old = load(cid);
    for (const key of ['memory_status', 'pinned', 'locked', 'do_not_mention', 'recall_blocked', 'sensitive_flag', 'created_at', 'updated_at', 'last_used_at', 'use_count', 'decay_score']) {
      assert.equal(rows[3][key], old[3][key], key);
    }
    assert.equal(rows[0].memory_subject, 'user'); assert.equal(rows[1].memory_subject, 'companion');
    assert.equal(rows[2].memory_origin, 'synthetic');
    const syntheticMeta = JSON.parse(rows[2].origin_metadata);
    assert.notEqual(syntheticMeta.turn_ids[0], syntheticTurn.id);
    assert.equal(db.prepare('SELECT synthetic FROM companion_conversation_turns WHERE id=?').get(syntheticMeta.turn_ids[0]).synthetic, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM companion_conversation_turns WHERE companion_id=?').get(result.companionId).n, 273);
    assert.deepEqual(JSON.parse(rows[5].source_memory_ids), [rows[3].id, rows[4].id]);
    assert.equal(rows[4].conflict_of, rows[1].id); assert.equal(rows[4].compacted_into, rows[5].id);
    assert.deepEqual(rows[0].embedding, Buffer.from([0, 1, 2, 3, 255])); assert.equal(rows[0].embedding_meta, '{"legacy_unknown":true}');
    const evidence = JSON.parse(rows[0].memory_evidence)[0]; assert.notEqual(evidence.turn_id, userTurn.id);
    const turn = db.prepare('SELECT * FROM companion_conversation_turns WHERE id=?').get(evidence.turn_id);
    assert.equal(turn.companion_id, result.companionId); assert.equal(turn.synthetic, 0); assert.equal(turn.import_unverified, 0);
    const barrier = m.getMemoryRecallBarrier(result.companionId, uid);
    assert.equal(barrier.revision, 7); assert.equal(barrier.turn_id_cutoff, evidence.turn_id);
    const allowed = new Set(m.getRecallableMemories(result.companionId, uid).map(row => row.id));
    assert.ok(!allowed.has(rows[2].id) && !allowed.has(rows[3].id) && !allowed.has(rows[5].id));
  });
  await test('default external v2 import preserves declarations but quarantines all history and proof turns', async () => {
    const payload = transfer.buildCompanionExport(cid, { includeMemories: true });
    const result = await importPayload(payload), rows = load(result.companionId);
    assert.equal(rows.length, 310); assert.equal(result.quarantinedMemories, 310);
    assert.equal(rows[0].memory_subject, 'user'); assert.equal(rows[2].memory_origin, 'synthetic');
    assert.ok(rows.every(row => row.recall_blocked === 1)); assert.equal(m.getRecallableMemories(result.companionId, uid).length, 0);
    assert.ok(db.prepare('SELECT import_unverified FROM companion_conversation_turns WHERE companion_id=?').all(result.companionId).every(row => row.import_unverified === 1));
    assert.equal(m.getConversationContext(result.companionId, 100).length, 0); assert.ok(result.warnings.length);
  });
  await test('forged or synthetic evidence cannot become recalled proof even with offline review', async () => {
    const payload = transfer.buildCompanionExport(cid, { includeMemories: true });
    payload.core_memories[0].memory_evidence = JSON.stringify([{ turn_id: syntheticTurn.id, quote: syntheticTurn.content }]);
    payload.core_memories[0].content = syntheticTurn.content;
    payload.core_memories[1].memory_evidence = JSON.stringify([{ turn_id: userTurn.id, quote: '我捏造了一句原话' }]);
    const result = await importPayload(payload, { trustReviewedHistory: true }), rows = load(result.companionId);
    assert.equal(rows[0].recall_blocked, 1); assert.equal(rows[1].recall_blocked, 1);
  });
  await test('v1 remains accepted without promoting claimed proof or silently truncating records', async () => {
    const payload = { schema: 'xiyu_companion_export_v1', companion: { name: '旧格式' },
      core_memories: Array.from({ length: 240 }, (_, i) => ({ content: `旧导入${i}`, memory_subject: 'user', pinned: 1, memory_status: i ? 'active' : 'deleted' })) };
    const result = await importPayload(payload, { trustReviewedHistory: true }), rows = load(result.companionId);
    assert.equal(rows.length, 240); assert.ok(rows.every(row => row.memory_subject === 'unknown' && row.recall_blocked === 1));
    assert.equal(rows[0].memory_status, 'deleted'); assert.equal(rows[0].pinned, 1);
  });
  await test('invalid references encoding or SQL constraints roll back new companion and every partial record', async () => {
    const payload = transfer.buildCompanionExport(cid, { includeMemories: true });
    payload.core_memories.at(-1).memory_type = 'not-a-type';
    const before = db.prepare('SELECT COUNT(*) n FROM companions').get().n;
    await assert.rejects(() => importPayload(payload));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM companions').get().n, before);
    const valid = transfer.buildCompanionExport(cid, { includeMemories: true });
    // A real late database failure checks atomicity independently of preflight validation.
    db.exec("CREATE TRIGGER fail_transfer_last BEFORE INSERT ON companion_memories WHEN NEW.content='旧记录编号309' AND NEW.companion_id<>88002 BEGIN SELECT RAISE(ABORT,'synthetic transfer failure'); END;");
    await assert.rejects(() => importPayload(valid), /synthetic transfer failure/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM companions').get().n, before);
    db.exec('DROP TRIGGER fail_transfer_last');
  });
  await test('32 MiB bound rejects oversized payload explicitly', () => {
    assert.equal(transfer.MAX_IMPORT_BYTES, 32 * 1024 * 1024);
    const payload = { schema: 'xiyu_companion_export_v2', companion: { name: 'bound', persona_prompt: 'x'.repeat(transfer.MAX_IMPORT_BYTES) } };
    assert.equal(transfer.validateCompanionImport(payload).valid, false);
  });
  await test('private memory, proof quote, and history payloads fail explicitly without partial import', async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM companions').get().n;
    for (const target of ['memory', 'quote', 'turn']) {
      const payload = transfer.buildCompanionExport(cid, { includeMemories: true });
      if (target === 'memory') payload.core_memories[0].content = '我的手机号是13812345678';
      if (target === 'quote') payload.core_memories[0].memory_evidence = JSON.stringify([{ turn_id: userTurn.id, quote: '我的手机号是13812345678' }]);
      if (target === 'turn') payload.evidence_turns[0].content = '我的手机号是13812345678';
      await assert.rejects(() => importPayload(payload, { trustReviewedHistory: true }), /private/);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM companions').get().n, before);
  });
  await test('offline CLI exports read-only and imports only a new copy with explicit reviewed-file hash', async () => {
    const source = path.join(temp, 'offline-source.db'), exported = path.join(temp, 'full.json'), output = path.join(temp, 'imported-copy.db');
    await db.backup(source);
    const sourceHash = () => createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const before = sourceHash();
    const run = args => spawnSync(process.execPath, ['scripts/persona_transfer.mjs', ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DB_PATH: source } });
    const exportedResult = run(['export', '--db', source, '--companion-id', String(cid), '--output-json', exported]);
    assert.equal(exportedResult.status, 0, exportedResult.stderr); assert.equal(sourceHash(), before);
    const manifest = JSON.parse(exportedResult.stdout); assert.equal(manifest.memories, 310); assert.equal(manifest.turns, 273);
    const base = ['import', '--db', source, '--input-json', exported, '--output-db', output, '--user-id', String(uid)];
    const rejected = run([...base, '--trust-reviewed-history', '--reviewed-sha256', 'a'.repeat(64)]);
    assert.equal(rejected.status, 1); assert.ok(!fs.existsSync(output));
    const imported = run([...base, '--trust-reviewed-history', '--reviewed-sha256', manifest.sha256]);
    assert.equal(imported.status, 0, imported.stderr); assert.equal(sourceHash(), before);
    const result = JSON.parse(imported.stdout);
    const target = new Database(output, { readonly: true });
    assert.equal(target.prepare('SELECT COUNT(*) n FROM companion_memories WHERE companion_id=?').get(result.companionId).n, 310);
    assert.equal(target.pragma('integrity_check', { simple: true }), 'ok'); target.close();
    assert.equal(run(base).status, 1, 'existing output cannot be overwritten');
  });
  await test('legacy source export supplies unknown provenance without adding columns or changing source bytes', () => {
    const legacy = path.join(temp, 'legacy.db');
    const old = new Database(legacy);
    old.exec(`CREATE TABLE companions(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT);
      INSERT INTO companions VALUES(1,2,'旧快照');
      CREATE TABLE companion_memories(id INTEGER PRIMARY KEY,companion_id INTEGER,user_id INTEGER,memory_type TEXT,content TEXT);
      INSERT INTO companion_memories VALUES(3,1,2,'fact','旧快照的未知记忆');
      CREATE TABLE companion_conversation_turns(id INTEGER PRIMARY KEY,companion_id INTEGER,role TEXT,content TEXT);
      INSERT INTO companion_conversation_turns VALUES(4,1,'user','旧快照对话');`);
    old.close(); const before = createHash('sha256').update(fs.readFileSync(legacy)).digest('hex');
    const readonly = new Database(legacy, { readonly: true });
    const payload = transfer.buildCompanionExportFromDb(readonly, 1, { includeMemories: true }); readonly.close();
    assert.equal(payload.core_memories[0].memory_subject, 'unknown'); assert.equal(payload.core_memories[0].memory_origin, 'unknown');
    assert.equal(payload.evidence_turns[0].synthetic, 0); assert.equal(payload.recall_barrier.revision, 0);
    assert.equal(transfer.validateCompanionImport(payload).valid, true);
    assert.equal(createHash('sha256').update(fs.readFileSync(legacy)).digest('hex'), before);
  });
  await test('validated role background containing ordinary token or Secret Garden wording is preserved', async () => {
    const payload = { schema: 'xiyu_companion_export_v2', companion: { name: '背景迁移' },
      persona_facts: [{ category: 'hobbies', content: '我喜欢研究 token 计费', sort_order: 0 },
        { category: 'music', content: '我喜欢 Secret Garden', sort_order: 1 }] };
    const result = await importPayload(payload);
    const facts = db.prepare('SELECT content FROM companion_persona_facts WHERE companion_id=? ORDER BY sort_order').all(result.companionId);
    assert.deepEqual(facts.map(row => row.content), ['我喜欢研究 token 计费', '我喜欢 Secret Garden']);
  });
  await test('explicit offline size override imports more than 32 MiB without dropping history bytes', async () => {
    const source = path.join(temp, 'large-source.db'), input = path.join(temp, 'large.json'), output = path.join(temp, 'large-copy.db');
    await db.backup(source);
    const longHistory = 'x'.repeat(33 * 1024 * 1024);
    const payload = { schema: 'xiyu_companion_export_v2', companion: { name: '大历史迁移' }, core_memories: [],
      evidence_turns: [{ id: 1, role: 'user', content: longHistory, synthetic: 0, import_unverified: 0 }] };
    fs.writeFileSync(input, JSON.stringify(payload));
    const base = ['scripts/persona_transfer.mjs', 'import', '--db', source, '--input-json', input, '--output-db', output, '--user-id', String(uid)];
    const run = extra => spawnSync(process.execPath, [...base, ...extra], { encoding: 'utf8', env: { ...process.env, DB_PATH: source } });
    assert.equal(run([]).status, 1); assert.ok(!fs.existsSync(output));
    const result = run(['--max-import-mib', '64']); assert.equal(result.status, 0, result.stderr);
    const cid = JSON.parse(result.stdout).companionId, copy = new Database(output, { readonly: true });
    const turn = copy.prepare('SELECT content,import_unverified FROM companion_conversation_turns WHERE companion_id=?').get(cid);
    assert.equal(turn.content.length, longHistory.length); assert.equal(turn.import_unverified, 1); copy.close();
  });
} finally { db.close(); process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true })); }
