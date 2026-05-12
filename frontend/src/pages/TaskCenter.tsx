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
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'create' && (
        <div className={`${card} p-4 max-w-lg`}>
          <h3 className="text-sm font-semibold mb-3 text-white">
            Create New Task
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
      )}
    </div>
  );
}