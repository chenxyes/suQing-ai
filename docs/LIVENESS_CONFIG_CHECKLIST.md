# SuQing 活人感配置核对清单（Phase 1）

本清单用于快速核对 `.env`、`/app/setup.html` 与角色 `persona_prompt`，确保 Phase 1 的**主/辅模型分离、后台思考流捕获、懂梗视神经与记忆召回**真正生效（无静默覆盖或降级）。

---

## 1. 环境变量与设置页核对

> **避坑提醒**：`CHAT_PROVIDER` 与 `CHAT_MODEL` 的生效优先级是 **`app_settings`（数据库设置页） > `.env`**。  
> 改完配置后运行 `npm run doctor`，确认实际生效来源无 `shadowed` 覆盖告警。

```env
# 1) 主对话模型（可用推理/思考模型，增强原生内心推演与活人语气）
CHAT_PROVIDER=deepseek
CHAT_MODEL=deepseek-reasoner          # 或 deepseek-flash / deepseek-chat

# 2) 辅助结构化模型（强烈建议配轻量非思考模型，防记忆/日记/Inner OS 触发 token_limit）
CHAT_AUX_PROVIDER=deepseek
CHAT_AUX_MODEL=deepseek-chat

# 3) 思考流调试与保底（绝不输出到微信/网页聊天气泡，仅 /app/debug-prompt.html 折叠查看）
CHAT_REASONING_CAPTURE=true
CHAT_REASONING_MAX_TOKENS=4096

# 4) Inner OS 双重思考（保持默认 always，与冲突弧检测完全兼容）
INNER_OS_MODE=always

# 5) 懂梗“视神经”（已内置梗图文字/弹幕/截图情绪识别提示词）
# 可选：deepseek (复用 DEEPSEEK_API_KEY) / qwen (qwen-vl-plus) / zhipu (glm-4v-flash) / custom
VISION_PROVIDER=deepseek
VISION_MODEL=deepseek-flash

# 6) 长期记忆向量召回（务必在 /app/setup.html 测试连通，避免退化为中文关键词 LIKE）
EMBEDDING_PROVIDER=qwen               # 或 openai / zhipu / gemini / custom（确保 Key 为纯 ASCII）

# 7) 联网搜索（激活 current_works 作品真实校验与后续 Phase 2 自主冲浪）
SEARCH_PROVIDER=tavily                # 或 searxng / brave
TAVILY_API_KEY=
```

---

## 2. 验证清单（5 分钟自检）

1. **运行 `npm run doctor`**：
   - 检查「AI 提供商」中 `CHAT_PROVIDER` / `CHAT_MODEL` 的实际生效来源，确认没有 `.env` 被数据库静默覆盖的警告；
   - 检查「活人感配置（Phase 1）」中 `aux` 模型、`VISION`、`EMBEDDING`、`SEARCH` 均符合预期。
2. **发一张带文字的梗图或截图**：
   - 确认她能读出图里的关键文字和槽点，而不是泛泛地说“这张图很有趣”。
3. **检查后台思考流隔离**：
   - 用思考模型聊一轮后，确认微信/网页气泡里**只有正常短句回复**，没有任何思维链泄露；
   - 打开 `/app/debug-prompt.html?id=<companionId>`，在「后台思考流」卡片中可看到最近几轮原生 `reasoning_content`。

---

## 3. 角色 `persona_prompt` “活人网感”调优模板（按需填入单角色额外设定）

> 以下模板只作用于单个角色，不破坏 SuQing 全局的短句 `||`、睡眠作息与反 AI 味护栏。

### 模板 A：自然轻吐槽 / 有主见日常感（推荐）
```text
你平时上网冲浪比较多，说话带一点点真实的网感和机灵劲儿，但不过度玩烂梗。
- 看到好笑的事或离谱的瓜会忍不住吐槽两句，有自己的审美和态度，不顺着对方敷衍夸；
- 偶尔会嘴硬、小傲娇，或者突然岔开话题聊一件刚想起来的小事；
- 聊到不感兴趣的话题会直接说“这个我不太感冒”，不硬聊、不讲道理、不给人生建议。
```

### 模板 B：高活人感 / 嘴毒护短活宝风（偏大肥鱼吐槽感）
```text
你脑回路很活，平时像个半夜睡不着还在刷手机的真实年轻人，爱吐槽、反应快、情绪鲜活。
- 对方发沙雕图或离谱事时会毫不客气地先笑/先吐槽，再自然接梗；
- 嘴上偶尔损两句、爱阴阳怪气逗对方，但真遇到对方难受或有正事时立刻收起玩笑认真护着；
- 绝不说教、绝不总结陈词、绝不用客服腔，没想好回什么就直说“等下我缓会儿”或发个语气词。
```
