//! A budget, as an audit entry has to record it.
//!
//! # Why a budget row exists in a crate that has no budget verb
//!
//! `merge_categories` moves budgets, and the migration is blunt about why they
//! are audited (`20260805214322:291-294`): *"The surface the delete-and-reassign
//! dialog never moved. Audited like the rest: budgets have no other audited write
//! path today, and this one is not going to be the first silent change to what a
//! budget measures."*
//!
//! That is worth restating, because it is the whole reason this file is not a
//! `SELECT category` and a counter. A budget pointing at a deleted category
//! *"silently reported £0 spent for ever after"* (`:20-22`). The audit entry is
//! what makes the difference between "the budget now measures something else"
//! and "the budget stopped measuring anything and nobody was told".
//!
//! # The whole row, and the one column that is not the cloud's
//!
//! `to_jsonb(v_old_budget)` in the cloud is the whole row, so this is the whole
//! row. One field is a local encoding rather than a translation:
//! `alert_threshold_bp` is `numeric(5,2)` in the cloud (80.00 meaning 80%) and
//! basis-points-of-a-percent locally (8000), because `schema.sql` keeps every
//! fractional quantity out of floating point. It is carried, under its local
//! name, so a reader of the entry can see the value that was stored rather than
//! a rounding of it.
//!
//! `spent_minor` and `rollover_amount_minor` are money and go through [`Money`];
//! `schema.sql` records that both are `numeric(10,2)` in the cloud against
//! `numeric(20,2)` here, which is a widening this crate does not narrow.
//!
//! # And a second projection, for the reader
//!
//! [`ListedBudget`] is the same eighteen columns with ONE difference, and the
//! difference is the threshold:
//!
//! * the AUDIT entry keeps `alert_threshold_bp`, the stored integer, for the
//!   reason two paragraphs up — an entry records what was stored, not a
//!   rendering of it;
//! * the READ hands over `alert_threshold`, `"80.00"`, because that is the
//!   column the cloud has and the field the app reads, and because rendering it
//!   on the far side would put a `/ 100` under `src/services/local/` — the one
//!   shape R-7's grep exists to catch.
//!
//! Two projections of one row, then, differing in one field, and the field is
//! the one nobody would think to check. That is why they are spelled out
//! separately rather than one being derived from the other.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::CoreResult;
use crate::money::{hundredths_to_decimal_string, Money};

/// A budget as stored, in the serialised order.
#[derive(Debug, Clone, Serialize)]
pub struct BudgetRow {
    /// Primary key.
    pub id: String,
    /// Owner.
    pub user_id: String,
    /// As shown.
    pub name: String,
    /// The limit.
    pub amount: Money,
    /// `weekly` | `monthly` | … | `every` — enumerated by CHECK in both engines.
    pub period: String,
    /// For `every`: how many of `repeat_unit` one cycle is. NULL on every other
    /// period, by CHECK in both engines.
    pub repeat_count: Option<i64>,
    /// For `every`: `week` or `month`. NULL on every other period.
    pub repeat_unit: Option<String>,
    /// A category id as text. No foreign key, so a merge that forgot this column
    /// would leave the dangling id the migration was written to stop.
    pub category: Option<String>,
    /// The uuid twin, `ON DELETE SET NULL` — which is how the old delete-and
    /// -reassign dialog quietly *nulled* a budget instead of moving it.
    pub category_id: Option<String>,
    /// First day covered.
    pub start_date: String,
    /// Last day covered, when the budget ends.
    pub end_date: Option<String>,
    /// What has been spent against it.
    pub spent: Money,
    /// Does an unspent remainder carry forward?
    pub rollover: bool,
    /// How much did.
    pub rollover_amount: Money,
    /// Basis points of a percent (8000 = 80.00%). NOT money — see the module
    /// docs.
    pub alert_threshold_bp: i64,
    /// Hidden budgets stay in the file and out of the reports.
    pub is_active: bool,
    /// Free text.
    pub notes: Option<String>,
    /// Opaque labels. Money is banned from it by CHECK.
    pub metadata: serde_json::Value,
    /// When the row was made.
    pub created_at: String,
    /// When it last changed.
    pub updated_at: String,
}

