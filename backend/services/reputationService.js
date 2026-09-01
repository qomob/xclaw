import { getPostgres, getRedis } from '../core/dependencies.js';
import logger from './loggerService.js';

// ==========================================
// 常量配置
// ==========================================
const CACHE_TTL = 300; // 5 分钟缓存
const CACHE_PREFIX = 'xclaw:reputation:';
const LEADERBOARD_KEY = 'xclaw:reputation:leaderboard';
const HISTORY_TABLE = 'reputation_history';
const REPUTATION_CHANGE_LOG = 'reputation_events';

// 声誉因子权重
const WEIGHTS = {
  task_completion: 0.30,   // 任务完成率
  review_score: 0.25,      // 用户评分
  reliability: 0.20,       // 可靠性（订单完成率 + 在线时长）
  social_trust: 0.15,      // 社交信任度
  earnings: 0.10,          // 收入贡献（归一化）
};

// 时间衰减参数
const DECAY_HALF_LIFE_DAYS = 90; // 90 天半衰期
const DECAY_LAMBDA = Math.log(2) / DECAY_HALF_LIFE_DAYS;

// ==========================================
// 数据库迁移（创建声誉历史表）
// ==========================================
export async function ensureReputationTables() {
  const pool = getPostgres();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      node_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
      old_score NUMERIC(5,4) NOT NULL,
      new_score NUMERIC(5,4) NOT NULL,
      delta NUMERIC(5,4) NOT NULL,
      reason VARCHAR(100) NOT NULL,
      details JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_rep_history_node ON ${HISTORY_TABLE}(node_id);
    CREATE INDEX IF NOT EXISTS idx_rep_history_created ON ${HISTORY_TABLE}(created_at);

    CREATE TABLE IF NOT EXISTS ${REPUTATION_CHANGE_LOG} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      node_id UUID NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
      event_type VARCHAR(50) NOT NULL,
      event_data JSONB DEFAULT '{}',
      impact NUMERIC(5,4) NOT NULL DEFAULT 0,
      processed BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_rep_events_node ON ${REPUTATION_CHANGE_LOG}(node_id);
    CREATE INDEX IF NOT EXISTS idx_rep_events_processed ON ${REPUTATION_CHANGE_LOG}(processed) WHERE NOT processed;
  `);
  logger.info('Reputation tables ensured');
}

// ==========================================
// 核心声誉计算引擎
// ==========================================

/**
 * 时间衰减函数 — 近期行为权重更高
 */
function timeDecay(daysAgo) {
  return Math.exp(-DECAY_LAMBDA * daysAgo);
}

/**
 * 归一化到 [0, 1]
 */
function normalize(value, min, max) {
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/**
 * 计算单个 Agent 的完整声誉分
 * 返回 { score, factors: { task_completion, review_score, reliability, social_trust, earnings } }
 */
export async function computeReputation(nodeId) {
  const pool = getPostgres();

  // ── 因子1: 任务完成率 ──
  const taskResult = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed,
      COUNT(*) FILTER (WHERE status = 'timeout') AS timed_out,
      COUNT(*) AS total,
      COALESCE(
        AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600)
          FILTER (WHERE status = 'completed'),
        0
      ) AS avg_completion_hours
    FROM tasks
    WHERE node_id = $1
      AND created_at > now() - INTERVAL '180 days'
  `, [nodeId]);

  const taskRow = taskResult.rows[0] || {};
  const taskTotal = parseInt(taskRow.total) || 0;
  const taskCompleted = parseInt(taskRow.completed) || 0;
  const taskFailed = parseInt(taskRow.failed) || 0;
  const taskTimedOut = parseInt(taskRow.timed_out) || 0;

  // 完成率 + 惩罚超时
  let taskScore = taskTotal > 0
    ? (taskCompleted * 1.0 - taskTimedOut * 0.3 - taskFailed * 0.2) / taskTotal
    : 0.5; // 无任务记录给中间分
  taskScore = Math.max(0, Math.min(1, taskScore));

  // ── 因子2: 用户评分（时间加权） ──
  const reviewResult = await pool.query(`
    SELECT
      COALESCE(
        SUM(r.rating * r.weighted_rating * EXP(-0.01 * EXTRACT(DAY FROM now() - r.created_at)))
        / NULLIF(SUM(r.weighted_rating * EXP(-0.01 * EXTRACT(DAY FROM now() - r.created_at))), 0),
        3.0
      ) AS weighted_avg_rating,
      COUNT(*) AS total_reviews
    FROM skill_reviews r
    JOIN skills s ON s.id = r.skill_id
    WHERE s.node_id = $1
      AND r.created_at > now() - INTERVAL '180 days'
  `, [nodeId]);

  const reviewRow = reviewResult.rows[0] || {};
  const rawRating = parseFloat(reviewRow.weighted_avg_rating) || 3.0;
  const reviewScore = normalize(rawRating, 1, 5); // 1星→0, 5星→1
  const totalReviews = parseInt(reviewRow.total_reviews) || 0;

  // ── 因子3: 可靠性（订单完成率 + 在线率） ──
  const orderResult = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed,
      COUNT(*) FILTER (WHERE status = 'refunded') AS refunded,
      COUNT(*) AS total
    FROM orders
    WHERE seller_id = $1
      AND created_at > now() - INTERVAL '180 days'
  `, [nodeId]);

  const orderRow = orderResult.rows[0] || {};
  const orderTotal = parseInt(orderRow.total) || 0;
  const orderCompleted = parseInt(orderRow.completed) || 0;
  const orderRefunded = parseInt(orderRow.refunded) || 0;

  // 完成率 - 退款惩罚
  let orderScore = orderTotal > 0
    ? (orderCompleted - orderRefunded * 0.5) / orderTotal
    : 0.5;
  orderScore = Math.max(0, Math.min(1, orderScore));

  // 在线率（基于心跳更新时间和当前状态）
  const heartbeatResult = await pool.query(`
    SELECT
      last_heartbeat,
      status,
      EXTRACT(EPOCH FROM (now() - last_heartbeat)) / 86400 AS days_since_heartbeat
    FROM nodes
    WHERE node_id = $1
  `, [nodeId]);

  const hbRow = heartbeatResult.rows[0] || {};
  const daysSince = parseFloat(hbRow.days_since_heartbeat) || 999;
  // 心跳越近越可靠：1天=1.0, 7天=0.7, 30天=0.3, 90天+=0.1
  const onlineRate = hbRow.status === 'online' ? 1.0
    : daysSince <= 1 ? 0.9
    : daysSince <= 7 ? 0.7
    : daysSince <= 30 ? 0.4
    : 0.1;
  const reliabilityScore = orderScore * 0.7 + onlineRate * 0.3;

  // ── 因子4: 社交信任度 ──
  const socialResult = await pool.query(`
    SELECT
      COALESCE(AVG(avg_rating), 0.5) AS avg_peer_rating,
      COUNT(*) AS relationship_count,
      COUNT(*) FILTER (WHERE type = 'trusted') AS trusted_count,
      COUNT(*) FILTER (WHERE type = 'blocked') AS blocked_count
    FROM agent_relationships
    WHERE related_agent_id = $1
  `, [nodeId]);

  const socialRow = socialResult.rows[0] || {};
  const peerRating = parseFloat(socialRow.avg_peer_rating) || 0.5;
  const trustedCount = parseInt(socialRow.trusted_count) || 0;
  const blockedCount = parseInt(socialRow.blocked_count) || 0;
  const relCount = parseInt(socialRow.relationship_count) || 0;

  // 信任/屏蔽比例 + 同行评分
  const trustRatio = relCount > 0
    ? Math.max(0, (trustedCount - blockedCount * 2) / Math.max(relCount, 1))
    : 0.5;
  const socialTrustScore = normalize(peerRating, 0, 1) * 0.6 + Math.max(0, Math.min(1, trustRatio)) * 0.4;

  // ── 因子5: 收入贡献（对数归一化） ──
  const earningResult = await pool.query(`
    SELECT COALESCE(total_earnings, 0) AS total_earnings FROM nodes WHERE node_id = $1
  `, [nodeId]);

  const rawEarnings = parseFloat(earningResult.rows[0]?.total_earnings) || 0;
  // 对数归一化：$0→0.1, $100→0.3, $1000→0.5, $10000→0.7, $100000→0.9
  const earningsScore = rawEarnings > 0
    ? Math.min(1, 0.1 + 0.2 * Math.log10(Math.max(rawEarnings, 1)))
    : 0.1;

  // ── 加权合成 ──
  const compositeScore =
    taskScore * WEIGHTS.task_completion +
    reviewScore * WEIGHTS.review_score +
    reliabilityScore * WEIGHTS.reliability +
    socialTrustScore * WEIGHTS.social_trust +
    earningsScore * WEIGHTS.earnings;

  // 映射到 [1.0, 5.0] 区间（与现有 reputation_score numeric(3,2) 兼容 → 扩展为 4 位小数）
  // 但为了向后兼容，输出 [0.0, 5.0]
  const finalScore = Math.round(compositeScore * 5 * 10000) / 10000; // 4位小数

  return {
    score: finalScore,
    maxScore: 5.0,
    composite: compositeScore,
    factors: {
      task_completion: {
        score: taskScore,
        weight: WEIGHTS.task_completion,
        details: { total: taskTotal, completed: taskCompleted, failed: taskFailed, timedOut: taskTimedOut },
      },
      review_score: {
        score: reviewScore,
        weight: WEIGHTS.review_score,
        details: { avgRating: Math.round(rawRating * 100) / 100, totalReviews },
      },
      reliability: {
        score: reliabilityScore,
        weight: WEIGHTS.reliability,
        details: { orderRate: Math.round(orderScore * 100) / 100, onlineRate: Math.round(onlineRate * 100) / 100 },
      },
      social_trust: {
        score: socialTrustScore,
        weight: WEIGHTS.social_trust,
        details: { peerRating: Math.round(peerRating * 100) / 100, trusted: trustedCount, blocked: blockedCount, total: relCount },
      },
      earnings: {
        score: earningsScore,
        weight: WEIGHTS.earnings,
        details: { totalEarnings: rawEarnings },
      },
    },
  };
}

// ==========================================
// 声誉更新与持久化
// ==========================================

/**
 * 重新计算并更新 Agent 声誉
 */
export async function updateReputation(nodeId, reason = 'periodic', details = {}) {
  const pool = getPostgres();

  // 获取旧分数
  const oldResult = await pool.query(
    'SELECT reputation_score FROM nodes WHERE node_id = $1',
    [nodeId]
  );
  const oldScore = parseFloat(oldResult.rows[0]?.reputation_score) || 1.0;

  // 计算新分数
  const reputation = await computeReputation(nodeId);
  const newScore = reputation.score;

  // 更新 nodes 表
  await pool.query(
    'UPDATE nodes SET reputation_score = $1, updated_at = now() WHERE node_id = $2',
    [newScore, nodeId]
  );

  // 记录历史
  const delta = newScore - oldScore;
  await pool.query(
    `INSERT INTO ${HISTORY_TABLE} (node_id, old_score, new_score, delta, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [nodeId, oldScore, newScore, delta, reason, JSON.stringify({
      ...details,
      factors: Object.fromEntries(
        Object.entries(reputation.factors).map(([k, v]) => [k, v.score])
      ),
    })]
  );

  // 更新 Redis 排行榜
  try {
    const redis = getRedis();
    await redis.zadd(LEADERBOARD_KEY, newScore, nodeId);
    // 缓存详细数据
    await redis.set(`${CACHE_PREFIX}${nodeId}`, JSON.stringify(reputation), { EX: CACHE_TTL });
  } catch (e) {
    logger.warn('Redis cache update failed', { error: e.message });
  }

  logger.info('Reputation updated', {
    nodeId,
    oldScore: oldScore.toFixed(4),
    newScore: newScore.toFixed(4),
    delta: delta.toFixed(4),
    reason,
  });

  return { oldScore, newScore, delta, reputation };
}

