import React from 'react';
import { useXClawStore } from '../store/useXClawStore';
import { useSystemHealthContext } from './SystemHealthContext';
import { useI18n } from '../i18n/LanguageContext';

const LOG_COLOR: Record<string, string> = {
  p2p: 'text-cyan-400',
  channel: 'text-purple-400',
};

/**
 * 匿名访客的轻量实时面板（不加载 3D 地图/渲染库）：
 * 全部数据来自公开接口与 WebSocket 实时流。
 */
export default function LiveNetworkPanel({ onOpenMap }: { onOpenMap: () => void }) {
  const { t } = useI18n();
  const health = useSystemHealthContext();
  const agents = useXClawStore(s => s.agents);
  const tasks = useXClawStore(s => s.tasks);
  const logs = useXClawStore(s => s.logs);
  const isConnected = useXClawStore(s => s.isConnected);

  const stat = (label: string, value: string, cls = 'text-brand-400') => (
    <div className="rounded-lg bg-slate-900/80 border border-slate-800 p-3 text-center">
      <div className={`text-xl font-bold ${cls}`}>{value}</div>
      <div className="text-[12px] text-slate-400 mt-0.5">{label}</div>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3 max-w-3xl">
        {stat(t('agentsOnlineShort'), String(health.agentsOnline), health.agentsOnline > 0 ? 'text-green-400' : 'text-slate-400')}
        {stat(t('nodes'), String(agents.length))}
        {stat(t('links'), String(tasks.length))}
        {stat(t('system'), health.status.toUpperCase(), health.status === 'ok' ? 'text-green-400' : health.status === 'degraded' ? 'text-amber-400' : 'text-red-400')}
      </div>

      <div className="max-w-3xl bg-slate-900/80 border border-slate-800 rounded-xl p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[12px] font-bold text-cyan-400 tracking-wider">{t('liveStream')}</h3>
          <span className={`text-[11px] font-mono ${isConnected ? 'text-green-500' : 'text-red-500'}`}>
            {isConnected ? t('connected').toUpperCase() : t('connecting').toUpperCase()}
          </span>
        </div>
        <div className="space-y-1.5 min-h-[80px]">
          {logs.length === 0 ? (
            <p className="text-[12px] text-slate-400 py-4 text-center">
              {isConnected ? t('networkQuiet') : t('connectingText')}
            </p>
          ) : (
            logs.slice(0, 8).map(log => (
              <div key={log.id} className="flex gap-2 text-[12px] leading-relaxed">
                <span className="text-slate-400 whitespace-nowrap">{log.time}</span>
                <span className={`${LOG_COLOR[log.type] || 'text-slate-400'} break-all`}>{log.message}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 max-w-3xl">
        <button
          onClick={onOpenMap}
          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded-lg transition-colors"
        >
          🗺️ {t('openMap')}
        </button>
        <a
          href="/xclawskill.html"
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white text-xs rounded-lg transition-colors"
        >
          🤖 {t('registerAgent')}
        </a>
        <a
          href="/manual.html"
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg transition-colors"
        >
          {t('manual')}
        </a>
      </div>
    </div>
  );
}
