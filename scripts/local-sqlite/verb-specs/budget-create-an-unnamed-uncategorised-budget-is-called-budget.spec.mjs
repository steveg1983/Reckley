import { USER, balanceIdentityHolds, budgetShape } from './_shared.mjs';

const NEW = 'b0000000-0000-0000-0000-0000000000f4';

// The last arm of the same expression, and the one nothing else reaches: no
// name and no category leaves the writer with a literal.
export default {
  invariant: 'B-3',
  title: 'a budget with neither a name nor a category is called Budget',
  design: 'planningService.createBudget:263 — `budget.categoryId || \'Budget\'`',
  consequence: 'a NOT NULL column with nothing to put in it would otherwise refuse the write, and the budgets page would refuse a budget somebody had just saved',
  parity: 'match',

  command: {
    verb: 'create_budget',
    payload: { id: NEW, user_id: USER, amount: '25.00', period: 'yearly', start_date: '2024-03-01' },
  },

  expect: { outcome: 'ok' },

  rowDivergence: {
    created_at: 'the instant of the write, on two clocks and in two transactions',
    updated_at: 'the same instant, and the same two clocks',
  },

  result: { id: NEW, name: 'Budget', category: null },

  state: [
    budgetShape(NEW, 'Budget:25.00:yearly:-:2024-03-01:-:0.00:none:even:80.00:active:-'),
    balanceIdentityHolds('a0000000-0000-0000-0000-000000000001'),
  ],
};
