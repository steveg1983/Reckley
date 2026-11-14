import type { Account } from '../types';
import type { AutoSyncMode } from './bankAutoSync';
import { toDecimal } from './decimal';
import { isCardAccountType } from './accountNumberInput';
import { isPastWarningLine } from './warningLine';

/**
 * "Needs Your Attention": WHY each account is on the list, in words, and where
 * the fix is.
 *
 * A row EXISTS only because a sentence was produced for it. The card used to
 * decide membership with one rule and label the row with another, so an
 * account whose owner had set any threshold other than £500 appeared with a
 * name and no words under it, and the screen-reader label announced "High
 * utilization" for it. Building the sentence and the row together makes that
 * shape unrepresentable.
 *
 * Pure, with `now` injected: the staleness clock is a parameter so the rules
 * below are tested at fixed instants rather than against the wall clock.
 */

export type AttentionKind = 'low-balance' | 'card-spending' | 'credit-utilisation' | 'feed-stale' | 'feed-reauth';

export interface AttentionItem {
  account: Account;
  kind: AttentionKind;
  /** The whole reason, as a sentence. Never empty. */
  reason: string;
  /** Where the fix is. Not wrapped for demo mode — the caller does that. */
  href: string;
  actionLabel: string;
}

/** The bank-feed facts an account carries (see hooks/useAccountBankSync). */
export interface AttentionBankLink {
  connectionId: string;
  institutionName: string;
  status: 'connected' | 'error' | 'reauth_required';
  lastSync?: Date;
}

export interface AttentionInput {
  accounts: readonly Account[];
  /** Ledger balance for an account id (see utils/accountBalances). */
  balanceOf: (accountId: string) => number;
  /** Bank link for an account id, or undefined for a manual account. */
  linkOf: (accountId: string) => AttentionBankLink | undefined;
  autoSyncMode: AutoSyncMode;
  formatMoney: (amount: number, currency?: string) => string;
  now: Date;
}

/** Utilisation (%) above which a credit card is worth mentioning. */
export const CREDIT_UTILISATION_LIMIT = 70;

/**
 * How old a feed may be before saying so, per refresh schedule.
 *
 * 'daily' allows a whole day plus two hours of slack, so a run scheduled for
 * 08:00 that lands at 08:04 does not make yesterday's row stale at 08:00 the
 * next morning. 'signin' means "refreshed whenever I open the app", so a
 * working morning is the tolerance. 'cloud' is the server's six-hour
 * interval (api/_lib/cloud-refresh.ts — PSD2's four unattended reads a day)
 * plus the same two hours of slack, since the hourly run that picks a
 * connection up lands some way after it falls due.
 *
 * 'off' is deliberately absent: the user turned automatic refresh off, and
 * nagging them about the consequence of their own setting is how a warning
 * becomes noise.
 */
