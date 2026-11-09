/** Load something from SQLite and reload whenever one of `topics` changes. */
import { useCallback, useEffect, useRef, useState } from 'react';

import { subscribe, type Topic } from '../lib/events';

export function useQuery<T>(load: () => Promise<T>, topics: readonly Topic[]): { data: T | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  // Drop stale results if loads overlap.
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    loadRef
      .current()
      .then((v) => {
        if (mine === seq.current) setData(v);
      })
      .catch((e) => console.warn('[useQuery]', e));
  }, []);

  const topicKey = topics.join(',');
  useEffect(() => {
    reload();
    const unsubs = topicKey.split(',').map((t) => subscribe(t as Topic, reload));
    return () => unsubs.forEach((u) => u());
  }, [reload, topicKey]);

  return { data, reload };
}
