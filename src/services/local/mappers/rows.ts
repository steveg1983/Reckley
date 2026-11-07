/**
 * A crate answer's rows as the app's own objects.
 *
 * Eight translations, one per entity the seam reads, and each one is the ONLY
 * place that entity crosses from the file into the application. They are here
 * rather than beside the port for the reason `accountMapping.ts` gives at
 * length about the two account mappers that once existed: *"an account has ONE
 * shape however it was loaded"*, and two mappers each complete in the fields the
 * other forgot made three bugs no amount of reading either file would explain.
 *
 * ── WHAT IS REUSED, AND WHAT COULD NOT BE ───────────────────────────────────
 *
 * ACCOUNTS reuse the cloud's mapper outright. `services/api/accountMapping.ts`
 * is "the ONE translation" and it imports nothing but types, so the local
 * edition can call it without dragging a Supabase client into a desktop bundle.
 * One rename happens first (see {@link toAccount}) and then the same function
 * the cloud boot uses reads the row. Anything it learns, this learns.
 *
 * The other six have a cloud twin that CANNOT be imported: `budgetFromDb` /
 * `goalFromDb` live inside `planningService.ts`, the split mapper inside
 * `transactionService.ts`, and both modules carry a Supabase client at module
 * scope. Importing either would put the cloud in the desktop bundle — the exact
 * thing PHASE3-PLAN §5's two bundle greps exist to refuse. So the mappings
 * below are written out, each naming the twin it must agree with and copying
 * its decisions explicitly rather than by accident:
 *
 *   budgets      planningService.ts `budgetFromDb`  — categoryId travels in the
 *                TEXT `category` column, never in the uuid `category_id`
 *   goals        planningService.ts `goalFromDb`    — `type` lives in metadata,
 *                `isActive` is "not paused", `progress` IS `current_amount`
 *   splits       transactionService.ts `mapSplitRow`
 *   transactions transactionService.ts `mapFromDbFields` + `DB_TO_CAMEL`
 *   categories   planningService.ts's category select
 *   dismissals   suggestionDismissalService.ts
 *
 * Making those six shareable means lifting them out of two Supabase-carrying
 * modules, which is a refactor of the cloud path and belongs to a commit that
 * says so. Until then the guard against drift is not this comment: it is the
 * contract suite, which asks both engines the same questions and compares
 * app-shaped answers.
 *
 * CUSTOM REPORTS ARE THE EXCEPTION, and they were written the other way round
 * from the start. Their two JSON columns are the only values in this app stored
 * as free-form JSON and read back as a CLOSED type, so nothing in either store
 * constrains what is inside them and a round-trip test cannot see a reader that
 * is wrong in the same way at both ends. Two readers would draw two different
 * reports from one definition. So the reading lives in
 * `services/reports/document.ts` — a module of two type imports, safe in a
 * desktop bundle for the reason `preferences/document.ts` is — and both engines
 * call it. See {@link toCustomReport}.
 *
 * ── WHAT THE FILE CANNOT ANSWER, STATED RATHER THAN GUESSED ────────────────
 *
 * This paragraph named three fields and is down to one. `Transaction.reconciled`
 * and `Account.lastReconciledBalance` had no column in
 * `scripts/local-sqlite/schema.sql` — the mirror predated
 * `20260810200000_marking_is_not_reconciling.sql` — and both are ported now
 * (the account's in slice 20, the transaction's with the reconciliation verbs).
 * What is left is `Transaction.metadata`-derived fields, which read as
 * `undefined` because the blob is not projected by any read here.
 *
 * The rule the ported column brought with it stands, and it is why `reconciled`
 * is mapped through `answeredFlag` rather than through `flag`: the column is
 * NULLABLE, and a NULL means "ask `cleared`"
 * (`utils/transactionReconciliation.ts`), which is the one-flag behaviour a row
 * written before the split is still describing. Inventing `false` for one would
 * report a whole reconciled history as unreconciled work.
 */

