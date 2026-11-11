// THE STORE, as a specifier that names no edition. This module used to open
// with `import { supabase }`, which is why a context about theme and currency
// reached a database client from the shared Layout. `@prefs-store` is the web's
// `user_preferences` row in a browser build and `null` — *"the file has already
// been attached"* — in a desktop one. See `editions/preferencesStore.ts`.
import { defaultPreferencesTransport } from '@prefs-store';
import { createScopedLogger } from '../loggers/scopedLogger';
// The document half, lifted into a module with no cloud in its scope so that a
// desktop bundle can remap the ids inside a preferences document without
// reaching a Supabase client (slice 27), and — since slice 28 — so that the
// desktop's own transport can name the interface it answers without naming this
// file. Re-exported here because every existing caller imports these names from
// this file, and a lift that renames its callers' imports is a refactor rather
// than a lift.
export {
  EMPTY_PREFERENCES,
  PREFERENCES_DOCUMENT_VERSION,
  PREFERENCE_KEYS_HOLDING_IDS,
  parsePreferencesDocument,
  type PreferencesDocument,
  type PreferencesTransport,
} from './preferences/document';
import {
  PREFERENCES_DOCUMENT_VERSION,
  parsePreferencesDocument,
  type PreferencesDocument,
  type PreferencesTransport,
} from './preferences/document';

/**
 * Preferences that travel with the ACCOUNT rather than with the browser.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * A full backup was restored into a fresh login and the app came up
 * factory-reset: right accounts, right transactions, and every choice the owner
 * had ever made about how to LOOK at them gone. Which accounts the dashboard
 * pins, which reports are pinned beside them, the period each surface opens on,
 * how the Accounts page is banded and sorted, which register columns are
 * hidden, the archive cutoffs he had set per account — a whole tier of
 * personalisation lived in `window.localStorage` and nowhere else. It did not
 * back up, it did not follow him to a second machine, and nothing said so.
 *
 * The fix is not "back up localStorage". localStorage holds two different kinds
 * of thing side by side: statements about the USER ("show me twelve months",
 * "these six accounts matter") and statements about the DEVICE ("this browser
 * has shown you the import tip", "this screen fits a 240px description
 * column"). Carrying the second kind across machines makes the app worse, not
 * better. So each key is classified once, and only the first kind lives here.
 *
 * ── THE DOCUMENT ────────────────────────────────────────────────────────────
 *
 * One row per user holding ONE jsonb document, not a row per key. Preferences
 * are read as a SET exactly once (at boot, before the first paint that depends
 * on them), written rarely, and have to travel whole into a backup file. A row
 * per key would turn one round trip into fifty, and would let a restore land
 * half a user's settings.
 *
 * Values are stored as the SAME STRINGS localStorage held — not as a typed
 * object graph. That is deliberate:
 *
 *   * every call site already serialises to a string, so rewiring one is
 *     `localStorage.` → `preferences.` and nothing else. The point of this work
 *     is where the data LIVES, not renaming it;
 *   * a key this build has never heard of is preserved untouched. An older
 *     client cannot drop a newer client's preference, because it never parses
 *     it — which is the property that makes a shared document safe to roll out
 *     to two versions at once;
 *   * a corrupt value costs exactly one preference. Each call site already
 *     guards its own parse (they had to: localStorage is hand-editable), so a
 *     bad value falls back to that key's default instead of failing the load.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
 *
 * Anything that grows with the size of the dataset. Everything registered below
 * is a toggle, an enum, a short list of account ids, or a handful of column
 * names. The database backs this up with a hard CHECK on the document's size
 * (see migration 20260809160000): preferences are small, and a table that lets
 * them stop being small would become a second, unindexed copy of the ledger.
 */

const preferencesLogger = createScopedLogger('PreferencesService');

// ── The document ────────────────────────────────────────────────────────────


// ── The registry ────────────────────────────────────────────────────────────

/**
 * A surface whose period picker is remembered. `usePeriod` writes four keys per
 * surface — the period itself, the "the user chose this" flag, and the two
 * custom bounds — and all four have to travel together or a restored custom
 * range comes back as an empty one the user never asked for.
 */
