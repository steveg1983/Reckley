import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PreferencesProvider } from '../../contexts/PreferencesContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { NotificationProvider } from '../../contexts/NotificationContext';
import Categorisation from '../Categorisation';
import { __setAppContextValue, __resetAppContextValue } from '../../test/mocks/AppContextSupabase';
import type { Account, Category, Transaction } from '../../types';

/**
 * "NOT THESE" (owner, 15 Nov 2026): beside "Confirm these", a way to say a
 * suggestion is wrong, row by row. The ticked rows lose the app's guess and
 * go back to be filed; the unticked ones stay suggested. Every figure invented.
 */
describe('Categorisation — saying a suggestion is wrong', () => {
  const account: Account = {
    id: 'acct-1', name: 'Synthetic Account', type: 'current', balance: 0,
    currency: 'GBP', lastUpdated: new Date('2026-01-01'),
  };
  const categories: Category[] = [
    { id: 'type-expense', name: 'Expenses', type: 'expense', level: 'type' },
    { id: 'det-groceries', name: 'Groceries', type: 'expense', level: 'detail', parentId: 'type-expense' },
  ];
  const txn = (id: string, description: string): Transaction => ({
    id, date: new Date('2026-02-01'), description, amount: -10, type: 'expense',
    accountId: 'acct-1', category: 'det-groceries', categoryConfirmed: false,
  });

  const renderPage = () =>
    render(
      <MemoryRouter>
        <PreferencesProvider>
          <ToastProvider>
            <NotificationProvider>
              <Categorisation />
            </NotificationProvider>
          </ToastProvider>
        </PreferencesProvider>
      </MemoryRouter>
    );

  afterEach(() => {
    __resetAppContextValue();
  });

  it('opens the group’s rows with nothing ticked, and clears the guess only on the ones ticked', async () => {
    const updateTransaction = vi.fn(async () => undefined);
    __setAppContextValue({
      accounts: [account],
      categories,
      transactionSplits: [],
      transactions: [txn('a', 'Synthetic grocer'), txn('b', 'Synthetic hardware'), txn('c', 'Synthetic baker')],
      confirmTransactionCategories: vi.fn(async () => 0),
      updateTransaction,
    });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Not these…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Synthetic hardware')).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Tick the ones that are wrong' });
    expect(submit).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Synthetic hardware/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Not .*: 1$/ }));

    await waitFor(() => expect(updateTransaction).toHaveBeenCalledTimes(1));
    expect(updateTransaction).toHaveBeenCalledWith('b', { category: '', categoryConfirmed: false, needsReview: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('tick all takes the guess off the whole group', async () => {
    const updateTransaction = vi.fn(async () => undefined);
    __setAppContextValue({
      accounts: [account],
      categories,
      transactionSplits: [],
      transactions: [txn('a', 'Synthetic grocer'), txn('b', 'Synthetic hardware')],
      confirmTransactionCategories: vi.fn(async () => 0),
      updateTransaction,
    });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Not these…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Tick all 2' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Not .*: 2$/ }));

    await waitFor(() => expect(updateTransaction).toHaveBeenCalledTimes(2));
  });

  it('cancel changes nothing', async () => {
    const updateTransaction = vi.fn(async () => undefined);
    __setAppContextValue({
      accounts: [account],
      categories,
      transactionSplits: [],
      transactions: [txn('a', 'Synthetic grocer')],
      confirmTransactionCategories: vi.fn(async () => 0),
      updateTransaction,
    });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Not these…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Synthetic grocer/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(updateTransaction).not.toHaveBeenCalled();
  });
});
