// 维护 Worker — 独立进程运行周期性后台任务（声誉重算、关系衰减、数据清理）
// 通过 Redis 分布式锁防止多副本重复执行
import { initPostgres, initRedis, closeConnections, getRedis, getPostgres } from '../core/dependencies.js';
import { ensureReputationTables, batchUpdateReputations } from '../services/reputationService.js';
import { decayRelationships } from '../services/relationshipService.js';
import { applyTrustDecay } from '../services/socialGraphService.js';
import { processVerificationDeadlines } from '../services/taskMarketService.js';
import logger from '../services/loggerService.js';

const INSTANCE_ID = process.env.INSTANCE_ID || 'maintenance';
const LOCK_PREFIX = 'xclaw:maintenance:lock:';
const LOCK_TTL_SECONDS = 600;

const INTERVALS = {
  reputation: parseInt(process.env.MAINT_REPUTATION_INTERVAL || '1800000', 10), // 30min
  decay: parseInt(process.env.MAINT_DECAY_INTERVAL || '3600000', 10),           // 60min
  cleanup: parseInt(process.env.MAINT_CLEANUP_INTERVAL || '86400000', 10),      // 24h
  verification: parseInt(process.env.VERIFICATION_PROCESS_INTERVAL || '60000', 10), // 1min
};

async function acquireLock(task) {
  const redis = getRedis();
  const ok = await redis.set(`${LOCK_PREFIX}${task}`, INSTANCE_ID, 'EX', LOCK_TTL_SECONDS, 'NX');
  return ok === 'OK';
}

async function releaseLock(task) {
  try {
    const redis = getRedis();
    await redis.del(`${LOCK_PREFIX}${task}`);
  } catch (_) {}
}

async function runWithLock(task, fn) {
  if (!(await acquireLock(task))) {
    logger.info('[Maintenance] Skipped (locked by another instance)', { task });
    return;
  }
  try {
    await fn();
    logger.info('[Maintenance] Completed', { task });
  } catch (err) {
    logger.error('[Maintenance] Failed', { task, error: err.message });
  } finally {
    await releaseLock(task);
  }
}

async function runReputation() {
  await ensureReputationTables();
  const results = await batchUpdateReputations({ batchSize: 100, onlyOnline: true });
  logger.info('[Maintenance] Reputation batch update', {
    total: results.length,
    errors: results.filter(r => r.error).length,
  });
}

async function runDecay() {
  const rel = await decayRelationships();
  const trust = await applyTrustDecay();
  logger.info('[Maintenance] Trust decay applied', { relationships: rel, trust });
}

async function runVerification() {
  const results = await processVerificationDeadlines(100);
  if (results.length > 0) {
    logger.info('[Maintenance] Verification deadlines processed', { count: results.length });
  }
}

async function runCleanup() {
  const pool = getPostgres();
  const cleanup = async (sql, label) => {
    const res = await pool.query(sql);
    logger.info('[Maintenance] Cleanup', { label, removed: res.rowCount });
  };
  const tableExists = async (table) => {
    const res = await pool.query('SELECT to_regclass($1) AS t', [table]);
    return res.rows[0]?.t !== null;
  };
  await cleanup(
    `DELETE FROM webhook_deliveries
      WHERE status IN ('dead', 'failed')
        AND updated_at < NOW() - INTERVAL '30 days'`,
    'webhook_deliveries'
  );
  if (await tableExists('reputation_events')) {
    await cleanup(
      `DELETE FROM reputation_events WHERE processed = TRUE AND created_at < NOW() - INTERVAL '90 days'`,
      'reputation_events'
    );
  }
  await cleanup(
    `DELETE FROM event_log WHERE created_at < NOW() - INTERVAL '30 days'`,
    'event_log'
  );
  await cleanup(
    `DELETE FROM metrics_snapshots WHERE created_at < NOW() - INTERVAL '30 days'`,
    'metrics_snapshots'
  );
  if (await tableExists('oauth_tokens')) {
    await cleanup(
      `DELETE FROM oauth_tokens WHERE expires_at < NOW()`,
      'oauth_tokens'
    );
  }
}

async function main() {
  await initPostgres();
  await initRedis();

  logger.info('[Maintenance] Worker started', { instance: INSTANCE_ID, intervals: INTERVALS });

  // 启动后立即执行一轮，之后按周期执行
  await runWithLock('reputation', runReputation);
  await runWithLock('decay', runDecay);
  await runWithLock('cleanup', runCleanup);
  await runWithLock('verification', runVerification);

  setInterval(() => runWithLock('reputation', runReputation), INTERVALS.reputation);
  setInterval(() => runWithLock('decay', runDecay), INTERVALS.decay);
  setInterval(() => runWithLock('cleanup', runCleanup), INTERVALS.cleanup);
  setInterval(() => runWithLock('verification', runVerification), INTERVALS.verification);
}

async function shutdown() {
  logger.info('[Maintenance] Shutting down');
  await closeConnections();
  process.exit(0);
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

main().catch(err => {
  logger.error('[Maintenance] Fatal', { error: err.message });
  process.exit(1);
});
