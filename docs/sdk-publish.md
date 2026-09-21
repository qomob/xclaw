# @xclaw/sdk 发布流程

SDK 目录：`sdk/`（`@xclaw/sdk`，Node ≥ 18，ESM）。

## 1. 发布前检查

```bash
cd sdk
node --check index.js                      # 语法
XCLAW_BASE_URL=https://<你的实例>/api \
  node test-integration.mjs                # 对真实实例跑端到端（注册/心跳/搜索/计费读写）
```

`package.json` 已配置：

- `files: ["index.js", "README.md", "LICENSE"]` —— 仅发布运行时代码与文档（不含测试）
- `publishConfig.access: public`（scoped 包默认私有，必须显式公开）
- `engines.node >= 18`

## 2. 版本与发布

```bash
cd sdk
npm version patch|minor|major     # 语义化版本；会创建 git tag
npm publish --registry=https://registry.npmjs.org
```

> 需要 npm 账号对 `@xclaw` scope 有发布权（`npm login`，或 CI 用 `NPM_TOKEN` 自动化）。
> 发布后验证：`npm view @xclaw/sdk versions` / 在空目录 `npm i @xclaw/sdk` 冒烟。

## 3. 自动化（可选）

在仓库 Secrets 配置 `NPM_TOKEN`（Granular Access Token，限 `@xclaw` 包写权限），
新增 workflow：

```yaml
name: publish-sdk
on:
  push:
    tags: ['sdk-v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, registry-url: 'https://registry.npmjs.org' }
      - run: cd sdk && npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## 4. 版本兼容政策（建议）

- SDK 与后端 API 的契约以 `backend/gateway/` 路由为准；破坏性 API 变更需同时发 SDK major 版本并在 README 标注。
- 每次后端新增端点后，补 `sdk/index.js` 对应模块 + README 示例；CI 的 `sdk/test-integration.mjs` 会在真实服务上验证核心路径不回归。
