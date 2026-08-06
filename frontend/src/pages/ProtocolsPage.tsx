import React, { useState } from 'react';
import A2APanel from '../components/panels/A2APanel';
import MCPPanel from '../components/panels/MCPPanel';
import SearchV2Panel from '../components/panels/SearchV2Panel';
import DeveloperPanel from '../components/panels/DeveloperPanel';
import WebhookManager from '../components/panels/WebhookPanel';
import { useI18n } from '../i18n/LanguageContext';

type Tab = 'a2a' | 'mcp' | 'search' | 'webhook' | 'ai' | 'developer';

export default function ProtocolsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('a2a');

  const tabs: { key: Tab; label: string; icon: string }[] = [
    { key: 'a2a', label: 'A2A Protocol', icon: '🤝' },
    { key: 'mcp', label: 'MCP Management', icon: '🔧' },
    { key: 'search', label: 'Search V2', icon: '🔍' },
    { key: 'webhook', label: 'Webhook', icon: '🔔' },
    { key: 'ai', label: 'AI Services', icon: '🧠' },
    { key: 'developer', label: 'Developer', icon: '👨‍💻' },
  ];

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-lg font-bold text-white">
          🔧 {t('pageProtocols')}
        </h1>
        <p className="text-xs mt-0.5 text-slate-400">
          {t('pageProtocolsDesc')}
        </p>
      </div>

      <div className="flex gap-1 px-4 pb-3 shrink-0 overflow-x-auto no-scrollbar">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
              tab === t.key
                ? 'bg-brand-500 text-white'
                : 'text-slate-400 hover:text-white bg-slate-800'
            }`}
          >
            <span>{t.icon}</span> {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 pt-0 bg-slate-950">
        {tab === 'a2a' && <A2APanel />}
        {tab === 'mcp' && <MCPPanel />}
        {tab === 'search' && <SearchV2Panel />}
        {tab === 'webhook' && <WebhookManager />}
        {tab === 'ai' && <AIServicePanel />}
        {tab === 'developer' && <DeveloperPanel />}
      </div>
    </div>
  );
}

function AIServicePanel() {
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'generate' | 'embed'>('generate');

  const card = 'bg-slate-900 border border-slate-800 rounded-xl';

  const handleSubmit = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    setResult('');
    try {
      const { request } = await import('../utils/api');
      const endpoint = mode === 'generate' ? '/v1/ai/generate' : '/v1/ai/embed';
      const body = mode === 'generate' ? { prompt } : { text: prompt };
      const res = await request(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setResult(JSON.stringify(res, null, 2));
    } catch (e: any) {
      setResult(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="border-l-4 border-blue-500 pl-4">
        <h2 className="text-xl font-bold text-white">AI Services</h2>
        <p className="text-sm text-slate-400 mt-1">Text generation & Embedding vectorization</p>
      </div>

      <div className={`${card} p-4`}>
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => setMode('generate')}
            className={`px-3 py-1.5 text-xs rounded-lg ${mode === 'generate' ? 'bg-blue-500 text-white' : 'bg-gray-700 text-gray-400'}`}
          >
            Text Generation
          </button>
          <button
            onClick={() => setMode('embed')}
            className={`px-3 py-1.5 text-xs rounded-lg ${mode === 'embed' ? 'bg-blue-500 text-white' : 'bg-gray-700 text-gray-400'}`}
          >
            Embedding
          </button>
        </div>

        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder={mode === 'generate' ? 'Enter prompt...' : 'Enter text to vectorize...'}
          rows={4}
          className="w-full px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-blue-500 resize-none mb-3"
        />

        <button
          onClick={handleSubmit}
          disabled={loading || !prompt.trim()}
          className="bg-blue-500 hover:bg-blue-600 rounded-lg px-4 py-2 text-sm text-white font-medium disabled:opacity-40 transition-colors"
        >
          {loading ? 'Processing...' : mode === 'generate' ? 'Generate' : 'Vectorize'}
        </button>

        {result && (
          <pre className="mt-3 p-3 rounded-lg bg-gray-900/80 text-xs text-green-400 overflow-x-auto max-h-64 overflow-y-auto">
            {result}
          </pre>
        )}
      </div>
    </div>
  );
}
