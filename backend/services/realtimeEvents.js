import realtimePushService from './realtimePushService.js';
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

    this.initialized = true;
    logger.info('[RealtimeEventBridge] initialized');
  }

  /** 节点上线/离线事件 */
  emitNodeEvent(event, nodeData) {
    realtimePushService.broadcast('nodes:events', { event, ...nodeData });
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
