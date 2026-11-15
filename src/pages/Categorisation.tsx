import React, { useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useApp } from '../contexts/AppContextSupabase';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import { computeIncomeExpense } from '../utils/incomeExpense';
import { expandSplitTransactions, type SplitExpandedTransaction } from '../utils/transactionSplits';
import { groupUncategorisedByAccount } from '../utils/uncategorisedByAccount';
import { groupSuggestedByCategory, groupSuggestedByAccount, isCategorySuggested } from '../utils/categoryProvenance';
import { awaitsFiling } from '../utils/transactionReview';
import { CATEGORY_REFILE_DANGLING_PATH } from '../utils/categoryRefileLink';
import {
  OPEN_PARAM,
  OPEN_FILE_LIST,
  OPEN_PAYEE_SWEEP,
  OPEN_TRANSFER_SWEEP,
} from '../utils/pageOpenLink';
import { preserveDemoParam } from '../utils/navigation';
import { preferences } from '../services/preferencesService';
import { useAttentionLadder } from '../hooks/useAttentionLadder';
import { useFlowConvert } from '../hooks/useFlowConvert';
import { useHistoricalAccounts } from '../hooks/useHistoricalAccounts';
import ReportCurrencyNote from '../components/reports/ReportCurrencyNote';
import { DEPTH_LEVEL_1 } from '../styles/depthShading';
import { useAccountNames } from '../hooks/useAccountNames';
import { useToast } from '../contexts/ToastContext';
import TransferSweepModal from '../components/TransferSweepModal';
import BulkCategorizeModal from '../components/BulkCategorizeModal';
import RejectSuggestionsModal from '../components/RejectSuggestionsModal';
import FileOutstandingSection from '../components/FileOutstandingSection';
import ReportDrillModal, { type ReportDrillTarget } from '../components/reports/ReportDrillModal';
import { ArrowRightLeftIcon, TagIcon, ListIcon, CheckCircleIcon, ChevronRightIcon } from '../components/icons';
import EmptyState from '../components/EmptyState';
import type { Transaction } from '../types';
import { formatCount } from '../utils/localeFormat';

/** Which of the two suggested views the reader last chose. */
const SUGGESTED_VIEW_KEY = 'categorisationSuggestedView';

/**
 * Categorisation — the counterpart to Reconciliation.
 *
 * Reconciliation answers "does this account agree with the bank?". This page
 * answers "is every transaction filed?", which is the other thing that has to
 * be true before a report can be trusted. A row with no category is not income
 * and not an expense, so it is excluded from every total in the app; until it
 * is filed it is money the reports cannot see.
 *
 * The three ways out already existed, but only inside the report gallery — you
 * had to already be looking at a report to find them, which is backwards for a
 * chore you do deliberately. They live here now, and the reports' review band
 * still offers the same actions in place.
 *
 * Deliberately reads ALL transactions, not a period: a chore is only finished
 * when nothing is left, and a date filter would hide the work rather than do
 * it.
 *
 * MONEY IN / MONEY OUT CONVERT (Design's §5, 25 Aug). They summed native units
 * as display units and said nothing about it — this page and the Categories
 * data-health panel were the last two such sums in the app, both carried by
 * the currency census at 'native-known' since the 22nd. Offered the choice
 * between mounting the Phase 0 disclosure and converting, Design ruled
 * convert: "disclosure was the honest interim, never the goal." So the figures
 * go through the same flows seam every other aggregation surface uses, and
 * ReportCurrencyNote states the basis — including the degraded case, where the
 * seam declines to convert and the Phase 0 sentence is what says so.
 */
