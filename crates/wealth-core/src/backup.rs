//! The backup format, and how one of its rows becomes a row in this file.
//!
//! # What this module is a port of, and what it deliberately is not
//!
//! It is the translation half of `restore_user_chunk`
//! (`supabase/migrations/20260807083000_user_data_restore.sql:230-374`) — the
//! part that takes *whole rows* out of a backup and puts them in a table.
//!
//! It is **not** a port of `backupService.remapBackupIds`. That runs on the
//! CLIENT, before a single row is sent, and the RPCs insert what they are handed
//! verbatim (`:279-294` re-owns and strips columns; it never touches an `id`).
//! The boundary matters enough to state twice: **ids arrive already remapped, or
//! they do not arrive remapped at all.** Nothing here invents an id, rewrites a
//! reference or resolves a dangling one, because the function it ports does none
//! of those things — and a Rust copy of the remapper would be a second
//! implementation of a rule the TypeScript already owns, drifting from it the
//! first time a column is added.
//!
//! # The column list is not written twice
//!
//! The cloud hands each row to `jsonb_populate_recordset` against the table's own
//! rowtype rather than naming columns, and the migration explains why at length:
//! *"Naming them was the first draft and it was wrong within the hour"*. SQLite
//! has no such facility, so the names are written down here — once, in one table
//! per entity, with the cloud's key on the left and this schema's column on the
//! right. That table IS the map between the two schemas, and it is the only
//! place either name appears.
//!
//! Every column name in an INSERT built here comes from a `&'static str` in that
//! table. No caller value is ever concatenated into SQL; values travel as bound
//! parameters. DESIGN.md §6.4's *"you cannot bypass what does not exist"* holds
//! through the one verb that takes arbitrary JSON.
//!
//! # Four things the cloud does that this must do differently
//!
//! 1. **Scale.** `numeric(20,2)` becomes `INTEGER` minor units, quantities and
//!    prices become `_e8`, `alert_threshold` becomes basis points. Each is a
//!    [`Kind`] and each is exact: a decimal string is scaled by integer
//!    arithmetic and a value with more places than the column can hold is
//!    REFUSED, never rounded ([`crate::money`] makes the same choice for the same
//!    reason).
//! 2. **Arrays.** `transactions.tags` and `suggestion_dismissals.subject_ids` are
//!    `text[]` and `uuid[]` in the cloud and child tables here. They are written
//!    after their parent row, in the same transaction.
//! 3. **Money in `metadata`.** DESIGN.md §5 divergence 9, *"the one most likely
//!    to bite: it is a hard failure on real data"*. `transactions_no_money_in_metadata`
//!    refuses eleven keys that a cloud backup legitimately carries. Four have a
//!    typed home and are PROMOTED into it; the other eight are dropped and every
//!    drop is REPORTED. See [`strip_metadata_money`].
//! 4. **Absent keys, and the null that is not one.** The cloud USED to refuse a
//!    row missing any NOT NULL key, because `jsonb_populate_recordset` supplies
//!    an explicit SQL NULL rather than the column's default — MEASURED: a row
//!    with no `low_balance_alert_enabled` was refused even though the column has
//!    a default. That was a live data-safety defect (every file exported before
//!    2026-08-10 failed to restore) and `20260811090000` fixed it by reading the
//!    schema's own constant defaults and laying them under each row. Here an
//!    absent key simply omits the column, so the engine applies the default and
//!    the fix needs no mechanism. What the same migration ALSO settled is the
//!    rule this file now keeps in both directions: **omitted is not the same as
//!    null**. A key stated as null on a NULLABLE column is a deliberate null and
//!    is stored as one; on a NOT NULL column it is treated as absent, because no
//!    legal export could have produced it. See [`insert_row`], which reads the
//!    nullability from the schema rather than from a list.
//!
//! 5. **Getting a row back OUT.** [`read_rows`] is the collect side, and it goes
//!    through the SAME column tables in reverse. One map, two directions: a file
//!    written here is a file the cloud's restore reads, and a file written there
//!    is one this restore reads, because neither side has a column list of its
//!    own to drift with.
//!
//! # Unknown keys are ignored, because they are ignored in the cloud
//!
//! MEASURED: `jsonb_populate_recordset` silently discards a key that is not a
//! column. A row carrying `a_column_that_does_not_exist` inserts fine. So does
//! one here. That is not a preference — a stricter local reading would refuse
//! files the cloud accepts, including every backup taken before a column was
//! dropped.
//!
//! All examples in this file are invented.

use std::collections::BTreeSet;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, ToSql};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{CoreError, CoreResult};

/// One row out of a backup file: the whole JSON object, keys as the cloud
/// spells them.
pub type BackupRow = Map<String, Value>;

/// Something the file carried that this ledger has nowhere to keep.
///
/// Reported rather than lost in silence. The cloud produces none of these — it
/// has the column, or it has no constraint — so a spec that provokes one
/// declares the divergence.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Dropped {
    /// Which table the row was going into.
    pub entity: String,
    /// The row's own id, as the file spells it.
    pub id: String,
    /// What was dropped, and why it had nowhere to go.
    pub what: String,
}

// ── Scales ──────────────────────────────────────────────────────────────────

/// How a JSON value becomes a column value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// TEXT, verbatim. Ids, names, enumerations, currency codes.
    Text,
    /// `boolean` → `INTEGER` 0/1. Accepts what Postgres's boolean cast accepts,
    /// through [`crate::wire::Flag`], so `"true"` works as well as `true`.
    Flag,
    /// `integer` → `INTEGER`. `statement_sequence`, `sort_order`, `role_order`.
    Ordinal,
    /// A decimal scaled by a power of ten: money (2), quantity and price (8),
    /// `alert_threshold` as basis points (2). More places than the scale can
    /// hold is a refusal, never a rounding.
    Scaled(u32),
    /// A calendar day, `YYYY-MM-DD`.
    Date,
    /// An instant, normalised to the shape this schema's column defaults use.
    Timestamp,
    /// A JSON document, stored as TEXT.
    Json,
}

/// One column of one entity: the key the file uses, the column this file has,
/// and how to get from one to the other.
#[derive(Debug, Clone, Copy)]
pub struct Column {
    /// The key in the backup row — the cloud's column name.
    pub key: &'static str,
    /// The column in `schema.sql`.
    pub column: &'static str,
    /// The conversion.
    pub kind: Kind,
}

const fn text(key: &'static str) -> Column {
    Column { key, column: key, kind: Kind::Text }
}
const fn flag(key: &'static str) -> Column {
    Column { key, column: key, kind: Kind::Flag }
}
const fn ordinal(key: &'static str) -> Column {
    Column { key, column: key, kind: Kind::Ordinal }
}
const fn date(key: &'static str) -> Column {
    Column { key, column: key, kind: Kind::Date }
}
const fn stamp(key: &'static str) -> Column {
    Column { key, column: key, kind: Kind::Timestamp }
}
const fn json(key: &'static str) -> Column {
    Column { key, column: key, kind: Kind::Json }
}
/// `numeric(20,2)` → `_minor`.
const fn money(key: &'static str, column: &'static str) -> Column {
    Column { key, column, kind: Kind::Scaled(2) }
}
/// `numeric(20,8)` → `_e8`.
const fn eight(key: &'static str, column: &'static str) -> Column {
    Column { key, column, kind: Kind::Scaled(8) }
}

// ── The column maps ─────────────────────────────────────────────────────────
//
// One `const` per entity, and each is the map between two schemas: the cloud's
// key on the left of every entry, this file's column on the right. They are
// items rather than array literals inside the match because a `const fn` cannot
// hand out a reference to a temporary — and `columns()` stays `const` so the
// match is exhaustive at compile time, which is canonical invariant #125: a new
// backup entity without a recorded storage decision does not build.

        // `plaid_account_id` and `plaid_connection_id` are absent on
        // purpose: the RPC strips both (`:282`) because they are GLOBALLY
        // unique and restoring them collides with whoever exported the file.
        // This schema has no such columns at all, so the strip is structural.
        // `parent_account_id` is absent for the other reason — it is
        // deferred to `finalize_user_restore`, which is where the cycle
        // closes.
