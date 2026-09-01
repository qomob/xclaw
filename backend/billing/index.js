import crypto from 'crypto';
import { getPostgres, getRedis } from '../core/dependencies.js';
import { formatResponse } from '../core/utils.js';
import logger from '../services/loggerService.js';
import eventBus from '../services/eventBus.js';

const COMMISSION_RATE = parseFloat(process.env.COMMISSION_RATE || '0.2');
const MIN_BALANCE = parseFloat(process.env.MIN_BALANCE || '0');
const TASK_BASE_PRICE = parseFloat(process.env.TASK_BASE_PRICE || '0.01');
const MAX_SINGLE_AMOUNT = parseFloat(process.env.MAX_SINGLE_AMOUNT || '1000000');
const BALANCE_CACHE_TTL = parseInt(process.env.BALANCE_CACHE_TTL || '30');

// ── Sandbox 注册额度（自助首笔交易闭环：新 Agent 免管理员即可完成首笔付费调用）──
const SANDBOX_GRANT_ENABLED = process.env.SANDBOX_GRANT_ENABLED !== 'false';
const SANDBOX_GRANT_AMOUNT = Math.round((parseFloat(process.env.SANDBOX_GRANT_AMOUNT) || 10) * 100) / 100;
const SANDBOX_GRANT_IP_DAILY_LIMIT = parseInt(process.env.SANDBOX_GRANT_IP_DAILY_LIMIT) || 3;

function validateAmount(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num) || num <= 0) {
    return { valid: false, error: '金额必须为正数' };
  }
  if (num > MAX_SINGLE_AMOUNT) {
    return { valid: false, error: `单笔金额不能超过 ${MAX_SINGLE_AMOUNT}` };
  }
  const rounded = Math.round(num * 100) / 100;
  return { valid: true, amount: rounded };
}

export async function invalidateBalanceCache(nodeId) {
  if (!nodeId) return;
  try {
    const redisClient = getRedis();
    await redisClient.del(`node:${nodeId}:balance`);
  } catch (_) {}
}

/**
 * 确保账本账户存在（幂等）
 * @param {object} q - pg Pool 或 Client
 * @param {string} nodeId
 */
export async function ensureBillingAccount(q, nodeId) {
  await q.query(
    `INSERT INTO billing_accounts (node_id, balance)
     VALUES ($1, 0)
     ON CONFLICT (node_id) DO NOTHING`,
    [nodeId]
  );
}

/**
 * 在给定连接（或连接池）上原子扣款；余额不足时返回 { ok: false }
 * 调用方需自行管理事务
 */
export async function debitAccount(q, nodeId, amount, minBalance = MIN_BALANCE) {
  await ensureBillingAccount(q, nodeId);
  const result = await q.query(
    `UPDATE billing_accounts
        SET balance = balance - $1, updated_at = NOW()
      WHERE node_id = $2 AND balance - $1 >= $3
      RETURNING balance`,
    [amount, nodeId, minBalance]
  );
  if (result.rows.length === 0) return { ok: false };
  return { ok: true, balance: parseFloat(result.rows[0].balance) };
}

/**
 * 在给定连接（或连接池）上原子入账；调用方需自行管理事务
 */
export async function creditAccount(q, nodeId, amount) {
  await ensureBillingAccount(q, nodeId);
  const result = await q.query(
    `UPDATE billing_accounts
        SET balance = balance + $1, updated_at = NOW()
      WHERE node_id = $2
      RETURNING balance`,
    [amount, nodeId]
  );
  return parseFloat(result.rows[0].balance);
}

/**
 * 冻结调用方资金到托管（需在调用方事务内执行）
 */
