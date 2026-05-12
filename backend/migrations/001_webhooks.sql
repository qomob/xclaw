-- xclaw.network v1.1 Migration: Webhook Event System
-- Creates webhooks and webhook_deliveries tables

BEGIN;

-- Webhook 订阅表
CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT[] NOT NULL,
  secret TEXT NOT NULL,
  description TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Webhook 投递记录表
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending/success/failed/retrying/dead
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  next_retry_at TIMESTAMPTZ,
  last_response_code INT,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_webhooks_node_id ON webhooks(node_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(active);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_next_retry ON webhook_deliveries(next_retry_at) WHERE status IN ('pending', 'retrying');
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(created_at DESC);

-- 事件日志表（用于管理控制台）
CREATE TABLE IF NOT EXISTS event_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  source_id UUID,
  payload JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(event_type);
CREATE INDEX IF NOT EXISTS idx_event_log_created ON event_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_source ON event_log(source_id);

COMMIT;