export default function Categorisation(): React.JSX.Element {
  const { accounts, transactions, transactionSplits, categories, confirmTransactionCategories, updateTransaction } = useApp();
  const { formatCurrency } = useCurrencyDecimal();
  const { showSuccess, showError } = useToast();
  // One rule, app-wide — see utils/attentionLadder.
  const ladder = useAttentionLadder();
  // Only for the demo flag on the one link that leaves this page.
  const location = useLocation();

  const [drill, setDrill] = useState<ReportDrillTarget | null>(null);

  /**
   * THE THREE WAYS THROUGH, ADDRESSED (owner, 1 Sep 2026).
   *
   * Two of these are modal state and the third is a disclosure, so until now the
   * only way to send somebody to one was to land them on this page and tell them
   * which card to press. They answer `?open=` instead — see utils/pageOpenLink
   * for the idiom and its two rules, both of which are kept right here:
   *
   *  - read ONCE, in these initialisers, because the parameter says how the page
   *    was OPENED rather than standing over the reader's shoulder. Closing the
   *    sweep closes it, and nothing puts it back;
   *  - an unknown value opens nothing: each of these is an equality against a
   *    named constant, so a stale or mistyped address is an ordinary visit.
   */
  const [searchParams] = useSearchParams();
  const [showTransferSweep, setShowTransferSweep] = useState(
    () => searchParams.get(OPEN_PARAM) === OPEN_TRANSFER_SWEEP
  );
  const [showBulkCategorize, setShowBulkCategorize] = useState(
    () => searchParams.get(OPEN_PARAM) === OPEN_PAYEE_SWEEP
  );
  /** Whether the filter-and-file list below the cards is showing. */
  const [filing, setFiling] = useState(
    () => searchParams.get(OPEN_PARAM) === OPEN_FILE_LIST
  );
  /**
   * …and the same arrival as a TOKEN, because revealing that list is not the
   * same as showing it: it sits below three cards and a panel of figures, so a
   * link that opened it and left the reader at the top of the page has answered
   * with something they cannot see. `?refile=dangling` on Manage → Categories
   * has brought its section into view since the morning it shipped; this is
   * that behaviour, for the address that reveals rather than opens.
   *
   * Read ONCE here like its three neighbours, which is what keeps it an arrival:
   * pressing the card yourself scrolls nothing, because you are already looking
   * at the control you pressed.
   */
  const [fileArrival] = useState<string | null>(
    () => (searchParams.get(OPEN_PARAM) === OPEN_FILE_LIST ? OPEN_FILE_LIST : null)
  );
  /** Which group button is mid-confirm, so it alone can say so. */
  const [confirmingCategoryId, setConfirmingCategoryId] = useState<string | null>(null);

  // Split parents become one row per line, so a half-filed split still shows
  // the line that needs a category rather than hiding behind its parent.
  const rows = useMemo(
    () => expandSplitTransactions(transactions, transactionSplits),
    [transactions, transactionSplits]
  );

  /**
   * CLOSED ACCOUNTS ARE THE POINT (Design's §5, 25 Aug: convert rather than
   * disclose). The backlog lives in old history — measured, 43 of the 90
   * accounts behind it are closed — and a resolver built from the context's
   * open-accounts list would hand back no factor for exactly those rows. They
   * would sum native while the ≈ said everything was converted, which is worse
   * than the honest native sum this replaces.
   */
  const historicalAccounts = useHistoricalAccounts(accounts);
  const convert = useFlowConvert(historicalAccounts);

  const flows = useMemo(
    () => computeIncomeExpense(rows, [], categories, { convert }),
    [rows, categories, convert]
  );

  const uncategorised = flows.uncategorizedRows;
  const count = uncategorised.length;

  /**
   * The rows counted HERE but not by the register's "to review" — filed under
   * a category that no longer exists. The two counters answer neighbouring
   * questions by design (this page counts all filing work; the review flag is
   * row-local and cannot know an id dangles), and the owner read the two-row
   * gap between them as a bug on 1 Sep 2026 — which any user would. The gap
   * is not the bug; the SILENCE about it was. The rule mirrors
   * categoryHealth's exactly: a non-blank category id that neither the tree
   * nor an unassigned bucket answers to.
   */
  const danglingCount = useMemo(() => {
    const known = new Set(categories.map(c => c.id));
    return uncategorised.filter(row => row.category && !known.has(row.category)).length;
  }, [uncategorised, categories]);

  /**
   * The rows the filter-and-file list below can actually settle, and the size
   * of the job its card states.
   *
   * Read off the RAW transactions rather than the split-expanded rows above:
   * every row here is one `updateTransaction` can write, and a split line is a
   * virtual projection with a synthetic id. It is a wider question than the
   * backlog figure in any case — a feed's guess is filed but not agreed with,
   * which is work of exactly the kind this page exists for.
   */
  const toFile = useMemo(() => transactions.filter(awaitsFiling), [transactions]);

  /**
   * The part of the backlog above that the list cannot show: lines inside a
   * split, which are filed in their parent. Counted here so the list can say
   * so instead of leaving the reader to find the gap.
   */
  const splitLinesOutstanding = useMemo(
    () => uncategorised.filter(row => row.isSplitLine === true).length,
    [uncategorised]
  );

  // Includes CLOSED accounts — old history is exactly where the
  // uncategorised backlog lives, and "Unknown account" was just a failure
  // to look closed accounts up.
  const accountName = useAccountNames();

  /** Where the unfiled rows actually are, worst first. */
  const byAccount = useMemo(
    () => groupUncategorisedByAccount(uncategorised, accountName),
    [uncategorised, accountName]
  );

  /**
   * Categories the app guessed and nobody has agreed with yet.
   *
   * Deliberately built from the RAW transactions, not the split-expanded rows:
   * nothing in the app ever guesses a split line (a split is always typed by
   * hand or stated by an imported file), so expanding here would only invent
   * work. A split parent's own category is blank, which is not a suggestion
   * either — see categoryProvenance.
   */
  const suggestedGroups = useMemo(() => groupSuggestedByCategory(transactions), [transactions]);
  const suggestedCount = useMemo(
    () => suggestedGroups.reduce((sum, group) => sum + group.rows.length, 0),
    [suggestedGroups]
  );

  /**
   * The same suggestions seen BY ACCOUNT (owner, 24 Aug), each account's own
   * category groups beneath it — the shape the unfiled list above already
   * uses, and the one that answers "what has this card been guessing at?".
   * The category view stays the default: a guess is judged against its
   * category first, and an account is how you narrow it.
   *
   * Persisted, because it is a way of working rather than a one-off look.
   */
  const [suggestedView, setSuggestedView] = useState<'category' | 'account'>(
    () => (preferences.getItem(SUGGESTED_VIEW_KEY) === 'account' ? 'account' : 'category')
  );
  const chooseSuggestedView = (view: 'category' | 'account'): void => {
    setSuggestedView(view);
    preferences.setItem(SUGGESTED_VIEW_KEY, view);
  };

  const suggestedByAccount = useMemo(
    () => groupSuggestedByAccount(transactions, accountName),
    [transactions, accountName]
  );

  const categoryLabel = (categoryId: string): string =>
    categories.find(c => c.id === categoryId)?.name ?? 'Unknown category';

  const confirmGroup = async (
    categoryId: string,
    groupRows: Transaction[],
    /** Which BUTTON is busy — the account view has one per account+category. */
    busyKey: string = categoryId
  ): Promise<void> => {
    setConfirmingCategoryId(busyKey);
    try {
      const confirmed = await confirmTransactionCategories(groupRows.map(row => row.id));
      showSuccess(
        `${formatCount(confirmed)} transaction${confirmed === 1 ? '' : 's'} confirmed as ${categoryLabel(categoryId)}.`,
        'Categories confirmed'
      );
    } catch (error) {
      showError(error);
    } finally {
      setConfirmingCategoryId(null);
    }
  };

  /*
   * "NOT THESE" (owner, 15 Nov 2026). Which group's rows are being refused;
   * held by ids, so the pop-up's list follows the ledger while it is open.
   */
  const [rejecting, setRejecting] = useState<{ categoryId: string; ids: ReadonlySet<string> } | null>(null);
  const rejectingRows = useMemo(
    () => (rejecting
      ? transactions.filter(row => rejecting.ids.has(row.id) && row.category.trim() === rejecting.categoryId && isCategorySuggested(row))
      : []),
    [rejecting, transactions]
  );
  const rejectSuggestions = async (ids: string[]): Promise<void> => {
    if (!rejecting) return;
    const label = categoryLabel(rejecting.categoryId);
    let done = 0;
    try {
      // Through the editor's own audited write, a few at a time: the guess is
      // taken off and the row goes back to be filed.
      for (let start = 0; start < ids.length; start += 10) {
        const batch = ids.slice(start, start + 10);
        await Promise.all(batch.map(id => updateTransaction(id, { category: '', categoryConfirmed: false, needsReview: true })));
        done += batch.length;
      }
      showSuccess(
        `${formatCount(done)} transaction${done === 1 ? '' : 's'} no longer suggested as ${label}. File ${done === 1 ? 'it' : 'them'} above.`,
        'Suggestion taken off'
      );
    } catch (error) {
      if (done > 0) {
        showSuccess(`${formatCount(done)} of ${formatCount(ids.length)} done before the error.`, 'Partly done');
      }
      showError(error);
      throw error;
    }
  };

  const openDrill = (title: string, drillRows: SplitExpandedTransaction[]): void => {
    setDrill({ title, bucket: 'uncategorized', rows: drillRows, total: null });
  };

  /**
   * The suggested list is NOT the uncategorised bucket: those rows already have
   * a category, so the drill's blanks-only inline filing has nothing to do
   * there. 'neutral' gives the plain list with each row opening its editor,
   * which is the right escape hatch when a group needs looking at properly.
   */
  const openSuggestedDrill = (categoryId: string, groupRows: Transaction[]): void => {
    setDrill({
      title: `Suggested as ${categoryLabel(categoryId)}`,
      bucket: 'neutral',
      rows: groupRows,
      total: null,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-gray-900 dark:text-white">Categorisation</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          A transaction with no category is left out of every total in the app. This is where you file them.
        </p>
      </div>

      {count === 0 && transactions.length === 0 ? (
        // AN EMPTY LEDGER IS NOT A FILED LEDGER (owner, 26 Aug, from the
        // desktop build's first open). "Everything is filed" congratulated a
        // ledger with nothing in it — a claim that happened to be vacuously
        // true and read as a lie. Zero transactions is a different state
        // with a different remedy, and the remedy lives on other pages.
        <div className="bg-white dark:bg-gray-800 rounded-xl border-2 border-gray-200 dark:border-gray-700">
          <EmptyState
            title="No transactions to categorise yet"
            description="Once you add or import transactions, this is where you file anything the app could not place — so every report counts all of your money."
          />
        </div>
      ) : count === 0 ? (
        // The hand-rolled centred copy this page carried since batch 7 is what
        // exposed the inconsistency — and it was the one that was right. Now
        // the shared component, which the owner centred app-wide on 15 August.
        <div className="bg-white dark:bg-gray-800 rounded-xl border-2 border-gray-200 dark:border-gray-700">
          <EmptyState
            /* Nothing left to file IS a success, and the app has a token for
               that — the stock blue was a colour standing in for a semantic one
               that already exists (stock-blue ruling, 28 Aug; the same
               substitution OFXImportModal's finished import took). */
            icon={<CheckCircleIcon size={32} className="text-green-700 dark:text-green-400" />}
            title="Everything is filed"
            description={
              suggestedCount === 0
                ? 'Every transaction has a category, so every report is counting all of your money.'
                : 'Every transaction has a category, so every report is counting all of your money — but some of those categories are still the app’s suggestions, below.'
            }
          />
        </div>
      ) : (
        <>
          {/* What is outstanding, and what it is worth. Two columns on a phone,
              four on a desktop — the same shape as the reconciliation bar. */}
          {/* THE LADDER DECIDES THE COLOUR, NOT THE COUNT (Design's per-app
              ruling, 24 Aug). Categorise is the bottom rung: while a feed is
              dead, or rows are unreviewed, or an account disagrees with its
              bank, this panel's figures are not yet facts — so it keeps
              every one of them and gives up only the amber. Standing down
              is about which work is NEXT, never about what the reader is
              allowed to know. */}
          <div className={`bg-white dark:bg-gray-800 rounded-xl border-2 p-4 ${
            ladder.wearsAmber('categorise')
              ? 'border-amber-300 dark:border-amber-600'
              : 'border-line dark:border-gray-700'
          }`}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
              <div className="text-center">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Needs a category</p>
                <p className={`text-lg font-bold tabular-nums ${
                  ladder.wearsAmber('categorise')
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-gray-900 dark:text-white'
                }`}>
                  {formatCount(count)}
                </p>
              </div>
              <div className="text-center">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Money in</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white tabular-nums" data-testid="categorisation-money-in">
                  {flows.holdsForeign ? '≈ ' : ''}{formatCurrency(flows.uncategorizedIn.toNumber())}
                </p>
              </div>
              <div className="text-center col-span-2 md:col-span-1">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Money out</p>
                <p className="text-lg font-bold text-gray-900 dark:text-white tabular-nums" data-testid="categorisation-money-out">
                  {flows.holdsForeign ? '≈ ' : ''}{formatCurrency(flows.uncategorizedOut.toNumber())}
                </p>
              </div>
            </div>
          </div>

          {/* Why this count can read HIGHER than the register's "to review":
              rows filed under a category that no longer exists are filing
              work (their money is in no report) but not row-review work (the
              row-local flag cannot know an id dangles). The owner met the
              unexplained two-row gap on 1 Sep 2026 and read it as a bug —
              which any user would. Named here, with the remedy, per the
              data-health rule; at zero it renders nothing.

              THE LINK LANDS ON THE ROWS (owner, from a user, 1 Sep 2026). It
              used to point at that page's front door, where the data-health
              panel said the same thing again and offered a link back HERE — a
              closed circle that never showed anybody a row. It now carries the
              ask in the address, so the page it opens has the Re-categorise
              section open on exactly these rows, each with its own picker. See
              utils/categoryRefileLink. */}
          {danglingCount > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {formatCount(danglingCount)} of these {danglingCount === 1 ? 'is' : 'are'} filed
              under a category that no longer exists, so {danglingCount === 1 ? 'it' : 'they'}{' '}
              {danglingCount === 1 ? 'does not' : 'do not'} show in the register's review count
              — repair {danglingCount === 1 ? 'it' : 'them'} under{' '}
              <Link
                to={preserveDemoParam(CATEGORY_REFILE_DANGLING_PATH, location.search)}
                className="underline hover:no-underline"
              >
                Manage&nbsp;→&nbsp;Categories
              </Link>.
            </p>
          )}

          {/* The basis these two figures are on. Same component the report hub
              mounts, so this page cannot drift from a report that quotes the
              same backlog — and it degrades the same way: no ECB history, no
              conversion, and the Phase 0 sentence says the totals are native
              rather than a third basis nobody stated. */}
          <ReportCurrencyNote />

          {/* The three ways through, cheapest first: a transfer sweep can clear
              thousands of rows without a decision, filing a payee clears every
              row for that merchant at once, and a search-and-tick is the
              general case. */}
          <div className="grid gap-3 md:grid-cols-3">
            <ActionCard
              icon={<ArrowRightLeftIcon size={22} />}
              title="Match transfers"
              body="Find equal-and-opposite pairs across your accounts and link them in one go. Money moved between your own accounts is neither income nor spending."
              onClick={() => setShowTransferSweep(true)}
            />
            <ActionCard
              icon={<TagIcon size={22} />}
              title="Categorise by payee"
              body="File a whole merchant at once, and teach future imports to file it for you."
              onClick={() => setShowBulkCategorize(true)}
            />
            {/* Nothing to file, no card — the third way through is the one
                whose whole body is a count (house rule: a zero renders
                nothing). Its two neighbours have work to do either way.

                The second sentence is there because this count is NOT the
                panel's: it is the register's "to review" population, so it
                also holds rows the app guessed at, which are filed and
                therefore counted in no backlog. The owner met an unexplained
                gap between two counters on 1 Sep 2026 and read it as a bug —
                which is what an unexplained gap is. */}
            {toFile.length > 0 && (
              <ActionCard
                icon={<ListIcon size={22} />}
                title="Filter and file"
                body={`${toFile.length === 1
                  ? 'Search the one outstanding transaction, tick it, and file it in one press.'
                  : `Search the ${formatCount(toFile.length)} outstanding transactions, tick them, and file them in one press.`
                } Rows with no category and the app’s own guesses are both here.`}
                onClick={() => setFiling(showing => !showing)}
                expanded={filing}
              />
            )}
          </div>
        </>
      )}

      {/* OUTSIDE the branch above, and that is load-bearing: filing the last
          of the backlog takes this page to "Everything is filed", and a list
          that lived in the other arm would take its own account of the press —
          and the one shot back — off the screen at the exact moment they were
          the only things on it worth reading. */}
      <FileOutstandingSection
        open={filing}
        onHide={() => setFiling(false)}
        splitLines={splitLinesOutstanding}
        arrival={fileArrival}
      />

      {/* Which accounts the work is actually in — the same "pick one and
          clear it" shape as the reconciliation account list. */}
      {count > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">By account</h2>
          <div className="flex flex-col gap-2">
            {byAccount.map(({ accountId, rows: accountRows }) => (
              <button
                key={accountId}
                type="button"
                onClick={() => openDrill(`Uncategorised — ${accountName(accountId)}`, accountRows)}
                className="w-full text-left bg-white dark:bg-gray-800 rounded-xl border-2 border-gray-200 dark:border-gray-700 hover:border-primary hover:shadow-md transition-all p-4 flex items-center gap-3"
              >
                <span className="font-medium text-gray-900 dark:text-white truncate min-w-0 flex-1">
                  {accountName(accountId)}
                </span>
                {/* NEUTRAL — a count is not a signal (Design, 25 Aug §4,
                    and their own rule since the 13th: "a zero, a count and a
                    settled row need none"). Five soft ambers sat here on the
                    page representing the STOOD-DOWN categorise rung, which
                    is precisely the erosion the ladder exists to prevent.
                    Not rung-dependent: a per-account count has no business
                    wearing the attention colour at any rung, so this is
                    neutral outright rather than conditional. */}
                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 whitespace-nowrap">
                  {formatCount(accountRows.length)}
                </span>
                <ChevronRightIcon size={18} className="text-gray-400 flex-shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Suggestions waiting to be agreed with ────────────────────────────
          A separate chore from the one above, and deliberately below it: an
          unfiled row is money the reports cannot see, while a suggested row is
          already counted and merely unverified. Shown even when nothing is
          uncategorised, because "is every category actually mine?" is a
          question in its own right.

          There is no "confirm everything" button, and that is on purpose.
          Confirming without looking would relabel every guess as a decision in
          one click and put us straight back where we started — unable to tell
          what has been checked. A category group is the smallest unit that can
          honestly be judged at a glance. */}
      {suggestedCount > 0 && (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              Suggested categories ({formatCount(suggestedCount)})
            </h2>
            {/* The same segmented idiom the period picker uses. */}
            <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-0.5">
              {([['category', 'By category'], ['account', 'By account']] as const).map(([view, label]) => (
                <button
                  key={view}
                  type="button"
                  onClick={() => chooseSuggestedView(view)}
                  aria-pressed={suggestedView === view}
                  className={`px-3 py-1 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                    suggestedView === view
                      ? 'bg-[#1a2332] dark:bg-[#2d3a4d] text-white'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
            The app filled these in from what you have filed before. They already count in your
            reports — confirming just records that you have checked them.
          </p>
          <div className="flex flex-col gap-2">
            {suggestedView === 'category'
              ? suggestedGroups.map(({ categoryId, rows: groupRows }) => (
                  <SuggestedGroupRow
                    key={categoryId}
                    label={categoryLabel(categoryId)}
                    rows={groupRows}
                    busy={confirmingCategoryId !== null}
                    confirming={confirmingCategoryId === categoryId}
                    onOpen={() => openSuggestedDrill(categoryId, groupRows)}
                    onConfirm={() => void confirmGroup(categoryId, groupRows)}
                    onReject={() => setRejecting({ categoryId, ids: new Set(groupRows.map(row => row.id)) })}
                  />
                ))
              : suggestedByAccount.map(({ accountId, rows: accountRows, categories: accountCategories }) => (
                  <div key={accountId} className="flex flex-col gap-2">
                    {/* The account heads its own categories — the depth ladder's
                        top step, as everywhere a section heads its rows. */}
                    <div className={`flex items-baseline justify-between gap-3 rounded px-2 py-2 ${DEPTH_LEVEL_1}`}>
                      <span className="text-sm font-bold text-gray-900 dark:text-white truncate">
                        {accountName(accountId)}
                      </span>
                      <span className="text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {formatCount(accountRows.length)} suggested
                      </span>
                    </div>
                    {accountCategories.map(({ categoryId, rows: groupRows }) => (
                      <SuggestedGroupRow
                        key={`${accountId}-${categoryId}`}
                        label={categoryLabel(categoryId)}
                        rows={groupRows}
                        indent
                        busy={confirmingCategoryId !== null}
                        confirming={confirmingCategoryId === `${accountId}-${categoryId}`}
                        onOpen={() => openSuggestedDrill(categoryId, groupRows)}
                        // Confirms THIS ACCOUNT's rows for that category, not
                        // every account's: the view is the scope.
                        onConfirm={() => void confirmGroup(categoryId, groupRows, `${accountId}-${categoryId}`)}
                        onReject={() => setRejecting({ categoryId, ids: new Set(groupRows.map(row => row.id)) })}
                      />
                    ))}
                  </div>
                ))}
          </div>
        </div>
      )}

      <ReportDrillModal target={drill} onClose={() => setDrill(null)} categories={categories} />
      <TransferSweepModal isOpen={showTransferSweep} onClose={() => setShowTransferSweep(false)} />
      <BulkCategorizeModal isOpen={showBulkCategorize} onClose={() => setShowBulkCategorize(false)} />
      {rejecting && (
        <RejectSuggestionsModal
          label={categoryLabel(rejecting.categoryId)}
          rows={rejectingRows}
          accountName={accountName}
          onClose={() => setRejecting(null)}
          onReject={rejectSuggestions}
        />
      )}
    </div>
  );
}

function ActionCard({
  icon,
  title,
  body,
  onClick,
  expanded,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onClick: () => void;
  /**
   * Set only by the card that reveals something on this page rather than
   * opening a modal — the two that open one say nothing, which is right: a
   * dialog announces itself.
   */
  expanded?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className="text-left bg-white dark:bg-gray-800 rounded-xl border-2 border-gray-200 dark:border-gray-700 hover:border-primary hover:shadow-md transition-all p-4 flex flex-col gap-2 min-h-[48px]"
    >
      <span className="flex items-center gap-2 text-gray-900 dark:text-white font-semibold">
        {/* `text-primary` ALONE, on purpose: index.css gives it a dark
            counterpart (#f9fafb) with `!important`, so the `dark:text-blue-400`
            that used to sit here was a stock blue invented for a ground the
            token already answers for (stock-blue ruling, 28 Aug). */}
        <span className="text-primary">{icon}</span>
        {title}
      </span>
      <span className="text-sm text-gray-500 dark:text-gray-400">{body}</span>
    </button>
  );
}

/**
 * One suggested group — a guessed category, its size, and the way to agree
 * with it.
 *
 * NEUTRAL, not amber (Design ruling, 24 Aug §1a). Seven amber buttons in a
 * column was the most amber the app had ever shown at once, and under
 * Ruling A amber is "this one, next" — singular. These are not next actions
 * in that sense either: the panel above them says the rows already count in
 * the reports and confirming only records that they were checked, which
 * makes this optional bookkeeping. A quiet outline is what optional
 * bookkeeping looks like.
 */
function SuggestedGroupRow({
  label,
  rows,
  indent = false,
  busy,
  confirming,
  onOpen,
  onConfirm,
  onReject,
}: {
  label: string;
  rows: readonly Transaction[];
  indent?: boolean;
  busy: boolean;
  confirming: boolean;
  onOpen: () => void;
  onConfirm: () => void;
  /** Opens the "which are not this?" list (owner, 15 Nov 2026). */
  onReject: () => void;
}): React.JSX.Element {
  return (
    <div
      className={`w-full bg-white dark:bg-gray-800 rounded-xl border border-line dark:border-gray-700 p-4 flex items-center gap-3 ${
        indent ? 'ml-4' : ''
      }`}
    >
      <div className="p-2 bg-gray-100 dark:bg-gray-700/50 rounded-lg flex-shrink-0">
        <TagIcon size={20} className="text-gray-500 dark:text-gray-400" />
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="font-medium text-gray-900 dark:text-white truncate min-w-0 flex-1 text-left hover:underline"
        title="Look through these transactions before deciding"
      >
        {label}
        <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
          {formatCount(rows.length)} transaction{rows.length === 1 ? '' : 's'}
        </span>
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className="px-4 h-[42px] inline-flex items-center justify-center text-sm font-medium rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap flex-shrink-0"
      >
        {confirming ? 'Confirming…' : 'Confirm these'}
      </button>
      <button
        type="button"
        onClick={onReject}
        disabled={busy}
        title="Choose which of these are not this category"
        className="px-4 h-[42px] inline-flex items-center justify-center text-sm font-medium rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap flex-shrink-0"
      >
        Not these…
      </button>
    </div>
  );
}
