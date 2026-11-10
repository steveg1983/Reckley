// This module runs inside Vercel's node ESM runtime (imported by api/banking/*),
// where a relative import WITHOUT the .js extension is ERR_MODULE_NOT_FOUND at
// module load — the whole function dies as FUNCTION_INVOCATION_FAILED before
// the handler (or Sentry) ever runs. Vite tolerates the extensionless form, so
// only production breaks. Every relative import here must carry .js; the
// serverless-import-closure spec enforces this for the whole api/ graph.
import type { BalanceUnavailableReason } from '../../types/banking-api.js';
import { cardBalanceToAppBalance } from './cardNormalization.js';

/**
 * "What the bank said this account holds" — or an explicit statement that it
 * said nothing.
 *
 * ── WHY THIS TYPE EXISTS ────────────────────────────────────────────────────
 * Every balance path in the banking API used to start at `let balance = 0` and
 * fill it in from TrueLayer inside a try/catch. A momentary failure of the
 * balance endpoint therefore produced the number 0 — indistinguishable, one
 * line later, from a bank that genuinely reported an empty account. That zero
 * was then written as if it were fact:
 *
 *   • account CREATION seeded `balance`, `bank_balance` AND `initial_balance`
 *     from it, so a new account asserted it held £0.00 on the day it was
 *     linked, and the first-import rebase (initial_balance -= Σ backfill, see
 *     migration 20260613090000) built its arithmetic on a figure that was
 *     never true;
 *   • the sync UPDATE path stamped `bank_balance_date` = today onto it, dating
 *     a fabrication as this morning's reading;
 *   • the link modal showed it to the user as their balance and prefilled it
 *     into the new-account form.
 *
 * A `number` cannot carry "the bank did not answer", so the type has to. Every
 * producer of a bank figure returns one of these, and every consumer is forced
 * by the compiler to decide what to do when there is no figure. The invariant
 * the whole module exists to hold:
 *
 *   NEVER write a fabricated figure as if the bank had reported it.
 *
 * No arithmetic happens here — a snapshot carries the bank's own number
 * through unchanged. The one conversion (a card's amount-owed → the app's
 * negative liability) is delegated to cardBalanceToAppBalance, which does it
 * in Decimal.
 */
export type BankBalanceSnapshot =
  | { readonly status: 'reported'; readonly amount: number }
  | { readonly status: 'unavailable'; readonly reason: BalanceUnavailableReason };

export const reportedBalance = (amount: number): BankBalanceSnapshot => ({
  status: 'reported',
  amount
});

export const unavailableBalance = (reason: BalanceUnavailableReason): BankBalanceSnapshot => ({
  status: 'unavailable',
  reason
});

/**
 * A bank account's balance as returned by fetchAccountBalance: a number, or
 * null when the payload carried no balance row. A non-finite number is treated
 * exactly like a missing one — NaN is not a balance.
 */
export const accountBalanceSnapshot = (value: number | null | undefined): BankBalanceSnapshot => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return unavailableBalance('not_reported');
  }
  return reportedBalance(value);
};

/**
 * A card's balance as returned by fetchCardBalance — `current`, the amount
 * OWED — converted to the app's convention (a liability is negative). The
 * conversion only happens once there is a real number to convert: the old code
 * passed the raw `number | null` into cardBalanceToAppBalance, whose null → 0
 * branch reported "no answer from the card issuer" as "you owe nothing".
 */
export const cardBalanceSnapshot = (current: number | null | undefined): BankBalanceSnapshot => {
  if (typeof current !== 'number' || !Number.isFinite(current)) {
    return unavailableBalance('not_reported');
  }
  return reportedBalance(cardBalanceToAppBalance(current));
};

/** The figure to show a user, or null to show "not reported" — never 0. */
export const balanceForDisplay = (snapshot: BankBalanceSnapshot): number | null =>
  snapshot.status === 'reported' ? snapshot.amount : null;

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const asHttpStatus = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;

/**
 * The HTTP status behind a failed TrueLayer call, when there is one.
 *
 * Preferred source is a numeric `status` property (what a typed HTTP error
 * carries). The message fallback exists because api/_lib/truelayer.ts throws
 * plain Errors shaped `"… fetch failed (<id>): <status> <body>"`; it is
 * deliberately anchored to the text immediately after the parenthesised id so
 * digits inside the provider's response body cannot be mistaken for a status.
 * If neither yields a status the caller treats the failure as transport-level
 * (retryable), which is the safe direction: at worst a doomed call is made
 * three times instead of once.
 */
