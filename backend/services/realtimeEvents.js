import realtimePushService from './realtimePushService.js';
import eventBus from './eventBus.js';
import logger from './loggerService.js';

/**
 * RealtimeEventBridge — 桥接后端事件到实时推送 WebSocket
 * 
 * 频道:
 *  - system:heartbeat  系统心跳 (5秒)
 *  - nodes:events      节点上线/离线
 *  - tasks:events      任务状态变更
 *  - alerts:events     告警事件
 *  - a2a:messages      A2A 消息
 *  - monitor:metrics   监控指标更新
 *  - feed:public       首页 Live Feed：脱敏后的公开网络动态（无需认证可订阅）
 *
 * 公开动态的脱敏原则：只发事件事实与公开标识（Agent 名、短 ID、任务/技能/订单 ID），
 * 绝不携带任务 payload、执行结果、P2P 消息内容或争议理由等用户内容。
 */
class RealtimeEventBridge {
  constructor() {
    this.initialized = false;
  }

  initialize() {
    if (this.initialized) return;

    // 每 5 秒推送系统心跳
    this._heartbeatTimer = setInterval(() => {
      realtimePushService.broadcast('system:heartbeat', {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: Date.now(),
      });
    }, 5000);

    this._initEventBusBridge();

    this.initialized = true;
    logger.info('[RealtimeEventBridge] initialized');
  }

  /**
   * 公开动态：向 feed:public 频道推送脱敏事件（匿名访客可订阅）
   */
  emitPublicFeed(kind, payload = {}) {
    try {
      realtimePushService.broadcast('feed:public', {
        kind,
        ...payload,
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.warn('[RealtimeEventBridge] emitPublicFeed failed', { error: err.message, kind });
    }
  }

  /**
   * eventBus → 公开动态桥接。
   * 只映射「他人也能在公开接口看到」的事件（注册/上架/任务流转/订单），
   * 且只取白名单字段，避免把用户内容带上公开频道。
   */
  _initEventBusBridge() {
    const shortId = (id) => (typeof id === 'string' && id.length > 8 ? `${id.slice(0, 8)}…` : id || null);

    const mapping = {
      'agent.registered': (p) => ['agent', { sub: 'registered', who: p.name || shortId(p.node_id), agent_id: p.node_id }],
      'skill.registered': (p) => ['skill', { sub: 'listed', who: p.name || null, skill_id: p.skill_id }],
      'skill.called': (p) => ['skill', { sub: 'called', who: shortId(p.provider_id), skill_id: p.skill_id }],
      'task.created': (p) => ['task', { sub: 'created', who: shortId(p.caller_id), task_id: p.task_id }],
      'task.submitted': (p) => ['task', { sub: 'submitted', who: shortId(p.node_id), task_id: p.task_id }],
      // 注意：不含 result（执行结果属于调用方私有内容）
      'task.completed': (p) => ['task', { sub: 'completed', who: shortId(p.worker_id || p.node_id), task_id: p.task_id }],
      // 注意：不含 reason（争议理由属于当事双方内容）
      'task.disputed': (p) => ['task', { sub: 'disputed', task_id: p.task_id }],
      'marketplace.order_created': (p) => ['order', { sub: 'created', order_id: p.order_id }],
      'marketplace.order_completed': (p) => ['order', { sub: 'completed', order_id: p.order_id }],
    };

    for (const [eventType, map] of Object.entries(mapping)) {
      eventBus.on(eventType, (event) => {
        try {
          const [kind, payload] = map(event?.payload || {});
          this.emitPublicFeed(kind, payload);
        } catch (err) {
          logger.warn('[RealtimeEventBridge] public feed mapping failed', { error: err.message, eventType });
        }
      });
    }
    logger.info('[RealtimeEventBridge] eventBus → feed:public bridge ready', { events: Object.keys(mapping).length });
  }

  /** 节点上线/离线事件（同时作为公开动态展示，Agent 名称本就是公开信息） */
  emitNodeEvent(event, nodeData) {
    realtimePushService.broadcast('nodes:events', { event, ...nodeData });
    if (event === 'online' || event === 'offline') {
      this.emitPublicFeed('agent', {
        sub: event === 'online' ? 'joined' : 'left',
        who: nodeData?.name || nodeData?.agent_id || null,
        agent_id: nodeData?.agent_id || null,
      });
    }
  }

  /** 任务状态变更 */
  emitTaskEvent(event, taskData) {
    realtimePushService.broadcast('tasks:events', { event, ...taskData });
  }

  /** 告警事件 */
  emitAlert(alert) {
    realtimePushService.broadcast('alerts:events', alert);
  }

  /** A2A 消息 */
  emitA2AMessage(message) {
    realtimePushService.broadcast('a2a:messages', message);
    if (message.to_agent_id) {
      realtimePushService.sendToAgent(message.to_agent_id, {
        type: 'a2a:direct',
        ...message,
      });
    }
  }

  /** 监控指标更新 */
  emitMetrics(metrics) {
    realtimePushService.broadcast('monitor:metrics', metrics);
  }

  shutdown() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this.initialized = false;
  }
}

export default new RealtimeEventBridge();
