/**
 * How a budget has run, cycle by cycle (owner, 7 Nov 2026: "per-category
 * cycle history — how this budget did in each past cycle").
 *
 * One table under the card, mounted only when the fold is opened: the
 * cycle's days, what it was allowed (the plan plus any carry and anything
 * received), what it spent, and what was left or gone over. The figures are
 * the evaluation's own (utils/budgetEvaluation), so a cycle's allowance here
 * is the allowance the card showed on the day — and when the budget carries,
 * sends its surplus on, or is sent one, each is a column of its own, present
 * only when it happened. That is why this shipped AFTER the rollover modes.
 *
 * Newest first, because the question is "what happened lately". Twelve at a
 * time; a budget with more says how many more and shows them on request. The
 * cycle being measured now is not a row — it is the card above.
 *
 * Colour follows the card: an overspent cycle reads in the card's red, a
 * cycle with something left in its green, so the two surfaces agree. A
 * carry, a send and a receipt are figures, not verdicts — neutral ink.
 */

import { useMemo, useState } from 'react';
import { useNegativeTone } from '../contexts/NegativesInRedContext';
import { useApp } from '../contexts/AppContextSupabase';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import { evaluateBudgetHistory } from '../utils/budgetEvaluation';
import { foreignCurrencyAccountIds } from '../utils/budgetSpending';
import { describeBudgetWindow } from '../utils/budgetPace';
import type { Budget } from '../types';

interface BudgetCycleHistoryProps {
  budget: Budget;
  /** The instant the page was evaluated at, so the history and the card agree about "now". */
  evaluatedAt: Date;
}

const PAGE = 12;

export default function BudgetCycleHistory({ budget, evaluatedAt }: BudgetCycleHistoryProps): React.JSX.Element {
  const { transactions, transactionSplits, categories, accounts, budgets } = useApp();
  const { formatCurrency, displayCurrency } = useCurrencyDecimal();
  const negativeTone = useNegativeTone();
  const [showAll, setShowAll] = useState(false);

  const past = useMemo(
    () =>
      evaluateBudgetHistory(budget, {
        transactions,
        transactionSplits,
        categories,
        foreignAccountIds: foreignCurrencyAccountIds(accounts, displayCurrency),
        now: evaluatedAt,
        // Every budget, so what others sent this one is counted into its cycles.
        budgets,
      }).past.slice().reverse(),
    [budget, transactions, transactionSplits, categories, accounts, budgets, displayCurrency, evaluatedAt]
  );

  const carries = past.some(cycle => !cycle.carriedIn.isZero() || !cycle.carriedOut.isZero());
  const sends = past.some(cycle => !cycle.sentOn.isZero());
  const receives = past.some(cycle => !cycle.receivedIn.isZero());
  const shown = showAll ? past : past.slice(0, PAGE);
  const hidden = past.length - shown.length;

  if (past.length === 0) {
    return (
      <p className="text-dense text-gray-500 dark:text-gray-400" data-testid="budget-history-empty">
        No completed periods yet.
      </p>
    );
  }

  const figure = (value: typeof past[number]['carriedOut']): string => (value.isZero() ? '—' : formatCurrency(value));

  return (
    <div data-testid="budget-history">
      <table className="w-full text-dense">
        <thead>
          <tr className="text-left text-gray-500 dark:text-gray-400">
            <th scope="col" className="font-medium py-1 pr-2">Period</th>
            {receives && <th scope="col" className="font-medium py-1 pr-2 text-right">Received</th>}
            <th scope="col" className="font-medium py-1 pr-2 text-right">Allowed</th>
            <th scope="col" className="font-medium py-1 pr-2 text-right">Spent</th>
            <th scope="col" className="font-medium py-1 text-right">Left</th>
            {carries && <th scope="col" className="font-medium py-1 pl-2 text-right">Carried on</th>}
            {sends && <th scope="col" className="font-medium py-1 pl-2 text-right">Sent on</th>}
          </tr>
        </thead>
        <tbody>
          {shown.map(cycle => (
            <tr key={cycle.window.start.getTime()} className="border-t border-gray-100 dark:border-gray-700" data-testid="budget-history-row">
              <td className="py-1 pr-2 text-gray-700 dark:text-gray-200">{describeBudgetWindow(cycle.window)}</td>
              {receives && (
                <td className="py-1 pr-2 text-right text-gray-700 dark:text-gray-200">{figure(cycle.receivedIn)}</td>
              )}
              <td className="py-1 pr-2 text-right text-gray-900 dark:text-white">{formatCurrency(cycle.allowance)}</td>
              <td className="py-1 pr-2 text-right text-gray-900 dark:text-white">{formatCurrency(cycle.spent)}</td>
              <td
                className={`py-1 text-right font-medium ${
                  cycle.remaining.isNegative() ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                }`}
              >
                {cycle.remaining.isNegative()
                  ? `over by ${formatCurrency(cycle.remaining.abs())}`
                  : formatCurrency(cycle.remaining)}
              </td>
              {carries && (
                /* An overspend carried on is below zero and otherwise plain:
                   the one figure in this table "Negatives in red" governs. */
                <td className={`py-1 pl-2 text-right ${negativeTone(cycle.carriedOut.toNumber(), 'text-gray-700 dark:text-gray-200')}`}>{figure(cycle.carriedOut)}</td>
              )}
              {sends && (
                <td className="py-1 pl-2 text-right text-gray-700 dark:text-gray-200">{figure(cycle.sentOn)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-2 text-dense underline text-gray-700 dark:text-gray-200 hover:no-underline"
        >
          Show {hidden} earlier {hidden === 1 ? 'period' : 'periods'}
        </button>
      )}
    </div>
  );
}
