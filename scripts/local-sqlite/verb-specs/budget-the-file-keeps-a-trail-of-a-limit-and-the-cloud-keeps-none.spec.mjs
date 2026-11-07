import {
  USER, EXISTING_BUDGET, existingBudget, auditTrailFor, balanceIdentityHolds, budgetShape,
} from './_shared.mjs';

// DIVERGENCE 10, asserted ONCE for the entity rather than on every spec in the
// family — delete_unused_categories argues that restraint: "a family of
// divergences is how a real one gets missed".
//
// PHASE1-PLAN §2.2 traced U-1 ("every financial write emits an audit row")
// against planningService and found it FALSE of budgets.amount, budgets.spent,
// goals.target_amount and goals.current_amount, then ruled that the local
// edition fixes it. This is the spec that holds the ruling: three writes, three
// entries here, and the cloud's log empty afterwards.
export default {
  invariant: 'U-1',
  title: 'a budget’s whole life is audited on a device and nowhere in the cloud',
  design: 'PHASE1-PLAN §2.2; there is no write_financial_audit call for budgets anywhere in supabase/migrations, and PlanningService writes the table directly',
  consequence: 'the compliance answer to "what changed that figure" is the reason U-1 exists, and a budget amount is a figure a person asks it about',
  parity: 'divergent',
  reason: 'the cloud has no function to write an audit row from — this is DESIGN.md §5 divergence 10, decided before the verbs existed rather than discovered by them',

  setup: existingBudget,

  command: {
    verb: 'update_budget',
    payload: { id: EXISTING_BUDGET, user_id: USER, patch: { amount: '150.00' } },
  },

  expect: { outcome: 'ok' },

  rowDivergence: {
    updated_at: 'the instant of the write, on two clocks and in two transactions',
    created_at: 'the fixture inserted it on each engine separately',
  },

  result: { id: EXISTING_BUDGET, amount: '150.00' },

  state: [
    // The edit itself lands identically. Only the trail differs.
    budgetShape(EXISTING_BUDGET, 'Food:150.00:monthly:c0000000-0000-0000-0000-000000000003:2024-01-01:-:0.00:none:80.00:active:-'),
    auditTrailFor('budget', { sqlite: 'update', postgres: 'NONE' }),
    balanceIdentityHolds('a0000000-0000-0000-0000-000000000001'),
  ],
};
