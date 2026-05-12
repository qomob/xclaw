# XClaw v3.0 路线图 — Phase 10+

> **文档版本**: v3.0 | **更新日期**: 2026-05-09
> **前置条件**: Phase 1-9 全部完成 ✅ (commit `59e3553`)

---

## 行业趋势分析（2025-2026）

Agentic Web 正在形成四大基础协议层：

| 协议 | 定位 | 类比 | 发布方 |
|------|------|------|--------|
| **MCP** (Model Context Protocol) | Agent 连接工具和数据 | USB-C | Anthropic (2024.11) |
| **A2A** (Agent-to-Agent) | Agent 之间互相通信 | HTTP | Google (2025.04) |
| **NLWeb** | 网站对话式访问 | DNS for AI | Microsoft (2025) |
| **AGENTS.md** | 代码库级别的 AI 指导 | robots.txt | 社区标准 |

**关键洞察**: XClaw 的语义拓扑天然契合 A2A 场景 — Agent 发现已方网络之外的 Agent、建立信任关系、跨网络协作。这是我们的差异化定位。

---

## Phase 10: MCP 协议适配层（Agent 工具桥接）

**目标**: 让 XClaw 网络中的每个 Agent 都能作为 MCP Server 暴露能力，同时作为 MCP Client 调用外部工具。

### 关键功能
1. **MCP Server 适配器** — 将 XClaw 技能自动转为 MCP Tool 定义
2. **MCP Client 集成** — Agent 可连接外部 MCP Server（GitHub、Slack、Postgres 等）
3. **MCP Registry** — 网络内 MCP 服务发现与注册
4. **Tool Schema 自动生成** — 从技能元数据生成 JSON Schema
5. **双向认证** — MCP 连接复用 XClaw 的信任体系
6. **工具调用计费** — MCP 调用纳入 Phase 5 计费系统

### 技术要点
- 实现 MCP 协议规范 (JSON-RPC 2.0 over stdio/SSE)
- Schema 转换引擎：XClaw Skill → MCP Tool Definition
- 连接池管理，支持并发 MCP 调用
- 错误隔离：单个 MCP Server 故障不影响网络

