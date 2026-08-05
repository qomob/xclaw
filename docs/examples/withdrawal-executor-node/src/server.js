// HTTP 服务：POST /broadcast（验签 + 幂等 + 广播 + 异步回调）、GET /health、GET /metrics
import express from 'express';
import crypto from 'node:crypto';
import { config, requireSecret } from './config.js';
import { isDuplicate, markProcessed, processedCount } from './store.js';
import { isLive, broadcastSimulated, broadcastEthers } from './broadcaster.js';
import { sendCallback } from './callback.js';

export function createApp() {
  requireSecret();
  const app = express();

  // Prometheus 风格监控计数（零依赖）
  const metrics = {
    http_requests_total: 0,
    dispatch_ok: 0,
    dispatch_duplicate: 0,
    dispatch_sig_fail: 0,
    broadcast_ok: 0,
    broadcast_fail: 0,
    callback_ok: 0,
    callback_fail: 0,
  };

  app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));

  app.post('/broadcast', async (req, res) => {
    metrics.http_requests_total++;
    const raw = req.rawBody.toString('utf8');
    const headerSig = req.headers['x-xclaw-signature'] || '';
    if (!verifySignature(raw, headerSig)) {
      metrics.dispatch_sig_fail++;
      return res.status(401).json({ error: 'invalid signature' });
    }

    const idem = req.headers['x-idempotency-key'] || req.body?.idempotency_key;
    if (isDuplicate(idem)) {
      metrics.dispatch_duplicate++;
      return res.json({ accepted: true, duplicate: true });
    }

    try {
      // 生产走真实广播；未配置 RPC/私钥时自动降级模拟
      const { txHash, simulated } = isLive()
        ? await broadcastEthers(req.body)
        : await broadcastSimulated(req.body);
      markProcessed(idem, txHash);
      metrics.dispatch_ok++;
      metrics.broadcast_ok++;

      // 异步回调（completed），失败重试在 callback.js 内
      const withdrawalId = req.body.withdrawal_id;
      queueMicrotask(async () => {
        const r = await sendCallback(withdrawalId, { status: 'completed', txHash });
        r.ok ? metrics.callback_ok++ : metrics.callback_fail++;
      });

      res.json({ accepted: true, reference: txHash, simulated });
    } catch (err) {
      metrics.dispatch_ok++;
      metrics.broadcast_fail++;
      console.error('[server] 广播失败:', err.message);
      res.status(502).json({ accepted: false, error: err.message });
    }
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      live_broadcast: isLive(),
      callback_url: Boolean(config.callbackUrl),
      processed: processedCount(),
    });
  });

  app.get('/metrics', (_req, res) => {
    const lines = Object.entries(metrics).map(([k, v]) => `${k} ${v}`);
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(lines.join('\n') + '\n');
  });

  return app;
}

function verifySignature(rawBody, signature) {
  if (!signature || !signature.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', config.secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature.slice('sha256='.length));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

