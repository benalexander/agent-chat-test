import { useSyncExternalStore } from 'react';

import { getStreaming } from '../chat/streaming';
import { subscribe } from '../lib/events';

const sub = (cb: () => void) => subscribe('streaming', cb);

/** The reply currently streaming in, or null. */
export function useStreaming() {
  return useSyncExternalStore(sub, getStreaming);
}
