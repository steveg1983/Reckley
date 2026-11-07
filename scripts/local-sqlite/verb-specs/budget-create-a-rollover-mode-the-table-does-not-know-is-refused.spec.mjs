import { USER, WEEKLY_SHOP, budgetsOwnedBy } from './_shared.mjs';

const NEW = 'b0000000-0000-0000-0000-0000000000f9';

// The other half of budgets_rollover_check: the four words are the whole
// vocabulary. The old fold's 'all' / 'percentage' / 'fixed' were settings
// in localStorage, never a column value, and a row arriving with one is
// refused by the TABLE on both engines rather than read as one of the four.
export default {
  invariant: 'B-3',
  title: 'a rollover mode outside the four is refused by both tables, and nothing is stored',
  design: 'budgets_rollover_check — cloud migration 20261107203000 and scripts/local-sqlite/schema.sql, the same predicate on both engines',
  consequence: 'a word the evaluation reads as "none" on one engine and the table stores on the other would carry nothing on the page and something in the file',
  parity: 'match',

  command: {
    verb: 'create_budget',
    payload: {
      id: NEW,
      user_id: USER,
      name: 'Old fold',
      amount: '10.00',
      period: 'monthly',
      rollover_mode: 'all',
      category: WEEKLY_SHOP,
      start_date: '2026-11-01',
    },
  },

  expect: { outcome: 'refused', error: 'budgets_rollover_check' },

  state: [
    budgetsOwnedBy(USER, '0'),
  ],
};
