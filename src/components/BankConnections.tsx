import React, { useState, useEffect } from 'react';
import { useAuth as useClerkAuth } from '@clerk/clerk-react';
import { bankConnectionService, type BankConnection, type BankInstitution } from '../services/bankConnectionService';
import { Modal } from './common/Modal';
import LinkBankAccountsModal from './banking/LinkBankAccountsModal';
import BankingOpsAlertStatsCard from './BankingOpsAlertStatsCard';
import type { BankingAuditDateRangePreset, BankingAuditScope } from '../utils/bankingOpsUrlState';
import {
  Building2Icon,
  RefreshCwIcon,
  LinkIcon,
  UnlinkIcon,
  AlertCircleIcon,
  CheckCircleIcon,
  ClockIcon,
  PlusIcon,
  SearchIcon
} from './icons';
import { formatDate, formatDateTime } from '../utils/dateFormatter';
import { describeReread } from '../utils/rereadOutcome';
import { earliestRereadDay } from '../services/banking/syncWindow';
import { createScopedLogger } from '../loggers/scopedLogger';

// Module scope, not a useMemo: the loaders below are started from a mount
// effect, and a logger created inside the component makes them look unstable to
// react-hooks/exhaustive-deps. `useAccountBankSync.ts` already does it this way.
const logger = createScopedLogger('BankConnections');

interface BankConnectionsProps {
  onAccountsLinked?: () => void;
  defaultOpsOnlyAboveThreshold?: boolean;
  defaultOpsEventType?: string;
  defaultOpsEventTypePrefix?: string;
  defaultOpenOpsAuditLog?: boolean;
  defaultOpsAuditStatus?: 'pending' | 'completed' | 'failed';
  defaultOpsAuditScope?: BankingAuditScope;
  defaultOpsAuditDateRangePreset?: BankingAuditDateRangePreset;
}

/** The catch-up window's first day, YYYY-MM-DD: thirty days ago, today's clock. */
const thirtyDaysAgoIso = (): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
};

/** Today, YYYY-MM-DD, by the same UTC day the re-read's limit is counted in. */
const todayIso = (): string => new Date().toISOString().slice(0, 10);

