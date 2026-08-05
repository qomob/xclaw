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

// 验证签名
export function verifySignature(data, signature, publicKey) {
  try {
    if (typeof data === 'string') {
      data = Buffer.from(data);
    }
    return crypto.verify(null, data, {
      key: publicKey,
      type: 'spki',
      format: 'pem'
    }, Buffer.from(signature, 'base64'));
  } catch (error) {
    logger.error('Signature verification error:', error);
    return false;
  }
}

// 生成签名
export function generateSignature(data, privateKey) {
  try {
    if (typeof data === 'string') {
      data = Buffer.from(data);
    }
    const sigBuf = crypto.sign(null, data, {
      key: privateKey,
      type: 'pkcs8',
      format: 'pem'
    });
    return sigBuf.toString('base64');
  } catch (error) {
    logger.error('Signature generation error:', error);
    return null;
  }
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
