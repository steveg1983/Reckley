/**
 * A LONG BUDGET READ THREE WAYS.
 *
 * The owner's ruling (10 Nov 2026) in his own example: a yearly budget that
 * started in October, read in November, is measured against two calendar
 * months' worth — 2/12 of the year — and never by days. These specs hold that
 * arithmetic, the months stepping from the budget's own first day, and the
 * budgets that are left as their whole period whatever is chosen.
 *
 * Every amount here is invented.
 */

import { describe, it, expect } from 'vitest';
import { evaluateBudgets } from './budgetEvaluation';
import { budgetMonthSteps, measureBudget, parseBudgetView, DEFAULT_BUDGET_VIEW } from './budgetView';
import { getBudgetPeriodWindow } from './budgetPeriods';
import type { Budget, Category, Transaction } from '../types';

const categories: Category[] = [{ id: 'cat-fuel', name: 'Fuel', type: 'expense', level: 'detail' }];

const budget = (over: Partial<Budget> = {}): Budget => ({
  id: 'b-fuel',
  categoryId: 'cat-fuel',
  amount: 1200,
  period: 'yearly',
  startDate: '2026-10-01',
  isActive: true,
  // Written after the cycle model shipped, so the start is a chosen anchor
  // and not a legacy row keeping the calendar year (utils/budgetPeriods).
  createdAt: new Date(2026, 10, 7),
  updatedAt: new Date(2026, 10, 7),
  spent: 0,
  ...over,
});

const row = (id: string, date: Date, amount: number): Transaction => ({
  id,
  date,
  amount,
  description: 'A row',
  type: amount < 0 ? 'expense' : 'income',
  accountId: 'acc',
  category: 'cat-fuel',
  cleared: false,
} as Transaction);

const transactions = [
  row('oct', new Date(2026, 9, 12), -150),
  row('nov-early', new Date(2026, 10, 3), -40),
  row('nov-refund', new Date(2026, 10, 5), 10),
  row('nov-late', new Date(2026, 10, 28), -20),
];

const evaluate = (b: Budget, now: Date) => evaluateBudgets([b], { transactions, categories, now })[0];

describe('the owner’s example: started in October, read in November', () => {
  const now = new Date(2026, 10, 10, 12);
  const result = evaluate(budget(), now);

  it('is two months of twelve — the month counts from the day it begins', () => {
    expect(result.months).toMatchObject({ total: 12, elapsed: 2 });
    expect(result.months?.currentStart).toEqual(new Date(2026, 10, 1));
    expect(result.months?.currentEnd).toEqual(new Date(2026, 10, 30, 23, 59, 59, 999));
  });

  it('to date: 2/12 of the year against everything spent so far', () => {
    const measure = measureBudget(result, 'toDate');
    expect(measure.view).toBe('toDate');
    expect(measure.allowance.toNumber()).toBe(200);
    // The whole of November counts, the row dated after today included: the
    // allowance is for the month, not for the days of it that have passed.
    expect(measure.spent.toNumber()).toBe(200);
    expect(measure.remaining.toNumber()).toBe(0);
    expect(measure.percentage).toBe(100);
    expect(measure.months).toEqual({ elapsed: 2, total: 12 });
    expect(measure.start).toEqual(result.window.start);
    expect([...measure.rowIds].sort()).toEqual(['nov-early', 'nov-late', 'nov-refund', 'oct']);
  });

  it('this month: one twelfth against November alone, refunds netted', () => {
    const measure = measureBudget(result, 'month');
    expect(measure.allowance.toNumber()).toBe(100);
    expect(measure.spent.toNumber()).toBe(50);
    expect(measure.remaining.toNumber()).toBe(50);
    expect([...measure.rowIds].sort()).toEqual(['nov-early', 'nov-late', 'nov-refund']);
    expect(measure.start).toEqual(new Date(2026, 10, 1));
  });

  it('whole period: exactly what the evaluation always said', () => {
    const measure = measureBudget(result, 'period');
    expect(measure.allowance.toNumber()).toBe(1200);
    expect(measure.spent.toNumber()).toBe(result.spent.toNumber());
    expect(measure.months).toBeNull();
    expect(measure.rowIds).toBe(result.countedRowIds);
  });

  it('is not by days: the 1st and the 30th of a month read the same share', () => {
    const first = measureBudget(evaluate(budget(), new Date(2026, 10, 1, 0, 0, 1)), 'toDate');
    const last = measureBudget(evaluate(budget(), new Date(2026, 10, 30, 23, 0)), 'toDate');
    expect(first.allowance.toNumber()).toBe(200);
    expect(last.allowance.toNumber()).toBe(200);
  });
});

