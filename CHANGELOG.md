# Changelog

所有重要修复与功能变更均按时间倒序登记于此。

---

## [1.23.0] - 2026-11-28

### Fixed
- **精选服装灵感库「收入展柜 / 穿着中」唯一绑定、防重复与置灰态同步（`src/db.mjs`、`src/api.mjs`、`src/pose_outfit_library.mjs`、`src/wardrobe_stylist.mjs`、`public/app/dashboard.js`、`public/app/dashboard.css`）**：
  - `companion_wardrobe` 增量补齐 `preset_id` 字段并在迁移时按 `slot + name + visual_prompt` 自动为历史藏品精确回填唯一 `preset_id`；`findWardrobeItemByPreset()` 严格按 `preset_id` 唯一匹配（无 `preset_id` 的旧数据仅按 `slot + name + visual_prompt` 三重精确匹配），彻底避免多款同名预设（如多条“短款连衣裙”）互相撞车。
  - `POST /api/companions/:id/wardrobe/preset` 改为幂等去重，已入柜单品不重复建档，点「立即穿上」时直接复用已有藏品；灵感库卡片与展柜状态实时联动，已入柜按钮置灰禁用为「✓ 已入展柜」，正在穿着显示「✨ 穿着中」，移出展柜后自动恢复可点击。

### Added

#### Phase 4-A++ · 真透明背景抠图平铺修复 + 苏晴「衣橱主理人」自主搭配与选姿势
- **截图抠图透明背景 PNG 修复（`src/garment_extractor.mjs`、`src/providers/custom.mjs`、`src/providers/image.mjs`、`src/providers/vision.mjs`、`public/app/dashboard.html`、`public/app/dashboard.js`）**：
  - 修复截图识别偶发 Vision 超时（压缩识别图至 768px 并将自定义 Vision 超时放宽至 55s）以及前端默认选中「原图快速入库」导致未触发抠图的问题：现默认选中「✨ 去人去背景透明平铺 PNG（推荐）」，并在超时或提取降级时向界面清晰提示原因、不再静默吞错。
  - `customImage()` 支持透传 `background=transparent` 与 `output_format=png`（上游不支持时自动平滑重试）；新增 `removeWhiteBackgroundToTransparentPng()` 边界 4-连通泛洪去背与 1px 柔边羽化算法，确保输出真正的 RGBA 透明背景 PNG，同时完整保护服装内部的白色领口与内搭衬衫不被误抠。
- **苏晴「衣橱主理人」自主穿搭与选姿势（`src/wardrobe_stylist.mjs`、`src/wardrobe.mjs`、`src/bot.mjs`、`src/plan_tasks.mjs`、`src/api.mjs`、`public/app/dashboard.*`、`public/app/playground.html`）**：
  - 新增 `src/wardrobe_stylist.mjs`：由苏晴结合当前季节、心情、今日日程与衣橱/灵感库藏品，自主决定今天穿什么、如何叠穿、摆什么拍照姿势，并写下第一人称「主理人搭配笔记」。
  - 接入每日 07:30 晨间自主换装（`plan_tasks.mjs`）、控制台展柜顶栏「👑 让苏晴自己搭」一键入口与今日上身台「主理人搭配笔记」展示，以及微信/网页聊天自然触发（如“今天穿什么你自己决定吧 / 你自己挑一身拍给我看”与“看看你今天穿了什么，拍一张给我”），自动沿用她自选的穿搭与姿势发来 OOTD 照；`buildWardrobePromptBlock()` 同步注入她的今日搭配小心思，且截图提取预览支持行内直接修改单品名称。
- **中英文 README 重写（`README.md`、`README.en.md`）**：全面同步数字衣橱、主理人自主穿搭、透明背景抠图、可视化姿势库、Cloudflare R2 双模存储、三层虚拟约会与双人合影、极光/暗夜双玻璃主题及完整目录/验证指令，中英功能表行数与发布一致性门禁完全对齐。
- **回归测试（`scripts/phase4_assets_check.mjs`）**：补充白底转真透明 PNG 边界泛洪不误伤内部白衬衫的像素级断言，以及苏晴自主搭配意图识别与决策落库断言。

