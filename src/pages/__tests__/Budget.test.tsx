import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PreferencesProvider } from '../../contexts/PreferencesContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { NotificationProvider } from '../../contexts/NotificationContext';
import { __setAppContextValue, __resetAppContextValue } from '../../test/mocks/AppContextSupabase';
import Budget from '../Budget';
import type { Account, Budget as BudgetType, Category, Transaction, TransactionSplit } from '../../types';

/**
 * What a budget card says it has spent, and what it says is left.
 *
 * The rows are dated inside the CURRENT month, built from the app's own wire
 * shape: Postgres sends `date` as "2026-08-15", which the boundary
 * (utils/dateBoundary) turns into that instant — UTC midnight — before the page
 * ever sees it. Dating them relative to today keeps the test honest on any day
 * of any year without freezing the clock.
 *
 * The app context is the shared test double from src/test/setup.ts; every
 * figure and name here is synthetic (this repo is public).
 */

/**
 * The setup wizard, stubbed. It is a lazy chunk with a grid, twelve months of
 * aggregation and a confirm step of its own, all pinned by BudgetWizard.test —
 * what the block at the foot of this file tests is whether the PAGE opens it
 * when the address says to, which needs nothing of the real one but its shape.
 */
vi.mock('../../components/BudgetWizard', () => ({
  default: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? (
      <div data-testid="budget-wizard">
        <button type="button" onClick={onClose}>Close the wizard</button>
      </div>
    ) : null,
}));

const now = new Date();
/** The 10th of the current month, exactly as the wire would send it. */
const wireDate = (day: number): Date =>
  new Date(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);

const ACCOUNTS: Account[] = [
  { id: 'acc-1', name: 'Synthetic Current', type: 'current', balance: 0, currency: 'GBP', lastUpdated: now, openingBalance: 0 }
];

const CATEGORIES: Category[] = [
  { id: 'type-expense', name: 'Expenses', type: 'expense', level: 'type', isSystem: true },
  { id: 'grp-food', name: 'Food', type: 'expense', level: 'sub', parentId: 'type-expense' },
  { id: 'det-groceries', name: 'Groceries', type: 'expense', level: 'detail', parentId: 'grp-food' },
  { id: 'grp-home', name: 'Home', type: 'expense', level: 'sub', parentId: 'type-expense' },
  { id: 'det-household', name: 'Household', type: 'expense', level: 'detail', parentId: 'grp-home' }
];

const txn = (over: Partial<Transaction> & { id: string }): Transaction => ({
  date: wireDate(10),
  amount: -10,
  description: 'synthetic row',
  category: 'det-groceries',
  accountId: 'acc-1',
  type: 'expense',
  ...over
});

const budget = (over: Partial<BudgetType> & { id: string; categoryId: string; amount: number }): BudgetType => ({
  period: 'monthly',
  isActive: true,
  spent: 0,
  createdAt: new Date(now.getFullYear(), 0, 1),
  updatedAt: new Date(now.getFullYear(), 0, 1),
  ...over
});

/**
 * The page, opened at an address. Defaults to the plain one; the wizard's own
 * `?open=wizard` is the only caller that passes anything else (see the block at
 * the foot of this file).
 */
const renderBudget = (entry: string = '/budget'): void => {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <PreferencesProvider>
        <ToastProvider>
          {/* The page raises budget alerts through the notification context,
              exactly as it does inside the real provider stack. */}
          <NotificationProvider>
            <Budget />
          </NotificationProvider>
        </ToastProvider>
      </PreferencesProvider>
    </MemoryRouter>
  );
};

/** The card for a category, found by its heading. */
const card = (categoryName: string): HTMLElement => {
  const heading = screen.getByRole('heading', { level: 3, name: categoryName });
  const element = heading.closest('div.bg-white');
  if (!element) throw new Error(`No card rendered for ${categoryName}`);
  return element as HTMLElement;
};

