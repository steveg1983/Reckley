import { describe, it, expect } from 'vitest';
import { getBudgetPeriodWindow } from './budgetPeriods';
import { budgetPace, describeBudgetWindow, paceDifference } from './budgetPace';
import { toDecimal } from './decimal';

const at = (year: number, month: number, day: number): Date => new Date(year, month, day, 12, 0, 0, 0);

/** A yearly budget from 1 Nov 2026, written after the cycle model shipped. */
const yearly = { period: 'yearly', startDate: '2026-11-01', createdAt: at(2026, 10, 10) };

describe('describeBudgetWindow', () => {
  it('names both ends of the window, in the app’s locale', () => {
    const window = getBudgetPeriodWindow(yearly, at(2027, 1, 10));
    // Intl pads the dash with narrow no-break spaces; the words are what is pinned.
    expect(describeBudgetWindow(window).replace(/\s+/g, ' ')).toBe('1 Nov 2026 – 31 Oct 2027');
  });
});

describe('budgetPace — how far through the window we are', () => {
  it('reads a year in whole months gone, counting a month only once its day has come round', () => {
    const window = getBudgetPeriodWindow(yearly, at(2027, 1, 10));
    expect(budgetPace(window, at(2027, 1, 10)).text).toBe('3 of 12 months gone');
    expect(budgetPace(window, at(2026, 11, 1)).text).toBe('1 of 12 months gone');
    expect(budgetPace(window, at(2026, 10, 30)).text).toBe('0 of 12 months gone');
  });

  it('reads a quarter in months and a month in days', () => {
    const quarterly = getBudgetPeriodWindow({ ...yearly, period: 'quarterly' }, at(2026, 11, 20));
    expect(budgetPace(quarterly, at(2026, 11, 20)).text).toBe('1 of 3 months gone');
    const monthly = getBudgetPeriodWindow({ ...yearly, period: 'monthly' }, at(2026, 10, 12));
    expect(budgetPace(monthly, at(2026, 10, 12)).text).toBe('day 12 of 30');
  });

  it('paces by days, with today counted as gone', () => {
    const monthly = getBudgetPeriodWindow({ ...yearly, period: 'monthly' }, at(2026, 10, 15));
    expect(budgetPace(monthly, at(2026, 10, 15)).fraction).toBeCloseTo(15 / 30, 6);
    expect(budgetPace(monthly, at(2026, 10, 30)).fraction).toBe(1);
  });

  it('a budget that has not started has nothing gone, and names its first day', () => {
    const window = getBudgetPeriodWindow({ ...yearly, startDate: '2027-04-06' }, at(2026, 10, 15));
    expect(budgetPace(window, at(2026, 10, 15))).toEqual({ fraction: 0, text: 'Starts 6 Apr 2027' });
  });

  it('a finished budget has all of it gone, and names its last day', () => {
    const window = getBudgetPeriodWindow({ ...yearly, endDate: '2027-06-30' }, at(2027, 7, 15));
    expect(budgetPace(window, at(2027, 7, 15))).toEqual({ fraction: 1, text: 'Finished 30 Jun 2027' });
  });
});

describe('paceDifference — spending against the pace', () => {
  it('is positive when spending runs ahead of the time gone, negative when behind', () => {
    const halfway = { fraction: 0.5, text: '6 of 12 months gone' };
    expect(paceDifference(toDecimal(1200), toDecimal(700), halfway).toString()).toBe('100');
    expect(paceDifference(toDecimal(1200), toDecimal(500), halfway).toString()).toBe('-100');
  });

  it('paces nothing against a budget of nothing', () => {
    expect(paceDifference(toDecimal(0), toDecimal(40), { fraction: 0.5, text: '' }).isZero()).toBe(true);
  });
});
