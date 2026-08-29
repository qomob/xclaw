import { generateUUID, verifySignature, generateSignature, calculateDistance, validateParams, generateAPIKey, formatResponse, errorHandler, isTimestampFresh, signaturePayload, SIGNATURE_TIMESTAMP_WINDOW_MS } from '../../core/utils.js';
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

  describe('Signature Replay Protection', () => {
    test('isTimestampFresh accepts a current timestamp', () => {
      expect(isTimestampFresh(Date.now())).toBe(true);
      expect(isTimestampFresh(String(Date.now()))).toBe(true);
      expect(isTimestampFresh(new Date().toISOString())).toBe(true);
    });

    test('isTimestampFresh rejects timestamps outside the window', () => {
      const window = SIGNATURE_TIMESTAMP_WINDOW_MS;
      expect(isTimestampFresh(Date.now() - window - 1000)).toBe(false);
      expect(isTimestampFresh(Date.now() + window + 1000)).toBe(false);
    });

    test('isTimestampFresh rejects garbage input', () => {
      expect(isTimestampFresh('not-a-date')).toBe(false);
      expect(isTimestampFresh(undefined)).toBe(false);
      expect(isTimestampFresh(null)).toBe(false);
      expect(isTimestampFresh(Number.NaN)).toBe(false);
    });

    test('isTimestampFresh honors a custom window', () => {
      const stale = Date.now() - 10 * 60 * 1000;
      expect(isTimestampFresh(stale, 60 * 60 * 1000)).toBe(true);
      expect(isTimestampFresh(stale, 60 * 1000)).toBe(false);
    });

    test('signaturePayload binds timestamp to the body', () => {
      const ts = 1700000000000;
      expect(signaturePayload(ts, { a: 1 })).toBe('1700000000000:{"a":1}');
      expect(signaturePayload(ts, '{"a":1}')).toBe('1700000000000:{"a":1}');
    });

    test('a signature over signaturePayload must not verify against the bare body (anti-downgrade)', () => {
      const ts = Date.now();
      const body = { action: 'transfer', amount: 1 };
      const pair = crypto.generateKeyPairSync('ed25519');
      const signed = generateSignature(signaturePayload(ts, body), pair.privateKey);
      // 攻击者剥离 timestamp 头重放：签名无法对裸 body 验证通过
      expect(verifySignature(JSON.stringify(body), signed, pair.publicKey)).toBe(false);
      // 正常路径：对 timestamp:body 验证通过
      expect(verifySignature(signaturePayload(ts, body), signed, pair.publicKey)).toBe(true);
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
