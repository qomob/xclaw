// 可插拔提现执行器：对接外部链上广播/签名服务
//
// 设计：
// - 未配置 WITHDRAWAL_EXECUTOR_URL 时进入 dry-run：标记 awaiting_execution=manual，
//   由人工打款后调用管理员状态流转（不伪造真实广播）
// - 配置后：把 pending 提现派发给外部服务（HMAC 签名 + 幂等键），外部服务回调
//   POST /v1/payment/withdrawals/:tx_id/callback（HMAC 验签）自动完成或失败退款
import crypto from 'crypto';
import { getPostgres } from '../core/dependencies.js';
import { safeFetch } from '../core/httpGuard.js';
import logger from './loggerService.js';

const EXECUTOR_URL = process.env.WITHDRAWAL_EXECUTOR_URL || '';
const EXECUTOR_SECRET = process.env.WITHDRAWAL_EXECUTOR_SECRET || '';
const CALLBACK_SECRET = process.env.WITHDRAWAL_CALLBACK_SECRET || EXECUTOR_SECRET;
const EXECUTOR_TIMEOUT_MS = parseInt(process.env.WITHDRAWAL_EXECUTOR_TIMEOUT || '30000', 10);

export function isExecutorConfigured() {
  return Boolean(EXECUTOR_URL && EXECUTOR_SECRET);
}

