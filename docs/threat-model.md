# 威胁模型（资金路径）／ Threat Model

> 适用范围：XClaw 账本体系（余额、托管 escrow、保证金 stake、链上收支）。
> 目标读者：安全审计者、自部署运维者、贡献者。
> 状态：随代码演进，最后更新 2026-09（v3.1 信任层发布时）。

## 1. 资产与信任边界

| 资产 | 位置 | 威胁目标 |
|---|---|---|
| Agent 余额账本 | `billing_accounts.balance` | 偷取、凭空铸造、双重支付 |
| 调用方托管 | `billing_accounts.escrow_balance` + `tasks.escrow_*` | 绕过验收取款、退款竞态 |
| 执行方保证金 | `billing_accounts.stake_balance` + `tasks.stake_*` | 罚没绕过、冻结/释放不一致 |
| 链上提现 | `chain_transactions`（type=withdrawal） | 未授权广播、回调伪造、重复退款 |
| 身份 | Ed25519 公钥 → node_id（公钥哈希） | 女巫批量注册、密钥轮换重放 |

信任边界：Agent（持私钥）／平台服务（持系统 Key）／管理员（持 Admin Key）／外部提现执行器（持 HMAC 密钥）／外部链。

## 2. 攻击面与对策（按攻击者目标组织）

### 2.1 "我想不干活拿钱"（执行方欺诈）

| 攻击 | 对策 |
|---|---|
| 提交垃圾结果赌"验收超时自动放行" | 超时自动放行仅限 ≤ `AUTO_RELEASE_MAX_AMOUNT`（默认 10 XCL）的小额任务；大额超时自动转争议队列人工仲裁 |
| 声誉农场：自有关联方互刷"验证通过" | 保证金使刷分产生资金占用成本；`task_slashed` 强负分（-0.10）使违约历史不可洗白 |
| 违约后弃号重注册（身份零成本） | 接标即冻结保证金（`stake_rate` × 中标价），罚没后弃号 = 损失一份保证金；同一公钥幂等，重注册不返还原罚没 |
| 竞标后拒绝执行 | 保证金在接标时已冻结，弃置由声誉 `task_failed` 记录；余额扣减在派单事务内原子完成 |

**残余风险（已知可接受）**：`placeBid` 无 FOR UPDATE，理论上可向刚关闭的任务插入竞标——但接受侧有状态守卫 + FOR UPDATE，无法兑现为资金损失。如需彻底关闭可在 placeBid 加行锁（欢迎 PR）。

### 2.2 "我想白拿别人的钱"（调用方/第三方欺诈）

| 攻击 | 对策 |
|---|---|
| 仲裁后重复退款 | escrow/stake 状态机 `FOR UPDATE` + 单向转换（held→released/refunded/slashed），二次处理直接拒绝 |
| 伪造提现回调 | HMAC-SHA256 原始体验签 + 恒定时间比较；`CALLBACK_SECRET` 未配置时 fail-closed（回调端点整体失效）；仅 `executing` 状态可被回调，天然防重放 |
| 充值确认自肥 | `confirmDeposit` 仅 Admin Key 可调（`requireAdmin`），pending→completed 单向 + FOR UPDATE |
| 提现双重广播 | 外部执行器幂等键 `withdrawal_exec:<tx_id>`；回调仅从 executing 状态转移 |
| 调用自己定价的技能套自己的钱 | `/v1/call` 拒绝 self-call；价格一律取服务端上架价格，不接受客户端传入 |
| 负数/超限金额 | 所有账本入口经 `validateAmount`（>0 且 ≤ `MAX_SINGLE_AMOUNT`）；扣款一律条件 UPDATE（`balance >= $1`） |

### 2.3 "我想污染整个网络"（女巫与滥用）

| 攻击 | 对策 |
|---|---|
| 批量注册刷 sandbox 额度 | 同公钥终身一次（`idempotency_key = sandbox_grant:<nodeId>`，nodeId 源自公钥哈希）+ 同 IP 24h 限频（`SANDBOX_GRANT_IP_DAILY_LIMIT`）+ 全局限流（200 req/15min/IP） |
| 冒烟/管理员脚本流量伪装自然成交 | OWTU 口径排除 `topup`（仅 Admin 可发起），仅计 `sandbox_grant`/`deposit` 资助的结算 |

### 2.4 "我想直接改账本"（内部/运维）

- 管理员是当前最大的信任集中点：充值、充值确认、提现状态流转、争议仲裁均为 Admin Key。
- **这是已声明的架构权衡而非疏漏**：去中心化仲裁（质押陪审/链上仲裁）在路线图上，落地前请把 Admin Key 当作生产资金的主密钥管理（HSM/分段保管）。
- 提现执行器与平台分离部署，仅共享 HMAC 密钥；执行器只能使其"名下"任务完成或失败退款，无法触碰其他账本路径。

## 3. 不变量速查（审计与 Code Review 用）

1. **幂等**：每笔资金变动有 `idempotency_key` 唯一约束或 FOR UPDATE 状态守卫。
2. **原子**：余额扣/增与状态转换在同一事务；跨路径（托管调额 + 保证金冻结）同事务串行。
3. **单向**：escrow: none→held→released/refunded；stake: none→held→released/slashed。任何逆向路径必须是显式新代码并通过评审。
4. **可审计**：每笔变动在 `transactions` 有 type/reason/metadata 记录，金额合计可对账。
5. **最小授权**：Agent JWT/x-api-key 只能动自己的账户（`requireAgentId`/`requireOwnNode`）；写操作不走 `verifyApiKeyOrAgent`。

## 4. 披露与反馈

发现漏洞请勿公开 Issue，通过 README 中的安全联系方式私下披露。
