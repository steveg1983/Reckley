/**
 * WHAT EACH CATEGORY ACTUALLY COST, over a year — the evidence a budget is
 * set against.
 *
 * The owner's spec (29 Aug 2026): before asking someone for a budget figure,
 * show them what they really spent, per category, with the annual and the
 * monthly side by side; whichever they type, compute the other. This module
 * is the first half of that — the arithmetic, pure and tested, so the screen
 * above it only has to render and the numbers can be argued with directly.
 *
 * ── THE WINDOW, AND WHY THE DEFAULT IS WHOLE MONTHS ─────────────────────────
 * "Last 12 months" has two honest readings and the owner named both:
 *
 *   'full-months'  the twelve COMPLETE calendar months before this one — on
 *                  29 August, that is 1 Aug 2025 to 31 Jul 2026. The default,
 *                  and his own reading: a budget set against a part-finished
 *                  month is set against a month that has not happened yet, and
 *                  every category reads low by however much of August is left.
 *   'to-yesterday' the rolling year ending yesterday. Truer to "the last
 *                  twelve months" as a phrase, and the right answer for
 *                  somebody who wants the most recent evidence including the
 *                  month in progress.
 *
 * Yesterday rather than today in both: today is itself a part-day.
 *
 * ── WHAT COUNTS ────────────────────────────────────────────────────────────
 * SPENDING only, and spending is what `classifyFlow` calls an expense — so
 * transfers between your own accounts are out (moving money is not spending
 * it), income is out, and revaluations are out (a fund going up is not
 * earning and a fund going down is not spending). Splits are expanded first,
 * so a £180 supermarket shop split £120 groceries / £60 wine lands in two
 * categories rather than one.
 *
 * Refunds NET OFF within their category: a £40 return against a £200 coat
 * makes the year's Clothing £160, because that is what the year cost. A
 * category whose refunds exceed its spending nets to zero rather than going
 * negative — "you were paid to shop here" is never the answer, and a negative
 * budget suggestion is nonsense.
 *
 * UNFILED SPENDING IS COUNTED AND REPORTED SEPARATELY. Money that went out
 * under no category cannot be attributed to one, but pretending it does not
 * exist would make every figure here quietly low. The caller gets the total
 * so the screen can say so — the house rule about naming the consequence
 * rather than showing a number that is wrong in a way nobody can see.
 *
 * ── MONEY IS DECIMAL, ALWAYS ───────────────────────────────────────────────
 * Every total is a Decimal from first addition to last, and the monthly
 * figure is the window's total divided by its months at full precision — the
 * caller rounds for display. The named windows are all exactly twelve months,
 * so for them `annual` IS the total and `monthly` is a twelfth of it, which
 * is the other reason the window is defined in whole months rather than days.
 *
 * ── A WINDOW THE USER CHOOSES ('custom', 5 Nov 2026) ───────────────────────
 * The owner's ask: the guide should be able to measure over months of the
 * user's choosing, not only the three named years. A custom window is whole
 * calendar months from one month to another, 1 to 36 of them, never
 * including the month still running. Its figures are stated AT A RATE:
 * `monthly` is total ÷ months and `annual` is total × 12 ÷ months — so a
 * six-month window of £600 reads "£100 a month, £1,200 a year", which is the
 * figure a budget is set against. `total` carries what the window actually
 * cost, and `window.months` says how many months, so the screen can say the
 * figures are a rate rather than a year's spending. The range itself comes
 * from `buildPlWindow`, the same month inputs the Plan page uses, so the two
 * screens cannot disagree about a range.
 */

import { toDecimal, type DecimalInstance } from './decimal';
import { buildPlWindow } from './plWindow';
import { buildCategoryKindLookup, classifyFlow } from './incomeExpense';
import { expandSplitTransactions } from './transactionSplits';
import type { Category, Transaction, TransactionSplit } from '../types';

export type SpendWindowKind = 'full-months' | 'to-yesterday' | 'calendar-year' | 'tax-year' | 'custom';

/** The months a 'custom' window runs over, inclusive, as YYYY-MM. */
export interface SpendWindowCustom {
  fromMonth: string;
  toMonth: string;
}

