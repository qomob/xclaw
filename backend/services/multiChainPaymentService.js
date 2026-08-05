/**
 * multiChainPaymentService.js — 多币种支付服务
 *
 * 支持 ETH (Ethereum) / BTC (Bitcoin) / USDT (ERC-20) 三种货币的
 * 钱包管理、充值确认、提现处理。
 *
 * @module services/multiChainPaymentService
 */

import { getPostgres, getRedis } from '../core/dependencies.js';
import { generateUUID, formatResponse } from '../core/utils.js';
import logger from './loggerService.js';
import eventBus from './eventBus.js';
import crypto from 'crypto';

const SUPPORTED_CURRENCIES = ['ethereum', 'bitcoin', 'usdt'];
const CACHE_TTL = 60;

const CURRENCY_META = {
  ethereum: { symbol: 'ETH', label: 'Ethereum', type: 'native' },
  bitcoin:  { symbol: 'BTC', label: 'Bitcoin',  type: 'native' },
  usdt:     { symbol: 'USDT', label: 'Tether USD', type: 'token' }
};

function isValidCurrency(currency) {
  return SUPPORTED_CURRENCIES.includes(currency);
}

function isValidAddress(address, currency) {
  if (!address || typeof address !== 'string') return false;
  if (currency === 'bitcoin') {
    return /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)
      || /^bc1[a-zA-HJ-NP-Z0-9]{25,90}$/.test(address);
  }
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * 清除节点钱包缓存
 * @param {string} nodeId
 */
async function invalidateWalletCache(nodeId) {
  try {
    const redisClient = getRedis();
    await redisClient.del(`wallets:${nodeId}`);
  } catch (_) { /* ignore */ }
}

// ═════════════════════════════════════════════════════════
// 钱包管理
// ═════════════════════════════════════════════════════════

/**
 * 注册 / 绑定钱包地址
 * @param {string} nodeId  - Agent 节点 ID
 * @param {object} params
 * @param {string} params.chain    - 链名
 * @param {string} params.address  - 链上地址
 * @param {string} [params.label]  - 钱包标签
 * @returns {Promise<object>} formatResponse
 */
