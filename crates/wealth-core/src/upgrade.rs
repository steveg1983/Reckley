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
//! Applied inside one transaction, the version stamped as its last statement
//! — so a crash mid-step leaves the file at the version it was, with nothing
//! half-done, and the next open does it again. SQLite can `ADD COLUMN` but
//! cannot add or change a CHECK, so a change that touches one REBUILDS the
//! table by the documented twelve-step procedure: foreign keys off (outside
//! the transaction, where the pragma takes), the new table made under a
//! temporary name, the rows copied, the old table dropped, the new one
//! renamed, the indexes remade, `foreign_key_check` run before the commit,
//! foreign keys back on and READ BACK.
//!
//! The new table's DDL is lifted from `schema.sql` itself rather than copied
//! here, for the reason [`crate::SCHEMA_SQL`] gives about copies: a rebuild
//! that drifted from the schema would make an upgraded file differ from a new
//! one in a way nothing would report. And because the rebuild always makes the
//! CURRENT shape, a file is brought from whatever version it is to the current
//! one in ONE rebuild. Which columns it copies is read off the two tables
//! (`pragma_table_info`), not off a per-version list: every column the old
//! table has that the new one keeps is copied under its name, a column the
//! old table lacks is left to its default, and a column whose MEANING moved
//! is translated by name — today the one such is the old `rollover` flag
//! becoming the `rollover_mode` word. The second change (version 2, the same
//! day as the first) made that the rule rather than a chain of per-version
//! steps, each of which would have had to know the DDL of a shape that no
//! longer exists, and would have refused a file that was merely stamped low.
//!
//! # The versions
//!
//! * **0 → 1** (7 Nov 2026): `repeat_count`, `repeat_unit`,
//!   `budgets_repeat_check` — the owner's "any repeat interval".
//! * **1 → 2** (7 Nov 2026): `rollover_mode` with `budgets_rollover_check`, in
//!   place of `rollover` and `rollover_amount_minor` — the owner's "rollover
//!   modes". A row that was carrying under the old flag is read as carrying its
//!   surplus, which is the one thing the old fold carried by default; the
//!   stored amount is let go, because the app derives the carry now
//!   (`utils/budgetEvaluation`) and the stored figure was already stale.
//! * **2 → 3** (7 Nov 2026, again): `pace_shape` with `budgets_pace_check` —
//!   the owner's "pace shape". A column the old table lacks, left to its
//!   default by the introspecting copy; nothing is translated.
//! * **3 → 4** (7 Nov 2026, once more): `rollover_to` with
//!   `budgets_rollover_to_check` — where a surplus goes. Nullable, left NULL
//!   by the copy; nothing is translated.

use rusqlite::Connection;

use crate::error::{CoreError, CoreResult};

/// The version `schema.sql` stamps into a file it makes, and the one this
/// build upgrades to. Raised in the same commit as the change it names.
pub const SCHEMA_VERSION: i64 = 4;

