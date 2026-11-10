import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BalanceUnavailableReason,
  SyncAccountsResponse
} from '../../src/types/banking-api.js';
import {
  markConnectionSyncSuccess,
  withProviderAccessToken,
  type BankConnectionRow
} from './banking-sync.js';
import { fetchAccountBalance, fetchAccounts, fetchCardBalance, fetchCardPendingTransactions, fetchCards } from './truelayer.js';
import {
  PENDING_UNAVAILABLE,
  pendingColumns,
  pendingFromFeed,
  type PendingAtBankSnapshot
} from '../../src/services/banking/pendingAtBank.js';
import {
  cardDisplayName,
  cardMask
} from '../../src/services/banking/cardNormalization.js';
import { selectAdoptableAccountId, type AdoptionCandidate } from '../../src/services/banking/accountMatching.js';
import {
  accountBalanceSnapshot,
  balanceForDisplay,
  cardBalanceSnapshot,
  isAnySeedingDeferred,
  isExpiredTokenBalanceError,
  planBankBalanceRefresh,
  planNewAccountSeeding,
  resolveBalanceSnapshot,
  type BankBalanceSnapshot,
  type NewAccountSeedPlan
} from '../../src/services/banking/bankBalanceSnapshot.js';

/**
 * THE ACCOUNT SYNC, WITHOUT THE HTTP.
 *
 * The body of api/banking/sync-accounts.ts, moved here unchanged for the
 * reason sync-transactions-core.ts gives: the cloud refresh cron runs the
 * same sync with no request in hand. Same contract, too — `connection` is the
 * caller's own and already past the needs-reauth guard; failure is by
 * throwing, and nothing is marked on the way out.
 */

const inferMask = (account: {
  account_number?: {
    number?: string;
    iban?: string;
  };
}): string | undefined => {
  const accountNumber = account.account_number?.number?.replace(/\s+/g, '');
  if (accountNumber && accountNumber.length >= 4) {
    return accountNumber.slice(-4);
  }

  const iban = account.account_number?.iban?.replace(/\s+/g, '');
  if (iban && iban.length >= 4) {
    return iban.slice(-4);
  }

  return undefined;
};

/** The provider-STABLE identifier (full sort code + account number) from the
 *  TrueLayer payload. Unlike account_id, these survive a disconnect/reconnect,
 *  so they are the key used to re-adopt an existing account (see
 *  findAdoptableAccountId). */
const extractBankIdentifiers = (account: {
  account_number?: { number?: string; sort_code?: string };
}): { accountNumber: string | null; sortCode: string | null } => ({
  accountNumber: account.account_number?.number?.trim() || null,
  sortCode: account.account_number?.sort_code?.trim() || null
});

const mapAccountType = (accountType: string | undefined): string => {
  const normalized = (accountType ?? '').toLowerCase();
  switch (normalized) {
    case 'transaction':
      return 'checking';
    case 'savings':
      return 'savings';
    case 'credit_card':
      return 'credit';
    default:
      return 'checking';
  }
};

interface SyncedTrueLayerAccount {
  externalAccountId: string;
  name: string;
  type: string;
  /** What the bank said it holds — or that it said nothing. Never a stand-in 0. */
  balance: BankBalanceSnapshot;
  currency: string;
  mask?: string;
  accountNumber?: string | null;
  sortCode?: string | null;
  /** 'card' → served by /data/v1/cards; 'account' → /data/v1/accounts. */
  kind: 'account' | 'card';
  /**
   * What the bank says is pending — read for cards only, whose balance can
   * run ahead of the posted feed. 'unavailable' for a bank account, and for a
   * card whose issuer did not answer.
   */
  pending: PendingAtBankSnapshot;
}

/**
 * A card's pending items, or 'unavailable'. One attempt: this explains a
 * difference on the reconcile screen and nothing depends on it, so a flaky
 * endpoint is not worth three round trips on every sync. An expired token is
 * re-thrown, for the same reason a balance read re-throws it — the whole
 * operation is replayed with a fresh one.
 */
const readCardPending = async (accessToken: string, externalAccountId: string): Promise<PendingAtBankSnapshot> => {
  try {
    return pendingFromFeed(await fetchCardPendingTransactions(accessToken, externalAccountId), { cardSigned: true });
  } catch (error) {
    if (isExpiredTokenBalanceError(error)) {
      throw error;
    }
    return PENDING_UNAVAILABLE;
  }
};