export async function escrowFundsInTx(client, taskId, callerId, amount) {
  const validation = validateAmount(amount);
  if (!validation.valid) return { success: false, error: validation.error };

  const res = await client.query(
    `UPDATE billing_accounts
        SET balance = balance - $1,
            escrow_balance = escrow_balance + $1,
            updated_at = NOW()
      WHERE node_id = $2 AND balance >= $1
      RETURNING balance, escrow_balance`,
    [validation.amount, callerId]
  );
  if (res.rows.length === 0) return { success: false, error: '余额不足，无法托管' };

  await client.query(
    `INSERT INTO transactions
      (id, task_id, node_id, amount, type, status, reason, metadata)
     VALUES ($1, $2, $3, $4, 'escrow_hold', 'completed', $5, $6)`,
    [crypto.randomUUID(), taskId, callerId, validation.amount, `escrow_hold:${taskId}`, JSON.stringify({})]
  );
  await client.query(
    `UPDATE tasks SET escrow_amount = $1, escrow_status = 'held', updated_at = NOW() WHERE id = $2`,
    [validation.amount, taskId]
  );

  return {
    success: true,
    amount: validation.amount,
    balance: parseFloat(res.rows[0].balance),
    escrow_balance: parseFloat(res.rows[0].escrow_balance)
  };
}

/**
 * 调整托管金额：竞标价高于当前托管则追加冻结，低于则解冻差额（需在调用方事务内执行）
 */
export async function adjustEscrowInTx(client, taskId, newAmount) {
  const taskRes = await client.query(
    'SELECT caller_id, escrow_amount, escrow_status FROM tasks WHERE id = $1 FOR UPDATE',
    [taskId]
  );
  if (!taskRes.rows.length) return { success: false, error: '任务不存在' };
  const task = taskRes.rows[0];
  if (task.escrow_status !== 'held') return { success: false, error: '任务未处于托管状态' };

  const current = parseFloat(task.escrow_amount) || 0;
  const target = Math.round(Number(newAmount) * 100) / 100;
  if (!Number.isFinite(target) || target <= 0) return { success: false, error: '托管金额无效' };
  const diff = Math.round((target - current) * 100) / 100;
  if (diff === 0) return { success: true, amount: current, delta: 0 };

  if (diff > 0) {
    const res = await client.query(
      `UPDATE billing_accounts
          SET balance = balance - $1,
              escrow_balance = escrow_balance + $1,
              updated_at = NOW()
        WHERE node_id = $2 AND balance >= $1
        RETURNING balance`,
      [diff, task.caller_id]
    );
    if (res.rows.length === 0) return { success: false, error: '余额不足，无法追加托管' };
  } else {
    await client.query(
      `UPDATE billing_accounts
          SET balance = balance + $1,
              escrow_balance = escrow_balance - $1,
              updated_at = NOW()
        WHERE node_id = $2`,
      [Math.abs(diff), task.caller_id]
    );
  }

  await client.query(
    `UPDATE tasks SET escrow_amount = $1, updated_at = NOW() WHERE id = $2`,
    [target, taskId]
  );
  return { success: true, amount: target, delta: diff };
}

/**
 * 释放托管给执行方（需在调用方事务内执行）
 */
export async function releaseEscrowInTx(client, taskId, workerId) {
  const taskRes = await client.query(
    'SELECT caller_id, escrow_amount, escrow_status FROM tasks WHERE id = $1 FOR UPDATE',
    [taskId]
  );
  if (!taskRes.rows.length) return { success: false, error: '任务不存在' };
  const task = taskRes.rows[0];
  if (task.escrow_status !== 'held') return { success: false, error: '任务未处于托管状态' };
  const escrow = parseFloat(task.escrow_amount) || 0;
  if (escrow <= 0) return { success: false, error: '托管金额异常' };

  await client.query(
    `UPDATE billing_accounts
        SET escrow_balance = escrow_balance - $1, updated_at = NOW()
      WHERE node_id = $2`,
    [escrow, task.caller_id]
  );
  const workerBalance = await creditAccount(client, workerId, escrow);
  await client.query(
    `INSERT INTO transactions
      (id, task_id, node_id, amount, type, status, reason, metadata)
     VALUES ($1, $2, $3, $4, 'escrow_release', 'completed', $5, $6)`,
    [crypto.randomUUID(), taskId, workerId, escrow, `escrow_release:${taskId}`, JSON.stringify({ caller_id: task.caller_id })]
  );
  await client.query(
    `UPDATE tasks SET escrow_amount = 0, escrow_status = 'released', resolution = 'released', updated_at = NOW() WHERE id = $1`,
    [taskId]
  );

  return { success: true, amount: escrow, worker_balance: workerBalance };
}

