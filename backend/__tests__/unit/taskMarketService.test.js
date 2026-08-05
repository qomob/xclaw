import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// ============================================
// Mock setup
// ============================================
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockPoolQuery = jest.fn();
const mockRedisSmembers = jest.fn().mockResolvedValue([]);
const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisGet = jest.fn().mockResolvedValue(null);

jest.unstable_mockModule('../../core/dependencies.js', () => ({
  getPostgres: jest.fn(() => ({
    connect: jest.fn(() => Promise.resolve({ query: mockClientQuery, release: mockRelease })),
    query: mockPoolQuery,
  })),
  getRedis: jest.fn(() => ({
    smembers: mockRedisSmembers,
    set: mockRedisSet,
    get: mockRedisGet,
  })),
}));

jest.unstable_mockModule('../../services/loggerService.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/socialGraphService.js', () => ({
  computeTrustScore: jest.fn(() => Promise.resolve(0.8)),
}));

const mockEscrowFunds = jest.fn().mockResolvedValue({ success: true, amount: 50 });
const mockAdjustEscrow = jest.fn().mockResolvedValue({ success: true, amount: 10, delta: 0 });
const mockReleaseEscrow = jest.fn().mockResolvedValue({ success: true, amount: 10, worker_balance: 0 });
const mockRefundEscrow = jest.fn().mockResolvedValue({ success: true, amount: 10 });
const mockInvalidateCache = jest.fn();
const mockEmitEvent = jest.fn();

jest.unstable_mockModule('../../billing/index.js', () => ({
  escrowFundsInTx: mockEscrowFunds,
  adjustEscrowInTx: mockAdjustEscrow,
  releaseEscrowInTx: mockReleaseEscrow,
  refundEscrowInTx: mockRefundEscrow,
  invalidateBalanceCache: mockInvalidateCache,
}));

jest.unstable_mockModule('../../services/eventBus.js', () => ({
  default: { emit: mockEmitEvent, on: jest.fn() },
}));

jest.unstable_mockModule('../../services/websocketService.js', () => ({
  default: { sendToAgent: jest.fn() },
}));

jest.unstable_mockModule('../../services/reputationService.js', () => ({
  logReputationEvent: jest.fn().mockResolvedValue({}),
}));

jest.unstable_mockModule('uuid', () => ({
  v1: jest.fn(() => 'mock-uuid-v1'),
  v3: jest.fn(() => 'mock-uuid-v3'),
  v4: jest.fn(() => 'mock-uuid-v4'),
  v5: jest.fn(() => 'mock-uuid-v5'),
  NIL: '00000000-0000-0000-0000-000000000000',
  validate: jest.fn(() => true),
  stringify: jest.fn(() => 'mock-uuid-stringify'),
  parse: jest.fn(() => []),
  version: jest.fn(() => 4),
}));

// Import after mocks
const {
  computeMatchScore,
  findBestMatches,
  placeBid,
  getTaskBids,
  acceptBid,
  autoAssignTask,
  browseTasks,
  getMarketStats,
  createMarketTask,
  completeMarketTask,
  acceptTaskResult,
  rejectTaskResult,
  cancelMarketTaskByCaller,
} = await import('../../services/taskMarketService.js');

