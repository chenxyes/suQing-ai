# 运行数据排查后的本地修复计划

**Goal:** 修复已证实的配置、记忆归属、召回及互动状态问题，每项测试后由用户逐项最终确认。
**Architecture:** 保留现有 SQLite 架构；先修输入和召回约束，再补建索引与审阅历史污染。独立模块并行准备，存在数据依赖的改动按顺序实施。
**Tech Stack:** Node.js ESM、better-sqlite3、现有 smoke / node:test。
**Spec / requirements:** 用户本轮要求；私有取证报告 `/Users/charlexys/code/suQing-ai/reports/aws-memory-audit-20261019/排查报告.md`。报告与真实对话不入 Git。

## Global Constraints

- 仅在 `/Users/charlexys/code/suQing-ai-memory-fixes` 的 `codex/memory-repair` 上改动。起点 `8218c09`，初始工作区干净；已 fetch origin，远端无更新，既有 relay 修复已在 main 历史内。
- 不修改 main/master，不推送、不部署，不连接或修改服务器。2026-10-20 用户授权本地提交已验收的第 1～6 项；未验收项不得混入提交。
- 下载的快照只读保存，不让应用初始化或迁移直接打开该快照。测试仅使用临时数据库与合成样本，不调用真实收费模型，不复制真实聊天或密钥到测试。
- 如运行 Python，必须使用虚拟环境；优先 Node / shell。测试运行时由协调者提供本地 Node 22 与依赖。
- 每项先复现再修复，保留测试证据和独立 diff；最终确认逐项进行。并行完成表示待审，不代表用户已确认。
- 不通过关闭保护机制或自动清除 safe_mode 修复误判。真实凭据有效性与自然度提升不得用本地 mock 冒充实测。

### Task 1: Embedding 配置与故障状态

**Files:** `src/providers/embedding.mjs`、`src/api.mjs`、`public/app/setup.html`、`scripts/embedding_config_check.mjs`（协调者独占）。
**Dependencies:** 无；原生配置必须和实际请求使用同一读取路径。
**Acceptance criteria:** 非 ASCII/空白/缺失密钥、未知 provider、非法维度请求前拒绝；不回显凭据/响应正文；状态区分配置合法与请求成功，暴露明确安全原因；native model/key/dim 使用数据库覆盖环境；保留 custom 完整向量兼容性；失败返回 null 并提供可诊断的计数/状态。不得冒称远端密钥已经修好。
- [x] 用临时数据库、拦截网络验证请求前校验、动态设置优先级、响应合法性、状态与无凭据泄露。
- [x] 实现并运行相关 provider/API 检查、lint。
- [x] 输出第 1 项审阅包；用户已于 2026-10-19 接受本地修复。

### Task 2: 召回与存储准入

**Files:** `src/db.mjs`、`src/memory_v2.mjs`、相关 smoke。
**Dependencies:** Task 1 审阅；与 Task 3 共享数据库接口，顺序执行。
**Acceptance criteria:** 聊天/摘要/主动消息所有注入排除 deleted/archived/do_not_mention；必要敏感标记被保留；管理界面仍能查看被删除条目；单条、批量、patch 写入统一隐私过滤；不会从旧派生摘要再次泄露被撤销事实。明确区分可追溯摘要和旧无来源摘要，保守处理后者。
- [x] 合成数据库覆盖各召回与写入入口、跨用户/角色隔离。
- [x] 修复后回放私有快照副本，记录去标识化统计。
- [x] 输出第 2 项审阅包；用户已于 2026-10-19 接受本地修复。

### Task 3: 事实主体、来源与去重

**Files:** `src/memory.mjs`、`src/db.mjs`、`src/companion.mjs`、反思调用方与测试。
**Dependencies:** Task 2。
**Acceptance criteria:** 区分 user/companion/shared 事实，证据来自对应真实消息；角色妹妹不能写成用户妹妹；引述/假设/简短附和不能自动变事实；用户纠正能撤销旧事实；反思更新带实际 ID、内容变化后失效旧向量；重复事实不重复入库；注入分主体。未经证明的历史记忆不能自动认定为用户事实。
- [x] 实现 schema 兼容迁移、提取约束与确定性校验，回归验证各写入链路。
- [x] 生成只读污染审计与显式应用的迁移工具，报告旧数据无法证明的部分。

### Task 4: 向量回填、混合检索与记忆维护