export function periodPreferenceKeys(base: string): string[] {
  return [base, `${base}Explicit`, `${base}CustomStart`, `${base}CustomEnd`];
}

/**
 * Where a CARD's "this one has a window of its own" flag lives.
 *
 * A pinned dashboard card is an ordinary period surface — same four keys, same
 * hook — plus one bit that says the pin is in force. The bit is separate from
 * `…Explicit` on purpose: that flag answers *"did the user choose this value, or
 * did a surface suggest it?"*, and the card needs the different question *"is
 * this card being read over its own window, or over the page's?"*. Conflating a
 * value with a state is exactly what `readStoredSelection`'s long note is about.
 *
 * The separation is also what makes a user with no pins byte-identical to
 * today: no flag, no key, nothing read, nothing written.
 */
export function periodPinKey(base: string): string {
  return `${base}Pinned`;
}

/** Everything one pinnable card can store: the period surface, plus the pin. */
export function cardPeriodPreferenceKeys(base: string): string[] {
  return [...periodPreferenceKeys(base), periodPinKey(base)];
}

/**
 * Every key that travels with the account.
 *
 * This list does TWO jobs, and only the first is load-bearing at runtime:
 *
 *  1. it is what the one-time lift copies out of an existing browser, so the
 *     owner's real account keeps the settings he already has rather than
 *     starting from defaults on the day this ships;
 *  2. it is the written inventory. A key not here is a key somebody decided
 *     stays on the device, and the decision is recorded in the classification
 *     table beside this list rather than left to be inferred from a diff.
 *
 * Writing a key through this service is what makes it portable — the registry
 * is not a gate. That is on purpose: a call site added after this list stops
 * being maintained still travels correctly, it just misses the one-time lift,
 * which matters for exactly one boot in the lifetime of one browser.
 */
