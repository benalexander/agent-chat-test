import { countUnreadAbove, KV, kvGetNumber } from '../db/repo';
import { useQuery } from './useQuery';

/** Complete assistant messages newer than lastSeenRev (Coach tab badge). */
export function useUnread(): number {
  const { data } = useQuery(async () => countUnreadAbove(await kvGetNumber(KV.lastSeenRev)), ['messages', 'kv']);
  return data ?? 0;
}
