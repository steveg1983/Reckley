import { describe, it, expect, vi } from 'vitest';
import {
  lowBalanceNote,
  pushLowBalances,
  type LowBalancePushDeps,
  type WatchedAccount,
} from '../../../api/_lib/low-balance-push';
import { BANK_AUTO_SYNC_PREFS_KEY } from '../../../api/_lib/reminder-push';
import { PHONE_NOTIFICATION_PREFS_KEY } from '../../../src/services/push/prefs';
import type { PushNote } from '../../../api/_lib/push';

/**
 * "AN ACCOUNT IS PAST THE LINE YOU SET" — once per crossing, never an amount,
 * only for people who asked and are in cloud mode. Every figure invented.
 */

interface UserSetup {
  lowBalances?: boolean;
  feedMode?: string;
  accounts?: Array<Omit<WatchedAccount, 'userId'> & { balance: number }>;
}

function harness(users: Record<string, UserSetup>, initialMarks: string[] = []) {
  const marks = new Set(initialMarks);
  const pushed: Array<{ userId: string; note: PushNote }> = [];
  const deps: LowBalancePushDeps = {
    usersWithDevices: vi.fn(async () => Object.keys(users)),
    loadPreferences: vi.fn(async (ids: readonly string[]) => {
      const map = new Map<string, Record<string, string>>();
      for (const id of ids) {
        map.set(id, {
          [PHONE_NOTIFICATION_PREFS_KEY]: JSON.stringify({ lowBalances: users[id].lowBalances ?? true }),
          [BANK_AUTO_SYNC_PREFS_KEY]: JSON.stringify({ mode: users[id].feedMode ?? 'cloud', dailyTime: '08:00' }),
        });
      }
      return map;
    }),
    loadWatchedAccounts: vi.fn(async (ids: readonly string[]) =>
      ids.flatMap(userId => (users[userId].accounts ?? []).map(({ balance: _balance, ...account }) => ({ ...account, userId })))
    ),
    loadBalances: vi.fn(async (userId: string) =>
      new Map((users[userId].accounts ?? []).map(account => [account.id, account.balance]))
    ),
    loadMarks: vi.fn(async () => new Set(marks)),
    mark: vi.fn(async (account: WatchedAccount) => {
      marks.add(account.id);
    }),
    unmark: vi.fn(async (ids: readonly string[]) => {
      for (const id of ids) marks.delete(id);
    }),
    notify: vi.fn(async (userId: string, note: PushNote) => {
      pushed.push({ userId, note });
      return { devices: 1, sent: 1, retired: 0, failed: 0 };
    }),
  };
  return { deps, pushed, marks };
}

const current = (balance: number, over: Partial<WatchedAccount> = {}) => ({
  id: 'acc-current',
  name: 'Synthetic Current',
  type: 'current',
  lowBalanceAlertEnabled: true,
  lowBalanceThreshold: 1000,
  balance,
  ...over,
});

describe('pushLowBalances', () => {
  it('announces an account that has gone below its line, and marks it', async () => {
    const { deps, pushed, marks } = harness({ u1: { accounts: [current(250)] } });
    const summary = await pushLowBalances(deps);

    expect(pushed).toHaveLength(1);
    expect(pushed[0].userId).toBe('u1');
    expect(pushed[0].note).toEqual(lowBalanceNote({ id: 'acc-current', name: 'Synthetic Current', type: 'current' }));
    expect(marks.has('acc-current')).toBe(true);
    expect(summary).toMatchObject({ users: 1, past: 1, pushed: 1, sent: 1 });
  });

  it('says it ONCE: an account still below its line on the next run is not announced again', async () => {
    const { deps, pushed } = harness({ u1: { accounts: [current(250)] } }, ['acc-current']);
    const summary = await pushLowBalances(deps);
    expect(pushed).toHaveLength(0);
    expect(summary).toMatchObject({ past: 1, pushed: 0 });
  });

  it('re-arms when the account comes back above its line, so the next crossing is announced', async () => {
    const first = harness({ u1: { accounts: [current(5000)] } }, ['acc-current']);
    const summary = await pushLowBalances(first.deps);
    expect(first.marks.has('acc-current')).toBe(false);
    expect(summary.rearmed).toBe(1);

    const second = harness({ u1: { accounts: [current(250)] } }, [...first.marks]);
    await pushLowBalances(second.deps);
    expect(second.pushed).toHaveLength(1);
  });

  it('re-arms when the warning on the account is switched off', async () => {
    const { deps, marks } = harness({ u1: { accounts: [] } }, ['acc-current']);
    await pushLowBalances(deps);
    expect(marks.size).toBe(0);
  });

  it('a card is announced as spending past the line, and the words carry no amount', async () => {
    const { deps, pushed } = harness({
      u1: { accounts: [current(-1500, { id: 'acc-card', name: 'Synthetic Card', type: 'credit' })] },
    });
    await pushLowBalances(deps);
    expect(pushed[0].note.title).toBe('Card spending past your warning');
    expect(pushed[0].note.body).toBe('Spending on Synthetic Card has gone past the level you set.');
    expect(pushed[0].note.url).toBe('/accounts/acc-card');
    for (const text of [pushed[0].note.title, pushed[0].note.body]) {
      expect(text).not.toMatch(/[£$€]|\d/);
    }
  });

  it('a card owing less than its line is fine', async () => {
    const { deps, pushed } = harness({
      u1: { accounts: [current(-200, { id: 'acc-card', type: 'credit' })] },
    });
    await pushLowBalances(deps);
    expect(pushed).toHaveLength(0);
  });

  it('only people who switched it on, and only in cloud mode', async () => {
    const { deps, pushed } = harness({
      off: { lowBalances: false, accounts: [current(1)] },
      notCloud: { feedMode: 'browser', accounts: [current(1)] },
      on: { accounts: [current(1, { id: 'acc-on' })] },
    });
    const summary = await pushLowBalances(deps);
    expect(pushed.map(p => p.userId)).toEqual(['on']);
    expect(summary).toMatchObject({ users: 1, notCloud: 1 });
  });

  it('nothing to do with no phones listening', async () => {
    const { deps } = harness({});
    expect(await pushLowBalances(deps)).toMatchObject({ users: 0, pushed: 0 });
    expect(deps.loadPreferences).not.toHaveBeenCalled();
  });

  it('every lock-screen note fits Apple’s collapse-id limit', () => {
    const note = lowBalanceNote({ id: '624eb45e-0000-4000-8000-000000000000', name: 'X', type: 'current' });
    expect(new TextEncoder().encode(note.collapseId ?? '').length).toBeLessThanOrEqual(64);
  });
});
