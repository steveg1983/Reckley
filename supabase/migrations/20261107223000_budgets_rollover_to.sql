-- budgets_rollover_to — where a budget's surplus goes.
--
-- WHY. The last part of the owner's "rollover modes" (7 Nov 2026): a budget
-- that carries its surplus may SEND it to another budget rather than keep
-- it — groceries to the holiday fund. One column names the budget.
--
-- A PLAIN ID, NOT A FOREIGN KEY, ON PURPOSE. A ledger-wide link between two
-- rows of this table would need what accounts.parent_account_id has: the
-- user-scoped composite key, the deferred second pass of a restore, the link
-- section in the backup file. The evaluation (utils/budgetEvaluation,
-- resolveRolloverTarget) reads a pointer that names nothing — a deleted
-- budget, another login's, the budget itself — as "keep it here", the
-- editor offers only the login's own running budgets, and the restore's id
-- remapper rewrites the column with the rest (backup/format ENTITY_REFERENCES).
-- The two things the table CAN hold it to, it does: not itself, and only
-- under a mode that carries a surplus.
--
-- WHEN IT LANDS. At the end of each of the sender's cycles, what was left —
-- the surplus, never an overspend — lands in the target's cycle holding the
-- day after, and is counted into that cycle's allowance. Derived, never
-- stored, like the carry.
--
-- READ BY. utils/budgetEvaluation, planningService.budgetFromDb,
-- api/_lib/mcp/port.ts, the local edition's mappers and crate. The same
-- CHECK is in scripts/local-sqlite/schema.sql (version 4).
--
-- BALANCE REASONING. No money column is touched.

ALTER TABLE public.budgets
  ADD COLUMN rollover_to uuid;

ALTER TABLE public.budgets ADD CONSTRAINT budgets_rollover_to_check CHECK (
  rollover_to IS NULL
  OR (rollover_to <> id AND rollover_mode IN ('surplus', 'both'))
);
