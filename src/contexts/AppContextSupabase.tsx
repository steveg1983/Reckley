/* eslint-disable react-refresh/only-export-components */
/**
 * The app's state, and the one door it reads and writes through.
 *
 * This file names no engine and, from the mount slice's second half, no EDITION
 * either. Every ledger operation goes through `dataPort` — the seam — and the
 * questions it used to ask about the engine itself (how many writes may be in
 * flight, whether to open a realtime subscription) are answered by that seam's
 * capability descriptor.
 *
 * ── THE FOUR IMPORTS THAT ARE GONE, AND WHAT REPLACED THEM ──────────────────
 *
 * Until the mount slice this provider reached the cloud four ways, all of them
 * inside the seventy lines of ONE effect between *"is Clerk loaded?"* and
 * *"read the ledger"*: `useUser()`, `userIdService`, `AutoSyncService` and
 * `initializeDemoData`. A walk from here with a desktop's resolution found 48
 * modules and those four roots, and nothing else in these 2,200 lines reached a
 * cloud at all — which is why twenty of the twenty-five owed desktop routes
 * named this one file as their only blocker.
 *
 * They are behind `@session` now: a specifier the BUILD resolves, exactly as it
 * resolves `@data`. The hook answers three things — is the session settled, is
 * there an owner, and *"do whatever your edition must do before I read"* — and
 * a browser's answer is the hundred lines that used to be here while a device's
 * is that it happened when the file was opened. Nothing was deleted; the same
 * code runs in the same order in the web build, from `editions/cloud/session.ts`.
 *
 * THE NAME OF THIS FILE IS NOW WRONG, and knowingly so. It says Supabase and it
 * has not mentioned Supabase since the seam landed. Renaming it would touch
 * roughly seventy importers for no behaviour, and the module path is what those
 * importers are written against; it is a rename to do on a quiet day, not while
 * an edition is being mounted on top of it.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
// Who is asking, and what has to happen before a read — the mount slice's fifth
// seam. `editions/session.ts` carries the argument for why it is ONE seam and
// not four, and why the alternative (splitting this provider in two) is wrong
// for a reason React decides rather than taste.
import { useEditionSession } from '@session';
// The ledger goes through the seam, and `@data` is the seam's DOOR: a specifier
// that names no edition, resolved by the build to `services/port/index.ts` in
// the web app and to `services/local/deviceDataPort.ts` in a desktop window. In
// this build `dataPort` IS the DataService singleton typed as the interface —
// no wrapper, no second copy, no extra bytes — and in that one it is the port
// over the file the person opened. Neither bundle contains the other's engine,
// because neither bundle's graph can reach it. See docs/edition-gating.md.
import { dataPort } from '@data';
import type { DataPortCapabilities } from '@data';
// The reports service, for its ADOPTION alone: the four persistence calls below
// go straight through the seam like every other entity's, and this is the one
// piece of report behaviour that is neither a read nor a write but a one-time
// rescue of what a browser was still holding. See `adoptLegacyReports`.
import { customReportService } from '../services/customReportService';
import { getDefaultCategories } from '../data/defaultCategories';
// formatCurrency import removed - not used in this context
import {
  toDecimalTransaction,
  toDecimalAccount,
} from '../utils/decimal-converters';
import { toDecimal, type DecimalInstance } from '../utils/decimal';
import { normalizeTransactionDates } from '../utils/dateBoundary';
import {
  isMarkedAwaitingFinalize,
  isReconciled,
  reconciledAfterMarking
} from '../utils/transactionReconciliation';
import { reviewAfterMarking } from '../utils/transactionReview';
import {
  buildTestDataset,
  planTestDataCategories,
  type TestDataPhase,
  type TestDataProgress,
  type TestDataSeedResult
} from '../utils/testDataset';
import type { ServerAccountBalance } from '../utils/accountBalances';
import type { DecimalTransaction, DecimalAccount } from '../types/decimal-types';
import type {
  Account,
  AccountUpdate,
  Transaction,
  TransactionSplit,
  TransactionSplitInput,
  SplitWriteResult,
  Category,
  CategoryMergeResult,
  Budget,
  CustomReport,
  DismissalKind,
  Goal,
  RecurringTransaction,
  SuggestionDismissal,
  TransferDisplacedDisposition,
  TransferRepointResult,
  AppState
} from '../types';
import { createScopedLogger } from '../loggers/scopedLogger';
import { planCategoryTreeImport, planCategoryPrune, type CategoryTreeGroup } from '../utils/categoryTreeImport';
import {
  BULK_TRANSFER_FILING_REFUSAL,
  categoryIdIsTransferFiling,
} from '../utils/transferCoherence';
import { fxForLinkedPair, withFxRecord } from '../utils/crossCurrencyTransfer';
import {
  releaseUpdatesFor,
  survivorsOfDeletedLeg,
  type DeleteTransactionOutcome,
  type TransferSurvivorOutcome,
} from '../utils/transferSurvivorRelease';
import { formatCount } from '../utils/localeFormat';

export interface Tag {
  id: string;
  name: string;
  color?: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One row's payee, said row by row.
 *
 * The unit the payee sweep's one-shot Undo is held in and given back by. A
 * rename collapses many payees into ONE name, so there is no "the previous
 * name" to put back — each row has to carry its own wording, or undoing a
 * rename would be a second rename.
 */
export interface TransactionDescription {
  id: string;
  description: string;
}

export interface AppContextType extends AppState {
  // Account operations
  addAccount: (account: Omit<Account, 'id'> & { initialBalance?: number }) => Promise<Account>;
  updateAccount: (id: string, updates: AccountUpdate) => Promise<void>;
  closeAccount: (id: string) => Promise<void>;

  // Transaction operations — async so callers can surface save failures.
  /**
   * Returns THE ROW THAT WAS WRITTEN, id and all.
   *
   * It used to promise `void`, and the register's quick-add dock had already
   * been written as though it did not: it wrote `const created = await
   * addTransaction(…); if (isTransfer && created) { …make the other side… }`.
   * `created` was always undefined, so the guard was always false and the
   * Txfr toggle silently produced ONE leg of every transfer it was asked for —
   * a row pointing at an account with nothing in it pointing back. Nothing in
   * the type system objected, because `void` is assignable to a condition.
   *
   * A create that will not say what it created cannot be followed by anything
   * that needs the new id, and creating the other half of a transfer is
   * exactly that. So it says.
   */
  addTransaction: (transaction: Omit<Transaction, 'id'>) => Promise<Transaction>;
  updateTransaction: (id: string, updates: Partial<Transaction>) => Promise<void>;
  /**
   * Remove one row — and RELEASE whatever it was half of.
   *
   * It reports what became of the other side rather than returning void,
   * because a caller that deletes both halves has to be able to say truthfully
   * which one survived if the second delete fails, and "released" and "merely
   * unlinked" are two different rows to go and look for. See
   * utils/transferSurvivorRelease.ts.
   */
  deleteTransaction: (id: string) => Promise<DeleteTransactionOutcome>;
  
  // Budget operations — async so callers can surface persistence failures
  addBudget: (budget: Omit<Budget, 'id' | 'spent'>) => Promise<void>;
  updateBudget: (id: string, updates: Partial<Budget>) => Promise<void>;
  deleteBudget: (id: string) => Promise<void>;

  /**
   * Every report this login has built, in hand before the first paint.
   *
   * Exposed as STATE rather than behind a fetch because two of its readers have
   * no await to put one in: the pinned-report widget resolves its report during
   * render, and the dashboard's picker lists them inline. See the state
   * declaration for the rest of the argument.
   */
  customReports: CustomReport[];
  /**
   * Save a report — created when it carries no id, replaced when it does.
   *
   * ONE verb for both, unlike the goal pair above, because the builder has one
   * button. `CustomReportBuilder` hands back a whole report whether the person
   * opened it on a blank form or on an existing report, and the id is the only
   * thing that says which happened; making the caller decide would move that
   * test into a component that has no other reason to care.
   *
   * Answers the STORED report, so the caller can use the id the store minted.
   */
  saveCustomReport: (report: CustomReport) => Promise<CustomReport>;
  deleteCustomReport: (id: string) => Promise<void>;
  
  // Category operations — async so callers can surface persistence failures
  /** Returns the created category so callers can use its real id immediately. */
  addCategory: (category: Omit<Category, 'id'>) => Promise<Category>;
  /**
   * Merge a Money-style category tree; skips same-named entries. With
   * pruneOthers, unused non-system categories outside the tree are removed
   * afterwards (categories still referenced by transactions are kept).
   */
  importCategoryTree: (
    tree: CategoryTreeGroup[],
    options?: { pruneOthers?: boolean }
  ) => Promise<{ created: number; skipped: number; pruned: number; keptForTransactions: number }>;
  updateCategory: (id: string, updates: Partial<Category>) => Promise<void>;
  deleteCategory: (id: string) => Promise<void>;
  /**
   * Join two categories: every reference (transactions, split lines, budgets,
   * recurring templates) moves from `sourceId` to `targetId` and the source is
   * removed — all in ONE server-side transaction, so it either happens or it
   * does not. Balance-neutral. Returns what actually moved, as the database
   * counted it.
   */
  mergeCategories: (sourceId: string, targetId: string) => Promise<CategoryMergeResult>;
  getSubCategories: (parentId: string) => Category[];
  getDetailCategories: (parentId: string) => Category[];
  