interface LinkedAccountRow {
  account_id: string;
  external_account_id: string;
}

/** An account this sync could not read a balance for, and why. */
interface UnreadBalance {
  name: string;
  reason: BalanceUnavailableReason;
}

interface PersistOutcome {
  /**
   * Names of accounts this run did NOT create, because the connection had no
   * bank-reported balance to seed every new account from. Actionable: they are
   * missing from the user's account list until the next sync adds them.
   */
  notCreated: string[];
  /**
   * Every account whose balance the bank did not report. For an existing
   * account the only consequence is that bank_balance keeps its previous
   * value and previous date — the ledger is untouched.
   */
  unreadBalances: UnreadBalance[];
}

/**
 * Reconnect-safe account recovery (audit: a disconnect→reconnect created a
 * DUPLICATE account). On a fresh connection the linked_accounts mapping is gone
 * (disconnect hard-deletes the connection, cascade-deleting its links) and
 * TrueLayer reissues account_id, so neither the per-connection link nor the
 * external id can locate the user's existing account — the sync then auto-creates
 * a duplicate. Match instead on the provider-STABLE identifier (sort code +
 * account number, normalised). Adopt ONLY a single, unambiguous, currently-
 * UNLINKED candidate, so we never hijack an account managed by another live
 * connection, never merge two real accounts that merely share a name, and never
 * touch `balance` (the caller's update path sets bank_balance only).
 */
const findAdoptableAccountId = async (
  supabase: SupabaseClient,
  userId: string,
  account: SyncedTrueLayerAccount
): Promise<string | null> => {
  if (!account.accountNumber || !account.sortCode) {
    return null; // bank gave no stable identifier — skip the scan entirely
  }

  // User-scoped only (never a cross-tenant scan): the user's own active accounts
  // that carry a stored account number.
  const candidatesResult = await supabase
    .from('accounts')
    .select('id, account_number, sort_code')
    .eq('user_id', userId)
    .eq('is_active', true)
    .not('account_number', 'is', null);
  if (candidatesResult.error) {
    throw new Error(`Failed to scan accounts for re-adoption: ${candidatesResult.error.message}`);
  }
  const candidates: AdoptionCandidate[] = (candidatesResult.data ?? []).map((row) => ({
    id: row.id as string,
    accountNumber: (row.account_number as string | null) ?? null,
    sortCode: (row.sort_code as string | null) ?? null
  }));
  if (candidates.length === 0) {
    return null;
  }

  // Which of those candidates are already linked to ANY connection (never adopt
  // a live-linked account). One query, scoped to the candidate ids.
  const linksResult = await supabase
    .from('linked_accounts')
    .select('account_id')
    .in('account_id', candidates.map((c) => c.id));
  if (linksResult.error) {
    throw new Error(`Failed to check existing links: ${linksResult.error.message}`);
  }
  const linkedAccountIds = new Set<string>(
    (linksResult.data ?? []).map((row) => row.account_id as string)
  );

  return selectAdoptableAccountId(candidates, linkedAccountIds, account.accountNumber, account.sortCode);
};

