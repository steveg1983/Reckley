import {
  USER, WEEKLY_SHOP, FOOD_BUDGET, FUEL_BUDGET, OPENED_SECOND,
  twoBudgets, listedBudget, auditRowsInTotal,
} from './_shared.mjs';

export default {
  invariant: 'READ-4',
  title: 'a threshold stored as 4250 basis points arrives as "42.50" — the same text the cloud\'s numeric(5,2) casts to',
  design: 'schema.sql shouts NOT MONEY at this column and stores hundredths of a percent (8000 = 80.00%) because the file keeps every fractional quantity out of floating point; the cloud stores numeric(5,2). Two encodings, one value, and money.rs renders the local one — because the alternative is a `/ 100` on the far side of the boundary, which is exactly the shape R-7\'s grep exists to catch',
  consequence: 'get it wrong by a factor of a hundred and every budget alerts at 0.8% of its limit — on the first pound spent, for ever, on every budget in the file',
  parity: 'divergent',
  reason: 'THE STORED VALUES DIVERGE AND THE ANSWERS DO NOT, which is the whole spec. The state assertion reads what each file HOLDS — 4250 against 42.50 — while the result assertion reads what each engine ANSWERS with, and that is "42.50" on both. If the storage encodings ever stop diverging (a local column holding a percentage), this spec must go red and be re-thought rather than quietly keep passing.',

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
        start_date: '2024-02-01', is_active: false, alert_threshold: '80.00',
        created_at: OPENED_SECOND, updated_at: OPENED_SECOND,
      }),
    ],
  },
  state: [
    auditRowsInTotal('0'),
    {
      name: 'the_threshold_as_the_file_stores_it',
      sqlite: `SELECT CAST(alert_threshold_bp AS TEXT) FROM budgets WHERE id = '${FOOD_BUDGET}'`,
      postgres: `SELECT alert_threshold::text FROM public.budgets WHERE id = '${FOOD_BUDGET}'`,
      expect: { sqlite: '4250', postgres: '42.50' },
    },
  ],
};
