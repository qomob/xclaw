// MCP 路由文件
import { Router } from 'express';
import { verifyApiKey } from './auth.js';
import * as mcpService from '../services/mcpService.js';

const router = Router();
router.use(verifyApiKey);

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

// ============================================
// POST /v1/mcp/servers/register — 注册外部 MCP Server
// ============================================
router.post('/v1/mcp/servers/register', async (req, res) => {
  const { name, endpoint, description, capabilities, auth_type, auth_config } = req.body;

  if (!name || !endpoint) {
    return res.status(400).json({ success: false, error: 'name and endpoint are required' });
  }

  const registeredBy = req.agentId || null;
  const result = await mcpService.registerMCPServer(
    { name, endpoint, description, capabilities, auth_type, auth_config },
    registeredBy
  );

  res.status(result.success ? 200 : 400).json(result);
});

// ============================================
// GET /v1/mcp/servers — 列出已注册 MCP Server
// ============================================
router.get('/v1/mcp/servers', async (req, res) => {
  const { status, search, limit, offset } = req.query;
  const filters = {};
  if (status) filters.status = status;
  if (search) filters.search = search;
  if (limit) filters.limit = limit;
  if (offset) filters.offset = offset;

  const result = await mcpService.listMCPServers(filters);
  res.status(200).json(result);
});

// ============================================
// GET /v1/mcp/servers/:serverId — 获取 MCP Server 详情
// ============================================
router.get('/v1/mcp/servers/:serverId', validateUUIDParam('serverId'), async (req, res) => {
  const result = await mcpService.getMCPServer(req.params.serverId);
  res.status(result.success ? 200 : 404).json(result);
});

// ============================================
// DELETE /v1/mcp/servers/:serverId — 注销 MCP Server
// ============================================
router.delete('/v1/mcp/servers/:serverId', validateUUIDParam('serverId'), async (req, res) => {
  const result = await mcpService.unregisterMCPServer(req.params.serverId);
  res.status(result.success ? 200 : 404).json(result);
});

// ============================================
// GET /v1/mcp/servers/:serverId/tools — 列出 MCP Server 的工具列表
// ============================================
router.get('/v1/mcp/servers/:serverId/tools', validateUUIDParam('serverId'), async (req, res) => {
  const result = await mcpService.listMCPServerTools(req.params.serverId);
  res.status(result.success ? 200 : 400).json(result);
});

// ============================================
// POST /v1/mcp/servers/:serverId/invoke — 调用 MCP Server 的工具
// ============================================
router.post('/v1/mcp/servers/:serverId/invoke', validateUUIDParam('serverId'), async (req, res) => {
  const { tool_name, params } = req.body;

  if (!tool_name) {
    return res.status(400).json({ success: false, error: 'tool_name is required' });
  }

  const callerId = req.agentId || null;
  const result = await mcpService.invokeMCPTool(
    req.params.serverId,
    tool_name,
    params || {},
    callerId
  );

  res.status(result.success ? 200 : 400).json(result);
});

// ============================================
// GET /v1/mcp/tools — 列出所有可用的 MCP Tools（聚合）
// ============================================
router.get('/v1/mcp/tools', async (req, res) => {
  const { limit, offset } = req.query;
  const filters = {};
  if (limit) filters.limit = limit;
  if (offset) filters.offset = offset;

  const result = await mcpService.listAllMCPTools(filters);
  res.status(200).json(result);
});

// ============================================
// GET /v1/mcp/tools/export/:nodeId — 导出某 Agent 的技能为 MCP Tools
// ============================================
router.get('/v1/mcp/tools/export/:nodeId', validateUUIDParam('nodeId'), async (req, res) => {
  const result = await mcpService.exportSkillsAsMCPTools(req.params.nodeId);
  res.status(result.success ? 200 : 400).json(result);
});

// ============================================
// GET /v1/mcp/stats — MCP 统计
// ============================================
router.get('/v1/mcp/stats', async (req, res) => {
  const result = await mcpService.getMCPStats();
  res.status(200).json(result);
});

// ============================================
// GET /v1/mcp/logs — 调用日志
// ============================================
router.get('/v1/mcp/logs', async (req, res) => {
  const { server_id, caller_id, status, limit, offset } = req.query;
  const filters = {};
  if (server_id) filters.server_id = server_id;
  if (caller_id) filters.caller_id = caller_id;
  if (status) filters.status = status;
  if (limit) filters.limit = limit;
  if (offset) filters.offset = offset;

  const result = await mcpService.getMCPInvocationLogs(filters);
  res.status(200).json(result);
});

// ============================================
// POST /v1/mcp/servers/:serverId/health — 健康检查
// ============================================
router.post('/v1/mcp/servers/:serverId/health', validateUUIDParam('serverId'), async (req, res) => {
  const result = await mcpService.checkMCPServerHealth(req.params.serverId);
  res.status(result.success ? 200 : 404).json(result);
});

export default router;
