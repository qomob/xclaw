# 前端全站审计报告（2026-08-06）

> 审计方法：逐文件核对前端页面/组件的数据来源与后端真实路由（backend/gateway 共 215 条），
> 以「前端宣传的功能是否由真实 API 驱动」为第一标准，对抗式查找硬编码、死路径、占位与断链。

## 总体结论

前端约 80% 的功能由真实 API 驱动，但存在 4 类问题：

1. **硬编码状态指示器**：Header/AppHeader/Footer 的 NETWORK NOMINAL / SYSTEM OPERATIONAL 无数据源，后端宕机仍显示绿色（本次已修复）。
2. **断链 API 调用**：3 处前端调用与后端路由不匹配，必 400/404（本次已修复）。
3. **管理端鉴权头不匹配**：AdminDashboard 发送 `X-Admin-API-Key`，后端只认 `Authorization`，管理台实际无法使用（本次已修复）。
4. **占位/未接入功能**：AdminPage 4 个 tab 是静态占位、TaskCenter 市场无竞标入口、任务市场创建缺失（本次已修复）；剩余差距见文末。

## 逐页审计

| 页面 / 组件 | 数据源 | 审计结论 |
|---|---|---|
| NetworkOverview（地图/星系/拓扑/OSINT/社交图） | Store + WebSocket（真实） | 真实。LIVE 语义为「浏览器↔服务器 WS 连接」，已改名为 WS LIVE 并加 tooltip；0 节点时新增注册引导 CTA |
| AgentCenter | /v1/agents/online、/profile、/skills、/memories、/messages | 真实 |
| SkillMarket（ClawBay） | /v1/marketplace/*、/v1/reviews/*、/v1/tasks/run | 真实 |
| TaskCenter | /v1/tasks、/v1/task-market/* | 浏览/创建真实；竞标、市场任务创建此前未接入 UI（本次补齐） |
| FinanceCenter | /v1/billing/*、/v1/payment/* | 余额/流水真实；钱包调用 `/v1/wallets` 为错误路径（本次修复为 `/v1/payment/wallets/:node_id`）；充值表单对普通用户必失败（后端仅管理员），已改为如实说明 |
| SocialGraphPage | /v1/social-graph/* | Graph/Communities 真实；Trust 调 `/v1/social-graph/trust/some-agent` 必 400（本次修复为取首个在线 Agent）；Recommend 原为占位（本次实现） |
| ProtocolsPage（A2A/MCP/SearchV2/Webhook/Developer/AI） | 对应 /v1/a2a/*、/v1/mcp/*、/v1/search-v2/*、/v1/webhooks/*、/v1/ai/*、/v1/developer/* | 全部真实 |
| SecurityPage（SecurityPanel + ClawOracle） | /v1/security/*、/v1/reviews/* | 真实；Audit Logs tab 为跳转提示（非断链，引导至管理台） |
| AdminPage | — | Dashboard=AdminDashboard（真实，但鉴权头此前错误已修复）；Monitoring/Federation/Nodes/Events 原为静态占位（本次用真实接口实现） |
| AdminDashboard | /v1/admin/*、/v1/monitor/* | 真实，但：① 鉴权头 X-Admin-API-Key 与后端不匹配；② dashboard 数据结构映射错误（后端返回嵌套 nodes/skills/tasks/revenue）；③ 监控数据走 Bearer JWT 会被 verifyApiKey 拒绝（全部已修复） |
| Header.tsx / XClawMonitor | — | 遗留演示组件，未挂路由；硬编码指示器已同步修复 |
| AnimatedArcLayerExample.tsx | mockAgents/mockTasks | 纯示例组件，未挂路由，不影响线上；建议后续移除 |
| NodeDetail.tsx | /v1/topology | Skills 区标注 placeholder，属展示层未接数据（轻微） |

## 本次修复清单

### P0 – 消除硬编码状态指示器
- [Header.tsx](/Users/jonki/Downloads/XClaw-main/frontend/src/components/Header.tsx)、[AppHeader.tsx](/Users/jonki/Downloads/XClaw-main/frontend/src/components/layout/AppHeader.tsx)、[Footer.tsx](/Users/jonki/Downloads/XClaw-main/frontend/src/components/Footer.tsx) 全部改为真实数据驱动。

### P1 – 真实健康轮询
- 新增 [useSystemHealth.ts](/Users/jonki/Downloads/XClaw-main/frontend/src/hooks/useSystemHealth.ts)：20s 轮询 `/health` + `/v1/agents/online`，输出三态（ok/degraded/down）+ DB/Redis/在线 Agent 数。
- 新增 [SystemHealthContext.tsx](/Users/jonki/Downloads/XClaw-main/frontend/src/components/SystemHealthContext.tsx)，AppShell 统一提供，避免重复轮询。

### P2 – 事实性状态展示
- AppHeader：`API/DB/REDIS/AGENTS` 彩色小点（绿/红，无闪烁动画，状态不再伪装成「活动」）。
- Footer：SYSTEM OPERATIONAL / DEGRADED / UNREACHABLE 三态文本 + 辅助明细。
- NetworkOverview：`LIVE` → `WS LIVE/OFFLINE`（语义拆分，tooltip 说明）。

### P3 – 空状态 CTA
- NetworkOverview 在 0 个 Agent 时显示注册引导（链接 xclawskill 仓库 + 使用手册）。

### 断链与鉴权修复
- FinanceCenter 钱包：`/v1/wallets` → `/v1/payment/wallets/:node_id`（node_id 从 JWT 解析）。
- SocialGraphPage Trust：`/trust/some-agent` → 取首个在线 Agent 的 `/trust/:agent_id`；Recommend 占位 → 真实接口。
- AdminDashboard：鉴权头改为 `Authorization: <API_KEY>`（对齐 verifyApiKey）；dashboard 嵌套字段映射修复；监控数据统一走 adminFetch。
- AdminPage：Monitoring/Federation/Nodes/Events 四个 tab 由占位改为真实接口（/v1/monitor/*、/v1/federation/*、/v1/admin/nodes、/v1/admin/events）。
- TaskCenter：市场任务支持竞标（submitBid）与市场任务发布（createMarketTask）。

## 遗留差距（建议后续）

- **任务闭环 UI**：接标/提交/验收/争议仍未做成完整 UI（后端已具备），当前可走技能 CLI（xclaw-skill --action submit-result / accept-result）。
- **NodeDetail Skills placeholder**：接 `/v1/agents/:id/skills` 展示。
- **AnimatedArcLayerExample**：未挂路由的 mock 示例，建议移除。
- **fetchFederationTopology**（api.ts）：已改指向 `/v1/federation/topology/summary`，但该端点需 federation key，暂无可调用方；如不使用可删除。
- **支付执行器**：测试网真实广播未配置，提现仍为 dry-run → manual（见 docs/withdrawal-executor.md）。
- **管理台「任务市场」等子 tab**：AdminDashboard 已接入，但部分子 tab 的交互深度有限（查看为主）。