/** The most months a custom window may hold — three years of evidence is plenty. */
export const MAX_CUSTOM_MONTHS = 36;

export interface SpendWindow {
  kind: SpendWindowKind;
  /** Inclusive ISO dates — the range the figures were summed over. */
  from: string;
  to: string;
  /**
   * How many months the range holds. Twelve for every named kind; what the
   * user chose, after clamping, for 'custom'. The screen reads it to say
   * when "a year" is a rate rather than a year.
   */
  months: number;
}

export interface CategorySpend {
  categoryId: string;
  /** What the window actually cost, positive. Refunds are netted; never below zero. */
  total: DecimalInstance;
  /**
   * The window's spending at a year's rate: exactly `total` for a twelve-month
   * window, total × 12 ÷ months otherwise. The figure a yearly budget is set against.
   */
  annual: DecimalInstance;
  /** The same at a month's rate: total ÷ months. Exactly annual ÷ 12 for every window. */
  monthly: DecimalInstance;
  /** How many rows made it up — evidence the figure is not one freak charge. */
  rows: number;
  /**
   * The month (YYYY-MM) that held nearly all of it, when one did — the
   * evidence a budget is PAID IN ONE GO (owner, 7 Nov 2026): insurance, car
   * tax, a season ticket. Null when the spending was spread, or the window
   * is too short to tell. See `paidOnceIn`.
   */
  paidOnce: string | null;
}

/** The share of a window's spending one month must hold to read as "paid once". */
export const PAID_ONCE_SHARE = 0.8;
/** The fewest months a window needs before one month holding the lot means anything. */
export const PAID_ONCE_MIN_MONTHS = 6;

/**
 * The month that held at least `PAID_ONCE_SHARE` of a category's spending,
 * or null. A six-month window at least: in a shorter one a single bill is
 * most of what there is, and the rule would call every category a lump.
 * Refunds net within their month; a month that netted below zero holds none.
 */
export function paidOnceIn(
  byMonth: ReadonlyMap<string, DecimalInstance>,
  total: DecimalInstance,
  months: number
): string | null {
  if (months < PAID_ONCE_MIN_MONTHS || !total.greaterThan(0)) return null;
  const floor = total.times(PAID_ONCE_SHARE);
  let peak: { month: string; amount: DecimalInstance } | null = null;
  for (const [month, amount] of byMonth) {
    if (peak === null || amount.greaterThan(peak.amount)) peak = { month, amount };
  }
  return peak !== null && peak.amount.greaterThanOrEqualTo(floor) ? peak.month : null;
}

export interface CategorySpendSummary {
  window: SpendWindow;
  /** Leaf category id → what it cost. Categories with no spending are ABSENT. */
  byCategory: Map<string, CategorySpend>;
  /**
   * Spending that went out under NO category, and so belongs to none of the
   * rows above. Reported so the screen can say the figures are that much
   * short rather than looking complete and being wrong.
   */
  unfiled: DecimalInstance;
  unfiledRows: number;
}

const ZERO = toDecimal(0);
const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const MONTH_INPUT = /^\d{4}-\d{2}$/;
const monthKey = (d: Date): string => iso(d).slice(0, 7);
/** Months from one YYYY-MM to another, inclusive — "2026-01" to "2026-06" is 6. */
const monthsBetween = (fromMonth: string, toMonth: string): number =>
  (Number(toMonth.slice(0, 4)) - Number(fromMonth.slice(0, 4))) * 12 +
  (Number(toMonth.slice(5, 7)) - Number(fromMonth.slice(5, 7))) + 1;
const shiftMonth = (month: string, by: number): string =>
  monthKey(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + by, 1));

/**
 * The months a custom window may run over, as it stands today: whole months,
 * none of them the one still running, at most `MAX_CUSTOM_MONTHS`.
 *
 * A range that reaches into this month is cut back to last month; a range
 * longer than the cap keeps its END and loses its earliest months — the
 * recent evidence is the evidence. A range stated backwards is turned the
 * right way round. A range not yet stated, or malformed, is the last twelve
 * complete months, which is what 'full-months' is — so choosing "custom" and
 * typing nothing changes nothing.
 */
