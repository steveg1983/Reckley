import { describe, expect, it } from 'vitest';
import {
  MAX_PENDING_ITEMS,
  PENDING_UNAVAILABLE,
  pendingColumns,
  pendingFromColumns,
  pendingFromFeed,
  pendingTotal,
} from './pendingAtBank';

describe('pendingFromFeed', () => {
  it('keeps each row in the app’s sign: a card purchase is negative, a refund positive', () => {
    // Card convention: positive = money out of the card.
    const snapshot = pendingFromFeed(
      [
        { amount: 12.5, description: 'CAFE NERO', timestamp: '2026-11-09T08:14:00Z' },
        { amount: -40, description: '  REFUND SHOP  ', timestamp: '2026-11-08T00:00:00+00:00' },
      ],
      { cardSigned: true }
    );

    expect(snapshot).toEqual({
      status: 'reported',
      items: [
        { date: '2026-11-09', description: 'CAFE NERO', amount: -12.5 },
        { date: '2026-11-08', description: 'REFUND SHOP', amount: 40 },
      ],
    });
  });

  it('leaves an account feed’s sign alone', () => {
    const snapshot = pendingFromFeed([{ amount: -9.99, description: 'DD' }], { cardSigned: false });
    expect(snapshot).toEqual({ status: 'reported', items: [{ date: null, description: 'DD', amount: -9.99 }] });
  });

  it('drops a row with no usable amount, and names one with no words', () => {
    const snapshot = pendingFromFeed(
      [{ amount: Number.NaN, description: 'x' }, { description: 'no amount' }, { amount: '7' }, { amount: 5, merchant_name: 'Shop Ltd' }, { amount: 1 }],
      { cardSigned: true }
    );
    expect(snapshot).toEqual({
      status: 'reported',
      items: [
        { date: null, description: 'Shop Ltd', amount: -5 },
        { date: null, description: 'Pending transaction', amount: -1 },
      ],
    });
  });

  it('reports an empty feed as nothing pending, and never a negative zero', () => {
    expect(pendingFromFeed([], { cardSigned: true })).toEqual({ status: 'reported', items: [] });
    const zero = pendingFromFeed([{ amount: 0, description: 'z' }], { cardSigned: true });
    expect(zero.status === 'reported' && Object.is(zero.items[0].amount, -0)).toBe(false);
  });

  it('cuts a list no person would read', () => {
    const rows = Array.from({ length: MAX_PENDING_ITEMS + 25 }, (_unused, index) => ({ amount: 1, description: `row ${index}` }));
    const snapshot = pendingFromFeed(rows, { cardSigned: true });
    expect(snapshot.status === 'reported' && snapshot.items.length).toBe(MAX_PENDING_ITEMS);
  });
});

describe('pendingTotal', () => {
  it('sums in Decimal — 0.1 + 0.2 is 0.3 here', () => {
    expect(pendingTotal([{ amount: 0.1 }, { amount: 0.2 }])).toBe(0.3);
    expect(pendingTotal([{ amount: -12.5 }, { amount: 40 }, { amount: -0.3 }])).toBe(27.2);
    expect(pendingTotal([])).toBe(0);
  });
});

describe('pendingColumns', () => {
  const asOf = '2026-11-10T09:07:00.000Z';

  it('writes the items and the moment they were read', () => {
    const items = [{ date: '2026-11-09', description: 'CAFE', amount: -3.2 }];
    expect(pendingColumns({ status: 'reported', items }, asOf)).toEqual({ pending_items: items, pending_as_of: asOf });
  });

  it('clears both when the bank did not say — stale rows explain nothing', () => {
    expect(pendingColumns(PENDING_UNAVAILABLE, asOf)).toEqual({ pending_items: null, pending_as_of: null });
  });
});

describe('pendingFromColumns', () => {
  const asOf = '2026-11-10T09:07:00.000Z';

  it('reads a stored row back with its total', () => {
    expect(
      pendingFromColumns({
        pending_items: [
          { date: '2026-11-09', description: 'CAFE', amount: -3.2 },
          { date: null, description: 'REFUND', amount: 10 },
        ],
        pending_as_of: asOf,
      })
    ).toEqual({
      items: [
        { date: '2026-11-09', description: 'CAFE', amount: -3.2 },
        { date: null, description: 'REFUND', amount: 10 },
      ],
      total: 6.8,
      asOf,
    });
  });

  it('shows only the items it can vouch for', () => {
    const pending = pendingFromColumns({
      pending_items: [{ description: 'no amount' }, 'nonsense', { date: 'not a day', description: 'OK', amount: -1 }],
      pending_as_of: asOf,
    });
    expect(pending).toEqual({ items: [{ date: null, description: 'OK', amount: -1 }], total: -1, asOf });
  });

  it('tells the client nothing for no pending items, or a row not wholly there', () => {
    expect(pendingFromColumns({ pending_items: [], pending_as_of: asOf })).toBeNull();
    expect(pendingFromColumns({ pending_items: null, pending_as_of: null })).toBeNull();
    expect(pendingFromColumns({ pending_items: [{ description: 'x', amount: 1 }], pending_as_of: null })).toBeNull();
    expect(pendingFromColumns({ pending_items: 'oops', pending_as_of: asOf })).toBeNull();
    expect(pendingFromColumns({})).toBeNull();
  });
});
