//! Opening a ledger, making one, and working out whose it is.
//!
//! # `create_file` and `open_file` are COMMANDS, not verbs (PHASE3-PLAN D-5)
//!
//! Slice 18 left this open — the seam's header said the two were *"the desktop
//! shell's … slice 27"* without saying which surface they belong to — and there
//! are three reasons they are the shell's own commands rather than variants of
//! `wealth_core::command::Command`. Any one of them would be enough.
//!
//! **A path is not a payload.** `dispatch` deserialises a caller's JSON, and the
//! caller is a WebView. The entire argument for the ledger crate existing is
//! that the WebView is the part of this program most likely to be reached by an
//! extension, a malformed import, or a dependency with a supply-chain problem
//! (`lib.rs`: *"putting them in a WebView that … can reach"*). An
//! `{"verb":"open_file","payload":{"path":"…"}}` would hand that WebView the
//! ability to name any file on the disk — to open somebody's browser history or
//! their messaging database, both of which are SQLite, and to create a file
//! anywhere it can write. A path therefore never crosses the invoke boundary in
//! that direction: the renderer asks to open A ledger, the SHELL shows the
//! platform's own chooser, and the user's choice is the only path that exists.
//!
//! **There is no connection to dispatch over.** `dispatch(&mut Connection, …)`
//! takes an already-open ledger. A verb that OPENS one has nothing to be
//! dispatched against — it is what makes the argument the others need. The
//! crate already has a family in that shape, the `plan_*` admission commands,
//! and it answers them in `plan()` before a file is touched; a file verb is the
//! same observation from the other end.
//!
//! **It would be state in a crate that deliberately has none.** Which document
//! is open, and which locks are held, are properties of a running application.
//! `wealth-core` holds no globals and no session; keeping it that way is what
//! lets the differential harness run it as a process per call.
//!
//! R-10 is untouched by this. The rule is that the VERB SET has one exhaustive
//! match, and these are not verbs — there is no second dispatch, no `match` over
//! a string, and nothing here that a `Command` could ever also mean.
//!
//! # Whose rows are these? (PHASE3-PLAN D-5)
//!
//! `localDataPort.ts` states the rule and leaves the resolution here: *"the
//! owner of a local file is a uuid minted when the FILE is created, stored in
//! its one `users` row"*, and the port is CONSTRUCTED with it — never told one
//! per call.
//!
//! So [`create`] mints a v4 uuid and writes that row, and [`open`] reads it
//! back. What makes this more than one line is the cases where a file does not
//! have exactly one:
//!
//! * **no rows at all.** A real file: `wealth-core-cli --apply-schema` makes one
//!   (MEASURED — the harness's `LedgerFiles.create` produces exactly this), and
//!   so does any tool that applies the schema without adopting the result. It is
//!   a valid, empty, ownerless ledger and it is refused BY NAME, because the
//!   alternative is a window full of nothing that looks exactly like a new file.
//! * **more than one.** `schema.sql` says the table is *"kept for parity with
//!   the cloud … A local file holds exactly one row in practice; nothing here
//!   enforces that, because a future 'household' file may hold more"*. Until
//!   there is a screen that asks which person you are, picking one would be
//!   picking somebody's finances at random. Refused, with both ids named.
//!
//! Neither case can be produced by this shell. They are the two ways a file can
//! arrive from somewhere else, and a shell that only handled the files it wrote
//! itself would be a shell that opens other people's files wrongly.
//!
//! # What is deliberately NOT written into a new file
//!
//! `schema_meta`. The schema creates it and documents the rows it is for
//! (`schema_version`, `created_at`, the four scales) and nothing in either
//! engine has ever written one — verified by grep across the crate and the
//! harness before this file was written. A version stamp that nothing compares
//! is a version stamp nobody can trust, and the moment it earns its write is the
//! moment something opens a file it did not create and has to decide whether it
//! can. That is the migration slice's decision to make, with the reader in front
//! of it; writing the row now would present a future reader with a value that
//! had never been checked against anything.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;
use wealth_core::db;

use crate::lock::{LedgerLock, LockRefused};

/// The one login row a device file has, as the shell writes it.
///
/// `email` is NOT NULL and a device has no email address, so it is a stated
/// non-address rather than a blank — the same string, for the same reason, that
/// the contract harness writes in `localCore.fixtureFile.ts`.
const DEVICE_EMAIL: &str = "device@localhost";

/// An open ledger: the connection, whose it is, and the claim that keeps it
/// this window's.
#[derive(Debug)]
pub struct Document {
    /// Where it is on disk. Shown to the person, never sent by the renderer.
    pub path: PathBuf,
    /// The uuid in the file's one `users` row.
    pub owner: String,
    /// The ONE connection. Behind `main.rs`'s mutex — the first of the two
    /// locks.
    pub connection: Connection,
    /// The second. Dropped with this value, and only with it.
    _claim: LedgerLock,
}

