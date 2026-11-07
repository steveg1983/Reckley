//! The differential harness's bridge into the command layer.
//!
//! ```text
//! wealth-core-cli --db <path>        JSON command on stdin, JSON result on stdout
//! wealth-core-cli --apply-schema --db <path>   create the file and apply the schema
//! wealth-core-cli --version                    engine and crate versions, as JSON
//! ```
//!
//! # What is here, and what is deliberately not
//!
//! Arguments, stdin, stdout, exit codes. That is the whole of it.
//!
//! The verb set, the dispatch over it and the envelope an answer travels in are
//! [`wealth_core::command`], in the library, because the desktop shell's one
//! `#[tauri::command]` runs the same match and a second copy of it would be a
//! second verb set (PHASE3-PLAN D-3). This file is one caller of that module; it
//! does not own the surface, and nothing about the wire is decided here.
//!
//! # Why a spawned binary and not a native Node addon
//!
//! `scripts/local-sqlite/lib/sqlite.mjs` states the constraint this repo already
//! decided: *"this repo ships a browser bundle and a Vercel function set —
//! adding a native, node-gyp-compiled devDependency for a schema harness buys a
//! prebuild/rebuild failure mode on every `npm ci`"*. A napi-rs binding would be
//! exactly that devDependency. A spawned binary has **zero** npm surface: the
//! harness runs it if it is built and says so plainly if it is not, and
//! `npm ci` never learns Rust exists.
//!
//! The Node runner already drives `psql` this way — one process per spec, JSON
//! or text out — so the two engines are driven by the same shape and neither
//! gets a structural advantage in the comparison.
//!
//! The cost is a process spawn per command. MEASURED, 40 runs after 3 warm-ups
//! on an M-series laptop: median **2.50 ms**, min 2.20, p95 3.42; the whole
//! 16-spec suite including the Postgres side is 0.66 s wall clock. A long-lived
//! JSON-lines daemon would save single-digit milliseconds in exchange for a
//! failure mode — a hung child holding a write lock on the temp database — that
//! is much worse than the latency it saves. It is also why the APP does not
//! arrive this way: a spawn per call is fine for a spec and wrong for a rename
//! of three thousand rows, which is the measurement behind D-3's in-process
//! command for the shell.
//!
//! # Why the Node side owns the file and the Rust side only writes to it
//!
//! The harness creates the temp database, applies `schema.sql` and the fixture
//! with `node:sqlite`, then calls this binary, then re-opens the file to run its
//! assertions. So the verb is exercised against the **vendored** schema, applied
//! by the same code path that applies it for the existing 54 constraint specs —
//! not against a copy this crate keeps. `--apply-schema` exists only for the
//! crate's own integration tests, which have no Node runner to do it for them.

use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;

use wealth_core::command::{dispatch, parse, plan, respond, Response};
use wealth_core::db;

fn main() -> ExitCode {
    match run() {
        Ok(response) => {
            print(&response);
            ExitCode::SUCCESS
        }
        // A harness fault — a missing file, an unreadable stdin, a schema that
        // will not apply. Deliberately NOT a JSON error body: the runner must be
        // able to tell "the verb refused" from "the harness is broken", and the
        // existing runner already makes that distinction for Postgres.
        Err(fault) => {
            eprintln!("wealth-core-cli: {fault}");
            ExitCode::FAILURE
        }
    }
}

fn print(response: &Response) {
    match serde_json::to_string(response) {
        Ok(text) => println!("{text}"),
        Err(error) => eprintln!("wealth-core-cli: could not serialise response: {error}"),
    }
}

fn run() -> Result<Response, String> {
    let mut database: Option<PathBuf> = None;
    let mut apply_schema = false;
    let mut show_version = false;

    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--db" => database = args.next().map(PathBuf::from),
            "--apply-schema" => apply_schema = true,
            "--version" => show_version = true,
            other => return Err(format!("unknown argument {other}")),
        }
    }

    if show_version {
        return Ok(Response::Ok {
            ok: true,
            result: serde_json::json!({
                "crate": env!("CARGO_PKG_VERSION"),
                "rusqlite": rusqlite::version(),
            }),
        });
    }

    if apply_schema {
        let path = database
            .as_ref()
            .ok_or_else(|| "--db <path> is required".to_owned())?;
        let connection = rusqlite::Connection::open(path).map_err(|error| error.to_string())?;
        db::configure(&connection).map_err(|error| error.to_string())?;
        wealth_core::apply_schema(&connection).map_err(|error| error.to_string())?;
        return Ok(Response::Ok {
            ok: true,
            result: serde_json::json!({ "schema": "applied" }),
        });
    }

    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("could not read the command from stdin: {error}"))?;

    // A malformed command is a REFUSAL, not a fault: the harness asked for
    // something and is being told no. Only the transport is a fault.
    let command = match parse(&input) {
        Ok(command) => command,
        Err(refusal) => return Ok(refusal),
    };

    // THE ADMISSION SURFACE IS ANSWERED BEFORE A FILE EXISTS
    // ------------------------------------------------------
    // A `plan_*` command decides what a row MEANS; it does not write, and the
    // easiest way to keep that true is for it never to be holding a database.
    // Being handed one is therefore a FAULT rather than an ignored argument: a
    // caller that passes `--db` to a planner has misunderstood which half of
    // the surface it is talking to, and a silent success would leave it
    // misunderstanding that until the day the planner grew a write.
    let command = match plan(command) {
        Ok(outcome) => {
            if database.is_some() {
                return Err(
                    "a plan_* command decides what a row means and writes nothing, so it is \
                     never handed a database; drop --db"
                        .to_owned(),
                );
            }
            return respond(outcome);
        }
        Err(command) => command,
    };

    let path = database.ok_or_else(|| "--db <path> is required".to_owned())?;
    let mut connection = db::open(&path).map_err(|error| error.to_string())?;
    // As the desktop does on open: a file made by an earlier schema is brought
    // to this one's shape before a verb reads it.
    wealth_core::upgrade::upgrade_schema(&mut connection).map_err(|error| error.to_string())?;

    respond(dispatch(&mut connection, command))
}
