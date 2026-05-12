import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockPoolQuery = jest.fn();
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisSmembers = jest.fn().mockResolvedValue([]);
const mockRedisSismember = jest.fn().mockResolvedValue(1);
const mockRedisXlen = jest.fn().mockResolvedValue(0);
const mockRedisXRange = jest.fn().mockResolvedValue([]);
const mockRedisPublish = jest.fn().mockResolvedValue(1);

const mockGenerateUUID = jest.fn(() => 'test-uuid-123');
const mockCalculateDistance = jest.fn(() => 10);
const mockStartTaskWorkflow = jest.fn();
const mockChargeTask = jest.fn().mockResolvedValue({ success: true });
const mockRewardNode = jest.fn().mockResolvedValue({ success: true });
const mockTemporalClient = { available: false, startTaskWorkflow: mockStartTaskWorkflow };

jest.unstable_mockModule('../../core/dependencies.js', () => ({
  getPostgres: jest.fn(() => ({ query: mockPoolQuery })),
  getRedis: jest.fn(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    smembers: mockRedisSmembers,
    sismember: mockRedisSismember,
    xlen: mockRedisXlen,
    xRange: mockRedisXRange,
    publish: mockRedisPublish,
  })),
}));

jest.unstable_mockModule('../../core/utils.js', () => ({
  generateUUID: mockGenerateUUID,
  calculateDistance: mockCalculateDistance,
  formatResponse: (success, data, error) => ({
    success,
    ...(data && { data }),
    ...(error && { error }),
  }),
}));

jest.unstable_mockModule('../../workflows/temporalClient.js', () => ({
  default: mockTemporalClient,
}));

jest.unstable_mockModule('../../billing/index.js', () => ({
  chargeTask: mockChargeTask,
  rewardNode: mockRewardNode,
}));

jest.unstable_mockModule('../../services/loggerService.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const {
  routeTask, routeTaskWithRetry, logTaskAction,
  getTaskStatus, updateTaskStatus, getNodeTasks, completeTask,
} = await import('../../router/taskRouter.js');

