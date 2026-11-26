#!/usr/bin/env node
/**
 * 表情包工坊 & 心愿收藏箱回归检查（纯离线，不依赖 DB 与外网）
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  safeFilename,
  normalizeTags,
  recommendPacksForCompanion,
  importStickerFromBase64,
  updateStickerMeta,
  deleteSticker,
  recordStickerWish,
  dismissStickerWish,
  getStickerStudioState,
} from '../src/sticker_studio.mjs';
import { parseStickerMarkers } from '../src/stickers.mjs';

// 1. 路径穿越防护
assert.equal(safeFilename('../etc/passwd'), null);
assert.equal(safeFilename('a/b.png'), null);
assert.equal(safeFilename('.hidden.png'), null);
assert.equal(safeFilename('cat_01.gif'), 'cat_01.gif');

// 2. 标签规范化
assert.deepEqual(normalizeTags('Happy, shy，CAT  happy'), ['happy', 'shy', 'cat']);

// 3. 人设推荐
const rec = recommendPacksForCompanion({ name: '林知夏', persona_summary: '温柔治愈的爱猫少女，偶尔有点傲娇吐槽' });
assert.ok(rec.pack_ids.length >= 3);
assert.ok(rec.reason.includes('林知夏'));

// 4. 手动导入 → 编辑 → 禁用 → parseStickerMarkers 缺失标签收集 → 删除清理
// 构造一个 >100 字节的有效 PNG Base64（复用项目内的 favicon-32.png）
const pngBuf = readFileSync(new URL('../public/favicon-32.png', import.meta.url));
const dataUrl = `data:image/png;base64,${pngBuf.toString('base64')}`;

const created = await importStickerFromBase64({
  imageBase64: dataUrl,
  filename: 'smoke_happy.png',
  emotion: 'happy',
  tags: ['smoke_only_tag'],
  description: '回归测试贴纸',
});
assert.ok(created.id.startsWith('custom_'));
assert.ok(created.tags.includes('smoke_only_tag'));

// parseStickerMarkers 命中刚上传的标签 + 报告不存在的缺失标签
const parsed = parseStickerMarkers('太棒啦 [STICKER:smoke_only_tag] [STICKER:nonexistent_wish_xyz]');
assert.equal(parsed.stickers.length, 1);
assert.deepEqual(parsed.missingTags, ['nonexistent_wish_xyz']);

// 编辑 & 停用
const updated = updateStickerMeta(created.id, { tags: ['smoke_only_tag', 'edited'], disabled: true });
assert.equal(updated.disabled, true);
assert.ok(updated.tags.includes('edited'));

// 心愿记录 & 忽略清理
const wish = recordStickerWish({ tag: 'smoke_wish_tag', context: '测试语境', autoCollect: false });
assert.equal(wish.tag, 'smoke_wish_tag');
assert.ok(getStickerStudioState().wishlist.items.some(w => w.id === wish.id));
assert.equal(dismissStickerWish(wish.id), true);

// 删除测试贴纸（清理现场）
assert.equal(deleteSticker(created.id), true);

console.log('sticker_studio_smoke: all assertions passed');
