// 回调 XClaw：HMAC 签名 + 指数退避重试
import crypto from 'node:crypto';
import { config } from './config.js';

function sign(rawBody) {
  return crypto.createHmac('sha256', config.secret).update(rawBody).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 回调 XClaw 提现状态
 * @returns {Promise<{ok: boolean, attempts: number}>}
 */
export async function sendCallback(withdrawalId, { status, txHash = null, error = null }) {
  if (!config.callbackUrl) {
    console.warn(`[callback] EXECUTOR_CALLBACK_URL 未配置，跳过回调 ${withdrawalId} -> ${status}`);
    return { ok: false, attempts: 0 };
  }

  const body = Buffer.from(JSON.stringify({ status, tx_hash: txHash, error }));
  const signature = sign(body);
  const url = `${config.callbackUrl.replace(/\/+$/, '')}/${withdrawalId}/callback`;

  let attempts = 0;
  for (let i = 0; i < config.callbackMaxRetries; i++) {
    attempts++;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.callbackTimeoutMs);
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-XClaw-Signature': `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (resp.ok) {
        console.log(`[callback] ${withdrawalId} -> ${status} ok (HTTP ${resp.status})`);
        return { ok: true, attempts };
      }
      console.warn(`[callback] HTTP ${resp.status}，第 ${attempts} 次失败: ${(await resp.text()).slice(0, 200)}`);
    } catch (err) {
      console.warn(`[callback] 第 ${attempts} 次失败: ${err.message}`);
    }
    if (i < config.callbackMaxRetries - 1) {
      await sleep(1000 * 2 ** i); // 指数退避
    }
  }
  console.error(`[callback] ${withdrawalId} 回调失败（已重试 ${attempts} 次）`);
  return { ok: false, attempts };
}

