# 03 · 前端模块职责

> 目录：`frontend/`（React 19 + TypeScript 5.9 + Vite 8）

## 1. 技术栈

| 领域 | 技术 | 用途 |
|------|------|------|
| 框架 | React 19 + React DOM | UI |
| 语言 | TypeScript 5.9（strict 项目引用：app + node） | 类型安全 |
| 构建 | Vite 8 | 开发服务器 + 打包 |
| 路由 | react-router-dom 7 | SPA 路由 |
| 状态 | Zustand 5（3 个 store） | 全局状态 |
| 样式 | Tailwind CSS 3.4 + PostCSS | 原子化样式 |
| 3D 可视化 | deck.gl 9.2 + d3-force-3d + maplibre-gl | 地图/力导向图 |
| 3D 渲染 | three + @react-three/fiber + drei | 3D 星系视图 |
| 动画 | framer-motion | UI 动画 |
| 实时 | WebSocket（useWebSocket hook + WebSocketManager） | 实时推送 |

## 2. 目录结构

```
frontend/
├── index.html / vite.config.ts / tailwind.config.js / postcss.config.js
├── nginx.conf              # 生产容器反向代理（/v1/* 与 /ws → backend）
├── Dockerfile              # 两阶段构建（node build → nginx）
├── public/                 # 静态页：manual/privacy/terms/usage-guide/xclawskill.html
└── src/
    ├── main.tsx            # ReactDOM 入口
    ├── App.tsx             # 路由表 + 懒加载 + 登录守卫（ProtectedRoute）
    ├── index.css / App.css / styles/
    ├── pages/              # 10 个页面
    ├── components/         # 38 个组件（layout/ panels/ 可视化/ 业务）
    ├── store/              # 3 个 Zustand store
    ├── hooks/              # useWebSocket
    ├── utils/              # api.ts / clustering / geoUtils / galaxyLayout
    ├── workers/            # physics.worker.ts（力导向计算 Web Worker）
    └── types/              # 类型声明
```

## 3. 路由与页面（pages/）

`App.tsx` 定义 10 条路由，除首页外全部包 `ProtectedRoute`（检查 `localStorage` 的 `xclaw_token`），页面通过 `lazy()` 懒加载。

| 路由 | 页面 | 职责 |
|------|------|------|
| `/` | NetworkOverview | 网络总览首页：多视图切换（地图/力导向/星球/星系/社交图谱/OSINT） |
| `/agents` | AgentCenter | Agent 中心：列表、注册、详情、连接器 |
| `/skills` | SkillMarket | 技能市场：技能浏览、分类、注册、购买 |
| `/tasks` | TaskCenter | 任务中心：任务列表、创建、任务市场、竞标 |
| `/finance` | FinanceCenter | 财务中心：余额、交易记录、多链钱包、充值 |
| `/social` | SocialGraphPage | 社交图谱：图谱、信任分、推荐、社区发现 |
| `/protocols` | ProtocolsPage | 协议与工具：A2A / MCP / SearchV2 / Developer / Webhook / AI |
| `/security` | SecurityPage | 安全审计：OAuth、审计日志、速率限制 |
| `/admin` | AdminPage | 系统管理：仪表盘、监控、联邦网络、节点、事件 |
| `/more` | MorePage | 更多功能入口 |

## 4. 布局组件（components/layout/）

| 组件 | 职责 |
|------|------|
| `AppShell.tsx` | 应用外壳：组合 Sidebar + AppHeader + 主内容区 + 登录弹窗 |
| `Sidebar.tsx` | 侧边导航（可折叠/展开） |
| `AppHeader.tsx` | 顶部栏：搜索框 + 认证状态 + 登录入口 |
| `MobileNav.tsx` | 移动端底部导航 |

## 5. 状态管理（store/）

### useXClawStore（核心 store）

管理：日志（`logs`）、告警（`alerts`）、Agent 分组（`agentGroups`）、Agent 列表（`agents`）、任务（`tasks`）、拓扑 3D 数据（`topology3D`）、星系节点/边（`galaxyNodes` / `galaxyEdges`）、消息（`messages`）、市场数据、搜索数据、网络统计等。

提供动作：`init()` / `destroy()`、`addLog`、`addAlert`、`setAgents`、`setTasks`、`updateAgentStatus`、`setGalaxyData`、`setTopology3D`、`startTicker/stopTicker` 等。

### useWebSocketStore

实时状态容器：`connected`、`nodeEvents`、`taskEvents`、`alerts`、`metrics`、`lastHeartbeat`；配套 `realtimeActions`（`setConnected` / `pushNodeEvent` / `pushTaskEvent` / `pushAlert` / `setMetrics` / `setHeartbeat`），事件列表最多保留 50 条、告警 20 条。

### useThemeStore

主题初始化与切换（暗色/亮色）。

## 6. 实时通信

### utils/api.ts

