import React from 'react';
import { useI18n } from '../i18n/LanguageContext';

export default function Footer() {
  const { t } = useI18n();

  return (
    <footer
      className="shrink-0 border-t border-slate-800 bg-slate-950/90 px-4 py-2.5 flex items-center justify-between gap-3"
      role="contentinfo"
    >
      <div className="flex items-center gap-3 shrink-0">
        <span className="hidden md:inline text-[12px] text-slate-400">
          © 2026 XClaw.Network · {t('rights')}
        </span>
        <a href="/privacy.html" target="_blank" rel="noopener noreferrer" className="text-[11px] text-slate-400 hover:text-slate-300 transition-colors">
          {t('privacy')}
        </a>
        <a href="/terms.html" target="_blank" rel="noopener noreferrer" className="text-[11px] text-slate-400 hover:text-slate-300 transition-colors">
          {t('terms')}
        </a>
        <a href="/manual.html" target="_blank" rel="noopener noreferrer" className="text-[11px] text-slate-400 hover:text-slate-300 transition-colors">
          {t('manual')}
        </a>
        <a
          href="https://github.com/qomob/XClaw"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-300 transition-colors"
          title="GitHub"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          <span>GitHub</span>
        </a>
      </div>
    </footer>
  );
}
