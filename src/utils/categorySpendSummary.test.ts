/**
 * The evidence a budget is set against — pinned.
 *
 * Two readings of "last 12 months" (the owner named both, 29 Aug 2026), what
 * counts as spending, and the twin arithmetic that lets someone type either
 * figure. Every name and amount is invented: this repo is public.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_CUSTOM_MONTHS,
  PAID_ONCE_MIN_MONTHS,
  clampCustomWindow,
  groupSubtotals,
  paidOnceIn,
  spendWindow,
  summariseCategorySpend,
  twinOf,
} from './categorySpendSummary';
import { toDecimal } from './decimal';
import type { Category, Transaction, TransactionSplit } from '../types';

const CATEGORIES: Category[] = [
  { id: 'type-income', name: 'Income', type: 'income', level: 'type' },
  { id: 'type-expense', name: 'Expenses', type: 'expense', level: 'type' },
  { id: 'type-transfer', name: 'Transfer', type: 'both', level: 'type', isTransferCategory: true },
  { id: 'grp-food', name: 'Food', type: 'expense', level: 'sub', parentId: 'type-expense' },
  { id: 'det-shop', name: 'Food Shopping', type: 'expense', level: 'detail', parentId: 'grp-food' },
  { id: 'det-dining', name: 'Dining Out', type: 'expense', level: 'detail', parentId: 'grp-food' },
  { id: 'grp-home', name: 'Household', type: 'expense', level: 'sub', parentId: 'type-expense' },
  { id: 'det-energy', name: 'Gas & Electricity', type: 'expense', level: 'detail', parentId: 'grp-home' },
  { id: 'det-salary', name: 'Net Pay', type: 'income', level: 'detail', parentId: 'type-income' },
  { id: 'transfer-out', name: 'Transfer Out', type: 'both', level: 'detail', parentId: 'type-transfer', isTransferCategory: true },
];

const txn = (over: Partial<Transaction> & { id: string; date: string }): Transaction => ({
  accountId: 'acc-1',
  description: 'Synthetic row',
  amount: -50,
  type: 'expense',
  category: 'det-shop',
  ...over,
  date: new Date(over.date),
});

/** Fixed "now": Saturday 29 August 2026, mid-month on purpose. */
const NOW = new Date(2026, 7, 29);

describe('spendWindow', () => {
  it('full-months ends at the last COMPLETE month — the owner\'s reading', () => {
    // 29 Aug: August has not finished, so it is out; the year is Aug 2025 to
    // Jul 2026 inclusive. Counting a part-month would read every category low
    // by however much of August is left.
    expect(spendWindow('full-months', NOW)).toEqual({
      kind: 'full-months', from: '2025-08-01', to: '2026-07-31', months: 12,
    });
  });

  it('to-yesterday is the rolling year ending yesterday — today is a part-day too', () => {
    expect(spendWindow('to-yesterday', NOW)).toEqual({
      kind: 'to-yesterday', from: '2025-08-29', to: '2026-08-28', months: 12,
    });
  });

  it('full-months on the FIRST of a month still ends with the month just gone', () => {
    expect(spendWindow('full-months', new Date(2026, 0, 1))).toEqual({
      kind: 'full-months', from: '2025-01-01', to: '2025-12-31', months: 12,
    });
  });
});

