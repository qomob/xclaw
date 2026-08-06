import { useState, useEffect, useCallback } from 'react';
import A2APanel from './panels/A2APanel';
import SearchV2Panel from './panels/SearchV2Panel';
import MCPPanel from './panels/MCPPanel';
import DeveloperPanel from './panels/DeveloperPanel';
import SecurityPanel from './panels/SecurityPanel';
import {
  adminFetch,
  getStoredAdminKey,
  setStoredAdminKey,
  clearStoredAdminKey,
} from '../utils/adminApi';
import { useI18n } from '../i18n/LanguageContext';
import { fmtDateTime } from '../utils/format';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DashboardData {
  nodes?: { total: number; active: number };
  skills?: { total: number };
  tasks?: { total: number; completed: number; running: number };
  revenue?: { total: number; currency: string };
  today_events: number;
  active_webhooks: number;
}

interface AdminEvent {
  id: string;
  type: string;
  message: string;
  level: 'info' | 'warn' | 'error' | 'success';
  timestamp: string;
  source?: string;
}

interface HourBucket {
  hour: string;   // e.g. "14:00"
  count: number;
}

interface MonitorHealth {
  status: string;
  uptime: number;
  cpu_usage: number;
  memory_usage: number;
  disk_usage: number;
  active_connections: number;
}

interface DatabaseStats {
  total_connections: number;
  idle_connections: number;
  database_size_mb: number;
  tables: Array<{ name: string; row_count: number }>;
}

interface RedisInfo {
  used_memory: string;
  total_keys: number;
  connected_clients: number;
  uptime_seconds: number;
  ops_per_sec: number;
}

interface BusinessKPIs {
  total_nodes: number;
  online_nodes: number;
  total_tasks: number;
  completed_tasks: number;
  total_bids: number;
  federation_peers: number;
  avg_task_completion_time?: number;
  total_revenue?: number;
}

interface MonitorAlert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  timestamp: string;
  acknowledged: boolean;
}

/** Build mock hourly buckets from events for the last 24 hours */
function buildHourBuckets(events: AdminEvent[]): HourBucket[] {
  const now = new Date();
  const buckets: Map<string, number> = new Map();

  // Initialise 24 empty buckets
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600_000);
    const key = `${String(d.getHours()).padStart(2, '0')}:00`;
    buckets.set(key, 0);
  }

  for (const ev of events) {
    const t = new Date(ev.timestamp);
    const key = `${String(t.getHours()).padStart(2, '0')}:00`;
    if (buckets.has(key)) {
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
  }

  return Array.from(buckets.entries()).map(([hour, count]) => ({ hour, count }));
}

