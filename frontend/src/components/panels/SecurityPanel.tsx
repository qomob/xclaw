import { useState, useEffect, useCallback } from 'react';
import {
  fetchSecurityStats,
  fetchOAuthClients,
  fetchAuditLogs,
  fetchAuditStats,
  fetchRateLimits,
} from '../../utils/api';
import { useI18n } from '../../i18n/LanguageContext';

interface SecurityStatsData {
  total_requests: number;
  blocked_requests: number;
  active_tokens: number;
  oauth_clients: number;
}

interface OAuthClient {
  id: string;
  name: string;
  redirect_uris: string[];
  grant_types: string[];
  created_at: string;
}

interface AuditLog {
  id: string;
  action: string;
  actor: string;
  resource: string;
  status: string;
  timestamp: string;
  details?: string;
}

interface RateLimitEntry {
  endpoint: string;
  limit: number;
  window: string;
  current: number;
}

export default function SecurityPanel() {
  const { t } = useI18n();
  const [stats, setStats] = useState<SecurityStatsData | null>(null);
  const [auditStats, setAuditStats] = useState<{ total: number; today: number; critical: number } | null>(null);
  const [clients, setClients] = useState<OAuthClient[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [rateLimits, setRateLimits] = useState<RateLimitEntry[]>([]);

  const loadData = useCallback(async () => {
    try {
      const [statsRes, clientsRes, logsRes, auditRes, rlRes] = await Promise.allSettled([
        fetchSecurityStats(),
        fetchOAuthClients(),
        fetchAuditLogs(50),
        fetchAuditStats(),
        fetchRateLimits(),
      ]);
      if (statsRes.status === 'fulfilled') setStats(statsRes.value.data ?? statsRes.value);
      if (clientsRes.status === 'fulfilled') setClients(clientsRes.value.data?.clients ?? clientsRes.value.data ?? []);
      if (logsRes.status === 'fulfilled') setLogs(logsRes.value.data?.logs ?? logsRes.value.data ?? []);
      if (auditRes.status === 'fulfilled') setAuditStats(auditRes.value.data ?? auditRes.value);
      if (rlRes.status === 'fulfilled') setRateLimits(rlRes.value.data?.limits ?? rlRes.value.data ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-l-4 border-red-500 pl-4">
        <h2 className="text-xl font-bold text-white">{t('secCompTitle')}</h2>
        <p className="text-sm text-slate-400 mt-1">{t('secCompDesc')}</p>
      </div>

      {/* Security Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Requests', value: stats?.total_requests ?? '—', color: 'text-red-400' },
          { label: 'Blocked Requests', value: stats?.blocked_requests ?? '—', color: 'text-amber-400' },
          { label: 'Active Tokens', value: stats?.active_tokens ?? '—', color: 'text-emerald-400' },
          { label: 'OAuth Clients', value: stats?.oauth_clients ?? '—', color: 'text-sky-400' },
        ].map(c => (
          <div key={c.label} className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
            <div className="text-xs text-slate-500 uppercase tracking-wider">{c.label}</div>
            <div className={`text-3xl font-bold mt-1 ${c.color}`}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Audit Stats */}
      {auditStats && (
        <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
          <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('secAuditStats')}</h3>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg bg-gray-900/50 p-3 text-center">
              <div className="text-xs text-slate-500">{t('secTotalEvents')}</div>
              <div className="text-xl font-bold text-red-400">{auditStats.total}</div>
            </div>
            <div className="rounded-lg bg-gray-900/50 p-3 text-center">
              <div className="text-xs text-slate-500">{t('secEventsToday')}</div>
              <div className="text-xl font-bold text-amber-400">{auditStats.today}</div>
            </div>
            <div className="rounded-lg bg-gray-900/50 p-3 text-center">
              <div className="text-xs text-slate-500">{t('secCriticalEvents')}</div>
              <div className="text-xl font-bold text-red-500">{auditStats.critical}</div>
            </div>
          </div>
        </div>
      )}

      {/* OAuth2 Clients */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('secOAuthClients')} ({clients.length})</h3>
        {clients.length > 0 ? (
          <div className="bg-gray-900/50 rounded-lg overflow-x-auto">
            <table className="w-full text-sm min-w-[500px]">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('pnlName')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('secRedirectUris')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('secGrantTypes')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('devCreatedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {clients.map(c => (
                  <tr key={c.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="py-2 px-3 text-red-300 font-medium">{c.name}</td>
                    <td className="py-2 px-3 text-slate-400 font-mono text-xs max-w-xs truncate">
                      {c.redirect_uris?.join(', ') || '—'}
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex gap-1 flex-wrap">
                        {c.grant_types?.map((g, i) => (
                          <span key={i} className="px-1.5 py-0.5 text-xs bg-red-500/15 text-red-300 rounded">{g}</span>
                        ))}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-slate-500 text-xs whitespace-nowrap">
                      {new Date(c.created_at).toLocaleDateString('zh-CN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-6 text-slate-600 text-sm">{t('secNoClients')}</div>
        )}
      </div>

      {/* Audit Logs */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('secAuditLogs')}</h3>
        {logs.length > 0 ? (
          <div className="bg-gray-900/50 rounded-lg overflow-x-auto">
            <table className="w-full text-sm min-w-[500px]">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('pnlTime')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('secOperator')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('secAction')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('secResource')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('pnlStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.slice(0, 30).map((log, i) => (
                  <tr key={log.id || i} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="py-2 px-3 text-slate-500 text-xs whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="py-2 px-3 text-slate-300 font-mono text-xs">{log.actor}</td>
                    <td className="py-2 px-3 text-slate-300 text-xs">{log.action}</td>
                    <td className="py-2 px-3 text-slate-400 text-xs max-w-xs truncate">{log.resource}</td>
                    <td className="py-2 px-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${log.status === 'success' ? 'bg-green-500/20 text-green-400' : log.status === 'denied' ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'}`}>
                        {log.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-6 text-slate-600 text-sm">{t('secNoAudit')}</div>
        )}
      </div>

      {/* Rate Limits */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('secRateLimiting')}</h3>
        {rateLimits.length > 0 ? (
          <div className="bg-gray-900/50 rounded-lg overflow-x-auto">
            <table className="w-full text-sm min-w-[450px]">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('secEndpoint')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('secLimit')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('secWindow')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('secCurrentUsage')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('secUsage')}</th>
                </tr>
              </thead>
              <tbody>
                {rateLimits.map((rl, i) => {
                  const usage = rl.limit > 0 ? (rl.current / rl.limit) * 100 : 0;
                  return (
                    <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                      <td className="py-2 px-3 text-red-300 font-mono text-xs">{rl.endpoint}</td>
                      <td className="py-2 px-3 text-slate-400">{rl.limit}</td>
                      <td className="py-2 px-3 text-slate-400">{rl.window}</td>
                      <td className="py-2 px-3 text-slate-400">{rl.current}</td>
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-gray-700 rounded-full h-2 max-w-[100px]">
                            <div
                              className={`h-2 rounded-full ${usage > 80 ? 'bg-red-500' : usage > 50 ? 'bg-amber-500' : 'bg-green-500'}`}
                              style={{ width: `${Math.min(usage, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs text-slate-400">{usage.toFixed(0)}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-6 text-slate-600 text-sm">{t('secNoRateLimit')}</div>
        )}
      </div>
    </div>
  );
}