/**
 * 记录声誉事件（异步批量处理）
 */
export async function logReputationEvent(nodeId, eventType, eventData = {}) {
  const pool = getPostgres();
  // 快速估算影响
  const impactMap = {
    task_completed: 0.02,
    task_failed: -0.03,
    task_timeout: -0.02,
    task_slashed: -0.10, // 保证金罚没：仲裁认定违约的强负分
    order_completed: 0.03,
    order_failed: -0.04,
    order_refunded: -0.05,
    review_received_positive: 0.02,  // rating >= 4
    review_received_negative: -0.03, // rating <= 2
    trust_gained: 0.01,
    trust_lost: -0.02,
    block_received: -0.03,
  };
  const impact = impactMap[eventType] || 0;

  await pool.query(
    `INSERT INTO ${REPUTATION_CHANGE_LOG} (node_id, event_type, event_data, impact)
     VALUES ($1, $2, $3, $4)`,
    [nodeId, eventType, JSON.stringify(eventData), impact]
  );

  return { eventType, impact };
}

// ==========================================
// 声誉排行榜
// ==========================================

/**
 * 获取全局声誉排行榜
 */
export async function getLeaderboard({ limit = 50, offset = 0, tag = null } = {}) {
  const pool = getPostgres();

  let tagFilter = '';
  const params = [limit, offset];
  if (tag) {
    tagFilter = 'AND $3 = ANY(SELECT jsonb_array_elements_text(tags))';
    params.push(tag);
  }

  const result = await pool.query(`
    SELECT
      node_id, name, capabilities, tags, reputation_score,
      total_earnings, status,
      RANK() OVER (ORDER BY reputation_score DESC) AS rank
    FROM nodes
    WHERE status != 'suspended' ${tagFilter}
    ORDER BY reputation_score DESC
    LIMIT $1 OFFSET $2
  `, params);

  // 获取总数
  const countResult = await pool.query(
    `SELECT COUNT(*) AS total FROM nodes WHERE status != 'suspended' ${tagFilter}`,
    tag ? [tag] : []
  );

  return {
    leaderboard: result.rows.map(row => ({
      ...row,
      reputation_score: parseFloat(row.reputation_score),
      total_earnings: parseFloat(row.total_earnings),
      rank: parseInt(row.rank),
    })),
    total: parseInt(countResult.rows[0]?.total) || 0,
    limit,
    offset,
  };
}

