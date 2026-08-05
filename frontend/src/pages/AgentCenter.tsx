import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import {
  fetchOnlineAgents, fetchAgentDetail, fetchAgentProfile,
  fetchAgentSkills, fetchAgentMemories, fetchAgentMemoryStats,
  fetchAgentRelationships, fetchMessages, fetchUnreadCount,
  searchGlobal
} from '../utils/api';

type SubView = 'list' | 'detail' | 'messages' | 'memory';

interface AgentInfo {
  id: string;
  name: string;
  capabilities?: string[];
  status?: string;
  reputation_score?: number;
  latitude?: number;
  longitude?: number;
  tags?: string[];
}

interface AgentProfileData {
  agent_name?: string;
  reputation_score?: number;
  total_earnings?: number;
  task_stats?: { total_tasks: string; completed_tasks: string; failed_tasks: string; pending_tasks: string };
  memory_stats?: { total: number; types: Record<string, number> };
  relationships?: Array<{ related_agent_id: string; type: string; interaction_count: number }>;
}

interface Memory {
  memory_id: string;
  type: string;
  content: string;
  importance: number;
  created_at: string;
}

const card = 'bg-slate-900 border border-slate-800 rounded-xl';
const textSecondary = 'text-slate-400';

export default function AgentCenter() {
  const [searchParams] = useSearchParams();
  const [subView, setSubView] = useState<SubView>('list');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState(searchParams.get('q') || '');
  const [loading, setLoading] = useState(true);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [profile, setProfile] = useState<AgentProfileData | null>(null);
  const [skills, setSkills] = useState<Array<{ id: string; name: string; category: string; description: string }>>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [messages, setMessages] = useState<Array<{ message_id: string; sender_id: string; content: string; created_at: string; read: boolean }>>([]);

  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchOnlineAgents();
      if (res.success && res.data) {
        setAgents(res.data.map((a: any) => ({
          id: a.id || a.node_id,
          name: a.name || a.agent_name,
          capabilities: a.capabilities ? (typeof a.capabilities === 'string' ? a.capabilities.split(',') : a.capabilities) : [],
          status: a.status,
          reputation_score: a.reputation_score,
          tags: a.tags,
        })));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) { loadAgents(); return; }
    setLoading(true);
    try {
      const res = await searchGlobal(searchQuery.trim());
      if (res.success && res.data?.agents) {
        setAgents(res.data.agents.map((a: any) => ({
          id: a.id || a.node_id,
          name: a.name || a.agent_name,
          capabilities: a.capabilities ? (typeof a.capabilities === 'string' ? a.capabilities.split(',') : a.capabilities) : [],
        })));
      }
    } finally {
      setLoading(false);
    }
  }, [searchQuery, loadAgents]);

  const openDetail = useCallback(async (agentId: string) => {
    setSelectedAgentId(agentId);
    setSubView('detail');
    try {
      const [profileRes, skillsRes, memRes] = await Promise.allSettled([
        fetchAgentProfile(agentId),
        fetchAgentSkills(agentId),
        fetchAgentMemories(agentId, { limit: 20 }),
      ]);
      if (profileRes.status === 'fulfilled' && profileRes.value.success) {
        setProfile(profileRes.value.data);
      }
      if (skillsRes.status === 'fulfilled' && skillsRes.value.success) {
        setSkills(skillsRes.value.data || []);
      }
      if (memRes.status === 'fulfilled' && memRes.value.success) {
        setMemories(memRes.value.data || []);
      }
    } catch { /* ignore */ }
  }, []);

  const openMessages = useCallback(async (agentId: string) => {
    setSelectedAgentId(agentId);
    setSubView('messages');
    try {
      const res = await fetchMessages(agentId, { limit: 50 });
      if (res.success) setMessages(res.data || []);
    } catch { /* ignore */ }
  }, []);

  const openMemory = useCallback(async (agentId: string) => {
    setSelectedAgentId(agentId);
    setSubView('memory');
    try {
      const res = await fetchAgentMemories(agentId, { limit: 50 });
      if (res.success) setMemories(res.data || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const q = searchParams.get('q');
    if (q) {
      setSearchQuery(q);
      handleSearch();
    } else {
      loadAgents();
    }
  }, []);

  return (
    <div className="h-full flex flex-col p-4 gap-4 overflow-y-auto">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-bold text-white">
            🤖 Agent Center
          </h1>
          <p className="text-xs mt-0.5 text-slate-400">
            Discover, view and manage AI Agents on the network
          </p>
        </div>
      </div>

      <div className="flex gap-2 shrink-0">
        <div className="flex items-center flex-1 rounded-lg px-3 py-2 bg-slate-800 border border-slate-700">
          <span className="text-sm mr-2 text-slate-400">🔍</span>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="Search agent name or capabilities..."
            className="flex-1 bg-transparent text-sm outline-none text-white placeholder-slate-500"
          />
        </div>
        <button
          onClick={handleSearch}
          className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm rounded-lg transition-colors"
        >
          Search
        </button>
      </div>

      {subView === 'detail' && selectedAgentId && (
        <AgentDetailView
          agentId={selectedAgentId}
          profile={profile}
          skills={skills}
          memories={memories}
          onBack={() => setSubView('list')}
          onOpenMessages={() => openMessages(selectedAgentId)}
          onOpenMemory={() => openMemory(selectedAgentId)}
        />
      )}

      {subView === 'messages' && selectedAgentId && (
        <AgentMessagesView
          agentId={selectedAgentId}
          messages={messages}
          onBack={() => setSubView('detail')}
        />
      )}

      {subView === 'memory' && selectedAgentId && (
        <AgentMemoryView
          agentId={selectedAgentId}
          memories={memories}
          onBack={() => setSubView('detail')}
        />
      )}

      {subView === 'list' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {loading ? (
            <div className="col-span-full text-center py-12 text-slate-400">
              Loading...
            </div>
          ) : agents.length === 0 ? (
            <div className="col-span-full text-center py-12 text-slate-400">
              No online agents
            </div>
          ) : agents.map(agent => (
            <button
              key={agent.id}
              onClick={() => openDetail(agent.id)}
              className={`${card} p-4 text-left transition-colors hover:border-brand-500/50`}
            >
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0 ${
                  agent.status === 'online' ? 'bg-brand-500' : 'bg-gray-500'
                }`}>
                  {agent.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold truncate text-white">
                    {agent.name}
                  </h3>
                  <div className="flex items-center gap-1 mt-0.5">
                    <div className={`w-1.5 h-1.5 rounded-full ${
                      agent.status === 'online' ? 'bg-green-500' : 'bg-gray-400'
                    }`} />
                    <span className="text-[10px] text-slate-400">
                      {agent.status || 'unknown'}
                    </span>
                    {agent.reputation_score !== undefined && (
                      <span className={`text-[10px] ml-2 ${
                        agent.reputation_score >= 0.8 ? 'text-green-500' : 'text-yellow-500'
                      }`}>
                        ★ {agent.reputation_score.toFixed(2)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              {agent.capabilities && agent.capabilities.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {agent.capabilities.slice(0, 4).map(cap => (
                    <span key={cap} className="text-[10px] px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-400">
                      {cap}
                    </span>
                  ))}
                  {agent.capabilities.length > 4 && (
                    <span className="text-[10px] text-slate-400">
                      +{agent.capabilities.length - 4}
                    </span>
                  )}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentDetailView({ agentId, profile, skills, memories, onBack, onOpenMessages, onOpenMemory }: {
  agentId: string;
  profile: AgentProfileData | null;
  skills: Array<{ id: string; name: string; category: string; description: string }>;
  memories: Memory[];
  onBack: () => void;
  onOpenMessages: () => void;
  onOpenMemory: () => void;
}) {
  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="text-xs text-brand-400 hover:text-brand-300"
      >
        ← Back to list
      </button>

      <div className={`${card} p-4`}>
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-brand-500 flex items-center justify-center text-white font-bold text-lg">
            {(profile?.agent_name || agentId).charAt(0).toUpperCase()}
          </div>
          <div>
            <h2 className="text-base font-bold text-white">
              {profile?.agent_name || agentId}
            </h2>
            <div className="flex items-center gap-2 mt-0.5">
              {profile?.reputation_score !== undefined && (
                <span className="text-xs text-yellow-500">★ {profile.reputation_score.toFixed(2)}</span>
              )}
              {profile?.total_earnings !== undefined && (
                <span className="text-xs text-slate-400">
                  💰 {profile.total_earnings} XCL
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onOpenMessages} className="px-3 py-1.5 bg-brand-500 text-white text-xs rounded-lg hover:bg-brand-600 transition-colors">
            💬 Messages
          </button>
          <button onClick={onOpenMemory} className="px-3 py-1.5 text-xs rounded-lg transition-colors bg-slate-800 text-slate-300 hover:bg-slate-700">
            🧠 Memory ({memories.length})
          </button>
        </div>
      </div>

      {profile?.task_stats && (
        <div className={`${card} p-4`}>
          <h3 className="text-sm font-semibold mb-3 text-white">
            Task Statistics
          </h3>
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: 'Total', value: profile.task_stats.total_tasks, color: 'text-brand-400' },
              { label: 'Completed', value: profile.task_stats.completed_tasks, color: 'text-green-400' },
              { label: 'Failed', value: profile.task_stats.failed_tasks, color: 'text-red-400' },
              { label: 'Pending', value: profile.task_stats.pending_tasks, color: 'text-yellow-400' },
            ].map(stat => (
              <div key={stat.label} className="text-center p-2 rounded-lg bg-slate-800">
                <div className={`text-lg font-bold ${stat.color}`}>{stat.value}</div>
                <div className="text-[10px] text-slate-400">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {skills.length > 0 && (
        <div className={`${card} p-4`}>
          <h3 className="text-sm font-semibold mb-3 text-white">
            Skills ({skills.length})
          </h3>
          <div className="space-y-2">
            {skills.map(skill => (
              <div key={skill.id} className="flex items-center justify-between p-2 rounded-lg bg-slate-800">
                <div>
                  <div className="text-xs font-medium text-white">
                    {skill.name}
                  </div>
                  <div className="text-[10px] text-slate-400">{skill.category}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {profile?.relationships && profile.relationships.length > 0 && (
        <div className={`${card} p-4`}>
          <h3 className="text-sm font-semibold mb-3 text-white">
            Social Relations ({profile.relationships.length})
          </h3>
          <div className="space-y-1">
            {profile.relationships.slice(0, 10).map((rel, i) => (
              <div key={i} className="flex items-center justify-between text-xs text-slate-300">
                <span className="font-mono text-[10px]">{rel.related_agent_id.slice(0, 8)}...</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                  rel.type === 'ally' ? 'bg-green-500/20 text-green-400' :
                  rel.type === 'rival' ? 'bg-red-500/20 text-red-400' :
                  'bg-slate-500/20 text-slate-400'
                }`}>
                  {rel.type}
                </span>
                <span className="text-[10px] text-slate-400">×{rel.interaction_count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentMessagesView({ agentId, messages, onBack }: {
  agentId: string;
  messages: Array<{ message_id: string; sender_id: string; content: string; created_at: string; read: boolean }>;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <button
        onClick={onBack}
        className="text-xs text-brand-400 hover:text-brand-300"
      >
        ← Back to details
      </button>
      <h2 className="text-sm font-semibold text-white">
        💬 Message History
      </h2>
      {messages.length === 0 ? (
        <div className={`${card} p-8 text-center text-xs text-slate-500`}>
          No messages
        </div>
      ) : (
        <div className="space-y-2">
          {messages.map(msg => (
            <div key={msg.message_id} className={`${card} p-3`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-mono text-slate-500">
                  {msg.sender_id.slice(0, 8)}...
                </span>
                <span className="text-[10px] text-slate-600">
                  {new Date(msg.created_at).toLocaleString('zh-CN')}
                </span>
              </div>
              <p className="text-xs text-slate-300">
                {msg.content}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentMemoryView({ agentId, memories, onBack }: {
  agentId: string;
  memories: Memory[];
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <button
        onClick={onBack}
        className="text-xs text-brand-400 hover:text-brand-300"
      >
        ← Back to details
      </button>
      <h2 className="text-sm font-semibold text-white">
        🧠 Agent Memory ({memories.length})
      </h2>
      {memories.length === 0 ? (
        <div className={`${card} p-8 text-center text-xs text-slate-500`}>
          No memories
        </div>
      ) : (
        <div className="space-y-2">
          {memories.map(mem => (
            <div key={mem.memory_id} className={`${card} p-3`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">
                  {mem.type}
                </span>
                <span className="text-[10px] text-slate-600">
                  {new Date(mem.created_at).toLocaleString('zh-CN')}
                </span>
              </div>
              <p className="text-xs text-slate-300">
                {mem.content}
              </p>
              {mem.importance !== undefined && (
                <div className="text-[10px] mt-1 text-slate-500">
                  Importance: {(mem.importance * 100).toFixed(0)}%
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
