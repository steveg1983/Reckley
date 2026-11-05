/**
 * The budget wizard's arithmetic, pinned.
 *
 * What is guarded here is the difference between an empty box and a typed
 * zero, the twelve-complete-month window and its name, which categories can
 * carry a budget at all, and the rule that a write happens only where the
 * money changed. Every name and amount is invented: this repo is public.
 *
 * DATES ARE RELATIVE TO `new Date()`, never spelled out. The suite fixes its
 * own "now", so a hard-coded 2026 date can fall outside the window and read
 * every figure as zero — a fixture that lies rather than a test that fails.
 */

import { describe, it, expect } from 'vitest';
import {
  amountInMode,
  budgetHistoryWindow,
  budgetPeriodSuffix,
  describeAnchor,
  runFromDate,
  runFromOptions,
  buildWizardRows,
  entryInMode,
  groupWizardRows,
  indexExistingBudgets,
  isBudgetableCategory,
  monthlyEquivalent,
  planBudgetWrites,
  summariseForWizard,
  totalBudgeted,
  twinFigure,
  wizardBoxValue,
  wizardPeriodOf,
  type BudgetMode,
  type WizardEntries,
  type WizardRow,
} from './budgetWizardPlan';
import { toDecimal } from './decimal';
import type { Budget, Category, Transaction } from '../types';

const CATEGORIES: Category[] = [
  { id: 'type-expense', name: 'Expenses', type: 'expense', level: 'type' },
  { id: 'type-income', name: 'Income', type: 'income', level: 'type' },
  { id: 'grp-food', name: 'Food', type: 'expense', level: 'sub', parentId: 'type-expense' },
  { id: 'det-shop', name: 'Food Shopping', type: 'expense', level: 'detail', parentId: 'grp-food' },
  { id: 'det-dining', name: 'Dining Out', type: 'expense', level: 'detail', parentId: 'grp-food' },
  { id: 'det-quiet', name: 'Never Used', type: 'expense', level: 'detail', parentId: 'grp-food' },
  { id: 'grp-home', name: 'Household', type: 'expense', level: 'sub', parentId: 'type-expense' },
  { id: 'det-energy', name: 'Gas & Electricity', type: 'expense', level: 'detail', parentId: 'grp-home' },
  { id: 'det-pay', name: 'Net Pay', type: 'income', level: 'detail', parentId: 'type-income' },
  {
    id: 'det-move', name: 'Transfer Out', type: 'both', level: 'detail',
    parentId: 'type-expense', isTransferCategory: true,
  },
  {
    id: 'det-reval', name: 'Account Adjustment', type: 'expense', level: 'detail',
    parentId: 'type-expense', isRevaluationCategory: true,
  },
  {
    id: 'det-unfiled', name: 'Unassigned', type: 'expense', level: 'detail',
    parentId: 'type-expense', isUnassignedBucket: true,
  },
  { id: 'det-gone', name: 'Retired Category', type: 'expense', level: 'detail', parentId: 'grp-food', isActive: false },
];

/** The 10th of each of the twelve complete months before this one — inside the window by construction. */
const lastCompleteMonth = (): Date => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 0);
};

const monthlySpend = (prefix: string, category: string, amount: number): Transaction[] => {
  const anchor = lastCompleteMonth();
  return Array.from({ length: 12 }, (_, index) => ({
    id: `${prefix}-${index}`,
    accountId: 'acc-1',
    description: 'Synthetic row',
    amount: -amount,
    type: 'expense' as const,
    category,
    date: new Date(anchor.getFullYear(), anchor.getMonth() - index, 10),
  }));
};

const TRANSACTIONS: Transaction[] = [
  ...monthlySpend('shop', 'det-shop', 100),     // £1,200 a year
  ...monthlySpend('dine', 'det-dining', 50),    // £600 a year
  ...monthlySpend('energy', 'det-energy', 80),  // £960 a year
  // Kinds that are not expenditure, each £500 a month, none of which may land.
  ...monthlySpend('move', 'det-move', 500),
  ...monthlySpend('reval', 'det-reval', 500),
  ...monthlySpend('unfiled', 'det-unfiled', 500),
  ...monthlySpend('pay', 'det-pay', 500),
];

