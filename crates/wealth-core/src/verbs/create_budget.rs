//! `create_budget` — a limit somebody set, and the two columns the writer fills
//! in so the table will take it.
//!
//! # What it is a port OF
//!
//! `planningService.createBudget` (`:256-271`), whose whole body is four lines:
//!
//! ```text
//! const row = budgetToDb({ ...budget, spent: 0 }, userId);
//! if (!row.start_date) row.start_date = new Date().toISOString().slice(0, 10);
//! if (!row.name)       row.name       = budget.categoryId || 'Budget';
//! .from('budgets').insert(row).select().single()
//! ```
//!
//! No RPC. `budgets` is one of the tables the cloud writes DIRECTLY over
//! PostgREST — PHASE3-PLAN D-2, argued in full at the head of [`super`] — so
//! what is ported is the WRITE ITSELF: `budgetToDb`'s column list, the two
//! defaults above it, and the `.select().single()` that hands the stored row
//! back.
//!
//! # `spent` IS THE WRITER'S ZERO, NOT THE CALLER'S
//!
//! `{ ...budget, spent: 0 }` is the cloud writer overriding whatever it was
//! handed, and the seam says why in the same words: *"`spent` is not supplied
//! because it is not stored knowledge — it is the sum of the rows filed under
//! that category in the period, recomputed from the ledger"*. The column exists
//! because the cloud has one; it starts at zero on both engines because both
//! writers say so, and this verb has no `spent` argument at all rather than one
//! it would then ignore. An UPDATE may still set it (`budgetToDb` has the line),
//! which is [`super::update_budget`]'s business and is faithful to the cloud.
//!
//! # THE TWO DEFAULTS ARE A `NOT NULL` COLUMN BEING SATISFIED
//!
//! `start_date` and `name` are `NOT NULL` with no default in BOTH engines, and
//! `budgetToDb` can produce a row with neither — so the writer fills them in
//! after the mapper and before the insert. Both are reproduced here, in the verb
//! rather than in `mappers/writes.ts`, for one reason: the harness sends ONE
//! payload to both engines, and a default applied on the TypeScript side would
//! arrive already-applied and could never be compared. The oracle transcribes
//! the same two lines.
//!
//! `start_date`'s value is *today*, and WHICH today is divergence D-8: this
//! engine takes the UTC day, off the file's own clock, inside the write's
//! transaction. `new Date().toISOString().slice(0, 10)` is the UTC day too, so
//! the two agree by construction rather than by luck.
//!
//! `name`'s is `budget.categoryId || 'Budget'`, and it is the SECOND time that
//! expression runs: `budgetToDb` already wrote `b.name ?? b.categoryId ??
//! 'Budget'`. The two differ, and the difference is reachable — `??` passes an
//! empty string through and `||` does not — so a budget created with `name: ''`
//! is stored as its category id in both engines. Reproduced rather than tidied,
//! because the tidy version stores a budget with no name on the budgets page.
//!
//! # THE THRESHOLD IS NOT MONEY AND IS NOT A FLOAT EITHER
//!
//! `alert_threshold` is `numeric(5,2)` in the cloud (80.00 meaning 80%) and
//! `alert_threshold_bp` here — an INTEGER count of hundredths of a percent, 8000
//! meaning the same thing — because `schema.sql` keeps every fractional quantity
//! out of floating point. It therefore crosses the wire in the same spelling
//! money does, a plain decimal string, and is parsed by
//! [`crate::money::hundredths_from_decimal_string`], which is
//! [`crate::money::Money::parse`]'s grammar WITHOUT its type: a percentage that
//! was a [`Money`] would be eligible for every arithmetic this crate reserves
//! for amounts.
//!
//! Out of range is the FILE's refusal (`alert_threshold_bp BETWEEN 0 AND
//! 10000`), which the cloud's `numeric(5,2)` mirrors from the other direction by
//! refusing anything that will not fit in five digits.
//!
//! # IT AUDITS, AND THE CLOUD HAS NOTHING TO AUDIT FROM — DIVERGENCE 10
//!
//! One `budget/create` entry, chained, in the same transaction. The cloud writes
//! none: `write_financial_audit` is called from inside atomic RPCs and there is
//! no atomic RPC here, so in the cloud creating a budget, changing its amount or
//! deleting it leaves no trace at all.
//!
//! **This is a decision that was taken before this verb existed**, and it is
//! worth reading rather than re-deriving. PHASE1-PLAN §2.2 traced U-1 (*"every
//! financial write emits an audit row"*) against `planningService`, found it
//! true of accounts, transactions and splits and FALSE of `budgets.amount`,
//! `budgets.spent`, `goals.target_amount` and `goals.current_amount`, and ruled:
//! *"the local edition fixes it. Budgets and goals are audited."* Its reasons,
//! in its own order:
//!
//! 1. the reason U-1 exists is the compliance answer to *"what changed that
//!    figure"*, and a budget amount and a goal target are figures a user will
//!    ask that about;
//! 2. the cost of fixing it is one call inside a verb that has to exist anyway,
//!    and `financial_audit_log` already accepts an arbitrary `entity` — the
//!    cloud's CHECK is on `action` alone, so no schema changes on either side;
//! 3. the cost of REPLICATING the gap is that the local edition ships a known
//!    compliance hole on purpose, and every future reader has to be told it was
//!    deliberate.
//!
//! The cloud's own newer code agrees, from the other end: `merge_categories`
//! audits a budget whose category it moved, and says why in words this verb
//! inherits — *"budgets have no other audited write path today, and this one is
//! not going to be the first silent change to what a budget measures"*
//! (`20260805214322:291-294`). Slice 22 is the commit where that sentence stops
//! being true, and it stops being true the right way round.
//!
//! It is DECLARED in DESIGN.md §5 as divergence 10 and asserted by name in the
//! differential suite — once per entity, in a spec that exists for it, rather
//! than on every spec in the family. [`super::delete_unused_categories`] argues
//! that restraint: *"a family of divergences is how a real one gets missed"*.
//!
//! # No guard, measured
//!
//! An INSERT into `budgets`. `schema.sql` has no trigger on that table at all,
//! and no foreign key of it points anywhere a trigger watches. The cloud DOES
//! have one — `update_budgets_updated_at`, `BEFORE UPDATE` — which is why every
//! verb in this family writes `updated_at` itself rather than leaving it to a
//! trigger that has no local twin. `tests/planning_writes.rs` asserts the guard
//! table empty across a create rather than reasoning about it.

