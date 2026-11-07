import { USER, WEEKLY_SHOP, budgetsOwnedBy } from './_shared.mjs';

const NEW = 'b0000000-0000-0000-0000-0000000000f7';

// The other half of budgets_repeat_check: the pair belongs to 'every' alone.
// A monthly budget arriving with an interval is a contradiction the TABLE
// refuses on both engines, before any reader could pick one meaning.
export default {
  invariant: 'B-3',
  title: 'an interval on a monthly budget is refused by both tables, and nothing is stored',
  design: 'budgets_repeat_check — cloud migration 20261107150000 and scripts/local-sqlite/schema.sql, the same predicate on both engines',
  consequence: 'a row that is monthly by name and every-2-months by its columns would be read one way by the cycle model and the other by whoever wrote it',
  parity: 'match',

  command: {
    verb: 'create_budget',
    payload: {
      id: NEW,
      user_id: USER,
      name: 'Contradiction',
      amount: '10.00',
      period: 'monthly',
      repeat_count: 2,
      repeat_unit: 'month',
      category: WEEKLY_SHOP,
      start_date: '2026-11-01',
    },
  },

  expect: { outcome: 'refused', error: 'budgets_repeat_check' },

  state: [
    budgetsOwnedBy(USER, '0'),
  ],
};
