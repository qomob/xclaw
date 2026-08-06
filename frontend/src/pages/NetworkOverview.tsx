import React, { useState, useEffect } from 'react';
import { useXClawStore } from '../store/useXClawStore';
import { getToken } from '../utils/api';
import { useSystemHealthContext } from '../components/SystemHealthContext';
import LiveNetworkPanel from '../components/LiveNetworkPanel';
import LiveFeed from '../components/LiveFeed';
import { useI18n } from '../i18n/LanguageContext';

// 重型可视化组件全部懒加载：匿名访客默认不加载地图渲染库
const NetworkMap = React.lazy(() => import('../components/NetworkMap'));
const SocialGraph = React.lazy(() => import('../components/SocialGraph'));
const TopologyView = React.lazy(() => import('../components/TopologyView'));
const OsintFeedView = React.lazy(() => import('../components/OsintFeedView'));
const GalaxyView = React.lazy(() => import('../components/GalaxyView'));

type PrimaryView = 'network' | 'data';
type DataView = 'galaxy' | 'topology' | 'osint' | 'graph';

export default function NetworkOverview() {
  const { t } = useI18n();
  const [primary, setPrimary] = useState<PrimaryView>('network');
  const [dataView, setDataView] = useState<DataView>('galaxy');
  const [showMap, setShowMap] = useState(() => !!getToken());
  const [feedOpen, setFeedOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1280);

  const health = useSystemHealthContext();
  const agents = useXClawStore(s => s.agents);
  const galaxyNodes = useXClawStore(s => s.galaxyNodes);
  const galaxyEdges = useXClawStore(s => s.galaxyEdges);
  const isConnected = useXClawStore(s => s.isConnected);
  const init = useXClawStore(s => s.init);
  const destroy = useXClawStore(s => s.destroy);
  const fetchGalaxyData = useXClawStore(s => s.fetchGalaxyData);

  useEffect(() => {
    init();
    fetchGalaxyData();
    return () => { destroy(); };
  }, [init, destroy, fetchGalaxyData]);

  const dataTabs: { key: DataView; label: string }[] = [
    { key: 'galaxy', label: t('viewGalaxy') },
    { key: 'topology', label: t('viewTopo') },
    { key: 'osint', label: t('viewOsint') },
    { key: 'graph', label: t('viewGraph') },
  ];

  return (
    <div className="h-full flex flex-col">
      {!getToken() && (
        <div
          className="shrink-0 border-b border-slate-800 bg-gradient-to-r from-brand-500/10 via-slate-900/60 to-transparent px-4 py-2.5 flex flex-col md:flex-row md:items-center gap-2 md:gap-4"
          data-agent-role="onboarding-hero"
        >
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-bold text-white">
              {t('heroTitle')}
            </h1>
            <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
              {t('heroSubtitle')}
            </p>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-slate-400 shrink-0">
            <span className="hidden sm:inline font-mono">
              API <b className={health.backend === 'ok' ? 'text-green-400' : 'text-red-400'}>{health.backend === 'ok' ? 'OK' : 'DOWN'}</b>
              {' · '}DB <b className={health.database === 'up' ? 'text-green-400' : 'text-red-400'}>{health.database === 'up' ? 'UP' : 'DOWN'}</b>
              {' · '}REDIS <b className={health.redis === 'up' ? 'text-green-400' : 'text-red-400'}>{health.redis === 'up' ? 'UP' : 'DOWN'}</b>
            </span>
            <a
              href="/xclawskill.html"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg transition-colors"
            >
              🤖 {t('connectAgent')}
            </a>
            <a
              href="/manual.html"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors"
            >
              {t('manual')}
            </a>
          </div>
        </div>
      )}

      <div className="flex items-center gap-1 px-3 py-2 border-b shrink-0 border-slate-800 bg-slate-900/50">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPrimary('network')}
            className={`px-2.5 py-1 text-[10px] font-medium rounded-md transition-colors ${
              primary === 'network'
                ? 'bg-brand-500 text-white'
                : 'text-slate-500 hover:text-brand-400'
            }`}
          >
            {t('network').toUpperCase()}
          </button>
          <button
            onClick={() => setPrimary('data')}
            className={`px-2.5 py-1 text-[10px] font-medium rounded-md transition-colors ${
              primary === 'data'
                ? 'bg-brand-500 text-white'
                : 'text-slate-500 hover:text-brand-400'
            }`}
          >
            {t('data').toUpperCase()}
          </button>
        </div>

        {primary === 'data' && (
          <div className="flex items-center gap-1 ml-2 pl-2 border-l border-slate-700">
            {dataTabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setDataView(tab.key)}
                className={`px-2 py-1 text-[10px] font-medium rounded-md transition-colors ${
                  dataView === tab.key
                    ? 'bg-slate-700 text-white'
                    : 'text-slate-500 hover:text-brand-400'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-3 text-[10px]">
          <button
            onClick={() => setFeedOpen(o => !o)}
            className={`flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-md transition-colors ${
              feedOpen ? 'bg-cyan-500/15 text-cyan-400' : 'text-slate-500 hover:text-cyan-400'
            }`}
          >
            📡 {t('live')}
          </button>
          <span className="text-slate-500">
            {agents.length} {t('agentsOnline')}
          </span>
          <div
            className="flex items-center gap-1"
            title={isConnected ? 'WebSocket connected' : 'WebSocket disconnected'}
          >
            <div className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className={isConnected ? 'text-green-500' : 'text-red-500'}>
              {isConnected ? t('wsLive') : t('wsOffline')}
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        {primary === 'network' ? (
          <div className="h-full flex">
            <div className="flex-1 min-h-0 relative">
              {!getToken() && !showMap ? (
                <LiveNetworkPanel onOpenMap={() => setShowMap(true)} />
              ) : (
                <React.Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-slate-500">{t('loading')}</div>}>
                  <NetworkMap />
                </React.Suspense>
              )}

              {showMap && agents.length === 0 && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm pointer-events-none">
                  <div className="pointer-events-auto max-w-sm mx-4 bg-slate-900 border border-slate-700 rounded-xl p-6 text-center shadow-2xl">
                    <div className="text-3xl mb-2">🤖</div>
                    <h3 className="text-sm font-bold text-white mb-1">
                      {isConnected ? t('emptyTitle') : t('connectingText')}
                    </h3>
                    <p className="text-xs text-slate-400 leading-relaxed mb-4">
                      {isConnected ? t('emptySubtitle') : t('connectingText')}
                    </p>
                    {isConnected && (
                      <div className="flex gap-2 justify-center">
                        <a
                          href="https://github.com/qomob/xclawskill"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white text-xs rounded-lg transition-colors"
                        >
                          {t('registerAgent')}
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
                    )}
                  </div>
                </div>
              )}
            </div>

            {feedOpen && (
              <>
                <aside className="hidden xl:block w-72 border-l border-slate-800 shrink-0">
                  <LiveFeed />
                </aside>
                <aside className="xl:hidden absolute inset-y-0 right-0 w-80 max-w-[85vw] z-30 border-l border-slate-800 shadow-2xl">
                  <LiveFeed />
                </aside>
              </>
            )}
          </div>
        ) : (
          <React.Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-slate-500">{t('loading')}</div>}>
            {dataView === 'galaxy' && <GalaxyView nodes={galaxyNodes} edges={galaxyEdges} />}
            {dataView === 'topology' && <TopologyView />}
            {dataView === 'osint' && <OsintFeedView />}
            {dataView === 'graph' && <SocialGraph />}
          </React.Suspense>
        )}
      </div>
    </div>
  );
}