use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::audit::{self, Action};
use crate::db;
use crate::error::{CoreError, CoreResult, Refusal};
use crate::money::{hundredths_from_decimal_string, Money};
use crate::row::budget::{self, ListedBudget};
use crate::wire::{null_if_empty, Flag};

/// `name` when the caller states none and has no category to name it after.
pub(super) const DEFAULT_NAME: &str = "Budget";

/// `alert_threshold` when the caller states none: 80%, counted in hundredths of
/// a percent.
///
/// Written out here rather than left to the column, because this INSERT NAMES
/// the column and a named column bound to NULL is a `NOT NULL` violation rather
/// than a default. It is the same value on both engines — `DEFAULT 80` on a
/// `numeric(5,2)` there, `DEFAULT 8000` here — and the same arrangement
/// [`super::create_category`] uses for its five flag defaults.
const DEFAULT_ALERT_THRESHOLD_BP: i64 = 8000;

/// One budget as `budgetToDb` sends it, plus the owner.
///
/// Every column that mapper can produce and not one more: it is a WHITELIST of
/// twelve `if (b.k !== undefined)` lines, so a key it has no line for never
/// reaches the cloud's table either. `deny_unknown_fields` is this crate's usual
/// strengthening and here it is also parity — `mappers/writes.ts` filters the
/// same way and says so.
///
/// `spent` is absent, and that absence is the whole of the paragraph in the
/// module docs: the cloud's writer overrides it to zero before the insert, so a
/// verb that accepted one would be accepting a figure it must then discard.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BudgetDraft {
    /// Client-minted, or minted here when absent — B-5. The column is TEXT with
    /// no default in `schema.sql`, for the reason
    /// [`super::create_category`] gives about a column that also holds slugs.
    #[serde(default)]
    pub id: Option<String>,
    /// As shown. `NOT NULL`; see the module docs for what fills it in.
    #[serde(default)]
    pub name: Option<String>,
    /// The limit. `NOT NULL` in both engines with no default, so an absent one
    /// is refused by the TABLE — which is where the cloud refuses it too.
    #[serde(default)]
    pub amount: Option<Money>,
    /// `weekly` | `biweekly` | `monthly` | `quarterly` | `yearly` | `custom` |
    /// `every`, enumerated by CHECK in both engines. `NOT NULL`, no default.
    #[serde(default)]
    pub period: Option<String>,
    /// For `every`: how many of `repeat_unit` one cycle is. Both engines hold
    /// the pair to that period by CHECK (`budgets_repeat_check`), so a pair on
    /// a named rhythm, or a missing one on `every`, is refused by the table.
    #[serde(default)]
    pub repeat_count: Option<i64>,
    /// For `every`: `week` or `month`.
    #[serde(default)]
    pub repeat_unit: Option<String>,
    /// The category id the app files a budget against — TEXT, because the
    /// default category ids were never uuids. `budgetFromDb` reads this column
    /// and never `category_id`, and says so.
    #[serde(default)]
    pub category: Option<String>,
    /// First day covered. `NOT NULL`; today when the caller states none.
    #[serde(default)]
    pub start_date: Option<String>,
    /// Last day covered, when the budget ends.
    #[serde(default)]
    pub end_date: Option<String>,
    /// Does an unspent remainder carry forward? Defaults false, as the column
    /// does on both engines.
    #[serde(default)]
    pub rollover: Option<Flag>,
    /// How much did. Defaults zero.
    #[serde(default)]
    pub rollover_amount: Option<Money>,
    /// Percent, as a two-place decimal string (`"80.00"`). NOT money — see the
    /// module docs. Defaults to the column's 80%.
    #[serde(default)]
    pub alert_threshold: Option<String>,
    /// Hidden budgets stay in the file and out of the reports. Defaults true.
    #[serde(default)]
    pub is_active: Option<Flag>,
    /// Free text.
    #[serde(default)]
    pub notes: Option<String>,
}