/**
 * 托管退款给调用方（需在调用方事务内执行）
 */
export async function refundEscrowInTx(client, taskId) {
  const taskRes = await client.query(
    'SELECT caller_id, escrow_amount, escrow_status FROM tasks WHERE id = $1 FOR UPDATE',
    [taskId]
  );
  if (!taskRes.rows.length) return { success: false, error: '任务不存在' };
  const task = taskRes.rows[0];
  if (task.escrow_status !== 'held') return { success: false, error: '任务未处于托管状态' };
  const escrow = parseFloat(task.escrow_amount) || 0;
  if (escrow <= 0) return { success: false, error: '托管金额异常' };

  await client.query(
    `UPDATE billing_accounts
        SET balance = balance + $1,
            escrow_balance = escrow_balance - $1,
            updated_at = NOW()
      WHERE node_id = $2`,
    [escrow, task.caller_id]
  );
  await client.query(
    `INSERT INTO transactions
      (id, task_id, node_id, amount, type, status, reason, metadata)
     VALUES ($1, $2, $3, $4, 'escrow_refund', 'completed', $5, $6)`,
    [crypto.randomUUID(), taskId, task.caller_id, escrow, `escrow_refund:${taskId}`, JSON.stringify({})]
  );
  await client.query(
    `UPDATE tasks SET escrow_amount = 0, escrow_status = 'refunded', resolution = 'refunded', updated_at = NOW() WHERE id = $1`,
    [taskId]
  );

  return { success: true, amount: escrow };
}

/**
 * 注册 sandbox 额度发放（自助获客闸门：替代"管理员线下核验充值"的关键路径角色）
 *
 * 防滥用设计：
 *   - 幂等：idempotency_key = sandbox_grant:<nodeId>，nodeId 源自公钥哈希，
 *     同一公钥终身只发放一次（重复注册/密钥轮换不重发）
 *   - IP 限频：同 IP 24h 内最多 SANDBOX_GRANT_IP_DAILY_LIMIT 次（女巫批量注册的成本线）
 *   - 额度刻意压小：够完成小额任务，不足以转移出金（提现另有链上执行器）
 *
 * 失败一律非阻断（注册主流程不受影响），返回 { granted, amount?, reason? }
 */