export const httpStatusOfError = (error: unknown): number | undefined => {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const fromProperty = asHttpStatus(error.status);
    if (fromProperty !== undefined) {
      return fromProperty;
    }
  }
  if (error instanceof Error) {
    const match = /fetch failed[^:]*:\s*(\d{3})\b/.exec(error.message);
    if (match) {
      return asHttpStatus(Number.parseInt(match[1], 10));
    }
  }
  return undefined;
};

/**
 * 401 means the access token has expired, which is not this module's problem
 * to solve: withProviderAccessToken refreshes the token and replays the whole
 * operation. Such an error is re-thrown rather than retried or swallowed —
 * swallowing it is how an expired token used to become a £0.00 balance.
 */
export const isExpiredTokenBalanceError = (error: unknown): boolean =>
  httpStatusOfError(error) === 401;

/**
 * Worth trying again? Rate limits, gateway errors and transport failures are
 * momentary. A 403 (missing scope) or 404 (unknown account) is a settled fact
 * about this connection and will read exactly the same 750ms later.
 */
export const isRetryableBalanceFetchError = (error: unknown): boolean => {
  const status = httpStatusOfError(error);
  if (status === undefined) {
    return true;
  }
  return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
};

export interface BalanceFetchRetryOptions {
  /** Total attempts, including the first. Default 3. */
  readonly attempts?: number;
  /** Pause before attempt n+1 (1-based n). Default 250ms then 750ms. */
  readonly delayMsForAttempt?: (attempt: number) => number;
  /** Injected for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Observability hook — called once per failed attempt. Never given the balance. */
  readonly onAttemptFailed?: (attempt: number, error: unknown) => void;
}

const defaultDelayMsForAttempt = (attempt: number): number => (attempt === 1 ? 250 : 750);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Fetch one account's balance, retrying transient failures, and return what
 * the bank said — including "nothing".
 *
 * Retry first, because the overwhelming majority of these failures are a 429
 * or a 502 that a second attempt clears; only once the bank has genuinely
 * declined to answer does the caller have to fall back on the honest but
 * inconvenient options (defer the seeding, skip the refresh, show "not
 * reported"). A settled refusal (403/404) is not retried: three identical
 * failures serve nobody and hold a serverless invocation open.
 *
 * Never throws for a balance-level failure — the outcome IS the return value —
 * with one deliberate exception: an expired token is re-thrown so the caller's
 * token wrapper can refresh and replay.
 */
export const resolveBalanceSnapshot = async (
  fetchOnce: () => Promise<number | null>,
  toSnapshot: (value: number | null) => BankBalanceSnapshot,
  options: BalanceFetchRetryOptions = {}
): Promise<BankBalanceSnapshot> => {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMsForAttempt = options.delayMsForAttempt ?? defaultDelayMsForAttempt;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // A bank that answers "I have no balance row for this account" has
      // answered. Retrying a settled answer only delays the honest outcome.
      return toSnapshot(await fetchOnce());
    } catch (error) {
      if (isExpiredTokenBalanceError(error)) {
        throw error;
      }
      options.onAttemptFailed?.(attempt, error);
      if (attempt >= attempts || !isRetryableBalanceFetchError(error)) {
        return unavailableBalance('fetch_failed');
      }
      await sleep(delayMsForAttempt(attempt));
    }
  }

  // Unreachable: the loop either returns or exhausts `attempts` inside catch.
  return unavailableBalance('fetch_failed');
};

/**
 * The three columns a brand-new bank-linked account is seeded with. They are
 * one snapshot of one moment, which is why they are produced together from a
 * single reported figure and never assembled field by field:
 *
 *   balance         — the ledger figure the user sees
 *   initial_balance — the opening figure the ledger invariant is measured from
 *                     (balance = initial_balance + Σ transactions)
 *   bank_balance    — the reconciliation reference, dated by bank_balance_date
 *
 * The first import of that account's history then rebases initial_balance
 * (initial_balance -= Σ backfill) on the understanding that `balance` already
 * embodies that history. That understanding is only true if `balance` came
 * from the bank. Seeded from a fabricated zero, every later figure inherits
 * the lie — which is why there is no "seed it with 0 for now" branch here.
 */
export interface NewAccountSeedFields {
  readonly balance: number;
  readonly bank_balance: number;
  readonly bank_balance_date: string;
  readonly initial_balance: number;
}

export type NewAccountSeedPlan =
  | { readonly action: 'seed'; readonly fields: NewAccountSeedFields }
  | { readonly action: 'defer'; readonly reason: BalanceUnavailableReason };

