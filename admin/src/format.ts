/** Time + money formatting. All absolute times render in a given IANA zone. */

export const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Returns `tz` if the runtime knows it, else the browser's zone. */
export function resolveTz(tz: string | null | undefined): string {
  if (!tz) return browserTz;
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return tz;
  } catch {
    return browserTz;
  }
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string, kind: 'datetime' | 'date'): Intl.DateTimeFormat {
  const key = `${kind}|${tz}`;
  let f = dtfCache.get(key);
  if (!f) {
    f =
      kind === 'datetime'
        ? new Intl.DateTimeFormat('en-AU', {
            timeZone: tz,
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
          })
        : new Intl.DateTimeFormat('en-AU', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' });
    dtfCache.set(key, f);
  }
  return f;
}

export function fmtDateTime(ms: number, tz: string): string {
  return dtf(tz, 'datetime').format(ms);
}

export function fmtDate(ms: number, tz: string): string {
  return dtf(tz, 'date').format(ms);
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function fmtRelative(ms: number, now = Date.now()): string {
  const diff = (ms - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return rtf.format(Math.round(diff), 'second');
  if (abs < 45 * 60) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 22 * 3600) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 30 * 86400) return rtf.format(Math.round(diff / 86400), 'day');
  return rtf.format(Math.round(diff / (30 * 86400)), 'month');
}

export function fmtMoney(n: number): string {
  return `A$${Math.round(n).toLocaleString('en-AU')}`;
}

export function pct(raised: number, target: number): number {
  return target > 0 ? Math.round((raised / target) * 100) : 0;
}

export function fmtRaised(raised: number, target: number): string {
  return `${fmtMoney(raised)} / ${fmtMoney(target)} (${pct(raised, target)}%)`;
}

export function fmtInt(n: number): string {
  return n.toLocaleString('en-AU');
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

// ---- date <input> <-> ms in a zone --------------------------------------------

function zoneParts(ms: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** `YYYY-MM-DD` of `ms` as seen in `tz`. */
export function toDateInput(ms: number, tz: string): string {
  const p = zoneParts(ms, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Offset of `tz` from UTC at instant `ms`, in ms. */
function tzOffset(ms: number, tz: string): number {
  const p = zoneParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which it is `dateStr` (YYYY-MM-DD) in `tz`, at the same wall-clock
 * time of day that `keepTimeOf` has in `tz`.
 */
export function fromDateInput(dateStr: string, tz: string, keepTimeOf: number): number {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const t = zoneParts(keepTimeOf, tz);
  const wall = Date.UTC(y, mo - 1, d, t.h, t.mi, t.s);
  // Two passes to settle DST transitions.
  let guess = wall - tzOffset(wall, tz);
  guess = wall - tzOffset(guess, tz);
  return guess;
}
