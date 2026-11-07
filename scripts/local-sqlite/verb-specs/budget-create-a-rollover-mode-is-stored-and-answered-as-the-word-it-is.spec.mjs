import {
  USER, WEEKLY_SHOP, balanceIdentityHolds, budgetShape, budgetsOwnedBy,
} from './_shared.mjs';

const NEW = 'b0000000-0000-0000-0000-0000000000f8';

// ROLLOVER MODES (7 Nov 2026, cloud 20261107203000): what a budget does with
// what each cycle leaves is one word on the row, and the carry it names is
// derived by the app from the cycles before — never a column. The happy
// path: the word goes in and comes back, on both engines, as the word it is.
export default {
  invariant: 'B-3',
  title: 'a budget that carries both stores the word and answers with it',
  design: 'docs/budget-direction.md §8 PR F; the oracle is planningService.createBudget transcribed in lib/verb-postgres.mjs, with rollover_mode in place of rollover/rollover_amount for migration 20261107203000',
  consequence: 'the Budget page works the carry out from this word; an engine that stored it as a flag or a figure would carry the wrong thing, or nothing, on that engine alone',
  parity: 'match',

  command: {
    verb: 'create_budget',
    payload: {
      id: NEW,
      user_id: USER,
      name: 'Groceries',
      amount: '400.00',
      period: 'monthly',
      rollover_mode: 'both',
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
    period: 'monthly',
    rollover_mode: 'both',
    amount: '400.00',
  },

  state: [
    budgetsOwnedBy(USER, '1'),
    budgetShape(NEW, 'Groceries:400.00:monthly:c0000000-0000-0000-0000-000000000003:2026-11-01:-:0.00:both:even:80.00:active:-'),
    balanceIdentityHolds('a0000000-0000-0000-0000-000000000001'),
  ],
};
