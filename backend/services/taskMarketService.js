import { getPostgres, getRedis } from '../core/dependencies.js';
import { generateUUID, calculateDistance } from '../core/utils.js';
import logger from './loggerService.js';
import { computeTrustScore } from './socialGraphService.js';
import crypto from 'crypto';

const CACHE_TTL = 300; // 5 分钟
const CACHE_PREFIX = 'xclaw:taskmarket:';

// ============================================
// 智能匹配引擎
// ============================================

/**
 * 计算 Agent 与任务的匹配度（0-1）
 * @param {Object} agent - Agent 完整信息
 * @param {Object} task - 任务信息
 * @returns {Object} 匹配分 + 详细 breakdown
 */
export async function computeMatchScore(agent, task) {
  const breakdown = {};
  
  // 1) 技能匹配 (0-40 分)
  let skillScore = 0;
  if (task.required_skills && task.required_skills.length > 0) {
    const agentSkills = agent.skills || [];
    const matchedSkills = task.required_skills.filter(s => agentSkills.includes(s));
    skillScore = (matchedSkills.length / task.required_skills.length) * 40;
    breakdown.skills = { matched: matchedSkills.length, total: task.required_skills.length, score: skillScore };
  } else {
    skillScore = task.skill_id && agentSkills?.includes(task.skill_id) ? 40 : 20;
    breakdown.skills = { score: skillScore };
  }
  
  // 2) 声誉匹配 (0-25 分)
  let reputationScore = 0;
  const agentReputation = parseFloat(agent.reputation_score) || 0.5;
  const minRequired = parseFloat(task.min_reputation) || 0;
  if (agentReputation >= minRequired) {
    reputationScore = Math.min(25, agentReputation * 25);
  }
  breakdown.reputation = { agent: agentReputation, required: minRequired, score: reputationScore };
  
  // 3) 经验匹配 (0-20 分)
  let experienceScore = 0;
  if (agent.task_stats) {
    const completionRate = agent.task_stats.completed / Math.max(1, agent.task_stats.total);
    const typeExperience = agent.task_stats[task.type] || 0;
    experienceScore = (completionRate * 10) + Math.min(10, typeExperience * 2);
  } else {
    experienceScore = 10;
  }
  breakdown.experience = { score: experienceScore };
  
  // 4) 可靠性匹配 (0-15 分)
  let reliabilityScore = 0;
  const isOnline = agent.status === 'online';
  const avgResponseTime = agent.avg_response_time || 30000;
  if (isOnline) {
    reliabilityScore += 8;
  }
  if (avgResponseTime < 60000) {
    reliabilityScore += 7;
  } else if (avgResponseTime < 300000) {
    reliabilityScore += 4;
  }
  breakdown.reliability = { online: isOnline, avgResponseTime, score: reliabilityScore };
  
  const totalScore = skillScore + reputationScore + experienceScore + reliabilityScore;
  
  return {
    score: totalScore,
    maxScore: 100,
    normalized: totalScore / 100,
    breakdown
  };
}

/**
 * 为任务寻找最佳匹配 Agent（自动分配模式）
 * @param {Object} task - 任务信息
 * @param {number} limit - 返回候选数量
 * @returns {Array} 排序后的候选 Agent 列表（带匹配分）
 */
