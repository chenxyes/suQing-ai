/**
 * 数字衣橱与发图送礼试穿自动化回归测试（纯离线零外部网络）。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmpDir = mkdtempSync(join(tmpdir(), 'suqing-wardrobe-check-'));
process.env.DB_PATH = join(tmpDir, 'test.db');
process.env.LOG_DIR = join(tmpDir, 'logs');
process.env.LOG_LEVEL = 'error';
process.env.PHOTO_VISUAL_IDENTITY_DIR = join(tmpDir, 'visuals');

let db;
let server;
try {
  const database = await import('../src/db.mjs');
  const wardrobe = await import('../src/wardrobe.mjs');
  const { buildSystemPrompt } = await import('../src/companion.mjs');
  const { buildGroundedReplyPrompt } = await import('../src/reply_prompt.mjs');
  const { customImage } = await import('../src/providers/custom.mjs');

  db = database.getDb();
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO users (id, wechat_user_id) VALUES (1, 'wxu_w1')").run();
  db.prepare("INSERT INTO companions (id, user_id, bot_id, name, clothing_style) VALUES (1, 1, 'bot1', '苏晴', '学生装')").run();
  const companion = database.getCompanionById(1);

  // ── 1. 意图识别 ─────────────────────────────────────────────────────────────
  assert.equal(wardrobe.detectGiftOrTryonIntent('给小晴买的新裙子，试试看', { hasInboundImage: true }).kind, 'tryon_now');
  assert.equal(wardrobe.detectGiftOrTryonIntent('刚给你下单了这双小白鞋，等快递到', { hasInboundImage: true }).kind, 'order_delivery');
  assert.equal(wardrobe.detectGiftOrTryonIntent('送你的奶白色腋下包', { hasInboundImage: true }).kind, 'gift_instant');
  assert.equal(wardrobe.detectGiftOrTryonIntent('今天下雨好冷啊', { hasInboundImage: true }).kind, null);
  assert.equal(wardrobe.detectGiftOrTryonIntent('明天穿我上次送的白色短靴吧', { hasInboundImage: false }).kind, 'wear_request');

  // ── 2. 槽位唯一性 & 穿戴计数 ────────────────────────────────────────────────
  const coat1 = database.createWardrobeItem({
    companionId: 1, slot: 'outerwear', category: '外套', name: '奶白色针织开衫',
    color: '奶白色', visualPrompt: 'cream knit cardigan with pearl buttons', status: 'wearing',
  });
  assert.equal(coat1.status, 'wearing');
  assert.equal(coat1.wear_count, 1);

  const coat2 = database.createWardrobeItem({
    companionId: 1, slot: 'outerwear', category: '外套', name: '驼色毛呢大衣',
    color: '驼色', visualPrompt: 'camel wool coat', status: 'wearing',
  });
  assert.equal(database.getWardrobeItem(1, coat1.id).status, 'owned', '同槽位新穿单品必须将旧 wearing 降级为 owned');
  assert.equal(coat2.status, 'wearing');

  const bag = database.createWardrobeItem({
    companionId: 1, slot: 'bag', category: '包包', name: '黑色链条腋下包',
    color: '黑色', visualPrompt: 'black quilted leather shoulder bag with gold chain', status: 'wearing',
  });
  assert.equal(database.getWardrobeItem(1, coat2.id).status, 'wearing', '不同槽位互不影响');
  assert.equal(bag.status, 'wearing');

  // ── 3. ≤80 token Prompt 注入（legacy + grounded 双链路，零“用户”字眼） ───────
  const block = wardrobe.buildWardrobePromptBlock(1);
  assert.ok(block.includes('【你的数字衣橱】'));
  assert.ok(block.includes('驼色毛呢大衣') && block.includes('黑色链条腋下包'));
  assert.ok(block.includes('奶白色针织开衫'), '珍藏衣橱应展示已收纳单品');
  assert.ok(!block.includes('用户'), '严守 user_wording_guard 红线');
  assert.ok(block.length <= 240, '衣橱注入块必须精简受控');

  const legacyPrompt = buildSystemPrompt(companion, { wardrobeHint: block });
  assert.ok(legacyPrompt.includes('驼色毛呢大衣'));
  const groundedPrompt = buildGroundedReplyPrompt(companion, {
    context: { state: { activity: { localTime: '2026-11-28 15:00', period: '下午', scheduled: null, scene: null } }, facts: [], events: [] },
    wardrobeHint: block,
  });
  assert.ok(groundedPrompt.includes('黑色链条腋下包'));

  // ── 4. 按品类自动机位路由 ────────────────────────────────────────────────────
  const shoePlan = wardrobe.buildTryonPhotoPlan({ slot: 'shoes', category: '鞋子', name: '白色短靴', visual_prompt: 'white ankle boots', source_image_path: '/tmp/x.jpg' });
  assert.equal(shoePlan.shotMode, 'FULL_BODY_LOW_MIRROR');
  assert.equal(shoePlan.aspect, '3:4');
  assert.deepEqual(shoePlan.extraReferenceImagePaths, ['/tmp/x.jpg']);

  const bagPlan = wardrobe.buildTryonPhotoPlan({ slot: 'bag', category: '包包', name: '黑色腋下包', visual_prompt: 'black bag' });
  assert.equal(bagPlan.shotMode, 'SIDE_CARRY_HALF_BODY');

  const accPlan = wardrobe.buildTryonPhotoPlan({ slot: 'accessory', category: '配饰', name: '珍珠耳钉', visual_prompt: 'pearl stud earrings' });
  assert.equal(accPlan.shotMode, 'CLOSE_SELFIE');

  // ── 5. 微信入站发图送礼/试穿/下单 + 文本点名换装闭环 ──────────────────────────
  const fakeImgBuf = Buffer.alloc(256, 0xab);
  const mockRecognize = async () => JSON.stringify({
    is_fashion_item: true,
    slot: 'shoes',
    category: '鞋子',
    name: '米白色厚底小白鞋',
    color: '米白色',
    material: '帆布',
    style_tags: ['百搭', '校园'],
    visual_prompt: 'off-white platform canvas sneakers with clean rubber sole',
    reaction_detail: '厚底显得很轻盈百搭',
  });

  const tryonOut = await wardrobe.handleInboundWardrobeTurn({
    companion,
    userText: '[他发了一张图片]\n给小晴买这双鞋试试看',
    inboundImages: [{ buffer: fakeImgBuf, mime: 'image/jpeg' }],
    recognize: mockRecognize,
    visualRoot: process.env.PHOTO_VISUAL_IDENTITY_DIR,
  });
  assert.equal(tryonOut.intent, 'tryon_now');
  assert.equal(tryonOut.shouldSendTryonPhoto, true);
  assert.equal(tryonOut.item.status, 'tryon_only');
  assert.ok(tryonOut.item.source_image_path && existsSync(tryonOut.item.source_image_path), '商品原图已安全落盘');

  const orderOut = await wardrobe.handleInboundWardrobeTurn({
    companion,
    userText: '刚给你下单了这双鞋，等快递到',
    inboundImages: [{ buffer: fakeImgBuf, mime: 'image/jpeg' }],
    recognize: mockRecognize,
    visualRoot: process.env.PHOTO_VISUAL_IDENTITY_DIR,
  });
  assert.equal(orderOut.intent, 'order_delivery');
  assert.equal(orderOut.shouldSendTryonPhoto, false);
  assert.equal(orderOut.item.status, 'in_transit');
  assert.ok(orderOut.item.eta_at, '下单等快递必须生成预计到达时间');

  // ── 6. 快递到期自动拆箱巡检 ──────────────────────────────────────────────────
  database.updateWardrobeItem(1, orderOut.item.id, { etaAt: '2026-11-28 00:00:00' });
  const deliveryRes = await wardrobe.runWardrobeDeliveryTick(new Date('2026-11-28T09:00:00Z'));
  assert.equal(deliveryRes.delivered, 1, '到期包裹应自动签收并转为 wearing');
  assert.equal(database.getWardrobeItem(1, orderOut.item.id).status, 'wearing');

  // 文本点名换穿
  const wearOut = await wardrobe.handleInboundWardrobeTurn({
    companion,
    userText: '明天穿我送的奶白色针织开衫给我看看',
    inboundImages: [],
  });
  assert.equal(wearOut.intent, 'wear_request');
  assert.equal(wearOut.item.id, coat1.id);
  assert.equal(wearOut.shouldSendTryonPhoto, true);
  assert.equal(database.getWardrobeItem(1, coat1.id).status, 'wearing');

  // ── 7. customImage 多图 /images/edits 协议 & fail-open 降级 /images/generations ─
  const hits = [];
  let editMode = 'ok';
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      hits.push({ url: req.url, contentType: req.headers['content-type'] || '', hasMultiImage: body.includes('name="image[]"') });
      if (req.url.endsWith('/images/edits') && editMode === '404') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not supported' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: req.url.endsWith('/images/edits') ? 'https://example.com/edited.png' : 'https://example.com/gen.png' }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.IMAGE_PROVIDER = 'custom';
  process.env.IMAGE_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.IMAGE_API_KEY = 'test-key';
  process.env.IMAGE_MODEL = 'gpt-image-2';
  const tinyPngDataUrl = 'data:image/png;base64,' + Buffer.alloc(80, 1).toString('base64');

  const editedUrl = await customImage('try on coat', '768x1024', [tinyPngDataUrl, tinyPngDataUrl]);
  assert.equal(editedUrl, 'https://example.com/edited.png');
  assert.equal(hits.at(-1).url, '/v1/images/edits');
  assert.equal(hits.at(-1).hasMultiImage, true, '多图参考应使用 image[] multipart 字段');

  editMode = '404';
  const fallbackUrl = await customImage('try on coat', '768x1024', [tinyPngDataUrl, tinyPngDataUrl]);
  assert.equal(fallbackUrl, 'https://example.com/gen.png', '/images/edits 404 时必须 fail-open 降级 /images/generations');
  assert.equal(hits.at(-1).url, '/v1/images/generations');

  // ── 8. 高保真锁脸 Prompt + 单部位局部换装 + 多部位叠穿合拍 ───────────────────
  const singlePrompt = wardrobe.buildLayeredTryonPrompt({
    items: [coat1],
    hasFaceRef: true,
    imageBindings: [{ imageIndex: 2, item: coat1 }],
    singlePartPreserveRest: true,
  });
  assert.ok(singlePrompt.prompt.includes('IDENTITY LOCK') && singlePrompt.prompt.includes('Image 1'), '单品试穿必须把 Image 1 锁为唯一人物事实源');
  assert.ok(singlePrompt.prompt.includes('SINGLE-PART SWAP RULE'), '单部位换装应保留其余部位协调穿搭');
  assert.ok(!singlePrompt.prompt.includes('soft round full cheeks'), '有人物定妆参考图时绝不能注入通用脸部文本覆盖真实长相');

  const topLayer = database.createWardrobeItem({
    companionId: 1, slot: 'top', category: '上衣', name: '白衬衫内搭',
    color: '白色', visualPrompt: 'crisp white collared shirt', status: 'wearing',
  });
  const bagLayer = database.createWardrobeItem({
    companionId: 1, slot: 'bag', category: '包包', name: '黑色腋下包',
    color: '黑色', visualPrompt: 'black leather shoulder bag', status: 'wearing',
  });
  // 不同槽位（outerwear + top + bag）同时 wearing，不互相覆盖
  const wearingAll = database.listWardrobeItems(1, { status: 'wearing' });
  assert.ok(wearingAll.some(i => i.id === coat1.id) && wearingAll.some(i => i.id === topLayer.id) && wearingAll.some(i => i.id === bagLayer.id), '不同部位应支持同时穿戴叠穿');

  const layeredPrompt = wardrobe.buildLayeredTryonPrompt({
    items: [topLayer, coat1, bagLayer],
    hasFaceRef: true,
    imageBindings: [
      { imageIndex: 2, item: topLayer },
      { imageIndex: 3, item: coat1 },
      { imageIndex: 4, item: bagLayer },
    ],
    singlePartPreserveRest: false,
  });
  assert.ok(layeredPrompt.prompt.includes('LAYERING RULE'), '多件叠穿必须包含叠穿层次约束');
  assert.ok(layeredPrompt.prompt.includes('Image 2') && layeredPrompt.prompt.includes('Image 3') && layeredPrompt.prompt.includes('Image 4'), '多件叠穿应逐一编号绑定参考图');

  // 脱下（unwear）单个部位，保留其他部位继续穿着
  database.updateWardrobeItem(1, bagLayer.id, { status: 'owned' });
  const afterUnwear = database.listWardrobeItems(1, { status: 'wearing' });
  assert.ok(!afterUnwear.some(i => i.id === bagLayer.id) && afterUnwear.some(i => i.id === topLayer.id) && afterUnwear.some(i => i.id === coat1.id), '脱下单部位不应影响其他在穿部位');

  console.log('wardrobe_tryon_check: all wardrobe, try-on, delivery, face-lock and layering assertions passed');
} finally {
  server?.close();
  db?.close();
  rmSync(tmpDir, { recursive: true, force: true });
}
