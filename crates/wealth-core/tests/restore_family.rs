//! Integration tests for the restore family, against the real vendored schema.
//!
//! The differential proof lives in `scripts/local-sqlite/verbs.mjs`: thirty-nine
//! specs running the same payload against the live Postgres RPCs and these verbs.
//! What is here is the half that has **no Postgres counterpart to compare
//! against**, and there are six kinds of it:
//!
//! 1. **The whole round trip.** Seed, snapshot, wipe, restore, snapshot again,
//!    compare. The cloud cannot be asked this question in one call — its restore
//!    is chunked across separate transactions and its wipe is a different request
//!    — so the one assertion that matters most to a person ("is my data the same
//!    afterwards?") can only be made here.
//! 2. **One transaction.** DESIGN.md §5 divergence 6. A multi-chunk restore is a
//!    local-only shape; the harness's Postgres driver refuses such a spec by name
//!    rather than comparing the wrong thing.
//! 3. **R-11 in anger.** The `transactions ↔ transaction_splits` cycle, closed in
//!    one COMMIT with no second pass. Postgres cannot do it at all, which is what
//!    `finalize_user_restore` exists for.
//! 4. **The guards, both halves.** That `_rpc_guard('leg')` is HELD across a wipe
//!    that touches a split leg (or the wipe is refused) and RELEASED before the
//!    call returns (or every later write in the file has S-9 and S-10 standing
//!    down). Both are claims about a SQLite trigger with no cloud twin.
//! 5. **The audit chain.** Whether the hashes actually chain across a wipe that
//!    writes one row per transaction and one per account. There is no cloud hash
//!    to compare to.
//! 6. **The column maps.** Fifteen entities, each with its own scale conversions.
//!    The differential specs exercise four of them; this exercises all fifteen,
//!    which is the only way a mapping typo in `investment_transactions` gets
//!    found before somebody's holdings do.
//!
//! All data is invented. This repo is public: no real payee, account number or
//! figure appears anywhere in it.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use rusqlite::Connection;
use serde_json::{json, Value};
use wealth_core::db;
use wealth_core::verbs::{
    finalize_user_restore, restore_user_chunk, user_financial_data_is_empty,
    wipe_user_financial_data, FinalizeUserRestore, RestoreUserChunk, UserFinancialDataIsEmpty,
    WipeUserFinancialData,
};

const OWNER: &str = "11111111-1111-1111-1111-111111111111";
const STRANGER: &str = "22222222-2222-2222-2222-222222222222";
const EVERYDAY: &str = "a0000000-0000-0000-0000-000000000001";
const RAINY_DAY: &str = "a0000000-0000-0000-0000-000000000002";
const TRANSFER_ROOT: &str = "c0000000-0000-0000-0000-000000000001";
const OUTGOINGS: &str = "c0000000-0000-0000-0000-000000000002";
const WEEKLY_SHOP: &str = "c0000000-0000-0000-0000-000000000003";
const TO_FROM_RAINY: &str = "c0000000-0000-0000-0000-0000000000fa";
const TO_FROM_EVERYDAY: &str = "c0000000-0000-0000-0000-0000000000fb";
const CORNER_SHOP: &str = "70000000-0000-0000-0000-000000000001";
const COUNTERPART: &str = "70000000-0000-0000-0000-000000000009";
const LEG_LINE: &str = "50000000-0000-0000-0000-000000000001";
const PLAIN_LINE: &str = "50000000-0000-0000-0000-000000000002";

/// An empty file with one login in it. Every test builds its own world on top.
fn blank() -> Connection {
    let connection = db::open_in_memory().expect("open");
    wealth_core::apply_schema(&connection).expect("schema");
    connection
        .execute_batch(&format!(
            "INSERT INTO users (id, email) VALUES ('{OWNER}', 'harness@example.test');
             INSERT INTO users (id, email) VALUES ('{STRANGER}', 'stranger@example.test');"
        ))
        .expect("users");
    connection
}

fn wipe(connection: &mut Connection) -> wealth_core::verbs::WipeUserFinancialDataResult {
    wipe_user_financial_data(
        connection,
        WipeUserFinancialData {
            confirm: Some("DELETE EVERYTHING".to_owned()),
            user_id: Some(OWNER.to_owned()),
        },
    )
    .expect("wipe")
}

fn restore(connection: &mut Connection, chunks: Value) -> wealth_core::verbs::RestoreUserChunkResult {
    let command: RestoreUserChunk =
        serde_json::from_value(json!({ "chunks": chunks, "user_id": OWNER })).expect("command");
    restore_user_chunk(connection, command).expect("restore")
}

/// One value, as text, whatever SQLite's affinity made of it.
///
/// A count comes back INTEGER and a `group_concat` comes back TEXT, so the read
/// has to go through the dynamic type or half the assertions in this file would
/// be about column affinity rather than about the ledger.
fn scalar(connection: &Connection, sql: &str) -> String {
    connection
        .query_row(sql, [], |row| row.get::<_, rusqlite::types::Value>(0))
        .map(|value| match value {
            rusqlite::types::Value::Null => "NULL".to_owned(),
            rusqlite::types::Value::Integer(number) => number.to_string(),
            rusqlite::types::Value::Real(number) => number.to_string(),
            rusqlite::types::Value::Text(text) => text,
            rusqlite::types::Value::Blob(_) => "BLOB".to_owned(),
        })
        .unwrap_or_else(|error| format!("ERROR {error}"))
}

// ── The dataset every round-trip test uses ──────────────────────────────────

