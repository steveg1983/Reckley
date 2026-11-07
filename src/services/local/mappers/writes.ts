/**
 * The app's shapes on their way INTO a ledger file.
 *
 * The other half of `rows.ts`, and deliberately not its mirror image. Reading is
 * one question — the crate answers with a whole row and the app wants a whole
 * object — while writing is many: `create_transaction` takes a draft,
 * `update_transaction` takes a patch of sixteen fields, an import row takes
 * thirteen keys, and a split line takes five. Each of those is a SUBSET of the
 * same columns, and each refuses a key it has not heard of
 * (`deny_unknown_fields`), so the subsets are written out below rather than
 * inferred.
 *
 * What is NOT written out again is the correspondence itself. Every function
 * here goes through `columns.ts` — the same table `rows.ts` reads — so a field
 * cannot be written under one name and read back under another, and cannot be
 * a decimal string going out and a number coming in. That is the property
 * `localCore.fixtureFile.ts` already insists on for its own two directions, and
 * the reason it gives applies with more force here: two conversions that are
 * each wrong in the same way agree perfectly.
 *
 * ── THE TWO SHAPES OF "A KEY THE VERB HAS NOT HEARD OF" ─────────────────────
 *
 * This file makes opposite decisions for the create path and the update path,
 * and the difference is the whole of divergence D-7.
 *
 * A CREATE is FILTERED. `create_transaction_atomic` reads the keys it knows out
 * of a jsonb blob and ignores the rest, and the app's callers rely on it: the
 * seam hands over `Omit<Transaction, 'id'>`, which carries `isSplit`,
 * `archived`, `linkedTransferId` and half a dozen other fields the create verb
 * has no argument for. Sending them would make every ordinary create a refusal.
 * So the create builder sends the verb's own list and nothing else, which
 * reproduces the cloud's discard rather than inventing a stricter engine.
 *
 * An UPDATE is PASSED THROUGH WHOLE. The cloud discards an unrecognised key in
 * SILENCE, and that silence has an incident behind it — the reconciliation
 * page's cleared checkbox "succeeded" for a month without touching `is_cleared`,
 * so a difference could never reach zero. The local core refuses instead, by
 * name, which is D-7's declared row for this engine. It can only refuse what it
 * is shown, so the update builder must NOT quietly drop a field it does not
 * recognise: `archived` goes over the wire and comes back as a refusal naming
 * it, which is exactly what the contract suite asks this engine for.
 *
 * THE ACCOUNT PAIR TAKES THE SAME TWO SHAPES, and for once the update's half is
 * not a divergence at all: `mapAccountToDb` sends a field it has no column for
 * under its own name, and PostgREST then refuses the whole update because there
 * is no such column. So both engines refuse an unrecognised account field, and
 * the local `deny_unknown_fields` is parity rather than strictness. What the
 * account update DOES drop is listed and argued at
 * {@link ACCOUNT_UPDATE_DROPS} — two of them are the cloud's own drop-list and
 * three are timestamps a caller has no business stating.
 *
 * THE CATEGORY PAIR IS FILTERED ON BOTH SIDES, which is neither of the two
 * shapes above and is the third thing a cloud mapper can be. `categoryToDb` is a
 * WHITELIST — eleven `if (c.k !== undefined)` lines and no else — so a key it
 * has no line for never reaches the cloud's table at all. Passing one through
 * would make the local edition refuse an edit the cloud performs, and the field
 * it would refuse on is a real one: `Category.description` exists in the app's
 * type and has a column in neither engine.
 *
 * THE BUDGET AND GOAL PAIRS ARE FILTERED IN BOTH DIRECTIONS TOO, for the same
 * reason and against the same kind of mapper: `budgetToDb` is twelve
 * `if (b.k !== undefined)` lines and `goalToDb` is a similar list, so both are
 * whitelists and a key neither has a line for never reaches the cloud's table.
 *
 * So the rule is not "creates filter and updates do not". It is: **do what the
 * cloud's own mapper does with a key it has never heard of.** For a transaction
 * that is discard-on-create and send-on-update; for an account it is send in
 * both directions; for a category, a budget and a goal it is discard in both.
 *
 * ── AND THE PART A COLUMN TABLE CANNOT DO: MANY FIELDS, ONE COLUMN ───────────
 *
 * Three of this file's builders fold SEVERAL app fields into ONE column, which
 * `columns.ts` deliberately cannot express — it is one row per column, and a
 * correspondence with two left-hand sides is not a correspondence:
 *
 *   an account's `openingBalance || balance || 0` → `initial_balance`
 *   a goal's `progress ?? currentAmount`          → `current_amount`
 *   a goal's `status ?? achieved ?? isActive`     → `status`
 *
 * Every one of them is a line of the cloud's own writer, transcribed with its
 * own operator: `||` where the writer wrote `||`, `??` where it wrote `??`. The
 * difference is reachable in both cases — `??` passes an empty string and a zero
 * through and `||` does not — so the operators are copied rather than chosen.
 */

