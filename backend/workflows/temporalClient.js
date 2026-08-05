class TemporalClient {
  constructor() {
    this.client = null;
    this.available = false;
  }

  async init() {
    try {
      if (!process.env.TEMPORAL_ADDRESS) {
        console.warn('TEMPORAL_ADDRESS 未配置，Temporal 工作流功能禁用');
        this.available = false;
        return;
      }
      const { Client, Connection } = await import('@temporalio/client');
      const connection = await Connection.connect({
        address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
      });
      this.client = new Client({
        connection,
        namespace: 'xclaw',
      });
      this.available = true;
      console.log('Temporal client connected');
    } catch (error) {
      console.warn('Temporal 不可用，任务工作流功能将禁用:', error.message);
      this.available = false;
    }
  }

  async startTaskWorkflow(taskId, skillId, payload, nodes) {
    if (!this.available) {
      throw new Error('Temporal 服务不可用');
    }

    try {
      const workflowId = `task-${taskId}`;
      const handle = await this.client.startWorkflow('taskWorkflow', {
        workflowId,
        taskId,
        skillId,
        payload,
        nodes
      }, {
        taskQueue: 'xclaw-tasks',
        workflowId
      });

      console.log(`Started workflow for task ${taskId}`);
      return handle;
    } catch (error) {
      console.error('Failed to start workflow:', error);
      throw error;
    }
  }

  async getWorkflowStatus(workflowId) {
    if (!this.available) {
      throw new Error('Temporal 服务不可用');
    }

    try {
      const handle = this.client.getWorkflowHandle(workflowId);
      const status = await handle.describe();
      return status;
    } catch (error) {
      console.error('Failed to get workflow status:', error);
      throw error;
    }
  }

  async cancelWorkflow(workflowId) {
    if (!this.available) {
      throw new Error('Temporal 服务不可用');
    }

    try {
      const handle = this.client.getWorkflowHandle(workflowId);
      await handle.cancel();
      console.log(`Canceled workflow ${workflowId}`);
    } catch (error) {
      console.error('Failed to cancel workflow:', error);
      throw error;
    }
  }
}

export default new TemporalClient();
