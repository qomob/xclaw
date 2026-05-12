import { Router } from 'express';
import { verifyApiKey } from './auth.js';
import a2aService from '../services/a2aService.js';

const router = Router();
router.use(verifyApiKey);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateUUID(name) {
  return (req, res, next) => {
    const v = req.params[name];
    if (v && !UUID_REGEX.test(v)) return res.status(400).json({ success: false, error: `Invalid ${name}` });
    next();
  };
}

// POST /v1/a2a/agents/publish — 发布 Agent Card
router.post('/v1/a2a/agents/publish', async (req, res) => {
  const { agent_id, ...cardData } = req.body;
  if (!agent_id) return res.status(400).json({ success: false, error: 'agent_id is required' });
  const result = await a2aService.publishAgentCard(agent_id, cardData);
  res.status(result.success ? 200 : 400).json(result);
});

// GET /v1/a2a/agents/discover — 发现 Agent
router.get('/v1/a2a/agents/discover', async (req, res) => {
  const { query, capability, skill, limit } = req.query;
  const result = await a2aService.discoverAgents(query, { capability, skill }, parseInt(limit) || 10);
  res.json(result);
});

// GET /v1/a2a/agents/:agentId — 获取 Agent Card
router.get('/v1/a2a/agents/:agentId', validateUUID('agentId'), async (req, res) => {
  const result = await a2aService.getAgentCard(req.params.agentId);
  res.status(result.success ? 200 : 404).json(result);
});

// PUT /v1/a2a/agents/:agentId — 更新 Agent Card
router.put('/v1/a2a/agents/:agentId', validateUUID('agentId'), async (req, res) => {
  const result = await a2aService.updateAgentCard(req.params.agentId, req.body);
  res.json(result);
});

// DELETE /v1/a2a/agents/:agentId — 注销 Agent Card
router.delete('/v1/a2a/agents/:agentId', validateUUID('agentId'), async (req, res) => {
  const result = await a2aService.unpublishAgentCard(req.params.agentId);
  res.json(result);
});

// POST /v1/a2a/tasks/send — 发送 A2A Task
router.post('/v1/a2a/tasks/send', async (req, res) => {
  const { agent_id, ...task } = req.body;
  if (!agent_id) return res.status(400).json({ success: false, error: 'agent_id is required' });
  if (!task.to_agent_id) return res.status(400).json({ success: false, error: 'to_agent_id is required' });
  const result = await a2aService.sendTask(agent_id, task);
  res.status(result.success ? 200 : 400).json(result);
});

// POST /v1/a2a/tasks/receive — 接收 A2A Task
router.post('/v1/a2a/tasks/receive', async (req, res) => {
  const { from_agent_id, ...task } = req.body;
  if (!from_agent_id) return res.status(400).json({ success: false, error: 'from_agent_id is required' });
  const result = await a2aService.receiveTask(from_agent_id, task);
  res.status(result.success ? 200 : 400).json(result);
});

// GET /v1/a2a/tasks/:taskId — 查询 Task 状态
router.get('/v1/a2a/tasks/:taskId', validateUUID('taskId'), async (req, res) => {
  const result = await a2aService.getTaskStatus(req.params.taskId);
  res.status(result.success ? 200 : 404).json(result);
});

// PUT /v1/a2a/tasks/:taskId — 更新 Task 状态
router.put('/v1/a2a/tasks/:taskId', validateUUID('taskId'), async (req, res) => {
  const { status, result } = req.body;
  if (!status) return res.status(400).json({ success: false, error: 'status is required' });
  const r = await a2aService.updateTaskStatus(req.params.taskId, status, result);
  res.json(r);
});

// POST /v1/a2a/messages — 发送消息
router.post('/v1/a2a/messages', async (req, res) => {
  const { from_agent_id, to_agent_id, content, message_type } = req.body;
  if (!from_agent_id || !to_agent_id || !content) {
    return res.status(400).json({ success: false, error: 'from_agent_id, to_agent_id, content are required' });
  }
  const result = await a2aService.sendMessage(from_agent_id, to_agent_id, content, message_type);
  res.json(result);
});

// GET /v1/a2a/messages/:agentId — 获取消息
router.get('/v1/a2a/messages/:agentId', validateUUID('agentId'), async (req, res) => {
  const { limit, offset } = req.query;
  const result = await a2aService.getMessages(req.params.agentId, parseInt(limit) || 20, parseInt(offset) || 0);
  res.json(result);
});

// GET /v1/a2a/negotiate — 能力协商
router.get('/v1/a2a/negotiate', async (req, res) => {
  const { local, remote } = req.query;
  if (!local || !remote) return res.status(400).json({ success: false, error: 'local and remote params required' });
  const result = await a2aService.negotiateCapabilities(local, remote);
  res.json(result);
});

// GET /v1/a2a/stats — A2A 统计
router.get('/v1/a2a/stats', async (_req, res) => {
  const result = await a2aService.getA2AStats();
  res.json(result);
});

export default router;
