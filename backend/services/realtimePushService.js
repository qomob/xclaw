import { WebSocketServer } from 'ws';
import logger from './loggerService.js';
import authService from './authService.js';
import { getRedis } from '../core/dependencies.js';
import { instanceId } from '../core/instance.js';

const MAX_CONNECTIONS = parseInt(process.env.WS_MAX_CONNECTIONS || '500', 10);
const MAX_PAYLOAD = 64 * 1024; // 64KB
const RATE_LIMIT_MSGS = parseInt(process.env.WS_MSG_RATE_LIMIT || '60', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.WS_MSG_RATE_WINDOW_MS || '10000', 10);
const BROADCAST_CHANNEL = 'xclaw:ws:broadcast';

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
    this._pub = null;
    this._sub = null;
  }

  /**
   * 初始化 WebSocket 服务器
   * @param {import('http').Server} server - HTTP server 实例
   */
  initialize(server) {
    // 使用 noServer 模式，手动监听 upgrade 事件并按路径分发
    // 避免与主 WSS 共享 server 时 handleUpgrade 被调用两次
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

    this.wss.on('connection', (ws, req) => {
      if (this.clients.size >= MAX_CONNECTIONS) {
        logger.warn('[RealtimePush] connection limit reached, rejecting');
        ws.close(1013, 'Too many connections');
        return;
      }

      const clientId = crypto.randomUUID();
      const client = {
        clientId,
        ws,
        subscriptions: new Set(),
        agentId: null,
        authenticated: false,
        ip: req.socket.remoteAddress,
        msgWindow: { count: 0, start: Date.now() }
      };
      this.clients.set(clientId, client);

      logger.info(`[RealtimePush] client connected: ${clientId} from ${client.ip}`);

      // 发送欢迎消息
      this._send(ws, { type: 'connected', clientId, timestamp: Date.now() });

      ws.on('message', (data) => {
        try {
          // 每客户端消息频率限制
          const now = Date.now();
          if (now - client.msgWindow.start > RATE_LIMIT_WINDOW_MS) {
            client.msgWindow = { count: 1, start: now };
          } else {
            client.msgWindow.count++;
          }
          if (client.msgWindow.count > RATE_LIMIT_MSGS) {
            this._send(ws, { type: 'error', message: 'Rate limit exceeded' });
            return;
          }

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
    this._initBroadcastBridge();
  }

  /**
   * 跨实例广播桥：发布到 Redis 频道，各实例订阅后向本地客户端投递
   */
  _initBroadcastBridge() {
    try {
      this._pub = getRedis();
      this._sub = getRedis().duplicate();
      this._sub.on('message', (channel, message) => {
        if (channel !== BROADCAST_CHANNEL) return;
        try {
          const event = JSON.parse(message);
          if (event.instance === instanceId) return; // 自己发布的已本地投递
          if (event.broadcastAll) {
            this._broadcastLocal(event.data);
          } else {
            this._broadcastChannelLocal(event.channel, event.data);
          }
        } catch (err) {
          logger.warn('[RealtimePush] Broadcast bridge error', { error: err.message });
        }
      });
      this._sub.subscribe(BROADCAST_CHANNEL);
      logger.info('[RealtimePush] Broadcast bridge initialized', { instance: instanceId });
    } catch (err) {
      logger.warn('[RealtimePush] Broadcast bridge init failed', { error: err.message });
    }
  }

  /**
   * 由 server.js 的单一 upgrade 分发器调用（仅处理 /ws 路径）
   */
  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  /**
   * 处理客户端消息
   */
  _handleMessage(clientId, msg) {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (msg.type) {
      case 'auth':
        this._authenticate(client, msg);
        break;

      case 'subscribe':
        if (!client.authenticated) {
          this._send(client.ws, { type: 'error', message: 'Authentication required before subscribing' });
          break;
        }
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
   * 真实认证：支持 API Key 或 Bearer JWT（authService 校验）
   */
  async _authenticate(client, msg) {
    const credential = msg.apiKey || msg.token;
    if (!credential) {
      this._send(client.ws, { type: 'auth_error', message: 'Missing credential' });
      client.ws.close(4401, 'Authentication failed');
      return;
    }

    let agentId = null;

    const keyResult = await authService.verifyApiKey(credential).catch(() => ({ valid: false }));
    if (keyResult.valid) {
      agentId = keyResult.agentId;
    } else {
      const payload = await authService.verifyToken(credential).catch(() => null);
      if (payload) {
        agentId = payload.agentId;
      }
    }

    if (!agentId) {
      this._send(client.ws, { type: 'auth_error', message: 'Invalid credential' });
      client.ws.close(4401, 'Authentication failed');
      return;
    }

    // 身份绑定：以认证凭据解析出的 agentId 为准。客户端自报的 agentId 与凭据
    // 不一致时直接拒绝——防止已认证 agent 冒充他人接收定向推送
    if (msg.agentId && msg.agentId !== agentId) {
      this._send(client.ws, { type: 'auth_error', message: 'agentId does not match the authenticated identity' });
      client.ws.close(4403, 'Agent identity mismatch');
      return;
    }

    client.agentId = agentId;
    client.authenticated = true;
    this._send(client.ws, { type: 'auth_ok', agentId: client.agentId });
    logger.info(`[RealtimePush] client ${client.clientId} authenticated as ${client.agentId}`);
  }

  /**
   * 向指定频道广播消息
   * @param {string} channel
   * @param {*} data
   * @param {string} [excludeClientId]
   */
  broadcast(channel, data, excludeClientId = null) {
    const sent = this._broadcastChannelLocal(channel, data, excludeClientId);
    try {
      this._pub?.publish(BROADCAST_CHANNEL, JSON.stringify({ channel, data, excludeClientId, instance: instanceId }));
    } catch (err) {
      logger.warn('[RealtimePush] Broadcast publish failed', { error: err.message });
    }
    return sent;
  }

  _broadcastChannelLocal(channel, data, excludeClientId = null) {
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
    const sent = this._broadcastLocal(data);
    try {
      this._pub?.publish(BROADCAST_CHANNEL, JSON.stringify({ broadcastAll: true, data, instance: instanceId }));
    } catch (err) {
      logger.warn('[RealtimePush] BroadcastAll publish failed', { error: err.message });
    }
    return sent;
  }

  _broadcastLocal(data) {
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
    try {
      this._sub?.quit();
      this._pub?.quit();
    } catch (_) {}
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
