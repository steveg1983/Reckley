import { getOptionalEnv, getRequiredEnv } from './env.js';

const SANDBOX_AUTH_URL = 'https://auth.truelayer-sandbox.com';
const PRODUCTION_AUTH_URL = 'https://auth.truelayer.com';
const SANDBOX_API_URL = 'https://api.truelayer-sandbox.com';
const PRODUCTION_API_URL = 'https://api.truelayer.com';

interface AuthUrlOptions {
  redirectUri: string;
  scope: string[];
  nonce: string;
  state: string;
  enableOpenBanking?: boolean;
  enableOauth?: boolean;
  enableMock?: boolean;
  /** A single TrueLayer provider id — deep-links past TrueLayer's chooser. */
  providerId?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

interface AccountProviderInfo {
  provider_id: string;
  display_name: string;
  logo_uri?: string;
}

export interface TrueLayerAccount {
  account_id: string;
  provider: AccountProviderInfo;
  display_name?: string;
  account_type?: string;
  currency?: string;
  account_number?: {
    number?: string;
    iban?: string;
    sort_code?: string;
  };
}

export interface TrueLayerTransaction {
  transaction_id: string;
  account_id: string;
  description: string;
  amount: number;
  currency: string;
  timestamp?: string;
  normalised_provider_transaction_id?: string;
  transaction_type?: string;
  merchant_name?: string;
  meta?: Record<string, unknown>;
}

interface AccountsResponse {
  results: TrueLayerAccount[];
}

interface AccountBalanceResult {
  available?: number | string | null;
  current?: number | string | null;
}

interface AccountBalancesResponse {
  results: AccountBalanceResult[];
}

interface TransactionsResponse {
  results: TrueLayerTransaction[];
}

const getEnvironment = (): string =>
  (getOptionalEnv('TRUELAYER_ENVIRONMENT') ?? 'production').toLowerCase();

const getAuthBaseUrl = (): string =>
  getEnvironment() === 'production' ? PRODUCTION_AUTH_URL : SANDBOX_AUTH_URL;

const getApiBaseUrl = (): string =>
  getEnvironment() === 'production' ? PRODUCTION_API_URL : SANDBOX_API_URL;

export const getRedirectUri = (): string => getRequiredEnv('TRUELAYER_REDIRECT_URI');

export const isSandboxEnvironment = (): boolean =>
  getEnvironment() !== 'production';

/**
 * Our institution ids → TrueLayer provider ids, taken from TrueLayer's live
 * registry (GET https://auth.truelayer.com/api/providers, checked
 * 2026-08-03) — not guessed. Passing exactly one provider in `providers`
 * skips TrueLayer's own bank chooser, so clicking "American Express" in our
 * shortcut list lands directly on the Amex consent screen instead of asking
 * the user to find Amex a second time. An unmapped id falls back to the full
 * UK list — a worse journey, never a broken one.
 */
const TRUELAYER_PROVIDER_BY_INSTITUTION: Record<string, string> = {
  amex: 'ob-amex',
  barclays: 'ob-barclays',
  barclaycard: 'ob-barclaycard',
  'first-direct': 'ob-first-direct',
  halifax: 'ob-halifax',
  hsbc: 'ob-hsbc',
  lloyds: 'ob-lloyds',
  monzo: 'ob-monzo',
  nationwide: 'ob-nationwide',
  natwest: 'ob-natwest',
  revolut: 'ob-revolut',
  santander: 'ob-santander-personal',
  starling: 'ob-starling',
  tsb: 'ob-tsb',
};

export const providerForInstitution = (institutionId: string | undefined): string | undefined => {
  if (!institutionId) return undefined;
  /*
   * A STORED connection already holds TrueLayer's OWN provider id.
   *
   * `bank_connections.institution_id` is written from the provider metadata
   * TrueLayer returns with the accounts (`provider.provider_id`), so a
   * Revolut connection is saved as `ob-revolut` — while the shortcut map
   * below is keyed by OUR ids (`revolut`, `amex`). The lookup therefore
   * missed on every existing connection and fell through to the full UK
   * list.
   *
   * That is nearly invisible when CONNECTING (the user picked their bank
   * from our list a moment ago, so a chooser is merely redundant) and badly
   * wrong when RECONNECTING: the user clicks Reconnect on a row that says
   * REVOLUT and lands on ninety banks, which reads as the wrong page and is
   * a very good way to abandon the journey. The owner's connection went
   * twelve days without a completed re-authorisation while its SCA
   * exemption sat expired.
   *
   * So an id that is already TrueLayer's passes straight through. Their
   * registry (GET /api/providers, 90 entries) uses these prefixes and no
   * others.
   */
  if (/^(ob|oauth|xs2a)-/.test(institutionId) || institutionId === 'mock') {
    return institutionId;
  }
  return TRUELAYER_PROVIDER_BY_INSTITUTION[institutionId];
};

export const buildAuthUrl = (options: AuthUrlOptions): string => {
  const url = new URL(getAuthBaseUrl());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('client_id', getRequiredEnv('TRUELAYER_CLIENT_ID'));
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', options.scope.join(' '));
  url.searchParams.set('nonce', options.nonce);
  url.searchParams.set('state', options.state);

  // CRITICAL: TrueLayer requires at least one provider to be specified.
  // Sandbox always uses 'mock'. In production a single mapped provider deep
  // links straight to that bank's consent screen; otherwise the full UK list.
  const isSandbox = isSandboxEnvironment();
  url.searchParams.set(
    'providers',
    isSandbox ? 'mock' : (options.providerId ?? 'uk-ob-all')
  );

  if (options.enableMock) {
    url.searchParams.set('enable_mock', 'true');
  }
  if (options.enableOpenBanking) {
    url.searchParams.set('enable_open_banking_providers', 'true');
  }
  if (options.enableOauth) {
    url.searchParams.set('enable_oauth_providers', 'true');
  }
  return url.toString();
};

export const exchangeCodeForToken = async (code: string): Promise<TokenResponse> => {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: getRequiredEnv('TRUELAYER_CLIENT_ID'),
    client_secret: getRequiredEnv('TRUELAYER_CLIENT_SECRET'),
    redirect_uri: getRedirectUri(),
    code
  });

  const response = await fetch(`${getAuthBaseUrl()}/connect/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`TrueLayer token exchange failed: ${response.status} ${details}`);
  }

  const data = (await response.json()) as TokenResponse;
  if (!data.access_token) {
    throw new Error('TrueLayer token exchange returned no access token');
  }

  return data;
};

export const refreshAccessToken = async (refreshToken: string): Promise<TokenResponse> => {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: getRequiredEnv('TRUELAYER_CLIENT_ID'),
    client_secret: getRequiredEnv('TRUELAYER_CLIENT_SECRET'),
    refresh_token: refreshToken
  });

  const response = await fetch(`${getAuthBaseUrl()}/connect/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`TrueLayer token refresh failed: ${response.status} ${details}`);
  }

  const data = (await response.json()) as TokenResponse;
  if (!data.access_token) {
    throw new Error('TrueLayer token refresh returned no access token');
  }

  return data;
};