/// Two accounts, a category tree, an ordinary expense, and a transfer whose far
/// side is a SPLIT LINE — the shape that exercises R-11, R-5 and the guard all
/// at once.
///
/// Balances are hand-maintained so B-1 holds before the wipe: Everyday is
/// −25.00 (one −25.00 split parent) and Rainy day is 15.00 (the counterpart).
fn seeded() -> Connection {
    let connection = blank();
    connection
        .execute_batch(&format!(
            "INSERT INTO categories (id, user_id, name, type, level) VALUES
               ('{TRANSFER_ROOT}', '{OWNER}', 'Transfer', 'both', 'type'),
               ('{OUTGOINGS}', '{OWNER}', 'Outgoings', 'expense', 'type');
             INSERT INTO categories (id, user_id, name, type, level, parent_id) VALUES
               ('{WEEKLY_SHOP}', '{OWNER}', 'Weekly shop', 'expense', 'sub', '{OUTGOINGS}');
             INSERT INTO accounts (id, user_id, name, type, balance_minor, initial_balance_minor,
                                   updated_at) VALUES
               ('{EVERYDAY}', '{OWNER}', 'Everyday', 'checking', -2500, 0, '2019-01-01T00:00:00.000Z'),
               ('{RAINY_DAY}', '{OWNER}', 'Rainy day', 'savings', 1500, 0, '2019-01-01T00:00:00.000Z');
             -- Both To/From rows are minted by C-3's trigger with generated ids.
             -- Renamed to ids the bundle below can name, which is the only way a
             -- round trip can be compared at all: a spec that could not predict
             -- them would have to exclude them from the snapshot, and they are
             -- exactly the rows the emptiness precondition exists to protect.
             UPDATE categories SET id = '{TO_FROM_RAINY}'
              WHERE account_id = '{RAINY_DAY}' AND is_transfer_category = 1;
             UPDATE categories SET id = '{TO_FROM_EVERYDAY}'
              WHERE account_id = '{EVERYDAY}' AND is_transfer_category = 1;
             INSERT INTO _rpc_guard VALUES ('split');
             INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                                       is_split, category, updated_at) VALUES
               ('{CORNER_SHOP}', '{OWNER}', '{EVERYDAY}', 'Corner shop', -2500, 'expense',
                '2019-05-04', 1, '', '2019-05-04T00:00:00.000Z');
             INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                                       transfer_account_id, updated_at) VALUES
               ('{COUNTERPART}', '{OWNER}', '{RAINY_DAY}', 'Counterpart', 1500, 'transfer',
                '2019-05-04', '{EVERYDAY}', '2019-05-04T00:00:00.000Z');
             INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor,
                                             sort_order, transfer_account_id, linked_transfer_id) VALUES
               ('{LEG_LINE}', '{CORNER_SHOP}', '{OWNER}', '{TO_FROM_RAINY}', -1500, 0,
                '{RAINY_DAY}', '{COUNTERPART}'),
               ('{PLAIN_LINE}', '{CORNER_SHOP}', '{OWNER}', '{WEEKLY_SHOP}', -1000, 1, NULL, NULL);
             -- The link is closed under _rpc_guard('restore'), the same flag
             -- finalize_user_restore holds, so the SEED does not re-date the row
             -- it is about to ask a restore to reproduce. Writing updated_at
             -- explicitly does NOT work here and it is worth saying why: the
             -- trigger's WHEN is `NEW.updated_at IS OLD.updated_at`, and writing
             -- the value the row already had satisfies it.
             INSERT INTO _rpc_guard VALUES ('restore');
             UPDATE transactions SET linked_transfer_split_id = '{LEG_LINE}'
              WHERE id = '{COUNTERPART}';
             DELETE FROM _rpc_guard;"
        ))
        .expect("seed");
    connection
}

/// Everything about the login that a restore has to bring back, as one string.
///
/// A single comparable value rather than a list of assertions, deliberately: the
/// question is *"is it the same afterwards"*, and a snapshot that has to be kept
/// in step with a list of expectations is a snapshot that stops asking it.
/// `updated_at` is IN here, because X-4 is exactly the thing a round trip is
/// most likely to break silently.
fn snapshot(connection: &Connection) -> String {
    let parts = [
        scalar(connection, "SELECT group_concat(s, ' | ') FROM (
            SELECT id || '/' || name || '/' || type || '/' || balance_minor || '/'
                || initial_balance_minor || '/' || COALESCE(parent_account_id, '-') || '/'
                || substr(updated_at, 1, 10) AS s
              FROM accounts ORDER BY id)"),
        scalar(connection, "SELECT group_concat(s, ' | ') FROM (
            SELECT id || '/' || name || '/' || level || '/' || COALESCE(parent_id, '-') || '/'
                || COALESCE(account_id, '-') || '/' || is_transfer_category AS s
              FROM categories ORDER BY id)"),
        scalar(connection, "SELECT group_concat(s, ' | ') FROM (
            SELECT id || '/' || account_id || '/' || description || '/' || amount_minor || '/'
                || type || '/' || date || '/' || COALESCE(category, '-') || '/' || is_split || '/'
                || is_cleared || '/' || category_confirmed || '/'
                || COALESCE(transfer_account_id, '-') || '/' || COALESCE(linked_transfer_id, '-')
                || '/' || COALESCE(linked_transfer_split_id, '-') || '/' || substr(updated_at, 1, 10) AS s
              FROM transactions ORDER BY id)"),
        scalar(connection, "SELECT group_concat(s, ' | ') FROM (
            SELECT id || '/' || transaction_id || '/' || category || '/' || amount_minor || '/'
                || sort_order || '/' || COALESCE(transfer_account_id, '-') || '/'
                || COALESCE(linked_transfer_id, '-') AS s
              FROM transaction_splits ORDER BY id)"),
    ];
    parts.join("\n")
}