#### Phase 4-A+ · Cloudflare R2 云图床 + 截图一键扒同款 + 自定义实图姿势/服装库
- **零依赖 Cloudflare R2 / 本地双模对象存储（`src/storage.mjs`）**：
  - 基于 Node 原生 `crypto` 实现标准 AWS SigV4（`PUT / GET / DELETE`）S3 协议客户端，自动兼容 `R2_ENDPOINT` 末尾带或不带 `/<bucket>` 的写法，支持 `R2_PUBLIC_URL` 自定义域 CDN 直链（如 `https://assets.charlexys.com`）与后端私密鉴权代理双模式，未配置 R2 时自动回落本地磁盘。
  - 试穿大片与双人约会合影落盘后自动静默镜像备份至 R2（`companions/<id>/wardrobe/` 与 `companions/<id>/dates/`）。
- **截图一键扒同款 & 姿势实图智能解析（`src/garment_extractor.mjs`、`src/providers/custom.mjs`、`src/providers/image.mjs`）**：
  - 支持上传任意穿搭截图 → Vision 自动拆解出多件分槽位单品清单（勾选单件或整套）；
  - 提供「⚡ 原图快速入库（零生图费）」与「✨ 去人去背景生成纯白底电商平铺图（Ghost Mannequin，消除模特人脸干扰）」双模式；支持独立低价环境变量 `GARMENT_EXTRACT_MODEL`（默认使用 `1024x1024` 轻量档并跳过人像美颜滤镜）。
- **自定义实图姿势库 & 服装库（`src/db.mjs`、`src/pose_outfit_library.mjs`、`src/wardrobe.mjs`、`src/date_mode.mjs`、`src/api.mjs`）**：
  - 新增 `custom_pose_library` 与 `custom_outfit_presets` 表及完整 CRUD，与内置目录自动合并（用户收藏实图置顶展示）。
  - 选中带实图的自定义姿势时，试穿大片与双人约会合影将实图作为独立编号参考图传入 `/images/edits`，注入严格的「仅借鉴动作与构图、绝不复制原图人物与衣物」指令；一键穿上自定义服装预设时自动携带高清商品原图参与试穿。
  - 新增 `/api/storage/{status,test-r2}`、`/api/wardrobe/catalog/asset/:kind/:assetId`、`/api/wardrobe/catalog/poses`、`/api/wardrobe/catalog/extract-{preview,save}` 与删除接口。
- **前端界面、一键换装联动与自动化回归（`public/app/dashboard.*`、`public/app/playground.html`、`scripts/phase4_assets_check.mjs`、`.github/workflows/ci.yml`）**：
  - 控制台服装灵感库新增 R2 状态标识与「✂️ 截图扒同款」折叠面板；单人试穿与双人约会姿势条均新增「＋ 上传姿势图」与自定义卡片删除能力；网页聊天室同步展示自定义双人姿势实图。
  - 修复服装灵感库点击「👗 立即穿上」时旧穿着衣物未自动脱下且不自动生图的问题：`createWardrobeItem` / `wearWardrobeItem` 支持原子脱下旧在穿衣物（`replaceAllWearing`），整套穿搭自动走 `FULL OUTFIT TRANSFER RULE` 全身迁移指令，点击「👗 立即穿上」后自动脱下旧装、触发高保真试穿图生成并实时刷新展示柜与左侧人物舞台。
  - 新增 `scripts/phase4_assets_check.mjs` 离线回归测试并接入 CI；新增 `scripts/sync_posewear_r2.mjs` 可复用同步工具，支持按严格安全（SFW）过滤将姿势图、四季/礼服穿搭图与完整中英提示词目录低并发同步至用户自有 Cloudflare R2 并幂等导入本地 SQLite。

