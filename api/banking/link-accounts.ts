import type { VercelRequest, VercelResponse } from '@vercel/node';
import type {
  LinkAccountsRequest,
  LinkAccountsResponse
} from '../../src/types/banking-api.js';
import { AuthError, requireAuth } from '../_lib/auth.js';
import { getServiceRoleSupabase } from '../_lib/supabase.js';
import { setCorsHeaders } from '../_lib/cors.js';
import { createErrorResponse } from '../_lib/http-error.js';
import { applyRateLimit } from '../_lib/rate-limit.js';
import {
  getUserBankConnection,
  withProviderAccessToken,
  type BankConnectionRow
} from '../_lib/banking-sync.js';
import { fetchAccountBalance, fetchCardBalance } from '../_lib/truelayer.js';
import { withSentry } from '../_lib/sentry.js';
import { linkedAccountNumberForStorage } from '../../src/utils/accountNumberInput.js';
import {
  accountBalanceSnapshot,
  cardBalanceSnapshot,
  planBankBalanceRefresh,
  planLinkBalanceSnap,
  resolveBalanceSnapshot,
  unavailableBalance,
  type BankBalanceSnapshot
} from '../../src/services/banking/bankBalanceSnapshot.js';

/**
 * The bank's balance for each account being linked, read HERE rather than
 * taken from the request body.
 *
 * Linking snaps the account to this figure — link_bank_account_snap moves
 * `balance` and shifts `initial_balance` by the same delta — so it decides
 * what the user is told they hold. The browser is not a source for that: the
 * figure it offers came from a discovery call that may itself have failed, and
 * before this it had no way to say so, sending 0 for "the bank did not answer"
 * exactly as it did for "the account is empty". An account with £2,000 in it
 * could be snapped to nothing by one unlucky HTTP request.
 *
 * A failure to read a balance is never fatal here: the mapping between the
 * user's account and the bank's is worth keeping regardless, so every link is
 * still made and only the snap is skipped.
 */
const fetchLinkBalances = async (
  supabase: ReturnType<typeof getServiceRoleSupabase>,
  connection: BankConnectionRow,
  links: LinkAccountsRequest['links']
): Promise<Map<string, BankBalanceSnapshot>> => {
  try {
    return await withProviderAccessToken(supabase, connection, async (accessToken) => {
      const entries = await Promise.all(
        links.map(async (link): Promise<[string, BankBalanceSnapshot]> => [
          link.externalAccountId,
          link.kind === 'card'
            ? await resolveBalanceSnapshot(
                () => fetchCardBalance(accessToken, link.externalAccountId),
                cardBalanceSnapshot
              )
            : await resolveBalanceSnapshot(
                () => fetchAccountBalance(accessToken, link.externalAccountId),
                accountBalanceSnapshot
              )
        ])
      );
      return new Map(entries);
    });
  } catch (error) {
    // The token could not be used or refreshed (the consent has expired since
    // discovery ran). Nothing to snap to; the links themselves still stand.
    console.error('[link-accounts] balance lookup failed for the whole connection', {
      message: error instanceof Error ? error.message : 'unknown error'
    });
    return new Map(links.map((link) => [link.externalAccountId, unavailableBalance('fetch_failed')]));
  }
};

