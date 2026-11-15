/**
 * A TAG OPENS ITS TRANSACTIONS (owner, 15 Nov 2026: "if I click in the box of
 * a tag, a list of those tagged transactions pops up on the screen"). Every
 * figure invented.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PreferencesProvider } from '../../../contexts/PreferencesContext';
import { ToastProvider } from '../../../contexts/ToastContext';
import { __setAppContextValue, __resetAppContextValue } from '../../../test/mocks/AppContextSupabase';
import Tags from '../Tags';
import type { Account, Transaction } from '../../../types';

const account: Account = {
  id: 'acct-1', name: 'Synthetic Account', type: 'current', balance: 0,
  currency: 'GBP', lastUpdated: new Date('2026-01-01'),
};

const txn = (id: string, description: string, tags: string[]): Transaction => ({
  id, date: new Date('2026-02-01'), description, amount: -12.5, type: 'expense',
  accountId: 'acct-1', category: '', tags,
});

const transactions = [
  txn('t-1', 'Synthetic follow-up', ['Need To DO']),
  txn('t-2', 'Synthetic untagged', []),
];

function setup(): void {
  __setAppContextValue({
    accounts: [account],
    categories: [],
    transactionSplits: [],
    transactions,
    tags: [
      { id: 'tag-1', name: 'Need To DO', color: '#6B7280', description: 'Synthetic tag' },
      { id: 'tag-2', name: 'Unused', color: '#6B7280' },
    ],
    getTagUsageCount: (name: string) => transactions.filter(t => t.tags?.includes(name)).length,
    getAllUsedTags: () => ['Need To DO'],
    addTag: vi.fn(),
    updateTag: vi.fn(),
    deleteTag: vi.fn(),
  });
}

const renderTags = () =>
  render(
    <MemoryRouter>
      <PreferencesProvider>
        <ToastProvider>
          <Tags />
        </ToastProvider>
      </PreferencesProvider>
    </MemoryRouter>
  );

afterEach(() => {
  __resetAppContextValue();
});

describe('Tags — a tag opens its transactions', () => {
  it('clicking anywhere in a tag’s box lists the transactions carrying it, and only those', async () => {
    setup();
    renderTags();
    fireEvent.click(screen.getAllByTestId('tag-row')[0]);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Tagged “Need To DO”/)).toBeInTheDocument();
    expect(within(dialog).getByText('Synthetic follow-up')).toBeInTheDocument();
    expect(within(dialog).queryByText('Synthetic untagged')).not.toBeInTheDocument();
  });

  it('the name is a button a keyboard can reach, saying what it opens', () => {
    setup();
    renderTags();
    expect(screen.getByRole('button', { name: 'Need To DO: show its 1 transaction' })).toBeEnabled();
  });

  it('a tag on no transaction opens nothing', () => {
    setup();
    renderTags();
    fireEvent.click(screen.getAllByTestId('tag-row')[1]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unused: show its 0 transactions' })).toBeDisabled();
  });

  it('edit and delete still do their own jobs without opening the list', () => {
    setup();
    renderTags();
    const row = screen.getAllByTestId('tag-row')[0];
    fireEvent.click(within(row).getAllByRole('button')[1]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
