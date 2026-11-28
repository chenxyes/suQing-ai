/**
 * 三层虚拟约会与相处框架自动化回归测试：
 *   1. Layer 1：presence_mode（local / ldr / digital）提示词、持久化与 persona_export 导出导入往返
 *   2. Layer 2：现实拍图云约会识别（云饭搭子 / 云逛街买手 / 赛博合影）
 *   3. Layer 3：约会剧场启停、数字衣橱穿搭快照绑定、场景锁定、ReplyReview 剧场放行（与非约会零回归）、
 *      结束结算写入高权重共同记忆 + 自动核销匹配 open_loops + 场景重置
 *   4. 任务 1 × 任务 2 联动：周末衣橱穿戴回访彩蛋提示
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiyu-date-mode-'));
process.env.XIYU_DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.BEHAVIOR_ENABLED = 'true';

const {
  getDb,
  getCompanionById,
  createWardrobeItem,
  saveOpenLoop,
  listOpenLoops,
  getRecallableMemories,
} = await import('../src/db.mjs');
const {
  buildPresenceModeHint,
  detectDateModeSignal,
  detectCloudDatePhotoContext,
  startDateSession,
  buildDateSessionPromptBlock,
  settleDateSession,
  handleInboundDateTurn,
  buildWeekendWardrobeBoomerangHint,
  setCompanionPresenceMode,
  getDateModeOverview,
  saveUserPortraitReference,
  getUserPortraitReference,
  clearUserPortraitReference,
  buildDatePhotoPrompt,
} = await import('../src/date_mode.mjs');
const { buildCompanionExport, importCompanionForUser } = await import('../src/persona_export.mjs');
const { reviewGroundedReply } = await import('../src/reply_review.mjs');

const db = getDb();
db.pragma('foreign_keys = OFF');
db.prepare("INSERT INTO users (id, wechat_user_id) VALUES (1, 'wx_date_test_user')").run();
db.prepare("INSERT INTO companions (id, user_id, bot_id, name, age, role_title, relationship_stage, memory_enabled) VALUES (1, 1, 'bot_date_test', '苏晴', 20, '大二女生', '恋人', 1)").run();
const user = { id: 1 };
const comp = getCompanionById(1);

// 1. Layer 1: presence_mode 提示词与持久化
assert.equal(buildPresenceModeHint({ presence_mode: 'local' }), '', 'local 模式默认不注入额外底盘提示');
const ldrHint = buildPresenceModeHint({ presence_mode: 'ldr' });
assert.ok(ldrHint.includes('异地恋'), 'ldr 模式应注入异地恋底盘');
assert.ok(!ldrHint.includes('用户'), 'ldr 提示词禁止出现禁用称谓');
const digitalHint = buildPresenceModeHint({ presence_mode: 'digital' });
assert.ok(digitalHint.includes('隔屏陪伴'), 'digital 模式应注入隔屏陪伴底盘');

assert.equal(setCompanionPresenceMode(comp.id, 'ldr'), 'ldr');
assert.equal(getCompanionById(comp.id).presence_mode, 'ldr');

// persona_export 导出 + 导入往返保留 presence_mode
const exported = buildCompanionExport(comp.id);
assert.equal(exported.companion.presence_mode, 'ldr', '导出 JSON 应包含 presence_mode=ldr');
const imported = await importCompanionForUser(user.id, null, 'bot_date_import', exported);
assert.equal(getCompanionById(imported.companionId).presence_mode, 'ldr', '导入后应保留 presence_mode=ldr');

// 2. Layer 2: 云约会拍图识别
assert.equal(
  detectCloudDatePhotoContext('[他发了一张图片，内容：餐厅餐桌上的火锅和菜单]', '帮我看看点哪个锅底')?.kind,
  'cloud_meal',
  '美食/菜单照应识别为 cloud_meal',
);
assert.equal(
  detectCloudDatePhotoContext('[他发了一张图片，内容：商场服装店橱窗和试衣镜]', '逛街看到这家店')?.kind,
  'cloud_walk',
  '橱窗/试衣镜照应识别为 cloud_walk',
);
assert.equal(
  detectCloudDatePhotoContext('[他发了一张图片，内容：咖啡馆木桌对面空座位]', '坐我对面合个影吧')?.kind,
  'cyber_group_photo',
  '合影请求应识别为 cyber_group_photo',
);

// 3. 自然触发信号测试（保守防误触发）
assert.equal(detectDateModeSignal('明天一起去逛商场吧', { hasActiveSession: false }), null, '未来约定不应立刻开启约会剧场');
const startSig = detectDateModeSignal('我到你楼下啦，走吧一起逛商场！', { hasActiveSession: false });
assert.equal(startSig?.action, 'start');
assert.equal(startSig?.activityType, 'shopping');
const endSig = detectDateModeSignal('我安全到家啦，今天逛得好开心', { hasActiveSession: true });
assert.equal(endSig?.action, 'end');
const casualEndSig = detectDateModeSignal('好啦好啦，今天就先这样啦', { hasActiveSession: true });
assert.equal(casualEndSig?.action, 'end', '自然口语“今天就先这样啦”在约会进行中应自动触发结算结束');
assert.equal(detectDateModeSignal('好啦好啦，今天就先这样啦', { hasActiveSession: false }), null, '非约会状态下不应误触发');

// 4. 任务 1 × 任务 2 联动：种入数字衣橱穿戴单品 + 周末回访彩蛋 + open_loop
const giftItem = createWardrobeItem({
  companionId: comp.id,
  slot: 'outerwear',
  category: '外套',
  name: '奶白色羊羔毛外套',
  color: '奶白色',
  visualPrompt: 'cream white shearling fleece jacket',
  giftedBy: 'user',
  status: 'wearing',
});
assert.ok(giftItem?.id);

assert.equal(buildWeekendWardrobeBoomerangHint(comp.id, { isWeekend: false }), '', '工作日不触发周末衣橱回访');
const weekendHint = buildWeekendWardrobeBoomerangHint(comp.id, { isWeekend: true });
assert.ok(weekendHint.includes('奶白色羊羔毛外套'), '周末日程应带上他送的数字衣橱单品回访彩蛋');

saveOpenLoop({
  companionId: comp.id,
  title: '周末一起去商场逛街挑衣服',
  loopKind: 'appointment',
  emotionalWeight: 70,
});
saveOpenLoop({
  companionId: comp.id,
  title: '下周三交实验报告',
  loopKind: 'user_said',
  emotionalWeight: 50,
});

// 5. Layer 3：开启约会剧场 -> 自动快照衣橱穿搭 + 锁定 current_scene
const session = startDateSession(comp.id, { activityType: 'shopping' });
assert.equal(session.status, 'active');
assert.equal(session.outfit_snapshot.length, 1, '开启约会应自动快照当前穿戴的数字衣橱单品');
assert.equal(session.outfit_snapshot[0].name, '奶白色羊羔毛外套');
assert.equal(getCompanionById(comp.id).current_scene, session.scene, '开启约会应锁定 companions.current_scene');

const datePrompt = buildDateSessionPromptBlock(session);
assert.ok(datePrompt.includes('周末一起逛商场') && datePrompt.includes('奶白色羊羔毛外套'), '剧场 Prompt 应包含约会主题与穿搭快照');
const datePromptWithPhoto = buildDateSessionPromptBlock({ ...session, photo_paths: ['couple_1.png'] });
assert.ok(datePromptWithPhoto.includes('已经一起拍好并看过了 1 张合影'), '拍完合影后 Prompt 应明确告知她已看过照片');

// 6. ReplyReview 剧场放行 vs 非约会严格审查零回归
const baseContext = {
  version: 1,
  current: { role: 'user', text: '你现在在干嘛呀？' },
  history: [],
  facts: [],
  events: [],
  unknown: [],
  state: {
    activity: {
      now: '2026-11-28 14:20',
      scene: null,
      scheduled: { time: '14:00', activity: '约闺蜜去图书馆自习' },
    },
  },
};
const keepJudge = async () => ({ text: JSON.stringify({ decision: 'keep', reasons: [] }) });

// 6a. 约会剧场进行中：不覆写为独处日程，也不裁切剧场内的现场动作
const inDateOutcome = await reviewGroundedReply({
  draft: '我刚试了那件外套，站在镜子前面等你夸我呢！',
  context: {
    ...baseContext,
    state: {
      ...baseContext.state,
      dateSession: { id: session.id, title: session.title, scene: session.scene, activityType: 'shopping' },
    },
  },
  companion: comp,
  probe: true,
}, keepJudge);
assert.equal(inDateOutcome.status, 'kept', '约会剧场中应放行现场互动，不触发独处日程覆写或旁白裁切');
assert.ok(inDateOutcome.reply.includes('镜子前面'), '约会剧场中应完整保留现场互动回复');

// 6b. 非约会状态：保持原有严格审查契约（零回归）
const soloOutcome = await reviewGroundedReply({
  draft: '正在逛街呢！',
  context: baseContext,
  companion: comp,
  probe: true,
}, keepJudge);
assert.equal(soloOutcome.status, 'revised', '非约会且无活跃历史时仍应走独处日程保护');
assert.ok(soloOutcome.reply.includes('约闺蜜去图书馆自习'), '非约会时 enforceTurnScope 保持原逻辑');

// 7. Layer 3：结束约会并自动结算 -> 写入高权重共同记忆 + 核销逛街 open_loop + 保留无关 open_loop + 重置 scene
const settled = await settleDateSession(comp.id, {
  sessionId: session.id,
  userNote: '逛得很开心还喝了奶茶',
  skipEmbedding: true,
});
assert.equal(settled.settled, true);
assert.equal(settled.session.status, 'settled');
assert.equal(settled.resolvedLoops.length, 1, '应仅核销匹配逛街/商场的 open_loop');
assert.ok(settled.resolvedLoops[0].includes('逛街'));
assert.ok(settled.memoryId > 0, '结算应写入长期共同记忆');

const remainingOpen = listOpenLoops(comp.id, { status: 'open', limit: 20 });
assert.equal(remainingOpen.length, 1, '无关的实验报告 open_loop 应保持 open');
assert.ok(remainingOpen[0].title.includes('实验报告'));

const memories = getRecallableMemories(comp.id, user.id);
const dateMem = memories.find(m => m.id === settled.memoryId);
assert.ok(dateMem && dateMem.importance === 8 && dateMem.content.includes('奶白色羊羔毛外套'), '结算记忆应记录约会与穿戴单品且 importance=8');
assert.equal(getCompanionById(comp.id).current_scene, '日常', '约会结束后 current_scene 应温和还原为日常');

// 8. handleInboundDateTurn 端到端自然开启 + 自然结算
const turnStart = await handleInboundDateTurn({
  companion: getCompanionById(comp.id),
  userText: '开启约会模式，带你去吃火锅',
  inboundImages: [],
});
assert.equal(turnStart.activeSession?.activity_type, 'dining');
const overview = getDateModeOverview(comp.id);
assert.equal(overview.presence_mode, 'ldr');
assert.equal(overview.activeSession?.id, turnStart.activeSession.id);

const turnEnd = await handleInboundDateTurn({
  companion: getCompanionById(comp.id),
  userText: '结束约会，到家啦',
  inboundImages: [],
});
assert.equal(turnEnd.activeSession, null);
assert.equal(turnEnd.settledResult?.settled, true);

// 9. 本人形象照存储与双人同框约会合影 Prompt 锁脸校验
assert.equal(getUserPortraitReference(comp.id), null);
const fakeUserBuf = Buffer.alloc(256, 7);
const savedUserRef = saveUserPortraitReference(comp.id, fakeUserBuf, 'image/jpeg');
assert.ok(savedUserRef?.fullPath && fs.existsSync(savedUserRef.fullPath));
assert.equal(getDateModeOverview(comp.id).hasUserPortrait, true);

const couplePrompt = buildDatePhotoPrompt({
  mode: 'cyber_group',
  hasCompanionRef: true,
  hasUserRef: true,
  sceneRefIndex: 3,
  outfitRefIndex: 4,
  outfitPrompt: 'black puffer jacket',
  userText: '湖边一起合影',
});
assert.ok(couplePrompt.includes('WOMAN IDENTITY LOCK') && couplePrompt.includes('Image 1'), '应强锁伴侣 Image 1 身份');
assert.ok(couplePrompt.includes('PARTNER IDENTITY LOCK') && couplePrompt.includes('Image 2'), '应强锁本人 Image 2 身份实现双人同框');
assert.ok(couplePrompt.includes('Image 3') && couplePrompt.includes('BACKGROUND SCENE BINDING'), '应绑定现实背景图 Image 3');
assert.ok(couplePrompt.includes('Image 4') && couplePrompt.includes('OUTFIT BINDING'), '应绑定衣橱穿搭图 Image 4');
assert.ok(!couplePrompt.includes('soft round full cheeks'), '有人物定妆参考图时绝不能注入通用脸部文本');
assert.equal(clearUserPortraitReference(comp.id), true);
assert.equal(getUserPortraitReference(comp.id), null);

// 10. 微信入站直接上传本人照片 + 约会进行中纯文字拍双人合影触发
const wxSaveSelf = await handleInboundDateTurn({
  companion: getCompanionById(comp.id),
  userText: '这是我的照片，以后合影用我这张',
  inboundImages: [{ buffer: fakeUserBuf, mime: 'image/jpeg' }],
});
assert.equal(wxSaveSelf.savedUserPortrait, true, '微信发本人照+口令应自动锁定本人形象照');
assert.ok(getUserPortraitReference(comp.id), '锁定后本地应存在本人形象照');

const wxDateStart = await handleInboundDateTurn({
  companion: getCompanionById(comp.id),
  userText: '开启约会模式，陪你逛商场',
  inboundImages: [],
});
assert.ok(wxDateStart.activeSession?.id);
const wxInDateSnap = await handleInboundDateTurn({
  companion: getCompanionById(comp.id),
  userText: '咱俩拍张约会合影吧',
  inboundImages: [],
});
assert.equal(wxInDateSnap.triggerDatePhoto?.mode, 'date_scene', '微信约会进行中纯文字说拍合影应触发双人约会照');

// 清理临时目录
getDb().close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('✅ date_mode_check passed (all 10 test groups green)');