async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCorsHeaders(req, res)) {
    return;
  }

  // This endpoint now calls TrueLayer once per account being linked, so it
  // needs the same abuse brake sync-accounts has: without it, a signed-in
  // caller could spend our provider quota in a loop. Linking is a once-per-
  // connection action, so six a minute is far above any real use.
  if (await applyRateLimit(req, res, { name: 'link-accounts', limit: 6, windowMs: 60_000 })) {
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return createErrorResponse(res, 405, 'Method not allowed', 'method_not_allowed');
  }

  try {
    const auth = await requireAuth(req);
    const supabase = getServiceRoleSupabase();
    const body = req.body as LinkAccountsRequest | undefined;

    if (!body || typeof body.connectionId !== 'string' || !body.connectionId.trim()) {
      return createErrorResponse(res, 400, 'connectionId is required', 'invalid_request');
    }
    if (!Array.isArray(body.links) || body.links.length === 0) {
      return createErrorResponse(res, 400, 'links array is required and must not be empty', 'invalid_request');
    }

    const connectionId = body.connectionId.trim();
    const connection = await getUserBankConnection(supabase, auth.userId, connectionId);
    if (!connection) {
      return createErrorResponse(res, 404, 'Connection not found', 'not_found');
    }

    // Validate all accountIds belong to this user. The stored `type` comes back
    // with them because it decides whether the number in the request body is a
    // card number — see the truncation below; `name` is there to name an
    // account in the response when its balance could not be confirmed.
    const accountIds = body.links.map((l) => l.accountId);
    const { data: userAccounts, error: accountsError } = await supabase
      .from('accounts')
      .select('id, type, name')
      .eq('user_id', auth.userId)
      .in('id', accountIds);

    if (accountsError) {
      return createErrorResponse(res, 500, `Failed to validate accounts: ${accountsError.message}`, 'internal_error');
    }

    const storedTypeByAccountId = new Map<string, unknown>(
      (userAccounts ?? []).map((a: { id: string; type: unknown }) => [a.id, a.type])
    );
    const nameByAccountId = new Map<string, string>(
      (userAccounts ?? []).map((a: { id: string; name: unknown }) => [
        a.id,
        typeof a.name === 'string' ? a.name : ''
      ])
    );
    const validAccountIds = new Set((userAccounts ?? []).map((a: { id: string }) => a.id));
    const invalidIds = accountIds.filter((id) => !validAccountIds.has(id));
    if (invalidIds.length > 0) {
      return createErrorResponse(res, 400, `Invalid account IDs: ${invalidIds.join(', ')}`, 'invalid_account_ids');
    }

    // Ask the bank what these accounts hold before writing anything. Doing it
    // once, up front, means one token acquisition for the whole request.
    const balanceByExternalAccountId = await fetchLinkBalances(supabase, connection, body.links);

    // Create linked_accounts entries and snap balances to the bank's figures
    let linked = 0;
    let snapped = 0;
    const balancesUnavailable: NonNullable<LinkAccountsResponse['balancesUnavailable']> = [];

    for (const link of body.links) {
      // Upsert linked_accounts entry
      const { error: upsertError } = await supabase
        .from('linked_accounts')
        .upsert(
          {
            connection_id: connectionId,
            account_id: link.accountId,
            external_account_id: link.externalAccountId,
            external_account_name: link.externalAccountName,
            external_account_mask: link.externalAccountMask ?? null,
            // 'card' → sync reads /data/v1/cards for this external account.
            external_kind: link.kind === 'card' ? 'card' : 'account'
          },
          { onConflict: 'connection_id,external_account_id' }
        );

      if (upsertError) {
        return createErrorResponse(res, 500, `Failed to link account: ${upsertError.message}`, 'internal_error');
      }

      // Persist the provider-stable bank identifiers on the account (when the
      // client supplied them) so a future disconnect→reconnect can re-adopt
      // this account instead of creating a duplicate (see sync-accounts
      // findAdoptableAccountId). Link time is the primary account-binding path,
      // so without this the re-adoption key would be missing for manually
      // linked accounts.
      //
      // A card's number is cut to its last 4 HERE as well as in the browser
      // (LinkBankAccountsModal), because a request body is not evidence of
      // anything: this handler holds the service-role key, and whatever it
      // writes to accounts.account_number is what every later backup, JSON
      // export and audit row will carry. A card reached through TrueLayer's
      // accounts surface publishes account_number.number — the full card number
      // — so the client trimming it is a convenience, not a guarantee. A bank
      // account number is a different thing and is stored whole.
      const identifierFields: Record<string, string> = {};
      if (link.sortCode) identifierFields.sort_code = link.sortCode;
      if (link.accountNumber) {
        const storableAccountNumber = linkedAccountNumberForStorage(
          link.accountNumber,
          link.kind === 'card',
          storedTypeByAccountId.get(link.accountId)
        );
        // A value with no digits in it leaves nothing to store, and an empty
        // string is not an identifier: leave the column as it was.
        if (storableAccountNumber) {
          identifierFields.account_number = storableAccountNumber;
        }
      }
      if (Object.keys(identifierFields).length > 0) {
        const { error: idError } = await supabase
          .from('accounts')
          .update(identifierFields)
          .eq('id', link.accountId)
          .eq('user_id', auth.userId);
        if (idError) {
          console.error('[link-accounts] failed to store bank identifiers', {
            code: idError.code,
            message: idError.message
          });
          return createErrorResponse(res, 500, 'Failed to store account identifiers', 'internal_error');
        }
      }

      // Snap the account to the bank's reported balance via the audited RPC:
      // it shifts initial_balance by the same delta as balance, so the ledger
      // invariant (balance = initial_balance + Σtxns) holds through the snap
      // and the change lands in financial_audit_log. A raw `balance := bank`
      // overwrite here was audit finding #12.
      //
      // No reported figure, no snap. The account keeps the balance its owner
      // gave it, bank_balance stays as it was (unset for a new account, so the
      // reconciliation screen honestly reads "N/A"), and the next sync fills
      // the bank's figure in once the bank will say what it is.
      //
      // And never an account the feed has already written to: the import
      // after a RE-link is incremental, so a snap there counts every row the
      // feed had not yet delivered twice (planLinkBalanceSnap tells the whole
      // story). Asked with the import's own question, and a failure to ask is
      // a failure of the link — guessing "never fed" is the guess that
      // corrupts a balance.
      const feedHistory = await supabase
        .from('transactions')
        .select('id')
        .eq('account_id', link.accountId)
        .not('external_transaction_id', 'is', null)
        .limit(1);
      if (feedHistory.error) {
        console.error('[link-accounts] could not read feed history', {
          code: feedHistory.error.code,
          message: feedHistory.error.message
        });
        return createErrorResponse(res, 500, 'Failed to read account history', 'internal_error');
      }

      const bankSnapshot =
        balanceByExternalAccountId.get(link.externalAccountId) ?? unavailableBalance('fetch_failed');
      const snapPlan = planLinkBalanceSnap(bankSnapshot, {
        hasFeedHistory: (feedHistory.data ?? []).length > 0
      });

      if (snapPlan.action === 'record') {
        // The reconcile screen's reference, and nothing else: `balance` and
        // `initial_balance` are not in this write.
        const recordResult = await supabase
          .from('accounts')
          .update(planBankBalanceRefresh(bankSnapshot, new Date().toISOString().slice(0, 10)))
          .eq('id', link.accountId)
          .eq('user_id', auth.userId);
        if (recordResult.error) {
          console.error('[link-accounts] could not record the bank balance', {
            code: recordResult.error.code,
            message: recordResult.error.message
          });
          return createErrorResponse(res, 500, 'Failed to record the bank balance', 'internal_error');
        }
      } else if (snapPlan.action === 'snap') {
        const snapResult = await supabase.rpc('link_bank_account_snap', {
          p_account_id: link.accountId,
          p_user_id: auth.userId,
          p_bank_balance: snapPlan.bankBalance
        });

        if (snapResult.error) {
          console.error('[link-accounts] balance snap failed', {
            code: snapResult.error.code,
            message: snapResult.error.message
          });
          return createErrorResponse(res, 500, 'Failed to update account balance', 'internal_error');
        }
        snapped++;
      } else {
        balancesUnavailable.push({
          accountId: link.accountId,
          name: nameByAccountId.get(link.accountId) || link.externalAccountName,
          reason: snapPlan.reason
        });
      }

      linked++;
    }

    const response: LinkAccountsResponse = {
      success: true,
      linked,
      snapped,
      ...(balancesUnavailable.length > 0 ? { balancesUnavailable } : {})
    };
    return res.status(200).json(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return createErrorResponse(res, error.status, error.message, error.code);
    }

    const message = error instanceof Error ? error.message : 'Unexpected error';
    return createErrorResponse(res, 500, message, 'internal_error');
  }
}

// Safety net: report any unhandled throw to Sentry (no-op without SENTRY_DSN).
export default withSentry(handler);