const ACCOUNTS: &[Column] = &[
            text("id"),
            text("name"),
            text("type"),
            text("currency"),
            money("balance", "balance_minor"),
            money("initial_balance", "initial_balance_minor"),
            money("bank_balance", "bank_balance_minor"),
            date("bank_balance_date"),
            date("last_reconciled_date"),
            // Added by 20260810200000, the same migration that split C from R.
            // Absent until slice 25, which is when anything could have NOTICED:
            // a column with no collector and no restorer is a column whose
            // absence from this table nothing can see. The round trip is what
            // sees it.
            money("last_reconciled_balance", "last_reconciled_balance_minor"),
            flag("low_balance_alert_enabled"),
            money("low_balance_threshold", "low_balance_threshold_minor"),
            date("opening_balance_date"),
            date("archive_through_date"),
            text("institution"),
            text("account_number"),
            text("sort_code"),
            text("icon"),
            text("color"),
            text("notes"),
            flag("is_active"),
            json("metadata"),
            stamp("created_at"),
            stamp("updated_at"),
];

const CATEGORIES: &[Column] = &[
            text("id"),
            text("name"),
            text("type"),
            text("level"),
            text("parent_id"),
            text("account_id"),
            text("color"),
            text("icon"),
            flag("is_system"),
            flag("is_transfer_category"),
            flag("is_revaluation_category"),
            flag("is_unassigned_bucket"),
            flag("is_active"),
            stamp("created_at"),
            stamp("updated_at"),
];

        // `linked_transfer_id` and `linked_transfer_split_id` are absent:
        // the RPC nulls both (`:288-289`) and finalize patches them.
        // `connection_id`, `external_transaction_id` and `external_provider`
        // are absent because the RPC strips them (`:285-286`) — this schema
        // HAS those columns, kept so a cloud backup restores losslessly, and
        // the strip is a decision rather than an accident of shape.
        //
        // `plaid_transaction_id` is stripped by the RPC and has no column
        // here. `transactions.plaid_account_id` is the one the RPC does NOT
        // strip — it survives a cloud restore and is dropped here for want of
        // a column. Recorded because it is the only asymmetry in this list
        // that is not deliberate on both sides.
        //
        // `fee_minor`, `original_amount_minor`, `original_currency` and
        // `fx_rate_e10` are not here either: they have no key in the backup
        // because the cloud keeps those figures in `metadata`. They are
        // filled by [`strip_metadata_money`].
const TRANSACTIONS: &[Column] = &[
            text("id"),
            text("account_id"),
            text("description"),
            money("amount", "amount_minor"),
            text("type"),
            date("date"),
            text("category"),
            text("category_id"),
            text("notes"),
            text("merchant_name"),
            text("location_city"),
            text("location_country"),
            text("payment_channel"),
            flag("is_recurring"),
            flag("is_cleared"),
            // Money's R, and THE column the three-branch null rule in
            // [`insert_row`] exists for: it is the only nullable column in this
            // schema with a default, so it is the only one where "the file said
            // null" and "the file said nothing" produce different rows. NULL
            // means *"this row predates the split between marking and
            // committing; ask is_cleared"*, and a restored cloud history is
            // made of exactly those rows.
            flag("is_reconciled"),
            flag("is_split"),
            flag("archived"),
            ordinal("statement_sequence"),
            flag("category_confirmed"),
            // Added by 20260810090000 — and the column whose absence from the
            // CLOUD's restore was a live data-safety defect (20260811090000:
            // every file exported before 2026-08-10 failed to restore). It has
            // always been storable here; it was never collected or restored,
            // which is the quieter half of the same mistake.
            flag("needs_review"),
            text("transfer_account_id"),
            text("import_source"),
            text("import_source_id"),
            json("metadata"),
            stamp("created_at"),
            stamp("updated_at"),
];

        // `linked_transfer_id` IS carried here, and that is the RPC's
        // behaviour rather than an oversight: its re-owning CASE has no
        // branch for `transaction_splits`, so the column travels. It
        // resolves because splits are sent after transactions.
const TRANSACTION_SPLITS: &[Column] = &[
            text("id"),
            text("transaction_id"),
            text("category"),
            money("amount", "amount_minor"),
            text("memo"),
            ordinal("sort_order"),
            text("transfer_account_id"),
            text("linked_transfer_id"),
            stamp("created_at"),
            stamp("updated_at"),
];

        // `alert_threshold` is numeric(5,2) meaning a percentage; this
        // schema stores basis points of a percent, so 80.00% is 8000 —
        // scale 2, the same integer arithmetic as money and not money.
const BUDGETS: &[Column] = &[
            text("id"),
            text("name"),
            money("amount", "amount_minor"),
            text("period"),
            // The `every` period's interval: a whole number and a unit.
            ordinal("repeat_count"),
            text("repeat_unit"),
            text("category"),
            text("category_id"),
            date("start_date"),
            date("end_date"),
            money("spent", "spent_minor"),
            flag("rollover"),
            money("rollover_amount", "rollover_amount_minor"),
            Column { key: "alert_threshold", column: "alert_threshold_bp", kind: Kind::Scaled(2) },
            flag("is_active"),
            text("notes"),
            json("metadata"),
            stamp("created_at"),
            stamp("updated_at"),
];

const GOALS: &[Column] = &[
            text("id"),
            text("name"),
            text("description"),
            money("target_amount", "target_amount_minor"),
            money("current_amount", "current_amount_minor"),
            date("target_date"),
            text("category"),
            text("priority"),
            text("status"),
            text("account_id"),
            text("contribution_frequency"),
            flag("auto_contribute"),
            text("icon"),
            text("color"),
            stamp("completed_at"),
            json("metadata"),
            stamp("created_at"),
            stamp("updated_at"),
];

const GOAL_CONTRIBUTIONS: &[Column] = &[
            text("id"),
            text("goal_id"),
            money("amount", "amount_minor"),
            text("transaction_id"),
            date("date"),
            text("notes"),
            stamp("created_at"),
];

        // THE PRICE FIX (DESIGN.md §3.2): the cloud stores unit prices at
        // numeric(10,2) against quantities at numeric(20,8), so a fund
        // priced at £12.345 cannot be written there. This schema stores them
        // at 8 dp. A cloud→local restore is therefore EXACT and a local→cloud
        // export would round — declared divergence 4.
const INVESTMENTS: &[Column] = &[
            text("id"),
            text("account_id"),
            text("symbol"),
            text("name"),
            text("asset_type"),
            text("exchange"),
            text("currency"),
            eight("quantity", "quantity_e8"),
            money("cost_basis", "cost_basis_minor"),
            eight("current_price", "current_price_e8"),
            money("market_value", "market_value_minor"),
            date("purchase_date"),
            eight("purchase_price", "purchase_price_e8"),
            stamp("last_updated"),
            text("notes"),
            stamp("created_at"),
            stamp("updated_at"),
];

        // `tax_minor` has no key: the cloud has nowhere to keep stamp duty
        // except `transactions.metadata.investmentData.stampDuty`, which
        // belongs to a different row. It takes this schema's default of 0,
        // which is the honest value for "the file did not say".
const INVESTMENT_TRANSACTIONS: &[Column] = &[
            text("id"),
            text("investment_id"),
            text("transaction_type"),
            eight("quantity", "quantity_e8"),
            eight("price", "unit_price_e8"),
            money("total_amount", "total_amount_minor"),
            money("fees", "fee_minor"),
            date("date"),
            text("notes"),
            stamp("created_at"),
];

        // R-10. In the cloud `user_id` is TEXT against
        // `user_profiles(clerk_user_id)`, which is why the RPC has to
        // overwrite it a SECOND time with a Clerk id (`:337-346`). There is
        // no Clerk here and the column is a plain `users(id)` foreign key, so
        // the special case disappears — this entity is re-owned exactly like
        // every other one, and `clerk_identity_unknown` has no local twin.
const RECURRING_TRANSACTIONS: &[Column] = &[
            text("id"),
            text("account_id"),
            text("description"),
            money("amount", "amount_minor"),
            text("type"),
            text("category"),
            text("frequency"),
            date("start_date"),
            date("end_date"),
            date("next_date"),
            flag("is_active"),
            flag("auto_create"),
            stamp("created_at"),
            stamp("updated_at"),
];

const NOTIFICATIONS: &[Column] = &[
            text("id"),
            text("type"),
            text("title"),
            text("message"),
            flag("is_read"),
            text("action_label"),
            text("action_url"),
            stamp("created_at"),
            stamp("updated_at"),
];

