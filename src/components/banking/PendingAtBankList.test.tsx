import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import PendingAtBankList from './PendingAtBankList';
import type { PendingAtBank } from '../../services/banking/pendingAtBank';

vi.mock('../../hooks/useCurrencyDecimal', () => ({
  useCurrencyDecimal: () => ({
    formatCurrency: (n: number) => (Number(n) < 0 ? `(£${Math.abs(Number(n)).toFixed(2)})` : `£${Number(n).toFixed(2)}`),
  }),
}));

const pending: PendingAtBank = {
  items: [
    { date: '2026-11-09', description: 'CAFE ON THE CORNER', amount: -3.2 },
    { date: null, description: 'REFUND FROM A SHOP', amount: 43.2 },
  ],
  total: 40,
  asOf: '2026-11-10T09:07:00.000Z',
};

describe('PendingAtBankList', () => {
  it('lists what the bank has not posted, says what they are, and totals them', () => {
    render(<PendingAtBankList pending={pending} currency="GBP" />);

    const section = screen.getByRole('region', { name: 'Pending at the bank' });
    expect(within(section).getByText(/2 items the bank has authorised but not yet posted/)).toBeInTheDocument();
    expect(within(section).getByText(/Not in your ledger and not counted in any balance here/)).toBeInTheDocument();

    const rows = within(section).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('CAFE ON THE CORNER');
    expect(rows[0]).toHaveTextContent('(£3.20)');
    expect(rows[1]).toHaveTextContent('REFUND FROM A SHOP');
    expect(rows[1]).toHaveTextContent('£43.20');
    expect(within(section).getByText('Pending total').parentElement).toHaveTextContent('£40.00');
  });

  it('is not a set of transactions: nothing in it can be pressed', () => {
    render(<PendingAtBankList pending={pending} />);
    const section = screen.getByRole('region', { name: 'Pending at the bank' });
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    expect(within(section).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(section).queryByRole('link')).not.toBeInTheDocument();
  });

  it('says nothing about a difference in the register, where there is none to explain', () => {
    render(<PendingAtBankList pending={pending} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says so when the pending items are the whole difference', () => {
    render(<PendingAtBankList pending={pending} difference={40} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'These pending items account for the whole difference. Nothing is missing from your ledger'
    );
  });

  it('claims nothing about a difference it does not exactly equal', () => {
    // An issuer's balance may or may not count pending (American Express does
    // not), so a part-share is not this list's to assert.
    render(<PendingAtBankList pending={pending} difference={55.5} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/of the difference/)).not.toBeInTheDocument();
  });

  it('sets out the bank’s balance and where it lands once these post', () => {
    render(<PendingAtBankList pending={pending} difference={55.5} bankBalance={-100} />);
    const section = screen.getByRole('region', { name: 'Pending at the bank' });
    expect(within(section).getByText('The bank’s reported balance').parentElement).toHaveTextContent('(£100.00)');
    // −100.00 + 40.00, in Decimal.
    expect(within(section).getByText('If these post as shown').parentElement).toHaveTextContent('(£60.00)');
  });

  it('shows no such statement in the register, which has no bank figure to start from', () => {
    render(<PendingAtBankList pending={pending} />);
    expect(screen.queryByText('The bank’s reported balance')).not.toBeInTheDocument();
  });

  it('draws every row it counts', () => {
    const many = {
      ...pending,
      items: Array.from({ length: 30 }, (_unused, index) => ({ date: '2026-11-09', description: `ROW ${index}`, amount: -1 })),
      total: -30,
    };
    render(<PendingAtBankList pending={many} />);
    const section = screen.getByRole('region', { name: 'Pending at the bank' });
    expect(within(section).getAllByRole('listitem')).toHaveLength(30);
    expect(within(section).getByRole('list').className).not.toMatch(/max-h|overflow-y/);
  });

  it('stays quiet about a difference of nothing', () => {
    render(<PendingAtBankList pending={pending} difference={0} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('draws nothing for an empty reading', () => {
    const { container } = render(<PendingAtBankList pending={{ ...pending, items: [], total: 0 }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
