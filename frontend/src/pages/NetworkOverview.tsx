import React, { useState, useEffect } from 'react';
import { useXClawStore } from '../store/useXClawStore';
import { getToken } from '../utils/api';
import { useSystemHealthContext } from '../components/SystemHealthContext';
import LiveFeed from '../components/LiveFeed';
import { useI18n } from '../i18n/LanguageContext';
import WorldMapLight from '../components/WorldMapLight';

// 重型可视化组件全部懒加载
const NetworkMap = React.lazy(() => import('../components/NetworkMap'));
const SocialGraph = React.lazy(() => import('../components/SocialGraph'));
const TopologyView = React.lazy(() => import('../components/TopologyView'));
const GalaxyView = React.lazy(() => import('../components/GalaxyView'));

type PrimaryView = 'network' | 'graph';
type MapMode = 'map' | 'map3d' | 'galaxy' | 'topo';

export default function NetworkOverview() {
  const { t } = useI18n();
  const [primary, setPrimary] = useState<PrimaryView>('network');
  const [mapMode, setMapMode] = useState<MapMode>('map');
  const [showEvents, setShowEvents] = useState(false);
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

  const tabBtn = (active: boolean, onClick: () => void, label: string) => (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-[12px] font-medium rounded-md transition-colors ${
        active ? 'bg-brand-500 text-white' : 'text-slate-400 hover:text-brand-400'
      }`}
    >
      {label}
    </button>
  );

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
            <p className="text-[12px] text-slate-400 mt-0.5 leading-relaxed">
              {t('heroSubtitle')}
            </p>
          </div>
          <div className="flex items-center gap-3 text-[12px] text-slate-400 shrink-0">
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
          </div>
        </div>
      )}

      <div className="flex items-center gap-1 px-3 py-2 border-b shrink-0 border-slate-800 bg-slate-900/50">
        {tabBtn(primary === 'network', () => setPrimary('network'), t('network').toUpperCase())}
        {tabBtn(primary === 'graph', () => setPrimary('graph'), t('viewGraph'))}

        {primary === 'network' && (
          <div className="flex items-center gap-1 ml-2 pl-2 border-l border-slate-700">
            {(['map', 'map3d', 'galaxy', 'topo'] as MapMode[]).map(m => (
              <button
                key={m}
                onClick={() => setMapMode(m)}
                className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors ${
                  mapMode === m ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-brand-400'
                }`}
              >
                {m === 'map' ? t('viewMap') : m === 'map3d' ? '3D' : m === 'galaxy' ? t('viewGalaxy') : t('viewTopo')}
              </button>
            ))}
            {mapMode === 'map3d' && (
              <button
                onClick={() => setShowEvents(o => !o)}
                className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors ${
                  showEvents ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-cyan-400'
                }`}
              >
                ⚡ {t('eventLayer')}
              </button>
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-3 text-[12px]">
          <button
            onClick={() => setFeedOpen(o => !o)}
            className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md transition-colors ${
              feedOpen ? 'bg-cyan-500/15 text-cyan-400' : 'text-slate-400 hover:text-cyan-400'
            }`}
          >
            📡 {t('live')}
          </button>
          <span className="text-slate-400">
            {agents.filter(a => a.online).length} {t('agentsOnline')}
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
              {mapMode === 'map' && (
                <WorldMapLight />
              )}
              {mapMode === 'map3d' && (
                <React.Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-slate-400">{t('loading')}</div>}>
                  <NetworkMap showEvents={showEvents} />
                </React.Suspense>
              )}
              {mapMode === 'galaxy' && (
                <React.Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-slate-400">{t('loading')}</div>}>
                  <GalaxyView nodes={galaxyNodes} edges={galaxyEdges} />
                </React.Suspense>
              )}
              {mapMode === 'topo' && (
                <React.Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-slate-400">{t('loading')}</div>}>
                  <TopologyView />
                </React.Suspense>
              )}

              {mapMode !== 'map3d' && agents.length === 0 && (
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
          <React.Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-slate-400">{t('loading')}</div>}>
            <SocialGraph />
          </React.Suspense>
        )}
      </div>
    </div>
  );
}
