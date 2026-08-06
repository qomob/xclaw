import { getPostgres, getRedis } from '../core/dependencies.js';
import { generateUUID, formatResponse } from '../core/utils.js';
import { routeTask, completeTask } from '../router/taskRouter.js';
import { debitAccount, creditAccount } from '../billing/index.js';
import logger from '../services/loggerService.js';
import eventBus from '../services/eventBus.js';

const COMMISSION_RATE = parseFloat(process.env.COMMISSION_RATE || '0.2');

export async function listSkill(skillId, nodeId, price) {
  const pgPool = getPostgres();
  const redisClient = getRedis();

  try {
    // 被自动扫描拒绝的技能禁止上架
    const gate = await pgPool.query(
      'SELECT review_status, review_note FROM skills WHERE id = $1',
      [skillId]
    );
    if (gate.rows.length > 0 && gate.rows[0].review_status === 'rejected') {
      return formatResponse(false, null, `技能存在安全问题，禁止上架：${gate.rows[0].review_note || '自动扫描拒绝'}`);
    }
    const result = await pgPool.query(
      `UPDATE skills SET
         price = $1, is_listed = TRUE, review_status = 'pending', reviewed_at = NULL, updated_at = NOW()
       WHERE id = $2 AND node_id = $3
       RETURNING *`,
      [price, skillId, nodeId]
    );

    if (result.rows.length === 0) {
      return formatResponse(false, null, '技能不存在或无权操作');
    }

    await redisClient.hset(`skill:${skillId}`, {
      price: price.toString(),
      is_listed: 'true'
    });
    await redisClient.sadd('marketplace:listed', skillId);

    logger.info('Skill listed', { skillId, nodeId, price });
    return formatResponse(true, result.rows[0]);
  } catch (error) {
    logger.error('List skill failed', { error: error.message, skillId });
    return formatResponse(false, null, '上架失败');
  }
}

/**
 * 管理员：列出待审核/已审核的技能（含卖家信息）
 */
export async function listSkillsForReview({ status = 'pending', limit = 50 } = {}) {
  const pgPool = getPostgres();
  const result = await pgPool.query(
    `SELECT s.id, s.name, s.category, s.version, s.description, s.price, s.is_listed,
            s.review_status, s.review_note, s.created_at, s.reviewed_at,
            n.name AS owner_name, n.reputation_score AS owner_reputation
     FROM skills s
     LEFT JOIN nodes n ON n.node_id = s.node_id
     WHERE s.review_status = $1
     ORDER BY s.created_at DESC
     LIMIT $2`,
    [status, Math.min(Math.max(parseInt(limit) || 50, 1), 200)]
  );
  return formatResponse(true, result.rows);
}

/**
 * 管理员：审核技能（approve 通过上架可见；reject 拒绝并强制下架）
 */
export async function reviewSkill(skillId, action, note, adminId) {
  if (!['approve', 'reject'].includes(action)) {
    return formatResponse(false, null, 'action 必须是 approve 或 reject');
  }
  const pgPool = getPostgres();
  const redisClient = getRedis();
  const status = action === 'approve' ? 'approved' : 'rejected';
  const result = await pgPool.query(
    `UPDATE skills SET
       review_status = $2,
       review_note = $3,
       reviewed_at = NOW(),
       updated_at = NOW(),
       is_listed = CASE WHEN $2 = 'approved' THEN is_listed ELSE FALSE END
     WHERE id = $1
     RETURNING id, name, review_status, review_note, is_listed`,
    [skillId, status, note || null]
  );
  if (!result.rows.length) {
    return formatResponse(false, null, '技能不存在');
  }
  // 同步 Redis 市场索引
  if (status === 'approved' && result.rows[0].is_listed) {
    await redisClient.sadd('marketplace:listed', skillId);
  } else {
    await redisClient.srem('marketplace:listed', skillId);
  }
  return formatResponse(true, result.rows[0]);
}

