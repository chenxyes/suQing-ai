/** Generic fallback regression: real module logic, injected search and in-memory records. */
import { readFileSync } from 'node:fs';

// Pure mode permits reproducing the regression before native dependencies are available.
// IO imports are stubbed to throw; every operation used below must be explicitly injected.
const source = readFileSync(new URL('../src/current_works.mjs', import.meta.url), 'utf8');
const pureSource = source.replace(/^import .*;\n/gm, '')
  + '\nconst log = () => {};';
const works = process.argv.includes('--pure')
  ? await import(`data:text/javascript;base64,${Buffer.from(pureSource).toString('base64')}`)
  : await import('../src/current_works.mjs');
const { ensureCurrentWorks, advanceWorkProgress, buildWorksPromptHint, buildScheduleWorksHint,
  buildWorkArchiveMemory, worksSceneSeed, verifyWorkCandidate, worksConfig } = works;
let pass = 0, fail = 0;
const ok = (condition, name) => { if (condition) pass++; else { fail++; console.log('  ✗', name); } };
const now = new Date('2026-10-19T04:00:00Z');
const cfg = { ...worksConfig({}), maxActive: 1, verifyRetries: 1, seriesDaysMin: 10, seriesDaysMax: 10 };
const db = () => {
  const rows = [];
  return { rows, getActive: () => rows.filter(w => w.status === 'active'),
    insert: (id, w) => rows.push({ id: rows.length + 1, status: 'active', kind: w.kind, title: w.title,
      verify_status: w.verifyStatus, verify_evidence: w.verifyEvidence, creator: w.creator,
      progress_note: w.progressNote, started_at: w.startedAt }),
    setStatus: (id, status) => { rows.find(w => w.id === id).status = status; },
    setProgress: (id, note) => { rows.find(w => w.id === id).progress_note = note; } };
};
for (const kind of ['game', 'series', 'anime']) {
  for (const response of [
    { ok: false, error: 'no_provider', provider: '', results: [] },
    { ok: true, results: [] },
  ]) {
    const store = db();
    const out = await ensureCurrentWorks({ id: 1 }, { ...store, cfg, now, rng: () => 0.9,
      generate: async () => ({ kind, title: '未证实作品甲', genre: '悬疑', progressNote: '第三章破案了' }),
      search: async () => response, findCached: () => null });
    const row = store.rows[0];
    ok(row.kind === kind && row.verify_status === 'generic', `${kind}/${response.ok}: fallback preserves kind`);
    ok(row.title !== '悬疑' && row.title !== '未证实作品甲', `${kind}: neither genre nor unverified name becomes work title`);
    ok(row.verify_evidence === null && row.creator === null, `${kind}: fallback invents no evidence or creator`);
    ok(row.progress_note && !/章|关卡|破案|通关|结局|第.*集/.test(row.progress_note), `${kind}: ordinary activity advances without invented details`);
    if (!response.ok) ok(out.fallbackReason === 'no_provider', `${kind}: no provider has explicit diagnostic`);
    const hints = buildWorksPromptHint([row]) + buildScheduleWorksHint([row]);
    ok(!/在看一本|在玩一本|在追一本/.test(hints) && !hints.includes('《') && !hints.includes('第三章'), `${kind}: hints preserve medium and never quote generic label as a name`);
    const archive = buildWorkArchiveMemory(row, false, now).content;
    ok(!/看完|通关|一本|《/.test(archive), `${kind}: lifecycle archive does not invent completion of a specific work`);
    ok(worksSceneSeed(row) === '', `${kind}: generic cannot fabricate a named photo subject`);
  }
}
const game = { kind: 'game', title: '游戏', verify_status: 'generic', progress_note: null, started_at: '2026-10-13T04:00:00Z' };
const note = advanceWorkProgress(game, now, cfg);
ok(note && /玩/.test(note) && !/章|关卡|通关|中段/.test(note), 'generic game progresses through ordinary play');
ok(advanceWorkProgress({ ...game, progress_note: note }, now, cfg) === null, 'same activity stage does not rewrite progress');
const store = db();
store.rows.push({ ...game, id: 1, status: 'active' });
const out = await ensureCurrentWorks({ id: 1 }, { ...store, cfg, now });
ok(out.progressed === 1 && store.rows[0].progress_note === note, 'refresh persists ordinary generic progress');
const h = buildWorksPromptHint([game]);
ok(!/现在都当已经看完|早看完啦|这就是你现在手头在看\/在做的全部/.test(h), 'unknown work is not forced to completed');
ok(/未确认|不能确认/.test(h) && /已完成|看完/.test(h), 'prompt explains uncertain status instead of inventing completion');
const v = await verifyWorkCandidate({ kind: 'game', title: '未证实作品甲' }, {
  search: async () => ({ ok: false, error: 'no_provider', results: [], provider: '' }), findCached: () => null,
});
ok(v.status === 'generic' && v.reason === 'no_provider', 'verification explicitly reports absent search provider');
console.log(`current_works_generic_smoke: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
