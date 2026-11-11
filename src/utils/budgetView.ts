/**
 * HOW A LONG BUDGET IS READ: over its whole period, so far, or this month.
 *
 * ── WHY (the owner, 10 Nov 2026) ────────────────────────────────────────────
 * His budgets are yearly, and a yearly bar two weeks into its year says
 * nothing a person can act on: "Looking at a yearly budget all the time
 * doesn't help people budget for the short term." The budget stays what he
 * made it — one annual figure — and the app reads it three ways:
 *
 *   period   spend against the whole allowance, as it always was
 *   toDate   spend so far against the months that have begun
 *   month    this month's spend against one month's share
 *
 * ── MONTHS, NOT DAYS (his ruling, the same day) ─────────────────────────────
 * "Calendar months rather than daily, simply split by 12 and if my budget
 * started in October and I am now in November, then my running total is
 * based against 2 calendar months' worth or 2/12 of the yearly total."
 * A month counts from the day it BEGINS: there is no part-month share.
 *
 * The months are the budget's own: they step from the window's first day. A
 * budget that starts on the 1st therefore steps with the calendar, which is
 * his case and the common one; one that starts on the 15th has months that
 * run 15th to 14th, so its year is still twelve of them and not thirteen
 * calendar months with two halves.
 *
 * ── WHAT IS LEFT ALONE ──────────────────────────────────────────────────────
 * A budget of one month or less has nothing shorter to be read as. Nor has
 * one that is not a whole number of months — six weeks is not "1 of 2
 * months" with a twelve-day second month. A budget
 * "paid in one go" (insurance, car tax) is a lump: a twelfth of it is not an
 * allowance anybody has. One that has not started or has finished is not
 * being read as "so far". Each of those reads as its whole period whatever
 * the choice — `measureBudget` says which view it actually applied.
 *
 * The carry counts: the share is of the allowance for the window, plan plus
 * whatever earlier cycles and other budgets left it.
 *
 * Runs in the API too (the widget's document reads through it), so nothing
 * here reads a locale or storage. Words for a screen are the screen's.
 */

import type { BudgetPeriodWindow } from './budgetPeriods.js';
import { toDecimal, type DecimalInstance } from './decimal.js';

export type BudgetView = 'period' | 'toDate' | 'month';

/** The preference the choice is kept under — one for every budget, and it travels with the account. */
export const BUDGET_VIEW_KEY = 'budgetView';

/** His ruling: a long budget reads "so far" unless the person says otherwise. */
export const DEFAULT_BUDGET_VIEW: BudgetView = 'toDate';

/** A stored choice, or the default: a preference is a string someone else wrote. */
export function parseBudgetView(raw: unknown): BudgetView {
  return raw === 'period' || raw === 'toDate' || raw === 'month' ? raw : DEFAULT_BUDGET_VIEW;
}

export interface BudgetMonthSteps {
  /** How many months the window holds. Always 2 or more. */
  total: number;
  /** How many have begun, the one holding `now` included. 1 to `total`. */
  elapsed: number;
  /** The month holding `now`: its first instant and its last. */
  currentStart: Date;
  currentEnd: Date;
}

const daysInMonth = (year: number, month: number): number => new Date(year, month + 1, 0).getDate();

/** The start of the window's step `index`: the same day of the month, or the month's last when it has no such day. */
function stepStart(start: Date, index: number): Date {
  const first = new Date(start.getFullYear(), start.getMonth() + index, 1);
  const day = Math.min(start.getDate(), daysInMonth(first.getFullYear(), first.getMonth()));
  return new Date(first.getFullYear(), first.getMonth(), day);
}

/** More steps than any budget has; a guard against a window that never ends, not a case anyone meets. */
const MAX_STEPS = 1200;

/**
 * The window's months as at `now`, or null when it has nothing shorter to be
 * read as: one month or less, not a whole number of months, not started, or
 * finished.
 */