export default function BankConnections({
  onAccountsLinked,
  defaultOpsOnlyAboveThreshold = false,
  defaultOpsEventType,
  defaultOpsEventTypePrefix,
  defaultOpenOpsAuditLog = false,
  defaultOpsAuditStatus,
  defaultOpsAuditScope,
  defaultOpsAuditDateRangePreset
}: BankConnectionsProps) {
  const [connections, setConnections] = useState<BankConnection[]>([]);
  const [institutions, setInstitutions] = useState<BankInstitution[]>([]);
  const [showAddBank, setShowAddBank] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [syncingConnections, setSyncingConnections] = useState<Set<string>>(new Set());
  const [configStatus, setConfigStatus] = useState({ plaid: false, trueLayer: false });
  /*
   * ─ WHAT WE KNOW, AS OPPOSED TO WHAT WE HAVE NOT ASKED YET ──────────────────
   *
   * Both of these start false and become true when their own fetch resolves,
   * and they exist because this panel used to say two untrue things on its way
   * to saying a true one. Reported: "there seems to be 2 other pages that occupy
   * the pop up before it settles ... the app flicks through them that quick I
   * cannot get a screenshot."
   *
   * They were these, in order:
   *   1. "Bank connections not configured — add your provider credentials to
   *      the backend environment variables", because `configStatus` defaults to
   *      neither provider being on and the warning renders on `!plaid &&
   *      !trueLayer`;
   *   2. "No banks connected — Connect Your First Bank", because `connections`
   *      defaults to `[]` and the list renders on `connections.length > 0`.
   *
   * Both are the same mistake: an EMPTY initial value rendered as a finding.
   * On an account with three live banks the modal opened by announcing that
   * the feature was unconfigured and that nothing was linked — which, for the
   * half-second it lasted, is indistinguishable from having lost them.
   *
   * Two flags rather than one, because the two fetches are independent and one
   * being slow must not hold back the other's answer.
   */
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [configChecked, setConfigChecked] = useState(false);
  /** False when the last health check FAILED — verdict unknown, not a config fact. */
  const [configKnown, setConfigKnown] = useState(true);
  const [linkingConnectionId, setLinkingConnectionId] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  // What an incomplete action could not do. It used to go to the console only,
  // so a sync that (for example) added no accounts because the bank never
  // reported a balance to open them with left the user staring at a connection
  // with nothing under it and no reason given.
  //
  // The heading travels with the message because this now reports two
  // different unfinished jobs, and "Bank sync incomplete" over a message about
  // an authorisation still standing at the bank would name the wrong thing.
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);
  /**
   * RE-READ FROM A DATE (owner, 13 Nov 2026 — see REREAD_REACH_DAYS). Which
   * connection's date row is open, the day chosen, and what the last re-read
   * did. The outcome is its own line and not the amber notice: that one means
   * "something did not finish", and a re-read that worked must not wear it.
   */
  const [rereadOpenFor, setRereadOpenFor] = useState<string | null>(null);
  const [rereadDay, setRereadDay] = useState('');
  const [rereadOutcome, setRereadOutcome] = useState<{ connectionId: string; text: string } | null>(null);

  const { getToken } = useClerkAuth();

  useEffect(() => {
    bankConnectionService.setAuthTokenProvider(() => getToken());
  }, [getToken]);

  useEffect(() => {
    void loadConnections();
    void loadInstitutions();
    void checkConfig();
  }, []);

  const startOAuthFlow = (authUrl: string) => {
    const authWindow = window.open(
      authUrl,
      'bankAuth',
      'width=500,height=700,left=200,top=100'
    );

    if (!authWindow) {
      window.location.assign(authUrl);
      return;
    }

    let settled = false;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(closeCheckInterval);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      const payload = event.data as {
        type?: string;
        status?: 'success' | 'error';
        error?: string;
        connectionId?: string;
      } | null;
      if (!payload || payload.type !== 'reckley:bank-oauth-complete') {
        return;
      }

      settled = true;
      cleanup();
      void loadConnections();
      if (payload.status === 'success') {
        setOauthError(null);
        setShowAddBank(false);
        if (payload.connectionId) {
          setLinkingConnectionId(payload.connectionId);
        } else {
          onAccountsLinked?.();
        }
      } else {
        // The popup closes itself moments after an error — if we don't show
        // the message here, the failure is completely invisible to the user.
        const errorText = payload.error || 'The bank connection was not completed.';
        logger.error('OAuth callback returned error', new Error(errorText));
        setOauthError(errorText);
      }
    };

    const closeCheckInterval = window.setInterval(() => {
      if (authWindow.closed) {
        cleanup();
        if (!settled) {
          void loadConnections();
        }
      }
    }, 1000);

    window.addEventListener('message', onMessage);
  };

  const loadConnections = async () => {
    try {
      await bankConnectionService.refreshConnections();
      setConnections(bankConnectionService.getConnections());
    } catch (error) {
      // Caught rather than left to bubble: both loaders are started with
      // `void`, so a rejection here became an unhandled promise rejection —
      // which predates the flags but only showed up once a test held a refresh
      // open and failed it on purpose.
      logger.error('Failed to load bank connections', error as Error);
    } finally {
      // In `finally` so a failed refresh still stops the panel waiting: a fetch
      // that threw has told us as much as it is going to, and holding the blank
      // forever would be its own kind of lie.
      setConnectionsLoaded(true);
    }
  };

  const loadInstitutions = async () => {
    const inst = await bankConnectionService.getInstitutions();
    setInstitutions(inst);
  };

  const checkConfig = async () => {
    try {
      await bankConnectionService.refreshConfigStatus();
      setConfigStatus(bankConnectionService.getConfigStatus());
      setConfigKnown(bankConnectionService.isConfigStatusKnown());
    } catch (error) {
      logger.error('Failed to check bank provider configuration', error as Error);
    } finally {
      setConfigChecked(true);
    }
  };

  const handleConnect = async (institution: BankInstitution) => {
    setIsLoading(true);
    setOauthError(null);
    try {
      const result = await bankConnectionService.connectBank(
        institution.id,
        institution.provider
      );

      if (result.url) {
        startOAuthFlow(result.url);
      } else {
        // Plaid was removed from the app; nothing should reach here.
        logger.error('Bank connection returned no auth URL', new Error(`provider=${institution.provider}`));
      }
    } catch (error) {
      logger.error('Failed to connect bank', error as Error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleReauthorize = async (connectionId: string) => {
    setIsLoading(true);
    setOauthError(null);
    try {
      const result = await bankConnectionService.reauthorizeConnection(connectionId);
      if (result.url) {
        startOAuthFlow(result.url);
      }
    } catch (error) {
      logger.error('Failed to reauthorize bank connection', error as Error);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * @param startDate — a catch-up: re-read from this day rather than the
   *   routine window (the last successful read, less a week). Offered as
   *   "Re-read 30 days" beside Sync now, for the week away that the window
   *   cannot reach back to on its own.
   */
  const handleSync = async (connectionId: string, startDate?: string) => {
    setSyncingConnections(prev => new Set(prev).add(connectionId));

    try {
      // A catch-up re-reads TRANSACTIONS only: the balances were refreshed by
      // the routine sync moments before, and the account sync has its own
      // per-minute limit that a Sync All followed by three re-reads tripped
      // (1 Oct 2026) — the re-reads all succeeded and the panel said they had
      // lost transactions.
      const result = startDate
        ? await bankConnectionService.syncTransactionsOnly(connectionId, { startDate })
        : await bankConnectionService.syncConnection(connectionId);

      if (result.success) {
        setNotice(null);
        setRereadOutcome(startDate ? { connectionId, text: describeReread(startDate, result) } : null);
        void loadConnections();
        onAccountsLinked?.();
      } else if (result.code === 'start_too_old') {
        // The server's refusal of a start no bank would serve. The date field
        // already stops at the limit, so this is a clock that turned midnight
        // with the row open; say the limit rather than "sync incomplete".
        setNotice({
          title: 'That date is too far back',
          body:
            `Banks hand over about the last ninety days. The earliest day you can re-read from is ` +
            `${formatDate(earliestRereadDay(new Date()))}. Nothing was changed.`
        });
      } else if (result.code === 'rate_limited') {
        // A throttle is not a sync that lost anything. Say so, and say what
        // to do — which is nothing, for a minute.
        setNotice({
          title: 'Synced too often',
          body:
            'The feeds can be refreshed a few times a minute, and that was more. ' +
            'Nothing was lost — wait a minute and try again.'
        });
      } else {
        logger.error('Sync failed', result.errors);
        // CONSEQUENCE, THEN REMEDY — not "Transaction sync failed", which is
        // the API's deliberately generic message and tells the reader
        // nothing about their money. The connection is not implicated here:
        // a failing sync means one call did not land, and the owner's audit
        // log is weeks of exactly that (accounts fine, transactions flaky)
        // being misread as a dead feed.
        setNotice({
          title: 'Bank sync incomplete',
          body:
            'Some transactions didn’t come through, so this account may be behind. ' +
            'The connection itself is fine — syncing again usually completes it.'
        });
        // Reload so a status change from the failed sync (e.g. reauth_required)
        // surfaces immediately — otherwise the Reauthorize CTA wouldn't appear
        // until the next manual refresh.
        void loadConnections();
      }
    } finally {
      setSyncingConnections(prev => {
        const next = new Set(prev);
        next.delete(connectionId);
        return next;
      });
    }
  };

  const handleSyncAll = async () => {
    const activeConnections = connections.filter(c => c.status === 'connected');
    
    for (const connection of activeConnections) {
      await handleSync(connection.id);
    }
  };

  const handleLinkComplete = async (connectionId: string) => {
    setLinkingConnectionId(null);
    setSyncingConnections(prev => new Set(prev).add(connectionId));
    try {
      await bankConnectionService.syncTransactionsOnly(connectionId);
      void loadConnections();
      onAccountsLinked?.();
    } finally {
      setSyncingConnections(prev => {
        const next = new Set(prev);
        next.delete(connectionId);
        return next;
      });
    }
  };

  const handleDisconnect = async (connectionId: string) => {
    if (confirm('Are you sure you want to disconnect this bank? This will stop automatic syncing.')) {
      const outcome = await bankConnectionService.disconnect(connectionId);
      void loadConnections();
      // Removing the connection and revoking it at the bank are two different
      // things, and this panel used to report only the first while implying
      // both. The row goes either way — a connection left standing is what
      // recreates the accounts — so a provider that refused is not a failure
      // to disconnect; it is an authorisation the user still has out and does
      // not know about.
      //
      // `=== false` rather than falsy: a response without the field has told
      // us nothing, and silence must not be reported as a refusal.
      if (outcome.revokedAtProvider === false) {
        setNotice({
          title: 'Your bank may still hold this authorisation',
          body:
            'The feed is removed here and won’t sync again, but the bank didn’t confirm that it ' +
            'had dropped Reckley’s access. Remove it in your bank’s own app or online ' +
            'banking, under connected apps or third-party access.'
        });
      }
    }
  };

  const getStatusIcon = (status: BankConnection['status']) => {
    switch (status) {
      case 'connected':
        return <CheckCircleIcon size={16} className="text-green-600 dark:text-green-400" />;
      case 'error':
        return <AlertCircleIcon size={16} className="text-red-600 dark:text-red-400" />;
      case 'reauth_required':
        return <AlertCircleIcon size={16} className="text-yellow-600 dark:text-yellow-400" />;
    }
  };

  const filteredInstitutions = institutions.filter(inst =>
    inst.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const needsReauth = connections.filter(c => c.status === 'reauth_required').length;

  return (
    <div className="space-y-6">
      {/* Configuration warning — ONLY when the server actually answered
          'degraded'. A failed check is a different sentence: it happened on
          the owner's TestFlight install, where the health call lost a race
          with the freshly-booting session and this banner told him his
          working backend was unconfigured (26 Aug, item 6). Consequence,
          then remedy, and never a server fact the client never learned. */}
      {configChecked && !configKnown && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <AlertCircleIcon className="text-yellow-600 dark:text-yellow-400 mt-0.5" size={20} />
            <div>
              <p className="font-medium text-yellow-800 dark:text-yellow-200">
                Couldn&rsquo;t check whether bank feeds are available
              </p>
              <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                The status check didn&rsquo;t get an answer, so connecting a bank may
                not work right now. Close this and try again in a moment.
              </p>
            </div>
          </div>
        </div>
      )}
      {configChecked && configKnown && !configStatus.plaid && !configStatus.trueLayer && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <AlertCircleIcon className="text-yellow-600 dark:text-yellow-400 mt-0.5" size={20} />
            <div>
              <p className="font-medium text-yellow-800 dark:text-yellow-200">
                Bank connections not configured
              </p>
              <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                To enable bank syncing, add your provider credentials to the backend environment variables.
              </p>
            </div>
          </div>
        </div>
      )}

      <BankingOpsAlertStatsCard
        initialOnlyAboveThreshold={defaultOpsOnlyAboveThreshold}
        initialEventType={defaultOpsEventType}
        initialEventTypePrefix={defaultOpsEventTypePrefix}
        initialShowAuditPanel={defaultOpenOpsAuditLog}
        initialAuditStatus={defaultOpsAuditStatus}
        initialAuditScope={defaultOpsAuditScope}
        initialAuditDateRangePreset={defaultOpsAuditDateRangePreset}
      />

      {/* OAuth failure — surfaced here because the popup self-closes */}
      {oauthError && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <AlertCircleIcon className="text-red-600 dark:text-red-400 mt-0.5" size={20} />
            <div className="flex-1">
              <p className="font-medium text-red-800 dark:text-red-200">
                Bank connection failed
              </p>
              <p className="text-sm text-red-700 dark:text-red-300 mt-1">{oauthError}</p>
            </div>
            <button
              type="button"
              onClick={() => setOauthError(null)}
              className="text-sm text-red-700 dark:text-red-300 underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* An action that ran but could not finish the job — a sync the bank
          would not report a balance for (accounts left out rather than opened
          at a figure nobody gave), or a disconnect the provider would not
          revoke. Amber, not red: the panel is working and there is a next step
          the reader can take. */}
      {notice && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <AlertCircleIcon className="text-amber-600 dark:text-amber-400 mt-0.5" size={20} />
            <div className="flex-1">
              <p className="font-medium text-amber-800 dark:text-amber-200">
                {notice.title}
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">{notice.body}</p>
            </div>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-sm text-amber-700 dark:text-amber-300 underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Connected Banks
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {connections.length} bank{connections.length !== 1 ? 's' : ''} connected
            {needsReauth > 0 && (
              <span className="text-yellow-600 dark:text-yellow-400 ml-2">
                ({needsReauth} need{needsReauth === 1 ? 's' : ''} reauthorization)
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-3">
          {connections.length > 0 && (
            <button
              onClick={handleSyncAll}
              className="px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors flex items-center gap-2"
            >
              <RefreshCwIcon size={16} />
              Sync All
            </button>
          )}
          <button
            onClick={() => setShowAddBank(true)}
            className="px-4 py-2 bg-[#1a2332] text-white rounded-lg hover:bg-[#2d3a4d] transition-colors flex items-center gap-2"
          >
            <PlusIcon size={16} />
            Add Bank
          </button>
        </div>
      </div>

      {/* Connected Banks List */}
      {!connectionsLoaded ? null : connections.length > 0 ? (
        <div className="space-y-3">
          {connections.map(connection => (
            <div
              key={connection.id}
              className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center">
                    <Building2Icon size={24} className="text-gray-600 dark:text-gray-400" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-medium text-gray-900 dark:text-white">
                        {connection.institutionName}
                      </h4>
                      {getStatusIcon(connection.status)}
                    </div>
                    <div className="flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400 mt-1">
                      <span>{connection.accountsCount ?? connection.accounts.length} accounts linked</span>
                      {connection.lastSync && (
                        <span className="flex items-center gap-1">
                          <ClockIcon size={12} />
                          Last synced {formatDateTime(connection.lastSync)}
                        </span>
                      )}
                      {/* CONNECTED, BUT BEHIND. Without this the modal
                          contradicts itself: the banner says a sync did not
                          finish while every row wears a tick. `error` is
                          present on a connected row exactly when the last
                          sync failed without the credentials being at
                          fault. */}
                      {connection.status === 'connected' && connection.error && (
                        <span className="text-gray-500 dark:text-gray-400">
                          · last sync didn’t finish
                        </span>
                      )}
                    </div>
                    {connection.error && (
                      <p className="text-sm text-red-600 dark:text-red-400 mt-1">
                        {connection.error}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setLinkingConnectionId(connection.id)}
                    disabled={connection.status === 'reauth_required'}
                    className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white disabled:opacity-50"
                    title="Link accounts"
                  >
                    <LinkIcon size={20} />
                  </button>
                  <button
                    onClick={() => handleSync(connection.id)}
                    disabled={syncingConnections.has(connection.id) || connection.status === 'reauth_required'}
                    className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white disabled:opacity-50"
                    title="Sync now"
                  >
                    <RefreshCwIcon
                      size={20}
                      className={syncingConnections.has(connection.id) ? 'animate-spin' : ''}
                    />
                  </button>
                  <button
                    onClick={() => handleSync(connection.id, thirtyDaysAgoIso())}
                    disabled={syncingConnections.has(connection.id) || connection.status === 'reauth_required'}
                    className="px-2 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white disabled:opacity-50"
                    title="Re-read the last 30 days — for a gap the routine sync cannot reach back to"
                  >
                    Re-read 30 days
                  </button>
                  <button
                    onClick={() => {
                      const opening = rereadOpenFor !== connection.id;
                      setRereadOpenFor(opening ? connection.id : null);
                      if (opening) setRereadDay(thirtyDaysAgoIso());
                    }}
                    disabled={syncingConnections.has(connection.id) || connection.status === 'reauth_required'}
                    aria-expanded={rereadOpenFor === connection.id}
                    className="px-2 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white disabled:opacity-50"
                    title="Re-read from a day you choose — for a gap older than 30 days"
                  >
                    From a date…
                  </button>
{connection.status === 'reauth_required' && (
                    <button
                      onClick={() => handleReauthorize(connection.id)}
                      disabled={isLoading}
                      className="px-3 py-1.5 text-xs font-medium text-yellow-700 dark:text-yellow-300 bg-yellow-100 dark:bg-yellow-900/30 rounded-md hover:bg-yellow-200 dark:hover:bg-yellow-900/50 disabled:opacity-50"
                      title="Reauthorize bank connection"
                    >
                      Reauthorize
                    </button>
                  )}
                  <button
                    onClick={() => handleDisconnect(connection.id)}
                    className="p-2 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                    title="Disconnect"
                  >
                    <UnlinkIcon size={20} />
                  </button>
                </div>
              </div>
              {rereadOpenFor === connection.id && (
                <form
                  className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 flex flex-wrap items-end gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!rereadDay) return;
                    setRereadOpenFor(null);
                    void handleSync(connection.id, rereadDay);
                  }}
                >
                  <label className="text-sm text-gray-700 dark:text-gray-300">
                    <span className="block mb-1">Re-read from</span>
                    <input
                      type="date"
                      value={rereadDay}
                      min={earliestRereadDay(new Date())}
                      max={todayIso()}
                      required
                      onChange={(event) => setRereadDay(event.target.value)}
                      className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 dark:text-white"
                    />
                  </label>
                  <button
                    type="submit"
                    className="px-3 py-2 text-sm font-medium bg-[#1a2332] text-white rounded-lg hover:bg-[#2d3a4d]"
                  >
                    Re-read
                  </button>
                  <button
                    type="button"
                    onClick={() => setRereadOpenFor(null)}
                    className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400"
                  >
                    Cancel
                  </button>
                  <p className="basis-full text-xs text-gray-500 dark:text-gray-400">
                    Banks hand over about the last ninety days, so that is as far back as this goes.
                    Transactions already in your ledger are recognised, including ones you entered
                    yourself for the same amount on that day or the day either side, so they are not
                    added twice.
                  </p>
                </form>
              )}
              {rereadOutcome?.connectionId === connection.id && (
                <p role="status" className="mt-3 text-sm text-gray-700 dark:text-gray-300">
                  {rereadOutcome.text}
                </p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-8 text-center">
          <LinkIcon size={48} className="text-gray-300 dark:text-gray-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
            No banks connected
          </h3>
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            Connect your bank accounts for automatic transaction imports and real-time balance updates.
          </p>
          <button
            onClick={() => setShowAddBank(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#1a2332] text-white rounded-lg hover:bg-[#2d3a4d]"
          >
            <PlusIcon size={20} />
            Connect Your First Bank
          </button>
        </div>
      )}

      {/* Add Bank Modal */}
      <Modal
        isOpen={showAddBank}
        onClose={() => setShowAddBank(false)}
        title="Connect a Bank"
        size="lg"
      >
        <div className="space-y-4">
          {/* Search */}
          <div className="relative">
            <SearchIcon 
              size={20} 
              className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
            />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search for your bank..."
              spellCheck={false}
              autoCapitalize="none"
              className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:border-transparent dark:bg-gray-700 dark:text-white"
            />
          </div>

          {/* Provider Info */}
          <div className="bg-[#1a2332] dark:bg-gray-700 rounded-lg p-3 text-sm">
            <p className="text-white/80">
              <strong className="text-white">Secure Connection:</strong> Your credentials are never stored.
              Connection is established directly with your bank using OAuth on
              TrueLayer&rsquo;s secure page.
            </p>
          </div>

          {/* Institution List */}
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {filteredInstitutions.map(institution => (
              <button
                key={institution.id}
                onClick={() => handleConnect(institution)}
                disabled={isLoading}
                className="w-full justify-center p-4 bg-gray-50 dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 rounded-lg transition-colors text-left flex items-center gap-4"
              >
                <div className="w-12 h-12 bg-white dark:bg-gray-800 rounded-lg flex items-center justify-center">
                  <Building2Icon size={24} className="text-gray-600 dark:text-gray-400" />
                </div>
                <div className="flex-1">
                  <h4 className="font-medium text-gray-900 dark:text-white">
                    {institution.name}
                  </h4>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    via {institution.provider === 'truelayer' ? 'TrueLayer' : 'Plaid'}
                  </p>
                </div>
                <LinkIcon size={20} className="text-gray-400" />
              </button>
            ))}
          </div>

          {filteredInstitutions.length === 0 && (
            <div className="text-center py-8">
              <p className="text-gray-500 dark:text-gray-400">
                No banks found matching "{searchTerm}"
              </p>
            </div>
          )}

          {/* Catch-all: the in-app list is a shortcut, never a gate — the
              full provider choice lives on TrueLayer's page. */}
          <button
            onClick={() => handleConnect({
              id: 'uk-ob-all',
              name: 'your bank',
              country: 'GB',
              provider: 'truelayer',
              supportsAccountDetails: true,
              supportsTransactions: true,
              supportsBalance: true
            })}
            disabled={isLoading}
            className="w-full justify-center p-3 border border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            {/* `dark:text-blue-400` came off and nothing moved: index.css gives
                `.dark .text-primary` its own `!important` rule (#f9fafb), so
                the blue had already been losing that cascade. */}
            Don&rsquo;t see your bank or card? <span className="font-medium text-primary">Browse all providers</span>
          </button>
        </div>
      </Modal>

      {/* Link discovered bank accounts/cards to app accounts */}
      {linkingConnectionId && (
        <LinkBankAccountsModal
          isOpen={true}
          onClose={() => setLinkingConnectionId(null)}
          connectionId={linkingConnectionId}
          onLinkComplete={handleLinkComplete}
        />
      )}
    </div>
  );
}
