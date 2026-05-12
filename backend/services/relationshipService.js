import { getPostgres } from '../core/dependencies.js';
import { formatResponse } from '../core/utils.js';
import logger from './loggerService.js';
import eventBus from './eventBus.js';

const VALID_TYPES = ['trusted', 'blocked', 'neutral'];

export async function updateRelationship(agent_id, related_agent_id, { type, rating } = {}) {
  if (!agent_id || !related_agent_id) {
    return formatResponse(false, null, 'agent_id 和 related_agent_id 必填');
  }
  if (agent_id === related_agent_id) {
    return formatResponse(false, null, '不能与自己建立关系');
  }
  if (type && !VALID_TYPES.includes(type)) {
    return formatResponse(false, null, `type 必须是 ${VALID_TYPES.join('/')}`);
  }

  const pgPool = getPostgres();
  try {
    let sql, params;

    if (rating !== undefined) {
      const clampedRating = Math.min(Math.max(rating, 0), 1);
      sql = `INSERT INTO agent_relationships (agent_id, related_agent_id, type, interaction_count, avg_rating, last_interaction_at, updated_at)
             VALUES ($1, $2, $3, 1, $4, NOW(), NOW())
             ON CONFLICT (agent_id, related_agent_id) DO UPDATE SET
               interaction_count = agent_relationships.interaction_count + 1,
               avg_rating = (agent_relationships.avg_rating * agent_relationships.interaction_count + $4) / (agent_relationships.interaction_count + 1),
               last_interaction_at = NOW(),
               updated_at = NOW()`;
      params = [agent_id, related_agent_id, type || 'neutral', clampedRating];
    } else {
      sql = `INSERT INTO agent_relationships (agent_id, related_agent_id, type, interaction_count, last_interaction_at, updated_at)
             VALUES ($1, $2, $3, 1, NOW(), NOW())
             ON CONFLICT (agent_id, related_agent_id) DO UPDATE SET
               interaction_count = agent_relationships.interaction_count + 1,
               last_interaction_at = NOW(),
               updated_at = NOW()`;
      params = [agent_id, related_agent_id, type || 'neutral'];
    }

    await pgPool.query(sql, params);

    if (type) {
      await pgPool.query(
        `UPDATE agent_relationships SET type = $3, updated_at = NOW() WHERE agent_id = $1 AND related_agent_id = $2`,
        [agent_id, related_agent_id, type]
      );
    }

    const result = await pgPool.query(
      `SELECT * FROM agent_relationships WHERE agent_id = $1 AND related_agent_id = $2`,
      [agent_id, related_agent_id]
    );
    eventBus.emit('relationship.created', { agent_id, related_id: related_agent_id, type: type || 'neutral' }, { sourceId: agent_id });
    return formatResponse(true, result.rows[0]);
  } catch (error) {
    logger.error('Failed to update relationship', { error: error.message, agent_id, related_agent_id });
    return formatResponse(false, null, '更新关系失败');
  }
}

export async function getRelationships(agent_id, { type } = {}) {
  const pgPool = getPostgres();
  try {
    const params = [agent_id];
    let sql = `SELECT r.*, n.name as related_name
               FROM agent_relationships r
               LEFT JOIN nodes n ON r.related_agent_id = n.node_id
               WHERE r.agent_id = $1`;
    if (type) {
      params.push(type);
      sql += ` AND r.type = $${params.length}`;
    }
    sql += ` ORDER BY r.last_interaction_at DESC NULLS LAST`;

    const result = await pgPool.query(sql, params);
    return formatResponse(true, result.rows);
  } catch (error) {
    logger.error('Failed to get relationships', { error: error.message, agent_id });
    return formatResponse(false, null, '获取关系失败');
  }
}

export async function getBlockedAgentIds(agent_id) {
  const pgPool = getPostgres();
  try {
    const result = await pgPool.query(
      `SELECT related_agent_id FROM agent_relationships WHERE agent_id = $1 AND type = 'blocked'`,
      [agent_id]
    );
    return result.rows.map(r => r.related_agent_id);
  } catch (error) {
    logger.error('Failed to get blocked agents', { error: error.message, agent_id });
    return [];
  }
}

