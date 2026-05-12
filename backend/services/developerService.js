/**
 * DeveloperService — 开发者平台服务
 *
 * 管理开发者注册、沙箱环境、API Keys 等。
 * @module services/developerService
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { getPostgres, getRedis } from '../core/dependencies.js';

/** @type {string} 开发者表名 (Redis hash prefix) */
const REDIS_DEV_PREFIX = 'developer:';

class DeveloperService {
  constructor() {
    /** @type {boolean} */
    this.initialized = false;
  }

  /**
   * 初始化 — 建表
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) return;

    const pg = getPostgres();
    await pg.query(`
      CREATE TABLE IF NOT EXISTS developer_profiles (
        developer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE,
        sandbox_api_key VARCHAR(255),
        plan VARCHAR(50) DEFAULT 'free',
        rate_limit INTEGER DEFAULT 100,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pg.query(`
      CREATE TABLE IF NOT EXISTS sandbox_agents (
        agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        developer_id UUID REFERENCES developer_profiles(developer_id) ON DELETE CASCADE,
        name VARCHAR(255),
        capabilities TEXT,
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pg.query(`
      CREATE TABLE IF NOT EXISTS developer_api_keys (
        key_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        developer_id UUID REFERENCES developer_profiles(developer_id) ON DELETE CASCADE,
        name VARCHAR(255),
        api_key VARCHAR(255) NOT NULL,
        permissions JSONB DEFAULT '{"read": true, "write": false}',
        last_used TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        revoked_at TIMESTAMP
      );
    `);

    this.initialized = true;
  }

  /**
   * 生成随机 API Key
   * @param {string} [prefix='xclw_dev']
   * @returns {string}
   * @private
   */
  _generateApiKey(prefix = 'xclw_dev') {
    const raw = randomUUID() + '-' + Date.now() + '-' + randomUUID();
    const hash = createHash('sha256').update(raw).digest('hex');
    return `${prefix}_${hash.substring(0, 40)}`;
  }