const budget = (over: Partial<Budget> & { id: string; categoryId: string }): Budget => ({
  amount: 100,
  period: 'monthly',
  isActive: true,
  spent: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

/**
 * The boxes of one screen, all typed in the same rhythm.
 *
 * An entry is a string AND the rhythm it was typed in, because a change of
 * rhythm converts what is in the boxes (owner, 2 Sep 2026) and the conversion
 * is made from the original figure every time — see the module header. Most of
 * this suite types in one rhythm and reads in the same one, which is what this
 * helper says; the tests that switch say so by passing the two apart.
 */
const typedIn = (typedAs: BudgetMode, boxes: Record<string, string>): WizardEntries =>
  Object.fromEntries(Object.entries(boxes).map(([id, value]) => [id, { value, typedAs }]));

const rowsFor = (budgets: Budget[] = []): WizardRow[] =>
  buildWizardRows(summariseForWizard(TRANSACTIONS, [], CATEGORIES, new Date()), CATEGORIES, budgets);

const rowFor = (rows: WizardRow[], id: string): WizardRow => {
  const found = rows.find(r => r.category.id === id);
  if (!found) throw new Error(`no row for ${id}`);
  return found;
};

describe('budgetHistoryWindow — twelve COMPLETE months', () => {
  it('ends on the last day of the month before this one', () => {
    const now = new Date();
    const window = budgetHistoryWindow(now);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    expect(window.to).toBe(
      `${endOfLastMonth.getFullYear()}-${String(endOfLastMonth.getMonth() + 1).padStart(2, '0')}-${String(endOfLastMonth.getDate()).padStart(2, '0')}`
    );
  });

  it('excludes the part-finished month even on its last day', () => {
    // 31 August is still inside August; the last COMPLETE month is July.
    const window = budgetHistoryWindow(new Date(2026, 7, 31));
    expect(window.from).toBe('2025-08-01');
    expect(window.to).toBe('2026-07-31');
  });

  it('starts on the first of the month eleven before that — exactly twelve months', () => {
    const window = budgetHistoryWindow(new Date(2026, 0, 15));
    expect(window.from).toBe('2025-01-01');
    expect(window.to).toBe('2025-12-31');
  });

  it('names the range in the house idiom rather than describing it', () => {
    expect(budgetHistoryWindow(new Date(2026, 7, 31)).label).toBe('Aug 2025 – Jul 2026');
  });

  it('crosses a year boundary without arithmetic drift', () => {
    const window = budgetHistoryWindow(new Date(2026, 2, 4));
    expect(window.from).toBe('2025-03-01');
    expect(window.to).toBe('2026-02-28');
    expect(window.label).toBe('Mar 2025 – Feb 2026');
  });
});

describe('budgetHistoryWindow — the measuring stick is a choice', () => {
  it('calendar-year is the last COMPLETE Jan–Dec, named with both ends', () => {
    const window = budgetHistoryWindow(new Date(2026, 8, 1), 'calendar-year');
    expect(window.from).toBe('2025-01-01');
    expect(window.to).toBe('2025-12-31');
    expect(window.label).toBe('Jan – Dec 2025');
  });

  it('tax-year runs 6 April to 5 April, and only a WHOLE one counts', () => {
    // 1 Sep 2026 is past 6 April, so 2025/26 is complete.
    const past = budgetHistoryWindow(new Date(2026, 8, 1), 'tax-year');
    expect(past.from).toBe('2025-04-06');
    expect(past.to).toBe('2026-04-05');
    // The 6th-to-5th boundary is named in full — month names alone would
    // print "Apr 2025 – Apr 2026" and look like an error.
    expect(past.label).toBe('6 Apr 2025 – 5 Apr 2026');
    // On 5 April the year ends TODAY and is not yet whole — the one before counts.
    const eve = budgetHistoryWindow(new Date(2026, 3, 5), 'tax-year');
    expect(eve.from).toBe('2024-04-06');
    expect(eve.to).toBe('2025-04-05');
  });

  it('the default is unchanged — twelve complete months', () => {
    const now = new Date(2026, 7, 31);
    expect(budgetHistoryWindow(now, 'full-months')).toEqual(budgetHistoryWindow(now));
  });

  it('every named window says it is twelve months', () => {
    const now = new Date(2026, 8, 1);
    for (const kind of ['full-months', 'calendar-year', 'tax-year'] as const) {
      expect(budgetHistoryWindow(now, kind).months).toBe(12);
    }
  });

  it('custom months are named like the default window, and counted', () => {
    const window = budgetHistoryWindow(new Date(2026, 8, 1), 'custom', { fromMonth: '2026-01', toMonth: '2026-06' });
    expect(window.from).toBe('2026-01-01');
    expect(window.to).toBe('2026-06-30');
    expect(window.label).toBe('Jan 2026 – Jun 2026');
    expect(window.months).toBe(6);
  });

  it('a custom window of one month has one name', () => {
    const window = budgetHistoryWindow(new Date(2026, 8, 1), 'custom', { fromMonth: '2026-06', toMonth: '2026-06' });
    expect(window.label).toBe('Jun 2026');
    expect(window.months).toBe(1);
  });

  it('custom with nothing chosen is the default window under another name', () => {
    const now = new Date(2026, 8, 1);
    expect(budgetHistoryWindow(now, 'custom')).toEqual(budgetHistoryWindow(now));
  });

  it('the summary is summed over the same window the header names', () => {
    // One source for the range — the label and the figures cannot describe
    // different windows, whichever measuring stick is chosen.
    const now = new Date(2026, 8, 1);
    const custom = { fromMonth: '2026-02', toMonth: '2026-07' };
    for (const kind of ['full-months', 'calendar-year', 'tax-year', 'custom'] as const) {
      const summary = summariseForWizard([], [], [], now, kind, custom);
      const window = budgetHistoryWindow(now, kind, custom);
      expect(summary.window.from).toBe(window.from);
      expect(summary.window.to).toBe(window.to);
      expect(summary.window.months).toBe(window.months);
    }
  });
});

describe('twinFigure — type one figure, see the other', () => {
  it('a monthly budget states its year', () => {
    expect(twinFigure(100, 'monthly').toString()).toBe('1200');
  });

  it('a yearly budget states its month, at two places', () => {
    expect(twinFigure(1000, 'yearly').toString()).toBe('83.33');
  });

  it('is Decimal throughout — 0.1 + 0.2 arithmetic never appears', () => {
    expect(twinFigure('0.07', 'monthly').toString()).toBe('0.84');
    expect(twinFigure('20.10', 'monthly').toString()).toBe('241.2');
  });

  it('converts a stored figure into the mode being typed', () => {
    expect(amountInMode(1200, 'yearly', 'monthly').toString()).toBe('100');
    expect(amountInMode(100, 'monthly', 'yearly').toString()).toBe('1200');
    expect(amountInMode(100, 'monthly', 'monthly').toString()).toBe('100');
  });

  it('measures every stored figure per month, the currency comparisons are made in', () => {
    expect(monthlyEquivalent(1200, 'yearly').toString()).toBe('100');
    expect(monthlyEquivalent(75, 'monthly').toString()).toBe('75');
  });
});

describe('which stored periods the wizard will express', () => {
  it('reads monthly and yearly, and a blank period as monthly', () => {
    expect(wizardPeriodOf('monthly')).toBe('monthly');
    expect(wizardPeriodOf('yearly')).toBe('yearly');
    expect(wizardPeriodOf('')).toBe('monthly');
    expect(wizardPeriodOf(undefined)).toBe('monthly');
  });

  it('refuses the periods it has no honest conversion for', () => {
    expect(wizardPeriodOf('weekly')).toBeNull();
    expect(wizardPeriodOf('quarterly')).toBeNull();
    expect(wizardPeriodOf('custom')).toBeNull();
  });

  it('suffixes an amount so a bare figure reads as a rate', () => {
    expect(budgetPeriodSuffix('monthly')).toBe('/mo');
    expect(budgetPeriodSuffix('yearly')).toBe('/yr');
    expect(budgetPeriodSuffix('weekly')).toBe('/wk');
    expect(budgetPeriodSuffix('custom')).toBe('');
  });
});

describe('which categories can carry a budget', () => {
  it('takes expense categories', () => {
    expect(isBudgetableCategory(CATEGORIES[3])).toBe(true);
  });

  it('leaves income out — v1 budgets what you spend', () => {
    expect(isBudgetableCategory(rowKind('det-pay'))).toBe(false);
  });

  it('leaves transfers out: moving money is not spending it', () => {
    expect(isBudgetableCategory(rowKind('det-move'))).toBe(false);
  });

  it('leaves the revaluation category out: a fund falling is not expenditure', () => {
    expect(isBudgetableCategory(rowKind('det-reval'))).toBe(false);
  });

  it("leaves the importer's unassigned bucket out: it is not a classification", () => {
    expect(isBudgetableCategory(rowKind('det-unfiled'))).toBe(false);
  });

  it('leaves a soft-deleted category out', () => {
    expect(isBudgetableCategory(rowKind('det-gone'))).toBe(false);
  });

  function rowKind(id: string): Category {
    const found = CATEGORIES.find(c => c.id === id);
    if (!found) throw new Error(`no category ${id}`);
    return found;
  }
});

describe('buildWizardRows — the grid', () => {
  it('gives a box to every detail category, spent in or not', () => {
    const ids = rowsFor().map(r => r.category.id);
    expect(ids).toContain('det-shop');
    expect(ids).toContain('det-quiet');
  });

  it('carries the history the reports would report', () => {
    const rows = rowsFor();
    expect(rowFor(rows, 'det-shop').annual.toString()).toBe('1200');
    expect(rowFor(rows, 'det-shop').monthly.toString()).toBe('100');
    expect(rowFor(rows, 'det-shop').rows).toBe(12);
  });

  it('shows nothing for a category with no spending, rather than omitting it', () => {
    const quiet = rowFor(rowsFor(), 'det-quiet');
    expect(quiet.annual.toString()).toBe('0');
    expect(quiet.rows).toBe(0);
  });

  it('excludes transfers, revaluations, the unassigned bucket and income entirely', () => {
    const ids = rowsFor().map(r => r.category.id);
    expect(ids).not.toContain('det-move');
    expect(ids).not.toContain('det-reval');
    expect(ids).not.toContain('det-unfiled');
    expect(ids).not.toContain('det-pay');
  });

  it('gives a parent group no box of its own — a budget is measured at the leaf', () => {
    expect(rowsFor().map(r => r.category.id)).not.toContain('grp-food');
  });

  it('DOES show a group that already has a budget, so it can be edited or removed', () => {
    const rows = rowsFor([budget({ id: 'b-grp', categoryId: 'grp-food', amount: 400 })]);
    expect(rows.map(r => r.category.id)).toContain('grp-food');
    expect(rowFor(rows, 'grp-food').existing?.id).toBe('b-grp');
  });

  it('pre-fills what is stored, keeping the period it is stored in', () => {
    const rows = rowsFor([budget({ id: 'b-1', categoryId: 'det-shop', amount: 1500, period: 'yearly' })]);
    const shop = rowFor(rows, 'det-shop');
    expect(shop.existing?.amount.toString()).toBe('1500');
    expect(shop.existing?.period).toBe('yearly');
  });

  it('ignores a deactivated budget rather than resurrecting it', () => {
    const rows = rowsFor([budget({ id: 'b-off', categoryId: 'det-shop', isActive: false })]);
    expect(rowFor(rows, 'det-shop').existing).toBeNull();
  });

  it('keeps one budget per category when the data holds two', () => {
    const index = indexExistingBudgets([
      budget({ id: 'b-first', categoryId: 'det-shop', amount: 10 }),
      budget({ id: 'b-second', categoryId: 'det-shop', amount: 20 }),
    ]);
    expect(index.get('det-shop')?.id).toBe('b-first');
  });
});

describe('groupWizardRows — arrangement', () => {
  it('files each row under its parent with a display-only roll-up', () => {
    const groups = groupWizardRows(rowsFor());
    const food = groups.find(g => g.name === 'Food');
    expect(food?.annual.toString()).toBe('1800'); // 1200 + 600 + 0
    expect(food?.monthly.toString()).toBe('150');
  });

  it('leads with the biggest spend, inside a group and between groups', () => {
    const groups = groupWizardRows(rowsFor());
    expect(groups.map(g => g.name)).toEqual(['Food', 'Household']);
    expect(groups[0].rows.map(r => r.category.name)).toEqual(['Food Shopping', 'Dining Out', 'Never Used']);
  });
});

describe('planBudgetWrites — empty is not zero', () => {
  it('writes a typed zero: "I intend to spend nothing here" is a real budget', () => {
    const plan = planBudgetWrites(rowsFor(), typedIn('monthly', { 'det-shop': '0' }), 'monthly');
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0].amount.toString()).toBe('0');
    expect(plan.upserts[0].period).toBe('monthly');
    expect(plan.budgetedCount).toBe(1);
  });

  it('writes nothing for an empty box that had no budget behind it', () => {
    const plan = planBudgetWrites(rowsFor(), typedIn('monthly', { 'det-shop': '' }), 'monthly');
    expect(plan.upserts).toHaveLength(0);
    expect(plan.removals).toHaveLength(0);
    expect(plan.budgetedCount).toBe(0);
  });

  it('REMOVES the budget behind a box somebody emptied', () => {
    const rows = rowsFor([budget({ id: 'b-1', categoryId: 'det-shop', amount: 120 })]);
    const plan = planBudgetWrites(rows, typedIn('monthly', { 'det-shop': '' }), 'monthly');
    expect(plan.removals).toEqual([
      { budgetId: 'b-1', categoryId: 'det-shop', categoryName: 'Food Shopping' },
    ]);
    expect(plan.upserts).toHaveLength(0);
    expect(plan.budgetedCount).toBe(0);
  });

  it('keeps a typed zero and an emptied box apart on the same screen', () => {
    const rows = rowsFor([
      budget({ id: 'b-1', categoryId: 'det-shop', amount: 120 }),
      budget({ id: 'b-2', categoryId: 'det-dining', amount: 60 }),
    ]);
    const plan = planBudgetWrites(rows, typedIn('monthly', { 'det-shop': '0', 'det-dining': '' }), 'monthly');
    expect(plan.upserts.map(u => u.categoryId)).toEqual(['det-shop']);
    expect(plan.upserts[0].amount.toString()).toBe('0');
    expect(plan.removals.map(r => r.categoryId)).toEqual(['det-dining']);
  });

  it('leaves an untouched box exactly as it was', () => {
    const rows = rowsFor([budget({ id: 'b-1', categoryId: 'det-shop', amount: 120 })]);
    const plan = planBudgetWrites(rows, {}, 'monthly');
    expect(plan.upserts).toHaveLength(0);
    expect(plan.removals).toHaveLength(0);
    // Still budgeted, and still counted: it exists after the apply.
    expect(plan.budgetedCount).toBe(1);
    expect(plan.monthlyTotal.toString()).toBe('120');
  });
});

