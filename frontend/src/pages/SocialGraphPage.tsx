import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchSocialGraph, fetchRelationshipStats,
  request
} from '../utils/api';
import SocialGraph from '../components/SocialGraph';

type Tab = 'graph' | 'trust' | 'recommend' | 'communities';

interface TrustScore {
  agent_id: string;
  related_id: string;
  trust_score: number;
}

interface Community {
  id: string;
  members: string[];
  size: number;
  density: number;
}

const card = 'bg-slate-900 border border-slate-800 rounded-xl';
const textSecondary = 'text-slate-400';

export default function SocialGraphPage() {
  const [tab, setTab] = useState<Tab>('graph');
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [trustScores, setTrustScores] = useState<TrustScore[]>([]);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [loading, setLoading] = useState(false);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetchRelationshipStats();
      if (res.success) setStats(res.data || {});
    } catch { /* ignore */ }
  }, []);

  const loadTrust = useCallback(async () => {
    setLoading(true);
    try {
      const res = await request('/v1/social-graph/trust/some-agent?limit=50');
      if (res.success) setTrustScores(res.data || []);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  const loadCommunities = useCallback(async () => {
    setLoading(true);
    try {
      const res = await request('/v1/social-graph/communities?min_size=3');
      if (res.success) setCommunities(res.data?.communities || res.data || []);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    if (tab === 'trust') loadTrust();
    if (tab === 'communities') loadCommunities();
  }, [tab, loadTrust, loadCommunities]);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'graph', label: 'Graph' },
    { key: 'trust', label: 'Trust Scores' },
    { key: 'recommend', label: 'Recommend' },
    { key: 'communities', label: 'Communities' },
  ];

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-lg font-bold text-white">
          🕸️ Social Graph
        </h1>
        <p className="text-xs mt-0.5 text-slate-400">
          Agent relationship network, trust scores & community detection
        </p>
      </div>

      <div className="flex gap-1 px-4 pb-2 shrink-0">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              tab === t.key
                ? 'bg-brand-500 text-white'
                : 'text-slate-400 hover:text-white bg-slate-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0">
        {tab === 'graph' && (
          <div className="h-full">
            <SocialGraph />
          </div>
        )}

        {tab === 'trust' && (
          <div className="p-4 space-y-3 overflow-y-auto">
            {loading ? (
              <div className="text-center py-12 text-slate-400">Loading...</div>
            ) : trustScores.length === 0 ? (
              <div className={`${card} p-8 text-center text-xs text-slate-400`}>No trust score data</div>
            ) : (
              trustScores.map((ts, i) => (
                <div key={i} className={`${card} p-3 flex items-center justify-between`}>
                  <span className="text-xs font-mono text-slate-400">
                    {ts.related_id?.slice(0, 12)}...
                  </span>
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-2 rounded-full overflow-hidden bg-slate-800">
                      <div
                        className={`h-full rounded-full ${ts.trust_score >= 0.7 ? 'bg-green-500' : ts.trust_score >= 0.4 ? 'bg-yellow-500' : 'bg-red-500'}`}
                        style={{ width: `${Math.min(ts.trust_score * 100, 100)}%` }}
                      />
                    </div>
                    <span className={`text-xs font-bold ${
                      ts.trust_score >= 0.7 ? 'text-green-400' : ts.trust_score >= 0.4 ? 'text-yellow-400' : 'text-red-400'
                    }`}>
                      {(ts.trust_score * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'recommend' && (
          <div className="p-4">
            <div className={`${card} p-8 text-center text-xs text-slate-400`}>
              Agent relationship recommendations based on social graph (login required)
            </div>
          </div>
        )}

        {tab === 'communities' && (
          <div className="p-4 space-y-3 overflow-y-auto">
            {loading ? (
              <div className="text-center py-12 text-slate-400">Loading...</div>
            ) : communities.length === 0 ? (
              <div className={`${card} p-8 text-center text-xs text-slate-400`}>No community data</div>
            ) : (
              communities.map((c, i) => (
                <div key={c.id || i} className={`${card} p-4`}>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-white">
                      Community {i + 1}
                    </h3>
                    <div className="flex gap-2">
                      <span className="text-[10px] text-slate-400">{c.size} members</span>
                      <span className="text-[10px] text-slate-400">Density: {(c.density * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {c.members.slice(0, 8).map((m, mi) => (
                      <span key={mi} className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-slate-800 text-slate-400">
                        {m.slice(0, 8)}...
                      </span>
                    ))}
                    {c.members.length > 8 && (
                      <span className="text-[10px] text-slate-400">+{c.members.length - 8}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}