function formatRevenue(val: number): string {
  if (val >= 1_000_000) return `¥${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `¥${(val / 1_000).toFixed(1)}K`;
  return `¥${val.toFixed(2)}`;
}

function formatUptime(seconds: number): string {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const LEVEL_COLORS: Record<string, string> = {
  info: 'text-sky-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
  success: 'text-emerald-400',
};

const LEVEL_BG: Record<string, string> = {
  info: 'bg-sky-500/20',
  warn: 'bg-amber-500/20',
  error: 'bg-red-500/20',
  success: 'bg-emerald-500/20',
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState(getStoredAdminKey);
  const [inputKey, setInputKey] = useState('');
  const [authed, setAuthed] = useState(!!getStoredAdminKey());
  const [authError, setAuthError] = useState('');

  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [hourBuckets, setHourBuckets] = useState<HourBucket[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Monitor states
  const [monitorHealth, setMonitorHealth] = useState<MonitorHealth | null>(null);
  const [dbStats, setDbStats] = useState<DatabaseStats | null>(null);
  const [redisInfo, setRedisInfo] = useState<RedisInfo | null>(null);
  const [kpis, setKpis] = useState<BusinessKPIs | null>(null);
  const [monitorAlerts, setMonitorAlerts] = useState<MonitorAlert[]>([]);
  const [federationStatus, setFederationStatus] = useState<{ total_peers: number; active_peers: number } | null>(null);
  const [taskMarketStats, setTaskMarketStats] = useState<{ open_tasks: number; total_bids: number } | null>(null);

  // Tab state
  const [activeTab, setActiveTab] = useState('overview');

  const TABS = [
    { id: 'overview', label: t('admOverview'), color: 'cyan' },
    { id: 'monitor', label: t('admMonitor'), color: 'sky' },
    { id: 'federation', label: t('admFederation'), color: 'violet' },
    { id: 'taskmarket', label: t('admTaskMarket'), color: 'amber' },
    { id: 'disputes', label: t('admDisputeArbitration'), color: 'red' },
    { id: 'skillreviews', label: t('admSkillReviews'), color: 'green' },
    { id: 'settings', label: t('admSettings'), color: 'slate' },
    { id: 'a2a', label: t('prA2A'), color: 'purple' },
    { id: 'searchv2', label: t('prSearchV2'), color: 'cyan' },
    { id: 'mcp', label: t('prMCP'), color: 'green' },
    { id: 'developer', label: t('prDeveloper'), color: 'orange' },
    { id: 'security', label: t('admSecurityTab'), color: 'red' },
  ];

  // ─── Auth ────────────────────────────────────────────────────────────────

  const handleLogin = useCallback(async () => {
    setAuthError('');
    try {
      await adminFetch<{ success: boolean }>('/v1/admin/dashboard?check=1', inputKey.trim());
      setStoredAdminKey(inputKey.trim());
      setApiKey(inputKey.trim());
      setAuthed(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (msg === 'AUTH_FAILED') {
        setAuthError('Invalid API Key, please try again');
      } else {
        // If the endpoint just doesn't exist yet (backend in dev), accept key anyway
        setStoredAdminKey(inputKey.trim());
        setApiKey(inputKey.trim());
        setAuthed(true);
      }
    }
  }, [inputKey]);

  const handleLogout = useCallback(() => {
    clearStoredAdminKey();
    setApiKey('');
    setAuthed(false);
    setDashboard(null);
    setEvents([]);
  }, []);

  // ─── Data fetching ───────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    if (!apiKey) return;
    setLoading(true);
    setError('');
    try {
      const [dashRes, evRes] = await Promise.allSettled([
        adminFetch<{ data: DashboardData }>('/v1/admin/dashboard', apiKey),
        adminFetch<{ data: AdminEvent[] }>('/v1/admin/events?limit=20&offset=0', apiKey),
      ]);

      if (dashRes.status === 'fulfilled') {
        setDashboard(dashRes.value.data ?? (dashRes.value as unknown as DashboardData));
      }
      if (evRes.status === 'fulfilled') {
        const evData = evRes.value.data ?? (evRes.value as unknown as AdminEvent[]);
        setEvents(evData);
        setHourBuckets(buildHourBuckets(evData));
      }

      // 监控数据（后端 verifyApiKey 校验完整 API Key，统一走 adminFetch）
      Promise.allSettled([
        adminFetch<{ success: boolean; data: MonitorHealth }>('/v1/monitor/health', apiKey),
        adminFetch<{ success: boolean; data: DatabaseStats }>('/v1/monitor/database', apiKey),
        adminFetch<{ success: boolean; data: RedisInfo }>('/v1/monitor/redis', apiKey),
        adminFetch<{ success: boolean; data: BusinessKPIs }>('/v1/monitor/kpis', apiKey),
        adminFetch<{ success: boolean; data: MonitorAlert[] }>('/v1/monitor/alerts?limit=10', apiKey),
        adminFetch<{ success: boolean; data: { total_peers: number; active_peers: number } }>('/v1/federation/status', apiKey),
        adminFetch<{ success: boolean; data: { open_tasks: number; total_bids: number } }>('/v1/task-market/stats', apiKey),
      ]).then(([healthRes, dbRes, redisRes, kpiRes, alertsRes, fedRes, tmRes]) => {
        if (healthRes.status === 'fulfilled' && healthRes.value.success) setMonitorHealth(healthRes.value.data);
        if (dbRes.status === 'fulfilled' && dbRes.value.success) setDbStats(dbRes.value.data);
        if (redisRes.status === 'fulfilled' && redisRes.value.success) setRedisInfo(redisRes.value.data);
        if (kpiRes.status === 'fulfilled' && kpiRes.value.success) setKpis(kpiRes.value.data);
        if (alertsRes.status === 'fulfilled' && alertsRes.value.success) setMonitorAlerts(alertsRes.value.data || []);
        if (fedRes.status === 'fulfilled' && fedRes.value.success) setFederationStatus(fedRes.value.data);
        if (tmRes.status === 'fulfilled' && tmRes.value.success) setTaskMarketStats(tmRes.value.data);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (msg === 'AUTH_FAILED') {
        handleLogout();
        return;
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [apiKey, handleLogout]);

  useEffect(() => {
    if (authed) fetchData();
  }, [authed, fetchData]);

  // Auto-refresh every 30s
  useEffect(() => {
    if (!authed) return;
    const id = setInterval(fetchData, 30_000);
    return () => clearInterval(id);
  }, [authed, fetchData]);

  // ─── Render: Login Panel ─────────────────────────────────────────────────

  if (!authed) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-[#0B0F19] font-mono p-4">
        <div className="w-full max-w-xs sm:max-w-md p-6 sm:p-8 rounded-xl border border-slate-700/60 bg-[#111827]/90 shadow-2xl">
          <div className="flex flex-col items-center mb-6 sm:mb-8">
            <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center mb-3 sm:mb-4 shadow-lg shadow-cyan-500/30">
              <svg className="w-6 h-6 sm:w-8 sm:h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h1 className="text-lg sm:text-xl font-bold text-white tracking-wide">XClaw Admin Console</h1>
            <p className="text-slate-400 text-xs sm:text-sm mt-1">Enter admin API Key to continue</p>
          </div>

          {authError && (
            <div className="mb-4 px-3 py-2 rounded bg-red-500/20 border border-red-500/40 text-red-400 text-xs sm:text-sm text-center">
              {authError}
            </div>
          )}

          <div className="space-y-3 sm:space-y-4">
            <input
              type="password"
              value={inputKey}
              onChange={(e) => setInputKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
              placeholder="Enter Admin API Key"
              className="w-full px-3 sm:px-4 py-2.5 sm:py-3 rounded-lg bg-[#0B0F19] border border-slate-700 text-white placeholder-slate-400 text-sm focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30 transition-colors"
            />
            <button
              onClick={handleLogin}
              disabled={!inputKey.trim()}
              className="w-full py-2.5 sm:py-3 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 text-white font-semibold text-sm sm:text-base hover:from-cyan-500 hover:to-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Login
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Render: Dashboard ───────────────────────────────────────────────────

  const maxBucket = Math.max(...hourBuckets.map((b) => b.count), 1);

  const statCards = dashboard
    ? [
        { label: t('admTotalNodes'), value: dashboard.nodes?.total ?? '—', icon: '🖥', color: 'from-cyan-500 to-cyan-700' },
        { label: t('admTotalSkills'), value: dashboard.skills?.total ?? '—', icon: '⚡', color: 'from-blue-500 to-blue-700' },
        { label: t('admTotalTasks'), value: dashboard.tasks?.total ?? '—', icon: '📋', color: 'from-violet-500 to-violet-700' },
        { label: t('admTotalRevenue'), value: formatRevenue(dashboard.revenue?.total ?? 0), icon: '💰', color: 'from-emerald-500 to-emerald-700' },
      ]
    : [
        { label: t('admTotalNodes'), value: '—', icon: '🖥', color: 'from-cyan-500 to-cyan-700' },
        { label: t('admTotalSkills'), value: '—', icon: '⚡', color: 'from-blue-500 to-blue-700' },
        { label: t('admTotalTasks'), value: '—', icon: '📋', color: 'from-violet-500 to-violet-700' },
        { label: t('admTotalRevenue'), value: '—', icon: '💰', color: 'from-emerald-500 to-emerald-700' },
      ];

  return (
    <div className="min-h-screen w-full bg-[#0B0F19] text-slate-300 font-mono p-2 sm:p-4 md:p-6 lg:p-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-4 sm:mb-6 gap-3 sm:gap-4">
        <div>
          <h1 className="text-lg sm:text-2xl font-bold text-white tracking-wide">
            <span className="bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
              XClaw
            </span>{' '}
            Admin Dashboard
          </h1>
          <p className="text-slate-400 text-xs sm:text-sm mt-1">System Admin Console · Real-time Monitoring</p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={fetchData}
            className="px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs sm:text-sm text-slate-300 hover:bg-slate-700 transition-colors"
          >
            ↻ Refresh
          </button>
          <button
            onClick={handleLogout}
            className="px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg bg-red-900/40 border border-red-800/60 text-xs sm:text-sm text-red-400 hover:bg-red-900/60 transition-colors"
          >
            Logout
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-4 sm:mb-6 px-3 sm:px-4 py-2 sm:py-3 rounded-lg bg-red-500/15 border border-red-500/30 text-red-400 text-xs sm:text-sm">
          ⚠ Failed to load data: {error}
        </div>
      )}

      {/* Tab Navigation — Mobile: scrollable, Desktop: regular */}
      <div className="mb-4 sm:mb-6 border-b border-slate-700/60">
        <nav className="flex gap-1 overflow-x-auto no-scrollbar pb-px -mb-px">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-2.5 sm:px-4 py-2 sm:py-2.5 text-xs sm:text-sm font-medium rounded-t-lg whitespace-nowrap transition-colors shrink-0 ${
                activeTab === tab.id
                  ? `text-white bg-slate-800/60 border-b-2 border-${tab.color}-500`
                  : 'text-slate-400 hover:text-slate-300 hover:bg-slate-800/30'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* ─── New Panel Tabs ─── */}
      {activeTab === 'a2a' && <A2APanel />}
      {activeTab === 'searchv2' && <SearchV2Panel />}
      {activeTab === 'mcp' && <MCPPanel />}
      {activeTab === 'developer' && <DeveloperPanel />}
      {activeTab === 'security' && <SecurityPanel />}
      {activeTab === 'taskmarket' && <TaskMarketPanel stats={taskMarketStats} />}
      {activeTab === 'disputes' && <DisputesPanel apiKey={apiKey} />}
      {activeTab === 'skillreviews' && <SkillReviewsPanel apiKey={apiKey} />}

      {/* ─── Overview Tab Content ─── */}
      {activeTab === 'overview' && (<>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4 mb-4 sm:mb-6">
        {statCards.map((card) => (
          <div
            key={card.label}
            className="relative overflow-hidden rounded-lg sm:rounded-xl border border-slate-700/60 bg-[#111827] p-3 sm:p-5 group hover:border-slate-600 transition-colors"
          >
            <div className={`absolute top-0 right-0 w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-gradient-to-br ${card.color} opacity-10 -translate-y-4 translate-x-4 group-hover:opacity-20 transition-opacity`} />
            <div className="text-xl sm:text-2xl mb-1 sm:mb-2">{card.icon}</div>
            <div className="text-[12px] sm:text-xs text-slate-400 uppercase tracking-wider mb-0.5 sm:mb-1">{card.label}</div>
            <div className="text-lg sm:text-2xl font-bold text-white">{card.value}</div>
          </div>
        ))}
      </div>

      {/* Main content grid */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 sm:gap-6">
        {/* Activity chart — takes 2 cols */}
        <div className="xl:col-span-2 rounded-lg sm:rounded-xl border border-slate-700/60 bg-[#111827] p-3 sm:p-5">
          <div className="flex items-center justify-between mb-3 sm:mb-4">
            <h2 className="text-xs sm:text-sm font-semibold text-white uppercase tracking-wider">{t('admEventTrends')}</h2>
            <span className="text-[12px] sm:text-xs text-slate-400">
              {dashboard ? `${dashboard.today_events} ${t('admEventsToday')}` : '—'}
            </span>
          </div>

          {/* Bar chart with divs */}
          <div className="flex items-end gap-0.5 sm:gap-1 h-28 sm:h-40">
            {hourBuckets.length === 0 && !loading && (
              <div className="flex-1 flex items-center justify-center text-slate-400 text-xs sm:text-sm h-full">
                {t('admNoEventData')}
              </div>
            )}
            {hourBuckets.map((b) => {
              const pct = (b.count / maxBucket) * 100;
              return (
                <div key={b.hour} className="flex-1 flex flex-col items-center justify-end h-full group/bar">
                  <span className="text-[12px] sm:text-[12px] text-slate-400 mb-0.5 sm:mb-1 opacity-0 group-hover/bar:opacity-100 transition-opacity">
                    {b.count}
                  </span>
                  <div
                    className="w-full rounded-t bg-gradient-to-t from-cyan-600 to-blue-500 min-h-[2px] transition-all group-hover/bar:from-cyan-400 group-hover/bar:to-blue-400"
                    style={{ height: `${Math.max(pct, 2)}%` }}
                    title={`${b.hour} — ${b.count} events`}
                  />
                  <span className="text-[12px] sm:text-[11px] text-slate-400 mt-0.5 sm:mt-1 hidden sm:block select-none">
                    {b.hour.slice(0, 2)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* X-axis labels (show every 3 hours) */}
          <div className="flex gap-0.5 sm:gap-1 mt-1">
            {hourBuckets.map((b, i) => (
              <div key={b.hour} className="flex-1 text-center">
                <span className={`text-[12px] sm:text-[11px] select-none ${i % 3 === 0 ? 'text-slate-400' : 'text-transparent'}`}>
                  {b.hour}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Quick info panel */}
        <div className="rounded-lg sm:rounded-xl border border-slate-700/60 bg-[#111827] p-3 sm:p-5">
          <h2 className="text-xs sm:text-sm font-semibold text-white uppercase tracking-wider mb-3 sm:mb-4">Quick Info</h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between py-2 border-b border-slate-800">
              <span className="text-slate-400 text-sm">Active Webhooks</span>
              <span className="text-white font-semibold">{dashboard?.active_webhooks ?? '—'}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-slate-800">
              <span className="text-slate-400 text-sm">Events Today</span>
              <span className="text-white font-semibold">{dashboard?.today_events ?? '—'}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-slate-800">
              <span className="text-slate-400 text-sm">Recent Events</span>
              <span className="text-white font-semibold">{events.length}</span>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-slate-400 text-sm">Status</span>
              <span className={`text-sm font-semibold ${loading ? 'text-amber-400' : error ? 'text-red-400' : 'text-emerald-400'}`}>
                {loading ? '⏳ Loading' : error ? '⚠ Error' : '● OK'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Phase 7-9 Monitor Panel */}
      <div className="mt-4 sm:mt-6 grid grid-cols-1 xl:grid-cols-3 gap-4 sm:gap-6">
        {/* System Health */}
        <div className="rounded-lg sm:rounded-xl border border-slate-700/60 bg-[#111827] p-3 sm:p-5">
          <h2 className="text-xs sm:text-sm font-semibold text-white uppercase tracking-wider mb-3 sm:mb-4">System Health</h2>
          {monitorHealth ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between py-2 border-b border-slate-800">
                <span className="text-slate-400 text-sm">Status</span>
                <span className={`text-sm font-semibold ${monitorHealth.status === 'healthy' ? 'text-emerald-400' : 'text-amber-400'}`}>
                  ● {monitorHealth.status}
                </span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-slate-800">
                <span className="text-slate-400 text-sm">CPU</span>
                <span className="text-white text-sm">{monitorHealth.cpu_usage?.toFixed(1) ?? '—'}%</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-slate-800">
                <span className="text-slate-400 text-sm">Memory</span>
                <span className="text-white text-sm">{monitorHealth.memory_usage ? `${(monitorHealth.memory_usage / 1024 / 1024 / 1024).toFixed(1)}GB` : '—'}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-slate-800">
                <span className="text-slate-400 text-sm">Uptime</span>
                <span className="text-white text-sm">{formatUptime(monitorHealth.uptime)}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-slate-400 text-sm">Active Connections</span>
                <span className="text-white text-sm">{monitorHealth.active_connections ?? '—'}</span>
              </div>
            </div>
          ) : (
            <div className="text-center py-6 text-slate-400 text-sm">Loading...</div>
          )}
        </div>

        {/* Business KPIs + Federation + TaskMarket */}
        <div className="rounded-lg sm:rounded-xl border border-slate-700/60 bg-[#111827] p-3 sm:p-5">
          <h2 className="text-xs sm:text-sm font-semibold text-white uppercase tracking-wider mb-3 sm:mb-4">Business Metrics</h2>
          {kpis ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-slate-800/50 p-3 text-center">
                  <div className="text-xs text-slate-400">Online Nodes</div>
                  <div className="text-lg font-bold text-cyan-400">{kpis.online_nodes}/{kpis.total_nodes}</div>
                </div>
                <div className="rounded-lg bg-slate-800/50 p-3 text-center">
                  <div className="text-xs text-slate-400">Completed Tasks</div>
                  <div className="text-lg font-bold text-emerald-400">{kpis.completed_tasks}/{kpis.total_tasks}</div>
                </div>
                <div className="rounded-lg bg-slate-800/50 p-3 text-center">
                  <div className="text-xs text-slate-400">Federation Nodes</div>
                  <div className="text-lg font-bold text-violet-400">{kpis.federation_peers}</div>
                </div>
                <div className="rounded-lg bg-slate-800/50 p-3 text-center">
                  <div className="text-xs text-slate-400">Total Bids</div>
                  <div className="text-lg font-bold text-amber-400">{kpis.total_bids}</div>
                </div>
              </div>
              {kpis.total_revenue !== undefined && (
                <div className="flex items-center justify-between py-2 border-t border-slate-800">
                  <span className="text-slate-400 text-sm">Total Revenue</span>
                  <span className="text-white font-semibold">{formatRevenue(kpis.total_revenue)}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-6 text-slate-400 text-sm">Loading...</div>
          )}
        </div>

        {/* Database + Redis + Alerts */}
        <div className="rounded-lg sm:rounded-xl border border-slate-700/60 bg-[#111827] p-3 sm:p-5">
          <h2 className="text-xs sm:text-sm font-semibold text-white uppercase tracking-wider mb-3 sm:mb-4">Infrastructure</h2>
          <div className="space-y-3">
            {/* Redis */}
            {redisInfo && (
              <>
                <div className="text-xs text-slate-400 uppercase tracking-wider mb-2">Redis</div>
                <div className="flex items-center justify-between py-1.5 border-b border-slate-800">
                  <span className="text-slate-400 text-sm">Memory</span>
                  <span className="text-white text-sm">{redisInfo.used_memory}</span>
                </div>
                <div className="flex items-center justify-between py-1.5 border-b border-slate-800">
                  <span className="text-slate-400 text-sm">Keys</span>
                  <span className="text-white text-sm">{redisInfo.total_keys}</span>
                </div>
                <div className="flex items-center justify-between py-1.5 border-b border-slate-800">
                  <span className="text-slate-400 text-sm">OPS/sec</span>
                  <span className="text-white text-sm">{redisInfo.ops_per_sec}</span>
                </div>
              </>
            )}
            {/* DB */}
            {dbStats && (
              <>
                <div className="text-xs text-slate-400 uppercase tracking-wider mt-3 mb-2">Database</div>
                <div className="flex items-center justify-between py-1.5 border-b border-slate-800">
                  <span className="text-slate-400 text-sm">Connections</span>
                  <span className="text-white text-sm">{dbStats.total_connections}</span>
                </div>
                <div className="flex items-center justify-between py-1.5 border-b border-slate-800">
                  <span className="text-slate-400 text-sm">Size</span>
                  <span className="text-white text-sm">{dbStats.database_size_mb?.toFixed(1)}MB</span>
                </div>
              </>
            )}
            {/* Alerts */}
            {monitorAlerts.length > 0 && (
              <>
                <div className="text-xs text-slate-400 uppercase tracking-wider mt-3 mb-2">Alerts ({monitorAlerts.length})</div>
                {monitorAlerts.slice(0, 5).map((alert, i) => (
                  <div key={alert.id || i} className="flex items-start gap-2 py-1.5 text-sm">
                    <span className={`shrink-0 mt-0.5 w-2 h-2 rounded-full ${
                      alert.severity === 'critical' ? 'bg-red-500' :
                      alert.severity === 'warning' ? 'bg-amber-500' : 'bg-sky-500'
                    }`} />
                    <span className="text-slate-400 truncate">{typeof alert.message === 'string' ? alert.message : JSON.stringify(alert.message)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Recent events table */}
      <div className="mt-4 sm:mt-6 rounded-lg sm:rounded-xl border border-slate-700/60 bg-[#111827] p-3 sm:p-5">
        <h2 className="text-xs sm:text-sm font-semibold text-white uppercase tracking-wider mb-3 sm:mb-4">Recent Events</h2>

        {events.length === 0 && !loading && (
          <div className="text-center py-12 text-slate-400 text-sm">
            No event records
          </div>
        )}

        {events.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Time</th>
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Level</th>
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Type</th>
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Source</th>
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                    <td className="py-2 px-3 text-slate-400 whitespace-nowrap">
                      {new Date(ev.timestamp).toLocaleString('zh-CN', {
                        month: '2-digit', day: '2-digit',
                        hour: '2-digit', minute: '2-digit', second: '2-digit',
                      })}
                    </td>
                    <td className="py-2 px-3">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${LEVEL_BG[ev.level] || 'bg-slate-700/30'} ${LEVEL_COLORS[ev.level] || 'text-slate-400'}`}>
                        {ev.level.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-slate-300">{ev.type}</td>
                    <td className="py-2 px-3 text-slate-400 font-mono text-xs">{ev.source || '—'}</td>
                    <td className="py-2 px-3 text-slate-300 max-w-md truncate">{ev.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
            <span className="ml-3 text-slate-400 text-sm">Loading...</span>
          </div>
        )}
      </div>

      </>)}
    </div>
  );
}

