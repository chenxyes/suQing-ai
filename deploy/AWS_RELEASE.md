# AWS 手动审批发布

本流程只在手动运行 `Approved AWS release` 后构建镜像；SSH 部署还需要 GitHub `production` environment 审批。普通 push、合并 PR、推送 tag 都不会自动部署服务器。现有 `docker-publish.yml` 仍可发布镜像，但没有 SSH 部署动作。

## 首次配置（须经仓库/服务器所有者许可）

1. 合并通过审查的 PR。等待目标 main commit 的 `CI` push 运行成功。
2. Settings → Environments → 创建 `production`，在 Required reviewers 中指定批准人；将部署分支限制为 main，建议禁止管理员绕过保护。单人仓库需要允许批准人审批自己手动发起的运行。工作流会在构建前及批准后检查 Required reviewers，配置缺失或读取失败即拒绝部署。
3. 在 production 添加 secrets：`DEPLOY_HOST`（DNS/IPv4）、`DEPLOY_USER`、`DEPLOY_SSH_KEY`（专用部署私钥）、`DEPLOY_KNOWN_HOSTS`（通过可信渠道核验的主机公钥）。不要在 workflow 临时 ssh-keyscan 后无条件信任。SSH 当前使用标准 22 端口。
4. 添加 environment variable `DEPLOY_DIR=/home/ubuntu/xiyu-ai`。当前目录不含空格；此流程仅接受无空格的绝对路径。运行用户须能在该目录写 `.release`，并调用 Docker/Compose。Docker 访问权限等同于主机高权限，密钥必须专用。
5. 服务器保留现有 `docker-compose.yml`、`.env`、数据目录、微信凭据和头像挂载；已有 `xiyu-ai` 服务须运行且提供 Docker healthcheck。无需将私密配置放到 GitHub 或镜像。
6. 确认服务器能拉取 GHCR 镜像。公共仓库不意味着包一定公开；首次包可能为私有。将包设为可读，或由管理员在服务器预先 `docker login ghcr.io`（只读 packages 凭据）。脚本拉取失败不会替换服务。

`ssh qing` 是本地 SSH 别名，GitHub runner 不认识；必须填写实际主机和单独的部署凭据。本次开发没有创建 production environment、上传 secrets 或执行部署。

## 发布

Actions → Approved AWS release → Run workflow：选择 main，填写经过 CI 的完整 40 位小写 commit SHA。预检验证提交属于 main 历史且同 SHA 的 push CI 已成功。镜像支持 amd64/arm64；服务器最终使用 `ghcr.io/...@sha256:...` digest，而非 latest/tag。

检查构建结果、提交和镜像后，在 production deployment review 中批准。作业再次核对门禁，固定 SSH 主机密钥，把版本中的发布脚本传到服务器，并复用现有 Compose 项目和挂载。发布串行执行，不取消正在进行的发布。

脚本先拉取候选镜像，再切换单个服务。旧镜像被本地 rollback tag 保留。Docker 健康检查最多轮询约 3 分钟；候选启动/健康失败会恢复旧镜像，再检查健康，整个 workflow 仍标记失败。不存在原服务时拒绝首次部署，避免把缺失凭据/数据的空实例当作成功上线。

成功记录：`.release/current-image`、`.release/previous-image`、`.release/compose.image.yml`。不要对运行版本执行不带覆盖文件的普通 `docker compose up`，那会回到基础 compose 的旧 image。人工重启使用：

```bash
cd /home/ubuntu/xiyu-ai
docker compose -f docker-compose.yml -f .release/compose.image.yml up -d --no-build --pull never xiyu-ai
```

## 失败与恢复

- 拉取或预检失败：原服务未替换，修正原因后重新申请运行和审批。
- 候选不健康：查看 workflow 日志，确认 `Previous image restored and healthy`。若回滚也失败，保留持久卷并人工检查，不自动删除数据或容器日志。
- 作业被强制终止/主机掉电：检查 `.release/lock/pid` 对应进程和容器状态后才清理残留锁。不要盲目删除锁后并行发布。
- 每次发布前按项目备份流程保留数据库快照。镜像回滚不撤销数据库 schema/data 迁移。未来不兼容迁移必须单独设计备份恢复与应用兼容窗口。
- 基础 `/api/health` 证明进程和 HTTP 存活，不证明每个模型 Key 有效；发布后仍需在设置页分别运行连接测试，尤其是更换中转服务时。

## 本地验证

```bash
node scripts/deploy_release_check.mjs
node scripts/release_gate_check.mjs
bash -n deploy/release.sh
```

上述检查使用隔离的假 Docker 和 GitHub 响应验证脚本控制流、失败退出与回滚；不代表已在 AWS 完成真实发版。首次真实发布仍需人工批准并观察服务器健康。
