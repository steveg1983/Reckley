-- ============================================================================
-- VENDORED COPY — provenance
-- ============================================================================
-- Origin: the Phase 1 local-edition design draft, written to the session
--         scratchpad as local-core/schema.sql and companion to local-core/
--         DESIGN.md. Copied here on 2026-08-08, byte-for-byte below this
--         header, so the constraint harness has a version-controlled schema to
--         test rather than a file in a temp directory.
--
-- Status: NOT a migration. Nothing applies this to any database except
--         scripts/local-sqlite/run.mjs, which applies it to a throwaway file.
--         supabase/migrations/ remains the only schema anything ships.
--
-- Rule:   this file is a COPY, not a fork. Edit the design first, re-copy, and
--         re-run `npm run test:local-sqlite`. A change made only here is drift,
--         and the parity table in README.md stops meaning anything.
--
-- AMENDED 2026-08-08, in BOTH copies together, by the differential harness:
--         the harness found C-3 and C-4 classified as ported triggers in
--         DESIGN.md §1.4 and absent from the DDL — a new account got no
--         To/From category, and a renamed one kept the old category name.
--         trg_create_transfer_category_for_account and
--         trg_sync_transfer_category_for_account were written from
--         supabase/migrations/20260708140000_transfer_categories_lifecycle.sql,
--         and trg_protect_transfer_category regained the users-row clause it
--         had dropped (C-5): without it DELETE FROM users is refused outright.
--         Both copies were edited in the same change and diffed to prove they
--         differ by this header alone:
--             diff <(tail -n +35 scripts/local-sqlite/schema.sql) \
--                  <scratchpad>/local-core/schema.sql   -> no output
--         (35 = this header is 34 lines; the rest is the original, verbatim.)
--         Specs: specs/c3-*, specs/c4-*, specs/c5-*.
--
-- AMENDED 2026-08-08 (2), by the verb harness: transactions.category_confirmed
--         was missing. The design draft predates
--         supabase/migrations/20260808100000_category_provenance.sql, which
--         added the column to the cloud AND to create_transaction_atomic's
--         column list. Porting that RPC without the column is not possible, so
--         the column was added here with the cloud's default (1 = confirmed)
--         and the cloud's reasoning quoted at the definition.
--         This copy is now AHEAD of the scratchpad draft by that one column;
--         the draft is a design document and this file is what executes, so
--         when the two are reconciled this is the direction the change travels.
--         Specs: verb-specs/create-transaction-carries-*.spec.mjs.
--
-- AMENDED 2026-08-08 (3), in BOTH copies together, discharging the parity
--         obligation recorded at
--         supabase/migrations/20260808170000_rows_cannot_name_a_foreign_account
--         .sql:241-249. The cloud widened SEVEN foreign keys from (account) to
--         (account, owner) so that "this row's account belongs to this row's
--         user" is a shape the table will accept rather than a WHERE clause
--         every writer must remember. Until this file matched, the two engines
--         disagreed about what a LEGAL ROW IS, and the differential harness was
--         measuring a difference in schemas rather than a difference in
--         implementations — which is the one thing it must never do.
--         The same seven keys are here, plus the anchor they point at
--         (accounts_id_user_unique). See "THE OWNERSHIP PAIRING" below for the
--         one place the two engines had to reach the same behaviour by
--         different mechanisms: SQLite has no `ON DELETE SET NULL (column)`.
--         Both copies were edited in the same change and diffed to prove they
--         differ by this header and by amendment (2)'s one column alone:
--             diff <(tail -n +72 scripts/local-sqlite/schema.sql |
--                      sed '/-- Has a human vouched/,/^$/d') \
--                  <scratchpad>/local-core/schema.sql   -> no output
--         (72 = this header is 69 lines and two blank ones; the rest is the
--          original, verbatim, minus the one column amendment (2) declared
--          this copy ahead by.)
--         Specs: specs/r12-*.
--
-- AMENDED 2026-08-08 (4), in BOTH copies together, by the verb harness again:
--         v_integrity_violations gained `entity` and `severity` columns and the
--         TWO INGEST CHECKS PHASE1-PLAN §2.5 owes it — fifteen checks become
--         seventeen, fifteen hard and two advisory — and v_integrity_ok now
--         counts only the hard ones. The section's own header comment was also
--         CORRECTED: it claimed every check had a Postgres twin the differential
--         harness could compare names against, and there is no such twin; the
--         correction carries the trace that establishes it.
--         Both copies were edited in the same change and diffed to prove they
--         differ by this header and by amendment (2)'s one column alone:
--             diff <(tail -n +88 scripts/local-sqlite/schema.sql |
--                      sed '/-- Has a human vouched/,/^$/d') \
--                  <scratchpad>/local-core/schema.sql   -> no output
--         (88 = this header is 85 lines and two blank ones.)
--         Specs: verb-specs/integrity-*.
--
-- AMENDED 2026-08-09 (5), in THIS COPY ONLY, mirroring
--         supabase/migrations/20260809160000_preferences_that_travel.sql:
--         `user_preferences`, one row per user holding the settings that belong
--         to the ACCOUNT rather than to the browser. A cloud backup carries the
--         document (services/backupService writes it as a top-level
--         `preferences` section), so a local file that could not hold it would
--         restore the ledger and drop every choice about how to read it —
--         which is the exact failure the cloud migration exists to fix.
--
--         THIS COPY ONLY, on amendment (2)'s precedent and for the same reason:
--         the scratchpad draft predates the cloud migration, this file is what
--         executes, and when the two are reconciled the change travels in this
--         direction. This copy is now ahead of the draft by amendment (2)'s one
--         column and by this one table.
--
--         NO OWNERSHIP PAIRING, and that is not an omission: the composite-FK
--         pattern of 20260808170000 exists so that a row naming an ACCOUNT
--         cannot name one belonging to somebody else. user_preferences names no
--         account — it references users(id) alone, which is the anchor the
--         pairing is built from, not a thing that needs pairing. Account ids do
--         appear INSIDE the document (dashboardKeyAccounts, the archive
--         overrides), and they are unreferencable text there by construction:
--         see the note at the table.
--
-- AMENDED 2026-08-10 (6), in THIS COPY ONLY, mirroring
--         supabase/migrations/20260810090000_imported_rows_arrive_new.sql:
--         `transactions.needs_review`, the Microsoft Money "this arrived and
--         nobody has looked at it" bit. Added on amendment (2)'s precedent and
--         for the same reason — the scratchpad draft predates the cloud
--         migration, this file is what executes, and when the two are
--         reconciled the change travels in this direction. This copy is now
--         ahead of the draft by amendment (2)'s one column, amendment (5)'s one
--         table, and this one column.
--
--         DEFAULT 0 (= reviewed), matching the cloud's `NOT NULL DEFAULT
--         false`, for the reason the cloud gives at length: silence must be
--         safe, so a writer that has never heard of the column produces a
--         reviewed row and existing history reads as reviewed without being
--         rewritten. The two IMPORT verbs are what set it to 1; the create verb
--         deliberately does not, so a row a person typed is born reviewed.
--
--         PARITY OBLIGATION — RETIRED 2026-08-11, by ruling rather than by
--         edit. 20260810090000 is now confirmed applied in the reference
--         cluster, which is the condition this note originally waited on. But
--         the obligation as written predates slice 19's ruling and conflicts
--         with it: ROW_JSON is the Postgres twin of the crate's audit
--         projection, and that projection deliberately excludes needs_review —
--         the audit payload is hash-chained and compared field by field across
--         engines, so widening it re-chains history to say what the review
--         flag already says elsewhere. The field's read-back home is the
--         RESULT projection, which belongs to the commit that gives the port
--         a caller (slice 27, recorded in localDataPort.ts's header). Until
--         then the boot read (BOOT columns) is where needs_review crosses,
--         and it does.
--
--         THE PARITY IS NOW REAL — slice 27 built that result projection.
--         `crate::row::WrittenTransaction` is the audit row plus this column
--         and is what every write ANSWERS with; `crate::row::TransactionRow`
--         is what the chain records and is byte-for-byte what it was. ROW_JSON
--         is the twin of the FIRST of those, so it projects needs_review and
--         all 467 verb specs compare the two engines on it. The audit half is
--         held by two of the crate's own tests (row.rs asserts the audit
--         projection's exact key list; tests/update_transaction.rs reads the
--         stored payload back and fails if the key appears). So the column now
--         crosses on THREE paths — the boot read, a write's answer, and
--         neither the audit nor the chain.
--
-- AMENDED 2026-08-11 (7), in THIS COPY ONLY, mirroring
--         supabase/migrations/20260810200000_marking_is_not_reconciling.sql:
--         `transactions.is_reconciled`, Microsoft Money's R — the committed
--         state only a finalize produces — and with it the reconcile-sweep moved
--         onto that flag and a new CHECK that committed implies marked. Added on
--         amendment (2)'s precedent and for the same reason. This copy is now
--         ahead of the draft by amendment (2)'s one column, amendment (5)'s one
--         table, amendment (6)'s one column and this one column.
--
--         THE CLOUD'S NULL STORY, TRANSLATED AND MEASURED. The migration adds
--         the column bare and sets the default in a SECOND statement, so that
--         history keeps the honest NULL ("ask is_cleared") and only new rows get
--         false. Neither half of that is available or needed here: MEASURED
--         (probe-addcolumn.mjs), SQLite's ADD COLUMN with a DEFAULT gives rows
--         written before the alter that default — attmissingval by another name
--         — and `ALTER COLUMN … SET DEFAULT` is a syntax error, so the two-step
--         cannot be written. A file created from this schema has no pre-split
--         rows, so DEFAULT 0 is right for every INSERT and matches the cloud's
--         answer for one. The column stays NULLABLE because a restored cloud
--         backup's rows really are pre-split, and the obligation that leaves is
--         recorded at the column: `crate::backup` currently turns a JSON null
--         into "column omitted", which the default then fills.
--
--         The accounts side of the same migration was already here: slice 20
--         added last_reconciled_balance_minor for AccountUpdate's sake.
--         Specs: specs/a3-*, verb-specs/cleared-*, verb-specs/finalize-*,
--         verb-specs/archive-*, verb-specs/unarchive-*.
--
-- AMENDED 2026-08-11 (8), COMMENT ONLY — no DDL, no column, no constraint, no
--         trigger. Recorded as an amendment anyway, because the comment it
--         changes is a RECORDED OBLIGATION and retiring one silently is how a
--         file's documentation stops being evidence.
--
--         Amendment (7) left the obligation at `transactions.is_reconciled`:
--         a restored cloud backup's rows carry NULL for the whole of a user's
--         history, and `crate::backup` turned an absent or JSON-null key into
--         "column omitted", which the DEFAULT 0 then filled. Slice 25 built the
--         collector that closes the round trip, so the rule became measurable —
--         and the differential harness immediately corrected it: the fix the
--         obligation predicted (tell absent from null) still filled an ABSENT
--         key from the default, and the cloud does not. 20260811090000 fills a
--         silence for exactly one class, NOT NULL columns with a constant
--         default, so a nullable column is out of reach on both engines.
--
--         The column and its DEFAULT 0 are UNCHANGED and still right: the
--         default is what a VERB's INSERT gets when it says nothing about the
--         flag, which is the migration's "a transaction is born uncommitted
--         whether it was typed, imported or downloaded". What changed is who
--         may reach it — a restore no longer can.
--         Specs: verb-specs/restore-a-deliberate-null-*, and the crate's
--         tests/backup_round_trip.rs.
--
-- AMENDED 2026-08-11 (9), in THIS COPY ONLY, and it changes NO STORAGE: the two
--         CHECKs on `user_preferences` were anonymous and are now NAMED, with
--         the cloud's own names —  `user_preferences_prefs_is_object` and
--         `user_preferences_prefs_is_small` (20260809160000:176, :181). No
--         column, no table, no trigger, no default and no admitted value
--         changes; a document this schema accepted yesterday it accepts today.
--
--         WHY IT IS WORTH AN AMENDMENT ANYWAY. Slice 28 gave the table its
--         verbs, and the first differential spec written against them could not
--         name the refusal it was asserting: SQLite reports an anonymous CHECK
--         as `CHECK constraint failed:` followed by the EXPRESSION, and Postgres
--         reports the constraint's name. So one refusal needed two `expect`
--         strings, and the harness's whole rule about naming a refusal — *"what
--         separates 'the right rule fired' from 'something went wrong'"* —
--         was being kept by matching on a fragment of SQL. Both engines now
--         refuse under one name, and the spec asserts it once.
--
--         The trigger question, answered here because this is where somebody
--         will look for it: `user_preferences` has NO triggers, on purpose. The
--         cloud stamps `updated_at` with `update_user_preferences_updated_at`;
--         this file ports four of the cloud's eleven `updated_at` triggers (see
--         the note at that block) and `write_preferences` writes its own stamp,
--         exactly as the planning family's six verbs do.
--         Specs: verb-specs/preferences-*, and the crate's tests/preferences.rs.
-- ============================================================================


-- ============================================================================
-- Reckley — local edition core schema (SQLite)
-- Phase 1 design draft. NOT applied anywhere. NOT a migration.
-- ============================================================================
--
-- Source of truth for every rule reproduced here: supabase/migrations/*.sql.
-- packages/types/supabase.ts is NOT a source — it declares eight tables with no
-- migration behind them (mortgage_calculations, financial_plans,
-- saved_calculations, recurring_templates, tags, sync_queue, user_id_mappings,
-- audit_log — all verified: zero matching CREATE TABLE in supabase/migrations).
--
-- ── THE FOUR RULES THIS FILE EXISTS TO ENFORCE ──────────────────────────────
--
-- 1. Money is INTEGER minor units. Never REAL. Every table is STRICT, so this
--    is enforced by the storage engine, not by convention:
--        sqlite> CREATE TABLE s(amt INTEGER NOT NULL) STRICT;
--        sqlite> INSERT INTO s VALUES (1.5);
--        Error: cannot store REAL value in INTEGER column s.amt
--    (verified, SQLite 3.54.0). Without STRICT, INTEGER is only an affinity and
--    a float sails straight in.
--
-- 2. Scale is per column, and the column NAME says which:
--        _minor  INTEGER, 1e2   money            (matches numeric(x,2) exactly)
--        _e8     INTEGER, 1e8   quantity, price  (numeric(20,8) / price fix)
--        _e10    INTEGER, 1e10  fx rate
--        _bp     INTEGER, 1e2   percentage, NOT money
--    A reader who cannot see the scale in the name will eventually get it wrong.
--
-- 3. Every money column carries a bounded CHECK, because SQLite integers are
--    int64 and the declared Postgres types are wider than int64 once scaled.
--    See "OVERFLOW ARITHMETIC" below.
--
-- 4. Foreign keys are only enforced when the connection says so.
--        sqlite> PRAGMA foreign_keys;   -->  0
--    (verified). Every ON DELETE SET NULL in this file — including the one that
--    deliberately strands a transfer's other leg — is inert unless the opening
--    code sets PRAGMA foreign_keys = ON. That PRAGMA belongs in the Rust
--    connection setup where no caller can forget it.
--
-- ── THE OWNERSHIP PAIRING (R-12 — new, and not one of DESIGN.md's 87) ───────
--
-- Every reference to an account carries the account's OWNER alongside its id,
-- and the target is `accounts (id, user_id)` rather than `accounts (id)`. Seven
-- keys, listed at their definitions:
--
--     transactions.account_id                 CASCADE
--     transactions.transfer_account_id        clear (see below)
--     transaction_splits.transfer_account_id  clear
--     accounts.parent_account_id              clear
--     categories.account_id                   CASCADE
--     goals.account_id                        clear
--     investments.account_id                  CASCADE
--
-- WHY, in the cloud's words
-- (20260808170000_rows_cannot_name_a_foreign_account.sql:27-42): row-level
-- security gates on user_id alone, referential-integrity checks are exempt from
-- row-level security by design, and so a single-column key answered "does this
-- account exist?" while nobody was left to answer "does it belong to the same
-- person as this row?". A row filed against a stranger's account is invisible
-- to that stranger and counted by every aggregate that reaches their data
-- through account_id.
--
-- A local file has ONE login and no RLS, so that particular attack is not the
-- local reason. The local reason is the harness: a differential harness whose
-- two schemas disagree about what a legal row is measures the schemas, not the
-- implementations. And a restore is a real path — a backup carrying a row whose
-- account belongs to a login that is not this one is exactly the shape this
-- refuses, and the shape a local edition WILL be handed (X-9, id remapping).
--
-- THE ANCHOR. SQLite, like Postgres, requires the parent columns of a composite
-- foreign key to be collectively UNIQUE. `accounts.id` is already the primary
-- key, so `(id, user_id)` could not have been non-unique — the index below
-- exists solely so that the pair is a legal foreign-key TARGET. Without it
-- every child insert fails with `foreign key mismatch - "transactions"
-- referencing "accounts"` (verified) rather than with anything about ownership.
--
-- THE ONE DIVERGENCE, IN MECHANISM AND NOT IN BEHAVIOUR. Four of the seven were
-- `ON DELETE SET NULL`, and the cloud keeps them so by naming the column:
-- `ON DELETE SET NULL (transfer_account_id)`, PostgreSQL 15+. **SQLite has no
-- such syntax and no such behaviour.** MEASURED (probe-composite-fk.mjs,
-- SQLite 3.50.0):
--
--     ON DELETE SET NULL (pid)   -> near "(": syntax error
--     ON DELETE SET NULL on a composite key, child user_id NULLABLE
--                                -> BOTH columns nulled: {uid: null, pid: null}
--     the same with user_id NOT NULL
--                                -> the parent DELETE is REFUSED:
--                                   "NOT NULL constraint failed: c2.uid"
--
-- So a bare SET NULL here would not merely null too much; it would make
-- "delete an account somebody transferred to" impossible — which is the exact
-- failure the cloud's guard 1 refuses to ship (20260808170000:274-287).
--
-- The four keys are therefore declared with SQLite's default action (NO ACTION,
-- checked immediately) and the clearing is done by `trg_unnest_account_
-- references`, a BEFORE DELETE trigger on accounts that nulls ONLY the account
-- column. Behaviour is identical, including the part nobody would think to
-- check: a native SQLite SET NULL fires the child's own triggers, so the
-- updated_at bump that the FK action used to cause still happens, from the
-- trigger's UPDATE instead. MEASURED both ways (probe-fk-triggers.mjs, cases A
-- and C: `updated_at = BUMPED` either way).
--
-- And the arrangement fails LOUD rather than quiet: if the trigger ever stopped
-- reaching a referencing row, the account DELETE would be refused by the key
-- instead of silently orphaning it.
--
-- ── OVERFLOW ARITHMETIC (this is why the bounds are what they are) ──────────
--
-- INT64_MAX = 9,223,372,036,854,775,807 ≈ 9.223e18.
--
-- Postgres numeric(20,2) permits up to 1e18 − 0.01. Scaled by 100 that needs
-- 1e20, which int64 CANNOT hold. The same is true of numeric(20,8) scaled by
-- 1e8. The prior spike flagged this for quantity only; it is true of EVERY
-- numeric(20,x) column in the schema, money included.
--
-- SQLite's sum() over INTEGER raises "integer overflow" rather than silently
-- promoting to float (verified: SELECT sum(x) FROM (9223372036854775807, 1)
-- --> Error: integer overflow). Fail-loud is the behaviour we want, but the
-- bounds are chosen so it never fires on real data:
--
--   MONEY_ROW  = ±1e11 minor  = ±£1,000,000,000.00 per row
--                9.223e18 / 1e11 = 92,233,720 rows summable before overflow.
--   MONEY_STOCK= ±1e15 minor  = ±£10,000,000,000,000.00 per balance/target
--                9.223e18 / 1e15 = 9,223 accounts summable.
--   QTY        = ±9e18 raw at 1e8 = ±90,000,000,000 units, 8dp exact.
--                Postgres numeric(20,8) permits 1e12 units, so a position
--                larger than 9e10 units exists in the cloud type and is
--                REFUSED here. That divergence is deliberate and tested.
--                Quantities are NEVER summed in SQL — the command layer sums
--                them in i128 — so no aggregate bound is needed.
--   PRICE      = 0..1e16 raw at 1e8 = £0.00000001 .. £100,000,000.00 per unit.
--                price_e8 * quantity_e8 is 1e16-scaled and overflows int64 for
--                any position over ~£92; it is therefore NEVER computed in SQL.
--                The command layer does it in i128 and stores the result in a
--                _minor column.
--
-- ── WHAT IS NOT HERE, AND WHY ───────────────────────────────────────────────
--
-- subscriptions, subscription_usage, subscription_events, subscription_logs,
-- invoices, payment_methods, user_profiles, plaid_* (already dropped by
-- 20260613100000_drop_legacy_plaid_tables.sql), bank_connections,
-- linked_accounts, sync_history, sync_metadata, banking_ops_alert_counters.
-- These are SaaS billing and bank-feed plumbing. A local file has no
-- subscription and no bank feed. transactions keeps connection_id,
-- external_transaction_id and external_provider as plain nullable columns with
-- no FK, so a cloud backup restores into a local file without loss.
--
-- ============================================================================


-- ── Connection setup. Every one of these is per-connection, not per-file. ───
-- Belongs in Rust, applied on open, verified by a startup assertion.
PRAGMA journal_mode = WAL;      -- persistent (stored in the file header)
PRAGMA foreign_keys = ON;       -- PER CONNECTION. Default 0. Verified.
PRAGMA synchronous = FULL;      -- measured cost: insert median 0.114ms vs
                                -- 0.069ms at NORMAL (storage-spike,
                                -- results-node-sqlite.json, n=50000); bulk
                                -- writes 38.4ms vs 38.0ms. Money buys FULL.
PRAGMA busy_timeout = 5000;
PRAGMA trusted_schema = OFF;
PRAGMA recursive_triggers = OFF; -- default; the updated_at triggers rely on it


-- ============================================================================
-- 0. FILE IDENTITY
-- ============================================================================

CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
-- rows: schema_version, created_at, created_by_app_version, money_scale='100',
--       qty_scale='100000000', price_scale='100000000', fx_scale='10000000000'
-- The scales are written into the FILE so a future reader can never guess.


-- ============================================================================
-- 1. IDENTITY
-- ============================================================================
-- Kept for parity with the cloud so backup files interchange and every
-- user_id FK in this file means what it means in Postgres. A local file holds
-- exactly one row in practice; nothing here enforces that, because a future
-- "household" file may hold more and a CHECK would then be a migration.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  first_name    TEXT,
  last_name     TEXT,
  settings      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings)),
  preferences   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(preferences)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (id = lower(id) AND length(id) = 36),
  CHECK (created_at LIKE '____-__-__T%Z'),
  CHECK (updated_at LIKE '____-__-__T%Z')
) STRICT;
-- Deliberately dropped vs cloud: clerk_id, stripe_customer_id,
-- subscription_tier, subscription_status, last_sync_at. None has a local
-- meaning; keeping them would invite code that reads them.


-- ============================================================================
-- 2. ACCOUNTS
-- ============================================================================

CREATE TABLE accounts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  type                TEXT NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'GBP',

  -- balance = initial_balance + SUM(transactions.amount) for this account.
  -- That identity is INVARIANT B-1. Nothing in this file can enforce it (see
  -- DESIGN.md); it is enforced by never exposing an absolute balance setter,
  -- and proved by verify_integrity().
  balance_minor         INTEGER NOT NULL DEFAULT 0,
  initial_balance_minor INTEGER NOT NULL DEFAULT 0,

  -- The bank's own figure. COMPARED against, never added to — the rule
  -- 20260807200000_bank_balance_as_of_date.sql:50-58 states and
  -- api/banking/sync-accounts.ts has kept since audit finding #12.
  bank_balance_minor  INTEGER,
  bank_balance_date   TEXT,
  last_reconciled_date TEXT,

  -- The ending balance the last finalized reconciliation settled against —
  -- Money's "last statement balance", and the figure the next reconciliation
  -- is offered as its starting point. Port of
  -- 20260810200000_marking_is_not_reconciling.sql:123, which added it to the
  -- cloud; this mirror predated that migration and the gap was RECORDED in
  -- three places rather than closed (crate `row/account.rs`, the harness's
  -- ACCOUNT_JSON, and localCore.fixtureFile.ts's column table). It is closed
  -- here because `update_account` takes an `AccountUpdate`, whose type names
  -- this field: a column the seam's own type carries and the file cannot hold
  -- is a write the local edition would have had to refuse while the cloud
  -- accepted it.
  --
  -- NULLABLE, and never zero-as-unknown: the migration's own comment says so
  -- and so does `mapAccountFromDb` — £0.00 is a real statement balance (an
  -- account swept to zero every night closes on exactly that), so "never
  -- reconciled" and "reconciled at zero" must not share a value.
  last_reconciled_balance_minor INTEGER,

  low_balance_alert_enabled INTEGER NOT NULL DEFAULT 0 CHECK (low_balance_alert_enabled IN (0,1)),
  low_balance_threshold_minor INTEGER,

  opening_balance_date TEXT,
  archive_through_date TEXT,

  -- The investment/(Cash) pairing. The clearing is done by
  -- trg_unnest_account_references so that losing the investment account
  -- gracefully un-nests the cash account rather than blocking the delete
  -- (20260722090000_investment_cash_pairing.sql:17-25) — see "THE OWNERSHIP
  -- PAIRING" for why the ON DELETE clause cannot say so itself here.
  -- The key is at the foot of this table: self-referential, so an account may
  -- only be paired with an account of the SAME OWNER, which was always the
  -- intent and never the rule (20260808170000:105-109).
  parent_account_id   TEXT,

  institution         TEXT,
  account_number      TEXT,
  sort_code           TEXT,
  icon                TEXT,
  color               TEXT,
  notes               TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  metadata            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- 20260720120000_split_leg_transfers.sql:32-38 — the current live list.
  CONSTRAINT accounts_type_check CHECK (type IN (
    'checking','savings','credit','cash','investment','loan',
    'assets','other','asset','liability','mortgage')),

  -- 20260722090000_investment_cash_pairing.sql:33-35
  CONSTRAINT accounts_parent_not_self CHECK (parent_account_id IS NULL OR parent_account_id <> id),

  CONSTRAINT accounts_balance_bounded CHECK (
    balance_minor         BETWEEN -1000000000000000 AND 1000000000000000 AND
    initial_balance_minor BETWEEN -1000000000000000 AND 1000000000000000 AND
    (bank_balance_minor IS NULL OR bank_balance_minor BETWEEN -1000000000000000 AND 1000000000000000) AND
    (last_reconciled_balance_minor IS NULL OR last_reconciled_balance_minor BETWEEN -1000000000000000 AND 1000000000000000) AND
    (low_balance_threshold_minor IS NULL OR low_balance_threshold_minor BETWEEN -1000000000000000 AND 1000000000000000)),

  CONSTRAINT accounts_dates_shaped CHECK (
    (bank_balance_date    IS NULL OR bank_balance_date    LIKE '____-__-__') AND
    (last_reconciled_date IS NULL OR last_reconciled_date LIKE '____-__-__') AND
    (opening_balance_date IS NULL OR opening_balance_date LIKE '____-__-__') AND
    (archive_through_date IS NULL OR archive_through_date LIKE '____-__-__')),

  CONSTRAINT accounts_currency_shaped CHECK (length(currency) = 3 AND currency = upper(currency)),

  -- R-12, self-referential. Twin of accounts_parent_account_id_user_fkey
  -- (20260808170000:486-490). No ON DELETE clause: SQLite cannot null one
  -- column of a composite key, so trg_unnest_account_references does it.
  FOREIGN KEY (parent_account_id, user_id) REFERENCES accounts(id, user_id)
) STRICT;

CREATE INDEX idx_accounts_user       ON accounts(user_id);
CREATE INDEX idx_accounts_parent     ON accounts(parent_account_id) WHERE parent_account_id IS NOT NULL;

-- R-12's ANCHOR. Redundant as a uniqueness claim — id is the primary key — and
-- that is the point: it exists so that (id, user_id) is a legal foreign-key
-- TARGET, which is the only way a child row can be made to carry its account's
-- owner. Twin of accounts_id_user_unique (20260808170000:426-427).
--
-- SQLite needs this for a second reason Postgres does not have: the parent
-- columns of a composite key must be covered by a UNIQUE INDEX specifically,
-- and without one every child insert fails with "foreign key mismatch" — a
-- message about the SCHEMA that says nothing about the row. Verified.
CREATE UNIQUE INDEX accounts_id_user_unique ON accounts(id, user_id);


-- ============================================================================
-- 3. CATEGORIES
-- ============================================================================

CREATE TABLE categories (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('income','expense','both')),
  level        TEXT NOT NULL CHECK (level IN ('type','sub','detail')),
  parent_id    TEXT REFERENCES categories(id) ON DELETE CASCADE,

  -- R-12 pairs this with user_id; the key is at the foot of the table. A
  -- category filed against a stranger's account is a category nothing can ever
  -- clean up through the UI (20260808170000:110-116). ON DELETE CASCADE is
  -- unchanged from the single-column key it replaced, and needs no column list:
  -- the account going takes the whole row.
  account_id   TEXT,
  color        TEXT,
  icon         TEXT,
  is_system                INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  is_transfer_category     INTEGER NOT NULL DEFAULT 0 CHECK (is_transfer_category IN (0,1)),
  is_revaluation_category  INTEGER NOT NULL DEFAULT 0 CHECK (is_revaluation_category IN (0,1)),
  is_unassigned_bucket     INTEGER NOT NULL DEFAULT 0 CHECK (is_unassigned_bucket IN (0,1)),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- A To/From category belongs to exactly one account, and only that kind does
  -- (20260708140000_transfer_categories_lifecycle.sql). NEW — the cloud has no
  -- such constraint and nothing stops an ordinary category acquiring an
  -- account_id.
  CONSTRAINT categories_account_only_for_transfer
    CHECK ((account_id IS NULL) OR is_transfer_category = 1),

  -- The three semantic flags are mutually exclusive. is_unassigned_bucket
  -- DECLASSIFIES (20260724100000:21-23) while the other two CLASSIFY; a row
  -- carrying two of them has no defined meaning in utils/incomeExpense.ts.
  -- NEW — the cloud has no such constraint.
  CONSTRAINT categories_flags_exclusive
    CHECK (is_transfer_category + is_revaluation_category + is_unassigned_bucket <= 1),

  -- R-12. Twin of categories_account_id_user_fkey (20260808170000:499-503).
  FOREIGN KEY (account_id, user_id) REFERENCES accounts(id, user_id) ON DELETE CASCADE
) STRICT;

-- initial-schema.sql:938. NULLs are distinct in a UNIQUE index in BOTH engines
-- (verified in SQLite), so two type-level roots may share a name — same
-- behaviour as Postgres, deliberately.
CREATE UNIQUE INDEX ux_categories_user_name_parent ON categories(user_id, name, parent_id);
CREATE INDEX idx_categories_user     ON categories(user_id);
CREATE INDEX idx_categories_parent   ON categories(parent_id);
CREATE INDEX idx_categories_account  ON categories(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX idx_categories_transfer ON categories(user_id, is_transfer_category) WHERE is_transfer_category = 1;


-- ============================================================================
-- 4. TRANSACTIONS
-- ============================================================================

CREATE TABLE transactions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The ledger's own account reference, and the defect
  -- 20260808170000_rows_cannot_name_a_foreign_account.sql was written for.
  -- R-12 pairs it with user_id; the key is at the foot of the table. ON DELETE
  -- CASCADE is unchanged and needs no column list — the account going takes the
  -- row entire.
  account_id    TEXT NOT NULL,
  description   TEXT NOT NULL,

  -- Signed, minor units. Expenses negative, income positive — the convention
  -- 20260310000500_fix_expense_amount_signs.sql normalised the data to.
  amount_minor  INTEGER NOT NULL,

  type          TEXT NOT NULL CHECK (type IN ('income','expense','transfer')),
  date          TEXT NOT NULL CHECK (date LIKE '____-__-__'),

  -- TEXT holding a category id. Deliberately NOT a foreign key — see
  -- DESIGN.md invariant R-3. The cloud has the same gap and legacy sentinels
  -- ('transfer-in'/'transfer-out') live in this column, so an FK would reject
  -- data the cloud accepts. A verify_integrity() check reports danglers.
  category      TEXT,
  category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,

  notes         TEXT,
  merchant_name TEXT,
  location_city TEXT,
  location_country TEXT,
  payment_channel  TEXT,

  is_recurring  INTEGER NOT NULL DEFAULT 0 CHECK (is_recurring IN (0,1)),
  is_cleared    INTEGER NOT NULL DEFAULT 0 CHECK (is_cleared IN (0,1)),

  -- Microsoft Money's R, and the ONLY thing a finalize produces
  -- (20260810200000_marking_is_not_reconciling.sql:107-114). `is_cleared` above
  -- is the C beside it: a working mark, kept, settling nothing.
  --
  -- THREE-VALUED, and the third value is the point. NULL means "this row
  -- predates the split between marking and committing; ask is_cleared", which is
  -- the rule src/utils/transactionReconciliation.ts holds for the app and
  -- COALESCE(is_reconciled, is_cleared) holds in SQL. 0 means marked or not but
  -- explicitly NOT committed; 1 means committed by a finalize.
  --
  -- DEFAULT 0, and the cloud's own two-statement trick is BOTH unavailable here
  -- and unnecessary. The cloud added the column bare and then set the default,
  -- because a column added WITH one gives existing rows that default through
  -- attmissingval and would silently answer "not committed" for the whole of
  -- history. MEASURED (probe-addcolumn.mjs, node:sqlite 3.50.0): SQLite does
  -- exactly the same — after `ALTER TABLE t ADD COLUMN c INTEGER DEFAULT 0`, a
  -- row written BEFORE the alter reads 0 and not NULL, with no rewrite — and
  -- SQLite has no `ALTER COLUMN … SET DEFAULT` at all (`near "ALTER": syntax
  -- error`), so the two-step cannot be spelled. It is not needed: this file is
  -- CREATEd rather than migrated, so it has no pre-split rows of its own, and
  -- the default is what every INSERT that says nothing about the column gets —
  -- which is the cloud's answer too, and the migration's rule that "a
  -- transaction is born uncommitted whether it was typed, imported or
  -- downloaded". A bank-feed row still arrives is_cleared = 1; that is a mark.
  --
  -- WHERE A NULL CAN STILL ARRIVE: a restored cloud backup, whose rows carry
  -- NULL for the whole of a user's history. DISCHARGED 2026-08-11 by slice 25,
  -- which is the slice that could measure it — a round trip needs a collector,
  -- and until there was one nothing could produce the file this rule is about.
  --
  -- The obligation as recorded here anticipated the right FIX and the wrong
  -- RULE, and the difference is worth keeping. It said the fix was "one Kind in
  -- crate::backup that tells absent from null", with an absent key still taking
  -- the default. The differential spec (restore-a-deliberate-null-is-not-the-
  -- same-as-a-column-the-file-never-mentioned) measured that against the cloud
  -- and found it diverging: 0 here, NULL there. The cloud's own rule, from
  -- 20260811090000, fills a silence from the schema's default for exactly one
  -- class — NOT NULL columns with a constant default — so a NULLABLE column is
  -- never reached by it at all. `crate::backup` now says the same thing in one
  -- sentence: a column that may hold null is given what the file says, or NULL;
  -- a column that may not is given what the file says, or its default. So a
  -- restored pre-split history reads as history rather than as a decade of
  -- reconciliations offered back to be done again.
  is_reconciled INTEGER DEFAULT 0 CHECK (is_reconciled IN (0,1)),

  is_split      INTEGER NOT NULL DEFAULT 0 CHECK (is_split IN (0,1)),
  archived      INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),

  -- The bank's own order within a day. Ordinal, never a time
  -- (20260808090000_transaction_statement_sequence.sql:75-78).
  statement_sequence INTEGER,

  -- Has a human vouched for `category`?
  -- (20260808100000_category_provenance.sql:104-107). 0 = the app guessed it
  -- (the smart categoriser on a file import, payee memory on a bank feed) and
  -- nobody has agreed yet; 1 = the user typed, picked or edited it, or their
  -- own imported file stated it. DEFAULT 1 for the reason the cloud gives:
  -- "any writer that does not know about provenance produces a confirmed row,
  -- and existing history reads as confirmed". Counts in reports identically
  -- either way — this records who decided, never what was decided.
  --
  -- No index, matching the cloud's stated reasoning: nothing filters on it
  -- server-side, and an index no query uses is write cost with no read benefit.
  category_confirmed INTEGER NOT NULL DEFAULT 1 CHECK (category_confirmed IN (0,1)),

  -- Did this row arrive from an import that nobody has looked at yet?
  -- (20260810090000_imported_rows_arrive_new.sql). 1 = it came in on a
  -- statement file or a bank feed and no save has been made against it since;
  -- the register prints it in bold, counts it in the "To Review" box and can
  -- filter down to it. 0 = reviewed, or never needed reviewing. DEFAULT 0 for
  -- the reason the cloud gives: "any writer that does not know about review
  -- produces a reviewed row, and existing history reads as reviewed". Never
  -- affects a figure.
  --
  -- A DIFFERENT QUESTION FROM category_confirmed above, not a duplicate of it:
  -- that one asks whether a human vouched for one FIELD, this one whether a
  -- human has seen the ROW. A statement row can carry a category the file
  -- itself stated (confirmed) and still be a transaction nobody has read.
  --
  -- No index, same reasoning as category_confirmed: nothing filters on it in
  -- the store, and an index no query uses is write cost with no read benefit.
  needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1)),

  -- Transfer structure (20260716100000, 20260720120000).
  --
  -- R-12's WEAKEST link and the reason the pairing is not optional: the cloud's
  -- create_transaction_atomic copies transfer_account_id straight out of the
  -- caller's payload with no ownership check at all (20260808150000:196), so
  -- this one was reachable through a TRUSTED RPC and not only through a raw
  -- insert. MEASURED on the reference cluster before the key existed: accepted;
  -- after: refused (probe-fk-verbs.sql, P1). The key is at the foot of the
  -- table, and the clearing is trg_unnest_account_references'.
  transfer_account_id      TEXT,
  linked_transfer_id       TEXT REFERENCES transactions(id) ON DELETE SET NULL
                             DEFERRABLE INITIALLY DEFERRED,
  linked_transfer_split_id TEXT REFERENCES transaction_splits(id) ON DELETE SET NULL
                             DEFERRABLE INITIALLY DEFERRED,

  -- File-import provenance (20260722170000). NOT the bank feed.
  import_source    TEXT,
  import_source_id TEXT,

  -- Bank-feed provenance. Kept so a cloud backup restores losslessly; no FK,
  -- because bank_connections does not exist in a local file.
  connection_id           TEXT,
  external_transaction_id TEXT,
  external_provider       TEXT CHECK (external_provider IS NULL OR external_provider IN ('truelayer','plaid')),

  -- ── Money promoted out of the JSONB blob ─────────────────────────────────
  -- See DESIGN.md §3. These were untyped floats inside metadata
  -- (src/types/index.ts:160-166). Anything that can change a figure is a
  -- typed integer column now.
  fee_minor             INTEGER,
  original_amount_minor INTEGER,
  original_currency     TEXT,
  fx_rate_e10           INTEGER,

  -- Everything else the blob carried. Money is BANNED from it by CHECK, so it
  -- cannot creep back in as a float (verified: the CHECK fires).
  metadata      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),

  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- 20260722170000:60-63 — both or neither.
  CONSTRAINT transactions_import_provenance_complete
    CHECK ((import_source IS NULL) = (import_source_id IS NULL)),

  CONSTRAINT transactions_amount_bounded
    CHECK (amount_minor BETWEEN -100000000000 AND 100000000000),

  CONSTRAINT transactions_promoted_money_bounded CHECK (
    (fee_minor IS NULL OR fee_minor BETWEEN -100000000000 AND 100000000000) AND
    (original_amount_minor IS NULL OR original_amount_minor BETWEEN -100000000000 AND 100000000000) AND
    (fx_rate_e10 IS NULL OR (fx_rate_e10 > 0 AND fx_rate_e10 <= 1000000000000000000))),

  -- FX triple is all-or-nothing: a converted amount with no rate, or a rate
  -- with no source currency, is unusable. NEW — the blob enforced nothing.
  CONSTRAINT transactions_fx_complete CHECK (
    (original_amount_minor IS NULL AND original_currency IS NULL AND fx_rate_e10 IS NULL)
    OR (original_amount_minor IS NOT NULL AND original_currency IS NOT NULL AND fx_rate_e10 IS NOT NULL)),

  -- Money may not hide in the blob again. Each key listed here is one that
  -- src/types/index.ts declared as `number`.
  CONSTRAINT transactions_no_money_in_metadata CHECK (
    json_extract(metadata,'$.transferMetadata.fees')           IS NULL AND
    json_extract(metadata,'$.transferMetadata.exchangeRate')   IS NULL AND
    json_extract(metadata,'$.transferMetadata.originalAmount') IS NULL AND
    json_extract(metadata,'$.transferMetadata.pricePerUnit')   IS NULL AND
    json_extract(metadata,'$.transferMetadata.marketValue')    IS NULL AND
    json_extract(metadata,'$.transferMetadata.costBasis')      IS NULL AND
    json_extract(metadata,'$.transferMetadata.units')          IS NULL AND
    json_extract(metadata,'$.transferMetadata.expectedAmount') IS NULL AND
    json_extract(metadata,'$.transferMetadata.actualAmount')   IS NULL AND
    json_extract(metadata,'$.transferMetadata.discrepancy')    IS NULL AND
    json_extract(metadata,'$.investmentData')                  IS NULL),

  -- A split parent's categorisation lives in its lines
  -- (20260713100000:225-227). In the cloud this is only ever true because the
  -- RPC writes it; here it is a constraint.  NEW.
  CONSTRAINT transactions_split_parent_has_blank_category
    CHECK (is_split = 0 OR COALESCE(trim(category),'') = ''),

  -- A transfer cannot be split (20260713100000:153-155). NEW as a constraint.
  CONSTRAINT transactions_transfer_not_split
    CHECK (NOT (is_split = 1 AND type = 'transfer')),

  -- Committed implies marked (20260810200000:130-136, and the migration's own
  -- verification 7, which is a SELECT looking for rows in this state).
  --
  -- The cloud keeps it in ONE function — set_transactions_cleared's CASE, whose
  -- unmark branch writes `is_reconciled = false` — and nowhere else, so its
  -- update RPC can leave a row committed-but-unmarked and the migration ships a
  -- query to go and find them. Here it is a property of the file, which is
  -- DESIGN.md §6's argument applied to the newest column in it: the pair
  -- (committed, unmarked) puts the cleared balance and the reconciled set
  -- permanently out of step, and a rule enforced in one writer is a rule the
  -- next writer skips.
  --
  -- `IS NOT 1` rather than `<> 1`, because the third value has to pass: a NULL
  -- row is pre-split history whose commitment nobody has answered, and `NULL <>
  -- 1` is NULL, which a CHECK treats as satisfied — true here by luck rather
  -- than by statement. Written as `IS NOT` so it is true by statement.
  --
  -- DECLARED DIVERGENCE, with a spec: update_transaction's `is_cleared` field
  -- can reach this. Unticking a committed row is accepted by the cloud (leaving
  -- exactly the pair verification 7 hunts for) and refused by this file. There
  -- is no `unreconcile` operation in the seam on either engine, so the local
  -- answer is "a committed row stays ticked", which is Money's behaviour and
  -- what the register must be told before it offers the tick.
  CONSTRAINT transactions_reconciled_implies_cleared
    CHECK (is_reconciled IS NOT 1 OR is_cleared = 1),

  -- A linked transfer must name the other account (20260716100000:121-137).
  CONSTRAINT transactions_linked_has_target
    CHECK (linked_transfer_id IS NULL OR transfer_account_id IS NOT NULL),

  -- A transfer never points at its own account.
  CONSTRAINT transactions_transfer_two_accounts
    CHECK (transfer_account_id IS NULL OR transfer_account_id <> account_id),

  CONSTRAINT transactions_no_self_link
    CHECK (linked_transfer_id IS NULL OR linked_transfer_id <> id),

  CONSTRAINT transactions_timestamps_shaped
    CHECK (created_at LIKE '____-__-__T%Z' AND updated_at LIKE '____-__-__T%Z'),

  -- R-12. Twins of transactions_account_id_user_fkey (20260808170000:439-443)
  -- and transactions_transfer_account_id_user_fkey (:456-460).
  FOREIGN KEY (account_id, user_id)          REFERENCES accounts(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (transfer_account_id, user_id) REFERENCES accounts(id, user_id)
) STRICT;

-- ── Indexes. Measured, not guessed. ────────────────────────────────────────
-- Benchmark: 50,000 transactions / 8 accounts, this schema, SQLite 3.54,
-- median of 40 runs after 3 warm-ups (scratchpad/local-core/bench/):
--
--   balances aggregate      106.493 ms  →   3.463 ms   (30.8x)
--   register page, 200 rows   3.037 ms  →   0.098 ms   (31.0x)
--   category rollup, 6 mths   7.417 ms  →   3.921 ms   ( 1.9x)
--   file size                 8.90 MB   →  17.87 MB    ( 2.0x — the price)
--
-- The Phase 0 spike measured the whole IPC boundary at 0.145–0.162 ms per
-- invoke. The balances index is worth 103 ms. Index design carries roughly
-- 640x the leverage of transport design; that ratio is the reason this section
-- exists at all.

-- Covering index for the balances aggregate. The four columns are exactly what
-- the aggregate touches, so the query is index-only (EXPLAIN QUERY PLAN:
-- "SEARCH t USING COVERING INDEX idx_txn_balance_cover").
CREATE INDEX idx_txn_balance_cover ON transactions(account_id, user_id, amount_minor, id);

-- The register: one account, newest first, the bank's own order breaking ties
-- within a day. SQLite does NOT accept NULLS LAST in an index definition
-- (verified: "unsupported use of NULLS LAST"), so the NULLS-LAST semantics of
-- idx_transactions_statement_order (20260808090000:92-93) are expressed as the
-- expression `(statement_sequence IS NULL)`, which sorts 0 (known) before
-- 1 (unknown) — exactly compareChronological's rule. Partial on archived = 0
-- to match the live register, mirroring idx_transactions_live.
CREATE INDEX idx_txn_register ON transactions(
  account_id, date DESC, (statement_sequence IS NULL), statement_sequence DESC
) WHERE archived = 0;

-- Whole-user paging: transactionService.ts:389-391 orders date DESC, id DESC.
CREATE INDEX idx_txn_user_page ON transactions(user_id, date DESC, id DESC);

-- Reports: category totals over a period, index-only.
CREATE INDEX idx_txn_cat_period ON transactions(user_id, date, category, amount_minor);

-- Reconciliation: the uncleared list (mirrors idx_transactions_account_cleared,
-- 20260310000200:20-21).
CREATE INDEX idx_txn_uncleared ON transactions(account_id, date) WHERE is_cleared = 0;

-- Transfer navigation (mirrors idx_transactions_linked_transfer and
-- idx_transactions_linked_transfer_split).
CREATE INDEX idx_txn_linked       ON transactions(linked_transfer_id)       WHERE linked_transfer_id IS NOT NULL;
CREATE INDEX idx_txn_linked_split ON transactions(linked_transfer_split_id) WHERE linked_transfer_split_id IS NOT NULL;

-- Payee memory. The cloud indexes upper(btrim(description))
-- (20260708100000:24-26). SQLite's upper() is ASCII-ONLY — verified:
--     upper('café') --> 'CAFé'   (Postgres gives 'CAFÉ')
-- so a payee with a non-ASCII letter groups DIFFERENTLY on the two engines.
-- The generated column below is the single place that normalisation is
-- defined, so the divergence has exactly one site to fix (an ICU collation, or
-- a Rust-side normaliser writing the column) and exactly one test.
ALTER TABLE transactions ADD COLUMN description_norm TEXT
  GENERATED ALWAYS AS (upper(trim(description))) VIRTUAL;
CREATE INDEX idx_txn_payee ON transactions(account_id, description_norm, type, date DESC)
  WHERE category IS NOT NULL AND trim(category) <> '';

-- Import idempotence (20260722170000:67-68). Non-partial deliberately, as in
-- the cloud: NULLs are distinct in both engines, so unprovenanced rows never
-- collide.
CREATE UNIQUE INDEX ux_txn_import_source ON transactions(user_id, import_source, import_source_id);

-- Bank-feed dedupe (20260308000000:115-117), kept for restored cloud data.
CREATE UNIQUE INDEX ux_txn_external ON transactions(connection_id, external_transaction_id)
  WHERE external_transaction_id IS NOT NULL;


-- ── Tags: text[] has no SQLite equivalent, so it becomes a child table. ────
CREATE TABLE transaction_tags (
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag            TEXT NOT NULL CHECK (trim(tag) <> ''),
  PRIMARY KEY (transaction_id, tag)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_transaction_tags_tag ON transaction_tags(tag);


-- ============================================================================
-- 5. TRANSACTION SPLITS
-- ============================================================================

CREATE TABLE transaction_splits (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category       TEXT NOT NULL,          -- category id as text; see R-3
  amount_minor   INTEGER NOT NULL,       -- signed, same convention as transactions
  memo           TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,

  -- Split-line transfer legs (20260720120000:40-44). A split leg moves money to
  -- an account the same way a transfer does and is written by the same class of
  -- payload, so R-12 pairs it with user_id too (20260808170000:100-104); the
  -- key is at the foot of the table and the clearing is
  -- trg_unnest_account_references'.
  transfer_account_id TEXT,
  linked_transfer_id  TEXT REFERENCES transactions(id) ON DELETE SET NULL
                        DEFERRABLE INITIALLY DEFERRED,

  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- 20260713100000:43-44
  CONSTRAINT transaction_splits_category_not_blank CHECK (trim(category) <> ''),
  CONSTRAINT transaction_splits_amount_nonzero     CHECK (amount_minor <> 0),

  CONSTRAINT transaction_splits_amount_bounded
    CHECK (amount_minor BETWEEN -100000000000 AND 100000000000),

  -- A linked leg must name the account on the other side
  -- (20260806094058:314-331). NEW as a constraint.
  CONSTRAINT transaction_splits_linked_has_target
    CHECK (linked_transfer_id IS NULL OR transfer_account_id IS NOT NULL),

  -- R-12. Twin of transaction_splits_transfer_account_id_user_fkey
  -- (20260808170000:470-474).
  FOREIGN KEY (transfer_account_id, user_id) REFERENCES accounts(id, user_id)
) STRICT;

CREATE INDEX idx_splits_transaction ON transaction_splits(transaction_id, sort_order);
CREATE INDEX idx_splits_user_cat    ON transaction_splits(user_id, category);
CREATE INDEX idx_splits_linked      ON transaction_splits(linked_transfer_id) WHERE linked_transfer_id IS NOT NULL;
-- Covering index for the sum-check verify_integrity() runs after every split write.
CREATE INDEX idx_splits_sum_cover   ON transaction_splits(transaction_id, amount_minor);

-- The boot's whole-store split read: `list_transaction_splits`, which is
-- `.eq('user_id', …).order('transaction_id').order('sort_order')` plus this
-- crate's `id` tie-break. LOCAL-ONLY — the cloud has no counterpart, and needs
-- none: PostgREST pages that query 1,000 rows at a time behind RLS, while a file
-- answers it whole, once, on every boot.
--
-- MEASURED (crates/wealth-core/tests/reads_at_scale.rs, 50k transactions /
-- 8k split lines, debug profile):
--
--   without: SCAN transaction_splits USING INDEX idx_splits_transaction
--            + USE TEMP B-TREE FOR LAST TERM OF ORDER BY      8.9ms
--   with:    SEARCH transaction_splits USING INDEX idx_splits_user_display
--                                                             4.5ms
--
-- The 2× is the smaller half of the reason. The larger half is the word SCAN:
-- without this index the read walks EVERY login's lines and discards the ones
-- that are not the caller's, so the cost is a property of the file rather than
-- of the answer — and a restored two-login file (B-3) is exactly the case the
-- reads were given a required owner for. The write cost is four columns on a
-- table written a line set at a time.
CREATE INDEX idx_splits_user_display ON transaction_splits(user_id, transaction_id, sort_order, id);


-- ============================================================================
-- 6. THE RPC GUARD
-- ============================================================================
-- Postgres gates its split guard on a transaction-local session variable
-- (`current_setting('app.split_rpc', true)`, 20260713100000:73). SQLite has no
-- session variables, so the same mechanism is a one-row temp table that only
-- the command layer creates, and only for the life of one transaction.
--
--   BEGIN IMMEDIATE;
--   INSERT OR IGNORE INTO _rpc_guard VALUES ('split');
--   ... writes ...
--   DELETE FROM _rpc_guard WHERE flag = 'split';
--   COMMIT;
--
-- It must be a REAL table, not a TEMP one. VERIFIED: a persistent trigger
-- cannot reference temp objects —
--     Parse error: trigger trg_protect_split_is_split cannot reference
--                  objects in database temp
-- so the TEMP-table version of this design does not compile. The real table
-- is set and cleared inside the SAME transaction as the writes it authorises,
-- so a crash rolls the flag back with everything else; a stray row is
-- therefore impossible rather than merely unlikely, and verify_integrity()
-- reports one anyway.
--
-- HARDENING OPTION (not taken in Phase 1, recorded here): replace the table
-- with an application-defined SQL function `rpc_guard(flag)` registered by the
-- Rust layer. The file then stays READABLE by any tool while being WRITABLE
-- only by a process that supplies the function — the closest local analogue of
-- "only the RPC may write". Rejected for Phase 1 because it makes the
-- differential harness's SQLite driver depend on the Rust binary even for
-- setup fixtures.

CREATE TABLE _rpc_guard(flag TEXT PRIMARY KEY) STRICT;


-- ── Split parents are read-only outside the split writers ──────────────────
-- Port of protect_split_transaction_fields (20260713100000:67-105). BEFORE
-- UPDATE + RAISE(ABORT) works verbatim in SQLite (verified). The error strings
-- are the cloud's, character for character, because the client surfaces
-- error.message to the user.

CREATE TRIGGER trg_protect_split_is_split
BEFORE UPDATE OF is_split ON transactions
WHEN NEW.is_split IS NOT OLD.is_split
 AND NOT EXISTS (SELECT 1 FROM _rpc_guard WHERE flag = 'split')
BEGIN
  SELECT RAISE(ABORT, 'is_split can only change through set_transaction_splits');
END;

CREATE TRIGGER trg_protect_split_amount
BEFORE UPDATE OF amount_minor ON transactions
WHEN OLD.is_split = 1 AND NEW.amount_minor IS NOT OLD.amount_minor
 AND NOT EXISTS (SELECT 1 FROM _rpc_guard WHERE flag = 'split')
BEGIN
  SELECT RAISE(ABORT, 'split_amount_locked: this transaction is split — its amount is the sum of its splits; edit the splits instead');
END;

CREATE TRIGGER trg_protect_split_type
BEFORE UPDATE OF type ON transactions
WHEN OLD.is_split = 1 AND NEW.type IS NOT OLD.type
 AND NOT EXISTS (SELECT 1 FROM _rpc_guard WHERE flag = 'split')
BEGIN
  SELECT RAISE(ABORT, 'split_type_locked: remove the split before changing the transaction type');
END;

CREATE TRIGGER trg_protect_split_category
BEFORE UPDATE OF category ON transactions
WHEN OLD.is_split = 1 AND trim(COALESCE(NEW.category,'')) <> ''
 AND NOT EXISTS (SELECT 1 FROM _rpc_guard WHERE flag = 'split')
BEGIN
  SELECT RAISE(ABORT, 'split_category_locked: this transaction is split — its categorisation lives in its split lines');
END;

-- ── A linked split leg is immutable except for memo and position ───────────
-- Port of 20260806094058:314-331. In the cloud these are procedural checks
-- inside set_transaction_splits_with_legs; here they are constraints, so a
-- future code path that forgets them still cannot break the pair.
CREATE TRIGGER trg_protect_linked_leg
BEFORE UPDATE ON transaction_splits
WHEN OLD.linked_transfer_id IS NOT NULL
 AND (NEW.amount_minor IS NOT OLD.amount_minor
   OR NEW.transfer_account_id IS NOT OLD.transfer_account_id
   OR NEW.category IS NOT OLD.category
   OR NEW.linked_transfer_id IS NOT OLD.linked_transfer_id)
 AND NOT EXISTS (SELECT 1 FROM _rpc_guard WHERE flag = 'leg')
BEGIN
  SELECT RAISE(ABORT, 'split_leg_locked: that line is one half of a transfer — delete that transfer first, then edit the split');
END;

CREATE TRIGGER trg_protect_linked_leg_delete
BEFORE DELETE ON transaction_splits
WHEN OLD.linked_transfer_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM _rpc_guard WHERE flag = 'leg')
BEGIN
  SELECT RAISE(ABORT, 'split_leg_line_removed: that line is one half of a transfer — the transaction on the other side would be left pointing at a line that no longer exists');
END;

-- ── Transfer categories are managed from their account ─────────────────────
-- The whole lifecycle from 20260708140000_transfer_categories_lifecycle.sql:
-- an account MINTS its To/From category on insert (C-3), the category FOLLOWS
-- the account's name and open/closed state (C-4), and it cannot be deleted
-- while the account is there (C-5). All three are AFTER/BEFORE-shaped already,
-- so §2.3's "SQLite BEFORE triggers cannot assign to NEW" does not bite here:
-- the create and sync ports issue their own statements, and the protect port
-- only RAISEs. Verified: all three compile and fire under
-- PRAGMA trusted_schema = OFF.

-- C-3. Port of create_transfer_category_for_account (20260708140000:34-82).
--
-- Two behaviours are load-bearing and both are reproduced:
--   * it SKIPS when the user has no Transfer type anchor yet. The cloud comment
--     explains it (categories seed lazily; a parentless category renders as
--     junk) and the RESTORE PATH DEPENDS ON IT: restore_user_chunk inserts
--     accounts first, when no categories exist, so this trigger stands itself
--     down and the backup's own To/From rows land unopposed. A local restore
--     must keep that order for the same reason.
--   * it is COLLISION-GUARDED. categories are UNIQUE (user_id, name, parent_id)
--     while account names are not unique, so two accounts of the same name
--     would collide. The cloud uses ON CONFLICT … DO NOTHING so account
--     creation survives the clash; SQLite spells it identically. NOT
--     `INSERT OR IGNORE`, which would swallow every other constraint too.
--
-- The id: the cloud column defaults to gen_random_uuid(); this schema has no
-- such default, so the trigger builds a v4 UUID from randomblob(). random() is
-- non-deterministic, which bars it from CHECKs, generated columns and index
-- expressions — but not from a trigger body. Verified firing.
CREATE TRIGGER trg_create_transfer_category_for_account
AFTER INSERT ON accounts
WHEN EXISTS (SELECT 1 FROM categories
              WHERE user_id = NEW.user_id AND level = 'type'
                AND (type = 'both' OR name = 'Transfer'))
 AND NOT EXISTS (SELECT 1 FROM categories
                  WHERE account_id = NEW.id AND is_transfer_category = 1)
BEGIN
  INSERT INTO categories (id, user_id, name, type, level, parent_id,
                          is_system, is_transfer_category, account_id, is_active)
  VALUES (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2)
          || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2)
          || '-' || hex(randomblob(6))),
    NEW.user_id,
    'To/From ' || NEW.name,
    'both',
    'detail',
    -- Prefer the structural match (the Transfer type category is the only
    -- type-level 'both'); fall back to the name for legacy datasets.
    (SELECT id FROM categories
      WHERE user_id = NEW.user_id AND level = 'type'
        AND (type = 'both' OR name = 'Transfer')
      ORDER BY (type = 'both') DESC LIMIT 1),
    0, 1, NEW.id, NEW.is_active)
  ON CONFLICT (user_id, name, parent_id) DO NOTHING;
END;

-- C-4. Port of sync_transfer_category_for_account (20260708140000:90-119).
-- The rename follows the account and open/closed mirrors onto the category, so
-- a closed account's To/From row leaves the transaction dropdowns.
--
-- Collision-guarded the same way, and for the stated reason: an account rename
-- or a bank sync must NEVER abort on a category naming clash. A clash keeps the
-- old category name; is_active still syncs.
--
-- `AFTER UPDATE OF name, is_active` is narrower than the cloud's bare AFTER
-- UPDATE, and equivalent: a column's value cannot change unless it is in the
-- SET list. Writing updated_at here also stands the generic updated_at trigger
-- down (its WHEN is `NEW.updated_at IS OLD.updated_at`), so there is exactly
-- one write per row.
CREATE TRIGGER trg_sync_transfer_category_for_account
AFTER UPDATE OF name, is_active ON accounts
WHEN NEW.name IS NOT OLD.name OR NEW.is_active IS NOT OLD.is_active
BEGIN
  UPDATE categories
     SET name = CASE
           WHEN NOT EXISTS (SELECT 1 FROM categories x
                             WHERE x.user_id = categories.user_id
                               AND x.parent_id IS categories.parent_id
                               AND x.name = 'To/From ' || NEW.name
                               AND x.id <> categories.id)
           THEN 'To/From ' || NEW.name
           ELSE categories.name
         END,
         is_active = NEW.is_active,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE account_id = NEW.id AND is_transfer_category = 1;
END;

-- C-5. Port of protect_transfer_category (20260708140000:127-146), THREE
-- conditions, not two.
--
-- The users-row clause is not decoration. Without it, `DELETE FROM users` is
-- refused outright: the cascade reaches this category while its account row is
-- still there, this trigger raises, and the whole erasure aborts leaving every
-- row in place. MEASURED, both ways, on this schema:
--
--   two-condition  -> user erasure REFUSED: transfer_category_protected
--                     rows left: users 1, accounts 1, categories 2
--   THREE-condition-> user erasure SUCCEEDED, rows left: 0, 0, 0
--   Postgres, same operation -> SUCCEEDED, 0 rows left
--
-- So the cloud's third clause is what makes erasure immune to cascade ordering,
-- and dropping it locally (as an earlier draft of this file did, on the grounds
-- that a local file has no GDPR cascade) would have made "delete everything"
-- impossible rather than merely different.
CREATE TRIGGER trg_protect_transfer_category
BEFORE DELETE ON categories
WHEN OLD.is_transfer_category = 1
 AND OLD.account_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id)
 AND EXISTS (SELECT 1 FROM users    WHERE id = OLD.user_id)
BEGIN
  SELECT RAISE(ABORT, 'transfer_category_protected');
END;


-- ── updated_at ─────────────────────────────────────────────────────────────
-- Postgres uses a BEFORE UPDATE trigger that ASSIGNS NEW.updated_at
-- (update_updated_at_column, initial-schema.sql:354). SQLite triggers CANNOT
-- assign to NEW — verified: `SET NEW.u = 'x'` is a syntax error. The port is an
-- AFTER UPDATE trigger issuing its own UPDATE, which is safe only because
-- PRAGMA recursive_triggers defaults to OFF (verified: 0). If that pragma is
-- ever turned on, these loop.
--
-- The WHEN clause reproduces the restore exemption: the cloud stands the
-- trigger down while app.restore_in_progress is set (20260807083000:87-99) so
-- a restore does not re-date a decade of history. Here that is the guard flag.
CREATE TRIGGER trg_transactions_updated_at
AFTER UPDATE ON transactions
WHEN NEW.updated_at IS OLD.updated_at
 AND NOT EXISTS (SELECT 1 FROM _rpc_guard WHERE flag = 'restore')
BEGIN
  UPDATE transactions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_accounts_updated_at
AFTER UPDATE ON accounts
WHEN NEW.updated_at IS OLD.updated_at
 AND NOT EXISTS (SELECT 1 FROM _rpc_guard WHERE flag = 'restore')
BEGIN
  UPDATE accounts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_categories_updated_at
AFTER UPDATE ON categories
WHEN NEW.updated_at IS OLD.updated_at
 AND NOT EXISTS (SELECT 1 FROM _rpc_guard WHERE flag = 'restore')
BEGIN
  UPDATE categories SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_splits_updated_at
AFTER UPDATE ON transaction_splits
WHEN NEW.updated_at IS OLD.updated_at
 AND NOT EXISTS (SELECT 1 FROM _rpc_guard WHERE flag = 'restore')
BEGIN
  UPDATE transaction_splits SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;
-- (the same shape for budgets, goals, investments, notifications,
--  recurring_transactions, dashboard_layouts, widget_preferences — eleven
--  tables in the cloud, per the comment at 20260807083000:101)


-- ── The reconcile-sweep ────────────────────────────────────────────────────
-- Port of sweep_reconciled_into_archive as RESTATED by
-- 20260810200000_marking_is_not_reconciling.sql:336-361, which is the live
-- definition; the original (20260721130000:123-148) hung off is_cleared because
-- that was the only flag there was. The cloud's version is a BEFORE trigger
-- that ASSIGNS NEW.archived := true. That cannot be done in SQLite, so it
-- becomes an AFTER trigger issuing an UPDATE.
--
-- This is a REAL behavioural difference, not just a syntactic one: the cloud
-- archives the row in the same statement that clears it, while this fires a
-- second statement afterwards. Anything watching for a single-statement change
-- sees two here. It is safe because recursive_triggers is OFF (the inner UPDATE
-- does not re-fire this trigger) and because both statements are inside the
-- caller's transaction.
--
-- IT HANGS OFF THE COMMITTED FLAG, AND THAT IS THE WHOLE OF THE C/R SPLIT HERE.
-- A working mark must never make a row vanish from the screen the ticking
-- happens on: a mark is reversible, and a row you cannot see is a row you cannot
-- unmark. Only finalizing is final, so only finalizing sweeps. This mirror kept
-- firing on is_cleared for two slices after the cloud moved, and
-- specs/a3-reconciling-an-old-row-archives-it is what said so on every run —
-- the two engines disagreed about whether ticking a row archives it.
CREATE TRIGGER trg_sweep_reconciled_into_archive
AFTER UPDATE OF is_reconciled ON transactions
WHEN NEW.is_reconciled = 1 AND OLD.is_reconciled IS NOT NEW.is_reconciled AND NEW.archived = 0
 AND EXISTS (
   SELECT 1 FROM accounts a
    WHERE a.id = NEW.account_id
      AND a.archive_through_date IS NOT NULL
      AND NEW.date <= a.archive_through_date)
BEGIN
  UPDATE transactions SET archived = 1 WHERE id = NEW.id;
END;


-- ── Suggestion dismissals die with their subject ───────────────────────────
-- Port of prune_suggestion_dismissals_for_transaction (20260806180000:156-170).
--
-- BEFORE, not AFTER — and the difference is the whole trigger. MEASURED
-- (slice 19): as an AFTER DELETE it never fired once. The cloud keeps the
-- subjects in a `text[]` ON the dismissal, so `subject_ids @> ARRAY[OLD.id]` is
-- still true whenever its trigger runs. This schema keeps them in a child table
-- with `ON DELETE CASCADE` on `transaction_id` (see the table, and the reason it
-- is a key rather than an array) — and SQLite applies that cascade before the
-- AFTER trigger, so by the time this statement looked for the subject rows they
-- had already gone with the transaction. The subquery matched nothing, the
-- dismissal survived, and nothing said a word.
--
-- What it costs is not a tidy-up: the dismissal is left naming a row that no
-- longer exists, with no subjects at all, and it travels into every backup taken
-- afterwards. `contract.ts`'s "forgets a refusal about a row that no longer
-- exists" is the rule that found it, and the rule says why the cloud does it
-- with a trigger and every other engine has to do it too.
--
-- BEFORE is safe: the DELETE below cascades the subject rows itself, the
-- transaction's own delete then finds nothing left to cascade, and a tidy-up
-- that runs a moment earlier cannot fail a financial delete any more than one
-- that runs a moment later.
CREATE TRIGGER trg_prune_suggestion_dismissals
BEFORE DELETE ON transactions
BEGIN
  DELETE FROM suggestion_dismissals
   WHERE user_id = OLD.user_id
     AND id IN (SELECT dismissal_id FROM suggestion_dismissal_subjects WHERE transaction_id = OLD.id);
END;


-- ============================================================================
-- 7. BUDGETS, GOALS
-- ============================================================================

CREATE TABLE budgets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  amount_minor  INTEGER NOT NULL,
  period        TEXT NOT NULL CHECK (period IN ('weekly','biweekly','monthly','quarterly','yearly','custom','every')),
  -- ANY REPEAT INTERVAL (7 Nov 2026, cloud 20261107150000): for period 'every',
  -- how many of which unit one cycle is. budgets_repeat_check below holds the
  -- pair to exactly those rows. A file made before this is SCHEMA VERSION 0
  -- and gains the columns on open — see the FILE VERSION block at the end.
  repeat_count  INTEGER,
  repeat_unit   TEXT,
  category      TEXT,                                          -- category id as text
  category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
  start_date    TEXT NOT NULL CHECK (start_date LIKE '____-__-__'),
  end_date      TEXT CHECK (end_date IS NULL OR end_date LIKE '____-__-__'),
  spent_minor           INTEGER NOT NULL DEFAULT 0,
  rollover              INTEGER NOT NULL DEFAULT 0 CHECK (rollover IN (0,1)),
  rollover_amount_minor INTEGER NOT NULL DEFAULT 0,

  -- NOT MONEY. numeric(5,2) in the cloud, default 80, meaning 80%.
  -- Stored as basis-points-of-a-percent (1e2), so 80.00% = 8000.
  alert_threshold_bp INTEGER NOT NULL DEFAULT 8000 CHECK (alert_threshold_bp BETWEEN 0 AND 10000),

  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  notes         TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT budgets_money_bounded CHECK (
    amount_minor          BETWEEN -1000000000000000 AND 1000000000000000 AND
    spent_minor           BETWEEN -1000000000000000 AND 1000000000000000 AND
    rollover_amount_minor BETWEEN -1000000000000000 AND 1000000000000000),
  CONSTRAINT budgets_period_ordered CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT budgets_repeat_check CHECK (
    -- IS NOT NULL first: a CHECK that evaluates to NULL PASSES in SQLite and
    -- in Postgres alike, so `NULL >= 1` would have let an 'every' row through
    -- with no interval at all. The crate's upgrade test proved it.
    (period = 'every' AND repeat_count IS NOT NULL AND repeat_count >= 1
      AND repeat_unit IS NOT NULL AND repeat_unit IN ('week','month'))
    OR (period <> 'every' AND repeat_count IS NULL AND repeat_unit IS NULL))
) STRICT;
CREATE INDEX idx_budgets_user ON budgets(user_id);

-- NOTE the widening vs cloud: budgets.spent and rollover_amount are
-- numeric(10,2) in Postgres (max ~£99.9m) while budgets.amount is
-- numeric(20,2). A budget over £99,999,999.99 already cannot record its own
-- spend in the cloud. Local uses one bound for all three. That is a deliberate
-- divergence and a differential test must expect it.

CREATE TABLE goals (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  description         TEXT,
  target_amount_minor  INTEGER NOT NULL,
  current_amount_minor INTEGER NOT NULL DEFAULT 0,
  target_date         TEXT CHECK (target_date IS NULL OR target_date LIKE '____-__-__'),
  category            TEXT,
  priority            TEXT CHECK (priority IS NULL OR priority IN ('low','medium','high')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','paused','canceled')),
  -- R-12 pairs this with user_id (20260808170000:510-514); the key is at the
  -- foot of the table, the clearing is trg_unnest_account_references'.
  account_id          TEXT,
  contribution_frequency TEXT CHECK (contribution_frequency IS NULL OR contribution_frequency IN ('daily','weekly','biweekly','monthly','yearly')),
  auto_contribute     INTEGER NOT NULL DEFAULT 0 CHECK (auto_contribute IN (0,1)),
  icon                TEXT,
  color               TEXT,
  completed_at        TEXT,
  metadata            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT goals_money_bounded CHECK (
    target_amount_minor  BETWEEN -1000000000000000 AND 1000000000000000 AND
    current_amount_minor BETWEEN -1000000000000000 AND 1000000000000000),

  -- R-12. Twin of goals_account_id_user_fkey (20260808170000:510-514).
  FOREIGN KEY (account_id, user_id) REFERENCES accounts(id, user_id)
) STRICT;
CREATE INDEX idx_goals_user ON goals(user_id);

CREATE TABLE goal_contributions (
  id             TEXT PRIMARY KEY,
  goal_id        TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_minor   INTEGER NOT NULL CHECK (amount_minor BETWEEN -100000000000 AND 100000000000),
  transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  date           TEXT NOT NULL CHECK (date LIKE '____-__-__'),
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX idx_goal_contributions_goal ON goal_contributions(goal_id, date);


-- ── R-12: clearing an account reference without clearing its owner ──────────
-- The SET NULL half of the ownership pairing, done by hand because SQLite will
-- not do it. Read "THE OWNERSHIP PAIRING" at the head of this file first; the
-- short version is that `ON DELETE SET NULL` on a composite key nulls EVERY
-- child key column, `user_id` is NOT NULL on all four of these tables, and
-- SQLite has no `ON DELETE SET NULL (column)` to name just the one. MEASURED:
-- a bare SET NULL turns "delete an account somebody transferred to" into
-- `NOT NULL constraint failed`.
--
-- So those four keys carry NO on-delete action — SQLite's default, NO ACTION,
-- checked immediately — and this trigger clears the references first. It runs
-- BEFORE the account row goes, which is the whole reason it works: by the time
-- the key is checked there is nothing left pointing at the row.
--
-- Each UPDATE names the owner as well as the account. That is redundant TODAY,
-- because the very keys this trigger serves guarantee a referencing row shares
-- the account's owner — and it is deliberate: if that guarantee were ever lost,
-- this trigger would leave the stray row behind and the account DELETE would be
-- REFUSED by the key rather than silently orphaning it. Loud, not quiet.
--
-- It lives here rather than beside the other triggers because a trigger body
-- may not name a table that does not exist yet, and `goals` is defined above
-- this line and below those.
--
-- WHAT IT DOES NOT DO: the three CASCADE keys (transactions.account_id,
-- categories.account_id, investments.account_id) are untouched — CASCADE needs
-- no column list, so the declaration still says it, and this trigger must not
-- pre-empt it. Deleting an account still takes its transactions (R-1), its
-- To/From category (C-3/C-5) and its holdings (R-9) exactly as before.
--
-- ── THE LINK CLEAR, AND WHY IT IS PART OF THE SAME TRIGGER ──────────────────
-- ADDED 2026-08-08, by the wipe port, which could not wipe. Two things that are
-- each individually right combine into a refusal the cloud does not have:
--
--   * `transactions_linked_has_target` — a LOCAL CHECK ("a linked transfer must
--     name the other account"). The cloud has no such constraint; the rule lives
--     procedurally inside its RPCs. MEASURED on the reference cluster: the only
--     CHECKs on public.transactions are the type enum, the provider enum and the
--     import-provenance pair.
--   * the two `transfer_account_id = NULL` statements above, which exist ONLY
--     because SQLite has no `ON DELETE SET NULL (column)`.
--
-- The trigger is BEFORE DELETE, so it nulls `transfer_account_id` while
-- `linked_transfer_id` is still set — a state that lasts one statement and that
-- the CHECK refuses. MEASURED, both engines, on a linked pair whose far side is
-- deleted:
--
--   postgres  ok       — 2 rows survive; the survivor reads transfer_account_id
--                        NULL, linked_transfer_id NULL
--   sqlite    REFUSED  — CHECK constraint failed: transactions_linked_has_target
--   sqlite    REFUSED  — the same, for a split leg:
--                        transaction_splits_linked_has_target
--
-- Postgres reaches BOTH nulls because the two are independent foreign-key
-- actions: `transfer_account_id` is SET NULL by the account key, and
-- `linked_transfer_id` is SET NULL by the transactions key when the counterpart
-- row — which lives IN the account being deleted — cascades away. It never sees
-- the half-nulled row because it never has to evaluate a constraint that would
-- object to one.
--
-- So the three UPDATEs below do the SAME work Postgres's own keys do, in the one
-- order that never produces a row the CHECK can object to: clear the LINKS whose
-- counterpart is about to cascade FIRST, then clear the targets. Note the
-- condition — a link is cleared only when the row (or split line) it names lives
-- in the account going away, which is exactly the set the cascade would have
-- nulled. A link pointing somewhere else is left alone.
--
-- The consequence if this is ever removed: `wipe_user_financial_data` — "delete
-- everything" — is REFUSED outright on any file containing one linked transfer,
-- which is every real file. The refusal names a CHECK about transfer targets
-- while the user is trying to erase the whole ledger, and there is no way
-- through it from the UI.
--
-- The verb still owes `_rpc_guard('leg')` on top of this: clearing a linked
-- leg's `linked_transfer_id` is an UPDATE of a watched column and
-- `trg_protect_linked_leg` raises `split_leg_locked` for it. MEASURED: with the
-- widened trigger and NO guard the split-leg case still refuses, and with the
-- guard it succeeds and the surviving line reads NULL/NULL. That is R-5 working
-- as designed, not a second defect — the guard is the caller's to hold.
CREATE TRIGGER trg_unnest_account_references
BEFORE DELETE ON accounts
BEGIN
  UPDATE transactions
     SET linked_transfer_id       = NULL,
         linked_transfer_split_id = NULL
   WHERE user_id = OLD.user_id
     AND (linked_transfer_id IN (SELECT id FROM transactions WHERE account_id = OLD.id)
       OR linked_transfer_split_id IN (SELECT s.id FROM transaction_splits s
                                         JOIN transactions t ON t.id = s.transaction_id
                                        WHERE t.account_id = OLD.id));
  UPDATE transaction_splits SET linked_transfer_id = NULL
   WHERE user_id = OLD.user_id
     AND linked_transfer_id IN (SELECT id FROM transactions WHERE account_id = OLD.id);
  UPDATE transactions       SET transfer_account_id = NULL
   WHERE transfer_account_id = OLD.id AND user_id = OLD.user_id;
  UPDATE transaction_splits SET transfer_account_id = NULL
   WHERE transfer_account_id = OLD.id AND user_id = OLD.user_id;
  UPDATE goals              SET account_id = NULL
   WHERE account_id = OLD.id AND user_id = OLD.user_id;
  UPDATE accounts           SET parent_account_id = NULL
   WHERE parent_account_id = OLD.id AND user_id = OLD.user_id;
END;


-- ============================================================================
-- 8. CUSTOM REPORTS
-- ============================================================================
-- The twin of 20260812140000_reports_outlive_the_browser.sql, and the only table
-- in this file whose cloud original was written because the work it holds was
-- not being kept ANYWHERE.
--
-- `src/services/customReportService.ts` is a real builder: summary statistics,
-- line, pie and bar charts, tables, category breakdowns and period-over-period
-- comparisons, every one of them computed from the user's own transactions. It
-- then saved the result to `window.localStorage`, under one key, on one machine.
-- The cloud's header records what that cost somebody with two computers. It cost
-- the LOCAL edition strictly more, which is why this table is not optional here:
-- the desktop promise is that the FILE is everything, and a report composed in a
-- desktop window lived in the WebView's storage rather than in the ledger it
-- described. Copying the file to another machine did not bring it. Nothing
-- anywhere said so.
--
-- ── IT HOLDS NO MONEY, AND THAT IS A PROPERTY RATHER THAN AN OMISSION ────────
--
-- Every other table in this section has a `_minor` column and a bounded CHECK
-- around it. This one has neither and must never gain either. A custom report is
-- a QUESTION about the ledger — which components, over which range, narrowed to
-- which accounts — and the answer is computed fresh from `transactions` every
-- time it is generated. A stored figure here would be a cache of an answer the
-- ledger can change underneath, and the reports page would start disagreeing
-- with the register for reasons nobody could see. The rule is the same one R-1
-- keeps for balances, arriving through a door that has no money in it: two
-- numbers are only worth having while they are arrived at independently, and a
-- report is not a second number, it is a second QUESTION.
--
-- ── WHY `components` IS AN ARRAY AND `filters` IS AN OBJECT, BY CHECK ────────
--
-- Because every reader ITERATES the one and INDEXES INTO the other, and
-- `json_valid()` on its own does not say which: it accepts a bare number, a
-- quoted string and an object equally, so a `components` holding `{}` would pass
-- validity and render as no report at all — a blank page with no error on it.
-- `json_type()` is what turns that into a refusal at the write, where the person
-- who typed it is still looking.
--
-- The SHAPE INSIDE stays the client's business (`ReportComponent[]` and the
-- filter object in `src/components/CustomReportBuilder.tsx`), so a component can
-- gain a config key without a migration; what may not vary is the container.
--
-- Order inside `components` is MEANINGFUL — it is the order the blocks render
-- in, top to bottom — which is why the write verbs replace this column wholesale
-- rather than merging into it the way the goal verbs merge `metadata`. The
-- argument is at `crate::verbs::update_custom_report`, and it is the reason this
-- table's two blobs are not `metadata` under another name.
--
-- ── THE ROW IDS INSIDE `filters`, WHICH THIS TABLE DOES NOT CONSTRAIN ────────
--
-- `filters.accounts` and `filters.categories` hold account and category ids.
-- They are opaque JSON content to this file: no foreign key reaches them, there
-- is no R-12 ownership pairing to make (the table has no `account_id` COLUMN for
-- one to hang off), and `trg_unnest_account_references` deliberately has no
-- branch for this table — there is no column for it to null. Deleting an account
-- therefore leaves a report still naming it, and the report simply narrows to
-- nothing for that account. That is exactly what the cloud's jsonb does, and
-- reproducing the absence is the port.
--
-- What DOES rewrite those ids is the backup remapper on the TypeScript side
-- (`remapBackupIds`, declared through ENTITY_REFERENCES in
-- `src/services/backup/format.ts`), and it is the only thing that CAN: it is the
-- only place holding the map from the file's ids to the fresh ones a restore
-- mints. `crates/wealth-core/src/backup.rs` reproduces none of it on purpose —
-- "ids arrive already remapped, or they do not arrive remapped at all".

CREATE TABLE custom_reports (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- What every list of reports displays, and the only thing here ever sorted or
  -- searched by. A real column rather than a key in one of the blobs for that
  -- reason alone.
  name        TEXT NOT NULL,
  -- NOT NULL with an empty default: the builder's field is optional, and a
  -- reader should never have to tell "no description" from "description
  -- unknown".
  description TEXT NOT NULL DEFAULT '',

  components  TEXT NOT NULL DEFAULT '[]'
                CHECK (json_valid(components) AND json_type(components) = 'array'),
  filters     TEXT NOT NULL DEFAULT '{}'
                CHECK (json_valid(filters) AND json_type(filters) = 'object'),

  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- A report with no name is one the list cannot offer you. The builder already
  -- refuses to save one; this is the same rule where it cannot be bypassed, and
  -- it catches the whitespace-only name the builder's own `if (!name)` does not.
  CONSTRAINT custom_reports_name_not_blank CHECK (length(trim(name)) > 0)
) STRICT;
CREATE INDEX idx_custom_reports_user ON custom_reports(user_id);

-- NOTE the divergences vs cloud. Each is deliberate and each is a differential
-- test's to expect:
--
--   * `jsonb` there, TEXT-with-`json_valid` here — this file's usual (see
--     `budgets.metadata`). One consequence is worth naming rather than
--     discovering: `jsonb` NORMALISES on the way in, losing key order and
--     whitespace, and TEXT does not. A report round-tripped through the two
--     engines is the same DOCUMENT and not the same BYTES.
--   * `uuid` and `timestamptz` there, TEXT here, and no `gen_random_uuid()`
--     default on the key — B-5, the same as `budgets.id` and `goals.id`: the id
--     is the caller's to mint or the verb's, never the column's.
--   * the cloud stamps `updated_at` from `update_custom_reports_updated_at`, a
--     BEFORE UPDATE trigger. There is no such trigger here, for the reason the
--     updated_at family in section 6 gives, so the verbs write the column
--     themselves.
--   * `custom_reports_definition_is_small` — 256 KiB over the two blobs — has NO
--     twin here, and the absence is a decision rather than an oversight. The
--     cloud's reason is bandwidth: a report that cached its own output would put
--     a second copy of the ledger into every boot's download. A local file
--     downloads nothing, so the same mistake costs disk instead of somebody's
--     morning, and a CHECK is the wrong instrument for it either way — it
--     refuses the save AFTER the report has been composed, which is the one
--     moment a person cannot act on the news. If it ever needs catching here,
--     `verify_integrity` (section 14) is where a local file keeps its "this is
--     odd" observations, at `severity = 'warning'`.
--   * RLS, the four owner policies and the anon revoke have no local twin at
--     all: one login, no PostgREST, and the file's owner can open it with any
--     SQLite tool (the point section 10 makes about the audit log). `user_id` is
--     still NOT NULL and still a foreign key, because a RESTORED file can hold
--     more than one login's rows.
--   * the cloud indexes `(user_id, updated_at DESC)` because its page lists
--     reports newest-first. This is the plain owner index every other table in
--     this file carries, because the local read orders by `created_at, id` —
--     this crate's own stated tie-break — and a covering index for a list of a
--     dozen rows is write cost bought against a sort of a dozen rows. The
--     argument, with the measurement behind it, is at `crate::verbs::reads`.

-- One row per category the user has ADJUSTED in the forecast scenario
-- (20260819150000): the monthly figure the scenario uses in place of the
-- twelve-month base average. Holds no ledger data and changes no figure —
-- the scenario reads the base and lays these on top; Budget is only ever
-- written by the explicit stage-2 promotion, which does not exist yet.
--
-- RELATIONAL rather than a json document keyed by category ids, and the
-- reason is the backup format's: the restore remapper rewrites uuid COLUMNS,
-- never the keys of a json object, so a document would restore verbatim into
-- a login with fresh ids and silently adjust nothing. As a column the
-- reference remaps, dangles loudly, and CASCADEs away with its category.
--
-- `monthly_minor` is an INTEGER of pennies — this file's money discipline;
-- a magnitude, with the category's own income/expense type saying which side
-- it lands on.
CREATE TABLE forecast_adjustments (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id   TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  monthly_minor INTEGER NOT NULL CHECK (monthly_minor >= 0),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- One adjustment per category per user — the scenario is a single stated
  -- figure, not a history of edits. Doubles as the by-owner lookup.
  CONSTRAINT forecast_adjustments_one_per_category UNIQUE (user_id, category_id)
) STRICT;


-- ============================================================================
-- 9. INVESTMENTS
-- ============================================================================
-- THE PRICE FIX. The cloud stores every unit price as numeric(10,2)
-- (initial-schema.sql:553, :575, :581) against quantities at numeric(20,8).
-- A share priced at £12.345 cannot be written; it rounds to £12.35 or £12.34
-- and the position value is wrong from that moment on. That is a pre-existing
-- schema bug, and this is a fresh schema, so it is fixed here:
--
--   prices are _e8 (8 decimal places), the same scale as quantity.
--
-- 8dp is chosen, not measured: it is exact for UK fund prices (4dp), US equity
-- (4dp), and sub-cent crypto down to £0.00000001. It is NOT enough for tokens
-- quoted below that, and the file records the scale in schema_meta so a later
-- widening is a migration rather than an archaeology exercise.
--
-- price_e8 * quantity_e8 is 1e16-scaled and overflows int64 for any position
-- over about £92. It is therefore NEVER computed in SQL. market_value_minor is
-- computed in the command layer in i128, rounded half-up to minor units, and
-- stored. cost_basis_minor likewise.

CREATE TABLE investments (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- R-12 pairs this with user_id; the key is at the foot of the table. Holdings
  -- roll up into a portfolio figure, so one filed against a stranger's account
  -- moves a number nobody can explain (20260808170000:119-121). ON DELETE
  -- CASCADE unchanged.
  account_id         TEXT,
  symbol             TEXT NOT NULL,
  name               TEXT NOT NULL,
  asset_type         TEXT NOT NULL CHECK (asset_type IN
                       ('stock','bond','etf','mutual_fund','crypto','commodity','real_estate','other')),
  exchange           TEXT,
  currency           TEXT NOT NULL DEFAULT 'GBP' CHECK (length(currency) = 3),

  quantity_e8        INTEGER NOT NULL CHECK (quantity_e8 BETWEEN -9000000000000000000 AND 9000000000000000000),
  cost_basis_minor   INTEGER NOT NULL CHECK (cost_basis_minor BETWEEN -1000000000000000 AND 1000000000000000),
  current_price_e8   INTEGER CHECK (current_price_e8 IS NULL OR (current_price_e8 >= 0 AND current_price_e8 <= 10000000000000000)),
  market_value_minor INTEGER CHECK (market_value_minor IS NULL OR market_value_minor BETWEEN -1000000000000000 AND 1000000000000000),
  purchase_date      TEXT CHECK (purchase_date IS NULL OR purchase_date LIKE '____-__-__'),
  purchase_price_e8  INTEGER CHECK (purchase_price_e8 IS NULL OR (purchase_price_e8 >= 0 AND purchase_price_e8 <= 10000000000000000)),
  last_updated       TEXT,
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- R-12. Twin of investments_account_id_user_fkey (20260808170000:522-525).
  FOREIGN KEY (account_id, user_id) REFERENCES accounts(id, user_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX idx_investments_user    ON investments(user_id);
CREATE INDEX idx_investments_account ON investments(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX idx_investments_symbol  ON investments(user_id, symbol);

CREATE TABLE investment_transactions (
  id                 TEXT PRIMARY KEY,
  investment_id      TEXT NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_type   TEXT NOT NULL CHECK (transaction_type IN ('buy','sell','dividend','split','transfer')),
  quantity_e8        INTEGER NOT NULL CHECK (quantity_e8 BETWEEN -9000000000000000000 AND 9000000000000000000),
  unit_price_e8      INTEGER NOT NULL CHECK (unit_price_e8 >= 0 AND unit_price_e8 <= 10000000000000000),
  total_amount_minor INTEGER NOT NULL CHECK (total_amount_minor BETWEEN -100000000000 AND 100000000000),
  fee_minor          INTEGER NOT NULL DEFAULT 0 CHECK (fee_minor BETWEEN -100000000000 AND 100000000000),
  tax_minor          INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor BETWEEN -100000000000 AND 100000000000),
  date               TEXT NOT NULL CHECK (date LIKE '____-__-__'),
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX idx_inv_txn_investment ON investment_transactions(investment_id, date);
-- tax_minor is NEW: investmentData.stampDuty was a float in the metadata blob
-- (src/types/index.ts:200) with nowhere typed to live.


-- ============================================================================
-- 10. RECURRING TEMPLATES
-- ============================================================================
-- The cloud keys these by user_profiles(clerk_user_id) TEXT, not users(id)
-- uuid — the odd one out that the restore RPC has to special-case
-- (20260807083000:337-346). Locally there is no Clerk, so this is a plain
-- users(id) FK and the special case disappears.

CREATE TABLE recurring_transactions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id   TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN -100000000000 AND 100000000000),
  type         TEXT NOT NULL CHECK (type IN ('income','expense')),
  category     TEXT NOT NULL,
  frequency    TEXT NOT NULL CHECK (frequency IN ('daily','weekly','biweekly','monthly','quarterly','yearly')),
  start_date   TEXT NOT NULL CHECK (start_date LIKE '____-__-__'),
  end_date     TEXT CHECK (end_date IS NULL OR end_date LIKE '____-__-__'),
  next_date    TEXT NOT NULL CHECK (next_date LIKE '____-__-__'),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  auto_create  INTEGER NOT NULL DEFAULT 1 CHECK (auto_create IN (0,1)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX idx_recurring_user_next ON recurring_transactions(user_id, next_date) WHERE is_active = 1;


-- ============================================================================
-- 11. AUDIT LOG
-- ============================================================================
-- In the cloud this table is immutable from the client because it has no
-- INSERT/UPDATE/DELETE policy and only a SECURITY DEFINER helper writes it
-- (20260610150000:35-43). None of that survives locally: the user owns the
-- file and can open it with any SQLite tool.
--
-- The honest local property is TAMPER-EVIDENT, not tamper-proof. The triggers
-- below stop the APP from rewriting history; the hash chain makes an
-- out-of-band edit detectable. Both are stated as such in DESIGN.md.

CREATE TABLE financial_audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('create','update','delete')),
  before_data TEXT CHECK (before_data IS NULL OR json_valid(before_data)),
  after_data  TEXT CHECK (after_data  IS NULL OR json_valid(after_data)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- Tamper evidence. seq is dense and monotonic; row_hash =
  -- SHA256(prev_hash || seq || entity || entity_id || action || before || after
  --        || created_at), computed in Rust. A gap in seq, or a hash that does
  -- not chain, is a report from verify_integrity() — not an error the app can
  -- prevent.
  seq         INTEGER NOT NULL UNIQUE,
  prev_hash   TEXT,
  row_hash    TEXT NOT NULL,

  CONSTRAINT audit_create_has_no_before CHECK (action <> 'create' OR before_data IS NULL),
  CONSTRAINT audit_delete_has_no_after  CHECK (action <> 'delete' OR after_data  IS NULL),
  CONSTRAINT audit_update_has_both      CHECK (action <> 'update' OR (before_data IS NOT NULL AND after_data IS NOT NULL))
) STRICT;

CREATE INDEX idx_audit_user_created ON financial_audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_entity       ON financial_audit_log(entity, entity_id);

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON financial_audit_log
BEGIN SELECT RAISE(ABORT,'audit_immutable'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON financial_audit_log
WHEN NOT EXISTS (SELECT 1 FROM _rpc_guard WHERE flag = 'audit_purge')
BEGIN SELECT RAISE(ABORT,'audit_immutable'); END;
-- The purge exemption is the local counterpart of purge_expired_audit_log
-- (20260611150000). It deletes from the OLD end only; verify_integrity()
-- re-checks that the surviving chain still chains from its new head.


-- ============================================================================
-- 12. SUGGESTION DISMISSALS
-- ============================================================================
-- The cloud stores subject_ids as uuid[] with a GIN index
-- (20260806180000:95, :109-110). SQLite has neither, so the array becomes a
-- child table — which is strictly better here: the prune trigger becomes an
-- indexed join instead of an array containment scan, and the "every id
-- resolves in exactly one table" property the column comment claims becomes a
-- foreign key instead of a promise.

CREATE TABLE suggestion_dismissals (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- NINE, matching 20260817220000 — this list and the cloud CHECK must widen
  -- together, and the parity lane is what notices when they do not.
  --
  -- 20260806180000:99-100 created the constraint with four kinds;
  -- 20260808120000 added payee-merchant and payee-line, and 20260808190000
  -- added payee-hidden, both by DROP + ADD of the whole constraint. This mirror
  -- predated those two, and the gap was RECORDED rather than closed in three
  -- places (crate `row/dismissal.rs`, `mappers/rows.ts`'s DISMISSAL_KINDS, and
  -- the read spec's notes) because nothing that existed could reach it: a read
  -- returns what is stored, and a payee dismissal could not be stored.
  --
  -- It is closed HERE, by exactly the argument that closed
  -- `last_reconciled_balance_minor` above: `dismissSuggestion(kind:
  -- DismissalKind, …)` is the seam's own signature, `DismissalKind` names every
  -- kind, and a value the seam's own type carries that this file cannot hold
  -- is a write the local edition would have to refuse while the cloud accepts
  -- it. Settings → Payee cleanup drives all three of the payee kinds through
  -- that one door (PayeeCleanup.tsx:433, :449, :491), so the four-kind CHECK
  -- was not a theoretical gap — it was that whole screen refusing to save on a
  -- local file. The restore path is the second half: a cloud backup carrying
  -- one payee dismissal would have been refused WHOLE, which is
  -- `restore_user_chunk`'s all-or-nothing rule doing exactly what it says.
  --
  -- The payee kinds are the same table and the same policies with two habits of
  -- their own, both of which this schema already supports without a change:
  -- `subject_key` holds ROLE-TAGGED, PERCENT-ENCODED PAYEE TEXT rather than ids
  -- (so a restore's id remapping cannot rewrite a payee name), and subject_ids
  -- is EMPTY — which is why the prune trigger below never removes one. That
  -- emptiness is correct rather than untidy: delete every transaction carrying
  -- the wording, re-import the statement, and the same wording arrives on brand
  -- new ids, so a refusal that expired with the rows would put the payee the
  -- user struck off straight back on the screen (20260808190000:57-61).
  --
  -- The two RECURRING kinds (20260817220000) answer "is this detected pattern
  -- a real commitment?" — recurring-confirmed is the first POSITIVE verdict
  -- stored here, the gate that lets a pattern feed the calendar and forecast;
  -- recurring-not moves it to a recoverable band. Same two habits as the
  -- payee kinds: no subject rows (a pattern outlives its rows), and a key
  -- whose payee text no id remapper can touch — with one role-prefixed
  -- ACCOUNT id segment that a restore's remapping rewrites in place, so the
  -- verdict follows the account into its new login.
  -- forecast-excluded (20260819130000): "not part of my typical month" —
  -- one row struck from the forecast BASE, key = the row's bare uuid,
  -- subject id carried so a deleted row takes its exclusion with it.
  kind         TEXT NOT NULL CHECK (kind IN (
                 'transfer-pair','transfer-leg','stranded','duplicate',
                 'payee-merchant','payee-line','payee-hidden',
                 'recurring-confirmed','recurring-not','forecast-excluded')),

  subject_key  TEXT NOT NULL CHECK (trim(subject_key) <> ''),
  dismissed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT suggestion_dismissals_unique_subject UNIQUE (user_id, kind, subject_key)
) STRICT;

CREATE TABLE suggestion_dismissal_subjects (
  dismissal_id   TEXT NOT NULL REFERENCES suggestion_dismissals(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  role_order     INTEGER NOT NULL,
  PRIMARY KEY (dismissal_id, role_order)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_dismissal_subjects_txn ON suggestion_dismissal_subjects(transaction_id);

CREATE TRIGGER trg_dismissals_no_update BEFORE UPDATE ON suggestion_dismissals
BEGIN SELECT RAISE(ABORT,'dismissal_immutable: a dismissal is created or deleted, never edited'); END;
-- Matches the cloud, which has no UPDATE policy for the same reason
-- (20260806180000:129-133).


-- ============================================================================
-- 13. UI STATE (carried so a cloud backup restores whole)
-- ============================================================================

CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('info','success','warning','error')),
  title        TEXT NOT NULL,
  message      TEXT,
  is_read      INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
  action_label TEXT,
  action_url   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE dashboard_layouts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  widgets    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(widgets)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
-- initial-schema.sql:1295. The cloud ALSO has a BEFORE trigger doing the same
-- job (initial-schema.sql:1617); the index alone is sufficient and the trigger
-- is not ported.
CREATE UNIQUE INDEX ux_one_default_layout ON dashboard_layouts(user_id) WHERE is_default = 1;

CREATE TABLE widget_preferences (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  widget_type    TEXT NOT NULL,
  settings       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings)),
  is_collapsed   INTEGER NOT NULL DEFAULT 0 CHECK (is_collapsed IN (0,1)),
  last_refreshed TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, widget_type)
) STRICT;

-- Mirrors supabase/migrations/20260809160000_preferences_that_travel.sql. One
-- row per user, one versioned document, holding every setting that belongs to
-- the account rather than to the browser.
--
-- Differences from the cloud, both forced by SQLite and neither a change of
-- meaning:
--   * jsonb has no local equivalent, so the document is TEXT guarded by
--     json_valid() plus json_type() = 'object' — the pair that reproduces the
--     cloud's jsonb-plus-jsonb_typeof check. A caller must not be able to store
--     an array here; every reader indexes into it by key.
--   * the cloud's size ceiling is `length(prefs::text) <= 262144`; length() over
--     the TEXT is literally the same measurement, so the number is carried
--     across unchanged rather than re-derived.
--
-- Account ids DO appear inside the document (dashboardKeyAccounts, the archive
-- overrides map). They are deliberately NOT foreign keys and cannot be: they sit
-- inside JSON, one level below anything a key can address. Nothing depends on
-- them resolving — a pinned account that no longer exists is skipped by the
-- dashboard, exactly as it is today — and the restore rewrites them through the
-- same id map every other reference goes through (see
-- backupService.remapPreferenceIds). That is the only mechanism available and
-- the only one needed; a preference is not a ledger entry.
-- Both CHECKs are NAMED, and the names are the cloud's own (amendment 9). An
-- anonymous CHECK is reported by SQLite as `CHECK constraint failed:` and the
-- expression, and by Postgres as the constraint's name — so a differential spec
-- asserting one refusal had to assert two different strings and would have gone
-- on passing if either engine started refusing for a different reason.
--
-- NOT a trigger, and NOT an `updated_at` stamp. `user_preferences` has no
-- triggers at all: the four ported above are the four the write paths could not
-- do for themselves, and the preferences verb writes its own stamp exactly as
-- the planning family's do.
CREATE TABLE user_preferences (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prefs      TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT user_preferences_prefs_is_object
    CHECK (json_valid(prefs) AND json_type(prefs) = 'object'),
  CONSTRAINT user_preferences_prefs_is_small CHECK (length(prefs) <= 262144),
  UNIQUE (user_id)
) STRICT;


-- ============================================================================
-- 14. verify_integrity() — the invariants no constraint can hold
-- ============================================================================
-- One view per whole-database invariant, plus one union that reports every
-- violation with a name. The Rust command runs it after every write in debug
-- and test builds, and on demand ("Check this file") in release. It is the
-- single highest-leverage artifact in the local core: every procedural
-- invariant that a future code path might drop is caught here.
--
-- CORRECTED 2026-08-08. This comment used to say *"each of these has a Postgres
-- twin, textually different but semantically identical, so the differential
-- harness can compare violation NAMES across engines"*. It does not. TRACED:
-- `grep -rn verify_integrity` over `supabase/`, `api/` and `src/` returns
-- nothing but this file and its own specs; there is no `CREATE VIEW` anywhere in
-- `supabase/migrations/`; and the only Postgres relatives of any of these are two
-- one-off verification SELECTs a migration runs once and discards
-- (20260808090000:292-299 and 20260807200000:100-110, both of B-1 alone). So
-- verify_integrity is a LOCAL-ONLY facility with no differential oracle, and the
-- specs that prove it say so — `crates/wealth-core/src/verbs/verify_integrity.rs`
-- carries the whole argument.
--
-- Two columns beyond the original three, added 2026-08-08 with the two ingest
-- checks (PHASE1-PLAN §2.5):
--
--   entity    which table the subject lives in, so a caller can resolve the id
--             without knowing every check by name
--   severity  'violation' (a rule of the ledger is broken) or 'warning' (a
--             HEURISTIC — see the two ingest checks at the foot). v_integrity_ok
--             counts only 'violation', so adding advisory checks cannot make the
--             existing "must be empty" assertion flaky.

CREATE VIEW v_integrity_violations AS

  -- B-1: balance = initial_balance + SUM(amount). Not enforceable by any
  --      constraint in either engine.
  SELECT 'balance_identity' AS check_name,
         'account'          AS entity,
         a.id               AS subject,
         'violation'        AS severity,
         'account balance is not initial_balance + sum(transactions)' AS detail
    FROM accounts a
    LEFT JOIN (SELECT account_id, SUM(amount_minor) AS total
                 FROM transactions GROUP BY account_id) t ON t.account_id = a.id
   WHERE a.balance_minor <> a.initial_balance_minor + COALESCE(t.total, 0)

UNION ALL
  -- S-1: split lines sum exactly to their parent.
  SELECT 'split_sum', 'transaction', t.id, 'violation',
         'split lines do not sum to the parent amount'
    FROM transactions t
    JOIN (SELECT transaction_id, SUM(amount_minor) AS total, COUNT(*) AS n
            FROM transaction_splits GROUP BY transaction_id) s
      ON s.transaction_id = t.id
   WHERE t.is_split = 1 AND s.total <> t.amount_minor

UNION ALL
  -- S-2: a split parent has at least two lines (20260713100000:185).
  SELECT 'split_min_lines', 'transaction', t.id, 'violation',
         'a split has fewer than two lines'
    FROM transactions t
   WHERE t.is_split = 1
     AND (SELECT COUNT(*) FROM transaction_splits s WHERE s.transaction_id = t.id) < 2

UNION ALL
  -- S-3: an unsplit transaction has no lines.
  SELECT 'orphan_split_lines', 'transaction', s.transaction_id, 'violation',
         'split lines on a transaction that is not split'
    FROM transaction_splits s
    JOIN transactions t ON t.id = s.transaction_id
   WHERE t.is_split = 0
   GROUP BY s.transaction_id

UNION ALL
  -- T-1: transfer links are MUTUAL. Enforced nowhere in the cloud; only
  --      repair_claimed_transfer even checks it (20260805145035:327-331).
  SELECT 'transfer_link_not_mutual', 'transaction', a.id, 'violation',
         'this row links to one that does not link back'
    FROM transactions a
    LEFT JOIN transactions b ON b.id = a.linked_transfer_id
   WHERE a.linked_transfer_id IS NOT NULL
     AND a.linked_transfer_split_id IS NULL
     AND (b.id IS NULL OR b.linked_transfer_id IS NOT a.id)

UNION ALL
  -- T-2: the two sides of a transfer move OPPOSITE WAYS and neither is zero.
  --
  --      Same currency — exactly opposite, as ever (20260716100000:108-111).
  --      Different currencies — opposite in SIGN only: two amounts in two
  --      currencies cancel only at a rate of exactly 1, so demanding it here
  --      would report every legitimately converted pair in the file as money
  --      appearing from nowhere. The verb was loosened in the same direction
  --      and for the same reason (20260812100000); a check stricter than the
  --      verb that writes the rows is a check that only ever cries wolf.
  --
  --      A missing account row falls to the STRICT branch, matching
  --      link_transfer_pair's `crossed_currencies`: a currency nobody can
  --      establish is not evidence of a conversion.
  SELECT 'transfer_amounts_not_opposite', 'transaction', a.id, 'violation',
         CASE WHEN aa.currency IS NOT NULL AND ba.currency IS NOT NULL
                   AND aa.currency <> ba.currency
              THEN 'linked transfer sides in different currencies both move the same way'
              ELSE 'linked transfer sides are not exact opposites'
         END
    FROM transactions a
    JOIN transactions b ON b.id = a.linked_transfer_id
    LEFT JOIN accounts aa ON aa.id = a.account_id
    LEFT JOIN accounts ba ON ba.id = b.account_id
   WHERE a.linked_transfer_split_id IS NULL
     AND CASE
           WHEN aa.currency IS NOT NULL AND ba.currency IS NOT NULL
                AND aa.currency <> ba.currency
             -- `> 0` rather than sign(): both sides are known non-zero by the
             -- time it is evaluated, and sign() is newer than the oldest
             -- SQLite this file is expected to open on.
             THEN a.amount_minor = 0 OR b.amount_minor = 0
                  OR (a.amount_minor > 0) = (b.amount_minor > 0)
           ELSE a.amount_minor = 0 OR a.amount_minor <> -b.amount_minor
         END

UNION ALL
  -- T-3: a transfer's two sides are in different accounts.
  SELECT 'transfer_same_account', 'transaction', a.id, 'violation',
         'both sides of this transfer are in one account'
    FROM transactions a
    JOIN transactions b ON b.id = a.linked_transfer_id
   WHERE a.account_id = b.account_id

UNION ALL
  -- T-4: a split-line leg is opposite to the LINE, never the parent
  --      (20260720120000:15-17).
  SELECT 'split_leg_amounts_not_opposite', 'split_line', s.id, 'violation',
         'a split leg and its counterpart are not exact opposites'
    FROM transaction_splits s
    JOIN transactions c ON c.id = s.linked_transfer_id
   WHERE s.amount_minor = 0 OR c.amount_minor <> -s.amount_minor

UNION ALL
  -- T-5: a counterpart that names a split line must be named back by it.
  SELECT 'split_leg_link_not_mutual', 'transaction', c.id, 'violation',
         'this row names a split line that does not name it back'
    FROM transactions c
    LEFT JOIN transaction_splits s ON s.id = c.linked_transfer_split_id
   WHERE c.linked_transfer_split_id IS NOT NULL
     AND (s.id IS NULL OR s.linked_transfer_id IS NOT c.id)

UNION ALL
  -- R-3: transactions.category and transaction_splits.category are TEXT with
  --      no FK, in BOTH engines. Danglers are reported, not rejected — the
  --      legacy 'transfer-in'/'transfer-out' sentinels are legal values.
  SELECT 'dangling_category_ref', 'transaction', t.id, 'violation',
         'category text names no category of this user'
    FROM transactions t
   WHERE t.category IS NOT NULL
     AND trim(t.category) <> ''
     AND t.category NOT IN ('transfer-in','transfer-out')
     AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = t.category AND c.user_id = t.user_id)

UNION ALL
  SELECT 'dangling_split_category_ref', 'split_line', s.id, 'violation',
         'split line category names no category of this user'
    FROM transaction_splits s
   WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = s.category AND c.user_id = s.user_id)

UNION ALL
  -- C-3: every account has exactly one transfer category
  --      (20260708140000:57-78).
  SELECT 'account_missing_transfer_category', 'account', a.id, 'violation',
         'this account has no To/From category'
    FROM accounts a
   WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.account_id = a.id AND c.is_transfer_category = 1)

UNION ALL
  SELECT 'account_multiple_transfer_categories', 'account', a.id, 'violation',
         'this account has more than one To/From category'
    FROM accounts a
   WHERE (SELECT COUNT(*) FROM categories c WHERE c.account_id = a.id AND c.is_transfer_category = 1) > 1

UNION ALL
  -- A-1: the audit chain is dense and links.
  SELECT 'audit_chain_broken', 'audit_entry', l.id, 'violation',
         'this audit row does not chain to its predecessor'
    FROM financial_audit_log l
    LEFT JOIN financial_audit_log p ON p.seq = l.seq - 1
   WHERE (l.seq > (SELECT MIN(seq) FROM financial_audit_log))
     AND (p.id IS NULL OR l.prev_hash IS NOT p.row_hash)

UNION ALL
  -- I-1: an account nested under another must not itself be a parent
  --      (one level only — the (Cash) pairing, 20260722090000).
  SELECT 'account_nesting_too_deep', 'account', a.id, 'violation',
         'a nested account is itself a parent'
    FROM accounts a
   WHERE a.parent_account_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM accounts c WHERE c.parent_account_id = a.id)

-- ── The two INGEST checks (PHASE1-PLAN §2.5) ────────────────────────────────
--
-- Everything above catches a ledger that contradicts itself. Neither of the two
-- commonest ingest disasters does that: a card statement imported with inverted
-- signs, and an <AVAILBAL> stored where a <LEDGERBAL> belongs, both produce data
-- that is internally consistent and entirely wrong. MEASURED before these were
-- written (`scratchpad/local-core/probe-integrity1.mjs`, cases 16 and 17): both
-- shapes were planted and the fifteen checks above reported NOTHING.
--
-- They are HEURISTICS and are labelled as such: a credit card genuinely can be
-- in credit, and a bank figure genuinely can disagree with an unreconciled
-- ledger. They report `severity = 'warning'`, v_integrity_ok ignores warnings,
-- and the app is expected to phrase them as a question rather than a verdict.
--
-- Both are narrowed to `type = 'credit'` deliberately. That is the whole card
-- population — accounts_type_check has no 'card' — and it is the only kind where
-- "positive means you are owed money" is the wrong reading. A loan or a mortgage
-- carries the same sign convention but is never fed by a statement importer
-- making this decision per row, so widening them would buy false positives
-- without buying a catch.

UNION ALL
  -- TS-F1/TS-F2. A card's stored balance is -current; a positive one means
  -- either a genuine credit balance or an importer that got the sign backwards.
  -- The provenance test is what makes it worth reporting: a hand-typed positive
  -- balance is a decision, an imported one is a guess.
  SELECT 'card_account_sign_implausible', 'account', a.id, 'warning',
         'a credit account is in credit and its rows were imported — the statement''s signs may be inverted'
    FROM accounts a
   WHERE a.type = 'credit'
     AND a.balance_minor > 0
     AND EXISTS (SELECT 1 FROM transactions t
                  WHERE t.account_id = a.id
                    AND (t.import_source IS NOT NULL OR t.external_transaction_id IS NOT NULL))

UNION ALL
  -- TS-I1/TS-I2. <AVAILBAL> is remaining credit: positive, and larger than the
  -- balance it was mistaken for. The predicate is PHASE1-PLAN §2.5's, spelled
  -- without sign(): SQLite's sign() needs SQLITE_ENABLE_MATH_FUNCTIONS, and
  -- `bank_balance_minor * balance_minor < 0` would overflow int64 at the bounded
  -- extremes and silently become a float. Two comparisons say the same thing
  -- exactly.
  SELECT 'bank_balance_implausible', 'account', a.id, 'warning',
         'the bank figure disagrees with the ledger by more than the ledger itself — an available balance may have been stored as a bank balance'
    FROM accounts a
   WHERE a.type = 'credit'
     AND a.bank_balance_minor IS NOT NULL
     AND ((a.bank_balance_minor > 0 AND a.balance_minor < 0)
       OR (a.bank_balance_minor < 0 AND a.balance_minor > 0))
     AND abs(a.bank_balance_minor - a.balance_minor) > abs(a.balance_minor);

-- The one-line answer. WARNINGS ARE NOT COUNTED: the two ingest checks are
-- heuristics, and a file that trips one is not thereby corrupt.
CREATE VIEW v_integrity_ok AS
  SELECT (SELECT COUNT(*) FROM v_integrity_violations WHERE severity = 'violation') = 0 AS ok;


-- ============================================================================
-- FILE VERSION
-- ============================================================================
-- The version this files shape is. A file made by this schema is stamped
-- with it; a file made by an earlier schema reads 0 (SQLites default), and
-- `wealth_core::upgrade::upgrade_schema` brings it here ON OPEN, one version
-- at a time, rebuilding what SQLite cannot ALTER. The `schema_meta` row named
-- `schema_version` in section 0 was documented and never written; this pragma
-- is the mechanism, because it needs no table to be right about.
--
--   0  every file before 7 Nov 2026 (desktop 0.1.6 and earlier)
--   1  budgets.repeat_count / repeat_unit and the two CHECKs they come with
--
-- Raise it in the SAME commit as the change it names, with the upgrade step
-- beside it in the crate.
PRAGMA user_version = 1;
