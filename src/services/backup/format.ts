/**
 * The BACKUP FILE FORMAT — what a file IS, and every rule about reading one.
 *
 * ── WHY THIS IS A MODULE OF ITS OWN, AND WHAT WAS LEFT BEHIND ───────────────
 *
 * `backupService.ts` does two different jobs. One is the cloud's: read fourteen
 * tables over PostgREST, hand the file to the browser to download, pour a file
 * back in through the restore RPCs. Its first line is `import { supabase }`, and
 * that is right for the half of it that talks to a database.
 *
 * The other job is not about any engine at all. The tag a file carries, which
 * tables it holds and in what order, how a bundle is built out of rows, what
 * makes a file valid, which columns hold references, how every id in one is
 * remapped, and the order a restore must apply the steps in — those are
 * statements about a FILE ON SOMEBODY'S DISK. `dataPort.ts` says so where it
 * imports these types: *"these types describe a file on the user's disk, not an
 * engine … a local edition inherits the format for the same reason it inherits
 * the seam."*
 *
 * That half is here now, so a caller can have the format without a Supabase
 * client. Nothing in this file imports one, and nothing in it can: the two
 * things it needs from elsewhere are `PREFERENCE_KEYS_HOLDING_IDS` and
 * `parsePreferencesDocument`, which slice 27 lifted into
 * `services/preferences/document.ts` for exactly this reason.
 *
 * ── THE OBLIGATION THIS DISCHARGES ──────────────────────────────────────────
 *
 * `localDataPort.ts`'s `BackupFormat` records it in full: the local port may not
 * import `backupService.ts`, so the format arrives injected, and *"whoever opens
 * a document in the DESKTOP shell (slice 27) must supply an implementation that
 * does not itself reach a Supabase client. Today that means lifting the pure
 * format half out of `backupService.ts` into a module of its own, which is a
 * FILE MOVE — and a file move is a `scripts/port-coverage` manifest change, so
 * it belongs to the commit that has a desktop bundle to measure."* This is that
 * commit and this is that module.
 *
 * ── IT IS A MOVE, NOT A FORK ────────────────────────────────────────────────
 *
 * Every function below is the one the cloud export and the browser export have
 * always called, moved verbatim. `backupService.ts` re-exports all of it, so no
 * caller changed and no second builder of one format exists — which is the whole
 * point, because the format is the only thing making a backup portable between
 * editions (B-11).
 */

import {
  PREFERENCE_KEYS_HOLDING_IDS,
  parsePreferencesDocument,
  type PreferencesDocument,
} from '../preferences/document';

/** The format tag written into every file from now on. */
export const BACKUP_FORMAT = 'reckley-backup-v2';

/**
 * Format tags restore ACCEPTS — forever.
 *
 * A backup lives on a user's disk, outside any release we ship, so a tag we
 * once wrote can never stop being read: the day it does, every file carrying
 * it stops restoring and the person holding it finds out when they need it.
 * `BACKUP_FORMAT` is what we write today; the rest of this list is what we
 * have written before. Append to it when the writer changes; never remove.
 *
 * The version number stays at v2 across a brand change on purpose — a bump
 * tells a reader the SHAPE changed, and it has not.
 */
export const LEGACY_BACKUP_FORMATS = ['wealthtracker-backup-v2'] as const;
export const ACCEPTED_BACKUP_FORMATS: ReadonlySet<string> = new Set<string>([
  BACKUP_FORMAT,
  ...LEGACY_BACKUP_FORMATS,
]);
export type AcceptedBackupFormat = typeof BACKUP_FORMAT | (typeof LEGACY_BACKUP_FORMATS)[number];

/**
 * The newest migration timestamp at the moment this format was written —
 * 20260812140000_reports_outlive_the_browser.sql, which created
 * `public.custom_reports` and gave `restore_user_chunk` a branch for it.
 *
 * It is stamped into the file so a restore can be told which schema the rows
 * were shaped by. Bump it when a migration changes what a backed-up row looks
 * like, not on every migration: its job is to date the ROW SHAPE, and a file
 * claiming a shape it does not have is worse than one claiming an old one.
 *
 * Bumped from 20260809160000 for the reason that value was bumped from
 * 20260807083000: a backup now carries something it did not before, and this
 * time it is a fifteenth TABLE rather than a section beside them. Informational
 * only — nothing gates on it, and a file stamped with either older value
 * restores exactly as it always did (its `custom_reports` array is simply
 * absent, which `validateBackupBundle` already reads as "this file has none").
 *
 * Bumped again to 20260819150000 when `forecast_adjustments` became the
 * sixteenth table, by the same argument end to end.
 */
export const BACKUP_SCHEMA_VERSION = '20260819150000';

/** Rows travel exactly as the database returned them. No mapping, no reshaping. */
export type BackupRow = Record<string, unknown>;

/**
 * Every table a backup carries, and the order the export reads them in.
 *
 * Deliberately NOT everything the user's row touches: bank_connections holds
 * provider credentials and is left behind on purpose (restore_user_chunk
 * strips connection_id for the same reason), and the subscription/billing
 * tables belong to Stripe, not to the user's financial history.
 */
export const BACKUP_ENTITIES = [
  'accounts',
  'categories',
  'transactions',
  'transaction_splits',
  'budgets',
  'goals',
  'goal_contributions',
  'investments',
  'investment_transactions',
  'recurring_transactions',
  'notifications',
  'dashboard_layouts',
  'widget_preferences',
  'suggestion_dismissals',
  // LAST, and it is the read order rather than a ranking: a report references
  // accounts and categories from inside a jsonb blob with no foreign key behind
  // it, so nothing about it constrains where it sits in this list — and the
  // restore order, which IS constrained, is stated separately in RESTORE_STEPS.
  // Appending rather than inserting also keeps every older file's `counts`
  // consistent with the list this build walks.
  'custom_reports',
  // Appended for custom_reports' reason. One row per category the user has
  // ADJUSTED in the forecast's scenario — the stated deviation from the base
  // average. References its category through an ordinary uuid column, so the
  // remapper's plainest mechanism covers it; restored after categories exist
  // (see RESTORE_STEPS).
  'forecast_adjustments',
] as const;