describe('spendWindow — months the user chooses (custom)', () => {
  it('runs from the first of the from-month to the last day of the to-month, and counts them', () => {
    expect(spendWindow('custom', NOW, { fromMonth: '2026-01', toMonth: '2026-06' })).toEqual({
      kind: 'custom', from: '2026-01-01', to: '2026-06-30', months: 6,
    });
  });

  it('a single month is a window of one', () => {
    expect(spendWindow('custom', NOW, { fromMonth: '2026-02', toMonth: '2026-02' })).toEqual({
      kind: 'custom', from: '2026-02-01', to: '2026-02-28', months: 1,
    });
  });

  it('never includes the month still running — a range reaching into it is cut back to last month', () => {
    // 29 Aug: August is not finished. A range "to August" ends in July.
    expect(spendWindow('custom', NOW, { fromMonth: '2026-05', toMonth: '2026-08' })).toEqual({
      kind: 'custom', from: '2026-05-01', to: '2026-07-31', months: 3,
    });
    // …and a range entirely in the future collapses to last month alone.
    expect(spendWindow('custom', NOW, { fromMonth: '2026-09', toMonth: '2026-12' })).toEqual({
      kind: 'custom', from: '2026-07-01', to: '2026-07-31', months: 1,
    });
  });

  it('a range stated backwards is turned the right way round', () => {
    expect(spendWindow('custom', NOW, { fromMonth: '2026-06', toMonth: '2026-01' })).toEqual({
      kind: 'custom', from: '2026-01-01', to: '2026-06-30', months: 6,
    });
  });

  it('keeps the most recent 36 months of a longer range — the recent evidence is the evidence', () => {
    const w = spendWindow('custom', NOW, { fromMonth: '2020-01', toMonth: '2026-07' });
    expect(w.months).toBe(MAX_CUSTOM_MONTHS);
    expect(w.to).toBe('2026-07-31');
    expect(w.from).toBe('2023-08-01');
  });

  it('with no range stated it is the last twelve complete months — choosing "custom" and typing nothing changes nothing', () => {
    const named = spendWindow('full-months', NOW);
    expect(spendWindow('custom', NOW)).toEqual({ ...named, kind: 'custom' });
    expect(spendWindow('custom', NOW, { fromMonth: '', toMonth: '2026-06' })).toEqual({ ...named, kind: 'custom' });
  });

  it('clampCustomWindow is the rule the screen can show back', () => {
    expect(clampCustomWindow({ fromMonth: '2026-09', toMonth: '2026-12' }, NOW)).toEqual({
      fromMonth: '2026-07', toMonth: '2026-07',
    });
    expect(clampCustomWindow(undefined, NOW)).toEqual({ fromMonth: '2025-08', toMonth: '2026-07' });
  });
});

describe('summariseCategorySpend — what counts', () => {
  const rows: Transaction[] = [
    txn({ id: 'a', date: '2025-09-10', amount: -120 }),
    txn({ id: 'b', date: '2026-03-04', amount: -80 }),
    txn({ id: 'c', date: '2026-07-31', amount: -100 }),       // last day, in
    txn({ id: 'd', date: '2026-08-02', amount: -400 }),       // this month, OUT of full-months
    txn({ id: 'e', date: '2025-07-31', amount: -999 }),       // day before the window
    txn({ id: 'f', date: '2026-02-02', amount: 6000, type: 'income', category: 'det-salary' }),
    txn({ id: 'g', date: '2026-02-03', amount: -500, type: 'transfer', category: 'transfer-out' }),
  ];

  it('sums the window\'s expenses per category and nothing else', () => {
    const s = summariseCategorySpend(rows, [], CATEGORIES, { now: NOW });
    expect(s.byCategory.get('det-shop')?.annual.toNumber()).toBe(300); // 120+80+100
    // Income and transfers never appear, whatever their amount.
    expect(s.byCategory.has('det-salary')).toBe(false);
    expect(s.byCategory.has('transfer-out')).toBe(false);
  });

  it('gives the monthly figure as exactly a twelfth of the year', () => {
    const s = summariseCategorySpend(rows, [], CATEGORIES, { now: NOW });
    expect(s.byCategory.get('det-shop')?.monthly.toNumber()).toBe(25); // 300 / 12
  });

  it('over a twelve-month window, annual IS the total — to the digit, no ÷12×12 round trip', () => {
    const s = summariseCategorySpend([txn({ id: 'odd', date: '2026-01-10', amount: -100 })], [], CATEGORIES, { now: NOW });
    const spend = s.byCategory.get('det-shop');
    expect(spend?.total.toString()).toBe('100');
    expect(spend?.annual.toString()).toBe('100');
    expect(spend?.monthly.times(12).toString()).toBe('100');
  });

  it('over a custom window, the figures are AT A RATE: a month is total ÷ months, a year is that × 12', () => {
    // Jan–Jun 2026 holds only the £80 of March: £80 over six months.
    const s = summariseCategorySpend(rows, [], CATEGORIES, {
      kind: 'custom', now: NOW, custom: { fromMonth: '2026-01', toMonth: '2026-06' },
    });
    const spend = s.byCategory.get('det-shop');
    expect(s.window.months).toBe(6);
    expect(spend?.total.toNumber()).toBe(80);
    expect(spend?.monthly.toString()).toBe('13.333333333333333333');
    expect(spend?.annual.toNumber()).toBe(160);
    // The invariant every screen relies on holds whatever the window: monthly = annual ÷ 12.
    expect(spend?.annual.dividedBy(12).toString()).toBe(spend?.monthly.toString());
  });

  it('the window choice changes what is counted, visibly', () => {
    const rolling = summariseCategorySpend(rows, [], CATEGORIES, { kind: 'to-yesterday', now: NOW });
    // August's £400 joins; July 2025's £999 was already out of both.
    expect(rolling.byCategory.get('det-shop')?.annual.toNumber()).toBe(700);
  });

  it('leaves a category with no spending OUT of the map rather than in it at zero', () => {
    const s = summariseCategorySpend(rows, [], CATEGORIES, { now: NOW });
    expect(s.byCategory.has('det-energy')).toBe(false);
  });

  it('counts the rows behind each figure — one freak charge should be visible as one', () => {
    const s = summariseCategorySpend(rows, [], CATEGORIES, { now: NOW });
    expect(s.byCategory.get('det-shop')?.rows).toBe(3);
  });
});

