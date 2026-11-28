# TODO · 苏晴体验升级路线清单

> 记录基于 2026-11-28 线上排查与架构评审确定的「数字衣橱」与「三层虚拟约会框架」联合拆分清单。

---

## 任务 1：数字衣橱 + 发图送礼试穿系统（衣服、包包、鞋子等）

详细架构见 [docs/WARDROBE_AND_TRYON_ARCHITECTURE.md](docs/WARDROBE_AND_TRYON_ARCHITECTURE.md)。

- [x] **1-A · 架构与数据闭环**
  - [x] 输出完整数据模型、状态机、微信连发图片融合、多图参考编辑与按品类机位路由方案
  - [x] `companion_wardrobe` 数据库表、槽位唯一 `wearing` 切换与级联清理（`src/db.mjs`）
  - [x] `src/wardrobe.mjs`：意图识别（即时试穿 / 直接赠送 / 下单等快递 / 换穿点名）、Vision 结构化单品解析、原图落盘、≤80 token Prompt 注入块、按品类机位路由
  - [x] 多图参考生图能力：`customImage` 支持 `/images/edits`（`image[]` 多图输入，失败自动 fail-open 降级 `/images/generations`），`openrouter`/`302ai`/`photo_sender` 同步支持多参考图
- [x] **1-B · 双端与异步任务接入**
  - [x] 微信连发图片融合：`bot.mjs` 的 `pendingBursts` 携带图片 Buffer，自动承接“先发商品图 + 再发文字”的微信习惯并触发衣橱入库与试穿返图
  - [x] 快递拆箱定时任务：`plan_tasks.mjs` 每 10 分钟巡检 `in_transit` 到期包裹，自动转为 `wearing` 并主动推送拆箱消息与试穿返图
  - [x] REST API：`GET/POST/PATCH/DELETE /api/companions/:id/wardrobe`、单品图片接口、一键试穿接口、人物参考图上传接口
  - [x] Dashboard「👗 衣橱与工具」可视化衣橱卡片（原商品图 + 试穿图 + 一键换穿/试穿 + 人物参考图上传）与网页 Playground 同步接入
- [x] **1-C · 测试与联动彩蛋**
  - [x] 自动化回归测试并接入 CI（`scripts/wardrobe_tryon_check.mjs`）
  - [x] 周末日程穿戴回访彩蛋（与任务 2-C 一起落地：“今天出门背了你送的那个小包”）
- [ ] **待用户提供素材**
  - [ ] 上传并锁定苏晴正式人物参考图（已就绪：`POST /api/companions/:id/visual-identity/upload-reference` 与 Dashboard 一键上传按钮）

---

## 任务 2：三层虚拟约会与相处框架（异地恋底盘 + 拍图云约会 + 可结算约会剧场）

详细架构见 [docs/VIRTUAL_DATING_AND_RELATIONSHIP_ARCHITECTURE.md](docs/VIRTUAL_DATING_AND_RELATIONSHIP_ARCHITECTURE.md)。

核心组合：**「异地恋」做底盘防内耗 +「送礼换装 & 随手拍图/赛博合影」承接日常逛街吃饭欲 +「有进有出、带记忆结算的约会剧场」承接高甜沉浸时刻。**

- [x] **2-A · 技术架构与联合任务拆分**
  - [x] 沉淀三层相处框架架构文档（`docs/VIRTUAL_DATING_AND_RELATIONSHIP_ARCHITECTURE.md`）并与数字衣橱完成联动设计
- [x] **2-B · 数据模型与核心服务（`src/db.mjs` + `src/persona_export.mjs` + `src/date_mode.mjs`）**
  - [x] `companions.presence_mode`（`local` / `ldr` / `digital`）增量迁移与导入导出字段对齐
  - [x] `companion_date_sessions` 表、索引、级联清理与完整 CRUD 封装
  - [x] `src/date_mode.mjs`：底盘提示词、云约会拍图识别（饭搭子/云逛街/赛博合影）、约会剧场启停与数字衣橱穿搭快照、多图赛博合影/约会打卡照生成、结束自动结算（写入高权重记忆 + 核销关联 `open_loops` + 重置场景）、周末衣橱穿戴回访提示
- [x] **2-C · 运行时全链路集成**
  - [x] `companion.mjs` / `reply_prompt.mjs` / `reply_pipeline.mjs` 注入 `presenceHint` 与 `dateSession`
  - [x] `reply_review.mjs` 在 `dateSession` 进行期间放行剧场互动（跳过独处日程覆写与动作旁白裁切），非约会状态保持零回归
  - [x] `plan_tasks.mjs` 注入 `presence_mode` 约束与周末数字衣橱穿戴回访彩蛋
  - [x] `bot.mjs` 与 `playground.mjs` 接入约会剧场自然触发/结算、云约会上下文与微信赛博合影异步返图
- [x] **2-D · REST API 与 Web Dashboard 控制台**
  - [x] `src/api.mjs`：`presence-mode` 切换、`date-mode` 状态/开启/结算/打卡照/赛博合影/图片接口，同步补充 `companionSummary.presence_mode`
  - [x] Dashboard「💕 相处底盘 & 约会剧场」折叠卡片（底盘切换 + 快捷开启/结算约会 + 穿搭联动展示 + 一键赛博合影）
- [x] **2-E · 自动化测试与 CI 闭环**
  - [x] 新增 `scripts/date_mode_check.mjs` 并接入 `.github/workflows/ci.yml`
  - [x] 登记 `CHANGELOG.md` 并通过全量本地 CI 回归检查

---

## 任务 3（Phase 4）：姿势库 & 精选服装预设库 & 360° 旋转展台规划

借鉴社区高星方案 `atuizz/posewear`（姿势与服装参考库）与 `Arekejoker/sprite-turntable`（360° 手办旋转展台）：

- [ ] **Phase 4-A（即将开工）· 姿势库 + 精选服装预设库（零额外模型依赖）**
  - [ ] 内置双语「单人试穿姿势库」（对镜比耶、回眸一笑、侧身秀包、慵懒靠墙、元气街拍、插兜酷girl、窗边托腮、轻撩头发等）
  - [ ] 内置双语「双人约会合影姿势库」（并肩比耶、靠肩自拍、面对面吃漂亮饭、街角牵手回眸、夕阳剪影漫步等）
  - [ ] 内置「精选服装灵感预设库」（学院 JK、秋冬毛呢/羽绒外套、温柔针织开衫、百褶裙、复古腋下包、马丁靴/小白鞋、精致配饰等），一键收入展柜或直接试穿
  - [ ] 打通展示柜试穿、整套叠穿 OOTD 合拍与约会/双人合影接口的 `pose_id` 精准控姿参数，并接入 Dashboard & Playground 可视化选择器
- [ ] **Phase 4-B（TODO 备选）· 试穿大片 360° 旋转展示台**
  - [ ] 轻量版：复用现有生图模型生成 8 视角环绕定妆拼图 + `sharp` 切片 + HTML5 Canvas 拖拽旋转展台（零 GPU）
  - [ ] 旗舰版（待有视频生成资源后接入）：对接首尾帧 360° Orbit 视频模型 + 透明抠图 72 帧序列导入与 Canvas 无极旋转