#### Phase 4-A · 姿势库（单人试穿 + 双人约会合影）+ 精选服装灵感预设库
- **姿势与服装灵感目录（`src/pose_outfit_library.mjs`）**：
  - 内置 10 款单人试穿/叠穿姿势（对镜比耶、回眸轻笑、插兜酷girl、轻撩碎发、侧身秀包、窗边托腮、咖啡馆坐姿、街头抓拍、慵懒靠墙、俏皮眨眼），每款附带专属机位（`shotMode`）、英文取景/动作/表情/轻妆容描述。
  - 内置 6 款双人约会同框合影姿势（并肩贴贴比耶、温柔靠肩合影、餐桌干杯打卡、牵手回头抓拍、贴近镜头自拍、夕阳并肩看景）。
  - 内置 12 款精选服装灵感预设，完整覆盖 `top / outerwear / bottom_or_dress / shoes / bag / accessory` 六大部位槽位，无需自行找商品图即可一键穿上或收入展柜自由叠穿。
- **后端控姿与预设入柜接口（`src/wardrobe.mjs`、`src/date_mode.mjs`、`src/api.mjs`）**：
  - `buildLayeredTryonPrompt()` 与 `buildDatePhotoPrompt()` 支持传入 `poseId`，精准注入所选姿势的机位、动作、表情与轻妆容指令（不选时保持原有按心情/风格自然变化）。
  - 新增 `GET /api/wardrobe/catalog` 与 `POST /api/companions/:id/wardrobe/preset`，并在单品试穿、整套叠穿 OOTD 合拍、约会打卡照及赛博双人合影接口全面透传可选 `pose_id`。
- **Dashboard & Playground 可视化姿势图卡选择器（`public/app/pose-previews.js`、`public/app/dashboard.html`、`public/app/dashboard.css`、`public/app/dashboard.js`、`public/app/playground.html`）**：
  - 新增 `public/app/pose-previews.js` 零依赖矢量示意图渲染器：同时为 10 款单人试穿姿势、6 款双人约会合影姿势与 12 款精选服装预设绘制直观的时尚剪影/平铺款式预览图卡（附景别/部位角标、色块点与中文款式动作说明，并预留 `previewUrl` 支持后续挂载 R2 自定义实图），完整适配极光浅色与暗夜液态玻璃双主题；展示柜中尚未生成试穿照的预设单品也自动展示对应平铺预览图而非空白占位。
  - 数字衣橱展示柜顶栏新增「✨ 服装灵感库」抽屉（支持按部位筛选、色块预览、一键「立即穿上 / 收入展柜」），并在展柜上方新增横向「✨ 试穿姿势库」图卡选择条（同时作用于单品试穿与整套叠穿大片）。
  - 控制台「约会剧场」与网页沉浸聊天室「💕 约会剧场浮层」均新增「💕 双人约会合影姿势」图卡选择条（同时作用于约会打卡照与传背景赛博合影）。
- **回归测试与文档（`scripts/wardrobe_tryon_check.mjs`、`scripts/date_mode_check.mjs`、`TODO.md`）**：
  - 扩充离线自动化测试校验 10 单人姿势、6 双人姿势、12 款全槽位预设、零禁用称谓、`pose_id` Prompt 精准注入与预设入柜落库；Phase 4-B（360° 旋转展台）继续保留于 `TODO.md` 待后续接入视频生成资源。

