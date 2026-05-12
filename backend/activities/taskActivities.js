import { getPostgres, getRedis } from '../core/dependencies.js';
import { formatResponse } from '../core/utils.js';

let _globalSubscriber = null;

async function getGlobalSubscriber() {
  if (_globalSubscriber && !_globalSubscriber.closed) return _globalSubscriber;
  const redis = getRedis();
  _globalSubscriber = redis.duplicate();
  return _globalSubscriber;
}

export async function executeTaskActivity(taskId, nodeId, skillId, payload) {
  const redisClient = getRedis();

  try {
    const messageId = `task-${taskId}-${Date.now()}`;

    await redisClient.xadd(
      `node:${nodeId}:tasks`,
      '*',
      'task_id', taskId,
      'skill_id', skillId,
      'payload', JSON.stringify(payload),
      'message_id', messageId
    );

    const subscriber = await getGlobalSubscriber();
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Task execution timeout'));
      }, 60000);

      const channel = `task:${taskId}:result`;
      let resolved = false;

      function onMessage(msgChannel, message) {
        if (msgChannel !== channel || resolved) return;
        resolved = true;
        clearTimeout(timeout);
        resolve(JSON.parse(message));
      }

      subscriber.subscribe(channel, (err) => {
        if (err) { clearTimeout(timeout); reject(err); return; }
      });

      subscriber.on('message', onMessage);
    });

    if (result.success) {
      return result.data;
    } else {
      throw new Error(result.error || 'Task execution failed');
    }
  } catch (error) {
    console.error(`Error executing task activity on node ${nodeId}:`, error);
    throw error;
  }
}

export async function retryTask(taskId, nodeId, skillId, payload) {
  return executeTaskActivity(taskId, nodeId, skillId, payload);
}

export async function shutdown() {
  if (_globalSubscriber && !_globalSubscriber.closed) {
    try { await _globalSubscriber.quit(); } catch (_) {}
    _globalSubscriber = null;
  }
}
