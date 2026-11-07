import {
  USER, WEEKLY_SHOP, FOOD_BUDGET, twoBudgets, balanceIdentityHolds, budgetsOwnedBy,
} from './_shared.mjs';

const NEW = 'b0000000-0000-0000-0000-0000000000fc';

// WHERE A SURPLUS GOES (7 Nov 2026, cloud 20261107223000): a budget that
// carries its surplus may send it to another budget. The pointer is a plain
// id on both engines — no foreign key, by design — so it goes in and comes
// back as the id it is.
export default {
  invariant: 'B-3',
  title: 'a budget that sends its surplus elsewhere stores the id and answers with it',
  design: 'docs/budget-direction.md §8 PR I; the oracle is planningService.createBudget transcribed in lib/verb-postgres.mjs, with rollover_to added for migration 20261107223000',
  consequence: 'the Budget page reads where the surplus goes from this id; an engine that dropped it would keep on that engine what the other sends',
  parity: 'match',

  setup: twoBudgets,
  command: {
    verb: 'create_budget',
    payload: {
      id: NEW,
      user_id: USER,
      name: 'Groceries',
      amount: '400.00',
      period: 'monthly',
      rollover_mode: 'surplus',
      rollover_to: FOOD_BUDGET,
      category: WEEKLY_SHOP,
      start_date: '2026-11-01',
    },
  },

  expect: { outcome: 'ok' },

  rowDivergence: {
    created_at: 'the instant of the write, on two clocks and in two transactions',
    updated_at: 'the same instant, and the same two clocks',
  },

  result: {
    id: NEW,
    rollover_mode: 'surplus',
    rollover_to: FOOD_BUDGET,
    amount: '400.00',
  },

  state: [
    budgetsOwnedBy(USER, '3'),
    balanceIdentityHolds('a0000000-0000-0000-0000-000000000001'),
  ],
};
