// MCP 协议适配层 — 核心服务
import { getPostgres, getRedis } from '../core/dependencies.js';
import { generateUUID, formatResponse } from '../core/utils.js';
import logger from './loggerService.js';
import eventBus from './eventBus.js';
import { safeFetch } from '../core/httpGuard.js';

// ============================================
// Table initialization
// ============================================
let _tablesInitialized = false;

// Test-only reset
export function __resetForTesting() {
  _tablesInitialized = false;
}

async function ensureTables() {
  if (_tablesInitialized) return;
  const pg = getPostgres();
  await pg.query(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      endpoint VARCHAR(500) NOT NULL,
      description TEXT,
      capabilities JSONB DEFAULT '{}',
      auth_type VARCHAR(50) DEFAULT 'none',
      auth_config JSONB DEFAULT '{}',
      status VARCHAR(50) DEFAULT 'active',
      last_health_check TIMESTAMP,
      registered_by UUID,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS mcp_invocation_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      server_id UUID REFERENCES mcp_servers(id),
      tool_name VARCHAR(255),
      params JSONB,
      result JSONB,
      status VARCHAR(50),
      caller_id UUID,
      duration_ms INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  _tablesInitialized = true;
}

// ============================================
// JSON-RPC request ID counter
// ============================================
let _rpcId = 0;
function nextRpcId() {
  return ++_rpcId;
}

// ============================================
// Helper: build auth headers for external MCP call
// ============================================
function buildAuthHeaders(server) {
  const headers = { 'Content-Type': 'application/json' };
  if (!server || server.auth_type === 'none') return headers;
  const cfg = server.auth_config || {};
  switch (server.auth_type) {
    case 'bearer':
      if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;
      break;
    case 'api_key':
      if (cfg.header_name && cfg.api_key) {
        headers[cfg.header_name] = cfg.api_key;
      } else if (cfg.api_key) {
        headers['X-API-Key'] = cfg.api_key;
      }
      break;
    case 'basic':
      if (cfg.username && cfg.password) {
        headers['Authorization'] = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
      }
      break;
    default:
      break;
  }
  return headers;
}

// ============================================
// MCP Tool Definition 生成
// ============================================
export async function generateToolDefinition(skillId) {
  try {
    await ensureTables();
    const pg = getPostgres();

    const { rows } = await pg.query(
      'SELECT id, name, description, category, version, input_schema, output_schema, node_id FROM skills WHERE id = $1',
      [skillId]
    );

    if (rows.length === 0) {
      return formatResponse(false, null, 'Skill not found');
    }

    const skill = rows[0];

    // Build MCP-compliant Tool Definition
    const toolDef = {
      name: skill.name,
      description: skill.description || '',
      inputSchema: skill.input_schema || {
        type: 'object',
        properties: {},
        required: []
      },
      annotations: {
        category: skill.category || 'general',
        version: skill.version || '1.0.0',
        source_skill_id: skill.id,
        source_node_id: skill.node_id,
      }
    };

    // Include output schema if available
    if (skill.output_schema) {
      toolDef.outputSchema = skill.output_schema;
    }

    return formatResponse(true, toolDef);
  } catch (error) {
    logger.error('[MCP] generateToolDefinition error:', error);
    return formatResponse(false, null, error.message);
  }
}

// ============================================
// 注册外部 MCP Server
// ============================================
export async function registerMCPServer(serverData, registeredBy) {
  try {
    await ensureTables();
    const pg = getPostgres();
    const redis = getRedis();

    if (!serverData.name || !serverData.endpoint) {
      return formatResponse(false, null, 'name and endpoint are required');
    }

    const result = await pg.query(
      `INSERT INTO mcp_servers (name, endpoint, description, capabilities, auth_type, auth_config, registered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        serverData.name,
        serverData.endpoint,
        serverData.description || null,
        JSON.stringify(serverData.capabilities || {}),
        serverData.auth_type || 'none',
        JSON.stringify(serverData.auth_config || {}),
        registeredBy || null,
      ]
    );

    const server = result.rows[0];

    // Cache in Redis
    await redis.hset(
      `mcp:server:${server.id}`,
      'id', server.id,
      'name', server.name,
      'endpoint', server.endpoint,
      'status', server.status,
      'capabilities', JSON.stringify(server.capabilities || {})
    );
    await redis.sadd('mcp:servers:active', server.id);

    // Emit event
    eventBus.emit('mcp:server:registered', { serverId: server.id, name: server.name });

    logger.info(`[MCP] Server registered: ${server.id} (${server.name})`);
    return formatResponse(true, server);
  } catch (error) {
    logger.error('[MCP] registerMCPServer error:', error);
    return formatResponse(false, null, error.message);
  }
}

// ============================================
// 获取 MCP Server 信息
// ============================================
export async function getMCPServer(serverId) {
  try {
    await ensureTables();
    const redis = getRedis();

    // Try Redis cache first
    const cached = await redis.hgetall(`mcp:server:${serverId}`);
    if (cached && cached.id) {
      // Parse capabilities from string
      if (typeof cached.capabilities === 'string') {
        cached.capabilities = JSON.parse(cached.capabilities);
      }
      return formatResponse(true, cached);
    }

    // Fallback to DB
    const pg = getPostgres();
    const { rows } = await pg.query('SELECT * FROM mcp_servers WHERE id = $1', [serverId]);

    if (rows.length === 0) {
      return formatResponse(false, null, 'MCP Server not found');
    }

    const server = rows[0];

    // Update Redis cache
    await redis.hset(
      `mcp:server:${server.id}`,
      'id', server.id,
      'name', server.name,
      'endpoint', server.endpoint,
      'status', server.status,
      'capabilities', JSON.stringify(server.capabilities || {})
    );

    return formatResponse(true, server);
  } catch (error) {
    logger.error('[MCP] getMCPServer error:', error);
    return formatResponse(false, null, error.message);
  }
}

// ============================================
// 列出已注册 MCP Server
// ============================================
export async function listMCPServers(filters = {}) {
  try {
    await ensureTables();
    const pg = getPostgres();

    const conditions = [];
    const values = [];
    let paramIdx = 1;

    if (filters.status) {
      conditions.push(`status = $${paramIdx++}`);
      values.push(filters.status);
    }

    if (filters.search) {
      conditions.push(`(name ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`);
      values.push(`%${filters.search}%`);
      paramIdx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(parseInt(filters.limit) || 20, 1), 100);
    const offset = Math.max(parseInt(filters.offset) || 0, 0);

    const { rows } = await pg.query(
      `SELECT * FROM mcp_servers ${where} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      [...values, limit, offset]
    );

    return formatResponse(true, rows);
  } catch (error) {
    logger.error('[MCP] listMCPServers error:', error);
    return formatResponse(false, null, error.message);
  }
}

// ============================================
// 注销 MCP Server
// ============================================
export async function unregisterMCPServer(serverId) {
  try {
    await ensureTables();
    const pg = getPostgres();
    const redis = getRedis();

    const { rowCount } = await pg.query('DELETE FROM mcp_servers WHERE id = $1', [serverId]);

    if (rowCount === 0) {
      return formatResponse(false, null, 'MCP Server not found');
    }

    // Remove from Redis
    await redis.hdel(`mcp:server:${serverId}`, 'id', 'name', 'endpoint', 'status', 'capabilities');
    await redis.srem('mcp:servers:active', serverId);

    // Emit event
    eventBus.emit('mcp:server:unregistered', { serverId });

    logger.info(`[MCP] Server unregistered: ${serverId}`);
    return formatResponse(true, { deleted: true });
  } catch (error) {
    logger.error('[MCP] unregisterMCPServer error:', error);
    return formatResponse(false, null, error.message);
  }
}

// ============================================
// 发现 MCP Server（按能力搜索）
// ============================================
export async function discoverMCPServers(capabilities, limit = 10) {
  try {
    await ensureTables();
    const pg = getPostgres();

    if (!capabilities || (Array.isArray(capabilities) && capabilities.length === 0)) {
      const { rows } = await pg.query(
        'SELECT * FROM mcp_servers WHERE status = $1 ORDER BY created_at DESC LIMIT $2',
        ['active', limit]
      );
      return formatResponse(true, rows);
    }

    const capArray = Array.isArray(capabilities) ? capabilities : [capabilities];
    // Use JSONB containment operator
    const { rows } = await pg.query(
      `SELECT * FROM mcp_servers
       WHERE status = 'active'
         AND capabilities @> ANY($1::jsonb[])
       ORDER BY created_at DESC
       LIMIT $2`,
      [capArray.map(c => JSON.stringify(typeof c === 'string' ? { [c]: true } : c)), limit]
    );

    return formatResponse(true, rows);
  } catch (error) {
    logger.error('[MCP] discoverMCPServers error:', error);
    return formatResponse(false, null, error.message);
  }
}

// ============================================
// 调用外部 MCP Server 的工具
// ============================================
export async function invokeMCPTool(serverId, toolName, params, callerId) {
  const startTime = Date.now();
  let server = null;

  try {
    await ensureTables();
    const pg = getPostgres();

    // 1. Find server info
    const serverResult = await getMCPServer(serverId);
    if (!serverResult.success) {
      return formatResponse(false, null, 'MCP Server not found');
    }
    server = serverResult.data;

    if (server.status !== 'active') {
      return formatResponse(false, null, 'MCP Server is not active');
    }

    // 2. Construct JSON-RPC 2.0 request
    const rpcRequest = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: params || {},
      },
      id: nextRpcId(),
    };

    // 3. Send to server endpoint
    const headers = buildAuthHeaders(server);
    const response = await safeFetch(server.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(rpcRequest),
    }, 30000);

    const durationMs = Date.now() - startTime;
    const responseBody = await response.json();

    let invocationStatus = 'success';
    let resultData = null;

    if (response.ok && !responseBody.error) {
      resultData = responseBody.result || responseBody;
    } else {
      invocationStatus = 'error';
      resultData = responseBody.error || { message: `HTTP ${response.status}` };
    }

    // 4. Log invocation
    try {
      await pg.query(
        `INSERT INTO mcp_invocation_logs (server_id, tool_name, params, result, status, caller_id, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          serverId,
          toolName,
          JSON.stringify(params || {}),
          JSON.stringify(resultData),
          invocationStatus,
          callerId || null,
          durationMs,
        ]
      );
    } catch (logErr) {
      logger.warn('[MCP] Failed to log invocation:', logErr.message);
    }

    // 5. Return result
    if (invocationStatus === 'success') {
      return formatResponse(true, { result: resultData, duration_ms: durationMs });
    } else {
      return formatResponse(false, null, typeof resultData === 'string' ? resultData : resultData.message || 'Tool invocation failed');
    }
  } catch (error) {
    const durationMs = Date.now() - startTime;

    // Log failed invocation
    try {
      const pg = getPostgres();
      await pg.query(
        `INSERT INTO mcp_invocation_logs (server_id, tool_name, params, result, status, caller_id, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          serverId,
          toolName,
          JSON.stringify(params || {}),
          JSON.stringify({ error: error.message }),
          'error',
          callerId || null,
          durationMs,
        ]
      );
    } catch (logErr) {
      // Ignore log errors
    }

    logger.error('[MCP] invokeMCPTool error:', error);
    return formatResponse(false, null, error.message);
  }
}

