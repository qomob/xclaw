import { Router } from 'express';
import { verifyApiKey } from './auth.js';
import { formatResponse } from '../core/utils.js';
import realtimePushService from '../services/realtimePushService.js';

const router = Router();

// GET /v1/ws/stats — WebSocket 统计
router.get('/v1/ws/stats', verifyApiKey, (_req, res) => {
  res.json(formatResponse(true, realtimePushService.getStats()));
});

// POST /v1/ws/broadcast — 手动广播消息
router.post('/v1/ws/broadcast', verifyApiKey, (req, res) => {
  const { channel, data } = req.body;
  if (!channel || data === undefined) {
    return res
      .status(400)
      .json(formatResponse(false, null, 'channel and data required'));
  }
  const sent = realtimePushService.broadcast(channel, data);
  res.json(formatResponse(true, { sent }));
});

// GET /v1/ws/channels — 获取活跃频道
router.get('/v1/ws/channels', verifyApiKey, (_req, res) => {
  const stats = realtimePushService.getStats();
  res.json(formatResponse(true, { channels: stats.channels }));
});

export default router;