import { getDefaultCategories } from '../../../data/defaultCategories';
import type {
  Account,
  AccountUpdate,
  Budget,
  Category,
  CustomReport,
  DismissalKind,
  Goal,
  Transaction,
  TransactionSplitInput
} from '../../../types';
import type {
  InvestmentChanges,
  InvestmentDraft
} from '../../investments/holding';
import type { Column } from './columns';
import {
  ACCOUNT_COLUMNS,
  BUDGET_COLUMNS,
  CATEGORY_COLUMNS,
  CUSTOM_REPORT_COLUMNS,
  DISMISSAL_COLUMNS,
  GOAL_COLUMNS,
  INVESTMENT_COLUMNS,
  SPLIT_COLUMNS,
  TRANSACTION_COLUMNS,
  encode,
  payloadOf
} from './columns';

/**
 * What `create_transaction` accepts, out of the transaction's columns.
 *
 * `id` is absent on purpose. The seam's argument is `Omit<Transaction, 'id'>`,
 * so an id arriving here is one a caller spread in from a row it was copying —
 * and a create that adopted it would either collide with that row or resurrect
 * a deleted one. The crate mints the id (B-5, client-minted where the client is
 * the file), and `create-transaction-an-empty-id-is-generated-not-stored`
 * records the same decision on the other side of the wire.
 *
 * `needs_review` is absent because the verb has no such argument: a row a person
 * typed is born reviewed, by the column's own default, and
 * `20260810090000` says at length why the create path needed no edit for it.
 */
const CREATE_KEYS: readonly string[] = [
  'account_id',
  'description',
  'amount',
  'type',
  'date',
  'category',
  'notes',
  'tags',
  'is_recurring',
  'transfer_account_id',
  'statement_sequence',
  'category_confirmed',
  'is_cleared'
];

/**
 * What one row of `import_transactions` accepts.
 *
 * Two absences carry meaning. `account_id` is not here because the account is
 * one argument for the whole call — the boundary that stops a file scattering
 * rows into accounts the caller does not own, and the reason the destination
 * the user picked beats whatever each row's parser guessed.
 *
 * `needs_review` is not here because the verb writes it as a LITERAL: every row
 * a file brings in is new work, whatever the draft says. Passing the draft's
 * value through would make the register's bold depend on each of three parsers
 * remembering a key, and a parser that forgets fails silently.
 */
const IMPORT_KEYS: readonly string[] = [
  'description',
  'amount',
  'type',
  'date',
  'category',
  'notes',
  'tags',
  'is_recurring',
  'is_cleared',
  'statement_sequence',
  'category_confirmed'
];

/**
 * What one line of `set_transaction_splits_with_legs` accepts — the five, and
 * the crate names them in the same order.
 *
 * `sort_order` is not one of them: display order IS the order of the array, and
 * the verb numbers the lines itself. A caller that sent both could contradict
 * itself, and the loser would be whichever the writer happened to read second.
 */
const SPLIT_LINE_KEYS: readonly string[] = [
  'id',
  'category',
  'amount',
  'memo',
  'transfer_account_id'
];

/** A draft as `create_transaction`'s payload. */
export const toCreatePayload = (draft: Omit<Transaction, 'id'>): Record<string, unknown> =>
  payloadOf(TRANSACTION_COLUMNS, { ...draft }, CREATE_KEYS);

/** One draft as one row of an import request. */
export const toImportRow = (draft: Omit<Transaction, 'id'>): Record<string, unknown> =>
  payloadOf(TRANSACTION_COLUMNS, { ...draft }, IMPORT_KEYS);

/** One line as the split writer reads it, in the order it was handed. */
export const toSplitLine = (line: TransactionSplitInput): Record<string, unknown> =>
  payloadOf(SPLIT_COLUMNS, { ...line }, SPLIT_LINE_KEYS);

/**
 * A partial edit as `update_transaction`'s patch.
 *
 * Every key the caller STATED, and only those: a field that is absent means
 * "leave it alone" to every one of the crate's tri-state fields, so adding one
 * here would be the port making an edit nobody asked for. A key present with
 * `undefined` is treated as absent — it is what an object spread produces for a
 * field that was never set, and JSON has no way to carry it anyway. A key
 * present with `null` is a STATEMENT and travels as one; `transfer_account_id:
 * null` is how the app un-points a stranded leg.
 *
 * A field this table does not know travels under its own name, unconverted. It
 * will be refused — that is D-7, and the header says why the refusal is the
 * point rather than a rough edge.
 */
