import { describe, it, expect } from 'vitest';
import {
  syncWindowStart,
  earliestRereadDay,
  isBeyondRereadReach,
  FIRST_SYNC_WINDOW_DAYS,
  REREAD_REACH_DAYS,
  ROUTINE_SYNC_OVERLAP_DAYS
} from '../syncWindow';

// Every date here is invented. The SHAPE is the Aug 2026 incident: a feed that
// died about a day after every reauthorization because each unattended sync
// asked for the full ninety days — a PSD2-protected resource readable only
// within ~5 minutes of authentication.

const NOW = new Date('2026-08-26T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysBefore = (from: Date, days: number): Date => new Date(from.getTime() - days * DAY_MS);

describe('syncWindowStart — the long window only while authentication is fresh', () => {
  it('asks for the full history when the connection has never synced', () => {
    // Moments after linking: SCA is fresh, and this is the one chance to
    // collect history at all.
    expect(syncWindowStart(null, NOW)).toEqual(daysBefore(NOW, FIRST_SYNC_WINDOW_DAYS));
    expect(syncWindowStart(undefined, NOW)).toEqual(daysBefore(NOW, FIRST_SYNC_WINDOW_DAYS));
  });

  it('asks only for what is new once it has synced before', () => {
    const lastSync = daysBefore(NOW, 1).toISOString();

    const start = syncWindowStart(lastSync, NOW);

    expect(start).toEqual(daysBefore(new Date(lastSync), ROUTINE_SYNC_OVERLAP_DAYS));
    // The point of the fix: a routine run must NOT reach the protected edge.
    expect(start.getTime()).toBeGreaterThan(daysBefore(NOW, FIRST_SYNC_WINDOW_DAYS).getTime());
  });

  it('overlaps its last success rather than resuming exactly at it', () => {
    // A card transaction can settle days later, and a bank can backdate a row.
    const lastSync = daysBefore(NOW, 3);

    const start = syncWindowStart(lastSync.toISOString(), NOW);

    // "Earlier than the last success" alone is satisfied by the ninety-day
    // window this fix removed, so it is not enough to assert — measured: that
    // form of the check passed against the bug. Pin the SIZE of the overlap.
    expect(start.getTime()).toBeLessThan(lastSync.getTime());
    expect(lastSync.getTime() - start.getTime()).toBe(ROUTINE_SYNC_OVERLAP_DAYS * DAY_MS);
  });

  it('never reaches further back than the long window, however stale', () => {
    // A connection dormant for a year must not quietly turn a routine sync
    // back into a protected-resource request and restart the whole cycle.
    const start = syncWindowStart(daysBefore(NOW, 365).toISOString(), NOW);

    expect(start).toEqual(daysBefore(NOW, FIRST_SYNC_WINDOW_DAYS));
  });

  it('treats an unreadable stored value as never synced rather than guessing', () => {
    expect(syncWindowStart('not a date', NOW)).toEqual(daysBefore(NOW, FIRST_SYNC_WINDOW_DAYS));
  });
});

describe('a re-read the owner asks for — as far as a bank serves, and no further', () => {
  // Owner, 13 Nov 2026: a payment the feed skipped six weeks earlier could not
  // be fetched, because nothing in the app asked further back than 30 days.
  it('reaches one day inside the long window, never the protected ninetieth day', () => {
    expect(REREAD_REACH_DAYS).toBe(FIRST_SYNC_WINDOW_DAYS - 1);
    expect(earliestRereadDay(NOW)).toBe('2026-05-29');
  });

  it('counts in whole UTC days, whatever the hour', () => {
    expect(earliestRereadDay(new Date('2026-08-26T00:00:01.000Z'))).toBe('2026-05-29');
    expect(earliestRereadDay(new Date('2026-08-26T23:59:59.000Z'))).toBe('2026-05-29');
  });

  it('the limit day itself is allowed; the day before it is refused', () => {
    expect(isBeyondRereadReach('2026-05-29', NOW)).toBe(false);
    expect(isBeyondRereadReach('2026-05-29T00:00:00.000Z', NOW)).toBe(false);
    expect(isBeyondRereadReach('2026-05-28', NOW)).toBe(true);
    expect(isBeyondRereadReach('2026-05-28T23:59:59.999Z', NOW)).toBe(true);
  });

  it('thirty days back, the old catch-up, is well inside it', () => {
    expect(isBeyondRereadReach(daysBefore(NOW, 30).toISOString(), NOW)).toBe(false);
  });
});
