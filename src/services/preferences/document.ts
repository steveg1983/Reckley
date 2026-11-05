/**
 * The preferences DOCUMENT — its shape, its parser, and the keys inside it that
 * name rows.
 *
 * ── WHY THIS IS A MODULE OF ITS OWN ─────────────────────────────────────────
 *
 * `preferencesService.ts` is where preferences LIVE while the app runs: a
 * Supabase transport, a debounced writer, a local mirror, a class with a cache.
 * Its module scope reaches `supabase` and the app's cloud-bound logger on its
 * first two lines.
 *
 * What is here is none of that. It is the FILE FORMAT half — what a preferences
 * document IS, how to read one off the wire without trusting it, and which of
 * its keys hold ids that a restore has to follow. Those are statements about a
 * document on somebody's disk rather than about an engine, and a backup file
 * carries the document verbatim: `buildBackupBundle` puts it in, `remapBackupIds`
 * rewrites the ids inside it, and a restore puts it back.
 *
 * It was lifted out in slice 27, when the desktop shell became the first caller
 * that has a preferences document to remap and no Supabase client to reach for.
 * The chain it had to break is one import long and entirely invisible from
 * either end: `services/backup/format.ts` needs `PREFERENCE_KEYS_HOLDING_IDS`,
 * and taking it from `preferencesService.ts` would have put the cloud in a
 * desktop bundle through a constant that is a list of strings.
 *
 * Slice 28 moved one more name down here — {@link PreferencesTransport}, the
 * interface a STORE answers — for the same reason one module along. The desktop
 * has an implementation of it now (`services/local/preferencesTransport.ts`,
 * the ledger file), and a transport that took its own interface from
 * `preferencesService.ts` would name the cloud in a type position on a module
 * whose whole promise is that it does not. That import would be erased at build
 * and would still be wrong: `localDataPort.ts` makes the same decision about the
 * backup format, and says why — *"the type and the injected implementation come
 * from the same place even though only one of them is real at runtime"*.
 *
 * A transport is arguably not a "document", and it is here anyway: its two verbs
 * are *read this user's document* and *replace it*, which is the document's
 * storage contract and nothing else. Nothing in it knows there is a table.
 *
 * `preferencesService.ts` re-exports every name below, so nothing that already
 * imported one of them changed.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The version this build writes.
 *
 * Bump it only when the MEANING of the values map changes, never for a new key
 * — new keys are the normal case and need no version at all. A document
 * claiming a version this build does not know is read anyway, values and all:
 * refusing it would lose every setting rather than the one that changed.
 */
export const PREFERENCES_DOCUMENT_VERSION = 1;

export interface PreferencesDocument {
  version: number;
  /** Preference key → the exact string the call site stored. */
  values: Record<string, string>;
}

export const EMPTY_PREFERENCES: PreferencesDocument = { version: PREFERENCES_DOCUMENT_VERSION, values: {} };

/**
 * Read a document off the wire.
 *
 * Deliberately forgiving in one direction and strict in the other: a `values`
 * entry that is not a string is DROPPED (nothing can consume it, and keeping it
 * would put a shape into the document that a later write would echo back to the
 * database), while an unrecognised VERSION is kept as it is. The first is
 * corruption; the second is a newer client, and a newer client's document must
 * come back out of an older one unharmed.
 */
export function parsePreferencesDocument(raw: unknown): PreferencesDocument {
  if (!isRecord(raw)) return { ...EMPTY_PREFERENCES, values: {} };

  const version = typeof raw.version === 'number' && Number.isFinite(raw.version)
    ? raw.version
    : PREFERENCES_DOCUMENT_VERSION;

  const values: Record<string, string> = {};
  if (isRecord(raw.values)) {
    for (const [key, value] of Object.entries(raw.values)) {
      if (typeof value === 'string') values[key] = value;
    }
  }

  return { version, values };
}

/**
 * The stored copy, as two verbs.
 *
 * A PORT rather than "the slice of the Supabase client we use", and that is not
 * only taste. A structural interface describing the PostgREST builder chain has
 * to be checked against `SupabaseClient<Database>`'s generics every time the
 * real client is assigned to it, and `tsc -b` gives up on that with
 * "Type instantiation is excessively deep" — the compiler's way of saying the
 * abstraction is drawn in the wrong place. Two verbs are also what a caller
 * actually needs: read this user's document, replace it. Nothing above cares
 * that it is a table — which is what let the local edition answer the same
 * interface with a file (`services/local/preferencesTransport.ts`).
 *
 * ── `null` IS AN ANSWER, AND IT IS NOT AN EMPTY DOCUMENT ────────────────────
 *
 * `read` answers `null` for *"this store has never held settings for this
 * user"*, and `{ version, values: {} }` for *"they have everything at its
 * default"*. `PreferencesService.attach` branches on that difference to decide
 * whether to LIFT this machine's settings into the store, so an implementation
 * that flattened the two would either lose somebody's years of choices or write
 * a stale machine's over a fresh one's.
 */
export interface PreferencesTransport {
  read(userId: string): Promise<PreferencesDocument | null>;
  write(userId: string, document: PreferencesDocument): Promise<void>;
}

/**
 * Keys the preferences document holds that name ROWS in the user's data.
 *
 * They matter to exactly one caller — the restore, which mints a fresh id for
 * every row it puts back (see backupService.remapBackupIds and the reason it
 * remaps unconditionally). A preference naming accounts by id and restored
 * verbatim would come back pointing at the accounts of the login the file came
 * from: the dashboard's key accounts would silently be six accounts that no
 * longer exist, and the archive cutoffs the owner set per account would apply
 * to nothing. Both fail SILENTLY, which is what makes this worth spelling out.
 */
export const PREFERENCE_KEYS_HOLDING_IDS = {
  /** JSON arrays of row ids — accounts for the first two, budgets for the third. */
  idArray: [
    'dashboardKeyAccounts',
    'reportsAccountFilterIds',
    'dashboardKeyBudgets',
  ] as readonly string[],
  /** JSON object whose KEYS are account ids. */
  idKeyedObject: [
    'archiveManager.overrides.v1',
  ] as readonly string[],
} as const;