const DASHBOARD_LAYOUTS: &[Column] = &[
            text("id"),
            text("name"),
            json("widgets"),
            flag("is_default"),
            stamp("created_at"),
            stamp("updated_at"),
];

const WIDGET_PREFERENCES: &[Column] = &[
            text("id"),
            text("widget_type"),
            json("settings"),
            flag("is_collapsed"),
            stamp("last_refreshed"),
            stamp("created_at"),
            stamp("updated_at"),
];

        // `subject_ids` is a uuid[] in the cloud with a GIN index and a
        // column comment PROMISING every id resolves. Here it is the child
        // table `suggestion_dismissal_subjects`, where the promise is a
        // foreign key — see [`insert_row`] for what happens to a subject the
        // file names and the ledger does not have.
const SUGGESTION_DISMISSALS: &[Column] = &[
            text("id"),
            text("kind"),
            text("subject_key"),
            stamp("dismissed_at"),
];

        // The two blobs are `jsonb` in the cloud and TEXT-with-`json_valid`
        // here, so they travel as [`Kind::Json`] exactly as `metadata` does —
        // and unlike `metadata` they can never carry money, because the money
        // CHECK's whole subject is the transaction blob and a report holds no
        // figure at all (`crate::row::custom_report` argues it).
        //
        // The account and category ids INSIDE `filters` are the reason this
        // entity is declared to `remapBackupIds` on the TypeScript side, and the
        // reason nothing here touches them: this module translates rows and the
        // remapper rewrites references, and the header above says why that line
        // is not crossed. A file whose `filters` still named the exporter's
        // accounts would restore into a report that narrows to nothing — wrong,
        // and wrong in a way that is visible on the page rather than in a total.
        // `monthly_minor` travels under ONE name in both engines — the cloud
        // column is already an integer of pennies (bigint), so there is no
        // `_minor` rename and no scale conversion anywhere on this row's trip.
const FORECAST_ADJUSTMENTS: &[Column] = &[
            text("id"),
            text("category_id"),
            ordinal("monthly_minor"),
            stamp("created_at"),
            stamp("updated_at"),
];

const CUSTOM_REPORTS: &[Column] = &[
            text("id"),
            text("name"),
            text("description"),
            json("components"),
            json("filters"),
            stamp("created_at"),
            stamp("updated_at"),
];

// ── The columns a restore will not insert, and a collect must still write ───
//
// Three columns form the cycles `finalize_user_restore` exists to close, so
// [`insert_row`] deliberately has no entry for any of them and the RPC nulls
// them for the same reason. They are still part of the FILE — `buildBackupBundle`
// reads them straight off the rows to build `links.account_parents` and
// `links.transaction_links` — so a collect that left them out would export a
// ledger whose every transfer came back unpaired, silently, and the pairing
// would be gone from the only copy.
//
// Separate lists rather than a flag on [`Column`], so that the INSERT side
// cannot reach them by accident: the two directions ask for different sets and
// each asks by name.

const ACCOUNTS_DEFERRED: &[Column] = &[text("parent_account_id")];

const TRANSACTIONS_DEFERRED: &[Column] =
    &[text("linked_transfer_id"), text("linked_transfer_split_id")];

// ── The entities ────────────────────────────────────────────────────────────

/// Everything `restore_user_chunk` will accept, spelled exactly as the RPC's
/// `p_entity` branch list spells it.
///
/// The match in [`Entity::columns`] is exhaustive, which is canonical invariant
/// #125 made structural: *"Every backup entity must have a recorded storage
/// decision — a new table without one is a compile error."*
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Entity {
    /// Must be first in any restore: the emptiness precondition is checked here.
    Accounts,
    /// Sent level by level by the client, so `parent_id` always resolves.
    Categories,
    /// The ledger.
    Transactions,
    /// Split lines, after their parents.
    TransactionSplits,
    /// Budgets.
    Budgets,
    /// Goals.
    Goals,
    /// Contributions, after their goals.
    GoalContributions,
    /// Holdings.
    Investments,
    /// Holding movements, after their holdings.
    InvestmentTransactions,
    /// Templates. The cloud's odd one out; see [`Entity::columns`].
    RecurringTransactions,
    /// Carried so a cloud backup restores whole.
    Notifications,
    /// Carried so a cloud backup restores whole.
    DashboardLayouts,
    /// Carried so a cloud backup restores whole.
    WidgetPreferences,
    /// Carried so a cloud backup restores whole.
    SuggestionDismissals,
    /// The saved reports — added by `20260812140000`, which is also where
    /// the cloud's `restore_user_chunk` grew its fifteenth branch.
    CustomReports,
    /// The forecast scenario's stated deviations — one row per adjusted
    /// category. The sixteenth, added by `20260819150000`; relational rather
    /// than a document precisely so THIS machinery's plainest case (a uuid
    /// column) is the one that carries its category reference.
    ForecastAdjustments,
}

impl Entity {
    /// Every entity a backup carries, in the order `BACKUP_ENTITIES` lists them.
    ///
    /// The same order the cloud's collector reads in
    /// (`backupService.BACKUP_ENTITIES`), and the reason it is written down once
    /// rather than spelled at each call site: [`super::verbs::collect_backup`]
    /// walks it, and so does the exhaustiveness test below. A file whose
    /// sections came out in a different order from the cloud's would be a
    /// different file for no reason a reader could see.
    pub const ALL: [Self; 16] = [
        Self::Accounts,
        Self::Categories,
        Self::Transactions,
        Self::TransactionSplits,
        Self::Budgets,
        Self::Goals,
        Self::GoalContributions,
        Self::Investments,
        Self::InvestmentTransactions,
        Self::RecurringTransactions,
        Self::Notifications,
        Self::DashboardLayouts,
        Self::WidgetPreferences,
        Self::SuggestionDismissals,
        Self::CustomReports,
        Self::ForecastAdjustments,
    ];

    /// The table this entity is stored in.
    #[must_use]
    pub const fn table(self) -> &'static str {
        match self {
            Self::Accounts => "accounts",
            Self::Categories => "categories",
            Self::Transactions => "transactions",
            Self::TransactionSplits => "transaction_splits",
            Self::Budgets => "budgets",
            Self::Goals => "goals",
            Self::GoalContributions => "goal_contributions",
            Self::Investments => "investments",
            Self::InvestmentTransactions => "investment_transactions",
            Self::RecurringTransactions => "recurring_transactions",
            Self::Notifications => "notifications",
            Self::DashboardLayouts => "dashboard_layouts",
            Self::WidgetPreferences => "widget_preferences",
            Self::SuggestionDismissals => "suggestion_dismissals",
            Self::CustomReports => "custom_reports",
            Self::ForecastAdjustments => "forecast_adjustments",
        }
    }

    /// The name `p_entity` carries. Same string on both engines.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        self.table()
    }

    /// Resolve `p_entity`.
    ///
    /// # Errors
    /// [`CoreError::Refused`] with the RPC's own `restore_entity_unknown`.
    pub fn parse(name: &str) -> CoreResult<Self> {
        let entity = match name {
            "accounts" => Self::Accounts,
            "categories" => Self::Categories,
            "transactions" => Self::Transactions,
            "transaction_splits" => Self::TransactionSplits,
            "budgets" => Self::Budgets,
            "goals" => Self::Goals,
            "goal_contributions" => Self::GoalContributions,
            "investments" => Self::Investments,
            "investment_transactions" => Self::InvestmentTransactions,
            "recurring_transactions" => Self::RecurringTransactions,
            "notifications" => Self::Notifications,
            "dashboard_layouts" => Self::DashboardLayouts,
            "widget_preferences" => Self::WidgetPreferences,
            "suggestion_dismissals" => Self::SuggestionDismissals,
            "custom_reports" => Self::CustomReports,
            "forecast_adjustments" => Self::ForecastAdjustments,
            other => {
                return Err(CoreError::refuse(
                    "restore_entity_unknown",
                    &format!("\"{other}\" is not something this backup format carries"),
                ))
            }
        };
        Ok(entity)
    }

    /// Which columns this entity's rows land in, and how each is converted.
    ///
    /// Read off the two schemas side by side, not off memory. Where the two
    /// disagree the disagreement is noted here rather than anywhere else.
    #[must_use]
    pub const fn columns(self) -> &'static [Column] {
        match self {
            Self::Accounts => ACCOUNTS,
            Self::Categories => CATEGORIES,
            Self::Transactions => TRANSACTIONS,
            Self::TransactionSplits => TRANSACTION_SPLITS,
            Self::Budgets => BUDGETS,
            Self::Goals => GOALS,
            Self::GoalContributions => GOAL_CONTRIBUTIONS,
            Self::Investments => INVESTMENTS,
            Self::InvestmentTransactions => INVESTMENT_TRANSACTIONS,
            Self::RecurringTransactions => RECURRING_TRANSACTIONS,
            Self::Notifications => NOTIFICATIONS,
            Self::DashboardLayouts => DASHBOARD_LAYOUTS,
            Self::WidgetPreferences => WIDGET_PREFERENCES,
            Self::SuggestionDismissals => SUGGESTION_DISMISSALS,
            Self::CustomReports => CUSTOM_REPORTS,
            Self::ForecastAdjustments => FORECAST_ADJUSTMENTS,
        }
    }

    /// The columns a COLLECT writes and a RESTORE will not insert.
    ///
    /// Empty for thirteen of the fifteen. See the two lists above for why the
    /// other two are asymmetric on purpose.
    #[must_use]
    pub const fn deferred(self) -> &'static [Column] {
        match self {
            Self::Accounts => ACCOUNTS_DEFERRED,
            Self::Transactions => TRANSACTIONS_DEFERRED,
            _ => &[],
        }
    }
}

