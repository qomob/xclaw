# 贡献指南（CONTRIBUTING）

感谢你对 XClaw 的关注。XClaw 是 AI Agent 时代的公共网络层：身份、发现、信任、结算。
本文档说明如何参与共建。

## 行为准则

保持专业与善意。争论技术方案，不评判个人。

## 如何贡献

### 1. 报告 Bug

- 在 GitHub Issues 提交，附最小复现步骤、期望行为、实际行为
- 涉及**资金路径**（计费/托管/保证金/提现）的问题请加 `money-path` 标签并注明账本流水类型（`escrow_*` / `stake_*` / `commission` 等）

### 2. 安全漏洞

**请勿通过公开 Issue 报告安全漏洞。** 见 README 的安全披露说明，通过私下渠道联系 Qomob.AI。
我们承诺：48 小时内确认、修复后披露中致谢。

### 3. 提交代码

```bash
# 后端（Node 20+, ESM）
cd backend && npm ci && npm test          # 282 个单测，必须全绿

# 前端（React 19）
cd frontend && npm ci && npx tsc --noEmit # 类型检查必须通过

# 端到端冒烟（需本地 PG + Redis）
bash scripts/smoke-self-serve.sh          # 全自助闭环（无管理员）
bash scripts/smoke-task-market.sh both    # 管理员闭环（positive + dispute）
```

提交信息遵循仓库惯例：`type(scope): 中文摘要`，如 `feat(billing): ...`、`fix(trust): ...`。

### 4. 资金路径改动的硬性要求

任何触及以下模块的 PR，除单测外必须说明对威胁模型（[docs/threat-model.md](./docs/threat-model.md)）各项攻击面的影响：

- `backend/billing/`（账本、托管、保证金、sandbox 额度）
- `backend/services/taskMarketService.js`（竞标/结算/仲裁/超时）
- `backend/services/multiChainPaymentService.js`、`backend/services/withdrawalExecutor.js`（链上收支）
- `backend/gateway/auth.js`（认证与授权）

不变量（Invariant）速查，PR 描述中请自查：

| 不变量 | 说明 |
|---|---|
| 幂等 | 每笔资金变动有 `idempotency_key`；状态机转换有 FOR UPDATE 前置守卫 |
| 正负守卫 | 金额必须 > 0 且 ≤ `MAX_SINGLE_AMOUNT`；扣款用条件 UPDATE（`balance >= $1`） |
| 来源可审计 | 每笔变动落 `transactions`，带 type / reason / metadata |
| 罚没对称 | `stake_slash` 必须同时记录补偿金额与没收金额 |

### 5. 文档

协议与 API 变更请同步更新 `README.md` / `README_EN.md` 的对应表格与 `docs/wiki/`。

## 开发环境

参考 README「快速开始」；本地起 PG + Redis 后，迁移在启动时自动应用（`backend/migrations/`）。
新增表结构一律走迁移文件（幂等 DDL，`IF NOT EXISTS`），不要直接改 `database/schema.sql` 之外的历史行为。

## 许可

提交即表示你同意代码以 Apache License 2.0（见 [LICENSE](LICENSE)）授权给 Qomob.AI 与社区。
