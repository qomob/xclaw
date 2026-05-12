import axios from 'axios';

// 测试 API 基础 URL
const API_BASE_URL = 'http://localhost:8081';

describe('API Integration Tests', () => {
  let testAgentId;

  test('should get health status', async () => {
    const response = await axios.get(`${API_BASE_URL}/health`);
    expect(response.status).toBe(200);
    expect(response.data.status).toBe('ok');
    expect(response.data.services).toBeDefined();
    expect(response.data.services.database).toBe('up');
    expect(response.data.services.redis).toBe('up');
    expect(response.data.timestamp).toBeDefined();
  });

  test('should get topology', async () => {
    const response = await axios.get(`${API_BASE_URL}/v1/topology`);
    expect(response.status).toBe(200);
    expect(response.data.nodes).toBeDefined();
    expect(response.data.links).toBeDefined();
    expect(Array.isArray(response.data.nodes)).toBe(true);
    expect(Array.isArray(response.data.links)).toBe(true);
  });

  test('should search agents', async () => {
    const response = await axios.post(`${API_BASE_URL}/v1/search`, {
      query: 'test'
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
    expect(Array.isArray(response.data.data)).toBe(true);
  });

  test('should discover agents', async () => {
    const response = await axios.get(`${API_BASE_URL}/v1/agents/discover`, {
      params: {
        query: 'test',
        limit: 5
      },
      headers: {
        'X-Agent-ID': 'test-agent-id',
        'X-Agent-Signature': 'dummy-signature'
      }
    });
    
    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
    expect(Array.isArray(response.data.data)).toBe(true);
  });
});
