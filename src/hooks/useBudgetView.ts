import { useCallback, useState } from 'react';
import { preferences } from '../services/preferencesService';
import { BUDGET_VIEW_KEY, parseBudgetView, type BudgetView } from '../utils/budgetView';

/**
 * How a long budget is read, and the way to change it — the single reader and
 * writer of the preference, so the Dashboard's cog and the Budget page cannot
 * keep the choice under two names (owner, 10 Nov 2026: one setting for every
 * budget). Each surface reads it as it mounts; they are never on screen
 * together. See utils/budgetView.
 */
export function useBudgetView(): [BudgetView, (view: BudgetView) => void] {
  const [view, setView] = useState<BudgetView>(() => parseBudgetView(preferences.getItem(BUDGET_VIEW_KEY)));
  const choose = useCallback((next: BudgetView) => {
    preferences.setItem(BUDGET_VIEW_KEY, next);
    setView(next);
  }, []);
  return [view, choose];
}
