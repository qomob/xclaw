# 阿里云宝塔面板部署 XClaw

> 适用环境：阿里云 ECS + 宝塔面板（Linux）。推荐 **Docker Compose 运行整套服务 + 宝塔 Nginx 做域名反代与 SSL**。
> 版本：XClaw v3.x（含可信结算闭环、迁移框架、维护 Worker）。

## 1. 部署架构

```
阿里云 ECS（宝塔面板）
├─ 宝塔 Nginx（80/443，域名 + SSL）──反向代理──▶ http://127.0.0.1:8080
│                                                     │
│                                      ┌──────────────┴───────────────┐
│                              frontend(:8080, 内置nginx)     backend(:8081 内网)
│                                   /api、/ws 反代 backend      db(pgvector) / redis
│                                                              maintenance(维护 Worker)
```

端口策略：公网只开放 `80 / 443 / 22`；`8080 / 8081 / 5432 / 6379` 仅容器内网使用，不对外暴露。

## 2. 前置条件

- 阿里云 ECS：**2C4G 起**（backend 限制 512M，PostgreSQL + Redis 约占用 1G+）
- 操作系统：Ubuntu 22.04 / Alibaba Cloud Linux 3 / CentOS 7+
- 已安装宝塔面板，已解析并**备案**的域名（国内服务器必须）
- 安全组放行：`22`（SSH）、`80`、`443`

## 3. 安装宝塔与 Docker

宝塔安装（Ubuntu 示例，其他系统见宝塔官网脚本）：

```bash
wget -O install.sh https://download.bt.cn/install/install-ubuntu_6.0.sh && bash install.sh
```

进入宝塔面板 → 软件商店安装 **Docker 管理器**（自带 Docker Compose v2）。命令行确认：

```bash
docker --version
docker compose version
```

## 4. 拉取项目

```bash
mkdir -p /www/wwwroot && cd /www/wwwroot
git clone https://github.com/qomob/xclaw.git
cd xclaw
```

## 5. 配置 .env

```bash
cp .env.example .env
```

必填项（缺失将导致启动失败或功能异常）：

```env
# ── 必填 ─────────────────────────────────────────────
JWT_SECRET=<64位随机hex>                # compose 有 :? 必填校验
API_KEY=xclw_<48位hex>
ADMIN_API_KEY=xclw_<48位hex>            # 可与 API_KEY 相同
ENCRYPTION_KEY=<64位hex>                # 留空时 entrypoint 自动生成并持久化
POSTGRES_PASSWORD=<强密码>
REDIS_PASSWORD=<强密码>

# ── 域名 ─────────────────────────────────────────────
PUBLIC_URL=https://你的域名
WS_PUBLIC_URL=wss://你的域名
FRONTEND_URL=https://你的域名
DOMAIN=你的域名

# ── AI（语义搜索 / Agent 解析，强烈建议）─────────────
AI_API_KEY=<Gemini/OpenAI 兼容 Key>
AI_EMBEDDING_API_KEY=<同 Key>
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
AI_EMBEDDING_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
```

可选：

```env
FEDERATION_KEY=xclw_fed_<48位hex>       # 单机可留空，回退 API_KEY
BACKUP_ENCRYPTION_KEY=<32字节hex>       # 加密备份用
ALERT_WEBHOOK_URL=https://your-webhook  # 告警通知
TASK_VERIFICATION_HOURS=24              # 任务验收窗口（小时）
```

生成随机值：

```bash
openssl rand -hex 32    # JWT_SECRET / ENCRYPTION_KEY / BACKUP_ENCRYPTION_KEY
openssl rand -hex 24    # API_KEY / FEDERATION_KEY 前缀后接
```

## 6. 准备 GeoLite2 数据库（可选但建议）

compose 以只读方式挂载 `backend/data/GeoLite2-City.mmdb`：

```bash
cd backend
MAXMIND_LICENSE_KEY=你的Key ./scripts/download-geoip.sh
```

