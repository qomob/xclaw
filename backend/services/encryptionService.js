import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import logger from './loggerService.js';

class EncryptionService {
  constructor() {
    this.masterKey = process.env.ENCRYPTION_KEY;
    this.algorithm = 'aes-256-gcm';

    if (!this.masterKey && process.env.NODE_ENV === 'production') {
      logger.error('CRITICAL: ENCRYPTION_KEY not provided in production environment!');
      throw new Error('Server configuration error: ENCRYPTION_KEY missing');
    }

    if (!this.masterKey) {
      const keyPath = path.join(process.cwd(), '.dev-encryption-key');
      try {
        this.masterKey = fs.readFileSync(keyPath, 'utf8').trim();
      } catch {
        this.masterKey = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(keyPath, this.masterKey, { mode: 0o600 });
        logger.warn('ENCRYPTION_KEY not provided, generated and saved to .dev-encryption-key');
      }
    }
  }

  // 加密数据
  encrypt(data, additionalData = '') {
    // 生成随机初始化向量
    const iv = crypto.randomBytes(16);
    // 生成随机认证标签
    const tagLength = 16;
    
    // 创建加密器
    const cipher = crypto.createCipheriv(this.algorithm, Buffer.from(this.masterKey, 'hex'), iv, {
      authTagLength: tagLength
    });
    
    // 添加附加数据
    cipher.setAAD(Buffer.from(additionalData));
    
    // 加密数据
    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    
    // 获取认证标签
    const tag = cipher.getAuthTag().toString('base64');
    
    return {
      iv: iv.toString('base64'),
      tag,
      encryptedData: encrypted
    };
  }

  // 解密数据
  decrypt(encryptedData, iv, tag, additionalData = '') {
    try {
      // 创建解密器
      const decipher = crypto.createDecipheriv(
        this.algorithm,
        Buffer.from(this.masterKey, 'hex'),
        Buffer.from(iv, 'base64'),
        {
          authTagLength: 16
        }
      );
      
      // 添加附加数据
      decipher.setAAD(Buffer.from(additionalData));
      
      // 设置认证标签
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      
      // 解密数据
      let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
      decrypted += decipher.final('utf8');
      
      return JSON.parse(decrypted);
    } catch (error) {
      console.error('Decryption error:', error);
      throw new Error('Failed to decrypt data');
    }
  }

  // 加密消息（用于 WebSocket 传输）
  encryptMessage(message, agentId) {
    return this.encrypt(message, agentId);
  }

  // 解密消息（用于 WebSocket 传输）
  decryptMessage(encryptedMessage, agentId) {
    const { iv, tag, encryptedData } = encryptedMessage;
    return this.decrypt(encryptedData, iv, tag, agentId);
  }

  // 生成安全的随机密钥
  generateKey() {
    return crypto.randomBytes(32).toString('hex');
  }

  // 哈希数据
  hash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  // 生成 HMAC
  generateHMAC(data, key) {
    return crypto.createHmac('sha256', key).update(data).digest('hex');
  }
}

// 导出单例
export default new EncryptionService();
