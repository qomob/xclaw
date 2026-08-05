-- ============================================
-- 002_schema_harmonization
-- 修复代码与 schema.sql 的漂移：补齐缺失列/表/索引
-- 全部幂等，可安全重复执行
-- ============================================

-- 自包含：若 schema.sql 未被执行（如本地开发直接跑后端），先补建基础表
CREATE TABLE IF NOT EXISTS marketplace_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID REFERENCES skills(id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  price DECIMAL(10, 2) NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID,
  buyer_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  skill_id UUID REFERENCES skills(id) ON DELETE SET NULL,
  listing_id UUID REFERENCES marketplace_listings(id) ON DELETE SET NULL,
  amount DECIMAL(10, 2) NOT NULL,
  commission DECIMAL(10, 2) DEFAULT 0,
  task_id UUID,
  result JSONB,
  completed_at TIMESTAMP,
  status VARCHAR(30) DEFAULT 'pending',
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skill_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  weighted_rating DECIMAL(5, 2) DEFAULT 0,
  comment TEXT,
  order_id UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS reputation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  event_type VARCHAR(100) NOT NULL,
  event_data JSONB DEFAULT '{}',
  impact NUMERIC(5, 4) DEFAULT 0,
  processed BOOLEAN DEFAULT FALSE,
  score_delta DECIMAL(5, 4) DEFAULT 0,
  reason VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing_accounts (
  node_id UUID PRIMARY KEY REFERENCES nodes(node_id) ON DELETE CASCADE,
  balance DECIMAL(16, 2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallets (
  wallet_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  chain VARCHAR(30) NOT NULL,
  address VARCHAR(255) NOT NULL,
  label VARCHAR(100),
  is_primary BOOLEAN DEFAULT FALSE,
  verified_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (node_id, chain, address)
);

CREATE TABLE IF NOT EXISTS supported_chains (
  chain_id VARCHAR(30) PRIMARY KEY,
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

INSERT INTO supported_chains (chain_id, name, explorer_url, chain_currency, decimals, min_deposit, min_withdrawal, withdraw_fee, confirmations_required)
VALUES
  ('ethereum', 'Ethereum Mainnet', 'https://etherscan.io', 'ETH', 18, 0.001, 0.01, 0.0005, 12),
  ('bitcoin',  'Bitcoin',          'https://mempool.space', 'BTC', 8, 0.0001, 0.001, 0.0001, 6),
  ('usdt',     'Tether USD (ERC-20)', 'https://etherscan.io', 'USDT', 6, 1, 10, 1, 12)
ON CONFLICT (chain_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS chain_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  wallet_id UUID REFERENCES wallets(wallet_id) ON DELETE SET NULL,
  chain VARCHAR(30) NOT NULL,
  tx_hash VARCHAR(255),
  type VARCHAR(20) NOT NULL,
  amount DECIMAL(20, 8) NOT NULL,
  currency VARCHAR(20) NOT NULL DEFAULT 'ETH',
  status VARCHAR(30) DEFAULT 'pending',
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

-- agent_messages.encrypted（agentMessageService 写入）
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS encrypted BOOLEAN DEFAULT FALSE;

-- skill_reviews.weighted_rating + 两列唯一约束（reviewService ON CONFLICT 依赖）
ALTER TABLE skill_reviews ADD COLUMN IF NOT EXISTS weighted_rating DECIMAL(5, 2) DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_reviews_skill_reviewer ON skill_reviews(skill_id, reviewer_id);

-- skills：市场/统计/MCP 列（marketplaceService / reviewService / mcpService）
ALTER TABLE skills ADD COLUMN IF NOT EXISTS price DECIMAL(10, 2) DEFAULT 0;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS is_listed BOOLEAN DEFAULT FALSE;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS avg_rating DECIMAL(3, 2) DEFAULT 0;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS sales_count INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS total_revenue DECIMAL(16, 2) DEFAULT 0;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT FALSE;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS input_schema JSONB DEFAULT '{}';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS output_schema JSONB DEFAULT '{}';

-- tasks：核心路由与任务市场列（taskRouter / taskMarketService / federationService）
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS caller_id UUID REFERENCES nodes(node_id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title VARCHAR(255);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 5;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS min_reputation DECIMAL(5, 2) DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS bid_deadline TIMESTAMP;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget_min DECIMAL(10, 2) DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget_max DECIMAL(10, 2) DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline TIMESTAMP;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignment_strategy VARCHAR(20) DEFAULT 'auto';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS required_skills JSONB DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result JSONB;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;

-- nodes：拓扑引擎 / 任务匹配列
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS source_url VARCHAR(500);
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS skills JSONB DEFAULT '[]';

-- orders：市场订单列（marketplaceService placeOrder / completeOrder）
ALTER TABLE orders ADD COLUMN IF NOT EXISTS commission DECIMAL(10, 2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS task_id UUID;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS result JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;

-- reputation_events：统一为事件驱动结构（reputationService 依赖 impact/processed）
ALTER TABLE reputation_events ADD COLUMN IF NOT EXISTS impact NUMERIC(5, 4) DEFAULT 0;
ALTER TABLE reputation_events ADD COLUMN IF NOT EXISTS processed BOOLEAN DEFAULT FALSE;

-- task_market_stats：任务市场统计（federationService / getMarketStats 读取）
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

-- 性能监控（performanceService 查询 pg_stat_statements）
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 索引：任务市场常用过滤
CREATE INDEX IF NOT EXISTS idx_tasks_caller_id ON tasks(caller_id) WHERE caller_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority DESC) WHERE status IN ('open', 'pending');
CREATE INDEX IF NOT EXISTS idx_orders_buyer_status ON orders(buyer_id, status);
