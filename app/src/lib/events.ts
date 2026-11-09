/**
 * Tiny change bus so screens re-read SQLite after writes. Every repo write that
 * touches a table emits that table's topic (in-process only, which is enough:
 * the background task and the UI share one JS runtime when the app is alive).
 */
export type Topic = 'messages' | 'kv' | 'bg_runs' | 'deliveries' | 'streaming';

const listeners = new Map<Topic, Set<() => void>>();

export function subscribe(topic: Topic, cb: () => void): () => void {
  let set = listeners.get(topic);
  if (!set) listeners.set(topic, (set = new Set()));
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

export function emit(...topics: Topic[]): void {
  for (const t of topics) listeners.get(t)?.forEach((cb) => cb());
}
