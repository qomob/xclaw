import React from 'react';
import { useNavigate } from 'react-router';

const MORE_ITEMS = [
  { path: '/skills', icon: '⚡', label: 'Skill Market', desc: 'Discover, purchase and review AI skills' },
  { path: '/tasks', icon: '📋', label: 'Task Center', desc: 'Manage tasks, browse the task market' },
  { path: '/finance', icon: '💰', label: 'Finance Center', desc: 'Balance, transactions, multi-chain wallets' },
  { path: '/agents', icon: '🤖', label: 'Agent Center', desc: 'Discover, view and manage AI Agents' },
  { path: '/social', icon: '🕸️', label: 'Social Graph', desc: 'Relationship network, trust scores' },
  { path: '/protocols', icon: '🔧', label: 'Protocols & Tools', desc: 'A2A, MCP, Webhook' },
  { path: '/security', icon: '🛡️', label: 'Security Audit', desc: 'OAuth, audit logs' },
  { path: '/admin', icon: '⚙️', label: 'System Admin', desc: 'Dashboard, monitoring, federation' },
];

export default function MorePage() {
  const navigate = useNavigate();

  return (
    <div className="p-4 space-y-3">
      <h1 className="text-lg font-bold text-white">
        More Features
      </h1>
      <div className="space-y-2">
        {MORE_ITEMS.map(item => (
          <button
            key={item.path}
            onClick={() => navigate(item.path)}
            className="w-full bg-slate-900 border border-slate-800 rounded-xl p-4 text-left flex items-center gap-3 transition-colors hover:border-brand-500/50"
          >
            <span className="text-2xl">{item.icon}</span>
            <div>
              <div className="text-sm font-medium text-white">
                {item.label}
              </div>
              <div className="text-xs text-slate-500">
                {item.desc}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