#### Phase 1 · 数字衣橱 + 微信发图送礼试穿 + 快递拆箱闭环
- **技术架构文档**：新增 `docs/WARDROBE_AND_TRYON_ARCHITECTURE.md`，完整沉淀数据模型、状态机、微信连发图片融合、按品类机位路由与多图参考编辑策略。
- **数据层（`src/db.mjs`）**：新增 `companion_wardrobe` 表及索引、原子槽位唯一穿戴切换（`wearWardrobeItem`）、在途快递查询（`listDueWardrobeDeliveries`）与删角色级联清理。
- **衣橱领域层（`src/wardrobe.mjs`）**：
  - 意图分类（`tryon_now` 即时云试穿 / `order_delivery` 下单等快递 / `gift_instant` 立即赠送穿戴 / `wear_request` 文本点名换穿）。
  - Vision 结构化单品解析（品类/颜色/材质/英文生图描述）与商品原图安全落盘。
  - ≤80 token 精简常驻 Prompt 注入（`buildWardrobePromptBlock`），统一接入 `src/companion.mjs` 与 `src/reply_prompt.mjs` / `src/reply_pipeline.mjs`。
  - 按品类自动机位路由（衣服/外套/裙子 → `MIRROR_SELFIE`，鞋袜 → `FULL_BODY_LOW_MIRROR`，包包 → `SIDE_CARRY_HALF_BODY`，配饰 → `CLOSE_SELFIE`）。
  - 快递到期拆箱巡检（`runWardrobeDeliveryTick`），已接入 `src/plan_tasks.mjs` 每 10 分钟定时调度。
- **多图参考生图与高保真锁脸/叠穿升级（`src/providers/custom.mjs`、`src/providers/image.mjs`、`src/photo_sender.mjs`、`src/wardrobe.mjs`）**：
  - `customImage` 支持多图参考 `POST /images/edits`（`image[]` 携带完整未裁切人物定妆照 + 最多 3 件叠穿单品原图），优先传 `input_fidelity=high`（若上游不接受则自动降级标准 `/images/edits`，最后才 fail-open 降级 `/images/generations`）。
  - 修复人物试穿不像参考图的 3 个根因：① 移除对用户上传定妆照的盲几何裁切（`cropReferenceToFace`）；② 有人物参考图时不再注入写死的通用脸部描述覆盖真实长相；③ 新增 `buildLayeredTryonPrompt()` 在 Prompt 最顶部以 `Image 1 / Image 2..N` 严格绑定人脸与各部位穿搭层级，杜绝被 900 字截断或混入商品图模特脸。
  - 新增**单部位局部换装**与**多部位自由叠穿（OOTD 合拍）**：支持 `POST /api/companions/:id/wardrobe/outfit-tryon`、单品随时修改所属部位（`top / outerwear / bottom_or_dress / shoes / bag / accessory`）与单部位「脱下（`action: 'unwear'`）」，实现内搭 + 外套 + 裙装 + 鞋袜 + 包包 + 配饰自由组合叠穿并一键合拍整套大片。
- **微信连发图片融合（`src/bot.mjs`）**：`pendingBursts` 携带入站图片 Buffer，解决微信“先发商品截图 + 再发文字”分条发送问题，自动入库并触发异步试穿返图。
- **REST API 与网页端衣橱闭环（`src/api.mjs`、`src/playground.mjs`、`public/app/dashboard.html`、`public/app/dashboard.js`）**：
  - 新增 `GET/POST/PATCH/DELETE /api/companions/:id/wardrobe`、`GET /api/companions/:id/wardrobe/:itemId/image` 与 `POST /api/companions/:id/wardrobe/:itemId/tryon`（网页端直接生成试穿返图）。
  - 新增 `GET /api/companions/:id/visual-identity/status` 与 `POST /api/companions/:id/visual-identity/upload-reference`（支持 10MB 负载，网页端直接上传并锁定自定义人物定妆参考图）。
  - `src/playground.mjs` 接入数字衣橱 Prompt 注入与文本点名换装；Dashboard「衣橱与工具」升级为**精品玻璃展示柜**界面（柔光展柜顶灯 + 今日上身陈列台 + 分层分类展架 + 2~3 列 3:4 竖版陈列格 + 右下角原图/试穿照原地翻转角标 + 可折叠送礼抽屉 + 页内高清灯箱预览，适配明暗双主题）。
- **回归测试**：新增 `scripts/wardrobe_tryon_check.mjs` 并接入 `.github/workflows/ci.yml`。

