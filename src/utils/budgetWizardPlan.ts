/**
 * A BUDGET IS A PROPERTY OF ITS CATEGORY — the arithmetic behind the wizard
 * that sets them, kept pure so the screen above it only has to render.
 *
 * The owner's ruling (31 Aug 2026, signed off verbatim): a budget is not a
 * separate object that happens to share a category's name. It is one of that
 * category's properties, stored where it always was — the `budgets` table,
 * keyed by `category_id` — and shown through two lenses:
 *
 *   Manage → Categories   "WHAT IS SET".  Every category row carries its
 *                         budget, as stored, in its own column.
 *   Budget page           "HOW IS IT GOING". Untouched, reading the same rows.
 *
 * The wizard is the third door and the only one that WRITES in bulk, so every
 * rule about what a write means lives here, in one tested place, rather than
 * being re-derived by a component that also has to lay out a grid.
 *
 * ── THE WINDOW: TWELVE COMPLETE MONTHS ─────────────────────────────────────
 * The history is the last twelve COMPLETE calendar months. The current,
 * part-finished month is excluded — a budget set against a month that has not
 * happened yet is set against a category that reads low by however much of the
 * month is left, and every figure on the screen would be quietly short.
 *
 * The window is NAMED on screen ("Sep 2025 – Aug 2026") rather than described
 * ("the last year"), because those are different claims and only one of them
 * can be checked by the person reading it. The label is built with the app's
 * own locale seam (`getDateLocale`, en-GB by default) and the en-dash-with-
 * spaces separator the import screens already use for a month range, so the
 * same range never appears in two spellings.
 *
 * ── WHAT COUNTS AS SPENDING, AND WHAT IS NOT EVEN A ROW ────────────────────
 * Neither question is answered here from scratch. Both defer to the classifier
 * the reports use (`utils/incomeExpense`), reached two ways:
 *
 *   The HISTORY comes from `summariseCategorySpend`, which classifies every
 *   row with `classifyFlow` — so transfers between your own accounts are out
 *   (moving money is not spending it), income is out, and revaluations are out
 *   (a fund falling in value is not an expenditure). Splits are expanded, so a
 *   shop split between two categories lands in both.
 *
 *   The ROWS come from `categoryKindOf`, the same module's per-category half.
 *   A category is budgetable only if its own kind is 'expense'. That one test
 *   excludes income categories (out of scope for v1), the account transfer
 *   categories, the revaluation category and the importer's unassigned bucket
 *   — without this module holding its own list of special ids that could drift
 *   out of step with the reports'.
 *
 * ── EMPTY IS NOT ZERO ──────────────────────────────────────────────────────
 * The distinction the whole write depends on:
 *
 *   ''   (empty box)  UNBUDGETED. No budget row. If one existed, it is REMOVED
 *                     — clearing a figure is how you take a budget off, and
 *                     step 3 says so by name before anything happens.
 *   '0'  (typed zero) A REAL BUDGET, of nothing. "I intend to spend nothing
 *                     here" is a target somebody can be over. It is written.
 *
 * A box nobody has touched is a third state again: `undefined` rather than ''.
 * It means "as it was" — an existing budget survives untouched, a category
 * without one stays without one. Only a box somebody actually emptied removes.
 *
 * ── A WRITE HAPPENS ONLY WHERE THE MONEY CHANGED ───────────────────────────
 * Comparison is on the MONTHLY EQUIVALENT, never on the typed figure. Somebody
 * who has £1,200/yr stored, opens the wizard in monthly mode and leaves the
 * pre-filled £100 alone has changed nothing — and rewriting that row as
 * £100/mo would churn a stored period for no gain, breaking nothing visibly
 * but making a "12 budgets updated" report out of a session that updated none.
 *
 * ── PERIODS THE WIZARD CANNOT EXPRESS ARE LEFT ALONE ───────────────────────
 * `budgets.period` also allows 'weekly', 'quarterly' and 'custom'. The wizard
 * asks one question — months or years — so it has no honest way to re-express
 * a weekly allowance, and dividing one into a month is a guess (four weeks?
 * 4.348?). Such a row is shown with its stored figure, read-only, pointing at
 * the Budget page, and is in NEITHER list: never rewritten, never removed.
 * Refusing loudly beats converting quietly.
 *
 * ── A CHANGE OF RHYTHM CONVERTS WHAT WAS TYPED ─────────────────────────────
 * The owner, 2 Sep 2026, asked whether switching months for years should carry
 * the figures over: "Yes, it should convert." So typing £90 a month, going
 * back and choosing annually leaves £1,080 in the box — the same money said
 * the other way — rather than £90, which would turn a considered monthly
 * decision into a twelfth of itself without a word.
 *
 * HOW, and the choice is the whole of it: an entry holds THE STRING AS TYPED
 * together with the rhythm it was typed in, and every read converts from that
 * original (`entryInMode`). The alternative — converting the stored string in
 * place at each switch — cannot round-trip, and the counter-example is small
 * enough to be certain about: £100 a year is £8.33 a month, and £8.33 a month
 * is £99.96 a year. Two presses of Back would cost fourpence and twenty would
 * cost real money. Converting from the ORIGINAL each time makes a switch a
 * LENS RATHER THAN AN EDIT: 100 → 8.33 → 100, exactly, however often it is
 * turned over, because nothing anybody typed was ever overwritten.
 *
 * It also keeps the box typeable. A value canonicalised on every keystroke
 * would re-spell "12." as "12" while somebody was still on their way to 12.50.
 *
 * What is NOT converted: an empty box (emptied is emptied, in either rhythm)
 * and a figure that will not read as money — that one is shown exactly as
 * typed and reported by name in step 3, because converting a guess is guessing
 * twice.
 *
 * ── MONEY IS DECIMAL FROM END TO END ───────────────────────────────────────
 * Every figure in and out of this module is a Decimal. The typed string is
 * parsed by `parseMoneyInput` (the app's money parser: pennies, ROUND_HALF_UP,
 * and null for anything that is not a plain number) and is a Decimal from that
 * point on. The twin — ×12 or ÷12 — is Decimal arithmetic quantised to two
 * places, so £1,000/yr reads £83.33/mo rather than 83.33333333333333. A
 * converted entry is rounded by exactly that twin, so the box shows a sum
 * somebody can hold and every figure derived from it — the row's twin, the
 * group total, the scoreboard, the write — reads the box's own string rather
 * than a fuller one kept out of sight. The screen cannot show 8.33 and write
 * 8.3333.
 */