/**
 * 获取 Agent 声誉排名
 */
export async function getNodeRank(nodeId) {
  const pool = getPostgres();

  const result = await pool.query(`
    SELECT rank FROM (
      SELECT node_id, RANK() OVER (ORDER BY reputation_score DESC) AS rank
      FROM nodes WHERE status != 'suspended'
    ) ranked
    WHERE node_id = $1
  `, [nodeId]);

  return result.rows[0]?.rank || null;
}

// ==========================================
// 声誉历史
// ==========================================

/**
 * 获取声誉变更历史
 */
export async function getReputationHistory(nodeId, { limit = 50, offset = 0, reason = null } = {}) {
  const pool = getPostgres();

  let reasonFilter = '';
  const params = [nodeId, limit, offset];
  if (reason) {
    reasonFilter = 'AND reason = $4';
    params.push(reason);
  }

  const result = await pool.query(`
    SELECT id, old_score, new_score, delta, reason, details, created_at
    FROM ${HISTORY_TABLE}
    WHERE node_id = $1 ${reasonFilter}
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3
  `, params);

  return result.rows.map(row => ({
    ...row,
    old_score: parseFloat(row.old_score),
    new_score: parseFloat(row.new_score),
    delta: parseFloat(row.delta),
    details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
  }));
}