/** HMAC-SHA256 签名（原始字节验签用） */
export function buildHmac(payload, secret) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** 回调签名验证（恒定时间比较，长度不等直接拒绝） */
export function verifyCallbackSignature(rawBody, signature) {
  if (!signature || !CALLBACK_SECRET) return false;
  const expected = buildHmac(rawBody, CALLBACK_SECRET);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function updateMetadata(withdrawalId, patch) {
  const pool = getPostgres();
  await pool.query(
    `UPDATE chain_transactions SET metadata = metadata || $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [withdrawalId, JSON.stringify(patch)]
  );
}

/**
 * 派发单笔提现到外部执行器
 * @returns {{success: boolean, status: 'executing'|'pending'|'manual', reference?: string, error?: string, note?: string}}
 */
export async function dispatchWithdrawal(withdrawal) {
  if (!isExecutorConfigured()) {
    // dry-run：不广播，仅提示人工执行
    await updateMetadata(withdrawal.id, {
      awaiting_execution: 'manual',
      note: '未配置 WITHDRAWAL_EXECUTOR_URL，需人工打款后调用管理员状态流转',
    });
    return {
      success: true,
      status: 'manual',
      note: '未配置执行器，需人工打款（dry-run）',
    };
  }

  const payload = {
    withdrawal_id: withdrawal.id,
    chain: withdrawal.chain,
    to_address: withdrawal.to_address,
    from_address: withdrawal.from_address || null,
    amount: withdrawal.amount,
    currency: withdrawal.currency,
    idempotency_key: `withdrawal_exec:${withdrawal.id}`,
    nonce: crypto.randomBytes(8).toString('hex'),
    timestamp: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);
  const signature = buildHmac(body, EXECUTOR_SECRET);

  try {
    const resp = await safeFetch(EXECUTOR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-XClaw-Signature': `sha256=${signature}`,
        'X-Idempotency-Key': payload.idempotency_key,
      },
      body,
    }, EXECUTOR_TIMEOUT_MS);

    const data = await resp.json().catch(() => ({}));
    if (resp.ok && (data.accepted === true || data.status === 'accepted')) {
      await updateMetadata(withdrawal.id, {
        executor_reference: data.reference || null,
        dispatched_at: new Date().toISOString(),
        awaiting_execution: false,
      });
      const pool = getPostgres();
      await pool.query(
        `UPDATE chain_transactions SET status = 'executing', updated_at = NOW() WHERE id = $1`,
        [withdrawal.id]
      );
      return { success: true, status: 'executing', reference: data.reference || null };
    }
    logger.warn('[WithdrawalExecutor] Executor rejected', { withdrawalId: withdrawal.id, status: resp.status, data });
    return { success: false, status: 'pending', error: data.error || `Executor HTTP ${resp.status}` };
  } catch (err) {
    logger.error('[WithdrawalExecutor] Dispatch failed', { withdrawalId: withdrawal.id, error: err.message });
    return { success: false, status: 'pending', error: err.message };
  }
}

/**
 * 批量处理待执行提现（管理员/运维触发）
 */
export async function processPendingWithdrawals({ limit = 20 } = {}) {
  const pool = getPostgres();
  const { rows } = await pool.query(
    `SELECT id, node_id, chain, amount, currency, to_address, from_address, status, metadata
     FROM chain_transactions
     WHERE type = 'withdrawal' AND status = 'pending'
     ORDER BY created_at ASC
     LIMIT $1`,
    [Math.min(Math.max(parseInt(limit) || 20, 1), 100)]
  );

  const results = [];
  for (const w of rows) {
    const r = await dispatchWithdrawal(w);
    results.push({ withdrawal_id: w.id, ...r });
  }
  return results;
}

/**
 * 外部执行器回调：completed（打款成功）或 failed（失败自动退款）
 * 幂等：仅 executing 状态可处理；重复回调返回当前状态
 */
export async function handleWithdrawalCallback(txId, { status, tx_hash, error } = {}) {
  if (!['completed', 'failed'].includes(status)) {
    return { success: false, error: 'status 必须是 completed 或 failed' };
  }

  const pgPool = getPostgres();
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    const res = await client.query(
      `SELECT * FROM chain_transactions
        WHERE id = $1 AND type = 'withdrawal' AND status = 'executing'
        FOR UPDATE`,
      [txId]
    );
    if (!res.rows.length) {
      await client.query('ROLLBACK');
      const existing = await pgPool.query(
        'SELECT status FROM chain_transactions WHERE id = $1',
        [txId]
      );
      return { success: false, error: '回调状态不匹配或已处理', current: existing.rows[0]?.status || null };
    }

    const tx = res.rows[0];
    if (status === 'completed') {
      await client.query(
        `UPDATE chain_transactions
            SET status = 'completed',
                tx_hash = COALESCE($2, tx_hash),
                metadata = metadata || $3::jsonb,
                updated_at = NOW()
          WHERE id = $1`,
        [txId, tx_hash || null, JSON.stringify({ completed_by: 'executor', completed_at: new Date().toISOString() })]
      );
    } else {
      // 失败：自动退款（本金 + 手续费）
      const metadata = typeof tx.metadata === 'string' ? JSON.parse(tx.metadata) : (tx.metadata || {});
      const fee = parseFloat(metadata.fee) || 0;
      const refund = parseFloat((parseFloat(tx.amount) + fee).toFixed(2));
      const { creditAccount } = await import('../billing/index.js');
      await creditAccount(client, tx.node_id, refund);
      await client.query(
        `INSERT INTO transactions (id, node_id, amount, type, status, reason, metadata)
         VALUES ($1, $2, $3, 'withdrawal_refund', 'completed', $4, $5)`,
        [crypto.randomUUID(), tx.node_id, refund, 'withdrawal executor failed refund', JSON.stringify({ withdrawal_id: txId })]
      );
      await client.query(
        `UPDATE chain_transactions
            SET status = 'failed',
                metadata = metadata || $3::jsonb,
                updated_at = NOW()
          WHERE id = $1`,
        [txId, null, JSON.stringify({ completed_by: 'executor', failure: error || null, failed_at: new Date().toISOString() })]
      );
    }

    await client.query('COMMIT');

    const { invalidateBalanceCache } = await import('../billing/index.js');
    await invalidateBalanceCache(tx.node_id);

    logger.info('[WithdrawalExecutor] Callback processed', { withdrawalId: txId, status });
    return { success: true, withdrawal_id: txId, status };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('[WithdrawalExecutor] Callback failed', { withdrawalId: txId, error: err.message });
    return { success: false, error: err.message };
  } finally {
    client.release();
  }
}
