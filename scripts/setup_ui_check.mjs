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
