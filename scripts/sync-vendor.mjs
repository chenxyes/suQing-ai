#!/usr/bin/env node
/**
 * Sync pinned frontend vendor bundles from node_modules into public/vendor/.
 * Keeps runtime Docker image (npm ci --omit=dev) independent of devDependencies
 * and eliminates runtime unpkg/CDN unpinned fetches.
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(ROOT, 'node_modules/lucide/dist/umd/lucide.min.js');
const dstDir = path.join(ROOT, 'public/vendor');
const dst = path.join(dstDir, 'lucide.min.js');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'node_modules/lucide/package.json'), 'utf8'));

mkdirSync(dstDir, { recursive: true });
copyFileSync(src, dst);
console.log(`[sync-vendor] copied lucide@${pkg.version} -> public/vendor/lucide.min.js`);
