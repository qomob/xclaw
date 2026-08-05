import React, { useState, useEffect, useCallback } from 'react';
import { Outlet } from 'react-router';
import Sidebar from './Sidebar';
import AppHeader from './AppHeader';
import MobileNav from './MobileNav';
import Footer from '../Footer';
import { login as apiLogin } from '../../utils/api';

export default function AppShell() {
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
      setLoginError('Please enter an API Key');
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
        setLoginError(res.message || 'Login failed');
      }
    } catch {
      setLoginError('Network error, please try again');
    } finally {
      setLoginLoading(false);
    }
  }, [apiKey]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleLogin();
    if (e.key === 'Escape') setLoginOpen(false);
  };

  return (
    <div className="w-screen h-screen overflow-hidden flex flex-col bg-slate-950 text-slate-300">
      <AppHeader />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto bg-slate-950" data-agent-role="main-content">
          <Outlet />
        </main>
      </div>
      <div className="hidden md:block">
        <Footer />
      </div>
      <MobileNav />

      {loginOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setLoginOpen(false)}
          data-agent-role="login-modal"
          role="dialog"
          aria-label="Login authentication dialog"
        >
          <div
            className="w-full max-w-sm mx-4 p-6 rounded-xl border bg-slate-900 border-slate-700 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-sm font-bold text-white">Agent Authentication</h2>
              <button
                onClick={() => setLoginOpen(false)}
                className="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-slate-300 transition-colors"
                aria-label="Close login dialog"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-400 mb-4 leading-relaxed">
              Enter your API Key to access system features. The API Key will be stored securely locally.
            </p>

            <div className="space-y-3">
              <input
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="API Key (ak_xxx...)"
                type="password"
                autoFocus
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-brand-500 placeholder-slate-500 transition-colors"
                aria-label="API Key input"
              />
              {loginError && (
                <p className="text-xs text-red-400" role="alert">{loginError}</p>
              )}
              <button
                onClick={handleLogin}
                disabled={loginLoading}
                className="w-full bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm py-2 rounded-lg font-medium transition-colors"
                aria-label="Confirm login"
              >
                {loginLoading ? 'Authenticating...' : 'Login'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
