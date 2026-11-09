/** The device's fundraiser id: a UUID kept in SecureStore. It names the agent instance on the worker. */
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const KEY = 'agent_chat_user_id';

/**
 * AFTER_FIRST_UNLOCK so the background task can read it while the phone is
 * locked (the default WHEN_UNLOCKED would fail in BGTaskScheduler runs).
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

let cached: string | null = null;
let creating: Promise<string> | null = null;

export async function getUserId(): Promise<string> {
  if (cached) return cached;
  creating ??= (async () => {
    let id = await SecureStore.getItemAsync(KEY, OPTIONS);
    if (!id) {
      id = Crypto.randomUUID();
      await SecureStore.setItemAsync(KEY, id, OPTIONS);
    }
    cached = id;
    return id;
  })().finally(() => {
    creating = null;
  });
  return creating;
}