// ─── Task Market Panel ─────────────────────────────────────────────────────

function TaskMarketPanel({ stats }: { stats: { open_tasks: number; total_bids: number } | null }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <div className="border-l-4 border-amber-500 pl-4">
        <h2 className="text-xl font-bold text-white">{t('admTaskMarket')}</h2>
        <p className="text-sm text-slate-400 mt-1">{t('admTaskMarketDesc')}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 max-w-md">
        <div className="rounded-lg bg-[#111827] border border-slate-700/60 p-4 text-center">
          <div className="text-2xl font-bold text-amber-400">{stats?.open_tasks ?? '—'}</div>
          <div className="text-xs text-slate-400 mt-1">{t('admOpenTasks')}</div>
        </div>
        <div className="rounded-lg bg-[#111827] border border-slate-700/60 p-4 text-center">
          <div className="text-2xl font-bold text-purple-400">{stats?.total_bids ?? '—'}</div>
          <div className="text-xs text-slate-400 mt-1">{t('admTotalBids')}</div>
        </div>
      </div>

      <div className="rounded-lg bg-[#111827] border border-slate-700/60 p-4 text-sm text-slate-400 max-w-xl">
        {t('admTaskMarketDesc')} · {t('pageTasks')}
      </div>
    </div>
  );
}

