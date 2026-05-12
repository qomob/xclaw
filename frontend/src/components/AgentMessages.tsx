import { useState, useCallback, useEffect } from 'react';
import { useXClawStore } from '../store/useXClawStore';
import { fetchMessages, markMessagesRead, fetchUnreadCount, fetchOfflineMessages, fetchOfflineMessageCount } from '../utils/api';

interface Message {
  message_id: string;
  sender_id: string;
  sender_name?: string;
  type: string;
  content: string;
  task_id?: string;
  read: boolean;
  created_at: string;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
}

export default function AgentMessages() {
  const selectedAgentId = useXClawStore(state => state.selectedAgentId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [offlineMessages, setOfflineMessages] = useState<Message[]>([]);
  const [offlineCount, setOfflineCount] = useState(0);
  const [showOffline, setShowOffline] = useState(false);

  const loadMessages = useCallback(async () => {
    if (!selectedAgentId) return;
    setLoading(true);
    try {
      const res = await fetchMessages(selectedAgentId, { limit: 30 }) as ApiResponse<Message[]>;
      if (res.success) {
        setMessages(res.data || []);
      }
      const countRes = await fetchUnreadCount(selectedAgentId) as ApiResponse<{ count: number }>;
      if (countRes.success) {
        setUnreadCount(countRes.data?.count || 0);
      }
    } catch {
      // ignore fetch errors
    }
    setLoading(false);
  }, [selectedAgentId]);

  const loadOfflineCount = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      const countRes = await fetchOfflineMessageCount(selectedAgentId) as ApiResponse<{ count: number }>;
      if (countRes.success) {
        setOfflineCount(countRes.data?.count || 0);
      }
    } catch {
      // ignore
    }
  }, [selectedAgentId]);

  useEffect(() => {
    loadMessages();
    loadOfflineCount();
  }, [loadMessages, loadOfflineCount]);

  const toggleOffline = async () => {
    if (!selectedAgentId) return;
    if (!showOffline) {
      try {
        const res = await fetchOfflineMessages(selectedAgentId, { limit: 10 }) as ApiResponse<Message[]>;
        if (res.success) {
          setOfflineMessages(res.data || []);
        }
      } catch {
        // ignore
      }
    }
    setShowOffline(prev => !prev);
  };

  const handleMarkRead = async () => {
    if (!selectedAgentId) return;
    await markMessagesRead(selectedAgentId);
    setMessages(prev => prev.map(m => ({ ...m, read: true })));
    setUnreadCount(0);
  };

  if (!selectedAgentId) {
    return (
      <div className="border border-[#1E293B] bg-slate-900/50 backdrop-blur-sm rounded-sm p-2 md:p-4">
        <h2 className="text-[10px] md:text-sm font-bold text-cyan-400 mb-1.5">AGENT MESSAGES</h2>
        <p className="text-[10px] text-gray-500">Select an agent to view messages</p>
      </div>
    );
  }

  const typeColor: Record<string, string> = {
    warning: 'border-yellow-500',
    info: 'border-cyan-500',
    recommendation: 'border-green-500',
  };

  return (
    <div className="border border-[#1E293B] bg-slate-900/50 backdrop-blur-sm rounded-sm p-2 md:p-4 flex flex-col">
      <div className="flex justify-between items-center mb-1.5">
        <h2 className="text-[10px] md:text-sm font-bold text-cyan-400">
          AGENT MESSAGES
          {unreadCount > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 bg-red-500/80 text-white text-[10px] rounded-full">{unreadCount}</span>
          )}
        </h2>
        <div className="flex items-center gap-1.5">
          {unreadCount > 0 && (
            <button onClick={handleMarkRead} className="text-[10px] text-gray-400 hover:text-cyan-400">
              MARK READ
            </button>
          )}
          <button onClick={loadMessages} className="text-[10px] text-gray-400 hover:text-cyan-400">
            ↻
          </button>
          {offlineCount > 0 && (
            <button onClick={toggleOffline} className={`text-[10px] px-1.5 py-0.5 rounded-sm border ${showOffline ? 'bg-indigo-500/20 border-indigo-500 text-indigo-300' : 'border-gray-600 text-gray-400 hover:text-indigo-400 hover:border-indigo-500'}`}>
              OFFLINE ({offlineCount})
            </button>
          )}
        </div>
      </div>
      <div className="space-y-1.5 flex-1 overflow-y-auto max-h-48">
        {loading && messages.length === 0 && (
          <p className="text-[10px] text-gray-500">Loading...</p>
        )}
        {!loading && messages.length === 0 && (
          <p className="text-[10px] text-gray-500">No messages</p>
        )}
        {messages.map(msg => (
          <div
            key={msg.message_id}
            className={`border-l-2 ${typeColor[msg.type] || 'border-gray-600'} ${!msg.read ? 'bg-slate-800/50' : ''}`}
          >
            <div className="ml-1.5">
              <div className="flex justify-between items-start gap-1">
                <span className={`text-[10px] ${!msg.read ? 'text-white' : 'text-gray-400'}`}>
                  {msg.content}
                </span>
              </div>
              <div className="flex gap-2 mt-0.5">
                {msg.sender_name && (
                  <span className="text-[9px] text-cyan-600">from: {msg.sender_name}</span>
                )}
                <span className="text-[9px] text-gray-600">
                  {new Date(msg.created_at).toLocaleTimeString()}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
      {showOffline && (
        <div className="mt-2 border-t border-indigo-500/30 pt-1.5">
          <h3 className="text-[10px] font-bold text-indigo-400 mb-1">OFFLINE MESSAGES</h3>
          <div className="space-y-1.5 max-h-32 overflow-y-auto">
            {offlineMessages.length === 0 && (
              <p className="text-[10px] text-gray-500">No offline messages</p>
            )}
            {offlineMessages.map(msg => (
              <div
                key={msg.message_id}
                className="border-l-2 border-indigo-500 bg-indigo-500/5"
              >
                <div className="ml-1.5">
                  <div className="flex justify-between items-start gap-1">
                    <span className="text-[10px] text-gray-300">
                      {msg.content}
                    </span>
                  </div>
                  <div className="flex gap-2 mt-0.5">
                    {msg.sender_name && (
                      <span className="text-[9px] text-indigo-400">from: {msg.sender_name}</span>
                    )}
                    <span className="text-[9px] text-gray-600">
                      {new Date(msg.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
