-- XClaw 数据库基线 Schema
--
-- ⚠️ 权威来源是 backend/migrations/*.sql：容器启动时按序执行全部迁移，
-- 本文件只提供「全新部署的首个基线」。文件末尾的「迁移增量」区块列出
-- 后续迁移新增的表/列，保证该文件与线上真实结构一致（便于人工查阅）。
-- 变更结构时请新增迁移文件，并同步更新本文件的对应区块。

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS nodes (
    node_id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    capabilities TEXT NOT NULL,
    tags JSONB DEFAULT '[]',
    public_key TEXT NOT NULL,
    endpoint_url VARCHAR(255),
    latitude DOUBLE PRECISION DEFAULT 0,
    longitude DOUBLE PRECISION DEFAULT 0,
    status VARCHAR(50) DEFAULT 'offline',
    reputation_score DECIMAL(3, 2) DEFAULT 1.0,
    -- 精度与 backend/registry/db.js、migrations/008 对齐（避免三源漂移）
    total_earnings DECIMAL(16, 4) DEFAULT 0,
    last_heartbeat TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS node_embeddings (
    node_id UUID REFERENCES nodes(node_id) ON DELETE CASCADE,
    capability_vector vector(768),
    PRIMARY KEY (node_id)
);

CREATE TABLE IF NOT EXISTS skills (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(100) NOT NULL,
    version VARCHAR(50) NOT NULL,
    node_id UUID REFERENCES nodes(node_id),
    schema JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY,
    type VARCHAR(255) NOT NULL,
    payload JSONB DEFAULT '{}',
    status VARCHAR(50) DEFAULT 'pending',
    node_id UUID REFERENCES nodes(node_id),
    skill_id UUID REFERENCES skills(id),
    reward_amount DECIMAL(10, 2),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_logs (
    log_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
    node_id UUID REFERENCES nodes(node_id),
    action VARCHAR(255),
    details TEXT,
    status VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY,
    task_id UUID REFERENCES tasks(id),
    skill_id UUID REFERENCES skills(id),
    node_id UUID REFERENCES nodes(node_id),
    -- 精度对齐 db.js（微额计费）并容纳 MAX_SINGLE_AMOUNT=1e6 的单笔；见 migrations/008
    amount DECIMAL(18, 4) NOT NULL,
    type VARCHAR(50) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    idempotency_key VARCHAR(255) UNIQUE,
    operator_id UUID,
    reason VARCHAR(500),
    ip_address VARCHAR(45),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
CREATE INDEX IF NOT EXISTS idx_nodes_tags ON nodes USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_nodes_reputation ON nodes(reputation_score);
CREATE INDEX IF NOT EXISTS idx_nodes_heartbeat ON nodes(last_heartbeat) WHERE status = 'online';
CREATE INDEX IF NOT EXISTS idx_skills_node_id ON skills(node_id);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_node_id ON tasks(node_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_transactions_node_id ON transactions(node_id);
CREATE INDEX IF NOT EXISTS idx_transactions_task_id_type ON transactions(task_id, type);
CREATE INDEX IF NOT EXISTS idx_transactions_idempotency_key ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_type_status ON transactions(type, status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);

CREATE TABLE IF NOT EXISTS agent_memories (
    memory_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL DEFAULT 'interaction',
    content TEXT NOT NULL,
    related_agent_id UUID REFERENCES nodes(node_id) ON DELETE SET NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    importance DECIMAL(3, 2) DEFAULT 0.5,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_id ON agent_memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_type ON agent_memories(type);
CREATE INDEX IF NOT EXISTS idx_agent_memories_importance ON agent_memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memories_related ON agent_memories(related_agent_id) WHERE related_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_memories_created ON agent_memories(created_at DESC);

CREATE TABLE IF NOT EXISTS agent_relationships (
    relationship_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
    related_agent_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL DEFAULT 'neutral',
    interaction_count INTEGER DEFAULT 0,
    avg_rating DECIMAL(3, 2) DEFAULT 0.5,
    last_interaction_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(agent_id, related_agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_relationships_agent ON agent_relationships(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_relationships_related ON agent_relationships(related_agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_relationships_type ON agent_relationships(type);

CREATE INDEX IF NOT EXISTS idx_node_embeddings_vector
ON node_embeddings
USING hnsw (capability_vector vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS agent_messages (
    message_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sender_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
    receiver_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
    type VARCHAR(50) DEFAULT 'info',
    content TEXT NOT NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_receiver ON agent_messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_sender ON agent_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_read ON agent_messages(receiver_id, read) WHERE read = FALSE;
CREATE INDEX IF NOT EXISTS idx_agent_messages_created ON agent_messages(created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'nodes' AND column_name = 'total_earnings') THEN
    ALTER TABLE nodes ADD COLUMN total_earnings DECIMAL(16, 4) DEFAULT 0;
  END IF;
END
$$;

-- ──────────────────────────────────────────
-- Phase 5: 多币种支付 (ETH / BTC / USDT)
-- ──────────────────────────────────────────

-- 多币种钱包：每个 Agent 可绑定多种货币的地址
CREATE TABLE IF NOT EXISTS wallets (
    wallet_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    node_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
    chain VARCHAR(30) NOT NULL,                     -- ethereum / bitcoin / usdt
    address VARCHAR(255) NOT NULL,
    label VARCHAR(100),
    is_primary BOOLEAN DEFAULT FALSE,
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (node_id, chain, address)
);

CREATE INDEX IF NOT EXISTS idx_wallets_node_id ON wallets(node_id);
CREATE INDEX IF NOT EXISTS idx_wallets_chain ON wallets(chain);
CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address);

-- 链上交易记录：充值 + 提现
CREATE TABLE IF NOT EXISTS chain_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    node_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
    wallet_id UUID REFERENCES wallets(wallet_id) ON DELETE SET NULL,
    chain VARCHAR(30) NOT NULL,
    tx_hash VARCHAR(255),
    type VARCHAR(20) NOT NULL,                      -- deposit / withdrawal
    amount DECIMAL(20, 8) NOT NULL,
    currency VARCHAR(20) NOT NULL DEFAULT 'ETH',    -- ETH / MATIC / USDT / USDC / XCL
    status VARCHAR(30) DEFAULT 'pending',           -- pending / confirming / completed / failed / cancelled
    confirmations INTEGER DEFAULT 0,
    required_confirmations INTEGER DEFAULT 12,
    from_address VARCHAR(255),
    to_address VARCHAR(255),
    gas_used DECIMAL(20, 8),
    gas_price DECIMAL(30, 8),
    block_number BIGINT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chain_tx_node ON chain_transactions(node_id);
CREATE INDEX IF NOT EXISTS idx_chain_tx_chain ON chain_transactions(chain);
CREATE INDEX IF NOT EXISTS idx_chain_tx_status ON chain_transactions(status);
CREATE INDEX IF NOT EXISTS idx_chain_tx_hash ON chain_transactions(tx_hash);
CREATE INDEX IF NOT EXISTS idx_chain_tx_type ON chain_transactions(type);
CREATE INDEX IF NOT EXISTS idx_chain_tx_created ON chain_transactions(created_at DESC);

-- 支持的货币配置
CREATE TABLE IF NOT EXISTS supported_chains (
    chain_id VARCHAR(30) PRIMARY KEY,               -- ethereum / bitcoin / usdt
    name VARCHAR(100) NOT NULL,
    rpc_url VARCHAR(500),
    explorer_url VARCHAR(500),
    chain_currency VARCHAR(20) NOT NULL DEFAULT 'ETH',
    contract_address VARCHAR(255),
    decimals INTEGER DEFAULT 18,
    min_deposit DECIMAL(20, 8) DEFAULT 0.001,
    min_withdrawal DECIMAL(20, 8) DEFAULT 0.01,
    withdraw_fee DECIMAL(20, 8) DEFAULT 0.0005,
    confirmations_required INTEGER DEFAULT 12,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 初始化三种货币：ETH / BTC / USDT
INSERT INTO supported_chains (chain_id, name, explorer_url, chain_currency, decimals, min_deposit, min_withdrawal, withdraw_fee, confirmations_required)
VALUES
    ('ethereum', 'Ethereum Mainnet', 'https://etherscan.io', 'ETH', 18, 0.001, 0.01, 0.0005, 12),
    ('bitcoin',  'Bitcoin',          'https://mempool.space', 'BTC', 8, 0.0001, 0.001, 0.0001, 6),
    ('usdt',     'Tether USD (ERC-20)', 'https://etherscan.io', 'USDT', 6, 1, 10, 1, 12)
ON CONFLICT (chain_id) DO NOTHING;

-- Webhook 事件系统
-- node_id 外键与 migrations/001 对齐（缺 FK 时删节点会留孤儿 webhook）
CREATE TABLE IF NOT EXISTS webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    events TEXT[] NOT NULL,
    secret TEXT NOT NULL,
    description TEXT,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_node_id ON webhooks(node_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(active);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(30) DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 5,
    last_response_code INTEGER,
    last_error TEXT,
    next_retry_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 索引名与 migrations/001 一致，避免同名索引重复创建
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_next_retry ON webhook_deliveries(next_retry_at) WHERE status IN ('pending', 'retrying');
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(created_at DESC);

-- 事件日志（eventBus 使用）；source_id 实际写入均为实体 UUID（agent/task/order/node）
CREATE TABLE IF NOT EXISTS event_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(100) NOT NULL,
    source_id UUID,
    payload JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(event_type);
CREATE INDEX IF NOT EXISTS idx_event_log_created ON event_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_source ON event_log(source_id);

-- 计费账户
CREATE TABLE IF NOT EXISTS billing_accounts (
    node_id UUID PRIMARY KEY REFERENCES nodes(node_id) ON DELETE CASCADE,
    balance DECIMAL(16, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 市场上架
CREATE TABLE IF NOT EXISTS marketplace_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id UUID REFERENCES skills(id) ON DELETE CASCADE,
    seller_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
    price DECIMAL(10, 2) NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_seller ON marketplace_listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_skill ON marketplace_listings(skill_id);

-- 订单
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
    seller_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
    skill_id UUID REFERENCES skills(id) ON DELETE SET NULL,
    listing_id UUID REFERENCES marketplace_listings(id) ON DELETE SET NULL,
    amount DECIMAL(10, 2) NOT NULL,
    status VARCHAR(30) DEFAULT 'pending',
    payload JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- 技能评价
CREATE TABLE IF NOT EXISTS skill_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    reviewer_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(skill_id, reviewer_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_skill_reviews_skill ON skill_reviews(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_reviews_reviewer ON skill_reviews(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_skill_reviews_rating ON skill_reviews(rating);

-- 任务竞标
CREATE TABLE IF NOT EXISTS task_bids (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    bidder_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
    proposed_price DECIMAL(10, 2) NOT NULL,
    estimated_duration VARCHAR(100),
    proposal TEXT,
    status VARCHAR(30) DEFAULT 'pending',
    match_score DECIMAL(5, 2),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_bids_task ON task_bids(task_id);
CREATE INDEX IF NOT EXISTS idx_task_bids_bidder ON task_bids(bidder_id);
CREATE INDEX IF NOT EXISTS idx_task_bids_status ON task_bids(status);

-- 声誉系统
CREATE TABLE IF NOT EXISTS reputation_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    event_data JSONB DEFAULT '{}',
    score_delta DECIMAL(5, 4) DEFAULT 0,
    reason VARCHAR(500),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reputation_events_node ON reputation_events(node_id);
CREATE INDEX IF NOT EXISTS idx_reputation_events_type ON reputation_events(event_type);
CREATE INDEX IF NOT EXISTS idx_reputation_events_created ON reputation_events(created_at DESC);

CREATE TABLE IF NOT EXISTS reputation_snapshots (
    node_id UUID PRIMARY KEY REFERENCES nodes(node_id) ON DELETE CASCADE,
    score DECIMAL(5, 2) DEFAULT 50,
    level VARCHAR(20) DEFAULT 'bronze',
    total_events INTEGER DEFAULT 0,
    last_computed_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 迁移增量（backend/migrations 追加的表与列，随迁移演进）
-- ============================================================

-- 002: 事件日志 metadata / 任务市场统计
ALTER TABLE event_log ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

CREATE TABLE IF NOT EXISTS task_market_stats (
  id SERIAL PRIMARY KEY,
  total_tasks INTEGER DEFAULT 0,
  open_tasks INTEGER DEFAULT 0,
  assigned_tasks INTEGER DEFAULT 0,
  completed_tasks INTEGER DEFAULT 0,
  cancelled_tasks INTEGER DEFAULT 0,
  active_bids INTEGER DEFAULT 0,
  total_budget_min NUMERIC(16, 2) DEFAULT 0,
  total_budget_max NUMERIC(16, 2) DEFAULT 0,
  avg_budget_min NUMERIC(16, 2) DEFAULT 0,
  avg_budget_max NUMERIC(16, 2) DEFAULT 0,
  unique_caller_count INTEGER DEFAULT 0,
  unique_worker_count INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 003: 指标快照
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

-- 004: 任务托管与验收
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS escrow_amount DECIMAL(16, 2) DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS escrow_status VARCHAR(20) DEFAULT 'none';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_deadline TIMESTAMP;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) DEFAULT 'none';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result_evidence JSONB;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dispute_reason TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS resolution VARCHAR(20);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS task_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  opened_by UUID,
  reason TEXT NOT NULL,
  evidence JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'open',
  resolution VARCHAR(30),
  resolved_by UUID,
  resolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_disputes_status ON task_disputes(status);
CREATE INDEX IF NOT EXISTS idx_task_disputes_task ON task_disputes(task_id);

-- 010: 执行方保证金
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stake_amount DECIMAL(16, 2) DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stake_status VARCHAR(20) DEFAULT 'none';
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS escrow_balance DECIMAL(16, 2) NOT NULL DEFAULT 0;
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS stake_balance DECIMAL(16, 2) NOT NULL DEFAULT 0;

-- 011: sandbox 赠送额度（不可提现部分）
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS sandbox_balance DECIMAL(16, 2) NOT NULL DEFAULT 0;
