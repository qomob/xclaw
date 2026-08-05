import { getPostgres, getRedis } from '../core/dependencies.js';
import { generateUUID, formatResponse } from '../core/utils.js';
import logger from './loggerService.js';
import eventBus from './eventBus.js';
import { safeFetch } from '../core/httpGuard.js';

const A2A_PREFIX = 'a2a:';

class A2AService {
  constructor() {
    this.pgPool = null;
    this.redis = null;
    this._initialized = false;
    this._tablesReady = false;
  }

  _getRedis() {
    if (!this.redis) this.redis = getRedis();
    return this.redis;
  }

  _getPg() {
    if (!this.pgPool) this.pgPool = getPostgres();
    return this.pgPool;
  }

  async init() {
    if (this._initialized) return;
    await this._ensureTables();
    this._initialized = true;
    logger.info('A2A service initialized');
  }

  async _ensureTables() {
    if (this._tablesReady) return;
    const pg = this._getPg();
    await pg.query(`
      CREATE TABLE IF NOT EXISTS a2a_agent_cards (
        agent_id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        url VARCHAR(500),
        capabilities JSONB DEFAULT '[]',
        skills JSONB DEFAULT '[]',
        authentication JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        status VARCHAR(50) DEFAULT 'active',
        vector_id UUID,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pg.query(`
      CREATE TABLE IF NOT EXISTS a2a_task_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_agent_id UUID,
        to_agent_id UUID,
        task_type VARCHAR(100),
        skill VARCHAR(255),
        input_data JSONB DEFAULT '{}',
        output_data JSONB,
        status VARCHAR(50) DEFAULT 'pending',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pg.query(`
      CREATE TABLE IF NOT EXISTS a2a_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_agent_id UUID,
        to_agent_id UUID,
        content TEXT,
        message_type VARCHAR(50) DEFAULT 'text',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    this._tablesReady = true;
  }

  // ==========================================
  // Agent Card 管理
  // ==========================================

  async publishAgentCard(agentId, cardData) {
    const pg = this._getPg();
    const redis = this._getRedis();
    try {
      const { name, description, url, capabilities, skills, authentication, metadata } = cardData;
      const card = {
        agent_id: agentId,
        name: name || 'Unnamed Agent',
        description: description || '',
        url: url || null,
        capabilities: capabilities || [],
        skills: skills || [],
        authentication: authentication || {},
        metadata: metadata || {},
        status: 'active',
        updated_at: new Date().toISOString(),
      };

      await pg.query(`
        INSERT INTO a2a_agent_cards (agent_id, name, description, url, capabilities, skills, authentication, metadata, status, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', NOW())
        ON CONFLICT (agent_id) DO UPDATE SET
          name = EXCLUDED.name, description = EXCLUDED.description, url = EXCLUDED.url,
          capabilities = EXCLUDED.capabilities, skills = EXCLUDED.skills,
          authentication = EXCLUDED.authentication, metadata = EXCLUDED.metadata,
          status = 'active', updated_at = NOW()
      `, [agentId, card.name, card.description, card.url,
          JSON.stringify(card.capabilities), JSON.stringify(card.skills),
          JSON.stringify(card.authentication), JSON.stringify(card.metadata)]);

      await redis.hset(`${A2A_PREFIX}card:${agentId}`, {
        name: card.name, description: card.description, url: card.url || '',
        capabilities: JSON.stringify(card.capabilities), skills: JSON.stringify(card.skills),
        status: 'active',
      });
      await redis.sadd(`${A2A_PREFIX}agents:active`, agentId);

      eventBus.emit('a2a.card.published', { agent_id: agentId, name: card.name }, { sourceId: agentId });
      logger.info('A2A Agent Card published', { agentId, name: card.name });
      return formatResponse(true, card);
    } catch (error) {
      logger.error('publishAgentCard failed', { error: error.message, agentId });
      return formatResponse(false, null, error.message);
    }
  }

  async getAgentCard(agentId) {
    const pg = this._getPg();
    const redis = this._getRedis();
    try {
      // Redis first
      const cached = await redis.hgetall(`${A2A_PREFIX}card:${agentId}`);
      if (cached && cached.name) {
        return formatResponse(true, {
          agent_id: agentId,
          name: cached.name,
          description: cached.description || '',
          url: cached.url || null,
          capabilities: JSON.parse(cached.capabilities || '[]'),
          skills: JSON.parse(cached.skills || '[]'),
          status: cached.status || 'active',
        });
      }
      // DB fallback
      const result = await pg.query('SELECT * FROM a2a_agent_cards WHERE agent_id = $1', [agentId]);
      if (result.rows.length === 0) {
        return formatResponse(false, null, 'Agent Card not found');
      }
      return formatResponse(true, result.rows[0]);
    } catch (error) {
      logger.error('getAgentCard failed', { error: error.message, agentId });
      return formatResponse(false, null, error.message);
    }
  }

  async updateAgentCard(agentId, updates) {
    const pg = this._getPg();
    const redis = this._getRedis();
    try {
      const fields = [];
      const values = [agentId];
      let idx = 2;
      for (const [key, val] of Object.entries(updates)) {
        if (['name', 'description', 'url', 'status'].includes(key)) {
          fields.push(`${key} = $${idx}`);
          values.push(val);
          idx++;
        } else if (['capabilities', 'skills', 'authentication', 'metadata'].includes(key)) {
          fields.push(`${key} = $${idx}`);
          values.push(JSON.stringify(val));
          idx++;
        }
      }
      if (fields.length === 0) return formatResponse(false, null, 'No valid fields to update');

      fields.push('updated_at = NOW()');
      const result = await pg.query(
        `UPDATE a2a_agent_cards SET ${fields.join(', ')} WHERE agent_id = $1 RETURNING *`,
        values
      );
      if (result.rows.length === 0) return formatResponse(false, null, 'Agent Card not found');

      // Update Redis cache
      const card = result.rows[0];
      await redis.hset(`${A2A_PREFIX}card:${agentId}`, {
        name: card.name, description: card.description || '', url: card.url || '',
        capabilities: JSON.stringify(card.capabilities || []),
        skills: JSON.stringify(card.skills || []),
        status: card.status,
      });

      return formatResponse(true, card);
    } catch (error) {
      logger.error('updateAgentCard failed', { error: error.message, agentId });
      return formatResponse(false, null, error.message);
    }
  }

  async discoverAgents(query, filters = {}, limit = 10) {
    const pg = this._getPg();
    try {
      const conditions = ["status = 'active'"];
      const params = [];
      let idx = 1;

      if (query) {
        conditions.push(`(name ILIKE $${idx} OR description ILIKE $${idx})`);
        params.push(`%${query}%`);
        idx++;
      }
      if (filters.capability) {
        conditions.push(`capabilities @> $${idx}`);
        params.push(JSON.stringify([filters.capability]));
        idx++;
      }
      if (filters.skill) {
        conditions.push(`skills @> $${idx}`);
        params.push(JSON.stringify([filters.skill]));
        idx++;
      }

      params.push(limit);
      const sql = `SELECT * FROM a2a_agent_cards WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT $${idx}`;
      const result = await pg.query(sql, params);
      return formatResponse(true, result.rows);
    } catch (error) {
      logger.error('discoverAgents failed', { error: error.message });
      return formatResponse(false, null, error.message);
    }
  }

  async unpublishAgentCard(agentId) {
    const pg = this._getPg();
    const redis = this._getRedis();
    try {
      await pg.query("UPDATE a2a_agent_cards SET status = 'inactive', updated_at = NOW() WHERE agent_id = $1", [agentId]);
      await redis.hset(`${A2A_PREFIX}card:${agentId}`, { status: 'inactive' });
      await redis.srem(`${A2A_PREFIX}agents:active`, agentId);
      return formatResponse(true, { agent_id: agentId, status: 'inactive' });
    } catch (error) {
      logger.error('unpublishAgentCard failed', { error: error.message, agentId });
      return formatResponse(false, null, error.message);
    }
  }

  // ==========================================
  // A2A Task 管理
  // ==========================================

  async sendTask(agentId, task) {
    const pg = this._getPg();
    try {
      const taskId = generateUUID(`a2a-task:${Date.now()}:${agentId}`);
      const { to_agent_id, task_type, skill, input, metadata } = task;

      // Look up target agent
      const cardResult = await this.getAgentCard(to_agent_id);
      if (!cardResult.success) return formatResponse(false, null, 'Target agent not found');

      const log = await pg.query(`
        INSERT INTO a2a_task_logs (id, from_agent_id, to_agent_id, task_type, skill, input_data, status, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, 'sent', $7) RETURNING *
      `, [taskId, agentId, to_agent_id, task_type || 'generic', skill || null,
          JSON.stringify(input || {}), JSON.stringify(metadata || {})]);

      // Try to call remote agent URL if available
      const targetCard = cardResult.data;
      let remoteResult = null;
      if (targetCard.url) {
        try {
          const resp = await safeFetch(targetCard.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'tasks/send',
              params: { id: taskId, message: { role: 'user', parts: [{ text: JSON.stringify(input) }] } },
              id: 1,
            }),
          }, 30000);
          if (resp.ok) remoteResult = await resp.json();
        } catch (e) {
          logger.warn('A2A remote call failed', { error: e.message, to: to_agent_id });
        }
      }

      await pg.query("UPDATE a2a_task_logs SET status = 'delivered', output_data = $1 WHERE id = $2",
        [JSON.stringify(remoteResult || { delivered: true }), taskId]);

      logger.info('A2A Task sent', { taskId, from: agentId, to: to_agent_id });
      return formatResponse(true, { task_id: taskId, status: 'delivered', remote_result: remoteResult });
    } catch (error) {
      logger.error('sendTask failed', { error: error.message, agentId });
      return formatResponse(false, null, error.message);
    }
  }

  async receiveTask(fromAgentId, task) {
    const pg = this._getPg();
    try {
      const taskId = generateUUID(`a2a-recv:${Date.now()}`);
      await pg.query(`
        INSERT INTO a2a_task_logs (id, from_agent_id, to_agent_id, task_type, skill, input_data, status, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, 'received', $7) RETURNING *
      `, [taskId, fromAgentId, task.to_agent_id, task.task_type || 'generic',
          task.skill || null, JSON.stringify(task.input || {}),
          JSON.stringify(task.metadata || {})]);

      logger.info('A2A Task received', { taskId, from: fromAgentId });
      return formatResponse(true, { task_id: taskId, status: 'received' });
    } catch (error) {
      logger.error('receiveTask failed', { error: error.message });
      return formatResponse(false, null, error.message);
    }
  }

  async getTaskStatus(taskId) {
    const pg = this._getPg();
    try {
      const result = await pg.query('SELECT * FROM a2a_task_logs WHERE id = $1', [taskId]);
      if (result.rows.length === 0) return formatResponse(false, null, 'Task not found');
      return formatResponse(true, result.rows[0]);
    } catch (error) {
      return formatResponse(false, null, error.message);
    }
  }

  async updateTaskStatus(taskId, status, result) {
    const pg = this._getPg();
    try {
      const res = await pg.query(`
        UPDATE a2a_task_logs SET status = $1, output_data = $2, updated_at = NOW() WHERE id = $3 RETURNING *
      `, [status, JSON.stringify(result || {}), taskId]);
      if (res.rows.length === 0) return formatResponse(false, null, 'Task not found');
      return formatResponse(true, res.rows[0]);
    } catch (error) {
      return formatResponse(false, null, error.message);
    }
  }

  // ==========================================
  // A2A Message
  // ==========================================

  async sendMessage(fromAgentId, toAgentId, content, messageType = 'text') {
    const pg = this._getPg();
    try {
      const msgId = generateUUID(`a2a-msg:${Date.now()}`);
      await pg.query(`
        INSERT INTO a2a_messages (id, from_agent_id, to_agent_id, content, message_type)
        VALUES ($1, $2, $3, $4, $5)
      `, [msgId, fromAgentId, toAgentId, content, messageType]);

      logger.info('A2A Message sent', { msgId, from: fromAgentId, to: toAgentId });
      return formatResponse(true, { id: msgId, from: fromAgentId, to: toAgentId, content, type: messageType });
    } catch (error) {
      logger.error('sendMessage failed', { error: error.message });
      return formatResponse(false, null, error.message);
    }
  }

  async getMessages(agentId, limit = 20, offset = 0) {
    const pg = this._getPg();
    try {
      const result = await pg.query(`
        SELECT * FROM a2a_messages
        WHERE to_agent_id = $1 OR from_agent_id = $1
        ORDER BY created_at DESC LIMIT $2 OFFSET $3
      `, [agentId, limit, offset]);
      return formatResponse(true, result.rows);
    } catch (error) {
      return formatResponse(false, null, error.message);
    }
  }

  // ==========================================
  // 能力协商
  // ==========================================

  async negotiateCapabilities(localAgentId, remoteAgentId) {
    try {
      const [local, remote] = await Promise.all([
        this.getAgentCard(localAgentId),
        this.getAgentCard(remoteAgentId),
      ]);

      if (!local.success || !remote.success) {
        return formatResponse(false, null, 'One or both agents not found');
      }

      const localCaps = new Set((local.data.capabilities || []).map(String));
      const remoteCaps = new Set((remote.data.capabilities || []).map(String));
      const localSkills = new Set((local.data.skills || []).map(String));
      const remoteSkills = new Set((remote.data.skills || []).map(String));

      const overlapping = [...localCaps].filter(c => remoteCaps.has(c));
      const complementary = [...remoteCaps].filter(c => !localCaps.has(c));
      const skillGaps = [...remoteSkills].filter(s => !localSkills.has(s));

      const opportunities = complementary.map(cap => ({
        capability: cap,
        local_has: false,
        remote_has: true,
        collaboration_type: 'delegate',
      }));

      return formatResponse(true, {
        local_agent: { id: localAgentId, capabilities: [...localCaps], skills: [...localSkills] },
        remote_agent: { id: remoteAgentId, capabilities: [...remoteCaps], skills: [...remoteSkills] },
        overlapping,
        complementary,
        skill_gaps: skillGaps,
        collaboration_opportunities: opportunities,
      });
    } catch (error) {
      logger.error('negotiateCapabilities failed', { error: error.message });
      return formatResponse(false, null, error.message);
    }
  }

  // ==========================================
  // 统计
  // ==========================================

  async getA2AStats() {
    const pg = this._getPg();
    const redis = this._getRedis();
    try {
      const [agents, tasks, messages, active] = await Promise.all([
        pg.query('SELECT COUNT(*) as count FROM a2a_agent_cards'),
        pg.query('SELECT COUNT(*) as count, COUNT(*) FILTER (WHERE status = \'completed\') as completed FROM a2a_task_logs'),
        pg.query('SELECT COUNT(*) as count FROM a2a_messages'),
        redis.smembers(`${A2A_PREFIX}agents:active`),
      ]);

      const totalTasks = parseInt(tasks.rows[0].count) || 0;
      const completedTasks = parseInt(tasks.rows[0].completed) || 0;

      return formatResponse(true, {
        published_agents: parseInt(agents.rows[0].count) || 0,
        active_agents: active.length,
        total_tasks: totalTasks,
        completed_tasks: completedTasks,
        total_messages: parseInt(messages.rows[0].count) || 0,
        success_rate: totalTasks > 0 ? parseFloat(((completedTasks / totalTasks) * 100).toFixed(2)) : 0,
      });
    } catch (error) {
      return formatResponse(false, null, error.message);
    }
  }

  __resetForTesting() {
    this.pgPool = null;
    this.redis = null;
    this._initialized = false;
    this._tablesReady = false;
  }
}

const a2aService = new A2AService();
export default a2aService;
