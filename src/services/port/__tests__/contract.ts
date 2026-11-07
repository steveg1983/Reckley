/**
 * The DataPort contract suite.
 *
 * One `describe` block, run once per implementation of the seam. It is written
 * against the interface and the app's own types ONLY — no storage keys, no
 * client, no service names — so the local edition can run this same file
 * unchanged by supplying a harness that builds its own store. That
 * reusability, not the assertions, is the deliverable: it is what makes
 * "the local edition behaves like the cloud one" a thing that is proved rather
 * than hoped.
 *
 * What is pinned here is the set of rules that today exist in exactly one
 * implementation and would otherwise be re-derived (or quietly not) by the
 * next one:
 *
 *  - a refused split leaves the store exactly as it was;
 *  - a split line that is half of a transfer may move and be re-memoed, and
 *    nothing else, with the refusal said in words a user can act on;
 *  - transfer pairing invariants, in the order they are judged;
 *  - the category-merge guards, source before target — the order decides which
 *    sentence the user sees;
 *  - every money movement lands on the penny;
 *  - a budget survives a create and an edit to the penny, is refused by name
 *    when it is not there, and is not an error to delete twice — and lands
 *    under the owner the implementation resolved for itself, never another;
 *  - a goal starts at the money already put by rather than at zero, and no
 *    write through the seam carries one past its own target;
 *  - that a mark is a working note and only finalizing reconciles anything,
 *    including what the archive sweep hangs off now that the two are separate;
 *  - dismissal pruning and dismissal idempotence;
 *  - and the DECLARED divergences (D-7, M-1), asserted per engine so that a
 *    difference between implementations is recorded rather than discovered.
 *
 * This file is not itself a test: it exports a function. `*.contract.test.ts`
 * files call it.
 */

import { describe, it, expect, vi } from 'vitest';
// The app's own default category tree — the one list all three engines start a
// fresh store from. Imported rather than restated because B-4's rule below is
// about THAT list and no other: see PREPARE_CATEGORIES's `keepsTheDefaultIds`.
// It is safe to import here for the same reason the local edition can send it
// over the seam: the module carries data and a slug function, and imports
// nothing but a type.
import { getDefaultCategories } from '../../../data/defaultCategories';
import type { BackupBundle, BackupEntity, BackupRow, BootSnapshot, DataPort } from '../dataPort';
import type { InvestmentHolding } from '../../investments/holding';
// The app's own decimal, because a holding's quantity and its two unit prices
// are `DecimalInstance` rather than `number` — the one place this seam does not
// say `MoneyNumber`, and `DataPortInvestmentWrites` argues why.
import { toDecimal } from '../../../utils/decimal';
import type {
  Account,
  Budget,
  Category,
  CustomReport,
  Goal,
  SuggestionDismissal,
  Transaction,
  TransactionSplit
} from '../../../types';

/**
 * Which implementation is under test. Divergences are declared against these
 * names, so adding an engine means adding a row to the tables below and
 * finding out immediately which rules it does not yet keep.
 */
export type DataPortEngine = 'browser-storage' | 'supabase' | 'local-core';

/** The seed a test starts from. Plain app data; no engine words in it. */
export interface PortFixture {
  accounts?: Account[];
  transactions?: Transaction[];
  splits?: TransactionSplit[];
  categories?: Category[];
  budgets?: Budget[];
  goals?: Goal[];
  /**
   * Reports somebody built.
   *
   * No per-engine table beside this one, unlike {@link PortFixture.investments}:
   * every engine the seam has keeps custom reports, because the browser branch
   * grew a storage key for them in the same slice that gave the cloud a table.
   * The failure this entity exists to end was a report living in ONE browser, so
   * an engine that could not hold one would be the bug rather than a divergence.
   */
  customReports?: CustomReport[];
  /**
   * Positions, for an engine that has somewhere to keep one.
   *
   * An engine that has NOT — see {@link INVESTMENT_STORAGE} — seeds nothing and
   * reads back nothing, which is the honest translation of a fixture into a
   * store with no holdings table rather than a gap in the harness. Every rule
   * that uses this branches on that table and asserts BOTH branches.
   */
  investments?: InvestmentHolding[];
  dismissals?: SuggestionDismissal[];
}

/**
 * What the store holds now, however it holds it. The harness reads this back
 * by whatever means fits its engine — a browser-storage snapshot, a set of
 * SELECTs — and the suite compares app-shaped values only.
 */
export interface PortStoreState {
  accounts: Account[];
  transactions: Transaction[];
  splits: TransactionSplit[];
  categories: Category[];
  budgets: Budget[];
  goals: Goal[];
  customReports: CustomReport[];
  investments: InvestmentHolding[];
  dismissals: SuggestionDismissal[];
}

export interface DataPortUnderTest {
  /**
   * The engine under test, typed as the whole seam — and it must BE the whole
   * seam: while an engine was being built this was permitted to be less, with a
   * ratchet naming what was missing, and that permission is withdrawn. The
   * annotation is documentation rather than proof (this file is not compiled by
   * `tsc -b`); the surface rule below is what actually holds a port to the seam.
   */
  port: DataPort;
  /**
   * What the store holds now, read by something OTHER THAN THE PORT.
   *
   * Not a preference. This is the independent witness that every "the refusal
   * changed nothing" and every "the row really landed" assertion is built on,
   * and a harness that answered it with the port's own reads would turn all of
   * them into "the port agrees with itself" — which a port that silently writes
   * nothing and reads nothing back satisfies perfectly. The rule *"reads its
   * own store back by some means other than itself"* checks it by watching
   * rather than by asking.
   */
  read(): Promise<PortStoreState>;
}

export interface DataPortContractHarness {
  engine: DataPortEngine;
  /** A fresh, isolated store seeded with the fixture. Never shared between tests. */
  create(fixture: PortFixture): Promise<DataPortUnderTest>;
  /**
   * A port whose STORE IS BROKEN — it refuses every read.
   *
   * Required, not optional, because the rule it proves cannot be proved any
   * other way: the boot's reads must resolve rather than reject, and a store
   * that always works never asks them the question. The boot effect has one
   * outer catch, and reaching it puts a full-page "Failed to load data" in
   * front of somebody whose ledger is fine.
   *
   * How the store is broken is the harness's business: an adapter that throws,
   * a database file that is not there, a connection pointed at nothing.
   */
  createUnreadable(): Promise<DataPort>;
}

/**
 * Every operation the seam names, written out where a RUNTIME check can walk
 * it.
 *
 * WHY A LIST AND NOT THE TYPE. `tsc -b` does not typecheck tests:
 * tsconfig.app.json excludes every `__tests__` directory and every `.test.ts`
 * and `.test.tsx` file, and eslint runs without a project. So the `DataPort`
 * annotation on a test double is documentation, not a proof: a double that
 * answers half the seam compiles, runs and passes, and the day a real
 * implementation is swapped in behind those same tests the missing half is a
 * `TypeError` in front of a user rather than a red line in a diff.
 *
 * What the list buys, in the two places it is used:
 *
 *  - here, that the engine under test really implements every operation it
 *    claims to (a contract suite run against a partial port proves nothing);
 *  - in AppContextBootThroughPort.test.tsx, that the stubbed seam the boot is
 *    proved against has EXACTLY these keys — no fewer, so an operation cannot
 *    join the seam while the one test that boots the app on a bare stub keeps
 *    passing without answering it, and no more, so the stub cannot drift into
 *    inventing a door the interface does not have.
 *
 * It is maintained by hand ON PURPOSE and in the same commit as the interface:
 * the list is the one place a person adding an operation has to say out loud
 * that they have added it. Grouped and ordered as `dataPort.ts` groups them, so
 * the two files can be read side by side.
 */
export const DATA_PORT_OPERATIONS: readonly (keyof DataPort)[] = [
  // Reads
  'listAccounts',
  'listClosedAccounts',
  'listTransactions',
  'loadBootTransactions',
  'getAccountBalances',
  'listTransactionSplits',
  'listTransactionSplitsFor',
  'listBudgets',
  'listGoals',
  'listCustomReports',
  'listForecastAdjustments',
  'listCategories',
  'listSuggestionDismissals',
  'listInvestments',
  // The boot, in one answer
  'loadBoot',
  // Account writes
  'createAccount',
  'updateAccount',
  'closeAccount',
  // Transaction writes
  'createTransaction',
  'updateTransaction',
  'deleteTransaction',
  'setTransactionsCleared',
  'finalizeReconciliation',
  'applyCategoryToUncategorized',
  'suggestCategoryToUncategorized',
  'confirmTransactionCategories',
  'setTransactionArchived',
  'archiveTransactionsBefore',
  'unarchiveAccount',
  // Bulk writes
  'importTransactions',
  // Transfer writes
  'linkTransferPair',
  'linkSplitLineTransfer',
  'unlinkTransfers',
  'repairClaimedTransfer',
  'createTransferCounterpart',
  'repointTransfer',
  // Split writes
  'setTransactionSplits',
  // Planning writes
  'createBudget',
  'updateBudget',
  'deleteBudget',
  'createGoal',
  'updateGoal',
  'deleteGoal',
  'createCategory',
  'createCategories',
  'updateCategory',
  'deleteCategory',
  'deleteUnusedCategories',
  'mergeCategories',
  // Report writes
  'createCustomReport',
  'updateCustomReport',
  'deleteCustomReport',
  // Investment writes
  'createInvestment',
  'updateInvestment',
  'deleteInvestment',
  'applyInvestmentPrices',
  // Dismissal writes
  'dismissSuggestion',
  'restoreSuggestion',
  // Forecast scenario writes — the dismissal family's company
  'setForecastAdjustment',
  'clearForecastAdjustment',
  // Backup lifecycle
  'financialDataIsEmpty',
  'collectBackup',
  'restoreBackup',
  'wipeAllFinancialData',
  // Migration
  'importMsMoney',
  // Lifecycle
  'initialize',
  'prepareCategories',
  'subscribeToUpdates',
  // What the engine can do
  'capabilities'
];

/*
 * ── THE RATCHET IS GONE, AND THIS IS ITS EPITAPH ────────────────────────────
 *
 * `NOT_YET` and `NOT_YET_CEILING` used to be declared here: a per-engine list of
 * the operations an implementation had NOT written yet, by name, with a count
 * beside it that could only go down. They are DELETED — not left holding an
 * empty array, which is what the block itself said would happen the day the
 * number reached zero. It reached zero at slice 26.
 *
 * The argument is kept because it is the reason the local edition could be built
 * at all, and the next second engine will want it back.
 *
 * The surface rule below is the floor under every other rule: a suite run
 * against a port that is missing operations proves only that the operations it
 * HAS behave. That is what makes this file worth running — and it is also what
 * makes a second engine impossible to build incrementally, because a local
 * edition is fifty-six operations against a Rust crate and the choice would
 * otherwise be between one enormous unreviewable commit and turning the floor
 * off while the work was in progress.
 *
 * So the floor stayed on and the exception was written DOWN, per engine, by
 * name, and checked in BOTH DIRECTIONS: nothing missing that was not listed (so
 * the list could not become a way to opt out), and nothing listed that was not
 * missing (so an operation that had since been written had to LEAVE the list in
 * the same commit, which is what stopped the rules needing it from staying
 * skipped after the work was done — the half that made it a ratchet rather than
 * a register of excuses). The count went in the title of every pull request that
 * changed it: 41, 25, 22, 17, 11, 9, 4, 1, 0.
 *
 * What survives is the floor without the exception, and it is stronger for it:
 * the surface rule asks a port for every operation the seam names and accepts no
 * answer but all of them, and {@link rule} below no longer has a branch that can
 * skip anything. Nothing in this file is conditional on an engine being
 * unfinished, because no engine is.
 */

// ── Declared divergences ────────────────────────────────────────────────────
// Written as tables rather than as `if (engine === …)` scattered through the
// tests, so the whole difference between implementations can be read in one
// place — the way the crate's own differential specs do it.

/**
 * D-7 — a field outside `updateTransaction`'s honoured set. Every such field
 * has a dedicated operation, and the dedicated operation is the contract; what
 * the three engines do with it when it arrives on an update anyway differs.
 */
const UPDATE_OUTSIDE_ALLOW_LIST: Record<DataPortEngine, 'applies' | 'discards' | 'refuses'> = {
  'browser-storage': 'applies',
  supabase: 'discards',
  'local-core': 'refuses'
};

/**
 * M-1 — an amount with more than two decimal places. A penny is the smallest
 * thing a ledger can hold; the engines disagree about what to do when handed
 * something smaller.
 */
const SUB_PENNY_AMOUNT: Record<DataPortEngine, 'keeps' | 'rounds' | 'refuses'> = {
  'browser-storage': 'keeps',
  supabase: 'rounds',
  'local-core': 'refuses'
};

/**
 * B-1 — where a boot's transactions came from. The ROWS are the same question
 * for every engine; the provenance is not, and it is reported on the
 * boot-timing line rather than hidden, so it is declared here rather than
 * asserted equal.
 *
 * `snapshots` says whether the engine has a cache layer that can make a boot
 * legitimately fast. `reasonWhenUncached` is the words it must use when it does
 * not — never null, because a null there claims a snapshot stood.
 */
const BOOT_PROVENANCE: Record<DataPortEngine, { snapshots: boolean; reasonWhenUncached: string }> = {
  // No snapshot layer: it reads the one store it has, and says so.
  'browser-storage': { snapshots: false, reasonWhenUncached: 'local mode' },
  // Snapshot + delta, so a boot may legitimately report null.
  supabase: { snapshots: true, reasonWhenUncached: 'no cache' },
  // One store read, and honest about it — the rows are already on the device.
  'local-core': { snapshots: false, reasonWhenUncached: 'local mode' }
};

/**
 * BOOT_COMPOSITION — HOW an engine answers `loadBoot`, which is a different
 * question from what it answers with.
 *
 * The snapshot's CONTENTS are asserted equal for everybody: the same accounts,
 * the same prepared categories, the same rows, the budgets and the goals. What
 * cannot be asserted equal is the shape of the machinery underneath, and the
 * difference is not cosmetic — it decides what a test is even able to observe.
 *
 * `fansOut: true` means the composite is BUILT FROM the seam's own other reads,
 * so each one is separately observable and the ordering rules between them can
 * be proved by holding one and watching whether the next starts. That is how
 * the two rules below are proved today, and it is the only way they can be
 * proved from outside.
 *
 * `fansOut: false` means the answer is indivisible — one crossing, one
 * transaction, one snapshot — and there is no "before" or "after" inside it to
 * observe. Ordering is not kept there, it is unable to be broken there, which
 * is a stronger property and a differently-shaped assertion: the rules below
 * then check the OUTCOME (the rows are filed under the categories the same
 * answer carried) and that the composite really did not fan out.
 *
 * The 'local-core' row is a CLAIM the later slices have to make true, not a
 * description of something that exists.
 */
const BOOT_COMPOSITION: Record<DataPortEngine, { describes: string; fansOut: boolean }> = {
  // Six ordered reads of the one store it has.
  'browser-storage': { describes: 'six ordered reads of the one store it has', fansOut: true },
  // The same six, each a network crossing, in the order the boot depended on.
  supabase: { describes: 'six crossings, in the order the boot depended on', fansOut: true },
  // One crossing, one transaction, one snapshot — nothing to order.
  'local-core': { describes: 'one crossing, one transaction, one snapshot', fansOut: false }
};

/**
 * B-2 — whether the engine can compute every account's balance itself.
 *
 * The cloud can (one RPC that usually answers BEFORE the transaction pages do,
 * which is the whole point of it); browser storage has no second engine to ask;
 * a local core may answer so fast the window closes to nothing. `empty` is a
 * declared "I don't know", never a map of zeros — see the test below for why
 * that distinction is load-bearing rather than pedantic.
 */
const SERVER_BALANCES: Record<DataPortEngine, 'empty' | 'answers'> = {
  'browser-storage': 'empty',
  supabase: 'answers',
  'local-core': 'answers'
};

/**
 * B-4 — what `prepareCategories` does with a store that has none.
 *
 * All three must hand back a usable set (a ledger with no categories has
 * nowhere to file anything), and that part is asserted equal. Where they differ
 * is whether the set they handed back is also IN the store afterwards, which
 * decides whether the next read sees the same list or the defaults again.
 *
 * `describes` is the sentence the test names itself with, so a new engine's row
 * is a claim someone has to write down rather than a boolean nobody reads.
 *
 * `keepsTheDefaultIds` is the OTHER half of B-4 and the half that was missing
 * until slice 21: whether the ids the engine hands back are the ids
 * `src/data/defaultCategories.ts` names. It is not a detail of the same
 * question. `persists` alone is satisfied perfectly by an engine that seeds a
 * tree of freshly minted uuids — it wrote something, and it answered with what
 * it wrote — and that engine has quietly become a second id space, which is the
 * exact thing the cloud needed `migrate_categories_atomic`'s four passes to
 * escape from. The consequence is not cosmetic: the app resolves `'transfer-in'`
 * and `'type-transfer'` BY NAME in its own source (the transfer sentinels the
 * category column still legitimately holds, and the anchor C-3's trigger looks
 * for), so an engine that renamed them would leave that code asking a file for
 * categories it has never heard of.
 */
const PREPARE_CATEGORIES: Record<
  DataPortEngine,
  { describes: string; persists: boolean; keepsTheDefaultIds: boolean }
> = {
  // Hands back the defaults and writes nothing: the browser's copy is a cache,
  // and a cache that invents its own contents is no longer a cache. It cannot
  // renumber what it does not store.
  'browser-storage': {
    describes: 'answers with the defaults and stores nothing',
    persists: false,
    keepsTheDefaultIds: true
  },
  // Migrates the list it was given (or the defaults) into per-user rows, and
  // remaps every reference to it in the same database transaction. Its
  // `categories.id` is a uuid column, so the slugs CANNOT survive there and the
  // remap is the whole reason that function exists.
  supabase: {
    describes: 'migrates a set into the account and keeps it',
    persists: true,
    keepsTheDefaultIds: false
  },
  // Seeds its defaults into the one store it has; nothing to remap, ever. Only
  // `users.id` carries a uuid CHECK in a file (PHASE3-PLAN D-5), so a category
  // keeps the id it arrived with.
  'local-core': {
    describes: 'seeds the defaults into the store',
    persists: true,
    keepsTheDefaultIds: true
  }
};

/**
 * B-3 — what "the owner" is, for an engine being asked to file a write under
 * one.
 *
 * The phrase differs so much between engines that asserting it equal would be
 * asserting a fiction: browser storage has no concept of an owner, the cloud
 * has a column and a policy, a device edition has itself. What is asserted
 * equal is the pair of rules underneath the phrase, and they are the ones that
 * decide whether somebody's budget survives the night — see the test below.
 */
const OWNERSHIP: Record<DataPortEngine, string> = {
  'browser-storage': 'one store and no owner at all',
  supabase: 'an owner the implementation resolves, stamped on the row and enforced by RLS',
  // Asserted rather than aspirational since slice 22, and worth saying what the
  // phrase turned out to MEAN once there were writes to ask it of: a local
  // ledger's owner is the uuid in its own `users` row, read when the document
  // opened and cached for its life (PHASE3-PLAN D-5). Both halves of the rule
  // are therefore structural rather than careful — the port has no per-call
  // owner argument to get wrong, and two owners are two FILES, which is exactly
  // what the isolation half of the test below constructs.
  'local-core': 'the device itself'
};

/**
 * B-5 — where a new category's id is MADE.
 *
 * The caller uses the id it gets back on the very next line: as the value of the
 * select it just added an option to, and as the `parentId` of the children a
 * tree import creates in its second pass. So the part that is asserted equal is
 * that the id is final and usable at once. Where it comes from is not the same
 * question — a client mints a uuid, a database column defaults to one — and an
 * engine whose ids are allocated somewhere else entirely (a server that
 * renumbers on sync) would have to declare it here rather than discover it in a
 * register full of rows filed under an id that stopped existing.
 */
const ID_PROVENANCE: Record<DataPortEngine, string> = {
  'browser-storage': 'an id the client mints',
  supabase: 'an id the database column defaults to',
  'local-core': 'an id the client mints'
};

/**
 * B-6 — what a bulk prune does with the list it is handed.
 *
 * An engine that can see the whole ledger re-judges every row AGAINST IT AS IT
 * IS NOW, so a plan computed from a stale snapshot cannot destroy a category
 * somebody filed a transaction under in another tab a second ago; it therefore
 * deletes FEWER rows than it was asked to. Browser storage IS the snapshot it
 * would re-judge against — there is no second opinion available — so it does
 * what it is told.
 *
 * What every engine is held to, and what the test below asks in both branches:
 * the number it returns is the number of rows that ACTUALLY left. Not the size
 * of the request. The caller prints that figure ("pruned 40, kept 12 in use")
 * and re-reads the category set because of it.
 */
const BULK_PRUNE: Record<DataPortEngine, { describes: string; reverifies: boolean }> = {
  'browser-storage': { describes: 'does what the plan says', reverifies: false },
  supabase: { describes: 're-judges every row and keeps the ones still in use', reverifies: true },
  'local-core': { describes: 're-judges every row and keeps the ones still in use', reverifies: true }
};

/**
 * B-9 — how a bulk import can fail, and whether it can say how far it has got.
 *
 * The rule EVERY engine keeps, asserted below rather than declared: `inserted`
 * is a PREFIX count. Rows [0, inserted) of the file are in the account, rows
 * [inserted, total) are not, in file order. Both callers slice the array they
 * handed in at that number to name the missing payments to somebody holding the
 * statement, so a count that merely totalled the rows written — with the gaps
 * anywhere else — would send them looking for the wrong transactions.
 *
 * `partial` is how far a failure can get, and it follows from the size of the
 * unit each engine writes in: the cloud posts chunks that each commit on their
 * own, so it can stop at any chunk boundary; a device write is ONE store
 * transaction, so it is 0 or all of them. Both are prefixes.
 *
 * `reportsProgress` is whether `onProgress` can fire before the answer. An
 * engine that commits in pieces can count them honestly; one atomic write has
 * no fraction to report, and inventing one is the bar-creeping-to-90% lie that
 * keeps somebody waiting on a write that already failed.
 */
const BULK_IMPORT: Record<
  DataPortEngine,
  { partial: 'all-or-nothing' | 'any prefix'; reportsProgress: boolean }
> = {
  // One IndexedDB transaction covering the rows and the balance together.
  'browser-storage': { partial: 'all-or-nothing', reportsProgress: false },
  // Chunks of a thousand, each its own database transaction.
  supabase: { partial: 'any prefix', reportsProgress: true },
  // One store transaction, same as the browser and for the same reason.
  'local-core': { partial: 'all-or-nothing', reportsProgress: false }
};

/**
 * B-11 — WHAT THIS ENGINE CANNOT KEEP.
 *
 * A backup file carries every table the format knows about, and not every
 * engine has somewhere to put all of them: a browser has no investments, no
 * goal contributions and no repeating templates, because local mode has no
 * screen, no writer and no reader for any of them. Restoring a login's file
 * onto a device therefore genuinely loses part of it.
 *
 * That is a fact about the product, so it is written down HERE rather than
 * inferred from a mapping inside one engine. Two things follow from it, and
 * both are asserted below: the rows are never dropped in silence — they come
 * back NAMED, with a reason a person can read and act on — and an engine that
 * holds everything says so with an empty list rather than by staying quiet.
 *
 * A table added to the format with nowhere to live on a device must appear in
 * this row on the same day, or the restore that skips it will say nothing.
 */
