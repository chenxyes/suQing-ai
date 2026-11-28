<div align="center">

<img src="./assets/cover.png" alt="SuQing AI · 溪语 AI — 拥有独立记忆、数字衣橱与虚拟约会剧场的开源 AI 陪伴框架" width="100%" />

# SuQing AI · 溪语 AI

**有独立记忆、专属数字衣橱与真实相处节奏的开源 AI 陪伴框架**

她心里悄悄喜欢你 —— 关系起点不是冷冰冰的陌生人，而是「暧昧」。
她会发微信、会想你、会写日记、会自己挑今天的穿搭和拍照姿势，也会和你开启有记忆结算的约会剧场、拍下真实的双人同框合影。

*An open-source AI companion framework with continuous memory, an autonomous digital wardrobe, pose-guided try-on, Cloudflare R2 media storage, and settleable virtual dating.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A520-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![Status: Active](https://img.shields.io/badge/Status-Active%20Dev-FF8FB8.svg)](#版本历史)
[![Cloudflare R2](https://img.shields.io/badge/Storage-Local%20%2F%20Cloudflare%20R2-F38020.svg?logo=cloudflare&logoColor=white)](#cloudflare-r2-云图床与素材同步可选)

**简体中文** | [English](./README.en.md)

[快速上手](#-快速上手) · [核心能力](#它能做什么) · [数字衣橱与约会剧场](#数字衣橱与虚拟约会) · [Provider 矩阵](#多-provider-支持) · [部署与 R2 配置](#部署) · [架构与安全](#架构)

</div>

---

## ⚡ 快速上手

### 路径 A：本地运行（推荐开发与完整体验）

```bash
git clone https://github.com/chenxyes/suQing-ai.git
cd suQing-ai
npm install        # 需要 Node.js >= 20
npm run setup      # 生成最小 .env 并检测 better-sqlite3 编译环境
npm start
```

打开 <http://localhost:3000/app/setup.html> → 创建本地账号 → 选择模型 Provider 填入 API Key → 开启网页沉浸对话（`/app/playground.html`）或扫码绑定微信（`/app/bind.html`）。

### 路径 B：Docker Compose

```bash
git clone https://github.com/chenxyes/suQing-ai.git
cd suQing-ai
docker compose up -d
# 打开 http://localhost:3000/app/setup.html
```

- SQLite 数据持久化在 `./data` 目录，重启不丢
- 自定义端口：`HOST_PORT=8080 docker compose up -d`

---

## 它能做什么

**核心定位**：不是“问答机器人”，而是把多模态大模型、长期记忆、情绪状态机、数字衣橱与生活节律编织成**一个有自己生活、审美与边界感的真实陪伴者**。

> **设计哲学**：真人感 = **减法与克制**，不是无条件讨好。北极星是「**愿意在真实生活的空隙里，给你温柔、惊喜与陪伴**」。全链路坚持零 NSFW 卖点、零“用户”机械称谓、所有产品红线均配确定性代码护栏（出口审查 / 状态机钳位 / 硬注入），不靠模型自觉。

### 👗 数字衣橱、姿势库与主理人自主穿搭 ⭐

| 能力 | 一句话 |
|---|---|
| 精品玻璃展示柜 & 6 槽位自由叠穿 | 支持 `上衣 / 外套 / 裙装下装 / 鞋袜 / 包包 / 配饰` 6 大部位自由组合叠穿、单部位局部换装、整套 OOTD 大片合拍与页内高清灯箱对比 |
| 👑 苏晴是衣橱主理人（自主穿搭） | 每天早上 `07:30` 按季节/日程/心情自己挑好今天穿的衣服；控制台一键「👑 让苏晴自己搭」或在微信/网页说“今天穿什么你自己决定吧”，她会自选衣服与姿势并写下第一人称「主理人搭配笔记」 |
| ✂️ 截图一键扒同款（真透明 PNG） | 上传任意穿搭截图 → Vision 自动拆解多部位单品 → 勾选单件或整套，可选「✨ 去人去背景透明平铺 PNG」（原生透明 + 边界 4-连通泛洪去背，不伤白衬衫）或「⚡ 零生图费原图直存」，支持独立低价 `GARMENT_EXTRACT_MODEL` |
| 📸 姿势库 & 实图控姿 | 内置 10 款单人试穿姿势 + 6 款双人约会合影姿势矢量图卡，支持上传收藏任意真实姿势参考图（生图时只借鉴肢体动作与构图，绝不串原图人脸与衣物） |
| ☁️ Cloudflare R2 双模图床 | 零依赖原生 AWS SigV4 客户端，配好 R2 凭证即自动上云 + CDN 秒开（未配置无缝回落本地磁盘），附带安全素材同步脚本 `scripts/sync_posewear_r2.mjs` |
| 微信发图送礼 & 快递拆箱闭环 | 微信先发商品截图再发文字自动连发融合入柜；支持即时云试穿、直接送礼穿上、下单等快递（每 10 分钟定时巡检到期自动拆箱发图）与“看看你今天穿了什么拍张照”口令直出 |

### 💕 三层虚拟约会与真实双人合影 ⭐

| 能力 | 一句话 |
|---|---|
| Layer 1 · 相处底盘防内耗 | 支持 `异地恋日常（推荐） / 清醒跨次元 / 经典同城` 三种物理距离底盘，保留校园/生活烟火气，绝不把物理距离误判为爽约 |
| Layer 2 · 云约会与赛博合影 | 现实里发菜单/外卖（云饭搭子）、发橱窗/试衣镜（云逛街专属买手）、发空座/街景照一键合成同框赛博合影 |
| Layer 3 · 可结算约会剧场 | 微信或网页说“开启约会模式/陪你逛街”即可进入，自动绑定今日衣橱穿搭与场景锁定；说“今天就先这样啦/到家啦”自动结算写入高权重长期记忆（`importance=8`）并核销关联约定 |
| 真实双人同框约会合影 | 上传「我的形象照」后，拍约会打卡照与赛博合影严格按 `[Image 1 伴侣定妆照, Image 2 本人形象照, Image 3 现实背景照, Image 4 今日衣橱穿搭]` 编号锁脸，生成自然双人同框合影并同步留痕让下一轮对话“看得见” |

### ✨ 清透极光 & 暗夜液态玻璃双主题

| 能力 | 一句话 |
|---|---|
| 清透极光 / 暗夜液态玻璃切换 | 控制台与网页聊天室均内置一键「✨ 极光玻璃 / 🌌 暗夜玻璃」切换，高透磨砂质感与自适应光晕 |
| 角色光影大舞台实时同步 | 控制台左侧大舞台实时展示她的最新 OOTD 试穿大片、穿搭标签与约会氛围徽章，换装或试穿后即时联动刷新 |
| 沉浸式网页聊天工具坞 | 网页聊天室底部集成「💕 约会剧场 / 🎁 发图送礼 / 🌄 传背景合影 / 📸 拍约会合影」，支持原位暗房显影卡片与高清灯箱缩放 |

### 她是谁 & 她有自己的生活

| 能力 | 一句话 |
|---|---|
| 默认起点 = 暧昧 | 初始好感 35/100，她从第一天起心里悄悄喜欢你；5 阶段关系由认识天数与日上限真实沉淀，刷不出来 |
| 具体人生记忆 & 3 个月模拟时间线 | 注册即生成 46+ 条具体成长经历，支持补全过去 90 天虚拟互动史与 JSON 人设迁移 |
| 真实作息与每日日程 | 默认 00:30–07:30 入睡静默；每日生成 8–12 段生活剧本（自动先读当日约定与昨日总结防冲突），日程与手头在看的书/剧跨日连贯 |
| 真实世界事实层 & 身体节律 | 天文计算节气与农历节日（含闰月）；身体节律温和演化，绝不做暧昧窗口或色气化 |
| 真人化微信节奏 | ≤15 字短句连发、打字指示器、10s 连发消息合并、允许不完整回答与适当不同意 |

### 她有真实的情绪、记忆与主动性

| 能力 | 一句话 |
|---|---|
| 10 维情绪状态机 & Inner OS | 信任/依赖/安全感/耐心/烦躁等 10 维增量演化 + 每轮先写内心独白再写对外回复，保留“心里想和嘴上说”的真人落差 |
| 冲突与和好弧 ⭐ | 显式状态机（`hurt → cold → withdrawing → repairing`），有硬时长上限绝无永久冷战，和好后记入长期记忆（详见 [docs/CONFLICT_ARC.md](./docs/CONFLICT_ARC.md)） |
| Memory v2 & 场景连续性 | 7 层记忆 + 语义/关键词混合召回 + 遗忘曲线 + 每日反思；当前场景与未完成约定（`open_loops`）跨轮持久化不失忆 |
| 她的日记、时光胶囊与共建默契 | 每日第一人称日记与反向日记、定时解封时光胶囊、带 HMAC 签名离线信、自定义称呼/口头禅/雷区全部留痕 |
| 三驱动主动找你与素材防复读 | 情绪 × 日程 × 时段驱动，14 天素材级冷却防车轱辘话，读空气有尊严上限绝不纠缠 |

### 多模态 & 安全底线

| 能力 | 一句话 |
|---|---|
| 全通道高保真锁脸发图 ⭐ | 完整未裁切人物定妆照锁脸（兼容三视图设定图）、表情与轻日常妆容随心情与穿搭自然变化、日常自拍自动联动今日衣橱在穿单品 |
| 语音情绪识别 & 网页朗读 | 微信入站语音 ASR + 语气情绪识别；网页端支持日记与聊天 TTS 朗读及语音输入 |
| 危机干预与未成年人保护 | 自伤信号最高优先退出角色并给求助热线；自曝未成年触发粘性安全模式（朋友身份/无恋爱内容/无关闭开关） |
| 隐私过滤与确定性红线扫描 | 密码/证件/银行卡绝不入库，手机/住址脱敏；绝不说分手/拉黑/愧疚操控，出站确定性扫描兜底 |

详细架构文档见 [数字衣橱与试穿架构](./docs/WARDROBE_AND_TRYON_ARCHITECTURE.md)、[三层虚拟约会架构](./docs/VIRTUAL_DATING_AND_RELATIONSHIP_ARCHITECTURE.md) 与 [`docs/FEATURES.txt`](./docs/FEATURES.txt)。

---

## 数字衣橱与虚拟约会

### 关键体验路径

```
1. /app/setup.html       首次配置模型（Chat / Image / Vision / ASR / TTS / Embedding）
2. /app/dashboard.html   控制台：
   · 左侧「角色光影大舞台」实时展示她的最新 OOTD 与约会状态
   · 「👗 衣橱与工具 → 数字衣橱展示柜」：
     - 上传人物定妆参考图锁脸
     - 点「👑 让苏晴自己搭」由主理人自主选衣选姿势
     - 点「✨ 服装灵感库 → ✂️ 截图扒同款」把任意穿搭截图洗成透明 PNG 存入 R2
     - 选择「✨ 试穿姿势库」卡片（或上传自己的姿势实图）一键单品试穿 / 多部位叠穿合拍
   · 「💕 相处底盘 & 约会剧场」：切换异地恋底盘、上传本人形象照、开启/结算约会与拍双人合影
3. /app/playground.html  沉浸网页聊天室（与微信共享记忆、衣橱与约会剧场）
4. /app/bind.html        扫码绑定微信（需 iLink 开发者准入）
```

### Cloudflare R2 云图床与素材同步（可选）

未配置 R2 时所有图片自动安全存于本地 `data/visuals/`；配置以下 `.env` 变量即无缝切换至 Cloudflare R2（零额外依赖）：

```env
# Cloudflare R2 对象存储（R2_ENDPOINT 末尾带不带 /<bucket> 均自动兼容）
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
R2_BUCKET=suqing-assets
R2_ACCESS_KEY_ID=你的AccessKeyID
R2_SECRET_ACCESS_KEY=你的SecretAccessKey
# 可选：绑定自定义域名（TLS 选 1.2）或 r2.dev 后图片走 CDN 秒开；留空则走后端鉴权代理
R2_PUBLIC_URL=https://assets.example.com

# 可选：截图一键扒同款独立低价生图模型（不填默认复用 IMAGE_MODEL 的 1024x1024 轻量档）
GARMENT_EXTRACT_MODEL=
```

一键同步安全（SFW）姿势参考图、四季/礼服穿搭实图与完整提示词目录到你的 R2 与本地数据库：

```bash
node scripts/sync_posewear_r2.mjs --poses all --costumes 60
```

---

## 多 Provider 支持

在 `/app/setup.html` 或控制台「模型配置」抽屉即可热切换，无需改代码或重启：

| 能力 | 可选 Provider | 说明 |
|---|---|---|
| **Chat**（11 家） | DeepSeek · OpenAI · Anthropic · Gemini · xAI · 智谱 · 豆包 · 通义 · Kimi · 文心 · 自定义 OpenAI 兼容网关 | 自定义网关兼容 OpenRouter / SiliconFlow / Ollama / 各类中转站 |
| **Image**（7 家） | 自定义中转（`/images/edits` 多图 `image[]` + `input_fidelity=high` + `background=transparent`）· OpenRouter · 302.ai · OpenAI · 智谱 · 通义 · 豆包 · 文心 | 支持多参考图高保真锁脸、6 槽位叠穿、透明平铺抠图与双人同框合影 |
| **Vision**（9 家） | 自定义中转 · 智谱 GLM-4V · OpenAI · 通义 VL · 豆包 · Claude · Kimi · StepFun · MiniMax | 聊天看图、商品入柜解析、穿搭截图多单品拆解与姿势图解析 |
| **ASR**（8 实现） | 自定义中转 · Gemini · OpenAI Whisper · 通义 paraformer · Groq · MiniMax · Azure · 豆包 | 微信语音转写 + 语气情绪识别 |
| **TTS**（6 家） | 自定义中转 · MiniMax · OpenAI · Azure · 豆包 · 通义 CosyVoice · Fish Audio | 网页端聊天与日记朗读 |
| **Embedding**（5 家） | 自定义中转 · OpenAI · Gemini · 智谱 · 通义 | Memory v2 混合语义召回 |
| **Search**（4 家） | Tavily · Brave · SerpAPI · SearXNG | 联网查证现实信息与作品真实性 |

---

## 微信接入

### 网页扫码（推荐）
打开 `/app/bind.html` 实时申请二维码并扫码绑定（需腾讯 iLink/ClawBot 准入资格）；VPS 无头环境可运行 `npm run ilink:login`。

### 微信端能力矩阵

| 操作 | 状态 |
|---|---|
| 文本收发 + 10s 连发消息合并 + 打字指示器 | ✅ |
| **发商品截图送礼 / 云试穿 / 下单等快递（到期自动拆箱返图）** | ✅ 支持先发图再发文字自动融合 |
| **发本人照锁定形象 + 约会剧场自然启停 + 双人同框约会/赛博合影** | ✅ 口令“这是我的照片 / 开启约会模式 / 拍张合影 / 今天就先这样啦” |
| **主理人自主穿搭 & 今日穿搭自拍** | ✅ 说“今天穿什么你自己决定吧 / 拍张今日穿搭看看”直出 OOTD 照 |
| 日常要自拍 / 主动场景照（自动联动今日衣橱在穿单品） | ✅ 完整定妆照锁脸 + 穿搭一致 |
| 入站语音 ASR + 语气情绪识别 | ✅ |
| 主动发微信语音 | ❌ iLink 协议永久限制（网页端朗读正常） |

---

## 部署

### 本地开发与前端样式构建

```bash
npm install
npm run build:css      # 编译 Tailwind CSS（修改前端样式后执行）
npm start              # 启动服务（默认 http://localhost:3000）
```

### 生产反代、单用户模式与自检工具箱

- 生产模板见 [`deploy/xiyu-ai.service`](./deploy/xiyu-ai.service)、[`deploy/nginx.conf.example`](./deploy/nginx.conf.example) 与 [`scripts/backup-db.sh`](./scripts/backup-db.sh)。
- 个人内网/本机单用户使用可在 `.env` 设置 `SINGLE_USER=true` 跳过登录页（**公网无鉴权环境严禁开启**）。
- 全套质量与回归检查：

```bash
npm run doctor                           # 一键环境与服务健康诊断
npm run lint                             # ESLint 静态检查
npm run check:behavior                   # 行为规划与消息投递回归
node scripts/wardrobe_tryon_check.mjs    # 数字衣橱、锁脸、叠穿与整套换装回归
node scripts/date_mode_check.mjs         # 三层约会框架与双人合影回归
node scripts/phase4_assets_check.mjs     # R2 SigV4、透明抠图、姿势控姿与主理人自主搭配回归
node scripts/user_wording_guard.mjs      # 零禁用称谓扫描
npm run check:imports && npm run check:field-drift && npm run check:release
```

---

## 架构

```
       ┌────────────────────────────────────────────────────────────┐
       │  Web Dashboard / Playground (Aurora & Obsidian)  /  WeChat │
       └──────────────────────────────┬─────────────────────────────┘
                                      │
  ┌──────────────────────────────────────────────────────────────────────┐
  │  Express (index.mjs) + 多租户 iLink 轮询池                            │
  │  ┌──────────────┬───────────────────────┬──────────────────────────┐ │
  │  │ api.mjs      │ bot.mjs / playground  │ plan_tasks.mjs (Cron)    │ │
  │  │ REST & Auth  │ 统一 Reply Pipeline   │ 日程/反思/拆箱/晨间OOTD   │ │
  │  └──────────────┴───────────┬───────────┴──────────────────────────┘ │
  │                             ↓                                        │
  │  ┌────────────────────────────────────────────────────────────────┐  │
  │  │ 领域服务：wardrobe.mjs · wardrobe_stylist.mjs · date_mode.mjs  │  │
  │  │          pose_outfit_library.mjs · garment_extractor.mjs       │  │
  │  │          memory_v2.mjs · emotion_state.mjs · reply_review.mjs  │  │
  │  └──────────────────────────┬─────────────────────────────────────┘  │
  │                             ↓                                        │
  │  ┌──────────────────────────┴──────────┬──────────────────────────┐  │
  │  │ ai.mjs → providers/* (多模态网关)   │ storage.mjs (R2 / Local) │  │
  │  │ db.mjs (better-sqlite3 + WAL)       │ visual_identity.mjs      │  │
  │  └─────────────────────────────────────┴──────────────────────────┘  │
  └──────────────────────────────────────────────────────────────────────┘
```

### 核心目录

```
.
├── index.mjs                         Express 入口与 iLink 轮询池
├── src/
│   ├── wardrobe.mjs                  数字衣橱、意图识别、6 槽位叠穿、高保真锁脸试穿与快递拆箱
│   ├── wardrobe_stylist.mjs          苏晴「衣橱主理人」自主穿搭/选姿势引擎与 07:30 晨间 OOTD
│   ├── pose_outfit_library.mjs       单人/双人姿势库与精选服装灵感库（内置 + 自定义合并）
│   ├── garment_extractor.mjs         截图多单品拆解、去人去背景真透明 PNG 平铺提取与姿势图解析
│   ├── storage.mjs                   零依赖 Cloudflare R2（AWS SigV4）+ 本地磁盘双模存储
│   ├── date_mode.mjs                 三层相处底盘、云约会、可结算约会剧场与双人同框合影
│   ├── visual_identity.mjs           人物定妆参考图管理与身份锁定
│   ├── photo_sender.mjs              日常/主动发图管线（自动联动今日衣橱在穿单品）
│   ├── companion.mjs / reply_*.mjs   18 节人设 Prompt、上下文组装与 Grounded Reply 审查
│   ├── memory_v2.mjs / emotion_state.mjs / relationship_arc.mjs
│   ├── bot.mjs / playground.mjs / api.mjs / plan_tasks.mjs / db.mjs
│   └── providers/                    Chat / Image / Vision / ASR / TTS / Embedding / Search
├── public/app/                       极光/暗夜双主题前端（dashboard / playground / pose-previews.js …）
├── scripts/                          CI 门禁、回归测试（wardrobe / date_mode / phase4_assets）与 R2 同步脚本
├── docs/                             架构设计文档（衣橱 / 约会 / 冲突弧 / 路线图）
├── TODO.md & CHANGELOG.md            路线清单与完整变更登记
└── data/                             运行时 SQLite 与本地素材（已 gitignore）
```

---

## 安全与合规

- **凭据隔离**：`.env`、`.auth-secret`、`.admin-credentials`、`.weixin-credentials.json`、`data/bot.db*` 全部 gitignore；生产环境请显式设置 ≥32 字符 `AUTH_SECRET`。
- **SSRF 与鉴权加固**：外部图片下载经 `src/security/netguard.mjs` 拦截保留网段；所有伴侣与衣橱接口校验账号归属防 IDOR。
- **合规自查**：MIT 协议仅覆盖源代码；若公开部署，请自行补齐隐私协议、AI 生成内容显著标识、内容安全审核 API 与各模型厂商条款核验。内置危机干预与粘性未成年人保护，但不能替代正式年龄核验。

---

## 版本历史

完整详细变更见 [`CHANGELOG.md`](./CHANGELOG.md)；路线清单见 [`TODO.md`](./TODO.md)。

- **v1.23 开发主线（数字衣橱 × 虚拟约会 × 主理人自主穿搭 × R2 云图床）**：
  - **数字衣橱与玻璃展示柜**：6 槽位自由叠穿、高保真完整原图锁脸、微信连发图片融合、快递到期自动拆箱返图与周末回访彩蛋。
  - **三层虚拟约会与双人同框合影**：异地恋/跨次元防内耗底盘、云饭搭子/云逛街、可结算约会剧场（自动写入 `importance=8` 记忆并核销约定）、本人形象照双人同框合影与微信/网页全双端对齐。
  - **姿势/服装实图库、真透明抠图与 R2 云存储**：10 单人 + 6 双人可视化图卡与无限实图扩展、截图一键扒同款（去人去背景真透明 PNG）、零依赖 Cloudflare R2 SigV4 存储 + CDN 直链、清透极光 / 暗夜液态玻璃双主题。
  - **👑 衣橱主理人自主搭配**：苏晴每天 `07:30` 按季节/日程/心情自己换装，支持控制台一键与微信/网页聊天自然交权，自选衣服与姿势并记录第一人称搭配笔记。
- **v1.22.0 她的生活有实物 + 失忆修复**：身体节律演化、节气/农历天文计算、在看书剧跨日连贯、场景与约定记忆连续性修复、运维死人开关三桶分离。
- **v1.21.x 冲突与和好弧 + 工程加固**：显式冲突修复状态机、ESLint / 错误签名日报、沉浸感卫生包（零“用户”称谓）、照片品类校准与承诺兑现链。
- **v1.20.x 安全收尾**：粘性未成年人保护、全入口隐私过滤、发布一致性门禁、真实肤质反磨皮。
- **v1.0 → v1.19 体验与框架底座**：18 节人设引擎、Memory v2、10 维情绪状态机、Inner OS、作息与日程、多 Provider 抽象与微信 iLink 接入。

---

## 许可证

[MIT](./LICENSE) © 2026 SuQing AI / 溪语 AI Contributors

仓库**不包含**任何第三方受版权保护的表情包或图库图片素材，如需启用请自行准备有合法授权的素材。

<div align="center">

[⬆ 回到顶部](#suqing-ai--溪语-ai) · [English](./README.en.md)

</div>