  // Tag operations
  addTag: (tag: Omit<Tag, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateTag: (id: string, updates: Partial<Tag>) => void;
  deleteTag: (id: string) => void;
  getTagUsageCount: (tagName: string) => number;
  getAllUsedTags: () => string[];
  
  // Other operations
  importData: (data: Partial<AppState>) => void;
  exportData: () => string;
  resetLoadedData: () => Promise<void>;
  getDecimalTransactions: () => DecimalTransaction[];
  getDecimalAccounts: () => DecimalAccount[];
  
  // Sync status
  isLoading: boolean;
  lastSyncTime: Date | null;
  syncError: string | null;
  /**
   * The boot's transaction read failed and the list in state is its fallback
   * (usually empty), NOT the ledger. Anything about to assert "there are no
   * transactions" — an empty register, a zeroed report — must check this
   * first and say "couldn't load" instead: presenting an unreadable ledger as
   * an empty one tells a user their money is gone.
   */
  transactionsLoadFailed: boolean;
  /**
   * What the store behind this app can do — the seam's own descriptor, surfaced
   * here so a component can read it without importing the seam.
   *
   * It replaced `isUsingSupabase`, which was a boolean four unrelated questions
   * were being answered from: how many writes may be in flight, whether to open
   * a realtime subscription, where a backup goes, and whether a sentence says
   * "login" or "device". Each of those is now a field that says what it governs
   * (see DataPortCapabilities), which is what lets an engine that is neither of
   * today's two answer them independently instead of being forced to claim it
   * is Supabase.
   *
   * `edition` is WORDS ONLY and no code here may branch on it — a test greps
   * for that. The routing questions are the other four fields.
   */
  capabilities: DataPortCapabilities;
  /**
   * Re-pull ONLY accounts + transactions from Supabase (e.g. after a bank sync).
   * Deliberately narrow — budgets/goals are a separate read, so a whole-app
   * refresh would blank them for cloud users.
   */
  refreshAccountsAndTransactions: () => Promise<void>;
  /**
   * Re-pull categories (e.g. after closing/reopening an account, whose DB
   * trigger flips the linked transfer category's active flag server-side).
   * Never throws — a failed refresh just leaves the current snapshot.
   */
  refreshCategories: () => Promise<void>;
  /**
   * Mark transactions off against a statement (or take the mark back) in one
   * round trip. Balance-neutral, and NOT a reconciliation: a mark is a working
   * state that survives leaving the screen and settles nothing. Only
   * {@link finalizeReconciliation} commits.
   */
  setTransactionsCleared: (ids: string[], cleared: boolean) => Promise<void>;
  /**
   * Finish an account's reconciliation: commit its marked rows and record the
   * day and the ending balance the user confirmed. Resolves with how many rows
   * were converted, so the screen can say what it did.
   */
  finalizeReconciliation: (
    accountId: string,
    endingBalance: number,
    reconciledOn: Date
  ) => Promise<number>;
  /**
   * Apply a category to the listed transactions that are still uncategorized
   * (payee-memory propagation). Fill-blanks only — never overwrites an explicit
   * category, enforced server-side. Returns the number actually updated.
   */
  applyCategoryToUncategorized: (ids: string[], category: string) => Promise<number>;
  /**
   * Payee memory's automatic fan-out (11 Sep 2026): the same fill-blanks
   * spread, written as a SUGGESTION — `categoryConfirmed: false`,
   * `needsReview: true` — so the extrapolated rows stay in To Review wearing
   * the Suggested badge until their owner confirms or corrects each one.
   */
  suggestCategoryToUncategorized: (ids: string[], category: string) => Promise<number>;
  /**
   * Agree with the app's suggested category on the named rows, without changing
   * it. Balance-neutral — one boolean per row. Returns how many actually
   * flipped (a row someone else already confirmed does not count twice).
   */
  confirmTransactionCategories: (ids: string[]) => Promise<number>;
  /**
   * Rewrite the payee (description) on the named transactions — the Payee
   * cleanup screen's one write.
   *
   * Every row goes through the SAME audited dataPort.updateTransaction the
   * edit modal uses, so each rename lands in financial_audit_log with its
   * before and after. What differs is only the orchestration: the writes are
   * awaited in small batches (never fired and forgotten), and React state is
   * touched ONCE at the end — a per-row state update would re-map a 50k-row
   * array and re-render the app for every transaction renamed.
   *
   * Resolves with the number of rows actually rewritten. A row that fails is
   * counted out rather than aborting the batch, so a single bad id cannot
   * strand the rest half-renamed with nothing to show for it.
   */
  renameTransactionDescriptions: (
    ids: string[],
    description: string,
    onProgress?: (done: number) => void
  ) => Promise<number>;
  /**
   * Give each of these rows back the payee it names — the other direction of
   * the rename above, and the write behind the sweep's one-shot Undo.
   *
   * Same door, same batching, same single state patch (they share
   * `writeDescriptions`); what differs is that every row carries its OWN text
   * rather than all of them sharing one, which is what makes it an undo rather
   * than another rename. Each write lands in financial_audit_log like any
   * other, so putting a batch back is as auditable as making it.
   *
   * Resolves with the number of rows actually put back, and NEVER throws for a
   * write the ledger refused: the caller is a screen saying what became of a
   * batch it has already told the user about, and it needs the count far more
   * than an exception — `entries.length` minus this is what still reads the
   * name the rename gave it.
   */
  restoreTransactionDescriptions: (
    entries: ReadonlyArray<TransactionDescription>,
    onProgress?: (done: number) => void
  ) => Promise<number>;
  /** Soft-archive an account's reconciled transactions on/before the cutoff. */
  archiveTransactionsBefore: (accountId: string, cutoff: Date) => Promise<number>;
  /** Bring an account's archived transactions back into the live register. */
  unarchiveAccount: (accountId: string) => Promise<number>;
  /**
   * Every split line of the user's transactions, loaded at boot and kept in
   * step by setTransactionSplits. Category-aggregation surfaces expand split
   * parents into these via expandSplitTransactions.
   */
  transactionSplits: TransactionSplit[];
  /**
   * Per-account balance computed by the store itself (opening balance + Σ
   * amount) in one round trip, loaded alongside the ~52-page transaction fetch.
   * Balance surfaces read it ONLY while `transactions` is still empty, so the
   * first paint shows real money instead of zeros; empty map when the store
   * cannot answer, in which case nothing changes.
   *
   * Read-only on purpose: they are a stand-in for the seconds a long history is
   * in flight, and nothing above this seam may edit them.
   */
  serverBalances: ReadonlyMap<string, ServerAccountBalance>;
  /** Splits for one transaction, in display order (empty when not split). */
  getTransactionSplits: (transactionId: string) => Promise<TransactionSplit[]>;
  /**
   * Replace a transaction's splits atomically (empty array un-splits it).
   * Split lines must sum EXACTLY to expectedAmount — enforced server-side,
   * which also syncs the transaction amount and account balance when the sum
   * changes them.
   *
   * A line may declare a `transferAccountId`, making it one LEG of a transfer:
   * the counterpart transaction is created in that account and linked to the
   * exact line, in the same server-side transaction, and comes back in
   * `counterparts`. An already-linked leg may only move position or memo —
   * changing its amount, target or category, or dropping it, is refused,
   * because the row on the other side is pinned to it.
   */
  setTransactionSplits: (
    transactionId: string,
    splits: TransactionSplitInput[],
    expectedAmount: number | null
  ) => Promise<SplitWriteResult>;
  /**
   * Join two existing rows (in different accounts, exactly opposite amounts)
   * into a linked transfer pair — both become type 'transfer' carrying the
   * other account's To/From category. Balance-neutral; atomic server-side.
   */
  linkTransferPair: (idA: string, idB: string) => Promise<{ a: Transaction; b: Transaction }>;
  /**
   * Join one LINE of a split to an existing row as the two halves of a
   * transfer — the line-level counterpart of linkTransferPair, for the case
   * where the movement is only part of the transaction it sits in (£35,000
   * arrives, £30,000 of it settles a loan). The amounts must be exactly
   * opposite between the LINE and the row, never the split parent, whose total
   * legitimately differs. Balance-neutral; atomic server-side.
   */
  linkSplitLineTransfer: (
    splitId: string,
    transactionId: string
  ) => Promise<{ split: TransactionSplit; transaction: Transaction }>;
  /**
   * Break linked transfer pairs (the un-doing of linkTransferPair): clears the
   * link on the named rows so they can be re-paired or re-filed. Balance-neutral.
   * The rows keep their transfer type and category until something re-files
   * them — leaving that to the caller, which knows what the row should become.
   */
  unlinkTransfers: (ids: string[]) => Promise<number>;
  /**
   * Soft-archive (or restore) ONE transaction — hidden from the live register,
   * never deleted, still counted in every balance and report.
   */
  setTransactionArchived: (id: string, archived: boolean) => Promise<void>;
  /**
   * Re-pair a counterpart onto the row that really matches it: the wrong
   * pairing is broken, the row it displaces is filed under the given Account
   * Adjustment category, and the right pair is linked — all in ONE server-side
   * transaction, so it either happens or it does not. Balance-neutral.
   */
  repairClaimedTransfer: (
    strandedId: string,
    counterpartId: string,
    partnerId: string,
    adjustmentCategoryId: string
  ) => Promise<void>;
  /**
   * Money-style "create the other side": insert the counterpart in the target
   * account and convert the source into a linked transfer, atomically. Moves
   * the target account's balance by the counterpart amount.
   */
  createTransferCounterpart: (
    id: string,
    targetAccountId: string
  ) => Promise<{ source: Transaction; counterpart: Transaction }>;
  /**
   * Point an EXISTING linked transfer at a different account, atomically: both
   * sides are re-filed from the new pairing, and the counterpart it displaces
   * is moved, released as a plain uncategorised row, or deleted — whichever the
   * caller says. Amounts and dates are never touched.
   *
   * The only transfer operation that is not balance-neutral: a moved
   * counterpart carries its amount out of one account and into the other.
   */
  repointTransfer: (
    id: string,
    targetAccountId: string,
    disposition?: TransferDisplacedDisposition
  ) => Promise<TransferRepointResult>;
  /**
   * Suggestions the user has told the sweeps to stop offering. Loaded on demand
   * (nothing outside the sweeps needs them, and the boot is already the slowest
   * thing in the app), so a surface that filters by these must wait for
   * `suggestionDismissalsStatus` to leave 'loading' before it renders a list.
   */
  suggestionDismissals: SuggestionDismissal[];
  /**
   * 'idle' before the first load, 'error' when the list could not be read — in
   * which case the surfaces show everything and say so, rather than pretending
   * the filter ran.
   */
  suggestionDismissalsStatus: 'idle' | 'loading' | 'ready' | 'error';
  /** Re-read the dismissals (called when a sweep opens). Never throws. */
  refreshSuggestionDismissals: () => Promise<void>;
  /**
   * Record a refusal so the suggestion is never offered again. Throws if it
   * could not be saved — a dismissal that silently fails is the bug this exists
   * to fix.
   */
  dismissSuggestion: (
    kind: DismissalKind,
    subjectKey: string,
    subjectIds: string[]
  ) => Promise<void>;
  /** Undo a refusal: the suggestion comes back from the next scan. */
  restoreSuggestion: (kind: DismissalKind, subjectKey: string) => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);
const appLogger = createScopedLogger('AppContext');

/**
 * Write a payee onto each of these rows and report which ones landed.
 *
 * The one loop behind BOTH bulk payee writes — the rename and the undo of it.
 * Shared rather than copied because the thing worth getting right is the
 * batching, and a second copy of it would be a second chance to get the limit
 * wrong on a store that cannot survive being got wrong.
 *
 * How many may be in flight at once is the STORE's answer, not this loop's. In
 * the cloud each write is an independent RPC, so a handful in flight keeps a
 * few thousand renames tolerable without opening a few thousand sockets; a
 * store that re-reads and re-persists a whole collection per write has no such
 * freedom, because two in flight is a lost-update race and the second silently
 * overwrites the first.
 *
 * The reasoning is unchanged and the numbers are unchanged (8 and 1). What
 * changed is who holds them: this file used to resolve a database id and check
 * a Supabase client to work out which engine it was writing to — the last place
 * in the context that named either — and an engine that is neither had no way
 * to be safe here. Now it states its own limit.
 *
 * Never throws: a row the ledger refused is counted out rather than aborting
 * the batch, so a single bad id cannot strand the rest half-written with
 * nothing to show for it. The callers decide what a total failure means.
 */
const writeDescriptions = async (
  writes: ReadonlyArray<TransactionDescription>,
  onProgress?: (done: number) => void
): Promise<{ written: TransactionDescription[]; failures: number }> => {
  const BATCH_SIZE = dataPort.capabilities().maxConcurrentWrites;
  const written: TransactionDescription[] = [];
  let failures = 0;

  for (let start = 0; start < writes.length; start += BATCH_SIZE) {
    const batch = writes.slice(start, start + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(write => dataPort.updateTransaction(write.id, { description: write.description }))
    );
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        written.push(batch[index]);
      } else {
        failures++;
        appLogger.error('Failed to write payee on transaction', result.reason);
      }
    });
    onProgress?.(Math.min(start + batch.length, writes.length));
  }

  return { written, failures };
};

