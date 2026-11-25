# V1 事实约束生成与按需输出审查

起点：664a6a6，codex/suqing-behavior-v1 独立 worktree，开始时干净。用户明确授权调整架构并实施组合方案；继续 PR #9，不修改 main，不部署。Node ESM / SQLite，复用 provider、记忆来源校验和投递账本，不增加依赖。

## 设计与契约

V1 采用单独、共用的回复管线，替代两入口的旧式混合提示生成；关闭 V1 时保留原兼容路径。现有安全/未成年人/关系状态转移/投递/记忆落账仍由对应层负责。审查不是新的策略规划，不修改关系或安排任务。

1. src/reply_context.mjs：buildReplyContext({userText,history,memories,userProfile,events=[],now})，纯函数，输出 {version:1,current:{id:'current',role:'user',text},history:[{id,role,text,at}],facts:[{id,subject,text,kind,at,evidence}],events:[...],unknown:[{id,reason}]}。保留原始说话人，助手的问句和推断不成为用户事实；记忆过现有准入校验，摘要/无证据/未知主体不晋升事实。profile 只接收 getUserProfileForRecall 的结果，标记为 profile 来源，保留不同证据级别。事件保留状态/时间，不把历史意向当当前未完成承诺。
2. src/reply_prompt.mjs + config/SOUL.md：buildGroundedReplyPrompt(companion,{context,behaviorPlan,arcState,personaFacts,preferences,dailySchedule,channel,...})。稳定表达原则单一来源，人物资料与用户事实分区；按当前动作加载方法卡，删除 V1 上叠加旧模板的路径。人格、阶段、偏好、明确用户塑造保留；模糊长摘要和自由内心独白不用作事实。
3. src/reply_review.mjs：reviewGroundedReply({draft,context,companion,behaviorPlan,accountId,probe,mode}) -> {reply,status,reasons}。mode=adaptive 默认，仅严格白名单的无事实短确认可跳过；mode=all 用于评测。其他草稿最多一次有超时与 token 上限的 provider 调用，返回 keep/revise 与理由；保留原话证据，审查事实/当前行动/边界/无授权承诺。无效、失败或超时返回既有 CHAT_FALLBACK，不能泄漏 JSON 或保留未审草稿。probe 零写入。该模块的调用进入已有 ai_usage_events，增加 purpose 列区分 reply/internal/review，不新建账本。
4. src/reply_pipeline.mjs：generateGroundedReply(options) -> {reply,review}，组合上述三层与现有 generateReply，不持久化对话、不发送消息。bot/playground/行为跟进共用；最终安全处理在审查后，所有生成/修订使用同一上下文。成功投递后才做原有记录，审查失败不产生成功行为或任务。

## 实施任务

- [x] Task 1（独立代理）：事实上下文与针对角色归属、错误记忆、未知信息、事件状态的纯回归；仅 reply_context.mjs 和对应检查脚本。
- [x] Task 2（独立代理）：审查协议、保守跳过、失败策略及 usage purpose；仅 reply_review.mjs、对应检查脚本、db.mjs 的 usage 扩展、ai.mjs 的 purpose 透传。
- [x] Task 3（主代理）：精简 SOUL/提示、共用生成管线、微信/网页/行为跟进整合；删除被取代的 V1 提示拼装，不叠加两套输出审查。
- [x] Task 4：更新集成测试（HTTP+SQLite）和真实模型脚本；复验历史失败样本、增加证据/审查误判反例，记录 draft 与最终回复、按用途调用与 token、延迟、降级次数。真实模型至少四组多轮，不能用字段匹配替代实际效果审核。
- [x] Task 5：独立审查整合 diff；本地 CI/P0/开源检查及远程 CI，通过后提交更新 PR #9，文档诚实记录能力和评测范围。保持特性开关默认关闭，生产发布另行授权。

## 验收

买/煮未回答不能断言；驾照不能编既往练车/失败；不想被催应回应边界；明确求助不反问要不要建议；停止后不恢复追问；时间范围原样尊重，不虚构后台联系。保留人物个性与合理澄清，安全/未成年人不进入恋爱方法。全量审查与 adaptive 对照应显示跳过只发生在明确无事实短回复。审查失败进入可观测降级，不发送原草稿。既有记忆撤销/敏感权限、probe、部分送达、取消竞态保持正确。

## 决策

用户已明确允许审查增加的调用开销，无需重复申请架构批准。先用当前 provider 验证方案；不引入新模型服务、代理框架或第二记忆库。旧协议只在开关关闭路径存在。当前 PR #8 仍独立，避免自动交叉合并；事件输入遵守已有状态，后续发布前须明确两项修复的整合顺序。
