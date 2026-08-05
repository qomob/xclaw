// 认证管理文件
import crypto from 'crypto';
import { verifySignature } from '../core/utils.js';
import { getNode } from '../registry/nodeRegistry.js';
import config from '../core/config.js';

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
  
  // 获取节点信息
  const nodeResult = await getNode(agentId);
  if (!nodeResult.success) {
    return res.status(401).json({
      success: false,
      error: 'Agent not found'
    });
  }
  
  // 验证签名
  const requestData = JSON.stringify(req.body);
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
  
  if (!validApiKey) {
    return res.status(500).json({
      success: false,
      error: 'Server configuration error: API_KEY not set'
    });
  }
  
  if (!apiKey || !safeEqual(apiKey, validApiKey)) {
    return res.status(401).json({
      success: false,
      error: 'Invalid API key'
    });
  }

  req.isAdmin = safeEqual(apiKey, config.security.adminApiKey);
  next();
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
 * 使用 FEDERATION_KEY 环境变量，未配置时回退 API_KEY
 */
export function requireFederationKey(req, res, next) {
  const expected = process.env.FEDERATION_KEY || config.security.apiKey;
  if (!expected) {
    return res.status(500).json({
      success: false,
      error: 'FEDERATION_KEY not configured'
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

// 验证 WebSocket 连接
export async function verifyWebSocketConnection(agentId, signature, timestamp) {
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
