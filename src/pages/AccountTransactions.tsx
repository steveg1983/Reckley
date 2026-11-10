import React, { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback, useId, Suspense } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
// Through `@identity`, not through Clerk. The only thing the register wanted a
// session for is a KEY to namespace a stored setting by — see
// src/editions/identity.ts, and the same change in ImprovedDashboard.
import { useIdentityKey } from '@identity';
import { useApp } from '../contexts/AppContextSupabase';
import { parseMoneyInput, toDecimal } from '../utils/decimal';
import type { DecimalInstance } from '../utils/decimal';
import { isReconciled } from '../utils/transactionReconciliation';
import { preserveDemoParam } from '../utils/navigation';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import { ArrowLeftIcon, SearchIcon, PlusIcon, CalendarIcon, XIcon, SettingsIcon, FilterIcon, ChevronUpIcon, ChevronDownIcon, MaximizeIcon, MinimizeIcon, EyeIcon, KeyboardIcon, AlertCircleIcon } from '../components/icons';
import StatPill from '../components/common/StatPill';
import DatePicker from '../components/common/DatePicker';
import MoneyInput from '../components/common/MoneyInput';
import EditTransactionModal from '../components/EditTransactionModal';
import DeleteTransactionConfirm from '../components/DeleteTransactionConfirm';
import BulkDeleteTransactionsConfirm from '../components/BulkDeleteTransactionsConfirm';
import RegisterSelectionBar from '../components/RegisterSelectionBar';
import RegisterShortcutsDialog from '../components/RegisterShortcutsDialog';
import AccountSettingsModal from '../components/AccountSettingsModal';
import { accountHasHistory } from '../utils/accountHistory';
import {
  QuickEditRowProvider,
  QuickEditFieldCell,
  QuickEditActionStrip,
  QUICK_EDIT_ROW_HEIGHT,
  QUICK_EDIT_STRIP_HEIGHT,
  type QuickEditField,
  type QuickEditFocusRequest,
} from '../components/QuickEditRow';
import { isInsideQuickEdit } from '../utils/quickEditScope';
import SuggestedCategoryBadge from '../components/SuggestedCategoryBadge';
import CategorySelector from '../components/CategorySelector';
import PageTip from '../components/PageTip';
import { usePreferences } from '../contexts/PreferencesContext';
import { useToast } from '../contexts/ToastContext';
import { VirtualizedTable, type Column, type RowDetail } from '../components/VirtualizedTable';
import { InfiniteScrollTransactionList } from '../components/InfiniteScrollTransactionList';
import MobileQuickEditCard from '../components/MobileQuickEditCard';
import { useIsMobileViewport } from '../hooks/useMediaQuery';
import { TableSkeleton } from '../components/loading/TableSkeleton';
import { useDelayedFlag } from '../hooks/useDelayedFlag';
import { usePendingAtBank } from '../hooks/usePendingAtBank';
import PendingAtBankList from '../components/banking/PendingAtBankList';
import EmptyState from '../components/EmptyState';
import FilteredEmptyState from '../components/FilteredEmptyState';
import { compareChronological, compareTransactions, type TransactionSortField } from '../utils/transactionSort';
import { createCategoryLabeller } from '../utils/categoryLabel';
import { orderColumnKeys, moveColumnKey } from '../utils/columnLayout';
import { computeArchiveWindow, ARCHIVE_PRESETS, type ArchiveRange } from '../utils/archiveRange';
import { effectiveOpeningDate, findSiblingAccount } from '../utils/openingDates';
import { describeDeleteStranding, resolveTransferOtherSide } from '../utils/transferOtherSide';
import { deleteTransferPair } from '../utils/transferSurvivorRelease';
import { buildTransactionRegisterPath } from '../utils/transactionDeepLink';
import { normalisePayeeKey } from '../utils/recurringDetection';
import { readProvenance, returnState } from '../utils/navigationProvenance';
import { planBulkDelete, type BulkDeletePlan } from '../utils/registerBulkDelete';
import { DATE_COLUMN_WIDTH_PX } from '../utils/registerDateColumn';
import {
  advanceTypeAheadBuffer,
  claimsSpaceForTypeAhead,
  findTypeAheadMatch,
  isTypeAheadKey,
} from '../utils/registerShortcuts';
import { isConfirmableSuggestion } from '../utils/categoryProvenance';
import { classifyTransferCategoryChoice } from '../utils/transferCoherence';
import { transferCategoryIdFor } from '../utils/transferRepoint';
import CrossCurrencyTransferDialog from '../components/CrossCurrencyTransferDialog';
import { buildFxRecord } from '../utils/fx';
import {
  crossedCurrencies,
  destinationLegAmount,
  recordConvertedCounterpart,
  type ConfirmedConversion,
} from '../utils/crossCurrencyTransfer';
import {
  buildPayeeCompletionIndex,
  rememberedCategoryForPayee,
  type PayeeCompletionEntry,
} from '../utils/payeeAutocomplete';
import PayeeAutoCompleteInput from '../components/PayeeAutoCompleteInput';
import AddWithoutCategoryConfirm from '../components/AddWithoutCategoryConfirm';
import { countAwaitingReview, isAwaitingReview } from '../utils/transactionReview';
import { countUnreconciled } from '../utils/transactionReconciliation';
import { lazyWithRecovery } from '../utils/lazyWithRecovery';
import { formatCardNumberForDisplay, isCardAccountType } from '../utils/accountNumberInput';
import { buildAttentionItems } from '../utils/attentionItems';
import { loadAutoSyncPrefs } from '../utils/bankAutoSync';
import { buildAccountBankLinks } from '../hooks/accountBankLinks';
import { useBankConnectionSnapshot } from '@service';
import { dataPort } from '@data';
import AccountSelector from '../components/common/AccountSelector';
import type { Account, Transaction } from '../types';
import { preferences, type PreferenceStorage } from '../services/preferencesService';
import { formatShortDate } from '../utils/dateFormatter';

/**
 * The app's one full "add a transaction" editor — the same component Layout
 * opens app-wide (Alt+N, ?action=add-transaction), reached here from the
 * toolbar's Add.
 *
 * Lazy for the reason Layout loads the same module lazily: it is not part of
 * the register's first paint, and loading it the same way means both entry
 * points share ONE chunk rather than shipping the editor twice.
 */
const AddTransactionModal = lazyWithRecovery(() => import('../components/AddTransactionModal'));

type TransactionWithBalance = Transaction & { balance: number };

/**
 * Whether this id belongs to a CLOSED account, once we have asked.
 *
 * The app context carries only OPEN accounts, so an id that misses it is not
 * automatically a missing account: closing one hides it and keeps every
 * transaction (the Microsoft Money model), and a payee drill, a report drill
 * or a bookmark lands on a closed account's register as readily as an open
 * one's. 'idle' means the question never arose — the account is open.
 */
type ClosedAccountLookup =
  | { status: 'idle' | 'loading' }
  | { status: 'done'; account: Account | null };

interface OpeningBalanceRow {
  id: 'opening-balance';
  isOpeningBalance: true;
  date: Date;
  /** True when no date could be resolved — the row shows "no date set" rather
   *  than a fabricated one (see the shared opening-date resolver). */
  noDateSet?: boolean;
  description: string;
  amount: number;
  balance: number;
  type: 'income';
  category: string;
  accountId: string;
  tags: string[];
  cleared: true;
}

type DisplayRow = TransactionWithBalance | OpeningBalanceRow;

function isOpeningBalanceRow(row: DisplayRow): row is OpeningBalanceRow {
  return 'isOpeningBalance' in row && row.isOpeningBalance === true;
}

// Persisted (per browser) column layout for the account register.
const COLUMN_ORDER_KEY = 'accountRegister.columnOrder.v1';
const COLUMN_WIDTHS_KEY = 'accountRegister.columnWidths.v1';
const HIDDEN_COLUMNS_KEY = 'accountRegister.hiddenColumns.v1';
const ARCHIVE_KEY = 'accountRegister.archive.v1';
// Columns off by default; the user can switch them on in the View dropdown.
const DEFAULT_HIDDEN_COLUMNS = ['amount', 'notes'];

interface ArchiveState { range: ArchiveRange; from: string; to: string }

/** The Quick Add bar's heading, and what names the bar to a screen reader. */
const QUICK_ADD_HEADING_ID = 'quick-add-heading';
/** Where the add bar's own message is printed — what the faulty box points at. */
const QUICK_ADD_ERROR_ID = 'quick-add-error';

/**
 * The payee index before it has been built. A module constant so the memo's
 * "not yet" answer keeps one identity and never re-renders the box behind it.
 */
const NO_PAYEES: readonly PayeeCompletionEntry[] = [];

/**
 * How much vertical room the register leaves for the bottom dock, in px.
 *
 * ─ WHY A NUMBER AND NOT A MEASUREMENT ──────────────────────────────────────
 * The table's height is measured (viewport − everything above it − this), and
 * the dock is the one thing BELOW it. Measuring the dock instead would make the
 * table's height depend on the height of an element that sits after it in the
 * flow, which is the shape of an oscillation: a taller table can bring on a
 * scrollbar, a scrollbar narrows the dock, a narrower dock wraps and grows, and
 * the table shrinks again. So the dock's height is declared, the same way the
 * editor row's is (see QUICK_EDIT_ROW_HEIGHT), and anything that changes it
 * changes the number here in the same commit.
 *
 * ─ THE PARTS, RE-COUNTED 30 AUG 2026 ───────────────────────────────────────
 * The declared 224 was still clearing a 178px bar the dock no longer is —
 * the owner measured the drift by eye: "a big gap below it to the bottom of
 * my screen. That is wasted space." Added up from the dock's own utilities:
 *
 *   26  the shell — py-3 (24) and its 1px borders
 *   50  the field row — text-xs label (16) + mb-0.5 (2) + h-[32px] controls
 *   40  the cross-type line at its WORST — mt-2 (8) + two wrapped lines of
 *       text-xs (32); one line on a wide window, but the reserve must fit
 *       the narrow one or the last row hides behind the dock
 *   16  the gap between the table and the dock
 *   32  the page's own md:pb-8 under everything (EXPANDED_DOCK_RESERVE_PX,
 *       which is exactly this padding, is the cross-check)
 *    8  slack
 * = 172, and about three more register rows on a laptop than 224 left room
 * for. The quick-add ERROR line stays outside this arithmetic on purpose:
 * it appears in answer to a keystroke, while the person is looking at the
 * dock, and vanishes with the next one — reserving for it permanently would
 * charge every quiet moment for the loud one.
 */
export const QUICK_ADD_FIELDS_RESERVE_PX = 172;
/**
 * What the bar's heading adds: a `text-sm` line box (20px) and its `mb-2` (8).
 * Those two utilities are on the <h2> below, and a test holds them to it —
 * because a heading that grew without this growing puts the last row of the
 * register behind the dock.
 */
export const QUICK_ADD_HEADING_HEIGHT_PX = 28;
export const DOCK_RESERVE_PX = QUICK_ADD_FIELDS_RESERVE_PX + QUICK_ADD_HEADING_HEIGHT_PX;
/** With the dock hidden there is nothing to clear but the page's own padding. */
const EXPANDED_DOCK_RESERVE_PX = 32;

/**
 * Which column each editable field takes over while a row is being edited.
 *
 * The mapping is the whole of the alignment problem: the editor never places
 * anything, it only says which cell it belongs in, and the cell is drawn by the
 * table at the column's own width under the column's own header. Any column not
 * named here — Payment, Deposit, Balance, R, Tags — stays exactly as it
 * reads. Amounts are the full editor's job. Notes joined on 17 Aug (owner:
 * annotating a statement is the same run as tidying descriptions, and it was
 * the one on-screen text field that still forced the full editor open per row).
 */
const QUICK_EDIT_COLUMN_FIELDS: Readonly<Record<string, QuickEditField>> = {
  date: 'date',
  description: 'description',
  category: 'category',
  notes: 'notes',
};

// Friendly labels for the View dropdown's column checkboxes.
const COLUMN_LABELS: Record<string, string> = { reconciled: 'Reconciled (R)' };

/**
 * ONE quiet outline for every toolbar control that is not the primary action
 * (DESIGN_PASS §3.1 QUIET, and P7: four button roles in the building, a fifth
 * is a bug report).
 *
 * Search & filters, View, Expand table and the two toggles were four different
 * outlines with three border colours between them, which made the row read as
 * four ranks of thing when it is one rank of thing and one primary. Written
 * once, here, so the next control added to this toolbar has nowhere else to
 * get its clothes from.
 */
const TOOLBAR_QUIET_BUTTON =
  'flex w-full sm:w-auto items-center justify-center gap-2 px-3 py-1.5 text-sm border rounded transition-colors duration-state';
const TOOLBAR_QUIET_IDLE =
  'border-line-strong dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-surface-tertiary dark:hover:bg-gray-700';
/** The same button, switched on. A state of the one style, not a second style. */
const TOOLBAR_QUIET_ACTIVE =
  // Dark side wears the focus-family slate, not a blue: blue means link in
  // this app, and a selected border already has a dark ruling (index.css's
  // `.dark .border-primary`) — same family as the focus ring, no second
  // highlight colour (Claude Design's canon ruling, 22 Aug §2/§6).
  'border-[#1a2332] dark:border-[#94a3b8] text-[#1a2332] dark:text-[#94a3b8] bg-surface-secondary dark:bg-gray-700';

/** The sortable columns, named as their headers name them. */
const SORT_FIELD_LABELS: Record<TransactionSortField, string> = {
  date: 'Date',
  description: 'Description',
  category: 'Category',
  tags: 'Tags',
  payment: 'Payment',
  deposit: 'Deposit',
  amount: 'Amount',
  notes: 'Notes'
};

/**
 * How the register brings a row into view — and the one rule that decides it.
 *
 * ─ THE RULE ───────────────────────────────────────────────────────────────
 * WORKING a row centres it. BROWSING does not. The row EDITOR is what tells the
 * two apart: while a row is an editor the user is working, and the row being
 * worked belongs in the middle — wherever the highlight goes next.
 *
 *   What just happened                            Alignment
 *   ────────────────────────────────────────────  ─────────
 *   A ?txn= deep link arrived                     centre
 *   A click made a row the editor                 centre
 *   F2 opened (or re-opened) the editor           centre
 *   Save & Next stepped an editor to the next     centre
 *   Save & Previous stepped it back               centre
 *   Arrow / Page / Home / End / type-ahead,
 *     with a row being EDITED                     centre
 *   …the same keys with nothing being edited      nearest
 *   Shift+arrow stretching a run of rows          nearest — see below
 *   A delete moved the highlight to the next      nearest
 *   A second click opened the full editor         neither — the modal is the view
 *   Escape let go of the row                      neither — nothing is being worked
 *
 * WHY CENTRE FOR THE EDITOR. The owner: "It is nice to see the transactions
 * above and below the one you are working on." A row edited at the foot of the
 * screen shows nothing after it; centred, the row being worked has its
 * neighbours either side, which is how a register is read. Both ends clamp —
 * react-window's 'center' and the non-virtualised path's arithmetic alike stop
 * at the top and at the foot — so the first and last few rows simply sit as
 * near the middle as the list allows, which is the exception he named.
 *
 * An edited row is taller than a plain one and carries its strip of actions
 * with it (see RowDetail), so centring the row centres the whole of it.
 *
 * WHY THE ARROWS FOLLOW THE EDITOR. They did not, and the owner said what that
 * felt like: "When I click on a transaction it does put it in the middle, but
 * when I use the up and down arrows, it is not the list moving up and down and
 * the highlighted box staying in the middle, it is the highlighted box that
 * moves down or up the list." Which is Money's register the wrong way round.
 * Working down a statement, the thing that should hold still is the row being
 * worked; the ledger scrolls beneath it. So an arrow WHILE A ROW IS BEING
 * EDITED moves the editing, and moving it centres it — the same sentence as
 * every other line in the table above.
 *
 * WHY NOT WHEN NOTHING IS BEING EDITED. A bare highlight walking the list is
 * browsing, and re-centring the register on every keystroke would heave the
 * whole page about one line at a time to no end. 'nearest' moves the list only
 * when the highlight reaches an edge, which is what every list that has ever
 * had arrow keys does.
 *
 * WHY SHIFT+ARROW STAYS NEAREST. It is stretching a SELECTION, not moving an
 * editor: no row is an editor at all while more than one is selected (see
 * quickEditRow), so there would be nothing in the middle to keep there, and
 * dragging the register under a growing selection makes it harder to see how
 * far it reaches.
 */
type RowScrollAlign = 'center' | 'nearest';

interface RowScrollRequest {
  rowId: string;
  align: RowScrollAlign;
  /**
   * Which request this is.
   *
   * Asking for the same row with the same alignment twice is not a change React
   * can see, so without a count F2 on a row the user has since scrolled away
   * from would sit there doing nothing at all.
   */
  token: number;
}

/** The same kind of request again, counted — see RowScrollRequest.token. */
const nextRowScroll = (
  previous: RowScrollRequest | null,
  rowId: string,
  align: RowScrollAlign
): RowScrollRequest => ({ rowId, align, token: (previous?.token ?? 0) + 1 });

/**
 * Is this element somewhere the user is TYPING?
 *
 * Every keyboard shortcut on this page defers to it: a register that swallows
 * the down arrow while someone is halfway through a description, or deletes a
 * row because they pressed Delete in the search box, is worse than one with no
 * shortcuts at all.
 */
const isTextEntryTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
};

/**
 * A stored JSON value, from whichever store the key belongs in.
 *
 * The register's layout is deliberately split across the two. Column ORDER and
 * which columns are HIDDEN are decisions about what matters in a statement, so
 * they follow the account; column WIDTHS are pixels, and pixels belong to the
 * screen they were dragged on. Carrying a 13-inch laptop's widths onto a
 * 32-inch monitor would make the register worse on the bigger screen, which is
 * the opposite of what "my settings followed me" is supposed to mean.
 */
