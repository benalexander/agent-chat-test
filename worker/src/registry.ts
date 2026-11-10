/**
 * Registry: a singleton Durable Object (idFromName('global')) listing every known
 * user for the admin panel. Two writers:
 *  - the Worker, on authorised app requests (`touch`: lastSeen + device timezone,
 *    throttled to one write a minute per user);
 *  - each CoachAgent, whenever its messages or campaign change (`pushSummary`).
 * Both upsert, so whichever arrives first creates the entry.
 */
import { DurableObject } from 'cloudflare:workers';
import type { RegistryEntry, UserSummary } from '@agent-chat/shared';

/** Skip a touch if lastSeen is fresher than this and the timezone is unchanged. */
export const TOUCH_THROTTLE_MS = 60_000;

interface Row {
  user_id: string;
  first_seen: number;
  last_seen: number;
  timezone: string | null;
  summary: string | null;
  [key: string]: SqlStorageValue;
}

function toEntry(r: Row): RegistryEntry {
  return {
    userId: r.user_id,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    timezone: r.timezone,
    summary: r.summary ? (JSON.parse(r.summary) as UserSummary) : null,
  };
}

export class Registry extends DurableObject<Cloudflare.Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS users (
         user_id TEXT PRIMARY KEY,
         first_seen INTEGER NOT NULL,
         last_seen INTEGER NOT NULL,
         timezone TEXT,
         summary TEXT
       )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS users_last_seen ON users (last_seen)`);
  }

  private row(userId: string): Row | undefined {
    return this.sql.exec<Row>(`SELECT * FROM users WHERE user_id = ?`, userId).toArray()[0];
  }

  /** App activity. Returns whether anything was written. */
  touch(userId: string, now: number, timezone: string | null): boolean {
    const r = this.row(userId);
    if (!r) {
      this.sql.exec(
        `INSERT INTO users (user_id, first_seen, last_seen, timezone, summary) VALUES (?, ?, ?, ?, NULL)`,
        userId,
        now,
        now,
        timezone,
      );
      return true;
    }
    const tzChanged = timezone !== null && timezone !== r.timezone;
    if (!tzChanged && now - r.last_seen < TOUCH_THROTTLE_MS) return false;
    this.sql.exec(
      `UPDATE users SET last_seen = MAX(last_seen, ?), timezone = ? WHERE user_id = ?`,
      now,
      timezone ?? r.timezone,
      userId,
    );
    return true;
  }

  /** Agent-side change. Creates the entry if missing; ignores out-of-order (older) summaries. */
  pushSummary(userId: string, summary: UserSummary): void {
    const r = this.row(userId);
    if (!r) {
      this.sql.exec(
        `INSERT INTO users (user_id, first_seen, last_seen, timezone, summary) VALUES (?, ?, ?, NULL, ?)`,
        userId,
        summary.updatedAt,
        summary.updatedAt,
        JSON.stringify(summary),
      );
      return;
    }
    const prev = r.summary ? (JSON.parse(r.summary) as UserSummary) : null;
    if (prev && prev.updatedAt > summary.updatedAt) return;
    this.sql.exec(`UPDATE users SET summary = ? WHERE user_id = ?`, JSON.stringify(summary), userId);
  }

  get(userId: string): RegistryEntry | null {
    const r = this.row(userId);
    return r ? toEntry(r) : null;
  }

  /** Newest lastSeen first. */
  list(): RegistryEntry[] {
    return this.sql.exec<Row>(`SELECT * FROM users ORDER BY last_seen DESC, user_id ASC`).toArray().map(toEntry);
  }

  remove(userId: string): boolean {
    const existed = !!this.row(userId);
    this.sql.exec(`DELETE FROM users WHERE user_id = ?`, userId);
    return existed;
  }
}

export function registryStub(env: Cloudflare.Env): DurableObjectStub<Registry> {
  return env.Registry.get(env.Registry.idFromName('global'));
}
