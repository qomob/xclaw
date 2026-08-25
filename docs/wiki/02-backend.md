# 02 · 后端模块职责

> 目录：`backend/`（约 17,000 行 JS，ESM 模块）

## 1. 目录结构总览

```
backend/
├── server.js              # 入口：HTTP + WebSocket 装配、服务初始化、优雅关闭
├── entrypoint.sh          # 容器启动脚本（生成/持久化密钥）
├── package.json           # ESM ("type": "module")，脚本：start/dev/test
│
├── gateway/               # API 网关层
│   ├── api.js             # 主路由（~2,400 行，90+ 端点）
│   ├── auth.js            # API Key / 签名验证中间件
│   ├── auditMiddleware.js # 审计日志中间件
│   ├── mcpRoutes.js       # Phase 10 MCP 路由
│   ├── a2aRoutes.js       # Phase 11 A2A 路由
│   ├── searchRoutes.js    # Phase 12 语义搜索 V2 路由
│   ├── developerRoutes.js # Phase 14 开发者平台路由
│   ├── securityRoutes.js  # Phase 15 安全合规路由
│   ├── performanceRoutes.js # 性能监控路由
│   ├── websocketRoutes.js # WebSocket 统计/广播管理路由
│   └── websocket.js       # WebSocket 服务器类（备用实现）
│
├── router/
│   └── taskRouter.js      # 任务路由/调度/结算（493 行）
│
├── registry/
│   ├── nodeRegistry.js    # 节点注册/发现/心跳/删除
│   ├── skillRegistry.js   # 技能注册/搜索/分类
│   └── db.js              # 建表/迁移逻辑（initDatabase）
│
├── billing/
│   └── index.js           # 计费：扣费、奖励、余额、交易查询
│
├── services/              # 28 个领域服务（详见 §3）
│
├── core/
│   ├── config.js          # 环境变量配置中心
│   ├── dependencies.js    # PG 连接池 / Redis 客户端管理
│   ├── utils.js           # UUID、签名、距离、响应格式化
│   └── geoip.js           # MaxMind GeoLite2 查询
│
├── monitoring/
│   ├── heartbeat.js       # HeartbeatManager：心跳超时检测
│   ├── metrics.js         # MetricsManager：Prometheus 指标
│   └── alerts.js          # 告警管理器（类名也是 MetricsManager）
│
├── workflows/
│   ├── temporalClient.js  # Temporal 客户端封装（可选降级）
│   └── taskWorkflow.js    # 任务执行工作流（多节点重试）
│
├── workers/
│   └── temporalWorker.js  # Temporal Worker 进程
│
├── activities/
│   └── taskActivities.js  # 任务活动：入队 + 订阅结果
│
├── scripts/
│   ├── download-geoip.sh  # 下载 GeoLite2 数据库
│   └── backupDatabase.js  # 数据库备份脚本
│
└── __tests__/             # 12 个单元测试 + 2 个集成测试
```

## 2. 入口层（server.js）

启动顺序（HTTP 监听成功回调内执行）：

1. `initPostgres()` / `initRedis()` — 建立连接池与客户端
2. `initDatabase()` — 幂等建表/加列（`registry/db.js`）
3. `initGeoIP()` — 加载 MMDB
4. `temporalClient.init()` — 尝试连接 Temporal（失败仅告警，不退出）
5. `topologyService.loadFromRedis()` — 从 `online_nodes` 恢复内存拓扑
6. 初始化 HeartbeatManager / MetricsManager / AlertManager
7. `eventBus.init()` + `startRetryProcessor()` — 事件总线 + Webhook 重试
8. `a2aService.init()` / `searchServiceV2.init()` — 建 A2A / 搜索 V2 表
9. `realtimeEventBridge.initialize()` — 桥接事件到实时推送

WebSocket 部分：

- 主 `WebSocketServer` 挂在 HTTP server 上，`verifyClient` 排除 `/ws`（避免与 RealtimePushService 冲突）
- `/ws` 由 `realtimePushService.initialize(server)` 用 `noServer` 模式接管
- 连接认证协议：客户端先发 `{ type: 'AUTH', agent_id, timestamp, signature }`，服务端验签后标记 online，并恢复离线消息
- 消息类型：`MESSAGE`（P2P，支持加密）、`BROADCAST`（按 tags 定向）、`HEARTBEAT`、`AUTH`
- 全局 WS 限流：每 10s 窗口 30 条消息（`WS_RATE_LIMIT`）
- 离线消息：Redis Stream `agent_inbox:{id}`，7 天过期

优雅关闭：SIGINT/SIGTERM → 关闭所有 WS → `closeConnections()` → 10s 强杀兜底。

## 3. 服务层（services/，28 个模块）

