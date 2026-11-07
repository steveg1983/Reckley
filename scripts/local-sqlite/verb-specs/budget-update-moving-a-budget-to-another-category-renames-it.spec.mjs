import {
  USER, OUTGOINGS, EXISTING_BUDGET, existingBudget, balanceIdentityHolds, budgetShape,
} from './_shared.mjs';

// The one line in budgetToDb where two keys decide one column:
//   if (b.name !== undefined || b.categoryId !== undefined)
//     row.name = b.name ?? b.categoryId ?? 'Budget';
// So an edit that only moves the category also REWRITES THE NAME. Nobody would
// choose that; it is what falls out of a mapper filling in a NOT NULL column,
// and it is pinned here because a port that tidied it would leave the two
// editions disagreeing about what a budget is called after an ordinary edit.
export default {
  invariant: 'D-7',
  title: 'changing only the category renames the budget to the category id',
  design: 'planningService.ts:93-95 — budgetToDb writes `name` whenever EITHER key is present',
  consequence: 'the budgets page shows this string; two editions that disagree about it disagree about what the user is looking at',
  parity: 'match',

  setup: existingBudget,

  command: {
    verb: 'update_budget',
    payload: { id: EXISTING_BUDGET, user_id: USER, patch: { category: OUTGOINGS } },
  },

  expect: { outcome: 'ok' },

  rowDivergence: {
    updated_at: 'the instant of the write, on two clocks and in two transactions',
    created_at: 'the fixture inserted it on each engine separately',
  },

  result: { id: EXISTING_BUDGET, category: OUTGOINGS, name: OUTGOINGS },

  state: [
    budgetShape(EXISTING_BUDGET, 'c0000000-0000-0000-0000-000000000002:100.00:monthly:c0000000-0000-0000-0000-000000000002:2024-01-01:-:0.00:none:even:80.00:active:-'),
    balanceIdentityHolds('a0000000-0000-0000-0000-000000000001'),
  ],
};
