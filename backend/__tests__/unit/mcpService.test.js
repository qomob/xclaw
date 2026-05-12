import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// ============================================
// Mock setup
// ============================================
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockPoolQuery = jest.fn();
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
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/eventBus.js', () => ({
  default: {
    emit: jest.fn(),
    on: jest.fn(),
  },
}));

jest.unstable_mockModule('../../core/utils.js', () => ({
  generateUUID: jest.fn((name) => `uuid-${name}`),
  formatResponse: jest.fn((success, data, error) => ({
    success,
    ...(data !== null && data !== undefined && { data }),
    ...(error && { error }),
  })),
}));

// Import after mocks
const {
  generateToolDefinition,
  registerMCPServer,
  getMCPServer,
  listMCPServers,
  unregisterMCPServer,
  discoverMCPServers,
  invokeMCPTool,
  listMCPServerTools,
  exportSkillsAsMCPTools,
  listAllMCPTools,
  getMCPStats,
  getMCPInvocationLogs,
  checkMCPServerHealth,
  __resetForTesting,
} = await import('../../services/mcpService.js');

// ============================================
// Tests
// ============================================
describe('mcpService', () => {
  beforeEach(() => {
    __resetForTesting();
    mockClientQuery.mockReset();
    mockRelease.mockReset();
    mockPoolQuery.mockReset();
    mockRedisHset.mockReset().mockResolvedValue(1);
    mockRedisHget.mockReset().mockResolvedValue(null);
    mockRedisHgetall.mockReset().mockResolvedValue({});
    mockRedisHdel.mockReset().mockResolvedValue(1);
    mockRedisSmembers.mockReset().mockResolvedValue([]);
    mockRedisSadd.mockReset().mockResolvedValue(1);
    mockRedisSrem.mockReset().mockResolvedValue(1);
  });

  // ============================================
  // generateToolDefinition
  // ============================================
  describe('generateToolDefinition', () => {
    test('should return error when skill not found', async () => {
      // ensureTables query
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // skill lookup query
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const result = await generateToolDefinition('nonexistent-skill-id');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Skill not found/);
    });

    test('should generate tool definition from skill', async () => {
      const skill = {
        id: 'skill-1',
        name: 'text-generator',
        description: 'Generates text',
        category: 'nlp',
        version: '2.0.0',
        input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
        output_schema: { type: 'object', properties: { text: { type: 'string' } } },
        node_id: 'node-1',
      };

      // ensureTables query
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // skill lookup
      mockPoolQuery.mockResolvedValueOnce({ rows: [skill] });

      const result = await generateToolDefinition('skill-1');
      expect(result.success).toBe(true);
      expect(result.data.name).toBe('text-generator');
      expect(result.data.description).toBe('Generates text');
      expect(result.data.inputSchema).toEqual(skill.input_schema);
      expect(result.data.outputSchema).toEqual(skill.output_schema);
      expect(result.data.annotations.category).toBe('nlp');
      expect(result.data.annotations.version).toBe('2.0.0');
      expect(result.data.annotations.source_skill_id).toBe('skill-1');
    });

    test('should handle skill with null schemas', async () => {
      const skill = {
        id: 'skill-2',
        name: 'simple-tool',
        description: 'A simple tool',
        category: null,
        version: null,
        input_schema: null,
        output_schema: null,
        node_id: 'node-1',
      };

      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockPoolQuery.mockResolvedValueOnce({ rows: [skill] });

      const result = await generateToolDefinition('skill-2');
      expect(result.success).toBe(true);
      expect(result.data.inputSchema).toEqual({ type: 'object', properties: {}, required: [] });
      expect(result.data.outputSchema).toBeUndefined();
    });

    test('should handle DB error gracefully', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('DB connection failed'));

      const result = await generateToolDefinition('skill-x');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/DB connection failed/);
    });
  });

  // ============================================
  // registerMCPServer
  // ============================================
  describe('registerMCPServer', () => {
    test('should reject when name is missing', async () => {
      const result = await registerMCPServer({ endpoint: 'http://example.com' }, 'user-1');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/name and endpoint are required/);
    });

    test('should reject when endpoint is missing', async () => {
      const result = await registerMCPServer({ name: 'Test Server' }, 'user-1');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/name and endpoint are required/);
    });

    test('should register server successfully', async () => {
      const serverRow = {
        id: 'server-uuid-1',
        name: 'Test MCP Server',
        endpoint: 'http://mcp.example.com/api',
        description: 'A test server',
        capabilities: { tools: true },
        auth_type: 'bearer',
        auth_config: { token: 'secret' },
        status: 'active',
        registered_by: 'user-1',
      };

      // ensureTables
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // INSERT RETURNING
      mockPoolQuery.mockResolvedValueOnce({ rows: [serverRow] });

      const result = await registerMCPServer(
        {
          name: 'Test MCP Server',
          endpoint: 'http://mcp.example.com/api',
          description: 'A test server',
          capabilities: { tools: true },
          auth_type: 'bearer',
          auth_config: { token: 'secret' },
        },
        'user-1'
      );

      expect(result.success).toBe(true);
      expect(result.data.name).toBe('Test MCP Server');
      expect(result.data.endpoint).toBe('http://mcp.example.com/api');
      expect(mockRedisHset).toHaveBeenCalled();
      expect(mockRedisSadd).toHaveBeenCalledWith('mcp:servers:active', 'server-uuid-1');
    });

    test('should register with default values', async () => {
      const serverRow = {
        id: 'server-uuid-2',
        name: 'Minimal',
        endpoint: 'http://min.com',
        status: 'active',
      };

      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockPoolQuery.mockResolvedValueOnce({ rows: [serverRow] });

      const result = await registerMCPServer({ name: 'Minimal', endpoint: 'http://min.com' });
      expect(result.success).toBe(true);
    });

    test('should handle DB error gracefully', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('DB insert failed'));

      const result = await registerMCPServer({ name: 'X', endpoint: 'http://x.com' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/DB insert failed/);
    });
  });

  // ============================================
  // getMCPServer
  // ============================================
  describe('getMCPServer', () => {
    test('should return server from Redis cache', async () => {
      // ensureTables
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockRedisHgetall.mockResolvedValueOnce({
        id: 'server-1',
        name: 'Cached Server',
        endpoint: 'http://cached.com',
        status: 'active',
        capabilities: '{"tools":true}',
      });

      const result = await getMCPServer('server-1');
      expect(result.success).toBe(true);
      expect(result.data.name).toBe('Cached Server');
      expect(result.data.capabilities).toEqual({ tools: true });
    });

    test('should fallback to DB when not in cache', async () => {
      // ensureTables
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // Redis returns empty
      mockRedisHgetall.mockResolvedValueOnce({});
      // DB lookup
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'server-2', name: 'DB Server', endpoint: 'http://db.com', status: 'active', capabilities: {} }],
      });

      const result = await getMCPServer('server-2');
      expect(result.success).toBe(true);
      expect(result.data.name).toBe('DB Server');
    });

    test('should return error when server not found', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockRedisHgetall.mockResolvedValueOnce({});
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const result = await getMCPServer('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/MCP Server not found/);
    });
  });

  // ============================================
  // listMCPServers
  // ============================================
  describe('listMCPServers', () => {
    test('should list servers with default pagination', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // ensureTables
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          { id: 's1', name: 'Server 1', status: 'active' },
          { id: 's2', name: 'Server 2', status: 'active' },
        ],
      });

      const result = await listMCPServers();
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
    });

    test('should apply status filter', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await listMCPServers({ status: 'active' });

      const queryStr = mockPoolQuery.mock.calls[1][0];
      expect(queryStr).toContain('status = $1');
      const params = mockPoolQuery.mock.calls[1][1];
      expect(params[0]).toBe('active');
    });

    test('should apply search filter', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await listMCPServers({ search: 'test' });

      const queryStr = mockPoolQuery.mock.calls[1][0];
      expect(queryStr).toContain('ILIKE');
    });

    test('should handle errors gracefully', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('DB error'));

      const result = await listMCPServers();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/DB error/);
    });
  });

  // ============================================
  // unregisterMCPServer
  // ============================================
  describe('unregisterMCPServer', () => {
    test('should unregister server successfully', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // ensureTables
      mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 }); // DELETE

      const result = await unregisterMCPServer('server-1');
      expect(result.success).toBe(true);
      expect(result.data.deleted).toBe(true);
      expect(mockRedisHdel).toHaveBeenCalled();
      expect(mockRedisSrem).toHaveBeenCalledWith('mcp:servers:active', 'server-1');
    });

    test('should return error when server not found', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockPoolQuery.mockResolvedValueOnce({ rowCount: 0 });

      const result = await unregisterMCPServer('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/MCP Server not found/);
    });
  });

  // ============================================
  // discoverMCPServers
  // ============================================
  describe('discoverMCPServers', () => {
    test('should return all active servers when no capabilities specified', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 's1', name: 'Server 1', status: 'active' }],
      });

      const result = await discoverMCPServers([]);
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
    });

    test('should return all active servers when capabilities is null', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 's1', name: 'Server 1', status: 'active' }],
      });

      const result = await discoverMCPServers(null);
      expect(result.success).toBe(true);
    });

    test('should search by capabilities', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 's1', name: 'Capable Server' }] });

      const result = await discoverMCPServers(['nlp'], 5);
      expect(result.success).toBe(true);
      expect(mockPoolQuery.mock.calls[1][0]).toContain('@>');
    });
  });

  // ============================================
  // invokeMCPTool
  // ============================================
  describe('invokeMCPTool', () => {
    test('should return error when server not found', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // ensureTables
      // getMCPServer: Redis empty
      mockRedisHgetall.mockResolvedValueOnce({});
      // getMCPServer: DB empty
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const result = await invokeMCPTool('nonexistent', 'tool1', {}, 'caller1');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/MCP Server not found/);
    });

    test('should return error when server is not active', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // ensureTables
      mockRedisHgetall.mockResolvedValueOnce({ id: 's1', name: 'S1', endpoint: 'http://s1.com', status: 'inactive' });

      const result = await invokeMCPTool('s1', 'tool1', {}, 'caller1');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not active/);
    });
  });

  // ============================================
  // exportSkillsAsMCPTools
  // ============================================
  describe('exportSkillsAsMCPTools', () => {
    test('should export skills as MCP tools', async () => {
      const skills = [
        { id: 'sk1', name: 'tool-a', description: 'Tool A', category: 'nlp', version: '1.0', input_schema: null, output_schema: null, node_id: 'node-1' },
        { id: 'sk2', name: 'tool-b', description: 'Tool B', category: 'cv', version: '1.0', input_schema: null, output_schema: null, node_id: 'node-1' },
      ];

      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // ensureTables
      mockPoolQuery.mockResolvedValueOnce({ rows: skills }); // skills lookup
      // generateToolDefinition for sk1 (ensureTables already initialized, so only skill lookup)
      mockPoolQuery.mockResolvedValueOnce({ rows: [skills[0]] });
      // generateToolDefinition for sk2
      mockPoolQuery.mockResolvedValueOnce({ rows: [skills[1]] });

      const result = await exportSkillsAsMCPTools('node-1');
      expect(result.success).toBe(true);
      expect(result.data.node_id).toBe('node-1');
      expect(result.data.tool_count).toBe(2);
      expect(result.data.tools).toHaveLength(2);
      expect(result.data.tools[0].name).toBe('tool-a');
      expect(result.data.tools[1].name).toBe('tool-b');
    });

    test('should return empty tools when node has no skills', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // ensureTables
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // no skills

      const result = await exportSkillsAsMCPTools('node-empty');
      expect(result.success).toBe(true);
      expect(result.data.tool_count).toBe(0);
      expect(result.data.tools).toHaveLength(0);
    });
  });

  // ============================================
  // getMCPStats
  // ============================================
  describe('getMCPStats', () => {
    test('should return MCP statistics', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // ensureTables
      // server stats query
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ total_servers: '5', active_servers: '3' }],
      });
      // invocation stats query
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ total_invocations: '100', successful_invocations: '80' }],
      });
      // smembers for active servers (for tool counting)
      mockRedisSmembers.mockResolvedValueOnce([]);

      const result = await getMCPStats();
      expect(result.success).toBe(true);
      expect(result.data.total_servers).toBe(5);
      expect(result.data.active_servers).toBe(3);
      expect(result.data.total_invocations).toBe(100);
      expect(result.data.success_rate).toBe(80.0);
      expect(result.data.total_tools).toBe(0);
    });

    test('should handle zero invocations gracefully', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ total_servers: '0', active_servers: '0' }],
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ total_invocations: '0', successful_invocations: '0' }],
      });
      mockRedisSmembers.mockResolvedValueOnce([]);

      const result = await getMCPStats();
      expect(result.success).toBe(true);
      expect(result.data.success_rate).toBe(0);
    });
  });

  // ============================================
  // getMCPInvocationLogs
  // ============================================
  describe('getMCPInvocationLogs', () => {
    test('should return invocation logs with default filters', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // ensureTables
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          { id: 'log-1', server_id: 's1', tool_name: 'tool1', status: 'success' },
          { id: 'log-2', server_id: 's1', tool_name: 'tool2', status: 'error' },
        ],
      });

      const result = await getMCPInvocationLogs();
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
    });

    test('should apply server_id filter', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await getMCPInvocationLogs({ server_id: 's1' });

      const queryStr = mockPoolQuery.mock.calls[1][0];
      expect(queryStr).toContain('server_id = $1');
    });

    test('should apply status and caller_id filters', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await getMCPInvocationLogs({ status: 'success', caller_id: 'user-1' });

      const queryStr = mockPoolQuery.mock.calls[1][0];
      expect(queryStr).toContain('status = $');
      expect(queryStr).toContain('caller_id = $');
    });
  });

  // ============================================
  // checkMCPServerHealth
  // ============================================
  describe('checkMCPServerHealth', () => {
    test('should return error when server not found', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // ensureTables
      mockRedisHgetall.mockResolvedValueOnce({});
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const result = await checkMCPServerHealth('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/MCP Server not found/);
    });
  });
});
