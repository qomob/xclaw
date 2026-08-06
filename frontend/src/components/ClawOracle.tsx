import { useState, useEffect, useCallback } from 'react';
import {
  fetchReviewRankings, fetchCategoryRankings,
  fetchSkillReviews, postReview,
  AuthError, getToken
} from '../utils/api';

interface RankedSkill {
  id: string;
  name: string;
  category: string;
  price: number;
  avg_rating: number;
  review_count: number;
  sales_count: number;
  total_revenue: number;
  seller_name?: string;
  seller_reputation?: number;
}

interface CategoryStat {
  category: string;
  skill_count: number;
  top_rated_count: number;
  category_avg_rating: number;
  total_sales: number;
  total_revenue: number;
}

interface Review {
  review_id: string;
  rating: number;
  comment: string;
  weighted_rating: number;
  reviewer_name?: string;
  reviewer_reputation?: number;
  created_at: string;
}

type View = 'rankings' | 'categories' | 'reviews';

export default function ClawOracle({ collapsed = false }: { collapsed?: boolean }) {
  const [view, setView] = useState<View>('rankings');
  const [rankings, setRankings] = useState<RankedSkill[]>([]);
  const [categories, setCategories] = useState<CategoryStat[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedSkillName, setSelectedSkillName] = useState('');
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState('');
  const [needsAuth, setNeedsAuth] = useState(!getToken());

  const fetchData = useCallback(async () => {
    try {
      const [rankRes, catRes] = await Promise.all([
        fetchReviewRankings({ limit: 20 }),
        fetchCategoryRankings()
      ]);
      if (rankRes.success) setRankings(rankRes.data);
      if (catRes.success) setCategories(catRes.data);
    } finally {
      setLoading(false);
    }
  }, []);

  const openReviews = async (skillId: string, skillName: string) => {
    setSelectedSkillId(skillId);
    setSelectedSkillName(skillName);
    setView('reviews');
    try {
      const res = await fetchSkillReviews(skillId, { limit: 15 });
      if (res.success) setReviews(res.data);
    } catch { void 0; }
  };

  const handleSubmitReview = async () => {
    if (!selectedSkillId) return;
    try {
      const res = await postReview(selectedSkillId, reviewRating, reviewComment || undefined);
      if (res.success) {
        alert('Review submitted!');
        setReviewComment('');
        const revRes = await fetchSkillReviews(selectedSkillId, { limit: 15 });
        if (revRes.success) setReviews(revRes.data);
      } else {
        alert(`Failed: ${res.message}`);
      }
    } catch (e) {
      if (e instanceof AuthError) { setNeedsAuth(true); return; }
    }
  };

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    const onAuthChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.authenticated === false) setNeedsAuth(true);
      if (detail?.authenticated === true) setNeedsAuth(false);
    };
    window.addEventListener('xclaw:auth-change', onAuthChange);
    return () => { window.removeEventListener('xclaw:auth-change', onAuthChange); };
  }, []);

  const stars = (r: number) => '\u2605'.repeat(Math.round(r)) + '\u2606'.repeat(5 - Math.round(r));
  const ratingColor = (r: number) =>
    r >= 4 ? 'text-green-400' : r >= 3 ? 'text-yellow-400' : 'text-red-400';
  const rankBorder = (i: number) =>
    i === 0 ? 'border-l-yellow-500 border-yellow-800/40' :
    i === 1 ? 'border-l-gray-300 border-gray-700/40' :
    i === 2 ? 'border-l-orange-600 border-orange-800/30' :
    'border-l-purple-500 border-purple-800/30';
  const filteredRankings = categoryFilter
    ? rankings.filter(r => r.category === categoryFilter)
    : rankings;

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 pt-2">
        <span className="text-purple-400 text-lg">🔮</span>
        <span className="text-[7px] text-gray-400 text-center leading-tight">ORACLE</span>
        <span className="text-[7px] text-purple-400">{rankings.length}</span>
      </div>
    );
  }

  const viewBtn = (v: View, label: string) => (
    <button key={v} onClick={() => setView(v)}
      className={`text-[12px] md:text-[12px] px-1.5 py-0.5 rounded transition-colors ${
        view === v ? 'bg-purple-600/80 text-white' : 'text-gray-400 hover:text-purple-400'
      }`}>
      {label}
    </button>
  );

  return (
    <div className="flex flex-col h-full bg-slate-900/50 rounded-sm border border-[#1E293B] p-2 md:p-4 space-y-2 md:space-y-3 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-700">
      <h2 className="text-xs md:text-sm font-bold text-cyan-400 mb-1 md:mb-2 flex items-center gap-1 md:gap-2">
        <span className="text-purple-400 text-[12px] md:text-sm">🔮</span> CLAW ORACLE
      </h2>

      <p className="text-[12px] md:text-[11px] text-gray-400 leading-relaxed">
        Weighted reputation system for XClaw skills.
        Reviews are weighted by reviewer reputation to ensure quality and prevent manipulation.
      </p>

      <div className="flex gap-1 flex-wrap">{viewBtn('rankings', 'Rankings')}{viewBtn('categories', 'Categories')}{viewBtn('reviews', 'Reviews')}</div>

      {/* ===== RANKINGS VIEW ===== */}
      {view === 'rankings' && (
        <>
          {categories.length > 0 && (
            <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
              className="w-full bg-black/30 border border-gray-700 rounded px-2 py-1.5 text-[11px] md:text-[12px] text-white outline-none focus:border-purple-500">
              <option value="">All Categories</option>
              {categories.map(c => (
                <option key={c.category} value={c.category}>{c.category} ({c.skill_count})</option>
              ))}
            </select>
          )}

          <div className="space-y-2 md:space-y-2.5 min-h-0">
            {loading ? (
              <div className="border border-purple-800/40 bg-black/30 rounded p-4 text-center text-[11px] text-gray-400 animate-pulse">Loading rankings...</div>
            ) : filteredRankings.length === 0 ? (
              <div className="border border-gray-800/40 bg-black/30 rounded p-4 text-center text-[11px] text-gray-400">No data.</div>
            ) : filteredRankings.map((s, i) => (
              <button key={s.id} onClick={() => openReviews(s.id, s.name)}
                className={`w-full text-left bg-black/30 rounded border border-l-2 ${rankBorder(i)} p-2 md:p-2.5 space-y-1 hover:border-purple-700/50 transition-colors`}>
                <div className="flex items-start gap-2">
                  <span className={`text-[12px] md:text-xs font-bold w-5 text-center shrink-0 ${i < 3 ? 'text-amber-400' : 'text-gray-400'}`}>#{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[12px] md:text-xs font-semibold text-white truncate">{s.name}</h3>
                    <p className="text-[12px] md:text-[11px] text-gray-400">{s.category} · {s.seller_name || 'Unknown'}</p>
                  </div>
                  <div className="text-right shrink-0 ml-1">
                    <div className={`text-[12px] md:text-xs font-bold ${ratingColor(s.avg_rating)}`}>{stars(s.avg_rating)}</div>
                    <div className="text-[7px] text-gray-400">{s.avg_rating.toFixed(1)} · {s.review_count} rev</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {/* ===== CATEGORIES VIEW ===== */}
      {view === 'categories' && (
        <div className="space-y-2 md:space-y-2.5 min-h-0">
          {categories.map(cat => (
            <div key={cat.category}
              className={`bg-black/30 rounded border border-l-2 ${Number(cat.category_avg_rating) >= 4 ? 'border-l-green-500 border-green-800/30' : Number(cat.category_avg_rating) >= 3 ? 'border-l-yellow-500 border-yellow-800/30' : 'border-l-red-500 border-red-800/30'} p-2 md:p-2.5 space-y-1.5`}>
              <div className="flex justify-between items-center">
                <h3 className="text-[12px] md:text-xs font-semibold text-white">{cat.category}</h3>
                <span className={`text-[12px] md:text-xs font-bold ${ratingColor(cat.category_avg_rating)}`}>
                  {Number(cat.category_avg_rating).toFixed(1)}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {[['Skills', cat.skill_count, 'text-cyan-300'], ['Top-rated', cat.top_rated_count, 'text-amber-300'], ['Sold', cat.total_sales, 'text-green-300']].map(([k, v, c]) => (
                  <div key={k} className="space-y-0.5"><div className="text-[7px] text-gray-400">{k}</div><div className={`text-[11px] font-medium ${c}`}>{v}</div></div>
                ))}
              </div>
              <div className="mt-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-red-500 via-yellow-500 to-green-500"
                  style={{ width: `${Math.min(100, cat.category_avg_rating * 20)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ===== REVIEWS VIEW ===== */}
      {view === 'reviews' && (
        <div className="space-y-2 md:space-y-3 min-h-0">
          {selectedSkillId ? (
            <>
              <button onClick={() => setView('rankings')} className="text-[11px] md:text-[12px] text-cyan-400 hover:underline flex items-center gap-1">&larr; Back to Rankings</button>

              <div className="bg-black/30 rounded border border-l-2 border-l-purple-500 border-purple-800/30 p-2.5 md:p-3 space-y-1.5">
                <h3 className="text-[11px] md:text-sm font-bold text-white flex items-center gap-1.5">
                  <span className="text-purple-400">★</span> {selectedSkillName}
                </h3>
                <p className="text-[12px] text-gray-400">{reviews.length} reviews</p>
              </div>

              <div className="space-y-1.5">
                {reviews.length === 0 ? (
                  <div className="border border-gray-800/40 bg-black/30 rounded p-3 text-center text-[12px] text-gray-400">No reviews yet.</div>
                ) : reviews.map(r => (
                  <div key={r.review_id}
                    className={`bg-black/30 rounded border border-l-2 ${r.rating >= 4 ? 'border-l-green-500 border-green-800/20' : r.rating >= 3 ? 'border-l-yellow-500 border-yellow-800/20' : 'border-l-red-500 border-red-800/20'} p-2 space-y-0.5`}>
                    <div className="flex justify-between items-center">
                      <span className={`text-[11px] md:text-[12px] font-medium ${ratingColor(r.rating)}`}>{stars(r.rating)}</span>
                      <div className="flex items-center gap-1">
                        <span className="text-[7px] text-gray-400">{r.reviewer_name?.slice(0, 8) || 'Anonymous'}</span>
                        {r.reviewer_reputation !== undefined && (
                          <span className="text-[6px] px-1 py-0.5 rounded bg-purple-900/30 text-purple-300 font-medium">
                            {(r.reviewer_reputation * 100).toFixed(0)}%
                          </span>
                        )}
                      </div>
                    </div>
                    {r.comment && <p className="text-[12px] text-gray-300 leading-relaxed">{r.comment}</p>}
                    <div className="text-[6px] text-gray-400 mt-0.5">Weighted score: {r.weighted_rating.toFixed(2)}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-1.5 pt-1 border-t border-slate-800">
                <h3 className="text-[12px] md:text-xs font-semibold text-white flex items-center gap-1.5"><span className="text-purple-400">✎</span> Write a Review</h3>
                {needsAuth ? (
                  <div className="bg-black/30 rounded border border-l-2 border-l-purple-500 border-purple-800/30 p-3 space-y-1.5">
                    <p className="text-[12px] text-gray-400 text-center">Authenticate to post reviews</p>
                    <button onClick={() => window.dispatchEvent(new CustomEvent('xclaw:request-login'))}
                      className="w-full bg-purple-600 hover:bg-purple-700 text-white text-[11px] py-1.5 rounded font-medium transition-colors">Go to Auth</button>
                    <p className="text-[7px] text-gray-400 text-center">Use <code className="bg-slate-800 px-1 rounded">xclaw-skill login</code> to get your API Key</p>
                  </div>
                ) : (
                  <div className="bg-black/30 rounded border border-purple-800/30 p-2.5 space-y-1.5">
                    <div className="flex gap-1">
                      {[1, 2, 3, 4, 5].map(n => (
                        <button key={n} onClick={() => setReviewRating(n)}
                          className={`text-base transition-transform ${n <= reviewRating ? 'text-yellow-400 scale-110' : 'text-gray-400 hover:text-gray-400'}`}>&#9733;</button>
                      ))}
                      <span className="text-[12px] text-gray-400 self-end ml-1">{reviewRating}/5</span>
                    </div>
                    <textarea value={reviewComment} onChange={e => setReviewComment(e.target.value)}
                      placeholder="Share your experience..."
                      className="w-full bg-slate-900/50 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-white outline-none focus:border-purple-500 resize-none placeholder-gray-500"
                      rows={2} />
                    <button onClick={handleSubmitReview}
                      className="w-full bg-purple-600 hover:bg-purple-700 text-white text-[11px] py-1.5 rounded font-medium transition-colors">Submit Review</button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="border border-purple-800/40 bg-black/30 rounded p-4 text-center text-[11px] text-gray-400">
              Select a skill from Rankings to view and write reviews.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
