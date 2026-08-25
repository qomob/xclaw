import { getPostgres, getRedis } from '../core/dependencies.js';
import { generateUUID, calculateDistance } from '../core/utils.js';
import logger from './loggerService.js';
import { computeTrustScore } from './socialGraphService.js';
import crypto from 'crypto';
import eventBus from './eventBus.js';
import websocketService from './websocketService.js';
import { escrowFundsInTx, adjustEscrowInTx, releaseEscrowInTx, refundEscrowInTx, invalidateBalanceCache } from '../billing/index.js';
import { logReputationEvent } from './reputationService.js';

const VERIFICATION_WINDOW_MS = (parseInt(process.env.TASK_VERIFICATION_HOURS || '24', 10)) * 60 * 60 * 1000;

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

    // 托管调额：以中标价为准（高于预算追加冻结，低于预算解冻差额）
    if (task.escrow_status === 'held') {
      const adjust = await adjustEscrowInTx(client, taskId, bid.proposed_price);
      if (!adjust.success) {
        await client.query('ROLLBACK');
        return { success: false, error: adjust.error };
      }
    }
    
    // 标记中标
    await client.query(
      `UPDATE task_bids SET status = 'accepted', updated_at = now()
       WHERE id = $1`,
      [bidId]
    );
    
    await client.query('COMMIT');

    // 事件驱动派活：向中标 Agent 推送 TASK
    try {
      websocketService.sendToAgent(bid.bidder_id, {
        type: 'TASK',
        market: true,
        task_id: taskId,
        skill_id: task.skill_id,
        price: bid.proposed_price,
        payload: task.payload || {}
      });
    } catch (pushErr) {
      logger.warn('Failed to push TASK to winner', { error: pushErr.message, taskId });
    }
    
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

    // 事件驱动派活：向自动匹配的 Agent 推送 TASK
    try {
      websocketService.sendToAgent(winner.node_id, {
        type: 'TASK',
        market: true,
        task_id: taskId,
        skill_id: task.skill_id,
        price: task.budget_max || task.budget_min || 0,
        payload: task.payload || {}
      });
    } catch (pushErr) {
      logger.warn('Failed to push TASK on auto-assign', { error: pushErr.message, taskId });
    }
    
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
  const client = await pgPool.connect();
  
  try {
    await client.query('BEGIN');
    const taskId = crypto.randomUUID();
    
    // 验证调用者
    if (!taskData.caller_id) {
      return { success: false, error: 'caller_id is required' };
    }
    
    // ── 输入校验：杜绝非法值直落数据库（此前 deadline 传数字会回裸 SQL 500）──
    const isValidDate = (v) => {
      if (v == null || v === '') return true; // 可空
      if (typeof v !== 'string') return false;
      const t = Date.parse(v);
      return !Number.isNaN(t) && Number.isFinite(t);
    };
    for (const field of ['deadline', 'bid_deadline']) {
      const v = taskData[field];
      if (v != null && v !== '') {
        if (typeof v !== 'string' || !isValidDate(v)) {
          return { success: false, error: `${field} must be a valid ISO datetime string (e.g. 2026-12-31T23:59:59Z)` };
        }
        if (new Date(v).getTime() <= Date.now()) {
          return { success: false, error: `${field} must be in the future` };
        }
      }
    }
    const budgetMax = Number(taskData.budget_max) || 0;
    const budgetMin = Number(taskData.budget_min) || 0;
    if (budgetMax < 0 || budgetMin < 0 || budgetMax > 1000000) {
      return { success: false, error: 'budget values must be between 0 and 1000000' };
    }
    if (taskData.budget_max != null && Number.isNaN(Number(taskData.budget_max))) {
      return { success: false, error: 'budget_max must be a number' };
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
    
    await client.query(
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

    // 可信结算：创建任务即冻结预算到托管（escrow）
    const escrowAmount = Math.round((parseFloat(taskData.budget_max) || 0) * 100) / 100;
    if (escrowAmount > 0) {
      const escrow = await escrowFundsInTx(client, taskId, taskData.caller_id, escrowAmount);
      if (!escrow.success) {
        await client.query('ROLLBACK');
        return { success: false, error: escrow.error };
      }
    }

    await client.query('COMMIT');
    
    logger.info('Market task created', { taskId, strategy, caller: taskData.caller_id });
    eventBus.emit('task.created', { task_id: taskId, caller_id: taskData.caller_id, escrow_amount: escrowAmount }, { sourceId: taskData.caller_id });
    
    return {
      success: true,
      data: {
        task_id: taskId,
        escrow_amount: escrowAmount,
        escrow_status: escrowAmount > 0 ? 'held' : 'none'
      }
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Failed to create market task', { error: error.message });
    return { success: false, error: error.message };
  } finally {
    client.release();
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
    
    // 提交执行结果：进入验收窗口（调用方可在截止前接受/拒绝，超时自动放行）
    const verificationDeadline = new Date(Date.now() + VERIFICATION_WINDOW_MS);
    await client.query(
      `UPDATE tasks SET 
         status = 'submitted',
         verification_status = 'pending',
         submitted_at = now(),
         verification_deadline = $3,
         result = $1,
         result_evidence = $1,
         updated_at = now()
       WHERE id = $2`,
      [JSON.stringify(result), taskId, verificationDeadline]
    );
    
    await client.query('COMMIT');
    
    logger.info('Task submitted for verification', { taskId, nodeId, deadline: verificationDeadline.toISOString() });
    eventBus.emit('task.submitted', { task_id: taskId, node_id: nodeId }, { sourceId: nodeId });
    
    return {
      success: true,
      data: {
        task_id: taskId,
        status: 'submitted',
        verification_deadline: verificationDeadline.toISOString()
      }
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to complete task', { error: error.message, taskId, nodeId });
    return { success: false, error: error.message };
  } finally {
    client.release();
  }
}

// ============================================
// 可信结算：验收 / 拒绝 / 争议 / 取消退款
// ============================================

/**
 * 调用方验收执行结果：释放托管给执行方，任务完成
 * @param {string} taskId
 * @param {string} callerId
 * @param {object} [opts] { auto: boolean } 超时自动放行标记
 */
export async function acceptTaskResult(taskId, callerId, opts = {}) {
  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const taskRes = await client.query(
      'SELECT * FROM tasks WHERE id = $1 AND caller_id = $2 FOR UPDATE',
      [taskId, callerId]
    );
    if (!taskRes.rows.length) {
      await client.query('ROLLBACK');
      return { success: false, error: '任务不存在或无权操作' };
    }
    const task = taskRes.rows[0];
    if (task.status !== 'submitted') {
      await client.query('ROLLBACK');
      return { success: false, error: `任务不在待验收状态 (${task.status})` };
    }

    // 释放托管给执行方
    const release = await releaseEscrowInTx(client, taskId, task.node_id);
    if (!release.success) {
      await client.query('ROLLBACK');
      return { success: false, error: release.error };
    }

    await client.query(
      `UPDATE tasks SET
         status = 'completed',
         verification_status = 'accepted',
         completed_at = now(),
         updated_at = now()
       WHERE id = $1`,
      [taskId]
    );

    await client.query('COMMIT');

    await invalidateBalanceCache(callerId);
    await invalidateBalanceCache(task.node_id);

    logger.info('Task result accepted', { taskId, callerId, worker: task.node_id, amount: release.amount, auto: !!opts.auto });
    eventBus.emit('task.completed', { task_id: taskId, result: task.result, worker_id: task.node_id }, { sourceId: task.node_id });

    // 声誉联动：验证通过才计入完成
    try {
      await logReputationEvent(task.node_id, 'task_completed', { task_id: taskId });
    } catch (repErr) {
      logger.warn('Reputation event failed', { error: repErr.message, taskId });
    }

    return { success: true, data: { task_id: taskId, status: 'completed', released_amount: release.amount, auto: !!opts.auto } };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Failed to accept task result', { error: error.message, taskId });
    return { success: false, error: error.message };
  } finally {
    client.release();
  }
}

/**
 * 调用方拒绝执行结果：任务进入争议，资金继续托管
 */
export async function rejectTaskResult(taskId, callerId, reason) {
  if (!reason || !String(reason).trim()) {
    return { success: false, error: '拒绝原因必填' };
  }
  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const taskRes = await client.query(
      'SELECT * FROM tasks WHERE id = $1 AND caller_id = $2 FOR UPDATE',
      [taskId, callerId]
    );
    if (!taskRes.rows.length) {
      await client.query('ROLLBACK');
      return { success: false, error: '任务不存在或无权操作' };
    }
    const task = taskRes.rows[0];
    if (task.status !== 'submitted') {
      await client.query('ROLLBACK');
      return { success: false, error: `任务不在待验收状态 (${task.status})` };
    }

    await client.query(
      `UPDATE tasks SET
         status = 'disputed',
         verification_status = 'disputed',
         dispute_reason = $2,
         updated_at = now()
       WHERE id = $1`,
      [taskId, String(reason).trim()]
    );

    const disputeRes = await client.query(
      `INSERT INTO task_disputes (task_id, opened_by, reason, status)
       VALUES ($1, $2, $3, 'open')
       RETURNING id`,
      [taskId, callerId, String(reason).trim()]
    );

    await client.query('COMMIT');

    logger.info('Task disputed', { taskId, callerId, disputeId: disputeRes.rows[0].id });
    eventBus.emit('task.disputed', { task_id: taskId, reason: String(reason).trim() }, { sourceId: callerId });

    return { success: true, data: { task_id: taskId, status: 'disputed', dispute_id: disputeRes.rows[0].id } };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Failed to reject task result', { error: error.message, taskId });
    return { success: false, error: error.message };
  } finally {
    client.release();
  }
}

/**
 * 调用方取消任务：托管资金全额退回
 */
export async function cancelMarketTaskByCaller(taskId, callerId) {
  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const taskRes = await client.query(
      'SELECT * FROM tasks WHERE id = $1 AND caller_id = $2 FOR UPDATE',
      [taskId, callerId]
    );
    if (!taskRes.rows.length) {
      await client.query('ROLLBACK');
      return { success: false, error: '任务不存在或无权操作' };
    }
    const task = taskRes.rows[0];
    if (task.status !== 'pending' && task.status !== 'open') {
      await client.query('ROLLBACK');
      return { success: false, error: `任务不可取消 (${task.status})` };
    }

    if (task.escrow_status === 'held') {
      const refund = await refundEscrowInTx(client, taskId);
      if (!refund.success) {
        await client.query('ROLLBACK');
        return { success: false, error: refund.error };
      }
    }

    await client.query(
      `UPDATE tasks SET status = 'cancelled', updated_at = now() WHERE id = $1`,
      [taskId]
    );
    await client.query(
      `UPDATE task_bids SET status = 'cancelled' WHERE task_id = $1 AND status = 'pending'`,
      [taskId]
    );

    await client.query('COMMIT');
    await invalidateBalanceCache(callerId);

    logger.info('Market task cancelled with escrow refund', { taskId, callerId });
    return { success: true, data: { task_id: taskId, status: 'cancelled', escrow_refunded: task.escrow_status === 'held' } };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Failed to cancel market task', { error: error.message, taskId });
    return { success: false, error: error.message };
  } finally {
    client.release();
  }
}

