// 账本对账：校验「账本余额 ↔ 交易流水 ↔ 托管/保证金状态」的一致性。
// 只读检查，不做自动修正（资金修正必须人工介入并有审计记录）。
import { getPostgres } from '../core/dependencies.js';
import logger from './loggerService.js';

// 交易类型对 billing_accounts.balance 的方向（+1 增 / -1 减 / 0 无影响）
// 注意：withdrawal_fee 存的是负数金额，统一按绝对值乘方向计算。
export const BALANCE_EFFECT = {
  topup: +1,
  deposit: +1,
  sandbox_grant: +1,
  node_reward: +1,
  escrow_refund: +1,
  escrow_release: +1,
  stake_release: +1,
  stake_compensation: +1,
  withdrawal_refund: +1,
  escrow_hold: -1,
  task: -1,
  deduction: -1,
  stake_hold: -1,
  withdrawal: -1,
  withdrawal_fee: -1,
  // 记录型（不改变余额）
  skill_commission: 0,
  stake_slash: 0,
};

function buildEffectCaseSql() {
  const whens = Object.entries(BALANCE_EFFECT)
    .map(([type, sign]) => `WHEN '${type}' THEN ${sign} * ABS(amount)`)
    .join(' ');
  return `CASE type ${whens} ELSE NULL END`;
}

/**
 * 执行对账，返回结构化报告。
 * issues 非空即表示存在需要人工核对的漂移。
 */
export async function runReconciliation({ sampleLimit = 20 } = {}) {
  const pool = getPostgres();
  const report = {
    checked_at: new Date().toISOString(),
    ok: true,
    issues: [],
    details: {}
  };

  try {
    // 1) 全站托管不变量：billing_accounts.escrow_balance 合计 == held 状态任务的 escrow_amount 合计
    const escrow = await pool.query(`
      SELECT
        (SELECT COALESCE(SUM(escrow_balance), 0) FROM billing_accounts)::numeric AS account_total,
        (SELECT COALESCE(SUM(escrow_amount), 0) FROM tasks WHERE escrow_status = 'held')::numeric AS task_total
    `);
    const escrowDiff = Number(escrow.rows[0].account_total) - Number(escrow.rows[0].task_total);
    report.details.escrow = {
      account_total: Number(escrow.rows[0].account_total),
      task_total: Number(escrow.rows[0].task_total),
      diff: escrowDiff
    };
    if (Math.abs(escrowDiff) > 0.001) {
      report.issues.push({
        type: 'escrow_balance_mismatch',
        severity: 'critical',
        message: `托管账目不平：账户侧 ${escrow.rows[0].account_total}，任务侧 ${escrow.rows[0].task_total}`,
        diff: escrowDiff
      });
    }

    // 2) 全站保证金不变量
    const stake = await pool.query(`
      SELECT
        (SELECT COALESCE(SUM(stake_balance), 0) FROM billing_accounts)::numeric AS account_total,
        (SELECT COALESCE(SUM(stake_amount), 0) FROM tasks WHERE stake_status = 'held')::numeric AS task_total
    `);
    const stakeDiff = Number(stake.rows[0].account_total) - Number(stake.rows[0].task_total);
    report.details.stake = {
      account_total: Number(stake.rows[0].account_total),
      task_total: Number(stake.rows[0].task_total),
      diff: stakeDiff
    };
    if (Math.abs(stakeDiff) > 0.001) {
      report.issues.push({
        type: 'stake_balance_mismatch',
        severity: 'critical',
        message: `保证金账目不平：账户侧 ${stake.rows[0].account_total}，任务侧 ${stake.rows[0].task_total}`,
        diff: stakeDiff
      });
    }

    // 3) 负余额（任何科目为负都说明扣款/冻结路径有 bug）
    const negative = await pool.query(`
      SELECT node_id, balance, escrow_balance, stake_balance, sandbox_balance
        FROM billing_accounts
       WHERE balance < 0 OR escrow_balance < 0 OR stake_balance < 0 OR sandbox_balance < 0
       LIMIT $1
    `, [sampleLimit]);
    if (negative.rows.length > 0) {
      report.issues.push({
        type: 'negative_balance',
        severity: 'critical',
        message: `发现 ${negative.rows.length} 个负余额账户`,
        samples: negative.rows
      });
    }

    // 4) 资金卡死：终态任务仍持有托管/保证金（无任何流程会再释放）
    const stuckEscrow = await pool.query(`
      SELECT id, status, escrow_status, escrow_amount, caller_id, node_id
        FROM tasks
       WHERE escrow_status = 'held'
         AND status IN ('completed', 'failed', 'cancelled', 'disputed')
       LIMIT $1
    `, [sampleLimit]);
    if (stuckEscrow.rows.length > 0) {
      report.issues.push({
        type: 'stuck_escrow',
        severity: 'high',
        message: `发现 ${stuckEscrow.rows.length} 个终态任务仍持有托管资金`,
        samples: stuckEscrow.rows
      });
    }

    const stuckStake = await pool.query(`
      SELECT id, status, stake_status, stake_amount, node_id
        FROM tasks
       WHERE stake_status = 'held'
         AND status IN ('completed', 'failed', 'cancelled', 'disputed')
       LIMIT $1
    `, [sampleLimit]);
    if (stuckStake.rows.length > 0) {
      report.issues.push({
        type: 'stuck_stake',
        severity: 'high',
        message: `发现 ${stuckStake.rows.length} 个终态任务仍冻结保证金`,
        samples: stuckStake.rows
      });
    }

    // 5) 余额 vs 流水（尽力而为）：按类型方向累计应当等于余额；
    //    未知类型（NULL 效应）会显式列出，避免把「漏记账」误判成漂移
    const effectCase = buildEffectCaseSql();
    const ledger = await pool.query(`
      SELECT ba.node_id, ba.balance,
             COALESCE(SUM(${effectCase}), 0)::numeric AS expected,
             COUNT(*) FILTER (WHERE ${effectCase} IS NULL)::int AS unmapped_rows
        FROM billing_accounts ba
        LEFT JOIN transactions t
               ON t.node_id = ba.node_id AND t.status = 'completed'
        GROUP BY ba.node_id, ba.balance
       HAVING ABS(ba.balance - COALESCE(SUM(${effectCase}), 0)) > 0.01
       ORDER BY ABS(ba.balance - COALESCE(SUM(${effectCase}), 0)) DESC
       LIMIT $1
    `, [sampleLimit]);
    report.details.ledger_variance = ledger.rows;
    // 说明：stake_slash 的调用方补偿、管理员手工调账等历史操作可能造成已知差异，
    // 因此以 warning 记录；对账以 1/2 两条不变量为准。
    if (ledger.rows.length > 0) {
      report.issues.push({
        type: 'ledger_variance',
        severity: 'warning',
        message: `发现 ${ledger.rows.length} 个账户余额与流水累计不一致（需人工核对）`,
        samples: ledger.rows
      });
    }

    report.ok = !report.issues.some(i => i.severity === 'critical');
    if (!report.ok) {
      logger.error('[Reconciliation] 对账发现严重漂移', { issues: report.issues.map(i => i.type) });
    } else if (report.issues.length > 0) {
      logger.warn('[Reconciliation] 对账存在告警项', { issues: report.issues.map(i => i.type) });
    } else {
      logger.info('[Reconciliation] 账本一致');
    }
  } catch (error) {
    report.ok = false;
    report.issues.push({ type: 'reconciliation_error', severity: 'critical', message: error.message });
    logger.error('[Reconciliation] 对账执行失败', { error: error.message });
  }

  return report;
}
