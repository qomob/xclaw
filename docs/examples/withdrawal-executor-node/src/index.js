import { config } from './config.js';
import { initStore } from './store.js';
import { createApp } from './server.js';

initStore();

const app = createApp();
app.listen(config.port, () => {
  console.log(`[executor] listening on :${config.port}`);
  console.log(`[executor] callback: ${config.callbackUrl || '未配置'}`);
  console.log(`[executor] broadcast mode: ${process.env.EXECUTOR_RPC_URL && process.env.EXECUTOR_PRIVATE_KEY ? 'live (ethers)' : 'SIMULATED'}`);
});

