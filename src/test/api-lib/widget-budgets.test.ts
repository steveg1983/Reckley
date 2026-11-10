import { describe, it, expect } from 'vitest';
import {
  describeBudgetsForWidget,
  usableTimeZone,
  wallClockIn,
  widgetSettingsFrom,
  type WidgetSettings,
} from '../../../api/_lib/widget-budgets';
import { evaluateBudgets } from '../../utils/budgetEvaluation';
import type { Budget, Category, Transaction } from '../../types';

/**
 * WHAT A WIDGET IS TOLD — the document a home-screen widget draws from.
 * The figures come from the app's own evaluation, run for real here; these
 * specs are about what is said of them, and above all what is NOT sent.
 * Every amount is invented (public repo).
 */

const NOW = new Date(2026, 9, 15, 12, 0, 0); // 15 October 2026, local
const INSTANT = new Date('2026-10-15T11:00:00.000Z');

const categoryList: Category[] = [
  { id: 'cat-groceries', name: 'Groceries', type: 'expense', level: 'detail' },
  { id: 'cat-fuel', name: 'Fuel', type: 'expense', level: 'detail' },
  { id: 'cat-fun', name: 'Fun', type: 'expense', level: 'detail' },
];
const categories = new Map(categoryList.map(category => [category.id, category]));

const budget = (over: Partial<Budget> & { id: string; categoryId: string }): Budget => ({
  amount: 500,
  period: 'monthly',
  isActive: true,
  createdAt: new Date(2026, 0, 1),
  updatedAt: new Date(2026, 0, 1),
  spent: 0,
  ...over,
});

const spend = (id: string, category: string, amount: number): Transaction => ({
  id,
  date: new Date(2026, 9, 3),
  amount: -amount,
  description: 'A row',
  type: 'expense',
  accountId: 'acc-gbp',
  category,
  cleared: false,
} as Transaction);

const budgets = [
  budget({ id: 'b-groceries', categoryId: 'cat-groceries', name: 'Groceries' }),
  budget({ id: 'b-fuel', categoryId: 'cat-fuel', name: 'Fuel', amount: 200 }),
  budget({ id: 'b-fun', categoryId: 'cat-fun', name: 'Fun', amount: 100 }),
];
const transactions = [
  spend('t1', 'cat-groceries', 123), // 24.6 % — nothing to say
  spend('t2', 'cat-fuel', 185), //      92.5 % — near
  spend('t3', 'cat-fun', 112), //       over by 12
];

const settings = (over: Partial<WidgetSettings> = {}): WidgetSettings => ({
  display: 'amounts',
  hideWhenLocked: false,
  keyBudgetIds: [],
  locale: 'en-GB',
  ...over,
});

const describeWith = (over: Partial<WidgetSettings> = {}) =>
  describeBudgetsForWidget({
    evaluated: evaluateBudgets(budgets, { transactions, categories: categoryList, now: NOW, budgets }),
    activeCount: budgets.length,
    currency: 'GBP',
    categories,
    settings: settings(over),
    today: NOW,
    instant: INSTANT,
  });

describe('describeBudgetsForWidget — amounts', () => {
  it('says each budget in words, in whole pounds, with the bar’s number beside it', () => {
    const document = describeWith();
    const groceries = document.budgets.find(b => b.id === 'b-groceries');
    expect(groceries).toMatchObject({
      name: 'Groceries',
      percent: 24.6,
      attention: 'none',
      status: '£377 left',
      spent: '£123',
      allowance: '£500',
      period: 'Monthly',
      until: '2026-10-31',
      daysLeft: 17, // the 15th to the 31st, today included
    });
    // £377 over 17 days.
    expect(groceries?.perDay).toBe('£22 a day');
  });

  it('marks a budget near its limit, and one over it — and an overspend has no "a day"', () => {
    const document = describeWith();
    expect(document.budgets.find(b => b.id === 'b-fuel')).toMatchObject({ attention: 'near', status: '£15 left' });
    const fun = document.budgets.find(b => b.id === 'b-fun');
    expect(fun).toMatchObject({ attention: 'over', status: 'Over by £12', percent: 112 });
    expect(fun?.perDay).toBeUndefined();
  });

  it('a budget’s own alert threshold decides "near", not the default', () => {
    const cautious = [budget({ id: 'b-groceries', categoryId: 'cat-groceries', alertThreshold: 20 })];
    const document = describeBudgetsForWidget({
      evaluated: evaluateBudgets(cautious, { transactions, categories: categoryList, now: NOW, budgets: cautious }),
      activeCount: 1,
      currency: 'GBP',
      categories,
      settings: settings(),
      today: NOW,
      instant: INSTANT,
    });
    expect(document.budgets[0].attention).toBe('near');
  });

  it('formats in the region the person chose', () => {
    const document = describeWith({ locale: 'de-DE' });
    // German puts the symbol after, with a no-break space.
    expect(document.budgets.find(b => b.id === 'b-groceries')?.allowance).toMatch(/^500\s£$/);
  });
});