describe('summariseCategorySpend — refunds, splits and unfiled money', () => {
  it('nets a refund off its category: the year cost what it cost', () => {
    const s = summariseCategorySpend([
      txn({ id: 'buy', date: '2026-01-10', amount: -200, category: 'det-dining' }),
      txn({ id: 'refund', date: '2026-01-20', amount: 40, type: 'income', category: 'det-dining' }),
    ], [], CATEGORIES, { now: NOW });
    expect(s.byCategory.get('det-dining')?.annual.toNumber()).toBe(160);
  });

  it('never reports negative spending — "you were paid to shop here" is not a budget', () => {
    const s = summariseCategorySpend([
      txn({ id: 'buy', date: '2026-01-10', amount: -50, category: 'det-dining' }),
      txn({ id: 'refund', date: '2026-01-20', amount: 300, type: 'income', category: 'det-dining' }),
    ], [], CATEGORIES, { now: NOW });
    expect(s.byCategory.get('det-dining')?.annual.toNumber()).toBe(0);
  });

  it('splits land in their own categories, not the parent\'s', () => {
    const parent = txn({ id: 'split', date: '2026-05-05', amount: -180, category: '', isSplit: true });
    const splits: TransactionSplit[] = [
      { id: 's1', transactionId: 'split', category: 'det-shop', amount: -120, sortOrder: 1 },
      { id: 's2', transactionId: 'split', category: 'det-dining', amount: -60, sortOrder: 2 },
    ];
    const s = summariseCategorySpend([parent], splits, CATEGORIES, { now: NOW });
    expect(s.byCategory.get('det-shop')?.annual.toNumber()).toBe(120);
    expect(s.byCategory.get('det-dining')?.annual.toNumber()).toBe(60);
  });

  it('counts unfiled spending separately, so the screen can say the figures are short', () => {
    const s = summariseCategorySpend([
      txn({ id: 'filed', date: '2026-04-01', amount: -100 }),
      txn({ id: 'unfiled', date: '2026-04-02', amount: -75, category: undefined }),
      txn({ id: 'unfiled-credit', date: '2026-04-03', amount: 20, type: 'income', category: undefined }),
    ], [], CATEGORIES, { now: NOW });

    expect(s.byCategory.get('det-shop')?.annual.toNumber()).toBe(100);
    expect(s.unfiled.toNumber()).toBe(75);   // the credit is not unfiled SPENDING
    expect(s.unfiledRows).toBe(1);
  });
});

/**
 * PAID IN ONE GO (owner, 7 Nov 2026): the window's own evidence that a
 * category is a lump — most of its spending in one month — which the wizard
 * proposes as the budget's pace shape. A rule, not a flag.
 */
