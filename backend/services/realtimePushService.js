import { WebSocketServer } from 'ws';
import logger from './loggerService.js';

/**
 * RealtimePushService — 实时推送 WebSocket 服务
 * 路径: /ws (区别于现有的 agent WebSocket 无特定路径)
 * 
 * 支持:
 *  - 频道订阅/退订
 *  - 广播、定向推送
 *  - 心跳保活 (30秒服务端 ping)
 */
class RealtimePushService {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // clientId -> { ws, subscriptions, agentId, ip }
    this.heartbeatInterval = null;
    this.initialized = false;
  }

  /**
   * 初始化 WebSocket 服务器
   * @param {import('http').Server} server - HTTP server 实例
   */
  initialize(server) {
    // 使用 noServer 模式，手动监听 upgrade 事件并按路径分发
    // 避免与主 WSS 共享 server 时 handleUpgrade 被调用两次
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url, `http://${req.headers.host}`);
      if (pathname === '/ws') {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
      }
    });

    this.wss.on('connection', (ws, req) => {
      const clientId = crypto.randomUUID();
      const client = {
        ws,
        subscriptions: new Set(),
        agentId: null,
        ip: req.socket.remoteAddress,
      };
      this.clients.set(clientId, client);

      logger.info(`[RealtimePush] client connected: ${clientId} from ${client.ip}`);

      // 发送欢迎消息
      this._send(ws, { type: 'connected', clientId, timestamp: Date.now() });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(clientId, msg);
        } catch (err) {
          this._send(ws, { type: 'error', message: 'Invalid JSON' });
        }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
        logger.info(`[RealtimePush] client disconnected: ${clientId}`);
      });

      ws.on('error', (err) => {
        logger.error(`[RealtimePush] client error (${clientId}):`, err.message);
      });

      // 心跳
      ws.on('ping', () => ws.pong());
    });

    // 全局心跳（30秒）
    this.heartbeatInterval = setInterval(() => {
      for (const [id, client] of this.clients) {
        if (client.ws.readyState === 1) {
          // OPEN
          client.ws.ping();
        } else {
          this.clients.delete(id);
        }
      }
    }, 30000);

    this.initialized = true;
    logger.info(`[RealtimePush] WebSocket service initialized on /ws`);
  }

  /**
   * 处理客户端消息
   */
  _handleMessage(clientId, msg) {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (msg.type) {
      case 'auth':
        if (msg.apiKey) {
          client.agentId = msg.agentId || clientId;
          this._send(client.ws, { type: 'auth_ok', agentId: client.agentId });
          logger.info(`[RealtimePush] client ${clientId} authenticated as ${client.agentId}`);
        }
        break;

      case 'subscribe':
        if (Array.isArray(msg.channels)) {
          msg.channels.forEach((ch) => client.subscriptions.add(ch));
          this._send(client.ws, { type: 'subscribed', channels: msg.channels });
          logger.debug(`[RealtimePush] client ${clientId} subscribed to: ${msg.channels.join(', ')}`);
        }
        break;

      case 'unsubscribe':
        if (Array.isArray(msg.channels)) {
          msg.channels.forEach((ch) => client.subscriptions.delete(ch));
          this._send(client.ws, { type: 'unsubscribed', channels: msg.channels });
        }
        break;

      case 'ping':
        this._send(client.ws, { type: 'pong', timestamp: Date.now() });
        break;

      default:
        this._send(client.ws, {
          type: 'error',
          message: `Unknown message type: ${msg.type}`,
        });
    }
  }

  /**
   * 向指定频道广播消息
   * @param {string} channel
   * @param {*} data
   * @param {string} [excludeClientId]
   */
  broadcast(channel, data, excludeClientId = null) {
    const message = { type: channel, data, timestamp: Date.now() };
    let sent = 0;
    for (const [id, client] of this.clients) {
      if (id === excludeClientId) continue;
      if (
        client.subscriptions.has(channel) ||
        client.subscriptions.has('*')
      ) {
        if (client.ws.readyState === 1) {
          this._send(client.ws, message);
          sent++;
        }
      }
    }
    return sent;
  }

  /**
   * 向所有连接广播
   */
  broadcastAll(data) {
    const message = { type: 'broadcast', data, timestamp: Date.now() };
    let sent = 0;
    for (const [, client] of this.clients) {
      if (client.ws.readyState === 1) {
        this._send(client.ws, message);
        sent++;
      }
    }
    return sent;
  }

  /**
   * 向特定 agent 发送
   */
  sendToAgent(agentId, data) {
    for (const [, client] of this.clients) {
      if (client.agentId === agentId && client.ws.readyState === 1) {
        this._send(client.ws, { type: 'direct', data, timestamp: Date.now() });
        return true;
      }
    }
    return false;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      totalClients: this.clients.size,
      authenticatedClients: [...this.clients.values()].filter((c) => c.agentId)
        .length,
      channels: [
        ...new Set(
          [...this.clients.values()].flatMap((c) => [...c.subscriptions])
        ),
      ],
      uptime: process.uptime(),
    };
  }

  /**
   * 关闭服务
   */
  shutdown() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.wss) {
      for (const [, client] of this.clients) {
        client.ws.close(1001, 'Server shutting down');
      }
      this.wss.close();
    }
    this.initialized = false;
  }

  /** @private */
  _send(ws, data) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }
}

export default new RealtimePushService();
