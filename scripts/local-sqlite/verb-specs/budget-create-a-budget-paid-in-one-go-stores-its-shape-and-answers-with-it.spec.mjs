import {
  USER, WEEKLY_SHOP, balanceIdentityHolds, budgetShape, budgetsOwnedBy,
} from './_shared.mjs';

const NEW = 'b0000000-0000-0000-0000-0000000000fa';

// PACE SHAPE (7 Nov 2026, cloud 20261107213000): how a budget's money lands
// over its period is one word on the row — 'even' or 'once' — and the card
// reads a 'once' budget as "not yet paid" rather than "behind". The happy
// path: the word goes in and comes back, on both engines.
export default {
  invariant: 'B-3',
  title: 'a budget paid in one go stores its shape and answers with it',
  design: 'docs/budget-direction.md §8 PR H; the oracle is planningService.createBudget transcribed in lib/verb-postgres.mjs, with pace_shape added for migration 20261107213000',
  consequence: 'the Budget page reads the pace from this word; an engine that dropped it would show a yearly insurance budget as months behind on that engine alone',
  parity: 'match',

  command: {
    verb: 'create_budget',
    payload: {
      id: NEW,
      user_id: USER,
      name: 'Insurance',
      amount: '480.00',
      period: 'yearly',
      pace_shape: 'once',
      category: WEEKLY_SHOP,
      start_date: '2026-04-06',
    },
  },

  expect: { outcome: 'ok' },

  rowDivergence: {
    created_at: 'the instant of the write, on two clocks and in two transactions',
    updated_at: 'the same instant, and the same two clocks',
  },

  result: {
    id: NEW,
    period: 'yearly',
    pace_shape: 'once',
    rollover_mode: 'none',
    amount: '480.00',
  },

  state: [
    budgetsOwnedBy(USER, '1'),
    budgetShape(NEW, 'Insurance:480.00:yearly:c0000000-0000-0000-0000-000000000003:2026-04-06:-:0.00:none:once:80.00:active:-'),
    balanceIdentityHolds('a0000000-0000-0000-0000-000000000001'),
  ],
};
