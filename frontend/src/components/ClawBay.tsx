import { useState, useEffect, useCallback } from 'react';
import {
  fetchMarketplaceListings, fetchListingDetail, placeOrder,
  fetchMyOrders, fetchSkillReviews, postReview, fetchTopRatedSkills,
  searchSkills, fetchFeaturedSkills, fetchMarketplaceStats,
  AuthError, login as apiLogin, getToken,
  fetchOrderDetail, runTask, pollTask,
  registerSkill, listSkill, delistSkill, fetchAgentSkills, getAgentIdFromToken,
} from '../utils/api';
import { useI18n } from '../i18n/LanguageContext';
import { useToast } from './ToastContext';
import { ErrorState, EmptyState } from './StateNotice';

interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  tags?: string[];
  price: number;
  is_listed: boolean;
  featured: boolean;
  sales_count: number;
  total_revenue: number;
  avg_rating: number;
  review_count: number;
  seller_name?: string;
  seller_reputation?: number;
  seller_status?: string;
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

interface Order {
  order_id: string;
  skill_id: string;
  skill_name: string;
  amount: number;
  commission: number;
  status: string;
  created_at: string;
  seller_name?: string;
}

interface MarketStats {
  listed_skills: number;
  total_orders: number;
  total_revenue: number;
  avg_market_rating: number;
  active_sellers: number;
  completed_orders: number;
  total_volume: number;
}

type Tab = 'discover' | 'market' | 'detail' | 'orders' | 'top' | 'publish';