import { toDecimal, parseMoneyInput, type DecimalInstance } from './decimal';
import { categoryKindOf } from './incomeExpense';
import {
  spendWindow,
  summariseCategorySpend,
  type CategorySpendSummary,
  type SpendWindowCustom,
  type SpendWindowKind,
} from './categorySpendSummary';
import { getDateLocale } from './dateFormatter';
import { resolveBudgetAnchor } from './budgetPeriods';
import type { Budget, Category, Transaction, TransactionSplit } from '../types';
import { compareNames } from './localeFormat';

/** The wizard reads its window types from here, as it reads everything else. */
export type { SpendWindowCustom } from './categorySpendSummary';
export { clampCustomWindow } from './categorySpendSummary';

const ZERO = toDecimal(0);
const MONTHS_IN_YEAR = 12;

/** The two rhythms the wizard can write. `budgets.period` allows more (see the header). */
export type BudgetMode = 'monthly' | 'yearly';

/** Below this, two monthly figures are the same money — half a penny. */
const SAME_MONEY = toDecimal('0.005');

export interface BudgetHistoryWindow {
  /** Inclusive ISO date of the first day of the earliest complete month. */
  from: string;
  /** Inclusive ISO date of the last day of the most recent complete month. */
  to: string;
  /** "Sep 2025 – Aug 2026" — the range named, so it can be checked. */
  label: string;
  /**
   * How many months the range holds — twelve for every named kind, the
   * user's choice for 'custom'. When it is not twelve, "a year" and "a month"
   * in the grid are RATES over the window, and the screen says so.
   */
  months: number;
}

/**
 * The measurement windows the wizard offers: three named years, or months of
 * the user's choosing ('custom', owner 5 Nov 2026 — "a custom option for the
 * guide period").
 */
export type WizardWindowKind = Extract<SpendWindowKind, 'full-months' | 'calendar-year' | 'tax-year' | 'custom'>;

/**
 * The chosen window, named so it can be checked.
 *
 * 'full-months' (the default) is the twelve complete calendar months before
 * the month `now` falls in — the month `now` is in is never one of them,
 * INCLUDING on its last day: 31 August is still inside August, and August
 * completes at midnight. 'calendar-year' and 'tax-year' are the last
 * COMPLETE such year (owner, 1 Sep 2026: a calendar-year budgeter sets this
 * year's budgets against Jan–Dec of last year, part-way through and
 * unbothered). 'custom' is whole months from one to another, clamped by the
 * summariser's own rule (never the month still running, at most 36). The
 * RANGES all come from `spendWindow`, which is also what the summariser sums
 * over — one source, so the label and the figures cannot describe different
 * windows.
 */