export function clampCustomWindow(custom: SpendWindowCustom | undefined, now: Date): SpendWindowCustom {
  const cap = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  if (!custom || !MONTH_INPUT.test(custom.fromMonth) || !MONTH_INPUT.test(custom.toMonth)) {
    return { fromMonth: shiftMonth(cap, -11), toMonth: cap };
  }
  const ordered = custom.fromMonth <= custom.toMonth
    ? [custom.fromMonth, custom.toMonth]
    : [custom.toMonth, custom.fromMonth];
  const toMonth = ordered[1] < cap ? ordered[1] : cap;
  const fromMonth = ordered[0] < toMonth ? ordered[0] : toMonth;
  const earliest = shiftMonth(toMonth, -(MAX_CUSTOM_MONTHS - 1));
  return { fromMonth: fromMonth < earliest ? earliest : fromMonth, toMonth };
}

/**
 * The months a summary covers, from a given "now".
 *
 * Every named kind is exactly twelve months long — see the note on `monthly`.
 * 'custom' is whatever the user chose, clamped by `clampCustomWindow`.
 */
export function spendWindow(kind: SpendWindowKind, now: Date, custom?: SpendWindowCustom): SpendWindow {
  if (kind === 'full-months') {
    // The last COMPLETE month is the one before this one; the window is that
    // month and the eleven before it.
    const end = new Date(now.getFullYear(), now.getMonth(), 0);        // last day of last month
    const start = new Date(end.getFullYear(), end.getMonth() - 11, 1); // first day, 11 months earlier
    return { kind, from: iso(start), to: iso(end), months: 12 };
  }
  if (kind === 'custom') {
    // The range is `buildPlWindow`'s — the Plan page's own custom months — so
    // the two screens agree about what "Jan to Jun" holds; the clamping is
    // this module's, because only the guide refuses the month still running.
    const chosen = clampCustomWindow(custom, now);
    const pl = buildPlWindow('custom', now, chosen);
    const [year, month1, day] = pl.endExclusive.split('-').map(Number);
    return {
      kind,
      from: pl.start,
      to: iso(new Date(year, month1 - 1, day - 1)),
      months: monthsBetween(chosen.fromMonth, chosen.toMonth),
    };
  }
  if (kind === 'calendar-year' || kind === 'tax-year') {
    // A budgeter who thinks in calendar or tax years measures against the
    // last COMPLETE one (owner, 1 Sep 2026: "Some people may want to work on
    // calendar years"). The boundary rules — which year counts as complete,
    // and 6 April to 5 April for HMRC — already live in `buildPlWindow`
    // under the owner's own 19 Aug completeness ruling; deriving them here a
    // second time is how two screens come to disagree about a year. The end
    // is exclusive there and inclusive here, so step back one day BY PARTS —
    // parsing 'YYYY-MM-DD' through `new Date(string)` reads it as UTC
    // midnight and shifts a summer date across the day line (the localDayKey
    // lesson). Both years are exactly twelve months, so `monthly` stays
    // annual ÷ 12 like every other window.
    const pl = buildPlWindow(kind, now);
    const [year, month1, day] = pl.endExclusive.split('-').map(Number);
    return { kind, from: pl.start, to: iso(new Date(year, month1 - 1, day - 1)), months: 12 };
  }
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1); // yesterday
  const start = new Date(end.getFullYear(), end.getMonth() - 12, end.getDate() + 1);
  return { kind, from: iso(start), to: iso(end), months: 12 };
}

/**
 * What every category cost over the window — the table the budget screen is
 * built on, and the same classifier the reports use, so the two cannot
 * disagree about what counts as spending.
 */
