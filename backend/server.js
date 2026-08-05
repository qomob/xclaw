import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import hpp from 'hpp';

// 核心配置
import config from './core/config.js';
import authService from './services/authService.js';
import encryptionService from './services/encryptionService.js';
import topologyService from './services/topologyService.js';
import websocketService from './services/websocketService.js';
import logger from './services/loggerService.js';
import apiRouter from './gateway/api.js';

// 核心模块
import { initPostgres, initRedis, closeConnections, getRedis } from './core/dependencies.js';
import { errorHandler } from './core/utils.js';
import { handleHeartbeat } from './registry/nodeRegistry.js';
import { runMigrations } from './core/migrations.js';

// 注册模块
import { initDatabase } from './registry/db.js';
import { initGeoIP } from './core/geoip.js';

// 监控模块
import HeartbeatManager from './monitoring/heartbeat.js';
import MetricsManager from './monitoring/metrics.js';
import alertManager from './monitoring/alerts.js';

// 工作流模块
import temporalClient from './workflows/temporalClient.js';

// v1.1: Event Bus + Webhook System
import eventBus from './services/eventBus.js';
import { startRetryProcessor } from './services/webhookService.js';

// Phase 11-12: A2A + Search V2
import a2aService from './services/a2aService.js';
import searchServiceV2 from './services/searchServiceV2.js';

// Realtime Push WebSocket
import realtimePushService from './services/realtimePushService.js';
import realtimeEventBridge from './services/realtimeEvents.js';

// ==========================================
// 1. 初始化依赖与配置
// ==========================================
const app = express();
const port = config.server.port;

// 先启动 HTTP 服务器
const server = app.listen(port, config.server.host, async () => {
  logger.info('HTTP Server running', { port: port, url: `http://${config.server.host}:${port}` });
  
  try {
    // 初始化数据库连接
    await initPostgres();
    await initRedis();
    
    // 初始化数据库表
    await initDatabase();
    // 应用未执行的迁移（修复 schema 漂移）
    await runMigrations();
    
    await initGeoIP();
    
    await temporalClient.init();
    
    // 从 Redis 加载在线节点到 topologyService
    await topologyService.init();
    await topologyService.loadFromRedis(redis);

    // 初始化跨实例 WS 桥（定向消息路由）
    await websocketService.initRedisBridge();
    
    // 初始化监控模块
    const heartbeatManager = new HeartbeatManager();
    heartbeatManager.setWsConnections(wsConnections);
    await heartbeatManager.init();
    
    const metricsManager = new MetricsManager();
    await metricsManager.init();
    
    await alertManager.init();
    
    // v1.1: 初始化事件总线和 Webhook 重试处理器
    await eventBus.init();
    startRetryProcessor();
    
    // Phase 11-12: 初始化 A2A 和 Search V2 服务
    await a2aService.init();
    await searchServiceV2.init();
    
    // 初始化实时推送事件桥接
    realtimeEventBridge.initialize();
    
    logger.info('All services initialized successfully');
  } catch (error) {
    logger.error('Error initializing services:', error);
    process.exit(1);
  }
});

// Redis 连接 (通过依赖注入获取)
const redis = getRedis();

// 将 WebSocket 服务器附加到 HTTP 服务器上
// 注意: 主 WSS 与 RealtimePushService(/ws) 通过单一 upgrade 分发器按路径分流，
// 避免两个 handleUpgrade 竞争导致 /ws 被主 WSS 403 拒绝
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 1024 * 256
});

// WebSocket 连接映射
const wsConnections = new Map();

// 初始化 WebSocket 服务
websocketService.init(wss, wsConnections);

// 初始化实时推送 WebSocket 服务 (路径: /ws)
realtimePushService.initialize(server);

// 单一 upgrade 分发：/ws → RealtimePushService，其余 → Agent WSS
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === '/ws') {
    realtimePushService.handleUpgrade(req, socket, head);
  } else {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
});

// Data pump removed — no auto-registration of zombie nodes
const WS_RATE_LIMIT = parseInt(process.env.WS_RATE_LIMIT || '30');
const WS_RATE_WINDOW_MS = parseInt(process.env.WS_RATE_WINDOW_MS || '10000');
const wsMessageCounts = new Map();

// 中间件
app.use(express.json({ limit: '1mb' }));
app.use(helmet());
app.use(hpp());

// 速率限制中间件
app.set('trust proxy', 1);

const limiter = rateLimit({
  windowMs: config.rateLimit?.windowMs || 15 * 60 * 1000,
  max: config.rateLimit?.max || 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: '请求过于频繁，请稍后再试'
  },
  skip: (req) => req.path === '/health' || req.path === '/metrics'
});
app.use(limiter);

