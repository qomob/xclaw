import React, { useState, useEffect, useCallback } from 'react';
import { Outlet } from 'react-router';
import TopHeader from './TopHeader';
import Footer from '../Footer';
import { SystemHealthProvider } from '../SystemHealthContext';
import { LanguageProvider, useI18n } from '../../i18n/LanguageContext';
import { ToastProvider } from '../ToastContext';
import { login as apiLogin } from '../../utils/api';

function LoginModal() {
  const { t } = useI18n();
  const [loginOpen, setLoginOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  useEffect(() => {
    const onRequest = () => setLoginOpen(true);
    window.addEventListener('xclaw:request-login', onRequest);
    return () => window.removeEventListener('xclaw:request-login', onRequest);
  }, []);

  const handleLogin = useCallback(async () => {
    if (!apiKey.trim()) {
      setLoginError(t('loginErrorEmpty'));
      return;
    }
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await apiLogin(apiKey.trim());
      if (res.success) {
        setApiKey('');
        setLoginOpen(false);
        window.dispatchEvent(new CustomEvent('xclaw:auth-change', { detail: { authenticated: true } }));
      } else {
        setLoginError(`${t('loginErrorInvalid')}${res.message || ''}`);
      }
    } catch {
      setLoginError(t('loginErrorNetwork'));
    } finally {
      setLoginLoading(false);
    }
  }, [apiKey, t]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleLogin();
    if (e.key === 'Escape') setLoginOpen(false);
  };

  if (!loginOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => setLoginOpen(false)}
      data-agent-role="login-modal"
      role="dialog"
      aria-label={t('loginTitle')}
    >
      <div
        className="w-full max-w-sm mx-4 p-6 rounded-xl border bg-slate-900 border-slate-700 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-bold text-white">{t('loginTitle')}</h2>
          <button
            onClick={() => setLoginOpen(false)}
            className="w-6 h-6 flex items-center justify-center rounded text-slate-400 hover:text-slate-300 transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <p className="text-xs text-slate-400 mb-4 leading-relaxed">
          {t('loginDesc')}
        </p>

        <div className="mb-4 rounded-lg bg-slate-800/60 border border-slate-700/60 p-3 space-y-2">
          <p className="text-[11px] font-semibold text-slate-300">{t('noKeyYet')}</p>
          <ol className="list-decimal list-inside space-y-1 text-[11px] text-slate-400 leading-relaxed">
            <li>{t('noKeyStep1')}</li>
            <li>
              {t('noKeyStep2')}
              <code className="px-1 rounded bg-slate-900 text-brand-400 font-mono">xclaw-skill register</code>
            </li>
            <li>{t('noKeyStep3')}</li>
          </ol>
          <div className="flex gap-3 pt-1">
            <a
              href="/xclawskill.html"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-brand-400 hover:underline"
            >
              {t('guideLink')}
            </a>
            <a
              href="/manual.html"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-slate-400 hover:underline"
            >
              {t('manual')}
            </a>
          </div>
        </div>

        <div className="space-y-3">
          <input
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('apiKeyPlaceholder')}
            type="password"
            autoFocus
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-brand-500 placeholder-slate-400 transition-colors"
            aria-label={t('apiKeyPlaceholder')}
          />
          {loginError && (
            <p className="text-xs text-red-400" role="alert">{loginError}</p>
          )}
          <button
            onClick={handleLogin}
            disabled={loginLoading}
            className="w-full bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm py-2 rounded-lg font-medium transition-colors"
            aria-label={t('login')}
          >
            {loginLoading ? t('authenticating') : t('login')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AppShell() {
  return (
    <SystemHealthProvider>
      <LanguageProvider>
        <ToastProvider>
          <div className="w-screen h-screen overflow-hidden flex flex-col bg-slate-950 text-slate-300">
            <TopHeader />
            <main className="flex-1 overflow-y-auto bg-slate-950" data-agent-role="main-content">
              <Outlet />
            </main>
            <Footer />
            <LoginModal />
          </div>
        </ToastProvider>
      </LanguageProvider>
    </SystemHealthProvider>
  );
}