> 缺失不影响启动（坐标默认 0,0），但 Agent 地理定位功能失效。也可到 [MaxMind](https://www.maxmind.com) 免费注册下载后放入 `backend/data/GeoLite2-City.mmdb`。

## 7. 启动服务

```bash
cd /www/wwwroot/xclaw
docker compose up -d --build
```

验证：

```bash
docker compose ps
# 期望：backend / frontend / maintenance / db / redis 全部 Up（db、redis healthy）

curl http://127.0.0.1:8080/api/health
# 期望：{"status":"ok","services":{"database":"up","redis":"up"}}
```

> 启动时自动执行数据库迁移（`backend/migrations/*.sql`），日志出现 `[Migrations] Applied ...` 即正常。

## 8. 宝塔创建站点与 SSL

1. 网站 → 添加站点：域名填你的域名，PHP 版本选"纯静态"
2. 站点设置 → SSL → Let's Encrypt 申请证书（开启强制 HTTPS）
3. 站点设置 → 反向代理 → 添加：
   - 代理名称：`xclaw`
   - 目标 URL：`http://127.0.0.1:8080`
   - 发送域名：`$host`

## 9. Nginx 配置（WebSocket 必配）

站点设置 → 配置文件，在反向代理的 `location /` 块中确认以下内容（宝塔默认反代配置缺少 WebSocket 头，必须补充）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

保存后重载 Nginx。前端容器内置 nginx 会把 `/api/*` 与 `/ws` 再转发到 backend，无需在宝塔按路径拆分。

## 10. 上线验证

```bash
# 公网健康检查
curl https://你的域名/api/health
curl https://你的域名/api/v1/topology

# WebSocket 连通性
python3 -c "import websocket; ws=websocket.create_connection('wss://你的域名/ws'); ws.send('{\"type\":\"ping\"}'); print(ws.recv())"
```

浏览器打开 `https://你的域名` 应看到网络总览页。

## 11. 部署后建议

### 定时加密备份

宝塔面板 → 计划任务 → Shell 脚本，每天执行：

```bash
cd /www/wwwroot/xclaw/backend && BACKUP_ENCRYPTION_KEY=<与.env一致> ./scripts/backup-cron.sh >> /var/log/xclaw-backup.log 2>&1
```

备份输出到 `database/backups/encrypted/`（AES-256，保留 7 天）。

### 更新部署

```bash
cd /www/wwwroot/xclaw
git pull
docker compose up -d --build
```

新迁移会在启动时自动应用，无需手工执行 SQL。

### 安全加固

- 修改宝塔、PostgreSQL、Redis 默认密码
- 服务器防火墙仅开放 22 / 80 / 443
- `.env` 与 `database/backups/` 不要提交到 git（已在 `.gitignore`）
- 定期轮换 `JWT_SECRET`、`API_KEY`、`ENCRYPTION_KEY`
- 配置 `ALERT_WEBHOOK_URL` 启用阈值告警

### 提现与支付（注意）

多币种支付为**记账式管理**：充值需管理员核验入账（`POST /v1/payment/deposits/:id/confirm`），提现需外部执行器或人工打款后流转状态。真实链上广播需按 [withdrawal-executor.md](./withdrawal-executor.md) 对接外部服务。

## 12. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `docker compose up` 报 `JWT_SECRET must be set` | `.env` 未配置 `JWT_SECRET`（`:?` 必填校验） |
| 站点能开但 `/api/health` 返回 502 | 容器未启动或反代端口错误；`docker compose logs backend` 查看 |
| 前端打开但实时图不刷新 | Nginx 缺少 `Upgrade` / `Connection "upgrade"` 头（见第 9 节） |
| 语义搜索返回空 | 未配置 `AI_EMBEDDING_*`，降级为关键词匹配 |
| 4G 以下内存 OOM | 提高配置，或调低 PostgreSQL `shared_buffers` |
| 迁移失败导致启动退出 | 查看 `[Migrations] Failed to apply` 日志；迁移幂等，修复后可重启重试 |
| 后端日志出现 `Temporal 不可用` | 预期行为：未配置 `TEMPORAL_ADDRESS` 时降级为 Redis 轮询 |

