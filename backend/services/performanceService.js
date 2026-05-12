/**
 * 性能服务 — 连接池管理 + 性能监控 + 调优建议
 * @module services/performanceService
 */

import { getPostgres, getRedis } from '../core/dependencies.js';
import logger from './loggerService.js';
import cacheService from './cacheService.js';

class PerformanceService {
  constructor() {
    this.initialized = false;
    this._metrics = { queries: 0, slowQueries: 0, avgResponseTime: 0, totalResponseTime: 0 };
  }

  async initialize() {
    if (this.initialized) return;
    await cacheService.initialize();
    this.initialized = true;
    logger.info('PerformanceService initialized');
  }

  /**
   * 获取 PostgreSQL 连接池状态
   * @returns {Promise<object>}
   */
  async getPoolStats() {
    const pg = getPostgres();
    return {
      totalCount: pg.totalCount,
      idleCount: pg.idleCount,
      waitingCount: pg.waitingCount,
      maxPoolSize: pg.options?.max || 20,
      utilizationPercent: pg.totalCount > 0 ? ((pg.totalCount - pg.idleCount) / (pg.options?.max || 20) * 100).toFixed(1) : '0'
    };
  }

  /**
   * 获取 Redis 内存和连接信息
   * @returns {Promise<object>}
   */
  async getRedisStats() {
    const redis = getRedis();
    const info = await redis.info('memory');
    const clientsInfo = await redis.info('clients');

    const memLine = info.split('\r\n').find(l => l.startsWith('used_memory_human:'));
    const peakLine = info.split('\r\n').find(l => l.startsWith('used_memory_peak_human:'));
    const clientsLine = clientsInfo.split('\r\n').find(l => l.startsWith('connected_clients:'));

    return {
      usedMemory: memLine ? memLine.split(':')[1] : 'unknown',
      peakMemory: peakLine ? peakLine.split(':')[1] : 'unknown',
      connectedClients: clientsLine ? parseInt(clientsLine.split(':')[1]) : 0,
      keyspaceSize: await this._getKeyspaceSize(redis)
    };
  }

  /**
   * 缓存统计
   * @returns {object}
   */
  getCacheStats() {
    return cacheService.getStats();
  }

  /**
   * 慢查询检测
   * @returns {Promise<Array>}
   */
  async getSlowQueries() {
    const pg = getPostgres();
    try {
      const result = await pg.query(`
        SELECT query, calls, total_time, mean_time, rows
        FROM pg_stat_statements
        WHERE mean_time > 100
        ORDER BY mean_time DESC
        LIMIT 10
      `);
      return result.rows;
    } catch {
      return [{ note: 'pg_stat_statements extension not enabled' }];
    }
  }

  /**
   * 表大小统计
   * @returns {Promise<Array>}
   */
  async getTableSizes() {
    const pg = getPostgres();
    const result = await pg.query(`
      SELECT relname as table_name,
             pg_size_pretty(pg_total_relation_size(relid)) as total_size,
             pg_size_pretty(pg_relation_size(relid)) as table_size,
             pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) as index_size,
             n_live_tup as row_count
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 15
    `);
    return result.rows;
  }

  /**
   * 获取调优建议
   * @param {object} poolStats
   * @param {object} redisStats
   * @returns {Array<string>}
   */
  getRecommendations(poolStats, redisStats) {
    const recs = [];

    // 连接池利用率
    const util = parseFloat(poolStats.utilizationPercent);
    if (util > 80) {
      recs.push(`⚠️ 连接池利用率 ${util}%，建议增加 max pool size (当前 ${poolStats.maxPoolSize})`);
    } else if (util < 20 && poolStats.maxPoolSize > 10) {
      recs.push(`ℹ️ 连接池利用率低 (${util}%)，可考虑减小 pool size 节省资源`);
    }

    // 等待连接
    if (poolStats.waitingCount > 0) {
      recs.push(`🔴 有 ${poolStats.waitingCount} 个请求等待连接，建议优化慢查询或增加连接数`);
    }

    // Redis 内存
    const memStr = redisStats.usedMemory || '0M';
    const memNum = parseFloat(memStr);
    if (memNum > 100) {
      recs.push(`⚠️ Redis 内存使用 ${memStr}，建议检查大 key 或设置过期策略`);
    }

    // 缓存命中率
    const cacheStats = this.getCacheStats();
    const hitRate = parseFloat(cacheStats.hitRate);
    if (hitRate < 50 && cacheStats.total > 100) {
      recs.push(`⚠️ 缓存命中率 ${cacheStats.hitRate}，建议增加缓存 TTL 或扩大缓存范围`);
    } else if (hitRate > 90) {
      recs.push(`✅ 缓存命中率优秀 (${cacheStats.hitRate})`);
    }

    if (recs.length === 0) {
      recs.push('✅ 系统运行良好，暂无调优建议');
    }

    return recs;
  }

  /**
   * 完整性能报告
   * @returns {Promise<object>}
   */
  async getFullReport() {
    const poolStats = await this.getPoolStats();
    const redisStats = await this.getRedisStats();
    const tableSizes = await this.getTableSizes();
    const cacheStats = this.getCacheStats();
    const recommendations = this.getRecommendations(poolStats, redisStats);

    return {
      pool: poolStats,
      redis: redisStats,
      cache: cacheStats,
      tables: tableSizes,
      recommendations,
      timestamp: new Date().toISOString()
    };
  }

  /** @private */
  async _getKeyspaceSize(redis) {
    try {
      const dbsize = await redis.dbsize();
      return dbsize;
    } catch {
      return 0;
    }
  }
}

export default new PerformanceService();
