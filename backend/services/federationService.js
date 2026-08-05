import { getPostgres, getRedis } from '../core/dependencies.js';
import logger from './loggerService.js';
import crossNetworkService from './crossChainService.js';
import { safeFetch } from '../core/httpGuard.js';
import { federationPath } from '../core/utils.js';

// ============================================
// 常量配置
// ============================================
const FEDERATION_PREFIX = 'xclaw:federation:';
const PEER_REGISTRY_KEY = `${FEDERATION_PREFIX}peers`;
const SYNC_PREFIX = `${FEDERATION_PREFIX}sync:`;
const HEALTH_CHECK_INTERVAL = 30000; // 30秒
const PEER_TIMEOUT_MS = 60000; // 60秒超时
const TOPOLOGY_SYNC_INTERVAL = 300000; // 5分钟
const MAX_HOPS = 5; // 最大转发跳数

/**
 * 联邦网络服务 — 管理多实例互联、节点发现、跨网任务路由
 */
class FederationService {
  constructor() {
    this.redis = null;
    this.pgPool = null;
    this.localNetworkId = process.env.NETWORK_ID || 'default';
    this.localEndpoint = process.env.LOCAL_ENDPOINT || '';
    this._healthTimer = null;
    this._syncTimer = null;
    this._initialized = false;
  }

  _getRedis() {
    if (!this.redis) this.redis = getRedis();
    return this.redis;
  }

  _getPg() {
    if (!this.pgPool) this.pgPool = getPostgres();
    return this.pgPool;
  }

  // ==========================================
  // 初始化
  // ==========================================

  /**
   * 初始化联邦服务
   */
  async init() {
    if (this._initialized) return;
    
    const redis = this._getRedis();
    
    // 注册本地网络
    await redis.hset(PEER_REGISTRY_KEY, this.localNetworkId, JSON.stringify({
      network_id: this.localNetworkId,
      endpoint: this.localEndpoint,
      status: 'active',
      last_seen: Date.now(),
      capabilities: await this._getLocalCapabilities(),
      node_count: await this._getLocalNodeCount()
    }));
    
    // 启动健康检查
    this._healthTimer = setInterval(() => this._healthCheck(), HEALTH_CHECK_INTERVAL);
    
    // 启动拓扑同步
    this._syncTimer = setInterval(() => this._syncTopology(), TOPOLOGY_SYNC_INTERVAL);
    
    this._initialized = true;
    logger.info('Federation service initialized', { 
      localNetworkId: this.localNetworkId,
      endpoint: this.localEndpoint 
    });
  }

  // ==========================================
  // 对等网络管理
  // ==========================================

  /**
   * 注册远程联邦节点
   * @param {string} networkId - 远程网络 ID
   * @param {string} endpoint - 远程端点 URL
   * @param {Object} metadata - 额外元数据
   * @returns {Object} 注册结果
   */
  async registerPeer(networkId, endpoint, metadata = {}) {
    if (networkId === this.localNetworkId) {
      return { success: false, error: 'Cannot register self as peer' };
    }

    const redis = this._getRedis();
    
    // 验证远端可达性（可选跳过）
    if (!metadata.skip_verify) {
      const isReachable = await this._checkPeerReachable(endpoint);
      if (!isReachable) {
        return { success: false, error: 'Peer endpoint is not reachable' };
      }
    }
    
    const peerInfo = {
      network_id: networkId,
      endpoint,
      status: 'active',
      last_seen: Date.now(),
      registered_at: Date.now(),
      capabilities: metadata.capabilities || [],
      node_count: metadata.node_count || 0,
      version: metadata.version || '1.0.0'
    };
    
    await redis.hset(PEER_REGISTRY_KEY, networkId, JSON.stringify(peerInfo));
    
    logger.info('Peer registered', { networkId, endpoint });
    
    return { success: true, data: peerInfo };
  }

  /**
   * 注销远程联邦节点
   * @param {string} networkId - 远程网络 ID
   */
  async unregisterPeer(networkId) {
    const redis = this._getRedis();
    await redis.hdel(PEER_REGISTRY_KEY, networkId);
    logger.info('Peer unregistered', { networkId });
    return { success: true };
  }

  /**
   * 列出所有联邦节点
   * @returns {Array} 联邦节点列表
   */
  async listPeers() {
    const redis = this._getRedis();
    const peers = await redis.hgetall(PEER_REGISTRY_KEY);
    
    const result = [];
    for (const [networkId, info] of Object.entries(peers)) {
      if (networkId === this.localNetworkId) continue;
      try {
        const parsed = JSON.parse(info);
        // 判断是否活跃（60秒内有心跳）
        parsed.is_alive = (Date.now() - parsed.last_seen) < PEER_TIMEOUT_MS * 2;
        result.push(parsed);
      } catch { /* skip invalid */ }
    }
    
    return { success: true, data: result };
  }

