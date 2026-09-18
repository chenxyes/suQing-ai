# Relay Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 各能力支持中转自定义配置，修复聊天空响应处理，提供审批式 AWS 发布。
**Architecture:** 保留 provider 抽象并加入能力级 custom 配置；聊天边界分类响应；发布使用独立 workflow 和服务器脚本。
**Tech Stack:** Node >=20、ESM、Express、SQLite、原生 node:test、Docker Compose、GitHub Actions。

## Global Constraints

- 工作树：`.worktrees/relay-reliability`，分支 `codex/relay-reliability`；禁止合并和部署。
- 不修改记忆算法或生产配置，不提交密钥、聊天原文或用户数据。
- 保留现有厂商功能，新增能力必须覆盖设置 UI、API、运行时、连接测试。
- 每项先添加失败回归测试，再实现，报告命令与结果。

### Task 1: Custom model endpoints

**Files:** `src/providers/{vision,asr,tts,image,embedding}.mjs`, new `src/providers/custom.mjs`, `src/api.mjs`, `public/app/setup.html`, relevant photo availability checks, `.env.example`, `scripts/custom_provider_check.mjs`.
**Interfaces:** independent `${CAP}_BASE_URL`, `${CAP}_API_KEY`, `${CAP}_MODEL`, `${CAP}_PROVIDER=custom`; shared custom configuration helper; existing provider APIs unchanged.
- [ ] Create local HTTP relay regression script asserting vision `/chat/completions`, ASR `/audio/transcriptions`, TTS `/audio/speech`, image `/images/generations`, embedding `/embeddings` paths, independent keys/models, URL and base64 image responses, bounded failure.
- [ ] Run `node scripts/custom_provider_check.mjs` and record expected failure for unsupported provider.
- [ ] Add capability-specific configuration resolution, strict HTTP(S) URL/key validation and native compatible requests; account for provider availability checks and dynamic image settings.
- [ ] Extend authenticated setup metadata/save/test endpoints and settings UI, including image and embedding cards, custom base URL controls and effective settings. Atomic validation before mutation; key redaction and blank-key preservation.
- [ ] Run relay regression and relevant existing provider smoke checks, syntax and lint; document env parameters, commit task.

### Task 2: Chat response reliability

**Files:** `src/providers/chat.mjs`, `src/ai.mjs`, new focused response/retry helper if needed, `src/bot.mjs`, `src/playground.mjs`, regression script.
**Interfaces:** preserve `generateReply(...) -> string`; export common fallback predicate/constant for callers; provider result includes safe response metadata.
- [ ] Test through local fake endpoint returning empty content, empty choices, reasoning-only length finish, refusal/filter, 429, 401, transient empty then success and repeated failures.
- [ ] Confirm current empty response succeeds incorrectly; preserve evidence of failed test.
- [ ] Parse response types safely; classify failures and retry only recoverable cases with bounded total attempts. Disable SDK automatic retries. Validate configurable timeout and retry bounds. Log metadata only.
- [ ] Guard fallback persistence/postprocessing at both chat callers without changing memory algorithm; retain user input and recovery behavior.
- [ ] Run targeted tests, lint and relevant baseline tests; document which upstream cause remains unprovable from historical logs; commit task.

### Task 3: Approval-based AWS release

**Files:** new `.github/workflows/deploy-aws.yml`, `deploy/release.sh`, `deploy/compose.release.yml`, deployment docs and regression script.
**Interfaces:** manual workflow selects main commit; tested commit builds image; deploy receives immutable `ghcr.io/...@sha256:...` reference and existing server compose directory.
- [ ] Inspect deployment metadata read-only (mount paths, service, port and healthcheck), never read secrets.
- [ ] Write shell harness with fake docker validating deployment success, unhealthy candidate rollback, first-deploy failure, invalid inputs and missing approval configuration.
- [ ] Implement main-only release, CI gate, protected production environment, explicit reviewer-rule validation, pinned host key SSH, concurrency, bounded health polling, rollback and failure status.
- [ ] Run shell syntax, harness and YAML/action validation; document secrets/environment setup, least permissions, review gates and limitations; commit task.

### Task 4: Review and PR

- [ ] Run lint, import smoke, relevant existing checks and all new checks. Compare unchanged baseline failures before attributing them to this branch.
- [ ] Independent review of task diffs and full branch; resolve important findings with covering tests.
- [ ] Add regression commands to CI; update investigation report and progress ledger.
- [ ] Push branch, create PR with evidence and deployment prerequisites, attach PR, inspect checks. Do not merge or deploy.