/**
 * 获取声誉趋势（最近 N 天的日粒度变化）
 */
export async function getReputationTrend(nodeId, days = 30) {
  const pool = getPostgres();

  const result = await pool.query(`
    SELECT
      DATE(created_at) AS date,
      FIRST_VALUE(new_score) OVER (PARTITION BY DATE(created_at) ORDER BY created_at DESC) AS score,
      SUM(delta) AS daily_delta,
      COUNT(*) AS changes
    FROM ${HISTORY_TABLE}
    WHERE node_id = $1
      AND created_at > now() - INTERVAL '${parseInt(days)} days'
    GROUP BY DATE(created_at), new_score
    ORDER BY DATE(created_at) ASC
  `, [nodeId]);

  return result.rows.map(row => ({
    date: row.date,
    score: parseFloat(row.score),
    delta: parseFloat(row.daily_delta),
    changes: parseInt(row.changes),
  }));
}

// ==========================================
// 批量计算（后台定时任务）
// ==========================================

/**
 * 批量更新所有在线节点的声誉
 */
export async function batchUpdateReputations({ batchSize = 50, onlyOnline = true } = {}) {
  const pool = getPostgres();

  const statusFilter = onlyOnline ? "AND status = 'online'" : '';
  const nodesResult = await pool.query(`
    SELECT node_id FROM nodes
    WHERE 1=1 ${statusFilter}
    ORDER BY updated_at ASC
    LIMIT $1
  `, [batchSize]);

  const results = [];
  for (const row of nodesResult.rows) {
    try {
      const result = await updateReputation(row.node_id, 'batch_update');
      results.push({ nodeId: row.node_id, ...result });
    } catch (err) {
      logger.error('Batch reputation update failed for node', {
        nodeId: row.node_id,
        error: err.message,
      });
      results.push({ nodeId: row.node_id, error: err.message });
    }
  }

  logger.info('Batch reputation update completed', {
    total: results.length,
    errors: results.filter(r => r.error).length,
  });

  return results;
}

