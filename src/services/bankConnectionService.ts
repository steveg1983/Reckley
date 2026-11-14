import type {
  DeadLetterAdminAuditResponse,
  DeadLetterAdminListResponse,
  DeadLetterAdminResetResponse,
  ConnectionsResponse,
  CreateLinkTokenRequest,
  CreateLinkTokenResponse,
  DiscoverAccountsResponse,
  DiscoveredBankAccount,
  DisconnectResponse,
  ErrorResponse,
  ExchangeTokenResponse,
  LinkAccountsRequest,
  LinkAccountsResponse,
  OpsAlertStatsResponse,
  OpsAlertTestResponse,
  SyncAccountsResponse,
  SyncTransactionsResponse
} from '../types/banking-api';
import type { PendingAtBank } from './banking/pendingAtBank';
import { isRuntimeBypassAllowed } from '../utils/runtimeMode';
import { compareText } from '../utils/localeFormat';

export interface BankConnection {
  id: string;
  provider: 'plaid' | 'truelayer' | 'manual';
  institutionId: string;
  institutionName: string;
  institutionLogo?: string;
  status: 'connected' | 'error' | 'reauth_required';
  lastSync?: Date;
  accounts: string[];
  accountsCount?: number;
  /** Reckley account ids linked to this connection. */
  linkedAccountIds: string[];
  /**
   * What the bank says is pending on each linked account, keyed by Reckley
   * account id — present only for accounts with at least one pending item.
   * The reconcile screen reads it to explain a difference the posted feed
   * cannot (services/banking/pendingAtBank).
   */
  pendingAtBank?: Record<string, PendingAtBank>;
  createdAt?: Date;
  expiresAt?: Date;
  error?: string;
}

export interface BankInstitution {
  id: string;
  name: string;
  logo?: string;
  country: string;
  provider: 'plaid' | 'truelayer';
  supportsAccountDetails: boolean;
  supportsTransactions: boolean;
  supportsBalance: boolean;
}

export interface SyncResult {
  success: boolean;
  accountsUpdated: number;
  transactionsImported: number;
  errors: string[];
  /**
   * The API's own name for why it refused, when it did: 'rate_limited' is the
   * one the connections panel tells apart, because a throttle is not a sync
   * that lost transactions and must not be reported as one (owner, 1 Oct
   * 2026: three "Re-read 30 days" presses after a Sync All tripped the
   * per-minute limit and the panel said "some transactions didn't come
   * through" over a re-read that had brought back every one of them).
   */
  code?: string;
  /**
   * What a re-read found besides new rows — present on a transactions-only
   * sync. `alreadyHeld` is every row the bank offered that the ledger had
   * (by its bank id, or re-issued under a new one); `matchedToOwnRows` is the
   * rows the owner had entered or imported himself, now recognised as the
   * bank's and not doubled. A re-read that brings nothing new still did
   * something, and the panel should be able to say what.
   */
  alreadyHeld?: number;
  matchedToOwnRows?: number;
}

/** The refusal code off a thrown request, if the API gave one. */
const refusalCode = (error: unknown): string | undefined =>
  error instanceof Error && typeof (error as Partial<BankingApiError>).code === 'string'
    ? (error as BankingApiError).code
    : undefined;

export interface ConnectBankOptions {
  mode?: 'connect' | 'reauth';
  connectionId?: string;
}

/**
 * The two separate answers a disconnect comes back with.
 *
 * They used to be one, and the one was the stronger reading of the weaker
 * fact: `disconnect` threw the response away and returned `true`, so a
 * TrueLayer that REFUSED the revocation still reached the user as a clean
 * disconnection — the app had forgotten the bank and the bank had not
 * forgotten the app, and nothing on screen said so.
 *
 * The endpoint has always been more careful than we were. It deletes the row
 * either way, because a connection left standing is what recreates the
 * accounts on the next sync, and reports the provider's answer separately.
 */
export interface DisconnectOutcome {
  /** The connection is gone from Reckley. */
  removed: boolean;
  /**
   * Whether the PROVIDER confirmed it had dropped the consent.
   *
   * Left `undefined` rather than coerced to `false` when the response does not
   * carry the field: "this deployment did not say" is not "the bank refused",
   * and only the second is worth alarming somebody with.
   */
  revokedAtProvider?: boolean;
}