const readStored = <T,>(store: PreferenceStorage, key: string, fallback: T): T => {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

export default function AccountTransactions() {
  const { accountId } = useParams<{ accountId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  /**
   * Where the user came from, when whoever sent them here said so.
   *
   * Absent on an ordinary visit from the accounts list, a bookmark or a
   * refresh — and then the back button reads "Back to Accounts" exactly as it
   * always has.
   */
  const backTo = readProvenance(location.state);
  const {
    accounts, transactions, categories, isLoading, transactionsLoadFailed,
    deleteTransaction, addTransaction, updateAccount, updateTransaction,
    // The dock's Txfr path writes BOTH legs: the row, then the one operation
    // that turns it into a linked pair. See commitQuickAdd.
    createTransferCounterpart,
    // …except across a currency boundary, where the far side cannot be minted
    // and is written explicitly at a confirmed figure instead.
    linkTransferPair,
    refreshCategories, refreshAccountsAndTransactions,
    // The reconcile and archive writes the register's keyboard uses are the
    // SAME ones the reconciliation screen and the archive manager use — a key
    // must never be a second, quieter way to change the ledger.
    setTransactionsCleared, setTransactionArchived,
  } = useApp();
  const { formatCurrency } = useCurrencyDecimal();
  const identityKey = useIdentityKey();
  const { showError, showInfo, showSuccess, showWarning } = useToast();
  const { compactView, setCompactView: _setCompactView } = usePreferences();

  // Find the specific account — the context holds the OPEN ones only.
  const account = accounts.find(acc => acc.id === accountId);
  const accountIsOpen = account !== undefined;

  /**
   * ONE CURRENCY FOR THIS REGISTER, resolved once, before anything is drawn.
   *
   * A register is a column of figures that add up: the header total, the
   * running balance and every payment in between are the same money, so a
   * table that prints two symbols in one column is not a formatting slip, it
   * is an arithmetic claim that cannot be true. It happened because the
   * currency was passed at each call site — some with the account's, some with
   * none at all, which silently means the user's display currency
   * (see useCurrencyDecimal) — so agreement was a thing to remember rather
   * than a thing that held. (DESIGN_PASS §3.1 FIX.)
   *
   * Everything the register prints about THIS account now goes through here.
   * Figures about OTHER accounts — the transfer picker's list of balances —
   * deliberately do not: they wear their own account's currency, because that
   * is what they are.
   */
  const registerCurrency = account?.currency;
  // What the bank has authorised but not posted on this account, if it says.
  // Drawn beneath the register, after the last real row — never among them.
  const pendingAtBank = usePendingAtBank(accountId);
  const formatRegisterMoney = useCallback(
    (amount: DecimalInstance | number) => formatCurrency(amount, registerCurrency),
    [formatCurrency, registerCurrency]
  );

  // Asked for only on a miss, and only once the open list has arrived, so an
  // ordinary register costs no extra request.
  const [closedLookup, setClosedLookup] = useState<ClosedAccountLookup>({ status: 'idle' });
  const [reopening, setReopening] = useState(false);

  /**
   * Whether the wait has gone on long enough to be worth showing. Under 200ms
   * the register shows NOTHING rather than a flash of grey bars — see
   * useDelayedFlag, and DESIGN_PASS §4.
   */
  const registerIsResolving = !account && (isLoading || closedLookup.status !== 'done');
  const showRegisterSkeleton = useDelayedFlag(registerIsResolving);

  useEffect(() => {
    if (isLoading || accountIsOpen) return;
    if (!accountId) {
      setClosedLookup({ status: 'done', account: null });
      return;
    }
    let cancelled = false;
    setClosedLookup({ status: 'loading' });
    dataPort.listClosedAccounts()
      .then(list => {
        if (!cancelled) {
          setClosedLookup({ status: 'done', account: list.find(a => a.id === accountId) ?? null });
        }
      })
      .catch(() => {
        // A failed lookup says nothing about the account; "not in the open
        // list, and we cannot check" reads as no longer existing.
        if (!cancelled) setClosedLookup({ status: 'done', account: null });
      });
    return () => { cancelled = true; };
  }, [accountId, accountIsOpen, isLoading]);

  // Closed accounts have no register — the Accounts page's rule — so the way
  // through is to re-open the account, offered here where the need arises.
  // The refresh recipe matches the Accounts page's Reopen button: closed
  // accounts are filtered out at load, and the DB trigger re-activates the
  // account's transfer category. Once the account is back in the open list
  // this page renders its register in place, deep link and all.
  const handleReopenAccount = useCallback(async (): Promise<void> => {
    if (!accountId || reopening) return;
    setReopening(true);
    try {
      await updateAccount(accountId, { isActive: true });
      await refreshAccountsAndTransactions();
      await refreshCategories();
    } catch (error) {
      showError(error);
    } finally {
      setReopening(false);
    }
  }, [accountId, reopening, updateAccount, refreshAccountsAndTransactions, refreshCategories, showError]);

  // State for search and filtering
  const [searchTerm, setSearchTerm] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'income' | 'expense' | 'transfer'>('all');
  // Single-viewport layout: search collapses behind a toggle, and the table
  // can expand over the bottom add/edit dock for bulk browsing.
  const [showFilters, setShowFilters] = useState(false);
  const [tableExpanded, setTableExpanded] = useState(false);
  const [sortField, setSortField] = useState<TransactionSortField>('date');
  /**
   * Has the PHONE's Order control been used? The phone reverses the default
   * chronology (newest first — see phoneListRows), and that reversal must
   * stand down the moment the order is CHOSEN, or "oldest first" would be
   * unreachable: choosing date-ascending would be flipped right back to
   * newest-first by the default's own courtesy.
   */
  const [phoneSortChosen, setPhoneSortChosen] = useState(false);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  // The table's height is MEASURED (viewport minus everything above it and a
  // reserve for the bottom dock) so the whole page always fits one screen,
  // whatever banners/nav are present. Fixed calc() guesses drift.
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [tableHeight, setTableHeight] = useState(480);
  const measureTableHeight = useCallback(() => {
    const el = tableWrapRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const dockReserve = tableExpanded ? EXPANDED_DOCK_RESERVE_PX : DOCK_RESERVE_PX;
    setTableHeight(Math.max(240, window.innerHeight - top - dockReserve));
  }, [tableExpanded]);
  // Re-measured on anything that moves the table down the page: the filter
  // panel, and the sort — a non-date sort adds a line above the table, and a
  // table measured before that line appeared overflows the viewport by its
  // height until the next window resize.
  useLayoutEffect(() => {
    measureTableHeight();
    window.addEventListener('resize', measureTableHeight);
    return () => window.removeEventListener('resize', measureTableHeight);
  }, [measureTableHeight, showFilters, sortField]);
  // Column layout (order + widths), drag-controlled and persisted per browser.
  const [columnOrder, setColumnOrder] = useState<string[]>(() => readStored<string[]>(preferences, COLUMN_ORDER_KEY, []));
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => readStored<Record<string, number>>(localStorage, COLUMN_WIDTHS_KEY, {}));

  useEffect(() => {
    try { preferences.setItem(COLUMN_ORDER_KEY, JSON.stringify(columnOrder)); } catch { /* storage may be unavailable */ }
  }, [columnOrder]);
  useEffect(() => {
    try { localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(columnWidths)); } catch { /* storage may be unavailable */ }
  }, [columnWidths]);

  const handleColumnResize = useCallback((key: string, width: number) => {
    setColumnWidths(prev => ({ ...prev, [key]: width }));
  }, []);

  // View dropdown: which columns are hidden, and how far back to show.
  const [hiddenColumns, setHiddenColumns] = useState<string[]>(() => readStored<string[]>(preferences, HIDDEN_COLUMNS_KEY, DEFAULT_HIDDEN_COLUMNS));
  const [archive, setArchive] = useState<ArchiveState>(() => readStored<ArchiveState>(preferences, ARCHIVE_KEY, { range: 'all', from: '', to: '' }));
  const [showView, setShowView] = useState(false);
  // Soft archive (persistent, server-side) — distinct from the date-window
  // "archive" dropdown above. Off by default; the toggle appears only when the
  // account actually has archived transactions.
  //
  // ?showArchived=1 arrives from the archive manager, where a row links here
  // so you can see how far back an account's history really goes before
  // choosing a cutoff. Read at first render as well as in the effect below, so
  // the hidden rows are there in the first paint rather than flashing in.
  const [showArchived, setShowArchived] = useState(
    () => new URLSearchParams(location.search).get('showArchived') === '1'
  );
  /**
   * Is the register narrowed to the rows that arrived and have not been dealt
   * with — the "To Review" box in the toolbar, pressed?
   *
   * NOT PERSISTED, unlike every other view setting on this page (columns, the
   * date window, the sort). Those describe how you like to read a register;
   * this describes a job you are part-way through, and a job you finished
   * yesterday must not still be filtering the register tomorrow. Coming back to
   * a register showing four of its nine hundred rows, with no memory of why, is
   * the worst kind of stale state — it looks like data loss.
   */
  const [reviewOnly, setReviewOnly] = useState(false);
  /** Set when the FOCUSED accounts list sent this visit (see the `back` param). */
  const [backToAccountsReview, setBackToAccountsReview] = useState(false);
  /**
   * The register narrowed to ONE recurring pattern's payments — every label
   * it has worn, so a stitched pattern (a bank rename) shows its whole
   * history in one view. Arrives by URL from Plan → Recurring Payments
   * (owner, 18 Aug: sending the user to the bare account "is pretty
   * pointless"), consumed-and-deleted like ?review= so the filter cannot
   * outlive the click that asked for it. Matching is by the DETECTOR's own
   * payee normaliser, never a re-derivation that could drift from it.
   */
  const [recurringPayeeFilter, setRecurringPayeeFilter] = useState<string[] | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { preferences.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify(hiddenColumns)); } catch { /* storage may be unavailable */ }
  }, [hiddenColumns]);
  useEffect(() => {
    try { preferences.setItem(ARCHIVE_KEY, JSON.stringify(archive)); } catch { /* storage may be unavailable */ }
  }, [archive]);

  // Close the View dropdown on outside click.
  useEffect(() => {
    if (!showView) return;
    const onDown = (e: MouseEvent) => {
      if (viewRef.current && !viewRef.current.contains(e.target as Node)) setShowView(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showView]);

  const archiveWindow = useMemo(() => computeArchiveWindow(archive.range, archive.from, archive.to), [archive]);

  // Deep links into this register, both consumed with a replace — the
  // established pattern — so back/refresh does not re-trigger them, and both
  // in ONE effect so their two replaces cannot overwrite each other:
  //  - ?txn=<txnId> (the categorisation drill) selects that transaction, widens
  //    the date window to All so it cannot be filtered out of sight, and
  //    scrolls the register to its row;
  //  - ?showArchived=1 (the archive manager) opens the register with the
  //    hidden rows already showing.
  const pendingTxnRef = useRef<string | null>(null);
  // Which account has already had its opening scroll — see the foot-scroll
  // effect below. It lives up here because a deep link CLAIMS that scroll, and
  // has to do so in the same pass that reads the parameter: state set here is
  // not visible to the later effect until the next render, by which time the
  // register would already have jumped to the foot.
  const openedAtFootRef = useRef<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const txn = params.get('txn');
    const hasShowArchived = params.has('showArchived');
    const hasReview = params.has('review');
    const hasBack = params.has('back');
    const hasRecurringPayee = params.has('recurringPayee');
    if (!txn && !hasShowArchived && !hasReview && !hasBack && !hasRecurringPayee) return;
    if (txn) {
      pendingTxnRef.current = txn;
      openedAtFootRef.current = accountId ?? null;
      setArchive(prev => (prev.range === 'all' ? prev : { range: 'all', from: '', to: '' }));
      params.delete('txn');
    }
    if (hasShowArchived) {
      // Arriving at a register that is ALREADY open changes only the search
      // string, so the switch is flipped here too, not just in the initial
      // state above.
      if (params.get('showArchived') === '1') setShowArchived(true);
      params.delete('showArchived');
    }
    if (hasReview) {
      /*
       * ARRIVING ALREADY FILTERED, from the To Review count on the accounts
       * list. The owner's ask: clicking that figure should take you to "that
       * specific view in the account register, filtered to show items 'to
       * review' only".
       *
       * A URL PARAMETER RATHER THAN STORED STATE, and deliberately: the
       * comment on `reviewOnly` argues that a filter must not outlive the
       * session that set it, because "coming back to a register showing four
       * of its nine hundred rows, with no memory of why" reads as data loss.
       * A parameter is the opposite of stored — it is consumed and deleted in
       * the same pass as `txn` and `showArchived` below, so the filter is on
       * because the user asked for it one click ago and is gone the moment
       * they navigate away. `=== '1'` so `?review=0` can turn it off rather
       * than mean the same as `?review=1`.
       *
       * The register drops the filter by itself when the count reaches zero
       * (the effect beside `toReviewCount`), so this cannot strand anyone on
       * an empty list after they have dealt with the last arrival.
       */
      if (params.get('review') === '1') setReviewOnly(true);
      params.delete('review');
    }
    if (hasBack) {
      // The FOCUSED accounts list sent this visit as one stop on a review
      // round — finishing here should return there, still focused, to pick
      // the next account (owner, 19 Aug). Consumed like the rest: the way
      // back is because the user came from there one click ago, not stored.
      if (params.get('back') === 'accounts-review') setBackToAccountsReview(true);
      params.delete('back');
    }
    if (hasRecurringPayee) {
      // Percent-decoding is URLSearchParams' own; the '|' separator survives
      // because a normalised payee key cannot contain one (letters, &, '
      // and spaces only — see normalisePayeeKey).
      const keys = (params.get('recurringPayee') ?? '')
        .split('|').map(k => k.trim()).filter(Boolean);
      if (keys.length > 0) {
        setRecurringPayeeFilter(keys);
        // A pattern's history usually predates any archive window.
        setArchive(prev => (prev.range === 'all' ? prev : { range: 'all', from: '', to: '' }));
      }
      params.delete('recurringPayee');
    }
    // The state is carried across by hand. React Router gives a replaced entry
    // null state unless told otherwise, and the state here is the provenance
    // that knows the way back to whatever sent the user — the duplicate sweep,
    // a notification. Consuming the deep link must not cost them the way home.
    navigate(
      { pathname: location.pathname, search: params.toString() },
      { replace: true, state: location.state }
    );
  }, [accountId, location.pathname, location.search, location.state, navigate]);

  // location.search is a dependency for the already-mounted case: landing on
  // the register that is ALREADY open only changes the search string, and
  // without it this effect would never wake to consume the pending id.
  //
  // Both halves run whatever state the account is in, which is what carries a
  // deep link across a re-open: the id is stashed and resolved into SELECTION
  // STATE while the closed page is showing (transactions are loaded per user,
  // not per open account), and that state outlives the re-open because the
  // component never unmounts. If the row genuinely isn't loaded yet the id
  // stays pending and the re-open's refresh wakes this effect again.
  useEffect(() => {
    const txn = pendingTxnRef.current;
    if (!txn) return;
    const target = transactions.find(t => t.id === txn);
    if (!target) return; // rows may still be loading; retry on next change
    pendingTxnRef.current = null;
    setSelectedTransaction(target);
    setSelectedTransactionId(txn);
    // …and already an editor. A ?txn= link is someone being sent to a
    // particular transaction to DO something about it (the categorisation drill
    // sends them), so the row arrives with its own boxes open rather than
    // merely pointed at.
    setQuickEditOpen(true);
    setRowScroll(previous => nextRowScroll(previous, txn, 'center'));
  }, [transactions, location.search]);

  const toggleColumn = useCallback((key: string) => {
    setHiddenColumns(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]));
  }, []);
  
  // State for modals and selection
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  /**
   * Whether the toolbar's Add has the full editor open.
   *
   * Plain state, NOT a `?action=add` in the URL — the idiom the Transactions
   * and Accounts pages use — and the difference is worth writing down, because
   * it looks like an inconsistency and is not.
   *
   * That parameter exists where the BUTTON and the MODAL are in different
   * component trees. On /transactions the add modal is Layout's, so the page's
   * header button cannot open it directly and signals through the URL instead;
   * on /accounts the parameter is there for the mobile + and the app-wide
   * shortcut, while the page's own Add Account button just sets state
   * (Accounts.tsx). Here the modal is the register's own — it has to be, since
   * it carries this account — and nothing outside this page links to a
   * per-account add, so a fourth query parameter would buy nothing.
   *
   * It would also cost: ?txn= and ?showArchived= are consumed in ONE effect
   * with ONE replace, precisely so two consumers cannot overwrite each other's
   * navigation (see that effect). Adding a third consumer to that knot for a
   * link nobody sends is exactly the coupling that comment is warning about.
   */
  const [showAddTransaction, setShowAddTransaction] = useState(false);
  const [showAccountSettings, setShowAccountSettings] = useState(false);
  // The CLOSED page's settings dialog (owner, 22 Aug): regrouping or renaming
  // a closed account must not cost a reopen–edit–close round trip. Its own
  // flag, because the closed branch returns before the register's modal.
  const [showClosedSettings, setShowClosedSettings] = useState(false);
  const [deleteConfirmTransaction, setDeleteConfirmTransaction] = useState<Transaction | null>(null);
  const [selectedTransactionId, setSelectedTransactionId] = useState<string | null>(null);
  /**
   * Where a Shift-extended selection started, or null when only one row is
   * highlighted.
   *
   * The selection ITSELF is not stored — it is the run of rows between this
   * anchor and the highlighted row, worked out from the current display order
   * (see selectedRowIds). One source of truth means a row can never be "in the
   * selection" while being nowhere in the list, which is exactly how a bulk
   * action ends up acting on something the user cannot see.
   */
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  /** The bulk delete's worked-out consequences, while its confirmation is up. */
  const [bulkDeletePlan, setBulkDeletePlan] = useState<BulkDeletePlan | null>(null);
  /** True while a bulk action's writes are in flight. */
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  /**
   * Whether the highlighted row is currently an EDITOR — its Date, Description
   * and Category cells turned into boxes, with the strip of actions beneath it.
   *
   * Separate from the highlight itself, because Escape peels the two apart:
   * the first one stops the editing and leaves the row highlighted (the
   * register is legible again), the second lets go of the row. It follows the
   * highlight while it is on — arrowing down takes the editing down with it,
   * which is what Money's register does — and stays off while it is off, so
   * someone who stopped editing to READ the list can arrow through it
   * undisturbed.
   */
  const [quickEditOpen, setQuickEditOpen] = useState(false);
  /**
   * A request for the row editor to take the cursor, and which field.
   *
   * Two things ask: F2 (the date field, calendar and all), and the landing
   * after a Save & Next (whichever field the run is working down). Held here
   * rather than inside the editor because the editor's cells are rebuilt on the
   * row it moves to, and a request has to survive that hop to be honoured on
   * the other side. Handed straight back when honoured, so nothing can replay
   * it.
   */
  const [quickEditFocus, setQuickEditFocus] = useState<QuickEditFocusRequest | null>(null);
  /** Which quick-add field to put the cursor in once the bar is on screen. */
  const [quickAddFocus, setQuickAddFocus] = useState<'date' | 'description' | null>(null);
  /** A pulse asking the search box for the cursor once the filter panel opens. */
  const [searchFocusToken, setSearchFocusToken] = useState(0);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const quickAddDateRef = useRef<HTMLDivElement>(null);
  const quickAddDescriptionRef = useRef<HTMLInputElement>(null);
  /** The amount box — so a blocked add can put the cursor where the fault is. */
  const quickAddAmountRef = useRef<HTMLInputElement>(null);
  /** True while an add is in flight — see commitQuickAdd. A ref, because the
   *  second keystroke can arrive before a re-render would have told it. */
  const quickAddInFlightRef = useRef(false);
  /** The type-ahead search in progress: what has been typed, and when. */
  const typeAheadRef = useRef<{ buffer: string; at: number }>({ buffer: '', at: 0 });
  /**
   * The row the register should bring into view, how, and which request it is.
   *
   * Which alignment each thing that can happen asks for — and why — is written
   * out once, at RowScrollRequest above. Null means nothing has been asked for:
   * the list stays exactly where the user left it.
   */
  const [rowScroll, setRowScroll] = useState<RowScrollRequest | null>(null);
  
  // State for quick add form
  const [quickAddForm, setQuickAddForm] = useState({
    date: new Date().toISOString().split('T')[0],
    description: '',
    amount: '',
    type: 'expense' as 'income' | 'expense' | 'transfer',
    category: '',
    tags: [] as string[],
    notes: ''
  });
  /**
   * What is wrong with the draft, and WHICH BOX is wrong.
   *
   * The field is carried with the message because a message alone cannot point:
   * the bar is one row of five fields and "Please enter an amount" printed
   * underneath it leaves the reader to work out which. With the field named,
   * the box itself is outlined, marked `aria-invalid`, tied to the message by
   * `aria-describedby` and given the cursor — so the eye, the screen reader and
   * the keyboard are all sent to the same place. 'form' is for the failures no
   * one box owns (the save itself came back with an error).
   */
  const [quickAddError, setQuickAddError] = useState<
    { field: 'description' | 'amount' | 'category' | 'form'; message: string } | null
  >(null);
  const clearQuickAddError = useCallback((): void => setQuickAddError(null), []);
  /**
   * The draft waiting on "…add anyway?". Non-null only while the dialog is up.
   *
   * The draft is held rather than the form being submitted optimistically,
   * because Cancel has to leave every keystroke exactly where it was.
   */
  const [confirmUncategorised, setConfirmUncategorised] = useState<{ description: string } | null>(null);
  /**
   * The draft waiting on a confirmed conversion, held for the same reason as
   * the one above: Cancel must leave every keystroke exactly where it was, and
   * nothing may reach the ledger until the figure is settled.
   *
   * `draft` is the override `submitQuickAdd` had already computed (a transfer
   * CATEGORY may have been turned into a target account on the way here), so
   * confirming replays the same add rather than re-deriving it.
   */
  const [pendingConversion, setPendingConversion] = useState<
    { target: string; draft: Partial<typeof quickAddForm>; from: string; to: string } | null
  >(null);
  const [conversionBusy, setConversionBusy] = useState(false);
  // Money-style cross-type filing, the same affordance the edit modal offers:
  // browse the OTHER direction's categories (a refund is money IN but belongs
  // under the expense category it refunds). The type toggle still decides which
  // way the money moves; the category decides which total it lands in.
  const [crossTypeCategories, setCrossTypeCategories] = useState(false);
  /**
   * Whether the payee index has been asked for yet.
   *
   * Building it is one pass over EVERY transaction the user owns, and it is
   * rebuilt whenever that list changes — after every add. Paying for that on
   * the register's first paint would charge it to everyone who opened an
   * account to read it, so the first cursor in the Description box is what
   * arms it. Focus always precedes typing, so the ghost is ready for the first
   * keystroke.
   */
  const [payeeIndexArmed, setPayeeIndexArmed] = useState(false);
  const armPayeeIndex = useCallback((): void => setPayeeIndexArmed(true), []);
  /**
   * The payees the Description box completes from — the whole register, not
   * this account's slice.
   *
   * Payees are the user's, not the account's: the shop you buy petrol from is
   * the same shop whichever card paid. That is also how the payee machinery
   * already reads the world — the cleanup screen counts every payee the user
   * owns, and buildPayeeGroups' suggestions span accounts.
   */
  const payeeIndex = useMemo<readonly PayeeCompletionEntry[]>(
    () => (payeeIndexArmed ? buildPayeeCompletionIndex(transactions) : NO_PAYEES),
    [payeeIndexArmed, transactions]
  );

  // Every transaction for this account, unfiltered — the basis for running
  // balances (so hiding rows never corrupts the displayed balance).
  const fullAccountTransactions = useMemo<Transaction[]>(
    () => (account ? transactions.filter(t => t.accountId === account.id) : []),
    [account, transactions]
  );
  const hasArchivedHere = useMemo(() => fullAccountTransactions.some(t => t.archived), [fullAccountTransactions]);

  /**
   * Whether Account Settings may still offer the CURRENCY field for editing.
   *
   * Asked through the shared rule rather than off `fullAccountTransactions`
   * above, even though the two lists are the same rows: what counts as
   * "history" for a re-denomination is a decision with one home, and reading a
   * list's length here would make this page a second place that decides it.
   */
  const accountHoldsHistory = useMemo(
    () => (account ? accountHasHistory(transactions, account.id) : undefined),
    [account, transactions]
  );

  // When the opening balance takes effect, via the SAME resolver the net-worth
  // walks and the drill use — so the register can never disagree with them.
  // undefined = no datable signal at all: the row shows "no date set" instead
  // of a fabricated today.
  const openingEffectiveDate = useMemo<Date | undefined>(() => {
    if (!account) return undefined;
    let ownFirst: Date | undefined;
    for (const t of fullAccountTransactions) {
      const d = new Date(t.date);
      if (!ownFirst || d < ownFirst) ownFirst = d;
    }
    // The paired "(Cash)" sibling's first activity — a position account whose
    // money lives in its cash sibling has no transactions of its own.
    const sibling = findSiblingAccount(account, accounts);
    let siblingFirst: Date | undefined;
    if (sibling) {
      for (const t of transactions) {
        if (t.accountId !== sibling.id) continue;
        const d = new Date(t.date);
        if (!siblingFirst || d < siblingFirst) siblingFirst = d;
      }
    }
    return effectiveOpeningDate(account, ownFirst, siblingFirst);
  }, [account, accounts, transactions, fullAccountTransactions]);

  /**
   * What the Category column says for a row — and the ONE function that
   * answers it, for the cell and for the sort alike.
   *
   * They were two functions, and they disagreed: the cell showed
   * "Food > Groceries" and "Transfer > Savings", the sort key was the leaf name
   * alone and the empty string for any transfer entered by hand. Sorting by
   * Category therefore tied every transfer with every uncategorised row and
   * delivered the register in date order. One resolver is what stops that
   * coming back — see createCategoryLabeller, and CategoryLabelFor for the
   * whole account of it.
   */
  const categoryLabel = useMemo(
    () => createCategoryLabeller(categories, accounts),
    [categories, accounts]
  );

  // Get account-specific transactions
  const accountTransactions = useMemo<Transaction[]>(() => {
    if (!account) return [];


    return transactions
      .filter(t => t.accountId === account.id)
      .filter(t => {
        // Soft archive: hidden from the live register unless the user opts in.
        if (!showArchived && t.archived) return false;

        // One recurring pattern's payments, across every label it has worn.
        if (recurringPayeeFilter &&
            !recurringPayeeFilter.includes(normalisePayeeKey(t.description))) return false;

        // Type filter
        if (typeFilter !== 'all' && t.type !== typeFilter) return false;

        // Date range filter (Search & filters)
        if (dateFrom && new Date(t.date) < new Date(dateFrom)) return false;
        if (dateTo && new Date(t.date) > new Date(dateTo)) return false;

        // Archive window (View dropdown "Show" presets)
        if (archiveWindow.from && new Date(t.date) < archiveWindow.from) return false;
        if (archiveWindow.to && new Date(t.date) > archiveWindow.to) return false;

        // Search filter
        if (!searchTerm) return true;
        const search = searchTerm.toLowerCase();
        return (
          t.description.toLowerCase().includes(search) ||
          t.amount.toString().includes(search) ||
          // The SAME label the Category column shows and the Category sort
          // orders by — so searching finds what the column reads. It used to
          // match the leaf name alone, which meant typing "Bills" found nothing
          // filed under "Bills > Water": the parent the user was looking at was
          // the one part of the label the search could not see. It also gives
          // transfers a searchable label at last ("Transfer > Savings"), which
          // a leaf lookup could never resolve.
          categoryLabel(t).toLowerCase().includes(search) ||
          (t.tags && t.tags.some((tag: string) => tag.toLowerCase().includes(search))) ||
          (t.notes && t.notes.toLowerCase().includes(search))
        );
      })
      .sort((a, b) => compareTransactions(a, b, sortField, sortDirection, categoryLabel));
    // categories is not a dependency: the only thing here that reads them is
    // categoryLabel, which is memoised on exactly them (and on accounts) — so a
    // renamed category rebuilds the labeller and this list follows.
  }, [account, transactions, searchTerm, dateFrom, dateTo, typeFilter, archiveWindow, showArchived, sortField, sortDirection, categoryLabel, recurringPayeeFilter]);

  /**
   * How many rows in front of the user have arrived and not been dealt with —
   * the figure in the toolbar's "To Review" box.
   *
   * COUNTED OVER THE ROWS THE REGISTER IS SHOWING, deliberately, and not over
   * the account as a whole. The box is a button: pressing it must produce
   * exactly this many rows, or the number is a lie the very moment it is
   * believed. Counting the whole account would say "3" while a date window hid
   * two of them, and clicking would then empty the register.
   *
   * The Accounts list counts the same predicate over the whole account, because
   * there is no view to narrow there — one rule (isAwaitingReview), asked of
   * whatever population the screen is actually showing.
   *
   * `reviewOnly` is deliberately NOT a dependency: this counts the list BEFORE
   * the review filter, so pressing the button cannot change the number the
   * button is showing.
   */
  const toReviewCount = useMemo(
    () => countAwaitingReview(accountTransactions),
    [accountTransactions]
  );

  /**
   * Nothing left to review ends the filter, rather than leaving somebody
   * looking at an empty register with the button that got them there gone (the
   * box hides itself at zero — the house rule that a zero count renders
   * nothing). Reviewing the last row is a success, and it should read like one.
   *
   * When the visit was one stop on a REVIEW ROUND (sent by the focused
   * accounts list, `back=accounts-review`), finishing goes back to that list —
   * still focused — to pick the next account, rather than leaving the user in
   * the register they have just cleared (owner, 19 Aug). Only while the
   * filter is still on: someone who turned it off and stayed to browse has
   * left the round, and must not be teleported mid-scroll.
   *
   * Cannot loop: toReviewCount is computed from the unfiltered list above.
   */
  useEffect(() => {
    if (toReviewCount !== 0) return;
    if (backToAccountsReview && reviewOnly) {
      navigate(preserveDemoParam('/accounts?focus=review', location.search));
      return;
    }
    setReviewOnly(false);
  }, [toReviewCount, backToAccountsReview, reviewOnly, navigate, location.search]);

  /**
   * The rows the table actually lists. One more filter on the end of the chain,
   * applied here rather than inside `accountTransactions` so the count above
   * can be taken from the list without it.
   */
  const visibleTransactions = useMemo<Transaction[]>(
    () => (reviewOnly ? accountTransactions.filter(isAwaitingReview) : accountTransactions),
    [accountTransactions, reviewOnly]
  );

  /**
   * EVERY FILTER CURRENTLY HOLDING SOMETHING BACK, named the way the user set
   * it — the list that turns "my transactions are gone" back into "they are
   * hidden, by these" (DESIGN_PASS §4).
   *
   * Named from the same state the controls are bound to, so a filter that
   * cannot be seen in the toolbar (the View menu's date window, the archive
   * toggle) is still accounted for. A filtered-empty register that omitted one
   * would be worse than saying nothing: it would send the user looking in the
   * wrong place.
   */
  const activeFilterNames = useMemo<string[]>(() => {
    const names: string[] = [];
    if (searchTerm) names.push(`Search: ${searchTerm}`);
    if (typeFilter !== 'all') {
      names.push(`Type: ${typeFilter.charAt(0).toUpperCase()}${typeFilter.slice(1)}`);
    }
    if (dateFrom || dateTo) names.push('the date range');
    if (archive.range !== 'all') {
      const preset = ARCHIVE_PRESETS.find(p => p.value === archive.range);
      names.push(`Show: ${preset?.label ?? archive.range}`);
    }
    if (reviewOnly) names.push('To Review only');
    if (recurringPayeeFilter) {
      names.push(`Recurring payee: ${recurringPayeeFilter[0]}${
        recurringPayeeFilter.length > 1 ? ' (including former names)' : ''}`);
    }
    if (hasArchivedHere && !showArchived) names.push('archived rows being hidden');
    return names;
  }, [searchTerm, typeFilter, dateFrom, dateTo, archive.range, reviewOnly, recurringPayeeFilter, hasArchivedHere, showArchived]);

  /** Puts every one of the above away — the remedy the filtered-empty offers. */
  const clearAllFilters = useCallback((): void => {
    setSearchTerm('');
    setTypeFilter('all');
    setDateFrom('');
    setDateTo('');
    setArchive(prev => ({ ...prev, range: 'all' }));
    setReviewOnly(false);
    setRecurringPayeeFilter(null);
    // "Clear filters" has to mean it: if archived rows are among what is
    // hidden, a button that left them hidden would empty the register again
    // and read as broken.
    if (hasArchivedHere) setShowArchived(true);
  }, [hasArchivedHere]);

  // Calculate running balance
  const transactionsWithBalance = useMemo<TransactionWithBalance[]>(() => {
    if (!account) return [] as TransactionWithBalance[];
    
    
    // Running balance is computed over the FULL account history — every
    // transaction, ignoring the view filters — so hiding rows (archived, date
    // window, search) never corrupts the balance shown against a visible row.
    //
    // compareChronological, NOT a local sort: the displayed rows are ordered by
    // the same function (compareTransactions delegates to it for Date, and
    // negates it wholesale for newest-first), so the column the user reads is
    // the column these figures were accumulated in. The two used to disagree on
    // same-day rows, and a register whose Balance column disagrees with itself
    // is worse than one without a Balance column.
    const sortedForBalance = [...fullAccountTransactions].sort(compareChronological);

    // Decimal, not float: a statement's worth of `runningBalance += amount`
    // drifts by a fraction of a penny and the register then shows a balance
    // that never quite equals the account's. Amounts are pre-signed.
    let runningBalance = toDecimal(account.openingBalance ?? 0);
    const balanceMap = new Map<string, number>();
    for (const transaction of sortedForBalance) {
      runningBalance = runningBalance.plus(toDecimal(transaction.amount));
      balanceMap.set(transaction.id, runningBalance.toNumber());
    }

    // Display the filtered subset, each carrying its true running balance.
    return visibleTransactions.map(t => ({
      ...t,
      balance: balanceMap.get(t.id) ?? 0
    }));
  }, [account, visibleTransactions, fullAccountTransactions]);

  // Build display rows with virtual Opening Balance as first entry
  const displayRows = useMemo<DisplayRow[]>(() => {
    if (!account) return [];

    // Nothing visible means nothing for a lead line to lead. A register whose
    // only row is "Brought forward" is the shape that made "my transactions
    // are gone" plausible — it looks like a register that lost its contents.
    // Empty, the table can say what is actually true instead (DESIGN_PASS §4).
    if (transactionsWithBalance.length === 0) return [];

    const openingBalance = account.openingBalance ?? 0;

    // The lead row's balance is whatever the balance was JUST BEFORE the
    // earliest VISIBLE transaction. With nothing hidden that equals the opening
    // balance ("Opening Balance"); when earlier history is hidden (archived, or
    // a date window) it's the carried-forward figure ("Brought forward"), so
    // the visible running balances stay continuous and correct.
    //
    // "Earliest" by compareChronological, not by date alone. Comparing only the
    // day left several rows tied, and the reduce then kept whichever the array
    // held first — which under a newest-first sort is the LAST of that day's
    // rows, so the lead balance came out short by everything else on that day.
    const earliestVisible = transactionsWithBalance.reduce<TransactionWithBalance | null>(
      (earliest, t) => (earliest === null || compareChronological(t, earliest) < 0 ? t : earliest),
      null
    );
    // No visible rows → the lead balance is the full account balance (opening
    // plus every transaction, all of which are currently hidden).
    const fullBalance = fullAccountTransactions
      .reduce((sum, t) => sum.plus(toDecimal(t.amount)), toDecimal(openingBalance)).toNumber();
    const leadBalance = earliestVisible
      ? toDecimal(earliestVisible.balance).minus(toDecimal(earliestVisible.amount)).toNumber()
      : fullBalance;
    const isBroughtForward = Math.abs(leadBalance - openingBalance) > 0.005;

    // Date: a "Brought forward" lead line is a carried-forward figure dated to
    // the cutoff (a different thing from the opening balance). A real "Opening
    // Balance" line uses the shared resolver's effective date; when that has no
    // signal at all the row shows "no date set" rather than a fabricated today.
    let obDate: Date | null;
    if (isBroughtForward && earliestVisible) {
      obDate = new Date(earliestVisible.date);
      obDate.setDate(obDate.getDate() - 1);
    } else {
      obDate = openingEffectiveDate ?? null;
    }

    const openingBalanceRow: OpeningBalanceRow = {
      id: 'opening-balance',
      isOpeningBalance: true,
      date: obDate ?? new Date(),
      noDateSet: obDate === null,
      description: isBroughtForward ? 'Brought forward' : 'Opening Balance',
      amount: leadBalance,
      balance: leadBalance,
      type: 'income',
      category: '',
      accountId: account.id,
      tags: [],
      cleared: true,
    };

    // Respect sort direction — opening balance is always chronologically first
    if (sortField === 'date' && sortDirection === 'desc') {
      return [...transactionsWithBalance, openingBalanceRow];
    }
    return [openingBalanceRow, ...transactionsWithBalance];
  }, [account, transactionsWithBalance, fullAccountTransactions, openingEffectiveDate, sortField, sortDirection]);

  // What is NOT RECONCILED, in money — the same question the Accounts page's
  // Unreconciled column answers in rows, and it has to be the same answer. A
  // marked-but-unfinalized row is still outstanding here, exactly as it is
  // there. Decimal, because this is money on screen.
  // How many rows a reconciliation would still have to tick — the number on
  // the "Reconcile" button that stands where To Review stood once the review
  // is done (see the toolbar).
  const unreconciledCount = useMemo(
    () => (account ? countUnreconciled(accountTransactions) : 0),
    [account, accountTransactions]
  );

  const unreconciledTotal = useMemo(() => {
    if (!account) return 0;

    return accountTransactions
      .filter(t => !isReconciled(t))
      .reduce((sum, t) => sum.plus(toDecimal(t.amount)), toDecimal(0))
      .toNumber();
  }, [account, accountTransactions]);

  // The true account balance = opening + Σ ALL its transactions. Computed over
  // the FULL set (never the filtered view) so archiving/date filters never
  // change the headline balance. Decimal — money is never summed as float.
  const computedAccountBalance = useMemo(() => {
    if (!account) return 0;
    return fullAccountTransactions
      .reduce((sum, t) => sum.plus(toDecimal(t.amount)), toDecimal(account.openingBalance ?? 0))
      .toNumber();
  }, [account, fullAccountTransactions]);

  // Bank balance from TrueLayer sync (or null if not available)
  const bankBalance = account?.bankBalance ?? null;

  /**
   * Why the dashboard sent them here.
   *
   * "Needs Your Attention" used to click through to a register that said
   * nothing about the warning, so the trip ended in a guess. Same builder, same
   * sentence — one account's worth of it, from connections already in memory,
   * so this costs a map lookup and no request. Nothing to say renders nothing.
   */
  const bankConnections = useBankConnectionSnapshot();
  const attentionReason = useMemo(() => {
    if (!account) return null;
    const links = buildAccountBankLinks(bankConnections);
    const [item] = buildAttentionItems({
      accounts: [account],
      balanceOf: () => computedAccountBalance,
      linkOf: (id) => links.get(id),
      autoSyncMode: identityKey ? loadAutoSyncPrefs(identityKey).mode : 'off',
      formatMoney: formatRegisterMoney,
      now: new Date(),
    });
    return item?.reason ?? null;
  }, [account, bankConnections, computedAccountBalance, identityKey, formatRegisterMoney]);

  /**
   * What to say when the register is not in date order.
   *
   * The Balance column is kept, and its figures stay true — the balance map is
   * keyed by transaction, so every row shows what the account was worth
   * immediately after that transaction whatever order the rows sit in, and
   * sorting by Amount to find a large payment is exactly when someone wants to
   * know it. What stops being true is the COLUMN: it no longer runs down the
   * page, and each row's arithmetic no longer follows from the one above.
   *
   * Blanking the column instead would destroy correct information and make a
   * user-sized, user-ordered column vanish as a side effect of clicking a
   * different header. Saying it in a line is the honest option: name the
   * consequence, and give the way back to a running balance.
   */
  const balanceOrderNotice = useMemo((): string | null => {
    if (sortField === 'date') return null;
    return `Sorted by ${SORT_FIELD_LABELS[sortField]}, so the Balance column doesn't run down the page. Each row still shows what ${account?.name ?? 'the account'} was worth immediately after that transaction — sort by Date to read the column as a running balance.`;
  }, [sortField, account?.name]);

  /**
   * Is the phone DISPLAYING the register oldest-first?
   *
   * The state order and the displayed order are not the same thing, and this
   * is the one place that knows it: `phoneListRows` below reverses the state
   * order whenever the owner has not chosen one, so the only way a phone shows
   * oldest-first is when he asked for it. Anything downstream that cares which
   * end is which — the anchor, the jump control's label — asks THIS, not
   * `sortDirection`.
   */
  const phoneShowsOldestFirst =
    phoneSortChosen && sortField === 'date' && sortDirection === 'asc';

  /**
   * NEWEST FIRST on a phone (owner, 17 Aug: opening on a row from years ago
   * read as starting at the wrong end). The desktop table keeps Money's
   * chronology and opens AT the foot; a page-scrolled infinite list cannot
   * start at its own foot without fighting its loading direction, and
   * newest-at-top is what every phone banking app has taught a thumb to
   * expect. Only the DEFAULT chronology is reversed — a sort the user chose
   * is shown exactly as they chose it. Each row carries its own precomputed
   * running balance, so the order is presentation, not arithmetic. Memoised:
   * an 11,000-row copy per keystroke is the kind of quiet quadratic the
   * dashboard perf pass existed to remove.
   */
  const phoneListRows = useMemo(
    () => (sortField === 'date' && sortDirection === 'asc' && !phoneSortChosen
      ? [...transactionsWithBalance].reverse()
      : transactionsWithBalance),
    [transactionsWithBalance, sortField, sortDirection, phoneSortChosen]
  );

  /**
   * Which end of the displayed list holds the NEWEST transaction, when that is
   * a question with an answer at all.
   *
   * Sorted by date, it always has one: oldest-first puts the newest last,
   * every other date order puts it first. Sorted by description or amount it
   * does not — the ends are "A" and "Z", or largest and smallest — so this is
   * `undefined` and the jump control falls back to naming a direction rather
   * than inventing a chronology.
   */
  const phoneNewestEnd: 'start' | 'end' | undefined =
    sortField === 'date' ? (phoneShowsOldestFirst ? 'end' : 'start') : undefined;

  // ── Opening at the foot of the register ────────────────────────────────────
  // Money's register is ordered oldest-first with the NEWEST transaction on the
  // last line, and it opens showing that line. The order is untouched (see
  // sortDirection's 'asc' default); it is the initial scroll position that
  // moves, once per account, and only on arrival.
  //
  // A deep link beats it outright: ?txn= means the user asked for one
  // particular row, and that row's centring wins. Such an arrival marks the
  // account done (above, as the parameter is read), so that clicking the row
  // afterwards — which clears the scroll target — cannot be mistaken for
  // "nothing has scrolled yet" and yank the viewport to the foot.
  const [footScrollToken, setFootScrollToken] = useState(0);
  useEffect(() => {
    if (!accountId || !accountIsOpen) return;
    if (openedAtFootRef.current === accountId) return;
    if (pendingTxnRef.current !== null || rowScroll !== null) {
      openedAtFootRef.current = accountId;
      return;
    }
    // Rows arrive after the account does; wait for them, or the list would be
    // asked to scroll to the foot of nothing.
    if (displayRows.length === 0) return;
    openedAtFootRef.current = accountId;
    setFootScrollToken(token => token + 1);
  }, [accountId, accountIsOpen, displayRows.length, rowScroll]);

  /**
   * Open the full editor on a row — splits, tags, everything the quick-edit
   * box has no room for.
   *
   * One function for both ways in (a second click on an open box, and Enter on
   * the highlighted row) so the two can never drift apart.
   */
  const openFullEditor = useCallback((row: TransactionWithBalance): void => {
    setSelectedTransaction(row);
    setSelectedTransactionId(row.id);
    setIsEditModalOpen(true);
  }, []);

  // Handle transaction row click
  const handleTransactionClick = useCallback((item: DisplayRow) => {
    if (isOpeningBalanceRow(item)) return;
    // Clicking a row hands the keyboard to the register, so the arrow keys are
    // live on the row you just highlighted without a second click. Browsers do
    // this themselves for a click inside a focusable container; doing it here
    // makes it certain rather than inherited. preventScroll because the click
    // proves the row is already on screen.
    tableWrapRef.current?.focus({ preventScroll: true });
    setSelectedTransaction(item);
    // A plain click is "just this one" — it collapses any Shift-extended run,
    // and it ends any type-ahead search: the user has found their row by hand.
    setSelectionAnchorId(null);
    typeAheadRef.current = { buffer: '', at: 0 };

    if (selectedTransactionId === item.id && quickEditOpen) {
      // A second click on a row that is ALREADY an editor means "give me
      // everything" — the full editor, with the amount, splits, tags and the
      // rest. Never from inside one of the row's own boxes: those swallow their
      // clicks, because clicking into the description is typing (see the
      // editor's cell shell).
      setRowScroll(null);
      openFullEditor(item);
      return;
    }
    // Otherwise: highlight it and turn the row itself into the editor, which is
    // what a click on a transaction has always meant here — the form has simply
    // walked from the foot of the page, to a box under the row, to the row's
    // own cells.
    setSelectedTransactionId(item.id);
    setQuickEditOpen(true);
    // …in the MIDDLE of the register, with the transactions either side of it
    // still readable. The owner's ask, and the reason the row is worth bringing
    // there: a row clicked near the foot would otherwise put its strip of
    // actions half off the screen, and a row clicked anywhere shows only what
    // follows it. See RowScrollRequest for the whole rule.
    setRowScroll(previous => nextRowScroll(previous, item.id, 'center'));
  }, [selectedTransactionId, quickEditOpen, openFullEditor]);

  const quickEditTarget = useMemo(
    () => transactionsWithBalance.find(t => t.id === selectedTransactionId) ?? null,
    [transactionsWithBalance, selectedTransactionId]
  );

  // A transfer to this very account moves nothing, so the quick-add dock's
  // account picker never offers it. Held steady so the picker's own grouping
  // is not rebuilt on every render of the page.
  const quickAddExcludedAccountIds = useMemo(
    () => (account ? [account.id] : []),
    [account]
  );

  // Clicking the page background deselects: the row un-highlights and the
  // bottom dock flips back from Quick Edit to Quick Add. Clicks inside the
  // table, the dock, or any dialog keep the selection.
  //
  // NEVER while the edit modal is open: the modal only renders while a row is
  // selected, and its pickers (category, tags, date) render their menus in
  // PORTALS on document.body — outside the dialog subtree — so a click on a
  // category option used to deselect, unmount the modal mid-click, and dump
  // the user back on the register with nothing saved. The listbox guard keeps
  // the selection for any other portaled picker menu (the dock's, say) too.
  //
  // Nor while the account is CLOSED: the register isn't rendered then, so
  // there is no row to click away from — and a mousedown on "Re-open and
  // view" would wipe the ?txn selection this page is about to show.
  //
  // Nor while the delete confirmation is up, for the same reason as the edit
  // modal: answering a dialog about the selected row is not clicking away from
  // it, and losing the selection mid-answer would leave the register with
  // nothing highlighted the moment the dialog closed.
  useEffect(() => {
    if (!accountIsOpen || !selectedTransactionId || isEditModalOpen || deleteConfirmTransaction) return;
    // Same reason for the bulk confirmation and the shortcut list: both are
    // ABOUT the selection, and losing it mid-answer would leave the register
    // with nothing highlighted the moment they closed.
    if (bulkDeletePlan || showShortcuts) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest('[data-transaction-table]') ||
        // The row editor's own parts, named in their own right: the fields sit
        // inside the table above, but saying so here is what keeps this honest
        // if the strip ever moves.
        isInsideQuickEdit(target) ||
        // The row editor's calendar is drawn in a PORTAL on document.body
        // (the transaction list would clip it), so a click on the 14th is
        // nowhere near the table in the DOM. Without this, picking a date
        // would deselect the row and unmount its editor mid-click — the same
        // trap the listbox guard below covers for the category menu.
        target.closest('[data-datepicker-panel]') ||
        // The bulk-action bar acts ON the selection — a mousedown there is
        // the opposite of clicking away from it, and deselecting first would
        // unmount the very button being pressed.
        target.closest('[data-register-selection-bar]') ||
        target.closest('[role="dialog"]') ||
        target.closest('[role="alertdialog"]') ||
        target.closest('[role="listbox"]')
      ) {
        return;
      }
      setSelectedTransactionId(null);
      setSelectedTransaction(null);
      setRowScroll(null);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [accountIsOpen, selectedTransactionId, isEditModalOpen, deleteConfirmTransaction, bulkDeletePlan, showShortcuts]);

  // Next non-summary row below the given one in the CURRENT visible order —
  // powers "Save & Next" in both the quick-edit panel and the full modal.
  const getNextTransactionId = useCallback((currentId: string): string | null => {
    const index = displayRows.findIndex(row => row.id === currentId);
    if (index === -1) return null;
    for (let i = index + 1; i < displayRows.length; i += 1) {
      if (!isOpeningBalanceRow(displayRows[i])) {
        return displayRows[i].id;
      }
    }
    return null;
  }, [displayRows]);

  const advanceToNextTransaction = useCallback((currentId: string): boolean => {
    const nextId = getNextTransactionId(currentId);
    if (!nextId) return false;
    const nextTransaction = transactionsWithBalance.find(t => t.id === nextId) ?? null;
    setSelectedTransactionId(nextId);
    setSelectedTransaction(nextTransaction);
    // Save & Next has to SHOW you the next one — and show it in the same place
    // every time. The editing moves to it, so the row it moves to is centred
    // like any other row worked on: working down a statement, each row in turn
    // arrives mid-screen with its neighbours either side, rather than the work
    // creeping towards the foot of the register a line at a time. See
    // RowScrollRequest.
    setRowScroll(previous => nextRowScroll(previous, nextId, 'center'));
    return true;
  }, [getNextTransactionId, transactionsWithBalance]);

  const getPreviousTransactionId = useCallback((currentId: string): string | null => {
    const index = displayRows.findIndex(row => row.id === currentId);
    if (index === -1) return null;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (!isOpeningBalanceRow(displayRows[i])) {
        return displayRows[i].id;
      }
    }
    return null;
  }, [displayRows]);

  const advanceToPreviousTransaction = useCallback((currentId: string): boolean => {
    const previousId = getPreviousTransactionId(currentId);
    if (!previousId) return false;
    const previousTransaction = transactionsWithBalance.find(t => t.id === previousId) ?? null;
    setSelectedTransactionId(previousId);
    setSelectedTransaction(previousTransaction);
    // Same reason as Save & Next above, in the other direction — and centred
    // for the same reason too: a run that centres going forwards and does not
    // going back would shift the register under anyone stepping either way.
    setRowScroll(previous => nextRowScroll(previous, previousId, 'center'));
    return true;
  }, [getPreviousTransactionId, transactionsWithBalance]);

  // ── Driving the register from the keyboard ─────────────────────────────────
  // The table is a focusable ARIA grid whose active row is named by
  // aria-activedescendant — the same pattern the category and account
  // comboboxes use, and the reason every row needs a stable DOM id.
  const registerId = useId();
  const rowDomId = useCallback((rowKey: string): string => `${registerId}-row-${rowKey}`, [registerId]);

  /**
   * The rows the arrows walk, in the order they are drawn.
   *
   * transactionsWithBalance, not displayRows: the lead "Opening Balance" /
   * "Brought forward" line is a summary, not a transaction — clicking it does
   * nothing, so arrowing onto it would strand the user on a row that cannot be
   * edited, deleted or docked.
   */
  const navigableRows = transactionsWithBalance;

  /**
   * A page, in rows. The measured table height already includes the header row,
   * and the minus-one both absorbs that and leaves a line of context at the
   * fold — the convention every register and spreadsheet follows.
   */
  const pageStep = useMemo(
    () => Math.max(1, Math.floor(tableHeight / (compactView ? 36 : 44)) - 1),
    [tableHeight, compactView]
  );

  /** Where the highlight currently sits in that list, or -1 for nowhere. */
  const activeRowIndex = useMemo(
    () => (selectedTransactionId ? navigableRows.findIndex(row => row.id === selectedTransactionId) : -1),
    [navigableRows, selectedTransactionId]
  );

  /**
   * Every row the selection covers, in display order.
   *
   * Derived, never stored: with only one row highlighted it is that row; with
   * an anchor planted by Shift+arrow it is the whole run between the two ends
   * AS THE REGISTER IS CURRENTLY ORDERED. A stored id list would keep rows
   * that a filter has since hidden, and a bulk action would then act on rows
   * nobody can see.
   */
  const selectedRowIds = useMemo<string[]>(() => {
    if (!selectedTransactionId) return [];
    if (!selectionAnchorId || selectionAnchorId === selectedTransactionId) {
      return [selectedTransactionId];
    }
    const anchorIndex = navigableRows.findIndex(row => row.id === selectionAnchorId);
    if (anchorIndex === -1 || activeRowIndex === -1) return [selectedTransactionId];
    const from = Math.min(anchorIndex, activeRowIndex);
    const to = Math.max(anchorIndex, activeRowIndex);
    return navigableRows.slice(from, to + 1).map(row => row.id);
  }, [navigableRows, selectedTransactionId, selectionAnchorId, activeRowIndex]);

  const selectedRows = useMemo<TransactionWithBalance[]>(() => {
    if (selectedRowIds.length <= 1) {
      const single = navigableRows.find(row => row.id === selectedTransactionId);
      return single ? [single] : [];
    }
    const ids = new Set(selectedRowIds);
    return navigableRows.filter(row => ids.has(row.id));
  }, [navigableRows, selectedRowIds, selectedTransactionId]);

  const hasMultiSelection = selectedRowIds.length > 1;

  const selectedIdSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds]);

  /**
   * A re-sort or a filter change drops a multi-row selection.
   *
   * "These five rows" means the five that were next to each other on screen.
   * Re-order the register underneath them and the run between the two ends is
   * a different five — so the honest answer is to let go rather than silently
   * re-point the selection at rows the user never chose.
   */
  useEffect(() => {
    setSelectionAnchorId(null);
  }, [sortField, sortDirection, searchTerm, dateFrom, dateTo, typeFilter, showArchived, archiveWindow]);

  /**
   * Move the highlight to `nextIndex` (clamped to the list), and scroll it in.
   *
   * `extend` is Shift held: the first extension plants the anchor where the
   * highlight already was, so the run grows from there; an unshifted move
   * pulls the anchor up and collapses the selection back to one row — which is
   * the behaviour of every list that has ever had Shift+arrow.
   *
   * Returns whether the register took the key. It says yes even when nothing
   * can move (already at an end — the ends stop, they never wrap), because a
   * page that lurches when you arrow past the last row is precisely what this
   * is for.
   */
  const moveSelectionTo = useCallback((nextIndex: number, extend: boolean): boolean => {
    if (navigableRows.length === 0) return false;
    const clamped = Math.min(navigableRows.length - 1, Math.max(0, nextIndex));
    const next = navigableRows[clamped];
    if (!next) return false;
    if (extend) {
      setSelectionAnchorId(prev => prev ?? selectedTransactionId ?? next.id);
    } else {
      setSelectionAnchorId(null);
    }
    setSelectedTransactionId(next.id);
    setSelectedTransaction(next);
    // Which of the two things this key is doing decides where the row lands.
    //
    // While a row is being edited it is MOVING THE EDITING — the editor follows
    // the highlight — so the row it moves to is centred, exactly as it is when
    // a click or a Save & Next moves it. The owner, on the register that did
    // not:
    // "when I use the up and down arrows, it is not the list moving up and down
    // and the highlighted box staying in the middle, it is the highlighted box
    // that moves down or up the list."
    //
    // With nothing being edited it is browsing: the least scroll that shows
    // the row, and nothing at all while it is already on screen.
    //
    // `extend` is Shift, and Shift is neither — it stretches a selection, and
    // while more than one row is selected no row is an editor, so there is
    // nothing to keep in the middle. The whole rule is at RowScrollRequest.
    const align: RowScrollAlign = quickEditOpen && !extend ? 'center' : 'nearest';
    setRowScroll(previous => nextRowScroll(previous, next.id, align));
    return true;
  }, [navigableRows, selectedTransactionId, quickEditOpen]);

  /** Move by `delta` rows. Entering with nothing highlighted starts at an end. */
  const moveSelection = useCallback((delta: number, extend = false): boolean => {
    if (navigableRows.length === 0) return false;
    const nextIndex = activeRowIndex === -1
      ? (delta > 0 ? 0 : navigableRows.length - 1)
      : activeRowIndex + delta;
    return moveSelectionTo(nextIndex, extend);
  }, [navigableRows.length, activeRowIndex, moveSelectionTo]);

  // ── What the keys actually do ──────────────────────────────────────────────

  /** Let go of the whole selection: no highlight, and nothing being edited. */
  const clearSelection = useCallback((): void => {
    setSelectionAnchorId(null);
    setSelectedTransactionId(null);
    setSelectedTransaction(null);
    setRowScroll(null);
    // The editing is about a row. With no row, there is nothing to edit.
    setQuickEditOpen(false);
  }, []);

  /**
   * Mark (or unmark) the given rows.
   *
   * Straight down setTransactionsCleared — the SAME write the reconciliation
   * screen's checkbox makes, in one round trip, so the two surfaces cannot
   * drift. And it is a MARK, not a reconciliation: only finalizing a
   * reconciliation commits anything, which is why nothing here disappears into
   * the archive the way it used to (that sweep now hangs off the committed
   * flag). Unmarking a row that WAS reconciled takes the commitment with it —
   * the store's own rule, mirrored in reconciledAfterMarking.
   */
  const applyCleared = useCallback(async (ids: string[], cleared: boolean): Promise<void> => {
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      await setTransactionsCleared(ids, cleared);
    } catch (error) {
      showError(error);
    } finally {
      setBulkBusy(false);
    }
  }, [setTransactionsCleared, showError]);

  /**
   * Space: mark the highlighted row, or unmark it if it is marked already.
   *
   * Over a multi-row selection the question is asked once for the whole run:
   * if ANY row is still unmarked, Space marks the lot — that is what someone
   * ticking off a statement means. Only when every one of them is marked
   * already does Space undo them, so the key can never half-do a selection and
   * leave the user unsure which way it went.
   */
  const toggleClearedOnSelection = useCallback((): void => {
    if (selectedRows.length === 0) return;
    const anyUnmarked = selectedRows.some(row => !row.cleared);
    void applyCleared(selectedRows.map(row => row.id), anyUnmarked);
  }, [selectedRows, applyCleared]);

  /**
   * Archive the selected rows that are not archived already.
   *
   * One call per row — there is no batch archive write, and inventing one here
   * would be a second path into the same table. Failures are counted rather
   * than aborting the run, so one bad row cannot strand the rest half-done
   * with nothing said about it.
   */
  const archiveSelection = useCallback(async (): Promise<void> => {
    const targets = selectedRows.filter(row => !row.archived);
    if (targets.length === 0) return;
    setBulkBusy(true);
    let archived = 0;
    let firstError: unknown = null;
    try {
      for (const row of targets) {
        try {
          await setTransactionArchived(row.id, true);
          archived += 1;
        } catch (error) {
          if (firstError === null) firstError = error;
        }
      }
    } finally {
      setBulkBusy(false);
    }
    if (archived > 0) {
      showSuccess(
        archived === 1
          ? 'Archived 1 transaction. It is hidden from this list, not deleted — every balance is unchanged.'
          : `Archived ${archived} transactions. They are hidden from this list, not deleted — every balance is unchanged.`
      );
      // The whole selection goes, not just the run: an archived row leaves the
      // live list, and a highlight left pointing at one would have
      // aria-activedescendant naming a row that is no longer in the page.
      clearSelection();
    }
    if (firstError !== null) showError(firstError);
  }, [selectedRows, setTransactionArchived, clearSelection, showSuccess, showError]);

  /**
   * Ctrl/Cmd+Enter: open the other half of a transfer, where it lives.
   *
   * A no-op on anything that is not one half of a linked pair — but a spoken
   * one. The user pressed two keys deliberately; silence would read as a
   * broken shortcut, and an error would be a lie about something that is
   * simply not applicable.
   */
  const jumpToTransferOtherSide = useCallback((row: TransactionWithBalance): void => {
    const otherSide = resolveTransferOtherSide(row, transactions, accounts);
    if (!otherSide) {
      showInfo("This isn't one half of a transfer, so there's no other side to jump to.");
      return;
    }
    navigate(buildTransactionRegisterPath(otherSide.accountId, otherSide.transactionId, location.search));
  }, [transactions, accounts, showInfo, navigate, location.search]);

  /**
   * Ctrl/Cmd+D: copy the highlighted row into the add bar as a DRAFT.
   *
   * Never a write. It fills the same form the Add button submits, dated today,
   * and puts the cursor in the description — so the usual "same again, but
   * £4 more" takes one keystroke and one edit, and still ends with the user
   * pressing Add.
   *
   * Two consequences worth knowing. The highlight is let go of — the user has
   * moved on to a new transaction, and leaving the old row open as an editor
   * while they type into the add bar would be two half-finished edits on one
   * screen. And a SPLIT row copies as a plain draft, because its
   * categorisation lives in lines this form has no way to hold.
   */
  const duplicateIntoQuickAdd = useCallback((row: TransactionWithBalance): void => {
    setTableExpanded(false);
    clearSelection();
    clearQuickAddError();
    setCrossTypeCategories(false);
    // A row filed under a "To/From <account>" category copies as the TRANSFER
    // it claims to be, whatever its own type field says. Copying it verbatim
    // would reproduce the incoherence — the disease spreading by Ctrl+D — and
    // there is nothing to guess about: the category names the account.
    const copied = classifyTransferCategoryChoice(
      categories,
      row.type === 'transfer' ? '' : row.category,
      row.accountId
    );
    setQuickAddForm({
      date: new Date().toISOString().split('T')[0],
      description: row.description,
      // Decimal, not Math.abs on a float: the form re-parses this string into
      // the amount that gets written, and money never round-trips through
      // float arithmetic in this app.
      amount: toDecimal(row.amount).abs().toFixed(2),
      type: copied.kind === 'convert' ? 'transfer' : row.type,
      // On a transfer this field means the TARGET ACCOUNT, which is where the
      // form reads it from; a split has no single category to copy. A copied
      // transfer category resolves to its account for the same reason — the
      // dock's Category box means the target once the type says transfer.
      //
      // A 'refuse' (the source's own To/From, or a category naming no account)
      // copies as BLANK rather than as something the Add button would then
      // reject: there is no target to carry, and the draft is a new
      // transaction the user is about to finish anyway.
      category: copied.kind === 'convert'
        ? copied.targetAccountId
        : copied.kind === 'refuse'
          ? ''
          : (row.type === 'transfer'
              ? (row.transferAccountId ?? '')
              : (row.isSplit ? '' : (row.category ?? ''))),
      tags: row.tags ? [...row.tags] : [],
      notes: row.notes ?? '',
    });
    setQuickAddFocus('description');
  }, [clearSelection, clearQuickAddError, categories]);

  /** `+`: an empty new transaction, cursor in the Date box. */
  const startNewTransaction = useCallback((): void => {
    setTableExpanded(false);
    clearSelection();
    setQuickAddFocus('date');
  }, [clearSelection]);

  /** Ctrl/Cmd+F: the filter panel open, cursor already in the search box. */
  const openSearch = useCallback((): void => {
    setShowFilters(true);
    setSearchFocusToken(token => token + 1);
  }, []);

  // The cursor lands only once the field it is asked for is on screen — both
  // of these run in the render that mounts it.
  useEffect(() => {
    if (searchFocusToken === 0) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [searchFocusToken]);

  useEffect(() => {
    if (!quickAddFocus) return;
    if (quickAddFocus === 'description') {
      quickAddDescriptionRef.current?.focus();
      quickAddDescriptionRef.current?.select();
    } else {
      const input = quickAddDateRef.current?.querySelector('input');
      input?.focus();
      input?.select();
    }
    setQuickAddFocus(null);
  }, [quickAddFocus]);

  /**
   * Put the cursor in the box the add bar has just complained about.
   *
   * Straight at the element rather than through the quickAddFocus request
   * above: that request exists to survive the bar being REVEALED, and here the
   * bar is already on screen with the user's hands in it — a round trip through
   * state would leave the message on screen for a frame with the cursor
   * somewhere else.
   */
  const focusQuickAddField = useCallback((field: 'description' | 'amount'): void => {
    const el = field === 'description' ? quickAddDescriptionRef.current : quickAddAmountRef.current;
    el?.focus();
    el?.select();
  }, []);

  /**
   * A payee suggestion accepted — offer the category it usually gets.
   *
   * Money's other courtesy, and the same memory the rest of the app already
   * runs on: the rule for "which category does this payee get" is
   * rememberedCategoryForPayee, which is buildPayeeGroups' rule, so the register
   * and the bulk-categorise screen cannot suggest different things about the
   * same payee.
   *
   * Three cases decline to guess:
   *   * a TRANSFER — that box is the other account, not a category;
   *   * a category the user has ALREADY chosen — a suggestion never overwrites
   *     a decision (the same rule payee memory obeys server-side);
   *   * cross-type filing switched on — the picker is deliberately listing the
   *     OTHER direction's tree, and filling it with this direction's habit
   *     would put a category in the box that the list beneath it does not offer.
   *
   * What lands is a suggestion in a box the user is looking at and can change,
   * not a decision taken behind them.
   */
  const handlePayeeAccepted = useCallback(
    (payee: string): void => {
      if (quickAddForm.type === 'transfer' || crossTypeCategories) return;
      if (quickAddForm.category !== '') return;
      const remembered = rememberedCategoryForPayee(
        transactions,
        categories,
        payee,
        quickAddForm.type
      );
      if (remembered === undefined) return;
      setQuickAddForm(form => (form.category === '' ? { ...form, category: remembered } : form));
    },
    [quickAddForm.type, quickAddForm.category, crossTypeCategories, transactions, categories]
  );

  /**
   * The Category box answered — and the one case where the answer is not a
   * category at all.
   *
   * ─ THE CONVERSION MOMENT, IN THE DOCK'S OWN IDIOM ─────────────────────────
   * A "To/From <account>" category means "this money moved to that account".
   * The register's inline editor treats it exactly as the Transfer toggle with
   * that account chosen (see QuickEditRow.save: "'Make this a transfer' arrives
   * two ways and they mean the same thing"), and this dock now says the same
   * thing the way a FORM can say it — by flipping its own Type to Txfr and
   * putting the account in the To Account slot, in front of the user, before
   * anything is written.
   *
   * The editor asks its match-or-create question AFTER a save because the row
   * it is converting already exists and its twin might too. Here there is no
   * row yet: pressing Add writes the pair, which is Money's own behaviour for a
   * transfer typed into the register.
   *
   * A choice that CANNOT become a transfer is refused at the box, with the
   * reason, and the previous category left alone — the dock must never hold a
   * draft the Add button is going to reject.
   */
  const handleQuickAddCategoryChosen = useCallback(
    (categoryId: string): void => {
      clearQuickAddError();
      if (!account) return;
      const choice = classifyTransferCategoryChoice(categories, categoryId, account.id);
      if (choice.kind === 'refuse') {
        setQuickAddError({ field: 'category', message: choice.message });
        return;
      }
      if (choice.kind === 'convert') {
        setCrossTypeCategories(false);
        setQuickAddForm(form => ({
          ...form,
          type: 'transfer',
          category: choice.targetAccountId,
        }));
        return;
      }
      setQuickAddForm(form => ({ ...form, category: categoryId }));
    },
    [account, categories, clearQuickAddError]
  );

  const handleQuickEditFocusHandled = useCallback(() => setQuickEditFocus(null), []);
  /**
   * The editing stopping — Escape, the ×, or a finished Save: give the row its
   * cells back, keep it highlighted, and hand the keyboard back to the list.
   *
   * Both halves matter, and the second is the one that was missing. Without the
   * close, Escape would not do what the row plainly looks like it should.
   * Without the focus, the keyboard is left on a button that is about to be
   * taken off screen — and the register ignores everything inside the editor on
   * purpose, so the next arrow key was scrolling the list instead of moving the
   * highlight.
   */
  const handleQuickEditDismiss = useCallback(() => {
    setQuickEditOpen(false);
    tableWrapRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * Save & Next: step the highlight on, and tell the editor that opens on the
   * next row where to put the cursor — the field the user was last in, so a
   * run of categories (or descriptions, or dates) carries straight on.
   */
  const handleQuickEditNext = useCallback((currentId: string, landOn: QuickEditFocusRequest) => {
    if (advanceToNextTransaction(currentId)) {
      setQuickEditFocus(landOn);
    }
  }, [advanceToNextTransaction]);

  /**
   * The transaction whose ROW is currently the editor, or null when none is.
   *
   * Null in the three cases where an open editor would be a lie: nothing is
   * highlighted, a RUN of rows is (the editor edits one transaction), or the
   * full editor is open over the top of it.
   */
  const quickEditRow = useMemo<TransactionWithBalance | null>(() => {
    if (!quickEditOpen || hasMultiSelection || isEditModalOpen) return null;
    return quickEditTarget;
  }, [quickEditOpen, hasMultiSelection, isEditModalOpen, quickEditTarget]);

  /**
   * Whether this row's Category cell can become a picker at all.
   *
   * A transfer's category follows the account it faces, and a split's lives in
   * its lines — neither is a choice this row can offer, so the cell is left
   * showing what it always showed rather than turning into a control that
   * would have to refuse.
   */
  const canEditCategoryInPlace =
    quickEditRow !== null && quickEditRow.type !== 'transfer' && quickEditRow.isSplit !== true;

  /**
   * Save & Next, or nothing at all on the last row of the register.
   *
   * Nothing pretends there is somewhere to go: the strip shows no Save & Next
   * there, and the save ends the run rather than wrapping round to the top.
   */
  const quickEditNext = useMemo<((landOn: QuickEditFocusRequest) => void) | undefined>(() => {
    if (!quickEditRow || !getNextTransactionId(quickEditRow.id)) return undefined;
    const currentId = quickEditRow.id;
    return (landOn: QuickEditFocusRequest): void => { handleQuickEditNext(currentId, landOn); };
  }, [quickEditRow, getNextTransactionId, handleQuickEditNext]);

  // THE PHONE'S OWN "NEXT". Its list is drawn in `phoneListRows` order, which
  // reverses the register's default (newest at the top), so Save & Next on a
  // phone has to walk the order the person is looking at, not the table's.
  const isPhoneLayout = useIsMobileViewport();
  const phoneQuickEditNext = useMemo<((landOn: QuickEditFocusRequest) => void) | undefined>(() => {
    if (!quickEditRow) return undefined;
    const index = phoneListRows.findIndex(row => row.id === quickEditRow.id);
    if (index === -1 || index + 1 >= phoneListRows.length) return undefined;
    const nextId = phoneListRows[index + 1].id;
    return (landOn: QuickEditFocusRequest): void => {
      setSelectedTransactionId(nextId);
      setSelectedTransaction(transactionsWithBalance.find(t => t.id === nextId) ?? null);
      setQuickEditFocus(landOn);
    };
  }, [quickEditRow, phoneListRows, transactionsWithBalance]);

  /**
   * Keys the register claims while the table has focus.
   *
   * Scoped to the table's own keydown rather than the window: the search box
   * and the quick-add bar sit OUTSIDE it, so typing in them is untouched by
   * construction rather than by a list of exceptions.
   *
   * The row editor is the one thing that is INSIDE it — that is the whole
   * point of it — so it gets the two guards at the top: nothing typed anywhere,
   * and nothing at all from within the editor, reaches these keys.
   *
   * preventDefault is called only when the register actually handled the key,
   * so an empty register still scrolls the page as it always did.
   *
   * ─ THE ONE RULE ───────────────────────────────────────────────────────────
   * A bare letter or digit is ALWAYS the type-ahead search, never a command.
   * Every command therefore lives on a modifier, on F2, or on a key that types
   * nothing: Space, Enter, Escape, Delete, the arrows, Home/End, `+`, `?`.
   * The reasoning, and why Ctrl/Cmd+N is nowhere to be seen, is written down
   * once in src/utils/registerShortcuts.ts — the same module the printed
   * shortcut list is rendered from.
   *
   * ─ AND WHY EVERYTHING CLAIMED IS ALSO STOPPED ─────────────────────────────
   * The app carries a window-level shortcut listener (useKeyboardShortcuts) on
   * which a bare `g` or `n` starts a two-key "go to…" sequence and `?` opens
   * the app-wide list. Without stopPropagation, typing "gr" to find a payee
   * would navigate to Reports mid-word. So `claim` stops the event as well as
   * preventing its default — including for a letter that matched nothing,
   * because a mistyped letter must not take the user off the page either.
   */
  const handleRegisterKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (isTextEntryTarget(e.target)) return;
    // The row editor sits INSIDE this grid — its fields ARE cells of a row —
    // so its keys bubble through here. It owns every one of them: Space on its
    // Save button must press the button, not reconcile the row; Delete on its
    // category picker must clear the category, not offer to delete the
    // transaction. The typing guard above covers its text fields; this covers
    // its buttons and its comboboxes, which are not text at all.
    if (isInsideQuickEdit(e.target)) return;
    // A dialog owns the keyboard while it is open, and all of these render
    // over this.
    if (isEditModalOpen || showAddTransaction || deleteConfirmTransaction || bulkDeletePlan || showShortcuts) return;

    const claim = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    const activeRow = selectedTransactionId
      ? navigableRows.find(t => t.id === selectedTransactionId)
      : undefined;

    /** Add this key to the search in progress and move to what it finds. */
    const runTypeAhead = (key: string, now: number): void => {
      const buffer = advanceTypeAheadBuffer(
        typeAheadRef.current.buffer,
        key,
        now - typeAheadRef.current.at
      );
      typeAheadRef.current = { buffer, at: now };
      const match = findTypeAheadMatch(navigableRows, buffer, activeRowIndex);
      // No match leaves the highlight exactly where it was — jumping
      // somewhere arbitrary on a typo is worse than not moving.
      if (match >= 0) moveSelectionTo(match, false);
    };

    // ── Commands on the modifier key ──────────────────────────────────────
    // Ctrl on a PC, Cmd on a Mac, both accepted either way round so a
    // mismatched keyboard still works. Alt combinations belong to the
    // app-wide navigation shortcuts and are left alone entirely.
    if (e.altKey) return;
    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'd':
          if (!activeRow) return;
          claim();
          duplicateIntoQuickAdd(activeRow);
          return;
        case 'f':
          claim();
          openSearch();
          return;
        case 'enter':
          if (!activeRow) return;
          claim();
          jumpToTransferOtherSide(activeRow);
          return;
        default:
          // Everything else on the modifier is the browser's — Ctrl+C, Ctrl+A,
          // Ctrl+R. Taking those would be worse than offering nothing.
          return;
      }
    }

    switch (e.key) {
      case 'ArrowDown':
        if (moveSelection(1, e.shiftKey)) claim();
        break;
      case 'ArrowUp':
        if (moveSelection(-1, e.shiftKey)) claim();
        break;
      case 'PageDown':
        if (moveSelection(pageStep, e.shiftKey)) claim();
        break;
      case 'PageUp':
        if (moveSelection(-pageStep, e.shiftKey)) claim();
        break;
      case 'Home':
        if (moveSelectionTo(0, e.shiftKey)) claim();
        break;
      case 'End':
        if (moveSelectionTo(navigableRows.length - 1, e.shiftKey)) claim();
        break;
      case 'Enter': {
        if (!activeRow) return;
        claim();
        // The FULL editor, whatever the row's own boxes are doing — the same
        // openFullEditor a second click reaches, so the two cannot drift.
        // (Enter INSIDE the editor accepts and then saves; the editor handles
        // its own keys and this handler never sees them — see the guard at the
        // top.)
        openFullEditor(activeRow);
        break;
      }
      case 'F2': {
        // Straight into the row's own Date box, turning the row into an
        // editor if Escape had stopped it. Never over a multi-row selection —
        // the editor edits ONE transaction, and no row is one then.
        if (!activeRow || hasMultiSelection) return;
        claim();
        setQuickEditOpen(true);
        // The date field, calendar and all: F2 is someone asking to EDIT this
        // row, and the calendar is most of what the date field is for. A Save &
        // Next landing on the same field asks for it shut — see the editor's
        // QuickEditFocusRequest.
        setQuickEditFocus({ field: 'date', openCalendar: true });
        // The editing happens in the register itself, so an expanded table is
        // no obstacle: it is on screen either way, and collapsing it would undo
        // something the user asked for. Centred, like every other way editing
        // begins — including on the row it is already on, which is why the
        // request carries a count (see RowScrollRequest.token).
        setRowScroll(previous => nextRowScroll(previous, activeRow.id, 'center'));
        break;
      }
      case ' ': {
        // Mid-search the space bar belongs to the search, not to Reconcile —
        // otherwise typing a two-word payee would tick the R column on
        // whatever row it had reached. See claimsSpaceForTypeAhead.
        const now = Date.now();
        if (claimsSpaceForTypeAhead(typeAheadRef.current.buffer, now - typeAheadRef.current.at)) {
          claim();
          runTypeAhead(' ', now);
          break;
        }
        if (!activeRow) return;
        claim();
        toggleClearedOnSelection();
        break;
      }
      // Backspace as well as Delete: a Mac's full-size Delete key sends
      // Backspace, and the register is the only place either is claimed, so
      // neither can fire from a page that merely happens to be open.
      case 'Delete':
      case 'Backspace': {
        if (!activeRow) return;
        claim();
        if (hasMultiSelection) {
          // Worked out first, so the confirmation can name every consequence
          // and every refusal before a single row is touched.
          setBulkDeletePlan(planBulkDelete(selectedRows, transactions, accounts));
        } else {
          setDeleteConfirmTransaction(activeRow);
        }
        break;
      }
      case 'Escape': {
        // Whatever else Escape does here, it abandons the type-ahead search —
        // otherwise the space bar would still belong to a search the user has
        // plainly finished with, and the next Space would not reconcile.
        typeAheadRef.current = { buffer: '', at: 0 };
        // One layer at a time: the multi-row selection first, the highlight
        // second. Anything left over belongs to whatever is above us.
        //
        // The editing is a layer of its own, but it is peeled from INSIDE the
        // editor — an Escape with the cursor in one of the row's boxes stops
        // the editing and leaves the row highlighted (see the editor's own
        // handler). An Escape aimed at the LIST is about the list: it lets go
        // of the row, and the editing, being about that row, goes with it.
        if (hasMultiSelection) {
          claim();
          setSelectionAnchorId(null);
          return;
        }
        if (!selectedTransactionId) return;
        claim();
        clearSelection();
        break;
      }
      case '?': {
        claim();
        setShowShortcuts(true);
        break;
      }
      // `+` needs Shift on a UK/US layout and none on a German one; `=` is the
      // same key top unshifted. Accepting all three means "the key next to
      // Backspace" wherever it is.
      case '+':
      case '=': {
        claim();
        startNewTransaction();
        break;
      }
      default: {
        if (!isTypeAheadKey(e)) return;
        claim();
        runTypeAhead(e.key, Date.now());
        break;
      }
    }
  }, [
    isEditModalOpen, showAddTransaction, deleteConfirmTransaction, bulkDeletePlan, showShortcuts,
    moveSelection, moveSelectionTo, pageStep, selectedTransactionId, navigableRows,
    activeRowIndex, openFullEditor, hasMultiSelection, selectedRows,
    transactions, accounts, toggleClearedOnSelection, clearSelection,
    duplicateIntoQuickAdd, openSearch, jumpToTransferOtherSide, startNewTransaction,
  ]);

  /**
   * Write the draft away. Called only once every guard below has been answered,
   * so it asks no questions of its own.
   *
   * `override` carries the fields the guard CHANGED on its way through — the
   * transfer-category conversion rewrites the type and the target account, and
   * a `setQuickAddForm` does not take effect until the next render, several
   * awaits after this one has already read the form. Passing the change rather
   * than reading state back is what makes "what the guard decided" and "what
   * gets written" the same thing.
   */
  const commitQuickAdd = async (
    override: Partial<typeof quickAddForm> = {},
    /**
     * Present only when the two accounts hold different currencies and the
     * person has confirmed what arrives. Its presence switches the second leg
     * from MINTED to WRITTEN: see the branch at the counterpart step.
     */
    conversion?: ConfirmedConversion
  ): Promise<void> => {
    if (!account) return;
    const draft = { ...quickAddForm, ...override };
    // One row per gesture. Now that Enter adds — a key that repeats while it is
    // held, and that a fast hand can send twice before the write comes back —
    // the draft has to be able to say "already going". The window is the await
    // below: the form does not empty until it returns, so without this a second
    // Enter inside it would post the same transaction again. Duplicate rows are
    // the one mistake this register cannot let a keystroke make.
    if (quickAddInFlightRef.current) return;
    quickAddInFlightRef.current = true;
    // Calculate the correct amount based on transaction type
    let amount = parseMoneyInput(draft.amount) ?? 0;
    if (draft.type === 'expense') {
      amount = -Math.abs(amount); // Expenses are always negative
    } else if (draft.type === 'income') {
      amount = Math.abs(amount); // Income is always positive
    } else if (draft.type === 'transfer') {
      // For transfers, amount is negative (money leaving this account)
      amount = -Math.abs(amount);
    }

    // Create the transaction
    const isTransfer = draft.type === 'transfer';
    // On a transfer this field holds the TARGET ACCOUNT, not a category — the
    // dock's one invariant, and the reason the submit guard runs first (a
    // transfer CATEGORY chosen under Exp/Inc has already been turned into this
    // shape, or refused).
    const targetAccountId = isTransfer ? draft.category : undefined;

    const transactionData: Omit<Transaction, 'id'> = {
      date: new Date(draft.date),
      description: draft.description,
      amount: amount,
      type: draft.type,
      accountId: account.id,
      transferAccountId: targetAccountId,
      tags: draft.tags,
      notes: draft.notes,
      cleared: false,
      // The target account's own "To/From" category, read from the one place
      // the crossover rule is written down — not the legacy 'transfer-out'
      // sentinel this used to send. createTransferCounterpart re-files both
      // sides anyway; this matters for the one case where it cannot run, and
      // its rollback cannot either: the row left behind at least names the
      // account it was meant to face.
      category: isTransfer && targetAccountId
        ? transferCategoryIdFor(categories, targetAccountId, amount)
        : draft.category,
      // The confirmed rate rides with the row from its INSERT, so a converted
      // leg is never in the ledger without the record of what made it.
      ...(conversion
        ? { metadata: { fx: buildFxRecord(conversion.rate, conversion.source, conversion.asOf) } }
        : {}),
    };

    try {
      const newTransaction = await addTransaction(transactionData);

      /**
       * BOTH LEGS, LINKED — or neither.
       *
       * What this used to be: a second, blind `addTransaction` for the other
       * side, guarded by `if (… && newTransaction)` on a value the context
       * promised as `void`. The guard was permanently false, so the Txfr toggle
       * wrote ONE row — pointing at an account with nothing in it pointing back,
       * which is what the editor honestly reported as "Linked transfer — no
       * other side recorded".
       *
       * Even had it run, two independent inserts are not a transfer: neither row
       * would carry linkedTransferId, so nothing would tie them together, the
       * pair could not be re-pointed or unlinked, and deleting one would leave
       * the other stranded.
       *
       * createTransferCounterpart is the operation that already exists for this
       * (an RPC in the cloud, a mirrored twin in the browser store): it writes
       * the other row, sets BOTH types to 'transfer', files BOTH sides under the
       * other account's To/From category, links them each way, moves the target
       * account's balance and writes the audit trail — atomically.
       */
      if (isTransfer && targetAccountId) {
        try {
          if (conversion) {
            /**
             * ACROSS A CURRENCY BOUNDARY THE FAR SIDE IS WRITTEN, NOT MINTED.
             *
             * `createTransferCounterpart` copies −amount into the other ledger
             * and refuses when the currencies differ, which is right and is
             * untouched: copying digits across a boundary is wrong at any rate.
             * So the two verbs that ARE legal here are composed instead — an
             * ordinary insert into the target account in the target's own
             * currency, then `link_transfer_pair`, which is balance-neutral and
             * converts nothing. Both figures came off the dialog; neither was
             * invented by the app.
             *
             * The rollback below is shared with the minted path deliberately:
             * whichever way the second leg failed to appear, the first leg is
             * a one-sided transfer and must not survive.
             */
            await recordConvertedCounterpart(
              { addTransaction, updateTransaction, linkTransferPair, deleteTransaction },
              newTransaction,
              {
                accountId: targetAccountId,
                category: transferCategoryIdFor(
                  categories,
                  account.id,
                  destinationLegAmount(amount, conversion.destinationAmount).toNumber()
                ),
              },
              conversion
            );
          } else {
            await createTransferCounterpart(newTransaction.id, targetAccountId);
          }
        } catch (counterpartError) {
          // The other side could not be made, so the row that would have been
          // its first leg must not survive: a one-sided transfer reads as a
          // real payment in an account nobody is looking at. Removing it puts
          // the user back exactly where they pressed Add.
          //
          // A failure to remove it is reported INSTEAD, and says what is now on
          // screen — because at that point there IS a half-transfer in the
          // register, and telling the user why the transfer failed while saying
          // nothing about the row it left behind would be the more misleading
          // of the two messages.
          try {
            await deleteTransaction(newTransaction.id);
          } catch {
            const reason = counterpartError instanceof Error
              ? counterpartError.message
              : 'The other side of the transfer could not be created.';
            throw new Error(
              `${reason} The row was added to this account and could not be removed — open it and use the Transfer type to finish it, or delete it.`
            );
          }
          throw counterpartError;
        }
      }

      // Reset form and error
      clearQuickAddError();
      setCrossTypeCategories(false);
      setQuickAddForm({
        date: new Date().toISOString().split('T')[0],
        description: '',
        amount: '',
        type: 'expense',
        category: '',
        tags: [],
        notes: ''
      });
    } catch (error) {
      setQuickAddError({
        field: 'form',
        message: error instanceof Error ? error.message : 'Failed to add transaction. Please try again.',
      });
    } finally {
      // In `finally` and not after the reset: a write that FAILED leaves the
      // draft on screen for the user to try again, and a latch that only
      // released on success would have locked them out of their own retry.
      quickAddInFlightRef.current = false;
    }
  };

  /**
   * The guards, in the order the row is read — and the ONLY route into
   * commitQuickAdd, so the + Add button and the Enter key cannot come to
   * different conclusions about the same draft.
   *
   * Two of the three answers are deliberately different in kind:
   *
   *   * a missing DESCRIPTION or a missing/zero AMOUNT is a BLOCK. There is no
   *     transaction to add — a nameless £0.00 row is not a record of anything —
   *     so the bar says so at the box and puts the cursor in it.
   *   * a missing CATEGORY is a QUESTION. An uncategorised transaction is a
   *     real transaction: the balance is right the moment it is in, and the
   *     review band exists to file it later. Blocking it would make the app
   *     refuse work it is perfectly able to do.
   *
   * A transfer's blank field is a BLOCK rather than that question, because on
   * a transfer that box is not a category at all — it is the other account, and
   * there is no such thing as half a transfer.
   */
  const submitQuickAdd = async (): Promise<void> => {
    clearQuickAddError();
    if (!account) return;

    if (!quickAddForm.description.trim()) {
      setQuickAddError({ field: 'description', message: 'Please enter a description' });
      focusQuickAddField('description');
      return;
    }

    // Decimal, not a float compare: "0.00", "0" and ".00" are all the same
    // nothing, and an unparseable amount is not a number at all.
    const parsedAmount = parseMoneyInput(quickAddForm.amount);
    if (parsedAmount === null || toDecimal(parsedAmount).isZero()) {
      setQuickAddError({ field: 'amount', message: 'Please enter an amount' });
      focusQuickAddField('amount');
      return;
    }

    if (quickAddForm.type === 'transfer' && !quickAddForm.category) {
      setQuickAddError({ field: 'category', message: 'Please choose the account to transfer to' });
      return;
    }

    /**
     * THE INVARIANT, CHECKED WHERE IT IS ABOUT TO BE WRITTEN.
     *
     * By here a transfer category should already have flipped the type — the
     * picker does it as it is chosen, and Ctrl+D does it as a row is copied.
     * This is the belt to those braces, and it is not ceremony: `category` is a
     * plain string in this form and more than one thing puts ids into it. A
     * check at the door of the only write means no future filler can reintroduce
     * a row whose type and category disagree, whatever it does upstream.
     *
     * Converted rather than refused where a target can be resolved, because the
     * user's instruction is unambiguous ("this money went to that account") and
     * refusing a clear instruction to protect an invariant is the app arguing
     * with itself. Refused, loudly, only where no target exists.
     */
    let target = quickAddForm.type === 'transfer' ? quickAddForm.category : '';
    let convertedDraft: Partial<typeof quickAddForm> = {};
    if (quickAddForm.type !== 'transfer') {
      const choice = classifyTransferCategoryChoice(categories, quickAddForm.category, account.id);
      if (choice.kind === 'refuse') {
        setQuickAddError({ field: 'category', message: choice.message });
        return;
      }
      if (choice.kind === 'convert') {
        target = choice.targetAccountId;
        convertedDraft = { type: 'transfer', category: choice.targetAccountId };
        setCrossTypeCategories(false);
        setQuickAddForm(form => ({ ...form, ...convertedDraft }));
      }
    }

    /**
     * The currency boundary, asked about BEFORE the first write.
     *
     * This was a refusal until 2026-08-12, and the reason it could not simply
     * be dropped is that `createTransferCounterpart` — the one-call route the
     * same-currency dock takes — mints the far side by copying −amount, so a
     * dollar row would have moved a sterling account by the same digits. That
     * guard is right and stays. What changes is that there is now somewhere to
     * go: the person is asked what arrived, and the confirmed pair is written
     * explicitly by `commitQuickAdd`'s conversion branch.
     *
     * Still before the first write, and for the reason the refusal was: a
     * create-then-delete would leave two audit entries for a transfer that
     * never existed, and a cancelled dialog should cost nothing at all.
     */
    if (target) {
      const crossed = crossedCurrencies(accounts, account.id, target);
      if (crossed) {
        setPendingConversion({ target, draft: convertedDraft, ...crossed });
        return;
      }
    }

    if (target) {
      await commitQuickAdd(convertedDraft);
      return;
    }

    if (!quickAddForm.category) {
      setConfirmUncategorised({ description: quickAddForm.description.trim() });
      return;
    }

    await commitQuickAdd();
  };

  const handleQuickAdd = (e: React.FormEvent): void => {
    e.preventDefault();
    void submitQuickAdd();
  };

  /**
   * Enter, from anywhere in the add bar, is + Add — the Microsoft Money
   * register, where a row is committed by finishing it rather than by reaching
   * for a button.
   *
   * Three keystrokes are deliberately NOT claimed:
   *
   *   * one already answered — `defaultPrevented` is how an OPEN category or
   *     account list says "that Enter chose an option and closed me". Reading
   *     the flag rather than tracking the pickers' state keeps the two from
   *     ever disagreeing about who owns the key;
   *   * one on a BUTTON — Enter activates the focused control, and the Type
   *     toggle and + Add are controls. (+ Add submits, which lands here anyway.)
   *   * one with a modifier held, which is somebody's shortcut, not this form's.
   *
   * A REPEAT — the same key still held down — is refused outright: leaning on
   * Enter is one gesture, not forty transactions. (commitQuickAdd latches as
   * well, for the two presses a fast hand can genuinely make.)
   */
  const handleQuickAddKeyDown = (e: React.KeyboardEvent<HTMLFormElement>): void => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.repeat) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    void submitQuickAdd();
  };

  /**
   * What deleting the row in the confirmation would leave behind in ANOTHER
   * account — null for an ordinary row, and then the dialog says nothing extra.
   *
   * The same warning the full editor's delete carries, for the same reason:
   * the counterpart of a linked transfer survives, still moving that account's
   * balance, released out of the transfer it was half of. A delete reached in
   * two keystrokes must not be less informed than one reached through the
   * editor — and it carries the same offer to remove the whole movement, which
   * `deletableOtherSide` is what decides.
   */
  const deleteStranding = useMemo(
    () => describeDeleteStranding(deleteConfirmTransaction, transactions, accounts),
    [deleteConfirmTransaction, transactions, accounts]
  );

  /**
   * Move the highlight off a row that is about to leave the list.
   *
   * Worked out BEFORE the row goes. Deleting from the keyboard must not
   * dead-end: the register leaves you on the row that takes the deleted one's
   * place (the last row's predecessor), ready for the next Delete.
   */
  const advanceSelectionPast = useCallback((targetId: string) => {
    if (selectedTransactionId !== targetId) return;
    const successorId = getNextTransactionId(targetId) ?? getPreviousTransactionId(targetId);
    setSelectedTransactionId(successorId);
    setSelectedTransaction(successorId ? transactionsWithBalance.find(t => t.id === successorId) ?? null : null);
    // 'nearest', which here means "don't move": the successor takes the deleted
    // row's own place on screen, so there is nothing to scroll to and centring
    // would move the register for no reason at all.
    setRowScroll(previous => (successorId ? nextRowScroll(previous, successorId, 'nearest') : null));
  }, [
    getNextTransactionId, getPreviousTransactionId, selectedTransactionId, transactionsWithBalance
  ]);

  /**
   * The highlight moves and the dialog closes SYNCHRONOUSLY — everything before
   * the first await — so the keyboard loop (Delete, Enter, Delete, Enter) is not
   * waiting on a round trip. Only the reporting is asynchronous, and it exists
   * because a delete that fails used to say nothing at all: the row stayed, the
   * dialog went, and the only trace was an unhandled rejection in the console.
   */
  const handleDeleteConfirm = useCallback(async (): Promise<void> => {
    const target = deleteConfirmTransaction;
    if (!target) return;
    advanceSelectionPast(target.id);
    setDeleteConfirmTransaction(null);
    try {
      await deleteTransaction(target.id);
    } catch (error) {
      showError(error);
    }
  }, [advanceSelectionPast, deleteConfirmTransaction, deleteTransaction, showError]);

  /**
   * Delete the whole movement: this leg and the one facing it.
   *
   * Offered only when the other half is a row this register can see and can
   * safely take with it — the planner decides that, not this handler. The
   * sequencing and the partial-failure wording live in deleteTransferPair,
   * beside the release rule they depend on, so the editor's copy of this button
   * cannot end up saying something different.
   *
   * showWarning rather than showError for a half-done delete, for a mechanical
   * reason as well as a tonal one: getUserFriendlyError replaces any message
   * over 100 characters with "An error occurred", and the whole value of this
   * report is the sentence that says which side survived and what it now is.
   */
  const handleDeleteBothSidesConfirm = useCallback(async (): Promise<void> => {
    const target = deleteConfirmTransaction;
    const otherSide = deleteStranding?.deletableOtherSide;
    if (!target || !otherSide) return;
    advanceSelectionPast(target.id);
    setDeleteConfirmTransaction(null);
    const result = await deleteTransferPair(
      target,
      otherSide,
      deleteStranding?.accountName,
      { deleteTransaction }
    );
    if (result.kind === 'nothing-deleted') showError(result.error);
    if (result.kind === 'one-deleted') showWarning(result.message, 'Only one side was deleted');
  }, [
    advanceSelectionPast, deleteConfirmTransaction, deleteStranding, deleteTransaction,
    showError, showWarning
  ]);

  /**
   * Carry out the bulk delete the confirmation was answered for.
   *
   * The PLAN is what runs — not the current selection — so what happens is
   * exactly what the dialog described, even if something re-rendered
   * underneath it. Rows are deleted one at a time down the same audited
   * deleteTransaction the single delete uses; a row that fails is counted out
   * rather than aborting the rest, and the first failure is shown, so nobody
   * is left with a half-finished batch and no idea which half.
   */
  const handleBulkDeleteConfirm = useCallback(async (): Promise<void> => {
    const plan = bulkDeletePlan;
    if (!plan || plan.deleting.length === 0) return;
    setBulkBusy(true);
    let deleted = 0;
    let firstError: unknown = null;
    try {
      for (const transaction of plan.deleting) {
        try {
          await deleteTransaction(transaction.id);
          deleted += 1;
        } catch (error) {
          if (firstError === null) firstError = error;
        }
      }
    } finally {
      setBulkBusy(false);
      setBulkDeletePlan(null);
      // The rows that were highlighted are gone; leaving the highlight
      // pointing at them would show the add bar over an empty selection.
      clearSelection();
    }
    if (deleted > 0) {
      showSuccess(deleted === 1 ? 'Deleted 1 transaction.' : `Deleted ${deleted} transactions.`);
    }
    if (firstError !== null) showError(firstError);
  }, [bulkDeletePlan, deleteTransaction, clearSelection, showSuccess, showError]);
  
  // Define table columns for VirtualizedTable (base definitions; order + widths
  // are applied below from the persisted layout).
  const baseColumns: Column<DisplayRow>[] = useMemo(() => [
    {
      key: 'date',
      header: 'Date',
      // Wide enough for the widest dd/mm/yyyy Inter can draw, in both the
      // read-only cell and the picker the cell becomes while the row is being
      // edited. The whole sum — and the measurements it rests on — is in
      // registerDateColumn.
      width: `${DATE_COLUMN_WIDTH_PX}px`,
      accessor: (transaction) => (
        <span className={`text-sm text-gray-900 dark:text-white ${
          // Microsoft Money's convention, and the only one this register needed:
          // a row that has just arrived is bold until somebody saves it. Date
          // and Description carry it and nothing else does — two cells at
          // opposite ends of the row make the line read as bold at a glance,
          // while bolding every cell would fight the amounts (which use weight
          // for money in/out) and the amber suggestion badge.
          isOpeningBalanceRow(transaction) || !isAwaitingReview(transaction)
            ? ''
            : 'font-semibold'
        }`}>
          {isOpeningBalanceRow(transaction) && transaction.noDateSet
            ? <span className="italic text-gray-400">no date set</span>
            : formatShortDate(transaction.date)}
        </span>
      ),
      className: 'text-center',
      headerClassName: 'text-center',
      sortable: true
    },
    {
      key: 'reconciled',
      // Microsoft Money's own column, and its own two letters: C is a mark made
      // while balancing, R is a reconciliation that was finished. One tick for
      // both was what let a working mark pass for settled work.
      header: 'C/R',
      width: '35px',
      accessor: (transaction) => (
        isReconciled(transaction) ? (
          /* The C/R letters are law; their colour never was (stock-blue ruling,
             28 Aug §4 — the same finding that neutralised the reconciliation
             list's chips). R wore the stock blue on every settled row, and a
             mark carried by 7,240 rows at once marks nothing. R keeps its
             distinction from C as a DEEPER ink in the one neutral family, not
             as a hue: the letter is what tells them apart. */
          <span className="text-gray-700 dark:text-gray-200 font-semibold" title="Reconciled">R</span>
        ) : transaction.cleared ? (
          <span
            className="text-gray-500 dark:text-gray-400 font-semibold"
            title="Marked while balancing — not reconciled until you finalize"
          >
            C
          </span>
        ) : (
          // THE COLUMN'S BASELINE. Unmarked used to be nothing at all, which
          // left a law-bearing column reading as an empty gutter — and with
          // nothing to change FROM, a C or an R arriving in it registered as
          // "something in the gap" rather than as a state changing. A dimmed
          // dot gives the column a floor: the eye learns where the marks live
          // before there are any. Decorative, so it is hidden from a screen
          // reader, which is told the truth by the absence of C or R.
          // (DESIGN_PASS §3.1 FIX, TEST-GATED.)
          <span aria-hidden="true" className="text-line-strong dark:text-gray-600">·</span>
        )
      ),
      className: 'text-center',
      headerClassName: 'text-center'
    },
    {
      key: 'description',
      header: 'Description',
      width: undefined, // flex column — uses flex:1 via className
      accessor: (transaction) => {
        const awaitingReview = !isOpeningBalanceRow(transaction) && isAwaitingReview(transaction);
        return (
          <div className="flex items-center gap-2 min-w-0">
            <span className={`text-sm text-gray-900 dark:text-white truncate ${
              awaitingReview ? 'font-semibold' : ''
            }`}>
              {transaction.description}
            </span>
            {/* WEIGHT IS A VISUAL CUE AND NOTHING ELSE (WCAG 1.4.1, and the
                same reasoning as SuggestedCategoryBadge's sr-only clause). Bold
                is invisible to a screen reader and to anyone reading the
                register one row at a time in a magnifier, so the fact is also
                stated in words — off-screen, because on-screen it would be a
                second marker for one fact and the whole point of the bold is
                that it costs the row no space. */}
            {awaitingReview && <span className="sr-only">— awaiting review</span>}
          </div>
        );
      },
      className: 'flex-1 min-w-0',
      headerClassName: 'flex-1 min-w-0',
      sortable: true,
      // The flex filler: it absorbs the slack when other columns are resized, so
      // it has no resize handle of its own.
      resizable: false
    },
    {
      key: 'category',
      header: 'Category',
      width: '280px',
      accessor: (transaction) => {
        // The SAME resolver the sort orders this column by — see categoryLabel.
        const name = categoryLabel(transaction);
        // The opening-balance lead line is a summary, not a transaction: it has
        // no category and nothing to vouch for.
        const suggested = !isOpeningBalanceRow(transaction) && isConfirmableSuggestion(transaction);
        if (!suggested) {
          // A category the user stands behind gets NO extra chrome. Whatever is
          // marked in a register has to be rare, or the marking says nothing.
          return (
            <span className="text-sm text-gray-600 dark:text-gray-400 truncate block">
              {name}
            </span>
          );
        }
        return (
          // The badge sits AFTER the name and never shrinks: the names keep one
          // left edge down the column (a ragged one is unreadable at a glance),
          // and the amber still stands out where the guesses are. The name is
          // what gives way when the column is dragged narrow — it is also the
          // part the row's own tooltip and the dock below repeat.
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm text-gray-600 dark:text-gray-400 truncate">
              {name}
            </span>
            <SuggestedCategoryBadge title="The app filled this in. Click the row to confirm it or pick a different category." />
          </span>
        );
      },
      className: 'text-left',
      headerClassName: 'text-left',
      sortable: true
    },
    {
      key: 'tags',
      header: 'Tags',
      width: '120px',
      accessor: (transaction) => (
        <div className="flex flex-wrap gap-1 overflow-hidden max-h-[1.5rem] justify-center">
          {transaction.tags?.map((tag: string, idx: number) => (
            <span
              key={idx}
              className="inline-flex items-center px-1.5 py-0 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
            >
              {tag}
            </span>
          ))}
        </div>
      ),
      className: 'text-center',
      headerClassName: 'text-center',
      sortable: true
    },
    {
      key: 'payment',
      header: 'Payment',
      // 130px fits a 7-figure amount with pennies; Description is the flex
      // column, so the extra width comes out of it automatically.
      width: '130px',
      // Money out — the magnitude (no sign), in red, like MS Money's Payment
      // column. WEIGHT 400: colour already says which direction this is, and
      // the column that carries the weight is Balance (DESIGN_PASS §3.1
      // PROMOTE). The token, not text-red-600, so the AA-instrumented value is
      // the one on screen.
      accessor: (transaction) => (
        transaction.amount < 0 ? (
          <span className="text-sm font-normal text-expense dark:text-red-400">
            {formatRegisterMoney(Math.abs(transaction.amount))}
          </span>
        ) : null
      ),
      className: 'text-right',
      headerClassName: 'text-right',
      sortable: true
    },
    {
      key: 'deposit',
      header: 'Deposit',
      width: '130px',
      // Money in — in green, like MS Money's Deposit column. Weight 400, as
      // Payment above.
      accessor: (transaction) => (
        transaction.amount > 0 ? (
          <span className="text-sm font-normal text-income dark:text-green-400">
            {formatRegisterMoney(transaction.amount)}
          </span>
        ) : null
      ),
      className: 'text-right',
      headerClassName: 'text-right',
      sortable: true
    },
    {
      // Single signed Amount column (off by default; Payment/Deposit replace it).
      key: 'amount',
      header: 'Amount',
      width: '120px',
      accessor: (transaction) => (
        <span className={`text-sm font-normal ${
          transaction.amount > 0
            ? 'text-income dark:text-green-400'
            : transaction.amount < 0
            ? 'text-expense dark:text-red-400'
            : 'text-gray-900 dark:text-gray-100'
        }`}>
          {formatRegisterMoney(transaction.amount)}
        </span>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
      sortable: true
    },
    {
      key: 'notes',
      header: 'Notes',
      width: '200px',
      accessor: (transaction) => {
        const notes = 'notes' in transaction ? transaction.notes : undefined;
        return (
          <span className="text-sm text-gray-600 dark:text-gray-400 truncate block" title={notes || ''}>
            {notes || ''}
          </span>
        );
      },
      className: 'text-left',
      headerClassName: 'text-left',
      sortable: true
    },
    {
      key: 'balance',
      header: 'Balance',
      // The register's rightmost column: room for a signed 7-figure running
      // balance ("-£1,234,567.89") without truncating at the table edge.
      width: '140px',
      accessor: (transaction) => (
        // data-testid: the column's whole contract is that the rows and the
        // balances are in the same order, and the only way to hold that to
        // account is to read the figures off in rendered order.
        <span
          data-testid="register-balance"
          // THE LINE PEOPLE ACTUALLY TRACK, and until now the hardest of the
          // three money columns to find: all of them shared one weight, so
          // the running balance was just more figures. 500 in the navy-900
          // family — colour says direction, weight says "this is the line"
          // (DESIGN_PASS §3.1 PROMOTE). Negative still reads red, because an
          // overdrawn balance is a fact about the money and not a decoration.
          className={`text-sm font-medium ${
            transaction.balance < 0
              ? 'text-expense dark:text-red-400'
              : 'text-primary dark:text-gray-100'
          }`}
        >
          {formatRegisterMoney(transaction.balance)}
        </span>
      ),
      className: 'text-right',
      headerClassName: 'text-right'
    }
  ], [formatRegisterMoney, categoryLabel]);

  // Apply the persisted order + widths on top of the base definitions.
  const columns: Column<DisplayRow>[] = useMemo(() => {
    const baseKeys = baseColumns.map(c => c.key);
    const byKey = new Map(baseColumns.map(c => [c.key, c] as const));
    const hidden = new Set(hiddenColumns);
    return orderColumnKeys(baseKeys, columnOrder)
      .filter(key => !hidden.has(key))
      .map(key => byKey.get(key))
      .filter((c): c is Column<DisplayRow> => Boolean(c))
      .map(c => (columnWidths[c.key] != null ? { ...c, width: columnWidths[c.key] } : c));
  }, [baseColumns, columnOrder, columnWidths, hiddenColumns]);

  const handleColumnReorder = useCallback((fromKey: string, toKey: string) => {
    setColumnOrder(prev => moveColumnKey(orderColumnKeys(baseColumns.map(c => c.key), prev), fromKey, toKey));
  }, [baseColumns]);

  /**
   * Which fields the row can actually offer, in the order the register draws
   * them.
   *
   * A column switched off in the View menu takes its editor with it: there is
   * nowhere in the row for a field whose column is not on screen, and an editor
   * that floated one somewhere else would be the very thing this change got rid
   * of. Nothing is lost — Enter opens the full editor, which reaches every
   * field of every row — and a keyboard run lands on a field that exists (see
   * the editor's resolveField).
   */
  const quickEditFields = useMemo<QuickEditField[]>(() => {
    const shown = new Set(columns.map(c => c.key));
    return (['date', 'description', 'category', 'notes'] as const).filter(field => {
      if (!shown.has(field)) return false;
      return field !== 'category' || canEditCategoryInPlace;
    });
  }, [columns, canEditCategoryInPlace]);
  // A phone card has no column choices to honour: every field, every time.
  const phoneQuickEditFields = useMemo<QuickEditField[]>(
    () => (['date', 'description', 'category', 'notes'] as const).filter(
      field => field !== 'category' || canEditCategoryInPlace
    ),
    [canEditCategoryInPlace]
  );

  /**
   * The row editor, as the register draws it: the row's own Date, Description
   * and Category cells become the controls, and a slim strip beneath the row
   * carries the actions, pushing every row below down by exactly its height.
   *
   * Microsoft Money's shape, and the reason the register can be worked down
   * without the eye ever leaving the line being edited.
   */
  const quickEditRowDetail = useMemo<RowDetail<DisplayRow> | null>(() => {
    // ONE editor on screen at a time. Both layouts are always in the DOM and
    // CSS chooses which is seen, so on a phone the table's editor cells must
    // not mount underneath the card's — the field refs would land on the
    // hidden copy and the cursor with them. The phone list gates its card the
    // same way, on the same flag.
    if (!quickEditRow || isPhoneLayout) return null;
    const editableFields = new Set(quickEditFields);
    return {
      key: quickEditRow.id,
      height: QUICK_EDIT_STRIP_HEIGHT,
      rowHeight: QUICK_EDIT_ROW_HEIGHT,
      renderCell: (columnKey) => {
        const field = QUICK_EDIT_COLUMN_FIELDS[columnKey];
        // undefined, not null: "this column is none of the editor's business",
        // which leaves the cell reading exactly as it did.
        if (!field || !editableFields.has(field)) return undefined;
        return <QuickEditFieldCell field={field} />;
      },
      render: () => <QuickEditActionStrip />,
    };
  }, [quickEditRow, quickEditFields, isPhoneLayout]);

  if (!account) {
    // Still finding out which of the three it is — the open list may not have
    // arrived, or the closed lookup may be in flight. Saying "not found" here
    // would flash an error at an account that exists.
    // Spelled out rather than read off registerIsResolving, which carries the
    // same answer but does not narrow closedLookup for the branches below it.
    if (isLoading || closedLookup.status !== 'done') {
      // SHAPE, NOT SPINNER — and only once the wait has earned it. The rows
      // are drawn at the height and the column widths the real ones will
      // have, so the register does not jump when they arrive (DESIGN_PASS §4).
      return showRegisterSkeleton
        ? (
          <div className="hidden lg:block">
            <TableSkeleton columns={columns} rowHeight={compactView ? 36 : 44} />
          </div>
        )
        : null;
    }

    // Closed: an honest page, not an error. Its history is intact; what it
    // hasn't got is an open register (the same rule as the Accounts page,
    // where a closed account offers Reopen rather than a way in).
    if (closedLookup.account) {
      const closedAccount = closedLookup.account;
      return (
        <div className="flex flex-col h-full">
          {/* No back-arrow chrome above the card: the actions below ARE the
              page, and a second back button would only duplicate one. */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700 p-6 max-w-2xl">
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">
              {closedAccount.name}
            </h1>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              This account is closed, and closed accounts don&rsquo;t have an open register.
              To see its transactions the account must be re-opened first. Nothing else
              changes — every transaction is preserved either way, and you can close it
              again from the Accounts page whenever you&rsquo;re done.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => { void handleReopenAccount(); }}
                disabled={reopening}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-primary-action text-on-primary-action hover:bg-primary-action-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {reopening ? 'Re-opening…' : 'Re-open and view'}
              </button>
              {/* Settings WITHOUT reopening (owner, 22 Aug: "if I want to
                  change in what group that account sits without re-opening I
                  can go in to its settings") — the same no-round-trip rule
                  the Accounts page's closed rows already follow. */}
              <button
                type="button"
                onClick={() => setShowClosedSettings(true)}
                disabled={reopening}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                <SettingsIcon size={16} />
                Account Settings
              </button>
              {/* THE WAY BACK IS WHERE THE READER CAME FROM (owner, 22 Aug):
                  reached from the net-worth report's drill, "Back to
                  Accounts" dumped him on the Accounts page mid-analysis. The
                  same provenance the open register's back button honours is
                  honoured here — the report's own path reopens the drill on
                  the date he was reading. */}
              <button
                type="button"
                onClick={() => (backTo
                  ? navigate(backTo.path, { state: returnState(backTo) })
                  : navigate(preserveDemoParam('/accounts', location.search)))}
                disabled={reopening}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                <ArrowLeftIcon size={16} />
                {backTo ? backTo.label : 'Back to Accounts'}
              </button>
            </div>
          </div>
          <AccountSettingsModal
            isOpen={showClosedSettings}
            onClose={() => setShowClosedSettings(false)}
            account={closedAccount}
            // The open accounts, which is what the pairing field pairs with —
            // the Accounts page's own rule for its closed rows.
            accounts={accounts}
            hasTransactions={accountHasHistory(transactions, closedAccount.id)}
            onSave={async (accountId, updates) => {
              await updateAccount(accountId, updates);
              if (updates.isActive === true) {
                // Reopened from settings: the re-pull flips accountIsOpen and
                // this page becomes the register on its own.
                await refreshAccountsAndTransactions();
              } else {
                // Still closed: the lookup's copy is what this page renders,
                // so refetch it and show the saved facts rather than the old
                // ones — the same read the lookup itself makes.
                const list = await dataPort.listClosedAccounts();
                setClosedLookup({ status: 'done', account: list.find(a => a.id === accountId) ?? null });
              }
              if (updates.isActive !== undefined || updates.name !== undefined) {
                await refreshCategories();
              }
            }}
          />
        </div>
      );
    }

    // Neither open nor closed: there is no such account any more.
    return (
      <div className="flex flex-col items-center justify-center h-64">
        <p className="text-gray-500 dark:text-gray-400">This account no longer exists</p>
        <button
          onClick={() => navigate(preserveDemoParam('/accounts', location.search))}
          className="mt-4 text-primary hover:text-secondary"
        >
          Return to Accounts
        </button>
      </div>
    );
  }

  // '00000000' is the placeholder an account with no number was seeded with,
  // and it is not a number anyone wants read back at them.
  const storedAccountNumber =
    account.accountNumber && account.accountNumber !== '00000000' ? account.accountNumber : '';

  // A card shows as XXXX XXXX XXXX 1234. Four digits on their own read like a
  // truncation; the mask says plainly that four digits is the whole of what is
  // held. A bank account number is a different thing — 8 real digits — so it
  // is shown as it is.
  const displayedAccountNumber = isCardAccountType(account.type)
    ? formatCardNumberForDisplay(storedAccountNumber)
    : storedAccountNumber;

  /**
   * What stands where the rows would be — and the two cases are NOT the same
   * state (DESIGN_PASS §4).
   *
   * An account with nothing in it is a beginning, and wants the two ways of
   * putting something in it. An account whose rows are all behind a filter is
   * an alarm — the register looks exactly like one that has lost its contents
   * — and wants the count that proves they still exist, the filters holding
   * them back by name, and the one control that lets go.
   */
  const registerEmptyState = fullAccountTransactions.length === 0 ? (
    transactionsLoadFailed ? (
      // A THIRD case, and it outranks the other two: the boot's transaction
      // read failed, so an empty list here is the FALLBACK, not the ledger.
      // Asserting "no transactions yet" over a full account is the same lie
      // the filtered empty state exists to prevent — "your money is gone" —
      // told by a network failure instead of a filter. Consequence first,
      // then the remedy; the remedy is a reload because the retry that can
      // fix a failed boot is the boot.
      <EmptyState
        title="This account's transactions couldn't be loaded"
        description="The last load didn't finish, so this register can't say what's in the account — nothing is missing from your ledger, it just couldn't be read this time. Trying again reloads the app."
        action={{ label: 'Try again', onClick: () => window.location.reload() }}
      />
    ) : (
    <EmptyState
      title="No transactions in this account yet"
      description={`Its balance stays at ${formatRegisterMoney(computedAccountBalance)}, and this account adds nothing to your reports until something lands here. Nothing is estimated, so nothing appears until you add it.`}
      action={{ label: 'Add transaction', onClick: () => setShowAddTransaction(true) }}
      secondaryAction={{
        label: 'Import a statement',
        onClick: () => navigate(preserveDemoParam('/enhanced-import', location.search))
      }}
    />
    )
  ) : (
    <FilteredEmptyState
      hiddenCount={fullAccountTransactions.length}
      filters={activeFilterNames}
      onClear={clearAllFilters}
    />
  );

  return (
    <div className="flex flex-col h-full">
      {/* The way back.
          Normally to the accounts list; but a register reached from somewhere
          that said where it came from returns THERE instead, restored — the
          duplicate sweep reopens on the pair the user jumped from rather than
          leaving them on a settings page with the dialog gone. See
          utils/navigationProvenance. */}
      <button
        onClick={() => (backTo
          ? navigate(backTo.path, { state: returnState(backTo) })
          : navigate(preserveDemoParam('/accounts', location.search)))}
        className="flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 mb-3 self-start"
      >
        <ArrowLeftIcon size={16} />
        <span className="text-sm">{backTo ? backTo.label : 'Back to Accounts'}</span>
      </button>

      {/* Compact header with inline stat boxes. flex-wrap: the three stat
          pills need ~450px, so on a phone they used to paint straight over
          the account name — wrapped, they take their own rows beneath it. */}
      <div className="bg-[#1a2332] dark:bg-gray-700 rounded-2xl shadow px-4 py-3 mb-4 flex flex-wrap items-center justify-between gap-3 lg:gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-white leading-tight">
                {account.name}
              </h1>
              <button
                onClick={() => setShowAccountSettings(true)}
                className="p-1 text-white/50 hover:text-white transition-colors"
                title="Account Settings"
                type="button"
              >
                <SettingsIcon size={16} />
              </button>
            </div>
            {(account.sortCode && account.sortCode !== '000000') || displayedAccountNumber ? (
              <div className="flex items-center gap-3 mt-0.5">
                {account.sortCode && account.sortCode !== '000000' && (
                  <span className="text-xs text-white/70">{account.sortCode}</span>
                )}
                {displayedAccountNumber && (
                  <span className="text-xs text-white/70">{displayedAccountNumber}</span>
                )}
              </div>
            ) : null}
          </div>
        </div>

        {/* One pill per row on a phone, all the same width, label left and
            figure right — they used to wrap into ragged rows of unequal
            pills. From lg they sit inline beside the title as before. */}
        <div className="grid grid-cols-1 gap-2 w-full lg:w-auto lg:flex lg:flex-wrap lg:items-center">
          {/* Four pills, four <StatPill>s — the register keeps its own
              ARRANGEMENT (a header strip, label beside figure) and shares only
              the pair. The design ruling was explicit that this header must not
              become the net-worth summary card: `bank − ledger = difference` in
              one account's own currency is a different statement from
              `assets − liabilities = net worth` across all of them.

              Two of these four can be UNKNOWN rather than zero — an account
              with no bank feed has no bank balance — which used to print "N/A"
              and now prints an em-dash, uncoloured. */}
          <div className="bg-white/90 dark:bg-gray-800/90 backdrop-blur-xl rounded-lg border border-gray-100 dark:border-gray-700 px-3 py-1.5">
            {/* NEUTRAL — a balance is a MAGNITUDE (Claude Design §5). This
                read `>= 0 ? positive : negative`, so £0.00 printed in income
                green, and the rule this app already carries is that the hues
                are banned on magnitudes and permitted on directions. How much
                is in the account is not a direction; on a credit card the
                green would have been actively wrong. Net Worth on the summary
                card is neutral for the same reason. */}
            <StatPill
              label="Account Balance"
              value={formatRegisterMoney(computedAccountBalance)}
              tone="neutral"
              layout="inline"
            />
          </div>

          <div className="bg-white/90 dark:bg-gray-800/90 backdrop-blur-xl rounded-lg border border-gray-100 dark:border-gray-700 px-3 py-1.5">
            {/* Same rule, and Design's own instruction to check the siblings
                found it: what the BANK says is in the account is a magnitude
                too, and it was carrying the same green. */}
            <StatPill
              label="Bank Balance"
              value={bankBalance != null ? formatRegisterMoney(bankBalance) : null}
              tone="neutral"
              layout="inline"
            />
          </div>

          <div className="bg-white/90 dark:bg-gray-800/90 backdrop-blur-xl rounded-lg border border-gray-100 dark:border-gray-700 px-3 py-1.5">
            <StatPill
              label="Unreconciled"
              value={formatRegisterMoney(unreconciledTotal)}
              layout="inline"
            />
          </div>

          <div className="bg-white/90 dark:bg-gray-800/90 backdrop-blur-xl rounded-lg border border-gray-100 dark:border-gray-700 px-3 py-1.5">
            <StatPill
              label="Difference"
              value={bankBalance != null ? formatRegisterMoney(bankBalance - computedAccountBalance) : null}
              // Agreed is the good outcome here, and it is not "positive money"
              // — it is settled. Anything else is a gap to explain.
              tone={bankBalance != null && bankBalance - computedAccountBalance === 0 ? 'settled' : 'negative'}
              layout="inline"
            />
          </div>
        </div>
      </div>

      {/* The reason the dashboard sent them here, said where the money is. */}
      {attentionReason && (
        <div
          className="flex items-start gap-3 rounded-xl border border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-900/20 px-4 py-3"
          role="status"
          data-testid="account-attention-banner"
        >
          <AlertCircleIcon size={18} className="text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <p className="text-sm text-gray-700 dark:text-gray-200">{attentionReason}</p>
        </div>
      )}

      {/* Main content — single-viewport layout: toolbar, table, bottom dock */}
      <div className="flex flex-col gap-3">
      {/* Toolbar: what the register SHOWS on the left, what it DOES on the
          right — Add last, in the rightmost seat, the way every other page in
          the app puts its primary action, and since DESIGN_PASS §3.1 the only
          thing in that seat. Everything else is one quiet outline (see
          TOOLBAR_QUIET_BUTTON), grouped left at 8px. On a phone the buttons
          share the row in equal thirds with short labels — the full wording
          wrapped inside the buttons and gave each a different height — and a
          fourth wraps to the next line, exactly as Show archived already
          does. */}
      {/* relative: the View panel spans THIS row edge to edge on a phone —
          see its own comment. Positioning context only; nothing else moves. */}
      <div className="relative grid grid-cols-3 items-stretch gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-between">
        {/* display:contents on phones dissolves this wrapper so every button
            inside it is an equal grid cell of the row above; from sm it is the
            left cluster again. */}
        <div className="contents sm:flex sm:items-center sm:gap-2">
        <button
          onClick={() => setShowFilters(prev => !prev)}
          className={`${TOOLBAR_QUIET_BUTTON} ${TOOLBAR_QUIET_IDLE}`}
        >
          <FilterIcon size={14} />
          <span className="sm:hidden">Filters</span>
          <span className="hidden sm:inline">Search &amp; filters</span>
          {(searchTerm || typeFilter !== 'all' || dateFrom || dateTo || recurringPayeeFilter) && (
            /* The dot says this button is SWITCHED ON, so it wears the switched-on
               colours this toolbar already declares — see TOOLBAR_QUIET_ACTIVE.
               A stock blue here was a sixth invented highlight (stock-blue
               ruling, 28 Aug). */
            <span className="w-2 h-2 rounded-full bg-[#1a2332] dark:bg-[#94a3b8]" title="Filters active" />
          )}
          {showFilters ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
        </button>

        {/* ARRIVED FROM A RECURRING PATTERN — the register is narrowed to
            its payments, and must say so while showing rows, not only when
            empty (batch-7: a filtered register must never read as the whole
            account). The one control lets go of just this filter. */}
        {recurringPayeeFilter && (
          <button
            onClick={() => setRecurringPayeeFilter(null)}
            className={`${TOOLBAR_QUIET_BUTTON} ${TOOLBAR_QUIET_ACTIVE}`}
            title="Showing one recurring pattern's payments — click to show the whole register"
          >
            Recurring payee: {recurringPayeeFilter[0]}
            {recurringPayeeFilter.length > 1 ? ' (including former names)' : ''} ✕
          </button>
        )}

        {/* Soft-archive toggle — only when this account has archived history */}
        {hasArchivedHere && (
          <button
            onClick={() => setShowArchived(prev => !prev)}
            className={`${TOOLBAR_QUIET_BUTTON} ${showArchived ? TOOLBAR_QUIET_ACTIVE : TOOLBAR_QUIET_IDLE}`}
            title="Archived transactions are hidden from the live list but never deleted"
          >
            <EyeIcon size={14} />
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
        )}

        {/* View: choose which columns to show, and how far back to list */}
        <div className="static sm:relative flex" ref={viewRef}>
          <button
            onClick={() => setShowView(prev => !prev)}
            className={`${TOOLBAR_QUIET_BUTTON} ${TOOLBAR_QUIET_IDLE}`}
          >
            <EyeIcon size={14} />
            View
            {archive.range !== 'all' && (
              /* Same dot, same reason as the Filters one above. */
              <span className="w-2 h-2 rounded-full bg-[#1a2332] dark:bg-[#94a3b8]" title="Showing a limited date range" />
            )}
            {showView ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
          </button>
          {/* FULL TOOLBAR WIDTH on a phone: the button's place in the row
              depends on how the toolbar wrapped, so anchoring 256px to either
              of its edges clips one way or the other (measured both: 150px
              off the right, then 14px off the left). The wrapper goes static
              below sm, the panel anchors to the toolbar row and spans it —
              found adding the Order section (owner item 9). Desktop keeps
              the anchored w-64 it always had. */}
          {showView && (
            <div className="absolute z-50 mt-1 left-0 right-0 w-auto top-full sm:top-auto sm:right-auto sm:w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl shadow-lg p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Columns</p>
              <div className="max-h-52 overflow-y-auto -mx-1 px-1">
                {baseColumns.map(col => (
                  <label key={col.key} className="flex items-center gap-2 py-1 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!hiddenColumns.includes(col.key)}
                      onChange={() => toggleColumn(col.key)}
                      className="rounded border-gray-300 dark:border-gray-600"
                    />
                    {COLUMN_LABELS[col.key] ?? col.header}
                  </label>
                ))}
              </div>
              {/* ORDER — phone only (owner, 26 Aug, item 9): the desktop
                  sorts by clicking column headers, which a card list does not
                  have. Six orders, each named by what ARRIVES FIRST, because
                  "descending" makes a thumb stop and think. Picking any of
                  them marks the order as CHOSEN, which stands the phone's
                  newest-first default reversal down — see phoneSortChosen. */}
              <div className="sm:hidden mt-2 pt-2 border-t border-gray-100 dark:border-gray-700">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Order</p>
                {([
                  { label: 'Date — newest first', field: 'date', direction: 'desc' },
                  { label: 'Date — oldest first', field: 'date', direction: 'asc' },
                  { label: 'Description — A to Z', field: 'description', direction: 'asc' },
                  { label: 'Description — Z to A', field: 'description', direction: 'desc' },
                  { label: 'Amount — largest first', field: 'amount', direction: 'desc' },
                  { label: 'Amount — smallest first', field: 'amount', direction: 'asc' },
                ] as const).map(option => (
                  <label key={option.label} className="flex items-center gap-2 py-1 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
                    <input
                      type="radio"
                      name="phone-order"
                      checked={
                        sortField === option.field &&
                        (phoneSortChosen
                          ? sortDirection === option.direction
                          // The unchosen default (date ascending, reversed for
                          // the phone) DISPLAYS newest first, so that is the
                          // radio it honestly matches.
                          : option.direction === 'desc' && option.field === 'date')
                      }
                      onChange={() => {
                        setSortField(option.field);
                        setSortDirection(option.direction);
                        setPhoneSortChosen(true);
                      }}
                      className="border-gray-300 dark:border-gray-600"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
              <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Show</p>
                {ARCHIVE_PRESETS.map(preset => (
                  <label key={preset.value} className="flex items-center gap-2 py-1 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
                    <input
                      type="radio"
                      name="archive-range"
                      checked={archive.range === preset.value}
                      onChange={() => setArchive(prev => ({ ...prev, range: preset.value }))}
                      className="border-gray-300 dark:border-gray-600"
                    />
                    {preset.label}
                  </label>
                ))}
                {archive.range === 'custom' && (
                  <div className="mt-2 space-y-2 pl-6">
                    <div>
                      <span className="block text-[11px] text-gray-500 dark:text-gray-400 mb-0.5">From</span>
                      <DatePicker
                        value={archive.from}
                        onChange={(v) => setArchive(prev => ({ ...prev, from: v }))}
                        className="text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg"
                        aria-label="Archive from date"
                      />
                    </div>
                    <div>
                      <span className="block text-[11px] text-gray-500 dark:text-gray-400 mb-0.5">To</span>
                      <DatePicker
                        value={archive.to}
                        onChange={(v) => setArchive(prev => ({ ...prev, to: v }))}
                        className="text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg"
                        aria-label="Archive to date"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* The shortcut list, reachable with a mouse. `?` opens the same
                  dialog, but only someone who already knows about it will ever
                  press `?` — so it lives here too, beside the other things
                  that change how the register behaves. Desktop only: this is
                  where the keyboard-driven table is. */}
              <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700 hidden lg:block">
                <button
                  type="button"
                  onClick={() => { setShowView(false); setShowShortcuts(true); }}
                  className="w-full flex items-center gap-2 py-1 text-sm text-gray-700 dark:text-gray-200 hover:text-[#1a2332] dark:hover:text-gray-100"
                >
                  <KeyboardIcon size={14} />
                  Keyboard shortcuts
                  <kbd className="ml-auto px-1.5 py-0.5 text-[11px] font-semibold rounded border border-gray-300 bg-gray-100 text-gray-700 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200">
                    ?
                  </kbd>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* To Review — how many rows have arrived and not been dealt with, and
            the switch that narrows the register to exactly them.

            NOTHING AT ZERO. Not a greyed-out button, not "To Review 0" — the
            house rule is that a zero count renders nothing, because a permanent
            box reading 0 is a box the eye learns to skip, and then it says
            nothing on the day it reads 40. Its absence is the "all done", which
            is why finishing the last row makes it disappear (and, in the effect
            beside toReviewCount, drops the filter with it rather than leaving
            an empty register behind).

            Beside View rather than in it: this is a job, not a preference. */}
        {/* THE NEXT JOB, where the last one stood. With nothing left to review
            and rows still to tick, the slot To Review occupied offers the
            reconciliation for THIS account — straight there, not back to the
            Accounts page and in again from its row (the owner, 2 Oct 2026:
            "more clicks than are needed"). The same destination that row's
            own Reconcile button reaches, carrying `from=accounts` so the
            reconciliation's own way back works as it does from there.

            Same rule as To Review: nothing at zero. An account with nothing
            to review AND nothing to tick shows neither — that is what "done"
            looks like. The count is neutral, not amber: rows waiting to be
            ticked are a job, not a thing gone wrong. */}
        {toReviewCount === 0 && unreconciledCount > 0 && account && (
          <Link
            to={preserveDemoParam(`/reconciliation?account=${account.id}&from=accounts`, location.search)}
            className={`${TOOLBAR_QUIET_BUTTON} ${TOOLBAR_QUIET_IDLE}`}
            title="Nothing left to review here — go straight to reconciling this account against its statement."
          >
            Reconcile
            <span className="inline-flex items-center px-1.5 py-0 rounded-full text-xs font-semibold tabular-nums bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200">
              {unreconciledCount}
            </span>
          </Link>
        )}
        {toReviewCount > 0 && (
          <button
            type="button"
            onClick={() => setReviewOnly(prev => !prev)}
            aria-pressed={reviewOnly}
            className={`${TOOLBAR_QUIET_BUTTON} ${reviewOnly ? TOOLBAR_QUIET_ACTIVE : TOOLBAR_QUIET_IDLE}`}
            title={
              reviewOnly
                ? 'Showing only transactions that have arrived and not been dealt with. Click to show them all again.'
                : 'Transactions that arrived from an import and have not been saved yet. Click to show only those.'
            }
          >
            To Review
            {/* Amber, the colour this app already uses for "this wants your
                attention" (the suggested-category badge, the uncategorised
                bar), and sized like the tag pills the register already draws so
                a toolbar with a count in it still reads as one row of
                controls. The number is the point, so it carries the colour
                rather than the whole button — a fully amber button in a row of
                grey ones reads as an error. */}
            <span className="inline-flex items-center px-1.5 py-0 rounded-full text-xs font-semibold tabular-nums bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
              {toReviewCount}
            </span>
          </button>
        )}

        {/* Expand table sits with the other quiet controls rather than in the
            right-hand seat: it changes what the register SHOWS, which is what
            this whole cluster does. The right-hand seat is for the one thing
            that changes the ledger. (DESIGN_PASS §3.1 QUIET.) */}
        <button
          onClick={() => setTableExpanded(prev => !prev)}
          className={`${TOOLBAR_QUIET_BUTTON} ${tableExpanded ? TOOLBAR_QUIET_ACTIVE : TOOLBAR_QUIET_IDLE}`}
          title={tableExpanded ? 'Shrink the table and show the add/edit bar' : 'Expand the table over the add/edit bar'}
        >
          {tableExpanded ? <MinimizeIcon size={14} /> : <MaximizeIcon size={14} />}
          <span className="sm:hidden">{tableExpanded ? 'Shrink' : 'Expand'}</span>
          <span className="hidden sm:inline">{tableExpanded ? 'Standard view' : 'Expand table'}</span>
        </button>
        </div>
        {/* The right cluster: the same `contents` trick as the left one, so on
            a phone Add is a grid cell like the rest and from sm it is pushed to
            the right edge by the container's justify-between. */}
        <div className="contents sm:flex sm:items-center sm:gap-2">
        {/* THE FULL ADD, on this account. The dock at the foot of the page is
            deliberately six fields wide — date, type, payee, category, amount —
            and there was no way at all from this page to reach the rest of a
            transaction. This is that way: the same editor the Transactions
            page's "Add Transaction" opens, opened on the account whose register
            is on screen.

            Dark navy, like Add Transaction and Add Account wear on their own
            pages, because it is the same rank of action; sized px-3 py-1.5
            like its neighbours here, because a taller button in a toolbar row
            makes the row look broken. */}
        <button
          type="button"
          onClick={() => setShowAddTransaction(true)}
          className="flex w-full sm:w-auto items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium bg-[#1a2332] text-white rounded hover:bg-[#2d3a4d] transition-colors duration-state"
          title={`Add a transaction to ${account.name} on the full form — notes, the whole category tree, and a transfer's other side. The bar at the foot of the register is the quick way in.`}
        >
          <PlusIcon size={14} />
          <span className="sm:hidden">Add</span>
          <span className="hidden sm:inline">Add transaction</span>
        </button>
        </div>
      </div>

      {/* Search and Filter Bar (collapsed by default to keep one viewport) */}
      {showFilters && (
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700 p-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col lg:flex-row gap-4">
            {/* Search Input */}
            <div className="flex-1">
              <div className="relative">
                <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={20} />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search by description, amount, category..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 sm:py-2 text-base sm:text-sm bg-white dark:bg-gray-700 border-2 border-gray-300 dark:border-gray-500 rounded-lg focus:border-transparent dark:text-white min-h-[48px] sm:min-h-[auto]"
                />
              </div>
            </div>
            
            {/* Type Filter and Compact View Toggle */}
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 border border-gray-300 dark:border-gray-600 rounded-lg p-1">
                <button
                  onClick={() => setTypeFilter('all')}
                  className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                    typeFilter === 'all'
                      ? 'bg-[#1a2332] text-white'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  All
                </button>
                <button
                  onClick={() => setTypeFilter('income')}
                  className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                    typeFilter === 'income'
                      ? 'bg-green-600 text-white'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  Income
                </button>
                <button
                  onClick={() => setTypeFilter('expense')}
                  className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                    typeFilter === 'expense'
                      ? 'bg-red-600 text-white'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  Expense
                </button>
                <button
                  onClick={() => setTypeFilter('transfer')}
                  className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                    typeFilter === 'transfer'
                      ? 'bg-[#1a2332] text-white'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  Transfer
                </button>
              </div>
            </div>
          </div>
          
          {/* Date Range and Additional Filters */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CalendarIcon size={18} className="text-gray-500 dark:text-gray-400 hidden sm:block" />
              <div className="w-40">
                <DatePicker
                  value={dateFrom}
                  onChange={(val) => setDateFrom(val)}
                  className="bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-500 rounded-lg dark:text-white text-sm"
                  aria-label="Filter from date"
                />
              </div>
              <span className="text-sm text-gray-500 dark:text-gray-400">to</span>
              <div className="w-40">
                <DatePicker
                  value={dateTo}
                  onChange={(val) => setDateTo(val)}
                  className="bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-500 rounded-lg dark:text-white text-sm"
                  aria-label="Filter to date"
                />
              </div>
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => {
                    setDateFrom('');
                    setDateTo('');
                  }}
                  className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-600 rounded-lg"
                  title="Clear date range"
                >
                  <XIcon size={18} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      )}

      {/* Transactions Table — measured to keep the whole page in one viewport;
          the table scrolls internally. Expanded mode trades the bottom dock
          for more visible rows. */}
      {/* Phones get a card list rather than the table. The register table's
          columns are fixed-width flex cells with visible overflow — at 375px
          they shrink into each other and the headers paint on top of one
          another. A register is also read differently on a phone: tap a row to
          see or change everything. */}
      {/* The row editor's state, the keys it answers to and the writes it makes
          — held ABOVE the table so that typing a description re-renders three
          cells and a strip rather than eleven thousand rows, and mounted
          ALWAYS, editor or no editor, because a wrapper that comes and goes
          changes the shape of the tree beneath it and this register has already
          been through what that does to a virtualised list.

          It wraps the PHONE list too (29 Sep 2026): a tapped card becomes this
          same editor, stacked (MobileQuickEditCard), so the two layouts share
          one editor state and one set of writes. Which "next" and which fields
          are handed over depends on which layout is on screen. */}
      <QuickEditRowProvider
        transaction={quickEditRow}
        fields={isPhoneLayout ? phoneQuickEditFields : quickEditFields}
        onNext={isPhoneLayout ? phoneQuickEditNext : quickEditNext}
        // A phone's Save & Next shows the next row whole, cursor in the
        // description, and opens the category list only on Return or a tap —
        // see the prop's note.
        run={isPhoneLayout ? 'description-first' : 'same-field'}
        // The To Review list drops a row as it is filed, so a plain Save or a
        // Confirm there moves on to the next row (see the prop's note).
        moveOnAfterSave={reviewOnly}
        onDismiss={handleQuickEditDismiss}
        focusRequest={quickEditFocus}
        onFocusRequestHandled={handleQuickEditFocusHandled}
      >
      <div
        // The phone's half of the register, named so a test can ask it what it
        // is showing separately from the table's. Both are in the DOM at once
        // and CSS decides which one a person sees, so "the register says X" is
        // only a true claim when it is asked of one viewport at a time.
        data-testid="register-phone-list"
        className="lg:hidden bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700 overflow-hidden"
      >
        <InfiniteScrollTransactionList
          transactions={phoneListRows}
          /*
           * OLDEST-FIRST OPENS ON THE NEWEST, exactly as the desktop register
           * does by scrolling to its foot. The anchor follows the DISPLAYED
           * order, which is why it asks `phoneShowsOldestFirst` and not the
           * sort state.
           *
           * THE FIRST VERSION OF THIS LINE READ THE STATE ORDER, and shipped:
           * `sortField === 'date' && sortDirection === 'asc' ? 'end' : 'start'`.
           * Those are the register's defaults, so the untouched phone matched
           * it — but `phoneListRows` above REVERSES exactly that case into
           * newest-first, and an anchor of 'end' on a newest-first list opens
           * on its last row. Owner, 29 Aug: "The register now opens at the
           * bottom, which is the oldest transaction." The precise opposite of
           * what the line was for, on the one view every phone gets by
           * default.
           *
           * The reversal is part of the displayed order. Anything choosing an
           * END has to account for it, which is what the derivation beside
           * `phoneListRows` now exists to make impossible to forget.
           */
          anchor={phoneShowsOldestFirst ? 'end' : 'start'}
          /* Which end is the newest, so the jump control can say where it
             goes rather than which way it scrolls. Undefined under a
             description or amount sort, where neither end is "newest". */
          newestEnd={phoneNewestEnd}
          /* The accounts are what let a card say "Transfer > Current Account"
             instead of an italic *Uncategorised* over a correctly filed
             transfer (owner's phone, 1 Sep 2026 — the category a transfer
             carries is the literal 'transfer-out', which is no category's id).
             An empty array used to stand here to keep every card in a
             single-account register from repeating that account's name; the
             list now derives that from the rows themselves, so passing the
             real accounts adds the labels without adding the repetition. */
          accounts={accounts}
          categories={categories}
          // A phone is still looking at the REGISTER, with the same To Review
          // box above it and the same filter, so it gets the same bold. A list
          // that offers neither — a report, a Find result — gets the default
          // and says nothing.
          markAwaitingReview
          // THE SAME NODE THE DESKTOP TABLE GETS. The phone used to answer both
          // kinds of nothing with one sentence that told a user with an empty
          // register to adjust filters and a user with a filter to add
          // transactions; passing the register's own split state means the two
          // viewports cannot drift into disagreeing about what happened to the
          // rows (DESIGN_PASS §4).
          emptyContent={registerEmptyState}
          isLoading={isLoading}
          formatCurrency={formatRegisterMoney}
          onEdit={(t) => { setSelectedTransaction(t); setSelectedTransactionId(t.id); setIsEditModalOpen(true); }}
          /* A TAP EDITS IN PLACE, as a click does on the desktop: the card
             becomes the editor where it stands. The long-press and the swipe's
             Edit (onEdit, above) still open the full modal. */
          onView={(t) => { setSelectedTransaction(t); setSelectedTransactionId(t.id); setQuickEditOpen(true); }}
          editingId={isPhoneLayout ? (quickEditRow?.id ?? null) : null}
          renderEditor={(t) => (
            <MobileQuickEditCard
              transaction={t}
              onFullEditor={(row) => {
                const withBalance = transactionsWithBalance.find(item => item.id === row.id);
                if (withBalance) openFullEditor(withBalance);
              }}
            />
          )}
          onDelete={(id) => {
            const target = transactionsWithBalance.find(t => t.id === id);
            if (target) setDeleteConfirmTransaction(target);
          }}
        />
      </div>

      {/* How many rows the highlight now covers, for anyone who cannot see it
          stretch. The region is ALWAYS here, empty until there is something to
          say: a live region that appears with its message already in it is
          announced unreliably or not at all, which is the same as not having
          one. */}
      <div className="sr-only" aria-live="polite">
        {hasMultiSelection ? `${selectedRowIds.length} transactions selected` : ''}
      </div>

      {/* Only the desktop table has a Balance column, so only it needs the
          warning that the column has stopped being a running one. */}
      {balanceOrderNotice && (
        <p className="hidden lg:block text-sm text-gray-600 dark:text-gray-400">
          {balanceOrderNotice}
        </p>
      )}

{/* The register is one ARIA grid, focusable as a whole and driven from
          the keyboard: arrows and page keys walk the highlight, Enter opens the
          highlighted row, and aria-activedescendant tells a screen reader which
          row that is. Clicking a row focuses this wrapper (the browser focuses
          the nearest focusable ancestor), so the keys are live straight after
          the click that highlights the row. */}
      <div
        ref={tableWrapRef}
        data-transaction-table
        style={{ height: tableHeight }}
        // No radius here any more: the table is the page's content, not a card
        // sitting on it, and the corner was only ever there to clip the ring
        // that has gone (DESIGN_PASS §3.1 QUIET). The focus ring stays — it is
        // the one border with a meaning.
        //
        // A REFETCH DIMS, IT NEVER BLANKS: figures already on screen stay put
        // at 60% while the same figures are fetched again. Blanking a register
        // to reload it is indistinguishable, for the half-second it lasts,
        // from losing the data (DESIGN_PASS §4).
        className={`hidden lg:block overflow-hidden ${
          isLoading ? 'opacity-60 transition-opacity duration-enter' : ''
        }`}
        role="grid"
        aria-label={`${account.name} transactions`}
        // The header row counts, which is what puts the first transaction on
        // row 2 — the same numbering the user sees. The strip under a row
        // being edited is a row of the grid too (one cell, holding the
        // actions), so it counts as one while it is there rather than leaving
        // the total short.
        aria-rowcount={displayRows.length + 1 + (quickEditRowDetail ? 1 : 0)}
        tabIndex={0}
        // Shift+arrow stretches the highlight over a run of rows, so a screen
        // reader is told up front that more than one row can be selected —
        // otherwise every extra aria-selected row reads as a contradiction.
        aria-multiselectable
        aria-activedescendant={selectedTransactionId ? rowDomId(selectedTransactionId) : undefined}
        onKeyDown={handleRegisterKeyDown}
      >
        <VirtualizedTable
          items={displayRows}
          columns={columns}
          getItemKey={(row: DisplayRow) => row.id}
          rowDomId={rowDomId}
          onRowClick={(item) => handleTransactionClick(item)}
          rowHeight={compactView ? 36 : 44}
          scrollToKey={rowScroll?.rowId ?? null}
          scrollToAlign={rowScroll?.align}
          scrollToToken={rowScroll?.token}
          scrollToBottomToken={footScrollToken}
          rowDetail={quickEditRowDetail}
          selectedItems={selectedIdSet}
          onSort={(column, direction) => {
            // Every header sorts except the running Balance (which stays in its
            // chronological order regardless — see transactionsWithBalance).
            const sortableFields = ['date', 'description', 'category', 'tags', 'payment', 'deposit', 'amount', 'notes'] as const;
            if ((sortableFields as readonly string[]).includes(column)) {
              setSortField(column as typeof sortField);
              setSortDirection(direction);
            }
          }}
          sortColumn={sortField}
          sortDirection={sortDirection}
          onColumnReorder={handleColumnReorder}
          onColumnResize={handleColumnResize}
          // Where the rows would be, when there are none: what is absent, what
          // follows from that, and the control that fixes it — never a blank
          // table (DESIGN_PASS §4). No emptyMessage beside it: emptyContent
          // always wins, so a string here would be unreachable copy that a
          // later reader could mistake for what the register says.
          emptyContent={registerEmptyState}
          threshold={50}
          /* ONE TREATMENT, not four. The navy fill, the blue-grey ring, the
             drop shadow and the zebra were four ways of saying "this is a
             table" over the top of each other, and every one of them cost
             either contrast or a row. What is left is a hairline under a
             label-sized header and a hairline between rows — the table reads
             as the page's content, which is what it is (DESIGN_PASS §3.1
             QUIET, P1/P4). */
          surface="flat"
          striped={false}
          rowBorderClassName="border-b border-line-soft dark:border-gray-700"
          className="virtualized-table bg-white dark:bg-gray-800 h-full border-0"
          headerClassName="bg-surface-secondary dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-b border-line"
          headerCellClassName="font-medium text-label uppercase"
          headerSortHoverClassName="hover:text-gray-900 dark:hover:text-gray-100"
          rowClassName={(row: DisplayRow) => {
            // The opening balance is a PERMANENT fact of the account, not a
            // state anyone acts on, so its wash is a neutral lift and the
            // italic carries the rest (stock-blue ruling, 28 Aug: colour marks
            // what needs attention, and a resting row needs none).
            if (isOpeningBalanceRow(row)) {
              return 'bg-gray-50 dark:bg-gray-700/30 italic';
            }
            // Everything in the run reads as selected; the row the arrows are
            // actually on keeps the register's own highlight class on top, so
            // "where am I" stays answerable inside a nine-row selection.
            if (selectedTransactionId === row.id) return 'selected-transaction-row';
            // The selected wash is the SELECTED state's own token, the same
            // pair Accounts' rows wear (ACCOUNT_ROW_SELECTED_CLASS):
            // `--color-primary` does not invert on dark, so a tenth of a
            // near-black navy over a gray-800 table is no wash at all and dark
            // takes the house counterpart, a lifted grey.
            return selectedIdSet.has(row.id)
              ? 'bg-primary/10 dark:bg-gray-700/50'
              : '';
          }}
        />
      </div>
      </QuickEditRowProvider>

      {/* Pending at the bank: after the last real transaction, under a rule,
          faded — what the bank has authorised and not yet sent. Not rows of the
          register: nothing in it can be selected, edited or counted. Hidden
          with the rest of the chrome when the table is expanded. */}
      {!tableExpanded && pendingAtBank && (
        <PendingAtBankList pending={pendingAtBank} currency={registerCurrency} />
      )}

      {/* Bottom dock — ONE always-visible bar (hidden only in expanded mode).
          Editing a transaction happens up in the register now, on the row
          itself; what is left down here is what a RUN of rows can be done to,
          and otherwise the add bar — which stays put whether or not a row is
          highlighted, so "add one more" never costs you your place. */}
      {!tableExpanded && hasMultiSelection && (
        <RegisterSelectionBar
          count={selectedRows.length}
          unmarkedCount={selectedRows.filter(row => !row.cleared).length}
          archivableCount={selectedRows.filter(row => !row.archived).length}
          busy={bulkBusy}
          onReconcile={() => { void applyCleared(selectedRows.map(row => row.id), true); }}
          onUnreconcile={() => { void applyCleared(selectedRows.map(row => row.id), false); }}
          onArchive={() => { void archiveSelection(); }}
          onDelete={() => setBulkDeletePlan(planBulkDelete(selectedRows, transactions, accounts))}
          onClear={clearSelection}
        />
      )}

      {/* Quick Add Transaction (the dock's default mode) */}
      {!tableExpanded && !hasMultiSelection && (
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md border border-gray-100 dark:border-gray-700 px-4 py-3">
        {/* max-w: the dock is as wide as the register, and a description box
            stretched across it left Amount and Add squeezed into the corner.
            Capping the form makes both rows end at the same edge, so the wide
            fields stop hogging and the small ones get room. flex-wrap keeps
            the fields stacking instead of overflowing on narrow screens. */}
        {/* Named, so it is a landmark a screen reader can jump to and — now
            that the quick-EDIT box sits up in the register — so "Description"
            down here and "Description" up there are heard in their own
            contexts rather than as two identical fields on one screen.

            Named BY ITS OWN HEADING (aria-labelledby, not aria-label): the bar
            used to introduce itself only to screen readers, as "Add a
            transaction", while the eye got five field labels and nothing
            saying what they were for. Now it says so on screen, and the name
            read out is that same string by construction — the two cannot drift
            into saying different things about one bar. */}
        {/* noValidate, deliberately: the browser's own "fill in this field"
            bubble would fire on the + Add button and never on Enter, so the two
            routes into the same draft would report different faults in
            different places. Every check the bar makes is its own (see
            submitQuickAdd), said in the bar's own words, at the box at fault.
            `required` stays on the fields — it is what tells a screen reader
            they are required — it just no longer decides what happens. */}
        <form
          onSubmit={handleQuickAdd}
          onKeyDown={handleQuickAddKeyDown}
          noValidate
          aria-labelledby={QUICK_ADD_HEADING_ID}
        >
          <h2
            id={QUICK_ADD_HEADING_ID}
            // The selection bar that takes this bar's place carries its count
            // line at exactly this size and weight (RegisterSelectionBar), so
            // the dock reads as one thing whichever mode it is in.
            //
            // text-sm + mb-2 is where QUICK_ADD_HEADING_HEIGHT_PX comes from.
            // Change either and change that.
            className="text-sm font-semibold text-gray-900 dark:text-white mb-2"
          >
            Quick Add Transaction
          </h2>
          {/* One line across the full width — Date, Type, Description,
              Category, Amount, Add — wrapping only when the window is too
              narrow to hold it. Capping the form instead (an earlier attempt)
              squashed the fields into the left half and left the rest of the
              register empty; letting Description and Category share the slack
              equally keeps either from hogging it. */}
          {/* Phones: a 2-column grid — Date | Type, then Description and
              Category full-width, then Amount | Add. The free-wrapping row
              produced a different ragged layout at every width. From sm up
              it is the same single wrapping row as before. */}
          <div className="grid grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap">
            {/* Every label down here is tied to the field it names — htmlFor
                where the control has an id of its own, and the control's own
                aria-label where it does not (the pickers). A <label> attached
                to nothing is invisible to a screen reader, which is the one
                reader that needs it. */}
            <div ref={quickAddDateRef} className="w-full sm:w-[150px] sm:shrink-0">
              <label htmlFor="quick-add-date" className="text-xs text-gray-500 dark:text-gray-400 mb-0.5 block">Date</label>
              <DatePicker
                id="quick-add-date"
                value={quickAddForm.date}
                onChange={(val) => { clearQuickAddError(); setQuickAddForm({ ...quickAddForm, date: val }); }}
                className="h-auto sm:h-[32px] bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg dark:text-white text-xs"
              />
            </div>

            <div className="sm:shrink-0">
              <span className="text-xs text-gray-500 dark:text-gray-400 mb-0.5 block">Type</span>
              <div
                role="group"
                aria-label="Transaction type"
                className="grid grid-flow-col auto-cols-fr sm:flex gap-0.5 items-center h-[38px] sm:h-[32px] bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5"
              >
                {/* Red and green here are the app's money semantics — out and
                    in. A transfer is NEITHER: nothing leaves the book, which is
                    why it gets no direction anywhere else in the app either (see
                    TrendArrow's no-direction-at-zero). It wore a stock blue only
                    because the trio wanted a third fill; the honest third value
                    is no hue (stock-blue ruling, 28 Aug). */}
                {([
                  { value: 'expense', label: 'Exp', activeColor: 'text-red-600 dark:text-red-400' },
                  { value: 'income', label: 'Inc', activeColor: 'text-green-600 dark:text-green-400' },
                  { value: 'transfer', label: 'Txfr', activeColor: 'text-gray-700 dark:text-gray-200' },
                ] as const).map(({ value, label, activeColor }) => (
                  <button
                    key={value}
                    type="button"
                    // Which one is on, said out loud — the white pill says it
                    // to the eye and nothing said it to anyone else.
                    aria-pressed={quickAddForm.type === value}
                    onClick={() => {
                      // Clearing the category is not tidiness: it may belong to
                      // the tree the picker no longer shows, and on 'transfer'
                      // the same field means the TARGET ACCOUNT.
                      clearQuickAddError();
                      setCrossTypeCategories(false);
                      setQuickAddForm({ ...quickAddForm, type: value, category: '' });
                    }}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                      quickAddForm.type === value
                        ? `bg-white dark:bg-gray-600 shadow-sm ${activeColor}`
                        : 'text-gray-400 dark:text-gray-500 hover:text-gray-600'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="col-span-2 min-w-0 sm:flex-1 sm:min-w-[180px]">
              <label htmlFor="quick-add-description" className="text-xs text-gray-500 dark:text-gray-400 mb-0.5 block">Description</label>
              {/* Money's AutoComplete: the best match from the user's own payees
                  drawn faint ahead of the caret, accepted by Right Arrow and by
                  nothing else. The box's VALUE is only ever what was typed —
                  see PayeeAutoCompleteInput for why that is the whole of the
                  never-committed rule. */}
              <PayeeAutoCompleteInput
                id="quick-add-description"
                inputRef={quickAddDescriptionRef}
                placeholder="Description"
                value={quickAddForm.description}
                onChange={(description) => { clearQuickAddError(); setQuickAddForm({ ...quickAddForm, description }); }}
                onFocus={armPayeeIndex}
                payees={payeeIndex}
                onAccept={handlePayeeAccepted}
                required
                aria-invalid={quickAddError?.field === 'description' ? true : undefined}
                aria-describedby={quickAddError?.field === 'description' ? QUICK_ADD_ERROR_ID : undefined}
                className={`w-full px-2.5 py-1.5 h-auto sm:h-[32px] text-xs bg-white dark:bg-gray-700 border rounded-lg dark:text-white ${
                  quickAddError?.field === 'description'
                    ?'border-red-500 dark:border-red-400'
                    :'border-gray-300 dark:border-gray-600'
                }`}
              />
            </div>

            <div className="col-span-2 min-w-0 sm:flex-1 sm:min-w-[180px]">
              {/* A span, not a label: both controls below are comboboxes that
                  carry their own aria-label, and a <label> pointing at nothing
                  is worse than no label at all. */}
              <span className="text-xs text-gray-500 dark:text-gray-400 mb-0.5 block">
                {quickAddForm.type === 'transfer' ? 'To Account' : 'Category'}
              </span>
              {quickAddForm.type === 'transfer' ? (
                /* The account and category pickers take turns in this one
                   slot, so they are the same control at the same size — and
                   usePortal opens the list upward when the dock is sitting at
                   the bottom of the window. */
                <AccountSelector
                  accounts={accounts}
                  excludeIds={quickAddExcludedAccountIds}
                  selectedAccountId={quickAddForm.category}
                  onAccountChange={(accountId) => { clearQuickAddError(); setQuickAddForm({ ...quickAddForm, category: accountId }); }}
                  placeholder="Account..."
                  searchPlaceholder="Search accounts…"
                  formatLabel={(acc) => `${acc.name} (${formatCurrency(acc.balance, acc.currency)})`}
                  size="compact"
                  usePortal
                  ariaLabel="To Account"
                  // Enter belongs to the row, not to this box — see the add
                  // bar's own key handler. Space and the arrows still open it.
                  closedEnter="pass-through"
                  ariaInvalid={quickAddError?.field === 'category' ? true : undefined}
                  ariaDescribedBy={quickAddError?.field === 'category' ? QUICK_ADD_ERROR_ID : undefined}
                />
              ) : (
                /* Which direction's tree it lists is this row's own, flipped by
                   the cross-type checkbox below — the same control the edit
                   modal offers, so both surfaces teach the same model. The
                   picker also offers the direction-neutral Revaluation
                   categories (Account Adjustment) either way round. */
                <CategorySelector
                  selectedCategory={quickAddForm.category}
                  // Not a plain setter: a "To/From <account>" category is not a
                  // category, it is a transfer. See handleQuickAddCategoryChosen.
                  onCategoryChange={handleQuickAddCategoryChosen}
                  // Offered here for the same reason the register's inline
                  // editor offers them: choosing one is a complete instruction
                  // ("this money went to that account"), and this dock knows
                  // exactly what to do with it — flip its own Type to Txfr, put
                  // the account in the To Account slot, and write both legs on
                  // Add. This account's own To/From is left out: a transfer to
                  // itself moves nothing.
                  includeTransferTargets
                  transferSourceAccountId={account.id}
                  transactionType={
                    crossTypeCategories
                      ? (quickAddForm.type === 'income' ? 'expense' : 'income')
                      : quickAddForm.type
                  }
                  placeholder="Category..."
                  allowCreate={false}
                  // The dock row bottom-aligns its fields; the helper line under
                  // the combobox counted as field height and hoisted the picker
                  // above its neighbours. The label already names the field.
                  showHelperText={false}
                  // Match the row's 32px fields — the default 42px trigger
                  // still stood proud of its neighbours.
                  size="compact"
                  // Enter belongs to the row, not to this box — see the add
                  // bar's own key handler. Space and the arrows still open it,
                  // and so now does simply typing the category's name.
                  closedEnter="pass-through"
                />
              )}
            </div>

            {/* Wide enough for a five-figure sum with its pennies without the
                digits scrolling out of view. */}
            <div className="w-full sm:w-[150px] sm:shrink-0">
              <label htmlFor="quick-add-amount" className="text-xs text-gray-500 dark:text-gray-400 mb-0.5 block">Amount</label>
              <MoneyInput
                id="quick-add-amount"
                ref={quickAddAmountRef}
                value={quickAddForm.amount}
                // The type buttons carry the sign; this field holds the size.
                onChange={(value) => { clearQuickAddError(); setQuickAddForm({ ...quickAddForm, amount: value }); }}
                aria-invalid={quickAddError?.field === 'amount' ? true : undefined}
                aria-describedby={quickAddError?.field === 'amount' ? QUICK_ADD_ERROR_ID : undefined}
                className={`w-full px-2.5 py-1.5 h-auto sm:h-[32px] text-xs text-right bg-white dark:bg-gray-700 border rounded-lg dark:text-white ${
                  quickAddError?.field === 'amount'
                    ?'border-red-500 dark:border-red-400'
                    :'border-gray-300 dark:border-gray-600'
                }`}
                required
              />
            </div>

            <button
              type="submit"
              className="w-full sm:w-auto sm:shrink-0 px-5 py-2 sm:py-1.5 h-auto sm:h-[32px] min-w-[92px] text-sm sm:text-xs bg-[#1a2332] text-white rounded-lg hover:bg-secondary transition-colors flex items-center justify-center gap-1"
              title="Add Transaction"
            >
              <PlusIcon size={14} />
              Add
            </button>
          </div>

          {/* The bar's message, immediately under the row it is about — and
              under the box at fault, which is outlined, marked aria-invalid,
              tied to this line by aria-describedby and holding the cursor. It
              used to print BELOW the cross-type line, a paragraph's distance
              from a row of five fields, naming none of them.
              role="alert": it appears in answer to a keystroke the user has
              already made, so it is read out rather than waited to be found.
              Kept OUT of the fields' own boxes on purpose: the row is
              bottom-aligned, so a message inside a field would grow that field
              and lift its box above its neighbours — and the dock's height is a
              declared number (DOCK_RESERVE_PX), not a measurement. */}
          {quickAddError && (
            <p
              id={QUICK_ADD_ERROR_ID}
              role="alert"
              className="text-xs text-red-600 dark:text-red-400 mt-1"
            >
              {quickAddError.message}
            </p>
          )}

          {/* Cross-type filing — identical wording to the edit transaction
              modal, deliberately: a refund files under the expense category it
              refunds, and the register and the modal must not teach two
              different models of the same idea. */}
          {(quickAddForm.type === 'income' || quickAddForm.type === 'expense') && (
            <label className="mt-2 flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={crossTypeCategories}
                onChange={(e) => {
                  clearQuickAddError();
                  setCrossTypeCategories(e.target.checked);
                  setQuickAddForm({ ...quickAddForm, category: '' });
                }}
                className="mt-0.5"
              />
              <span>
                {quickAddForm.type === 'income'
                  ? 'Categorise as an expense — e.g. a refund files under the expense category it refunds, reducing that category’s total.'
                  : 'Categorise as income — file this outgoing under an income category, reducing that category’s total.'}
              </span>
            </label>
          )}
        </form>
      </div>
      )}
      </div>

      {/* "You haven't chosen a category — add anyway?" — the one guard that
          asks rather than blocks. Continue adds the row uncategorised (the
          review band will surface it); Cancel leaves every keystroke in place.
          Both routes into the add — the button and Enter — arrive here. */}
      {confirmUncategorised && (
        <AddWithoutCategoryConfirm
          description={confirmUncategorised.description}
          onConfirm={() => {
            setConfirmUncategorised(null);
            void commitQuickAdd();
          }}
          onCancel={() => setConfirmUncategorised(null)}
        />
      )}

      {/* "These accounts hold different currencies" — the other guard that asks
          rather than blocks, and the newer of the two. Same discipline as the
          one above: the draft is held, nothing is written until the figure is
          confirmed, and Cancel leaves every keystroke where it was. */}
      {pendingConversion && account && (
        <CrossCurrencyTransferDialog
          isOpen
          sourceAmount={parseMoneyInput(quickAddForm.amount) ?? 0}
          sourceCurrency={pendingConversion.from}
          sourceAccountName={account.name}
          destinationCurrency={pendingConversion.to}
          destinationAccountName={
            accounts.find(a => a.id === pendingConversion.target)?.name ?? 'the other account'
          }
          busy={conversionBusy}
          onConfirm={(conversion) => {
            const { draft } = pendingConversion;
            setConversionBusy(true);
            void commitQuickAdd(draft, conversion).finally(() => {
              setConversionBusy(false);
              setPendingConversion(null);
            });
          }}
          onCancel={() => setPendingConversion(null)}
        />
      )}

      {/* The toolbar's Add — the app's one full add editor, opened on THIS
          account. Mounted only while it is open, which is what makes the
          prefill work at all (the form freezes its opening values on mount;
          see initialAccountId) and what gives every add a clean form.

          Nothing here refreshes the list afterwards, and nothing needs to: the
          editor saves through the context's addTransaction, which appends the
          saved row to the shared transactions state, and this register is a
          filter over that state. The row appears as the modal closes.

          Nor does anything mark it as arrived-and-unreviewed. That flag belongs
          to the import path alone — a person typing IS the review (see
          dataPort.bulkImportTransactions, which spells out the rule). */}
      {showAddTransaction && (
        <Suspense fallback={null}>
          <AddTransactionModal
            isOpen
            onClose={() => setShowAddTransaction(false)}
            initialAccountId={account.id}
          />
        </Suspense>
      )}

      {/* Edit Modal */}
      {selectedTransaction && (
        <EditTransactionModal
          isOpen={isEditModalOpen}
          onClose={() => {
            setIsEditModalOpen(false);
            setSelectedTransaction(null);
            setSelectedTransactionId(null);
          }}
          transaction={selectedTransaction}
          onSaveAndNext={
            getNextTransactionId(selectedTransaction.id)
              ? () => {
                  if (!advanceToNextTransaction(selectedTransaction.id)) {
                    setIsEditModalOpen(false);
                    setSelectedTransaction(null);
                    setSelectedTransactionId(null);
                  }
                }
              : undefined
          }
          onSaveAndPrevious={
            getPreviousTransactionId(selectedTransaction.id)
              ? () => { advanceToPreviousTransaction(selectedTransaction.id); }
              : undefined
          }
          // This IS the register the modal's "see it in its account" link
          // would jump to, so the link stays hidden here.
          hideJumpToAccountId={accountId}
        />
      )}
      
      {/* Delete Confirmation — keyboard-first: the primary destructive button
          is focused on open, so the loop is arrow to the row, Delete, Enter.
          On one half of a transfer that primary is "Delete both sides", which
          is what deleting a transfer means. */}
      {deleteConfirmTransaction && (
        <DeleteTransactionConfirm
          transaction={deleteConfirmTransaction}
          stranding={deleteStranding}
          onConfirm={() => { void handleDeleteConfirm(); }}
          onConfirmBothSides={() => { void handleDeleteBothSidesConfirm(); }}
          onCancel={() => setDeleteConfirmTransaction(null)}
        />
      )}

      {/* Deleting a RUN of rows — the confirmation names every row that would
          leave half a transfer behind, and every row it is refusing to touch.
          Cancel holds the focus here, unlike its single-row sibling: there is
          a list to read first. */}
      {bulkDeletePlan && (
        <BulkDeleteTransactionsConfirm
          plan={bulkDeletePlan}
          busy={bulkBusy}
          onConfirm={() => { void handleBulkDeleteConfirm(); }}
          onCancel={() => setBulkDeletePlan(null)}
        />
      )}

      <RegisterShortcutsDialog
        isOpen={showShortcuts}
        onClose={() => setShowShortcuts(false)}
      />

      {/* Account Settings — opened directly from the register header. Same
          modal, same fields as the Accounts page, pairing included. */}
      <AccountSettingsModal
        isOpen={showAccountSettings}
        onClose={() => setShowAccountSettings(false)}
        account={account}
        accounts={accounts}
        hasTransactions={accountHoldsHistory}
        onSave={async (accountId, updates) => {
          await updateAccount(accountId, updates);
          // Rename/close also updates the account's transfer category via the
          // DB trigger — refresh so dropdowns stay in sync without a reload.
          if (updates.isActive !== undefined || updates.name !== undefined) {
            await refreshCategories();
          }
          // Closing the account from its own register: nothing left to show.
          if (updates.isActive === false) {
            navigate(preserveDemoParam('/accounts', location.search));
          }
        }}
      />

      {/* The one thing nobody discovers on their own. Dismissed for good once
          read, like every other page tip; Settings ▸ App Settings ▸ Page Tips
          brings it back. */}
      <PageTip
        id="register-keyboard"
        title="This register runs on the keyboard"
        description="Click a row and it becomes the editor, right where it sits; Enter saves and moves to the next transaction. Press ? for every shortcut — or find them under View ▸ Keyboard shortcuts."
      />
    </div>
  );
}
