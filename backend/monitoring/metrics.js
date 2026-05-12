// 指标监控文件
import { getRedis, getPostgres } from '../core/dependencies.js';
import os from 'os';

export default class MetricsManager {
  constructor() {
    this.redisClient = null;
    this.metrics = {
      nodes: {
        total: 0,
        online: 0,
        offline: 0,
        join_rate: 0,
        leave_rate: 0
      },
      tasks: {
        total: 0,
        pending: 0,
        completed: 0,
        failed: 0,
        success_rate: 0,
        avg_execution_time: 0
      },
      requests: {
        total: 0,
        success: 0,
        error: 0,
        success_rate: 0
      },
      latency: {
        average: 0,
        max: 0,
        min: 0
      },
      websocket: {
        connections: 0,
        messages_sent: 0,
        messages_received: 0,
        connection_rate: 0,
        disconnection_rate: 0
      },
      memory: {
        heap_used: 0,
        heap_total: 0,
        heap_max: 0,
        rss: 0,
        external: 0
      },
      cpu: {
        usage: 0,
        cores: os.cpus().length
      },
      network: {
        bytes_sent: 0,
        bytes_received: 0,
        packets_sent: 0,
        packets_received: 0
      },
      database: {
        connections: 0,
        queries: 0,
        query_time: 0
      },
      skills: {
        total: 0,
        invocations: 0,
        avg_execution_time: 0,
        success_rate: 0
      },
      billing: {
        transactions: 0,
        amount: 0,
        avg_transaction_amount: 0
      }
    };
    this.startTime = Date.now();
    this.lastCpuUsage = process.cpuUsage();
    this.lastNetworkStats = { bytesSent: 0, bytesReceived: 0 };
  }

  async init() {
    this.redisClient = await getRedis();
    this._alertCheckInterval = setInterval(async () => {
      try {
        const { default: alertManager } = await import('./alerts.js');
        const currentMetrics = await this.getMetrics();
        await alertManager.checkAllMetrics(currentMetrics);
      } catch (e) {}
    }, parseInt(process.env.ALERT_CHECK_INTERVAL || '60000'));
  }

  // 更新节点指标
  async updateNodeMetrics() {
    try {
      const onlineNodes = await this.redisClient.smembers('online_nodes');
      this.metrics.nodes.online = onlineNodes.length;

      const pgPool = getPostgres();
      const result = await pgPool.query('SELECT COUNT(*)::int AS count FROM nodes');
      this.metrics.nodes.total = result.rows[0]?.count ?? onlineNodes.length;
      this.metrics.nodes.offline = this.metrics.nodes.total - this.metrics.nodes.online;
    } catch (error) {
      console.error('Error updating node metrics:', error);
    }
  }

  // 更新任务指标
  async updateTaskMetrics() {
    try {
      const pgPool = getPostgres();
      const result = await pgPool.query(
        'SELECT status, COUNT(*)::int AS count FROM tasks GROUP BY status'
      );
      let total = 0, pending = 0, completed = 0, failed = 0;
      for (const row of result.rows) {
        total += row.count;
        if (row.status === 'pending') pending = row.count;
        else if (row.status === 'completed') completed = row.count;
        else if (row.status === 'failed') failed = row.count;
      }
      this.metrics.tasks.total = total;
      this.metrics.tasks.pending = pending;
      this.metrics.tasks.completed = completed;
      this.metrics.tasks.failed = failed;
      this.metrics.tasks.success_rate = total > 0 ? (completed / total) * 100 : 0;
    } catch (error) {
      console.error('Error updating task metrics:', error);
    }
  }

  // 记录请求
  recordRequest(success, latency) {
    this.metrics.requests.total++;
    if (success) {
      this.metrics.requests.success++;
    } else {
      this.metrics.requests.error++;
    }
    
    // 更新成功率
    this.metrics.requests.success_rate = (this.metrics.requests.success / this.metrics.requests.total) * 100;
    
    // 更新延迟指标
    if (latency) {
      this.metrics.latency.average = (
        this.metrics.latency.average * (this.metrics.requests.total - 1) + latency
      ) / this.metrics.requests.total;
      this.metrics.latency.max = Math.max(this.metrics.latency.max, latency);
      this.metrics.latency.min = Math.min(this.metrics.latency.min || latency, latency);
    }
  }

  // 更新 WebSocket 指标
  updateWebSocketMetrics(connections, messagesSent, messagesReceived) {
    this.metrics.websocket.connections = connections;
    this.metrics.websocket.messages_sent = messagesSent;
    this.metrics.websocket.messages_received = messagesReceived;
  }

  // 记录 WebSocket 连接
  recordWebSocketConnection() {
    this.metrics.websocket.connection_rate++;
  }

