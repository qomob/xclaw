import { getRedis, getPostgres } from '../core/dependencies.js';
import { instanceId } from '../core/instance.js';
import logger from './loggerService.js';

const TOPO_SET = 'topology:nodes';
const TOPO_EVENTS = 'xclaw:topology:events';
// 拓扑缓存键 TTL:兜底防孤儿(绕过 API 的 DB 删除会让缓存永久残留,
// 重启后幽灵节点复活)。正常节点注册时刷新 TTL。
const CACHE_TTL_SECONDS = parseInt(process.env.TOPOLOGY_CACHE_TTL_SECONDS || '604800');

class TopologyService {
  constructor() {
    this.state = {
      nodes: [],
      links: []
    };
    this._pub = null;
    this._sub = null;
    this._initialized = false;
  }

  /**
   * 初始化 Redis 发布/订阅桥（跨实例拓扑同步）
   */
  async init() {
    if (this._initialized) return;
    this._pub = getRedis();
    this._sub = getRedis().duplicate();
    this._sub.on('message', (channel, message) => {
      if (channel !== TOPO_EVENTS) return;
      try {
        const event = JSON.parse(message);
        if (event.instance === instanceId) return; // 自己发布的消息已本地应用
        if (event.delete) {
          this.removeNode(event.delete);
        } else {
          if (event.node) this.addNode(event.node);
          if (Array.isArray(event.links) && event.links.length > 0) this.addLinks(event.links);
        }
      } catch (err) {
        logger.warn('[Topology] Event parse error', { error: err.message });
      }
    });
    await this._sub.subscribe(TOPO_EVENTS);
    this._initialized = true;
    logger.info('[Topology] Redis bridge initialized', { instance: instanceId });
  }

  getState() {
    return this.state;
  }

  addNode(node) {
    const existing = this.state.nodes.findIndex(n => n.id === node.id);
    if (existing >= 0) {
      this.state.nodes[existing] = { ...this.state.nodes[existing], ...node };
      logger.debug('Node updated in topology state', { nodeId: node.id });
    } else {
      this.state.nodes.push(node);
      logger.debug('Node added to topology state', { nodeId: node.id });
    }
  }

  removeNode(nodeId) {
    this.state.nodes = this.state.nodes.filter(n => n.id !== nodeId);
    this.state.links = this.state.links.filter(
      l => l.source !== nodeId && l.target !== nodeId
    );
    logger.debug('Node removed from topology state', { nodeId });
  }

  updateNode(nodeId, data) {
    const idx = this.state.nodes.findIndex(n => n.id === nodeId);
    if (idx >= 0) {
      this.state.nodes[idx] = { ...this.state.nodes[idx], ...data };
      logger.debug('Node updated in topology state', { nodeId });
    }
  }

  addLinks(links) {
    this.state.links.push(...links);
    logger.debug('Links added to topology state', { count: links.length });
  }

  hasNode(nodeId) {
    return this.state.nodes.some(n => n.id === nodeId);
  }

  searchNodes(query, tags, limit) {
    let filteredNodes = this.state.nodes;

    if (tags && tags.length > 0) {
      filteredNodes = filteredNodes.filter(node =>
        tags.some(tag => node.tags && node.tags.includes(tag))
      );
    }

    if (query) {
      const queryLower = query.toLowerCase();
      filteredNodes = filteredNodes.filter(node =>
        node.name && node.name.toLowerCase().includes(queryLower) ||
        (node.tags && node.tags.some(tag => tag.toLowerCase().includes(queryLower)))
      );
    }

    return filteredNodes.slice(0, limit);
  }

  getNode(nodeId) {
    return this.state.nodes.find(n => n.id === nodeId);
  }