export default function ClawBay({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<Tab>('market');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [discoverSkills, setDiscoverSkills] = useState<Skill[]>([]);
  const [featured, setFeatured] = useState<Skill[]>([]);
  const [topRated, setTopRated] = useState<Skill[]>([]);
  const [stats, setStats] = useState<MarketStats | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [sortBy] = useState('created_at');
  const [orderStatus, setOrderStatus] = useState('');
  const [orderLoading, setOrderLoading] = useState(false);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState('');
  const [needsAuth, setNeedsAuth] = useState(!getToken());
  const [apiKey, setApiKey] = useState('');
  const [loginError, setLoginError] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [taskRunning, setTaskRunning] = useState(false);
  const [taskStatus, setTaskStatus] = useState<{ task_id: string; status: string; result?: string | Record<string, unknown>; error?: string } | null>(null);
  const [mySkills, setMySkills] = useState<Array<{ id: string; name: string; category: string; version: string; price: number | string; is_listed: boolean; sales_count?: number }>>([]);
  const [pubForm, setPubForm] = useState({ name: '', description: '', category: '', version: '1.0.0', price: '' });
  const [pubStatus, setPubStatus] = useState('');
  const [pubBusy, setPubBusy] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [listRes, featRes, statsRes, topRes] = await Promise.all([
        fetchMarketplaceListings({ limit: 50, sort: sortBy }),
        fetchFeaturedSkills(6),
        fetchMarketplaceStats(),
        fetchTopRatedSkills(10)
      ]);
      setLoadError(false);
      if (listRes.success) setSkills(listRes.data);
      if (featRes.success) setFeatured(featRes.data);
      if (statsRes.success) setStats(statsRes.data);
      if (topRes.success) setTopRated(topRes.data);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [sortBy]);

  const discoverSearch = useCallback(async (term: string) => {
    try {
      const res = await searchSkills(term);
      if (res.success) setDiscoverSkills(res.data);
    } catch { void 0; }
  }, []);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetchMyOrders({ status: orderStatus || undefined, limit: 20 });
      if (res.success) setOrders(res.data);
    } catch (e) {
      if (e instanceof AuthError) { setNeedsAuth(true); return; }
    }
  }, [orderStatus]);

  const openDetail = async (skill: Skill) => {
    setSelectedSkill(skill);
    setActiveTab('detail');
    try {
      const [detailRes, revRes] = await Promise.all([
        fetchListingDetail(skill.id),
        fetchSkillReviews(skill.id, { limit: 10 })
      ]);
      if (detailRes.success) setSelectedSkill(detailRes.data);
      if (revRes.success) setReviews(revRes.data);
    } catch { void 0; }
  };

  const handleBuy = async () => {
    if (!selectedSkill) return;
    setOrderLoading(true);
    try {
      const res = await placeOrder(selectedSkill.id);
      if (res.success) {
        toast(`${t('cbOrderId')}: ${res.data.order_id?.slice(0, 12)}… · ${res.data.amount} XCL`, 'success');
        fetchOrders();
      } else {
        toast(res.message || t('loadFailedHint'), 'error');
      }
    } catch (e) {
      if (e instanceof AuthError) { setNeedsAuth(true); setOrderLoading(false); return; }
      const err = e as { message?: string };
      toast(err.message || t('loadFailedHint'), 'error');
    } finally {
      setOrderLoading(false);
    }
  };

  const handleReview = async () => {
    if (!selectedSkill) return;
    try {
      const res = await postReview(selectedSkill.id, reviewRating, reviewComment || undefined);
      if (res.success) {
        toast(t('cbSubmitReview'), 'success');
        setReviewComment('');
        const revRes = await fetchSkillReviews(selectedSkill.id, { limit: 10 });
        if (revRes.success) setReviews(revRes.data);
      } else {
        toast(res.message || t('cbSubmitReview'), 'error');
      }
    } catch (e) {
      if (e instanceof AuthError) { setNeedsAuth(true); return; }
    }
  };

  const handleLogin = async () => {
    setLoginError('');
    try {
      const res = await apiLogin(apiKey);
      if (res.success) {
        setNeedsAuth(false);
        setApiKey('');
        fetchOrders();
        window.dispatchEvent(new CustomEvent('xclaw:auth-change', { detail: { authenticated: true } }));
      } else {
        setLoginError(res.message || 'Login failed');
      }
    } catch { setLoginError('Network error'); }
  };

  const handleSelectOrder = async (orderId: string) => {
    try {
      const res = await fetchOrderDetail(orderId);
      if (res.success) setSelectedOrder(res.data);
    } catch (e) {
      if (e instanceof AuthError) { setNeedsAuth(true); return; }
    }
  };

  const handleRunTask = async () => {
    if (!selectedSkill) return;
    setTaskRunning(true);
    setTaskStatus(null);
    try {
      const res = await runTask({ skill_id: selectedSkill.id, params: {} });
      if (res.success && res.data?.task_id) {
        const tid = res.data.task_id;
        setTaskStatus({ task_id: tid, status: res.data.status || 'pending' });
        // Poll for completion
        const pollInterval = setInterval(async () => {
          try {
            const pollRes = await pollTask(tid);
            if (pollRes.success && pollRes.data) {
              const task = Array.isArray(pollRes.data) ? pollRes.data.find((t: { task_id: string }) => t.task_id === tid) : pollRes.data;
              if (task) {
                setTaskStatus(task);
                if (task.status === 'completed' || task.status === 'failed') {
                  clearInterval(pollInterval);
                  setTaskRunning(false);
                }
              }
            }
          } catch { clearInterval(pollInterval); setTaskRunning(false); }
        }, 2000);
        // Safety timeout after 60s
        setTimeout(() => { clearInterval(pollInterval); setTaskRunning(false); }, 60000);
      } else {
        setTaskStatus({ task_id: '', status: 'failed', error: res.message || 'Failed to start task' });
        setTaskRunning(false);
      }
    } catch (e) {
      if (e instanceof AuthError) { setNeedsAuth(true); }
      const err = e as { message?: string };
      setTaskStatus({ task_id: '', status: 'failed', error: err.message || 'Network error' });
      setTaskRunning(false);
    }
  };

  const loadMySkills = useCallback(async () => {
    const agentId = getAgentIdFromToken();
    if (!agentId) return;
    try {
      const res = await fetchAgentSkills(agentId);
      if (res.success) setMySkills(res.data || []);
    } catch { /* ignore */ }
  }, []);

  const handlePublish = async () => {
    const agentId = getAgentIdFromToken();
    const price = parseFloat(pubForm.price);
    if (!agentId || !pubForm.name.trim() || !pubForm.category || !price || price <= 0) {
      setPubStatus('error');
      return;
    }
    setPubBusy(true);
    setPubStatus('');
    try {
      const reg = await registerSkill({
        name: pubForm.name.trim(),
        description: pubForm.description.trim(),
        category: pubForm.category,
        version: pubForm.version || '1.0.0',
        node_id: agentId,
      });
      if (!reg.success || !reg.data?.skill_id) {
        setPubStatus('error');
        return;
      }
      const listed = await listSkill(reg.data.skill_id, price);
      if (!listed.success) {
        setPubStatus('error');
        return;
      }
      setPubStatus('success');
      toast(`${t('cbPublishOk')} · ${pubForm.name.trim()} @ ${price} XCL`, 'success');
      setPubForm({ name: '', description: '', category: '', version: '1.0.0', price: '' });
      loadMySkills();
      fetchData();
    } catch {
      setPubStatus('error');
    } finally {
      setPubBusy(false);
    }
  };

  const handleDelist = async (skillId: string) => {
    try {
      const res = await delistSkill(skillId);
      toast(res.success ? t('cbPubDelisted') : (res.error || t('cbPubDelist')), res.success ? 'success' : 'error');
      loadMySkills();
      fetchData();
    } catch (e) {
      toast(e instanceof Error ? e.message : t('cbPubDelist'), 'error');
    }
  };

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { if (activeTab === 'publish') loadMySkills(); }, [activeTab, loadMySkills]);
  useEffect(() => { discoverSearch(discoverQuery); }, [discoverQuery, discoverSearch]);
  useEffect(() => { if (activeTab === 'orders') fetchOrders(); }, [activeTab, fetchOrders]);

  useEffect(() => {
    const onLoginRequest = () => { setActiveTab('orders'); };
    const onAuthChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.authenticated === false) setNeedsAuth(true);
    };
    window.addEventListener('xclaw:request-login', onLoginRequest);
    window.addEventListener('xclaw:auth-change', onAuthChange);
    return () => {
      window.removeEventListener('xclaw:request-login', onLoginRequest);
      window.removeEventListener('xclaw:auth-change', onAuthChange);
    };
  }, []);

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 pt-2">
        <span className="text-amber-400 text-lg">⚡</span>
        <span className="text-[7px] text-gray-400 text-center leading-tight">CLAW<br />BAY</span>
        <span className="text-[7px] text-amber-400">{stats?.listed_skills || 0}</span>
      </div>
    );
  }

  const statusColor = (s: string) =>
    s === 'completed' ? 'border-green-500' : s === 'processing' ? 'border-yellow-500' : s === 'failed' ? 'border-red-500' : 'border-gray-600';
  const statusLabel = (s: string) =>
    ({ pending: t('cbStatusPending'), processing: t('cbStatusProcessing'), completed: t('cbStatusCompleted'), failed: t('cbStatusFailed') }[s] || s);
  const stars = (r: number) => '\u2605'.repeat(Math.round(r)) + '\u2606'.repeat(5 - Math.round(r));

  const tabBtn = (tab: Tab, label: string) => (
    <button key={tab} onClick={() => setActiveTab(tab)}
      className={`text-[12px] md:text-[12px] px-1.5 py-0.5 rounded transition-colors ${
        activeTab === tab ? 'bg-amber-600/80 text-white' : 'text-gray-400 hover:text-amber-400'
      }`}>
      {label}
    </button>
  );

  const statBadge = (label: string, value: string | number, color: string) => (
    <div><div className="text-[7px] md:text-[12px] text-gray-400">{label}</div><div className={`text-[11px] md:text-[12px] font-bold ${color}`}>{value}</div></div>
  );

  return (
    <div className="flex flex-col h-full bg-slate-900/50 rounded-sm border border-[#1E293B] p-2 md:p-4 space-y-2 md:space-y-3 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-700">
      <h2 className="text-xs md:text-sm font-bold text-cyan-400 mb-1 md:mb-2 flex items-center gap-1 md:gap-2">
        <span className="text-amber-400 text-[12px] md:text-sm">⚡</span> {t('cbTitle')}
      </h2>

      <p className="text-[12px] md:text-[11px] text-gray-400 leading-relaxed">
        {t('cbDesc')}
      </p>

      <div className="flex gap-1 flex-wrap">{tabBtn('discover', t('cbDiscover'))}{tabBtn('market', t('cbMarket'))}{tabBtn('top', t('cbTop'))}{tabBtn('orders', t('cbOrders'))}{tabBtn('publish', t('cbPublish'))}</div>

      {stats && (
        <div className="grid grid-cols-3 gap-1.5 md:gap-2">
          {statBadge(t('cbListed'), stats.listed_skills, 'text-cyan-400')}
          {statBadge(t('cbTraded'), stats.completed_orders || 0, 'text-green-400')}
          {statBadge(t('cbAvgRating'), Number(stats.avg_market_rating).toFixed(1), 'text-amber-400')}
        </div>
      )}

      {/* ===== DISCOVER TAB ===== */}
      {activeTab === 'discover' && (
        <>
          <div className="flex gap-1.5">
            <input value={discoverQuery} onChange={e => setDiscoverQuery(e.target.value)}
              placeholder={t('cbSemanticPlaceholder')}
              className="flex-1 bg-black/30 border border-gray-700 rounded px-2 py-1.5 text-[11px] md:text-[12px] text-white outline-none focus:border-cyan-500 placeholder-gray-500" />
            <button onClick={() => discoverSearch(discoverQuery)}
              className="bg-cyan-600 hover:bg-cyan-700 text-white text-[11px] px-2.5 py-1.5 rounded shrink-0 font-medium">🔍</button>
          </div>

          <div className="space-y-2 md:space-y-2.5 min-h-0">
            {!discoverQuery && discoverSkills.length === 0 ? (
              <div className="border border-cyan-800/40 bg-black/30 rounded p-3 text-center text-[11px] text-gray-400 animate-pulse">{t('cbScanning')}</div>
            ) : discoverSkills.length === 0 ? (
              <div className="border border-gray-800/40 bg-black/30 rounded p-3 text-center text-[11px] text-gray-400">{t('cbNoMatch')}</div>
            ) : discoverSkills.map(s => (
              <div key={s.id} onClick={() => openDetail(s as Skill)}
                className={`bg-black/30 rounded border border-l-2 ${s.is_listed ? 'border-l-amber-500 border-amber-800/30 hover:border-amber-700/50' : 'border-l-cyan-500 border-cyan-800/30 hover:border-cyan-700/50'} p-2 md:p-2.5 space-y-1 cursor-pointer transition-colors`}>
                <h3 className="text-[12px] md:text-xs font-semibold text-white flex items-center gap-1.5">
                  <span className={s.is_listed ? 'text-amber-400' : 'text-cyan-400'}>{s.is_listed ? '$' : '✧'}</span> {s.name}
                </h3>
                <p className="text-[12px] md:text-[11px] text-gray-400 leading-relaxed line-clamp-2">{s.description}</p>
                <div className="flex items-center gap-2 text-[7px] md:text-[12px] text-gray-400">
                  <span className="bg-slate-800 px-1 py-0.5 rounded uppercase">{s.category}</span>
                  {s.version && <span>v{s.version}</span>}
                  {(s as unknown as { tags?: string[] }).tags?.slice(0, 3).map((t: string) => (
                    <span key={t} className="text-cyan-500/70">#{t}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ===== MARKET TAB ===== */}
      {activeTab === 'market' && (
        <>
          <div className="flex gap-1.5">
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder={t('cbFilterPlaceholder')}
              className="flex-1 bg-black/30 border border-gray-700 rounded px-2 py-1.5 text-[11px] md:text-[12px] text-white outline-none focus:border-amber-500 placeholder-gray-500" />
            <button onClick={() => fetchData()}
              className="bg-amber-600 hover:bg-amber-700 text-white text-[11px] px-2.5 py-1.5 rounded shrink-0 font-medium">🔍</button>
          </div>

          {featured.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] md:text-[12px] font-semibold text-amber-300 flex items-center gap-1"><span>★</span> {t('cbFeatured')}</div>
              <div className="flex gap-1.5 overflow-x-auto pb-1">
                {featured.slice(0, 4).map(s => (
                  <button key={s.id} onClick={() => openDetail(s)}
                    className="shrink-0 bg-black/30 border border-l-2 border-l-amber-500 border-amber-800/30 rounded p-2 text-left min-w-[110px] space-y-1 hover:border-amber-700/50 transition-colors">
                    <div className="text-[11px] md:text-[12px] font-semibold text-white truncate">{s.name}</div>
                    <div className="text-[12px] text-amber-400 font-medium">{s.price} XCL</div>
                    {s.avg_rating > 0 && <div className="text-[7px] text-yellow-400">{stars(s.avg_rating)}</div>}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2 md:space-y-2.5 min-h-0">
            {loadError ? (
              <ErrorState onRetry={fetchData} />
            ) : loading ? (
              <div className="border border-amber-800/40 bg-black/30 rounded p-4 text-center text-[11px] text-gray-400 animate-pulse">{t('cbLoading')}</div>
            ) : skills.filter(s => !searchQuery || s.name.toLowerCase().includes(searchQuery.toLowerCase()) || s.description?.toLowerCase().includes(searchQuery.toLowerCase())).length === 0 ? (
              <EmptyState
                message={t('emptyMarket')}
                action={
                  <a
                    href="https://github.com/qomob/xclawskill"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-[11px] rounded-lg transition-colors"
                  >
                    {t('registerAgent')}
                  </a>
                }
              />
            ) : skills.filter(s => !searchQuery || s.name.toLowerCase().includes(searchQuery.toLowerCase()) || s.description?.toLowerCase().includes(searchQuery.toLowerCase())).map(s => (
              <button key={s.id} onClick={() => openDetail(s)}
                className="w-full text-left bg-black/30 rounded border border-l-2 border-l-amber-500 border-amber-800/30 p-2 md:p-2.5 space-y-1 hover:border-amber-700/50 transition-colors">
                <div className="flex justify-between items-start">
                  <h3 className="text-[12px] md:text-xs font-semibold text-white truncate pr-2 flex items-center gap-1.5">
                    <span className="text-amber-400">$</span> {s.name}
                  </h3>
                  <div className="text-right shrink-0">
                    <div className="text-[12px] md:text-xs font-bold text-amber-400">{s.price} XCL</div>
                    {s.avg_rating > 0 && <div className="text-[7px] text-yellow-400">{stars(s.avg_rating)}</div>}
                  </div>
                </div>
                <p className="text-[12px] md:text-[11px] text-gray-400 leading-relaxed line-clamp-1">{s.description}</p>
                <div className="flex items-center gap-2 text-[7px] md:text-[12px] text-gray-400">
                  <span>{s.category}</span>
                  <span>v{s.version}</span>
                  <span>{s.seller_name || 'Unknown'}</span>
                  <span>{s.sales_count} {t('cbSold')}</span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {/* ===== TOP TAB ===== */}
      {activeTab === 'top' && (
        <div className="space-y-2 md:space-y-2.5 min-h-0">
          {topRated.map((s, i) => (
            <button key={s.id} onClick={() => openDetail(s)}
              className="w-full text-left bg-black/30 rounded border border-l-2 border-l-amber-500 border-amber-800/30 p-2 md:p-2.5 space-y-1 hover:border-amber-700/50 transition-colors">
              <div className="flex items-start gap-2">
                <span className={`text-[12px] md:text-xs font-bold w-5 text-center shrink-0 ${i < 3 ? 'text-amber-400' : 'text-gray-400'}`}>#{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-[12px] md:text-xs font-semibold text-white truncate">{s.name}</h3>
                  <p className="text-[12px] md:text-[11px] text-gray-400">{s.category} · {s.seller_name || 'Unknown'}</p>
                </div>
                <div className="text-right shrink-0 ml-1">
                  <div className="text-[12px] md:text-xs font-bold text-amber-400">{s.price} XCL</div>
                  <div className="text-[7px] text-yellow-400">{stars(s.avg_rating)} ({s.review_count})</div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* ===== ORDERS TAB ===== */}
      {activeTab === 'orders' && (
        <>
          {needsAuth ? (
            <div className="space-y-2">
              <div className="bg-black/30 rounded border border-l-2 border-l-amber-500 border-amber-800/30 p-3 space-y-2">
                <h3 className="text-[12px] md:text-xs font-semibold text-white flex items-center gap-1.5"><span className="text-amber-400">🔑</span> {t('cbAuthTitle')}</h3>
                <p className="text-[12px] text-gray-400 leading-relaxed">{t('cbAuthDesc')}</p>
                <div className="space-y-1.5">
                  <input value={apiKey} onChange={e => setApiKey(e.target.value)}
                    placeholder="API Key (ak_xxx...)"
                    type="password"
                    className="w-full bg-slate-900/50 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-white outline-none focus:border-amber-500 placeholder-gray-500" />
                  {loginError && <div className="text-[12px] text-red-400">{loginError}</div>}
                  <button onClick={handleLogin}
                    className="w-full bg-amber-600 hover:bg-amber-700 text-white text-[11px] py-1.5 rounded font-medium transition-colors">{t('cbAuthenticate')}</button>
                </div>
              </div>
              <div className="bg-slate-900/30 rounded border border-cyan-900/20 p-2.5 space-y-1">
                <p className="text-[7px] md:text-[12px] text-cyan-400/70 leading-relaxed">
                  <span className="text-cyan-400">ℹ</span> {t('cbGetKeyHint')} <code className="bg-slate-800 px-1 rounded text-cyan-300">xclaw-skill login</code>
                </p>
              </div>
            </div>
          ) : (
            <>
              <select value={orderStatus} onChange={e => setOrderStatus(e.target.value)}
                className="w-full bg-black/30 border border-gray-700 rounded px-2 py-1.5 text-[11px] md:text-[12px] text-white outline-none focus:border-amber-500">
                <option value="">{t('cbAllStatus')}</option>
                <option value="pending">{t('cbStatusPending')}</option>
                <option value="processing">{t('cbStatusProcessing')}</option>
                <option value="completed">{t('cbStatusCompleted')}</option>
                <option value="failed">{t('cbStatusFailed')}</option>
              </select>
              <div className="space-y-2 md:space-y-2.5 min-h-0">
                {selectedOrder ? (
                  <div className="bg-black/30 rounded border border-l-2 border-l-cyan-500 border-cyan-800/30 p-2.5 md:p-3 space-y-2">
                    <button onClick={() => setSelectedOrder(null)} className="text-[11px] md:text-[12px] text-cyan-400 hover:underline flex items-center gap-1">&larr; {t('cbBackToOrders')}</button>
                    <h3 className="text-[11px] md:text-sm font-bold text-white flex items-center gap-1.5">
                      <span className="text-cyan-400">&#9776;</span> {t('cbOrderDetail')}
                    </h3>
                    <div className="grid grid-cols-2 gap-1.5">
                      {[
                        [t('cbOrderId'), selectedOrder.order_id?.slice(0, 12) + '…', 'text-cyan-300'],
                        [t('cbSkill'), selectedOrder.skill_name, 'text-white'],
                        [t('cbAmount'), `${selectedOrder.amount} XCL`, 'text-amber-400 font-bold'],
                        [t('cbCommission'), `${selectedOrder.commission} XCL`, 'text-gray-300'],
                        [t('cbStatus'), selectedOrder.status, selectedOrder.status === 'completed' ? 'text-green-400' : selectedOrder.status === 'processing' ? 'text-yellow-400' : selectedOrder.status === 'failed' ? 'text-red-400' : 'text-gray-400'],
                        [t('cbCreated'), new Date(selectedOrder.created_at).toLocaleString(), 'text-gray-300'],
                        [t('cbSeller'), selectedOrder.seller_name || 'Unknown', 'text-white'],
                        [t('cbSkillId'), selectedOrder.skill_id?.slice(0, 12) + '…', 'text-gray-400'],
                      ].map(([k, v, c]) => (
                        <div key={k as string} className="bg-slate-900/50 rounded p-1.5 space-y-0.5">
                          <div className="text-[7px] text-gray-400">{k}</div>
                          <div className={`text-[11px] md:text-[12px] ${c} truncate`}>{v}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : orders.length === 0 ? (
                  <div className="border border-gray-800/40 bg-black/30 rounded p-4 text-center text-[11px] text-gray-400">{t('cbNoOrders')}</div>
                ) : orders.map(o => (
                  <div key={o.order_id} onClick={() => handleSelectOrder(o.order_id)}
                    className={`bg-black/30 rounded border border-l-2 ${statusColor(o.status)} p-2 md:p-2.5 space-y-1 cursor-pointer hover:border-amber-700/50 transition-colors`}>
                    <div className="flex justify-between items-start">
                      <h3 className="text-[12px] md:text-xs font-semibold text-white truncate max-w-[140px]">{o.skill_name}</h3>
                      <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${
                        o.status === 'completed' ? 'bg-green-900/30 text-green-400' :
                        o.status === 'processing' ? 'bg-yellow-900/30 text-yellow-400' :
                        o.status === 'failed' ? 'bg-red-900/30 text-red-400' :
                        'bg-gray-800 text-gray-400'
                      }`}>{statusLabel(o.status)}</span>
                    </div>
                    <div className="flex justify-between text-[12px] md:text-[11px] text-gray-400">
                      <span>{o.amount} XCL</span>
                      <span>{new Date(o.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* ===== PUBLISH TAB ===== */}
      {activeTab === 'publish' && (
        <div className="space-y-3">
          {needsAuth ? (
            <div className="bg-black/30 rounded border border-l-2 border-l-amber-500 border-amber-800/30 p-4 text-center space-y-2">
              <p className="text-[12px] text-gray-400">{t('cbNeedLogin')}</p>
              <button
                onClick={() => setActiveTab('orders')}
                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-[11px] rounded-lg transition-colors"
              >
                {t('cbGoToAuth')}
              </button>
            </div>
          ) : (
            <>
              <div className="bg-black/30 rounded border border-l-2 border-l-amber-500 border-amber-800/30 p-3 space-y-2">
                <h3 className="text-[12px] font-semibold text-white flex items-center gap-1.5">
                  <span className="text-amber-400">🚀</span> {t('cbPublishTitle')}
                </h3>
                <input
                  type="text"
                  value={pubForm.name}
                  onChange={e => setPubForm(f => ({ ...f, name: e.target.value }))}
                  placeholder={t('cbSkillName')}
                  className="w-full bg-slate-900/50 border border-gray-700 rounded px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-amber-500 placeholder-gray-500"
                />
                <textarea
                  value={pubForm.description}
                  onChange={e => setPubForm(f => ({ ...f, description: e.target.value }))}
                  placeholder={t('tcDescPlaceholder')}
                  rows={3}
                  className="w-full bg-slate-900/50 border border-gray-700 rounded px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-amber-500 placeholder-gray-500 resize-none"
                />
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <input
                    type="text"
                    value={pubForm.category}
                    onChange={e => setPubForm(f => ({ ...f, category: e.target.value }))}
                    placeholder={t('cbCategoryLabel')}
                    className="w-full bg-slate-900/50 border border-gray-700 rounded px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-amber-500 placeholder-gray-500"
                  />
                  <input
                    type="text"
                    value={pubForm.version}
                    onChange={e => setPubForm(f => ({ ...f, version: e.target.value }))}
                    placeholder={t('cbVersion')}
                    className="w-full bg-slate-900/50 border border-gray-700 rounded px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-amber-500 placeholder-gray-500"
                  />
                  <input
                    type="number"
                    value={pubForm.price}
                    onChange={e => setPubForm(f => ({ ...f, price: e.target.value }))}
                    placeholder={t('cbPriceLabel')}
                    min="0"
                    step="0.01"
                    className="w-full bg-slate-900/50 border border-gray-700 rounded px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-amber-500 placeholder-gray-500"
                  />
                </div>
                <p className="text-[10px] text-gray-500">{t('cbPriceHint')}</p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={handlePublish}
                    disabled={pubBusy || !pubForm.name.trim() || !pubForm.price}
                    className="bg-amber-600 hover:bg-amber-700 disabled:opacity-40 text-white text-[11px] px-3 py-1.5 rounded-lg font-medium transition-colors"
                  >
                    {pubBusy ? '...' : t('cbPublishBtn')}
                  </button>
                  {pubStatus === 'success' && <span className="text-[11px] text-green-400">{t('cbPublishOk')}</span>}
                  {pubStatus === 'error' && <span className="text-[11px] text-red-400">{t('cbPublishFail')}</span>}
                </div>
              </div>

              <div className="bg-black/30 rounded border border-gray-800/40 p-3 space-y-1.5">
                <h3 className="text-[12px] font-semibold text-white">{t('cbMySkills')} ({mySkills.length})</h3>
                {mySkills.length === 0 ? (
                  <p className="text-[11px] text-gray-500 text-center py-3">{t('cbNoListings')}</p>
                ) : (
                  mySkills.map(s => (
                    <div key={s.id} className="flex items-center justify-between bg-slate-900/50 rounded px-2.5 py-2">
                      <div className="min-w-0">
                        <div className="text-[12px] font-medium text-white truncate">{s.name}</div>
                        <div className="text-[10px] text-gray-500">
                          {s.category} · v{s.version} · {Number(s.price) > 0 ? `${Number(s.price)} XCL` : '—'} · {s.sales_count ?? 0} {t('cbSalesCount')}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${s.is_listed ? 'bg-green-500/20 text-green-400' : 'bg-slate-600/30 text-gray-400'}`}>
                          {s.is_listed ? t('cbPubListed') : t('cbPubUnlisted')}
                        </span>
                        {s.is_listed && (
                          <button
                            onClick={() => handleDelist(s.id)}
                            className="text-[10px] text-red-400 hover:text-red-300 transition-colors"
                          >
                            {t('cbPubDelist')}
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ===== DETAIL VIEW ===== */}
      {activeTab === 'detail' && selectedSkill && (
        <div className="space-y-2 md:space-y-3 min-h-0">
          <button onClick={() => setActiveTab('market')} className="text-[11px] md:text-[12px] text-cyan-400 hover:underline flex items-center gap-1">&larr; {t('cbBackToMarket')}</button>

          <div className="bg-black/30 rounded border border-l-2 border-l-amber-500 border-amber-800/30 p-2.5 md:p-3 space-y-2">
            <h3 className="text-[11px] md:text-sm font-bold text-white flex items-center gap-1.5">
              <span className="text-amber-400">$</span> {selectedSkill.name}
            </h3>
            <p className="text-[12px] md:text-[11px] text-gray-400 leading-relaxed">{selectedSkill.description}</p>
            <div className="grid grid-cols-2 gap-1.5">
              {[['Category', selectedSkill.category, 'text-cyan-300'], ['Version', selectedSkill.version, 'text-white'], ['Price', `${selectedSkill.price} XCL`, 'text-amber-400 font-bold'], ['Sales', selectedSkill.sales_count, 'text-green-400'], ['Rating', selectedSkill.avg_rating > 0 ? `${selectedSkill.avg_rating.toFixed(1)} / 5` : 'N/A', 'text-yellow-400'], ['Seller', `${selectedSkill.seller_name || 'Unknown'}${selectedSkill.seller_reputation ? ` (${(selectedSkill.seller_reputation * 100).toFixed(0)}%)` : ''}`, 'text-white']].map(([k, v, c]) => (
                <div key={k} className="bg-slate-900/50 rounded p-1.5 space-y-0.5">
                  <div className="text-[7px] text-gray-400">{k}</div>
                  <div className={`text-[11px] md:text-[12px] ${c} truncate`}>{v}</div>
                </div>
              ))}
            </div>
          </div>

          {needsAuth ? (
            <div className="bg-black/30 rounded border border-l-2 border-l-amber-500 border-amber-800/30 p-3 space-y-1.5">
              <p className="text-[12px] text-gray-400 text-center">{t('cbAuthToBuy')}</p>
              <button onClick={() => setActiveTab('orders')} className="w-full bg-amber-600 hover:bg-amber-700 text-white text-[11px] py-1.5 rounded font-medium transition-colors">{t('cbGoToAuth')}</button>
            </div>
          ) : (
            <div className="space-y-2">
              <button onClick={handleBuy} disabled={orderLoading}
                className={`w-full py-2 rounded text-[12px] md:text-[11px] font-bold transition-colors ${
                  orderLoading ? 'bg-gray-700 text-gray-400 cursor-wait' : 'bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white'
                }`}>
                {orderLoading ? 'Processing...' : `${t('cbBuyNow')} · ${selectedSkill.price} XCL`}
              </button>
              <button onClick={handleRunTask} disabled={taskRunning}
                className={`w-full py-2 rounded text-[12px] md:text-[11px] font-bold transition-colors ${
                  taskRunning ? 'bg-gray-700 text-gray-400 cursor-wait' : 'bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white'
                }`}>
                {taskRunning ? t('cbRunningTask') : `⚡ ${t('cbRunSkill')}`}
              </button>
              {taskStatus && (
                <div className={`bg-black/30 rounded border border-l-2 p-2.5 space-y-1.5 ${
                  taskStatus.status === 'completed' ? 'border-l-green-500 border-green-800/30' :
                  taskStatus.status === 'failed' ? 'border-l-red-500 border-red-800/30' :
                  'border-l-cyan-500 border-cyan-800/30'
                }`}>
                  <div className="flex justify-between items-center">
                    <h4 className="text-[11px] md:text-[12px] font-semibold text-white">{t('cbTaskStatus')}</h4>
                    <span className={`text-[12px] md:text-[11px] font-medium px-1.5 py-0.5 rounded ${
                      taskStatus.status === 'completed' ? 'bg-green-900/30 text-green-400' :
                      taskStatus.status === 'failed' ? 'bg-red-900/30 text-red-400' :
                      taskStatus.status === 'running' ? 'bg-cyan-900/30 text-cyan-400' :
                      'bg-yellow-900/30 text-yellow-400'
                    }`}>{taskStatus.status?.toUpperCase()}</span>
                  </div>
                  {taskStatus.task_id && (
                    <div className="text-[12px] text-gray-400">
                      Task ID: <span className="text-cyan-400/70 font-mono">{taskStatus.task_id}</span>
                    </div>
                  )}
                  {taskStatus.error && (
                    <div className="text-[12px] text-red-400 bg-red-900/20 rounded px-1.5 py-1">{taskStatus.error}</div>
                  )}
                  {taskStatus.result && (
                    <div className="text-[12px] text-green-300 bg-green-900/20 rounded px-1.5 py-1 font-mono whitespace-pre-wrap max-h-24 overflow-y-auto">
                      {String(typeof taskStatus.result === 'string' ? taskStatus.result : JSON.stringify(taskStatus.result, null, 2))}
                    </div>
                  )}
                  {(taskStatus.status === 'pending' || taskStatus.status === 'running') && (
                    <div className="text-[7px] text-gray-400 animate-pulse">{t('cbPolling')}</div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="space-y-1.5 pt-1 border-t border-slate-800">
            <h3 className="text-[12px] md:text-xs font-semibold text-white flex items-center gap-1.5"><span className="text-yellow-400">★</span> {t('cbReviews')} ({reviews.length})</h3>
            {reviews.length === 0 ? (
              <div className="border border-gray-800/40 bg-black/30 rounded p-3 text-center text-[12px] text-gray-400">{t('cbNoReviews')}</div>
            ) : reviews.map(r => (
              <div key={r.review_id} className="bg-black/30 rounded border border-gray-800/30 p-2 space-y-0.5">
                <div className="flex justify-between items-center">
                  <span className="text-[11px] md:text-[12px] text-yellow-400 font-medium">{stars(r.rating)}</span>
                  <span className="text-[7px] text-gray-400">{r.reviewer_name?.slice(0, 8) || 'Anonymous'}</span>
                </div>
                {r.comment && <p className="text-[12px] text-gray-300 leading-relaxed">{r.comment}</p>}
              </div>
            ))}
          </div>

          <div className="space-y-1.5 pt-1 border-t border-slate-800">
            <h3 className="text-[12px] md:text-xs font-semibold text-white flex items-center gap-1.5"><span className="text-purple-400">✎</span> {t('cbWriteReview')}</h3>
            <div className="bg-black/30 rounded border border-purple-800/30 p-2.5 space-y-1.5">
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map(n => (
                  <button key={n} onClick={() => setReviewRating(n)}
                    className={`text-base transition-transform ${n <= reviewRating ? 'text-yellow-400 scale-110' : 'text-gray-400 hover:text-gray-400'}`}>&#9733;</button>
                ))}
                <span className="text-[12px] text-gray-400 self-end ml-1">{reviewRating}/5</span>
              </div>
              <textarea value={reviewComment} onChange={e => setReviewComment(e.target.value)}
                placeholder={t('cbReviewPlaceholder')}
                className="w-full bg-slate-900/50 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-white outline-none focus:border-purple-500 resize-none placeholder-gray-500"
                rows={2} />
              <button onClick={handleReview}
                className="w-full bg-purple-600 hover:bg-purple-700 text-white text-[11px] py-1.5 rounded font-medium transition-colors">{t('cbSubmitReview')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