// 请求 ID 中间件：生成/透传 x-request-id，记录请求日志（便于跨服务串联与排障）
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  const start = Date.now();
  res.on('finish', () => {
    logger.info('HTTP request', {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
      ip: req.ip
    });
  });
  next();
});

// CORS 配置
app.use(cors({
  origin: config.security.corsOrigins.length > 0
    ? config.security.corsOrigins
    : ['http://localhost:5173', 'http://127.0.0.1:5173', 'https://xclaw.network', 'https://skill.xclaw.network'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-agent-signature', 'x-agent-id']
}));

// 挂载 API 路由 (包含 /health, /metrics 和 /v1 接口)
app.use('/', apiRouter);

// 全局 404 handler — 所有未匹配的 API 请求返回 JSON
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found', path: req.path });
});

// 全局错误处理 — 捕获 JSON 解析错误、请求体过大等
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: '请求体过大，最大允许 1MB' });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ success: false, error: 'JSON 格式错误' });
  }
  logger.error('Unhandled error', { error: err.message, path: req.path });
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ==========================================
// 2. WebSocket 广播引擎
// ==========================================
// WebSocket 连接映射已在前面定义

wss.on('connection', (ws, req) => {
  // 从查询参数中获取 agent_id
  const url = new URL(req.url, `http://${req.headers.host}`);
  const agentId = url.searchParams.get('agent_id');
  
  // 保存客户端 IP（考虑反向代理）
  const forwarded = req.headers['x-forwarded-for'];
  ws._clientIp = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  
  if (!agentId) {
    logger.warn('WebSocket connection failed: missing agent_id');
    ws.close(4001, 'Missing agent_id');
    return;
  }
  
  logger.info('New WebSocket connection', { agentId, clientCount: wss.clients.size });
  
  // 如果是 monitor 模式，验证 monitor token 后加入连接池
  if (agentId === 'monitor') {
    const monitorToken = url.searchParams.get('token');
    const expectedToken = process.env.MONITOR_TOKEN;
    if (expectedToken) {
      let tokenValid = false;
      try {
        // timingSafeEqual 要求两缓冲区等长，先比长度避免异常崩溃
        const provided = Buffer.from(monitorToken || '');
        const expected = Buffer.from(expectedToken);
        tokenValid = provided.length === expected.length
          && crypto.timingSafeEqual(provided, expected);
      } catch (err) {
        logger.warn('Monitor token comparison error', { error: err.message });
      }
      if (!tokenValid) {
        logger.warn('Monitor WebSocket connection rejected: invalid token');
        ws.close(4003, 'Invalid monitor token');
        return;
      }
    }
    wsConnections.set(agentId, ws);
    logger.info('Monitor WebSocket connected');
    
    // 发送初始拓扑数据
    ws.send(JSON.stringify({
      type: 'INIT_TOPOLOGY',
      data: topologyService.getState()
    }));
    
    ws.on('close', () => {
      wsConnections.delete(agentId);
      logger.info('Monitor WebSocket disconnected');
    });
    return;
  }
  
  // 踢掉同一 agentId 的旧连接
  const oldWs = wsConnections.get(agentId);
  if (oldWs && oldWs !== ws) {
    oldWs.removeAllListeners('close');
    oldWs.close();
    wsConnections.delete(agentId);
  }

  const authHandler = async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'AUTH') {
        const { agent_id, timestamp, signature } = data;

        if (agent_id !== agentId) {
          ws.close(4001, 'Agent ID mismatch');
          return;
        }

        const publicKeyPem = await authService.getAgentPublicKey(agentId);
        if (!publicKeyPem) {
          ws.close(4001, 'Agent not registered');
          return;
        }

        const authData = JSON.stringify({ agent_id, timestamp });
        if (!authService.verifySignature(authData, signature, publicKeyPem)) {
          ws.close(4001, 'Invalid signature');
          return;
        }

        wsConnections.set(agentId, ws);
        ws.agentId = agentId;
        logger.info('WebSocket authenticated', { agentId });
        await websocketService.registerRoute(agentId);

        const redisClient = getRedis();
        const now = new Date();
        await redisClient.hset(`node:${agentId}`, 'status', 'online', 'last_heartbeat', now.toISOString());
        await redisClient.sadd('online_nodes', agentId);
        await redisClient.set(`xclaw:agent:${agentId}:status`, 'online', 'EX', 300);

        ws.send(JSON.stringify({ type: 'AUTH_SUCCESS' }));

        const agentName = agentId.length > 12 ? agentId.slice(0, 12) + '...' : agentId;
        websocketService.sendToAgent('monitor', {
          type: 'AGENT_STATUS',
          data: {
            status: 'online',
            agent_id: agentId,
            agent_name: agentName,
            timestamp: now.toISOString()
          }
        });

        await recoverOfflineMessages(agentId, ws);

        ws.removeListener('message', authHandler);
        ws.on('message', (message) => {
          const now = Date.now();
          const bucket = wsMessageCounts.get(agentId) || { count: 0, start: now };
          if (now - bucket.start > WS_RATE_WINDOW_MS) {
            bucket.count = 1;
            bucket.start = now;
          } else {
            bucket.count++;
          }
          wsMessageCounts.set(agentId, bucket);
          if (bucket.count > WS_RATE_LIMIT) {
            logger.warn('WS rate limit exceeded', { agentId, count: bucket.count });
            ws.send(JSON.stringify({ success: false, error: 'Rate limit exceeded' }));
            return;
          }
          handleWebSocketMessage(message, agentId, ws._clientIp);
        });
      }
    } catch (error) {
      logger.error('WebSocket message error', { error: error.message, agentId });
      ws.close(4002, 'Invalid message');
    }
  };

  ws.on('message', authHandler);

    ws.on('close', () => {
      if (wsConnections.get(agentId) === ws) {
        wsConnections.delete(agentId);
        websocketService.unregisterRoute(agentId).catch(() => {});
      // 更新离线状态
      (async () => {
        try {
          const redisClient = getRedis();
          await redisClient.set(`xclaw:agent:${agentId}:status`, 'offline', 'EX', 300);
          await redisClient.srem('online_nodes', agentId);
        } catch (error) {
          logger.warn('Failed to update offline status', { agentId, error: error.message });
        }
      })();
      const agentName = agentId.length > 12 ? agentId.slice(0, 12) + '...' : agentId;
      websocketService.sendToAgent('monitor', {
        type: 'AGENT_STATUS',
        data: {
          status: 'offline',
          agent_id: agentId,
          agent_name: agentName,
          timestamp: new Date().toISOString()
        }
      });
    }
    wsMessageCounts.delete(agentId);
    logger.info('WebSocket disconnected', { agentId, clientCount: wss.clients.size });
  });
});

