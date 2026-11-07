import { USER, WEEKLY_SHOP, balanceIdentityHolds, budgetShape } from './_shared.mjs';

const NEW = 'b0000000-0000-0000-0000-0000000000f3';

// `if (!row.name) row.name = budget.categoryId || 'Budget'` — a NOT NULL column
// being satisfied by the writer, and the ONE place `??` and `||` disagree: the
// mapper's `b.name ?? b.categoryId` passes an empty string through, and the
// writer's `!row.name` catches it and replaces it. So a budget saved with the
// name field left blank is filed under its category id on both engines.
export default {
  invariant: 'B-3',
  title: 'an empty name falls through to the category id, on both engines',
  design: 'planningService.createBudget:263 — the second of the two lines the writer adds after budgetToDb, because budgets.name is NOT NULL with no default',
  consequence: 'the budgets page prints this string; a port that stored the empty name would show a limit with no label beside it, and only on one edition',
  parity: 'match',

  command: {
    verb: 'create_budget',
    payload: {
      id: NEW,
      user_id: USER,
      name: '',
      amount: '50.00',
      period: 'weekly',
      category: WEEKLY_SHOP,
      start_date: '2024-02-01',
    },
  },

  expect: { outcome: 'ok' },

  rowDivergence: {
    created_at: 'the instant of the write, on two clocks and in two transactions',
    updated_at: 'the same instant, and the same two clocks',
  },

  result: { id: NEW, name: WEEKLY_SHOP, amount: '50.00' },

  state: [
    budgetShape(NEW, 'c0000000-0000-0000-0000-000000000003:50.00:weekly:c0000000-0000-0000-0000-000000000003:2024-02-01:-:0.00:none:even:80.00:active:-'),
    balanceIdentityHolds('a0000000-0000-0000-0000-000000000001'),
  ],
};