export const PORTABLE_PREFERENCE_KEYS: readonly string[] = [
  // ── Dashboard ────────────────────────────────────────────────────────────
  // Which accounts the owner put on his own front page, and which reports he
  // pinned beside them. Statements about HIS data, not about this screen.
  'dashboardKeyAccounts',
  'dashboardKeyBudgets',
  // How a long budget is read — so far, this month, or whole (utils/budgetView).
  // The widget's document is shaped by it too, so it must reach the server.
  'budgetView',
  'dashboardPinnedReports',
  ...periodPreferenceKeys('dashboardReports'),
  ...periodPreferenceKeys('dashboardReportsFlows'),
  ...periodPreferenceKeys('dashboardPerformance'),
  // …and the cards that have been PINNED to a window of their own, against the
  // page's. A statement about how the owner reads HIS figures — an all-time net
  // worth beside twelve months of flows — so it travels with the account like
  // every other statement of that kind. See hooks/useCardPeriod.
  ...cardPeriodPreferenceKeys('dashboardReports.pin.performance'),
  ...cardPeriodPreferenceKeys('dashboardReports.pin.net-worth'),
  ...cardPeriodPreferenceKeys('dashboardReports.pin.income-expense-trend'),
  ...cardPeriodPreferenceKeys('dashboardReports.pin.expense-categories'),

  // ── Reports ──────────────────────────────────────────────────────────────
  ...periodPreferenceKeys('reportsPeriod'),
  ...periodPreferenceKeys('exportPeriod'),
  'reportsAccountFilterIds',
  'reportsShowRevaluations',
  'reportsMatrixSubcategories',
  'reportsShowTopTransactions',
  'reportsComparisonBasis',
  'reportsTrendChartType',
  'reportsPayeeSide',
  'reports.monthlyIncomeExpenses.cumulative.v1',
  'reports.incomeSpendingOverTime.cumulative.v1',
  'netWorthChartType',
  'netWorthShowDetail',

  // ── Accounts page ────────────────────────────────────────────────────────
  'accountsGroupBy.v2',
  'accountsSortMode',
  'accountsCollapsedGroups',

  // ── Reconciliation ───────────────────────────────────────────────────────
  'reconciliationGroupBy.v2',
  // The pre-toggle key, when banding this list was one choice rather than two
  // switches. Still carried so an existing view survives the upgrade — it is
  // read once, by the migration in `reconciliationGrouping`.
  'reconciliationGroupBy',
  'reconciliationSortMode',
  'reconciliationOnlyAttention',

  // ── Register (per-account transaction list) ──────────────────────────────
  // Order and visibility travel; WIDTHS do not — see the classification note.
  'accountRegister.columnOrder.v1',
  'accountRegister.hiddenColumns.v1',
  'accountRegister.archive.v1',

  // ── Archive ──────────────────────────────────────────────────────────────
  'archiveManager.preset.v1',
  'archiveManager.customDate.v1',
  'archiveManager.overrides.v1',
  'archiveManager.collapsedGroups.v1',

  // ── App-wide preferences (PreferencesContext) ────────────────────────────
  'money_management_compact_view',
  'money_management_currency',
  'money_management_theme',
  'money_management_theme_schedule',
  // Retired, and still carried for the same reason `reconciliationGroupBy` is:
  // a backup taken today may be restored by a build that still reads them, and
  // dropping a key from this list silently discards whatever the document
  // holds. Nothing in the app reads any of the three.
  'money_management_first_name',
  'money_management_show_investments',
  'money_management_goal_celebrations',

  // ── Alerts (NotificationContext) ─────────────────────────────────────────
  'money_management_budget_alerts_enabled',
  'money_management_alert_threshold',
  'money_management_large_transaction_alerts_enabled',
  'money_management_large_transaction_threshold',

  // ── Export templates ─────────────────────────────────────────────────────
  'export-templates',
  'export-templates-initialised',

  // ── Bank auto-sync ───────────────────────────────────────────────────────
  // The PREFERENCE only. `bankAutoSync:lastRun:<user>` stays on the device:
  // it records when THIS browser last ran a sync, and a fresh machine that
  // inherited it would believe it had already synced today and skip.
  'bankAutoSync.prefs.v1',

  // ── The "Bringing in your history" guide ─────────────────────────────────
  // Three statements about the PERSON, not about this screen: that they have
  // met the guide (which is what keeps it on screen while their backlog falls),
  // that they hid it, and which of the three steps only they can judge they
  // have finished. A guide dismissed on a laptop that came back on a phone
  // would be the same bug the balance reminder's acknowledgement was moved here
  // to avoid. See components/dashboard/HistoryPathCard.
  'historyPath.engaged.v1',
  'historyPath.dismissed.v1',
  'historyPath.ticks.v1',

  // ── Phone notifications ──────────────────────────────────────────────────
  // The switches travel: they are what the person asked for, and the SERVER
  // reads them from this document to decide whether to push at all
  // (api/_lib/cloud-refresh-announce.ts, api/_lib/reminder-push.ts). The
  // zone is a device fact kept in the account's document on purpose — see
  // services/push/prefs.ts — and it travels for the same reason: the cron
  // needs it, and the cron reads only this row.
  'phoneNotifications.prefs.v1',
  'device.timeZone.v1',

  // ── Home-screen widgets ──────────────────────────────────────────────────
  // How the person wants their budgets seen at a glance — amounts or
  // percentages, hidden while locked or not. The SERVER reads both from this
  // document to shape what a widget is sent (api/_lib/widget-budgets.ts).
  // Whether a phone HOLDS a widget key is not here: that is a fact about one
  // phone, and it is asked of the phone. See services/widget/prefs.ts.
  'widgetDisplay',
  'widgetHideWhenLocked',
  'widgetPercentAs',

  // ── Formatting ───────────────────────────────────────────────────────────
  'preferredLocale',
] as const;


// ── Where a preference lives while the app runs ─────────────────────────────

/**
 * The shape every rewired call site talks to — deliberately `Storage`'s own, so
 * a call site changes by one word and its error handling stays exactly as it
 * was. `getItem` is synchronous because the surfaces reading it are `useState`
 * initialisers: a promise here would mean every remembered toggle flashed its
 * default first.
 */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * WHAT SYNCHRONOUS READING COSTS, stated rather than hidden.
 *
 * On a machine the user has NEVER opened, the browser mirror is empty and the
 * account's document lands a few hundred milliseconds into boot. A surface that
 * read its preference in a `useState` initialiser before then shows the default
 * for the rest of that session — one session, on one machine, once.
 *
 * That is the deliberate trade against the alternative, which is worse in the
 * other 99% of visits: making every remembered toggle asynchronous means every
 * returning user watches the dashboard paint the DEFAULT and then correct
 * itself, on every load, for ever. The app-wide values (theme, currency, name)
 * do not pay even the one-session cost, because PreferencesContext subscribes
 * and corrects itself the moment the document arrives; anything else that turns
 * out to matter can do the same through `subscribe`.
 */

