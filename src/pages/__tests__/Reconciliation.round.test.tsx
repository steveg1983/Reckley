/**
 * The reconcile ROUND, and the finalize button that stopped lying.
 *
 * Owner, 19 Aug, after the review round shipped: "Can you check if this is
 * how it also works when reconciling an account / accounts" — it did not,
 * and now does: from the FOCUSED accounts list, finishing (or backing out
 * of) one account's reconciliation returns to that list, still focused, to
 * pick the next; with nothing left anywhere the round is over and the
 * ordinary Accounts page stands.
 *
 * And the same evening's bug, in his words: "when I press 'complete
 * reconciliation' it has been freezing and nothing happening. I pressed it
 * about 10-20 times and eventually it kind of completed." A first-ever
 * finalize converts thousands of rows and takes real seconds server-side;
 * the button now says "Completing…", refuses seconds, and a stack of
 * presses fires exactly ONE write.
 *
 * Every name and figure here is invented: this repo is public.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PreferencesProvider } from '../../contexts/PreferencesContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { NotificationProvider } from '../../contexts/NotificationContext';
import Reconciliation from '../Reconciliation';
import Accounts from '../Accounts';
import { __setAppContextValue, __resetAppContextValue } from '../../test/mocks/AppContextSupabase';
import type { Account, Transaction } from '../../types';

const ACCOUNT: Account = {
  id: 'acc-round',
  name: 'Roundabout Invented',
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
  cleared: true,
  reconciled: false,
  ...over,
});

const AccountsProbe = (): React.JSX.Element => {
  const location = useLocation();
  return <div data-testid="accounts-probe">{location.search}</div>;
};

const renderRound = (search: string) =>
  render(
    <MemoryRouter initialEntries={[`/reconciliation${search}`]}>
      <PreferencesProvider>
        <ToastProvider>
          <NotificationProvider>
            <Routes>
              <Route path="/reconciliation" element={<Reconciliation />} />
              <Route path="/accounts" element={<AccountsProbe />} />
            </Routes>
          </NotificationProvider>
        </ToastProvider>
      </PreferencesProvider>
    </MemoryRouter>
  );

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  __resetAppContextValue();
});

describe('Reconciliation — the round from the focused accounts list', () => {
  it('finishing returns to the focused list, to pick the next account', async () => {
    __setAppContextValue({
      accounts: [ACCOUNT],
      transactions: [row('t1'), row('t2')],
      finalizeReconciliation: vi.fn(async () => 2),
      isLoading: false,
    });

    renderRound(`?account=${ACCOUNT.id}&from=accounts&back=accounts-reconcile`);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    fireEvent.click(screen.getByRole('button', { name: /Finalise Reconciliation/ }));
    await act(async () => {
      fireEvent.click(screen.getByText('Complete Reconciliation'));
    });

    expect(screen.getByTestId('accounts-probe')).toHaveTextContent('focus=reconcile');
  });

  it('backing out mid-account also returns to the focused list — it is where the user came from', () => {
    __setAppContextValue({
      accounts: [ACCOUNT],
      transactions: [row('t1')],
      isLoading: false,
    });

    renderRound(`?account=${ACCOUNT.id}&from=accounts&back=accounts-reconcile`);
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));

    expect(screen.getByTestId('accounts-probe')).toHaveTextContent('focus=reconcile');
  });

  it('without the marker, leaving goes to the ordinary Accounts page, exactly as before', () => {
    __setAppContextValue({
      accounts: [ACCOUNT],
      transactions: [row('t1')],
      isLoading: false,
    });

    renderRound(`?account=${ACCOUNT.id}&from=accounts`);
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));

    expect(screen.getByTestId('accounts-probe')).not.toHaveTextContent('focus');
  });
});

describe('Reconciliation — Complete refuses seconds while the write is in flight', () => {
  it('says "Completing…", disables, and a stack of presses fires ONE write', async () => {
    let release: (value: number) => void = () => {};
    const finalizeReconciliation = vi.fn(
      () => new Promise<number>(resolve => { release = resolve; })
    );
    __setAppContextValue({
      accounts: [ACCOUNT],
      transactions: [row('t1'), row('t2')],
      finalizeReconciliation,
      isLoading: false,
    });

    renderRound(`?account=${ACCOUNT.id}`);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    fireEvent.click(screen.getByRole('button', { name: /Finalise Reconciliation/ }));
    fireEvent.click(screen.getByText('Complete Reconciliation'));

    // In flight: the button says what it is doing and refuses more presses —
    // the owner's 7,199-row finalize took seconds and got pressed 10-20
    // times, each press another RPC queueing behind the first one's locks.
    const busy = await screen.findByRole('button', { name: 'Completing…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    fireEvent.click(busy);
    expect(finalizeReconciliation).toHaveBeenCalledTimes(1);

    await act(async () => { release(2); });
    expect(finalizeReconciliation).toHaveBeenCalledTimes(1);
  });
});

describe('Accounts — ?focus=reconcile resumes the round', () => {
  const OTHER: Account = {
    ...ACCOUNT, id: 'acc-clean', name: 'Clean Invented', institution: 'Other Bank',
  };

  const renderAccountsWith = (search: string) =>
    render(
      <MemoryRouter initialEntries={[`/accounts${search}`]}>
        <PreferencesProvider>
          <ToastProvider>
            <Accounts />
          </ToastProvider>
        </PreferencesProvider>
      </MemoryRouter>
    );

  it('while an account still carries unreconciled work', async () => {
    __setAppContextValue({
      accounts: [ACCOUNT, OTHER],
      transactions: [
        row('t1', { cleared: false }),
        row('t2', { accountId: OTHER.id, reconciled: true }),
      ],
      isLoading: false,
    });

    renderAccountsWith('?focus=reconcile');
    await screen.findByRole('button', { name: /Showing to reconcile — show all/ });
    expect(screen.getByRole('heading', { level: 3, name: ACCOUNT.name })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: OTHER.name })).not.toBeInTheDocument();
  });

  it('with everything reconciled, the round is over — the ordinary page', async () => {
    __setAppContextValue({
      accounts: [ACCOUNT, OTHER],
      transactions: [
        row('t1', { reconciled: true }),
        row('t2', { accountId: OTHER.id, reconciled: true }),
      ],
      isLoading: false,
    });

    renderAccountsWith('?focus=reconcile');
    await screen.findByRole('heading', { level: 3, name: ACCOUNT.name });
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 3, name: OTHER.name })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Showing to reconcile — show all/ })).not.toBeInTheDocument();
  });
});
