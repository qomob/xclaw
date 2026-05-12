import crypto from 'crypto';
import { getPostgres, getRedis } from '../core/dependencies.js';
import logger from './loggerService.js';

const DELIVERY_TIMEOUT = parseInt(process.env.WEBHOOK_TIMEOUT || '10000');
const MAX_RETRIES = parseInt(process.env.WEBHOOK_MAX_RETRIES || '5');
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000]; // 指数退避
const WEBHOOK_QUEUE_KEY = 'xclaw:webhook:delivery_queue';
const PROCESSOR_INTERVAL = parseInt(process.env.WEBHOOK_PROCESSOR_INTERVAL || '5000');

let processorTimer = null;

// ==========================================
// Webhook CRUD
// ==========================================

/**
 * 创建 webhook 订阅
 */
export async function createWebhook(nodeId, { url, events, description = null }) {
  const pool = getPostgres();

  // 验证 URL
  try {
    new URL(url);
  } catch {
    throw new Error('无效的 webhook URL');
  }

  // 验证事件类型
  const validEvents = getValidEvents();
  const invalidEvents = events.filter(e => !validEvents.includes(e) && e !== '*');
  if (invalidEvents.length > 0) {
    throw new Error(`不支持的事件类型: ${invalidEvents.join(', ')}`);
  }

  // 生成签名密钥
  const secret = crypto.randomBytes(32).toString('hex');

  const result = await pool.query(
    `INSERT INTO webhooks (node_id, url, events, secret, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, node_id, url, events, secret, description, active, created_at`,
    [nodeId, url, events, secret, description]
  );

  const webhook = result.rows[0];
  logger.info('[WebhookService] Created', { webhookId: webhook.id, nodeId, events });

  // 脱敏返回
  webhook.secret_preview = webhook.secret.substring(0, 8) + '...';
  return webhook;
}

/**
 * 列出节点的 webhooks
 */
export async function listWebhooks(nodeId, { activeOnly = false } = {}) {
  const pool = getPostgres();
  const condition = activeOnly ? 'AND active = true' : '';

  const result = await pool.query(
    `SELECT id, node_id, url, events, description, active, created_at, updated_at
     FROM webhooks WHERE node_id = $1 ${condition}
     ORDER BY created_at DESC`,
    [nodeId]
  );

  return result.rows;
}

/**
 * 获取单个 webhook
 */
export async function getWebhook(webhookId, nodeId = null) {
  const pool = getPostgres();
  const condition = nodeId ? 'AND node_id = $3' : '';
  const params = nodeId ? [webhookId, nodeId] : [webhookId];

  // nodeId 条件使用正确的参数索引
  const query = nodeId
    ? `SELECT id, node_id, url, events, description, active, created_at, updated_at
       FROM webhooks WHERE id = $1 AND node_id = $2`
    : `SELECT id, node_id, url, events, description, active, created_at, updated_at
       FROM webhooks WHERE id = $1`;

  const result = await pool.query(query, params);

  if (result.rows.length === 0) {
    throw new Error('Webhook not found');
  }
  return result.rows[0];
}

/**
 * 删除 webhook
 */
export async function deleteWebhook(webhookId, nodeId) {
  const pool = getPostgres();

  const result = await pool.query(
    `DELETE FROM webhooks WHERE id = $1 AND node_id = $2
     RETURNING id`,
    [webhookId, nodeId]
  );

  if (result.rows.length === 0) {
    throw new Error('Webhook not found');
  }

  logger.info('[WebhookService] Deleted', { webhookId, nodeId });
  return { success: true };
}

/**
 * 更新 webhook 状态
 */
export async function toggleWebhook(webhookId, nodeId, active) {
  const pool = getPostgres();

  const result = await pool.query(
    `UPDATE webhooks SET active = $1, updated_at = NOW()
     WHERE id = $2 AND node_id = $3
     RETURNING id, active`,
    [active, webhookId, nodeId]
  );

  if (result.rows.length === 0) {
    throw new Error('Webhook not found');
  }

  return result.rows[0];
}

// ==========================================
// Webhook 投递
// ==========================================

/**
 * 触发所有匹配的 webhook
 */
