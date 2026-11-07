import {
  USER, WEEKLY_SHOP, balanceIdentityHolds, budgetShape, budgetsOwnedBy,
} from './_shared.mjs';

const NEW = 'b0000000-0000-0000-0000-0000000000f6';

// ANY REPEAT INTERVAL (7 Nov 2026, cloud 20261107150000): the period 'every'
// carries how many of which unit one cycle is, and both engines hold the pair
// to that period by CHECK. The happy path: the pair goes in and comes back.
export default {
  invariant: 'B-3',
  title: 'a budget every 2 months stores its interval and answers with it',
  design: 'docs/budget-direction.md §8 PR E; the oracle is planningService.createBudget transcribed in lib/verb-postgres.mjs, with repeat_count/repeat_unit added for migration 20261107150000',
  consequence: 'the Budget page captions the card "Every 2 months" and steps its window by two months from the start — a pair dropped by either engine would read as every month on that engine alone',
  parity: 'match',

  command: {
    verb: 'create_budget',
    payload: {
      id: NEW,
      user_id: USER,
      name: 'Car wash',
      amount: '30.00',
      period: 'every',
      repeat_count: 2,
      repeat_unit: 'month',
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
    period: 'every',
    repeat_count: 2,
    repeat_unit: 'month',
    start_date: '2026-11-01',
    amount: '30.00',
  },

  state: [
    budgetsOwnedBy(USER, '1'),
    budgetShape(NEW, 'Car wash:30.00:every:c0000000-0000-0000-0000-000000000003:2026-11-01:-:0.00:no:0.00:80.00:active:-'),
    balanceIdentityHolds('a0000000-0000-0000-0000-000000000001'),
  ],
};
