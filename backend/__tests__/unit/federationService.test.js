import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// ============================================
// Mock setup
// ============================================
const mockPoolQuery = jest.fn();
const mockRedisHset = jest.fn().mockResolvedValue(1);
const mockRedisHget = jest.fn().mockResolvedValue(null);
const mockRedisHgetall = jest.fn().mockResolvedValue({});
const mockRedisHdel = jest.fn().mockResolvedValue(1);
const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisSmembers = jest.fn().mockResolvedValue([]);

jest.unstable_mockModule('../../core/dependencies.js', () => ({
  getPostgres: jest.fn(() => ({
    query: mockPoolQuery,
  })),
  getRedis: jest.fn(() => ({
    hset: mockRedisHset,
    hget: mockRedisHget,
    hgetall: mockRedisHgetall,
    hdel: mockRedisHdel,
    set: mockRedisSet,
    smembers: mockRedisSmembers,
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

jest.unstable_mockModule('../../services/crossChainService.js', () => ({
  default: {},
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Import after mocks — federationService exports a singleton
const federationServiceModule = await import('../../services/federationService.js');
const federationService = federationServiceModule.default;

// ============================================
// Tests
// ============================================
describe('federationService', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockRedisHset.mockReset().mockResolvedValue(1);
    mockRedisHget.mockReset().mockResolvedValue(null);
    mockRedisHgetall.mockReset().mockResolvedValue({});
    mockRedisHdel.mockReset().mockResolvedValue(1);
    mockRedisSet.mockReset().mockResolvedValue('OK');
    mockRedisSmembers.mockReset().mockResolvedValue([]);
    mockFetch.mockReset();

    // Reset internal state
    federationService.redis = null;
    federationService.pgPool = null;
    federationService._initialized = false;
    federationService.localNetworkId = 'test-local';
    federationService.localEndpoint = 'http://localhost:3000';
    // Stop any timers from previous tests
    if (federationService._healthTimer) clearInterval(federationService._healthTimer);
    if (federationService._syncTimer) clearInterval(federationService._syncTimer);
    federationService._healthTimer = null;
    federationService._syncTimer = null;
  });

  afterEach(() => {
    if (federationService._healthTimer) clearInterval(federationService._healthTimer);
    if (federationService._syncTimer) clearInterval(federationService._syncTimer);
  });

  // ============================================
  // registerPeer
  // ============================================
  describe('registerPeer', () => {
    test('should reject registering self as peer', async () => {
      const result = await federationService.registerPeer('test-local', 'http://remote:3000');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Cannot register self/);
    });

    test('should register peer when reachable', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const result = await federationService.registerPeer(
        'remote-net-1',
        'http://remote:3000',
        { capabilities: ['nlp'], node_count: 5 }
      );

      expect(result.success).toBe(true);
      expect(result.data.network_id).toBe('remote-net-1');
      expect(result.data.endpoint).toBe('http://remote:3000');
      expect(result.data.status).toBe('active');
      expect(mockRedisHset).toHaveBeenCalled();
    });

    test('should skip verification when skip_verify is true', async () => {
      const result = await federationService.registerPeer(
        'remote-net-2',
        'http://unreachable:3000',
        { skip_verify: true }
      );

      expect(result.success).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('should reject when peer endpoint is not reachable', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false });

      const result = await federationService.registerPeer(
        'remote-net-3',
        'http://down:3000'
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not reachable/);
    });

    test('should reject when fetch throws', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await federationService.registerPeer(
        'remote-net-4',
        'http://broken:3000'
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not reachable/);
    });

    test('should store metadata correctly', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const result = await federationService.registerPeer(
        'remote-5',
        'http://r5:3000',
        { version: '2.0.0', capabilities: ['ml', 'nlp'], node_count: 10 }
      );

      expect(result.success).toBe(true);
      expect(result.data.version).toBe('2.0.0');
      expect(result.data.capabilities).toEqual(['ml', 'nlp']);
      expect(result.data.node_count).toBe(10);
    });
  });

  // ============================================
  // getFederationStatus
  // ============================================
  describe('getFederationStatus', () => {
    test('should return local and federation stats', async () => {
      const peerData = JSON.stringify({
        network_id: 'remote-1',
        endpoint: 'http://r1:3000',
        last_seen: Date.now(),
        node_count: 7,
      });

      mockRedisHgetall.mockResolvedValueOnce({
        'test-local': JSON.stringify({ network_id: 'test-local', last_seen: Date.now() }),
        'remote-1': peerData,
      });

      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ cnt: '5' }] })   // online nodes
        .mockResolvedValueOnce({ rows: [{ cnt: '10' }] })   // skills
        .mockResolvedValueOnce({ rows: [{ active: '3' }] }); // active tasks

      const result = await federationService.getFederationStatus();

      expect(result.success).toBe(true);
      expect(result.data.local.network_id).toBe('test-local');
      expect(result.data.local.online_nodes).toBe(5);
      expect(result.data.local.total_skills).toBe(10);
      expect(result.data.local.active_tasks).toBe(3);
      expect(result.data.federation.total_peers).toBe(1);
      expect(result.data.federation.alive_peers).toBe(1);
      expect(result.data.federation.total_remote_nodes).toBe(7);
      expect(result.data.federation.total_network_size).toBe(12); // 5 + 7
    });

    test('should count only alive peers', async () => {
      const staleTime = Date.now() - 300000; // old timestamp
      mockRedisHgetall.mockResolvedValueOnce({
        'remote-stale': JSON.stringify({
          network_id: 'remote-stale',
          last_seen: staleTime,
          node_count: 3,
        }),
      });

      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ cnt: '2' }] })
        .mockResolvedValueOnce({ rows: [{ cnt: '5' }] })
        .mockResolvedValueOnce({ rows: [{ active: '1' }] });

      const result = await federationService.getFederationStatus();

      expect(result.data.federation.alive_peers).toBe(0);
      expect(result.data.federation.total_remote_nodes).toBe(0);
    });

    test('should handle empty peer list', async () => {
      mockRedisHgetall.mockResolvedValueOnce({});
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
        .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
        .mockResolvedValueOnce({ rows: [{ active: '0' }] });

      const result = await federationService.getFederationStatus();

      expect(result.success).toBe(true);
      expect(result.data.federation.total_peers).toBe(0);
      expect(result.data.federation.alive_peers).toBe(0);
    });
  });

  // ============================================
  // routeTaskFederated
  // ============================================
  describe('routeTaskFederated', () => {
    test('should reject when max hops reached', async () => {
      const result = await federationService.routeTaskFederated({ type: 'test' }, 5);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Max hops reached/);
    });

    test('should return local matches when found', async () => {
      // _findLocalMatches: smembers returns online nodes
      mockRedisSmembers.mockResolvedValueOnce(['n1']);
      // _findLocalMatches: query nodes
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ node_id: 'n1', name: 'Node1', reputation_score: 0.8, capabilities: ['ml'] }],
      });

      const result = await federationService.routeTaskFederated({ type: 'ml-task' });

      expect(result.success).toBe(true);
      expect(result.data.target).toBe('local');
      expect(result.data.matches.length).toBeGreaterThan(0);
    });

    test('should query remote peers when no local matches', async () => {
      // No local matches
      mockRedisSmembers.mockResolvedValueOnce([]);

      // listPeers → hgetall returns alive peer
      mockRedisHgetall.mockResolvedValueOnce({
        'test-local': JSON.stringify({ network_id: 'test-local' }),
        'remote-1': JSON.stringify({
          network_id: 'remote-1',
          endpoint: 'http://remote:3000',
          last_seen: Date.now(),
          node_count: 5,
          is_alive: true,
        }),
      });

      // _queryRemoteMatches → fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            matches: [{ node_id: 'rn1', name: 'RemoteNode', match_score: 75 }],
          },
        }),
      });

      const result = await federationService.routeTaskFederated({ type: 'ml-task' });

      expect(result.success).toBe(true);
      expect(result.data.target).toBe('remote');
      expect(result.data.matches.length).toBeGreaterThan(0);
    });

    test('should fail when no peers available', async () => {
      mockRedisSmembers.mockResolvedValueOnce([]); // no local
      mockRedisHgetall.mockResolvedValueOnce({
        'test-local': JSON.stringify({ network_id: 'test-local' }),
      }); // no remote peers

      const result = await federationService.routeTaskFederated({ type: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No local matches and no federation peers/);
    });

    test('should fail when all remote queries fail', async () => {
      mockRedisSmembers.mockResolvedValueOnce([]); // no local
      mockRedisHgetall.mockResolvedValueOnce({
        'remote-1': JSON.stringify({
          network_id: 'remote-1',
          endpoint: 'http://remote:3000',
          last_seen: Date.now(),
          node_count: 5,
          is_alive: true,
        }),
      });
      mockFetch.mockRejectedValueOnce(new Error('timeout')); // remote query fails

      const result = await federationService.routeTaskFederated({ type: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No matches found across federation/);
    });

    test('should increment hops when querying remote', async () => {
      mockRedisSmembers.mockResolvedValueOnce([]); // no local
      mockRedisHgetall.mockResolvedValueOnce({
        'remote-1': JSON.stringify({
          network_id: 'remote-1',
          endpoint: 'http://remote:3000',
          last_seen: Date.now(),
          node_count: 5,
          is_alive: true,
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: { matches: [{ node_id: 'rn1', match_score: 80 }] },
        }),
      });

      await federationService.routeTaskFederated({ type: 'test' }, 2);

      // Verify fetch was called with hops+1 in body
      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.hops).toBe(3);
    });
  });

  // ============================================
  // getLocalTopologySummary
  // ============================================
  describe('getLocalTopologySummary', () => {
    test('should return topology summary with nodes, skills, stats', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{
            node_id: 'n1', name: 'Node1', capabilities: ['ml'],
            reputation_score: 0.9, status: 'online',
            latitude: 39.9, longitude: 116.4, total_earnings: 100,
          }],
        })
        .mockResolvedValueOnce({
          rows: [{ id: 's1', name: 'Python', category: 'dev', description: 'Python dev' }],
        })
        .mockResolvedValueOnce({
          rows: [{ total_tasks: 50, active_tasks: 10 }],
        });

      const result = await federationService.getLocalTopologySummary();

      expect(result.success).toBe(true);
      expect(result.data.network_id).toBe('test-local');
      expect(result.data.timestamp).toBeDefined();
      expect(result.data.nodes).toHaveLength(1);
      expect(result.data.nodes[0].id).toBe('n1');
      expect(result.data.nodes[0].location).toEqual({ lat: 39.9, lng: 116.4 });
      expect(result.data.skills).toHaveLength(1);
      expect(result.data.stats).toBeDefined();
    });

    test('should parse string capabilities to array', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{
            node_id: 'n1', name: 'Node1', capabilities: '["ml","nlp"]',
            reputation_score: 0.9, status: 'online',
            latitude: null, longitude: null, total_earnings: 0,
          }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{}] });

      const result = await federationService.getLocalTopologySummary();

      expect(result.data.nodes[0].capabilities).toEqual(['ml', 'nlp']);
    });
  });

  // ============================================
  // handleMatchQuery
  // ============================================
  describe('handleMatchQuery', () => {
    test('should return local matches for incoming query', async () => {
      mockRedisSmembers.mockResolvedValueOnce(['n1']);
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ node_id: 'n1', name: 'Node1', reputation_score: 0.8, capabilities: ['ml'] }],
      });

      const result = await federationService.handleMatchQuery(
        { type: 'ml-task' },
        'remote-network'
      );

      expect(result.success).toBe(true);
      expect(result.data.network_id).toBe('test-local');
      expect(result.data.matches.length).toBeGreaterThan(0);
    });

    test('should return empty matches when no local nodes', async () => {
      mockRedisSmembers.mockResolvedValueOnce([]);

      const result = await federationService.handleMatchQuery(
        { type: 'test' },
        'remote-network'
      );

      expect(result.success).toBe(true);
      expect(result.data.matches).toEqual([]);
    });
  });

  // ============================================
  // unregisterPeer
  // ============================================
  describe('unregisterPeer', () => {
    test('should remove peer from registry', async () => {
      const result = await federationService.unregisterPeer('remote-1');
      expect(result.success).toBe(true);
      expect(mockRedisHdel).toHaveBeenCalled();
    });
  });

  // ============================================
  // listPeers
  // ============================================
  describe('listPeers', () => {
    test('should list only remote peers (not self)', async () => {
      mockRedisHgetall.mockResolvedValueOnce({
        'test-local': JSON.stringify({ network_id: 'test-local', last_seen: Date.now() }),
        'remote-1': JSON.stringify({
          network_id: 'remote-1',
          endpoint: 'http://r1:3000',
          last_seen: Date.now(),
          node_count: 3,
        }),
      });

      const result = await federationService.listPeers();
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].network_id).toBe('remote-1');
      expect(result.data[0].is_alive).toBe(true);
    });

    test('should skip invalid entries', async () => {
      mockRedisHgetall.mockResolvedValueOnce({
        'test-local': JSON.stringify({ network_id: 'test-local' }),
        'bad-entry': 'not-json{{',
      });

      const result = await federationService.listPeers();
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(0);
    });
  });
});
