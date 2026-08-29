// WebSocket 管理文件
import { WebSocketServer as WSS } from 'ws';
import { getNode, updateNodeStatus, handleHeartbeat } from '../registry/nodeRegistry.js';
import { getRedis } from '../core/dependencies.js';
import { verifySignature, formatResponse, isTimestampFresh } from '../core/utils.js';

class WebSocketServer {
  constructor(server) {
    this.wss = new WSS({ server });
    this.clients = new Map(); // 存储客户端连接
    this.redisClient = null;
    this.init();
  }

  async init() {
    this.redisClient = await getRedis();
    this.setupEventListeners();
    this.setupHeartbeatChecker();
  }

  setupEventListeners() {
    this.wss.on('connection', (ws, req) => {
      const urlParams = new URLSearchParams(req.url.split('?')[1]);
      const agentId = urlParams.get('agent_id');
      
      if (!agentId) {
        ws.close(4001, 'Missing agent_id');
        return;
      }

      ws.agentId = agentId;
      const forwarded = req.headers['x-forwarded-for'];
      ws._clientIp = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
      this.clients.set(agentId, ws);
      
      console.log(`Agent ${agentId} connected`);

      // 处理消息
      ws.on('message', async (message) => {
        await this.handleMessage(ws, message);
      });

      // 处理关闭
      ws.on('close', () => {
        this.handleClose(agentId);
      });

      // 处理错误
      ws.on('error', (error) => {
        console.error(`WebSocket error for agent ${agentId}:`, error);
      });
    });
  }

  async handleMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'AUTH':
          await this.handleAuth(ws, data);
          break;
        case 'MESSAGE':
          await this.handleMessageSend(ws, data);
          break;
        case 'BROADCAST':
          await this.handleBroadcast(ws, data);
          break;
        case 'HEARTBEAT':
          await this.handleHeartbeat(ws, data);
          break;
        default:
          ws.send(JSON.stringify(formatResponse(false, null, 'Unknown message type')));
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
      ws.send(JSON.stringify(formatResponse(false, null, 'Invalid message format')));
    }
  }

  async handleAuth(ws, data) {
    const { agent_id, signature, timestamp } = data;

    if (agent_id !== ws.agentId) {
      ws.close(4002, 'Agent ID mismatch');
      return;
    }

    // 重放防护：AUTH 签名材料包含 timestamp，超出窗口即拒绝
    if (!isTimestampFresh(timestamp)) {
      ws.close(4005, 'Signature timestamp expired');
      return;
    }

    // 获取节点信息
    const nodeResult = await getNode(agent_id);
    if (!nodeResult.success) {
      ws.close(4003, 'Agent not found');
      return;
    }

    // 验证签名
    const authData = JSON.stringify({ agent_id, timestamp });
    if (!verifySignature(authData, signature, nodeResult.data.public_key)) {
      ws.close(4004, 'Invalid signature');
      return;
    }

    // 认证成功
    ws.authenticated = true;
    ws.send(JSON.stringify(formatResponse(true, { message: 'Authenticated' })));
    console.log(`Agent ${agent_id} authenticated`);
  }

  async handleMessageSend(ws, data) {
    if (!ws.authenticated) {
      ws.send(JSON.stringify(formatResponse(false, null, 'Not authenticated')));
      return;
    }

    const { to_agent_id, payload } = data;
    const targetWs = this.clients.get(to_agent_id);
    
    if (targetWs) {
      targetWs.send(JSON.stringify({
        type: 'MESSAGE',
        from_agent_id: ws.agentId,
        payload
      }));
      ws.send(JSON.stringify(formatResponse(true, { message: 'Message sent' })));
    } else {
      ws.send(JSON.stringify(formatResponse(false, null, 'Target agent not found')));
    }
  }

  async handleBroadcast(ws, data) {
    if (!ws.authenticated) {
      ws.send(JSON.stringify(formatResponse(false, null, 'Not authenticated')));
      return;
    }

    const { payload } = data;
    this.wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WSS.OPEN) {
        client.send(JSON.stringify({
          type: 'BROADCAST',
          from_agent_id: ws.agentId,
          payload
        }));
      }
    });
    ws.send(JSON.stringify(formatResponse(true, { message: 'Broadcast sent' })));
  }

  async handleHeartbeat(ws, data) {
    const { agent_id } = data;
    if (agent_id !== ws.agentId) {
      return;
    }
    
    const result = await handleHeartbeat(agent_id, ws._clientIp);
    ws.send(JSON.stringify(result));
  }

  handleClose(agentId) {
    this.clients.delete(agentId);
    console.log(`Agent ${agentId} disconnected`);
    // 更新节点状态
    updateNodeStatus(agentId, 'offline');
  }

  setupHeartbeatChecker() {
    setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
  }
}

export default WebSocketServer;