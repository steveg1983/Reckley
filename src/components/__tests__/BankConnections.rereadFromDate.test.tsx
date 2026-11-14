/**
 * A RE-READ FROM A DAY THE OWNER CHOOSES.
 *
 * Owner, 13 Nov 2026. A weekly payment the feed had skipped six weeks before
 * left an account one payment short, and he asked the obvious question: "if I
 * re-synced the bank, shouldn't it bring in the missing amount?" It should.
 * The bank would have served it; nothing in the app asked further back than
 * thirty days.
 *
 * What these hold: the date row opens beside the old catch-up, stops at what a
 * bank serves, sends the day named through the transactions-only path, and
 * then SAYS what the re-read did — including when it found nothing new.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { earliestRereadDay } from '../../services/banking/syncWindow';
import { formatDate } from '../../utils/dateFormatter';

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: async () => 'test-token' })
}));
vi.mock('../BankingOpsAlertStatsCard', () => ({ default: () => null }));
vi.mock('../banking/LinkBankAccountsModal', () => ({ default: () => null }));

const syncTransactionsOnly = vi.fn();
const syncConnection = vi.fn();

const connection = {
  id: 'conn-1',
  provider: 'truelayer',
  institutionId: 'inst-1',
  institutionName: 'Synthetic Bank',
  status: 'connected',
  accounts: [],
  accountsCount: 1,
  lastSync: new Date('2026-11-13T09:00:00Z'),
};

vi.mock('../../services/bankConnectionService', () => ({
  bankConnectionService: {
    setAuthTokenProvider: vi.fn(),
    refreshConnections: async () => undefined,
    getConnections: () => [connection],
    refreshConfigStatus: async () => undefined,
    getConfigStatus: () => ({ plaid: false, trueLayer: true }),
    getInstitutions: async () => [],
    syncTransactionsOnly: (...args: unknown[]) => syncTransactionsOnly(...args),
    syncConnection: (...args: unknown[]) => syncConnection(...args),
  }
}));

import BankConnections from '../BankConnections';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const openDateRow = async (): Promise<HTMLInputElement> => {
  render(<BankConnections />);
  const opener = await screen.findByRole('button', { name: 'From a date…' });
  fireEvent.click(opener);
  return screen.getByLabelText('Re-read from') as HTMLInputElement;
};

describe('re-read from a date', () => {
  it('is closed until asked for, and the old one-press catch-up is still there', async () => {
    render(<BankConnections />);
    expect(await screen.findByRole('button', { name: 'Re-read 30 days' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Re-read from')).toBeNull();
    expect(screen.getByRole('button', { name: 'From a date…' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('the date stops where a bank stops serving, and at today', async () => {
    const input = await openDateRow();
    expect(input.min).toBe(earliestRereadDay(new Date()));
    expect(input.max).toBe(new Date().toISOString().slice(0, 10));
    // It opens on the old catch-up's day, so pressing Re-read at once is the
    // same thirty days as before.
    expect(input.value >= input.min && input.value <= input.max).toBe(true);
  });

  it('sends the day named through the transactions-only path and says what came back', async () => {
    syncTransactionsOnly.mockResolvedValue({
      success: true, accountsUpdated: 0, transactionsImported: 1,
      alreadyHeld: 30, matchedToOwnRows: 1, errors: []
    });
    const input = await openDateRow();
    const day = earliestRereadDay(new Date());
    fireEvent.change(input, { target: { value: day } });
    fireEvent.click(screen.getByRole('button', { name: 'Re-read' }));

    await waitFor(() => expect(syncTransactionsOnly).toHaveBeenCalledWith('conn-1', { startDate: day }));
    expect(syncConnection).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(
      `Re-read from ${formatDate(day)}: 1 new transaction added, 30 already in your ledger, ` +
      '1 matched to a row you had entered yourself.'
    );
    // The row closes once it has been used.
    expect(screen.queryByLabelText('Re-read from')).toBeNull();
  });

  it('a re-read that finds nothing new says so; it does not fall silent', async () => {
    syncTransactionsOnly.mockResolvedValue({
      success: true, accountsUpdated: 0, transactionsImported: 0, alreadyHeld: 12, matchedToOwnRows: 0, errors: []
    });
    await openDateRow();
    fireEvent.click(screen.getByRole('button', { name: 'Re-read' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/nothing new, 12 already in your ledger\./);
  });

  it('a start the server refuses as too old names the limit, not "sync incomplete"', async () => {
    syncTransactionsOnly.mockResolvedValue({
      success: false, accountsUpdated: 0, transactionsImported: 0, errors: ['refused'], code: 'start_too_old'
    });
    await openDateRow();
    fireEvent.click(screen.getByRole('button', { name: 'Re-read' }));

    expect(await screen.findByText('That date is too far back')).toBeInTheDocument();
    expect(screen.queryByText(/Bank sync incomplete/)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('Cancel closes the row and reads nothing', async () => {
    await openDateRow();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Re-read from')).toBeNull();
    expect(syncTransactionsOnly).not.toHaveBeenCalled();
  });
});
