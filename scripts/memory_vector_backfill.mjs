#!/usr/bin/env node
/** Offline-first vector audit. Writes and model calls require an explicitly marked copy. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { filterRecallableMemoryRows } from '../src/memory_admission.mjs';
import { validateMemoryEvidence } from '../src/memory_provenance.mjs';
import { sameEmbeddingSpace, storedMemoryVector, validMemoryVector } from '../src/memory_vectors.mjs';

const MARKER = 'memory_vector_backfill_copy';
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const readonly = file => new Database(file, { readonly: true, fileMustExist: true });
function fileHash(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function sourceIdentity(file) {
  return { path: file, sha256: fileHash(file), walSha256: fs.existsSync(file + '-wal') ? fileHash(file + '-wal') : null };
}
function provenFact(db, row) {
  if (!['user', 'companion', 'shared'].includes(row.memory_subject) || !row.memory_evidence
    || !hasTable(db, 'companion_conversation_turns') || !hasTable(db, 'companions')) return false;
  const owner = db.prepare('SELECT user_id FROM companions WHERE id=?').get(row.companion_id);
  if (!owner || String(owner.user_id) !== String(row.user_id)) return false;
  try {
    const evidence = JSON.parse(row.memory_evidence);
    if (!Array.isArray(evidence) || !evidence.length || evidence.length > 160) return false;
    const turns = evidence.map(item => db.prepare(`SELECT id,companion_id,role,content,synthetic
      FROM companion_conversation_turns WHERE id=? AND companion_id=? AND COALESCE(synthetic,0)=0`)
      .get(item.turn_id, row.companion_id)).filter(Boolean);
    const checked = validateMemoryEvidence({ subject: row.memory_subject, evidence, turns });
    return !!checked && checked.content === row.content;
  } catch { return false; }
}
function auditRows(db) {
  if (!hasTable(db, 'companion_memories')) throw new Error('missing_memory_table');
  const rows = db.prepare('SELECT * FROM companion_memories ORDER BY id').all();
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.companion_id, row.user_id]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const eligible = [];
  for (const group of groups.values()) {
    const first = group[0];
    const revision = hasTable(db, 'memory_recall_barriers')
      ? db.prepare('SELECT revision FROM memory_recall_barriers WHERE companion_id=? AND user_id=?')
        .get(first.companion_id, first.user_id)?.revision || 0 : 0;
    eligible.push(...filterRecallableMemoryRows(group, { recallRevision: revision,
      hasRevocations: revision > 0 || group.some(row => (row.memory_status ?? 'active') !== 'active' || row.do_not_mention || row.recall_blocked) })
      .filter(row => provenFact(db, row)));
  }
  return { total: rows.length, eligible: eligible.sort((a, b) => a.id - b.id) };
}
function checkedDestination(outputDb, source, runtimeDb) {
  if (!outputDb) throw new Error('apply_requires_output_copy');
  const output = path.resolve(outputDb);
  const canonical = fs.existsSync(output) ? fs.realpathSync(output) : path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  if (canonical === source || canonical === runtimeDb || (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink())) {
    throw new Error('output_must_be_separate_copy');
  }
  if (fs.existsSync(output)) {
    const a = fs.statSync(source), b = fs.statSync(output);
    if (a.dev === b.dev && a.ino === b.ino) throw new Error('output_must_be_separate_copy');
  }
  return canonical;
}

export async function backfillMemoryVectors({ dbPath, outputDb = null, apply = false, resume = false,
  batchSize = 100, embed = null, spaceConfig = null } = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error('existing_db_required');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('batch_size_must_be_1_to_1000');
  if (resume && !apply) throw new Error('resume_requires_apply');
  const sourcePath = fs.realpathSync(dbPath), source = readonly(sourcePath);
  let snapshot, identity;
  try {
    snapshot = auditRows(source);
    if (!apply) return { mode: 'dry-run', total: snapshot.total, eligible: snapshot.eligible.length,
      excluded: snapshot.total - snapshot.eligible.length, candidateIds: snapshot.eligible.slice(0, batchSize).map(row => row.id),
      providerCalls: 0, written: 0 };
    identity = sourceIdentity(sourcePath);
    const defaultPath = path.resolve(process.env.DB_PATH || 'data/bot.db');
    const runtimeDb = fs.existsSync(defaultPath) ? fs.realpathSync(defaultPath) : defaultPath;
    outputDb = checkedDestination(outputDb, sourcePath, runtimeDb);
    if (resume) {
      const copy = readonly(outputDb);
      try {
        const marker = hasTable(copy, MARKER) && copy.prepare(`SELECT * FROM ${MARKER} WHERE id=1`).get();
        if (!marker || marker.version !== 1 || marker.output_path !== outputDb || marker.source_identity !== JSON.stringify(identity)) {
          throw new Error('resume_requires_matching_marked_copy');
        }
      } finally { copy.close(); }
    } else {
      fs.closeSync(fs.openSync(outputDb, 'wx', 0o600));
      await source.backup(outputDb);
      // Refuse a moving source snapshot; this tool is for offline copies.
      if (JSON.stringify(sourceIdentity(sourcePath)) !== JSON.stringify(identity)) throw new Error('source_changed_during_copy');
      const copy = new Database(outputDb);
      try {
        copy.exec(`CREATE TABLE ${MARKER}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER,source_identity TEXT,output_path TEXT,last_id INTEGER DEFAULT 0)`);
        copy.prepare(`INSERT INTO ${MARKER}(id,version,source_identity,output_path) VALUES(1,1,?,?)`).run(JSON.stringify(identity), outputDb);
      } finally { copy.close(); }
    }
  } finally { source.close(); }

  // No imports with schema/settings side effects are reachable in dry-run mode.
  process.env.DB_PATH = outputDb;
  process.env.LOG_DIR = path.join(path.dirname(outputDb), 'memory-vector-backfill-logs');
  const m = await import('../src/db.mjs');
  const db = m.getDb();
  if (fs.realpathSync(db.name) !== outputDb) throw new Error('database_module_already_initialized_elsewhere');
  const report = { mode: resume ? 'resume-copy' : 'apply-copy', total: 0, eligible: 0, excluded: 0,
    providerCalls: 0, written: 0, skipped: 0, failed: 0, stale: 0, errors: [] };
  try {
    if (!embed || !spaceConfig) {
      const provider = await import('../src/providers/embedding.mjs');
      embed ||= provider.embedTextWithDescriptor;
      spaceConfig ||= provider.getEmbeddingSpaceConfig;
    }
    snapshot = auditRows(db);
    report.total = snapshot.total; report.eligible = snapshot.eligible.length;
    report.excluded = report.total - report.eligible;
    if (!spaceConfig()) { report.errors.push({ code: 'invalid_embedding_config' }); return report; }
    const cursor = db.prepare(`SELECT last_id FROM ${MARKER} WHERE id=1`).get().last_id;
    const rows = [...snapshot.eligible.filter(row => row.id > cursor), ...snapshot.eligible.filter(row => row.id <= cursor)];
    let observedSpace = null;
    for (const row of rows) {
      if (report.providerCalls >= batchSize) break;
      const current = m.getRecallableMemories(row.companion_id, row.user_id).find(candidate => candidate.id === row.id);
      if (!current || !provenFact(db, current)) { report.stale++; continue; }
      let active = spaceConfig();
      if (!active) { report.errors.push({ code: 'invalid_embedding_config' }); break; }
      if (active.dimension === null && observedSpace && ['version', 'provider', 'model', 'endpointId'].every(key => active[key] === observedSpace[key])) active = observedSpace;
      const stored = storedMemoryVector(current);
      if (stored && sameEmbeddingSpace(stored.descriptor, active)) { report.skipped++; continue; }
      const revision = m.getMemoryRecallBarrier(current.companion_id, current.user_id).revision;
      report.providerCalls++;
      try {
        const result = await embed(current.content);
        if (!validMemoryVector(result, current.content)) {
          report.failed++; report.errors.push({ id: current.id, code: 'embedding_failed_or_invalid' });
        } else {
          observedSpace = result.descriptor;
          if (m.writeMemoryEmbedding(current.id, current.companion_id, current.user_id, result,
            { expectedContent: current.content, expectedRecallRevision: revision })) report.written++;
          else report.stale++;
        }
      } catch { report.failed++; report.errors.push({ id: current.id, code: 'embedding_or_write_failed' }); }
      db.prepare(`UPDATE ${MARKER} SET last_id=? WHERE id=1`).run(current.id);
    }
    return report;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i++) {
      const key = process.argv[i];
      if (key === '--apply' || key === '--resume') args[key] = true;
      else if (['--db', '--output-db', '--batch-size'].includes(key) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args[key] = process.argv[++i];
      else throw new Error('invalid_arguments');
    }
    const report = await backfillMemoryVectors({ dbPath: args['--db'], outputDb: args['--output-db'], apply: !!args['--apply'],
      resume: !!args['--resume'], batchSize: args['--batch-size'] === undefined ? 100 : Number(args['--batch-size']) });
    console.log(JSON.stringify(report));
    if (report.failed || report.errors?.length) process.exitCode = 1;
  } catch (error) {
    // SQL/filesystem/provider errors may carry paths or response details. Only expose our safe codes.
    const code = /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'backfill_failed';
    console.error(JSON.stringify({ error: code })); process.exitCode = 1;
  }
}
