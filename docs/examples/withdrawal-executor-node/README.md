# XClaw 提现执行器 — Node.js 生产骨架（ethers 真实广播）

> 生产级骨架：HMAC 验签、持久化幂等、指数退避重试、Prometheus 监控、以太坊真实广播（ethers v6）。
> 未配置 RPC/私钥时自动降级为模拟广播，便于本地联调。

## 快速开始

```bash
npm install

# 本地联调（模拟广播）
EXECUTOR_SECRET=<与 XClaw 一致> \
EXECUTOR_CALLBACK_URL=http://127.0.0.1:8081/api/v1/payment/withdrawals \
npm start
```

## 生产配置（环境变量）

```bash
EXECUTOR_PORT=9090
EXECUTOR_SECRET=<HMAC 密钥，与 WITHDRAWAL_EXECUTOR_SECRET 一致>
EXECUTOR_CALLBACK_URL=https://your-xclaw/api/v1/payment/withdrawals
EXECUTOR_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/xxx
EXECUTOR_PRIVATE_KEY=<签名私钥（建议 KMS/环境注入，勿写入代码库）>
EXECUTOR_CALLBACK_MAX_RETRIES=5
EXECUTOR_CALLBACK_TIMEOUT_MS=15000
EXECUTOR_STATE_FILE=/var/lib/xclaw-executor/state.json
```

## 端点

| 端点 | 说明 |
|---|---|
| `POST /broadcast` | 接收 XClaw 派发；验签、幂等、广播、异步回调 |
| `GET /health` | 存活探针（含广播模式/回调配置/已处理数） |
| `GET /metrics` | Prometheus 文本格式（请求/派发/广播/回调计数） |

## 目录结构

```
src/
├── config.js      # 环境变量配置
├── store.js       # 幂等持久化（JSON 文件；生产可替换 Redis/DB）
├── broadcaster.js # 广播层：ethers 真实广播 / 模拟降级
├── callback.js    # 回调 XClaw：HMAC + 指数退避重试
├── server.js      # Express 服务 + 监控
└── index.js       # 入口
```

## 生产落地清单

- [ ] `EXECUTOR_STATE_FILE` 指向持久卷（多实例请把 `store.js` 换成 Redis/Postgres 唯一键）
- [ ] 私钥经 KMS/密钥管理注入，服务器文件权限 0600
- [ ] 回调失败接入告警（`callback_fail` 指标 + 日志）
- [ ] 广播前校验金额上限与 `to_address`（链上兜底）
- [ ] ERC-20（USDT）需扩展为合约转账（示例仅原生币直转）