const BACKUP_COVERAGE: Record<
  DataPortEngine,
  { notStored: readonly { entity: BackupEntity; label: string }[] }
> = {
  'browser-storage': {
    notStored: [
      { entity: 'goal_contributions', label: 'Goal contributions' },
      { entity: 'investments', label: 'Investments' },
      { entity: 'investment_transactions', label: 'Investment transactions' },
      { entity: 'recurring_transactions', label: 'Recurring transactions' },
      { entity: 'notifications', label: 'Notifications' },
      { entity: 'dashboard_layouts', label: 'Dashboard layouts' },
      { entity: 'widget_preferences', label: 'Widget preferences' },
      { entity: 'forecast_adjustments', label: 'Forecast adjustments' }
    ]
  },
  // Every table in the format is a table in the database — the format was read
  // off it.
  supabase: { notStored: [] },
  // A claim the local edition has to meet, not a description of something that
  // exists: it is meant to hold the whole ledger. The day it cannot hold a
  // table, this row says which, and the restore starts saying so too.
  'local-core': { notStored: [] }
};

/**
 * B-12 — WHETHER THIS ENGINE HAS ANYWHERE TO KEEP A HOLDING.
 *
 * Holdings were the last region of the ledger outside this seam, and they joined
 * it with one engine that genuinely cannot serve them. That is not a shortfall
 * to be fixed in a later slice, it is what browser storage has always been:
 * `investments` has been `stored: false` in `LOCAL_BACKUP_BINDINGS` since that
 * table was written, there is no storage key, no writer and no reader, and
 * `pages/Investments.tsx` used to say "Sign in to save holdings." at every write
 * for exactly that reason.
 *
 * So the divergence is DECLARED rather than levelled, and the rules below assert
 * BOTH branches rather than skipping one:
 *
 *   `keeps` — a create lands, the read lists it, an edit moves it, a delete
 *   removes it.
 *
 *   `has nowhere to keep them` — the READ answers an empty list (there are
 *   none, because there is nowhere to keep them, which is a true statement about
 *   the portfolio) and every WRITE refuses in words. Those two are deliberately
 *   different: an empty list is a true answer, and a create that resolved
 *   successfully having stored nothing would be a false one.
 *
 * An engine that answers `has nowhere to keep them` must also SAY SO through
 * `capabilities().cannotKeep`, and the rule below checks the two agree — because
 * a store that quietly answers `[]` and a store that has no holdings look
 * identical to a screen otherwise, and the Investments page would render an
 * empty portfolio with no explanation.
 */
const INVESTMENT_STORAGE: Record<DataPortEngine, 'keeps' | 'has nowhere to keep them'> = {
  // No key, no writer, no reader — and never has been. See above.
  'browser-storage': 'has nowhere to keep them',
  // `public.investments`, since the initial schema.
  supabase: 'keeps',
  // `investments` in `schema.sql`, with quantity and both unit prices at 1e8
  // rather than the cloud's old `numeric(10,2)` — the bug migration
  // 20260809120000 fixed in the cloud was fixed in this schema before it shipped.
  'local-core': 'keeps'
};

/**
 * Where the forecast scenario's adjustments live — investments' shape, one
 * tier over: the browser has no store for them (declared in
 * `backup/browserCoverage.ts`, so `cannotKeep` says it), and a signed-out
 * write REFUSES rather than landing somewhere invisible — the custom-reports
 * localStorage failure is the scar this rule keeps closed.
 */
const ADJUSTMENT_STORAGE: Record<DataPortEngine, 'keeps' | 'has nowhere to keep them'> = {
  'browser-storage': 'has nowhere to keep them',
  // `public.forecast_adjustments`, 20260819150000.
  supabase: 'keeps',
  // `forecast_adjustments` in `schema.sql`, the same integer of pennies.
  'local-core': 'keeps'
};

/**
 * B-7 — WHAT AN ACCOUNT IS WORTH AT BIRTH, when the caller states two figures.
 *
 * `Omit<Account, 'id'>` carries a `balance` AND an `openingBalance`, and on an
 * account with no transactions those are the same quantity described twice. B-1
 * — `balance = openingBalance + Σ(rows)` — is only satisfiable while they agree.
 *
 * In production they always do: `AppContextSupabase.addAccount` sets
 * `balance = initialBalance || balance || 0` before it calls the seam, so the
 * one shape that can reach this disagreement is a caller (or a fixture) that
 * contradicts itself. What the engines then do differs, and it differs for a
 * reason worth writing down rather than asserting away.
 *
 * `keeps both figures` stores what it was told and lets the two stand. The cloud
 * does that — its insert has a `balance` column and its writer fills it from
 * `account.balance || 0` — so a cloud account created this way is permanently
 * 50.50 out, and nothing there notices, because the cloud has no
 * `verify_integrity` and no ledger identity to keep.
 *
 * `the balance is the opening balance` has ONE money argument. It is not a
 * dropped field: it is the ledger identity being kept, in a file that reports
 * `balance_identity` by name the moment it is not. The rule below asserts BOTH
 * branches, because "the create answered with something" is not the claim —
 * the claim is that each engine did the specific thing declared here.
 */
const ACCOUNT_BALANCE_AT_BIRTH: Record<
  DataPortEngine,
  'keeps both figures' | 'the balance is the opening balance'
> = {
  'browser-storage': 'keeps both figures',
  supabase: 'keeps both figures',
  'local-core': 'the balance is the opening balance'
};

/**
 * B-7 — `Account.creditLimit`, which no DATABASE in this product has a column
 * for.
 *
 * Not a gap in one engine: `accountMapping.ts` says it outright — *"no migration
 * creates `accounts.credit_limit`"* — and it is not in the local mirror either.
 * VERIFIED against the reference cluster: `accounts` has twenty-eight columns
 * and none of them is that one. The field is mapped in both directions "for the
 * day the column exists", and until then it can only ever arrive from browser
 * storage, which keeps whatever object it is handed.
 *
 * So the rule below asserts a DIFFERENT thing per engine rather than the same
 * thing everywhere, and both halves are assertions: a store that keeps it gives
 * the figure back, and a store with no column for it answers `undefined` —
 * never `0`, which is a real credit limit and would divide the dashboard's
 * utilisation by zero.
 *
 * The day a migration adds the column, this table has one value and goes.
 */
const CREDIT_LIMIT_STORAGE: Record<DataPortEngine, 'keeps' | 'has no column for it'> = {
  'browser-storage': 'keeps',
  supabase: 'has no column for it',
  'local-core': 'has no column for it'
};

/**
 * C-3 — what a create does about the new account's own To/From category.
 *
 * Every transfer is filed under a category naming the account on the other side,
 * and those categories are made BY the account rather than by anybody typing
 * one: `create_transfer_category_for_account` fires on `accounts` INSERT in the
 * cloud (`20260708140000:34-82`) and `trg_create_transfer_category_for_account`
 * does the same in a local file. Neither is a verb, in either edition, and that
 * is the point — parity by construction, not by two implementations kept in
 * step.
 *
 * Browser storage has no triggers and mints nothing, which is a real difference
 * and not a shortfall to be fixed: local mode's category tree is a cache of a
 * decision taken elsewhere.
 *
 * `mints` therefore governs BOTH branches of rule 83: one To/From category named
 * after the account, or none at all — asserted either way, because "none"
 * silently becoming "one" would mean an engine had grown a second implementation
 * of the trigger.
 */
const TRANSFER_CATEGORY_ON_CREATE: Record<DataPortEngine, { describes: string; mints: boolean }> = {
  // No trigger, and nothing to be one: the store is a cache.
  'browser-storage': { describes: 'mints nothing — there is no trigger in a browser store', mints: false },
  // The database mints it, on INSERT.
  supabase: { describes: 'the database mints one, on the account INSERT', mints: true },
  // The file mints it, from the same trigger ported into schema.sql.
  'local-core': { describes: 'the file mints one, on the account INSERT', mints: true }
};

/**
 * B-8 — what a subscription promises.
 *
 * `subscribeToUpdates` is a watch, not a read: the caller hands over callbacks
 * and gets a handle back. WHAT arrives through those callbacks is the part the
 * engines cannot agree on, so it is declared here rather than asserted equal.
 *
 * `delivers: 'never'` is not a gap to be filled in later. An engine with no
 * other device to hear from has nothing to say: browser storage is one store in
 * one tab, and a local core is one file on one machine. Its handle is a no-op,
 * and the caller already treats a silent channel as normal.
 *
 * What EVERY engine is held to is in the test below, because the boot's cleanup
 * depends on it: the handle is a function, calling it twice is safe (the
 * cleanup drains its handles, and a fast user switch can reach the same one
 * again), and once it has been called nothing further arrives.
 */
const SUBSCRIPTION_DELIVERY: Record<
  DataPortEngine,
  { describes: string; delivers: 'never' | 'at-least-once' }
> = {
  // One store, one tab. Nothing to hear from, so nothing ever fires.
  'browser-storage': { describes: 'never delivers a change', delivers: 'never' },
  // A realtime channel: an event may arrive more than once, events may arrive
  // out of order, and an event may be THIS client's own write coming back —
  // which is why the provider suppresses reloads for a moment after a local
  // write and debounces whatever is left.
  supabase: {
    describes: 'delivers at least once, unordered, and may echo this client’s own writes',
    delivers: 'at-least-once'
  },
  // One file on one machine: same silence, same reason.
  'local-core': { describes: 'never delivers a change', delivers: 'never' }
};

// ── Fixture builders ────────────────────────────────────────────────────────
// Invented data throughout: made-up account names, made-up amounts.

const ACCOUNT_A = 'acct-a';
const ACCOUNT_B = 'acct-b';
const ACCOUNT_C = 'acct-c';

const AT = (day: string): Date => new Date(`${day}T12:00:00.000Z`);

/**
 * Let anything a write scheduled actually run. One macrotask: enough for a
 * callback an engine dispatched for itself, deliberately not enough to wait on
 * a network. See B-8 for what that buys and what it does not.
 */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

const anAccount = (id: string, name: string, rest: Partial<Account> = {}): Account => ({
  id,
  name,
  type: 'checking',
  balance: 0,
  currency: 'GBP',
  isActive: true,
  lastUpdated: AT('2025-01-01'),
  ...rest
});

const aTransaction = (id: string, rest: Partial<Transaction> = {}): Transaction => ({
  id,
  accountId: ACCOUNT_A,
  amount: -10,
  date: AT('2025-01-10'),
  description: 'Something bought',
  category: 'cat-everyday',
  type: 'expense',
  ...rest
});

const aCategory = (id: string, name: string, rest: Partial<Category> = {}): Category => ({
  id,
  name,
  type: 'expense',
  level: 'detail',
  isActive: true,
  ...rest
});

/**
 * A category as a CALLER supplies one — no id, because the id is the store's to
 * mint and the caller's to use immediately afterwards (B-5).
 */
const aNewCategory = (
  name: string,
  rest: Partial<Omit<Category, 'id'>> = {}
): Omit<Category, 'id'> => ({
  name,
  type: 'expense',
  level: 'detail',
  isActive: true,
  ...rest
});

const aBudget = (id: string, categoryId: string, amount: number): Budget => ({
  id,
  categoryId,
  amount,
  period: 'monthly',
  isActive: true,
  spent: 0,
  createdAt: AT('2025-01-01'),
  updatedAt: AT('2025-01-01')
});

/**
 * A budget as a CALLER supplies one — no id, and no `spent`: what has been
 * spent against a category is summed from the ledger, so it is never the
 * caller's to state. The two timestamps are the caller's own (the budget modal
 * sends them), and every engine is free to stamp its own over them.
 */
const aNewBudget = (
  categoryId: string,
  amount: number,
  rest: Partial<Omit<Budget, 'id' | 'spent'>> = {}
): Omit<Budget, 'id' | 'spent'> => ({
  categoryId,
  amount,
  period: 'monthly',
  isActive: true,
  createdAt: AT('2025-01-01'),
  updatedAt: AT('2025-01-01'),
  ...rest
});

const aGoal = (id: string, name: string, targetAmount: number): Goal => ({
  id,
  name,
  type: 'savings',
  targetAmount,
  currentAmount: 0,
  targetDate: AT('2026-01-01'),
  isActive: true,
  createdAt: AT('2025-01-01'),
  updatedAt: AT('2025-01-01'),
  progress: 0
});

/**
 * A goal as a CALLER supplies one — no id, and no `progress`.
 *
 * `progress` is absent for a DIFFERENT reason than `spent` is absent from a new
 * budget, and the difference is the whole of rule 49 below. A budget's `spent`
 * is summed from the ledger and is never the caller's to state; a goal's
 * progress is money somebody has already put by, which nothing else knows
 * about — so it is not ignored, it is taken from `currentAmount`.
 */
const aNewGoal = (
  name: string,
  targetAmount: number,
  rest: Partial<Omit<Goal, 'id' | 'progress'>> = {}
): Omit<Goal, 'id' | 'progress'> => ({
  name,
  type: 'savings',
  targetAmount,
  currentAmount: 0,
  targetDate: AT('2026-01-01'),
  isActive: true,
  createdAt: AT('2025-01-01'),
  updatedAt: AT('2025-01-01'),
  ...rest
});

/**
 * A report as it sits in a store: one component, and filters naming a real
 * account and a real category.
 *
 * The filters are populated on purpose rather than left empty. They are the
 * whole reason a report is more than a name — and `filters.accounts` and
 * `filters.categories` are ids, which is what `backup/format.ts`'s
 * `jsonbIdArrays` has to remap on a restore. A fixture whose filters were `{}`
 * would round-trip perfectly through an engine that threw the column away.
 */
const aCustomReport = (id: string, name: string, rest: Partial<CustomReport> = {}): CustomReport => ({
  id,
  name,
  description: 'What went where',
  components: [
    {
      id: 'component-1',
      type: 'summary-stats',
      title: 'Key metrics',
      config: { metrics: ['income', 'expenses'] },
      width: 'full'
    }
  ],
  filters: {
    dateRange: 'month',
    accounts: [ACCOUNT_A],
    categories: ['cat-everyday'],
    tags: ['holiday']
  },
  createdAt: AT('2025-01-01'),
  updatedAt: AT('2025-01-01'),
  ...rest
});

/**
 * A report as a CALLER supplies one — no id, because the id is the store's to
 * mint and the caller's to use immediately afterwards (B-5).
 *
 * The two timestamps are the caller's own — the builder puts them on every
 * report it hands back — and every engine is free to stamp its own over them,
 * exactly as `aNewBudget` above says of a budget's. Nothing asserts them,
 * because nothing may: `create_custom_report`'s draft has no clock in it and the
 * cloud's writer has no line for either column.
 */
const aNewCustomReport = (
  name: string,
  rest: Partial<Omit<CustomReport, 'id'>> = {}
): Omit<CustomReport, 'id'> => ({
  name,
  description: 'What went where',
  components: [
    {
      id: 'component-1',
      type: 'summary-stats',
      title: 'Key metrics',
      config: { metrics: ['income', 'expenses'] },
      width: 'full'
    }
  ],
  filters: {
    dateRange: 'month',
    accounts: [ACCOUNT_A],
    categories: ['cat-everyday'],
    tags: ['holiday']
  },
  createdAt: AT('2025-01-01'),
  updatedAt: AT('2025-01-01'),
  ...rest
});

/** Three accounts and nothing else — the starting point for most tests. */
const threeAccounts = (): Account[] => [
  anAccount(ACCOUNT_A, 'Everyday', { balance: -70.1 }),
  anAccount(ACCOUNT_B, 'Rainy day', { type: 'savings', balance: 500 }),
  anAccount(ACCOUNT_C, 'Spare', { type: 'savings', balance: 0 })
];

/**
 * The categories the rows in this file are filed under — the two ordinary ones,
 * and the To/From category of each account a transfer leg names.
 *
 * ── WHY A FIXTURE NEEDS THESE AT ALL ────────────────────────────────────────
 *
 * Until the local engine ran, no test here seeded a category unless the test was
 * ABOUT categories: every other fixture filed its rows under 'cat-everyday' and
 * left the tree out, because browser storage does not mind. The split writer
 * does mind, in every engine that has one — `set_transaction_splits_with_legs`
 * refuses a line filed under a category the owner does not have, by name, and
 * `dataService.setTransactionSplitsLocally` records in its own comment that it
 * deliberately does NOT reproduce that ("demo/offline fixtures routinely carry
 * transactions without the tree they were filed against"). That is a reasonable
 * thing for a browser cache to do and a bad thing for a ledger to do; the RPC is
 * the specification, and a fixture that only one engine's laxness makes possible
 * is a fixture describing a ledger nobody should be able to hold.
 *
 * So the split fixtures state their tree. It changes nothing for the engines
 * that never looked.
 *
 * ── THE TWO LEG CATEGORIES ARE ORDINARY ONES, AND THAT IS DELIBERATE ────────
 *
 * A split line that is half of a transfer can be filed one of two ways, and the
 * two are refused differently. Under a store's own To/From category, the line
 * is PINNED — the category names the account on the other side, so a line that
 * transfers somewhere else is contradicting itself and is refused for that,
 * before anything about the link is looked at. Under an ORDINARY category
 * nothing contradicts, and the refusal that fires is the one about the link.
 *
 * The rules below are about the link, so the fixtures file their legs under
 * ordinary categories — the shape the Microsoft Money import produces, and, in
 * `20260806094058`'s own words, *"exactly the population this migration was
 * written for"*. Filing them under a real To/From category would test a
 * different rule and would test it by accident.
 */
const filingCategories = (): Category[] => [
  aCategory('cat-everyday', 'Everyday spending'),
  aCategory('cat-bills', 'Bills'),
  aCategory('cat-transfer-a', 'Money paid to Everyday', { type: 'both' }),
  aCategory('cat-transfer-b', 'Money paid to Rainy day', { type: 'both' })
];

const balanceOf = (state: PortStoreState, accountId: string): number | undefined =>
  state.accounts.find(account => account.id === accountId)?.balance;

const transactionOf = (state: PortStoreState, id: string): Transaction | undefined =>
  state.transactions.find(transaction => transaction.id === id);

/**
 * A comparable picture of the whole store. Used for "a refusal changed
 * nothing": JSON is the one shape both a browser store and a database row can
 * be reduced to without the suite knowing which it is looking at.
 */
const asComparable = (state: PortStoreState): string => JSON.stringify(state);

/**
 * The OUTCOME the categories-before-transactions rule exists to produce, asked
 * of a snapshot rather than of an order of calls.
 *
 * Whatever the categories were renumbered to, the rows in the same snapshot are
 * filed under THOSE ids — not under the ones that were there when the boot
 * started. Nothing throws when that goes wrong; the register simply comes up
 * with its category column blank, which is why it is asserted rather than
 * assumed.
 */
const expectRowsFiledUnderTheSnapshotsCategories = (boot: BootSnapshot): void => {
  const categoryIds = new Set(boot.categories.map(category => category.id));
  boot.transactions
    .filter(transaction => transaction.category)
    .forEach(transaction => {
      expect(categoryIds.has(transaction.category)).toBe(true);
    });
};

