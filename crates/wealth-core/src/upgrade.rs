//! The ledger file's schema version, and the upgrade from each version to the
//! next.
//!
//! # Why this exists
//!
//! A ledger gets its schema on the day it is created and never again:
//! [`crate::apply_schema`] runs `schema.sql` on a fresh file, and opening an
//! existing one applies nothing. Until 7 Nov 2026 that was enough, because the
//! schema had never changed since the desktop shipped. The budgets table then
//! gained two columns and a CHECK (`repeat_count`, `repeat_unit`,
//! `budgets_repeat_check` — the owner's "any repeat interval"), and every file
//! made by 0.1.6 or earlier would have failed its first budget read. This is
//! the mechanism that was always going to be needed, built for the first
//! change that needed it.
//!
//! # The version
//!
//! `PRAGMA user_version`, an integer in the file header. `schema.sql` stamps
//! [`SCHEMA_VERSION`] into every file it makes; a file made before any stamp
//! reads 0, which is exactly "every file before 7 Nov 2026". The
//! `schema_meta.schema_version` row the schema's section 0 documents was never
//! written by anything, so it is not what this reads — a pragma needs no table
//! to be right about.
//!
//! # The upgrade
//!
//! One step per version, each applied inside one transaction, the version
//! stamped as its last statement — so a crash mid-step leaves the file at the
//! version it was, with nothing half-done, and the next open does it again.
//! SQLite can `ADD COLUMN` but cannot add or change a CHECK, so a step that
//! changes one REBUILDS the table by the documented twelve-step procedure:
//! foreign keys off (outside the transaction, where the pragma takes), the
//! new table made under a temporary name, the rows copied, the old table
//! dropped, the new one renamed, the indexes remade, `foreign_key_check` run
//! before the commit, foreign keys back on and READ BACK.
//!
//! The new table's DDL is lifted from `schema.sql` itself rather than copied
//! here, for the reason [`crate::SCHEMA_SQL`] gives about copies: a rebuild
//! that drifted from the schema would make an upgraded file differ from a new
//! one in a way nothing would report.

use rusqlite::Connection;

use crate::error::{CoreError, CoreResult};

/// The version `schema.sql` stamps into a file it makes, and the one this
/// build upgrades to. Raised in the same commit as the change it names.
pub const SCHEMA_VERSION: i64 = 1;

/// The eighteen columns every version-0 budgets table has, in the order the
/// rebuild copies them. The two the rebuild adds are left to their NULLs —
/// which is what `budgets_repeat_check` requires of every row that is not
/// `every`, and no version-0 row is.
const BUDGET_V0_COLUMNS: &str = "id, user_id, name, amount_minor, period, category, category_id, \
     start_date, end_date, spent_minor, rollover, rollover_amount_minor, alert_threshold_bp, \
     is_active, notes, metadata, created_at, updated_at";