export interface OpsAlertStatsQuery {
  eventType?: string;
  eventTypePrefix?: string;
  minSuppressed?: number;
  limit?: number;
  onlyAboveThreshold?: boolean;
}

export interface DeadLetterAdminAuditQuery {
  status?: 'pending' | 'completed' | 'failed';
  scope?: 'single' | 'bulk' | 'all_dead_lettered';
  action?: 'reset_dead_letter';
  adminClerkId?: string;
  since?: string;
  until?: string;
  cursor?: string;
  limit?: number;
}

export interface BankingApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
}

type FetchLike = typeof fetch;
type Logger = Pick<Console, 'log' | 'warn' | 'error'>;
type AuthTokenProvider = () => Promise<string | null>;
const E2E_TEST_TOKEN = 'e2e-test-token';

export interface BankConnectionServiceOptions {
  fetch?: FetchLike;
  logger?: Logger;
  apiBaseUrl?: string;
  authTokenProvider?: AuthTokenProvider | null;
}

export class BankConnectionService {
  private connections: BankConnection[] = [];
  private connectionListeners = new Set<() => void>();
  private configStatus = { plaid: false, trueLayer: false };
  private configStatusKnown = true;
  private fetcher: FetchLike | null;
  private logger: Logger;
  private apiBaseUrl: string;
  private tokenProvider: AuthTokenProvider | null;
  private hasLoggedTestAuthFallback = false;

  constructor(options: BankConnectionServiceOptions = {}) {
    const defaultFetch = typeof fetch !== 'undefined'
      ? fetch.bind(globalThis) as typeof fetch
      : null;
    this.fetcher = options.fetch ?? defaultFetch;
    const fallbackLogger = typeof console !== 'undefined' ? console : undefined;
    const noop = () => {};
    this.logger = {
      log: options.logger?.log ?? (fallbackLogger?.log?.bind(fallbackLogger) ?? noop),
      warn: options.logger?.warn ?? (fallbackLogger?.warn?.bind(fallbackLogger) ?? noop),
      error: options.logger?.error ?? (fallbackLogger?.error?.bind(fallbackLogger) ?? noop)
    };
    const envBase = typeof import.meta !== 'undefined'
      ? (import.meta.env?.VITE_BANKING_API_BASE_URL as string | undefined)
      : undefined;
    this.apiBaseUrl = (options.apiBaseUrl ?? envBase ?? '').trim();
    this.tokenProvider = options.authTokenProvider ?? null;
  }

  setAuthTokenProvider(provider: AuthTokenProvider | null): void {
    this.tokenProvider = provider;
  }

  setApiBaseUrl(baseUrl: string | null): void {
    this.apiBaseUrl = (baseUrl ?? '').trim();
  }

  private shouldUseE2eAuthFallback(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    const env = typeof import.meta !== 'undefined' ? import.meta.env : undefined;

    // Every other bypass in the app defers to isRuntimeBypassAllowed, which
    // refuses to unlock anything in a production build. Without it, a
    // production deploy that inherited VITE_E2E_TEST_MODE_AUTH=true (the flag
    // is baked into the bundle at build time) would send a hard-coded bearer
    // token for anyone who set ?testMode=true.
    if (!env || !isRuntimeBypassAllowed(env)) {
      return false;
    }

    const e2eAuthEnabled = env.VITE_E2E_TEST_MODE_AUTH === 'true';
    if (!e2eAuthEnabled) {
      return false;
    }

    const params = new URLSearchParams(window.location.search);
    const queryTestModeEnabled = params.get('testMode') === 'true';
    const storageTestModeEnabled = window.localStorage.getItem('isTestMode') === 'true';
    return queryTestModeEnabled || storageTestModeEnabled;
  }