/// What the renderer is told about the document it now has.
///
/// The path is in it because a person needs to see which ledger they are
/// looking at, and the owner because the port is constructed with one.
#[derive(Debug, Serialize)]
pub struct OpenLedger {
    pub path: String,
    pub owner: String,
}

impl Document {
    #[must_use]
    pub fn describe(&self) -> OpenLedger {
        OpenLedger {
            path: self.path.display().to_string(),
            owner: self.owner.clone(),
        }
    }
}

/// Open a ledger that already exists.
///
/// The order is load-bearing: CLAIM, then open. A lock taken after a successful
/// open would leave a window in which two processes have both opened the file
/// and one of them is about to be told it may not — having already run
/// `db::open`'s PRAGMAs against it.
///
/// # Errors
/// A sentence for a person. Every failure here is a FAULT rather than a refusal
/// in the ledger's sense: nothing was asked of the ledger, so `respond`'s
/// envelope has nothing to say about it, and the shell shows it out by its own
/// door.
pub fn open(path: &Path) -> Result<Document, String> {
    if !path.exists() {
        return Err(format!(
            "There is no ledger at {}. It may have been moved, renamed, or be on a \
             drive that is not connected.",
            path.display()
        ));
    }

    let claim = LedgerLock::claim(path).map_err(|refused: LockRefused| refused.to_string())?;

    // `db::open` is the crate's, PRAGMAs and read-backs and all — including the
    // journal-mode assertion this slice added, which is the one check that is
    // about the FILE rather than about the connection.
    let mut connection = db::open(path).map_err(|error| {
        format!(
            "This file could not be opened as a ledger: {error}\n\nIf it is a \
             Reckley backup (.json) rather than a ledger (.db), restore it into a \
             new ledger instead."
        )
    })?;

    // A file made by an earlier schema is brought to this one's shape here,
    // before anything reads it — the only place an existing ledger is ever
    // ALTERed. See `wealth_core::upgrade`.
    wealth_core::upgrade::upgrade_schema(&mut connection).map_err(|error| {
        format!(
            "This ledger could not be brought up to date: {error}\n\nNothing in it was \
             changed. Keep the file; a later version of Reckley may open it."
        )
    })?;

    let owner = resolve_owner(&connection, path)?;

    Ok(Document {
        path: path.to_path_buf(),
        owner,
        connection,
        _claim: claim,
    })
}

/// Make a ledger, and mint the identity that owns it.
///
/// # Errors
/// As [`open`].
pub fn create(path: &Path) -> Result<Document, String> {
    // The chooser's own overwrite prompt is about REPLACING a file, and this is
    // not that: a half-created ledger over somebody's existing one is the single
    // most expensive mistake this program could make. A save dialog that already
    // asked is asked again here, structurally, because the two questions are not
    // the same question.
    if path.exists() {
        return Err(format!(
            "{} already exists. Choose a name that is not in use — a new ledger is \
             never written over an existing file.",
            path.display()
        ));
    }

    let claim = LedgerLock::claim(path).map_err(|refused: LockRefused| refused.to_string())?;

    let connection = Connection::open(path)
        .map_err(|error| format!("This ledger could not be created: {error}"))?;
    db::configure(&connection).map_err(|error| format!("This ledger could not be prepared: {error}"))?;
    wealth_core::apply_schema(&connection)
        .map_err(|error| format!("The ledger schema could not be applied: {error}"))?;
    // The schema sets WAL as its first statement and the mode lives in the file
    // header. Asserted rather than assumed for `db::assert_journal_mode`'s
    // reason: a set without a read-back proves nothing, and a file that came out
    // of this function in the wrong mode would be one this program never opened
    // successfully again.
    db::assert_journal_mode(&connection)
        .map_err(|error| format!("This ledger was created in the wrong journal mode: {error}"))?;

    let owner = uuid::Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO users (id, email) VALUES (?1, ?2)",
            rusqlite::params![owner, DEVICE_EMAIL],
        )
        .map_err(|error| format!("This ledger could not be given an owner: {error}"))?;

    Ok(Document {
        path: path.to_path_buf(),
        owner,
        connection,
        _claim: claim,
    })
}

