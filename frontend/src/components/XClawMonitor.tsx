import React, { useState, useEffect, useCallback } from 'react';
import Header from './Header';
import NetworkMap from './NetworkMap';
import SocialGraph from './SocialGraph';
import TopologyView from './TopologyView';
import OsintFeedView from './OsintFeedView';
import RightPanel from './RightPanel';
import AgentConnector from './AgentConnector';
import ClawBay from './ClawBay';
import ClawOracle from './ClawOracle';
import Footer from './Footer';
import { useXClawStore } from '../store/useXClawStore';

const SIDEBAR_STATE_KEY = 'xclaw_sidebar_expanded';

export default function XClawMonitor() {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [sweepTime, setSweepTime] = useState(30.1);
  const [leftPanelOpen, setLeftPanelOpen] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [centerView, setCenterView] = useState<'map' | 'graph' | 'topology' | 'osint'>('map');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem(SIDEBAR_STATE_KEY) === 'collapsed';
  });

  const initStore = useXClawStore(state => state.init);
  const destroyStore = useXClawStore(state => state.destroy);
  const alerts = useXClawStore(state => state.alerts);

  useEffect(() => {
    initStore();
    return () => {
      destroyStore();
    };
  }, [initStore, destroyStore]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
      setSweepTime(prev => (prev < 30 ? prev + 0.1 : 0));
    }, 100);
    return () => clearInterval(interval);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_STATE_KEY, next ? 'collapsed' : 'expanded');
      return next;
    });
  }, []);

  // Close overlays on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLeftPanelOpen(false);
        setRightPanelOpen(false);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <div className="w-screen h-screen overflow-hidden flex flex-col bg-[#0B0F19] text-[#94A3B8] font-mono">
      <Header currentTime={currentTime} sweepTime={sweepTime} />

      <div className="flex-1 flex gap-2 md:gap-4 p-1.5 sm:p-2 md:p-4 overflow-hidden relative">
        {/* 移动端面板切换按钮 */}
        <div className="md:hidden absolute top-1.5 right-1.5 sm:top-2 sm:right-2 z-30 flex gap-1.5">
          <button
            onClick={() => { setLeftPanelOpen(true); setRightPanelOpen(false); }}
            className="px-2.5 py-1 bg-cyan-600 hover:bg-cyan-700 text-white text-[12px] rounded font-bold"
          >
            PANELS
          </button>
          <button
            onClick={() => { setRightPanelOpen(true); setLeftPanelOpen(false); }}
            className="px-2.5 py-1 bg-violet-600 hover:bg-violet-700 text-white text-[12px] rounded font-bold relative"
          >
            ALERTS
            {alerts.length > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[12px] rounded-full flex items-center justify-center font-bold">
                {alerts.length > 9 ? '9+' : alerts.length}
              </span>
            )}
          </button>
        </div>

        {/* 左侧边栏 - 桌面端 */}
        <div
          className={`hidden md:flex flex-col overflow-hidden h-full transition-all duration-300 ease-in-out shrink-0 ${
            sidebarCollapsed ? 'w-16' : 'w-72'
          }`}
        >
          {/* Toggle 按钮 */}
          <button
            onClick={toggleSidebar}
            className={`flex items-center transition-all duration-300 h-8 mb-1 text-gray-400 hover:text-cyan-400 rounded hover:bg-slate-800/50 ${
              sidebarCollapsed ? 'justify-center mx-auto' : 'justify-end pr-2'
            }`}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg
              className={`w-4 h-4 transition-transform duration-300 ${
                sidebarCollapsed ? 'rotate-180' : ''
              }`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          {/* Agent Connector */}
          <div className={`flex-1 overflow-y-auto min-h-0 ${sidebarCollapsed ? 'px-1' : 'pr-1'}`}>
            <AgentConnector collapsed={sidebarCollapsed} />
          </div>

          {/* ClawBay Marketplace */}
          <div className={`flex-1 overflow-y-auto min-h-0 border-t border-[#1E293B] ${
            sidebarCollapsed ? 'px-1 pt-1' : 'pr-1 pt-2'
          }`}>
            <ClawBay collapsed={sidebarCollapsed} />
          </div>

          {/* ClawOracle 信誉评价 */}
          <div className={`flex-1 overflow-y-auto min-h-0 border-t border-[#1E293B] ${
            sidebarCollapsed ? 'px-1 pt-1' : 'pr-1 pt-2'
          }`}>
            <ClawOracle collapsed={sidebarCollapsed} />
          </div>
        </div>

        {/* 左侧边栏 - 移动端 overlay */}
        <div
          className={`${
            leftPanelOpen
              ? 'fixed inset-y-0 left-0 z-40 w-80 max-w-[85vw] transition-transform duration-300 md:hidden'
              : 'hidden'
          } flex flex-col bg-[#0B0F19] border-r border-[#1E293B]`}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-[#1E293B]">
            <span className="text-xs text-cyan-400 font-bold">PANELS</span>
            <button
              onClick={() => setLeftPanelOpen(false)}
              className="w-8 h-8 bg-gray-700 text-white rounded-full flex items-center justify-center text-sm font-bold"
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 min-h-0">
            <AgentConnector collapsed={false} />
          </div>
          <div className="flex-1 overflow-y-auto border-t border-[#1E293B] pt-2 p-2 min-h-0">
            <ClawBay collapsed={false} />
          </div>
          <div className="flex-1 overflow-y-auto border-t border-[#1E293B] pt-2 p-2 min-h-0">
            <ClawOracle collapsed={false} />
          </div>
        </div>

        {/* 右侧面板 - 移动端 overlay */}
        <div
          className={`${
            rightPanelOpen
              ? 'fixed inset-y-0 right-0 z-40 w-80 max-w-[85vw] transition-transform duration-300 lg:hidden'
              : 'hidden'
          } flex flex-col bg-[#0B0F19] border-l border-[#1E293B]`}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-[#1E293B]">
            <span className="text-xs text-violet-400 font-bold">ALERTS & INFO</span>
            <button
              onClick={() => setRightPanelOpen(false)}
              className="w-8 h-8 bg-gray-700 text-white rounded-full flex items-center justify-center text-sm font-bold"
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 min-h-0">
            <RightPanel alerts={alerts} />
          </div>
        </div>

        {/* 遮罩层 - 移动端 */}
        {(leftPanelOpen || rightPanelOpen) && (
          <div
            className="md:hidden fixed inset-0 bg-black/50 z-30"
            onClick={() => { setLeftPanelOpen(false); setRightPanelOpen(false); }}
          />
        )}

        {/* 中间主视图 */}
        <div className="flex-1 border border-[#1E293B] bg-slate-900/50 backdrop-blur-sm rounded-sm overflow-hidden h-full order-2 md:order-none min-w-0 flex flex-col">
          <div className="flex items-center gap-0.5 sm:gap-1 px-1.5 sm:px-2 py-1 border-b border-[#1E293B] bg-[#0B0F19]/80 shrink-0 overflow-x-auto no-scrollbar">
            <button
              onClick={() => setCenterView('map')}
              className={`px-1.5 sm:px-2 py-0.5 text-[11px] sm:text-[12px] font-mono rounded transition-colors whitespace-nowrap ${
                centerView === 'map' ? 'bg-cyan-600 text-white' : 'text-gray-400 hover:text-cyan-400'
              }`}
            >
              MAP
            </button>
            <button
              onClick={() => setCenterView('topology')}
              className={`px-1.5 sm:px-2 py-0.5 text-[11px] sm:text-[12px] font-mono rounded transition-colors whitespace-nowrap ${
                centerView === 'topology' ? 'bg-cyan-600 text-white' : 'text-gray-400 hover:text-cyan-400'
              }`}
            >
              TOPO
            </button>
            <button
              onClick={() => setCenterView('osint')}
              className={`px-1.5 sm:px-2 py-0.5 text-[11px] sm:text-[12px] font-mono rounded transition-colors whitespace-nowrap ${
                centerView === 'osint' ? 'bg-cyan-600 text-white' : 'text-gray-400 hover:text-cyan-400'
              }`}
            >
              OSINT
            </button>
            <button
              onClick={() => setCenterView('graph')}
              className={`px-1.5 sm:px-2 py-0.5 text-[11px] sm:text-[12px] font-mono rounded transition-colors whitespace-nowrap ${
                centerView === 'graph' ? 'bg-cyan-600 text-white' : 'text-gray-400 hover:text-cyan-400'
              }`}
            >
              GRAPH
            </button>
          </div>
          <div className="flex-1 min-h-0">
            {centerView === 'map' && <NetworkMap />}
            {centerView === 'topology' && <TopologyView />}
            {centerView === 'osint' && <OsintFeedView />}
            {centerView === 'graph' && <SocialGraph />}
          </div>
        </div>

        {/* 右侧边栏 - 桌面端 */}
        <div className="hidden lg:flex flex-col w-72 shrink-0 overflow-y-auto h-full">
          <RightPanel alerts={alerts} />
        </div>
      </div>

      {/* Footer — 移动端简化版已在 footer.css 中处理 */}
      <div className="hidden md:block">
        <Footer />
      </div>
      <div className="md:hidden">
        <Footer />
      </div>
    </div>
  );
}