export function toUpdatePatch(updates: Partial<Transaction>): Record<string, unknown> {
  return whole(TRANSACTION_COLUMNS, updates as Record<string, unknown>, new Set());
}

// ── Accounts ────────────────────────────────────────────────────────────────

/**
 * What `create_account` accepts, out of the account's columns.
 *
 * `balance` is absent, and it is the most important absence in this file. The
 * seam hands over `Omit<Account, 'id'>`, which carries both `balance` and
 * `openingBalance` — and a ledger with no transactions cannot hold two different
 * figures without breaking B-1. The verb therefore takes ONE, `initial_balance`,
 * and sets the balance equal to it; which of the caller's two figures becomes
 * that one is decided in {@link toAccountCreatePayload} below, on the side that
 * has the caller's own type.
 *
 * `id` IS here, unlike the transaction create's key list, and for the opposite
 * reason to the one stated there: the seam's argument is `Omit<Account, 'id'>`
 * too, so an id can only arrive from a caller that minted one on purpose — and
 * the crate treats an absent id as "mint me one" (B-5). Nothing in the app sends
 * one today; the harness does, because two engines cannot be compared on a row
 * neither of them can name.
 */
const ACCOUNT_CREATE_KEYS: readonly string[] = [
  'id',
  'name',
  'type',
  'currency',
  'initial_balance',
  'is_active',
  'institution',
  'sort_code',
  'account_number',
  'opening_balance_date',
  'notes',
  'low_balance_alert_enabled',
  'low_balance_threshold'
];

/**
 * Fields of an `AccountUpdate` that are DROPPED rather than sent, and each one
 * is a decision.
 *
 * `holdings` and `tags` are the cloud's own drop-list (`mapAccountToDb`'s
 * `NOT_ACCOUNT_COLUMNS`): holdings live with the investments they belong to and
 * tags are not stored on an account, so sending either would fail the whole
 * update rather than just that field.
 *
 * The three timestamps are this edition's addition, and the reason is the one
 * every write verb here gives about `updated_at`: the crate stamps it from the
 * file's own clock INSIDE the write's transaction, so that the row, the To/From
 * category C-4 touches and the audit entry all carry one instant. A caller's
 * copy of a timestamp is not an instruction — it is what the caller last read —
 * and the cloud accepting one is how a stale client comes to backdate a row it
 * has just edited.
 */
const ACCOUNT_UPDATE_DROPS = new Set(['holdings', 'tags', 'createdAt', 'updatedAt', 'lastUpdated']);

/**
 * A new account as `create_account`'s payload.
 *
 * THE ONE FIGURE. `initial_balance` is `openingBalance || balance || 0`, falsy
 * -wise, which is `accountService.createAccount`'s own expression for the same
 * column (`account.openingBalance || account.balance || 0`) — so an account
 * created here opens at the figure the cloud would have called its initial
 * balance. In production the two are always the same number anyway:
 * `AppContextSupabase.addAccount` sets `balance = initialBalance || balance || 0`
 * before the seam is called. When they differ, the opening balance is the one a
 * ledger can honour, and `contract.ts`'s `ACCOUNT_BALANCE_AT_BIRTH` declares it.
 *
 * FILTERED, like the transaction create and for the same reason:
 * `Omit<Account, 'id'>` carries `plaidAccountId`, `mask`, `holdings` and half a
 * dozen others the verb has no argument for, and sending them would make every
 * ordinary create a refusal.
 */
export function toAccountCreatePayload(account: Omit<Account, 'id'>): Record<string, unknown> {
  const opening = account.openingBalance || account.balance || 0;
  return payloadOf(
    ACCOUNT_COLUMNS,
    { ...account, openingBalance: opening },
    ACCOUNT_CREATE_KEYS
  );
}

/**
 * A partial edit as `update_account`'s patch.
 *
 * PASSED THROUGH WHOLE, minus {@link ACCOUNT_UPDATE_DROPS}, which is exactly
 * what `mapAccountToDb` does: *"`undefined` means 'leave this alone' and is
 * dropped; `null` means 'clear the stored value' and is kept"*, and a field it
 * has no column for travels under its own name — where PostgREST refuses the
 * whole update because there is no such column. The local twin of that refusal
 * is `deny_unknown_fields`, so the two engines agree about an unrecognised field
 * as well as about a recognised one.
 *
 * `balance` is the one field that is recognised AND refused, by name. It is in
 * the column table for that purpose alone; the verb's module documentation says
 * why the refusal is worth more than the silence.
 */
export function toAccountUpdatePatch(updates: AccountUpdate): Record<string, unknown> {
  return whole(ACCOUNT_COLUMNS, updates as Record<string, unknown>, ACCOUNT_UPDATE_DROPS);
}

