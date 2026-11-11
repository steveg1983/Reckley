/**
 * SpendingAlerts Tests
 *
 * This tab used to read budgets from BudgetContext (a plaintext localStorage
 * mirror), so for a signed-in user it never raised anything. Now that it reads
 * the real budgets these tests pin the two faults that were waiting there: the
 * persisted alert shape that crashed on reload, and the category NAME being
 * compared against a category ID so every message named a raw UUID.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import SpendingAlerts from './SpendingAlerts';
import { formatCurrency as formatCurrencyDecimal } from '../utils/currency-decimal';
import { toDecimal } from '../utils/decimal';
import { preferences } from '../services/preferencesService';

const inCurrentMonth = (day: number): Date => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), day, 12, 0, 0);
};

const mockBudgets = [
  {
    id: 'budget-1',
    categoryId: 'cat-1',
    amount: 200,
    period: 'monthly' as const,
    isActive: true,
    spent: 0,
    createdAt: inCurrentMonth(1),
    updatedAt: inCurrentMonth(1)
  }
];

vi.mock('../contexts/AppContextSupabase', () => ({
  useApp: () => ({
    categories: [{ id: 'cat-1', name: 'Groceries', type: 'expense', level: 'detail' }],
    transactions: [
      {
        id: 'txn-1',
        accountId: 'acc-1',
        // Expenses are stored signed (negative): 190 of a 200 budget = 95%.
        amount: -190,
        type: 'expense',
        category: 'cat-1',
        date: inCurrentMonth(10),
        description: 'Weekly shop'
      }
    ],
    transactionSplits: [],
    budgets: mockBudgets
  })
}));

// Seeded per test so persisted-payload cases can be reproduced.
const mockStorageSeed: Record<string, unknown> = {};

vi.mock('../hooks/useLocalStorage', () => ({
  useLocalStorage: vi.fn((key: string, defaultValue: unknown) => {
    const seeded = Object.prototype.hasOwnProperty.call(mockStorageSeed, key);
    const [value, setValue] = React.useState(seeded ? mockStorageSeed[key] : defaultValue);
    return [value, setValue];
  })
}));

vi.mock('../hooks/useCurrencyDecimal', () => ({
  useCurrencyDecimal: () => ({
    formatCurrency: (value: number | { toNumber: () => number }) =>
      formatCurrencyDecimal(typeof value === 'number' ? value : value.toNumber(), 'USD')
  })
}));

const singleCriticalConfig = [
  {
    id: 'config-1',
    name: 'Budget Warning',
    enabled: true,
    thresholds: { warning: 75, critical: 90 },
    notificationTypes: { inApp: true, email: false, push: false },
    frequency: 'realtime',
    categories: [],
    sound: false,
    vibrate: false
  }
];

describe('SpendingAlerts', () => {
  beforeEach(() => {
    Object.keys(mockStorageSeed).forEach(key => delete mockStorageSeed[key]);
    mockStorageSeed['alert-configs'] = singleCriticalConfig;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('names the category rather than its raw ID', () => {
    render(<SpendingAlerts />);

    expect(screen.getByText(/Critical: Groceries has reached 95% of budget!/)).toBeInTheDocument();
    expect(screen.queryByText(/cat-1/)).not.toBeInTheDocument();
  });

  /**
   * THE ALERTS FOLLOW THE READING (owner, 11 Nov 2026). The panel used to set
   * one calendar month's spend against a yearly budget's WHOLE allowance, so
   * a year could spend twelve times its month before it warned.
   */
  describe('a yearly budget', () => {
    const monthly = mockBudgets[0];
    const now = new Date();
    const yearly = {
      ...monthly,
      amount: 2400,
      period: 'yearly' as const,
      startDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`,
      // Written after the cycle model shipped: the start is its anchor.
      createdAt: new Date(2026, 10, 7),
    };

    beforeEach(() => {
      mockBudgets[0] = yearly as typeof monthly;
    });

    afterEach(() => {
      mockBudgets[0] = monthly;
      preferences.removeItem('budgetView');
    });

    it('so far, by default: 190 of the first month\u2019s 200 is critical', () => {
      render(<SpendingAlerts />);
      expect(screen.getByText(/Critical: Groceries has reached 95% of budget!/)).toBeInTheDocument();
    });

    it('the whole period, when that is the choice: 190 of 2,400 raises nothing', () => {
      preferences.setItem('budgetView', 'period');
      render(<SpendingAlerts />);
      expect(screen.queryByText(/Groceries (has reached|is at)/)).not.toBeInTheDocument();
    });
  });

  it('resolves the most-alerted category to a name too', () => {
    render(<SpendingAlerts />);

    const summary = screen.getByText(/Most alerts in/);
    expect(summary).toHaveTextContent('Groceries');
  });

  it('revives persisted alerts without throwing on timestamps or amounts', () => {
    mockStorageSeed['spending-alerts'] = JSON.parse(JSON.stringify([
      {
        id: 'alert-1',
        configId: 'config-1',
        budgetId: 'budget-1',
        categoryId: 'cat-1',
        type: 'warning',
        percentage: 80,
        spent: 160,
        budget: 200,
        remaining: 40,
        message: 'Warning: Groceries is at 80% of budget',
        timestamp: inCurrentMonth(5).toISOString(),
        isRead: false,
        isDismissed: false
      }
    ]));

    expect(() => render(<SpendingAlerts />)).not.toThrow();

    // `.getTime()` on the revived timestamp is what the sort needs, and
    // `.greaterThan()` on the revived remaining is what the colour needs.
    expect(screen.getByText('Warning: Groceries is at 80% of budget')).toBeInTheDocument();
    expect(screen.getByText(/Remaining:/)).toBeInTheDocument();
  });

  it('discards pre-fix alerts that stored Decimals and a category name field', () => {
    // decimal.js serialises to a STRING through JSON, so `.greaterThan()` threw
    // and this tab crashed the first time it was reopened. Those alerts also
    // carry `category` instead of `categoryId` and a message naming a raw UUID,
    // so they are dropped — the sweep below raises a correctly-worded one.
    const legacyAlert = {
      id: 'legacy-1',
      configId: 'config-1',
      budgetId: 'budget-1',
      category: 'cat-1',
      type: 'warning',
      percentage: 80,
      spent: toDecimal(160),
      budget: toDecimal(200),
      remaining: toDecimal(40),
      message: 'Warning: cat-1 is at 80% of budget',
      timestamp: inCurrentMonth(5),
      isRead: false,
      isDismissed: false
    };
    const persisted = JSON.parse(JSON.stringify([legacyAlert]));
    expect(typeof persisted[0].spent).toBe('string');
    mockStorageSeed['spending-alerts'] = persisted;

    expect(() => render(<SpendingAlerts />)).not.toThrow();

    expect(screen.queryByText('Warning: cat-1 is at 80% of budget')).not.toBeInTheDocument();
    expect(screen.getByText(/Critical: Groceries has reached 95% of budget!/)).toBeInTheDocument();
  });

  it('mutes by category ID so the muted budget stops alerting', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    render(<SpendingAlerts />);

    await userEvent.click(screen.getByRole('button', { name: /Configure/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Groceries' }));
    await userEvent.click(screen.getByRole('button', { name: /Save Settings/i }));

    expect(screen.getByText('Muted Categories')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unmute Groceries' })).toBeInTheDocument();
  });
});