/// A budget as the app lists it: the same row, with the threshold rendered.
#[derive(Debug, Clone, Serialize)]
pub struct ListedBudget {
    /// Primary key.
    pub id: String,
    /// Owner.
    pub user_id: String,
    /// As shown.
    pub name: String,
    /// The limit.
    pub amount: Money,
    /// `weekly` | `monthly` | … | `every` — enumerated by CHECK in both engines.
    pub period: String,
    /// For `every`: how many of `repeat_unit` one cycle is. NULL otherwise.
    pub repeat_count: Option<i64>,
    /// For `every`: `week` or `month`. NULL otherwise.
    pub repeat_unit: Option<String>,
    /// The category id the app actually files a budget against: TEXT, because
    /// the default category ids were never uuids.
    pub category: Option<String>,
    /// The uuid twin, `ON DELETE SET NULL`.
    pub category_id: Option<String>,
    /// First day covered.
    pub start_date: String,
    /// Last day covered, when the budget ends.
    pub end_date: Option<String>,
    /// What has been spent against it.
    pub spent: Money,
    /// Does an unspent remainder carry forward?
    pub rollover: bool,
    /// How much did.
    pub rollover_amount: Money,
    /// Percent, as a two-place decimal string (`"80.00"`). NOT money — see the
    /// module docs, and [`hundredths_to_decimal_string`].
    pub alert_threshold: String,
    /// Hidden budgets stay in the file and out of the reports — but they stay
    /// in this list, or a paused budget could never be un-paused.
    pub is_active: bool,
    /// Free text.
    pub notes: Option<String>,
    /// Opaque labels. Money is banned from it by CHECK.
    pub metadata: serde_json::Value,
    /// When the row was made. The list's sort key.
    pub created_at: String,
    /// When it last changed.
    pub updated_at: String,
}

/// Every budget this login has, oldest first.
///
/// The port of `planningService.getBudgets`: `.select('*')`,
/// `.eq('user_id', …)`, `.order('created_at', { ascending: true })`. Its own
/// comment carries the rule that is easiest to get wrong here — *"Inactive
/// budgets load too: pausing a budget greys it out on the page … it must not
/// make the budget vanish with no way to reactivate it"* — so there is no
/// `is_active` filter, deliberately.
///
/// # Errors
/// [`crate::error::CoreError`] if the read fails.
pub fn list_all(connection: &Connection, user_id: &str) -> CoreResult<Vec<ListedBudget>> {
    // EXPLAIN QUERY PLAN (measured against schema.sql):
    //   SEARCH budgets USING INDEX idx_budgets_user (user_id=?)
    //   USE TEMP B-TREE FOR ORDER BY
    let mut statement = connection.prepare(
        "SELECT id, user_id, name, amount_minor, period, repeat_count, repeat_unit,
                category, category_id, start_date, end_date, spent_minor, rollover,
                rollover_amount_minor, alert_threshold_bp, is_active, notes, metadata,
                created_at, updated_at
           FROM budgets
          WHERE user_id = ?1
          ORDER BY created_at, id",
    )?;
    let rows = statement.query_map(params![user_id], |record| {
        let metadata_text: String = record.get(17)?;
        Ok(ListedBudget {
            id: record.get(0)?,
            user_id: record.get(1)?,
            name: record.get(2)?,
            amount: Money::from_minor(record.get(3)?),
            period: record.get(4)?,
            repeat_count: record.get(5)?,
            repeat_unit: record.get(6)?,
            category: record.get(7)?,
            category_id: record.get(8)?,
            start_date: record.get(9)?,
            end_date: record.get(10)?,
            spent: Money::from_minor(record.get(11)?),
            rollover: record.get::<_, i64>(12)? != 0,
            rollover_amount: Money::from_minor(record.get(13)?),
            alert_threshold: hundredths_to_decimal_string(record.get(14)?),
            is_active: record.get::<_, i64>(15)? != 0,
            notes: record.get(16)?,
            metadata: serde_json::from_str(&metadata_text).unwrap_or(serde_json::Value::Null),
            created_at: record.get(18)?,
            updated_at: record.get(19)?,
        })
    })?;

    let mut budgets = Vec::new();
    for budget in rows {
        budgets.push(budget?);
    }
    Ok(budgets)
}

