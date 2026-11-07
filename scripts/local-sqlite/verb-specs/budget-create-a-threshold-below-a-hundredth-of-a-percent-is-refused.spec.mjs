import { USER, balanceIdentityHolds, budgetShape, budgetsOwnedBy } from './_shared.mjs';

const NEW = 'b0000000-0000-0000-0000-0000000000f6';

// The threshold is NOT money and is held to money's exactness anyway, which is
// the whole point of `hundredths_from_decimal_string` being Money::parse's
// grammar without its type.
//
// MEASURED, 2026-08-11, and it is not what this spec was first written to
// expect: `numeric(5,2)` does not REFUSE 80.005, it ROUNDS it to 80.01 — five
// significant digits with two after the point is a scale, not a validation. So
// the cloud stores a percentage nobody typed and says nothing, and the crate
// refuses the value by name before the file is opened. That is the same
// difference M-1 declares for money, on the one column in this family that is
// not money, and it is the reason the grammar is shared even though the type is
// not.
export default {
  invariant: 'M-1',
  title: 'an alert threshold with three decimal places is refused here and quietly rounded in the cloud',
  design: 'crate::money::hundredths_from_decimal_string against numeric(5,2); schema.sql stores alert_threshold_bp as hundredths of a percent',
  consequence: 'a threshold rounded on the way in is an alert that fires at a percentage nobody set, and the person who set it has no way to see that it moved',
  parity: 'divergent',
  reason: 'numeric(5,2) rounds to its scale and stores 80.01; the crate refuses the value rather than deciding on somebody’s behalf what they meant',

  command: {
    verb: 'create_budget',
    payload: {
      id: NEW,
      user_id: USER,
      name: 'Food',
      amount: '50.00',
      period: 'monthly',
      start_date: '2024-01-01',
      alert_threshold: '80.005',
    },
  },

  expect: {
    sqlite: { outcome: 'refused', error: 'percentage_malformed' },
    postgres: { outcome: 'ok' },
  },

  state: [
    budgetsOwnedBy(USER, { sqlite: '0', postgres: '1' }),
    // The rounding, made visible. `80.01` is what a person would find on the
    // budgets page having typed `80.005`.
    budgetShape(NEW, {
      sqlite: 'GONE',
      postgres: 'Food:50.00:monthly:-:2024-01-01:-:0.00:none:80.01:active:-',
    }),
    balanceIdentityHolds('a0000000-0000-0000-0000-000000000001'),
  ],
};