describe('TaskRouter Module Tests', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockRedisGet.mockReset().mockResolvedValue(null);
    mockRedisSet.mockReset().mockResolvedValue('OK');
    mockRedisSmembers.mockReset().mockResolvedValue([]);
    mockRedisSismember.mockReset().mockResolvedValue(1);
    mockRedisXlen.mockReset().mockResolvedValue(0);
    mockRedisXRange.mockReset().mockResolvedValue([]);
    mockRedisPublish.mockReset().mockResolvedValue(1);
    mockGenerateUUID.mockReset().mockReturnValue('test-uuid-123');
    mockCalculateDistance.mockReset().mockReturnValue(10);
    mockStartTaskWorkflow.mockReset();
    mockChargeTask.mockReset().mockResolvedValue({ success: true });
    mockRewardNode.mockReset().mockResolvedValue({ success: true });
    mockTemporalClient.available = false;
  });

  describe('routeTask', () => {
    test('should route task successfully', async () => {
      mockRedisSmembers.mockResolvedValue(['node-1']);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ node_id: 'node-1', name: 'Node1', latitude: 40, longitude: -74 }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const result = await routeTask({ type: 'test', skill_id: 'skill-1', payload: {} });
      expect(result.success).toBe(true);
      expect(result.data.task_id).toBe('test-uuid-123');
      expect(result.data.status).toBe('pending');
      expect(result.data.nodes).toEqual(['node-1']);
    });

    test('should return error when no suitable nodes found', async () => {
      mockRedisSmembers.mockResolvedValue([]);

      const result = await routeTask({ type: 'test', payload: {} });
      expect(result.success).toBe(false);
      expect(result.error).toBe('没有找到合适的节点');
    });

    test('should start Temporal workflow when available', async () => {
      mockRedisSmembers.mockResolvedValue(['node-1']);
      mockTemporalClient.available = true;
      mockStartTaskWorkflow.mockResolvedValue({ workflowId: 'wf-123' });
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ node_id: 'node-1', name: 'Node1', latitude: 40, longitude: -74 }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const result = await routeTask({ type: 'test', skill_id: 'skill-1', payload: {} });
      expect(result.success).toBe(true);
      expect(result.data.workflow_id).toBe('wf-123');
      expect(mockRedisSet).toHaveBeenCalledWith('task:test-uuid-123:workflow', 'wf-123');
    });

    test('should handle Temporal start failure gracefully', async () => {
      mockRedisSmembers.mockResolvedValue(['node-1']);
      mockTemporalClient.available = true;
      mockStartTaskWorkflow.mockRejectedValue(new Error('Temporal down'));
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ node_id: 'node-1', name: 'Node1', latitude: 40, longitude: -74 }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const result = await routeTask({ type: 'test', skill_id: 'skill-1', payload: {} });
      expect(result.success).toBe(true);
      expect(result.data.workflow_id).toBeUndefined();
    });

    test('should handle database insert error', async () => {
      mockRedisSmembers.mockResolvedValue(['node-1']);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ node_id: 'node-1', name: 'Node1', latitude: 40, longitude: -74 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('DB error'));

      const result = await routeTask({ type: 'test', skill_id: 'skill-1', payload: {} });
      expect(result.success).toBe(false);
      expect(result.error).toBe('任务路由失败');
    });

    test('should filter nodes by skill', async () => {
      mockRedisSmembers.mockResolvedValue(['node-1', 'node-2']);
      mockRedisSismember
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ node_id: 'node-1', name: 'Node1', latitude: 40, longitude: -74 }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const result = await routeTask({ type: 'test', skill_id: 'skill-1', payload: {} });
      expect(result.success).toBe(true);
      expect(result.data.nodes).toEqual(['node-1']);
    });

    test('should score and sort nodes by distance and load', async () => {
      mockRedisSmembers.mockResolvedValue(['node-1', 'node-2']);
      mockCalculateDistance
        .mockReturnValueOnce(10)
        .mockReturnValueOnce(50);
      mockRedisXlen
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(8);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ node_id: 'node-1', name: 'Node1', latitude: 40, longitude: -74 }] })
        .mockResolvedValueOnce({ rows: [{ node_id: 'node-2', name: 'Node2', latitude: 35, longitude: -80 }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const result = await routeTask({ type: 'test', payload: {}, latitude: 39, longitude: -75 });
      expect(result.success).toBe(true);
      expect(result.data.nodes[0]).toBe('node-1');
    });

    test('should sort by load only when no coordinates provided', async () => {
      mockRedisSmembers.mockResolvedValue(['node-1', 'node-2']);
      mockRedisXlen
        .mockResolvedValueOnce(8)
        .mockResolvedValueOnce(2);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ node_id: 'node-1', name: 'Node1', latitude: 40, longitude: -74 }] })
        .mockResolvedValueOnce({ rows: [{ node_id: 'node-2', name: 'Node2', latitude: 35, longitude: -80 }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const result = await routeTask({ type: 'test', payload: {} });
      expect(result.success).toBe(true);
      expect(result.data.nodes[0]).toBe('node-2');
    });
  });

  describe('routeTaskWithRetry', () => {
    test('should return on first successful attempt', async () => {
      mockRedisSmembers.mockResolvedValue(['node-1']);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ node_id: 'node-1', name: 'Node1', latitude: 40, longitude: -74 }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const result = await routeTaskWithRetry({ type: 'test', payload: {} });
      expect(result.success).toBe(true);
    });

    test('should retry and return last failure', async () => {
      mockRedisSmembers.mockResolvedValue([]);

      const result = await routeTaskWithRetry({ type: 'test', payload: {} });
      expect(result.success).toBe(false);
      expect(result.error).toBe('没有找到合适的节点');
    }, 15000);
  });

  describe('logTaskAction', () => {
    test('should insert log successfully', async () => {
      mockPoolQuery.mockResolvedValueOnce({});

      await logTaskAction('task-1', 'node-1', 'TASK_CREATED', 'details', 'pending');
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO task_logs'),
        ['task-1', 'node-1', 'TASK_CREATED', 'details', 'pending']
      );
    });

    test('should handle database error gracefully', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('DB error'));
      await expect(logTaskAction('task-1', null, 'ACTION', 'details', 'status')).resolves.toBeUndefined();
    });
  });

  describe('getTaskStatus', () => {
    test('should return task when found', async () => {
      const mockTask = { id: 'task-1', status: 'pending' };
      mockPoolQuery.mockResolvedValueOnce({ rows: [mockTask] });

      const result = await getTaskStatus('task-1');
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockTask);
    });

    test('should return error when task not found', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const result = await getTaskStatus('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toBe('任务不存在');
    });

    test('should handle database error', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('DB error'));

      const result = await getTaskStatus('task-1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('获取任务状态失败');
    });
  });

  describe('updateTaskStatus', () => {
    test('should update status successfully', async () => {
      mockPoolQuery.mockResolvedValueOnce({});

      const result = await updateTaskStatus('task-1', 'running');
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('running');
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE tasks SET status'),
        ['running', 'task-1']
      );
    });

    test('should handle database error', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('DB error'));

      const result = await updateTaskStatus('task-1', 'running');
      expect(result.success).toBe(false);
      expect(result.error).toBe('更新任务状态失败');
    });
  });

  describe('getNodeTasks', () => {
    test('should return parsed tasks', async () => {
      mockRedisXRange.mockResolvedValueOnce([
        { id: '123-0', message: { task_id: 't-1', type: 'test', payload: '{"key":"val"}', skill_id: 's-1' } },
      ]);

      const result = await getNodeTasks('node-1');
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].task_id).toBe('t-1');
      expect(result.data[0].payload).toEqual({ key: 'val' });
    });

    test('should return empty list for no tasks', async () => {
      mockRedisXRange.mockResolvedValueOnce([]);

      const result = await getNodeTasks('node-1');
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    test('should handle error', async () => {
      mockRedisXRange.mockRejectedValueOnce(new Error('Redis error'));

      const result = await getNodeTasks('node-1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('获取节点任务失败');
    });
  });

  describe('completeTask', () => {
    test('should complete task successfully with billing', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 'task-1', status: 'running', node_id: 'node-1', reward_amount: 0.05 }] })
        .mockResolvedValueOnce({});

      const result = await completeTask('task-1', { output: 'done' });
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('completed');
      expect(mockRedisPublish).toHaveBeenCalledWith('task:task-1:result', expect.any(String));
      expect(mockChargeTask).toHaveBeenCalledWith('task-1', 0.05, expect.any(Object));
      expect(mockRewardNode).toHaveBeenCalledWith('node-1', 0.05, expect.any(Object));
    });

    test('should fail task when error provided', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 'task-1', status: 'running', node_id: 'node-1' }] })
        .mockResolvedValueOnce({});

      const result = await completeTask('task-1', null, 'Something went wrong');
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('failed');
      expect(mockChargeTask).not.toHaveBeenCalled();
      expect(mockRewardNode).not.toHaveBeenCalled();
    });

    test('should return error when task not found', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const result = await completeTask('nonexistent', {});
      expect(result.success).toBe(false);
      expect(result.error).toBe('任务不存在');
    });

    test('should skip billing when task has no node_id', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 'task-1', status: 'running', node_id: null }] })
        .mockResolvedValueOnce({});

      const result = await completeTask('task-1', { output: 'done' });
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('completed');
      expect(mockChargeTask).not.toHaveBeenCalled();
      expect(mockRewardNode).not.toHaveBeenCalled();
    });

    test('should handle billing failure gracefully', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 'task-1', status: 'running', node_id: 'node-1' }] })
        .mockResolvedValueOnce({});
      mockChargeTask.mockRejectedValueOnce(new Error('Billing down'));

      const result = await completeTask('task-1', { output: 'done' });
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('completed');
    });

    test('should use TASK_BASE_PRICE when reward_amount not set', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 'task-1', status: 'running', node_id: 'node-1' }] })
        .mockResolvedValueOnce({});

      const result = await completeTask('task-1', { output: 'done' });
      expect(result.success).toBe(true);
      expect(mockChargeTask).toHaveBeenCalledWith('task-1', 0.01, expect.any(Object));
      expect(mockRewardNode).toHaveBeenCalledWith('node-1', 0.01, expect.any(Object));
    });

    test('should handle general error', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('DB error'));

      const result = await completeTask('task-1', {});
      expect(result.success).toBe(false);
      expect(result.error).toBe('完成任务失败');
    });
  });
});
