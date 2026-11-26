# 抖音 Sidecar 桥接协议与接入指南（路线 1）

本文档说明如何将外部开源抖音发布/评论工具（例如 [`dreammis/social-auto-upload`](https://github.com/dreammis/social-auto-upload)、[`liaogx/douyin-mcp`](https://github.com/liaogx/douyin-mcp)、[`wenyg/douyin-creator-tools`](https://github.com/wenyg/douyin-creator-tools) 或自建桥接服务）接入 `suQing-ai`，实现 **suQing 自主发图文/视频到抖音** 与 **自动巡检回复抖音评论**。

---

## 为什么采用 Sidecar 路线 1？

1. **主程序零膨胀**：`suQing-ai` 主容器不塞入 500MB Chromium / Playwright，保持轻量稳定。
2. **解耦易维护**：抖音创作者中心网页改版时，只需更新社区发布器仓库，无需修改 `suQing-ai`。
3. **安全边界清晰**：
   - 全程跑在 `public_mode` 公域隔离层（零读取 1v1 私人记忆/好感度/关系弧，零修改情绪机）；
   - `safe_mode=1` 或未满 18 岁人设强制锁定禁入；
   - 外部地址仅允许 `https://` 或本机 `http://127.0.0.1` / `http://localhost`；
   - 遇登录失效（`LOGIN_REQUIRED`）或安全验证（`CAPTCHA_REQUIRED`），立刻优雅暂停并在 `/app/studio.html` 弹窗提示人工处理，绝不尝试绕过验证码。

---

## 接入方式 A：直接对接 `social-auto-upload` (`sau` CLI)

适合**仅需自动发图文/视频**、且发布器与 `suQing-ai` 装在同一台机器的场景：

1. 按 [dreammis/social-auto-upload](https://github.com/dreammis/social-auto-upload) 文档安装 `sau`，先手动扫码登录一次：
   ```bash
   sau douyin login --account default
   sau douyin check --account default
   ```
2. 打开 `suQing-ai` 的 `/app/studio.html` → 模块 3「自主发抖音 & 自动回评论」：
   - 勾选 **启用 Sidecar 桥接总开关**
   - 连接模式选 **本机 social-auto-upload (sau CLI)**，填写 `sau` 路径和账号名（如 `default`）
   - 勾选 **允许她不定时自己决定构思并生成图文/视频** 与 **合成后自动推送到 Sidecar**
   - 点 **保存 Sidecar 配置** → **检测 Sidecar 与登录态**。

---

## 接入方式 B：HTTP Sidecar 协议（推荐：同时支持自主发稿 + 自动回评论）

任何实现以下 4 个 JSON 接口的本地或 HTTPS 服务（例如封装 `sau` + `douyin-creator-tools` / `liaogx/douyin-mcp` / 未来企业号 Open API 网关）都可以零改动接入。

> 若配置了 `Bearer Token`，`suQing-ai` 会在所有请求头附带 `Authorization: Bearer <token>`。

### 1. 健康与登录态检查：`GET /health`
响应示例：
```json
{
  "ok": true,
  "logged_in": true,
  "account_name": "素清的日常",
  "supports_comments": true,
  "detail": "创作者中心会话有效"
}
```

### 2. 发布图文或 9:16 视频：`POST /publish`
请求体：
```json
{
  "platform": "douyin",
  "draft_id": 12,
  "format": "image_post",
  "title": "靠窗第三排的光真的很好睡",
  "caption": "下午跑去咖啡馆摸鱼画画，顺手拍了两张。",
  "hashtags": ["日常碎碎念", "咖啡馆"],
  "voice_script": "今天下午找了个靠窗的位置...",
  "media_files": [
    { "name": "img_1.png", "path": "/abs/path/to/data/social_studio/c_1/draft_12/img_1.png" }
  ],
  "audio_file": null,
  "video_file": null,
  "draft_only": true
}
```
成功响应：
```json
{
  "ok": true,
  "item_id": "7412345678901234567",
  "draft_only": true,
  "detail": "已上传到抖音草稿箱"
}
```
若登录过期或触发安全验证，请返回 `401` 或 `429` 并带上标准错误码（`suQing-ai` 会立刻暂停并提醒人工介入）：
```json
{
  "ok": false,
  "code": "LOGIN_REQUIRED",
  "error": "创作者中心 Cookie 已过期，请重新扫码登录"
}
```
（安全验证请返回 `"code": "CAPTCHA_REQUIRED"`）

### 3. 拉取未回复评论：`GET /comments/unreplied?limit=10`
响应示例：
```json
{
  "ok": true,
  "comments": [
    {
      "comment_id": "c_987654321",
      "item_id": "7412345678901234567",
      "item_title": "靠窗第三排的光真的很好睡",
      "author_name": "路过的橘猫",
      "text": "这杯冰美式看着好香，在哪家店呀？",
      "created_at": "2026-11-27T08:30:00Z"
    }
  ]
}
```

### 4. 发送评论回复：`POST /comments/reply`
请求体：
```json
{
  "comment_id": "c_987654321",
  "item_id": "7412345678901234567",
  "text": "哈哈就是楼下拐角那家小店，豆子还挺香的～"
}
```
响应示例：
```json
{
  "ok": true,
  "reply_id": "r_111222333",
  "detail": "评论回复成功"
}
```
