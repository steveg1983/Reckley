/**
 * The window a budget is currently being measured over.
 *
 * WHY this exists: the Budget page and the notification service each derived
 * the window themselves, and both wrote the same two-branch guess —
 * "monthly, else the whole calendar year". A weekly budget therefore compared
 * a week's allowance against a YEAR of spending on the alerts path, and a
 * quarterly or custom one did the same on both. The card caption repeated the
 * guess in words ("Yearly budget" for anything that was not monthly), so the
 * screen agreed with itself while being wrong.
 *
 * One derivation, used by every surface, is the only way those can never drift
 * apart again.
 *
 * ── A BUDGET IS AN ALLOWANCE FOR A CYCLE, ANCHORED ON ITS START (5 Nov 2026) ─
 *
 * Until 5 Nov a yearly budget was measured over the CALENDAR YEAR it was read
 * in, whatever day it was written. Budgets set on 29 Oct were compared with
 * ten months of spending that happened before they existed, and the owner's
 * first sight of his new budgets was most of them already overspent. The
 * wizard had asked what each category cost and what to allow, and never asked
 * FROM WHEN — and the page never said.
 *
 * Now `start_date` is the anchor for every period that repeats. A monthly,
 * quarterly or yearly budget is measured over the cycle containing `now`,
 * counted from its start: 1 Nov 2026 – 31 Oct 2027, then 1 Nov 2027 – …; a
 * tax-year budgeter anchors on 6 April and gets 6 Apr – 5 Apr with no special
 * case; a budget from the 15th runs 15th to 14th (a decision the owner made
 * for people paid mid-month, 5 Nov 2026). Before the anchor the window is the
 * FIRST cycle and `notStarted` says so; past an `end_date` it is the LAST and
 * `ended` says so. The arithmetic is in whole months with the day clamped to
 * the month's length, so an anchor on the 31st steps 31 Jan → 28 Feb → 31 Mar,
 * the same way `plWindow` and the fortnight code already count.
 *
 * ── LEGACY ROWS KEEP THE CALENDAR, AND HOW THEY ARE TOLD APART ──────────────
 *
 * No screen ever collected a start date before this shipped: the service
 * filled `start_date` with the day of creation. Reading that day as an anchor
 * would move every existing budget's window on the day this deploys — a
 * yearly budget written on 29 Oct would run 29 Oct to 28 Oct, which nobody
 * chose. So a row written BEFORE `ANCHOR_SINCE` whose start date is its own
 * creation day is read as having no anchor, and keeps the calendar month,
 * quarter or year it has always had. The one way such a row gains an anchor
 * is to be re-dated — by the wizard's "run these budgets from" or the editor's
 * "Starts" — which writes a start that is not its creation day. A row written
 * on or after `ANCHOR_SINCE` always carries a chosen start (the writers put
 * one on every row), so its date is its anchor, creation day or not.
 *
 * Measured before shipping: every stored budget was either start = creation
 * day (the service default) or start = 1 January (the showcase seeder), and
 * both read exactly as before under this rule. There is no migration, in any
 * of the three engines, and none is needed.
 *
 * ── AN END DATE, AND A BUDGET THAT RUNS ONCE (5 Nov 2026, the owner's "5") ──
 *
 * Every period honours `end_date`, not only the month-stepped ones: a weekly
 * budget "until the end of June" is a thing a person asks for, and a weekly
 * branch that ignored the column would have kept measuring week after week
 * past the day they said stop. One function, `boundedWindow`, applies the
 * rule to whatever cycle a period follows — the Sunday week, the fortnight
 * from the anchor, the month-stepped cycle, the legacy calendar — so no period
 * can honour the end differently: the current cycle is cut short at the end
 * date; after it the window is the cycle the end date falls in, cut there,
 * and `ended` is true. An end date before the start is no end at all (no
 * writer allows one; a corrupt row reads as open-ended rather than as a budget
 * that finished before it began).
 *
 * A budget that runs ONCE is the `custom` period, captioned "One-off": one
 * window from `start_date` to `end_date`, measured once, finished after. The
 * editor collects both days for it, and only for it. Nothing else changed in
 * that branch — the old open-ended and missing-dates fallbacks stay, stated in
 * the code, for rows older builds wrote.
 *
 * ── ANY REPEAT INTERVAL (7 Nov 2026, the owner's "4") ─────────────────────
 *
 * The period `every` repeats every N weeks or months: `repeat_count` and
 * `repeat_unit` on the row say which, and both engines' CHECKs hold them to
 * exactly that period. The cycle is the fortnight's or the month-stepped
 * cycle's rule with N in place of 2 or 1, 3, 12 — nothing new is counted,
 * only counted in the user's own step — anchored on the start date (every
 * such row is written after the cycle model shipped, so its start is chosen),
 * and bounded by the end date like every other period. The caption is the
 * interval itself: "Every 2 months", "Every 6 weeks". A row whose pair is
 * missing or unsound (nothing writes one, but a reader must answer) is read
 * as every month. The six named rhythms are untouched: a monthly budget is
 * still 'monthly', not 'every 1 month', so nothing stored changed.
 *
 * BOUNDARIES: windows are inclusive and run to the LAST MILLISECOND of the end
 * day. The old code ended a month at `new Date(y, m + 1, 0)` — local midnight —
 * which dropped the final day of every month for anyone west of the row's
 * timestamp (a date-only "2026-08-31" off the wire is UTC midnight, i.e. 01:00
 * local under BST, which is already past a midnight boundary).
 *
 * This module runs in the browser AND in the API (`api/_lib/mcp/server.ts`
 * evaluates budgets for the connector), so it imports nothing that touches a
 * window, a locale or storage. Captions that need a locale live in
 * `utils/budgetPace`.
 */

