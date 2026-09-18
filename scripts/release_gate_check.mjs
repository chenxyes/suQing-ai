import assert from 'node:assert/strict';
const { verifyReleaseGate } = await import('./release_gate.mjs');
const sha = 'a'.repeat(40);
async function check(changes = {}) {
  const data = { ref: 'refs/heads/main', environment: { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'owner' } }] }] },
    runs: [{ head_sha: sha, head_branch: 'main', event: 'push', conclusion: 'success', status: 'completed' }], comparison: 'identical', ...changes };
  const github = { rest: { repos: {
    getEnvironment: async () => ({ data: data.environment }),
    getCommit: async () => ({ data: { sha } }),
    compareCommitsWithBasehead: async () => ({ data: { status: data.comparison } }),
  }, actions: { listWorkflowRuns: async () => ({ data: { workflow_runs: data.runs } }) } } };
  return verifyReleaseGate({ github, context: { ref: data.ref, repo: { owner: 'owner', repo: 'repo' }, payload: { inputs: { commit: sha } } } });
}
assert.equal(await check(), sha);
for (const changes of [{ ref: 'refs/heads/feature' }, { environment: { protection_rules: [] } },
  { environment: { protection_rules: [{ type: 'required_reviewers', reviewers: [] }] } },
  { comparison: 'diverged' }, { runs: [] }, { runs: [{ head_sha: sha, head_branch: 'main', event: 'push', conclusion: 'failure' }] },
  { runs: [{ head_sha: 'b'.repeat(40), head_branch: 'main', event: 'push', conclusion: 'success', status: 'completed' }] }]) {
  await assert.rejects(check(changes));
}
console.log('release gate: 8 approval/commit/CI scenarios passed');
