// 任务工作流
import { proxyActivities } from '@temporalio/workflow';

// 导入活动
const { executeTaskActivity } = proxyActivities({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '1 minute',
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
});

export async function taskWorkflow(taskId, skillId, payload, nodes) {
  let lastError = null;
  
  // 尝试在多个节点上执行任务
  for (const node of nodes) {
    try {
      console.log(`Attempting to execute task ${taskId} on node ${node.node_id || node.id}`);
      
      // 执行任务
      const result = await executeTaskActivity(taskId, node.node_id || node.id, skillId, payload);
      
      console.log(`Task ${taskId} completed successfully on node ${node.node_id || node.id}`);
      return {
        success: true,
        result,
        nodeId: node.node_id || node.id
      };
    } catch (error) {
      console.error(`Error executing task ${taskId} on node ${node.node_id || node.id}:`, error);
      lastError = error;
    }
  }
  
  // 所有节点都失败
  console.error(`Task ${taskId} failed on all nodes`);
  return {
    success: false,
    error: lastError?.message || 'All nodes failed',
    nodeId: null
  };
}