import React, { createContext, useContext } from 'react';
import { useSystemHealth } from '../hooks/useSystemHealth';
import type { SystemHealth } from '../hooks/useSystemHealth';

const SystemHealthContext = createContext<SystemHealth | null>(null);

export function SystemHealthProvider({ children }: { children: React.ReactNode }) {
  const health = useSystemHealth();
  return (
    <SystemHealthContext.Provider value={health}>
      {children}
    </SystemHealthContext.Provider>
  );
}

export function useSystemHealthContext(): SystemHealth {
  const ctx = useContext(SystemHealthContext);
  if (!ctx) {
    throw new Error('useSystemHealthContext must be used within SystemHealthProvider');
  }
  return ctx;
}
