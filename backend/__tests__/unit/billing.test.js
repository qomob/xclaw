import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockPoolQuery = jest.fn();
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisDel = jest.fn().mockResolvedValue(1);

jest.unstable_mockModule('../../core/dependencies.js', () => ({
  getPostgres: jest.fn(() => ({
    connect: jest.fn(() => Promise.resolve({ query: mockClientQuery, release: mockRelease })),
    query: mockPoolQuery,
  })),
  getRedis: jest.fn(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
  })),
}));

const { chargeTask, chargeSkill, rewardNode, getTransactions, getNodeBalance, deductFromBalance } =
  await import('../../billing/index.js');

describe('Billing Module Tests', () => {
  beforeEach(() => {
    mockClientQuery.mockReset();
    mockRelease.mockReset();
    mockPoolQuery.mockReset();
    mockRedisGet.mockReset().mockResolvedValue(null);
    mockRedisSet.mockReset().mockResolvedValue('OK');
    mockRedisDel.mockReset().mockResolvedValue(1);
  });

  describe('chargeTask', () => {
    test('should charge task with default amount', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({});

      const result = await chargeTask('task-1');
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('completed');
      expect(result.data.amount).toBe(0.01);
      expect(result.data.duplicate).toBeUndefined();
      expect(mockRelease).toHaveBeenCalled();
    });

    test('should charge task with custom amount', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({});

      const result = await chargeTask('task-2', 5.5);
      expect(result.success).toBe(true);
      expect(result.data.amount).toBe(5.5);
    });

    test('should handle duplicate charge idempotently', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'tx-existing', status: 'completed' }] })
        .mockResolvedValueOnce({});

      const result = await chargeTask('task-dup');
      expect(result.success).toBe(true);
      expect(result.data.duplicate).toBe(true);
      expect(result.data.transaction_id).toBe('tx-existing');
    });

    test('should handle unique violation (23505) gracefully', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce({ code: '23505' });

      const result = await chargeTask('task-23505');
      expect(result.success).toBe(true);
      expect(result.data.duplicate).toBe(true);
    });

    test('should reject negative amount', async () => {
      const result = await chargeTask('task-neg', -1);
      expect(result.success).toBe(false);
      expect(result.error).toContain('正数');
    });

    test('should reject zero amount', async () => {
      const result = await chargeTask('task-zero', 0);
      expect(result.success).toBe(false);
    });

    test('should reject NaN amount', async () => {
      const result = await chargeTask('task-nan', NaN);
      expect(result.success).toBe(false);
    });

    test('should reject amount exceeding MAX_SINGLE_AMOUNT', async () => {
      const result = await chargeTask('task-huge', 2000000);
      expect(result.success).toBe(false);
      expect(result.error).toContain('不能超过');
    });

    test('should round amount to 2 decimal places', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({});

      const result = await chargeTask('task-round', 1.234);
      expect(result.success).toBe(true);
      expect(result.data.amount).toBe(1.23);
    });

    test('should handle generic database error', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('connection lost'));

      const result = await chargeTask('task-err');
      expect(result.success).toBe(false);
      expect(result.error).toBe('任务计费失败');
      expect(mockRelease).toHaveBeenCalled();
    });

    test('should release client even on error', async () => {
      mockClientQuery.mockRejectedValueOnce(new Error('fail'));
      await chargeTask('task-release');
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('chargeSkill', () => {
    test('should charge skill commission with default rate 0.2', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({});

      const result = await chargeSkill('skill-1', 1.0);
      expect(result.success).toBe(true);
      expect(result.data.amount).toBe(0.2);
      expect(result.data.status).toBe('completed');
    });

    test('should calculate commission correctly', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({});

      const result = await chargeSkill('skill-2', 2.5);
      expect(result.success).toBe(true);
      expect(result.data.amount).toBe(0.5);
    });

    test('should reject invalid amount', async () => {
      const result = await chargeSkill('skill-3', -1);
      expect(result.success).toBe(false);
    });

    test('should handle database error', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('db error'));

      const result = await chargeSkill('skill-err', 1.0);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Skill 抽成失败');
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('rewardNode', () => {
    test('should reward node and update reputation', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({});

      const result = await rewardNode('node-1', 0.5);
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('completed');
      expect(result.data.amount).toBe(0.5);
      expect(mockRedisDel).toHaveBeenCalledWith('node:node-1:balance');
    });

    test('should reject non-existent node', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockResolvedValueOnce({});

      const result = await rewardNode('node-missing', 0.5);
      expect(result.success).toBe(false);
      expect(result.error).toBe('节点不存在');
    });

    test('should reject invalid amount', async () => {
      const result = await rewardNode('node-1', -1);
      expect(result.success).toBe(false);
    });

    test('should handle database error', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('db error'));

      const result = await rewardNode('node-err', 0.5);
      expect(result.success).toBe(false);
      expect(result.error).toBe('节点奖励失败');
      expect(mockRelease).toHaveBeenCalled();
    });

    test('should invalidate balance cache on success', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({});

      await rewardNode('node-cache', 1.0);
      expect(mockRedisDel).toHaveBeenCalledWith('node:node-cache:balance');
    });
  });

  describe('getTransactions', () => {
    test('should return transactions with default limit', async () => {
      const mockRows = [{ id: 'tx-1' }, { id: 'tx-2' }];
      mockPoolQuery.mockResolvedValueOnce({ rows: mockRows });

      const result = await getTransactions();
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockRows);
      const calledSQL = mockPoolQuery.mock.calls[0][0];
      expect(calledSQL).toContain('LIMIT $1');
      expect(mockPoolQuery.mock.calls[0][1][0]).toBe(50);
    });

    test('should filter by task_id', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await getTransactions({ task_id: 'task-1' });
      const calledSQL = mockPoolQuery.mock.calls[0][0];
      expect(calledSQL).toContain('task_id = $1');
      expect(mockPoolQuery.mock.calls[0][1]).toContain('task-1');
    });

    test('should filter by node_id', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await getTransactions({ node_id: 'node-1' });
      const calledSQL = mockPoolQuery.mock.calls[0][0];
      expect(calledSQL).toContain('node_id =');
    });

    test('should apply multiple filters', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await getTransactions({ task_id: 't1', type: 'task', status: 'completed' });
      const calledSQL = mockPoolQuery.mock.calls[0][0];
      expect(calledSQL).toContain('task_id =');
      expect(calledSQL).toContain('type =');
      expect(calledSQL).toContain('status =');
      expect(calledSQL).toContain('AND');
    });

    test('should cap limit at 200', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await getTransactions({ limit: 500 });
      expect(mockPoolQuery.mock.calls[0][1][0]).toBe(200);
    });

    test('should use minimum limit of 1', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await getTransactions({ limit: -5 });
      expect(mockPoolQuery.mock.calls[0][1][0]).toBe(1);
    });

    test('should apply offset', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await getTransactions({ offset: 10 });
      const calledSQL = mockPoolQuery.mock.calls[0][0];
      expect(calledSQL).toContain('OFFSET');
    });

    test('should handle database error', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('db error'));

      const result = await getTransactions();
      expect(result.success).toBe(false);
      expect(result.error).toBe('获取交易记录失败');
    });
  });

  describe('getNodeBalance', () => {
    test('should return balance from cache', async () => {
      mockRedisGet.mockResolvedValueOnce('42.5');
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ total_earnings: '42.50' }] });

      const result = await getNodeBalance('node-1');
      expect(result.success).toBe(true);
      expect(result.data.balance).toBe(42.5);
    });

    test('should return error for non-existent node', async () => {
      mockRedisGet.mockResolvedValueOnce(null);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await getNodeBalance('node-missing');
      expect(result.success).toBe(false);
      expect(result.error).toBe('节点不存在');
    });

    test('should handle redis error gracefully', async () => {
      mockRedisGet.mockRejectedValueOnce(new Error('redis error'));

      const result = await getNodeBalance('node-err');
      expect(result.success).toBe(false);
      expect(result.error).toBe('获取节点余额失败');
    });
  });

  describe('deductFromBalance', () => {
    test('should deduct from balance successfully', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ total_earnings: '9.5' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({});

      const result = await deductFromBalance('node-1', 0.5);
      expect(result.success).toBe(true);
      expect(result.data.new_balance).toBe(9.5);
      expect(mockRedisDel).toHaveBeenCalledWith('node:node-1:balance');
    });

    test('should reject when balance insufficient', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({});

      const result = await deductFromBalance('node-1', 9999);
      expect(result.success).toBe(false);
      expect(result.error).toBe('余额不足');
    });

    test('should reject invalid amount', async () => {
      const result = await deductFromBalance('node-1', -1);
      expect(result.success).toBe(false);
    });

    test('should handle database error', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('db error'));

      const result = await deductFromBalance('node-err', 1.0);
      expect(result.success).toBe(false);
      expect(result.error).toBe('扣款失败');
      expect(mockRelease).toHaveBeenCalled();
    });
  });
});
