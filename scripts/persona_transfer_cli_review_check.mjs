/** Independent CLI file-safety and large-payload review; synthetic local files only. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-cli-review-'));
const source = path.join(temp, 'source.db'), exported = path.join(temp, 'large.json');
process.env.DB_PATH = source; process.env.LOG_DIR = path.join(temp, 'logs');
globalThis.fetch = () => { throw new Error('Offline test forbids network'); };
const { getDb } = await import('../src/db.mjs');
const db = getDb();
db.prepare("INSERT INTO users(id,wechat_user_id) VALUES(1,'synthetic-cli-review')").run();
db.prepare("INSERT INTO companions(id,user_id,bot_id,name) VALUES(1,1,'fixture','大文件合成角色')").run();
const content = i => `第${i}条合成测试记忆：${'甲'.repeat(4000)}`;
const insert = db.prepare("INSERT INTO companion_memories(companion_id,user_id,memory_type,content) VALUES(1,1,'fact',?)");
db.transaction(() => { for (let i = 0; i < 220; i++) insert.run(content(i)); })();
db.close();
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = digest(source);
const run = (args, runtime = source) => spawnSync(process.execPath, ['scripts/persona_transfer.mjs', ...args], {
  cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DB_PATH: runtime }, timeout: 30000,
});
const importArgs = output => ['import', '--db', source, '--input-json', exported, '--output-db', output, '--user-id', '1'];
try {
  await test('CLI round-trips more than 2 MiB and 200 records without truncation', () => {
    const result = run(['export', '--db', source, '--companion-id', '1', '--output-json', exported]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(digest(source), before);
    assert.ok(fs.statSync(exported).size > 2 * 1024 * 1024);
    assert.equal(JSON.parse(result.stdout).memories, 220);
    const output = path.join(temp, 'large-copy.db');
    const imported = run(importArgs(output));
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(digest(source), before);
    const target = new Database(output, { readonly: true });
    try {
      const id = JSON.parse(imported.stdout).companionId;
      const rows = target.prepare('SELECT content,recall_blocked FROM companion_memories WHERE companion_id=? ORDER BY id').all(id);
      assert.equal(rows.length, 220);
      assert.deepEqual(rows.map(row => row.content), Array.from({ length: 220 }, (_, i) => content(i)));
      assert.ok(rows.every(row => row.recall_blocked === 1));
      assert.equal(target.pragma('integrity_check', { simple: true }), 'ok');
    } finally { target.close(); }
  });

  await test('source aliases and configured runtime destination are rejected without file changes', () => {
    const symlink = path.join(temp, 'source-alias.db'), hardlink = path.join(temp, 'source-hardlink.db');
    fs.symlinkSync(source, symlink); fs.linkSync(source, hardlink);
    for (const output of [source, symlink, hardlink]) assert.equal(run(importArgs(output)).status, 1);
    const runtime = path.join(temp, 'active-runtime.db');
    assert.equal(run(importArgs(runtime), runtime).status, 1);
    assert.equal(fs.existsSync(runtime), false);
    assert.equal(run(['export', '--db', source, '--companion-id', '1', '--output-json', symlink]).status, 1);
    assert.equal(digest(source), before);
  });

  await test('over-limit raw JSON fails before creating a destination copy', () => {
    const oversized = path.join(temp, 'over32m.json'), output = path.join(temp, 'oversized-copy.db');
    const handle = fs.openSync(oversized, 'wx');
    try { fs.ftruncateSync(handle, 32 * 1024 * 1024 + 1); } finally { fs.closeSync(handle); }
    const result = run(['import', '--db', source, '--input-json', oversized, '--output-db', output, '--user-id', '1']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr.trim().split('\n').at(-1)).error, 'input_exceeds_explicit_size_limit');
    assert.equal(fs.existsSync(output), false);
    assert.equal(digest(source), before);
  });

  await test('source SQLite sidecar destinations and parent-directory aliases are rejected', () => {
    const aliasDir = path.join(temp, 'alias'); fs.symlinkSync(temp, aliasDir);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      for (const mode of ['export', 'import']) {
        const copy = path.join(temp, `${mode}${suffix}.db`); fs.copyFileSync(source, copy);
        const output = path.join(aliasDir, path.basename(copy) + suffix);
        const args = mode === 'export'
          ? ['export', '--db', copy, '--companion-id', '1', '--output-json', output]
          : ['import', '--db', copy, '--input-json', exported, '--output-db', output, '--user-id', '1'];
        const result = run(args);
        assert.equal(result.status, 1, `${mode} must reject ${suffix}`);
        assert.equal(fs.existsSync(output), false, `${suffix} must not be created`);
        assert.equal(digest(copy), before);
      }
    }
  });

  await test('configured runtime sidecar destinations are protected when source is a different snapshot', () => {
    for (const mode of ['export', 'import']) {
      const runtime = path.join(temp, `separate-${mode}-runtime.db`); fs.copyFileSync(source, runtime);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        const output = runtime + suffix;
        const args = mode === 'export'
          ? ['export', '--db', source, '--companion-id', '1', '--output-json', output]
          : importArgs(output);
        const result = run(args, runtime);
        assert.equal(result.status, 1, `${mode} runtime ${suffix} must be protected`);
        assert.equal(fs.existsSync(output), false);
      }
      assert.equal(digest(runtime), before);
    }
    assert.equal(digest(source), before);
  });

  await test('export reads committed WAL rows while preserving source database and sidecar bytes', () => {
    const walSource = path.join(temp, 'wal-source.db'); fs.copyFileSync(source, walSource);
    const live = new Database(walSource);
    try {
      live.pragma('journal_mode = WAL'); live.pragma('wal_autocheckpoint = 0');
      live.prepare("INSERT INTO companion_memories(companion_id,user_id,memory_type,content) VALUES(1,1,'fact','仅在WAL中的合成事实')").run();
      const hashes = () => Object.fromEntries(['', '-wal', '-shm', '-journal'].map(suffix => [suffix, fs.existsSync(walSource + suffix) ? digest(walSource + suffix) : null]));
      const original = hashes(); assert.ok(original['-wal']);
      const output = path.join(temp, 'wal-export.json');
      const result = run(['export', '--db', walSource, '--companion-id', '1', '--output-json', output]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(hashes(), original);
      const payload = JSON.parse(fs.readFileSync(output, 'utf8'));
      assert.equal(payload.core_memories.length, 221);
      assert.equal(payload.core_memories.at(-1).content, '仅在WAL中的合成事实');
    } finally { live.close(); }
  });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
