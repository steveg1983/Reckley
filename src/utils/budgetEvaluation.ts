/**
 * ONE evaluation of a budget — allowance, spend, window, and the rows behind
 * the figure — for every surface that quotes one.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * utils/budgetSpending already made the SUM one calculation. What was still
 * done twice was everything around the sum: which category a budget means
 * (a budget saved by the old picker carries a category NAME where the id
 * belongs), whether a group budget rolls its children up, what the allowance
 * is once a carry is counted in, and above all WHICH WINDOW the budget is
 * measured over. The Budget page did all of that; the Dashboard's Budget
 * Status card did none of it — it summed the budget's own category over a
 * rolling thirty days against the base amount, so the same budget read one
 * figure on the Dashboard and another on the Budget page, and the Dashboard's
 * could not say what period it was for because it was not any period a
 * budget has (the owner, 15 Oct 2026: "I cannot easily see what period that
 * is for").
 *
 * So the whole evaluation is here, once. Both surfaces call it with the same
 * inputs and show the same numbers under the same caption, and the Dashboard
 * can open the rows behind a figure because this returns them.
 *
 * ── THE CARRY IS DERIVED, NEVER STORED (7 Nov 2026, the owner's "3") ────────
 * A budget's `rolloverMode` says what the gap at the end of each cycle does:
 * nothing ('none', the default and the owner's own choice), a surplus carried
 * into the next cycle, an overspend carried, or both. The carry into the
 * window being measured is worked out HERE, from the cycles before it: from
 * the budget's first cycle forward, each cycle's allowance is the plan plus
 * what the cycle before left it, less what it spent, and what that leaves —
 * kept under the mode — is the next cycle's carry. Nothing is written back.
 * The old build stored a carry a person applied by hand, month by month,
 * from a fold on the Budget page: a stored figure went stale the moment a
 * row behind it changed, and the fold assumed every budget was monthly. A
 * derived one follows the ledger, means the same thing for a year as for a
 * week, and costs one extra pass over the budget's own rows.
 *
 * ── WHAT COMES BACK ─────────────────────────────────────────────────────────
 * Decimal throughout — callers convert at the edge, as the Budget page always
 * did. `remaining` is SIGNED: an overspent budget reads "over by £155", not
 * "£0 remaining" (see calculateBudgetRemaining for the floored figure and who
 * it is for). `countedRowIds` names the expanded rows the sum was taken over
 * — split lines by their synthetic id — so a drill shows exactly what was
 * counted and nothing a second filter might have chosen differently.
 */

import type { Budget, BudgetRolloverMode, Category, Transaction, TransactionSplit } from '../types/index.js';
import { toDecimal } from './decimal.js';
import type { DecimalInstance } from './decimal.js';
import {
  calculateBudgetPercentage,
  calculateBudgetSpendingBreakdown,
  type BudgetSpendingFilter,
  type DatedDecimalTransaction,
} from './calculations-decimal.js';
import { normaliseRolloverMode, previousBudgetWindow, type BudgetPeriodWindow } from './budgetPeriods.js';
import {
  buildCategoryChildIndex,
  calculateBudgetSpend,
  collectBudgetCategoryIds,
  prepareBudgetTransactions,
} from './budgetSpending.js';

/** Enough of a category to resolve a budget's target and walk its children. */
export type BudgetCategoryRef = Pick<Category, 'id' | 'name' | 'parentId'>;

/**
 * The category a budget means, by id.
 *
 * Legacy healing on the SPEND path, not just in the modal: budgets saved by the
 * old picker carry a category NAME where the id belongs (some under a legacy
 * `category` field), and matched nothing until each was opened and re-saved. A
 * name that resolves to a current category is read as that category; anything
 * else is left as stored, so an unknown id still matches nothing rather than
 * something else.
 */
export function buildBudgetCategoryResolver(
  categories: readonly BudgetCategoryRef[]
): (budget: Pick<Budget, 'categoryId'>) => string {
  const ids = new Set<string>();
  const idByName = new Map<string, string>();
  for (const category of categories) {
    if (!category?.id) continue;
    ids.add(category.id);
    if (category.name) idByName.set(category.name, category.id);
  }
  return (budget) => {
    if (budget.categoryId && ids.has(budget.categoryId)) return budget.categoryId;
    const legacy = (budget as Pick<Budget, 'categoryId'> & { category?: string }).category ?? budget.categoryId;
    return (legacy && idByName.get(legacy)) || budget.categoryId;
  };
}

