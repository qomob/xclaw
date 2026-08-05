import logger from './loggerService.js';
import encryptionService from './encryptionService.js';
import topologyService from './topologyService.js';
import { getRedis } from '../core/dependencies.js';
import { instanceId } from '../core/instance.js';

const ROUTE_PREFIX = 'ws:agent:';
const DIRECT_CHANNEL = 'xclaw:ws:direct';
const ROUTE_TTL = 300; // 5 分钟路由有效期

class WebsocketService {
  constructor() {
    this.wss = null;
    this.wsConnections = new Map();
    this.channels = new Map();
    this._pub = null;
    this._sub = null;
    this._bridgeReady = false;
  }

  init(wss, wsConnections) {
    this.wss = wss;
    this.wsConnections = wsConnections;
  }

  /**
   * 初始化跨实例 Redis 桥（定向消息路由）
   */
  async initRedisBridge() {
    if (this._bridgeReady) return;
    this._pub = getRedis();
    this._sub = getRedis().duplicate();
    this._sub.on('message', (channel, message) => {
      if (channel !== DIRECT_CHANNEL) return;
      try {
        const { agentId, instance, payload } = JSON.parse(message);
        if (instance !== instanceId) return;
        const ws = this.wsConnections.get(agentId);
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify(payload));
        }
      } catch (err) {
        logger.warn('[WS-Bridge] Direct delivery error', { error: err.message });
      }
    });
    await this._sub.subscribe(DIRECT_CHANNEL);
    this._bridgeReady = true;
    logger.info('[WS-Bridge] Redis bridge initialized', { instance: instanceId });
  }

  /** 注册 Agent → 实例路由（AUTH 成功后调用） */
  async registerRoute(agentId) {
    try {
      await this._pub.set(`${ROUTE_PREFIX}${agentId}`, instanceId, 'EX', ROUTE_TTL);
    } catch (err) {
      logger.warn('[WS-Bridge] registerRoute failed', { error: err.message, agentId });
    }
  }

  /** 注销路由（连接关闭时调用，仅清理属于本实例的路由） */
  async unregisterRoute(agentId) {
    try {
      const current = await this._pub.get(`${ROUTE_PREFIX}${agentId}`);
      if (current === instanceId) {
        await this._pub.del(`${ROUTE_PREFIX}${agentId}`);
      }
    } catch (err) {
      logger.warn('[WS-Bridge] unregisterRoute failed', { error: err.message, agentId });
    }
  }

  subscribe(channel, agentId) {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }
    this.channels.get(channel).add(agentId);
  }

  unsubscribe(channel, agentId) {
    const members = this.channels.get(channel);
    if (members) {
      members.delete(agentId);
      if (members.size === 0) this.channels.delete(channel);
    }
  }

  _encryptFor(agentId, message) {
    return encryptionService.encryptMessage(message, agentId);
  }

  /**
   * 向指定 Agent 发送消息；本地无连接时尝试跨实例路由
   */
  sendToAgent(agentId, message) {
    const ws = this.wsConnections.get(agentId);
    if (ws && ws.readyState === 1) {
      if (agentId === 'monitor') {
        ws.send(JSON.stringify(message));
        return true;
      }
      try {
        const encrypted = this._encryptFor(agentId, message);
        ws.send(JSON.stringify({ encrypted: true, payload: encrypted }));
        return true;
      } catch (error) {
        logger.error('Failed to send to agent', { agentId, error: error.message });
        return false;
      }
    }
    // 跨实例转发（乐观）
    this._forwardToRemote(agentId, message).catch(() => {});
    return true;
  }

  async _forwardToRemote(agentId, message) {
    try {
      const route = await this._pub.get(`${ROUTE_PREFIX}${agentId}`);
      if (!route || route === instanceId) return; // 无路由或路由陈旧指向本实例
      const payload = agentId === 'monitor'
        ? message
        : this._encryptFor(agentId, message);
      await this._pub.publish(DIRECT_CHANNEL, JSON.stringify({ agentId, instance: route, payload }));
      logger.debug('[WS-Bridge] Forwarded to remote instance', { agentId, route });
    } catch (err) {
      logger.warn('[WS-Bridge] Forward failed', { error: err.message, agentId });
    }
  }

  broadcastToChannel(channel, message) {
    const members = this.channels.get(channel);
    if (!members) return;
    for (const agentId of members) {
      this.sendToAgent(agentId, message);
    }
  }

  /**
   * 拓扑增量广播：持久化到 Redis + 跨实例同步 + 本地投递
   */
  async broadcastDelta(newNode, newLinks) {
    await topologyService.publishUpdate(newNode, newLinks || []);
    if (!this.wss) return;

    this.wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        try {
          const agentId = client.agentId;
          const delta = { type: 'DELTA_UPDATE', data: { nodes: [newNode], links: newLinks || [] } };
          if (agentId === 'monitor') {
            client.send(JSON.stringify(delta));
          } else if (agentId) {
            const encryptedMessage = this._encryptFor(agentId, delta);
            client.send(JSON.stringify({ encrypted: true, payload: encryptedMessage }));
          }
        } catch (error) {
          logger.error('Failed to send delta update', { error: error.message });
        }
      }
    });
  }
}

export default new WebsocketService();
