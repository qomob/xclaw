import { getPostgres, getRedis } from '../core/dependencies.js';
import { generateUUID, formatResponse } from '../core/utils.js';
import logger from '../services/loggerService.js';
import eventBus from '../services/eventBus.js';

const COMMISSION_RATE = parseFloat(process.env.COMMISSION_RATE || '0.2');
const MIN_BALANCE = parseFloat(process.env.MIN_BALANCE || '0');
const TASK_BASE_PRICE = parseFloat(process.env.TASK_BASE_PRICE || '0.01');
const MAX_SINGLE_AMOUNT = parseFloat(process.env.MAX_SINGLE_AMOUNT || '1000000');
const BALANCE_CACHE_TTL = parseInt(process.env.BALANCE_CACHE_TTL || '30');

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

async function invalidateBalanceCache(nodeId) {
  try {
    const redisClient = getRedis();
    await redisClient.del(`node:${nodeId}:balance`);
  } catch (_) {}
}

async function getCachedBalance(nodeId) {
  const redisClient = getRedis();
  const cached = await redisClient.get(`node:${nodeId}:balance`);
  if (cached !== null) {
    return { balance: parseFloat(cached), fromCache: true };
  }

  const pgPool = getPostgres();
  const result = await pgPool.query(
    'SELECT COALESCE(total_earnings, 0) as total_earnings FROM nodes WHERE node_id = $1',
    [nodeId]
  );
  if (result.rows.length === 0) {
    return { balance: 0, fromCache: false };
  }

  const balance = parseFloat(result.rows[0].total_earnings);
  await redisClient.set(`node:${nodeId}:balance`, balance.toString(), 'EX', BALANCE_CACHE_TTL);
  return { balance, fromCache: false };
}

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
      const tx = existing.rows[0];
      await client.query('ROLLBACK');
      return formatResponse(true, {
        transaction_id: tx.id,
        amount: validation.amount,
        status: tx.status,
        duplicate: true
      });
    }

    const transactionId = generateUUID(`transaction:${Date.now()}`);

    await client.query(
      `INSERT INTO transactions (id, task_id, amount, type, status, idempotency_key, operator_id, ip_address, metadata)
       VALUES ($1, $2, $3, 'task', 'completed', $4, $5, $6, $7)`,
      [transactionId, taskId, validation.amount, idempotencyKey, audit.operator_id || null, audit.ip_address || null, audit.metadata || '{}']
    );

    await client.query('COMMIT');

    logger.info('Task charged', { taskId, transactionId, amount: validation.amount });
    eventBus.emit('billing.debit', { node_id: audit.operator_id || null, amount: validation.amount, type: 'task_charge' }, { sourceId: audit.operator_id || null });
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

  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const commission = Math.round(validation.amount * COMMISSION_RATE * 100) / 100;
    const transactionId = generateUUID(`skill-commission:${Date.now()}`);

    await client.query(
      `INSERT INTO transactions (id, skill_id, amount, type, status, operator_id, ip_address, metadata)
       VALUES ($1, $2, $3, 'skill_commission', 'completed', $4, $5, $6)`,
      [transactionId, skillId, commission, audit.operator_id || null, audit.ip_address || null, audit.metadata || '{}']
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

export async function rewardNode(nodeId, amount, audit = {}) {
  const validation = validateAmount(amount);
  if (!validation.valid) {
    return formatResponse(false, null, validation.error);
  }

  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const transactionId = generateUUID(`node-reward:${Date.now()}`);

    await client.query(
      `INSERT INTO transactions (id, node_id, amount, type, status, operator_id, reason, ip_address, metadata)
       VALUES ($1, $2, $3, 'node_reward', 'completed', $4, $5, $6, $7)`,
      [transactionId, nodeId, validation.amount, audit.operator_id || null, audit.reason || 'task reward', audit.ip_address || null, audit.metadata || '{}']
    );

    const updateResult = await client.query(
      `UPDATE nodes SET
         reputation_score = LEAST(
           (SELECT COALESCE(
             (SELECT
               CASE WHEN total_tasks = 0 THEN 0.5
                 ELSE LEAST(1.0, success_rate * 0.5 + avg_rel_rating * 0.3 + COALESCE(1.0 - fail_ratio, 0.5) * 0.2)
               END
             FROM (
               SELECT
                 COUNT(*) as total_tasks,
                 COUNT(*) FILTER (WHERE status = 'completed')::FLOAT / NULLIF(COUNT(*), 0) as success_rate,
                 0.5 as avg_rel_rating,
                 COUNT(*) FILTER (WHERE status = 'failed')::FLOAT / NULLIF(COUNT(*), 0) as fail_ratio
               FROM tasks WHERE node_id = $2
             ) sub
           ), 0.5) + 0.01
         ), 1.0),
         total_earnings = COALESCE(total_earnings, 0) + $1,
         updated_at = NOW()
       WHERE node_id = $2`,
      [validation.amount, nodeId]
    );

    if (updateResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, '节点不存在');
    }

    await client.query('COMMIT');

    await invalidateBalanceCache(nodeId);

    logger.info('Node rewarded', { nodeId, transactionId, amount: validation.amount });
    eventBus.emit('billing.credit', { node_id: nodeId, amount: validation.amount, type: 'task_reward' }, { sourceId: nodeId });
    return formatResponse(true, { transaction_id: transactionId, amount: validation.amount, status: 'completed' });
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
    const { balance } = await getCachedBalance(nodeId);

    const pgPool = getPostgres();
    const dbResult = await pgPool.query(
      'SELECT total_earnings FROM nodes WHERE node_id = $1',
      [nodeId]
    );

    if (dbResult.rows.length === 0) {
      return formatResponse(false, null, '节点不存在');
    }

    const totalEarnings = parseFloat(dbResult.rows[0].total_earnings) || 0;

    return formatResponse(true, {
      node_id: nodeId,
      balance: totalEarnings,
      total_earnings: totalEarnings,
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

    const updateResult = await client.query(
      `UPDATE nodes SET
         total_earnings = total_earnings - $1,
         updated_at = NOW()
       WHERE node_id = $2 AND total_earnings - $1 >= $3
       RETURNING total_earnings`,
      [validation.amount, nodeId, MIN_BALANCE]
    );

    if (updateResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, '余额不足');
    }

    const newBalance = parseFloat(updateResult.rows[0].total_earnings);

    const transactionId = generateUUID(`deduction:${Date.now()}`);
    await client.query(
      `INSERT INTO transactions (id, node_id, amount, type, status, operator_id, reason, ip_address, metadata)
       VALUES ($1, $2, $3, 'deduction', 'completed', $4, $5, $6, $7)`,
      [transactionId, nodeId, -validation.amount, audit.operator_id || null, audit.reason || 'withdraw', audit.ip_address || null, audit.metadata || '{}']
    );

    await client.query('COMMIT');

    await invalidateBalanceCache(nodeId);

    logger.info('Balance deducted', { nodeId, transactionId, amount: validation.amount, newBalance });
    return formatResponse(true, { transaction_id: transactionId, new_balance: newBalance });
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
