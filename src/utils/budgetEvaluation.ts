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
import { getBudgetPeriodWindow, normaliseRolloverMode, previousBudgetWindow, type BudgetPeriodWindow } from './budgetPeriods.js';
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
  /** The budget this one sends its surplus to, or null when it keeps it (see resolveRolloverTarget). */
  rolloverTo: string | null;
  /** What other budgets sent into this window — their surpluses landing here. */
  receivedIn: DecimalInstance;
  /** The same, by sender. */
  receivedFrom: ReadonlyArray<{ budgetId: string; amount: DecimalInstance }>;
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
  /**
   * Every budget of the login, for the links between them: a budget that
   * sends its surplus to one in this list is counted into it even when the
   * caller evaluates a subset. Defaults to the budgets being evaluated.
   */
  budgets?: readonly Budget[];
}

/**
 * How many earlier cycles the walk will visit at most. A weekly budget
 * running since 2003 has fewer; this guards against a model that never
 * answers "first", not a case anyone meets.
 */
const MAX_CARRY_CYCLES = 1200;

/** What a cycle's remainder keeps for the budget's OWN next cycle under a mode: only its surplus, only its overspend, all of it, or nothing. */
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

/**
 * ── WHERE A SURPLUS GOES (7 Nov 2026, the last part of the owner's "3") ─────
 *
 * A budget whose mode carries a surplus may SEND it to another budget rather
 * than keep it: `rolloverTo` names the budget. At the end of each of the
 * source's cycles what was left — the surplus, never an overspend — lands in
 * the target's cycle holding the day after, and counts into that cycle's
 * allowance as `receivedIn`; under 'both' the overspend still stays with the
 * source. The pointer is a plain id and not a foreign key, on purpose: a
 * ledger-wide link would need the deferred restore pass the account parents
 * have, and a dangling, foreign or self reference simply reads as "keep it
 * here" — `resolveRolloverTarget` is the one place that is decided. The
 * editor offers only the login's own running budgets and never the budget
 * itself, and both engines' CHECKs refuse self and a mode that carries no
 * surplus. A loop (A sends to B, B to A) is cut where it is met and the
 * second link reads as "keep".
 */

/** One completed cycle of a budget, as the history shows it (7 Nov 2026, the owner's "7"). */
export interface BudgetCycleFigures {
  /** The cycle's days. */
  window: BudgetPeriodWindow;
  /** What the budget's own cycle before handed it, SIGNED, under the mode; zero in the first cycle. */
  carriedIn: DecimalInstance;
  /** What other budgets sent it — their surpluses landing in this cycle. */
  receivedIn: DecimalInstance;
  /** The plan plus the carry plus what was received. */
  allowance: DecimalInstance;
  /** Net spend in the cycle. */
  spent: DecimalInstance;
  /** Allowance less spend, SIGNED. */
  remaining: DecimalInstance;
  /** What it kept for its own next cycle, SIGNED, under the mode. */
  carriedOut: DecimalInstance;
  /** What it sent on to the budget it sends its surplus to; zero when it keeps. */
  sentOn: DecimalInstance;
}

/**
 * The budget a budget sends its surplus to, or null when it keeps it: a
 * mode that carries no surplus, no target stated, the budget itself, or a
 * target not among the budgets given (deleted, or never this login's) all
 * read as "keep". See the header.
 */
export function resolveRolloverTarget(
  budget: Pick<Budget, 'id' | 'rolloverMode' | 'rolloverTo'>,
  budgets: ReadonlyMap<string, Budget>
): string | null {
  const mode = normaliseRolloverMode(budget.rolloverMode);
  if (mode !== 'surplus' && mode !== 'both') return null;
  const target = budget.rolloverTo;
  if (!target || target === budget.id || !budgets.has(target)) return null;
  return target;
}

/** What one evaluation pass shares between the budgets it evaluates. */
interface Ledger {
  prepared: DatedDecimalTransaction[];
  childIndex: ReadonlyMap<string, string[]>;
  resolveCategoryId: (budget: Pick<Budget, 'categoryId'>) => string;
  foreignAccountIds: ReadonlySet<string> | undefined;
  now: Date;
  /** Every budget the links may name — see EvaluateBudgetsInput.budgets. */
  byId: Map<string, Budget>;
  /** The RUNNING budgets that send their surplus to each target. */
  sourcesByTarget: Map<string, Budget[]>;
  /** One budget's figures computed once per pass. */
  memo: Map<string, BudgetFigures>;
}