// ── Reading a value ─────────────────────────────────────────────────────────

/// The text of a JSON value, in the spelling `jsonb ->>` would produce.
///
/// Shares [`crate::wire::as_text`]'s decision so that a caller who has always
/// sent `{"amount": -15}` keeps working: a number arrives as its own spelling,
/// not as a float.
fn as_text(value: &Value) -> Option<String> {
    crate::wire::as_text(value)
}

/// Scale a decimal string by `10^places`, exactly.
///
/// `Money::parse` is the 2-place case and this is the same algorithm generalised,
/// with the same three refusals. It is written here rather than in [`crate::money`]
/// because quantities and prices are not money and must not acquire money's type.
///
/// # Errors
/// A refusal code from [`crate::money::MoneyError`], so the codes a caller sees
/// are the same whichever scale refused them.
fn scale(text: &str, places: u32) -> Result<i64, crate::money::MoneyError> {
    use crate::money::MoneyError;

    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    if digits.is_empty() || digits.matches('.').count() > 1 {
        return Err(MoneyError::Malformed);
    }
    let mut parts = digits.splitn(2, '.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next().unwrap_or("");
    if whole.is_empty() && fraction.is_empty() {
        return Err(MoneyError::Malformed);
    }
    if !whole.bytes().all(|b| b.is_ascii_digit()) || !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return Err(MoneyError::Malformed);
    }
    // Trailing zeros beyond the scale are not extra precision: "1.500" at scale 2
    // is 150, and refusing it would refuse a value the file can express exactly.
    let significant = fraction.trim_end_matches('0');
    let width = usize::try_from(places).map_err(|_| MoneyError::OutOfRange)?;
    if significant.len() > width {
        return Err(MoneyError::SubMinorUnit);
    }

    let mut units: i64 = if whole.is_empty() {
        0
    } else {
        whole.parse::<i64>().map_err(|_| MoneyError::OutOfRange)?
    };
    for _ in 0..places {
        units = units.checked_mul(10).ok_or(MoneyError::OutOfRange)?;
    }
    let mut padded = String::from(significant);
    while padded.len() < width {
        padded.push('0');
    }
    if !padded.is_empty() {
        let fractional = padded.parse::<i64>().map_err(|_| MoneyError::OutOfRange)?;
        units = units.checked_add(fractional).ok_or(MoneyError::OutOfRange)?;
    }
    if negative {
        units = units.checked_neg().ok_or(MoneyError::OutOfRange)?;
    }
    Ok(units)
}

/// A calendar day, `YYYY-MM-DD`.
///
/// Canonical invariant #124 / TS-X4, and its second sentence is the one that
/// matters: *"a value already a day passes untouched"*. A day is passed through
/// without being parsed, because `new Date('2026-01-15')` invents a UTC midnight
/// and midnight belongs to a zone — which is how a transaction dated the 15th
/// comes back as the 14th west of Greenwich. A longer value is truncated
/// LEXICALLY, with no zone arithmetic at all, for the same reason.
fn as_day(text: &str) -> Option<String> {
    let day = text.get(..10)?;
    if crate::wire::is_calendar_date(day) {
        Some(day.to_owned())
    } else {
        None
    }
}

/// An instant, in the exact shape this schema's column defaults produce.
///
/// SQLite does the conversion, not Rust, for the reason [`crate::db::now`] gives:
/// a row written by a verb and a row written by a column default must be stamped
/// by the same clock in the same format, and a second implementation would
/// eventually drift from the first. MEASURED — `strftime('%Y-%m-%dT%H:%M:%fZ', ?)`
/// against the shapes a backup can hold:
///
/// ```text
/// 2019-01-01T00:00:00+00:00     -> 2019-01-01T00:00:00.000Z
/// 2019-05-04T09:30:00.123+01:00 -> 2019-05-04T08:30:00.123Z
/// 2019-01-01T00:00:00.000Z      -> 2019-01-01T00:00:00.000Z
/// not a time                    -> NULL
/// ```
///
/// The `+00:00` case is why this cannot be a string test: PostgREST renders
/// `timestamptz` with a numeric offset, and `transactions_timestamps_shaped`
/// requires the `Z`.
fn as_instant(connection: &Connection, text: &str) -> CoreResult<Option<String>> {
    Ok(connection.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1)",
        [text],
        |row| row.get::<_, Option<String>>(0),
    )?)
}

// ── The metadata money strip ────────────────────────────────────────────────

/// The eleven keys `transactions_no_money_in_metadata` refuses, and what becomes
/// of each.
///
/// DESIGN.md §3.3 is the table this is a transcription of. Four have a typed home
/// in this schema and are promoted into it; the rest are dropped, because the
/// figures they carry belong to a row in another table entirely (a transaction
/// carrying `investmentData.quantity` is an investment transaction written to the
/// wrong table) or to a reconciliation design that `is_cleared` + `bank_balance`
/// replaced.
///
/// **Every drop is reported.** The alternative — refusing the restore — was
/// rejected: it would make a real cloud backup unrestorable with no way forward
/// but hand-editing JSON, and DESIGN.md already decided these figures have no
/// home. The alternative in the other direction — dropping them quietly — is the
/// one thing a restore must never do with a number.
const PROMOTED: [(&str, &str, u32); 4] = [
    ("fees", "fee_minor", 2),
    ("originalAmount", "original_amount_minor", 2),
    ("exchangeRate", "fx_rate_e10", 10),
    // Not money and not banned by the CHECK, but the FX triple is all-or-nothing
    // (`transactions_fx_complete`), so the currency has to travel with the amount
    // and the rate or none of the three can land.
    ("originalCurrency", "original_currency", 0),
];

/// The banned keys with nowhere to go, and the sentence each drop reports.
const DROPPED_KEYS: [(&str, &str); 7] = [
    ("pricePerUnit", "a unit price belongs on the holding, not on a transaction"),
    ("marketValue", "a market value belongs on the holding, not on a transaction"),
    ("costBasis", "a cost basis belongs on the holding, not on a transaction"),
    ("units", "a unit count belongs on the holding, not on a transaction"),
    ("expectedAmount", "reconciliation is is_cleared and bank_balance now"),
    ("actualAmount", "reconciliation is is_cleared and bank_balance now"),
    ("discrepancy", "reconciliation is is_cleared and bank_balance now"),
];