// ============================================
// Tests
// ============================================
describe('taskMarketService', () => {
  beforeEach(() => {
    mockClientQuery.mockReset();
    mockRelease.mockReset();
    mockPoolQuery.mockReset();
    mockRedisSmembers.mockReset().mockResolvedValue([]);
    mockRedisSet.mockReset().mockResolvedValue('OK');
    mockRedisGet.mockReset().mockResolvedValue(null);
    mockEscrowFunds.mockReset().mockResolvedValue({ success: true, amount: 50 });
    mockAdjustEscrow.mockReset().mockResolvedValue({ success: true, amount: 10, delta: 0 });
    mockReleaseEscrow.mockReset().mockResolvedValue({ success: true, amount: 10, worker_balance: 0 });
    mockRefundEscrow.mockReset().mockResolvedValue({ success: true, amount: 10 });
    mockInvalidateCache.mockReset();
    mockEmitEvent.mockReset();
  });

  // ============================================
  // computeMatchScore
  // ============================================
  describe('computeMatchScore', () => {
    test('should compute match score with full breakdown', async () => {
      const agent = {
        skills: ['python', 'nlp', 'ml'],
        reputation_score: 0.8,
        status: 'online',
        avg_response_time: 10000,
        task_stats: { completed: 20, total: 25, 'general': 5 },
      };
      const task = {
        required_skills: ['python', 'nlp'],
        min_reputation: 0.5,
        type: 'general',
      };

      const result = await computeMatchScore(agent, task);

      expect(result.score).toBeGreaterThan(0);
      expect(result.maxScore).toBe(100);
      expect(result.normalized).toBe(result.score / 100);
      expect(result.breakdown.skills).toBeDefined();
      expect(result.breakdown.reputation).toBeDefined();
      expect(result.breakdown.experience).toBeDefined();
      expect(result.breakdown.reliability).toBeDefined();
    });

    test('should give full skill score when all required skills match', async () => {
      const agent = {
        skills: ['python', 'nlp'],
        reputation_score: 0.5,
        status: 'offline',
        avg_response_time: 300000,
      };
      const task = {
        required_skills: ['python', 'nlp'],
        min_reputation: 0,
        type: 'general',
      };

      const result = await computeMatchScore(agent, task);
      expect(result.breakdown.skills.score).toBe(40);
    });

    test('should give partial skill score when some skills match', async () => {
      const agent = {
        skills: ['python'],
        reputation_score: 0.5,
        status: 'offline',
        avg_response_time: 300000,
      };
      const task = {
        required_skills: ['python', 'nlp', 'ml'],
        min_reputation: 0,
        type: 'general',
      };

      const result = await computeMatchScore(agent, task);
      expect(result.breakdown.skills.matched).toBe(1);
      expect(result.breakdown.skills.total).toBe(3);
    });

    test('should penalize reputation below minimum', async () => {
      const agent = {
        skills: [],
        reputation_score: 0.2,
        status: 'offline',
        avg_response_time: 300000,
      };
      const task = {
        required_skills: [],
        min_reputation: 0.5,
        type: 'general',
      };

      const result = await computeMatchScore(agent, task);
      expect(result.breakdown.reputation.score).toBe(0);
    });

    test('should reward online status with reliability points', async () => {
      const agent = {
        skills: [],
        reputation_score: 0.5,
        status: 'online',
        avg_response_time: 10000,
      };
      const task = {
        required_skills: [],
        min_reputation: 0,
        type: 'general',
      };

      const result = await computeMatchScore(agent, task);
      // online: +8, response < 60s: +7 → 15
      expect(result.breakdown.reliability.score).toBe(15);
    });

    test('should handle agent without task_stats', async () => {
      const agent = {
        skills: [],
        reputation_score: 0.5,
        status: 'offline',
        avg_response_time: 300000,
      };
      const task = {
        required_skills: [],
        min_reputation: 0,
        type: 'general',
      };

      const result = await computeMatchScore(agent, task);
      expect(result.breakdown.experience.score).toBe(10); // default
    });
  });

  // ============================================
  // findBestMatches
  // ============================================
  describe('findBestMatches', () => {
    test('should return empty array when no online nodes', async () => {
      mockRedisSmembers.mockResolvedValueOnce([]);

      const result = await findBestMatches({ id: 't1', min_reputation: 0 });
      expect(result).toEqual([]);
    });

    test('should return empty when no nodes meet reputation threshold', async () => {
      mockRedisSmembers.mockResolvedValueOnce(['node1']);
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const result = await findBestMatches({ id: 't1', min_reputation: 0.9, type: 'general' });
      expect(result).toEqual([]);
    });

    test('should return scored candidates sorted by match_score', async () => {
      mockRedisSmembers.mockResolvedValueOnce(['node1', 'node2']);

      // qualifiedNodes query
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          { node_id: 'n1', name: 'Node1', reputation_score: 0.8, status: 'online', latitude: null, longitude: null, skills: ['python'], total_earnings: 0 },
          { node_id: 'n2', name: 'Node2', reputation_score: 0.9, status: 'online', latitude: null, longitude: null, skills: ['python', 'nlp'], total_earnings: 0 },
        ],
      });

      // task stats for n1
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ completed: '10', total: '12', type_count: '3' }],
      });
      // task stats for n2
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ completed: '20', total: '20', type_count: '8' }],
      });

      const result = await findBestMatches({
        id: 't1',
        required_skills: ['python', 'nlp'],
        min_reputation: 0.5,
        type: 'general',
      }, 5);

      expect(result.length).toBeLessThanOrEqual(5);
      expect(result.length).toBe(2);
      // n2 has more matching skills and higher reputation → should be first
      expect(result[0].match_score).toBeGreaterThanOrEqual(result[1].match_score);
    });
  });

  // ============================================
  // createMarketTask
  // ============================================
  describe('createMarketTask', () => {
    test('should reject when caller_id is missing', async () => {
      const result = await createMarketTask({ title: 'Test' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/caller_id is required/);
    });

    test('should reject when caller not found in DB', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const result = await createMarketTask({ caller_id: 'unknown-node' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Caller not found/);
    });

    test('should create task with default strategy auto', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ node_id: 'caller1' }] }); // caller check
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'new-task-id' }] }) // INSERT tasks
        .mockResolvedValueOnce({}); // COMMIT

      const result = await createMarketTask({
        caller_id: 'caller1',
        title: 'My Task',
        budget_min: 10,
        budget_max: 50,
      });

      expect(result.success).toBe(true);
      expect(result.data.task_id).toBeDefined();
      expect(result.data.escrow_amount).toBe(50);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      expect(mockEscrowFunds).toHaveBeenCalledTimes(1);
      expect(mockEscrowFunds.mock.calls[0][3]).toBe(50);
    });

    test('should set bid_deadline when strategy is bid without deadline', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ node_id: 'caller1' }] });
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'new-task-id' }] })
        .mockResolvedValueOnce({});

      const result = await createMarketTask({
        caller_id: 'caller1',
        assignment_strategy: 'bid',
      });

      expect(result.success).toBe(true);
      expect(mockEscrowFunds).not.toHaveBeenCalled();
    });

    test('should create task with direct strategy as assigned status', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ node_id: 'caller1' }] });
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'new-task-id' }] })
        .mockResolvedValueOnce({});

      const result = await createMarketTask({
        caller_id: 'caller1',
        assignment_strategy: 'direct',
      });

      expect(result.success).toBe(true);
      const insertCall = mockClientQuery.mock.calls[1];
      // The status value should be 'assigned' for direct strategy
      expect(insertCall[1][5]).toBe('assigned');
    });

    test('should handle DB error gracefully', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ node_id: 'caller1' }] });
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('DB insert failed'));

      const result = await createMarketTask({ caller_id: 'caller1' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/DB insert failed/);
    });
  });

  // ============================================
  // 可信结算：验收 / 拒绝 / 取消退款
  // ============================================
  describe('trusted settlement', () => {
    test('should accept submitted task and release escrow to worker', async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 't1', status: 'submitted', caller_id: 'caller1', node_id: 'worker1', escrow_status: 'held' }] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}) // UPDATE tasks completed
        .mockResolvedValueOnce({}); // COMMIT

      const result = await acceptTaskResult('t1', 'caller1', { auto: false });

      expect(result.success).toBe(true);
      expect(result.data.status).toBe('completed');
      expect(mockReleaseEscrow).toHaveBeenCalledTimes(1);
      expect(mockReleaseEscrow.mock.calls[0][1]).toBe('t1');
      expect(mockReleaseEscrow.mock.calls[0][2]).toBe('worker1');
      expect(mockEmitEvent).toHaveBeenCalled();
    });

    test('should reject submitted task and open dispute', async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 't1', status: 'submitted', caller_id: 'caller1' }] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}) // UPDATE tasks disputed
        .mockResolvedValueOnce({ rows: [{ id: 'd1' }] }) // INSERT dispute
        .mockResolvedValueOnce({}); // COMMIT

      const result = await rejectTaskResult('t1', 'caller1', '结果质量不合格');

      expect(result.success).toBe(true);
      expect(result.data.status).toBe('disputed');
      expect(result.data.dispute_id).toBe('d1');
      expect(mockReleaseEscrow).not.toHaveBeenCalled();
    });

    test('should cancel pending task and refund escrow', async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 't1', status: 'open', caller_id: 'caller1', escrow_status: 'held' }] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({}) // UPDATE tasks cancelled
        .mockResolvedValueOnce({}) // UPDATE task_bids
        .mockResolvedValueOnce({}); // COMMIT

      const result = await cancelMarketTaskByCaller('t1', 'caller1');

      expect(result.success).toBe(true);
      expect(result.data.status).toBe('cancelled');
      expect(mockRefundEscrow).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================
  // browseTasks (listTasks)
  // ============================================
  describe('browseTasks', () => {
    test('should return tasks with default pagination', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 't1' }, { id: 't2' }] }) // main query
        .mockResolvedValueOnce({ rows: [{ total: '2' }] }); // count query

      const result = await browseTasks();

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.pagination).toBeDefined();
      expect(result.pagination.limit).toBe(20);
      expect(result.pagination.offset).toBe(0);
    });

    test('should apply status filter', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] });

      await browseTasks({ status: 'open' });

      const queryStr = mockPoolQuery.mock.calls[0][0];
      expect(queryStr).toContain('t.status = $1');
      // Params will also include limit/offset
      const params = mockPoolQuery.mock.calls[0][1];
      expect(params[0]).toBe('open');
    });

    test('should apply skill_id filter', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] });

      await browseTasks({ skill_id: 'skill-123' });

      const params = mockPoolQuery.mock.calls[0][1];
      expect(params).toContain('skill-123');
    });

    test('should apply budget filters', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] });

      await browseTasks({ min_budget: 10, max_budget: 100 });

      const params = mockPoolQuery.mock.calls[0][1];
      expect(params).toContain(10);
      expect(params).toContain(100);
    });

    test('should apply require_bids filter', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] });

      await browseTasks({ require_bids: true });

      const queryStr = mockPoolQuery.mock.calls[0][0];
      expect(queryStr).toContain("assignment_strategy = 'bid'");
    });

    test('should handle custom limit and offset', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '100' }] });

      const result = await browseTasks({ limit: '10', offset: '20' });

      expect(result.pagination.limit).toBe(10);
      expect(result.pagination.offset).toBe(20);
      expect(result.pagination.hasMore).toBe(true);
    });

    test('should handle errors gracefully', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('DB error'));

      const result = await browseTasks();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/DB error/);
    });
  });

  // ============================================
  // placeBid (bidOnTask)
  // ============================================
  describe('placeBid', () => {
    test('should reject when task not found', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const result = await placeBid('task-x', 'bidder1', { proposed_price: 10 });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Task not found/);
    });

    test('should reject when task is not open for bids', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 't1', status: 'completed', bid_deadline: null }],
      });

      const result = await placeBid('t1', 'bidder1', { proposed_price: 10 });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not open for bids/);
    });

    test('should reject when bid deadline has passed', async () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString();
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 't1', status: 'open', bid_deadline: pastDate }],
      });

      const result = await placeBid('t1', 'bidder1', { proposed_price: 10 });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/deadline has passed/);
    });

    test('should reject when bidder not found', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 't1', status: 'open', bid_deadline: null }] })
        .mockResolvedValueOnce({ rows: [] }); // bidder not found

      const result = await placeBid('t1', 'unknown-bidder', { proposed_price: 10 });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Bidder not found/);
    });

    test('should reject when bidder is not online', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 't1', status: 'open', bid_deadline: null }] })
        .mockResolvedValueOnce({ rows: [{ node_id: 'b1', status: 'offline' }] });

      const result = await placeBid('t1', 'b1', { proposed_price: 10 });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not online/);
    });

    test('should reject when bidder already has a pending bid', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 't1', status: 'open', bid_deadline: null }] })
        .mockResolvedValueOnce({ rows: [{ node_id: 'b1', status: 'online' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'existing-bid', status: 'pending' }] });

      const result = await placeBid('t1', 'b1', { proposed_price: 10 });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already placed a bid/);
    });

    test('should successfully place a bid with match_score', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 't1', status: 'open', bid_deadline: null, required_skills: [], min_reputation: 0, type: 'general' }] })
        .mockResolvedValueOnce({ rows: [{ node_id: 'b1', status: 'online', skills: [], reputation_score: 0.5 }] })
        .mockResolvedValueOnce({ rows: [] }) // no existing bid
        .mockResolvedValueOnce({ rows: [{ id: 'new-bid' }] }); // INSERT

      const result = await placeBid('t1', 'b1', {
        proposed_price: 25,
        estimated_duration: 60,
        proposal: 'I can do this',
      });

      expect(result.success).toBe(true);
      expect(result.data.match_score).toBeDefined();
      expect(result.data.bid_id).toBeDefined();
    });
  });

  // ============================================
  // acceptBid (assignTask - manual_bid strategy)
  // ============================================
  describe('acceptBid', () => {
    test('should reject when task not found or not authorized', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})           // BEGIN
        .mockResolvedValueOnce({ rows: [] })  // SELECT task
        .mockResolvedValueOnce({});           // ROLLBACK

      const result = await acceptBid('t1', 'bid1', 'caller1');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Task not found or not authorized/);
      expect(mockRelease).toHaveBeenCalled();
    });

    test('should reject when task not in bid phase', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})  // BEGIN
        .mockResolvedValueOnce({    // SELECT task (found, but wrong status)
          rows: [{ id: 't1', status: 'completed', caller_id: 'caller1' }],
        })
        .mockResolvedValueOnce({}); // ROLLBACK

      const result = await acceptBid('t1', 'bid1', 'caller1');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not in bid phase/);
    });

    test('should reject when bid not found or already processed', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})  // BEGIN
        .mockResolvedValueOnce({    // SELECT task (open)
          rows: [{ id: 't1', status: 'open', caller_id: 'caller1' }],
        })
        .mockResolvedValueOnce({ rows: [] }) // SELECT bid (not found)
        .mockResolvedValueOnce({});           // ROLLBACK

      const result = await acceptBid('t1', 'bid1', 'caller1');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Bid not found or already processed/);
    });

    test('should accept bid and update task + reject others', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})  // BEGIN
        .mockResolvedValueOnce({    // SELECT task
          rows: [{ id: 't1', status: 'open', caller_id: 'caller1' }],
        })
        .mockResolvedValueOnce({    // SELECT bid
          rows: [{ id: 'bid1', bidder_id: 'winner1', proposed_price: 50 }],
        })
        .mockResolvedValueOnce({})  // reject other bids
        .mockResolvedValueOnce({})  // update task
        .mockResolvedValueOnce({})  // mark bid accepted
        .mockResolvedValueOnce({}); // COMMIT

      const result = await acceptBid('t1', 'bid1', 'caller1');

      expect(result.success).toBe(true);
      expect(result.data.winner_id).toBe('winner1');
      expect(result.data.price).toBe(50);
      expect(mockRelease).toHaveBeenCalled();
    });

    test('should rollback on error', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})  // BEGIN
        .mockResolvedValueOnce({    // SELECT task
          rows: [{ id: 't1', status: 'open', caller_id: 'caller1' }],
        })
        .mockResolvedValueOnce({    // SELECT bid
          rows: [{ id: 'bid1', bidder_id: 'winner1', proposed_price: 50 }],
        })
        .mockResolvedValueOnce({})  // reject other bids
        .mockRejectedValueOnce(new Error('DB crash')); // update task fails

      const result = await acceptBid('t1', 'bid1', 'caller1');
      expect(result.success).toBe(false);
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  // ============================================
  // autoAssignTask (assignTask - auto strategy)
  // ============================================
  describe('autoAssignTask', () => {
    test('should reject when task not found', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const result = await autoAssignTask('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Task not found/);
    });

    test('should reject when task not available', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 't1', status: 'completed' }],
      });

      const result = await autoAssignTask('t1');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not available for assignment/);
    });

    test('should reject when no suitable agents found', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 't1', status: 'open', min_reputation: 0, type: 'general' }],
      });
      mockRedisSmembers.mockResolvedValueOnce([]); // no online nodes

      const result = await autoAssignTask('t1');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No suitable agents/);
    });
  });

  // ============================================
  // completeMarketTask
  // ============================================
  describe('completeMarketTask', () => {
    test('should reject when task not found or not authorized', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})           // BEGIN
        .mockResolvedValueOnce({ rows: [] })  // SELECT task
        .mockResolvedValueOnce({});           // ROLLBACK

      const result = await completeMarketTask('t1', 'node1', { output: 'done' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Task not found or not authorized/);
      expect(mockRelease).toHaveBeenCalled();
    });

    test('should reject when task is not in progress', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})  // BEGIN
        .mockResolvedValueOnce({    // SELECT task (wrong status)
          rows: [{ id: 't1', status: 'pending' }],
        })
        .mockResolvedValueOnce({}); // ROLLBACK

      const result = await completeMarketTask('t1', 'node1', {});
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not in progress/);
    });

    test('should complete task with result', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})  // BEGIN
        .mockResolvedValueOnce({    // SELECT task (assigned status)
          rows: [{ id: 't1', status: 'assigned' }],
        })
        .mockResolvedValueOnce({})  // UPDATE tasks
        .mockResolvedValueOnce({}); // COMMIT

      const result = await completeMarketTask('t1', 'node1', { output: 'success' });
      expect(result.success).toBe(true);
      expect(mockRelease).toHaveBeenCalled();
    });

    test('should complete task from running status', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})  // BEGIN
        .mockResolvedValueOnce({    // SELECT task (running status)
          rows: [{ id: 't1', status: 'running' }],
        })
        .mockResolvedValueOnce({})  // UPDATE
        .mockResolvedValueOnce({}); // COMMIT

      const result = await completeMarketTask('t1', 'node1', { output: 'done' });
      expect(result.success).toBe(true);
    });

    test('should rollback on error', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})  // BEGIN
        .mockResolvedValueOnce({    // SELECT task
          rows: [{ id: 't1', status: 'assigned' }],
        })
        .mockRejectedValueOnce(new Error('DB error')); // UPDATE fails

      const result = await completeMarketTask('t1', 'node1', {});
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/DB error/);
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  // ============================================
  // getTaskBids
  // ============================================
  describe('getTaskBids', () => {
    test('should return bids sorted by match_score', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          { id: 'b1', match_score: 80, proposed_price: 10 },
          { id: 'b2', match_score: 60, proposed_price: 20 },
        ],
      });

      const result = await getTaskBids('t1');
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
    });

    test('should handle errors', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('DB error'));

      const result = await getTaskBids('t1');
      expect(result.success).toBe(false);
    });
  });

  // ============================================
  // getMarketStats
  // ============================================
  describe('getMarketStats', () => {
    test('should return market statistics', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{
          total_tasks: 100, open_tasks: 5, assigned_tasks: 2, completed_tasks: 80,
          cancelled_tasks: 1, total_budget_min: '500', total_budget_max: '1000',
          avg_budget_min: '5', avg_budget_max: '10', unique_caller_count: 10, unique_worker_count: 8
        }] }) // task stats
        .mockResolvedValueOnce({ rows: [{ active_bids: 7 }] }) // active bids
        .mockResolvedValueOnce({ rows: [{ skill_id: 's1', skill_name: 'Python', task_count: 15 }] }) // hot skills
        .mockResolvedValueOnce({ rows: [{ avg_bids_per_task: '3.5' }] }) // avg bids
        .mockResolvedValueOnce({}); // task_market_stats upsert

      const result = await getMarketStats();

      expect(result.success).toBe(true);
      expect(result.data.total_tasks).toBe(100);
      expect(result.data.hot_skills).toHaveLength(1);
      expect(result.data.avg_bids_per_task).toBe(3.5);
    });

    test('should handle DB error', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('Stats query failed'));

      const result = await getMarketStats();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Stats query failed/);
    });
  });
});
