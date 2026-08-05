// API 管理文件
import express from 'express';
import rateLimit from 'express-rate-limit';
import config from '../core/config.js';
import { registerNode, getNode, discoverNodes, handleHeartbeat, getOnlineNodes } from '../registry/nodeRegistry.js';
import { registerSkill, getSkill, searchSkills, getNodeSkills, getSkillCategories } from '../registry/skillRegistry.js';
import { routeTask, getTaskStatus, completeTask, updateTaskStatus, createTask, listTasks, getTaskLogs } from '../router/taskRouter.js';
import { formatResponse, validateParams } from '../core/utils.js';
import { getRedis, checkPostgresHealth, checkRedisHealth, getPostgres } from '../core/dependencies.js';
import topologyService from '../services/topologyService.js';
import authService from '../services/authService.js';
import websocketService from '../services/websocketService.js';
import crossNetworkService from '../services/crossChainService.js';
import { chargeTask, chargeSkill, getTransactions, getNodeBalance, deductFromBalance, getBillingStats } from '../billing/index.js';
import {
  registerWallet, getWallets, setPrimaryWallet, removeWallet,
  createDeposit, createWithdrawal,
  getChainTransactions, getSupportedChains, getPaymentOverview,
  confirmDeposit, updateWithdrawalStatus
} from '../services/multiChainPaymentService.js';
import { addMemory, getMemories, getMemoryStats, deleteMemory, getGlobalMemoryStats } from '../services/memoryService.js';
import { updateRelationship, getRelationships, deleteRelationship, getSocialGraph, decayRelationships, getGlobalRelationshipStats } from '../services/relationshipService.js';
import { computeTrustScore, batchComputeTrustScores, applyTrustDecay, recommendRelationships, discoverCommunities, getSocialGraphStats } from '../services/socialGraphService.js';
import {
  ensureReputationTables, computeReputation, updateReputation,
  logReputationEvent, getLeaderboard, getNodeRank,
  getReputationHistory, getReputationTrend,
  batchUpdateReputations, processPendingEvents,
  getReputationStats, getReputationProfile
} from '../services/reputationService.js';
import { sendMessage, getMessages, markMessagesRead, getUnreadCount, dequeueOfflineMessages, getOfflineQueueLength, decryptMessageContent } from '../services/agentMessageService.js';
import federationService from '../services/federationService.js';
import monitorService from '../services/monitorService.js';
import client from 'prom-client';
import * as marketplaceService from '../services/marketplaceService.js';
import * as reviewService from '../services/reviewService.js';
import { generateText, generateEmbedding } from '../services/aiService.js';
import {
  computeMatchScore, findBestMatches, placeBid, getTaskBids, acceptBid, autoAssignTask,
  browseTasks, getMarketStats, createMarketTask, completeMarketTask
} from '../services/taskMarketService.js';
import { verifyApiKey, requireAdmin, requireAgentId, requireOwnNode, requireFederationKey } from './auth.js';
import { searchAgentsByIntent } from '../services/searchEngine.js';
import { executeQuery, findNearestNodes } from '../services/databaseService.js';
import {
  createWebhook, listWebhooks, getWebhook, deleteWebhook,
  retryDelivery, listDeliveries, getValidEvents,
  listDeadDeliveries, retryDeliveryAdmin
} from '../services/webhookService.js';
import eventBus from '../services/eventBus.js';

const router = express.Router();
const requireAuth = authService.authMiddleware.bind(authService);

// UUID 格式验证中间件
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateUUIDParam(paramName) {
  return (req, res, next) => {
    const val = req.params[paramName];
    if (val && !UUID_REGEX.test(val)) {
      return res.status(400).json({ success: false, error: `参数 ${paramName} 必须是有效的 UUID 格式` });
    }
    next();
  };
}

// 初始化 Prometheus 指标
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ prefix: 'xclaw_' });

const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'xclaw_http_request_duration_ms',
  help: 'Duration of HTTP requests in ms',
  labelNames: ['method', 'route', 'code'],
  buckets: [0.1, 5, 15, 50, 100, 200, 500, 1000, 2000, 5000]
});

// 记录请求时长的中间件
router.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    httpRequestDurationMicroseconds
      .labels(req.method, req.path, res.statusCode)
      .observe(duration);
  });
  next();
});

router.get('/metrics', verifyApiKey, async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

// 获取当前拓扑状态
router.get('/v1/topology', (req, res) => {
  res.status(200).json(topologyService.getState());
});

// 搜索接口 - 语义向量搜索
router.post('/v1/search', async (req, res) => {
  const { query, limit = 10 } = req.body;
  if (!query) {
    return res.status(400).json(formatResponse(false, null, '缺少查询参数'));
  }

  try {
    const { searchAgentsByIntent } = await import('../services/searchEngine.js');
    const results = await searchAgentsByIntent(query);
    const formatted = results.map(r => ({
      id: r.id,
      name: r.name,
      distance: r.distance,
      match_reason: `语义相似度: ${(1 - r.distance).toFixed(2)}`
    }));
    res.status(200).json(formatResponse(true, formatted));
  } catch (error) {
    const fallback = topologyService.searchNodes(query, null, Math.min(limit, 10));
    res.status(200).json(formatResponse(true, fallback));
  }
});

// 语义搜索 (GET 版)
router.get('/v1/search', async (req, res) => {
  try {
    const query = req.query.q || req.query.query || '';
    const limit = Math.min(Math.max(parseInt(req.query.limit || '5'), 1), 20);
    if (!query) {
      return res.status(400).json(formatResponse(false, null, '缺少 query 参数 (q 或 query)'));
    }
    const { searchAgentsByIntent } = await import('../services/searchEngine.js');
    const results = await searchAgentsByIntent(query);
    const formatted = results.map(r => ({
      id: r.id,
      name: r.name,
      distance: r.distance,
      match_reason: `语义相似度: ${(1 - r.distance).toFixed(2)}`
    }));
    res.status(200).json(formatResponse(true, formatted));
  } catch (error) {
    const fallback = topologyService.searchNodes(req.query.q || req.query.query || '', null, Math.min(parseInt(req.query.limit || '5'), 10));
    res.status(200).json(formatResponse(true, fallback));
  }
});

// 节点注册
router.post('/v1/agents/register', async (req, res) => {
  const { body, headers } = req;
  const signature = headers['x-agent-signature'];
  
  if (!signature) {
    return res.status(400).json(formatResponse(false, null, '缺少签名'));
  }
  
  const validation = validateParams(body, ['agent_name', 'capabilities', 'public_key']);
  if (!validation.valid) {
    return res.status(400).json(formatResponse(false, null, validation.message));
  }
  
  const result = await registerNode(body, signature, req.ip);
  if (result.success) {
    const nodeId = result.data.agent_id;
    const node = topologyService.getNode(nodeId);
    if (node) {
      websocketService.broadcastDelta(node, []);
    }
    res.status(200).json(result);
  } else {
    res.status(400).json(result);
  }
});

// 获取在线节点
router.get('/v1/agents/online', async (req, res) => {
  const result = await getOnlineNodes();
  res.status(200).json(result);
});

// 发现节点
router.get('/v1/agents/discover', async (req, res) => {
  const { query, tags, limit } = req.query;
  
  const parsedTags = tags ? tags.split(',') : [];
  const parsedLimit = limit ? parseInt(limit) : 5;
  
  const result = await discoverNodes(query, parsedTags, parsedLimit);
  res.status(200).json(result);
});

router.get('/v1/agents/search', async (req, res) => {
  const { query, tags, limit } = req.query;
  
  const parsedTags = tags ? tags.split(',') : [];
  const parsedLimit = limit ? parseInt(limit) : 5;
  
  const result = await discoverNodes(query, parsedTags, parsedLimit);
  res.status(200).json(result);
});

// 获取节点信息
router.get('/v1/agents/:agent_id', validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id } = req.params;
  
  const result = await getNode(agent_id);
  if (result.success) {
    res.status(200).json(result);
  } else {
    res.status(404).json(result);
  }
});

// 节点心跳
router.post('/v1/agents/:agent_id/heartbeat', validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id } = req.params;
  
  const result = await handleHeartbeat(agent_id, req.ip);
  if (result.success) {
    res.status(200).json(result);
  } else {
    res.status(400).json(result);
  }
});

// 注册技能
router.post('/v1/skills/register', async (req, res) => {
  const { body } = req;
  
  const validation = validateParams(body, ['name', 'description', 'category', 'version', 'node_id']);
  if (!validation.valid) {
    return res.status(400).json(formatResponse(false, null, validation.message));
  }
  
  const result = await registerSkill(body, body.node_id);
  if (result.success) {
    res.status(200).json(result);
  } else {
    res.status(400).json(result);
  }
});

// 搜索技能
router.get('/v1/skills/search', async (req, res) => {
  const { query, category, limit } = req.query;
  
  const parsedLimit = limit ? parseInt(limit) : 10;
  
  const result = await searchSkills(query, category, parsedLimit);
  res.status(200).json(result);
});

// 获取技能分类
router.get('/v1/skills/categories', async (req, res) => {
  const result = await getSkillCategories();
  res.status(200).json(result);
});

// 获取技能信息
router.get('/v1/skills/:skill_id', validateUUIDParam("skill_id"), async (req, res) => {
  const { skill_id } = req.params;
  
  const result = await getSkill(skill_id);
  if (result.success) {
    res.status(200).json(result);
  } else {
    res.status(404).json(result);
  }
});