// ─── Disputes Panel ────────────────────────────────────────────────────────

interface Dispute {
  id: string;
  task_id: string;
  opened_by: string | null;
  reason: string;
  evidence: string | null;
  status: 'open' | 'resolved';
  resolution: string | null;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
  type: string;
  title: string;
  caller_id: string;
  node_id: string | null;
  escrow_amount: number | null;
}

function DisputesPanel({ apiKey }: { apiKey: string }) {
  const { t, lang } = useI18n();
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = statusFilter ? `?status=${statusFilter}&limit=50` : '?limit=50';
      const res = await adminFetch<{ data: Dispute[] }>(`/v1/admin/task-market/disputes${qs}`, apiKey);
      setDisputes(res.data || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load disputes');
    } finally {
      setLoading(false);
    }
  }, [apiKey, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const resolve = async (dispute: Dispute, resolution: 'released_to_worker' | 'refunded_caller') => {
    const confirmText = resolution === 'released_to_worker' ? t('admConfirmRelease') : t('admConfirmRefund');
    if (!window.confirm(confirmText)) return;
    setBusyId(dispute.id);
    try {
      const res = await adminFetch<{ success?: boolean; message?: string }>(
        `/v1/admin/task-market/disputes/${dispute.id}/resolve`,
        apiKey,
        {
          method: 'POST',
          body: JSON.stringify({ resolution }),
        }
      );
      if (res && res.success === false) {
        alert(res.message || t('pnlCreatedFail'));
      }
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : t('pnlCreatedFail'));
    } finally {
      setBusyId(null);
    }
  };

  const filterBtn = (key: string, label: string) => (
    <button
      key={key}
      onClick={() => setStatusFilter(key)}
      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
        statusFilter === key ? 'bg-red-500 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="border-l-4 border-red-500 pl-4">
          <h2 className="text-xl font-bold text-white">{t('admDisputeArbitration')}</h2>
          <p className="text-sm text-slate-400 mt-1">
            {t('admDisputeDesc')}
          </p>
        </div>
        <div className="flex gap-1.5">
          {filterBtn('', t('admAll'))}
          {filterBtn('open', t('admOpen'))}
          {filterBtn('resolved', t('admResolved'))}
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400">
          {error === 'AUTH_FAILED' ? 'Invalid admin API key' : error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <div className="w-6 h-6 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
          <span className="ml-3 text-slate-400 text-sm">{t('pnlLoading')}</span>
        </div>
      ) : disputes.length === 0 ? (
        <div className="rounded-lg bg-[#111827] border border-slate-700/60 p-10 text-center text-sm text-slate-400">
          {t('admNoDisputes')}{statusFilter ? `: ${statusFilter}` : ''}
        </div>
      ) : (
        <div className="space-y-3">
          {disputes.map(d => (
            <div key={d.id} className="rounded-lg bg-[#111827] border border-slate-700/60 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-white truncate">{d.title || d.type}</h3>
                  <p className="text-[12px] font-mono text-slate-400 mt-0.5">
                    dispute {d.id.slice(0, 8)}… · task {d.task_id.slice(0, 8)}…
                  </p>
                </div>
                <span className={`shrink-0 text-xs px-2 py-1 rounded font-medium ${
                  d.status === 'open'
                    ? 'bg-red-500/20 text-red-400'
                    : 'bg-green-500/20 text-green-400'
                }`}>
                  {d.status === 'open' ? t('admOpen').toUpperCase() : `${t('admResolved').toUpperCase()} · ${d.resolution || ''}`}
                </span>
              </div>

              {d.reason && (
                <p className="text-xs text-slate-300 mt-2 bg-slate-900/60 rounded p-2.5">
                  <span className="text-slate-400">{t('admReason')}:</span> {d.reason}
                </p>
              )}
              {d.evidence && (
                <p className="text-xs text-slate-400 mt-1.5">
                  <span className="text-slate-400">{t('admEvidence')}:</span> {d.evidence}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2 mt-2.5 text-[12px] text-slate-400">
                <span>{t('admEscrow')}: <span className="text-amber-400 font-medium">{d.escrow_amount ?? 0} XCL</span></span>
                <span>· {t('admOpened')}: {fmtDateTime(d.created_at, lang)}</span>
                {d.resolved_at && <span>· {t('admResolvedAt')}: {fmtDateTime(d.resolved_at, lang)}</span>}
              </div>

              {d.status === 'open' && (
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => resolve(d, 'released_to_worker')}
                    disabled={busyId === d.id}
                    className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white text-xs rounded-lg transition-colors"
                  >
                    {busyId === d.id ? t('admProcessing') : t('admReleaseWorker')}
                  </button>
                  <button
                    onClick={() => resolve(d, 'refunded_caller')}
                    disabled={busyId === d.id}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 text-xs rounded-lg transition-colors"
                  >
                    {busyId === d.id ? t('admProcessing') : t('admRefundCaller')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 技能审核面板 ─────────────────────────────────────────────────────────

interface PendingSkill {
  id: string;
  name: string;
  category: string;
  version: string;
  description: string;
  price: string | number;
  is_listed: boolean;
  review_status: string;
  review_note: string | null;
  created_at: string;
  owner_name: string | null;
  owner_reputation: string | number | null;
  scan_result?: { verdict?: string; flags?: Array<{ rule: string; severity: string; type: string; hint: string }> };
}

function SkillReviewsPanel({ apiKey }: { apiKey: string }) {
  const { t } = useI18n();
  const [items, setItems] = useState<PendingSkill[]>([]);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminFetch<{ data: PendingSkill[] }>(
        `/v1/admin/marketplace/reviews?status=${statusFilter}&limit=50`,
        apiKey
      );
      setItems(res.data || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [apiKey, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const review = async (skill: PendingSkill, action: 'approve' | 'reject') => {
    const note = action === 'reject' ? (window.prompt(t('admReviewNote')) || '') : '';
    setBusyId(skill.id);
    try {
      await adminFetch(`/v1/admin/marketplace/reviews/${skill.id}`, apiKey, {
        method: 'POST',
        body: JSON.stringify({ action, note }),
      });
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  const filterBtn = (key: string, label: string) => (
    <button
      key={key}
      onClick={() => setStatusFilter(key)}
      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
        statusFilter === key ? 'bg-green-500 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="border-l-4 border-green-500 pl-4">
          <h2 className="text-xl font-bold text-white">{t('admSkillReviews')}</h2>
          <p className="text-sm text-slate-400 mt-1">{t('admSkillDesc')}</p>
        </div>
        <div className="flex gap-1.5">
          {filterBtn('pending', t('cbReviewPending'))}
          {filterBtn('approved', t('cbReviewApproved'))}
          {filterBtn('rejected', t('cbReviewRejected'))}
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400">
          {error === 'AUTH_FAILED' ? 'Invalid admin API key' : error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10 text-slate-400 text-sm">{t('pnlLoading')}</div>
      ) : items.length === 0 ? (
        <div className="rounded-lg bg-[#111827] border border-slate-700/60 p-10 text-center text-sm text-slate-500">
          {t('admNoPending')}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(s => (
            <div key={s.id} className="rounded-lg bg-[#111827] border border-slate-700/60 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-white truncate">{s.name}</h3>
                  <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">{s.description}</p>
                  <div className="flex flex-wrap gap-2 mt-2 text-[10px] text-slate-500">
                    <span className="px-1.5 py-0.5 rounded bg-slate-800">{s.category} · v{s.version}</span>
                    <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">{Number(s.price) > 0 ? `${Number(s.price)} XCL` : '未定价'}</span>
                    <span>{t('admOwner')}: {s.owner_name || s.id.slice(0, 8)}</span>
                    {s.owner_reputation != null && <span>★ {Number(s.owner_reputation).toFixed(2)}</span>}
                    <span>{new Date(s.created_at).toLocaleString()}</span>
                  </div>
                  {s.review_note && (
                    <p className="text-xs text-red-300 mt-1.5">{t('admReviewNote')}: {s.review_note}</p>
                  )}
                  {s.scan_result?.flags?.length ? (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {s.scan_result.flags.map(f => (
                        <span
                          key={f.rule}
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            f.severity === 'critical' || f.severity === 'high'
                              ? 'bg-red-500/20 text-red-400'
                              : f.severity === 'medium'
                                ? 'bg-amber-500/20 text-amber-400'
                                : 'bg-slate-600/30 text-slate-400'
                          }`}
                        >
                          [{f.rule}] {f.hint}
                        </span>
                      ))}
                    </div>
                  ) : (
                    s.scan_result?.verdict === 'pass' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 mt-2 inline-block">
                        auto-scan: pass
                      </span>
                    )
                  )}
                </div>
              </div>
              {s.review_status === 'pending' && (
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => review(s, 'approve')}
                    disabled={busyId === s.id}
                    className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white text-xs rounded-lg transition-colors"
                  >
                    {busyId === s.id ? t('admProcessing') : t('admApprove')}
                  </button>
                  <button
                    onClick={() => review(s, 'reject')}
                    disabled={busyId === s.id}
                    className="px-3 py-1.5 bg-red-600/80 hover:bg-red-600 disabled:opacity-40 text-white text-xs rounded-lg transition-colors"
                  >
                    {busyId === s.id ? t('admProcessing') : t('admReject')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
