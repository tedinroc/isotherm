export const pct = (p: number | null | undefined, digits = 0) =>
  p === null || p === undefined || !Number.isFinite(p) ? '—' : `${(p * 100).toFixed(digits)}%`;

/** A price in AUSD per contract shown as cents-like "0.41". */
export const px = (p: number | null | undefined) => (p === null || p === undefined || !Number.isFinite(p) ? '—' : p.toFixed(p < 0.01 || p > 0.99 ? 3 : 2));

export const amt = (x: number | null | undefined, digits = 2) =>
  x === null || x === undefined || !Number.isFinite(x)
    ? '—'
    : x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

export function countdown(secs: number, lang: 'en' | 'zh'): string {
  if (secs <= 0) return lang === 'zh' ? '已截止' : 'closed';
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (lang === 'zh') {
    if (d > 0) return `${d}天${h}小時`;
    if (h > 0) return `${h}小時${m}分`;
    return `${m}分${s}秒`;
  }
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

export const localTime = (unix: number, lang: 'en' | 'zh', tzOffsetMin?: number) => {
  const d = new Date((unix + (tzOffsetMin ?? 0) * 60) * 1000);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
  if (tzOffsetMin !== undefined) opts.timeZone = 'UTC';
  return d.toLocaleString(lang === 'zh' ? 'zh-TW' : 'en-US', opts);
};