/// Read one budget as the app lists it, scoped to an owner.
///
/// The `.eq('id', …).eq('user_id', …)` pair every one of `planningService`'s
/// budget writes carries, and `None` is the port of `.single()` finding nothing.
/// An absent owner applies no ownership clause — the decision
/// [`crate::verbs::update_transaction`] documents at length.
///
/// This answers [`ListedBudget`] rather than [`BudgetRow`] because it is what a
/// WRITE hands back, and a write's answer is what the caller puts straight into
/// state: the same projection `list_budgets` returns, threshold rendered and
/// all. The audit entry's `before`/`after` want the other one, which is
/// [`read`].
///
/// # Errors
/// [`crate::error::CoreError`] if the read fails.
pub fn read_listed(
    connection: &Connection,
    id: &str,
    user_id: Option<&str>,
) -> CoreResult<Option<ListedBudget>> {
    Ok(connection
        .query_row(
            "SELECT id, user_id, name, amount_minor, period, repeat_count, repeat_unit,
                    category, category_id, start_date, end_date, spent_minor, rollover,
                    rollover_amount_minor, alert_threshold_bp, is_active, notes, metadata,
                    created_at, updated_at
               FROM budgets
              WHERE id = ?1
                AND (?2 IS NULL OR user_id = ?2)",
            params![id, user_id],
            |record| {
                let metadata_text: String = record.get(17)?;
                Ok(ListedBudget {
                    id: record.get(0)?,
                    user_id: record.get(1)?,
                    name: record.get(2)?,
                    amount: Money::from_minor(record.get(3)?),
                    period: record.get(4)?,
                    repeat_count: record.get(5)?,
                    repeat_unit: record.get(6)?,
                    category: record.get(7)?,
                    category_id: record.get(8)?,
                    start_date: record.get(9)?,
                    end_date: record.get(10)?,
                    spent: Money::from_minor(record.get(11)?),
                    rollover: record.get::<_, i64>(12)? != 0,
                    rollover_amount: Money::from_minor(record.get(13)?),
                    alert_threshold: hundredths_to_decimal_string(record.get(14)?),
                    is_active: record.get::<_, i64>(15)? != 0,
                    notes: record.get(16)?,
                    metadata: serde_json::from_str(&metadata_text)
                        .unwrap_or(serde_json::Value::Null),
                    created_at: record.get(18)?,
                    updated_at: record.get(19)?,
                })
            },
        )
        .optional()?)
}

/// Read one budget as an audit entry records it, scoped to an owner.
///
/// [`read`] with the ownership clause and without the refusal, so a verb can
/// tell "no such budget" from "not yours" in one read and then say neither —
/// both are `budget_not_found`, exactly as `.eq().eq().single()` cannot tell
/// them apart either.
///
/// # Errors
/// [`crate::error::CoreError`] if the read fails.
pub fn read_owned(
    connection: &Connection,
    id: &str,
    user_id: Option<&str>,
) -> CoreResult<Option<BudgetRow>> {
    Ok(connection
        .query_row(
            "SELECT id, user_id, name, amount_minor, period, repeat_count, repeat_unit,
                    category, category_id, start_date, end_date, spent_minor, rollover,
                    rollover_amount_minor, alert_threshold_bp, is_active, notes, metadata,
                    created_at, updated_at
               FROM budgets
              WHERE id = ?1
                AND (?2 IS NULL OR user_id = ?2)",
            params![id, user_id],
            row_of,
        )
        .optional()?)
}

/// Read one budget, whole.
///
/// # Errors
/// [`crate::error::CoreError`] if the row is absent or the read fails.
pub fn read(connection: &Connection, id: &str) -> CoreResult<BudgetRow> {
    Ok(connection.query_row(
        "SELECT id, user_id, name, amount_minor, period, repeat_count, repeat_unit,
                category, category_id, start_date, end_date, spent_minor, rollover,
                rollover_amount_minor, alert_threshold_bp, is_active, notes, metadata,
                created_at, updated_at
           FROM budgets
          WHERE id = ?1",
        params![id],
        row_of,
    )?)
}

/// One record of that twenty-column SELECT as a [`BudgetRow`].
///
/// Written once because two readers use the identical column list, and a second
/// copy is how an added column comes to be read at the wrong index by one of
/// them.
fn row_of(record: &rusqlite::Row<'_>) -> rusqlite::Result<BudgetRow> {
    let metadata_text: String = record.get(17)?;
    Ok(BudgetRow {
        id: record.get(0)?,
        user_id: record.get(1)?,
        name: record.get(2)?,
        amount: Money::from_minor(record.get(3)?),
        period: record.get(4)?,
        repeat_count: record.get(5)?,
        repeat_unit: record.get(6)?,
        category: record.get(7)?,
        category_id: record.get(8)?,
        start_date: record.get(9)?,
        end_date: record.get(10)?,
        spent: Money::from_minor(record.get(11)?),
        rollover: record.get::<_, i64>(12)? != 0,
        rollover_amount: Money::from_minor(record.get(13)?),
        alert_threshold_bp: record.get(14)?,
        is_active: record.get::<_, i64>(15)? != 0,
        notes: record.get(16)?,
        metadata: serde_json::from_str(&metadata_text).unwrap_or(serde_json::Value::Null),
        created_at: record.get(18)?,
        updated_at: record.get(19)?,
    })
}
