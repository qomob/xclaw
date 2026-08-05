import { getPostgres, getRedis } from '../core/dependencies.js';
import { formatResponse } from '../core/utils.js';
import logger from './loggerService.js';
import websocketService from './websocketService.js';
import encryptionService from './encryptionService.js';

// 离线消息队列前缀
const OFFLINE_QUEUE_PREFIX = 'xclaw:offline:';
const OFFLINE_MAX_AGE_HOURS = parseInt(process.env.OFFLINE_MESSAGE_MAX_AGE_HOURS || '72');

/**
 * 检查接收方是否在线
 */
async function isAgentOnline(receiver_id) {
  // 先检查 WebSocket 连接（最准确）
  const ws = websocketService.wsConnections.get(receiver_id);
  if (ws && ws.readyState === 1) {
    return true;
  }
  
  // 其次检查 Redis 状态
  const redis = getRedis();
  try {
    const status = await redis.get(`xclaw:agent:${receiver_id}:status`);
    return status === 'online';
  } catch {
    return false;
  }
}

/**
 * 发送消息（支持加密存储 + 离线队列）
 */
export async function sendMessage({ sender_id, receiver_id, type = 'info', content, task_id = null, encrypt = true }) {
  if (!sender_id || !receiver_id || !content) {
    return formatResponse(false, null, 'sender_id, receiver_id, content 必填');
  }
  const pgPool = getPostgres();
  const redis = getRedis();
  
  try {
    // 加密内容（可选）
    let encrypted = null;
    let contentToStore = content;
    
    if (encrypt) {
      encrypted = encryptionService.encryptMessage({ content, type, sender_id, task_id }, receiver_id);
      contentToStore = JSON.stringify(encrypted);
    }
    
    // 存入数据库
    const result = await pgPool.query(
      `INSERT INTO agent_messages (sender_id, receiver_id, type, content, task_id, encrypted)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING message_id, sender_id, receiver_id, type, content, task_id, read, created_at`,
      [sender_id, receiver_id, type, contentToStore, task_id, encrypt]
    );
    const msg = result.rows[0];
    
    // 检查接收方是否在线
    const online = await isAgentOnline(receiver_id);
    
    if (online) {
      // 在线：直接通过 WebSocket 推送（已加密）
      websocketService.sendToAgent(receiver_id, {
        type: 'AGENT_MESSAGE',
        data: { ...msg, encrypted }
      });
    } else {
      // 离线：加入离线消息队列（Redis List）
      const queueKey = OFFLINE_QUEUE_PREFIX + receiver_id;
      const msgWithMeta = {
        message_id: msg.message_id,
        sender_id,
        type,
        encrypted,
        task_id,
        queued_at: new Date().toISOString()
      };
      await redis.lpush(queueKey, JSON.stringify(msgWithMeta));
      await redis.expire(queueKey, OFFLINE_MAX_AGE_HOURS * 3600);
      logger.info('Message queued for offline agent', { receiver_id, message_id: msg.message_id });
    }
    
    return formatResponse(true, { ...msg, online, queued: !online });
  } catch (error) {
    logger.error('Failed to send agent message', { error: error.message, sender_id, receiver_id });
    return formatResponse(false, null, '发送消息失败');
  }
}

export async function getMessages(agent_id, { unread_only = false, limit = 50, offset = 0 } = {}) {
  const pgPool = getPostgres();
  try {
    const params = [agent_id];
    let sql = `SELECT m.message_id, m.sender_id, m.receiver_id, m.type, m.content, m.task_id, m.read, m.created_at,
               n.name as sender_name
               FROM agent_messages m
               LEFT JOIN nodes n ON n.node_id = m.sender_id
               WHERE m.receiver_id = $1`;
    if (unread_only) {
      sql += ` AND m.read = FALSE`;
    }
    sql += ` ORDER BY m.created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 200)} OFFSET ${Math.max(offset, 0)}`;
    const result = await pgPool.query(sql, params);
    return formatResponse(true, result.rows);
  } catch (error) {
    logger.error('Failed to get messages', { error: error.message, agent_id });
    return formatResponse(false, null, '获取消息失败');
  }
}

export async function markMessagesRead(agent_id, message_ids = null) {
  const pgPool = getPostgres();
  try {
    let sql = `UPDATE agent_messages SET read = TRUE WHERE receiver_id = $1 AND read = FALSE`;
    const params = [agent_id];
    if (message_ids && message_ids.length > 0) {
      sql += ` AND message_id = ANY($2)`;
      params.push(message_ids);
    }
    const result = await pgPool.query(sql, params);
    return formatResponse(true, { updated: result.rowCount });
  } catch (error) {
    logger.error('Failed to mark messages read', { error: error.message, agent_id });
    return formatResponse(false, null, '标记已读失败');
  }
}

export async function getUnreadCount(agent_id) {
  const pgPool = getPostgres();
  try {
    const result = await pgPool.query(
      `SELECT COUNT(*) as count FROM agent_messages WHERE receiver_id = $1 AND read = FALSE`,
      [agent_id]
    );
    return formatResponse(true, { count: parseInt(result.rows[0].count) });
  } catch (error) {
    logger.error('Failed to get unread count', { error: error.message, agent_id });
    return formatResponse(false, null, '获取未读数失败');
  }
}

/**
 * 取回离线消息队列中的消息
 */
export async function dequeueOfflineMessages(agent_id, limit = 50) {
  const redis = getRedis();
  const queueKey = OFFLINE_QUEUE_PREFIX + agent_id;
  
  try {
    const messages = await redis.lrange(queueKey, 0, limit - 1);
    if (messages.length === 0) {
      return formatResponse(true, { messages: [], count: 0 });
    }
    
    const decrypted = [];
    let successfulCount = 0;
    for (const m of messages) {
      try {
        const parsed = JSON.parse(m);
        if (parsed.encrypted) {
          const decryptedData = encryptionService.decryptMessage(parsed.encrypted, agent_id);
          decrypted.push({ ...parsed, decrypted_content: decryptedData });
        } else {
          decrypted.push(parsed);
        }
        successfulCount++;
      } catch {
        // 解析/解密失败的消息保留在队列中，避免数据丢失
        logger.warn('Failed to parse/dequeue offline message', { agent_id });
      }
    }
    
    // 仅移除成功交付的消息
    if (successfulCount > 0) {
      await redis.ltrim(queueKey, successfulCount, -1);
    }
    
    return formatResponse(true, { messages: decrypted, count: decrypted.length });
  } catch (error) {
    logger.error('Failed to dequeue offline messages', { error: error.message, agent_id });
    return formatResponse(false, null, '取回离线消息失败');
  }
}

/**
 * 解密消息内容
 */
export function decryptMessageContent(encryptedPayload, agentId) {
  try {
    return encryptionService.decryptMessage(encryptedPayload, agentId);
  } catch (error) {
    logger.error('Message decryption failed', { error: error.message, agentId });
    return null;
  }
}

/**
 * 获取离线消息队列长度
 */
export async function getOfflineQueueLength(agent_id) {
  const redis = getRedis();
  try {
    const len = await redis.llen(OFFLINE_QUEUE_PREFIX + agent_id);
    return formatResponse(true, { count: len });
  } catch (error) {
    logger.error('Failed to get offline queue length', { error: error.message, agent_id });
    return formatResponse(false, null, '获取离线队列长度失败');
  }
}
