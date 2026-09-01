// 认证管理文件
import crypto from 'crypto';
import { verifySignature, isTimestampFresh, signaturePayload } from '../core/utils.js';
import { getNode } from '../registry/nodeRegistry.js';
import config from '../core/config.js';
import logger from '../services/loggerService.js';
import { verifyCallbackSignature } from '../services/withdrawalExecutor.js';
import authService from '../services/authService.js';

// 验证请求签名
export async function verifyRequestSignature(req, res, next) {
  const signature = req.headers['x-agent-signature'];
  const agentId = req.params.agent_id || req.body.node_id;

  if (!signature || !agentId) {
    return res.status(401).json({
      success: false,
      error: 'Missing signature or agent ID'
    });
  }

  // 重放防护：新协议要求 x-agent-timestamp 参与签名材料（timestamp:body），
  // 剥离头或重放超出窗口的请求均无法通过验签。
  // 兼容期：未带 timestamp 的旧格式（仅 body）仍接受，但视为待废弃并告警。
  const tsHeader = req.headers['x-agent-timestamp'];
  if (tsHeader === undefined) {
    logger.warn('Deprecation: unsigned timestamp in agent signature — replay protection inactive', {
      agentId, path: req.path
    });
  } else if (!isTimestampFresh(tsHeader)) {
    return res.status(401).json({
      success: false,
      error: 'Signature timestamp expired or invalid'
    });
  }

  // 获取节点信息
  const nodeResult = await getNode(agentId);
  if (!nodeResult.success) {
    return res.status(401).json({
      success: false,
      error: 'Agent not found'
    });
  }

  // 验证签名
  const requestData = tsHeader !== undefined
    ? signaturePayload(tsHeader, req.body)
    : JSON.stringify(req.body);
  if (!verifySignature(requestData, signature, nodeResult.data.public_key)) {
    return res.status(401).json({
      success: false,
      error: 'Invalid signature'
    });
  }

  next();
}

// 验证 API 密钥
export function verifyApiKey(req, res, next) {
  const apiKey = req.headers['authorization'];
  const validApiKey = config.security.apiKey;
  const adminKey = config.security.adminApiKey;

  if (!validApiKey) {
    return res.status(500).json({
      success: false,
      error: 'Server configuration error: API_KEY not set'
    });
  }

  // 独立管理密钥是合法凭据：可通认证且 isAdmin=true；
  // 系统 Key 仅通认证（isAdmin=false）——两把钥匙必须不同值
  if (!apiKey || (!safeEqual(apiKey, validApiKey) && !(adminKey && safeEqual(apiKey, adminKey)))) {
    return res.status(401).json({
      success: false,
      error: 'Invalid API key'
    });
  }

  req.isAdmin = !!(adminKey && safeEqual(apiKey, adminKey));
  next();
}

/**
 * 平台 API Key 或 Agent 认证（JWT / x-api-key）二选一。
 * 用于面向 UI/Agent 的只读资源（如任务市场浏览），
 * 允许已登录 Agent 读取，同时保留服务器端/CLI 使用平台 Key 的路径。
 */
export function verifyApiKeyOrAgent(req, res, next) {
  const apiKey = req.headers['authorization'];
  const validApiKey = config.security.apiKey;
  const adminKey = config.security.adminApiKey;
  // 管理密钥优先：管理台/运维用 ADMIN_API_KEY 读取面向 Agent 的资源
  // （此前 admin Key 在此 401，管理台的部分面板被 allSettled 静默吞掉）
  if (apiKey && adminKey && safeEqual(apiKey, adminKey)) {
    req.isAdmin = true;
    return next();
  }
  if (apiKey && validApiKey && safeEqual(apiKey, validApiKey)) {
    req.isAdmin = config.security.adminApiKey && safeEqual(apiKey, config.security.adminApiKey);
    return next();
  }
  return authService.authMiddleware(req, res, next);
}

export function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }
  next();
}

/**
 * 校验路径参数中的资源 ID 必须属于当前认证主体（JWT/API Key）
 * @param {string} paramName 路由参数名，默认 agent_id
 */
export function requireAgentId(paramName = 'agent_id') {
  return (req, res, next) => {
    const targetId = req.params[paramName];
    if (!req.agentId || !targetId || req.agentId !== targetId) {
      return res.status(403).json({
        success: false,
        error: '无权访问该资源'
      });
    }
    next();
  };
}

/**
 * 校验请求体中的 node_id 必须属于当前认证主体
 * @param {string} bodyField 请求体字段名，默认 node_id
 */
export function requireOwnNode(bodyField = 'node_id') {
  return (req, res, next) => {
    const targetId = req.body?.[bodyField];
    if (!req.agentId || !targetId || req.agentId !== targetId) {
      return res.status(403).json({
        success: false,
        error: '无权操作该节点'
      });
    }
    next();
  };
}

/**
 * 联邦网络共享密钥校验（防止未授权实例写入/读取联邦数据）
 * fail-closed：未配置 FEDERATION_KEY 时联邦端点一律拒绝——
 * 不回退系统 API_KEY，否则任意系统 Key 持有者即可跨网读写
 */
export function requireFederationKey(req, res, next) {
  const expected = process.env.FEDERATION_KEY;
  if (!expected) {
    return res.status(503).json({
      success: false,
      error: 'FEDERATION_KEY not configured — federation endpoints are disabled'
    });
  }
  const provided = req.headers['x-federation-key'] || '';
  if (!safeEqual(provided, expected)) {
    return res.status(401).json({
      success: false,
      error: 'Invalid federation key'
    });
  }
  next();
}

/**
 * 提现执行器回调验签（HMAC-SHA256，基于原始请求体）
 */
export function verifyWithdrawalCallback(req, res, next) {
  const signature = req.headers['x-xclaw-signature'] || '';
  const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
  if (!verifyCallbackSignature(raw, signature)) {
    return res.status(401).json({ success: false, error: 'Invalid callback signature' });
  }
  next();
}

// 验证 WebSocket 连接
export async function verifyWebSocketConnection(agentId, signature, timestamp) {
  // 重放防护：timestamp 为签名材料的一部分，超出窗口即拒绝
  if (!isTimestampFresh(timestamp)) {
    return false;
  }

  // 获取节点信息
  const nodeResult = await getNode(agentId);
  if (!nodeResult.success) {
    return false;
  }

  // 验证签名
  const authData = JSON.stringify({ agent_id: agentId, timestamp });
  if (!verifySignature(authData, signature, nodeResult.data.public_key)) {
    return false;
  }

  return true;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