// 获取节点的技能列表
router.get('/v1/agents/:agent_id/skills', validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id } = req.params;
  
  const result = await getNodeSkills(agent_id);
  res.status(200).json(result);
});

// 运行任务
const skillLimiter = rateLimit({
  windowMs: config.rateLimit?.skill?.windowMs || 15 * 60 * 1000,
  max: config.rateLimit?.skill?.max || 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { ip: false, keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    const skillId = req.body?.skill_id || 'unknown';
    return `${req.ip}:${skillId}`;
  },
  message: { success: false, error: 'Skill rate limit exceeded, please try again later.' }
});

router.post('/v1/tasks/run', requireAuth, skillLimiter, async (req, res) => {
  const { body } = req;
  
  const validation = validateParams(body, []);
  if (!body.type && !body.skill_id) {
    return res.status(400).json(formatResponse(false, null, '缺少 type 或 skill_id 参数'));
  }
  // 兼容 ClawBay: 如果没有 type 但有 skill_id，用 skill_id 作为 type
  if (!body.type && body.skill_id) {
    body.type = body.skill_id;
  }
  
  const result = await routeTask(body);
  if (result.success) {
    res.status(200).json(result);
  } else {
    res.status(400).json(result);
  }
});

// 任务轮询
router.get('/v1/tasks/poll', requireAuth, async (req, res) => {
  try {
    const { agent_id } = req.headers;
    
    if (!agent_id) {
      return res.status(400).json({ error: 'Agent ID required' });
    }
    
    // 从 Redis 中获取节点的任务队列
    const redisClient = getRedis();
    const tasks = await redisClient.xRange(`node:${agent_id}:tasks`, '-', '+', { count: 1 });
    
    if (tasks.length === 0) {
      return res.status(200).json({ success: true, data: null });
    }
    
    const task = tasks[0];
    const taskData = {
      task_id: task.message.task_id,
      skill_id: task.message.skill_id,
      payload: JSON.parse(task.message.payload),
      message_id: task.message.message_id
    };
    
    // 从队列中移除任务
    await redisClient.xDel(`node:${agent_id}:tasks`, task.id);
    
    res.status(200).json({ success: true, data: taskData });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 获取任务状态
router.get('/v1/tasks/:task_id', validateUUIDParam("task_id"), async (req, res) => {
  const { task_id } = req.params;
  
  const result = await getTaskStatus(task_id);
  if (result.success) {
    res.status(200).json(result);
  } else {
    res.status(404).json(result);
  }
});

// 完成任务
router.post('/v1/tasks/:task_id/complete', validateUUIDParam("task_id"), async (req, res) => {
  const { task_id } = req.params;
  const { result } = req.body;
  
  const response = await completeTask(task_id, result);
  if (response.success) {
    res.status(200).json(response);
  } else {
    res.status(400).json(response);
  }
});

// ==========================================
// 计费相关 API 路由（需鉴权）
// ==========================================

function buildAudit(req) {
  return {
    operator_id: req.agentId || null,
    ip_address: req.ip || null,
    reason: req.body?.reason || null,
    metadata: req.body?.metadata || {}
  };
}

router.post('/v1/billing/task/:task_id', requireAuth, validateUUIDParam("task_id"), async (req, res) => {
  try {
    const { task_id } = req.params;
    const { amount } = req.body;
    const result = await chargeTask(task_id, amount, buildAudit(req));
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/v1/billing/skill/:skill_id', requireAuth, validateUUIDParam("skill_id"), async (req, res) => {
  try {
    const { skill_id } = req.params;
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ error: 'amount required' });
    const result = await chargeSkill(skill_id, amount, buildAudit(req));
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/v1/billing/node/:node_id/balance', requireAuth, requireAgentId("node_id"), validateUUIDParam("node_id"), async (req, res) => {
  try {
    const { node_id } = req.params;
    const result = await getNodeBalance(node_id);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/v1/billing/node/:node_id/stats', requireAuth, requireAgentId("node_id"), validateUUIDParam("node_id"), async (req, res) => {
  try {
    const { node_id } = req.params;
    const result = await getBillingStats(node_id);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/v1/billing/node/:node_id/withdraw', requireAuth, requireAgentId("node_id"), validateUUIDParam("node_id"), async (req, res) => {
  try {
    const { node_id } = req.params;
    const { amount, reason } = req.body;
    if (!amount) return res.status(400).json({ error: 'amount required' });
    const audit = buildAudit(req);
    if (reason) audit.reason = reason;
    const result = await deductFromBalance(node_id, amount, audit);
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/v1/billing/transactions', requireAuth, async (req, res) => {
  try {
    const { node_id, type, from_date, to_date, limit, offset } = req.query;
    const filters = {};
    if (node_id) filters.node_id = node_id;
    if (type) filters.type = type;
    if (from_date) filters.from_date = from_date;
    if (to_date) filters.to_date = to_date;
    if (limit) filters.limit = parseInt(limit);
    if (offset) filters.offset = parseInt(offset);
    const result = await getTransactions(filters);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// Agent Profile 聚合 API
// ==========================================

router.get('/v1/agents/:agent_id/profile', validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id } = req.params;
  const pgPool = getPostgres();

  try {
    const [nodeRes, taskRes, memRes, relRes] = await Promise.all([
      pgPool.query('SELECT node_id, name AS agent_name, reputation_score, total_earnings, latitude, longitude, created_at FROM nodes WHERE node_id = $1', [agent_id]),
      pgPool.query(`SELECT
        COUNT(*) as total_tasks,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_tasks,
        COUNT(*) FILTER (WHERE status = 'failed') as failed_tasks,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_tasks
      FROM tasks WHERE node_id = $1`, [agent_id]),
      getMemoryStats(agent_id),
      getRelationships(agent_id)
    ]);

    if (nodeRes.rows.length === 0) {
      return res.status(404).json(formatResponse(false, null, 'Agent 不存在'));
    }

    const profile = {
      ...nodeRes.rows[0],
      task_stats: taskRes.rows[0],
      memory_stats: memRes.success ? memRes.data : null,
      relationships: relRes.success ? relRes.data : []
    };

    res.json(formatResponse(true, profile));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, '获取 Profile 失败'));
  }
});

// ==========================================
// Agent 记忆 API 路由
// ==========================================

router.post('/v1/agents/:agent_id/memories', requireAuth, requireAgentId("agent_id"), validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id } = req.params;
  const { type, content, related_agent_id, task_id, importance } = req.body;
  if (!content) {
    return res.status(400).json(formatResponse(false, null, 'content 必填'));
  }
  const result = await addMemory({ agent_id, type, content, related_agent_id, task_id, importance });
  res.status(result.success ? 200 : 400).json(result);
});

router.get('/v1/agents/:agent_id/memories', requireAuth, requireAgentId("agent_id"), validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id } = req.params;
  const { type, limit, offset } = req.query;
  const result = await getMemories(agent_id, { type, limit: parseInt(limit) || 20, offset: parseInt(offset) || 0 });
  res.status(result.success ? 200 : 400).json(result);
});

router.get('/v1/agents/:agent_id/memories/stats', requireAuth, requireAgentId("agent_id"), validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id } = req.params;
  const result = await getMemoryStats(agent_id);
  res.status(result.success ? 200 : 400).json(result);
});

router.delete('/v1/agents/:agent_id/memories/:memory_id', requireAuth, requireAgentId("agent_id"), validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id, memory_id } = req.params;
  const result = await deleteMemory(agent_id, memory_id);
  res.status(result.success ? 200 : 400).json(result);
});

// ==========================================
// Agent 关系 API 路由
// ==========================================

router.post('/v1/agents/:agent_id/relationships', requireAuth, requireAgentId("agent_id"), validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id } = req.params;
  const { related_agent_id, type, rating } = req.body;
  if (!related_agent_id) {
    return res.status(400).json(formatResponse(false, null, 'related_agent_id 必填'));
  }
  const result = await updateRelationship(agent_id, related_agent_id, { type, rating });
  res.status(result.success ? 200 : 400).json(result);
});

router.get('/v1/agents/:agent_id/relationships', requireAuth, requireAgentId("agent_id"), validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id } = req.params;
  const { type } = req.query;
  const result = await getRelationships(agent_id, { type });
  res.status(result.success ? 200 : 400).json(result);
});

router.delete('/v1/agents/:agent_id/relationships/:related_agent_id', requireAuth, requireAgentId("agent_id"), validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id, related_agent_id } = req.params;
  const result = await deleteRelationship(agent_id, related_agent_id);
  res.status(result.success ? 200 : 400).json(result);
});

router.get('/v1/social-graph', async (_req, res) => {
  const result = await getSocialGraph();
  res.status(result.success ? 200 : 500).json(result);
});

router.post('/v1/social-graph/decay', verifyApiKey, async (_req, res) => {
  const count = await decayRelationships();
  res.json(formatResponse(true, { decayed: count }));
});

// ─── 社交图谱 v2 — 信任评分 / 推荐 / 社区发现 ────