import { mapAccountFromDb } from '../../api/accountMapping';
import {
  BUDGET_COLUMNS,
  CATEGORY_COLUMNS,
  CUSTOM_REPORT_COLUMNS,
  DISMISSAL_COLUMNS,
  GOAL_COLUMNS,
  SPLIT_COLUMNS,
  TRANSACTION_COLUMNS,
  fieldsOf
} from './columns';
import { parseReportComponents, parseReportFilters } from '../../reports/document';
import type {
  Account,
  Budget,
  Category,
  CustomReport,
  ForecastAdjustment,
  Goal,
  SuggestionDismissal,
  Transaction,
  TransactionSplit,
  TransferDisplacedOutcome
} from '../../../types';
import type { AccountBalanceSnapshot } from '../../port/dataPort';
import { field, instant, isRecord, moneyOr, oneOf, strings, text, textOr, whole } from './values';

/**
 * A listed account.
 *
 * The crate's row IS the `accounts` row, column for column and name for name,
 * so it goes straight through `mapAccountFromDb` — the same function the
 * signed-in boot uses — which is what keeps `lowBalanceAlertEnabled`,
 * `sortCode`/`accountNumber` and the opening balance from being forgotten by a
 * second mapper, as they were once before.
 *
 * **This used to rename `kind` to `type` on the way past, and that was wrong.**
 * The crate's Rust field is called `kind` because `type` is a reserved word
 * there, and every row struct carries `#[serde(rename = "type")]` to put it
 * back — so the JSON says `type` and always did. The rename therefore read a key
 * that is not there and overwrote the real one with `undefined`: every account
 * loaded from a file came back typed 'other'. It threw nothing and no read rule
 * asked, which is how it survived a slice. See `columns.ts`, where the wire name
 * is now stated once for both directions.
 */
export const toAccount = (row: Record<string, unknown>): Account => mapAccountFromDb(row);

/** Every category value the app knows, as a runtime lookup (see `oneOf`). */
const CATEGORY_TYPES: Record<Category['type'], true> = {
  income: true,
  expense: true,
  both: true
};

const CATEGORY_LEVELS: Record<Category['level'], true> = {
  type: true,
  sub: true,
  detail: true
};

/**
 * A category.
 *
 * Through {@link CATEGORY_COLUMNS} since slice 21, which is the same list
 * `writes.ts` serialises a new category and a patch with — so a field cannot be
 * written under one name and read back under another. It read the row's keys by
 * hand until the day it had a writer, which is the arrangement `columns.ts`
 * describes and the reason the move happened in the commit that gave it one
 * rather than in a tidy-up of its own.
 *
 * `parentId` is `null` rather than absent when the column is NULL, because the
 * app's type says `string | null` and the Categories page tests it against
 * `null` when it decides whether a row is a top-level heading. `accountId` is
 * the opposite — `string | undefined` — and is left absent, matching
 * `categoryFromDb`.
 */
export const toCategory = (row: Record<string, unknown>): Category => {
  const value = fieldsOf(CATEGORY_COLUMNS, row);
  return {
    id: textOr(value.id, ''),
    name: textOr(value.name, ''),
    type: oneOf<Category['type']>(value.type, CATEGORY_TYPES, 'expense'),
    level: oneOf<Category['level']>(value.level, CATEGORY_LEVELS, 'detail'),
    parentId: text(value.parentId) ?? null,
    color: text(value.color),
    icon: text(value.icon),
    isSystem: value.isSystem === true,
    isTransferCategory: value.isTransferCategory === true,
    isRevaluationCategory: value.isRevaluationCategory === true,
    isUnassignedBucket: value.isUnassignedBucket === true,
    accountId: text(value.accountId),
    isActive: value.isActive === true
  };
};

const TRANSACTION_TYPES: Record<Transaction['type'], true> = {
  income: true,
  expense: true,
  transfer: true
};

/**
 * A listed transaction.
 *
 * Every value comes through {@link TRANSACTION_COLUMNS}, which is the SAME list
 * `writes.ts` serialises a draft with — so a column cannot be read under one
 * name and written under another, and cannot be a day in one direction and an
 * instant in the other. What is left here is assembly: which fields the app's
 * type requires, and what each one becomes when the file said nothing.
 *
 * `category` is `''` rather than absent when the column is NULL, because the
 * app's type says `string` and a split parent legitimately holds no category of
 * its own (`transactions_split_parent_has_blank_category` in the schema makes
 * that a constraint rather than a habit).
 *
 * `category_id` is deliberately NOT in the table: `Transaction` has no such
 * field. The cloud's mapper produces the key anyway because it renames every
 * column it meets and then casts the result, so nothing there notices; carrying
 * it here would be inventing a property the app has no reader for.
 */