// 处理 WebSocket 消息
async function handleWebSocketMessage(message, agentId, clientIp) {
  try {
    const data = JSON.parse(message);
    
    if (data.encrypted) {
      try {
        const decryptedData = encryptionService.decryptMessage(data.payload, agentId);
        switch (decryptedData.type) {
          case 'MESSAGE':
            await handleDirectMessage(decryptedData, agentId);
            break;
          case 'BROADCAST':
            await handleBroadcastMessage(decryptedData, agentId);
            break;
          default:
            logger.warn('Unknown message type', { type: decryptedData.type });
        }
      } catch (error) {
        logger.error('Failed to decrypt message', { error: error.message, agentId });
      }
    } else {
      switch (data.type) {
        case 'MESSAGE':
          await handleDirectMessage(data, agentId);
          break;
        case 'BROADCAST':
          await handleBroadcastMessage(data, agentId);
          break;
        case 'HEARTBEAT':
          await handleHeartbeat(agentId, clientIp);
          break;
        default:
          logger.warn('Unknown message type', { type: data.type });
      }
    }
  } catch (error) {
    logger.error('Message processing error', { error: error.message, agentId });
  }
}

// 处理点对点消息
async function handleDirectMessage(message, authenticatedAgentId) {
  const sender_id = message.sender_id || authenticatedAgentId;
  const recipient_id = message.recipient_id || message.to_agent_id;
  const content = message.content || message.payload?.content;
  const timestamp = message.timestamp || new Date().toISOString();
  const signature = message.signature;

  if (!recipient_id) {
    logger.warn('Message rejected: missing recipient_id', { sender_id });
    return;
  }

  if (signature) {
    const senderPublicKey = await authService.getAgentPublicKey(sender_id);
    if (!senderPublicKey) {
      logger.warn('Message rejected: sender not registered', { sender_id });
      return;
    }
    const messageData = JSON.stringify({ sender_id, recipient_id, content, timestamp });
    if (!authService.verifySignature(messageData, signature, senderPublicKey)) {
      logger.warn('Message rejected: invalid signature', { sender_id });
      return;
    }
  } else if (sender_id !== authenticatedAgentId) {
    logger.warn('Message rejected: sender_id mismatch with authenticated connection', { sender_id, authenticatedAgentId });
    return;
  }
  
  const delivered = websocketService.sendToAgent(recipient_id, {
    type: 'MESSAGE',
    sender_id,
    content,
    timestamp
  });
  if (delivered) {
    logger.info('Message delivered', { sender_id, recipient_id });
  } else {
    const encryptedMessage = encryptionService.encryptMessage(message, recipient_id);
    await storeOfflineMessage(recipient_id, {
      ...message,
      encrypted: true,
      payload: encryptedMessage
    });
    logger.info('Encrypted message stored for offline recipient', { sender_id, recipient_id });
  }
  
  websocketService.sendToAgent('monitor', {
    type: 'LOG_MESSAGE',
    logType: 'p2p',
    data: { sender_id, recipient_id, content, timestamp }
  });
}