export async function registerWallet(nodeId, { chain, address, label } = {}) {
  if (!isValidCurrency(chain)) {
    return formatResponse(false, null, `不支持的货币: ${chain}，支持: ${SUPPORTED_CURRENCIES.join(', ')}`);
  }
  if (!isValidAddress(address, chain)) {
    return formatResponse(false, null, `无效的 ${CURRENCY_META[chain]?.symbol || chain} 地址格式`);
  }

  const pgPool = getPostgres();
  try {
    // 检查是否已绑定
    const existing = await pgPool.query(
      'SELECT wallet_id FROM wallets WHERE node_id = $1 AND chain = $2 AND address = $3',
      [nodeId, chain, address]
    );
    if (existing.rows.length > 0) {
      return formatResponse(true, { wallet_id: existing.rows[0].wallet_id, duplicate: true });
    }

    // 检查是否是该链上的第一个钱包（自动设为主钱包）
    const countResult = await pgPool.query(
      'SELECT COUNT(*) as cnt FROM wallets WHERE node_id = $1 AND chain = $2',
      [nodeId, chain]
    );
    const isPrimary = parseInt(countResult.rows[0].cnt) === 0;

    const walletId = generateUUID(`wallet:${Date.now()}`);
    await pgPool.query(
      `INSERT INTO wallets (wallet_id, node_id, chain, address, label, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [walletId, nodeId, chain, address, label || null, isPrimary]
    );

    await invalidateWalletCache(nodeId);
    logger.info('Wallet registered', { nodeId, chain, address, walletId });

    return formatResponse(true, {
      wallet_id: walletId,
      chain,
      address,
      is_primary: isPrimary
    });
  } catch (error) {
    if (error.code === '23505') {
      return formatResponse(false, null, '该地址已绑定');
    }
    logger.error('Register wallet failed', { error: error.message, nodeId });
    return formatResponse(false, null, '注册钱包失败');
  }
}

/**
 * 获取节点的所有钱包
 * @param {string} nodeId
 * @param {object} [filters]
 * @param {string} [filters.chain] - 按链过滤
 * @returns {Promise<object>}
 */
export async function getWallets(nodeId, filters = {}) {
  const pgPool = getPostgres();
  try {
    let sql = 'SELECT wallet_id, chain, address, label, is_primary, verified_at, created_at FROM wallets WHERE node_id = $1';
    const params = [nodeId];

    if (filters.chain) {
      sql += ` AND chain = $${params.length + 1}`;
      params.push(filters.chain);
    }

    sql += ' ORDER BY is_primary DESC, created_at ASC';

    const result = await pgPool.query(sql, params);

    // 按 chain 分组
    const grouped = {};
    for (const row of result.rows) {
      if (!grouped[row.chain]) grouped[row.chain] = [];
      grouped[row.chain].push({
        wallet_id: row.wallet_id,
        address: row.address,
        label: row.label,
        is_primary: row.is_primary,
        verified_at: row.verified_at,
        created_at: row.created_at
      });
    }

    return formatResponse(true, {
      total: result.rows.length,
      chains: Object.keys(grouped).length,
      wallets: grouped
    });
  } catch (error) {
    logger.error('Get wallets failed', { error: error.message, nodeId });
    return formatResponse(false, null, '获取钱包列表失败');
  }
}

/**
 * 设为主钱包
 * @param {string} nodeId
 * @param {string} walletId
 * @returns {Promise<object>}
 */
export async function setPrimaryWallet(nodeId, walletId) {
  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    // 获取目标钱包的链
    const target = await client.query(
      'SELECT chain FROM wallets WHERE wallet_id = $1 AND node_id = $2',
      [walletId, nodeId]
    );
    if (target.rows.length === 0) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, '钱包不存在');
    }
    const chain = target.rows[0].chain;

    // 取消同链其他主钱包
    await client.query(
      'UPDATE wallets SET is_primary = FALSE WHERE node_id = $1 AND chain = $2 AND is_primary = TRUE',
      [nodeId, chain]
    );

    // 设为主钱包
    await client.query(
      'UPDATE wallets SET is_primary = TRUE, updated_at = NOW() WHERE wallet_id = $1',
      [walletId]
    );

    await client.query('COMMIT');
    await invalidateWalletCache(nodeId);

    return formatResponse(true, { wallet_id: walletId, chain, is_primary: true });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Set primary wallet failed', { error: error.message, nodeId, walletId });
    return formatResponse(false, null, '设置主钱包失败');
  } finally {
    client.release();
  }
}

/**
 * 删除钱包
 * @param {string} nodeId
 * @param {string} walletId
 * @returns {Promise<object>}
 */
export async function removeWallet(nodeId, walletId) {
  const pgPool = getPostgres();
  try {
    const result = await pgPool.query(
      'DELETE FROM wallets WHERE wallet_id = $1 AND node_id = $2 RETURNING chain',
      [walletId, nodeId]
    );
    if (result.rows.length === 0) {
      return formatResponse(false, null, '钱包不存在');
    }

    await invalidateWalletCache(nodeId);
    logger.info('Wallet removed', { nodeId, walletId, chain: result.rows[0].chain });
    return formatResponse(true, { wallet_id: walletId, removed: true });
  } catch (error) {
    logger.error('Remove wallet failed', { error: error.message, nodeId, walletId });
    return formatResponse(false, null, '删除钱包失败');
  }
}

// ═════════════════════════════════════════════════════════
// 充值（Deposit）
// ═════════════════════════════════════════════════════════

/**
 * 创建充值记录（用户发起链上转账后调用）
 * @param {string} nodeId
 * @param {object} params
 * @param {string} params.chain
 * @param {string} params.tx_hash
 * @param {number} params.amount
 * @param {string} [params.currency]
 * @param {string} [params.from_address]
 * @param {string} [params.to_address]
 * @returns {Promise<object>}
 */
export async function createDeposit(nodeId, { chain, tx_hash, amount, currency, from_address, to_address } = {}) {
  if (!isValidCurrency(chain)) {
    return formatResponse(false, null, `不支持的货币: ${chain}`);
  }
  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    return formatResponse(false, null, '充值金额必须为正数');
  }
  if (!tx_hash) {
    return formatResponse(false, null, '缺少交易哈希');
  }

  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    // 幂等检查
    const existing = await client.query(
      'SELECT id, status FROM chain_transactions WHERE tx_hash = $1 AND chain = $2',
      [tx_hash, chain]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return formatResponse(true, {
        id: existing.rows[0].id,
        status: existing.rows[0].status,
        duplicate: true
      });
    }

    // 获取链配置
    const chainConfig = await client.query(
      'SELECT min_deposit, confirmations_required FROM supported_chains WHERE chain_id = $1 AND is_active = TRUE',
      [chain]
    );
    if (chainConfig.rows.length === 0) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, `货币 ${chain} 未启用`);
    }

    if (numAmount < parseFloat(chainConfig.rows[0].min_deposit)) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, `充值金额低于最低限额 ${chainConfig.rows[0].min_deposit}`);
    }

    // 查找匹配的钱包
    const walletResult = await client.query(
      'SELECT wallet_id FROM wallets WHERE node_id = $1 AND chain = $2 AND address = $3',
      [nodeId, chain, to_address || '']
    );

    const txId = generateUUID(`deposit:${Date.now()}`);
    await client.query(
      `INSERT INTO chain_transactions
        (id, node_id, wallet_id, chain, tx_hash, type, amount, currency, status,
         confirmations, required_confirmations, from_address, to_address)
       VALUES ($1, $2, $3, $4, $5, 'deposit', $6, $7, 'pending',
         0, $8, $9, $10)`,
      [
        txId, nodeId,
        walletResult.rows.length > 0 ? walletResult.rows[0].wallet_id : null,
        chain, tx_hash, numAmount,
        currency || CURRENCY_META[chain]?.symbol || 'ETH',
        chainConfig.rows[0].confirmations_required,
        from_address || null,
        to_address || null
      ]
    );

    await client.query('COMMIT');

    logger.info('Deposit created', { nodeId, chain, tx_hash, amount: numAmount });
    eventBus.emit('payment.deposit', { node_id: nodeId, chain, amount: numAmount, tx_id: txId }, { sourceId: nodeId });

    return formatResponse(true, {
      id: txId,
      chain,
      tx_hash,
      amount: numAmount,
      currency: currency || CURRENCY_META[chain]?.symbol || 'ETH',
      status: 'pending'
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Create deposit failed', { error: error.message, nodeId });
    return formatResponse(false, null, '创建充值记录失败');
  } finally {
    client.release();
  }
}

// ═════════════════════════════════════════════════════════
// 提现（Withdrawal）
// ═════════════════════════════════════════════════════════

/**
 * 发起提现请求
 * @param {string} nodeId
 * @param {object} params
 * @param {string} params.chain
 * @param {string} params.to_address - 目标地址
 * @param {number} params.amount
 * @param {string} [params.currency]
 * @returns {Promise<object>}
 */
export async function createWithdrawal(nodeId, { chain, to_address, amount, currency } = {}) {
  if (!isValidCurrency(chain)) {
    return formatResponse(false, null, `不支持的货币: ${chain}`);
  }
  if (!isValidAddress(to_address, chain)) {
    return formatResponse(false, null, `无效的 ${CURRENCY_META[chain]?.symbol || chain} 目标地址`);
  }
  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    return formatResponse(false, null, '提现金额必须为正数');
  }

  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    // 获取链配置
    const chainConfig = await client.query(
      'SELECT min_withdrawal, withdraw_fee, confirmations_required FROM supported_chains WHERE chain_id = $1 AND is_active = TRUE',
      [chain]
    );
    if (chainConfig.rows.length === 0) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, `货币 ${chain} 未启用`);
    }

    const minWithdrawal = parseFloat(chainConfig.rows[0].min_withdrawal);
    const fee = parseFloat(chainConfig.rows[0].withdraw_fee);

    if (numAmount < minWithdrawal) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, `提现金额低于最低限额 ${minWithdrawal}`);
    }

    // 从统一账本（billing_accounts）原子扣款
    const { debitAccount } = await import('../billing/index.js');
    const debit = await debitAccount(client, nodeId, numAmount + fee);
    if (!debit.ok) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, '余额不足');
    }

    // 获取主钱包地址作为 from_address
    const walletResult = await client.query(
      'SELECT wallet_id, address FROM wallets WHERE node_id = $1 AND chain = $2 AND is_primary = TRUE LIMIT 1',
      [nodeId, chain]
    );

    const txId = generateUUID(`withdrawal:${Date.now()}`);
    await client.query(
      `INSERT INTO chain_transactions
        (id, node_id, wallet_id, chain, type, amount, currency, status,
         required_confirmations, from_address, to_address, metadata)
       VALUES ($1, $2, $3, $4, 'withdrawal', $5, $6, 'pending',
         $7, $8, $9, $10)`,
      [
        txId, nodeId,
        walletResult.rows.length > 0 ? walletResult.rows[0].wallet_id : null,
        chain, numAmount,
        currency || CURRENCY_META[chain]?.symbol || 'ETH',
        chainConfig.rows[0].confirmations_required,
        walletResult.rows.length > 0 ? walletResult.rows[0].address : null,
        to_address,
        JSON.stringify({ fee, net_amount: numAmount })
      ]
    );

    // 记录手续费交易
    if (fee > 0) {
      const feeTxId = generateUUID(`fee:${Date.now()}`);
      await client.query(
        `INSERT INTO transactions (id, node_id, amount, type, status, reason, metadata)
         VALUES ($1, $2, $3, 'withdrawal_fee', 'completed', 'withdrawal fee', $4)`,
        [feeTxId, nodeId, -fee, JSON.stringify({ chain, withdrawal_id: txId })]
      );
    }

    await client.query('COMMIT');

    // 清缓存
    try {
      const redisClient = getRedis();
      await redisClient.del(`node:${nodeId}:balance`);
    } catch (_) {}

    logger.info('Withdrawal created', { nodeId, chain, amount: numAmount, fee, txId });
    eventBus.emit('payment.withdrawal', { node_id: nodeId, chain, amount: numAmount, fee, tx_id: txId }, { sourceId: nodeId });

    return formatResponse(true, {
      id: txId,
      chain,
      amount: numAmount,
      fee,
      net_amount: numAmount,
      currency: currency || CURRENCY_META[chain]?.symbol || 'ETH',
      to_address,
      status: 'pending'
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Create withdrawal failed', { error: error.message, nodeId });
    return formatResponse(false, null, '发起提现失败');
  } finally {
    client.release();
  }
}

/**
 * 管理员确认充值入账（线下核验链上交易后调用）
 * 将 pending 充值转为 completed 并入账 billing_accounts
 */
export async function confirmDeposit(txId, adminNote = null) {
  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const res = await client.query(
      `SELECT * FROM chain_transactions
        WHERE id = $1 AND type = 'deposit' AND status = 'pending'
        FOR UPDATE`,
      [txId]
    );
    if (res.rows.length === 0) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, '充值记录不存在或已处理');
    }

    const tx = res.rows[0];
    const amount = parseFloat(tx.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, '充值金额异常');
    }

    const { creditAccount } = await import('../billing/index.js');
    const newBalance = await creditAccount(client, tx.node_id, amount);

    await client.query(
      `UPDATE chain_transactions
          SET status = 'completed',
              confirmations = required_confirmations,
              metadata = metadata || $2::jsonb,
              updated_at = NOW()
        WHERE id = $1`,
      [txId, JSON.stringify({ confirmed_by: 'admin', note: adminNote, confirmed_at: new Date().toISOString() })]
    );

    await client.query('COMMIT');

    try {
      const redisClient = getRedis();
      await redisClient.del(`node:${tx.node_id}:balance`);
    } catch (_) {}

    logger.info('Deposit confirmed', { txId, nodeId: tx.node_id, amount, newBalance });
    eventBus.emit('payment.deposit_confirmed', { node_id: tx.node_id, amount, tx_id: txId }, { sourceId: tx.node_id });

    return formatResponse(true, {
      id: txId,
      node_id: tx.node_id,
      amount,
      status: 'completed',
      new_balance: newBalance
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Confirm deposit failed', { error: error.message, txId });
    return formatResponse(false, null, '确认充值失败');
  } finally {
    client.release();
  }
}

/**
 * 管理员更新提现状态：completed（链上已打款）或 failed（失败退款）
 */
export async function updateWithdrawalStatus(txId, newStatus, adminNote = null) {
  if (!['completed', 'failed'].includes(newStatus)) {
    return formatResponse(false, null, '状态必须是 completed 或 failed');
  }

  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const res = await client.query(
      `SELECT * FROM chain_transactions
        WHERE id = $1 AND type = 'withdrawal' AND status = 'pending'
        FOR UPDATE`,
      [txId]
    );
    if (res.rows.length === 0) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, '提现记录不存在或已处理');
    }

    const tx = res.rows[0];
    const metadata = JSON.parse(tx.metadata || '{}');
    const amount = parseFloat(tx.amount);
    const fee = parseFloat(metadata.fee) || 0;

    if (newStatus === 'failed') {
      // 退款：本金 + 手续费退回账本
      const { creditAccount } = await import('../billing/index.js');
      const refund = parseFloat((amount + fee).toFixed(2));
      const newBalance = await creditAccount(client, tx.node_id, refund);
      await client.query(
        `INSERT INTO transactions (id, node_id, amount, type, status, reason, metadata)
         VALUES ($1, $2, $3, 'withdrawal_refund', 'completed', $4, $5)`,
        [crypto.randomUUID(), tx.node_id, refund, 'withdrawal failed refund', JSON.stringify({ withdrawal_id: txId })]
      );
      logger.info('Withdrawal refunded', { txId, nodeId: tx.node_id, refund, newBalance });
    }

    await client.query(
      `UPDATE chain_transactions
          SET status = $2,
              metadata = metadata || $3::jsonb,
              updated_at = NOW()
        WHERE id = $1`,
      [txId, newStatus, JSON.stringify({ settled_by: 'admin', note: adminNote, settled_at: new Date().toISOString() })]
    );

    await client.query('COMMIT');

    try {
      const redisClient = getRedis();
      await redisClient.del(`node:${tx.node_id}:balance`);
    } catch (_) {}

    logger.info('Withdrawal status updated', { txId, newStatus, nodeId: tx.node_id });
    return formatResponse(true, { id: txId, status: newStatus });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Update withdrawal status failed', { error: error.message, txId });
    return formatResponse(false, null, '更新提现状态失败');
  } finally {
    client.release();
  }
}

// ═════════════════════════════════════════════════════════
// 查询
// ═════════════════════════════════════════════════════════

/**
 * 获取链上交易记录
 * @param {string} nodeId
 * @param {object} [filters]
 * @returns {Promise<object>}
 */
export async function getChainTransactions(nodeId, filters = {}) {
  const pgPool = getPostgres();
  try {
    let sql = `SELECT id, chain, tx_hash, type, amount, currency, status,
                      confirmations, required_confirmations, from_address, to_address,
                      gas_used, gas_price, block_number, metadata, created_at, updated_at
               FROM chain_transactions WHERE node_id = $1`;
    const params = [nodeId];

    if (filters.chain) {
      sql += ` AND chain = $${params.length + 1}`;
      params.push(filters.chain);
    }
    if (filters.type) {
      sql += ` AND type = $${params.length + 1}`;
      params.push(filters.type);
    }
    if (filters.status) {
      sql += ` AND status = $${params.length + 1}`;
      params.push(filters.status);
    }

    sql += ' ORDER BY created_at DESC';

    const limit = Math.min(Math.max(parseInt(filters.limit) || 50, 1), 200);
    params.push(limit);
    sql += ` LIMIT $${params.length}`;

    const offset = Math.max(parseInt(filters.offset) || 0, 0);
    if (offset > 0) {
      params.push(offset);
      sql += ` OFFSET $${params.length}`;
    }

    const result = await pgPool.query(sql, params);

    // 统计
    const stats = await pgPool.query(
      `SELECT type, status, COUNT(*) as count, COALESCE(SUM(amount), 0) as total
       FROM chain_transactions WHERE node_id = $1
       GROUP BY type, status`,
      [nodeId]
    );

    return formatResponse(true, {
      total: result.rows.length,
      transactions: result.rows,
      summary: stats.rows
    });
  } catch (error) {
    logger.error('Get chain transactions failed', { error: error.message, nodeId });
    return formatResponse(false, null, '获取链上交易记录失败');
  }
}

/**
 * 获取支持的链列表
 * @returns {Promise<object>}
 */
export async function getSupportedChains() {
  const pgPool = getPostgres();
  try {
    const result = await pgPool.query(
      `SELECT chain_id, name, chain_currency, decimals,
              min_deposit, min_withdrawal, withdraw_fee,
              confirmations_required, is_active, explorer_url
       FROM supported_chains ORDER BY name`
    );
    const chains = result.rows.map(row => ({
      ...row,
      symbol: CURRENCY_META[row.chain_id]?.symbol || row.chain_currency,
      type: CURRENCY_META[row.chain_id]?.type || 'native'
    }));
    return formatResponse(true, {
      total: chains.length,
      chains
    });
  } catch (error) {
    logger.error('Get supported chains failed', { error: error.message });
    return formatResponse(false, null, '获取支持的货币列表失败');
  }
}

/**
 * 获取多链支付总览（管理后台用）
 * @returns {Promise<object>}
 */
export async function getPaymentOverview() {
  const pgPool = getPostgres();
  try {
    const [volumeResult, chainBreakdown, statusBreakdown] = await Promise.all([
      pgPool.query(
        `SELECT
           COUNT(*) as total_transactions,
           COALESCE(SUM(amount), 0) as total_volume,
           COALESCE(SUM(amount) FILTER (WHERE type = 'deposit'), 0) as total_deposits,
           COALESCE(SUM(amount) FILTER (WHERE type = 'withdrawal'), 0) as total_withdrawals
         FROM chain_transactions`
      ),
      pgPool.query(
        `SELECT chain, type, COUNT(*) as count, COALESCE(SUM(amount), 0) as total
         FROM chain_transactions
         GROUP BY chain, type
         ORDER BY chain, type`
      ),
      pgPool.query(
        `SELECT status, COUNT(*) as count
         FROM chain_transactions
         GROUP BY status`
      )
    ]);

    const walletCount = await pgPool.query('SELECT COUNT(*) as total FROM wallets');

    return formatResponse(true, {
      total_transactions: parseInt(volumeResult.rows[0].total_transactions),
      total_volume: parseFloat(volumeResult.rows[0].total_volume),
      total_deposits: parseFloat(volumeResult.rows[0].total_deposits),
      total_withdrawals: parseFloat(volumeResult.rows[0].total_withdrawals),
      total_wallets: parseInt(walletCount.rows[0].total),
      by_chain: chainBreakdown.rows,
      by_status: statusBreakdown.rows
    });
  } catch (error) {
    logger.error('Get payment overview failed', { error: error.message });
    return formatResponse(false, null, '获取支付总览失败');
  }
}
