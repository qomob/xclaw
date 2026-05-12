import React, { useState } from 'react';
import AdminDashboard from '../components/AdminDashboard';

type Tab = 'dashboard' | 'monitor' | 'federation' | 'nodes' | 'events';

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('dashboard');

  const tabs: { key: Tab; label: string }[] = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'monitor', label: 'Monitoring' },
    { key: 'federation', label: 'Federation' },
    { key: 'nodes', label: 'Node Management' },
    { key: 'events', label: 'Event Logs' },
  ];

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-lg font-bold text-white">
          ⚙️ System Admin
        </h1>
        <p className="text-xs mt-0.5 text-slate-400">
          Admin console, system monitoring & federation management
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
        {tab === 'monitor' && <MonitorTab />}
        {tab === 'federation' && <FederationTab />}
        {tab === 'nodes' && <NodesTab />}
        {tab === 'events' && <EventsTab />}
      </div>
    </div>
  );
}

function MonitorTab() {
  const card = 'bg-gray-800/50 border border-gray-700/50 rounded-xl';

  return (
    <div className="space-y-6">
      <div className="border-l-4 border-sky-500 pl-4">
        <h2 className="text-xl font-bold text-white">System Monitoring</h2>
        <p className="text-sm text-slate-400 mt-1">Service health, database & Redis monitoring</p>
      </div>
      <div className={`${card} p-4 text-center text-sm text-slate-400 py-8`}>
        Loading monitoring data... (Admin API Key required)
      </div>
    </div>
  );
}

function FederationTab() {
  const card = 'bg-gray-800/50 border border-gray-700/50 rounded-xl';

  return (
    <div className="space-y-6">
      <div className="border-l-4 border-violet-500 pl-4">
        <h2 className="text-xl font-bold text-white">Federation</h2>
        <p className="text-sm text-slate-400 mt-1">Cross-network peer discovery & federation task routing</p>
      </div>
      <div className={`${card} p-4 text-center text-sm text-slate-400 py-8`}>
        Loading federation data...
      </div>
    </div>
  );
}

function NodesTab() {
  const card = 'bg-gray-800/50 border border-gray-700/50 rounded-xl';

  return (
    <div className="space-y-6">
      <div className="border-l-4 border-green-500 pl-4">
        <h2 className="text-xl font-bold text-white">Node Management</h2>
        <p className="text-sm text-slate-400 mt-1">Management interface for all registered nodes</p>
      </div>
      <div className={`${card} p-4 text-center text-sm text-slate-400 py-8`}>
        Loading node list... (Admin API Key required)
      </div>
    </div>
  );
}

function EventsTab() {
  const card = 'bg-gray-800/50 border border-gray-700/50 rounded-xl';

  return (
    <div className="space-y-6">
      <div className="border-l-4 border-amber-500 pl-4">
        <h2 className="text-xl font-bold text-white">Event Logs</h2>
        <p className="text-sm text-slate-400 mt-1">System events & webhook delivery records</p>
      </div>
      <div className={`${card} p-4 text-center text-sm text-slate-400 py-8`}>
        Loading event logs... (Admin API Key required)
      </div>
    </div>
  );
}