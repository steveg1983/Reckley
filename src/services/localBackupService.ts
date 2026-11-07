import { storageAdapter, STORAGE_KEYS } from './storageAdapter';
import { browserAbsence } from './backup/browserCoverage';
import { toDecimal } from '../utils/decimal';
import { normaliseRolloverMode } from '../utils/budgetPeriods';
import { preferences, type PreferencesDocument } from './preferencesService';
import {
  BACKUP_ENTITIES,
  MAX_EXACT_MONEY,
  buildBackupBundle,
  remapBackupIds,
  type BackupBundle,
  type BackupEntity,
  type BackupRow,
  type DanglingReference,
  type ExportProgress,
  type RestoreProgress,
} from './backupService';

/**
 * Backup and restore for the browser's own copy — demo mode, local mode, and
 * any session where the cloud is not configured.
 *
 * Until this existed a local user could not save their data AT ALL.
 * backupService talks to Supabase from its first line (`import { supabase }`)
 * and resolves `client ?? supabase`, so every entry point threw "Backup and
 * restore need the cloud connection". storageAdapter.exportData/importData
 * existed but nothing in the product ever called them.
 *
 * ── THE SEAM ────────────────────────────────────────────────────────────────
 * `buildBackupBundle` is a pure function over rows, and `remapBackupIds`,
 * `findUnsafeMoneyValues` and `validateBackupBundle` are pure over the bundle.
 * Only the code that FETCHES rows was ever coupled to Supabase. So this module
 * supplies rows from browser storage and hands them to the same builder: one
 * format, one validator, one id remapper, two storage engines.
 *
 * ── WHY ROWS ARE CONVERTED RATHER THAN COPIED ───────────────────────────────
 * Browser storage holds the APP's types — camelCase, `openingBalance`,
 * `linkedTransferId`. The backup format holds DATABASE rows — snake_case,
 * `initial_balance`, `linked_transfer_id`. Writing the app's shape into a file
 * tagged `reckley-backup-v2` would be a second format wearing the first
 * one's name, and it would also be broken: `remapBackupIds` looks up
 * `account_id`, `transfer_account_id`, `parent_account_id` and friends BY
 * COLUMN NAME, so an app-shaped bundle would come back with every transaction
 * still pointing at ids from the old dataset — silently, because nothing local
 * enforces a foreign key. Converting is not tidiness; it is what makes the
 * shared machinery work at all.
 *
 * The column names below are taken from the app's OWN cloud mappers
 * (accountService.mapAccountToDb, planningService.budgetToDb/goalToDb/
 * categoryToDb, transactionService.CAMEL_TO_DB, transactionService.mapSplitRow,
 * suggestionDismissalService.toDismissal) rather than invented here, so a local
 * backup carries exactly the columns the cloud path would have written.
 *
 * ── WHAT A LOCAL FILE DOES NOT CARRY ────────────────────────────────────────
 * The same provider ids a cloud backup leaves behind: `plaid_account_id`,
 * `plaid_connection_id`, `plaid_transaction_id`. They are globally unique and
 * restore_user_chunk strips them anyway, so carrying them would only invite a
 * collision with whoever exported them.
 */

// ── Storage port ────────────────────────────────────────────────────────────

/**
 * The slice of browser storage this module needs.
 *
 * `setMany` is the whole atomicity story: it is ONE IndexedDB readwrite
 * transaction, so a restore either lands completely or leaves the previous
 * contents untouched. A per-key loop could not promise that — a failure on the
 * ninth key would leave eight tables from the file beside six from before.
 */
export interface LocalBackupStore {
  get<T>(key: string): Promise<T | null>;
  setMany(entries: ReadonlyArray<{ key: string; value: unknown }>): Promise<void>;
}

const defaultStore = (): LocalBackupStore => storageAdapter;

/**
 * The preferences half of the file, on a device.
 *
 * Its own port rather than another storage key, because on this engine the
 * preferences document does not live in the encrypted store at all — it lives
 * in the same service the cloud path reads, whose browser mirror IS the store
 * when nobody is signed in. Injecting it keeps the test honest and keeps this
 * module from reaching for a singleton mid-function.
 */
export interface LocalPreferencesPort {
  read(): PreferencesDocument;
  write(document: PreferencesDocument): Promise<void>;
}

const defaultPreferences = (): LocalPreferencesPort => ({
  read: () => preferences.getDocument(),
  write: (document) => preferences.replaceAll(document),
});

// ── Small readers ───────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A non-empty string, or undefined. Empty strings are absences, not values. */
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const bool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const numeric = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const textArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined;

/**
 * A `timestamptz` column: the full instant, as ISO 8601.
 *
 * Browser storage is JSON, so a Date written by the app is READ BACK as the
 * string it serialised to. Both spellings therefore turn up here depending on
 * whether the value has been through storage yet, and both must land on the
 * same column value or an export would differ from itself.
 */
