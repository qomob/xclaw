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