// ── Categories ──────────────────────────────────────────────────────────────

/**
 * What `create_category` accepts, out of the category's columns.
 *
 * `id` is absent, for the reason the transaction create gives and the account
 * create does not: the seam's argument is `Omit<Category, 'id'>`, and the crate
 * mints one (B-5, client-minted where the client is the file). The verb DOES
 * accept an id — the differential harness sends one, because two engines cannot
 * be compared on a row neither can name — and nothing in the app has one to
 * send.
 *
 * Everything else `categoryToDb` can produce is here, including the three
 * semantic flags: a RESTORE is the caller that legitimately states
 * `isTransferCategory`, and what stops an ordinary category acquiring an
 * `accountId` is the file's own CHECK rather than an omission here.
 */
const CATEGORY_CREATE_KEYS: readonly string[] = [
  'name',
  'type',
  'level',
  'parent_id',
  'account_id',
  'color',
  'icon',
  'is_system',
  'is_transfer_category',
  'is_revaluation_category',
  'is_unassigned_bucket',
  'is_active'
];

/** The same list, plus the id — because a SEED's ids are the whole point (B-4). */
const CATEGORY_SEED_KEYS: readonly string[] = ['id', ...CATEGORY_CREATE_KEYS];

/** A new category as `create_category`'s payload. */
export const toCategoryCreatePayload = (
  category: Omit<Category, 'id'>
): Record<string, unknown> => payloadOf(CATEGORY_COLUMNS, { ...category }, CATEGORY_CREATE_KEYS);

/**
 * A partial edit as `update_category`'s patch.
 *
 * FILTERED, unlike the two update builders above it, and the header says why in
 * one line: `categoryToDb` is a whitelist. `Partial<Category>` carries
 * `description`, which has a column in neither engine and which the cloud's
 * mapper silently drops — so a port that sent it would refuse an edit the cloud
 * performs.
 *
 * A field stated as `null` still travels as `null`: `payloadOf` drops only what
 * is `undefined`, and the crate's tri-state fields read a stated null as "clear
 * this" and absence as "leave it alone". That distinction is what lets the
 * Categories page move a leaf out of a group.
 */
export const toCategoryUpdatePatch = (
  updates: Partial<Category>
): Record<string, unknown> => payloadOf(CATEGORY_COLUMNS, { ...updates }, CATEGORY_CREATE_KEYS);

/**
 * The default category tree, as `seed_categories` takes it.
 *
 * THE TREE IS THE APP'S, and it crosses the seam rather than living in the
 * crate. `src/data/defaultCategories.ts` is the one list all three engines use —
 * browser storage answers with it unwritten, the cloud migrates it into per-user
 * uuids, and a device seeds it — and a second copy in Rust would go stale the
 * first time a group was added to the starter set with nothing to catch it.
 * `migrate_categories_atomic` takes the client's list for exactly the same
 * reason, which is why the verb's payload has the same shape.
 *
 * THE IDS TRAVEL, and that is divergence B-4 in one line: `'type-income'` and
 * `'transfer-in'` are stored as themselves, because `schema.sql` puts the uuid
 * CHECK on `users.id` alone (PHASE3-PLAN D-5) and a file has no second id space
 * to remap into.
 *
 * Computed per call rather than cached: it is a pure function of a constant
 * array, it is asked once per boot at most, and a module-level constant would be
 * a copy that a test which mutates a category could reach.
 */
export const defaultCategorySeed = (): Array<Record<string, unknown>> =>
  getDefaultCategories().map(category =>
    payloadOf(CATEGORY_COLUMNS, { ...category }, CATEGORY_SEED_KEYS)
  );

/**
 * Every key a caller STATED, converted where this table knows the column and
 * carried under its own name where it does not.
 *
 * The shared shape of both update builders. A key present with `undefined` is
 * treated as absent — it is what an object spread produces for a field that was
 * never set, and JSON has no way to carry it anyway. A key present with `null`
 * is a STATEMENT and travels as one.
 */
function whole(
  columns: readonly Column[],
  updates: Record<string, unknown>,
  dropped: ReadonlySet<string>
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (dropped.has(field)) continue;
    const column = columns.find(entry => entry.field === field);
    if (column === undefined) {
      patch[field] = value;
      continue;
    }
    patch[column.key] = encode(column.kind, value);
  }
  return patch;
}

// ── Budgets ─────────────────────────────────────────────────────────────────

