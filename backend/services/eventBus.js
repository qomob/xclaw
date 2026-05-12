import { EventEmitter } from 'events';
import { getPostgres, getRedis } from '../core/dependencies.js';
import logger from './loggerService.js';

/**
 * xclaw 事件总线
 * 
 * 职责：
 * 1. 进程内事件发布/订阅（EventEmitter）
 * 2. 事件持久化到 event_log 表
 * 3. 触发 webhook 投递
 */
class EventBus {
  constructor() {
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(100);
    this._initialized = false;
  }

  /**
   * 初始化：加载 webhookService 并订阅内部事件
   */
  async init() {
    if (this._initialized) return;
    this._initialized = true;
    logger.info('[EventBus] Initialized');
  }

  /**
   * 发布事件
   * @param {string} eventType - 事件类型，如 'task.completed'
   * @param {object} payload - 事件数据
   * @param {object} options - { sourceId, metadata }
   */
  async emit(eventType, payload = {}, options = {}) {
    const { sourceId = null, metadata = {} } = options;

    try {
      // 1. 持久化到 event_log
      await this._persistEvent(eventType, payload, sourceId, metadata);
    } catch (err) {
      logger.error('[EventBus] Failed to persist event', { eventType, error: err.message });
    }

    try {
      // 2. 进程内广播
      this._emitter.emit(eventType, { eventType, payload, sourceId, metadata, timestamp: new Date().toISOString() });
      this._emitter.emit('*', { eventType, payload, sourceId, metadata, timestamp: new Date().toISOString() });
    } catch (err) {
      logger.error('[EventBus] EventEmitter error', { eventType, error: err.message });
    }

    // 3. 触发 webhook 投递（延迟加载避免循环依赖）
    try {
      const { triggerWebhooks } = await import('./webhookService.js');
      setImmediate(() => triggerWebhooks(eventType, payload, sourceId));
    } catch (err) {
      // webhookService 尚未加载时不报错
      if (!err.message.includes('Cannot find module')) {
        logger.error('[EventBus] Webhook trigger failed', { eventType, error: err.message });
      }
    }
  }

  /**
   * 订阅事件
   * @param {string} eventType - 事件类型，'*' 为全部
   * @param {function} handler - 处理函数
   */
  on(eventType, handler) {
    this._emitter.on(eventType, handler);
    return () => this._emitter.off(eventType, handler);
  }

  /**
   * 一次性订阅
   */
  once(eventType, handler) {
    this._emitter.once(eventType, handler);
    return () => this._emitter.off(eventType, handler);
  }

  /**
   * 持久化事件到 event_log
   */
  async _persistEvent(eventType, payload, sourceId, metadata) {
    const pool = getPostgres();
    await pool.query(
      `INSERT INTO event_log (event_type, source_id, payload, metadata)
       VALUES ($1, $2, $3, $4)`,
      [eventType, sourceId, JSON.stringify(payload), JSON.stringify(metadata)]
    );
  }

  /**
   * 查询事件日志
   */
  async queryEvents({ eventType = null, sourceId = null, limit = 50, offset = 0, since = null } = {}) {
    const pool = getPostgres();
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (eventType) {
      conditions.push(`event_type = $${paramIdx++}`);
      params.push(eventType);
    }
    if (sourceId) {
      conditions.push(`source_id = $${paramIdx++}`);
      params.push(sourceId);
    }
    if (since) {
      conditions.push(`created_at >= $${paramIdx++}`);
      params.push(since);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM event_log ${where}`,
      params
    );

    const result = await pool.query(
      `SELECT * FROM event_log ${where} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset]
    );

    return {
      events: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit,
      offset
    };
  }
}

// 单例导出
const eventBus = new EventBus();
export default eventBus;