/// The command: one budget, and whose.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateBudget {
    /// Owner. `NOT NULL` and a foreign key in both engines.
    pub user_id: String,
    /// The budget, flattened into the command so the payload is the object
    /// `budgetToDb` produces plus the owner — which is what the cloud's insert
    /// row literally is.
    #[serde(flatten)]
    pub budget: BudgetDraft,
}

/// What the verb hands back.
#[derive(Debug, Serialize)]
pub struct CreateBudgetResult {
    /// The budget as stored — [`ListedBudget`], the same projection
    /// `list_budgets` answers with, so a caller can put it straight into state
    /// without re-reading.
    pub answer: ListedBudget,
    /// Dense sequence number of the audit row written for this create.
    pub audit_seq: i64,
    /// Its chained hash.
    pub audit_row_hash: String,
}

/// Store one budget and audit it — one SQLite transaction, or none of it.
///
/// # Errors
/// [`CoreError::Refused`] for `percentage_malformed`, `boolean_invalid`, or a
/// rule the file enforced — `budgets_period_check`,
/// `budgets_period_ordered`, `budgets_money_bounded`, the `alert_threshold_bp`
/// range, the users foreign key, a `NOT NULL` column nobody filled in;
/// [`CoreError::Storage`] for a fault.
// Consumed rather than borrowed, for the reason every write verb here gives: it
// writes an audit row, and `&command` is an invitation to do it twice.
#[allow(clippy::needless_pass_by_value)]
pub fn create_budget(
    connection: &mut Connection,
    command: CreateBudget,
) -> CoreResult<CreateBudgetResult> {
    // Everything that can refuse without touching the file, before the file is
    // touched — the ordering Postgres gets free from its casts.
    let threshold = resolve_threshold(command.budget.alert_threshold.as_deref())?;
    let rollover =
        super::create_account::resolve_flag(command.budget.rollover.as_ref(), false, "rollover")?;
    let is_active =
        super::create_account::resolve_flag(command.budget.is_active.as_ref(), true, "is_active")?;

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = db::now(&transaction)?;

    let id = super::minted_uuid(command.budget.id.as_deref());
    // The writer's two lines, in the writer's order. `start_date` is the UTC day
    // of the file's own clock (D-8); `name` falls back through the mapper's `??`
    // and then the writer's `||`, which is why an empty string reaches the
    // second one.
    let start_date = match null_if_empty(command.budget.start_date.as_deref()) {
        Some(day) => day.to_owned(),
        None => now.get(..10).unwrap_or_default().to_owned(),
    };
    let name = match null_if_empty(command.budget.name.as_deref()) {
        Some(stated) => stated.to_owned(),
        None => null_if_empty(command.budget.category.as_deref())
            .unwrap_or(DEFAULT_NAME)
            .to_owned(),
    };

    transaction.execute(
        "INSERT INTO budgets (
           id, user_id, name, amount_minor, period, repeat_count, repeat_unit,
           category, start_date, end_date,
           spent_minor, rollover, rollover_amount_minor, alert_threshold_bp,
           is_active, notes, created_at, updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?15, ?16, ?6, ?7, ?8,
           0, ?9, ?10, ?11, ?12, ?13, ?14, ?14
         )",
        params![
            id,
            command.user_id,
            name,
            command.budget.amount.map(Money::minor),
            command.budget.period,
            null_if_empty(command.budget.category.as_deref()),
            start_date,
            null_if_empty(command.budget.end_date.as_deref()),
            i64::from(rollover),
            command
                .budget
                .rollover_amount
                .unwrap_or(Money::ZERO)
                .minor(),
            threshold.unwrap_or(DEFAULT_ALERT_THRESHOLD_BP),
            i64::from(is_active),
            command.budget.notes,
            now,
            command.budget.repeat_count,
            null_if_empty(command.budget.repeat_unit.as_deref()),
        ],
    )?;

    // Read back rather than reconstructed, for the reason `create_transaction`
    // states about `to_jsonb(v_tx)`: the audit's `after` and the caller's answer
    // must be what storage holds, defaults and CHECKs and all.
    let stored = read_back(&transaction, &id, &command.user_id)?;
    let entry = audit::write(
        &transaction,
        &command.user_id,
        "budget",
        &id,
        Action::Create,
        None,
        Some(&super::json_of(&budget::read(&transaction, &id)?)?),
        &now,
    )?;

    transaction.commit()?;

    Ok(CreateBudgetResult {
        answer: stored,
        audit_seq: entry.seq,
        audit_row_hash: entry.row_hash,
    })
}

