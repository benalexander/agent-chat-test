/**
 * Pure proactive-messaging rules. No I/O, no Date.now() — everything is passed in
 * so it can be unit tested across timezones.
 */
import type { ProactiveTrigger } from '@agent-chat/shared';

export interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** YYYY-MM-DD in the given timezone. */
  dateKey: string;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-AU', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of `ms` in `timeZone` (IANA). */
export function localTime(ms: number, timeZone: string): LocalTime {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  // Some ICU versions render midnight as "24" even with h23.
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { year, month, day, hour, minute, dateKey: `${year}-${pad(month)}-${pad(day)}` };
}

/** Whole calendar days between two instants, measured in `timeZone`. */
export function localDaysBetween(fromMs: number, toMs: number, timeZone: string): number {
  const a = localTime(fromMs, timeZone);
  const b = localTime(toMs, timeZone);
  const da = Date.UTC(a.year, a.month - 1, a.day);
  const db = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((db - da) / 86_400_000);
}

/** Quiet hours wrap midnight when start > end (e.g. 21:00–08:00). */
export function isQuietHours(ms: number, timeZone: string, startHour: number, endHour: number): boolean {
  const { hour } = localTime(ms, timeZone);
  if (startHour === endHour) return false;
  return startHour > endHour ? hour >= startHour || hour < endHour : hour >= startHour && hour < endHour;
}

/** Number of timestamps that fall on the same local calendar day as `now`. */
export function countOnLocalDay(timestamps: number[], now: number, timeZone: string): number {
  const today = localTime(now, timeZone).dateKey;
  return timestamps.filter((t) => localTime(t, timeZone).dateKey === today).length;
}

export interface GuardrailRules {
  maxPerDay: number;
  /** Per-trigger daily caps (missing trigger = only maxPerDay applies). */
  maxPerDayByTrigger?: Partial<Record<ProactiveTrigger, number>>;
  quietStartHour: number;
  quietEndHour: number;
  cooldownMs: number;
}

export interface GuardrailInput {
  now: number;
  timeZone: string;
  /** createdAt of proactive messages actually sent (any day; filtered here). */
  sentAt: number[];
  lastUserMessageAt: number | null;
  /** Debug "force proactive now": bypass every rule. */
  force?: boolean;
  rules: GuardrailRules;
}

export type GuardrailDecision =
  | { allowed: true; reason?: 'forced' }
  | { allowed: false; reason: 'quiet_hours' | 'daily_cap' | 'cooldown' };

export function checkGuardrails(input: GuardrailInput): GuardrailDecision {
  const { now, timeZone, rules } = input;
  if (input.force) return { allowed: true, reason: 'forced' };
  if (isQuietHours(now, timeZone, rules.quietStartHour, rules.quietEndHour)) {
    return { allowed: false, reason: 'quiet_hours' };
  }
  if (countOnLocalDay(input.sentAt, now, timeZone) >= rules.maxPerDay) {
    return { allowed: false, reason: 'daily_cap' };
  }
  if (input.lastUserMessageAt != null && now - input.lastUserMessageAt < rules.cooldownMs) {
    return { allowed: false, reason: 'cooldown' };
  }
  return { allowed: true };
}

// ---- Trigger timing (also pure) ---------------------------------------------

/**
 * True if `trigger` has used up its per-day allowance (rules.maxPerDayByTrigger) on the
 * local day of `now`. Checked by the tick before an attempt, so a capped trigger is
 * skipped silently: no LLM call, no proactive-log row.
 */
export function triggerCapReached(
  trigger: ProactiveTrigger,
  triggerSentAt: number[],
  now: number,
  timeZone: string,
  rules: Pick<GuardrailRules, 'maxPerDayByTrigger'>,
): boolean {
  const cap = rules.maxPerDayByTrigger?.[trigger];
  return cap !== undefined && countOnLocalDay(triggerSentAt, now, timeZone) >= cap;
}

export interface InactivityInput {
  now: number;
  /** Latest of: last donation, last user message, campaign start. */
  lastActivityAt: number;
  /** When the inactivity trigger last fired (any outcome), or null. */
  lastInactivityAt: number | null;
  thresholdMs: number;
}

/** Fires once per `thresholdMs` of continued silence. */
export function inactivityDue(i: InactivityInput): boolean {
  if (i.now - i.lastActivityAt < i.thresholdMs) return false;
  if (i.lastInactivityAt == null || i.lastInactivityAt < i.lastActivityAt) return true;
  return i.now - i.lastInactivityAt >= i.thresholdMs;
}

export interface CheckinInput {
  now: number;
  timeZone: string;
  /** Last check-in attempt (any outcome), or campaign start. */
  lastCheckinAt: number;
  intervalMs: number;
  /** null = no time-of-day gate (dev mode). Otherwise local hour it must fire in. */
  atLocalHour: number | null;
}

export function checkinDue(c: CheckinInput): boolean {
  if (c.atLocalHour == null) return c.now - c.lastCheckinAt >= c.intervalMs;
  const { hour } = localTime(c.now, c.timeZone);
  if (hour !== c.atLocalHour) return false;
  const intervalDays = Math.max(1, Math.round(c.intervalMs / 86_400_000));
  return localDaysBetween(c.lastCheckinAt, c.now, c.timeZone) >= intervalDays;
}