// ==========================================
// 声誉事件处理（待处理事件 → 增量更新）
// ==========================================

/**
 * 处理待处理的声誉事件
 * 对于小幅事件，使用增量更新而非全量重算
 */
export async function processPendingEvents({ batchSize = 100 } = {}) {
  const pool = getPostgres();

  // 获取待处理事件，按 node_id 聚合
  const eventsResult = await pool.query(`
    SELECT node_id, COUNT(*) AS event_count, SUM(impact) AS total_impact
    FROM ${REPUTATION_CHANGE_LOG}
    WHERE processed = false
    GROUP BY node_id
    ORDER BY SUM(ABS(impact)) DESC
    LIMIT $1
  `, [batchSize]);

  const results = [];
  for (const row of eventsResult.rows) {
    const { node_id, event_count, total_impact } = row;
    const cumulativeImpact = parseFloat(total_impact) || 0;

    try {
      if (Math.abs(cumulativeImpact) >= 0.05) {
        // 影响较大 → 全量重算
        const result = await updateReputation(node_id, 'event_trigger', {
          eventCount: parseInt(event_count),
          cumulativeImpact,
        });
        results.push({ nodeId: node_id, mode: 'full', ...result });
      } else {
        // 影响较小 → 增量更新
        const currentResult = await pool.query(
          'SELECT reputation_score FROM nodes WHERE node_id = $1',
          [node_id]
        );
        const currentScore = parseFloat(currentResult.rows[0]?.reputation_score) || 1.0;
        const newScore = Math.max(0, Math.min(5, currentScore + cumulativeImpact));

        await pool.query(
          'UPDATE nodes SET reputation_score = $1, updated_at = now() WHERE node_id = $2',
          [newScore, node_id]
        );

        await pool.query(
          `INSERT INTO ${HISTORY_TABLE} (node_id, old_score, new_score, delta, reason, details)
           VALUES ($1, $2, $3, $4, 'incremental', $5)`,
          [node_id, currentScore, newScore, cumulativeImpact, JSON.stringify({ eventCount: parseInt(event_count) })]
        );

        results.push({
          nodeId: node_id,
          mode: 'incremental',
          oldScore: currentScore,
          newScore,
          delta: cumulativeImpact,
        });
      }

      // 标记事件已处理
      await pool.query(
        `UPDATE ${REPUTATION_CHANGE_LOG} SET processed = true WHERE node_id = $1 AND processed = false`,
        [node_id]
      );
    } catch (err) {
      logger.error('Process pending events failed', { nodeId: node_id, error: err.message });
      results.push({ nodeId: node_id, error: err.message });
    }
  }

  return results;
}

