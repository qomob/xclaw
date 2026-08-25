import crypto from 'crypto';
// 测试真实生产实现（修复前此处复刻了本地实现，未走 core/utils.js 真实路径，
// 导致 SDK(base64 DER) 注册必失败的 bug 未被发现）
import { verifySignature, generateSignature, parsePublicKey } from '../../core/utils.js';

function sign(data, privateKey) {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return crypto.sign(null, buf, privateKey).toString('base64');
}

describe('Signature Verification (real core/utils.js)', () => {
  let keyPair;
  let publicKey;
  let privateKey;

  beforeAll(() => {
    keyPair = crypto.generateKeyPairSync('ed25519');
    publicKey = keyPair.publicKey;
    privateKey = keyPair.privateKey;
  });

  test('should verify a valid signature (KeyObject input)', () => {
    const data = JSON.stringify({ message: 'Hello, world!' });
    const signature = sign(data, privateKey);
    expect(verifySignature(data, signature, publicKey)).toBe(true);
  });

  test('should reject an invalid signature', () => {
    const data = JSON.stringify({ message: 'Hello, world!' });
    const signature = sign(data, privateKey);
    expect(verifySignature(JSON.stringify({ message: 'tampered' }), signature, publicKey)).toBe(false);
  });

  test('should reject a signature from another key', () => {
    const other = crypto.generateKeyPairSync('ed25519');
    const data = JSON.stringify({ message: 'Hello' });
    const signature = sign(data, privateKey);
    expect(verifySignature(data, signature, other.publicKey)).toBe(false);
  });

  test('should verify PEM-encoded public key (Python CLI format)', () => {
    const pemKey = publicKey.export({ type: 'spki', format: 'pem' });
    const data = JSON.stringify({ agent_name: 'py-agent', capabilities: 'nlp' });
    const signature = sign(data, privateKey);
    expect(verifySignature(data, signature, pemKey)).toBe(true);
  });

  test('should verify base64 DER SPKI public key (Node SDK format)', () => {
    const derB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const data = JSON.stringify({ agent_name: 'node-agent', capabilities: 'nlp' });
    const signature = sign(data, privateKey);
    expect(verifySignature(data, signature, derB64)).toBe(true);
  });

  test('should reject garbage public key without throwing', () => {
    expect(verifySignature('data', 'c2ln', 'not-a-key')).toBe(false);
    expect(verifySignature('data', 'c2ln', '')).toBe(false);
    expect(verifySignature('data', 'c2ln', null)).toBe(false);
  });

  test('generateSignature + verifySignature roundtrip (PEM & DER)', () => {
    const data = JSON.stringify({ roundtrip: true, n: 1 });
    // PEM private key
    const pemPriv = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const sigPem = generateSignature(data, pemPriv);
    expect(sigPem).toBeTruthy();
    expect(verifySignature(data, sigPem, publicKey)).toBe(true);
    // base64 DER PKCS8 private key (Node SDK format)
    const derPriv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    const sigDer = generateSignature(data, derPriv);
    expect(sigDer).toBeTruthy();
    expect(verifySignature(data, sigDer, publicKey)).toBe(true);
  });

  test('parsePublicKey returns null for invalid input', () => {
    expect(parsePublicKey(undefined)).toBeNull();
    expect(parsePublicKey('')).toBeNull();
    expect(parsePublicKey('bm90LWEta2V5')).toBeNull();
  });

  test('should handle edge cases', () => {
    const emptyData = '';
    const signature = sign(emptyData, privateKey);
    expect(verifySignature(emptyData, signature, publicKey)).toBe(true);

    const complexData = JSON.stringify({
      agent_id: '12345',
      timestamp: new Date().toISOString(),
      capabilities: ['weather', 'finance', 'health'],
      tags: ['ai', 'agent', 'service']
    });
    const complexSignature = sign(complexData, privateKey);
    expect(verifySignature(complexData, complexSignature, publicKey)).toBe(true);
  });
});
