-- budgets_repeat_every — a budget that repeats every N weeks or months.
--
-- WHY. The owner's "any repeat interval" (7 Nov 2026): the six named rhythms
-- (weekly, biweekly, monthly, quarterly, yearly, and the one-off 'custom') are
-- not every rhythm a household runs on — a budget every 2 months, or every
-- 6 weeks, had nowhere to live. A new period value, 'every', carries the
-- interval in two columns: how many, of which unit. The six named rhythms are
-- untouched; a monthly budget stays 'monthly', so nothing stored changed.
--
-- THE PAIR BELONGS TO 'every' ALONE. budgets_repeat_check holds repeat_count
-- (a whole number of at least one) and repeat_unit ('week' or 'month') to
-- exactly the rows whose period is 'every', and to NULL on every other row —
-- so an interval cannot be left behind on a budget that moved to a named
-- rhythm, and a named rhythm cannot be quietly re-read as an interval. The
-- same two CHECKs are in scripts/local-sqlite/schema.sql, and the differential
-- lane measures both engines refusing the same rows.
--
-- READ BY. utils/budgetPeriods (the cycle: the fortnight's and the
-- month-stepped rule with the user's own N), planningService.budgetFromDb,
-- api/_lib/mcp/port.ts, the local edition's mappers and crate.
--
-- BALANCE REASONING. No money column is touched.

ALTER TABLE public.budgets
  ADD COLUMN repeat_count integer,
  ADD COLUMN repeat_unit text;

ALTER TABLE public.budgets DROP CONSTRAINT budgets_period_check;
ALTER TABLE public.budgets ADD CONSTRAINT budgets_period_check
  CHECK (period = ANY (ARRAY['weekly'::text, 'biweekly'::text, 'monthly'::text, 'quarterly'::text, 'yearly'::text, 'custom'::text, 'every'::text]));

-- IS NOT NULL first: a CHECK that evaluates to NULL PASSES (SQL's rule, in
-- Postgres and SQLite alike), so `NULL >= 1` alone would let an 'every' row
-- through with no interval. The local edition's upgrade test caught it.
ALTER TABLE public.budgets ADD CONSTRAINT budgets_repeat_check CHECK (
  (period = 'every' AND repeat_count IS NOT NULL AND repeat_count >= 1
    AND repeat_unit IS NOT NULL AND repeat_unit IN ('week', 'month'))
  OR (period <> 'every' AND repeat_count IS NULL AND repeat_unit IS NULL)
);

COMMENT ON COLUMN public.budgets.repeat_count IS
  'For period ''every'': how many of repeat_unit one cycle is (a whole number, at least 1). NULL for every other period, by CHECK.';
COMMENT ON COLUMN public.budgets.repeat_unit IS
  'For period ''every'': ''week'' or ''month''. NULL for every other period, by CHECK.';
