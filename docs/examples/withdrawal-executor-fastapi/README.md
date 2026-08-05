# XClaw 提现执行器 — FastAPI 生产骨架

> 生产级骨架：HMAC 验签、SQLite 持久化幂等、指数退避重试回调、Prometheus 监控、web3 真实广播（可选）。
> 未配置 RPC/私钥时自动降级为模拟广播。

## 快速开始

```bash
pip install -r requirements.txt

# 本地联调（模拟广播）
EXECUTOR_SECRET=<与 XClaw 一致> \
EXECUTOR_CALLBACK_URL=http://127.0.0.1:8081/api/v1/payment/withdrawals \
uvicorn executor:app --host 0.0.0.0 --port 9090
```

## 生产配置（环境变量）

```bash
EXECUTOR_SECRET=<HMAC 密钥，与 WITHDRAWAL_EXECUTOR_SECRET 一致>
EXECUTOR_CALLBACK_URL=https://your-xclaw/api/v1/payment/withdrawals
EXECUTOR_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/xxx
EXECUTOR_PRIVATE_KEY=<签名私钥>
EXECUTOR_STATE_FILE=/var/lib/xclaw-executor/state.db
EXECUTOR_CALLBACK_MAX_RETRIES=5
EXECUTOR_CALLBACK_TIMEOUT_MS=15000
```

## 端点

| 端点 | 说明 |
|---|---|
| `POST /broadcast` | 验签、幂等、广播、异步回调 |
| `GET /health` | 存活探针（广播模式/回调配置/已处理数） |
| `GET /metrics` | Prometheus 文本格式 |

## 真实以太坊广播

安装 `web3` 并配置 `EXECUTOR_RPC_URL` / `EXECUTOR_PRIVATE_KEY` 后自动启用：
`executor.py::_broadcast_live` 使用 `eth.account` 签名并 `send_raw_transaction` 广播，等待回执后回调。

> ERC-20（USDT）需扩展为合约 `transfer` 调用；多链（BTC 等）需分别接入对应 SDK。

## 生产落地清单

- [ ] `EXECUTOR_STATE_FILE` 指向持久卷（多实例建议换 PostgreSQL/Redis 唯一键）
- [ ] 私钥经 KMS/密钥管理注入
- [ ] 回调失败指标 `callback_fail` 接入告警
- [ ] 广播前校验金额上限与目标地址（链上兜底）

