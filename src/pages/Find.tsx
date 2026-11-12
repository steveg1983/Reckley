import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../contexts/AppContextSupabase';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import { useDebounce } from '../hooks/useDebounce';
import PageWrapper from '../components/PageWrapper';
import EmptyState from '../components/EmptyState';
import FilteredEmptyState from '../components/FilteredEmptyState';
import { TableSkeleton, type TableSkeletonColumn } from '../components/loading/TableSkeleton';
import { useDelayedFlag } from '../hooks/useDelayedFlag';
import { preserveDemoParam } from '../utils/navigation';
import { SearchIcon, XIcon } from '../components/icons';
import { transactionRowDomId } from '../components/transactionRowDomId';
import { buildTransactionRegisterPath } from '../utils/transactionDeepLink';
import { createCategoryLabeller } from '../utils/categoryLabel';
import { UNCATEGORISED_LABEL } from '../utils/categoryNames';
import { isMarkedAwaitingFinalize, isReconciled } from '../utils/transactionReconciliation';
import { isAwaitingReview } from '../utils/transactionReview';
import {
  FIND_RESULT_CAP,
  findTransactions,
  isFindCriteriaEmpty,
  type FindCriteria,
} from '../utils/findTransactions';
import type { Transaction } from '../types';
import { formatShortDate, getDateLocale } from '../utils/dateFormatter';

/**
 * FIND — Microsoft Money's, not a second register.
 *
 * ─ WHAT IT IS FOR ──────────────────────────────────────────────────────────
 * The work happens in an account's register. This view answers one question the
 * register cannot — "which account was that in?" — and then gets out of the
 * way: every row here is a way INTO a register, and nothing here edits, ticks,
 * reconciles, deletes or bulk-anythings. That is the whole reason it can exist
 * alongside the registers without becoming the second copy of them that the
 * retired global Transactions page was: two lists that both edit must both grow
 * every feature, forever, and one of them will always be the poor relation.
 *
 * ─ WHY IT IS NOT PAGED ─────────────────────────────────────────────────────
 * It draws at most FIND_RESULT_CAP rows and states the true total. A user
 * paging through four thousand results is not finding anything; they are
 * browsing, which is what the register is for. See utils/findTransactions.
 *
 * ─ ONE LIST, NOT TWO ───────────────────────────────────────────────────────
 * The phone gets the same table with two columns dropped, not a card list of
 * its own. A second rendering is a second thing to keep true, and this batch is
 * about deleting exactly that kind of duplicate.
 */

/**
 * The look of the row the keyboard is on: the same wash and #6B86B3 ring the
 * register's active row wears (.selected-transaction-row in index.css), and the
 * same one the Accounts list echoes (ACCOUNT_ROW_SELECTED_CLASS).
 *
 * The wash is that class's own pair, not a stock blue (stock-blue ruling,
 * 28 Aug): `bg-primary/10` is the brand navy at a tenth. `--color-primary` does
 * not invert on dark — a tenth of a near-black navy over a gray-800 table is no
 * wash at all — so dark takes the house counterpart, a lifted grey. Solid
 * `gray-700` rather than the account rows' half-strength one, because an
 * unselected row here HOVERS to `gray-700/50`: the two would have been the same
 * ground, and "where the keyboard is" cannot look like "where the pointer
 * happens to be". The ring stays #6B86B3 — that is `navy-400`, a token this app
 * owns and named for this job, and it draws the outline the wash alone cannot.
 *
 * Utilities rather than that class, and the ring drawn on the CELLS rather than
 * the row, for the reasons the CSS table model forces: `margin` and
 * `border-radius` do nothing on a `<tr>`, a row's box-shadow is not painted
 * while borders are collapsing (Tailwind's preflight makes collapse the default
 * for every table here), and in the collapsing model the CELL's border is the
 * one that wins — so bordering the cells is the only way to draw one unbroken
 * outline round a row that survives its neighbour being selected too.
 *
 * No font-weight, deliberately: weight already says something on this list. A
 * row that arrived and has not been reviewed is bold (isAwaitingReview), and
 * emboldening the selected row would erase that mark exactly when the user is
 * looking straight at it.
 */