/**
 * What `create_budget` accepts, out of the budget's columns.
 *
 * `spent` is absent, and it is the important absence: the cloud's own writer
 * overrides whatever it was handed with zero (`budgetToDb({ ...budget, spent: 0
 * })`), because what has been spent against a category is summed from the ledger
 * and is never the caller's to state. The verb therefore has no `spent` argument
 * at all rather than one it would then discard, and the seam says the same thing
 * from its end.
 *
 * `id` is absent for the transaction create's reason: the seam's argument is
 * `Omit<Budget, 'id' | 'spent'>`, and the crate mints one (B-5). The verb DOES
 * accept an id, because the differential harness has to name a row on both
 * engines.
 *
 * `name` and `start_date` ARE here even though both are `NOT NULL` and the
 * caller may state neither. The verb fills them in — today's date, and the
 * category id or the literal 'Budget' — because those two lines belong to the
 * cloud's writer and a default applied on this side would arrive at the harness
 * already applied, where no spec could compare it.
 */
const BUDGET_CREATE_KEYS: readonly string[] = [
  'name',
  'amount',
  'period',
  'repeat_count',
  'repeat_unit',
  'category',
  'start_date',
  'end_date',
  'rollover',
  'rollover_amount',
  'alert_threshold',
  'is_active',
  'notes'
];

/**
 * What `update_budget` accepts: the create's list, plus `spent`.
 *
 * `budgetToDb` has a `spent` line and only `createBudget` overrides it, so an
 * update that states the figure sends it — which is faithful rather than
 * permissive. The seam's *"summed from the ledger, never stored knowledge"* is a
 * statement about where the figure COMES FROM; the column is still written by
 * whatever recomputed it, and a port that refused the key would refuse a write
 * the cloud performs.
 */
const BUDGET_UPDATE_KEYS: readonly string[] = [...BUDGET_CREATE_KEYS, 'spent'];

/** A new budget as `create_budget`'s payload. */
export const toBudgetCreatePayload = (
  budget: Omit<Budget, 'id' | 'spent'>
): Record<string, unknown> => payloadOf(BUDGET_COLUMNS, { ...budget }, BUDGET_CREATE_KEYS);

/**
 * A partial edit as `update_budget`'s patch.
 *
 * FILTERED, like the category patch and for the same reason: the mapper it ports
 * is a whitelist, so a key it has never heard of is a key the cloud drops in
 * silence, and a port that sent one would refuse an edit the cloud performs.
 * `Partial<Budget>` carries `createdAt` and `updatedAt`, which are exactly that.
 *
 * A field stated as `null` still travels as `null`: `payloadOf` drops only what
 * is `undefined`, and the crate's tri-state fields read a stated null as "clear
 * this" and absence as "leave it alone".
 */
export const toBudgetUpdatePatch = (
  updates: Partial<Budget>
): Record<string, unknown> => payloadOf(BUDGET_COLUMNS, { ...updates }, BUDGET_UPDATE_KEYS);

// ── Goals ───────────────────────────────────────────────────────────────────

/**
 * What the goal verbs accept, out of the goal's columns.
 *
 * One list for the create and the update, because `goalToDb` is one mapper with
 * no `spent`-shaped exception in it. `id` is absent for the reason the budget's
 * is.
 *
 * `metadata` is not a column of the table in `columns.ts` and is not in this
 * list either: it is assembled from three app fields below.
 */
const GOAL_KEYS: readonly string[] = [
  'name',
  'description',
  'target_amount',
  'current_amount',
  'target_date',
  'category',
  'priority',
  'status',
  'completed_at',
  'account_id',
  'contribution_frequency',
  'auto_contribute',
  'icon',
  'color'
];

/**
 * A new goal as `create_goal`'s payload.
 *
 * THE OPENING FIGURE, which is contract rule 49 and the whole of this slice's
 * named property. `createGoal` computes `goal.currentAmount ?? 0` and hands it
 * to `goalToDb` as `progress`, whose own line is `progress ?? currentAmount` —
 * so both app fields collapse into ONE column before a row exists, and the
 * column's own default (`0` on both engines) is what a goal with nothing put by
 * starts at. Nothing here writes a zero: a literal would be one edit away from
 * being written over a stated figure, which is exactly the bug rule 49 records
 * ("the version that hard-coded zero lost the opening amount, and lost it
 * differently in each engine").
 *
 * `Omit<Goal, 'id' | 'progress'>` has no `progress` to give precedence to, so on
 * this path the two-field fold has one input. {@link toGoalUpdatePatch} is where
 * the precedence is really exercised.
 */
export function toGoalCreatePayload(goal: Omit<Goal, 'id' | 'progress'>): Record<string, unknown> {
  return {
    ...payloadOf(GOAL_COLUMNS, { ...goal, status: statusOf(goal) }, GOAL_KEYS),
    ...metadataOf(goal)
  };
}

