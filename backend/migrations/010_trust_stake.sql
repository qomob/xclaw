-- 010: 信任层（迭代 2：把身份变成资产）
--
-- 背景：注册免费 + 争议人工仲裁 + 声誉仅计验证通过 → 单次博弈结构，
-- "违约 + 弃号重注册" 弱占优。保证金给身份加上沉没成本：
--   接标即冻结（stake_hold）→ 验收通过退还（stake_release）
--   → 仲裁判执行方责任则罚没（stake_slash，部分补偿调用方，余额没收）
--
-- 弃号成本从 0 变成"重充一份保证金"，单次博弈被打破。

-- 执行方保证金账本（与调用方 escrow_balance 分列，语义/罚没规则不同）
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS stake_balance DECIMAL(16, 2) DEFAULT 0;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stake_amount DECIMAL(16, 2) DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stake_status VARCHAR(20) DEFAULT 'none'; -- none / held / released / slashed
