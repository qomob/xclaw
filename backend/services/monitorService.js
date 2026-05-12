import os from 'os';
import { getPostgres, getRedis } from '../core/dependencies.js';
import logger from './loggerService.js';

/**
 * 系统监控服务 — 提供实时健康状态、性能指标和告警
 */
class MonitorService {
  constructor() {
    this._startTime = Date.now();
    this._alertCallbacks = [];
  }

  /**
   * 获取完整系统健康状态
   */
  async getSystemHealth() {
    const [dbHealth, redisHealth, systemMetrics] = await Promise.all([
      this._checkDatabase(),
      this._checkRedis(),
      this._getSystemMetrics()
    ]);

    const overall = (dbHealth.status === 'up' && redisHealth.status === 'up')
      ? 'healthy' : 'degraded';

    return {
      success: true,
      data: {
        status: overall,
        uptime_ms: Date.now() - this._startTime,
        uptime_human: this._formatUptime(Date.now() - this._startTime),
        timestamp: Date.now(),
        system: systemMetrics,
        database: dbHealth,
        redis: redisHealth
      }
    };
  }

  /**
   * 获取数据库连接池状态
   */
  async getDatabaseStats() {
    const pgPool = getPostgres();
    
    const [poolStats, tableStats, activeQueries] = await Promise.all([
      pgPool.query(`
        SELECT 
          (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) as total_connections,
          (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') as active_queries,
          (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle') as idle_connections,
          (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') as max_connections
      `),
      pgPool.query(`
        SELECT 
          schemaname || '.' || relname as table_name,
          n_live_tup as row_count,
          n_dead_tup as dead_rows,
          last_vacuum,
          last_autovacuum,
          last_analyze
        FROM pg_stat_user_tables
        ORDER BY n_live_tup DESC
        LIMIT 20
      `),
      pgPool.query(`
        SELECT pid, state, query, query_start, wait_event_type, wait_event
        FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active'
        ORDER BY query_start
        LIMIT 10
      `)
    ]);

    return {
      success: true,
      data: {
        pool: poolStats.rows[0],
        tables: tableStats.rows,
        active_queries: activeQueries.rows
      }
    };
  }

  /**
   * 获取 Redis 状态
   */
  async getRedisStats() {
    const redis = getRedis();
    
    const [info, keyspace, clients] = await Promise.all([
      redis.info('memory'),
      redis.info('keyspace'),
      redis.info('clients')
    ]);

    // 解析关键指标
    const memoryMatch = info.match(/used_memory_human:(\S+)/);
    const peakMatch = info.match(/used_memory_peak_human:(\S+)/);
    const totalKeys = this._parseTotalKeys(keyspace);
    const connectedClients = clients.match(/connected_clients:(\d+)/);

    return {
      success: true,
      data: {
        memory: {
          used: memoryMatch ? memoryMatch[1] : 'unknown',
          peak: peakMatch ? peakMatch[1] : 'unknown'
        },
        keys: totalKeys,
        connected_clients: connectedClients ? parseInt(connectedClients[1]) : 0
      }
    };
  }

