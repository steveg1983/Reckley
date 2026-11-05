/**
 * What a budget's window SAYS on a screen: its dates, and how far through it
 * we are.
 *
 * Split from `utils/budgetPeriods` on purpose: that module also runs in the
 * API (the connector evaluates budgets with it) and must import nothing that
 * reads a locale or storage. Everything here is for a screen.
 *
 * ── PACE (owner, 5 Nov 2026: "this batch") ─────────────────────────────────
 * An annual budget read on day five of its year and on day 360 used to show
 * the same bar. The honest reading of a long cycle is how much of the cycle
 * has gone beside how much of the money has: "3 of 12 months gone" and
 * whether spending is ahead of or behind that pace. The fraction is by DAYS,
 * so a cycle of any length paces the same way; the words are months for a
 * cycle longer than one month and days otherwise, because "35 of 365 days"
 * is a figure nobody reads.
 */

import type { BudgetPeriodWindow } from './budgetPeriods';
import { getDateLocale } from './dateFormatter';
import { toDecimal, type DecimalInstance } from './decimal';

/** "1 Nov 2026 – 31 Oct 2027" — the exact days a window covers, in the app's locale. */
export function describeBudgetWindow(window: Pick<BudgetPeriodWindow, 'start' | 'end'>): string {
  return new Intl.DateTimeFormat(getDateLocale(), { day: 'numeric', month: 'short', year: 'numeric' })
    .formatRange(window.start, window.end);
}

/** "6 Apr 2027" — one day, in the app's locale. */
export function describeBudgetDay(date: Date): string {
  return new Intl.DateTimeFormat(getDateLocale(), { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

export interface BudgetPace {
  /** How much of the window has elapsed, 0 to 1, by days; today counts as gone. */
  fraction: number;
  /** "3 of 12 months gone", "day 12 of 30", "Starts 6 Apr 2027", "Finished 30 Jun 2027". */
  text: string;
}

const DAY_MS = 86_400_000;

/** Whole days from the start of `from`'s day to the start of `to`'s day. */
function daysApart(from: Date, to: Date): number {
  const fromMs = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const toMs = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((toMs - fromMs) / DAY_MS);
}

/** Whole months from `from` to `to`, counting a month only once its day has come round. */
function wholeMonthsApart(from: Date, to: Date): number {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * How far through its window a budget is, as at `now`.
 *
 * Before the window: nothing has elapsed and the text names the first day.
 * After an ended window: all of it has, and the text names the last day.
 */
export function budgetPace(window: BudgetPeriodWindow, now: Date = new Date()): BudgetPace {
  if (window.notStarted) return { fraction: 0, text: `Starts ${describeBudgetDay(window.start)}` };
  if (window.ended || now > window.end) return { fraction: 1, text: `Finished ${describeBudgetDay(window.end)}` };

  const totalDays = daysApart(window.start, window.end) + 1;
  const elapsedDays = Math.min(totalDays, Math.max(0, daysApart(window.start, now) + 1));
  const fraction = totalDays > 0 ? elapsedDays / totalDays : 1;

  // A cycle longer than one month is read in months; the day after the end
  // is the next cycle's start, which is what a whole-month count is taken to.
  const dayAfterEnd = new Date(window.end.getFullYear(), window.end.getMonth(), window.end.getDate() + 1);
  const totalMonths = wholeMonthsApart(window.start, dayAfterEnd);
  if (totalMonths > 1) {
    const gone = Math.min(totalMonths, wholeMonthsApart(window.start, now));
    return { fraction, text: `${gone} of ${totalMonths} months gone` };
  }
  return { fraction, text: `day ${elapsedDays} of ${totalDays}` };
}

/**
 * Spending against the pace: positive is AHEAD of pace (spending faster than
 * the window allows so far), negative is behind it. Zero allowance paces
 * nothing, so it is zero.
 */
export function paceDifference(
  allowance: DecimalInstance,
  spent: DecimalInstance,
  pace: BudgetPace
): DecimalInstance {
  if (allowance.lessThanOrEqualTo(0)) return toDecimal(0);
  return spent.minus(allowance.times(pace.fraction)).toDecimalPlaces(2);
}
