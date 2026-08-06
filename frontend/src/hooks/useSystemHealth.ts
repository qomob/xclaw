import { useEffect, useState, useCallback } from 'react';
import { request } from '../utils/api';

export interface SystemHealth {
  /** 后端服务是否可响应（/health 返回 ok） */
  backend: 'ok' | 'down';
  database: 'up' | 'down';
  redis: 'up' | 'down';
  /** 三态汇总：ok / degraded / down */
  status: 'ok' | 'degraded' | 'down';
  /** 在线 Agent 数量（来自 /v1/agents/online） */
  agentsOnline: number;
  lastCheck: number | null;
  checking: boolean;
}

const DEFAULT_POLL_MS = 20_000;

/**
 * 轮询后端健康状态与在线 Agent 数量。
 * 所有状态均来自真实接口，不再使用硬编码“NETWORK NOMINAL”之类的文案。
 */
export function useSystemHealth(pollMs: number = DEFAULT_POLL_MS): SystemHealth {
  const [state, setState] = useState<SystemHealth>({
    backend: 'down',
    database: 'down',
    redis: 'down',
    status: 'down',
    agentsOnline: 0,
    lastCheck: null,
    checking: true,
  });

  const check = useCallback(async () => {
    const startedAt = Date.now();
    try {
      const [healthRes, agentsRes] = await Promise.allSettled([
        request('/health'),
        request('/v1/agents/online'),
      ]);

      let backend: SystemHealth['backend'] = 'down';
      let database: SystemHealth['database'] = 'down';
      let redis: SystemHealth['redis'] = 'down';
      let agentsOnline = 0;

      if (healthRes.status === 'fulfilled') {
        const data = healthRes.value as { status?: string; services?: { database?: string; redis?: string } };
        backend = data?.status === 'ok' ? 'ok' : 'down';
        database = data?.services?.database === 'up' ? 'up' : 'down';
        redis = data?.services?.redis === 'up' ? 'up' : 'down';
      }
      if (agentsRes.status === 'fulfilled') {
        const data = agentsRes.value as { success?: boolean; data?: unknown[] };
        if (data?.success && Array.isArray(data.data)) {
          agentsOnline = data.data.length;
        }
      }

      const status: SystemHealth['status'] =
        backend === 'ok' && database === 'up' && redis === 'up'
          ? 'ok'
          : backend === 'down'
            ? 'down'
            : 'degraded';

      setState({
        backend,
        database,
        redis,
        status,
        agentsOnline,
        lastCheck: startedAt,
        checking: false,
      });
    } catch {
      setState(s => ({
        ...s,
        backend: 'down',
        database: 'down',
        redis: 'down',
        status: 'down',
        lastCheck: startedAt,
        checking: false,
      }));
    }
  }, []);

  useEffect(() => {
    check();
    const id = setInterval(check, pollMs);
    return () => clearInterval(id);
  }, [check, pollMs]);

  return state;
}
