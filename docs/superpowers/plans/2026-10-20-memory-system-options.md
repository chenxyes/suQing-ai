# 记忆系统选型与迁移建议

建议先保留修复后的内置系统，验证中文对话的归属、召回和纠错效果；确有检索瓶颈时，优先试验 Mem0 OSS，关系时间线复杂时再考虑 Graphiti。外部系统不能直接替代本项目的说话人证据和撤销规则，也不会自动让 DeepSeek 更有生活感。

依据：本地修复分支 `codex/memory-repair` 的 `519406a`，以及 2026-10-20 只读核验的官方公开源。本文是选型及迁移方案；没有安装候选系统、迁移生产数据或做真实模型效果测试。

## 当前系统如何工作，能证明什么

| 环节 | 当前实现 | 对体验的影响 |
| --- | --- | --- |
| 提取 | `src/memory.mjs::extractAndSaveMemories` 从真实落库 turns 生成候选；`src/ai.mjs::extractStructuredInfo` 使用现有聊天调用链 | “记忆大模型”与向量模型是两件事。这里没有独立的 `MEMORY_MODEL` 路由；配置 DeepSeek 聊天并不意味着已经配置可用 embedding |
| 归属 | `src/memory_provenance.mjs::validateMemoryEvidence` 核对消息 ID、role、原句；区分 user/companion/shared | 角色说“我有一个妹妹”，不能凭该 assistant 消息写成用户事实。引述、假设等保守拒绝；可能漏记委婉表达，不能证明说话内容客观为真 |
| 存储和派生 | SQLite 保存事实、证据、状态及来源；画像、摘要、事件图追踪依赖 | 有来源链才能在更正、删除或“不再提起”后阻止旧摘要再次带回错误事实 |
| 召回 | `src/db.mjs::recallMemoriesHybrid`、`src/memory_retrieval.mjs` 合并中文词片段匹配、同空间向量相似度、重要度和时间衰减 | 没有有效向量仍有词面召回；同义改写的效果需要实际中文评测。当前在本地候选上评分，规模扩大后才需要评估专用索引 |
| 准入 | `src/memory_admission.mjs` 过滤受限、虚构及失效依赖；召回版本约束异步结果 | 换检索器也必须保留这些规则。旧 unknown 来源不会因换库自动变可信 |
| 向量 | `src/providers/embedding.mjs` 与 `src/memory_vectors.mjs` 保存 provider/model/dimension/endpoint 身份及内容散列 | 配置合法、真实调用成功、索引覆盖率应分开检查；相同维度也不代表可混用不同模型的向量 |

此前本地回归验证了上述机制；这不等于证明 DeepSeek 的真实提取准确率或自然度已经提升。实际效果要分开测：主体串线、同义召回、纠错后旧事实残留，以及措辞、重复追问、角色活动连贯性。机器人感还受提示词、回复长度和活动状态影响，属于本轮表达修复的范围，不能用更换数据库代替。

## 备选系统与选择原因

本项目当前 `package.json`、`src`、`scripts` 没有 Mem0、Graphiti、Zep 或 Letta 适配器。下列都是需要开发接入的候选系统；厂商给 Codex/其他框架提供的插件不能直接当成本项目已安装的记忆插件。

| 方案 | 适合解决的问题 | 本项目代价和边界 | 建议 |
| --- | --- | --- | --- |
| 保留内置 SQLite | 单机个人陪伴、明确主体、可解释纠错与撤销 | 运维最少，证据与管理界面一致；中文词面策略较简单，模型抽取及同义召回仍需测量 | **当前首选**。先把已修复行为和可用 embedding 跑通 |
| Mem0 OSS 自托管 | 通用个性化记忆 API、向量/混合检索、统一外部记忆接口 | 增加服务或 SDK、索引后端及监控；其 user/agent scope 不等于本项目逐句主体证明。需核验所锁版本的中文分词、嵌入及元数据过滤；不能把混合对话交给默认提取后直接当用户事实 | **首个外部试验候选**。初期仅写入已验证事实，保留本地权威记录；锁定版本后核对 `infer=false` 等直存接口 [1] |
| Graphiti 自托管 | “以前住哪里、何时搬家、关系何时变化”等跨时间和实体关系查询 | episode 来源、时间有效区间与混合图检索有价值；需 Python 服务与图数据库等依赖，抽取/消歧调用、备份和升级更复杂。兼容 OpenAI 协议不代表 DeepSeek 的结构化输出必然可靠 [2] | 只有中文关系/时间问题实测明显胜出才采用；个人单机场景优先级低于 Mem0 |
| Zep 托管服务 | 希望厂商承担图与上下文基础设施运维 | 当前 Zep 与 Graphiti 不是同一可自托管产品；旧 Community Edition 已停止支持。托管费用、数据处理位置、删除和导出约定需按当期服务核实 [3] | 只有愿意承担持续服务依赖和费用时考虑，不按“免费开源 Zep”规划部署 |
| Letta | 需要长期有状态 agent、可修改记忆/提示、工具与调度的一体化运行框架 | 替换范围涉及 agent 执行与上下文管理，远超记忆检索。官方现将活跃实现指向 `letta-code`，旧 V1 server 位于 archive；当前 AgentFile 导入导出也已弃用 [4] | 本轮不选。将来若决定整体重构自主 agent，再单独评估 |

Mem0、Graphiti、当前 Letta Code 仓库的根许可证核验为 Apache-2.0；本项目为 MIT。此结论不覆盖数据库、模型、全部附属组件或云服务条款。自托管免去某些服务订阅，不免除机器、备份、embedding、抽取及运维成本；这里没有给出未验证的固定月费。

