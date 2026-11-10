import type { PendingAtBank } from '../services/banking/pendingAtBank.js';

// POST /api/banking/create-link-token
export interface CreateLinkTokenRequest {
  institutionId?: string;
  mode?: 'connect' | 'reauth';
  connectionId?: string;
}

export interface CreateLinkTokenResponse {
  authUrl: string;
  state: string;
}

// POST /api/banking/exchange-token
export interface ExchangeTokenRequest {
  code: string;
  state: string;
}

export interface ExchangeTokenResponse {
  success: boolean;
  connectionId: string;
  institutionId: string;
  institutionName: string;
  institutionLogo?: string;
  accountsCount: number;
}

/**
 * Why the bank reported no balance for an account.
 *
 *  'not_reported'  the call succeeded and carried no balance (an empty
 *                  results array, or a non-numeric amount) — a settled answer
 *  'fetch_failed'  the call itself failed after retries — a momentary answer
 *
 * The distinction exists so nothing downstream has to guess: both mean "we do
 * not know", and neither may be written as a figure. See
 * src/services/banking/bankBalanceSnapshot.ts.
 */
export type BalanceUnavailableReason = 'not_reported' | 'fetch_failed';

// POST /api/banking/discover-accounts
export interface DiscoverAccountsRequest {
  connectionId: string;
}

export interface DiscoveredBankAccount {
  externalAccountId: string;
  name: string;
  type: string;
  /**
   * The bank's reported balance, or null when it reported none. NOT 0: a zero
   * here used to mean either "this account is empty" or "the balance endpoint
   * failed", and the UI showed both as £0.00 and prefilled both into the
   * new-account form.
   */
  balance: number | null;
  currency: string;
  sortCode?: string;
  accountNumber?: string;
  mask?: string;
  /**
   * Which TrueLayer surface serves this external account: 'account' →
   * /data/v1/accounts (banks), 'card' → /data/v1/cards (credit cards, e.g.
   * American Express). Absent means 'account' (pre-cards clients).
   */
  kind?: 'account' | 'card';
}

export interface DiscoverAccountsResponse {
  success: boolean;
  accounts: DiscoveredBankAccount[];
  error?: string;
}

// POST /api/banking/link-accounts
export interface LinkAccountsRequest {
  connectionId: string;
  // No `balance` field, deliberately. Linking snaps the account to the bank's
  // figure — a write that moves real money on screen — and the browser is not
  // a source of bank figures: an older tab whose discovery call failed would
  // post a fabricated 0 and zero the account. The handler fetches the balance
  // from TrueLayer itself at snap time. (Older clients still send `balance`;
  // an unread property in the body is harmless.)
  links: Array<{
    externalAccountId: string;
    accountId: string;
    externalAccountName: string;
    externalAccountMask?: string;
    // Provider-stable bank identifiers, persisted on the account so a future
    // disconnect→reconnect can re-adopt it instead of creating a duplicate.
    sortCode?: string;
    accountNumber?: string;
    /** 'card' when the external account is served by the Cards API. */
    kind?: 'account' | 'card';
  }>;
}

export interface LinkAccountsResponse {
  success: boolean;
  linked: number;
  /**
   * Of those linked, how many were snapped to a bank-reported balance. An
   * account the feed has already written to is never snapped — a re-link
   * records the bank's figure for reconciliation and leaves the ledger alone.
   */
  snapped: number;
  /**
   * Accounts linked WITHOUT a balance snap because the bank reported no
   * figure. Their balances are untouched — whatever the user entered stands.
   */
  balancesUnavailable?: Array<{ accountId: string; name: string; reason: BalanceUnavailableReason }>;
  error?: string;
}

// POST /api/banking/sync-accounts
export interface SyncAccountsRequest {
  connectionId: string;
  createUnlinked?: boolean;
}

export interface SyncAccountsResponse {
  /**
   * False when the sync could not finish the job — including the case where
   * accounts could not be added because the bank reported no balance to seed
   * them from. `error` then carries the sentence shown to the user.
   */
  success: boolean;
  accountsSynced: number;
  accounts: Array<{
    id: string;
    name: string;
    type: string;
    /** null when the bank reported no balance for this account. Never a stand-in 0. */
    balance: number | null;
    currency: string;
    mask?: string;
  }>;
  /** Every account this sync could not read a balance for, and why. */
  balancesUnavailable?: Array<{ name: string; reason: BalanceUnavailableReason }>;
  error?: string;
}

// POST /api/banking/sync-transactions
export interface SyncTransactionsRequest {
  connectionId: string;
  startDate?: string;
  endDate?: string;
}

