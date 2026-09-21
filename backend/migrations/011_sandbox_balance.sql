-- 011: sandbox 赠送额度与可提现余额隔离
--
-- 背景：注册赠送的 sandbox 额度此前与真实充值余额混同，可被提取（女巫注册套现）。
-- 方案：billing_accounts.sandbox_balance 记录余额中「不可提现」的部分：
--   - 发放 sandbox 额度时同步增加
--   - 真实消费（扣款/托管释放给执行方/保证金罚没）时递减，GREATEST(0, ...) 兜底
--   - 托管冻结/解冻、退款/退还保证金不改变它，保证「冻结后取消退款」不会把赠送额度洗成可提现
-- 可提现金额 = balance - sandbox_balance（见 billing/index.js getWithdrawableBalance）。

ALTER TABLE billing_accounts
  ADD COLUMN IF NOT EXISTS sandbox_balance DECIMAL(16, 2) NOT NULL DEFAULT 0;

-- 存量账户回填：历史上发放过的 sandbox 总额（终身一次），不超过当前余额
UPDATE billing_accounts ba
   SET sandbox_balance = LEAST(ba.balance, g.sandbox_total)
  FROM (
    SELECT node_id, SUM(amount) AS sandbox_total
      FROM transactions
     WHERE type = 'sandbox_grant' AND status = 'completed'
     GROUP BY node_id
  ) g
 WHERE ba.node_id = g.node_id
   AND ba.balance > 0
   AND ba.sandbox_balance = 0;

COMMENT ON COLUMN billing_accounts.sandbox_balance IS '不可提现的赠送额度（sandbox grant），真实消费时递减';
