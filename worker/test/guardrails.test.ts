import { describe, expect, it } from 'vitest';
import {
  checkGuardrails,
  checkinDue,
  countOnLocalDay,
  inactivityDue,
  isQuietHours,
  localTime,
  triggerCapReached,
  type GuardrailInput,
} from '../src/guardrails';
import { getTimings } from '../src/config';

// Prod quiet hours (21:00–08:00) and 10-min cooldown, with the cap pinned at 2/day so the
// tests don't depend on the tunable trial value.
const rules = { ...getTimings(false), maxPerDay: 2 };
const MIN = 60_000;
const HOUR = 60 * MIN;

/** 2026-11-10 03:00Z = 14:00 in Melbourne (AEDT, UTC+11), 03:00 in London, 22:00 (prev day) in New York. */
const T = Date.UTC(2026, 10, 10, 3, 0);

function input(over: Partial<GuardrailInput> = {}): GuardrailInput {
  return { now: T, timeZone: 'Australia/Melbourne', sentAt: [], lastUserMessageAt: null, rules, ...over };
}

describe('localTime', () => {
  it('computes wall-clock time per timezone', () => {
    expect(localTime(T, 'Australia/Melbourne')).toMatchObject({ hour: 14, dateKey: '2026-11-10' });
    expect(localTime(T, 'Europe/London')).toMatchObject({ hour: 3, dateKey: '2026-11-10' });
    expect(localTime(T, 'America/New_York')).toMatchObject({ hour: 22, dateKey: '2026-11-09' });
    expect(localTime(Date.UTC(2026, 10, 10, 13, 0), 'Australia/Melbourne')).toMatchObject({ hour: 0 });
  });
});

describe('quiet hours (21:00–08:00 device-local)', () => {
  it('depends on the device timezone for the same instant', () => {
    expect(isQuietHours(T, 'Australia/Melbourne', 21, 8)).toBe(false); // 14:00
    expect(isQuietHours(T, 'Europe/London', 21, 8)).toBe(true); // 03:00
    expect(isQuietHours(T, 'America/New_York', 21, 8)).toBe(true); // 22:00
    expect(isQuietHours(T, 'Asia/Tokyo', 21, 8)).toBe(false); // 12:00
  });

  it('boundaries: 21:00 is quiet, 08:00 is not, 20:59 is not', () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 10, 10, h, m); // UTC tz for clarity
    expect(isQuietHours(at(21), 'UTC', 21, 8)).toBe(true);
    expect(isQuietHours(at(20, 59), 'UTC', 21, 8)).toBe(false);
    expect(isQuietHours(at(7, 59), 'UTC', 21, 8)).toBe(true);
    expect(isQuietHours(at(8), 'UTC', 21, 8)).toBe(false);
    expect(isQuietHours(at(0), 'UTC', 21, 8)).toBe(true);
  });

  it('blocks proactive messages', () => {
    expect(checkGuardrails(input({ timeZone: 'Europe/London' }))).toEqual({ allowed: false, reason: 'quiet_hours' });
    expect(checkGuardrails(input())).toEqual({ allowed: true });
  });
});

describe('per-trigger daily cap', () => {
  const capped = { maxPerDayByTrigger: { checkin: 2, inactivity: 1 } };
  const reached = (trigger: 'checkin' | 'inactivity' | 'donation', sent: number[]) =>
    triggerCapReached(trigger, sent, T, 'Australia/Melbourne', capped);

  it('caps check-ins at 2 and inactivity at 1 per local day', () => {
    expect(reached('checkin', [T - HOUR])).toBe(false);
    expect(reached('checkin', [T - 2 * HOUR, T - HOUR])).toBe(true);
    expect(reached('inactivity', [])).toBe(false);
    expect(reached('inactivity', [T - HOUR])).toBe(true);
  });

  it('resets on the next local day and leaves uncapped triggers alone', () => {
    expect(reached('inactivity', [T - 28 * HOUR])).toBe(false);
    expect(reached('donation', [T - 2 * HOUR, T - HOUR, T - MIN])).toBe(false);
  });

  it('trial timings cap check-ins at 2 and inactivity at 1', () => {
    expect(getTimings(false).maxPerDayByTrigger).toEqual({ checkin: 2, inactivity: 1 });
  });
});