export interface SyncTransactionsResponse {
  success: boolean;
  transactionsImported: number;
  duplicatesSkipped: number;
  /**
   * Existing rows repointed to a re-issued provider id (same transaction,
   * new external id — the Aug 2026 churned-cheque class). Neither imported
   * nor a duplicate; present only when non-zero.
   */
  idChurnRepaired?: number;
  /**
   * Hand-made transfer legs adopted by feed rows this sync — the same
   * payment recorded by the owner before the feed delivered it (28 Aug).
   */
  transfersAdopted?: number;
  /** Imported (CSV/manual) rows the feed recognised as its own and stamped —
   *  one payment, one row, the owner's categorisation kept. */
  importedRowsAdopted?: number;
  /**
   * Rows the bank offered that the owner had DELETED, and which were
   * therefore not re-imported (28 Aug: a card payment he had already recorded
   * as a transfer came back on the next sync and credited the card twice).
   *
   * Reported separately from duplicatesSkipped because they are a different
   * sentence. A duplicate is the app noticing it already has something; this
   * is the app honouring a decision the owner made. Silence would make a
   * count of 40 offered and 39 stored unanswerable.
   */
  deletedByOwnerSkipped?: number;
  /**
   * Rows one of the owner's import rules categorised, tagged or renamed on the
   * way in (28 Aug, his ruling: "the sync should say what it did rather than
   * transforming things invisibly").
   *
   * Counts rows actually CHANGED, not rows a rule was run against — a number
   * nobody can check is worse than no number.
   */
  rulesApplied?: number;
  error?: string;
}

// POST /api/banking/disconnect
export interface DisconnectRequest {
  connectionId: string;
}

export interface DisconnectResponse {
  success: boolean;
  /**
   * Whether the PROVIDER accepted the revocation, as distinct from whether we
   * forgot the connection.
   *
   * The two used to be the same thing said once, and the thing being said was
   * the weaker of them: `disconnect` deleted our row and never touched
   * TrueLayer, so the app forgot the bank and the bank did not forget the app.
   * The row delete still always happens — a connection left standing recreates
   * its accounts on the next sync — so this is how a caller can tell a full
   * disconnection from a local one.
   */
  revokedAtProvider?: boolean;
  error?: string;
}

// GET /api/banking/connections
export interface BankConnection {
  id: string;
  provider: string;
  institutionId: string;
  institutionName: string;
  institutionLogo?: string;
  status: 'connected' | 'error' | 'reauth_required';
  lastSync?: string;
  accountsCount: number;
  /** Reckley account ids linked to this connection (for per-account UI). */
  linkedAccountIds: string[];
  /**
   * What the bank says is pending — authorised, not yet posted — keyed by
   * Reckley account id. Only accounts with at least one pending item appear;
   * absent altogether when none do. See services/banking/pendingAtBank.
   */
  pendingAtBank?: Record<string, PendingAtBank>;
  expiresAt?: string;
  /**
   * The last failure the server recorded against this connection, if any.
   *
   * Present on a CONNECTED row too, and that is the point: a sync can fail
   * without the connection being broken (one bank endpoint flaking while
   * authentication is perfectly good), and this column is the only thing
   * that tells those two apart. It was missing from the endpoint's select,
   * so the UI's "The provider said: …" line could never render.
   */
  error?: string | null;
}

export type ConnectionsResponse = BankConnection[];

// POST /api/banking/webhook
export interface WebhookPayload {
  event_type: string;
  connection_id?: string;
  [key: string]: unknown;
}

// GET /api/banking/ops-alert-stats
export interface OpsAlertStatsRow {
  dedupeKey: string;
  eventType: string;
  lastSentAt: string | null;
  suppressedCount: number;
  updatedAt: string | null;
  isAboveThreshold: boolean;
}

export interface OpsAlertStatsSummary {
  totalSuppressed: number;
  maxSuppressedCount: number;
  mostRecentLastSentAt: string | null;
  mostRecentUpdatedAt: string | null;
  rowsAboveThreshold: number;
}

export interface OpsAlertStatsResponse {
  success: boolean;
  filters: {
    eventType: string | null;
    eventTypePrefix?: string | null;
    minSuppressed: number;
    limit: number;
    onlyAboveThreshold: boolean;
  };
  threshold: {
    enabled: boolean;
    suppressionThreshold: number | null;
    suppressionNotifyEvery: number | null;
  };
  count: number;
  summary: OpsAlertStatsSummary;
  rows: OpsAlertStatsRow[];
}

// POST /api/banking/ops-alert-test
export interface OpsAlertTestRequest {
  message?: string;
}

export interface OpsAlertTestResponse {
  success: boolean;
  eventType: string;
  delivered: boolean;
}

