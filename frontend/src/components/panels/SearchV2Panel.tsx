import { useState, useEffect, useCallback } from 'react';
import {
  fetchSearchV2Stats,
  searchV2,
  fetchSearchV2Trending,
  fetchSearchV2Gaps,
} from '../../utils/api';
import { useI18n } from '../../i18n/LanguageContext';

interface SearchV2Stats {
  total_searches: number;
  top_queries: Array<{ query: string; count: number }>;
}

interface SearchResult {
  id: string;
  name: string;
  score: number;
  type: string;
  highlights?: string;
}

interface TrendingItem {
  query: string;
  count: number;
  growth?: number;
}

interface GapItem {
  query: string;
  search_count: number;
  result_count: number;
  coverage: number;
}

export default function SearchV2Panel() {
  const { t } = useI18n();
  const [stats, setStats] = useState<SearchV2Stats | null>(null);
  const [trending, setTrending] = useState<TrendingItem[]>([]);
  const [gaps, setGaps] = useState<GapItem[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  const loadInitial = useCallback(async () => {
    try {
      const [statsRes, trendRes, gapsRes] = await Promise.allSettled([
        fetchSearchV2Stats(),
        fetchSearchV2Trending(15),
        fetchSearchV2Gaps(),
      ]);
      if (statsRes.status === 'fulfilled') setStats(statsRes.value.data ?? statsRes.value);
      if (trendRes.status === 'fulfilled') setTrending(trendRes.value.data?.trending ?? trendRes.value.data ?? []);
      if (gapsRes.status === 'fulfilled') setGaps(gapsRes.value.data?.gaps ?? gapsRes.value.data ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadInitial(); }, [loadInitial]);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = await searchV2(query.trim());
      setResults(res.data?.results ?? res.data ?? []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const maxTrendCount = Math.max(...trending.map(t => t.count), 1);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-l-4 border-cyan-500 pl-4">
        <h2 className="text-xl font-bold text-white">{t('sv2ManageTitle')}</h2>
        <p className="text-sm text-slate-400 mt-1">{t('sv2ManageDesc')}</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-4">
        <div className="bg-gray-800/50 rounded-lg sm:rounded-xl p-3 sm:p-4 border border-gray-700/50">
          <div className="text-lg sm:text-2xl mb-0.5 sm:mb-1">🔍</div>
          <div className="text-[11px] sm:text-xs text-slate-400 uppercase tracking-wider">{t('sv2TotalSearches')}</div>
          <div className="text-xl sm:text-3xl font-bold text-cyan-400 mt-0.5 sm:mt-1">{stats?.total_searches ?? '—'}</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg sm:rounded-xl p-3 sm:p-4 border border-gray-700/50">
          <div className="text-lg sm:text-2xl mb-0.5 sm:mb-1">🔥</div>
          <div className="text-[11px] sm:text-xs text-slate-400 uppercase tracking-wider">{t('sv2TopQueries')}</div>
          <div className="mt-2 space-y-1">
            {stats?.top_queries?.slice(0, 5).map((q, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="text-slate-300">{q.query}</span>
                <span className="text-cyan-400">{q.count}</span>
              </div>
            )) ?? <div className="text-slate-400 text-sm">{t('pnlNoResults')}</div>}
          </div>
        </div>
      </div>

      {/* Search Box */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('sv2SearchTest')}</h3>
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder={t('sv2QueryPlaceholder')}
            className="flex-1 px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-400 text-sm focus:outline-none focus:border-cyan-500"
          />
          <button
            onClick={handleSearch}
            disabled={loading}
            className="bg-cyan-500 hover:bg-cyan-600 rounded-lg px-4 py-2 text-sm text-white font-medium disabled:opacity-40 transition-colors"
          >
            Search
          </button>
        </div>
        {results.length > 0 ? (
          <div className="space-y-2">
            {results.map((r, i) => (
              <div key={r.id || i} className="flex items-center justify-between bg-gray-900/50 rounded-lg p-3">
                <div>
                  <div className="text-sm text-white font-medium">{r.name}</div>
                  <div className="text-xs text-slate-400">{r.type} · {r.id}</div>
                </div>
                <div className="text-sm font-bold text-cyan-400">{r.score?.toFixed(2) ?? '—'}</div>
              </div>
            ))}
          </div>
        ) : query && !loading ? (
          <div className="text-center py-4 text-slate-400 text-sm">{t('sv2NoResults')}</div>
        ) : null}
      </div>

      {/* Trending Tags Cloud */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('sv2TrendingTags')}</h3>
        {trending.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {trending.map((t, i) => {
              const size = 0.7 + (t.count / maxTrendCount) * 0.8;
              return (
                <span
                  key={i}
                  className="px-3 py-1 rounded-full bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 cursor-default hover:bg-cyan-500/25 transition-colors"
                  style={{ fontSize: `${size}rem` }}
                  title={`${t.query}: ${t.count} times${t.growth ? ` (${t.growth > 0 ? '+' : ''}${t.growth}%)` : ''}`}
                >
                  {t.query}
                </span>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-4 text-slate-400 text-sm">{t('sv2NoTrending')}</div>
        )}
      </div>

      {/* Capability Gaps */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700/50">
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('sv2GapAnalysis')}</h3>
        {gaps.length > 0 ? (
          <div className="bg-gray-900/50 rounded-lg overflow-x-auto">
            <table className="w-full text-sm min-w-[400px]">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">{t('sv2Query')}</th>
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">{t('sv2Searches')}</th>
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">{t('sv2ResultsCount')}</th>
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">{t('sv2Coverage')}</th>
                </tr>
              </thead>
              <tbody>
                {gaps.map((g, i) => (
                  <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="py-2 px-3 text-slate-300">{g.query}</td>
                    <td className="py-2 px-3 text-slate-400">{g.search_count}</td>
                    <td className="py-2 px-3 text-slate-400">{g.result_count}</td>
                    <td className="py-2 px-3">
                      <span className={`text-sm font-medium ${g.coverage < 0.5 ? 'text-red-400' : g.coverage < 0.8 ? 'text-amber-400' : 'text-emerald-400'}`}>
                        {(g.coverage * 100).toFixed(0)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-4 text-slate-400 text-sm">{t('sv2NoGap')}</div>
        )}
      </div>
    </div>
  );
}
