import crypto from 'crypto';

// 模拟签名验证函数
function verifySignature(data, signature, publicKey) {
  try {
    const buffer = Buffer.from(signature, 'base64');
    return crypto.verify(null, Buffer.from(data), publicKey, buffer);
  } catch (error) {
    console.error('Signature verification failed', { error: error.message });
    return false;
  }
}

// 生成密钥对的辅助函数
function generateKeyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

// 签名数据的辅助函数
function signData(data, privateKey) {
  const buffer = crypto.sign(null, Buffer.from(data), privateKey);
  return buffer.toString('base64');
}

describe('Signature Verification', () => {
  let keyPair;
  let publicKey;
  let privateKey;

  beforeAll(() => {
    keyPair = generateKeyPair();
    publicKey = keyPair.publicKey;
    privateKey = keyPair.privateKey;
  });

  test('should verify a valid signature', () => {
    const data = JSON.stringify({ message: 'Hello, world!' });
    const signature = signData(data, privateKey);
    
    const result = verifySignature(data, signature, publicKey);
    expect(result).toBe(true);
  });

  test('should reject an invalid signature', () => {
    const data = JSON.stringify({ message: 'Hello, world!' });
    const signature = signData(data, privateKey);
    
    // Tamper with the data
    const tamperedData = JSON.stringify({ message: 'Hello, tampered world!' });
    const result = verifySignature(tamperedData, signature, publicKey);
    expect(result).toBe(false);
  });

  test('should reject an invalid public key', () => {
    const data = JSON.stringify({ message: 'Hello, world!' });
    const signature = signData(data, privateKey);
    
    // Generate a different key pair
    const anotherKeyPair = generateKeyPair();
    const anotherPublicKey = anotherKeyPair.publicKey;
    
    const result = verifySignature(data, signature, anotherPublicKey);
    expect(result).toBe(false);
  });

  test('should handle edge cases', () => {
    // Empty data
    const emptyData = '';
    const signature = signData(emptyData, privateKey);
    const result = verifySignature(emptyData, signature, publicKey);
    expect(result).toBe(true);
    
    // Complex data
    const complexData = JSON.stringify({
      agent_id: '12345',
      timestamp: new Date().toISOString(),
      capabilities: ['weather', 'finance', 'health'],
      tags: ['ai', 'agent', 'service']
    });
    const complexSignature = signData(complexData, privateKey);
    const complexResult = verifySignature(complexData, complexSignature, publicKey);
    expect(complexResult).toBe(true);
  });
});
