/**
 * The budgets running today, evaluated — once, for every server surface that
 * quotes one.
 *
 * The connector's `reckley_budget_status` did this inline. The home-screen
 * widget (10 Nov 2026) needs exactly the same figures, and "exactly the same"
 * is only true of one function: which budgets count as running, how wide the
 * read is, and that EVERY active budget is handed to the evaluation so a
 * surplus one sends another is counted into it. So it lives here and both
 * call it. The arithmetic itself is the app's — `evaluateBudgets`, the Budget
 * page's and the Dashboard card's one evaluation.
 *
 * Nothing here is a TypeScript enum or a parameter property: the API project
 * compiles with `erasableSyntaxOnly`.
 */

import type { Budget, Category } from '../../src/types/index.js';
import { evaluateBudgets, type EvaluatedBudget } from '../../src/utils/budgetEvaluation.js';
import { getBudgetPeriodWindow } from '../../src/utils/budgetPeriods.js';
import type { ReckleyPort } from './mcp/port.js';

/**
 * A budget window's bounds are LOCAL midnights (utils/budgetPeriods), so they
 * are named by their local calendar parts — through toISOString, 1 October
 * at 00:00 BST would read as 30 September.
 */
export const localDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** "Bills (Household) > Telephone" — the path a category reads as on screen. */
export function categoryPath(id: string | undefined, categories: Map<string, Category>): string | null {
  if (!id) return null;
  const parts: string[] = [];
  let current = categories.get(id);
  let guard = 0;
  while (current && guard++ < 6) {
    if (current.level !== 'type') parts.unshift(current.name);
    current = current.parentId ? categories.get(current.parentId) : undefined;
  }
  return parts.length > 0 ? parts.join(' > ') : (categories.get(id)?.name ?? null);
}

export interface RunningBudgets {
  /** Active budgets, running or not — zero means the person has none at all. */
  activeCount: number;
  /** The running ones, evaluated over their own windows, in stored order. */
  evaluated: EvaluatedBudget<Budget>[];
  /** The ledger's currency: the first account's, GBP for a ledger with none. */
  currency: string;
  categories: Map<string, Category>;
}

/**
 * Running today: active, and neither finished (past its end date) nor yet to
 * start. A finished budget's figure is history, a future one's is nothing;
 * the Budget page shows both captioned as such, these answers are about now.
 */
export async function evaluateRunningBudgets(port: ReckleyPort, today: Date, rowCap: number): Promise<RunningBudgets> {
  const [budgets, categoryList, accounts] = await Promise.all([
    port.listBudgets(),
    port.listCategories(),
    port.listAccounts(),
  ]);
  const categories = new Map(categoryList.map(category => [category.id, category]));
  const currency = accounts[0]?.currency ?? 'GBP';
  const active = budgets.filter(budget => budget.isActive);
  const running = active.filter(budget => {
    const window = getBudgetPeriodWindow(budget, today);
    return !window.ended && !window.notStarted;
  });
  if (running.length === 0) {
    return { activeCount: active.length, evaluated: [], currency, categories };
  }
  // Budgets are measured over their own windows — since 5 Nov 2026 a
  // repeating budget runs its cycle from its OWN start, so a yearly one
  // can straddle two calendar years. The read covers the earliest start
  // to the latest end among them, nothing wider and nothing narrower.
  const windows = running.map(budget => getBudgetPeriodWindow(budget, today));
  const earliest = windows.reduce((soFar, w) => (w.start < soFar ? w.start : soFar), windows[0].start);
  const latest = windows.reduce((soFar, w) => (w.end > soFar ? w.end : soFar), windows[0].end);
  const range = await port.transactionsBetween(localDay(earliest), localDay(latest), rowCap);
  const evaluated = evaluateBudgets(running, {
    transactions: range.rows,
    transactionSplits: range.splits,
    categories: categoryList,
    now: today,
    // Every active budget, so what one sends another is counted into it.
    budgets: active,
  });
  return { activeCount: active.length, evaluated, currency, categories };
}
