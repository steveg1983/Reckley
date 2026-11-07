import { render, screen, waitFor, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import BudgetPage from '../../pages/Budget';
import { AppProvider } from '../../contexts/AppContextSupabase';
import { NotificationProvider } from '../../contexts/NotificationContext';
import { PreferencesProvider } from '../../contexts/PreferencesContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { __resetAppContextValue, __setAppContextValue } from '../mocks/AppContextSupabase';
import type { Budget, Category } from '../../types';

// Legacy budgets predate the categoryId column and only carry a category name.
type LegacyBudget = Omit<Budget, 'categoryId'> & { category?: string };

// Helper to render with all providers
const renderWithProviders = (ui: React.ReactElement, { route = '/budget' } = {}) => {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <PreferencesProvider>
        <AppProvider>
          <NotificationProvider>
            <ToastProvider>
              <Routes>
                <Route path="/budget" element={ui} />
              </Routes>
            </ToastProvider>
          </NotificationProvider>
        </AppProvider>
      </PreferencesProvider>
    </MemoryRouter>
  );
};

describe('Budget Workflow Integration', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    __resetAppContextValue();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Create Budget → Track Spending → Alerts', () => {
    it('should open and close the budget modal', async () => {
      // Step 1: Render budget page
      renderWithProviders(<BudgetPage />);

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: /budget/i })).toBeInTheDocument();
      });

      // Click the Create a budget icon
      const addBudgetIcon = screen.getByTitle('Create a budget');
      await user.click(addBudgetIcon);

      // Wait for modal to appear
      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      // Verify modal has the expected title
      const modal = screen.getByRole('dialog');
      expect(within(modal).getByRole('heading', { name: 'Add Budget' })).toBeInTheDocument();

      // Verify form fields are present - use getAllByText since there might be multiple matches
      const categoryElements = within(modal).getAllByText(/category/i);
      expect(categoryElements.length).toBeGreaterThan(0);
      // Exact, as labels: the rollover select's label and hint also say
      // "period" and "amount".
      expect(within(modal).getByText('Amount', { selector: 'label' })).toBeInTheDocument();
      expect(within(modal).getByText('Period', { selector: 'label' })).toBeInTheDocument();

      // Click cancel button
      const cancelButton = within(modal).getByRole('button', { name: /cancel/i });
      await user.click(cancelButton);

      // Verify modal closes
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('folds the features below the budgets — no tabs, no retired approaches (§12)', async () => {
      const budgets: Budget[] = [{
        id: 'budget-1',
        categoryId: 'cat-1',
        name: 'Entertainment',
        amount: 200,
        period: 'monthly',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        spent: 0
      }];
      const categories: Category[] = [
        { id: 'cat-1', name: 'Entertainment', type: 'expense', level: 'detail' }
      ];
      __setAppContextValue({ budgets, categories, transactions: [] });
      renderWithProviders(<BudgetPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: /budget/i })).toBeInTheDocument();
      });

      // The one feature left is a collapsed fold, earned by the budget
      // existing. (Templates was a fold until 1 Sep 2026 — retired: applying
      // a budget set in one go is the wizard's job now. Rollover until 7 Nov
      // 2026 — a mode on each budget now, chosen in the editor.)
      const alertsFold = await screen.findByRole('button', { name: /spending alerts/i });
      expect(alertsFold).toHaveAttribute('aria-expanded', 'false');

      // The retired features are gone for good.
      expect(screen.queryByText(/envelope/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/zero-based/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/budget templates/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /rollover/i })).not.toBeInTheDocument();

      // Opening a fold mounts its content.
      await user.click(alertsFold);
      await waitFor(() => {
        expect(alertsFold).toHaveAttribute('aria-expanded', 'true');
      });
    });

    it('should handle budget with existing data', async () => {
      // Seed the live provider context with an existing budget
      const budgets: Budget[] = [{
        id: 'budget-1',
        categoryId: 'cat-1',
        name: 'Entertainment',
        amount: 200,
        period: 'monthly',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        spent: 0
      }];
      const categories: Category[] = [
        { id: 'cat-1', name: 'Entertainment', type: 'expense', level: 'detail' },
        { id: 'cat-2', name: 'Food & Dining', type: 'expense', level: 'detail' }
      ];

      __setAppContextValue({ budgets, categories, transactions: [] });

      renderWithProviders(<BudgetPage />);

      await waitFor(() => {
        expect(screen.getByText('Entertainment')).toBeInTheDocument();
      });

      // The budget amount appears in the format "£200.00 of £200.00"
      await waitFor(() => {
        const budgetTexts = screen.getAllByText(/200/);
        expect(budgetTexts.length).toBeGreaterThan(0);
      });
    });

    it('should display budget with existing data', async () => {
      // Seed the live provider context with a budget
      const budgets: Budget[] = [{
        id: 'budget-1',
        categoryId: 'cat-1',
        name: 'Groceries',
        amount: 500,
        period: 'monthly',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        spent: 0
      }];
      const categories: Category[] = [
        { id: 'cat-1', name: 'Groceries', type: 'expense', level: 'detail' }
      ];

      __setAppContextValue({ budgets, categories, transactions: [] });

      renderWithProviders(<BudgetPage />);

      await waitFor(() => {
        // Should show budget category
        expect(screen.getByText('Groceries')).toBeInTheDocument();
      });

      // Budget amount appears in various formats (e.g., "£500.00 of £500.00")
      await waitFor(() => {
        const budgetTexts = screen.getAllByText(/500/);
        expect(budgetTexts.length).toBeGreaterThan(0);
      });
    });

    it('should render legacy budgets that only store category name', async () => {
      const legacyBudgets: LegacyBudget[] = [{
        id: 'legacy-budget-1',
        category: 'Legacy Travel',
        amount: 150,
        period: 'monthly',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        spent: 0
      }];

      __setAppContextValue({
        // Single assertion is intentional: legacy rows lack categoryId by design
        budgets: legacyBudgets as Budget[],
        categories: [],
        transactions: []
      });

      renderWithProviders(<BudgetPage />);

      await waitFor(() => {
        expect(screen.getByText('Legacy Travel')).toBeInTheDocument();
      });
    });

    it('should select different budget periods', async () => {
      renderWithProviders(<BudgetPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: /budget/i })).toBeInTheDocument();
      });

      // Click Create a budget icon
      const addBudgetIcon = screen.getByTitle('Create a budget');
      await user.click(addBudgetIcon);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      const modal = screen.getByRole('dialog');

      // Find period select - find by proximity to label. Exact, as a label:
      // "At the end of each period" and its hint sit in the same form.
      const periodLabel = within(modal).getByText('Period', { selector: 'label' });
      const periodSelect = periodLabel.parentElement?.querySelector('select');
      expect(periodSelect).toBeInTheDocument();

      if (periodSelect) {
        // Verify default is monthly
        expect(periodSelect).toHaveValue('monthly');

        // Change to yearly
        await user.selectOptions(periodSelect, 'yearly');
        expect(periodSelect).toHaveValue('yearly');
      }

      // Click cancel to close
      const cancelButton = within(modal).getByRole('button', { name: /cancel/i });
      await user.click(cancelButton);

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('keeps the budget page a single approach — the page itself is Traditional (§12)', async () => {
      const budgets: Budget[] = [{
        id: 'budget-1',
        categoryId: 'cat-1',
        name: 'Entertainment',
        amount: 200,
        period: 'monthly',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        spent: 0
      }];
      const categories: Category[] = [
        { id: 'cat-1', name: 'Entertainment', type: 'expense', level: 'detail' }
      ];
      __setAppContextValue({ budgets, categories, transactions: [] });
      renderWithProviders(<BudgetPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: /budget/i })).toBeInTheDocument();
      });

      // No tab strip anywhere: the budgets ARE the page.
      expect(screen.queryByRole('button', { name: /traditional/i })).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 3, name: 'Entertainment' })).toBeInTheDocument();
    });
  });
});