function timestampColumn(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  const raw = text(value);
  if (raw === undefined) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * A `date` column: the calendar day alone, 'YYYY-MM-DD'.
 *
 * A day with a time on it is TRUNCATED, deliberately and visibly. These columns
 * are Postgres DATEs; the cloud has always stored the day only, and a backup
 * that claimed otherwise would restore differently on the two engines. A value
 * that is already a day is passed through untouched rather than parsed, because
 * `new Date('2026-01-15')` invents a UTC midnight and midnight belongs to a
 * zone — which is how a transaction dated the 15th comes back as the 14th west
 * of Greenwich.
 */
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function dateColumn(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString().slice(0, 10);
  }
  const raw = text(value);
  if (raw === undefined) return undefined;
  if (DAY_ONLY.test(raw)) return raw;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

/**
 * Write a column only when the app holds something for it.
 *
 * `null` IS written: a parent_account_id of null says "this account hangs under
 * nothing", which is not the same as a row that never mentioned the column.
 */
function put(row: BackupRow, column: string, value: unknown): void {
  if (value !== undefined) row[column] = value;
}

// ── Fields the format has no column for ─────────────────────────────────────

/**
 * Where app fields with no column of their own ride.
 *
 * Namespaced under the `metadata` jsonb the four biggest tables already have,
 * for the same reason goalToDb puts `type` and `linkedAccountIds` there: the
 * alternative is dropping them, and for a LOCAL user browser storage is the
 * only copy in existence. A cloud backup has no such key, so reading one back
 * simply finds nothing — the hatch costs nothing in the other direction.
 *
 * NOT a licence to skip mapping: a field holding another row's ID must be given
 * a real column, because remapBackupIds works from ENTITY_REFERENCES and never
 * looks inside metadata. Anything parked here comes back pointing at the
 * dataset it left.
 */
const LOCAL_ONLY_FIELDS = 'localOnlyFields';

/** Everything on the app object that the column map above did not consume. */
function localOnlyFields(
  app: Record<string, unknown>,
  carried: ReadonlySet<string>
): Record<string, unknown> | undefined {
  const rest: Record<string, unknown> = {};
  let found = false;
  for (const [key, value] of Object.entries(app)) {
    if (carried.has(key) || value === undefined) continue;
    rest[key] = value;
    found = true;
  }
  return found ? rest : undefined;
}

/** Attach the leftovers to a row that has a `metadata` column. */
function withLocalOnlyFields(row: BackupRow, rest: Record<string, unknown> | undefined): BackupRow {
  if (rest === undefined) return row;
  const existing = isRecord(row.metadata) ? row.metadata : {};
  return { ...row, metadata: { ...existing, [LOCAL_ONLY_FIELDS]: rest } };
}

/** Read them back off a row this app wrote. Absent for every cloud-written row. */
function readLocalOnlyFields(row: BackupRow): Record<string, unknown> {
  if (!isRecord(row.metadata)) return {};
  const parked = row.metadata[LOCAL_ONLY_FIELDS];
  return isRecord(parked) ? parked : {};
}

/** Drop `undefined` entries so a restored object matches what storage held. */
function compact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ── accounts ────────────────────────────────────────────────────────────────

/**
 * App names this entity's columns account for, plus the two deliberately left
 * behind. Anything not listed rides in metadata; see localOnlyFields.
 */
const ACCOUNT_CARRIED = new Set<string>([
  'id', 'name', 'type', 'balance', 'currency', 'institution', 'lastUpdated',
  'openingBalance', 'openingBalanceDate', 'archiveThroughDate', 'parentAccountId',
  'notes', 'isActive', 'createdAt', 'sortCode', 'accountNumber', 'bankBalance',
  'bankBalanceDate', 'lastReconciledDate', 'lowBalanceThreshold', 'lowBalanceAlertEnabled',
  // Globally unique provider ids. restore_user_chunk strips both, so a file
  // that carried them could only ever collide with the login it came from.
  'plaidAccountId', 'plaidConnectionId',
]);

function accountToRow(app: Record<string, unknown>): BackupRow {
  const row: BackupRow = {};
  put(row, 'id', text(app.id));
  put(row, 'name', text(app.name));
  // The database calls a current account 'checking'; the UI calls it 'current'.
  // The same swap accountService has made on every cloud write since day one.
  const type = text(app.type);
  put(row, 'type', type === 'current' ? 'checking' : type);
  put(row, 'balance', app.balance);
  put(row, 'currency', text(app.currency));
  put(row, 'institution', app.institution ?? undefined);
  put(row, 'initial_balance', app.openingBalance);
  put(row, 'opening_balance_date', dateColumn(app.openingBalanceDate));
  put(row, 'archive_through_date', app.archiveThroughDate === null ? null : dateColumn(app.archiveThroughDate));
  put(row, 'parent_account_id', app.parentAccountId === null ? null : text(app.parentAccountId));
  put(row, 'secured_against_account_ids', Array.isArray(app.securedAgainstAccountIds) ? app.securedAgainstAccountIds : undefined);
  put(row, 'notes', app.notes ?? undefined);
  put(row, 'is_active', bool(app.isActive));
  put(row, 'sort_code', text(app.sortCode));
  put(row, 'account_number', text(app.accountNumber));
  put(row, 'bank_balance', app.bankBalance === null ? null : numeric(app.bankBalance));
  put(row, 'bank_balance_date', app.bankBalanceDate === null ? null : dateColumn(app.bankBalanceDate));
  put(row, 'last_reconciled_date', app.lastReconciledDate === null ? null : dateColumn(app.lastReconciledDate));
  put(row, 'low_balance_threshold', numeric(app.lowBalanceThreshold));
  put(row, 'low_balance_alert_enabled', bool(app.lowBalanceAlertEnabled));
  put(row, 'created_at', timestampColumn(app.createdAt));
  // `lastUpdated` is what the app calls updated_at — there is no `last_updated`
  // column, however confidently ACCOUNT_CAMEL_TO_DB names one.
  put(row, 'updated_at', timestampColumn(app.lastUpdated));
  return withLocalOnlyFields(row, localOnlyFields(app, ACCOUNT_CARRIED));
}

function accountFromRow(row: BackupRow): Record<string, unknown> {
  const type = text(row.type);
  return compact({
    ...readLocalOnlyFields(row),
    id: text(row.id),
    name: text(row.name),
    type: type === 'checking' ? 'current' : type,
    balance: row.balance,
    currency: text(row.currency),
    institution: text(row.institution),
    openingBalance: row.initial_balance,
    openingBalanceDate: text(row.opening_balance_date),
    archiveThroughDate: row.archive_through_date === null ? null : text(row.archive_through_date),
    parentAccountId: row.parent_account_id === null ? null : text(row.parent_account_id),
    securedAgainstAccountIds: Array.isArray(row.secured_against_account_ids) ? row.secured_against_account_ids : undefined,
    notes: text(row.notes),
    isActive: bool(row.is_active),
    sortCode: text(row.sort_code),
    accountNumber: text(row.account_number),
    bankBalance: row.bank_balance === null ? null : numeric(row.bank_balance),
    bankBalanceDate: row.bank_balance_date === null ? null : text(row.bank_balance_date),
    lastReconciledDate: row.last_reconciled_date === null ? null : text(row.last_reconciled_date),
    lowBalanceThreshold: numeric(row.low_balance_threshold),
    lowBalanceAlertEnabled: bool(row.low_balance_alert_enabled),
    createdAt: text(row.created_at),
    lastUpdated: text(row.updated_at),
  });
}

// ── categories ──────────────────────────────────────────────────────────────

/**
 * No leftovers hatch here, and none is possible: categories has no `metadata`
 * column. Every field of Category maps to a column except `description`, which
 * has no column in the schema, no writer anywhere in the app and no reader —
 * so it is not carried, and this comment is the only place anyone would find
 * that out.
 */
function categoryToRow(app: Record<string, unknown>): BackupRow {
  const row: BackupRow = {};
  put(row, 'id', text(app.id));
  put(row, 'name', text(app.name));
  put(row, 'type', text(app.type));
  put(row, 'level', text(app.level));
  put(row, 'parent_id', app.parentId === null ? null : text(app.parentId));
  put(row, 'color', text(app.color));
  put(row, 'icon', text(app.icon));
  put(row, 'is_system', bool(app.isSystem));
  put(row, 'is_transfer_category', bool(app.isTransferCategory));
  put(row, 'is_revaluation_category', bool(app.isRevaluationCategory));
  put(row, 'is_unassigned_bucket', bool(app.isUnassignedBucket));
  put(row, 'account_id', app.accountId === null ? null : text(app.accountId));
  put(row, 'is_active', bool(app.isActive));
  return row;
}

function categoryFromRow(row: BackupRow): Record<string, unknown> {
  return compact({
    id: text(row.id),
    name: text(row.name),
    type: text(row.type),
    level: text(row.level),
    parentId: row.parent_id === null ? null : text(row.parent_id),
    color: text(row.color),
    icon: text(row.icon),
    isSystem: bool(row.is_system),
    isTransferCategory: bool(row.is_transfer_category),
    isRevaluationCategory: bool(row.is_revaluation_category),
    isUnassignedBucket: bool(row.is_unassigned_bucket),
    accountId: text(row.account_id),
    isActive: bool(row.is_active),
  });
}

// ── transactions ────────────────────────────────────────────────────────────

const TRANSACTION_CARRIED = new Set<string>([
  'id', 'date', 'amount', 'description', 'category', 'accountId', 'type', 'tags',
  'notes', 'cleared', 'isRecurring', 'isSplit', 'archived', 'merchant',
  'paymentChannel', 'transferAccountId', 'linkedTransferId', 'linkedTransferSplitId',
  'createdAt', 'updatedAt',
  // Globally unique; stripped by restore_user_chunk for the same reason.
  'plaidTransactionId',
]);

function transactionToRow(app: Record<string, unknown>): BackupRow {
  const row: BackupRow = {};
  put(row, 'id', text(app.id));
  put(row, 'account_id', text(app.accountId));
  put(row, 'date', dateColumn(app.date));
  put(row, 'amount', app.amount);
  put(row, 'description', typeof app.description === 'string' ? app.description : undefined);
  // `category` is TEXT holding a category's id. It is the field most easily
  // forgotten and the most expensive to forget: miss it and every categorised
  // transaction comes back filed under an id that no longer exists.
  put(row, 'category', text(app.category));
  put(row, 'type', text(app.type));
  put(row, 'tags', textArray(app.tags));
  put(row, 'notes', text(app.notes));
  put(row, 'is_cleared', bool(app.cleared));
  put(row, 'is_recurring', bool(app.isRecurring));
  put(row, 'is_split', bool(app.isSplit));
  put(row, 'archived', bool(app.archived));
  put(row, 'merchant_name', text(app.merchant));
  put(row, 'payment_channel', text(app.paymentChannel));
  put(row, 'transfer_account_id', text(app.transferAccountId));
  put(row, 'linked_transfer_id', text(app.linkedTransferId));
  put(row, 'linked_transfer_split_id', text(app.linkedTransferSplitId));
  put(row, 'created_at', timestampColumn(app.createdAt));
  put(row, 'updated_at', timestampColumn(app.updatedAt));
  return withLocalOnlyFields(row, localOnlyFields(app, TRANSACTION_CARRIED));
}

function transactionFromRow(row: BackupRow): Record<string, unknown> {
  return compact({
    ...readLocalOnlyFields(row),
    id: text(row.id),
    accountId: text(row.account_id),
    date: text(row.date),
    amount: row.amount,
    description: typeof row.description === 'string' ? row.description : undefined,
    category: text(row.category),
    type: text(row.type),
    tags: textArray(row.tags),
    notes: text(row.notes),
    cleared: bool(row.is_cleared),
    isRecurring: bool(row.is_recurring),
    isSplit: bool(row.is_split),
    archived: bool(row.archived),
    merchant: text(row.merchant_name),
    paymentChannel: text(row.payment_channel),
    transferAccountId: text(row.transfer_account_id),
    linkedTransferId: text(row.linked_transfer_id),
    linkedTransferSplitId: text(row.linked_transfer_split_id),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  });
}

// ── transaction_splits ──────────────────────────────────────────────────────

function splitToRow(app: Record<string, unknown>): BackupRow {
  const row: BackupRow = {};
  put(row, 'id', text(app.id));
  put(row, 'transaction_id', text(app.transactionId));
  put(row, 'category', text(app.category));
  put(row, 'amount', app.amount);
  put(row, 'memo', text(app.memo));
  put(row, 'sort_order', numeric(app.sortOrder));
  put(row, 'transfer_account_id', text(app.transferAccountId));
  put(row, 'linked_transfer_id', text(app.linkedTransferId));
  return row;
}

function splitFromRow(row: BackupRow): Record<string, unknown> {
  return compact({
    id: text(row.id),
    transactionId: text(row.transaction_id),
    category: text(row.category),
    amount: row.amount,
    memo: text(row.memo),
    sortOrder: numeric(row.sort_order),
    transferAccountId: text(row.transfer_account_id),
    linkedTransferId: text(row.linked_transfer_id),
  });
}

// ── budgets ─────────────────────────────────────────────────────────────────

const BUDGET_CARRIED = new Set<string>([
  'id', 'categoryId', 'amount', 'period', 'isActive', 'createdAt', 'updatedAt',
  'name', 'spent', 'startDate', 'endDate', 'rolloverMode',
  'alertThreshold', 'notes',
]);

function budgetToRow(app: Record<string, unknown>): BackupRow {
  const row: BackupRow = {};
  put(row, 'id', text(app.id));
  // budgets.name is NOT NULL, and budgetToDb has always filled it the same way.
  // A row without it is one a cloud restore would refuse halfway through.
  put(row, 'name', text(app.name) ?? text(app.categoryId) ?? 'Budget');
  // The frontend's category id travels in the TEXT `category` column, not the
  // uuid `category_id` — default category ids are not uuids.
  put(row, 'category', text(app.categoryId));
  put(row, 'amount', app.amount);
  put(row, 'period', text(app.period));
  put(row, 'is_active', bool(app.isActive));
  put(row, 'spent', numeric(app.spent));
  put(row, 'start_date', dateColumn(app.startDate));
  put(row, 'end_date', dateColumn(app.endDate));
  put(row, 'rollover_mode', text(app.rolloverMode));
  put(row, 'alert_threshold', numeric(app.alertThreshold));
  put(row, 'notes', text(app.notes));
  put(row, 'created_at', timestampColumn(app.createdAt));
  put(row, 'updated_at', timestampColumn(app.updatedAt));
  return withLocalOnlyFields(row, localOnlyFields(app, BUDGET_CARRIED));
}

function budgetFromRow(row: BackupRow): Record<string, unknown> {
  return compact({
    ...readLocalOnlyFields(row),
    id: text(row.id),
    categoryId: text(row.category),
    amount: row.amount,
    period: text(row.period),
    isActive: bool(row.is_active),
    name: text(row.name),
    spent: numeric(row.spent),
    startDate: text(row.start_date),
    endDate: text(row.end_date),
    // A backup from before 7 Nov 2026 carries `rollover`/`rollover_amount`
    // instead: both are dropped here, as the cloud's restore drops a key
    // that is no longer a column, and the budget reads as starting afresh.
    rolloverMode: normaliseRolloverMode(row.rollover_mode),
    alertThreshold: numeric(row.alert_threshold),
    notes: text(row.notes),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  });
}

// ── goals ───────────────────────────────────────────────────────────────────

/**
 * Three Goal fields have no column and ride in `metadata`, exactly as goalToDb
 * puts them there on every cloud write: `type`, `linkedAccountIds` and
 * `contributionAmount`. They are handled explicitly rather than left to the
 * leftovers hatch so a goal written locally and a goal written by the cloud
 * produce the same row.
 */
const GOAL_CARRIED = new Set<string>([
  'id', 'name', 'description', 'targetAmount', 'currentAmount', 'progress',
  'targetDate', 'isActive', 'achieved', 'status', 'completedAt', 'createdAt',
  'updatedAt', 'category', 'priority', 'accountId', 'autoContribute',
  'contributionFrequency', 'icon', 'color',
  'type', 'linkedAccountIds', 'contributionAmount',
]);

function goalStatus(app: Record<string, unknown>): string | undefined {
  const status = text(app.status);
  if (status !== undefined) return status;
  if (app.achieved === true) return 'completed';
  const active = bool(app.isActive);
  if (active === undefined) return undefined;
  return active ? 'active' : 'paused';
}

function goalToRow(app: Record<string, unknown>): BackupRow {
  const row: BackupRow = {};
  put(row, 'id', text(app.id));
  put(row, 'name', text(app.name));
  put(row, 'description', text(app.description));
  put(row, 'target_amount', app.targetAmount);
  // `progress` is what the UI layer treats as the accumulated amount; goalToDb
  // prefers it over currentAmount for exactly that reason.
  put(row, 'current_amount', app.progress ?? app.currentAmount);
  put(row, 'target_date', dateColumn(app.targetDate));
  put(row, 'category', text(app.category));
  put(row, 'priority', text(app.priority));
  put(row, 'status', goalStatus(app));
  put(row, 'completed_at', timestampColumn(app.completedAt));
  put(row, 'account_id', text(app.accountId));
  put(row, 'auto_contribute', bool(app.autoContribute));
  put(row, 'contribution_frequency', text(app.contributionFrequency));
  put(row, 'icon', text(app.icon));
  put(row, 'color', text(app.color));
  put(row, 'created_at', timestampColumn(app.createdAt));
  put(row, 'updated_at', timestampColumn(app.updatedAt));

  const metadata: Record<string, unknown> = {};
  if (text(app.type) !== undefined) metadata.type = app.type;
  if (textArray(app.linkedAccountIds) !== undefined) metadata.linkedAccountIds = app.linkedAccountIds;
  if (numeric(app.contributionAmount) !== undefined) metadata.contributionAmount = app.contributionAmount;
  if (Object.keys(metadata).length > 0) row.metadata = metadata;

  return withLocalOnlyFields(row, localOnlyFields(app, GOAL_CARRIED));
}

function goalFromRow(row: BackupRow): Record<string, unknown> {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const status = text(row.status);
  const currentAmount = row.current_amount;
  return compact({
    ...readLocalOnlyFields(row),
    id: text(row.id),
    name: text(row.name),
    description: text(row.description),
    targetAmount: row.target_amount,
    currentAmount,
    progress: currentAmount,
    targetDate: text(row.target_date),
    category: text(row.category),
    priority: text(row.priority),
    status,
    isActive: status === undefined ? undefined : status !== 'paused',
    achieved: status === undefined ? undefined : status === 'completed',
    completedAt: text(row.completed_at),
    accountId: text(row.account_id),
    autoContribute: bool(row.auto_contribute),
    contributionFrequency: text(row.contribution_frequency),
    icon: text(row.icon),
    color: text(row.color),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    type: text(metadata.type),
    linkedAccountIds: textArray(metadata.linkedAccountIds),
    contributionAmount: numeric(metadata.contributionAmount),
  });
}

// ── custom_reports ──────────────────────────────────────────────────────────
//
// The two jsonb columns travel as VALUES, not as strings, in both directions.
// `buildBackupBundle` writes the bundle out with one `JSON.stringify` at the
// end, so a report whose components were stringified here would land in the file
// as a string containing JSON — and would restore into a jsonb column holding a
// JSON string, which `parseReportComponents` reads as "not an array" and answers
// with an empty report. Silently: nothing constrains the inside of that column
// on either engine.

function customReportToRow(app: Record<string, unknown>): BackupRow {
  const row: BackupRow = {};
  put(row, 'id', text(app.id));
  put(row, 'name', text(app.name));
  put(row, 'description', text(app.description));
  // `?? []` and `?? {}` rather than omitted: both columns are NOT NULL in the
  // cloud, and a report saved halfway through being built legitimately has no
  // components at all.
  put(row, 'components', Array.isArray(app.components) ? app.components : []);
  put(row, 'filters', isRecord(app.filters) ? app.filters : {});
  put(row, 'created_at', timestampColumn(app.createdAt));
  put(row, 'updated_at', timestampColumn(app.updatedAt));
  return row;
}

function customReportFromRow(row: BackupRow): Record<string, unknown> {
  return compact({
    id: text(row.id),
    name: text(row.name),
    description: text(row.description),
    components: Array.isArray(row.components) ? row.components : [],
    filters: isRecord(row.filters) ? row.filters : {},
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  });
}

// ── suggestion_dismissals ───────────────────────────────────────────────────

function dismissalToRow(app: Record<string, unknown>): BackupRow {
  const row: BackupRow = {};
  put(row, 'id', text(app.id));
  put(row, 'kind', text(app.kind));
  // subject_key is TEXT — row ids for the sweeps' kinds, which remapBackupIds
  // rewrites and re-sorts, and role-prefixed payee text for payee cleanup's,
  // which it leaves alone. Carrying it as-is, whichever it is, is what keeps a
  // refused suggestion refused.
  put(row, 'subject_key', text(app.subjectKey));
  put(row, 'subject_ids', textArray(app.subjectIds) ?? []);
  put(row, 'dismissed_at', timestampColumn(app.dismissedAt));
  return row;
}

function dismissalFromRow(row: BackupRow): Record<string, unknown> {
  return compact({
    id: text(row.id),
    kind: text(row.kind),
    subjectKey: text(row.subject_key),
    subjectIds: textArray(row.subject_ids) ?? [],
    dismissedAt: text(row.dismissed_at),
  });
}

// ── The one mapping: table ↔ browser storage ────────────────────────────────

interface StoredLocally {
  readonly stored: true;
  readonly storageKey: string;
  readonly label: string;
  readonly toRow: (app: Record<string, unknown>) => BackupRow;
  readonly fromRow: (row: BackupRow) => Record<string, unknown>;
}

interface NotStoredLocally {
  readonly stored: false;
  readonly label: string;
  /** Said back to the user when a file holds rows this device cannot keep. */
  readonly absence: string;
}

export type LocalEntityBinding = StoredLocally | NotStoredLocally;

/**
 * One table this store has nowhere for, with its reason.
 *
 * The eight sentences live in `backup/browserCoverage.ts` rather than here, and
 * the arrow points that way rather than this way, because the SEAM needs the
 * same list SYNCHRONOUSLY in a render: `capabilities().cannotKeep` is what
 * `RestoreBackupModal` asks now, instead of reading this table directly.
 *
 * That change is a bug fix rather than a tidy-up, and it is worth naming here
 * because this table is what the bug read. The dialog picked these bindings
 * whenever `backupTarget !== 'login'` — a description of the BROWSER's store,
 * chosen by a condition a DEVICE edition also matches — so a device would have
 * been warned that a file's budgets, goals and dismissals could not be kept, by
 * a file that keeps all fifteen tables. A false warning about data loss, shown
 * to somebody deciding whether to press a button.
 *
 * A second copy of the seven sentences would have been free to drift from this
 * one, which is the same failure one level down. So there is one copy, it is in
 * the light module, and both readers take the `label` from it too — so the
 * warning a person reads BEFORE a restore and the one they read after it are
 * the same words.
 */
const absent = (entity: BackupEntity): NotStoredLocally => {
  const { label, absence } = browserAbsence(entity);
  return { stored: false, label, absence };
};

/**
 * THE single source of truth for what local backup and restore touch.
 *
 * Keyed by BackupEntity, so a table added to BACKUP_ENTITIES without a decision
 * recorded here is a COMPILE error, not a table that quietly stops being backed
 * up. The runtime check below covers the same ground for a build that reached
 * production some other way — this is the one mapping where "silently absent"
 * means a user loses data and finds out on the day they need the file.
 *
 * Every `stored: false` entry is a decision with a reason attached, not an
 * omission: local mode has no screen, no writer and no reader for those tables,
 * and inventing a storage key for data the app cannot use would produce a
 * backup nobody could restore into anything.
 */
export const LOCAL_BACKUP_BINDINGS: Readonly<Record<BackupEntity, LocalEntityBinding>> = {
  accounts: {
    stored: true, storageKey: STORAGE_KEYS.ACCOUNTS, label: 'Accounts',
    toRow: accountToRow, fromRow: accountFromRow,
  },
  categories: {
    stored: true, storageKey: STORAGE_KEYS.CATEGORIES, label: 'Categories',
    toRow: categoryToRow, fromRow: categoryFromRow,
  },
  transactions: {
    stored: true, storageKey: STORAGE_KEYS.TRANSACTIONS, label: 'Transactions',
    toRow: transactionToRow, fromRow: transactionFromRow,
  },
  transaction_splits: {
    stored: true, storageKey: STORAGE_KEYS.TRANSACTION_SPLITS, label: 'Transaction splits',
    toRow: splitToRow, fromRow: splitFromRow,
  },
  budgets: {
    stored: true, storageKey: STORAGE_KEYS.BUDGETS, label: 'Budgets',
    toRow: budgetToRow, fromRow: budgetFromRow,
  },
  goals: {
    stored: true, storageKey: STORAGE_KEYS.GOALS, label: 'Goals',
    toRow: goalToRow, fromRow: goalFromRow,
  },
  suggestion_dismissals: {
    stored: true, storageKey: STORAGE_KEYS.SUGGESTION_DISMISSALS, label: 'Dismissed suggestions',
    toRow: dismissalToRow, fromRow: dismissalFromRow,
  },
  // `stored: true` from the day the table joined the format, which is what
  // separates it from the seven below. A report is not a cloud-only entity: the
  // browser branch of the seam keeps them under a storage key of its own, so a
  // signed-out person's reports go into their backup and come back out of it —
  // which is the whole point of the table existing, since the failure it was
  // created to end was reports being lost to a browser that cleared its data.
  custom_reports: {
    stored: true, storageKey: STORAGE_KEYS.CUSTOM_REPORTS, label: 'Custom reports',
    toRow: customReportToRow, fromRow: customReportFromRow,
  },
  goal_contributions: absent('goal_contributions'),
  investments: absent('investments'),
  investment_transactions: absent('investment_transactions'),
  recurring_transactions: absent('recurring_transactions'),
  notifications: absent('notifications'),
  dashboard_layouts: absent('dashboard_layouts'),
  widget_preferences: absent('widget_preferences'),
  forecast_adjustments: absent('forecast_adjustments'),
};

// A binding missing at runtime would mean an entity silently vanished from
// every backup taken afterwards. Fail at import instead, where it cannot be
// mistaken for an empty table.
const unbound = BACKUP_ENTITIES.filter((entity) => LOCAL_BACKUP_BINDINGS[entity] === undefined);
if (unbound.length > 0) {
  throw new Error(
    `Local backup has no decision recorded for: ${unbound.join(', ')}. ` +
    'Every table in BACKUP_ENTITIES needs an entry in LOCAL_BACKUP_BINDINGS — ' +
    'either the storage key it lives under, or the reason this device does not hold it.'
  );
}

/** Storage keys a local backup reads and a local restore replaces, in order. */
export const LOCAL_BACKUP_STORAGE_KEYS: readonly string[] = BACKUP_ENTITIES
  .map((entity) => LOCAL_BACKUP_BINDINGS[entity])
  .filter((binding): binding is StoredLocally => binding.stored)
  .map((binding) => binding.storageKey);

/**
 * There is no account behind a browser-local backup, and pretending otherwise
 * would put a made-up id in a field a reader might trust. Restore ignores it on
 * both engines — every row is re-owned to whoever is restoring.
 */
export const LOCAL_SOURCE_USER_ID = 'local-device';

// ── Reading rows out of browser storage ─────────────────────────────────────

/** Money columns whose magnitude decides whether a backup can be exact. */
const MONEY_COLUMNS = [
  'amount', 'balance', 'initial_balance', 'bank_balance', 'target_amount',
  'current_amount', 'low_balance_threshold', 'spent',
] as const;

/**
 * A money value stored as text that would not survive the round trip.
 *
 * buildBackupBundle already refuses numbers beyond MAX_EXACT_MONEY, but it can
 * only see numbers — and browser storage is hand-editable JSON, so an amount
 * can arrive as a string. Compared through Decimal, never through parseFloat:
 * the comparison itself must not be the thing that loses the penny.
 */
function unsafeTextMoney(entity: BackupEntity, row: BackupRow): string | null {
  for (const column of MONEY_COLUMNS) {
    const value = row[column];
    if (typeof value !== 'string' || value.length === 0) continue;
    let magnitude;
    try {
      magnitude = toDecimal(value).abs();
    } catch {
      return `${entity} ${String(row.id ?? '(no id)')} has ${column} = "${value}", which is not a number at all.`;
    }
    if (magnitude.greaterThan(MAX_EXACT_MONEY)) {
      return `${entity} ${String(row.id ?? '(no id)')} has ${column} = "${value}", which is larger than ${MAX_EXACT_MONEY} — beyond that, restoring it would change the amount.`;
    }
  }
  return null;
}

async function readEntityRows(
  store: LocalBackupStore,
  entity: BackupEntity,
  binding: StoredLocally
): Promise<BackupRow[]> {
  const stored = await store.get<unknown>(binding.storageKey);
  if (stored === null || stored === undefined) return [];
  if (!Array.isArray(stored)) {
    throw new Error(
      `Browser storage holds something other than a list under ${binding.storageKey}, ` +
      `so ${binding.label} could not be backed up. Nothing has been written.`
    );
  }

  const rows: BackupRow[] = [];
  for (const entry of stored) {
    // A non-object entry is corruption, and a backup that skipped it would be a
    // backup that quietly held less than the app does.
    if (!isRecord(entry)) {
      throw new Error(
        `${binding.label} in browser storage contains an entry that is not a record, ` +
        'so this backup would not be a faithful copy. Nothing has been written.'
      );
    }
    const row = binding.toRow(entry);
    const problem = unsafeTextMoney(entity, row);
    if (problem !== null) {
      throw new Error(`This backup would lose precision and has not been written. ${problem}`);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Read every table this device holds and build the file.
 *
 * The same builder the cloud export uses, so the money-precision guard, the
 * empty-array-per-table rule and the links payload all come for free rather
 * than being re-implemented slightly differently.
 */
export async function collectLocalBackupBundle(
  options: {
    onProgress?: (progress: ExportProgress) => void;
    store?: LocalBackupStore;
    preferences?: LocalPreferencesPort;
    now?: () => Date;
  } = {}
): Promise<BackupBundle> {
  const store = options.store ?? defaultStore();
  const preferencesPort = options.preferences ?? defaultPreferences();
  const data: Partial<Record<BackupEntity, BackupRow[]>> = {};

  for (const [index, entity] of BACKUP_ENTITIES.entries()) {
    const report = (rows: number): void => options.onProgress?.({
      entity,
      entityNumber: index + 1,
      entityCount: BACKUP_ENTITIES.length,
      rows,
    });
    report(0);

    const binding = LOCAL_BACKUP_BINDINGS[entity];
    const rows = binding.stored ? await readEntityRows(store, entity, binding) : [];
    data[entity] = rows;
    report(rows.length);
  }

  const now = options.now ?? (() => new Date());
  return buildBackupBundle({
    sourceUserId: LOCAL_SOURCE_USER_ID,
    exportedAt: now().toISOString(),
    data,
    // For a signed-out user this is the ONLY copy of their settings that will
    // ever exist anywhere, which makes carrying it more important here than in
    // the cloud file, not less.
    preferences: preferencesPort.read(),
  });
}

// ── Is there anything here? ─────────────────────────────────────────────────

/**
 * True when this device holds no accounts, categories or transactions — the
 * same three tables user_financial_data_is_empty asks about, so "empty" means
 * one thing across both engines.
 */
export async function localFinancialDataIsEmpty(
  options: { store?: LocalBackupStore } = {}
): Promise<boolean> {
  const store = options.store ?? defaultStore();
  for (const key of [STORAGE_KEYS.ACCOUNTS, STORAGE_KEYS.CATEGORIES, STORAGE_KEYS.TRANSACTIONS]) {
    const stored = await store.get<unknown>(key);
    if (Array.isArray(stored) && stored.length > 0) return false;
  }
  return true;
}

// ── Clearing it ─────────────────────────────────────────────────────────────

/** The phrase wipe_user_financial_data demands, so both engines ask the same. */
export const LOCAL_WIPE_CONFIRMATION = 'DELETE EVERYTHING';

/**
 * Erase this device's financial data.
 *
 * Replaces the old `wipeLocalData`, which wrote `'[]'` into `window.localStorage`
 * while every reader in the app goes through storageAdapter → encryptedStorage →
 * IndexedDB. The keys it cleared were not the keys anything read, so "Clear All
 * Data" reported success and changed nothing; its test asserted on localStorage
 * and passed for the same reason.
 *
 * One bulk write, so the clear either happens or does not — it cannot empty the
 * accounts and leave the transactions behind. Returns what was actually thrown
 * away, per table, the way wipe_user_financial_data returns its counts.
 */
export async function wipeLocalFinancialData(
  confirmation: string,
  options: { store?: LocalBackupStore } = {}
): Promise<Record<string, number>> {
  if (confirmation !== LOCAL_WIPE_CONFIRMATION) {
    throw new Error(
      'wipe_not_confirmed: this erases every account, transaction, budget and goal on this device — the caller must pass the exact confirmation phrase'
    );
  }

  const store = options.store ?? defaultStore();
  const counts: Record<string, number> = {};
  const entries: Array<{ key: string; value: unknown }> = [];

  for (const entity of BACKUP_ENTITIES) {
    const binding = LOCAL_BACKUP_BINDINGS[entity];
    if (!binding.stored) continue;
    const stored = await store.get<unknown>(binding.storageKey);
    counts[entity] = Array.isArray(stored) ? stored.length : 0;
    entries.push({ key: binding.storageKey, value: [] });
  }

  await store.setMany(entries);
  return counts;
}

// ── Putting a file back ─────────────────────────────────────────────────────

export interface LocalRestoreOutcome {
  /** Rows written, per table, in the order the file holds them. */
  restored: { label: string; rows: number }[];
  /**
   * Rows the file carries that this device has nowhere to keep. Reported rather
   * than dropped in silence: the file still holds them, and signing in and
   * restoring the same file there would.
   */
  notStoredLocally: { label: string; rows: number; absence: string }[];
  accountsRelinked: number;
  transactionsRelinked: number;
  /** Settings put back. Locally this cannot fail separately — see below. */
  preferencesRestored: number;
  preferencesFailure: string | null;
  danglingRefs: DanglingReference[];
}

export class LocalRestoreRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalRestoreRefusedError';
  }
}

/**
 * Close the links the file records separately.
 *
 * The cloud NULLs these on insert and patches them in a second pass because
 * their constraints form cycles and none is DEFERRABLE. Browser storage has no
 * constraints at all, so nothing forces the two-step here — but the links
 * payload is applied over the rows anyway, because it is what
 * finalize_user_restore applies, and a file whose two copies disagree must
 * restore the same way on both engines rather than differently.
 */
function applyLinks(bundle: BackupBundle): {
  accounts: BackupRow[];
  transactions: BackupRow[];
  accountsRelinked: number;
  transactionsRelinked: number;
} {
  const parents = new Map<string, string>();
  for (const link of bundle.links.account_parents) {
    if (link.parent_account_id) parents.set(link.id, link.parent_account_id);
  }

  const transfers = new Map<string, { transfer: string | null; split: string | null }>();
  for (const link of bundle.links.transaction_links) {
    if (link.linked_transfer_id || link.linked_transfer_split_id) {
      transfers.set(link.id, { transfer: link.linked_transfer_id, split: link.linked_transfer_split_id });
    }
  }

  let accountsRelinked = 0;
  const accounts = bundle.data.accounts.map((row) => {
    const id = typeof row.id === 'string' ? row.id : null;
    const parent = id === null ? undefined : parents.get(id);
    if (parent === undefined) return row;
    accountsRelinked += 1;
    return { ...row, parent_account_id: parent };
  });

  let transactionsRelinked = 0;
  const transactions = bundle.data.transactions.map((row) => {
    const id = typeof row.id === 'string' ? row.id : null;
    const link = id === null ? undefined : transfers.get(id);
    if (link === undefined) return row;
    transactionsRelinked += 1;
    return { ...row, linked_transfer_id: link.transfer, linked_transfer_split_id: link.split };
  });

  return { accounts, transactions, accountsRelinked, transactionsRelinked };
}

/**
 * Restore a backup into browser storage.
 *
 * ── THE PRECONDITION ────────────────────────────────────────────────────────
 * Refused unless this device is empty, the same rule the cloud enforces. None
 * of the reasons the migration gives applies here — there are no triggers to
 * mint a colliding transfer category, no unique constraints to trip, no
 * updated_at stamps to preserve — so locally it is not a mechanical necessity.
 * It is kept because it is a product rule worth having on its own: a restore
 * REPLACES, replacing is destructive, and destruction gets its own
 * confirmation rather than hiding inside the same click as "restore". Keeping
 * it also means one sentence describes the feature on both engines, instead of
 * the app quietly merging on one and refusing on the other.
 *
 * ── FAILURE ─────────────────────────────────────────────────────────────────
 * Everything is converted first and written last, in ONE IndexedDB transaction.
 * So a failure while reading, validating or converting writes nothing at all,
 * and a failure during the write is rolled back by IndexedDB. There is no
 * halfway state to be stranded in — which is strictly better than the cloud,
 * where chunks are separate transactions and a mid-restore failure leaves the
 * login partly populated.
 *
 * What CAN still leave a user with nothing is the sequence, not the operation:
 * erasing a device (its own confirmed step) and then failing to restore leaves
 * it empty. The file on disk is the way back, which is why the dialog says to
 * keep it before erasing anything.
 */
export async function restoreLocalBackupBundle(
  bundle: BackupBundle,
  options: {
    onProgress?: (progress: RestoreProgress) => void;
    store?: LocalBackupStore;
    preferences?: LocalPreferencesPort;
    newId?: () => string;
  } = {}
): Promise<LocalRestoreOutcome> {
  const store = options.store ?? defaultStore();
  const preferencesPort = options.preferences ?? defaultPreferences();

  if (!(await localFinancialDataIsEmpty({ store }))) {
    throw new LocalRestoreRefusedError(
      'restore_target_not_empty: this device already holds data — clear it first, because restoring on top would replace everything here with the file'
    );
  }

  // Every id is replaced before anything is written, for the reason
  // remapBackupIds sets out: primary keys are global rather than per user, so a
  // file restored anywhere but where it came from would otherwise carry ids
  // that belong to somebody else's rows.
  const { bundle: remapped, danglingRefs } = options.newId
    ? remapBackupIds(bundle, options.newId)
    : remapBackupIds(bundle);

  const { accounts, transactions, accountsRelinked, transactionsRelinked } = applyLinks(remapped);
  const linked: Record<BackupEntity, BackupRow[]> = { ...remapped.data, accounts, transactions };

  const restored: { label: string; rows: number }[] = [];
  const notStoredLocally: { label: string; rows: number; absence: string }[] = [];
  const entries: Array<{ key: string; value: unknown }> = [];

  const stepCount = BACKUP_ENTITIES.length + 1;
  for (const [index, entity] of BACKUP_ENTITIES.entries()) {
    const binding = LOCAL_BACKUP_BINDINGS[entity];
    const rows = linked[entity];

    options.onProgress?.({
      stepNumber: index + 1,
      stepCount,
      label: binding.label,
      rowsDone: 0,
      rowsTotal: rows.length,
    });

    if (!binding.stored) {
      if (rows.length > 0) {
        notStoredLocally.push({ label: binding.label, rows: rows.length, absence: binding.absence });
      }
      continue;
    }

    // Every stored table is written, empty ones included: a restore replaces,
    // so a table the file has no rows for must end up empty rather than keeping
    // whatever happened to be there.
    entries.push({ key: binding.storageKey, value: rows.map(binding.fromRow) });
    restored.push({ label: binding.label, rows: rows.length });

    options.onProgress?.({
      stepNumber: index + 1,
      stepCount,
      label: binding.label,
      rowsDone: rows.length,
      rowsTotal: rows.length,
    });
  }

  options.onProgress?.({
    stepNumber: stepCount,
    stepCount,
    label: 'Saving',
    rowsDone: 0,
    rowsTotal: entries.length,
  });

  await store.setMany(entries);

  // After the one atomic write, and deliberately not inside it: the settings
  // live in a different store from the financial rows, so they cannot join that
  // transaction however they are ordered. Last is therefore the only safe place
  // — a device with its ledger back and its toggles at defaults is recoverable,
  // the other way round is not.
  let preferencesRestored = 0;
  let preferencesFailure: string | null = null;
  if (remapped.preferences !== null) {
    options.onProgress?.({
      stepNumber: stepCount,
      stepCount,
      label: 'Preferences',
      rowsDone: 0,
      rowsTotal: Object.keys(remapped.preferences.values).length,
    });
    try {
      await preferencesPort.write(remapped.preferences);
      preferencesRestored = Object.keys(remapped.preferences.values).length;
    } catch (error) {
      preferencesFailure = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    restored,
    notStoredLocally,
    accountsRelinked,
    transactionsRelinked,
    preferencesRestored,
    preferencesFailure,
    danglingRefs,
  };
}
