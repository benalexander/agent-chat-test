/**
 * Our own SQLite tables inside the agent's Durable Object:
 *  - coach_kv: small JSON values (campaign, timezone, counters, timestamps)
 *  - coach_message_rev: sync cursor. `rev` is a global monotonic counter bumped on
 *    every insert AND update of a message (the SDK's internal `seq` is private and
 *    not bumped on updates). `hash` detects whether a persisted message changed.
 *  - coach_llm_log / coach_proactive_log / coach_push_log: debug logs, capped at LOG_CAP rows.
 */
import type { LlmLogEntry, ProactiveLogEntry, ProactiveTrigger, PushLogEntry } from '@agent-chat/shared';
import { LOG_CAP } from './config';

/** cyrb53 — fast non-crypto string hash; only used for change detection. */
export function hashString(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const REV_COUNTER_KEY = 'rev_counter';

export class CoachStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS coach_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS coach_message_rev (message_id TEXT PRIMARY KEY, rev INTEGER NOT NULL, hash TEXT NOT NULL)`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS coach_message_rev_rev ON coach_message_rev (rev)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS coach_llm_log (id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS coach_proactive_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, outcome TEXT NOT NULL, entry TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS coach_push_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT, entry TEXT NOT NULL)`);
  }

  // ---- kv --------------------------------------------------------------------

  get<T>(key: string): T | undefined {
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM coach_kv WHERE key = ?`, key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  set(key: string, value: unknown): void {
    this.sql.exec(
      `INSERT INTO coach_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      JSON.stringify(value),
    );
  }

  /** Clears everything except the rev counter (kept monotonic across resets). */
  clearKv(): void {
    this.sql.exec(`DELETE FROM coach_kv WHERE key != ?`, REV_COUNTER_KEY);
  }

  // ---- rev cursor ------------------------------------------------------------

  latestRev(): number {
    return this.get<number>(REV_COUNTER_KEY) ?? 0;
  }

  /**
   * Record the current content of a message. Bumps the global rev if the message is
   * new or its content hash changed. Returns the new rev, or null if unchanged.
   */
  touch(messageId: string, content: string): number | null {
    const hash = hashString(content);
    const row = this.sql
      .exec<{ hash: string }>(`SELECT hash FROM coach_message_rev WHERE message_id = ?`, messageId)
      .toArray()[0];
    if (row && row.hash === hash) return null;
    const rev = this.latestRev() + 1;
    this.set(REV_COUNTER_KEY, rev);
    this.sql.exec(
      `INSERT INTO coach_message_rev (message_id, rev, hash) VALUES (?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET rev = excluded.rev, hash = excluded.hash`,
      messageId,
      rev,
      hash,
    );
    return rev;
  }

  /** Message ids with rev > since, ascending by rev. */
  changedSince(since: number): { messageId: string; rev: number }[] {
    return this.sql
      .exec<{ message_id: string; rev: number }>(
        `SELECT message_id, rev FROM coach_message_rev WHERE rev > ? ORDER BY rev ASC`,
        since,
      )
      .toArray()
      .map((r) => ({ messageId: r.message_id, rev: r.rev }));
  }

  revOf(messageId: string): number | undefined {
    return this.sql
      .exec<{ rev: number }>(`SELECT rev FROM coach_message_rev WHERE message_id = ?`, messageId)
      .toArray()[0]?.rev;
  }

  clearRevs(): void {
    this.sql.exec(`DELETE FROM coach_message_rev`);
  }

  // ---- logs ------------------------------------------------------------------

  logLlm(entry: LlmLogEntry): void {
    this.sql.exec(`INSERT INTO coach_llm_log (entry) VALUES (?)`, JSON.stringify(entry));
    this.sql.exec(
      `DELETE FROM coach_llm_log WHERE id NOT IN (SELECT id FROM coach_llm_log ORDER BY id DESC LIMIT ?)`,
      LOG_CAP,
    );
  }

  logProactive(entry: ProactiveLogEntry): void {
    this.sql.exec(
      `INSERT INTO coach_proactive_log (at, outcome, entry) VALUES (?, ?, ?)`,
      entry.at,
      entry.outcome,
      JSON.stringify(entry),
    );
    this.sql.exec(
      `DELETE FROM coach_proactive_log WHERE id NOT IN (SELECT id FROM coach_proactive_log ORDER BY id DESC LIMIT ?)`,
      LOG_CAP,
    );
  }

  /** Newest first. */
  llmLog(): LlmLogEntry[] {
    return this.sql
      .exec<{ entry: string }>(`SELECT entry FROM coach_llm_log ORDER BY id DESC`)
      .toArray()
      .map((r) => JSON.parse(r.entry) as LlmLogEntry);
  }

  /** Newest first. */
  proactiveLog(): ProactiveLogEntry[] {
    return this.sql
      .exec<{ entry: string }>(`SELECT entry FROM coach_proactive_log ORDER BY id DESC`)
      .toArray()
      .map((r) => JSON.parse(r.entry) as ProactiveLogEntry);
  }

  /** Timestamps of proactive messages actually sent (for the daily caps), optionally for one trigger. */
  proactiveSentAt(trigger?: ProactiveTrigger): number[] {
    const rows = trigger
      ? this.sql.exec<{ at: number }>(
          `SELECT at FROM coach_proactive_log WHERE outcome = 'sent' AND json_extract(entry, '$.trigger') = ?`,
          trigger,
        )
      : this.sql.exec<{ at: number }>(`SELECT at FROM coach_proactive_log WHERE outcome = 'sent'`);
    return rows.toArray().map((r) => r.at);
  }

  logPush(entry: PushLogEntry): void {
    this.sql.exec(
      `INSERT INTO coach_push_log (ticket_id, entry) VALUES (?, ?)`,
      entry.ticketId ?? null,
      JSON.stringify(entry),
    );
    this.sql.exec(
      `DELETE FROM coach_push_log WHERE id NOT IN (SELECT id FROM coach_push_log ORDER BY id DESC LIMIT ?)`,
      LOG_CAP,
    );
  }

  /** Merge `patch` into the log entry for `ticketId` (no-op if it was pruned). */
  updatePush(ticketId: string, patch: Partial<PushLogEntry>): void {
    const row = this.sql
      .exec<{ id: number; entry: string }>(`SELECT id, entry FROM coach_push_log WHERE ticket_id = ?`, ticketId)
      .toArray()[0];
    if (!row) return;
    const entry = { ...(JSON.parse(row.entry) as PushLogEntry), ...patch };
    this.sql.exec(`UPDATE coach_push_log SET entry = ? WHERE id = ?`, JSON.stringify(entry), row.id);
  }

  /** Newest first. */
  pushLog(): PushLogEntry[] {
    return this.sql
      .exec<{ entry: string }>(`SELECT entry FROM coach_push_log ORDER BY id DESC`)
      .toArray()
      .map((r) => JSON.parse(r.entry) as PushLogEntry);
  }

  clearLogs(): void {
    this.sql.exec(`DELETE FROM coach_llm_log`);
    this.sql.exec(`DELETE FROM coach_proactive_log`);
    this.sql.exec(`DELETE FROM coach_push_log`);
  }
}
