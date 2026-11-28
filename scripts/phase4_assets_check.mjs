/**
 * Phase 4-A+ 自动化回归测试（纯离线零外部网络）：
 *   1. Cloudflare R2 零依赖 SigV4 客户端（端点尾随桶名自动规范化、mock S3 PUT/GET/DELETE 往返、本地降级兜底）
 *   2. 自定义图文姿势库 & 服装灵感预设库 SQLite CRUD 与内置目录合并排序
 *   3. 截图一键扒同款（Vision 多槽位拆解 + 去人去背景平铺 Prompt + GARMENT_EXTRACT_MODEL 轻量档转发）
 *   4. 真实姿势参考图在试穿（wardrobe.mjs）与双人合影（date_mode.mjs）中的编号绑定与防串脸指令
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmpDir = mkdtempSync(join(tmpdir(), 'suqing-phase4a-plus-'));
process.env.DB_PATH = join(tmpDir, 'test.db');
process.env.LOG_DIR = join(tmpDir, 'logs');
process.env.LOG_LEVEL = 'error';
process.env.PHOTO_VISUAL_IDENTITY_DIR = join(tmpDir, 'visuals');
delete process.env.R2_ENDPOINT;
delete process.env.R2_BUCKET;
delete process.env.R2_ACCESS_KEY_ID;
delete process.env.R2_SECRET_ACCESS_KEY;
delete process.env.R2_PUBLIC_URL;

let db;
let s3Server;
try {
  const database = await import('../src/db.mjs');
  const storage = await import('../src/storage.mjs');
  const library = await import('../src/pose_outfit_library.mjs');
  const extractor = await import('../src/garment_extractor.mjs');
  const wardrobe = await import('../src/wardrobe.mjs');
  const dateMode = await import('../src/date_mode.mjs');

  db = database.getDb();

  // ── 1. 本地存储兜底（未配置 R2 时）──────────────────────────────────────────
  assert.equal(storage.isR2Configured(), false);
  assert.equal(storage.getStorageStatus().driver, 'local');
  const localSaved = await storage.storeAssetBuffer('presets/test/local.jpg', Buffer.from('local-img-bytes'), {
    contentType: 'image/jpeg',
    localRoot: join(tmpDir, 'assets'),
  });
  assert.equal(localSaved.driver, 'local');
  assert.ok(existsSync(localSaved.imageRef));
  const localRead = await storage.readAssetBuffer(localSaved.imageRef);
  assert.equal(localRead.buffer.toString('utf8'), 'local-img-bytes');
  assert.equal(await storage.deleteAsset(localSaved.imageRef), true);

  // ── 2. Cloudflare R2 SigV4 Mock S3 服务器全流程 + 尾随桶名自动规范化 ────────
  const store = new Map();
  const seenAuth = [];
  s3Server = http.createServer((req, res) => {
    seenAuth.push({ method: req.method, url: req.url, auth: req.headers.authorization || '' });
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'PUT') {
        store.set(req.url, { body, ct: req.headers['content-type'] || 'application/octet-stream' });
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === 'GET') {
        const hit = store.get(req.url);
        if (!hit) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': hit.ct });
        res.end(hit.body);
        return;
      }
      if (req.method === 'DELETE') {
        store.delete(req.url);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(405);
      res.end();
    });
  });
  await new Promise(resolve => s3Server.listen(0, '127.0.0.1', resolve));
  const s3Port = s3Server.address().port;

  // 故意在 R2_ENDPOINT 末尾带上 /suqing-assets，验证自动去重
  process.env.R2_ENDPOINT = `http://127.0.0.1:${s3Port}/suqing-assets`;
  process.env.R2_BUCKET = 'suqing-assets';
  process.env.R2_ACCESS_KEY_ID = 'ak_test_123';
  process.env.R2_SECRET_ACCESS_KEY = 'sk_test_456';
  process.env.R2_PUBLIC_URL = 'https://assets.example.com';

  const cfg = storage.getR2Config();
  assert.equal(cfg.endpoint, `http://127.0.0.1:${s3Port}`, 'R2_ENDPOINT 末尾的 /<bucket> 必须自动剥离避免双路径');
  assert.equal(storage.isR2Configured(), true);
  assert.equal(storage.getStorageStatus().driver, 'r2');

  const r2Saved = await storage.storeAssetBuffer('presets/garments/top/test_flat.jpg', Buffer.from('r2-flatlay-bytes'), {
    contentType: 'image/jpeg',
  });
  assert.equal(r2Saved.driver, 'r2');
  assert.equal(r2Saved.imageRef, 'r2://presets/garments/top/test_flat.jpg');
  assert.equal(r2Saved.publicUrl, 'https://assets.example.com/presets/garments/top/test_flat.jpg');
  assert.ok(seenAuth.at(-1).auth.startsWith('AWS4-HMAC-SHA256 Credential=ak_test_123/'), '请求必须携带合法 AWS SigV4 签名');
  assert.equal(seenAuth.at(-1).url, '/suqing-assets/presets/garments/top/test_flat.jpg', '路径不应出现重复桶名');

  const r2Read = await storage.readAssetBuffer(r2Saved.imageRef);
  assert.equal(r2Read.buffer.toString('utf8'), 'r2-flatlay-bytes');
  const probeRes = await storage.testR2Connection();
  assert.equal(probeRes.ok, true);
  assert.equal(await storage.deleteAsset(r2Saved.imageRef), true);

  // ── 3. 自定义图文姿势库 & 服装预设库 CRUD + 目录合并 ────────────────────────
  const customPose = database.createCustomPose({
    id: 'cpose_test_1',
    kind: 'solo',
    label: '小红书复古回眸',
    tag: '氛围感',
    framingLabel: '半身实图',
    descZh: '侧身微回眸轻托耳畔发丝',
    shotMode: 'MIRROR_SELFIE',
    posePrompt: 'turning sideways over shoulder with gentle hand near cheek',
    expressionPrompt: 'warm candid smile',
    imageRef: 'r2://presets/poses/solo/cpose_test_1.jpg',
    publicUrl: 'https://assets.example.com/presets/poses/solo/cpose_test_1.jpg',
  });
  const customPreset = database.createCustomOutfitPreset({
    id: 'coutfit_test_1',
    slot: 'outerwear',
    category: '外套',
    name: '美拉德复古皮衣',
    color: '深棕色',
    material: '软皮',
    styleTags: ['美拉德', '甜酷'],
    descZh: '复古深棕翻领短款机车皮衣',
    visualPrompt: 'vintage dark brown cropped leather jacket with lapel collar',
    swatch: '#5C3A21',
    imageRef: 'r2://presets/garments/outerwear/coutfit_test_1.jpg',
    publicUrl: 'https://assets.example.com/presets/garments/outerwear/coutfit_test_1.jpg',
    extractedMode: 'flatlay',
  });

  const catalog = library.getPoseAndOutfitCatalog();
  assert.equal(catalog.soloPoses[0].id, customPose.id, '自定义姿势应置顶展示');
  assert.equal(catalog.soloPoses[0].isCustom, true);
  assert.equal(catalog.soloPoses[0].previewUrl, customPose.publicUrl);
  assert.equal(catalog.outfitPresets[0].id, customPreset.id, '自定义服装预设应置顶展示');
  assert.equal(catalog.outfitPresets[0].extractedMode, 'flatlay');
  assert.equal(library.getPoseById(customPose.id)?.id, customPose.id);
  assert.equal(library.getOutfitPresetById(customPreset.id)?.id, customPreset.id);
  assert.ok(!JSON.stringify(catalog).includes('用户'), '合并后的目录严禁出现禁用称谓');

  // ── 4. 截图一键扒同款（Vision 拆解 + 低价平铺模型转发）─────────────────────
  const fakeShot = Buffer.alloc(128, 0x33);
  const detected = await extractor.detectOutfitsInScreenshot(fakeShot, 'image/jpeg', {
    recognize: async () => JSON.stringify({
      items: [
        { slot: 'outerwear', category: '外套', name: '卡其色长款风衣', color: '卡其色', material: '纯棉斜纹', swatch: '#C2A887', style_tags: ['气质', '通勤'], desc_zh: '双排扣系带卡其风衣', visual_prompt: 'classic khaki double-breasted belted trench coat' },
        { slot: 'bag', category: '包包', name: '棕色托特通勤包', color: '深棕色', material: '牛皮', swatch: '#6B4423', style_tags: ['百搭'], desc_zh: '大容量复古棕色托特包', visual_prompt: 'structured brown leather tote handbag' },
      ],
    }),
  });
  assert.equal(detected.length, 2);
  assert.equal(detected[0].slot, 'outerwear');
  assert.equal(detected[1].slot, 'bag');

  const flatPrompt = extractor.buildFlatlayExtractionPrompt(detected[0]);
  assert.ok(flatPrompt.includes('GHOST-MANNEQUIN') && flatPrompt.includes('Completely remove ALL human anatomy'), '平铺提取 Prompt 必须要求彻底去人去背景');

  process.env.GARMENT_EXTRACT_MODEL = 'gpt-image-1-mini';
  let capturedGenOpts = null;
  const tinyPngDataUrl = 'data:image/png;base64,' + Buffer.alloc(96, 2).toString('base64');
  const flatOut = await extractor.extractGarmentFlatlayImage(fakeShot, 'image/jpeg', detected[0], {
    generateImage: async (_p, opts) => {
      capturedGenOpts = opts;
      return tinyPngDataUrl;
    },
  });
  assert.equal(capturedGenOpts.model, 'gpt-image-1-mini', '配置 GARMENT_EXTRACT_MODEL 后应优先走低价独立模型');
  assert.equal(capturedGenOpts.size, '1024x1024', '平铺提取应使用 1024x1024 轻量尺寸');
  assert.equal(capturedGenOpts.inputFidelity, 'low', '平铺提取应使用低成本档');
  assert.equal(capturedGenOpts.background, 'transparent', '平铺提取应优先请求原生透明背景');
  assert.equal(capturedGenOpts.skipBeautify, true, '纯白底平铺商品图应跳过人像美颜滤镜');
  assert.ok(flatOut.buffer.length > 0);

  // ── 4b. 边界泛洪白底转真透明 PNG 校验（外部纯白变透明，内部白衬衫保持不透明）─
  const sharp = (await import('sharp')).default;
  const w = 32; const h = 32;
  const rawImg = Buffer.alloc(w * h * 3, 255); // 全白背景
  // 中央画一个深色边框包围的白衬衫区域（模拟海军领黑西装 + 白内搭）
  for (let y = 8; y < 24; y++) {
    for (let x = 8; x < 24; x++) {
      const isBorder = y <= 10 || y >= 21 || x <= 10 || x >= 21;
      const o = (y * w + x) * 3;
      if (isBorder) { rawImg[o] = 25; rawImg[o + 1] = 35; rawImg[o + 2] = 60; }
      else { rawImg[o] = 255; rawImg[o + 1] = 255; rawImg[o + 2] = 255; } // 内部白色衬衫
    }
  }
  const syntheticWhitePng = await sharp(rawImg, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  const transparentOut = await extractor.removeWhiteBackgroundToTransparentPng(syntheticWhitePng);
  const { data: outRgba } = await sharp(transparentOut).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(outRgba[3], 0, '左上角纯白背景像素必须被抠成 alpha=0 透明');
  const centerIdx = (16 * w + 16) * 4;
  assert.equal(outRgba[centerIdx + 3], 255, '被深色衣领包围的内部白色衬衫必须保持完全不透明');

  // ── 4c. 衣橱主理人自主搭配（SuQing Stylist Autonomy）校验 ──────────────────
  const stylist = await import('../src/wardrobe_stylist.mjs');
  assert.equal(stylist.detectAutonomousStyleRequest('今天穿什么你自己决定吧，拍一张给我看')?.wantPhoto, true);
  assert.equal(stylist.detectAutonomousStyleRequest('你自己挑一身喜欢的穿搭')?.kind, 'autonomous_style');
  assert.equal(stylist.detectAutonomousStyleRequest('今天天气不错'), null);

  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO users (id, wechat_user_id) VALUES (99, 'wx_stylist_test')").run();
  db.prepare("INSERT INTO companions (id, user_id, bot_id, name, current_mood) VALUES (99, 99, 'bot99', '苏晴', '开心')").run();
  const comp99 = database.getCompanionById(99);
  const ownedA = database.createWardrobeItem({
    companionId: 99, slot: 'top', category: '上衣', name: '白衬衫', visualPrompt: 'white shirt', status: 'wearing',
  });
  const ownedB = database.createWardrobeItem({
    companionId: 99, slot: 'outerwear', category: '外套', name: '奶白开衫', visualPrompt: 'cream cardigan', status: 'owned',
  });
  const ownedC = database.createWardrobeItem({
    companionId: 99, slot: 'bottom_or_dress', category: '裙子', name: '藏青百褶裙', visualPrompt: 'navy pleated skirt', status: 'owned',
  });
  const picked = await stylist.decideSuQingOutfitAndPose(comp99, { occasion: '校园日常' }, {
    extractJson: async () => JSON.stringify({
      source: 'wardrobe',
      wardrobe_ids: [ownedB.id, ownedC.id],
      preset_id: '',
      pose_id: 'mirror_peace',
      stylist_note: '今天想走温柔学院风，自己把奶白开衫和藏青百褶裙搭一块啦～',
    }),
  });
  assert.equal(picked.items.length, 2, '苏晴应自主选中 2 件叠穿');
  assert.equal(picked.pose?.id, 'mirror_peace', '苏晴应自主选定拍照姿势');
  assert.equal(database.getWardrobeItem(99, ownedA.id).status, 'owned', '自主换装应自动脱下旧穿搭');
  assert.equal(database.getWardrobeItem(99, ownedB.id).status, 'wearing');
  assert.equal(database.getWardrobeItem(99, ownedC.id).status, 'wearing');
  assert.ok(stylist.getWardrobeStylistNote(99)?.note.includes('温柔学院风'), '应持久化主理人搭配笔记');
  assert.ok(!JSON.stringify(picked).includes('用户'), '主理人搭配输出严禁包含禁用称谓');

  // 验证主理人搭配笔记写入常驻衣橱 Prompt，且“看看今天穿了什么拍张照”触发 today_ootd_photo 并带自选姿势
  const promptBlock = wardrobe.buildWardrobePromptBlock(99);
  assert.ok(promptBlock.includes('搭配小心思：') && promptBlock.includes('温柔学院风'), '常驻衣橱 Prompt 应包含苏晴的今日搭配小心思');
  assert.ok(stylist.detectTodayOotdPhotoRequest('看看你今天穿了什么，拍一张给我')?.kind === 'today_ootd_photo');
  const ootdTurn = await wardrobe.handleInboundWardrobeTurn({
    companion: comp99,
    userText: '拍张今日穿搭给我看看呗',
    inboundImages: [],
  });
  assert.equal(ootdTurn?.intent, 'today_ootd_photo');
  assert.equal(ootdTurn?.shouldSendTryonPhoto, true);
  assert.equal(ootdTurn?.poseId, 'mirror_peace', '今日穿搭拍照应自动沿用苏晴自己选定的姿势');

  // 验证精选预设入柜去重匹配（有 preset_id 严格按 id；旧数据按 slot+name+visual_prompt 精确匹配，同名不同款绝不误撞）
  const presetOwned = database.createWardrobeItem({
    companionId: 99,
    slot: 'bottom_or_dress',
    category: '裙子',
    name: '短款连衣裙',
    visualPrompt: 'red velvet mini dress with black tights',
    presetId: 'preset_red_mini_dress',
    status: 'wearing',
  });
  assert.equal(database.findWardrobeItemByPreset(99, {
    id: 'preset_red_mini_dress', slot: 'bottom_or_dress', name: '短款连衣裙', visualPrompt: 'red velvet mini dress with black tights',
  })?.id, presetOwned.id);
  assert.equal(database.findWardrobeItemByPreset(99, {
    id: 'preset_black_mini_dress', slot: 'bottom_or_dress', name: '短款连衣裙', visualPrompt: 'black mini dress with green heels',
  }), null, '同名不同款（不同 preset_id）绝不能误匹配为同一件');
  assert.equal(database.findWardrobeItemByPreset(99, {
    id: 'legacy_preset_id', slot: 'outerwear', name: '奶白开衫', visualPrompt: 'cream cardigan',
  })?.id, ownedB.id, '迁移前旧数据（preset_id 为空）按 slot+name+visual_prompt 精确匹配');
  assert.equal(database.findWardrobeItemByPreset(99, {
    id: 'legacy_preset_other', slot: 'outerwear', name: '奶白开衫', visualPrompt: 'different cream cardigan with hood',
  }), null, '迁移前旧数据同名但 visual_prompt 不同绝不误匹配');
  database.deleteWardrobeItem(99, presetOwned.id);
  assert.equal(database.findWardrobeItemByPreset(99, {
    id: 'preset_red_mini_dress', slot: 'bottom_or_dress', name: '短款连衣裙', visualPrompt: 'red velvet mini dress with black tights',
  }), null, '移出展柜后应恢复可再次收入');

  // ── 5. 实图姿势参考编号绑定与防串脸校验 ─────────────────────────────────────
  const soloPoseRefPrompt = wardrobe.buildLayeredTryonPrompt({
    items: [{ id: 1, slot: 'outerwear', category: '外套', name: '美拉德皮衣', visual_prompt: 'brown leather jacket' }],
    hasFaceRef: true,
    imageBindings: [{ imageIndex: 2, item: { id: 1, slot: 'outerwear', category: '外套', name: '美拉德皮衣', visual_prompt: 'brown leather jacket' } }],
    poseId: customPose.id,
    poseRefIndex: 3,
  });
  assert.ok(soloPoseRefPrompt.prompt.includes('POSE & FRAMING REFERENCE ONLY (Image 3)'), '单人实图姿势应编号绑定并禁止串脸串衣');

  const couplePoseRefPrompt = dateMode.buildDatePhotoPrompt({
    mode: 'date_scene',
    hasCompanionRef: true,
    hasUserRef: true,
    poseId: customPose.id,
    poseRefIndex: 3,
    presetScenePrompt: 'cozy cafe',
  });
  assert.ok(couplePoseRefPrompt.includes('POSE & FRAMING REFERENCE ONLY (Image 3)'), '双人实图姿势应编号绑定并禁止串脸串衣');

  assert.ok(database.deleteCustomPose(customPose.id));
  assert.ok(database.deleteCustomOutfitPreset(customPreset.id));

  console.log('✅ phase4_assets_check passed (R2 SigV4, custom catalog, garment extractor, pose-ref bindings all green)');
} finally {
  s3Server?.close();
  db?.close();
  rmSync(tmpDir, { recursive: true, force: true });
}
