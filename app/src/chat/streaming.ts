/**
 * In-memory state of the reply currently streaming in. Partial replies never
 * touch SQLite; once the stream ends a sync stores the server's final copy.
 */
import { emit } from '../lib/events';

export interface StreamingState {
  /** clientMessageId of the user message being answered. */
  userMessageId: string;
  /** Assistant message id from the stream's `start` chunk, once known. */
  assistantId: string | null;
  text: string;
}

let state: StreamingState | null = null;

export function getStreaming(): StreamingState | null {
  return state;
}

export function setStreaming(next: StreamingState | null): void {
  state = next;
  emit('streaming');
}