/** The browser storage the cache mirrors into. Injectable for tests. */
export interface LocalMirror {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/*
 * `PreferencesTransport` USED TO BE DECLARED HERE. It moved to
 * `preferences/document.ts` in slice 28 and is re-exported above, so no caller
 * changed — see that module's header for why: the desktop's implementation of
 * it may not name this file, even in a type position that a build erases.
 */

/** How long a burst of changes is collected before one write goes out. */
export const PREFERENCES_WRITE_DEBOUNCE_MS = 800;

/*
 * `supabasePreferencesTransport` AND `USER_PREFERENCES_TABLE` USED TO BE
 * DECLARED HERE. They moved to `services/preferences/cloudTransport.ts` in the
 * mount slice, unchanged, and this module now reaches the transport through
 * `@prefs-store` — the specifier each build resolves to its own store.
 * `backupService.ts` imports it from its new home; nothing else ever called it.
 * See `editions/preferencesStore.ts` for why the FALLBACK is the seam rather
 * than the service.
 */

export interface PreferencesServiceOptions {
  mirror?: LocalMirror | null;
  transport?: PreferencesTransport | null;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  debounceMs?: number;
}

/**
 * The live preferences of whoever is signed in.
 *
 * ── THE THREE STORES, AND WHY ───────────────────────────────────────────────
 *
 *   memory   authoritative while the tab is open, and the only one anything
 *            reads. Synchronous, so a `useState` initialiser gets the real
 *            answer rather than a default it has to correct a frame later.
 *   browser  a mirror, written on every change. It is what makes the app work
 *            signed-out, offline, and during the boot before the row arrives —
 *            and it is where the one-time lift finds the settings the owner
 *            already has.
 *   database the copy that travels. Written debounced, because dragging a
 *            column width or ticking six accounts is a burst of changes and
 *            each one does not deserve a round trip.
 *
 * ── WHAT HAPPENS ON A CONFLICT ──────────────────────────────────────────────
 *
 * The server row wins on load, per key, and the browser mirror is refreshed
 * from it. That is the only rule that makes "my settings follow me" true: a
 * machine that has not been opened for a month must not push its month-old
 * toggles over the ones set since. The exception is a server row that does not
 * exist yet, which is the lift — see `attach`.
 */
export class PreferencesService implements PreferenceStorage {
  private document: PreferencesDocument = { version: PREFERENCES_DOCUMENT_VERSION, values: {} };
  private readonly listeners = new Set<() => void>();
  private readonly injectedMirror: LocalMirror | null | undefined;
  /**
   * The store, when somebody has said which one. `undefined` means *"nobody has
   * said, so ask the cloud"* — see {@link PreferencesService.useTransport} for
   * why that is three states rather than two.
   */
  private transportOverride: PreferencesTransport | null | undefined;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly debounceMs: number;

  private userId: string | null = null;
  private pendingWrite: ReturnType<typeof setTimeout> | undefined;
  /** Resolves when nothing is queued — the whole reason tests need not sleep. */
  private inFlight: Promise<void> = Promise.resolve();
  private loaded = false;
  /**
   * True when this session asked the store for the row and did not get an
   * answer — as against `loaded`, which says an answer ARRIVED.
   *
   * The two are not opposites and the difference is the whole point. An
   * unloaded session that never asked has nothing to lose by writing; one whose
   * read FAILED is holding an empty document that means *"I don't know"*, and a
   * write would publish that ignorance over a row it never saw. See
   * {@link PreferencesService.scheduleWrite}.
   */
  private readFailed = false;

