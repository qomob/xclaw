// 依赖管理文件
import config from './config.js';
import Redis from 'ioredis';
import { Pool } from 'pg';
import logger from '../services/loggerService.js';

// 数据库连接池
let pgPool = null;
let redisClient = null;

// 初始化 PostgreSQL 连接池
export function initPostgres() {
  const poolConfig = config.database.postgres.connectionString 
    ? { connectionString: config.database.postgres.connectionString }
    : {
        host: config.database.postgres.host,
        port: config.database.postgres.port,
        user: config.database.postgres.user,
        password: config.database.postgres.password,
        database: config.database.postgres.database,
      };

  pgPool = new Pool({
    ...poolConfig,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
  });

  pgPool.on('error', (err) => {
    logger.error('PostgreSQL connection error:', err);
  });

  return pgPool;
}

// 初始化 Redis 客户端
export function initRedis() {
  // 幂等：模块加载期 getRedis() 可能已建立首个连接，避免再建第二条导致连接泄漏
  if (redisClient) return redisClient;

  const pw = config.database.redis.password;
  logger.info('Initializing Redis', { host: config.database.redis.host, port: config.database.redis.port, hasPassword: !!pw });

  redisClient = new Redis({
    host: config.database.redis.host,
    port: config.database.redis.port,
    password: pw || undefined,
    enableReadyCheck: true,
    retryStrategy(times) {
      // 永不放弃：返回 null 会让 ioredis 永久停止重连，进程不自愈只能重启。
      // 以 5s 封顶的退避持续重试，等待 Redis 恢复。
      return Math.min(times * 200, 5000);
    }
  });

  redisClient.on('error', (err) => {
    logger.error('Redis connection error:', err);
  });

  redisClient.on('connect', () => {
    logger.info('Redis connected successfully');
  });

  return redisClient;
}

// 获取 PostgreSQL 连接池
export function getPostgres() {
  if (!pgPool) {
    return initPostgres();
  }
  return pgPool;
}

// 获取 Redis 客户端
export function getRedis() {
  if (!redisClient) {
    return initRedis();
  }
  return redisClient;
}

/**
 * 检查数据库健康状态
 * @returns {Promise<boolean>}
 */
export async function checkPostgresHealth() {
  if (!pgPool) return false;
  try {
    const client = await pgPool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (error) {
    logger.error('PostgreSQL health check failed:', error);
    return false;
  }
}

/**
 * 检查 Redis 健康状态
 * @returns {Promise<boolean>}
 */
export async function checkRedisHealth() {
  if (!redisClient) return false;
  try {
    await redisClient.ping();
    return true;
  } catch (error) {
    logger.error('Redis health check failed:', error);
    return false;
  }
}

// 关闭所有连接
export function closeConnections() {
  if (pgPool) {
    pgPool.end();
  }
  if (redisClient) {
    redisClient.quit();
  }
}