describe('summariseCategorySpend — a category paid in one go', () => {
  it('names the month that held nearly all of it', () => {
    const summary = summariseCategorySpend(
      [
        txn({ id: 'premium', date: '2026-03-15', amount: -480, category: 'det-energy' }),
        txn({ id: 'top-up', date: '2026-05-02', amount: -20, category: 'det-energy' }),
        txn({ id: 'weekly', date: '2026-03-16', amount: -50 }),
      ],
      [], CATEGORIES, { now: NOW }
    );
    expect(summary.byCategory.get('det-energy')?.paidOnce).toBe('2026-03');
    expect(summary.byCategory.get('det-shop')?.paidOnce).toBe('2026-03');
  });

  it('says nothing for spending spread through the year', () => {
    const spread = Array.from({ length: 12 }, (_, index) =>
      txn({ id: `m-${index}`, date: `${index < 5 ? 2025 : 2026}-${String(((index + 7) % 12) + 1).padStart(2, '0')}-10`, amount: -50 })
    );
    expect(summariseCategorySpend(spread, [], CATEGORIES, { now: NOW }).byCategory.get('det-shop')?.paidOnce).toBeNull();
  });

  it('needs a window long enough to tell a lump from a short window', () => {
    const custom = { fromMonth: '2026-05', toMonth: '2026-07' };
    const once = [txn({ id: 'bill', date: '2026-06-10', amount: -300 })];
    expect(summariseCategorySpend(once, [], CATEGORIES, { now: NOW, kind: 'custom', custom }).byCategory.get('det-shop')?.paidOnce).toBeNull();
    const longer = { fromMonth: '2026-02', toMonth: '2026-07' };
    expect(summariseCategorySpend(once, [], CATEGORIES, { now: NOW, kind: 'custom', custom: longer }).byCategory.get('det-shop')?.paidOnce).toBe('2026-06');
  });

  it('the rule itself: four fifths in one month, exactly, is enough; less is not', () => {
    const month = (pairs: Array<[string, number]>): Map<string, ReturnType<typeof toDecimal>> =>
      new Map(pairs.map(([key, amount]) => [key, toDecimal(amount)]));
    expect(paidOnceIn(month([['2026-03', 80], ['2026-04', 20]]), toDecimal(100), 12)).toBe('2026-03');
    expect(paidOnceIn(month([['2026-03', 79], ['2026-04', 21]]), toDecimal(100), 12)).toBeNull();
    expect(paidOnceIn(month([['2026-03', 100]]), toDecimal(100), PAID_ONCE_MIN_MONTHS - 1)).toBeNull();
    expect(paidOnceIn(month([]), toDecimal(0), 12)).toBeNull();
  });
});

describe('groupSubtotals — context for a leaf figure', () => {
  it('rolls leaves up to the group they sit under', () => {
    const s = summariseCategorySpend([
      txn({ id: 'a', date: '2026-01-05', amount: -300, category: 'det-shop' }),
      txn({ id: 'b', date: '2026-01-06', amount: -200, category: 'det-dining' }),
      txn({ id: 'c', date: '2026-01-07', amount: -150, category: 'det-energy' }),
    ], [], CATEGORIES, { now: NOW });

    const groups = groupSubtotals(s, CATEGORIES);
    expect(groups.get('grp-food')?.toNumber()).toBe(500);
    expect(groups.get('grp-home')?.toNumber()).toBe(150);
  });
});

describe('twinOf — type either figure, see the other', () => {
  it('a monthly budget states its year, and a yearly budget its month', () => {
    expect(twinOf(1600, 'monthly').toNumber()).toBe(19200);
    expect(twinOf(15000, 'yearly').toNumber()).toBe(1250);
  });

  it('keeps full precision rather than rounding into the stored figure', () => {
    // £1,000/yr is £83.33… a month: the screen rounds, the arithmetic does not,
    // so a twin typed back never drifts.
    expect(twinOf(1000, 'yearly').times(12).toNumber()).toBe(1000);
  });
});