export const toTransaction = (row: Record<string, unknown>): Transaction => {
  const value = fieldsOf(TRANSACTION_COLUMNS, row);
  return {
    id: textOr(value.id, ''),
    accountId: textOr(value.accountId, ''),
    amount: typeof value.amount === 'number' ? value.amount : 0,
    date: value.date instanceof Date ? value.date : new Date(0),
    description: textOr(value.description, ''),
    category: textOr(value.category, ''),
    categoryConfirmed: value.categoryConfirmed === true,
    needsReview: value.needsReview === true,
    type: oneOf<Transaction['type']>(value.type, TRANSACTION_TYPES, 'expense'),
    tags: strings(value.tags),
    notes: text(value.notes),
    cleared: value.cleared === true,
    // NOT `=== true`, and that is the whole of the C/R split on this side: the
    // column is three-valued, and `undefined` means "ask `cleared`" rather than
    // "not committed". `answeredFlag` is what keeps the three apart on the way
    // in; flattening them here would undo it in the last line that touches the
    // value.
    reconciled: typeof value.reconciled === 'boolean' ? value.reconciled : undefined,
    isRecurring: value.isRecurring === true,
    isSplit: value.isSplit === true,
    archived: value.archived === true,
    statementSequence: whole(value.statementSequence) ?? null,
    createdAt: value.createdAt instanceof Date ? value.createdAt : undefined,
    updatedAt: value.updatedAt instanceof Date ? value.updatedAt : undefined,
    linkedTransferId: text(value.linkedTransferId),
    transferAccountId: text(value.transferAccountId),
    linkedTransferSplitId: text(value.linkedTransferSplitId)
  };
};

/**
 * A split line.
 *
 * The two transfer-leg fields are omitted rather than set to `undefined` when
 * they are null, matching `transactionService.mapSplitRow`: the register asks
 * `'transferAccountId' in line` in places, and a present-but-undefined key
 * answers that question the wrong way.
 */
export const toSplit = (row: Record<string, unknown>): TransactionSplit => {
  const value = fieldsOf(SPLIT_COLUMNS, row);
  return {
    id: textOr(value.id, ''),
    transactionId: textOr(value.transactionId, ''),
    category: textOr(value.category, ''),
    amount: typeof value.amount === 'number' ? value.amount : 0,
    memo: text(value.memo) === '' ? undefined : text(value.memo),
    sortOrder: whole(value.sortOrder) ?? 0,
    ...(text(value.transferAccountId) ? { transferAccountId: text(value.transferAccountId) } : {}),
    ...(text(value.linkedTransferId) ? { linkedTransferId: text(value.linkedTransferId) } : {})
  };
};

const BUDGET_PERIODS: Record<Budget['period'], true> = {
  monthly: true,
  weekly: true,
  yearly: true,
  custom: true,
  quarterly: true,
  every: true
};

/**
 * A budget.
 *
 * Through {@link BUDGET_COLUMNS} since slice 22, which is the same list
 * `writes.ts` serialises a new budget and a patch with — so a field cannot be
 * written under one name and read back under another. It read the row's keys by
 * hand until the day it had a writer, which is the arrangement `columns.ts`
 * describes.
 *
 * `categoryId` comes out of the TEXT `category` column and never out of
 * `category_id`, which is `budgetFromDb`'s decision and its reason verbatim:
 * *"frontend category ids are not UUIDs, so the uuid `category_id` column
 * cannot hold them"*. The table carries that rename, so the write direction
 * cannot pick the other column by accident.
 *
 * `alertThreshold` arrives as the crate's already-rendered percentage string
 * ('80.00' for the stored 8000 basis-points-of-a-percent). It is read with the
 * money reader because the shape is the same — a fixed two-place decimal — and
 * NOT because it is money: `schema.sql` says in capitals that it is not, and
 * dividing 8000 by 100 on this side of the boundary is precisely the arithmetic
 * this directory forbids.
 *
 * A stored period the app has no member for — the schema allows 'biweekly',
 * the app's union does not — reads as 'custom', which is the app's own name for
 * a cadence none of the standard ones describe. A cast would put a string the
 * budgets page has no branch for into a period selector.
 */
