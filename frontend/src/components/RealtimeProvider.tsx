import { useEffect } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { realtimeActions } from '../store/useWebSocketStore';

const SUBSCRIBE_CHANNELS = [
  'system:heartbeat',
  'nodes:events',
  'tasks:events',
  'alerts:events',
  'a2a:messages',
  'monitor:metrics',
];

export default function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const { connected, lastMessage } = useWebSocket({
    channels: SUBSCRIBE_CHANNELS,
    onMessage: (msg) => {
      switch (msg.type) {
        case 'system:heartbeat':
          realtimeActions.setHeartbeat();
          break;
        case 'nodes:events':
          realtimeActions.pushNodeEvent(msg as unknown as Parameters<typeof realtimeActions.pushNodeEvent>[0]);
          break;
        case 'tasks:events':
          realtimeActions.pushTaskEvent(msg as unknown as Parameters<typeof realtimeActions.pushTaskEvent>[0]);
          break;
        case 'alerts:events':
          realtimeActions.pushAlert(msg as unknown as Parameters<typeof realtimeActions.pushAlert>[0]);
          break;
        case 'monitor:metrics':
          realtimeActions.setMetrics((msg as { data: Record<string, unknown> }).data);
          break;
      }
    },
  });

  useEffect(() => {
    realtimeActions.setConnected(connected);
  }, [connected]);

  return <>{children}</>;
}