  /**
   * 获取联邦网络状态概览
   * @returns {Object} 联邦状态
   */
  async getFederationStatus() {
    const redis = this._getRedis();
    const pgPool = this._getPg();
    
    const allPeers = await redis.hgetall(PEER_REGISTRY_KEY);
    const peerCount = Object.keys(allPeers).filter(id => id !== this.localNetworkId).length;
    
    // 本地统计
    const localNodes = await pgPool.query('SELECT COUNT(*) as cnt FROM nodes WHERE status = $1', ['online']);
    const localSkills = await pgPool.query('SELECT COUNT(*) as cnt FROM skills');
    const localTasks = await pgPool.query('SELECT COUNT(*) FILTER (WHERE status = $1) as active FROM tasks', ['assigned']);
    
    // 远程统计
    let totalRemoteNodes = 0;
    let alivePeers = 0;
    for (const [networkId, info] of Object.entries(allPeers)) {
      if (networkId === this.localNetworkId) continue;
      try {
        const parsed = JSON.parse(info);
        if ((Date.now() - parsed.last_seen) < PEER_TIMEOUT_MS * 2) {
          alivePeers++;
          totalRemoteNodes += parsed.node_count || 0;
        }
      } catch { /* skip */ }
    }
    
    return {
      success: true,
      data: {
        local: {
          network_id: this.localNetworkId,
          endpoint: this.localEndpoint,
          online_nodes: parseInt(localNodes.rows[0].cnt),
          total_skills: parseInt(localSkills.rows[0].cnt),
          active_tasks: parseInt(localTasks.rows[0].active)
        },
        federation: {
          total_peers: peerCount,
          alive_peers: alivePeers,
          total_remote_nodes: totalRemoteNodes,
          total_network_size: parseInt(localNodes.rows[0].cnt) + totalRemoteNodes
        }
      }
    };
  }

  // ==========================================
  // 跨网任务路由
  // ==========================================

  /**
   * 跨网路由任务 — 在联邦网络中寻找最佳执行节点
   * @param {Object} taskData - 任务数据
   * @param {number} hops - 当前跳数（防环）
   * @returns {Object} 路由结果
   */
  async routeTaskFederated(taskData, hops = 0) {
    if (hops >= MAX_HOPS) {
      return { success: false, error: 'Max hops reached, terminating federation route' };
    }
    
    // 先尝试本地匹配
    const localMatches = await this._findLocalMatches(taskData);
    if (localMatches.length > 0) {
      return {
        success: true,
        data: {
          target: 'local',
          matches: localMatches,
          network_id: this.localNetworkId
        }
      };
    }
    
    // 本地无匹配，转发到联邦网络
    const peers = await this.listPeers();
    if (!peers.data || peers.data.length === 0) {
      return { success: false, error: 'No local matches and no federation peers available' };
    }
    
    // 按优先级排序远端（活跃 > 非活跃，节点数多 > 少）
    const alivePeers = peers.data
      .filter(p => p.is_alive)
      .sort((a, b) => (b.node_count || 0) - (a.node_count || 0));
    
    if (alivePeers.length === 0) {
      return { success: false, error: 'No alive federation peers' };
    }
    
    // 尝试向每个远端查询（并发）
    const remoteResults = await Promise.allSettled(
      alivePeers.map(peer => this._queryRemoteMatches(peer, taskData, hops))
    );
    
    // 合并结果
    const allMatches = [];
    for (const result of remoteResults) {
      if (result.status === 'fulfilled' && result.value?.success) {
        allMatches.push(...(result.value.data?.matches || []));
      }
    }
    
    if (allMatches.length === 0) {
      return { success: false, error: 'No matches found across federation' };
    }
    
    // 按匹配分排序
    allMatches.sort((a, b) => (b.match_score || 0) - (a.match_score || 0));
    
    return {
      success: true,
      data: {
        target: 'remote',
        matches: allMatches.slice(0, 5),
        searched_peers: alivePeers.length
      }
    };
  }