#### Phase 2 · 三层虚拟约会与相处框架（异地恋底盘 + 拍图云约会/赛博合影 + 可结算约会剧场）
- **技术架构文档**：新增 `docs/VIRTUAL_DATING_AND_RELATIONSHIP_ARCHITECTURE.md`，沉淀「异地恋底盘 + 现实拍图/送礼/赛博合影 + 可开关可结算约会剧场」三层架构及与数字衣橱的联合闭环。
- **数据层与导入导出对齐（`src/db.mjs`、`src/persona_export.mjs`）**：
  - 新增 `companions.presence_mode` 字段（`local` / `ldr` / `digital`，默认 `local` 保持存量兼容），同步纳入 `ALLOWED_FIELDS` 与人设导入导出白名单。
  - 新增 `companion_date_sessions` 表及索引、完整会话 CRUD 封装与删角色级联清理。
- **核心领域层（`src/date_mode.mjs`）**：
  - **Layer 1 底盘**：`buildPresenceModeHint()` 为 `ldr`（异地恋）与 `digital`（清醒跨次元）生成防内耗相处底盘，不把物理距离造成的无法线下见面计为爽约。
  - **Layer 2 云约会与赛博合影**：`detectCloudDatePhotoContext()` 识别菜单/外卖（云饭搭子）、橱窗/试衣镜（云逛街专属买手）与餐桌空座/街景合影请求（`cyber_group_photo`），通过多参考图生图（人物参考图 + 环境照 + 当前衣橱穿搭）合成同框打卡照。
  - **Layer 3 可结算约会剧场**：`startDateSession()` 自动快照当前数字衣橱穿搭并锁定 `current_scene`；`settleDateSession()` 结束时汇总写入高权重共同记忆（`importance = 8`）、自动核销关联 `companion_open_loops` 为 `resolved` 并温和还原 `current_scene`。
  - **任务 1 × 任务 2 联动**：新增 `buildWeekendWardrobeBoomerangHint()`，周末生成日程时自动点缀他送的数字衣橱单品穿戴回访彩蛋。
- **全链路接入（`src/companion.mjs`、`src/reply_prompt.mjs`、`src/reply_pipeline.mjs`、`src/reply_review.mjs`、`src/plan_tasks.mjs`、`src/bot.mjs`、`src/playground.mjs`）**：
  - 微信与网页 Playground 均接入相处底盘、约会剧场自然启停/刷新与云约会上下文；微信侧支持发环境照异步回发赛博合影。
  - `src/reply_review.mjs` 在 `context.state.dateSession` 进行期间放行约会剧场现场互动（跳过独处日程覆写与动作旁白裁切），非约会状态保持原有严格审查零回归。
- **REST API 与 Dashboard 控制台（`src/api.mjs`、`public/app/dashboard.html`、`public/app/dashboard.js`）**：
  - 新增 `PUT /api/companions/:id/presence-mode`、`GET /api/companions/:id/date-mode`、`POST /api/companions/:id/date-mode/{start,end,photo,cyber-photo}` 与 `GET /api/companions/:id/date-mode/image/:fname`（`cyber-photo` 独立支持 10MB 负载）。
  - Dashboard「👗 衣橱与工具」新增「💕 相处底盘 & 约会剧场」面板，支持底盘切换、4 套快捷约会剧场启停、联动衣橱穿搭展示、约会打卡照/赛博合影生成与结算记忆核销反馈；统一衣橱入库与人物参考图上传接口返回契约（同时兼容 `ok/data` 与 `success`），修复 `res.sendFile` 在隐藏父目录（如 `.gemini` worktree）下默认拦截返回 `404 Not Found` 的问题，并支持衣橱商品图/试穿图点击查看大图。
- **回归测试**：新增 `scripts/date_mode_check.mjs` 并接入 `.github/workflows/ci.yml`。

