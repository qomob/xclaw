import axios from 'axios';
import crypto from 'crypto';

// 测试 API 基础 URL
const API_BASE_URL = 'http://localhost:8081';

describe('XClaw API Integration Tests', () => {
  let testKeyPair;
  let testAgentId;

  beforeAll(() => {
    // 生成测试密钥对
    testKeyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
  });

  test('Health Check', async () => {
    const response = await axios.get(`${API_BASE_URL}/health`);
    expect(response.status).toBe(200);
    expect(response.data.status).toBe('ok');
    expect(response.data.services).toBeDefined();
  });

  test('Agent Registration Workflow', async () => {
    const agentData = {
      agent_name: 'IntegrationTestAgent',
      capabilities: 'Test semantic capabilities for integration',
      tags: ['test', 'integration'],
      public_key: testKeyPair.publicKey,
      latitude: 31.23,
      longitude: 121.47
    };

    // 生成签名
    const sign = crypto.createSign('SHA256');
    sign.update(JSON.stringify(agentData));
    const signature = sign.sign(testKeyPair.privateKey, 'base64');

    const response = await axios.post(`${API_BASE_URL}/v1/agents/register`, agentData, {
      headers: {
        'Content-Type': 'application/json',
        'x-agent-signature': signature
      }
    });

    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
    testAgentId = response.data.data.agent_id;
    expect(testAgentId).toBeDefined();
  });

  test('Discovery API with Semantic Search', async () => {
    if (!testAgentId) return;

    const response = await axios.get(`${API_BASE_URL}/v1/agents/discover`, {
      params: { query: 'integration test', limit: 5 },
      headers: { 'x-agent-id': testAgentId }
    });

    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
    expect(Array.isArray(response.data.data)).toBe(true);
  });

  test('Topology Data Retrieval', async () => {
    const response = await axios.get(`${API_BASE_URL}/v1/topology`);
    expect(response.status).toBe(200);
    expect(response.data.nodes).toBeDefined();
    expect(response.data.links).toBeDefined();
  });
});
