/** Small display helpers shared by Coach and Debug. */

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)} s`;
  const m = s / 60;
  if (m < 90) return `${m.toFixed(1)} min`;
  return `${(m / 60).toFixed(1)} h`;
}

export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.name === 'AbortError' ? 'timeout' : e.message;
  return String(e);
}