const persistAccountsAndLinks = async (
  supabase: SupabaseClient,
  userId: string,
  connection: {
    id: string;
    institution_name: string;
  },
  accounts: SyncedTrueLayerAccount[]
): Promise<PersistOutcome> => {
  const outcome: PersistOutcome = {
    notCreated: [],
    unreadBalances: accounts.flatMap((account) =>
      account.balance.status === 'unavailable'
        ? [{ name: account.name, reason: account.balance.reason }]
        : []
    )
  };
  const linkedResult = await supabase
    .from('linked_accounts')
    .select('account_id, external_account_id')
    .eq('connection_id', connection.id);

  if (linkedResult.error) {
    throw new Error(`Failed to load linked accounts: ${linkedResult.error.message}`);
  }

  const existingLinks = (linkedResult.data ?? []) as LinkedAccountRow[];
  const linkByExternalAccountId = new Map<string, LinkedAccountRow>();
  existingLinks.forEach((row) => {
    if (row.external_account_id) {
      linkByExternalAccountId.set(row.external_account_id, row);
    }
  });

  const nowIso = new Date().toISOString();
  // The day the bank's figure is true for. Recorded so a manually imported
  // statement can tell whether it is older than what the feed already holds —
  // without it, last March's statement would overwrite this morning's sync.
  const balanceAsOfDay = nowIso.slice(0, 10);
  const externalAccountIds = new Set<string>();

  // Decide the seeding of every account BEFORE writing any of them, because
  // the decision is all-or-nothing for this connection.
  //
  // Auto-creation only ever runs on a connection's first sync — once any link
  // exists, an unlinked external account is left for the Link Accounts modal
  // (below). So creating four accounts and deferring the fifth would strand
  // that fifth one: the next sync would find links and skip it for good, and
  // "sync again to add it" would be untrue. Defer them together, create them
  // together, and the retry the user is told about is a retry that works.
  const seedPlans = new Map<string, NewAccountSeedPlan>(
    accounts.map((account) => [
      account.externalAccountId,
      planNewAccountSeeding(account.balance, balanceAsOfDay)
    ])
  );
  const seedingDeferred = isAnySeedingDeferred(seedPlans.values());

  for (const account of accounts) {
    externalAccountIds.add(account.externalAccountId);

    const existingLink = linkByExternalAccountId.get(account.externalAccountId);
    let accountId = existingLink?.account_id ?? null;

    // Reconnect recovery: when this external account has no link (a fresh
    // connection after a disconnect, or TrueLayer reissued the account_id),
    // re-adopt the user's existing account for the same real bank account
    // instead of auto-creating a duplicate. Routes through the update branch
    // below, which sets bank_balance only — never `balance` — so no double-count.
    if (!accountId) {
      accountId = await findAdoptableAccountId(supabase, userId, account);
    }

    // Stable bank identifiers, stored so future reconnects can re-adopt this
    // account (only overwrite when the bank actually supplied them).
    const identifierFields: Record<string, string> = {};
    if (account.accountNumber) identifierFields.account_number = account.accountNumber;
    if (account.sortCode) identifierFields.sort_code = account.sortCode;

    if (accountId) {
      // The account's name belongs to the USER: sync fills a blank name but
      // never overwrites one that has been typed — feeds used to rename
      // accounts to the bank's own label on every sync.
      const currentName = await supabase
        .from('accounts')
        .select('name')
        .eq('id', accountId)
        .eq('user_id', userId)
        .maybeSingle();
      // A failed lookup counts as "named": renaming is only safe when the
      // account is POSITIVELY known to be blank.
      const hasUserName = currentName.error !== null || Boolean(currentName.data?.name?.trim());

      // The bank's reported figure goes to bank_balance (the reconciliation
      // reference) ONLY. `balance` is ledger-authoritative — moved exclusively
      // by the atomic transaction RPCs — so overwriting it here would silently
      // discard manual entries and break balance = initial_balance + Σtxns
      // (audit finding #12). See migration 20260613090000 for the invariant.
      //
      // And when the bank reported nothing, neither column moves: the figure
      // already stored stays, still carrying the date it was true for. Writing
      // today's date over an unread balance would tell the reconciliation
      // screen that this morning's reading confirmed a number nobody read.
      const balanceRefresh = planBankBalanceRefresh(account.balance, balanceAsOfDay);
      const updateResult = await supabase
        .from('accounts')
        .update({
          ...(hasUserName ? {} : { name: account.name }),
          type: account.type,
          ...balanceRefresh,
          currency: account.currency,
          institution: connection.institution_name,
          is_active: true,
          updated_at: nowIso,
          ...identifierFields
        })
        .eq('id', accountId)
        .eq('user_id', userId)
        .select('id')
        .maybeSingle();

      if (updateResult.error) {
        throw new Error(`Failed to update mapped account: ${updateResult.error.message}`);
      }

      if (!updateResult.data?.id) {
        accountId = null;
      }
    }

    if (!accountId) {
      // If linked_accounts already exist for this connection, skip auto-creating
      // new accounts for unlinked external accounts. The user should use the
      // Link Accounts modal to manually link them first.
      if (existingLinks.length > 0) {
        continue;
      }

      // A new account is seeded with the bank's figure in all three balance
      // columns at once. Without a figure there is nothing honest to seed it
      // with: 0 would assert the account is empty, and the first import's
      // rebase (initial_balance -= Σ) would then build on a number nobody
      // reported. So the account is not created at all this run — an account
      // the user can see is missing beats an account that lies about its
      // balance — and the caller tells them to sync again.
      const seedPlan = seedPlans.get(account.externalAccountId);
      if (seedingDeferred || seedPlan?.action !== 'seed') {
        outcome.notCreated.push(account.name);
        continue;
      }

      const insertAccountResult = await supabase
        .from('accounts')
        .insert({
          user_id: userId,
          name: account.name,
          type: account.type,
          ...seedPlan.fields,
          currency: account.currency,
          institution: connection.institution_name,
          is_active: true,
          created_at: nowIso,
          updated_at: nowIso,
          ...identifierFields
        })
        .select('id')
        .single();

      if (insertAccountResult.error || !insertAccountResult.data?.id) {
        throw new Error(`Failed to create account for bank link: ${insertAccountResult.error?.message ?? 'unknown error'}`);
      }

      accountId = insertAccountResult.data.id;
    }

    const upsertLinkResult = await supabase
      .from('linked_accounts')
      .upsert(
        {
          connection_id: connection.id,
          account_id: accountId,
          external_account_id: account.externalAccountId,
          external_account_mask: account.mask ?? null,
          external_account_name: account.name,
          external_kind: account.kind
        },
        {
          onConflict: 'connection_id,external_account_id'
        }
      );

    if (upsertLinkResult.error) {
      throw new Error(`Failed to store linked account mapping: ${upsertLinkResult.error.message}`);
    }

    // What the bank says is pending, beside the balance it was read with. A
    // SEPARATE write that is allowed to fail: the link above is what the sync
    // cannot do without, and this is a sentence on one screen. Kept out of the
    // upsert so that a database without these columns yet (the migration is
    // applied by hand) still syncs.
    const pendingResult = await supabase
      .from('linked_accounts')
      .update(pendingColumns(account.pending, nowIso))
      .eq('connection_id', connection.id)
      .eq('external_account_id', account.externalAccountId);
    if (pendingResult.error) {
      console.error('[sync-accounts] could not record pending-at-bank', {
        message: pendingResult.error.message
      });
    }
  }

  const staleExternalAccountIds = existingLinks
    .filter((row) => !externalAccountIds.has(row.external_account_id))
    .map((row) => row.external_account_id);

  if (staleExternalAccountIds.length === 0) {
    return outcome;
  }

  const deleteStaleLinksResult = await supabase
    .from('linked_accounts')
    .delete()
    .eq('connection_id', connection.id)
    .in('external_account_id', staleExternalAccountIds);

  if (deleteStaleLinksResult.error) {
    throw new Error(`Failed to remove stale linked accounts: ${deleteStaleLinksResult.error.message}`);
  }

  return outcome;
};

