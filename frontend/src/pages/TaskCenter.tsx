import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchTasks, createTask, browseTaskMarket, fetchTaskMarketStats,
  createMarketTask, submitBid, fetchTaskBids, acceptBid, withdrawBid,
  submitMarketResult, acceptMarketResult, rejectMarketResult,
  cancelMarketTask, fetchMarketTask, getAgentIdFromToken,
} from '../utils/api';
import { useI18n } from '../i18n/LanguageContext';

type Tab = 'my-tasks' | 'market' | 'create';

interface TaskItem {
  id: string;
  type: string;
  status: string;
  payload?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface MarketTaskItem {
  id: string;
  title: string;
  description?: string;
  category?: string;
  budget_min?: number;
  budget_max?: number;
  status: string;
  created_at: string;
  bid_count?: number;
  caller_name?: string;
  worker_name?: string;
  assignment_strategy?: string;
}

interface TaskDetail extends MarketTaskItem {
  caller_id?: string;
  node_id?: string;
  deadline?: string;
  priority?: string;
  required_capabilities?: string[];
  tags?: string[];
  result?: unknown;
  verification_status?: string;
  updated_at?: string;
}

interface Bid {
  id: string;
  bidder_id: string;
  bidder_name?: string;
  reputation_score?: number;
  proposed_price: number;
  estimated_duration?: string;
  proposal?: string;
  match_score?: number;
  status: string;
  created_at: string;
}

const card = 'bg-slate-900 border border-slate-800 rounded-xl';
const textSecondary = 'text-slate-400';

export default function TaskCenter() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('my-tasks');
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [marketTasks, setMarketTasks] = useState<MarketTaskItem[]>([]);
  const [marketStats, setMarketStats] = useState<{ open_tasks: number; total_bids: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [taskStatusFilter, setTaskStatusFilter] = useState('');

  const [createForm, setCreateForm] = useState({ title: '', description: '', type: 'general', target_agent_id: '', priority: 'normal' });
  const [createStatus, setCreateStatus] = useState('');

  const [marketForm, setMarketForm] = useState({
    title: '',
    description: '',
    category: 'general',
    budget_min: '',
    budget_max: '',
    deadline: '',
    capabilities: '',
    strategy: 'auto',
  });
  const [marketStatus, setMarketStatus] = useState('');

  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  const [bidPrice, setBidPrice] = useState('');
  const [bidDuration, setBidDuration] = useState('');
  const [bidProposal, setBidProposal] = useState('');
  const [bidStatus, setBidStatus] = useState('');

  const [resultText, setResultText] = useState('');
  const [rejectReason, setRejectReason] = useState('');

  const myAgentId = getAgentIdFromToken();

  const statusLabel = (s: string) =>
    ({
      open: t('tcStatusOpen'),
      assigned: t('tcStatusAssigned'),
      submitted: t('tcStatusSubmitted'),
      completed: t('tcStatusCompleted'),
      disputed: t('tcStatusDisputed'),
      pending: t('tcStatusPending'),
      cancelled: t('tcStatusCancelled'),
      running: t('tcStatusRunning'),
    }[s] || s);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { limit: '30' };
      if (taskStatusFilter) params.status = taskStatusFilter;
      const res = await fetchTasks(params);
      if (res.success) setTasks(res.data || []);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [taskStatusFilter]);