export function summariseCategorySpend(
  transactions: Transaction[],
  splits: TransactionSplit[],
  categories: Category[],
  options: { kind?: SpendWindowKind; now?: Date; custom?: SpendWindowCustom } = {}
): CategorySpendSummary {
  const window = spendWindow(options.kind ?? 'full-months', options.now ?? new Date(), options.custom);
  const kinds = buildCategoryKindLookup(categories);

  const totals = new Map<string, { total: DecimalInstance; rows: number; byMonth: Map<string, DecimalInstance> }>();
  let unfiled = ZERO;
  let unfiledRows = 0;

  for (const row of expandSplitTransactions(transactions, splits)) {
    // `new Date(...)` around a value the type already calls a Date is the
    // house pattern (utils/incomeExpense does the same): the field is a Date
    // in the type and sometimes an ISO string at runtime, and this reads both.
    // Compared as ISO strings, which for YYYY-MM-DD is chronological order.
    const day = iso(new Date(row.date));
    if (day < window.from || day > window.to) continue;

    const kind = classifyFlow(row, kinds);
    // Spending only. An 'uncategorized' row is spending we cannot attribute,
    // which is a different thing from spending that did not happen.
    if (kind === 'uncategorized') {
      // Only the money going OUT: an unfiled credit is not unfiled spending.
      if (row.amount < 0) {
        unfiled = unfiled.plus(toDecimal(row.amount).abs());
        unfiledRows += 1;
      }
      continue;
    }
    if (kind !== 'expense') continue;

    const categoryId = row.category;
    if (!categoryId) continue;
    // Expenses are stored negative, so negating yields positive spending —
    // and a positive-amount refund correctly SUBTRACTS.
    const contribution = toDecimal(row.amount).negated();
    const current = totals.get(categoryId) ?? { total: ZERO, rows: 0, byMonth: new Map<string, DecimalInstance>() };
    const month = day.slice(0, 7);
    current.byMonth.set(month, (current.byMonth.get(month) ?? ZERO).plus(contribution));
    totals.set(categoryId, { total: current.total.plus(contribution), rows: current.rows + 1, byMonth: current.byMonth });
  }

  const byCategory = new Map<string, CategorySpend>();
  for (const [categoryId, { total, rows, byMonth }] of totals) {
    // Netted below zero means refunds outweighed spending: the window cost
    // nothing, and no budget follows from it.
    const cost = total.isNegative() ? ZERO : total;
    if (cost.isZero() && rows === 0) continue;
    // ONE division each, from the total: a twelve-month window's `annual` is
    // its total to the digit (no ÷12×12 round trip), and every window's
    // `monthly` is exactly a twelfth of its `annual`.
    const annual = window.months === 12 ? cost : cost.times(12).dividedBy(window.months);
    byCategory.set(categoryId, {
      categoryId,
      total: cost,
      annual,
      monthly: cost.dividedBy(window.months),
      rows,
      paidOnce: paidOnceIn(byMonth, cost, window.months),
    });
  }

  return { window, byCategory, unfiled, unfiledRows };
}

/**
 * Roll leaf spending up to the groups the categories sit under — the context
 * column, so a leaf figure can be read against the group it belongs to
 * (owner's ruling: budgets are set at the leaf, groups are shown for
 * context).
 *
 * Keyed by the GROUP's id. A leaf whose parent is missing from `categories`
 * contributes to nothing rather than to a phantom group.
 */
export function groupSubtotals(
  summary: CategorySpendSummary,
  categories: Category[]
): Map<string, DecimalInstance> {
  const parentOf = new Map(categories.map(c => [c.id, c.parentId ?? null]));
  const groups = new Map<string, DecimalInstance>();
  for (const spend of summary.byCategory.values()) {
    const parent = parentOf.get(spend.categoryId);
    if (!parent) continue;
    groups.set(parent, (groups.get(parent) ?? ZERO).plus(spend.annual));
  }
  return groups;
}

/**
 * The twin of a figure the user typed: a monthly budget's year, or a yearly
 * budget's month. The whole of the owner's "type either and see the other",
 * in one place so the screen and any future caller cannot disagree by a
 * rounding.
 */
export function twinOf(
  amount: DecimalInstance | number | string,
  typedAs: 'monthly' | 'yearly'
): DecimalInstance {
  const value = toDecimal(amount);
  return typedAs === 'monthly' ? value.times(12) : value.dividedBy(12);
}
