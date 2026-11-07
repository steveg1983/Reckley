/**
 * One evaluation of a budget, for every surface that quotes one.
 *
 * The Dashboard's Budget Status card summed a budget's own category over a
 * rolling thirty days against the base amount; the Budget page measured the
 * budget's real window, rolled groups up, healed legacy category names and
 * carried rollovers in. Same budget, two figures. These specs pin the one
 * evaluation both now share — above all the WINDOW, which is what made the
 * Dashboard's figure unanswerable ("what period is that for?").
 */

import { describe, it, expect } from 'vitest';
import { evaluateBudgets, buildBudgetCategoryResolver } from './budgetEvaluation';
import { expandSplitTransactions } from './transactionSplits';
import type { Budget, Category, Transaction, TransactionSplit } from '../types';

const NOW = new Date(2026, 9, 15, 12, 0, 0); // 15 October 2026, local

const categories: Category[] = [
  { id: 'cat-food', name: 'Food', type: 'expense', level: 'sub' },
  { id: 'cat-groceries', name: 'Groceries', type: 'expense', level: 'detail', parentId: 'cat-food' },
  { id: 'cat-eating-out', name: 'Eating out', type: 'expense', level: 'detail', parentId: 'cat-food' },
  { id: 'cat-fuel', name: 'Fuel', type: 'expense', level: 'detail' },
];

const budget = (over: Partial<Budget> & { id: string; categoryId: string }): Budget => ({
  amount: 500,
  period: 'monthly',
  isActive: true,
  createdAt: new Date(2026, 0, 1),
  updatedAt: new Date(2026, 0, 1),
  spent: 0,
  ...over,
});

const row = (over: Partial<Transaction> & { id: string; date: Date; amount: number }): Transaction => ({
  description: 'A row',
  type: over.amount < 0 ? 'expense' : 'income',
  accountId: 'acc-gbp',
  category: 'cat-groceries',
  cleared: false,
  ...over,
} as Transaction);

describe('evaluateBudgets — the window is the budget’s own, not a rolling month', () => {
  const monthly = budget({ id: 'b-groceries', categoryId: 'cat-groceries' });

  it('counts the whole calendar month, including days more than thirty ago', () => {
    const transactions = [
      row({ id: 'first-of-month', date: new Date(2026, 9, 1), amount: -120 }),
      row({ id: 'yesterday', date: new Date(2026, 9, 14), amount: -80 }),
    ];

    const [result] = evaluateBudgets([monthly], { transactions, categories, now: NOW });

    expect(result.spent.toNumber()).toBe(200);
    expect(result.window.label).toBe('Monthly');
    expect(result.window.start).toEqual(new Date(2026, 9, 1, 0, 0, 0, 0));
    expect(result.window.end).toEqual(new Date(2026, 9, 31, 23, 59, 59, 999));
  });

  it('leaves last month out, however recent — the Dashboard’s old thirty days took it', () => {
    const transactions = [
      row({ id: 'late-september', date: new Date(2026, 8, 28), amount: -300 }),
      row({ id: 'this-month', date: new Date(2026, 9, 3), amount: -50 }),
    ];

    const [result] = evaluateBudgets([monthly], { transactions, categories, now: NOW });

    expect(result.spent.toNumber()).toBe(50);
    expect(Array.from(result.countedRowIds)).toEqual(['this-month']);
  });

  it('names exactly the rows it summed, split lines by their own id', () => {
    const transactions = [
      row({ id: 'shop', date: new Date(2026, 9, 5), amount: -100, category: '' , isSplit: true }),
      row({ id: 'fuel', date: new Date(2026, 9, 6), amount: -40, category: 'cat-fuel' }),
    ];
    const splits: TransactionSplit[] = [
      { id: 's1', transactionId: 'shop', category: 'cat-groceries', amount: -70, sortOrder: 0 },
      { id: 's2', transactionId: 'shop', category: 'cat-fuel', amount: -30, sortOrder: 1 },
    ];
    const expanded = expandSplitTransactions(transactions, splits);
    const groceriesLine = expanded.find(r => r.isSplitLine && r.category === 'cat-groceries');
    expect(groceriesLine).toBeDefined();

    const [result] = evaluateBudgets([monthly], { transactions, transactionSplits: splits, categories, now: NOW });

    expect(result.spent.toNumber()).toBe(70);
    expect(Array.from(result.countedRowIds)).toEqual([groceriesLine!.id]);
  });

  it('nets a refund off the spend', () => {
    const transactions = [
      row({ id: 'spend', date: new Date(2026, 9, 2), amount: -90 }),
      row({ id: 'refund', date: new Date(2026, 9, 9), amount: 30, type: 'income' }),
    ];

    const [result] = evaluateBudgets([monthly], { transactions, categories, now: NOW });

    expect(result.spent.toNumber()).toBe(60);
    expect(result.countedRowIds.size).toBe(2);
  });
});