/// The same dataset, as a backup file holds it: cloud column names, cloud scales,
/// money as decimal strings, links stripped into the separate payload the file
/// carries them in.
fn bundle() -> (Value, Value) {
    let chunks = json!([
        { "entity": "accounts", "rows": [
            { "id": EVERYDAY, "user_id": STRANGER, "name": "Everyday", "type": "checking",
              "currency": "GBP", "balance": "-25.00", "initial_balance": "0.00",
              "is_active": true, "low_balance_alert_enabled": false, "metadata": {},
              "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" },
            { "id": RAINY_DAY, "user_id": STRANGER, "name": "Rainy day", "type": "savings",
              "currency": "GBP", "balance": "15.00", "initial_balance": "0.00",
              "is_active": true, "low_balance_alert_enabled": false, "metadata": {},
              "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" },
        ]},
        { "entity": "categories", "rows": [
            { "id": TRANSFER_ROOT, "user_id": STRANGER, "name": "Transfer", "type": "both",
              "level": "type", "is_system": false, "is_transfer_category": false,
              "is_revaluation_category": false, "is_unassigned_bucket": false, "is_active": true,
              "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" },
            { "id": OUTGOINGS, "user_id": STRANGER, "name": "Outgoings", "type": "expense",
              "level": "type", "is_system": false, "is_transfer_category": false,
              "is_revaluation_category": false, "is_unassigned_bucket": false, "is_active": true,
              "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" },
        ]},
        { "entity": "categories", "rows": [
            { "id": WEEKLY_SHOP, "user_id": STRANGER, "name": "Weekly shop", "type": "expense",
              "level": "sub", "parent_id": OUTGOINGS, "is_system": false,
              "is_transfer_category": false, "is_revaluation_category": false,
              "is_unassigned_bucket": false, "is_active": true,
              "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" },
        ]},
        { "entity": "categories", "rows": [
            // The To/From row, under its ORIGINAL id — the whole reason the
            // target has to be empty.
            { "id": TO_FROM_RAINY, "user_id": STRANGER, "name": "To/From Rainy day", "type": "both",
              "level": "detail", "parent_id": TRANSFER_ROOT, "account_id": RAINY_DAY,
              "is_system": false, "is_transfer_category": true,
              "is_revaluation_category": false, "is_unassigned_bucket": false, "is_active": true,
              "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" },
            { "id": TO_FROM_EVERYDAY, "user_id": STRANGER,
              "name": "To/From Everyday", "type": "both", "level": "detail",
              "parent_id": TRANSFER_ROOT, "account_id": EVERYDAY, "is_system": false,
              "is_transfer_category": true, "is_revaluation_category": false,
              "is_unassigned_bucket": false, "is_active": true,
              "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" },
        ]},
        { "entity": "transactions", "rows": [
            { "id": CORNER_SHOP, "user_id": STRANGER, "account_id": EVERYDAY,
              "description": "Corner shop", "amount": "-25.00", "type": "expense",
              "date": "2019-05-04", "category": "", "is_cleared": false, "is_split": true,
              "archived": false, "category_confirmed": true, "is_recurring": false, "metadata": {},
              "created_at": "2019-05-04T00:00:00+00:00", "updated_at": "2019-05-04T00:00:00+00:00" },
            { "id": COUNTERPART, "user_id": STRANGER, "account_id": RAINY_DAY,
              "description": "Counterpart", "amount": "15.00", "type": "transfer",
              "date": "2019-05-04", "transfer_account_id": EVERYDAY,
              "linked_transfer_split_id": LEG_LINE,
              "is_cleared": false, "is_split": false, "archived": false,
              "category_confirmed": true, "is_recurring": false, "metadata": {},
              "created_at": "2019-05-04T00:00:00+00:00", "updated_at": "2019-05-04T00:00:00+00:00" },
        ]},
        { "entity": "transaction_splits", "rows": [
            { "id": LEG_LINE, "transaction_id": CORNER_SHOP, "user_id": STRANGER,
              "category": TO_FROM_RAINY, "amount": "-15.00", "sort_order": 0,
              "transfer_account_id": RAINY_DAY, "linked_transfer_id": COUNTERPART,
              "created_at": "2019-05-04T00:00:00+00:00", "updated_at": "2019-05-04T00:00:00+00:00" },
            { "id": PLAIN_LINE, "transaction_id": CORNER_SHOP, "user_id": STRANGER,
              "category": WEEKLY_SHOP, "amount": "-10.00", "sort_order": 1,
              "created_at": "2019-05-04T00:00:00+00:00", "updated_at": "2019-05-04T00:00:00+00:00" },
        ]},
    ]);
    let links = json!({
        "account_parents": [],
        "transaction_links": [
            { "id": COUNTERPART, "linked_transfer_id": null, "linked_transfer_split_id": LEG_LINE },
        ],
    });
    (chunks, links)
}

// ── The headline ────────────────────────────────────────────────────────────