const STALE_AFTER_MS: Record<Exclude<AutoSyncMode, 'off'>, number> = {
  daily: 26 * 60 * 60 * 1000,
  signin: 6 * 60 * 60 * 1000,
  cloud: 8 * 60 * 60 * 1000,
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const OPEN_BANKING_HREF = '/open-banking';

/**
 * How long ago an instant was, in words.
 *
 * Epoch milliseconds throughout: lastSync is a full timestamp, and calendar-day
 * arithmetic calls a refresh forty minutes old "yesterday" either side of
 * midnight.
 */
export function formatTimeSince(from: Date, now: Date): string {
  const elapsed = now.getTime() - from.getTime();
  if (elapsed < MINUTE_MS) return 'a moment ago';
  if (elapsed < HOUR_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(elapsed / DAY_MS);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Is this feed behind what the user asked for?
 *
 * A connection that has never completed a refresh counts as stale on sight —
 * its accounts hold whatever was typed in by hand. A connection in 'error'
 * counts too: the sentence ("hasn't been able to refresh since…") is true of
 * it, and the threshold still applies so a failure ten minutes ago says
 * nothing. 'reauth_required' has a row of its own with a better sentence.
 */
function isFeedStale(link: AttentionBankLink, mode: AutoSyncMode, now: Date): boolean {
  if (mode === 'off') return false;
  if (link.status === 'reauth_required') return false;
  if (!link.lastSync) return true;
  return now.getTime() - link.lastSync.getTime() > STALE_AFTER_MS[mode];
}

function staleReason(link: AttentionBankLink, now: Date): string {
  return link.lastSync
    ? `Balances may be out of date — ${link.institutionName} hasn't been able to refresh since ${formatTimeSince(link.lastSync, now)}.`
    : `${link.institutionName} has never completed a refresh, so this balance is whatever was last entered by hand.`;
}

/** The same fact, said as the second half of an account's own sentence. */
function composedStaleReason(link: AttentionBankLink, now: Date): string {
  return link.lastSync
    ? `Balances may be out of date: ${link.institutionName} hasn't refreshed since ${formatTimeSince(link.lastSync, now)}.`
    : `Balances may be out of date: ${link.institutionName} has never completed a refresh.`;
}

function reauthReason(link: AttentionBankLink, now: Date): string {
  return link.lastSync
    ? `${link.institutionName} needs you to sign in again — nothing new has come through since ${formatTimeSince(link.lastSync, now)}.`
    : `${link.institutionName} needs you to sign in again — nothing has come through from it yet.`;
}

/**
 * The account's OWN problem — the money, not the plumbing. At most one per
 * account: the threshold the user set outranks a utilisation rule they never
 * asked for, and two rows about one account is the card repeating itself.
 */
function buildAccountItem(
  account: Account,
  balance: number,
  formatMoney: AttentionInput['formatMoney']
): AttentionItem | null {
  /*
   * ON A CARD THE SAME NUMBER MEANS SPENDING (owner, 16 August). The user
   * types the positive figure they think in — "warn me at £10,000 of spend" —
   * and the app knows spend is a negative balance, so the line is crossed at
   * −threshold. One stored column, one comparison, two readings.
   *
   * This also repairs the old semantics on cards, which were near-useless:
   * "balance below £500" is almost always TRUE of an account that lives
   * negative, so a card with this alert on was a card that warned forever.
   *
   * The comparison itself lives in utils/warningLine.ts, which the phone's
   * low-balance push asks too (14 Nov 2026), so the two never disagree.
   */
  const isCard = isCardAccountType(account.type);
  if (account.lowBalanceThreshold != null && isPastWarningLine(account, balance)) {
    return isCard
      ? {
          account,
          kind: 'card-spending',
          reason:
            `Spending at ${formatMoney(Math.abs(balance), account.currency)} — ` +
            `above the ${formatMoney(account.lowBalanceThreshold, account.currency)} you asked to be warned at.`,
          href: `/accounts/${account.id}`,
          actionLabel: 'Open register',
        }
      : {
          account,
          kind: 'low-balance',
          reason:
            `Down to ${formatMoney(balance, account.currency)} — ` +
            `below the ${formatMoney(account.lowBalanceThreshold, account.currency)} you asked to be warned at.`,
          href: `/accounts/${account.id}`,
          actionLabel: 'Open register',
        };
  }

  // A card IN CREDIT is not using any of its limit. The previous rule took the
  // absolute value of the balance, so a £200 credit on a £250 card read as 80%
  // utilisation and warned the one person who owed nothing.
  if (account.type === 'credit' && account.creditLimit && balance < 0) {
    const used = toDecimal(balance).abs().dividedBy(toDecimal(account.creditLimit)).times(100);
    if (used.greaterThan(CREDIT_UTILISATION_LIMIT)) {
      return {
        account,
        kind: 'credit-utilisation',
        reason: `Using ${used.toFixed(0)}% of the ${formatMoney(account.creditLimit, account.currency)} limit.`,
        href: `/accounts/${account.id}`,
        actionLabel: 'Open register',
      };
    }
  }

  return null;
}

/**
 * Everything the card should say, in one pass over the accounts.
 *
 * Account rows come first in account order, then one row per bank connection
 * that needs something — a login backing four accounts says its piece once,
 * attached to the first account it backs so the row still has a name on it.
 */
export function buildAttentionItems(input: AttentionInput): AttentionItem[] {
  const { accounts, balanceOf, linkOf, autoSyncMode, formatMoney, now } = input;

  const accountItems: AttentionItem[] = [];
  /** Connections whose staleness is already said inside an account's own row. */
  const explained = new Set<string>();
  /** Feed rows keyed by connection, so one login cannot fill the card. */
  const feedItems = new Map<string, AttentionItem>();

  for (const account of accounts) {
    const item = buildAccountItem(account, balanceOf(account.id), formatMoney);
    const link = linkOf(account.id);

    if (link) {
      if (link.status === 'reauth_required') {
        if (!feedItems.has(link.connectionId)) {
          feedItems.set(link.connectionId, {
            account,
            kind: 'feed-reauth',
            reason: reauthReason(link, now),
            href: OPEN_BANKING_HREF,
            actionLabel: 'Reconnect bank',
          });
        }
      } else if (isFeedStale(link, autoSyncMode, now)) {
        if (item) {
          // A stale feed is WHY the figure in this row may be wrong, so it is
          // said in the same sentence rather than in a second row about the
          // same account — and that settles this connection.
          item.reason += ` ${composedStaleReason(link, now)}`;
          explained.add(link.connectionId);
        } else if (!feedItems.has(link.connectionId)) {
          feedItems.set(link.connectionId, {
            account,
            kind: 'feed-stale',
            reason: staleReason(link, now),
            href: OPEN_BANKING_HREF,
            actionLabel: 'Check the feed',
          });
        }
      }
    }

    if (item) accountItems.push(item);
  }

  // A connection explained by a later account's row loses its own — the order
  // accounts arrive in must not decide whether the card repeats itself.
  const feedRows = [...feedItems.entries()]
    .filter(([connectionId, row]) => row.kind === 'feed-reauth' || !explained.has(connectionId))
    .map(([, row]) => row);

  return [...accountItems, ...feedRows];
}