/// What came out of one row's `metadata`.
#[derive(Debug, Default)]
pub struct MetadataStrip {
    /// Column name → value, for the four promoted figures.
    pub promoted: Vec<(&'static str, SqlValue)>,
    /// What was thrown away, and why.
    pub dropped: Vec<String>,
}

/// Lift the money out of a cloud `metadata` blob so the row can be stored.
///
/// Mutates the blob in place: after this returns, `metadata` contains none of the
/// eleven keys and `transactions_no_money_in_metadata` is satisfied. Everything
/// non-numeric — `transferType`, `reference`, `documentation`, the dates, the
/// labels — is left exactly as the file had it.
///
/// # Errors
/// [`CoreError::Refused`] if a promoted figure cannot be scaled: a rate with
/// eleven decimal places, or an amount past `i64`. Those are refusals rather than
/// drops because the figure DOES have a home and would be silently wrong in it.
pub fn strip_metadata_money(metadata: &mut Value) -> CoreResult<MetadataStrip> {
    let mut strip = MetadataStrip::default();

    if let Some(investment) = metadata.get("investmentData") {
        if !investment.is_null() {
            strip.dropped.push(
                "investmentData — a transaction carrying holding figures is an investment \
                 transaction written to the wrong table"
                    .to_owned(),
            );
        }
    }
    if let Some(object) = metadata.as_object_mut() {
        object.remove("investmentData");
    }

    let Some(transfer) = metadata.get_mut("transferMetadata").and_then(Value::as_object_mut) else {
        return Ok(strip);
    };

    for (key, column, places) in PROMOTED {
        let Some(value) = transfer.remove(key) else { continue };
        if value.is_null() {
            continue;
        }
        let Some(text) = as_text(&value) else { continue };
        if places == 0 {
            strip.promoted.push((column, SqlValue::Text(text)));
            continue;
        }
        let scaled = scale(&text, places).map_err(|error| {
            CoreError::refuse(
                error.code(),
                &format!(
                    "metadata.transferMetadata.{key} holds {text}, which this ledger stores in \
                     {column} and cannot represent: {error}"
                ),
            )
        })?;
        strip.promoted.push((column, SqlValue::Integer(scaled)));
    }

    for (key, why) in DROPPED_KEYS {
        if transfer.remove(key).is_some_and(|value| !value.is_null()) {
            strip.dropped.push(format!("metadata.transferMetadata.{key} — {why}"));
        }
    }

    Ok(strip)
}

// ── Writing a row ───────────────────────────────────────────────────────────

/// Which of a table's columns will accept a NULL, asked of the schema itself.
///
/// The local half of the cloud's catalogue read (`20260811090000`: *"it cannot
/// be a list. It is read from the schema itself"*). SQLite's answer is simpler
/// than Postgres's and the difference is worth stating, because it is why this
/// function returns one set rather than a map of defaults:
///
/// * the cloud has to decide WHICH default is safe to apply, since it must
///   supply a value for every column it does not want NULLed — and a generated
///   default (`gen_random_uuid()`, `now()`) applied to a silence would mint a
///   fresh identity or stamp history with today. Leaving a column out of an
///   INSERT has no such hazard: the default is applied by the ENGINE, exactly as
///   it is for every other writer, so nothing here can choose the wrong one.
/// * so the only question left is the one this answers: may this column hold the
///   null the file stated?
///
/// MEASURED against `schema.sql` (2026-08-11): of every column reachable from a
/// backup row, exactly ONE is nullable AND carries a default —
/// `transactions.is_reconciled`. Every other nullable column defaults to NULL
/// anyway, so this rule changes the stored row for that column and no other
/// today. It is written as a rule rather than as that one column because the
/// next nullable column with a meaning-carrying default must not need anybody to
/// remember this file.
///
/// `pragma` binds the table name as a parameter; nothing is concatenated.
fn nullable_columns(connection: &Connection, table: &str) -> CoreResult<BTreeSet<String>> {
    let mut names = BTreeSet::new();
    connection.pragma(None, "table_info", table, |row| {
        let name: String = row.get("name")?;
        let not_null: i64 = row.get("notnull")?;
        if not_null == 0 {
            names.insert(name);
        }
        Ok(())
    })?;
    Ok(names)
}

/// The two child tables a backup row can carry inside an array column.
fn child_array(entity: Entity, row: &BackupRow) -> Option<(&'static str, &[Value])> {
    let key = match entity {
        Entity::Transactions => "tags",
        Entity::SuggestionDismissals => "subject_ids",
        _ => return None,
    };
    row.get(key).and_then(Value::as_array).map(|values| (key, values.as_slice()))
}

/// Insert one backup row, re-owned to `owner`.
///
/// # Errors
/// [`CoreError::Refused`] naming the entity and the row's id, always — a restore
/// of fifty thousand rows that says only *"CHECK constraint failed"* has told the
/// user nothing they can act on.
#[allow(clippy::too_many_lines)]
pub fn insert_row(
    connection: &Connection,
    entity: Entity,
    row: &BackupRow,
    owner: &str,
    dropped: &mut Vec<Dropped>,
) -> CoreResult<()> {
    let id = row.get("id").and_then(Value::as_str).unwrap_or("(no id)").to_owned();
    let named = |error: CoreError| -> CoreError { name_the_row(error, entity, &id) };

    // X-6: the owner is supplied by the verb and never read from the file, so a
    // bundle exported by another login lands owned by whoever restored it.
    let mut columns: Vec<&'static str> = vec!["user_id"];
    let mut values: Vec<SqlValue> = vec![SqlValue::Text(owner.to_owned())];

    let nullable = nullable_columns(connection, entity.table())?;

    for column in entity.columns() {
        // ── A SILENCE IS ANSWERED BY THE SCHEMA, AND ONLY WHERE IT MAY BE ───
        // The cloud's own rule (20260811090000), translated — and the
        // translation was CORRECTED by the differential harness, which is the
        // whole reason that harness exists. The rule is one sentence:
        //
        //   A COLUMN THAT MAY HOLD NULL IS GIVEN WHAT THE FILE SAYS, OR NULL.
        //   A COLUMN THAT MAY NOT IS GIVEN WHAT THE FILE SAYS, OR ITS DEFAULT.
        //
        // In the cloud that falls out of two mechanisms: `jsonb_populate_recordset`
        // emits an EXPLICIT NULL for every column the JSON does not mention, and
        // 20260811090000 then lays the schema's constant defaults under the row
        // for exactly one class — *"NOT NULL WITH a default, which is the only
        // class this fills in"*. Here the same two outcomes are reached by
        // choosing between binding NULL and leaving the column out of the
        // INSERT, which is what makes SQLite apply its default.
        //
        // MEASURED, and the measurement is why this reads as it does: the first
        // draft filled a silence from the default wherever there was one, and
        // the differential spec caught it on `transactions.is_reconciled` — a
        // file from before that column existed came back `0` here and NULL in
        // the cloud. NULL there MEANS *"this row predates the split between
        // marking and committing; ask is_cleared"*, and `0` means *"explicitly
        // not committed"*. Filling it in would offer a decade of reconciled
        // statements back to somebody to do again.
        //
        // A stated null on a NOT NULL column is treated as a silence for the
        // reason the migration gives: no legal export could have produced it,
        // because the column refuses NULL, so it is a hand-edited file or a
        // client that wrote a key it had no value for — and the default is the
        // only honest reading.
        //
        // Which columns are which is READ FROM THE SCHEMA, never listed here. A
        // list would be a promise to remember restore every time anybody adds a
        // column, and that promise has already been broken once — by a careful
        // migration, in the cloud, on this exact operation.
        let stated = row.get(column.key).filter(|value| !value.is_null());
        let Some(value) = stated else {
            if nullable.contains(column.column) {
                columns.push(column.column);
                values.push(SqlValue::Null);
            }
            continue;
        };
        let stored = match column.kind {
            Kind::Json => SqlValue::Text(value.to_string()),
            Kind::Flag => {
                let flag: crate::wire::Flag = serde_json::from_value(value.clone())
                    .map_err(|error| CoreError::InvalidCommand(error.to_string()))
                    .map_err(named)?;
                let resolved = flag
                    .resolve()
                    .map_err(|message| CoreError::refuse("invalid_boolean", &message))
                    .map_err(named)?;
                SqlValue::Integer(i64::from(resolved))
            }
            Kind::Ordinal => {
                let Some(text) = as_text(value) else { continue };
                if text.is_empty() {
                    continue;
                }
                let number = text.parse::<i64>().map_err(|_| {
                    named(CoreError::refuse(
                        "invalid_integer",
                        &format!("{} is not an integer: {text:?}", column.key),
                    ))
                })?;
                SqlValue::Integer(number)
            }
            Kind::Scaled(places) => {
                let Some(text) = as_text(value) else { continue };
                let scaled = scale(&text, places)
                    .map_err(|error| {
                        CoreError::refuse(
                            error.code(),
                            &format!("{} holds {text}, which this ledger cannot store: {error}", column.key),
                        )
                    })
                    .map_err(named)?;
                SqlValue::Integer(scaled)
            }
            Kind::Date => {
                let Some(text) = as_text(value) else { continue };
                let day = as_day(&text).ok_or_else(|| {
                    named(CoreError::refuse(
                        "date_invalid",
                        &format!("{} is not a calendar day: {text:?}", column.key),
                    ))
                })?;
                SqlValue::Text(day)
            }
            Kind::Timestamp => {
                let Some(text) = as_text(value) else { continue };
                let instant = as_instant(connection, &text)?.ok_or_else(|| {
                    named(CoreError::refuse(
                        "timestamp_unreadable",
                        &format!("{} is not an instant this file can date: {text:?}", column.key),
                    ))
                })?;
                SqlValue::Text(instant)
            }
            Kind::Text => SqlValue::Text(as_text(value).unwrap_or_default()),
        };
        columns.push(column.column);
        values.push(stored);
    }

    // Divergence 9. Done after the column loop so the promoted figures join the
    // same INSERT as the blob they came out of: a row whose fee landed and whose
    // metadata did not would be a row that says the fee twice.
    if entity == Entity::Transactions {
        let mut metadata = row.get("metadata").cloned().unwrap_or(Value::Null);
        if !metadata.is_null() {
            let strip = strip_metadata_money(&mut metadata).map_err(named)?;
            for note in strip.dropped {
                dropped.push(Dropped { entity: entity.as_str().to_owned(), id: id.clone(), what: note });
            }
            for (column, value) in strip.promoted {
                columns.push(column);
                values.push(value);
            }
            if let Some(position) = columns.iter().position(|name| *name == "metadata") {
                if let Some(slot) = values.get_mut(position) {
                    *slot = SqlValue::Text(metadata.to_string());
                }
            }
        }
    }

    let placeholders = (1..=columns.len()).map(|n| format!("?{n}")).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({placeholders})",
        entity.table(),
        columns.join(", ")
    );
    let bound: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    connection.execute(&sql, bound.as_slice()).map_err(|error| named(error.into()))?;

