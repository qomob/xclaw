import React, { useState, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import RealtimeProvider from './components/RealtimeProvider';
import { useThemeStore } from './store/useThemeStore';
import { getToken } from './utils/api';
import AppShell from './components/layout/AppShell';
import NetworkOverview from './pages/NetworkOverview';
import 'tailwindcss/tailwind.css';

const AgentCenter = lazy(() => import('./pages/AgentCenter'));
const SkillMarket = lazy(() => import('./pages/SkillMarket'));
const TaskCenter = lazy(() => import('./pages/TaskCenter'));
const FinanceCenter = lazy(() => import('./pages/FinanceCenter'));
const SocialGraphPage = lazy(() => import('./pages/SocialGraphPage'));
const ProtocolsPage = lazy(() => import('./pages/ProtocolsPage'));
const SecurityPage = lazy(() => import('./pages/SecurityPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const MorePage = lazy(() => import('./pages/MorePage'));

function LazyPage({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-400" /></div>}>
      {children}
    </Suspense>
  );
}

function ThemeInitializer({ children }: { children: React.ReactNode }) {
  const initTheme = useThemeStore(s => s.init);
  React.useEffect(() => { initTheme(); }, [initTheme]);
  return <>{children}</>;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(() => !!getToken());

  useEffect(() => {
    const onAuth = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.authenticated === false) setAuthed(false);
      if (detail?.authenticated === true) setAuthed(true);
    };
    window.addEventListener('xclaw:auth-change', onAuth);
    return () => window.removeEventListener('xclaw:auth-change', onAuth);
  }, []);

  if (!authed) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8" data-agent-role="auth-gate">
        <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 text-xl">
          🔒
        </div>
        <p className="text-sm text-slate-400 text-center">This page requires login to access</p>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('xclaw:request-login'))}
          className="px-4 py-2 rounded-lg text-sm bg-brand-500/10 text-brand-400 hover:bg-brand-500/20 border border-brand-500/20 transition-colors"
          aria-label="Open login dialog"
        >
          🔑 Login
        </button>
      </div>
    );
  }

  return <>{children}</>;
}

function App() {
  return (
    <RealtimeProvider>
      <ThemeInitializer>
        <BrowserRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={<NetworkOverview />} />
              <Route path="/agents" element={<ProtectedRoute><LazyPage><AgentCenter /></LazyPage></ProtectedRoute>} />
              <Route path="/skills" element={<ProtectedRoute><LazyPage><SkillMarket /></LazyPage></ProtectedRoute>} />
              <Route path="/tasks" element={<ProtectedRoute><LazyPage><TaskCenter /></LazyPage></ProtectedRoute>} />
              <Route path="/finance" element={<ProtectedRoute><LazyPage><FinanceCenter /></LazyPage></ProtectedRoute>} />
              <Route path="/social" element={<ProtectedRoute><LazyPage><SocialGraphPage /></LazyPage></ProtectedRoute>} />
              <Route path="/protocols" element={<ProtectedRoute><LazyPage><ProtocolsPage /></LazyPage></ProtectedRoute>} />
              <Route path="/security" element={<ProtectedRoute><LazyPage><SecurityPage /></LazyPage></ProtectedRoute>} />
              <Route path="/admin" element={<ProtectedRoute><LazyPage><AdminPage /></LazyPage></ProtectedRoute>} />
              <Route path="/more" element={<ProtectedRoute><LazyPage><MorePage /></LazyPage></ProtectedRoute>} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ThemeInitializer>
    </RealtimeProvider>
  );
}

export default App;
