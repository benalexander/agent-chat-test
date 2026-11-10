import { useLayoutEffect, useMemo, useRef } from 'react';
import type {
  AdminMessage,
  AdminMessagePart,
  AdminUserDetail,
  LlmLogEntry,
  ProactiveLogEntry,
} from '@agent-chat/shared';
import { fmtInt } from './format';
import { Time } from './hooks';

type Item =
  | { kind: 'message'; at: number; message: AdminMessage; llm: LlmLogEntry | null }
  | { kind: 'system'; at: number; entry: ProactiveLogEntry };

/** How far (ms) an LLM log entry may be from a message's createdAt to count as its turn. */
const MATCH_WINDOW_MS = 2 * 60_000;

/**
 * Best-effort pairing of assistant messages with LLM log entries (the log has no
 * message id). Chat replies take the nearest unused `chat` entry at/after the message's
 * createdAt (a few seconds of slack before, since createdAt and the log timestamp are
 * taken at different points of the turn); proactive messages take the nearest unused
 * `proactive` entry with the same trigger (outcome `sent` if recorded). Anything
 * outside MATCH_WINDOW_MS, or older than the capped log, simply shows no stats.
 */
function matchLlm(messages: AdminMessage[], log: LlmLogEntry[]): Map<string, LlmLogEntry> {
  const used = new Set<LlmLogEntry>();
  const out = new Map<string, LlmLogEntry>();
  for (const m of messages) {
    const meta = m.metadata;
    if (m.role !== 'assistant' || !meta) continue;
    let best: LlmLogEntry | null = null;
    let bestDist = Infinity;
    for (const e of log) {
      if (used.has(e)) continue;
      if (meta.origin === 'proactive') {
        if (e.kind !== 'proactive' || e.trigger !== meta.trigger) continue;
        if (e.outcome && e.outcome !== 'sent') continue;
      } else if (e.kind !== 'chat' || e.at < meta.createdAt - 5000) {
        continue;
      }
      const dist = Math.abs(e.at - meta.createdAt);
      if (dist <= MATCH_WINDOW_MS && dist < bestDist) {
        best = e;
        bestDist = dist;
      }
    }
    if (best) {
      used.add(best);
      out.set(m.id, best);
    }
  }
  return out;
}

function buildItems(detail: AdminUserDetail): Item[] {
  const llm = matchLlm(detail.messages, detail.state.llmLog);
  const items: Item[] = [];
  // Messages without metadata (pre-stamping) inherit the previous message's time so
  // they keep their thread position.
  let lastAt = 0;
  for (const m of detail.messages) {
    const at = m.metadata?.createdAt ?? lastAt;
    lastAt = at;
    items.push({ kind: 'message', at, message: m, llm: llm.get(m.id) ?? null });
  }
  for (const entry of detail.state.proactiveLog) {
    if (entry.outcome !== 'sent') items.push({ kind: 'system', at: entry.at, entry });
  }
  // Stable sort keeps thread order for equal timestamps.
  return items.sort((a, b) => a.at - b.at);
}

export function Transcript({ detail, tz }: { detail: AdminUserDetail; tz: string }) {
  const items = useMemo(() => buildItems(detail), [detail]);
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);

  const onScroll = () => {
    const el = scroller.current;
    if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Content signature: changes when messages are added or edited (rev bumps).
  const signature = `${items.length}:${detail.state.latestRev}`;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [signature]);

  return (
    <div className="panel transcript-panel">
      <div className="panel-head">
        <h2>Transcript</h2>
        <span className="muted small">
          {detail.messages.length} messages · rev {detail.state.latestRev}
        </span>
      </div>
      <div className="transcript" ref={scroller} onScroll={onScroll}>
        {items.length === 0 && <p className="muted pad">No messages yet.</p>}
        {items.map((item, i) =>
          item.kind === 'message' ? (
            <MessageRow key={item.message.id} item={item} tz={tz} />
          ) : (
            <SystemRow key={`sys-${item.at}-${i}`} entry={item.entry} tz={tz} />
          ),
        )}
      </div>
    </div>
  );
}

const OUTCOME_LABEL: Record<ProactiveLogEntry['outcome'], string> = {
  sent: 'sent',
  skipped_by_llm: 'skipped by LLM',
  blocked_by_guardrail: 'blocked by guardrail',
  error: 'failed',
};

function SystemRow({ entry, tz }: { entry: ProactiveLogEntry; tz: string }) {
  return (
    <div className={`system-row outcome-${entry.outcome}`}>
      <span>
        Proactive {entry.trigger} {OUTCOME_LABEL[entry.outcome]}
        {entry.reason ? `: ${entry.reason}` : ''}
      </span>
      <span className="small">
        <Time ms={entry.at} tz={tz} />
      </span>
    </div>
  );
}

function MessageRow({ item, tz }: { item: Extract<Item, { kind: 'message' }>; tz: string }) {
  const { message: m, llm } = item;
  const meta = m.metadata;
  return (
    <div className={`msg msg-${m.role}`}>
      <div className="msg-head">
        <strong>{m.role}</strong>
        {meta && <span className={`badge badge-${meta.origin}`}>{meta.origin}</span>}
        {meta?.trigger && <span className="badge badge-trigger">{meta.trigger}</span>}
        {!meta && <span className="badge">no metadata</span>}
        <span className="muted small">rev {m.rev}</span>
        <span className="spacer" />
        {llm && (
          <span className="muted small mono" title={`LLM log entry at ${new Date(llm.at).toISOString()} (best-effort match)`}>
            {fmtInt(llm.inputTokens)} in / {fmtInt(llm.outputTokens)} out · {fmtInt(llm.latencyMs)} ms · {llm.model}
          </span>
        )}
        <span className="muted small">
          <Time ms={meta?.createdAt} tz={tz} />
        </span>
      </div>
      <div className="msg-body">
        {m.parts.map((p, i) => (
          <Part key={i} part={p} />
        ))}
      </div>
    </div>
  );
}

function json(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? 'undefined';
  } catch {
    return String(v);
  }
}

function Part({ part }: { part: AdminMessagePart }) {
  if (part.type === 'step-start') return null;
  if (part.type === 'text') return <div className="part-text">{String(part.text ?? '')}</div>;
  if (part.type === 'reasoning') {
    return (
      <details className="part-collapsible">
        <summary>reasoning</summary>
        <div className="part-text muted">{String(part.text ?? '')}</div>
      </details>
    );
  }
  if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
    const name = part.type === 'dynamic-tool' ? String(part.toolName ?? 'dynamic-tool') : part.type.slice(5);
    return (
      <details className="part-collapsible">
        <summary>
          tool <strong className="mono">{name}</strong> <span className="muted">({String(part.state ?? '?')})</span>
          {part.errorText != null && <span className="error-inline"> error</span>}
        </summary>
        <div className="kv">
          <div className="muted small">input</div>
          <pre>{json(part.input)}</pre>
          {'output' in part && (
            <>
              <div className="muted small">output</div>
              <pre>{json(part.output)}</pre>
            </>
          )}
          {part.errorText != null && (
            <>
              <div className="muted small">error</div>
              <pre className="error">{String(part.errorText)}</pre>
            </>
          )}
        </div>
      </details>
    );
  }
  return (
    <details className="part-collapsible">
      <summary className="mono">{part.type}</summary>
      <pre>{json(part)}</pre>
    </details>
  );
}
