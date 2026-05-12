import { jest } from '@jest/globals';
import crypto from 'crypto';

const mockRedis = {
  set: jest.fn(() => Promise.resolve('OK')),
  get: jest.fn(() => Promise.resolve(null)),
  del: jest.fn(() => Promise.resolve(0)),
  exists: jest.fn(() => Promise.resolve(0)),
  expire: jest.fn(() => Promise.resolve(1)),
  sadd: jest.fn(() => Promise.resolve(1)),
  sismember: jest.fn(() => Promise.resolve(0)),
  setex: jest.fn(() => Promise.resolve('OK')),
};

jest.unstable_mockModule('../../core/dependencies.js', () => ({
  getPostgres: jest.fn(),
  getRedis: jest.fn(() => mockRedis),
}));

let authService;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-jwt-secret-for-testing';
  authService = (await import('../../services/authService.js')).default;
});

describe('AuthService Tests', () => {
  let publicKey, privateKey, agentId;

  beforeAll(() => {
    const { publicKey: pub, privateKey: priv } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    publicKey = pub;
    privateKey = priv;
    agentId = authService.generateAgentId(publicKey);
  });

  test('should register and retrieve agent public key', async () => {
    authService.registerAgent(agentId, publicKey);
    expect(await authService.getAgentPublicKey(agentId)).toBe(publicKey);
  });

  test('should verify valid signature', () => {
    const data = 'test-auth-data';
    const verify = crypto.createSign('SHA256');
    verify.update(data);
    const signature = verify.sign(privateKey, 'base64');
    
    expect(authService.verifySignature(data, signature, publicKey)).toBe(true);
  });

  test('should generate valid JWT token', () => {
    const token = authService.generateToken(agentId);
    expect(token).toBeDefined();
    
    const parts = token.split('.');
    expect(parts.length).toBe(3);
    
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');
    expect(header.typ).toBe('JWT');
  });

  test('should verify valid JWT token', async () => {
    const token = authService.generateToken(agentId);
    const payload = await authService.verifyToken(token);
    expect(payload).not.toBeNull();
    expect(payload.agentId).toBe(agentId);
    expect(payload.iat).toBeDefined();
    expect(payload.exp).toBeDefined();
    expect(payload.jti).toBeDefined();
  });

  test('should reject tampered JWT token', async () => {
    const token = authService.generateToken(agentId);
    const parts = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ agentId: 'attacker', iat: 0, exp: 9999999999 })).toString('base64url');
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    
    expect(await authService.verifyToken(tamperedToken)).toBeNull();
  });

  test('should reject JWT with invalid signature', async () => {
    const parts = authService.generateToken(agentId).split('.');
    const forgedToken = `${parts[0]}.${parts[1]}.${Buffer.from('forgesignature').toString('base64url')}`;
    
    expect(await authService.verifyToken(forgedToken)).toBeNull();
  });

  test('should reject malformed tokens', async () => {
    expect(await authService.verifyToken('not.a.jwt')).toBeNull();
    expect(await authService.verifyToken('invalid')).toBeNull();
    expect(await authService.verifyToken('')).toBeNull();
  });

  test('should revoke and reject JWT token', async () => {
    const token = authService.generateToken(agentId);
    expect(await authService.verifyToken(token)).not.toBeNull();
    
    await authService.revokeToken(token);
    mockRedis.get.mockResolvedValueOnce('1');
    expect(await authService.verifyToken(token)).toBeNull();
    mockRedis.get.mockResolvedValueOnce('1');
    expect(await authService.isTokenRevoked(token)).toBe(true);
  });

  test('should reject invalid signature', () => {
    const data = 'test-auth-data';
    const invalidSignature = 'invalid-sig-base64';
    expect(authService.verifySignature(data, invalidSignature, publicKey)).toBe(false);
  });

  test('should reject signature for different data', () => {
    const data = 'test-auth-data';
    const otherData = 'different-data';
    const verify = crypto.createSign('SHA256');
    verify.update(data);
    const signature = verify.sign(privateKey, 'base64');
    
    expect(authService.verifySignature(otherData, signature, publicKey)).toBe(false);
  });

  test('should reject signature with different public key', () => {
    const data = 'test-auth-data';
    const verify = crypto.createSign('SHA256');
    verify.update(data);
    const signature = verify.sign(privateKey, 'base64');
    
    const { publicKey: otherPubKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    
    expect(authService.verifySignature(data, signature, otherPubKey)).toBe(false);
  });

  test('should verify agent permission correctly', () => {
    authService.registerAgent(agentId, publicKey);
    expect(authService.checkPermission(agentId, '/v1/any-endpoint')).toBe(true);
    
    const unregisteredId = 'unregistered-agent-id';
    expect(authService.checkPermission(unregisteredId, '/v1/any-endpoint')).toBe(false);
  });

  test('should generate and verify API key', async () => {
    const apiKey = await authService.generateApiKey(agentId);
    expect(apiKey).toBeDefined();
    expect(apiKey.startsWith('ak_')).toBe(true);
    
    mockRedis.get.mockResolvedValueOnce(agentId);
    const resolvedAgentId = await authService.verifyApiKey(apiKey);
    expect(resolvedAgentId).toBe(agentId);
  });

  test('should reject unknown API key', async () => {
    expect(await authService.verifyApiKey('ak_unknown_key_12345')).toBeNull();
  });

  test('should delete API key', async () => {
    const apiKey = await authService.generateApiKey(agentId);
    mockRedis.get.mockResolvedValueOnce(agentId);
    expect(await authService.verifyApiKey(apiKey)).toBe(agentId);
    
    mockRedis.del.mockResolvedValueOnce(1);
    expect(await authService.deleteApiKey(apiKey)).toBe(true);
    mockRedis.get.mockResolvedValueOnce(null);
    expect(await authService.verifyApiKey(apiKey)).toBeNull();
  });
});