// 处理广播消息
async function handleBroadcastMessage(message, authenticatedAgentId) {
  const sender_id = message.sender_id || authenticatedAgentId;
  const content = message.content || message.payload?.content;
  const tags = message.tags || message.payload?.tags || [];
  const timestamp = message.timestamp || new Date().toISOString();
  const signature = message.signature;

  if (!sender_id) {
    logger.warn('Broadcast rejected: no sender identity');
    return;
  }

  if (signature) {
    const senderPublicKey = await authService.getAgentPublicKey(sender_id);
    if (!senderPublicKey) {
      logger.warn('Broadcast rejected: sender not registered', { sender_id });
      return;
    }
    const messageData = JSON.stringify({ sender_id, content, tags, timestamp });
    if (!authService.verifySignature(messageData, signature, senderPublicKey)) {
      logger.warn('Broadcast rejected: invalid signature', { sender_id });
      return;
    }
  } else if (sender_id !== authenticatedAgentId) {
    logger.warn('Broadcast rejected: sender_id mismatch with authenticated connection', { sender_id, authenticatedAgentId });
    return;
  }
  
  let sentCount = 0;
  for (const [agentId] of wsConnections) {
    if (agentId === sender_id) continue;
    if (tags && tags.length > 0) {
      const agentNode = topologyService.getState().nodes.find(n => n.id === agentId);
      if (agentNode && tags.some(tag => agentNode.tags && agentNode.tags.includes(tag))) {
        const sent = websocketService.sendToAgent(agentId, {
          type: 'BROADCAST',
          sender_id,
          content,
          tags,
          timestamp
        });
        if (sent) sentCount++;
      }
    } else {
      const sent = websocketService.sendToAgent(agentId, {
        type: 'BROADCAST',
        sender_id,
        content,
        timestamp
      });
      if (sent) sentCount++;
    }
  }
  
  logger.info('Broadcast sent', { sender_id, tagCount: tags ? tags.length : 0, recipients: sentCount });

  websocketService.sendToAgent(sender_id, {
    success: true,
    message: `Broadcast sent to ${sentCount} agent(s)`,
    recipients: sentCount
  });
  
  websocketService.sendToAgent('monitor', {
    type: 'LOG_MESSAGE',
    logType: 'channel',
    data: { sender_id, content, tags, timestamp }
  });
}

// 存储离线消息
async function storeOfflineMessage(recipientId, message) {
  try {
    const streamKey = `agent_inbox:${recipientId}`;
    await redis.xadd(streamKey, '*', 'sender_id', message.sender_id, 'payload', JSON.stringify(message), 'timestamp', message.timestamp);
    // 设置过期时间（7天）
    await redis.expire(streamKey, 7 * 24 * 60 * 60);
  } catch (error) {
    logger.error('Failed to store offline message', { error: error.message, recipientId });
  }
}

// 恢复离线消息
async function recoverOfflineMessages(agentId, ws) {
  try {
    const streamKey = `agent_inbox:${agentId}`;
    const messages = await redis.xrange(streamKey, '-', '+');
    
    for (const [id, fields] of messages) {
      const message = JSON.parse(fields.payload);
      
      if (message.encrypted) {
        // 直接转发加密消息
        ws.send(JSON.stringify({
          encrypted: true,
          payload: message.payload
        }));
      } else {
        // 加密后发送未加密的消息
        const encryptedMessage = encryptionService.encryptMessage({
          type: 'MESSAGE',
          sender_id: message.sender_id,
          content: message.content,
          timestamp: message.timestamp
        }, agentId);
        
        ws.send(JSON.stringify({
          encrypted: true,
          payload: encryptedMessage
        }));
      }
      
      // 删除已传递的消息
      await redis.xdel(streamKey, id);
    }
    
    if (messages.length > 0) {
      logger.info('Offline messages recovered', { agentId, count: messages.length });
    }
  } catch (error) {
    logger.error('Failed to recover offline messages', { error: error.message, agentId });
  }
}

// ==========================================
// Section 4 API routes removed and migrated to gateway/api.js

// ==========================================
// 6. 新 API 路由
// Section 6, 7, 8 API routes removed and migrated to gateway/api.js

// ==========================================
// 4. 定时任务
// ==========================================

// Data pump removed — interval timer disabled

// 全局错误处理
app.use(errorHandler);

// 优雅关闭
async function gracefulShutdown(signal) {
  logger.info('Shutting down server...', { signal });

  wss.clients.forEach(client => client.close());

  await closeConnections();

  server.close(() => {
    logger.info('Server stopped');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

logger.info('WebSocket server initialized and attached to HTTP server');