**不要把厂商排行榜当成本项目效果。** Mem0 当前 README 明确标注托管评测含 OSS 不提供的专有优化，并介绍将 agent-generated facts 纳入记忆；示例 NLP 安装还使用英文模型。这些都需要针对中文陪伴场景重新验收，而不能据榜单推定自托管版本更会区分“我/你/她”。Graphiti 有来源与时序结构，但抽取仍由模型参与，仍须本项目校验。

## 替换时应保留的接口边界

建议把外部系统先作为“找候选”的索引。SQLite 继续保存原句、主体、状态和撤销版本。写入外部前只投影已准入事实；返回候选后用本地 memory ID 取回当前权威记录，再做 scope、状态、依赖和版本校验，最后生成聊天上下文。外部总结不能绕过这一步直接注入。

适配器至少需要：幂等写入、按用户和角色检索、按源 memory ID 更新/撤销、完整分页导出、重建索引和健康状态。可用 `(dataset_id, companion_scope, source_memory_id)` 作外部唯一映射；外部 `user_id`/`agent_id` 使用映射值，不能将 scope 元数据误当事实主体。

**撤销召回与彻底擦除要分别验收。** Mem0 源码的删除流程会保留含旧值的 history；Graphiti 的时间失效也不是物理删除，移除 episode 会涉及共享节点、事实及摘要重建 [5]。外部删除失败时，本地撤销版本应立即阻止注入，并重试索引清理。若目标是彻底擦除，还必须处理 history、图摘要、缓存、日志、导出和备份的保留策略；不能承诺一个 delete 调用已完成所有删除。

## 分阶段迁移与回退

1. **锁定基线。** 保留只读原始快照及散列；记录模型/提示、embedding 空间与版本、候选条数、延迟、索引覆盖率。先用合成中文样本比较；真实对话和真实模型评测另按用户授权范围执行。
2. **用 Task 7 v2 导出作为交换档案。** `scripts/persona_transfer.mjs export` 只读源库；`src/persona_memory_transfer.mjs` 导出全部状态的记忆、证据 turns、原 ID、主体、来源、时间、受限标记、依赖、冲突、压缩关系、召回 barrier 及原向量元数据。原 ID 是映射依据，目标库的本地主键允许变化；不能只搬一列摘要文本。它是角色/记忆交换格式，不是完整服务器备份，也还不是 Mem0/Graphiti 转换器。
3. **先隔离导入。** 本项目 v2 默认导入隔离历史和证据；仅离线、明确审阅且文件 SHA256 匹配的路径可尝试信任恢复，仍核验证据。旧 v1/unknown、synthetic、已删除/禁止提起的记录保留状态，不自动提升为用户事实。外部转换器也必须遵守此规则；候选索引只接收当前准入子集，受限原文留在受控档案，避免外发后再补删。
4. **重新建向量和映射。** 保留原向量用于原系统回退；只在完全相同空间且内容散列一致时才考虑复用。更换模型、端点或维度时，在新索引重算当前准入正文。每条事实维护旧 ID→新 ID 与证据 turn ID 映射；派生摘要不能丢来源；换库不恢复缺失的历史证据。
5. **影子比较。** 原系统继续回答，同一输入只记录外部候选差异。比较中文改写 Recall@k、错误主体注入、纠错后旧事实、遗忘/虚构隔离、跨用户/角色隔离、P95 延迟及实际 token/费用。固定“角色有妹妹，用户没有”“我引用你说的话”“我已经不住那里”等场景。建议硬门槛：这组归属/撤销/隔离用例零违规；相关召回不退步，并在确有痛点的样例上带来可说明的收益。
6. **小范围切换并可回退。** 获得最终确认后才部署：先单一角色切读路径，写入仍以 SQLite 为权威，经幂等队列同步外部；断网/索引故障回退内置召回。版本及删除事件必须同步，重试不能复活撤销数据。回退仅切检索器，保留切换期间新增的本地事实和撤销记录，不能用旧快照覆盖新数据。彻底替换权威库应另立迁移项目。

选择依据因此很具体：当前最重要的是“记住是谁说的、改错后不再提、中文能找回来”，这些已经有本地证据接口可继续验证。先保留它们，只有外部候选在同条件比较中有收益，才值得增加服务和迁移复杂度。

## 核验来源

以下官方仓库原文通过只读 HTTP 成功读取；不是安装或运行验证。链接固定到本次核验提交（Zep 与 Letta 历史仓库的说明页为当日 main）。版本更新后应重新确认接口、部署方式、许可证与价格。

1. [Mem0 README](https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/README.md)、[add/search 实现](https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/mem0/memory/main.py)、[许可证](https://github.com/mem0ai/mem0/blob/main/LICENSE)。
2. [Graphiti README：来源、时间、后端、兼容模型及结构化输出](https://github.com/getzep/graphiti/blob/6e3e3cb98edfac4ca5be6129002d76cdf714ad09/README.md)、[许可证](https://github.com/getzep/graphiti/blob/main/LICENSE)。
3. [Zep 当前仓库定位及旧 Community Edition 状态](https://github.com/getzep/zep/blob/main/README.md)。
4. [Letta 当前入口及 archive 说明](https://github.com/letta-ai/letta/blob/main/README.md)、[Letta Code README](https://github.com/letta-ai/letta-code/blob/e8073d4e475ab7f56e76f9aaeea81a7618a92575/README.md)、[许可证](https://github.com/letta-ai/letta-code/blob/main/LICENSE)。
5. [Mem0 `_delete_memory` 保留 history](https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/mem0/memory/main.py#L2111)、[Graphiti `remove_episode` 处理共享依赖与摘要](https://github.com/getzep/graphiti/blob/6e3e3cb98edfac4ca5be6129002d76cdf714ad09/graphiti_core/graphiti.py#L2174)。