// POST /api/banking/dead-letter-admin
export interface DeadLetterAdminResetRequest {
  connectionId?: string;
  connectionIds?: string[];
  resetAllDeadLettered?: boolean;
  confirm?: string;
  reason?: string;
  limit?: number;
}

export interface DeadLetterAdminRow {
  connectionId: string;
  userId: string | null;
  provider: string | null;
  status: string | null;
  institutionName: string | null;
  queueAttempts: number;
  queueLastError: string | null;
  queueNextRetryAt: string | null;
  updatedAt: string | null;
}

export interface DeadLetterAdminListResponse {
  success: boolean;
  maxRetryAttempts: number;
  count: number;
  rows: DeadLetterAdminRow[];
}

export interface DeadLetterAdminResetResponse {
  success: boolean;
  maxRetryAttempts: number;
  requested: number;
  resetConnectionIds: string[];
  auditId: string;
  auditStatus: 'completed' | 'pending';
}

// GET /api/banking/dead-letter-admin-audit
export interface DeadLetterAdminAuditRow {
  id: string;
  adminUserId: string | null;
  adminClerkId: string;
  action: string;
  scope: string;
  reason: string | null;
  requestedCount: number;
  resetCount: number;
  maxRetryAttempts: number | null;
  connectionIds: string[];
  metadata: Record<string, unknown>;
  status: string;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DeadLetterAdminAuditSummary {
  requestedTotal: number;
  resetTotal: number;
  pendingCount: number;
  completedCount: number;
  failedCount: number;
}

export interface DeadLetterAdminAuditResponse {
  success: boolean;
  filters: {
    status: string | null;
    scope: string | null;
    action: string | null;
    adminClerkId: string | null;
    since: string | null;
    until: string | null;
    cursor: string | null;
    limit: number;
  };
  count: number;
  summary: DeadLetterAdminAuditSummary;
  page: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
  rows: DeadLetterAdminAuditRow[];
}

export interface ErrorResponse {
  error: string;
  code: string;
  requestId?: string;
  details?: unknown;
}

// Re-export as a namespace-like object for backwards compatibility
export const BankingAPI = {
  // Type-only exports can't be in a const, so use type re-exports instead
} as const;

// Type exports under BankingAPI namespace pattern
export type { CreateLinkTokenRequest as BankingAPICreateLinkTokenRequest };
export type { CreateLinkTokenResponse as BankingAPICreateLinkTokenResponse };
export type { ExchangeTokenRequest as BankingAPIExchangeTokenRequest };
export type { ExchangeTokenResponse as BankingAPIExchangeTokenResponse };
export type { SyncAccountsRequest as BankingAPISyncAccountsRequest };
export type { SyncAccountsResponse as BankingAPISyncAccountsResponse };
export type { SyncTransactionsRequest as BankingAPISyncTransactionsRequest };
export type { SyncTransactionsResponse as BankingAPISyncTransactionsResponse };
export type { DisconnectRequest as BankingAPIDisconnectRequest };
export type { DisconnectResponse as BankingAPIDisconnectResponse };
export type { BankConnection as BankingAPIConnection };
export type { ConnectionsResponse as BankingAPIConnectionsResponse };
export type { WebhookPayload as BankingAPIWebhookPayload };
export type { OpsAlertStatsRow as BankingAPIOpsAlertStatsRow };
export type { OpsAlertStatsSummary as BankingAPIOpsAlertStatsSummary };
export type { OpsAlertStatsResponse as BankingAPIOpsAlertStatsResponse };
export type { OpsAlertTestRequest as BankingAPIOpsAlertTestRequest };
export type { OpsAlertTestResponse as BankingAPIOpsAlertTestResponse };
export type { DeadLetterAdminRow as BankingAPIDeadLetterAdminRow };
export type { DeadLetterAdminListResponse as BankingAPIDeadLetterAdminListResponse };
export type { DeadLetterAdminResetRequest as BankingAPIDeadLetterAdminResetRequest };
export type { DeadLetterAdminResetResponse as BankingAPIDeadLetterAdminResetResponse };
export type { DeadLetterAdminAuditRow as BankingAPIDeadLetterAdminAuditRow };
export type { DeadLetterAdminAuditSummary as BankingAPIDeadLetterAdminAuditSummary };
export type { DeadLetterAdminAuditResponse as BankingAPIDeadLetterAdminAuditResponse };
export type { ErrorResponse as BankingAPIErrorResponse };
export type { DiscoverAccountsRequest as BankingAPIDiscoverAccountsRequest };
export type { DiscoverAccountsResponse as BankingAPIDiscoverAccountsResponse };
export type { DiscoveredBankAccount as BankingAPIDiscoveredBankAccount };
export type { LinkAccountsRequest as BankingAPILinkAccountsRequest };
export type { LinkAccountsResponse as BankingAPILinkAccountsResponse };
