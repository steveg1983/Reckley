import type { SupabaseClient } from '@supabase/supabase-js';
import { describeSupabaseFailure } from './supabase-failure.js';
import { parsePhoneNotificationPrefs, PHONE_NOTIFICATION_PREFS_KEY } from '../../src/services/push/prefs.js';
import { isCardAccountTypeValue } from '../../src/utils/accountNumberInput.js';
import { isPastWarningLine } from '../../src/utils/warningLine.js';
import { loadPreferenceValues, notifyUser, pushDeps, usersWithEnabledDevices, type NotifyOutcome, type PushNote } from './push.js';
import { BANK_AUTO_SYNC_PREFS_KEY, isCloudMode } from './reminder-push.js';

/**
 * "An account is past the line you set" — on the lock screen.
 *
 * The owner, 14 Nov 2026: the Dashboard's "Needs your attention" card had
 * been warning about a low balance and the phone had never once said so,
 * because nothing on the server looked. This looks every quarter-hour (the
 * reminders cron), for every person who switched "Low balances" on, with
 * the card's own rule (utils/warningLine.ts) over the balance the register
 * shows (account_balances_for_user, the connector's exact sum).
 *
 * ONCE PER CROSSING. low_balance_marks holds a row for each account already
 * announced; while it stays past the line nothing more is sent, and when it
 * comes back (or its warning is switched off) the row goes, so the next
 * crossing is announced again. The mark is written BEFORE the push, as the
 * reminder's is: a run that dies mid-send must not announce twice.
 *
 * NO AMOUNTS (owner, 11 Nov 2026: every lock-screen surface is figure-free).
 * The note names the account and says which side of the line it is on; the
 * figure is one tap away, behind the phone's own lock.
 */

export interface WatchedAccount {
  id: string;
  userId: string;
  name: string;
  type: unknown;
  lowBalanceAlertEnabled: boolean;
  lowBalanceThreshold: number | null;
}

export interface LowBalancePushDeps {
  usersWithDevices: () => Promise<string[]>;
  loadPreferences: (userIds: readonly string[]) => Promise<Map<string, Record<string, string>>>;
  /** Open accounts with a warning switched on, for these users. */
  loadWatchedAccounts: (userIds: readonly string[]) => Promise<WatchedAccount[]>;
  /** The register's balance of every account one user has. */
  loadBalances: (userId: string) => Promise<Map<string, number>>;
  /** Account ids already announced, for these users. */
  loadMarks: (userIds: readonly string[]) => Promise<Set<string>>;
  mark: (account: WatchedAccount) => Promise<void>;
  unmark: (accountIds: readonly string[]) => Promise<void>;
  notify: (userId: string, note: PushNote) => Promise<NotifyOutcome>;
}

export interface LowBalancePushSummary {
  /** Asked for low-balance pushes, in cloud mode. */
  users: number;
  /** Asked, but their feeds are not refreshed in the cloud. */
  notCloud: number;
  /** Accounts past their line now. */
  past: number;
  /** Of those, announced on this run. */
  pushed: number;
  /** Marks cleared because the account came back or the warning went off. */
  rearmed: number;
  sent: number;
  retired: number;
  failed: number;
}

/** The lock-screen words for one account. Never an amount. */
export const lowBalanceNote = (account: Pick<WatchedAccount, 'id' | 'name' | 'type'>): PushNote =>
  isCardAccountTypeValue(account.type)
    ? {
        title: 'Card spending past your warning',
        body: `Spending on ${account.name} has gone past the level you set.`,
        url: `/accounts/${account.id}`,
        collapseId: `low-balance-${account.id}`,
        threadId: 'low-balance',
      }
    : {
        title: 'Balance below your warning',
        body: `${account.name} has gone below the level you set.`,
        url: `/accounts/${account.id}`,
        collapseId: `low-balance-${account.id}`,
        threadId: 'low-balance',
      };