/**
 * Seeding is all-or-nothing per connection.
 *
 * Accounts are only auto-created on a connection's FIRST sync — after that an
 * unlinked bank account is left for the Link Accounts modal. So creating four
 * accounts and holding back the fifth would strand the fifth for good, and the
 * "sync again" the user is told to do would quietly do nothing. Hold them all
 * back together and the retry is a retry that works.
 */
export const isAnySeedingDeferred = (plans: Iterable<NewAccountSeedPlan>): boolean => {
  for (const plan of plans) {
    if (plan.action !== 'seed') {
      return true;
    }
  }
  return false;
};

export const planNewAccountSeeding = (
  snapshot: BankBalanceSnapshot,
  balanceAsOfDay: string
): NewAccountSeedPlan => {
  if (snapshot.status !== 'reported') {
    return { action: 'defer', reason: snapshot.reason };
  }
  return {
    action: 'seed',
    fields: {
      balance: snapshot.amount,
      bank_balance: snapshot.amount,
      bank_balance_date: balanceAsOfDay,
      initial_balance: snapshot.amount
    }
  };
};

/**
 * What an existing linked account's sync writes for the bank's figure.
 *
 * `bank_balance` is a reference the app reconciles against, never a source of
 * money (see migration 20260613090000) — so a sync that could not read it
 * writes NEITHER it nor its date. Yesterday's figure, still carrying
 * yesterday's date, is stale but true; today's date on an unreadable figure
 * would be a fabrication, and the reconciliation screen would silently treat
 * it as this morning's reading.
 */
export type BankBalanceRefreshFields =
  | { readonly bank_balance: number; readonly bank_balance_date: string }
  | { readonly bank_balance?: undefined; readonly bank_balance_date?: undefined };

export const planBankBalanceRefresh = (
  snapshot: BankBalanceSnapshot,
  balanceAsOfDay: string
): BankBalanceRefreshFields => {
  if (snapshot.status !== 'reported') {
    return {};
  }
  return {
    bank_balance: snapshot.amount,
    bank_balance_date: balanceAsOfDay
  };
};

/**
 * Whether a link-time balance snap may run. The snap (link_bank_account_snap)
 * moves the user's real balance to the bank's figure and shifts
 * initial_balance by the same delta — so calling it with a fabricated zero
 * does not merely record a wrong reference, it rewrites what the user believes
 * they hold. Without a reported figure there is nothing to snap to, and the
 * account keeps the balance its owner gave it.
 *
 * ── AND NEVER AN ACCOUNT THE FEED HAS ALREADY WRITTEN TO ────────────────────
 *
 * The snap and the import are two halves of one sum. A snap puts everything
 * the bank has posted into `initial_balance`; the import that follows a FIRST
 * link is a backfill for exactly that reason — it rebases instead of adding
 * (backfillStamp.ts), so nothing is counted twice. That pairing only holds
 * while the account has no feed row.
 *
 * Re-link an account that already has feed history — a consent that lapsed
 * and was renewed, which PSD2 forces every ninety days — and the snap still
 * ran, but the import after it is INCREMENTAL: the account is "already fed",
 * so every row the feed had not yet delivered is added on top of a balance
 * that already contained it. The error lands in `initial_balance`, where
 * `balance = initial_balance + Σ(amount)` goes on holding and every
 * transaction matches the bank row for row. The owner re-authorised American
 * Express at 00:51 on 6 Nov 2026; nine seconds later the catch-up import
 * arrived, and both cards carried a reconcile difference equal — to the
 * penny — to the rows of that one import, until the audit log gave the two
 * timestamps (10 Nov).
 *
 * So `hasFeedHistory` is asked with the import's OWN question (any row of the
 * account with an external_transaction_id), and an account that answers yes
 * is not snapped. The bank's figure is still RECORDED — `bank_balance` is the
 * reconcile screen's reference and moving it touches no ledger figure.
 */
export type BalanceSnapPlan =
  | { readonly action: 'snap'; readonly bankBalance: number }
  /** Already fed: note what the bank said, leave the ledger alone. */
  | { readonly action: 'record'; readonly bankBalance: number }
  | { readonly action: 'skip'; readonly reason: BalanceUnavailableReason };

export const planLinkBalanceSnap = (
  snapshot: BankBalanceSnapshot,
  account: { hasFeedHistory: boolean }
): BalanceSnapPlan => {
  if (snapshot.status !== 'reported') {
    return { action: 'skip', reason: snapshot.reason };
  }
  return account.hasFeedHistory
    ? { action: 'record', bankBalance: snapshot.amount }
    : { action: 'snap', bankBalance: snapshot.amount };
};
