import logger from './loggerService.js';

class TopologyService {
  constructor() {
    this.state = {
      nodes: [],
      links: []
    };
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
      const tags = JSON.parse(info.tags);
      if (Array.isArray(tags) && tags.length > 0) {
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

  async loadFromRedis(redisClient) {
    try {
      const nodeIds = await redisClient.smembers('online_nodes');
      let loaded = 0;
      for (const nodeId of nodeIds) {
        if (this.hasNode(nodeId)) continue;
        const info = await redisClient.hgetall(`node:${nodeId}`);
        if (info && info.id) {
          this.state.nodes.push({
            id: info.id,
            name: info.name || info.id,
            status: info.status || 'online',
            tags: info.tags ? JSON.parse(info.tags) : [],
            group: this._deriveGroup(info),
            val: this._deriveVal(info),
            lat: parseFloat(info.lat) || 0,
            lng: parseFloat(info.lng) || 0
          });
          loaded++;
        }
      }
      logger.info('Topology loaded from Redis', { total: nodeIds.length, loaded });
    } catch (error) {
      logger.error('Failed to load topology from Redis', { error: error.message });
    }
  }
}

export default new TopologyService();
