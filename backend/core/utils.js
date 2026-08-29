// 工具函数文件
import crypto from 'crypto';
import { v5 as uuidv5 } from 'uuid';
import logger from '../services/loggerService.js';

// 生成 UUID v5
export function generateUUID(name, namespace = '1b671a64-40d5-491e-99b0-da01ff1f3341') {
  return uuidv5(name, namespace);
}

// 生成随机字符串
export function generateRandomString(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

// 生成 API 密钥
export function generateAPIKey() {
  return `api_key_${generateRandomString(16)}`;
}

function isKeyObject(value) {
  return !!value && typeof value === 'object'
    && typeof value.type === 'string'
    && typeof value.asymmetricKeyType === 'string';
}

/**
 * 将公钥解析为 Node KeyObject，兼容两种常见编码：
 * - PEM（Python CLI xclaw_skill.py 使用）
 * - base64 DER SPKI（Node SDK generateKeyPair 使用）
 * @param {string|Buffer|object} publicKey
 * @returns {object|null} crypto.KeyObject 或 null
 */
export function parsePublicKey(publicKey) {
  try {
    if (isKeyObject(publicKey)) return publicKey;
    if (typeof publicKey !== 'string' || !publicKey.trim()) return null;
    const trimmed = publicKey.trim();
    if (trimmed.includes('-----BEGIN')) {
      return crypto.createPublicKey({ key: trimmed, format: 'pem' });
    }
    // base64 DER (SPKI)
    return crypto.createPublicKey({
      key: Buffer.from(trimmed, 'base64'),
      format: 'der',
      type: 'spki'
    });
  } catch (error) {
    logger.error('Public key parse error:', error.message);
    return null;
  }
}

/**
 * 将私钥解析为 Node KeyObject，兼容 PEM 与 base64 DER (PKCS8)
 * @param {string|Buffer|object} privateKey
 * @returns {object|null} crypto.KeyObject 或 null
 */
export function parsePrivateKey(privateKey) {
  try {
    if (isKeyObject(privateKey)) return privateKey;
    if (typeof privateKey !== 'string' || !privateKey.trim()) return null;
    const trimmed = privateKey.trim();
    if (trimmed.includes('-----BEGIN')) {
      return crypto.createPrivateKey({ key: trimmed, format: 'pem' });
    }
    return crypto.createPrivateKey({
      key: Buffer.from(trimmed, 'base64'),
      format: 'der',
      type: 'pkcs8'
    });
  } catch (error) {
    logger.error('Private key parse error:', error.message);
    return null;
  }
}

// 验证签名（公钥支持 PEM 或 base64 DER SPKI）
export function verifySignature(data, signature, publicKey) {
  try {
    const key = parsePublicKey(publicKey);
    if (!key) return false;
    if (typeof data === 'string') {
      data = Buffer.from(data);
    }
    return crypto.verify(null, data, key, Buffer.from(signature, 'base64'));
  } catch (error) {
    logger.error('Signature verification error:', error);
    return false;
  }
}

// 生成签名（私钥支持 PEM 或 base64 DER PKCS8）
export function generateSignature(data, privateKey) {
  try {
    const key = parsePrivateKey(privateKey);
    if (!key) return null;
    if (typeof data === 'string') {
      data = Buffer.from(data);
    }
    const sigBuf = crypto.sign(null, data, key);
    return sigBuf.toString('base64');
  } catch (error) {
    logger.error('Signature generation error:', error);
    return null;
  }
}

// 签名重放防护：timestamp 超出窗口即拒绝（秒级时钟偏差可容忍，窗口可经环境变量调整）
export const SIGNATURE_TIMESTAMP_WINDOW_MS = parseInt(process.env.SIGNATURE_TIMESTAMP_WINDOW_MS || '300000');
export function isTimestampFresh(ts, windowMs = SIGNATURE_TIMESTAMP_WINDOW_MS) {
  let t;
  if (typeof ts === 'number') {
    t = ts;
  } else if (typeof ts === 'string' && /^\d+$/.test(ts.trim())) {
    // HTTP 头携带的毫秒时间戳是数字字符串，Date.parse 无法解析，需先转数值
    t = Number(ts.trim());
  } else {
    t = Date.parse(ts);
  }
  if (!Number.isFinite(t)) return false;
  return Math.abs(Date.now() - t) <= windowMs;
}

// Ed25519 请求签名的标准材料：timestamp 与 body 绑定，截获的签名无法在窗口外重放。
// 客户端与服务端必须使用同一拼接顺序。
export function signaturePayload(timestamp, body) {
  const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
  return `${timestamp}:${bodyString}`;
}

// 计算两个坐标之间的距离（Haversine 公式）
export function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // 地球半径（公里）
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// 角度转弧度
function toRad(deg) {
  return deg * (Math.PI / 180);
}

// 格式化响应
export function formatResponse(success, data, error) {
  return {
    success,
    ...(data && { data }),
    ...(error && { error })
  };
}

// 错误处理中间件
export function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  
  logger.error('API Error:', {
    method: req.method,
    url: req.url,
    status: statusCode,
    message: message,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack
  });

  res.status(statusCode).json(formatResponse(false, null, message));
}

// 验证请求参数
export function validateParams(params, requiredFields) {
  const missingFields = requiredFields.filter(field => !params[field]);
  if (missingFields.length > 0) {
    return { valid: false, message: `Missing required parameters: ${missingFields.join(', ')}` };
  }
  return { valid: true };
}

/**
 * 联邦/跨链出站路径前缀
 * 默认 /api 兼容 nginx 反代（/api/v1/... → /v1/...）；
 * 对端为直连后端时设置 FEDERATION_PATH_PREFIX= 为空
 */
export function federationPath(path) {
  const prefix = (process.env.FEDERATION_PATH_PREFIX || '/api').replace(/\/+$/, '');
  return `${prefix}${path}`;
}