  /**
   * 分发任务到远端网络
   * @param {string} targetNetworkId - 目标网络 ID
   * @param {Object} taskData - 任务数据
   * @returns {Object} 分发结果
   */
  async dispatchTaskToPeer(targetNetworkId, taskData) {
    const redis = this._getRedis();
    const peerInfo = await redis.hget(PEER_REGISTRY_KEY, targetNetworkId);
    
    if (!peerInfo) {
      return { success: false, error: `Peer ${targetNetworkId} not found` };
    }
    
    const peer = JSON.parse(peerInfo);
    if (!peer.endpoint) {
      return { success: false, error: `Peer ${targetNetworkId} has no endpoint` };
    }
    
    try {
      const response = await safeFetch(`${peer.endpoint.replace(/\/+$/, '')}${federationPath('/v1/federation/task/receive')}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Federation-Source': this.localNetworkId,
          'X-Federation-Target': targetNetworkId,
          'X-Federation-Key': process.env.FEDERATION_KEY || process.env.API_KEY || ''
        },
        body: JSON.stringify({
          source_network: this.localNetworkId,
          task: taskData,
          hops: (taskData._hops || 0) + 1
        })
      }, 30000);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const result = await response.json();
      logger.info('Task dispatched to peer', { targetNetworkId, taskId: taskData.id });
      
      return result;
    } catch (error) {
      logger.error('Failed to dispatch task to peer', { 
        error: error.message, targetNetworkId, taskId: taskData.id 
      });
      return { success: false, error: error.message };
    }
  }

  // ==========================================
  // 拓扑同步
  // ==========================================

  /**
   * 请求远端网络的拓扑摘要
   * @param {string} networkId - 远端网络 ID
   * @returns {Object} 拓扑摘要
   */
  async requestTopologySync(networkId) {
    const redis = this._getRedis();
    const peerInfo = await redis.hget(PEER_REGISTRY_KEY, networkId);
    
    if (!peerInfo) {
      return { success: false, error: 'Peer not found' };
    }
    
    const peer = JSON.parse(peerInfo);
    
    try {
      const response = await safeFetch(`${peer.endpoint.replace(/\/+$/, '')}${federationPath('/v1/federation/topology/summary')}`, {
        method: 'GET',
        headers: {
          'X-Federation-Source': this.localNetworkId,
          'X-Federation-Key': process.env.FEDERATION_KEY || process.env.API_KEY || ''
        }
      }, 15000);
      
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const result = await response.json();
      
      // 缓存远端拓扑
      if (result.success && result.data) {
        await redis.set(
          `${SYNC_PREFIX}topology:${networkId}`,
          JSON.stringify(result.data),
          { EX: 3600 } // 1小时缓存
        );
      }
      
      return result;
    } catch (error) {
      logger.error('Topology sync failed', { error: error.message, networkId });
      return { success: false, error: error.message };
    }
  }

  /**
   * 生成本地拓扑摘要（供远端调用）
   * @returns {Object} 本地拓扑摘要
   */
  async getLocalTopologySummary() {
    const pgPool = this._getPg();
    
    const [nodes, skills, stats] = await Promise.all([
      pgPool.query(`
        SELECT node_id, name, capabilities, reputation_score, status, 
               latitude, longitude, total_earnings
        FROM nodes WHERE status = 'online'
      `),
      pgPool.query('SELECT id, name, category, description FROM skills'),
      pgPool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('open', 'pending')) as open_tasks,
          COUNT(*) FILTER (WHERE status = 'completed') as completed_tasks,
          COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_tasks,
          COUNT(*) as total_tasks,
          COALESCE(SUM(budget_min), 0) as total_budget_min,
          COALESCE(SUM(budget_max), 0) as total_budget_max
        FROM tasks
      `)
    ]);
    