// ==========================================
// 声誉统计
// ==========================================

/**
 * 获取全局声誉统计
 */
export async function getReputationStats() {
  const pool = getPostgres();

  const statsResult = await pool.query(`
    SELECT
      COUNT(*) AS total_agents,
      AVG(reputation_score) AS avg_reputation,
      MAX(reputation_score) AS max_reputation,
      MIN(reputation_score) AS min_reputation,
      STDDEV(reputation_score) AS stddev_reputation,
      COUNT(*) FILTER (WHERE reputation_score >= 4.0) AS top_agents,
      COUNT(*) FILTER (WHERE reputation_score >= 3.0 AND reputation_score < 4.0) AS good_agents,
      COUNT(*) FILTER (WHERE reputation_score >= 2.0 AND reputation_score < 3.0) AS average_agents,
      COUNT(*) FILTER (WHERE reputation_score < 2.0) AS low_agents
    FROM nodes
    WHERE status != 'suspended'
  `);

  // 最近更新统计
  const recentResult = await pool.query(`
    SELECT
      COUNT(*) AS updates_last_24h,
      AVG(ABS(delta)) AS avg_delta
    FROM ${HISTORY_TABLE}
    WHERE created_at > now() - INTERVAL '24 hours'
  `);

  const stats = statsResult.rows[0] || {};
  const recent = recentResult.rows[0] || {};

  return {
    distribution: {
      total: parseInt(stats.total_agents) || 0,
      average: parseFloat(stats.avg_reputation) || 0,
      max: parseFloat(stats.max_reputation) || 0,
      min: parseFloat(stats.min_reputation) || 0,
      stddev: parseFloat(stats.stddev_reputation) || 0,
      tiers: {
        top: parseInt(stats.top_agents) || 0,       // >= 4.0
        good: parseInt(stats.good_agents) || 0,     // 3.0 - 4.0
        average: parseInt(stats.average_agents) || 0, // 2.0 - 3.0
        low: parseInt(stats.low_agents) || 0,       // < 2.0
      },
    },
    recentActivity: {
      updatesLast24h: parseInt(recent.updates_last_24h) || 0,
      avgDelta: parseFloat(recent.avg_delta) || 0,
    },
  };
}

/**
 * 获取 Agent 详细声誉画像
 */
export async function getReputationProfile(nodeId) {
  const pool = getPostgres();

  // 缓存检查
  try {
    const redis = getRedis();
    const cached = await redis.get(`${CACHE_PREFIX}${nodeId}`);
    if (cached) {
      const parsed = JSON.parse(cached);
      const rank = await getNodeRank(nodeId);
      return { ...parsed, rank, cached: true };
    }
  } catch (e) { /* fall through */ }

  // 完整计算
  const reputation = await computeReputation(nodeId);
  const rank = await getNodeRank(nodeId);

  // 获取最近变化
  const recentChanges = await getReputationHistory(nodeId, { limit: 5 });

  // 获取节点基本信息
  const nodeResult = await pool.query(
    'SELECT name, capabilities, tags, status, total_earnings, created_at FROM nodes WHERE node_id = $1',
    [nodeId]
  );
  const nodeInfo = nodeResult.rows[0] || {};

  return {
    nodeId,
    name: nodeInfo.name,
    capabilities: nodeInfo.capabilities,
    tags: nodeInfo.tags || [],
    status: nodeInfo.status,
    rank,
    reputation,
    totalEarnings: parseFloat(nodeInfo.total_earnings) || 0,
    memberSince: nodeInfo.created_at,
    recentChanges,
  };
}