/** A budget's cycles and what flows between them, as at the ledger's instant. */
interface BudgetFigures {
  categoryId: string;
  window: BudgetPeriodWindow;
  mode: BudgetRolloverMode;
  rolloverTo: string | null;
  carriedFrom: BudgetPeriodWindow | null;
  /** Every completed cycle, oldest first. Empty when nothing asked for them. */
  past: BudgetCycleFigures[];
  /** Into the current window. */
  carriedIn: DecimalInstance;
  receivedIn: DecimalInstance;
  receivedFrom: Array<{ budgetId: string; amount: DecimalInstance }>;
}

function ledgerOf(budgets: readonly Budget[], input: EvaluateBudgetsInput): Ledger {
  const all = input.budgets ?? budgets;
  const byId = new Map<string, Budget>();
  for (const budget of all) byId.set(budget.id, budget);
  const sourcesByTarget = new Map<string, Budget[]>();
  for (const budget of all) {
    // A paused budget is out of play on the Budget page, and sends nothing.
    if (budget.isActive === false) continue;
    const target = resolveRolloverTarget(budget, byId);
    if (target === null) continue;
    const sources = sourcesByTarget.get(target);
    if (sources) sources.push(budget);
    else sourcesByTarget.set(target, [budget]);
  }
  return {
    prepared: prepareBudgetTransactions(input.transactions, input.transactionSplits ?? []),
    childIndex: buildCategoryChildIndex(input.categories),
    resolveCategoryId: buildBudgetCategoryResolver(input.categories),
    foreignAccountIds: input.foreignAccountIds,
    now: input.now ?? new Date(),
    byId,
    sourcesByTarget,
    memo: new Map(),
  };
}

/** The day after a window's last day, at noon — where a surplus sent on lands. */
function dayAfter(window: BudgetPeriodWindow): Date {
  return new Date(window.end.getFullYear(), window.end.getMonth(), window.end.getDate() + 1, 12);
}

const within = (day: Date, window: BudgetPeriodWindow): boolean => day >= window.start && day <= window.end;

/**
 * One budget's cycles and the flows between them, memoised per pass.
 *
 * The walk back through the cycles is made only when something needs it —
 * the budget carries, sends, or is sent to, or the caller asked for the
 * history — because under 'none' with no links it is a cost every card
 * would otherwise pay. The rows of every earlier cycle are taken in ONE pass
 * over the prepared set, so each cycle's own sum walks only the budget's
 * rows; the cycles are then summed oldest first, each handing what it kept
 * to the next and what it sent on to its target's cycle holding the day after.
 *
 * `visiting` is the chain of budgets being asked about, so a loop between
 * two budgets is cut where it is met rather than followed for ever.
 */
function figuresFor(
  budget: Budget,
  ledger: Ledger,
  visiting: ReadonlySet<string>,
  options: { history?: boolean } = {}
): BudgetFigures {
  const memoised = ledger.memo.get(budget.id);
  if (memoised && (!options.history || memoised.past.length > 0 || memoised.carriedFrom === null)) return memoised;

  const categoryId = ledger.resolveCategoryId(budget);
  const categoryIds = collectBudgetCategoryIds(categoryId, ledger.childIndex);
  const filter: BudgetSpendingFilter = {
    categoryIds: categoryIds.size > 1 ? categoryIds : undefined,
    excludeAccountIds: ledger.foreignAccountIds,
  };
  const window = getBudgetPeriodWindow(budget, ledger.now);
  const mode = normaliseRolloverMode(budget.rolloverMode);
  const rolloverTo = resolveRolloverTarget(budget, ledger.byId);
  const carriedFrom = previousBudgetWindow(budget, window);
  const sources = (ledger.sourcesByTarget.get(budget.id) ?? []).filter(source => !visiting.has(source.id));

  const zero = toDecimal(0);
  const unwalked: BudgetFigures = {
    categoryId, window, mode, rolloverTo, carriedFrom, past: [], carriedIn: zero, receivedIn: zero, receivedFrom: [],
  };
  const needsWalk = options.history === true || mode !== 'none' || sources.length > 0;
  if (!needsWalk || (carriedFrom === null && sources.length === 0)) {
    ledger.memo.set(budget.id, unwalked);
    return unwalked;
  }

  const windows: BudgetPeriodWindow[] = [];
  for (let cycle = carriedFrom; cycle && windows.length < MAX_CARRY_CYCLES; cycle = previousBudgetWindow(budget, cycle)) {
    windows.push(cycle);
  }
  windows.reverse();

  // What the senders' completed cycles landed in each of this budget's
  // cycles — by index into `windows`, and `windows.length` for the current.
  const landed = new Map<number, Array<{ budgetId: string; amount: DecimalInstance }>>();
  const chain = new Set(visiting);
  chain.add(budget.id);
  for (const source of sources) {
    const theirs = figuresFor(source, ledger, chain);
    for (const cycle of theirs.past) {
      if (!cycle.sentOn.greaterThan(0)) continue;
      const day = dayAfter(cycle.window);
      let index = windows.findIndex(w => within(day, w));
      if (index < 0 && within(day, window)) index = windows.length;
      if (index < 0) continue;
      const list = landed.get(index);
      const entry = { budgetId: source.id, amount: cycle.sentOn };
      if (list) list.push(entry);
      else landed.set(index, [entry]);
    }
  }
  const receivedAt = (index: number): DecimalInstance =>
    (landed.get(index) ?? []).reduce((sum, entry) => sum.plus(entry.amount), zero);

  const earlier = windows.length === 0
    ? []
    : calculateBudgetSpendingBreakdown({ categoryId }, ledger.prepared, windows[0].start, windows[windows.length - 1].end, filter).counted;
  const plan = toDecimal(budget.amount);
  let carry = zero;
  const past = windows.map((cycle, index) => {
    const { spent } = calculateBudgetSpendingBreakdown({ categoryId }, earlier, cycle.start, cycle.end, {
      categoryIds: filter.categoryIds,
    });
    const carriedIn = carry;
    const receivedIn = receivedAt(index);
    const allowance = plan.plus(carriedIn).plus(receivedIn);
    const remaining = allowance.minus(spent);
    // Sent on: the surplus, to the target; kept: the rest the mode allows.
    const sentOn = rolloverTo !== null && remaining.greaterThan(0) ? remaining : zero;
    carry = rolloverTo !== null ? keptUnder(mode, remaining.minus(sentOn)) : keptUnder(mode, remaining);
    return { window: cycle, carriedIn, receivedIn, allowance, spent, remaining, carriedOut: carry, sentOn };
  });

  const figures: BudgetFigures = {
    categoryId,
    window,
    mode,
    rolloverTo,
    carriedFrom,
    past,
    carriedIn: carry,
    receivedIn: receivedAt(windows.length),
    receivedFrom: landed.get(windows.length) ?? [],
  };
  ledger.memo.set(budget.id, figures);
  return figures;
}