describe('Budget page — what a card says has been spent', () => {
  afterEach(() => {
    __resetAppContextValue();
  });

  describe('a plain row and a split line, in one budget', () => {
    beforeEach(() => {
      const splitParent = txn({
        id: 't-split',
        amount: -100,
        isSplit: true,
        category: 'det-household',
        description: 'synthetic split shop'
      });
      const splits: TransactionSplit[] = [
        { id: 'sp-1', transactionId: 't-split', category: 'det-groceries', amount: -30, sortOrder: 0 },
        { id: 'sp-2', transactionId: 't-split', category: 'det-household', amount: -70, sortOrder: 1 }
      ];

      __setAppContextValue({
        accounts: ACCOUNTS,
        categories: CATEGORIES,
        transactions: [txn({ id: 't-1', amount: -40 }), splitParent],
        transactionSplits: splits,
        budgets: [budget({ id: 'bud-groceries', categoryId: 'det-groceries', amount: 200 })]
      });
    });

    it('counts the split line against the budget for the line’s own category', () => {
      renderBudget();

      // £40 plain + the £30 grocery line of the £100 split.
      expect(within(card('Groceries')).getByText('£70.00 of £200.00')).toBeInTheDocument();
      expect(within(card('Groceries')).getByText('£130.00 remaining')).toBeInTheDocument();
      expect(within(card('Groceries')).getByText('35% used')).toBeInTheDocument();
    });

    it('captions the card with the budget’s actual period and the days it covers', () => {
      renderBudget();
      const caption = within(card('Groceries')).getByText(/^Monthly ·/).textContent?.replace(/\s+/g, ' ') ?? '';
      // "Monthly · 1–30 Nov 2026": both ends of the month, which Intl folds
      // together where they share a month and year.
      expect(caption).toMatch(/^Monthly · 1(?: \w{3}(?: \d{4})?)?\s?–\s?\d{2} \w{3} \d{4}$/);
      expect(caption).toContain(now.toLocaleDateString('en-GB', { month: 'short' }));
    });

    it('says how far through the month it is, and how spending runs against that pace', () => {
      renderBudget();
      const groceries = within(card('Groceries'));
      expect(groceries.getByText(new RegExp(`^day ${now.getDate()} of \\d+$`))).toBeInTheDocument();
      // £70 of £200 spent; whether that is over or under the pace depends on
      // the day the suite runs, so only the SHAPE is pinned here. The arithmetic
      // is pinned in budgetPace.test.
      expect(groceries.getByText(/^(on pace|£\d+\.\d\d (over|under) the pace)$/)).toBeInTheDocument();
    });
  });

  describe('an overspent budget', () => {
    beforeEach(() => {
      __setAppContextValue({
        accounts: ACCOUNTS,
        categories: CATEGORIES,
        transactions: [txn({ id: 't-1', amount: -80 })],
        transactionSplits: [],
        budgets: [budget({ id: 'bud-groceries', categoryId: 'det-groceries', amount: 50 })]
      });
    });

    it('says how far over it is, instead of "£0.00 remaining"', () => {
      renderBudget();

      const groceries = within(card('Groceries'));
      expect(groceries.getByText('over budget by £30.00')).toBeInTheDocument();
      expect(groceries.queryByText(/remaining/)).not.toBeInTheDocument();
      // The percentage tells the truth past 100%…
      expect(groceries.getByText('160% used')).toBeInTheDocument();
      // …while the bar, which has nowhere further to go, stops at full.
      expect(groceries.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    });

    it('leaves the page total agreeing with the card', () => {
      renderBudget();

      // Total Remaining is the same overspend, not a floored zero.
      expect(screen.getByText('(£30.00)')).toBeInTheDocument();
    });
  });

  describe('a budget on a whole group', () => {
    beforeEach(() => {
      __setAppContextValue({
        accounts: ACCOUNTS,
        categories: CATEGORIES,
        transactions: [
          txn({ id: 't-1', amount: -40, category: 'det-groceries' }),
          txn({ id: 't-2', amount: -25, category: 'grp-food' }),
          txn({ id: 't-3', amount: -60, category: 'det-household' })
        ],
        transactionSplits: [],
        budgets: [budget({ id: 'bud-food', categoryId: 'grp-food', amount: 300 })]
      });
    });

    it('rolls the categories beneath the group up, and nothing outside it', () => {
      renderBudget();

      expect(within(card('Food')).getByText('£65.00 of £300.00')).toBeInTheDocument();
    });
  });

  /**
   * THE CYCLE MODEL (owner, 5 Nov 2026). A yearly budget runs twelve months
   * from its own start; one that starts in the future has not begun; and the
   * page's totals never add a month's allowance to a year's.
   */
  describe('budgets anchored on their own start', () => {
    const inThreeMonths = new Date(now.getFullYear(), now.getMonth() + 3, 1);
    const iso = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    beforeEach(() => {
      __setAppContextValue({
        accounts: ACCOUNTS,
        categories: CATEGORIES,
        transactions: [txn({ id: 't-1', amount: -40 }), txn({ id: 't-2', amount: -60, category: 'det-household' })],
        transactionSplits: [],
        budgets: [
          // Written after the model shipped, from the 1st of this month: a
          // year that began this month.
          budget({
            id: 'bud-groceries', categoryId: 'det-groceries', amount: 1200, period: 'yearly',
            startDate: iso(new Date(now.getFullYear(), now.getMonth(), 1)),
            createdAt: now, updatedAt: now
          }),
          // …and one that does not begin for three months.
          budget({
            id: 'bud-household', categoryId: 'det-household', amount: 600, period: 'yearly',
            startDate: iso(inThreeMonths), createdAt: now, updatedAt: now
          })
        ]
      });
    });

    it('measures a yearly budget over the year from its start, and says which year', () => {
      renderBudget();
      const groceries = within(card('Groceries'));
      expect(groceries.getByText('£40.00 of £1,200.00')).toBeInTheDocument();
      expect(groceries.getByText(/^0 of 12 months gone$/)).toBeInTheDocument();
      // "Yearly · 1 Nov 2026 – 31 Oct 2027", or "1 Jan – 31 Dec 2026" when the
      // year happens to be a calendar one and Intl folds the shared year.
      const caption = groceries.getByText(/^Yearly ·/).textContent?.replace(/\s+/g, ' ') ?? '';
      const monthAfter = new Date(now.getFullYear(), now.getMonth() + 12, 0);
      expect(caption).toMatch(new RegExp(`^Yearly · 1 ${now.toLocaleDateString('en-GB', { month: 'short' })}( ${now.getFullYear()})? – ${monthAfter.getDate()} ${monthAfter.toLocaleDateString('en-GB', { month: 'short' })} ${monthAfter.getFullYear()}$`));
    });

    it('a budget that has not started says when it starts, and draws no bar', () => {
      renderBudget();
      const household = within(card('Household'));
      expect(household.getByText(/^Starts 1 \w{3} \d{4} · £600\.00 for the year$/)).toBeInTheDocument();
      expect(household.queryByRole('progressbar')).not.toBeInTheDocument();
      expect(household.queryByText(/used/)).not.toBeInTheDocument();
    });

    it('totals one rhythm as itself, captioned', () => {
      renderBudget();
      expect(screen.getByText('£1,800.00')).toBeInTheDocument();
      expect(screen.getAllByText('Yearly budgets').length).toBe(3);
    });
  });

  describe('a page holding two rhythms', () => {
    beforeEach(() => {
      __setAppContextValue({
        accounts: ACCOUNTS,
        categories: CATEGORIES,
        transactions: [txn({ id: 't-1', amount: -40 })],
        transactionSplits: [],
        budgets: [
          budget({ id: 'bud-groceries', categoryId: 'det-groceries', amount: 200 }),
          budget({ id: 'bud-household', categoryId: 'det-household', amount: 2400, period: 'yearly' })
        ]
      });
    });

    it('never adds a month to a year — each rhythm is totalled on its own line', () => {
      renderBudget();
      expect(screen.queryByText('£2,600.00')).not.toBeInTheDocument();
      const budgeted = screen.getByText('Total Budgeted').closest('div') as HTMLElement;
      expect(within(budgeted).getByText('Monthly')).toBeInTheDocument();
      expect(within(budgeted).getByText('£200.00')).toBeInTheDocument();
      expect(within(budgeted).getByText('Yearly')).toBeInTheDocument();
      expect(within(budgeted).getByText('£2,400.00')).toBeInTheDocument();
    });
  });

  /**
   * ANY REPEAT INTERVAL (owner, 7 Nov 2026). Two intervals are two rhythms:
   * each is captioned by its interval and totalled on its own line.
   */
  describe('budgets that repeat every N weeks or months', () => {
    const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const iso = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    beforeEach(() => {
      __setAppContextValue({
        accounts: ACCOUNTS,
        categories: CATEGORIES,
        transactions: [txn({ id: 't-1', amount: -40 })],
        transactionSplits: [],
        budgets: [
          budget({
            id: 'bud-groceries', categoryId: 'det-groceries', amount: 200, period: 'every',
            repeatCount: 2, repeatUnit: 'month', startDate: iso(firstOfThisMonth), createdAt: now, updatedAt: now
          }),
          budget({
            id: 'bud-household', categoryId: 'det-household', amount: 120, period: 'every',
            repeatCount: 6, repeatUnit: 'week', startDate: iso(firstOfThisMonth), createdAt: now, updatedAt: now
          })
        ]
      });
    });

    it('captions each card by its interval, and counts this month’s spend in the interval begun this month', () => {
      renderBudget();
      const groceries = within(card('Groceries'));
      expect(groceries.getByText(/^Every 2 months ·/)).toBeInTheDocument();
      expect(groceries.getByText('£40.00 of £200.00')).toBeInTheDocument();
      expect(within(card('Household')).getByText(/^Every 6 weeks ·/)).toBeInTheDocument();
    });

    it('totals each interval on its own line — two intervals are two rhythms', () => {
      renderBudget();
      expect(screen.queryByText('£320.00')).not.toBeInTheDocument();
      const budgeted = screen.getByText('Total Budgeted').closest('div') as HTMLElement;
      expect(within(budgeted).getByText('Every 2 months')).toBeInTheDocument();
      expect(within(budgeted).getByText('£200.00')).toBeInTheDocument();
      expect(within(budgeted).getByText('Every 6 weeks')).toBeInTheDocument();
      expect(within(budgeted).getByText('£120.00')).toBeInTheDocument();
    });
  });

  /**
   * A budget that has FINISHED (owner, 5 Nov 2026: end dates and one-off
   * budgets). It keeps its card — what the last period came to is worth
   * seeing — captioned as over, and it is left out of the live total: its
   * allowance was for days that are gone.
   */
  describe('a one-off budget that has finished', () => {
    const lastYear = now.getFullYear() - 1;

    beforeEach(() => {
      __setAppContextValue({
        accounts: ACCOUNTS,
        categories: CATEGORIES,
        transactions: [
          txn({ id: 't-1', amount: -40 }),
          // Inside the one-off's month, last year — counted by it, by nothing else.
          txn({ id: 't-done', amount: -120, category: 'det-household', date: new Date(`${lastYear}-06-15`) })
        ],
        transactionSplits: [],
        budgets: [
          budget({ id: 'bud-groceries', categoryId: 'det-groceries', amount: 200 }),
          budget({
            id: 'bud-household', categoryId: 'det-household', amount: 300, period: 'custom',
            startDate: `${lastYear}-06-01`, endDate: `${lastYear}-06-30`, createdAt: now, updatedAt: now
          })
        ]
      });
    });

    it('is captioned One-off, over its own days, and finished — and still says what it came to', () => {
      renderBudget();
      const household = within(card('Household'));
      const caption = household.getByText(/^One-off ·/).textContent?.replace(/\s+/g, ' ') ?? '';
      expect(caption).toMatch(new RegExp(`^One-off · 1\\s*[–-]\\s*30 Jun ${lastYear} · finished$`));
      expect(household.getByText('£120.00 of £300.00')).toBeInTheDocument();
      expect(household.getByText(`Finished 30 Jun ${lastYear}`)).toBeInTheDocument();
    });

    it('is left out of the total, which is then one rhythm, captioned as itself', () => {
      renderBudget();
      expect(screen.queryByText('£500.00')).not.toBeInTheDocument();
      expect(screen.getByText('£200.00')).toBeInTheDocument();
      expect(screen.getAllByText('Monthly budgets').length).toBe(3);
    });
  });
});

/**
 * The two page actions that write: the Active/Inactive toggle and Delete.
 *
 * Both used to be launched and forgotten. A refused write left the row looking
 * exactly as it had, with nothing said — the card kept the truth (the context
 * leaves its state alone when the write throws) while the person who pressed
 * the button was told a budget had changed that had not.
 */
describe('Budget page — a write the server refuses', () => {
  /** Any refusal would do; this is the sentence the live guard uses. */
  const REFUSAL = 'Still connecting to your account — please try again in a moment.';

  const seed = (overrides: { updateBudget?: () => Promise<void>; deleteBudget?: () => Promise<void> }): void => {
    __setAppContextValue({
      accounts: ACCOUNTS,
      categories: CATEGORIES,
      transactions: [txn({ id: 't-1', amount: -40 })],
      transactionSplits: [],
      budgets: [budget({ id: 'bud-groceries', categoryId: 'det-groceries', amount: 200 })],
      ...overrides
    });
  };

  afterEach(() => {
    __resetAppContextValue();
    vi.restoreAllMocks();
  });

  it('says so when the Active toggle is refused, and leaves the card alone', async () => {
    seed({ updateBudget: vi.fn().mockRejectedValue(new Error(REFUSAL)) });
    renderBudget();

    fireEvent.click(within(card('Groceries')).getByRole('button', { name: 'Active' }));

    const shown = await screen.findByText(REFUSAL);
    expect(shown.textContent).toBe(REFUSAL);
    // The toggle still reads what the stored budget actually is.
    expect(within(card('Groceries')).getByRole('button', { name: 'Active' })).toBeInTheDocument();
  });

  it('says so when the delete is refused, and the budget is still there', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    seed({ deleteBudget: vi.fn().mockRejectedValue(new Error(REFUSAL)) });
    renderBudget();

    fireEvent.click(within(card('Groceries')).getByRole('button', { name: 'Delete Budget' }));

    const shown = await screen.findByText(REFUSAL);
    expect(shown.textContent).toBe(REFUSAL);
    expect(card('Groceries')).toBeInTheDocument();
  });

  it('says nothing when the delete goes through', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deleteBudget = vi.fn().mockResolvedValue(undefined);
    seed({ deleteBudget });
    renderBudget();

    fireEvent.click(within(card('Groceries')).getByRole('button', { name: 'Delete Budget' }));

    await waitFor(() => expect(deleteBudget).toHaveBeenCalledWith('bud-groceries'));
    expect(screen.queryByText(REFUSAL)).not.toBeInTheDocument();
  });

  it('does not delete at all when the confirmation is declined', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const deleteBudget = vi.fn().mockResolvedValue(undefined);
    seed({ deleteBudget });
    renderBudget();

    fireEvent.click(within(card('Groceries')).getByRole('button', { name: 'Delete Budget' }));

    expect(deleteBudget).not.toHaveBeenCalled();
  });
});

