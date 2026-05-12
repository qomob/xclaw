import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockRedisHset = jest.fn().mockResolvedValue(1);
const mockRedisHget = jest.fn().mockResolvedValue(null);
const mockRedisHgetall = jest.fn().mockResolvedValue({});
const mockRedisHdel = jest.fn().mockResolvedValue(1);
const mockRedisSmembers = jest.fn().mockResolvedValue([]);
const mockRedisSadd = jest.fn().mockResolvedValue(1);
const mockRedisSrem = jest.fn().mockResolvedValue(1);

jest.unstable_mockModule('../../core/dependencies.js', () => ({
  getPostgres: jest.fn(() => ({
    connect: jest.fn(() => Promise.resolve({ query: mockClientQuery, release: mockRelease })),
    query: mockPoolQuery,
  })),
  getRedis: jest.fn(() => ({
    hset: mockRedisHset,
    hget: mockRedisHget,
    hgetall: mockRedisHgetall,
    hdel: mockRedisHdel,
    smembers: mockRedisSmembers,
    sadd: mockRedisSadd,
    srem: mockRedisSrem,
  })),
}));

jest.unstable_mockModule('../../services/loggerService.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../services/eventBus.js', () => ({
  default: { emit: jest.fn(), on: jest.fn() },
}));

jest.unstable_mockModule('../../core/utils.js', () => ({
  generateUUID: jest.fn((seed) => `uuid-${seed}`),
  formatResponse: jest.fn((success, data, error) => ({
    success, ...(data !== null && data !== undefined && { data }), ...(error && { error }),
  })),
}));

const a2aService = (await import('../../services/a2aService.js')).default;

// Skip table creation in tests
a2aService._tablesReady = true;
a2aService._initialized = true;

