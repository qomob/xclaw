-- 007: 多币种货币模型 (ETH / BTC / USDT)
-- 背景：multiChainPaymentService 已使用 SUPPORTED_CURRENCIES=['ethereum','bitcoin','usdt'] 并依赖 decimals 列，
--       但 database/schema.sql 的种子数据仅在数据库首次初始化时执行，存量库需此迁移补齐：
--         1) bitcoin / usdt 行缺失 → 充值/提现查询 "chain_id=$1 AND is_active=TRUE" 会返回"货币未启用"；
--         2) 旧链 polygon/arbitrum/optimism 仍为 active，与 SUPPORTED_CURRENCIES 不一致。
-- 幂等：可安全重复执行（无 updated_at 列，勿引用）。

-- 1. 为 supported_chains 补 decimals 列（服务端金额换算依赖；若已存在则跳过）
ALTER TABLE supported_chains ADD COLUMN IF NOT EXISTS decimals INTEGER DEFAULT 18;

-- 2. 更新/插入三种货币（DO UPDATE 保证存量 ethereum 行补全 decimals；bitcoin/usdt 不存在则插入）
INSERT INTO supported_chains (chain_id, name, explorer_url, chain_currency, decimals, min_deposit, min_withdrawal, withdraw_fee, confirmations_required)
VALUES
    ('ethereum', 'Ethereum Mainnet', 'https://etherscan.io', 'ETH', 18, 0.001, 0.01, 0.0005, 12),
    ('bitcoin',  'Bitcoin',          'https://mempool.space', 'BTC', 8, 0.0001, 0.001, 0.0001, 6),
    ('usdt',     'Tether USD (ERC-20)', 'https://etherscan.io', 'USDT', 6, 1, 10, 1, 12)
ON CONFLICT (chain_id) DO UPDATE SET
    decimals = EXCLUDED.decimals,
    name = EXCLUDED.name,
    chain_currency = EXCLUDED.chain_currency,
    is_active = TRUE;

-- 3. 停用旧链 polygon/arbitrum/optimism（保留历史数据，但不再被 is_active = TRUE 的充提查询选中）
UPDATE supported_chains SET is_active = FALSE
WHERE chain_id IN ('polygon', 'arbitrum', 'optimism');
