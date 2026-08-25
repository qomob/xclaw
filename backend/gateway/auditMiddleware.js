/**
 * 审计中间件 (Phase 15)
 * 自动记录所有 API 请求到 audit_logs
 * @module auditMiddleware
 */

import securityService from '../services/securityService.js';

/**
 * Express 中间件 — 自动审计所有 API 请求
 * 拦截 res.json，在响应前异步写入审计日志（fire-and-forget）
 * @returns {Function} Express 中间件函数
 */
export default function auditMiddleware() {
  return async (req, res, next) => {
    // 确保服务已初始化
    try {
      if (!securityService.initialized) {
        await securityService.initialize();
      }
    } catch {
      // 初始化失败不影响请求
    }

    const start = Date.now();

    // 捕获原始 res.json
    const originalJson = res.json.bind(res);
    res.json = function (data) {
      // 异步写入审计日志（不阻塞响应）
      const duration = Date.now() - start;
      // 以 HTTP 状态码为准（/health、/v1/topology 等响应体无 success 字段）
      securityService.logAudit(
        req.agentId || req.headers['x-agent-id'] || 'anonymous',
        `${req.method} ${req.path}`,
        req.path,
        res.statusCode < 400 ? 'success' : 'failure',
        req.ip || req.connection?.remoteAddress,
        { method: req.method, duration, statusCode: res.statusCode, userAgent: req.headers['user-agent'] }
      ).catch(() => {}); // 静默失败
      return originalJson(data);
    };
    next();
  };
}
