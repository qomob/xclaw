// 告警管理器 — 基于指标的阈值告警，支持冷却、Redis 持久化与 Webhook 通知
import { getRedis } from '../core/dependencies.js';
import logger from '../services/loggerService.js';
import realtimeEventBridge from '../services/realtimeEvents.js';
import { safeFetch } from '../core/httpGuard.js';

const ALERTS_KEY = 'xclaw:alerts';
const ALERTS_MAX = 200;

function envFloat(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

function envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

export class AlertManager {
  constructor() {
    this.interval = null;
    this.cooldowns = new Map(); // rule -> last triggered timestamp
    this.checkIntervalMs = envInt('ALERT_CHECK_INTERVAL', 60000);
    this.cooldownMs = envInt('ALERT_COOLDOWN_MS', 10 * 60 * 1000);
    this.webhookUrl = process.env.ALERT_WEBHOOK_URL || '';
    this.rules = {
      online_ratio: envFloat('ALERT_ONLINE_RATIO', 0.5),
      task_failure_rate: envFloat('ALERT_TASK_FAILURE', 0.5),
      ws_connections: envInt('ALERT_WS_MAX', 400),
      memory_mb: envInt('ALERT_MEMORY_MB', 700),
      cpu: envFloat('ALERT_CPU', 90),
      error_rate: envFloat('ALERT_ERROR_RATE', 0.5),
      db_connections: envInt('ALERT_DB_CONNS', 15),
    };
  }

  async init() {
    // 清掉进程内冷却状态，重新开始检查循环
    this.cooldowns.clear();
    this.interval = setInterval(() => {
      this.checkAllMetricsFromRedis().catch(() => {});
    }, this.checkIntervalMs);
    logger.info('[Alerts] AlertManager initialized', { interval: this.checkIntervalMs, webhook: !!this.webhookUrl });
  }

  /**
   * 周期性入口：从 Redis 读取各实例聚合的实时指标（由 metricsManager 定时写入）
   */
  async checkAllMetricsFromRedis() {
    try {
      const redis = getRedis();
      const raw = await redis.get('xclaw:metrics:latest');
      if (!raw) return;
      const metrics = JSON.parse(raw);
      await this.checkAllMetrics(metrics);
    } catch (err) {
      logger.error('[Alerts] checkAllMetricsFromRedis error', { error: err.message });
    }
  }

  /**
   * 核心：评估所有规则并触发告警
   * @param {object} metrics MetricsManager 输出结构
   */
  async checkAllMetrics(metrics) {
    const fired = [];
    const now = Date.now();
    const m = metrics || {};

    const nodes = m.nodes || {};
    const total = nodes.total || 0;
    const online = nodes.online || 0;
    if (total > 0 && online / total < this.rules.online_ratio) {
      fired.push({ rule: 'online_ratio', severity: 'high', message: `在线节点比例过低: ${online}/${total}` });
    }

    const tasks = m.tasks || {};
    const taskTotal = tasks.total || 0;
    if (taskTotal > 0 && (tasks.failed || 0) / taskTotal > this.rules.task_failure_rate) {
      fired.push({ rule: 'task_failure_rate', severity: 'high', message: `任务失败率过高: ${tasks.failed}/${taskTotal}` });
    }

    const ws = m.websocket || {};
    if ((ws.connections || 0) > this.rules.ws_connections) {
      fired.push({ rule: 'ws_connections', severity: 'medium', message: `WebSocket 连接数过高: ${ws.connections}` });
    }

    const memory = m.memory || {};
    const rssMb = Math.round((memory.rss || 0) / (1024 * 1024));
    if (rssMb > this.rules.memory_mb) {
      fired.push({ rule: 'memory', severity: 'high', message: `进程内存过高: ${rssMb}MB` });
    }

    if ((m.cpu?.usage || 0) > this.rules.cpu) {
      fired.push({ rule: 'cpu', severity: 'high', message: `CPU 使用率过高: ${Math.round(m.cpu.usage)}%` });
    }

    const requests = m.requests || {};
    if (requests.total > 0 && (requests.error || 0) / requests.total > this.rules.error_rate) {
      fired.push({ rule: 'error_rate', severity: 'medium', message: `接口错误率过高: ${requests.error}/${requests.total}` });
    }

    const db = m.database || {};
    if ((db.connections || 0) > this.rules.db_connections) {
      fired.push({ rule: 'db_connections', severity: 'medium', message: `数据库连接数过高: ${db.connections}` });
    }

    for (const alert of fired) {
      const last = this.cooldowns.get(alert.rule) || 0;
      if (now - last < this.cooldownMs) continue;
      this.cooldowns.set(alert.rule, now);
      await this._dispatch(alert);
    }
  }

  async _dispatch(alert) {
    const record = {
      id: `${alert.rule}-${Date.now()}`,
      rule: alert.rule,
      severity: alert.severity,
      message: alert.message,
      timestamp: new Date().toISOString(),
    };
    try {
      const redis = getRedis();
      await redis.lpush(ALERTS_KEY, JSON.stringify(record));
      await redis.ltrim(ALERTS_KEY, 0, ALERTS_MAX - 1);
    } catch (err) {
      logger.error('[Alerts] Failed to persist alert', { error: err.message });
    }
    logger.warn('[Alerts] Fired', record);

    // 推送到前端实时通道
    try {
      realtimeEventBridge.emitAlert(record);
    } catch (_) {}

    // 真实通知通道（Webhook）
    if (this.webhookUrl) {
      try {
        await safeFetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'alert', ...record }),
        }, 5000);
      } catch (err) {
        logger.warn('[Alerts] Webhook notification failed', { error: err.message });
      }
    }
  }

  /**
   * 读取最近告警（Redis 持久化，跨实例共享）
   */
  async getAlerts(limit = 50) {
    try {
      const redis = getRedis();
      const items = await redis.lrange(ALERTS_KEY, 0, Math.min(limit, ALERTS_MAX) - 1);
      return items.map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
    } catch (err) {
      logger.error('[Alerts] Failed to read alerts', { error: err.message });
      return [];
    }
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }
}

const alertManager = new AlertManager();
export default alertManager;