describe('planBudgetWrites — what counts as a change', () => {
  it('creates where there was nothing, carrying no budget id', () => {
    const plan = planBudgetWrites(rowsFor(), typedIn('monthly', { 'det-shop': '95' }), 'monthly');
    expect(plan.upserts[0].budgetId).toBeUndefined();
    expect(plan.upserts[0].categoryId).toBe('det-shop');
  });

  it('edits where there was something, carrying its id', () => {
    const rows = rowsFor([budget({ id: 'b-1', categoryId: 'det-shop', amount: 120 })]);
    const plan = planBudgetWrites(rows, typedIn('monthly', { 'det-shop': '95' }), 'monthly');
    expect(plan.upserts[0].budgetId).toBe('b-1');
  });

  it('re-typing the figure already stored is not a write', () => {
    const rows = rowsFor([budget({ id: 'b-1', categoryId: 'det-shop', amount: 120 })]);
    const plan = planBudgetWrites(rows, typedIn('monthly', { 'det-shop': '120' }), 'monthly');
    expect(plan.upserts).toHaveLength(0);
    expect(plan.budgetedCount).toBe(1);
  });

  it('a yearly budget seen in monthly mode and left alone is not rewritten', () => {
    // £1,200/yr pre-fills the monthly box as £100. Agreeing with it changes no
    // money, so its stored period is not churned into 'monthly'.
    const rows = rowsFor([budget({ id: 'b-1', categoryId: 'det-shop', amount: 1200, period: 'yearly' })]);
    const plan = planBudgetWrites(rows, typedIn('monthly', { 'det-shop': '100' }), 'monthly');
    expect(plan.upserts).toHaveLength(0);
    expect(plan.monthlyTotal.toString()).toBe('100');
  });

  it('rewrites in the chosen mode once the money really changes', () => {
    const rows = rowsFor([budget({ id: 'b-1', categoryId: 'det-shop', amount: 1200, period: 'yearly' })]);
    const plan = planBudgetWrites(rows, typedIn('monthly', { 'det-shop': '110' }), 'monthly');
    expect(plan.upserts[0]).toMatchObject({ budgetId: 'b-1', period: 'monthly' });
    expect(plan.upserts[0].amount.toString()).toBe('110');
  });

  it('writes an annual figure as yearly when that is the chosen mode', () => {
    const plan = planBudgetWrites(rowsFor(), typedIn('yearly', { 'det-shop': '1500' }), 'yearly');
    expect(plan.upserts[0].period).toBe('yearly');
    expect(plan.upserts[0].amount.toString()).toBe('1500');
    expect(plan.upserts[0].monthly.toString()).toBe('125');
  });

  it('reads a figure typed with a currency symbol and separators', () => {
    const plan = planBudgetWrites(rowsFor(), typedIn('yearly', { 'det-shop': ' £1,250.50 ' }), 'yearly');
    expect(plan.upserts[0].amount.toString()).toBe('1250.5');
  });

  it('never guesses at a figure it cannot read — it reports the row', () => {
    const plan = planBudgetWrites(rowsFor(), typedIn('monthly', { 'det-shop': 'about a hundred' }), 'monthly');
    expect(plan.upserts).toHaveLength(0);
    expect(plan.rejections).toEqual([
      { categoryId: 'det-shop', categoryName: 'Food Shopping', raw: 'about a hundred' },
    ]);
  });

  it('refuses a negative budget rather than storing one', () => {
    const plan = planBudgetWrites(rowsFor(), typedIn('monthly', { 'det-shop': '-50' }), 'monthly');
    expect(plan.upserts).toHaveLength(0);
    expect(plan.rejections.map(r => r.categoryId)).toEqual(['det-shop']);
  });

  it('leaves a weekly budget alone: neither rewritten nor removed', () => {
    const rows = rowsFor([budget({ id: 'b-wk', categoryId: 'det-shop', amount: 30, period: 'weekly' })]);
    const plan = planBudgetWrites(rows, typedIn('monthly', { 'det-shop': '200' }), 'monthly');
    expect(plan.upserts).toHaveLength(0);
    expect(plan.removals).toHaveLength(0);
    // Counted, because it will still be there afterwards.
    expect(plan.budgetedCount).toBe(1);
  });
});

