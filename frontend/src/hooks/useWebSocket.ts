import { useEffect, useRef, useCallback, useState } from 'react';

interface WSMessage {
  type: string;
  data?: unknown;
  timestamp?: number;
  [key: string]: unknown;
}

interface UseWebSocketOptions {
  url?: string;
  channels?: string[];
  onMessage?: (msg: WSMessage) => void;
  autoReconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

interface UseWebSocketReturn {
  connected: boolean;
  connecting: boolean;
  lastMessage: WSMessage | null;
  sendMessage: (msg: WSMessage) => void;
  subscribe: (channels: string[]) => void;
  unsubscribe: (channels: string[]) => void;
  stats: { reconnects: number; messagesReceived: number; messagesSent: number };
}

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const {
    url,
    channels = [],
    onMessage,
    autoReconnect = true,
    reconnectInterval = 3000,
    maxReconnectAttempts = 10,
  } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectCountRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const channelsRef = useRef(channels);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);
  const [stats, setStats] = useState({ reconnects: 0, messagesReceived: 0, messagesSent: 0 });

  const getWsUrl = useCallback(() => {
    if (url) return url;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }, [url]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setConnecting(true);
    const wsUrl = getWsUrl();
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setConnected(true);
      setConnecting(false);
      reconnectCountRef.current = 0;

      // 自动认证
      const token = localStorage.getItem('xclaw_token');
      if (token) {
        ws.send(JSON.stringify({ type: 'auth', apiKey: token }));
      }

      // 自动订阅
      if (channelsRef.current.length > 0) {
        ws.send(JSON.stringify({ type: 'subscribe', channels: channelsRef.current }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WSMessage;
        setLastMessage(msg);
        setStats((prev) => ({ ...prev, messagesReceived: prev.messagesReceived + 1 }));
        onMessageRef.current?.(msg);
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setConnecting(false);

      if (autoReconnect && reconnectCountRef.current < maxReconnectAttempts) {
        reconnectCountRef.current++;
        setStats((prev) => ({ ...prev, reconnects: prev.reconnects + 1 }));
        reconnectTimerRef.current = setTimeout(connect, reconnectInterval);
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, [getWsUrl, autoReconnect, reconnectInterval, maxReconnectAttempts]);

  const sendMessage = useCallback((msg: WSMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
      setStats((prev) => ({ ...prev, messagesSent: prev.messagesSent + 1 }));
    }
  }, []);

  const subscribe = useCallback(
    (ch: string[]) => {
      channelsRef.current = [...new Set([...channelsRef.current, ...ch])];
      sendMessage({ type: 'subscribe', channels: ch });
    },
    [sendMessage],
  );

  const unsubscribe = useCallback(
    (ch: string[]) => {
      channelsRef.current = channelsRef.current.filter((c) => !ch.includes(c));
      sendMessage({ type: 'unsubscribe', channels: ch });
    },
    [sendMessage],
  );

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  return { connected, connecting, lastMessage, sendMessage, subscribe, unsubscribe, stats };
}