export function budgetHistoryWindow(
  now: Date,
  kind: WizardWindowKind = 'full-months',
  custom?: SpendWindowCustom
): BudgetHistoryWindow {
  const window = spendWindow(kind, now, custom);
  const part = (isoDate: string): Date => {
    const [year, month1, day] = isoDate.split('-').map(Number);
    return new Date(year, month1 - 1, day);
  };
  const monthLabel = (d: Date): string =>
    d.toLocaleDateString(getDateLocale(), { month: 'short', year: 'numeric' });
  const dayLabel = (d: Date): string =>
    d.toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
  const from = part(window.from);
  const to = part(window.to);
  const label =
    kind === 'tax-year'
      ? // The 6th-to-5th boundary is the whole point of a tax year — month
        // names alone would print "Apr 2025 – Apr 2026" and look like an error.
        `${dayLabel(from)} – ${dayLabel(to)}`
      : kind === 'calendar-year'
        ? `${from.toLocaleDateString(getDateLocale(), { month: 'short' })} – ${monthLabel(to)}`
        : window.months === 1
          ? // One month has one name; "Jun 2026 – Jun 2026" would read as a mistake.
            monthLabel(to)
          : `${monthLabel(from)} – ${monthLabel(to)}`;
  return { from: window.from, to: window.to, label, months: window.months };
}

/**
 * The twin of a typed figure: a monthly budget's year, or a yearly budget's
 * month, at two places.
 *
 * Quantised here rather than at the point of display because the twin is a
 * MONEY figure in its own right — the thing the user is agreeing to when they
 * press apply — and £83.33333… is not a sum anybody can hold.
 */
export function twinFigure(amount: DecimalInstance | number | string, typedAs: BudgetMode): DecimalInstance {
  const value = toDecimal(amount);
  const twin = typedAs === 'monthly' ? value.times(MONTHS_IN_YEAR) : value.dividedBy(MONTHS_IN_YEAR);
  return twin.toDecimalPlaces(2);
}

/** A stored amount as its per-month equivalent — the currency every comparison is made in. */
export function monthlyEquivalent(amount: DecimalInstance | number | string, period: BudgetMode): DecimalInstance {
  const value = toDecimal(amount);
  return period === 'monthly' ? value : value.dividedBy(MONTHS_IN_YEAR);
}

/**
 * A figure ready to sit IN a box: two places, plain, no symbol and no
 * thousands separator, because it is going into a text input the user then
 * edits and types over. `formatCurrency` is for reading; this is for typing.
 */
export function boxFigure(amount: DecimalInstance | number | string): string {
  return toDecimal(amount).toDecimalPlaces(2).toString();
}

/** A stored amount in the mode being typed, ready to pre-fill a box. */
export function amountInMode(
  amount: DecimalInstance | number | string,
  storedAs: BudgetMode,
  mode: BudgetMode
): DecimalInstance {
  const value = toDecimal(amount);
  if (storedAs === mode) return value.toDecimalPlaces(2);
  return twinFigure(value, storedAs);
}

/**
 * The stored period as one of the two the wizard writes — or null when it is
 * one it refuses to re-express (see the header). Blank/absent reads as
 * monthly, which is what a budget without a stated period means everywhere
 * else in the app (`utils/budgetPeriods` makes the same choice for the same
 * reason).
 */
export function wizardPeriodOf(period: string | null | undefined): BudgetMode | null {
  const value = (period ?? '').trim().toLowerCase();
  if (value === '' || value === 'monthly') return 'monthly';
  if (value === 'yearly' || value === 'annual' || value === 'annually') return 'yearly';
  return null;
}

/** "/mo", "/yr" — the suffix that makes a bare amount a rate, for the Categories column. */
export function budgetPeriodSuffix(period: string | null | undefined): string {
  switch ((period ?? '').trim().toLowerCase()) {
    case 'weekly': return '/wk';
    case 'biweekly':
    case 'bi-weekly': return '/fortnight';
    case 'quarterly': return '/qtr';
    case 'yearly':
    case 'annual':
    case 'annually': return '/yr';
    case 'custom': return '';
    // An interval of the user's own has no one-word suffix; the card says it in full.
    case 'every': return '';
    default: return '/mo';
  }
}

