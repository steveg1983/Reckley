import { describe, it, expect } from 'vitest';
import {
  describeBudgetRepeat,
  getBudgetPeriodLabel,
  getBudgetPeriodWindow,
  normaliseBudgetPeriod,
  resolveBudgetAnchor,
  resolveBudgetRepeat
} from './budgetPeriods';

/** Local date, written the way the windows are built. */
const at = (year: number, month: number, day: number, hour = 12): Date =>
  new Date(year, month, day, hour, 0, 0, 0);

/** "2026-08-01 00:00:00.000" — readable enough to assert a boundary on. */
const stamp = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ` +
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:` +
  `${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;

describe('normaliseBudgetPeriod', () => {
  it('reads every period the app writes', () => {
    expect(normaliseBudgetPeriod('weekly')).toBe('weekly');
    expect(normaliseBudgetPeriod('quarterly')).toBe('quarterly');
    expect(normaliseBudgetPeriod('yearly')).toBe('yearly');
    expect(normaliseBudgetPeriod('custom')).toBe('custom');
  });

  it('accepts the spellings other parts of the app use for a fortnight', () => {
    expect(normaliseBudgetPeriod('biweekly')).toBe('biweekly');
    expect(normaliseBudgetPeriod('bi-weekly')).toBe('biweekly');
    expect(normaliseBudgetPeriod('Fortnightly')).toBe('biweekly');
  });

  // The old fallback was YEARLY, which is exactly how a week's allowance came
  // to be compared against a year of spending.
  it('falls back to monthly, never to yearly', () => {
    expect(normaliseBudgetPeriod(undefined)).toBe('monthly');
    expect(normaliseBudgetPeriod('')).toBe('monthly');
    expect(normaliseBudgetPeriod('per sennight')).toBe('monthly');
  });
});

describe('getBudgetPeriodLabel', () => {
  it('captions each period as itself', () => {
    expect(getBudgetPeriodLabel('monthly')).toBe('Monthly');
    expect(getBudgetPeriodLabel('weekly')).toBe('Weekly');
    expect(getBudgetPeriodLabel('biweekly')).toBe('Fortnightly');
    expect(getBudgetPeriodLabel('quarterly')).toBe('Quarterly');
    expect(getBudgetPeriodLabel('yearly')).toBe('Yearly');
    expect(getBudgetPeriodLabel('custom')).toBe('One-off');
  });
});

describe('getBudgetPeriodWindow', () => {
  it('measures a monthly budget over the calendar month, to the last millisecond', () => {
    const window = getBudgetPeriodWindow({ period: 'monthly' }, at(2026, 7, 15));

    expect(stamp(window.start)).toBe('2026-08-01 00:00:00.000');
    // The old end was local midnight of the 31st, which dropped the whole of
    // the last day for any row timestamped after it.
    expect(stamp(window.end)).toBe('2026-08-31 23:59:59.999');
    expect(window.label).toBe('Monthly');
  });

  it('measures a weekly budget over the current week', () => {
    // Wednesday 12 August 2026.
    const window = getBudgetPeriodWindow({ period: 'weekly' }, at(2026, 7, 12));

    expect(stamp(window.start)).toBe('2026-08-09 00:00:00.000');
    expect(stamp(window.end)).toBe('2026-08-15 23:59:59.999');
    expect(window.label).toBe('Weekly');
  });

  it('measures a quarterly budget over the calendar quarter', () => {
    const window = getBudgetPeriodWindow({ period: 'quarterly' }, at(2026, 7, 15));

    expect(stamp(window.start)).toBe('2026-07-01 00:00:00.000');
    expect(stamp(window.end)).toBe('2026-09-30 23:59:59.999');
    expect(window.label).toBe('Quarterly');
  });

  it('measures a yearly budget over the calendar year', () => {
    const window = getBudgetPeriodWindow({ period: 'yearly' }, at(2026, 7, 15));

    expect(stamp(window.start)).toBe('2026-01-01 00:00:00.000');
    expect(stamp(window.end)).toBe('2026-12-31 23:59:59.999');
  });

  describe('fortnightly', () => {
    it('counts fortnights from the budget’s own start date', () => {
      // 15 August is 28 days (two whole fortnights) after 18 July.
      const window = getBudgetPeriodWindow(
        { period: 'biweekly', startDate: '2026-07-18' },
        at(2026, 7, 15)
      );

      expect(stamp(window.start)).toBe('2026-08-15 00:00:00.000');
      expect(stamp(window.end)).toBe('2026-08-28 23:59:59.999');
      expect(window.label).toBe('Fortnightly');
    });

    it('falls back to the day the budget was created', () => {
      const window = getBudgetPeriodWindow(
        { period: 'biweekly', createdAt: new Date(2026, 6, 18) },
        at(2026, 7, 14)
      );

      expect(stamp(window.start)).toBe('2026-08-01 00:00:00.000');
      expect(stamp(window.end)).toBe('2026-08-14 23:59:59.999');
    });

    it('gives a budget that has not started yet its FIRST fortnight', () => {
      const window = getBudgetPeriodWindow(
        { period: 'biweekly', startDate: '2026-09-01' },
        at(2026, 7, 15)
      );

      expect(stamp(window.start)).toBe('2026-09-01 00:00:00.000');
      expect(stamp(window.end)).toBe('2026-09-14 23:59:59.999');
    });
  });

  describe('custom', () => {
    it('uses the stored start and end dates', () => {
      const window = getBudgetPeriodWindow(
        { period: 'custom', startDate: '2026-04-06', endDate: '2027-04-05' },
        at(2026, 7, 15)
      );

      expect(stamp(window.start)).toBe('2026-04-06 00:00:00.000');
      expect(stamp(window.end)).toBe('2027-04-05 23:59:59.999');
      expect(window.label).toBe('One-off');
    });

    it('runs an open-ended custom period up to now', () => {
      const window = getBudgetPeriodWindow(
        { period: 'custom', startDate: '2026-04-06' },
        at(2026, 7, 15)
      );

      expect(stamp(window.start)).toBe('2026-04-06 00:00:00.000');
      expect(stamp(window.end)).toBe('2026-08-15 23:59:59.999');
    });

    it('falls back to the current month when the dates are missing, still captioned One-off', () => {
      const window = getBudgetPeriodWindow({ period: 'custom' }, at(2026, 7, 15));

      expect(stamp(window.start)).toBe('2026-08-01 00:00:00.000');
      expect(stamp(window.end)).toBe('2026-08-31 23:59:59.999');
      expect(window.label).toBe('One-off');
    });

    it('ignores an unreadable stored date rather than filing the budget in 1970', () => {
      const window = getBudgetPeriodWindow(
        { period: 'custom', startDate: 'not a date' },
        at(2026, 7, 15)
      );

      expect(stamp(window.start)).toBe('2026-08-01 00:00:00.000');
    });
  });
});

/**
 * THE CYCLE MODEL (5 Nov 2026). A repeating budget is measured over the cycle
 * containing now, counted from its own start — see the module header for why
 * a yearly budget written on 29 October must not be measured against January.
 */
describe('getBudgetPeriodWindow — anchored on the budget’s start', () => {
  /** A row written after the model shipped: its start is its anchor, whatever day it was created. */
  const written = (over: Record<string, unknown>) => ({ createdAt: new Date(2026, 10, 10), ...over });

  it('a yearly budget runs twelve months from its start, not the calendar year', () => {
    const window = getBudgetPeriodWindow(written({ period: 'yearly', startDate: '2026-11-01' }), at(2027, 7, 15));
    expect(stamp(window.start)).toBe('2026-11-01 00:00:00.000');
    expect(stamp(window.end)).toBe('2027-10-31 23:59:59.999');
    expect(window.label).toBe('Yearly');
    expect(window.notStarted).toBe(false);
    expect(window.ended).toBe(false);
  });

  it('…and starts again the day the year is up', () => {
    const window = getBudgetPeriodWindow(written({ period: 'yearly', startDate: '2026-11-01' }), at(2027, 10, 1));
    expect(stamp(window.start)).toBe('2027-11-01 00:00:00.000');
    expect(stamp(window.end)).toBe('2028-10-31 23:59:59.999');
  });

  it('a tax-year budgeter anchors on 6 April and gets 6 April to 5 April, no special case', () => {
    const budget = written({ period: 'yearly', startDate: '2026-04-06' });
    const lastDay = getBudgetPeriodWindow(budget, at(2027, 3, 5));
    expect(stamp(lastDay.start)).toBe('2026-04-06 00:00:00.000');
    expect(stamp(lastDay.end)).toBe('2027-04-05 23:59:59.999');
    const firstDay = getBudgetPeriodWindow(budget, at(2027, 3, 6));
    expect(stamp(firstDay.start)).toBe('2027-04-06 00:00:00.000');
  });

  it('a monthly budget from the 15th runs 15th to 14th (the owner, for people paid mid-month)', () => {
    const budget = written({ period: 'monthly', startDate: '2027-01-15' });
    const early = getBudgetPeriodWindow(budget, at(2027, 1, 10));
    expect(stamp(early.start)).toBe('2027-01-15 00:00:00.000');
    expect(stamp(early.end)).toBe('2027-02-14 23:59:59.999');
    const late = getBudgetPeriodWindow(budget, at(2027, 1, 20));
    expect(stamp(late.start)).toBe('2027-02-15 00:00:00.000');
    expect(stamp(late.end)).toBe('2027-03-14 23:59:59.999');
  });

  it('a monthly budget from the 1st is the calendar month, exactly as before', () => {
    const window = getBudgetPeriodWindow(written({ period: 'monthly', startDate: '2026-11-01' }), at(2027, 1, 10));
    expect(stamp(window.start)).toBe('2027-02-01 00:00:00.000');
    expect(stamp(window.end)).toBe('2027-02-28 23:59:59.999');
  });

  it('an anchor on the 31st is clamped to the month it lands in, never carried into the next', () => {
    const budget = written({ period: 'monthly', startDate: '2027-01-31' });
    const feb = getBudgetPeriodWindow(budget, at(2027, 1, 28));
    expect(stamp(feb.start)).toBe('2027-02-28 00:00:00.000');
    expect(stamp(feb.end)).toBe('2027-03-30 23:59:59.999');
    const stillJan = getBudgetPeriodWindow(budget, at(2027, 1, 27));
    expect(stamp(stillJan.start)).toBe('2027-01-31 00:00:00.000');
    expect(stamp(stillJan.end)).toBe('2027-02-27 23:59:59.999');
  });

  it('a quarterly budget counts three months from its start', () => {
    const window = getBudgetPeriodWindow(written({ period: 'quarterly', startDate: '2026-11-01' }), at(2027, 0, 15));
    expect(stamp(window.start)).toBe('2026-11-01 00:00:00.000');
    expect(stamp(window.end)).toBe('2027-01-31 23:59:59.999');
    expect(window.label).toBe('Quarterly');
  });

  it('a budget that has not started yet shows its FIRST cycle and says so', () => {
    const window = getBudgetPeriodWindow(written({ period: 'yearly', startDate: '2027-04-06' }), at(2026, 10, 15));
    expect(stamp(window.start)).toBe('2027-04-06 00:00:00.000');
    expect(stamp(window.end)).toBe('2028-04-05 23:59:59.999');
    expect(window.notStarted).toBe(true);
    expect(window.ended).toBe(false);
  });

  it('an end date cuts the current cycle short', () => {
    const window = getBudgetPeriodWindow(
      written({ period: 'yearly', startDate: '2026-11-01', endDate: '2027-06-30' }),
      at(2027, 2, 15)
    );
    expect(stamp(window.start)).toBe('2026-11-01 00:00:00.000');
    expect(stamp(window.end)).toBe('2027-06-30 23:59:59.999');
    expect(window.ended).toBe(false);
  });

  it('past its end date a budget shows its LAST cycle, finished, rather than a new one', () => {
    const window = getBudgetPeriodWindow(
      written({ period: 'yearly', startDate: '2026-11-01', endDate: '2027-06-30' }),
      at(2027, 7, 15)
    );
    expect(stamp(window.start)).toBe('2026-11-01 00:00:00.000');
    expect(stamp(window.end)).toBe('2027-06-30 23:59:59.999');
    expect(window.ended).toBe(true);
  });
});

/**
 * LEGACY ROWS KEEP THE CALENDAR. Before 5 Nov 2026 nothing collected a start
 * date and the service filled it with the creation day; reading that as an
 * anchor would move every existing budget on deploy day. Measured before
 * shipping: every stored row was one of the two shapes pinned here.
 */
describe('getBudgetPeriodWindow — rows written before the cycle model', () => {
  it('a yearly budget whose start is its creation day keeps the calendar year (the 29 Oct rows)', () => {
    const window = getBudgetPeriodWindow(
      { period: 'yearly', startDate: '2026-10-29', createdAt: '2026-10-29T18:03:11.000Z' },
      at(2026, 10, 15)
    );
    expect(stamp(window.start)).toBe('2026-01-01 00:00:00.000');
    expect(stamp(window.end)).toBe('2026-12-31 23:59:59.999');
    expect(resolveBudgetAnchor({ startDate: '2026-10-29', createdAt: '2026-10-29T18:03:11.000Z' })).toBeNull();
  });

  it('…judged by the creation day in UTC as well as local time, which is the day the old default wrote', () => {
    // Created 23:30 UTC on the 29th, which is already the 30th in a zone ahead
    // of UTC; the service wrote the UTC day. Either match means "unchosen".
    expect(resolveBudgetAnchor({ startDate: '2026-10-29', createdAt: '2026-10-29T23:30:00.000Z' })).toBeNull();
  });

  it('a monthly budget of the same shape keeps the calendar month', () => {
    const window = getBudgetPeriodWindow(
      { period: 'monthly', startDate: '2026-08-29', createdAt: '2026-08-29T09:00:00.000Z' },
      at(2026, 10, 15)
    );
    expect(stamp(window.start)).toBe('2026-11-01 00:00:00.000');
    expect(stamp(window.end)).toBe('2026-11-30 23:59:59.999');
  });

  it('a legacy row whose start is NOT its creation day was chosen, and is the anchor (the seeder’s 1 January)', () => {
    const window = getBudgetPeriodWindow(
      { period: 'yearly', startDate: '2026-01-01', createdAt: '2026-08-29T09:00:00.000Z' },
      at(2026, 10, 15)
    );
    expect(stamp(window.start)).toBe('2026-01-01 00:00:00.000');
    expect(stamp(window.end)).toBe('2026-12-31 23:59:59.999');
    expect(resolveBudgetAnchor({ startDate: '2026-01-01', createdAt: '2026-08-29T09:00:00.000Z' })).toBe('2026-01-01');
  });

  it('a legacy row re-dated by the wizard gains its anchor', () => {
    const window = getBudgetPeriodWindow(
      { period: 'yearly', startDate: '2026-11-01', createdAt: '2026-10-29T18:03:11.000Z' },
      at(2027, 7, 15)
    );
    expect(stamp(window.start)).toBe('2026-11-01 00:00:00.000');
    expect(stamp(window.end)).toBe('2027-10-31 23:59:59.999');
  });

  it('a row written on or after the ship day is anchored on its start even when that is its creation day', () => {
    expect(resolveBudgetAnchor({ startDate: '2026-11-06', createdAt: '2026-11-06T10:00:00.000Z' })).toBe('2026-11-06');
  });

  it('a row with no creation stamp takes its start at face value', () => {
    expect(resolveBudgetAnchor({ startDate: '2026-07-01' })).toBe('2026-07-01');
  });

  it('a row with no start has no anchor, whenever it was written', () => {
    expect(resolveBudgetAnchor({ createdAt: '2026-11-10T10:00:00.000Z' })).toBeNull();
    expect(resolveBudgetAnchor({ startDate: 'not a date', createdAt: '2026-11-10T10:00:00.000Z' })).toBeNull();
  });
});

/**
 * AN END DATE IS HONOURED BY EVERY PERIOD (5 Nov 2026). The month-stepped
 * cycles honoured one from the day the model shipped; the week, the fortnight
 * and the legacy calendar did not, so a weekly budget "until the end of June"
 * would have gone on measuring week after week. One function bounds them all.
 */
describe('getBudgetPeriodWindow — an end date is honoured by every period', () => {
  // 1 November 2026 is a Sunday, so the Sunday weeks are 1–7, 8–14, 15–21 Nov.

  it('a weekly budget is cut short at its end date', () => {
    const window = getBudgetPeriodWindow({ period: 'weekly', endDate: '2026-11-11' }, at(2026, 10, 10));
    expect(stamp(window.start)).toBe('2026-11-08 00:00:00.000');
    expect(stamp(window.end)).toBe('2026-11-11 23:59:59.999');
    expect(window.ended).toBe(false);
  });

  it('…and past it shows the week the end fell in, finished', () => {
    const window = getBudgetPeriodWindow({ period: 'weekly', endDate: '2026-11-11' }, at(2026, 10, 20));
    expect(stamp(window.start)).toBe('2026-11-08 00:00:00.000');
    expect(stamp(window.end)).toBe('2026-11-11 23:59:59.999');
    expect(window.ended).toBe(true);
  });

  it('a fortnightly budget past its end shows the fortnight the end fell in, finished', () => {
    const window = getBudgetPeriodWindow(
      { period: 'biweekly', startDate: '2026-11-01', endDate: '2026-11-20' },
      at(2026, 11, 1)
    );
    expect(stamp(window.start)).toBe('2026-11-15 00:00:00.000');
    expect(stamp(window.end)).toBe('2026-11-20 23:59:59.999');
    expect(window.ended).toBe(true);
  });

  it('a legacy row that keeps the calendar still stops at its end date', () => {
    // Start = creation day, created before the model: no anchor, calendar
    // months — and an end date given later still finishes it.
    const window = getBudgetPeriodWindow(
      { period: 'monthly', startDate: '2024-01-01', endDate: '2024-06-30', createdAt: '2024-01-01T09:00:00.000Z' },
      at(2025, 0, 1)
    );
    expect(stamp(window.start)).toBe('2024-06-01 00:00:00.000');
    expect(stamp(window.end)).toBe('2024-06-30 23:59:59.999');
    expect(window.ended).toBe(true);
  });

  it('an end date before the start is no end at all, not a budget that finished before it began', () => {
    const window = getBudgetPeriodWindow(
      { period: 'monthly', startDate: '2026-11-01', endDate: '2026-10-01', createdAt: new Date(2026, 10, 10) },
      at(2026, 10, 10)
    );
    expect(stamp(window.start)).toBe('2026-11-01 00:00:00.000');
    expect(stamp(window.end)).toBe('2026-11-30 23:59:59.999');
    expect(window.ended).toBe(false);
    expect(window.notStarted).toBe(false);
  });

  /**
   * ANY REPEAT INTERVAL (7 Nov 2026). `every` is the fortnight's and the
   * month-stepped rule with the user's own N, captioned by the interval.
   */
  describe('every — an interval of the user’s own', () => {
    it('every 2 months steps two months from the start, and is captioned by the interval', () => {
      const window = getBudgetPeriodWindow(
        { period: 'every', repeatCount: 2, repeatUnit: 'month', startDate: '2026-11-01', createdAt: new Date(2026, 10, 7) },
        at(2027, 0, 15)
      );
      expect(window.label).toBe('Every 2 months');
      expect(window.period).toBe('every');
      expect(stamp(window.start)).toBe('2027-01-01 00:00:00.000');
      expect(stamp(window.end)).toBe('2027-02-28 23:59:59.999');
    });

    it('every 6 weeks steps forty-two days from the start', () => {
      const window = getBudgetPeriodWindow(
        { period: 'every', repeatCount: 6, repeatUnit: 'week', startDate: '2026-11-01', createdAt: new Date(2026, 10, 7) },
        at(2026, 11, 20)
      );
      expect(window.label).toBe('Every 6 weeks');
      expect(stamp(window.start)).toBe('2026-12-13 00:00:00.000');
      expect(stamp(window.end)).toBe('2027-01-23 23:59:59.999');
    });

    it('before its start it is the first interval, not yet begun; an end date still cuts it', () => {
      const window = getBudgetPeriodWindow(
        { period: 'every', repeatCount: 3, repeatUnit: 'week', startDate: '2026-12-01', endDate: '2026-12-10' },
        at(2026, 10, 20)
      );
      expect(window.notStarted).toBe(true);
      expect(stamp(window.start)).toBe('2026-12-01 00:00:00.000');
      expect(stamp(window.end)).toBe('2026-12-10 23:59:59.999');
    });

    it('a count of one is said as the unit alone', () => {
      expect(describeBudgetRepeat({ count: 1, unit: 'week' })).toBe('Every week');
      expect(getBudgetPeriodLabel('every', { repeatCount: 1, repeatUnit: 'month' })).toBe('Every month');
      expect(getBudgetPeriodLabel('every', { repeatCount: 4, repeatUnit: 'week' })).toBe('Every 4 weeks');
    });

    it('an unsound pair is read as every month, which the caption says', () => {
      expect(resolveBudgetRepeat({ repeatCount: 0, repeatUnit: 'month' })).toBeNull();
      expect(resolveBudgetRepeat({ repeatCount: 1.5, repeatUnit: 'month' })).toBeNull();
      expect(resolveBudgetRepeat({ repeatCount: 2, repeatUnit: 'day' })).toBeNull();
      expect(resolveBudgetRepeat({ repeatCount: 2, repeatUnit: 'month' })).toEqual({ count: 2, unit: 'month' });

      const window = getBudgetPeriodWindow(
        { period: 'every', repeatCount: null, repeatUnit: null, startDate: '2026-11-15', createdAt: new Date(2026, 10, 7) },
        at(2026, 11, 20)
      );
      expect(window.label).toBe('Every month');
      expect(getBudgetPeriodLabel('every')).toBe('Every month');
      expect(stamp(window.start)).toBe('2026-12-15 00:00:00.000');
      expect(stamp(window.end)).toBe('2027-01-14 23:59:59.999');
    });

    it('is its own period name, and the six named rhythms are untouched', () => {
      expect(normaliseBudgetPeriod('every')).toBe('every');
      expect(normaliseBudgetPeriod('monthly')).toBe('monthly');
      expect(getBudgetPeriodLabel('biweekly')).toBe('Fortnightly');
    });
  });

  describe('a one-off budget runs once', () => {
    const oneOff = { period: 'custom', startDate: '2026-12-01', endDate: '2027-01-31' };

    it('before its first day it has not started, and is captioned One-off', () => {
      const window = getBudgetPeriodWindow(oneOff, at(2026, 10, 10));
      expect(window.label).toBe('One-off');
      expect(window.notStarted).toBe(true);
      expect(window.ended).toBe(false);
      expect(stamp(window.start)).toBe('2026-12-01 00:00:00.000');
      expect(stamp(window.end)).toBe('2027-01-31 23:59:59.999');
    });

    it('between its days it is running', () => {
      const window = getBudgetPeriodWindow(oneOff, at(2026, 11, 15));
      expect(window.notStarted).toBe(false);
      expect(window.ended).toBe(false);
    });

    it('after its last day it is finished, over the same days — never a second run', () => {
      const window = getBudgetPeriodWindow(oneOff, at(2027, 1, 1));
      expect(window.ended).toBe(true);
      expect(stamp(window.start)).toBe('2026-12-01 00:00:00.000');
      expect(stamp(window.end)).toBe('2027-01-31 23:59:59.999');
    });
  });
});
