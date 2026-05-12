import crypto from 'crypto';
import { v5 as uuidv5 } from 'uuid';
import logger from './loggerService.js';
import { getPostgres, getRedis } from '../core/dependencies.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  process.exit(1);
}
const JWT_ALGORITHM = 'HS256';
const JWT_TYPE = 'JWT';

function base64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64');
}

class AuthService {
  constructor() {
    this.agentPublicKeys = new Map();
    this.tokenExpiry = 24 * 60 * 60 * 1000;
  }

  verifySignature(data, signature, publicKeyPem) {
    try {
      if (typeof data === 'string') {
        data = Buffer.from(data);
      }
      return crypto.verify(null, data, {
        key: publicKeyPem,
        type: 'spki',
        format: 'pem'
      }, Buffer.from(signature, 'base64'));
    } catch (error) {
      logger.error('Signature verification failed', { error: error.message });
      return false;
    }
  }

  generateAgentId(publicKey) {
    const AGENT_NAMESPACE = '1b671a64-40d5-491e-99b0-da01ff1f3341';
    return uuidv5(publicKey, AGENT_NAMESPACE);
  }

  registerAgent(agentId, publicKey) {
    this.agentPublicKeys.set(agentId, publicKey);
    logger.info('Agent public key registered in memory', { agentId, totalKeys: this.agentPublicKeys.size });
  }

  async getAgentPublicKey(agentId) {
    if (this.agentPublicKeys.has(agentId)) {
      return this.agentPublicKeys.get(agentId);
    }
    try {
      const pgPool = getPostgres();
      const result = await pgPool.query(
        'SELECT public_key FROM nodes WHERE node_id = $1',
        [agentId]
      );
      if (result.rows.length > 0) {
        const publicKey = result.rows[0].public_key;
        this.agentPublicKeys.set(agentId, publicKey);
        return publicKey;
      }
    } catch (e) {
      logger.error('Failed to fetch agent public key from DB', { error: e.message, agentId });
    }
    return null;
  }

  generateToken(agentId) {
    const now = Math.floor(Date.now() / 1000);
    const header = base64urlEncode(JSON.stringify({ alg: JWT_ALGORITHM, typ: JWT_TYPE }));
    const payload = base64urlEncode(JSON.stringify({
      jti: crypto.randomUUID(),
      agentId,
      iat: now,
      exp: now + Math.floor(this.tokenExpiry / 1000)
    }));
    const signingInput = `${header}.${payload}`;
    const signature = base64urlEncode(
      crypto.createHmac('sha256', JWT_SECRET).update(signingInput).digest()
    );
    return `${header}.${payload}.${signature}`;
  }

  async verifyToken(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const [headerB64, payloadB64, sigB64] = parts;
      const signingInput = `${headerB64}.${payloadB64}`;

      const expectedSig = base64urlEncode(
        crypto.createHmac('sha256', JWT_SECRET).update(signingInput).digest()
      );
      if (sigB64 !== expectedSig) {
        logger.warn('Token signature mismatch');
        return null;
      }

      const redis = getRedis();
      const blacklisted = await redis.get(`blacklist:${token}`);
      if (blacklisted) return null;

      const payload = JSON.parse(base64urlDecode(payloadB64).toString());
      if (payload.exp < Math.floor(Date.now() / 1000)) {
        return null;
      }

      return payload;
    } catch (error) {
      logger.error('Token verification failed', { error: error.message });
      return null;
    }
  }

  async revokeToken(token) {
    const payload = await this.verifyToken(token);
    if (payload) {
      const ttl = payload.exp - Math.floor(Date.now() / 1000);
      if (ttl > 0) {
        const redis = getRedis();
        await redis.set(`blacklist:${token}`, '1', 'EX', ttl);
      }
      logger.info('Token revoked', { agentId: payload.agentId });
    }
  }

  async isTokenRevoked(token) {
    const redis = getRedis();
    return (await redis.get(`blacklist:${token}`)) !== null;
  }

  checkPermission(agentId) {
    return this.agentPublicKeys.has(agentId);
  }

  async generateApiKey(agentId) {
    const apiKey = `ak_${crypto.randomBytes(24).toString('base64url')}`;
    const redis = getRedis();
    await redis.set(`apikey:${apiKey}`, agentId);
    logger.info('API key generated', { agentId, keyPrefix: apiKey.substring(0, 10) });
    return apiKey;
  }

  async verifyApiKey(apiKey) {
    const redis = getRedis();
    const agentId = await redis.get(`apikey:${apiKey}`);
    if (agentId) {
      return { valid: true, agentId };
    }
    return { valid: false };
  }

  async deleteApiKey(apiKey) {
    const redis = getRedis();
    return (await redis.del(`apikey:${apiKey}`)) > 0;
  }

  async authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const payload = await this.verifyToken(token);
      if (payload) {
        req.agentId = payload.agentId;
        return next();
      }
    }

    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const keyResult = await this.verifyApiKey(apiKey);
      if (keyResult.valid) {
        req.agentId = keyResult.agentId;
        return next();
      }
    }

    res.status(401).json({ error: 'Unauthorized' });
  }
}

export default new AuthService();