export type BackupEntity = (typeof BACKUP_ENTITIES)[number];

const BACKUP_ENTITY_SET: ReadonlySet<string> = new Set<string>(BACKUP_ENTITIES);
/** The three levels categories.level is constrained to. */
export const CATEGORY_LEVELS = ['type', 'sub', 'detail'] as const;
export type CategoryLevel = (typeof CATEGORY_LEVELS)[number];
/**
 * Rows per restore_user_chunk call. Small enough that the biggest request stays
 * well under any request-size limit on the one operation a user cannot afford
 * to have fail halfway.
 */
export const RESTORE_CHUNK_SIZE = 500;

/** Accounts that hang under another account, closed after every row exists. */
export interface AccountParentLink {
  id: string;
  parent_account_id: string;
}

/** A transfer's pointer at its other half, closed in the same second pass. */
export interface TransactionLink {
  id: string;
  linked_transfer_id: string | null;
  linked_transfer_split_id: string | null;
}

export interface BackupLinks {
  account_parents: AccountParentLink[];
  transaction_links: TransactionLink[];
}

export interface BackupBundle {
  format: AcceptedBackupFormat;
  schemaVersion: string;
  exportedAt: string;
  sourceUserId: string;
  counts: Record<string, number>;
  data: Record<BackupEntity, BackupRow[]>;
  /**
   * Duplicates values that are also present in `data`, deliberately. The insert
   * pass NULLs both self-references and the transactions↔splits cycle because
   * no constraint in the schema is DEFERRABLE, so the second pass needs them
   * from somewhere — and reading them back out of `data` would mean the file's
   * two copies could disagree with no way to tell which was right.
   */
  links: BackupLinks;
  /**
   * Every setting that belongs to the account rather than to the browser, as
   * one document. `null` means the file carries none — either an older file, or
   * a user who has expressed no preference at all.
   *
   * A SECTION of its own rather than a fifteenth entry in `data`, for three
   * reasons that are all about the restore rather than about the export:
   *
   *  • it is one row, replaced, where every entity in `data` is many rows,
   *    inserted. restore_user_chunk's whole shape is "insert whole rows into an
   *    empty login";
   *  • it must go in LAST and must never be able to block a financial row. In
   *    `data` it would be one more step in a loop that stops dead on the first
   *    refusal, so a preferences failure could cost someone their transactions;
   *  • the empty-login precondition does not apply to it. A login always has a
   *    preferences row by the time a restore runs — the app writes one at boot
   *    — so an INSERT-only path would refuse every time.
   *
   * Old files have no such key. `undefined` reads as `null`; nothing breaks.
   */
  preferences: PreferencesDocument | null;
}
// ── Building the file ───────────────────────────────────────────────────────