/**
 * A partial edit as `update_goal`'s patch.
 *
 * THE CONTRIBUTION PATH, and the fold that matters on it: `progress` wins over
 * `currentAmount`, because that is the order `goalToDb` tests them in, and the
 * contribution the app sends carries both. It SETS — the verb's statement is
 * `current_amount_minor = ?` and never `+ ?` — because the figure has already
 * been added up and capped against the target by the caller.
 *
 * FILTERED, like the budget patch: `Partial<Goal>` carries `progress`,
 * `isActive`, `achieved`, `type`, `linkedAccountIds`, `contributionAmount`,
 * `createdAt` and `updatedAt`, and not one of them is a column. Three of them
 * are folded (below) and the rest are dropped, which is what the cloud's mapper
 * does with them.
 */
export function toGoalUpdatePatch(updates: Partial<Goal>): Record<string, unknown> {
  const folded: Partial<Goal> = { ...updates };
  // `if (g.progress !== undefined) row.current_amount = g.progress;
  //  else if (g.currentAmount !== undefined) row.current_amount = g.currentAmount;`
  if (updates.progress !== undefined) folded.currentAmount = updates.progress;
  const status = statusOf(updates);
  if (status !== undefined) folded.status = status;
  return {
    ...payloadOf(GOAL_COLUMNS, folded, GOAL_KEYS),
    ...metadataOf(updates)
  };
}

/**
 * `status`, folded out of the three app fields that all describe it.
 *
 * `goalToDb`'s ladder, in its order and with its operators:
 *
 * ```text
 * if      (g.status  !== undefined) row.status = g.status;
 * else if (g.achieved === true)     row.status = 'completed';
 * else if (g.isActive !== undefined) row.status = g.isActive ? 'active' : 'paused';
 * ```
 *
 * The middle rung is `=== true` rather than truthy, so `achieved: false` falls
 * through to `isActive` instead of claiming the goal is unfinished — which
 * matters, because the goal modal sends both.
 *
 * `undefined` means the column is not mentioned, which on a create leaves the
 * column's default ('active') and on an update leaves whatever is stored.
 */
function statusOf(goal: Partial<Goal>): Goal['status'] | undefined {
  if (goal.status !== undefined) return goal.status;
  if (goal.achieved === true) return 'completed';
  if (goal.isActive !== undefined) return goal.isActive ? 'active' : 'paused';
  return undefined;
}

/**
 * `metadata`, assembled from the three app fields that never got columns.
 *
 * `{}` — no key at all — when the caller mentioned none of them, because the
 * verb reads an absent `metadata` as "leave the blob alone" and a stated one as
 * "merge this over it". Sending `{}` would be a merge of nothing, which is
 * harmless and would also make every ordinary edit rewrite a column it has no
 * business touching.
 *
 * The MERGE is the verb's, not this function's: `goalToDb` spreads the stated
 * fields over the row's CURRENT metadata, and that object lives in the file. A
 * port that merged here would be merging over whatever its caller last read,
 * which is how "editing a goal's type deleted its linked accounts" happened in
 * the first place.
 *
 * `contributionAmount` is a NUMBER and it is money, riding in a blob on both
 * engines — DESIGN.md §5 divergence 9's shape, and the CHECK that bans money
 * from metadata covers `transactions` alone. Nothing in the app writes the field
 * today (`GoalModal` sets `linkedAccountIds` and never this), so what crosses
 * here is a field of the app's type with no writer. The day it gets one it wants
 * a column, in both schemas.
 */
function metadataOf(goal: Partial<Goal>): Record<string, unknown> {
  const stated: Record<string, unknown> = {};
  if (goal.type !== undefined) stated.type = goal.type;
  if (goal.linkedAccountIds !== undefined) stated.linkedAccountIds = goal.linkedAccountIds;
  if (goal.contributionAmount !== undefined) stated.contributionAmount = goal.contributionAmount;
  return Object.keys(stated).length === 0 ? {} : { metadata: stated };
}

// ── Custom reports ──────────────────────────────────────────────────────────

/**
 * What the report verbs accept, out of the report's columns.
 *
 * One list for the create and the update, because `customReportToDb` is one
 * whitelist with no `spent`-shaped exception in it. `id` is absent for the
 * reason the budget's and the goal's are: the seam's create argument is
 * `Omit<CustomReport, 'id'>` and the crate mints one (B-5). The verb accepts an
 * id anyway, so that the differential harness can name a row on both engines.
 *
 * FILTERED IN BOTH DIRECTIONS, which is the third of the three shapes this
 * file's header lays out and the same one a category, a budget and a goal have:
 * the cloud mapper it ports is a whitelist — five `if (r.k !== undefined)` lines
 * and no else — so a key it has no line for never reaches the cloud's table, and
 * a port that sent one would refuse an edit the cloud performs.
 * `Partial<CustomReport>` carries exactly such keys: `createdAt` and `updatedAt`
 * are on every report object the builder hands back, and neither is an
 * instruction on an UPDATE.
 */
