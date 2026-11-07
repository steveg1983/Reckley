import {
  USER, THEIR_BUDGET, secondUser, setups, strangersBudget,
  balanceIdentityHolds, budgetShape,
} from './_shared.mjs';

// The `.eq('user_id', …)` half of the query, which is the only thing standing
// between two logins in ONE file — a local ledger has no RLS to fall back on,
// and a restored backup can legitimately hold a second login's rows.
export default {
  invariant: 'X-6',
  title: 'a budget belonging to somebody else is refused, and left exactly as it was',
  design: 'the second `.eq()` on planningService.updateBudget:282, and the ownership clause the verb applies in its place',
  consequence: 'a file that holds two logins would otherwise let either one edit the other’s limits, silently',
  parity: 'match',

  setup: setups(secondUser, strangersBudget),

  command: {
    verb: 'update_budget',
    payload: { id: THEIR_BUDGET, user_id: USER, patch: { amount: '1.00' } },
  },

  expect: {
    sqlite: { outcome: 'refused', error: 'budget_not_found' },
    postgres: { outcome: 'refused', error: 'PGRST116' },
  },

  state: [
    budgetShape(THEIR_BUDGET, 'Theirs:50.00:monthly:-:2024-01-01:-:0.00:none:80.00:active:-'),
    balanceIdentityHolds('a0000000-0000-0000-0000-000000000001'),
  ],
};
