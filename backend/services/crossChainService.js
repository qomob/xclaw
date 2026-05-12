import crypto from 'crypto';
import logger from './loggerService.js';
import authService from './authService.js';
import encryptionService from './encryptionService.js';
import { getRedis } from '../core/dependencies.js';

const MESSAGE_QUEUE_PREFIX = 'xclaw:crossnet:queue:';
const MESSAGE_STATUS_PREFIX = 'xclaw:crossnet:status:';
const NETWORK_REGISTRY_KEY = 'xclaw:crossnet:networks';
const DLQ_PREFIX = 'xclaw:crossnet:dlq:';
const BRPOP_TIMEOUT = parseInt(process.env.CROSSNET_BRPOP_TIMEOUT || '5');
const MAX_RETRIES = parseInt(process.env.CROSSNET_MAX_RETRIES || '3');
const RELAY_TIMEOUT_MS = parseInt(process.env.CROSSNET_RELAY_TIMEOUT || '10000');

class CrossNetworkService {
  constructor() {
    this.redis = null;
    this.localNetworkId = process.env.NETWORK_ID || 'default';
    this.localEndpoint = process.env.LOCAL_ENDPOINT || '';
    this._consumerRunning = false;
    this._abortController = null;
  }

  _getRedis() {
    if (!this.redis) {
      this.redis = getRedis();
    }
    return this.redis;
  }

  async init() {
    const redis = this._getRedis();
    await redis.hSet(NETWORK_REGISTRY_KEY, this.localNetworkId, JSON.stringify({
      url: this.localEndpoint,
      network_id: this.localNetworkId,
      last_seen: Date.now()
    }));
    logger.info('Cross-network service initialized', { localNetworkId: this.localNetworkId, localEndpoint: this.localEndpoint });
    this.startPoller();
  }

  startPoller() {
    if (this._consumerRunning) return;
    this._consumerRunning = true;
    this._abortController = new AbortController();
    this._consumeLoop();
    logger.info('Cross-network BRPOP consumer started');
  }

