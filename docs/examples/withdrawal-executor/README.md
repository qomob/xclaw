# 提现执行器参考实现（Withdrawal Executor — Reference）

> 最小可用的 XClaw 提现执行器，用于**本地联调与协议验证**。
> 零第三方依赖（Python 标准库）。**不执行真实链上广播**——`executor.py` 中
> `broadcast()` 为模拟实现，生产请替换为真实的私钥签名与链上 RPC 广播。

## 协议速览

对接协议完整定义见 [docs/withdrawal-executor.md](../../withdrawal-executor.md)。

```
XClaw ──POST /broadcast（HMAC + 幂等键）──▶ 执行器
执行器 ──POST /v1/payment/withdrawals/:id/callback（HMAC）──▶ XClaw
```

## 用法

### 1. 启动执行器（自动模式：模拟广播后自动回调 completed）

```bash
python3 executor.py \
  --secret <与 XClaw WITHDRAWAL_EXECUTOR_SECRET 一致的密钥> \
  --callback-url http://127.0.0.1:8081/api/v1/payment/withdrawals \
  --auto --port 9090
```

### 2. 手动模式（先模拟广播，稍后手动回调）

终端 A（接收派发）：

```bash
python3 executor.py --secret <key> --port 9090
```

终端 B（手动触发回调）：

```bash
# 完成
python3 executor.py --secret <key> \
  --manual-callback <withdrawal_id> --tx-hash 0xabc123

# 失败（XClaw 自动退款）
python3 executor.py --secret <key> \
  --manual-callback <withdrawal_id> --error "insufficient gas"
```

### 3. 本地联调 XClaw

```bash
# 配置 .env
WITHDRAWAL_EXECUTOR_URL=http://127.0.0.1:9090/broadcast
WITHDRAWAL_EXECUTOR_SECRET=<key>
WITHDRAWAL_CALLBACK_SECRET=<key 或独立值>

# 重启后端后，管理员派发
curl -X POST "http://127.0.0.1:8081/v1/admin/payment/withdrawals/process?limit=10" \
  -H "Authorization: <admin_api_key>"
```

提现状态流转：`pending → executing（已派发）→ completed（回调）`；执行器返回失败则 XClaw 自动退款。

## 幂等与安全

- 执行器以 `X-Idempotency-Key` 去重（内存 Set；生产建议持久化）
- 派发/回调均基于**原始请求体字节**计算 `HMAC-SHA256(secret)`
- XClaw 端仅 `executing` 状态可被回调，重复/乱序回调返回 409
- 生产部署额外要求：时间戳窗口校验、私钥不出执行器、金额/地址双重校验、回调重试

## 生产落地清单

- [ ] `broadcast()` 替换为真实链上签名 + RPC 广播
- [ ] 幂等去重改为持久化存储（Redis/DB）
- [ ] 回调增加指数退避重试
- [ ] 监控与告警（广播失败、回调失败）
- [ ] 私钥安全管理（KMS / HSM / 专用签名服务）