export const FIND_ROW_SELECTED_CLASS =
  'bg-primary/10 dark:bg-gray-700 ' +
  '[&>td]:border-y [&>td]:border-[#6B86B3]/50 dark:[&>td]:border-[#6B86B3]/70 ' +
  '[&>td:first-child]:border-l [&>td:last-child]:border-r';

/**
 * The results table's geometry, for the placeholder that stands in for it.
 *
 * The table below is hand-written `<th>`s rather than a `Column[]`, so this is
 * the one place the two could drift apart — and a placeholder of the wrong
 * shape is a layout shift with extra steps. Find.emptyStates.test.tsx counts
 * the placeholder's cells against the real header's in the rendered DOM, so a
 * column added to one and not the other fails rather than quietly misaligning.
 *
 * The `hidden sm:block` / `hidden md:block` pairs mirror the header's own
 * `hidden sm:table-cell` / `hidden md:table-cell`: at 375px the real table
 * draws four columns, so the placeholder must draw four too.
 */
const FIND_SKELETON_COLUMNS: TableSkeletonColumn[] = [
  { key: 'date', width: '14%' },
  { key: 'cr', width: '6%' },
  { key: 'account', width: '18%', className: 'hidden sm:block' },
  { key: 'description', width: '32%' },
  { key: 'category', width: '16%', className: 'hidden md:block' },
  { key: 'amount', width: '14%' },
];

/** `py-2` over `text-sm`'s 20px line — the height a result row actually is. */
const FIND_ROW_HEIGHT = 36;

/** How a day is written in the range chip — the app's date style, spelled out. */
const DAY_PARTS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

/**
 * `YYYY-MM-DD` as the chip prints it, or the raw text if it cannot be read.
 *
 * The formatter is built per call rather than once at module load: it used to
 * hard-code 'en-GB', and a constant built from `getDateLocale()` at import time
 * would freeze whatever the setting said then — the rows in the table beneath
 * this chip ask for the locale every time they draw, and the chip must not be
 * the one date on the page still answering to yesterday's choice.
 */
function formatDay(day: string): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return day;
  return new Intl.DateTimeFormat(getDateLocale(), DAY_PARTS).format(new Date(ms));
}

