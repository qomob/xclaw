/**
 * 性能监控路由 — 连接池/缓存/调优建议
 * @module gateway/performanceRoutes
 */

import { Router } from 'express';
import { verifyApiKey } from './auth.js';
import { formatResponse } from '../core/utils.js';
import performanceService from '../services/performanceService.js';

const router = Router();

// 确保 service 已初始化（无前缀挂载时 router.use 会拦截所有进入请求——收敛到本路由器路径）
router.use((req, res, next) => {
  if (!req.path.startsWith('/v1/performance')) return next();
  (async () => {
    try {
      await performanceService.initialize();
    } catch {}
    next();
  })();
});

/**
 * GET /v1/performance/report — 完整性能报告
 */
router.get('/v1/performance/report', verifyApiKey, async (_req, res) => {
  try {
    const report = await performanceService.getFullReport();
    res.json(formatResponse(true, report));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message));
  }
});

/**
 * GET /v1/performance/pool — 连接池状态
 */
router.get('/v1/performance/pool', verifyApiKey, async (_req, res) => {
  try {
    const stats = await performanceService.getPoolStats();
    res.json(formatResponse(true, stats));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message));
  }
});

/**
 * GET /v1/performance/redis — Redis 状态
 */
router.get('/v1/performance/redis', verifyApiKey, async (_req, res) => {
  try {
    const stats = await performanceService.getRedisStats();
    res.json(formatResponse(true, stats));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message));
  }
});

/**
 * GET /v1/performance/cache — 缓存统计
 */
router.get('/v1/performance/cache', verifyApiKey, async (_req, res) => {
  try {
    const stats = performanceService.getCacheStats();
    res.json(formatResponse(true, stats));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message));
  }
});

/**
 * POST /v1/performance/cache/flush — 清空缓存
 */
router.post('/v1/performance/cache/flush', verifyApiKey, async (_req, res) => {
  try {
    await (await import('../services/cacheService.js')).default.flush();
    res.json(formatResponse(true, { flushed: true }));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message));
  }
});

/**
 * GET /v1/performance/tables — 表大小统计
 */
router.get('/v1/performance/tables', verifyApiKey, async (_req, res) => {
  try {
    const tables = await performanceService.getTableSizes();
    res.json(formatResponse(true, tables));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message));
  }
});

export default router;
