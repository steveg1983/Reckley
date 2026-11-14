/**
 * Is an account past the line its owner asked to be warned at?
 *
 * ONE answer for two places: the Dashboard's "Needs your attention" card
 * (utils/attentionItems.ts) and the phone's low-balance push
 * (api/_lib/low-balance-push.ts). If they disagreed, the phone would buzz
 * about an account the card calls fine, or stay silent about one it flags.
 *
 * ON A CARD THE SAME NUMBER MEANS SPENDING (owner, 16 August). The person
 * types the positive figure they think in ("warn me at £10,000 of spend")
 * and spend is a negative balance, so a card's line is crossed at
 * −threshold. Everywhere else the line is the threshold itself.
 *
 * Pure, and importable by the server: no browser, no app state.
 */

import { isCardAccountTypeValue } from './accountNumberInput.js';

export interface WarningLineAccount {
  type: unknown;
  lowBalanceAlertEnabled?: boolean | null;
  lowBalanceThreshold?: number | null;
}

/** True when the warning is switched on and the balance is beyond the line. */
export function isPastWarningLine(account: WarningLineAccount, balance: number): boolean {
  if (account.lowBalanceAlertEnabled !== true) return false;
  const threshold = account.lowBalanceThreshold;
  if (threshold === null || threshold === undefined || !Number.isFinite(threshold)) return false;
  return balance < (isCardAccountTypeValue(account.type) ? -threshold : threshold);
}