  constructor(options: PreferencesServiceOptions = {}) {
    this.injectedMirror = options.mirror;
    this.transportOverride = options.transport;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout.bind(globalThis);
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout.bind(globalThis);
    this.debounceMs = options.debounceMs ?? PREFERENCES_WRITE_DEBOUNCE_MS;
  }

  /**
   * The browser's own storage, resolved on EVERY use rather than captured in the
   * constructor.
   *
   * This module is imported at boot, and a reference taken then outlives
   * anything that replaces `window.localStorage` afterwards — which is not a
   * hypothetical: the test harness installs its own implementation after the
   * module graph is loaded, and a service holding the original would quietly be
   * reading a different store from the one every test writes to. Resolving late
   * also means no assumption that `window` exists at import time.
   */
  private get mirror(): LocalMirror | null {
    if (this.injectedMirror !== undefined) return this.injectedMirror;
    return typeof window !== 'undefined' ? window.localStorage : null;
  }

  private resolveTransport(): PreferencesTransport | null {
    if (this.transportOverride !== undefined) return this.transportOverride;
    return defaultPreferencesTransport();
  }

  /**
   * Say which store these settings live in, for the rest of this session.
   *
   * ── WHY THE CONSTRUCTOR WAS NOT ENOUGH ──────────────────────────────────
   *
   * There is ONE instance of this service and the whole application reads it
   * through `subscribe` — that is the point of the singleton, and it is argued
   * where the singleton is created. So a second instance pointed at a file is
   * not an option: every surface would go on reading the first one.
   *
   * The cloud never needed this, because its store is a property of the BUILD
   * (`@prefs-store`'s cloud half reads a module-scope client). A ledger file is
   * a property of the SESSION — it is chosen, opened and closed while the
   * program runs — so the desktop's boot says so here, once, before it attaches
   * (`services/local/deviceDocument.ts`).
   *
   * ── THREE STATES, NOT TWO, AND THIS METHOD CAN ONLY REACH TWO OF THEM ───
   *
   * `undefined` is *"nobody has said"* and is what makes `resolveTransport`
   * fall through to the cloud. This method takes `PreferencesTransport | null`
   * and therefore cannot restore it: once a session has been told where the
   * settings live, it does not go back to guessing. `null` is a real answer —
   * *"there is no store; the browser mirror IS the store"* — and is what a demo
   * or signed-out session already gets.
   *
   * ── IT DETACHES, AND THAT IS NOT TIDINESS ───────────────────────────────
   *
   * `scheduleWrite` resolves the transport when its TIMER FIRES, not when the
   * change was made. So a burst of changes made a moment before this call would
   * otherwise be delivered to the NEW store under the PREVIOUS store's user id
   * — the same cross-account write `detach` exists to prevent on a shared
   * browser. Changing stores is changing accounts, and it is treated as one.
   */
  useTransport(transport: PreferencesTransport | null): void {
    if (this.transportOverride === transport) return;
    if (this.userId !== null || this.loaded) {
      this.detach();
    } else {
      this.cancelPendingWrite();
    }
    this.transportOverride = transport;
  }

  /**
   * Everything the browser already holds for a registered key.
   *
   * Read WITHOUT the server, before sign-in resolves, so the very first paint
   * of a returning user shows their own settings instead of the defaults they
   * would then watch get corrected.
   */
  private readMirror(): Record<string, string> {
    const values: Record<string, string> = {};
    if (!this.mirror) return values;
    for (const key of PORTABLE_PREFERENCE_KEYS) {
      try {
        const stored = this.mirror.getItem(key);
        if (stored !== null) values[key] = stored;
      } catch {
        // Safari private browsing throws on read. A preference nobody can read
        // is a default, which is survivable; a page that will not render is not.
        return values;
      }
    }
    return values;
  }

  // ── The Storage-shaped face every call site uses ──────────────────────────

