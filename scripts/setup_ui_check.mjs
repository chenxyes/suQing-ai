import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../public/app/setup.html', import.meta.url), 'utf8');
for (const [, script] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script);
const updateTabs = /function updateTabs\(\) \{[\s\S]*?\n\}/.exec(html)?.[0];
assert.ok(updateTabs);
const tabs = new Map();
const document = { getElementById(id) {
  if (!tabs.has(id)) tabs.set(id, new Set());
  const classes = tabs.get(id);
  return { classList: { add(...values) { for (const value of values) { if (!value) throw new SyntaxError('Empty class token'); classes.add(value); } }, remove(...values) { for (const value of values) classes.delete(value); } } };
} };
vm.runInNewContext(`${updateTabs}; updateTabs();`, { document, S: { currentStep: 2 }, canGoStep: step => step === 5 });
assert.ok(tabs.get('tab-2').has('active'));
assert.ok(tabs.get('tab-3').has('locked'));
assert.ok(!tabs.get('tab-5').has('locked'));
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(new Set(ids).size, ids.length, 'DOM IDs must be unique');
for (const cap of ['vision', 'asr', 'tts', 'image', 'embedding']) {
  for (const suffix of ['provider', 'base', 'model', 'key', 'save', 'clear', 'test', 'msg']) assert.ok(ids.includes(`s2-${cap}-${suffix}`));
}
assert.ok(!/<head>[\s\S]*<section[\s\S]*<\/head>/.test(html));
console.log('setup UI: inline scripts, tab initialization and all capability controls passed');

const saveSearch = /async function saveSearch\(\) \{[\s\S]*?\n\}/.exec(html)?.[0];
assert.ok(saveSearch);
const fields = { 's2-search-provider': { value: 'tavily' }, 's2-search-key': { value: 'fixture-key' } };
const messages = []; let refreshed = 0;
await vm.runInNewContext(`${saveSearch}; saveSearch();`, {
  document: { getElementById: id => fields[id] },
  setMsg: (...args) => messages.push(args), authHeaders: () => ({}),
  fetch: async (_url, options) => {
    assert.equal(JSON.parse(options.body).api_key, 'fixture-key');
    return { json: async () => ({ ok: true, data: { label: 'Tavily', key_saved: true } }) };
  },
  refreshOptional: async () => { refreshed++; },
});
assert.equal(messages.at(-1)[2], 'ok', 'successful search save must remain successful');
assert.equal(fields['s2-search-key'].value, '', 'saved search key must be cleared');
assert.equal(refreshed, 1, 'successful save must refresh metadata');
console.log('setup UI: search save behavior passed');