import { toDateMs } from './dateBoundary.js';
import type { BudgetRepeatUnit } from '../types/index.js';

/** Every period a budget can be measured over. */
export type BudgetPeriodName = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom' | 'every';

/** An `every` budget's interval: how many of which unit one cycle is. */
export interface BudgetRepeat {
  count: number;
  unit: BudgetRepeatUnit;
}

/**
 * The day the cycle model shipped. A budget created on or after this day
 * always carries a chosen start; one created before it carries the service's
 * default unless it has since been re-dated. See the header.
 */
export const ANCHOR_SINCE = '2026-11-06';

/**
 * What a window is derived FROM. Structural on purpose: `Budget`,
 * `DecimalBudget` and the recommendation service's drafts all satisfy it
 * without conversion, and `period` is a plain string because rows written by
 * older builds (and by the recurring-template importer) carry values the
 * current union has never listed.
 */
export interface BudgetPeriodSource {
  period?: string | null;
  /** The stored `budgets.start_date` — the anchor of every repeating period, and a custom period's first day. */
  startDate?: string | Date | null;
  /** The stored `budgets.end_date` — the last day the budget runs; a custom period's last day. */
  endDate?: string | Date | null;
  /**
   * When the row was written. Tells a chosen start from the service's old
   * default (see the header), and anchors a fortnightly budget with no start.
   */
  createdAt?: string | Date | null;
  /** For `every`: how many of the unit one cycle is (`budgets.repeat_count`). */
  repeatCount?: number | null;
  /** For `every`: 'week' or 'month' (`budgets.repeat_unit`). */
  repeatUnit?: string | null;
}

/**
 * An `every` budget's interval as stored, or null when the pair is missing or
 * unsound — a count that is not a whole number of at least one, or a unit
 * that is neither week nor month. Nothing writes such a row; a reader still
 * has to answer for one.
 */
export function resolveBudgetRepeat(
  source: Pick<BudgetPeriodSource, 'repeatCount' | 'repeatUnit'>
): BudgetRepeat | null {
  const { repeatCount: count, repeatUnit: unit } = source;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return null;
  if (unit !== 'week' && unit !== 'month') return null;
  return { count, unit };
}

/** What an `every` budget with no sound pair is read as. */
const EVERY_FALLBACK: BudgetRepeat = { count: 1, unit: 'month' };

/** "Every 2 months", "Every 6 weeks", "Every month" — the interval as a caption. */
export function describeBudgetRepeat(repeat: BudgetRepeat): string {
  if (repeat.count === 1) return `Every ${repeat.unit}`;
  return `Every ${repeat.count} ${repeat.unit}s`;
}

export interface BudgetPeriodWindow {
  /** First instant counted (local start of day). */
  start: Date;
  /** Last instant counted (local end of day, inclusive). */
  end: Date;
  /** The period the window was derived for. */
  period: BudgetPeriodName;
  /** Caption for the card — "Monthly", "Fortnightly", … */
  label: string;
  /**
   * `now` is before the budget's first day. The window is the FIRST cycle and
   * nothing in it has happened yet: a card shows "starts …", not "0% used".
   */
  notStarted: boolean;
  /**
   * The budget's end date has passed. The window is the LAST cycle, cut at
   * the end date, and it is finished rather than re-measured against nothing.
   */
  ended: boolean;
}

