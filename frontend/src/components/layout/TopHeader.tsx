import React, { useState, useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router';
import { getToken, clearToken, getAgentIdFromToken } from '../../utils/api';
import { useI18n } from '../../i18n/LanguageContext';
import type { Lang } from '../../i18n/LanguageContext';
import { useSystemHealthContext } from '../SystemHealthContext';

interface NavItem {
  path: string;
  key: string;
}

const PRIMARY_NAV: NavItem[] = [
  { path: '/', key: 'navNetwork' },
  { path: '/skills', key: 'navMarket' },
  { path: '/tasks', key: 'navTasks' },
  { path: '/finance', key: 'navFinance' },
];

const MORE_NAV: NavItem[] = [
  { path: '/agents', key: 'navAgent' },
  { path: '/social', key: 'navSocial' },
  { path: '/protocols', key: 'navProtocols' },
  { path: '/security', key: 'navSecurity' },
  { path: '/admin', key: 'navAdmin' },
];

function LangToggle({ lang, toggleLang, compact = false }: { lang: Lang; toggleLang: () => void; compact?: boolean }) {
  return (
    <button
      onClick={toggleLang}
      className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium border transition-colors ${
        compact ? 'border-slate-700 text-slate-300' : 'border-slate-700/70 text-slate-300 hover:border-brand-500/50'
      }`}
      aria-label="Switch language / 切换语言"
      title={lang === 'zh' ? 'English' : '中文'}
    >
      <span className={lang === 'zh' ? 'text-brand-400 font-bold' : 'text-slate-400'}>中</span>
      <span className="text-slate-400">/</span>
      <span className={lang === 'en' ? 'text-brand-400 font-bold' : 'text-slate-400'}>EN</span>
    </button>
  );
}

export default function TopHeader() {
  const { t, lang, toggleLang } = useI18n();
  const health = useSystemHealthContext();
  const location = useLocation();
  const [authed, setAuthed] = useState(() => !!getToken());
  const [agentPreview, setAgentPreview] = useState(() => getAgentIdFromToken()?.slice(0, 8) || '');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onAuth = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.authenticated === true) {
        setAuthed(true);
        setAgentPreview(getAgentIdFromToken()?.slice(0, 8) || '');
      }
      if (detail?.authenticated === false) {
        setAuthed(false);
        setAgentPreview('');
      }
    };
    window.addEventListener('xclaw:auth-change', onAuth);
    return () => window.removeEventListener('xclaw:auth-change', onAuth);
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
    setMoreOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const handleLogout = () => {
    clearToken();
    setAuthed(false);
    setAgentPreview('');
    window.dispatchEvent(new CustomEvent('xclaw:auth-change', { detail: { authenticated: false } }));
  };

  const handleLogin = () => {
    window.dispatchEvent(new CustomEvent('xclaw:request-login'));
  };

  const isActive = (path: string) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);

  const moreActive =
    isActive('/agents') || isActive('/social') || isActive('/protocols') || isActive('/security') || isActive('/admin');

  const navLinkCls = (path: string) =>
    `px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
      isActive(path) ? 'bg-brand-500/15 text-brand-400' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
    }`;

  return (
    <header className="shrink-0 h-14 border-b border-slate-800 bg-slate-950/85 backdrop-blur-md z-40">
      <div className="h-full px-3 md:px-5 flex items-center gap-2 md:gap-4">
        {/* 移动端汉堡 */}
        <button
          onClick={() => setDrawerOpen(true)}
          className="lg:hidden flex items-center justify-center w-9 h-9 rounded-lg text-slate-300 hover:bg-slate-800 transition-colors"
          aria-label="Open menu"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        {/* Logo */}
        <NavLink to="/" className="flex items-center gap-2 shrink-0">
          <img src="/XClaw_logo.png" alt="XClaw" className="h-7 w-auto" />
          <span className="hidden sm:inline text-sm font-bold tracking-wider text-white">Agents Connected</span>
        </NavLink>

        {/* 桌面主导航（仅登录后显示） */}
        {authed && (
          <nav className="hidden lg:flex items-center gap-1 ml-4" aria-label="Primary navigation">
            {PRIMARY_NAV.map(item => (
              <NavLink key={item.path} to={item.path} className={navLinkCls(item.path)}>
                {t(item.key as never)}
              </NavLink>
            ))}
            <div className="relative" ref={moreRef}>
              <button
                onClick={() => setMoreOpen(o => !o)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1 ${
                  moreActive ? 'bg-brand-500/15 text-brand-400' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                {t('navMore')}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {moreOpen && (
                <div className="absolute right-0 top-full mt-1 w-44 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-1.5 z-50">
                  {MORE_NAV.map(item => (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      className={`block px-3 py-2 text-xs rounded-lg transition-colors ${
                        isActive(item.path) ? 'bg-brand-500/15 text-brand-400' : 'text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      {t(item.key as never)}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          </nav>
        )}

        <div className="ml-auto flex items-center gap-2 md:gap-3">
          {/* 系统状态点 */}
          <div
            className="hidden md:flex items-center gap-1.5"
            title={`API ${health.backend} · DB ${health.database} · Redis ${health.redis}`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                health.status === 'ok' ? 'bg-green-500' : health.status === 'degraded' ? 'bg-amber-500' : 'bg-red-500'
              }`}
              aria-hidden="true"
            />
            <span className="text-[11px] text-slate-400 hidden xl:inline">
              {health.status === 'ok' ? t('systemOperational') : health.status === 'degraded' ? t('systemDegraded') : t('systemUnreachable')}
            </span>
          </div>

          <a
            href="https://github.com/qomob/XClaw"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition-colors"
            aria-label="GitHub"
            title="GitHub"
          >
            <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>

          <LangToggle lang={lang} toggleLang={toggleLang} />

          {authed ? (
            <div className="flex items-center gap-1.5">
              <span className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-green-900/20 border border-green-800/40 text-green-400 text-[11px] font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                {agentPreview}…
              </span>
              <button
                onClick={handleLogout}
                className="px-2.5 py-1.5 rounded-lg text-[11px] text-slate-400 hover:text-red-400 hover:bg-slate-800/60 transition-colors"
                title={t('logout')}
              >
                {t('logout')}
              </button>
            </div>
          ) : (
            <button
              onClick={handleLogin}
              className="px-4 py-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-xs font-medium transition-colors"
            >
              {t('login')}
            </button>
          )}
        </div>
      </div>

      {/* 移动端抽屉 */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />
          <div className="absolute left-0 top-0 bottom-0 w-72 bg-slate-950 border-r border-slate-800 flex flex-col shadow-2xl">
            <div className="flex items-center justify-between h-14 px-4 border-b border-slate-800">
              <span className="text-sm font-bold text-white">XCLAW</span>
              <button
                onClick={() => setDrawerOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800"
                aria-label="Close menu"
              >
                ✕
              </button>
            </div>
            {authed ? (
              <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5" aria-label="Mobile navigation">
                {[...PRIMARY_NAV, ...MORE_NAV].map(item => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    className={`block px-3 py-2.5 text-sm rounded-lg transition-colors ${
                      isActive(item.path) ? 'bg-brand-500/15 text-brand-400 font-medium' : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {t(item.key as never)}
                  </NavLink>
                ))}
              </nav>
            ) : (
              <div className="flex-1 overflow-y-auto py-4 px-4 space-y-2">
                <p className="text-xs text-slate-400 leading-relaxed">
                  {t('heroSubtitle')}
                </p>
                <a
                  href="/xclawskill.html"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block px-3 py-2.5 text-sm rounded-lg text-brand-400 hover:bg-slate-800 transition-colors"
                >
                  🤖 {t('connectAgent')}
                </a>
                <a
                  href="/manual.html"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block px-3 py-2.5 text-sm rounded-lg text-slate-300 hover:bg-slate-800 transition-colors"
                >
                  📖 {t('manual')}
                </a>
              </div>
            )}
            <div className="border-t border-slate-800 p-4 flex items-center justify-between">
              <LangToggle lang={lang} toggleLang={toggleLang} compact />
              {authed ? (
                <button onClick={handleLogout} className="text-xs text-slate-400 hover:text-red-400">
                  {t('logout')}
                </button>
              ) : (
                <button onClick={handleLogin} className="px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white text-xs rounded-lg">
                  {t('login')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
