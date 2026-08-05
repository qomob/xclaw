import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { getToken, clearToken } from '../../utils/api';

export default function AppHeader() {
  const navigate = useNavigate();
  const [authenticated, setAuthenticated] = useState(() => !!getToken());
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const onAuth = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.authenticated === false) setAuthenticated(false);
      if (detail?.authenticated === true) setAuthenticated(true);
    };
    window.addEventListener('xclaw:auth-change', onAuth);
    return () => window.removeEventListener('xclaw:auth-change', onAuth);
  }, []);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    navigate(`/agents?q=${encodeURIComponent(searchQuery.trim())}`);
    setSearchOpen(false);
    setSearchQuery('');
  };

  const handleLogout = () => {
    clearToken();
    setAuthenticated(false);
    window.dispatchEvent(new CustomEvent('xclaw:auth-change', { detail: { authenticated: false } }));
  };

  const formattedTime = currentTime.toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  return (
    <header
      className="h-12 flex items-center justify-between px-4 border-b shrink-0 bg-slate-900/90 border-slate-800 text-slate-300 backdrop-blur-sm"
      data-agent-role="app-header"
      role="banner"
    >
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <img src="/XClaw_logo.png" alt="XClaw" className="h-6 w-auto" />
        </div>
        <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-400" data-agent-role="network-status">
          <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          <span>NETWORK NOMINAL</span>
        </div>
      </div>

      <form onSubmit={handleSearch} className="hidden md:flex items-center max-w-md flex-1 mx-8" role="search" aria-label="Global search">
        <div className="flex items-center w-full rounded-lg px-3 py-1.5 bg-slate-800 border border-slate-700 focus-within:border-brand-500">
          <span className="text-sm mr-2 text-slate-400">🔍</span>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search agents, skills, tasks..."
            className="flex-1 bg-transparent text-xs outline-none text-white placeholder-slate-500"
            aria-label="Search keywords"
          />
        </div>
      </form>

      <div className="flex items-center gap-3">
        <span className="text-xs font-mono text-slate-400" data-agent-role="current-time">
          {formattedTime}
        </span>

        {authenticated ? (
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] transition-colors bg-green-900/20 border border-green-800/40 text-green-400 hover:bg-green-900/30"
            aria-label="Authenticated, click to logout"
            data-agent-role="auth-status"
          >
            <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
            AUTH
          </button>
        ) : (
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('xclaw:request-login'))}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] transition-colors bg-slate-800 text-slate-400 hover:text-brand-400"
            aria-label="Open login dialog"
          >
            LOGIN
          </button>
        )}

        <button
          onClick={() => setSearchOpen(!searchOpen)}
          className="md:hidden w-7 h-7 flex items-center justify-center rounded-lg text-slate-400"
          aria-label="Toggle mobile search"
        >
          🔍
        </button>
      </div>

      {searchOpen && (
        <div className="absolute top-12 left-0 right-0 p-3 border-b z-50 bg-slate-900 border-slate-800 md:hidden">
          <form onSubmit={handleSearch} className="flex gap-2" role="search">
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search..."
              className="flex-1 px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 text-white border border-slate-700"
              aria-label="Search keywords"
            />
            <button type="submit" className="px-3 py-2 bg-brand-500 text-white text-sm rounded-lg">
              Search
            </button>
          </form>
        </div>
      )}
    </header>
  );
}
