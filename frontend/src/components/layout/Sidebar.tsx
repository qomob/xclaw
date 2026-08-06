import React, { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router';
import { getToken } from '../../utils/api';

interface NavItem {
  path: string;
  icon: string;
  label: string;
  badge?: number;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/', icon: '🗺️', label: 'Network Overview' },
  { path: '/skills', icon: '⚡', label: 'Skill Market' },
  { path: '/tasks', icon: '📋', label: 'Task Center' },
  { path: '/finance', icon: '💰', label: 'Finance Center' },
  { path: '/agents', icon: '🤖', label: 'Agent Center' },
  { path: '/social', icon: '🕸️', label: 'Social Graph' },
  { path: '/protocols', icon: '🔧', label: 'Protocols & Tools' },
  { path: '/security', icon: '🛡️', label: 'Security Audit' },
  { path: '/admin', icon: '⚙️', label: 'System Admin' },
];

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(() =>
    localStorage.getItem('xclaw_sidebar') === 'collapsed'
  );
  const [authenticated, setAuthenticated] = useState(() => !!getToken());
  const location = useLocation();

  useEffect(() => {
    const onAuth = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.authenticated === false) setAuthenticated(false);
      if (detail?.authenticated === true) setAuthenticated(true);
    };
    window.addEventListener('xclaw:auth-change', onAuth);
    return () => window.removeEventListener('xclaw:auth-change', onAuth);
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('xclaw_sidebar', next ? 'collapsed' : 'expanded');
  };

  const handleLoginRequest = () => {
    window.dispatchEvent(new CustomEvent('xclaw:request-login'));
  };

  return (
    <aside
      className={`hidden md:flex flex-col shrink-0 h-full border-r transition-all duration-300 bg-slate-900 border-slate-800 ${
        collapsed ? 'w-16' : 'w-56'
      }`}
      data-agent-role="sidebar"
      aria-label="Main navigation sidebar"
    >
      <div className={`flex items-center h-12 border-b border-slate-800 ${collapsed ? 'justify-center' : 'px-4'}`}>
        {!collapsed && (
          <span className="text-sm font-bold tracking-wider text-brand-500">
            XCLAW
          </span>
        )}
        {collapsed && (
          <span className="text-xs font-bold text-brand-500">X</span>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto py-2 no-scrollbar" aria-label="Feature navigation">
        {authenticated ? (
          NAV_ITEMS.map(item => {
            const isActive = item.path === '/'
              ? location.pathname === '/'
              : location.pathname.startsWith(item.path);
            return (
              <NavLink
                key={item.path}
                to={item.path}
                className={`flex items-center gap-3 mx-2 px-2 py-2 rounded-lg text-xs transition-colors border-l-2 ${
                  collapsed ? 'justify-center' : ''
                } ${
                  isActive
                    ? 'bg-brand-500/20 text-brand-400 border-l-brand-500'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800 border-l-transparent'
                }`}
                title={collapsed ? item.label : undefined}
                aria-label={item.label}
                data-agent-role="nav-item"
              >
                <span className="text-base shrink-0">{item.icon}</span>
                {!collapsed && <span className="truncate">{item.label}</span>}
                {!collapsed && item.badge && (
                  <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400">
                    {item.badge}
                  </span>
                )}
              </NavLink>
            );
          })
        ) : (
          <div className={`flex flex-col items-center gap-3 px-3 py-6 ${collapsed ? 'px-1' : ''}`} data-agent-role="auth-required">
            {!collapsed && (
              <>
                <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-400">
                  🔒
                </div>
                <p className="text-[10px] text-slate-400 text-center leading-relaxed">
                  Please log in to access<br />system features
                </p>
              </>
            )}
            <button
              onClick={handleLoginRequest}
              className={`flex items-center gap-1.5 rounded-lg text-[10px] transition-colors bg-brand-500/10 text-brand-400 hover:bg-brand-500/20 border border-brand-500/20 ${
                collapsed ? 'px-1.5 py-1.5' : 'px-3 py-1.5 w-full justify-center'
              }`}
              title={collapsed ? 'Login' : undefined}
              aria-label="Open login dialog"
            >
              <span className="text-sm">{collapsed ? '🔑' : '🔑 Login'}</span>
            </button>
          </div>
        )}
      </nav>

      <div className="border-t border-slate-800">
        <a
          href="/xclawskill.html"
          target="_blank"
          rel="noopener noreferrer"
          className={`flex items-center gap-3 mx-2 px-2 py-2 rounded-lg text-xs transition-colors border-l-2 border-l-transparent text-slate-500 hover:text-slate-300 hover:bg-slate-800 ${
            collapsed ? 'justify-center' : ''
          }`}
          title={collapsed ? 'XClaw Skill' : undefined}
          aria-label="XClaw Skill"
        >
          <span className="text-base shrink-0">🧩</span>
          {!collapsed && <span className="truncate">XClaw Skill</span>}
        </a>
        <a
          href="/manual.html"
          target="_blank"
          rel="noopener noreferrer"
          className={`flex items-center gap-3 mx-2 px-2 py-2 rounded-lg text-xs transition-colors border-l-2 border-l-transparent text-slate-500 hover:text-slate-300 hover:bg-slate-800 ${
            collapsed ? 'justify-center' : ''
          }`}
          title={collapsed ? 'User Manual' : undefined}
          aria-label="User Manual"
        >
          <span className="text-base shrink-0">📖</span>
          {!collapsed && <span className="truncate">User Manual</span>}
        </a>
      </div>

      <button
        onClick={toggle}
        className="flex items-center justify-center h-10 border-t border-slate-800 text-slate-400 hover:text-slate-300 transition-colors"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <svg
          className={`w-4 h-4 transition-transform ${collapsed ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
    </aside>
  );
}
