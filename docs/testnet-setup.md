# Sepolia 测试网提现执行器配置手册

> 目标：把提现从 dry-run（manual）升级为真实链上广播——
> 管理员 `process` 后，后端派发给本机执行器，执行器用 ethers v6 广播到 Sepolia，
> 再通过 HMAC 回调把状态写回，自动完成（或失败退款）。

## 架构回顾

```text
后端 process 提现
  └─ POST http://127.0.0.1:9090/broadcast   (HMAC-SHA256 + 幂等键)
       执行器 ethers 广播 Sepolia
       └─ POST https://xclaw.network/api/v1/payment/withdrawals/:tx_id/callback (HMAC)
            后端验签 → completed（放款） / failed（自动退款）
```

## 1. 前置条件

- 服务器可访问外网（RPC、Etherscan）。
- 生成测试私钥（只用于测试网）：
  ```bash
  echo "0x$(openssl rand -hex 32)"
  ```
- 给该地址领 Sepolia 测试 ETH（至少 0.05 ETH，够一笔 gas + 转账）：
  - Alchemy: https://sepoliafaucet.com
  - Chainlink: https://faucets.chain.link/sepolia
  - Infura: https://www.infura.io/faucet/sepolia
- RPC（选一）：
  - https://rpc.sepolia.org （免费，偶不稳定）
  - Alchemy/Infura 免费 RPC：`https://eth-sepolia.g.alchemy.com/v2/<你的Key>`（推荐）

## 2. 安装执行器

```bash
cd /www/wwwroot/xclaw/docs/examples/withdrawal-executor-node
npm install --production
```

## 3. systemd 常驻（推荐，替代 nohup）

仓库已提供模板：

```bash
cp /www/wwwroot/xclaw/docs/examples/withdrawal-executor-node/xclaw-executor.service \
   /etc/systemd/system/xclaw-executor.service
```

编辑模板，替换两个占位值，并核对共享密钥：

```ini
Environment=EXECUTOR_SECRET=REPLACE_WITH_SHARED_SECRET      # 与后端 WITHDRAWAL_EXECUTOR_SECRET 一致
Environment=EXECUTOR_PRIVATE_KEY=REPLACE_WITH_TESTNET_PRIVATE_KEY  # 0x 开头的测试私钥
```

启动：

```bash
mkdir -p /var/lib/xclaw-executor
systemctl daemon-reload
systemctl enable --now xclaw-executor
systemctl status xclaw-executor --no-pager
curl -s http://127.0.0.1:9090/health
```

健康检查期望：

```json
{"status":"ok","live_broadcast":true,"callback_url":true,"processed":0}
```

`live_broadcast:true` 表示已进入真实广播模式；`callback_url:true` 表示回调地址已配置。

## 4. 后端接入

在 `/www/wwwroot/xclaw/.env` 追加（`EXECUTOR_SECRET` 必须与执行器的完全一致）：

```env
WITHDRAWAL_EXECUTOR_URL=http://127.0.0.1:9090/broadcast
WITHDRAWAL_EXECUTOR_SECRET=<与 EXECUTOR_SECRET 相同>
WITHDRAWAL_CALLBACK_SECRET=<与 EXECUTOR_SECRET 相同>
```

重启后端：

```bash
cd /www/wwwroot/xclaw
docker compose up -d backend
```

> 说明：`WITHDRAWAL_CALLBACK_SECRET` 不填时默认回退到 `WITHDRAWAL_EXECUTOR_SECRET`，
> 显式配置更清晰。派发用 `WITHDRAWAL_EXECUTOR_SECRET` 签名，回调用 `WITHDRAWAL_CALLBACK_SECRET` 验签。

## 5. 端到端验证（Sepolia）

复用之前的测试 Agent（PayTest，`fc651127-91a4-5fc7-9c25-a9788e1d218a`）或注册新 Agent：

```bash
cd /www/wwwroot/xclaw/skills/xclawskill
ADMIN_KEY=$(grep '^ADMIN_API_KEY=' /www/wwwroot/xclaw/.env | cut -d= -f2)
JWT=$(python3 -c "import json;print(json.load(open('/tmp/pay_test.json'))['jwt'])")
AGENT=$(python3 -c "import json;print(json.load(open('/tmp/pay_test.json'))['agent_id'])")

# ① 管理员充值记账额度（当前账本以 XCL 计；50 足够覆盖 0.5 ETH 提现的余额校验）
curl -s -X POST https://xclaw.network/api/v1/billing/topup \
  -H "Authorization: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d "{\"node_id\":\"$AGENT\",\"amount\":50}"

# ② 发起提现 0.5 ETH 到测试地址
curl -s -X POST https://xclaw.network/api/v1/payment/withdraw \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d "{\"node_id\":\"$AGENT\",\"chain\":\"ethereum\",\"to_address\":\"0x1111111111111111111111111111111111111111\",\"amount\":0.5}"

# ③ 管理员派发 → 应返回 status:"executing"
curl -s -X POST "https://xclaw.network/api/v1/admin/payment/withdrawals/process?limit=10" \
  -H "Authorization: $ADMIN_KEY"

# ④ 观察执行器日志（应出现 已广播交易 与 callback ok: HTTP 200）
journalctl -u xclaw-executor -n 30 --no-pager

# ⑤ 确认状态落库（含 tx_hash）
curl -s "https://xclaw.network/api/v1/payment/transactions/$AGENT" -H "Authorization: Bearer $JWT"
```

在 [Sepolia Etherscan](https://sepolia.etherscan.io) 按 tx_hash 可查到真实链上交易。

## 6. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `/health` 返回 `live_broadcast:false` | RPC 或私钥未配置 | 检查 systemd 环境变量 |
| process 返回 `manual` | 后端 .env 未配置执行器 URL | 补 `WITHDRAWAL_EXECUTOR_URL` 后重启 backend |
| 广播报错 `insufficient funds` | 测试地址没有 Sepolia ETH | 领水后再试 |
| RPC 超时 | rpc.sepolia.org 不稳定 | 换 Alchemy/Infura 免费 RPC |
| 回调 401 | 密钥不一致 | 核对三处 EXECUTOR_SECRET 完全一致 |
| 回调失败重试后仍失败 | 后端不可达 | 检查 Nginx `/api/v1/payment/withdrawals` 反代与 8080 连通 |

## 7. 安全注意

- 测试私钥只用于 Sepolia；**绝不**在主网复用。
- 主网方案：KMS/专用签名服务 + 小额限额 + 多签审核，先小额定标。
- 9090 端口只允许本机访问（systemd 默认监听 0.0.0.0，可加防火墙规则只放行 127.0.0.1）。
- 敏感值（EXECUTOR_SECRET、私钥）只放 `.env` / systemd EnvironmentFile，**不要提交仓库**。
- 生产建议将 state.json 换为 Redis/Postgres 持久化（见 store.js 注释），并接入 /metrics 监控。
