/**
 * BudgetModal Tests
 *
 * Focus: the category field. It is the shared CategorySelector combobox —
 * grouped under its parent group, expense tree only — and it deals in category
 * IDs, which is what `calculateBudgetSpending` matches transactions on. The old
 * flat <select> stored the category NAME, so budgets added here matched nothing.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '../../test/testUtils';
import { __setAppContextValue, __resetAppContextValue } from '../../test/mocks/AppContextSupabase';
import BudgetModal from '../BudgetModal';
import type { Budget, Category } from '../../types';

// A two-direction tree: budgets are spending limits, so only the expense side
// may be offered.
const tree: Category[] = [
  { id: 'type-income', name: 'Income', type: 'income', level: 'type' },
  { id: 'type-expense', name: 'Expenses', type: 'expense', level: 'type' },
  { id: 'sub-salary', name: 'Salary', type: 'income', level: 'sub', parentId: 'type-income' },
  { id: 'sub-food', name: 'Food', type: 'expense', level: 'sub', parentId: 'type-expense' },
  { id: 'det-payslip', name: 'Payslip', type: 'income', level: 'detail', parentId: 'sub-salary' },
  { id: 'det-groceries', name: 'Groceries', type: 'expense', level: 'detail', parentId: 'sub-food' },
];

const addBudget = vi.fn();
const updateBudget = vi.fn();

describe('BudgetModal', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __setAppContextValue({
      categories: tree,
      // No budgets unless a test says so: the shared default fixture holds
      // budgets keyed by category NAME ("Groceries"), which resolve onto this
      // tree and would trip the one-budget-per-category guard.
      budgets: [],
      addBudget,
      updateBudget,
      getSubCategories: (parentId?: string) =>
        tree.filter(c => c.level === 'sub' && c.parentId === parentId),
      getDetailCategories: (parentId?: string) =>
        tree.filter(c => c.level === 'detail' && c.parentId === parentId),
    });
  });

  afterEach(() => {
    cleanup();
    __resetAppContextValue();
  });

  /** Open the category combobox by clicking its collapsed trigger. */
  const openCategoryPicker = (): void => {
    fireEvent.click(screen.getByText('Search or select category…'));
  };

  it('renders without crashing', () => {
    renderWithProviders(<BudgetModal {...defaultProps} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('offers the shared searchable combobox, not a flat select', () => {
    renderWithProviders(<BudgetModal {...defaultProps} />);
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeInTheDocument();
  });

  it('lists expense categories under their group heading, and no income ones', () => {
    renderWithProviders(<BudgetModal {...defaultProps} />);
    openCategoryPicker();
    expect(screen.getByText('Food')).toBeInTheDocument();        // group heading
    expect(screen.getByText('Groceries')).toBeInTheDocument();   // the category
    expect(screen.queryByText('Payslip')).not.toBeInTheDocument();
  });

  it('saves the chosen category as an ID — what budget spending matches on', () => {
    renderWithProviders(<BudgetModal {...defaultProps} />);
    openCategoryPicker();
    fireEvent.click(screen.getByText('Groceries'));
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Budget' }));

    expect(addBudget).toHaveBeenCalledTimes(1);
    expect(addBudget.mock.calls[0][0]).toMatchObject({ categoryId: 'det-groceries', amount: 250 });
  });

  it('blocks the save and says so when no category is chosen', () => {
    renderWithProviders(<BudgetModal {...defaultProps} />);
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Budget' }));

    expect(addBudget).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a category to budget against.');
  });

  it('offers each group as a budgetable choice of its own', () => {
    // Budgeting "Food" as a whole is how most people plan; the spending rolls
    // the group's detail categories up (see utils/budgetSpending).
    renderWithProviders(<BudgetModal {...defaultProps} />);
    openCategoryPicker();

    fireEvent.click(screen.getByText('All Food'));
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '400' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Budget' }));

    expect(addBudget.mock.calls[0][0]).toMatchObject({ categoryId: 'sub-food', amount: 400 });
  });

  describe('one budget per category', () => {
    const existing: Budget = {
      id: 'bud-existing',
      categoryId: 'det-groceries',
      amount: 300,
      period: 'monthly',
      isActive: true,
      spent: 0,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    };

    beforeEach(() => {
      __setAppContextValue({ budgets: [existing] });
    });

    it('refuses to add a second budget to a category that already has one', () => {
      renderWithProviders(<BudgetModal {...defaultProps} />);
      openCategoryPicker();
      fireEvent.click(screen.getByText('Groceries'));
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '250' } });

      expect(screen.getByRole('alert')).toHaveTextContent('Groceries already has a budget.');
      expect(screen.getByRole('button', { name: 'Add Budget' })).toBeDisabled();

      // …and the form itself refuses the submit, however it is reached.
      // (The modal renders through a portal, so it is found from the dialog.)
      const form = screen.getByRole('dialog').querySelector('form');
      if (!form) throw new Error('No form rendered');
      fireEvent.submit(form);

      expect(addBudget).not.toHaveBeenCalled();
    });

    it('offers to edit the budget that category already has', () => {
      const onEditExisting = vi.fn();
      renderWithProviders(<BudgetModal {...defaultProps} onEditExisting={onEditExisting} />);
      openCategoryPicker();
      fireEvent.click(screen.getByText('Groceries'));

      fireEvent.click(screen.getByRole('button', { name: 'Edit that budget instead' }));

      expect(onEditExisting).toHaveBeenCalledWith(existing);
    });

    it('lets that same budget be saved when it is the one being edited', () => {
      renderWithProviders(<BudgetModal {...defaultProps} budget={existing} />);
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '350' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

      expect(updateBudget).toHaveBeenCalledWith('bud-existing', expect.objectContaining({ amount: 350 }));
    });
  });

  it('shows the category of a budget stored the legacy way, by NAME', () => {
    // Budgets added by the old flat <select> hold the category name. Resolve it
    // back to an id so the picker displays it — and so saving heals the value.
    const legacyBudget = {
      id: 'b-1',
      categoryId: 'Groceries',
      amount: 300,
      period: 'monthly',
      isActive: true,
      spent: 0,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    } satisfies Budget;

    renderWithProviders(<BudgetModal {...defaultProps} budget={legacyBudget} />);
    expect(screen.getByText('Food > Groceries')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(updateBudget).toHaveBeenCalledWith('b-1', expect.objectContaining({
      categoryId: 'det-groceries',
    }));
  });

  describe('a save that does not go through', () => {
    /**
     * The sentence the context uses when a signed-in session's database id has
     * not resolved yet. Any refusal would do — this modal used to close on all
     * of them, because it launched the write and never looked back.
     */
    const REFUSAL = 'Still connecting to your account — please try again in a moment.';

    /** Choose a category and an amount, as a person would before saving. */
    const fillForm = (): void => {
      openCategoryPicker();
      fireEvent.click(screen.getByText('Groceries'));
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '250' } });
    };

    it('stays open and says why, in the words the write used', async () => {
      __setAppContextValue({ addBudget: vi.fn().mockRejectedValue(new Error(REFUSAL)) });
      renderWithProviders(<BudgetModal {...defaultProps} />);
      fillForm();

      fireEvent.click(screen.getByRole('button', { name: 'Add Budget' }));

      const shown = await screen.findByText(REFUSAL);
      // Exact equality, not "contains": a wrapper ("Error: …", "Could not save:
      // …") is a different sentence from the one the write chose, and the user
      // is owed that one.
      expect(shown.textContent).toBe(REFUSAL);
      // The modal is still here, with the work still in it — the whole point.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(defaultProps.onClose).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText('0.00')).toHaveValue('250');
      // Nothing to retry from is worse than a failed save: the button comes back.
      expect(screen.getByRole('button', { name: 'Add Budget' })).toBeEnabled();
    });

    it('closes as before when the save goes through', async () => {
      __setAppContextValue({ addBudget: vi.fn().mockResolvedValue(undefined) });
      renderWithProviders(<BudgetModal {...defaultProps} />);
      fillForm();

      fireEvent.click(screen.getByRole('button', { name: 'Add Budget' }));

      await waitFor(() => expect(defaultProps.onClose).toHaveBeenCalledTimes(1));
      expect(screen.queryByText(REFUSAL)).not.toBeInTheDocument();
    });

    it('cannot be asked for the same budget twice while the first save is in flight', async () => {
      let settle = (): void => {};
      const inFlight = vi.fn().mockImplementation(
        () => new Promise<void>(resolve => { settle = () => resolve(); })
      );
      __setAppContextValue({ addBudget: inFlight });
      renderWithProviders(<BudgetModal {...defaultProps} />);
      fillForm();

      fireEvent.click(screen.getByRole('button', { name: 'Add Budget' }));
      expect(inFlight).toHaveBeenCalledTimes(1);
      // The button says so…
      expect(screen.getByRole('button', { name: 'Add Budget' })).toBeDisabled();

      // …and the form refuses a second submit however it is reached, which is
      // useModalForm's own re-entrancy guard rather than the disabled attribute.
      const form = screen.getByRole('dialog').querySelector('form');
      if (!form) throw new Error('No form rendered');
      fireEvent.submit(form);

      expect(inFlight).toHaveBeenCalledTimes(1);

      settle();
      await waitFor(() => expect(defaultProps.onClose).toHaveBeenCalledTimes(1));
      expect(inFlight).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * STARTS — the day a budget's cycles count from (owner, 5 Nov 2026). The
   * default is the 1st of this month; a monthly budget from the 15th runs
   * 15th to 14th; weekly has no anchor and no field.
   */
  describe('Starts — the day the cycles count from', () => {
    const isoDay = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const firstOfThisMonth = (): string => {
      const now = new Date();
      return isoDay(new Date(now.getFullYear(), now.getMonth(), 1));
    };

    const fillAndAdd = (): void => {
      openCategoryPicker();
      fireEvent.click(screen.getByText('Groceries'));
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '250' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add Budget' }));
    };

    /**
     * ONE FROM DATE AND ONE TO DATE (owner, 7 Nov 2026 evening): a repeating
     * budget's dates are the set's. The form shows them, asks for none, and
     * writes them on every save — so a drifted card is healed by its next
     * edit. Only a one-off has days of its own.
     */
    it('with no other budgets, a new one runs from the 1st of this month, says so, and asks for no date', () => {
      renderWithProviders(<BudgetModal {...defaultProps} />);
      expect(screen.queryByLabelText('Starts')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Ends')).not.toBeInTheDocument();
      expect(screen.getByTestId('budget-set-dates')).toHaveTextContent(/^Runs with your other budgets from \d{1,2} \w{3} \d{4}\. To change that for all of them, use Set up budgets\.$/);
      expect(screen.getByText(/^First month: /)).toBeInTheDocument();

      fillAndAdd();
      expect(addBudget.mock.calls[0][0]).toMatchObject({ startDate: firstOfThisMonth(), endDate: null });
    });

    it('a new budget inherits the day the other budgets run from — the 15th runs 15th to 14th', () => {
      const payday = {
        id: 'b-pay', categoryId: 'sub-food', amount: 300, period: 'monthly', isActive: true, spent: 0,
        startDate: '2026-11-15', createdAt: new Date('2026-11-07T10:00:00.000Z'), updatedAt: new Date('2026-11-07T10:00:00.000Z'),
      } satisfies Budget;
      __setAppContextValue({ budgets: [payday] });
      renderWithProviders(<BudgetModal {...defaultProps} />);
      expect(screen.getByTestId('budget-set-dates')).toHaveTextContent('Runs with your other budgets from 15 Nov 2026.');
      expect(screen.getByText(/First month: 15 Nov\s*–\s*14 Dec 2026/)).toBeInTheDocument();

      fillAndAdd();
      expect(addBudget.mock.calls[0][0]).toMatchObject({ startDate: '2026-11-15', endDate: null });
    });

    it('a weekly budget has no start to share, only the end', () => {
      renderWithProviders(<BudgetModal {...defaultProps} />);
      fireEvent.change(screen.getByDisplayValue('Monthly'), { target: { value: 'weekly' } });
      expect(screen.getByTestId('budget-set-dates')).toHaveTextContent('Runs with your other budgets, week by week.');

      fillAndAdd();
      expect(addBudget.mock.calls[0][0]).not.toHaveProperty('startDate');
      expect(addBudget.mock.calls[0][0]).toMatchObject({ endDate: null });
    });

    it('saving a budget that drifted from the set brings it back to the set’s dates', () => {
      // The owner's trap (7 Nov): one card from 1 December among a set from 1 November.
      const november = (id: string, categoryId: string): Budget => ({
        id, categoryId, amount: 100, period: 'yearly', isActive: true, spent: 0,
        startDate: '2026-11-01', endDate: '2027-10-31',
        createdAt: new Date('2026-11-07T10:00:00.000Z'), updatedAt: new Date('2026-11-07T10:00:00.000Z'),
      });
      const drifted = { ...november('b-drift', 'det-groceries'), startDate: '2026-12-01', endDate: null };
      __setAppContextValue({ budgets: [november('b-1', 'sub-food'), november('b-2', 'det-payslip'), drifted] });

      renderWithProviders(<BudgetModal {...defaultProps} budget={drifted} />);
      expect(screen.getByTestId('budget-set-dates')).toHaveTextContent('Runs with your other budgets from 1 Nov 2026 until 31 Oct 2027.');
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
      expect(updateBudget).toHaveBeenCalledWith('b-drift', expect.objectContaining({ startDate: '2026-11-01', endDate: '2027-10-31' }));
    });
  });

  /**
   * ENDS — the day a budget stops, and a budget that runs once (owner, 5 Nov
   * 2026). Optional for a repeating period, honoured by every one of them;
   * required for a one-off, which is nothing but its two days.
   */
  describe('Ends — the day the budget stops, and a budget that runs once', () => {
    const fillAndAdd = (): void => {
      openCategoryPicker();
      fireEvent.click(screen.getByText('Groceries'));
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '250' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add Budget' }));
    };
    const choosePeriod = (value: string): void => {
      fireEvent.change(screen.getByDisplayValue('Monthly'), { target: { value } });
    };

    /** The set's end, shared by every repeating budget (7 Nov 2026 evening). */
    const endingSet = {
      id: 'b-set', categoryId: 'sub-food', amount: 300, period: 'monthly', isActive: true, spent: 0,
      startDate: '2027-01-01', endDate: '2027-06-30',
      createdAt: new Date('2026-11-10T10:00:00.000Z'), updatedAt: new Date('2026-11-10T10:00:00.000Z'),
    } satisfies Budget;

    it('a repeating budget takes the set’s end, names the last period beside the first, and writes it', () => {
      __setAppContextValue({ budgets: [endingSet] });
      renderWithProviders(<BudgetModal {...defaultProps} />);
      expect(screen.queryByLabelText('Ends')).not.toBeInTheDocument();
      expect(screen.getByTestId('budget-set-dates')).toHaveTextContent('Runs with your other budgets from 1 Jan 2027 until 30 Jun 2027.');
      expect(screen.getByTestId('budget-choice')).toHaveTextContent(
        /^First month: 1\s*[–-]\s*31 Jan 2027\. Last month: 1\s*[–-]\s*30 Jun 2027\.$/
      );

      fillAndAdd();
      expect(addBudget.mock.calls[0][0]).toMatchObject({ startDate: '2027-01-01', endDate: '2027-06-30' });
    });

    it('a one-off ending before it starts is refused, and nothing is written', () => {
      renderWithProviders(<BudgetModal {...defaultProps} />);
      choosePeriod('custom');
      fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2027-06-01' } });
      fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2027-01-31' } });
      expect(screen.queryByTestId('budget-choice')).not.toBeInTheDocument();

      fillAndAdd();
      expect(screen.getByRole('alert')).toHaveTextContent('Ends is before Starts.');
      expect(addBudget).not.toHaveBeenCalled();
    });

    it('a weekly budget takes the set’s end too, and says when it stops', () => {
      __setAppContextValue({ budgets: [endingSet] });
      renderWithProviders(<BudgetModal {...defaultProps} />);
      choosePeriod('weekly');
      expect(screen.getByTestId('budget-set-dates')).toHaveTextContent('Runs with your other budgets until 30 Jun 2027.');
      expect(screen.getByTestId('budget-choice')).toHaveTextContent('Runs until 30 Jun 2027.');

      fillAndAdd();
      expect(addBudget.mock.calls[0][0]).toMatchObject({ period: 'weekly', endDate: '2027-06-30' });
      expect(addBudget.mock.calls[0][0]).not.toHaveProperty('startDate');
    });

    it('a one-off that already has its days shows them', () => {
      const once = {
        id: 'b-1',
        categoryId: 'det-groceries',
        amount: 300,
        period: 'custom',
        isActive: true,
        spent: 0,
        startDate: '2026-12-01',
        endDate: '2027-01-31',
        createdAt: new Date('2026-11-10T10:00:00.000Z'),
        updatedAt: new Date('2026-11-10T10:00:00.000Z'),
      } satisfies Budget;

      renderWithProviders(<BudgetModal {...defaultProps} budget={once} />);
      expect(screen.getByLabelText('Starts')).toHaveValue('2026-12-01');
      expect(screen.getByLabelText('Ends')).toHaveValue('2027-01-31');
      expect(screen.queryByTestId('budget-set-dates')).not.toBeInTheDocument();
    });

    /**
     * EVERY… — an interval of the user's own (owner, 7 Nov 2026): N weeks or
     * months, counted from Starts. A whole number of at least one, or no save.
     */
    /**
     * AT THE END OF EACH PERIOD (owner, 7 Nov 2026): rollover is a choice per
     * budget, "neither" by default. The carry is derived from the periods
     * before, so the editor only records the mode.
     */
    describe('At the end of each period — the rollover mode', () => {
      it('starts afresh unless told otherwise, and says what that means', () => {
        renderWithProviders(<BudgetModal {...defaultProps} />);
        expect(screen.getByLabelText('At the end of each period')).toHaveValue('none');
        expect(screen.getByText('Each period starts with the amount above, whatever the last one left.')).toBeInTheDocument();

        fillAndAdd();
        expect(addBudget.mock.calls[0][0]).toMatchObject({ rolloverMode: 'none' });
      });

      it('carries what is left when asked, and writes the mode', () => {
        renderWithProviders(<BudgetModal {...defaultProps} />);
        fireEvent.change(screen.getByLabelText('At the end of each period'), { target: { value: 'surplus' } });
        expect(screen.getByText('Anything left at the end of a period is added to the next one. An overspend is not carried.')).toBeInTheDocument();

        fillAndAdd();
        expect(addBudget.mock.calls[0][0]).toMatchObject({ rolloverMode: 'surplus' });
      });

      it('a one-off has no next period: the choice is not offered, and it is written as starting afresh', () => {
        renderWithProviders(<BudgetModal {...defaultProps} />);
        fireEvent.change(screen.getByLabelText('At the end of each period'), { target: { value: 'both' } });
        choosePeriod('custom');
        expect(screen.queryByLabelText('At the end of each period')).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-12-01' } });
        fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2027-01-31' } });

        fillAndAdd();
        expect(addBudget.mock.calls[0][0]).toMatchObject({ period: 'custom', rolloverMode: 'none' });
      });

      it('a budget that carries both shows its mode', () => {
        const carries = {
          id: 'b-1',
          categoryId: 'det-groceries',
          amount: 90,
          period: 'monthly',
          rolloverMode: 'both',
          isActive: true,
          spent: 0,
          startDate: '2026-11-01',
          createdAt: new Date('2026-11-07T10:00:00.000Z'),
          updatedAt: new Date('2026-11-07T10:00:00.000Z'),
        } satisfies Budget;

        renderWithProviders(<BudgetModal {...defaultProps} budget={carries} />);
        expect(screen.getByLabelText('At the end of each period')).toHaveValue('both');
        expect(screen.getByText('Whatever a period leaves — left over or gone over — carries into the next one.')).toBeInTheDocument();
      });
    });

    /**
     * WHERE A SURPLUS GOES (owner, 7 Nov 2026): under a mode that carries a
     * surplus, it may be sent to another running budget; otherwise kept.
     */
    describe('Send what is left to — where a surplus goes', () => {
      const holiday = {
        id: 'b-holiday',
        categoryId: 'sub-food',
        amount: 50,
        period: 'monthly',
        isActive: true,
        spent: 0,
        startDate: '2026-11-01',
        createdAt: new Date('2026-11-07T10:00:00.000Z'),
        updatedAt: new Date('2026-11-07T10:00:00.000Z'),
      } satisfies Budget;

      it('is not offered while nothing is carried, and writes no destination', () => {
        __setAppContextValue({ budgets: [holiday] });
        renderWithProviders(<BudgetModal {...defaultProps} />);
        expect(screen.queryByLabelText('Send what is left to')).not.toBeInTheDocument();
        fillAndAdd();
        expect(addBudget.mock.calls[0][0]).toMatchObject({ rolloverTo: null });
      });

      it('once a surplus is carried, offers the other running budgets, keeps by default, and writes the chosen one', () => {
        __setAppContextValue({ budgets: [holiday, { ...holiday, id: 'b-paused', categoryId: 'det-payslip', isActive: false }] });
        renderWithProviders(<BudgetModal {...defaultProps} />);
        fireEvent.change(screen.getByLabelText('At the end of each period'), { target: { value: 'surplus' } });
        const select = screen.getByLabelText('Send what is left to');
        expect(select).toHaveValue('');
        expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Keep it here', 'Food']);

        fireEvent.change(select, { target: { value: 'b-holiday' } });
        fillAndAdd();
        expect(addBudget.mock.calls[0][0]).toMatchObject({ rolloverMode: 'surplus', rolloverTo: 'b-holiday' });
      });

      it('a destination chosen and then the mode moved to one that keeps nothing is not written', () => {
        __setAppContextValue({ budgets: [holiday] });
        renderWithProviders(<BudgetModal {...defaultProps} />);
        fireEvent.change(screen.getByLabelText('At the end of each period'), { target: { value: 'both' } });
        fireEvent.change(screen.getByLabelText('Send what is left to'), { target: { value: 'b-holiday' } });
        fireEvent.change(screen.getByLabelText('At the end of each period'), { target: { value: 'overspend' } });
        expect(screen.queryByLabelText('Send what is left to')).not.toBeInTheDocument();
        fillAndAdd();
        expect(addBudget.mock.calls[0][0]).toMatchObject({ rolloverMode: 'overspend', rolloverTo: null });
      });

      it('a budget that already sends its surplus shows where, and never offers itself', () => {
        const groceries = { ...holiday, id: 'b-groceries', categoryId: 'det-groceries', rolloverMode: 'surplus' as const, rolloverTo: 'b-holiday' };
        __setAppContextValue({ budgets: [holiday, groceries] });
        renderWithProviders(<BudgetModal {...defaultProps} budget={groceries} />);
        const select = screen.getByLabelText('Send what is left to');
        expect(select).toHaveValue('b-holiday');
        expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Keep it here', 'Food']);
      });
    });

    /**
     * PAID (owner, 7 Nov 2026): how the money lands over the period, a
     * per-budget option the wizard proposes and this editor can change.
     */
    describe('Paid — spread across the period, or in one go', () => {
      it('is spread unless told otherwise, and writes the shape', () => {
        renderWithProviders(<BudgetModal {...defaultProps} />);
        expect(screen.getByLabelText('Paid')).toHaveValue('even');
        fillAndAdd();
        expect(addBudget.mock.calls[0][0]).toMatchObject({ paceShape: 'even' });
      });

      it('in one go says what that means, and writes it', () => {
        renderWithProviders(<BudgetModal {...defaultProps} />);
        fireEvent.change(screen.getByLabelText('Paid'), { target: { value: 'once' } });
        expect(screen.getByText(/A bill paid once a period/)).toBeInTheDocument();
        fillAndAdd();
        expect(addBudget.mock.calls[0][0]).toMatchObject({ paceShape: 'once' });
      });

      it('a budget paid in one go shows its shape', () => {
        const lump = {
          id: 'b-1',
          categoryId: 'det-groceries',
          amount: 480,
          period: 'yearly',
          paceShape: 'once',
          isActive: true,
          spent: 0,
          startDate: '2026-04-06',
          createdAt: new Date('2026-11-07T10:00:00.000Z'),
          updatedAt: new Date('2026-11-07T10:00:00.000Z'),
        } satisfies Budget;
        renderWithProviders(<BudgetModal {...defaultProps} budget={lump} />);
        expect(screen.getByLabelText('Paid')).toHaveValue('once');
      });
    });

    describe('Every… — an interval of the user’s own', () => {
      /** The set runs from 1 January 2027: what the intervals count from (7 Nov 2026 evening). */
      const fromNewYear = {
        id: 'b-set', categoryId: 'sub-food', amount: 300, period: 'monthly', isActive: true, spent: 0,
        startDate: '2027-01-01', createdAt: new Date('2026-11-10T10:00:00.000Z'), updatedAt: new Date('2026-11-10T10:00:00.000Z'),
      } satisfies Budget;

      it('asks how many and of what, names the first interval from the set’s start, and writes the pair', () => {
        __setAppContextValue({ budgets: [fromNewYear] });
        renderWithProviders(<BudgetModal {...defaultProps} />);
        choosePeriod('every');
        fireEvent.change(screen.getByLabelText('Every how many'), { target: { value: '2' } });
        fireEvent.change(screen.getByLabelText('Weeks or months'), { target: { value: 'month' } });
        expect(screen.getByTestId('budget-choice')).toHaveTextContent(
          /^First 2 months: 1 Jan\s*[–-]\s*28 Feb 2027\.$/
        );

        fillAndAdd();
        expect(addBudget.mock.calls[0][0]).toMatchObject({
          period: 'every',
          repeatCount: 2,
          repeatUnit: 'month',
          startDate: '2027-01-01',
        });
      });

      it('six weeks reads as six weeks', () => {
        __setAppContextValue({ budgets: [fromNewYear] });
        renderWithProviders(<BudgetModal {...defaultProps} />);
        choosePeriod('every');
        fireEvent.change(screen.getByLabelText('Every how many'), { target: { value: '6' } });
        fireEvent.change(screen.getByLabelText('Weeks or months'), { target: { value: 'week' } });
        expect(screen.getByTestId('budget-choice')).toHaveTextContent(
          /^First 6 weeks: 1 Jan\s*[–-]\s*11 Feb 2027\.$/
        );
      });

      it('refuses a count that is not a whole number of at least one, and writes nothing', () => {
        renderWithProviders(<BudgetModal {...defaultProps} />);
        choosePeriod('every');
        fireEvent.change(screen.getByLabelText('Every how many'), { target: { value: '0' } });
        expect(screen.queryByTestId('budget-choice')).not.toBeInTheDocument();

        fillAndAdd();
        expect(screen.getByRole('alert')).toHaveTextContent('Every how many? A whole number, one or more.');
        expect(addBudget).not.toHaveBeenCalled();
      });

      it('a named rhythm writes no pair', () => {
        renderWithProviders(<BudgetModal {...defaultProps} />);
        fillAndAdd();
        expect(addBudget.mock.calls[0][0]).toMatchObject({ period: 'monthly', repeatCount: null, repeatUnit: null });
      });

      it('a budget that already repeats every 3 weeks shows its pair', () => {
        const every = {
          id: 'b-1',
          categoryId: 'det-groceries',
          amount: 90,
          period: 'every',
          repeatCount: 3,
          repeatUnit: 'week',
          isActive: true,
          spent: 0,
          startDate: '2026-11-01',
          createdAt: new Date('2026-11-07T10:00:00.000Z'),
          updatedAt: new Date('2026-11-07T10:00:00.000Z'),
        } satisfies Budget;

        renderWithProviders(<BudgetModal {...defaultProps} budget={every} />);
        expect(screen.getByDisplayValue('Every…')).toBeInTheDocument();
        expect(screen.getByLabelText('Every how many')).toHaveValue(3);
        expect(screen.getByLabelText('Weeks or months')).toHaveValue('week');
      });
    });

    describe('One-off — a budget that runs once', () => {
      it('is offered as a period, needs both days, and says so', () => {
        renderWithProviders(<BudgetModal {...defaultProps} />);
        choosePeriod('custom');
        expect(screen.getByDisplayValue('One-off')).toBeInTheDocument();
        expect(screen.getByText('A one-off budget runs once, from Starts to Ends, and is then finished.')).toBeInTheDocument();

        fillAndAdd();
        expect(screen.getByRole('alert')).toHaveTextContent('A one-off budget needs the day it starts and the day it ends.');
        expect(addBudget).not.toHaveBeenCalled();
      });

      it('runs once from Starts to Ends, says so, and writes both days', () => {
        renderWithProviders(<BudgetModal {...defaultProps} />);
        choosePeriod('custom');
        fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-12-01' } });
        fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2027-01-31' } });
        expect(screen.getByTestId('budget-choice')).toHaveTextContent(
          /^Runs once, 1 Dec 2026\s*[–-]\s*31 Jan 2027, and is then finished\.$/
        );
        // No "runs 15th to 14th" hint: a one-off has no cycle to describe.
        expect(screen.queryByText(/runs 15th to 14th|runs with the tax year/)).not.toBeInTheDocument();

        fillAndAdd();
        expect(addBudget.mock.calls[0][0]).toMatchObject({
          period: 'custom',
          startDate: '2026-12-01',
          endDate: '2027-01-31',
        });
      });
    });
  });
});
