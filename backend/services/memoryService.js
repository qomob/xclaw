import { getPostgres } from '../core/dependencies.js';
import { formatResponse } from '../core/utils.js';
import logger from './loggerService.js';

const VALID_TYPES = ['interaction', 'preference', 'lesson', 'achievement'];

export async function addMemory({ agent_id, type = 'interaction', content, related_agent_id = null, task_id = null, importance = 0.5 }) {
  if (!agent_id || !content) {
    return formatResponse(false, null, 'agent_id 和 content 必填');
  }
  if (!VALID_TYPES.includes(type)) {
    return formatResponse(false, null, `type 必须是 ${VALID_TYPES.join('/')}`);
  }

  const pgPool = getPostgres();
  try {
    const result = await pgPool.query(
      `INSERT INTO agent_memories (agent_id, type, content, related_agent_id, task_id, importance)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING memory_id, agent_id, type, content, related_agent_id, task_id, importance, created_at`,
      [agent_id, type, content, related_agent_id, task_id, Math.min(Math.max(importance, 0), 1)]
    );
    return formatResponse(true, result.rows[0]);
  } catch (error) {
    logger.error('Failed to add memory', { error: error.message, agent_id });
    return formatResponse(false, null, '写入记忆失败');
  }
}

export async function getMemories(agent_id, { type, limit = 20, offset = 0 } = {}) {
  const pgPool = getPostgres();
  try {
    const params = [agent_id];
    let sql = `SELECT memory_id, agent_id, type, content, related_agent_id, task_id, importance, created_at
               FROM agent_memories WHERE agent_id = $1`;
    if (type) {
      params.push(type);
      sql += ` AND type = $${params.length}`;
    }
    sql += ` ORDER BY importance DESC, created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 100)} OFFSET ${Math.max(offset, 0)}`;

    const result = await pgPool.query(sql, params);
    return formatResponse(true, result.rows);
  } catch (error) {
    logger.error('Failed to get memories', { error: error.message, agent_id });
    return formatResponse(false, null, '获取记忆失败');
  }
}

export async function getMemoryStats(agent_id) {
  const pgPool = getPostgres();
  try {
    const result = await pgPool.query(
      `SELECT type, COUNT(*) as count, AVG(importance) as avg_importance
       FROM agent_memories WHERE agent_id = $1
       GROUP BY type ORDER BY count DESC`,
      [agent_id]
    );
    return formatResponse(true, result.rows);
  } catch (error) {
    logger.error('Failed to get memory stats', { error: error.message, agent_id });
    return formatResponse(false, null, '获取记忆统计失败');
  }
}

export async function getGlobalMemoryStats() {
  const pgPool = getPostgres();
  try {
    const totalRes = await pgPool.query(
      `SELECT COUNT(*) as total FROM agent_memories`
    );
    const typeRes = await pgPool.query(
      `SELECT type, COUNT(*) as count, AVG(importance) as avg_importance FROM agent_memories GROUP BY type ORDER BY count DESC`
    );
    const agentRes = await pgPool.query(
      `SELECT agent_id, COUNT(*) as memory_count FROM agent_memories GROUP BY agent_id ORDER BY memory_count DESC LIMIT 20`
    );
    return formatResponse(true, {
      total: parseInt(totalRes.rows[0]?.total || '0'),
      by_type: typeRes.rows,
      top_agents: agentRes.rows
    });
  } catch (error) {
    logger.error('Failed to get global memory stats', { error: error.message });
    return formatResponse(false, null, '获取全局记忆统计失败');
  }
}

export async function deleteMemory(agent_id, memory_id) {
  const pgPool = getPostgres();
  try {
    const result = await pgPool.query(
      'DELETE FROM agent_memories WHERE memory_id = $1 AND agent_id = $2',
      [memory_id, agent_id]
    );
    if (result.rowCount === 0) {
      return formatResponse(false, null, '记忆不存在或无权删除');
    }
    return formatResponse(true, { deleted: true });
  } catch (error) {
    logger.error('Failed to delete memory', { error: error.message, agent_id, memory_id });
    return formatResponse(false, null, '删除记忆失败');
  }
}
