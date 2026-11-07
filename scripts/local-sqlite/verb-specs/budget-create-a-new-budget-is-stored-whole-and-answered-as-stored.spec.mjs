import {
  USER, WEEKLY_SHOP, balanceIdentityHolds, budgetShape, budgetsOwnedBy,
} from './_shared.mjs';

const NEW = 'b0000000-0000-0000-0000-0000000000f2';

// The happy path of the family, and the one that fixes what a budget create
// MEANS: the twelve columns budgetToDb can send, the defaults it leaves to the
// table, and the whole row handed back.
export default {
  invariant: 'B-3',
  title: 'a create stores every column it was given and answers with the row as stored',
  design: 'PHASE3-PLAN D-2; the oracle is planningService.createBudget:256-271 (a PostgREST INSERT of budgetToDb, no RPC), transcribed in lib/verb-postgres.mjs',
  consequence: 'the caller puts this answer straight into state and draws a limit against it — a row reconstructed from the request rather than read back would disagree with the file the moment a default or a CHECK had an opinion',
  parity: 'match',

  command: {
    verb: 'create_budget',
    payload: {
      id: NEW,
      user_id: USER,
      name: 'Food',
      // A decimal STRING. Never a JSON number: a JSON number is a double.
      amount: '70.10',
      period: 'monthly',
      category: WEEKLY_SHOP,
      start_date: '2024-01-01',
      notes: 'Watch the takeaways',
    },
  },

  expect: { outcome: 'ok' },

  rowDivergence: {
    created_at: 'the instant of the write, on two clocks and in two transactions',
    updated_at: 'the same instant, and the same two clocks',
  },

  result: {
    id: NEW,
    user_id: USER,
    name: 'Food',
    amount: '70.10',
    period: 'monthly',
    category: WEEKLY_SHOP,
    start_date: '2024-01-01',
    notes: 'Watch the takeaways',
    // The five the caller did not send, answered by the column defaults — and
    // the two engines' defaults are the same five values. `spent` is the
    // WRITER's zero rather than a default; the caller has no say in it.
    spent: '0.00',
    end_date: null,
    rollover_mode: 'none',
    pace_shape: 'even',
    rollover_to: null,
    alert_threshold: '80.00',
    is_active: true,
    category_id: null,
  },

  state: [
    budgetsOwnedBy(USER, '1'),
    budgetShape(NEW, 'Food:70.10:monthly:c0000000-0000-0000-0000-000000000003:2024-01-01:-:0.00:none:even:80.00:active:Watch the takeaways'),
    balanceIdentityHolds('a0000000-0000-0000-0000-000000000001'),
  ],
};