  private resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) {
      return path;
    }
    const base = this.apiBaseUrl.replace(/\/+$/, '');
    if (!base) {
      return path.startsWith('/') ? path : `/${path}`;
    }
    if (path.startsWith('/')) {
      return `${base}${path}`;
    }
    return `${base}/${path}`;
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = this.tokenProvider ? await this.tokenProvider() : null;
    if (token) {
      return { Authorization: `Bearer ${token}` };
    }

    if (this.shouldUseE2eAuthFallback()) {
      if (!this.hasLoggedTestAuthFallback) {
        this.logger.warn(
          'Using VITE_E2E_TEST_MODE_AUTH fallback token for banking API requests in test mode'
        );
        this.hasLoggedTestAuthFallback = true;
      }
      return { Authorization: `Bearer ${E2E_TEST_TOKEN}` };
    }

    throw new Error('Missing authentication token');
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.fetcher) {
      throw new Error('Fetch API is not available');
    }

    const headers = new Headers(init.headers ?? {});
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const authHeaders = await this.getAuthHeaders();
    Object.entries(authHeaders).forEach(([key, value]) => headers.set(key, value));

    const response = await this.fetcher(this.resolveUrl(path), {
      ...init,
      headers
    });

    if (!response.ok) {
      let message = `Request failed with status ${response.status}`;
      let code: string | undefined;
      let details: unknown;
      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('application/json')) {
        try {
          const payload = (await response.json()) as Partial<ErrorResponse>;
          if (typeof payload.error === 'string' && payload.error.trim()) {
            message = payload.error;
          }
          if (typeof payload.code === 'string') {
            code = payload.code;
          }
          details = payload.details;
        } catch {
          message = await response.text();
        }
      } else {
        const text = await response.text();
        if (text.trim()) {
          message = text;
        }
      }

      const error = new Error(message) as BankingApiError;
      error.status = response.status;
      error.code = code;
      error.details = details;
      throw error;
    }

    return response.json() as Promise<T>;
  }

  private async requestText(path: string, init: RequestInit = {}): Promise<string> {
    if (!this.fetcher) {
      throw new Error('Fetch API is not available');
    }

    const headers = new Headers(init.headers ?? {});
    const authHeaders = await this.getAuthHeaders();
    Object.entries(authHeaders).forEach(([key, value]) => headers.set(key, value));

    const response = await this.fetcher(this.resolveUrl(path), {
      ...init,
      headers
    });

    if (!response.ok) {
      let message = `Request failed with status ${response.status}`;
      let code: string | undefined;
      let details: unknown;
      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('application/json')) {
        try {
          const payload = (await response.json()) as Partial<ErrorResponse>;
          if (typeof payload.error === 'string' && payload.error.trim()) {
            message = payload.error;
          }
          if (typeof payload.code === 'string') {
            code = payload.code;
          }
          details = payload.details;
        } catch {
          message = await response.text();
        }
      } else {
        const text = await response.text();
        if (text.trim()) {
          message = text;
        }
      }

      const error = new Error(message) as BankingApiError;
      error.status = response.status;
      error.code = code;
      error.details = details;
      throw error;
    }

    return response.text();
  }

  async getOpsAlertStats(query: OpsAlertStatsQuery = {}): Promise<OpsAlertStatsResponse> {
    const params = new URLSearchParams();

    if (typeof query.eventType === 'string' && query.eventType.trim()) {
      params.set('eventType', query.eventType.trim());
    }
    if (typeof query.eventTypePrefix === 'string' && query.eventTypePrefix.trim()) {
      params.set('eventTypePrefix', query.eventTypePrefix.trim());
    }
    if (typeof query.minSuppressed === 'number' && Number.isFinite(query.minSuppressed)) {
      params.set('minSuppressed', String(Math.max(0, Math.floor(query.minSuppressed))));
    }
    if (typeof query.limit === 'number' && Number.isFinite(query.limit)) {
      const limit = Math.min(Math.max(Math.floor(query.limit), 1), 200);
      params.set('limit', String(limit));
    }
    if (query.onlyAboveThreshold === true) {
      params.set('onlyAboveThreshold', '1');
    }

    const queryString = params.toString();
    const path = queryString
      ? `/api/banking/ops-alert-stats?${queryString}`
      : '/api/banking/ops-alert-stats';

    return this.request<OpsAlertStatsResponse>(path, { method: 'GET' });
  }

  async triggerOpsAlertTest(message?: string): Promise<OpsAlertTestResponse> {
    const trimmedMessage = typeof message === 'string' ? message.trim() : '';
    const payload = trimmedMessage ? { message: trimmedMessage } : {};

    return this.request<OpsAlertTestResponse>('/api/banking/ops-alert-test', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  async resetAllDeadLettered(
    confirm: string,
    reason: string,
    limit?: number
  ): Promise<DeadLetterAdminResetResponse> {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw new Error('Reason is required');
    }

    const payload: {
      resetAllDeadLettered: true;
      confirm: string;
      reason: string;
      limit?: number;
    } = {
      resetAllDeadLettered: true,
      confirm,
      reason: trimmedReason
    };

    if (typeof limit === 'number' && Number.isFinite(limit)) {
      payload.limit = Math.max(1, Math.floor(limit));
    }

    return this.request<DeadLetterAdminResetResponse>('/api/banking/dead-letter-admin', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  async resetDeadLetterConnections(
    connectionIds: string[],
    reason: string,
    confirm?: string
  ): Promise<DeadLetterAdminResetResponse> {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw new Error('Reason is required');
    }

    const uniqueConnectionIds = Array.from(new Set(
      connectionIds
        .map((connectionId) => connectionId.trim())
        .filter(Boolean)
    )).slice(0, 200);

    if (uniqueConnectionIds.length === 0) {
      throw new Error('At least one connection is required');
    }

    const payload: {
      connectionIds: string[];
      reason: string;
      confirm?: string;
    } = {
      connectionIds: uniqueConnectionIds,
      reason: trimmedReason
    };
    const trimmedConfirm = typeof confirm === 'string' ? confirm.trim() : '';
    if (trimmedConfirm) {
      payload.confirm = trimmedConfirm;
    }

    return this.request<DeadLetterAdminResetResponse>('/api/banking/dead-letter-admin', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  async getDeadLetterRows(limit = 25): Promise<DeadLetterAdminListResponse> {
    const parsedLimit = Math.min(200, Math.max(1, Math.floor(limit)));
    return this.request<DeadLetterAdminListResponse>(`/api/banking/dead-letter-admin?limit=${parsedLimit}`, {
      method: 'GET'
    });
  }

  async getDeadLetterAudit(query: DeadLetterAdminAuditQuery = {}): Promise<DeadLetterAdminAuditResponse> {
    const params = new URLSearchParams();

    if (typeof query.status === 'string' && query.status.trim()) {
      params.set('status', query.status.trim());
    }
    if (typeof query.scope === 'string' && query.scope.trim()) {
      params.set('scope', query.scope.trim());
    }
    if (typeof query.action === 'string' && query.action.trim()) {
      params.set('action', query.action.trim());
    }
    if (typeof query.adminClerkId === 'string' && query.adminClerkId.trim()) {
      params.set('adminClerkId', query.adminClerkId.trim());
    }
    if (typeof query.since === 'string' && query.since.trim()) {
      params.set('since', query.since.trim());
    }
    if (typeof query.until === 'string' && query.until.trim()) {
      params.set('until', query.until.trim());
    }
    if (typeof query.cursor === 'string' && query.cursor.trim()) {
      params.set('cursor', query.cursor.trim());
    }
    if (typeof query.limit === 'number' && Number.isFinite(query.limit)) {
      const bounded = Math.min(200, Math.max(1, Math.floor(query.limit)));
      params.set('limit', String(bounded));
    }

    const queryString = params.toString();
    const path = queryString
      ? `/api/banking/dead-letter-admin-audit?${queryString}`
      : '/api/banking/dead-letter-admin-audit';

    return this.request<DeadLetterAdminAuditResponse>(path, { method: 'GET' });
  }

  async exportDeadLetterAuditCsv(query: DeadLetterAdminAuditQuery = {}): Promise<string> {
    const params = new URLSearchParams();

    if (typeof query.status === 'string' && query.status.trim()) {
      params.set('status', query.status.trim());
    }
    if (typeof query.scope === 'string' && query.scope.trim()) {
      params.set('scope', query.scope.trim());
    }
    if (typeof query.action === 'string' && query.action.trim()) {
      params.set('action', query.action.trim());
    }
    if (typeof query.adminClerkId === 'string' && query.adminClerkId.trim()) {
      params.set('adminClerkId', query.adminClerkId.trim());
    }
    if (typeof query.since === 'string' && query.since.trim()) {
      params.set('since', query.since.trim());
    }
    if (typeof query.until === 'string' && query.until.trim()) {
      params.set('until', query.until.trim());
    }
    if (typeof query.cursor === 'string' && query.cursor.trim()) {
      params.set('cursor', query.cursor.trim());
    }
    if (typeof query.limit === 'number' && Number.isFinite(query.limit)) {
      const bounded = Math.min(5000, Math.max(1, Math.floor(query.limit)));
      params.set('limit', String(bounded));
    }

    const queryString = params.toString();
    const path = queryString
      ? `/api/banking/dead-letter-admin-audit-export?${queryString}`
      : '/api/banking/dead-letter-admin-audit-export';

    return this.requestText(path, { method: 'GET' });
  }

  async refreshConnections(): Promise<BankConnection[]> {
    try {
      const data = await this.request<ConnectionsResponse>('/api/banking/connections', {
        method: 'GET'
      });

      this.connections = data.map((connection) => ({
        id: connection.id,
        provider: connection.provider as BankConnection['provider'],
        institutionId: connection.institutionId,
        institutionName: connection.institutionName,
        institutionLogo: connection.institutionLogo,
        status: connection.status,
        lastSync: connection.lastSync ? new Date(connection.lastSync) : undefined,
        accounts: [],
        accountsCount: connection.accountsCount,
        linkedAccountIds: connection.linkedAccountIds ?? [],
        ...(connection.pendingAtBank ? { pendingAtBank: connection.pendingAtBank } : {}),
        expiresAt: connection.expiresAt ? new Date(connection.expiresAt) : undefined,
        // The last failure the server recorded. Present on a CONNECTED row
        // too — that is the "connected, but the last sync did not finish"
        // state, which is the difference between a bank we cannot reach and
        // one endpoint that flaked.
        error: connection.error ?? undefined
      }));
    } catch (error) {
      this.logger.error('Failed to load bank connections', error as Error);
      this.connections = [];
    }

    this.connectionListeners.forEach((listener) => listener());
    return this.connections;
  }

  getConnections(): BankConnection[] {
    return this.connections;
  }

  /**
   * Be told when the cache above is replaced.
   *
   * Read-only surfaces (the dashboard's attention card, a register's banner)
   * want the connections that are ALREADY loaded, not a fetch of their own —
   * one is running from Layout on every signed-in session. Without a signal
   * they would each have to ask the network again to find out something the
   * app already knows. The returned function unsubscribes.
   */
  subscribeToConnections(listener: () => void): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  async refreshConfigStatus(): Promise<{ plaid: boolean; trueLayer: boolean }> {
    try {
      // The health endpoint answers with a verdict, not an inventory: which
      // banking secrets are present is ops detail reserved for the ops-admin
      // allowlist. 'ok' means every var the connect flow needs is configured.
      const data = await this.request<{ status?: string }>(
        '/api/banking/health',
        { method: 'GET' }
      );

      this.configStatus = {
        plaid: false,
        trueLayer: data.status === 'ok'
      };
      this.configStatusKnown = true;
    } catch (error) {
      // A FAILED check is not a 'degraded' verdict, and folding it into one
      // told the owner's TestFlight install "bank connections not configured
      // — add provider credentials" while the very same backend was serving
      // his live feeds (26 Aug, item 6). A health call can fail for reasons
      // that say nothing about configuration — the auth token not yet
      // minted in a freshly-booted WebView is the likely one there — so the
      // answer is "unknown", and the UI says it could not check rather than
      // asserting a server fact it never learned.
      this.logger.warn('Failed to load banking config status', error as Error);
      this.configStatus = { plaid: false, trueLayer: false };
      this.configStatusKnown = false;
    }

    return this.configStatus;
  }

  /** False when the last health check FAILED (verdict unknown), true when it answered. */
  isConfigStatusKnown(): boolean {
    return this.configStatusKnown;
  }

  getConfigStatus(): { plaid: boolean; trueLayer: boolean } {
    return this.configStatus;
  }

  /**
   * Quick-pick list for the Connect a Bank modal. Every entry launches the
   * SAME generic TrueLayer flow — the definitive institution choice happens
   * on TrueLayer's own secure page, which lists every provider our client
   * can access (all UK Open Banking banks, plus card issuers like American
   * Express now the auth link requests the cards scope). This list is
   * recognition/reassurance only, so missing an entry never blocks anyone:
   * the modal's "Browse all banks" action runs the identical flow.
   *
   * (The old list also carried Chase/Bank of America "via Plaid" — dead
   * entries for a provider that was removed from the app.)
   */
  async getInstitutions(_country: string = 'GB'): Promise<BankInstitution[]> {
    const uk = (id: string, name: string): BankInstitution => ({
      id,
      name,
      country: 'GB',
      provider: 'truelayer',
      supportsAccountDetails: true,
      supportsTransactions: true,
      supportsBalance: true
    });

    // Sorted programmatically so a future addition cannot land out of order
    // (Barclaycard vs Barclays already had, alphabetically, swapped places).
    return [
      uk('amex', 'American Express'),
      uk('barclays', 'Barclays'),
      uk('barclaycard', 'Barclaycard'),
      uk('first-direct', 'First Direct'),
      uk('halifax', 'Halifax'),
      uk('hsbc', 'HSBC'),
      uk('lloyds', 'Lloyds Bank'),
      uk('monzo', 'Monzo'),
      uk('nationwide', 'Nationwide'),
      uk('natwest', 'NatWest'),
      uk('revolut', 'Revolut'),
      uk('santander', 'Santander'),
      uk('starling', 'Starling Bank'),
      uk('tsb', 'TSB')
    ].sort((a, b) => compareText(a.name, b.name));
  }

  async connectBank(
    institutionId: string,
    provider: 'plaid' | 'truelayer',
    options: ConnectBankOptions = {}
  ): Promise<{ url?: string; linkToken?: string }> {
    if (provider === 'truelayer') {
      const requestBody: CreateLinkTokenRequest = {
        institutionId,
        mode: options.mode ?? 'connect',
        connectionId: options.connectionId
      };
      const response = await this.request<CreateLinkTokenResponse>('/api/banking/create-link-token', {
        method: 'POST',
        body: JSON.stringify(requestBody)
      });
      return { url: response.authUrl };
    }

    return { linkToken: 'plaid-not-configured' };
  }

  async reauthorizeConnection(connectionId: string): Promise<{ url?: string; linkToken?: string }> {
    const connection = this.connections.find((item) => item.id === connectionId);
    if (!connection) {
      throw new Error('Connection not found');
    }
    if (connection.provider !== 'truelayer') {
      throw new Error('Reauthorization is currently supported only for TrueLayer connections');
    }

    return this.connectBank(connection.institutionId, 'truelayer', {
      mode: 'reauth',
      connectionId
    });
  }

  async handleOAuthCallback(code: string, state?: string): Promise<BankConnection | null> {
    if (!state) {
      throw new Error('Missing state parameter');
    }

    const response = await this.request<ExchangeTokenResponse>('/api/banking/exchange-token', {
      method: 'POST',
      body: JSON.stringify({ code, state })
    });

    await this.refreshConnections();
    return this.connections.find((connection) => connection.id === response.connectionId) ?? null;
  }

  /**
   * @param options.startDate — read from this day (YYYY-MM-DD) instead of the
   *   routine window. The "re-read the last 30 days" catch-up: a user who was
   *   away longer than the window reaches, or who suspects a gap, names the
   *   range and the server honours it (an explicit start always wins there).
   */
  async syncConnection(connectionId: string, options: { startDate?: string } = {}): Promise<SyncResult> {
    try {
      const accountsResponse = await this.request<SyncAccountsResponse>('/api/banking/sync-accounts', {
        method: 'POST',
        body: JSON.stringify({ connectionId })
      });

      const transactionsResponse = await this.request<SyncTransactionsResponse>('/api/banking/sync-transactions', {
        method: 'POST',
        body: JSON.stringify(options.startDate ? { connectionId, startDate: options.startDate } : { connectionId })
      });

      await this.refreshConnections();

      const errors: string[] = [];
      if (accountsResponse.error) {
        errors.push(accountsResponse.error);
      }
      if (transactionsResponse.error) {
        errors.push(transactionsResponse.error);
      }

      return {
        success: accountsResponse.success && transactionsResponse.success,
        accountsUpdated: accountsResponse.accountsSynced,
        transactionsImported: transactionsResponse.transactionsImported,
        errors
      };
    } catch (error) {
      this.logger.error('Failed to sync bank connection', error as Error);
      const code = refusalCode(error);
      return {
        success: false,
        accountsUpdated: 0,
        transactionsImported: 0,
        errors: [error instanceof Error ? error.message : 'Unknown sync error'],
        ...(code ? { code } : {})
      };
    }
  }

  async syncAll(): Promise<Map<string, SyncResult>> {
    const results = new Map<string, SyncResult>();
    for (const connection of this.connections) {
      results.set(connection.id, await this.syncConnection(connection.id));
    }
    return results;
  }

  /**
   * Remove a connection, and say what actually happened to the consent.
   *
   * A non-2xx throws out of `request`, so reaching the lines below means the
   * row is gone — that part was never in doubt and is not what this returns
   * for. `revokedAtProvider` is: the endpoint revokes best-effort and deletes
   * regardless, so this is the only place a caller can learn that the bank may
   * still be holding an authorisation the user believes they have withdrawn.
   */
  async disconnect(connectionId: string): Promise<DisconnectOutcome> {
    const response = await this.request<DisconnectResponse>('/api/banking/disconnect', {
      method: 'POST',
      body: JSON.stringify({ connectionId })
    });

    this.connections = this.connections.filter((connection) => connection.id !== connectionId);
    return {
      removed: response.success !== false,
      revokedAtProvider: response.revokedAtProvider
    };
  }

  async discoverAccounts(connectionId: string): Promise<DiscoveredBankAccount[]> {
    const response = await this.request<DiscoverAccountsResponse>('/api/banking/discover-accounts', {
      method: 'POST',
      body: JSON.stringify({ connectionId })
    });
    return response.accounts;
  }

  async linkAccounts(connectionId: string, links: LinkAccountsRequest['links']): Promise<LinkAccountsResponse> {
    return this.request<LinkAccountsResponse>('/api/banking/link-accounts', {
      method: 'POST',
      body: JSON.stringify({ connectionId, links })
    });
  }

  /**
   * @param options.startDate — read from this day (YYYY-MM-DD) instead of the
   *   routine window. The "Re-read 30 days" catch-up comes through HERE, not
   *   syncConnection: a catch-up is about transactions, the balances were
   *   refreshed by the routine sync moments before, and the account sync's
   *   own per-minute limit is what a Sync All plus three re-reads tripped.
   */
  async syncTransactionsOnly(connectionId: string, options: { startDate?: string } = {}): Promise<SyncResult> {
    try {
      const transactionsResponse = await this.request<SyncTransactionsResponse>('/api/banking/sync-transactions', {
        method: 'POST',
        body: JSON.stringify(options.startDate ? { connectionId, startDate: options.startDate } : { connectionId })
      });

      await this.refreshConnections();

      return {
        success: transactionsResponse.success,
        accountsUpdated: 0,
        transactionsImported: transactionsResponse.transactionsImported,
        alreadyHeld:
          (transactionsResponse.duplicatesSkipped ?? 0) + (transactionsResponse.idChurnRepaired ?? 0),
        matchedToOwnRows:
          (transactionsResponse.transfersAdopted ?? 0) + (transactionsResponse.importedRowsAdopted ?? 0),
        errors: transactionsResponse.error ? [transactionsResponse.error] : []
      };
    } catch (error) {
      this.logger.error('Failed to sync transactions', error as Error);
      const code = refusalCode(error);
      return {
        success: false,
        accountsUpdated: 0,
        transactionsImported: 0,
        errors: [error instanceof Error ? error.message : 'Unknown sync error'],
        ...(code ? { code } : {})
      };
    }
  }

  needsReauth(): BankConnection[] {
    const now = Date.now();
    return this.connections.filter((connection) =>
      connection.status === 'reauth_required' ||
      (connection.expiresAt && connection.expiresAt.getTime() < now)
    );
  }
}

export const bankConnectionService = new BankConnectionService();
