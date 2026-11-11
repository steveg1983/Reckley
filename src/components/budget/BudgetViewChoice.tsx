import React from 'react';
import { parseBudgetView, type BudgetView } from '../../utils/budgetView';

/**
 * HOW A LONG BUDGET IS READ — the one choice, wherever it is offered.
 *
 * The owner's ruling (10 Nov 2026): one setting for every budget, on the
 * Dashboard's Key Budgets cog and on the Budget page, defaulting to "so far".
 * It is a statement about how the person reads THEIR budgets, so it is a
 * portable preference and travels with the account — and the home-screen
 * widget's document is shaped by the same key (`api/_lib/widget-budgets`).
 *
 * `hooks/useBudgetView` is the single reader and writer of the preference.
 */

const OPTIONS: ReadonlyArray<{ value: BudgetView; label: string }> = [
  { value: 'toDate', label: 'So far — the months begun' },
  { value: 'month', label: 'This month’s share' },
  { value: 'period', label: 'The whole period' },
];

interface BudgetViewChoiceProps {
  /** Unique on the page: the Dashboard and the Budget page each have one. */
  id: string;
  view: BudgetView;
  onChange: (view: BudgetView) => void;
}

export default function BudgetViewChoice({ id, view, onChange }: BudgetViewChoiceProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-dense text-gray-500 dark:text-gray-400">
        Read longer budgets
      </label>
      <select
        id={id}
        value={view}
        onChange={event => onChange(parseBudgetView(event.target.value))}
        className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
      >
        {OPTIONS.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
