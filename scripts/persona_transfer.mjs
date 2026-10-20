#!/usr/bin/env node
/** Full persona/history transfer. Import always creates a new database copy. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalFilePath as absolute, protectDatabasePaths, openOfflineSqliteSnapshot } from '../src/offline_sqlite_snapshot.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function parseArgs() {
  const command = process.argv[2], args = {};
  if (!['export', 'import'].includes(command)) throw new Error('command_must_be_export_or_import');
  const allowed = command === 'export' ? ['--db', '--companion-id', '--output-json']
    : ['--db', '--input-json', '--output-db', '--user-id', '--bot-id', '--reviewed-sha256', '--max-import-mib'];
  for (let i = 3; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (command === 'import' && key === '--trust-reviewed-history') args[key] = true;
    else if (allowed.includes(key) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args[key] = process.argv[++i];
    else throw new Error('invalid_arguments');
  }
  return { command, args };
}
try {
  const { command, args } = parseArgs();
  if (!args['--db'] || !fs.existsSync(args['--db'])) throw new Error('existing_source_db_required');
  const sourcePath = fs.realpathSync(args['--db']);
  if (command === 'export') {
    const companionId = Number(args['--companion-id']);
    if (!Number.isSafeInteger(companionId) || companionId <= 0 || !args['--output-json']) throw new Error('companion_id_and_output_json_required');
    const outputJson = protectDatabasePaths(sourcePath, args['--output-json']);
    protectDatabasePaths(process.env.DB_PATH || path.resolve('data/bot.db'), outputJson);
    process.env.DB_PATH = sourcePath;
    const { buildCompanionExportFromDb } = await import('../src/persona_export.mjs');
    const snapshot = openOfflineSqliteSnapshot(sourcePath);
    try {
      const payload = buildCompanionExportFromDb(snapshot.db, companionId, { includeMemories: true });
      const bytes = JSON.stringify(payload, null, 2) + '\n';
      snapshot.assertSourceUnchanged();
      fs.writeFileSync(outputJson, bytes, { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ mode: 'read-only-export', memories: payload.core_memories.length,
        turns: payload.evidence_turns.length, sha256: hash(bytes) }));
    } finally { snapshot.close(); }
  } else {
    if (!args['--input-json'] || !args['--output-db']) throw new Error('input_json_and_new_output_db_required');
    const userId = Number(args['--user-id']);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('target_user_id_required');
    const output = protectDatabasePaths(sourcePath, args['--output-db']);
    const inputJson = protectDatabasePaths(sourcePath, args['--input-json']);
    const runtimeDb = absolute(process.env.DB_PATH || path.resolve('data/bot.db'));
    protectDatabasePaths(runtimeDb, output);
    if (output === sourcePath || output === runtimeDb || fs.existsSync(output)) throw new Error('output_must_be_new_separate_copy');
    const maxMiB = args['--max-import-mib'] === undefined ? 32 : Number(args['--max-import-mib']);
    if (!Number.isSafeInteger(maxMiB) || maxMiB < 1 || maxMiB > 256) throw new Error('max_import_mib_must_be_1_to_256');
    const maxBytes = maxMiB * 1024 * 1024;
    if (fs.statSync(inputJson).size > maxBytes) throw new Error('input_exceeds_explicit_size_limit');
    const raw = fs.readFileSync(inputJson);
    const reviewed = args['--trust-reviewed-history'] === true;
    if (reviewed && (!/^[a-f0-9]{64}$/.test(args['--reviewed-sha256'] || '') || hash(raw) !== args['--reviewed-sha256'])) {
      throw new Error('reviewed_history_requires_matching_sha256');
    }
    const payload = JSON.parse(raw.toString('utf8'));
    process.env.DB_PATH = output;
    process.env.LOG_DIR = path.join(path.dirname(output), 'persona-transfer-logs');
    const { validateCompanionImport, importCompanionForUser } = await import('../src/persona_export.mjs');
    if (!validateCompanionImport(payload, { maxBytes }).valid) throw new Error('invalid_import_payload');
    const snapshot = openOfflineSqliteSnapshot(sourcePath);
    try {
      if (!snapshot.db.prepare('SELECT id FROM users WHERE id=?').get(userId)) throw new Error('target_user_missing');
      fs.closeSync(fs.openSync(output, 'wx', 0o600));
      await snapshot.db.backup(output);
    } finally { snapshot.close(); }
    const { getDb } = await import('../src/db.mjs');
    try {
      const result = await importCompanionForUser(userId, null, args['--bot-id'] || 'offline-import', payload,
        { importMemories: true, trustReviewedHistory: reviewed, maxImportBytes: maxBytes });
      console.log(JSON.stringify({ mode: 'new-copy-import', ...result }));
    } finally { getDb().close(); }
  }
} catch (error) {
  const code = /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'persona_transfer_failed';
  console.error(JSON.stringify({ error: code })); process.exitCode = 1;
}
