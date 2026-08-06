import React, { useMemo } from 'react';
import { useXClawStore } from '../store/useXClawStore';
import type { FeedItem } from '../store/useXClawStore';
import { useI18n } from '../i18n/LanguageContext';

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
          <span className={`text-[10px] font-semibold truncate ${tone}`}>
            {label}
            {item.who ? ` · ${item.who}` : ''}
          </span>
          <span className="text-[9px] text-slate-600 whitespace-nowrap shrink-0">{item.time}</span>
        </div>
        {item.content && (
          <p className="text-[10px] text-slate-400 leading-relaxed break-all line-clamp-2 mt-0.5">
            {item.content}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 实时动态模块：新加入/离开的 Agent、Agent 全网广播、P2P 消息。
 * 数据来自 WebSocket 实时流（store.feed）。
 */
export default function LiveFeed() {
  const { t } = useI18n();
  const feed = useXClawStore(s => s.feed);
  const isConnected = useXClawStore(s => s.isConnected);

  const rows = useMemo(() => feed.slice(0, 60), [feed]);

  return (
    <div className="h-full flex flex-col bg-slate-950/70">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-800 shrink-0">
        <h3 className="text-[11px] font-bold text-cyan-400 tracking-wider">
          {t('feedTitle')}
        </h3>
        <span className="flex items-center gap-1.5">
          <span className="relative flex w-2 h-2" aria-hidden="true">
            <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping ${isConnected ? 'bg-cyan-400' : 'bg-slate-600'}`} />
            <span className={`relative inline-flex w-2 h-2 rounded-full ${isConnected ? 'bg-cyan-400' : 'bg-slate-600'}`} />
          </span>
          <span className={`text-[9px] font-mono ${isConnected ? 'text-green-500' : 'text-red-500'}`}>
            {isConnected ? t('connected').toUpperCase() : t('connecting').toUpperCase()}
          </span>
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-1.5 space-y-0.5">
        {rows.length === 0 ? (
          <div className="text-center py-10 px-4">
            <div className="text-2xl mb-2">📡</div>
            <p className="text-[10px] text-slate-600 leading-relaxed">
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
                  label={item.sub === 'left' ? t('feedAgentLeft') : t('feedAgentJoined')}
                  tone={item.sub === 'left' ? 'text-slate-400' : 'text-green-400'}
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
            if (item.kind === 'p2p') {
              return (
                <FeedRow
                  key={item.id}
                  item={item}
                  icon="↔"
                  label={t('feedP2P')}
                  tone="text-cyan-400"
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
