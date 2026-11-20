/**
 * A BANK CONNECTION IN PROGRESS HOLDS OFF "WHEN I LEAVE THE APP".
 *
 * Connecting or re-consenting a bank takes the person out of Reckley — to the
 * bank's own app or page — for longer than the leave mode's grace. Without
 * this, they would come back signed out and the connection would never finish
 * (owner's ruling, 19 Nov 2026: "hold off the sign out during bank
 * connection").
 *
 * The hold is a timestamp in this browser's storage, set when the flow
 * starts and released when the callback reports an outcome either way. It
 * lapses on its own after fifteen minutes, so a flow abandoned at the bank
 * cannot keep somebody signed in for ever.
 */
const HOLD_KEY = 'ledger_bank_connection_hold';
const HOLD_LIFETIME_MS = 15 * 60_000;

export function holdSignOutForBankConnection(): void {
  try {
    window.localStorage.setItem(HOLD_KEY, String(Date.now()));
  } catch {
    // Storage refused: no hold, and the leave mode behaves as it would anyway.
  }
}

export function releaseBankConnectionHold(): void {
  try {
    window.localStorage.removeItem(HOLD_KEY);
  } catch {
    // Nothing held that could be released.
  }
}

export function bankConnectionHoldActive(): boolean {
  try {
    const raw = window.localStorage.getItem(HOLD_KEY);
    if (raw === null) return false;
    const startedAt = Number(raw);
    return Number.isFinite(startedAt) && Date.now() - startedAt < HOLD_LIFETIME_MS;
  } catch {
    return false;
  }
}