/** A budget already stored against a category, as the wizard needs to read it. */
export interface ExistingBudget {
  id: string;
  categoryId: string;
  amount: DecimalInstance;
  /** null when the stored period is one the wizard will not re-express. */
  period: BudgetMode | null;
  /** The raw stored period, for the read-only note on a refused row. */
  storedPeriod: string;
  /**
   * The day the budget's cycles are counted from, as an ISO date — or null
   * for a legacy row that keeps the calendar (see utils/budgetPeriods). What
   * "Run these budgets from" compares against to know which rows a chosen
   * start would move.
   */
  anchor: string | null;
}

/** One line of the grid: a category, what it cost, and what is budgeted on it. */
export interface WizardRow {
  category: Category;
  /** The group this row sits under — '' for a row with no parent group. */
  groupName: string;
  groupId: string | null;
  /**
   * What the window cost at a year's rate, positive, netted of refunds — the
   * window's total for a twelve-month window, scaled to twelve months otherwise.
   */
  annual: DecimalInstance;
  /** The same at a month's rate — exactly annual ÷ 12, whatever the window. */
  monthly: DecimalInstance;
  /** How many rows made the figure up: evidence it is not one freak charge. */
  rows: number;
  existing: ExistingBudget | null;
  /** True when this row takes typing. False for a parent shown only as a subtotal. */
  editable: boolean;
}

/** A parent and the rows filed under it, with its display-only roll-up. */
export interface WizardGroup {
  id: string;
  name: string;
  /** Sum of the children's years — context, never an input. */
  annual: DecimalInstance;
  monthly: DecimalInstance;
  rows: WizardRow[];
}

/**
 * Every budget the wizard can see, indexed by category.
 *
 * Inactive budgets are skipped: a deactivated budget is one the user has
 * already taken out of play on the Budget page, and resurrecting it here
 * because the wizard happened to touch its category would undo that silently.
 * Where a category somehow carries two active budgets, the FIRST wins and the
 * rest are ignored rather than being fought over — the wizard writes one
 * budget per category, which is the invariant the whole model rests on.
 */
export function indexExistingBudgets(budgets: Budget[]): Map<string, ExistingBudget> {
  const byCategory = new Map<string, ExistingBudget>();
  for (const budget of budgets) {
    if (budget.isActive === false) continue;
    if (!budget.categoryId || byCategory.has(budget.categoryId)) continue;
    byCategory.set(budget.categoryId, {
      id: budget.id,
      categoryId: budget.categoryId,
      amount: toDecimal(budget.amount),
      period: wizardPeriodOf(budget.period),
      storedPeriod: budget.period,
      anchor: resolveBudgetAnchor(budget),
    });
  }
  return byCategory;
}

/**
 * Where a stored budget runs from, in words: its anchor as a day, or the
 * calendar period a legacy row still keeps. Step 3 names it beside the count
 * of budgets a chosen start would move, so the move is checkable.
 */
