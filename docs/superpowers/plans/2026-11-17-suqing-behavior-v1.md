# suqing 相处行为 V1 实施计划

**目标：**把狗头军师的方法转成 suqing 自己执行的相处行为，完成受挫安慰、分享喜悦、争执修复三个场景的候选选择、行动约束、多轮延续和基本后续关心。

**起点：**`main` / `8218c090836ed5db6e492dc5dabaa7dda1e7243d`；实施分支 `codex/suqing-behavior-v1`，使用独立 worktree。需求来源：本次对话及 `docs/ROADMAP.md` 的 V1–V5 优化目标。

**架构：**本地、可替换的行为方案库 → 现有 Inner OS 同一次调用产出候选行动 → 程序按场景、用户边界、关系状态校验 → suqing 生成回复 → 实际输出记账。后续行动复用主动调度，不新增常驻 agent、Python 服务或向量数据库。

## 全局约束

- 不修改、提交、推送或回滚 main/master；不自动提交、推送、部署。
- Node ESM + 现有 SQLite；不增加运行依赖，不使用 Python。
- `BEHAVIOR_ENABLED=true` 显式启用，默认关闭，保留现有行为。`BEHAVIOR_LIBRARY_DIR` 可指定外挂目录；加载异常不阻塞聊天。
- 行为执行者是 suqing，不能把相处方法输出为教用户操作他人的教程；不以消息量、依赖程度或留存作为学习奖励。
- 仅三类情境加暂停控制；其他场景走现有聊天。安全风险、未成年人模式、明确停止信号优先；不修改好感、关系状态机的转移规则。
- 保留旧 Inner OS 的 thought/struct 调用契约；新计划使用白名单字段和动作，不接受模型生成的任意工具或代码。
- 基本延时关心仅支持用户明确请求的“数字分钟/小时后再找/问/陪/聊我”，1–1440 分钟；仅微信且主动消息允许。网页仅多轮延续，不承诺后台推送。自然日期、复杂多步计划属 V2。
- 策略和任务写入遵守隐私过滤；probe、无效 companion、生成失败不产生成功执行记录。发送成功不等于心理效果成功。
- 用户换题/明确停止能退出；不把短确认、沉默或未回复判成策略失败。
- 延迟任务必须有到期、取消、失效和幂等领取；发送早退不算 sent，部分送达记录实际文本，不盲目重发整段。

## 共享接口

`prepareBehaviorContext({ companion, userText, history, previous, arcState, safetyLevel, channel })`：返回候选上下文或 null；内部检查 feature flag。

`buildBehaviorPlanningHint(context)`：Inner OS 使用的短指令，约定候选 JSON 的 `behavior` 字段 `{ scenario, action }`。

`resolveBehaviorPlan(context, rawBehavior, { arcState, safetyLevel } = {})`：返回经过校验的计划或 null。计划字段固定为 `{ scenario, action, sourceId, sourceRevision, arcState, followup }`。scenario=`support|celebrate|repair|pause`；action=`validate|listen|suggest|celebrate|clarify|repair|pause`。followup=null 或 `{ delayMinutes }`，只从显式用户请求和通道能力生成，不信任模型的时间。

`buildBehaviorReplyHint(plan)`：返回面向 suqing 的执行指导，绑定来源，不泄露 JSON；包含关系状态约束、不能凭空认错/虚构经历、不能承诺未安排的动作。

`readBehaviorState(companionId, { now } = {})`：最近有效计划或 null。

`observeBehaviorInput(companionId, userText, { probe, now } = {})`：处理显式取消/结束，不记成功；其他输入不能凭空删除承诺。

`recordBehaviorDelivery({ companionId, turnKey, plan, userText, deliveredText, channel, probe, now })`：幂等保存实际执行，并按显式授权创建一个后续任务；返回记录或 null。

## Task 1: 行为方案与纯运行时

**负责文件：**新增 `src/behavior_library.mjs`、`src/behavior_runtime.mjs`、`config/behavior/*.json`、`config/behavior/LICENSE.goutoujunshi`、`scripts/behavior_runtime_check.mjs`。

