/**
 * 安全合规服务 (Phase 15)
 * 提供 OAuth2/OIDC、审计日志、速率限制管理功能
 * @module securityService
 */

import crypto from 'crypto';
import { getPostgres, getRedis } from '../core/dependencies.js';
import logger from './loggerService.js';

const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 小时
const RATE_LIMIT_PREFIX = 'ratelimit:';

/**
 * 安全服务类 — 管理 OAuth2、审计日志、速率限制
 */
class SecurityService {
  constructor() {
    this.initialized = false;
  }

  /**
   * 初始化安全服务 — 创建数据库表
   */
  async initialize() {
    if (this.initialized) return;

    const pg = getPostgres();

    await pg.query(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_secret VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        redirect_uris TEXT[],
        grant_types TEXT[] DEFAULT '{"client_credentials"}',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES oauth_clients(client_id),
        agent_id UUID,
        access_token VARCHAR(512) NOT NULL,
        refresh_token VARCHAR(512),
        token_type VARCHAR(50) DEFAULT 'Bearer',
        expires_at TIMESTAMP NOT NULL,
        scopes TEXT[] DEFAULT '{"read"}',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id VARCHAR(255),
        action VARCHAR(100) NOT NULL,
        resource VARCHAR(255),
        result VARCHAR(50) DEFAULT 'success',
        ip_address VARCHAR(45),
        user_agent TEXT,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rate_limit_configs (
        id SERIAL PRIMARY KEY,
        tier VARCHAR(50) UNIQUE NOT NULL,
        window_ms INTEGER DEFAULT 60000,
        max_requests INTEGER DEFAULT 100,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_logs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    `);

    // 插入默认速率限制配置
    await pg.query(`
      INSERT INTO rate_limit_configs (tier, window_ms, max_requests) VALUES
        ('free', 60000, 100),
        ('pro', 60000, 1000),
        ('enterprise', 60000, 10000)
      ON CONFLICT (tier) DO NOTHING
    `);

    this.initialized = true;
    logger.info('SecurityService initialized');
  }

  // ============================================================
  // OAuth2 方法
  // ============================================================

  /**
   * 注册 OAuth2 客户端
   * @param {string} name - 客户端名称
   * @param {string[]} redirectUris - 重定向 URI 列表
   * @param {string[]} grantTypes - 授权类型列表
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async registerClient(name, redirectUris = [], grantTypes = ['client_credentials']) {
    try {
      const pg = getPostgres();
      const clientId = crypto.randomUUID();
      const clientSecret = crypto.randomBytes(24).toString('hex');

      const result = await pg.query(
        `INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, grant_types)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING client_id, name, redirect_uris, grant_types, created_at`,
        [clientId, clientSecret, name, redirectUris, grantTypes]
      );

      return {
        success: true,
        data: {
          ...result.rows[0],
          client_secret: clientSecret // 仅在创建时返回
        }
      };
    } catch (error) {
      logger.error('registerClient error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 列出所有 OAuth2 客户端
   * @returns {Promise<{success: boolean, data?: object[], error?: string}>}
   */
  async listClients() {
    try {
      const pg = getPostgres();
      const result = await pg.query(
        'SELECT client_id, name, redirect_uris, grant_types, created_at FROM oauth_clients ORDER BY created_at DESC'
      );
      return { success: true, data: result.rows };
    } catch (error) {
      logger.error('listClients error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 颁发 OAuth2 Token
   * @param {string} grantType - 授权类型 (password/client_credentials/refresh_token)
   * @param {object} params - 参数对象
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async issueToken(grantType, params = {}) {
    try {
      const pg = getPostgres();

      if (grantType === 'client_credentials') {
        const { client_id, client_secret } = params;

        // 验证 client 凭据
        const clientRes = await pg.query(
          'SELECT * FROM oauth_clients WHERE client_id = $1',
          [client_id]
        );

        if (clientRes.rows.length === 0) {
          return { success: false, error: 'Invalid client credentials' };
        }

        const client = clientRes.rows[0];
        if (client.client_secret !== client_secret) {
          return { success: false, error: 'Invalid client credentials' };
        }

        if (!client.grant_types.includes('client_credentials')) {
          return { success: false, error: 'Grant type not allowed for this client' };
        }

        // 生成 token
        const accessToken = crypto.randomBytes(32).toString('hex');
        const refreshToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);

        await pg.query(
          `INSERT INTO oauth_tokens (client_id, access_token, refresh_token, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [client_id, accessToken, refreshToken, expiresAt]
        );

        return {
          success: true,
          data: {
            access_token: accessToken,
            refresh_token: refreshToken,
            token_type: 'Bearer',
            expires_in: Math.floor(TOKEN_EXPIRY_MS / 1000),
            scope: 'read'
          }
        };
      }

      if (grantType === 'password') {
        const { client_id, client_secret, username, password, agent_id } = params;

        // 验证 client
        const clientRes = await pg.query(
          'SELECT * FROM oauth_clients WHERE client_id = $1',
          [client_id]
        );

        if (clientRes.rows.length === 0 || clientRes.rows[0].client_secret !== client_secret) {
          return { success: false, error: 'Invalid client credentials' };
        }

        if (!clientRes.rows[0].grant_types.includes('password')) {
          return { success: false, error: 'Grant type not allowed for this client' };
        }

        // 简化版：直接用 agent_id 作为用户标识（实际生产中需要验证密码）
        const accessToken = crypto.randomBytes(32).toString('hex');
        const refreshToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);

        await pg.query(
          `INSERT INTO oauth_tokens (client_id, agent_id, access_token, refresh_token, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [client_id, agent_id || null, accessToken, refreshToken, expiresAt]
        );

        return {
          success: true,
          data: {
            access_token: accessToken,
            refresh_token: refreshToken,
            token_type: 'Bearer',
            expires_in: Math.floor(TOKEN_EXPIRY_MS / 1000),
            scope: 'read'
          }
        };
      }

      if (grantType === 'refresh_token') {
        const { refresh_token } = params;

        if (!refresh_token) {
          return { success: false, error: 'Missing refresh_token' };
        }

        // 查找 refresh token
        const tokenRes = await pg.query(
          'SELECT * FROM oauth_tokens WHERE refresh_token = $1',
          [refresh_token]
        );

        if (tokenRes.rows.length === 0) {
          return { success: false, error: 'Invalid refresh token' };
        }

        const oldToken = tokenRes.rows[0];

        // 删除旧 token
        await pg.query('DELETE FROM oauth_tokens WHERE id = $1', [oldToken.id]);

        // 生成新 token
        const newAccessToken = crypto.randomBytes(32).toString('hex');
        const newRefreshToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);

        await pg.query(
          `INSERT INTO oauth_tokens (client_id, agent_id, access_token, refresh_token, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [oldToken.client_id, oldToken.agent_id, newAccessToken, newRefreshToken, expiresAt]
        );

        return {
          success: true,
          data: {
            access_token: newAccessToken,
            refresh_token: newRefreshToken,
            token_type: 'Bearer',
            expires_in: Math.floor(TOKEN_EXPIRY_MS / 1000),
            scope: 'read'
          }
        };
      }

      return { success: false, error: `Unsupported grant_type: ${grantType}` };
    } catch (error) {
      logger.error('issueToken error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 吊销 Token
   * @param {string} token - 要吊销的 access_token 或 refresh_token
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async revokeToken(token) {
    try {
      const pg = getPostgres();

      const result = await pg.query(
        'DELETE FROM oauth_tokens WHERE access_token = $1 OR refresh_token = $1',
        [token]
      );

      if (result.rowCount === 0) {
        return { success: false, error: 'Token not found' };
      }

      return { success: true };
    } catch (error) {
      logger.error('revokeToken error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Token 内省 — 验证 token 有效性
   * @param {string} token - access_token
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async introspectToken(token) {
    try {
      const pg = getPostgres();

      const result = await pg.query(
        `SELECT t.*, c.name as client_name
         FROM oauth_tokens t
         LEFT JOIN oauth_clients c ON t.client_id = c.client_id
         WHERE t.access_token = $1`,
        [token]
      );

      if (result.rows.length === 0) {
        return { success: true, data: { active: false } };
      }

      const tokenRow = result.rows[0];

      // 检查是否过期
      if (new Date(tokenRow.expires_at) < new Date()) {
        // 清理过期 token
        await pg.query('DELETE FROM oauth_tokens WHERE id = $1', [tokenRow.id]);
        return { success: true, data: { active: false } };
      }

      return {
        success: true,
        data: {
          active: true,
          token_type: tokenRow.token_type,
          client_id: tokenRow.client_id,
          agent_id: tokenRow.agent_id,
          scope: tokenRow.scopes ? tokenRow.scopes.join(' ') : 'read',
          expires_at: tokenRow.expires_at
        }
      };
    } catch (error) {
      logger.error('introspectToken error:', error);
      return { success: false, error: error.message };
    }
  }

  // ============================================================
  // 审计日志方法
  // ============================================================

  /**
   * 写入审计日志
   * @param {string} agentId - Agent ID
   * @param {string} action - 动作描述
   * @param {string} resource - 资源标识
   * @param {string} result - 结果 (success/failure)
   * @param {string} ip - IP 地址
   * @param {object} metadata - 附加元数据
   * @returns {Promise<{success: boolean}>}
   */
  async logAudit(agentId, action, resource, result, ip, metadata = {}) {
    try {
      const pg = getPostgres();

      await pg.query(
        `INSERT INTO audit_logs (agent_id, action, resource, result, ip_address, user_agent, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          agentId || null,
          action,
          resource,
          result || 'success',
          ip || null,
          metadata.userAgent || null,
          JSON.stringify(metadata)
        ]
      );

      return { success: true };
    } catch (error) {
      logger.error('logAudit error:', error);
      return { success: false };
    }
  }

  /**
   * 查询审计日志
   * @param {object} filters - 过滤条件
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async queryAuditLogs(filters = {}) {
    try {
      const pg = getPostgres();
      const conditions = [];
      const values = [];
      let paramIdx = 1;

      if (filters.agent_id) {
        conditions.push(`agent_id = $${paramIdx++}`);
        values.push(filters.agent_id);
      }
      if (filters.action) {
        conditions.push(`action = $${paramIdx++}`);
        values.push(filters.action);
      }
      if (filters.from_date) {
        conditions.push(`created_at >= $${paramIdx++}`);
        values.push(filters.from_date);
      }
      if (filters.to_date) {
        conditions.push(`created_at <= $${paramIdx++}`);
        values.push(filters.to_date);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = Math.min(Math.max(parseInt(filters.limit) || 50, 1), 500);
      const offset = Math.max(parseInt(filters.offset) || 0, 0);

      const result = await pg.query(
        `SELECT id, agent_id, action, resource, result, ip_address, metadata, created_at
         FROM audit_logs ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...values, limit, offset]
      );

      // 获取总数
      const countRes = await pg.query(
        `SELECT COUNT(*) as total FROM audit_logs ${whereClause}`,
        values
      );

      return {
        success: true,
        data: {
          logs: result.rows,
          total: parseInt(countRes.rows[0].total),
          limit,
          offset
        }
      };
    } catch (error) {
      logger.error('queryAuditLogs error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取审计统计 — 按 action 类型聚合
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async getAuditStats() {
    try {
      const pg = getPostgres();

      const [byAction, byResult, recentCount, totalResult] = await Promise.all([
        pg.query(`
          SELECT action, COUNT(*) as count
          FROM audit_logs
          GROUP BY action
          ORDER BY count DESC
          LIMIT 20
        `),
        pg.query(`
          SELECT result, COUNT(*) as count
          FROM audit_logs
          GROUP BY result
        `),
        pg.query(`
          SELECT COUNT(*) as count
          FROM audit_logs
          WHERE created_at > NOW() - INTERVAL '24 hours'
        `),
        pg.query(`SELECT COUNT(*) as total FROM audit_logs`)
      ]);

      return {
        success: true,
        data: {
          by_action: byAction.rows,
          by_result: byResult.rows,
          last_24h_count: parseInt(recentCount.rows[0].count),
          total: parseInt(totalResult.rows[0].total)
        }
      };
    } catch (error) {
      logger.error('getAuditStats error:', error);
      return { success: false, error: error.message };
    }
  }

  // ============================================================
  // 速率限制方法
  // ============================================================

  /**
   * 获取速率限制配置
   * @returns {Promise<{success: boolean, data?: object[], error?: string}>}
   */
  async getRateLimitConfig() {
    try {
      const pg = getPostgres();
      const result = await pg.query(
        'SELECT tier, window_ms, max_requests, updated_at FROM rate_limit_configs ORDER BY max_requests ASC'
      );
      return { success: true, data: result.rows };
    } catch (error) {
      logger.error('getRateLimitConfig error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 更新速率限制配置
   * @param {object} config - 配置对象 { window_ms, max_requests, tier_limits }
   * @returns {Promise<{success: boolean, data?: object[], error?: string}>}
   */
  async updateRateLimitConfig(config = {}) {
    try {
      const pg = getPostgres();

      // 如果提供了 tier_limits 数组，批量更新
      if (config.tier_limits && Array.isArray(config.tier_limits)) {
        for (const tierConfig of config.tier_limits) {
          await pg.query(
            `UPDATE rate_limit_configs
             SET window_ms = COALESCE($1, window_ms),
                 max_requests = COALESCE($2, max_requests),
                 updated_at = NOW()
             WHERE tier = $3`,
            [tierConfig.window_ms, tierConfig.max_requests, tierConfig.tier]
          );
        }
      }

      // 如果提供了顶层 window_ms / max_requests，更新所有 tier
      if (config.window_ms) {
        await pg.query(
          `UPDATE rate_limit_configs SET window_ms = $1, updated_at = NOW()`,
          [config.window_ms]
        );
      }
      if (config.max_requests) {
        await pg.query(
          `UPDATE rate_limit_configs SET max_requests = $1, updated_at = NOW()`,
          [config.max_requests]
        );
      }

      // 返回更新后的配置
      const result = await pg.query(
        'SELECT tier, window_ms, max_requests, updated_at FROM rate_limit_configs ORDER BY max_requests ASC'
      );

      return { success: true, data: result.rows };
    } catch (error) {
      logger.error('updateRateLimitConfig error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取特定 agent 的速率使用情况
   * @param {string} agentId - Agent ID
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async getRateLimitStatus(agentId) {
    try {
      const redis = getRedis();
      const pg = getPostgres();

      // 获取默认配置 (free tier)
      const configRes = await pg.query(
        "SELECT window_ms, max_requests FROM rate_limit_configs WHERE tier = 'free'"
      );
      const config = configRes.rows[0] || { window_ms: 60000, max_requests: 100 };

      // 从 Redis 获取当前窗口内的请求计数
      const now = Date.now();
      const windowKey = Math.floor(now / config.window_ms);
      const redisKey = `${RATE_LIMIT_PREFIX}${agentId}:${windowKey}`;

      const count = await redis.get(redisKey);
      const currentCount = parseInt(count) || 0;

      const windowStart = windowKey * config.window_ms;
      const windowEnd = windowStart + config.window_ms;
      const resetIn = windowEnd - now;

      return {
        success: true,
        data: {
          agent_id: agentId,
          current_count: currentCount,
          max_requests: config.max_requests,
          window_ms: config.window_ms,
          remaining: Math.max(0, config.max_requests - currentCount),
          reset_in_ms: resetIn,
          window_start: new Date(windowStart).toISOString(),
          window_end: new Date(windowEnd).toISOString()
        }
      };
    } catch (error) {
      logger.error('getRateLimitStatus error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 记录一次请求用于速率限制计数
   * @param {string} agentId - Agent ID
   * @param {number} windowMs - 窗口时间（毫秒）
   * @returns {Promise<number>} 当前窗口请求数
   */
  async incrementRateLimit(agentId, windowMs = 60000) {
    try {
      const redis = getRedis();
      const now = Date.now();
      const windowKey = Math.floor(now / windowMs);
      const redisKey = `${RATE_LIMIT_PREFIX}${agentId}:${windowKey}`;

      const count = await redis.incr(redisKey);
      // 首次设置过期时间
      if (count === 1) {
        await redis.expire(redisKey, Math.ceil(windowMs / 1000) + 1);
      }

      return count;
    } catch (error) {
      logger.error('incrementRateLimit error:', error);
      return 0;
    }
  }

  // ============================================================
  // 统计方法
  // ============================================================

  /**
   * 获取安全总览统计
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  async getSecurityStats() {
    try {
      const pg = getPostgres();

      const [
        clientsCount,
        activeTokens,
        auditTotal,
        auditLast24h,
        auditFailures,
        topAgents
      ] = await Promise.all([
        pg.query('SELECT COUNT(*) as count FROM oauth_clients'),
        pg.query('SELECT COUNT(*) as count FROM oauth_tokens WHERE expires_at > NOW()'),
        pg.query('SELECT COUNT(*) as count FROM audit_logs'),
        pg.query("SELECT COUNT(*) as count FROM audit_logs WHERE created_at > NOW() - INTERVAL '24 hours'"),
        pg.query("SELECT COUNT(*) as count FROM audit_logs WHERE result = 'failure' AND created_at > NOW() - INTERVAL '24 hours'"),
        pg.query(`
          SELECT agent_id, COUNT(*) as request_count
          FROM audit_logs
          WHERE created_at > NOW() - INTERVAL '24 hours'
          GROUP BY agent_id
          ORDER BY request_count DESC
          LIMIT 5
        `)
      ]);

      return {
        success: true,
        data: {
          oauth: {
            registered_clients: parseInt(clientsCount.rows[0].count),
            active_tokens: parseInt(activeTokens.rows[0].count)
          },
          audit: {
            total_logs: parseInt(auditTotal.rows[0].count),
            last_24h: parseInt(auditLast24h.rows[0].count),
            failures_last_24h: parseInt(auditFailures.rows[0].count)
          },
          top_agents_last_24h: topAgents.rows,
          rate_limit_tiers: (await this.getRateLimitConfig()).data
        }
      };
    } catch (error) {
      logger.error('getSecurityStats error:', error);
      return { success: false, error: error.message };
    }
  }
}

// 单例导出
const securityService = new SecurityService();
export default securityService;
