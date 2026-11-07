import { USER, WEEKLY_SHOP, budgetsOwnedBy } from './_shared.mjs';

const NEW = 'b0000000-0000-0000-0000-0000000000fb';

// The other half of budgets_pace_check: two words are the whole vocabulary,
// and a third is refused by the TABLE on both engines rather than read as
// one of the two.
export default {
  invariant: 'B-3',
  title: 'a pace shape outside the two is refused by both tables, and nothing is stored',
  design: 'budgets_pace_check — cloud migration 20261107213000 and scripts/local-sqlite/schema.sql, the same predicate on both engines',
  consequence: 'a word the page reads as "even" on one engine and the table stores on the other would pace the budget differently on each',
  parity: 'match',

  command: {
    verb: 'create_budget',
    payload: {
      id: NEW,
      user_id: USER,
      name: 'Lumpy',
      amount: '10.00',
      period: 'monthly',
      pace_shape: 'lump',
      category: WEEKLY_SHOP,
      start_date: '2026-11-01',
    },
  },

  expect: { outcome: 'refused', error: 'budgets_pace_check' },

  state: [
    budgetsOwnedBy(USER, '0'),
  ],
};