export async function findBestMatches(task, limit = 5) {
  const pgPool = getPostgres();
  const redisClient = getRedis();
  
  try {
    // 获取在线节点
    const onlineNodeIds = await redisClient.smembers('online_nodes');
    if (onlineNodeIds.length === 0) {
      logger.warn('No online nodes for task matching', { taskId: task.id });
      return [];
    }
    
    // 过滤：声誉门槛
    const minRep = parseFloat(task.min_reputation) || 0;
    const qualifiedNodes = await pgPool.query(
      `SELECT node_id, name, reputation_score, status, latitude, longitude, skills, total_earnings
       FROM nodes 
       WHERE node_id = ANY($1) AND reputation_score >= $2`,
      [onlineNodeIds, minRep]
    );
    
    if (qualifiedNodes.rows.length === 0) {
      logger.warn('No nodes meet reputation requirement', { taskId: task.id, minRep });
      return [];
    }
    
    // 计算每个节点的匹配分
    const scored = [];
    for (const agent of qualifiedNodes.rows) {
      // 解析 skills 字段（可能是字符串或数组）
      if (typeof agent.skills === 'string') {
        try {
          agent.skills = JSON.parse(agent.skills);
        } catch {
          agent.skills = [];
        }
      }
      
      // 获取任务统计
      const taskStats = await pgPool.query(
        `SELECT 
           COUNT(*) FILTER (WHERE status = 'completed') as completed,
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE type = $1) as type_count
         FROM tasks 
         WHERE node_id = $2`,
        [task.type, agent.node_id]
      );
      
      agent.task_stats = {
        completed: parseInt(taskStats.rows[0].completed) || 0,
        total: parseInt(taskStats.rows[0].total) || 0,
        [task.type]: parseInt(taskStats.rows[0].type_count) || 0
      };
      
      const matchResult = await computeMatchScore(agent, task);
      scored.push({
        ...agent,
        match_score: matchResult.score,
        match_breakdown: matchResult.breakdown
      });
    }
    
    // 排序并返回 top N
    scored.sort((a, b) => b.match_score - a.match_score);
    return scored.slice(0, limit);
  } catch (error) {
    logger.error('Failed to find best matches', { error: error.message, taskId: task.id });
    return [];
  }
}

// ============================================
// 竞标系统
// ============================================

/**
 * Agent 对任务出价
 * @param {string} taskId - 任务 ID
 * @param {string} bidderId - 竞标者 ID
 * @param {Object} bidData - 竞标数据
 * @returns {Object} 竞标结果
 */
export async function placeBid(taskId, bidderId, bidData) {
  const pgPool = getPostgres();
  
  try {
    // 验证任务状态
    const taskResult = await pgPool.query(
      'SELECT * FROM tasks WHERE id = $1',
      [taskId]
    );
    
    if (taskResult.rows.length === 0) {
      return { success: false, error: 'Task not found' };
    }
    
    const task = taskResult.rows[0];
    if (task.status !== 'pending' && task.status !== 'open') {
      return { success: false, error: `Task is not open for bids (status: ${task.status})` };
    }
    
    // 检查竞标截止时间
    if (task.bid_deadline && new Date() > new Date(task.bid_deadline)) {
      return { success: false, error: 'Bid deadline has passed' };
    }
    
    // 验证竞标者
    const bidderResult = await pgPool.query(
      'SELECT * FROM nodes WHERE node_id = $1',
      [bidderId]
    );
    
    if (bidderResult.rows.length === 0) {
      return { success: false, error: 'Bidder not found' };
    }
    
    const bidder = bidderResult.rows[0];
    if (bidder.status !== 'online') {
      return { success: false, error: 'Bidder is not online' };
    }
    
    // 检查是否已出价
    const existingBid = await pgPool.query(
      'SELECT * FROM task_bids WHERE task_id = $1 AND bidder_id = $2',
      [taskId, bidderId]
    );
    
    if (existingBid.rows.length > 0 && existingBid.rows[0].status === 'pending') {
      return { success: false, error: 'You have already placed a bid on this task' };
    }
    
    // 计算匹配分
    const matchResult = await computeMatchScore(bidder, task);
    
    // 插入/更新竞标
    const bidId = crypto.randomUUID();
    await pgPool.query(
      `INSERT INTO task_bids (id, task_id, bidder_id, proposed_price, estimated_duration, proposal, match_score, score_breakdown)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (task_id, bidder_id) DO UPDATE SET
         proposed_price = EXCLUDED.proposed_price,
         estimated_duration = EXCLUDED.estimated_duration,
         proposal = EXCLUDED.proposal,
         match_score = EXCLUDED.match_score,
         score_breakdown = EXCLUDED.score_breakdown,
         updated_at = now()
       RETURNING *`,
      [
        bidId,
        taskId,
        bidderId,
        bidData.proposed_price,
        bidData.estimated_duration || 0,
        bidData.proposal || '',
        matchResult.score,
        JSON.stringify(matchResult.breakdown)
      ]
    );
    
    logger.info('Bid placed', { taskId, bidderId, price: bidData.proposed_price, matchScore: matchResult.score });
    
    return {
      success: true,
      data: {
        bid_id: bidId,
        match_score: matchResult.score,
        message: 'Bid placed successfully'
      }
    };
  } catch (error) {
    logger.error('Failed to place bid', { error: error.message, taskId, bidderId });
    return { success: false, error: error.message };
  }
}