describe('the ends of the year', () => {
  it('the first month is one twelfth', () => {
    const measure = measureBudget(evaluate(budget(), new Date(2026, 9, 2, 12)), 'toDate');
    expect(measure.months).toEqual({ elapsed: 1, total: 12 });
    expect(measure.allowance.toNumber()).toBe(100);
  });

  it('the last month is the whole allowance, to the penny', () => {
    const odd = budget({ amount: 1000 });
    const measure = measureBudget(evaluate(odd, new Date(2027, 8, 20, 12)), 'toDate');
    expect(measure.months).toEqual({ elapsed: 12, total: 12 });
    expect(measure.allowance.toNumber()).toBe(1000);
    expect(measureBudget(evaluate(odd, new Date(2026, 10, 10, 12)), 'toDate').allowance.toNumber()).toBe(166.67);
  });
});

describe('the months are the budget’s own', () => {
  it('a year that starts on the 15th is still twelve months, each 15th to 14th', () => {
    const mid = budget({ startDate: '2026-10-15' });
    const window = getBudgetPeriodWindow(mid, new Date(2026, 10, 14, 12));
    expect(budgetMonthSteps(window, new Date(2026, 10, 14, 12))).toMatchObject({ total: 12, elapsed: 1 });
    const second = budgetMonthSteps(window, new Date(2026, 10, 15, 12));
    expect(second).toMatchObject({ total: 12, elapsed: 2 });
    expect(second?.currentStart).toEqual(new Date(2026, 10, 15));
    expect(second?.currentEnd).toEqual(new Date(2026, 11, 14, 23, 59, 59, 999));
  });

  it('a quarter is three', () => {
    const quarterly = budget({ period: 'quarterly', amount: 300 });
    const result = evaluate(quarterly, new Date(2026, 10, 10, 12));
    expect(result.months).toMatchObject({ total: 3, elapsed: 2 });
    expect(measureBudget(result, 'month').allowance.toNumber()).toBe(100);
  });
});

describe('budgets left as their whole period, whatever is chosen', () => {
  const now = new Date(2026, 10, 10, 12);

  it('a monthly budget has nothing shorter to be read as', () => {
    const result = evaluate(budget({ period: 'monthly', amount: 100 }), now);
    expect(result.months).toBeNull();
    expect(measureBudget(result, 'toDate').view).toBe('period');
    expect(measureBudget(result, 'month').allowance.toNumber()).toBe(100);
  });

  it('six weeks is not two months', () => {
    const result = evaluate(budget({ period: 'every', repeatCount: 6, repeatUnit: 'week', amount: 120 }), now);
    expect(result.months).toBeNull();
    expect(measureBudget(result, 'toDate').allowance.toNumber()).toBe(120);
  });

  it('a budget paid in one go is a lump, not twelve shares', () => {
    const result = evaluate(budget({ paceShape: 'once' }), now);
    expect(result.months).toBeNull();
    expect(measureBudget(result, 'toDate').allowance.toNumber()).toBe(1200);
  });

  it('a budget that has not started is not read "so far"', () => {
    const result = evaluate(budget({ startDate: '2027-01-01' }), now);
    expect(result.window.notStarted).toBe(true);
    expect(result.months).toBeNull();
  });
});

describe('the stored choice', () => {
  it('reads the three views and nothing else', () => {
    expect(parseBudgetView('period')).toBe('period');
    expect(parseBudgetView('month')).toBe('month');
    expect(parseBudgetView('toDate')).toBe('toDate');
  });

  it('defaults to "to date" — the ruling — for an absent or odd value', () => {
    expect(DEFAULT_BUDGET_VIEW).toBe('toDate');
    expect(parseBudgetView(null)).toBe('toDate');
    expect(parseBudgetView('yearly')).toBe('toDate');
  });
});
