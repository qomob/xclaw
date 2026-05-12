import { create } from 'zustand';

interface RealtimeState {
  connected: boolean;
  nodeEvents: Array<{ event: string; timestamp: number; [key: string]: unknown }>;
  taskEvents: Array<{ event: string; timestamp: number; [key: string]: unknown }>;
  alerts: Array<{ id: string; severity: string; message: string; timestamp: number }>;
  metrics: Record<string, unknown> | null;
  lastHeartbeat: number | null;
}

interface RealtimeActions {
  init: () => void;
  destroy: () => void;
}

export const useRealtimeStore = create<RealtimeState & RealtimeActions>((set) => ({
  connected: false,
  nodeEvents: [],
  taskEvents: [],
  alerts: [],
  metrics: null,
  lastHeartbeat: null,

  init: () => {
    // WebSocket 会在组件层通过 useWebSocket hook 初始化
    // 这里主要提供全局状态管理
  },

  destroy: () => {
    set({
      connected: false,
      nodeEvents: [],
      taskEvents: [],
      alerts: [],
      metrics: null,
      lastHeartbeat: null,
    });
  },
}));

// 全局 WebSocket 状态更新方法
export const realtimeActions = {
  setConnected: (connected: boolean) => useRealtimeStore.setState({ connected }),
  pushNodeEvent: (event: RealtimeState['nodeEvents'][0]) =>
    useRealtimeStore.setState((s) => ({
      nodeEvents: [event, ...s.nodeEvents].slice(0, 50),
    })),
  pushTaskEvent: (event: RealtimeState['taskEvents'][0]) =>
    useRealtimeStore.setState((s) => ({
      taskEvents: [event, ...s.taskEvents].slice(0, 50),
    })),
  pushAlert: (alert: RealtimeState['alerts'][0]) =>
    useRealtimeStore.setState((s) => ({
      alerts: [alert, ...s.alerts].slice(0, 20),
    })),
  setMetrics: (metrics: Record<string, unknown>) => useRealtimeStore.setState({ metrics }),
  setHeartbeat: () => useRealtimeStore.setState({ lastHeartbeat: Date.now() }),
};
