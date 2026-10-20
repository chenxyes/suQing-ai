/** Execute the actual proactive work-consumption blocks with IO supplied in memory. */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as works from '../src/current_works.mjs';

const source = readFileSync(new URL('../src/proactive.mjs', import.meta.url), 'utf8');
function block(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < a) throw new Error('Proactive work block boundary changed');
  return source.slice(a, b);
}
const textBlock = block("  let chosenWorkMatId = '';", '  const proactiveBinding =');
const photoBlock = block("  let workPhotoMatId = '';", '  // v1.21.6 PR-C');
let pass = 0, fail = 0;
const ok = (c, message) => { if (c) pass++; else { fail++; console.log('  ✗', message); } };
function context(rows) {
  return { ...works, companion: { id: 1 }, proactiveActiveWorks: rows, getActiveCurrentWorks: () => rows,
    getRecentlyUsedMaterialIds: () => new Set(), countRecentMaterialUse: () => 0,
    log: (_level, message) => { if (message.includes('失败')) throw new Error(message); } };
}
const fixtures = [
  { id: 1, kind: 'game', title: '游戏', verify_status: 'generic', expected: '在玩一款游戏' },
  { id: 2, kind: 'series', title: '剧集', verify_status: 'generic', expected: '在追一部剧' },
  { id: 3, kind: 'anime', title: '动画', verify_status: 'generic', expected: '在追一部动画' },
  { id: 4, kind: 'craft', title: '手工', verify_status: 'generic', expected: '在做一些手工' },
  { id: 5, kind: 'game', title: '已验证示例游戏', verify_status: 'verified', expected: '在玩《已验证示例游戏》' },
  { id: 6, kind: 'craft', title: '织围巾', verify_status: 'skip', expected: '手上在织围巾' },
];
for (const row of fixtures) {
  for (const effectiveKind of ['normal', 'lastcall']) {
    const { prompt, material } = runInNewContext(textBlock + '\n({ prompt: systemPrompt, material: chosenWorkMatId });',
      { ...context([row]), effectiveKind, systemPrompt: '' });
    ok(prompt.includes(row.expected), `${effectiveKind}/${row.kind}/${row.verify_status}: correct subject reaches proactive prompt`);
    ok(!prompt.includes('刚看完一章') && !prompt.includes('那本游戏') && !prompt.includes('那本剧集'), `${row.kind}: no book-only progress example`);
    ok(material === `work:${row.id}`, `${row.kind}: selected work still gets material accounting`);
    if (row.verify_status === 'generic') ok(!prompt.includes('《'), `${row.kind}: generic never becomes named work`);
  }
  const category = { id: 'activity_pov', sceneSeed: '原有普通场景' };
  const photo = runInNewContext(photoBlock + '\n({ material: workPhotoMatId, category: categoryForPlanner });',
    { ...context([row]), sampledCategory: category, categoryForPlanner: category });
  if (row.verify_status === 'generic') {
    ok(photo.material === '' && photo.category.sceneSeed === '原有普通场景', `${row.kind}: generic does not consume a photo slot or erase scene seed`);
  } else {
    ok(photo.material === `work:${row.id}` && photo.category.sceneSeed.includes(row.title), `${row.kind}: verified work/craft still supplies its photo scene`);
  }
}
console.log(`current_works_proactive_smoke: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
