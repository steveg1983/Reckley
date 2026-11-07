import {
  USER, EXISTING_BUDGET, existingBudget, balanceIdentityHolds, budgetShape, budgetsOwnedBy,
} from './_shared.mjs';

// `.single()` is the whole difference between this verb and the delete: it
// raises when the update matches nothing, and the delete has no such clause.
export default {
  invariant: 'D-7',
  title: 'updating a budget that is not there is refused, and the store is untouched',
  design: 'the `.single()` on planningService.updateBudget:283 — PostgREST answers PGRST116 when it matches no row; the verb refuses budget_not_found before its first write',
  consequence: 'an id that names nothing is a stale page or a double submit, and inventing the budget to satisfy it would put an amount on the budgets page that nobody set',
  parity: 'match',

  setup: existingBudget,

  command: {
    verb: 'update_budget',
    payload: {
      id: 'b0000000-0000-0000-0000-0000000000ff',
      user_id: USER,
      patch: { amount: '300.00' },
    },
  },

  // The same outcome under two names, and the names are the two layers each
  // engine refuses IN: a PostgREST contract on one side, the verb's own guard on
  // the other.
  expect: {
    sqlite: { outcome: 'refused', error: 'budget_not_found' },
    postgres: { outcome: 'refused', error: 'PGRST116' },
  },

  state: [
    budgetsOwnedBy(USER, '1'),
    budgetShape(EXISTING_BUDGET, 'Food:100.00:monthly:c0000000-0000-0000-0000-000000000003:2024-01-01:-:0.00:none:80.00:active:-'),
    balanceIdentityHolds('a0000000-0000-0000-0000-000000000001'),
  ],
};
