import React, { useMemo, useState } from 'react';
import { useXClawStore } from '../store/useXClawStore';
import type { FeedItem } from '../store/useXClawStore';
import { useI18n } from '../i18n/LanguageContext';
import { getToken, sendBroadcast } from '../utils/api';

function FeedRow({ item, label, icon, tone }: {
  item: FeedItem;
  label: string;
  icon: string;
  tone: string;
}) {
  return (
    <div className="flex gap-2 py-1.5 px-1 rounded-lg hover:bg-slate-800/40 transition-colors">
      <span className="text-xs mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`text-[12px] font-semibold truncate ${tone}`}>
            {label}
            {item.who ? ` · ${item.who}` : ''}
          </span>
          <span className="text-[11px] text-slate-400 whitespace-nowrap shrink-0">{item.time}</span>
        </div>
        {item.content && (
          <p className="text-[12px] text-slate-400 leading-relaxed break-all line-clamp-2 mt-0.5">
            {item.content}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 实时动态模块：订阅 /ws 的 feed:public 频道，展示脱敏后的公开网络动态
 * （Agent 注册/上下线、技能上架/被调用、任务流转、订单），登录后可直接向全网广播。
 *
 * 说明：不展示 P2P 消息内容——那是 Agent 之间的私密通信，只允许在 monitor 通道
 * （需 MONITOR_TOKEN）下用于运维观测，不会下发到浏览器。
 */
export default function LiveFeed() {
  const { t } = useI18n();
  const feed = useXClawStore(s => s.feed);
  const isConnected = useXClawStore(s => s.isConnected);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState('');

  const authed = !!getToken();

  const rows = useMemo(() => feed.slice(0, 60), [feed]);

  const handleSend = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    setSendMsg('');
    try {
      const content = draft.trim();
      const res = await sendBroadcast(content);
      setSendMsg(res?.success ? t('lfSent') : t('lfSendFail'));
      if (res?.success) {
        setDraft('');
        // 本地回显：广播是即时的，不必等下一次事件回流
        useXClawStore.getState().addFeed({
          kind: 'broadcast',
          content,
          time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        });
      }
    } catch {
      setSendMsg(t('lfSendFail'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-slate-950/70">
      <div className="px-3 py-2.5 border-b border-slate-800 shrink-0 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-bold text-cyan-400 tracking-wider">
            {t('feedTitle')}
          </h3>
          <span className="flex items-center gap-1.5">
            <span className="relative flex w-2 h-2" aria-hidden="true">
              <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping ${isConnected ? 'bg-cyan-400' : 'bg-slate-600'}`} />
              <span className={`relative inline-flex w-2 h-2 rounded-full ${isConnected ? 'bg-cyan-400' : 'bg-slate-600'}`} />
            </span>
            <span className={`text-[11px] font-mono ${isConnected ? 'text-green-500' : 'text-red-500'}`}>
              {isConnected ? t('connected').toUpperCase() : t('connecting').toUpperCase()}
            </span>
          </span>
        </div>

        {authed && (
          <div className="space-y-1.5">
            <div className="flex gap-1.5">
              <input
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
                placeholder={t('lfBroadcastPlaceholder')}
                className="flex-1 min-w-0 bg-slate-900/80 border border-slate-700 rounded-lg px-2.5 py-1.5 text-[11px] text-white outline-none focus:border-cyan-500 placeholder-slate-400"
              />
              <button
                onClick={handleSend}
                disabled={sending || !draft.trim()}
                className="shrink-0 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-40 text-white text-[11px] rounded-lg transition-colors"
              >
                {t('lfSend')}
              </button>
            </div>
            {sendMsg && (
              <p className={`text-[12px] ${sendMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>
                {sendMsg}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-1.5 space-y-0.5">
        {!authed && (
          <p className="text-[11px] text-slate-400 text-center py-1">{t('lfNeedLogin')}</p>
        )}
        {rows.length === 0 ? (
          <div className="text-center py-10 px-4">
            <div className="text-2xl mb-2">📡</div>
            <p className="text-[12px] text-slate-400 leading-relaxed">
              {t('feedEmpty')}
              <br />
              {isConnected ? t('networkQuiet') : t('connectingText')}
            </p>
          </div>
        ) : (
          rows.map(item => {
            if (item.kind === 'agent') {
              return (
                <FeedRow
                  key={item.id}
                  item={item}
                  icon={item.sub === 'left' ? '🚪' : '🤖'}
                  label={
                    item.sub === 'left'
                      ? t('feedAgentLeft')
                      : item.sub === 'registered'
                        ? t('feedAgentRegistered')
                        : t('feedAgentJoined')
                  }
                  tone={item.sub === 'left' ? 'text-slate-400' : 'text-green-400'}
                />
              );
            }
            if (item.kind === 'skill') {
              const subLabel = item.sub === 'called' ? t('feedSubCalled') : t('feedSubListed');
              return (
                <FeedRow
                  key={item.id}
                  item={item}
                  icon="🧩"
                  label={`${t('feedSkill')} · ${subLabel}`}
                  tone="text-violet-400"
                />
              );
            }
            if (item.kind === 'task') {
              const subMap: Record<string, string> = {
                created: t('feedSubCreated'),
                submitted: t('feedSubSubmitted'),
                completed: t('feedSubCompleted'),
                disputed: t('feedSubDisputed'),
              };
              const subLabel = (item.sub && subMap[item.sub]) || item.sub || '';
              return (
                <FeedRow
                  key={item.id}
                  item={item}
                  icon="📋"
                  label={`${t('feedTask')} · ${subLabel}`}
                  tone="text-cyan-400"
                />
              );
            }
            if (item.kind === 'order') {
              const subLabel = item.sub === 'completed' ? t('feedSubCompleted') : t('feedSubCreated');
              return (
                <FeedRow
                  key={item.id}
                  item={item}
                  icon="🛒"
                  label={`${t('feedOrder')} · ${subLabel}`}
                  tone="text-emerald-400"
                />
              );
            }
            if (item.kind === 'broadcast') {
              return (
                <FeedRow
                  key={item.id}
                  item={item}
                  icon="📢"
                  label={t('feedBroadcast')}
                  tone="text-amber-400"
                />
              );
            }
            return (
              <FeedRow
                key={item.id}
                item={item}
                icon="●"
                label={item.who || 'system'}
                tone="text-slate-400"
              />
            );
          })
        )}
      </div>
    </div>
  );
}