/**
 * 获取任务的所有竞标
 * @param {string} taskId - 任务 ID
 * @returns {Array} 竞标列表（按匹配分排序）
 */
export async function getTaskBids(taskId) {
  const pgPool = getPostgres();
  
  try {
    const result = await pgPool.query(
      `SELECT b.*, n.name as bidder_name, n.reputation_score
       FROM task_bids b
       JOIN nodes n ON b.bidder_id = n.node_id
       WHERE b.task_id = $1 AND b.status = 'pending'
       ORDER BY b.match_score DESC, b.proposed_price ASC`,
      [taskId]
    );
    
    return {
      success: true,
      data: result.rows
    };
  } catch (error) {
    logger.error('Failed to get task bids', { error: error.message, taskId });
    return { success: false, error: error.message };
  }
}

/**
 * 接受竞标（任务发布者选择中标者）
 * @param {string} taskId - 任务 ID
 * @param {string} bidId - 竞标 ID
 * @param {string} callerId - 任务发布者 ID
 * @returns {Object} 结果
 */
export async function acceptBid(taskId, bidId, callerId) {
  const pgPool = getPostgres();
  const client = await pgPool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 验证任务归属
    const taskResult = await client.query(
      'SELECT * FROM tasks WHERE id = $1 AND caller_id = $2',
      [taskId, callerId]
    );
    
    if (taskResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Task not found or not authorized' };
    }
    
    const task = taskResult.rows[0];
    if (task.status !== 'pending' && task.status !== 'open') {
      await client.query('ROLLBACK');
      return { success: false, error: 'Task is not in bid phase' };
    }
    
    // 验证竞标
    const bidResult = await client.query(
      'SELECT * FROM task_bids WHERE id = $1 AND task_id = $2 AND status = $3',
      [bidId, taskId, 'pending']
    );
    
    if (bidResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Bid not found or already processed' };
    }
    
    const bid = bidResult.rows[0];
    
    // 拒绝其他竞标
    await client.query(
      `UPDATE task_bids SET status = 'rejected', updated_at = now()
       WHERE task_id = $1 AND id != $2 AND status = 'pending'`,
      [taskId, bidId]
    );
    
    // 更新任务状态
    await client.query(
      `UPDATE tasks SET 
         status = 'assigned',
         node_id = $1,
         reward_amount = $2,
         assigned_at = now(),
         updated_at = now()
       WHERE id = $3`,
      [bid.bidder_id, bid.proposed_price, taskId]
    );
    
    // 标记中标
    await client.query(
      `UPDATE task_bids SET status = 'accepted', updated_at = now()
       WHERE id = $1`,
      [bidId]
    );
    
    await client.query('COMMIT');
    
    logger.info('Bid accepted', { taskId, bidId, winner: bid.bidder_id, price: bid.proposed_price });
    
    return {
      success: true,
      data: {
        task_id: taskId,
        winner_id: bid.bidder_id,
        price: bid.proposed_price
      }
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to accept bid', { error: error.message, taskId, bidId });
    return { success: false, error: error.message };
  } finally {
    client.release();
  }
}

/**
 * 自动分配任务（基于匹配分）
 * @param {string} taskId - 任务 ID
 * @returns {Object} 分配结果
 */
