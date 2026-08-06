import React from 'react';
import { useSystemHealthContext } from './SystemHealthContext';
import { useI18n } from '../i18n/LanguageContext';
import type { TranslationKey } from '../i18n/translations';

const STATUS_TEXT: Record<string, TranslationKey> = {
  ok: 'systemOperational',
  degraded: 'systemDegraded',
  down: 'systemUnreachable',
};

export default function Footer() {
  const health = useSystemHealthContext();
  const { t } = useI18n();

  return (
    <footer
      className="shrink-0 border-t border-slate-800 bg-slate-950/90 px-4 py-2.5 flex items-center justify-between gap-3"
      role="contentinfo"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            health.status === 'ok' ? 'bg-green-500' : health.status === 'degraded' ? 'bg-amber-500' : 'bg-red-500'
          }`}
          aria-hidden="true"
        />
        <span className="text-[11px] text-slate-400 truncate">
          {t(STATUS_TEXT[health.status] || 'systemOperational')}
        </span>
        <span className="hidden sm:inline text-[10px] text-slate-600 font-mono">
          API {health.backend.toUpperCase()} · DB {health.database.toUpperCase()} · REDIS {health.redis.toUpperCase()}
        </span>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <span className="hidden md:inline text-[10px] text-slate-600">
          © 2026 XClaw.Network · {t('rights')}
        </span>
        <a href="/privacy.html" target="_blank" rel="noopener noreferrer" className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors">
          {t('privacy')}
        </a>
        <a href="/terms.html" target="_blank" rel="noopener noreferrer" className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors">
          {t('terms')}
        </a>
        <a href="/manual.html" target="_blank" rel="noopener noreferrer" className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors">
          {t('manual')}
        </a>
      </div>
    </footer>
  );
}
