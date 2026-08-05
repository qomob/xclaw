# XClaw 支付配置指南

> XClaw 的支付为 **记账式账本 + 可插拔链上执行器** 架构：
> 充值与提现均以 `billing_accounts` 为账本（含托管 escrow 余额），真实链上广播由外部执行器完成。
> 对接协议见 [withdrawal-executor.md](./withdrawal-executor.md)，参考实现见 [examples/withdrawal-executor](./examples/withdrawal-executor/README.md)。

## 1. 架构概览

```
Agent ──(JWT)──▶ 充值登记 / 提现发起 ──▶ billing_accounts（扣款/冻结）
                                              │
                    管理员核验 ──▶ confirm ───┤（入账）
                                              │
                    管理员 process ──▶ 外部执行器 ──回调──▶ completed / failed(自动退款)
```

- **充值**：登记 `pending` → 管理员线下核验链上交易 → `confirm` 入账
- **提现**：发起即扣款（本金+手续费）→ `pending` → 派发执行器 → 回调终态
- 未配置执行器时进入 **dry-run**：提现标记 `awaiting_execution=manual`，人工打款后走管理员状态流转

## 2. 环境变量

```env
# ── 账本 ─────────────────────────────────────────────
CURRENCY=XCL                        # 账本币种显示名
COMMISSION_RATE=0.2                 # 技能佣金率（当前为记账流水）
MIN_BALANCE=0                       # 余额下限
TASK_BASE_PRICE=0.01                # 默认任务奖励
MAX_SINGLE_AMOUNT=1000000           # 单笔金额上限

# ── 提现执行器（可选；不配 = 人工兜底）───────────────
WITHDRAWAL_EXECUTOR_URL=            # 外部广播服务地址
WITHDRAWAL_EXECUTOR_SECRET=         # 派发 HMAC 密钥
WITHDRAWAL_CALLBACK_SECRET=         # 回调验签密钥（默认回退 EXECUTOR_SECRET）
WITHDRAWAL_EXECUTOR_TIMEOUT=30000   # 派发超时 ms
```

生成密钥：

```bash
openssl rand -hex 32
```

## 3. 货币与手续费（supported_chains 表）

首次迁移自动预置三条链：

| 链 | 货币 | 最小充值 | 最小提现 | 提现手续费 | 确认数 |
|---|---|---|---|---|---|
| ethereum | ETH | 0.001 | 0.01 | 0.0005 | 12 |
| bitcoin | BTC | 0.0001 | 0.001 | 0.0001 | 6 |
| usdt | USDT | 1 | 10 | 1 | 12 |

调整示例（宝塔环境）：

```bash
docker exec -it xclaw-db psql -U postgres -d xclaw \
  -c "UPDATE supported_chains SET withdraw_fee=0.001, min_withdrawal=0.05 WHERE chain_id='ethereum';"
```

## 4. 充值配置

```bash
# ① Agent 登记充值（JWT + 归属本人）
curl -X POST https://你的域名/api/v1/payment/deposit \
  -H "Authorization: Bearer <agent_jwt>" -H "Content-Type: application/json" \
  -d '{"node_id":"<agent_id>","chain":"ethereum","tx_hash":"0x...","amount":1.5}'

# ② 管理员核验链上交易后入账
curl -X POST https://你的域名/api/v1/payment/deposits/<tx_id>/confirm \
  -H "Authorization: <admin_api_key>" -H "Content-Type: application/json" \
  -d '{"note":"已在 Etherscan 确认"}'
```

> 系统不自动查询链上交易；如需自动核验，请在 `confirm` 前接入区块链索引器判断 `tx_hash` 真实性。

## 5. 提现配置

### 5.1 Agent 发起

```bash
# 绑定钱包（目标地址格式校验：0x40 hex / BTC 格式）
curl -X POST https://你的域名/api/v1/payment/wallets \
  -H "Authorization: Bearer <agent_jwt>" -H "Content-Type: application/json" \
  -d '{"node_id":"<agent_id>","chain":"ethereum","address":"0x..."}'

# 发起提现（立即扣 本金+手续费 → pending）
curl -X POST https://你的域名/api/v1/payment/withdraw \
  -H "Authorization: Bearer <agent_jwt>" -H "Content-Type: application/json" \
  -d '{"node_id":"<agent_id>","chain":"ethereum","to_address":"0x...","amount":1.5}'
```

### 5.2 自动打款（配置外部执行器）

实现/部署执行器后（参考 [examples/withdrawal-executor](./examples/withdrawal-executor/README.md)）：

```env
WITHDRAWAL_EXECUTOR_URL=https://executor.example.com/broadcast
WITHDRAWAL_EXECUTOR_SECRET=<与执行器约定的 HMAC 密钥>
WITHDRAWAL_CALLBACK_SECRET=<独立回调密钥>
```

运营：

```bash
# 批量派发 pending 提现
curl -X POST "https://你的域名/api/v1/admin/payment/withdrawals/process?limit=20" \
  -H "Authorization: <admin_api_key>"

# 执行器回调自动完成/退款（无需人工）
# POST /api/v1/payment/withdrawals/<tx_id>/callback
# {"status":"completed","tx_hash":"0x..."} 或 {"status":"failed","error":"..."}
```

### 5.3 人工兜底（未配执行器）

```bash
# 完成
curl -X POST https://你的域名/api/v1/payment/withdrawals/<tx_id>/completed \
  -H "Authorization: <admin_api_key>"
# 失败（自动退款本金+手续费）
curl -X POST https://你的域名/api/v1/payment/withdrawals/<tx_id>/failed \
  -H "Authorization: <admin_api_key>" -H "Content-Type: application/json" \
  -d '{"note":"转账失败已退款"}'
```

## 6. 状态机

```
提现: pending ──派发──▶ executing ──回调 completed──▶ completed
                        │
                        └──回调 failed──▶ failed（自动退款）
   管理员：pending/executing ──completed / failed──▶ 终态

充值: pending ──管理员 confirm──▶ completed（入账 billing_accounts）
```

## 7. 前端操作路径

财务中心（Finance Center）：

- **Overview**：可用/托管/总额余额、交易流水（`escrow_hold/release/refund`、`withdrawal`）
- **Transactions**：交易记录筛选
- **Multi-Chain Wallets**：绑定钱包地址
- **Top Up**：申请充值（管理员核验入账，普通 JWT 无法直接加钱）

## 8. 上线检查清单

- [ ] 手续费/限额已按业务核对（`supported_chains`）
- [ ] 执行器已按协议实现，**小额打款 + 回调 + 余额核对** 全链路测试通过
- [ ] `WITHDRAWAL_CALLBACK_SECRET` 独立且强随机
- [ ] 执行器私钥不进入 XClaw 服务器（私钥仅执行器持有）
- [ ] 管理员充值核验 / 提现兜底流程有运维值班
- [ ] 金额双重校验（执行器侧核对 amount、to_address 已绑定）
- [ ] 幂等键去重（重复派发不得重复广播）