// 查询两个 Agent 之间的信任评分
router.get('/v1/social-graph/trust/:agent_id/:related_id', validateUUIDParam("agent_id"), async (req, res) => {
  try {
    const result = await computeTrustScore(req.params.agent_id, req.params.related_id);
    res.json(formatResponse(true, result));
  } catch (error) {
    logger.error('Failed to compute trust score', { error: error.message });
    res.status(500).json(formatResponse(false, null, error.message));
  }
});

// 批量获取一个 Agent 的信任评分列表
router.get('/v1/social-graph/trust/:agent_id', validateUUIDParam("agent_id"), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const minTrust = parseFloat(req.query.min_trust || '0.3');
    const results = await batchComputeTrustScores(req.params.agent_id, { limit, minTrust });
    res.json(formatResponse(true, results));
  } catch (error) {
    logger.error('Failed to batch compute trust scores', { error: error.message });
    res.status(500).json(formatResponse(false, null, error.message));
  }
});

// 触发信任衰减（v2 增强版）
router.post('/v1/social-graph/trust/decay', verifyApiKey, async (_req, res) => {
  try {
    const count = await applyTrustDecay();
    res.json(formatResponse(true, { decayed: count }));
  } catch (error) {
    logger.error('Failed to apply trust decay', { error: error.message });
    res.status(500).json(formatResponse(false, null, error.message));
  }
});

// 关系推荐
router.get('/v1/social-graph/recommend/:agent_id', validateUUIDParam("agent_id"), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '10'), 50);
    const result = await recommendRelationships(req.params.agent_id, { limit });
    res.status(result.success ? 200 : 500).json(result);
  } catch (error) {
    logger.error('Failed to recommend relationships', { error: error.message });
    res.status(500).json(formatResponse(false, null, error.message));
  }
});

// 社区发现
router.get('/v1/social-graph/communities', async (req, res) => {
  try {
    const minSize = parseInt(req.query.min_size || '3');
    const result = await discoverCommunities({ minCommunitySize: minSize });
    res.status(result.success ? 200 : 500).json(result);
  } catch (error) {
    logger.error('Failed to discover communities', { error: error.message });
    res.status(500).json(formatResponse(false, null, error.message));
  }
});

// 社交图谱聚合统计
router.get('/v1/social-graph/stats', async (_req, res) => {
  try {
    const result = await getSocialGraphStats();
    res.status(result.success ? 200 : 500).json(result);
  } catch (error) {
    logger.error('Failed to get social graph stats', { error: error.message });
    res.status(500).json(formatResponse(false, null, error.message));
  }
});

// 全局关系统计
router.get('/v1/relationships', async (_req, res) => {
  const result = await getGlobalRelationshipStats();
  res.status(result.success ? 200 : 500).json(result);
});

// 全局记忆统计
router.get('/v1/memory/stats', async (_req, res) => {
  const result = await getGlobalMemoryStats();
  res.status(result.success ? 200 : 500).json(result);
});

// 全局关系统计
router.get('/v1/relationships/stats', async (_req, res) => {
  const result = await getGlobalRelationshipStats();
  res.status(result.success ? 200 : 500).json(result);
});

// ==========================================
// 跨网络 Agent 互操作 API 路由
// ==========================================

router.post('/v1/crossnetwork/messages', requireAuth, async (req, res) => {
  try {
    const { fromNetwork, toNetwork, recipientId, content, signature } = req.body;
    const senderId = req.headers['x-agent-id'];
    
    if (!fromNetwork || !toNetwork || !recipientId || !content || !signature || !senderId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const message = crossNetworkService.generateCrossNetworkMessage(fromNetwork, toNetwork, senderId, recipientId, content);
    const signedMessage = { ...message, signature };
    const result = await crossNetworkService.sendCrossNetworkMessage(signedMessage);
    
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/v1/crossnetwork/messages/:messageId/status', requireAuth, async (req, res) => {
  try {
    const { messageId } = req.params;
    const status = await crossNetworkService.getMessageStatus(messageId);
    res.status(200).json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 跨网络消息接收端点（供远端实例中继，需联邦共享密钥）
router.post('/v1/crossnetwork/receive', requireFederationKey, async (req, res) => {
  try {
    const sourceNetwork = req.headers['x-federation-source'] || req.body?.source_network;
    const result = await crossNetworkService.receiveFromRemote(sourceNetwork, req.body?.payload || req.body);
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// Agent 消息 API 路由
// ==========================================

router.post('/v1/agents/:agent_id/messages', requireAuth, requireAgentId("agent_id"), validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id } = req.params;
  const { receiver_id, type, content, task_id, encrypt } = req.body;
  if (!receiver_id || !content) {
    return res.status(400).json(formatResponse(false, null, 'receiver_id 和 content 必填'));
  }
  const result = await sendMessage({ sender_id: agent_id, receiver_id, type: type || 'info', content, task_id, encrypt: encrypt !== false });
  res.status(result.success ? 200 : 400).json(result);
});

router.get('/v1/agents/:agent_id/messages', requireAuth, requireAgentId("agent_id"), validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id } = req.params;
  const { unread_only, limit, offset } = req.query;
  const result = await getMessages(agent_id, {
    unread_only: unread_only === 'true',
    limit: parseInt(limit) || 50,
    offset: parseInt(offset) || 0
  });
  res.status(result.success ? 200 : 400).json(result);
});

router.put('/v1/agents/:agent_id/messages/read', requireAuth, requireAgentId("agent_id"), validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id } = req.params;
  const { message_ids } = req.body;
  const result = await markMessagesRead(agent_id, message_ids);
  res.status(result.success ? 200 : 400).json(result);
});

router.get('/v1/agents/:agent_id/messages/unread-count', requireAuth, requireAgentId("agent_id"), validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id } = req.params;
  const result = await getUnreadCount(agent_id);
  res.status(result.success ? 200 : 400).json(result);
});

// 离线消息队列
router.get('/v1/agents/:agent_id/messages/offline', requireAuth, requireAgentId("agent_id"), validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id } = req.params;
  const { limit } = req.query;
  const result = await dequeueOfflineMessages(agent_id, parseInt(limit) || 50);
  res.status(result.success ? 200 : 500).json(result);
});

router.get('/v1/agents/:agent_id/messages/offline-count', requireAuth, requireAgentId("agent_id"), validateUUIDParam("agent_id"), async (req, res) => {
  const { agent_id } = req.params;
  const result = await getOfflineQueueLength(agent_id);
  res.status(result.success ? 200 : 500).json(result);
});

// ==========================================
// 广播 API 路由（需鉴权）
// ==========================================

router.post('/v1/broadcast', requireAuth, async (req, res) => {
  const { message, tags } = req.body;
  if (!message) {
    return res.status(400).json(formatResponse(false, null, 'message 必填'));
  }
  try {
    const senderId = req.headers['x-agent-id'] || 'api';
    const tagList = tags || [];
    let sentCount = 0;
    for (const [agentId] of websocketService.wsConnections) {
      if (agentId === senderId || agentId === 'monitor') continue;
      if (tagList.length > 0) {
        const agentNode = topologyService.getState().nodes.find(n => n.id === agentId);
        if (agentNode && tagList.some(tag => agentNode.tags && agentNode.tags.includes(tag))) {
          const sent = websocketService.sendToAgent(agentId, { type: 'BROADCAST', sender_id: senderId, content: message, tags: tagList, timestamp: new Date().toISOString() });
          if (sent) sentCount++;
        }
      } else {
        const sent = websocketService.sendToAgent(agentId, { type: 'BROADCAST', sender_id: senderId, content: message, timestamp: new Date().toISOString() });
        if (sent) sentCount++;
      }
    }
    res.status(200).json(formatResponse(true, { sent: sentCount, message: `Broadcast sent to ${sentCount} agent(s)` }));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, '广播失败'));
  }
});

router.post('/v1/announce', requireAuth, async (req, res) => {
  const { message, tags } = req.body;
  if (!message) {
    return res.status(400).json(formatResponse(false, null, 'message 必填'));
  }
  try {
    const senderId = req.headers['x-agent-id'] || 'api';
    const tagList = tags || [];
    let sentCount = 0;
    for (const [agentId] of websocketService.wsConnections) {
      if (agentId === senderId || agentId === 'monitor') continue;
      if (tagList.length > 0) {
        const agentNode = topologyService.getState().nodes.find(n => n.id === agentId);
        if (agentNode && tagList.some(tag => agentNode.tags && agentNode.tags.includes(tag))) {
          const sent = websocketService.sendToAgent(agentId, { type: 'BROADCAST', sender_id: senderId, content: message, tags: tagList, timestamp: new Date().toISOString() });
          if (sent) sentCount++;
        }
      } else {
        const sent = websocketService.sendToAgent(agentId, { type: 'BROADCAST', sender_id: senderId, content: message, timestamp: new Date().toISOString() });
        if (sent) sentCount++;
      }
    }
    res.status(200).json(formatResponse(true, { sent: sentCount, message: `Announce sent to ${sentCount} agent(s)` }));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, '广播失败'));
  }
});

// ==========================================
// Auth 登录 API
// ==========================================

router.post('/v1/auth/login', async (req, res) => {
  try {
    const { api_key } = req.body;
    if (!api_key) {
      return res.status(400).json(formatResponse(false, null, 'api_key 必填'));
    }
    const result = await authService.verifyApiKey(api_key);
    if (!result.valid) {
      return res.status(401).json(formatResponse(false, null, '无效的 API Key'));
    }
    const token = authService.generateToken(result.agentId);
    res.json(formatResponse(true, { token, agent_id: result.agentId }));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, '登录失败'));
  }
});