  stopPoller() {
    this._consumerRunning = false;
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  async _consumeLoop() {
    const redis = this._getRedis();
    const queueKey = `${MESSAGE_QUEUE_PREFIX}${this.localNetworkId}`;

    while (this._consumerRunning) {
      try {
        const result = await redis.brPop(queueKey, BRPOP_TIMEOUT);
        if (!result) continue;

        const entry = JSON.parse(result.element);
        try {
          await this.deliverToLocalRecipient(entry);
        } catch (error) {
          logger.error('Failed to deliver cross-network message', { error: error.message, messageId: entry?.id });
          await redis.rPush(`${DLQ_PREFIX}${this.localNetworkId}`, JSON.stringify(entry));
          await redis.set(`${MESSAGE_STATUS_PREFIX}${entry?.id}`,
            JSON.stringify({ status: 'delivery_failed', error: error.message, timestamp: Date.now() }), { EX: 86400 });
        }
      } catch (error) {
        if (!this._consumerRunning) break;
        logger.error('Error in cross-network BRPOP consumer', { error: error.message });
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  generateCrossNetworkMessage(fromNetwork, toNetwork, senderId, recipientId, content, nonce = null) {
    return {
      id: crypto.randomUUID(),
      fromNetwork,
      toNetwork,
      senderId,
      recipientId,
      content,
      nonce: nonce || `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      timestamp: Date.now(),
      status: 'pending'
    };
  }

  signCrossNetworkMessage(message, privateKey) {
    const messageData = JSON.stringify({
      id: message.id, fromNetwork: message.fromNetwork,
      toNetwork: message.toNetwork, senderId: message.senderId,
      recipientId: message.recipientId, content: message.content,
      nonce: message.nonce, timestamp: message.timestamp
    });
    const signature = crypto.createSign('SHA256').update(messageData).sign(privateKey, 'hex');
    return { ...message, signature };
  }

  async verifyCrossNetworkMessage(message) {
    const publicKey = await authService.getAgentPublicKey(message.senderId);
    if (!publicKey) return false;

    const messageData = JSON.stringify({
      id: message.id, fromNetwork: message.fromNetwork,
      toNetwork: message.toNetwork, senderId: message.senderId,
      recipientId: message.recipientId, content: message.content,
      nonce: message.nonce, timestamp: message.timestamp
    });

    try {
      return crypto.createVerify('SHA256').update(messageData).verify(publicKey, message.signature, 'hex');
    } catch (error) {
      logger.error('Failed to verify cross-network message signature', { error: error.message });
      return false;
    }
  }

  encryptCrossNetworkMessage(message) {
    return encryptionService.encrypt(message, `${message.fromNetwork}:${message.toNetwork}`);
  }

  decryptCrossNetworkMessage(encryptedMessage) {
    return encryptionService.decrypt(
      encryptedMessage.encryptedData, encryptedMessage.iv, encryptedMessage.tag,
      `${encryptedMessage.fromNetwork}:${encryptedMessage.toNetwork}`
    );
  }

  async sendCrossNetworkMessage(message) {
    try {
      if (!await this.verifyCrossNetworkMessage(message)) {
        throw new Error('Invalid message signature');
      }

      const encryptedMessage = this.encryptCrossNetworkMessage(message);
      const redis = this._getRedis();

      if (message.toNetwork === this.localNetworkId) {
        const queueKey = `${MESSAGE_QUEUE_PREFIX}${message.toNetwork}`;
        await redis.rPush(queueKey, JSON.stringify(encryptedMessage));
        await redis.set(`${MESSAGE_STATUS_PREFIX}${message.id}`,
          JSON.stringify({ status: 'sent', timestamp: Date.now(), delivery: 'local' }), { EX: 86400 });
        logger.info('Cross-network message queued (local)', { messageId: message.id, toNetwork: message.toNetwork });
      } else {
        const targetInfo = await redis.hGet(NETWORK_REGISTRY_KEY, message.toNetwork);
        if (!targetInfo) {
          throw new Error(`Target network '${message.toNetwork}' not found in registry`);
        }
        const targetUrl = JSON.parse(targetInfo).url;
        if (!targetUrl) throw new Error(`No endpoint for network '${message.toNetwork}'`);

        await this.relayToRemote(encryptedMessage, targetUrl);
        await redis.set(`${MESSAGE_STATUS_PREFIX}${message.id}`,
          JSON.stringify({ status: 'sent', timestamp: Date.now(), delivery: 'remote', target_url: targetUrl }), { EX: 86400 });
        logger.info('Cross-network message relayed (remote)', { messageId: message.id, toNetwork: message.toNetwork, targetUrl });
      }

      return { success: true, messageId: message.id };
    } catch (error) {
      logger.error('Failed to send cross-network message', { error: error.message, messageId: message.id });
      const redis = this._getRedis();
      await redis.set(`${MESSAGE_STATUS_PREFIX}${message.id}`,
        JSON.stringify({ status: 'failed', error: error.message, timestamp: Date.now() }), { EX: 86400 });
      return { success: false, error: error.message };
    }
  }

  async relayToRemote(encryptedMessage, targetUrl) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);

        const response = await fetch(`${targetUrl.replace(/\/+$/, '')}/api/v1/crossnet/receive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_network: this.localNetworkId, payload: encryptedMessage }),
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => '')}`);
        }

        const result = await response.json();
        if (!result.success) throw new result.error || new Error('Remote rejected message');
        return;
      } catch (error) {
        lastError = error;
        logger.warn(`Cross-net relay attempt ${attempt}/${MAX_RETRIES} failed`, { error: error.message, targetUrl });
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }
    throw lastError;
  }

  async receiveFromRemote(sourceNetwork, payload) {
    const redis = this._getRedis();
    const queueKey = `${MESSAGE_QUEUE_PREFIX}${this.localNetworkId}`;

    const entry = {
      ...payload,
      _received_from_remote: sourceNetwork,
      _received_at: Date.now()
    };

    await redis.rPush(queueKey, JSON.stringify(entry));
    logger.info('Received remote cross-network message', { sourceNetwork, messageId: payload?.id });
    return { success: true, received: true };
  }

  async deliverToLocalRecipient(encryptedEntry) {
    const redis = this._getRedis();
    const message = this.decryptCrossNetworkMessage(encryptedEntry);

    await redis.set(`${MESSAGE_STATUS_PREFIX}${message.id}`,
      JSON.stringify({ status: 'delivered', delivered_to: message.recipientId, timestamp: Date.now() }), { EX: 86400 });

    logger.info('Cross-network message delivered locally', {
      messageId: message.id, fromNetwork: message.fromNetwork, recipientId: message.recipientId
    });

    return message;
  }

  async registerRemoteNetwork(networkId, url) {
    const redis = this._getRedis();
    await redis.hSet(NETWORK_REGISTRY_KEY, networkId, JSON.stringify({
      url, network_id: networkId, registered_by: this.localNetworkId, registered_at: Date.now()
    }));
    logger.info('Remote network registered', { networkId, url });
  }

  async listRegisteredNetworks() {
    const redis = this._getRedis();
    const all = await redis.hGetAll(NETWORK_REGISTRY_KEY);
    return Object.entries(all).reduce((acc, [id, data]) => {
      acc[id] = JSON.parse(data); return acc;
    }, {});
  }

  async getMessageStatus(messageId) {
    const redis = this._getRedis();
    const data = await redis.get(`${MESSAGE_STATUS_PREFIX}${messageId}`);
    return data ? JSON.parse(data) : { status: 'not_found' };
  }

  async getDeadLetterQueue() {
    const redis = this._getRedis();
    const dlqKey = `${DLQ_PREFIX}${this.localNetworkId}`;
    const items = await redis.lRange(dlqKey, 0, -1);
    return items.map(item => JSON.parse(item));
  }

  async retryDeadLetterMessage(messageId) {
    const redis = this._getRedis();
    const dlqKey = `${DLQ_PREFIX}${this.localNetworkId}`;
    const items = await redis.lRange(dlqKey, 0, -1);

    for (let i = 0; i < items.length; i++) {
      const entry = JSON.parse(items[i]);
      if (entry.id === messageId) {
        await redis.lRem(dlqKey, 1, items[i]);
        await redis.rPush(`${MESSAGE_QUEUE_PREFIX}${this.localNetworkId}`, items[i]);
        await redis.set(`${MESSAGE_STATUS_PREFIX}${messageId}`,
          JSON.stringify({ status: 'retry_pending', timestamp: Date.now() }), { EX: 86400 });
        logger.info('Dead letter message retried', { messageId });
        return { success: true };
      }
    }
    return { success: false, error: 'Message not found in DLQ' };
  }

  async updateLocalHeartbeat() {
    const redis = this._getRedis();
    const existing = await redis.hGet(NETWORK_REGISTRY_KEY, this.localNetworkId);
    if (existing) {
      const info = JSON.parse(existing);
      info.last_seen = Date.now();
      await redis.hSet(NETWORK_REGISTRY_KEY, this.localNetworkId, JSON.stringify(info));
    }
  }
}

export default new CrossNetworkService();