  /**
   * The document first, then the browser.
   *
   * The fall-through is what makes this a drop-in replacement for
   * `localStorage.getItem` on the very first boot after it ships: every setting
   * the user already has is sitting in browser storage under exactly these
   * keys, and reading it there means nothing is forgotten in the window between
   * the app starting and the account's document arriving.
   *
   * It STOPS once a stored document has been loaded, and that is deliberate.
   * After the server has spoken, a key absent from its document is absent — the
   * user removed that preference, possibly on another machine — and falling
   * back to this browser's leftover copy would resurrect it every boot.
   */
  getItem(key: string): string | null {
    const value = this.document.values[key];
    if (value !== undefined) return value;
    if (this.loaded) return null;
    try {
      return this.mirror?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  setItem(key: string, value: string): void {
    if (this.document.values[key] === value) return;
    this.document = { ...this.document, values: { ...this.document.values, [key]: value } };
    this.writeMirror(key, value);
    this.scheduleWrite();
    this.notify();
  }

  removeItem(key: string): void {
    // The MIRROR is cleared whether or not the document held this key, and that
    // asymmetry with the early return below is the whole point.
    //
    // `getItem` above reads the mirror for any key the document does not hold,
    // right up until the account's row lands — so a key left behind here is not
    // dormant, it is live, and it comes back on the next boot as a setting the
    // user already switched off. The dashboard's period pins are where that bit:
    // a released card removes its five keys, the four that carry the WINDOW are
    // in the document and go, and the fifth — the pin flag, removed last — is
    // mirror-only whenever this session's document did not happen to hold it
    // (a boot that read before `attach` resolved, an offline boot, a session
    // whose writes never reached the server). What survives is a pin flag with
    // no window beside it: the card comes back declaring itself pinned with
    // nothing to be pinned to. See hooks/useCardPeriod.
    try {
      this.mirror?.removeItem(key);
    } catch {
      // Unwritable storage costs the mirror, never the in-memory truth.
    }
    // Nothing to forget in the document, so nothing to write back or announce.
    if (!(key in this.document.values)) return;
    const values = { ...this.document.values };
    delete values[key];
    this.document = { ...this.document, values };
    this.scheduleWrite();
    this.notify();
  }

  private writeMirror(key: string, value: string): void {
    try {
      this.mirror?.setItem(key, value);
    } catch {
      // Quota or private browsing. The setting still holds for this visit and
      // still reaches the server; only the offline copy is lost.
    }
  }

  // ── Subscription (useSyncExternalStore) ───────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** The identity React compares. A new object per change, stable between them. */
  getDocument = (): PreferencesDocument => this.document;

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  /**
   * Bind the service to a signed-in user and load their row.
   *
   * THE LIFT: a user whose row does not exist yet has their current browser
   * settings written up as the row's first content. Without it, shipping this
   * would read as the app forgetting everything on the day it learned to
   * remember — the owner has years of choices in `window.localStorage` and no
   * intention of making them again.
   *
   * The lift is once per login, not once per device, and that is the right
   * grain: the row exists after the first machine writes it, so a second
   * machine loads the first's settings rather than overwriting them with its
   * own. Whichever machine gets there first wins, which is the only outcome
   * available without a merge policy nobody asked for.
   */
  async attach(userId: string): Promise<void> {
    if (this.userId === userId && this.loaded) return;
    this.userId = userId;
    this.readFailed = false;

    const transport = this.resolveTransport();
    if (!transport) {
      // Local or demo mode. The mirror IS the store; nothing more to do.
      this.loaded = true;
      return;
    }

    let stored: PreferencesDocument | null;
    try {
      stored = await transport.read(userId);
    } catch (error) {
      // A database that has not had 20260809160000 applied yet lands here, and
      // so does an offline boot. Both are survivable: the browser mirror holds
      // exactly what this machine held before, which is where every one of
      // these settings lived until today.
      //
      // What this session may NOT do is write. It is holding an empty document
      // and a set user id, and `write` uploads the document WHOLE — so the
      // first preference anything touched afterwards replaced the user's entire
      // stored row with the one or two keys this session happened to set. That
      // is silent data loss, and it falls hardest on preferences written only
      // when the user deliberately does something (a dashboard card pinned to
      // its own window): everything a mount effect rewrites each boot comes
      // back, and those do not. This session stays local; the next boot retries
      // the read and writes normally once it has an answer.
      this.readFailed = true;
      preferencesLogger.warn(
        'Could not read your stored preferences, so changes made now will stay on this device until the next reload',
        error
      );
      return;
    }

    if (stored === null) {
      // No row yet. THE LIFT: everything this browser holds becomes the row's
      // first content, merged UNDER anything already set this session — a
      // toggle flipped while the read was in flight is newer than the stored
      // copy it came from. An empty browser lifts an empty document, which is
      // correct and costs one insert.
      this.document = {
        version: PREFERENCES_DOCUMENT_VERSION,
        values: { ...this.readMirror(), ...this.document.values },
      };
      this.loaded = true;
      this.scheduleWrite();
      this.notify();
      return;
    }

    // Server wins per key, and the browser mirror is refreshed to match: this
    // machine's month-old toggles must not outrank the ones set since. Values
    // set during THIS session stay on top — they postdate the read.
    this.document = { ...stored, values: { ...stored.values, ...this.document.values } };
    for (const [key, value] of Object.entries(this.document.values)) this.writeMirror(key, value);
    this.loaded = true;
    this.notify();
  }

  /**
   * Forget the signed-in user, and everything held for them.
   *
   * The in-memory document is CLEARED, not kept, and that matters on a shared
   * browser: `attach` merges whatever is in memory on top of the document it
   * reads, so a session that signed out of one account and into another would
   * otherwise write the first user's pinned accounts and archive cutoffs into
   * the second user's row. The browser mirror is left alone — it is the
   * browser's own copy, it is what a signed-out or local session reads, and it
   * has always survived sign-out.
   */
  detach(): void {
    this.cancelPendingWrite();
    this.userId = null;
    this.loaded = false;
    this.readFailed = false;
    this.document = { version: PREFERENCES_DOCUMENT_VERSION, values: {} };
    this.notify();
  }

  // ── Writing back ──────────────────────────────────────────────────────────

  private cancelPendingWrite(): void {
    if (this.pendingWrite !== undefined) {
      this.clearTimeoutFn(this.pendingWrite);
      this.pendingWrite = undefined;
    }
  }

  private scheduleWrite(): void {
    // No user, or a user whose row this session could not read. The second is
    // the dangerous one: the document is empty because the read failed, not
    // because the settings are, and `write` would publish it over the row. See
    // `readFailed`.
    if (this.userId === null || this.readFailed) return;
    this.cancelPendingWrite();
    this.pendingWrite = this.setTimeoutFn(() => {
      this.pendingWrite = undefined;
      this.inFlight = this.write();
    }, this.debounceMs);
  }

  private async write(): Promise<void> {
    const userId = this.userId;
    const transport = this.resolveTransport();
    if (userId === null || !transport) return;

    // Snapshot before awaiting: a change made while the request is in flight
    // must schedule its own write rather than silently ride on this one.
    const document = this.document;
    try {
      await transport.write(userId, document);
    } catch (error) {
      // Offline, or the row was refused. The browser mirror already holds it,
      // so the setting survives this session and the next write retries.
      preferencesLogger.warn('Preferences could not be saved to your account', error);
    }
  }

  /**
   * Send anything queued NOW and wait for it.
   *
   * Exists for two callers with the same problem: a test that must not sleep,
   * and an export that would otherwise read a row the user's last click has not
   * reached yet.
   */
  async flush(): Promise<void> {
    if (this.pendingWrite !== undefined) {
      this.cancelPendingWrite();
      this.inFlight = this.write();
    }
    await this.inFlight;
  }

  /** Replace the whole document — the restore path, and nothing else. */
  async replaceAll(document: PreferencesDocument): Promise<void> {
    this.document = parsePreferencesDocument(document);
    for (const [key, value] of Object.entries(this.document.values)) this.writeMirror(key, value);
    this.notify();
    if (this.userId !== null) {
      this.cancelPendingWrite();
      this.inFlight = this.write();
      await this.inFlight;
    }
  }
}

/**
 * The one instance the app talks to.
 *
 * A singleton rather than context state because the readers are `useState`
 * initialisers scattered across pages that mount at different times, and
 * because `PreferencesProvider` sits ABOVE `AppProvider` in the tree — the
 * database identity it needs does not exist when it mounts. The service is
 * bound to a user when that identity resolves (see AppContextSupabase), and
 * everything below re-renders through `subscribe`.
 */
export const preferences = new PreferencesService();