const PERIOD_LABELS: Record<BudgetPeriodName, string> = {
  weekly: 'Weekly',
  biweekly: 'Fortnightly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
  // The owner's word for a budget that runs once (5 Nov 2026). "Custom" said
  // nothing about what the budget did; this says it does not repeat.
  custom: 'One-off',
  // The caption an `every` budget wears when its pair is unsound — the
  // interval it is then read as. A sound one is captioned by its interval.
  every: describeBudgetRepeat(EVERY_FALLBACK),
};

/** Days in a fortnight — the biweekly step. */
const FORTNIGHT_DAYS = 14;

/** How many months one cycle of each repeating period is. */
const CYCLE_MONTHS: Record<'monthly' | 'quarterly' | 'yearly', number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/**
 * A stored period string as one of the periods we can measure.
 *
 * Unknown/blank falls back to MONTHLY, not yearly: a monthly allowance is what
 * a budget without a stated period means everywhere else in the app, and the
 * old yearly fallback is precisely what made a week's budget read a year of
 * spending.
 */
export function normaliseBudgetPeriod(period: string | null | undefined): BudgetPeriodName {
  switch ((period ?? '').trim().toLowerCase()) {
    case 'weekly':
      return 'weekly';
    case 'biweekly':
    case 'bi-weekly':
    case 'fortnightly':
      return 'biweekly';
    case 'quarterly':
      return 'quarterly';
    case 'yearly':
    case 'annual':
    case 'annually':
      return 'yearly';
    case 'custom':
      return 'custom';
    case 'every':
      return 'every';
    default:
      return 'monthly';
  }
}

/**
 * The caption a card shows for a period — "Fortnightly", "Quarterly", … — and
 * for `every`, the interval itself when the row is given: "Every 2 months".
 */
export function getBudgetPeriodLabel(
  period: string | null | undefined,
  source?: Pick<BudgetPeriodSource, 'repeatCount' | 'repeatUnit'>
): string {
  const name = normaliseBudgetPeriod(period);
  if (name === 'every' && source) {
    return describeBudgetRepeat(resolveBudgetRepeat(source) ?? EVERY_FALLBACK);
  }
  return PERIOD_LABELS[name];
}

/** Local start of the given calendar day. */
function startOfDay(year: number, month: number, day: number): Date {
  return new Date(year, month, day, 0, 0, 0, 0);
}

/** Local end of the given calendar day — inclusive upper bound. */
function endOfDay(year: number, month: number, day: number): Date {
  return new Date(year, month, day, 23, 59, 59, 999);
}

interface DayParts {
  year: number;
  month: number;
  day: number;
}

function partsOf(date: Date): DayParts {
  return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
}

/** The same instant's calendar day in UTC — the day the service's old default named. */
function utcPartsOf(date: Date): DayParts {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() };
}