describe('describeBudgetsForWidget — percentages only', () => {
  it('sends NO amount: the fields are absent, and no figure of money is anywhere in the document', () => {
    const document = describeWith({ display: 'percent' });
    for (const entry of document.budgets) {
      expect(entry).not.toHaveProperty('spent');
      expect(entry).not.toHaveProperty('allowance');
      expect(entry).not.toHaveProperty('perDay');
    }
    const text = JSON.stringify(document);
    expect(text).not.toContain('£');
    // The amounts these budgets hold, as any formatter would print them.
    for (const figure of ['123', '377', '500', '185', '200']) {
      expect(text).not.toContain(figure);
    }
    expect(document.display).toBe('percent');
  });

  it('still says where each budget stands', () => {
    const document = describeWith({ display: 'percent' });
    expect(document.budgets.find(b => b.id === 'b-groceries')?.status).toBe('25% used');
    expect(document.budgets.find(b => b.id === 'b-fun')?.status).toBe('Over by 12%');
  });
});

describe('describeBudgetsForWidget — order and the empty states', () => {
  it('puts the Key Budgets first, in the person’s order, and flags them', () => {
    const document = describeWith({ keyBudgetIds: ['b-fun', 'b-groceries', 'b-gone'] });
    expect(document.budgets.map(b => [b.id, b.key])).toEqual([
      ['b-fun', true],
      ['b-groceries', true],
      ['b-fuel', false],
    ]);
  });

  it('tells "no budgets at all" from "none running today"', () => {
    const empty = (activeCount: number) =>
      describeBudgetsForWidget({
        evaluated: [],
        activeCount,
        currency: 'GBP',
        categories,
        settings: settings(),
        today: NOW,
        instant: INSTANT,
      });
    expect(empty(0)).toMatchObject({ hasBudgets: false, budgets: [] });
    expect(empty(2)).toMatchObject({ hasBudgets: true, budgets: [] });
  });

  it('stamps the real instant and carries the lock-screen choice', () => {
    const document = describeWith({ hideWhenLocked: true });
    expect(document.asOf).toBe('2026-10-15T11:00:00.000Z');
    expect(document.hideWhenLocked).toBe(true);
    expect(document.v).toBe(1);
  });
});

describe('widgetSettingsFrom — a preferences document is strings someone else wrote', () => {
  it('defaults to amounts, shown when locked, no Key Budgets, UK English', () => {
    expect(widgetSettingsFrom(undefined)).toEqual({
      display: 'amounts',
      hideWhenLocked: false,
      keyBudgetIds: [],
      locale: 'en-GB',
    });
  });

  it('reads the stored choices', () => {
    expect(
      widgetSettingsFrom({
        widgetDisplay: 'percent',
        widgetHideWhenLocked: 'true',
        dashboardKeyBudgets: '["a","b"]',
        preferredLocale: 'en-US',
      })
    ).toEqual({ display: 'percent', hideWhenLocked: true, keyBudgetIds: ['a', 'b'], locale: 'en-US' });
  });

  it('survives values that are not what they should be', () => {
    expect(
      widgetSettingsFrom({
        widgetDisplay: 'everything',
        widgetHideWhenLocked: 'yes',
        dashboardKeyBudgets: '{not json',
        preferredLocale: 'not a locale!',
      })
    ).toEqual({ display: 'amounts', hideWhenLocked: false, keyBudgetIds: [], locale: 'en-GB' });
    expect(widgetSettingsFrom({ dashboardKeyBudgets: '["a",7,null]' }).keyBudgetIds).toEqual(['a']);
  });
});

describe('wallClockIn — whose today', () => {
  it('is the person’s calendar day, not UTC’s, in the hour a monthly budget turns over', () => {
    // 23:30 UTC on 30 September is 00:30 on 1 October in a British summer.
    const instant = new Date('2026-09-30T23:30:00.000Z');
    const london = wallClockIn('Europe/London', instant);
    expect([london.getFullYear(), london.getMonth(), london.getDate(), london.getHours(), london.getMinutes()]).toEqual([
      2026, 9, 1, 0, 30,
    ]);
    const utc = wallClockIn('UTC', instant);
    expect([utc.getMonth(), utc.getDate(), utc.getHours()]).toEqual([8, 30, 23]);
  });

  it('follows a zone far from Greenwich', () => {
    const auckland = wallClockIn('Pacific/Auckland', new Date('2026-01-01T12:00:00.000Z'));
    expect([auckland.getDate(), auckland.getHours()]).toEqual([2, 1]);
  });

  it('a zone it does not know is London, not a crash', () => {
    expect(usableTimeZone('Europe/Paris')).toBe('Europe/Paris');
    expect(usableTimeZone('Mars/Olympus')).toBe('Europe/London');
    expect(usableTimeZone(undefined)).toBe('Europe/London');
    expect(usableTimeZone('x'.repeat(200))).toBe('Europe/London');
  });
});
