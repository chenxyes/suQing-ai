import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = `ghcr.io/chenxyes/suqing-ai@sha256:${'a'.repeat(64)}`;
const fakeDocker = `#!/usr/bin/env python3
import sys,os,json
from pathlib import Path
a=sys.argv[1:]; p=Path(os.environ['FAKE_STATE']); s=json.loads(p.read_text());
with open(os.environ['FAKE_CALLS'],'a') as f: f.write(json.dumps(a)+'\\n')
if a[:2]==['compose','version']: print('2.40.3')
elif a and a[0]=='pull':
 if os.environ.get('FAIL_PULL'): sys.exit(1)
elif a[:2]==['image','tag']: pass
elif a and a[0]=='inspect':
 fmt=a[a.index('--format')+1]
 if fmt=='{{.Image}}': print('sha256:'+'b'*64)
 elif 'com.docker.compose.project.working_dir' in fmt: print(os.environ['FAKE_PROJECT'])
 elif 'com.docker.compose.project' in fmt: print('xiyu-ai')
 elif '.State.Health' in fmt: print('unhealthy' if s.get('bad') else 'healthy')
 else: sys.exit(2)
elif a and a[0]=='compose':
 if 'ps' in a:
  if not os.environ.get('NO_CONTAINER'): print('container1')
 elif 'config' in a: pass
 elif 'up' in a:
  candidate=os.environ.get('RELEASE_IMAGE','').startswith('ghcr.io/')
  s['bad']=candidate and bool(os.environ.get('UNHEALTHY'))
  s['image']=os.environ.get('RELEASE_IMAGE');p.write_text(json.dumps(s))
  if candidate and os.environ.get('FAIL_UP'): sys.exit(1)
 else: sys.exit(2)
else: sys.exit(2)
`;
function runCase(extra = {}, ref = image) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-check-'));
  const bin = path.join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(path.join(bin, 'docker'), fakeDocker, { mode: 0o755 });
  writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n  xiyu-ai:\n    image: existing\n');
  writeFileSync(path.join(dir, 'state.json'), '{}');
  const result = spawnSync('bash', [path.join(root, 'deploy/release.sh'), dir, ref], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: path.join(dir, 'state.json'),
      FAKE_CALLS: path.join(dir, 'calls.jsonl'), FAKE_PROJECT: realpathSync(dir),
      RELEASE_HEALTH_ATTEMPTS: '1', RELEASE_HEALTH_INTERVAL: '0', ...extra }, encoding: 'utf8', timeout: 10_000,
  });
  let override = ''; try { override = readFileSync(path.join(dir, '.release/compose.image.yml'), 'utf8'); } catch {}
  const state = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
  let calls = []; try { calls = readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch {}
  rmSync(dir, { recursive: true, force: true });
  return { ...result, state, calls, override };
}
const success = runCase();
assert.equal(success.status, 0, success.stderr);
assert.equal(success.state.image, image);
assert.ok(success.calls.some(a => a.includes('--no-build') && a.includes('--no-deps')));
for (const mode of ['UNHEALTHY', 'FAIL_UP']) {
  const r = runCase({ [mode]: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.state.image, /^xiyu-release-rollback:/, mode);
  assert.equal(r.state.bad, false);
  assert.ok(r.override.includes(r.state.image), `${mode}: restart override must select restored image`);
}
for (const env of [{ FAIL_PULL: '1' }, { NO_CONTAINER: '1' }]) {
  const r = runCase(env); assert.notEqual(r.status, 0);
  assert.equal(r.calls.filter(a => a.includes('up')).length, 0);
}
for (const ref of ['latest', 'ghcr.io/owner/repo:latest', `${image};touch /tmp/injected`, '-bad']) {
  const r = runCase({}, ref); assert.notEqual(r.status, 0); assert.equal(r.calls.length, 0);
}
console.log('deploy release: 9 scenarios passed (success, rollback, preflight, invalid references)');
