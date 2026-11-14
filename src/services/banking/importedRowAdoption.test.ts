import { describe, it, expect } from 'vitest';
import { resolveImportedRowAdoption } from './importedRowAdoption';

/**
 * CSV first, feed second — one payment, one row. The owner's partner
 * imported a year by CSV and then connected the feed over the same window;
 * every overlapping payment doubled. These pin the pairing rules, and
 * especially the one that separates this resolver from the transfer one:
 * same-day identicals pair by COUNT, because nothing observable tells them
 * apart. Every figure invented — this repo is public.
 */

const cand = (id: string, date: string, amount: number, account = 'acc-a') => ({
  external_transaction_id: id, account_id: account, date, amount,
});
const row = (id: string, date: string, amount: number, account = 'acc-a') => ({
  id, account_id: account, date, amount,
});

describe('same-day pairing, by count', () => {
  it('adopts the CSV twin of a feed row — category and description survive elsewhere', () => {
    const { inserts, adoptions } = resolveImportedRowAdoption(
      [cand('ext-1', '2026-06-02', 8300)],
      [row('t-1', '2026-06-02', 8300)]
    );
    expect(adoptions).toEqual([{ existingRowId: 't-1', candidate: cand('ext-1', '2026-06-02', 8300) }]);
    expect(inserts).toEqual([]);
  });

  it('three identical bills on one day: three candidates adopt three rows, none double', () => {
    const { inserts, adoptions } = resolveImportedRowAdoption(
      [cand('e1', '2026-06-22', -0.99), cand('e2', '2026-06-22', -0.99), cand('e3', '2026-06-22', -0.99)],
      [row('t1', '2026-06-22', -0.99), row('t2', '2026-06-22', -0.99), row('t3', '2026-06-22', -0.99)]
    );
    expect(adoptions).toHaveLength(3);
    expect(new Set(adoptions.map((a) => a.existingRowId)).size).toBe(3);
    expect(inserts).toEqual([]);
  });

  it('a genuinely NEW third payment inserts once the twins are spoken for', () => {
    const { inserts, adoptions } = resolveImportedRowAdoption(
      [cand('e1', '2026-06-22', -0.99), cand('e2', '2026-06-22', -0.99), cand('e3', '2026-06-22', -0.99)],
      [row('t1', '2026-06-22', -0.99), row('t2', '2026-06-22', -0.99)]
    );
    expect(adoptions).toHaveLength(2);
    expect(inserts.map((c) => c.external_transaction_id)).toEqual(['e3']);
  });

  it('never crosses accounts or amounts', () => {
    const { inserts, adoptions } = resolveImportedRowAdoption(
      [cand('e1', '2026-06-02', 4500)],
      [row('t1', '2026-06-02', 4500, 'acc-b'), row('t2', '2026-06-02', 4501)]
    );
    expect(adoptions).toEqual([]);
    expect(inserts).toHaveLength(1);
  });
});

describe('the ±1-day pass is strictly one-to-one', () => {
  it('adopts a next-day twin when it is the only reading', () => {
    const { adoptions } = resolveImportedRowAdoption(
      [cand('e1', '2026-06-23', -109.71)],
      [row('t1', '2026-06-22', -109.71)]
    );
    expect(adoptions).toEqual([{ existingRowId: 't1', candidate: cand('e1', '2026-06-23', -109.71) }]);
  });

  it('refuses a cross-day pairing with two candidates for one row — inserts instead', () => {
    // Two £15 payments a day either side of one imported £15 row: pairing
    // either would move a real payment's identity to the wrong day.
    const { inserts, adoptions } = resolveImportedRowAdoption(
      [cand('e1', '2026-06-21', -15), cand('e2', '2026-06-23', -15)],
      [row('t1', '2026-06-22', -15)]
    );
    expect(adoptions).toEqual([]);
    expect(inserts).toHaveLength(2);
  });

  it('same-day claims beat cross-day ones — the nearer reading wins', () => {
    const { adoptions, inserts } = resolveImportedRowAdoption(
      [cand('e1', '2026-06-22', -50), cand('e2', '2026-06-23', -50)],
      [row('t1', '2026-06-22', -50)]
    );
    // e1 takes its same-day twin in phase 1; e2's only near row is taken,
    // so it inserts rather than stealing.
    expect(adoptions).toEqual([{ existingRowId: 't1', candidate: cand('e1', '2026-06-22', -50) }]);
    expect(inserts.map((c) => c.external_transaction_id)).toEqual(['e2']);
  });
});

describe('a row the owner typed in himself is recognised the same way', () => {
  // Owner, 13 Nov 2026: a weekly payment the feed had skipped was added by
  // hand, and a later re-read from a date would offer the bank's own copy. A
  // hand-typed row has no bank id, exactly like an imported one, so the
  // bank's copy takes it over and nothing is doubled. Amounts invented.
  it("the bank's copy adopts the hand-typed row and is not inserted beside it", () => {
    const { inserts, adoptions } = resolveImportedRowAdoption(
      [cand('bank-1', '2026-10-02', -20)],
      [row('typed-by-hand', '2026-10-02', -20)]
    );
    expect(adoptions).toEqual([{ existingRowId: 'typed-by-hand', candidate: cand('bank-1', '2026-10-02', -20) }]);
    expect(inserts).toEqual([]);
  });

  it('a weekly payment a week away is a different payment and still arrives', () => {
    const { inserts, adoptions } = resolveImportedRowAdoption(
      [cand('bank-1', '2026-09-18', -20)],
      [row('typed-by-hand', '2026-10-02', -20)]
    );
    expect(adoptions).toEqual([]);
    expect(inserts).toHaveLength(1);
  });
});
