import {
  USER, EXISTING_BUDGET, existingBudget, balanceIdentityHolds, budgetShape,
} from './_shared.mjs';

// budgetToDb's whole presence rule: `undefined` is dropped, so a key that is not
// in the patch is a column the write does not mention. The same `p ? 'k'` class
// update_account and update_category have.
export default {
  invariant: 'D-7',
  title: 'an update writes the fields it names and leaves every other column where it was',
  design: 'planningService.updateBudget:273-287 — `.update(budgetToDb(updates)).eq(id).eq(user_id).select().single()`',
  consequence: 'the caller replaces its copy of the budget with this answer, so a write that blanked what it was not asked about would erase a period, a category or a threshold the user never touched',
  parity: 'match',

  setup: existingBudget,

  command: {
    verb: 'update_budget',
    payload: {
      id: EXISTING_BUDGET,
      user_id: USER,
      patch: { amount: '0.30', notes: 'tighter' },
    },
  },

  expect: { outcome: 'ok' },

  rowDivergence: {
    updated_at: 'the instant of the write, on two clocks and in two transactions',
    created_at: 'the fixture inserted it on each engine separately',
  },

  result: {
    id: EXISTING_BUDGET,
    amount: '0.30',
    notes: 'tighter',
    // Untouched, because the patch did not name them.
    name: 'Food',
    period: 'monthly',
    category: 'c0000000-0000-0000-0000-000000000003',
    start_date: '2024-01-01',
    is_active: true,
    alert_threshold: '80.00',
  },

  state: [
    budgetShape(EXISTING_BUDGET, 'Food:0.30:monthly:c0000000-0000-0000-0000-000000000003:2024-01-01:-:0.00:none:even:80.00:active:tighter'),
    balanceIdentityHolds('a0000000-0000-0000-0000-000000000001'),
  ],
};
