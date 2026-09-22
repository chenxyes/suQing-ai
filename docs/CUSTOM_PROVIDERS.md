# 使用中转站配置图片、语音和向量模型

登录 `/app/setup.html`，展开「可选：图片、语音与向量模型」。图片理解/OCR、语音识别、语音合成、生图、Embedding 每项都可选择「自定义 OpenAI 兼容中转」，独立填写 Base URL、Model、API Key；TTS 还可填写 Voice ID。

先保存，再点击该项「测试已保存配置」。测试发起真实请求，生图和语音测试可能计费。测试成功仅说明当前配置能处理样例，不能保证中转站的所有模型都支持所有能力。

| 能力 | Base URL 后追加的路径 | 响应要求 |
| --- | --- | --- |
| 图片理解/OCR | `/chat/completions` | 多模态 image_url 输入，文本 content |
| ASR | `/audio/transcriptions` | multipart 音频输入，JSON text |
| TTS | `/audio/speech` | MP3 音频响应，voice 为中转站支持的音色 |
| 生图 | `/images/generations` | `data[0].url` 或 `data[0].b64_json` |
| Embedding | `/embeddings` | `data[0].embedding` 有限数值数组 |

例如服务文档要求 `https://relay.example/v1/audio/speech`，则填写 Base URL `https://relay.example/v1`。不要填完整操作路径或把 Key 放进 URL。只支持 HTTP(S)，禁止 URL 用户名/密码、查询参数和片段；API Key 必须是无空白 ASCII 字符，中文占位文本会被直接拒绝。

各能力使用 `${CAP}_BASE_URL`、`${CAP}_API_KEY`、`${CAP}_MODEL`、`${CAP}_PROVIDER=custom`（CAP 为 VISION、ASR、TTS、IMAGE、EMBEDDING）。设置页保存在本地 SQLite，优先于环境变量；修改后立即生效。Key 不回显；留空保留原 Key，首次保存必须提供 Key。设置校验失败不会部分写入。点击「恢复环境配置」删除该能力的页面 provider/model 覆盖，保留 Key 和 URL，以便以后重新启用。

厂商原有协议继续保留。生图/Embedding 的现有环境预设也可继续使用；新页面控件用于选择自定义中转或恢复环境预设。任意厂商私有协议不一定兼容 OpenAI；例如只提供 Gemini 原生生图 API 的中转站，需要其 OpenAI 兼容接口才能使用这里的自定义选项。自定义生图当前为文生图，不宣称支持参考图编辑。

更换 Embedding 模型后，原有向量可能不兼容，即使维度相同也不能直接比较。本次未迁移记忆或重建索引；请先评估并另行安排索引迁移。Chat 超时、空回复分类说明见 [排查报告](relay-incident-analysis.md)；审批式部署见 [AWS 发布说明](../deploy/AWS_RELEASE.md)。

ASR 连接测试发送仓库内固定的约 3 秒英语语音（“Hello. This is a speech recognition test.”），要求识别结果包含 `speech recognition test`（忽略大小写和标点）。空转录或无关文本不会被视为测试成功；只支持其它语言的模型可能无法通过这个英语样例。此检查不代替真实中转服务的兼容性验证。

自定义 Embedding 完整保留上游返回向量，不使用原厂商 `EMBEDDING_DIM` 截断，也不擅自指定模型输出维度；状态中的 custom `dim` 为 null，表示由模型决定。存储支持可变长度，现有余弦计算对不同长度返回零相似度；旧检索仍可能按重要性补足，因此换模型前仍需单独安排索引迁移。本次不修改原厂商向量处理或生产索引。

生图与 Embedding 的 `active_configured` 表示当前 provider 的本地配置是否具备所需字段（豆包还需接入点 ID），不表示凭据已经被上游验证；恢复环境配置后也按实际原厂商判断。

## Fish Audio 原生 TTS

设置页的 `Fish Audio` 是原生 provider，不使用 OpenAI 兼容的 `/audio/speech`。请求固定发送到 `https://api.fish.audio/v1/tts`，模型通过 `model` 请求头传递，文本使用 `text` 字段，音频固定请求为 MP3。`TTS_VOICE_ID` 在此 provider 中对应 Fish 的 `reference_id`，可以留空；填写时使用 Fish 账户可访问的声音模型 ID。

默认模型为 `s2.1-pro-free`，也可以在 Model 输入框中填写 Fish 账户可用的其它模型 ID。Fish provider 仍然是完整 MP3 返回后播放的普通 TTS，不提供麦克风实时会话或边生成边播放。

也可以通过环境变量配置：

```env
TTS_PROVIDER=fish
TTS_MODEL=s2.1-pro-free
TTS_VOICE_ID=your-reference-id
FISH_API_KEY=
```
