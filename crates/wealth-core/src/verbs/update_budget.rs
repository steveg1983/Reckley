//! `update_budget` — the port of a PostgREST `UPDATE`, of the `.single()` on the
//! end of it, and of one line in the mapper that renames a budget nobody asked
//! to rename.
//!
//! # What it is a port OF
//!
//! `planningService.updateBudget` (`:273-287`):
//!
//! ```text
//! .from('budgets').update(budgetToDb(updates))
//!   .eq('id', id).eq('user_id', userId).select().single()
//! ```
//!
//! No RPC, for the reason [`super::create_budget`] gives: `budgets` is one of the
//! tables the cloud writes directly. PHASE3-PLAN D-2.
//!
//! # ONE presence rule, and it is `budgetToDb`'s
//!
//! Twelve `if (b.k !== undefined)` lines. `undefined` means *leave this alone*
//! and is dropped; anything else — `null` included — is sent. So every field
//! below is the `p ? 'k'` class [`super::update_account`] describes: **the key
//! being present is the whole test, and a JSON null stores NULL.** Where the
//! column is `NOT NULL` (`amount`, `period`, `start_date`, `rollover`,
//! `alert_threshold`, `is_active`, and `name` — see below) a stated null is
//! refused by the file, on both engines.
//!
//! # THE ONE LINE THAT IS NOT AN ASSIGNMENT: A CATEGORY CHANGE RENAMES THE BUDGET
//!
//! ```text
//! if (b.name !== undefined || b.categoryId !== undefined) {
//!   row.name = b.name ?? b.categoryId ?? 'Budget';
//! }
//! ```
//!
//! Two keys decide ONE column, and the surprising half is the second: an update
//! that moves a budget to a different category, and says nothing about its name,
//! **rewrites the name to the category id**. That is not a rule anybody would
//! choose — it is what falls out of a mapper that fills in a `NOT NULL` column —
//! and it is reproduced here rather than tidied, because the tidy version leaves
//! the two engines disagreeing about what a budget is called after an ordinary
//! edit, which is the exact class of difference this port exists to prevent.
//!
//! Note `??` and not `||`: a stated empty name is an empty name, and only
//! `undefined`/`null` fall through to the category. A stated null CATEGORY falls
//! through again, to the literal `'Budget'`.
//!
//! It lives in the verb rather than in `mappers/writes.ts` for the reason
//! [`super::create_budget`]'s two defaults do: the harness sends ONE payload to
//! both engines, so a derivation applied on the TypeScript side arrives
//! already-applied and can never be compared. The oracle transcribes the same
//! three-way choice.
//!
//! # `spent` IS SETTABLE HERE AND NOT ON A CREATE, AND THAT IS THE CLOUD
//!
//! `budgetToDb` has a `spent` line and `createBudget` overrides it to zero;
//! neither is this verb's decision. The seam's *"`spent` is summed from the
//! ledger, never stored knowledge"* is a statement about where the FIGURE comes
//! from, and the column is written by whatever recomputes it. A verb that
//! refused the key would refuse a write the cloud performs.
//!
//! # A BUDGET THAT IS NOT THERE IS REFUSED, AND ONE THAT IS GONE IS NOT
//!
//! `.single()` is the whole difference between this verb and
//! [`super::delete_budget`], which accepts an id naming nothing. PostgREST raises
//! `PGRST116` when an update matches no row and `.single()` is on the query; the
//! delete has no `.single()` and no rows matched is a successful call with
//! nothing done.
//!
//! The seam states the same rule from the app's end: *"A budget that is not there
//! is refused BY NAME rather than created, and the refusal leaves the store
//! exactly as it was."* The refusal is `budget_not_found`, and
//! [`super::create_budget`] carries the argument about where its WORDS come from
//! — this is the first family in the crate whose refusal the cloud has no
//! sentence for.
//!
//! # It audits
//!
//! One `budget/update` entry, `before` and `after`, in the same transaction. See
//! [`super::create_budget`] for the family's argument and for PHASE1-PLAN §2.2,
//! which decided it before any of these verbs existed.
//!
//! # No guard, measured
//!
//! An UPDATE of `budgets`. `schema.sql` has no trigger on that table; the cloud
//! has one (`update_budgets_updated_at`), which is why this verb writes
//! `updated_at` itself rather than leaving it to a trigger that does not exist
//! here. `tests/planning_writes.rs` asserts the guard table empty across an edit.

use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::audit::{self, Action};
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::money::Money;
use crate::row::budget::{self, ListedBudget};
use crate::wire::{Field, Flag};

