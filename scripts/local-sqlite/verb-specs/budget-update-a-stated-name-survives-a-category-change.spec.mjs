import {
  USER, OUTGOINGS, EXISTING_BUDGET, existingBudget, balanceIdentityHolds, budgetShape,
} from './_shared.mjs';

// The other side of the same expression, and what stops the spec beside this one
// from being satisfied by a port that ALWAYS overwrites the name: `??` means a
// stated name wins, and an EMPTY stated name is still a stated name — unlike the
// create, where the writer's second `||` catches it.
export default {
  invariant: 'D-7',
  title: 'a name stated alongside a category change is the name that is kept, empty or not',
  design: 'planningService.ts:93-95 — `b.name ?? b.categoryId`, nullish rather than falsy',
  consequence: 'an update that renamed a budget the user had just named would undo the edit in the same call that saved it',
  parity: 'match',

  setup: existingBudget,

  command: {
    verb: 'update_budget',
    payload: { id: EXISTING_BUDGET, user_id: USER, patch: { category: OUTGOINGS, name: '' } },
  },

  expect: { outcome: 'ok' },

  rowDivergence: {
    updated_at: 'the instant of the write, on two clocks and in two transactions',
    created_at: 'the fixture inserted it on each engine separately',
  },

  result: { id: EXISTING_BUDGET, category: OUTGOINGS, name: '' },

  state: [
    budgetShape(EXISTING_BUDGET, ':100.00:monthly:c0000000-0000-0000-0000-000000000002:2024-01-01:-:0.00:none:80.00:active:-'),
    balanceIdentityHolds('a0000000-0000-0000-0000-000000000001'),
  ],
};
