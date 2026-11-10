import { describe, it, expect, vi } from 'vitest';
import {
  accountBalanceSnapshot,
  balanceForDisplay,
  cardBalanceSnapshot,
  httpStatusOfError,
  isAnySeedingDeferred,
  isRetryableBalanceFetchError,
  planBankBalanceRefresh,
  planLinkBalanceSnap,
  planNewAccountSeeding,
  reportedBalance,
  resolveBalanceSnapshot,
  unavailableBalance,
  type BankBalanceSnapshot
} from './bankBalanceSnapshot';

const AS_OF = '2026-08-08';

/** Never awaits a real timer: retry backoff is injected in every test here. */
const noSleep = async (): Promise<void> => {};

/** The exact message api/_lib/truelayer.ts throws on a failed balance call. */
const trueLayerBalanceError = (status: number, body = 'Service Unavailable'): Error =>
  new Error(`TrueLayer balance fetch failed (acc-1): ${status} ${body}`);

describe('a bank figure and the absence of one are different things', () => {
  it('keeps a real zero balance as a reported zero', () => {
    // The whole point: an account that genuinely holds nothing must survive
    // the same pipeline that refuses to invent a nothing.
    expect(accountBalanceSnapshot(0)).toEqual({ status: 'reported', amount: 0 });
    expect(balanceForDisplay(accountBalanceSnapshot(0))).toBe(0);
  });

  it('reports "no figure" when the bank sent no balance row', () => {
    expect(accountBalanceSnapshot(null)).toEqual({ status: 'unavailable', reason: 'not_reported' });
    expect(accountBalanceSnapshot(undefined)).toEqual({ status: 'unavailable', reason: 'not_reported' });
    expect(accountBalanceSnapshot(Number.NaN)).toEqual({ status: 'unavailable', reason: 'not_reported' });
  });

  it('shows nothing rather than zero when there is no figure', () => {
    expect(balanceForDisplay(unavailableBalance('fetch_failed'))).toBeNull();
    expect(balanceForDisplay(unavailableBalance('not_reported'))).toBeNull();
  });

  it('converts a card figure to an app liability, and refuses to convert a non-figure', () => {
    // TrueLayer card `current` is the amount OWED; the app holds liabilities
    // negative. A card with £20 on it is -20; a card issuer that says nothing
    // is NOT a card with nothing on it.
    expect(cardBalanceSnapshot(20)).toEqual({ status: 'reported', amount: -20 });
    expect(cardBalanceSnapshot(0)).toEqual({ status: 'reported', amount: 0 });
    expect(Object.is(balanceForDisplay(cardBalanceSnapshot(0)), -0)).toBe(false);
    expect(cardBalanceSnapshot(null)).toEqual({ status: 'unavailable', reason: 'not_reported' });
    expect(cardBalanceSnapshot(undefined)).toEqual({ status: 'unavailable', reason: 'not_reported' });
  });
});

describe('seeding a new bank-linked account', () => {
  it('seeds balance, bank_balance and initial_balance from the one reported figure', () => {
    const plan = planNewAccountSeeding(reportedBalance(1234.56), AS_OF);

    expect(plan).toEqual({
      action: 'seed',
      fields: {
        balance: 1234.56,
        bank_balance: 1234.56,
        bank_balance_date: AS_OF,
        initial_balance: 1234.56
      }
    });
  });

  it('seeds a genuinely empty account at zero, dated today', () => {
    expect(planNewAccountSeeding(reportedBalance(0), AS_OF)).toEqual({
      action: 'seed',
      fields: {
        balance: 0,
        bank_balance: 0,
        bank_balance_date: AS_OF,
        initial_balance: 0
      }
    });
  });

  it.each(['fetch_failed', 'not_reported'] as const)(
    'defers rather than opening an account at a figure nobody reported (%s)',
    (reason) => {
      const plan = planNewAccountSeeding(unavailableBalance(reason), AS_OF);

      expect(plan).toEqual({ action: 'defer', reason });
      // The invariant, stated the way it can fail: there is no seed payload at
      // all — no balance, no initial_balance, no bank_balance, and no zero
      // anywhere for the first-import rebase (initial_balance -= Σ) to build on.
      expect('fields' in plan).toBe(false);
      expect(JSON.stringify(plan)).not.toContain('0');
    }
  );

  it('holds back every new account on the connection when any balance is missing', () => {
    // Auto-creation only runs on a connection's first sync, so a partial
    // creation would strand the missing account permanently and make "sync
    // again" a lie.
    const plans = [
      planNewAccountSeeding(reportedBalance(10), AS_OF),
      planNewAccountSeeding(unavailableBalance('fetch_failed'), AS_OF),
      planNewAccountSeeding(reportedBalance(20), AS_OF)
    ];

    expect(isAnySeedingDeferred(plans)).toBe(true);
    expect(isAnySeedingDeferred(plans.filter((plan) => plan.action === 'seed'))).toBe(false);
    expect(isAnySeedingDeferred([])).toBe(false);
  });
});