/// The columns whose meaning moved between versions: the new column, the old
/// one it is read from, and the expression that reads it. Today the one such
/// is the old `rollover` flag as the word it meant — a row carrying under the
/// old fold carried its surplus; version 2 has the word itself.
const TRANSLATED_COLUMNS: &[(&str, &str, &str)] = &[(
    "rollover_mode",
    "rollover",
    "CASE WHEN rollover <> 0 THEN 'surplus' ELSE 'none' END",
)];

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
    if file_version(&transaction)? < SCHEMA_VERSION {
        rebuild_budgets(&transaction)?;
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

/// The budgets table rebuilt to the current `schema.sql` shape, its rows
/// copied, its index remade — inside the caller's transaction.
///
/// The new table is made first so its columns can be READ beside the old
/// one's: a column both have is copied under its name; one only the new table
/// has is left to its default (the interval pair's NULLs are what
/// `budgets_repeat_check` requires of every row that is not `every`, and no
/// older row is); one named in [`TRANSLATED_COLUMNS`] is read through its
/// expression when the old table has the column it reads from.
fn rebuild_budgets(transaction: &rusqlite::Transaction<'_>) -> CoreResult<()> {
    let create = schema_statement("CREATE TABLE budgets (", ") STRICT;")?
        .replacen("CREATE TABLE budgets (", "CREATE TABLE budgets_rebuilt (", 1);
    transaction.execute_batch(&create)?;

    let old_columns = column_names(transaction, "budgets")?;
    let mut into = Vec::new();
    let mut from = Vec::new();
    for column in column_names(transaction, "budgets_rebuilt")? {
        if old_columns.contains(&column) {
            into.push(column.clone());
            from.push(column);
        } else if let Some((_, _, expression)) = TRANSLATED_COLUMNS
            .iter()
            .find(|(new, source, _)| *new == column && old_columns.iter().any(|old| old == source))
        {
            into.push(column);
            from.push((*expression).to_owned());
        }
    }

    let index = schema_statement("CREATE INDEX idx_budgets_user ON budgets(", ";")?;
    transaction.execute_batch(&format!(
        "INSERT INTO budgets_rebuilt ({})\n\
           SELECT {} FROM budgets;\n\
         DROP TABLE budgets;\n\
         ALTER TABLE budgets_rebuilt RENAME TO budgets;\n\
         {index}",
        into.join(", "),
        from.join(", "),
    ))?;
    Ok(())
}

/// A table's column names, in declared order, off the file itself.
fn column_names(transaction: &rusqlite::Transaction<'_>, table: &str) -> CoreResult<Vec<String>> {
    let mut statement = transaction.prepare("SELECT name FROM pragma_table_info(?1)")?;
    let names = statement
        .query_map([table], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(names)
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

    /// A version-1 budgets table: what `schema.sql` had between the two
    /// changes of 7 Nov 2026 — the interval pair and its CHECKs, and still the
    /// old rollover flag and amount.
    const BUDGETS_V1: &str = "CREATE TABLE budgets_v1 (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      amount_minor  INTEGER NOT NULL,
      period        TEXT NOT NULL CHECK (period IN ('weekly','biweekly','monthly','quarterly','yearly','custom','every')),
      repeat_count  INTEGER,
      repeat_unit   TEXT,
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
      CONSTRAINT budgets_period_ordered CHECK (end_date IS NULL OR end_date >= start_date),
      CONSTRAINT budgets_repeat_check CHECK (
        (period = 'every' AND repeat_count IS NOT NULL AND repeat_count >= 1
          AND repeat_unit IS NOT NULL AND repeat_unit IN ('week','month'))
        OR (period <> 'every' AND repeat_count IS NULL AND repeat_unit IS NULL))
    ) STRICT;";

    const OWNER: &str = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

    /// A file exactly as an earlier build would have left it: the current
    /// schema with its budgets table swapped for the given version's, two
    /// budgets in it — one carrying under the old flag, one not — and the
    /// version stamped (0 is what a file made before any stamp reads).
    fn an_older_file(path: &std::path::Path, version: i64) {
        let (ddl, temp, extra_columns, extra_values) = if version == 0 {
            (BUDGETS_V0, "budgets_v0", "", "")
        } else {
            (BUDGETS_V1, "budgets_v1", ", repeat_count, repeat_unit", ", 2, 'month'")
        };
        let connection = Connection::open(path).unwrap();
        crate::db::configure(&connection).unwrap();
        crate::apply_schema(&connection).unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = OFF")
            .unwrap();
        connection
            .execute_batch(&format!(
                "BEGIN;
                 {ddl}
                 DROP TABLE budgets;
                 ALTER TABLE {temp} RENAME TO budgets;
                 CREATE INDEX idx_budgets_user ON budgets(user_id);
                 INSERT INTO users (id, email) VALUES ('{OWNER}', 'device@local');
                 INSERT INTO budgets (id, user_id, name, amount_minor, period, start_date, notes)
                   VALUES ('b-1', '{OWNER}', 'Food', 7010, 'monthly', '2026-01-01', 'kept');
                 INSERT INTO budgets (id, user_id, name, amount_minor, period, start_date, rollover, rollover_amount_minor{extra_columns})
                   VALUES ('b-carry', '{OWNER}', 'Fuel', 5000, '{period}', '2026-01-01', 1, 1234{extra_values});
                 PRAGMA user_version = {version};
                 COMMIT;",
                period = if version == 0 { "monthly" } else { "every" },
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
        assert!(columns_of(&connection, "budgets").iter().any(|c| c == "rollover_mode"));
    }

    #[test]
    fn a_version_zero_file_is_rebuilt_with_its_budgets_kept_and_the_new_rule_enforced() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("v0.db");
        an_older_file(&path, 0);

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

        // The rows survived, whole, with the new pair at NULL; the old flag
        // became the word it meant, and the old amount is gone with its column.
        let (name, period, count, unit, mode, notes): (String, String, Option<i64>, Option<String>, String, String) =
            connection
                .query_row(
                    "SELECT name, period, repeat_count, repeat_unit, rollover_mode, notes FROM budgets WHERE id = 'b-1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
                )
                .unwrap();
        assert_eq!(
            (name.as_str(), period.as_str(), count, unit, mode.as_str(), notes.as_str()),
            ("Food", "monthly", None, None, "none", "kept")
        );
        let carried: String = connection
            .query_row("SELECT rollover_mode FROM budgets WHERE id = 'b-carry'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(carried, "surplus");
        assert!(!columns_of(&connection, "budgets").iter().any(|c| c == "rollover_amount_minor"));

        // The rollover rule is live: a word outside the four is refused.
        let refused = connection.execute(
            "INSERT INTO budgets (id, user_id, name, amount_minor, period, start_date, rollover_mode)
             VALUES ('b-5', ?1, 'Old fold', 100, 'monthly', '2026-11-01', 'all')",
            [OWNER],
        );
        assert!(refused.unwrap_err().to_string().contains("budgets_rollover_check"));

        // The interval rule is live: 'every' needs its pair, a named rhythm may not have one.
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
    fn a_version_one_file_keeps_its_interval_and_gains_the_mode() {
        // The second change of the day: a file made between the two carries
        // the pair already and must keep it, while its flag becomes a word.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("v1.db");
        an_older_file(&path, 1);

        let mut connection = crate::db::open(&path).unwrap();
        assert_eq!(file_version(&connection).unwrap(), 1);
        assert!(columns_of(&connection, "budgets").iter().any(|c| c == "rollover_amount_minor"));

        assert_eq!(upgrade_schema(&mut connection).unwrap(), SCHEMA_VERSION);

        let fresh = crate::db::open_in_memory().unwrap();
        crate::apply_schema(&fresh).unwrap();
        assert_eq!(columns_of(&connection, "budgets"), columns_of(&fresh, "budgets"));

        let (period, count, unit, mode): (String, Option<i64>, Option<String>, String) = connection
            .query_row(
                "SELECT period, repeat_count, repeat_unit, rollover_mode FROM budgets WHERE id = 'b-carry'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!((period.as_str(), count, unit.as_deref(), mode.as_str()), ("every", Some(2), Some("month"), "surplus"));
        let plain: String = connection
            .query_row("SELECT rollover_mode FROM budgets WHERE id = 'b-1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(plain, "none");
        assert_eq!(upgrade_schema(&mut connection).unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn a_current_file_merely_stamped_low_is_rebuilt_onto_itself_and_loses_nothing() {
        // The desktop shell's own test makes an "old" file this way, and a
        // backup restored into a fresh file could be stamped before its
        // tables are: every column is copied under its name, nothing is
        // translated, and the row comes through whole.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("stamped.db");
        let connection = Connection::open(&path).unwrap();
        crate::db::configure(&connection).unwrap();
        crate::apply_schema(&connection).unwrap();
        connection
            .execute_batch(&format!(
                "INSERT INTO users (id, email) VALUES ('{OWNER}', 'device@local');
                 INSERT INTO budgets (id, user_id, name, amount_minor, period, repeat_count, repeat_unit, start_date, rollover_mode)
                   VALUES ('b-6', '{OWNER}', 'Both', 100, 'every', 3, 'week', '2026-11-01', 'both');
                 PRAGMA user_version = 0;"
            ))
            .unwrap();
        drop(connection);

        let mut connection = crate::db::open(&path).unwrap();
        assert_eq!(upgrade_schema(&mut connection).unwrap(), SCHEMA_VERSION);
        let (count, unit, mode): (Option<i64>, Option<String>, String) = connection
            .query_row(
                "SELECT repeat_count, repeat_unit, rollover_mode FROM budgets WHERE id = 'b-6'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((count, unit.as_deref(), mode.as_str()), (Some(3), Some("week"), "both"));
    }

    #[test]
    fn a_version_two_file_gains_the_pace_shape_at_its_default_and_keeps_its_mode() {
        // Version 2 is the current shape less `pace_shape`: made here by
        // stamping a current file low and dropping the column (which no CHECK
        // but its own names, so SQLite allows it). The copy leaves the new
        // column to its default and copies everything else by name.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("v2.db");
        let connection = Connection::open(&path).unwrap();
        crate::db::configure(&connection).unwrap();
        crate::apply_schema(&connection).unwrap();
        connection
            .execute_batch(&format!(
                "INSERT INTO users (id, email) VALUES ('{OWNER}', 'device@local');
                 INSERT INTO budgets (id, user_id, name, amount_minor, period, start_date, rollover_mode)
                   VALUES ('b-7', '{OWNER}', 'Insurance', 100, 'yearly', '2026-04-06', 'surplus');
                 ALTER TABLE budgets DROP COLUMN pace_shape;
                 PRAGMA user_version = 2;"
            ))
            .unwrap();
        drop(connection);

        let mut connection = crate::db::open(&path).unwrap();
        assert_eq!(file_version(&connection).unwrap(), 2);
        assert!(!columns_of(&connection, "budgets").iter().any(|c| c == "pace_shape"));
        assert_eq!(upgrade_schema(&mut connection).unwrap(), SCHEMA_VERSION);

        let (mode, shape): (String, String) = connection
            .query_row("SELECT rollover_mode, pace_shape FROM budgets WHERE id = 'b-7'", [], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        assert_eq!((mode.as_str(), shape.as_str()), ("surplus", "even"));
        let refused = connection.execute(
            "INSERT INTO budgets (id, user_id, name, amount_minor, period, start_date, pace_shape)
             VALUES ('b-8', ?1, 'Lumpy', 100, 'monthly', '2026-11-01', 'lump')",
            [OWNER],
        );
        assert!(refused.unwrap_err().to_string().contains("budgets_pace_check"));
    }

    #[test]
    fn a_version_three_file_gains_where_a_surplus_goes_at_null_and_the_rule_is_live() {
        // `rollover_to` is named by a TABLE constraint, which SQLite will not
        // DROP COLUMN out from under — so the version-3 shape is stood in for
        // by the current one stamped 3: the copy by name is the same copy,
        // and what the test is about is the column's NULL and the rule.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("v3.db");
        let connection = Connection::open(&path).unwrap();
        crate::db::configure(&connection).unwrap();
        crate::apply_schema(&connection).unwrap();
        connection
            .execute_batch(&format!(
                "INSERT INTO users (id, email) VALUES ('{OWNER}', 'device@local');
                 INSERT INTO budgets (id, user_id, name, amount_minor, period, start_date, rollover_mode)
                   VALUES ('b-9', '{OWNER}', 'Groceries', 50000, 'monthly', '2026-11-01', 'surplus');
                 PRAGMA user_version = 3;"
            ))
            .unwrap();
        drop(connection);

        let mut connection = crate::db::open(&path).unwrap();
        assert_eq!(file_version(&connection).unwrap(), 3);
        assert_eq!(upgrade_schema(&mut connection).unwrap(), SCHEMA_VERSION);
        let target: Option<String> = connection
            .query_row("SELECT rollover_to FROM budgets WHERE id = 'b-9'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(target, None);

        // Not itself; and only a mode that carries a surplus.
        let refused = connection.execute("UPDATE budgets SET rollover_to = 'b-9' WHERE id = 'b-9'", []);
        assert!(refused.unwrap_err().to_string().contains("budgets_rollover_to_check"));
        let refused = connection.execute(
            "UPDATE budgets SET rollover_mode = 'none', rollover_to = 'b-elsewhere' WHERE id = 'b-9'",
            [],
        );
        assert!(refused.unwrap_err().to_string().contains("budgets_rollover_to_check"));
        // A plain id: a budget that is not there is accepted by the table and read as "keep" by the app.
        connection
            .execute("UPDATE budgets SET rollover_to = 'b-elsewhere' WHERE id = 'b-9'", [])
            .unwrap();
    }

    #[test]
    fn a_failed_step_leaves_the_file_at_the_version_it_was() {
        // A version-0 file whose budgets table is GONE: the rebuild's copy
        // cannot run, the transaction rolls back, and the version stays 0 —
        // nothing half-done, and the next open tries again.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("broken.db");
        an_older_file(&path, 0);
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
