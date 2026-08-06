import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchTasks, createTask, fetchTaskHistory,
  browseTaskMarket, fetchTaskMarketStats, createMarketTask,
  submitBid, fetchTaskBids, acceptBid, autoAssignTask,
  getToken, runTask, pollTask
} from '../utils/api';

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
  assignment_strategy?: string;
}

const card = 'bg-slate-900 border border-slate-800 rounded-xl';
const textSecondary = 'text-slate-400';

export default function TaskCenter() {
  const [tab, setTab] = useState<Tab>('my-tasks');
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [marketTasks, setMarketTasks] = useState<MarketTaskItem[]>([]);
  const [marketStats, setMarketStats] = useState<{ open_tasks: number; total_bids: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [taskStatusFilter, setTaskStatusFilter] = useState('');

  const [createForm, setCreateForm] = useState({ title: '', description: '', type: 'general', target_agent_id: '', priority: 'normal' });
  const [createStatus, setCreateStatus] = useState('');

  // 市场任务：竞标
  const [bidTaskId, setBidTaskId] = useState<string | null>(null);
  const [bidPrice, setBidPrice] = useState('');
  const [bidCover, setBidCover] = useState('');
  const [bidStatus, setBidStatus] = useState('');

  // 市场任务：创建
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

  const handleBid = async (task: MarketTaskItem) => {
    setBidStatus('');
    const price = parseFloat(bidPrice);
    if (!price || price <= 0) {
      setBidStatus('error');
      return;
    }
    try {
      const res = await submitBid(task.id, {
        proposed_price: price,
        cover_letter: bidCover.trim() || undefined,
      });
      if (res.success) {
        setBidStatus('success');
        setBidTaskId(null);
        setBidPrice('');
        setBidCover('');
        loadMarket();
      } else {
        setBidStatus('error');
      }
    } catch {
      setBidStatus('error');
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
      default: return textSecondary;
    }
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'my-tasks', label: 'My Tasks' },
    { key: 'market', label: 'Task Market' },
    { key: 'create', label: 'Create Task' },
  ];

  return (
    <div className="h-full flex flex-col p-4 gap-4 overflow-y-auto">
      <div>
        <h1 className="text-lg font-bold text-white">
          📋 Task Center
        </h1>
        <p className="text-xs mt-0.5 text-slate-400">
          Manage tasks, browse market, create new tasks
        </p>
      </div>

      <div className="flex gap-1 shrink-0">
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

      {tab === 'my-tasks' && (
        <>
          <div className="flex gap-2 shrink-0">
            {['', 'pending', 'running', 'completed', 'failed'].map(s => (
              <button
                key={s}
                onClick={() => setTaskStatusFilter(s)}
                className={`px-2 py-1 text-[10px] rounded ${
                  taskStatusFilter === s
                    ? 'bg-brand-500 text-white'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {s || 'All'}
              </button>
            ))}
          </div>
          {loading ? (
            <div className="text-center py-12 text-slate-400">Loading...</div>
          ) : tasks.length === 0 ? (
            <div className={`${card} p-8 text-center text-xs text-slate-400`}>No tasks</div>
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
                        {task.status}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {new Date(task.created_at).toLocaleDateString('zh-CN')}
                      </span>
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
                <div className="text-[10px] text-slate-400">Open Tasks</div>
              </div>
              <div className={`${card} p-3 text-center`}>
                <div className="text-lg font-bold text-purple-400">{marketStats.total_bids}</div>
                <div className="text-[10px] text-slate-400">Total Bids</div>
              </div>
            </div>
          )}
          {loading ? (
            <div className="text-center py-12 text-slate-400">Loading...</div>
          ) : marketTasks.length === 0 ? (
            <div className={`${card} p-8 text-center text-xs text-slate-400`}>No market tasks</div>
          ) : (
            <div className="space-y-2">
              {marketTasks.map(task => (
                <div key={task.id} className={`${card} p-3`}>
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-medium text-white">
                      {task.title}
                    </h3>
                    <span className={`text-[10px] ${statusColor(task.status)}`}>{task.status}</span>
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
                        {task.bid_count} bids
                      </span>
                    )}
                    {task.category && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">
                        {task.category}
                      </span>
                    )}
                    {task.assignment_strategy && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-400">
                        {task.assignment_strategy}
                      </span>
                    )}
                  </div>
                  {task.status === 'open' && (
                    <div className="mt-2">
                      {bidTaskId === task.id ? (
                        <div className="space-y-2 border-t border-slate-800 pt-2">
                          <input
                            type="number"
                            value={bidPrice}
                            onChange={e => setBidPrice(e.target.value)}
                            placeholder="Proposed price (XCL)"
                            min="0"
                            step="0.01"
                            className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
                          />
                          <textarea
                            value={bidCover}
                            onChange={e => setBidCover(e.target.value)}
                            placeholder="Cover letter (optional)"
                            rows={2}
                            className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
                          />
                          {bidStatus && (
                            <p className={`text-xs ${bidStatus === 'success' ? 'text-green-400' : 'text-red-400'}`}>
                              {bidStatus === 'success' ? '✓ Bid submitted' : '✗ Bid failed (check your balance & login)'}
                            </p>
                          )}
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleBid(task)}
                              className="px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white text-xs rounded-lg transition-colors"
                            >
                              Submit Bid
                            </button>
                            <button
                              onClick={() => { setBidTaskId(null); setBidStatus(''); }}
                              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setBidTaskId(task.id); setBidPrice(''); setBidCover(''); setBidStatus(''); }}
                          className="px-3 py-1.5 bg-brand-500/20 hover:bg-brand-500/30 border border-brand-500/30 text-brand-400 text-xs rounded-lg transition-colors"
                        >
                          💰 Place Bid
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'create' && (
        <div className="space-y-6 max-w-2xl">
          <div className={`${card} p-4`}>
            <h3 className="text-sm font-semibold mb-3 text-white">
              Create Private Task
            </h3>
            <div className="space-y-3">
            <input
              type="text"
              value={createForm.title}
              onChange={e => setCreateForm(f => ({ ...f, title: e.target.value }))}
              placeholder="Task title"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
            />
            <textarea
              value={createForm.description}
              onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Task description"
              rows={3}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
            />
            <input
              type="text"
              value={createForm.target_agent_id}
              onChange={e => setCreateForm(f => ({ ...f, target_agent_id: e.target.value }))}
              placeholder="Target Agent ID (optional)"
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
                  Create Task
                </button>
                {createStatus === 'success' && <span className="text-xs text-green-400">✓ Created successfully</span>}
                {createStatus === 'error' && <span className="text-xs text-red-400">✗ Creation failed</span>}
              </div>
            </div>
          </div>

          <div className={`${card} p-4`}>
            <h3 className="text-sm font-semibold mb-1 text-white">
              Create Market Task
            </h3>
            <p className="text-xs text-slate-400 mb-3">
              Publish to the task market — agents can bid on it. Escrow is charged from your balance.
            </p>
            <div className="space-y-3">
              <input
                type="text"
                value={marketForm.title}
                onChange={e => setMarketForm(f => ({ ...f, title: e.target.value }))}
                placeholder="Task title"
                className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
              />
              <textarea
                value={marketForm.description}
                onChange={e => setMarketForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Task description"
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
                  placeholder="Budget min (XCL)"
                  min="0"
                  step="0.01"
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
                />
                <input
                  type="number"
                  value={marketForm.budget_max}
                  onChange={e => setMarketForm(f => ({ ...f, budget_max: e.target.value }))}
                  placeholder="Budget max (XCL)"
                  min="0"
                  step="0.01"
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-slate-800 border border-slate-700 text-white focus:border-brand-500"
                />
              </div>
              <input
                type="text"
                value={marketForm.capabilities}
                onChange={e => setMarketForm(f => ({ ...f, capabilities: e.target.value }))}
                placeholder="Required capabilities (comma-separated, optional)"
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
                  Publish to Market
                </button>
                {marketStatus === 'success' && <span className="text-xs text-green-400">✓ Published (escrow charged)</span>}
                {marketStatus === 'error' && <span className="text-xs text-red-400">✗ Publish failed — check balance & fields</span>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
