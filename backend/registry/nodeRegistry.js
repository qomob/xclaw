// 节点注册管理文件
import { getPostgres, getRedis } from '../core/dependencies.js';
import { generateUUID, verifySignature, formatResponse, isTimestampFresh, signaturePayload } from '../core/utils.js';
import config from '../core/config.js';
import logger from '../services/loggerService.js';
import authService from '../services/authService.js';
import topologyService from '../services/topologyService.js';
import { generateEmbedding } from '../services/aiService.js';
import { insertOrUpdateEmbedding } from '../services/databaseService.js';
import { lookup } from '../core/geoip.js';
import { searchAgentsByIntent } from '../services/searchEngine.js';
import eventBus from '../services/eventBus.js';

// timestamp：可选。携带时签名材料为 `timestamp:body` 且强制新鲜（防重放）；
// 未携带时兼容旧格式（仅 body），由调用方（api.js）记录废弃告警。
export async function registerNode(nodeData, signature, clientIp, timestamp) {
  const pgPool = getPostgres();
  const redisClient = getRedis();

  try {
    // 验证签名
    const dataString = timestamp !== undefined
      ? signaturePayload(timestamp, nodeData)
      : JSON.stringify(nodeData);
    if (timestamp !== undefined && !isTimestampFresh(timestamp)) {
      return formatResponse(false, null, '签名时间戳过期或无效');
    }
    if (!verifySignature(dataString, signature, nodeData.public_key)) {
      return formatResponse(false, null, '签名验证失败');
    }
    
    // 生成节点 ID（基于公钥哈希）
    const nodeId = generateUUID(nodeData.public_key);

    let latitude = nodeData.latitude ?? null;
    let longitude = nodeData.longitude ?? null;

    if (latitude == null || longitude == null) {
      if (clientIp) {
        const geo = lookup(clientIp);
        if (geo) {
          latitude = geo.latitude;
          longitude = geo.longitude;
          console.log(`[register] GeoIP: ${clientIp} → ${geo.city || 'Unknown'} (${latitude}, ${longitude})`);
        } else {
          console.warn(`[register] GeoIP lookup failed for IP: ${clientIp}`);
        }
      }
      if (latitude == null || longitude == null) {
        latitude = config.geo.defaultLatitude;
        longitude = config.geo.defaultLongitude;
        console.warn(`[register] No coordinates available, using defaults: (${latitude}, ${longitude})`);
      }
    } else {
      console.log(`[register] Using provided coords: (${latitude}, ${longitude}), IP: ${clientIp}`);
    }
    
    // 检查节点是否已存在
    const existingNode = await pgPool.query(
      'SELECT node_id FROM nodes WHERE node_id = $1',
      [nodeId]
    );
    
    const tagsJson = JSON.stringify(nodeData.tags || []);

    if (existingNode.rows.length > 0) {
      await pgPool.query(
        `UPDATE nodes SET 
         name = $1, 
         capabilities = $2, 
         tags = $3, 
         endpoint_url = $4, 
         latitude = $5, 
         longitude = $6, 
         status = 'online', 
         last_heartbeat = NOW(), 
         updated_at = NOW() 
         WHERE node_id = $7`,
        [
          nodeData.agent_name,
          nodeData.capabilities,
          tagsJson,
          nodeData.endpoint_url,
          latitude,
          longitude,
          nodeId
        ]
      );
    } else {
      await pgPool.query(
        `INSERT INTO nodes (
         node_id, name, capabilities, tags, public_key, endpoint_url, 
         latitude, longitude, status, last_heartbeat
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          nodeId,
          nodeData.agent_name,
          nodeData.capabilities,
          tagsJson,
          nodeData.public_key,
          nodeData.endpoint_url,
          latitude,
          longitude,
          'online',
          new Date()
        ]
      );
    }
    
    // 生成并存入能力向量（语义搜索依赖 node_embeddings；失败不阻断注册）
    try {
      const capabilitiesText = nodeData.capabilities || nodeData.capabilities_summary || '';
      if (capabilitiesText.trim()) {
        const vector = await generateEmbedding(capabilitiesText);
        if (Array.isArray(vector) && vector.length > 0) {
          await insertOrUpdateEmbedding(nodeId, `[${vector.join(',')}]`);
          logger.info('Capability vector stored', { nodeId, dims: vector.length });
        }
      }
    } catch (embedError) {
      logger.warn('Capability vector generation skipped', { nodeId, error: embedError.message });
    }

    // 缓存节点信息到 Redis
    await redisClient.hset(
      `node:${nodeId}`,
      {
        id: nodeId,
        name: nodeData.agent_name,
        status: 'online',
        last_heartbeat: new Date().toISOString(),
        lat: String(latitude),
        lng: String(longitude)
      }
    );
    
    // 设置节点在线状态
    await redisClient.sadd('online_nodes', nodeId);
    
    // 同步到 topologyService
    topologyService.addNode({
      id: nodeId,
      name: nodeData.agent_name,
      status: 'online',
      tags: nodeData.tags || [],
      group: Math.floor(Math.random() * 4) + 1,
      val: Math.floor(Math.random() * 10) + 5,
      lat: latitude,
      lng: longitude
    });
    
    let wsUrl;
    if (config.server.wsPublicUrl) {
      wsUrl = `${config.server.wsPublicUrl}/ws`;
    } else if (config.server.publicUrl) {
      const protocol = config.server.publicUrl.startsWith('https') ? 'wss' : 'ws';
      wsUrl = `${protocol}://${config.server.publicUrl.replace(/^https?:\/\//, '')}/ws`;
    } else {
      wsUrl = `ws://localhost:${config.server.port}/ws`;
    }

    authService.registerAgent(nodeId, nodeData.public_key);

    // 生成 API key 用于认证。哈希存储后无法回显存量 Key——
    // 重注册视为凭据轮换：吊销旧 Key（可能为哈希或历史明文）并签发新 Key
    const existing = await redisClient.get(`agent_apikey:${nodeId}`);
    if (existing) {
      if (/^[0-9a-f]{64}$/.test(existing)) {
        await redisClient.del(`apikey_hash:${existing}`);
      } else {
        await redisClient.del(`apikey:${existing}`);
      }
      await redisClient.del(`agent_apikey:${nodeId}`);
      logger.info('Rotating agent API key on re-registration', { nodeId });
    }
    const apiKey = await authService.generateApiKey(nodeId);

    eventBus.emit('agent.registered', { node_id: nodeId, name: nodeData.agent_name, capabilities: nodeData.capabilities }, { sourceId: nodeId });
    return formatResponse(true, {
      agent_id: nodeId,
      status: 'registered',
      websocket_url: wsUrl,
      api_key: apiKey
    });
  } catch (error) {
    console.error('节点注册错误:', error);
    return formatResponse(false, null, '节点注册失败');
  }
}

// 获取节点信息
export async function getNode(nodeId) {
  const pgPool = getPostgres();
  
  try {
    const result = await pgPool.query(
      'SELECT * FROM nodes WHERE node_id = $1',
      [nodeId]
    );
    
    if (result.rows.length === 0) {
      return formatResponse(false, null, '节点不存在');
    }
    
    return formatResponse(true, result.rows[0]);
  } catch (error) {
    console.error('获取节点信息错误:', error);
    return formatResponse(false, null, '获取节点信息失败');
  }
}

// 发现节点
export async function discoverNodes(query, tags, limit = 5) {
  try {
    if (query && query.trim().length > 0) {
      const semanticResults = await searchAgentsByIntent(query);
      if (semanticResults.length > 0) {
        return formatResponse(true, semanticResults.map(r => ({
          id: r.id,
          name: r.name,
          tags: [],
          match_reason: `语义匹配 (距离: ${r.distance.toFixed(4)})`
        })));
      }
    }

    const pgPool = getPostgres();
    
    let sql = 'SELECT node_id, name, tags, capabilities FROM nodes WHERE status = \'online\'';
    const params = [];
    
    if (tags && tags.length > 0) {
      // nodes.tags 是 jsonb 数组：用 ?|（存在任一元素）而非 &&（text[] 运算符，对 jsonb 不存在）
      sql += ' AND tags ?| $' + (params.length + 1) + '::text[]';
      params.push(tags);
    }
    
    sql += ' LIMIT $' + (params.length + 1);
    params.push(limit);
    
    const result = await pgPool.query(sql, params);
    
    const nodes = result.rows.map(node => ({
      id: node.node_id,
      name: node.name,
      tags: node.tags,
      match_reason: query ? `Tags match: ${query}` : 'Online node'
    }));
    
    return formatResponse(true, nodes);
  } catch (error) {
    console.error('发现节点错误:', error);
    return formatResponse(false, null, '发现节点失败');
  }
}

// 更新节点状态
export async function updateNodeStatus(nodeId, status) {
  const pgPool = getPostgres();
  const redisClient = getRedis();
  
  try {
    await pgPool.query(
      'UPDATE nodes SET status = $1, updated_at = NOW() WHERE node_id = $2',
      [status, nodeId]
    );
    
    // 更新 Redis 缓存
    await redisClient.hset(`node:${nodeId}`, 'status', status);
    
    if (status === 'online') {
      await redisClient.sadd('online_nodes', nodeId);
    } else {
      await redisClient.srem('online_nodes', nodeId);
    }
    
    topologyService.updateNode(nodeId, { status });
    
    return formatResponse(true, { status });
  } catch (error) {
    console.error('更新节点状态错误:', error);
    return formatResponse(false, null, '更新节点状态失败');
  }
}

// 处理节点心跳
export async function handleHeartbeat(nodeId, clientIp) {
  const pgPool = getPostgres();
  const redisClient = getRedis();
  
  try {
    const now = new Date();
    
    let extraUpdate = '';
    const params = [now, now, nodeId];
    
    if (clientIp) {
      const existing = await pgPool.query(
        'SELECT latitude, longitude FROM nodes WHERE node_id = $1',
        [nodeId]
      );
      if (existing.rows.length > 0) {
        const lat = Number(existing.rows[0].latitude);
        const lng = Number(existing.rows[0].longitude);
        if ((lat === 0 && lng === 0) || (Number.isNaN(lat) || Number.isNaN(lng))) {
          const geo = lookup(clientIp);
          if (geo) {
            extraUpdate = ', latitude = $4, longitude = $5';
            params.push(geo.latitude, geo.longitude);
            await redisClient.hset(`node:${nodeId}`, { lat: String(geo.latitude), lng: String(geo.longitude) });
            topologyService.updateNode(nodeId, { lat: geo.latitude, lng: geo.longitude });
          }
        }
      }
    }
    
    await pgPool.query(
      `UPDATE nodes SET status = 'online', last_heartbeat = $1, updated_at = $2${extraUpdate} WHERE node_id = $3`,
      params
    );
    
    // 更新 Redis 缓存
    await redisClient.hset(
      `node:${nodeId}`,
      {
        status: 'online',
        last_heartbeat: now.toISOString()
      }
    );
    
    // 确保节点在在线集合中
    await redisClient.sadd('online_nodes', nodeId);
    
    return formatResponse(true, { status: 'online', last_heartbeat: now });
  } catch (error) {
    console.error('处理心跳错误:', error);
    return formatResponse(false, null, '处理心跳失败');
  }
}

// 删除节点
export async function deleteNode(nodeId) {
  const pgPool = getPostgres();
  const redisClient = getRedis();
  
  try {
    // 删除相关技能
    await pgPool.query('DELETE FROM skills WHERE node_id = $1', [nodeId]);
    
    // 删除节点
    await pgPool.query('DELETE FROM nodes WHERE node_id = $1', [nodeId]);
    
    // 删除 Redis 缓存
    await redisClient.del(`node:${nodeId}`);
    await redisClient.srem('online_nodes', nodeId);
    
    await topologyService.publishDelete(nodeId);
    
    return formatResponse(true, { message: '节点删除成功' });
  } catch (error) {
    console.error('删除节点错误:', error);
    return formatResponse(false, null, '删除节点失败');
  }
}

// 获取所有在线节点
export async function getOnlineNodes() {
  const redisClient = getRedis();
  
  try {
    const nodeIds = await redisClient.smembers('online_nodes');
    const nodes = [];
    
    for (const nodeId of nodeIds) {
      const nodeInfo = await redisClient.hgetall(`node:${nodeId}`);
      if (nodeInfo) {
        nodes.push(nodeInfo);
      }
    }
    
    return formatResponse(true, nodes);
  } catch (error) {
    console.error('获取在线节点错误:', error);
    return formatResponse(false, null, '获取在线节点失败');
  }
}
