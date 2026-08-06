import React, { useState } from 'react';
import AnimatedLogo from './AnimatedLogo';
import { getToken, clearToken } from '../utils/api';
import { useSystemHealth } from '../hooks/useSystemHealth';
import '../styles/logo-animations.css';

interface HeaderProps {
  currentTime: Date;
  sweepTime: number;
}

export default function Header({ currentTime, sweepTime }: HeaderProps) {
  const [authenticated, setAuthenticated] = useState(() => !!getToken());
  const health = useSystemHealth();
  const [agentIdPreview, setAgentIdPreview] = useState(() => {
    const token = getToken();
    if (token) {
      try { return JSON.parse(atob(token.split('.')[1])).agentId?.slice(0, 8) || ''; } catch { return ''; }
    }
    return '';
  });

  const handleLogout = () => {
    clearToken();
    setAuthenticated(false);
    setAgentIdPreview('');
    window.dispatchEvent(new CustomEvent('xclaw:auth-change', { detail: { authenticated: false } }));
  };

  const handleLoginRequest = () => {
    window.dispatchEvent(new CustomEvent('xclaw:request-login'));
  };

  const formattedTime = currentTime.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  return (
    <div className="h-10 md:h-12 border-b border-[#1E293B] flex items-center justify-between px-2 md:px-4 bg-slate-900/80 backdrop-blur-sm">
      {/* 左侧 Logo */}
      <div className="flex items-center">
        <AnimatedLogo
          src="/XClaw_logo.png"
          alt="XClaw Logo"
          className="h-6 md:h-8 w-auto"
        />
      </div>

      {/* 中间扫描动画 */}
      <div className="hidden sm:flex items-center">
        <span className="text-xs md:text-sm">SWEEP: </span>
        <span className="text-xs md:text-sm font-semibold text-cyan-400 ml-1">
          {sweepTime.toFixed(1)}s
        </span>
        <div className="ml-2 md:ml-4 w-20 md:w-32 h-1 bg-slate-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-cyan-400 transition-all duration-100 ease-linear"
            style={{ width: `${(sweepTime / 30) * 100}%` }}
          />
        </div>
      </div>

      {/* 右侧时间和状态 */}
      <div className="flex items-center gap-2 md:gap-4">
        {/* Agent 身份状态指示器 */}
        <button
          onClick={authenticated ? handleLogout : handleLoginRequest}
          className={`hidden md:flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] md:text-[12px] font-mono transition-colors ${
            authenticated
              ? 'bg-green-900/20 border border-green-800/40 text-green-400 hover:bg-green-900/30'
              : 'bg-gray-800/30 border border-gray-700/40 text-gray-400 hover:text-cyan-400 hover:border-cyan-800/40'
          }`}
          title={authenticated ? `Logged in as ${agentIdPreview}... (Click to logout)` : 'Click to login with API Key'}
        >
          <div className={`w-1.5 h-1.5 rounded-full ${authenticated ? 'bg-green-400' : 'bg-gray-600'}`} />
          {authenticated ? (
            <span>{agentIdPreview}…</span>
          ) : (
            <span>NOT AUTH</span>
          )}
        </button>

        <div className="text-xs md:text-sm font-mono">
          {formattedTime}
        </div>
        <div
          className="hidden md:flex items-center gap-2 text-xs md:text-sm"
          title={`API ${health.backend} · DB ${health.database} · Redis ${health.redis} · ${health.agentsOnline} agents online`}
        >
          <span className={`font-mono ${health.backend === 'ok' ? 'text-green-500' : 'text-red-500'}`}>
            API {health.backend === 'ok' ? 'OK' : 'DOWN'}
          </span>
          <span className={`font-mono ${health.database === 'up' ? 'text-green-500' : 'text-red-500'}`}>
            DB {health.database === 'up' ? 'UP' : 'DOWN'}
          </span>
          <span className={`font-mono ${health.redis === 'up' ? 'text-green-500' : 'text-red-500'}`}>
            RDS {health.redis === 'up' ? 'UP' : 'DOWN'}
          </span>
          <span className="font-mono text-slate-400">{health.agentsOnline} AGENTS</span>
        </div>
        <div className="md:hidden">
          <span className={`text-[12px] font-mono ${health.backend === 'ok' ? 'text-green-500' : 'text-red-500'}`}>
            {health.backend === 'ok' ? 'OK' : 'DOWN'}
          </span>
        </div>
      </div>
    </div>
  );
}
