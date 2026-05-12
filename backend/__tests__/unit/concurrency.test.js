import cacheService from '../../services/cacheService.js';
import { getRedis } from '../../core/dependencies.js';

describe('Concurrency Safety Tests', () => {
  let redis;

  beforeAll(async () => {
    redis = getRedis();
  });

  afterAll(async () => {
    await cacheService.clear();
  });

  test('should handle concurrent cache set/get correctly', async () => {
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

  test('should handle concurrent cache clearing correctly', async () => {
    const key = 'concurrency_clear_key';
    await cacheService.set(key, 'value', 60);
    
    const clearPromises = Array.from({ length: 20 }).map(() => cacheService.clear());
    await Promise.all(clearPromises);
    
    const value = await cacheService.get(key);
    expect(value).toBeNull();
  });
});