export default function Find(): React.JSX.Element {
  const { transactions, accounts, categories, isLoading } = useApp();
  const { formatCurrency } = useCurrencyDecimal();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const urlQuery = searchParams.get('q') ?? '';
  const dateFrom = searchParams.get('dateFrom') ?? '';
  const dateTo = searchParams.get('dateTo') ?? '';

  const [text, setText] = useState(urlQuery);
  const debouncedText = useDebounce(text, 250);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /**
   * The address bar and the box, kept saying the same thing.
   *
   * WRITING (this effect): a Find that cannot be linked, bookmarked or reloaded
   * is a Find you have to retype, and the Calendar and the header search both
   * arrive by URL — so the URL has to be the medium. `replace`, so that typing
   * eight letters does not put eight entries in the back button.
   *
   * READING (the next effect): an arrival while ALREADY here — the header
   * search's "see all", pressed a second time with a different query — changes
   * only the URL, and the box has to follow it.
   *
   * They settle rather than fight because both compare against the DEBOUNCED
   * text, which is what the URL will say once the user stops typing: mid-word
   * the reader sees the URL still holding the last settled query and does
   * nothing, and after the writer runs the two agree and neither fires.
   */
  const latestSearch = useRef(location.search);
  latestSearch.current = location.search;
  // Read through a ref, not a dependency: this is the reader's YARDSTICK, not
  // its trigger. As a dependency it would re-run the reader mid-word and hand
  // the box back the query the URL has not caught up with yet.
  const latestDebounced = useRef(debouncedText);
  latestDebounced.current = debouncedText;

  useEffect(() => {
    const params = new URLSearchParams(latestSearch.current);
    if ((params.get('q') ?? '') === debouncedText) return;
    if (debouncedText === '') params.delete('q');
    else params.set('q', debouncedText);
    setSearchParams(params, { replace: true });
  }, [debouncedText, setSearchParams]);

  useEffect(() => {
    if (urlQuery !== latestDebounced.current) setText(urlQuery);
  }, [urlQuery]);

  const criteria = useMemo<FindCriteria>(() => ({
    text: debouncedText,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  }), [debouncedText, dateFrom, dateTo]);

  /**
   * The search itself: one linear pass over the rows already in memory, redone
   * only when the question or the data changes. This view draws MATCHES, capped
   * — so the fifty-thousand-row problem that made a global register untenable
   * does not arise here however large the ledger gets.
   */
  const outcome = useMemo(() => findTransactions(transactions, criteria), [transactions, criteria]);
  const nothingAsked = isFindCriteriaEmpty(criteria);

  const accountNames = useMemo(
    () => new Map(accounts.map(account => [account.id, account.name] as const)),
    [accounts]
  );
  const accountCurrencies = useMemo(
    () => new Map(accounts.map(account => [account.id, account.currency] as const)),
    [accounts]
  );
  // The register's own Category resolver, so a row reads the same here as it
  // does there — transfers included ("Transfer > Rainy Day Savings").
  const categoryLabel = useMemo(() => createCategoryLabeller(categories, accounts), [categories, accounts]);

  /** Where a row goes: its own account's register, with the row picked out. */
  const openRow = useCallback((transaction: Transaction): void => {
    navigate(buildTransactionRegisterPath(transaction.accountId, transaction.id, location.search));
  }, [navigate, location.search]);

  /** Move the highlight onto `id` and hand it the focus, without scrolling more than it must. */
  const selectRow = useCallback((id: string): void => {
    setSelectedId(id);
    const node = document.getElementById(transactionRowDomId(id));
    node?.focus({ preventScroll: true });
    node?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  // The rows as the keyboard sees them, read from a ref so the key handler is
  // not rebuilt (and every row re-rendered) on every result change.
  const navigationRef = useRef<{ rows: Transaction[]; selectedId: string | null }>({ rows: [], selectedId: null });
  useEffect(() => {
    navigationRef.current = { rows: outcome.rows, selectedId };
  }, [outcome.rows, selectedId]);

  /**
   * The keys, on the row that has the focus — the register's idiom, and the
   * Accounts list's: arrows walk, Home/End jump, Enter opens what a click
   * opens, Escape lets go.
   *
   * On the ROW rather than the window, which is what keeps them out of the
   * search box's way by construction rather than by a list of exceptions.
   * Everything claimed is also stopped: the app carries a window-level shortcut
   * listener, and an Enter it saw after this list had answered it would be one
   * gesture doing two things.
   */
  const handleRowKeyDown = useCallback((
    event: React.KeyboardEvent<HTMLTableRowElement>,
    transaction: Transaction
  ): void => {
    if (event.target !== event.currentTarget) return;
    const { rows, selectedId: current } = navigationRef.current;
    const claim = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    const move = (delta: number): void => {
      if (rows.length === 0) return;
      const index = current === null ? -1 : rows.findIndex(row => row.id === current);
      // No highlight, or a highlight on a row this search no longer shows: the
      // key is an arrival on the row under the user's hand, and jumping to a
      // neighbour of nowhere would be a surprise.
      const next = index === -1 ? transaction : rows[Math.min(rows.length - 1, Math.max(0, index + delta))];
      if (next === undefined) return;
      selectRow(next.id);
    };

    switch (event.key) {
      case 'ArrowDown':
        claim();
        move(1);
        break;
      case 'ArrowUp':
        claim();
        move(-1);
        break;
      case 'Home':
        claim();
        if (rows[0]) selectRow(rows[0].id);
        break;
      case 'End':
        claim();
        if (rows[rows.length - 1]) selectRow(rows[rows.length - 1].id);
        break;
      case 'Enter':
        claim();
        openRow(transaction);
        break;
      case 'Escape':
        // Claimed ONLY when there is something to let go of: Escape belongs to
        // whatever layer is outermost, and a list holding nothing is not one.
        if (current === null) return;
        claim();
        setSelectedId(null);
        break;
      default:
        break;
    }
  }, [openRow, selectRow]);

  /**
   * The single tab stop for the whole table: the highlighted row while it is on
   * screen, and otherwise the first row, so Tab always lands somewhere the
   * arrows can start from. A table that made every row a tab stop would take
   * two hundred presses to get past.
   */
  const tabStopId = selectedId !== null && outcome.rows.some(row => row.id === selectedId)
    ? selectedId
    : outcome.rows[0]?.id;

  const clearDates = useCallback((): void => {
    const params = new URLSearchParams(latestSearch.current);
    params.delete('dateFrom');
    params.delete('dateTo');
    setSearchParams(params, { replace: true });
  }, [setSearchParams]);

  /**
   * Everything the search is currently asking for, let go of at once — the
   * remedy the filtered-empty state offers.
   *
   * The box is cleared as well as the URL: the box is what the user is looking
   * at, and a "Clear" that emptied the results while leaving the query sitting
   * in the field would read as the search having broken.
   */
  const clearSearch = useCallback((): void => {
    setText('');
    const params = new URLSearchParams(latestSearch.current);
    params.delete('q');
    params.delete('dateFrom');
    params.delete('dateTo');
    setSearchParams(params, { replace: true });
  }, [setSearchParams]);

  /**
   * The filters holding every result back, named the way the user set them
   * (DESIGN_PASS §4). "Gone" and "hidden" look identical on a search page, and
   * only the count and these names tell them apart.
   */
  const activeFilterNames = useMemo<string[]>(() => {
    const names: string[] = [];
    const typed = debouncedText.trim();
    if (typed) names.push(`Search: ${typed}`);
    if (dateFrom || dateTo) names.push('the date range');
    return names;
  }, [debouncedText, dateFrom, dateTo]);

  /**
   * NOTHING TO SEARCH, versus NOTHING FOUND — and the difference is the whole
   * reason this page can be trusted.
   *
   * Find reads the rows already in memory, so before they arrive every search
   * legitimately matches nothing. Saying "Nothing matches Ferrier" at that
   * moment is a FALSE NEGATIVE about the user's own money: they conclude the
   * transaction is not there and go looking somewhere else. So a load that has
   * not finished shows the shape of the table instead, and only once it has —
   * and only once 200ms have passed, or a quick load flashes grey bars for
   * nothing (useDelayedFlag).
   */
  const stillArriving = isLoading && transactions.length === 0;
  const showResultsSkeleton = useDelayedFlag(stillArriving);
  const nothingToSearch = !isLoading && transactions.length === 0;

  const rangeLabel = dateFrom && dateTo && dateFrom !== dateTo
    ? `${formatDay(dateFrom)} – ${formatDay(dateTo)}`
    : formatDay(dateFrom || dateTo);

  return (
    <PageWrapper title="Find" contentClassName="space-y-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4 space-y-3">
        <div className="relative">
          <SearchIcon size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400" />
          <input
            type="search"
            value={text}
            onChange={event => setText(event.target.value)}
            // autoFocus: this page has one job, and the user came here to type.
            autoFocus
            // This box takes a description OR an amount, so the spell-checker
            // is offered merchant names and "141.50" and has an opinion about
            // both. A red underline under a search term reads as "you typed it
            // wrong" at the exact moment the page is saying "nothing matched" —
            // two accusations for one perfectly good query.
            spellCheck={false}
            autoCapitalize="none"
            placeholder="Find a description or an amount…"
            aria-label="Find transactions by description or amount"
            className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500"
          />
        </div>

        {(dateFrom || dateTo) && (
          <div className="flex items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-2 rounded-full bg-gray-100 dark:bg-gray-700 px-3 py-1 text-gray-700 dark:text-gray-200">
              Dated {rangeLabel}
              <button
                type="button"
                onClick={clearDates}
                className="rounded-full p-0.5 hover:bg-gray-200 dark:hover:bg-gray-600"
                aria-label="Clear the date range"
                title="Clear the date range"
              >
                <XIcon size={14} />
              </button>
            </span>
          </div>
        )}
      </div>

      {stillArriving ? (
        // SHAPE, NOT SPINNER — and nothing at all under 200ms. Never the words
        // "Nothing matches" while the rows are still on their way.
        showResultsSkeleton ? (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
            <TableSkeleton columns={FIND_SKELETON_COLUMNS} rowHeight={FIND_ROW_HEIGHT} />
          </div>
        ) : null
      ) : nothingToSearch ? (
        // There is nothing in the ledger at all, so no query could ever match.
        // Saying "Nothing matches Ferrier" here would blame the search for the
        // absence of the data.
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
          <EmptyState
            title="There are no transactions to search yet"
            description="Find looks through every account at once — so until something lands in one of them, every search here comes back empty."
            action={{
              label: 'Import a statement',
              onClick: () => navigate(preserveDemoParam('/enhanced-import', location.search))
            }}
            secondaryAction={{
              label: 'Go to Accounts',
              onClick: () => navigate(preserveDemoParam('/accounts', location.search))
            }}
          />
        </div>
      ) : nothingAsked ? (
        // Not an empty state: nothing is missing and nothing is hidden. It is
        // the page explaining itself before it has been asked anything, and
        // that argument is why it was originally left reading down the left
        // edge while the true empty states were centred.
        //
        // Overruled by the owner, on the ground that beats it: he is looking at
        // a PAGE, not at a taxonomy. Whatever this block is called, it occupies
        // the same slot as the two states either side of it, and a panel that
        // jumps from centred to left-aligned depending on which branch rendered
        // reads as a layout bug rather than as a distinction. Consistency was
        // his ruling when the empty states were centred ("it looks cleaner,
        // especially on mobile view") and it applies here for the same reason.
        // Still no decorative glyph — §4 rules that out either way.
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-10 text-center">
          <h3 className="text-card font-semibold text-gray-900 dark:text-white">Find looks through every account at once</h3>
          <p className="mt-1 mx-auto max-w-2xl text-body text-gray-600 dark:text-gray-400">
            Type part of a description, or an amount as your statement prints it — 141.50 finds it
            whichever way the money went. Click a result to open that transaction in its own
            account&rsquo;s register, which is where you can change it.
          </p>
        </div>
      ) : outcome.total === 0 ? (
        // The rows ARE there — this search is what is hiding them. Say how
        // many, say what is doing it, and offer the one control that undoes it.
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
          <FilteredEmptyState
            hiddenCount={transactions.length}
            scope="across your accounts"
            filters={activeFilterNames}
            onClear={clearSearch}
          />
        </div>
      ) : (
        // A REFETCH DIMS, IT NEVER BLANKS: results already on screen stay where
        // they are at 60% while the ledger is fetched again. Blanking them is
        // indistinguishable, for as long as it lasts, from losing them
        // (DESIGN_PASS §4).
        <div
          className={`bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden ${
            isLoading ? 'opacity-60 transition-opacity duration-enter' : ''
          }`}
        >
          <p className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">
            {outcome.capped
              ? `Showing the first ${FIND_RESULT_CAP} of ${outcome.total} matches — narrow the search.`
              : `${outcome.total} match${outcome.total === 1 ? '' : 'es'}`}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full" aria-label="Search results">
              <thead>
                <tr className="bg-[#6B86B3] dark:bg-gray-700 text-white text-xs uppercase tracking-wide">
                  <th scope="col" className="py-2 pl-4 pr-3 text-left font-medium">Date</th>
                  {/* Money's two letters, and the register's: R for a
                      reconciliation that finished, C for a mark made while
                      balancing. A cross-account list that disagreed with the
                      register about which is which would be worse than either. */}
                  <th scope="col" className="py-2 px-2 text-center font-medium" aria-label="C/R column">C/R</th>
                  <th scope="col" className="py-2 px-3 text-left font-medium hidden sm:table-cell">Account</th>
                  <th scope="col" className="py-2 px-3 text-left font-medium">Description</th>
                  <th scope="col" className="py-2 px-3 text-left font-medium hidden md:table-cell">Category</th>
                  <th scope="col" className="py-2 pl-3 pr-4 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {outcome.rows.map(transaction => {
                  const isCurrent = transaction.id === selectedId;
                  const awaitingReview = isAwaitingReview(transaction);
                  const isExpense = transaction.type === 'expense'
                    || (transaction.type === 'transfer' && transaction.amount < 0);
                  const amount = formatCurrency(
                    Math.abs(transaction.amount),
                    accountCurrencies.get(transaction.accountId)
                  );
                  return (
                    <tr
                      key={transaction.id}
                      id={transactionRowDomId(transaction.id)}
                      // A result is a way into a register: one click opens it.
                      // There is nothing here to select a row FOR — no edit, no
                      // bulk action — so the highlight is the keyboard's
                      // position and nothing else.
                      onClick={() => openRow(transaction)}
                      onKeyDown={event => handleRowKeyDown(event, transaction)}
                      tabIndex={transaction.id === tabStopId ? 0 : -1}
                      aria-current={isCurrent ? 'true' : undefined}
                      className={`cursor-pointer select-none transition-colors ${
                        isCurrent ? FIND_ROW_SELECTED_CLASS : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                      }`}
                    >
                      <td className={`py-2 pl-4 pr-3 text-sm text-gray-900 dark:text-gray-100 whitespace-nowrap ${awaitingReview ? 'font-semibold' : ''}`}>
                        {formatShortDate(transaction.date)}
                      </td>
                      <td className="py-2 px-2 text-center text-sm">
                        {isReconciled(transaction) ? (
                          /* The letters are law; their colour never was. R keeps
                             its distinction from C as a deeper ink in the one
                             neutral family — the register's C/R column and the
                             reconciliation chips read the same way (stock-blue
                             ruling, 28 Aug §4). */
                          <span className="text-gray-700 dark:text-gray-200 font-semibold" title="Reconciled">R</span>
                        ) : isMarkedAwaitingFinalize(transaction) ? (
                          <span
                            className="text-gray-500 dark:text-gray-400 font-semibold"
                            title="Marked while balancing — not reconciled until you finalise"
                          >
                            C
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 px-3 text-sm text-gray-700 dark:text-gray-300 hidden sm:table-cell">
                        {accountNames.get(transaction.accountId) ?? 'Unknown'}
                      </td>
                      <td className={`py-2 px-3 text-sm text-gray-900 dark:text-gray-100 ${awaitingReview ? 'font-semibold' : ''}`}>
                        {transaction.description}
                        {/* Weight is a visual cue and nothing else (WCAG 1.4.1),
                            so the fact is said in words too — off-screen,
                            because on screen it would cost the row space to say
                            twice. The register says it in the same words. */}
                        {awaitingReview && <span className="sr-only"> — awaiting review</span>}
                      </td>
                      <td className="py-2 px-3 text-sm text-gray-600 dark:text-gray-400 hidden md:table-cell">
                        {categoryLabel(transaction) || <span className="italic text-gray-400">{UNCATEGORISED_LABEL}</span>}
                      </td>
                      <td className={`py-2 pl-3 pr-4 text-sm text-right font-medium whitespace-nowrap ${isExpense ? 'text-red-600' : 'text-green-600'}`}>
                        {/* Accounting notation, as every other list here draws
                            it: (£100.00) is money out. */}
                        {isExpense ? `(${amount})` : amount}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </PageWrapper>
  );
}
