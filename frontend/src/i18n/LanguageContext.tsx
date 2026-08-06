import React, { createContext, useContext, useEffect, useState } from 'react';
import { zh, en } from './translations';
import type { TranslationKey } from './translations';

export type Lang = 'zh' | 'en';

const STORAGE_KEY = 'xclaw_lang';

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function detectInitialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh') return saved;
  } catch { /* ignore */ }
  return 'zh';
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch { /* ignore */ }
  }, [lang]);

  const value: I18nContextValue = {
    lang,
    setLang: setLangState,
    toggleLang: () => setLangState(prev => (prev === 'zh' ? 'en' : 'zh')),
    t: (key) => (lang === 'zh' ? zh[key] : en[key]) ?? zh[key] ?? key,
  };

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used within LanguageProvider');
  }
  return ctx;
}