/**
 * Tell TrueLayer to forget this connection.
 *
 * `DELETE /data/v1/me` revokes the access token and the consent behind it, so
 * the provider stops holding an authorisation for this user's bank.
 *
 * ─ WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Until now `api/banking/disconnect.ts` deleted our own `bank_connections` row
 * and nothing else. The app forgot the bank; the bank did not forget the app.
 * That is a defensible thing to ship and an indefensible thing to IMPLY, and
 * the wording around it implied the stronger one — "Delete All Data", "you
 * would need to re-authorise".
 *
 * Returns whether the provider accepted it rather than throwing, because the
 * caller has to delete the row either way: refusing to disconnect because a
 * revocation failed would leave the connection in place, and a connection left
 * in place is what recreates the accounts on the next sync.
 */
export const revokeAccessToken = async (accessToken: string): Promise<boolean> => {
  const response = await fetch(`${getApiBaseUrl()}/data/v1/me`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  // 401/403 mean the token is already dead, which is the state we were asking
  // for. Anything else that is not ok is a real failure to revoke.
  return response.ok || response.status === 401 || response.status === 403;
};

export interface TrueLayerCard {
  account_id: string;
  card_network?: string;
  card_type?: string;
  currency?: string;
  display_name?: string;
  partial_card_number?: string;
  name_on_card?: string;
  provider: AccountProviderInfo;
}

interface CardsResponse {
  results: TrueLayerCard[];
}

interface CardBalanceResult {
  /** Amount OWED on the card (positive = expenditure). */
  current?: number | string | null;
  /** Remaining CREDIT — never a balance; never use as a fallback. */
  available?: number | string | null;
}

interface CardBalancesResponse {
  results: CardBalanceResult[];
}

/**
 * The user's cards on this connection. A connection authorised BEFORE the
 * `cards` scope was added will be rejected with 403 — treated as "no cards"
 * so pre-existing bank connections keep syncing untouched; the user re-links
 * to pick up card access. 501 endpoint_not_supported (a provider with no
 * cards surface) is likewise "no cards" — deterministic per provider, so
 * tolerating it cannot mask a transient failure.
 */
export const fetchCards = async (accessToken: string): Promise<TrueLayerCard[]> => {
  const response = await fetch(`${getApiBaseUrl()}/data/v1/cards`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (response.status === 403 || response.status === 501) {
    return [];
  }
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`TrueLayer cards fetch failed: ${response.status} ${details}`);
  }

  const data = (await response.json()) as CardsResponse;
  return Array.isArray(data.results) ? data.results : [];
};

/**
 * The card's `current` figure: the amount OWED (positive). Deliberately no
 * fallback to `available` — that is remaining credit, and using it would
 * report a £20 debt on a £3,300 limit as £3,280 of money.
 */