export interface EvaluatedBudget<B extends Budget = Budget> {
  /** The budget as stored. */
  budget: B;
  /** The category the budget means — healed, see buildBudgetCategoryResolver. */
  categoryId: string;
  /** The allowance for the window: the amount plus the carry. */
  effectiveAmount: DecimalInstance;
  /** The mode the budget runs under — 'none' for a row that states none. */
  rolloverMode: BudgetRolloverMode;
  /**
   * What the cycles before this one left behind, SIGNED, under that mode:
   * zero under 'none', in a first cycle, or when nothing was left.
   */
  carriedIn: DecimalInstance;
  /** The cycle before the window — where a carry comes out of — or null in a first cycle. */
  carriedFrom: BudgetPeriodWindow | null;
  /** Net spend in the window — positive magnitude, refunds deducted. */
  spent: DecimalInstance;
  /** Allowance less spend, SIGNED: negative is how far over. */
  remaining: DecimalInstance;
  /** Spend as a percentage of the allowance; 0 for a zero allowance. */
  percentage: number;
  /** The period the budget is being measured over right now. */
  window: BudgetPeriodWindow;
  /** The expanded rows the spend was summed from, by id — what a drill shows. */
  countedRowIds: ReadonlySet<string>;
  /** In-window rows left out because their account is in another currency. */
  excludedForeignCount: number;
}

export interface EvaluateBudgetsInput {
  transactions: Transaction[];
  transactionSplits?: TransactionSplit[];
  categories: readonly BudgetCategoryRef[];
  /** Accounts held in another currency — see foreignCurrencyAccountIds. */
  foreignAccountIds?: ReadonlySet<string>;
  /** One evaluation instant for the whole set. Defaults to now. */
  now?: Date;
}

/**
 * How many earlier cycles the walk will visit at most. A weekly budget
 * running since 2003 has fewer; this guards against a model that never
 * answers "first", not a case anyone meets.
 */
const MAX_CARRY_CYCLES = 1200;

/** What a cycle's remainder becomes under a mode: only its surplus, only its overspend, all of it, or nothing. */
function keptUnder(mode: BudgetRolloverMode, remainder: DecimalInstance): DecimalInstance {
  switch (mode) {
    case 'surplus':
      return remainder.greaterThan(0) ? remainder : toDecimal(0);
    case 'overspend':
      return remainder.lessThan(0) ? remainder : toDecimal(0);
    case 'both':
      return remainder;
    case 'none':
      return toDecimal(0);
  }
}

/** One completed cycle of a budget, as the history shows it (7 Nov 2026, the owner's "7"). */
export interface BudgetCycleFigures {
  /** The cycle's days. */
  window: BudgetPeriodWindow;
  /** What the cycle before handed it, SIGNED, under the mode; zero in the first cycle. */
  carriedIn: DecimalInstance;
  /** The plan plus the carry. */
  allowance: DecimalInstance;
  /** Net spend in the cycle. */
  spent: DecimalInstance;
  /** Allowance less spend, SIGNED. */
  remaining: DecimalInstance;
  /** What it handed to the next cycle, SIGNED, under the mode. */
  carriedOut: DecimalInstance;
}

/**
 * Every cycle before `window`, oldest first, each with its figures — the
 * walk the carry comes out of, and what the history shows (see the header).
 *
 * The rows of every earlier cycle are taken in ONE pass over the prepared
 * set, so each cycle's own sum walks only the budget's rows; the cycles are
 * then summed oldest first, each handing what it kept to the next.
 */
function cyclesBefore(
  budget: Budget,
  categoryId: string,
  window: BudgetPeriodWindow,
  mode: BudgetRolloverMode,
  prepared: DatedDecimalTransaction[],
  filter: BudgetSpendingFilter
): BudgetCycleFigures[] {
  const windows: BudgetPeriodWindow[] = [];
  for (
    let cycle = previousBudgetWindow(budget, window);
    cycle && windows.length < MAX_CARRY_CYCLES;
    cycle = previousBudgetWindow(budget, cycle)
  ) {
    windows.push(cycle);
  }
  if (windows.length === 0) return [];
  windows.reverse();

  const earlier = calculateBudgetSpendingBreakdown(
    { categoryId },
    prepared,
    windows[0].start,
    windows[windows.length - 1].end,
    filter
  ).counted;
  const plan = toDecimal(budget.amount);
  let carry = toDecimal(0);
  return windows.map(cycle => {
    const { spent } = calculateBudgetSpendingBreakdown({ categoryId }, earlier, cycle.start, cycle.end, {
      categoryIds: filter.categoryIds,
    });
    const carriedIn = carry;
    const allowance = plan.plus(carriedIn);
    const remaining = allowance.minus(spent);
    carry = keptUnder(mode, remaining);
    return { window: cycle, carriedIn, allowance, spent, remaining, carriedOut: carry };
  });
}

