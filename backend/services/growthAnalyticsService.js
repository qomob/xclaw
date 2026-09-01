// 增长分析服务（迭代 0）
//
// 唯一北极星指标 OWTU（Organic Weekly Transactions，自然周成交数）：
//   近一周 escrow_release 结算笔数，且任务 caller 的资金来源包含
//   非管理员注入（sandbox_grant / deposit）。
//   管理员 topup 资助的脚本流量（冒烟测试、运维自测）不计入——
//   该指标存在的意义就是把"管道通了"和"市场存在"区分开。
//
// 漏斗（30 天）：注册 → 发现(discovery) → 需求意图(task.created/order_created)
//   → 成交(task.completed) → 复购(caller 结算 ≥2 次)
import { getPostgres } from '../core/dependencies.js';
import logger from './loggerService.js';

// 资金来源类型 → 是否自然（非管理员）注入。
// topup 仅管理员可发起（/v1/billing/topup requireAdmin），视为非自然。
const ORGANIC_FUNDING_TYPES = ['sandbox_grant', 'deposit'];

// escrow_release 的 confirmed 状态：管理员线下确认的入账 deposit 记为 confirmed
const ORGANIC_FUNDING_STATUS = ['completed', 'confirmed'];

function organicFundingExistsCte(callerColumn) {
  return `EXISTS (
    SELECT 1 FROM transactions f
     WHERE f.node_id = ${callerColumn}
       AND f.type = ANY($1)
       AND f.status = ANY($2)
  )`;
}

/**
 * OWTU 周序列（默认近 8 周）
 */
async function getOwtuWeekly(weeks) {
  const pool = getPostgres();
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('week', r.created_at), 'YYYY-MM-DD') AS week_start,
            COUNT(*)::int AS total_settlements,
            COUNT(*) FILTER (WHERE ${organicFundingExistsCte('tk.caller_id')})::int AS organic_settlements,
            COALESCE(SUM(r.amount) FILTER (WHERE ${organicFundingExistsCte('tk.caller_id')}), 0)::float AS organic_volume
       FROM transactions r
       JOIN tasks tk ON tk.id = r.task_id
      WHERE r.type = 'escrow_release'
        AND r.status = 'completed'
        AND r.created_at >= date_trunc('week', NOW()) - ($3::int - 1) * INTERVAL '7 days'
      GROUP BY 1
      ORDER BY 1`,
    [ORGANIC_FUNDING_TYPES, ORGANIC_FUNDING_STATUS, weeks]
  );
  return rows;
}

/**
 * 30 天漏斗：注册 → 发现 → 需求意图 → 成交 → 复购
 */
async function getFunnel30d() {
  const pool = getPostgres();
  const { rows: funnel } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE event_type = 'agent.registered')::int AS registrations,
       COUNT(*) FILTER (WHERE event_type = 'skill.discovered')::int AS discoveries,
       COUNT(*) FILTER (WHERE event_type = 'task.created')::int AS market_tasks_created,
       COUNT(*) FILTER (WHERE event_type = 'marketplace.order_created')::int AS orders_created,
       COUNT(*) FILTER (WHERE event_type = 'task.completed')::int AS settlements
       FROM event_log
      WHERE created_at >= NOW() - INTERVAL '30 days'`
  );

  // 复购：30 天内结算 ≥2 次的 caller 占比
  const { rows: repeat } = await pool.query(
    `SELECT COUNT(*)::int AS callers_total,
            COUNT(*) FILTER (WHERE settles >= 2)::int AS callers_repeat
       FROM (
         SELECT tk.caller_id, COUNT(*) AS settles
           FROM transactions r
           JOIN tasks tk ON tk.id = r.task_id
          WHERE r.type = 'escrow_release'
            AND r.status = 'completed'
            AND r.created_at >= NOW() - INTERVAL '30 days'
          GROUP BY tk.caller_id
       ) s`
  );

  // 30 天资金来源结构：自然注入 vs 管理员注入（判断经济是否还靠输血）
  const { rows: funding } = await pool.query(
    `SELECT type,
            COUNT(*)::int AS count,
            COALESCE(SUM(amount), 0)::float AS total_amount
       FROM transactions
      WHERE type = ANY($1)
        AND status = ANY($2)
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY type
      ORDER BY type`,
    [[...ORGANIC_FUNDING_TYPES, 'topup'], [...ORGANIC_FUNDING_STATUS, 'completed']]
  );

  return {
    ...funnel[0],
    callers_total: repeat[0]?.callers_total ?? 0,
    callers_repeat: repeat[0]?.callers_repeat ?? 0,
    funding_mix: funding
  };
}

/**
 * 汇总：管理台一张卡片所需的全部数据
 */
export async function getGrowthOverview({ weeks = 8 } = {}) {
  try {
    const weekly = await getOwtuWeekly(weeks);
    const current = weekly.length ? weekly[weekly.length - 1].organic_settlements : 0;
    const prev = weekly.length > 1 ? weekly[weekly.length - 2].organic_settlements : 0;
    const funnel = await getFunnel30d();

    return {
      success: true,
      data: {
        // 北极星：本周自然成交、上周对比、环比
        owtu: {
          current_week: current,
          prev_week: prev,
          delta_pct: prev > 0 ? Math.round(((current - prev) / prev) * 100) : (current > 0 ? 100 : 0),
          weekly
        },
        funnel_30d: {
          ...funnel,
          repeat_rate: funnel.callers_total > 0
            ? Math.round((funnel.callers_repeat / funnel.callers_total) * 100)
            : 0
        },
        // 指标口径随代码一起注释化，供管理台展示与后续审计
        definition: {
          owtu: '自然周结算数（caller 资金来源含 sandbox_grant/deposit，排除纯管理员 topup 流量）',
          organic_funding_types: ORGANIC_FUNDING_TYPES
        },
        generated_at: new Date().toISOString()
      }
    };
  } catch (error) {
    logger.error('Growth analytics failed', { error: error.message });
    return { success: false, error: '增长统计查询失败' };
  }
}