export async function delistSkill(skillId, nodeId) {
  const pgPool = getPostgres();
  const redisClient = getRedis();

  try {
    const result = await pgPool.query(
      `UPDATE skills SET 
         is_listed = FALSE, updated_at = NOW() 
       WHERE id = $1 AND node_id = $2
       RETURNING id`,
      [skillId, nodeId]
    );

    if (result.rows.length === 0) {
      return formatResponse(false, null, '技能不存在或无权操作');
    }

    await redisClient.hset(`skill:${skillId}`, { is_listed: 'false' });
    await redisClient.srem('marketplace:listed', skillId);

    return formatResponse(true, { delisted: true });
  } catch (error) {
    logger.error('Delist skill failed', { error: error.message, skillId });
    return formatResponse(false, null, '下架失败');
  }
}

export async function getMarketplaceListings(filters = {}) {
  const pgPool = getPostgres();

  try {
    let sql = `
      SELECT s.*, n.name as seller_name, n.reputation_score as seller_reputation,
             n.status as seller_status
      FROM skills s
      LEFT JOIN nodes n ON s.node_id = n.node_id
      WHERE s.is_listed = TRUE AND s.review_status = 'approved'
    `;
    const params = [];
    const conditions = [];

    if (filters.category) {
      conditions.push(`s.category = $${params.length + 1}`);
      params.push(filters.category);
    }

    if (filters.min_price !== undefined) {
      conditions.push(`s.price >= $${params.length + 1}`);
      params.push(filters.min_price);
    }

    if (filters.max_price !== undefined) {
      conditions.push(`s.price <= $${params.length + 1}`);
      params.push(filters.max_price);
    }

    if (filters.featured) {
      conditions.push(`s.featured = TRUE`);
    }

    if (filters.node_id) {
      conditions.push(`s.node_id = $${params.length + 1}`);
      params.push(filters.node_id);
    }

    if (filters.query && filters.query.trim()) {
      conditions.push(`(s.name ILIKE $${params.length + 1} OR s.description ILIKE $${params.length + 1})`);
      params.push(`%${filters.query.trim()}%`);
    }

    if (conditions.length > 0) {
      sql += ' AND ' + conditions.join(' AND ');
    }

    const sortBy = filters.sort || 'created_at';
    const sortOrder = filters.order === 'asc' ? 'ASC' : 'DESC';
    const validSortFields = ['price', 'sales_count', 'total_revenue', 'avg_rating', 'created_at', 'updated_at'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'created_at';

    sql += ` ORDER BY s.${sortField} ${sortOrder}`;

    const limit = Math.min(Math.max(parseInt(filters.limit) || 20, 1), 100);
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
    logger.error('Get marketplace listings failed', { error: error.message });
    return formatResponse(false, null, '获取市场列表失败');
  }
}

export async function getListingDetail(skillId) {
  const pgPool = getPostgres();

  try {
    const result = await pgPool.query(`
      SELECT s.*, n.name as seller_name, n.reputation_score as seller_reputation,
             n.status as seller_status, n.latitude, n.longitude
      FROM skills s
      LEFT JOIN nodes n ON s.node_id = n.node_id
      WHERE s.id = $1
    `, [skillId]);

    if (result.rows.length === 0) {
      return formatResponse(false, null, '技能不存在');
    }

    return formatResponse(true, result.rows[0]);
  } catch (error) {
    logger.error('Get listing detail failed', { error: error.message, skillId });
    return formatResponse(false, null, '获取技能详情失败');
  }
}

export async function placeOrder(buyerId, skillId, payload = {}) {
  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const skillResult = await client.query(
      'SELECT * FROM skills WHERE id = $1 AND is_listed = TRUE AND review_status = $2 FOR UPDATE',
      [skillId, 'approved']
    );

    if (skillResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, '技能未上架或不存在');
    }

    const skill = skillResult.rows[0];
    const price = parseFloat(skill.price);
    const commission = Math.round(price * COMMISSION_RATE * 100) / 100;

    // 从统一账本扣款（原子条件更新，余额不足返回空行）
    const debit = await debitAccount(client, buyerId, price);
    if (!debit.ok) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, '余额不足');
    }

    const orderId = generateUUID(`order:${Date.now()}`);
    await client.query(
      `INSERT INTO orders (order_id, buyer_id, seller_id, skill_id, amount, commission, status, payload)
       VALUES ($1, $2, $3, $4, $5, $6, 'paid', $7)`,
      [orderId, buyerId, skill.node_id, skillId, price, commission, JSON.stringify(payload)]
    );

    const taskData = {
      type: skill.category,
      payload,
      caller_id: buyerId,
      skill_id: skillId
    };

    const routeResult = await routeTask(taskData);

    if (routeResult.success) {
      await client.query(
        `UPDATE orders SET task_id = $1, status = 'processing' WHERE order_id = $2`,
        [routeResult.data.task_id, orderId]
      );
    } else {
      await client.query(
        `UPDATE orders SET status = 'failed' WHERE order_id = $1`,
        [orderId]
      );
    }

    await client.query(
      `UPDATE skills SET sales_count = sales_count + 1, total_revenue = total_revenue + $1 WHERE id = $2`,
      [price, skillId]
    );

    await client.query('COMMIT');

    logger.info('Order placed', { orderId, buyerId, skillId, price });

    const response = {
      order_id: orderId,
      status: routeResult.success ? 'processing' : 'failed',
      amount: price,
      commission,
      seller_id: skill.node_id
    };

    if (routeResult.success) {
      response.task_id = routeResult.data.task_id;
    }

    eventBus.emit('marketplace.order_created', { order_id: orderId, skill_id: skillId, buyer_id: buyerId, seller_id: skill.node_id }, { sourceId: buyerId });
    return formatResponse(true, response);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Place order failed', { error: error.message, buyerId, skillId });
    return formatResponse(false, null, '下单失败');
  } finally {
    client.release();
  }
}