const CUSTOM_REPORT_KEYS: readonly string[] = [
  'name',
  'description',
  'components',
  'filters'
];

/**
 * A new report as `create_custom_report`'s payload.
 *
 * ── THE TWO TIMESTAMPS ARE DROPPED, AND THAT COSTS SOMETHING ────────────────
 *
 * `Omit<CustomReport, 'id'>` carries `createdAt` and `updatedAt` — the builder
 * puts them on every report it hands back — and neither reaches the store. Both
 * engines stamp their own: `create_custom_report`'s draft has five fields and
 * none of them is a clock, and `customReportToDb` is a whitelist with no line
 * for either column. That is the same treatment a new BUDGET's two timestamps
 * get, and the rule `columns.ts` states for every create in this file — a
 * caller's copy of a timestamp is what it last read, not an instruction.
 *
 * What it costs is worth writing down rather than discovering. The ADOPTION
 * (`customReportService.adoptLegacyReports`) carries reports out of a browser's
 * old storage key, and some of those were built years ago; they arrive in the
 * store dated the day the adoption ran, so the reports page will say somebody
 * created them this morning. The alternative was worse in a way that is not
 * obvious: the cloud's INSERT could honour a stated `created_at` and the file's
 * verb cannot, so honouring it on one side would be an UNDECLARED divergence
 * between the editions — two engines disagreeing about when a person did
 * something, which is exactly the class of difference the contract suite exists
 * to make impossible.
 */
export function toCustomReportCreatePayload(
  report: Omit<CustomReport, 'id'>
): Record<string, unknown> {
  return payloadOf(CUSTOM_REPORT_COLUMNS, { ...report }, CUSTOM_REPORT_KEYS);
}

/**
 * A partial edit as `update_custom_report`'s patch.
 *
 * ── THE TWO JSON COLUMNS REPLACE, AND THAT IS THE WHOLE OF THIS FUNCTION ────
 *
 * `toGoalUpdatePatch` above sends a `metadata` object the VERB then merges over
 * what is stored, because three unrelated app fields share that one column and
 * rebuilding it from a partial update once deleted a goal's linked accounts.
 * Nothing shares these two columns, so the verb REPLACES them — and the
 * difference has to be got right in this direction rather than left to the
 * engine, because a merged `components` array would make removing a component
 * impossible: the removed one would survive every save and no screen would
 * explain why it kept coming back.
 *
 * A field the caller did not state is absent from the patch and the verb leaves
 * the column alone, which is how "rename this report" avoids rewriting its
 * components at all. `payloadOf` drops only `undefined`, so a stated `null` (a
 * value neither of these columns should ever hold) still travels and the crate's
 * own boundary is what judges it.
 *
 * `updatedAt` is not sent, exactly as it is not sent on the create above. An
 * edit happens now, by definition, so the store's clock is the honest answer and
 * a caller's copy of the old value would freeze the timestamp at whatever it
 * last read.
 */
export function toCustomReportUpdatePatch(
  updates: Partial<CustomReport>
): Record<string, unknown> {
  return payloadOf(CUSTOM_REPORT_COLUMNS, { ...updates }, CUSTOM_REPORT_KEYS);
}

// ── Dismissals ──────────────────────────────────────────────────────────────

/**
 * What `dismiss_suggestion` accepts: the four keys the cloud's own insert
 * carries, and not one more.
 *
 * ```text
 * .insert({ user_id, kind, subject_key: subjectKey, subject_ids: subjectIds })
 * ```
 *
 * `id` is absent for the reason every create here gives — the seam's argument
 * list does not carry one and the crate mints one (B-5) where the cloud's column
 * default would. `dismissed_at` is absent for a DIFFERENT reason worth keeping
 * separate: it is not the caller's to state at all. Both engines default the
 * column to the instant of the write, so a port that sent one would be
 * overwriting a figure the table had already decided, and "when you first said
 * no" would become "when this client's clock said so".
 *
 * NOT FILTERED against a whitelist, unlike the category, budget and goal
 * patches, and the difference is the seam's rather than this file's: those three
 * take an app OBJECT with fields that have no columns, so a filter is what stops
 * `createdAt` reaching a verb. This one takes three arguments — a kind, a key
 * and a list of ids — so there is nothing to filter out. The column table is
 * still what serialises them, because a value that crossed one way through the
 * table and the other way by hand is precisely the drift the table exists to
 * prevent.
 */
const DISMISSAL_KEYS: readonly string[] = ['kind', 'subject_key', 'subject_ids'];