export const toBudget = (row: Record<string, unknown>): Budget => {
  const value = fieldsOf(BUDGET_COLUMNS, row);
  return {
    id: textOr(value.id, ''),
    categoryId: textOr(value.categoryId, ''),
    amount: typeof value.amount === 'number' ? value.amount : 0,
    period: oneOf<Budget['period']>(value.period, BUDGET_PERIODS, 'custom'),
    // The `every` pair: null, not undefined, when the row has none — the
    // app's own type says a stated null is "no interval".
    repeatCount: whole(value.repeatCount) ?? null,
    repeatUnit: value.repeatUnit === 'week' || value.repeatUnit === 'month' ? value.repeatUnit : null,
    isActive: value.isActive === true,
    // Not in the table: stamped by the file's clock inside the write, and read
    // here off the row the crate answered with.
    createdAt: instant(row.created_at) ?? new Date(0),
    updatedAt: instant(row.updated_at) ?? new Date(0),
    name: text(value.name),
    spent: typeof value.spent === 'number' ? value.spent : 0,
    startDate: text(value.startDate),
    endDate: text(value.endDate),
    rollover: value.rollover === true,
    rolloverAmount: typeof value.rolloverAmount === 'number' ? value.rolloverAmount : 0,
    alertThreshold: typeof value.alertThreshold === 'number' ? value.alertThreshold : undefined,
    notes: text(value.notes)
  };
};

const GOAL_TYPES: Record<Goal['type'], true> = {
  savings: true,
  'debt-payoff': true,
  investment: true,
  custom: true
};

const GOAL_PRIORITIES: Record<NonNullable<Goal['priority']>, true> = {
  low: true,
  medium: true,
  high: true
};

const GOAL_STATUSES: Record<NonNullable<Goal['status']>, true> = {
  active: true,
  completed: true,
  paused: true
};

/**
 * A goal, mapped exactly as `goalFromDb` maps the cloud's row.
 *
 * Through {@link GOAL_COLUMNS} since slice 22, for the fifteen columns that
 * really are one column and one field. The three that are not are assembled
 * here, and every one of them is a decision `goalFromDb` already took:
 *
 *  - `type` is not a column in either engine. It lives in `metadata.type`, and
 *    'savings' is the default a goal with no stated kind reads as.
 *  - `isActive` is "the status is not paused" and `achieved` is "the status is
 *    completed". One column answers both, because a goal has one state.
 *  - `progress` IS `currentAmount`. It is not derived from the target and it is
 *    never zero for a goal created with money already put by — the rule the
 *    contract suite asks for by name, and the one that used to be lost
 *    differently by each engine. `writes.ts` folds the same two fields back
 *    into the same column on the way out, with the same precedence the cloud's
 *    mapper uses.
 *
 * `status` is read against the app's three values, so the schema's fourth
 * ('canceled', which no screen offers and nothing writes) reads as 'active'
 * rather than as a value the goals page cannot draw.
 */
export const toGoal = (row: Record<string, unknown>): Goal => {
  const value = fieldsOf(GOAL_COLUMNS, row);
  const currentAmount = typeof value.currentAmount === 'number' ? value.currentAmount : 0;
  // Annotated rather than inferred: without it TypeScript narrows the result to
  // the literal type of the fallback, and the two comparisons below — which are
  // the whole of "one column answers both questions" — become comparisons
  // between types with no overlap.
  const status: NonNullable<Goal['status']> = oneOf<NonNullable<Goal['status']>>(value.status, GOAL_STATUSES, 'active');
  const completedAt = value.completedAt;
  return {
    id: textOr(value.id, ''),
    name: textOr(value.name, ''),
    type: oneOf<Goal['type']>(field(row.metadata, 'type'), GOAL_TYPES, 'savings'),
    targetAmount: typeof value.targetAmount === 'number' ? value.targetAmount : 0,
    currentAmount,
    progress: currentAmount,
    // A goal with no target date is a goal with no deadline; the app's type
    // says Date, so "no deadline" is the epoch rather than an Invalid Date that
    // renders as "NaN/NaN/NaN" in the one place the page prints it.
    targetDate: value.targetDate instanceof Date ? value.targetDate : new Date(0),
    description: text(value.description),
    isActive: status !== 'paused',
    achieved: status === 'completed',
    status,
    completedAt: completedAt instanceof Date ? completedAt.toISOString() : undefined,
    createdAt: instant(row.created_at) ?? new Date(0),
    updatedAt: instant(row.updated_at) ?? new Date(0),
    category: text(value.category),
    priority: typeof value.priority === 'string'
      ? oneOf<NonNullable<Goal['priority']>>(value.priority, GOAL_PRIORITIES, 'medium')
      : undefined,
    accountId: text(value.accountId),
    autoContribute: value.autoContribute === true,
    contributionFrequency: text(value.contributionFrequency),
    icon: text(value.icon),
    color: text(value.color)
  };
};

