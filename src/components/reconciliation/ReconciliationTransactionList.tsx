import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { SearchIcon, PlusIcon } from '../icons';
import { useCurrencyDecimal } from '../../hooks/useCurrencyDecimal';
import { isMarkedAwaitingFinalize, isReconciled } from '../../utils/transactionReconciliation';
import type { Transaction, Category } from '../../types';
import { formatShortDate } from '../../utils/dateFormatter';

/**
 * What the list is showing.
 *
 * The vocabulary is the model, and the middle one is the whole reconciliation:
 *
 *   'unreconciled' — everything this reconciliation still has to settle,
 *       ticked or not. THE WORKING LIST, and the default. A row does not leave
 *       it by being marked; it leaves it by being reconciled, which only
 *       Finalize does.
 *   'marked' — the C rows only: what Finalize would commit if pressed now, and
 *       the exact set "Unmark all" acts on. A strict narrowing of the working
 *       list, for the last look before signing.
 *   'all' — plus the rows finished reconciliations already committed.
 *
 * The middle filter used to be 'unmarked', and marking a row dropped it out of
 * the view: press "Mark all" and the list the user was working emptied itself,
 * which read as "that's the reconciliation done" — the very lie the C/R split
 * exists to kill. Ticking a row is progress THROUGH this list, not an exit
 * from it, so the badge changes and the row stays put.
 *
 * ── WHY "To reconcile" AND NOT "Outstanding" ────────────────────────────────
 * Because this is a finance app and the domain already owns that word:
 * outstanding items, in bank reconciliation, are the ones that have NOT yet
 * cleared the bank — which is the unmarked SUBSET of this set, not the set. A
 * label that names a superset with the trade's word for one of its parts is a
 * trap for exactly the user who knows what he is doing. "To reconcile" says
 * what is true of every row here and nothing that is not: this is the work.
 */
type FilterMode = 'all' | 'unreconciled' | 'marked';

const FILTER_LABELS: Record<FilterMode, string> = {
  all: 'All',
  unreconciled: 'To reconcile',
  marked: 'Marked',
};

/** What each view is, said where the choice is made. */
const FILTER_TITLES: Record<FilterMode, string> = {
  all: 'Every transaction on this account, including ones already reconciled.',
  unreconciled: 'Everything this reconciliation still has to settle. Marked rows stay here, showing C, until you finalise.',
  marked: 'The rows marked C — what Finalise would reconcile if you pressed it now.',
};

/**
 * An empty view says which emptiness it is.
 *
 * "No transactions found" is a search result, and reading it after finalizing —
 * when the truth is that the account is finished — invites the user to go
 * looking for rows the app has not lost.
 */
const FILTER_EMPTY_MESSAGES: Record<FilterMode, string> = {
  all: 'This account has no transactions yet.',
  unreconciled: 'Nothing left to reconcile on this account.',
  marked: 'Nothing is marked yet. Tick the rows that appear on your statement.',
};

interface ReconciliationTransactionListProps {
  transactions: Transaction[];
  categories: Category[];
  currency?: string;
  openingBalance: number;
  /** Ids with a mark-write in flight; their checkboxes are disabled. */
  pendingClearedIds?: ReadonlyMap<string, boolean>;
  onToggleCleared: (transactionId: string, cleared: boolean) => void;
  /** Bulk mark/unmark; ids are the currently visible (filtered) transactions. */
  onBulkSetCleared: (transactionIds: string[], cleared: boolean) => void;
  /** Open a transaction to edit its details/category. */
  onRowClick: (transaction: Transaction) => void;
  onAddTransaction: () => void;
  /**
   * Reports the currently visible transactions in display order (after sort +
   * filter + search) so a parent can drive "Save & Next" through the exact
   * order the user sees.
   */
  onVisibleOrderChange?: (orderedIds: string[]) => void;
}

/** Why a committed row's tick does not move here. */
const RECONCILED_ROW_TITLE =
  'Reconciled in a finished reconciliation. Un-tick it in the account register if it is wrong.';