/**
 * ONE budget's completed cycles, oldest first, each with its figures — "how
 * has this budget run" (the owner's "7", 7 Nov 2026) — plus the one being
 * measured now. Called when a history is opened, not for every card: the
 * walk under 'none' is a cost the card itself never pays. Pass every budget
 * of the login in `input.budgets`, so what others sent it is counted.
 */
export function evaluateBudgetHistory(
  budget: Budget,
  input: EvaluateBudgetsInput
): { current: EvaluatedBudget; past: BudgetCycleFigures[] } {
  const ledger = ledgerOf([budget], input);
  const figures = figuresFor(budget, ledger, new Set(), { history: true });
  const [current] = evaluateBudgets([budget], { ...input, budgets: input.budgets ?? [budget] });
  return { current, past: figures.past };
}

/**
 * Evaluate every budget given, in the order given, as at one instant.
 *
 * Splits are expanded and amounts decimalised ONCE for the whole set; a group
 * budget counts every category beneath its own; a detail budget keeps the
 * plain equality match it always had (a single-id set is the same thing).
 * The links between budgets are read from `input.budgets` when given, so a
 * surface that evaluates a subset still counts what the rest sent it.
 */
export function evaluateBudgets<B extends Budget>(
  budgets: readonly B[],
  input: EvaluateBudgetsInput
): EvaluatedBudget<B>[] {
  const ledger = ledgerOf(budgets, input);

  return budgets.map(budget => {
    const figures = figuresFor(budget, ledger, new Set());
    const { categoryId, window } = figures;
    const categoryIds = collectBudgetCategoryIds(categoryId, ledger.childIndex);
    const { spent, counted, excludedForeignCount } = calculateBudgetSpend(
      { ...budget, categoryId },
      ledger.prepared,
      {
        now: ledger.now,
        categoryIds: categoryIds.size > 1 ? categoryIds : undefined,
        foreignAccountIds: input.foreignAccountIds,
      }
    );
    const effectiveAmount = toDecimal(budget.amount).plus(figures.carriedIn).plus(figures.receivedIn);

    return {
      budget,
      categoryId,
      effectiveAmount,
      rolloverMode: figures.mode,
      rolloverTo: figures.rolloverTo,
      carriedIn: figures.carriedIn,
      carriedFrom: figures.carriedFrom,
      receivedIn: figures.receivedIn,
      receivedFrom: figures.receivedFrom,
      spent,
      remaining: effectiveAmount.minus(spent),
      percentage: calculateBudgetPercentage({ amount: effectiveAmount }, spent),
      window,
      countedRowIds: new Set(counted.map(row => row.id)),
      excludedForeignCount,
    };
  });
}
