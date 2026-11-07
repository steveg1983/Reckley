//! Reckley local edition — the command layer.
//!
//! # The dividing line
//!
//! DESIGN.md §6.3, and it is the whole reason this crate exists:
//!
//! > **If it decides what gets written, it is Rust. If it decides what gets
//! > shown, it is TypeScript.**
//!
//! Forty-six of the eighty-seven money rules in the cloud exist only as control
//! flow inside Postgres functions. They have to live somewhere in a local
//! edition. Putting them in the renderer means putting them in a WebView that an
//! extension, a malformed import or a dependency with a supply-chain problem can
//! reach. So they live here, behind a command surface with no SQL on it.
//!
//! # The schema
//!
//! This crate has **no schema of its own**. It reads
//! `scripts/local-sqlite/schema.sql` — the same vendored file the differential
//! constraint harness applies — through [`SCHEMA_SQL`]. A second copy would
//! drift from the first, and the drift would be invisible until a constraint
//! that fires in the harness did not fire in the app.
//!
//! # The surface, and who reaches it
//!
//! [`command`] holds the verb set, the one dispatch over it and the envelope an
//! answer travels in. It is a library module rather than part of the CLI bin
//! that first held it because two callers need that dispatch and there must not
//! be two of it: the differential harness's bridge, and the desktop shell's
//! single Tauri command (PHASE3-PLAN D-3). The bin keeps what is the command
//! line's own — arguments, stdin, stdout, exit codes.
//!
//! # Phase 1 scope
//!
//! Nine verbs, in the order they were ported and for the reasons they were
//! ported in it:
//!
//! * [`verbs::create_transaction`] — first on purpose. The smallest verb that
//!   touches all four of the things the port is most likely to get wrong:
//!   relative balance arithmetic in SQL, a refusal SQLite will not raise for
//!   you, an audit row in the same transaction, and money crossing a boundary.
//!   If the command-layer design is wrong, this is the verb that says so. Its
//!   port also found a live cloud regression (`is_cleared`, dropped by a rebase
//!   onto a superseded definition) and
//!   `supabase/migrations/20260808150000_create_honours_is_cleared.sql` is the
//!   repair.
//! * [`verbs::update_transaction`] — the hard one, and the one that could not be
//!   guessed. Fifteen settable fields with **four** behaviours between them for
//!   the same `""`, measured rather than assumed (AUDIT3 §1, executed here for
//!   the first time), plus two shapes of balance movement.
//! * [`verbs::delete_transaction`] — the smallest body and the largest trap: the
//!   R-5 leg guard, without which the local file refuses a delete the cloud
//!   performs, including the one the error message tells the user to perform.
//! * [`verbs::set_transaction_splits_with_legs`] — the largest function in the
//!   schema and the one PHASE1-PLAN §6.3 says to sequence early *because* it is:
//!   *"it touches balance, splits, transfers and audit at once, and if the
//!   command-layer design is wrong, it is the verb that will say so"*. Twenty
//!   reachable refusals whose ORDER is part of the contract, the transfer-leg
//!   choreography, two shapes of balance movement and three audited entities.
//!   What it says about the design: the command layer held. The only thing it
//!   needed that the first three did not is a second and third row type, and the
//!   guard it was built for turns out not to be the guard it needs.
//!
//! Then **the transfer family** — the five functions that decide what "these two
//! rows are one movement of money" means. They are ported together because they
//! share their rules by copy-and-paste in the cloud (`20260805145035:252-255`
//! says so in as many words), and porting one without the others would leave
//! four copies of one sentence with only one of them under test:
//!
//! * [`verbs::link_transfer_pair`] — both sides already exist, so join them.
//!   Balance-neutral by construction, and the original of the guard block the
//!   other three copy.
//! * [`verbs::create_transfer_counterpart`] — only one side exists, so make the
//!   other. The one verb in the family that moves money, and the only one with a
//!   currency guard, because it is the only one that copies an amount into
//!   another ledger.
//! * [`verbs::clear_transfer_links`] — the audited unlink. Establishing that
//!   this *is* the unlink path (the client stopped writing the column directly
//!   in the same migration that added the RPC) was half the work of porting it.
//! * [`verbs::repair_claimed_transfer`] — twelve refusals, three rows written
//!   exactly once each, and the only place in the schema that checks mutual
//!   linkage at all.
//! * [`verbs::link_split_line_transfer`] — the split-line counterpart of
//!   `link_transfer_pair`, carrying T-10: amounts compared against the LINE,
//!   never the parent.
//!
//! What the family says about the design: the guard question has to be asked
//! per verb and the answer here is *none*, five times, for five different
//! reasons — see [`verbs`].
//!
//! Then **the category family** — three verbs, and a fourth thing that turned
//! out not to be a verb at all:
//!
//! * [`verbs::merge_categories`] — the largest refusal list in the schema
//!   (seventeen sites, sixteen codes, all reachable — the commissioning brief
//!   said twelve), four reference surfaces moved in one transaction, three new
//!   audited entities, and the second verb in the crate to need a `_rpc_guard`.
//! * [`verbs::apply_category_to_uncategorized`] — payee memory across the
//!   blanks. Porting it required tracing THREE definitions across three
//!   migrations, which is how the port found the live cloud regression its own
//!   documentation records: the newest definition was written from the oldest
//!   and lost a guard the middle one added on purpose.
//! * [`verbs::confirm_transaction_categories`] — the smallest verb in the crate
//!   and the only one whose safety comes from an argument that is not there.
//!
//! **The fourth thing.** The transfer-category lifecycle
//! (`create_transfer_category_for_account`, `sync_transfer_category_for_account`,
//! `protect_transfer_category`, all `20260708140000`) is not ported here, and it
//! is not an omission: all three `RETURN trigger`, all three are attached to
//! triggers on `accounts` and `categories`, and `schema.sql` already carries them
//! as C-3, C-4 and C-5. Nothing in `src/` or `api/` calls any of them. Porting
//! them as verbs would have created a second, callable copy of a rule the file
//! already enforces.
//!
//! And the thinner surface that follows from that: **there is no
//! create/update/delete-category verb, because the cloud has no such RPC.**
//! `PlanningService` writes `categories` directly — `.insert()`, `.update()`,
//! `.delete()` at `planningService.ts:479/567/638` — exactly as the audits found
//! for budgets and goals. So the authority for those three operations is *the
//! table plus its constraints*, which the 54 constraint specs already cover
//! (C-1, C-2, C-11, C-12 and the three lifecycle triggers). Inventing
//! `create_category` here would have been inventing a cloud function to be a port
//! of. Two category RPCs that DO exist are named in [`verbs`] as deliberately not
//! done.
//!
//! Then **the restore family** — four functions and the whole of
//! `20260807083000_user_data_restore.sql`, ported together because none of them
//! means anything alone: the emptiness question exists to gate the restore, the
//! wipe exists to make the answer true, and the finalize exists to close what the
//! restore had to leave open.
//!
//! * [`verbs::user_financial_data_is_empty`] — the only verb in the crate that
//!   opens no transaction and writes nothing. Three tables, not "any data", and
//!   the narrowness is the design.
//! * [`verbs::wipe_user_financial_data`] — "delete everything", and the verb that
//!   found a defect in `schema.sql`: two rules that are each individually right
//!   combined to refuse an account deletion the cloud performs, which made a wipe
//!   impossible on any file holding one linked transfer.
//! * [`verbs::restore_user_chunk`] — the only verb that takes arbitrary JSON, and
//!   therefore the only one with a translation layer ([`backup`]) between the
//!   payload and the tables. Five refusals whose ORDER includes two measured
//!   surprises, sixteen entities' worth of column mapping, and DESIGN.md's
//!   divergence 9 — the money a cloud backup keeps in a JSON blob that this
//!   schema bans by CHECK.
//! * [`verbs::finalize_user_restore`] — the second pass, ported even though R-11
//!   removes the need for one, because the links are a separate payload in the
//!   file and both engines must apply them the same way. The one verb that holds
//!   `_rpc_guard('restore')`, and the one whose audit row could not be written as
//!   the cloud writes it.
//!
//! And **the account snap**, [`verbs::link_bank_account_snap`], which belongs
//! with them for one reason: it is the only function in the schema that assigns
//! an absolute balance, and understanding why that is not a contradiction of B-2
//! is the same piece of reasoning a restore needs about `accounts.balance` being
//! authoritative (X-8).
//!
//! Then the two that close the ledger core:
//!
//! * [`verbs::delete_unused_categories`] — the category family's fourth and last
//!   verb, and the only one in the crate whose every protection is a `WHERE`
//!   clause rather than a refusal. Porting it found the measured hole in the
//!   promise its own migration makes (a referenced child dies with its named
//!   parent, on BOTH engines), the one shape in which the FILE refuses on the
//!   function's behalf, and the one place where the cloud's single statement
//!   cannot be a single statement here without changing the number it answers
//!   with.
//! * [`verbs::verify_integrity`] — **the only verb in this crate that is not a
//!   port of anything.** The cloud has no such function, no such view and no
//!   equivalent; the local edition needs one because it has no second
//!   implementation to be checked against. Seventeen checks, fifteen rules and
//!   two suspicions, each one proved to fire by a spec that plants its violation.
//!   Its specs are the first in the verb harness to run on one engine, because
//!   there is no other engine to run them on.
//!
//! And then **the ingest pair** — the two RPCs through which every transaction
//! that was not typed by a person arrives. They are ported together because they
//! are the same operation told by two different informants, and almost
//! everything interesting about either is a place where they DISAGREE:
//!
//! * [`verbs::import_transactions`] — the file importer (OFX, QIF, CSV), and the
//!   only verb in the crate whose headline is a thing that must NOT happen
//!   twice. Its live definition is four migrations deep and the newest is the one
//!   that matters: a chunk carrying import keys can be re-posted after a lost
//!   response without moving the balance a second time. Five refusals whose ORDER
//!   is measured, including one genuine surprise — a malformed request is named
//!   before the caller is told the account is not theirs.
//! * [`verbs::import_bank_transactions`] — the bank feed, which a local file will
//!   probably never have. It is ported anyway because a restored cloud backup
//!   carries feed-written rows, and because **B-4's first-import rebase lives
//!   here and nowhere else**: the one place in the schema where an import moves
//!   `initial_balance` instead of `balance`. Its precondition (TS-F7) is not
//!   satisfied by the cloud that calls it, and the verb's documentation says so
//!   rather than quietly correcting it.
//!
//! What the pair says about the design: the two things a port is most likely to
//! get wrong here are both about ORDER rather than about arithmetic — the order
//! the refusals fire in, and the order the rows are read in — and neither can be
//! reasoned out from the SQL. Both were measured. The third is a tie-break that
//! **does not exist**: `payee_memory_category` orders on three keys and the cloud's
//! answer below the third is an artefact of its query plan, so the port states a
//! fourth of its own and says out loud that it is not a port of anything.
//!
//! And then [`admission`] — the surface the ingest verbs sit behind, and the
//! first thing in this crate that is **not** a port of a Postgres function.
//! The twenty-one verbs above all had an oracle: a live RPC to be compared
//! against, row for row. These rules have none. They are the decisions
//! TypeScript makes about what a parsed row MEANS before any of those verbs
//! sees it — which of two rows is the same payment, which figure on a statement
//! is the balance, whether a card number may be stored, whether a heuristic
//! match may redefine what an account reconciles against — and PHASE1-PLAN §5
//! counts 48 invariants of that class, 35 % of the inventory, with no SQL side
//! at all.
//!
//! Their oracle is the TypeScript itself, and it is executed rather than
//! transcribed: `scripts/local-sqlite/admission.mjs` drives the real module and
//! this crate from one payload and compares the two answers. See [`admission`]
//! for the dividing line, for the one divergence the money type forces at three
//! sites, and for what is deliberately still outstanding.
//!
//! What is deliberately NOT here is as much of the design as what is: no
//! absolute balance setter, no verb that accepts SQL, and no general-purpose
//! writer for the columns that have dedicated verbs. See [`verbs`].
//!
//! One thing the restore family deliberately does not port, named here so nobody
//! has to re-derive it: **`backupService.remapBackupIds`**. Ids are remapped on
//! the CLIENT, before a single row is sent, and the RPCs insert what they are
//! handed verbatim. [`backup`] says so at its head, and a Rust copy of that
//! function would be a second implementation of a rule the TypeScript owns.