export function runDataPortContract(name: string, harness: DataPortContractHarness): void {
  const { engine } = harness;

  /**
   * A rule, and the operations it exercises.
   *
   * Every `it` below is written through this, and `needs` is now documentation
   * that the compiler checks the SPELLING of: a rule says out loud which
   * operations it is about, which is the index nobody wrote, and a name that is
   * not a member of the seam does not typecheck.
   *
   * It used to do more. While an engine was being built, a rule needing an
   * operation that engine had not written was SKIPPED BY NAME with the missing
   * operation printed beside it — so a partial engine's test run read as a work
   * queue rather than as a wall of green, and nothing inside a test body was
   * ever conditional, so a rule could not half-run. That branch is deleted with
   * the ratchet it belonged to. Every rule runs on every engine now.
   *
   * The list is the operations a rule CALLS, not the ones its fixture happens
   * to touch: seeding is the harness's job and is expected to work whatever the
   * port can do.
   */
  const rule = (
    needs: readonly (keyof DataPort)[],
    title: string,
    body: () => Promise<void>
  ): void => {
    void needs;
    it(title, body);
  };

  describe(name, () => {
    describe('the surface itself', () => {
      it('answers every operation the seam names', async () => {
        // The floor under every rule below: a suite run against a port that is
        // missing operations proves only that the operations it HAS behave.
        // Nothing else here would notice the absence — an engine under
        // construction would go green on the half it had finished.
        //
        // Not a type check, deliberately. Tests are not compiled by `tsc -b`,
        // so `implements DataPort` is only checked where the implementation
        // itself is production code; a harness that assembles its port out of
        // parts (which the local edition, being two halves, does) gets no such
        // check at all. This one runs.
        //
        // ALL OF THEM, with no excuse list. This rule used to accept a declared
        // set of operations an engine had not written yet, checked in both
        // directions against a per-engine ratchet; the ratchet reached zero at
        // slice 26 and went, and what is left is the sentence it was protecting.
        const { port } = await harness.create({ accounts: threeAccounts() });

        const missing = DATA_PORT_OPERATIONS.filter(operation => typeof port[operation] !== 'function');

        expect(missing).toEqual([]);
      });

      it('reads its own store back by some means other than itself', async () => {
        // A HARNESS rule rather than an engine one, and the only rule in this
        // file about the file itself.
        //
        // `read()` is the independent witness every "a refusal changed nothing"
        // and every "the row really landed" assertion here is built on. A
        // harness that implemented it by calling the port's own reads would
        // turn all of them into "the port agrees with itself", which is a
        // property every broken implementation also has: a write that silently
        // did nothing and a read that consistently reports nothing agree
        // perfectly.
        //
        // It cannot be checked by reading the harness, because "does this
        // function reach the port" is not a question a grep answers once a
        // helper or two is involved. So it is checked by watching: every
        // operation the port has is spied on — spies call through, so nothing
        // is changed — and the store is read back. Any call at all is the
        // forbidden shape.
        const { port, read } = await harness.create({ accounts: threeAccounts() });

        const watched = DATA_PORT_OPERATIONS
          .filter(operation => typeof port[operation] === 'function')
          .map(operation => ({ operation, spy: vi.spyOn(port, operation) }));

        try {
          await read();
          const touched = watched
            .filter(({ spy }) => spy.mock.calls.length > 0)
            .map(({ operation }) => operation);
          expect(touched).toEqual([]);
        } finally {
          watched.forEach(({ spy }) => spy.mockRestore());
        }
      });

      rule(['capabilities'], 'describes what it can do, synchronously and completely', async () => {
        // The capability descriptor is the one answer every OTHER answer in
        // this suite is allowed to differ on — it is how an engine declares its
        // own divergences instead of the app guessing them. So its shape is a
        // contract in a way none of the data shapes are: a missing field is not
        // a wrong number on a screen, it is `undefined` flowing into a batch
        // size, a subscription gate, or the sentence that tells somebody
        // whether the file they just downloaded is their only copy.
        const { port } = await harness.create({ accounts: [] });

        const capabilities = port.capabilities();

        // Synchronous, and that is load-bearing rather than stylistic: every
        // consumer is a render or the tick of a write. A promise here would put
        // a loading state in front of a sentence.
        expect(capabilities).not.toBeInstanceOf(Promise);

        expect(Object.keys(capabilities).sort()).toEqual([
          'backupTarget',
          'cannotKeep',
          'edition',
          'maxConcurrentWrites',
          'realtime',
          'session'
        ]);
        expect(['cloud', 'device']).toContain(capabilities.edition);
        expect(['ready', 'connecting', 'anonymous']).toContain(capabilities.session);
        expect(typeof capabilities.realtime).toBe('boolean');
        expect(['login', 'device']).toContain(capabilities.backupTarget);

        // AT LEAST ONE, ALWAYS. Callers divide work into batches of this
        // number: a 0 is an infinite loop over somebody's transactions, and a
        // fraction is a slice() that never advances. An engine that is unsure
        // says 1 — one write at a time is slow, never wrong.
        expect(Number.isInteger(capabilities.maxConcurrentWrites)).toBe(true);
        expect(capabilities.maxConcurrentWrites).toBeGreaterThanOrEqual(1);

        // A store whose owner has not resolved is not a login. Backups are the
        // operation where naming the wrong store costs the most — the file is
        // the only copy — so the implication is asserted rather than assumed.
        if (capabilities.backupTarget === 'login') {
          expect(capabilities.session).toBe('ready');
        }

        // WHAT THIS STORE CANNOT KEEP is a list, always — empty is a statement
        // ("I hold every table the format carries") rather than a shrug, and a
        // screen has to be able to render `[]` without a null check. Every entry
        // names a table, gives it a word a person uses, and says WHY, because a
        // warning that a restore will lose something and does not say what is a
        // warning nobody can act on. Which tables, per engine, is B-11 and is
        // asserted against the restore's own answer in the backup rules below.
        expect(Array.isArray(capabilities.cannotKeep)).toBe(true);
        for (const entry of capabilities.cannotKeep) {
          expect(typeof entry.entity).toBe('string');
          expect(entry.label.length).toBeGreaterThan(0);
          expect(entry.absence.length).toBeGreaterThan(0);
        }
      });
    });

    describe('accounts', () => {
      rule(['createAccount', 'listAccounts'], 'gives back every field it was given', async () => {
        // The seam's promise about accounts: what the app wrote is what the
        // app reads. Two mappers that each dropped what the other kept is how
        // a low-balance alert silently switched itself off, so the field set
        // is a contract, not an implementation detail.
        const { port, read } = await harness.create({ accounts: [] });

        await port.createAccount({
          name: 'Rainy day',
          type: 'savings',
          balance: 250.5,
          currency: 'GBP',
          institution: 'Made Up Bank',
          isActive: true,
          lastUpdated: AT('2025-01-01'),
          openingBalance: 200,
          notes: 'Set aside for the boiler',
          sortCode: '00-00-00',
          accountNumber: '12345678',
          creditLimit: 0,
          lowBalanceThreshold: 25,
          lowBalanceAlertEnabled: true
        });

        const [stored] = (await read()).accounts;
        expect(stored).toMatchObject({
          name: 'Rainy day',
          type: 'savings',
          currency: 'GBP',
          institution: 'Made Up Bank',
          openingBalance: 200,
          notes: 'Set aside for the boiler',
          sortCode: '00-00-00',
          accountNumber: '12345678',
          lowBalanceThreshold: 25,
          lowBalanceAlertEnabled: true
        });
        expect(stored.id).toBeTruthy();

        // `creditLimit` is the ONE field of that payload no database in this
        // product has a column for, which is a fact about the schema rather
        // than about any engine — see CREDIT_LIMIT_STORAGE. Asserted in both
        // branches: a store that keeps it must give the figure back, and a
        // store with no column must answer `undefined` rather than `0`, because
        // £0 is a real credit limit and the dashboard divides by it.
        expect(stored.creditLimit).toBe(
          CREDIT_LIMIT_STORAGE[engine] === 'keeps' ? 0 : undefined
        );

        const listed = await port.listAccounts();
        expect(listed.find(account => account.id === stored.id)).toMatchObject({
          lowBalanceAlertEnabled: true,
          accountNumber: '12345678',
          sortCode: '00-00-00'
        });
      });

      rule(['createAccount'], 'B-7: hands the whole account back to the caller that created it', async () => {
        // The WRITE twin of the rule above, and a different promise: that one
        // is about what the store holds afterwards, this one is about the
        // object the create ANSWERS with. The caller puts it straight into app
        // state without re-reading, and the account settings modal seeds its
        // form from whatever is in state — so a field an engine drops on the
        // way in is a field the user finds blank when they reopen the account,
        // and writes back blank the next time they save something else.
        //
        // It is a rule of the seam rather than of any one engine because the
        // two writers that used to share this job disagreed about it: one sent
        // the bank details, the opening balance date and the notes, the other
        // sent ten columns and none of those four.
        //
        // The card rule rides along here because a create is the one place it
        // can be applied without asking anything: the account type is in the
        // payload. Whatever a caller supplies — a form, an importer, a
        // restored backup — four digits at most are stored, because anything
        // stored reaches that person's backups and their JSON export.
        const { port, read } = await harness.create({ accounts: [] });

        const created = await port.createAccount({
          name: 'Rainy day',
          type: 'savings',
          balance: 250.5,
          currency: 'GBP',
          institution: 'Made Up Bank',
          isActive: true,
          lastUpdated: AT('2025-01-01'),
          openingBalance: 200,
          openingBalanceDate: AT('2024-04-06'),
          notes: 'Set aside for the boiler',
          sortCode: '12-34-56',
          accountNumber: '12345678'
        });

        expect(created.id).toBeTruthy();
        expect(created).toMatchObject({
          name: 'Rainy day',
          type: 'savings',
          currency: 'GBP',
          institution: 'Made Up Bank',
          isActive: true,
          notes: 'Set aside for the boiler',
          sortCode: '12-34-56',
          accountNumber: '12345678'
        });

        // THE TWO MONEY FIELDS, which are the same quantity described twice on
        // an account with no transactions — and which this payload deliberately
        // states as two different numbers. What each engine does with that is
        // ACCOUNT_BALANCE_AT_BIRTH, and both branches are asserted, because the
        // difference is a ledger identity rather than a preference.
        if (ACCOUNT_BALANCE_AT_BIRTH[engine] === 'keeps both figures') {
          expect(created.balance).toBe(250.5);
          expect(created.openingBalance).toBe(200);
        } else {
          // One figure, and it is the opening balance: `balance = opening + Σ
          // rows` is true from the account's first instant because there is no
          // way to state anything else. Asserted as an EQUALITY between the two
          // fields rather than as a literal, so an engine that started dropping
          // both would fail here rather than pass by accident.
          expect(created.openingBalance).toBe(200);
          expect(created.balance).toBe(created.openingBalance);

          const [onFile] = (await read()).accounts;
          expect(onFile.balance).toBe(onFile.openingBalance);
        }
        // A Date crosses as a Date (rule 3): this one is read straight back
        // into a date input, and a string there shows as an empty field.
        expect(created.openingBalanceDate).toBeInstanceOf(Date);
        // THE DAY, not the instant, and the difference is the field's own.
        // `opening_balance_date` is a calendar DAY in every engine that has a
        // schema — a `date` column in the cloud, `LIKE '____-__-__'` in the
        // file — so the noon this fixture happens to state is not stored
        // anywhere and comes back as midnight. Asserting the instant would be
        // asserting a property of a store that keeps the object it was handed,
        // which is one engine out of three, and it would fail against the cloud
        // for the same reason it fails against a file.
        //
        // What the consumer needs is still asserted, and it is the whole of what
        // the rule was after: a Date, on the right day. A zone slip — the way a
        // day west of Greenwich becomes the day before — moves the UTC day, so
        // this catches the bug the assertion existed for.
        expect(created.openingBalanceDate?.toISOString().slice(0, 10)).toBe('2024-04-06');

        // Card-shaped but invented. A card has no sort code at all, and its
        // number is the last four digits and nothing else.
        const card = await port.createAccount({
          name: 'Spending card',
          type: 'credit',
          balance: 0,
          currency: 'GBP',
          isActive: true,
          lastUpdated: AT('2025-01-01'),
          accountNumber: '1111222233334444'
        });

        expect(card.accountNumber).toBe('4444');
        expect(JSON.stringify(await read())).not.toContain('1111222233334444');
      });

      rule(['closeAccount', 'listClosedAccounts'], 'closes an account rather than deleting it', async () => {
        // A deleted account is a hole in a ledger: its transactions would have
        // nowhere to belong. Every engine soft-closes.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [aTransaction('txn-1')]
        });

        await port.closeAccount(ACCOUNT_A);

        const state = await read();
        expect(state.accounts.find(account => account.id === ACCOUNT_A)?.isActive).toBe(false);
        expect(transactionOf(state, 'txn-1')).toBeDefined();

        const closed = await port.listClosedAccounts();
        expect(closed.map(account => account.id)).toContain(ACCOUNT_A);
      });

      rule(
        ['createAccount', 'listCategories'],
        '83: a created account has the To/From category its transfers will be filed under',
        async () => {
          // C-3. Every transfer is filed under a category naming the account on
          // the OTHER side, and those categories are made by the account rather
          // than by anybody typing one — a trigger on `accounts` INSERT in the
          // cloud, the same trigger ported into the file's schema, and nothing
          // at all in a browser store.
          //
          // The consequence of getting it wrong is not a missing row in a list:
          // it is that transfers into or out of this account have nowhere to be
          // filed, so the money moves and the report cannot say where it went.
          //
          // The fixture states the Transfer type root on purpose. BOTH triggers
          // stand down without one — "categories seed lazily; a parentless
          // category renders as junk" is the cloud's own comment — and that
          // stand-down is what makes a restore's insert order safe, so it is a
          // behaviour to preserve rather than to design around.
          const { port } = await harness.create({
            accounts: [],
            categories: [aCategory('cat-transfer-root', 'Transfer', { type: 'both', level: 'type' })]
          });

          const created = await port.createAccount({
            name: 'Holiday fund',
            type: 'savings',
            balance: 0,
            openingBalance: 0,
            currency: 'GBP',
            isActive: true,
            lastUpdated: AT('2025-01-01')
          });

          const mine = (await port.listCategories()).filter(
            category => category.accountId === created.id && category.isTransferCategory === true
          );

          if (!TRANSFER_CATEGORY_ON_CREATE[engine].mints) {
            // Asserted, not skipped: "none" quietly becoming "one" would mean
            // this engine had grown a second implementation of a trigger, and
            // two implementations of C-3 is how an account ends up with two.
            expect(mine).toHaveLength(0);
            return;
          }

          expect(mine).toHaveLength(1);
          expect(mine[0].name).toBe('To/From Holiday fund');
          // Filed under the Transfer root, active, and a leaf: a To/From
          // category that is not under the anchor renders as junk in the
          // category tree, and one that is not active is missing from the
          // dropdown that needs it.
          expect(mine[0].parentId).toBe('cat-transfer-root');
          expect(mine[0].isActive).toBe(true);
        }
      );

      rule(
        ['collectBackup', 'restoreBackup', 'listCategories'],
        '84: a restored ledger has exactly ONE To/From category per account',
        async () => {
          // R-6, and the collision rule 83 creates: a backup carries its own
          // To/From categories AND its accounts, and an engine that mints one
          // on every account INSERT will mint a second for every account in the
          // file. Two To/From categories for one account is not cosmetic — the
          // transfer picker offers the same account twice under two ids, and
          // half the history is then filed under a category the other half does
          // not use.
          //
          // Asserted for every engine, including the one that mints nothing:
          // there the count is the file's own, and a restore that duplicated
          // rows would fail here too.
          const source = await harness.create({
            accounts: [anAccount(ACCOUNT_A, 'Everyday')],
            categories: [
              aCategory('cat-transfer-root', 'Transfer', { type: 'both', level: 'type' }),
              aCategory('cat-to-from-a', 'To/From Everyday', {
                type: 'both',
                parentId: 'cat-transfer-root',
                accountId: ACCOUNT_A,
                isTransferCategory: true
              })
            ]
          });
          const file = await source.port.collectBackup();

          const target = await harness.create({});
          await target.port.restoreBackup(file);

          const accounts = (await target.read()).accounts;
          expect(accounts).toHaveLength(1);

          const transferCategories = (await target.port.listCategories()).filter(
            category => category.isTransferCategory === true
          );
          expect(transferCategories).toHaveLength(1);
          expect(transferCategories[0].accountId).toBe(accounts[0].id);
          expect(transferCategories[0].name).toBe('To/From Everyday');
        }
      );
    });

    describe('money moves exactly', () => {
      // Every fixture here is chosen so that IEEE-754 gets the sum wrong
      // (0.1 + 0.2 = 0.30000000000000004; -70.3 - -70.1 = -0.19999999999999574).
      // A float slipping into any implementation therefore fails on this
      // screen rather than in someone's balance six months later.
      const openWith = (a: number, b = 0): Account[] => [
        anAccount(ACCOUNT_A, 'Everyday', { balance: a }),
        anAccount(ACCOUNT_B, 'Rainy day', { type: 'savings', balance: b }),
        anAccount(ACCOUNT_C, 'Spare', { type: 'savings', balance: 0 })
      ];

      rule(['createTransaction'], 'adds a transaction to the balance to the penny', async () => {
        const { port, read } = await harness.create({ accounts: openWith(0.1) });

        await port.createTransaction({
          accountId: ACCOUNT_A,
          amount: 0.2,
          date: AT('2025-01-11'),
          description: 'A small thing',
          category: 'cat-everyday',
          type: 'income'
        });

        expect(balanceOf(await read(), ACCOUNT_A)).toBe(0.3);
      });

      rule(['updateTransaction'], 'moves the balance by the difference when an amount is edited', async () => {
        // Two float traps in one: the difference itself, and adding it on.
        const { port, read } = await harness.create({
          accounts: openWith(1.1),
          transactions: [aTransaction('txn-1', { amount: -70.1 })]
        });

        await port.updateTransaction('txn-1', { amount: -70.3 });

        expect(balanceOf(await read(), ACCOUNT_A)).toBe(0.9);
      });

      rule(['deleteTransaction'], 'takes a deleted transaction back out of the balance', async () => {
        const { port, read } = await harness.create({
          accounts: openWith(-70.1),
          transactions: [aTransaction('txn-1', { amount: -0.2 })]
        });

        await port.deleteTransaction('txn-1');

        expect(balanceOf(await read(), ACCOUNT_A)).toBe(-69.9);
      });

      rule(['createTransferCounterpart'], 'moves both balances when a transfer counterpart is created', async () => {
        const { port, read } = await harness.create({
          accounts: openWith(-70.1, 0.1),
          transactions: [aTransaction('txn-1', { amount: -0.2 })]
        });

        const { source, counterpart } = await port.createTransferCounterpart('txn-1', ACCOUNT_B);

        expect(source.type).toBe('transfer');
        expect(source.transferAccountId).toBe(ACCOUNT_B);
        expect(counterpart.amount).toBe(0.2);
        expect(counterpart.accountId).toBe(ACCOUNT_B);
        expect(counterpart.linkedTransferId).toBe('txn-1');

        const state = await read();
        // The source account does not move: its row was already counted.
        expect(balanceOf(state, ACCOUNT_A)).toBe(-70.1);
        expect(balanceOf(state, ACCOUNT_B)).toBe(0.3);
      });

      rule(['createTransferCounterpart', 'repointTransfer'], 'carries the money with the row when a transfer is re-pointed', async () => {
        // A re-point is the ONE transfer operation that is not balance-neutral:
        // the counterpart changes address, so the account it left must be down
        // by exactly what the account it joined is up by. The figures are
        // chosen so a float would get the subtraction wrong.
        const { port, read } = await harness.create({
          accounts: openWith(-70.1, 0.1),
          transactions: [aTransaction('txn-1', { amount: -0.2 })]
        });
        await port.createTransferCounterpart('txn-1', ACCOUNT_B);

        const result = await port.repointTransfer('txn-1', ACCOUNT_C);

        // The same row moved, and the pair still names each other.
        expect(result.displaced).toEqual({ kind: 'moved', fromAccountId: ACCOUNT_B });
        expect(result.counterpart.accountId).toBe(ACCOUNT_C);
        expect(result.counterpart.amount).toBe(0.2);
        expect(result.counterpart.linkedTransferId).toBe('txn-1');
        expect(result.source.linkedTransferId).toBe(result.counterpart.id);
        expect(result.source.transferAccountId).toBe(ACCOUNT_C);

        const state = await read();
        expect(balanceOf(state, ACCOUNT_A)).toBe(-70.1);   // never moved
        expect(balanceOf(state, ACCOUNT_B)).toBe(0.1);     // 0.3 − 0.2
        expect(balanceOf(state, ACCOUNT_C)).toBe(0.2);
      });

      rule(['createTransferCounterpart', 'deleteTransaction'], 'leaves the survivor of a deleted transfer leg unlinked', async () => {
        // Stated as a contract because it is not free anywhere: the cloud gets
        // it from transactions_linked_transfer_id_fkey (ON DELETE SET NULL) and
        // browser storage has to do it by hand. A dangling link is a row every
        // screen still treats as half of a pair — the editor refuses to move
        // it, and the register offers to jump to a transaction that is gone.
        const { port, read } = await harness.create({
          accounts: openWith(-70.1, 0.1),
          transactions: [aTransaction('txn-1', { amount: -0.2 })]
        });
        const { counterpart } = await port.createTransferCounterpart('txn-1', ACCOUNT_B);

        await port.deleteTransaction(counterpart.id);

        const survivor = (await read()).transactions.find(t => t.id === 'txn-1');
        expect(survivor?.linkedTransferId).toBeFalsy();
        // The rest of the leg is left alone: it is UNMATCHED, not un-typed.
        expect(survivor?.type).toBe('transfer');
        expect(survivor?.transferAccountId).toBe(ACCOUNT_B);
      });

      rule(['setTransactionSplits'], 'moves the balance when a split changes the transaction total', async () => {
        const { port, read } = await harness.create({
          accounts: openWith(0.1),
          categories: filingCategories(),
          transactions: [aTransaction('txn-1', { amount: 0.1, type: 'income' })]
        });

        const result = await port.setTransactionSplits(
          'txn-1',
          [
            { category: 'cat-everyday', amount: 0.1 },
            { category: 'cat-bills', amount: 0.2 }
          ],
          null
        );

        // The split's own total, and the balance that follows it.
        expect(result.amount).toBe(0.3);
        const state = await read();
        expect(balanceOf(state, ACCOUNT_A)).toBe(0.3);
        expect(transactionOf(state, 'txn-1')?.amount).toBe(0.3);
      });

      rule(['getAccountBalances'], 'computes a server-side balance that agrees with the client sum to the penny', async () => {
        // The two figures are stand-ins for each other on the dashboard for the
        // seconds a long history is in flight, so a disagreement between them
        // is money changing on screen. Same float trap as everything above:
        // 0.1 + 0.2 is not 0.3 in IEEE-754.
        const { port } = await harness.create({
          accounts: [anAccount(ACCOUNT_A, 'Everyday', { balance: 0.1, openingBalance: 0.1 })],
          transactions: [aTransaction('txn-1', { amount: 0.2, type: 'income' })]
        });

        const balances = await port.getAccountBalances();

        if (SERVER_BALANCES[engine] === 'empty') {
          expect(balances.size).toBe(0);
          return;
        }
        expect(balances.get(ACCOUNT_A)?.balance).toBe(0.3);
        expect(balances.get(ACCOUNT_A)?.txnCount).toBe(1);
      });
    });

    describe('importing a file', () => {
      /**
       * A statement as a parser hands one over: drafts, no ids — and every row
       * naming the WRONG account, because that is what a real file does. A CSV
       * says "Barclays" in a column and a parser guesses at it; the destination
       * the user picked is the one that must win.
       *
       * The three amounts are another IEEE-754 trap: 10.1 + 20.2 + 0.3 is
       * 30.599999999999998 in float, and this is the largest single balance
       * movement anything in the app makes.
       */
      const statement = (): Array<Omit<Transaction, 'id'>> => [
        {
          accountId: ACCOUNT_A,
          amount: 10.1,
          date: AT('2025-02-03'),
          description: 'CHEQUE PAID IN',
          category: 'cat-everyday',
          type: 'income'
        },
        {
          accountId: ACCOUNT_A,
          amount: 20.2,
          date: AT('2025-02-04'),
          description: 'REFUND FROM SHOP',
          category: 'cat-everyday',
          type: 'income'
        },
        {
          accountId: ACCOUNT_A,
          amount: 0.3,
          date: AT('2025-02-05'),
          description: 'INTEREST',
          category: 'cat-everyday',
          type: 'income'
        }
      ];

      rule(['importTransactions'], 'files every row into the account it was told, and moves that balance to the penny', async () => {
        const { port, read } = await harness.create({ accounts: threeAccounts() });
        const rows = statement();

        const result = await port.importTransactions(ACCOUNT_C, rows);

        expect(result.inserted).toBe(rows.length);
        expect(result.total).toBe(rows.length);
        expect(result.complete).toBe(true);
        // Never more "already here" than "here": the second number is a subset
        // of the first, not a separate pile added beside it.
        expect(result.alreadyPresent).toBeLessThanOrEqual(result.inserted);

        const state = await read();
        const landed = state.transactions.filter(t => t.accountId === ACCOUNT_C);
        expect(landed.map(t => t.description).sort()).toEqual(
          rows.map(row => row.description).sort()
        );
        // Every row usable at once: an id of its own, and no two the same.
        expect(new Set(landed.map(t => t.id)).size).toBe(rows.length);
        expect(landed.every(t => Boolean(t.id))).toBe(true);

        // The destination beat the parser's guess — for the rows AND for the
        // money. A statement filed into the wrong account is a register that
        // disagrees with the bank by whatever the file was worth.
        expect(balanceOf(state, ACCOUNT_C)).toBe(30.6);
        expect(balanceOf(state, ACCOUNT_A)).toBe(-70.1);
        expect(state.transactions.some(t => t.accountId === ACCOUNT_A)).toBe(false);
      });

      /**
       * A file's rows arrive as NEW WORK — the Microsoft Money convention the
       * register's bold and its "To Review" counter are built on.
       *
       * Pinned on the SEAM rather than in either engine because it is the only
       * place the rule can be stated once. The cloud decides it inside
       * import_transactions_atomic (a SQL literal) and the device decides it
       * inside importTransactionsLocally (a TypeScript literal), so there is no
       * shared line of code to hold to account — only this.
       *
       * And it is stated as "whatever the drafts said", deliberately: the
       * engines do NOT read the flag off the row, because a per-row key is a
       * key each of the three parsers has to remember, and a parser that
       * forgets fails silently — rows import, nothing lights up, and the
       * feature looks switched off rather than broken.
       */
      rule(['importTransactions'], 'marks every row it writes as new work, whatever the drafts said', async () => {
        const { port, read } = await harness.create({ accounts: threeAccounts() });
        const rows = statement().map(row => ({ ...row, needsReview: false }));

        await port.importTransactions(ACCOUNT_C, rows);

        const landed = (await read()).transactions.filter(t => t.accountId === ACCOUNT_C);
        expect(landed).toHaveLength(rows.length);
        expect(landed.every(t => t.needsReview === true)).toBe(true);
      });

      rule(['importTransactions'], 'B-9: what it says landed is a prefix of the file, and the rest really is absent', async () => {
        // The rule both importers depend on LITERALLY: each slices the array it
        // handed in at `inserted` and shows the remainder as "these payments
        // are missing". So this asks the store what it holds and compares it
        // against exactly that slice. An implementation that reported a count
        // it had not written — or wrote rows it did not count — fails here
        // rather than in front of somebody comparing a paper statement.
        const { port, read } = await harness.create({ accounts: threeAccounts() });
        const rows = statement();
        const before = asComparable(await read());

        // An account that is not there: the one refusal every engine makes for
        // itself (the cloud RPC's account_not_found_or_not_owned, and the same
        // judgement on a device), and the cheapest way to ask for a write that
        // does not happen.
        const result = await port.importTransactions('acct-that-is-not-there', rows);

        expect(result.complete).toBe(false);
        // Prose, because the caller renders it (rule 4 of the seam).
        expect(typeof result.error).toBe('string');
        expect(result.error).not.toBe('');
        expect(result.total).toBe(rows.length);

        const state = await read();
        expect(state.transactions.map(t => t.description))
          .toEqual(rows.slice(0, result.inserted).map(row => row.description));
        // And a write that did not happen changed nothing else either.
        expect(asComparable(state)).toBe(before);
      });

      rule(['importTransactions'], `B-9: when the store fails mid-import, this engine lands ${BULK_IMPORT[engine].partial}`, async () => {
        // REPORTED, NOT THROWN. "412 of 900 landed" is an outcome the caller
        // has to render — the missing rows are named on screen — so a store
        // that will not answer must come back as a result, not as a rejection
        // the import dialog would turn into "Import failed" and nothing else.
        const port = await harness.createUnreadable();
        const rows = statement();

        const result = await port.importTransactions(ACCOUNT_C, rows);

        expect(result.complete).toBe(false);
        expect(result.total).toBe(rows.length);
        if (BULK_IMPORT[engine].partial === 'all-or-nothing') {
          expect([0, rows.length]).toContain(result.inserted);
        } else {
          expect(result.inserted).toBeGreaterThanOrEqual(0);
          expect(result.inserted).toBeLessThanOrEqual(rows.length);
        }
      });

      rule(['importTransactions'], 'writes nothing at all when the file has no rows', async () => {
        // The ordinary case rather than a caller's mistake: a statement whose
        // every row was already in the register arrives here empty, because the
        // duplicate check ran before anyone knew what would be left.
        const { port, read } = await harness.create({ accounts: threeAccounts() });
        const before = asComparable(await read());

        const result = await port.importTransactions(ACCOUNT_C, []);

        expect(result).toMatchObject({ inserted: 0, alreadyPresent: 0, total: 0, complete: true });
        expect(asComparable(await read())).toBe(before);
      });
    });

    describe('the boot read', () => {
      rule(['loadBootTransactions'], 'hands over every row, with dates the app can use', async () => {
        // Rule 3 of the seam: a Date crosses as a Date. These rows go straight
        // into app state and into the balance maths, and a store that hands
        // back the string it serialised would put "2025-01-10" where every
        // reader expects to call .getTime().
        const { port } = await harness.create({
          accounts: threeAccounts(),
          transactions: [
            aTransaction('txn-1'),
            aTransaction('txn-2', { amount: -20, date: AT('2025-02-14'), description: 'Something else' })
          ]
        });

        const boot = await port.loadBootTransactions();

        expect(boot.transactions.map(transaction => transaction.id).sort()).toEqual(['txn-1', 'txn-2']);
        boot.transactions.forEach(transaction => {
          expect(transaction.date).toBeInstanceOf(Date);
          expect(Number.isNaN(new Date(transaction.date).getTime())).toBe(false);
        });
      });

      rule(['loadBootTransactions'], 'reports honestly how many rows it handed over, and where they came from', async () => {
        // The count is printed on the boot-timing line. A figure that does not
        // match the array beside it is worse than no figure at all: the next
        // slowness report starts from it.
        const { port } = await harness.create({
          accounts: threeAccounts(),
          transactions: [aTransaction('txn-1'), aTransaction('txn-2', { amount: -20 })]
        });

        const boot = await port.loadBootTransactions();

        expect(boot.stats.total).toBe(boot.transactions.length);
        const provenance = BOOT_PROVENANCE[engine];
        if (provenance.snapshots) {
          // Either a snapshot stood (null) or it says why it did not.
          if (boot.stats.fullFetchReason !== null) {
            expect(boot.stats.fullFetchReason).not.toBe('');
          }
          expect(boot.stats.cached + boot.stats.fetched).toBeGreaterThanOrEqual(boot.stats.total);
        } else {
          expect(boot.stats.fullFetchReason).toBe(provenance.reasonWhenUncached);
          expect(boot.stats.cached).toBe(0);
        }
      });

      rule(['loadBootTransactions'], 'answers empty, with the reason said out loud, when the store will not open', async () => {
        // THE rule this slice exists to keep. The boot effect has one outer
        // catch and reaching it replaces the whole app with a "Failed to load
        // data" page — for somebody whose ledger is fine and whose next reload
        // would have worked. A broken store costs an empty list, never a throw.
        const port = await harness.createUnreadable();

        const boot = await port.loadBootTransactions();

        expect(boot.transactions).toEqual([]);
        expect(boot.stats.total).toBe(0);
        expect(typeof boot.stats.fullFetchReason).toBe('string');
        expect(boot.stats.fullFetchReason).not.toBe('');
      });
    });

    describe('server-computed balances', () => {
      rule(['getAccountBalances'], `B-2: this engine ${SERVER_BALANCES[engine]}`, async () => {
        const { port } = await harness.create({
          accounts: threeAccounts(),
          transactions: [aTransaction('txn-1')]
        });

        const balances = await port.getAccountBalances();

        if (SERVER_BALANCES[engine] === 'empty') {
          // Empty means "I don't know", and the app sums the rows itself.
          // THREE entries of zero would be a different answer entirely: the
          // seeding rule keys off the map being non-empty, so a map of zeros
          // would paint every account at £0.00 and call it real money.
          expect(balances.size).toBe(0);
          return;
        }
        expect([...balances.keys()].sort()).toEqual([ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]);
      });

      rule(['getAccountBalances'], 'never rejects, and does not invent zeros, when the store will not open', async () => {
        const port = await harness.createUnreadable();

        const balances = await port.getAccountBalances();

        expect(balances.size).toBe(0);
      });
    });

    describe('preparing the categories', () => {
      rule(['prepareCategories'], `B-4: with nothing stored, this engine ${PREPARE_CATEGORIES[engine].describes}`, async () => {
        // Never empty, whatever the store holds. This is the list the register,
        // the budgets page and every category filter are built from, and the
        // boot does not ask twice — an engine that answered [] here would put a
        // person in front of a ledger with nowhere to file anything and no way
        // to make one.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          categories: []
        });

        const prepared = await port.prepareCategories();

        expect(prepared.length).toBeGreaterThan(0);
        expect(prepared.every(category => typeof category.id === 'string' && category.id !== ''))
          .toBe(true);
        expect(prepared.every(category => typeof category.name === 'string' && category.name !== ''))
          .toBe(true);

        // WHICH IDS, and this is the half `persists` cannot see. An engine that
        // seeded a tree of freshly minted uuids satisfies every assertion above
        // — it wrote something and answered with what it wrote — and has
        // silently become a second id space. The app resolves 'transfer-in',
        // 'transfer-out' and the Transfer anchor BY NAME in its own source, so
        // an engine that renumbered them leaves that code asking for categories
        // the store has never heard of, and nothing throws: the register comes
        // up with its category column blank.
        //
        // The cloud is the one engine that MUST renumber — its `categories.id`
        // is a uuid column and a slug cannot be stored in one — which is why
        // this is a declared row rather than an equality.
        const defaults = getDefaultCategories().map(category => category.id).sort();
        if (PREPARE_CATEGORIES[engine].keepsTheDefaultIds) {
          expect(prepared.map(category => category.id).sort()).toEqual(defaults);
        } else {
          // Renumbered, and therefore NOT the app's ids — asserted, because an
          // engine that started keeping them would have stopped being the engine
          // this row describes.
          expect(prepared.map(category => category.id).sort()).not.toEqual(defaults);
        }

        // Where the engines part company again: whether that set was also
        // written.
        const stored = (await read()).categories;
        if (PREPARE_CATEGORIES[engine].persists) {
          expect(stored.map(category => category.id).sort())
            .toEqual(prepared.map(category => category.id).sort());
        } else {
          expect(stored).toEqual([]);
        }
      });

      rule(['prepareCategories'], 'asked again, it answers the same set and adds nothing to the store', async () => {
        // Rule 85. THE BOOT ASKS THIS EVERY LAUNCH, and two of the three engines
        // are allowed to WRITE while answering it — so "what does the second
        // call do" is a question with a wrong answer, and the wrong answer is
        // silent: a person opens the app on Tuesday and has two of every
        // category, or the eleven they deleted on Monday are back.
        //
        // Asserted for all three, because all three claim it for different
        // reasons: browser storage writes nothing at all, the cloud's migration
        // refuses a second run outright (`categories_already_migrated`) and its
        // caller never reaches it, and a local file gates the seed on having no
        // categories rather than on any single id being absent. Those are three
        // implementations of one promise, and this is the promise.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          categories: []
        });

        const first = await port.prepareCategories();
        const second = await port.prepareCategories();

        expect(first.length).toBeGreaterThan(0);
        expect(second.map(category => category.id).sort())
          .toEqual(first.map(category => category.id).sort());

        const stored = (await read()).categories;
        if (PREPARE_CATEGORIES[engine].persists) {
          expect(stored.map(category => category.id).sort())
            .toEqual(first.map(category => category.id).sort());
        } else {
          expect(stored).toEqual([]);
        }
        // The half a set comparison cannot see: two rows sharing an id would
        // pass every assertion above and be two rows on the page.
        expect(new Set(stored.map(category => category.id)).size).toBe(stored.length);
      });

      rule(['prepareCategories', 'loadBootTransactions', 'listCategories'], 'finishes its work before a transaction read can see the rows', async () => {
        // The ordering the boot depends on, stated where an implementation can
        // be held to it rather than only where it is obeyed.
        //
        // An engine is allowed to renumber categories on first use — the cloud
        // does exactly that, and remaps every transaction and budget reference
        // in the same database transaction. What it is NOT allowed to do is
        // leave that work running behind the promise it just resolved: the app
        // reads its transactions next, and rows carrying the OLD ids would
        // point at categories that no longer exist. Nothing throws when that
        // happens. The register simply comes up with its category column blank.
        //
        // So: whatever prepareCategories resolves with IS the set the rows that
        // follow are filed under, and IS what a later read of the same question
        // gives back.
        const { port } = await harness.create({
          accounts: threeAccounts(),
          categories: [aCategory('cat-everyday', 'Everyday'), aCategory('cat-bills', 'Bills')],
          transactions: [
            aTransaction('txn-1', { category: 'cat-everyday' }),
            aTransaction('txn-2', { amount: -20, category: 'cat-bills' })
          ]
        });

        const prepared = await port.prepareCategories();
        const boot = await port.loadBootTransactions();

        const preparedIds = new Set(prepared.map(category => category.id));
        boot.transactions
          .filter(transaction => transaction.category)
          .forEach(transaction => {
            expect(preparedIds.has(transaction.category)).toBe(true);
          });
        expect((await port.listCategories()).map(category => category.id).sort())
          .toEqual([...preparedIds].sort());
      });
    });

    describe('budgets, goals and custom reports', () => {
      rule(
        ['listBudgets', 'listGoals', 'listCustomReports'],
        'answers for the owner it resolved itself, and only that owner',
        async () => {
        // Rule 1 of the seam: no read takes a user id, every implementation
        // resolves its own owner. That rule has teeth precisely because
        // getting it wrong is SILENT — the wrong owner's budgets are a
        // perfectly well-formed list of amounts, and nothing on screen says
        // whose. Two isolated stores, asked the same question, is the cheapest
        // way to make a mixed-up owner fail here instead of in front of
        // somebody.
        const mine = await harness.create({
          accounts: threeAccounts(),
          budgets: [aBudget('budget-mine', 'cat-everyday', 200)],
          goals: [aGoal('goal-mine', 'New boiler', 1500)],
          customReports: [aCustomReport('report-mine', 'Where it went')]
        });
        const theirs = await harness.create({
          accounts: threeAccounts(),
          budgets: [aBudget('budget-theirs', 'cat-bills', 75)],
          goals: [aGoal('goal-theirs', 'Someone else’s holiday', 900)],
          customReports: [aCustomReport('report-theirs', 'Someone else’s question')]
        });

        expect((await mine.port.listBudgets()).map(budget => budget.id)).toEqual(['budget-mine']);
        expect((await mine.port.listGoals()).map(goal => goal.id)).toEqual(['goal-mine']);
        expect((await mine.port.listCustomReports()).map(report => report.id)).toEqual(['report-mine']);
        expect((await theirs.port.listBudgets()).map(budget => budget.id)).toEqual(['budget-theirs']);
        expect((await theirs.port.listGoals()).map(goal => goal.id)).toEqual(['goal-theirs']);
        expect((await theirs.port.listCustomReports()).map(report => report.id)).toEqual(['report-theirs']);
        }
      );

      rule(['listBudgets', 'listGoals'], 'hands back the amounts it was given, to the penny', async () => {
        // A budget and a goal are money on a page. 0.1 + 0.2 territory again:
        // an engine that round-trips these through a float column would be
        // caught here rather than by a limit that is a penny out.
        const { port } = await harness.create({
          accounts: threeAccounts(),
          budgets: [aBudget('budget-1', 'cat-everyday', 70.1)],
          goals: [aGoal('goal-1', 'Rainy day', 0.3)]
        });

        expect((await port.listBudgets())[0].amount).toBe(70.1);
        expect((await port.listGoals())[0].targetAmount).toBe(0.3);
      });
    });

    describe('writing a budget', () => {
      rule(['createBudget', 'listBudgets', 'updateBudget'], 'round-trips the amount through a create and an edit, to the penny', async () => {
        // A budget is a limit somebody set on purpose, and the page compares
        // it against a Decimal sum of real transactions. An engine that stored
        // it through a float column would put a limit a penny out and then
        // announce it had been exceeded — 0.1 + 0.2 territory, in a place the
        // user is watching. `spent` starts at zero in every engine because it
        // is summed from the ledger, never stored knowledge.
        const { port } = await harness.create({ accounts: threeAccounts() });

        const created = await port.createBudget(aNewBudget('cat-everyday', 70.1));

        expect(created.id).toBeTruthy();
        expect(created.amount).toBe(70.1);
        expect(created.spent).toBe(0);
        expect((await port.listBudgets()).map(budget => [budget.id, budget.amount]))
          .toEqual([[created.id, 70.1]]);

        const edited = await port.updateBudget(created.id, { amount: 0.3 });

        // The whole budget comes back, not just the field that moved: the
        // caller replaces its copy with this answer.
        expect(edited).toMatchObject({ id: created.id, categoryId: 'cat-everyday', amount: 0.3 });
        expect((await port.listBudgets())[0].amount).toBe(0.3);
      });

      rule(['createBudget', 'listBudgets'], `B-3: a budget is filed under ${OWNERSHIP[engine]}`, async () => {
        // Two rules, equal for every engine however it spells "owner".
        //
        // FIRST: no operation ACCEPTS an owner. Stated at runtime and not left
        // to the interface because the interface is only compiled where the
        // implementation is production code — and it is a partial, hand-built
        // port that would grow a `(userId, budget)` signature and start
        // trusting its caller for the one value that must never be trusted.
        //
        // SECOND: a write whose owner could not be resolved does not reach
        // another owner's store. Two isolated stores is the cheapest way to
        // ask, and it is not a hypothetical failure: the service behind the
        // cloud branch treats a null owner as "write the browser's copy",
        // which for a signed-in session is a budget that appears on the page
        // and is gone by morning.
        const mine = await harness.create({ accounts: threeAccounts() });
        const theirs = await harness.create({ accounts: threeAccounts() });

        expect(mine.port.createBudget.length).toBe(1);
        expect(mine.port.updateBudget.length).toBe(2);
        expect(mine.port.deleteBudget.length).toBe(1);

        const created = await mine.port.createBudget(aNewBudget('cat-everyday', 200));

        expect((await mine.read()).budgets.map(budget => budget.id)).toEqual([created.id]);
        expect((await theirs.read()).budgets).toEqual([]);
        expect(await theirs.port.listBudgets()).toEqual([]);
      });

      rule(['createBudget', 'updateBudget', 'listBudgets'], 'keeps an interval of the user’s own, and clears it when the period moves', async () => {
        // ANY REPEAT INTERVAL (7 Nov 2026): 'every' carries its pair; a named
        // rhythm carries none. Both engines hold that by CHECK, so the pair
        // must travel whole on a create, and a stated null must CLEAR it on an
        // update — `undefined` would leave the interval behind on a budget
        // that is now monthly, and the table would refuse the row.
        const { port } = await harness.create({ accounts: threeAccounts() });

        const created = await port.createBudget(
          aNewBudget('cat-everyday', 50, { period: 'every', repeatCount: 2, repeatUnit: 'month' })
        );
        expect(created).toMatchObject({ period: 'every', repeatCount: 2, repeatUnit: 'month' });
        expect((await port.listBudgets())[0]).toMatchObject({ period: 'every', repeatCount: 2, repeatUnit: 'month' });

        const moved = await port.updateBudget(created.id, { period: 'monthly', repeatCount: null, repeatUnit: null });
        expect(moved).toMatchObject({ period: 'monthly', repeatCount: null, repeatUnit: null });

        // "No interval" is the claim, not "a null": a column-backed engine
        // answers null, the browser's store answers what it was given, which
        // is nothing at all. Both are no interval.
        const named = await port.createBudget(aNewBudget('cat-bills', 20));
        expect(named.period).toBe('monthly');
        expect(named.repeatCount ?? null).toBeNull();
        expect(named.repeatUnit ?? null).toBeNull();
      });

      rule(['updateBudget'], 'refuses to change a budget that is not there, and says which', async () => {
        // Not created-on-the-fly: an id that names nothing is a bug upstream
        // (a stale page, a double submit after a delete), and inventing a
        // budget to satisfy it would put an amount somebody never set on the
        // budgets page. Rule 4 of the seam — the message is what the user
        // reads — so it is asserted, not merely the rejection.
        const { port } = await harness.create({
          accounts: threeAccounts(),
          budgets: [aBudget('budget-1', 'cat-everyday', 200)]
        });

        await expect(port.updateBudget('budget-nowhere', { amount: 300 }))
          .rejects.toThrow(/budget not found/i);
      });

      rule(['updateBudget'], 'leaves the store exactly as it was when it refuses', async () => {
        // The all-or-nothing rule the splits and the merge already keep, asked
        // of a planning write: everything is judged before anything is
        // written, so a refusal is never a half-applied edit.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          budgets: [aBudget('budget-1', 'cat-everyday', 200)],
          goals: [aGoal('goal-1', 'New boiler', 1500)]
        });
        const before = asComparable(await read());

        await expect(port.updateBudget('budget-nowhere', { amount: 300 })).rejects.toThrow();

        expect(asComparable(await read())).toBe(before);
      });

      rule(['deleteBudget'], 'treats deleting a budget that has already gone as done, not as an error', async () => {
        // Same rule as a dismissal: a double-click, or a second device that
        // got there first, must not turn a decision into an error message.
        // Idempotence is the point — the second call is not a test of the
        // first, it is the case a slow network actually produces.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          budgets: [aBudget('budget-1', 'cat-everyday', 200)]
        });

        await expect(port.deleteBudget('budget-nowhere')).resolves.toBeUndefined();
        expect((await read()).budgets.map(budget => budget.id)).toEqual(['budget-1']);

        await port.deleteBudget('budget-1');
        await port.deleteBudget('budget-1');

        expect((await read()).budgets).toEqual([]);
      });
    });

    describe('writing a goal', () => {
      rule(['createGoal', 'listGoals', 'updateGoal'], 'round-trips the amounts through a create and an edit, to the penny', async () => {
        // Same reason as the budget above: a goal's target is a figure
        // somebody typed, and the page draws a bar of progress against it. An
        // engine that stored either through a float column would announce a
        // goal reached a penny early, or refuse to call it reached at all.
        const { port } = await harness.create({ accounts: threeAccounts() });

        const created = await port.createGoal(aNewGoal('New boiler', 1500.05));

        expect(created.id).toBeTruthy();
        expect(created.targetAmount).toBe(1500.05);
        expect((await port.listGoals()).map(goal => [goal.id, goal.targetAmount]))
          .toEqual([[created.id, 1500.05]]);

        const edited = await port.updateGoal(created.id, { targetAmount: 0.3 });

        // The whole goal comes back, not just the field that moved: the caller
        // replaces its copy with this answer.
        expect(edited).toMatchObject({ id: created.id, name: 'New boiler', targetAmount: 0.3 });
        expect((await port.listGoals())[0].targetAmount).toBe(0.3);
      });

      rule(['createGoal', 'listGoals'], 'starts a goal at the money already put by, not at zero', async () => {
        // Rule 49. `progress` is the accumulated amount, so a goal written
        // down for something already half saved for begins there. The version
        // of this that hard-coded zero did not merely round down — it lost the
        // opening figure DIFFERENTLY in each engine, banking it in one and
        // discarding it in the other, which is exactly the class of difference
        // this suite exists to catch. The rule is "start at what you were
        // given", not "start at something": a goal set for something not yet
        // saved for begins at zero, which is the first half of this test.
        const { port } = await harness.create({ accounts: threeAccounts() });

        const started = await port.createGoal(aNewGoal('New boiler', 1500));
        expect(started.progress).toBe(0);

        const partway = await port.createGoal(
          aNewGoal('Holiday', 2000, { currentAmount: 250.05 })
        );

        expect(partway.progress).toBe(250.05);
        const stored = (await port.listGoals()).find(goal => goal.id === partway.id);
        expect(stored?.progress).toBe(250.05);
      });

      rule(['createGoal', 'updateGoal', 'listGoals'], 'never carries a goal past its own target', async () => {
        // Rule 50, and it is a rule about the SHAPE of the write rather than
        // about arithmetic here.
        //
        // Contributing to a goal reaches the seam as an ordinary update
        // carrying the new progress — a figure the caller has already added up
        // and already capped at the target. So this operation must SET what it
        // is handed. An engine that read the field as an increment would undo
        // the cap silently: the second contribution below would take a goal
        // that is full to twice its target, and the bar on the page would draw
        // past its own end.
        const { port } = await harness.create({ accounts: threeAccounts() });
        const created = await port.createGoal(
          aNewGoal('New boiler', 1500, { currentAmount: 1200 })
        );

        // £500 put towards a goal £300 short of its target: capped by the
        // caller, stored verbatim here.
        const filled = await port.updateGoal(created.id, { progress: 1500, currentAmount: 1500 });
        expect(filled.progress).toBe(1500);

        // And again, which is what a second click on a full goal produces.
        const again = await port.updateGoal(created.id, { progress: 1500, currentAmount: 1500 });
        expect(again.progress).toBe(1500);
        expect((await port.listGoals())[0].progress).toBe(1500);
      });

      rule(['createGoal', 'listGoals'], `B-3 for goals: a goal is filed under ${OWNERSHIP[engine]}`, async () => {
        // The same pair of rules the budget writes are held to, asked again of
        // the operations that did not exist when it was asked the first time —
        // because both halves of B-3 are per-operation. The arity check cannot
        // be inherited (a new write is exactly where a `(userId, goal)`
        // signature creeps back in), and neither can the isolation check: the
        // service behind the cloud branch treats a null owner as "write the
        // browser's copy" for goals precisely as it does for budgets.
        const mine = await harness.create({ accounts: threeAccounts() });
        const theirs = await harness.create({ accounts: threeAccounts() });

        expect(mine.port.createGoal.length).toBe(1);
        expect(mine.port.updateGoal.length).toBe(2);
        expect(mine.port.deleteGoal.length).toBe(1);

        const created = await mine.port.createGoal(aNewGoal('New boiler', 1500));

        expect((await mine.read()).goals.map(goal => goal.id)).toEqual([created.id]);
        expect((await theirs.read()).goals).toEqual([]);
        expect(await theirs.port.listGoals()).toEqual([]);
      });

      rule(['updateGoal'], 'refuses to change a goal that is not there, and leaves the store exactly as it was', async () => {
        // Two rules in one ask, because they are the same moment: an id that
        // names nothing is a bug upstream (a stale page, a contribution
        // submitted after a delete) and must not quietly become a new goal
        // nobody set — and the judgement happens before the first write, so the
        // refusal is never a half-applied edit. Rule 4 of the seam means the
        // sentence is asserted too, not merely the rejection.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          budgets: [aBudget('budget-1', 'cat-everyday', 200)],
          goals: [aGoal('goal-1', 'New boiler', 1500)]
        });
        const before = asComparable(await read());

        await expect(port.updateGoal('goal-nowhere', { progress: 300 }))
          .rejects.toThrow(/goal not found/i);

        expect(asComparable(await read())).toBe(before);
      });

      rule(['deleteGoal'], 'treats deleting a goal that has already gone as done, not as an error', async () => {
        // Same rule as the budget delete and the dismissal before it: a
        // double-click, or a second device that got there first, must not turn
        // a decision into an error message.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          goals: [aGoal('goal-1', 'New boiler', 1500)]
        });

        await expect(port.deleteGoal('goal-nowhere')).resolves.toBeUndefined();
        expect((await read()).goals.map(goal => goal.id)).toEqual(['goal-1']);

        await port.deleteGoal('goal-1');
        await port.deleteGoal('goal-1');

        expect((await read()).goals).toEqual([]);
      });
    });

    describe('the forecast scenario\u2019s adjustments', () => {
      rule(
        ['setForecastAdjustment', 'clearForecastAdjustment', 'listForecastAdjustments'],
        `B-12: this engine ${ADJUSTMENT_STORAGE[engine]}`,
        async () => {
          const { port } = await harness.create({ accounts: threeAccounts() });

          if (ADJUSTMENT_STORAGE[engine] === 'has nowhere to keep them') {
            await expect(port.setForecastAdjustment('any-category', 90000)).rejects.toThrow();
            // …and the read is not a rejection: the Forecast page draws a
            // scenario that simply follows the base.
            await expect(port.listForecastAdjustments()).resolves.toEqual([]);
            expect(
              port.capabilities().cannotKeep.map(entry => entry.entity)
            ).toContain('forecast_adjustments');
            return;
          }

          // A category of the ledger's own, minted through the seam — the
          // harness seeds none beyond each account's To/From.
          const category = await port.createCategory(aNewCategory('Groceries'));

          // State a figure: £900 a month, as the 90000 pennies it crosses as.
          const stated = await port.setForecastAdjustment(category.id, 90000);
          expect(stated.categoryId).toBe(category.id);
          expect(stated.monthlyMinor).toBe(90000);
          expect(stated.id).toBeTruthy();

          // RESTATE it: the row keeps its identity — the scenario is a single
          // stated figure per category, not a history of edits.
          const restated = await port.setForecastAdjustment(category.id, 75000);
          expect(restated.id).toBe(stated.id);
          expect(restated.monthlyMinor).toBe(75000);
          expect((await port.listForecastAdjustments()).map(row => [row.categoryId, row.monthlyMinor]))
            .toEqual([[category.id, 75000]]);

          // Clear it: back to the base, and clearing again is a successful
          // nothing rather than an error.
          await port.clearForecastAdjustment(category.id);
          await port.clearForecastAdjustment(category.id);
          expect(await port.listForecastAdjustments()).toEqual([]);
        }
      );

      rule(
        ['setForecastAdjustment'],
        'refuses an adjustment on a category the ledger does not hold — the FILE judges it',
        async () => {
          if (ADJUSTMENT_STORAGE[engine] === 'has nowhere to keep them') return;
          const { port } = await harness.create({ accounts: threeAccounts() });

          // The foreign key's refusal, not a check either implementation
          // writes — the dismissal family's discipline, one table over.
          await expect(
            port.setForecastAdjustment('99999999-9999-4999-8999-999999999999', 90000)
          ).rejects.toThrow();
        }
      );
    });

    describe('writing a custom report', () => {
      rule(
        ['createCustomReport', 'listCustomReports', 'updateCustomReport'],
        'round-trips a report through a create and an edit',
        async () => {
          // The five rules the budget and goal blocks above keep, asked of the
          // one entity on this seam that holds no money — so what is checked is
          // not a penny but a DEFINITION, which is the thing a report is.
          const { port } = await harness.create({ accounts: threeAccounts() });

          const created = await port.createCustomReport(aNewCustomReport('Where it went'));

          expect(created.id).toBeTruthy();
          expect(created.name).toBe('Where it went');
          expect((await port.listCustomReports()).map(report => [report.id, report.name]))
            .toEqual([[created.id, 'Where it went']]);

          const edited = await port.updateCustomReport(created.id, { name: 'Where it really went' });

          // The whole report comes back, not just the field that moved: the
          // caller replaces its copy with this answer, so a partial one would
          // blank the components it did not mention.
          expect(edited).toMatchObject({ id: created.id, name: 'Where it really went' });
          expect(edited.components).toHaveLength(1);
          expect((await port.listCustomReports())[0].name).toBe('Where it really went');
        }
      );

      rule(
        ['createCustomReport', 'listCustomReports', 'updateCustomReport'],
        'keeps a report’s components and filters intact, and REPLACES them rather than merging',
        async () => {
          // The rule with no analogue in the planning writes, and the one an
          // engine is most likely to improvise: `updateGoal` MERGES its jsonb
          // (three unrelated fields share that column), and these two columns
          // must not be merged. An engine that merged `components` would make
          // removing a component impossible — the removed one would survive
          // every save, and no screen would explain why it kept coming back.
          const { port } = await harness.create({ accounts: threeAccounts() });

          const created = await port.createCustomReport(aNewCustomReport('Where it went', {
            components: [
              {
                id: 'component-1',
                type: 'summary-stats',
                title: 'Key metrics',
                config: { metrics: ['income', 'expenses'], limit: 10, showLegend: true },
                width: 'full'
              },
              {
                id: 'component-2',
                type: 'pie-chart',
                title: 'By category',
                config: { dataType: 'expenses-by-category' },
                width: 'half'
              }
            ]
          }));

          // Everything survived the crossing — the order, the nested config, the
          // scalar types inside it, and the two filter lists.
          const stored = (await port.listCustomReports())[0];
          expect(stored.components.map(component => component.id)).toEqual(['component-1', 'component-2']);
          expect(stored.components[0].config).toEqual({
            metrics: ['income', 'expenses'], limit: 10, showLegend: true
          });
          expect(stored.components[1]).toMatchObject({ type: 'pie-chart', width: 'half' });
          expect(stored.filters).toMatchObject({
            dateRange: 'month',
            accounts: [ACCOUNT_A],
            categories: ['cat-everyday'],
            tags: ['holiday']
          });

          // One component removed, and the filters narrowed to a different
          // account. A merge would leave two components and both accounts.
          const edited = await port.updateCustomReport(created.id, {
            components: [stored.components[1]],
            filters: { dateRange: 'year', accounts: [ACCOUNT_B] }
          });

          expect(edited.components.map(component => component.id)).toEqual(['component-2']);
          expect(edited.filters.accounts).toEqual([ACCOUNT_B]);
          expect(edited.filters.dateRange).toBe('year');
          // The categories and tags the old filters carried are GONE, because
          // the object replaced rather than merged.
          expect(edited.filters.categories).toBeUndefined();
          expect(edited.filters.tags).toBeUndefined();

          const reread = (await port.listCustomReports())[0];
          expect(reread.components.map(component => component.id)).toEqual(['component-2']);
          expect(reread.filters.accounts).toEqual([ACCOUNT_B]);
        }
      );

      rule(
        ['createCustomReport', 'listCustomReports'],
        `B-3 for reports: a report is filed under ${OWNERSHIP[engine]}`,
        async () => {
          // The same pair of rules the budget and goal writes are held to, asked
          // again of operations that did not exist when it was asked before —
          // because both halves of B-3 are per-operation. The arity check cannot
          // be inherited: a new write is exactly where a `(userId, report)`
          // signature creeps back in.
          const mine = await harness.create({ accounts: threeAccounts() });
          const theirs = await harness.create({ accounts: threeAccounts() });

          expect(mine.port.createCustomReport.length).toBe(1);
          expect(mine.port.updateCustomReport.length).toBe(2);
          expect(mine.port.deleteCustomReport.length).toBe(1);

          const created = await mine.port.createCustomReport(aNewCustomReport('Where it went'));

          expect((await mine.read()).customReports.map(report => report.id)).toEqual([created.id]);
          expect((await theirs.read()).customReports).toEqual([]);
          expect(await theirs.port.listCustomReports()).toEqual([]);
        }
      );

      rule(
        ['updateCustomReport'],
        'refuses to change a report that is not there, and leaves the store exactly as it was',
        async () => {
          // Two rules in one ask, because they are the same moment: an id that
          // names nothing is a bug upstream (a stale page, a save submitted
          // after a delete on another device) and must not quietly become a new
          // report nobody built — and the judgement happens before the first
          // write, so the refusal is never a half-applied edit. Rule 4 of the
          // seam means the sentence is asserted too, not merely the rejection.
          const { port, read } = await harness.create({
            accounts: threeAccounts(),
            customReports: [aCustomReport('report-1', 'Where it went')]
          });
          const before = asComparable(await read());

          await expect(port.updateCustomReport('report-nowhere', { name: 'Nothing' }))
            .rejects.toThrow(/custom report not found/i);

          expect(asComparable(await read())).toBe(before);
        }
      );

      rule(
        ['deleteCustomReport'],
        'treats deleting a report that has already gone as done, not as an error',
        async () => {
          // Same rule as the budget and goal deletes: a double-click, or a
          // second device that got there first, must not turn a decision into an
          // error message.
          const { port, read } = await harness.create({
            accounts: threeAccounts(),
            customReports: [aCustomReport('report-1', 'Where it went')]
          });

          await expect(port.deleteCustomReport('report-nowhere')).resolves.toBeUndefined();
          expect((await read()).customReports.map(report => report.id)).toEqual(['report-1']);

          await port.deleteCustomReport('report-1');
          await port.deleteCustomReport('report-1');

          expect((await read()).customReports).toEqual([]);
        }
      );
    });

    describe('holdings', () => {
      /**
       * The whole of B-12 in one rule, both branches asserted.
       *
       * An engine that keeps holdings stores what it was told and lists it back;
       * one that does not answers an EMPTY LIST from the read and REFUSES the
       * write in words. The asymmetry is the point and is stated on the
       * divergence table: an empty list is a true answer about a portfolio, and
       * a create that resolved having stored nothing would be a false one.
       */
      rule(
        ['createInvestment', 'listInvestments'],
        `B-12: this engine ${INVESTMENT_STORAGE[engine]}`,
        async () => {
          const { port, read } = await harness.create({ accounts: threeAccounts() });

          const draft = {
            accountId: ACCOUNT_B,
            symbol: 'aaaa.l',
            name: 'A Listed Company plc',
            quantity: toDecimal('100'),
            averageCost: toDecimal('32.775'),
            currency: 'GBP',
            assetType: 'stock' as const
          };

          if (INVESTMENT_STORAGE[engine] === 'has nowhere to keep them') {
            await expect(port.createInvestment(draft)).rejects.toThrow();
            // …and the read is not a rejection. A screen has to be able to draw
            // an empty portfolio without a full-page error.
            await expect(port.listInvestments()).resolves.toEqual([]);
            // And it SAYS so, rather than leaving the emptiness unexplained.
            expect(
              port.capabilities().cannotKeep.map(entry => entry.entity)
            ).toContain('investments');
            return;
          }

          const created = await port.createInvestment(draft);
          // THE SYMBOL IS UPPER-CASED before either engine sees it, so both
          // agree, and a portfolio cannot hold `aaaa.l` and `AAAA.L` as two
          // securities one quote can only reach half of.
          expect(created.symbol).toBe('AAAA.L');
          expect(created.quantity.toFixed()).toBe('100');
          // DERIVED, never stated: 100 × 32.775 = 3277.50. No draft anywhere
          // carries a cost of its own, because two numbers that must agree are
          // two numbers that will not.
          expect(created.costBasis.toFixed(2)).toBe('3277.50');
          // A position nobody has fetched a price for is NEVER PRICED, which is
          // a different thing from worth nothing.
          expect(created.currentPrice).toBeNull();
          expect(created.marketValue).toBeNull();

          const listed = await port.listInvestments();
          expect(listed.map(holding => holding.symbol)).toEqual(['AAAA.L']);

          // The independent witness: it really landed in the store, at the
          // figures the port answered with.
          const stored = (await read()).investments;
          expect(stored.map(holding => holding.symbol)).toEqual(['AAAA.L']);
          expect(stored[0].costBasis.toFixed(2)).toBe('3277.50');
          expect(stored[0].quantity.toFixed()).toBe('100');
        }
      );

      rule(
        ['createInvestment', 'updateInvestment', 'listInvestments'],
        'moves a position’s cost when either figure behind it moves, and leaves it alone otherwise',
        async () => {
          if (INVESTMENT_STORAGE[engine] === 'has nowhere to keep them') return;
          const { port, read } = await harness.create({ accounts: threeAccounts() });

          const created = await port.createInvestment({
            accountId: ACCOUNT_B,
            symbol: 'AAAA.L',
            name: 'A Listed Company plc',
            quantity: toDecimal('100'),
            averageCost: toDecimal('32.775'),
            currency: 'GBP'
          });

          // QUANTITY ALONE. The stored unit cost supplies the other half, or the
          // row would describe a position that was never held — the cloud's own
          // sentence, and the reason this is a rule rather than an engine's
          // habit.
          await port.updateInvestment(created.id, { quantity: toDecimal('200') });
          expect((await read()).investments[0].costBasis.toFixed(2)).toBe('6555.00');

          // A field that is neither leaves the cost exactly as it was.
          await port.updateInvestment(created.id, { name: 'A Listed Company' });
          const after = (await read()).investments[0];
          expect(after.costBasis.toFixed(2)).toBe('6555.00');
          expect(after.name).toBe('A Listed Company');
        }
      );

      rule(['updateInvestment'], 'refuses to change a holding that is not there, and leaves the store exactly as it was', async () => {
        if (INVESTMENT_STORAGE[engine] === 'has nowhere to keep them') return;
        const { port, read } = await harness.create({ accounts: threeAccounts() });
        const created = await port.createInvestment({
          accountId: ACCOUNT_B,
          symbol: 'AAAA.L',
          name: 'A Listed Company plc',
          quantity: toDecimal('10'),
          averageCost: toDecimal('5.00'),
          currency: 'GBP'
        });
        const before = (await read()).investments;

        await expect(
          port.updateInvestment('holding-nowhere', { name: 'Nothing' })
        ).rejects.toThrow();

        const now = (await read()).investments;
        expect(now).toHaveLength(before.length);
        expect(now[0].id).toBe(created.id);
        expect(now[0].name).toBe('A Listed Company plc');
      });

      rule(['deleteInvestment'], 'treats deleting a holding that has already gone as done, not as an error', async () => {
        if (INVESTMENT_STORAGE[engine] === 'has nowhere to keep them') return;
        const { port, read } = await harness.create({ accounts: threeAccounts() });
        const created = await port.createInvestment({
          accountId: ACCOUNT_B,
          symbol: 'AAAA.L',
          name: 'A Listed Company plc',
          quantity: toDecimal('10'),
          averageCost: toDecimal('5.00'),
          currency: 'GBP'
        });

        await expect(port.deleteInvestment('holding-nowhere')).resolves.toBeUndefined();
        expect((await read()).investments).toHaveLength(1);

        await port.deleteInvestment(created.id);
        await port.deleteInvestment(created.id);
        expect((await read()).investments).toEqual([]);
      });

      rule(
        ['createInvestment', 'applyInvestmentPrices', 'listInvestments'],
        'prices every row of a symbol, counts the rows rather than the quotes, and computes the value it does not store',
        async () => {
          if (INVESTMENT_STORAGE[engine] === 'has nowhere to keep them') return;
          const { port, read } = await harness.create({ accounts: threeAccounts() });

          // The same security in two accounts — an ISA and a dealing account is
          // the ordinary case, and it is why a quote is matched by SYMBOL.
          for (const accountId of [ACCOUNT_B, ACCOUNT_C]) {
            await port.createInvestment({
              accountId,
              symbol: 'AAAA.L',
              name: 'A Listed Company plc',
              quantity: toDecimal('10'),
              averageCost: toDecimal('5.00'),
              currency: 'GBP'
            });
          }

          const repriced = await port.applyInvestmentPrices([
            { symbol: 'AAAA.L', price: '32.775', asOf: '2026-08-11T16:35:00.000Z' },
            // A symbol nobody holds contributes ZERO, which is what makes
            // "3 of 5 updated" an honest sentence rather than a claim.
            { symbol: 'NOBODY.L', price: '1.00', asOf: '2026-08-11T16:35:00.000Z' }
          ]);
          expect(repriced).toBe(2);

          const listed = await port.listInvestments();
          expect(listed).toHaveLength(2);
          for (const holding of listed) {
            expect(holding.currentPrice?.toFixed()).toBe('32.775');
            // COMPUTED, not stored: 10 × 32.775 = 327.75. No engine keeps a
            // market value, because a stored copy of a derived number is a copy
            // that goes stale — so a holding can never show a value its own
            // price contradicts.
            expect(holding.marketValue?.toFixed(2)).toBe('327.75');
            // And the user's own figures were not touched by a price refresh.
            expect(holding.quantity.toFixed()).toBe('10');
            expect(holding.costBasis.toFixed(2)).toBe('50.00');
          }
          expect((await read()).investments).toHaveLength(2);
        }
      );

      rule(['applyInvestmentPrices'], 'writes nothing at all when there are no quotes', async () => {
        // The ordinary case rather than a caller's mistake: every symbol may
        // have failed to fetch. Asserted on EVERY engine, including the one with
        // nowhere to keep a holding — an empty sweep must not be the thing that
        // raises "sign in" at somebody who pressed nothing.
        const { port, read } = await harness.create({ accounts: threeAccounts() });
        await expect(port.applyInvestmentPrices([])).resolves.toBe(0);
        expect((await read()).investments).toEqual([]);
      });

      rule(['createInvestment', 'listInvestments'], 'answers for the owner it resolved itself, and only that owner', async () => {
        if (INVESTMENT_STORAGE[engine] === 'has nowhere to keep them') return;
        // Two stores, and neither may see the other's positions. A holding rolls
        // up into a portfolio figure, so one filed against a stranger's account
        // moves a number nobody can explain — which is why `schema.sql` gives
        // this table the R-12 composite key as well.
        const mine = await harness.create({ accounts: threeAccounts() });
        const theirs = await harness.create({ accounts: threeAccounts() });

        await mine.port.createInvestment({
          accountId: ACCOUNT_B,
          symbol: 'MINE.L',
          name: 'Mine',
          quantity: toDecimal('1'),
          averageCost: toDecimal('1.00'),
          currency: 'GBP'
        });

        expect((await mine.port.listInvestments()).map(h => h.symbol)).toEqual(['MINE.L']);
        expect(await theirs.port.listInvestments()).toEqual([]);
      });
    });

    describe('writing a category', () => {
      rule(['deleteCategory'], 'removes the categories under a category it removes', async () => {
        // Rule 51. The cascade is a rule of the SEAM, not an artefact of the
        // cloud's foreign key: an engine with no foreign keys to inherit it
        // from would otherwise leave a group's children behind as orphans
        // pointing at a parent that is gone — which reads on the categories
        // page as a set of headings that cannot be expanded and cannot be
        // deleted, because nothing lists them any more.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          categories: [
            aCategory('cat-group', 'Motoring', { level: 'sub' }),
            aCategory('cat-child', 'Fuel', { parentId: 'cat-group' }),
            aCategory('cat-other', 'Groceries')
          ]
        });

        await port.deleteCategory('cat-group');

        expect((await read()).categories.map(category => category.id)).toEqual(['cat-other']);
      });

      rule(['createCategories'], 'writes nothing when a bulk create is given nothing, and every row when it is given some', async () => {
        // Rule 52, and the empty half is the ordinary case rather than a
        // caller's mistake: a tree import that only adds detail to groups the
        // account already has plans no new groups at all, and asks anyway,
        // because the plan is computed before it is known to be empty. An
        // engine that opened a transaction, or sent an insert with no rows, to
        // answer that would be doing work — and in some drivers, failing —
        // over nothing.
        //
        // The second half is what stops the first from being satisfied by an
        // operation that always writes nothing.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          categories: [aCategory('cat-1', 'Groceries')]
        });
        const before = asComparable(await read());

        expect(await port.createCategories([])).toEqual([]);
        expect(asComparable(await read())).toBe(before);

        const created = await port.createCategories([
          aNewCategory('Fuel'),
          aNewCategory('Parking')
        ]);

        expect(created.map(category => category.name).sort()).toEqual(['Fuel', 'Parking']);
        expect((await read()).categories.map(category => category.name).sort())
          .toEqual(['Fuel', 'Groceries', 'Parking']);
      });

      rule(['deleteUnusedCategories'], `B-6: a bulk prune ${BULK_PRUNE[engine].describes}`, async () => {
        // Rule 53. The plan a prune is handed was computed from a snapshot, and
        // the gap between computing it and running it is long enough for
        // somebody to file a transaction under one of the categories in it —
        // in another tab, on a phone, or in the seconds the import spent
        // inserting the new tree. An engine that can see the ledger judges the
        // rows as they are NOW and keeps that one; browser storage IS the
        // snapshot, so it has no second opinion to consult and does what it
        // was told. Both are declared in BULK_PRUNE above rather than
        // discovered here.
        //
        // What is asserted for both, and is the whole of B-6: the number that
        // comes back is the number of rows that actually went.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          categories: [
            aCategory('cat-used', 'Groceries'),
            aCategory('cat-unused', 'Something nobody filed anything under')
          ],
          transactions: [aTransaction('txn-1', { category: 'cat-used' })]
        });
        const before = (await read()).categories.length;

        const removed = await port.deleteUnusedCategories(['cat-unused', 'cat-used']);

        const after = (await read()).categories;
        if (BULK_PRUNE[engine].reverifies) {
          expect(after.map(category => category.id)).toEqual(['cat-used']);
        } else {
          expect(after).toEqual([]);
        }
        expect(removed).toBe(before - after.length);
      });

      rule(['deleteUnusedCategories'], 'never invents the count: it is what actually went, not what was asked for', async () => {
        // The other half of B-6, and the one the caller prints. `importCategoryTree`
        // shows this figure to the user ("pruned 40, kept 12 still in use") and
        // re-reads the whole category set BECAUSE it cannot be derived from the
        // request — an id naming nothing removes nothing, and an id naming a
        // group removes the group's children with it. Returning the size of the
        // list would be a guess in the shape of a fact.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          categories: [
            aCategory('cat-group', 'Motoring', { level: 'sub' }),
            aCategory('cat-child', 'Fuel', { parentId: 'cat-group' }),
            aCategory('cat-keep', 'Groceries')
          ]
        });

        const untouched = asComparable(await read());
        expect(await port.deleteUnusedCategories([])).toBe(0);
        expect(asComparable(await read())).toBe(untouched);

        // Two ids, one of which names nothing.
        const beforeNowhere = (await read()).categories.length;
        const removedNowhere = await port.deleteUnusedCategories(['cat-keep', 'cat-nowhere']);
        const afterNowhere = (await read()).categories.length;
        expect(removedNowhere).toBe(beforeNowhere - afterNowhere);

        // One id, which may take more than one row with it.
        const beforeGroup = afterNowhere;
        const removedGroup = await port.deleteUnusedCategories(['cat-group']);
        const afterGroup = (await read()).categories.length;
        expect(removedGroup).toBe(beforeGroup - afterGroup);
      });

      rule(['createCategory', 'createCategories'], 'gives every new category an id of its own', async () => {
        // Rule 54. Two categories created in a row must not come back sharing
        // an id — an engine that answered with a constant, or that reused the
        // last one, would have the second name silently overwrite the first in
        // every list keyed by id, and the transactions filed under one would
        // appear under the other.
        const { port, read } = await harness.create({ accounts: threeAccounts() });

        const first = await port.createCategory(aNewCategory('Motoring', { level: 'sub' }));
        const second = await port.createCategory(aNewCategory('Household', { level: 'sub' }));

        expect(first.id).toBeTruthy();
        expect(second.id).toBeTruthy();
        expect(second.id).not.toBe(first.id);

        const bulk = await port.createCategories([aNewCategory('Parking'), aNewCategory('Tolls')]);

        expect(bulk).toHaveLength(2);
        expect(new Set(bulk.map(category => category.id)).size).toBe(2);

        const stored = (await read()).categories;
        expect(new Set(stored.map(category => category.id)).size).toBe(stored.length);
      });

      rule(['createCategory', 'updateCategory'], `B-5: a new category comes back with ${ID_PROVENANCE[engine]}, usable at once`, async () => {
        // Where the id is minted is declared, not asserted. What is asserted is
        // that it is FINAL: the callers use it on the next line — as the value
        // of the select they just added an option to, and as the parentId of
        // the children a tree import creates in its second pass — so an engine
        // that handed back a placeholder it meant to renumber later would file
        // transactions under an id that stops existing.
        const { port, read } = await harness.create({ accounts: threeAccounts() });

        const parent = await port.createCategory(aNewCategory('Motoring', { level: 'sub' }));
        const child = await port.createCategory(aNewCategory('Fuel', { parentId: parent.id }));

        expect(child.parentId).toBe(parent.id);

        const stored = (await read()).categories;
        expect(stored.find(category => category.id === parent.id)?.name).toBe('Motoring');
        expect(stored.find(category => category.id === child.id)?.parentId).toBe(parent.id);

        // And the id survives an edit made through it, which is the other way
        // the caller uses what it was handed.
        const renamed = await port.updateCategory(parent.id, { name: 'Car' });
        expect(renamed.id).toBe(parent.id);
        expect(renamed.name).toBe('Car');
      });
    });

    describe('splits', () => {
      rule(['setTransactionSplits'], 'leaves the store untouched when it refuses', async () => {
        // All-or-nothing. Every check runs before the first write, so a
        // refusal is not a half-written split — and the transaction being
        // edited already HAS lines, so a writer that clears them before
        // validating would be caught here rather than by the user.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          categories: filingCategories(),
          transactions: [aTransaction('txn-1', { amount: -30, isSplit: true, category: '' })],
          splits: [
            { id: 'line-1', transactionId: 'txn-1', category: 'cat-everyday', amount: -10, sortOrder: 1 },
            { id: 'line-2', transactionId: 'txn-1', category: 'cat-bills', amount: -20, sortOrder: 2 }
          ]
        });
        const before = asComparable(await read());

        await expect(
          port.setTransactionSplits('txn-1', [{ id: 'line-1', category: 'cat-everyday', amount: -30 }], null)
        ).rejects.toThrow(/at least 2 lines/i);

        expect(asComparable(await read())).toBe(before);
      });

      rule(['setTransactionSplits'], 'refuses a set that does not sum to the amount it was told to expect', async () => {
        const { port } = await harness.create({
          accounts: threeAccounts(),
          categories: filingCategories(),
          transactions: [aTransaction('txn-1', { amount: -70.1 })]
        });

        await expect(
          port.setTransactionSplits(
            'txn-1',
            [
              { category: 'cat-everyday', amount: -0.2 },
              { category: 'cat-bills', amount: -70.1 }
            ],
            -70.1
          )
          // The clause both engines say, rather than either one's sentence. The
          // cloud names the two figures ("split lines sum to −70.30 but the
          // transaction amount is −70.10") and browser storage does not ("The
          // split lines must sum to the transaction amount"); naming them is
          // better, so the assertion is on what they agree about — a phrasing
          // that admits the extra half is not a weaker rule than one that
          // forbids it.
        ).rejects.toThrow(/sum to[\s\S]*the transaction amount/i);
      });

      rule(['listTransactionSplitsFor'], 'reads a split back in display order', async () => {
        // `category: ''` on the parent, like the other three split fixtures in
        // this file. A split parent's categorisation lives in its LINES, and a
        // store is entitled to insist: the local engine's schema spells it
        // `transactions_split_parent_has_blank_category`, and it refused this
        // fixture on the first run of the second engine — which is the whole
        // reason a contract suite is written against more than one.
        const { port } = await harness.create({
          accounts: threeAccounts(),
          categories: filingCategories(),
          transactions: [aTransaction('txn-1', { amount: -30, isSplit: true, category: '' })],
          splits: [
            { id: 'line-2', transactionId: 'txn-1', category: 'cat-bills', amount: -20, sortOrder: 2 },
            { id: 'line-1', transactionId: 'txn-1', category: 'cat-everyday', amount: -10, sortOrder: 1 }
          ]
        });

        const lines = await port.listTransactionSplitsFor('txn-1');
        expect(lines.map(line => line.id)).toEqual(['line-1', 'line-2']);
      });

      describe('a line that is half of a transfer', () => {
        // The rule, precisely: such a line may change its position and its
        // memo. Everything else about it belongs to the row on the other side,
        // and changing it there would strand or falsify that row. Each refusal
        // says which line and which account, because the user has to be able
        // to act on it.
        const splitWithALeg = (): PortFixture => ({
          accounts: threeAccounts(),
          categories: filingCategories(),
          transactions: [
            aTransaction('txn-parent', { amount: -30, isSplit: true, category: '' }),
            aTransaction('txn-leg', {
              accountId: ACCOUNT_B,
              amount: 20,
              type: 'transfer',
              category: 'cat-transfer-a',
              transferAccountId: ACCOUNT_A,
              linkedTransferId: 'txn-parent',
              linkedTransferSplitId: 'line-leg'
            })
          ],
          splits: [
            {
              id: 'line-plain',
              transactionId: 'txn-parent',
              category: 'cat-everyday',
              amount: -10,
              sortOrder: 1
            },
            {
              id: 'line-leg',
              transactionId: 'txn-parent',
              category: 'cat-transfer-b',
              amount: -20,
              sortOrder: 2,
              transferAccountId: ACCOUNT_B,
              linkedTransferId: 'txn-leg'
            }
          ]
        });

        rule(['setTransactionSplits'], 'refuses to drop it, and changes nothing', async () => {
          // TWO lines, one of them new, so the ONLY rule this payload breaks is
          // the one it is about. Sending a single line dropped the leg AND took
          // the split below its two-line minimum, and which of the two an
          // engine mentions is decided by the order it checks them in — so the
          // test was asking a question about ordering while claiming to ask one
          // about transfer legs.
          const { port, read } = await harness.create(splitWithALeg());
          const before = asComparable(await read());

          await expect(
            port.setTransactionSplits(
              'txn-parent',
              [
                { id: 'line-plain', category: 'cat-everyday', amount: -10 },
                { category: 'cat-bills', amount: -20 }
              ],
              null
            )
          ).rejects.toThrow(/one half of a transfer/i);

          expect(asComparable(await read())).toBe(before);
        });

        rule(['setTransactionSplits'], 'refuses to change its amount', async () => {
          const { port } = await harness.create(splitWithALeg());

          await expect(
            port.setTransactionSplits(
              'txn-parent',
              [
                { id: 'line-plain', category: 'cat-everyday', amount: -10 },
                { id: 'line-leg', category: 'cat-transfer-b', amount: -25, transferAccountId: ACCOUNT_B }
              ],
              null
            )
            // Again the shared clause: the cloud names the figure the line has
            // to stay at and browser storage says "as it is". What both promise
            // — and the half that tells somebody what to do about it — is the
            // reason.
          ).rejects.toThrow(/the transaction on the other side is for exactly that much/i);
        });

        rule(['setTransactionSplits'], 'refuses to point it at a different account', async () => {
          const { port } = await harness.create(splitWithALeg());

          await expect(
            port.setTransactionSplits(
              'txn-parent',
              [
                { id: 'line-plain', category: 'cat-everyday', amount: -10 },
                { id: 'line-leg', category: 'cat-transfer-b', amount: -20, transferAccountId: ACCOUNT_C }
              ],
              null
            )
          ).rejects.toThrow(/would strand that row/i);
        });

        rule(['setTransactionSplits'], 'refuses to re-file it under another category', async () => {
          const { port } = await harness.create(splitWithALeg());

          await expect(
            port.setTransactionSplits(
              'txn-parent',
              [
                { id: 'line-plain', category: 'cat-everyday', amount: -10 },
                { id: 'line-leg', category: 'cat-everyday', amount: -20, transferAccountId: ACCOUNT_B }
              ],
              null
            )
          ).rejects.toThrow(/one half of a transfer/i);
        });

        rule(['setTransactionSplits'], 'lets the line beside it be re-filed', async () => {
          // The whole point of the rule being this narrow: the rest of the
          // split is ordinary and must stay editable.
          const { port, read } = await harness.create(splitWithALeg());

          const result = await port.setTransactionSplits(
            'txn-parent',
            [
              { id: 'line-plain', category: 'cat-bills', amount: -10 },
              { id: 'line-leg', category: 'cat-transfer-b', amount: -20, transferAccountId: ACCOUNT_B }
            ],
            -30
          );

          expect(result.isSplit).toBe(true);
          expect(result.splitCount).toBe(2);
          const lines = (await read()).splits.filter(line => line.transactionId === 'txn-parent');
          expect(lines.find(line => line.id === 'line-plain')?.category).toBe('cat-bills');
          // The leg is exactly as it was, link and all.
          expect(lines.find(line => line.id === 'line-leg')).toMatchObject({
            category: 'cat-transfer-b',
            amount: -20,
            transferAccountId: ACCOUNT_B,
            linkedTransferId: 'txn-leg'
          });
        });
      });
    });

    describe('transfer pairing', () => {
      const twoSides = (rest: Partial<Transaction> = {}): PortFixture => ({
        accounts: threeAccounts(),
        categories: filingCategories(),
        transactions: [
          aTransaction('txn-out', { accountId: ACCOUNT_A, amount: -25 }),
          aTransaction('txn-in', { accountId: ACCOUNT_B, amount: 25, type: 'income', ...rest })
        ]
      });

      rule(['linkTransferPair'], 'links two rows without moving a penny', async () => {
        const { port, read } = await harness.create(twoSides());

        const { a, b } = await port.linkTransferPair('txn-out', 'txn-in');

        expect(a.type).toBe('transfer');
        expect(b.type).toBe('transfer');
        expect(a.linkedTransferId).toBe('txn-in');
        expect(b.linkedTransferId).toBe('txn-out');

        const state = await read();
        expect(balanceOf(state, ACCOUNT_A)).toBe(-70.1);
        expect(balanceOf(state, ACCOUNT_B)).toBe(500);
      });

      rule(['linkTransferPair'], 'refuses two rows in the same account', async () => {
        const { port } = await harness.create({
          accounts: threeAccounts(),
          transactions: [
            aTransaction('txn-out', { amount: -25 }),
            aTransaction('txn-in', { amount: 25, type: 'income' })
          ]
        });

        await expect(port.linkTransferPair('txn-out', 'txn-in'))
          .rejects.toThrow(/two different accounts/i);
      });

      // `threeAccounts()` is entirely GBP, which is load-bearing here rather
      // than incidental: this rule states the SAME-CURRENCY guard, and the
      // four rules after it state the cross-currency one. A cross-currency
      // fixture reaching this rule would silently turn it into a test of the
      // other branch — and it would still pass, which is the dangerous part.
      rule(['linkTransferPair'], 'refuses amounts that are not exact opposites, in one currency', async () => {
        const { port } = await harness.create({
          accounts: threeAccounts(),
          transactions: [
            aTransaction('txn-out', { accountId: ACCOUNT_A, amount: -25 }),
            aTransaction('txn-in', { accountId: ACCOUNT_B, amount: 24, type: 'income' })
          ]
        });

        await expect(port.linkTransferPair('txn-out', 'txn-in'))
          .rejects.toThrow(/opposite non-zero amounts/i);
      });

      /**
       * Two accounts that do not share a currency, and a pair whose magnitudes
       * therefore do NOT cancel — the shape every real conversion has, and the
       * shape the old unconditional guard refused every single time.
       *
       * The rate here is deliberately not a round number: a fixture of ±25
       * across a boundary would pass under both the old rule and the new one
       * and prove nothing about which is in force.
       */
      const acrossACurrencyBoundary = (
        outAmount: number,
        inAmount: number,
        inType: Transaction['type'] = 'income'
      ): Parameters<typeof harness.create>[0] => ({
        accounts: [
          anAccount(ACCOUNT_A, 'Everyday', { balance: -70.1 }),
          anAccount(ACCOUNT_B, 'Dollars', { type: 'savings', balance: 500, currency: 'USD' }),
          anAccount(ACCOUNT_C, 'Spare', { type: 'savings', balance: 0 })
        ],
        categories: filingCategories(),
        transactions: [
          aTransaction('txn-out', { accountId: ACCOUNT_A, amount: outAmount }),
          aTransaction('txn-in', { accountId: ACCOUNT_B, amount: inAmount, type: inType })
        ]
      });

      rule(['linkTransferPair'], 'links two rows in different currencies whose magnitudes differ', async () => {
        const { port, read } = await harness.create(acrossACurrencyBoundary(-25, 31.75));

        const { a, b } = await port.linkTransferPair('txn-out', 'txn-in');

        expect(a.type).toBe('transfer');
        expect(b.type).toBe('transfer');
        expect(a.linkedTransferId).toBe('txn-in');
        expect(b.linkedTransferId).toBe('txn-out');

        // The point of the whole feature, asserted rather than argued: each
        // side still counts against its own account in its own currency, and
        // linking converted nothing. Neither balance moved.
        const state = await read();
        expect(balanceOf(state, ACCOUNT_A)).toBe(-70.1);
        expect(balanceOf(state, ACCOUNT_B)).toBe(500);
      });

      rule(['linkTransferPair'], 'refuses two rows in different currencies that move the same way', async () => {
        const { port } = await harness.create(acrossACurrencyBoundary(-25, -31.75, 'expense'));

        await expect(port.linkTransferPair('txn-out', 'txn-in'))
          .rejects.toThrow(/opposite in sign/i);
      });

      rule(['linkTransferPair'], 'refuses a zero side across a currency boundary', async () => {
        // Zero is neither leaving nor arriving. Asserted from the SECOND
        // position specifically: the same-currency rule catches a zero second
        // side through its negation test, and there is no negation in the
        // cross-currency rule to catch it — so this is the assertion that
        // would fail if an engine ported the loosening by deleting a clause.
        const { port } = await harness.create(acrossACurrencyBoundary(-25, 0));

        await expect(port.linkTransferPair('txn-out', 'txn-in'))
          .rejects.toThrow(/opposite in sign and non-zero/i);
      });

      // NOT A RULE HERE: "an unknown currency falls to the strict branch".
      //
      // All three engines implement it and the reasoning is written at each
      // one, but it cannot be a shared rule, because the local engine cannot
      // hold the fixture: `accounts_currency_shaped` (schema.sql:525) is
      // `length(currency) = 3`, so an absent currency is unstorable there by
      // construction, and the cloud's column is nullable only for legacy rows.
      // A rule one engine can never satisfy is not a contract — it is a
      // permanent red, or worse, an excuse list.

      rule(['linkTransferPair'], 'refuses a split transaction', async () => {
        // `category: ''` beside `isSplit`, like every other split fixture in
        // this file: a split parent's categorisation lives in its LINES, and a
        // store is entitled to insist (the local schema spells it
        // `transactions_split_parent_has_blank_category`).
        const { port } = await harness.create(twoSides({ isSplit: true, category: '' }));

        await expect(port.linkTransferPair('txn-out', 'txn-in'))
          .rejects.toThrow(/split transaction cannot become a transfer/i);
      });

      rule(['linkTransferPair'], 'refuses a row that is already linked', async () => {
        // A row that is half of a transfer names the account on the other side
        // as well as the row: the two travel together everywhere the app writes
        // them, and a store is entitled to insist on the pair
        // (`transactions_linked_has_target`). The counterpart is left out on
        // purpose — this is a STRANDED leg, which is a real state with a repair
        // flow, and it is still already linked as far as this operation cares.
        const { port } = await harness.create({
          accounts: threeAccounts(),
          categories: filingCategories(),
          transactions: [
            aTransaction('txn-out', { accountId: ACCOUNT_A, amount: -25 }),
            aTransaction('txn-in', {
              accountId: ACCOUNT_B,
              amount: 25,
              type: 'transfer',
              category: 'cat-transfer-a',
              transferAccountId: ACCOUNT_C,
              linkedTransferId: 'txn-elsewhere'
            }),
            aTransaction('txn-elsewhere', {
              accountId: ACCOUNT_C,
              amount: -25,
              type: 'transfer',
              category: 'cat-transfer-b',
              transferAccountId: ACCOUNT_B,
              linkedTransferId: 'txn-in'
            })
          ]
        });

        await expect(port.linkTransferPair('txn-out', 'txn-in'))
          .rejects.toThrow(/already part of a linked transfer/i);
      });

      rule(['unlinkTransfers'], 'unlinks only the rows it can, and counts them', async () => {
        // The third row is the interesting one, and it needs the whole shape
        // around it to BE that row: a split parent with a line that is one half
        // of a transfer, and the counterpart over in the other account. Named
        // links used to be enough here, pointing at a parent and a line the
        // fixture did not contain — which is a ledger no store can hold (the
        // local schema's `transactions_linked_has_target`, and the two foreign
        // keys behind the split leg). Written out, it is also clearer about
        // what is being asked: the leg's link lives on the LINE, so unlinking
        // it from the row would leave the line pointing at nothing.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          categories: filingCategories(),
          transactions: [
            aTransaction('txn-out', {
              accountId: ACCOUNT_A,
              amount: -25,
              type: 'transfer',
              category: 'cat-transfer-b',
              transferAccountId: ACCOUNT_B,
              linkedTransferId: 'txn-in'
            }),
            aTransaction('txn-in', {
              accountId: ACCOUNT_B,
              amount: 25,
              type: 'transfer',
              category: 'cat-transfer-a',
              transferAccountId: ACCOUNT_A,
              linkedTransferId: 'txn-out'
            }),
            aTransaction('txn-parent', { amount: -30, isSplit: true, category: '' }),
            // The opposite side of a split LINE: its link also lives on the
            // line, so unlinking it here would leave the line pointing at
            // nothing. Skipped, not counted, in every engine.
            aTransaction('txn-leg', {
              accountId: ACCOUNT_B,
              amount: 5,
              type: 'transfer',
              category: 'cat-transfer-a',
              transferAccountId: ACCOUNT_A,
              linkedTransferId: 'txn-parent',
              linkedTransferSplitId: 'line-leg'
            })
          ],
          splits: [
            { id: 'line-plain', transactionId: 'txn-parent', category: 'cat-everyday', amount: -25, sortOrder: 1 },
            {
              id: 'line-leg',
              transactionId: 'txn-parent',
              category: 'cat-transfer-b',
              amount: -5,
              sortOrder: 2,
              transferAccountId: ACCOUNT_B,
              linkedTransferId: 'txn-leg'
            }
          ]
        });

        const count = await port.unlinkTransfers(['txn-out', 'txn-in', 'txn-leg']);

        expect(count).toBe(2);
        const state = await read();
        expect(transactionOf(state, 'txn-out')?.linkedTransferId).toBeUndefined();
        expect(transactionOf(state, 'txn-leg')?.linkedTransferId).toBe('txn-parent');
      });
    });

    describe('category merge', () => {
      const mergeFixture = (): PortFixture => ({
        accounts: threeAccounts(),
        categories: [
          aCategory('cat-source', 'Coffee'),
          aCategory('cat-target', 'Eating out'),
          aCategory('cat-heading-source', 'Spending', { level: 'type' }),
          aCategory('cat-heading-target', 'Saving', { level: 'type' })
        ],
        transactions: [
          aTransaction('txn-1', { category: 'cat-source' }),
          aTransaction('txn-2', { category: 'cat-target' }),
          // A split parent, so its categorisation lives in its LINES and its own
          // category column is blank — the rule every other split fixture here
          // keeps, and a constraint in the engine that has one. The fourth row
          // is what keeps this fixture asking the same question it always did:
          // the counts below distinguish WHOLE transactions moved from split
          // LINES moved, so the whole-transaction side needs two rows of its own
          // now that the parent is not one of them.
          aTransaction('txn-3', { category: '', isSplit: true, amount: -30 }),
          aTransaction('txn-4', { category: 'cat-source' })
        ],
        splits: [
          { id: 'line-1', transactionId: 'txn-3', category: 'cat-source', amount: -10, sortOrder: 1 },
          { id: 'line-2', transactionId: 'txn-3', category: 'cat-source', amount: -20, sortOrder: 2 }
        ],
        budgets: [
          {
            id: 'budget-1',
            categoryId: 'cat-source',
            amount: 50,
            period: 'monthly',
            isActive: true,
            spent: 0,
            createdAt: AT('2025-01-01'),
            updatedAt: AT('2025-01-01')
          }
        ]
      });

      rule(['mergeCategories'], 'moves every reference, then removes the source', async () => {
        const { port, read } = await harness.create(mergeFixture());

        const result = await port.mergeCategories('cat-source', 'cat-target');

        expect(result).toMatchObject({
          sourceId: 'cat-source',
          targetId: 'cat-target',
          transactions: 2,
          splitLines: 2,
          // Two lines of ONE parent: the lines stay two, because adding them
          // together would destroy the user's own breakdown.
          splitTransactions: 1,
          budgets: 1
        });

        const state = await read();
        expect(state.categories.some(category => category.id === 'cat-source')).toBe(false);
        expect(state.transactions.filter(t => t.category === 'cat-target')).toHaveLength(3);
        expect(state.splits.every(line => line.category === 'cat-target')).toBe(true);
        expect(state.budgets[0].categoryId).toBe('cat-target');
      });

      rule(['mergeCategories'], 'judges the source before the target', async () => {
        // Both sides are top-level headings here, so both guards would fire.
        // Which sentence the user sees is decided by the ORDER, and the order
        // is part of the contract: they are asked to think about what they are
        // merging away first.
        const { port } = await harness.create(mergeFixture());

        await expect(port.mergeCategories('cat-heading-source', 'cat-heading-target'))
          .rejects.toThrow(/not a category things are filed under/i);
      });

      rule(['mergeCategories'], 'refuses to merge a category into itself, and changes nothing', async () => {
        const { port, read } = await harness.create(mergeFixture());
        const before = asComparable(await read());

        await expect(port.mergeCategories('cat-source', 'cat-source'))
          .rejects.toThrow(/cannot be merged into itself/i);

        expect(asComparable(await read())).toBe(before);
      });
    });

    describe('reconciliation and archiving', () => {
      // Dates sit at midday, far from any midnight: which calendar day an
      // instant belongs to is divergence D-8 (and D-9 for the day a finalize is
      // recorded on), and these tests are about the marks, not about the zone.

      /**
       * THE RULE THE WHOLE FEATURE RESTS ON. A mark is Microsoft Money's C: a
       * working note that survives being walked away from and settles nothing.
       * When one flag did both jobs, "Mark all" WAS the reconciliation — leave
       * the screen and the account showed no work left, which is the bug this
       * separation exists to end. Asserted at the seam because every screen
       * reads the store's answer, not its own memory.
       */
      rule(['setTransactionsCleared'], 'a mark is not a reconciliation: it is kept, and it settles nothing', async () => {
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [
            aTransaction('txn-1', { cleared: false, reconciled: false }),
            aTransaction('txn-2', { cleared: false, reconciled: false })
          ]
        });

        const count = await port.setTransactionsCleared(['txn-1', 'txn-2'], true);

        expect(count).toBe(2);
        const state = await read();
        for (const id of ['txn-1', 'txn-2']) {
          expect(transactionOf(state, id)).toMatchObject({ cleared: true, reconciled: false });
        }
      });

      rule(['setTransactionsCleared'], 'unmarking takes any commitment with it', async () => {
        // reconciled implies cleared. The pair (committed, unmarked) would put
        // the cleared balance and the reconciled set permanently out of step,
        // so a store may never be left holding it.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [aTransaction('txn-1', { cleared: true, reconciled: true })]
        });

        await port.setTransactionsCleared(['txn-1'], false);

        expect(transactionOf(await read(), 'txn-1')).toMatchObject({
          cleared: false,
          reconciled: false
        });
      });

      rule(['finalizeReconciliation'], 'finalizing commits exactly the marked rows, and records what they were settled against', async () => {
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [
            aTransaction('txn-marked', { cleared: true, reconciled: false }),
            aTransaction('txn-unmarked', { cleared: false, reconciled: false }),
            aTransaction('txn-already', { cleared: true, reconciled: true }),
            aTransaction('txn-other-account', {
              accountId: ACCOUNT_B,
              cleared: true,
              reconciled: false
            })
          ]
        });

        const outcome = await port.finalizeReconciliation(ACCOUNT_A, 142.5, AT('2025-03-31'));

        // One row converted — not the unmarked one, not the one already
        // committed (a second count for it would overstate the work), and not
        // another account's.
        expect(outcome.reconciled).toBe(1);
        const state = await read();
        expect(transactionOf(state, 'txn-marked')?.reconciled).toBe(true);
        expect(transactionOf(state, 'txn-unmarked')?.reconciled).toBe(false);
        expect(transactionOf(state, 'txn-already')?.reconciled).toBe(true);
        expect(transactionOf(state, 'txn-other-account')?.reconciled).toBe(false);

        const account = state.accounts.find(a => a.id === ACCOUNT_A);
        expect(account?.lastReconciledBalance).toBe(142.5);
        expect(new Date(account?.lastReconciledDate ?? 0).toISOString().slice(0, 10))
          .toBe('2025-03-31');
      });

      rule(['finalizeReconciliation'], 'records a zero ending balance as a figure, not as "none"', async () => {
        // A real account in this product is swept to zero every night, so its
        // correct statement balance is exactly £0. An engine that treated 0 as
        // "nothing was confirmed" would refuse to finish that reconciliation
        // for ever.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [aTransaction('txn-marked', { cleared: true, reconciled: false })]
        });

        const outcome = await port.finalizeReconciliation(ACCOUNT_A, 0, AT('2025-03-31'));

        expect(outcome.endingBalance).toBe(0);
        expect(outcome.reconciled).toBe(1);
        expect(
          (await read()).accounts.find(a => a.id === ACCOUNT_A)?.lastReconciledBalance
        ).toBe(0);
      });

      rule(['finalizeReconciliation'], 'finalizing twice commits nothing the second time, and re-states the balance', async () => {
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [aTransaction('txn-marked', { cleared: true, reconciled: false })]
        });

        await port.finalizeReconciliation(ACCOUNT_A, 142.5, AT('2025-03-31'));
        const second = await port.finalizeReconciliation(ACCOUNT_A, 200, AT('2025-04-30'));

        expect(second.reconciled).toBe(0);
        expect(
          (await read()).accounts.find(a => a.id === ACCOUNT_A)?.lastReconciledBalance
        ).toBe(200);
      });

      rule(['finalizeReconciliation'], 'refuses to finalize an account it cannot find, and changes nothing', async () => {
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [aTransaction('txn-marked', { cleared: true, reconciled: false })]
        });
        const before = asComparable(await read());

        await expect(port.finalizeReconciliation('acct-not-here', 10, AT('2025-03-31')))
          .rejects.toThrow(/account/i);

        expect(asComparable(await read())).toBe(before);
      });

      rule(['setTransactionsCleared', 'finalizeReconciliation'], 'archives a row that becomes COMMITTED on or before the account cutoff', async () => {
        // The sweep hangs off finalizing, never off marking. Ticking a row
        // dated before the cutoff used to make it vanish from the very list the
        // ticking happens on — from a list whose whole promise is that ticks
        // are reversible.
        const { port, read } = await harness.create({
          accounts: [
            anAccount(ACCOUNT_A, 'Everyday', { archiveThroughDate: AT('2025-02-28') }),
            anAccount(ACCOUNT_B, 'Rainy day', { type: 'savings' })
          ],
          transactions: [
            aTransaction('txn-old', { date: AT('2025-01-15'), reconciled: false }),
            aTransaction('txn-new', { date: AT('2025-03-15'), reconciled: false })
          ]
        });

        await port.setTransactionsCleared(['txn-old', 'txn-new'], true);

        // Marked, both still in the live list.
        const marked = await read();
        expect(transactionOf(marked, 'txn-old')?.archived).not.toBe(true);
        expect(transactionOf(marked, 'txn-new')?.archived).not.toBe(true);

        await port.finalizeReconciliation(ACCOUNT_A, 0, AT('2025-03-31'));

        const state = await read();
        expect(transactionOf(state, 'txn-old')).toMatchObject({ cleared: true, archived: true });
        expect(transactionOf(state, 'txn-new')?.reconciled).toBe(true);
        expect(transactionOf(state, 'txn-new')?.archived).not.toBe(true);
      });

      rule(['archiveTransactionsBefore'], 'archives reconciled rows up to a cutoff and leaves the rest alone', async () => {
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [
            aTransaction('txn-reconciled', { date: AT('2025-01-15'), cleared: true, reconciled: true }),
            // Marked but not committed: still work in progress, so the archive
            // leaves it in the register where it can still be unmarked.
            aTransaction('txn-marked-only', { date: AT('2025-01-16'), cleared: true, reconciled: false }),
            aTransaction('txn-unmarked', { date: AT('2025-01-17'), cleared: false, reconciled: false }),
            aTransaction('txn-later', { date: AT('2025-03-15'), cleared: true, reconciled: true }),
            aTransaction('txn-other-account', {
              accountId: ACCOUNT_B,
              date: AT('2025-01-15'),
              cleared: true,
              reconciled: true
            })
          ]
        });

        const count = await port.archiveTransactionsBefore(ACCOUNT_A, AT('2025-02-28'));

        expect(count).toBe(1);
        const state = await read();
        expect(transactionOf(state, 'txn-reconciled')?.archived).toBe(true);
        expect(transactionOf(state, 'txn-marked-only')?.archived).not.toBe(true);
        expect(transactionOf(state, 'txn-unmarked')?.archived).not.toBe(true);
        expect(transactionOf(state, 'txn-later')?.archived).not.toBe(true);
        expect(transactionOf(state, 'txn-other-account')?.archived).not.toBe(true);
        expect(state.accounts.find(account => account.id === ACCOUNT_A)?.archiveThroughDate).toBeTruthy();
      });

      rule(['unarchiveAccount'], 'brings an account back out of the archive', async () => {
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [
            aTransaction('txn-1', { cleared: true, archived: true }),
            aTransaction('txn-2', { accountId: ACCOUNT_B, cleared: true, archived: true })
          ]
        });

        const count = await port.unarchiveAccount(ACCOUNT_A);

        expect(count).toBe(1);
        const state = await read();
        expect(transactionOf(state, 'txn-1')?.archived).toBe(false);
        expect(transactionOf(state, 'txn-2')?.archived).toBe(true);
      });

      rule(['applyCategoryToUncategorized'], 'fills only the blanks when a category is applied in bulk', async () => {
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [
            aTransaction('txn-blank', { category: '' }),
            aTransaction('txn-filed', { category: 'cat-bills' })
          ]
        });

        const count = await port.applyCategoryToUncategorized(
          ['txn-blank', 'txn-filed'],
          'cat-everyday'
        );

        expect(count).toBe(1);
        const state = await read();
        // Filed by the user's own decision, so it counts as confirmed, not as
        // another guess for them to agree with later.
        expect(transactionOf(state, 'txn-blank')).toMatchObject({
          category: 'cat-everyday',
          categoryConfirmed: true
        });
        expect(transactionOf(state, 'txn-filed')?.category).toBe('cat-bills');
      });

      rule(['confirmTransactionCategories'], 'confirms only the rows still waiting to be agreed with', async () => {
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [
            aTransaction('txn-guessed', { categoryConfirmed: false }),
            aTransaction('txn-known', { categoryConfirmed: true })
          ]
        });

        const count = await port.confirmTransactionCategories(['txn-guessed', 'txn-known']);

        expect(count).toBe(1);
        expect(transactionOf(await read(), 'txn-guessed')?.categoryConfirmed).toBe(true);
      });

      /**
       * Agreeing with the guess ends the row's review as well.
       *
       * Both surfaces that reach this operation are a person looking at a row
       * and answering the question it was asking — the register's row editor,
       * where the whole row is on screen, and the Categorisation page's group
       * confirm, where the rows are listed with a drill one click away. The
       * one-click answer is still an answer, and a register that kept the row
       * bold afterwards would be nagging about work already done, which is how
       * people learn to ignore the bold everywhere else.
       *
       * It rides this operation rather than a second write for a mechanical
       * reason too: one click must be one write, or a confirm is two audit
       * entries and a race with itself.
       */
      rule(['confirmTransactionCategories'], 'ends the review of every row it confirms', async () => {
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [
            aTransaction('txn-guessed', { categoryConfirmed: false, needsReview: true }),
            // Nothing to agree with here, so nothing happens to it — including
            // its review, which is somebody else's job to end.
            aTransaction('txn-known', { categoryConfirmed: true, needsReview: true })
          ]
        });

        await port.confirmTransactionCategories(['txn-guessed', 'txn-known']);

        const state = await read();
        expect(transactionOf(state, 'txn-guessed')?.needsReview).toBe(false);
        expect(transactionOf(state, 'txn-known')?.needsReview).toBe(true);
      });

      /**
       * Filing a payee in bulk ENDS the review of the rows it files — and no
       * other's.
       *
       * This rule used to assert the opposite, on the argument that a payee
       * list never showed the rows' dates and amounts. The owner reversed it
       * on 1 Sep 2026 after a live measurement: a household ledger's "to
       * review" count refused to move under a thousand-row payee filing, and
       * a counter only lowerable one row at a time is a counter nobody will
       * lower. The confirm rule's own principle won — answering the question
       * a row was asking IS reviewing it. Both engines changed together
       * (20260901150000_bulk_filing_ends_review.sql and the crate's verb);
       * the half that still holds is that a row the call does NOT file keeps
       * its flag.
       */
      rule(['applyCategoryToUncategorized'], 'ends the review of the rows it files, and no other', async () => {
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [
            aTransaction('txn-blank', { category: '', needsReview: true }),
            // Already filed, so the call skips it — and its review stays.
            aTransaction('txn-filed', { category: 'cat-everyday', needsReview: true })
          ]
        });

        await port.applyCategoryToUncategorized(['txn-blank', 'txn-filed'], 'cat-everyday');

        const state = await read();
        expect(transactionOf(state, 'txn-blank')?.needsReview).toBe(false);
        expect(transactionOf(state, 'txn-filed')?.needsReview).toBe(true);
      });

      /**
       * The fan-out's own verb (the owner's ruling, 11 Sep 2026): payee
       * memory's automatic spread is a GUESS, and a guess must not vouch or
       * end a review nobody did. Same fill-blanks skeleton as the deliberate
       * verb above, opposite provenance — and the flag is SET true rather
       * than left alone, because a blank row sat in To Review under the
       * unfiled arm and gaining a category would otherwise lift it off the
       * list at the moment it acquires something worth checking.
       */
      rule(['suggestCategoryToUncategorized'], 'writes a guess that still wants eyes, and fills only the blanks', async () => {
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [
            aTransaction('txn-blank', { category: '', needsReview: false }),
            aTransaction('txn-filed', { category: 'cat-bills', needsReview: false })
          ]
        });

        const count = await port.suggestCategoryToUncategorized(
          ['txn-blank', 'txn-filed'],
          'cat-everyday'
        );

        expect(count).toBe(1);
        const state = await read();
        expect(transactionOf(state, 'txn-blank')).toMatchObject({
          category: 'cat-everyday',
          categoryConfirmed: false,
          needsReview: true
        });
        // The filed row is untouched in every respect — fill-blanks is the
        // promise, and a guess overwriting a decision would be the one thing
        // this family exists to prevent.
        expect(transactionOf(state, 'txn-filed')).toMatchObject({
          category: 'cat-bills',
          needsReview: false
        });
      });

      /**
       * A row somebody typed is born reviewed. There is nothing to go back and
       * look at: they were looking at it as they made it.
       */
      rule(['createTransaction'], 'never marks a hand-entered transaction as new work', async () => {
        const { port, read } = await harness.create({ accounts: threeAccounts() });

        await port.createTransaction({
          accountId: ACCOUNT_A,
          amount: -4.5,
          date: AT('2025-01-12'),
          description: 'Typed in by hand',
          category: 'cat-everyday',
          type: 'expense'
        });

        const created = (await read()).transactions.find(t => t.description === 'Typed in by hand');
        expect(created?.needsReview).not.toBe(true);
      });
    });

    describe('dismissed suggestions', () => {
      rule(['dismissSuggestion', 'listSuggestionDismissals'], 'records a refusal once, however many times it is asked', async () => {
        // A double-click, or a second device, must not turn a decision into an
        // error message.
        //
        // THE TWO ROWS ARE SEEDED, and until slice 23 they were not — this rule
        // and the restore one below both named `txn-1` in a fixture that had no
        // transactions in it, while the prune rule between them seeded its own.
        // Nothing noticed, because both rules were skipped on the only engine
        // that would have minded: `suggestion_dismissal_subjects.transaction_id`
        // is a foreign key in a ledger file, where the cloud has a `uuid[]` and
        // a column comment claiming the same thing.
        //
        // Seeding them is the honest fixture rather than a concession to one
        // engine. A dismissal about a row that does not exist is not a state the
        // app can produce: a sweep makes an offer about rows it has just read,
        // and the prune trigger the rule below tests exists precisely so those
        // rows cannot stop existing underneath it.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [aTransaction('txn-1'), aTransaction('txn-2', { amount: 10 })]
        });

        const first = await port.dismissSuggestion('duplicate', 'subject-key', ['txn-1', 'txn-2']);
        const second = await port.dismissSuggestion('duplicate', 'subject-key', ['txn-1', 'txn-2']);

        expect(second.id).toBe(first.id);
        expect((await read()).dismissals).toHaveLength(1);
        expect(await port.listSuggestionDismissals()).toHaveLength(1);
      });

      rule(['deleteTransaction'], 'forgets a refusal about a row that no longer exists', async () => {
        // A suggestion about a deleted row can never be offered again, so its
        // refusal is dead weight. The cloud does this with a trigger; every
        // other engine has to do it too, or a restored backup carries junk.
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [aTransaction('txn-1'), aTransaction('txn-2', { amount: 10 })],
          dismissals: [
            {
              id: 'dismissal-1',
              kind: 'duplicate',
              subjectKey: 'subject-key',
              subjectIds: ['txn-1', 'txn-2'],
              dismissedAt: AT('2025-01-05')
            }
          ]
        });

        await port.deleteTransaction('txn-1');

        expect((await read()).dismissals).toHaveLength(0);
      });

      rule(['restoreSuggestion', 'listSuggestionDismissals'], 'offers a suggestion again once the refusal is undone', async () => {
        // `txn-1` is seeded for the reason the first rule in this block gives at
        // length: a dismissal names rows that exist, everywhere.
        const { port } = await harness.create({
          accounts: threeAccounts(),
          transactions: [aTransaction('txn-1')],
          dismissals: [
            {
              id: 'dismissal-1',
              kind: 'duplicate',
              subjectKey: 'subject-key',
              subjectIds: ['txn-1'],
              dismissedAt: AT('2025-01-05')
            }
          ]
        });

        await port.restoreSuggestion('duplicate', 'subject-key');

        expect(await port.listSuggestionDismissals()).toHaveLength(0);
      });
    });

    describe('archiving one row', () => {
      rule(['setTransactionArchived'], 'hides it without deleting it, and can put it back', async () => {
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [aTransaction('txn-1', { amount: -0.2 })]
        });

        await port.setTransactionArchived('txn-1', true);
        let state = await read();
        expect(transactionOf(state, 'txn-1')?.archived).toBe(true);
        // Archiving is not deleting: the money is still counted.
        expect(balanceOf(state, ACCOUNT_A)).toBe(-70.1);

        await port.setTransactionArchived('txn-1', false);
        state = await read();
        expect(transactionOf(state, 'txn-1')?.archived).toBe(false);
      });
    });

    describe('watching for changes made elsewhere', () => {
      rule(['subscribeToUpdates', 'createTransaction'], `B-8: the handle is callable, idempotent and final — and this engine ${SUBSCRIPTION_DELIVERY[engine].describes}`, async () => {
        const { port } = await harness.create({ accounts: threeAccounts() });

        const heard: string[] = [];
        const stop = port.subscribeToUpdates({
          onAccountUpdate: () => heard.push('account'),
          onTransactionUpdate: () => heard.push('transaction')
        });

        // The caller stores this and calls it from a React cleanup. A handle
        // that is not a function takes the whole provider down on unmount.
        expect(typeof stop).toBe('function');

        await port.createTransaction({
          accountId: ACCOUNT_A,
          amount: -12.5,
          date: AT('2025-01-12'),
          description: 'Heard or not',
          category: 'cat-everyday',
          type: 'expense'
        });
        await settle();

        // An engine that never delivers must stay silent through a write it
        // made itself. One that does deliver may say anything at all — twice,
        // late, or in the wrong order — so nothing is asserted about it here.
        if (SUBSCRIPTION_DELIVERY[engine].delivers === 'never') {
          expect(heard).toEqual([]);
        }

        // Idempotent, and said twice on purpose: the boot's cleanup drains its
        // handles, and a fast user switch can reach the same one again.
        stop();
        stop();

        // Final. Whatever this engine had to say, it stops saying it. An engine
        // that really delivers needs a wider window than `settle` to make this
        // assertion mean anything — widening it is the harness's business, and
        // the harness that delivers does not exist yet.
        const heardBefore = heard.length;
        await port.createTransaction({
          accountId: ACCOUNT_A,
          amount: -3.25,
          date: AT('2025-01-13'),
          description: 'After the handle was used',
          category: 'cat-everyday',
          type: 'expense'
        });
        await settle();

        expect(heard.length).toBe(heardBefore);
      });
    });

    describe('declared divergences', () => {
      // These are the places the engines are known to differ. Asserting them
      // per engine is the difference between a difference that is recorded and
      // one that is discovered by a user.
      rule(['updateTransaction'], `D-7: a field outside the update allow-list — this engine ${UPDATE_OUTSIDE_ALLOW_LIST[engine]} it`, async () => {
        const { port, read } = await harness.create({
          accounts: threeAccounts(),
          transactions: [aTransaction('txn-1')]
        });

        // `archived` has a dedicated operation (setTransactionArchived), and
        // the dedicated operation is the contract. Sent on an update anyway,
        // this is what each engine does with it.
        const update = port.updateTransaction('txn-1', { archived: true });

        switch (UPDATE_OUTSIDE_ALLOW_LIST[engine]) {
          case 'applies':
            await update;
            expect(transactionOf(await read(), 'txn-1')?.archived).toBe(true);
            break;
          case 'discards':
            await update;
            expect(transactionOf(await read(), 'txn-1')?.archived).not.toBe(true);
            break;
          case 'refuses':
            await expect(update).rejects.toThrow();
            expect(transactionOf(await read(), 'txn-1')?.archived).not.toBe(true);
            break;
        }
      });

      rule(['createTransaction'], `M-1: an amount below a penny — this engine ${SUB_PENNY_AMOUNT[engine]} it`, async () => {
        const { port, read } = await harness.create({ accounts: threeAccounts() });

        const write = port.createTransaction({
          accountId: ACCOUNT_A,
          amount: -0.125,
          date: AT('2025-01-11'),
          description: 'Sub-penny',
          category: 'cat-everyday',
          type: 'expense'
        });

        switch (SUB_PENNY_AMOUNT[engine]) {
          case 'keeps': {
            const created = await write;
            expect(created.amount).toBe(-0.125);
            break;
          }
          case 'rounds': {
            const created = await write;
            expect(Math.abs(created.amount)).toBeCloseTo(0.13, 10);
            break;
          }
          case 'refuses':
            await expect(write).rejects.toThrow();
            expect((await read()).transactions).toHaveLength(0);
            break;
        }
      });
    });

    // ── The whole ledger out, and back in ─────────────────────────────────
    //
    // The only operations here whose failure costs a person everything rather
    // than one row. The rules are the same three in every engine: "empty"
    // means the same question, a file poured into an empty store reproduces
    // the ledger it came from, and anything the store cannot keep comes back
    // named instead of vanishing.
    describe('backup and restore', () => {
      /**
       * A ledger with something in every table this suite can seed.
       *
       * The SPLIT and the DISMISSAL are not padding. They are the two tables a
       * partial job is most likely to miss and least likely to be noticed
       * missing: a split hangs off a transaction rather than off the store, and
       * a dismissal hangs off nothing at all — no account to cascade from, no
       * screen that would look empty if it survived. Both are carried by a
       * backup file, so both decide whether "wiped" is true enough for the
       * restore that follows. A fixture without them lets an engine that clears
       * the obvious five pass every assertion below.
       */
      const aWholeLedger = (): PortFixture => ({
        accounts: threeAccounts(),
        categories: [aCategory('cat-everyday', 'Everyday spending')],
        transactions: [
          aTransaction('txn-1', { amount: -10.1, description: 'Corner shop' }),
          aTransaction('txn-2', {
            accountId: ACCOUNT_B,
            amount: 500,
            description: 'Payday',
            type: 'income'
          }),
          aTransaction('txn-3', {
            amount: -30,
            description: 'Weekly shop',
            isSplit: true,
            category: ''
          })
        ],
        splits: [
          { id: 'line-1', transactionId: 'txn-3', category: 'cat-everyday', amount: -10, sortOrder: 1 },
          { id: 'line-2', transactionId: 'txn-3', category: 'cat-bills', amount: -20, sortOrder: 2 }
        ],
        budgets: [aBudget('budget-1', 'cat-everyday', 200)],
        goals: [aGoal('goal-1', 'New boiler', 1500)],
        dismissals: [
          {
            id: 'dismissal-1',
            kind: 'duplicate',
            subjectKey: 'corner-shop-10-10',
            subjectIds: ['txn-1'],
            dismissedAt: AT('2025-01-05')
          }
        ]
      });

      /**
       * Everything about a file except WHEN it was taken.
       *
       * Two backups of the same untouched ledger are the same backup; the
       * timestamp is a note about the act of exporting, not about the data,
       * and comparing it would only ever assert that a clock moved.
       */
      const contents = (bundle: BackupBundle) => ({
        format: bundle.format,
        schemaVersion: bundle.schemaVersion,
        counts: bundle.counts,
        data: bundle.data,
        links: bundle.links,
        preferences: bundle.preferences
      });

      rule(['financialDataIsEmpty'], 'says a fresh store is empty, and says otherwise the moment it holds anything', async () => {
        // The question the restore dialog asks before it offers the button, so
        // a wrong answer either refuses a restore that was safe or allows one
        // over a login full of data.
        const fresh = await harness.create({});
        expect(await fresh.port.financialDataIsEmpty()).toBe(true);

        const holding = await harness.create({ accounts: threeAccounts() });
        expect(await holding.port.financialDataIsEmpty()).toBe(false);
      });

      rule(['financialDataIsEmpty', 'wipeAllFinancialData'], 'empties the store, and then agrees that it is empty', async () => {
        // The two operations have to answer the same question about one store.
        // A wipe that emptied what it felt like and an emptiness check that
        // asked about something else would give the restore dialog two
        // different answers about the same login — and the one it acts on is
        // the one that unlocks the button.
        const { port, read } = await harness.create(aWholeLedger());
        expect(await port.financialDataIsEmpty()).toBe(false);

        await port.wipeAllFinancialData();

        expect(await port.financialDataIsEmpty()).toBe(true);
        const after = await read();
        expect(after.accounts).toEqual([]);
        expect(after.transactions).toEqual([]);
        expect(after.categories).toEqual([]);
        expect(after.budgets).toEqual([]);
        expect(after.goals).toEqual([]);
        // The two that hang off something other than the store, and are
        // therefore the two an incomplete wipe leaves behind in silence.
        expect(after.splits).toEqual([]);
        expect(after.dismissals).toEqual([]);
      });

      rule(['wipeAllFinancialData', 'financialDataIsEmpty'], 'is safe to run twice, because that is the recovery when it stops', async () => {
        // Idempotence is not tidiness here, it is the whole repair. An engine
        // that erases in pieces cannot avoid stopping part-way (one statement
        // over 51,000 rows is cancelled by the database's own timeout, which is
        // why it is in pieces at all), so it makes that state SAFE instead:
        // deleting rows that have already gone is a no-op, and the dialog's
        // advice — run it again — has to be true rather than hopeful.
        const { port, read } = await harness.create(aWholeLedger());

        await port.wipeAllFinancialData();
        const afterFirst = asComparable(await read());

        await expect(port.wipeAllFinancialData()).resolves.toBeUndefined();

        expect(asComparable(await read())).toBe(afterFirst);
        expect(await port.financialDataIsEmpty()).toBe(true);
      });

      rule(['collectBackup', 'wipeAllFinancialData', 'restoreBackup'], 'erases a store a file can then be poured straight back into', async () => {
        // THE ROUND TRIP, closed: collect → wipe → restore → collect. Slice 9
        // could prove the middle two against a store that started empty; this
        // is the journey a real person makes, which always begins with a login
        // that already holds their life.
        //
        // It is also what pins how much a wipe has to delete. "Empty" for the
        // flag is three tables; a file carries fourteen. An engine that cleared
        // the three and left one the file also holds would pass every
        // assertion above and then fail HERE — which is exactly where it fails
        // in real life, half-way through a restore, in front of somebody who
        // has just deliberately erased their own login.
        const store = await harness.create(aWholeLedger());
        const file = await store.port.collectBackup();

        await store.port.wipeAllFinancialData();
        await store.port.restoreBackup(file);

        const again = await store.port.collectBackup();

        // Row for row and penny for penny, matched by name because every id is
        // minted anew on the way in.
        expect(again.counts).toEqual(file.counts);
        const namesOf = (bundle: BackupBundle, entity: BackupEntity, field: string): string[] =>
          bundle.data[entity].map(row => String(row[field])).sort();
        expect(namesOf(again, 'accounts', 'name')).toEqual(namesOf(file, 'accounts', 'name'));
        expect(namesOf(again, 'transactions', 'description'))
          .toEqual(namesOf(file, 'transactions', 'description'));
        expect(namesOf(again, 'transactions', 'amount'))
          .toEqual(namesOf(file, 'transactions', 'amount'));
        expect(namesOf(again, 'categories', 'name')).toEqual(namesOf(file, 'categories', 'name'));
        expect(namesOf(again, 'budgets', 'amount')).toEqual(namesOf(file, 'budgets', 'amount'));
        expect(namesOf(again, 'goals', 'name')).toEqual(namesOf(file, 'goals', 'name'));
      });

      rule(['collectBackup', 'restoreBackup', 'financialDataIsEmpty'], 'pours a file into an empty store and gets the same ledger back, to the penny', async () => {
        const source = await harness.create(aWholeLedger());
        const file = await source.port.collectBackup();

        const target = await harness.create({});
        const outcome = await target.port.restoreBackup(file);

        const before = await source.read();
        const after = await target.read();

        expect(after.accounts.map(account => account.name).sort())
          .toEqual(before.accounts.map(account => account.name).sort());
        expect(after.transactions.map(transaction => transaction.description).sort())
          .toEqual(before.transactions.map(transaction => transaction.description).sort());
        expect(after.categories.map(category => category.name).sort())
          .toEqual(before.categories.map(category => category.name).sort());
        expect(after.budgets.map(budget => budget.amount)).toEqual(before.budgets.map(budget => budget.amount));
        expect(after.goals.map(goal => goal.name)).toEqual(before.goals.map(goal => goal.name));
        // The two collections that hang off something other than the store, and
        // are therefore the two an incomplete COLLECT drops in silence — the
        // same pair the wipe rule names for the same reason. A section a
        // collector forgets is invisible to a counts comparison, because the
        // file it is compared against forgot it too.
        expect(after.splits.map(split => split.amount).sort())
          .toEqual(before.splits.map(split => split.amount).sort());
        expect(after.dismissals.map(dismissal => dismissal.subjectKey).sort())
          .toEqual(before.dismissals.map(dismissal => dismissal.subjectKey).sort());

        // Money survives a trip through the file as money — matched by NAME,
        // because every id is new (see below). -70.1 is the figure that goes
        // wrong in float if anything on the way in or out re-adds the rows.
        const balanceByName = (state: PortStoreState, name: string): number | undefined =>
          state.accounts.find(account => account.name === name)?.balance;
        expect(balanceByName(after, 'Everyday')).toBe(balanceByName(before, 'Everyday'));
        expect(balanceByName(after, 'Rainy day')).toBe(balanceByName(before, 'Rainy day'));
        expect(balanceByName(after, 'Everyday')).toBe(-70.1);

        // Nothing the file held was left unaccounted for, and the store now
        // answers the emptiness question the other way.
        expect(outcome.restored.some(entry => entry.rows > 0)).toBe(true);
        expect(await target.port.financialDataIsEmpty()).toBe(false);

        // EVERY ID IS NEW. The primary keys in a backup are unique across the
        // whole store rather than per owner, so a restore that kept them would
        // collide with the rows of whoever exported the file — which is the
        // main case a backup exists for.
        const oldIds = new Set(before.accounts.map(account => account.id));
        expect(after.accounts.every(account => !oldIds.has(account.id))).toBe(true);
        // And the rows that pointed at those accounts followed them.
        const byName = new Map(after.accounts.map(account => [account.name, account.id]));
        const everyday = after.transactions.find(t => t.description === 'Corner shop');
        expect(everyday?.accountId).toBe(byName.get('Everyday'));
      });

      rule(['collectBackup', 'restoreBackup'], 'a restored ledger exports to the same file again, and again', async () => {
        // Generation 2 against generation 3, because generation 1 carries the
        // ids the fixture invented and every restore mints new ones. Two
        // restores from a store that starts fresh produce the same ids in the
        // same order, so a conversion that lost or invented a field on the way
        // through the file drifts between generations and shows up here.
        const source = await harness.create(aWholeLedger());
        const first = await source.port.collectBackup();

        const secondStore = await harness.create({});
        await secondStore.port.restoreBackup(first);
        const second = await secondStore.port.collectBackup();

        const thirdStore = await harness.create({});
        await thirdStore.port.restoreBackup(second);
        const third = await thirdStore.port.collectBackup();

        expect(contents(third)).toEqual(contents(second));
      });

      rule(['collectBackup', 'restoreBackup'], 'refuses to restore over a store that still holds something, and changes nothing', async () => {
        // A restore REPLACES; it does not merge. Refusing is what makes it safe
        // to attempt at all — nothing the user already has can be mixed with
        // the file, re-dated, or half-overwritten.
        const source = await harness.create(aWholeLedger());
        const file = await source.port.collectBackup();

        const occupied = await harness.create({ accounts: threeAccounts() });
        const before = asComparable(await occupied.read());

        await expect(occupied.port.restoreBackup(file)).rejects.toThrow();
        expect(asComparable(await occupied.read())).toBe(before);
      });

      rule(
        ['collectBackup', 'restoreBackup'],
        BACKUP_COVERAGE[engine].notStored.length === 0
          ? 'holds every table the format carries, and says so'
          : `names the ${BACKUP_COVERAGE[engine].notStored.length} tables it cannot keep instead of dropping them in silence`,
        async () => {
          // B-11. "3 investments were skipped" tells somebody nothing they can
          // act on; knowing the file still holds them, and where they would
          // come back, does. So the answer is a list of names with reasons.
          const source = await harness.create(aWholeLedger());
          const file = await source.port.collectBackup();

          const unstorable = BACKUP_COVERAGE[engine].notStored;
          const row: BackupRow = { id: 'row-the-file-carries', user_id: 'source-login' };
          const carried: BackupBundle = {
            ...file,
            data: { ...file.data },
            counts: { ...file.counts }
          };
          for (const { entity } of unstorable) {
            carried.data[entity] = [row];
            carried.counts[entity] = 1;
          }

          const target = await harness.create({});
          const outcome = await target.port.restoreBackup(carried);

          expect(outcome.notStoredLocally.map(entry => entry.label).sort())
            .toEqual(unstorable.map(entry => entry.label).sort());
          // Every one of them carries a sentence, not a count.
          for (const entry of outcome.notStoredLocally) {
            expect(entry.rows).toBe(1);
            expect(entry.absence.length).toBeGreaterThan(0);
          }

          // ── AND THE WARNING BEFORE IT SAYS THE SAME THING ─────────────────
          //
          // The rule this pair exists for, and it is a bug fix with a date on
          // it. `RestoreBackupModal` warns, BEFORE a restore begins, that a file
          // holds rows the target cannot keep — and it built that warning from
          // `LOCAL_BACKUP_BINDINGS`, a description of the BROWSER's store,
          // chosen by `backupTarget !== 'login'`. A device edition matches that
          // condition and keeps all fourteen tables, so it would have been told
          // its own file's budgets and goals could not be restored. A false
          // warning about data loss, in front of somebody deciding whether to
          // press a button.
          //
          // The question is a property of the ENGINE, so the engine answers it.
          // Asserting the two agree is stronger than asserting either alone: an
          // engine could satisfy one by describing a store it does not have, and
          // it cannot satisfy both.
          expect(target.port.capabilities().cannotKeep.map(entry => entry.entity).sort())
            .toEqual(unstorable.map(entry => entry.entity).sort());
          expect(target.port.capabilities().cannotKeep.map(entry => entry.label).sort())
            .toEqual(outcome.notStoredLocally.map(entry => entry.label).sort());
          for (const entry of target.port.capabilities().cannotKeep) {
            expect(entry.absence.length).toBeGreaterThan(0);
          }
        }
      );
    });

    // ── The boot, in one answer ───────────────────────────────────────────
    //
    // These three rules used to live at the app's own boot effect, proved
    // against a stubbed seam. They are here now, and that MOVE is the point:
    // proved at the call site they held only for the one call site, and the
    // second implementation of the seam would have inherited none of them. The
    // app's boot test keeps the question it is actually good at — did every
    // piece of state come through the door — and the door's own promises are
    // kept here, once, for every engine.
    describe('the boot, in one answer', () => {
      /**
       * Let everything that CAN progress, progress.
       *
       * Nothing in these tests is time-dependent: the only thing that can
       * unblock the sequence is the promise the test itself holds, so a turn of
       * the event loop is enough to prove that whatever has not started by now
       * is waiting rather than merely slow.
       */
      const settleWhatCan = (): Promise<void> =>
        new Promise(resolve => {
          setTimeout(resolve, 0);
        });

      const aLedgerToBootOn = (): PortFixture => ({
        accounts: threeAccounts(),
        categories: [aCategory('cat-everyday', 'Everyday'), aCategory('cat-bills', 'Bills')],
        transactions: [
          aTransaction('txn-1', { category: 'cat-everyday' }),
          aTransaction('txn-2', { amount: -20, category: 'cat-bills' })
        ],
        budgets: [aBudget('budget-1', 'cat-everyday', 200)],
        goals: [aGoal('goal-1', 'New boiler', 1500)],
        customReports: [aCustomReport('report-1', 'Where it went')]
      });

      rule(['loadBoot'], `does not read a transaction until the categories are settled — ${BOOT_COMPOSITION[engine].describes}`, async () => {
        // THE ordering rule, and the reason the boot is one call rather than
        // six: on a first signed-in load, preparing the categories renumbers
        // every one of them AND remaps every transaction and budget that
        // referenced the old ids, in one database transaction. A transaction
        // read that started before that finished would hand the app rows
        // pointing at categories about to stop existing — a register whose
        // category column is blank, with nothing thrown anywhere to say why.
        //
        // Holding the categories is what makes this a proof rather than a
        // reading of the source: reordering the two, or gathering them into a
        // Promise.all, both start the transaction read while this one is still
        // outstanding, and both fail here.
        const { port } = await harness.create(aLedgerToBootOn());

        let boot: BootSnapshot;

        if (BOOT_COMPOSITION[engine].fansOut) {
          const order: string[] = [];
          const prepareCategories = port.prepareCategories.bind(port);
          const loadBootTransactions = port.loadBootTransactions.bind(port);
          let settleCategories!: () => void;
          const categoriesHeld = new Promise<void>(resolve => {
            settleCategories = resolve;
          });

          vi.spyOn(port, 'prepareCategories').mockImplementation(async () => {
            order.push('categories:started');
            await categoriesHeld;
            const prepared = await prepareCategories();
            order.push('categories:settled');
            return prepared;
          });
          vi.spyOn(port, 'loadBootTransactions').mockImplementation(async () => {
            order.push('transactions:started');
            return loadBootTransactions();
          });

          const inFlight = port.loadBoot();
          await settleWhatCan();

          // Everything before the categories has run; nothing after them has.
          expect(order).toEqual(['categories:started']);

          settleCategories();
          boot = await inFlight;

          expect(order).toEqual([
            'categories:started',
            'categories:settled',
            'transactions:started'
          ]);
        } else {
          // One indivisible answer: there is no "before" inside it to observe,
          // and that is a stronger property than an order kept correctly — it
          // is an order that cannot be got wrong. What IS observable is that the
          // composite really did not fan out into the seam's own reads.
          //
          // Both operations are there to watch, and the surface rule above is
          // what says so. While an engine was being built this filtered to the
          // ones that existed, so a port that had not written them yet passed
          // honestly rather than by accident; there is no such engine now, and
          // a spy on a method that is missing would fail loudly, which is the
          // right answer.
          const notFannedOut = (['prepareCategories', 'loadBootTransactions'] as const)
            .map(operation => vi.spyOn(port, operation));

          boot = await port.loadBoot();

          notFannedOut.forEach(spy => expect(spy).not.toHaveBeenCalled());
        }

        // The outcome the ordering exists to produce: whatever the categories
        // were renumbered to, the rows in the SAME snapshot are filed under
        // those ids. Nothing throws when this goes wrong — the register simply
        // comes up with its category column blank.
        expectRowsFiledUnderTheSnapshotsCategories(boot);

        // And the snapshot really is the whole boot, however it was gathered.
        // An engine that answered a partial one would leave the app deciding
        // which of its own pages to open empty.
        expect(boot.accounts.map(account => account.id).sort())
          .toEqual([ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]);
        expect(boot.categories.length).toBeGreaterThan(0);
        expect(boot.transactions.map(transaction => transaction.id).sort())
          .toEqual(['txn-1', 'txn-2']);
        expect(boot.budgets.map(budget => budget.id)).toEqual(['budget-1']);
        expect(boot.goals.map(goal => goal.id)).toEqual(['goal-1']);
        // The reports are in the SNAPSHOT and not fetched where they are drawn,
        // and that is load-bearing rather than tidy: two of their readers are
        // synchronous renders (`BootSnapshot` argues it), so an engine that left
        // them out would leave a pinned dashboard widget drawing nothing on
        // every first paint.
        expect(boot.customReports.map(report => report.id)).toEqual(['report-1']);
        // The stats describe the array beside them, exactly as they do when the
        // transaction read is asked on its own: the boot-timing line prints
        // this figure, and the next slowness report starts from it.
        expect(boot.transactionStats.total).toBe(boot.transactions.length);
        // A Date crosses as a Date (rule 3). These rows go straight into the
        // balance maths, and a string here is a NaN there.
        boot.transactions.forEach(transaction => {
          expect(transaction.date).toBeInstanceOf(Date);
        });
        // Diagnostic, and required to exist: the one console line a production
        // slowness report is read off is built from it.
        expect(Object.values(boot.phases).every(ms => typeof ms === 'number')).toBe(true);
      });

      rule(['loadBoot'], 'asks for the budgets and the goals together, not one after the other', async () => {
        // They are independent reads. Serialising them adds a whole round trip
        // to every signed-in boot in exchange for nothing, and it is the kind of
        // change that looks tidier in a diff than it is on a slow connection.
        const { port } = await harness.create(aLedgerToBootOn());

        if (!BOOT_COMPOSITION[engine].fansOut) {
          // Nothing to serialise: one transaction reads both. The claim worth
          // checking is that it really is one — a composite that quietly fanned
          // out into the seam's own reads would have the round trip back.
          const listBudgets = vi.spyOn(port, 'listBudgets');
          const listGoals = vi.spyOn(port, 'listGoals');

          const boot = await port.loadBoot();

          expect(listBudgets).not.toHaveBeenCalled();
          expect(listGoals).not.toHaveBeenCalled();
          expect(boot.budgets.map(budget => budget.id)).toEqual(['budget-1']);
          expect(boot.goals.map(goal => goal.id)).toEqual(['goal-1']);
          return;
        }

        const started: string[] = [];
        const listBudgets = port.listBudgets.bind(port);
        const listGoals = port.listGoals.bind(port);
        let landBudgets!: () => void;
        const budgetsInFlight = new Promise<void>(resolve => {
          landBudgets = resolve;
        });

        vi.spyOn(port, 'listBudgets').mockImplementation(async () => {
          started.push('listBudgets');
          await budgetsInFlight;
          return listBudgets();
        });
        vi.spyOn(port, 'listGoals').mockImplementation(async () => {
          started.push('listGoals');
          return listGoals();
        });

        const inFlight = port.loadBoot();
        await settleWhatCan();

        // The goals started while the budgets were still outstanding: that is
        // what "one Promise.all" means, and two sequential awaits could not
        // produce it.
        expect(started).toEqual(['listBudgets', 'listGoals']);

        landBudgets();
        const boot = await inFlight;

        expect(boot.budgets.map(budget => budget.id)).toEqual(['budget-1']);
        expect(boot.goals.map(goal => goal.id)).toEqual(['goal-1']);
      });

      rule(['loadBoot'], 'answers, with the reason said out loud, when the store will not open', async () => {
        // The same floor `loadBootTransactions` keeps, and now the more
        // important one: this call is the ONLY thing inside the boot's single
        // outer catch, so a rejection here is a full-page "Failed to load data"
        // in front of somebody whose next reload would have worked. A store
        // that will not open costs whatever could not be read — never a throw —
        // and the transaction stats say why, in the words the boot-timing line
        // prints.
        const port = await harness.createUnreadable();

        const boot = await port.loadBoot();

        expect(boot.accounts).toEqual([]);
        expect(boot.transactions).toEqual([]);
        expect(boot.splits).toEqual([]);
        expect(boot.budgets).toEqual([]);
        expect(boot.goals).toEqual([]);
        expect(boot.customReports).toEqual([]);
        expect(boot.transactionStats.total).toBe(0);
        expect(typeof boot.transactionStats.fullFetchReason).toBe('string');
        expect(boot.transactionStats.fullFetchReason).not.toBe('');
      });
    });
  });
}