/**
 * The sentence the user reads when accounts were left out. It names the
 * consequence — which accounts are missing — rather than a count, and gives
 * the two ways to fix it. Both lists are named, because they can differ: the
 * bank may have failed on one account while the whole batch was held back.
 */
const describeAccountsNotCreated = (
  institutionName: string,
  outcome: PersistOutcome
): string => {
  const unread = outcome.unreadBalances.map((entry) => entry.name).join(', ');
  const missing = outcome.notCreated.join(', ');
  const one = outcome.notCreated.length === 1;
  const opening = unread
    ? `${institutionName} didn't report a balance for ${unread}.`
    : `${institutionName} didn't report the balances needed to open these accounts.`;
  return `${opening} Rather than open an account at a balance your bank never gave, ${missing} ${one ? 'was' : 'were'} not added — sync again to add ${one ? 'it' : 'them'}, or add ${one ? 'it' : 'them'} yourself and use Link Accounts.`;
};

export const runAccountSync = async (
  supabase: SupabaseClient,
  userId: string,
  connection: BankConnectionRow
): Promise<SyncAccountsResponse> => {
  const accounts = await withProviderAccessToken(supabase, connection, async (accessToken) => {
    const truelayerAccounts = await fetchAccounts(accessToken);
    // Cards live on a separate API surface; [] when the token predates the
    // cards scope, so old bank connections sync exactly as before.
    const truelayerCards = await fetchCards(accessToken);

    const syncedAccounts = await Promise.all(
      truelayerAccounts.map(async (account): Promise<SyncedTrueLayerAccount> => {
        // Retried, then believed — including when the answer is "no figure".
        // The old code caught the failure and left `balance` at its initial
        // 0, which the seeding path below then wrote to three columns as a
        // fact. A 401 is re-thrown from here so withProviderAccessToken can
        // refresh the token and replay the whole operation.
        const balance = await resolveBalanceSnapshot(
          () => fetchAccountBalance(accessToken, account.account_id),
          accountBalanceSnapshot
        );

        const type = mapAccountType(account.account_type);
        // A card can arrive on the ACCOUNTS surface too (account_type
        // 'credit_card'), and there account_number.number is the card number
        // itself. Persisting it would put a full PAN in accounts.account_number
        // and from there into every backup, export and audit row — so a card is
        // given exactly what the /cards surface gives one below: no identifiers
        // and a last-4 mask. Re-adoption is unaffected; findAdoptableAccountId
        // already returns null without a sort code, which no card has.
        const identifiers = type === 'credit'
          ? { accountNumber: null, sortCode: null }
          : extractBankIdentifiers(account);
        return {
          externalAccountId: account.account_id,
          name: account.display_name?.trim() || connection.institution_name,
          type,
          balance,
          currency: account.currency || 'GBP',
          mask: inferMask(account),
          accountNumber: identifiers.accountNumber,
          sortCode: identifiers.sortCode,
          kind: 'account',
          pending: PENDING_UNAVAILABLE
        };
      })
    );

    const syncedCards = await Promise.all(
      truelayerCards.map(async (card): Promise<SyncedTrueLayerAccount> => {
        // Card `current` = amount OWED (positive) → app liability (negative).
        // An issuer that sends no balance used to arrive here as 0 twice
        // over: the catch left it at 0, and cardBalanceToAppBalance turned a
        // null `current` into 0 as well — "we could not reach Amex" and "you
        // owe Amex nothing" were the same value.
        const balance = await resolveBalanceSnapshot(
          () => fetchCardBalance(accessToken, card.account_id),
          cardBalanceSnapshot
        );

        return {
          externalAccountId: card.account_id,
          name: cardDisplayName(card, connection.institution_name),
          type: 'credit',
          balance,
          currency: card.currency || 'GBP',
          mask: cardMask(card.partial_card_number),
          // Cards carry no sort code / account number, so reconnect
          // re-adoption is skipped for them (see findAdoptableAccountId).
          accountNumber: null,
          sortCode: null,
          kind: 'card',
          pending: await readCardPending(accessToken, card.account_id)
        };
      })
    );

    return [...syncedAccounts, ...syncedCards];
  });

  const outcome = await persistAccountsAndLinks(supabase, userId, connection, accounts);

  // The connection itself is healthy — the bank answered, it simply did not
  // answer one balance call — so it keeps its connected status and the sync
  // is recorded as having run. What did not finish is reported per-sync.
  await markConnectionSyncSuccess(supabase, connection.id, userId);
  const partialNote = outcome.notCreated.length > 0
    ? `Not added (no bank balance to open them with): ${outcome.notCreated.join(', ')}`
    : outcome.unreadBalances.length > 0
      ? `Bank balance not refreshed for: ${outcome.unreadBalances.map((entry) => entry.name).join(', ')}`
      : null;
  await supabase.from('sync_history').insert({
    connection_id: connection.id,
    sync_type: 'accounts',
    status: partialNote ? 'partial' : 'success',
    records_synced: accounts.length,
    ...(partialNote ? { error: partialNote.slice(0, 2000) } : {}),
    created_at: new Date().toISOString()
  });

  // An account that was not created is missing from the user's books, so the
  // sync did not succeed and says so — the UI turns `error` into a "Bank
  // sync incomplete" warning. A stale bank_balance on an EXISTING account is
  // not a failure: nothing was written, the ledger is untouched, and the
  // figure still on screen carries the date it was true for.
  return {
    success: outcome.notCreated.length === 0,
    accountsSynced: accounts.length,
    accounts: accounts.map((account) => ({
      id: account.externalAccountId,
      name: account.name,
      type: account.type,
      balance: balanceForDisplay(account.balance),
      currency: account.currency,
      mask: account.mask
    })),
    ...(outcome.unreadBalances.length > 0 ? { balancesUnavailable: outcome.unreadBalances } : {}),
    ...(outcome.notCreated.length > 0
      ? { error: describeAccountsNotCreated(connection.institution_name, outcome) }
      : {})
  };
};