export async function grantSandboxCredit(nodeId, ip = null) {
  if (!SANDBOX_GRANT_ENABLED) return { granted: false, reason: 'disabled' };
  if (!(SANDBOX_GRANT_AMOUNT > 0)) return { granted: false, reason: 'invalid_amount' };

  const pgPool = getPostgres();
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT 1 FROM transactions WHERE idempotency_key = $1',
      [`sandbox_grant:${nodeId}`]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return { granted: false, reason: 'already_granted' };
    }

    if (ip) {
      const recent = await client.query(
        `SELECT COUNT(*)::int AS n
           FROM transactions
          WHERE type = 'sandbox_grant'
            AND status = 'completed'
            AND metadata->>'ip' = $1
            AND created_at > NOW() - INTERVAL '24 hours'`,
        [ip]
      );
      if (recent.rows[0].n >= SANDBOX_GRANT_IP_DAILY_LIMIT) {
        await client.query('ROLLBACK');
        logger.warn('Sandbox grant blocked by IP daily limit', { nodeId, ip });
        return { granted: false, reason: 'ip_daily_limit' };
      }
    }

    const balance = await creditAccount(client, nodeId, SANDBOX_GRANT_AMOUNT);
    await client.query(
      `INSERT INTO transactions
        (id, node_id, amount, type, status, idempotency_key, reason, metadata)
       VALUES ($1, $2, $3, 'sandbox_grant', 'completed', $4, $5, $6)`,
      [
        crypto.randomUUID(),
        nodeId,
        SANDBOX_GRANT_AMOUNT,
        `sandbox_grant:${nodeId}`,
        'Registration sandbox credit',
        JSON.stringify({ ip, source: 'registration' })
      ]
    );

    await client.query('COMMIT');
    await invalidateBalanceCache(nodeId);

    logger.info('Sandbox credit granted', { nodeId, amount: SANDBOX_GRANT_AMOUNT, ip });
    eventBus.emit(
      'billing.sandbox_granted',
      { node_id: nodeId, amount: SANDBOX_GRANT_AMOUNT, sandbox: true },
      { sourceId: nodeId }
    );
    return { granted: true, amount: SANDBOX_GRANT_AMOUNT, balance };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Sandbox grant failed', { error: error.message, nodeId });
    return { granted: false, reason: 'error' };
  } finally {
    client.release();
  }
}

async function getCachedBalance(nodeId) {
  const redisClient = getRedis();
  const cached = await redisClient.get(`node:${nodeId}:balance`);
  if (cached !== null) {
    return { balance: parseFloat(cached), fromCache: true };
  }

  const pgPool = getPostgres();
  await ensureBillingAccount(pgPool, nodeId);
  const result = await pgPool.query(
    'SELECT balance FROM billing_accounts WHERE node_id = $1',
    [nodeId]
  );
  const balance = parseFloat(result.rows[0]?.balance) || 0;
  await redisClient.set(`node:${nodeId}:balance`, balance.toString(), 'EX', BALANCE_CACHE_TTL);
  return { balance, fromCache: false };
}

/**
 * 任务计费：从任务调用方账户真实扣款（幂等）
 * 调用方不存在余额时返回失败，调用方为空（系统任务）时仅记账
 */
export async function chargeTask(taskId, amount = TASK_BASE_PRICE, audit = {}) {
  const validation = validateAmount(amount);
  if (!validation.valid) {
    return formatResponse(false, null, validation.error);
  }

  const idempotencyKey = `task_charge:${taskId}`;
  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id, status FROM transactions WHERE idempotency_key = $1',
      [idempotencyKey]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return formatResponse(true, {
        transaction_id: existing.rows[0].id,
        amount: validation.amount,
        status: existing.rows[0].status,
        duplicate: true
      });
    }

    const taskRes = await client.query(
      'SELECT caller_id FROM tasks WHERE id = $1',
      [taskId]
    );
    const callerId = taskRes.rows[0]?.caller_id || null;

    if (callerId) {
      const debit = await debitAccount(client, callerId, validation.amount);
      if (!debit.ok) {
        await client.query('ROLLBACK');
        return formatResponse(false, null, '调用方余额不足，无法结算任务');
      }
    }

    const transactionId = crypto.randomUUID();
    await client.query(
      `INSERT INTO transactions
        (id, task_id, node_id, amount, type, status, idempotency_key, operator_id, reason, ip_address, metadata)
       VALUES ($1, $2, $3, $4, 'task', 'completed', $5, $6, $7, $8, $9)`,
      [
        transactionId,
        taskId,
        callerId,
        validation.amount,
        idempotencyKey,
        audit.operator_id || null,
        audit.reason || `task_charge:${taskId}`,
        audit.ip_address || null,
        audit.metadata || '{}'
      ]
    );

    await client.query('COMMIT');
    await invalidateBalanceCache(callerId);

    logger.info('Task charged', { taskId, callerId, transactionId, amount: validation.amount });
    eventBus.emit(
      'billing.debit',
      { node_id: callerId, amount: validation.amount, type: 'task_charge' },
      { sourceId: callerId }
    );
    return formatResponse(true, { transaction_id: transactionId, amount: validation.amount, status: 'completed' });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (error.code === '23505') {
      return formatResponse(true, { task_id: taskId, status: 'completed', duplicate: true });
    }
    logger.error('Task charge failed', { error: error.message, taskId });
    return formatResponse(false, null, '任务计费失败');
  } finally {
    client.release();
  }
}