describe('planBudgetWrites — the totals step 3 states', () => {
  it('totals the month, the year and what those categories really cost', () => {
    const plan = planBudgetWrites(
      rowsFor(),
      typedIn('monthly', { 'det-shop': '90', 'det-dining': '40' }),
      'monthly'
    );
    expect(plan.budgetedCount).toBe(2);
    expect(plan.monthlyTotal.toString()).toBe('130');
    expect(plan.annualTotal.toString()).toBe('1560');
    expect(plan.spentTotal.toString()).toBe('1800'); // 1200 + 600
  });

  it('names a shortfall: budgets that allow less than the year cost', () => {
    const plan = planBudgetWrites(rowsFor(), typedIn('monthly', { 'det-shop': '90' }), 'monthly');
    expect(plan.difference.toString()).toBe('-120'); // 1080 budgeted vs 1200 spent
    expect(plan.difference.isNegative()).toBe(true);
  });

  it('names headroom: budgets that allow more than the year cost', () => {
    const plan = planBudgetWrites(rowsFor(), typedIn('monthly', { 'det-shop': '150' }), 'monthly');
    expect(plan.difference.toString()).toBe('600'); // 1800 budgeted vs 1200 spent
  });

  it('counts budgets left untouched in the totals, not just the ones being written', () => {
    const rows = rowsFor([budget({ id: 'b-1', categoryId: 'det-energy', amount: 80 })]);
    const plan = planBudgetWrites(rows, typedIn('monthly', { 'det-shop': '100' }), 'monthly');
    expect(plan.upserts).toHaveLength(1);
    expect(plan.budgetedCount).toBe(2);
    expect(plan.monthlyTotal.toString()).toBe('180');
  });

  it('excludes a removed budget from the totals it will not be part of', () => {
    const rows = rowsFor([
      budget({ id: 'b-1', categoryId: 'det-shop', amount: 100 }),
      budget({ id: 'b-2', categoryId: 'det-dining', amount: 50 }),
    ]);
    const plan = planBudgetWrites(rows, typedIn('monthly', { 'det-dining': '' }), 'monthly');
    expect(plan.budgetedCount).toBe(1);
    expect(plan.monthlyTotal.toString()).toBe('100');
    expect(plan.spentTotal.toString()).toBe('1200'); // Dining's £600 is not in it
  });
});