export function budgetMonthSteps(window: BudgetPeriodWindow, now: Date): BudgetMonthSteps | null {
  if (window.notStarted || window.ended || now < window.start || now > window.end) return null;

  const starts: Date[] = [];
  for (let index = 0; index < MAX_STEPS; index += 1) {
    const start = stepStart(window.start, index);
    if (start > window.end) break;
    starts.push(start);
  }
  if (starts.length < 2) return null;
  // Whole months only: the day after the window's last must be where the
  // next month would begin.
  const after = new Date(window.end.getFullYear(), window.end.getMonth(), window.end.getDate() + 1);
  if (after.getTime() !== stepStart(window.start, starts.length).getTime()) return null;

  let current = 0;
  for (let index = 1; index < starts.length; index += 1) {
    if (starts[index] <= now) current = index;
  }
  const next = starts[current + 1];
  const currentEnd = next
    ? new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1, 23, 59, 59, 999)
    : window.end;
  return { total: starts.length, elapsed: current + 1, currentStart: starts[current], currentEnd };
}

/** What `evaluateBudgets` works out once per budget so that any view can be read off it. */
export interface BudgetMonthFigures extends BudgetMonthSteps {
  /** Net spend from the window's first day to the end of the month holding `now`. */
  spentToDate: DecimalInstance;
  /** Net spend in the month holding `now`. */
  spentThisMonth: DecimalInstance;
  /** The expanded rows behind each, by id — what a drill shows. */
  toDateRowIds: ReadonlySet<string>;
  thisMonthRowIds: ReadonlySet<string>;
}

/** The part of an evaluated budget a view is read from. */
export interface MeasurableBudget {
  effectiveAmount: DecimalInstance;
  spent: DecimalInstance;
  window: BudgetPeriodWindow;
  countedRowIds: ReadonlySet<string>;
  months: BudgetMonthFigures | null;
}

export interface BudgetMeasure {
  /** The view actually applied: 'period' whenever the budget has no months to be read by. */
  view: BudgetView;
  /** The allowance the view measures against. */
  allowance: DecimalInstance;
  spent: DecimalInstance;
  /** Allowance less spend, SIGNED: negative is how far over. */
  remaining: DecimalInstance;
  /** Spend as a percentage of the allowance; 0 for a zero allowance. */
  percentage: number;
  /** The days the figures cover. */
  start: Date;
  end: Date;
  /** The months behind a 'toDate' or 'month' reading; null under 'period'. */
  months: { elapsed: number; total: number } | null;
  /** The rows the spend was summed from. */
  rowIds: ReadonlySet<string>;
}

const percentOf = (allowance: DecimalInstance, spent: DecimalInstance): number =>
  allowance.greaterThan(0) ? spent.dividedBy(allowance).times(100).toNumber() : 0;

/** One budget read under a view. Money to the penny; the last month takes no rounding because 12/12 is the whole. */
export function measureBudget(budget: MeasurableBudget, view: BudgetView): BudgetMeasure {
  const months = budget.months;
  if (view === 'period' || months === null) {
    return {
      view: 'period',
      allowance: budget.effectiveAmount,
      spent: budget.spent,
      remaining: budget.effectiveAmount.minus(budget.spent),
      percentage: percentOf(budget.effectiveAmount, budget.spent),
      start: budget.window.start,
      end: budget.window.end,
      months: null,
      rowIds: budget.countedRowIds,
    };
  }

  const steps = { elapsed: months.elapsed, total: months.total };
  if (view === 'toDate') {
    const allowance = budget.effectiveAmount.times(toDecimal(months.elapsed)).dividedBy(toDecimal(months.total)).toDecimalPlaces(2);
    return {
      view,
      allowance,
      spent: months.spentToDate,
      remaining: allowance.minus(months.spentToDate),
      percentage: percentOf(allowance, months.spentToDate),
      start: budget.window.start,
      end: months.currentEnd,
      months: steps,
      rowIds: months.toDateRowIds,
    };
  }

  const allowance = budget.effectiveAmount.dividedBy(toDecimal(months.total)).toDecimalPlaces(2);
  return {
    view,
    allowance,
    spent: months.spentThisMonth,
    remaining: allowance.minus(months.spentThisMonth),
    percentage: percentOf(allowance, months.spentThisMonth),
    start: months.currentStart,
    end: months.currentEnd,
    months: steps,
    rowIds: months.thisMonthRowIds,
  };
}