/// The stored budget, or the refusal for a row that vanished between writing it
/// and reading it back — unreachable, and named rather than unwrapped.
pub(super) fn read_back(
    transaction: &rusqlite::Transaction<'_>,
    id: &str,
    user_id: &str,
) -> CoreResult<ListedBudget> {
    budget::read_listed(transaction, id, Some(user_id))?.ok_or_else(|| {
        CoreError::refuse(
            NOT_FOUND,
            "the budget disappeared between writing it and reading it back",
        )
    })
}

/// The code every budget verb refuses a missing row under.
pub(super) const NOT_FOUND: &str = "budget_not_found";

/// The prose a person reads when one does.
///
/// **The first refusal in this crate whose words the cloud does not supply.**
/// Every other one carries a code a Postgres function raises, verbatim, because
/// seam rule 4 makes a refusal's `message` the sentence on the screen and
/// re-wording one would make the local edition's version of a shared rule differ
/// from the cloud's. There is no function here and therefore no sentence to
/// inherit — PostgREST's own answer is `PGRST116: JSON object requested,
/// multiple (or no) rows returned`, which is a fact about a REST convention and
/// not something to show anybody.
///
/// So the words come from the only other implementation of this operation the
/// app has: `DataServiceImpl.updateBudget`'s `throw new Error('Budget not
/// found')`, which is exactly what somebody editing a budget in local or demo
/// mode reads today. The machine code stays snake_case, as the family's do.
pub(super) const NOT_FOUND_MESSAGE: &str = "Budget not found";

/// The hint that rides with it, non-enumerably, for a debugger and never for a
/// branch.
pub(super) const NOT_FOUND_HINT: &str =
    "That budget no longer exists, or is not yours. Reload the budgets and try again.";

/// The refusal itself, so three verbs cannot word it three ways.
pub(super) fn not_found() -> CoreError {
    CoreError::Refused(
        Refusal::named(NOT_FOUND, NOT_FOUND_MESSAGE).with_hint(NOT_FOUND_HINT),
    )
}

/// A percentage as the column counts it, or the refusal.
///
/// `None` leaves the column's own default (8000 = 80%) to answer, which is what
/// an unstated `alert_threshold` does in the cloud too.
///
/// # Errors
/// [`CoreError::Refused`] under `percentage_malformed` — a code of this crate's
/// own, because the quantity is not money and reporting it as
/// `amount_malformed` would send a reader looking for an amount.
pub(super) fn resolve_threshold(stated: Option<&str>) -> CoreResult<Option<i64>> {
    let Some(text) = null_if_empty(stated) else {
        return Ok(None);
    };
    hundredths_from_decimal_string(text)
        .map(Some)
        .map_err(|error| {
            CoreError::Refused(
                Refusal::named("percentage_malformed", &format!("alert_threshold: {error}"))
                    .with_hint(
                        "A budget's alert threshold is a percentage, sent as a plain decimal \
                         string such as \"80.00\". Postgres refuses this too, as a numeric(5,2).",
                    ),
            )
        })
}