export async function autoAssignTask(taskId) {
  const pgPool = getPostgres();
  
  try {
    // 获取任务
    const taskResult = await pgPool.query(
      'SELECT * FROM tasks WHERE id = $1',
      [taskId]
    );
    
    if (taskResult.rows.length === 0) {
      return { success: false, error: 'Task not found' };
    }
    
    const task = taskResult.rows[0];
    if (task.status !== 'pending' && task.status !== 'open') {
      return { success: false, error: `Task is not available for assignment (status: ${task.status})` };
    }
    
    // 寻找最佳匹配
    const matches = await findBestMatches(task, 3);
    
    if (matches.length === 0) {
      return { success: false, error: 'No suitable agents found' };
    }
    
    const winner = matches[0];
    
    // 更新任务
    await pgPool.query(
      `UPDATE tasks SET 
         status = 'assigned',
         node_id = $1,
         reward_amount = $2,
         assigned_at = now(),
         updated_at = now()
       WHERE id = $3`,
      [winner.node_id, task.budget_max || task.budget_min || 0, taskId]
    );
    
    logger.info('Task auto-assigned', { taskId, winner: winner.node_id, matchScore: winner.match_score });
    
    return {
      success: true,
      data: {
        task_id: taskId,
        assigned_to: winner.node_id,
        agent_name: winner.name,
        match_score: winner.match_score
      }
    };
  } catch (error) {
    logger.error('Failed to auto-assign task', { error: error.message, taskId });
    return { success: false, error: error.message };
  }
}

// ============================================
// 任务市场浏览
// ============================================

/**
 * 浏览任务市场（分页 + 筛选）
 * @param {Object} filters - 筛选条件
 * @returns {Object} 任务列表 + 分页信息
 */