describe('evaluateBudgets — what the Budget page always did, now shared', () => {
  it('rolls a group budget’s children up, and nothing outside the group', () => {
    const group = budget({ id: 'b-food', categoryId: 'cat-food', amount: 1000 });
    const transactions = [
      row({ id: 'g', date: new Date(2026, 9, 2), amount: -100, category: 'cat-groceries' }),
      row({ id: 'e', date: new Date(2026, 9, 3), amount: -60, category: 'cat-eating-out' }),
      row({ id: 'f', date: new Date(2026, 9, 4), amount: -40, category: 'cat-fuel' }),
    ];

    const [result] = evaluateBudgets([group], { transactions, categories, now: NOW });

    expect(result.spent.toNumber()).toBe(160);
    expect(result.countedRowIds).toEqual(new Set(['g', 'e']));
  });

  it('heals a budget saved with the category NAME where the id belongs', () => {
    const legacy = budget({ id: 'b-legacy', categoryId: 'Groceries' });
    const transactions = [row({ id: 'g', date: new Date(2026, 9, 2), amount: -25 })];

    const [result] = evaluateBudgets([legacy], { transactions, categories, now: NOW });

    expect(result.categoryId).toBe('cat-groceries');
    expect(result.spent.toNumber()).toBe(25);
  });

  it('leaves an unknown id alone rather than guessing', () => {
    const resolve = buildBudgetCategoryResolver(categories);
    expect(resolve({ categoryId: 'cat-nowhere' })).toBe('cat-nowhere');
  });


  it('leaves rows in another currency out, and says how many', () => {
    const monthly = budget({ id: 'b', categoryId: 'cat-groceries' });
    const transactions = [
      row({ id: 'gbp', date: new Date(2026, 9, 2), amount: -40 }),
      row({ id: 'eur', date: new Date(2026, 9, 2), amount: -40, accountId: 'acc-eur' }),
    ];

    const [result] = evaluateBudgets([monthly], {
      transactions, categories, now: NOW, foreignAccountIds: new Set(['acc-eur']),
    });

    expect(result.spent.toNumber()).toBe(40);
    expect(result.excludedForeignCount).toBe(1);
    expect(Array.from(result.countedRowIds)).toEqual(['gbp']);
  });

  it('keeps the budgets in the order given', () => {
    const a = budget({ id: 'a', categoryId: 'cat-fuel' });
    const b = budget({ id: 'b', categoryId: 'cat-groceries' });

    expect(evaluateBudgets([b, a], { transactions: [], categories, now: NOW }).map(r => r.budget.id)).toEqual(['b', 'a']);
  });
});

/**
 * THE CARRY IS DERIVED (7 Nov 2026, the owner's "3"). A budget's mode says
 * what the end of a cycle does; the carry into the window is worked out from
 * the cycles before it, never stored. Every figure is invented.
 */
