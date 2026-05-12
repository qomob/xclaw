/**
 * 缓存服务 — Redis-based 缓存层
 * 支持 TTL, LRU 淘汰, 命名空间隔离
 * @module services/cacheService
 */

import { getRedis } from '../core/dependencies.js';
import logger from './loggerService.js';

class CacheService {
  constructor() {
    this.initialized = false;
    /** @type {Map<string, {data: *, expireAt: number}>} 进程内 L1 缓存 */
    this._l1 = new Map();
    this._l1MaxSize = 500;
    this._l1CleanupInterval = null;
    this._stats = { hits: 0, misses: 0, sets: 0, l1Hits: 0, l2Hits: 0 };
  }

  async initialize() {
    if (this.initialized) return;
    // 每 60 秒清理过期 L1 缓存
    this._l1CleanupInterval = setInterval(() => this._cleanupL1(), 60000);
    this.initialized = true;
    logger.info('CacheService initialized (L1 memory + L2 Redis)');
  }

  /**
   * 获取缓存 — L1 → L2 → miss
   * @param {string} key
   * @returns {Promise<*|null>}
   */
  async get(key) {
    // L1 检查
    const l1 = this._l1.get(key);
    if (l1 && l1.expireAt > Date.now()) {
      this._stats.hits++;
      this._stats.l1Hits++;
      return l1.data;
    }
    if (l1) this._l1.delete(key); // 已过期

    // L2 Redis 检查
    try {
      const redis = getRedis();
      const raw = await redis.get(`cache:${key}`);
      if (raw) {
        const data = JSON.parse(raw);
        // 回填 L1
        this._setL1(key, data, 30); // L1 TTL 固定 30 秒
        this._stats.hits++;
        this._stats.l2Hits++;
        return data;
      }
    } catch (err) {
      logger.warn('Cache L2 get error:', err.message);
    }

    this._stats.misses++;
    return null;
  }

  /**
   * 设置缓存
   * @param {string} key
   * @param {*} data
   * @param {number} [ttlSeconds=60] L2 TTL（秒）
   */
  async set(key, data, ttlSeconds = 60) {
    this._stats.sets++;
    // L1
    this._setL1(key, data, Math.min(ttlSeconds, 30));

    // L2 Redis
    try {
      const redis = getRedis();
      await redis.set(`cache:${key}`, JSON.stringify(data), 'EX', ttlSeconds);
    } catch (err) {
      logger.warn('Cache L2 set error:', err.message);
    }
  }

  /**
   * 删除缓存
   * @param {string} key
   */
  async del(key) {
    this._l1.delete(key);
    try {
      const redis = getRedis();
      await redis.del(`cache:${key}`);
    } catch (err) {
      logger.warn('Cache L2 del error:', err.message);
    }
  }

  async delete(key) {
    return this.del(key);
  }

  /**
   * 按前缀批量删除
   * @param {string} prefix
   */
  async delByPrefix(prefix) {
    // 清 L1
    for (const k of this._l1.keys()) {
      if (k.startsWith(prefix)) this._l1.delete(k);
    }
    // 清 L2
    try {
      const redis = getRedis();
      const keys = await redis.keys(`cache:${prefix}*`);
      if (keys.length > 0) await redis.del(...keys);
    } catch (err) {
      logger.warn('Cache L2 delByPrefix error:', err.message);
    }
  }

  /**
   * 获取或计算 — 缓存穿透保护
   * @param {string} key
   * @param {number} ttlSeconds
   * @param {function(): Promise<*>} fetcher
   * @returns {Promise<*>}
   */
  async getOrSet(key, ttlSeconds, fetcher) {
    const cached = await this.get(key);
    if (cached !== null) return cached;

    const data = await fetcher();
    if (data !== null && data !== undefined) {
      await this.set(key, data, ttlSeconds);
    }
    return data;
  }

  /**
   * 缓存统计
   * @returns {object}
   */
  getStats() {
    const total = this._stats.hits + this._stats.misses;
    return {
      ...this._stats,
      hitRate: total > 0 ? (this._stats.hits / total * 100).toFixed(1) + '%' : '0%',
      l1Size: this._l1.size,
      l1MaxSize: this._l1MaxSize,
      total
    };
  }

  /**
   * 清空所有缓存
   */
  async flush() {
    this._l1.clear();
    try {
      const redis = getRedis();
      const keys = await redis.keys('cache:*');
      if (keys.length > 0) await redis.del(...keys);
    } catch (err) {
      logger.warn('Cache flush error:', err.message);
    }
    this._stats = { hits: 0, misses: 0, sets: 0, l1Hits: 0, l2Hits: 0 };
  }

  async clear() {
    return this.flush();
  }

  /** @private L1 设置 */
  _setL1(key, data, ttlSeconds) {
    // LRU 淘汰
    if (this._l1.size >= this._l1MaxSize) {
      const oldest = this._l1.keys().next().value;
      this._l1.delete(oldest);
    }
    this._l1.set(key, { data, expireAt: Date.now() + ttlSeconds * 1000 });
  }

  /** @private L1 过期清理 */
  _cleanupL1() {
    const now = Date.now();
    for (const [k, v] of this._l1) {
      if (v.expireAt <= now) this._l1.delete(k);
    }
  }
}

export default new CacheService();