export async function browseTasks(filters = {}) {
  const pgPool = getPostgres();
  
  try {
    let sql = `
      SELECT t.*, 
             c.name as caller_name,
             n.name as worker_name,
             (SELECT COUNT(*) FROM task_bids WHERE task_id = t.id AND status = 'pending') as bid_count
      FROM tasks t
      LEFT JOIN nodes c ON t.caller_id = c.node_id
      LEFT JOIN nodes n ON t.node_id = n.node_id
      WHERE 1=1
    `;
    
    const params = [];
    let paramIdx = 1;
    
    if (filters.status) {
      sql += ` AND t.status = $${paramIdx++}`;
      params.push(filters.status);
    }
    
    if (filters.type) {
      sql += ` AND t.type = $${paramIdx++}`;
      params.push(filters.type);
    }
    
    if (filters.skill_id) {
      sql += ` AND t.skill_id = $${paramIdx++}`;
      params.push(filters.skill_id);
    }
    
    if (filters.min_budget) {
      sql += ` AND t.budget_max >= $${paramIdx++}`;
      params.push(parseFloat(filters.min_budget));
    }
    
    if (filters.max_budget) {
      sql += ` AND t.budget_min <= $${paramIdx++}`;
      params.push(parseFloat(filters.max_budget));
    }
    
    if (filters.require_bids) {
      sql += ` AND t.assignment_strategy = 'bid'`;
    }
    
    sql += ' ORDER BY t.priority DESC, t.created_at DESC';
    
    const limit = parseInt(filters.limit) || 20;
    const offset = parseInt(filters.offset) || 0;
    
    sql += ` LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);
    
    const result = await pgPool.query(sql, params);
    
    // 获取总数
    const countConditions = [];
    const countParams = [];
    if (filters.status) {
      countConditions.push(`t.status = $${countParams.length + 1}`);
      countParams.push(filters.status);
    }
    if (filters.type) {
      countConditions.push(`t.type = $${countParams.length + 1}`);
      countParams.push(filters.type);
    }
    const countSql = `SELECT COUNT(*) as total FROM tasks t ${
      countConditions.length > 0 ? 'WHERE ' + countConditions.join(' AND ') : ''
    }`;
    const countResult = await pgPool.query(countSql, countParams);
    
    return {
      success: true,
      data: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].total),
        limit,
        offset,
        hasMore: offset + limit < parseInt(countResult.rows[0].total)
      }
    };
  } catch (error) {
    logger.error('Failed to browse tasks', { error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * 获取任务市场统计
 * @returns {Object} 市场统计数据
 */
export async function getMarketStats() {
  const pgPool = getPostgres();
  
  try {
    const [taskStatsResult, bidStatsResult, hotSkillsResult, avgBidsResult] = await Promise.all([
      pgPool.query(`
        SELECT
          COUNT(*) as total_tasks,
          COUNT(*) FILTER (WHERE status IN ('open', 'pending')) as open_tasks,
          COUNT(*) FILTER (WHERE status = 'assigned') as assigned_tasks,
          COUNT(*) FILTER (WHERE status = 'completed') as completed_tasks,
          COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_tasks,
          COALESCE(SUM(budget_min), 0) as total_budget_min,
          COALESCE(SUM(budget_max), 0) as total_budget_max,
          COALESCE(AVG(budget_min), 0) as avg_budget_min,
          COALESCE(AVG(budget_max), 0) as avg_budget_max,
          COUNT(DISTINCT caller_id) as unique_caller_count,
          COUNT(DISTINCT node_id) as unique_worker_count
        FROM tasks
      `),
      pgPool.query(`
        SELECT COUNT(*) as active_bids FROM task_bids WHERE status = 'pending'
      `),
      pgPool.query(`
        SELECT skill_id, s.name as skill_name, COUNT(*) as task_count
        FROM tasks t
        LEFT JOIN skills s ON t.skill_id = s.id
        WHERE t.skill_id IS NOT NULL AND t.status IN ('pending', 'open', 'assigned')
        GROUP BY skill_id, s.name
        ORDER BY task_count DESC
        LIMIT 10
      `),
      pgPool.query(`
        SELECT AVG(bid_count) as avg_bids_per_task
        FROM (
          SELECT task_id, COUNT(*) as bid_count
          FROM task_bids
          WHERE status = 'pending'
          GROUP BY task_id
        ) sub
      `)
    ]);

    const taskStats = taskStatsResult.rows[0] || {};
    const stats = {
      ...taskStats,
      active_bids: parseInt(bidStatsResult.rows[0]?.active_bids) || 0
    };

    // 刷新 task_market_stats 派生表（federationService 兼容读取）
    await pgPool.query(
      `INSERT INTO task_market_stats
        (id, total_tasks, open_tasks, assigned_tasks, completed_tasks, cancelled_tasks,
         active_bids, total_budget_min, total_budget_max, avg_budget_min, avg_budget_max,
         unique_caller_count, unique_worker_count, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       ON CONFLICT (id) DO UPDATE SET
         total_tasks = EXCLUDED.total_tasks,
         open_tasks = EXCLUDED.open_tasks,
         assigned_tasks = EXCLUDED.assigned_tasks,
         completed_tasks = EXCLUDED.completed_tasks,
         cancelled_tasks = EXCLUDED.cancelled_tasks,
         active_bids = EXCLUDED.active_bids,
         total_budget_min = EXCLUDED.total_budget_min,
         total_budget_max = EXCLUDED.total_budget_max,
         avg_budget_min = EXCLUDED.avg_budget_min,
         avg_budget_max = EXCLUDED.avg_budget_max,
         unique_caller_count = EXCLUDED.unique_caller_count,
         unique_worker_count = EXCLUDED.unique_worker_count,
         updated_at = NOW()`,
      [
        parseInt(taskStats.total_tasks) || 0,
        parseInt(taskStats.open_tasks) || 0,
        parseInt(taskStats.assigned_tasks) || 0,
        parseInt(taskStats.completed_tasks) || 0,
        parseInt(taskStats.cancelled_tasks) || 0,
        parseInt(stats.active_bids) || 0,
        parseFloat(taskStats.total_budget_min) || 0,
        parseFloat(taskStats.total_budget_max) || 0,
        parseFloat(taskStats.avg_budget_min) || 0,
        parseFloat(taskStats.avg_budget_max) || 0,
        parseInt(taskStats.unique_caller_count) || 0,
        parseInt(taskStats.unique_worker_count) || 0
      ]
    );
    
    return {
      success: true,
      data: {
        ...stats,
        hot_skills: hotSkillsResult.rows,
        avg_bids_per_task: parseFloat(avgBidsResult.rows[0].avg_bids_per_task) || 0
      }
    };
  } catch (error) {
    logger.error('Failed to get market stats', { error: error.message });
    return { success: false, error: error.message };
  }
}

// ============================================
// 任务生命周期管理
// ============================================

/**
 * 创建任务（市场模式）
 * @param {Object} taskData - 任务数据
 * @returns {Object} 创建结果
 */
export async function createMarketTask(taskData) {
  const pgPool = getPostgres();
  
  try {
    const taskId = crypto.randomUUID();
    
    // 验证调用者
    if (!taskData.caller_id) {
      return { success: false, error: 'caller_id is required' };
    }
    
    const callerResult = await pgPool.query(
      'SELECT * FROM nodes WHERE node_id = $1',
      [taskData.caller_id]
    );
    
    if (callerResult.rows.length === 0) {
      return { success: false, error: 'Caller not found' };
    }
    
    // 确定分配策略
    let strategy = taskData.assignment_strategy || 'auto';
    if (strategy === 'bid' && !taskData.bid_deadline) {
      // 默认竞标截止时间为 24 小时后
      taskData.bid_deadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    }
    
    await pgPool.query(
      `INSERT INTO tasks (
        id, type, title, description, payload, status, caller_id, skill_id,
        budget_min, budget_max, deadline, assignment_strategy, required_skills,
        priority, min_reputation, bid_deadline, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now(), now())
      RETURNING *`,
      [
        taskId,
        taskData.type || 'general',
        taskData.title || '',
        taskData.description || '',
        taskData.payload || {},
        taskData.assignment_strategy === 'direct' ? 'assigned' : 'open',
        taskData.caller_id,
        taskData.skill_id || null,
        taskData.budget_min || 0,
        taskData.budget_max || 0,
        taskData.deadline || null,
        strategy,
        JSON.stringify(taskData.required_skills || []),
        taskData.priority || 5,
        taskData.min_reputation || 0,
        taskData.bid_deadline || null
      ]
    );
    
    logger.info('Market task created', { taskId, strategy, caller: taskData.caller_id });
    
    return {
      success: true,
      data: { task_id: taskId }
    };
  } catch (error) {
    logger.error('Failed to create market task', { error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * 完成任务
 * @param {string} taskId - 任务 ID
 * @param {string} nodeId - 执行者 ID
 * @param {Object} result - 任务结果
 * @returns {Object} 完成结果
 */
export async function completeMarketTask(taskId, nodeId, result) {
  const pgPool = getPostgres();
  const client = await pgPool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 验证任务归属
    const taskResult = await client.query(
      'SELECT * FROM tasks WHERE id = $1 AND node_id = $2',
      [taskId, nodeId]
    );
    
    if (taskResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Task not found or not authorized' };
    }
    
    const task = taskResult.rows[0];
    if (task.status !== 'assigned' && task.status !== 'running') {
      await client.query('ROLLBACK');
      return { success: false, error: `Task is not in progress (status: ${task.status})` };
    }
    
    // 更新任务状态
    await client.query(
      `UPDATE tasks SET 
         status = 'completed',
         result = $1,
         completed_at = now(),
         updated_at = now()
       WHERE id = $2`,
      [JSON.stringify(result), taskId]
    );
    
    await client.query('COMMIT');
    
    logger.info('Task completed', { taskId, nodeId });
    
    return { success: true };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to complete task', { error: error.message, taskId, nodeId });
    return { success: false, error: error.message };
  } finally {
    client.release();
  }
}