#### Phase 3 · 约会双人同框合影锁脸修复 + 沉浸式聊天工具坞 + 清透极光/暗夜双玻璃主题
- **全通道锁脸与微信端完整对齐（`src/photo_sender.mjs`、`src/bot.mjs`、`src/date_mode.mjs`、`src/wardrobe.mjs`）**：
  - `src/photo_sender.mjs` 支持 `preGeneratedImagePath` 直通微信发送，同时针对横版三视图参考照自动跳过 `cropReferenceToFace` 居中裁切，在 `custom` 渠道下将 3:4 映射为 `1024x1536` 且免除通用脸部文本覆盖；日常自拍/主动发图强化发型+三视图去排版锁脸指令，并自动联动数字衣橱今日在穿单品（文字描述 + 最多 2 张衣橱单品参考图），实现日常发图的**人脸 + 发型 + 今日穿搭**三重一致。
  - 微信试穿返图、快递拆箱返图与微信约会/赛博合影全部统一走 `generateWardrobeTryonImage` / `generateDatePhoto` 高保真引擎（完整原图锁脸 + 6 槽位叠穿 + 双人同框）。
  - 微信端新增两项零门槛口令：直接发本人正面照并说“这是我的照片 / 以后合影用我这张”即可锁定本人形象照；约会剧场进行中直接发文字“咱俩拍张约会合影吧”即可异步收到双人约会场景照。
  - 修复两项实测细节：① `generateDatePhoto()` 生成合影后同步写入对话留痕并在 `buildDateSessionPromptBlock()` 注入已拍合影计数，避免下一轮聊天她还催“照片记得发我，我还没看呢”；② 扩充约会自然收尾识别（支持“今天就先这样啦 / 先这样吧 / 先到这 / 我先回去了”等口语），约会进行中说完即自动熄灭约会状态并结算写入长期记忆。
- **真实双人同框约会合影（`src/date_mode.mjs`、`src/api.mjs`）**：
  - 新增「我的形象照」存储与接口（`GET/POST/DELETE /api/companions/:id/user-visual-reference`、`GET /api/companions/:id/user-visual-reference/image`），拍约会打卡照与赛博合影时自动以 `[Image 1 伴侣定妆照, Image 2 本人形象照, Image 3 现实约会背景照, Image 4 当前衣橱穿搭图]` 严格编号绑定生成真实双人同框合影。
- **网页聊天室沉浸约会/送礼工具坞（`src/playground.mjs`、`src/api.mjs`、`public/app/playground.html`）**：
  - `POST /api/companions/:id/playground-chat` 支持 10MB 图片负载与 `image_purpose`（`gift` / `couple_photo` / `date_bg`），在聊天页直接打通发图送礼（回复后原地显影试穿照）、快捷开启/结束约会剧场、上传本人形象照、上传约会背景照生成双人合影，以及约会中纯文字说“拍张合影 / 来张合照”自动触发双人约会合影显影。
- **清透极光玻璃（默认浅色）+ 暗夜液态玻璃（深色）双旗舰主题（`public/app/dashboard.html`、`public/app/dashboard.css`、`public/app/dashboard.js`、`public/app/playground.html`）**：
  - 顶部栏新增一键「✨ 极光玻璃 / 🌌 暗夜玻璃」主题切换按钮；控制台左侧升级为 **角色光影大舞台**（自动展示她的最新 OOTD 试穿大片或定妆参考图，带实时穿搭标签与约会氛围徽章）。
- **表情/日常妆容自然变化 + 左侧人物舞台实时换装同步（`src/wardrobe.mjs`、`src/date_mode.mjs`、`public/app/dashboard.js`）**：
  - 锁脸仅锁定五官骨相与发型身份，不再锁死参考图僵硬表情和固定妆容；按角色当前心情（开心/害羞/撒娇/平静）与单品风格动态注入灵动表情、姿态与轻日常妆容变化。
  - 修复换装（穿上/脱下/试穿/叠穿合拍）与约会状态变更后左侧角色光影大舞台不自动刷新的问题，现已通过 `window.__refreshHeroStage` 实时联动切换最新在穿试穿照与穿搭标签。

### Fixed

