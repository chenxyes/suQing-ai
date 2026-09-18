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
- [x] Create local HTTP relay regression script asserting vision `/chat/completions`, ASR `/audio/transcriptions`, TTS `/audio/speech`, image `/images/generations`, embedding `/embeddings` paths, independent keys/models, URL and base64 image responses, bounded failure.
- [x] Run `node scripts/custom_provider_check.mjs` and record expected failure for unsupported provider.
- [x] Add capability-specific configuration resolution, strict HTTP(S) URL/key validation and native compatible requests; account for provider availability checks and dynamic image settings.
- [x] Extend authenticated setup metadata/save/test endpoints and settings UI, including image and embedding cards, custom base URL controls and effective settings. Atomic validation before mutation; key redaction and blank-key preservation.
- [x] Run relay regression and relevant existing provider smoke checks, syntax and lint; document env parameters, commit task.

### Task 2: Chat response reliability

**Files:** `src/providers/chat.mjs`, `src/ai.mjs`, new focused response/retry helper if needed, `src/bot.mjs`, `src/playground.mjs`, regression script.
**Interfaces:** preserve `generateReply(...) -> string`; export common fallback predicate/constant for callers; provider result includes safe response metadata.
- [x] Test through local fake endpoint returning empty content, empty choices, reasoning-only length finish, refusal/filter, 429, 401, transient empty then success and repeated failures.
- [x] Confirm current empty response succeeds incorrectly; preserve evidence of failed test.
- [x] Parse response types safely; classify failures and retry only recoverable cases with bounded total attempts. Disable SDK automatic retries. Validate configurable timeout and retry bounds. Log metadata only.
- [x] Guard fallback persistence/postprocessing at both chat callers without changing memory algorithm; retain user input and recovery behavior.
- [x] Run targeted tests, lint and relevant baseline tests; document which upstream cause remains unprovable from historical logs; commit task.

### Task 3: Approval-based AWS release

**Files:** new `.github/workflows/deploy-aws.yml`, `deploy/release.sh`, `deploy/compose.release.yml`, deployment docs and regression script.
**Interfaces:** manual workflow selects main commit; tested commit builds image; deploy receives immutable `ghcr.io/...@sha256:...` reference and existing server compose directory.
- [x] Inspect deployment metadata read-only (mount paths, service, port and healthcheck), never read secrets.
- [x] Write shell harness with fake docker validating deployment success, unhealthy candidate rollback, first-deploy failure, invalid inputs and missing approval configuration.
- [x] Implement main-only release, CI gate, protected production environment, explicit reviewer-rule validation, pinned host key SSH, concurrency, bounded health polling, rollback and failure status.
- [x] Run shell syntax, harness and YAML/action validation; document secrets/environment setup, least permissions, review gates and limitations; commit task.

### Task 4: Review and PR

- [x] Run lint, import smoke, relevant existing checks and all new checks. Compare unchanged baseline failures before attributing them to this branch.
- [x] Independent review of task diffs and full branch; resolve important findings with covering tests.
- [x] Add regression commands to CI; update investigation report and progress ledger.
- [x] Push branch, create PR with evidence and deployment prerequisites, attach PR, inspect checks. Do not merge or deploy.

## Verification record (2026-09-18)

- All 56 standalone node/npm checks from CI passed locally, including existing regression suites; original P0 baseline: 131/131.
- ESLint, import smoke (21/21), full module syntax checks, actionlint 1.7.7 and shell syntax checks passed.
- Local authenticated HTTP fixtures cover independent save/status/probe/runtime settings for all five custom capabilities, atomic rejection, secret handling and image formats.
- Local browser exercised image and OCR save/probe and reload persistence; saved keys remain blank in the form.
- Chat tests cover empty recovery, bounded attempts, refusal/truncation/auth/rate-limit/timeout, dispatch configuration attribution, log redaction and failed-turn persistence.
- UI regressions execute actual tab initialization and search save logic. Search success regression was red before correcting the undefined variable and green afterward.
- Release tests cover 9 deployment/rollback scenarios and 8 approval/commit/CI gates; no real AWS release performed.
- Independent reviews identified search success reporting, proactive failure accounting, and auxiliary fallback propagation. Focused guards and behavioral regressions cover these paths, including preserving source memories when summary generation fails. Memory extraction, retrieval and ranking are unchanged.

Production remains untouched. The production environment/reviewer rules and SSH secrets require owner setup before any authorized deployment. The precise historical upstream reason for each fallback cannot be recovered from old logs; see the investigation report for evidence and limits.

PR: https://github.com/chenxyes/suQing-ai/pull/1 — open for owner review; no merge or deployment. GitHub check status is live on the PR.
