import React, { useState, useEffect, useCallback } from 'react';
import AdminDashboard from '../components/AdminDashboard';
import {
  adminFetch,
  getStoredAdminKey,
  setStoredAdminKey,
  validateAdminKey,
} from '../utils/adminApi';
import { useI18n } from '../i18n/LanguageContext';

type Tab = 'dashboard' | 'monitor' | 'federation' | 'nodes' | 'events';

interface MonitorHealth {
  status: string;
  uptime: number;
  cpu_usage: number;
  memory_usage: number;
  disk_usage: number;
  active_connections: number;
}

interface DBStats {
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

interface AdminNode {
  node_id: string;
  name: string;
  capabilities?: string;
  status?: string;
  reputation_score?: number;
  total_earnings?: number;
  latitude?: number;
  longitude?: number;
  last_heartbeat?: string;
  created_at?: string;
}

interface AdminEvent {
  id: string;
  event_type: string;
  type?: string;
  level?: string;
  message: string;
  created_at?: string;
  timestamp?: string;
  source_id?: string;
}

const card = 'bg-slate-900 border border-slate-800 rounded-xl';

export default function AdminPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [adminKey, setAdminKey] = useState(getStoredAdminKey);
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState('');
  const [checking, setChecking] = useState(false);

  const needKey = tab !== 'dashboard' && !adminKey;

  const handleKeySubmit = async () => {
    if (!keyInput.trim()) return;
    setChecking(true);
    setKeyError('');
    try {
      const ok = await validateAdminKey(keyInput.trim());
      if (!ok) {
        setKeyError('Invalid admin API key');
        return;
      }
      setStoredAdminKey(keyInput.trim());
      setAdminKey(keyInput.trim());
      setKeyInput('');
    } finally {
      setChecking(false);
    }
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'dashboard', label: t('admDashboard') },
    { key: 'monitor', label: t('admMonitor') },
    { key: 'federation', label: t('admFederation') },
    { key: 'nodes', label: t('admNodes') },
    { key: 'events', label: t('admEvents') },
  ];

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-lg font-bold text-white">
          ⚙️ {t('pageAdmin')}
        </h1>
        <p className="text-xs mt-0.5 text-slate-400">
          {t('pageAdminDesc')}
        </p>
      </div>

      <div className="flex gap-1 px-4 pb-3 shrink-0 overflow-x-auto no-scrollbar">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
              tab === t.key
                ? 'bg-brand-500 text-white'
                : 'text-slate-400 hover:text-white bg-slate-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 pt-0 bg-slate-950">
        {tab === 'dashboard' && <AdminDashboard />}

        {needKey ? (
          <AdminKeyGate
            keyInput={keyInput}
            setKeyInput={setKeyInput}
            keyError={keyError}
            checking={checking}
            onSubmit={handleKeySubmit}
          />
        ) : (
          <>
            {tab === 'monitor' && <MonitorTab apiKey={adminKey} />}
            {tab === 'federation' && <FederationTab apiKey={adminKey} />}
            {tab === 'nodes' && <NodesTab apiKey={adminKey} />}
            {tab === 'events' && <EventsTab apiKey={adminKey} />}
          </>
        )}
      </div>
    </div>
  );
}