export async function chargeSkill(skillId, amount, audit = {}) {
  const validation = validateAmount(amount);
  if (!validation.valid) {
    return formatResponse(false, null, validation.error);
  }

  const idempotencyKey = `skill_charge:${skillId}`;
  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id, status FROM transactions WHERE idempotency_key = $1',
      [idempotencyKey]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return formatResponse(true, {
        transaction_id: existing.rows[0].id,
        amount: validation.amount,
        status: existing.rows[0].status,
        duplicate: true
      });
    }

    const commission = Math.round(validation.amount * COMMISSION_RATE * 100) / 100;
    const transactionId = crypto.randomUUID();

    await client.query(
      `INSERT INTO transactions
        (id, skill_id, amount, type, status, idempotency_key, operator_id, ip_address, metadata)
       VALUES ($1, $2, $3, 'skill_commission', 'completed', $4, $5, $6, $7)`,
      [transactionId, skillId, commission, idempotencyKey, audit.operator_id || null, audit.ip_address || null, audit.metadata || '{}']
    );

    await client.query('COMMIT');
    return formatResponse(true, { transaction_id: transactionId, amount: commission, status: 'completed' });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Skill commission failed', { error: error.message, skillId });
    return formatResponse(false, null, 'Skill 抽成失败');
  } finally {
    client.release();
  }
}

/**
 * 节点奖励：入账到 billing_accounts（不再内联更新 reputation_score，避免双轨制）
 */
export async function rewardNode(nodeId, amount, audit = {}) {
  const validation = validateAmount(amount);
  if (!validation.valid) {
    return formatResponse(false, null, validation.error);
  }

  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const nodeExists = await client.query(
      'SELECT 1 FROM nodes WHERE node_id = $1',
      [nodeId]
    );
    if (nodeExists.rows.length === 0) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, '节点不存在');
    }

    const transactionId = crypto.randomUUID();
    await client.query(
      `INSERT INTO transactions
        (id, node_id, amount, type, status, operator_id, reason, ip_address, metadata)
       VALUES ($1, $2, $3, 'node_reward', 'completed', $4, $5, $6, $7)`,
      [transactionId, nodeId, validation.amount, audit.operator_id || null, audit.reason || 'task reward', audit.ip_address || null, audit.metadata || '{}']
    );

    const newBalance = await creditAccount(client, nodeId, validation.amount);

    await client.query('COMMIT');
    await invalidateBalanceCache(nodeId);

    logger.info('Node rewarded', { nodeId, transactionId, amount: validation.amount, newBalance });
    eventBus.emit(
      'billing.credit',
      { node_id: nodeId, amount: validation.amount, type: 'task_reward' },
      { sourceId: nodeId }
    );
    return formatResponse(true, { transaction_id: transactionId, amount: validation.amount, status: 'completed', new_balance: newBalance });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Node reward failed', { error: error.message, nodeId });
    return formatResponse(false, null, '节点奖励失败');
  } finally {
    client.release();
  }
}

