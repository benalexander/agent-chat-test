/**
 * Observability helpers.
 *
 * - `logEvent`: one structured log line per notable step. Workers Logs indexes the
 *   object's fields, so the dashboard (Workers → agent-chat-test → Observability) can
 *   filter by `evt`, `user`, `outcome` etc.; `wrangler tail` shows them live.
 * - `withSpan`: a custom tracing span (Workers traces, `observability.traces` in
 *   wrangler.jsonc) that nests under the request / alarm span alongside the AI SDK
 *   spans from `wrapAISDK` (see llm.ts).
 */
import { tracing } from 'cloudflare:workers';

type Fields = Record<string, string | number | boolean | null | undefined>;
type Attrs = Record<string, string | number | boolean | undefined>;

export type Evt =
  | 'request'
  | 'chat.start'
  | 'llm'
  | 'sync'
  | 'tick'
  | 'proactive'
  | 'push.send'
  | 'push.receipt'
  | 'push.token'
  | 'schedule';

export function logEvent(evt: Evt, fields: Fields = {}): void {
  const entry: Fields & { evt: Evt } = { evt };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) entry[k] = v;
  if (fields.level === 'error') console.error(entry);
  else console.log(entry);
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Runs `fn` inside a span named `name`. Exceptions are recorded on the span and
 * rethrown. Falls back to a plain call if tracing isn't available (e.g. tests).
 */
export async function withSpan<T>(name: string, attrs: Attrs, fn: (setAttrs: (a: Attrs) => void) => Promise<T>): Promise<T> {
  if (typeof tracing?.enterSpan !== 'function') return fn(() => {});
  return tracing.enterSpan(name, async (span) => {
    // Optional calls: local runtimes (wrangler dev / vitest) can hand back a partial no-op span.
    const set = (a: Attrs) => span?.setAttributes?.(a);
    set(attrs);
    try {
      const out = await fn(set);
      span?.setStatus?.({ code: 'ok' });
      return out;
    } catch (e) {
      span?.recordException?.({ name: e instanceof Error ? e.name : 'Error', message: errorText(e) });
      span?.setStatus?.({ code: 'error', message: errorText(e) });
      throw e;
    }
  });
}