/**
 * THE C/R CHIP'S COLOURS — Claude Design's stock-blue ruling, 28 Aug 2026 §4.
 *
 * `C` wore a filled `blue-600` badge on every marked row: 7,240 of them at once
 * on the owner's ledger, which is the 13 August "29 blue All reconciled pills"
 * finding at 250× scale. The ruling then applies unchanged now — **the C/R
 * letters are law, their colour never was.** The letter carries the meaning, so
 * under P2 there is nothing left for colour to add, and a badge on 100% of rows
 * marks nothing at all.
 *
 * Both marked states therefore take the neutral chip the ruling names: #f1f3f7
 * ground, #475569 letter (6.82:1 measured), with a gray-700/gray-200 counterpart
 * on dark from the same family.
 *
 * R KEEPS A DISTINCTION FROM C, but as a deeper ground out of that same family
 * rather than as the `navy-400` the ruling offered as an option. That token
 * measures 3.32:1 as a letter on #f1f3f7 and 3.69:1 as a ground under white —
 * both fail AA at this chip's `text-xs` size, and the previous R (`gray-400`
 * under white, 2.54:1) failed it worse. The letters are what tell the two apart;
 * the ground only has to stop them reading as one control.
 *
 * Neither state may reach for a hue again. A chip that appears on every row is
 * the definition of a resting state, and colour marks what needs attention.
 */
const CHIP_MARKED =
  'bg-[#f1f3f7] border-[#f1f3f7] text-[#475569] dark:bg-gray-700 dark:border-gray-700 dark:text-gray-200';
const CHIP_RECONCILED =
  'bg-[#e2e6ed] border-[#e2e6ed] text-[#475569] dark:bg-gray-600 dark:border-gray-600 dark:text-gray-100';

