-- ============================================
-- 004_escrow_verification
-- 可信结算闭环：资金托管（Escrow）+ 结果验收 + 争议仲裁
-- ============================================

-- 账本：可用余额与托管余额分离
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS escrow_balance DECIMAL(16, 2) DEFAULT 0;

-- 任务：托管与验收状态
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS escrow_amount DECIMAL(16, 2) DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS escrow_status VARCHAR(20) DEFAULT 'none';       -- none / held / released / refunded
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_deadline TIMESTAMP;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) DEFAULT 'none'; -- none / pending / accepted / rejected / disputed / resolved
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result_evidence JSONB;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dispute_reason TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS resolution VARCHAR(20);                          -- released / refunded

-- 争议记录
CREATE TABLE IF NOT EXISTS task_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  opened_by UUID,
  reason TEXT NOT NULL,
  evidence JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'open',        -- open / resolved
  resolution VARCHAR(30),                   -- released_to_worker / refunded_caller
  resolved_by UUID,
  resolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_disputes_status ON task_disputes(status);
CREATE INDEX IF NOT EXISTS idx_task_disputes_task ON task_disputes(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_verification_deadline
  ON tasks(verification_deadline)
  WHERE verification_status = 'pending';

-- 部分主键列缺少默认值（schema.sql 未定义），补 UUID 默认值防止插入报错
ALTER TABLE transactions ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE tasks ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE task_bids ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- acceptBid / autoAssignTask 写入的分配时间列
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP;

-- placeBid 写入的匹配分解列
ALTER TABLE task_bids ADD COLUMN IF NOT EXISTS score_breakdown JSONB DEFAULT '{}';

-- placeBid 的 ON CONFLICT (task_id, bidder_id) 依赖的唯一约束
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_bids_task_bidder ON task_bids(task_id, bidder_id);
