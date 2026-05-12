import { generateUUID, verifySignature, generateSignature, calculateDistance, validateParams, generateAPIKey, formatResponse, errorHandler } from '../../core/utils.js';
import crypto from 'crypto';
import { jest } from '@jest/globals';

describe('Core Utils Tests', () => {
  describe('UUID Generation', () => {
    test('should generate consistent UUID for same name', () => {
      const name = 'test-node';
      const uuid1 = generateUUID(name);
      const uuid2 = generateUUID(name);
      expect(uuid1).toBe(uuid2);
      expect(uuid1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  describe('Signature Security', () => {
    let publicKey, privateKey;

    beforeAll(() => {
      const { publicKey: pub, privateKey: priv } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      });
      publicKey = pub;
      privateKey = priv;
    });

    test('should sign and verify data correctly', () => {
      const data = 'important-agent-data';
      const signature = generateSignature(data, privateKey);
      expect(signature).toBeDefined();
      
      const isValid = verifySignature(data, signature, publicKey);
      expect(isValid).toBe(true);
    });

    test('should fail verification if data is tampered', () => {
      const data = 'original-data';
      const signature = generateSignature(data, privateKey);
      const isValid = verifySignature('tampered-data', signature, publicKey);
      expect(isValid).toBe(false);
    });
  });

  describe('Geo Calculations', () => {
    test('should calculate distance between Shanghai and Beijing correctly', () => {
      // SH: 31.23, 121.47 | BJ: 39.90, 116.40
      const distance = calculateDistance(31.23, 121.47, 39.90, 116.40);
      expect(distance).toBeGreaterThan(1000);
      expect(distance).toBeLessThan(1200);
    });
  });

  describe('API Key and Strings', () => {
    test('should generate API keys with prefix', () => {
      const apiKey = generateAPIKey();
      expect(apiKey).toMatch(/^api_key_[0-9a-f]{32}$/);
    });
  });

  describe('Error Handling and Formatting', () => {
    test('should format successful response', () => {
      const res = formatResponse(true, { id: 1 });
      expect(res.success).toBe(true);
      expect(res.data.id).toBe(1);
    });

    test('should format error response', () => {
      const res = formatResponse(false, null, 'Error msg');
      expect(res.success).toBe(false);
      expect(res.error).toBe('Error msg');
    });

    test('should handle API errors in errorHandler', () => {
      const err = { statusCode: 400, message: 'Bad Request' };
      const req = { method: 'GET', url: '/test' };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Bad Request' }));
    });

    test('should validate parameters correctly', () => {
      const params = { a: 1, b: 2 };
      expect(validateParams(params, ['a', 'b']).valid).toBe(true);
      expect(validateParams(params, ['a', 'c']).valid).toBe(false);
    });
  });
});
