import { describe, it, expect } from 'vitest';
import { describeReread } from './rereadOutcome';
import { formatDate } from './dateFormatter';

describe('what a re-read did, in a sentence', () => {
  const from = formatDate('2026-10-01');

  it('names every part that is not zero', () => {
    expect(describeReread('2026-10-01', { transactionsImported: 2, alreadyHeld: 31, matchedToOwnRows: 1 }))
      .toBe(`Re-read from ${from}: 2 new transactions added, 31 already in your ledger, 1 matched to a row you had entered yourself.`);
  });

  it('a re-read that found nothing new says so; it does not fall silent', () => {
    expect(describeReread('2026-10-01', { transactionsImported: 0, alreadyHeld: 40 }))
      .toBe(`Re-read from ${from}: nothing new, 40 already in your ledger.`);
    expect(describeReread('2026-10-01', { transactionsImported: 0 }))
      .toBe(`Re-read from ${from}: nothing new.`);
  });

  it('one is one: singular for a single transaction and a single row', () => {
    expect(describeReread('2026-10-01', { transactionsImported: 1, matchedToOwnRows: 3 }))
      .toBe(`Re-read from ${from}: 1 new transaction added, 3 matched to rows you had entered yourself.`);
  });
});
