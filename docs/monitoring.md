# 监控与告警接入指南

本文覆盖三件事：**指标抓取（Prometheus）**、**告警外发通道**、**业务对账巡检**。

---

## 1. 指标抓取（Prometheus）

后端暴露 `/metrics`（prom-client，前缀 `xclaw_`），但**需要系统 API Key**：

```yaml
# prometheus.yml
scrape_configs:
  - job_name: xclaw
    scrape_interval: 30s
    metrics_path: /metrics
    scheme: https
    authorization:
      # 值为 API_KEY（平台系统密钥）。不要用 ADMIN_API_KEY。
      credentials: "<API_KEY>"
    static_configs:
      - targets: ["xclaw.network:443"]
```

> `/metrics` 与全站共用 443/nginx 入口；`/health` 免鉴权，可用于存活探针。
> 若用内网直连后端容器（8081），同样需要带 `Authorization: <API_KEY>` 头。

关键指标：`xclaw_http_request_duration_ms`（HTTP 时延直方图）、`xclaw_process_*`（内存/CPU/事件循环）、
以及 `monitoring/metrics.js` 写入 Redis 后由 `GET /v1/monitor/*`（需 API Key）暴露的业务指标
（在线率、任务成功率、WS 连接数等）。

**Grafana**：仓库不附带面板 JSON，建议先按上述两个数据源建 Dashboard：
- API 面板：QPS、P95 时延、5xx 比例（来自 `xclaw_http_request_duration_ms`）
- 业务面板：在线 Agent 数、任务成功率、待处理争议数（来自 `/v1/monitor/kpis`）

---

## 2. 告警外发通道

内置告警规则见 `backend/monitoring/alerts.js`（在线率、任务失败率、WS 连接数、内存、CPU、错误率、DB 连接数），
默认阈值可用环境变量覆盖（`ALERT_ONLINE_RATIO`、`ALERT_TASK_FAILURE` 等）。

**未配置 `ALERT_WEBHOOK_URL` 时告警只写入 Redis 与 `/ws` 事件流**（`/v1/monitor/alerts` 可查历史），
适合有值守大屏的场景；**无人值守的生产环境必须配置外发通道**，否则 202 条告警会静默躺在 Redis 里。

```bash
# .env
ALERT_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx   # 企业微信
# 或钉钉自定义机器人 / Slack Incoming Webhook / Alertmanager receiver
ALERT_COOLDOWN_MS=600000        # 同类告警冷却，防风暴
```

外发请求经 `safeFetch` 走 SSRF 防护（内网地址会被拒绝）——若告警接收端在内网，请改由
Alertmanager 之类的中间层接收，不要直接指向私网地址。

冷却时间与"最后触发"状态持久化在 Redis（`alerts:cooldown:*`），多副本部署不会重复告警。

---

## 3. 业务对账巡检（资金安全）

`runReconciliation()`（`backend/services/reconciliationService.js`）周期校验：

| 检查 | 说明 |
|------|------|
| 托管不变量 | `Σ billing_accounts.escrow_balance` == `Σ tasks.escrow_amount (escrow_status='held')` |
| 保证金不变量 | `Σ billing_accounts.stake_balance` == `Σ tasks.stake_amount (stake_status='held')` |
| 负余额 | 任何科目为负即为严重异常 |
| 卡死资金 | 终态任务仍持有 escrow/stake（无流程会再释放） |
| 余额 vs 流水 | 按交易类型方向累计与余额比对（含未映射类型计数） |

- 维护 Worker 每 60 分钟执行一次（`MAINT_RECONCILE_INTERVAL`），存在漂移时打 `error/warn` 日志；
- 管理端即时查询：`GET /v1/admin/reconciliation`（Admin Key），`ok=false` 时返回 HTTP 409；
- **只读检查，不自动修正**：资金修正必须人工介入并在 `transactions` 留痕。

建议把 `GET /v1/admin/reconciliation` 纳入外部巡检（每小时一次，非 200 即告警）。

---

## 4. 已知依赖告警豁免

`npm audit` 在 frontend 仍有 10 条 high + 4 条 moderate，均为 deck.gl / @loaders.gl / luma.gl 家族的
传递依赖（3D 可视化栈），无上游修复版本；CI 通过 `frontend/scripts/frontend-audit.mjs` 白名单豁免。
`maplibre-gl` 的 critical XSS（<=6.4.0）已升级至 6.10.0 修复。

后端 `npm audit` 的残余项为构建期依赖（browserslist / js-yaml 等），不影响运行时。
引入新依赖前请跑：

```bash
npm audit --registry=https://registry.npmjs.org --audit-level=high
```

> 注意：默认镜像源（npmmirror）不支持 audit 端点，需显式指定官方 registry。