  const loadMarket = useCallback(async () => {
    setLoading(true);
    try {
      const [tasksRes, statsRes] = await Promise.allSettled([
        browseTaskMarket({ limit: 30 }),
        fetchTaskMarketStats(),
      ]);
      if (tasksRes.status === 'fulfilled' && tasksRes.value.success) {
        setMarketTasks(tasksRes.value.data || []);
      }
      if (statsRes.status === 'fulfilled' && statsRes.value.success) {
        setMarketStats(statsRes.value.data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const openDetail = useCallback(async (taskId: string) => {
    setDetailLoading(true);
    setDetailError('');
    setActionMsg('');
    setResultText('');
    setRejectReason('');
    try {
      const [taskRes, bidsRes] = await Promise.allSettled([
        fetchMarketTask(taskId),
        fetchTaskBids(taskId),
      ]);
      if (taskRes.status === 'fulfilled' && taskRes.value.success) {
        setDetail(taskRes.value.data);
      } else {
        setDetailError(t('tcErrNotFound'));
      }
      if (bidsRes.status === 'fulfilled' && bidsRes.value.success) {
        setBids(bidsRes.value.data || []);
      } else {
        setBids([]);
      }
    } catch {
      setDetailError(t('tcErrLoadDetail'));
    } finally {
      setDetailLoading(false);
    }
  }, [t]);

  const reloadDetail = useCallback(async () => {
    if (!detail) return;
    await openDetail(detail.id);
    loadMarket();
    loadTasks();
  }, [detail, openDetail, loadMarket, loadTasks]);

  const handleCreate = async () => {
    setCreateStatus('');
    try {
      const res = await createTask({
        title: createForm.title,
        description: createForm.description,
        target_agent_id: createForm.target_agent_id || undefined,
        priority: createForm.priority,
      });
      if (res.success) {
        setCreateStatus('success');
        setCreateForm({ title: '', description: '', type: 'general', target_agent_id: '', priority: 'normal' });
        loadTasks();
      } else {
        setCreateStatus('error');
      }
    } catch {
      setCreateStatus('error');
    }
  };

  const handleCreateMarket = async () => {
    setMarketStatus('');
    const min = parseFloat(marketForm.budget_min);
    const max = parseFloat(marketForm.budget_max);
    if (!marketForm.title.trim() || !min || !max || min > max) {
      setMarketStatus('error');
      return;
    }
    try {
      const res = await createMarketTask({
        title: marketForm.title.trim(),
        description: marketForm.description.trim(),
        category: marketForm.category,
        budget_min: min,
        budget_max: max,
        deadline: marketForm.deadline || undefined,
        required_capabilities: marketForm.capabilities.split(',').map(s => s.trim()).filter(Boolean),
        assignment_strategy: marketForm.strategy,
      });
      if (res.success) {
        setMarketStatus('success');
        setMarketForm({ title: '', description: '', category: 'general', budget_min: '', budget_max: '', deadline: '', capabilities: '', strategy: 'auto' });
        loadMarket();
      } else {
        setMarketStatus('error');
      }
    } catch {
      setMarketStatus('error');
    }
  };

  const handleBid = async () => {
    if (!detail) return;
    setBidStatus('');
    const price = parseFloat(bidPrice);
    if (!price || price <= 0) {
      setBidStatus('error');
      return;
    }
    try {
      const res = await submitBid(detail.id, {
        proposed_price: price,
        estimated_time: bidDuration || undefined,
        cover_letter: bidProposal || undefined,
      });
      if (res.success) {
        setBidStatus('success');
        setBidPrice('');
        setBidDuration('');
        setBidProposal('');
        reloadDetail();
      } else {
        setBidStatus('error');
      }
    } catch {
      setBidStatus('error');
    }
  };

  const handleAcceptBid = async (bidId: string) => {
    if (!detail) return;
    try {
      const res = await acceptBid(detail.id, bidId);
      setActionMsg(res.success ? t('tcMsgBidAccepted') : (res.message || t('tcMsgBidAccepted')));
      reloadDetail();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : t('tcMsgBidAccepted'));
    }
  };

  const handleWithdrawBid = async (bidId: string) => {
    if (!detail) return;
    try {
      const res = await withdrawBid(detail.id, bidId);
      setActionMsg(res.success ? t('tcMsgBidWithdrawn') : (res.message || t('tcMsgBidWithdrawn')));
      reloadDetail();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : t('tcMsgBidWithdrawn'));
    }
  };

  const handleCancel = async () => {
    if (!detail) return;
    try {
      const res = await cancelMarketTask(detail.id);
      setActionMsg(res.success ? t('tcMsgCancelled') : (res.message || t('tcMsgCancelled')));
      reloadDetail();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : t('tcMsgCancelled'));
    }
  };

  const handleSubmitResult = async () => {
    if (!detail) return;
    try {
      const res = await submitMarketResult(detail.id, { summary: resultText });
      setActionMsg(res.success ? t('tcMsgResultSubmitted') : (res.message || t('tcMsgResultSubmitted')));
      reloadDetail();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : t('tcMsgResultSubmitted'));
    }
  };

  const handleAcceptResult = async () => {
    if (!detail) return;
    try {
      const res = await acceptMarketResult(detail.id);
      setActionMsg(res.success ? t('tcMsgResultAccepted') : (res.message || t('tcMsgResultAccepted')));
      reloadDetail();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : t('tcMsgResultAccepted'));
    }
  };