#[test]
fn a_wipe_and_a_restore_leave_the_file_exactly_as_it_was() {
    let mut connection = seeded();
    let before = snapshot(&connection);

    let counts = wipe(&mut connection).answer;
    assert_eq!(counts.accounts, 2);
    // Zero, because the account delete already cascaded them: the number reports
    // its own statement, not the operation. Both engines say so.
    assert_eq!(counts.transactions, 0);
    // Three, not five: the two To/From rows cascaded with their accounts a
    // statement earlier, so by the time the categories statement runs there are
    // three left to count. Postgres reports the same three, for the same reason.
    assert_eq!(counts.categories, 3);

    let empty = user_financial_data_is_empty(
        &connection,
        UserFinancialDataIsEmpty { user_id: Some(OWNER.to_owned()) },
    )
    .expect("is empty");
    assert!(empty.answer.empty, "the wipe must satisfy the precondition it exists for");

    let (chunks, links) = bundle();
    let restored = restore(&mut connection, chunks);
    assert_eq!(restored.answer.inserted, 11);
    assert!(restored.answer.dropped.is_empty(), "{:?}", restored.answer.dropped);

    let command: FinalizeUserRestore =
        serde_json::from_value(json!({ "links": links, "user_id": OWNER })).expect("links");
    let finalized = finalize_user_restore(&mut connection, command).expect("finalize");
    assert_eq!(finalized.answer.transactions_relinked, 1);

    assert_eq!(
        snapshot(&connection),
        before,
        "a backup is defined by its restore; if these differ the file is not a backup"
    );
}