function AdminKeyGate({ keyInput, setKeyInput, keyError, checking, onSubmit }: {
  keyInput: string;
  setKeyInput: (v: string) => void;
  keyError: string;
  checking: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className={`${card} p-8 max-w-md mx-auto mt-12 text-center`}>
      <div className="text-3xl mb-3">🔑</div>
      <h2 className="text-sm font-bold text-white mb-2">Admin API Key Required</h2>
      <p className="text-xs text-slate-400 mb-4">
        This section requires the platform admin API key.
      </p>
      <input
        type="password"
        value={keyInput}
        onChange={e => setKeyInput(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && onSubmit()}
        placeholder="Admin API Key"
        className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500 placeholder-slate-500"
      />
      {keyError && <p className="text-xs text-red-400 mt-2">{keyError}</p>}
      <button
        onClick={onSubmit}
        disabled={checking || !keyInput.trim()}
        className="mt-3 w-full px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
      >
        {checking ? 'Verifying...' : 'Unlock'}
      </button>
    </div>
  );
}

// ─── Monitoring ──────────────────────────────────────────────────────────────

function MonitorTab({ apiKey }: { apiKey: string }) {
  const [health, setHealth] = useState<MonitorHealth | null>(null);
  const [db, setDb] = useState<DBStats | null>(null);
  const [redis, setRedis] = useState<RedisInfo | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [h, d, r] = await Promise.allSettled([
        adminFetch<{ data: MonitorHealth }>('/v1/monitor/health', apiKey),
        adminFetch<{ data: DBStats }>('/v1/monitor/database', apiKey),
        adminFetch<{ data: RedisInfo }>('/v1/monitor/redis', apiKey),
      ]);
      if (h.status === 'fulfilled') setHealth(h.value.data);
      if (d.status === 'fulfilled') setDb(d.value.data);
      if (r.status === 'fulfilled') setRedis(r.value.data);
      if (h.status === 'rejected' && h.reason?.message === 'AUTH_FAILED') {
        setError('Invalid admin API key');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load monitoring data');
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingCard />;
  if (error) return <ErrorCard message={error} />;

  return (
    <div className="space-y-4">
      <div className="border-l-4 border-sky-500 pl-4">
        <h2 className="text-xl font-bold text-white">System Monitoring</h2>
        <p className="text-sm text-slate-400 mt-1">Service health, database & Redis monitoring</p>
      </div>

      {health && (
        <div className={`${card} p-4`}>
          <h3 className="text-sm font-semibold mb-3 text-white">Backend Health</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Stat label="Status" value={health.status} valueClass={health.status === 'healthy' ? 'text-green-400' : 'text-amber-400'} />
            <Stat label="Uptime" value={formatUptime(health.uptime)} />
            <Stat label="CPU" value={`${health.cpu_usage ?? 0}%`} />
            <Stat label="Memory" value={`${health.memory_usage ?? 0}%`} />
            <Stat label="Disk" value={`${health.disk_usage ?? 0}%`} />
            <Stat label="Connections" value={String(health.active_connections ?? 0)} />
          </div>
        </div>
      )}

      {db && (
        <div className={`${card} p-4`}>
          <h3 className="text-sm font-semibold mb-3 text-white">Database</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Stat label="Connections" value={String(db.total_connections)} />
            <Stat label="Idle" value={String(db.idle_connections)} />
            <Stat label="Size" value={`${db.database_size_mb?.toFixed(1)} MB`} />
          </div>
        </div>
      )}

      {redis && (
        <div className={`${card} p-4`}>
          <h3 className="text-sm font-semibold mb-3 text-white">Redis</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Stat label="Memory" value={redis.used_memory || '—'} />
            <Stat label="Keys" value={String(redis.total_keys ?? 0)} />
            <Stat label="Clients" value={String(redis.connected_clients ?? 0)} />
            <Stat label="Ops/sec" value={String(redis.ops_per_sec ?? 0)} />
            <Stat label="Uptime" value={formatUptime(redis.uptime_seconds)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Federation ─────────────────────────────────────────────────────────────

interface FederationPeer {
  network_id?: string;
  name?: string;
  endpoint?: string;
  status?: string;
  last_seen?: string;
  [k: string]: unknown;
}

function FederationTab({ apiKey }: { apiKey: string }) {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [peers, setPeers] = useState<FederationPeer[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [s, p] = await Promise.allSettled([
        adminFetch<{ success?: boolean; data?: Record<string, unknown> }>('/v1/federation/status', apiKey),
        adminFetch<{ success?: boolean; data?: FederationPeer[] }>('/v1/federation/peers', apiKey),
      ]);
      if (s.status === 'fulfilled') setStatus(s.value.data ?? s.value);
      if (p.status === 'fulfilled') setPeers(p.value.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load federation data');
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingCard />;
  if (error) return <ErrorCard message={error} />;

  const totalPeers = typeof status?.total_peers === 'number' ? status.total_peers : peers.length;
  const activePeers = typeof status?.active_peers === 'number' ? status.active_peers : peers.filter(p => p.status === 'active' || p.status === 'online').length;

  return (
    <div className="space-y-4">
      <div className="border-l-4 border-violet-500 pl-4">
        <h2 className="text-xl font-bold text-white">Federation</h2>
        <p className="text-sm text-slate-400 mt-1">Cross-network peer discovery & federation task routing</p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Total Peers" value={String(totalPeers)} />
        <Stat label="Active Peers" value={String(activePeers)} valueClass="text-green-400" />
        <Stat label="Status" value={String(status?.status || '—')} />
      </div>

      {peers.length > 0 && (
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full text-sm min-w-[500px]">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left py-2 px-3 text-slate-500 font-medium">Network</th>
                <th className="text-left py-2 px-3 text-slate-500 font-medium">Endpoint</th>
                <th className="text-left py-2 px-3 text-slate-500 font-medium">Status</th>
                <th className="text-left py-2 px-3 text-slate-500 font-medium">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {peers.map((p, i) => (
                <tr key={p.network_id || i} className="border-b border-slate-800/50">
                  <td className="py-2 px-3 text-white font-mono text-xs">{p.name || p.network_id}</td>
                  <td className="py-2 px-3 text-slate-400 text-xs">{String(p.endpoint || '—')}</td>
                  <td className="py-2 px-3">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      p.status === 'active' || p.status === 'online' ? 'bg-green-500/20 text-green-400' : 'bg-slate-500/20 text-slate-400'
                    }`}>{String(p.status || 'unknown')}</span>
                  </td>
                  <td className="py-2 px-3 text-slate-500 text-xs">
                    {p.last_seen ? new Date(String(p.last_seen)).toLocaleString('zh-CN') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Nodes ──────────────────────────────────────────────────────────────────

function NodesTab({ apiKey }: { apiKey: string }) {
  const [nodes, setNodes] = useState<AdminNode[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminFetch<{ data: AdminNode[]; pagination: { total: number } }>('/v1/admin/nodes?limit=50', apiKey);
      setNodes(res.data || []);
      setTotal(res.pagination?.total ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load nodes');
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingCard />;
  if (error) return <ErrorCard message={error} />;

  return (
    <div className="space-y-4">
      <div className="border-l-4 border-green-500 pl-4">
        <h2 className="text-xl font-bold text-white">Node Management</h2>
        <p className="text-sm text-slate-400 mt-1">All registered nodes ({total})</p>
      </div>

      {nodes.length === 0 ? (
        <div className={`${card} p-8 text-center text-xs text-slate-400`}>No nodes registered</div>
      ) : (
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left py-2 px-3 text-slate-500 font-medium">Name</th>
                <th className="text-left py-2 px-3 text-slate-500 font-medium">Node ID</th>
                <th className="text-left py-2 px-3 text-slate-500 font-medium">Status</th>
                <th className="text-left py-2 px-3 text-slate-500 font-medium">Reputation</th>
                <th className="text-left py-2 px-3 text-slate-500 font-medium">Earnings</th>
                <th className="text-left py-2 px-3 text-slate-500 font-medium">Last Heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map(n => (
                <tr key={n.node_id} className="border-b border-slate-800/50">
                  <td className="py-2 px-3 text-white text-xs">{n.name}</td>
                  <td className="py-2 px-3 text-slate-400 font-mono text-xs">{n.node_id.slice(0, 12)}...</td>
                  <td className="py-2 px-3">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      n.status === 'online' ? 'bg-green-500/20 text-green-400' : 'bg-slate-500/20 text-slate-400'
                    }`}>{n.status || 'unknown'}</span>
                  </td>
                  <td className="py-2 px-3 text-slate-300 text-xs">{n.reputation_score != null ? n.reputation_score.toFixed(2) : '—'}</td>
                  <td className="py-2 px-3 text-brand-400 text-xs">{n.total_earnings != null ? `${n.total_earnings} XCL` : '—'}</td>
                  <td className="py-2 px-3 text-slate-500 text-xs">
                    {n.last_heartbeat ? new Date(n.last_heartbeat).toLocaleString('zh-CN') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Events ─────────────────────────────────────────────────────────────────

function EventsTab({ apiKey }: { apiKey: string }) {
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminFetch<{ data: AdminEvent[] }>('/v1/admin/events?limit=30', apiKey);
      setEvents(res.data || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load events');
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingCard />;
  if (error) return <ErrorCard message={error} />;

  return (
    <div className="space-y-4">
      <div className="border-l-4 border-amber-500 pl-4">
        <h2 className="text-xl font-bold text-white">Event Logs</h2>
        <p className="text-sm text-slate-400 mt-1">System events & webhook delivery records</p>
      </div>

      {events.length === 0 ? (
        <div className={`${card} p-8 text-center text-xs text-slate-400`}>No events yet</div>
      ) : (
        <div className="space-y-2">
          {events.map(ev => (
            <div key={ev.id} className={`${card} p-3`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-brand-400">{ev.event_type || ev.type}</span>
                <span className="text-[10px] text-slate-500">
                  {new Date(ev.created_at || ev.timestamp || '').toLocaleString('zh-CN')}
                </span>
              </div>
              <p className="text-xs text-slate-300 mt-1">{ev.message}</p>
              {ev.source_id && (
                <p className="text-[10px] text-slate-500 mt-1 font-mono">source: {ev.source_id.slice(0, 12)}...</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Shared bits ────────────────────────────────────────────────────────────

function Stat({ label, value, valueClass = 'text-white' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-lg bg-slate-800 p-3 text-center">
      <div className={`text-lg font-bold ${valueClass}`}>{value}</div>
      <div className="text-[10px] text-slate-400">{label}</div>
    </div>
  );
}

function LoadingCard() {
  return (
    <div className={`${card} p-8 text-center text-sm text-slate-400`}>
      Loading...
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className={`${card} p-8 text-center text-sm text-red-400`}>
      {message === 'AUTH_FAILED' ? 'Invalid admin API key' : message}
    </div>
  );
}

function formatUptime(seconds?: number): string {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
