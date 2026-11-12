/**
 * Marking is a HOLDING state; only Finalize reconciles.
 *
 * The owner's complaint, in his words: "I press 'Mark All Cleared', press 'OK'
 * and the unreconciled disappears — basically doing the reconciliation. If I
 * come out, the account is reconciled, so what is the point of Finalize
 * Reconciliation?" The headline test below is that sentence turned into an
 * assertion: mark everything, walk away, and every screen still says the work
 * is outstanding.
 *
 * Every name and figure here is invented: this repo is public.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PreferencesProvider } from '../../contexts/PreferencesContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { NotificationProvider } from '../../contexts/NotificationContext';
import Reconciliation from '../Reconciliation';
import Accounts from '../Accounts';
import { __setAppContextValue, __resetAppContextValue } from '../../test/mocks/AppContextSupabase';
import type { Account, Transaction } from '../../types';

const ACCOUNT: Account = {
  id: 'acc-holding',
  name: 'Everyday Invented',
  type: 'current',
  balance: 0,
  currency: 'GBP',
  institution: 'Invented Bank',
  lastUpdated: new Date('2026-05-01'),
  openingBalance: 0,
  isActive: true,
  bankBalance: 40,
  bankBalanceDate: '2026-05-01',
};

const row = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  id,
  accountId: ACCOUNT.id,
  date: new Date('2026-05-04'),
  amount: 20,
  description: `Invented ${id}`,
  category: 'det-sundries',
  type: 'income',
  cleared: false,
  reconciled: false,
  ...over,
});

/**
 * The store's own rule for a mark, and nothing more: `cleared` moves,
 * `reconciled` does not. Written out literally rather than imported, so this
 * suite proves what the SCREENS do with an honest store rather than agreeing
 * with a helper it also depends on.
 */
const markingStore = (initial: Transaction[]) => {
  let transactions = initial;
  const setTransactionsCleared = vi.fn(async (ids: string[], cleared: boolean) => {
    const idSet = new Set(ids);
    transactions = transactions.map(t => (idSet.has(t.id) ? { ...t, cleared } : t));
    __setAppContextValue({ transactions });
  });
  return {
    setTransactionsCleared,
    current: () => transactions,
  };
};

/**
 * The store's rule for FINISHING: every mark becomes committed, and the count
 * of what changed comes back. Written out literally for the same reason as the
 * marking store above — these suites prove what the screens do with an honest
 * store, not what a shared helper believes.
 */
const finalizingStore = (initial: Transaction[]) => {
  let transactions = initial;
  const finalizeReconciliation = vi.fn(async () => {
    const committing = transactions.filter(t => t.cleared === true && t.reconciled !== true);
    transactions = transactions.map(t => (t.cleared === true ? { ...t, reconciled: true } : t));
    __setAppContextValue({ transactions });
    return committing.length;
  });
  return {
    finalizeReconciliation,
    current: () => transactions,
  };
};

const renderReconciliation = () =>
  render(
    <MemoryRouter initialEntries={[`/reconciliation?account=${ACCOUNT.id}`]}>
      <PreferencesProvider>
        <ToastProvider>
          {/* The page opens EditTransactionModal, which reads the notification
              context even while closed. */}
          <NotificationProvider>
            <Reconciliation />
          </NotificationProvider>
        </ToastProvider>
      </PreferencesProvider>
    </MemoryRouter>
  );

const renderAccountList = () =>
  render(
    <MemoryRouter initialEntries={['/reconciliation']}>
      <PreferencesProvider>
        <ToastProvider>
          <NotificationProvider>
            <Reconciliation />
          </NotificationProvider>
        </ToastProvider>
      </PreferencesProvider>
    </MemoryRouter>
  );

const renderAccounts = () =>
  render(
    <MemoryRouter initialEntries={['/accounts']}>
      <PreferencesProvider>
        <ToastProvider>
          <Accounts />
        </ToastProvider>
      </PreferencesProvider>
    </MemoryRouter>
  );