export const fetchCardBalance = async (
  accessToken: string,
  accountId: string
): Promise<number | null> => {
  const response = await fetch(`${getApiBaseUrl()}/data/v1/cards/${encodeURIComponent(accountId)}/balance`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`TrueLayer card balance fetch failed (${accountId}): ${response.status} ${details}`);
  }

  const payload = (await response.json()) as CardBalancesResponse;
  const balanceRow = Array.isArray(payload.results) ? payload.results[0] : undefined;
  if (!balanceRow) {
    return null;
  }
  return toNumber(balanceRow.current);
};

/**
 * Card transactions. Same row shape as account transactions, but the SIGN
 * convention is inverted: positive = money out of the card (a purchase).
 * Callers normalise via cardAmountToAppSigned.
 */
export const fetchCardTransactions = async (
  accessToken: string,
  accountId: string,
  options: { from?: string; to?: string } = {}
): Promise<TrueLayerTransaction[]> => {
  const url = new URL(`${getApiBaseUrl()}/data/v1/cards/${encodeURIComponent(accountId)}/transactions`);
  if (options.from) {
    url.searchParams.set('from', options.from);
  }
  if (options.to) {
    url.searchParams.set('to', options.to);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`TrueLayer card transactions fetch failed (${accountId}): ${response.status} ${details}`);
  }

  const payload = (await response.json()) as TransactionsResponse;
  // Same PII rule as account transactions: never log contents.
  return Array.isArray(payload.results) ? payload.results : [];
};

/**
 * A card's PENDING transactions — authorised, not yet posted. Read for one
 * purpose: to say how much of the issuer's balance the posted feed has not
 * caught up with (services/banking/pendingAtBank). Never imported: a pending
 * row can change amount, or disappear, before it posts.
 *
 * Throws on any failure, the message in the shape httpStatusOfError reads, so
 * the caller can tell an expired token (replay the sync) from an issuer that
 * simply does not offer the endpoint (say nothing). Same sign convention as
 * posted card rows: positive = money out of the card.
 */
export const fetchCardPendingTransactions = async (
  accessToken: string,
  accountId: string
): Promise<TrueLayerTransaction[]> => {
  const response = await fetch(
    `${getApiBaseUrl()}/data/v1/cards/${encodeURIComponent(accountId)}/transactions/pending`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`TrueLayer card pending transactions fetch failed (${accountId}): ${response.status} ${details}`);
  }

  const payload = (await response.json()) as TransactionsResponse;
  // Same PII rule as posted transactions: never log contents.
  return Array.isArray(payload.results) ? payload.results : [];
};

export const fetchAccounts = async (accessToken: string): Promise<TrueLayerAccount[]> => {
  const response = await fetch(`${getApiBaseUrl()}/data/v1/accounts`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  // Cards-only providers (e.g. American Express) reject the bank-accounts
  // surface with 501 endpoint_not_supported — a deterministic per-provider
  // response, so "no bank accounts" is the truth, not an error. ONLY 501 is
  // tolerated: any other failure must still throw, because sync-accounts
  // prunes stale links against this result and a transient failure mapped to
  // [] would delete the user's account links.
  if (response.status === 501) {
    return [];
  }
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`TrueLayer accounts fetch failed: ${response.status} ${details}`);
  }

  const data = (await response.json()) as AccountsResponse;
  return Array.isArray(data.results) ? data.results : [];
};

const toNumber = (value: number | string | null | undefined): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export const fetchAccountBalance = async (
  accessToken: string,
  accountId: string
): Promise<number | null> => {
  const response = await fetch(`${getApiBaseUrl()}/data/v1/accounts/${encodeURIComponent(accountId)}/balance`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`TrueLayer balance fetch failed (${accountId}): ${response.status} ${details}`);
  }

  const payload = (await response.json()) as AccountBalancesResponse;
  const balanceRow = Array.isArray(payload.results) ? payload.results[0] : undefined;
  if (!balanceRow) {
    return null;
  }

  const current = toNumber(balanceRow.current);
  if (current !== null) {
    return current;
  }
  return toNumber(balanceRow.available);
};

interface FetchTransactionsOptions {
  from?: string;
  to?: string;
}

export const fetchTransactions = async (
  accessToken: string,
  accountId: string,
  options: FetchTransactionsOptions = {}
): Promise<TrueLayerTransaction[]> => {
  const url = new URL(`${getApiBaseUrl()}/data/v1/accounts/${encodeURIComponent(accountId)}/transactions`);
  if (options.from) {
    url.searchParams.set('from', options.from);
  }
  if (options.to) {
    url.searchParams.set('to', options.to);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`TrueLayer transactions fetch failed (${accountId}): ${response.status} ${details}`);
  }

  const payload = (await response.json()) as TransactionsResponse;
  const results = Array.isArray(payload.results) ? payload.results : [];
  // Intentionally NOT logging transaction contents or the account id: a raw
  // transaction carries the user's merchant, amount and description (PII), and
  // the external account id is sensitive. Sync counts are recorded in
  // sync_history server-side for observability instead.
  return results;
};