export async function deleteRelationship(agent_id, related_agent_id) {
  const pgPool = getPostgres();
  try {
    const result = await pgPool.query(
      'DELETE FROM agent_relationships WHERE agent_id = $1 AND related_agent_id = $2',
      [agent_id, related_agent_id]
    );
    if (result.rowCount === 0) {
      return formatResponse(false, null, '关系不存在');
    }
    eventBus.emit('relationship.updated', { agent_id, related_id: related_agent_id, action: 'deleted' }, { sourceId: agent_id });
    return formatResponse(true, { deleted: true });
  } catch (error) {
    logger.error('Failed to delete relationship', { error: error.message, agent_id, related_agent_id });
    return formatResponse(false, null, '删除关系失败');
  }
}

export async function decayRelationships() {
  const pgPool = getPostgres();
  try {
    const decayResult = await pgPool.query(`
      UPDATE agent_relationships
      SET avg_rating = GREATEST(0.1, avg_rating * POWER(0.95, EXTRACT(DAY FROM NOW() - COALESCE(last_interaction_at, created_at)))),
          type = CASE WHEN avg_rating < 0.3 AND type = 'trusted' THEN 'neutral' ELSE type END,
          updated_at = NOW()
      WHERE last_interaction_at IS NOT NULL
        AND EXTRACT(DAY FROM NOW() - last_interaction_at) > 7
      RETURNING relationship_id
    `);
    if (decayResult.rowCount > 0) {
      logger.info('Trust decay applied', { decayed_count: decayResult.rowCount });
    }
    return decayResult.rowCount;
  } catch (error) {
    logger.error('Trust decay failed', { error: error.message });
    return 0;
  }
}

export async function getGlobalRelationshipStats() {
  const pgPool = getPostgres();
  try {
    const totalRes = await pgPool.query(
      `SELECT COUNT(*) as total FROM agent_relationships`
    );
    const typeRes = await pgPool.query(
      `SELECT type, COUNT(*) as count FROM agent_relationships GROUP BY type ORDER BY count DESC`
    );
    const topRes = await pgPool.query(
      `SELECT agent_id, related_agent_id, type, interaction_count, avg_rating,
              na.name AS agent_name, nb.name AS related_name
       FROM agent_relationships r
       LEFT JOIN nodes na ON r.agent_id = na.node_id
       LEFT JOIN nodes nb ON r.related_agent_id = nb.node_id
       ORDER BY r.interaction_count DESC LIMIT 50`
    );
    return formatResponse(true, {
      total: parseInt(totalRes.rows[0]?.total || '0'),
      by_type: typeRes.rows,
      top_relationships: topRes.rows
    });
  } catch (error) {
    logger.error('Failed to get global relationship stats', { error: error.message });
    return formatResponse(false, null, '获取全局关系统计失败');
  }
}

export async function getSocialGraph() {
  const pgPool = getPostgres();
  try {
    await decayRelationships();

    const nodesRes = await pgPool.query(
      `SELECT n.node_id, n.name AS agent_name, n.reputation_score AS trust_score, n.status,
              COUNT(r.related_agent_id) AS relationship_count
       FROM nodes n
       LEFT JOIN agent_relationships r ON n.node_id = r.agent_id
       GROUP BY n.node_id, n.name, n.reputation_score, n.status
       ORDER BY relationship_count DESC`
    );
    const edgesRes = await pgPool.query(
      `SELECT r.agent_id, r.related_agent_id, r.type, r.interaction_count, r.avg_rating,
              r.last_interaction_at,
              na.name AS agent_name, nb.name AS related_name
       FROM agent_relationships r
       LEFT JOIN nodes na ON r.agent_id = na.node_id
       LEFT JOIN nodes nb ON r.related_agent_id = nb.node_id
       ORDER BY r.interaction_count DESC`
    );
    return formatResponse(true, { nodes: nodesRes.rows, edges: edgesRes.rows });
  } catch (error) {
    logger.error('Failed to get social graph', { error: error.message });
    return formatResponse(false, null, '获取社交图谱失败');
  }
}
