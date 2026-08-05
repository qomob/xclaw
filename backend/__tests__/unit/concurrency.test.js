import cacheService from '../../services/cacheService.js';
import { getRedis } from '../../core/dependencies.js';
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

describe('Concurrency Safety Tests', () => {
  let redis;

  beforeAll(async () => {
    if (!redisAvailable) return;
    redis = getRedis();
  });

  afterAll(async () => {
    if (!redisAvailable) return;
    await cacheService.clear();
  });

  testIt('should handle concurrent cache set/get correctly', async () => {
    const key = 'concurrency_test_key';
    const numConcurrentRequests = 50;
    
    // Simulate concurrent writes
    const writePromises = Array.from({ length: numConcurrentRequests }).map((_, i) => 
      cacheService.set(key, `value_${i}`, 60)
    );
    
    await Promise.all(writePromises);
    
    // The final value should be one of the value_i
    const finalValue = await cacheService.get(key);
    expect(finalValue).toMatch(/^value_\d+$/);
  });

  testIt('should handle concurrent cache clearing correctly', async () => {
    const key = 'concurrency_clear_key';
    await cacheService.set(key, 'value', 60);
    
    const clearPromises = Array.from({ length: 20 }).map(() => cacheService.clear());
    await Promise.all(clearPromises);
    
    const value = await cacheService.get(key);
    expect(value).toBeNull();
  });
});