  /**
   * 注册开发者 — 生成 sandbox API Key + 创建默认 sandbox agent
   * @param {string} name
   * @param {string} [email]
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async registerDeveloper(name, email) {
    await this.initialize();
    const pg = getPostgres();

    try {
      const sandboxApiKey = this._generateApiKey('xclw_dev');
      const developerId = randomUUID();

      await pg.query(
        `INSERT INTO developer_profiles (developer_id, name, email, sandbox_api_key)
         VALUES ($1, $2, $3, $4)`,
        [developerId, name, email || null, sandboxApiKey]
      );

      // 创建默认 sandbox agent
      const defaultAgentId = randomUUID();
      await pg.query(
        `INSERT INTO sandbox_agents (agent_id, developer_id, name, capabilities, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [defaultAgentId, developerId, `${name}-sandbox-agent`, 'test,sandbox', 'active']
      );

      return {
        success: true,
        data: {
          developer_id: developerId,
          name,
          email: email || null,
          sandbox_api_key: sandboxApiKey,
          default_agent_id: defaultAgentId,
          plan: 'free',
          rate_limit: 100
        }
      };
    } catch (err) {
      if (err.code === '23505' && err.constraint?.includes('email')) {
        return { success: false, error: 'Email already registered' };
      }
      return { success: false, error: err.message };
    }
  }

  /**
   * 获取开发者 profile
   * @param {string} developerId
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async getProfile(developerId) {
    await this.initialize();
    const pg = getPostgres();

    try {
      const { rows } = await pg.query(
        `SELECT developer_id, name, email, sandbox_api_key, plan, rate_limit, created_at, updated_at
         FROM developer_profiles WHERE developer_id = $1`,
        [developerId]
      );

      if (rows.length === 0) {
        return { success: false, error: 'Developer not found' };
      }

      return { success: true, data: rows[0] };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 获取沙箱环境状态
   * @param {string} developerId
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async getSandboxStatus(developerId) {
    await this.initialize();
    const pg = getPostgres();

    try {
      const profile = await this.getProfile(developerId);
      if (!profile.success) return profile;

      const [agentsRes, tasksRes] = await Promise.all([
        pg.query('SELECT COUNT(*)::int AS count FROM sandbox_agents WHERE developer_id = $1', [developerId]),
        pg.query('SELECT COUNT(*)::int AS count FROM tasks WHERE caller_id = $1', [developerId])
      ]);

      const redis = getRedis();
      let redisKeys = 0;
      try {
        const keys = await redis.keys(`${REDIS_DEV_PREFIX}${developerId}:*`);
        redisKeys = keys.length;
      } catch { /* ignore */ }

      return {
        success: true,
        data: {
          developer_id: developerId,
          status: 'active',
          agents_count: agentsRes.rows[0].count,
          tasks_count: tasksRes.rows[0].count,
          redis_keys: redisKeys,
          plan: profile.data.plan,
          rate_limit: profile.data.rate_limit
        }
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 重置沙箱 — 清除所有 sandbox agents（重新创建默认 agent）
   * @param {string} developerId
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async resetSandbox(developerId) {
    await this.initialize();
    const pg = getPostgres();

    try {
      const profile = await this.getProfile(developerId);
      if (!profile.success) return profile;

      // 删除所有 sandbox agents
      await pg.query('DELETE FROM sandbox_agents WHERE developer_id = $1', [developerId]);

      // 清理 Redis 中相关 key
      const redis = getRedis();
      try {
        const keys = await redis.keys(`${REDIS_DEV_PREFIX}${developerId}:*`);
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } catch { /* ignore */ }

      // 重新创建默认 agent
      const defaultAgentId = randomUUID();
      await pg.query(
        `INSERT INTO sandbox_agents (agent_id, developer_id, name, capabilities, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [defaultAgentId, developerId, `${profile.data.name}-sandbox-agent`, 'test,sandbox', 'active']
      );

      return {
        success: true,
        data: {
          message: 'Sandbox reset successfully',
          new_default_agent_id: defaultAgentId
        }
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 列出沙箱 agents
   * @param {string} developerId
   * @returns {Promise<{success: boolean, data?: object[], error?: string}>}
   */
  async listSandboxAgents(developerId) {
    await this.initialize();
    const pg = getPostgres();

    try {
      const { rows } = await pg.query(
        `SELECT agent_id, name, capabilities, status, created_at
         FROM sandbox_agents WHERE developer_id = $1 ORDER BY created_at DESC`,
        [developerId]
      );

      return { success: true, data: rows };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 在沙箱创建测试 agent
   * @param {string} developerId
   * @param {object} agentConfig
   * @param {string} [agentConfig.name]
   * @param {string} [agentConfig.capabilities]
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async createSandboxAgent(developerId, agentConfig = {}) {
    await this.initialize();
    const pg = getPostgres();

    try {
      const agentId = randomUUID();
      await pg.query(
        `INSERT INTO sandbox_agents (agent_id, developer_id, name, capabilities, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          agentId,
          developerId,
          agentConfig.name || 'test-agent',
          agentConfig.capabilities || 'test',
          'active'
        ]
      );

      return {
        success: true,
        data: {
          agent_id: agentId,
          name: agentConfig.name || 'test-agent',
          capabilities: agentConfig.capabilities || 'test',
          status: 'active'
        }
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 删除沙箱 agent
   * @param {string} developerId
   * @param {string} agentId
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async deleteSandboxAgent(developerId, agentId) {
    await this.initialize();
    const pg = getPostgres();

    try {
      const { rowCount } = await pg.query(
        'DELETE FROM sandbox_agents WHERE agent_id = $1 AND developer_id = $2',
        [agentId, developerId]
      );

      if (rowCount === 0) {
        return { success: false, error: 'Sandbox agent not found' };
      }

      return { success: true, data: { message: 'Sandbox agent deleted', agent_id: agentId } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 列出沙箱 tasks — 查看该开发者创建的 sandbox tasks
   * @param {string} developerId
   * @returns {Promise<{success: boolean, data?: object[], error?: string}>}
   */
  async listSandboxTasks(developerId) {
    await this.initialize();
    const pg = getPostgres();

    try {
      const { rows } = await pg.query(
        `SELECT task_id, type, payload, result, status, skill_id, assigned_node_id, created_at
         FROM tasks WHERE caller_id = $1 ORDER BY created_at DESC`,
        [developerId]
      );

      return { success: true, data: rows };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 在沙箱创建测试 task
   * @param {string} developerId
   * @param {object} taskConfig
   * @param {string} [taskConfig.type]
   * @param {object} [taskConfig.payload]
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async createSandboxTask(developerId, taskConfig = {}) {
    await this.initialize();
    const pg = getPostgres();

    try {
      const taskId = randomUUID();
      await pg.query(
        `INSERT INTO tasks (task_id, type, payload, status, caller_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          taskId,
          taskConfig.type || 'sandbox-test',
          JSON.stringify(taskConfig.payload || { test: true }),
          'pending',
          developerId
        ]
      );

      return {
        success: true,
        data: {
          task_id: taskId,
          type: taskConfig.type || 'sandbox-test',
          status: 'pending',
          payload: taskConfig.payload || { test: true }
        }
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 列出开发者 API Keys
   * @param {string} developerId
   * @returns {Promise<{success: boolean, data?: object[], error?: string}>}
   */
  async listApiKeys(developerId) {
    await this.initialize();
    const pg = getPostgres();

    try {
      const { rows } = await pg.query(
        `SELECT key_id, name, permissions, last_used, created_at, revoked_at
         FROM developer_api_keys WHERE developer_id = $1 ORDER BY created_at DESC`,
        [developerId]
      );

      return { success: true, data: rows };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 创建新 API Key
   * @param {string} developerId
   * @param {string} [name]
   * @param {object} [permissions]
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async createApiKey(developerId, name, permissions) {
    await this.initialize();
    const pg = getPostgres();

    try {
      const keyId = randomUUID();
      const apiKey = this._generateApiKey('xclw_dev');
      const perms = permissions || { read: true, write: false };

      await pg.query(
        `INSERT INTO developer_api_keys (key_id, developer_id, name, api_key, permissions)
         VALUES ($1, $2, $3, $4, $5)`,
        [keyId, developerId, name || 'default', apiKey, JSON.stringify(perms)]
      );

      return {
        success: true,
        data: {
          key_id: keyId,
          name: name || 'default',
          api_key: apiKey,
          permissions: perms
        }
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 吊销 API Key
   * @param {string} developerId
   * @param {string} keyId
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async revokeApiKey(developerId, keyId) {
    await this.initialize();
    const pg = getPostgres();

    try {
      const { rowCount } = await pg.query(
        `UPDATE developer_api_keys SET revoked_at = NOW()
         WHERE key_id = $1 AND developer_id = $2 AND revoked_at IS NULL`,
        [keyId, developerId]
      );

      if (rowCount === 0) {
        return { success: false, error: 'API Key not found or already revoked' };
      }

      return { success: true, data: { message: 'API Key revoked', key_id: keyId } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

/** @type {DeveloperService} 单例 */
const developerService = new DeveloperService();
export default developerService;