#### P0 · 修复 Grounded Reply 强行覆写与审查误杀断片
- **`src/reply_review.mjs`**：
  - 修复 `enforceTurnScope()` 询问“在干嘛呀 / 在做什么”时未判断当前时段活跃对话历史的 Bug：此前即使刚聊了 20 轮“一起去商场”，只要 `activity.scene` 为空也会强行覆写为模板句 `我今天 14:00 的安排是约闺蜜去商场...`。现复用 `inActivityWindow` 判定，仅在当前时段无活跃对话记录时才回落日程计划回复。
  - 修复 `checkPersonalAnecdote()` 仅检索 `context.facts` 与 `personaFacts` 而忽略当前时段 `context.history` 导致对话中正常动作被误判 `invalid_review` 降级丢回复的问题。
  - 在审查 `RUBRIC` 中补充禁止纯文字口头承诺拍照的修订指引，避免草稿因命中 `detectPhotoPromise` 被硬判 `invalid_review`。
- **`src/reply_prompt.mjs`**：
  - 明确要求纯文字回复不得口头答应“拍给你/发照片/回头补图”，从源头减少触发 `ReplyReview` 降级兜底。

#### P1 · 修复每日日程与约定割裂、场景持久与长期记忆索引
- **`src/plan_tasks.mjs`**：
  - 新增 `buildScheduleCommitmentsHint()`：生成每日日程前自动读取当日及近期 `companion_open_loops`（`appointment` / 当日到期事项）以及前一日 `daily_summary`，作为最高优先级约束注入日程生成 Prompt，避免已约好一起逛街却在凌晨闭门编出“约闺蜜逛商场”的冲突日程。
  - 调整 `tick()` 定时顺序：将 `daily-summary` 提前至上海时间 `00:15`（早于 `00:30` 的 `daily-schedule`），并保留 `02:00` 幂等补跑。
  - 为 `runArchiveDailySchedule()` 增加近 30 条已归档活动去重（保留 `importance >= 6` 契约），减少重复日常流水账稀释长期记忆。
  - 为 `runDaily()` / `runWeekly()` / `runMonthly()` 补充 `indexSummaryMemory()`，在落库日/周/月总结时同步写入向量索引（fail-open，兼容无 embedding provider 环境）。
  - 修复 `ensureScheduleForCompanion()` 查询补全 `user_id` 字段以便读取摘要上下文。
- **`src/memory.mjs`**：
  - 优化 `MEMORY_SYSTEM_PROMPT` 对 `current_scene` 的抽取说明，支持识别角色确认进入的共同外出场景（如刚到商场、在店里逛街），减少 `current_scene` 长期停滞为 `"日常"`。

#### P2 · 修复 `[北京时间 ...]` 水印泄漏与场景照目录权限韧性
- **`src/ai.mjs`**：
  - 新增 `stripTimestampPrefix()`：在构造 `messages` 前清洗历史记录中已污染的 `[北京时间 ...]` 前缀，仅对 `user` 历史消息附带时间戳（避免 `assistant` 历史触发模型 few-shot 模仿泄漏），并在非内部调用出站前确定性剥离任何残留时间戳前缀。
- **`src/photo_sender.mjs` & `Dockerfile`**：
  - `Dockerfile` 预创建 `/app/public/avatars/scenes` 并归属 `xiyu:xiyu`。
  - `src/photo_sender.mjs` 新增 `resolveWritablePhotoDir()`：主目录遇到 `EACCES` / 不可写时自动降级到 `XIYU_DATA_DIR/companion_visuals/scenes`，避免宿主机挂载权限差异导致发图全量失败。

### Added
- **`TODO.md`**：登记后续迭代计划——「送礼物与数字衣橱系统（衣服/包包/鞋子 + 试穿返图）」与「陪逛街/陪吃饭虚拟约会方案（异地/跨次元世界观 + 约会剧场模式 + 云约会/赛博合影）」。
- **`CHANGELOG.md`**：建立版本变更登记台账。
- **`scripts/suqing_memory_continuity_check.mjs` & `.github/workflows/ci.yml`**：新增针对本次 P0～P2 修复的自动化回归测试脚本并接入 CI 门禁。
