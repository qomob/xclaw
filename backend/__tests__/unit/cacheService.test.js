import cacheService from '../../services/cacheService.js';
import { getRedis, initRedis } from '../../core/dependencies.js';
import net from 'net';

// 探测本地 Redis：不可用时跳过（这些用例需要真实 Redis）
let redisAvailable = false;
try {
  await new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: 6379 }, () => { sock.destroy(); resolve(); });
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); reject(new Error('redis timeout')); }, 500);
  });
  redisAvailable = true;
} catch {}

const testIt = redisAvailable ? test : test.skip;

describe('CacheService Unit Tests', () => {
  beforeAll(async () => {
    if (!redisAvailable) return;
    await initRedis();
  });

  afterAll(async () => {
    if (!redisAvailable) return;
    await cacheService.clear();
  });

  testIt('should set and get cache values', async () => {
    const key = 'test_key';
    const value = { foo: 'bar' };
    await cacheService.set(key, value, 10);
    
    const retrieved = await cacheService.get(key);
    expect(retrieved).toEqual(value);
  });

  testIt('should return null for non-existent keys', async () => {
    const value = await cacheService.get('non_existent');
    expect(value).toBeNull();
  });

  testIt('should delete cache values', async () => {
    const key = 'delete_key';
    await cacheService.set(key, 'val', 10);
    await cacheService.delete(key);
    
    const value = await cacheService.get(key);
    expect(value).toBeNull();
  });

  testIt('should clear all cache', async () => {
    await cacheService.set('key1', 'val1', 10);
    await cacheService.set('key2', 'val2', 10);
    await cacheService.clear();
    
    expect(await cacheService.get('key1')).toBeNull();
    expect(await cacheService.get('key2')).toBeNull();
  });
});
