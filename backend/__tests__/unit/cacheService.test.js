import cacheService from '../../services/cacheService.js';
import { getRedis, initRedis } from '../../core/dependencies.js';

describe('CacheService Unit Tests', () => {
  beforeAll(async () => {
    await initRedis();
  });

  afterAll(async () => {
    await cacheService.clear();
  });

  test('should set and get cache values', async () => {
    const key = 'test_key';
    const value = { foo: 'bar' };
    await cacheService.set(key, value, 10);
    
    const retrieved = await cacheService.get(key);
    expect(retrieved).toEqual(value);
  });

  test('should return null for non-existent keys', async () => {
    const value = await cacheService.get('non_existent');
    expect(value).toBeNull();
  });

  test('should delete cache values', async () => {
    const key = 'delete_key';
    await cacheService.set(key, 'val', 10);
    await cacheService.delete(key);
    
    const value = await cacheService.get(key);
    expect(value).toBeNull();
  });

  test('should clear all cache', async () => {
    await cacheService.set('key1', 'val1', 10);
    await cacheService.set('key2', 'val2', 10);
    await cacheService.clear();
    
    expect(await cacheService.get('key1')).toBeNull();
    expect(await cacheService.get('key2')).toBeNull();
  });
});
