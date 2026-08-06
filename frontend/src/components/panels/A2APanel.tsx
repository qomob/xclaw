import { useState, useEffect, useCallback } from 'react';
import {
  fetchA2AStats,
  discoverA2AAgents,
  publishA2AAgent,
  fetchA2AMessages,
} from '../../utils/api';
import { useI18n } from '../../i18n/LanguageContext';

interface A2AStats {
  registered_agents: number;
  total_messages: number;
  total_tasks: number;
}

interface AgentCard {
  agent_id: string;
  name: string;
  capabilities: string[];
}

interface A2AMessage {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  content: string;
  timestamp: string;
}

export default function A2APanel() {
  const { t } = useI18n();
  const [stats, setStats] = useState<A2AStats | null>(null);
  const [discovered, setDiscovered] = useState<AgentCard[]>([]);
  const [messages, setMessages] = useState<A2AMessage[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [msgAgentId, setMsgAgentId] = useState('');

  // Publish form
  const [pubForm, setPubForm] = useState({ agent_id: '', name: '', capabilities: '' });
  const [pubStatus, setPubStatus] = useState('');

  const loadStats = useCallback(async () => {
    try {
      const res = await fetchA2AStats();
      setStats(res.data ?? res);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  const handleDiscover = async () => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    try {
      const res = await discoverA2AAgents(searchQuery.trim());
      setDiscovered(res.data?.agents ?? res.data ?? []);
    } catch {
      setDiscovered([]);
    } finally {
      setLoading(false);
    }
  };

  const handlePublish = async () => {
    setPubStatus('');
    try {
      const caps = pubForm.capabilities.split(',').map(s => s.trim()).filter(Boolean);
      await publishA2AAgent({
        agent_id: pubForm.agent_id,
        name: pubForm.name,
        capabilities: caps,
      });
      setPubStatus('success');
      setPubForm({ agent_id: '', name: '', capabilities: '' });
      loadStats();
    } catch {
      setPubStatus('error');
    }
  };

  const handleFetchMessages = async () => {
    if (!msgAgentId.trim()) return;
    try {
      const res = await fetchA2AMessages(msgAgentId.trim());
      setMessages(res.data?.messages ?? res.data ?? []);
    } catch {
      setMessages([]);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-l-4 border-purple-500 pl-4">
        <h2 className="text-xl font-bold text-white">{t('a2aTitle')}</h2>
        <p className="text-sm text-slate-400 mt-1">{t('a2aDesc')}</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {[
          { label: t('a2aRegisteredAgents'), value: stats?.registered_agents ?? '—', icon: '🤖' },
          { label: t('a2aTotalMessages'), value: stats?.total_messages ?? '—', icon: '💬' },
          { label: t('a2aTotalTasks'), value: stats?.total_tasks ?? '—', icon: '📋' },
        ].map(c => (
          <div key={c.label} className="bg-gray-800/50 rounded-lg sm:rounded-xl p-2.5 sm:p-4 border border-gray-700/50">
            <div className="text-lg sm:text-2xl mb-0.5 sm:mb-1">{c.icon}</div>
            <div className="text-[9px] sm:text-xs text-slate-500 uppercase tracking-wider">{c.label}</div>
            <div className="text-xl sm:text-3xl font-bold text-purple-400 mt-0.5 sm:mt-1">{c.value}</div>
          </div>
        ))}
      </div>

      {/* Agent Discovery */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('a2aDiscover')}</h3>
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleDiscover()}
            placeholder={t('a2aSearchPlaceholder')}
            className="flex-1 px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-purple-500"
          />
          <button
            onClick={handleDiscover}
            disabled={loading}
            className="bg-purple-500 hover:bg-purple-600 rounded-lg px-4 py-2 text-sm text-white font-medium disabled:opacity-40 transition-colors"
          >
            Search
          </button>
        </div>
        {discovered.length > 0 ? (
          <div className="space-y-2">
            {discovered.map((a, i) => (
              <div key={a.agent_id || i} className="flex items-center justify-between bg-gray-900/50 rounded-lg p-3">
                <div>
                  <div className="text-sm text-white font-medium">{a.name}</div>
                  <div className="text-xs text-slate-500 font-mono">{a.agent_id}</div>
                </div>
                <div className="flex gap-1 flex-wrap justify-end max-w-[50%]">
                  {a.capabilities?.map((cap, ci) => (
                    <span key={ci} className="px-2 py-0.5 text-xs bg-purple-500/20 text-purple-300 rounded-full">{cap}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-6 text-slate-600 text-sm">{t('a2aEnterKeywords')}</div>
        )}
      </div>

      {/* Publish Agent */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('a2aPublish')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <input
            type="text"
            value={pubForm.agent_id}
            onChange={e => setPubForm(f => ({ ...f, agent_id: e.target.value }))}
            placeholder={t('a2aAgentId')}
            className="px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-purple-500"
          />
          <input
            type="text"
            value={pubForm.name}
            onChange={e => setPubForm(f => ({ ...f, name: e.target.value }))}
            placeholder={t('a2aAgentName')}
            className="px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-purple-500"
          />
          <input
            type="text"
            value={pubForm.capabilities}
            onChange={e => setPubForm(f => ({ ...f, capabilities: e.target.value }))}
            placeholder={t('a2aCapsPlaceholder')}
            className="px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-purple-500"
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handlePublish}
            className="bg-purple-500 hover:bg-purple-600 rounded-lg px-4 py-2 text-sm text-white font-medium transition-colors"
          >
            {t('a2aPublishBtn')}
          </button>
          {pubStatus === 'success' && <span className="text-emerald-400 text-sm">{t('pnlRegisteredOk')}</span>}
          {pubStatus === 'error' && <span className="text-red-400 text-sm">{t('pnlRegFail')}</span>}
        </div>
      </div>

      {/* Messages */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('a2aMsgHistory')}</h3>
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={msgAgentId}
            onChange={e => setMsgAgentId(e.target.value)}
            placeholder={t('a2aMsgPlaceholder')}
            className="flex-1 px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-purple-500"
          />
          <button
            onClick={handleFetchMessages}
            className="bg-purple-500 hover:bg-purple-600 rounded-lg px-4 py-2 text-sm text-white font-medium transition-colors"
          >
            {t('a2aLoad')}
          </button>
        </div>
        {messages.length > 0 ? (
          <div className="bg-gray-900/50 rounded-lg overflow-x-auto">
            <table className="w-full text-sm min-w-[500px]">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('a2aSender')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('a2aReceiver')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('a2aContent')}</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">{t('pnlTime')}</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((msg, i) => (
                  <tr key={msg.id || i} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="py-2 px-3 text-purple-300 font-mono text-xs">{msg.from_agent_id}</td>
                    <td className="py-2 px-3 text-cyan-300 font-mono text-xs">{msg.to_agent_id}</td>
                    <td className="py-2 px-3 text-slate-300 max-w-xs truncate">{msg.content}</td>
                    <td className="py-2 px-3 text-slate-500 text-xs whitespace-nowrap">
                      {new Date(msg.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-6 text-slate-600 text-sm">{t('a2aNoMsgHint')}</div>
        )}
      </div>
    </div>
  );
}
