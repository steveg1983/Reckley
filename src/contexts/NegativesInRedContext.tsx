/* eslint-disable react-refresh/only-export-components -- a context file
   exports its hook beside its provider, exactly as WholePoundsContext does */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { preferences } from '../services/preferencesService';

/**
 * NEGATIVES IN RED, PER PAGE — and only if the person asks.
 *
 * The owner's ask (14 Nov 2026), of the Accounts page: "next to Hide Decimals
 * we should have 'negatives in red', as a tick box for the user to change the
 * view to have all negative balances show in red if they wish".
 *
 * OFF BY DEFAULT, and that is the design pass's rule, not an oversight:
 * colour marks what needs attention, and a card that is owed money or a
 * mortgage with a balance is the account doing what it is for. A list of
 * ninety accounts with every liability in red asks for attention forty times.
 * But a person scanning for what is overdrawn is asking a real question, and
 * the old Microsoft Money answered it exactly this way. So it is a choice,
 * the person's, made beside the other choice about how figures are drawn.
 *
 * The same shape as WholePoundsScope: a page wraps itself, remembers its own
 * answer under its own key, and everything inside that draws a balance asks
 * `useNegativeTone` for the class. Display only — no figure, total or export
 * changes.
 */

interface NegativesInRedValue {
  negativesInRed: boolean;
  setNegativesInRed: (value: boolean) => void;
}

/** Outside any scope: nothing is tinted, and the toggle (if rendered) does nothing. */
const NegativesInRedContext = createContext<NegativesInRedValue>({
  negativesInRed: false,
  setNegativesInRed: () => {},
});

/** The app's negative-figure red in both themes; `semantic-contrast.test.ts` measures it. */
export const NEGATIVE_FIGURE_CLASS = 'text-red-600 dark:text-red-400';

/**
 * The class for a balance: red when the scope is on and the amount is below
 * zero by a penny or more, otherwise `fallback` (the figure's ordinary
 * colour). Half a penny is the threshold so a float's dust — a balance of
 * minus nothing — is not painted as a debt.
 */
export const useNegativeTone = (): ((amount: number | null | undefined, fallback: string) => string) => {
  const { negativesInRed } = useContext(NegativesInRedContext);
  return useCallback(
    (amount, fallback) =>
      negativesInRed && typeof amount === 'number' && amount <= -0.005 ? NEGATIVE_FIGURE_CLASS : fallback,
    [negativesInRed]
  );
};

/** One page's scope. `page` is the storage key's tail, as in WholePoundsScope. */
export function NegativesInRedScope({ page, children }: { page: string; children: ReactNode }): React.JSX.Element {
  const key = `money_management_negatives_in_red_${page}`;
  const [negativesInRed, setState] = useState((): boolean => preferences.getItem(key) === 'true');
  const setNegativesInRed = useCallback((value: boolean): void => {
    setState(value);
    preferences.setItem(key, value ? 'true' : 'false');
  }, [key]);
  const value = useMemo(() => ({ negativesInRed, setNegativesInRed }), [negativesInRed, setNegativesInRed]);
  return <NegativesInRedContext.Provider value={value}>{children}</NegativesInRedContext.Provider>;
}

/** The checkbox, spelt and sized like "Hide decimals" so the two sit as a pair. */
export function NegativesInRedToggle({ className = '' }: { className?: string }): React.JSX.Element {
  const { negativesInRed, setNegativesInRed } = useContext(NegativesInRedContext);
  return (
    <label className={`flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 cursor-pointer select-none ${className}`}>
      <input
        type="checkbox"
        checked={negativesInRed}
        onChange={event => setNegativesInRed(event.target.checked)}
        className="rounded border-gray-300 dark:border-gray-600"
      />
      Negatives in red
    </label>
  );
}