/** The figure under a stat column's label on the Accounts page. */
/**
 * The figure under a column heading ON AN ACCOUNT ROW.
 *
 * Scoped to `[data-account-columns]` — a row's grid — rather than taking the
 * first "Unreconciled" on the page. The band now carries a column-header strip
 * that says the same four words once above the rows, so the first match became
 * a heading whose next sibling is the NEXT heading: this asserted 'To Review'
 * where it meant '3'. The row is what the test was always about.
 */
const accountsStat = (label: string): string => {
  const row = document.querySelector('[data-account-columns]');
  if (!(row instanceof HTMLElement)) throw new Error('no account row rendered');
  const labelNode = within(row).getAllByText(label)[0];
  const value = labelNode.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`"${label}" has no figure under it`);
  return value.textContent ?? '';
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  __resetAppContextValue();
});

describe('Reconciliation — marking is a holding state', () => {
  it('HEADLINE: marking everything and leaving still shows the account as unreconciled', async () => {
    const store = markingStore([row('t1'), row('t2'), row('t3')]);
    __setAppContextValue({
      accounts: [ACCOUNT],
      transactions: store.current(),
      setTransactionsCleared: store.setTransactionsCleared,
      isLoading: false,
    });

    const marking = renderReconciliation();
    await act(async () => {
      fireEvent.click(screen.getByText('Mark all'));
    });

    // The store was asked to mark all three, and only to mark them.
    expect(store.setTransactionsCleared).toHaveBeenCalledWith(['t1', 't2', 't3'], true);
    expect(store.current().every(t => t.cleared === true)).toBe(true);
    expect(store.current().every(t => t.reconciled === false)).toBe(true);

    marking.unmount();

    // 1. The reconciliation account list — the screen the user comes back to.
    const list = renderAccountList();
    expect(await screen.findByText('3 unreconciled')).toBeInTheDocument();
    expect(screen.queryByText('All transactions ticked')).not.toBeInTheDocument();
    list.unmount();

    // 2. The Accounts page's Unreconciled column, which is where the owner
    //    noticed the lie in the first place.
    renderAccounts();
    await screen.findByRole('heading', { level: 3, name: ACCOUNT.name });
    expect(accountsStat('Unreconciled')).toBe('3');
  });

  it('keeps the marks when the screen is left and reopened', async () => {
    // The other half of "holding": walking away must not cost eight hundred
    // ticks either. The marks are persisted on the way in, not on the way out.
    const store = markingStore([row('t1'), row('t2')]);
    __setAppContextValue({
      accounts: [ACCOUNT],
      transactions: store.current(),
      setTransactionsCleared: store.setTransactionsCleared,
      isLoading: false,
    });

    const first = renderReconciliation();
    await act(async () => {
      fireEvent.click(screen.getByText('Mark all'));
    });
    first.unmount();

    renderReconciliation();
    const marks = await screen.findAllByTitle('Unmark this transaction');
    expect(marks).toHaveLength(2);
    expect(marks[0]).toHaveTextContent('C');
  });

  it('fires no confirmation popup when marking in bulk', async () => {
    const store = markingStore([row('t1'), row('t2')]);
    const confirmSpy = vi.spyOn(window, 'confirm');
    __setAppContextValue({
      accounts: [ACCOUNT],
      transactions: store.current(),
      setTransactionsCleared: store.setTransactionsCleared,
      isLoading: false,
    });

    renderReconciliation();
    await act(async () => {
      fireEvent.click(screen.getByText('Mark all'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Unmark all'));
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

/**
 * The working list is what is not yet R.
 *
 * The owner's second complaint, from live testing of the shipped C/R model:
 * "Mark all empties the unmarked view — the rows vanish from the very list I am
 * working." They vanished because the middle filter meant UNMARKED, so a mark
 * was an exit. Under the holding-state model the only exit is Finalize: a
 * marked row stays in the work, wearing its C, until a reconciliation commits
 * it.
 */
describe('Reconciliation — the working list keeps its marks', () => {
  it('opens on the work', () => {
    __setAppContextValue({
      accounts: [ACCOUNT],
      transactions: [row('t1'), row('t2', { cleared: true, reconciled: true })],
      isLoading: false,
    });
    renderReconciliation();

    expect(screen.getByText('To reconcile')).toHaveAttribute('aria-pressed', 'true');
    // The committed row is not in the way of the work; it is one click away.
    expect(screen.getByText('Invented t1')).toBeInTheDocument();
    expect(screen.queryByText('Invented t2')).not.toBeInTheDocument();
  });

  it('HEADLINE: Mark all leaves every row on screen, wearing its C', async () => {
    const store = markingStore([row('t1'), row('t2'), row('t3')]);
    __setAppContextValue({
      accounts: [ACCOUNT],
      transactions: store.current(),
      setTransactionsCleared: store.setTransactionsCleared,
      isLoading: false,
    });
    renderReconciliation();

    await act(async () => {
      fireEvent.click(screen.getByText('Mark all'));
    });

    // Nothing left the list. The badges changed, and that is all.
    const marks = screen.getAllByTitle('Unmark this transaction');
    expect(marks).toHaveLength(3);
    marks.forEach(mark => expect(mark).toHaveTextContent('C'));
    expect(screen.getByText('Invented t1')).toBeInTheDocument();
    expect(screen.getByText('Invented t3')).toBeInTheDocument();
    // And Unmark all is the way back, still acting on what is in view.
    await act(async () => {
      fireEvent.click(screen.getByText('Unmark all'));
    });
    expect(screen.getAllByTitle('Mark this transaction')).toHaveLength(3);
  });

  it('only finalizing empties it — the rows turn R and leave together', async () => {
    // Two marked rows of 20 against a closing balance of 40: balanced, so the
    // dialog offers the completing step.
    const store = finalizingStore([
      row('t1', { cleared: true }),
      row('t2', { cleared: true }),
    ]);
    __setAppContextValue({
      accounts: [ACCOUNT],
      transactions: store.current(),
      finalizeReconciliation: store.finalizeReconciliation,
      isLoading: false,
    });

    const session = renderReconciliation();
    // Before: the work is on screen.
    expect(screen.getAllByTitle('Unmark this transaction')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    fireEvent.click(screen.getByRole('button', { name: /Finalise Reconciliation/ }));
    await act(async () => {
      fireEvent.click(screen.getByText('Complete Reconciliation'));
    });

    expect(store.current().every(t => t.reconciled === true)).toBe(true);
    session.unmount();

    // Coming back: the working list is empty, and says which emptiness it is
    // rather than sending the user hunting for rows nothing lost.
    renderReconciliation();
    expect(await screen.findByText('Nothing left to reconcile on this account.')).toBeInTheDocument();
    expect(screen.queryByTitle('Unmark this transaction')).not.toBeInTheDocument();

    // They are not gone, they are done: All still holds them, marked R.
    fireEvent.click(screen.getByText('All'));
    const committed = screen.getAllByTitle(/Reconciled in a finished reconciliation/);
    expect(committed).toHaveLength(2);
    committed.forEach(mark => expect(mark).toHaveTextContent('R'));
  });
});

describe('Reconciliation — finalizing is gated on a confirmed balance', () => {
  const finalizeReconciliation = vi.fn(async () => 2);

  const openAccount = (account: Account = ACCOUNT, transactions: Transaction[] = [row('t1', { cleared: true })]) => {
    __setAppContextValue({
      accounts: [account],
      transactions,
      finalizeReconciliation,
      isLoading: false,
    });
    return renderReconciliation();
  };

  beforeEach(() => {
    finalizeReconciliation.mockClear();
  });

  it('blocks Finalize until the balance is confirmed, and says why where it is refused', () => {
    openAccount();

    const finalize = screen.getByRole('button', { name: /Finalise Reconciliation/ });
    expect(finalize).toBeDisabled();
    // Named as a consequence, beside the box that has to be confirmed.
    expect(
      screen.getByText(/Confirm the closing balance to finish\. Until you do, your marks stay a working list/)
    ).toBeInTheDocument();
    // And the escape hatch is gone for good.
    expect(screen.queryByText('Finalise Anyway')).not.toBeInTheDocument();
  });

  it('confirming the shown figure opens the gate, and finalize sends that figure', async () => {
    // Two marked rows of 20 against a bank balance of 40: balanced, so the
    // modal offers the completing step rather than an adjustment.
    openAccount(ACCOUNT, [row('t1', { cleared: true }), row('t2', { cleared: true })]);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    const finalize = screen.getByRole('button', { name: /Finalise Reconciliation/ });
    expect(finalize).toBeEnabled();
    fireEvent.click(finalize);
    await act(async () => {
      fireEvent.click(screen.getByText('Complete Reconciliation'));
    });

    expect(finalizeReconciliation).toHaveBeenCalledTimes(1);
    const [accountId, endingBalance, day] = finalizeReconciliation.mock.calls[0];
    expect(accountId).toBe(ACCOUNT.id);
    expect(endingBalance).toBe(40);
    expect(day).toBeInstanceOf(Date);
  });

  it('confirms a zero balance — an account swept to zero is still reconcilable', async () => {
    // The distinction the UI holds is confirmed-vs-unconfirmed, never
    // zero-vs-set: a real account in this product is swept to zero nightly and
    // its correct statement balance is exactly £0.
    // Nothing marked, so the cleared balance is £0 too: balanced at zero.
    openAccount({ ...ACCOUNT, bankBalance: 0 }, [row('t1')]);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByRole('button', { name: /Finalise Reconciliation/ })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /Finalise Reconciliation/ }));
    await act(async () => {
      fireEvent.click(screen.getByText('Complete Reconciliation'));
    });

    expect(finalizeReconciliation.mock.calls[0][1]).toBe(0);
  });

  it('editing the figure after confirming takes the confirmation back', () => {
    openAccount();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByRole('button', { name: /Finalise Reconciliation/ })).toBeEnabled();

    fireEvent.click(screen.getByTitle('Click to change or remove'));
    fireEvent.change(screen.getByLabelText('Closing balance'), { target: { value: '55' } });

    expect(screen.getByRole('button', { name: /Finalise Reconciliation/ })).toBeDisabled();
  });

  it('Enter in the box confirms the figure that was typed', () => {
    const updateAccount = vi.fn();
    __setAppContextValue({
      accounts: [ACCOUNT],
      transactions: [row('t1', { cleared: true })],
      updateAccount,
      finalizeReconciliation,
      isLoading: false,
    });
    renderReconciliation();

    fireEvent.click(screen.getByTitle('Click to change or remove'));
    const input = screen.getByLabelText('Closing balance');
    fireEvent.change(input, { target: { value: '61.25' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Recorded on the account AND agreed to, in one keystroke.
    expect(updateAccount).toHaveBeenCalledWith(ACCOUNT.id, expect.objectContaining({ bankBalance: 61.25 }));
    expect(screen.getByRole('button', { name: /Finalise Reconciliation/ })).toBeEnabled();
  });

  it('starts from the last reconciliation when the bank has said nothing since', () => {
    // Money's starting balance. Still a suggestion — it is not confirmed until
    // the user says so.
    openAccount({
      ...ACCOUNT,
      bankBalance: null,
      bankBalanceDate: null,
      lastReconciledDate: new Date('2026-04-30'),
      lastReconciledBalance: 33.33,
    });

    expect(screen.getByText('£33.33')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Finalise Reconciliation/ })).toBeDisabled();
    expect(screen.getByText(/Last reconciled: 30\/04\/2026 · ending balance £33\.33/)).toBeInTheDocument();
  });

  it('an unbalanced account still gets the adjustment step, and still needs the confirmation', async () => {
    // The adjustment is computed FROM the confirmed figure, so it cannot be
    // reached without one.
    __setAppContextValue({
      accounts: [{ ...ACCOUNT, bankBalance: 100 }],
      transactions: [row('t1', { cleared: true, amount: 20 })],
      finalizeReconciliation,
      isLoading: false,
    });
    renderReconciliation();

    expect(screen.getByRole('button', { name: /Finalise Reconciliation/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    fireEvent.click(screen.getByRole('button', { name: /Finalise Reconciliation/ }));

    const dialog = screen.getByText('Finalise Reconciliation', { selector: 'h2' }).parentElement!
      .parentElement as HTMLElement;
    expect(within(dialog).getByText('Create Adjustment')).toBeInTheDocument();
    // Bank 100 − cleared 20 = 80 to explain.
    expect(within(dialog).getByText('£80.00')).toBeInTheDocument();
  });
});