#[test]
fn the_round_trip_keeps_every_balance_and_the_identity_that_ties_them_together() {
    let mut connection = seeded();
    wipe(&mut connection);
    let (chunks, links) = bundle();
    restore(&mut connection, chunks);
    let command: FinalizeUserRestore =
        serde_json::from_value(json!({ "links": links, "user_id": OWNER })).expect("links");
    finalize_user_restore(&mut connection, command).expect("finalize");

    // X-8: the file's own balances, verbatim. Not recomputed from the rows —
    // recomputing would discard any balance reconciled against a statement.
    assert_eq!(
        scalar(&connection, "SELECT group_concat(balance_minor, ',') FROM (
            SELECT balance_minor FROM accounts ORDER BY id)"),
        "-2500,1500"
    );
    // B-1 anyway, because this dataset happens to satisfy it and a restore that
    // broke it would be restoring something else.
    assert_eq!(
        scalar(&connection, "SELECT COUNT(*) FROM accounts a
             WHERE a.balance_minor <> a.initial_balance_minor
                 + COALESCE((SELECT SUM(t.amount_minor) FROM transactions t
                              WHERE t.account_id = a.id), 0)"),
        "0"
    );
}

// ── One transaction, and the cycle it can close ─────────────────────────────

#[test]
fn the_whole_restore_is_one_transaction_so_a_refusal_leaves_nothing_behind() {
    // DESIGN.md §5 divergence 6. The cloud's own comment calls its
    // non-atomicity "honest" and survivable because the login had to be empty;
    // not needing that argument is strictly better.
    let mut connection = seeded();
    wipe(&mut connection);

    let (chunks, _) = bundle();
    let mut broken = chunks.as_array().expect("chunks").clone();
    // A last chunk that cannot land: a split line naming a transaction the file
    // does not carry.
    broken.push(json!({ "entity": "transaction_splits", "rows": [
        { "id": "50000000-0000-0000-0000-0000000000ff",
          "transaction_id": "70000000-0000-0000-0000-0000000000ff",
          "user_id": OWNER, "category": WEEKLY_SHOP, "amount": "-1.00", "sort_order": 0,
          "created_at": "2019-05-04T00:00:00+00:00", "updated_at": "2019-05-04T00:00:00+00:00" }
    ]}));

    let command: RestoreUserChunk =
        serde_json::from_value(json!({ "chunks": broken, "user_id": OWNER })).expect("command");
    let error = restore_user_chunk(&mut connection, command).expect_err("the last chunk cannot land");
    assert_eq!(error.code(), "restore_row_refused", "{error}");

    // Ten rows landed before the eleventh refused, and every one of them is gone.
    for table in ["accounts", "categories", "transactions", "transaction_splits"] {
        assert_eq!(
            scalar(&connection, &format!("SELECT COUNT(*) FROM {table}")),
            "0",
            "{table} survived a refused restore"
        );
    }
    let empty = user_financial_data_is_empty(
        &connection,
        UserFinancialDataIsEmpty { user_id: Some(OWNER.to_owned()) },
    )
    .expect("is empty");
    assert!(empty.answer.empty, "a refused restore must leave the login restorable");
}

#[test]
fn a_split_line_may_name_a_transaction_that_has_not_been_restored_yet() {
    // R-11, and the reason one transaction is possible here at all.
    //
    // `transaction_splits.linked_transfer_id` is DEFERRABLE INITIALLY DEFERRED
    // in this schema and is not deferrable in the cloud, where nothing is
    // (20260807083000:488-493 verifies that as a premise of its two-pass design).
    // So this order — a leg line naming a counterpart that arrives in a LATER
    // chunk — is one Postgres cannot accept in any arrangement of its calls, and
    // one this file resolves at COMMIT.
    //
    // It is what makes DESIGN.md §5 divergence 6 true rather than aspirational:
    // the local restore does not need its chunks to be separate transactions,
    // because it does not need any of them to have committed before the next.
    let mut connection = seeded();
    wipe(&mut connection);

    let result = restore(
        &mut connection,
        json!([
            { "entity": "accounts", "rows": [
                { "id": EVERYDAY, "name": "Everyday", "type": "checking", "balance": "-25.00",
                  "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" },
                { "id": RAINY_DAY, "name": "Rainy day", "type": "savings", "balance": "15.00",
                  "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" }]},
            { "entity": "categories", "rows": [
                { "id": WEEKLY_SHOP, "name": "Weekly shop", "type": "expense", "level": "sub",
                  "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" }]},
            { "entity": "transactions", "rows": [
                { "id": CORNER_SHOP, "account_id": EVERYDAY, "description": "Corner shop",
                  "amount": "-25.00", "type": "expense", "date": "2019-05-04", "is_split": true,
                  "category": "",
                  "created_at": "2019-05-04T00:00:00+00:00", "updated_at": "2019-05-04T00:00:00+00:00" }]},
            // The line points FORWARD, at a row the next chunk brings.
            { "entity": "transaction_splits", "rows": [
                { "id": LEG_LINE, "transaction_id": CORNER_SHOP, "category": WEEKLY_SHOP,
                  "amount": "-15.00", "sort_order": 0, "transfer_account_id": RAINY_DAY,
                  "linked_transfer_id": COUNTERPART,
                  "created_at": "2019-05-04T00:00:00+00:00", "updated_at": "2019-05-04T00:00:00+00:00" },
                { "id": PLAIN_LINE, "transaction_id": CORNER_SHOP, "category": WEEKLY_SHOP,
                  "amount": "-10.00", "sort_order": 1,
                  "created_at": "2019-05-04T00:00:00+00:00", "updated_at": "2019-05-04T00:00:00+00:00" }]},
            { "entity": "transactions", "rows": [
                { "id": COUNTERPART, "account_id": RAINY_DAY, "description": "Counterpart",
                  "amount": "15.00", "type": "transfer", "date": "2019-05-04",
                  "transfer_account_id": EVERYDAY,
                  "created_at": "2019-05-04T00:00:00+00:00", "updated_at": "2019-05-04T00:00:00+00:00" }]},
        ]),
    );
    assert_eq!(result.answer.inserted, 7);
    assert_eq!(
        scalar(&connection, "SELECT COUNT(*) FROM transaction_splits s
             JOIN transactions t ON t.id = s.linked_transfer_id"),
        "1",
        "the forward reference should have resolved at COMMIT"
    );
}

// ── The guards ──────────────────────────────────────────────────────────────

#[test]
fn the_wipe_holds_the_leg_guard_and_puts_it_back() {
    let mut connection = seeded();
    wipe(&mut connection);
    assert_eq!(
        scalar(&connection, "SELECT COUNT(*) FROM _rpc_guard"),
        "0",
        "a stray flag leaves S-9 and S-10 standing down for every later write"
    );
    assert_eq!(scalar(&connection, "SELECT COUNT(*) FROM transaction_splits"), "0");
}

#[test]
fn the_wipe_does_not_hold_the_leg_guard_when_no_line_is_a_leg() {
    // A guard that is always on is not a guard. The condition is the same one
    // delete_transaction uses, and this is the half that proves it is a
    // CONDITION rather than a formality.
    let mut connection = seeded();
    connection
        .execute_batch(&format!(
            "INSERT INTO _rpc_guard VALUES ('leg');
             UPDATE transaction_splits SET linked_transfer_id = NULL WHERE id = '{LEG_LINE}';
             UPDATE transactions SET linked_transfer_split_id = NULL WHERE id = '{COUNTERPART}';
             DELETE FROM _rpc_guard;"
        ))
        .expect("unlink the leg");

    // With no leg anywhere, the wipe must still succeed — and it must do so
    // WITHOUT the guard, which is unobservable from outside except that the
    // whole thing works and the table is clean.
    wipe(&mut connection);
    assert_eq!(scalar(&connection, "SELECT COUNT(*) FROM _rpc_guard"), "0");
    assert_eq!(scalar(&connection, "SELECT COUNT(*) FROM transactions"), "0");
}

#[test]
fn finalize_puts_the_restore_guard_back_before_it_returns() {
    let mut connection = seeded();
    wipe(&mut connection);
    let (chunks, links) = bundle();
    restore(&mut connection, chunks);
    let command: FinalizeUserRestore =
        serde_json::from_value(json!({ "links": links, "user_id": OWNER })).expect("links");
    finalize_user_restore(&mut connection, command).expect("finalize");

    assert_eq!(scalar(&connection, "SELECT COUNT(*) FROM _rpc_guard"), "0");

    // …and the exemption really is off again: an ordinary edit now re-dates.
    connection
        .execute_batch(&format!(
            "UPDATE transactions SET description = 'Corner shop (edited)' WHERE id = '{CORNER_SHOP}';"
        ))
        .expect("edit");
    let day = scalar(
        &connection,
        &format!("SELECT substr(updated_at, 1, 10) FROM transactions WHERE id = '{CORNER_SHOP}'"),
    );
    assert_ne!(day, "2019-05-04", "the restore exemption outlived the restore");
}

// ── The audit ───────────────────────────────────────────────────────────────

#[test]
fn the_wipe_audits_every_row_and_the_hashes_chain() {
    let mut connection = seeded();
    let result = wipe(&mut connection);
    assert_eq!(result.audit_seq, Some(4), "two transactions and two accounts");

    /// One stored audit row, in the order `chain_hash` absorbs its fields.
    struct Entry {
        seq: i64,
        entity: String,
        entity_id: String,
        action: String,
        before: Option<String>,
        after: Option<String>,
        created_at: String,
        prev_hash: Option<String>,
        row_hash: String,
    }

    let mut statement = connection
        .prepare(
            "SELECT seq, entity, entity_id, action, before_data, after_data, created_at,
                    prev_hash, row_hash
               FROM financial_audit_log ORDER BY seq",
        )
        .expect("prepare");
    let rows: Vec<Entry> = statement
        .query_map([], |row| {
            Ok(Entry {
                seq: row.get(0)?,
                entity: row.get(1)?,
                entity_id: row.get(2)?,
                action: row.get(3)?,
                before: row.get(4)?,
                after: row.get(5)?,
                created_at: row.get(6)?,
                prev_hash: row.get(7)?,
                row_hash: row.get(8)?,
            })
        })
        .expect("query")
        .map(|row| row.expect("row"))
        .collect();

    assert_eq!(rows.len(), 4);
    let mut previous: Option<String> = None;
    for Entry { seq, entity, entity_id, action, before, after, created_at, prev_hash, row_hash } in rows {
        assert_eq!(action, "delete");
        assert!(before.is_some(), "a delete records what was there");
        assert!(after.is_none(), "U-6: a delete has no after");
        assert!(entity == "transaction" || entity == "account", "{entity}");
        assert_eq!(prev_hash, previous, "seq {seq} does not chain");
        let expected = wealth_core::audit::chain_hash(
            previous.as_deref(),
            seq,
            &entity,
            &entity_id,
            &action,
            before.as_deref(),
            after.as_deref(),
            &created_at,
        );
        assert_eq!(row_hash, expected, "seq {seq} hash does not verify");
        previous = Some(row_hash);
    }

    // The log survives the wipe. It is the only thing left that can say what
    // was there, which is the point of writing it before deleting.
    assert_eq!(scalar(&connection, "SELECT COUNT(*) FROM financial_audit_log"), "4");
}

// ── The column maps ─────────────────────────────────────────────────────────

#[test]
fn every_entity_the_format_carries_can_be_restored() {
    // The differential specs exercise four entities. This exercises all
    // fifteen, because a scale typo in `investment_transactions` is not
    // something anybody should find out about from their own holdings — and
    // because the fifteenth carries the two documents whose CONTAINER a CHECK
    // constrains on both engines, so a restore that stringified one of them
    // would be refused rather than stored wrongly.
    let mut connection = seeded();
    wipe(&mut connection);

    let chunks = json!([
        { "entity": "accounts", "rows": [{
            "id": EVERYDAY, "name": "Everyday", "type": "checking", "balance": "-25.00",
            "initial_balance": "0.00", "bank_balance": "-24.50", "bank_balance_date": "2019-06-01",
            "low_balance_threshold": "10.00", "low_balance_alert_enabled": true,
            "account_number": "1234", "sort_code": "00-00-00", "institution": "A bank",
            "opening_balance_date": "2019-01-01", "archive_through_date": "2018-12-31",
            "last_reconciled_date": "2019-05-31", "notes": "a note", "metadata": { "k": 1 },
            "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" }]},
        { "entity": "categories", "rows": [{
            "id": OUTGOINGS, "name": "Outgoings", "type": "expense", "level": "type",
            "is_system": false, "is_transfer_category": false, "is_revaluation_category": false,
            "is_unassigned_bucket": false, "is_active": true,
            "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" }]},
        { "entity": "transactions", "rows": [{
            "id": CORNER_SHOP, "account_id": EVERYDAY, "description": "Corner shop",
            "amount": "-25.00", "type": "expense", "date": "2019-05-04", "category": OUTGOINGS,
            "tags": ["one", "two", "one"], "is_cleared": true, "is_split": false, "archived": false,
            "category_confirmed": false, "statement_sequence": 7, "is_recurring": false,
            "import_source": "qif", "import_source_id": "row-1", "merchant_name": "A shop",
            "metadata": {}, "created_at": "2019-05-04T00:00:00+00:00",
            "updated_at": "2019-05-04T00:00:00+00:00" }]},
        { "entity": "transaction_splits", "rows": [{
            "id": PLAIN_LINE, "transaction_id": CORNER_SHOP, "category": OUTGOINGS,
            "amount": "-25.00", "sort_order": 0, "memo": "a memo",
            "created_at": "2019-05-04T00:00:00+00:00", "updated_at": "2019-05-04T00:00:00+00:00" }]},
        { "entity": "budgets", "rows": [{
            "id": "b0000000-0000-0000-0000-000000000001", "name": "Food", "amount": "100.00",
            "period": "monthly", "start_date": "2019-01-01", "spent": "42.50",
            "rollover_mode": "surplus", "alert_threshold": "80.00", "is_active": true,
            "category": OUTGOINGS, "notes": "a note", "metadata": {},
            "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" }]},
        { "entity": "goals", "rows": [{
            "id": "90000000-0000-0000-0000-000000000001", "name": "Holiday",
            "target_amount": "500.00", "current_amount": "125.00", "status": "active",
            "priority": "high", "account_id": EVERYDAY, "contribution_frequency": "monthly",
            "auto_contribute": true, "target_date": "2020-06-01",
            "completed_at": "2019-12-31T00:00:00+00:00", "metadata": {},
            "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" }]},
        { "entity": "goal_contributions", "rows": [{
            "id": "91000000-0000-0000-0000-000000000001",
            "goal_id": "90000000-0000-0000-0000-000000000001", "amount": "125.00",
            "date": "2019-03-01", "transaction_id": CORNER_SHOP, "notes": "first",
            "created_at": "2019-03-01T00:00:00+00:00" }]},
        { "entity": "investments", "rows": [{
            "id": "e0000000-0000-0000-0000-000000000001", "account_id": EVERYDAY, "symbol": "ABC",
            "name": "A fund", "asset_type": "etf", "currency": "GBP", "quantity": "10.50000000",
            "cost_basis": "1000.00", "current_price": "12.34500000", "market_value": "129.62",
            "purchase_date": "2019-02-01", "purchase_price": "9.87650000",
            "last_updated": "2019-06-01T00:00:00+00:00", "notes": "held",
            "created_at": "2019-02-01T00:00:00+00:00", "updated_at": "2019-06-01T00:00:00+00:00" }]},
        { "entity": "investment_transactions", "rows": [{
            "id": "e1000000-0000-0000-0000-000000000001",
            "investment_id": "e0000000-0000-0000-0000-000000000001", "transaction_type": "buy",
            "quantity": "10.50000000", "price": "9.87650000", "total_amount": "103.70",
            "fees": "1.50", "date": "2019-02-01", "notes": "bought",
            "created_at": "2019-02-01T00:00:00+00:00" }]},
        { "entity": "recurring_transactions", "rows": [{
            "id": "d0000000-0000-0000-0000-000000000001", "account_id": EVERYDAY,
            "description": "Rent", "amount": "-500.00", "type": "expense", "category": OUTGOINGS,
            "frequency": "monthly", "start_date": "2019-01-01", "next_date": "2019-07-01",
            "end_date": "2020-01-01", "is_active": true, "auto_create": false,
            "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" }]},
        { "entity": "notifications", "rows": [{
            "id": "f0000000-0000-0000-0000-000000000001", "type": "info", "title": "Hello",
            "message": "A message", "is_read": true, "action_label": "Open", "action_url": "/x",
            "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" }]},
        { "entity": "dashboard_layouts", "rows": [{
            "id": "f0000000-0000-0000-0000-000000000002", "name": "Mine",
            "widgets": [{ "w": "net-worth" }], "is_default": true,
            "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" }]},
        { "entity": "widget_preferences", "rows": [{
            "id": "f0000000-0000-0000-0000-000000000003", "widget_type": "net-worth",
            "settings": { "s": true }, "is_collapsed": true,
            "last_refreshed": "2019-06-01T09:30:00+01:00",
            "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" }]},
        { "entity": "suggestion_dismissals", "rows": [{
            "id": "f0000000-0000-0000-0000-000000000004", "kind": "duplicate",
            "subject_key": "a-key", "subject_ids": [CORNER_SHOP],
            "dismissed_at": "2019-06-01T00:00:00+00:00" }]},
        { "entity": "custom_reports", "rows": [{
            "id": "f0000000-0000-0000-0000-000000000005", "name": "Where it went",
            "description": "a description",
            "components": [{ "id": "c1", "type": "summary", "title": "Totals", "width": "full" }],
            // The ids in here arrived ALREADY REWRITTEN — `remapBackupIds` did it
            // on the client, which is the only place holding the map from the
            // file's ids to this login's. Nothing in the crate touches them, so
            // what this asserts is that they travel VERBATIM.
            "filters": { "dateRange": "custom", "customStartDate": "2019-01-01",
                         "accounts": [EVERYDAY], "categories": [OUTGOINGS],
                         "tags": ["a-label"] },
            "created_at": "2019-01-01T00:00:00+00:00",
            "updated_at": "2019-06-01T00:00:00+00:00" }]},
    ]);

    let result = restore(&mut connection, chunks);
    assert_eq!(result.answer.inserted, 15, "one row per entity");
    assert!(result.answer.dropped.is_empty(), "{:?}", result.answer.dropped);

    // The scale conversions, each read back as the integer the column holds.
    assert_eq!(
        scalar(&connection, "SELECT bank_balance_minor || '/' || low_balance_threshold_minor
                 FROM accounts"),
        "-2450/1000"
    );
    assert_eq!(
        scalar(&connection, "SELECT amount_minor || '/' || spent_minor || '/'
                 || alert_threshold_bp FROM budgets"),
        "10000/4250/8000",
        "alert_threshold is a PERCENTAGE stored as basis points of a percent, not money"
    );
    assert_eq!(
        scalar(&connection, "SELECT rollover_mode FROM budgets"),
        "surplus",
        "the rollover mode travels as the word it is"
    );
    assert_eq!(
        scalar(&connection, "SELECT target_amount_minor || '/' || current_amount_minor FROM goals"),
        "50000/12500"
    );
    assert_eq!(
        scalar(&connection, "SELECT quantity_e8 || '/' || cost_basis_minor || '/'
                 || current_price_e8 || '/' || market_value_minor || '/' || purchase_price_e8
                 FROM investments"),
        "1050000000/100000/1234500000/12962/987650000",
        "prices are 8dp here and 2dp in the cloud — DESIGN.md §5 divergence 4"
    );
    assert_eq!(
        scalar(&connection, "SELECT quantity_e8 || '/' || unit_price_e8 || '/'
                 || total_amount_minor || '/' || fee_minor || '/' || tax_minor
                 FROM investment_transactions"),
        "1050000000/987650000/10370/150/0",
        "tax_minor has no key in the backup format and takes this schema's default"
    );

    // The two array columns, which are child tables here.
    assert_eq!(
        scalar(&connection, "SELECT group_concat(tag, ',') FROM (
            SELECT tag FROM transaction_tags ORDER BY tag)"),
        "one,two",
        "tags are a SET: the duplicate in the file lands once"
    );
    assert_eq!(
        scalar(&connection, "SELECT transaction_id || '/' || role_order
                 FROM suggestion_dismissal_subjects"),
        format!("{CORNER_SHOP}/0")
    );

    // A timestamp with an offset, normalised by SQLite to the shape the column
    // defaults use — PostgREST renders timestamptz with a numeric offset and
    // `transactions_timestamps_shaped` requires the Z.
    assert_eq!(
        scalar(&connection, "SELECT last_refreshed FROM widget_preferences"),
        "2019-06-01T08:30:00.000Z"
    );
    // Every row re-owned, including the ones whose file rows named nobody.
    assert_eq!(
        scalar(&connection, "SELECT COUNT(DISTINCT user_id) || '/' || MIN(user_id) FROM (
            SELECT user_id FROM accounts UNION ALL SELECT user_id FROM budgets
             UNION ALL SELECT user_id FROM goals UNION ALL SELECT user_id FROM investments
             UNION ALL SELECT user_id FROM recurring_transactions
             UNION ALL SELECT user_id FROM suggestion_dismissals)"),
        format!("1/{OWNER}")
    );
}

#[test]
fn a_dismissal_naming_a_transaction_nobody_has_keeps_the_dismissal_and_reports_the_subject() {
    // The cloud's subject_ids is a uuid[] with a column comment PROMISING every
    // id resolves; here that promise is a foreign key. A restore cannot store an
    // id nothing matches — and refusing the whole file over a suggestion the
    // user waved away would be absurd, so the subject is dropped and SAID.
    let mut connection = seeded();
    wipe(&mut connection);
    let result = restore(
        &mut connection,
        json!([{ "entity": "suggestion_dismissals", "rows": [{
            "id": "f0000000-0000-0000-0000-000000000004", "kind": "duplicate",
            "subject_key": "a-key", "subject_ids": ["70000000-0000-0000-0000-0000000000ff"],
            "dismissed_at": "2019-06-01T00:00:00+00:00" }]}]),
    );

    assert_eq!(result.answer.inserted, 1, "the dismissal itself lands");
    assert_eq!(result.answer.dropped.len(), 1);
    assert!(
        result.answer.dropped[0].what.contains("does not hold"),
        "{:?}",
        result.answer.dropped[0]
    );
    assert_eq!(scalar(&connection, "SELECT COUNT(*) FROM suggestion_dismissals"), "1");
    assert_eq!(scalar(&connection, "SELECT COUNT(*) FROM suggestion_dismissal_subjects"), "0");
}

#[test]
fn an_unknown_key_in_a_row_is_ignored_exactly_as_the_cloud_ignores_it() {
    let mut connection = seeded();
    wipe(&mut connection);
    let result = restore(
        &mut connection,
        json!([{ "entity": "accounts", "rows": [{
            "id": EVERYDAY, "name": "Everyday", "type": "checking",
            "a_column_that_does_not_exist": "x",
            "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" }]}]),
    );
    assert_eq!(result.answer.inserted, 1);
    // …and the columns it did not mention took this schema's defaults, where the
    // cloud would have refused the row for the NOT NULL it left NULL. The
    // difference is reachable only from a hand-edited file; both exporters in
    // this repo write whole rows.
    assert_eq!(
        scalar(&connection, "SELECT balance_minor || '/' || currency || '/' || is_active FROM accounts"),
        "0/GBP/1"
    );
}

#[test]
fn a_figure_past_the_bound_names_the_row_it_came_from() {
    // MONEY-5. The refusal has to say WHICH row: a restore of fifty thousand
    // rows that says only "CHECK constraint failed" has told the user nothing
    // they can act on.
    let mut connection = seeded();
    wipe(&mut connection);
    let command: RestoreUserChunk = serde_json::from_value(json!({
        "chunks": [
            { "entity": "accounts", "rows": [{
                "id": EVERYDAY, "name": "Everyday", "type": "checking", "balance": "0.00",
                "initial_balance": "0.00",
                "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" }]},
            { "entity": "transactions", "rows": [{
                "id": CORNER_SHOP, "account_id": EVERYDAY, "description": "Absurd",
                "amount": "1000000000000.00", "type": "income", "date": "2019-05-04",
                "created_at": "2019-05-04T00:00:00+00:00", "updated_at": "2019-05-04T00:00:00+00:00" }]},
        ],
        "user_id": OWNER
    }))
    .expect("command");

    let error = restore_user_chunk(&mut connection, command).expect_err("out of bounds");
    let message = error.to_string();
    assert_eq!(error.code(), "restore_row_refused", "{message}");
    assert!(message.contains("transactions"), "{message}");
    assert!(message.contains(CORNER_SHOP), "the refusal must name the row: {message}");
    assert!(message.contains("transactions_amount_bounded"), "{message}");
    // And the account that landed first went with it: one transaction.
    assert_eq!(scalar(&connection, "SELECT COUNT(*) FROM accounts"), "0");
}

#[test]
fn a_sub_penny_figure_is_refused_rather_than_rounded() {
    let mut connection = seeded();
    wipe(&mut connection);
    let command: RestoreUserChunk = serde_json::from_value(json!({
        "chunks": [{ "entity": "accounts", "rows": [{
            "id": EVERYDAY, "name": "Everyday", "type": "checking", "balance": "-25.005",
            "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "2019-01-01T00:00:00+00:00" }]}],
        "user_id": OWNER
    }))
    .expect("command");
    let error = restore_user_chunk(&mut connection, command).expect_err("sub-penny");
    let message = error.to_string();
    assert!(message.contains("amount_not_representable"), "{message}");
    assert!(message.contains(EVERYDAY), "{message}");
}

#[test]
fn a_timestamp_nothing_can_read_is_refused_rather_than_stored_as_now() {
    let mut connection = seeded();
    wipe(&mut connection);
    let command: RestoreUserChunk = serde_json::from_value(json!({
        "chunks": [{ "entity": "accounts", "rows": [{
            "id": EVERYDAY, "name": "Everyday", "type": "checking",
            "created_at": "2019-01-01T00:00:00+00:00", "updated_at": "the day before yesterday" }]}],
        "user_id": OWNER
    }))
    .expect("command");
    let error = restore_user_chunk(&mut connection, command).expect_err("unreadable");
    assert!(error.to_string().contains("timestamp_unreadable"), "{error}");
}
