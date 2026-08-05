-- ============================================
-- 003_observability
-- 指标快照表（MetricsManager 定期写入，供趋势查询与告警）
-- ============================================

CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id BIGSERIAL PRIMARY KEY,
  online_nodes INTEGER DEFAULT 0,
  total_nodes INTEGER DEFAULT 0,
  task_total INTEGER DEFAULT 0,
  task_completed INTEGER DEFAULT 0,
  task_failed INTEGER DEFAULT 0,
  success_rate DOUBLE PRECISION DEFAULT 0,
  ws_connections INTEGER DEFAULT 0,
  memory_rss BIGINT DEFAULT 0,
  cpu_usage DOUBLE PRECISION DEFAULT 0,
  error_rate DOUBLE PRECISION DEFAULT 0,
  db_connections INTEGER DEFAULT 0,
  avg_latency DOUBLE PRECISION DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_created ON metrics_snapshots(created_at DESC);

-- eventBus 持久化依赖 metadata 列（schema.sql 的 event_log 无此列）
ALTER TABLE event_log ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
