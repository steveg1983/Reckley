-- budgets_rollover_mode — what a budget does with what each period leaves.
--
-- WHY. The owner's "rollover modes" (7 Nov 2026): carry a surplus, carry an
-- overspend, or neither — per budget, "neither" being his own answer and the
-- default, and "give the user the option" the ruling. One column, four words.
--
-- THE CARRY IS DERIVED, NEVER STORED. The two columns this replaces held a
-- carry a person applied BY HAND from a fold on the Budget page, month by
-- month, for monthly budgets alone: `rollover` said whether, `rollover_amount`
-- said how much, and the figure went stale the moment a row behind it changed.
-- Now utils/budgetEvaluation walks the cycles before the one being measured
-- and works the carry out under the mode, so the figure follows the ledger and
-- means the same thing for a year as for a week. A row that was carrying under
-- the old fold is read as carrying its surplus — the only thing that fold
-- carried by default — and the stored amount is let go, because the derived
-- figure is the one the page would show anyway.
--
-- RESTORE. A backup taken before this migration carries `rollover` and
-- `rollover_amount`; jsonb_populate_recordset discards a key that is not a
-- column (measured — the local edition's backup.rs records the same rule), so
-- such a backup restores with every budget starting afresh.
--
-- READ BY. utils/budgetPeriods (normaliseRolloverMode), utils/budgetEvaluation
-- (the carry), planningService.budgetFromDb, api/_lib/mcp/port.ts, the local
-- edition's mappers and crate. The same CHECK is in
-- scripts/local-sqlite/schema.sql, and a ledger file is rebuilt to it on open
-- (wealth_core::upgrade, version 2).
--
-- BALANCE REASONING. No money column is touched; one is dropped, and nothing
-- read it.

ALTER TABLE public.budgets
  ADD COLUMN rollover_mode text NOT NULL DEFAULT 'none';

UPDATE public.budgets SET rollover_mode = 'surplus' WHERE rollover = true;

ALTER TABLE public.budgets ADD CONSTRAINT budgets_rollover_check
  CHECK (rollover_mode IN ('none', 'surplus', 'overspend', 'both'));

ALTER TABLE public.budgets
  DROP COLUMN rollover,
  DROP COLUMN rollover_amount;