/**
 * A refusal as `dismiss_suggestion`'s payload.
 *
 * `subjectIds` is ALWAYS sent, including empty. It is not an optional field with
 * a default: an empty list is what the three payee kinds mean by "this is about
 * wording, not rows", and dropping the key would make that indistinguishable
 * from a caller who forgot to say.
 */
export const toDismissalPayload = (
  kind: DismissalKind,
  subjectKey: string,
  subjectIds: string[]
): Record<string, unknown> =>
  payloadOf(DISMISSAL_COLUMNS, { kind, subjectKey, subjectIds }, DISMISSAL_KEYS);

/**
 * The natural key `restore_suggestion` deletes by.
 *
 * `(kind, subject_key)` and no ids: the screen offering "undo" is looking at a
 * SUGGESTION rather than at a dismissal row, so it has never seen one. Through
 * the same table as the payload above, so the two verbs cannot come to spell
 * `subject_key` differently.
 */
export const toDismissalKey = (
  kind: DismissalKind,
  subjectKey: string
): Record<string, unknown> =>
  payloadOf(DISMISSAL_COLUMNS, { kind, subjectKey }, ['kind', 'subject_key']);


// ── Holdings ────────────────────────────────────────────────────────────────

/**
 * The ten keys `create_investment` accepts.
 *
 * `cost_basis` IS NOT ONE OF THEM, and neither engine takes one: it is
 * `quantity × averageCost`, derived by whoever is writing, because *"two numbers
 * that must agree are two numbers that will not"* (`investmentService.ts`).
 * `current_price` and `last_updated` are not here either — a price comes from an
 * exchange, never from a create.
 */
const INVESTMENT_CREATE_KEYS: readonly string[] = [
  'id',
  'account_id',
  'symbol',
  'name',
  'quantity',
  'purchase_price',
  'purchase_date',
  'currency',
  'asset_type',
  'notes'
];

/**
 * The seven a `update_investment` patch may carry — `InvestmentChanges` mapped
 * to columns, and `id` is not among them: the row being edited is named beside
 * the patch, not inside it.
 */
const INVESTMENT_PATCH_KEYS: readonly string[] = [
  'symbol',
  'name',
  'quantity',
  'purchase_price',
  'currency',
  'asset_type',
  'notes'
];

/**
 * A new holding as `create_investment`'s payload.
 *
 * THE SYMBOL IS TRIMMED AND UPPER-CASED HERE, because that is where the cloud
 * does it: `InvestmentService.create` sends `draft.symbol.trim().toUpperCase()`,
 * and the crate stores the text it is given for `columns.ts`'s stated reason —
 * *"a verb that renamed it would be a second opinion about what a payload
 * means"*, the same rule that keeps `accountTypeToDb`'s 'current' → 'checking'
 * on the client. A file that upper-cased it too would be a second implementation
 * of one decision; a file that did not, with a port that did not either, would
 * price `shel.l` and `SHEL.L` as two securities.
 *
 * The NAME is left exactly as the caller typed it, empty string included: both
 * engines fall back to the symbol for a blank one, and doing it here as well
 * would put the fallback in three places.
 */
export function toInvestmentCreatePayload(draft: InvestmentDraft): Record<string, unknown> {
  const symbol = draft.symbol.trim().toUpperCase();
  return payloadOf(
    INVESTMENT_COLUMNS,
    { ...draft, symbol },
    INVESTMENT_CREATE_KEYS
  );
}

/**
 * A partial edit as `update_investment`'s patch.
 *
 * The same symbol rule as the create, and for the same reason — the cloud's
 * update does `changes.symbol.trim().toUpperCase()` on exactly the branch that
 * mentions it, so an unstated symbol stays unstated rather than becoming `''`.
 *
 * FILTERED by `INVESTMENT_PATCH_KEYS` rather than passed through, because both
 * of the crate's investment payloads are `deny_unknown_fields` whitelists and so
 * is `InvestmentService.update`'s own `columns` object: a key neither writer has
 * a line for reaches neither engine.
 */
export function toInvestmentUpdatePatch(changes: InvestmentChanges): Record<string, unknown> {
  // `Partial<…>` rather than the interface itself, and not for the optionality
  // (every field already is). A mapped type carries an implicit index signature
  // and a declared interface does not, so this is what lets `payloadOf` read it
  // by key — the same shape `toGoalUpdatePatch`'s `Partial<Goal>` has, which is
  // why that one never had to say so.
  const folded: Partial<InvestmentChanges> = { ...changes };
  if (changes.symbol !== undefined) folded.symbol = changes.symbol.trim().toUpperCase();
  return payloadOf(INVESTMENT_COLUMNS, folded, INVESTMENT_PATCH_KEYS);
}