/**
 * A custom report.
 *
 * THE ONE MAPPING HERE WHOSE HARD PART IS SHARED WITH ITS CLOUD TWIN, and the
 * exception is deliberate rather than lucky. The header above explains why the
 * other six had to be written out — `budgetFromDb` and `goalFromDb` live inside
 * a module that reaches a Supabase client on its first line — and it names the
 * guard against drift as the contract suite rather than as care.
 *
 * That guard is not strong enough for this entity. `components` and `filters`
 * are free JSON on both engines, so nothing in either store constrains what is
 * inside them, and two independent readers would not disagree about a FIELD —
 * they would draw DIFFERENT REPORTS from one stored definition, which is the
 * kind of difference a round-trip test agrees with itself about. So the reading
 * of the two blobs lives in `services/reports/document.ts`, a module that
 * imports two types and nothing else, and the cloud's `customReportFromDb` calls
 * exactly the same two functions.
 *
 * What is left here is ASSEMBLY, and it is the same three decisions
 * `customReportFromDb` takes: a nullable `description` reads as '' because the
 * app's type says a report always has one, and the two timestamps fall back to
 * the epoch rather than to `new Date()` the way every other mapper in this file
 * does — a row whose clock could not be read is not a row created now.
 */
/**
 * A forecast adjustment, from either engine's answer row.
 *
 * Read directly rather than through a `Column` spec: three fields, none of
 * them money-scaled or tri-state — `monthly_minor` is an integer of pennies
 * in BOTH engines, the row's whole point, so there is no conversion for a
 * spec to declare.
 */
export const toForecastAdjustment = (row: Record<string, unknown>): ForecastAdjustment => ({
  id: textOr(row.id, ''),
  categoryId: textOr(row.category_id, ''),
  monthlyMinor: Number(row.monthly_minor ?? 0),
  createdAt: instant(row.created_at) ?? new Date(0),
  updatedAt: instant(row.updated_at) ?? new Date(0)
});

export const toCustomReport = (row: Record<string, unknown>): CustomReport => {
  const value = fieldsOf(CUSTOM_REPORT_COLUMNS, row);
  return {
    id: textOr(value.id, ''),
    name: textOr(value.name, ''),
    description: textOr(value.description, ''),
    components: parseReportComponents(value.components),
    filters: parseReportFilters(value.filters),
    createdAt: instant(row.created_at) ?? new Date(0),
    updatedAt: instant(row.updated_at) ?? new Date(0)
  };
};

/**
 * Every kind the APP knows, and — since slice 23 — every kind the file can
 * store.
 *
 * This list stayed the APP's while `scripts/local-sqlite/schema.sql` spelled its
 * CHECK `kind IN ('transfer-pair','transfer-leg','stranded','duplicate')`: the
 * three payee kinds arrived in the cloud after the local mirror was written, so
 * a value the reader understood could not actually reach it, and a backup
 * carrying one would have been refused by that constraint on the way in. The gap
 * was recorded here rather than papered over, and it was fixed where it lived —
 * `dismiss_suggestion` is the write that made it reachable and the schema is
 * where the CHECK was widened, with the reason beside the constraint.
 *
 * It is still spelled out rather than derived, and the reason is unchanged: this
 * is the APP's vocabulary, and a reader that narrowed to whatever the file
 * happened to admit would silently start answering `duplicate` for a kind the
 * cloud had just added.
 */
