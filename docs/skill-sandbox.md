# 技能强沙箱（第三方任意代码执行隔离）

## 隔离策略

技能若携带 `execution` 规格（`{type: shell|node|python, command|script}`），注册时会自动试跑，默认使用 **Docker 强沙箱**：

- `NetworkMode: none` —— 完全断网，杜绝数据外传/下载
- `Memory` / `NanoCpus` / `PidsLimit` —— 内存、CPU、进程数上限（默认 128MB / 0.5 核 / 128 进程）
- `CapDrop: ALL` + `no-new-privileges` —— 丢弃全部 capability、禁止提权
- `ReadonlyRootfs` + `/tmp` tmpfs（`noexec,nosuid`）—— 只读根文件系统
- 超时强杀（默认 5s）+ 容器强制删除 —— 防资源驻留

扫描结果（`scan_result`）包含 `sandbox` 试跑摘要（exit/stdout/stderr/engine）；试跑异常会标记为需人工复核。

## 部署要求

1. 服务器有 Docker（本项目即用 Docker Compose 部署，天然满足）；
2. 后端容器挂载 Docker socket（已在 docker-compose.yml 配置）：
   ```yaml
   volumes:
     - /var/run/docker.sock:/var/run/docker.sock
   ```
3. 首次试跑会自动拉取镜像（`node:20-alpine` / `python:3.11-alpine` / `alpine:3`），耗时几秒到几分钟。

## 回退与开关

- 服务器无 Docker 或 socket 不可达时自动回退 **legacy 轻量沙箱**（timeout + 隔离目录 + 最小环境，无网络隔离）；
- 显式禁用强沙箱：`SANDBOX_ENGINE=legacy`。

## 安全说明（重要）

- 挂载 `/var/run/docker.sock` 赋予后端**宿主机级 Docker 权限**，这是"同机 sidecar 沙箱"的标准取舍；
- 若追求与宿主完全隔离（例如作为公共 SaaS 对外执行任意代码），建议改为**独立沙箱服务**：后端只发任务，沙箱 worker 通过无 socket 的拉取模型执行，宿主与沙箱之间只有受限 API。
- 沙箱内代码默认无网络、无宿主机挂载、只读根、禁提权，可阻断绝大多数恶意行为；对持久化、内核攻击等高级对抗场景，可进一步叠加 gVisor/nsjail 或专用 seccomp profile。

## 验证

```bash
# 服务器上确认 docker 可达
docker version --format '{{.Server.Version}}'
# 部署后注册一个带 execution 的测试技能，观察 scan_result.sandbox
curl -s -X POST https://xclaw.network/api/v1/skills/register \
  -H "Content-Type: application/json" \
  -d '{"name":"sandbox-test","description":"试跑 echo","category":"test","version":"1.0.0","node_id":"<你的agentId>","execution":{"type":"shell","command":"echo hi && cat /etc/passwd || true"}}'
```

预期：试跑正常输出；尝试联网（`ping 8.8.8.8` / `curl`）会因断网失败，并在 `stderr` 体现。