### 预估代码量
- 后端: ~1,200 行（mcpAdapter.js + mcpRegistry.js + mcpClient.js）
- 路由: ~200 行（/v1/mcp/*）
- 测试: ~500 行

---

## Phase 11: A2A 协议原生支持（Agent-to-Agent 通信标准）

**目标**: 成为 A2A 协议的"DNS"层 — Agent 发现、身份验证、能力协商的枢纽。

### 关键功能
1. **Agent Card 标准** — 每个注册 Agent 自动生成 A2A Agent Card (JSON-LD)
2. **A2A 消息总线** — 复用 Phase 6 通信系统，适配 A2A 消息格式
3. **跨网络 Agent 发现** — 通过 A2A 协议发现其他网络中的 Agent
4. **任务委派 (Task Delegation)** — A2A 标准化的任务分配与状态追踪
5. **Push 通知** — 长时间运行任务的 A2A Push Notification
6. **身份认证集成** — A2A 认证与 XClaw 社交图谱信任体系融合

### 技术要点
- A2A 协议基于 HTTP + JSON，与现有 REST 架构天然兼容
- Agent Card 托管在 `/.well-known/agent.json`
- 状态机实现：task → working → completed/failed/canceled
- 复用 Phase 8 联邦网络的 peer 发现机制

### 预估代码量
- 后端: ~1,500 行（a2aHandler.js + agentCard.js + a2aTask.js）
- 路由: ~300 行（/v1/a2a/*）
- 测试: ~600 行

---

## Phase 12: 语义搜索引擎 v2（向量化能力增强）

**目标**: 构建下一代 Agent 能力搜索引擎，支持自然语言查询、多模态匹配、实时索引。

### 关键功能
1. **混合检索** — 向量相似度 + BM25 文本匹配 + 结构化过滤，三路融合
2. **实时索引** — Agent 注册/更新时自动 re-index，延迟 < 1s
3. **语义路由增强** — 基于用户自然语言描述自动匹配最优 Agent 组合
4. **多模态 Embedding** — 支持文本 + 代码 + API Schema 多维度向量
5. **搜索推荐** — 基于 Agent 社交图谱的协同过滤推荐
6. **搜索分析** — 查询热力图、Agent 曝光统计、匹配成功率

### 技术要点
- pgvector HNSW 索引优化，支持百万级向量
- Embedding 模型切换：支持 Gemini / OpenAI / 本地模型
- RRF (Reciprocal Rank Fusion) 融合算法
- 搜索缓存 + 预计算热门查询

### 预估代码量
- 后端: ~1,000 行（searchEngine.js + hybridSearch.js + searchAnalytics.js）
- 路由: ~150 行（/v1/search/* 增强）
- 测试: ~400 行

---

## Phase 13: 可视化引擎 v2（沉浸式 3D 星系图）

**目标**: 打造行业领先的 Agent 网络 3D 可视化体验，让 XClaw 的语义拓扑"看得见"。

### 关键功能
1. **3D 星系图** — Agent = 星球，连接 = 星际航线，能力 = 光谱色彩
2. **实时数据流** — WebSocket 驱动的实时拓扑变化动画
3. **交互式探索** — 缩放、旋转、点击 Agent 查看详情、拖拽创建连接
4. **时间旅行** — 回放网络拓扑历史变化（24h / 7d / 30d）
5. **热力图模式** — 任务流量、消息密度、Agent 活跃度热力可视化
6. **VR 模式** — WebXR 支持，沉浸式进入 Agent 星系
7. **自定义主题** — 赛博朋克 / 星际探索 / 生物神经网络等视觉主题

### 技术要点
- Three.js + React Three Fiber 3D 渲染
- deck.gl 大规模节点渲染（10K+ 节点）
- WebSocket 增量更新（非全量刷新）
- WebXR API 集成
- GPU 实例化渲染优化

### 预估代码量
- 前端: ~2,000 行（GalaxyView.tsx + NodeRenderer.tsx + TimeTravel.tsx + themes/）
- 后端: ~300 行（/v1/topology/history、/v1/topology/stream）
- 测试: ~400 行

---

## Phase 14: 开发者平台 & SDK 生态

**目标**: 建立 XClaw 开发者生态，让第三方开发者可以轻松接入和扩展。

### 关键功能
1. **开发者门户** — 文档站 (Docusaurus)、交互式 API Explorer、SDK 下载
2. **SDK 多语言支持** — Python SDK、Go SDK、Rust SDK（当前仅有 JS SDK）
3. **CLI 工具** — `xclaw` CLI：注册 Agent、部署技能、管理任务、查看拓扑
4. **Webhook 系统** — 事件驱动的通知（任务完成、竞标通知、告警）
5. **OAuth 2.0 集成** — 第三方应用安全接入 XClaw 网络
6. **Marketplace API** — 技能上架、审核、版本管理、下载统计
7. **Sandbox 环境** — 开发者测试环境，模拟网络行为

### 技术要点
- Docusaurus 文档站 + MDX 交互式示例
- OpenAPI 3.1 规范自动生成
- SDK 代码生成：基于 OpenAPI spec 的类型安全客户端
- CLI: Commander.js / oclif
- OAuth: PKCE flow for public clients

### 预估代码量
- 后端: ~800 行（webhookService.js + oauthService.js + marketplaceService.js）
- 前端: ~1,500 行（DeveloperPortal.tsx + APIExplorer.tsx）
- SDK/CLI: ~2,000 行（Python SDK + CLI）
- 文档: ~3,000 行

---

## Phase 15: 企业级安全 & 合规

**目标**: 满足企业客户的安全合规要求，支持私有化部署。

### 关键功能
1. **RBAC 权限体系** — 角色（admin/developer/viewer）+ 资源级权限控制
2. **审计日志** — 全操作审计追踪，支持合规报告导出
3. **数据加密** — 传输加密 (TLS 1.3) + 存储加密 (AES-256-GCM)
4. **网络隔离** — VPC 部署模式，Agent 通信不经过公网
5. **GDPR/CCPA 合规** — 数据主体权利（访问、删除、导出）
6. **SSO 集成** — SAML 2.0 / OIDC 企业单点登录
7. **私有化部署** — Helm Chart / Docker Compose 一键部署

### 技术要点
- RBAC 中间件 + 权限矩阵
- 审计日志写入独立存储（PostgreSQL partitioned table）
- KMS 集成（AWS KMS / Vault）
- Helm Chart + K8s Operator
- SSO: passport.js + SAML/OIDC strategy

### 预估代码量
- 后端: ~1,200 行（rbacService.js + auditService.js + encryptionService.js + ssoService.js）
- 路由: ~200 行
- 前端: ~500 行（权限管理 UI）
- DevOps: ~800 行（Helm Chart + K8s manifests）
- 测试: ~600 行

---

## 优先级排序

| 优先级 | Phase | 原因 |
|--------|-------|------|
| 🔴 P0 | Phase 10 MCP 适配 | 当前最热门协议，开发者需求强烈，接入后立即扩大生态 |
| 🔴 P0 | Phase 11 A2A 支持 | 与 XClaw 核心定位完美契合，"Agent DNS" 的天然延伸 |
| 🟡 P1 | Phase 13 可视化 v2 | 差异化展示，营销利器，Demo 效果拉满 |
| 🟡 P1 | Phase 14 开发者平台 | 生态建设基础，直接影响开发者采用率 |
| 🟢 P2 | Phase 12 语义搜索 v2 | 技术深化，提升匹配精度 |
| 🟢 P2 | Phase 15 安全合规 | 企业客户刚需，但当前阶段可后置 |

---

## 总预估

| Phase | 后端 | 前端 | 测试 | 合计 |
|-------|------|------|------|------|
| 10 MCP | ~1,400 | - | ~500 | ~1,900 |
| 11 A2A | ~1,800 | - | ~600 | ~2,400 |
| 12 语义搜索 | ~1,150 | - | ~400 | ~1,550 |
| 13 可视化 | ~300 | ~2,000 | ~400 | ~2,700 |
| 14 开发者平台 | ~800 | ~1,500 | ~200 | ~7,300* |
| 15 安全合规 | ~1,400 | ~500 | ~600 | ~3,500 |
| **合计** | **~6,850** | **~4,000** | **~2,700** | **~19,350** |

*含 SDK/CLI/文档 ~5,000 行

> 预估 Phase 10-15 全部完成后，XClaw 代码总量将达到 **~40,000 行**，成为 Agentic Web 领域最完整的开源基础设施。

---

## 里程碑时间线（建议）

```
2026 Q2 (5-6月): Phase 10 MCP + Phase 11 A2A  →  v2.1 发布
2026 Q3 (7-9月): Phase 13 可视化 + Phase 14 平台  →  v3.0 发布
2026 Q4 (10-12月): Phase 12 搜索 + Phase 15 安全  →  v3.1 发布
```

---

*"AI Agent 时代需要三个基础设施：连接（MCP）、通信（A2A）、发现（XClaw）。"*
