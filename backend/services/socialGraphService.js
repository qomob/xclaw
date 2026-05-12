/**
 * socialGraphService.js — 社交图谱 v2 引擎
 *
 * 信任评分 + 关系推荐 + 社区发现
 * 为 Agent 网络提供智能社交能力
 */
import { getPostgres } from '../core/dependencies.js';
import { getRedis } from '../core/dependencies.js';
import { formatResponse } from '../core/utils.js';
import logger from './loggerService.js';
import eventBus from './eventBus.js';

// ─── 常量 ────────────────────────────────────────────────────────

const TRUST_CACHE_PREFIX = 'xclaw:trust:';
const TRUST_CACHE_TTL = 300; // 5 分钟缓存

/** 信任评分权重配置 */
const TRUST_WEIGHTS = {
  interaction_count: 0.20,  // 交互次数
  avg_rating: 0.25,         // 平均评分
  task_completion: 0.20,    // 任务完成率
  reputation: 0.15,         // 全局声誉
  recency: 0.10,            // 时效性（最近交互）
  diversity: 0.10,          // 交互多样性（不同类型交互）
};

/** 信任衰减参数 */
const DECAY = {
  half_life_days: 30,       // 信任半衰期 30 天
  min_trust: 0.05,          // 最低信任阈值
  max_trust: 1.0,           // 最高信任
};

/** 推荐参数 */
const RECOMMEND = {
  max_results: 20,
  similarity_threshold: 0.5,
  diversity_penalty: 0.15,
};

// ─── 信任评分引擎 ─────────────────────────────────────────────────

/**
 * 计算两个 Agent 之间的综合信任评分
 * 多维度加权: 交互频率 + 评分 + 任务完成率 + 声誉 + 时效性 + 多样性
 *
 * @param {string} agentId - 源 Agent
 * @param {string} relatedId - 目标 Agent
 * @returns {Promise<{ trust_score: number, breakdown: object }>}
 */