#![deny(missing_docs)]
#![warn(clippy::pedantic)]
// The documentation in this crate is prose that names SQL keywords, engines and
// migrations in ordinary sentences. `doc_markdown` wants `SQLite`, `PRAGMA` and
// `Postgres` in backticks, which turns readable paragraphs into a rash of code
// spans and makes the invariant explanations — the reason these comments exist —
// harder to read. Backticks are used here for things you could type.
#![allow(clippy::doc_markdown)]

pub mod admission;
pub mod audit;
pub mod backup;
pub mod command;
pub mod db;
pub mod error;
pub mod money;
pub mod row;
pub mod scaled;
pub mod upgrade;
pub mod verbs;
pub mod wire;

/// The local edition schema, as vendored for the differential harness.
///
/// The path reaches out of the crate on purpose (see the module docs). If the
/// file moves, this crate stops compiling, which is the correct failure: a
/// silent fallback to a stale copy is the thing being prevented.
pub const SCHEMA_SQL: &str = include_str!("../../../scripts/local-sqlite/schema.sql");

/// Apply the schema to a connection that has already been through
/// [`db::configure`].
///
/// # Errors
/// [`error::CoreError`] if the schema does not apply.
pub fn apply_schema(connection: &rusqlite::Connection) -> error::CoreResult<()> {
    connection.execute_batch(SCHEMA_SQL)?;
    Ok(())
}
