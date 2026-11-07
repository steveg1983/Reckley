-- budgets_pace_shape — how a budget's money lands over its period.
--
-- WHY. The owner's "pace shape" (7 Nov 2026, "give the user the option"): a
-- yearly budget for a category paid once a year — insurance, car tax, a
-- season ticket — read "£x under the pace" for eleven months, which said
-- nothing true. A budget is now 'even' (spread across the period, the
-- default) or 'once' (paid in one go): the card reads a 'once' budget as
-- "not yet paid" until the payment lands and "paid" after, never behind.
--
-- WHERE IT COMES FROM. The wizard proposes 'once' for a NEW budget when the
-- guide window shows most of a category's spending fell in one month
-- (utils/categorySpendSummary, paidOnceIn); the editor can change it. No
-- transaction carries a flag and no screen exists to set one — the
-- category's own history is the evidence.
--
-- READ BY. utils/budgetPeriods (normalisePaceShape), the Budget page's pace
-- line, planningService.budgetFromDb, api/_lib/mcp/port.ts, the local
-- edition's mappers and crate. The same CHECK is in
-- scripts/local-sqlite/schema.sql, and a ledger file gains the column on open
-- (wealth_core::upgrade, version 3).
--
-- BALANCE REASONING. No money column is touched.

ALTER TABLE public.budgets
  ADD COLUMN pace_shape text NOT NULL DEFAULT 'even';

ALTER TABLE public.budgets ADD CONSTRAINT budgets_pace_check
  CHECK (pace_shape IN ('even', 'once'));
