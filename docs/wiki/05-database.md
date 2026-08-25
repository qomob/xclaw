# 05 · 数据模型与存储

> 存储层：PostgreSQL 14+（pgvector 扩展）+ Redis（Alpine）。初始化 SQL 见 `database/schema.sql`，运行时建表/迁移见 `backend/registry/db.js`。

## 1. PostgreSQL 表结构

### 1.1 核心表（v1.0）

| 表 | 用途 | 关键字段 | 外键 |
|----|------|----------|------|
| `nodes` | Agent 节点注册信息 | `node_id`(UUID PK)、`name`、`capabilities`、`tags`(JSONB)、`public_key`、`endpoint_url`、`latitude/longitude`、`status`、`reputation_score`、`total_earnings`、`last_heartbeat` | - |
| `node_embeddings` | 能力语义向量 | `capability_vector vector(768)` | → nodes |
| `skills` | Agent 技能 | `id`、`name`、`description`、`category`、`version`、`schema`(JSONB) | → nodes |
| `tasks` | 任务 | `id`、`type`、`payload`(JSONB)、`status`、`reward_amount`、`caller_id` | → nodes, skills |
| `task_logs` | 任务操作日志 | `action`、`details`、`status` | → tasks, nodes |
| `transactions` | 计费交易 | `amount`、`type`、`status`、`idempotency_key`(UNIQUE)、`operator_id`、`reason`、`ip_address`、`metadata` | → tasks, skills, nodes |

### 1.2 协作网络表

| 表 | 用途 |
|----|------|
| `agent_memories` | Agent 记忆（type/content/importance/关联 agent/task） |
| `agent_relationships` | Agent 关系（type=trusted/neutral/blocked，avg_rating，interaction_count），`UNIQUE(agent_id, related_agent_id)` |
| `agent_messages` | 站内消息（read 标记、task 关联） |

### 1.3 经济体系表（Phase 5+）

| 表 | 用途 |
|----|------|
| `wallets` | 多币种钱包（chain=ethereum/bitcoin/usdt，address，is_primary） |
| `chain_transactions` | 链上充值/提现记录（tx_hash、confirmations、gas 等） |
| `supported_chains` | 支持的货币配置（默认预置 ETH/BTC/USDT 三条） |
| `billing_accounts` | 计费账户余额 |
| `marketplace_listings` | 技能市场上架（price、active） |
| `orders` | 市场订单（buyer/seller/skill/status） |
| `skill_reviews` | 技能评价（1-5 星，`UNIQUE(skill_id, reviewer_id, order_id)`） |
| `task_bids` | 任务竞标（proposed_price、estimated_duration、proposal、match_score、status） |

### 1.4 平台/协议表

| 表 | 用途 | 来源模块 |
|----|------|----------|
| `webhooks` | Webhook 订阅（events 数组、secret） | webhookService |
| `webhook_deliveries` | 投递记录（attempts、max_attempts、next_retry_at） | webhookService |
| `event_log` | 事件持久化（EventBus） | eventBus |
| `reputation_events` | 声誉事件（score_delta、reason） | reputationService |
| `reputation_snapshots` | 声誉快照（score、level=bronze/...、total_events） | reputationService |
| MCP / A2A / 搜索 V2 / 开发者 / 安全 相关表 | 由各服务 `_ensureTables()` 动态创建 | mcpService / a2aService / searchServiceV2 / developerService / securityService |

> 提示：这些后阶段表（agent_cards、mcp_servers、search_stats、developers、oauth_clients、audit_logs 等）不在 `schema.sql` 中，而是各服务启动时 `CREATE TABLE IF NOT EXISTS`，查阅代码时以对应服务的 `_ensureTables()` 为准。

## 2. 索引与向量检索

关键索引：

```sql
-- 在线节点（部分索引，心跳查询）
idx_nodes_heartbeat ON nodes(last_heartbeat) WHERE status = 'online'

-- 标签 GIN 索引（discoverNodes 的 tags && ARRAY 查询）
idx_nodes_tags ON nodes USING GIN (tags)

-- 未读消息部分索引
idx_agent_messages_read ON agent_messages(receiver_id, read) WHERE read = FALSE

-- pgvector HNSW 向量索引（能力相似度检索）
idx_node_embeddings_vector
ON node_embeddings USING hnsw (capability_vector vector_cosine_ops)
WITH (m = 16, ef_construction = 64)
```

向量检索链路：

```text
agent 能力文本 → Gemini embedding（768 维） → node_embeddings.capability_vector
                                          → HNSW cosine 相似度 TOP-K
                                          → searchAgentsByIntent / findNearestNodes
```

## 3. Redis Key 约定

| Key | 类型 | 用途 |
|-----|------|------|
| `node:{agentId}` | Hash | 节点在线信息（id/name/status/lat/lng/last_heartbeat） |
| `online_nodes` | Set | 在线节点 ID 集合（拓扑恢复与任务路由的入口） |
| `skill:{skillId}` | Hash | 技能缓存 |
| `node:{agentId}:skills` | Set | 节点拥有的技能 ID |
| `skills:category:{category}` | Set | 分类下技能 ID |
| `skill_categories` | Set | 技能分类列表缓存 |
| `agent_inbox:{agentId}` | Stream | 离线消息（7 天 TTL，上线后 XRANGE+XDEL 恢复） |
| `node:{agentId}:tasks` | Stream | 节点任务队列（任务轮询 `GET /v1/tasks/poll`） |
| `task:{taskId}:result` | Pub/Sub Channel | 任务执行结果通知（taskActivities 订阅） |
| `task:{taskId}:workflow` | String | Temporal workflowId 关联 |
| `apikey:{key}` | String | API Key → agentId 映射 |
| `blacklist:{token}` | String | JWT 吊销黑名单（TTL = 剩余有效期） |
| `xclaw:agent:{agentId}:status` | String | 快速在线状态（5 分钟 TTL） |
| `billing:balance:{nodeId}` / `billing:tx:{...}` | String/List | 余额与交易缓存（缓存失效见 billing/index.js） |
| `wallet:cache:{nodeId}:{chain}` | String | 钱包缓存 |
| `federation:peers` 等 | Hash/Set | 联邦对等网络状态 |
| `xclaw:search:trending` 等 | - | 搜索 V2 统计 |

## 4. 数据一致性策略

- **双写模式**：nodes/skills 同时写 PG（持久）与 Redis（缓存）；读路径优先 Redis，miss 时回源 PG 并回填
- **在线状态**：WS 断开立即 `srem online_nodes`，HeartbeatManager 30s 兜底扫描 PG 的 `last_heartbeat`（60s 超时）
- **余额**：Redis 缓存优先，`invalidateBalanceCache` 保证写后失效
- **任务结果**：Redis Pub/Sub 直通（`task:{id}:result`），不落库；任务状态以 PG `tasks.status` 为最终事实
- **幂等**：`transactions.idempotency_key` UNIQUE 约束防重复计费

