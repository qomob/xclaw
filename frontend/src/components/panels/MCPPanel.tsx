import { useState, useEffect, useCallback } from 'react';
import { request } from '../../utils/api';
import {
  fetchMCPStats,
  fetchMCPServers,
  fetchMCPTools,
  fetchMCPLogs,
} from '../../utils/api';
import { useI18n } from '../../i18n/LanguageContext';

interface MCPStats {
  registered_servers: number;
  available_tools: number;
  total_calls: number;
}

interface MCPServer {
  id: string;
  name: string;
  endpoint: string;
  description?: string;
  capabilities?: string[];
  status?: string;
}

interface MCPTool {
  name: string;
  server_name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface MCPLog {
  id: string;
  server_name: string;
  tool_name?: string;
  status: string;
  duration_ms?: number;
  timestamp: string;
  error?: string;
}

export default function MCPPanel() {
  const { t } = useI18n();
  const [stats, setStats] = useState<MCPStats | null>(null);
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [tools, setTools] = useState<MCPTool[]>([]);
  const [logs, setLogs] = useState<MCPLog[]>([]);

  // Register form
  const [regForm, setRegForm] = useState({ name: '', endpoint: '', description: '', capabilities: '', auth_type: 'none' });
  const [regStatus, setRegStatus] = useState('');

  const loadData = useCallback(async () => {
    try {
      const [statsRes, serversRes, toolsRes, logsRes] = await Promise.allSettled([
        fetchMCPStats(),
        fetchMCPServers(),
        fetchMCPTools(),
        fetchMCPLogs(50),
      ]);
      if (statsRes.status === 'fulfilled') setStats(statsRes.value.data ?? statsRes.value);
      if (serversRes.status === 'fulfilled') setServers(serversRes.value.data?.servers ?? serversRes.value.data ?? []);
      if (toolsRes.status === 'fulfilled') setTools(toolsRes.value.data?.tools ?? toolsRes.value.data ?? []);
      if (logsRes.status === 'fulfilled') setLogs(logsRes.value.data?.logs ?? logsRes.value.data ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleRegister = async () => {
    setRegStatus('');
    try {
      const caps = regForm.capabilities.split(',').map(s => s.trim()).filter(Boolean);
      await request('/v1/mcp/servers/register', {
        method: 'POST',
        body: JSON.stringify({
          name: regForm.name,
          endpoint: regForm.endpoint,
          description: regForm.description,
          capabilities: caps,
          auth_type: regForm.auth_type,
        }),
      });
      setRegStatus('success');
      setRegForm({ name: '', endpoint: '', description: '', capabilities: '', auth_type: 'none' });
      loadData();
    } catch {
      setRegStatus('error');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-l-4 border-green-500 pl-4">
        <h2 className="text-xl font-bold text-white">{t('mcpTitle')}</h2>
        <p className="text-sm text-slate-400 mt-1">{t('mcpDesc')}</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {[
          { label: 'Registered Servers', value: stats?.registered_servers ?? '—', icon: '🖥️' },
          { label: 'Available Tools', value: stats?.available_tools ?? '—', icon: '🔧' },
          { label: 'Total Calls', value: stats?.total_calls ?? '—', icon: '📊' },
        ].map(c => (
          <div key={c.label} className="bg-gray-800/50 rounded-lg sm:rounded-xl p-2.5 sm:p-4 border border-gray-700/50">
            <div className="text-lg sm:text-2xl mb-0.5 sm:mb-1">{c.icon}</div>
            <div className="text-[9px] sm:text-xs text-slate-500 uppercase tracking-wider">{c.label}</div>
            <div className="text-xl sm:text-3xl font-bold text-green-400 mt-0.5 sm:mt-1">{c.value}</div>
          </div>
        ))}
      </div>

      {/* Server List */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('mcpServers')}</h3>
        {servers.length > 0 ? (
          <div className="bg-gray-900/50 rounded-lg overflow-x-auto">
            <table className="w-full text-sm min-w-[400px]">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('pnlName')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('mcpEndpoint')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('pnlStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((s, i) => (
                  <tr key={s.id || i} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="py-2 px-3 text-green-300 font-medium">{s.name}</td>
                    <td className="py-2 px-3 text-slate-400 font-mono text-xs max-w-xs truncate">{s.endpoint}</td>
                    <td className="py-2 px-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${s.status === 'healthy' ? 'bg-green-500/20 text-green-400' : 'bg-amber-500/20 text-amber-400'}`}>
                        {s.status ?? 'unknown'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-6 text-slate-600 text-sm">{t('pnlNoServers')}</div>
        )}
      </div>

      {/* Tool List */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('mcpTools')} ({tools.length})</h3>
        {tools.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {tools.map((t, i) => (
              <div key={i} className="bg-gray-900/50 rounded-lg p-3">
                <div className="text-sm text-white font-medium">{t.name}</div>
                <div className="text-xs text-slate-500">{t.server_name ?? '—'}</div>
                {t.description && <div className="text-xs text-slate-400 mt-1">{t.description}</div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-6 text-slate-600 text-sm">{t('pnlNoTools')}</div>
        )}
      </div>

      {/* Register Server Form */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('mcpRegister')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <input
            type="text"
            value={regForm.name}
            onChange={e => setRegForm(f => ({ ...f, name: e.target.value }))}
            placeholder={t('mcpServerName')}
            className="px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-green-500"
          />
          <input
            type="text"
            value={regForm.endpoint}
            onChange={e => setRegForm(f => ({ ...f, endpoint: e.target.value }))}
            placeholder={t('mcpEndpoint')}
            className="px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-green-500"
          />
          <input
            type="text"
            value={regForm.description}
            onChange={e => setRegForm(f => ({ ...f, description: e.target.value }))}
            placeholder={t('mcpDescPlaceholder')}
            className="px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-green-500"
          />
          <input
            type="text"
            value={regForm.capabilities}
            onChange={e => setRegForm(f => ({ ...f, capabilities: e.target.value }))}
            placeholder={t('mcpCaps')}
            className="px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-green-500"
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleRegister}
            className="bg-green-500 hover:bg-green-600 rounded-lg px-4 py-2 text-sm text-white font-medium transition-colors"
          >
            Register
          </button>
          {regStatus === 'success' && <span className="text-emerald-400 text-sm">{t('pnlRegisteredOk')}</span>}
          {regStatus === 'error' && <span className="text-red-400 text-sm">{t('pnlRegFail')}</span>}
        </div>
      </div>

      {/* Call Logs */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('mcpCallLogs')}</h3>
        {logs.length > 0 ? (
          <div className="bg-gray-900/50 rounded-lg overflow-x-auto">
            <table className="w-full text-sm min-w-[500px]">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('pnlTime')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('mcpServerName')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('mcpTool')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('pnlStatus')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('pnlDuration')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log, i) => (
                  <tr key={log.id || i} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="py-2 px-3 text-slate-500 text-xs whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </td>
                    <td className="py-2 px-3 text-green-300 text-xs">{log.server_name}</td>
                    <td className="py-2 px-3 text-slate-300 text-xs">{log.tool_name ?? '—'}</td>
                    <td className="py-2 px-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${log.status === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {log.status}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-slate-400 text-xs">{log.duration_ms ? `${log.duration_ms}ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-6 text-slate-600 text-sm">{t('pnlNoLogs')}</div>
        )}
      </div>
    </div>
  );
}
