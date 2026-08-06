import type { Lang } from '../i18n/LanguageContext';

const localeFor = (lang: Lang) => (lang === 'zh' ? 'zh-CN' : 'en-US');

export function fmtDate(value: string | number | Date | undefined, lang: Lang): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(localeFor(lang));
}

export function fmtDateTime(value: string | number | Date | undefined, lang: Lang): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(localeFor(lang));
}