function readString(row: BackupRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Only accounts that actually hang under another one — the rest need no patch. */
export function extractAccountParents(rows: readonly BackupRow[]): AccountParentLink[] {
  const links: AccountParentLink[] = [];
  for (const row of rows) {
    const id = readString(row, 'id');
    const parent = readString(row, 'parent_account_id');
    if (id && parent) links.push({ id, parent_account_id: parent });
  }
  return links;
}

/**
 * Only transactions carrying at least one link. finalize_user_restore UPDATEs
 * the rows it is given, and an UPDATE re-dates updated_at on anything it
 * touches — so handing it the whole table would re-date a decade of history to
 * the day of the restore.
 */
export function extractTransactionLinks(rows: readonly BackupRow[]): TransactionLink[] {
  const links: TransactionLink[] = [];
  for (const row of rows) {
    const id = readString(row, 'id');
    if (!id) continue;
    const transfer = readString(row, 'linked_transfer_id');
    const split = readString(row, 'linked_transfer_split_id');
    if (!transfer && !split) continue;
    links.push({ id, linked_transfer_id: transfer, linked_transfer_split_id: split });
  }
  return links;
}

export interface BuildBundleInput {
  sourceUserId: string;
  exportedAt: string;
  data: Partial<Record<BackupEntity, BackupRow[]>>;
  /** Overridable only so a test can pin it; production always uses the constant. */
  schemaVersion?: string;
  preferences?: PreferencesDocument | null;
}

/**
 * Assemble the file from rows already read. Pure — no clock, no network — so
 * the shape a user's backup takes is something a test can hold still.
 *
 * An entity with no rows is written as an empty array rather than left out.
 * A reader should not have to tell "this user has no investments" apart from
 * "this export forgot about investments".
 */
/**
 * Largest magnitude a numeric(20,2) can make the round trip through JSON without
 * losing a penny.
 *
 * The path is numeric -> PostgREST JSON number -> JS double -> JSON.stringify ->
 * back to numeric. Doubles hold integers exactly up to 2^53, so with two decimal
 * places that is 2^53 / 100. Below it the trip is exact — verified for 0.01,
 * 0.07, -0.29, 1234.56 and 99,999,999,999.99. Above it, it is not:
 * 99999999999999.99 returns as 99999999999999.98.
 *
 * No personal-finance figure comes near £90tn, but a backup that silently
 * changes a number is the one thing a backup must never do, so an export that
 * would lose precision says so instead of hoping.
 */
export const MAX_EXACT_MONEY = Number.MAX_SAFE_INTEGER / 100;

/** Money fields whose magnitude is worth checking before we promise fidelity. */
const MONEY_FIELDS = [
  'amount', 'balance', 'initial_balance', 'bank_balance', 'target_amount',
  'current_amount', 'contribution_amount', 'low_balance_threshold', 'price',
  'total_amount', 'fees', 'cost_basis', 'current_price', 'market_value',
  'purchase_price', 'spent',
] as const;

/**
 * Values too large to survive the JSON round trip exactly. Empty for every real
 * dataset; non-empty means the export would quietly alter money.
 */
export function findUnsafeMoneyValues(
  data: Partial<Record<BackupEntity, BackupRow[]>>
): Array<{ entity: string; id: string; field: string; value: number }> {
  const unsafe: Array<{ entity: string; id: string; field: string; value: number }> = [];
  for (const [entity, rows] of Object.entries(data)) {
    for (const row of rows ?? []) {
      for (const field of MONEY_FIELDS) {
        const value = row[field];
        if (typeof value === 'number' && Math.abs(value) > MAX_EXACT_MONEY) {
          unsafe.push({ entity, id: String(row.id ?? '(no id)'), field, value });
        }
      }
    }
  }
  return unsafe;
}

export function buildBackupBundle(input: BuildBundleInput): BackupBundle {
  const data = {} as Record<BackupEntity, BackupRow[]>;
  const counts: Record<string, number> = {};
  for (const entity of BACKUP_ENTITIES) {
    const rows = input.data[entity] ?? [];
    data[entity] = rows;
    counts[entity] = rows.length;
  }

  const unsafe = findUnsafeMoneyValues(data);
  if (unsafe.length > 0) {
    const first = unsafe[0];
    throw new Error(
      `This backup would lose precision and has not been written. ${first.entity} ` +
      `${first.id} has ${first.field} = ${first.value}, which is larger than ` +
      `${MAX_EXACT_MONEY} — beyond that, restoring it would change the amount. ` +
      `${unsafe.length} value(s) affected.`
    );
  }

  return {
    format: BACKUP_FORMAT,
    schemaVersion: input.schemaVersion ?? BACKUP_SCHEMA_VERSION,
    exportedAt: input.exportedAt,
    sourceUserId: input.sourceUserId,
    counts,
    data,
    links: {
      account_parents: extractAccountParents(data.accounts),
      transaction_links: extractTransactionLinks(data.transactions),
    },
    preferences: input.preferences ?? null,
  };
}

/** How many settings a file's preferences section actually carries. */
export function preferenceCount(bundle: BackupBundle): number {
  return bundle.preferences === null ? 0 : Object.keys(bundle.preferences.values).length;
}
/** reckley-backup-2026-08-07.json */
export function backupFileName(exportedAt: string): string {
  const date = new Date(exportedAt);
  const stamp = Number.isNaN(date.getTime())
    ? new Date().toISOString().slice(0, 10)
    : date.toISOString().slice(0, 10);
  return `reckley-backup-${stamp}.json`;
}
// ── Reading a file back ─────────────────────────────────────────────────────

export type BackupValidation =
  | { ok: true; bundle: BackupBundle }
  | { ok: false; problem: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * How a bad value gets quoted back to the user. Scalars are shown as
 * themselves — "it says it holds 99 transactions" is a message someone can act
 * on, "it says it holds number transactions" is not.
 */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'missing';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') return 'an object';
  return typeof value;
}

function validateLinks(value: unknown): { ok: true; links: BackupLinks } | { ok: false; problem: string } {
  if (value === undefined) {
    // A file with no links at all is legitimate — a dataset with no nested
    // accounts and no transfers has nothing to close in the second pass.
    return { ok: true, links: { account_parents: [], transaction_links: [] } };
  }
  if (!isPlainObject(value)) {
    return { ok: false, problem: `"links" should be an object, but it is ${describeValue(value)}.` };
  }

  const parentsRaw = value.account_parents ?? [];
  const linksRaw = value.transaction_links ?? [];
  if (!Array.isArray(parentsRaw)) {
    return { ok: false, problem: `"links.account_parents" should be an array, but it is ${describeValue(parentsRaw)}.` };
  }
  if (!Array.isArray(linksRaw)) {
    return { ok: false, problem: `"links.transaction_links" should be an array, but it is ${describeValue(linksRaw)}.` };
  }

  const account_parents: AccountParentLink[] = [];
  for (const entry of parentsRaw) {
    if (!isPlainObject(entry)) {
      return { ok: false, problem: `"links.account_parents" contains ${describeValue(entry)} where a row was expected.` };
    }
    const id = readString(entry, 'id');
    const parent = readString(entry, 'parent_account_id');
    if (!id || !parent) {
      return { ok: false, problem: 'Every entry in "links.account_parents" needs both an id and a parent_account_id.' };
    }
    account_parents.push({ id, parent_account_id: parent });
  }

  const transaction_links: TransactionLink[] = [];
  for (const entry of linksRaw) {
    if (!isPlainObject(entry)) {
      return { ok: false, problem: `"links.transaction_links" contains ${describeValue(entry)} where a row was expected.` };
    }
    const id = readString(entry, 'id');
    if (!id) {
      return { ok: false, problem: 'Every entry in "links.transaction_links" needs an id.' };
    }
    transaction_links.push({
      id,
      linked_transfer_id: readString(entry, 'linked_transfer_id'),
      linked_transfer_split_id: readString(entry, 'linked_transfer_split_id'),
    });
  }

  return { ok: true, links: { account_parents, transaction_links } };
}

/**
 * Decide whether a parsed file can be restored, and if not say exactly what is
 * wrong with it, quoting the offending value.
 *
 * Every check here is one the database would otherwise fail on halfway through
 * — and halfway through is the expensive place to find out, because the login
 * is empty by then and partly refilled.
 */
export function validateBackupBundle(parsed: unknown): BackupValidation {
  if (!isPlainObject(parsed)) {
    return { ok: false, problem: `The file should contain a JSON object, but it contains ${describeValue(parsed)}.` };
  }

  if (typeof parsed.format !== 'string' || !ACCEPTED_BACKUP_FORMATS.has(parsed.format)) {
    return {
      ok: false,
      problem: `This is not a backup this app can restore: "format" should be "${BACKUP_FORMAT}" but it is ${describeValue(parsed.format)}. Files from the old "Export everything" button say "wealthtracker-complete-export-v1" and cannot be restored — they were never complete enough to put back.`,
    };
  }

  const data = parsed.data;
  if (!isPlainObject(data)) {
    return { ok: false, problem: `"data" should be an object holding one array per table, but it is ${describeValue(data)}.` };
  }

  const unknownEntities = Object.keys(data).filter((key) => !BACKUP_ENTITY_SET.has(key));
  if (unknownEntities.length > 0) {
    return {
      ok: false,
      problem: `"data" holds ${unknownEntities.length === 1 ? 'a table' : 'tables'} this version cannot restore: ${unknownEntities.join(', ')}. The file was probably written by a newer version of the app.`,
    };
  }

  const rows = {} as Record<BackupEntity, BackupRow[]>;
  for (const entity of BACKUP_ENTITIES) {
    const value = data[entity];
    if (value === undefined) {
      rows[entity] = [];
      continue;
    }
    if (!Array.isArray(value)) {
      return { ok: false, problem: `"data.${entity}" should be an array of rows, but it is ${describeValue(value)}.` };
    }
    const bad = value.findIndex((row) => !isPlainObject(row));
    if (bad >= 0) {
      return { ok: false, problem: `"data.${entity}" entry ${bad + 1} is ${describeValue(value[bad])} where a row was expected.` };
    }
    rows[entity] = value;
  }

  const counts = parsed.counts;
  if (!isPlainObject(counts)) {
    return { ok: false, problem: `"counts" should be an object of per-table totals, but it is ${describeValue(counts)}.` };
  }
  for (const [entity, count] of Object.entries(counts)) {
    if (!BACKUP_ENTITY_SET.has(entity)) {
      return { ok: false, problem: `"counts" mentions a table this version cannot restore: ${entity}.` };
    }
    const actual = rows[entity as BackupEntity].length;
    if (count !== actual) {
      return {
        ok: false,
        problem: `The file is inconsistent: it says it holds ${describeValue(count)} ${entity} but carries ${actual}. It was probably truncated in transit — restoring it would leave out rows without telling you which.`,
      };
    }
  }

  // A category level outside the three the schema allows would be dropped
  // silently by the level-by-level restore, so refuse the file instead.
  for (const category of rows.categories) {
    const level = category.level;
    if (typeof level !== 'string' || !CATEGORY_LEVELS.includes(level as CategoryLevel)) {
      return {
        ok: false,
        problem: `A category in the file has level ${describeValue(level)}, which is not one of type, sub or detail. Categories are restored one level at a time, so this row would be left behind.`,
      };
    }
  }

  const links = validateLinks(parsed.links);
  if (!links.ok) return links;

  return {
    ok: true,
    bundle: {
      format: BACKUP_FORMAT,
      schemaVersion: typeof parsed.schemaVersion === 'string' ? parsed.schemaVersion : 'unknown',
      exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
      sourceUserId: typeof parsed.sourceUserId === 'string' ? parsed.sourceUserId : '',
      counts: Object.fromEntries(BACKUP_ENTITIES.map((entity) => [entity, rows[entity].length])),
      data: rows,
      links: links.links,
      // Absent in every file written before 20260809160000, and parsed rather
      // than validated: a preference this build cannot make sense of costs that
      // one preference, whereas refusing the FILE over it would cost the user
      // their entire history to protect a toggle. Unknown keys travel through
      // untouched (see parsePreferencesDocument).
      preferences: parsed.preferences === undefined || parsed.preferences === null
        ? null
        : parsePreferencesDocument(parsed.preferences),
    },
  };
}

/** Earliest and latest transaction date in the file, when it can be told. */
export function transactionDateRange(bundle: BackupBundle): { first: string; last: string } | null {
  let first: string | null = null;
  let last: string | null = null;
  for (const row of bundle.data.transactions) {
    const date = readString(row, 'date');
    if (!date) continue;
    // ISO date strings sort lexically, which is why no Date is constructed here
    // — parsing 50k of them to find two would cost more than the answer.
    if (first === null || date < first) first = date;
    if (last === null || date > last) last = date;
  }
  return first && last ? { first, last } : null;
}
// ── Giving every row a new identity ─────────────────────────────────────────

/**
 * Every primary key in the backup set is a bare `id uuid` that is unique across
 * the WHOLE Supabase project, not per user. The export preserves those ids, so
 * restoring a file into a SECOND login tries to insert rows whose ids already
 * belong to the first one, and Postgres refuses with
 * `duplicate key value violates unique constraint "accounts_pkey"`.
 *
 * That is not an edge case, it is the main reason a backup exists: "my account
 * is gone, I made a new one, put my file back". `user_financial_data_is_empty`
 * cannot see the clash — it counts rows owned by the target user, and the rows
 * in the way are owned by someone else.
 *
 * So every row gets a fresh id on the way in, and every reference to it is
 * rewritten to match.
 *
 * WHY UNCONDITIONALLY, rather than only when a collision is detected: one code
 * path is far easier to trust than two, and the two-path version would put the
 * rarely-exercised branch in charge of exactly the case that matters. There is
 * also nothing to preserve — a restore only ever runs into an empty login, so by
 * the time these rows land the originals have either been wiped or belong to a
 * different account. Keeping the old ids buys nothing and costs the one bug this
 * whole section exists to kill.
 */

/**
 * Which columns of each entity point at another row in the backup.
 *
 * Read off the live schema (information_schema plus pg_constraint), not off
 * memory: several of these have no foreign key behind them and would not show up
 * in an FK listing — `recurring_transactions.account_id` is a bare uuid, and the
 * TEXT `category` columns are the ones most likely to be forgotten.
 *
 * Deliberately absent:
 *  • `user_id` on every table — restore_user_chunk overwrites it with the target
 *    login's id. Remapping it here would be undone a moment later.
 *  • `accounts.plaid_connection_id` and `transactions.connection_id` — they
 *    point at bank_connections, which a backup deliberately does not carry, and
 *    the RPC strips both before inserting.
 *  • the jsonb `widgets` and `settings` — they hold layout and display choices,
 *    and nothing writes a row id into either.
 *
 * `metadata` used to be on that list, and it should not have been:
 * planningService.goalToDb parks `linkedAccountIds` there, because goals has no
 * column for them. So a goal's linked accounts survived a restore still naming
 * the accounts of the login the file came from — wrong on both storage engines,
 * and invisible because nothing constrains a jsonb key. See `jsonbIdArrays`.
 */
interface EntityReferences {
  /** Columns typed uuid whose value is another backed-up row's id. */
  readonly uuid?: readonly string[];
  /**
   * TEXT columns that hold a row id.
   *
   * The same column is free text in some rows — `goals.category` holds a label
   * a person typed, `transactions.category` holds a category's id — so the two
   * have to be told apart. That is done by asking whether the value NAMES A ROW
   * THE FILE CONTAINS, not by asking whether it looks like a uuid.
   *
   * The uuid test was the first answer and it was wrong for exactly one dataset,
   * which happens to be the one this file's local half reads: a signed-out user's
   * categories are seeded with text ids ('type-income', 'transfer-in' — see
   * data/defaultCategories), because the cloud's uuid ids are minted per user by
   * migrate_categories_atomic on first sign-in. Remapping categories[].id while
   * skipping every transactions.category that pointed at one left the whole
   * dataset uncategorised, silently, since nothing constrains that column.
   * Membership of the id map is exact where a shape test could only guess.
   */
  readonly textId?: readonly string[];
  /** uuid[] columns where every element is a row id. */
  readonly uuidArray?: readonly string[];
  /**
   * Arrays of row ids that live INSIDE a jsonb column, named column by column
   * and then key by key.
   *
   * ── WHY IT IS SHAPED LIKE THIS AND NOT LIKE A LIST OF KEYS ────────────────
   *
   * It was `metadataIdArrays: readonly string[]` — a list of keys, with the
   * COLUMN hard-coded as `metadata` in the remapper — because for a while
   * exactly one such array existed: `goals.metadata.linkedAccountIds`, parked in
   * a blob because goals has no column for it.
   *
   * Custom reports made that shape wrong rather than merely cramped.
   * `custom_reports.filters` holds `accounts` and `categories` — both arrays of
   * row ids, in a column that is not called `metadata` — and the honest choices
   * were to generalise this field or to grow a second one beside it. A second
   * one is the worse answer for a reason this file has a scar about: two
   * mechanisms doing one job means the next id-carrying blob is added to
   * whichever of the two its author happens to read, and the one that is missed
   * fails SILENTLY, because nothing constrains a key inside a jsonb value on
   * either engine. There is one mechanism, so there is one place to add to.
   *
   * ── AND STILL BY KEY, NEVER BY SWEEPING THE COLUMN ────────────────────────
   *
   * The rule the old field stated survives the generalisation unchanged, and it
   * is the important half. `metadata` also carries a user's own free text, and
   * `filters` carries `tags` — labels somebody typed, which are deliberately NOT
   * here. Rewriting anything inside one of these columns that happened to match
   * an id in the file would corrupt it, and a person whose tag is a uuid-shaped
   * string is a person nobody is going to think about again.
   */
  readonly jsonbIdArrays?: Readonly<Record<string, readonly string[]>>;
  /**
   * Columns that are a TOP-LEVEL array of ids — a Postgres uuid[]/text[],
   * not ids buried in a jsonb document (that is `jsonbIdArrays`). Every
   * element is remapped, and one that resolves to nothing is reported rather
   * than dropped, exactly as a scalar reference would be.
   */
  readonly idArrays?: readonly string[];
}

const ENTITY_REFERENCES: Readonly<Record<BackupEntity, EntityReferences>> = {
  accounts: { uuid: ['parent_account_id'], idArrays: ['secured_against_account_ids'] },
  categories: { uuid: ['parent_id', 'account_id'] },
  transactions: {
    uuid: ['account_id', 'category_id', 'transfer_account_id', 'linked_transfer_id', 'linked_transfer_split_id'],
    // `category` duplicates category_id as text and is what most of the app
    // actually reads. Miss it and every categorised transaction comes back
    // filed under a category id that no longer exists — silently, because
    // nothing constrains it.
    textId: ['category'],
  },
  transaction_splits: {
    uuid: ['transaction_id', 'transfer_account_id', 'linked_transfer_id'],
    textId: ['category'],
  },
  budgets: { uuid: ['category_id'], textId: ['category'] },
  goals: {
    uuid: ['account_id'],
    textId: ['category'],
    jsonbIdArrays: { metadata: ['linkedAccountIds'] },
  },
  goal_contributions: { uuid: ['goal_id', 'transaction_id'] },
  investments: { uuid: ['account_id'] },
  investment_transactions: { uuid: ['investment_id'] },
  recurring_transactions: { uuid: ['account_id'], textId: ['category'] },
  notifications: {},
  dashboard_layouts: {},
  widget_preferences: {},
  // subject_key is handled separately below — it is a composite, not a plain id.
  suggestion_dismissals: { uuidArray: ['subject_ids'] },
  /**
   * A report's filters name the rows it is ABOUT, and two of the three lists in
   * there are ids.
   *
   * `filters.accounts` and `filters.categories` hold account and category ids,
   * put there by the builder's multi-selects. Restored verbatim into a login
   * whose rows have been given fresh ids, a report filtered to "the current
   * account and the joint account" would be filtered to two accounts that no
   * longer exist — so it would generate, successfully, over NO transactions, and
   * present an empty report as the answer. Nothing would say anything: no
   * constraint watches the inside of a jsonb column, and an empty report is a
   * perfectly ordinary thing for a report to be.
   *
   * `filters.tags` is deliberately absent. Tags are LABELS the user typed, never
   * ids — `Transaction.tags` is a text array and the report generator matches
   * them as strings — so remapping one would replace somebody's word with a
   * uuid and quietly stop the filter matching anything.
   *
   * `components` is absent for a stronger reason: nothing in it is a row id at
   * all. A component's `id` is its own position marker inside the report
   * (`component-<timestamp>`, minted by the builder and unique only within the
   * report), and its `config` holds metrics, limits and sort keys. The backup's
   * id map is keyed by primary keys of backed-up ROWS, so a component id could
   * never collide with one — but sweeping the blob would be the shape this
   * spec's own documentation refuses.
   */
  custom_reports: { jsonbIdArrays: { filters: ['accounts', 'categories'] } },
  /**
   * The whole point of this table being RELATIONAL rather than a jsonb of
   * {categoryId: amount}: the id sits in a plain uuid column, so the restore
   * rewrites it with the same mechanism as every scalar reference above, and
   * an adjustment whose category did not survive the file is REPORTED as a
   * dangling reference rather than silently orphaned inside a blob no
   * constraint watches. Keys of a jsonb object are a shape the remapper
   * deliberately has no mechanism for.
   */
  forecast_adjustments: { uuid: ['category_id'] },
};

/**
 * Whether a string is shaped like a uuid.
 *
 * Only used to tell a reference from a label in the TEXT columns and inside
 * subject_key. Columns actually typed uuid are looked up directly — anything in
 * one of those IS an id, whatever it looks like.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The separator src/utils/suggestionDismissals.ts joins dismissal keys with. */
const DISMISSAL_KEY_SEPARATOR = '|';

/**
 * A reference that resolved to nothing — the row it named is not in the file.
 *
 * Left exactly as it was rather than blanked. A value we cannot explain is not
 * the same as a value we know to be absent, and overwriting it would destroy the
 * only evidence of what the row used to point at. Counted instead, so a restore
 * can say so rather than quietly detaching data.
 */
export interface DanglingReference {
  entity: string;
  /** The row's NEW id, so it can be found in the database after the restore. */
  rowId: string;
  field: string;
  /** The id that named nothing in the file. */
  value: string;
}

export interface RemapResult {
  bundle: BackupBundle;
  /** Original id → fresh id, for every row in the file. */
  idMap: ReadonlyMap<string, string>;
  danglingRefs: DanglingReference[];
}

/**
 * Rewrite the ids inside a dismissal key.
 *
 * suggestion_dismissals.subject_key is TEXT, but it is built out of row ids —
 * `<id>|<id>` sorted, or `split:<id>|txn:<id>`, or `<kind>|<id>|<id>` (see
 * src/utils/suggestionDismissals.ts). Remapping subject_ids while leaving this
 * alone would break every dismissal the user has made: the sweep recomputes the
 * key from the rows it finds, gets the new ids, and matches nothing — so every
 * suggestion the user has already refused comes back.
 *
 * The bare ids are re-sorted afterwards because canonicalSubjectKey sorts them,
 * and fresh ids do not sort the way the originals did. Segments carrying a role
 * prefix stay where they are: legDismissalKey deliberately does not sort, since
 * its two halves live in different tables.
 *
 * Payee cleanup's keys are made of TEXT rather than ids and must come through
 * here character for character. They do, by construction and without a special
 * case: every segment is role-prefixed (`payee-cleanup:merchant:…`), so none is
 * ever treated as a bare id or re-sorted, and the value behind that prefix
 * always contains a further ':' — which no uuid can — so it can neither look up
 * as an id nor be reported as a dangling one.
 */
function remapDismissalKey(
  key: string,
  lookup: (id: string) => string | undefined,
  onDangling: (value: string) => void
): string {
  const segments = key.split(DISMISSAL_KEY_SEPARATOR);

  const remapped = segments.map((segment) => {
    const colon = segment.indexOf(':');
    const prefix = colon >= 0 ? segment.slice(0, colon + 1) : '';
    const value = colon >= 0 ? segment.slice(colon + 1) : segment;
    const replacement = lookup(value);
    if (replacement !== undefined) return prefix + replacement;
    // Named no row in the file. Uuid-shaped, it should have been one; otherwise
    // it is a kind tag like "duplicate" or "claimed" and belongs as it is.
    if (UUID_PATTERN.test(value)) onDangling(value);
    return segment;
  });

  // Positions that held a BARE id — the ones canonicalSubjectKey sorted. Same
  // discriminator as above: a row the file contains, or something uuid-shaped
  // that was meant to be one. A kind tag is neither.
  const barePositions: number[] = [];
  segments.forEach((segment, index) => {
    if (segment.includes(':')) return;
    if (lookup(segment) !== undefined || UUID_PATTERN.test(segment)) barePositions.push(index);
  });

  const wasSorted = barePositions.every(
    (index, i) => i === 0 || segments[barePositions[i - 1]] <= segments[index]
  );
  if (wasSorted && barePositions.length > 1) {
    // Default comparator, matching canonicalSubjectKey's own `[...ids].sort()`.
    const sorted = barePositions.map((index) => remapped[index]).sort();
    barePositions.forEach((index, i) => { remapped[index] = sorted[i]; });
  }

  return remapped.join(DISMISSAL_KEY_SEPARATOR);
}

/**
 * Rewrite the account ids a preferences document holds.
 *
 * The preferences that mention rows all mention ACCOUNTS: which ones the
 * dashboard pins, which ones a report is filtered to, which ones have their own
 * archive cutoff. Restored verbatim into a login whose rows have been given
 * fresh ids, every one of them would name accounts that no longer exist — and
 * would do it SILENTLY, because nothing constrains a string inside a jsonb
 * document. The dashboard would come up with no key accounts and no explanation;
 * the per-account cutoffs the owner set would apply to nothing.
 *
 * A value that is not the JSON this build expects is left EXACTLY as it was
 * rather than dropped or blanked: it may be a newer client's key, and a
 * preference we cannot parse is still a preference somebody set. An id inside
 * one that names no row in the file is likewise left alone and reported, the
 * same rule every other dangling reference gets.
 */
export function remapPreferenceIds(
  document: PreferencesDocument,
  lookup: (id: string) => string | undefined,
  onDangling: (key: string, value: string) => void
): PreferencesDocument {
  const values: Record<string, string> = { ...document.values };

  const remapOne = (value: string, key: string): string => {
    const replacement = lookup(value);
    if (replacement !== undefined) return replacement;
    if (UUID_PATTERN.test(value)) onDangling(key, value);
    return value;
  };

  for (const key of PREFERENCE_KEYS_HOLDING_IDS.idArray) {
    const raw = values[key];
    if (raw === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // Not JSON this build wrote. Leave the user's value alone.
    }
    if (!Array.isArray(parsed)) continue;
    values[key] = JSON.stringify(
      parsed.map((element) => (typeof element === 'string' ? remapOne(element, key) : element))
    );
  }

  for (const key of PREFERENCE_KEYS_HOLDING_IDS.idKeyedObject) {
    const raw = values[key];
    if (raw === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const rekeyed: Record<string, unknown> = {};
    for (const [id, entry] of Object.entries(parsed)) {
      rekeyed[remapOne(id, key)] = entry;
    }
    values[key] = JSON.stringify(rekeyed);
  }

  return { ...document, values };
}

/**
 * Give every row in the bundle a fresh id and rewrite every reference to match.
 *
 * Pure: the only impurity is id generation, and that is injectable so a test can
 * hold it still. Returns a new bundle rather than editing the one passed in, so
 * a failed restore can be retried from the file as it was read.
 *
 * `newId` defaults to crypto.randomUUID, which the app already relies on
 * elsewhere and polyfills for older Safari in utils/safariCompat.
 */
export function remapBackupIds(
  bundle: BackupBundle,
  newId: () => string = () => crypto.randomUUID()
): RemapResult {
  // One map for every table rather than one per table. Ids here are uuids from
  // the same generator, so a value cannot mean one row in accounts and another
  // in categories — and subject_key needs exactly this, because it mixes
  // transaction ids with transaction_split ids in a single string.
  const idMap = new Map<string, string>();
  for (const entity of BACKUP_ENTITIES) {
    for (const row of bundle.data[entity]) {
      const id = readString(row, 'id');
      if (id && !idMap.has(id)) idMap.set(id, newId());
    }
  }

  const lookup = (id: string): string | undefined => idMap.get(id);
  const danglingRefs: DanglingReference[] = [];

  const data = {} as Record<BackupEntity, BackupRow[]>;
  for (const entity of BACKUP_ENTITIES) {
    const spec = ENTITY_REFERENCES[entity];
    data[entity] = bundle.data[entity].map((row) => {
      const original = readString(row, 'id');
      const rowId = (original && idMap.get(original)) ?? original ?? '(no id)';
      const next: BackupRow = { ...row };
      if (original) next.id = idMap.get(original) ?? original;

      const note = (field: string, value: string): void => {
        danglingRefs.push({ entity, rowId, field, value });
      };

      for (const field of spec.uuid ?? []) {
        const value = readString(row, field);
        if (!value) continue;
        const replacement = lookup(value);
        if (replacement === undefined) note(field, value);
        else next[field] = replacement;
      }

      for (const field of spec.textId ?? []) {
        const value = readString(row, field);
        if (!value) continue;
        const replacement = lookup(value);
        if (replacement !== undefined) {
          next[field] = replacement;
          continue;
        }
        // It named no row in the file. Uuid-shaped, it was meant to be one and
        // the user should hear about it; otherwise it is a label like "Holiday"
        // and there is nothing wrong with it.
        if (UUID_PATTERN.test(value)) note(field, value);
      }

      for (const field of spec.uuidArray ?? []) {
        const value = row[field];
        if (!Array.isArray(value)) continue;
        next[field] = value.map((element) => {
          if (typeof element !== 'string') return element;
          const replacement = lookup(element);
          if (replacement === undefined) {
            note(field, element);
            return element;
          }
          return replacement;
        });
      }

      // The jsonb columns carrying references — `goals.metadata` and
      // `custom_reports.filters` today. Rewritten column by column and then key
      // by key, and only for the keys the spec names, so everything else in
      // those blobs (a user's own free text in metadata, a report's tags)
      // travels through untouched. See `jsonbIdArrays` for why the column is
      // named in the spec rather than hard-coded here.
      for (const [column, keys] of Object.entries(spec.jsonbIdArrays ?? {})) {
        const stored = row[column];
        if (!isPlainObject(stored)) continue;
        const document: Record<string, unknown> = { ...stored };
        for (const key of keys) {
          const value = document[key];
          if (!Array.isArray(value)) continue;
          document[key] = value.map((element) => {
            if (typeof element !== 'string') return element;
            const replacement = lookup(element);
            if (replacement === undefined) {
              // The field is reported as `<column>.<key>` rather than as the
              // bare key, because a restore can now report a dangling reference
              // from either of two blobs and "linkedAccountIds" alone would not
              // say which row of which table to look at.
              note(`${column}.${key}`, element);
              return element;
            }
            return replacement;
          });
        }
        next[column] = document;
      }

      for (const column of spec.idArrays ?? []) {
        const stored = row[column];
        if (!Array.isArray(stored)) continue;
        next[column] = stored.map((element) => {
          if (typeof element !== 'string') return element;
          const replacement = lookup(element);
          if (replacement === undefined) {
            note(column, element);
            return element;
          }
          return replacement;
        });
      }

      if (entity === 'suggestion_dismissals') {
        const key = readString(row, 'subject_key');
        if (key) {
          next.subject_key = remapDismissalKey(key, lookup, (value) => note('subject_key', value));
        }
      }

      return next;
    });
  }

  // The links payload travels separately to finalize_user_restore, so it needs
  // the same treatment — remapping the rows and forgetting this would restore
  // every transfer pointing at the id it had in the old login.
  const account_parents: AccountParentLink[] = bundle.links.account_parents.map((link) => {
    const id = idMap.get(link.id) ?? link.id;
    const parent = idMap.get(link.parent_account_id);
    if (parent === undefined) {
      danglingRefs.push({ entity: 'links.account_parents', rowId: id, field: 'parent_account_id', value: link.parent_account_id });
    }
    return { id, parent_account_id: parent ?? link.parent_account_id };
  });

  const transaction_links: TransactionLink[] = bundle.links.transaction_links.map((link) => {
    const id = idMap.get(link.id) ?? link.id;
    const remapLink = (field: 'linked_transfer_id' | 'linked_transfer_split_id'): string | null => {
      const value = link[field];
      if (!value) return null;
      const replacement = idMap.get(value);
      if (replacement === undefined) {
        danglingRefs.push({ entity: 'links.transaction_links', rowId: id, field, value });
        return value;
      }
      return replacement;
    };
    return {
      id,
      linked_transfer_id: remapLink('linked_transfer_id'),
      linked_transfer_split_id: remapLink('linked_transfer_split_id'),
    };
  });

  const preferences = bundle.preferences === null
    ? null
    : remapPreferenceIds(bundle.preferences, lookup, (key, value) => {
        danglingRefs.push({ entity: 'preferences', rowId: key, field: key, value });
      });

  return {
    bundle: { ...bundle, data, links: { account_parents, transaction_links }, preferences },
    idMap,
    danglingRefs,
  };
}
// ── Putting it back ─────────────────────────────────────────────────────────

export interface RestoreStep {
  entity: BackupEntity;
  /** Set for the three category passes; undefined means "every row". */
  level?: CategoryLevel;
  label: string;
}

/**
 * The order restore_user_chunk must be called in. Not a preference — the
 * migration depends on it:
 *
 *  • accounts first, because that is where the "is this login empty?"
 *    precondition is checked, and it must fire before a single row lands.
 *  • categories level by level, so parent_id always resolves and two
 *    same-named details under different parents cannot trip the unique key.
 *  • parents before children everywhere else (goals before goal_contributions,
 *    investments before investment_transactions, transactions before splits).
 *
 * Custom reports go LAST, and unlike everything above it that is a choice rather
 * than a constraint. A report names accounts and categories from inside a jsonb
 * column with no foreign key behind it, so the database would accept it first —
 * but a step that lands before the rows it points at is a step whose failure
 * leaves a login holding reports about nothing, and the cheapest thing to lose
 * when a restore stops halfway is the thing that can be rebuilt from a screen in
 * two minutes.
 */
export const RESTORE_STEPS: readonly RestoreStep[] = [
  { entity: 'accounts', label: 'Accounts' },
  { entity: 'categories', level: 'type', label: 'Categories (top level)' },
  { entity: 'categories', level: 'sub', label: 'Categories (sub)' },
  { entity: 'categories', level: 'detail', label: 'Categories (detail)' },
  { entity: 'budgets', label: 'Budgets' },
  { entity: 'goals', label: 'Goals' },
  { entity: 'investments', label: 'Investments' },
  { entity: 'investment_transactions', label: 'Investment transactions' },
  { entity: 'transactions', label: 'Transactions' },
  { entity: 'transaction_splits', label: 'Transaction splits' },
  { entity: 'goal_contributions', label: 'Goal contributions' },
  { entity: 'recurring_transactions', label: 'Recurring transactions' },
  { entity: 'notifications', label: 'Notifications' },
  { entity: 'dashboard_layouts', label: 'Dashboard layouts' },
  { entity: 'widget_preferences', label: 'Widget preferences' },
  { entity: 'suggestion_dismissals', label: 'Dismissed suggestions' },
  { entity: 'custom_reports', label: 'Custom reports' },
  { entity: 'forecast_adjustments', label: 'Forecast adjustments' },
];

/** The rows one step sends, in the order the file holds them. */
export function rowsForStep(bundle: BackupBundle, step: RestoreStep): BackupRow[] {
  const rows = bundle.data[step.entity];
  if (!step.level) return rows;
  return rows.filter((row) => row.level === step.level);
}

export function chunkRows(rows: readonly BackupRow[], size: number = RESTORE_CHUNK_SIZE): BackupRow[][] {
  if (rows.length === 0) return [];
  const out: BackupRow[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

/**
 * A chunk the database refused. Carries the step so the UI can say WHERE the
 * restore stopped, and the server's own sentence untouched — the RPCs put a
 * machine code first and then a readable explanation, and paraphrasing it
 * would throw away the half that helps.
 */
export class RestoreFailedError extends Error {
  readonly step: string;
  readonly serverMessage: string;

  constructor(step: string, serverMessage: string) {
    super(`${step}: ${serverMessage}`);
    this.name = 'RestoreFailedError';
    this.step = step;
    this.serverMessage = serverMessage;
  }
}

export interface RestoreProgress {
  stepNumber: number;
  stepCount: number;
  label: string;
  rowsDone: number;
  rowsTotal: number;
}

export interface RestoreOutcome {
  /** Rows the database reported inserting, per step, in restore order. */
  restored: { label: string; rows: number }[];
  accountsRelinked: number;
  transactionsRelinked: number;
  /**
   * Settings put back, and whether that succeeded. `failed` carries the reason
   * rather than throwing: preferences are restored after every financial row is
   * safely in, and a restore that threw away a complete, correct ledger because
   * a toggle could not be saved would be the wrong trade by an enormous margin.
   */
  preferencesRestored: number;
  preferencesFailure: string | null;
  /**
   * References in the file that named a row the file does not contain. Left as
   * they were, and reported rather than swallowed — a restore that silently
   * detaches data is the one failure a backup must never have.
   */
  danglingRefs: DanglingReference[];
}

/**
 * How far an export has got, for a progress bar.
 *
 * Here rather than in `backupService.ts` because it describes the FILE being
 * built and not the store it is being read out of — every engine that can
 * collect a backup reports it, and one of them is a ledger file. It moved in
 * the mount slice's second half, with `downloadBackupBundle`; see that file's
 * note for what the old home cost.
 */
export interface ExportProgress {
  entity: BackupEntity;
  /** 1-based, for "3 of 14". */
  entityNumber: number;
  entityCount: number;
  /** Rows read for this entity so far. */
  rows: number;
}

/**
 * Hand the file to the browser. The stringify is the one unavoidably blocking
 * moment in the export — everything before it awaits — so it happens last,
 * after the progress display has already told the user what is going on.
 *
 * A WebView is a browser too: a desktop window downloads a backup exactly like
 * a tab does, and this is the same eight lines either way. Nothing here knows
 * where the bundle came from.
 */
export function downloadBackupBundle(bundle: BackupBundle): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = backupFileName(bundle.exportedAt);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
