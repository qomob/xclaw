-- 009: 增长分析（迭代 0：北极星指标 OWTU 基础设施）
--
-- OWTU（Organic Weekly Transactions）定义：
--   近一周内 escrow_release（成功结算）笔数，且该任务 caller 的账本中
--   存在至少一笔非管理员注入的资金（sandbox_grant / deposit）。
--   纯管理员 topup 资助的双向冒烟流量不计入。
--
-- 不建新表：埋点复用 event_log（eventBus 已持久化全部事件），
-- 结算与资金来源复用 transactions（type + metadata），仅需查询索引。

-- 事件按类型+时间检索（漏斗统计主查询路径）
CREATE INDEX IF NOT EXISTS idx_event_log_type_created
  ON event_log (event_type, created_at DESC);

-- 结算流水按类型+时间检索（OWTU 周序列主查询路径）
CREATE INDEX IF NOT EXISTS idx_transactions_type_status_created
  ON transactions (type, status, created_at);

-- sandbox 发放限频查询（按 IP 统计 24h 内发放次数）：
-- 部分索引只覆盖 sandbox_grant，体量恒小
CREATE INDEX IF NOT EXISTS idx_transactions_sandbox_grant_created
  ON transactions (created_at) WHERE type = 'sandbox_grant';
