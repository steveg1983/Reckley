-- linked_accounts: what the bank says is PENDING, beside the link it was read
-- through.
--
-- The feed imports posted transactions only, and a card issuer's balance can
-- run ahead of them — a refund already taken off what is owed, a purchase
-- authorised this morning. The reconcile screen proposes the bank's balance as
-- the closing balance, so on such a card "mark all" left a difference with no
-- transaction to account for it (the owner, 10 Nov 2026, on two American
-- Express cards). The account sync now reads the pending items and the
-- register and the reconcile screen show them, faded, as what the bank has
-- not yet sent. See src/services/banking/pendingAtBank.ts.
--
-- ON THE LINK, NOT THE ACCOUNT. `accounts` is mirrored column for column by
-- the local edition's ledger file, its backup and its restore; a local file
-- has no bank feed and nothing pending. linked_accounts is bank-feed plumbing
-- the local edition does not carry at all (scripts/local-sqlite/schema.sql
-- lists it among the tables left out), so the fact lives where only the cloud
-- can see it.
--
-- NEVER A TRANSACTION. These rows are a note of what the bank said at one
-- sync. They are overwritten at the next, cleared when the bank does not say,
-- and nothing in a balance or a report reads them.
--
--   pending_items   a JSON array of { date, description, amount } — amount in
--                   the app's sign (a purchase negative, a refund positive)
--   pending_as_of   when the sync read them
--
-- Both set or both null: rows with no date cannot be said to describe today,
-- and a date with no rows says nothing.

ALTER TABLE public.linked_accounts
  ADD COLUMN IF NOT EXISTS pending_items jsonb,
  ADD COLUMN IF NOT EXISTS pending_as_of timestamptz;

ALTER TABLE public.linked_accounts
  DROP CONSTRAINT IF EXISTS linked_accounts_pending_both_or_neither;
ALTER TABLE public.linked_accounts
  ADD CONSTRAINT linked_accounts_pending_both_or_neither
  CHECK ((pending_items IS NULL) = (pending_as_of IS NULL));

ALTER TABLE public.linked_accounts
  DROP CONSTRAINT IF EXISTS linked_accounts_pending_items_is_array;
ALTER TABLE public.linked_accounts
  ADD CONSTRAINT linked_accounts_pending_items_is_array
  CHECK (pending_items IS NULL OR jsonb_typeof(pending_items) = 'array');
