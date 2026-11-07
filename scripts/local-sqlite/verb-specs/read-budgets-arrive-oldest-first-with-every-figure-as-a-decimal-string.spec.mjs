import {
  USER, EVERYDAY, WEEKLY_SHOP, FOOD_BUDGET, FUEL_BUDGET, OPENED_SECOND,
  twoBudgets, listedBudget, balanceIdentityHolds, auditRowsInTotal,
} from './_shared.mjs';

export default {
  invariant: 'READ-1',
  title: 'the budgets come back oldest first, and their two money columns come back as decimal strings',
  design: 'planningService.getBudgets: .select(\'*\').eq(\'user_id\', …).order(\'created_at\', { ascending: true }). Two of the nineteen columns are money — amount, spent — and schema.sql records that spent is numeric(10,2) in the cloud against numeric(20,2) here; rollover_mode (20261107203000) is a word, not a figure',
  consequence: 'a budget is an amount against a category. Through a float it is an amount that nearly matches, and the number on the page stops agreeing with the number in the file',
  parity: 'match',

  setup: twoBudgets,
  command: { verb: 'list_budgets', payload: { user_id: USER } },
  expect: { outcome: 'ok' },
  result: {
    budgets: [
      listedBudget({
        id: FOOD_BUDGET, name: 'Food', amount: '123.45', category: WEEKLY_SHOP,
        end_date: '2024-12-31', spent: '67.89', rollover_mode: 'surplus',
        alert_threshold: '42.50', notes: 'the food one',
      }),
      listedBudget({
        id: FUEL_BUDGET, name: 'Fuel', amount: '50.00', period: 'weekly',
        start_date: '2024-02-01', is_active: false,
        created_at: OPENED_SECOND, updated_at: OPENED_SECOND,
      }),
    ],
  },
  state: [balanceIdentityHolds(EVERYDAY), auditRowsInTotal('0')],
};