  const handleRejectResult = async () => {
    if (!detail) return;
    try {
      const res = await rejectMarketResult(detail.id, rejectReason || undefined);
      setActionMsg(res.success ? t('tcMsgResultRejected') : (res.message || t('tcMsgResultRejected')));
      reloadDetail();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : t('tcMsgResultRejected'));
    }
  };

  useEffect(() => {
    if (tab === 'my-tasks') loadTasks();
    else if (tab === 'market') loadMarket();
  }, [tab, loadTasks, loadMarket]);

  const statusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'text-green-400';
      case 'running': return 'text-blue-400';
      case 'failed': return 'text-red-400';
      case 'pending': return 'text-yellow-400';
      case 'open': return 'text-brand-400';
      case 'assigned': return 'text-purple-400';
      case 'submitted': return 'text-cyan-400';
      case 'disputed': return 'text-red-400';
      default: return textSecondary;
    }
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'my-tasks', label: t('tcMyTasks') },
    { key: 'market', label: t('tcMarket') },
    { key: 'create', label: t('tcCreate') },
  ];

  if (detail) {
    return (
      <TaskDetailView
        task={detail}
        bids={bids}
        loading={detailLoading}
        error={detailError}
        actionMsg={actionMsg}
        myAgentId={myAgentId}
        statusLabel={statusLabel}
        bidPrice={bidPrice}
        setBidPrice={setBidPrice}
        bidDuration={bidDuration}
        setBidDuration={setBidDuration}
        bidProposal={bidProposal}
        setBidProposal={setBidProposal}
        bidStatus={bidStatus}
        resultText={resultText}
        setResultText={setResultText}
        rejectReason={rejectReason}
        setRejectReason={setRejectReason}
        onBack={() => setDetail(null)}
        onBid={handleBid}
        onAcceptBid={handleAcceptBid}
        onWithdrawBid={handleWithdrawBid}
        onCancel={handleCancel}
        onSubmitResult={handleSubmitResult}
        onAcceptResult={handleAcceptResult}
        onRejectResult={handleRejectResult}
      />
    );
  }

  return (
    <div className="h-full flex flex-col p-4 gap-4 overflow-y-auto">
      <div>
        <h1 className="text-lg font-bold text-white">
          📋 {t('pageTasks')}
        </h1>
        <p className="text-xs mt-0.5 text-slate-400">
          {t('pageTasksDesc')}
        </p>
      </div>

      <div className="flex gap-1 shrink-0">
        {tabs.map(tabItem => (
          <button
            key={tabItem.key}
            onClick={() => setTab(tabItem.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              tab === tabItem.key
                ? 'bg-brand-500 text-white'
                : 'text-slate-400 hover:text-white bg-slate-800'
            }`}
          >
            {tabItem.label}
          </button>
        ))}
      </div>

      {tab === 'my-tasks' && (
        <>
          <div className="flex gap-2 shrink-0 flex-wrap">
            {['', 'pending', 'open', 'assigned', 'submitted', 'completed', 'disputed'].map(s => (
              <button
                key={s}
                onClick={() => setTaskStatusFilter(s)}
                className={`px-2 py-1 text-[10px] rounded ${
                  taskStatusFilter === s
                    ? 'bg-brand-500 text-white'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {s ? statusLabel(s) : t('tcAll')}
              </button>
            ))}
          </div>
          {loading ? (
            <div className="text-center py-12 text-slate-400">{t('tcLoading')}</div>
          ) : tasks.length === 0 ? (
            <div className={`${card} p-8 text-center text-xs text-slate-400`}>{t('tcNoTasks')}</div>
          ) : (
            <div className="space-y-2">
              {tasks.map(task => (
                <div key={task.id} className={`${card} p-3`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-medium text-white">
                        {task.type}
                      </span>
                      <span className="ml-2 text-[10px] font-mono text-slate-400">
                        {task.id.slice(0, 8)}...
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-medium ${statusColor(task.status)}`}>
                        {statusLabel(task.status)}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {new Date(task.created_at).toLocaleDateString('zh-CN')}
                      </span>
                      <button
                        onClick={() => openDetail(task.id)}
                        className="text-[10px] px-2 py-1 rounded bg-slate-800 text-brand-400 hover:bg-slate-700 transition-colors"
                      >
                        {t('details')}
                      </button>
                    </div>
                  </div>
                  {task.payload && (
                    <p className="text-[10px] mt-1 text-slate-400 truncate">
                      {JSON.stringify(task.payload).slice(0, 100)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'market' && (
        <>
          {marketStats && (
            <div className="grid grid-cols-2 gap-3 shrink-0">
              <div className={`${card} p-3 text-center`}>
                <div className="text-lg font-bold text-brand-400">{marketStats.open_tasks}</div>
                <div className="text-[10px] text-slate-400">{t('tcOpenTasks')}</div>
              </div>
              <div className={`${card} p-3 text-center`}>
                <div className="text-lg font-bold text-purple-400">{marketStats.total_bids}</div>
                <div className="text-[10px] text-slate-400">{t('tcTotalBids')}</div>
              </div>
            </div>
          )}
          {loading ? (
            <div className="text-center py-12 text-slate-400">{t('tcLoading')}</div>
          ) : marketTasks.length === 0 ? (
            <div className={`${card} p-8 text-center text-xs text-slate-400`}>{t('tcNoMarketTasks')}</div>
          ) : (
            <div className="space-y-2">
              {marketTasks.map(task => (
                <div key={task.id} className={`${card} p-3`}>
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-medium text-white">
                      {task.title}
                    </h3>
                    <span className={`text-[10px] ${statusColor(task.status)}`}>{statusLabel(task.status)}</span>
                  </div>
                  {task.description && (
                    <p className="text-[10px] mt-1 text-slate-400 line-clamp-2">{task.description}</p>
                  )}
                  <div className="flex items-center gap-3 mt-1">
                    {task.budget_min !== undefined && (
                      <span className="text-[10px] text-brand-400">
                        💰 {task.budget_min}-{task.budget_max} XCL
                      </span>
                    )}
                    {task.bid_count !== undefined && (
                      <span className="text-[10px] text-slate-400">
                        {task.bid_count} {t('tcBids').toLowerCase()}
                      </span>
                    )}
                    {task.caller_name && (
                      <span className="text-[10px] text-slate-500">{t('tcCaller')}: {task.caller_name}</span>
                    )}
                    {task.assignment_strategy && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-400">
                        {task.assignment_strategy}
                      </span>
                    )}
                  </div>
                  <div className="mt-2">
                    <button
                      onClick={() => openDetail(task.id)}
                      className="px-3 py-1.5 bg-brand-500/20 hover:bg-brand-500/30 border border-brand-500/30 text-brand-400 text-xs rounded-lg transition-colors"
                    >
                      {t('tcViewBid')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'create' && (
        <div className="space-y-6 max-w-2xl">
          <div className={`${card} p-4`}>
            <h3 className="text-sm font-semibold mb-3 text-white">{t('tcCreatePrivate')}</h3>
            <div className="space-y-3">
              <input
                type="text"
                value={createForm.title}
                onChange={e => setCreateForm(f => ({ ...f, title: e.target.value }))}
                placeholder={t('tcTitlePlaceholder')}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
              />
              <textarea
                value={createForm.description}
                onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))}
                placeholder={t('tcDescPlaceholder')}
                rows={3}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
              />
              <input
                type="text"
                value={createForm.target_agent_id}
                onChange={e => setCreateForm(f => ({ ...f, target_agent_id: e.target.value }))}
                placeholder={t('tcTargetAgent')}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
              />
              <select
                value={createForm.priority}
                onChange={e => setCreateForm(f => ({ ...f, priority: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleCreate}
                  disabled={!createForm.title}
                  className="px-4 py-2 bg-brand-500 text-white text-sm rounded-lg hover:bg-brand-600 disabled:opacity-40 transition-colors"
                >
                  {t('tcCreateBtn')}
                </button>
                {createStatus === 'success' && <span className="text-xs text-green-400">{t('tcCreatedOk')}</span>}
                {createStatus === 'error' && <span className="text-xs text-red-400">{t('tcCreatedFail')}</span>}
              </div>
            </div>
          </div>

          <div className={`${card} p-4`}>
            <h3 className="text-sm font-semibold mb-1 text-white">{t('tcCreateMarket')}</h3>
            <p className="text-xs text-slate-400 mb-3">{t('tcMarketHint')}</p>
            <div className="space-y-3">
              <input
                type="text"
                value={marketForm.title}
                onChange={e => setMarketForm(f => ({ ...f, title: e.target.value }))}
                placeholder={t('tcTitlePlaceholder')}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
              />
              <textarea
                value={marketForm.description}
                onChange={e => setMarketForm(f => ({ ...f, description: e.target.value }))}
                placeholder={t('tcDescPlaceholder')}
                rows={3}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
              />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <select
                  value={marketForm.category}
                  onChange={e => setMarketForm(f => ({ ...f, category: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white"
                >
                  {['general', 'development', 'research', 'writing', 'analysis', 'design', 'data'].map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <select
                  value={marketForm.strategy}
                  onChange={e => setMarketForm(f => ({ ...f, strategy: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white"
                >
                  <option value="auto">Auto assign</option>
                  <option value="bid">Bid (agents compete)</option>
                  <option value="manual">Manual review</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="number"
                  value={marketForm.budget_min}
                  onChange={e => setMarketForm(f => ({ ...f, budget_min: e.target.value }))}
                  placeholder={t('tcBudgetMin')}
                  min="0"
                  step="0.01"
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
                />
                <input
                  type="number"
                  value={marketForm.budget_max}
                  onChange={e => setMarketForm(f => ({ ...f, budget_max: e.target.value }))}
                  placeholder={t('tcBudgetMax')}
                  min="0"
                  step="0.01"
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
                />
              </div>
              <input
                type="text"
                value={marketForm.capabilities}
                onChange={e => setMarketForm(f => ({ ...f, capabilities: e.target.value }))}
                placeholder={t('tcCapabilitiesPlaceholder')}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
              />
              <input
                type="datetime-local"
                value={marketForm.deadline}
                onChange={e => setMarketForm(f => ({ ...f, deadline: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white"
              />
              <div className="flex items-center gap-3">
                <button
                  onClick={handleCreateMarket}
                  disabled={!marketForm.title}
                  className="px-4 py-2 bg-purple-500 hover:bg-purple-600 text-white text-sm rounded-lg disabled:opacity-40 transition-colors"
                >
                  {t('tcPublishBtn')}
                </button>
                {marketStatus === 'success' && <span className="text-xs text-green-400">{t('tcPublishedOk')}</span>}
                {marketStatus === 'error' && <span className="text-xs text-red-400">{t('tcPublishedFail')}</span>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 任务详情视图 ─────────────────────────────────────────────────────────

function TaskDetailView({
  task, bids, loading, error, actionMsg, myAgentId, statusLabel,
  bidPrice, setBidPrice, bidDuration, setBidDuration, bidProposal, setBidProposal, bidStatus,
  resultText, setResultText, rejectReason, setRejectReason,
  onBack, onBid, onAcceptBid, onWithdrawBid, onCancel, onSubmitResult, onAcceptResult, onRejectResult,
}: {
  task: TaskDetail;
  bids: Bid[];
  loading: boolean;
  error: string;
  actionMsg: string;
  myAgentId: string | null;
  statusLabel: (s: string) => string;
  bidPrice: string;
  setBidPrice: (v: string) => void;
  bidDuration: string;
  setBidDuration: (v: string) => void;
  bidProposal: string;
  setBidProposal: (v: string) => void;
  bidStatus: string;
  resultText: string;
  setResultText: (v: string) => void;
  rejectReason: string;
  setRejectReason: (v: string) => void;
  onBack: () => void;
  onBid: () => void;
  onAcceptBid: (bidId: string) => void;
  onWithdrawBid: (bidId: string) => void;
  onCancel: () => void;
  onSubmitResult: () => void;
  onAcceptResult: () => void;
  onRejectResult: () => void;
}) {
  const { t } = useI18n();
  const isCaller = !!myAgentId && task.caller_id === myAgentId;
  const isWorker = !!myAgentId && task.node_id === myAgentId;
  const status = task.status || 'pending';
  const open = status === 'pending' || status === 'open';
  const submitted = status === 'submitted';
  const assigned = status === 'assigned' || status === 'running';

  return (
    <div className="h-full flex flex-col p-4 gap-4 overflow-y-auto">
      <button onClick={onBack} className="text-xs text-brand-400 hover:text-brand-300 self-start">
        ← {t('tcBackToDetail').replace('← ', '')}
      </button>

      <div className={`${card} p-4`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-white">{task.title || task.id}</h2>
            <p className="text-xs text-slate-400 mt-0.5">{task.description || '—'}</p>
          </div>
          <span className="text-[10px] px-2 py-1 rounded bg-slate-800 font-medium text-slate-300 shrink-0">
            {statusLabel(status)}
          </span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4">
          <InfoCell label={t('tcBudget')} value={task.budget_min != null ? `${task.budget_min}-${task.budget_max} XCL` : '—'} />
          <InfoCell label={t('tcStrategy')} value={task.assignment_strategy || '—'} />
          <InfoCell label={t('tcCaller')} value={task.caller_name || (task.caller_id || '—').slice(0, 12)} />
          <InfoCell label={t('tcWorker')} value={task.worker_name || (task.node_id ? task.node_id.slice(0, 12) : '—')} />
          {task.category && <InfoCell label={t('tcCategory')} value={task.category} />}
          {task.priority && <InfoCell label={t('tcPriority')} value={task.priority} />}
          {task.deadline && <InfoCell label={t('tcDeadline')} value={new Date(task.deadline).toLocaleDateString('zh-CN')} />}
          {task.verification_status && <InfoCell label={t('tcVerification')} value={task.verification_status} />}
        </div>

        {task.required_capabilities && task.required_capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-3">
            {task.required_capabilities.map((c, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-400">{c}</span>
            ))}
          </div>
        )}

        {task.result !== undefined && task.result !== null && (
          <div className="mt-3 bg-slate-800 rounded-lg p-3">
            <div className="text-[10px] text-slate-500 mb-1">{t('tcResult')}</div>
            <pre className="text-xs text-green-300 whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">
              {typeof task.result === 'string' ? task.result : JSON.stringify(task.result, null, 2)}
            </pre>
          </div>
        )}

        {actionMsg && (
          <div className="mt-3 text-xs text-brand-400 bg-brand-500/10 border border-brand-500/20 rounded-lg px-3 py-2">
            {actionMsg}
          </div>
        )}
        {error && (
          <div className="mt-3 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
      </div>

      {!loading && !error && (
        <div className="space-y-3">
          {isCaller && open && (
            <div className="flex gap-2">
              <button
                onClick={onCancel}
                className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-400 text-xs rounded-lg transition-colors"
              >
                {t('tcCancelTask')}
              </button>
            </div>
          )}

          {isWorker && assigned && (
            <div className={`${card} p-4`}>
              <h3 className="text-sm font-semibold text-white mb-2">{t('tcSubmitResult')}</h3>
              <textarea
                value={resultText}
                onChange={e => setResultText(e.target.value)}
                placeholder={t('tcResultPlaceholder')}
                rows={3}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
              />
              <button
                onClick={onSubmitResult}
                disabled={!resultText.trim()}
                className="mt-2 px-4 py-2 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-40 text-white text-xs rounded-lg transition-colors"
              >
                {t('tcSubmitResultBtn')}
              </button>
            </div>
          )}

          {isCaller && submitted && (
            <div className={`${card} p-4`}>
              <h3 className="text-sm font-semibold text-white mb-2">{t('tcAcceptReject')}</h3>
              <p className="text-xs text-slate-400 mb-3">{t('tcAcceptHint')}</p>
              <div className="flex flex-col md:flex-row gap-2">
                <button
                  onClick={onAcceptResult}
                  className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-xs rounded-lg transition-colors"
                >
                  {t('tcAcceptRelease')}
                </button>
                <div className="flex-1 flex gap-2">
                  <input
                    type="text"
                    value={rejectReason}
                    onChange={e => setRejectReason(e.target.value)}
                    placeholder={t('tcRejectReason')}
                    className="flex-1 px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white focus:border-red-500"
                  />
                  <button
                    onClick={onRejectResult}
                    className="px-4 py-2 bg-red-600/80 hover:bg-red-600 text-white text-xs rounded-lg transition-colors"
                  >
                    {t('tcReject')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {open && (
            <div className={`${card} p-4`}>
              <h3 className="text-sm font-semibold text-white mb-2">
                {t('tcBids')} ({bids.length})
              </h3>
              {bids.length === 0 ? (
                <div className="text-center py-4 text-xs text-slate-500">{t('tcNoBids')}</div>
              ) : (
                <div className="space-y-2">
                  {bids.map(bid => {
                    const mine = myAgentId === bid.bidder_id;
                    return (
                      <div key={bid.id} className="bg-slate-800 rounded-lg p-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-white">
                              {bid.bidder_name || bid.bidder_id.slice(0, 8)}
                            </span>
                            {mine && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-500/20 text-brand-400">{t('tcYou')}</span>
                            )}
                            {bid.reputation_score != null && (
                              <span className="text-[10px] text-yellow-500">★ {bid.reputation_score.toFixed(2)}</span>
                            )}
                          </div>
                          <span className="text-xs font-bold text-brand-400">{bid.proposed_price} XCL</span>
                        </div>
                        {bid.proposal && (
                          <p className="text-[10px] text-slate-400 mt-1">{bid.proposal}</p>
                        )}
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-[10px] text-slate-500">
                            {bid.estimated_duration ? `${t('tcEta')} ${bid.estimated_duration}` : ''}
                            {bid.match_score != null ? ` · ${t('tcMatch')} ${(bid.match_score * 100).toFixed(0)}%` : ''}
                          </span>
                          {isCaller ? (
                            <button
                              onClick={() => onAcceptBid(bid.id)}
                              className="text-[10px] px-2.5 py-1 rounded bg-green-600 hover:bg-green-700 text-white transition-colors"
                            >
                              {t('tcAcceptBid')}
                            </button>
                          ) : mine ? (
                            <button
                              onClick={() => onWithdrawBid(bid.id)}
                              className="text-[10px] px-2.5 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
                            >
                              {t('tcWithdrawBid')}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {!isCaller && (
                <div className="mt-3 border-t border-slate-800 pt-3 space-y-2">
                  <h4 className="text-xs font-medium text-white">{t('tcPlaceBid')}</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <input
                      type="number"
                      value={bidPrice}
                      onChange={e => setBidPrice(e.target.value)}
                      placeholder={t('tcBidPrice')}
                      min="0"
                      step="0.01"
                      className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
                    />
                    <input
                      type="text"
                      value={bidDuration}
                      onChange={e => setBidDuration(e.target.value)}
                      placeholder={t('tcBidDuration')}
                      className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
                    />
                  </div>
                  <textarea
                    value={bidProposal}
                    onChange={e => setBidProposal(e.target.value)}
                    placeholder={t('tcBidProposal')}
                    rows={2}
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
                  />
                  {bidStatus && (
                    <p className={`text-xs ${bidStatus === 'success' ? 'text-green-400' : 'text-red-400'}`}>
                      {bidStatus === 'success' ? t('tcBidOk') : t('tcBidFail')}
                    </p>
                  )}
                  <button
                    onClick={onBid}
                    disabled={!bidPrice}
                    className="px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-xs rounded-lg transition-colors"
                  >
                    {t('tcSubmitBidBtn')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-800 p-2.5">
      <div className="text-[9px] text-slate-500">{label}</div>
      <div className="text-xs text-slate-200 mt-0.5 truncate">{value}</div>
    </div>
  );
}