/**
 * THE RUNNING TOTALS — one sum, three places on screen.
 *
 * The scoreboard runs this over every row and each group heading runs it over
 * its own, which is what makes them add up (owner, 2 Sep 2026: "There should
 * be a total for each category grouping"). Pinned here rather than only
 * through the screen because the two rules worth breaking are arithmetic:
 * that an unfilled group has NO total rather than a total of zero, and that
 * the twin is divided once at the end rather than row by row.
 */
describe('totalBudgeted — the running totals', () => {
  it('has no total at all while every box is empty', () => {
    const total = totalBudgeted(rowsFor(), {}, 'monthly');
    expect(total.boxes).toBe(0);
    expect(total.typed.toString()).toBe('0');
  });

  it('adds the typed boxes, and says the year beside the month', () => {
    const total = totalBudgeted(rowsFor(), typedIn('monthly', { 'det-shop': '90', 'det-dining': '40.50' }), 'monthly');
    expect(total.boxes).toBe(2);
    expect(total.typed.toString()).toBe('130.5');
    expect(total.twin.toString()).toBe('1566');
  });

  it('counts a typed nought — a budget of nothing is a budget', () => {
    const total = totalBudgeted(rowsFor(), typedIn('monthly', { 'det-shop': '0' }), 'monthly');
    expect(total.boxes).toBe(1);
    expect(total.typed.toString()).toBe('0');
  });

  it('stops counting a box that was emptied', () => {
    const rows = rowsFor([budget({ id: 'b-1', categoryId: 'det-shop', amount: 120 })]);
    expect(totalBudgeted(rows, {}, 'monthly').typed.toString()).toBe('120');
    expect(totalBudgeted(rows, typedIn('monthly', { 'det-shop': '' }), 'monthly').boxes).toBe(0);
  });

  it('counts a stored budget nobody has touched, in the mode being typed', () => {
    const rows = rowsFor([budget({ id: 'b-1', categoryId: 'det-shop', amount: 1500, period: 'yearly' })]);
    expect(totalBudgeted(rows, {}, 'monthly').typed.toString()).toBe('125');
    expect(totalBudgeted(rows, {}, 'yearly').typed.toString()).toBe('1500');
  });

  it('leaves out a period it will not re-express, exactly as the write does', () => {
    const rows = rowsFor([budget({ id: 'b-wk', categoryId: 'det-shop', amount: 30, period: 'weekly' })]);
    const total = totalBudgeted(rows, {}, 'monthly');
    expect(total.boxes).toBe(0);
  });

  it('leaves out a figure that will not read as money rather than guessing at it', () => {
    const total = totalBudgeted(rowsFor(), typedIn('monthly', { 'det-shop': 'about a hundred', 'det-dining': '40' }), 'monthly');
    expect(total.boxes).toBe(1);
    expect(total.typed.toString()).toBe('40');
  });

  it('divides the twin ONCE, at the end — not row by row', () => {
    // Three £100 years. Divided per row that is 8.33 × 3 = £24.99; divided
    // once it is the £25.00 the year actually is, and the year is what the
    // write is measured in.
    const total = totalBudgeted(
      rowsFor(),
      typedIn('yearly', { 'det-shop': '100', 'det-dining': '100', 'det-energy': '100' }),
      'yearly'
    );
    expect(total.typed.toString()).toBe('300');
    expect(total.twin.toString()).toBe('25');
  });

  it('is the same sum over the groups as over the whole grid', () => {
    const rows = rowsFor();
    const entries = typedIn('monthly', { 'det-shop': '90', 'det-dining': '40.50', 'det-energy': '15' });
    const whole = totalBudgeted(rows, entries, 'monthly');
    const groups = groupWizardRows(rows).map(group => totalBudgeted(group.rows, entries, 'monthly'));

    const summed = groups.reduce((sum, group) => sum.plus(group.typed), toDecimal(0));
    expect(summed.toString()).toBe(whole.typed.toString());
    expect(groups.reduce((count, group) => count + group.boxes, 0)).toBe(whole.boxes);
  });
});