export async function getTransactions(filters = {}) {
  const pgPool = getPostgres();

  try {
    let sql = 'SELECT id, task_id, skill_id, node_id, amount, type, status, idempotency_key, operator_id, reason, metadata, created_at, updated_at FROM transactions';
    const params = [];
    const conditions = [];

    if (filters.task_id) {
      conditions.push(`task_id = $${params.length + 1}`);
      params.push(filters.task_id);
    }
    if (filters.skill_id) {
      conditions.push(`skill_id = $${params.length + 1}`);
      params.push(filters.skill_id);
    }
    if (filters.node_id) {
      conditions.push(`node_id = $${params.length + 1}`);
      params.push(filters.node_id);
    }
    if (filters.type) {
      conditions.push(`type = $${params.length + 1}`);
      params.push(filters.type);
    }
    if (filters.status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(filters.status);
    }
    if (filters.from_date) {
      conditions.push(`created_at >= $${params.length + 1}`);
      params.push(filters.from_date);
    }
    if (filters.to_date) {
      conditions.push(`created_at <= $${params.length + 1}`);
      params.push(filters.to_date);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
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
    return formatResponse(true, result.rows);
  } catch (error) {
    logger.error('Get transactions failed', { error: error.message });
    return formatResponse(false, null, '获取交易记录失败');
  }
}

export async function getNodeBalance(nodeId) {
  try {
    const pgPool = getPostgres();
    await ensureBillingAccount(pgPool, nodeId);
    const nodeRes = await pgPool.query(
      'SELECT 1 FROM nodes WHERE node_id = $1',
      [nodeId]
    );
    if (nodeRes.rows.length === 0) {
      return formatResponse(false, null, '节点不存在');
    }
    const dbResult = await pgPool.query(
      'SELECT balance, escrow_balance FROM billing_accounts WHERE node_id = $1',
      [nodeId]
    );

    const balance = parseFloat(dbResult.rows[0].balance) || 0;
    const escrowBalance = parseFloat(dbResult.rows[0].escrow_balance) || 0;
    // 刷新缓存，保持读取一致
    const redisClient = getRedis();
    await redisClient.set(`node:${nodeId}:balance`, balance.toString(), 'EX', BALANCE_CACHE_TTL).catch(() => {});

    return formatResponse(true, {
      node_id: nodeId,
      balance,
      escrow_balance: escrowBalance,
      total_balance: Math.round((balance + escrowBalance) * 100) / 100,
      currency: process.env.CURRENCY || 'XCL'
    });
  } catch (error) {
    logger.error('Get node balance failed', { error: error.message, nodeId });
    return formatResponse(false, null, '获取节点余额失败');
  }
}

export async function deductFromBalance(nodeId, amount, audit = {}) {
  const validation = validateAmount(amount);
  if (!validation.valid) {
    return formatResponse(false, null, validation.error);
  }

  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const debit = await debitAccount(client, nodeId, validation.amount, MIN_BALANCE);
    if (!debit.ok) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, '余额不足');
    }

    const transactionId = crypto.randomUUID();
    await client.query(
      `INSERT INTO transactions
        (id, node_id, amount, type, status, operator_id, reason, ip_address, metadata)
       VALUES ($1, $2, $3, 'deduction', 'completed', $4, $5, $6, $7)`,
      [transactionId, nodeId, -validation.amount, audit.operator_id || null, audit.reason || 'withdraw', audit.ip_address || null, audit.metadata || '{}']
    );

    await client.query('COMMIT');
    await invalidateBalanceCache(nodeId);

    logger.info('Balance deducted', { nodeId, transactionId, amount: validation.amount, newBalance: debit.balance });
    return formatResponse(true, { transaction_id: transactionId, new_balance: debit.balance });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Deduct from balance failed', { error: error.message, nodeId });
    return formatResponse(false, null, '扣款失败');
  } finally {
    client.release();
  }
}

export async function getBillingStats(nodeId) {
  const pgPool = getPostgres();
  try {
    const result = await pgPool.query(
      `SELECT
         type,
         COUNT(*) as count,
         COALESCE(SUM(ABS(amount)), 0) as total_amount
       FROM transactions
       WHERE node_id = $1 AND status = 'completed'
       GROUP BY type`,
      [nodeId]
    );
    return formatResponse(true, result.rows);
  } catch (error) {
    logger.error('Get billing stats failed', { error: error.message, nodeId });
    return formatResponse(false, null, '获取计费统计失败');
  }
}
