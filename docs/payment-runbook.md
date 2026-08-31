# 支付运营手册（Runbook）——人工核验与人工打款

> 适用模式：充值人工核验 + 提现人工打款（dry-run，未配置提现执行器）。
> 所有管理员操作使用 `ADMIN_API_KEY`（存放于服务器 `/www/wwwroot/xclaw/.env`）。
> 铁律：**先链上核验后入账；先对账后打款；打款后立刻回写状态。**

## 0. 快速查询

```bash
# 登录服务器
ssh ali-us && cd /www/wwwroot/xclaw

# 管理员 key（勿复制到聊天工具/工单）
ADMIN=$(grep '^ADMIN_API_KEY=' .env | cut -d= -f2)

# 待核验充值 / 待打款提现 / 托管中任务
docker exec xclaw-db psql -U postgres -d xclaw -c \
  "SELECT id,node_id,chain,amount,tx_hash,created_at FROM deposits WHERE status='pending' ORDER BY created_at;"
docker exec xclaw-db psql -U postgres -d xclaw -c \
  "SELECT id,node_id,chain,amount,to_address,created_at FROM withdrawals WHERE status='pending' ORDER BY created_at;"
docker exec xclaw-db psql -U postgres -d xclaw -c \
  "SELECT id,caller_id,escrow_amount,escrow_status FROM tasks WHERE escrow_status='held';"
```

## 1. 充值核验（每日）

对每条 `pending` 充值：

1. **金额一致**：链上实际到账 ≥ 登记的 `amount`（差一点点按链上实际值入账，让用户补登记差额）。
2. **到账地址正确**：tx 的收款方必须是**我们的平台收款地址**（见附录，勿外传）。
3. **确认数足够**：ETH/USDT ≥ 12 确认，BTC ≥ 6 确认（`supported_chains.confirmations`）。
4. **防重放**：这个 tx_hash 之前没有 confirm 过（查询见下）。

```sql
-- tx_hash 是否已用过
SELECT id,status,created_at FROM deposits WHERE tx_hash='<0x...>';
```

5. 全部通过才执行入账：

```bash
curl -sX POST https://xclaw.network/api/v1/payment/deposits/<tx_id>/confirm \
  -H "Authorization: $ADMIN" -H "Content-Type: application/json" \
  -d '{"note":"已核验: 12+确认, 金额一致"}'
```

**核验不通过**：不入账即可（pending 挂着），并在运营群告知用户原因。不要用 failed 去删记录。

## 2. 提现打款（每日）

对每条 `pending` 提现：

1. **对账**：该用户账本余额确实已冻结这笔款（提现创建时已扣，正常无需再查；若系统提示余额异常，先冻结操作并排查）。
2. **地址校验**：`to_address` 与用户绑定的钱包地址一致；人工目视比对首尾 6 位 + 中段。
3. **从平台热钱包打款**：本金 + 链上 gas（平台侧手续费 `withdraw_fee` 已在创建时扣到平台账本，不需要转给用户）。
4. **保存 tx_hash**，立即回写：

```bash
curl -sX POST https://xclaw.network/api/v1/payment/withdrawals/<tx_id>/completed \
  -H "Authorization: $ADMIN" -H "Content-Type: application/json" \
  -d '{"tx_hash":"0x链上哈希"}'
```

**打款失败/地址无效**（如合约地址、格式错）：

```bash
curl -sX POST https://xclaw.network/api/v1/payment/withdrawals/<tx_id>/failed \
  -H "Authorization: $ADMIN" -H "Content-Type: application/json" \
  -d '{"error":"地址无法收款"}'
```

→ 系统自动把本金+手续费退回用户余额。然后通知用户换地址重新发起。

**纪律**：打款后 5 分钟内必须回写状态；当日打款当日清，不在 pending 积压过夜。

## 3. 每日对账（收盘一次）

三个数必须对得上：

```sql
-- ① 平台应负债 = 所有用户 余额+托管 之和
SELECT COALESCE(SUM(balance+escrow_balance),0) AS liability FROM billing_accounts;
-- ② 平台钱包实际余额（链上/交易所查）应 ≥ ①
-- ③ 流水试算: 充值确认总额 - 提现完成总额 - 手续费留存 应与 ① 增量吻合
SELECT type, SUM(amount) FROM transactions WHERE created_at::date=CURRENT_DATE GROUP BY type;
```

**① > ② = 资金缺口，立即停止打款并排查。**（① < ② 可能是未入账的充值，安全侧，仍需查明。）

## 4. 争议仲裁

```bash
# 查看争议
curl -s "https://xclaw.network/api/v1/admin/task-market/disputes" -H "Authorization: $ADMIN"
# 裁定（胜方决定 escrow 释放给执行方还是退还发布方）
curl -sX POST https://xclaw.network/api/v1/admin/task-market/disputes/<dispute_id>/resolve \
  -H "Authorization: $ADMIN" -H "Content-Type: application/json" \
  -d '{"resolution":"refund_worker|refund_caller","note":"依据..."}'
```

原则：按任务验收标准裁定；证据不足时退款给发布方（宁可错退，不可错扣）。

## 5. 应急

| 情况 | 动作 |
|---|---|
| 疑似盗号/异常提现激增 | 暂停打款（不打款即天然暂停），排查登录日志，必要时轮换该用户凭据 |
| 平台热钱包余额不足 | 暂停打款，从冷钱包补充；绝不打折打款 |
| 数据库异常 | 停止一切资金操作；`docker compose logs -f backend`；用最近的 `/database/backups/encrypted/*.enc` 恢复（见 docs/backup-restore.md） |
| ADMIN_API_KEY 疑似泄露 | 改 .env 后 `docker compose up -d backend maintenance`，并检查审计日志 |

## 6. 试运营期限额（上线初期）

- 单笔上限：`MAX_SINGLE_AMOUNT=1000`（已设置）
- 单日提现总额人工上限：建议 ≤ 5000 等值，超过部分顺延次日
- 放量条件：连续 2 周零资金事故 + 流程跑熟后再逐步放开
