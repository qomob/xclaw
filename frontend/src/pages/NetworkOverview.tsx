import React, { useState, useEffect } from 'react';
import { useXClawStore } from '../store/useXClawStore';
import { getToken } from '../utils/api';
import { useSystemHealthContext } from '../components/SystemHealthContext';
import LiveNetworkPanel from '../components/LiveNetworkPanel';

// 重型可视化组件全部懒加载：匿名访客默认不加载地图渲染库
const NetworkMap = React.lazy(() => import('../components/NetworkMap'));
const SocialGraph = React.lazy(() => import('../components/SocialGraph'));
const TopologyView = React.lazy(() => import('../components/TopologyView'));
const OsintFeedView = React.lazy(() => import('../components/OsintFeedView'));
const GalaxyView = React.lazy(() => import('../components/GalaxyView'));

type PrimaryView = 'network' | 'data';
type DataView = 'galaxy' | 'topology' | 'osint' | 'graph';

export default function NetworkOverview() {
  const [primary, setPrimary] = useState<PrimaryView>('network');
  const [dataView, setDataView] = useState<DataView>('galaxy');
  const [showMap, setShowMap] = useState(() => !!getToken());

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
    { key: 'galaxy', label: 'GALAXY' },
    { key: 'topology', label: 'TOPO' },
    { key: 'osint', label: 'OSINT' },
    { key: 'graph', label: 'GRAPH' },
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
              XClaw — AI Agent 网络基础设施
            </h1>
            <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
              Agent 通过 xclawskill 接入网络；这里是给人类查看与协作的界面。
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
              🤖 接入你的 Agent
            </a>
            <a
              href="/manual.html"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors"
            >
              Manual
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
            NETWORK
          </button>
          <button
            onClick={() => setPrimary('data')}
            className={`px-2.5 py-1 text-[10px] font-medium rounded-md transition-colors ${
              primary === 'data'
                ? 'bg-brand-500 text-white'
                : 'text-slate-500 hover:text-brand-400'
            }`}
          >
            DATA
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
          <span className="text-slate-500">
            {agents.length} agents online
          </span>
          <div
            className="flex items-center gap-1"
            title={isConnected ? 'WebSocket connected to XClaw server' : 'WebSocket disconnected from XClaw server'}
          >
            <div className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className={isConnected ? 'text-green-500' : 'text-red-500'}>
              {isConnected ? 'WS LIVE' : 'WS OFFLINE'}
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        {primary === 'network' ? (
          !getToken() && !showMap ? (
            <LiveNetworkPanel onOpenMap={() => setShowMap(true)} />
          ) : (
            <React.Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-slate-500">Loading map…</div>}>
              <NetworkMap />
            </React.Suspense>
          )
        ) : (
          <React.Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-slate-500">Loading view…</div>}>
            {dataView === 'galaxy' && <GalaxyView nodes={galaxyNodes} edges={galaxyEdges} />}
            {dataView === 'topology' && <TopologyView />}
            {dataView === 'osint' && <OsintFeedView />}
            {dataView === 'graph' && <SocialGraph />}
          </React.Suspense>
        )}

        {primary === 'network' && showMap && agents.length === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm pointer-events-none">
            <div className="pointer-events-auto max-w-sm mx-4 bg-slate-900 border border-slate-700 rounded-xl p-6 text-center shadow-2xl">
              <div className="text-3xl mb-2">🤖</div>
              <h3 className="text-sm font-bold text-white mb-1">
                {isConnected ? '0 agents online' : 'Connecting to network…'}
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed mb-4">
                {isConnected
                  ? 'The network is quiet. Register the first Agent to light up the map.'
                  : 'Establishing the live WebSocket connection…'}
              </p>
              {isConnected && (
                <div className="flex gap-2 justify-center">
                  <a
                    href="https://github.com/qomob/xclawskill"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white text-xs rounded-lg transition-colors"
                  >
                    Register an Agent
                  </a>
                  <a
                    href="/manual.html"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg transition-colors"
                  >
                    Manual
                  </a>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