/**
 * The carry into `window`, and the cycle it comes out of (see the header).
 * Under 'none' nothing is carried, so the walk is not made.
 */
function carryInto(
  budget: Budget,
  categoryId: string,
  window: BudgetPeriodWindow,
  prepared: DatedDecimalTransaction[],
  filter: BudgetSpendingFilter
): { mode: BudgetRolloverMode; carriedIn: DecimalInstance; carriedFrom: BudgetPeriodWindow | null } {
  const mode = normaliseRolloverMode(budget.rolloverMode);
  const carriedFrom = previousBudgetWindow(budget, window);
  if (mode === 'none' || !carriedFrom) return { mode, carriedIn: toDecimal(0), carriedFrom };
  const cycles = cyclesBefore(budget, categoryId, window, mode, prepared, filter);
  const last = cycles[cycles.length - 1];
  return { mode, carriedIn: last ? last.carriedOut : toDecimal(0), carriedFrom };
}

/**
 * ONE budget's completed cycles, oldest first, each with its figures — "how
 * has this budget run" (the owner's "7", 7 Nov 2026) — plus the one being
 * measured now. Called when a history is opened, not for every card: the
 * walk under 'none' is a cost the card itself never pays.
 */
export function evaluateBudgetHistory(
  budget: Budget,
  input: EvaluateBudgetsInput
): { current: EvaluatedBudget; past: BudgetCycleFigures[] } {
  const [current] = evaluateBudgets([budget], input);
  const prepared = prepareBudgetTransactions(input.transactions, input.transactionSplits ?? []);
  const categoryIds = collectBudgetCategoryIds(current.categoryId, buildCategoryChildIndex(input.categories));
  const past = cyclesBefore(budget, current.categoryId, current.window, current.rolloverMode, prepared, {
    categoryIds: categoryIds.size > 1 ? categoryIds : undefined,
    excludeAccountIds: input.foreignAccountIds,
  });
  return { current, past };
}

/**
 * Evaluate every budget given, in the order given, as at one instant.
 *
 * Splits are expanded and amounts decimalised ONCE for the whole set; a group
 * budget counts every category beneath its own; a detail budget keeps the
 * plain equality match it always had (a single-id set is the same thing).
 */
export function evaluateBudgets<B extends Budget>(
  budgets: readonly B[],
  input: EvaluateBudgetsInput
): EvaluatedBudget<B>[] {
  const prepared = prepareBudgetTransactions(input.transactions, input.transactionSplits ?? []);
  const childIndex = buildCategoryChildIndex(input.categories);
  const resolveCategoryId = buildBudgetCategoryResolver(input.categories);
  const now = input.now ?? new Date();

  return budgets.map(budget => {
    const categoryId = resolveCategoryId(budget);
    const categoryIds = collectBudgetCategoryIds(categoryId, childIndex);
    const groupIds = categoryIds.size > 1 ? categoryIds : undefined;
    const { spent, window, counted, excludedForeignCount } = calculateBudgetSpend(
      { ...budget, categoryId },
      prepared,
      {
        now,
        categoryIds: groupIds,
        foreignAccountIds: input.foreignAccountIds,
      }
    );
    const { mode, carriedIn, carriedFrom } = carryInto(budget, categoryId, window, prepared, {
      categoryIds: groupIds,
      excludeAccountIds: input.foreignAccountIds,
    });
    const effectiveAmount = toDecimal(budget.amount).plus(carriedIn);

    return {
      budget,
      categoryId,
      effectiveAmount,
      rolloverMode: mode,
      carriedIn,
      carriedFrom,
      spent,
      remaining: effectiveAmount.minus(spent),
      percentage: calculateBudgetPercentage({ amount: effectiveAmount }, spent),
      window,
      countedRowIds: new Set(counted.map(row => row.id)),
      excludedForeignCount,
    };
  });
}
