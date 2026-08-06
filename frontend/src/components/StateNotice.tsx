import React from 'react';
import { useI18n } from '../i18n/LanguageContext';

export function LoadingState({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-slate-400">
      <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
      <span className="text-xs">{label || t('loading')}</span>
    </div>
  );
}

export function EmptyState({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className="text-center py-10 px-4">
      <div className="text-2xl mb-2">🌌</div>
      <p className="text-xs text-slate-400 leading-relaxed max-w-sm mx-auto">{message}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorState({ onRetry, hint }: { onRetry?: () => void; hint?: string }) {
  const { t } = useI18n();
  return (
    <div className="text-center py-10 px-4">
      <div className="text-2xl mb-2">⚠️</div>
      <p className="text-xs text-red-400 font-medium">{t('loadFailed')}</p>
      <p className="text-[11px] text-slate-500 mt-1">{hint || t('loadFailedHint')}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded-lg transition-colors"
        >
          {t('retry')}
        </button>
      )}
    </div>
  );
}