/**
 * A CHANGE OF RHYTHM CONVERTS WHAT WAS TYPED (owner, 2 Sep 2026: "Yes, it
 * should convert").
 *
 * Before this, a figure typed as £90 a month read £90 A YEAR after a trip
 * through step 1 — a considered decision turned into a twelfth of itself in
 * one press, silently. What is pinned here is the conversion AND the property
 * that makes it safe to do twice: it is taken from the figure that was
 * actually typed, never from the last conversion of it, so turning the screen
 * over and back is a lens rather than an edit and the original comes home
 * exactly. £100 a year is the case that proves it — £8.33 a month is not a
 * twelfth of anything that multiplies back to £100.
 */
describe('entryInMode — the rhythm converts, and round-trips', () => {
  const entry = (value: string, typedAs: BudgetMode): { value: string; typedAs: BudgetMode } =>
    ({ value, typedAs });

  it('gives back the string untouched in the rhythm it was typed in', () => {
    // Including the half-typed decimal point: a box re-spelled between
    // keystrokes cannot be typed in at all.
    expect(entryInMode(entry('12.', 'monthly'), 'monthly')).toBe('12.');
  });

  it('a month becomes its year, and a year its month, at two places', () => {
    expect(entryInMode(entry('90', 'monthly'), 'yearly')).toBe('1080');
    expect(entryInMode(entry('100', 'yearly'), 'monthly')).toBe('8.33');
  });

  it('ROUND-TRIPS: the original figure comes home, not a rounded one', () => {
    // The entry is never rewritten, so both directions are one conversion from
    // what was typed. Converting in place would leave £99.96 behind here.
    const monthly = entry('90', 'monthly');
    expect(entryInMode(monthly, 'yearly')).toBe('1080');
    expect(entryInMode(monthly, 'monthly')).toBe('90');

    const yearly = entry('100', 'yearly');
    expect(entryInMode(yearly, 'monthly')).toBe('8.33');
    expect(entryInMode(yearly, 'yearly')).toBe('100');
  });

  it('leaves an emptied box empty — that is a decision about the budget', () => {
    expect(entryInMode(entry('', 'monthly'), 'yearly')).toBe('');
  });

  it('never converts a figure it cannot read as money', () => {
    // Guessing at it once is already refused (step 3 names the row); guessing
    // at it and then multiplying the guess by twelve is worse.
    expect(entryInMode(entry('about a hundred', 'monthly'), 'yearly')).toBe('about a hundred');
  });

  it('carries the conversion into the totals and the write, not just the box', () => {
    // £90 a month, read on a screen that has been switched to years: the box
    // says £1,080, so the total says £1,080 and the budget written is £1,080 a
    // year. A write of 90 as a YEAR would be the whole bug this ruling names.
    const entries = typedIn('monthly', { 'det-shop': '90' });
    expect(wizardBoxValue(rowFor(rowsFor(), 'det-shop'), entries, 'yearly')).toBe('1080');
    expect(totalBudgeted(rowsFor(), entries, 'yearly').typed.toString()).toBe('1080');

    const plan = planBudgetWrites(rowsFor(), entries, 'yearly');
    expect(plan.upserts[0].amount.toString()).toBe('1080');
    expect(plan.upserts[0].period).toBe('yearly');
    expect(plan.upserts[0].monthly.toString()).toBe('90');
  });

  it('writes what the box SHOWS when the conversion had to round', () => {
    // £100 a year seen in monthly mode is £8.33 in the box. The write is that
    // £8.33 — the screen may not say one figure and store another, even when
    // the truer one is four pence away.
    const plan = planBudgetWrites(rowsFor(), typedIn('yearly', { 'det-shop': '100' }), 'monthly');
    expect(plan.upserts[0].amount.toString()).toBe('8.33');
    expect(plan.upserts[0].period).toBe('monthly');
  });
});

