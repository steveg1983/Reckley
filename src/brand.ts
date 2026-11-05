/**
 * The storage namespace — ONE place, so the next rename never touches data.
 *
 * ── WHY THE PREFIX IS NOT THE BRAND ─────────────────────────────────────────
 *
 * Browser storage keys are a wire format: every one is sitting in a user's
 * IndexedDB and localStorage already, and renaming one means a migration that
 * runs in a browser nobody can reach. The 2026 rename found THREE generations
 * live at once — `money_management_*`, `wealthtracker_*`, `wt_*` — because the
 * previous rename put the brand into the keys and then stopped halfway.
 *
 * So the prefix below is a word for what the data IS, not what the product is
 * called. It is deliberately dull. When the product is renamed again, this
 * file does not change and no user's data moves.
 *
 * ── WHAT MOVES AND WHAT DOES NOT ────────────────────────────────────────────
 *
 * Moved to this prefix (by `lib/storageMigration.ts`: copied in generation 1,
 * the old copies deleted in generation 2 once the copy is proven present):
 *   every `wealthtracker_*` key — the IndexedDB records in `secureData` and the
 *   localStorage keys of the same generation. They carried the old brand.
 *
 * Left exactly as they were, on purpose:
 *   `money_management_*` — the preference keys. `preferencesService` stores
 *     these AS THE SAME STRINGS in the cloud `user_preferences` document and
 *     they appear inside every backup file's `preferences.values`. Renaming
 *     them is a server-side remap plus a backup-file remap, for names no user
 *     ever sees. Not worth it; recorded here so nobody re-litigates it.
 *   `wt_*` — abbreviations with no visible brand in them, and the set includes
 *     `wt_enc_key`, the AES key for every encrypted record. The single most
 *     dangerous string in the repository; its name is not worth touching.
 */

/** The storage namespace. Two words were considered; this one names the data. */
export const KEY_PREFIX = 'ledger' as const;

/** `storageKey('accounts')` → `ledger_accounts`. Template-typed so `as const` tables keep literal types. */
export const storageKey = <N extends string>(name: N): `${typeof KEY_PREFIX}_${N}` =>
  `${KEY_PREFIX}_${name}`;
