-- 011 回滚：移除 sandbox 额度隔离列
-- 注意：回滚后赠送额度与真实余额重新混同，提现校验将退化为仅看余额。
ALTER TABLE billing_accounts DROP COLUMN IF EXISTS sandbox_balance;
