import React from 'react';
import { NavLink, useLocation } from 'react-router';

const MOBILE_NAV = [
  { path: '/', icon: '🗺️', label: 'Overview' },
  { path: '/agents', icon: '🤖', label: 'Agent' },
  { path: '/skills', icon: '⚡', label: 'Skills' },
  { path: '/tasks', icon: '📋', label: 'Tasks' },
  { path: '/more', icon: '☰', label: 'More' },
];

export default function MobileNav() {
  const location = useLocation();

  return (
    <nav
      className="md:hidden flex items-center justify-around h-14 border-t shrink-0 bg-slate-900 border-slate-800"
      data-agent-role="mobile-nav"
      aria-label="Mobile navigation"
    >
      {MOBILE_NAV.map(item => {
        const isActive = item.path === '/'
          ? location.pathname === '/'
          : location.pathname.startsWith(item.path);
        return (
          <NavLink
            key={item.path}
            to={item.path}
            className={`flex flex-col items-center gap-0.5 px-3 py-1 text-[10px] transition-colors ${
              isActive
                ? 'text-brand-500'
                : 'text-slate-400'
            }`}
            aria-label={item.label}
            data-agent-role="nav-item"
          >
            <span className="text-lg">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
