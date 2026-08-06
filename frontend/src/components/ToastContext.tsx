import React, { createContext, useContext, useCallback, useState } from 'react';

interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

interface ToastContextValue {
  toast: (message: string, kind?: Toast['kind']) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, kind, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3500);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed top-16 right-4 z-[70] flex flex-col gap-2 max-w-sm" role="status" aria-live="polite">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`px-3.5 py-2.5 rounded-lg border text-xs shadow-2xl backdrop-blur-md ${
              t.kind === 'success'
                ? 'bg-green-900/90 border-green-700 text-green-100'
                : t.kind === 'error'
                  ? 'bg-red-900/90 border-red-700 text-red-100'
                  : 'bg-slate-800/95 border-slate-600 text-slate-100'
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}