/// The file's schema version — 0 for a file made before any stamp.
///
/// # Errors
/// [`CoreError::Storage`] if the pragma cannot be read.
pub fn file_version(connection: &Connection) -> CoreResult<i64> {
    Ok(connection.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

/// Bring a file to [`SCHEMA_VERSION`], one step at a time; a file already
/// there is left exactly as it was. Answers the version the file is now at.
///
/// # Errors
/// [`CoreError::Storage`] if a step fails — the file is then at the version
/// it was, and nothing in it changed.
pub fn upgrade_schema(connection: &mut Connection) -> CoreResult<i64> {
    let before = file_version(connection)?;
    if before >= SCHEMA_VERSION {
        return Ok(before);
    }

    // Off OUTSIDE the transaction: inside one the pragma is a silent no-op,
    // which is the failure `db::configure` exists to catch.
    connection.pragma_update(None, "foreign_keys", false)?;
    let stepped = step_to_current(connection);
    let restored = connection.pragma_update(None, "foreign_keys", true);
    stepped?;
    restored?;
    let enforced: i64 = connection.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
    if enforced != 1 {
        return Err(fault(
            "PRAGMA foreign_keys did not come back on after the schema upgrade. Every ON DELETE \
             SET NULL in the schema would be inert; refusing to continue on this connection.",
        ));
    }
    file_version(connection)
}

/// Every step from the file's version to the current one, in one transaction.
fn step_to_current(connection: &mut Connection) -> CoreResult<()> {
    let transaction = connection.transaction()?;
    if file_version(&transaction)? < 1 {
        transaction.execute_batch(&budgets_rebuild_sql()?)?;
    }
    let violations: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM pragma_foreign_key_check",
        [],
        |row| row.get(0),
    )?;
    if violations > 0 {
        return Err(fault(&format!(
            "the schema upgrade left {violations} foreign-key violation(s); rolled back"
        )));
    }
    transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    transaction.commit()?;
    Ok(())
}

/// Version 0 → 1: the budgets table rebuilt to the current `schema.sql`
/// shape, its rows copied, its index remade.
fn budgets_rebuild_sql() -> CoreResult<String> {
    let create = schema_statement("CREATE TABLE budgets (", ") STRICT;")?
        .replacen("CREATE TABLE budgets (", "CREATE TABLE budgets_v1 (", 1);
    let index = schema_statement("CREATE INDEX idx_budgets_user ON budgets(", ";")?;
    Ok(format!(
        "{create}\n\
         INSERT INTO budgets_v1 ({BUDGET_V0_COLUMNS})\n\
           SELECT {BUDGET_V0_COLUMNS} FROM budgets;\n\
         DROP TABLE budgets;\n\
         ALTER TABLE budgets_v1 RENAME TO budgets;\n\
         {index}"
    ))
}

/// One statement of `schema.sql`, from its opening text to and including the
/// first `terminator` after it. A schema that no longer contains the opening
/// is a fault, not a silent empty rebuild.
fn schema_statement(opening: &str, terminator: &str) -> CoreResult<String> {
    let start = crate::SCHEMA_SQL
        .find(opening)
        .ok_or_else(|| fault(&format!("schema.sql no longer contains {opening:?}")))?;
    let rest = &crate::SCHEMA_SQL[start..];
    let end = rest
        .find(terminator)
        .and_then(|at| at.checked_add(terminator.len()))
        .ok_or_else(|| fault(&format!("schema.sql's {opening:?} has no {terminator:?}")))?;
    Ok(rest[..end].to_owned())
}

fn fault(message: &str) -> CoreError {
    CoreError::Storage(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_MISUSE),
        Some(message.to_owned()),
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::{file_version, upgrade_schema, SCHEMA_VERSION};
    use rusqlite::Connection;

    /// A version-0 budgets table: the DDL every file before 7 Nov 2026 holds,
    /// kept here as the fixture of the shape the upgrade must read. Column by
    /// column what `schema.sql` had on 6 Nov 2026 — no `repeat_count`, no
    /// `repeat_unit`, no `budgets_repeat_check`, and no `every` in the list.
    const BUDGETS_V0: &str = "CREATE TABLE budgets_v0 (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      amount_minor  INTEGER NOT NULL,
      period        TEXT NOT NULL CHECK (period IN ('weekly','biweekly','monthly','quarterly','yearly','custom')),
      category      TEXT,
      category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
      start_date    TEXT NOT NULL CHECK (start_date LIKE '____-__-__'),
      end_date      TEXT CHECK (end_date IS NULL OR end_date LIKE '____-__-__'),
      spent_minor           INTEGER NOT NULL DEFAULT 0,
      rollover              INTEGER NOT NULL DEFAULT 0 CHECK (rollover IN (0,1)),
      rollover_amount_minor INTEGER NOT NULL DEFAULT 0,
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
      CONSTRAINT budgets_period_ordered CHECK (end_date IS NULL OR end_date >= start_date)
    ) STRICT;";

    const OWNER: &str = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

    /// A file exactly as 0.1.6 would have left it: the current schema with its
    /// budgets table swapped for the version-0 one, a budget in it, and no
    /// version stamp.
    fn a_version_zero_file(path: &std::path::Path) {
        let connection = Connection::open(path).unwrap();
        crate::db::configure(&connection).unwrap();
        crate::apply_schema(&connection).unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = OFF")
            .unwrap();
        connection
            .execute_batch(&format!(
                "BEGIN;
                 {BUDGETS_V0}
                 DROP TABLE budgets;
                 ALTER TABLE budgets_v0 RENAME TO budgets;
                 CREATE INDEX idx_budgets_user ON budgets(user_id);
                 INSERT INTO users (id, email) VALUES ('{OWNER}', 'device@local');
                 INSERT INTO budgets (id, user_id, name, amount_minor, period, start_date, notes)
                   VALUES ('b-1', '{OWNER}', 'Food', 7010, 'monthly', '2026-01-01', 'kept');
                 PRAGMA user_version = 0;
                 COMMIT;"
            ))
            .unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON")
            .unwrap();
    }

    fn columns_of(connection: &Connection, table: &str) -> Vec<String> {
        let mut statement = connection
            .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
            .unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn a_file_the_schema_makes_is_already_at_the_current_version_and_is_left_alone() {
        let mut connection = crate::db::open_in_memory().unwrap();
        crate::apply_schema(&connection).unwrap();
        assert_eq!(file_version(&connection).unwrap(), SCHEMA_VERSION);

        let after = upgrade_schema(&mut connection).unwrap();
        assert_eq!(after, SCHEMA_VERSION);
        assert!(columns_of(&connection, "budgets").iter().any(|c| c == "repeat_count"));
    }

    #[test]
    fn a_version_zero_file_is_rebuilt_with_its_budgets_kept_and_the_new_rule_enforced() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("v0.db");
        a_version_zero_file(&path);

        let mut connection = crate::db::open(&path).unwrap();
        assert_eq!(file_version(&connection).unwrap(), 0);
        assert!(!columns_of(&connection, "budgets").iter().any(|c| c == "repeat_count"));

        assert_eq!(upgrade_schema(&mut connection).unwrap(), SCHEMA_VERSION);

        // The shape is the current schema's, column for column.
        let fresh = crate::db::open_in_memory().unwrap();
        crate::apply_schema(&fresh).unwrap();
        assert_eq!(columns_of(&connection, "budgets"), columns_of(&fresh, "budgets"));
        // The index came back under its name.
        let index: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_budgets_user'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index, 1);

        // The row survived, whole, with the new pair at NULL.
        let (name, period, count, unit, notes): (String, String, Option<i64>, Option<String>, String) =
            connection
                .query_row(
                    "SELECT name, period, repeat_count, repeat_unit, notes FROM budgets WHERE id = 'b-1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
                )
                .unwrap();
        assert_eq!((name.as_str(), period.as_str(), count, unit, notes.as_str()), ("Food", "monthly", None, None, "kept"));

        // The new rule is live: 'every' needs its pair, a named rhythm may not have one.
        let refused = connection.execute(
            "INSERT INTO budgets (id, user_id, name, amount_minor, period, start_date)
             VALUES ('b-2', ?1, 'No pair', 100, 'every', '2026-11-01')",
            [OWNER],
        );
        assert!(refused.unwrap_err().to_string().contains("budgets_repeat_check"));
        let refused = connection.execute(
            "INSERT INTO budgets (id, user_id, name, amount_minor, period, repeat_count, repeat_unit, start_date)
             VALUES ('b-3', ?1, 'Pair on monthly', 100, 'monthly', 2, 'month', '2026-11-01')",
            [OWNER],
        );
        assert!(refused.unwrap_err().to_string().contains("budgets_repeat_check"));
        connection
            .execute(
                "INSERT INTO budgets (id, user_id, name, amount_minor, period, repeat_count, repeat_unit, start_date)
                 VALUES ('b-4', ?1, 'Every 2 months', 100, 'every', 2, 'month', '2026-11-01')",
                [OWNER],
            )
            .unwrap();

        // Foreign keys are back on, and read back as such.
        let enforced: i64 = connection
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert_eq!(enforced, 1);
        // And a second open does nothing further.
        assert_eq!(upgrade_schema(&mut connection).unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn a_failed_step_leaves_the_file_at_the_version_it_was() {
        // A version-0 file whose budgets table is GONE: the rebuild's copy
        // cannot run, the transaction rolls back, and the version stays 0 —
        // nothing half-done, and the next open tries again.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("broken.db");
        a_version_zero_file(&path);
        let mut connection = crate::db::open(&path).unwrap();
        connection.execute_batch("DROP TABLE budgets").unwrap();

        assert!(upgrade_schema(&mut connection).is_err());
        assert_eq!(file_version(&connection).unwrap(), 0);
        let enforced: i64 = connection
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert_eq!(enforced, 1);
    }
}
