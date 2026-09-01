# Security Policy / 安全策略

## Supported Versions / 支持版本

| Version | Supported |
| ------- | --------- |
| main (HEAD) | ✅ |
| < 3.1 | ❌ |

## Reporting a Vulnerability / 报告漏洞

**请勿通过公开 GitHub Issue 报告安全漏洞。**

- 首选渠道：GitHub **Private vulnerability reporting**（仓库 Security 标签页 → Report a vulnerability）
- 备选渠道：**security@qomob.ai**

请包含：影响的模块（`backend/billing/`、`taskMarketService`、`multiChainPaymentService`、`withdrawalExecutor`、`gateway/auth.js` 优先级最高）、复现步骤、影响评估。资金路径的威胁模型见 [docs/threat-model.md](./docs/threat-model.md)。

**响应承诺 / Our commitment**: 48 小时内确认（48h acknowledgement），修复发布后在披露公告中致谢（credit on disclosure）。

## Scope / 范围说明

- Admin Key、系统 API Key、执行器 HMAC 密钥属于运维侧凭据泄露类问题，请一并报告。
- 女巫类经济学攻击（批量注册、声誉农场）的缓解措施与已知可接受风险见威胁模型第 2.3 节。