/** "2026-11-01" for a day, so days can be compared as strings or shown. */
function isoOf(parts: DayParts): string {
  return `${parts.year}-${String(parts.month + 1).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/**
 * The calendar day a stored value names, or null when it names none.
 *
 * A date-only "2026-08-01" is read as the LOCAL 1 August, not as UTC midnight:
 * these are period boundaries a person chose, and a boundary that lands an hour
 * before the day it names would quietly drop or add a day's spending.
 */
function toDayParts(value: string | Date | null | undefined): DayParts | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (dateOnly) {
      return { year: Number(dateOnly[1]), month: Number(dateOnly[2]) - 1, day: Number(dateOnly[3]) };
    }
  }
  const ms = toDateMs(value);
  if (!Number.isFinite(ms)) return null;
  return partsOf(new Date(ms));
}

/** Whole days from `from` to `to`, DST-proof (compared as UTC calendar days). */
function daysBetween(from: DayParts, to: DayParts): number {
  const fromMs = Date.UTC(from.year, from.month, from.day);
  const toMs = Date.UTC(to.year, to.month, to.day);
  return Math.round((toMs - fromMs) / 86_400_000);
}

/** Negative when `a` is the earlier day, zero when the same, positive when later. */
function compareDays(a: DayParts, b: DayParts): number {
  return daysBetween(b, a);
}

/**
 * `months` months on from a day, the day clamped to the month it lands in: an
 * anchor on the 31st steps 31 Jan → 28 Feb → 31 Mar, never into the month
 * after. Same rule the P&L windows keep.
 */
function addMonths(parts: DayParts, months: number): DayParts {
  const total = parts.month + months;
  const year = parts.year + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return { year, month, day: Math.min(parts.day, lastDay) };
}

/**
 * The cycle of `stepMonths` months, counted from `anchor`, that contains
 * `today` — or the first cycle when today is before the anchor.
 *
 * The month count alone can overshoot by one (today earlier in its month than
 * the anchor's day), never by more and never undershoot, so one step back is
 * the whole correction.
 */
function cycleContaining(anchor: DayParts, stepMonths: number, today: DayParts): { start: DayParts; next: DayParts } {
  const monthsApart = (today.year - anchor.year) * 12 + (today.month - anchor.month);
  let index = Math.floor(monthsApart / stepMonths);
  if (index > 0 && compareDays(addMonths(anchor, index * stepMonths), today) > 0) index -= 1;
  if (index < 0) index = 0;
  return {
    start: addMonths(anchor, index * stepMonths),
    next: addMonths(anchor, (index + 1) * stepMonths),
  };
}

/**
 * The anchor a repeating budget was given, or null for a legacy row that
 * never had one and keeps the calendar. The whole rule is in the header.
 */
export function resolveBudgetAnchor(budget: BudgetPeriodSource): string | null {
  const start = toDayParts(budget.startDate);
  if (!start) return null;
  const createdMs = budget.createdAt === null || budget.createdAt === undefined ? NaN : toDateMs(budget.createdAt);
  if (!Number.isFinite(createdMs)) return isoOf(start);
  const created = new Date(createdMs);
  if (isoOf(partsOf(created)) >= ANCHOR_SINCE) return isoOf(start);
  const isCreationDay = compareDays(start, partsOf(created)) === 0 || compareDays(start, utcPartsOf(created)) === 0;
  return isCreationDay ? null : isoOf(start);
}

/** A window from its day parts, with the two flags; `label` only for an interval of the user's own. */
function windowOf(
  start: DayParts,
  end: DayParts,
  period: BudgetPeriodName,
  flags: { notStarted: boolean; ended: boolean } = { notStarted: false, ended: false },
  label: string = PERIOD_LABELS[period]
): BudgetPeriodWindow {
  return {
    start: startOfDay(start.year, start.month, start.day),
    end: endOfDay(end.year, end.month, end.day),
    period,
    label,
    ...flags,
  };
}

/** The day before a day. */
function dayBefore(parts: DayParts): DayParts {
  return partsOf(new Date(parts.year, parts.month, parts.day - 1));
}

/** One cycle of a period, as its first and last day. */
interface Cycle {
  start: DayParts;
  end: DayParts;
}

/**
 * The week containing a day. Sunday-start, unchanged from what the Budget
 * page has always drawn — a silent shift to Monday would move every weekly
 * figure on the page without anyone asking for it.
 */
function weekContaining(day: DayParts): Cycle {
  const weekday = new Date(day.year, day.month, day.day).getDay();
  const start = partsOf(new Date(day.year, day.month, day.day - weekday));
  return { start, end: partsOf(new Date(start.year, start.month, start.day + 6)) };
}

/**
 * The cycle of `length` days containing a day, counted from the anchor — or
 * the FIRST cycle when the day is before it, not a phantom one behind it. A
 * fortnight is this with 14; "every 6 weeks" is this with 42.
 */
function daysCycleContaining(anchor: DayParts, length: number, day: DayParts): Cycle {
  const index = Math.max(0, Math.floor(daysBetween(anchor, day) / length));
  const start = partsOf(new Date(anchor.year, anchor.month, anchor.day + index * length));
  return { start, end: partsOf(new Date(start.year, start.month, start.day + length - 1)) };
}

/** The month-stepped cycle containing a day, counted from the anchor. */
function monthsCycleContaining(anchor: DayParts, stepMonths: number, day: DayParts): Cycle {
  const cycle = cycleContaining(anchor, stepMonths, day);
  return { start: cycle.start, end: dayBefore(cycle.next) };
}

/** The calendar month, quarter or year containing a day — what a legacy row keeps. */
function calendarCycleContaining(period: 'monthly' | 'quarterly' | 'yearly', day: DayParts): Cycle {
  const step = CYCLE_MONTHS[period];
  const firstMonth = Math.floor(day.month / step) * step;
  return {
    start: { year: day.year, month: firstMonth, day: 1 },
    // Day 0 of the month after the cycle is the cycle's last day.
    end: partsOf(new Date(day.year, firstMonth + step, 0)),
  };
}

/**
 * A budget's window: the cycle its period follows, bounded by its end date
 * and flagged. EVERY period comes through here, which is what makes the end
 * date mean one thing (see the header).
 *
 * `startsOn` is the budget's first day when it has one: before it the window
 * is the first cycle and `notStarted` says so. Past a sound end date the
 * window is the cycle the end date falls in, cut there, and `ended` says so.
 * An end date before the start is not sound and is read as no end.
 */
function boundedWindow(
  cycleOf: (day: DayParts) => Cycle,
  period: BudgetPeriodName,
  endDate: string | Date | null | undefined,
  today: DayParts,
  startsOn: DayParts | null,
  label?: string
): BudgetPeriodWindow {
  const stated = toDayParts(endDate);
  const last = stated && (startsOn === null || compareDays(stated, startsOn) >= 0) ? stated : null;

  if (last && compareDays(today, last) > 0) {
    const cycle = cycleOf(last);
    return windowOf(
      cycle.start,
      compareDays(last, cycle.end) < 0 ? last : cycle.end,
      period,
      { notStarted: false, ended: true },
      label
    );
  }

  const cycle = cycleOf(today);
  const end = last && compareDays(last, cycle.end) < 0 ? last : cycle.end;
  return windowOf(
    cycle.start,
    end,
    period,
    { notStarted: startsOn !== null && compareDays(today, startsOn) < 0, ended: false },
    label
  );
}

/**
 * The period a budget is currently being measured over.
 *
 * - weekly: the current week (Sunday-start — see weekContaining).
 * - biweekly: the fortnight containing `now`, counted from the budget's own
 *   start date (or, failing that, the day it was created). A fortnight has no
 *   calendar boundary to sit on, so the budget's own anchor is the only honest
 *   one.
 * - monthly / quarterly / yearly: the cycle containing `now`, counted from the
 *   budget's anchor (see the header) — or, for a legacy row with none, the
 *   calendar month, quarter and year.
 * - every: the cycle of N weeks or N months containing `now`, counted from
 *   the budget's start — the fortnight's and the month-stepped rule with the
 *   user's own N.
 * - custom ("One-off"): the stored start/end dates, once. A custom budget
 *   missing them falls back to the current month — stated in the code rather
 *   than silently inherited, and still captioned as itself so the card never
 *   claims a period the budget does not have.
 *
 * Every repeating period is bounded by the budget's end date through
 * `boundedWindow` — the one place the end date is read.
 */
export function getBudgetPeriodWindow(
  budget: BudgetPeriodSource,
  now: Date = new Date()
): BudgetPeriodWindow {
  const period = normaliseBudgetPeriod(budget.period);
  const today = partsOf(now);

  switch (period) {
    case 'weekly':
      return boundedWindow(weekContaining, period, budget.endDate, today, null);

    case 'biweekly': {
      const anchor = toDayParts(budget.startDate) ?? toDayParts(budget.createdAt) ?? weekContaining(today).start;
      return boundedWindow(day => daysCycleContaining(anchor, FORTNIGHT_DAYS, day), period, budget.endDate, today, anchor);
    }

    case 'every': {
      // The user's own step, from the start they chose (see the header). A
      // row with no start takes its creation day, as the fortnight does.
      const repeat = resolveBudgetRepeat(budget) ?? EVERY_FALLBACK;
      const anchor = toDayParts(budget.startDate) ?? toDayParts(budget.createdAt) ?? today;
      const cycleOf =
        repeat.unit === 'week'
          ? (day: DayParts): Cycle => daysCycleContaining(anchor, repeat.count * 7, day)
          : (day: DayParts): Cycle => monthsCycleContaining(anchor, repeat.count, day);
      return boundedWindow(cycleOf, period, budget.endDate, today, anchor, describeBudgetRepeat(repeat));
    }

    case 'monthly':
    case 'quarterly':
    case 'yearly': {
      const anchor = toDayParts(resolveBudgetAnchor(budget));
      if (anchor) {
        return boundedWindow(
          day => monthsCycleContaining(anchor, CYCLE_MONTHS[period], day),
          period,
          budget.endDate,
          today,
          anchor
        );
      }
      return boundedWindow(day => calendarCycleContaining(period, day), period, budget.endDate, today, null);
    }

    case 'custom':
    default: {
      const start = toDayParts(budget.startDate);
      if (start) {
        // No end date means "from the start date until now" — an open-ended
        // custom period, measured as far as it has run.
        const end = toDayParts(budget.endDate) ?? today;
        return windowOf(start, end, period, {
          notStarted: compareDays(today, start) < 0,
          ended: compareDays(today, end) > 0,
        });
      }
      return windowOf(
        { year: today.year, month: today.month, day: 1 },
        partsOf(new Date(today.year, today.month + 1, 0)),
        period
      );
    }
  }
}
