import { getPostgres, getRedis } from '../core/dependencies.js';
import { generateUUID, calculateDistance, formatResponse } from '../core/utils.js';
import temporalClient from '../workflows/temporalClient.js';
import { chargeTask, rewardNode } from '../billing/index.js';
import logger from '../services/loggerService.js';
import { addMemory } from '../services/memoryService.js';
import { getBlockedAgentIds, updateRelationship, getRelationships } from '../services/relationshipService.js';
import { sendMessage } from '../services/agentMessageService.js';
import eventBus from '../services/eventBus.js';

const TASK_BASE_PRICE = parseFloat(process.env.TASK_BASE_PRICE || '0.01');
const MAX_TASKS_PER_NODE = parseInt(process.env.MAX_TASKS_PER_NODE || '10');
const TASK_TIMEOUT_MS = parseInt(process.env.TASK_TIMEOUT_MS || '300000');
const TASK_MAX_RETRIES = parseInt(process.env.TASK_MAX_RETRIES || '2');

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message || `Timeout after ${ms}ms`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

export async function routeTask(taskData) {
  const pgPool = getPostgres();
  const redisClient = getRedis();

  try {
    const taskId = generateUUID(`task:${Date.now()}`);

    const suitableNodes = await withTimeout(
      findSuitableNodes(taskData),
      TASK_TIMEOUT_MS,
      'Node discovery timed out'
    );

    if (suitableNodes.length === 0) {
      logger.warn('No suitable nodes found for task', { taskId, type: taskData.type, skillId: taskData.skill_id });
      return formatResponse(false, null, '没有找到合适的节点');
    }

    await pgPool.query(
      `INSERT INTO tasks (
       id, type, payload, status, caller_id, skill_id
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        taskId,
        taskData.type,
        taskData.payload || {},
        'pending',
        taskData.caller_id || null,
        taskData.skill_id
      ]
    );

    let workflowId = null;

    if (temporalClient.available) {
      try {
        const workflowHandle = await withTimeout(
          temporalClient.startTaskWorkflow(
            taskId,
            taskData.skill_id,
            taskData.payload || {},
            suitableNodes
          ),
          10000,
          'Temporal workflow start timed out'
        );
        workflowId = workflowHandle.workflowId;
        await redisClient.set(`task:${taskId}:workflow`, workflowId);
      } catch (wfError) {
        logger.warn('Temporal workflow start failed, task created without workflow', {
          taskId,
          error: wfError.message
        });
      }
    } else {
      logger.warn('Temporal unavailable, task created without workflow', { taskId });
    }

    await logTaskAction(taskId, null, 'TASK_CREATED', `Task routed to nodes: ${suitableNodes.map(n => n.node_id).join(', ')}`, 'pending');

    const response = {
      task_id: taskId,
      status: 'pending',
      nodes: suitableNodes.map(node => node.node_id)
    };
    if (workflowId) {
      response.workflow_id = workflowId;
    }
    return formatResponse(true, response);
  } catch (error) {
    logger.error('Task routing failed', { error: error.message, type: taskData.type });
    return formatResponse(false, null, '任务路由失败');
  }
}

export async function routeTaskWithRetry(taskData) {
  let lastResult;
  for (let attempt = 1; attempt <= TASK_MAX_RETRIES; attempt++) {
    lastResult = await routeTask(taskData);
    if (lastResult.success) return lastResult;

    if (attempt < TASK_MAX_RETRIES) {
      logger.warn('Retrying task routing', { attempt, maxRetries: TASK_MAX_RETRIES, type: taskData.type });
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  return lastResult;
}

export async function logTaskAction(taskId, nodeId, action, details, status) {
  const pgPool = getPostgres();
  try {
    await pgPool.query(
      `INSERT INTO task_logs (task_id, node_id, action, details, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [taskId, nodeId, action, details, status]
    );
  } catch (error) {
    logger.error('Failed to log task action', { error: error.message, taskId, action });
  }
}

export async function getTaskLogs(taskId) {
  const pgPool = getPostgres();
  try {
    const { rows } = await pgPool.query(
      `SELECT log_id, task_id, node_id, action, details, status, created_at
       FROM task_logs WHERE task_id = $1 ORDER BY created_at ASC`,
      [taskId]
    );
    return { success: true, data: rows };
  } catch (error) {
    logger.error('Failed to get task logs', { error: error.message, taskId });
    return { success: false, error: error.message };
  }
}

export async function createTask(taskData) {
  const pgPool = getPostgres();
  try {
    const id = taskData.id || require('crypto').randomUUID();
    const { rows } = await pgPool.query(
      `INSERT INTO tasks (id, type, payload, status, node_id, skill_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        id,
        taskData.type || 'general',
        taskData.payload || {},
        'pending',
        taskData.node_id || null,
        taskData.skill_id || null
      ]
    );
    eventBus.emit('task.created', { task_id: id, skill_id: taskData.skill_id || null, node_id: taskData.node_id || null }, { sourceId: taskData.node_id || null });
    return { success: true, data: rows[0] };
  } catch (error) {
    logger.error('Failed to create task', { error: error.message });
    return { success: false, error: error.message };
  }
}

export async function listTasks(filters = {}) {
  const pgPool = getPostgres();
  try {
    let sql = 'SELECT * FROM tasks WHERE 1=1';
    const params = [];
    let paramIdx = 1;

    if (filters.status) {
      sql += ` AND status = $${paramIdx++}`;
      params.push(filters.status);
    }
    if (filters.agentId || filters.node_id) {
      sql += ` AND node_id = $${paramIdx++}`;
      params.push(filters.agentId || filters.node_id);
    }

    sql += ' ORDER BY created_at DESC';

    if (filters.limit) {
      sql += ` LIMIT $${paramIdx++}`;
      params.push(parseInt(filters.limit));
    }
    if (filters.offset) {
      sql += ` OFFSET $${paramIdx++}`;
      params.push(parseInt(filters.offset));
    }

    const { rows } = await pgPool.query(sql, params);
    return { success: true, data: rows };
  } catch (error) {
    logger.error('Failed to list tasks', { error: error.message });
    return { success: false, error: error.message };
  }
}

async function findSuitableNodes(taskData) {
  const pgPool = getPostgres();
  const redisClient = getRedis();

  try {
    const onlineNodeIds = await redisClient.smembers('online_nodes');
    if (onlineNodeIds.length === 0) return [];

    let blockedIds = [];
    if (taskData.caller_id) {
      blockedIds = await getBlockedAgentIds(taskData.caller_id);
    }

    const nodes = [];
    for (const nodeId of onlineNodeIds) {
      if (blockedIds.includes(nodeId)) continue;
      if (taskData.skill_id) {
        const hasSkill = await redisClient.sismember(`node:${nodeId}:skills`, taskData.skill_id);
        if (!hasSkill) continue;
      }

      const nodeInfo = await pgPool.query(
        'SELECT node_id, name, latitude, longitude FROM nodes WHERE node_id = $1',
        [nodeId]
      );

      if (nodeInfo.rows.length > 0) {
        const load = await getNodeLoad(nodeId);
        nodes.push({ ...nodeInfo.rows[0], load });
      }
    }

    if (nodes.length === 0) return [];

    const nodeIds = nodes.map(n => n.node_id);
    let experienceMap = {};
    try {
      const expResult = await pgPool.query(
        `SELECT node_id,
           COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
           COUNT(*) as total_count
         FROM tasks
         WHERE node_id = ANY($1) AND type = $2
         GROUP BY node_id`,
        [nodeIds, taskData.type]
      );
      for (const row of expResult.rows) {
        experienceMap[row.node_id] = {
          completed: parseInt(row.completed_count),
          total: parseInt(row.total_count)
        };
      }
    } catch (expError) {
      logger.warn('Experience query failed, skipping experience scoring', { error: expError.message });
    }

    let trustedMap = {};
    if (taskData.caller_id) {
      try {
        const relResult = await pgPool.query(
          `SELECT related_agent_id, avg_rating FROM agent_relationships
           WHERE agent_id = $1 AND type = 'trusted'`,
          [taskData.caller_id]
        );
        for (const row of relResult.rows) {
          trustedMap[row.related_agent_id] = parseFloat(row.avg_rating) || 0.5;
        }
      } catch (relError) {
        logger.warn('Trust lookup failed', { error: relError.message });
      }
    }

    if (!taskData.latitude || !taskData.longitude) {
      return nodes.sort((a, b) => {
        const expA = experienceMap[a.node_id];
        const expB = experienceMap[b.node_id];
        const trustA = trustedMap[a.node_id] ? trustedMap[a.node_id] * 20 : 0;
        const trustB = trustedMap[b.node_id] ? trustedMap[b.node_id] * 20 : 0;
        const scoreA = a.load * 100 - (expA ? expA.completed : 0) - trustA;
        const scoreB = b.load * 100 - (expB ? expB.completed : 0) - trustB;
        return scoreA - scoreB;
      });
    }

    const scoredNodes = nodes.map(node => {
      const distance = calculateDistance(
        taskData.latitude, taskData.longitude,
        node.latitude, node.longitude
      );
      const distanceScore = Math.max(0, 100 - distance);
      const loadScore = Math.max(0, 100 - node.load * 100);
      const exp = experienceMap[node.node_id];
      const experienceScore = exp && exp.total > 0
        ? Math.min(100, (exp.completed / exp.total) * 50 + Math.min(exp.completed, 10) * 5)
        : 0;
      const trustBonus = trustedMap[node.node_id] ? trustedMap[node.node_id] * 100 : 0;
      const score = distanceScore * 0.35 + loadScore * 0.25 + experienceScore * 0.25 + trustBonus * 0.15;
      return { ...node, distance, score };
    });

    return scoredNodes.sort((a, b) => b.score - a.score);
  } catch (error) {
    logger.error('Failed to find suitable nodes', { error: error.message, type: taskData.type });
    return [];
  }
}

async function getNodeLoad(nodeId) {
  const redisClient = getRedis();

  try {
    const taskCount = await redisClient.xlen(`node:${nodeId}:tasks`);
    return Math.min(1, taskCount / MAX_TASKS_PER_NODE);
  } catch (error) {
    logger.error('Failed to get node load', { error: error.message, nodeId });
    return 0.5;
  }
}

export async function getTaskStatus(taskId) {
  const pgPool = getPostgres();

  try {
    const result = await pgPool.query(
      'SELECT * FROM tasks WHERE id = $1',
      [taskId]
    );

    if (result.rows.length === 0) {
      return formatResponse(false, null, '任务不存在');
    }

    return formatResponse(true, result.rows[0]);
  } catch (error) {
    logger.error('Failed to get task status', { error: error.message, taskId });
    return formatResponse(false, null, '获取任务状态失败');
  }
}

export async function updateTaskStatus(taskId, status, result = null) {
  const pgPool = getPostgres();

  try {
    await pgPool.query(
      'UPDATE tasks SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, taskId]
    );

    return formatResponse(true, { status, result });
  } catch (error) {
    logger.error('Failed to update task status', { error: error.message, taskId, status });
    return formatResponse(false, null, '更新任务状态失败');
  }
}

export async function getNodeTasks(nodeId) {
  const redisClient = getRedis();

  try {
    const tasks = await redisClient.xRange(`node:${nodeId}:tasks`, '-', '+');

    const taskList = tasks.map(task => ({
      task_id: task.message.task_id,
      type: task.message.type,
      payload: JSON.parse(task.message.payload),
      skill_id: task.message.skill_id,
      timestamp: task.id
    }));

    return formatResponse(true, taskList);
  } catch (error) {
    logger.error('Failed to get node tasks', { error: error.message, nodeId });
    return formatResponse(false, null, '获取节点任务失败');
  }
}

export async function completeTask(taskId, result, error = null) {
  const pgPool = getPostgres();
  const redisClient = getRedis();

  try {
    const taskInfo = await pgPool.query(
      'SELECT * FROM tasks WHERE id = $1',
      [taskId]
    );

    if (taskInfo.rows.length === 0) {
      return formatResponse(false, null, '任务不存在');
    }

    const task = taskInfo.rows[0];
    const status = error ? 'failed' : 'completed';
    await pgPool.query(
      'UPDATE tasks SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, taskId]
    );

    await redisClient.publish(`task:${taskId}:result`, JSON.stringify({
      success: !error,
      data: result,
      error: error
    }));

    if (status === 'completed' && task.node_id) {
      const rewardAmount = task.reward_amount || TASK_BASE_PRICE;
      const audit = { operator_id: task.node_id, reason: `task_complete:${taskId}` };
      try {
        await chargeTask(taskId, rewardAmount, audit);
      } catch (billingError) {
        logger.error('Auto chargeTask failed', { error: billingError.message, taskId });
      }
      try {
        await rewardNode(task.node_id, rewardAmount, audit);
      } catch (billingError) {
        logger.error('Auto rewardNode failed', { error: billingError.message, taskId, nodeId: task.node_id });
      }

      try {
        await addMemory({
          agent_id: task.node_id,
          type: 'interaction',
          content: `完成任务 ${taskId}: ${JSON.stringify(result).slice(0, 500)}`,
          task_id: taskId,
          importance: 0.5
        });
      } catch (memError) {
        logger.error('Auto memory write failed', { error: memError.message, taskId, nodeId: task.node_id });
      }

      if (task.caller_id) {
        try {
          await updateRelationship(task.caller_id, task.node_id, { type: 'trusted', rating: 0.8 });
          await updateRelationship(task.node_id, task.caller_id, { type: 'trusted', rating: 0.8 });
        } catch (relError) {
          logger.error('Auto relationship update failed', { error: relError.message, taskId });
        }

        try {
          const trustedRels = await getRelationships(task.node_id, { type: 'trusted' });
          if (trustedRels.success && trustedRels.data.length > 0) {
            const recommendation = `我刚完成了任务 ${taskId} (类型: ${task.type})，有类似需求可以找我`;
            for (const rel of trustedRels.data.slice(0, 5)) {
              sendMessage({
                sender_id: task.node_id,
                receiver_id: rel.related_agent_id,
                content: recommendation,
                type: 'recommendation'
              });
            }
          }
        } catch (recError) {
          logger.error('Auto recommendation failed', { error: recError.message, taskId });
        }
      }
    }

    if (status === 'failed' && task.node_id) {
      if (task.caller_id) {
        try {
          await updateRelationship(task.caller_id, task.node_id, { type: 'neutral', rating: 0.3 });
        } catch (relError) {
          logger.error('Auto relationship update failed (fail)', { error: relError.message, taskId });
        }
      }
      try {
        const trustedRels = await getRelationships(task.caller_id || task.node_id, { type: 'trusted' });
        if (trustedRels.success && trustedRels.data.length > 0) {
          const warningContent = `任务 ${taskId} (类型: ${task.type}) 执行失败`;
          const recipients = trustedRels.data.slice(0, 10);
          for (const rel of recipients) {
            sendMessage({
              sender_id: task.caller_id || task.node_id,
              receiver_id: rel.related_agent_id,
              type: 'warning',
              content: warningContent,
              task_id: taskId
            }).catch(() => {});
          }
        }
      } catch (warnError) {
        logger.error('Auto warning broadcast failed', { error: warnError.message, taskId });
      }
    }

    eventBus.emit('task.completed', { task_id: taskId, result }, { sourceId: task.node_id });
    return formatResponse(true, { status, result, error });
  } catch (err) {
    logger.error('Failed to complete task', { error: err.message, taskId });
    return formatResponse(false, null, '完成任务失败');
  }
}