  _deriveGroup(info) {
    if (info.tags) {
      const tags = Array.isArray(info.tags) ? info.tags : JSON.parse(info.tags);
      if (tags.length > 0) {
        let hash = 0;
        for (const tag of tags) {
          for (let i = 0; i < tag.length; i++) {
            hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
          }
        }
        return (Math.abs(hash) % 4) + 1;
      }
    }
    const name = info.name || info.id;
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    }
    return (Math.abs(hash) % 4) + 1;
  }

  _deriveVal(info) {
    const linkCount = this.state.links.filter(
      l => l.source === info.id || l.target === info.id
    ).length;
    return linkCount + 5;
  }

  /**
   * 持久化节点到 Redis 并广播增量（本地应用 + 跨实例同步）
   */
  async publishUpdate(node, links = []) {
    if (!node || !node.id) return;
    this.addNode(node);
    if (links.length > 0) this.addLinks(links);
    try {
      await this._pub.sadd(TOPO_SET, node.id);
      // 序列化复杂字段（Redis HSET 会把对象 String() 化，需显式 JSON）
      await this._pub.hset(`topology:node:${node.id}`, {
        id: String(node.id),
        name: String(node.name || node.id),
        status: String(node.status || 'online'),
        tags: JSON.stringify(node.tags || []),
        lat: String(node.lat ?? 0),
        lng: String(node.lng ?? 0)
      });
      await this._pub.expire(`topology:node:${node.id}`, CACHE_TTL_SECONDS);
      await this._pub.publish(TOPO_EVENTS, JSON.stringify({ node, links, instance: instanceId }));
    } catch (err) {
      logger.warn('[Topology] publishUpdate failed', { error: err.message, nodeId: node.id });
    }
  }

  /**
   * 删除节点并广播删除事件
   */
  async publishDelete(nodeId) {
    this.removeNode(nodeId);
    try {
      await this._pub.srem(TOPO_SET, nodeId);
      await this._pub.del(`topology:node:${nodeId}`);
      await this._pub.publish(TOPO_EVENTS, JSON.stringify({ delete: nodeId, instance: instanceId }));
    } catch (err) {
      logger.warn('[Topology] publishDelete failed', { error: err.message, nodeId });
    }
  }

  /**
   * 从 Redis 加载持久化拓扑
   */
  async loadFromRedis(redisClient) {
    try {
      const nodeIds = await redisClient.smembers(TOPO_SET);
      let loaded = 0;
      for (const nodeId of nodeIds) {
        if (this.hasNode(nodeId)) continue;
        try {
          const info = await redisClient.hgetall(`topology:node:${nodeId}`);
          if (info && info.id) {
            this.state.nodes.push({
              id: info.id,
              name: info.name || info.id,
              status: info.status || 'online',
              tags: info.tags ? (Array.isArray(info.tags) ? info.tags : JSON.parse(info.tags)) : [],
              group: this._deriveGroup(info),
              val: this._deriveVal(info),
              lat: parseFloat(info.lat) || 0,
              lng: parseFloat(info.lng) || 0
            });
            loaded++;
            // 旧版本写入的键无 TTL,启动时统一刷新
            await redisClient.expire(`topology:node:${nodeId}`, CACHE_TTL_SECONDS);
          }
        } catch (parseErr) {
          logger.warn('[Topology] Skip unparseable node', { nodeId, error: parseErr.message });
        }
      }
      logger.info('Topology loaded from Redis', { total: nodeIds.length, loaded });
      await this._reconcileWithDatabase(nodeIds);
    } catch (error) {
      logger.error('Failed to load topology from Redis', { error: error.message });
    }
  }

  /**
   * 启动时与 DB 对账（拓扑事实源是 nodes 表）：
   * a) 清除缓存孤儿——绕过 API 的 DB 删除（手工清库等）留下的幽灵节点；
   * b) 补入 DB 有而缓存缺失的节点（缓存丢失/过期后自愈）。
   */
  async _reconcileWithDatabase(cacheNodeIds) {
    try {
      const { rows } = await getPostgres().query(
        'SELECT node_id, name, status, tags, latitude, longitude FROM nodes'
      );
      const dbIds = new Set(rows.map(r => String(r.node_id)));

      let removed = 0;
      for (const nodeId of cacheNodeIds) {
        if (!dbIds.has(String(nodeId))) {
          logger.info('[Topology] Reconcile: removing orphaned cache node (not in DB)', { nodeId });
          await this.publishDelete(nodeId);
          removed++;
        }
      }

      const cacheIds = new Set(cacheNodeIds.map(String));
      let added = 0;
      for (const r of rows) {
        const id = String(r.node_id);
        if (cacheIds.has(id) || this.hasNode(id)) continue;
        await this.publishUpdate({
          id,
          name: r.name,
          status: r.status || 'offline',
          tags: Array.isArray(r.tags) ? r.tags : [],
          lat: r.latitude ?? 0,
          lng: r.longitude ?? 0
        });
        added++;
      }

      if (removed > 0 || added > 0) {
        logger.info('[Topology] DB reconciliation complete', { removed, added, total: this.state.nodes.length });
      }
    } catch (error) {
      // 对账失败不阻断启动——缓存仍可用，下轮重启再试
      logger.warn('[Topology] DB reconciliation failed', { error: error.message });
    }
  }
}

export default new TopologyService();
