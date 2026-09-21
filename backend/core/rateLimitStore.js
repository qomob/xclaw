// Redis 限流存储：多副本共享计数，重启不清零。
// 不可用时降级为进程内 MemoryStore（fail-open，仅记录告警），避免 Redis 抖动把全站打成 500。
import { MemoryStore } from 'express-rate-limit';
import { getRedis } from './dependencies.js';
import logger from '../services/loggerService.js';

export class RedisRateLimitStore {
  constructor({ prefix = 'ratelimit:', windowMs = 15 * 60 * 1000 } = {}) {
    this.prefix = prefix;
    this.windowMs = windowMs;
    // 计数值跨实例共享，声明 localKeys=false 让 express-rate-limit 走异步计数路径
    this.localKeys = false;
    this.fallback = new MemoryStore();
    this.fallback.init({ windowMs: this.windowMs });
  }

  init(options = {}) {
    if (options.windowMs) this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  async increment(key) {
    try {
      const redis = getRedis();
      const redisKey = `${this.prefix}${key}`;
      const totalHits = await redis.incr(redisKey);
      let ttl = await redis.pttl(redisKey);
      if (totalHits === 1 || ttl < 0) {
        await redis.pexpire(redisKey, this.windowMs);
        ttl = this.windowMs;
      }
      return { totalHits, resetTime: new Date(Date.now() + ttl) };
    } catch (error) {
      logger.warn('Rate limit Redis store unavailable, using in-memory fallback', { error: error.message });
      return this.fallback.increment(key);
    }
  }

  async decrement(key) {
    try {
      await getRedis().decr(`${this.prefix}${key}`);
    } catch (_) {
      /* 降级：忽略 */
    }
  }

  async resetKey(key) {
    try {
      await getRedis().del(`${this.prefix}${key}`);
    } catch (_) {
      /* 降级：忽略 */
    }
  }
}

export function createRedisRateLimitStore(options) {
  return new RedisRateLimitStore(options);
}
