import React, { useState, useEffect } from 'react';
import { useXClawStore } from '../store/useXClawStore';

// 重型可视化组件全部懒加载，初始只加载默认视图（MAP）
const NetworkMap = React.lazy(() => import('../components/NetworkMap'));
const SocialGraph = React.lazy(() => import('../components/SocialGraph'));
const TopologyView = React.lazy(() => import('../components/TopologyView'));
const OsintFeedView = React.lazy(() => import('../components/OsintFeedView'));
const GalaxyView = React.lazy(() => import('../components/GalaxyView'));

type ViewMode = 'map' | 'galaxy' | 'topology' | 'osint' | 'graph';

export default function NetworkOverview() {
  const [view, setView] = useState<ViewMode>('map');
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

  const tabs: { key: ViewMode; label: string }[] = [
    { key: 'map', label: 'MAP' },
    { key: 'galaxy', label: 'GALAXY' },
    { key: 'topology', label: 'TOPO' },
    { key: 'osint', label: 'OSINT' },
    { key: 'graph', label: 'GRAPH' },
  ];

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-3 py-2 border-b shrink-0 border-slate-800 bg-slate-900/50">
        <div className="flex items-center gap-1">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setView(tab.key)}
              className={`px-2.5 py-1 text-[10px] font-medium rounded-md transition-colors ${
                view === tab.key
                  ? 'bg-brand-500 text-white'
                  : 'text-slate-500 hover:text-brand-400'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
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
        <React.Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-slate-500">Loading view…</div>}>
          {view === 'map' && <NetworkMap />}
          {view === 'galaxy' && <GalaxyView nodes={galaxyNodes} edges={galaxyEdges} />}
          {view === 'topology' && <TopologyView />}
          {view === 'osint' && <OsintFeedView />}
          {view === 'graph' && <SocialGraph />}
        </React.Suspense>

        {agents.length === 0 && (
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