// ==========================================
// AI Service Routes
// ==========================================

// AI 文本生成
router.post('/v1/ai/generate', verifyApiKey, async (req, res) => {
  try {
    const { prompt, model, temperature, response_schema } = req.body;
    if (!prompt) {
      return res.status(400).json({ success: false, error: '缺少 prompt 参数' });
    }
    const text = await generateText(prompt, { model, temperature, responseSchema: response_schema });
    res.json({ success: true, data: { text } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// AI Embedding 生成
router.post('/v1/ai/embed', verifyApiKey, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ success: false, error: '缺少 text 参数' });
    }
    const embedding = await generateEmbedding(text);
    res.json({ success: true, data: { embedding, dimensions: embedding.length } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 健康检查
router.get('/health', async (req, res) => {
  const dbStatus = await checkPostgresHealth();
  const redisStatus = await checkRedisHealth();
  const isHealthy = dbStatus && redisStatus;

  const healthInfo = {
    status: isHealthy ? 'ok' : 'degraded',
    services: {
      database: dbStatus ? 'up' : 'down',
      redis: redisStatus ? 'up' : 'down'
    },
    timestamp: new Date().toISOString()
  };

  res.status(isHealthy ? 200 : 503).json(healthInfo);
});

// Prometheus 指标端点
router.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  } catch (error) {
    res.status(500).end(error.message);
  }
});

// ==========================================
// 全局搜索 API
// ==========================================

router.post('/v1/search', async (req, res) => {
  try {
    const { query, scope } = req.body;
    if (!query) {
      return res.status(400).json(formatResponse(false, null, 'query 必填'));
    }
    const agents = await searchAgentsByIntent(query);
    res.json(formatResponse(true, { agents, query, scope }));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, '搜索失败'));
  }
});

// ==========================================
// 任务列表 & 创建 API
// ==========================================