export async function getOrder(orderId) {
  const pgPool = getPostgres();

  try {
    const result = await pgPool.query(`
      SELECT o.*, s.name as skill_name, s.category, s.price,
             buyer.name as buyer_name, seller.name as seller_name
      FROM orders o
      LEFT JOIN skills s ON o.skill_id = s.id
      LEFT JOIN nodes buyer ON o.buyer_id = buyer.node_id
      LEFT JOIN nodes seller ON o.seller_id = seller.node_id
      WHERE o.order_id = $1
    `, [orderId]);

    if (result.rows.length === 0) {
      return formatResponse(false, null, '订单不存在');
    }

    return formatResponse(true, result.rows[0]);
  } catch (error) {
    logger.error('Get order failed', { error: error.message, orderId });
    return formatResponse(false, null, '获取订单失败');
  }
}

export async function getBuyerOrders(buyerId, { status, limit = 20, offset = 0 } = {}) {
  const pgPool = getPostgres();

  try {
    let sql = `
      SELECT o.*, s.name as skill_name, s.category,
             seller.name as seller_name, seller.reputation_score as seller_reputation
      FROM orders o
      LEFT JOIN skills s ON o.skill_id = s.id
      LEFT JOIN nodes seller ON o.seller_id = seller.node_id
      WHERE o.buyer_id = $1
    `;
    const params = [buyerId];

    if (status) {
      params.push(status);
      sql += ` AND o.status = $${params.length}`;
    }

    sql += ' ORDER BY o.created_at DESC';

    params.push(Math.min(limit, 100));
    sql += ` LIMIT $${params.length}`;

    if (offset > 0) {
      params.push(offset);
      sql += ` OFFSET $${params.length}`;
    }

    const result = await pgPool.query(sql, params);
    return formatResponse(true, result.rows);
  } catch (error) {
    logger.error('Get buyer orders failed', { error: error.message, buyerId });
    return formatResponse(false, null, '获取订单列表失败');
  }
}