use super::create_account::resolve_flag_field;
use super::create_budget::{not_found, resolve_threshold, NOT_FOUND};

/// The command.
///
/// `(p_id, p, p_user_id)` in the shape every verb here uses, so the differential
/// harness can send ONE payload to both engines.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateBudget {
    /// Which budget.
    pub id: String,
    /// Whose. Absent means "name no owner", which in the cloud falls back to RLS
    /// and here means the ownership clause is not applied — the decision
    /// [`super::update_transaction`] documents at length.
    #[serde(default)]
    pub user_id: Option<String>,
    /// The fields to change.
    #[serde(default)]
    pub patch: BudgetPatch,
}

/// The settable columns, each in the three states `jsonb` can present.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BudgetPatch {
    /// As shown. Shares a line with `category` — see the module docs.
    #[serde(default)]
    pub name: Field<String>,
    /// The limit.
    #[serde(default)]
    pub amount: Field<Money>,
    /// `weekly` | `biweekly` | `monthly` | `quarterly` | `yearly` | `custom` | `every`.
    #[serde(default)]
    pub period: Field<String>,
    /// For `every`: how many of `repeat_unit` one cycle is. A stated null
    /// clears it — what the editor sends when the period moves to a named
    /// rhythm — and the table's CHECK holds the pair to `every`.
    #[serde(default)]
    pub repeat_count: Field<i64>,
    /// For `every`: `week` or `month`.
    #[serde(default)]
    pub repeat_unit: Field<String>,
    /// The category id, as TEXT. Renames the budget when `name` is not stated.
    #[serde(default)]
    pub category: Field<String>,
    /// First day covered.
    #[serde(default)]
    pub start_date: Field<String>,
    /// Last day covered.
    #[serde(default)]
    pub end_date: Field<String>,
    /// What has been spent against it — settable here, for the reason the module
    /// docs give.
    #[serde(default)]
    pub spent: Field<Money>,
    /// Does an unspent remainder carry forward?
    #[serde(default)]
    pub rollover: Field<Flag>,
    /// How much did.
    #[serde(default)]
    pub rollover_amount: Field<Money>,
    /// Percent, as a two-place decimal string. NOT money.
    #[serde(default)]
    pub alert_threshold: Field<String>,
    /// Hidden budgets stay in the file and out of the reports.
    #[serde(default)]
    pub is_active: Field<Flag>,
    /// Free text.
    #[serde(default)]
    pub notes: Field<String>,
}

/// What the verb hands back: the row as it now stands, and the audit entry.
#[derive(Debug, Serialize)]
pub struct UpdateBudgetResult {
    /// The budget as stored after the edit — the whole row, so the caller can
    /// replace its copy with the answer.
    pub answer: ListedBudget,
    /// Dense sequence number of the audit row written for this update.
    pub audit_seq: i64,
    /// Its chained hash.
    pub audit_row_hash: String,
}

/// Edit one budget and audit it — one SQLite transaction, or none of it.
///
/// # Errors
/// [`CoreError::Refused`] for `budget_not_found`, `percentage_malformed`,
/// `boolean_invalid`, or a rule the file enforced; [`CoreError::Storage`] for a
/// fault.
#[allow(clippy::needless_pass_by_value)]
pub fn update_budget(
    connection: &mut Connection,
    command: UpdateBudget,
) -> CoreResult<UpdateBudgetResult> {
    let patch = &command.patch;

    // Everything that can refuse without touching the file, before the file is
    // touched — the ordering Postgres gets free from its casts.
    let rollover = resolve_flag_field(&patch.rollover, "rollover")?;
    let is_active = resolve_flag_field(&patch.is_active, "is_active")?;
    let threshold = match patch.alert_threshold.value() {
        None => None,
        Some(text) => resolve_threshold(Some(text))?,
    };

    // BEGIN IMMEDIATE: the write lock up front, so the read-then-update below is
    // the cloud's `SELECT … FOR UPDATE` without the lock it has nothing to add.
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = db::now(&transaction)?;

    let owner = command.user_id.as_deref();
    let Some(before) = budget::read_owned(&transaction, &command.id, owner)? else {
        return Err(not_found());
    };

    let changed = apply(&transaction, &command, rollover, is_active, threshold, &now)?;
    // `id` is the primary key and the row was just proven to exist, so more than
    // one is unreachable and zero would mean the WHERE clause had drifted from
    // the one that found it. SQLite reports zero changed rows and raises nothing
    // at all, which is the silence this crate refuses to leave.
    if changed != 1 {
        return Err(CoreError::refuse(
            NOT_FOUND,
            "the budget disappeared between finding it and editing it",
        ));
    }

    let answer = super::create_budget::read_back(&transaction, &command.id, &before.user_id)?;
    let after = budget::read(&transaction, &command.id)?;

    let entry = audit::write(
        &transaction,
        &before.user_id,
        "budget",
        &command.id,
        Action::Update,
        Some(&super::json_of(&before)?),
        Some(&super::json_of(&after)?),
        &now,
    )?;

    transaction.commit()?;

    Ok(UpdateBudgetResult {
        answer,
        audit_seq: entry.seq,
        audit_row_hash: entry.row_hash,
    })
}

