import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QuickEditRowProvider } from './QuickEditRow';
import MobileQuickEditCard from './MobileQuickEditCard';
import type { Transaction } from '../types';

const mocks = vi.hoisted(() => ({
  updateTransaction: vi.fn(async () => {}),
  showError: vi.fn(),
  showSuccess: vi.fn(),
}));

const source: Transaction = {
  id: 'src',
  date: new Date('2026-09-21'),
  description: 'Two Way Sweep to account 00001234',
  amount: -28500,
  type: 'expense',
  accountId: 'acc-a',
  category: 'det-adjust',
  categoryConfirmed: false,
  cleared: false,
} as Transaction;

vi.mock('../contexts/AppContextSupabase', () => ({
  useApp: () => ({
    transactions: [source],
    accounts: [
      { id: 'acc-a', name: 'Coutts (General) - Current', type: 'checking', balance: 0, currency: 'GBP' },
      { id: 'acc-b', name: 'Coutts (Private)', type: 'checking', balance: 0, currency: 'GBP' },
    ],
    categories: [
      { id: 'type-reval', name: 'Revaluation', type: 'expense', level: 'type' },
      { id: 'sub-reval', name: 'Revaluation', type: 'expense', level: 'sub', parentId: 'type-reval' },
      { id: 'det-adjust', name: 'Account Adjustment', type: 'expense', level: 'detail', parentId: 'sub-reval' },
    ],
    getSubCategories: (parentId?: string) =>
      [{ id: 'sub-reval', name: 'Revaluation', type: 'expense', level: 'sub', parentId: 'type-reval' }].filter(c => c.parentId === parentId),
    getDetailCategories: (parentId?: string) =>
      [{ id: 'det-adjust', name: 'Account Adjustment', type: 'expense', level: 'detail', parentId: 'sub-reval' }].filter(c => c.parentId === parentId),
    updateTransaction: mocks.updateTransaction,
    linkTransferPair: vi.fn(async () => ({ a: {}, b: {} })),
    createTransferCounterpart: vi.fn(async () => ({ source: {}, counterpart: {} })),
    applyCategoryToUncategorized: vi.fn(async () => 0),
    confirmTransactionCategories: vi.fn(async () => 0),
    addTransaction: vi.fn(async () => {}),
    deleteTransaction: vi.fn(async () => {}),
  }),
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn(), showSuccess: mocks.showSuccess, showError: mocks.showError,
    showWarning: vi.fn(), showInfo: vi.fn(), dismissToast: vi.fn(),
  }),
}));

vi.mock('../hooks/useCurrencyDecimal', () => ({
  useCurrencyDecimal: () => ({
    formatCurrency: (n: number) => (Number(n) < 0 ? `(£${Math.abs(Number(n)).toFixed(2)})` : `£${Number(n).toFixed(2)}`),
  }),
}));

describe('the phone card editor — the register editor, stacked', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers every field the provider offers, under a caption, with the amount read off the row', () => {
    render(
      <QuickEditRowProvider transaction={source} onDismiss={vi.fn()}>
        <MobileQuickEditCard transaction={source} onFullEditor={vi.fn()} />
      </QuickEditRowProvider>
    );

    expect(screen.getByLabelText('Transaction date')).toBeInTheDocument();
    expect(screen.getByLabelText('Transaction description')).toHaveValue('Two Way Sweep to account 00001234');
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeInTheDocument();
    expect(screen.getByLabelText('Transaction notes')).toBeInTheDocument();
    expect(screen.getByText('(£28500.00)')).toBeInTheDocument();
    // The keyboard rhythm is the desktop's; a phone has no Enter to explain.
    expect(screen.queryByText(/Enter accepts/)).not.toBeInTheDocument();
    // The suggestion is shown as one, with the one-tap agreement beside it.
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('saves from the card exactly as the row saves', async () => {
    render(
      <QuickEditRowProvider transaction={source} onDismiss={vi.fn()}>
        <MobileQuickEditCard transaction={source} onFullEditor={vi.fn()} />
      </QuickEditRowProvider>
    );
    fireEvent.change(screen.getByLabelText('Transaction description'), { target: { value: 'Sweep to Private' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.updateTransaction).toHaveBeenCalledTimes(1));
    expect(mocks.updateTransaction.mock.calls[0][1]).toMatchObject({ description: 'Sweep to Private', needsReview: false });
  });

  describe('a run on a phone — the next row is shown whole', () => {
    // No category yet, and nothing the app suggested: the row a category
    // landing would have thrown the list open over.
    const unfiled: Transaction = { ...source, id: 'unfiled', description: 'CARD PAYMENT 4021', category: '' } as Transaction;

    it('lands Save & Next in the description, whichever field was last touched', async () => {
      const onNext = vi.fn();
      render(
        <QuickEditRowProvider transaction={source} onDismiss={vi.fn()} onNext={onNext} run="description-first">
          <MobileQuickEditCard transaction={source} onFullEditor={vi.fn()} />
        </QuickEditRowProvider>
      );
      // The person was last in the category box…
      fireEvent.focus(screen.getByRole('combobox', { name: 'Category' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save & Next' }));

      // …and the next row still opens on its description, nothing unfolded.
      await waitFor(() => expect(onNext).toHaveBeenCalledWith({ field: 'description', openCalendar: false }));
    });

    it('the desktop run still lands where the person was', async () => {
      const onNext = vi.fn();
      render(
        <QuickEditRowProvider transaction={source} onDismiss={vi.fn()} onNext={onNext}>
          <MobileQuickEditCard transaction={source} onFullEditor={vi.fn()} />
        </QuickEditRowProvider>
      );
      fireEvent.focus(screen.getByRole('combobox', { name: 'Category' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save & Next' }));

      await waitFor(() => expect(onNext).toHaveBeenCalledWith({ field: 'category', openCalendar: false }));
    });

    it('opens the category list on Return in the description, not before', () => {
      render(
        <QuickEditRowProvider transaction={unfiled} onDismiss={vi.fn()} onNext={vi.fn()} run="description-first">
          <MobileQuickEditCard transaction={unfiled} onFullEditor={vi.fn()} />
        </QuickEditRowProvider>
      );
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      fireEvent.keyDown(screen.getByLabelText('Transaction description'), { key: 'Enter' });

      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('Return on a row carrying a suggestion goes to Confirm, list closed', () => {
      render(
        <QuickEditRowProvider transaction={source} onDismiss={vi.fn()} onNext={vi.fn()} run="description-first">
          <MobileQuickEditCard transaction={source} onFullEditor={vi.fn()} />
        </QuickEditRowProvider>
      );
      fireEvent.keyDown(screen.getByLabelText('Transaction description'), { key: 'Enter' });

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
    });

    it('the desktop Enter still hands over Save & Next', () => {
      render(
        <QuickEditRowProvider transaction={unfiled} onDismiss={vi.fn()} onNext={vi.fn()}>
          <MobileQuickEditCard transaction={unfiled} onFullEditor={vi.fn()} />
        </QuickEditRowProvider>
      );
      fireEvent.keyDown(screen.getByLabelText('Transaction description'), { key: 'Enter' });

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save & Next' })).toHaveFocus();
    });
  });

  it('hands over to the full editor on request', () => {
    const onFullEditor = vi.fn();
    render(
      <QuickEditRowProvider transaction={source} onDismiss={vi.fn()}>
        <MobileQuickEditCard transaction={source} onFullEditor={onFullEditor} />
      </QuickEditRowProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Full editor' }));
    expect(onFullEditor).toHaveBeenCalledWith(source);
  });
});
