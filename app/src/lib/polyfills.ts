/**
 * Globals the AI SDK may touch that Hermes lacks. Expo's WinterCG runtime
 * already installs TextDecoderStream, structuredClone, URL and the streaming
 * expo/fetch; ReadableStream/TransformStream come from Metro's runtime.
 * Here we only add crypto.randomUUID / getRandomValues via expo-crypto.
 */
import * as Crypto from 'expo-crypto';

type CryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
};

const g = globalThis as unknown as { crypto?: CryptoLike };
g.crypto ??= {};
if (typeof g.crypto.randomUUID !== 'function') {
  g.crypto.randomUUID = () => Crypto.randomUUID();
}
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T =>
    Crypto.getRandomValues(array as unknown as Uint8Array) as unknown as T) as CryptoLike['getRandomValues'];
}

export {};

if (__DEV__ && (typeof globalThis.TransformStream === 'undefined' || typeof globalThis.ReadableStream === 'undefined')) {
  // The AI SDK's SSE parser needs web streams. Expo's runtime relies on them too,
  // so this should never fire on SDK 58; if it does, add web-streams-polyfill.
  console.warn('[polyfills] web streams missing: chat streaming will fail');
}