describe('evaluateBudgets — a carry from the cycles before, under the budget’s own mode', () => {
  // Anchored on 1 September 2026, measured in October: one cycle before. An
  // untouched cycle carries its whole allowance, so a chain test says so by
  // starting earlier.
  const from = { startDate: '2026-09-01', createdAt: new Date(2026, 10, 7) };
  const fromAugust = { startDate: '2026-08-01', createdAt: new Date(2026, 10, 7) };
  const september = (amount: number): Transaction => row({ id: `sep-${amount}`, date: new Date(2026, 8, 10), amount });
  const august = (amount: number): Transaction => row({ id: `aug-${amount}`, date: new Date(2026, 7, 10), amount });
  const thisMonth = row({ id: 'oct', date: new Date(2026, 9, 2), amount: -100 });

  it('under none — the default — the allowance is the plan, whatever last month left', () => {
    const plain = budget({ id: 'b', categoryId: 'cat-groceries', amount: 500, ...from });
    const [result] = evaluateBudgets([plain], { transactions: [september(-300), thisMonth], categories, now: NOW });

    expect(result.rolloverMode).toBe('none');
    expect(result.carriedIn.toNumber()).toBe(0);
    expect(result.effectiveAmount.toNumber()).toBe(500);
    // The cycle before is still named, so a card can say which it was.
    expect(result.carriedFrom?.start).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0));
  });

  it('surplus carries what last month left, and never an overspend', () => {
    const carries = budget({ id: 'b', categoryId: 'cat-groceries', amount: 500, rolloverMode: 'surplus', ...from });

    const [left] = evaluateBudgets([carries], { transactions: [september(-300), thisMonth], categories, now: NOW });
    expect(left.carriedIn.toNumber()).toBe(200);
    expect(left.effectiveAmount.toNumber()).toBe(700);
    expect(left.remaining.toNumber()).toBe(600);
    expect(left.carriedFrom?.end).toEqual(new Date(2026, 8, 30, 23, 59, 59, 999));

    const [over] = evaluateBudgets([carries], { transactions: [september(-650), thisMonth], categories, now: NOW });
    expect(over.carriedIn.toNumber()).toBe(0);
    expect(over.effectiveAmount.toNumber()).toBe(500);
  });

  it('overspend carries what last month went over by, and never a surplus', () => {
    const owes = budget({ id: 'b', categoryId: 'cat-groceries', amount: 500, rolloverMode: 'overspend', ...from });

    const [over] = evaluateBudgets([owes], { transactions: [september(-650), thisMonth], categories, now: NOW });
    expect(over.carriedIn.toNumber()).toBe(-150);
    expect(over.effectiveAmount.toNumber()).toBe(350);
    expect(over.remaining.toNumber()).toBe(250);
    expect(over.percentage).toBeCloseTo(28.57, 2);

    const [left] = evaluateBudgets([owes], { transactions: [september(-300), thisMonth], categories, now: NOW });
    expect(left.carriedIn.toNumber()).toBe(0);
  });

  it('both carries either way, and the cycles chain: August’s surplus funds September', () => {
    const both = budget({ id: 'b', categoryId: 'cat-groceries', amount: 500, rolloverMode: 'both', ...fromAugust });
    // August: 500 − 400 = 100 left. September: 500 + 100 − 650 = −50 over.
    const transactions = [august(-400), september(-650), thisMonth];

    const [result] = evaluateBudgets([both], { transactions, categories, now: NOW });
    expect(result.carriedIn.toNumber()).toBe(-50);
    expect(result.effectiveAmount.toNumber()).toBe(450);

    // Under surplus the same months hand nothing on: September's −50 is not kept.
    const surplus = budget({ id: 'b', categoryId: 'cat-groceries', amount: 500, rolloverMode: 'surplus', ...fromAugust });
    const [kept] = evaluateBudgets([surplus], { transactions, categories, now: NOW });
    expect(kept.carriedIn.toNumber()).toBe(0);
  });

  it('a first cycle carries nothing in, and names no cycle before', () => {
    const fresh = budget({ id: 'b', categoryId: 'cat-groceries', amount: 500, rolloverMode: 'both', startDate: '2026-10-01', createdAt: new Date(2026, 10, 7) });
    const [result] = evaluateBudgets([fresh], { transactions: [september(-300), thisMonth], categories, now: NOW });

    expect(result.carriedIn.toNumber()).toBe(0);
    expect(result.carriedFrom).toBeNull();
    expect(result.effectiveAmount.toNumber()).toBe(500);
  });

  it('a group budget carries what its children left', () => {
    const food = budget({ id: 'b', categoryId: 'cat-food', amount: 500, rolloverMode: 'surplus', ...from });
    const transactions = [
      row({ id: 'sep-g', date: new Date(2026, 8, 10), amount: -200, category: 'cat-groceries' }),
      row({ id: 'sep-e', date: new Date(2026, 8, 12), amount: -100, category: 'cat-eating-out' }),
      thisMonth,
    ];
    const [result] = evaluateBudgets([food], { transactions, categories, now: NOW });
    expect(result.carriedIn.toNumber()).toBe(200);
  });

  it('a yearly budget carries a year — what last year left — and a row in another currency is left out of it', () => {
    const yearly = budget({ id: 'b', categoryId: 'cat-groceries', amount: 6000, period: 'yearly', rolloverMode: 'surplus', startDate: '2025-10-01', createdAt: new Date(2026, 10, 7) });
    const transactions = [
      row({ id: 'last-year', date: new Date(2026, 2, 10), amount: -5000 }),
      row({ id: 'last-year-eur', date: new Date(2026, 2, 11), amount: -900, accountId: 'acc-eur' }),
      thisMonth,
    ];
    const [result] = evaluateBudgets([yearly], {
      transactions, categories, now: NOW, foreignAccountIds: new Set(['acc-eur']),
    });
    expect(result.carriedIn.toNumber()).toBe(1000);
    expect(result.carriedFrom?.start).toEqual(new Date(2025, 9, 1, 0, 0, 0, 0));
    expect(result.effectiveAmount.toNumber()).toBe(7000);
  });

  it('a legacy row keeping the calendar carries from the month it was written, not before', () => {
    // Start = creation day, created before the model: the first cycle is
    // August; July's spending is before the budget and does not count.
    const legacy = budget({ id: 'b', categoryId: 'cat-groceries', amount: 500, rolloverMode: 'both', startDate: '2026-08-20', createdAt: new Date('2026-08-20T09:00:00.000Z') });
    const transactions = [
      row({ id: 'jul', date: new Date(2026, 6, 10), amount: -900 }),
      august(-400), september(-450), thisMonth,
    ];
    const [result] = evaluateBudgets([legacy], { transactions, categories, now: NOW });
    expect(result.carriedIn.toNumber()).toBe(150);
  });
});