describe('a2aService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================
  // Agent Card
  // ==========================================
  test('publishAgentCard — creates new card', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await a2aService.publishAgentCard('agent-001', {
      name: 'Test Agent', description: 'A test agent', capabilities: ['chat'], skills: ['greet'],
    });
    expect(result.success).toBe(true);
    expect(result.data.name).toBe('Test Agent');
    expect(mockRedisHset).toHaveBeenCalled();
    expect(mockRedisSadd).toHaveBeenCalled();
  });

  test('getAgentCard — Redis cache hit', async () => {
    mockRedisHgetall.mockResolvedValueOnce({
      name: 'Cached Agent', description: 'cached', capabilities: '["chat"]', skills: '[]', status: 'active',
    });
    const result = await a2aService.getAgentCard('agent-001');
    expect(result.success).toBe(true);
    expect(result.data.name).toBe('Cached Agent');
  });

  test('getAgentCard — DB fallback when Redis empty', async () => {
    mockRedisHgetall.mockResolvedValueOnce({});
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'agent-001', name: 'DB Agent' }] });
    const result = await a2aService.getAgentCard('agent-001');
    expect(result.success).toBe(true);
    expect(result.data.name).toBe('DB Agent');
  });

  test('getAgentCard — not found', async () => {
    mockRedisHgetall.mockResolvedValueOnce({});
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await a2aService.getAgentCard('agent-999');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Agent Card not found');
  });

  test('updateAgentCard — updates fields', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ agent_id: 'agent-001', name: 'Updated', description: 'new desc', url: null, capabilities: [], skills: [], status: 'active' }],
    });
    const result = await a2aService.updateAgentCard('agent-001', { name: 'Updated' });
    expect(result.success).toBe(true);
    expect(result.data.name).toBe('Updated');
  });

  test('discoverAgents — filters by query', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ name: 'Chat Agent' }] });
    const result = await a2aService.discoverAgents('chat');
    expect(result.success).toBe(true);
  });

  test('discoverAgents — filters by capability', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ name: 'Capable Agent', capabilities: ['nlp'] }] });
    const result = await a2aService.discoverAgents(null, { capability: 'nlp' });
    expect(result.success).toBe(true);
  });

  test('unpublishAgentCard — sets inactive', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await a2aService.unpublishAgentCard('agent-001');
    expect(result.success).toBe(true);
    expect(result.data.status).toBe('inactive');
    expect(mockRedisSrem).toHaveBeenCalled();
  });

  // ==========================================
  // Tasks
  // ==========================================
  test('sendTask — creates task log', async () => {
    mockRedisHgetall.mockResolvedValueOnce({ name: 'Target', capabilities: '[]', skills: '[]', status: 'active', description: '', url: '' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'task-001' }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const result = await a2aService.sendTask('agent-001', {
      to_agent_id: 'agent-002', task_type: 'test', input: { text: 'hello' },
    });
    expect(result.success).toBe(true);
    expect(result.data.status).toBe('delivered');
  });

  test('sendTask — target not found', async () => {
    mockRedisHgetall.mockResolvedValueOnce({});
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const result = await a2aService.sendTask('agent-001', { to_agent_id: 'agent-999' });
    expect(result.success).toBe(false);
  });

  test('receiveTask — logs incoming task', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'task-recv-001' }] });
    const result = await a2aService.receiveTask('agent-remote', {
      to_agent_id: 'agent-local', task_type: 'compute', input: { x: 1 },
    });
    expect(result.success).toBe(true);
    expect(result.data.status).toBe('received');
  });

  test('getTaskStatus — returns task', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'task-001', status: 'completed' }] });
    const result = await a2aService.getTaskStatus('task-001');
    expect(result.success).toBe(true);
  });

  test('updateTaskStatus — updates status', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'task-001', status: 'completed' }] });
    const result = await a2aService.updateTaskStatus('task-001', 'completed', { output: 'done' });
    expect(result.success).toBe(true);
  });

  // ==========================================
  // Messages
  // ==========================================
  test('sendMessage — creates message', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await a2aService.sendMessage('agent-001', 'agent-002', 'Hello!');
    expect(result.success).toBe(true);
    expect(result.data.content).toBe('Hello!');
  });

  test('getMessages — returns messages for agent', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ content: 'Hi' }, { content: 'Hey' }] });
    const result = await a2aService.getMessages('agent-001');
    expect(result.success).toBe(true);
    expect(result.data.length).toBe(2);
  });

  // ==========================================
  // Negotiation
  // ==========================================
  test('negotiateCapabilities — compares two agents', async () => {
    mockRedisHgetall
      .mockResolvedValueOnce({ name: 'Agent A', capabilities: '["nlp","chat"]', skills: '["greet"]', status: 'active', description: '', url: '' })
      .mockResolvedValueOnce({ name: 'Agent B', capabilities: '["nlp","vision"]', skills: '["detect"]', status: 'active', description: '', url: '' });
    const result = await a2aService.negotiateCapabilities('agent-a', 'agent-b');
    expect(result.success).toBe(true);
    expect(result.data.overlapping).toContain('nlp');
    expect(result.data.complementary).toContain('vision');
  });

  test('negotiateCapabilities — one agent missing', async () => {
    mockRedisHgetall
      .mockResolvedValueOnce({ name: 'A', capabilities: '[]', skills: '[]', status: 'active', description: '', url: '' })
      .mockResolvedValueOnce({});
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await a2aService.negotiateCapabilities('agent-a', 'agent-missing');
    expect(result.success).toBe(false);
  });

  // ==========================================
  // Stats
  // ==========================================
  test('getA2AStats — returns statistics', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })
      .mockResolvedValueOnce({ rows: [{ count: '10', completed: '8' }] })
      .mockResolvedValueOnce({ rows: [{ count: '20' }] });
    mockRedisSmembers.mockResolvedValueOnce(['a1', 'a2', 'a3']);
    const result = await a2aService.getA2AStats();
    expect(result.success).toBe(true);
    expect(result.data.published_agents).toBe(5);
    expect(result.data.total_tasks).toBe(10);
    expect(result.data.success_rate).toBe(80);
  });
});