/// Whose rows a file holds. See this module's header for the two files that
/// have no answer.
fn resolve_owner(connection: &Connection, path: &Path) -> Result<String, String> {
    let mut statement = connection
        .prepare("SELECT id FROM users ORDER BY id")
        .map_err(|error| format!("This ledger's login could not be read: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("This ledger's login could not be read: {error}"))?;

    let mut owners = Vec::new();
    for row in rows {
        owners.push(row.map_err(|error| format!("This ledger's login could not be read: {error}"))?);
    }

    match owners.as_slice() {
        [only] => Ok(only.clone()),
        [] => Err(format!(
            "{} has the shape of a ledger but nobody owns it: its login row was never \
             written. A file made by applying the schema without opening it is like this. \
             Make a new ledger and restore a backup into it.",
            path.display()
        )),
        many => Err(format!(
            "{} holds {} logins ({}), and this window can only work on one person's money \
             at a time. Nothing has been opened.",
            path.display(),
            many.len(),
            many.join(", ")
        )),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::{create, open};

    /// A directory of this test's own. See `lock.rs`'s twin for why the name is
    /// a counter rather than a clock.
    fn temp_dir() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let base = std::env::temp_dir().join(format!(
            "wt-doc-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn a_new_ledger_has_the_schema_wal_and_exactly_one_owner() {
        let dir = temp_dir();
        let path = dir.join("new.db");

        let document = create(&path).expect("a new ledger");

        // A uuid v4, lower case, 36 characters — `schema.sql`'s CHECK on
        // users.id, and the shape `LocalDataPort`'s constructor demands before
        // it will answer anything.
        assert_eq!(document.owner.len(), 36);
        assert_eq!(document.owner, document.owner.to_lowercase());
        assert_eq!(document.owner.as_bytes()[14], b'4');

        let mode: String = document
            .connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");

        let count: i64 = document
            .connection
            .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn a_ledger_reopens_as_the_same_owner() {
        // The identity is the FILE'S, not the session's — which is what makes a
        // ledger's rows readable tomorrow.
        let dir = temp_dir();
        let path = dir.join("again.db");

        let minted = create(&path).expect("create").owner;
        // The first document goes out of scope, which is how its claim is
        // released. If it were not, this open would be refused.
        let reopened = open(&path).expect("open").owner;

        assert_eq!(minted, reopened);
    }

    #[test]
    fn opening_a_ledger_brings_it_to_the_current_schema_version() {
        // A file that reports version 0 is upgraded on open — the crate's own
        // tests prove the rebuild against the real version-0 shape; this proves
        // the shell's open is where it happens, and that a second open is a
        // no-op. The version is reset by hand here because `create` stamps it.
        let dir = temp_dir();
        let path = dir.join("old.db");
        let made = create(&path).expect("create");
        made.connection
            .execute_batch("PRAGMA user_version = 0")
            .unwrap();
        drop(made);

        let opened = open(&path).expect("open upgrades rather than refuses");
        let version: i64 = opened
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, wealth_core::upgrade::SCHEMA_VERSION);
        let enforced: i64 = opened
            .connection
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert_eq!(enforced, 1);
    }

    #[test]
    fn a_ledger_that_is_open_cannot_be_opened_again() {
        let dir = temp_dir();
        let path = dir.join("held.db");
        let held = create(&path).expect("create");

        let refused = open(&path).expect_err("a second window must be refused");
        assert!(refused.contains("already open"), "{refused}");
        drop(held);
    }

    #[test]
    fn a_schema_only_file_is_refused_by_name_rather_than_opened_empty() {
        // Exactly what `wealth-core-cli --apply-schema` produces, and what the
        // contract harness's `LedgerFiles.create` makes on every test.
        let dir = temp_dir();
        let path = dir.join("ownerless.db");
        let made = rusqlite::Connection::open(&path).unwrap();
        wealth_core::db::configure(&made).unwrap();
        wealth_core::apply_schema(&made).unwrap();
        drop(made);

        let refused = open(&path).expect_err("an ownerless ledger must be refused");
        assert!(refused.contains("nobody owns it"), "{refused}");
    }

    #[test]
    fn a_household_file_is_refused_with_both_logins_named() {
        let dir = temp_dir();
        let path = dir.join("household.db");
        let document = create(&path).expect("create");
        let second = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        document
            .connection
            .execute(
                "INSERT INTO users (id, email) VALUES (?1, 'other@localhost')",
                [second],
            )
            .unwrap();
        drop(document);

        let refused = open(&path).expect_err("two logins must be refused");
        assert!(refused.contains("holds 2 logins"), "{refused}");
        assert!(refused.contains(second), "{refused}");
    }

    #[test]
    fn a_new_ledger_is_never_written_over_an_existing_file() {
        let dir = temp_dir();
        let path = dir.join("precious.db");
        std::fs::write(&path, b"somebody's whole financial life").unwrap();

        let refused = create(&path).expect_err("an existing file must not be overwritten");
        assert!(refused.contains("already exists"), "{refused}");
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"somebody's whole financial life"
        );
    }

    #[test]
    fn a_file_that_is_not_a_ledger_says_so_and_points_at_the_restore() {
        let dir = temp_dir();
        let path = dir.join("backup.json");
        std::fs::write(&path, b"{\"format\":\"reckley-backup-v2\"}").unwrap();

        let refused = open(&path).expect_err("a backup file is not a ledger");
        assert!(refused.contains("could not be opened as a ledger"), "{refused}");
    }
}