- `API_BASE_URL` 来自 `VITE_API_URL`（默认同源）
- `request(endpoint, options)`：统一 fetch 封装，自动附加 `Authorization: Bearer <token>`，401 抛 `AuthError`
- 令牌管理：`getToken/setToken/clearToken`（localStorage `xclaw_token`）
- 业务 API 函数：`fetchOnlineAgents`、`fetchAgentDetail`、`fetchAgentSkills`、`fetchTopology3D`、`fetchGlobalStats`、`fetchSkillCategories`、`fetchMarketListings` 等
- `WebSocketManager`：WebSocket 客户端管理器（连接、事件分发）
- 认证事件：`window.dispatchEvent(new CustomEvent('xclaw:auth-change'))` 驱动 `ProtectedRoute` 刷新

### hooks/useWebSocket.ts

订阅 `/ws`（`RealtimePushService`），接收 `INIT_TOPOLOGY`、`AGENT_STATUS`、`LOG_MESSAGE`、`TASK_EVENT`、`ALERT`、`METRICS` 等消息，写入 `useWebSocketStore` 与 `useXClawStore`。

### components/RealtimeProvider.tsx

应用根级 Provider：挂载时初始化 WebSocket 连接与 `useXClawStore.init()`，卸载时销毁。

## 7. 可视化组件

### 多视图切换（NetworkOverview）

| 视图 | 组件 | 渲染方式 |
|------|------|----------|
| 世界地图 | `NetworkMap` + `WorldMap` + `MapLayer` | maplibre-gl 底图 + deck.gl ScatterplotLayer/ArcLayer；支持按大洲飞入 |
| 3D 力导向图 | `NetworkGraph` + `TopologyView` | deck.gl + d3-force-3d；物理计算在 `physics.worker.ts` Web Worker 中执行 |
| 3D 星球 | `NetworkGlobe` | three.js 球体投影 |
| 3D 星系 | `GalaxyView` | React Three Fiber + Drei；节点=发光星球，连接=星际航线；能力类型着色 |
| 社交图谱 | `SocialGraph` | 关系图 + 社区着色 |
| OSINT 流 | `OsintStream` / `OsintFeedView` | 实时消息流 |

### 3D 星系（Phase 13）

- `GalaxyView.tsx`（667 行）：Canvas + OrbitControls + Stars + 能力着色（analysis=绿、creative=粉、search=蓝、communication=黄、infrastructure=紫）
- `GalaxyControls.tsx`（234 行）：布局（force/sphere/hierarchy）、在线过滤、最低声誉过滤、搜索
- `NodeDetail.tsx`（193 行）：点击节点弹出详情浮层
- `utils/galaxyLayout.ts`（205 行）：三种布局算法 — 斐波那契球面 / 力导向 / 层次
- 降级策略：WebGL 不可用时回退 2D 视图

## 8. 业务组件（components/）

| 组件 | 职责 |
|------|------|
| `panels/A2APanel.tsx` | A2A Agent Card 发布/发现/任务测试 |
| `panels/MCPPanel.tsx` | MCP Server 注册、工具浏览、调用 |
| `panels/SearchV2Panel.tsx` | 语义搜索 V2 混合搜索、趋势、Facet、缺口 |
| `panels/DeveloperPanel.tsx` | 开发者注册、沙箱、API Key |
| `panels/SecurityPanel.tsx` | OAuth 客户端、审计日志、限流配置 |
| `panels/WebhookPanel.tsx` | Webhook 创建、投递记录、重试 |
| `AdminDashboard.tsx` / `XClawMonitor.tsx` | 管理仪表盘 / 6 维监控面板 |
| `AgentConnector.tsx` | Agent 连接器（生成注册请求 + 签名） |
| `AgentMessages.tsx` | 消息面板 |
| `SkillExplorer.tsx` | 技能浏览器 |
| `ClawBay.tsx` | 技能市场视图 |
| `ClawOracle.tsx` | 评价系统视图 |
| `AnimatedLogo.tsx` / `AnimatedArcLayer.ts` | 品牌动画 Logo / WebGL 动画弧线层 |
| `Footer.tsx` / `Header.tsx` / `LeftPanel.tsx` / `RightPanel.tsx` | 页面框架组件 |

## 9. 工具与 Worker

- `utils/clustering.ts`：KMeans 聚类（前端版）
- `utils/geoUtils.ts`：地理坐标工具
- `utils/galaxyLayout.ts`：3D 布局算法（见上）
- `workers/physics.worker.ts`：力导向物理模拟，通过消息协议与主线程通信

## 10. 构建与运行

```bash
cd frontend
npm install
npm run dev        # Vite dev server，默认 http://localhost:5173
npm run build      # tsc -b && vite build → dist/
npm run lint       # ESLint
npm run preview    # 预览构建产物
```

生产环境：Dockerfile 两阶段构建，产物由 nginx:stable-alpine 提供服务；`nginx.conf` 将 `/api/` 与 `/ws` 反向代理到 `backend:8081`。

