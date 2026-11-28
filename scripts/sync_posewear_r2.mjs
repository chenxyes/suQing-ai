#!/usr/bin/env node
/**
 * 将精选安全（SFW）姿势图、服装图与完整提示词目录同步至用户自己的 Cloudflare R2（suqing-assets），
 * 并幂等导入本地 SQLite 的 custom_pose_library 与 custom_outfit_presets 表。
 *
 * 用法：
 *   node scripts/sync_posewear_r2.mjs                       # 默认：全部 98 款安全单人姿势 + 60 款四季/礼服穿搭 + 全部提示词 JSON
 *   node scripts/sync_posewear_r2.mjs --costumes 120        # 同步 120 款穿搭实图（各季均衡采样）
 *   node scripts/sync_posewear_r2.mjs --costumes all        # 同步全部 1014 款安全穿搭实图（保持低并发 <=4）
 *   node scripts/sync_posewear_r2.mjs --skip-db             # 只传 R2，不写入本地 SQLite
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { getDb } from '../src/db.mjs';
import { r2PutObject, getR2Config, isR2Configured } from '../src/storage.mjs';
import { SOLO_POSES, COUPLE_POSES, OUTFIT_PRESETS } from '../src/pose_outfit_library.mjs';

const PUBLISHED_SITE = 'https://posewear.pages.dev/';
const SAFE_POSE_LINES = new Set(['全身·标准', '上半身']);
const SAFE_COSTUME_CATS = ['春季', '夏季', '秋季', '冬季', '派对礼服'];
const CONCURRENCY = 4; // 遵守原作者低并发要求

function parseArgs(argv) {
  const opts = { poses: 'all', costumes: 60, skipDb: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skip-db') opts.skipDb = true;
    else if (a === '--poses' && argv[i + 1]) opts.poses = argv[++i];
    else if (a === '--costumes' && argv[i + 1]) opts.costumes = argv[++i];
  }
  return opts;
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (SuQing-AI R2 Asset Sync)' },
    signal: AbortSignal.timeout(25_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

async function fetchBuffer(url, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (SuQing-AI R2 Asset Sync)' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100) throw new Error('empty image');
      return buf;
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

async function loadPosewearCatalogs() {
  const home = new URL(PUBLISHED_SITE);
  const html = await fetchText(home.href);
  const appMatch = html.match(/<script\b[^>]*\bsrc=["']((?:\/assets\/app\.[a-f0-9]+|\/?app)\.js)["']/);
  if (!appMatch) throw new Error('未找到目录脚本入口');
  const script = await fetchText(new URL(appMatch[1], home).href);

  const files = new Map();
  for (const m of script.matchAll(/["']((?:\/assets\/)?([a-z]+)(?:\.([a-f0-9]+))?\.json)["']/g)) {
    files.set(m[2], { url: new URL(m[1], home).href, digest: m[3] });
  }
  const canonical = html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/);
  const site = new URL(canonical?.[1] || home, home).href;
  const assetMatch = script.match(/\bconst AH=['"]([^'"]*)['"]/);
  const assetHost = new URL(assetMatch?.[1] || site, site).href;

  async function readJson(name) {
    const entry = files.get(name);
    if (!entry) throw new Error(`缺少目录 ${name}`);
    const text = await fetchText(entry.url);
    if (entry.digest) {
      const hash = createHash('sha256').update(text).digest('hex').slice(0, entry.digest.length);
      if (hash !== entry.digest) throw new Error(`目录校验不匹配: ${name}`);
    }
    const payload = JSON.parse(text);
    return Array.isArray(payload) ? payload : payload.items;
  }

  const poses = await readJson('poses');
  const costumes = await readJson('costumes');
  return { site, assetHost, poses, costumes };
}

function guessSlotFromCostume(item) {
  const text = `${item.ti || ''} ${item.zh || ''} ${item.en || ''}`.toLowerCase();
  if (/大衣|风衣|夹克|外套|开衫|羽绒|棉服|西装|斗篷|披肩|皮衣|马甲|\b(coat|jacket|cardigan|trench|blazer|puffer|parka|cape|vest)\b/.test(text)) {
    return { slot: 'outerwear', category: '外套' };
  }
  if (/连衣裙|礼服|长裙|短裙|半身裙|百褶裙|茶歇裙|牛仔裤|长裤|短裤|背带裤|\b(dress|gown|skirt|jeans|trousers|pants|shorts)\b/.test(text)) {
    return { slot: 'bottom_or_dress', category: /裤|jeans|trousers|pants|shorts/.test(text) ? '下装' : '裙装' };
  }
  return { slot: 'top', category: '上衣' };
}

function guessSwatchFromCostume(item) {
  const text = `${item.ti || ''} ${item.en || ''}`.toLowerCase();
  if (/black|黑/.test(text)) return '#26272D';
  if (/white|ivory|cream|白|奶/.test(text)) return '#F7F4EE';
  if (/pink|rose|粉|玫/.test(text)) return '#F5B8D0';
  if (/red|burgundy|wine|红|酒红/.test(text)) return '#C6455A';
  if (/navy|藏青|深蓝/.test(text)) return '#2A3B5C';
  if (/blue|denim|蓝|牛仔/.test(text)) return '#8AAED6';
  if (/beige|camel|brown|khaki|驼|米|棕|卡其/.test(text)) return '#C9A27B';
  if (/green|olive|mint|绿/.test(text)) return '#7FA88A';
  if (/purple|lavender|紫/.test(text)) return '#B49AD8';
  if (/yellow|mustard|黄/.test(text)) return '#E8C972';
  if (/gray|grey|灰/.test(text)) return '#9CA3AF';
  return '#F4D8E6';
}

function sampleBalanced(items, limit) {
  if (limit === 'all') return items;
  const maxN = Math.max(1, Number(limit) || 60);
  if (items.length <= maxN) return items;
  const groups = new Map();
  for (const it of items) {
    const k = it.cat || 'other';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const keys = [...groups.keys()];
  const perGroup = Math.max(1, Math.ceil(maxN / keys.length));
  const picked = [];
  for (const k of keys) {
    const arr = groups.get(k);
    const step = Math.max(1, Math.floor(arr.length / perGroup));
    for (let i = 0; i < arr.length && picked.length < maxN; i += step) {
      picked.push(arr[i]);
      if (picked.filter(x => (x.cat || 'other') === k).length >= perGroup) break;
    }
  }
  return picked.slice(0, maxN);
}

async function runPool(items, concurrency, workerFn) {
  let idx = 0;
  const results = new Array(items.length);
  async function runner() {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await workerFn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
  return results;
}

async function main() {
  if (!isR2Configured()) {
    console.error('❌ 未配置 Cloudflare R2（请先在 .env 设置 R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）');
    process.exit(1);
  }
  const opts = parseArgs(process.argv.slice(2));
  const r2Cfg = getR2Config();
  console.log(`☁️  目标 R2 桶: ${r2Cfg.bucket} (${r2Cfg.publicUrl || r2Cfg.endpoint})`);

  // 1. 先把本项目内置的姿势 + 服装 + 提示词也归档一份到 R2
  const builtinManifest = {
    source: 'suqing-ai-builtin',
    updated_at: new Date().toISOString(),
    soloPoses: SOLO_POSES,
    couplePoses: COUPLE_POSES,
    outfitPresets: OUTFIT_PRESETS,
  };
  await r2PutObject(
    'catalog/suqing_builtin.json',
    Buffer.from(JSON.stringify(builtinManifest, null, 2), 'utf8'),
    'application/json; charset=utf-8',
    r2Cfg,
  );
  console.log('✓ 已上传本项目内置目录: catalog/suqing_builtin.json');

  // 2. 拉取 posewear 公开目录并严格过滤仅保留 SFW 日常健康内容
  console.log('📥 正在读取 posewear 公开目录元数据…');
  const { site, assetHost, poses, costumes } = await loadPosewearCatalogs();
  const sfwPosesAll = poses.filter(p => !p.a && !p.n && !p.nsfw && SAFE_POSE_LINES.has(p.line));
  const sfwCostumesAll = costumes.filter(c => !c.a && !c.n && !c.nsfw && SAFE_COSTUME_CATS.includes(c.cat));

  const posesToSync = opts.poses === 'all' ? sfwPosesAll : sfwPosesAll.slice(0, Number(opts.poses) || 98);
  const costumesToSync = sampleBalanced(sfwCostumesAll, opts.costumes);
  console.log(`📊 筛选后安全素材：单人姿势 ${posesToSync.length}/${sfwPosesAll.length} 款，四季/礼服穿搭 ${costumesToSync.length}/${sfwCostumesAll.length} 款`);

  // 3. 同步姿势参考图到 R2
  let poseOk = 0;
  let poseFail = 0;
  const poseRecords = await runPool(posesToSync, CONCURRENCY, async (p, i) => {
    const front = (p.angles || []).find(a => a.zh === '正面') || (p.angles || [])[0];
    if (!front) return null;
    const srcUrl = front.i ? new URL(front.i, site).href : new URL(front.t, assetHost).href;
    const key = `presets/posewear/poses/${p.id}.webp`;
    try {
      const buf = await fetchBuffer(srcUrl);
      const uploaded = await r2PutObject(key, buf, 'image/webp', r2Cfg);
      poseOk++;
      if (poseOk % 20 === 0 || i === posesToSync.length - 1) {
        process.stdout.write(`\r  姿势图上传进度: ${poseOk}/${posesToSync.length} (失败 ${poseFail})`);
      }
      const isUpper = p.line === '上半身';
      return {
        id: `pw_pose_${p.id}`,
        kind: 'solo',
        label: String(p.zh || p.id).slice(0, 20),
        tag: String(p.cat || '标准姿势').slice(0, 14),
        framingLabel: isUpper ? '上半身' : '全身标准',
        descZh: `${p.line} · ${p.cat}：${p.zh}`,
        shotMode: isUpper ? 'CLOSE_SELFIE' : 'FULL_BODY_MIRROR',
        posePrompt: `${p.lineEn || 'full body, solo'}, ${p.en || ''}, ${front.en || 'front view'}`.replace(/,\s*,/g, ',').trim(),
        expressionPrompt: 'natural warm candid expression matching the pose',
        imageRef: uploaded.storageRef,
        publicUrl: uploaded.publicUrl,
      };
    } catch {
      poseFail++;
      return null;
    }
  });
  console.log(`\n✓ 姿势参考图同步完成: 成功 ${poseOk}，失败 ${poseFail}`);

  // 4. 同步精选四季/礼服穿搭实图到 R2
  let cosOk = 0;
  let cosFail = 0;
  const costumeRecords = await runPool(costumesToSync, CONCURRENCY, async (c, i) => {
    const srcUrl = c.m ? new URL(c.m, site).href : new URL(c.t, assetHost).href;
    const key = `presets/posewear/costumes/${c.id}.webp`;
    try {
      const buf = await fetchBuffer(srcUrl);
      const uploaded = await r2PutObject(key, buf, 'image/webp', r2Cfg);
      cosOk++;
      if (cosOk % 20 === 0 || i === costumesToSync.length - 1) {
        process.stdout.write(`\r  服装图上传进度: ${cosOk}/${costumesToSync.length} (失败 ${cosFail})`);
      }
      const { slot, category } = guessSlotFromCostume(c);
      return {
        id: `pw_cos_${c.id}`,
        slot,
        category,
        name: String(c.ti || c.id).slice(0, 44),
        color: String(c.cat || ''),
        material: '',
        styleTags: [c.cat, category].filter(Boolean),
        descZh: String(c.zh || c.ti || '').slice(0, 110),
        visualPrompt: String(c.en || c.kw || c.ti || 'casual fashion outfit').slice(0, 380),
        swatch: guessSwatchFromCostume(c),
        imageRef: uploaded.storageRef,
        publicUrl: uploaded.publicUrl,
        extractedMode: 'raw',
      };
    } catch {
      cosFail++;
      return null;
    }
  });
  console.log(`\n✓ 服装参考图同步完成: 成功 ${cosOk}，失败 ${cosFail}`);

  const validPoses = poseRecords.filter(Boolean);
  const validCostumes = costumeRecords.filter(Boolean);

  // 5. 将完整的 SFW 提示词目录 JSON（含全部 98 姿势 + 全部 1014 款安全穿搭提示词）上传 R2
  await r2PutObject(
    'catalog/posewear_poses.json',
    Buffer.from(JSON.stringify({ updated_at: new Date().toISOString(), count: validPoses.length, items: validPoses }, null, 2), 'utf8'),
    'application/json; charset=utf-8',
    r2Cfg,
  );
  await r2PutObject(
    'catalog/posewear_costumes.json',
    Buffer.from(JSON.stringify({ updated_at: new Date().toISOString(), count: validCostumes.length, items: validCostumes }, null, 2), 'utf8'),
    'application/json; charset=utf-8',
    r2Cfg,
  );
  await r2PutObject(
    'catalog/posewear_costumes_all_prompts.json',
    Buffer.from(JSON.stringify({
      updated_at: new Date().toISOString(),
      count: sfwCostumesAll.length,
      items: sfwCostumesAll.map(c => ({ id: c.id, cat: c.cat, title: c.ti, zh: c.zh, en: c.en, kw: c.kw })),
    }, null, 2), 'utf8'),
    'application/json; charset=utf-8',
    r2Cfg,
  );
  console.log('✓ 已上传完整提示词目录 JSON 至 R2: catalog/posewear_{poses,costumes,costumes_all_prompts}.json');

  // 6. 幂等写入本地 SQLite（让 Dashboard 展示柜 & 姿势库立即可见所有实图！）
  if (!opts.skipDb) {
    const db = getDb();
    const upsertPose = db.prepare(`
      INSERT INTO custom_pose_library
        (id, kind, label, tag, framing_label, desc_zh, shot_mode, pose_prompt, expression_prompt, image_ref, public_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        tag = excluded.tag,
        framing_label = excluded.framing_label,
        desc_zh = excluded.desc_zh,
        shot_mode = excluded.shot_mode,
        pose_prompt = excluded.pose_prompt,
        expression_prompt = excluded.expression_prompt,
        image_ref = excluded.image_ref,
        public_url = excluded.public_url
    `);
    const upsertCostume = db.prepare(`
      INSERT INTO custom_outfit_presets
        (id, slot, category, name, color, material, style_tags, desc_zh, visual_prompt, swatch, image_ref, public_url, extracted_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        slot = excluded.slot,
        category = excluded.category,
        name = excluded.name,
        color = excluded.color,
        style_tags = excluded.style_tags,
        desc_zh = excluded.desc_zh,
        visual_prompt = excluded.visual_prompt,
        swatch = excluded.swatch,
        image_ref = excluded.image_ref,
        public_url = excluded.public_url,
        extracted_mode = excluded.extracted_mode
    `);

    db.transaction(() => {
      for (const p of validPoses) {
        upsertPose.run(p.id, p.kind, p.label, p.tag, p.framingLabel, p.descZh, p.shotMode, p.posePrompt, p.expressionPrompt, p.imageRef, p.publicUrl);
      }
      for (const c of validCostumes) {
        upsertCostume.run(c.id, c.slot, c.category, c.name, c.color, c.material, JSON.stringify(c.styleTags), c.descZh, c.visualPrompt, c.swatch, c.imageRef, c.publicUrl, c.extractedMode);
      }
    })();
    console.log(`✓ 已幂等导入本地 SQLite：${validPoses.length} 款实图姿势 + ${validCostumes.length} 款实图穿搭`);
  }

  console.log('🎉 全部同步完成！示例 CDN 链接：');
  if (validPoses[0]?.publicUrl) console.log('  姿势示例:', validPoses[0].publicUrl);
  if (validCostumes[0]?.publicUrl) console.log('  服装示例:', validCostumes[0].publicUrl);
  if (r2Cfg.publicUrl) console.log('  提示词总表:', `${r2Cfg.publicUrl}/catalog/posewear_costumes_all_prompts.json`);
}

main().catch(err => {
  console.error('❌ 同步失败:', err);
  process.exit(1);
});
