import React, { useState, useEffect, useCallback } from 'react';
import { useThemeStore } from '../../store/useThemeStore';
import { request } from '../../utils/api';
import { useI18n } from '../../i18n/LanguageContext';

interface Webhook {
  id: string;
  url: string;
  events: string[];
  description?: string;
  active: boolean;
  created_at: string;
}

interface Delivery {
  id: string;
  event_type: string;
  status: string;
  attempts: number;
  created_at: string;
}

export default function WebhookManager() {
  const { t } = useI18n();
  const theme = useThemeStore(s => s.theme);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState({ url: '', events: '', description: '' });
  const [formStatus, setFormStatus] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [whRes, evRes] = await Promise.allSettled([
        request('/v1/webhooks'),
        request('/v1/events/types'),
      ]);
      if (whRes.status === 'fulfilled' && whRes.value.success) {
        setWebhooks(whRes.value.data || []);
      }
      if (evRes.status === 'fulfilled' && evRes.value.success) {
        setEvents(evRes.value.data || []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleCreate = async () => {
    setFormStatus('');
    try {
      const evts = form.events.split(',').map(s => s.trim()).filter(Boolean);
      const res = await request('/v1/webhooks', {
        method: 'POST',
        body: JSON.stringify({ url: form.url, events: evts, description: form.description }),
      });
      if (res.success) {
        setFormStatus('success');
        setForm({ url: '', events: '', description: '' });
        loadData();
      } else {
        setFormStatus('error');
      }
    } catch {
      setFormStatus('error');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await request(`/v1/webhooks/${id}`, { method: 'DELETE' });
      loadData();
    } catch { /* ignore */ }
  };

  const card = theme === 'dark'
    ? 'bg-gray-800/50 border border-gray-700/50 rounded-xl'
    : 'bg-white border border-gray-200 rounded-xl shadow-sm';

  return (
    <div className="space-y-6">
      <div className="border-l-4 border-amber-500 pl-4">
        <h2 className="text-xl font-bold text-white">{t('whTitle')}</h2>
        <p className="text-sm text-slate-400 mt-1">{t('whDesc')}</p>
      </div>

      <div className={`${card} p-4`}>
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('whCreate')}</h3>
        <div className="space-y-3">
          <input
            type="text"
            value={form.url}
            onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
            placeholder={t('whCallbackUrl')}
            className="w-full px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-400 text-sm focus:outline-none focus:border-amber-500"
          />
          <input
            type="text"
            value={form.events}
            onChange={e => setForm(f => ({ ...f, events: e.target.value }))}
            placeholder={t('whEventTypes')}
            className="w-full px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-400 text-sm focus:outline-none focus:border-amber-500"
          />
          <input
            type="text"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            placeholder={t('whDescOptional')}
            className="w-full px-3 py-2 rounded-lg bg-gray-900/50 border border-gray-700 text-white placeholder-slate-400 text-sm focus:outline-none focus:border-amber-500"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={handleCreate}
              disabled={!form.url || !form.events}
              className="bg-amber-500 hover:bg-amber-600 rounded-lg px-4 py-2 text-sm text-white font-medium disabled:opacity-40 transition-colors"
            >
              {t('whCreateBtn')}
            </button>
            {formStatus === 'success' && <span className="text-emerald-400 text-sm">{t('pnlCreatedOk')}</span>}
            {formStatus === 'error' && <span className="text-red-400 text-sm">{t('pnlCreatedFail')}</span>}
          </div>
        </div>
      </div>

      {events.length > 0 && (
        <div className={`${card} p-4`}>
          <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{t('whAvailableEvents')}</h3>
          <div className="flex flex-wrap gap-2">
            {events.map(e => (
              <span key={e} className="px-2 py-1 text-xs bg-amber-500/20 text-amber-300 rounded-full">{e}</span>
            ))}
          </div>
        </div>
      )}

      <div className={`${card} p-4`}>
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">
          {t('whRegistered')} ({webhooks.length})
        </h3>
        {loading ? (
          <div className="text-center py-6 text-slate-400 text-sm animate-pulse">{t('pnlLoading')}</div>
        ) : webhooks.length === 0 ? (
          <div className="text-center py-6 text-slate-400 text-sm">{t('pnlNoWebhooks')}</div>
        ) : (
          <div className="space-y-2">
            {webhooks.map(wh => (
              <div key={wh.id} className="flex items-center justify-between bg-gray-900/50 rounded-lg p-3">
                <div>
                  <div className="text-sm text-white font-medium font-mono">{wh.url}</div>
                  <div className="flex gap-1 mt-1">
                    {wh.events.map(e => (
                      <span key={e} className="px-1.5 py-0.5 text-[12px] bg-amber-500/20 text-amber-300 rounded">{e}</span>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(wh.id)}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  {t('pnlDelete')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
