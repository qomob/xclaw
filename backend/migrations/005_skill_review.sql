-- ============================================
-- 005_skill_review
-- 技能上架审核：默认 approved 兼容存量；新上架置 pending，管理员审核后可见
-- ============================================

ALTER TABLE skills ADD COLUMN IF NOT EXISTS review_status VARCHAR(20) DEFAULT 'approved'; -- pending / approved / rejected
ALTER TABLE skills ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS review_note TEXT;

CREATE INDEX IF NOT EXISTS idx_skills_review_status
  ON skills(review_status)
  WHERE review_status = 'pending';
