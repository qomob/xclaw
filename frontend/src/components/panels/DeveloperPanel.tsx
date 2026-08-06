import { useState, useEffect, useCallback } from 'react';
import {
  registerDeveloper,
  fetchSandboxStatus,
  fetchSandboxAgents,
  fetchDeveloperApiKeys,
} from '../../utils/api';
import { useI18n } from '../../i18n/LanguageContext';

interface SandboxStatus {
  status: string;
  created_at?: string;
  agents_count?: number;
  resources?: { cpu: string; memory: string; storage: string };
}

interface SandboxAgent {
  id: string;
  name: string;
  capabilities: string[];
  status: string;
}

interface ApiKey {
  id: string;
  name: string;
  key?: string;
  permissions: string[];
  created_at: string;
}

export default function DeveloperPanel() {
  const { t } = useI18n();
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus | null>(null);
  const [sandboxAgents, setSandboxAgents] = useState<SandboxAgent[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);

  // Register form
  const [regForm, setRegForm] = useState({ name: '', email: '' });
  const [regStatus, setRegStatus] = useState('');

  // API Key form
  const [keyForm, setKeyForm] = useState({ name: '', permissions: '' });
  const [keyStatus, setKeyStatus] = useState('');

  const loadData = useCallback(async () => {
    try {
      const [sbRes, agentsRes, keysRes] = await Promise.allSettled([
        fetchSandboxStatus(),
        fetchSandboxAgents(),
        fetchDeveloperApiKeys(),
      ]);
      if (sbRes.status === 'fulfilled') setSandboxStatus(sbRes.value.data ?? sbRes.value);
      if (agentsRes.status === 'fulfilled') setSandboxAgents(agentsRes.value.data?.agents ?? agentsRes.value.data ?? []);
      if (keysRes.status === 'fulfilled') setApiKeys(keysRes.value.data?.keys ?? keysRes.value.data ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleRegister = async () => {
    setRegStatus('');
    try {
      await registerDeveloper(regForm.name, regForm.email);
      setRegStatus('success');
      setRegForm({ name: '', email: '' });
    } catch {
      setRegStatus('error');
    }
  };

  const handleCreateKey = async () => {
    setKeyStatus('');
    try {
      const perms = keyForm.permissions.split(',').map(s => s.trim()).filter(Boolean);
      const { request } = await import('../../utils/api');
      await request('/v1/developer/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: keyForm.name, permissions: perms }),
      });
      setKeyStatus('success');
      setKeyForm({ name: '', permissions: '' });
      loadData();
    } catch {
      setKeyStatus('error');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-l-4 border-orange-500 pl-4">
        <h2 className="text-xl font-bold text-white">{t('devTitle')}</h2>
        <p className="text-sm text-slate-400 mt-1">{t('devDesc')}</p>
      </div>

      {/* Developer Registration */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('devRegister')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <input
            type="text"
            value={regForm.name}
            onChange={e => setRegForm(f => ({ ...f, name: e.target.value }))}
            placeholder={t('devName')}
            className="px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-orange-500"
          />
          <input
            type="email"
            value={regForm.email}
            onChange={e => setRegForm(f => ({ ...f, email: e.target.value }))}
            placeholder={t('devEmail')}
            className="px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-orange-500"
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleRegister}
            className="bg-orange-500 hover:bg-orange-600 rounded-lg px-4 py-2 text-sm text-white font-medium transition-colors"
          >
            {t('devRegisterBtn')}
          </button>
          {regStatus === 'success' && <span className="text-emerald-400 text-sm">{t('pnlRegisteredOk')}</span>}
          {regStatus === 'error' && <span className="text-red-400 text-sm">{t('pnlRegFail')}</span>}
        </div>
      </div>

      {/* Sandbox Status */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('devSandboxStatus')}</h3>
        {sandboxStatus ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg bg-gray-900/50 p-3 text-center">
              <div className="text-xs text-slate-500">{t('pnlStatus')}</div>
              <div className={`text-sm font-bold mt-1 ${sandboxStatus.status === 'active' ? 'text-emerald-400' : 'text-slate-400'}`}>
                {sandboxStatus.status}
              </div>
            </div>
            <div className="rounded-lg bg-gray-900/50 p-3 text-center">
              <div className="text-xs text-slate-500">{t('devSandboxAgents')}</div>
              <div className="text-sm font-bold text-orange-400 mt-1">{sandboxStatus.agents_count ?? 0}</div>
            </div>
            {sandboxStatus.resources && (
              <>
                <div className="rounded-lg bg-gray-900/50 p-3 text-center">
                  <div className="text-xs text-slate-500">CPU</div>
                  <div className="text-sm font-bold text-slate-300 mt-1">{sandboxStatus.resources.cpu}</div>
                </div>
                <div className="rounded-lg bg-gray-900/50 p-3 text-center">
                  <div className="text-xs text-slate-500">Memory</div>
                  <div className="text-sm font-bold text-slate-300 mt-1">{sandboxStatus.resources.memory}</div>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="text-center py-4 text-slate-600 text-sm">{t('pnlLoading')}</div>
        )}
      </div>

      {/* Sandbox Agents */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('devSandboxAgents')} ({sandboxAgents.length})</h3>
        {sandboxAgents.length > 0 ? (
          <div className="space-y-2">
            {sandboxAgents.map(a => (
              <div key={a.id} className="flex items-center justify-between bg-gray-900/50 rounded-lg p-3">
                <div>
                  <div className="text-sm text-white font-medium">{a.name}</div>
                  <div className="text-xs text-slate-500 font-mono">{a.id}</div>
                </div>
                <div className="flex items-center gap-2">
                  {a.capabilities?.slice(0, 3).map((c, i) => (
                    <span key={i} className="px-2 py-0.5 text-xs bg-orange-500/20 text-orange-300 rounded-full">{c}</span>
                  ))}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${a.status === 'running' ? 'bg-green-500/20 text-green-400' : 'bg-slate-500/20 text-slate-400'}`}>
                    {a.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-4 text-slate-600 text-sm">{t('pnlNoSandboxAgents')}</div>
        )}
      </div>

      {/* API Keys */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('devApiKeys')}</h3>
        <div className="flex flex-col sm:flex-row gap-2 mb-3">
          <input
            type="text"
            value={keyForm.name}
            onChange={e => setKeyForm(f => ({ ...f, name: e.target.value }))}
            placeholder={t('devKeyName')}
            className="flex-1 px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-orange-500"
          />
          <input
            type="text"
            value={keyForm.permissions}
            onChange={e => setKeyForm(f => ({ ...f, permissions: e.target.value }))}
            placeholder={t('devPerms')}
            className="flex-1 px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-orange-500"
          />
          <button
            onClick={handleCreateKey}
            className="bg-orange-500 hover:bg-orange-600 rounded-lg px-4 py-2 text-sm text-white font-medium transition-colors"
          >
            {t('devCreate')}
          </button>
        </div>
        {keyStatus === 'success' && <div className="text-emerald-400 text-sm mb-2">{t('pnlCreatedOk')}</div>}
        {keyStatus === 'error' && <div className="text-red-400 text-sm mb-2">{t('pnlCreatedFail')}</div>}
        {apiKeys.length > 0 ? (
          <div className="bg-gray-900/50 rounded-lg overflow-x-auto">
            <table className="w-full text-sm min-w-[500px]">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('pnlName')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">Key</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('devPermissions')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('devCreatedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {apiKeys.map(k => (
                  <tr key={k.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="py-2 px-3 text-orange-300">{k.name}</td>
                    <td className="py-2 px-3 text-slate-400 font-mono text-xs">{k.key ? `${k.key.slice(0, 8)}...` : '—'}</td>
                    <td className="py-2 px-3">
                      <div className="flex gap-1 flex-wrap">
                        {k.permissions?.map((p, i) => (
                          <span key={i} className="px-1.5 py-0.5 text-xs bg-orange-500/15 text-orange-300 rounded">{p}</span>
                        ))}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-slate-500 text-xs whitespace-nowrap">
                      {new Date(k.created_at).toLocaleDateString('zh-CN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-4 text-slate-600 text-sm">{t('pnlNoApiKeys')}</div>
        )}
      </div>
    </div>
  );
}