describe('refreshing an existing account bank balance', () => {
  it('writes the figure and the day it was true for', () => {
    expect(planBankBalanceRefresh(reportedBalance(-42.5), AS_OF)).toEqual({
      bank_balance: -42.5,
      bank_balance_date: AS_OF
    });
  });

  it('writes neither the figure nor the date when the bank reported nothing', () => {
    const fields = planBankBalanceRefresh(unavailableBalance('fetch_failed'), AS_OF);

    // Both must be absent, not undefined-valued: yesterday's figure stays,
    // still carrying yesterday's date. Stamping today's date on an unread
    // balance would tell the reconciliation screen it was confirmed today.
    expect(Object.keys(fields)).toEqual([]);
    expect('bank_balance' in fields).toBe(false);
    expect('bank_balance_date' in fields).toBe(false);
  });
});

describe('the link-time balance snap', () => {
  it('snaps a never-fed account to a reported figure', () => {
    expect(planLinkBalanceSnap(reportedBalance(980.21), { hasFeedHistory: false })).toEqual({
      action: 'snap',
      bankBalance: 980.21
    });
  });

  it('does not snap an account the feed has already written to — it records the figure', () => {
    // A re-link after a lapsed consent. The import that follows is
    // incremental, so a snap here counts every not-yet-delivered row twice:
    // once inside initial_balance, once as the row itself.
    const plan = planLinkBalanceSnap(reportedBalance(980.21), { hasFeedHistory: true });

    expect(plan).toEqual({ action: 'record', bankBalance: 980.21 });
  });

  it('skips an unreported figure whether or not the account was ever fed', () => {
    expect(planLinkBalanceSnap(unavailableBalance('not_reported'), { hasFeedHistory: true })).toEqual({
      action: 'skip',
      reason: 'not_reported'
    });
  });

  it('never snaps without one', () => {
    // link_bank_account_snap moves `balance` AND shifts initial_balance by the
    // same delta, so a fabricated 0 here does not merely record a bad
    // reference — it zeroes what the user believes they hold.
    const plan = planLinkBalanceSnap(unavailableBalance('fetch_failed'), { hasFeedHistory: false });

    expect(plan).toEqual({ action: 'skip', reason: 'fetch_failed' });
    expect('bankBalance' in plan).toBe(false);
  });
});