export default function ReconciliationTransactionList({
  transactions,
  categories,
  currency,
  openingBalance,
  pendingClearedIds,
  onToggleCleared,
  onBulkSetCleared,
  onRowClick,
  onAddTransaction,
  onVisibleOrderChange,
}: ReconciliationTransactionListProps): React.JSX.Element {
  const { formatCurrency } = useCurrencyDecimal();
  // Opens on the work. An account is opened here to reconcile it, so the first
  // thing on screen is what there is to reconcile — not a history the user
  // would have to filter down before starting. 'all' is one click away.
  const [filterMode, setFilterMode] = useState<FilterMode>('unreconciled');
  const [searchTerm, setSearchTerm] = useState('');

  const getCategoryName = useCallback((categoryId: string): string => {
    const cat = categories.find(c => c.id === categoryId);
    return cat?.name ?? '';
  }, [categories]);

  // Sort by date ascending, then compute running balance
  const sortedTransactions = useMemo(() => {
    const typeOrder = { income: 0, transfer: 1, expense: 2 };
    return [...transactions].sort((a, b) => {
      const dateA = new Date(a.date).getTime();
      const dateB = new Date(b.date).getTime();
      if (dateA !== dateB) return dateA - dateB;
      return typeOrder[a.type] - typeOrder[b.type];
    });
  }, [transactions]);

  // Running balance map
  const balanceMap = useMemo(() => {
    const map = new Map<string, number>();
    let running = openingBalance;
    for (const t of sortedTransactions) {
      running += t.amount;
      map.set(t.id, running);
    }
    return map;
  }, [sortedTransactions, openingBalance]);

  // Filter
  const filteredTransactions = useMemo(() => {
    let list = sortedTransactions;

    if (filterMode === 'unreconciled') {
      // Not `!t.cleared`: a mark is not an exit. The predicate is the one every
      // other surface counts with, so this list and the "N unreconciled" badges
      // elsewhere can never disagree about what is left to do.
      list = list.filter(t => !isReconciled(t));
    } else if (filterMode === 'marked') {
      list = list.filter(isMarkedAwaitingFinalize);
    }

    if (searchTerm) {
      const lower = searchTerm.toLowerCase();
      list = list.filter(t =>
        t.description.toLowerCase().includes(lower) ||
        t.amount.toString().includes(lower) ||
        getCategoryName(t.category).toLowerCase().includes(lower)
      );
    }

    return list;
  }, [sortedTransactions, filterMode, searchTerm, getCategoryName]);

  // Surface the visible order upward so a parent can walk transactions in the
  // exact order shown here (used to drive the modal's "Save & Next").
  useEffect(() => {
    onVisibleOrderChange?.(filteredTransactions.map(t => t.id));
  }, [filteredTransactions, onVisibleOrderChange]);

  /**
   * Mark acts on the unticked rows in view — and, like its opposite below,
   * never on a finished reconciliation. Committed rows arrive here already
   * ticked so the second clause is belt and braces, but the two bulk helpers
   * now state the same rule in the same shape, which is the point: neither one
   * reaches into a settled statement.
   */
  const visibleUnmarkedIds = useMemo(
    () => filteredTransactions.filter(t => t.cleared !== true && !isReconciled(t)).map(t => t.id),
    [filteredTransactions]
  );
  /**
   * Unmark acts on the WORKING set only — never on rows a finished
   * reconciliation committed. One click here can cover hundreds of rows, and a
   * bulk helper for this session's marks has no business reaching back into
   * settled statements.
   */
  const visibleMarkedIds = useMemo(
    () => filteredTransactions.filter(isMarkedAwaitingFinalize).map(t => t.id),
    [filteredTransactions]
  );

  const handleMarkAll = useCallback(() => {
    if (visibleUnmarkedIds.length === 0) return;
    // No confirmation. Marking is a working state that Finalize commits and a
    // second click undoes, so a modal asking "are you sure?" was asking about
    // nothing — and it was the popup that made "Mark all" feel like the
    // reconciliation itself.
    onBulkSetCleared(visibleUnmarkedIds, true);
  }, [visibleUnmarkedIds, onBulkSetCleared]);

  const handleUnmarkAll = useCallback(() => {
    if (visibleMarkedIds.length === 0) return;
    onBulkSetCleared(visibleMarkedIds, false);
  }, [visibleMarkedIds, onBulkSetCleared]);

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        {/* Search */}
        <div className="relative flex-1 basis-full sm:basis-auto">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
          <input
            type="text"
            placeholder="Search transactions..."
            spellCheck={false}
            autoCapitalize="none"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg dark:text-white"
          />
        </div>

        {/* Filter buttons */}
        <div className="flex items-center border border-gray-300 dark:border-gray-600 rounded-lg p-0.5">
          {(['all', 'unreconciled', 'marked'] as FilterMode[]).map(mode => (
            <button
              key={mode}
              onClick={() => setFilterMode(mode)}
              aria-pressed={filterMode === mode}
              title={FILTER_TITLES[mode]}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                filterMode === mode
                  ? 'bg-[#1a2332] text-white'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              {FILTER_LABELS[mode]}
            </button>
          ))}
        </div>

        {/* Bulk actions. The labels say "mark", not "clear": now that marking is
            the holding state, promising anything more would be the old lie in
            new words. */}
        <button
          onClick={handleMarkAll}
          disabled={visibleUnmarkedIds.length === 0}
          className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
          title="Tick every unmarked transaction shown. They stay in this list, showing C, until you finalise."
        >
          Mark all
        </button>
        <button
          onClick={handleUnmarkAll}
          disabled={visibleMarkedIds.length === 0}
          className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
          title="Un-tick the transactions marked in this reconciliation. Already-reconciled rows are left alone."
        >
          Unmark all
        </button>

        {/* Add transaction */}
        <button
          onClick={onAddTransaction}
          className="flex items-center gap-1 px-3 py-2 text-sm bg-[#1a2332] text-white rounded-lg hover:bg-secondary transition-colors"
        >
          <PlusIcon size={16} />
          Add
        </button>
      </div>

      {/* Transaction table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border-2 border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Header. "C/R" is Money's own column: C is a mark, R is reconciled. */}
        <div className="hidden md:grid grid-cols-[100px_50px_1fr_180px_120px_120px] gap-2 px-4 py-2 bg-secondary dark:bg-gray-700 text-white text-xs font-medium">
          <div>Date</div>
          <div className="text-center" title="C = marked in this reconciliation · R = reconciled">C/R</div>
          <div>Description</div>
          <div>Category</div>
          <div className="text-right">Amount</div>
          <div className="text-right">Balance</div>
        </div>

        {/* Rows */}
        {/* The inner scroller pads its own bottom on phones (the bottom
            chrome offset; 0px above md): this list scrolls inside a
            fixed-height column, so the page gutter below it is unreachable
            and its last rows sat behind the floating pill. */}
        <div
          className="max-h-[600px] overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700"
          style={{ paddingBottom: 'var(--wt-bottom-nav-clearance, 0px)' }}
        >
          {filteredTransactions.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
              {searchTerm
                ? `No transactions match “${searchTerm}”.`
                : FILTER_EMPTY_MESSAGES[filterMode]}
            </div>
          ) : (
            filteredTransactions.map(t => {
              const runningBal = balanceMap.get(t.id) ?? 0;
              const reconciled = isReconciled(t);

              return (
                <div
                  key={t.id}
                  onClick={() => onRowClick(t)}
                  /* NO `title` HERE (Design, 28 Aug §7). "Click to edit this
                     transaction" floated a stock dark tooltip mid-row, on every
                     row, restating what `cursor-pointer` and the row's own hover
                     state already say — the same disqualification the tile hint
                     earned. There is nothing for assistive tech to lose either:
                     this is a generic div with no role and no tab stop, so the
                     attribute was never announced, only drawn. */
                  className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 md:grid-cols-[100px_50px_1fr_180px_120px_120px] md:gap-2 px-4 py-3 md:py-2 hover:bg-gray-50 dark:hover:bg-gray-750 md:items-center text-sm cursor-pointer"
                >
                  {/* Date */}
                  <div className="text-gray-700 dark:text-gray-300">
                    {formatShortDate(t.date)}
                  </div>

                  {/* Mark / reconciled state. A committed row shows R and does
                      not move: a finished reconciliation is not undone by a
                      stray click on the screen you do the next one from. */}
                  <div className="flex justify-end md:block md:text-center">
                    <button
                      onClick={(e) => {
                        // The row itself opens the edit modal; keep the toggle isolated.
                        e.stopPropagation();
                        if (reconciled) return;
                        onToggleCleared(t.id, !t.cleared);
                      }}
                      disabled={reconciled || (pendingClearedIds?.has(t.id) ?? false)}
                      className={`w-6 h-6 rounded border-2 flex items-center justify-center transition-colors text-xs font-semibold disabled:cursor-not-allowed ${
                        reconciled
                          ? CHIP_RECONCILED
                          : t.cleared
                          ? `${CHIP_MARKED} disabled:opacity-60 disabled:cursor-wait`
                          : 'border-gray-300 dark:border-gray-500 hover:border-primary disabled:opacity-60 disabled:cursor-wait'
                      }`}
                      title={
                        reconciled
                          ? RECONCILED_ROW_TITLE
                          : t.cleared
                          ? 'Unmark this transaction'
                          : 'Mark this transaction'
                      }
                    >
                      {reconciled ? 'R' : t.cleared ? 'C' : ''}
                    </button>
                  </div>

                  {/* Description */}
                  <div className="col-span-2 md:col-span-1 text-gray-900 dark:text-white truncate">
                    {t.description}
                  </div>

                  {/* Category */}
                  <div className="text-gray-500 dark:text-gray-400 truncate">
                    {getCategoryName(t.category) || (
                      <span className="italic text-gray-400 dark:text-gray-500">Add category…</span>
                    )}
                  </div>

                  {/* Amount */}
                  <div className={`text-right font-medium ${
                    t.amount > 0
                      ? 'text-green-600 dark:text-green-400'
                      : t.amount < 0
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-gray-900 dark:text-white'
                  }`}>
                    {formatCurrency(t.amount, currency)}
                  </div>

                  {/* Running Balance */}
                  <div className={`col-span-2 md:col-span-1 text-right font-medium ${
                    runningBal < 0
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-gray-900 dark:text-white'
                  }`}>
                    {/* The column heading is gone on a phone, and a bare
                        second figure under the amount reads as a second
                        amount. */}
                    <span className="md:hidden text-xs font-normal text-gray-400 dark:text-gray-500 mr-1">Balance</span>
                    {formatCurrency(runningBal, currency)}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