// ============================================
// 获取 MCP Server 的工具列表
// ============================================
export async function listMCPServerTools(serverId) {
  try {
    await ensureTables();

    const serverResult = await getMCPServer(serverId);
    if (!serverResult.success) {
      return formatResponse(false, null, 'MCP Server not found');
    }

    const server = serverResult.data;

    const rpcRequest = {
      jsonrpc: '2.0',
      method: 'tools/list',
      id: nextRpcId(),
    };

    const headers = buildAuthHeaders(server);
    const response = await safeFetch(server.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(rpcRequest),
    }, 15000);

    const responseBody = await response.json();

    if (responseBody.error) {
      return formatResponse(false, null, responseBody.error.message || 'Failed to list tools');
    }

    const tools = responseBody.result?.tools || [];
    return formatResponse(true, tools);
  } catch (error) {
    logger.error('[MCP] listMCPServerTools error:', error);
    return formatResponse(false, null, error.message);
  }
}

// ============================================
// 将某 Agent 的所有技能导出为 MCP Tools
// ============================================
export async function exportSkillsAsMCPTools(nodeId) {
  try {
    await ensureTables();
    const pg = getPostgres();

    const { rows } = await pg.query(
      'SELECT id, name, description, category, version, input_schema, output_schema, node_id FROM skills WHERE node_id = $1',
      [nodeId]
    );

    const tools = [];
    for (const skill of rows) {
      const toolDefResult = await generateToolDefinition(skill.id);
      if (toolDefResult.success) {
        tools.push(toolDefResult.data);
      }
    }

    return formatResponse(true, { node_id: nodeId, tool_count: tools.length, tools });
  } catch (error) {
    logger.error('[MCP] exportSkillsAsMCPTools error:', error);
    return formatResponse(false, null, error.message);
  }
}