export function describeAnchor(existing: Pick<ExistingBudget, 'anchor' | 'period'>): string {
  if (existing.anchor === null) return existing.period === 'yearly' ? 'the calendar year' : 'the calendar month';
  const [year, month1, day] = existing.anchor.split('-').map(Number);
  return new Date(year, month1 - 1, day).toLocaleDateString(getDateLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// ── "RUN THESE BUDGETS FROM" ────────────────────────────────────────────────
//
// The question the wizard never asked (owner, 5 Nov 2026). A budget is an
// allowance for a cycle counted from its start, so the save has to say which
// day that is. The choices are the boundaries a person actually budgets from:
// this month, next month, the next calendar year, the next tax year — or any
// day they name. The 1st of the current month is the default by the owner's
// ruling: a budget that starts on the 5th invites the same confusion as one
// that starts on the 29th, and every product in the field defaults to a
// period boundary. Someone paid on the 15th chooses the 15th under "Another
// date", and their months then run 15th to 14th.

export type RunFromKind = 'this-month' | 'next-month' | 'next-calendar-year' | 'next-tax-year' | 'custom';

export interface RunFromOption {
  kind: Exclude<RunFromKind, 'custom'>;
  /** ISO date of the first day. */
  date: string;
  /** "This month — 1 Nov 2026": the choice AND the day it means, so it can be checked. */
  label: string;
}

const isoDayOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The four dated choices, as they stand on `now`. */
export function runFromOptions(now: Date): RunFromOption[] {
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const nextCalendarYear = new Date(now.getFullYear() + 1, 0, 1);
  // The next 6 April strictly after today: on 6 April itself the tax year
  // beginning today has begun, so "the next" one is a year off.
  const pastApril6 = now.getMonth() > 3 || (now.getMonth() === 3 && now.getDate() >= 6);
  const nextTaxYear = new Date(now.getFullYear() + (pastApril6 ? 1 : 0), 3, 6);
  const day = (d: Date): string =>
    d.toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
  return [
    { kind: 'this-month', date: isoDayOf(thisMonth), label: `This month — ${day(thisMonth)}` },
    { kind: 'next-month', date: isoDayOf(nextMonth), label: `Next month — ${day(nextMonth)}` },
    { kind: 'next-calendar-year', date: isoDayOf(nextCalendarYear), label: `The next calendar year — ${day(nextCalendarYear)}` },
    { kind: 'next-tax-year', date: isoDayOf(nextTaxYear), label: `The next tax year — ${day(nextTaxYear)}` },
  ];
}

/**
 * The day a choice means, or null when "Another date" has not yet been given
 * one — in which case there is nothing to write and the save waits.
 */
export function runFromDate(kind: RunFromKind, now: Date, custom: string): string | null {
  if (kind === 'custom') {
    const trimmed = custom.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) && Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
  }
  return runFromOptions(now).find(option => option.kind === kind)?.date ?? null;
}

/**
 * Is this a category a budget can be a property OF?
 *
 * Expense kinds only, and active ones. `categoryKindOf` is the reports' own
 * per-category classifier, so transfer categories, the revaluation category
 * and the unassigned bucket are excluded by the same rule that keeps their
 * transactions out of the history — one decision, not two that can drift.
 */
export function isBudgetableCategory(category: Category): boolean {
  if (category.isActive === false) return false;
  return categoryKindOf(category) === 'expense';
}

/**
 * The grid: budgetable categories, their history and their budgets.
 *
 * WHERE THE INPUTS GO. Transactions are filed at the DETAIL level, so that is
 * where a budget can be measured without ambiguity and that is where the boxes
 * are. A parent ('sub') row shows its children's roll-up and takes no typing —
 * budgeting both a group and its children would double-count, and which of the
 * two the Budget page should measure would be a question with two answers.
 *
 * ONE EXCEPTION, and it is not an invention: a group that ALREADY has a budget
 * gets a box. The wizard edits the world as it is, and a group budget somebody
 * set on the Budget page is part of that world — showing it read-only would
 * make step 3's total disagree with the Budget page, and hiding it would offer
 * a "remove" the user never got to make. The wizard never CREATES one.
 */
export function buildWizardRows(
  summary: CategorySpendSummary,
  categories: Category[],
  budgets: Budget[]
): WizardRow[] {
  const existingByCategory = indexExistingBudgets(budgets);
  const nameById = new Map(categories.map(c => [c.id, c.name]));

  return categories
    .filter(isBudgetableCategory)
    .filter(c => c.level === 'detail' || existingByCategory.has(c.id))
    .map(category => {
      const spend = summary.byCategory.get(category.id);
      const parentId = category.parentId ?? null;
      return {
        category,
        groupId: parentId,
        groupName: (parentId !== null ? nameById.get(parentId) : undefined) ?? '',
        annual: spend?.annual ?? ZERO,
        monthly: spend?.monthly ?? ZERO,
        rows: spend?.rows ?? 0,
        existing: existingByCategory.get(category.id) ?? null,
        editable: true,
      };
    });
}

/**
 * The rows arranged as the grid shows them: under their parent, biggest spend
 * first inside each group, biggest group first.
 *
 * Biggest-first because that is the order the decisions matter in — the
 * categories worth arguing about are the ones with money in them — and a name
 * tie-break so the order is stable rather than dependent on load order.
 */
export function groupWizardRows(rows: WizardRow[]): WizardGroup[] {
  const byGroup = new Map<string, WizardGroup>();
  const byName = (a: WizardRow, b: WizardRow): number =>
    compareNames(a.category.name, b.category.name);

  for (const row of rows) {
    const id = row.groupId ?? '';
    const group = byGroup.get(id) ?? { id, name: row.groupName, annual: ZERO, monthly: ZERO, rows: [] };
    group.rows.push(row);
    group.annual = group.annual.plus(row.annual);
    group.monthly = group.monthly.plus(row.monthly);
    byGroup.set(id, group);
  }

  for (const group of byGroup.values()) {
    group.rows.sort((a, b) => b.annual.comparedTo(a.annual) || byName(a, b));
  }

  return [...byGroup.values()].sort(
    (a, b) =>
      b.annual.comparedTo(a.annual) ||
      compareNames(a.name, b.name)
  );
}

/**
 * One box somebody has typed in: the string exactly as they typed it, and the
 * rhythm the screen was in at the time.
 *
 * BOTH HALVES ARE LOAD-BEARING. The string is kept unaltered so a box can be
 * typed in at all (a figure re-spelled between keystrokes cannot be); the
 * rhythm is kept so a later switch converts from what was meant rather than
 * from a figure some earlier switch already rounded. See the header.
 */
export interface WizardEntry {
  readonly value: string;
  readonly typedAs: BudgetMode;
}

/**
 * What the user has typed, by category id.
 *
 * ABSENT   the box has not been touched — leave the world as it is.
 * ''       emptied — unbudgeted, and REMOVE any budget that was there.
 * '0'      a deliberate zero, which is a budget and is written.
 */
export type WizardEntries = Readonly<Record<string, WizardEntry | undefined>>;

/**
 * A typed entry as the rhythm now being typed reads it — the conversion the
 * owner ruled on, 2 Sep 2026, in the one place every reader goes through.
 *
 * Same rhythm: the string back, untouched, including its half-typed decimal
 * point. Otherwise the twin, rounded to the penny exactly as the row's twin is
 * rounded, so what the box says and what the wizard writes are one figure.
 *
 * Two strings pass through unconverted, and neither is an oversight: an empty
 * box (emptied is a decision about the budget, not about the rhythm) and one
 * that will not read as money (never guessed at — step 3 names it instead).
 */
export function entryInMode(entry: WizardEntry, mode: BudgetMode): string {
  if (entry.typedAs === mode || entry.value.trim() === '') return entry.value;
  const parsed = parseMoneyInput(entry.value);
  if (parsed === null) return entry.value;
  return boxFigure(twinFigure(parsed, entry.typedAs));
}

/**
 * What a box actually holds: what was typed, else what is stored, else empty.
 *
 * ONE function, because the grid DRAWS the boxes and three separate totals SUM
 * them, and a screen where the drawing and the summing disagree is the bug
 * this was written to make impossible. A row the wizard will not re-express
 * reads empty here for the same reason its box is read-only: nothing in it is
 * being typed.
 */
export function wizardBoxValue(row: WizardRow, entries: WizardEntries, mode: BudgetMode): string {
  const typed = entries[row.category.id];
  if (typed !== undefined) return entryInMode(typed, mode);
  if (row.existing === null || row.existing.period === null) return '';
  return boxFigure(amountInMode(row.existing.amount, row.existing.period, mode));
}

/** What a set of boxes adds up to, both ways round, and how many were filled. */
export interface WizardBudgetTotal {
  /** The sum in the mode being typed — the figure under "Your budget, per …". */
  typed: DecimalInstance;
  /** The same money the other way round — the figure under "Which is …". */
  twin: DecimalInstance;
  /**
   * How many boxes carried a figure. ZERO MEANS THERE IS NO TOTAL, not a
   * total of zero: an empty box is unbudgeted and £0.00 is a budget of
   * nothing, and a screen that prints the second when it means the first has
   * invented a decision nobody made.
   */
  boxes: number;
}

/**
 * The running total of a set of boxes — the scoreboard's "Budgeted so far"
 * over every row, and each group heading's own figure over its own rows.
 *
 * ONE piece of arithmetic for both (owner, 2 Sep 2026: "There should be a
 * total for each category grouping"), so the group figures and the strip above
 * them can never disagree: in the mode being typed the group totals ADD UP to
 * the scoreboard's, exactly, because they are the same sum taken over disjoint
 * sets of the same boxes.
 *
 * Summed as a YEAR and turned back into a month once at the end, never row by
 * row: that is the currency `planBudgetWrites` compares in, and dividing
 * twelve rows before adding them rounds twelve times instead of once.
 *
 * Left out, here and in the write both: a stored period the wizard will not
 * re-express (a week does not divide into a month without a guess) and a
 * figure that will not parse as money (named in step 3, never guessed at).
 */
export function totalBudgeted(
  rows: WizardRow[],
  entries: WizardEntries,
  mode: BudgetMode
): WizardBudgetTotal {
  let annual = ZERO;
  let boxes = 0;

  for (const row of rows) {
    if (row.existing !== null && row.existing.period === null) continue;
    const value = wizardBoxValue(row, entries, mode);
    if (value.trim() === '') continue;
    const parsed = parseMoneyInput(value);
    if (parsed === null || parsed < 0) continue;
    const amount = toDecimal(parsed);
    annual = annual.plus(mode === 'monthly' ? amount.times(MONTHS_IN_YEAR) : amount);
    boxes += 1;
  }

  const perYear = annual.toDecimalPlaces(2);
  const perMonth = twinFigure(annual, 'yearly');
  return mode === 'monthly'
    ? { typed: perMonth, twin: perYear, boxes }
    : { typed: perYear, twin: perMonth, boxes };
}

export interface BudgetUpsert {
  categoryId: string;
  categoryName: string;
  /** Present when this edits a stored budget; absent when it creates one. */
  budgetId?: string;
  /** The figure to store, in `period`. Always two places. */
  amount: DecimalInstance;
  period: BudgetMode;
  /** The same money per month — what the totals are summed in. */
  monthly: DecimalInstance;
  /** The day the budget's cycles are counted from — the chosen "run from". Absent only while none is chosen. */
  startDate?: string;
}

export interface BudgetRemoval {
  budgetId: string;
  categoryId: string;
  categoryName: string;
}

/**
 * A stored budget the save is NOT otherwise touching, whose cycles run from a
 * different day than the one chosen. Moving it is a separate, explicit act —
 * step 3 offers it with a count and the days it would move from, and the
 * wizard writes these only when that offer is taken. Nothing inherits a start
 * silently.
 */
export interface BudgetRedate {
  budgetId: string;
  categoryId: string;
  categoryName: string;
  /** Where it runs from today, in words — see describeAnchor. */
  from: string;
}

/** A row whose typed figure could not be read as money — reported, never guessed at. */
export interface BudgetRejection {
  categoryId: string;
  categoryName: string;
  raw: string;
}

export interface BudgetWritePlan {
  upserts: BudgetUpsert[];
  removals: BudgetRemoval[];
  rejections: BudgetRejection[];
  /** Budgets the save does not touch that a chosen start would move — offered, never assumed. */
  redatable: BudgetRedate[];
  /** The chosen "run from", carried so the confirmation and the write name one day. */
  startDate: string | null;
  /** How many categories carry a budget once this plan is applied. */
  budgetedCount: number;
  /** The per-month total of every budget that will exist afterwards. */
  monthlyTotal: DecimalInstance;
  /** The same total per year — monthlyTotal × 12, at two places. */
  annualTotal: DecimalInstance;
  /** What those same categories actually cost over the window. */
  spentTotal: DecimalInstance;
  /**
   * annualTotal − spentTotal. POSITIVE means the budgets allow more than the
   * year cost (headroom); NEGATIVE means they allow less than was really
   * spent, which is the number worth saying out loud.
   */
  difference: DecimalInstance;
}

/**
 * The whole write, decided before anything is written.
 *
 * Given the world (rows carrying their existing budgets) and the wizard's
 * state (what was typed, in which mode), produce the two lists — and the
 * totals step 3 shows, computed from the SAME lists the apply pass walks, so
 * the confirmation cannot describe a different write from the one that runs.
 *
 * A row with a period the wizard will not re-express is passed over entirely:
 * it is in neither list, and its money is still counted in the totals, because
 * it will still exist afterwards and pretending otherwise would understate
 * what the user is committing to.
 *
 * `startDate` — the chosen "run from" — goes on every row the save writes.
 * A row the save would NOT otherwise write (untouched, or re-typed to the
 * same money) whose cycles run from a different day is listed in `redatable`
 * instead: moving it is offered in step 3, and the wizard writes it only when
 * the offer is taken.
 */
export function planBudgetWrites(
  rows: WizardRow[],
  entries: WizardEntries,
  mode: BudgetMode,
  options: { startDate?: string | null } = {}
): BudgetWritePlan {
  const startDate = options.startDate ?? null;
  const upserts: BudgetUpsert[] = [];
  const removals: BudgetRemoval[] = [];
  const rejections: BudgetRejection[] = [];
  const redatable: BudgetRedate[] = [];
  let monthlyTotal = ZERO;
  let spentTotal = ZERO;
  let budgetedCount = 0;

  /** This row will carry `monthly` a month afterwards; count it in the totals. */
  const willBudget = (row: WizardRow, monthly: DecimalInstance): void => {
    budgetedCount += 1;
    monthlyTotal = monthlyTotal.plus(monthly);
    spentTotal = spentTotal.plus(row.annual);
  };

  /** A budget left as it is, whose start the chosen day would move. */
  const offerRedate = (row: WizardRow, existing: ExistingBudget): void => {
    if (startDate === null || existing.anchor === startDate) return;
    redatable.push({
      budgetId: existing.id,
      categoryId: row.category.id,
      categoryName: row.category.name,
      from: describeAnchor(existing),
    });
  };

  for (const row of rows) {
    const entry = entries[row.category.id];
    /**
     * THE FIGURE AS THE BOX SHOWS IT, never the string as it was typed: a
     * £100-a-year entry looked at in monthly mode is the £8.33 on screen, and
     * writing 100 as a MONTHLY budget because that is what the keystrokes said
     * would be a twelvefold error nobody could see coming. `entryInMode` is
     * the same conversion `wizardBoxValue` draws with, so the confirmation,
     * the totals and the write are one figure. See the header.
     */
    const raw = entry === undefined ? undefined : entryInMode(entry, mode);
    const existing = row.existing;

    // A stored period the wizard cannot express: untouchable, but real, and
    // its money still counts towards what the user is agreeing to.
    if (existing !== null && existing.period === null) {
      budgetedCount += 1;
      spentTotal = spentTotal.plus(row.annual);
      continue;
    }

    // UNTOUCHED — the world stands. An existing budget carries on, converted
    // to a month for the total only; nothing is written and its stored period
    // is not disturbed.
    if (raw === undefined) {
      if (existing !== null && existing.period !== null) {
        willBudget(row, monthlyEquivalent(existing.amount, existing.period));
        offerRedate(row, existing);
      }
      continue;
    }

    // EMPTIED — unbudgeted. Removal only where there was something to remove.
    if (raw.trim() === '') {
      if (existing !== null) {
        removals.push({
          budgetId: existing.id,
          categoryId: row.category.id,
          categoryName: row.category.name,
        });
      }
      continue;
    }

    // TYPED — money, or nothing at all. A figure that will not parse is never
    // guessed at: the row is reported and left exactly as it was.
    const parsed = parseMoneyInput(raw);
    if (parsed === null || parsed < 0) {
      rejections.push({ categoryId: row.category.id, categoryName: row.category.name, raw });
      if (existing !== null && existing.period !== null) {
        willBudget(row, monthlyEquivalent(existing.amount, existing.period));
      }
      continue;
    }

    const amount = toDecimal(parsed);
    const monthly = monthlyEquivalent(amount, mode);
    willBudget(row, monthly);

    // Unchanged money is not a write — compared as months, so switching mode
    // without changing the figure writes nothing (see the header).
    if (existing !== null && existing.period !== null) {
      const before = monthlyEquivalent(existing.amount, existing.period);
      if (before.minus(monthly).abs().lessThan(SAME_MONEY)) {
        offerRedate(row, existing);
        continue;
      }
    }

    upserts.push({
      categoryId: row.category.id,
      categoryName: row.category.name,
      ...(existing !== null ? { budgetId: existing.id } : {}),
      amount,
      period: mode,
      monthly,
      ...(startDate !== null ? { startDate } : {}),
    });
  }

  const annualTotal = monthlyTotal.times(MONTHS_IN_YEAR).toDecimalPlaces(2);
  return {
    upserts,
    removals,
    rejections,
    redatable,
    startDate,
    budgetedCount,
    monthlyTotal: monthlyTotal.toDecimalPlaces(2),
    annualTotal,
    spentTotal: spentTotal.toDecimalPlaces(2),
    difference: annualTotal.minus(spentTotal.toDecimalPlaces(2)),
  };
}

/**
 * The history for the whole wizard, over the chosen window.
 *
 * A thin composition on purpose: the aggregation itself is
 * `summariseCategorySpend`, which the reports' classifier drives, so this
 * screen and the reports can never disagree about what a category cost. The
 * window is the one `budgetHistoryWindow` names, from the same arguments.
 */
export function summariseForWizard(
  transactions: Transaction[],
  splits: TransactionSplit[],
  categories: Category[],
  now: Date,
  kind: WizardWindowKind = 'full-months',
  custom?: SpendWindowCustom
): CategorySpendSummary {
  return summariseCategorySpend(transactions, splits, categories, { kind, now, custom });
}