describe('daily cap (2/day, device-local day)', () => {
  it('allows up to 2 sends per local day', () => {
    expect(checkGuardrails(input({ sentAt: [T - HOUR] }))).toEqual({ allowed: true });
    expect(checkGuardrails(input({ sentAt: [T - 2 * HOUR, T - HOUR] }))).toEqual({
      allowed: false,
      reason: 'daily_cap',
    });
  });

  it('counts by local calendar day, not a rolling 24h', () => {
    // 09:00 and 10:00 Melbourne on the previous local day — 28h/29h ago.
    const yesterday = [T - 29 * HOUR, T - 28 * HOUR];
    expect(countOnLocalDay(yesterday, T, 'Australia/Melbourne')).toBe(0);
    expect(checkGuardrails(input({ sentAt: yesterday }))).toEqual({ allowed: true });
    // Two sends 13h ago: 01:00 Melbourne today (same day) but 14:00 prev day in UTC.
    const early = [T - 13 * HOUR, T - 13 * HOUR + MIN];
    expect(countOnLocalDay(early, T, 'Australia/Melbourne')).toBe(2);
    expect(countOnLocalDay(early, T, 'UTC')).toBe(0);
  });
});

describe('cooldown (10 min after last user message)', () => {
  it('blocks within the cooldown and allows after', () => {
    expect(checkGuardrails(input({ lastUserMessageAt: T - 9 * MIN }))).toEqual({ allowed: false, reason: 'cooldown' });
    expect(checkGuardrails(input({ lastUserMessageAt: T - 10 * MIN }))).toEqual({ allowed: true });
  });

  it('dev mode compresses cooldown to 30s', () => {
    const dev = getTimings(true);
    expect(checkGuardrails(input({ rules: dev, lastUserMessageAt: T - 29_000 })).allowed).toBe(false);
    expect(checkGuardrails(input({ rules: dev, lastUserMessageAt: T - 31_000 })).allowed).toBe(true);
  });
});

describe('force bypass', () => {
  it('bypasses quiet hours, cap and cooldown', () => {
    const blocked = input({
      timeZone: 'Europe/London',
      sentAt: [T - MIN, T - 2 * MIN, T - 3 * MIN],
      lastUserMessageAt: T - 1000,
    });
    expect(checkGuardrails(blocked).allowed).toBe(false);
    expect(checkGuardrails({ ...blocked, force: true })).toEqual({ allowed: true, reason: 'forced' });
  });
});

describe('trigger timing', () => {
  const DAY = 24 * HOUR;
  it('inactivity fires after the threshold, once per silent period', () => {
    const base = { now: T, thresholdMs: 4 * DAY };
    expect(inactivityDue({ ...base, lastActivityAt: T - 3 * DAY, lastInactivityAt: null })).toBe(false);
    expect(inactivityDue({ ...base, lastActivityAt: T - 4 * DAY, lastInactivityAt: null })).toBe(true);
    expect(inactivityDue({ ...base, lastActivityAt: T - 5 * DAY, lastInactivityAt: T - DAY })).toBe(false);
    expect(inactivityDue({ ...base, lastActivityAt: T - 9 * DAY, lastInactivityAt: T - 5 * DAY })).toBe(true);
  });

  it('check-in: every 3 local days, only during the 18:00 hour', () => {
    const tz = 'Australia/Melbourne';
    const at18 = Date.UTC(2026, 10, 10, 7, 15); // 18:15 AEDT
    const base = { timeZone: tz, intervalMs: 3 * DAY, atLocalHour: 18 };
    expect(checkinDue({ ...base, now: at18, lastCheckinAt: at18 - 3 * DAY })).toBe(true);
    expect(checkinDue({ ...base, now: at18, lastCheckinAt: at18 - 2 * DAY })).toBe(false);
    expect(checkinDue({ ...base, now: at18 + 3 * HOUR, lastCheckinAt: at18 - 3 * DAY })).toBe(false);
    // dev: no hour gate, plain interval
    expect(checkinDue({ ...base, atLocalHour: null, intervalMs: 3 * MIN, now: T, lastCheckinAt: T - 3 * MIN })).toBe(true);
  });
});