    if let Some((key, members)) = child_array(entity, row) {
        write_child_array(connection, entity, &id, key, members, owner, dropped).map_err(named)?;
    }

    Ok(())
}

/// `text[]` and `uuid[]` become child tables here, so the array is written after
/// its parent row.
fn write_child_array(
    connection: &Connection,
    entity: Entity,
    id: &str,
    key: &str,
    members: &[Value],
    owner: &str,
    dropped: &mut Vec<Dropped>,
) -> CoreResult<()> {
    match entity {
        // A set, not a sequence: `PRIMARY KEY (transaction_id, tag)` is what
        // makes the two engines agree about a duplicate, and `INSERT OR IGNORE`
        // is how a duplicate in the file survives it — Postgres's `text[]` holds
        // one happily, so refusing here would refuse a row the cloud stores.
        Entity::Transactions => {
            let mut seen = BTreeSet::new();
            for member in members {
                let Some(tag) = member.as_str() else { continue };
                if tag.trim().is_empty() || !seen.insert(tag) {
                    continue;
                }
                connection.execute(
                    "INSERT OR IGNORE INTO transaction_tags (transaction_id, tag) VALUES (?1, ?2)",
                    rusqlite::params![id, tag],
                )?;
            }
            Ok(())
        }
        // The cloud's column comment PROMISES every subject id resolves in
        // exactly one table; here it is a foreign key. A subject the file names
        // and the ledger does not hold is therefore unstorable — and it is
        // dropped rather than refused, because a dismissal is a suggestion the
        // user has waved away, not money, and losing a whole restore over one
        // would be absurd. The dismissal itself still lands: `subject_key` is
        // what identifies it.
        Entity::SuggestionDismissals => {
            for (position, member) in members.iter().enumerate() {
                let Some(subject) = member.as_str() else { continue };
                let known: i64 = connection.query_row(
                    "SELECT EXISTS (SELECT 1 FROM transactions WHERE id = ?1 AND user_id = ?2)",
                    rusqlite::params![subject, owner],
                    |row| row.get(0),
                )?;
                if known == 0 {
                    dropped.push(Dropped {
                        entity: entity.as_str().to_owned(),
                        id: id.to_owned(),
                        what: format!("{key}[{position}] names a transaction this ledger does not hold"),
                    });
                    continue;
                }
                let order = i64::try_from(position).map_err(|_| {
                    CoreError::refuse("amount_out_of_range", "more subjects than a dismissal can hold")
                })?;
                connection.execute(
                    "INSERT INTO suggestion_dismissal_subjects (dismissal_id, transaction_id, role_order)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![id, subject, order],
                )?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

// ── Reading a row back OUT ──────────────────────────────────────────────────
//
// The other direction, and the reason this module is where it lives rather than
// two modules that happen to agree. Everything above translates a backup row
// into a stored row; everything below translates a stored row into a backup row,
// THROUGH THE SAME COLUMN TABLE. The tables are the map between two schemas, and
// a second copy of that map — a collector with a column list of its own — is a
// file that exports what it cannot import. That is not a hypothetical shape: it
// is what a hand-written collector produces the first time somebody adds a
// column to one list and not the other, and the failure surfaces only when a
// person restores.
//
// It is also the whole of B-11's claim, made structural: ONE format, read by
// both editions. A cloud file restores here because [`insert_row`] reads the
// cloud's keys; a file written here restores THERE because [`read_rows`] writes
// the cloud's keys. The keys are the same `&'static str` in both cases, so the
// two statements cannot drift apart.

/// The exact inverse of [`scale`]: a scaled integer as its decimal text.
///
/// Money crosses this seam as the number's own decimal spelling (PHASE3-PLAN
/// D-4), never as a JSON number — a JSON number is an IEEE-754 double by the
/// time any parser has read it, and `backupService.MAX_EXACT_MONEY` exists
/// because that trip is only exact below 2^53 hundredths. A decimal string has
/// no such ceiling and both engines' restores accept one: [`scale`] reads it
/// here, and `jsonb_populate_recordset` casts it to `numeric` there.
///
/// `hundredths_to_decimal_string` is the two-place case and this is the same
/// algorithm generalised, for [`scale`]'s reason: quantities and prices are not
/// money and must not acquire money's type on the way past.
// Every operation is bounded by construction: `places` comes from a `Kind` in
// the column table above and is never more than 10, so the divisor is at most
// 10^10 and cannot overflow a u64; the divisor is never zero, so neither the
// division nor the remainder can trap. Spelled out rather than switching the
// lint off silently, exactly as `crate::money` does.
#[allow(clippy::arithmetic_side_effects)]
fn unscale(units: i64, places: u32) -> String {
    if places == 0 {
        return units.to_string();
    }
    let negative = units < 0;
    // i64::MIN has no positive counterpart; unsigned_abs is the only correct way
    // to take the magnitude.
    let magnitude = units.unsigned_abs();
    let mut divisor: u64 = 1;
    for _ in 0..places {
        divisor = divisor.saturating_mul(10);
    }
    let whole = magnitude / divisor;
    let fraction = magnitude % divisor;
    let width = usize::try_from(places).unwrap_or(0);
    let sign = if negative { "-" } else { "" };
    format!("{sign}{whole}.{fraction:0width$}")
}

/// One stored column as the JSON the file carries.
///
/// A NULL column becomes JSON `null` — never an omitted key — which is the
/// collect side of the rule [`insert_row`] keeps: the two are different
/// statements and a file that could not tell them apart could not carry
/// `is_reconciled`'s third value at all.
fn value_of(record: &rusqlite::Row<'_>, index: usize, kind: Kind) -> rusqlite::Result<Value> {
    use rusqlite::types::ValueRef;

    let raw = record.get_ref(index)?;
    if matches!(raw, ValueRef::Null) {
        return Ok(Value::Null);
    }
    let value = match kind {
        Kind::Text | Kind::Date | Kind::Timestamp => Value::String(record.get::<_, String>(index)?),
        Kind::Flag => Value::Bool(record.get::<_, i64>(index)? != 0),
        Kind::Ordinal => Value::Number(record.get::<_, i64>(index)?.into()),
        Kind::Scaled(places) => Value::String(unscale(record.get::<_, i64>(index)?, places)),
        // Stored as TEXT and carried as a document, so a reader of the file sees
        // the same object the cloud's `jsonb` renders rather than a string
        // holding JSON. A blob this file cannot parse travels as its own text
        // instead of failing the export: a backup that refuses to be taken is
        // worse than one carrying something odd, and the odd thing is preserved
        // exactly.
        Kind::Json => {
            let text: String = record.get(index)?;
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        }
    };
    Ok(value)
}

/// Every row of one entity, whole, as the backup format spells them.
///
/// ── ORDERED BY `rowid` — THE FILE'S OWN ORDER, NOT THE ID'S ─────────────────
///
/// The cloud orders by `id` and says why: *"purely so paging is stable — without
/// a deterministic order the same row can appear on two pages and another on
/// none"*. There is no paging here, so that reason does not apply, and copying
/// the clause anyway would have been the wrong kind of faithfulness. MEASURED,
/// by the contract suite's *"a restored ledger exports to the same file again,
/// and again"*: ordering by id makes the export order a function of the RANDOM
/// uuids a restore mints, so two generations of the same ledger come out in
/// different orders — the same rows, shuffled, in a file a person might diff.
///
/// `rowid` is the order the file itself holds them in, which is the order they
/// were written in, which — after a restore — is the order the file being
/// restored listed them in. So the round trip is order-preserving, and the same
/// ledger exports to the same bytes however many times it goes round. It is also
/// the order `localCore.fixtureFile.ts` reads its independent witness back in,
/// for the same reason stated there.
///
/// Every table a backup carries has a rowid; the two child tables that do not
/// (`transaction_tags`, `suggestion_dismissal_subjects`) are read by
/// [`child_members`], each ordered by what its own meaning demands.
///
/// # Errors
/// [`CoreError::Storage`] for a fault. There is no refusal here: reading a
/// ledger you own cannot be refused, and a collect that could fail on a row
/// would be a backup that stops being takeable as soon as it matters.
pub fn read_rows(connection: &Connection, entity: Entity, owner: &str) -> CoreResult<Vec<Value>> {
    // The columns a restore inserts, plus the ones it leaves for the second
    // pass. Both are in the file; only the first are in an INSERT.
    let carried: Vec<Column> =
        entity.columns().iter().chain(entity.deferred().iter()).copied().collect();

    // Divergence 9, backwards. The cloud keeps these four figures inside
    // `metadata.transferMetadata` and this schema gives them typed columns, so a
    // collect has to put them back where a cloud restore will look for them —
    // otherwise a fee survives the trip out of the cloud and dies on the way
    // home. Symmetry with [`strip_metadata_money`], which is the only reason it
    // is safe: the same four keys, the same four columns, the same scales.
    let promoted: &[(&str, &str, u32)] =
        if matches!(entity, Entity::Transactions) { &PROMOTED } else { &[] };

    let mut names: Vec<&'static str> = carried.iter().map(|column| column.column).collect();
    for (_, column, _) in promoted {
        names.push(column);
    }

    // Every name in this statement is a `&'static str` from a column table in
    // this module. `owner` is bound. DESIGN.md §6.4 holds through the collect as
    // it does through the restore.
    let sql = format!(
        "SELECT {} FROM {} WHERE user_id = ?1 ORDER BY rowid",
        names.join(", "),
        entity.table()
    );

    let mut rows: Vec<Value> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    {
        let mut statement = connection.prepare(&sql)?;
        let mut cursor = statement.query(rusqlite::params![owner])?;
        while let Some(record) = cursor.next()? {
            let mut object = BackupRow::new();
            for (index, column) in carried.iter().enumerate() {
                object.insert(column.key.to_owned(), value_of(record, index, column.kind)?);
            }

            let mut transfer = Map::new();
            for (offset, (key, _, places)) in promoted.iter().enumerate() {
                let index = carried.len().saturating_add(offset);
                let kind = if *places == 0 { Kind::Text } else { Kind::Scaled(*places) };
                let value = value_of(record, index, kind)?;
                // A figure this row does not carry is left OUT of the blob
                // rather than written as null: the cloud's own writer only ever
                // puts a key there when there is a figure, and a
                // `transferMetadata` full of nulls would be a document the app
                // has never produced.
                if !value.is_null() {
                    transfer.insert((*key).to_owned(), value);
                }
            }
            if !transfer.is_empty() {
                fold_into_metadata(&mut object, transfer);
            }

            ids.push(object.get("id").and_then(Value::as_str).unwrap_or_default().to_owned());
            rows.push(Value::Object(object));
        }
    }

    // The child tables, folded back into the array columns the format carries.
    // A second pass rather than a nested cursor: one statement at a time is the
    // shape every other read in this crate keeps, and the row count here is a
    // person's ledger rather than a join.
    for (row, id) in rows.iter_mut().zip(ids.iter()) {
        let members = child_members(connection, entity, id)?;
        let Some((key, values)) = members else { continue };
        if let Some(object) = row.as_object_mut() {
            object.insert(key.to_owned(), Value::Array(values));
        }
    }

    Ok(rows)
}

/// Put the four promoted figures back under `metadata.transferMetadata`.
///
/// Merged into whatever the blob already holds rather than replacing it: the
/// same row's `transferType`, `reference` and dates live in there and are the
/// user's own text.
fn fold_into_metadata(object: &mut BackupRow, transfer: Map<String, Value>) {
    let mut metadata = object.remove("metadata").unwrap_or(Value::Null);
    if !metadata.is_object() {
        metadata = Value::Object(Map::new());
    }
    if let Some(blob) = metadata.as_object_mut() {
        let existing = blob.remove("transferMetadata");
        let mut merged = match existing {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        for (key, value) in transfer {
            merged.insert(key, value);
        }
        blob.insert("transferMetadata".to_owned(), Value::Object(merged));
    }
    object.insert("metadata".to_owned(), metadata);
}

/// The array column an entity carries in the file, read out of its child table.
///
/// The inverse of [`write_child_array`], and ordered the way each table's own
/// meaning demands: tags are a SET (`PRIMARY KEY (transaction_id, tag)`, so
/// there is no original order to preserve and `tag` is the only stable one), and
/// a dismissal's subjects are a SEQUENCE — `role_order` exists precisely because
/// `subject_ids[0]` and `subject_ids[1]` mean different things to the sweep that
/// wrote them.
fn child_members(
    connection: &Connection,
    entity: Entity,
    id: &str,
) -> CoreResult<Option<(&'static str, Vec<Value>)>> {
    let (key, sql) = match entity {
        Entity::Transactions => (
            "tags",
            "SELECT tag FROM transaction_tags WHERE transaction_id = ?1 ORDER BY tag",
        ),
        Entity::SuggestionDismissals => (
            "subject_ids",
            "SELECT transaction_id FROM suggestion_dismissal_subjects
              WHERE dismissal_id = ?1 ORDER BY role_order",
        ),
        _ => return Ok(None),
    };

    let mut statement = connection.prepare(sql)?;
    let mut cursor = statement.query(rusqlite::params![id])?;
    let mut members = Vec::new();
    while let Some(record) = cursor.next()? {
        members.push(Value::String(record.get::<_, String>(0)?));
    }
    Ok(Some((key, members)))
}

/// Put the entity and the row's id in front of whatever refused, and say what a
/// person can do about it.
///
/// The bounds in the hint are formatted from [`crate::money`]'s published
/// constants rather than written out, because the CONSTRAINT is what enforces
/// them and a second copy in prose would drift from it. MONEY-5: a cloud backup
/// may legally hold a `numeric(20,2)` row the local bound refuses, and the
/// obligation this discharges is that it is rejected *with a message*, never
/// silently rescaled — rescaling money is inventing it.
fn name_the_row(error: CoreError, entity: Entity, id: &str) -> CoreError {
    match error {
        CoreError::Storage(fault) => CoreError::Storage(fault),
        other => {
            let bound = crate::money::Money::from_minor(crate::money::Money::ROW_BOUND_MINOR);
            let stock = crate::money::Money::from_minor(crate::money::Money::STOCK_BOUND_MINOR);
            CoreError::Refused(
                crate::error::Refusal::named(
                    "restore_row_refused",
                    &format!("{} {id}: {other}", entity.as_str()),
                )
                .with_hint(&format!(
                    "This row is in the backup file but cannot be stored as it stands. If the \
                     figure is the problem: a single amount is bounded at ±{bound} and a stored \
                     balance at ±{stock}, because SQLite's integer sum RAISES at the int64 cliff \
                     where Postgres widens — one absurd row would leave the account with no \
                     computable balance at all rather than a wrong one. Correct the row in the \
                     file and restore again.",
                )),
            )
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::{as_day, scale, strip_metadata_money, unscale, Entity};
    use crate::money::MoneyError;
    use serde_json::json;

    #[test]
    fn scaling_is_exact_at_every_scale_the_schema_uses() {
        assert_eq!(scale("-12.34", 2), Ok(-1_234));
        assert_eq!(scale("12", 2), Ok(1_200));
        assert_eq!(scale("1.5", 2), Ok(150));
        assert_eq!(scale("1.500", 2), Ok(150), "trailing zeros are not precision");
        assert_eq!(scale("0.00000001", 8), Ok(1));
        assert_eq!(scale("12.345", 8), Ok(1_234_500_000));
        assert_eq!(scale("80", 2), Ok(8_000), "alert_threshold as basis points");
        assert_eq!(scale("1.0000000001", 10), Ok(10_000_000_001));
        assert_eq!(scale("-0", 2), Ok(0));
    }

    #[test]
    fn a_value_finer_than_the_column_is_refused_rather_than_rounded() {
        assert_eq!(scale("12.345", 2), Err(MoneyError::SubMinorUnit));
        assert_eq!(scale("0.000000001", 8), Err(MoneyError::SubMinorUnit));
        assert_eq!(MoneyError::SubMinorUnit.code(), "amount_not_representable");
    }

    #[test]
    fn scaling_overflow_is_an_error_not_a_wrap() {
        assert_eq!(scale("99999999999999999999", 2), Err(MoneyError::OutOfRange));
        assert_eq!(scale("1000000000000", 8), Err(MoneyError::OutOfRange));
    }

    #[test]
    fn scaling_refuses_everything_that_is_not_a_plain_decimal() {
        for text in ["", "-", "1,000", "1e3", "£1", "1.2.3", "abc"] {
            assert_eq!(scale(text, 2), Err(MoneyError::Malformed), "scaling {text:?}");
        }
    }

    #[test]
    fn a_day_passes_through_and_anything_longer_is_truncated_lexically() {
        assert_eq!(as_day("2024-03-01").as_deref(), Some("2024-03-01"));
        // No zone arithmetic: the 15th stays the 15th.
        assert_eq!(as_day("2026-01-15T02:30:00+05:00").as_deref(), Some("2026-01-15"));
        assert_eq!(as_day("2023-02-29"), None, "not a real day");
        assert_eq!(as_day("2024-3-1"), None);
        assert_eq!(as_day(""), None);
    }

    #[test]
    fn the_metadata_strip_promotes_four_and_reports_the_rest() {
        let mut metadata = json!({
            "transferMetadata": {
                "fees": 12.5,
                "originalAmount": "-100.00",
                "originalCurrency": "EUR",
                "exchangeRate": "1.1234567891",
                "marketValue": 9.99,
                "discrepancy": 0.01,
                "transferType": "wire"
            },
            "investmentData": { "stampDuty": 5 },
            "reference": "kept"
        });
        let strip = strip_metadata_money(&mut metadata).unwrap();

        assert_eq!(
            strip.promoted.iter().map(|(column, _)| *column).collect::<Vec<_>>(),
            ["fee_minor", "original_amount_minor", "fx_rate_e10", "original_currency"]
        );
        assert_eq!(strip.dropped.len(), 3, "{:?}", strip.dropped);
        assert!(strip.dropped[0].contains("investmentData"));

        // Everything non-numeric survives, and nothing the CHECK watches is left.
        assert_eq!(metadata["reference"], json!("kept"));
        assert_eq!(metadata["transferMetadata"]["transferType"], json!("wire"));
        assert!(metadata["transferMetadata"].get("fees").is_none());
        assert!(metadata.get("investmentData").is_none());
    }

    #[test]
    fn a_rate_finer_than_ten_places_is_refused_not_dropped() {
        // It HAS a home (fx_rate_e10), so silently losing it would be wrong in a
        // way losing marketValue is not.
        let mut metadata = json!({ "transferMetadata": { "exchangeRate": "1.00000000001" } });
        let error = strip_metadata_money(&mut metadata).expect_err("eleven places");
        assert_eq!(error.code(), "amount_not_representable", "{error}");
    }

    #[test]
    fn a_blob_with_no_money_in_it_is_left_alone() {
        let mut metadata = json!({ "transferMetadata": { "transferType": "wire" } });
        let strip = strip_metadata_money(&mut metadata).unwrap();
        assert_eq!(strip.promoted, [] as [(&str, rusqlite::types::Value); 0]);
        assert_eq!(strip.dropped, [] as [String; 0]);
        assert_eq!(metadata, json!({ "transferMetadata": { "transferType": "wire" } }));
    }

    #[test]
    fn every_entity_names_a_table_and_round_trips_its_own_name() {
        for entity in Entity::ALL {
            assert_eq!(Entity::parse(entity.as_str()).unwrap(), entity);
            assert!(!entity.columns().is_empty());
            // user_id is supplied by the verb, never taken from the file: X-6.
            assert!(
                entity.columns().iter().all(|column| column.key != "user_id"),
                "{} must not carry user_id from the file",
                entity.as_str()
            );
            // A deferred column is one a collect writes and a restore must NOT
            // insert. The two lists overlapping would mean the restore inserting
            // half of a cycle the finalize is about to close.
            for deferred in entity.deferred() {
                assert!(
                    entity.columns().iter().all(|column| column.key != deferred.key),
                    "{} carries {} in both directions",
                    entity.as_str(),
                    deferred.key
                );
            }
        }
    }

    #[test]
    fn every_entity_the_format_carries_is_in_the_walk() {
        // `ALL` is what the collector walks, so an entity missing from it would
        // be a table exported by nobody — the silent half of the same mistake
        // the exhaustive `columns()` match catches on the way in. SIXTEEN
        // since forecast_adjustments (20260819150000).
        assert_eq!(Entity::ALL.len(), 16);
        let mut seen = std::collections::BTreeSet::new();
        for entity in Entity::ALL {
            assert!(seen.insert(entity.as_str()), "{} is in ALL twice", entity.as_str());
        }
    }

    #[test]
    fn unscaling_is_the_exact_inverse_of_scaling_at_every_scale() {
        for (text, places) in [
            ("-12.34", 2), ("0.00", 2), ("1234567.89", 2), ("-0.01", 2),
            ("0.00000001", 8), ("12.34500000", 8), ("1.0000000001", 10),
            ("80.00", 2),
        ] {
            let units = scale(text, places).expect("the fixture is a legal decimal");
            assert_eq!(unscale(units, places), text, "round trip of {text} at scale {places}");
        }
    }

    #[test]
    fn money_leaves_the_collector_spelled_exactly_as_money_spells_itself() {
        // The two-place case has a second author — `crate::money` — and a file
        // whose amounts were spelled differently from every other answer this
        // crate gives would be a second money format.
        for minor in [-7_010_i64, 0, 1, -1, 25_050, i64::MIN] {
            assert_eq!(
                unscale(minor, 2),
                crate::money::hundredths_to_decimal_string(minor),
                "{minor} minor units"
            );
        }
    }

    #[test]
    fn a_scale_of_zero_is_the_integer_itself() {
        // `originalCurrency` rides the promoted list with places = 0 because it
        // is not a figure at all; the guard is what keeps it out of the decimal
        // path.
        assert_eq!(unscale(42, 0), "42");
    }

    #[test]
    fn an_unknown_entity_refuses_by_the_rpcs_own_name() {
        let error = Entity::parse("not_a_table").expect_err("unknown");
        assert_eq!(error.code(), "restore_entity_unknown");
        assert!(error.to_string().contains("not_a_table"), "{error}");
    }
}