describe('wizardBoxValue — what a box holds', () => {
  it('gives back what was typed, exactly as typed', () => {
    const rows = rowsFor();
    expect(wizardBoxValue(rowFor(rows, 'det-shop'), typedIn('monthly', { 'det-shop': '90.5' }), 'monthly')).toBe('90.5');
  });

  it('falls back to the stored budget, in the mode being typed', () => {
    const rows = rowsFor([budget({ id: 'b-1', categoryId: 'det-shop', amount: 1500, period: 'yearly' })]);
    expect(wizardBoxValue(rowFor(rows, 'det-shop'), {}, 'monthly')).toBe('125');
  });

  it('is empty for a row the wizard will not re-express — nothing is being typed there', () => {
    const rows = rowsFor([budget({ id: 'b-wk', categoryId: 'det-shop', amount: 30, period: 'weekly' })]);
    expect(wizardBoxValue(rowFor(rows, 'det-shop'), {}, 'monthly')).toBe('');
  });
});

/**
 * "RUN THESE BUDGETS FROM" (owner, 5 Nov 2026) — the question the wizard
 * never asked. See the module header's section of the same name.
 */
describe('runFromOptions / runFromDate — the choices and the day each means', () => {
  it('offers this month, next month, the next calendar year and the next tax year, as dates', () => {
    const options = runFromOptions(new Date(2026, 10, 5));
    expect(options.map(o => [o.kind, o.date])).toEqual([
      ['this-month', '2026-11-01'],
      ['next-month', '2026-12-01'],
      ['next-calendar-year', '2027-01-01'],
      ['next-tax-year', '2027-04-06'],
    ]);
    // The choice AND the day it means, so it can be checked.
    expect(options[0].label).toBe('This month — 1 Nov 2026');
  });

  it('the next tax year is the next 6 April strictly after today', () => {
    expect(runFromDate('next-tax-year', new Date(2027, 2, 1), '')).toBe('2027-04-06');
    expect(runFromDate('next-tax-year', new Date(2027, 3, 5), '')).toBe('2027-04-06');
    expect(runFromDate('next-tax-year', new Date(2027, 3, 6), '')).toBe('2028-04-06');
  });

  it('next month crosses December into the next year', () => {
    expect(runFromDate('next-month', new Date(2026, 11, 20), '')).toBe('2027-01-01');
  });

  it('"another date" is the typed day, and nothing until a real one is typed', () => {
    expect(runFromDate('custom', new Date(2026, 10, 5), '2027-07-15')).toBe('2027-07-15');
    expect(runFromDate('custom', new Date(2026, 10, 5), '')).toBeNull();
    expect(runFromDate('custom', new Date(2026, 10, 5), '15/07/2027')).toBeNull();
  });
});

