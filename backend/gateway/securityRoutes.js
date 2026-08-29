/**
 * 安全合规路由 (Phase 15)
 * 提供 OAuth2、审计日志、速率限制 API 端点
 * @module securityRoutes
 */

import express from 'express';
import securityService from '../services/securityService.js';
import { verifyApiKey } from './auth.js';

const router = express.Router();

/**
 * 确保安全服务已初始化的中间件
 */
async function ensureInitialized(req, res, next) {
  try {
    if (!securityService.initialized) {
      await securityService.initialize();
    }
    next();
  } catch (error) {
    res.status(500).json({ success: false, error: `Security service init failed: ${error.message}` });
  }
}

// 无前缀挂载时 router.use 会拦截所有进入请求——收敛到本路由器路径
router.use((req, res, next) => {
  if (!req.path.startsWith('/v1/security')) return next();
  return ensureInitialized(req, res, next);
});

// ============================================================
// OAuth2 端点
// ============================================================

/**
 * POST /v1/security/oauth/token
 * OAuth2 Token 端点 — 支持 password, client_credentials, refresh_token
 */
router.post('/v1/security/oauth/token', verifyApiKey, async (req, res) => {
  const { grant_type, client_id, client_secret, refresh_token, username, password, agent_id } = req.body;

  if (!grant_type) {
    return res.status(400).json({ success: false, error: 'Missing grant_type' });
  }

  const result = await securityService.issueToken(grant_type, {
    client_id,
    client_secret,
    refresh_token,
    username,
    password,
    agent_id
  });

  if (result.success) {
    res.status(200).json(result);
  } else {
    res.status(400).json(result);
  }
});

/**
 * POST /v1/security/oauth/revoke
 * 吊销 Token
 */
router.post('/v1/security/oauth/revoke', verifyApiKey, async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ success: false, error: 'Missing token' });
  }

  const result = await securityService.revokeToken(token);
  if (result.success) {
    res.status(200).json(result);
  } else {
    res.status(400).json(result);
  }
});

/**
 * GET /v1/security/oauth/introspect
 * Token 内省 — 验证 token 有效性
 */
router.get('/v1/security/oauth/introspect', verifyApiKey, async (req, res) => {
  const token = req.query.token || req.headers['x-token'];

  if (!token) {
    return res.status(400).json({ success: false, error: 'Missing token parameter' });
  }

  const result = await securityService.introspectToken(token);
  res.status(200).json(result);
});

/**
 * POST /v1/security/oauth/clients
 * 注册 OAuth2 Client
 */
router.post('/v1/security/oauth/clients', verifyApiKey, async (req, res) => {
  const { name, redirect_uris, grant_types } = req.body;

  if (!name) {
    return res.status(400).json({ success: false, error: 'Missing client name' });
  }

  const result = await securityService.registerClient(
    name,
    redirect_uris || [],
    grant_types || ['client_credentials']
  );

  if (result.success) {
    res.status(201).json(result);
  } else {
    res.status(400).json(result);
  }
});

/**
 * GET /v1/security/oauth/clients
 * 列出所有 OAuth2 Clients
 */
router.get('/v1/security/oauth/clients', verifyApiKey, async (req, res) => {
  const result = await securityService.listClients();
  res.status(200).json(result);
});

// ============================================================
// 审计日志端点
// ============================================================

/**
 * POST /v1/security/audit/logs
 * 写入审计日志
 */
router.post('/v1/security/audit/logs', verifyApiKey, async (req, res) => {
  const { agent_id, action, resource, result, ip_address, metadata } = req.body;

  if (!action) {
    return res.status(400).json({ success: false, error: 'Missing action' });
  }

  const logResult = await securityService.logAudit(
    agent_id,
    action,
    resource,
    result,
    ip_address,
    metadata
  );

  res.status(200).json(logResult);
});

/**
 * GET /v1/security/audit/logs
 * 查询审计日志（支持过滤）
 */
router.get('/v1/security/audit/logs', verifyApiKey, async (req, res) => {
  const { agent_id, action, from_date, to_date, limit, offset } = req.query;

  const result = await securityService.queryAuditLogs({
    agent_id,
    action,
    from_date,
    to_date,
    limit: limit ? parseInt(limit) : undefined,
    offset: offset ? parseInt(offset) : undefined
  });

  res.status(200).json(result);
});

/**
 * GET /v1/security/audit/stats
 * 审计统计 — 按 action 类型聚合
 */
router.get('/v1/security/audit/stats', verifyApiKey, async (req, res) => {
  const result = await securityService.getAuditStats();
  res.status(200).json(result);
});

// ============================================================
// 速率限制端点
// ============================================================

/**
 * GET /v1/security/rate-limits
 * 获取当前速率限制配置
 */
router.get('/v1/security/rate-limits', verifyApiKey, async (req, res) => {
  const result = await securityService.getRateLimitConfig();
  res.status(200).json(result);
});

/**
 * PUT /v1/security/rate-limits
 * 更新速率限制配置
 */
router.put('/v1/security/rate-limits', verifyApiKey, async (req, res) => {
  const { window_ms, max_requests, tier_limits } = req.body;

  const result = await securityService.updateRateLimitConfig({
    window_ms,
    max_requests,
    tier_limits
  });

  if (result.success) {
    res.status(200).json(result);
  } else {
    res.status(400).json(result);
  }
});

/**
 * GET /v1/security/rate-limits/status/:agentId
 * 获取特定 agent 的速率使用情况
 */
router.get('/v1/security/rate-limits/status/:agentId', verifyApiKey, async (req, res) => {
  const { agentId } = req.params;

  if (!agentId) {
    return res.status(400).json({ success: false, error: 'Missing agentId' });
  }

  const result = await securityService.getRateLimitStatus(agentId);
  res.status(200).json(result);
});

// ============================================================
// 安全总览统计
// ============================================================

/**
 * GET /v1/security/stats
 * 安全总览统计
 */
router.get('/v1/security/stats', verifyApiKey, async (req, res) => {
  const result = await securityService.getSecurityStats();
  res.status(200).json(result);
});

export default router;
