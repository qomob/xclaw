// 配置中心：全部来自环境变量，未配置时给出明确错误/降级
export const config = {
  port: parseInt(process.env.EXECUTOR_PORT || '9090', 10),

  // HMAC 密钥（与 XClaw WITHDRAWAL_EXECUTOR_SECRET 一致）
  secret: process.env.EXECUTOR_SECRET || '',

  // XClaw 回调基地址，如 https://your-domain/api/v1/payment/withdrawals
  callbackUrl: process.env.EXECUTOR_CALLBACK_URL || '',

  // 以太坊广播（未配置时进入模拟模式）
  rpcUrl: process.env.EXECUTOR_RPC_URL || '',
  privateKey: process.env.EXECUTOR_PRIVATE_KEY || '',

  // 回调重试
  callbackMaxRetries: parseInt(process.env.EXECUTOR_CALLBACK_MAX_RETRIES || '5', 10),
  callbackTimeoutMs: parseInt(process.env.EXECUTOR_CALLBACK_TIMEOUT_MS || '15000', 10),

  // 幂等持久化文件（生产建议替换为 Redis/Postgres，见 store.js 注释）
  stateFile: process.env.EXECUTOR_STATE_FILE || new URL('../data/state.json', import.meta.url).pathname,
};

export function requireSecret() {
  if (!config.secret) {
    throw new Error('EXECUTOR_SECRET 未配置');
  }
}