实现上述四个纯运行时接口。方案由上游已核对的共情、赞美/回应喜悦、冲突修复内容改写，记录上游仓库、固定 revision `6db7354a4002dc7c448a9c87ffdad8132570c9d3` 和路径，保留 MIT notice。方案具备适用条件、行动、避免行为和退出条件。三场景中的候选列表小而有界；对外部目录做 schema 与长度校验。普通闲聊不注入。

**测试先行：**真实纯函数覆盖受挫→倾听→明确求建议、喜悦、直接关系修复/第三方吵架区分、停止/换题、无关闲聊、非法模型动作、加载损坏、安全/未成年人跳过、短句延续、延迟请求通道限制。不要只匹配源码字符串。

## Task 2: 持久化与后续行动投递

**负责文件：**`src/db.mjs` 的独立行为迁移、新增 `src/behavior_tasks.mjs`、修改 `src/proactive.mjs`、新增 `scripts/behavior_tasks_check.mjs` 和投递回归测试。

实现三个共享持久化接口。SQLite 保存行动来源、动作、有限的脱敏上下文、实际文本、turnKey，独立于个人记忆表；保存基本后续任务。按 companion 隔离，唯一执行 key，时间使用 epoch ms；任务有领取租约和失效窗口；只对允许微信推送的角色安排显式请求。

到期任务接现有 scheduler 和发送安全/频率/睡眠/会话门，发送前再次检查取消和过时状态。不得绕过原有安全规则、不得靠普通随机日程才能兑现。修正 sender 返回结果，让 sent/partial/skipped/failed 对实际投递负责，更新既有 caller 的配额逻辑，防重复。后续消息围绕已授权话题，不得因反重复重生切到完全无关话题后记为完成。

**测试先行：**临时真实 SQLite 验证隔离、脱敏、重复 turn、probe、取消、领取竞争、过期、重启状态、投递失败不完成/部分投递不重复；明确 due 之前不发。mock 仅限网络/LLM 边界。与 Task 1 以共享 plan 契约交互，不编辑其文件。

## Task 3: Inner OS 与两个聊天入口接线

**负责文件：**`src/inner_os.mjs`、`src/bot.mjs`、`src/playground.mjs`、必要的 `src/ai.mjs` 调用用途选项、新增集成检查脚本。

同一次 Inner OS 调用提供候选方案并产出 behavior，保持旧 struct 兼容；使用可解析嵌套 JSON 的协议，不把计划泄露为独白。预处理不走联网搜索/对话文本清洗，按输出协议增加有上限预算。已有情境的短句仍能被处理，关闭 Inner OS/解析失败可保守回退。

两个入口共用 prepare/resolve/hint。微信 arc tick 后再校验计划；网页补齐行为启用时所需的关系上下文，probe 不运行写入 tick。行为计划生效时，避免同时拼接强制冷淡与修复指令；保留状态边界、反操控红线和人物性格。不因策略直接升好感或强行原谅。

在最终输出/实际发送后记录行为；微信发送前二次合并的被弃稿不能落成功记录；生成/发送失败不能创建假承诺；网页仅在成功保存结果后记录 channel=web，probe 不写。只传受限计划，不向用户/API 暴露内部规划。

## Task 4: 文档、验收与回归

更新 `docs/ROADMAP.md` 写明 V1–V5 的目标、验收门槛及真实进度；新增使用/设计说明，写明启用与外挂目录、数据、能力限制。新测试加入 package 脚本及 CI。保留现有测试，不把代码检查冒充真实模型效果验证。

执行修改文件语法检查、ESLint、导入、P0、开源检查和相关 Inner OS/冲突/安全/主动消息/探针测试。独立检查完整 diff，修复实际发现。若缺少可用模型配置，明确报告真实多轮效果和延迟成本尚待验证，V1 标为代码验收完成/效果待评测，不宣称产品效果已达成。

## 执行记录

- 2026-11-17：计划与优化目标已建立；开始 V1。未读取或使用生产密钥，不改主分支。

- 2026-11-17：V1 代码接线与回归完成，使用本地 HTTP 模型替身和临时 SQLite 验证；真实模型效果评测待进行，详见 `docs/BEHAVIOR.md`。新增 `inputStartedAt` 取消屏障；已发送但执行期间被取消的旧计划不重新激活状态/任务。暂停由独立停止标记表达，不要求新增成功执行记录。