export async function computeTrustScore(agentId, relatedId) {
  const pgPool = getPostgres();
  const redis = getRedis();

  // 1. 检查缓存
  const cacheKey = `${TRUST_CACHE_PREFIX}${agentId}:${relatedId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch { /* cache miss, compute */ }

  // 2. 查询关系数据
  const relRes = await pgPool.query(
    `SELECT type, interaction_count, avg_rating, last_interaction_at, created_at
     FROM agent_relationships
     WHERE agent_id = $1 AND related_agent_id = $2`,
    [agentId, relatedId]
  );

  if (relRes.rows.length === 0) {
    return { trust_score: 0, breakdown: { reason: 'no_relationship' } };
  }

  const rel = relRes.rows[0];

  // 3. 查询目标 Agent 声誉
  const nodeRes = await pgPool.query(
    `SELECT reputation_score FROM nodes WHERE node_id = $1`,
    [relatedId]
  );
  const reputation = nodeRes.rows[0]?.reputation_score || 0.5;

  // 4. 查询任务协作统计
  const taskRes = await pgPool.query(
    `SELECT COUNT(*) FILTER (WHERE t.status = 'completed') AS completed,
            COUNT(*) AS total
     FROM tasks t
     JOIN agent_relationships ar ON ar.agent_id = $1 AND ar.related_agent_id = $2
     WHERE t.node_id = $2 AND t.status IN ('completed', 'failed')`,
    [agentId, relatedId]
  );
  const taskCompletion = taskRes.rows[0]?.total > 0
    ? parseInt(taskRes.rows[0].completed) / parseInt(taskRes.rows[0].total)
    : 0.5;

  // 5. 计算各维度分数
  const scores = {
    interaction_count: Math.min(rel.interaction_count / 50, 1),  // 50 次交互满分
    avg_rating: rel.avg_rating || 0.5,
    task_completion: taskCompletion,
    reputation: reputation,
    recency: _computeRecency(rel.last_interaction_at),
    diversity: _computeDiversity(agentId, relatedId),
  };

  // 6. 加权求和
  let trustScore = 0;
  for (const [dim, weight] of Object.entries(TRUST_WEIGHTS)) {
    trustScore += (scores[dim] || 0) * weight;
  }

  // 7. 如果关系类型是 blocked，大幅降低
  if (rel.type === 'blocked') {
    trustScore *= 0.1;
  }
  // 如果是 trusted，小幅加成
  if (rel.type === 'trusted') {
    trustScore = Math.min(trustScore * 1.15, DECAY.max_trust);
  }

  trustScore = Math.round(Math.max(DECAY.min_trust, Math.min(trustScore, DECAY.max_trust)) * 1000) / 1000;

  const result = {
    trust_score: trustScore,
    breakdown: {
      ...scores,
      relationship_type: rel.type,
      interaction_count_raw: rel.interaction_count,
      weights: TRUST_WEIGHTS,
    },
  };

  // 8. 缓存
  await redis.set(cacheKey, JSON.stringify(result), { EX: TRUST_CACHE_TTL });

  return result;
}

/**
 * 批量计算一个 Agent 的所有信任评分
 * @param {string} agentId
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {string} [opts.minTrust=0.3]
 * @returns {Promise<object[]>}
 */
export async function batchComputeTrustScores(agentId, opts = {}) {
  const pgPool = getPostgres();
  const limit = opts.limit || 50;
  const minTrust = opts.minTrust || 0.3;

  const res = await pgPool.query(
    `SELECT related_agent_id FROM agent_relationships
     WHERE agent_id = $1
     ORDER BY interaction_count DESC
     LIMIT $2`,
    [agentId, limit]
  );

  const results = [];
  for (const row of res.rows) {
    const trust = await computeTrustScore(agentId, row.related_agent_id);
    if (trust.trust_score >= minTrust) {
      // 获取目标 Agent 基本信息
      const agentRes = await pgPool.query(
        `SELECT node_id, name, capabilities, reputation_score, status FROM nodes WHERE node_id = $1`,
        [row.related_agent_id]
      );
      if (agentRes.rows[0]) {
        results.push({
          ...agentRes.rows[0],
          ...trust,
        });
      }
    }
  }

  return results.sort((a, b) => b.trust_score - a.trust_score);
}

/**
 * 应用信任衰减 — 时间越久未交互，信任越低
 * @returns {Promise<number>} 衰减的关系数量
 */
export async function applyTrustDecay() {
  const pgPool = getPostgres();
  const halfLifeMs = DECAY.half_life_days * 24 * 60 * 60 * 1000;

  const res = await pgPool.query(
    `UPDATE agent_relationships
     SET avg_rating = GREATEST($1, avg_rating * POWER(0.5, EXTRACT(EPOCH FROM (NOW() - last_interaction_at)) / $2)),
         updated_at = NOW()
     WHERE last_interaction_at < NOW() - INTERVAL '7 days'
       AND avg_rating > $1
     RETURNING relationship_id`,
    [DECAY.min_trust, halfLifeMs / 1000]
  );

  // 清除所有信任缓存
  try {
    const redis = getRedis();
    let cursor = 0;
    do {
      const result = await redis.scan(cursor, { MATCH: `${TRUST_CACHE_PREFIX}*`, COUNT: 100 });
      cursor = result.cursor;
      if (result.keys.length > 0) {
        await redis.del(result.keys);
      }
    } while (cursor !== 0);
  } catch { /* non-critical */ }

  logger.info('Trust decay applied', { count: res.rows.length });
  return res.rows.length;
}

// ─── 关系推荐系统 ─────────────────────────────────────────────────

/**
 * 推荐潜在关系 — 基于协同过滤 + 语义相似度
 *
 * 策略：
 * 1. 找到与目标 Agent 有相似关系的 Agent (协同过滤)
 * 2. 找到能力相似的 Agent (语义相似度)
 * 3. 排除已有关系
 * 4. 多样性惩罚（避免推荐太多同一类型）
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {number} [opts.limit=10]
 * @returns {Promise<object>}
 */
export async function recommendRelationships(agentId, opts = {}) {
  const pgPool = getPostgres();
  const limit = opts.limit || RECOMMEND.max_results;

  // 1. 获取已有关系（排除用）
  const existingRes = await pgPool.query(
    `SELECT related_agent_id FROM agent_relationships WHERE agent_id = $1`,
    [agentId]
  );
  const existingIds = new Set(existingRes.rows.map(r => r.related_agent_id));
  existingIds.add(agentId); // 排除自己

  // 2. 协同过滤：找"我的好友的好友"
  const cfRes = await pgPool.query(
    `WITH my_relations AS (
       SELECT related_agent_id FROM agent_relationships
       WHERE agent_id = $1 AND type != 'blocked'
     )
     SELECT ar.related_agent_id, COUNT(*) AS mutual_count,
            AVG(ar.avg_rating) AS avg_mutual_rating
     FROM agent_relationships ar
     JOIN my_relations mr ON ar.agent_id = mr.related_agent_id
     WHERE ar.related_agent_id != $1
       AND ar.type != 'blocked'
     GROUP BY ar.related_agent_id
     ORDER BY mutual_count DESC, avg_mutual_rating DESC
     LIMIT 30`,
    [agentId]
  );

  // 3. 语义相似度：基于 embedding 找能力相似的 Agent
  let semanticResults = [];
  try {
    const embRes = await pgPool.query(
      `SELECT capability_vector FROM node_embeddings WHERE node_id = $1`,
      [agentId]
    );
    if (embRes.rows[0]?.capability_vector) {
      const simRes = await pgPool.query(
        `SELECT ne.node_id,
                1 - (ne.capability_vector <=> $1) AS similarity
         FROM node_embeddings ne
         WHERE ne.node_id != $2
         ORDER BY ne.capability_vector <=> $1
         LIMIT 20`,
        [embRes.rows[0].capability_vector, agentId]
      );
      semanticResults = simRes.rows;
    }
  } catch (err) {
    logger.warn('Semantic similarity lookup failed in recommend', { error: err.message });
  }

  // 4. 合并得分
  const candidates = new Map();

  for (const row of cfRes.rows) {
    if (existingIds.has(row.related_agent_id)) continue;
    const score = row.mutual_count * 0.4 + (row.avg_mutual_rating || 0.5) * 0.3;
    candidates.set(row.related_agent_id, { score, source: 'collaborative', mutual_count: row.mutual_count });
  }

  for (const row of semanticResults) {
    if (existingIds.has(row.node_id)) continue;
    const existing = candidates.get(row.node_id) || { score: 0, source: '' };
    existing.score += parseFloat(row.similarity) * 0.3;
    existing.source = existing.source ? `${existing.source}+semantic` : 'semantic';
    existing.similarity = parseFloat(row.similarity);
    candidates.set(row.node_id, existing);
  }

  // 5. 排序取 top N
  const sorted = [...candidates.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit);

  // 6. 获取候选 Agent 详情
  const results = [];
  for (const [candId, scoreData] of sorted) {
    const agentRes = await pgPool.query(
      `SELECT node_id, name, capabilities, tags, reputation_score, status FROM nodes WHERE node_id = $1`,
      [candId]
    );
    if (agentRes.rows[0]) {
      results.push({
        ...agentRes.rows[0],
        recommendation_score: Math.round(scoreData.score * 1000) / 1000,
        recommendation_source: scoreData.source,
        mutual_connections: scoreData.mutual_count || 0,
        semantic_similarity: scoreData.similarity || null,
      });
    }
  }

  return formatResponse(true, results);
}

// ─── 社区发现 ─────────────────────────────────────────────────────

/**
 * 基于标签传播的社区发现
 * 利用关系图 + 语义相似度对 Agent 进行聚类
 *
 * @param {object} [opts]
 * @param {number} [opts.minCommunitySize=3] - 最小社区大小
 * @returns {Promise<object>}
 */
export async function discoverCommunities(opts = {}) {
  const pgPool = getPostgres();
  const minSize = opts.minCommunitySize || 3;

  // 1. 获取所有关系边
  const edgesRes = await pgPool.query(
    `SELECT agent_id, related_agent_id, avg_rating, interaction_count, type
     FROM agent_relationships
     WHERE type != 'blocked'
     ORDER BY interaction_count DESC`
  );

  if (edgesRes.length === 0) {
    return formatResponse(true, { communities: [], total_communities: 0 });
  }

  // 2. 构建邻接表
  const adjacency = new Map();
  const allNodes = new Set();

  for (const edge of edgesRes.rows) {
    allNodes.add(edge.agent_id);
    allNodes.add(edge.related_agent_id);

    if (!adjacency.has(edge.agent_id)) adjacency.set(edge.agent_id, new Map());
    if (!adjacency.has(edge.related_agent_id)) adjacency.set(edge.related_agent_id, new Map());

    const weight = (edge.avg_rating || 0.5) * Math.log2(edge.interaction_count + 1);
    adjacency.get(edge.agent_id).set(edge.related_agent_id, weight);
    adjacency.get(edge.related_agent_id).set(edge.agent_id, weight);
  }

  // 3. 简化标签传播算法 (Label Propagation)
  const labels = new Map();
  const nodes = [...allNodes];

  // 初始化：每个节点的标签是自身
  for (const node of nodes) {
    labels.set(node, node);
  }

  // 迭代传播（最多 20 轮）
  for (let iter = 0; iter < 20; iter++) {
    let changed = 0;
    // 随机顺序遍历
    const shuffled = [...nodes].sort(() => Math.random() - 0.5);

    for (const node of shuffled) {
      const neighbors = adjacency.get(node);
      if (!neighbors || neighbors.size === 0) continue;

      // 统计邻居标签的加权投票
      const labelScores = new Map();
      for (const [neighbor, weight] of neighbors) {
        const label = labels.get(neighbor);
        labelScores.set(label, (labelScores.get(label) || 0) + weight);
      }

      // 选择得分最高的标签
      let bestLabel = labels.get(node);
      let bestScore = 0;
      for (const [label, score] of labelScores) {
        if (score > bestScore) {
          bestScore = score;
          bestLabel = label;
        }
      }

      if (bestLabel !== labels.get(node)) {
        labels.set(node, bestLabel);
        changed++;
      }
    }

    if (changed === 0) break; // 收敛
  }

  // 4. 提取社区
  const communityMap = new Map();
  for (const [node, label] of labels) {
    if (!communityMap.has(label)) communityMap.set(label, []);
    communityMap.get(label).push(node);
  }

  // 5. 过滤小社区，获取 Agent 详情
  const communities = [];
  let communityIdx = 0;

  for (const [label, members] of communityMap) {
    if (members.length < minSize) continue;

    const agentDetails = await pgPool.query(
      `SELECT node_id, name, capabilities, tags, reputation_score, status
       FROM nodes WHERE node_id = ANY($1)`,
      [members]
    );

    // 计算社区内的连接密度
    let internalEdges = 0;
    for (const member of members) {
      const neighbors = adjacency.get(member);
      if (neighbors) {
        for (const other of members) {
          if (neighbors.has(other)) internalEdges++;
        }
      }
    }
    const maxEdges = members.length * (members.length - 1);
    const density = maxEdges > 0 ? internalEdges / maxEdges : 0;

    communities.push({
      community_id: ++communityIdx,
      member_count: members.length,
      density: Math.round(density * 1000) / 1000,
      members: agentDetails.rows,
    });
  }

  return formatResponse(true, {
    communities: communities.sort((a, b) => b.member_count - a.member_count),
    total_communities: communities.length,
    total_agents: nodes.length,
    algorithm: 'label_propagation',
  });
}

/**
 * 获取社交图谱的聚合统计
 * @returns {Promise<object>}
 */
export async function getSocialGraphStats() {
  const pgPool = getPostgres();

  const [
    nodesRes,
    edgesRes,
    typeRes,
    topAgentsRes,
    avgRatingRes,
  ] = await Promise.all([
    pgPool.query('SELECT COUNT(DISTINCT agent_id) as count FROM agent_relationships'),
    pgPool.query('SELECT COUNT(*) as count FROM agent_relationships'),
    pgPool.query(
      `SELECT type, COUNT(*) as count, AVG(avg_rating) as avg_rating, AVG(interaction_count) as avg_interactions
       FROM agent_relationships GROUP BY type ORDER BY count DESC`
    ),
    pgPool.query(
      `SELECT n.node_id, n.name, n.reputation_score, COUNT(ar.relationship_id) as relation_count
       FROM nodes n
       JOIN agent_relationships ar ON ar.agent_id = n.node_id
       GROUP BY n.node_id, n.name, n.reputation_score
       ORDER BY relation_count DESC LIMIT 10`
    ),
    pgPool.query('SELECT AVG(avg_rating) as global_avg_rating FROM agent_relationships'),
  ]);

  return formatResponse(true, {
    total_agents_with_relations: parseInt(nodesRes.rows[0].count),
    total_edges: parseInt(edgesRes.rows[0].count),
    global_avg_rating: parseFloat(avgRatingRes.rows[0]?.global_avg_rating || 0).toFixed(3),
    relationship_types: typeRes.rows.map(r => ({
      type: r.type,
      count: parseInt(r.count),
      avg_rating: parseFloat(r.avg_rating || 0).toFixed(3),
      avg_interactions: parseFloat(r.avg_interactions || 0).toFixed(1),
    })),
    top_connected_agents: topAgentsRes.rows,
  });
}

// ─── 内部工具函数 ─────────────────────────────────────────────────

/** 计算时效性分数 — 最近交互得高分，指数衰减 */
function _computeRecency(lastInteractionAt) {
  if (!lastInteractionAt) return 0;
  const hoursSince = (Date.now() - new Date(lastInteractionAt).getTime()) / (1000 * 60 * 60);
  return Math.exp(-hoursSince / (24 * 7)); // 7 天半衰期
}

/** 计算交互多样性 — 通过不同类型任务/交互的丰富度 */
async function _computeDiversity(agentId, relatedId) {
  const pgPool = getPostgres();
  try {
    const res = await pgPool.query(
      `SELECT COUNT(DISTINCT t.type) AS type_count, COUNT(DISTINCT m.type) AS msg_types
       FROM (SELECT 1) AS dummy
       LEFT JOIN tasks t ON t.node_id = $2
       LEFT JOIN agent_messages m ON (m.sender_id = $1 AND m.receiver_id = $2)
            OR (m.sender_id = $2 AND m.receiver_id = $1)`,
      [agentId, relatedId]
    );
    const typeCount = parseInt(res.rows[0]?.type_count || 0) + parseInt(res.rows[0]?.msg_types || 0);
    return Math.min(typeCount / 5, 1); // 5 种类型满分
  } catch {
    return 0.5; // 默认
  }
}
