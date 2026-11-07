import { USER, WEEKLY_SHOP, FOOD_BUDGET, twoBudgets, budgetsOwnedBy } from './_shared.mjs';

const NEW = 'b0000000-0000-0000-0000-0000000000fd';

// The one rule the table CAN hold the pointer to (besides not-itself): a
// destination makes sense only under a mode that carries a surplus. A row
// arriving with a destination and 'overspend' is refused by both tables.
export default {
  invariant: 'B-3',
  title: 'a destination under a mode that carries no surplus is refused by both tables, and nothing is stored',
  design: 'budgets_rollover_to_check — cloud migration 20261107223000 and scripts/local-sqlite/schema.sql, the same predicate on both engines',
  consequence: 'a destination the evaluation would ignore on one engine and the table would store on the other is a row the two editions disagree about',
  parity: 'match',

  setup: twoBudgets,
  command: {
    verb: 'create_budget',
    payload: {
      id: NEW,
      user_id: USER,
      name: 'Contradiction',
      amount: '10.00',
      period: 'monthly',
      rollover_mode: 'overspend',
      rollover_to: FOOD_BUDGET,
      category: WEEKLY_SHOP,
      start_date: '2026-11-01',
    },
  },

  expect: { outcome: 'refused', error: 'budgets_rollover_to_check' },

  state: [
    budgetsOwnedBy(USER, '2'),
  ],
};
