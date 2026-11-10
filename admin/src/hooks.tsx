import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtDate, fmtDateTime, fmtRelative } from './format';

// ---- Hash routing ----------------------------------------------------------------

export type Route = { name: 'users' } | { name: 'user'; userId: string };

function parseHash(hash: string): Route {
  const m = /^#\/users\/([^/]+)\/?$/.exec(hash);
  if (m) return { name: 'user', userId: decodeURIComponent(m[1]) };
  return { name: 'users' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const userHref = (userId: string) => `#/users/${encodeURIComponent(userId)}`;

// ---- Polling -----------------------------------------------------------------------

export interface PollState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** Fetch now (and restart the interval). */
  refresh: () => Promise<void>;
}

/**
 * Calls `fetcher` immediately and then every `intervalMs` while the tab is visible.
 * Keeps the last good `data` when a poll fails. Re-fetches on becoming visible.
 */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs: number, key: string): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const timer = useRef<number | undefined>(undefined);
  const generation = useRef(0);

  const run = useCallback(async () => {
    const gen = generation.current;
    window.clearTimeout(timer.current);
    try {
      const result = await fetcherRef.current();
      if (gen !== generation.current) return;
      setData(result);
      setError(null);
    } catch (e) {
      if (gen !== generation.current) return;
      setError(e);
    } finally {
      if (gen === generation.current) {
        setLoading(false);
        window.clearTimeout(timer.current);
        if (!document.hidden) timer.current = window.setTimeout(run, intervalMs);
      }
    }
  }, [intervalMs]);

  useEffect(() => {
    generation.current++;
    setData(null);
    setError(null);
    setLoading(true);
    void run();
    const onVisibility = () => {
      if (document.hidden) window.clearTimeout(timer.current);
      else void run();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      generation.current++;
      window.clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [key, run]);

  return { data, error, loading, refresh: run };
}

// ---- Time display ------------------------------------------------------------------

/** Absolute time in `tz`, relative time in the tooltip. */
export function Time({ ms, tz, dateOnly }: { ms: number | null | undefined; tz: string; dateOnly?: boolean }) {
  if (ms == null) return <span className="muted">—</span>;
  return (
    <time dateTime={new Date(ms).toISOString()} title={fmtRelative(ms)}>
      {dateOnly ? fmtDate(ms, tz) : fmtDateTime(ms, tz)}
    </time>
  );
}
