/** Shared preflight, run again after environment approval. No production mutation. */
export async function verifyReleaseGate({ github, context }) {
  if (context.ref !== 'refs/heads/main') throw new Error('Releases must be dispatched from main');
  const requested = context.payload.inputs?.commit?.trim();
  if (!/^[a-f0-9]{40}$/.test(requested || '')) throw new Error('Enter the full 40-character commit SHA');
  const repo = context.repo;
  const { data: environment } = await github.rest.repos.getEnvironment({ ...repo, environment_name: 'production' });
  const reviewers = environment.protection_rules?.find(r => r.type === 'required_reviewers')?.reviewers;
  if (!Array.isArray(reviewers) || reviewers.length === 0) throw new Error('production must have required reviewers; refusing unprotected deployment');
  const { data: commit } = await github.rest.repos.getCommit({ ...repo, ref: requested });
  if (commit.sha !== requested) throw new Error('Commit resolution mismatch');
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${requested}...main` });
  if (!['identical', 'ahead'].includes(comparison.status)) throw new Error('Commit is not an ancestor of main');
  const { data } = await github.rest.actions.listWorkflowRuns({ ...repo, workflow_id: 'ci.yml', head_sha: requested, per_page: 100 });
  const passed = data.workflow_runs.some(run => run.head_sha === requested && run.head_branch === 'main' && run.event === 'push' && run.status === 'completed' && run.conclusion === 'success');
  if (!passed) throw new Error('Selected main commit has no successful push CI run');
  return requested;
}