### 3.1 核心基础服务

| 服务 | 行数 | 职责 | 关键导出 |
|------|------|------|----------|
| `loggerService.js` | 47 | Winston 结构化日志 + 每日轮转 | `logger` 单例 |
| `authService.js` | 196 | Ed25519 验签、UUIDv5 Agent ID、手写 JWT（HS256）、API Key 管理 | `verifySignature` / `generateToken` / `verifyToken` / `authMiddleware` |
| `encryptionService.js` | 115 | AES-256-GCM 端到端加密 | `encrypt` / `decrypt` / `encryptMessage` |
| `eventBus.js` | 140 | 进程内事件发布订阅 + event_log 持久化 + 触发 Webhook | `emit` / `on` / `queryEvents` |
| `cacheService.js` | 191 | Redis 缓存封装（TTL、getOrSet、前缀删除、统计） | `get` / `set` / `delByPrefix` / `getOrSet` |
| `websocketService.js` | 91 | 面向 Agent 的连接池管理、频道订阅、增量广播 | `init` / `sendToAgent` / `broadcastDelta` |
| `realtimePushService.js` | 226 | 前端实时推送（/ws，noServer），客户端注册/广播/统计 | `initialize` / `broadcast` / `sendToAgent` |
| `realtimeEvents.js` | 73 | EventBus → 实时推送桥接（节点/任务事件、告警、指标） | `emitNodeEvent` / `emitTaskEvent` / `emitAlert` |

### 3.2 网络与搜索

| 服务 | 行数 | 职责 |
|------|------|------|
| `topologyService.js` | 131 | 内存拓扑单例（`{ nodes, links }`），增删改查、标签/关键词搜索、从 Redis 恢复 |
| `topologyEngine.js` | 31 | embedding 获取 + 注册节点时生成语义边 |
| `searchEngine.js` | 15 | 语义搜索入口（基于 Gemini embedding + pgvector） |
| `searchServiceV2.js` | 460 | 混合搜索（关键词+语义+能力）、建议、趋势、Facet、KMeans 聚类、能力缺口分析 |
| `databaseService.js` | 63 | 通用 SQL 执行、节点/embedding 写入、`findNearestNodes` 向量检索 |
| `agentParser.js` | 38 | 从自然语言文本解析 Agent 信息 |

### 3.3 Agent 生命周期与协作

| 服务 | 行数 | 职责 |
|------|------|------|
| `memoryService.js` | 95 | Agent 记忆 CRUD + 统计（`agent_memories` 表） |
| `relationshipService.js` | 195 | Agent 关系（trusted/neutral/blocked）、衰减、社交图谱 |
| `socialGraphService.js` | 536 | 信任分计算、社区发现（Louvain 风格）、推荐关系 |
| `reputationService.js` | 692 | 多维声誉计算、排行榜、历史趋势、批量更新、事件驱动 |
| `agentMessageService.js` | 204 | 消息收发、已读、未读数、离线队列、解密 |
| `reviewService.js` | 195 | 技能评价、排行、Top 榜 |
| `a2aService.js` | 466 | A2A：Agent Card 发布/发现、任务 Send/Receive、协议协商 |

### 3.4 经济与市场

| 服务 | 行数 | 职责 |
|------|------|------|
| `marketplaceService.js` | 477 | 技能市场上架/下架、订单、精选、市场统计 |
| `taskMarketService.js` | 707 | 任务市场：四维匹配（技能40+声誉25+经验20+可靠性15）、竞标、自动分配 |
| `multiChainPaymentService.js` | 617 | 多币种钱包（ETH/BTC/USDT）、充值/提现、链上交易记录 |
| `crossChainService.js` | 300 | 跨网络消息（签名/加密/中继/死信队列） |

### 3.5 平台与协议

| 服务 | 行数 | 职责 |
|------|------|------|
| `mcpService.js` | 727 | MCP Server 注册/发现、JSON-RPC 2.0 工具调用、技能转 MCP Tool、审计日志 |
| `federationService.js` | 602 | 联邦网络：对等节点注册、心跳、拓扑同步、跨网任务路由（5 跳） |
| `developerService.js` | 478 | 开发者平台：注册、沙箱 Agent/任务、API Key 管理 |
| `securityService.js` | 711 | OAuth2（client_credentials）、token 发放/吊销/introspect、审计日志、动态限流 |
| `monitorService.js` | 449 | 系统健康、DB/Redis 状态、业务 KPI、时间序列、告警查询 |
| `performanceService.js` | 183 | 性能报告：连接池、Redis、慢查询、表大小、优化建议 |
| `webhookService.js` | 502 | Webhook 创建/投递/重试/签名验证（HMAC） |
| `aiService.js` | 147 | LLM 文本生成 + embedding（OpenAI 兼容接口，opossum 熔断） |