export function AppProvider({ children }: { children: React.ReactNode }) {
  /**
   * Whose ledger this is, and what this edition must do before it can be read.
   *
   * It replaced `const { user, isLoaded } = useUser()`, and the object's
   * IDENTITY is the replacement for that pair: both halves memoise on their own
   * notion of a session, so `[session]` below is exactly the `[user, isLoaded]`
   * this effect has always depended on, said once by whoever knows what a
   * session is.
   */
  const session = useEditionSession();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  /**
   * The reports somebody has built, in hand before anything renders.
   *
   * State here rather than a fetch where they are drawn, because two of their
   * readers are SYNCHRONOUS: `CustomReportWidget` resolves a pinned report
   * inside a `useMemo` during render, and the dashboard's report picker lists
   * them inline in a modal body. Neither has an await to put a fetch in, and
   * giving them one would mean a pinned widget that renders nothing on first
   * paint and appears a moment later, every load. So they ride the boot
   * snapshot, exactly as the goals do.
   */
  const [customReports, setCustomReports] = useState<CustomReport[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [recurringTransactions, setRecurringTransactions] = useState<RecurringTransaction[]>([]);
  // Every split line of the user's transactions, loaded once at boot and kept
  // in step by setTransactionSplits/deleteTransaction. Category-aggregation
  // surfaces (counters, budgets, analytics, exports) expand split parents
  // into these lines via expandSplitTransactions.
  const [transactionSplits, setTransactionSplitsState] = useState<TransactionSplit[]>([]);
  const [serverBalances, setServerBalances] =
    useState<ReadonlyMap<string, ServerAccountBalance>>(new Map());
  // Refusals the sweeps must honour. Loaded when a sweep opens, not at boot:
  // nothing else reads them, and the boot is already the slowest thing here.
  const [suggestionDismissals, setSuggestionDismissals] = useState<SuggestionDismissal[]>([]);
  const [suggestionDismissalsStatus, setSuggestionDismissalsStatus] =
    useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  const [isLoading, setIsLoading] = useState(true);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  /**
   * Did the boot's TRANSACTION read fail? — distinct from `syncError`, which
   * only speaks when the accounts failed too and the whole app falls back.
   *
   * The seam's floor for a failed transaction read is "an empty register
   * beside a working account list" (loadBoot never rejects), and that floor
   * needs a flag or it is indistinguishable from a genuinely empty ledger:
   * without one, a single timed-out page out of fifty booted the app into
   * every register claiming "No transactions in this account yet" over
   * accounts that are full. Consumers that would ASSERT emptiness (the
   * register's empty state) must consult this and say "couldn't load" with a
   * retry instead. Set once per boot from the stats the seam already reports.
   */
  const [transactionsLoadFailed, setTransactionsLoadFailed] = useState(false);
  /**
   * What the store can do, asked ONCE PER BOOT and held in state.
   *
   * State rather than a call in the render body, because the answer changing is
   * something React has to be told about: a sign-in that completes moves
   * `session` from 'connecting' to 'ready' and `backupTarget` from 'device' to
   * 'login', and a component that had merely called the seam during its last
   * render would keep showing the old sentence until something unrelated
   * re-rendered it.
   *
   * Seeded on the first render rather than defaulted, so the value is the
   * store's own answer from the very first paint instead of a placeholder that
   * happens to be wrong for a signed-in session. The re-ask sits in the boot's
   * `finally`, which is what makes it once per boot on EVERY path — including
   * the one where the boot failed, where the retired flag simply stayed false
   * and left a signed-in app describing itself as a device.
   */
  const [capabilities, setCapabilities] =
    useState<DataPortCapabilities>(() => dataPort.capabilities());


  // Refs to prevent duplicate updates and manage debouncing
  const lastUpdateRef = useRef<{ type: string; timestamp: number } | null>(null);
  const updateDebounceRef = useRef<NodeJS.Timeout | null>(null);
  // Suppress real-time reloads shortly after a local write to prevent overwriting optimistic updates
  const recentLocalUpdateRef = useRef<number>(0);
  /**
   * The accounts as they are right now, for callbacks that must not be rebuilt
   * every time a balance moves.
   *
   * `linkTransferPair` needs two accounts' CURRENCIES to know whether the pair
   * it just joined was a conversion. Taking `accounts` as a dependency would
   * give that callback a new identity on every balance change — and it is
   * handed to memoised children — so it reads the ref instead.
   */
  const accountsRef = useRef<Account[]>([]);
  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  // Initialize data service and load data
  useEffect(() => {
    if (!session.settled) return;

    // The realtime channels are opened deep inside an ASYNC boot, but React
    // only accepts a cleanup returned SYNCHRONOUSLY from the effect body. That
    // cleanup used to be returned from inside initializeData — into a promise
    // nobody read — so React was handed nothing at all, and every user change
    // and every unmount left the previous login's account and transaction
    // subscriptions open on the channel.
    //
    // The handles are collected in the effect's own scope instead, and the
    // cleanup at the bottom closes over them. `cancelled` covers the race in
    // both directions: a cleanup that fires while the boot is still in flight
    // has no handle to call yet, so anything registered after that point is
    // torn down the moment it arrives.
    let cancelled = false;
    const teardowns: Array<() => void> = [];
    const registerTeardown = (teardown: () => void): void => {
      if (cancelled) {
        teardown();
        return;
      }
      teardowns.push(teardown);
    };

    // ONE RENDER WHERE THERE WERE SEVERAL — a declared change, not a side
    // effect of tidying.
    //
    // The boot used to set its state in six instalments, each after its own
    // await, so the provider published several partly-filled states on the way
    // up: the accounts alone, then the categories, then the transactions, and
    // so on. Everything the boot reads now arrives in one snapshot and the
    // setters run in the same tick, so React batches them into a single render.
    //
    // WHO COULD SEE THOSE PARTLY-FILLED STATES. A signed-in session: nobody.
    // SupabaseDataLoader holds the whole app behind a loading screen until
    // `isLoading` goes false in this effect's `finally`, so no consumer renders
    // during the boot at all. A demo or signed-out session does render
    // throughout, and there the change is strictly in its favour — a reader
    // that used to be handed transactions before the budgets that are compared
    // against them now gets both at once, or neither.
    //
    // The one rule written against a partly-filled state is the balance seeding
    // in utils/accountBalances, which stands the store's own figures in while
    // `transactions.length === 0`. It is unaffected in both directions: the
    // balances are still the parallel read they always were, started before the
    // snapshot below is awaited, and the only sessions that render mid-boot are
    // the ones with no server balances to seed from (the call is guarded on a
    // resolved login).
    const initializeData = async () => {
      setIsLoading(true);
      setSyncError(null);

      // Boot phase timings — one summary line at the end so a slow load can
      // be attributed (auth? accounts? categories? transactions?) from the
      // console of ANY environment, production included.
      //
      // The record is MERGED FROM THREE PLACES now rather than marked off
      // inline: the session's preamble reports its own (`auth`, `services` in a
      // browser; nothing at all on a device, because nothing happened), the
      // boot snapshot reports the store's, and the balances round trip times
      // itself because it runs alongside rather than between.
      const bootStart = performance.now();
      const phases: Record<string, number> = {};
      let serverBalancesLoaded: Promise<void> | null = null;

      try {
        // WHOEVER IS ASKING, ANSWERED BY THE EDITION — one call where seventy
        // lines of Clerk, the id translator, the offline queue and the demo
        // seeder used to be. All four of those are still exactly what happens
        // in a browser (`editions/cloud/session.ts` holds them, in this order,
        // unchanged); on a device the preamble ran when the file was opened and
        // this resolves to an empty report.
        //
        // It is awaited inside the same `try` those lines were inside, and that
        // is load-bearing rather than incidental: an auth service that cannot be
        // reached has always ended this boot with "Failed to load data. Using
        // offline mode." rather than reading the ledger as nobody, and the seam
        // contract states the rule so the next implementation keeps it.
        const preamble = await session.prepare();
        Object.assign(phases, preamble.phases);

        if (preamble.owner) {
          // One round trip for every account's balance, started here and
          // deliberately NOT awaited: the rest of the boot must not wait on
          // it. The transaction pages are ~77% of that boot, and until they
          // land every client-side balance is zero — these figures let the
          // dashboard paint real money in the meantime.
          //
          // It stays OUT of the boot snapshot, which is the same decision said
          // twice: a read whose whole value is arriving before the ledger does
          // cannot be bundled with the ledger.
          //
          // The GUARD is the one thing here that changed meaning, and it changed
          // in the direction the seam was for. It used to read "a resolved
          // login, and nothing else, has server-side balances to ask for", which
          // was true of the two engines that existed. A file has them too — the
          // crate computes `account_balances` in one crossing — and a
          // 50,000-row ledger does not paint instantly merely because it is
          // local. So the question is now the seam's own: did the preamble end
          // with an owner? A browser answers exactly as before.
          const balancesStart = performance.now();
          serverBalancesLoaded = dataPort.getAccountBalances().then(balances => {
            phases.balances = Math.round(performance.now() - balancesStart);
            setServerBalances(balances);
          });
        }


        // ONE crossing for everything the app boots with.
        //
        // Six awaits used to stand here — the accounts, the categories, the
        // transactions, the split lines, and the budgets and goals together —
        // and the ORDER between three of them was a rule this call site was the
        // only place able to keep: categories before transactions (the one-time
        // id migration remaps every reference as it lands), budgets and goals in
        // one Promise.all, and the account read answering all three of the
        // boot's account cases. Those rules now live on the seam, where every
        // implementation is held to them by the same contract tests, and where
        // the local edition can answer the whole question from one transaction
        // against one file instead of crossing a process six times.
        //
        // The account list is no longer read twice, either: the signed-out
        // fallback that used to run below is the same `listAccounts` branch the
        // snapshot already takes.
        const boot = await dataPort.loadBoot();
        // loadBoot never rejects (contract rule 81) — the floor exists for the
        // TRANSIENT case, where an empty register beside a working account list
        // beats a full-page error nobody needed. But when the transaction read
        // failed AND no account came back either, the store itself is refusing:
        // an app rendering nothing at all is a worse lie than an error screen
        // with a Retry that will genuinely help. Both signals are the
        // snapshot's own honest answers, not a rethrow.
        if (boot.transactionStats.fullFetchReason === 'load failed' && boot.accounts.length === 0) {
          setSyncError('Failed to load data. Using offline mode.');
        }
        appLogger.info('Accounts loaded', { count: boot.accounts.length });

        // In the source order the six awaits set them in. React batches these
        // into ONE render where the sequence produced several — the declared
        // change, argued in the note above the effect body.
        setAccounts(boot.accounts);
        setCategories(boot.categories);
        setTransactions(boot.transactions);
        setTransactionsLoadFailed(boot.transactionStats.fullFetchReason === 'load failed');
        setTransactionSplitsState(boot.splits);
        setBudgets(boot.budgets);
        setGoals(boot.goals);
        setCustomReports(boot.customReports);
        // Measured where the work happens. `auth` and `services` above were
        // measured here because they happen here; these five were not.
        Object.assign(phases, boot.phases);

        // The one-time rescue of reports a browser is still holding on its own.
        //
        // AFTER the snapshot has been put into state rather than before, and not
        // awaited by anything the render waits on: it writes rows, so it is the
        // slowest thing in this effect on the single boot where it does any
        // work, and it has nothing to say on every boot afterwards. A person
        // whose ledger is loaded should not be looking at a spinner while their
        // saved questions are filed.
        //
        // It never rejects — `adoptLegacyReports` logs and stops at the first
        // refusal, keeping whatever landed and leaving the rest for the next
        // boot — so there is nothing here to catch. What it answers is the
        // reports it carried THIS call, appended rather than replacing the list,
        // because the snapshot above is the store's own answer and this is what
        // has just been added to it.
        const adopted = await customReportService.adoptLegacyReports();
        if (adopted.length > 0) {
          setCustomReports(prev => [...prev, ...adopted]);
          appLogger.info('Saved reports carried into the store', { count: adopted.length });
        }

        setLastSyncTime(new Date());
        // Settled long ago in practice (it started before the slowest phase) —
        // awaited only so the summary line below can report its timing.
        await serverBalancesLoaded;
        // The numbers live IN the message so any console shows the breakdown
        // without expanding an object — and via console.info directly, because
        // the scoped logger's console bridge is DEV-ONLY and this one line is
        // exactly what a production slowness report needs.
        // The transaction figure must stay honest about WHERE the rows came
        // from: a 200ms boot that hydrated a stale snapshot and a 200ms boot
        // that fetched nothing because nothing changed look identical
        // otherwise, and the next slowness report would start from a lie.
        // The reason is no longer optional-then-defaulted: the seam promises
        // stats on every answer and a stated reason whenever it did not serve a
        // snapshot, so the old `?? 'no cache'` had become a branch that could
        // not be taken. Both SENTENCES are unchanged.
        const txnStats = boot.transactionStats;
        const txnSummary = txnStats.fullFetchReason === null
          ? `${formatCount(txnStats.total)} transactions ` +
            `(${formatCount(txnStats.cached)} from cache + ${formatCount(txnStats.fetched)} delta)`
          : `${formatCount(boot.transactions.length)} transactions ` +
            `(full fetch — ${txnStats.fullFetchReason})`;
        console.info(
          `Boot data load: ${Math.round(performance.now() - bootStart)}ms total — ` +
          Object.entries(phases).map(([name, ms]) => `${name} ${ms}ms`).join(' · ') +
          ` (${txnSummary})`
        );

        // Subscribe to real-time updates — but only where there is something to
        // hear from. `subscribeToUpdates` is safe to call either way (an engine
        // with no other device hands back a no-op unsubscribe), so this gate is
        // not protecting the call: it skips the MACHINERY around it — the
        // debounce timer, the recent-local-write suppression window and the
        // teardown bookkeeping below — all of which exist solely to cope with
        // events that a store with no realtime will never send.
        //
        // It asks the seam what it can do rather than which product it is. The
        // predicate is unchanged (`realtime` is the same "a database id is
        // resolved AND a client is configured" the retired flag answered), but
        // an engine that gains a sync peer without becoming a login can now say
        // so, instead of having to claim it is Supabase to be heard.
        //
        // The second half was `&& user` and is `&& session.present`, which is
        // the same question asked of whoever knows the answer. It is redundant
        // in both editions today — `realtime` already implies a resolved owner
        // in the cloud and is false on a device — and it is kept for the reason
        // it was written: a gate this expensive to be wrong about should not
        // rest on one field's implication.
        if (dataPort.capabilities().realtime && session.present) {
          // Helper function to debounce updates
          const debouncedUpdate = (updateType: string, updateFn: () => Promise<void>) => {
            // Check if this is a duplicate update (within 1 second)
            const now = Date.now();
            if (lastUpdateRef.current && 
                lastUpdateRef.current.type === updateType && 
                now - lastUpdateRef.current.timestamp < 1000) {
              appLogger.debug('Skipping duplicate real-time update', { updateType });
              return;
            }
            
            // Clear any pending debounced update
            if (updateDebounceRef.current) {
              clearTimeout(updateDebounceRef.current);
            }
            
            // Set a new debounced update
            updateDebounceRef.current = setTimeout(async () => {
              lastUpdateRef.current = { type: updateType, timestamp: now };
              await updateFn();
            }, 200); // 200ms debounce
          };
          
          // ONE subscribe call and ONE handle: both channels — accounts and
          // transactions — now come through the same door.
          //
          // The account channel used to be opened through a second service, and
          // that service's version of the same subscription differed in ways
          // that are declared here rather than discovered later:
          //
          //  · the channel is named `accounts:<id>`, not `accounts-<id>`;
          //  · nothing logs the subscribe status any more. The retired call
          //    passed a status callback that logged every transition and every
          //    subscribe error; this one passes none, so a channel that fails to
          //    join now does so silently. That is the one thing this change
          //    costs, and it is a declared cost rather than an oversight;
          //  · the await disappears. The retired call was async because it
          //    resolved the login's database id itself before opening anything;
          //    the seam uses the id the boot already resolved, so the channel
          //    opens synchronously and there is no window between asking for it
          //    and holding its handle;
          //  · its "no database user for this Clerk id" warning goes with it —
          //    behind this gate an id is resolved by definition;
          //  · one registerTeardown instead of two, because there is one handle.
          //
          // What does NOT change: both callbacks below, the debounce above, and
          // the recent-local-write suppression are the code that was already
          // here, in the order it was already in.
          const unsubscribeData = dataPort.subscribeToUpdates({
            onAccountUpdate: async (payload) => {
              const realtimePayload = payload as { eventType: string; new?: { is_active?: boolean } };
              appLogger.debug('Real-time account update received', realtimePayload);
              appLogger.debug('Real-time account update type', { eventType: realtimePayload.eventType });

              // Handle different event types
              if (realtimePayload.eventType === 'UPDATE' && realtimePayload.new && !realtimePayload.new.is_active) {
                appLogger.debug('Real-time account marked inactive');
              }
              
              // Skip real-time reload if we just made a local update (prevents overwriting optimistic state)
              if (Date.now() - recentLocalUpdateRef.current < 2000) {
                appLogger.debug('Skipping real-time account reload (recent local update)');
                return;
              }

              debouncedUpdate('account', async () => {
                appLogger.debug('Reloading accounts after real-time update');
                // Reload accounts when any change happens — through the seam.
                //
                // The same question, asked the same way: the port's cloud branch
                // runs the same SELECT on `accounts` (user_id, is_active, ordered
                // by created_at) through the same mapAccountFromDb, and falls back
                // to the same stored list under the same storage key. What changes
                // is WHOSE id it asks about.
                //
                // The retired call carried this login's Clerk id and re-resolved
                // it to a database id on every event; the port reads the id the
                // boot already resolved. Behind the gate this whole block sits
                // behind — `capabilities().realtime` is exactly "a database id
                // is resolved AND Supabase is configured" — that id is warm, so
                // on the path that matters the two agree.
                //
                // Where they stop agreeing is a DECLARED IMPROVEMENT rather than
                // a preserved behaviour: if the id cache is cleared between the
                // event and this reload (sign-out, or a switch of login), the old
                // call would re-resolve the CAPTURED Clerk id and paint the
                // previous login's accounts onto whatever is on screen now. The
                // port has no captured id to re-resolve — it answers [] while a
                // session is still connecting, and never reaches for another
                // login's rows.
                const updatedAccounts = await dataPort.listAccounts();
                appLogger.debug('Accounts reloaded', { count: updatedAccounts.length });
                setAccounts(updatedAccounts);
                setLastSyncTime(new Date());

                // Also refresh transactions to update account balances
                const updatedTransactions = await dataPort.listTransactions();
                setTransactions(updatedTransactions);

                // Splits ride along — without this, a split edited on another
                // device leaves this device's category views stale.
                try {
                  setTransactionSplitsState(await dataPort.listTransactionSplits());
                } catch (splitError) {
                  appLogger.error('Failed to refresh transaction splits', splitError);
                }
              });
            },
            onTransactionUpdate: async (payload) => {
              appLogger.debug('Transaction update received', payload);
              
              debouncedUpdate('transaction', async () => {
                // Reload transactions when any change happens
                const updatedTransactions = await dataPort.listTransactions();
                setTransactions(updatedTransactions);

                // Splits ride along — without this, a split edited on another
                // device leaves this device's category views stale.
                try {
                  setTransactionSplitsState(await dataPort.listTransactionSplits());
                } catch (splitError) {
                  appLogger.error('Failed to refresh transaction splits', splitError);
                }

                // Also refresh accounts to update balances
                const updatedAccounts = await dataPort.listAccounts();
                setAccounts(updatedAccounts);
                setLastSyncTime(new Date());
              });
            }
          });

          // Handed to the effect rather than returned from here: this function
          // is async, so a returned cleanup only ever reaches a promise. The
          // race it guards is still real even though this handle now arrives
          // synchronously — everything ABOVE it is awaited, so a cleanup can
          // still fire while the boot is in flight, and a handle that lands
          // afterwards is closed on arrival instead of being stored.
          registerTeardown(unsubscribeData);
        }
      } catch (error) {
        appLogger.error('Failed to initialize data', error);
        appLogger.error('Initialization details', {
          message: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined
        });
        setSyncError('Failed to load data. Using offline mode.');
      } finally {
        // ONE re-ask per boot, on every path.
        //
        // In the `finally` rather than beside the other post-load state,
        // because a boot that threw is precisely when getting this wrong is
        // worst: the login is resolved, the data read failed, and the retired
        // flag — which was set only on the success path — left the app
        // describing itself as a device. The Export page then offered "the only
        // copy there is" to somebody whose data was in a database, and the
        // restore dialog aimed at the wrong store.
        setCapabilities(dataPort.capabilities());
        setIsLoading(false);
      }
    };

    void initializeData();

    return () => {
      cancelled = true;
      // Previously unreachable along with the unsubscribes: a pending debounced
      // reload would otherwise fire into a provider that has moved on.
      if (updateDebounceRef.current) {
        clearTimeout(updateDebounceRef.current);
        updateDebounceRef.current = null;
      }
      // Drained rather than iterated in place, so a handle is invoked exactly
      // once whichever side of the race it arrived on.
      const pending = teardowns.splice(0, teardowns.length);
      for (const teardown of pending) {
        teardown();
      }
    };
    // ONE dependency where there were two, and the same dependency.
    //
    // This was `[user, isLoaded]`. Both seam halves memoise their session object
    // on their own edition's version of that pair — the cloud's on `[user,
    // isLoaded]` literally — so this object's identity changes exactly when a
    // person signs in, signs out or changes, and at no other time. The effect
    // re-boots on precisely the events it always did.
  }, [session]);

  const refreshCategories = useCallback(async () => {
    try {
      const loaded = await dataPort.prepareCategories();
      setCategories(loaded);
    } catch (error) {
      appLogger.error('Failed to refresh categories', error);
    }
  }, []);

  // Narrow refresh for the bank-sync path: only accounts + transactions come from
  // Supabase here (listAccounts/listTransactions route to the cloud services), so we
  // never touch budgets/goals/categories which load from a different source.
  const refreshAccountsAndTransactions = useCallback(async () => {
    try {
      const [updatedAccounts, updatedTransactions] = await Promise.all([
        dataPort.listAccounts(),
        dataPort.listTransactions()
      ]);
      setAccounts(updatedAccounts);
      setTransactions(updatedTransactions);
      setLastSyncTime(new Date());
      setSyncError(null);
    } catch (error) {
      appLogger.error('Failed to refresh accounts and transactions', error);
      setSyncError('Failed to refresh account data');
    }
  }, []);

  // Account operations
  const addAccount = useCallback(async (account: Omit<Account, 'id'> & { initialBalance?: number }) => {
    try {
      appLogger.info('Adding account', account);

      const accountToCreate = {
        ...account,
        balance: account.initialBalance || account.balance || 0,
        initialBalance: account.initialBalance || account.balance || 0,
        isActive: account.isActive !== undefined ? account.isActive : true
      };

      // One door, whoever is signed in. This used to fork on the Clerk id —
      // a second account service for signed-in sessions, the seam for everyone
      // else — and the two did not write the same account: the fork's writer
      // sent the sort code, the account number, the opening balance date and
      // the notes, and the seam's did not. Whichever half of that pair a given
      // create happened to take decided whether the bank details the person had
      // just typed existed afterwards. The seam's writer sends all four now, so
      // there is nothing left for the fork to choose between.
      //
      // What the seam resolves for itself is the owner, which is the whole
      // point of it: no id is passed in, and a signed-in session whose database
      // id has not resolved yet is refused by name rather than quietly diverted
      // into browser storage to be lost at the next boot.
      const newAccount = await dataPort.createAccount(accountToCreate);
      appLogger.info('Account created', newAccount);

      // Add to state
      setAccounts(prev => [...prev, newAccount]);
      
      // Don't queue for sync - it's already in the database!
      // AutoSyncService is for offline-created items only
      
      return newAccount;
    } catch (error) {
      appLogger.error('Failed to add account', error);
      throw error;
    }
  }, []);

  const updateAccount = useCallback(async (id: string, updates: AccountUpdate) => {
    try {
      recentLocalUpdateRef.current = Date.now();
      const updatedAccount = await dataPort.updateAccount(id, updates);
      setAccounts(prev => prev.map(a => a.id === id ? updatedAccount : a));
    } catch (error) {
      appLogger.error('Failed to update account', error);
      throw error;
    }
  }, []);

  const closeAccount = useCallback(async (id: string) => {
    try {
      await dataPort.closeAccount(id);
      setAccounts(prev => prev.filter(a => a.id !== id));
      // Also remove related transactions
      setTransactions(prev => prev.filter(t => t.accountId !== id));
    } catch (error) {
      appLogger.error('Failed to close account', error);
      throw error;
    }
  }, []);

  // Transaction operations
  const addTransaction = useCallback(async (transaction: Omit<Transaction, 'id'>) => {
    try {
      const newTransaction = await dataPort.createTransaction(transaction);
      setTransactions(prev => [...prev, newTransaction]);
      
      // Update account balance locally for immediate UI feedback.
      // Decimal arithmetic — float math is banned on money values. The DB
      // balance is adjusted atomically inside create_transaction_atomic.
      setAccounts(prev => prev.map(acc => {
        if (acc.id === transaction.accountId) {
          return {
            ...acc,
            balance: toDecimal(acc.balance || 0).plus(toDecimal(transaction.amount)).toNumber()
          };
        }
        return acc;
      }));
      return newTransaction;
    } catch (error) {
      appLogger.error('Failed to add transaction', error);
      throw error;
    }
  }, []);

  const updateTransaction = useCallback(async (id: string, updates: Partial<Transaction>) => {
    try {
      const oldTransaction = transactions.find(t => t.id === id);
      const updatedTransaction = await dataPort.updateTransaction(id, updates);
      setTransactions(prev => prev.map(t => t.id === id ? updatedTransaction : t));
      
      // Update account balance if amount changed (Decimal arithmetic; the DB
      // balance is adjusted atomically inside update_transaction_atomic).
      if (oldTransaction && updates.amount !== undefined && updates.amount !== oldTransaction.amount) {
        const difference = toDecimal(updates.amount).minus(toDecimal(oldTransaction.amount));
        setAccounts(prev => prev.map(acc => {
          if (acc.id === oldTransaction.accountId) {
            return {
              ...acc,
              balance: toDecimal(acc.balance || 0).plus(difference).toNumber()
            };
          }
          return acc;
        }));
      }
    } catch (error) {
      appLogger.error('Failed to update transaction', error);
      throw error;
    }
  }, [transactions]);

  const setTransactionsCleared = useCallback(async (ids: string[], cleared: boolean) => {
    if (ids.length === 0) {
      return;
    }
    try {
      await dataPort.setTransactionsCleared(ids, cleared);
      const idSet = new Set(ids);
      // reconciledAfterMarking, not a bare `{ cleared }`: the state this mirrors
      // is what the store just wrote, and the store cleared the committed flag
      // on anything unmarked. Leaving it here would show an R against a row
      // that is no longer even ticked, until the next boot disagreed. The
      // review flag is mirrored for the same reason — the store ends review
      // on a filed row it marks (20260911213000), and the counter should say
      // so now.
      setTransactions(prev => prev.map(t => (
        idSet.has(t.id)
          ? { ...t, cleared, reconciled: reconciledAfterMarking(t, cleared), needsReview: reviewAfterMarking(t, cleared) }
          : t
      )));
    } catch (error) {
      appLogger.error('Failed to set cleared status', error);
      throw error;
    }
  }, []);

  /**
   * Finish a reconciliation. The ONE place a transaction becomes reconciled.
   *
   * The optimistic update mirrors the store's own rule exactly: the rows that
   * were marked-and-not-committed for this account become committed, and the
   * account records the day and the figure. Anything else here would make the
   * screen disagree with what was written until the next boot.
   */
  const finalizeReconciliation = useCallback(async (
    accountId: string,
    endingBalance: number,
    reconciledOn: Date
  ): Promise<number> => {
    try {
      const outcome = await dataPort.finalizeReconciliation(accountId, endingBalance, reconciledOn);
      setTransactions(prev => prev.map(t => (
        t.accountId === accountId && isMarkedAwaitingFinalize(t) ? { ...t, reconciled: true } : t
      )));
      setAccounts(prev => prev.map(a => (
        a.id === accountId
          ? { ...a, lastReconciledDate: outcome.reconciledOn, lastReconciledBalance: outcome.endingBalance }
          : a
      )));
      return outcome.reconciled;
    } catch (error) {
      appLogger.error('Failed to finalise reconciliation', error);
      throw error;
    }
  }, []);

  // Soft-archive: hide an account's reconciled transactions on/before the
  // cutoff. Balance-neutral — we only flip the `archived` flag and record the
  // cutoff; every account balance and report stays exact.
  const archiveTransactionsBefore = useCallback(async (accountId: string, cutoff: Date) => {
    try {
      const count = await dataPort.archiveTransactionsBefore(accountId, cutoff);
      setTransactions(prev => prev.map(t =>
        // The committed flag, not the mark — mirrors archive_transactions_before.
        t.accountId === accountId && !t.archived && isReconciled(t) && new Date(t.date) <= cutoff
          ? { ...t, archived: true } : t
      ));
      setAccounts(prev => prev.map(a => (a.id === accountId ? { ...a, archiveThroughDate: cutoff } : a)));
      return count;
    } catch (error) {
      appLogger.error('Failed to archive transactions', error);
      throw error;
    }
  }, []);

  const unarchiveAccount = useCallback(async (accountId: string) => {
    try {
      const count = await dataPort.unarchiveAccount(accountId);
      setTransactions(prev => prev.map(t => (t.accountId === accountId && t.archived ? { ...t, archived: false } : t)));
      setAccounts(prev => prev.map(a => (a.id === accountId ? { ...a, archiveThroughDate: null } : a)));
      return count;
    } catch (error) {
      appLogger.error('Failed to unarchive account', error);
      throw error;
    }
  }, []);

  const applyCategoryToUncategorized = useCallback(async (ids: string[], category: string) => {
    if (ids.length === 0) {
      return 0;
    }
    /**
     * THE ONE GATE EVERY BULK FILING PASSES THROUGH.
     *
     * Four surfaces call this — the review band's inline pickers, Categorise by
     * payee, a report drill-down, and payee memory's fan-out — and the RPC
     * behind it filters only the TARGET ROWS (blank, non-split); it says nothing
     * about the category being applied. So without this, any of the four could
     * stamp "To/From Savings" onto a hundred rows at once, and each of those
     * hundred would become a transfer with no other side: gone from every
     * report, absent from the review band, and still moving the balance.
     *
     * Refused rather than converted, deliberately. Converting would mean
     * creating a hundred counterpart rows in another account — inventing money
     * movements nobody recorded. A transfer needs its target resolved one row
     * at a time, which is what the editor's conversion flow is for.
     *
     * A throw, not a silent skip, because every caller here is a user's own
     * deliberate action and deserves to be told why it did not happen. Payee
     * memory is the exception and stops before it gets here — see
     * usePayeeMemory, which explains why a SUGGESTION says nothing.
     */
    if (categoryIdIsTransferFiling(categories, category)) {
      throw new Error(BULK_TRANSFER_FILING_REFUSAL);
    }
    try {
      const count = await dataPort.applyCategoryToUncategorized(ids, category);
      const idSet = new Set(ids);
      // Mirror the server's fill-blanks semantics locally: only blank,
      // NON-SPLIT rows flip (a split parent's blank category means "split").
      // categoryConfirmed comes along because this is the user's own filing —
      // the same reasoning as the server side (see the RPC and dataService).
      // needsReview ENDS with the filing (owner's ruling, 1 Sep 2026, after a
      // live ledger's "to review" count refused to move under a thousand-row
      // payee filing): answering the question a row was asking IS reviewing
      // it — the confirm path's own principle, now this one's too. See
      // 20260901150000_bulk_filing_ends_review.sql for the ruling it
      // reversed and the backfill that cleared the stranded rows.
      setTransactions(prev => prev.map(t =>
        idSet.has(t.id) && !t.isSplit && (!t.category || t.category.trim() === '')
          ? { ...t, category, categoryConfirmed: true, needsReview: false }
          : t
      ));
      return count;
    } catch (error) {
      appLogger.error('Failed to apply category', error);
      throw error;
    }
  }, [categories]);

  /**
   * The fan-out's own door (11 Sep 2026). The owner confirmed ONE suggestion
   * and watched payee memory file the payee's other rows off the review list
   * unseen — it was travelling through applyCategoryToUncategorized, which
   * vouches. This one writes the guess shape instead, and the state patch
   * mirrors it: category set, categoryConfirmed false, needsReview TRUE —
   * true rather than untouched, because these rows sat in To Review under
   * the unfiled arm, and gaining a category would otherwise lift them off
   * the list at the very moment they acquire something worth checking.
   *
   * The transfer-filing gate is the same as the deliberate verb's, but a
   * SILENT no-op rather than a throw: this is the app's own extrapolation,
   * and an error toast about a bulk write nobody requested would be the app
   * complaining about its own idea (usePayeeMemory already stops it earlier;
   * this is the second layer).
   */
  const suggestCategoryToUncategorized = useCallback(async (ids: string[], category: string) => {
    if (ids.length === 0) {
      return 0;
    }
    if (categoryIdIsTransferFiling(categories, category)) {
      return 0;
    }
    try {
      const count = await dataPort.suggestCategoryToUncategorized(ids, category);
      const idSet = new Set(ids);
      setTransactions(prev => prev.map(t =>
        idSet.has(t.id) && !t.isSplit && (!t.category || t.category.trim() === '')
          ? { ...t, category, categoryConfirmed: false, needsReview: true }
          : t
      ));
      return count;
    } catch (error) {
      appLogger.error('Failed to suggest category', error);
      throw error;
    }
  }, [categories]);

  /**
   * "Yes, that guess was right." Writes two booleans per row and nothing else,
   * so a confirm can never move a balance or a category. Local state mirrors
   * the server's own rule — only rows that were actually suggested flip.
   *
   * needsReview clears with the confirmation: answering the question a row was
   * asking IS reviewing that row, and leaving it bold afterwards would be the
   * register nagging about work already done. Mirrored here as well as in the
   * RPC so the counter and the bold drop on the click rather than on the next
   * refresh.
   */
  const confirmTransactionCategories = useCallback(async (ids: string[]): Promise<number> => {
    if (ids.length === 0) {
      return 0;
    }
    try {
      const count = await dataPort.confirmTransactionCategories(ids);

      // PAINT ONLY WHAT THE SERVER ACTUALLY CONFIRMED.
      //
      // This used to patch every id regardless of the count, so a call that
      // matched NOTHING looked identical to one that matched everything — the
      // rows went un-bold, the pill vanished, and the next read from the store
      // put them straight back. That is the owner's report: confirm on the
      // review page, return to the register, still bold, still "Suggested".
      //
      // A short count is not necessarily a failure — the RPC skips rows it
      // finds already confirmed — but it does mean this client's picture and
      // the store's disagree, and the store is the one that is right. So stop
      // guessing and go and read it.
      if (count === ids.length) {
        const idSet = new Set(ids);
        setTransactions(prev => prev.map(t =>
          idSet.has(t.id) && t.categoryConfirmed === false
            ? { ...t, categoryConfirmed: true, needsReview: false }
            : t
        ));
      } else {
        await refreshAccountsAndTransactions();
      }
      return count;
    } catch (error) {
      appLogger.error('Failed to confirm categories', error);
      throw error;
    }
  }, [refreshAccountsAndTransactions]);

  /**
   * Paint what the ledger actually took, in ONE pass.
   *
   * A per-row state update would re-map a 50k-row array and re-render the app
   * for every transaction written, which is the whole reason both bulk payee
   * writes touch React exactly once at the end.
   */
  const patchDescriptions = useCallback((written: ReadonlyArray<TransactionDescription>): void => {
    if (written.length === 0) return;
    const byId = new Map(written.map(write => [write.id, write.description]));
    setTransactions(prev => prev.map(t => {
      const description = byId.get(t.id);
      return description === undefined ? t : { ...t, description };
    }));
  }, []);

  const renameTransactionDescriptions = useCallback(async (
    ids: string[],
    description: string,
    onProgress?: (done: number) => void
  ): Promise<number> => {
    const newDescription = description.trim();
    if (ids.length === 0 || newDescription === '') {
      return 0;
    }

    const { written, failures } = await writeDescriptions(
      ids.map(id => ({ id, description: newDescription })),
      onProgress
    );
    patchDescriptions(written);

    // Every single write failed: the caller asked for a rename and got none,
    // so it must be able to say so rather than report "0 renamed" as success.
    if (written.length === 0 && failures > 0) {
      throw new Error('No payees could be renamed. Please try again.');
    }

    return written.length;
  }, [patchDescriptions]);

  const restoreTransactionDescriptions = useCallback(async (
    entries: ReadonlyArray<TransactionDescription>,
    onProgress?: (done: number) => void
  ): Promise<number> => {
    if (entries.length === 0) {
      return 0;
    }

    // No trimming and no emptiness check, unlike the rename above: this is not
    // a name somebody typed, it is the wording these rows were carrying a
    // moment ago, and the only faithful thing to do with it is put it back
    // exactly as it was.
    const { written } = await writeDescriptions(entries, onProgress);
    patchDescriptions(written);

    // Deliberately no throw when nothing landed — see the interface. A screen
    // that has already told the user "771 transactions now read <that name>"
    // needs to be able to say how many of them are back, and an exception at
    // this point would leave it unable to say anything true at all.
    return written.length;
  }, [patchDescriptions]);

  const getTransactionSplits = useCallback(async (transactionId: string) => {
    try {
      return await dataPort.listTransactionSplitsFor(transactionId);
    } catch (error) {
      appLogger.error('Failed to load transaction splits', error);
      throw error;
    }
  }, []);

  const setTransactionSplits = useCallback(async (
    transactionId: string,
    splits: TransactionSplitInput[],
    expectedAmount: number | null
  ) => {
    try {
      const oldTransaction = transactions.find(t => t.id === transactionId);
      const result = await dataPort.setTransactionSplits(transactionId, splits, expectedAmount);

      // Keep the aggregation-facing splits state in step. Re-read the rows
      // (rather than synthesising them) so ids match the server's; a failed
      // re-read only staleness-es this transaction's lines until next load.
      try {
        const freshSplits = result.isSplit ? await dataPort.listTransactionSplitsFor(transactionId) : [];
        setTransactionSplitsState(prev => [
          ...prev.filter(s => s.transactionId !== transactionId),
          ...freshSplits,
        ]);
      } catch (splitReadError) {
        appLogger.error('Failed to refresh splits after save', splitReadError);
      }

      // Mirror the atomic server change locally: the flag, the blanked
      // category while split, and the amount the splits sum to. A line that
      // became a transfer leg also put a REAL row in another account — those
      // come back from the database, so they are added as written rather than
      // synthesised here.
      setTransactions(prev => [
        ...prev.map(t =>
          t.id === transactionId
            ? {
                ...t,
                isSplit: result.isSplit,
                amount: result.amount,
                ...(result.isSplit ? { category: '' } : {}),
              }
            : t
        ),
        ...result.counterparts,
      ]);

      // Balances follow the money (Decimal arithmetic; the DB moved them
      // atomically inside the split RPC): the parent's account by whatever the
      // new total changed, each counterpart's account by the row now sitting
      // in it.
      const deltas = new Map<string, DecimalInstance>();
      const owe = (accountId: string, amount: DecimalInstance): void => {
        deltas.set(accountId, (deltas.get(accountId) ?? toDecimal(0)).plus(amount));
      };
      if (oldTransaction && result.amount !== oldTransaction.amount) {
        owe(oldTransaction.accountId, toDecimal(result.amount).minus(toDecimal(oldTransaction.amount)));
      }
      for (const counterpart of result.counterparts) {
        owe(counterpart.accountId, toDecimal(counterpart.amount));
      }
      if (deltas.size > 0) {
        setAccounts(prev => prev.map(acc => {
          const delta = deltas.get(acc.id);
          return delta
            ? { ...acc, balance: toDecimal(acc.balance || 0).plus(delta).toNumber() }
            : acc;
        }));
      }

      return result;
    } catch (error) {
      appLogger.error('Failed to set transaction splits', error);
      throw error;
    }
  }, [transactions]);

  const linkTransferPair = useCallback(async (idA: string, idB: string) => {
    try {
      const result = await dataPort.linkTransferPair(idA, idB);

      /**
       * THE DERIVED RATE, RECORDED HERE AND NOWHERE ELSE.
       *
       * Every link in the product comes through this one function — the
       * register, the quick-edit dock, the sweep, the coherence repair — so
       * this is the only place the stamp cannot be forgotten by a new call
       * site. Deriving it in each caller was the alternative and it is how
       * three of the four end up without it.
       *
       * Nothing is ASKED here, deliberately. Both amounts already existed and
       * their ratio is the rate that was really achieved, spread and fees
       * included. A dialog at this point would invite someone to overwrite a
       * fact with an opinion. `fxForLinkedPair` returns null when the accounts
       * share a currency, and — importantly — when either leg already carries
       * an `fx` record, so the confirmed provenance the creation flow wrote is
       * never downgraded to 'derived'.
       */
      let { a, b } = result;
      const fx = fxForLinkedPair(accountsRef.current, a, b, new Date());
      if (fx) {
        // Written to BOTH legs unchanged: the rate is a property of the
        // CONVERSION, not of either row.
        const metadataA = withFxRecord(a.metadata, fx);
        const metadataB = withFxRecord(b.metadata, fx);
        try {
          await Promise.all([
            dataPort.updateTransaction(a.id, { metadata: metadataA }),
            dataPort.updateTransaction(b.id, { metadata: metadataB }),
          ]);
          a = { ...a, metadata: metadataA };
          b = { ...b, metadata: metadataB };
        } catch (stampError) {
          // The LINK succeeded and is what the user asked for. Losing the
          // provenance stamp costs a figure its receipt, which is worth
          // logging; failing the whole operation over it would unlink two rows
          // the ledger has correctly joined, which is worse.
          appLogger.error('Linked the pair but could not record its rate', stampError);
        }
      }

      // Balance-neutral: both rows existed with these amounts already.
      setTransactions(prev => prev.map(t =>
        t.id === a.id ? a : t.id === b.id ? b : t
      ));
      return { a, b };
    } catch (error) {
      appLogger.error('Failed to link transfer pair', error);
      throw error;
    }
  }, []);

  const linkSplitLineTransfer = useCallback(async (splitId: string, transactionId: string) => {
    try {
      const result = await dataPort.linkSplitLineTransfer(splitId, transactionId);
      // State comes from what the database wrote: linking re-types and
      // re-categorises the row over there, and pins it to the exact line.
      // Balance-neutral — both sides existed with these amounts already.
      setTransactions(prev => prev.map(t => (t.id === result.transaction.id ? result.transaction : t)));
      setTransactionSplitsState(prev => prev.map(s => (s.id === result.split.id ? result.split : s)));
      return result;
    } catch (error) {
      appLogger.error('Failed to link split line transfer', error);
      throw error;
    }
  }, []);

  const unlinkTransfers = useCallback(async (ids: string[]) => {
    try {
      const count = await dataPort.unlinkTransfers(ids);
      // Balance-neutral: only the link goes. The type/category the rows carry
      // stay as they are until the caller re-files them, exactly as the
      // database left them.
      const idSet = new Set(ids);
      setTransactions(prev => prev.map(t => {
        if (!idSet.has(t.id) || t.linkedTransferSplitId || !t.linkedTransferId) return t;
        const { linkedTransferId: _cleared, ...rest } = t;
        return rest;
      }));
      return count;
    } catch (error) {
      appLogger.error('Failed to unlink transfers', error);
      throw error;
    }
  }, []);

  const setTransactionArchived = useCallback(async (id: string, archived: boolean) => {
    try {
      await dataPort.setTransactionArchived(id, archived);
      setTransactions(prev => prev.map(t => (t.id === id ? { ...t, archived } : t)));
    } catch (error) {
      appLogger.error('Failed to archive transaction', error);
      throw error;
    }
  }, []);

  const repairClaimedTransfer = useCallback(async (
    strandedId: string,
    counterpartId: string,
    partnerId: string,
    adjustmentCategoryId: string
  ) => {
    try {
      const result = await dataPort.repairClaimedTransfer(
        strandedId, counterpartId, partnerId, adjustmentCategoryId
      );
      // State comes from the rows the database actually wrote — the repair
      // re-types and re-categorises all three, and guessing at that here is how
      // a register ends up disagreeing with the ledger. Balance-neutral, so no
      // account touched.
      const written = new Map([
        [result.stranded.id, result.stranded],
        [result.counterpart.id, result.counterpart],
        [result.partner.id, result.partner],
      ]);
      setTransactions(prev => prev.map(t => written.get(t.id) ?? t));
    } catch (error) {
      appLogger.error('Failed to repair claimed transfer', error);
      throw error;
    }
  }, []);

  const createTransferCounterpart = useCallback(async (id: string, targetAccountId: string) => {
    try {
      const result = await dataPort.createTransferCounterpart(id, targetAccountId);
      setTransactions(prev => [
        ...prev.map(t => (t.id === result.source.id ? result.source : t)),
        result.counterpart,
      ]);
      // The DB moved the target account's balance atomically; mirror locally
      // (Decimal arithmetic, same as the other write paths).
      setAccounts(prev => prev.map(acc =>
        acc.id === targetAccountId
          ? { ...acc, balance: toDecimal(acc.balance || 0).plus(toDecimal(result.counterpart.amount)).toNumber() }
          : acc
      ));
      return result;
    } catch (error) {
      appLogger.error('Failed to create transfer counterpart', error);
      throw error;
    }
  }, []);

  const repointTransfer = useCallback(async (
    id: string,
    targetAccountId: string,
    disposition: TransferDisplacedDisposition = 'move'
  ) => {
    try {
      const result = await dataPort.repointTransfer(id, targetAccountId, disposition);
      // State comes from the rows the store actually wrote — a re-point re-files
      // BOTH categories, and guessing at that here is how a register ends up
      // disagreeing with the ledger.
      setTransactions(prev => {
        const written = new Map<string, Transaction>([
          [result.source.id, result.source],
          [result.counterpart.id, result.counterpart],
        ]);
        if (result.displaced.kind === 'released') {
          written.set(result.displaced.transaction.id, result.displaced.transaction);
        }
        const removedId = result.displaced.kind === 'deleted' ? result.displaced.id : null;
        const next = prev
          .filter(t => t.id !== removedId)
          .map(t => written.get(t.id) ?? t);
        // A counterpart that was CREATED (release/delete) is not in the list yet.
        return next.some(t => t.id === result.counterpart.id)
          ? next
          : [...next, result.counterpart];
      });

      // Balances, mirrored from what the store did rather than re-derived from
      // the disposition — Decimal arithmetic, same as every other write path.
      // A 'moved' counterpart carries its amount out of one account and into
      // the other; a 'released' one does not move at all, so only the account
      // receiving the fresh counterpart changes.
      const deltas = new Map<string, DecimalInstance>();
      const add = (accountId: string, delta: DecimalInstance): void => {
        if (!accountId) return;
        deltas.set(accountId, (deltas.get(accountId) ?? toDecimal(0)).plus(delta));
      };
      const counterpartAmount = toDecimal(result.counterpart.amount);
      if (result.displaced.kind === 'moved') {
        if (result.displaced.fromAccountId !== result.counterpart.accountId) {
          add(result.displaced.fromAccountId, counterpartAmount.negated());
          add(result.counterpart.accountId, counterpartAmount);
        }
      } else {
        add(result.counterpart.accountId, counterpartAmount);
        if (result.displaced.kind === 'deleted') {
          add(result.displaced.accountId, toDecimal(result.displaced.amount).negated());
        }
      }
      if (deltas.size > 0) {
        setAccounts(prev => prev.map(acc => {
          const delta = deltas.get(acc.id);
          return delta
            ? { ...acc, balance: toDecimal(acc.balance || 0).plus(delta).toNumber() }
            : acc;
        }));
      }
      return result;
    } catch (error) {
      appLogger.error('Failed to repoint transfer', error);
      throw error;
    }
  }, []);

  const refreshSuggestionDismissals = useCallback(async () => {
    setSuggestionDismissalsStatus('loading');
    try {
      setSuggestionDismissals(await dataPort.listSuggestionDismissals());
      setSuggestionDismissalsStatus('ready');
    } catch (error) {
      // Never thrown on: a sweep that cannot read the dismissals still has to
      // open. It shows everything and says the filter did not run — which is
      // the safe direction to fail in, since a dismissal can only hide.
      appLogger.error('Failed to load suggestion dismissals', error);
      setSuggestionDismissals([]);
      setSuggestionDismissalsStatus('error');
    }
  }, []);

  const dismissSuggestion = useCallback(async (
    kind: DismissalKind,
    subjectKey: string,
    subjectIds: string[]
  ) => {
    try {
      const dismissal = await dataPort.dismissSuggestion(kind, subjectKey, subjectIds);
      // Keyed by (kind, subjectKey), exactly as the table's unique constraint
      // is, so a repeat refusal replaces rather than duplicates.
      setSuggestionDismissals(prev => [
        dismissal,
        ...prev.filter(d => !(d.kind === kind && d.subjectKey === subjectKey)),
      ]);
    } catch (error) {
      appLogger.error('Failed to dismiss suggestion', error);
      throw error;
    }
  }, []);

  const restoreSuggestion = useCallback(async (kind: DismissalKind, subjectKey: string) => {
    try {
      await dataPort.restoreSuggestion(kind, subjectKey);
      setSuggestionDismissals(prev =>
        prev.filter(d => !(d.kind === kind && d.subjectKey === subjectKey))
      );
    } catch (error) {
      appLogger.error('Failed to restore dismissed suggestion', error);
      throw error;
    }
  }, []);

  /**
   * Delete one row, and answer for whatever it was half of.
   *
   * THE ONE PLACE THE SURVIVOR RELEASE IS APPLIED. Every delete in the app
   * arrives here — the register's single delete and its bulk delete, the
   * phone's swipe, the global transactions list, the full editor, the duplicate
   * sweep — and `dataPort.deleteTransaction` has exactly one caller, this
   * function, so no path can forget the rule by taking a different route.
   *
   * Why above the seam rather than inside it: releasing a survivor is a
   * statement about what the app's data MEANS (utils/transferSurvivorRelease.ts
   * holds it, with the measurements), not about how one store keeps it. Put in
   * the port it would have to be written three times — cloud, browser storage,
   * local core — and could drift; put here it is one rule, and the cloud path
   * gets it as a second audited write rather than as a migration nobody asked
   * for.
   */
  const deleteTransaction = useCallback(async (id: string): Promise<DeleteTransactionOutcome> => {
    try {
      const transaction = transactions.find(t => t.id === id);
      // Read BEFORE the delete: afterwards the store has already nulled the
      // link and there is nothing left to find them by.
      const survivors = survivorsOfDeletedLeg(id, transactions);
      await dataPort.deleteTransaction(id);
      setTransactions(prev => prev
        .filter(t => t.id !== id)
        // THE SURVIVOR IS UNLINKED, and this line is what makes that visible
        // before the next boot. The store has already done it — the cloud via
        // transactions_linked_transfer_id_fkey (ON DELETE SET NULL), browser
        // storage by hand — but state kept the dangling pointer, and every
        // screen reads state. That is the whole of the bug the owner hit:
        // deleting a transfer's other half left the survivor still LOOKING
        // linked, so the editor went on refusing to move it ("delete the
        // transfer and recreate it") and the register went on offering to jump
        // to a transaction that no longer existed. The only exit anybody found
        // was to delete the survivor too.
        //
        // Unlinking is all the STORE does. The release below finishes the job:
        // a row that has lost its other side stops being a transfer, because a
        // transfer must have another side or it is not one.
        .map(t => {
          if (t.linkedTransferId !== id) return t;
          const { linkedTransferId: _dangling, ...rest } = t;
          return rest;
        })
      );
      // Its split lines cascade away in the DB (FK); mirror locally.
      setTransactionSplitsState(prev => prev.filter(s => s.transactionId !== id));
      // So do any dismissals that named it (trg_prune_suggestion_dismissals):
      // the suggestion can never be offered again, so the refusal is spent.
      setSuggestionDismissals(prev => prev.filter(d => !d.subjectIds.includes(id)));

      // Update account balance (Decimal arithmetic; the DB balance is reversed
      // atomically inside delete_transaction_atomic).
      if (transaction) {
        setAccounts(prev => prev.map(acc => {
          if (acc.id === transaction.accountId) {
            return {
              ...acc,
              balance: toDecimal(acc.balance || 0).minus(toDecimal(transaction.amount)).toNumber()
            };
          }
          return acc;
        }));
      }

      // ── The release ────────────────────────────────────────────────────────
      // AFTER the delete, never before: released first and then a failed delete
      // would leave a live transfer whose two sides no longer agree, which is a
      // worse lie than a survivor that is briefly still typed as a transfer. A
      // release that fails leaves exactly the state the app had before this
      // rule existed — unlinked, still typed transfer — which the editor names
      // ("no other side recorded") and this function reports as unreleased so
      // the caller can too. Balance-neutral by construction: not one of the five
      // fields is an amount, so nothing here can move money.
      const outcomes: TransferSurvivorOutcome[] = [];
      for (const survivor of survivors) {
        try {
          await updateTransaction(survivor.id, releaseUpdatesFor(survivor));
          outcomes.push({ transactionId: survivor.id, accountId: survivor.accountId, released: true });
        } catch (error) {
          appLogger.error('Deleted a transfer leg but could not release its survivor', error);
          outcomes.push({ transactionId: survivor.id, accountId: survivor.accountId, released: false });
        }
      }
      return { survivors: outcomes };
    } catch (error) {
      appLogger.error('Failed to delete transaction', error);
      throw error;
    }
  }, [transactions, updateTransaction]);

  // Budget operations — persisted through the seam, which resolves the owner
  // itself (the id used to be resolved here and handed over; a null one wrote
  // browser storage under a signed-in session, and the budget was gone at the
  // next boot).
  const addBudget = useCallback(async (budget: Omit<Budget, 'id' | 'spent'>) => {
    try {
      const created = await dataPort.createBudget(budget);
      setBudgets(prev => [...prev, created]);
    } catch (error) {
      appLogger.error('Failed to add budget', error);
      throw error;
    }
  }, []);

  const updateBudget = useCallback(async (id: string, updates: Partial<Budget>) => {
    try {
      const updated = await dataPort.updateBudget(id, updates);
      setBudgets(prev => prev.map(b => b.id === id ? updated : b));
    } catch (error) {
      appLogger.error('Failed to update budget', error);
      throw error;
    }
  }, []);

  const deleteBudget = useCallback(async (id: string) => {
    try {
      await dataPort.deleteBudget(id);
      setBudgets(prev => prev.filter(b => b.id !== id));
    } catch (error) {
      appLogger.error('Failed to delete budget', error);
      throw error;
    }
  }, []);

  // Custom report operations — persisted through the seam, which resolves the
  // owner itself, for the reason written over the budget operations above.
  //
  // They go through `customReportService` rather than straight to `dataPort`,
  // unlike every other family here, and the reason is that the service is where
  // a report's OTHER half lives: the generators that turn a definition into
  // charts and tables. One door for both halves means the reports page imports
  // one thing, and it is what keeps the adoption's `createCustomReport` and an
  // ordinary save on the same path — a rescue that went through a different door
  // from the feature is a rescue nothing exercises.
  const saveCustomReport = useCallback(async (report: CustomReport) => {
    try {
      // A BLANK ID MEANS "NEW", and it is the convention the reports page
      // already used for its three Quick Start templates — they have always
      // been built with `id: ''`. The builder now hands back the same thing for
      // a report typed from scratch, instead of minting `report-${Date.now()}`:
      // that id is not a uuid, the cloud's column is, and an id the store cannot
      // keep is worse than no id at all.
      if (report.id !== '') {
        // `updatedAt` is deliberately not sent. An edit happens now, so the
        // store's own clock is the honest answer, and passing the copy this
        // page is holding would freeze the timestamp at whatever it last read.
        const updated = await customReportService.updateCustomReport(report.id, {
          name: report.name,
          description: report.description,
          components: report.components,
          filters: report.filters
        });
        setCustomReports(prev => prev.map(existing => existing.id === report.id ? updated : existing));
        return updated;
      }

      // Spelled out rather than spread-minus-id, so that a field added to
      // `CustomReport` has to be considered here instead of arriving silently.
      const created = await customReportService.createCustomReport({
        name: report.name,
        description: report.description,
        components: report.components,
        filters: report.filters,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt
      });
      setCustomReports(prev => [...prev, created]);
      return created;
    } catch (error) {
      appLogger.error('Failed to save custom report', error);
      throw error;
    }
  }, []);

  const deleteCustomReport = useCallback(async (id: string) => {
    try {
      await customReportService.deleteCustomReport(id);
      setCustomReports(prev => prev.filter(report => report.id !== id));
    } catch (error) {
      appLogger.error('Failed to delete custom report', error);
      throw error;
    }
  }, []);

  // Category operations — persisted through the seam, which resolves the owner
  // itself (Supabase when signed in, encrypted localStorage otherwise).
  const addCategory = useCallback(async (category: Omit<Category, 'id'>) => {
    try {
      const created = await dataPort.createCategory(category);
      setCategories(prev => [...prev, created]);
      return created;
    } catch (error) {
      appLogger.error('Failed to add category', error);
      throw error;
    }
  }, []);

  // Import a Money-style two-level tree (sub → detail), merging idempotently:
  // same-named categories are skipped, so re-running or overlapping the default
  // set never duplicates. Two phases because details need their sub's id.
  //
  // THE OWNER IS NOW RESOLVED PER CALL, not once for the whole import. This
  // function used to read the database id at the top and hand the same value to
  // all four writes; through the seam each one resolves the owner on its own
  // tick, which is a real difference in one case: a session that ends midway —
  // a sign-out in another tab, a token that expired between the groups insert
  // and the details insert. The old shape carried on writing under the id it
  // captured, into a login that is no longer signed in. The new one resolves
  // nothing, and the pending-session guard refuses the rest of the import
  // outright — which is the answer this import wants: half a tree in the right
  // account beats a whole one in the wrong.
  const importCategoryTree = useCallback(async (
    tree: CategoryTreeGroup[],
    options?: { pruneOthers?: boolean }
  ) => {
    const plan = planCategoryTreeImport(categories, tree);

    const createdSubs = await dataPort.createCategories(plan.subsToCreate);
    // Commit phase 1 to state immediately: if the details insert below fails,
    // a retry re-plans against state that INCLUDES these subs and skips them —
    // otherwise the re-insert would hit the (user_id, name, parent_id) unique
    // constraint and every retry would fail until a page reload.
    if (createdSubs.length > 0) {
      setCategories(prev => [...prev, ...createdSubs]);
    }

    // Resolve each detail's parent among existing + freshly created subs.
    // IMPORTANT: index by the ANCHOR the sub lives under (same predicate the
    // planner matches with), not by the sub's own `type` — a sub that ended up
    // typed 'both' would otherwise be matched by the planner but missing here.
    const typeAnchorIds = new Map<'income' | 'expense', string | undefined>([
      ['income', categories.find(c => c.level === 'type' && c.type === 'income')?.id],
      ['expense', categories.find(c => c.level === 'type' && c.type === 'expense')?.id],
    ]);
    const subIdByKey = new Map<string, string>();
    const keyOf = (type: 'income' | 'expense', name: string) => `${type}:${name.trim().toLowerCase()}`;
    for (const sub of [...categories, ...createdSubs]) {
      if (sub.level !== 'sub') continue;
      if (sub.parentId === typeAnchorIds.get('income')) {
        subIdByKey.set(keyOf('income', sub.name), sub.id);
      } else if (sub.parentId === typeAnchorIds.get('expense')) {
        subIdByKey.set(keyOf('expense', sub.name), sub.id);
      }
    }

    const detailRows: Array<Omit<Category, 'id'>> = [];
    for (const detail of plan.detailsToCreate) {
      const parentId = subIdByKey.get(keyOf(detail.type, detail.subName));
      if (!parentId) {
        throw new Error(`Import failed: parent category "${detail.subName}" was not created.`);
      }
      detailRows.push({ ...detail.category, parentId });
    }
    const createdDetails = await dataPort.createCategories(detailRows);
    if (createdDetails.length > 0) {
      setCategories(prev => [...prev, ...createdDetails]);
    }

    // Optional replace semantics: remove unused categories OUTSIDE the tree so
    // the user's list becomes the imported set. Anything a transaction still
    // references is kept (never orphan a transaction's category).
    let pruned = 0;
    let keptForTransactions = 0;
    if (options?.pruneOthers) {
      const merged = [...categories, ...createdSubs, ...createdDetails];
      // "In use" covers every reference kind: transactions, budgets (keyed by
      // categoryId), and recurring transaction templates.
      const usedCategoryIds = new Set(
        [
          ...transactions.map(t => t.category),
          ...budgets.map(b => b.categoryId),
          ...recurringTransactions.map(r => r.category),
        ].filter((c): c is string => !!c && c.trim() !== '')
      );
      const prunePlan = planCategoryPrune(merged, tree, usedCategoryIds);
      const idsToDelete = [...prunePlan.detailIdsToDelete, ...prunePlan.subIdsToDelete];
      if (idsToDelete.length > 0) {
        // The store re-verifies references server-side and may delete FEWER rows
        // than planned (a stale snapshot can never destroy referenced data) —
        // so re-read the authoritative category set instead of trusting the plan.
        pruned = await dataPort.deleteUnusedCategories(idsToDelete);
        const authoritative = await dataPort.prepareCategories();
        setCategories(authoritative);
      }
      keptForTransactions = prunePlan.keptForTransactionsCount;
    }

    return {
      created: createdSubs.length + createdDetails.length,
      skipped: plan.skippedCount,
      pruned,
      keptForTransactions,
    };
  }, [categories, transactions, budgets, recurringTransactions]);

  const updateCategory = useCallback(async (id: string, updates: Partial<Category>) => {
    try {
      const updated = await dataPort.updateCategory(id, updates);
      setCategories(prev => prev.map(c => c.id === id ? updated : c));
    } catch (error) {
      appLogger.error('Failed to update category', error);
      throw error;
    }
  }, []);

  const mergeCategories = useCallback(async (sourceId: string, targetId: string) => {
    try {
      const result = await dataPort.mergeCategories(sourceId, targetId);

      // Mirror exactly what the merge moved. Balance-neutral throughout: not
      // one amount, sign or account changes, so no account is touched.
      setTransactions(prev => prev.map(t =>
        t.category === sourceId ? { ...t, category: targetId } : t
      ));
      setTransactionSplitsState(prev => prev.map(s =>
        s.category === sourceId ? { ...s, category: targetId } : s
      ));
      setBudgets(prev => prev.map(b =>
        b.categoryId === sourceId ? { ...b, categoryId: targetId } : b
      ));
      setRecurringTransactions(prev => prev.map(r =>
        r.category === sourceId ? { ...r, category: targetId } : r
      ));
      setCategories(prev => prev.filter(c => c.id !== sourceId));

      // Import rules are the one place a category id is stored in THIS browser
      // rather than the database, so they cannot join the merge's transaction —
      // they follow it immediately instead. Loaded on demand so the rules
      // engine stays out of the boot bundle. A failure here costs a stale rule,
      // never the merge: the history is already joined and correct.
      try {
        const { importRulesService } = await import('../services/importRulesService');
        importRulesService.remapCategory(sourceId, targetId);
      } catch (rulesError) {
        appLogger.error('Failed to re-point import rules after a category merge', rulesError);
      }

      return result;
    } catch (error) {
      appLogger.error('Failed to merge categories', error);
      throw error;
    }
  }, []);

  const deleteCategory = useCallback(async (id: string) => {
    try {
      await dataPort.deleteCategory(id);
      // Children go with the parent (cloud FK is ON DELETE CASCADE; mirror it)
      setCategories(prev => prev.filter(c => c.id !== id && c.parentId !== id));
    } catch (error) {
      appLogger.error('Failed to delete category', error);
      throw error;
    }
  }, []);

  const getSubCategories = useCallback((parentId: string) => {
    return categories.filter(c => c.parentId === parentId);
  }, [categories]);

  const getDetailCategories = useCallback((parentId: string) => {
    return categories.filter(c => c.parentId === parentId);
  }, [categories]);

  // Tag operations
  const addTag = useCallback((tag: Omit<Tag, 'id' | 'createdAt' | 'updatedAt'>) => {
    const newTag: Tag = {
      ...tag,
      id: crypto.randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date()
    };
    setTags(prev => [...prev, newTag]);
  }, []);

  const updateTag = useCallback((id: string, updates: Partial<Tag>) => {
    setTags(prev => prev.map(t => 
      t.id === id ? { ...t, ...updates, updatedAt: new Date() } : t
    ));
  }, []);

  const deleteTag = useCallback((id: string) => {
    setTags(prev => prev.filter(t => t.id !== id));
  }, []);

  const getTagUsageCount = useCallback((tagName: string) => {
    return transactions.filter(t => t.tags?.includes(tagName) ?? false).length;
  }, [transactions]);

  const getAllUsedTags = useCallback(() => {
    const tagSet = new Set<string>();
    transactions.forEach(t => {
      if (t.tags) {
        t.tags.forEach(tag => tagSet.add(tag));
      }
    });
    return Array.from(tagSet);
  }, [transactions]);

  // Import/Export operations
  const importData = useCallback((data: Partial<AppState>) => {
    if (data.accounts) setAccounts(data.accounts);
    // A restored backup arrives via JSON.parse, so every `date` is the string
    // it was serialised to — the last way rows can enter state still stringly.
    if (data.transactions) setTransactions(normalizeTransactionDates(data.transactions));
    if (data.budgets) setBudgets(data.budgets);
    if (data.goals) setGoals(data.goals);
    if (data.categories) setCategories(data.categories);
    if (data.tags) setTags(data.tags);
    if (data.recurringTransactions) setRecurringTransactions(data.recurringTransactions);
  }, []);

  /**
   * The snapshot the Money migration offers to download before it replaces
   * everything. Data only.
   *
   * DECLARED FORMAT CHANGE: two keys have gone from the file — `isSyncing`,
   * which was always false, and `isUsingSupabase`, which was hardcoded TRUE and
   * therefore a lie in every browser-storage session that ever downloaded one.
   * Neither described the data beside it, and `importData` reads neither (it
   * takes accounts, transactions, budgets, goals, categories, tags and
   * recurring templates and ignores the rest), so an older file with the keys
   * still restores exactly as it did. What is gone is a file claiming to know
   * where its rows came from while getting it wrong.
   *
   * `isLoading: false` stays: it is honest — a snapshot is by definition taken
   * once the data is loaded — and it is part of the shape older tooling reads.
   */
  const exportData = useCallback((): string => {
    const data = {
      accounts,
      transactions,
      budgets,
      goals,
      categories,
      tags,
      recurringTransactions,
      isLoading: false
    };
    return JSON.stringify(data, null, 2);
  }, [accounts, transactions, budgets, goals, categories, tags, recurringTransactions]);

  const getDecimalTransactions = useCallback((): DecimalTransaction[] => {
    // Convert all transactions to decimal format for precise calculations
    return transactions.map(toDecimalTransaction);
  }, [transactions]);

  const getDecimalAccounts = useCallback((): DecimalAccount[] => {
    // Convert all accounts to decimal format for precise calculations
    return accounts.map(toDecimalAccount);
  }, [accounts]);

  /**
   * Forget what this session has loaded — the React state, and only that.
   *
   * Named for what it does: it deletes NOTHING from any store, so on its own the
   * next load brings everything straight back. The delete has to happen in the
   * store first; this then stops the stale snapshot outliving it.
   *
   * IT USED TO CLEAR THE CLOUD'S BOOT CACHE TOO, and that line is now inside
   * `DataService.wipeAllFinancialData`, where the cache belongs. It was the last
   * thing in this file that named one engine's private store: the cache is
   * IndexedDB, so a desktop bundle carried `indexedDBService` — and failed the
   * bundle grep for the browser storage this edition must not have — because a
   * shared provider imported the cloud's cache in order to empty it. Every
   * caller already wiped through the seam immediately before calling this, in
   * that order, so nothing about the behaviour changed.
   */
  const resetLoadedData = useCallback(async () => {
    setAccounts([]);
    setTransactions([]);
    setBudgets([]);
    setGoals([]);
    setCategories(getDefaultCategories());
    setTags([]);
    setRecurringTransactions([]);
  }, []);

  /**
   * Create the sample dataset in this login.
   *
   * Every row goes through the ordinary context operation for its kind —
   * addCategory, addAccount, addTransaction, addBudget — so a seeded
   * account is written, audited and balanced exactly like one the user typed
   * in, and it works the same in a cloud login as in demo mode because those
   * operations already know which store they are talking to. Nothing here
   * writes to localStorage on its own; that was the bug the demo seed had.
   *
   * The writes are awaited one at a time rather than fired off in parallel.
   * They are not independent: a transaction needs its account's id and its
   * category's id to exist first, and each transaction's balance adjustment is
   * a read-modify-write on the same account row. Firing N of those at once is
   * how balances drift.
   *
   * ADDS, never replaces: there is no delete or overwrite in this function. A
   * category the login already has is reused by name, not duplicated; accounts
   * and transactions are always new rows alongside whatever is there.
   */
  const loadTestData = useCallback(async (
    onProgress?: (progress: TestDataProgress) => void
  ): Promise<TestDataSeedResult> => {
    const dataset = buildTestDataset();
    const report = (phase: TestDataPhase, fraction: number, message: string): void => {
      onProgress?.({ phase, fraction, message });
    };

    // 1. Categories. A transaction filed under a category id this login does
    // not have is invisible in every category view, so the ids are resolved
    // against the login's OWN categories first and anything missing is created
    // before a single transaction is written. A freshly cleared login can be
    // missing even the type-level anchors; the plan creates those too.
    report('categories', 0, 'Checking categories…');
    const plan = planTestDataCategories(dataset.categories, categories);
    const categoryIdByName = new Map<string, string>(plan.resolved);
    for (const [index, planned] of plan.toCreate.entries()) {
      const parentId = planned.parentKey
        ? categoryIdByName.get(planned.parentKey)
        : planned.category.parentId;
      const created = await addCategory({ ...planned.category, parentId });
      categoryIdByName.set(planned.key, created.id);
      report('categories', 0.1 * ((index + 1) / plan.toCreate.length),
        `Adding categories… ${index + 1} of ${plan.toCreate.length}`);
    }

    // 2. Accounts, each opened at the balance that makes its closing balance
    // come out right once step 3 has run (see buildTestDataset).
    const accountIdByKey = new Map<string, string>();
    for (const [index, account] of dataset.accounts.entries()) {
      report('accounts', 0.1 + 0.1 * (index / dataset.accounts.length),
        `Creating accounts… ${index + 1} of ${dataset.accounts.length}`);
      const created = await addAccount({
        name: account.name,
        type: account.type,
        balance: account.openingBalance,
        initialBalance: account.openingBalance,
        openingBalance: account.openingBalance,
        currency: account.currency,
        institution: account.institution,
        accountNumber: account.accountNumber,
        isActive: true,
        lastUpdated: new Date()
      });
      accountIdByKey.set(account.key, created.id);
    }

    // 3. Transactions. Each one moves its account's balance through the same
    // atomic path a hand-typed transaction takes.
    let transactionsCreated = 0;
    for (const [index, transaction] of dataset.transactions.entries()) {
      const accountId = accountIdByKey.get(transaction.accountKey);
      const category = categoryIdByName.get(transaction.categoryName.toLowerCase());
      if (!accountId || !category) {
        // Unreachable given steps 1 and 2, and left as a throw rather than a
        // skip: a silently short seed is the failure this whole feature exists
        // to stop repeating.
        throw new Error(`Sample transaction "${transaction.description}" has no account or category to file under`);
      }
      await addTransaction({
        date: transaction.date,
        description: transaction.description,
        amount: transaction.amount,
        category,
        accountId,
        type: transaction.type,
        tags: transaction.tags,
        notes: transaction.notes
      });
      transactionsCreated += 1;
      report('transactions', 0.2 + 0.6 * ((index + 1) / dataset.transactions.length),
        `Adding transactions… ${index + 1} of ${dataset.transactions.length}`);
    }

    // 4. Budgets, filed against the same resolved category ids.
    let budgetsCreated = 0;
    for (const [index, budget] of dataset.budgets.entries()) {
      const categoryId = categoryIdByName.get(budget.categoryName.toLowerCase());
      if (!categoryId) {
        throw new Error(`Sample budget "${budget.name}" has no category to file under`);
      }
      await addBudget({
        name: budget.name,
        categoryId,
        amount: budget.amount,
        period: budget.period,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });
      budgetsCreated += 1;
      report('budgets', 0.8 + 0.05 * ((index + 1) / dataset.budgets.length),
        `Adding budgets… ${index + 1} of ${dataset.budgets.length}`);
    }


    // 6. Re-read what was actually stored. The optimistic updates each
    // operation made are correct, but re-reading is what proves it: the
    // balances now on screen are the ones the database computed, not the ones
    // this function predicted.
    report('refreshing', 0.9, 'Reloading your data…');
    await refreshAccountsAndTransactions();
    if (plan.toCreate.length > 0) {
      await refreshCategories();
    }
    const [reloadedBudgets, reloadedGoals] = await Promise.all([
      dataPort.listBudgets(),
      dataPort.listGoals()
    ]);
    setBudgets(reloadedBudgets);
    setGoals(reloadedGoals);
    report('refreshing', 1, 'Done.');

    const result: TestDataSeedResult = {
      categoriesCreated: plan.toCreate.length,
      accounts: accountIdByKey.size,
      transactions: transactionsCreated,
      budgets: budgetsCreated,
    };
    appLogger.info('Test data loaded', result);
    return result;
  }, [categories, addCategory, addAccount, addTransaction, addBudget,
    refreshAccountsAndTransactions, refreshCategories]);

  const value: AppContextType = {
    // State
    accounts,
    transactions,
    budgets,
    // Still here because AppState declares it and the boot payload fills it.
    // Inert: nothing can create, edit or delete one any more.
    goals,
    customReports,
    categories,
    tags,
    recurringTransactions,

    // Account operations
    addAccount,
    updateAccount,
    closeAccount,
    
    // Transaction operations
    addTransaction,
    updateTransaction,
    deleteTransaction,
    setTransactionsCleared,
    finalizeReconciliation,
    applyCategoryToUncategorized,
    suggestCategoryToUncategorized,
    confirmTransactionCategories,
    renameTransactionDescriptions,
    restoreTransactionDescriptions,
    archiveTransactionsBefore,
    unarchiveAccount,
    transactionSplits,
    serverBalances,
    getTransactionSplits,
    setTransactionSplits,
    linkTransferPair,
    linkSplitLineTransfer,
    unlinkTransfers,
    setTransactionArchived,
    repairClaimedTransfer,
    createTransferCounterpart,
    repointTransfer,

    // Sweep suggestions the user has refused for good
    suggestionDismissals,
    suggestionDismissalsStatus,
    refreshSuggestionDismissals,
    dismissSuggestion,
    restoreSuggestion,

    // Budget operations
    addBudget,
    updateBudget,
    deleteBudget,
    
    // Goal operations

    // Custom report operations — ONE save rather than an add/update pair,
    // because the builder has one button and the id is what says which happened.
    saveCustomReport,
    deleteCustomReport,

    // Category operations
    addCategory,
    importCategoryTree,
    updateCategory,
    deleteCategory,
    mergeCategories,
    getSubCategories,
    getDetailCategories,
    
    // Tag operations
    addTag,
    updateTag,
    deleteTag,
    getTagUsageCount,
    getAllUsedTags,
    
    // Other operations
    importData,
    exportData,
    resetLoadedData,
    getDecimalTransactions,
    getDecimalAccounts,
    
    // Sync status
    isLoading,
    lastSyncTime,
    syncError,
    transactionsLoadFailed,
    capabilities,
    refreshAccountsAndTransactions,
    refreshCategories,
    loadTestData
  };

  // The value object is always defined, no need to check

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    appLogger.error('useApp called outside of AppProvider');
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
