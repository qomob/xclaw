# 提现执行器对接规范（Withdrawal Executor Protocol）

> XClaw 的多币种支付是**记账式管理**：提现创建后立即冻结扣款，真实链上广播由外部执行器完成。
> 本文定义 XClaw 与外部链上广播服务的对接协议（派发 + 回调 + HMAC + 幂等）。

## 1. 工作模式

| 模式 | 条件 | 行为 |
|------|------|------|
| **dry-run（默认）** | 未设置 `WITHDRAWAL_EXECUTOR_URL` | 提现保持 `pending`，metadata 标记 `awaiting_execution=manual`；由人工打款后调用管理员状态流转 |
| **外部执行器** | 设置 `WITHDRAWAL_EXECUTOR_URL` + `WITHDRAWAL_EXECUTOR_SECRET` | 管理员触发批量派发 → 执行器广播 → 回调自动完成/退款 |

## 2. 状态机

```
pending ──派发──▶ executing ──回调 completed──▶ completed
   │                 │
   │                 └──回调 failed──▶ failed（自动退款：本金+手续费）
   └──管理员状态流转（completed/failed）──▶ 终态
```

- 提现创建时即从调用方可用余额扣款（本金+手续费）
- `executing` 表示已派发给执行器、资金已扣未放；仅回调或管理员可将其转为终态

## 3. 派发请求（XClaw → 执行器）

`POST {WITHDRAWAL_EXECUTOR_URL}`

请求头：

```
Content-Type: application/json
X-XClaw-Signature: sha256=<hmac>
X-Idempotency-Key: withdrawal_exec:<withdrawal_id>
```

请求体：

```json
{
  "withdrawal_id": "uuid",
  "chain": "ethereum",
  "to_address": "0x...",
  "from_address": "0x...",
  "amount": 0.01,
  "currency": "ETH",
  "idempotency_key": "withdrawal_exec:<withdrawal_id>",
  "nonce": "随机串",
  "timestamp": "ISO-8601"
}
```

HMAC 计算：`HMAC-SHA256(secret, rawRequestBody)`，`secret` 为 `WITHDRAWAL_EXECUTOR_SECRET`。

成功响应（2xx）：

```json
{ "accepted": true, "reference": "执行器内部编号（可选）" }
```

拒绝响应（4xx/5xx）：提现保持 `pending`，派发错误记录日志，可重试。

## 4. 回调（执行器 → XClaw）

`POST https://<xclaw>/v1/payment/withdrawals/:tx_id/callback`

请求头：

```
Content-Type: application/json
X-XClaw-Signature: sha256=<hmac>
```

请求体：

```json
{
  "status": "completed",
  "tx_hash": "0x链上交易哈希",
  "error": null
}
```

- `status` 仅允许 `completed` / `failed`
- HMAC 基于**原始请求体字节**，密钥为 `WITHDRAWAL_CALLBACK_SECRET`（未设置时回退 `WITHDRAWAL_EXECUTOR_SECRET`）
- 回调验签失败返回 `401`；状态不匹配或重复回调返回 `409`（幂等：仅 `executing` 可被处理）
- `completed`：写入 `tx_hash`，状态置 `completed`
- `failed`：自动退款（本金+手续费回到调用方余额），记录 `withdrawal_refund` 审计流水，状态置 `failed`

## 5. 运维操作

```bash
# 批量派发待执行提现（管理员 API Key）
curl -X POST "https://xclaw.network/v1/admin/payment/withdrawals/process?limit=20" \
  -H "Authorization: <admin_api_key>"

# 人工兜底：提现完成 / 失败（失败自动退款）
curl -X POST https://xclaw.network/v1/payment/withdrawals/<tx_id>/completed \
  -H "Authorization: <admin_api_key>"
curl -X POST https://xclaw.network/v1/payment/withdrawals/<tx_id>/failed \
  -H "Authorization: <admin_api_key>" -H "Content-Type: application/json" \
  -d '{"note": "打款失败"}'
```

## 6. 安全要求（对接外部服务时必读）

1. **私钥永不出 XClaw 服务器**：执行器可持有签名私钥，XClaw 只传地址与金额
2. **金额双重校验**：执行器必须校验 `amount` 与本地账本一致且低于单笔上限；`to_address` 必须是已绑定钱包地址
3. **幂等**：以 `idempotency_key` 去重；重复派发不得重复广播
4. **回调重放防护**：HMAC + 时间戳窗口（建议 5 分钟）；XClaw 端仅 `executing` 状态可回调（天然防重放）
5. **网络隔离**：执行器与 XClaw 之间使用内网/白名单；回调端点无 API Key，仅凭 HMAC（务必设置 `WITHDRAWAL_CALLBACK_SECRET`）
6. **审计**：所有派发/回调/退款均落 `chain_transactions.metadata` 与 `transactions` 流水