/**
 * 争议列表（管理员）
 */
export async function listDisputes({ status = null, limit = 50 } = {}) {
  const pgPool = getPostgres();
  const result = await pgPool.query(
    `SELECT d.id, d.task_id, d.opened_by, d.reason, d.evidence, d.status,
            d.resolution, d.resolved_by, d.created_at, d.resolved_at,
            t.type, t.title, t.caller_id, t.node_id, t.escrow_amount
     FROM task_disputes d
     JOIN tasks t ON t.id = d.task_id
     WHERE ($1::text IS NULL OR d.status = $1)
     ORDER BY d.created_at DESC
     LIMIT $2`,
    [status, Math.min(Math.max(parseInt(limit) || 50, 1), 200)]
  );
  return { success: true, data: result.rows };
}

/**
 * 管理员仲裁争议：释放给执行方 或 退款给调用方
 */
export async function resolveDispute(disputeId, resolution, adminId) {
  if (!['released_to_worker', 'refunded_caller'].includes(resolution)) {
    return { success: false, error: 'resolution 必须是 released_to_worker 或 refunded_caller' };
  }
  const pgPool = getPostgres();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const disputeRes = await client.query(
      `SELECT * FROM task_disputes WHERE id = $1 AND status = 'open' FOR UPDATE`,
      [disputeId]
    );
    if (!disputeRes.rows.length) {
      await client.query('ROLLBACK');
      return { success: false, error: '争议不存在或已处理' };
    }
    const dispute = disputeRes.rows[0];

    const taskRes = await client.query(
      'SELECT * FROM tasks WHERE id = $1 FOR UPDATE',
      [dispute.task_id]
    );
    if (!taskRes.rows.length) {
      await client.query('ROLLBACK');
      return { success: false, error: '关联任务不存在' };
    }
    const task = taskRes.rows[0];

    if (resolution === 'released_to_worker') {
      if (task.escrow_status === 'held') {
        const release = await releaseEscrowInTx(client, task.id, task.node_id);
        if (!release.success) {
          await client.query('ROLLBACK');
          return { success: false, error: release.error };
        }
      }
      await client.query(
        `UPDATE tasks SET
           status = 'completed',
           verification_status = 'resolved',
           resolution = 'released',
           completed_at = now(),
           updated_at = now()
         WHERE id = $1`,
        [task.id]
      );
      try { await logReputationEvent(task.node_id, 'task_completed', { task_id: task.id, dispute: true }); } catch (_) {}
    } else {
      if (task.escrow_status === 'held') {
        const refund = await refundEscrowInTx(client, task.id);
        if (!refund.success) {
          await client.query('ROLLBACK');
          return { success: false, error: refund.error };
        }
      }
      await client.query(
        `UPDATE tasks SET
           status = 'cancelled',
           verification_status = 'resolved',
           resolution = 'refunded',
           updated_at = now()
         WHERE id = $1`,
        [task.id]
      );
      try { await logReputationEvent(task.node_id, 'task_failed', { task_id: task.id, dispute: true }); } catch (_) {}
    }

    await client.query(
      `UPDATE task_disputes SET
         status = 'resolved',
         resolution = $2,
         resolved_by = $3,
         resolved_at = now(),
         updated_at = now()
       WHERE id = $1`,
      [disputeId, resolution, adminId || null]
    );

    await client.query('COMMIT');
    await invalidateBalanceCache(task.caller_id);
    if (task.node_id) await invalidateBalanceCache(task.node_id);

    logger.info('Dispute resolved', { disputeId, resolution, adminId });
    return { success: true, data: { dispute_id: disputeId, resolution, task_id: task.id } };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Failed to resolve dispute', { error: error.message, disputeId });
    return { success: false, error: error.message };
  } finally {
    client.release();
  }
}

/**
 * 处理验收超时：到期的 submitted 任务自动放行（调用方超时视为接受）
 */
export async function processVerificationDeadlines(limit = 50) {
  const pgPool = getPostgres();
  const result = await pgPool.query(
    `SELECT id AS task_id, caller_id
     FROM tasks
     WHERE verification_status = 'pending'
       AND verification_deadline <= NOW()
     LIMIT $1`,
    [Math.min(Math.max(parseInt(limit) || 50, 1), 200)]
  );

  const results = [];
  for (const row of result.rows) {
    const r = await acceptTaskResult(row.task_id, row.caller_id, { auto: true });
    results.push({ task_id: row.task_id, ...r });
  }
  return results;
}