/// The single UPDATE, column for column against `budgetToDb`'s output.
///
/// One statement rather than a SET list assembled in Rust, for
/// [`super::update_transaction`]'s two reasons: a statement built by
/// concatenation is a SQL surface and this crate has none (DESIGN.md §6.4), and
/// `ELSE <column>` is what makes "leave it alone" mean *the stored value* rather
/// than *what this process read a moment ago*.
///
/// `name` is the one parameter computed in Rust, because its value depends on
/// which of two keys were present — see the module docs.
fn apply(
    transaction: &rusqlite::Transaction<'_>,
    command: &UpdateBudget,
    rollover: Option<bool>,
    is_active: Option<bool>,
    threshold: Option<i64>,
    now: &str,
) -> CoreResult<usize> {
    let patch = &command.patch;
    // `row.name = b.name ?? b.categoryId ?? 'Budget'`, guarded by "either key
    // was present". `Field::value()` is None for both absence and a stated
    // null, which is exactly what `??` falls through on.
    let names_it = patch.name.is_present() || patch.category.is_present();
    let name = names_it.then(|| {
        patch
            .name
            .value()
            .or_else(|| patch.category.value())
            .map_or_else(
                || super::create_budget::DEFAULT_NAME.to_owned(),
                ToOwned::to_owned,
            )
    });

    Ok(transaction.execute(
        "UPDATE budgets SET
           name                  = CASE WHEN ?1  THEN ?2  ELSE name END,
           amount_minor          = CASE WHEN ?3  THEN ?4  ELSE amount_minor END,
           period                = CASE WHEN ?5  THEN ?6  ELSE period END,
           repeat_count          = CASE WHEN ?27 THEN ?28 ELSE repeat_count END,
           repeat_unit           = CASE WHEN ?29 THEN ?30 ELSE repeat_unit END,
           category              = CASE WHEN ?7  THEN ?8  ELSE category END,
           start_date            = CASE WHEN ?9  THEN ?10 ELSE start_date END,
           end_date              = CASE WHEN ?11 THEN ?12 ELSE end_date END,
           spent_minor           = CASE WHEN ?13 THEN ?14 ELSE spent_minor END,
           rollover              = CASE WHEN ?15 THEN ?16 ELSE rollover END,
           rollover_amount_minor = CASE WHEN ?17 THEN ?18 ELSE rollover_amount_minor END,
           alert_threshold_bp    = CASE WHEN ?19 THEN ?20 ELSE alert_threshold_bp END,
           is_active             = CASE WHEN ?21 THEN ?22 ELSE is_active END,
           notes                 = CASE WHEN ?23 THEN ?24 ELSE notes END,
           updated_at            = ?25
         WHERE id = ?26",
        params![
            names_it,
            name,
            patch.amount.is_present(),
            patch.amount.value().map(|money| money.minor()),
            patch.period.is_present(),
            patch.period.value(),
            patch.category.is_present(),
            patch.category.value(),
            patch.start_date.is_present(),
            patch.start_date.value(),
            patch.end_date.is_present(),
            patch.end_date.value(),
            patch.spent.is_present(),
            patch.spent.value().map(|money| money.minor()),
            patch.rollover.is_present(),
            rollover.map(i64::from),
            patch.rollover_amount.is_present(),
            patch.rollover_amount.value().map(|money| money.minor()),
            patch.alert_threshold.is_present(),
            threshold,
            patch.is_active.is_present(),
            is_active.map(i64::from),
            patch.notes.is_present(),
            patch.notes.value(),
            now,
            command.id,
            patch.repeat_count.is_present(),
            patch.repeat_count.value(),
            patch.repeat_unit.is_present(),
            patch.repeat_unit.value(),
        ],
    )?)
}
