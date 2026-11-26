import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

export const BEHAVIOR_ACTIONS = Object.freeze({
  support: ['validate', 'listen', 'suggest'],
  celebrate: ['celebrate'],
  repair: ['clarify', 'repair'],
});
const BUNDLED_DIRECTORY = fileURLToPath(new URL('../config/behavior/', import.meta.url));
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const textList = value => Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(v => text(v, 300));

function validateCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return false;
  const allowed = BEHAVIOR_ACTIONS[card.scenario];
  if (!allowed || !text(card.id, 80) || !/^[a-z0-9._-]+$/i.test(card.id) || !text(card.title, 100)) return false;
  const source = card.source;
  if (!source || !text(source.repository, 200) || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(source.repository)
      || typeof source.revision !== 'string' || !/^[a-f0-9]{40}$/.test(source.revision) || !text(source.path, 300)) return false;
  if (!textList(card.when) || !textList(card.avoid) || !textList(card.exit)) return false;
  if (!card.actions || Array.isArray(card.actions) || typeof card.actions !== 'object') return false;
  const actions = Object.keys(card.actions);
  return actions.length === allowed.length && actions.every(a => allowed.includes(a) && text(card.actions[a], 700));
}

/** Local operator-maintained cards only. A damaged override never silently falls back to different policies. */
export function loadBehaviorLibrary(directory = process.env.BEHAVIOR_LIBRARY_DIR || BUNDLED_DIRECTORY) {
  try {
    const dir = resolve(directory);
    const files = readdirSync(dir).filter(name => name.endsWith('.json')).sort();
    if (!files.length || files.length > 3) return [];
    const cards = [];
    const seen = new Set();
    for (const file of files) {
      const filePath = join(dir, file);
      const stat = lstatSync(filePath);
      if (!stat.isFile() || stat.size > 16_384) return [];
      const card = JSON.parse(readFileSync(filePath, 'utf8'));
      if (!validateCard(card) || seen.has(card.scenario)) return [];
      seen.add(card.scenario);
      cards.push(card);
    }
    return cards;
  } catch {
    return [];
  }
}
