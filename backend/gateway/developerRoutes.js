/**
 * Developer Routes — 开发者平台 API 路由 (Phase 14)
 *
 * 12 个端点：注册、profile、沙箱管理、API Key 管理。
 * 认证策略：接受系统 API Key 或开发者沙箱/开发 API Key。
 * @module gateway/developerRoutes
 */

import { Router } from 'express';
import { verifyApiKey } from './auth.js';
import config from '../core/config.js';
import developerService from '../services/developerService.js';
import { getPostgres } from '../core/dependencies.js';

const router = Router();

/**
 * 认证中间件：接受系统 API Key 或开发者级 API Key
 * 如果是系统 API Key，放行但 req.developerId 在后续端点中按需获取
 * 如果是开发者级 API Key（sandbox_api_key 或 developer_api_keys），设置 req.developerId
 */
router.use(async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const systemApiKey = config.security.apiKey;

  // 系统级 API Key — 直接放行
  if (authHeader && authHeader === systemApiKey) {
    return next();
  }

  // 非 API Key — 拒绝
  if (!authHeader) {
    return res.status(401).json({ success: false, error: 'Authorization header required' });
  }

  // 尝试匹配开发者级 API Key
  try {
    const pg = getPostgres();

    // 查 developer_profiles.sandbox_api_key
    const { rows } = await pg.query(
      `SELECT developer_id FROM developer_profiles WHERE sandbox_api_key = $1`,
      [authHeader]
    );
    if (rows.length > 0) {
      req.developerId = rows[0].developer_id;
      return next();
    }

    // 查 developer_api_keys (未吊销的)
    const { rows: keyRows } = await pg.query(
      `SELECT developer_id FROM developer_api_keys WHERE api_key = $1 AND revoked_at IS NULL`,
      [authHeader]
    );
    if (keyRows.length > 0) {
      req.developerId = keyRows[0].developer_id;
      return next();
    }

    // 都不匹配
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Authentication error' });
  }
});

// ============================================
// 1. POST /v1/developer/register
// ============================================
router.post('/v1/developer/register', async (req, res) => {
  const { name, email } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, error: 'name is required' });
  }
  const result = await developerService.registerDeveloper(name, email);
  if (result.success) {
    req.developerId = result.data.developer_id;
    res.status(201).json(result);
  } else {
    res.status(400).json(result);
  }
});

// ============================================
// 2. GET /v1/developer/profile
// ============================================
router.get('/v1/developer/profile', async (req, res) => {
  if (!req.developerId) {
    return res.status(404).json({ success: false, error: 'Developer profile not found. Register first.' });
  }
  const result = await developerService.getProfile(req.developerId);
  res.json(result);
});

// ============================================
// 3. GET /v1/developer/sandbox/status
// ============================================
router.get('/v1/developer/sandbox/status', async (req, res) => {
  if (!req.developerId) {
    return res.status(404).json({ success: false, error: 'Developer profile not found. Register first.' });
  }
  const result = await developerService.getSandboxStatus(req.developerId);
  res.json(result);
});

// ============================================
// 4. POST /v1/developer/sandbox/reset
// ============================================
router.post('/v1/developer/sandbox/reset', async (req, res) => {
  if (!req.developerId) {
    return res.status(404).json({ success: false, error: 'Developer profile not found. Register first.' });
  }
  const result = await developerService.resetSandbox(req.developerId);
  res.json(result);
});

// ============================================
// 5. GET /v1/developer/sandbox/agents
// ============================================
router.get('/v1/developer/sandbox/agents', async (req, res) => {
  if (!req.developerId) {
    return res.status(404).json({ success: false, error: 'Developer profile not found. Register first.' });
  }
  const result = await developerService.listSandboxAgents(req.developerId);
  res.json(result);
});

// ============================================
// 6. POST /v1/developer/sandbox/agents
// ============================================
router.post('/v1/developer/sandbox/agents', async (req, res) => {
  if (!req.developerId) {
    return res.status(404).json({ success: false, error: 'Developer profile not found. Register first.' });
  }
  const result = await developerService.createSandboxAgent(req.developerId, req.body);
  if (result.success) {
    res.status(201).json(result);
  } else {
    res.status(400).json(result);
  }
});

// ============================================
// 7. DELETE /v1/developer/sandbox/agents/:agentId
// ============================================
router.delete('/v1/developer/sandbox/agents/:agentId', async (req, res) => {
  if (!req.developerId) {
    return res.status(404).json({ success: false, error: 'Developer profile not found. Register first.' });
  }
  const result = await developerService.deleteSandboxAgent(req.developerId, req.params.agentId);
  res.json(result);
});

// ============================================
// 8. GET /v1/developer/sandbox/tasks
// ============================================
router.get('/v1/developer/sandbox/tasks', async (req, res) => {
  if (!req.developerId) {
    return res.status(404).json({ success: false, error: 'Developer profile not found. Register first.' });
  }
  const result = await developerService.listSandboxTasks(req.developerId);
  res.json(result);
});

// ============================================
// 9. POST /v1/developer/sandbox/tasks
// ============================================
router.post('/v1/developer/sandbox/tasks', async (req, res) => {
  if (!req.developerId) {
    return res.status(404).json({ success: false, error: 'Developer profile not found. Register first.' });
  }
  const result = await developerService.createSandboxTask(req.developerId, req.body);
  if (result.success) {
    res.status(201).json(result);
  } else {
    res.status(400).json(result);
  }
});

// ============================================
// 10. GET /v1/developer/api-keys
// ============================================
router.get('/v1/developer/api-keys', async (req, res) => {
  if (!req.developerId) {
    return res.status(404).json({ success: false, error: 'Developer profile not found. Register first.' });
  }
  const result = await developerService.listApiKeys(req.developerId);
  res.json(result);
});

// ============================================
// 11. POST /v1/developer/api-keys
// ============================================
router.post('/v1/developer/api-keys', async (req, res) => {
  if (!req.developerId) {
    return res.status(404).json({ success: false, error: 'Developer profile not found. Register first.' });
  }
  const { name, permissions } = req.body;
  const result = await developerService.createApiKey(req.developerId, name, permissions);
  if (result.success) {
    res.status(201).json(result);
  } else {
    res.status(400).json(result);
  }
});

// ============================================
// 12. DELETE /v1/developer/api-keys/:keyId
// ============================================
router.delete('/v1/developer/api-keys/:keyId', async (req, res) => {
  if (!req.developerId) {
    return res.status(404).json({ success: false, error: 'Developer profile not found. Register first.' });
  }
  const result = await developerService.revokeApiKey(req.developerId, req.params.keyId);
  res.json(result);
});

export default router;
