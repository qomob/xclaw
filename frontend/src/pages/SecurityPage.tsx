import React, { useState } from 'react';
import SecurityPanel from '../components/panels/SecurityPanel';
import ClawOracle from '../components/ClawOracle';
import { useI18n } from '../i18n/LanguageContext';

type Tab = 'security' | 'reputation' | 'audit';

export default function SecurityPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('security');

  const tabs: { key: Tab; label: string }[] = [
    { key: 'security', label: 'Security' },
    { key: 'reputation', label: 'Reputation' },
    { key: 'audit', label: 'Audit Logs' },
  ];

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-lg font-bold text-white">
          🛡️ {t('pageSecurity')}
        </h1>
        <p className="text-xs mt-0.5 text-slate-400">
          {t('pageSecurityDesc')}
        </p>
      </div>

      <div className="flex gap-1 px-4 pb-3 shrink-0">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
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
        {tab === 'security' && <SecurityPanel />}
        {tab === 'reputation' && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <ClawOracle collapsed={false} />
          </div>
        )}
        {tab === 'audit' && <AuditLogPanel />}
      </div>
    </div>
  );
}

function AuditLogPanel() {
  const card = 'bg-gray-800/50 border border-gray-700/50 rounded-xl';

  return (
    <div className="space-y-6">
      <div className="border-l-4 border-red-500 pl-4">
        <h2 className="text-xl font-bold text-white">Audit Logs</h2>
        <p className="text-sm text-slate-400 mt-1">Full operation audit trail</p>
      </div>

      <div className={`${card} p-4`}>
        <p className="text-sm text-slate-400 text-center py-8">
          Audit logs require admin privileges. Go to System Admin → Audit Logs.
        </p>
      </div>
    </div>
  );
}