  /**
   * 获取业务 KPI 汇总
   */
  async getBusinessKPIs() {
    const pgPool = getPostgres();
    
    const [
      nodeStats,
      taskStats,
      marketStats,
      billingStats,
      federationStats
    ] = await Promise.all([
      pgPool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'online') as online,
          COUNT(*) FILTER (WHERE status = 'offline') as offline,
          COUNT(*) FILTER (WHERE status = 'active') as active,
          AVG(reputation_score) FILTER (WHERE status = 'online') as avg_reputation,
          SUM(total_earnings) as total_earnings
        FROM nodes
      `),
      pgPool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'assigned') as assigned,
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) FILTER (WHERE status = 'failed') as failed,
          AVG(reward_amount) FILTER (WHERE status = 'completed') as avg_reward,
          AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) FILTER (WHERE status = 'completed') as avg_completion_seconds
        FROM tasks
      `),
      pgPool.query(`
        SELECT 
          COUNT(*) as total_bids,
          COUNT(*) FILTER (WHERE status = 'pending') as pending_bids,
          COUNT(*) FILTER (WHERE status = 'accepted') as accepted_bids,
          AVG(match_score) FILTER (WHERE status = 'accepted') as avg_match_score
        FROM task_bids
      `).catch(() => ({ rows: [{ total_bids: 0, pending_bids: 0, accepted_bids: 0, avg_match_score: 0 }] })),
      pgPool.query(`
        SELECT 
          COUNT(*) as total_transactions,
          COALESCE(SUM(ABS(amount)), 0) as total_volume,
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) as today_transactions,
          COALESCE(SUM(ABS(amount)) FILTER (WHERE created_at >= CURRENT_DATE), 0) as today_volume
        FROM transactions WHERE status = 'completed'
      `).catch(() => ({ rows: [{ total_transactions: 0, total_volume: 0, today_transactions: 0, today_volume: 0 }] })),
      this._getFederationKPIs()
    ]);

    return {
      success: true,
      data: {
        nodes: this._serializeRow(nodeStats.rows[0]),
        tasks: this._serializeRow(taskStats.rows[0]),
        market: this._serializeRow(marketStats.rows[0]),
        billing: this._serializeRow(billingStats.rows[0]),
        federation: federationStats
      }
    };
  }

  /**
   * 获取时间序列数据（用于图表）
   */
  async getTimeSeriesData(metric, hours = 24) {
    const pgPool = getPostgres();
    let query;

    switch (metric) {
      case 'tasks':
        query = `
          SELECT 
            date_trunc('hour', created_at) as time_bucket,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE status = 'completed') as completed,
            COUNT(*) FILTER (WHERE status = 'failed') as failed
          FROM tasks
          WHERE created_at >= NOW() - INTERVAL '${hours} hours'
          GROUP BY date_trunc('hour', created_at)
          ORDER BY time_bucket`;
        break;
      case 'nodes':
        query = `
          SELECT 
            date_trunc('hour', created_at) as time_bucket,
            COUNT(*) as registrations
          FROM nodes
          WHERE created_at >= NOW() - INTERVAL '${hours} hours'
          GROUP BY date_trunc('hour', created_at)
          ORDER BY time_bucket`;
        break;
      case 'revenue':
        query = `
          SELECT 
            date_trunc('hour', created_at) as time_bucket,
            COALESCE(SUM(ABS(amount)), 0) as volume,
            COUNT(*) as transactions
          FROM transactions
          WHERE created_at >= NOW() - INTERVAL '${hours} hours' AND status = 'completed'
          GROUP BY date_trunc('hour', created_at)
          ORDER BY time_bucket`;
        break;
      case 'reputation':
        query = `
          SELECT 
            date_trunc('hour', created_at) as time_bucket,
            COUNT(*) as events,
            AVG(new_value - old_value) as avg_change
          FROM reputation_events
          WHERE created_at >= NOW() - INTERVAL '${hours} hours'
          GROUP BY date_trunc('hour', created_at)
          ORDER BY time_bucket`;
        break;
      default:
        return { success: false, error: `Unknown metric: ${metric}` };
    }

    try {
      const result = await pgPool.query(query);
      return { success: true, data: result.rows, metric, period_hours: hours };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取告警列表
   */
  async getAlerts() {
    const alerts = [];
    const pgPool = getPostgres();
    const redis = getRedis();

    // 1. 检查离线节点过多
    try {
      const offlineResult = await pgPool.query(
        "SELECT COUNT(*) as cnt FROM nodes WHERE status = 'offline'"
      );
      const offlineCount = parseInt(offlineResult.rows[0].cnt);
      if (offlineCount > 5) {
        alerts.push({
          level: 'warning',
          type: 'nodes',
          message: `${offlineCount} nodes are offline`,
          timestamp: Date.now()
        });
      }
    } catch { /* skip */ }

    // 2. 检查失败任务过多
    try {
      const failedResult = await pgPool.query(
        "SELECT COUNT(*) as cnt FROM tasks WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '1 hour'"
      );
      const failedCount = parseInt(failedResult.rows[0].cnt);
      if (failedCount > 3) {
        alerts.push({
          level: 'critical',
          type: 'tasks',
          message: `${failedCount} tasks failed in the last hour`,
          timestamp: Date.now()
        });
      }
    } catch { /* skip */ }

    // 3. 检查 Redis 内存
    try {
      const memInfo = await redis.info('memory');
      const maxMem = parseInt(process.env.REDIS_MAXMEMORY || '0');
      if (maxMem > 0) {
        const usedMem = parseInt(memInfo.match(/used_memory:(\d+)/)?.[1] || '0');
        const ratio = usedMem / maxMem;
        if (ratio > 0.9) {
          alerts.push({
            level: 'critical',
            type: 'redis',
            message: `Redis memory usage at ${(ratio * 100).toFixed(1)}%`,
            timestamp: Date.now()
          });
        } else if (ratio > 0.75) {
          alerts.push({
            level: 'warning',
            type: 'redis',
            message: `Redis memory usage at ${(ratio * 100).toFixed(1)}%`,
            timestamp: Date.now()
          });
        }
      }
    } catch { /* skip */ }

    // 4. 检查 DB 连接数
    try {
      const connResult = await pgPool.query(
        "SELECT count(*) as cnt, (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') as max_conn FROM pg_stat_activity WHERE datname = current_database()"
      );
      const { cnt, max_conn } = connResult.rows[0];
      const ratio = parseInt(cnt) / parseInt(max_conn);
      if (ratio > 0.8) {
        alerts.push({
          level: 'warning',
          type: 'database',
          message: `DB connections at ${(ratio * 100).toFixed(1)}% (${cnt}/${max_conn})`,
          timestamp: Date.now()
        });
      }
    } catch { /* skip */ }

    // 按级别排序
    alerts.sort((a, b) => {
      const order = { critical: 0, warning: 1, info: 2 };
      return (order[a.level] ?? 2) - (order[b.level] ?? 2);
    });

    return { success: true, data: alerts };
  }

  // ==========================================
  // 内部方法
  // ==========================================

  async _checkDatabase() {
    try {
      const pgPool = getPostgres();
      const start = Date.now();
      await pgPool.query('SELECT 1');
      const latency = Date.now() - start;
      return { status: 'up', latency_ms: latency };
    } catch (error) {
      return { status: 'down', error: error.message };
    }
  }

  async _checkRedis() {
    try {
      const redis = getRedis();
      const start = Date.now();
      await redis.ping();
      const latency = Date.now() - start;
      return { status: 'up', latency_ms: latency };
    } catch (error) {
      return { status: 'down', error: error.message };
    }
  }

  _getSystemMetrics() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const loadAvg = os.loadavg();

    return {
      hostname: os.hostname(),
      platform: os.platform(),
      node_version: process.version,
      cpu_count: cpus.length,
      cpu_model: cpus[0]?.model || 'unknown',
      memory: {
        total_mb: Math.round(totalMem / 1024 / 1024),
        used_mb: Math.round((totalMem - freeMem) / 1024 / 1024),
        free_mb: Math.round(freeMem / 1024 / 1024),
        usage_percent: ((1 - freeMem / totalMem) * 100).toFixed(1)
      },
      load: {
        '1min': loadAvg[0].toFixed(2),
        '5min': loadAvg[1].toFixed(2),
        '15min': loadAvg[2].toFixed(2)
      },
      process: {
        pid: process.pid,
        memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024)
      }
    };
  }

  async _getFederationKPIs() {
    try {
      const redis = getRedis();
      const peers = await redis.hgetall('xclaw:federation:peers');
      const peerList = Object.entries(peers).filter(([id]) => id !== (process.env.NETWORK_ID || 'default'));
      let aliveCount = 0;
      let totalRemoteNodes = 0;
      
      for (const [, info] of peerList) {
        try {
          const parsed = JSON.parse(info);
          if ((Date.now() - parsed.last_seen) < 120000) {
            aliveCount++;
            totalRemoteNodes += parsed.node_count || 0;
          }
        } catch { /* skip */ }
      }

      return {
        total_peers: peerList.length,
        alive_peers: aliveCount,
        total_remote_nodes: totalRemoteNodes
      };
    } catch {
      return { total_peers: 0, alive_peers: 0, total_remote_nodes: 0 };
    }
  }

  _parseTotalKeys(keyspace) {
    const match = keyspace.match(/keys=(\d+)/);
    return match ? parseInt(match[1]) : 0;
  }

  _formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  _serializeRow(row) {
    const result = {};
    for (const [k, v] of Object.entries(row)) {
      result[k] = typeof v === 'string' && /^\d+\.?\d*$/.test(v) ? parseFloat(v) : v;
    }
    return result;
  }
}

export default new MonitorService();
