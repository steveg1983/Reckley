import { describe, it, expect, vi } from 'vitest';
import {
  alertThresholdFrom,
  bandOf,
  budgetNote,
  pushBudgetAlerts,
  ALERT_THRESHOLD_KEY,
  type BudgetMark,
  type BudgetPushDeps,
} from '../../../api/_lib/budget-push';
import { evaluateRunningBudgets } from '../../../api/_lib/budget-status';
import { BANK_AUTO_SYNC_PREFS_KEY } from '../../../api/_lib/reminder-push';
import { DEVICE_TIME_ZONE_KEY, PHONE_NOTIFICATION_PREFS_KEY } from '../../../src/services/push/prefs';
import type { PushNote } from '../../../api/_lib/push';
import type { Budget } from '../../../src/types';
import { budgets as fixtureBudgets, fakePort } from './mcp/fakePort';

/**
 * BUDGETS ON THE PHONE (owner, 15 Nov 2026) — the real evaluation over the
 * connector's fake ledger (October 2026: Groceries spent 102.50 of 150, so
 * 68.3%), once per band per period, a percentage and never an amount.
 */

// Midday on 15 October 2026 in London.
const NOW = new Date('2026-10-15T11:00:00Z');

interface Setup {
  budgets?: Budget[];
  threshold?: string;
  phone?: object;
  feedMode?: string;
  marks?: Array<[string, BudgetMark]>;
}

function harness(setup: Setup) {
  const marks = new Map<string, BudgetMark>(setup.marks ?? []);
  const pushed: PushNote[] = [];
  const deps: BudgetPushDeps = {
    now: () => NOW,
    usersWithDevices: vi.fn(async () => ['u1']),
    loadPreferences: vi.fn(async () => new Map([[
      'u1',
      {
        [PHONE_NOTIFICATION_PREFS_KEY]: JSON.stringify(setup.phone ?? { budgets: true }),
        [BANK_AUTO_SYNC_PREFS_KEY]: JSON.stringify({ mode: setup.feedMode ?? 'cloud', dailyTime: '08:00' }),
        [DEVICE_TIME_ZONE_KEY]: 'Europe/London',
        ...(setup.threshold ? { [ALERT_THRESHOLD_KEY]: setup.threshold } : {}),
      },
    ]])),
    evaluate: (_userId, today) => evaluateRunningBudgets(fakePort({ budgets: setup.budgets ?? fixtureBudgets }), today, 20_000),
    loadMarks: vi.fn(async () => new Map(marks)),
    mark: vi.fn(async (_userId: string, budgetId: string, mark: BudgetMark) => {
      marks.set(budgetId, mark);
    }),
    unmark: vi.fn(async (ids: readonly string[]) => {
      for (const id of ids) marks.delete(id);
    }),
    notify: vi.fn(async (_userId: string, note: PushNote) => {
      pushed.push(note);
      return { devices: 1, sent: 1, retired: 0, failed: 0 };
    }),
  };
  return { deps, pushed, marks };
}

const withAmount = (amount: number): Budget[] => [{ ...fixtureBudgets[0], amount }];

describe('pushBudgetAlerts', () => {
  it('says nothing below the threshold (80% unless set)', async () => {
    const { deps, pushed } = harness({});
    const summary = await pushBudgetAlerts(deps);
    expect(pushed).toHaveLength(0);
    expect(summary).toMatchObject({ users: 1, flagged: 0 });
  });

  it('announces a budget that has reached the threshold set in Settings, as a percentage', async () => {
    const { deps, pushed, marks } = harness({ threshold: '60' });
    await pushBudgetAlerts(deps);
    expect(pushed).toEqual([budgetNote('b-groceries', 'Groceries', 'near', 68.33)]);
    expect(pushed[0].body).toBe('Groceries has used 68% of its budget.');
    expect(marks.get('b-groceries')).toEqual({ band: 'near', periodStart: '2026-10-01' });
  });

  it('once: the same band in the same period is not said again', async () => {
    const { deps, pushed } = harness({ threshold: '60', marks: [['b-groceries', { band: 'near', periodStart: '2026-10-01' }]] });
    await pushBudgetAlerts(deps);
    expect(pushed).toHaveLength(0);
  });

  it('near then all used: the step to the second band is announced', async () => {
    const { deps, pushed, marks } = harness({
      budgets: withAmount(100),
      marks: [['b-groceries', { band: 'near', periodStart: '2026-10-01' }]],
    });
    await pushBudgetAlerts(deps);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].title).toBe('Budget spent');
    expect(marks.get('b-groceries')?.band).toBe('over');
  });

  it('a new period re-announces, even in the same band', async () => {
    const { deps, pushed } = harness({
      budgets: withAmount(100),
      marks: [['b-groceries', { band: 'over', periodStart: '2026-09-01' }]],
    });
    await pushBudgetAlerts(deps);
    expect(pushed).toHaveLength(1);
  });

  it('re-arms when the budget drops back below the threshold', async () => {
    const { deps, marks } = harness({ marks: [['b-groceries', { band: 'near', periodStart: '2026-10-01' }]] });
    const summary = await pushBudgetAlerts(deps);
    expect(marks.size).toBe(0);
    expect(summary.rearmed).toBe(1);
  });

  it('only for people who switched it on, in cloud mode', async () => {
    const off = harness({ threshold: '60', phone: { budgets: false } });
    await pushBudgetAlerts(off.deps);
    expect(off.pushed).toHaveLength(0);

    const notCloud = harness({ threshold: '60', feedMode: 'browser' });
    expect(await pushBudgetAlerts(notCloud.deps)).toMatchObject({ users: 0, notCloud: 1 });
    expect(notCloud.pushed).toHaveLength(0);
  });

  it('no lock-screen note ever carries a currency or an amount', () => {
    for (const note of [budgetNote('b', 'Groceries', 'near', 85.6), budgetNote('b', 'Groceries', 'over', 140)]) {
      expect(`${note.title} ${note.body}`).not.toMatch(/[£$€]|\d+\.\d/);
    }
  });
});

describe('the bands and the threshold', () => {
  it('match the Budget page: warning at the threshold, the second band from 100%', () => {
    expect(bandOf(79.9, 80)).toBeNull();
    expect(bandOf(80, 80)).toBe('near');
    expect(bandOf(100, 80)).toBe('over');
  });

  it('reads the Settings threshold, and falls back to 80 for anything odd', () => {
    expect(alertThresholdFrom('70')).toBe(70);
    expect(alertThresholdFrom(undefined)).toBe(80);
    expect(alertThresholdFrom('nonsense')).toBe(80);
  });
});