describe('classifying a failed balance call', () => {
  it('reads the status off a typed HTTP error', () => {
    expect(httpStatusOfError(Object.assign(new Error('nope'), { status: 429 }))).toBe(429);
  });

  it('reads the status out of the message api/_lib/truelayer.ts throws', () => {
    expect(httpStatusOfError(trueLayerBalanceError(503))).toBe(503);
    expect(httpStatusOfError(new Error('TrueLayer card balance fetch failed (acc-9): 401 expired'))).toBe(401);
  });

  it('does not mistake digits in the provider body for a status', () => {
    expect(httpStatusOfError(new Error('boom 404 somewhere'))).toBeUndefined();
    expect(httpStatusOfError('not an error')).toBeUndefined();
    expect(httpStatusOfError(null)).toBeUndefined();
  });

  it('retries what can change and not what cannot', () => {
    expect(isRetryableBalanceFetchError(trueLayerBalanceError(429))).toBe(true);
    expect(isRetryableBalanceFetchError(trueLayerBalanceError(500))).toBe(true);
    expect(isRetryableBalanceFetchError(trueLayerBalanceError(502))).toBe(true);
    expect(isRetryableBalanceFetchError(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryableBalanceFetchError(trueLayerBalanceError(403))).toBe(false);
    expect(isRetryableBalanceFetchError(trueLayerBalanceError(404))).toBe(false);
  });
});

describe('resolveBalanceSnapshot', () => {
  it('retries a transient failure and believes the answer it finally gets', async () => {
    const fetchOnce = vi.fn<() => Promise<number | null>>()
      .mockRejectedValueOnce(trueLayerBalanceError(503))
      .mockResolvedValueOnce(742.11);

    const snapshot = await resolveBalanceSnapshot(fetchOnce, accountBalanceSnapshot, {
      sleep: noSleep
    });

    expect(snapshot).toEqual({ status: 'reported', amount: 742.11 });
    expect(fetchOnce).toHaveBeenCalledTimes(2);
  });

  it('gives up honestly after the last attempt', async () => {
    const fetchOnce = vi.fn<() => Promise<number | null>>()
      .mockRejectedValue(trueLayerBalanceError(503));

    const snapshot = await resolveBalanceSnapshot(fetchOnce, accountBalanceSnapshot, {
      sleep: noSleep
    });

    expect(snapshot).toEqual({ status: 'unavailable', reason: 'fetch_failed' });
    expect(fetchOnce).toHaveBeenCalledTimes(3);
    expect(balanceForDisplay(snapshot)).toBeNull();
  });

  it('backs off between attempts instead of hammering the bank', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const fetchOnce = vi.fn<() => Promise<number | null>>()
      .mockRejectedValue(trueLayerBalanceError(429));

    await resolveBalanceSnapshot(fetchOnce, accountBalanceSnapshot, { sleep });

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 750]);
  });

  it('does not retry a settled refusal', async () => {
    const fetchOnce = vi.fn<() => Promise<number | null>>()
      .mockRejectedValue(trueLayerBalanceError(403, 'insufficient scope'));

    const snapshot = await resolveBalanceSnapshot(fetchOnce, accountBalanceSnapshot, {
      sleep: noSleep
    });

    expect(snapshot).toEqual({ status: 'unavailable', reason: 'fetch_failed' });
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });

  it('does not retry a bank that answered with no balance', async () => {
    const fetchOnce = vi.fn<() => Promise<number | null>>().mockResolvedValue(null);

    const snapshot = await resolveBalanceSnapshot(fetchOnce, accountBalanceSnapshot, {
      sleep: noSleep
    });

    expect(snapshot).toEqual({ status: 'unavailable', reason: 'not_reported' });
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });

  it('re-throws an expired token so the caller can refresh and replay', async () => {
    // Swallowing a 401 here is how an expired consent used to become £0.00.
    const fetchOnce = vi.fn<() => Promise<number | null>>()
      .mockRejectedValue(trueLayerBalanceError(401, 'token expired'));

    await expect(
      resolveBalanceSnapshot(fetchOnce, accountBalanceSnapshot, { sleep: noSleep })
    ).rejects.toThrow(/401/);
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });

  it('reports each failed attempt without ever handing out a balance', async () => {
    const onAttemptFailed = vi.fn<(attempt: number, error: unknown) => void>();
    const fetchOnce = vi.fn<() => Promise<number | null>>()
      .mockRejectedValueOnce(trueLayerBalanceError(500))
      .mockResolvedValueOnce(5);

    await resolveBalanceSnapshot(fetchOnce, accountBalanceSnapshot, {
      sleep: noSleep,
      onAttemptFailed
    });

    expect(onAttemptFailed).toHaveBeenCalledTimes(1);
    expect(onAttemptFailed.mock.calls[0]?.[0]).toBe(1);
  });
});

describe('end to end: what a link-day balance failure writes', () => {
  /** The chain sync-accounts runs: fetch → snapshot → seeding decision. */
  const seedingFor = async (fetchOnce: () => Promise<number | null>) =>
    planNewAccountSeeding(
      await resolveBalanceSnapshot(fetchOnce, accountBalanceSnapshot, { sleep: noSleep }),
      AS_OF
    );

  it('writes nothing at all when TrueLayer is down at link time', async () => {
    const plan = await seedingFor(() => Promise.reject(trueLayerBalanceError(502)));

    expect(plan.action).toBe('defer');
  });

  it('still opens a genuinely empty account at zero', async () => {
    const plan = await seedingFor(() => Promise.resolve(0));

    expect(plan).toEqual({
      action: 'seed',
      fields: { balance: 0, bank_balance: 0, bank_balance_date: AS_OF, initial_balance: 0 }
    });
  });

  it('leaves an existing account bank balance untouched when the call fails', async () => {
    const snapshot: BankBalanceSnapshot = await resolveBalanceSnapshot(
      () => Promise.reject(trueLayerBalanceError(504)),
      accountBalanceSnapshot,
      { sleep: noSleep }
    );

    expect(planBankBalanceRefresh(snapshot, AS_OF)).toEqual({});
    expect(planLinkBalanceSnap(snapshot).action).toBe('skip');
  });
});
