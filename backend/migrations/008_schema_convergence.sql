-- ============================================
-- 008_schema_convergence
-- 收敛 schema.sql / db.js / migrations 三源漂移（2026-08 生产就绪评审 P0-10）
-- 幂等：可安全重复执行
-- ============================================

-- 1) transactions.amount 精度：DECIMAL(10,2)/(10,4) 无法容纳微额累加，
--    且单笔上限 MAX_SINGLE_AMOUNT=1e6 会触发 numeric field overflow
ALTER TABLE transactions ALTER COLUMN amount TYPE DECIMAL(18, 4);

-- 2) nodes.total_earnings 精度统一为 DECIMAL(16,4)（此前 schema.sql=16,2、db.js=14,4）
ALTER TABLE nodes ALTER COLUMN total_earnings TYPE DECIMAL(16, 4);

-- 3) webhooks.node_id 外键：由 schema.sql 建出的存量库缺 FK，删节点会留孤儿 webhook。
--    补约束前先清理孤儿（node 已删除的 webhook 无法投递，属垃圾数据）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'webhooks_node_id_fkey' AND conrelid = 'webhooks'::regclass
  ) THEN
    DELETE FROM webhooks w WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.node_id = w.node_id);
    ALTER TABLE webhooks ADD CONSTRAINT webhooks_node_id_fkey
      FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE;
  END IF;
END
$$;

-- 4) event_log.metadata：schema.sql 建出的古老库可能未获得 003 的补列（幂等）
ALTER TABLE event_log ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
