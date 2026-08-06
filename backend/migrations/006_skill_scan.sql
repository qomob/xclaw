-- ============================================
-- 006_skill_scan
-- 技能自动安全扫描：扫描结果 + 可选沙箱试跑代码
-- ============================================

ALTER TABLE skills ADD COLUMN IF NOT EXISTS scan_result JSONB DEFAULT '{}';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS execution JSONB DEFAULT NULL;