// ============================================
// 列出所有可用的 MCP Tools（聚合所有已注册 Server 的工具）
// ============================================
export async function listAllMCPTools(filters = {}) {
  try {
    await ensureTables();

    // Get all active servers
    const serversResult = await listMCPServers({ status: 'active', limit: 100 });
    if (!serversResult.success) {
      return serversResult;
    }

    const servers = serversResult.data;
    const allTools = [];

    const limit = parseInt(filters.limit) || 100;
    const offset = parseInt(filters.offset) || 0;

    for (const server of servers) {
      try {
        const toolsResult = await listMCPServerTools(server.id);
        if (toolsResult.success) {
          const serverTools = (toolsResult.data || []).map(tool => ({
            ...tool,
            server_id: server.id,
            server_name: server.name,
          }));
          allTools.push(...serverTools);
        }
      } catch (err) {
        logger.warn(`[MCP] Failed to list tools from server ${server.id}: ${err.message}`);
      }
    }

    const paginated = allTools.slice(offset, offset + limit);

    return formatResponse(true, {
      total: allTools.length,
      limit,
      offset,
      tools: paginated,
    });
  } catch (error) {
    logger.error('[MCP] listAllMCPTools error:', error);
    return formatResponse(false, null, error.message);
  }
}

// ============================================
// MCP 统计
// ============================================
export async function getMCPStats() {
  try {
    await ensureTables();
    const pg = getPostgres();

    const [serverStats, invocationStats] = await Promise.all([
      pg.query(`
        SELECT
          COUNT(*) as total_servers,
          COUNT(*) FILTER (WHERE status = 'active') as active_servers
        FROM mcp_servers
      `),
      pg.query(`
        SELECT
          COUNT(*) as total_invocations,
          COUNT(*) FILTER (WHERE status = 'success') as successful_invocations
        FROM mcp_invocation_logs
      `),
    ]);

    const totalServers = parseInt(serverStats.rows[0]?.total_servers || '0');
    const activeServers = parseInt(serverStats.rows[0]?.active_servers || '0');
    const totalInvocations = parseInt(invocationStats.rows[0]?.total_invocations || '0');
    const successfulInvocations = parseInt(invocationStats.rows[0]?.successful_invocations || '0');
    const successRate = totalInvocations > 0 ? (successfulInvocations / totalInvocations * 100).toFixed(2) : '0.00';

    // Get total tools from active servers (best effort)
    let totalTools = 0;
    try {
      const redis = getRedis();
      const activeServerIds = await redis.smembers('mcp:servers:active');
      for (const sid of activeServerIds) {
        const toolsResult = await listMCPServerTools(sid);
        if (toolsResult.success) {
          totalTools += (toolsResult.data || []).length;
        }
      }
    } catch (err) {
      logger.warn('[MCP] Failed to count tools:', err.message);
    }

    return formatResponse(true, {
      total_servers: totalServers,
      active_servers: activeServers,
      total_tools: totalTools,
      total_invocations: totalInvocations,
      success_rate: parseFloat(successRate),
    });
  } catch (error) {
    logger.error('[MCP] getMCPStats error:', error);
    return formatResponse(false, null, error.message);
  }
}

