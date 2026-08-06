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
      </div>
    </footer>
  );
}