export const pushLowBalances = async (deps: LowBalancePushDeps): Promise<LowBalancePushSummary> => {
  const summary: LowBalancePushSummary = { users: 0, notCloud: 0, past: 0, pushed: 0, rearmed: 0, sent: 0, retired: 0, failed: 0 };
  const withDevices = await deps.usersWithDevices();
  if (withDevices.length === 0) return summary;

  const preferences = await deps.loadPreferences(withDevices);
  const listening: string[] = [];
  for (const userId of withDevices) {
    const values = preferences.get(userId);
    if (!values || !parsePhoneNotificationPrefs(values[PHONE_NOTIFICATION_PREFS_KEY]).lowBalances) continue;
    // The owner's ruling (11 Sep): phone alerts are what a CLOUD user opts into.
    if (!isCloudMode(values[BANK_AUTO_SYNC_PREFS_KEY])) {
      summary.notCloud += 1;
      continue;
    }
    listening.push(userId);
  }
  summary.users = listening.length;
  if (listening.length === 0) return summary;

  const [accounts, marks] = await Promise.all([deps.loadWatchedAccounts(listening), deps.loadMarks(listening)]);
  const byUser = new Map<string, WatchedAccount[]>();
  for (const account of accounts) {
    const list = byUser.get(account.userId) ?? [];
    list.push(account);
    byUser.set(account.userId, list);
  }

  const stillPast = new Set<string>();
  for (const userId of listening) {
    const watched = byUser.get(userId) ?? [];
    if (watched.length === 0) continue;
    const balances = await deps.loadBalances(userId);
    for (const account of watched) {
      const balance = balances.get(account.id);
      if (balance === undefined || !isPastWarningLine(account, balance)) continue;
      stillPast.add(account.id);
      summary.past += 1;
      if (marks.has(account.id)) continue;

      await deps.mark(account);
      const outcome = await deps.notify(userId, lowBalanceNote(account));
      summary.pushed += 1;
      summary.sent += outcome.sent;
      summary.retired += outcome.retired;
      summary.failed += outcome.failed;
    }
  }

  // Back above the line, warning switched off, or account closed: re-arm.
  const rearm = [...marks].filter(id => !stillPast.has(id));
  if (rearm.length > 0) {
    await deps.unmark(rearm);
    summary.rearmed = rearm.length;
  }
  return summary;
};

const num = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** The verbs bound to Supabase and Apple, or null when APNs is not configured. */
export const lowBalancePushDeps = (supabase: SupabaseClient): LowBalancePushDeps | null => {
  const push = pushDeps(supabase);
  if (!push) return null;
  return {
    usersWithDevices: () => usersWithEnabledDevices(supabase),
    loadPreferences: (userIds) => loadPreferenceValues(supabase, userIds),
    loadWatchedAccounts: async (userIds) => {
      const { data, error, status } = await supabase
        .from('accounts')
        .select('id, user_id, name, type, low_balance_alert_enabled, low_balance_threshold, is_active')
        .in('user_id', [...userIds])
        .eq('low_balance_alert_enabled', true);
      if (error) throw new Error(`Failed to load watched accounts: ${describeSupabaseFailure(error, status)}`);
      const rows = (data ?? []) as Array<{
        id: string;
        user_id: string;
        name: string | null;
        type: unknown;
        low_balance_alert_enabled: boolean | null;
        low_balance_threshold: number | string | null;
        is_active: boolean | null;
      }>;
      return rows
        .filter(row => row.is_active !== false)
        .map(row => ({
          id: row.id,
          userId: row.user_id,
          name: row.name ?? 'An account',
          type: row.type,
          lowBalanceAlertEnabled: row.low_balance_alert_enabled === true,
          lowBalanceThreshold: num(row.low_balance_threshold),
        }));
    },
    loadBalances: async (userId) => {
      const { data, error } = await supabase.rpc('account_balances_for_user', { p_user_id: userId });
      if (error) throw new Error(`Failed to load balances: ${error.message}`);
      const rows = (data ?? []) as Array<{ account_id: string; balance: number | string }>;
      const balances = new Map<string, number>();
      for (const row of rows) {
        const value = num(row.balance);
        if (value !== null) balances.set(row.account_id, value);
      }
      return balances;
    },
    loadMarks: async (userIds) => {
      const { data, error, status } = await supabase
        .from('low_balance_marks')
        .select('account_id')
        .in('user_id', [...userIds]);
      if (error) throw new Error(`Failed to load low-balance marks: ${describeSupabaseFailure(error, status)}`);
      return new Set(((data ?? []) as Array<{ account_id: string }>).map(row => row.account_id));
    },
    mark: async (account) => {
      const { error, status } = await supabase
        .from('low_balance_marks')
        .upsert({ account_id: account.id, user_id: account.userId, notified_at: new Date().toISOString() }, { onConflict: 'account_id' });
      if (error) throw new Error(`Failed to record the low-balance push: ${describeSupabaseFailure(error, status)}`);
    },
    unmark: async (accountIds) => {
      const { error, status } = await supabase.from('low_balance_marks').delete().in('account_id', [...accountIds]);
      if (error) throw new Error(`Failed to re-arm low-balance pushes: ${describeSupabaseFailure(error, status)}`);
    },
    notify: (userId, note) => notifyUser(push, userId, note),
  };
};
