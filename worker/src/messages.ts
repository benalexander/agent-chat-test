import type { UIMessage } from 'ai';
import type { MessageMetadata, MessageOrigin, SyncMessage } from '@agent-chat/shared';

export type CoachUIMessage = UIMessage<Partial<MessageMetadata> & Record<string, unknown>>;

export function messageText(m: UIMessage): string {
  return m.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function metadataOf(m: UIMessage): Partial<MessageMetadata> {
  return (m.metadata ?? {}) as Partial<MessageMetadata>;
}

/**
 * Fill in server-side metadata for messages that lack it (createdAt, origin).
 * Never overwrites existing values, so createdAt stays "first persisted" time.
 */
export function withDefaultMetadata(m: UIMessage, now: number): UIMessage {
  const md = metadataOf(m);
  if (md.createdAt != null && md.origin != null) return m;
  const origin: MessageOrigin = md.origin ?? (m.role === 'user' ? 'user' : 'reply');
  return { ...m, metadata: { ...(m.metadata as object | undefined), origin, createdAt: md.createdAt ?? now } };
}

/** Content used for rev change detection: everything the client could observe. */
export function revContent(m: UIMessage): string {
  return JSON.stringify({ role: m.role, parts: m.parts, metadata: m.metadata ?? null });
}

export function toSyncMessage(m: UIMessage, rev: number): SyncMessage | null {
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  const md = metadataOf(m);
  return {
    id: m.id,
    rev,
    role: m.role,
    text: messageText(m),
    origin: md.origin ?? (m.role === 'user' ? 'user' : 'reply'),
    ...(md.trigger ? { trigger: md.trigger } : {}),
    createdAt: md.createdAt ?? 0,
    // AIChatAgent (0.12) writes an assistant message to storage only after its stream
    // has ended (see _reply), so anything visible to sync is complete. An in-flight
    // reply is simply absent from /messages until it finishes.
    complete: true,
  };
}