/**
 * The empty page says what is absent and offers real ways in — and shows NO
 * furniture for data that isn't there (Claude Design, 22 Aug §2/§3). Before
 * this, three £0.00 summary cards stood over "no budgets set up yet", the
 * £0.00 Remaining wore green, £0.00 Spent wore a red falling arrow, and
 * "Create your first budget" was plain text where every other empty state
 * offers a control.
 */
describe('Budget page — an empty page is an empty state, not zeroed furniture', () => {
  it('hides the summary trio, drops the zero arrows, and offers both ways in', async () => {
    __setAppContextValue({
      accounts: ACCOUNTS,
      categories: CATEGORIES,
      budgets: [],
      transactions: [],
      transactionSplits: [],
    });
    renderBudget();

    expect(await screen.findByRole('heading', { level: 3, name: 'No budgets yet' })).toBeInTheDocument();
    // The consequence, then the remedies as real controls. TWO controls carry
    // the same words on purpose — the header button took the empty state's
    // label (Claude Design 22 Aug §7: "+ Add Budget" and "+ Create a budget"
    // were two primaries in two cases for one action).
    expect(screen.getByText(/nothing on this page has anything to measure against/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Create a budget' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'See last year’s spending' })).toBeInTheDocument();
    // No furniture: the three summary cards do not render over an empty page.
    expect(screen.queryByText('Total Budgeted')).not.toBeInTheDocument();
    expect(screen.queryByText('Total Spent')).not.toBeInTheDocument();
    expect(screen.queryByText('Total Remaining')).not.toBeInTheDocument();
    // Nor the feature folds — furniture until there is a budget to slice
    // (Claude Design 22 Aug §7, carried into §12's one-page shape).
    expect(screen.queryByRole('button', { name: /Rollover/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Spending alerts/ })).not.toBeInTheDocument();
  });

  it('brings the feature folds — not tabs — the moment a budget exists (§12)', async () => {
    // §12 (owner, 23 Aug): one budgeting approach. Envelope and Zero-Based
    // are RETIRED — they must never come back as choices — and Rollover and
    // Alerts are collapsed folds below the budgets, mounting their content
    // only when opened. Templates joined the retired list on 1 Sep 2026:
    // applying a budget set in one go is the wizard's job, and the named
    // sets lived only in localStorage.
    // Every figure here is invented; the repo is public.
    __setAppContextValue({
      accounts: ACCOUNTS,
      categories: CATEGORIES,
      budgets: [budget({ id: 'bud-groceries', categoryId: 'det-groceries', amount: 200 })],
      transactions: [],
      transactionSplits: [],
    });
    renderBudget();

    expect(await screen.findByRole('button', { name: /Rollover/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Spending alerts/ })).toBeInTheDocument();
    // The retired features are gone for good.
    expect(screen.queryByText('Envelope')).not.toBeInTheDocument();
    expect(screen.queryByText('Zero-Based')).not.toBeInTheDocument();
    expect(screen.queryByText(/Budget templates/)).not.toBeInTheDocument();
    // Folds start closed: a fold's content mounts only when opened.
    expect(screen.getByRole('button', { name: /Rollover/ })).toHaveAttribute('aria-expanded', 'false');
  });
});

/**
 * THE WIZARD HAS AN ADDRESS (owner, 1 Sep 2026).
 *
 * "Set budgets from your real year" is the last step of the dashboard's history
 * guide, and until this ruling it could only land on this page and leave the
 * reader to find the button. `?open=wizard` lands on the wizard — the same
 * `?open=` contract as Categorisation's two sweeps (utils/pageOpenLink): read
 * once on mount, and an unknown value opens nothing.
 */
describe('Budget page — opened at the wizard', () => {
  const setLedger = (): void => {
    __setAppContextValue({
      accounts: ACCOUNTS,
      categories: CATEGORIES,
      budgets: [],
      transactions: [],
      transactionSplits: [],
    });
  };

  afterEach(() => {
    __resetAppContextValue();
  });

  it('?open=wizard brings the wizard up on arrival', async () => {
    setLedger();
    renderBudget('/budget?open=wizard');

    expect(await screen.findByTestId('budget-wizard')).toBeInTheDocument();
  });

  it('lets the reader close it, and it stays closed', async () => {
    setLedger();
    renderBudget('/budget?open=wizard');

    fireEvent.click(await screen.findByRole('button', { name: 'Close the wizard' }));

    // The parameter is still in the address: it says how the page was opened,
    // not what it must keep doing.
    expect(screen.queryByTestId('budget-wizard')).not.toBeInTheDocument();
  });

  it('opens nothing for an ordinary visit, or for an ask it does not know', async () => {
    setLedger();
    renderBudget();
    expect(await screen.findByRole('button', { name: 'Set up budgets' })).toBeInTheDocument();
    expect(screen.queryByTestId('budget-wizard')).not.toBeInTheDocument();

    cleanup();
    setLedger();
    renderBudget('/budget?open=something-else');
    expect(await screen.findByRole('button', { name: 'Set up budgets' })).toBeInTheDocument();
    expect(screen.queryByTestId('budget-wizard')).not.toBeInTheDocument();
  });
});