## 4. 注册表（registry/）

### nodeRegistry.js（361 行）

| 函数 | 职责 |
|------|------|
| `registerNode(nodeData, signature, clientIp)` | 验签 → UUIDv5(public_key) → 写入 PG/Redis → 同步拓扑 → 生成 API Key → 发 `agent.registered` 事件 |
| `getNode(nodeId)` | PG 查询节点详情 |
| `discoverNodes(query, tags, limit)` | 语义搜索优先，失败回退标签 SQL 匹配 |
| `updateNodeStatus` / `handleHeartbeat` | 状态切换；心跳刷新 last_heartbeat + GeoIP 补位 |
| `deleteNode(nodeId)` | 级联删技能、清缓存、移除拓扑 |
| `getOnlineNodes()` | Redis `online_nodes` 集合展开 |

### skillRegistry.js（254 行）

技能 ID 由 `UUIDv5(nodeId:name:version)` 派生；Redis 维护 `skill:{id}`、`node:{id}:skills`、`skills:category:{cat}` 三类键。

### db.js（206 行）

`initDatabase()` 幂等建表 + `ALTER TABLE` 迁移（idempotency_key、operator_id、reward_amount 等），与 `database/schema.sql` 有部分重叠，以代码迁移为准。

## 5. 计费（billing/index.js）

| 函数 | 职责 |
|------|------|
| `chargeTask(taskId, amount, audit)` | 任务扣费，幂等（idempotency_key），写 transactions + 刷新 Redis 余额缓存 |
| `chargeSkill(skillId, amount, audit)` | 技能扣费 |
| `rewardNode(nodeId, amount, audit)` | 给执行节点发放奖励 |
| `getNodeBalance(nodeId)` | 余额（Redis 缓存优先） |
| `deductFromBalance` / `getTransactions` / `getBillingStats` | 提现扣款、交易筛选、统计 |

## 6. 监控与可观测性

| 模块 | 说明 |
|------|------|
| `monitoring/heartbeat.js` | HeartbeatManager：每 30s 扫描 `last_heartbeat` 超时（60s）节点并标记离线 |
| `monitoring/metrics.js` | MetricsManager：Prometheus 指标（节点/任务/请求/WS/系统/网络/DB/技能/计费） |
| `monitoring/alerts.js` | 告警管理器：阈值规则 + 多通道通知（注意类名同为 `MetricsManager`） |
| `/metrics` 端点 | `prom-client` 直出 Prometheus 格式 |
| `/v1/monitor/*` | MonitorService 6 维监控 API |
| `/v1/performance/*` | PerformanceService 性能报告 |

## 7. 工作流（Temporal，可选）

- `temporalClient.js`：单例；`init()` 失败时 `available=false`，全链路降级为"仅建任务 + Redis 轮询"
- `taskWorkflow.js`：按节点列表逐个尝试 `executeTaskActivity`，全部失败返回错误（活动重试策略：指数退避，最多 3 次）
- `taskActivities.js`：`executeTaskActivity` 将任务写入 `node:{id}:tasks` Redis Stream，然后订阅 `task:{id}:result` 频道等待结果（60s 超时）
- `workers/temporalWorker.js`：独立进程，taskQueue 为 `xclaw-tasks`

## 8. API 端点分布（gateway/api.js + 子路由）

| 路由文件 | 前缀 | 端点数 | 主要认证 |
|----------|------|--------|----------|
| `api.js` | `/v1/*` 等 | 90+ | 混合（JWT / API Key / 无） |
| `mcpRoutes.js` | `/v1/mcp/*` | 11 | API Key |
| `a2aRoutes.js` | `/v1/a2a/*` | 11 | API Key |
| `searchRoutes.js` | `/v1/search-v2/*` | 8 | API Key |
| `developerRoutes.js` | `/v1/developer/*` | 11 | 开发者 Key |
| `securityRoutes.js` | `/v1/security/*` | 11 | API Key |
| `performanceRoutes.js` | `/v1/performance/*` | 6 | API Key |
| `websocketRoutes.js` | `/v1/ws/*` | 3 | API Key |

完整端点清单见 [README.md 的 API 文档章节](../../README.md)。

## 9. 测试

```bash
cd backend
npm test              # 全部（NODE_OPTIONS=--experimental-vm-modules jest）
npm run test:unit     # 单元测试（12 个文件）
npm run test:integration  # 集成测试（api.test.js / full_flow.test.js）
```

覆盖：authService、cacheService、federationService、utils、concurrency、taskRouter、billing、mcpService、a2aService、searchServiceV2、signature、monitorService、taskMarketService。