  // 记录 WebSocket 断开连接
  recordWebSocketDisconnection() {
    this.metrics.websocket.disconnection_rate++;
  }

  // 更新系统指标
  updateSystemMetrics() {
    // 更新内存指标
    const memoryUsage = process.memoryUsage();
    this.metrics.memory.heap_used = memoryUsage.heapUsed;
    this.metrics.memory.heap_total = memoryUsage.heapTotal;
    this.metrics.memory.heap_max = memoryUsage.heapTotal;
    this.metrics.memory.rss = memoryUsage.rss;
    this.metrics.memory.external = memoryUsage.external;

    // 更新 CPU 指标
    const currentCpuUsage = process.cpuUsage();
    const cpuDiff = {
      user: currentCpuUsage.user - this.lastCpuUsage.user,
      system: currentCpuUsage.system - this.lastCpuUsage.system
    };
    const elapsedMs = Date.now() - this.startTime;
    const cpuUsagePercent = ((cpuDiff.user + cpuDiff.system) / (elapsedMs * 1000)) * 100;
    this.metrics.cpu.usage = Math.min(cpuUsagePercent, 100);
    this.lastCpuUsage = currentCpuUsage;
    this.startTime = Date.now();
  }

  async updateNetworkMetrics() {
    try {
      if (!this.redisClient) return;
      const info = await this.redisClient.info('stats');
      const match = info.match(/total_net_output_bytes:(\d+)/);
      if (match) this.metrics.network.bytes_sent = parseInt(match[1]);
      const matchIn = info.match(/total_net_input_bytes:(\d+)/);
      if (matchIn) this.metrics.network.bytes_received = parseInt(matchIn[1]);
    } catch (error) {
      console.error('Error updating network metrics:', error);
    }
  }

  async updateDatabaseMetrics() {
    try {
      const pgPool = getPostgres();
      this.metrics.database.connections = pgPool.totalCount || 0;
      this.metrics.database.queries = this.metrics.requests.total;
      this.metrics.database.query_time = this.metrics.latency.average;
    } catch (error) {
      console.error('Error updating database metrics:', error);
    }
  }

  // 更新技能指标
  updateSkillMetrics(total, invocations, avgExecutionTime, successRate) {
    this.metrics.skills.total = total;
    this.metrics.skills.invocations = invocations;
    this.metrics.skills.avg_execution_time = avgExecutionTime;
    this.metrics.skills.success_rate = successRate;
  }

  // 更新计费指标
  async updateBillingMetrics() {
    try {
      const pgPool = getPostgres();
      const result = await pgPool.query(
        'SELECT COUNT(*)::int AS transactions, COALESCE(SUM(amount), 0)::numeric AS amount FROM transactions'
      );
      const row = result.rows[0];
      const transactions = row.transactions;
      const amount = parseFloat(row.amount);
      this.metrics.billing.transactions = transactions;
      this.metrics.billing.amount = amount;
      this.metrics.billing.avg_transaction_amount = transactions > 0 ? amount / transactions : 0;
    } catch (error) {
      console.error('Error updating billing metrics:', error);
    }
  }

  // 获取所有指标
  async getMetrics() {
    await this.updateNodeMetrics();
    await this.updateTaskMetrics();
    await this.updateBillingMetrics();
    await this.updateNetworkMetrics();
    await this.updateDatabaseMetrics();
    this.updateSystemMetrics();
    
    return this.metrics;
  }

  // 获取节点指标
  async getNodeMetrics() {
    await this.updateNodeMetrics();
    return this.metrics.nodes;
  }

  // 获取任务指标
  async getTaskMetrics() {
    await this.updateTaskMetrics();
    return this.metrics.tasks;
  }

  // 获取请求指标
  getRequestMetrics() {
    return this.metrics.requests;
  }

  // 获取延迟指标
  getLatencyMetrics() {
    return this.metrics.latency;
  }

  // 获取 WebSocket 指标
  getWebSocketMetrics() {
    return this.metrics.websocket;
  }

  // 获取系统指标
  getSystemMetrics() {
    this.updateSystemMetrics();
    return {
      memory: this.metrics.memory,
      cpu: this.metrics.cpu
    };
  }

  // 获取网络指标
  getNetworkMetrics() {
    return this.metrics.network;
  }

  // 获取数据库指标
  getDatabaseMetrics() {
    return this.metrics.database;
  }

  // 获取技能指标
  getSkillMetrics() {
    return this.metrics.skills;
  }

  // 获取计费指标
  async getBillingMetrics() {
    await this.updateBillingMetrics();
    return this.metrics.billing;
  }
}
