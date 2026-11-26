/** Read source files without opening SQLite there; SQLite may create sidecars even readonly. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

export function canonicalFilePath(file) {
  const resolved = path.resolve(file);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  const tail = [path.basename(resolved)]; let parent = path.dirname(resolved);
  while (!fs.existsSync(parent)) { tail.unshift(path.basename(parent)); parent = path.dirname(parent); }
  return path.join(fs.realpathSync(parent), ...tail);
}
function digest(file) {
  if (!fs.existsSync(file)) return null;
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = fs.openSync(file, 'r');
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
export function protectDatabasePaths(sourcePath, candidate) {
  const source = canonicalFilePath(sourcePath), target = canonicalFilePath(candidate);
  const targetStat = fs.existsSync(target) ? fs.statSync(target) : null;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const protectedPath = source + suffix;
    if (target === protectedPath) throw new Error('path_overlaps_source_database');
    if (targetStat && fs.existsSync(protectedPath)) {
      const stat = fs.statSync(protectedPath);
      if (targetStat.dev === stat.dev && targetStat.ino === stat.ino) throw new Error('path_overlaps_source_database');
    }
  }
  return target;
}
export function openOfflineSqliteSnapshot(inputPath) {
  const sourcePath = fs.realpathSync(inputPath);
  const fingerprint = () => Object.fromEntries(['', '-wal', '-shm', '-journal'].map(suffix => [suffix || 'db', digest(sourcePath + suffix)]));
  const before = fingerprint();
  if (fs.existsSync(sourcePath + '-journal') && fs.statSync(sourcePath + '-journal').size) throw new Error('source_has_rollback_journal');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-sqlite-'));
  fs.chmodSync(directory, 0o700);
  const snapshotPath = path.join(directory, 'snapshot.db');
  let db;
  const assertSourceUnchanged = () => {
    if (JSON.stringify(fingerprint()) !== JSON.stringify(before)) throw new Error('source_changed_during_snapshot');
  };
  try {
    fs.copyFileSync(sourcePath, snapshotPath); fs.chmodSync(snapshotPath, 0o600);
    if (before['-wal'] !== null) { fs.copyFileSync(sourcePath + '-wal', snapshotPath + '-wal'); fs.chmodSync(snapshotPath + '-wal', 0o600); }
    assertSourceUnchanged();
    if (digest(snapshotPath) !== before.db || digest(snapshotPath + '-wal') !== before['-wal']) throw new Error('inconsistent_snapshot_bytes');
    db = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    return { db, sourcePath, snapshotPath,
      sourceIdentity: { database_sha256: before.db, wal_sha256: before['-wal'] }, assertSourceUnchanged,
      close() { try { db.close(); assertSourceUnchanged(); } finally { fs.rmSync(directory, { recursive: true, force: true }); } } };
  } catch (error) {
    if (db?.open) db.close(); fs.rmSync(directory, { recursive: true, force: true }); throw error;
  }
}