// ============================================
// 调用日志查询
// ============================================
export async function getMCPInvocationLogs(filters = {}) {
  try {
    await ensureTables();
    const pg = getPostgres();

    const conditions = [];
    const values = [];
    let paramIdx = 1;

    if (filters.server_id) {
      conditions.push(`server_id = $${paramIdx++}`);
      values.push(filters.server_id);
    }

    if (filters.caller_id) {
      conditions.push(`caller_id = $${paramIdx++}`);
      values.push(filters.caller_id);
    }

    if (filters.status) {
      conditions.push(`status = $${paramIdx++}`);
      values.push(filters.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(parseInt(filters.limit) || 50, 1), 200);
    const offset = Math.max(parseInt(filters.offset) || 0, 0);

    const { rows } = await pg.query(
      `SELECT * FROM mcp_invocation_logs ${where} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      [...values, limit, offset]
    );

    return formatResponse(true, rows);
  } catch (error) {
    logger.error('[MCP] getMCPInvocationLogs error:', error);
    return formatResponse(false, null, error.message);
  }
}

// ============================================
// 健康检查
// ============================================
export async function checkMCPServerHealth(serverId) {
  try {
    await ensureTables();

    const serverResult = await getMCPServer(serverId);
    if (!serverResult.success) {
      return formatResponse(false, null, 'MCP Server not found');
    }

    const server = serverResult.data;
    const rpcRequest = {
      jsonrpc: '2.0',
      method: 'ping',
      id: nextRpcId(),
    };

    const headers = buildAuthHeaders(server);
    let healthy = false;
    let responseStatus = null;

    try {
      const response = await safeFetch(server.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(rpcRequest),
      }, 10000);
      responseStatus = response.status;
      healthy = response.ok;
    } catch (fetchErr) {
      healthy = false;
      responseStatus = 'unreachable';
    }

    // Update status and last_health_check
    const pg = getPostgres();
    const newStatus = healthy ? 'active' : 'unhealthy';
    await pg.query(
      'UPDATE mcp_servers SET status = $1, last_health_check = NOW(), updated_at = NOW() WHERE id = $2',
      [newStatus, serverId]
    );

    // Update Redis cache
    const redis = getRedis();
    if (healthy) {
      await redis.sadd('mcp:servers:active', serverId);
    } else {
      await redis.srem('mcp:servers:active', serverId);
    }
    await redis.hset(`mcp:server:${serverId}`, 'status', newStatus);

    return formatResponse(true, {
      server_id: serverId,
      healthy,
      status: newStatus,
      response_status: responseStatus,
      checked_at: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[MCP] checkMCPServerHealth error:', error);
    return formatResponse(false, null, error.message);
  }
}