export async function triggerWebhooks(eventType, payload, sourceId) {
  const pool = getPostgres();
  let result;
  try {
    result = await pool.query(
      `SELECT id, node_id, url, secret, events
       FROM webhooks
       WHERE active = true
         AND ($1 = ANY(events) OR '*' = ANY(events))`,
      [eventType]
    );

    if (!result || !result.rows || result.rows.length === 0) return;
  } catch (err) {
    logger.warn('[WebhookService] triggerWebhooks query failed, table may not exist yet', { error: err.message });
    return;
  }

  const timestamp = new Date().toISOString();
  const deliveries = [];

  for (const webhook of result.rows) {
    // 构建投递 payload
    const deliveryPayload = {
      event: eventType,
      timestamp,
      data: payload,
      source_id: sourceId,
      delivery_id: crypto.randomUUID(),
    };

    // 创建投递记录
    const deliveryResult = await pool.query(
      `INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id`,
      [webhook.id, eventType, JSON.stringify(deliveryPayload)]
    );

    deliveries.push({
      deliveryId: deliveryResult.rows[0].id,
      webhook,
      payload: deliveryPayload,
    });
  }

  // 异步投递
  for (const { deliveryId, webhook, payload } of deliveries) {
    setImmediate(() => deliverWebhook(deliveryId, webhook, payload));
  }

  logger.info('[WebhookService] Triggered', {
    eventType,
    webhookCount: result.rows.length
  });
}

/**
 * 执行单次 webhook 投递
 */
async function deliverWebhook(deliveryId, webhook, payload) {
  const pool = getPostgres();

  try {
    // HMAC-SHA256 签名
    const signature = crypto
      .createHmac('sha256', webhook.secret)
      .update(JSON.stringify(payload))
      .digest('hex');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT);

    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-XClaw-Signature': `sha256=${signature}`,
        'X-XClaw-Event': payload.event,
        'X-XClaw-Delivery': payload.delivery_id,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      // 成功
      await pool.query(
        `UPDATE webhook_deliveries
         SET status = 'success', attempts = attempts + 1,
             last_response_code = $1, updated_at = NOW()
         WHERE id = $2`,
        [response.status, deliveryId]
      );

      logger.info('[WebhookService] Delivered', {
        deliveryId,
        webhookId: webhook.id,
        statusCode: response.status
      });
    } else {
      // 非 2xx，标记失败并重试
      await handleDeliveryFailure(deliveryId, response.status, `HTTP ${response.status}`);
    }
  } catch (err) {
    const code = err.name === 'AbortError' ? 408 : 0;
    await handleDeliveryFailure(deliveryId, code, err.message);
  }
}

/**
 * 处理投递失败（重试逻辑）
 */