**Files:** `src/db.mjs`、`src/memory.mjs`、`src/plan_tasks.mjs`、新回填脚本、维护测试。
**Dependencies:** Tasks 1–3；真实回填还需要合法凭据和用户部署授权。
**Acceptance criteria:** provider/model/dimension 可追溯，异构向量不混算；回填默认 dry-run、显式目标副本、可续跑、不恢复已撤销记录；关键词/无向量记忆不被语义路径遗漏；中文相关性、置顶配额、衰减与 recall touch 生效；压缩 importance 在 1..10 且事务避免源记录丢失；日摘要前的上下文保留足够证据，分页衰减不饥饿。
- [x] 合成数据和离线快照副本验证；记录在线验证前提。
- [x] 用户于 2026-10-20 接受本地修复并授权提交；审阅说明见 `2026-10-20-memory-repair-review-4.md`。

### Task 5: 未成年人判定中的事实主体

**Files:** 仅 `src/minor_guard.mjs`、`scripts/minor_guard_smoke.mjs`、可新增 `scripts/minor_guard_ownership_check.mjs`。
**Dependencies:** 可与 Task 1 并行，禁止改 db/ai/bot/companion/api 文件。
**Acceptance criteria:** 角色说去上学，用户催角色进校门，不能据此锁定用户；LLM 输出需要引用真实用户来源证据并校验，裸 yes 不可升级；引用助手/第三方/回忆/假设需排除；真实用户未满18自述、多轮用户自身在读语境仍可触发。保留 safe_mode 的粘性与现有年龄声明解除流程；不自动改存量状态。
- [x] 先建立能捕获旧误判行为的回归测试，沿用现有可测方式或适度依赖注入，避免仅匹配源码。
- [x] 实现并运行 minor_guard 相关测试，记录边界与无法由确定性测试证明的 LLM 准确率。
- [x] 写 task-5-report.md，包括修改文件、RED/GREEN命令结果、风险和剩余问题；不提交。
- [x] 用户于 2026-10-20 接受本地修复并授权提交；审阅说明见 `2026-10-20-memory-repair-review-5.md`。

### Task 6: 作品类别、进度与表达

**Files:** 仅 `src/current_works.mjs`、`scripts/current_works_*`（禁止改 db/companion/api）。
**Dependencies:** 可与 Task 1/5 并行。
**Acceptance criteria:** 游戏/剧集验证失败后 generic 保留原 kind；不把题材当真实作品名、不编造验证成功；generic 允许符合类别的普通活动进展但不虚构章节/关卡；明确无搜索 provider 的降级；prompt 不强迫把未知或未在当前档案的作品算作已完成；现有生命周期/真实作品校验仍成立。不要擅自迁移生产旧记录。
- [x] 在现有注入式 smoke 方式基础上先复现误写 book、generic 无进展与提示词行为。
- [x] 实现并运行相关 current_works/works_schedule 测试。
- [x] 写 task-6-report.md，包括修改文件、RED/GREEN证据、风险/未解项；不提交。
- [x] 用户于 2026-10-20 接受本地修复并授权提交；审阅说明见 `2026-10-20-memory-repair-review-6.md`。

### Task 7: 虚构历史隔离与历史迁移

**Files:** `src/backfill_history.mjs`、`src/db.mjs`、创建/绑定/回填入口、迁移与导出工具。
**Dependencies:** Tasks 2–4。
**Acceptance criteria:** 虚构共同经历显式 opt-in、与真实历史/用户事实分离；模拟记忆带来源，默认不作为真实事实召回；保留角色自身背景；历史不明项生成审阅清单，不盲删；完整迁移导出分页且保留主体、pin/status/时间/来源/向量元数据；数据库快照保留作回滚依据。

### Task 8: 表达约束与对照验收

**Files:** `src/companion.mjs`、对应 prompt smoke、审阅文档。
**Dependencies:** 前述数据与角色状态修复；Task 6 可先独立验收。
**Acceptance criteria:** reply_length 设置生效，取消与设置冲突的全局15字限制；压缩重复提示而保留事实/安全边界；同模型同输入的离线请求对照可审阅；真实自然度评测需要用户认可的模型调用条件，不擅自联网。说明当前架构是否还需更换记忆插件，以及迁移接口与选型理由。

## 逐项确认记录

Task 1 已于 2026-10-19 获用户确认；Task 2 同日已接受，Task 3、4、5 于 2026-10-20 已接受并获本地提交授权（分别包含于 `29712d7`、`78bc032`、`894e2f9`）。并行任务仅准备候选修复；按 Task 1→2→3→4→5→6→7→8 顺序提交用户最终确认，用户可调整顺序。确认不等于授权提交、推送或部署。