export async function getSellerOrders(sellerId, { status, limit = 20, offset = 0 } = {}) {
  const pgPool = getPostgres();

  try {
    let sql = `
      SELECT o.*, s.name as skill_name, s.category, s.price,
             buyer.name as buyer_name
      FROM orders o
      LEFT JOIN skills s ON o.skill_id = s.id
      LEFT JOIN nodes buyer ON o.buyer_id = buyer.node_id
      WHERE o.seller_id = $1
    `;
    const params = [sellerId];

    if (status) {
      params.push(status);
      sql += ` AND o.status = $${params.length}`;
    }

    sql += ' ORDER BY o.created_at DESC';

    params.push(Math.min(limit, 100));
    sql += ` LIMIT $${params.length}`;

    if (offset > 0) {
      params.push(offset);
      sql += ` OFFSET $${params.length}`;
    }

    const result = await pgPool.query(sql, params);
    return formatResponse(true, result.rows);
  } catch (error) {
    logger.error('Get seller orders failed', { error: error.message, sellerId });
    return formatResponse(false, null, '获取卖家订单失败');
  }
}

export async function completeOrder(orderId, resultData, error = null) {
  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const orderResult = await client.query(
      'SELECT * FROM orders WHERE order_id = $1 FOR UPDATE',
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return formatResponse(false, null, '订单不存在');
    }

    const order = orderResult.rows[0];
    const newStatus = error ? 'failed' : 'completed';

    await client.query(
      'UPDATE orders SET status = $1, result = $2, updated_at = NOW() WHERE order_id = $3',
      [newStatus, resultData ? JSON.stringify(resultData) : null, orderId]
    );

    if (newStatus === 'completed') {
      const netAmount = parseFloat(order.amount) - parseFloat(order.commission);
      await creditAccount(client, order.seller_id, netAmount);

      if (order.task_id) {
        try {
          await completeTask(order.task_id, resultData);
        } catch (_) {}
      }
    } else {
      // 失败退款：退回买家
      await creditAccount(client, order.buyer_id, parseFloat(order.amount));
    }

    await client.query('COMMIT');

    logger.info('Order completed', { orderId, status: newStatus });
    eventBus.emit('marketplace.order_completed', { order_id: orderId }, { sourceId: order.seller_id });
    return formatResponse(true, { order_id: orderId, status: newStatus });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Complete order failed', { error: err.message, orderId });
    return formatResponse(false, null, '完成订单失败');
  } finally {
    client.release();
  }
}

export async function getFeaturedSkills(limit = 6) {
  const pgPool = getPostgres();

  try {
    const result = await pgPool.query(`
      SELECT s.*, n.name as seller_name, n.reputation_score as seller_reputation
      FROM skills s
      LEFT JOIN nodes n ON s.node_id = n.node_id
      WHERE s.is_listed = TRUE AND (s.featured = TRUE OR s.sales_count > 0)
      ORDER BY s.avg_rating DESC NULLS LAST, s.sales_count DESC
      LIMIT $1
    `, [limit]);

    return formatResponse(true, result.rows);
  } catch (error) {
    logger.error('Get featured skills failed', { error: error.message });
    return formatResponse(false, null, '获取精选技能失败');
  }
}

export async function getMarketplaceStats() {
  const pgPool = getPostgres();

  try {
    const result = await pgPool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_listed = TRUE) as listed_skills,
        COUNT(*) as total_skills,
        COALESCE(SUM(sales_count), 0) as total_orders,
        COALESCE(SUM(total_revenue), 0) as total_revenue,
        COALESCE(AVG(avg_rating), 0) as avg_market_rating,
        COUNT(DISTINCT node_id) as active_sellers
      FROM skills
    `);

    const orderStats = await pgPool.query(`
      SELECT
        COUNT(*) as total_orders,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_orders,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_orders,
        COUNT(*) FILTER (WHERE status = 'processing') as processing_orders,
        COUNT(*) FILTER (WHERE status = 'failed') as failed_orders,
        COALESCE(SUM(amount), 0) as total_volume
      FROM orders
      WHERE created_at > NOW() - INTERVAL '30 days'
    `);

    return formatResponse(true, {
      ...result.rows[0],
      ...orderStats.rows[0]
    });
  } catch (error) {
    logger.error('Get marketplace stats failed', { error: error.message });
    return formatResponse(false, null, '获取市场统计失败');
  }
}