    return {
      success: true,
      data: {
        network_id: this.localNetworkId,
        timestamp: Date.now(),
        nodes: nodes.rows.map(n => ({
          id: n.node_id,
          name: n.name,
          capabilities: typeof n.capabilities === 'string' ? JSON.parse(n.capabilities || '[]') : n.capabilities,
          reputation: n.reputation_score,
          location: { lat: n.latitude, lng: n.longitude }
        })),
        skills: skills.rows,
        stats: stats.rows[0]
      }
    };
  }

  // ==========================================
  // 内部方法
  // ==========================================

  async _healthCheck() {
    const redis = this._getRedis();
    
    try {
      // 更新本地心跳
      const localInfo = await redis.hget(PEER_REGISTRY_KEY, this.localNetworkId);
      if (localInfo) {
        const parsed = JSON.parse(localInfo);
        parsed.last_seen = Date.now();
        parsed.node_count = await this._getLocalNodeCount();
        await redis.hset(PEER_REGISTRY_KEY, this.localNetworkId, JSON.stringify(parsed));
      }
      
      // 检查远端活跃状态
      const peers = await redis.hgetall(PEER_REGISTRY_KEY);
      for (const [networkId, info] of Object.entries(peers)) {
        if (networkId === this.localNetworkId) continue;
        try {
          const parsed = JSON.parse(info);
          const elapsed = Date.now() - parsed.last_seen;
          if (elapsed > PEER_TIMEOUT_MS * 3) {
            // 标记为 inactive
            parsed.status = 'inactive';
            await redis.hset(PEER_REGISTRY_KEY, networkId, JSON.stringify(parsed));
          }
        } catch { /* skip */ }
      }
    } catch (error) {
      logger.error('Federation health check failed', { error: error.message });
    }
  }

  async _syncTopology() {
    try {
      const peers = await this.listPeers();
      const alivePeers = (peers.data || []).filter(p => p.is_alive);
      
      for (const peer of alivePeers) {
        await this.requestTopologySync(peer.network_id);
      }
      
      logger.debug('Topology sync completed', { peersSynced: alivePeers.length });
    } catch (error) {
      logger.error('Topology sync failed', { error: error.message });
    }
  }

  async _checkPeerReachable(endpoint) {
    try {
      const response = await safeFetch(`${endpoint.replace(/\/+$/, '')}${federationPath('/v1/federation/health')}`, {
        method: 'GET',
      }, 10000);
      return response.ok;
    } catch {
      return false;
    }
  }

  async _findLocalMatches(taskData) {
    const pgPool = this._getPg();
    const redis = this._getRedis();
    
    try {
      const onlineIds = await redis.smembers('online_nodes');
      if (onlineIds.length === 0) return [];
      
      const nodes = await pgPool.query(
        'SELECT node_id, name, reputation_score, capabilities FROM nodes WHERE node_id = ANY($1) AND status = $2',
        [onlineIds, 'online']
      );
      
      return nodes.rows.map(n => ({
        node_id: n.node_id,
        name: n.name,
        reputation: n.reputation_score,
        network_id: this.localNetworkId,
        match_score: 50 // 基础分，实际应由匹配引擎计算
      }));
    } catch {
      return [];
    }
  }

  async _queryRemoteMatches(peer, taskData, hops) {
    try {
      const response = await safeFetch(`${peer.endpoint.replace(/\/+$/, '')}${federationPath('/v1/federation/task/match')}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Federation-Source': this.localNetworkId,
          'X-Federation-Key': process.env.FEDERATION_KEY || process.env.API_KEY || ''
        },
        body: JSON.stringify({ task: taskData, hops: hops + 1 })
      }, 15000);
      
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      logger.warn('Remote match query failed', { 
        error: error.message, peer: peer.network_id 
      });
      return { success: false, error: error.message };
    }
  }

  async _getLocalCapabilities() {
    try {
      const pgPool = this._getPg();
      const result = await pgPool.query('SELECT DISTINCT category FROM skills');
      return result.rows.map(r => r.category).filter(Boolean);
    } catch {
      return [];
    }
  }

  async _getLocalNodeCount() {
    try {
      const pgPool = this._getPg();
      const result = await pgPool.query('SELECT COUNT(*) as cnt FROM nodes WHERE status = $1', ['online']);
      return parseInt(result.rows[0].cnt);
    } catch {
      return 0;
    }
  }

  /**
   * 接收远端发来的任务匹配查询
   */
  async handleMatchQuery(taskData, sourceNetwork) {
    const matches = await this._findLocalMatches(taskData);
    return {
      success: true,
      data: {
        network_id: this.localNetworkId,
        matches
      }
    };
  }

  /**
   * 接收远端发来的任务
   */
  async handleIncomingTask(taskData, sourceNetwork) {
    const pgPool = this._getPg();
    
    try {
      const taskId = crypto.randomUUID();
      await pgPool.query(
        `INSERT INTO tasks (id, type, title, description, status, payload, priority, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, now(), now())`,
        [
          taskId,
          taskData.type || 'federated',
          taskData.title || `Federated task from ${sourceNetwork}`,
          taskData.description || '',
          { ...taskData.payload, _source_network: sourceNetwork, _federated: true },
          taskData.priority || 5
        ]
      );
      
      logger.info('Federated task received', { taskId, sourceNetwork });
      
      return { success: true, data: { task_id: taskId } };
    } catch (error) {
      logger.error('Failed to handle incoming federated task', { error: error.message });
      return { success: false, error: error.message };
    }
  }
}

export default new FederationService();
