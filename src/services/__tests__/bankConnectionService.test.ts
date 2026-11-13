import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DeadLetterAdminAuditResponse,
  DeadLetterAdminListResponse,
  DeadLetterAdminResetResponse,
  ConnectionsResponse,
  CreateLinkTokenResponse,
  ExchangeTokenResponse,
  OpsAlertStatsResponse,
  OpsAlertTestResponse
} from '../../types/banking-api';
import { BankConnectionService } from '../bankConnectionService';

const createLogger = () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
});

const createFetchMock = () => vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>();

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

const textResponse = (body: string, status: number): Response => new Response(body, { status });

const getRequestHeader = (init: RequestInit | undefined, header: string): string | null =>
  new Headers(init?.headers).get(header);

const getJsonBody = (init: RequestInit | undefined): unknown =>
  JSON.parse(String(init?.body ?? '{}'));

const createService = (fetchMock: typeof fetch) => {
  const logger = createLogger();
  const service = new BankConnectionService({
    fetch: fetchMock,
    logger,
    authTokenProvider: async () => 'test-token'
  });
  return { service, logger };
};

describe('BankConnectionService', () => {
  const env = import.meta.env as Record<string, string | undefined>;
  const originalE2eAuthFlag = env.VITE_E2E_TEST_MODE_AUTH;
  const originalLocation = window.location.pathname + window.location.search;

  beforeEach(() => {
    vi.clearAllMocks();
    env.VITE_E2E_TEST_MODE_AUTH = originalE2eAuthFlag;
    window.localStorage.removeItem('isTestMode');
    window.history.replaceState({}, '', originalLocation);
  });

  it('loads connections from the authenticated API and maps date fields', async () => {
    const fetchMock = createFetchMock();
    const apiConnections: ConnectionsResponse = [
      {
        id: 'conn_123',
        provider: 'truelayer',
        institutionId: 'provider_1',
        institutionName: 'Barclays',
        institutionLogo: 'https://logo.test/barclays.svg',
        status: 'connected',
        lastSync: '2026-01-01T00:00:00.000Z',
        accountsCount: 2,
        expiresAt: '2026-12-31T00:00:00.000Z'
      }
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse(apiConnections));
    const { service } = createService(fetchMock);

    const result = await service.refreshConnections();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('conn_123');
    expect(result[0].lastSync).toBeInstanceOf(Date);
    expect(result[0].expiresAt).toBeInstanceOf(Date);
    expect(result[0].accountsCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/banking/connections');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(getRequestHeader(fetchMock.mock.calls[0]?.[1], 'Authorization')).toBe('Bearer test-token');
  });

  it('logs and returns an empty connection list when loading connections fails', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(textResponse('db unavailable', 500));
    const { service, logger } = createService(fetchMock);

    const result = await service.refreshConnections();

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith('Failed to load bank connections', expect.any(Error));
  });

  it('loads TrueLayer configuration status from backend health endpoint', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
    const { service } = createService(fetchMock);

    const status = await service.refreshConfigStatus();

    expect(status).toEqual({ plaid: false, trueLayer: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/banking/health');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(getRequestHeader(fetchMock.mock.calls[0]?.[1], 'Authorization')).toBe('Bearer test-token');
  });

  it('treats a degraded health verdict as TrueLayer not configured', async () => {
    // The endpoint no longer discloses WHICH banking secret is missing to a
    // non-admin caller, so the client must act on the verdict alone.
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'degraded' }));
    const { service } = createService(fetchMock);

    const status = await service.refreshConfigStatus();

    expect(status).toEqual({ plaid: false, trueLayer: false });
  });

  it('builds a TrueLayer connection URL by calling create-link-token endpoint', async () => {
    const fetchMock = createFetchMock();
    const response: CreateLinkTokenResponse = {
      authUrl: 'https://auth.truelayer.com/?state=signed-state',
      state: 'signed-state'
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(response));
    const { service } = createService(fetchMock);

    const result = await service.connectBank('barclays', 'truelayer');

    expect(result).toEqual({ url: response.authUrl });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/banking/create-link-token');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(getRequestHeader(fetchMock.mock.calls[0]?.[1], 'Authorization')).toBe('Bearer test-token');
    expect(getJsonBody(fetchMock.mock.calls[0]?.[1])).toEqual({
      institutionId: 'barclays',
      mode: 'connect'
    });
  });

  it('starts reauthorization using connection context and mode=reauth', async () => {
    const fetchMock = createFetchMock();
    const connectionsResponse: ConnectionsResponse = [
      {
        id: 'conn_abc',
        provider: 'truelayer',
        institutionId: 'barclays',
        institutionName: 'Barclays',
        status: 'reauth_required',
        accountsCount: 2
      }
    ];
    const response: CreateLinkTokenResponse = {
      authUrl: 'https://auth.truelayer.com/?state=signed-state',
      state: 'signed-state'
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(connectionsResponse));
    fetchMock.mockResolvedValueOnce(jsonResponse(response));
    const { service } = createService(fetchMock);

    await service.refreshConnections();
    const result = await service.reauthorizeConnection('conn_abc');

    expect(result).toEqual({ url: response.authUrl });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/banking/create-link-token');
    expect(getJsonBody(fetchMock.mock.calls[1]?.[1])).toEqual({
      institutionId: 'barclays',
      mode: 'reauth',
      connectionId: 'conn_abc'
    });
  });

  it('rejects OAuth callback handling when state is missing', async () => {
    const fetchMock = createFetchMock();
    const { service } = createService(fetchMock);

    await expect(service.handleOAuthCallback('auth-code')).rejects.toThrow('Missing state parameter');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exchanges TrueLayer OAuth code and returns the created connection', async () => {
    const fetchMock = createFetchMock();
    const exchangeResponse: ExchangeTokenResponse = {
      success: true,
      connectionId: 'conn_123',
      institutionId: 'provider_1',
      institutionName: 'Barclays',
      institutionLogo: 'https://logo.test/barclays.svg',
      accountsCount: 3
    };
    const connectionsResponse: ConnectionsResponse = [
      {
        id: 'conn_123',
        provider: 'truelayer',
        institutionId: 'provider_1',
        institutionName: 'Barclays',
        institutionLogo: 'https://logo.test/barclays.svg',
        status: 'connected',
        accountsCount: 3
      }
    ];

    fetchMock.mockResolvedValueOnce(jsonResponse(exchangeResponse));
    fetchMock.mockResolvedValueOnce(jsonResponse(connectionsResponse));
    const { service } = createService(fetchMock);

    const connection = await service.handleOAuthCallback('auth-code', 'signed-state');

    expect(connection?.id).toBe('conn_123');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/banking/exchange-token');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(getJsonBody(fetchMock.mock.calls[0]?.[1])).toEqual({
      code: 'auth-code',
      state: 'signed-state'
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/banking/connections');
  });

  it('disconnects a connection via backend and removes it from local state', async () => {
    const fetchMock = createFetchMock();
    const connectionsResponse: ConnectionsResponse = [
      {
        id: 'conn_abc',
        provider: 'truelayer',
        institutionId: 'provider_1',
        institutionName: 'Barclays',
        status: 'connected',
        accountsCount: 1
      }
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse(connectionsResponse));
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, revokedAtProvider: true }));
    const { service } = createService(fetchMock);

    await service.refreshConnections();
    const outcome = await service.disconnect('conn_abc');

    expect(outcome.removed).toBe(true);
    expect(outcome.revokedAtProvider).toBe(true);
    expect(service.getConnections()).toEqual([]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/banking/disconnect');
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(getJsonBody(fetchMock.mock.calls[1]?.[1])).toEqual({ connectionId: 'conn_abc' });
  });

  it('reports a revocation the provider REFUSED, rather than swallowing it', async () => {
    // The bug this pins: `disconnect` used to discard the response and return
    // a bare `true`, so a TrueLayer that would not drop the consent reached
    // the user as a clean disconnection. The row still goes — a connection
    // left standing is what recreates the accounts on the next sync — so the
    // two facts have to travel separately.
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, revokedAtProvider: false }));
    const { service } = createService(fetchMock);

    const outcome = await service.disconnect('conn_abc');

    expect(outcome.removed).toBe(true);
    expect(outcome.revokedAtProvider).toBe(false);
  });

  it('leaves the revocation UNKNOWN when the endpoint did not say', async () => {
    // "This deployment did not send the field" is not "the bank refused", and
    // only the second is worth alarming somebody with. Coercing the absence to
    // false would put a warning about a standing bank authorisation in front
    // of every user of an older deployment.
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    const { service } = createService(fetchMock);

    const outcome = await service.disconnect('conn_abc');

    expect(outcome.removed).toBe(true);
    expect(outcome.revokedAtProvider).toBeUndefined();
  });

  it('identifies connections requiring reauthorization by status or expiry', async () => {
    const fetchMock = createFetchMock();
    const expiredIso = '2020-01-01T00:00:00.000Z';
    const futureIso = '2030-01-01T00:00:00.000Z';
    const connectionsResponse: ConnectionsResponse = [
      {
        id: 'conn_expired',
        provider: 'truelayer',
        institutionId: 'provider_1',
        institutionName: 'Expired Bank',
        status: 'connected',
        accountsCount: 1,
        expiresAt: expiredIso
      },
      {
        id: 'conn_reauth',
        provider: 'truelayer',
        institutionId: 'provider_2',
        institutionName: 'Reauth Bank',
        status: 'reauth_required',
        accountsCount: 1,
        expiresAt: futureIso
      },
      {
        id: 'conn_ok',
        provider: 'truelayer',
        institutionId: 'provider_3',
        institutionName: 'Healthy Bank',
        status: 'connected',
        accountsCount: 1,
        expiresAt: futureIso
      }
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse(connectionsResponse));
    const { service } = createService(fetchMock);

    await service.refreshConnections();
    const needsReauth = service.needsReauth();

    expect(needsReauth.map((connection) => connection.id)).toEqual(
      expect.arrayContaining(['conn_expired', 'conn_reauth'])
    );
    expect(needsReauth.map((connection) => connection.id)).not.toContain('conn_ok');
  });

  it('syncs a connection via backend sync endpoints and returns aggregated stats', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        accountsSynced: 2,
        accounts: []
      })
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        transactionsImported: 15,
        duplicatesSkipped: 3
      })
    );
    fetchMock.mockResolvedValueOnce(jsonResponse([] satisfies ConnectionsResponse));
    const { service } = createService(fetchMock);

    const result = await service.syncConnection('conn_123');

    expect(result).toEqual({
      success: true,
      accountsUpdated: 2,
      transactionsImported: 15,
      errors: []
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/banking/sync-accounts');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/banking/sync-transactions');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/banking/connections');
    expect(getJsonBody(fetchMock.mock.calls[0]?.[1])).toEqual({ connectionId: 'conn_123' });
    expect(getJsonBody(fetchMock.mock.calls[1]?.[1])).toEqual({ connectionId: 'conn_123' });
  });

  it('returns a failed sync result when sync endpoints error', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(textResponse('sync failed', 500));
    const { service } = createService(fetchMock);

    const result = await service.syncConnection('conn_123');

    expect(result).toEqual({
      success: false,
      accountsUpdated: 0,
      transactionsImported: 0,
      errors: ['sync failed']
    });
  });

  it('a re-read asks for transactions only, from the day named, and never touches the account sync', async () => {
    // "Re-read 30 days" (1 Oct 2026): a Sync All followed by a re-read on
    // every bank tripped the account sync's per-minute limit, and the panel
    // reported the throttle as transactions that had not come through. A
    // catch-up is about transactions; the balances were refreshed moments
    // before.
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, transactionsImported: 24, duplicatesSkipped: 0 }));
    fetchMock.mockResolvedValueOnce(jsonResponse([] satisfies ConnectionsResponse));
    const { service } = createService(fetchMock);

    const result = await service.syncTransactionsOnly('conn_123', { startDate: '2026-09-01' });

    expect(result).toEqual({
      success: true, accountsUpdated: 0, transactionsImported: 24,
      alreadyHeld: 0, matchedToOwnRows: 0, errors: []
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/banking/sync-transactions');
    expect(getJsonBody(fetchMock.mock.calls[0]?.[1])).toEqual({ connectionId: 'conn_123', startDate: '2026-09-01' });
    expect(fetchMock.mock.calls.map(call => call[0])).not.toContain('/api/banking/sync-accounts');
  });

  it('a re-read reports what it found besides new rows, so the panel can say what it did', async () => {
    // Owner, 13 Nov 2026: a re-read from a date he chooses. The bank's rows
    // the ledger already held, and the rows he had entered himself that the
    // feed now recognises, are counted apart from what was added.
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true, transactionsImported: 1, duplicatesSkipped: 30,
      idChurnRepaired: 1, transfersAdopted: 2, importedRowsAdopted: 1
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse([] satisfies ConnectionsResponse));
    const { service } = createService(fetchMock);

    const result = await service.syncTransactionsOnly('conn_123', { startDate: '2026-09-01' });

    expect(result).toMatchObject({ transactionsImported: 1, alreadyHeld: 31, matchedToOwnRows: 3 });
  });

  it('a throttle comes back named, so the panel can say "too often" rather than "lost transactions"', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'Too many requests, please try again shortly', code: 'rate_limited' }, 429)
    );
    const { service } = createService(fetchMock);

    const result = await service.syncConnection('conn_123');

    expect(result).toEqual({
      success: false,
      accountsUpdated: 0,
      transactionsImported: 0,
      errors: ['Too many requests, please try again shortly'],
      code: 'rate_limited'
    });
  });

  it('loads ops alert stats with query filters', async () => {
    const fetchMock = createFetchMock();
    const payload: OpsAlertStatsResponse = {
      success: true,
      filters: {
        eventType: 'banking.dead_letter_detected',
        minSuppressed: 2,
        limit: 25,
        onlyAboveThreshold: false
      },
      threshold: {
        enabled: true,
        suppressionThreshold: 5,
        suppressionNotifyEvery: 2
      },
      count: 1,
      summary: {
        totalSuppressed: 5,
        maxSuppressedCount: 5,
        mostRecentLastSentAt: '2026-02-10T10:00:00.000Z',
        mostRecentUpdatedAt: '2026-02-10T10:05:00.000Z',
        rowsAboveThreshold: 1
      },
      rows: [
        {
          dedupeKey: 'banking.dead_letter_detected:abc',
          eventType: 'banking.dead_letter_detected',
          lastSentAt: '2026-02-10T10:00:00.000Z',
          suppressedCount: 5,
          updatedAt: '2026-02-10T10:05:00.000Z',
          isAboveThreshold: true
        }
      ]
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));
    const { service } = createService(fetchMock);

    const result = await service.getOpsAlertStats({
      eventType: 'banking.dead_letter_detected',
      minSuppressed: 2,
      limit: 25
    });

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/banking/ops-alert-stats?eventType=banking.dead_letter_detected&minSuppressed=2&limit=25'
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(getRequestHeader(fetchMock.mock.calls[0]?.[1], 'Authorization')).toBe('Bearer test-token');
  });

  it('uses explicit e2e auth fallback only when enabled and test mode is active', async () => {
    const fetchMock = createFetchMock();
    const logger = createLogger();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        filters: {
          eventType: null,
          eventTypePrefix: null,
          minSuppressed: 0,
          limit: 10,
          onlyAboveThreshold: false
        },
        threshold: {
          enabled: true,
          suppressionThreshold: 0,
          suppressionNotifyEvery: 0
        },
        count: 0,
        summary: {
          totalSuppressed: 0,
          maxSuppressedCount: 0,
          mostRecentLastSentAt: null,
          mostRecentUpdatedAt: null,
          rowsAboveThreshold: 0
        },
        rows: []
      } satisfies OpsAlertStatsResponse)
    );

    env.VITE_E2E_TEST_MODE_AUTH = 'true';
    window.history.replaceState({}, '', '/settings/data?testMode=true');

    const service = new BankConnectionService({
      fetch: fetchMock,
      logger,
      authTokenProvider: async () => null
    });

    await service.getOpsAlertStats();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRequestHeader(fetchMock.mock.calls[0]?.[1], 'Authorization')).toBe('Bearer e2e-test-token');
    expect(logger.warn).toHaveBeenCalledWith(
      'Using VITE_E2E_TEST_MODE_AUTH fallback token for banking API requests in test mode'
    );
  });

  it('does not use e2e auth fallback when explicit flag is disabled', async () => {
    const fetchMock = createFetchMock();
    const logger = createLogger();
    env.VITE_E2E_TEST_MODE_AUTH = undefined;
    window.history.replaceState({}, '', '/settings/data?testMode=true');

    const service = new BankConnectionService({
      fetch: fetchMock,
      logger,
      authTokenProvider: async () => null
    });

    await expect(service.getOpsAlertStats()).rejects.toThrow('Missing authentication token');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(
      'Using VITE_E2E_TEST_MODE_AUTH fallback token for banking API requests in test mode'
    );
  });

  it('throws enriched API errors for non-2xx JSON responses', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'Admin access required',
          code: 'forbidden'
        },
        403
      )
    );
    const { service } = createService(fetchMock);

    await expect(service.getOpsAlertStats()).rejects.toMatchObject({
      message: 'Admin access required',
      status: 403,
      code: 'forbidden'
    });
  });

  it('encodes onlyAboveThreshold filter when enabled', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        filters: {
          eventType: null,
          minSuppressed: 0,
          limit: 10,
          onlyAboveThreshold: true
        },
        threshold: {
          enabled: true,
          suppressionThreshold: 5,
          suppressionNotifyEvery: 2
        },
        count: 0,
        summary: {
          totalSuppressed: 0,
          maxSuppressedCount: 0,
          mostRecentLastSentAt: null,
          mostRecentUpdatedAt: null,
          rowsAboveThreshold: 0
        },
        rows: []
      } satisfies OpsAlertStatsResponse)
    );
    const { service } = createService(fetchMock);

    await service.getOpsAlertStats({ onlyAboveThreshold: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/banking/ops-alert-stats?onlyAboveThreshold=1');
  });

  it('encodes eventTypePrefix filter for grouped ops views', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        filters: {
          eventType: null,
          eventTypePrefix: 'banking.truelayer.jwks_circuit_',
          minSuppressed: 0,
          limit: 10,
          onlyAboveThreshold: false
        },
        threshold: {
          enabled: true,
          suppressionThreshold: 5,
          suppressionNotifyEvery: 2
        },
        count: 0,
        summary: {
          totalSuppressed: 0,
          maxSuppressedCount: 0,
          mostRecentLastSentAt: null,
          mostRecentUpdatedAt: null,
          rowsAboveThreshold: 0
        },
        rows: []
      } satisfies OpsAlertStatsResponse)
    );
    const { service } = createService(fetchMock);

    await service.getOpsAlertStats({ eventTypePrefix: 'banking.truelayer.jwks_circuit_' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/banking/ops-alert-stats?eventTypePrefix=banking.truelayer.jwks_circuit_'
    );
  });

  it('sends a manual ops alert test via authenticated endpoint', async () => {
    const fetchMock = createFetchMock();
    const payload: OpsAlertTestResponse = {
      success: true,
      eventType: 'banking.ops_alert_test',
      delivered: true
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));
    const { service } = createService(fetchMock);

    const result = await service.triggerOpsAlertTest('  Preview smoke test  ');

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/banking/ops-alert-test');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(getRequestHeader(fetchMock.mock.calls[0]?.[1], 'Authorization')).toBe('Bearer test-token');
    expect(getJsonBody(fetchMock.mock.calls[0]?.[1])).toEqual({ message: 'Preview smoke test' });
  });

  it('resets all dead-lettered connections with confirmation and reason', async () => {
    const fetchMock = createFetchMock();
    const payload: DeadLetterAdminResetResponse = {
      success: true,
      maxRetryAttempts: 6,
      requested: 2,
      resetConnectionIds: ['conn_1', 'conn_2'],
      auditId: 'audit_1',
      auditStatus: 'completed'
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));
    const { service } = createService(fetchMock);

    const result = await service.resetAllDeadLettered('RESET_ALL_DEAD_LETTERED', '  Resolve support ticket #321  ', 100);

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/banking/dead-letter-admin');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(getRequestHeader(fetchMock.mock.calls[0]?.[1], 'Authorization')).toBe('Bearer test-token');
    expect(getJsonBody(fetchMock.mock.calls[0]?.[1])).toEqual({
      resetAllDeadLettered: true,
      confirm: 'RESET_ALL_DEAD_LETTERED',
      reason: 'Resolve support ticket #321',
      limit: 100
    });
  });

  it('rejects dead-letter reset when reason is empty', async () => {
    const fetchMock = createFetchMock();
    const { service } = createService(fetchMock);

    await expect(service.resetAllDeadLettered('RESET_ALL_DEAD_LETTERED', '   ')).rejects.toThrow('Reason is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads dead-letter preview rows with a bounded limit', async () => {
    const fetchMock = createFetchMock();
    const payload: DeadLetterAdminListResponse = {
      success: true,
      maxRetryAttempts: 6,
      count: 1,
      rows: [
        {
          connectionId: 'conn_1',
          userId: 'user_1',
          provider: 'truelayer',
          status: 'connected',
          institutionName: 'Barclays',
          queueAttempts: 7,
          queueLastError: 'dead_letter:transactions:500',
          queueNextRetryAt: null,
          updatedAt: '2026-02-10T00:00:00.000Z'
        }
      ]
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));
    const { service } = createService(fetchMock);

    const result = await service.getDeadLetterRows(999);

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/banking/dead-letter-admin?limit=200');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(getRequestHeader(fetchMock.mock.calls[0]?.[1], 'Authorization')).toBe('Bearer test-token');
  });

  it('loads dead-letter admin audit rows with filters', async () => {
    const fetchMock = createFetchMock();
    const payload: DeadLetterAdminAuditResponse = {
      success: true,
      filters: {
        status: 'completed',
        scope: 'bulk',
        action: 'reset_dead_letter',
        adminClerkId: 'clerk_admin_1',
        since: '2026-02-09T00:00:00.000Z',
        until: '2026-02-11T00:00:00.000Z',
        cursor: null,
        limit: 25
      },
      count: 1,
      summary: {
        requestedTotal: 11,
        resetTotal: 11,
        pendingCount: 0,
        completedCount: 1,
        failedCount: 0
      },
      page: {
        limit: 25,
        hasMore: false,
        nextCursor: null
      },
      rows: [
        {
          id: 'audit_1',
          adminUserId: 'user_admin_1',
          adminClerkId: 'clerk_admin_1',
          action: 'reset_dead_letter',
          scope: 'bulk',
          reason: 'Support replay',
          requestedCount: 11,
          resetCount: 11,
          maxRetryAttempts: 6,
          connectionIds: ['conn_1', 'conn_2'],
          metadata: { source: 'explicit_selection' },
          status: 'completed',
          error: null,
          createdAt: '2026-02-10T10:00:00.000Z',
          completedAt: '2026-02-10T10:01:00.000Z'
        }
      ]
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));
    const { service } = createService(fetchMock);

    const result = await service.getDeadLetterAudit({
      status: 'completed',
      scope: 'bulk',
      action: 'reset_dead_letter',
      adminClerkId: 'clerk_admin_1',
      since: '2026-02-09T00:00:00.000Z',
      until: '2026-02-11T00:00:00.000Z',
      limit: 25
    });

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/banking/dead-letter-admin-audit?status=completed&scope=bulk&action=reset_dead_letter&adminClerkId=clerk_admin_1&since=2026-02-09T00%3A00%3A00.000Z&until=2026-02-11T00%3A00%3A00.000Z&limit=25'
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(getRequestHeader(fetchMock.mock.calls[0]?.[1], 'Authorization')).toBe('Bearer test-token');
  });

  it('encodes cursor when loading additional dead-letter audit rows', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        filters: {
          status: null,
          scope: null,
          action: null,
          adminClerkId: null,
          since: null,
          until: null,
          cursor: 'eyJjcmVhdGVkQXQiOiIyMDI2LTAyLTEwVDEwOjAwOjAwLjAwMFoiLCJpZCI6ImF1ZGl0XzEifQ',
          limit: 10
        },
        count: 0,
        summary: {
          requestedTotal: 0,
          resetTotal: 0,
          pendingCount: 0,
          completedCount: 0,
          failedCount: 0
        },
        page: {
          limit: 10,
          hasMore: false,
          nextCursor: null
        },
        rows: []
      } satisfies DeadLetterAdminAuditResponse)
    );
    const { service } = createService(fetchMock);

    await service.getDeadLetterAudit({
      cursor: 'eyJjcmVhdGVkQXQiOiIyMDI2LTAyLTEwVDEwOjAwOjAwLjAwMFoiLCJpZCI6ImF1ZGl0XzEifQ',
      limit: 10
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/banking/dead-letter-admin-audit?cursor=eyJjcmVhdGVkQXQiOiIyMDI2LTAyLTEwVDEwOjAwOjAwLjAwMFoiLCJpZCI6ImF1ZGl0XzEifQ&limit=10'
    );
  });

  it('exports dead-letter audit rows as csv with filters', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      new Response('"id","createdAt"\n"audit_1","2026-02-10T10:00:00.000Z"', {
        status: 200,
        headers: { 'Content-Type': 'text/csv; charset=utf-8' }
      })
    );
    const { service } = createService(fetchMock);

    const csv = await service.exportDeadLetterAuditCsv({
      status: 'completed',
      scope: 'bulk',
      action: 'reset_dead_letter',
      limit: 1000
    });

    expect(csv).toContain('"audit_1"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/banking/dead-letter-admin-audit-export?status=completed&scope=bulk&action=reset_dead_letter&limit=1000'
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(getRequestHeader(fetchMock.mock.calls[0]?.[1], 'Authorization')).toBe('Bearer test-token');
  });

  it('resets selected dead-letter connections with deduplicated ids', async () => {
    const fetchMock = createFetchMock();
    const payload: DeadLetterAdminResetResponse = {
      success: true,
      maxRetryAttempts: 6,
      requested: 2,
      resetConnectionIds: ['conn_1', 'conn_2'],
      auditId: 'audit_2',
      auditStatus: 'completed'
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));
    const { service } = createService(fetchMock);

    const result = await service.resetDeadLetterConnections([' conn_1 ', 'conn_1', 'conn_2'], '  replay dead-letter queue  ');

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/banking/dead-letter-admin');
    expect(getJsonBody(fetchMock.mock.calls[0]?.[1])).toEqual({
      connectionIds: ['conn_1', 'conn_2'],
      reason: 'replay dead-letter queue'
    });
  });

  it('includes bulk confirmation token when resetting selected dead-letter connections', async () => {
    const fetchMock = createFetchMock();
    const payload: DeadLetterAdminResetResponse = {
      success: true,
      maxRetryAttempts: 6,
      requested: 11,
      resetConnectionIds: Array.from({ length: 11 }, (_value, index) => `conn_${index + 1}`),
      auditId: 'audit_3',
      auditStatus: 'completed'
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));
    const { service } = createService(fetchMock);

    const connectionIds = Array.from({ length: 11 }, (_value, index) => `conn_${index + 1}`);
    await service.resetDeadLetterConnections(connectionIds, 'bulk replay', ' RESET_SELECTED_BULK ');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getJsonBody(fetchMock.mock.calls[0]?.[1])).toEqual({
      connectionIds,
      reason: 'bulk replay',
      confirm: 'RESET_SELECTED_BULK'
    });
  });

  it('rejects selected dead-letter reset when no valid connection ids are provided', async () => {
    const fetchMock = createFetchMock();
    const { service } = createService(fetchMock);

    await expect(service.resetDeadLetterConnections(['  '], 'valid reason')).rejects.toThrow(
      'At least one connection is required'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
