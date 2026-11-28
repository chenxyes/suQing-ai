# Changelog

所有重要修复与功能变更均按时间倒序登记于此。

---

## [Unreleased] - 2026-11-28

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
  - 提高 `runArchiveDailySchedule()` 归档阈值（`importance >= 6` → `>= 7`）并对近 30 条已归档活动去重，减少重复日程流水账稀释长期记忆。
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
