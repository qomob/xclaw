// Temporal 工作器
import { Worker } from '@temporalio/worker';
import * as taskActivities from '../activities/taskActivities.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runWorker() {
  try {
    const worker = await Worker.create({
      workflowsPath: resolve(__dirname, '../workflows/taskWorkflow.js'),
      activities: taskActivities,
      taskQueue: 'xclaw-tasks',
      // 本地开发配置
      // 生产环境需要配置 Temporal 服务地址
    });

    console.log('Temporal worker started');

    // 启动工作器
    await worker.run();
  } catch (error) {
    console.error('Failed to start Temporal worker:', error);
    process.exit(1);
  }
}

// 检查是否作为主模块运行
if (process.argv[1] === __filename) {
  runWorker();
}

export default runWorker;