const DISMISSAL_KINDS: Record<SuggestionDismissal['kind'], true> = {
  'transfer-pair': true,
  'transfer-leg': true,
  stranded: true,
  duplicate: true,
  'payee-merchant': true,
  'payee-line': true,
  'payee-hidden': true,
  'recurring-confirmed': true,
  'recurring-not': true,
  'forecast-excluded': true
};

/**
 * A dismissal, with the child table already folded back into an array.
 *
 * `subject_ids` is a `uuid[]` column in the cloud and a joined child table
 * locally (`suggestion_dismissal_subjects`, ordered by `role_order`) — the verb
 * does the join, so what arrives here is the array either engine's caller
 * expects, IN ROLE ORDER. The positions are the fact: for a transfer pair they
 * say which row was the out and which the in, so `strings` is the one kind in
 * `columns.ts` whose order-preservation is load-bearing rather than incidental.
 *
 * Through `fieldsOf` since slice 23, with `dismissSuggestion`'s payload. The
 * `kind` narrowing stays here because it is ASSEMBLY: the table carries the
 * correspondence, and *which strings are admissible* is a decision, not a
 * conversion.
 */
export const toDismissal = (row: Record<string, unknown>): SuggestionDismissal => {
  const value = fieldsOf(DISMISSAL_COLUMNS, row);
  return {
    id: textOr(value.id, ''),
    kind: oneOf<SuggestionDismissal['kind']>(value.kind, DISMISSAL_KINDS, 'duplicate'),
    subjectKey: textOr(value.subjectKey, ''),
    subjectIds: strings(value.subjectIds),
    dismissedAt: value.dismissedAt instanceof Date ? value.dismissedAt : new Date(0)
  };
};

/**
 * What became of the counterpart a re-point displaced.
 *
 * The ninth translation, and the only one that is a UNION rather than a row:
 * the crate tags it `{"kind": "moved" | "released" | "deleted"}` and the app's
 * `TransferDisplacedOutcome` is the same three shapes in camelCase. The tag is
 * read first and the rest of the object only after, so a shape this file has
 * never heard of is a FAULT rather than a silently half-read object — the
 * caller acts on this to decide which accounts to move, and "I could not tell
 * what happened" must not arrive looking like "nothing happened".
 *
 * `moved` names no row because the row IS the result's `counterpart`, at a new
 * address; `released` carries the whole transaction because the caller has to
 * put an unlinked, uncategorised row back into a register it is not looking at;
 * `deleted` carries what is needed to reverse a balance and nothing else,
 * because the row is gone.
 */
export const toDisplaced = (value: unknown): TransferDisplacedOutcome => {
  const kind = field(value, 'kind');
  if (kind === 'moved') {
    return { kind: 'moved', fromAccountId: textOr(field(value, 'from_account_id'), '') };
  }
  if (kind === 'released') {
    const row = field(value, 'transaction');
    if (!isRecord(row)) {
      throw new Error('The ledger file released a counterpart without saying which row.');
    }
    return { kind: 'released', transaction: toTransaction(row) };
  }
  if (kind === 'deleted') {
    return {
      kind: 'deleted',
      id: textOr(field(value, 'id'), ''),
      accountId: textOr(field(value, 'account_id'), ''),
      amount: moneyOr(field(value, 'amount'), 0)
    };
  }
  throw new Error(
    `The ledger file said a re-point displaced its counterpart in a way this app does not know: ${JSON.stringify(kind)}.`
  );
};

/**
 * One account's DERIVED balance — `initial_balance + Σ amounts`, computed where
 * the rows are and never read off `accounts.balance`.
 *
 * `txnCount` is `COUNT(t.id)` under a LEFT JOIN, so an account with no
 * transactions answers 0 rather than 1. The crate holds that property (and the
 * three beside it) in `row/balance.rs`; this side only reads the answer.
 */
export const toBalance = (
  row: Record<string, unknown>
): { accountId: string; snapshot: AccountBalanceSnapshot } => ({
  accountId: textOr(row.account_id, ''),
  snapshot: {
    balance: moneyOr(row.balance, 0),
    txnCount: whole(row.txn_count) ?? 0
  }
});
