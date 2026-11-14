/* eslint-disable react-refresh/only-export-components -- this file exports
   its hook beside its toggle, exactly as WholePoundsContext does */
import React, { useCallback, useSyncExternalStore } from 'react';
import { preferences } from '../services/preferencesService';

/**
 * NEGATIVES IN RED — one choice for the whole app, and only if the person asks.
 *
 * The owner's ask (14 Nov 2026), of the Accounts page: "next to Hide Decimals
 * we should have 'negatives in red', as a tick box for the user to change the
 * view to have all negative balances show in red if they wish". He liked it on
 * sight and asked for it "throughout" the same day, ruling that it is ONE
 * setting: tick it on any page and every page follows.
 *
 * That is where it parts from "Hide decimals", which he ruled page-specific
 * (19 Aug): whether pennies are noise depends on how much a page shows, but
 * whether a debt should be red is a matter of how a person reads money, and
 * that does not change between pages. So there is no scope to wrap a page in.
 * The tick box is drawn beside "Hide decimals" wherever that is, and every one
 * of them is the same switch.
 *
 * OFF BY DEFAULT, and that is the design pass's rule, not an oversight: colour
 * marks what needs attention, and a card that is owed money or a mortgage with
 * a balance is the account doing what it is for. The choice is the person's.
 *
 * WHAT IT PAINTS: a figure that is otherwise plain and is below zero. A figure
 * that already carries a colour with a meaning — income green, spending red,
 * over budget, a gain or a loss — keeps that meaning; callers simply do not
 * ask for a tone there. Display only: no figure, total or export changes.
 */

const KEY = 'money_management_negatives_in_red';
/**
 * The first day's key, when the setting belonged to the Accounts page alone.
 * Honoured only until the app-wide key has been written once, so the choice
 * the owner made that morning carries over and a later untick is not undone.
 */
const FIRST_DAY_ACCOUNTS_KEY = 'money_management_negatives_in_red_accounts';

const readSetting = (): boolean => {
  const appWide = preferences.getItem(KEY);
  if (appWide !== null) return appWide === 'true';
  return preferences.getItem(FIRST_DAY_ACCOUNTS_KEY) === 'true';
};

const writeSetting = (value: boolean): void => {
  preferences.setItem(KEY, value ? 'true' : 'false');
};

/** Is "Negatives in red" on? Follows the preferences document, so a change on one page reaches every other. */
export const useNegativesInRed = (): boolean =>
  useSyncExternalStore(preferences.subscribe, readSetting, readSetting);

/** The app's negative-figure red in both themes; `semantic-contrast.test.ts` measures it. */
export const NEGATIVE_FIGURE_CLASS = 'text-red-600 dark:text-red-400';

/**
 * Whether an amount counts as below zero for this purpose: by half a penny or
 * more, so a float's dust — a balance of minus nothing — is not painted as a
 * debt. Exported for the few places that tint something other than a class
 * (a chart label, an SVG fill).
 */
export const isBelowZero = (amount: number | null | undefined): boolean =>
  typeof amount === 'number' && amount <= -0.005;

/**
 * The class for a figure: red when the setting is on and the amount is below
 * zero, otherwise `fallback` (the figure's ordinary colour).
 */
export const useNegativeTone = (): ((amount: number | null | undefined, fallback: string) => string) => {
  const on = useNegativesInRed();
  return useCallback(
    (amount, fallback) => (on && isBelowZero(amount) ? NEGATIVE_FIGURE_CLASS : fallback),
    [on]
  );
};

/** The checkbox, spelt and sized like "Hide decimals" so the two sit as a pair. */
export function NegativesInRedToggle({ className = '' }: { className?: string }): React.JSX.Element {
  const on = useNegativesInRed();
  return (
    <label className={`flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 cursor-pointer select-none ${className}`}>
      <input
        type="checkbox"
        checked={on}
        onChange={event => writeSetting(event.target.checked)}
        className="rounded border-gray-300 dark:border-gray-600"
      />
      Negatives in red
    </label>
  );
}