router.get('/v1/tasks', async (req, res) => {
  try {
    const { status, agentId, limit, offset } = req.query;
    const result = await listTasks({ status, agentId, limit, offset });
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/v1/tasks', requireAuth, async (req, res) => {
  try {
    const { title, description, type, target_agent_id, priority, tags, payload } = req.body;
    const taskData = {
      type: type || title || 'general',
      payload: payload || { title, description, priority, tags },
      node_id: target_agent_id || null
    };
    const result = await createTask(taskData);
    res.status(result.success ? 201 : 400).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.patch('/v1/tasks/:task_id/status', requireAuth, validateUUIDParam("task_id"), async (req, res) => {
  try {
    const { task_id } = req.params;
    const { status, result } = req.body;
    if (!status) {
      return res.status(400).json(formatResponse(false, null, 'status 必填'));
    }
    const response = await updateTaskStatus(task_id, status, result);
    res.status(response.success ? 200 : 400).json(response);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/v1/tasks/:task_id/history', validateUUIDParam("task_id"), async (req, res) => {
  try {
    const { task_id } = req.params;
    const result = await getTaskLogs(task_id);
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ==========================================
// 全局关系 API
// ==========================================

router.post('/v1/relationships', requireAuth, async (req, res) => {
  try {
    const { from_agent_id, to_agent_id, type, strength, tags } = req.body;
    if (!from_agent_id || !to_agent_id) {
      return res.status(400).json(formatResponse(false, null, 'from_agent_id 和 to_agent_id 必填'));
    }
    const result = await updateRelationship(from_agent_id, to_agent_id, { type, rating: strength });
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ==========================================
// 计费补充 API
// ==========================================

router.get('/v1/billing/balance', requireAuth, async (req, res) => {
  try {
    const agentId = req.agentId;
    if (!agentId) {
      return res.status(400).json({ error: 'agentId required' });
    }
    const result = await getNodeBalance(agentId);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/v1/agents/:agent_id/stats', requireAuth, requireAgentId("agent_id"), validateUUIDParam("agent_id"), async (req, res) => {
  try {
    const { agent_id } = req.params;
    const pgPool = getPostgres();
    const [nodeRes, taskRes, billingRes] = await Promise.all([
      pgPool.query('SELECT node_id, name, reputation_score, total_earnings, status, created_at FROM nodes WHERE node_id = $1', [agent_id]),
      pgPool.query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status=\'completed\') as completed, COUNT(*) FILTER (WHERE status=\'failed\') as failed FROM tasks WHERE node_id = $1', [agent_id]),
      getNodeBalance(agent_id).catch(() => ({ success: true, data: { balance: 0 } }))
    ]);
    if (nodeRes.rows.length === 0) {
      return res.status(404).json(formatResponse(false, null, 'Agent 不存在'));
    }
    res.json(formatResponse(true, {
      ...nodeRes.rows[0],
      task_stats: taskRes.rows[0],
      billing: billingRes.data || {}
    }));
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 充值仅限管理员（无真实支付渠道时禁止公开造币）
router.post('/v1/billing/topup', verifyApiKey, requireAdmin, async (req, res) => {
  try {
    const { amount, method } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'amount must be positive' });
    }
    if (Number(amount) > 1000000) {
      return res.status(400).json({ error: 'amount exceeds maximum' });
    }
    const agentId = req.agentId;
    const { executeQuery } = await import('../services/databaseService.js');
    // 创建充值交易记录
    const { rows } = await executeQuery(
      `INSERT INTO transactions (node_id, amount, type, status, reason, metadata)
       VALUES ($1, $2, 'topup', 'completed', $3, $4)
       RETURNING *`,
      [agentId, amount, `Top-up via ${method || 'unknown'}`, JSON.stringify({ method, source: 'api' })]
    );
    // 更新或创建账户余额
    await executeQuery(
      `INSERT INTO billing_accounts (node_id, balance)
       VALUES ($1, $2)
       ON CONFLICT (node_id) DO UPDATE SET balance = billing_accounts.balance + $2, updated_at = NOW()`,
      [agentId, amount]
    );
    res.json({ success: true, data: rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ==========================================
// 评价 API 别名 (前端路径兼容)
// ==========================================

router.post('/v1/reviews', requireAuth, async (req, res) => {
  try {
    const { skill_id, rating, comment, order_id } = req.body;
    if (!skill_id) {
      return res.status(400).json({ success: false, error: 'skill_id 必填' });
    }
    const result = await reviewService.addReview(skill_id, req.agentId, { rating, comment, orderId: order_id });
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.get('/v1/reviews/skill/:skill_id', validateUUIDParam("skill_id"), async (req, res) => {
  try {
    const { limit, offset, sort } = req.query;
    const result = await reviewService.getSkillReviews(req.params.skill_id, {
      limit: parseInt(limit) || 20,
      offset: parseInt(offset) || 0,
      sortBy: sort || 'created_at'
    });
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- Marketplace: Listings ---
router.get('/v1/marketplace/listings', async (req, res) => {
  try {
    const result = await marketplaceService.getMarketplaceListings(req.query);
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.get('/v1/marketplace/listings/:skill_id', validateUUIDParam("skill_id"), async (req, res) => {
  try {
    const result = await marketplaceService.getListingDetail(req.params.skill_id);
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.get('/v1/marketplace/featured', async (req, res) => {
  try {
    const result = await marketplaceService.getFeaturedSkills(parseInt(req.query.limit) || 6);
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.get('/v1/marketplace/stats', async (req, res) => {
  try {
    const result = await marketplaceService.getMarketplaceStats();
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- Marketplace: List / Delist ---
router.post('/v1/marketplace/list', requireAuth, async (req, res) => {
  try {
    const { skill_id, price } = req.body;
    if (!skill_id || price === undefined) {
      return res.status(400).json({ success: false, error: '缺少 skill_id 或 price 参数' });
    }
    const result = await marketplaceService.listSkill(skill_id, req.agentId, parseFloat(price));
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.post('/v1/marketplace/delist', requireAuth, async (req, res) => {
  try {
    const { skill_id } = req.body;
    if (!skill_id) {
      return res.status(400).json({ success: false, error: '缺少 skill_id 参数' });
    }
    const result = await marketplaceService.delistSkill(skill_id, req.agentId);
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- Marketplace: Orders ---
router.post('/v1/marketplace/orders', requireAuth, async (req, res) => {
  try {
    const { skill_id, ...payload } = req.body;
    const result = await marketplaceService.placeOrder(req.agentId, skill_id, payload);
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.get('/v1/marketplace/orders', requireAuth, async (req, res) => {
  try {
    const { role, status, limit, offset } = req.query;
    const agentId = req.agentId;
    let result;
    if (role === 'seller') {
      result = await marketplaceService.getSellerOrders(agentId, { status, limit: parseInt(limit) || 20, offset: parseInt(offset) || 0 });
    } else {
      result = await marketplaceService.getBuyerOrders(agentId, { status, limit: parseInt(limit) || 20, offset: parseInt(offset) || 0 });
    }
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.get('/v1/marketplace/orders/:order_id', requireAuth, async (req, res) => {
  try {
    const result = await marketplaceService.getOrder(req.params.order_id);
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 前端兼容别名: /v1/marketplace/my/orders
router.get('/v1/marketplace/my/orders', requireAuth, async (req, res) => {
  try {
    const { status, limit, offset } = req.query;
    const result = await marketplaceService.getBuyerOrders(req.agentId, { status, limit: parseInt(limit) || 20, offset: parseInt(offset) || 0 });
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 前端兼容别名: /v1/marketplace/my/sales
router.get('/v1/marketplace/my/sales', requireAuth, async (req, res) => {
  try {
    const { status, limit, offset } = req.query;
    const result = await marketplaceService.getSellerOrders(req.agentId, { status, limit: parseInt(limit) || 20, offset: parseInt(offset) || 0 });
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- Reviews ---

// ==========================================
// 全局统计 API
// ==========================================

router.get('/v1/stats/global', async (_req, res) => {
  try {
    const [memoryStats, relationshipStats, agentCount] = await Promise.all([
      getGlobalMemoryStats(),
      getGlobalRelationshipStats(),
      (async () => {
        const db = await getPostgres();
        const result = await db.query('SELECT COUNT(DISTINCT node_id) as count FROM nodes WHERE status = $1', ['online']);
        return { success: true, data: { online_agents: parseInt(result.rows[0]?.count || 0) } };
      })()
    ]);
    
    res.json({
      success: true,
      data: {
        memory: memoryStats.data || {},
        relationships: relationshipStats.data || {},
        agents: agentCount.data || {},
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Global stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/v1/skills/:skill_id/reviews', validateUUIDParam("skill_id"), async (req, res) => {
  try {
    const { limit, offset, sort } = req.query;
    const result = await reviewService.getSkillReviews(req.params.skill_id, {
      limit: parseInt(limit) || 20,
      offset: parseInt(offset) || 0,
      sortBy: sort || 'created_at'
    });
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.post('/v1/skills/:skill_id/reviews', requireAuth, validateUUIDParam("skill_id"), async (req, res) => {
  try {
    const { rating, comment, order_id } = req.body;
    const result = await reviewService.addReview(req.params.skill_id, req.agentId, { rating, comment, orderId: order_id });
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.get('/v1/reviews/rankings', async (req, res) => {
  try {
    const { category, limit, min_reviews } = req.query;
    const result = await reviewService.getSkillRankings({ category, limit: parseInt(limit) || 10, minReviews: parseInt(min_reviews) || 1 });
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.get('/v1/reviews/top-rated', async (req, res) => {
  try {
    const { limit } = req.query;
    const result = await reviewService.getTopRatedSkills(parseInt(limit) || 10);
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.get('/v1/reviews/categories', async (req, res) => {
  try {
    const result = await reviewService.getCategoryRankings();
    res.json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ─── Agent-scoped Routes ────────────────────────────────────────────────

// Agent tasks
router.get('/v1/agents/:agent_id/tasks', validateUUIDParam("agent_id"), async (req, res) => {
  try {
    const { agent_id } = req.params;
    const { status, limit = 20, offset = 0 } = req.query;
    const result = await executeQuery(
      'SELECT * FROM tasks WHERE node_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [agent_id, parseInt(limit), parseInt(offset)]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Agent billing summary
router.get('/v1/agents/:agent_id/billing', validateUUIDParam("agent_id"), async (req, res) => {
  try {
    const { agent_id } = req.params;
    const balance = await executeQuery(
      'SELECT * FROM billing_accounts WHERE node_id = $1', [agent_id]
    );
    const recentTx = await executeQuery(
      'SELECT * FROM transactions WHERE node_id = $1 ORDER BY created_at DESC LIMIT 20', [agent_id]
    );
    res.json({ success: true, data: { balance: balance.rows[0] || null, recent_transactions: recentTx.rows } });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Agent marketplace listings
router.get('/v1/agents/:agent_id/marketplace/listings', validateUUIDParam("agent_id"), async (req, res) => {
  try {
    const { agent_id } = req.params;
    const result = await executeQuery(
      `SELECT ml.*, s.name as skill_name FROM marketplace_listings ml
       JOIN skills s ON ml.skill_id = s.id
       WHERE ml.seller_id = $1 ORDER BY ml.created_at DESC`,
      [agent_id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Agent marketplace orders
router.get('/v1/agents/:agent_id/marketplace/orders', validateUUIDParam("agent_id"), async (req, res) => {
  try {
    const orders = await marketplaceService.getBuyerOrders(req.params.agent_id, req.query);
    res.json({ success: true, data: orders });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Agent marketplace sales
router.get('/v1/agents/:agent_id/marketplace/sales', validateUUIDParam("agent_id"), async (req, res) => {
  try {
    const sales = await marketplaceService.getSellerOrders(req.params.agent_id, req.query);
    res.json({ success: true, data: sales });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Agent reviews (all)
router.get('/v1/agents/:agent_id/reviews', validateUUIDParam("agent_id"), async (req, res) => {
  try {
    const { agent_id } = req.params;
    const { limit = 20, offset = 0 } = req.query;
    const result = await executeQuery(
      `SELECT sr.*, s.name as skill_name FROM skill_reviews sr
       JOIN skills s ON sr.skill_id = s.id
       WHERE sr.reviewer_id = $1
       ORDER BY sr.created_at DESC LIMIT $2 OFFSET $3`,
      [agent_id, parseInt(limit), parseInt(offset)]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Agent reviews received (reviews on agent's skills)
router.get('/v1/agents/:agent_id/reviews/received', validateUUIDParam("agent_id"), async (req, res) => {
  try {
    const { agent_id } = req.params;
    const { limit = 20, offset = 0 } = req.query;
    const result = await executeQuery(
      `SELECT sr.*, s.name as skill_name, sr.reviewer_id FROM skill_reviews sr
       JOIN skills s ON sr.skill_id = s.id
       WHERE s.node_id = $1
       ORDER BY sr.created_at DESC LIMIT $2 OFFSET $3`,
      [agent_id, parseInt(limit), parseInt(offset)]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Agent reviews given
router.get('/v1/agents/:agent_id/reviews/given', validateUUIDParam("agent_id"), async (req, res) => {
  try {
    const reviews = await reviewService.getReviewerReviews(req.params.agent_id, req.query);
    res.json({ success: true, data: reviews });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Agent embeddings
router.get('/v1/agents/:agent_id/embeddings', validateUUIDParam("agent_id"), async (req, res) => {
  try {
    const result = await executeQuery(
      'SELECT node_id, capability_vector FROM node_embeddings WHERE node_id = $1',
      [req.params.agent_id]
    );
    res.json({ success: true, data: result.rows[0] || null });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Agent similar embeddings
router.get('/v1/agents/:agent_id/embeddings/similar', validateUUIDParam("agent_id"), async (req, res) => {
  try {
    const { agent_id } = req.params;
    const { limit = 5 } = req.query;
    const emb = await executeQuery(
      'SELECT capability_vector FROM node_embeddings WHERE node_id = $1', [agent_id]
    );
    if (!emb.rows[0]?.capability_vector) {
      return res.json({ success: true, data: [] });
    }
    const similar = await findNearestNodes(agent_id, emb.rows[0].capability_vector, parseInt(limit));
    res.json({ success: true, data: similar });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Agent embedding stats
router.get('/v1/agents/:agent_id/embeddings/stats', validateUUIDParam("agent_id"), async (req, res) => {
  try {
    const stats = await executeQuery(
      'SELECT COUNT(*) as total_embeddings FROM node_embeddings WHERE node_id = $1',
      [req.params.agent_id]
    );
    res.json({ success: true, data: stats.rows[0] });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Marketplace categories
router.get('/v1/marketplace/categories', async (req, res) => {
  try {
    const result = await executeQuery(
      'SELECT DISTINCT category FROM skills WHERE category IS NOT NULL ORDER BY category'
    );
    res.json({ success: true, data: result.rows.map(r => r.category) });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ==========================================
// Webhook 事件系统
// ==========================================

// 创建 webhook
router.post('/v1/webhooks', verifyApiKey, async (req, res) => {
  try {
    const nodeId = req.nodeId || req.body.node_id;
    if (!nodeId) return res.status(400).json({ success: false, error: 'node_id required' });
    const { url, events, description } = req.body;
    if (!url || !events || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ success: false, error: 'url and events[] required' });
    }
    const webhook = await createWebhook(nodeId, { url, events, description });
    res.status(201).json({ success: true, data: webhook });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});

// 列出 webhooks
router.get('/v1/webhooks', verifyApiKey, async (req, res) => {
  try {
    const nodeId = req.nodeId || req.query.node_id;
    if (!nodeId) return res.status(400).json({ success: false, error: 'node_id required' });
    const webhooks = await listWebhooks(nodeId);
    res.json({ success: true, data: webhooks });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 查看 webhook 详情
router.get('/v1/webhooks/:id', verifyApiKey, async (req, res) => {
  try {
    const nodeId = req.nodeId || req.query.node_id;
    const webhook = await getWebhook(req.params.id, nodeId);
    res.json({ success: true, data: webhook });
  } catch (error) {
    const status = error.message === 'Webhook not found' ? 404 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// 删除 webhook
router.delete('/v1/webhooks/:id', verifyApiKey, async (req, res) => {
  try {
    const nodeId = req.nodeId || req.query.node_id;
    const result = await deleteWebhook(req.params.id, nodeId);
    res.json(result);
  } catch (error) {
    const status = error.message === 'Webhook not found' ? 404 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// 查看 webhook 投递历史
router.get('/v1/webhooks/:id/deliveries', verifyApiKey, async (req, res) => {
  try {
    const nodeId = req.nodeId || req.query.node_id;
    const { status, limit = 20, offset = 0 } = req.query;
    const result = await listDeliveries(req.params.id, nodeId, { status, limit: parseInt(limit), offset: parseInt(offset) });
    res.json({ success: true, ...result });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 手动重试失败投递
router.post('/v1/webhooks/:id/retry', verifyApiKey, async (req, res) => {
  try {
    const nodeId = req.nodeId || req.body.node_id;
    const result = await retryDelivery(req.params.id, nodeId);
    res.json(result);
  } catch (error) {
    const status = error.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, error: error.message });
  }
});

// 事件日志查询
router.get('/v1/events', verifyApiKey, async (req, res) => {
  try {
    const { event_type, source_id, limit = 50, offset = 0, since } = req.query;
    const result = await eventBus.queryEvents({
      eventType: event_type,
      sourceId: source_id,
      limit: parseInt(limit),
      offset: parseInt(offset),
      since: since || null
    });
    res.json({ success: true, ...result });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 获取可用事件类型
router.get('/v1/events/types', async (req, res) => {
  res.json({ success: true, data: getValidEvents() });
});

// ============================================================
// Admin Console API — 全部通过 [verifyApiKey, requireAdmin] 保护
// ============================================================

// 1. 仪表盘概览数据
router.get('/v1/admin/dashboard', verifyApiKey, requireAdmin, async (req, res) => {
  try {
    const [
      nodesResult,
      skillsResult,
      tasksResult,
      revenueResult,
      todayEventsResult,
      webhooksResult
    ] = await Promise.all([
      executeQuery('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = \'active\') as active FROM nodes'),
      executeQuery('SELECT COUNT(*) as total FROM skills'),
      executeQuery('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = \'completed\') as completed, COUNT(*) FILTER (WHERE status = \'running\') as running FROM tasks'),
      executeQuery('SELECT COALESCE(SUM(total_earnings), 0) as total_revenue FROM nodes'),
      executeQuery('SELECT COUNT(*) as total FROM event_log WHERE created_at >= CURRENT_DATE'),
      executeQuery('SELECT COUNT(*) as total FROM webhooks WHERE active = true')
    ]);

    res.json({
      success: true,
      data: {
        nodes: {
          total: parseInt(nodesResult.rows[0].total),
          active: parseInt(nodesResult.rows[0].active)
        },
        skills: {
          total: parseInt(skillsResult.rows[0].total)
        },
        tasks: {
          total: parseInt(tasksResult.rows[0].total),
          completed: parseInt(tasksResult.rows[0].completed),
          running: parseInt(tasksResult.rows[0].running)
        },
        revenue: {
          total: parseFloat(revenueResult.rows[0].total_revenue) || 0,
          currency: process.env.CURRENCY || 'XCL'
        },
        today_events: parseInt(todayEventsResult.rows[0].total),
        active_webhooks: parseInt(webhooksResult.rows[0].total)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. 节点列表（分页 + 筛选）
router.get('/v1/admin/nodes', verifyApiKey, requireAdmin, async (req, res) => {
  try {
    const { status, search, limit = '50', offset = '0' } = req.query;
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(status);
    }
    if (search) {
      conditions.push(`(name ILIKE $${paramIdx} OR node_id ILIKE $${paramIdx})`);
      params.push(`%${search}%`);
      paramIdx++;
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await executeQuery(
      `SELECT COUNT(*) as total FROM nodes ${where}`,
      params
    );

    const limitVal = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const offsetVal = Math.max(parseInt(offset) || 0, 0);

    const result = await executeQuery(
      `SELECT node_id, name, capabilities, tags, public_key, endpoint_url,
              latitude, longitude, status, reputation_score, total_earnings,
              last_heartbeat, created_at, updated_at
       FROM nodes ${where}
       ORDER BY created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limitVal, offsetVal]
    );

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].total),
        limit: limitVal,
        offset: offsetVal
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. 节点详情（含关联数据）
router.get('/v1/admin/nodes/:id', verifyApiKey, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const nodeResult = await executeQuery(
      'SELECT * FROM nodes WHERE node_id = $1',
      [id]
    );

    if (nodeResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Node not found' });
    }

    const [skillsResult, tasksResult, relationshipsResult] = await Promise.all([
      executeQuery('SELECT * FROM skills WHERE node_id = $1 ORDER BY created_at DESC', [id]),
      executeQuery(
        'SELECT id AS task_id, type, status, reward_amount, created_at, updated_at FROM tasks WHERE node_id = $1 ORDER BY created_at DESC LIMIT 20',
        [id]
      ),
      executeQuery(
        'SELECT related_agent_id, type AS relationship_type, avg_rating AS strength, interaction_count, last_interaction_at, created_at FROM agent_relationships WHERE agent_id = $1 ORDER BY avg_rating DESC LIMIT 20',
        [id]
      )
    ]);

    res.json({
      success: true,
      data: {
        node: nodeResult.rows[0],
        skills: skillsResult.rows,
        recent_tasks: tasksResult.rows,
        relationships: relationshipsResult.rows
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. 删除/停用节点
router.delete('/v1/admin/nodes/:id', verifyApiKey, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await executeQuery(
      `UPDATE nodes SET status = 'inactive', updated_at = NOW() WHERE node_id = $1 RETURNING node_id, name, status`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Node not found' });
    }

    res.json({
      success: true,
      data: result.rows[0],
      message: 'Node has been deactivated'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. 全局事件日志（分页 + 筛选）
router.get('/v1/admin/events', verifyApiKey, requireAdmin, async (req, res) => {
  try {
    const { event_type, limit = '50', offset = '0' } = req.query;

    const filters = {
      eventType: event_type || null,
      limit: Math.min(Math.max(parseInt(limit) || 50, 1), 200),
      offset: Math.max(parseInt(offset) || 0, 0)
    };

    const result = await eventBus.queryEvents(filters);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. 所有 webhook 列表（所有用户的）
router.get('/v1/admin/webhooks', verifyApiKey, requireAdmin, async (req, res) => {
  try {
    const { limit = '50', offset = '0' } = req.query;
    const limitVal = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const offsetVal = Math.max(parseInt(offset) || 0, 0);

    const countResult = await executeQuery('SELECT COUNT(*) as total FROM webhooks');
    const result = await executeQuery(
      `SELECT id, node_id, url, events, active, secret, created_at, updated_at
       FROM webhooks
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limitVal, offsetVal]
    );

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].total),
        limit: limitVal,
        offset: offsetVal
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. 过去 24 小时的统计（每小时事件数、任务数）
router.get('/v1/admin/stats/hourly', verifyApiKey, requireAdmin, async (req, res) => {
  try {
    const [eventsHourly, tasksHourly] = await Promise.all([
      executeQuery(
        `SELECT
           EXTRACT(HOUR FROM created_at) as hour,
           COUNT(*) as count
         FROM event_log
         WHERE created_at >= NOW() - INTERVAL '24 hours'
         GROUP BY EXTRACT(HOUR FROM created_at)
         ORDER BY hour`
      ),
      executeQuery(
        `SELECT
           EXTRACT(HOUR FROM created_at) as hour,
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE status = 'completed') as completed,
           COUNT(*) FILTER (WHERE status = 'failed') as failed
         FROM tasks
         WHERE created_at >= NOW() - INTERVAL '24 hours'
         GROUP BY EXTRACT(HOUR FROM created_at)
         ORDER BY hour`
      )
    ]);

    res.json({
      success: true,
      data: {
        events_hourly: eventsHourly.rows,
        tasks_hourly: tasksHourly.rows,
        period: '24h'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 8. 全局计费概览
router.get('/v1/admin/billing/overview', verifyApiKey, requireAdmin, async (req, res) => {
  try {
    const [billingResult, accountsResult, typeBreakdown] = await Promise.all([
      executeQuery(
        `SELECT
           COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) as total_income,
           COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) as total_expense,
           COALESCE(SUM(ABS(amount)), 0) as total_volume,
           COUNT(*) as total_transactions
         FROM transactions WHERE status = 'completed'`
      ),
      executeQuery(
        'SELECT COUNT(DISTINCT node_id) as active_accounts FROM nodes WHERE status = \'active\''
      ),
      executeQuery(
        `SELECT type, COUNT(*) as count, COALESCE(SUM(ABS(amount)), 0) as total_amount
         FROM transactions WHERE status = 'completed'
         GROUP BY type ORDER BY total_amount DESC`
      )
    ]);

    res.json({
      success: true,
      data: {
        total_income: parseFloat(billingResult.rows[0].total_income),
        total_expense: parseFloat(billingResult.rows[0].total_expense),
        total_volume: parseFloat(billingResult.rows[0].total_volume),
        total_transactions: parseInt(billingResult.rows[0].total_transactions),
        active_accounts: parseInt(accountsResult.rows[0].active_accounts),
        breakdown_by_type: typeBreakdown.rows,
        currency: process.env.CURRENCY || 'XCL'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Webhook 死信管理（管理员）
router.get('/v1/admin/webhooks/dead-letter', verifyApiKey, requireAdmin, async (req, res) => {
  try {
    const rows = await listDeadDeliveries({ limit: req.query.limit });
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/v1/admin/webhooks/deliveries/:id/retry', verifyApiKey, requireAdmin, async (req, res) => {
  try {
    const result = await retryDeliveryAdmin(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════
// Phase 5: 多币种支付 — 钱包 + 充值 + 提现 (ETH / BTC / USDT)
// ═════════════════════════════════════════════════════════

// 获取支持的货币
router.get('/v1/payment/chains', verifyApiKey, async (_req, res) => {
  const result = await getSupportedChains();
  res.json(result);
});

// 钱包管理
router.post('/v1/payment/wallets', verifyApiKey, async (req, res) => {
  const { node_id, chain, address, label } = req.body;
  if (!node_id || !chain || !address) {
    return res.status(400).json(formatResponse(false, null, '缺少 node_id, chain, address'));
  }
  const result = await registerWallet(node_id, { chain, address, label });
  res.status(result.success ? 201 : 400).json(result);
});

router.get('/v1/payment/wallets/:node_id', requireAuth, requireAgentId('node_id'), validateUUIDParam('node_id'), async (req, res) => {
  const result = await getWallets(req.params.node_id, { chain: req.query.chain });
  res.json(result);
});

router.put('/v1/payment/wallets/:node_id/:wallet_id/primary', requireAuth, requireAgentId('node_id'), validateUUIDParam('node_id'), async (req, res) => {
  const result = await setPrimaryWallet(req.params.node_id, req.params.wallet_id);
  res.json(result);
});

router.delete('/v1/payment/wallets/:node_id/:wallet_id', requireAuth, requireAgentId('node_id'), validateUUIDParam('node_id'), async (req, res) => {
  const result = await removeWallet(req.params.node_id, req.params.wallet_id);
  res.json(result);
});

// 充值
router.post('/v1/payment/deposit', requireAuth, requireOwnNode(), async (req, res) => {
  const { node_id, chain, tx_hash, amount, currency, from_address, to_address } = req.body;
  if (!node_id || !chain || !tx_hash || !amount) {
    return res.status(400).json(formatResponse(false, null, '缺少 node_id, chain, tx_hash, amount'));
  }
  const result = await createDeposit(node_id, { chain, tx_hash, amount, currency, from_address, to_address });
  res.status(result.success ? 201 : 400).json(result);
});

// 提现
router.post('/v1/payment/withdraw', requireAuth, requireOwnNode(), async (req, res) => {
  const { node_id, chain, to_address, amount, currency } = req.body;
  if (!node_id || !chain || !to_address || !amount) {
    return res.status(400).json(formatResponse(false, null, '缺少 node_id, chain, to_address, amount'));
  }
  const result = await createWithdrawal(node_id, { chain, to_address, amount, currency });
  res.status(result.success ? 201 : 400).json(result);
});

// 管理员确认充值入账（线下核验链上交易后调用）
router.post('/v1/payment/deposits/:tx_id/confirm', verifyApiKey, requireAdmin, async (req, res) => {
  const result = await confirmDeposit(req.params.tx_id, req.body?.note || null);
  res.status(result.success ? 200 : 400).json(result);
});

// 管理员更新提现状态：completed / failed（失败自动退款）
router.post('/v1/payment/withdrawals/:tx_id/:status', verifyApiKey, requireAdmin, async (req, res) => {
  const { tx_id, status } = req.params;
  const result = await updateWithdrawalStatus(tx_id, status, req.body?.note || null);
  res.status(result.success ? 200 : 400).json(result);
});

// 链上交易记录
router.get('/v1/payment/transactions/:node_id', requireAuth, requireAgentId('node_id'), validateUUIDParam('node_id'), async (req, res) => {
  const result = await getChainTransactions(req.params.node_id, {
    chain: req.query.chain,
    type: req.query.type,
    status: req.query.status,
    limit: req.query.limit,
    offset: req.query.offset
  });
  res.json(result);
});

// 支付总览（管理）
router.get('/v1/payment/overview', verifyApiKey, requireAdmin, async (_req, res) => {
  const result = await getPaymentOverview();
  res.json(result);
});

// ============================================================
// 💎 Phase 6: Agent 声誉系统
// ============================================================

// 声誉排行榜
router.get('/v1/reputation/leaderboard', verifyApiKey, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const tag = req.query.tag || null;
    const data = await getLeaderboard({ limit, offset, tag });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Agent 声誉画像
router.get('/v1/reputation/:node_id', verifyApiKey, validateUUIDParam('node_id'), async (req, res) => {
  try {
    const profile = await getReputationProfile(req.params.node_id);
    if (!profile.name) {
      return res.status(404).json({ success: false, error: 'Node not found' });
    }
    res.json({ success: true, data: profile });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 手动触发声誉重算（Admin）
router.post('/v1/reputation/:node_id/recompute', verifyApiKey, requireAdmin, validateUUIDParam('node_id'), async (req, res) => {
  try {
    const result = await updateReputation(req.params.node_id, 'manual');
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 声誉变更历史
router.get('/v1/reputation/:node_id/history', verifyApiKey, validateUUIDParam('node_id'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const reason = req.query.reason || null;
    const history = await getReputationHistory(req.params.node_id, { limit, offset, reason });
    res.json({ success: true, data: history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 声誉趋势
router.get('/v1/reputation/:node_id/trend', verifyApiKey, validateUUIDParam('node_id'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const trend = await getReputationTrend(req.params.node_id, days);
    res.json({ success: true, data: trend });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 记录声誉事件
router.post('/v1/reputation/:node_id/events', verifyApiKey, validateUUIDParam('node_id'), async (req, res) => {
  try {
    const { event_type, event_data } = req.body;
    if (!event_type) {
      return res.status(400).json({ success: false, error: 'event_type is required' });
    }
    const result = await logReputationEvent(req.params.node_id, event_type, event_data || {});
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 批量更新声誉（Admin）
router.post('/v1/reputation/batch/update', verifyApiKey, requireAdmin, async (req, res) => {
  try {
    const batchSize = Math.min(parseInt(req.query.batch_size) || 50, 500);
    const onlyOnline = req.query.only_online !== 'false';
    const results = await batchUpdateReputations({ batchSize, onlyOnline });
    res.json({ success: true, data: { updated: results.length, results } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 处理待处理声誉事件（Admin）
router.post('/v1/reputation/events/process', verifyApiKey, requireAdmin, async (req, res) => {
  try {
    const results = await processPendingEvents({ batchSize: parseInt(req.query.batch_size) || 100 });
    res.json({ success: true, data: { processed: results.length, results } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 全局声誉统计
router.get('/v1/reputation/stats/overview', verifyApiKey, async (_req, res) => {
  try {
    const stats = await getReputationStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 初始化声誉表（Admin）
router.post('/v1/reputation/init', verifyApiKey, requireAdmin, async (_req, res) => {
  try {
    await ensureReputationTables();
    res.json({ success: true, message: 'Reputation tables created' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// Phase 7: 自动化任务市场 API
// ============================================

// 浏览任务市场
router.get('/v1/task-market/browse', verifyApiKey, async (req, res) => {
  try {
    const filters = {
      status: req.query.status,
      type: req.query.type,
      skill_id: req.query.skill_id,
      min_budget: req.query.min_budget,
      max_budget: req.query.max_budget,
      require_bids: req.query.require_bids === 'true',
      limit: req.query.limit,
      offset: req.query.offset
    };
    const result = await browseTasks(filters);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取市场统计
router.get('/v1/task-market/stats', verifyApiKey, async (_req, res) => {
  try {
    const result = await getMarketStats();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 创建任务（市场模式）
router.post('/v1/task-market/tasks', verifyApiKey, async (req, res) => {
  try {
    const { type, title, description, payload, skill_id, budget_min, budget_max, deadline, assignment_strategy, required_skills, priority, min_reputation, bid_deadline } = req.body;
    const caller_id = req.agentId || req.body.caller_id;
    
    const result = await createMarketTask({
      caller_id, type, title, description, payload, skill_id,
      budget_min, budget_max, deadline, assignment_strategy,
      required_skills, priority, min_reputation, bid_deadline
    });
    
    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取任务详情
router.get('/v1/task-market/tasks/:task_id', verifyApiKey, validateUUIDParam('task_id'), async (req, res) => {
  try {
    const { task_id } = req.params;
    const pgPool = getPostgres();
    const result = await pgPool.query(
      `SELECT t.*, c.name as caller_name, n.name as worker_name
       FROM tasks t
       LEFT JOIN nodes c ON t.caller_id = c.node_id
       LEFT JOIN nodes n ON t.node_id = n.node_id
       WHERE t.id = $1`,
      [task_id]
    );
    
    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Task not found' });
    } else {
      res.json({ success: true, data: result.rows[0] });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取任务竞标列表
router.get('/v1/task-market/tasks/:task_id/bids', verifyApiKey, validateUUIDParam('task_id'), async (req, res) => {
  try {
    const { task_id } = req.params;
    const result = await getTaskBids(task_id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 对任务出价
router.post('/v1/task-market/tasks/:task_id/bids', verifyApiKey, validateUUIDParam('task_id'), async (req, res) => {
  try {
    const { task_id } = req.params;
    const bidder_id = req.agentId || req.body.bidder_id;
    const { proposed_price, estimated_duration, proposal } = req.body;
    
    if (!proposed_price) {
      return res.status(400).json({ success: false, error: 'proposed_price is required' });
    }
    
    const result = await placeBid(task_id, bidder_id, {
      proposed_price, estimated_duration, proposal
    });
    
    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 接受竞标（任务发布者）
router.post('/v1/task-market/tasks/:task_id/bids/:bid_id/accept', verifyApiKey, validateUUIDParam('task_id'), validateUUIDParam('bid_id'), async (req, res) => {
  try {
    const { task_id, bid_id } = req.params;
    const caller_id = req.agentId || req.body.caller_id;
    
    const result = await acceptBid(task_id, bid_id, caller_id);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 自动分配任务
router.post('/v1/task-market/tasks/:task_id/assign', verifyApiKey, requireAdmin, validateUUIDParam('task_id'), async (req, res) => {
  try {
    const { task_id } = req.params;
    const result = await autoAssignTask(task_id);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取最佳匹配（用于预览）
router.get('/v1/task-market/tasks/:task_id/matches', verifyApiKey, validateUUIDParam('task_id'), async (req, res) => {
  try {
    const { task_id } = req.params;
    const pgPool = getPostgres();
    
    const taskResult = await pgPool.query('SELECT * FROM tasks WHERE id = $1', [task_id]);
    if (taskResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    
    const matches = await findBestMatches(taskResult.rows[0], 5);
    res.json({ success: true, data: matches });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 完成任务
router.post('/v1/task-market/tasks/:task_id/complete', verifyApiKey, validateUUIDParam('task_id'), async (req, res) => {
  try {
    const { task_id } = req.params;
    const node_id = req.agentId || req.body.node_id;
    const { result } = req.body;
    
    const completeResult = await completeMarketTask(task_id, node_id, result || {});
    
    if (completeResult.success) {
      res.json(completeResult);
    } else {
      res.status(400).json(completeResult);
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 取消任务
router.post('/v1/task-market/tasks/:task_id/cancel', verifyApiKey, validateUUIDParam('task_id'), async (req, res) => {
  try {
    const { task_id } = req.params;
    const caller_id = req.agentId || req.body.caller_id;
    const pgPool = getPostgres();
    
    // 验证任务归属
    const taskResult = await pgPool.query(
      'SELECT * FROM tasks WHERE id = $1 AND caller_id = $2',
      [task_id, caller_id]
    );
    
    if (taskResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Task not found or not authorized' });
    }
    
    const task = taskResult.rows[0];
    if (task.status !== 'pending' && task.status !== 'open') {
      return res.status(400).json({ success: false, error: `Cannot cancel task in status: ${task.status}` });
    }
    
    await pgPool.query(
      `UPDATE tasks SET status = 'cancelled', updated_at = now() WHERE id = $1`,
      [task_id]
    );
    
    // 拒绝所有待处理竞标
    await pgPool.query(
      `UPDATE task_bids SET status = 'cancelled' WHERE task_id = $1 AND status = 'pending'`,
      [task_id]
    );
    
    res.json({ success: true, message: 'Task cancelled' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 撤回竞标
router.post('/v1/task-market/tasks/:task_id/bids/:bid_id/withdraw', verifyApiKey, validateUUIDParam('task_id'), validateUUIDParam('bid_id'), async (req, res) => {
  try {
    const { task_id, bid_id } = req.params;
    const bidder_id = req.agentId || req.body.bidder_id;
    const pgPool = getPostgres();
    
    const bidResult = await pgPool.query(
      'SELECT * FROM task_bids WHERE id = $1 AND task_id = $2 AND bidder_id = $3',
      [bid_id, task_id, bidder_id]
    );
    
    if (bidResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Bid not found or not authorized' });
    }
    
    const bid = bidResult.rows[0];
    if (bid.status !== 'pending') {
      return res.status(400).json({ success: false, error: `Cannot withdraw bid in status: ${bid.status}` });
    }
    
    await pgPool.query(
      `UPDATE task_bids SET status = 'withdrawn', updated_at = now() WHERE id = $1`,
      [bid_id]
    );
    
    res.json({ success: true, message: 'Bid withdrawn' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// Phase 9: 企业级管理控制台 — 实时监控 API
// ============================================

// 系统健康状态
router.get('/v1/monitor/health', verifyApiKey, async (req, res) => {
  try {
    const result = await monitorService.getSystemHealth();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 数据库详细状态
router.get('/v1/monitor/database', verifyApiKey, async (req, res) => {
  try {
    const result = await monitorService.getDatabaseStats();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Redis 状态
router.get('/v1/monitor/redis', verifyApiKey, async (req, res) => {
  try {
    const result = await monitorService.getRedisStats();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 业务 KPI
router.get('/v1/monitor/kpis', verifyApiKey, async (req, res) => {
  try {
    const result = await monitorService.getBusinessKPIs();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 时间序列数据
router.get('/v1/monitor/timeseries/:metric', verifyApiKey, async (req, res) => {
  try {
    const { metric } = req.params;
    const hours = parseInt(req.query.hours) || 24;
    const result = await monitorService.getTimeSeriesData(metric, hours);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 告警
router.get('/v1/monitor/alerts', verifyApiKey, async (req, res) => {
  try {
    const result = await monitorService.getAlerts();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 持久化指标历史
router.get('/v1/monitor/metrics/history', verifyApiKey, async (req, res) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 168);
    const result = await monitorService.getMetricsHistory(hours, req.query.limit);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// Phase 8: 联邦网络 API
// ============================================

// 联邦健康检查（公开端点，用于远端探测）
router.get('/v1/federation/health', async (req, res) => {
  res.json({ 
    success: true, 
    data: { 
      status: 'healthy', 
      network_id: federationService.localNetworkId,
      timestamp: Date.now()
    } 
  });
});

// 注册联邦节点
router.post('/v1/federation/peers', verifyApiKey, async (req, res) => {
  try {
    const { network_id, endpoint, capabilities, node_count, version, skip_verify } = req.body;
    if (!network_id || !endpoint) {
      return res.status(400).json({ success: false, error: 'network_id and endpoint are required' });
    }
    const result = await federationService.registerPeer(network_id, endpoint, { capabilities, node_count, version, skip_verify });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 注销联邦节点
router.delete('/v1/federation/peers/:network_id', verifyApiKey, async (req, res) => {
  try {
    const result = await federationService.unregisterPeer(req.params.network_id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 列出所有联邦节点
router.get('/v1/federation/peers', verifyApiKey, async (req, res) => {
  try {
    const result = await federationService.listPeers();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 联邦网络状态概览
router.get('/v1/federation/status', verifyApiKey, async (req, res) => {
  try {
    const result = await federationService.getFederationStatus();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 联邦任务路由 — 智能寻找最佳执行节点
router.post('/v1/federation/task/route', verifyApiKey, async (req, res) => {
  try {
    const taskData = req.body;
    if (!taskData.type && !taskData.title) {
      return res.status(400).json({ success: false, error: 'Task type or title required' });
    }
    const result = await federationService.routeTaskFederated(taskData);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 分发任务到远端网络
router.post('/v1/federation/task/dispatch', verifyApiKey, async (req, res) => {
  try {
    const { target_network_id, task } = req.body;
    if (!target_network_id || !task) {
      return res.status(400).json({ success: false, error: 'target_network_id and task are required' });
    }
    const result = await federationService.dispatchTaskToPeer(target_network_id, task);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 接收远端任务（被远端调用）
router.post('/v1/federation/task/receive', requireFederationKey, async (req, res) => {
  try {
    const sourceNetwork = req.headers['x-federation-source'] || req.body.source_network;
    const taskData = req.body.task;
    if (!sourceNetwork || !taskData) {
      return res.status(400).json({ success: false, error: 'source_network and task required' });
    }
    const result = await federationService.handleIncomingTask(taskData, sourceNetwork);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 处理远端匹配查询（被远端调用）
router.post('/v1/federation/task/match', requireFederationKey, async (req, res) => {
  try {
    const sourceNetwork = req.headers['x-federation-source'] || req.body.source_network;
    const taskData = req.body.task;
    const result = await federationService.handleMatchQuery(taskData, sourceNetwork);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 请求远端拓扑同步
router.post('/v1/federation/topology/sync/:network_id', verifyApiKey, async (req, res) => {
  try {
    const result = await federationService.requestTopologySync(req.params.network_id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 返回本地拓扑摘要（供远端调用）
router.get('/v1/federation/topology/summary', requireFederationKey, async (req, res) => {
  try {
    const result = await federationService.getLocalTopologySummary();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// MCP 协议适配层路由
// ============================================
import mcpRoutes from './mcpRoutes.js';
router.use(mcpRoutes);

// ============================================
// A2A 协议路由 (Phase 11)
// ============================================
import a2aRoutes from './a2aRoutes.js';
router.use(a2aRoutes);

// ============================================
// 语义搜索 v2 路由 (Phase 12)
// ============================================
import searchRoutes from './searchRoutes.js';
router.use(searchRoutes);

// ============================================
// 开发者平台路由 (Phase 14)
// ============================================
import developerRoutes from './developerRoutes.js';
router.use(developerRoutes);

// ============================================
// 安全合规路由 (Phase 15)
// ============================================
import securityRoutes from './securityRoutes.js';
router.use(securityRoutes);

// ============================================
// 性能监控路由 (Performance)
// ============================================
import performanceRoutes from './performanceRoutes.js';
router.use(performanceRoutes);

// ============================================
// WebSocket 管理路由
// ============================================
import websocketRoutes from './websocketRoutes.js';
router.use(websocketRoutes);

// ============================================
// 导出路由
// ============================================
export default router;