async function handleDeliveryFailure(deliveryId, responseCode, errorMessage) {
  const pool = getPostgres();

  const result = await pool.query(
    `SELECT attempts, max_attempts FROM webhook_deliveries WHERE id = $1`,
    [deliveryId]
  );

  if (result.rows.length === 0) return;

  const { attempts, max_attempts } = result.rows[0];
  const newAttempts = attempts + 1;

  if (newAttempts >= max_attempts) {
    // 达到最大重试次数，标记 dead letter
    await pool.query(
      `UPDATE webhook_deliveries
       SET status = 'dead', attempts = $1,
           last_response_code = $2, last_error = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [newAttempts, responseCode, errorMessage, deliveryId]
    );

    logger.warn('[WebhookService] Dead letter', { deliveryId, attempts: newAttempts });
  } else {
    // 指数退避重试
    const delay = RETRY_DELAYS[Math.min(newAttempts - 1, RETRY_DELAYS.length - 1)];
    const nextRetry = new Date(Date.now() + delay);

    await pool.query(
      `UPDATE webhook_deliveries
       SET status = 'retrying', attempts = $1,
           last_response_code = $2, last_error = $3,
           next_retry_at = $4, updated_at = NOW()
       WHERE id = $5`,
      [newAttempts, responseCode, errorMessage, nextRetry, deliveryId]
    );

    logger.info('[WebhookService] Retry scheduled', {
      deliveryId,
      attempts: newAttempts,
      nextRetry: nextRetry.toISOString()
    });
  }
}

/**
 * 手动重试失败的投递
 */
export async function retryDelivery(deliveryId, nodeId) {
  const pool = getPostgres();

  const result = await pool.query(
    `SELECT wd.*, w.url, w.secret, w.node_id
     FROM webhook_deliveries wd
     JOIN webhooks w ON wd.webhook_id = w.id
     WHERE wd.id = $1 AND w.node_id = $2
       AND wd.status IN ('failed', 'dead')`,
    [deliveryId, nodeId]
  );

  if (result.rows.length === 0) {
    throw new Error('Delivery not found or not retryable');
  }

  const delivery = result.rows[0];
  const payload = typeof delivery.payload === 'string'
    ? JSON.parse(delivery.payload)
    : delivery.payload;

  // 重置状态
  await pool.query(
    `UPDATE webhook_deliveries
     SET status = 'pending', attempts = 0, next_retry_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [deliveryId]
  );

  // 重新投递
  setImmediate(() => deliverWebhook(deliveryId, { id: delivery.webhook_id, url: delivery.url, secret: delivery.secret }, payload));

  return { success: true, deliveryId };
}

/**
 * 查询投递历史
 */
export async function listDeliveries(webhookId, nodeId, { status = null, limit = 20, offset = 0 } = {}) {
  const pool = getPostgres();

  const conditions = ['w.node_id = $1', 'wd.webhook_id = $2'];
  const params = [nodeId, webhookId];
  let paramIdx = 3;

  if (status) {
    conditions.push(`wd.status = $${paramIdx++}`);
    params.push(status);
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  const countResult = await pool.query(
    `SELECT COUNT(*) as total FROM webhook_deliveries wd
     JOIN webhooks w ON wd.webhook_id = w.id
     ${where}`,
    params
  );

  const result = await pool.query(
    `SELECT wd.id, wd.event_type, wd.payload, wd.status, wd.attempts,
            wd.last_response_code, wd.last_error, wd.next_retry_at,
            wd.created_at, wd.updated_at
     FROM webhook_deliveries wd
     JOIN webhooks w ON wd.webhook_id = w.id
     ${where}
     ORDER BY wd.created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limit, offset]
  );

  return {
    deliveries: result.rows,
    total: parseInt(countResult.rows[0].total),
    limit,
    offset
  };
}

// ==========================================
// 重试处理器（定时扫描 retrying 的投递）
// ==========================================

/**
 * 启动重试处理器
 */
export function startRetryProcessor() {
  if (processorTimer) return;

  processorTimer = setInterval(async () => {
    try {
      await processRetryQueue();
    } catch (err) {
      logger.error('[WebhookService] Retry processor error', { error: err.message });
    }
  }, PROCESSOR_INTERVAL);

  logger.info('[WebhookService] Retry processor started', { interval: PROCESSOR_INTERVAL });
}

/**
 * 停止重试处理器
 */
export function stopRetryProcessor() {
  if (processorTimer) {
    clearInterval(processorTimer);
    processorTimer = null;
    logger.info('[WebhookService] Retry processor stopped');
  }
}

/**
 * 处理到期的重试队列
 */
async function processRetryQueue() {
  let result;
  try {
    const pool = getPostgres();
    result = await pool.query(
      `SELECT wd.id as delivery_id, wd.payload, wd.attempts,
              w.id as webhook_id, w.url, w.secret
       FROM webhook_deliveries wd
       JOIN webhooks w ON wd.webhook_id = w.id
       WHERE wd.status = 'retrying'
         AND wd.next_retry_at <= NOW()
         AND w.active = true
       LIMIT 20`
    );
  } catch (err) {
    logger.warn('[WebhookService] processRetryQueue query failed', { error: err.message });
    return;
  }

  if (!result || !result.rows || result.rows.length === 0) return;

  const pool = getPostgres();
  for (const row of result.rows) {
    const payload = typeof row.payload === 'string'
      ? JSON.parse(row.payload)
      : row.payload;

    await pool.query(
      `UPDATE webhook_deliveries SET status = 'pending', updated_at = NOW() WHERE id = $1`,
      [row.delivery_id]
    );

    setImmediate(() => deliverWebhook(
      row.delivery_id,
      { id: row.webhook_id, url: row.url, secret: row.secret },
      payload
    ));
  }

  logger.info('[WebhookService] Processed retry queue', { count: result.rows.length });
}

// ==========================================
// 工具函数
// ==========================================

/**
 * 获取所有合法的事件类型
 */
export function getValidEvents() {
  return [
    // Agent 事件
    'agent.registered', 'agent.updated', 'agent.offline', 'agent.heartbeat',
    // Task 事件
    'task.created', 'task.completed', 'task.failed', 'task.cancelled',
    // Skill 事件
    'skill.registered', 'skill.updated', 'skill.purchased', 'skill.reviewed',
    // Billing 事件
    'billing.credit', 'billing.debit', 'billing.withdraw',
    // Relationship 事件
    'relationship.created', 'relationship.updated', 'relationship.trust_changed',
    // Marketplace 事件
    'marketplace.order_created', 'marketplace.order_completed', 'marketplace.order_cancelled',
    // Webhook 事件
    'webhook.delivery_failed', 'webhook.delivery_success',
  ];
}

/**
 * 验证 webhook 签名（供 SDK 使用）
 */
export function verifySignature(payload, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(`sha256=${expected}`)
  );
}
