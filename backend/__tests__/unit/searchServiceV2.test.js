import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisZrange = jest.fn().mockResolvedValue([]);
const mockRedisZincrby = jest.fn().mockResolvedValue(1);

jest.unstable_mockModule('../../core/dependencies.js', () => ({
  getPostgres: jest.fn(() => ({
    connect: jest.fn(() => Promise.resolve({ query: mockClientQuery, release: mockRelease })),
    query: mockPoolQuery,
  })),
  getRedis: jest.fn(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    zrange: mockRedisZrange,
    zincrby: mockRedisZincrby,
  })),
}));

jest.unstable_mockModule('../../services/loggerService.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../core/utils.js', () => ({
  generateUUID: jest.fn((seed) => `uuid-${seed}`),
  formatResponse: jest.fn((success, data, error) => ({
    success, ...(data !== null && data !== undefined && { data }), ...(error && { error }),
  })),
}));

jest.unstable_mockModule('../../services/aiService.js', () => ({
  generateEmbedding: jest.fn().mockResolvedValue(new Array(1536).fill(0.1)),
}));

const searchServiceV2 = (await import('../../services/searchServiceV2.js')).default;

// Skip table creation in tests
searchServiceV2._tablesReady = true;
searchServiceV2._initialized = true;

describe('searchServiceV2', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================
  // hybridSearch
  // ==========================================
  test('hybridSearch — returns ranked results', async () => {
    // _semanticSearch → agents
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { id: 'a1', name: 'Chat Bot', status: 'online', reputation_score: 80, distance: 0.2, result_type: 'agent' },
    ]});
    // _semanticSearch → skills
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    // _keywordSearch → agents
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { id: 'a1', name: 'Chat Bot', status: 'online', reputation_score: 80, rank: 0.5, result_type: 'agent' },
    ]});
    // _keywordSearch → skills
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    // _getFacets
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    // recordSearch
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const result = await searchServiceV2.hybridSearch({ query: 'chat bot' });
    expect(result.success).toBe(true);
    expect(result.data.results.length).toBeGreaterThanOrEqual(1);
  });

  test('hybridSearch — empty query returns empty results', async () => {
    // recordSearch
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await searchServiceV2.hybridSearch({ query: '' });
    expect(result.success).toBe(true);
    expect(result.data.results).toEqual([]);
  });

  test('hybridSearch — with filters', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // semantic agents
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // semantic skills
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // keyword agents
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // keyword skills
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // facets
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // recordSearch

    const result = await searchServiceV2.hybridSearch({
      query: 'test', filters: { min_reputation: 50, status: 'online' },
    });
    expect(result.success).toBe(true);
  });

  // ==========================================
  // _rankResults (RRF)
  // ==========================================
  test('_rankResults — RRF fusion combines scores', () => {
    const semantic = [
      { id: 'a1', result_type: 'agent', reputation_score: 90 },
      { id: 'a2', result_type: 'agent', reputation_score: 50 },
    ];
    const keyword = [
      { id: 'a1', result_type: 'agent' },
      { id: 'a3', result_type: 'agent' },
    ];
    const ranked = searchServiceV2._rankResults(semantic, keyword, { semantic: 0.6, keyword: 0.3, reputation: 0.1 });
    expect(ranked[0].id).toBe('a1');
    expect(ranked.length).toBe(3);
  });

  test('_rankResults — empty inputs', () => {
    const ranked = searchServiceV2._rankResults([], [], { semantic: 0.6, keyword: 0.3, reputation: 0.1 });
    expect(ranked).toEqual([]);
  });

  // ==========================================
  // _applyFilters
  // ==========================================
  test('_applyFilters — min_reputation filter', () => {
    const results = [
      { id: 'a1', reputation_score: 80 },
      { id: 'a2', reputation_score: 30 },
    ];
    const filtered = searchServiceV2._applyFilters(results, { min_reputation: 50 });
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe('a1');
  });

  test('_applyFilters — status filter', () => {
    const results = [
      { id: 'a1', status: 'online' },
      { id: 'a2', status: 'offline' },
    ];
    const filtered = searchServiceV2._applyFilters(results, { status: 'online' });
    expect(filtered.length).toBe(1);
  });

  test('_applyFilters — no filters returns all', () => {
    const results = [{ id: 'a1' }, { id: 'a2' }];
    const filtered = searchServiceV2._applyFilters(results, {});
    expect(filtered.length).toBe(2);
  });

  // ==========================================
  // Suggestions
  // ==========================================
  test('getSuggestions — returns matching trending', async () => {
    mockRedisZrange.mockResolvedValueOnce(['chat bot', '10', 'chat gpt', '5']);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // DB fallback not used but pg mock needed
    const result = await searchServiceV2.getSuggestions('chat');
    expect(result.success).toBe(true);
    expect(result.data.length).toBe(2);
  });

  test('getSuggestions — DB fallback when trending insufficient', async () => {
    mockRedisZrange.mockResolvedValueOnce([]);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ text: 'chat helper', type: 'query', popularity: 3 }] });
    const result = await searchServiceV2.getSuggestions('chat');
    expect(result.success).toBe(true);
  });

  // ==========================================
  // Trending
  // ==========================================
  test('getTrendingSearches — returns sorted', async () => {
    mockRedisZrange.mockResolvedValueOnce(['AI agent', '15', 'chat bot', '8']);
    const result = await searchServiceV2.getTrendingSearches();
    expect(result.success).toBe(true);
    expect(result.data.length).toBe(2);
  });

  // ==========================================
  // Facets
  // ==========================================
  test('getSearchFacets — returns facets', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ category: 'nlp', count: '5' }] });
    const result = await searchServiceV2.getSearchFacets('chat');
    expect(result.success).toBe(true);
  });

  // ==========================================
  // Clustering
  // ==========================================
  test('clusterAgents — returns clusters', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    const fakeVectors = [];
    for (let i = 0; i < 10; i++) {
      const vec = new Array(10).fill(0);
      vec[i % 3] = 1;
      fakeVectors.push({ node_id: `n${i}`, name: `Node${i}`, capability_vector: vec });
    }
    mockPoolQuery.mockResolvedValueOnce({ rows: fakeVectors });
    const result = await searchServiceV2.clusterAgents(3);
    expect(result.success).toBe(true);
    expect(result.data.total_agents).toBe(10);
    expect(result.data.clusters.length).toBe(3);
  });

  test('clusterAgents — cache hit', async () => {
    mockRedisGet.mockResolvedValueOnce(JSON.stringify({ clusters: [{ id: 0 }], total_agents: 5 }));
    const result = await searchServiceV2.clusterAgents(3);
    expect(result.success).toBe(true);
    expect(result.data.total_agents).toBe(5);
  });

  test('clusterAgents — no data', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await searchServiceV2.clusterAgents(3);
    expect(result.success).toBe(true);
    expect(result.data.total_agents).toBe(0);
  });

  // ==========================================
  // Similar Agents
  // ==========================================
  test('getSimilarAgents — returns nearest', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { id: 'n2', name: 'Similar', distance: 0.1 },
      { id: 'n3', name: 'Less Similar', distance: 0.3 },
    ]});
    const result = await searchServiceV2.getSimilarAgents('n1', 5);
    expect(result.success).toBe(true);
    expect(result.data.length).toBe(2);
  });

  // ==========================================
  // Gap Analysis
  // ==========================================
  test('capabilityGapAnalysis — returns gaps', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { node_id: 'n1', capabilities: 'chat,nlp' },
      { node_id: 'n2', capabilities: 'chat,vision' },
    ]});
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { type: 'translation', demand_count: '10' },
      { type: 'chat', demand_count: '5' },
    ]});
    const result = await searchServiceV2.capabilityGapAnalysis();
    expect(result.success).toBe(true);
    expect(result.data.gaps.length).toBe(2);
  });

  // ==========================================
  // Stats
  // ==========================================
  test('getSearchStats — returns counts', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: '100' }] })
      .mockResolvedValueOnce({ rows: [{ count: '45' }] })
      .mockResolvedValueOnce({ rows: [{ avg: '3.5' }] });
    const result = await searchServiceV2.getSearchStats();
    expect(result.success).toBe(true);
    expect(result.data.total_searches).toBe(100);
    expect(result.data.unique_queries).toBe(45);
  });

  test('getSearchStats — handles error', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('DB down'));
    const result = await searchServiceV2.getSearchStats();
    expect(result.success).toBe(false);
  });
});
