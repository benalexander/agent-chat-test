/**
 * Sending a chat message:
 *   1. insert the user message locally as `pending` (id = clientMessageId)
 *   2. POST /chat and read the AI SDK UI message stream into an in-memory bubble
 *   3. when the stream ends (or drops), sync: the stored reply replaces the bubble
 *      and the user message becomes `sent`
 * If the user message still isn't confirmed after that, it's marked `failed`;
 * retrying re-POSTs with the same id, which the worker treats idempotently.
 */
import { parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema, type UIMessage, type UIMessageChunk } from 'ai';
import * as Crypto from 'expo-crypto';

import { postChat } from '../api/client';
import { getMessage, insertPendingUserMessage, setLocalStatus } from '../db/repo';
import { runSync } from '../sync/sync';
import { getStreaming, setStreaming } from './streaming';

/** Concatenated text parts (tool/reasoning parts are not shown). */
function textOf(message: UIMessage): string {
  return message.parts
    .filter((p): p is Extract<UIMessage['parts'][number], { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** SSE bytes → UIMessageChunk stream, as the SDK's own HTTP transport does it. */
function toChunkStream(body: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
  return parseJsonEventStream({ stream: body, schema: uiMessageChunkSchema }).pipeThrough(
    new TransformStream({
      transform(result, controller) {
        if (!result.success) throw result.error;
        controller.enqueue(result.value);
      },
    }),
  );
}

/**
 * The worker persists the reply as the stream finishes, which can land just
 * after our sync. Retry briefly so the stored reply replaces the bubble
 * without a visible gap (the Coach poll would catch it within 10 s anyway).
 */
async function syncUntilStored(assistantId: string | null): Promise<void> {
  const delays = [0, 400, 1200, 2500];
  for (const ms of delays) {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    const res = await runSync({ reason: 'chat' });
    if (!res.ok || !assistantId) return;
    const stored = await getMessage(assistantId);
    if (stored?.complete) return;
  }
}

let inFlight = false;

/** True while a send is streaming; the composer is disabled meanwhile (one thread, one reply at a time). */
export function isSending(): boolean {
  return inFlight;
}

export async function sendMessage(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || inFlight) return;
  const id = Crypto.randomUUID();
  await insertPendingUserMessage(id, trimmed);
  await deliver(id, trimmed);
}

/** Tap-to-retry on a failed message: same clientMessageId. */
export async function retryMessage(id: string): Promise<void> {
  if (inFlight) return;
  const msg = await getMessage(id);
  if (!msg || msg.role !== 'user' || msg.status === 'sent') return;
  await setLocalStatus(id, 'pending');
  await deliver(id, msg.text);
}

async function deliver(id: string, text: string): Promise<void> {
  inFlight = true;
  setStreaming({ userMessageId: id, assistantId: null, text: '' });
  try {
    const body = await postChat({ clientMessageId: id, text });
    const messages = readUIMessageStream<UIMessage>({
      stream: toChunkStream(body as ReadableStream<Uint8Array>),
      terminateOnError: true,
    });
    for await (const m of messages) {
      setStreaming({ userMessageId: id, assistantId: m.id || null, text: textOf(m) });
    }
  } catch (e) {
    // Network error or dropped stream. If the server got the message it will
    // finish the reply anyway; the sync below finds out.
    console.warn('[chat] stream error', e);
  } finally {
    try {
      await syncUntilStored(getStreaming()?.assistantId ?? null);
      const after = await getMessage(id);
      if (after && after.status !== 'sent') await setLocalStatus(id, 'failed');
    } finally {
      if (getStreaming()?.userMessageId === id) setStreaming(null);
      inFlight = false;
    }
  }
}
