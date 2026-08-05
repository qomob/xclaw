// 心跳管理文件
import { getPostgres, getRedis } from '../core/dependencies.js';
import { updateNodeStatus } from '../registry/nodeRegistry.js';
import logger from '../services/loggerService.js';

export default class HeartbeatManager {
  constructor() {
    this.redisClient = null;
    this.heartbeatInterval = null;
  }

  setWsConnections(wsConnections) {
    this.wsConnections = wsConnections;
  }

  async init() {
    this.redisClient = await getRedis();
    this.startHeartbeatChecker();
  }

  startHeartbeatChecker() {
    this.heartbeatInterval = setInterval(async () => {
      await this.checkNodeHeartbeats();
    }, 30000);

    logger.info('Heartbeat checker started');
  }

  async checkNodeHeartbeats() {
    const pgPool = await getPostgres();
    
    try {
      const nodes = await pgPool.query(
        'SELECT node_id, last_heartbeat FROM nodes WHERE status = \'online\''
      );

      const now = new Date();
      const timeoutThreshold = 60000;

      for (const node of nodes.rows) {
        const lastHeartbeat = new Date(node.last_heartbeat);
        const timeSinceHeartbeat = now - lastHeartbeat;

        if (timeSinceHeartbeat > timeoutThreshold) {
          await updateNodeStatus(node.node_id, 'offline');
          logger.info('Node marked offline due to heartbeat timeout', { nodeId: node.node_id });
        }
      }
    } catch (error) {
      logger.error('Error checking node heartbeats', { error: error.message });
    }
  }

  // 处理节点心跳
  async handleNodeHeartbeat(nodeId) {
    try {
      // 更新节点心跳时间
      const pgPool = await getPostgres();
      const now = new Date();

      await pgPool.query(
        'UPDATE nodes SET last_heartbeat = $1, status = \'online\' WHERE node_id = $2',
        [now, nodeId]
      );

      // 更新 Redis 缓存
      await this.redisClient.hset(
        `node:${nodeId}`,
        'last_heartbeat',
        now.toISOString()
      );

      return true;
    } catch (error) {
      logger.error('Error handling node heartbeat', { error: error.message, nodeId });
      return false;
    }
  }

  // 停止心跳检查
  stop() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      logger.info('Heartbeat checker stopped');
    }
  }
}
