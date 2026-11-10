/**
 * Registry "touch" on app requests: lastSeen + device timezone. The Registry itself
 * throttles writes to once a minute per user; this in-isolate memo additionally skips
 * the RPC entirely when this isolate touched the same user/timezone recently.
 */
import { isValidTimezone } from './guardrails';
import { registryStub, TOUCH_THROTTLE_MS } from './registry';

const MEMO_MAX = 1000;
const memo = new Map<string, { at: number; tz: string | null }>();

export function touchRegistry(env: Cloudflare.Env, userId: string, rawTz: string | null): Promise<void> | null {
  const now = Date.now();
  const tz = isValidTimezone(rawTz) ? rawTz : null;
  const prev = memo.get(userId);
  if (prev && now - prev.at < TOUCH_THROTTLE_MS && (tz === null || tz === prev.tz)) return null;
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(userId, { at: now, tz: tz ?? prev?.tz ?? null });
  return registryStub(env)
    .touch(userId, now, tz)
    .then(
      () => undefined,
      (e: unknown) => {
        memo.delete(userId);
        console.warn('[registry] touch failed', userId, e);
      },
    );
}

/** Called after an admin DELETE so the user re-registers on their next app request. */
export function forgetTouch(userId: string): void {
  memo.delete(userId);
}