describe('planBudgetWrites — the chosen start', () => {
  /** A legacy row with a chosen 1 January: anchored there (see utils/budgetPeriods). */
  const fromJanuary = (over: Partial<Budget> & { id: string; categoryId: string }): Budget =>
    budget({ startDate: '2026-01-01', createdAt: new Date(2026, 7, 29), updatedAt: new Date(2026, 7, 29), ...over });

  it('goes on every row written', () => {
    const plan = planBudgetWrites(rowsFor(), typedIn('monthly', { 'det-shop': '95' }), 'monthly', { startDate: '2026-11-01' });
    expect(plan.upserts[0].startDate).toBe('2026-11-01');
    expect(plan.startDate).toBe('2026-11-01');
  });

  it('offers to move each budget left alone that runs from another day, naming where it runs from', () => {
    const rows = rowsFor([
      fromJanuary({ id: 'b-1', categoryId: 'det-shop', amount: 120 }),
      // No start ever chosen: a legacy row that keeps the calendar month.
      budget({ id: 'b-2', categoryId: 'det-dining', amount: 60 }),
    ]);
    const plan = planBudgetWrites(rows, {}, 'monthly', { startDate: '2026-11-01' });
    expect(plan.upserts).toHaveLength(0);
    expect(plan.redatable.map(r => [r.budgetId, r.categoryName, r.from]).sort()).toEqual([
      ['b-1', 'Food Shopping', '1 Jan 2026'],
      ['b-2', 'Dining Out', 'the calendar month'],
    ]);
  });

  it('describes a calendar-keeping yearly budget as the calendar year', () => {
    expect(describeAnchor({ anchor: null, period: 'yearly' })).toBe('the calendar year');
    expect(describeAnchor({ anchor: '2027-04-06', period: 'yearly' })).toBe('6 Apr 2027');
  });

  it('does not offer one that already runs from the chosen day', () => {
    const rows = rowsFor([fromJanuary({ id: 'b-1', categoryId: 'det-shop', amount: 120, startDate: '2026-11-01' })]);
    const plan = planBudgetWrites(rows, {}, 'monthly', { startDate: '2026-11-01' });
    expect(plan.redatable).toEqual([]);
  });

  it('re-typing the stored figure keeps the row out of the writes but in the offer', () => {
    const rows = rowsFor([budget({ id: 'b-1', categoryId: 'det-shop', amount: 120 })]);
    const plan = planBudgetWrites(rows, typedIn('monthly', { 'det-shop': '120' }), 'monthly', { startDate: '2026-11-01' });
    expect(plan.upserts).toHaveLength(0);
    expect(plan.redatable.map(r => r.budgetId)).toEqual(['b-1']);
  });

  it('a removal is not offered a re-date, and a changed figure is dated in its own write', () => {
    const rows = rowsFor([
      budget({ id: 'b-1', categoryId: 'det-shop', amount: 120 }),
      budget({ id: 'b-2', categoryId: 'det-dining', amount: 60 }),
    ]);
    const plan = planBudgetWrites(rows, typedIn('monthly', { 'det-shop': '', 'det-dining': '65' }), 'monthly', { startDate: '2026-11-01' });
    expect(plan.removals.map(r => r.budgetId)).toEqual(['b-1']);
    expect(plan.upserts.map(u => [u.budgetId, u.startDate])).toEqual([['b-2', '2026-11-01']]);
    expect(plan.redatable).toEqual([]);
  });

  it('with no day chosen there is nothing to offer and nothing is dated', () => {
    const rows = rowsFor([budget({ id: 'b-1', categoryId: 'det-shop', amount: 120 })]);
    const plan = planBudgetWrites(rows, typedIn('monthly', { 'det-dining': '50' }), 'monthly');
    expect(plan.startDate).toBeNull();
    expect(plan.redatable).toEqual([]);
    expect(plan.upserts[0].startDate).toBeUndefined();
  });
});
