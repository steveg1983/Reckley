import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
// Through `@identity`, not through Clerk. The one thing this page wanted a
// session for is a KEY to namespace a stored setting by, which is precisely
// and only what that seam answers — see src/editions/identity.ts. It was the
// last cloud root a walk from this page could find once `@session` took the
// state layer's preamble away.
import { useIdentityKey } from '@identity';
import {
  AlertCircleIcon,
  ChevronRightIcon,
  WalletIcon,
  PieChartIcon,
  SettingsIcon,
  XIcon,
  BarChart3Icon,
  CheckIcon
} from '../icons';
import { useApp } from '../../contexts/AppContextSupabase';
import { useCurrencyDecimal } from '../../hooks/useCurrencyDecimal';
import { useConvertedNetWorth, type AccountBalanceEntry } from '../../hooks/useConvertedNetWorth';
import { useInvestmentValuation } from '../../hooks/useInvestmentValuation';
import { netWorthPointToken } from '../../utils/netWorthSeries';
import { useNetWorthConversion } from '../../hooks/useNetWorthConversion';
import { useFlowConvert } from '../../hooks/useFlowConvert';
import MixedCurrencyDisclosure from '../MixedCurrencyDisclosure';
import { preserveDemoParam } from '../../utils/navigation';
import EmptyState from '../EmptyState';
import FilteredEmptyState from '../FilteredEmptyState';
import TrendArrow from '../TrendArrow';
import { TableSkeleton, type TableSkeletonColumn } from '../loading/TableSkeleton';
import { useDelayedFlag } from '../../hooks/useDelayedFlag';
import EditTransactionModal from '../EditTransactionModal';
import IncomeExpenseBreakdownModal from '../IncomeExpenseBreakdownModal';
import { Modal, ModalBody } from '../common/Modal';
import PeriodBar from '../../components/PeriodBar';
import { WholePoundsToggle } from '../../contexts/WholePoundsContext';
import NetWorthSummary from '../../components/NetWorthSummary';
import FirstSteps from './FirstSteps';
import HistoryPathCard from './HistoryPathCard';
import { useHistoryPath } from './useHistoryPath';
import AccountBreakdownModal, { type AccountBreakdownView } from '../../components/AccountBreakdownModal';
import { PERIOD_LABELS, usePeriod } from '../../hooks/usePeriod';
import { cardPeriodKey, useCardPeriod } from '../../hooks/useCardPeriod';
import {
  NetWorthWidget,
  IncomeExpenseTrendWidget,
  ExpenseCategoriesWidget,
  CustomReportWidget,
} from './reportWidgets/DashboardReportWidgets';
import DashboardWidgetCard from './reportWidgets/DashboardWidgetCard';
import CardPeriodControl from './reportWidgets/CardPeriodControl';
import { useReportDrill } from './reportWidgets/useReportDrill';
import { WIDGET_CHART_HEIGHT } from './reportWidgets/widgetChrome';
import { BUILT_IN_REPORTS, type PinnableReportId } from './reportWidgets/pinnableReports';
import { PieChart, BarChart, ResponsiveContainer } from '../charts/DashboardCharts';
import { categoricalColor, useCategoricalRamp } from '../charts/chartColors';
import { formatDecimal } from '../../utils/decimal-format';
import { toDecimal } from '../../utils/decimal';
import { getDateLocale } from '../../utils/dateFormatter';
import { expandSplitTransactions } from '../../utils/transactionSplits';
import { computeIncomeExpense } from '../../utils/incomeExpense';
import { computeAccountBalances } from '../../utils/accountBalances';
import {
  ACCOUNT_DISTRIBUTION_REMAINDER_ID,
  buildAccountDistribution,
  type AccountDistributionEntry,
} from '../../utils/accountDistribution';
import { groupAccountsBySection } from '../../utils/accountGrouping';
import { swapPositions, moveBySteps, previewStep } from '../../utils/reorderList';
import { buildCategoryNameLookup } from '../../utils/categoryNames';
import { compareText } from '../../utils/localeFormat';
import { evaluateBudgets } from '../../utils/budgetEvaluation';
import { foreignCurrencyAccountIds } from '../../utils/budgetSpending';
import type { BudgetPeriodWindow } from '../../utils/budgetPeriods';
import { describeBudgetMeasure, describeBudgetWindow } from '../../utils/budgetPace';
import { measureBudget } from '../../utils/budgetView';
import BudgetViewChoice from '../budget/BudgetViewChoice';
import { useBudgetView } from '../../hooks/useBudgetView';
import ReportDrillModal, { type ReportDrillTarget } from '../reports/ReportDrillModal';
import { buildAttentionItems } from '../../utils/attentionItems';
import { loadAutoSyncPrefs } from '../../utils/bankAutoSync';
import { buildAccountBankLinks } from '../../hooks/accountBankLinks';
import { useBankConnectionSnapshot } from '@service';
import { preferences } from '../../services/preferencesService';

/**
 * Where this page remembers the window it is being read over.
 *
 * The ORIGINAL key, deliberately. The dashboard has had three period controls
 * at various times — one for Performance, one for each half of the reports box
 * — and this is the one that predates all of them, so collapsing back to a
 * single page-level control keeps the choice the user already made rather than
 * starting them somewhere new. (`dashboardReportsFlows` and
 * `dashboardPerformance` are no longer read; a stored value under either is
 * simply ignored.)
 */
const DASHBOARD_PERIOD_KEY = 'dashboardReports';

/**
 * The heading of the two-figure card, in one place because it is also the name
 * its period control announces and the name the report drill-through uses. The
 * STORAGE key stays `…pin.performance`: renaming a heading must not lose
 * anyone's pinned window, and the key is not something a user ever reads.
 *
 * NOT "Money in, money out", which was the first choice and is wrong in this
 * app specifically. Money moves in and out for reasons that are neither income
 * nor an expense — a revaluation, an account adjustment, a transfer between two
 * of your own accounts — and this card counts none of them: `bucketByCategoryDirection`
 * admits only rows whose CATEGORY says income or expense. A heading promising
 * every movement, over two figures that exclude three kinds of movement, would
 * be a number that does not add up to its own title.
 */
const INCOME_AND_EXPENSES_TITLE = 'Income and Expenses';

/**
 * What a balance card is shaped like, for the placeholder that waits in its
 * place (DESIGN_PASS §4).
 *
 * The card is `p-4` around two stacked lines on the left (name over
 * institution) and the figure on the right, so the placeholder gets the same
 * two tracks at the same height and the grid does not reflow when the real
 * cards land.
 */
const ACCOUNT_CARD_SKELETON_COLUMNS: TableSkeletonColumn[] = [
  { key: 'name', className: 'flex-1' },
  { key: 'balance', width: '7rem' },
];

/**
 * What a balance card measures. MEASURED in the running app at 1280px, not
 * added up from the classes: `p-4` over two short lines reads as 76px on
 * paper and is 120px in the DOM, and a placeholder at the paper figure would
 * let the page jump by a third of a card per row as the real ones land.
 */
const ACCOUNT_CARD_HEIGHT = 120;

/**
 * Improved Dashboard with better information hierarchy
 * Design principles:
 * 1. Progressive disclosure - show most important info first
 * 2. Visual hierarchy - use size, color, and spacing
 * 3. Actionable insights - every section leads somewhere
 * 4. Mobile-optimized - works great on all screen sizes
 */
/**
 * The window a budget is measured over, as a person would say it —
 * "1–31 Oct 2026" — in the date locale the rest of the app uses. A budget's
 * figure without its period was the owner's complaint about this card: an
 * overspend is only a fact about some stretch of days, and the card never
 * said which.
 */
/** What the budget card's drill needs of a row: enough to name it and find its rows. */
interface BudgetStatusRow {
  categoryName: string;
  spent: number;
  window: BudgetPeriodWindow;
  /** The days the figure covers under the chosen reading — the drill's title. */
  measuredOver: { start: Date; end: Date };
  countedRowIds: ReadonlySet<string>;
}

/** How many budgets the card shows when the owner has never chosen any. */
const DEFAULT_KEY_BUDGETS = 3;

export function ImprovedDashboard() {
  // `customReports` comes from the context because the picker below lists them
  // INLINE in a modal body — there is no await to put a fetch in, and this used
  // to be a synchronous `localStorage` read. They ride the boot snapshot now;
  // `BootSnapshot` argues why that is the shape rather than a per-component
  // fetch.
  const { accounts, transactions, transactionSplits, budgets, categories, customReports, serverBalances, isLoading } = useApp();
  const { formatCurrency: formatCurrencyWithSymbol, displayCurrency } = useCurrencyDecimal();
  /**
   * THE HISTORY GUIDE SUPERSEDES FIRST STEPS (owner's ruling, 1 Sep 2026).
   *
   * Both cards can be earned at once — a fresh ledger with a year of statements
   * imported and nothing filed meets the first-steps checklist AND the guide's
   * hundred-row threshold — and the two then said overlapping things in two
   * voices, one under the other. The guide's first two steps are that checklist
   * done better (they name the order, and they are followed by the five that
   * were missing), so while it is up First steps stands down.
   *
   * Asked of the guide's own hook, never re-derived here: one definition of
   * "the guide is on screen", read by the card that draws it and by the gate
   * that hides its predecessor. Nothing else about First steps changes — a
   * dismissal mid-journey, or a backlog that never met the threshold, leaves it
   * exactly as it was, boot included.
   */
  const { visible: historyPathVisible } = useHistoryPath();
  const identityKey = useIdentityKey();
  const navigate = useNavigate();
  const location = useLocation();
  const [showAccountSettings, setShowAccountSettings] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  /**
   * KEY BUDGETS (owner, 7 Nov 2026): the same cog the key accounts have.
   * The card showed the first three budgets in list order and nothing could
   * change that. Now the owner chooses which budgets sit on his front page;
   * `null` means he never has, and the first three stand in — a default,
   * never written, so a person who has not chosen is not recorded as having
   * chosen three. The stored order is the display order, as it is for the
   * accounts. A statement about HIS budgets, so it travels with the account
   * (a portable preference, and its ids are followed through a restore).
   */
  const [showBudgetSettings, setShowBudgetSettings] = useState(false);
  // How a long budget is read (owner, 10 Nov 2026): so far, this month, or
  // whole. One setting, shared with the Budget page — see utils/budgetView.
  const [budgetView, setBudgetView] = useBudgetView();
  const [selectedBudgetIds, setSelectedBudgetIds] = useState<string[] | null>(() => {
    try {
      const stored = JSON.parse(preferences.getItem('dashboardKeyBudgets') ?? 'null');
      if (Array.isArray(stored)) return stored.filter((id): id is string => typeof id === 'string');
    } catch { /* fall through to the default */ }
    return null;
  });
  const persistBudgetSelection = useCallback((ids: string[]) => {
    preferences.setItem('dashboardKeyBudgets', JSON.stringify(ids));
    setSelectedBudgetIds(ids);
  }, []);
  const [breakdownType, setBreakdownType] = useState<'income' | 'expense' | null>(null);
  // A row in the breakdown list opens the full editor — check details, fix a
  // category — and the list re-derives live, so a re-categorised transaction
  // drops out of it immediately.
  const [editingBreakdownTxnId, setEditingBreakdownTxnId] = useState<string | null>(null);
  // Pinned reports: the user chooses which live reports show on the
  // Dashboard (built-ins + their custom reports). What matters is different
  // to different users.
  const [pinnedReports, setPinnedReports] = useState<PinnableReportId[]>(() => {
    try {
      const stored = JSON.parse(preferences.getItem('dashboardPinnedReports') ?? 'null');
      if (Array.isArray(stored)) return stored as PinnableReportId[];
    } catch { /* fall through to the default */ }
    return ['net-worth'];
  });
  const [showReportPicker, setShowReportPicker] = useState(false);
  /**
   * ONE clock for the whole page.
   *
   * There were three, in the same style, each governing only the section it
   * happened to sit in — so none of them declared what it covered and two of
   * them were feet apart on screen (DESIGN_PASS_2026-08 §3.4). A page-level bar
   * under the heading says what it governs by WHERE IT IS, which is the thing
   * the section-local pickers could not do at any size.
   *
   * Twelve months is the default because it is the window that reads on every
   * figure below: net worth over a single month is a dot, while income and
   * spending over a year is a perfectly ordinary question to ask. It is also
   * the default this storage key already had, so nobody's stored dashboard
   * moves underneath them.
   */
  const period = usePeriod(DASHBOARD_PERIOD_KEY, 'last-12-months');

  /**
   * …AND THE FOUR CARDS THAT MAY DECLARE THEMSELVES OUT OF IT.
   *
   * The page clock above is still the law, and it is still the default for
   * every one of these. What changed is that the law now has a stated
   * exception, because the owner hit the cost of not having one: all-time net
   * worth forced all-time income-vs-expenses, and a stock and a flow are
   * different lenses with different natural windows.
   *
   * These are the page's period CONSUMERS, and they are all of them. Net worth
   * summary, account distribution, key balances and the attention list read
   * today's balances; budget status reads a rolling thirty days on purpose;
   * a pinned custom report carries its own filters. None of those four can be
   * pinned, because none of them is being read over the page's window in the
   * first place — a period control on a card that ignores periods is the same
   * undeclared scope this whole design is against, pointed the other way.
   *
   * An unpinned card is handed `period` ITSELF, not a copy of it, so "follows
   * the page" needs nothing keeping it true. See hooks/useCardPeriod.
   */
  const netWorthCard = useCardPeriod(cardPeriodKey(DASHBOARD_PERIOD_KEY, 'net-worth'), period);
  const trendCard = useCardPeriod(cardPeriodKey(DASHBOARD_PERIOD_KEY, 'income-expense-trend'), period);
  const categoriesCard = useCardPeriod(cardPeriodKey(DASHBOARD_PERIOD_KEY, 'expense-categories'), period);

  /**
   * Performance can be LOCKED to Income vs Expenses, and is the only card that
   * can be locked to anything — because it is the only pair on this page that
   * measures one thing twice. Performance is the total of income and expenses
   * over a window; the trend chart is those two numbers month by month. A total
   * covering a different period from the chart of that total is a contradiction
   * rather than a preference.
   *
   * `trendCard.picker` rather than `trendCard`'s own window: the trend card may
   * itself be following the page, so the lock passes through whatever it has
   * resolved to. Set the chart to 12 months and the figures follow; put the
   * chart back on Default and the figures follow it back to the page bar.
   *
   * Offered only while the chart is actually ON the dashboard. Locking to a
   * card the owner has unpinned would tie these figures to a window nothing on
   * screen can show or change, so the partner is withheld and the card falls
   * back to the page — see useCardPeriod.
   */
  const trendIsOnDashboard = pinnedReports.includes('income-expense-trend');
  const performanceCard = useCardPeriod(
    cardPeriodKey(DASHBOARD_PERIOD_KEY, 'performance'),
    period,
    undefined,
    trendIsOnDashboard ? { picker: trendCard.picker, label: 'Income vs Expenses' } : undefined
  );
  const performancePeriod = performanceCard.picker;

  // The Account Distribution card lives here rather than in
  // DashboardReportWidgets, so it reaches for the same click-through as its
  // neighbours instead of growing a second one that drifts.
  const openReport = useReportDrill();

  /**
   * The transactions behind a budget's figure, in the same drill the report
   * cards open — the rows, their total, and the row editor inside it. The
   * card used to answer a click with nothing, and "£655 of £500" with no way
   * to see the £655 is a verdict without the evidence (the owner, 15 Oct
   * 2026). The rows are the ones the evaluation COUNTED, by id, so the drill
   * can never list a row the figure left out or leave out one it took.
   */
  const [budgetDrill, setBudgetDrill] = useState<ReportDrillTarget | null>(null);

  const togglePinnedReport = (id: PinnableReportId): void => {
    setPinnedReports(prev => {
      const next = prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id];
      preferences.setItem('dashboardPinnedReports', JSON.stringify(next));
      return next;
    });
  };
  
  // Which accounts the owner put on his own front page. A statement about HIS
  // accounts, so it travels with the account rather than with this browser.
  useEffect(() => {
    try {
      const saved = preferences.getItem('dashboardKeyAccounts');
      const parsed = saved ? JSON.parse(saved) : null;
      if (Array.isArray(parsed)) {
        setSelectedAccountIds(parsed);
        return;
      }
    } catch {
      preferences.removeItem('dashboardKeyAccounts');
    }
    // Default to showing first 4 accounts
    setSelectedAccountIds(accounts.slice(0, 4).map(a => a.id));
  }, [accounts]);

  // Real balance = openingBalance + Σ transactions, computed in ONE pass over
  // the whole transaction set. The previous per-account filters were
  // O(accounts × transactions) and ran up to five times per account —
  // ~50 MILLION Decimal operations per render on a 50k-row dataset. While the
  // transaction pages are still streaming in, the server's one-round-trip
  // balances stand in (see computeAccountBalances).
  /**
   * Which summary figure is opened out into its accounts — the same
   * AccountBreakdownModal the Accounts page drills with (owner, 16 August:
   * "make the 'what you own' and 'what you owe' clickable"). Rows are fed
   * from the SAME accountBalanceMap the tiles sum, so the modal's total and
   * the tile cannot disagree.
   */
  const [breakdownView, setBreakdownView] = useState<AccountBreakdownView | null>(null);

  const accountBalanceMap = useMemo(
    () => computeAccountBalances(accounts, transactions, serverBalances),
    [accounts, transactions, serverBalances]
  );

  /**
   * The SAME conversion the Accounts page's card runs (currency audit,
   * 22 Aug): this trio renders the same NetWorthSummary component as that
   * card, and until now was its un-fixed twin — native units summed as
   * display units, so a dollar account counted as that many pounds. The
   * single-currency majority keeps the exact arithmetic below; only a ledger
   * that actually spans currencies converts, and says so.
   */
  // The valuation term (slice 3b): today's derived investment value joins
  // every account balance BEFORE the trio sums or converts — so the card,
  // the reports and the series state one net worth. Zero for every account
  // without open positions, and until the valuation's reads land.
  const valuation = useInvestmentValuation();
  const valuationDayKey = netWorthPointToken(new Date());
  const netWorthEntries = useMemo<AccountBalanceEntry[]>(
    () => accounts.map(a => ({
      balance: toDecimal(accountBalanceMap.get(a.id) ?? 0).plus(valuation.deltaAt(a.id, valuationDayKey)),
      currency: a.currency || displayCurrency,
    })),
    [accounts, accountBalanceMap, displayCurrency, valuation, valuationDayKey]
  );
  const spansCurrencies = useMemo(
    () => netWorthEntries.some(entry => entry.currency !== displayCurrency),
    [netWorthEntries, displayCurrency]
  );
  const convertedNetWorth = useConvertedNetWorth(netWorthEntries, displayCurrency);
  // Per-account factors for the breakdown modal's rows — same rates cache as
  // the trio's conversion, so the drill cannot quote a different rate than
  // the card it opens from. Null on a single-currency ledger.
  const { conversion: rowConversion } = useNetWorthConversion(accounts);
  const flowConvert = useFlowConvert(accounts);

  // Calculate key metrics — all money sums use Decimal arithmetic (float math
  // is banned on currency values; IEEE-754 drifts on long sums).
  const metrics = useMemo(() => {
    // Ledger balance plus today's valuation term — the same figure the trio's
    // converted path sums, so the two paths cannot disagree.
    const effectiveBalance = (acc: typeof accounts[0]): number =>
      toDecimal(accountBalanceMap.get(acc.id) ?? 0)
        .plus(valuation.deltaAt(acc.id, valuationDayKey))
        .toNumber();

    const totalAssets = accounts
      .filter(acc => effectiveBalance(acc) > 0)
      .reduce((sum, acc) => sum.plus(toDecimal(effectiveBalance(acc))), toDecimal(0))
      .toNumber();

    const totalLiabilities = accounts
      .filter(acc => effectiveBalance(acc) < 0)
      .reduce((sum, acc) => sum.plus(toDecimal(effectiveBalance(acc)).abs()), toDecimal(0))
      .toNumber();

    const netWorth = toDecimal(totalAssets).minus(toDecimal(totalLiabilities)).toNumber();

    // Budget status reads each budget over ITS OWN period — the calendar
    // month for a monthly budget, the week for a weekly one — through the one
    // evaluation the Budget page uses (utils/budgetEvaluation): group budgets
    // roll their children up, the carry a budget's mode allows is counted
    // into the allowance, refunds net off, a legacy category name is healed.
    // It used to sum the
    // budget's own category over a rolling thirty days against the base
    // amount here, which is no period a budget has — so the same budget read
    // one figure on this card and another on the Budget page, and this card
    // could not say what stretch of days its figure was for (the owner,
    // 15 Oct 2026: "I cannot easily see what period that is for").
    const categoryNameFor = buildCategoryNameLookup(categories);
    const budgetStatus = evaluateBudgets(budgets.filter(b => b.isActive), {
      transactions,
      transactionSplits,
      categories,
      foreignAccountIds: foreignCurrencyAccountIds(accounts, displayCurrency),
      // The whole set, so what one budget sends another is counted here too.
      budgets,
    })
      // This card answers "how am I doing": a budget past its end date has
      // nothing to be doing, and one that has not started would read "0%
      // used" for a budget nobody has had the chance to use. Both stay on the
      // Budget page, captioned as what they are.
      .filter(({ window }) => !window.ended && !window.notStarted)
      .map(evaluated => {
      const { budget, categoryId, window } = evaluated;
      // The figures under the chosen reading: a yearly budget read "so far"
      // is measured against the months that have begun, not the year.
      const measure = measureBudget(evaluated, budgetView);
      return {
      ...budget,
      categoryId,
      // The budget's own category, NAMED. It was rendering `categoryId`
      // straight onto the screen — three raw UUIDs down the dashboard where
      // "Food & Drink" belongs — which is precisely what
      // `buildCategoryNameLookup` exists to prevent, in its own words: "a raw
      // category id must never reach a screen." Resolved once here so the
      // label, the group's aria-label and the progress bar's all say the same
      // thing.
      categoryName: categoryNameFor(categoryId),
      // The allowance for the window with the carry counted in — the figure
      // the Budget page's card shows, so "£655 / £600" reads the same there.
      amount: measure.allowance.toNumber(),
      spent: measure.spent.toNumber(),
      remaining: measure.remaining.toNumber(),
      percentUsed: measure.percentage,
      isOverBudget: measure.spent.gt(measure.allowance),
      window,
      // The rows behind THIS figure, so the drill shows what was counted.
      countedRowIds: measure.rowIds,
      measuredOver: { start: measure.start, end: measure.end },
      caption: describeBudgetMeasure(window, measure),
      // The same, as a sentence for a screen reader: the whole period keeps
      // the words it always had, "monthly, 1–31 Oct 2026".
      spokenCaption: measure.view === 'period'
        ? `${window.label.toLowerCase()}, ${describeBudgetWindow(window)}`
        : describeBudgetMeasure(window, measure).replace(' · ', ', ').replace(/^./, first => first.toLowerCase()),
      // Whether the choice changes anything for this budget at all.
      hasMonths: evaluated.months !== null,
    };
    });

    return {
      netWorth,
      totalAssets,
      totalLiabilities,
      budgetStatus,
    };
  }, [accounts, accountBalanceMap, transactions, transactionSplits, budgets, categories, displayCurrency, valuation, valuationDayKey, budgetView]);

  /**
   * The budgets the card shows, in the stored order — or the first three when
   * nothing was ever chosen. An id that names no running budget (deleted,
   * finished, not yet started) is simply skipped: the choice outlives the
   * budget, and comes back if the budget does.
   */
  const displayedBudgets = useMemo(() => {
    const running = metrics.budgetStatus;
    if (selectedBudgetIds === null) return running.slice(0, DEFAULT_KEY_BUDGETS);
    const byId = new Map(running.map(b => [b.id, b]));
    return selectedBudgetIds
      .map(id => byId.get(id))
      .filter((b): b is typeof running[number] => b !== undefined);
  }, [metrics.budgetStatus, selectedBudgetIds]);

  // "% used" is asked of the budgets ON THE CARD — the question the card
  // answers — not of every budget the page is not showing.
  const displayedBudgetPercent = useMemo(() => {
    const budgeted = displayedBudgets.reduce((sum, b) => sum.plus(toDecimal(b.amount)), toDecimal(0));
    if (!budgeted.greaterThan(0)) return 0;
    const spent = displayedBudgets.reduce((sum, b) => sum.plus(toDecimal(b.spent)), toDecimal(0));
    return spent.dividedBy(budgeted).times(100).toNumber();
  }, [displayedBudgets]);

  /**
   * The picker lists every running budget under its category's GROUP, A–Z,
   * the way the Budget page orders its cards; a budget whose category has no
   * group sits last, under its own heading, rather than first.
   */
  const budgetSections = useMemo(() => {
    const running = metrics.budgetStatus;
    const groupOf = (categoryId: string): string => {
      const category = categories.find(c => c.id === categoryId);
      if (!category?.parentId) return '';
      return categories.find(c => c.id === category.parentId)?.name ?? '';
    };
    const groups = new Map<string, typeof running>();
    for (const budget of running) {
      const name = groupOf(budget.categoryId);
      groups.set(name, [...(groups.get(name) ?? []), budget]);
    }
    // Under its group's heading a budget is named by its LEAF — "Food
    // Shopping", not "Home : Food Shopping" — the path the card shows would
    // repeat the heading on every line.
    const leafOf = (budget: typeof running[number]): string =>
      categories.find(c => c.id === budget.categoryId)?.name ?? budget.categoryName;
    return [...groups.entries()]
      .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : compareText(a, b)))
      .map(([name, rows]) => ({
        title: name || 'Other budgets',
        budgets: rows
          .map(budget => ({ id: budget.id, label: leafOf(budget), spent: budget.spent, amount: budget.amount }))
          .sort((a, b) => compareText(a.label, b.label)),
      }));
  }, [metrics.budgetStatus, categories]);

  const toggleBudgetSelection = (budgetId: string): void => {
    const current = selectedBudgetIds ?? displayedBudgets.map(b => b.id);
    persistBudgetSelection(
      current.includes(budgetId) ? current.filter(id => id !== budgetId) : [...current, budgetId]
    );
  };
  const selectAllBudgets = useCallback(
    () => persistBudgetSelection(budgetSections.flatMap(section => section.budgets.map(b => b.id))),
    [budgetSections, persistBudgetSelection]
  );
  const clearAllBudgets = useCallback(() => persistBudgetSelection([]), [persistBudgetSelection]);

  const openBudgetDrill = useCallback((status: BudgetStatusRow): void => {
    const rows = expandSplitTransactions(transactions, transactionSplits)
      .filter(row => status.countedRowIds.has(row.id));
    setBudgetDrill({
      title: `${status.categoryName} — ${describeBudgetWindow(status.measuredOver)}`,
      bucket: 'expense',
      rows,
      total: status.spent,
    });
  }, [transactions, transactionSplits]);

  // Performance figures for the SELECTED period. Income/expenses come from
  // CATEGORY SEMANTICS (utils/incomeExpense): a refund filed under an expense
  // category is an expense credit that reduces spending — direction of
  // movement never decides the bucket. The cards and the breakdown modal read
  // these same totals, so both always describe one and the same window.
  const performance = useMemo(() => {
    const { from, to } = performancePeriod.range;
    // The flows seam (ruling C): the same per-date resolver the reports use,
    // so this card and the report it opens cannot sum on different bases.
    const flows = computeIncomeExpense(transactions, transactionSplits, categories, {
      from: from ?? undefined,
      to: to ?? undefined,
      convert: flowConvert,
    });
    return {
      income: flows.income.toNumber(),
      expenses: flows.expenses.toNumber(),
      incomeRows: flows.incomeRows,
      expenseRows: flows.expenseRows,
      holdsForeign: flows.holdsForeign,
    };
  }, [transactions, transactionSplits, categories, performancePeriod.range, flowConvert]);

  // Generate net worth data for chart - ONLY REAL DATA
  const netWorthData = useMemo(() => {
    // Only show current month's actual data
    // In the future, this will pull from historical snapshots
    const currentDate = new Date();
    // A chart axis is a date too, so the month follows the chosen region
    // rather than a literal 'en-US' nobody picked.
    const currentMonth = currentDate.toLocaleDateString(getDateLocale(), { month: 'short', year: 'numeric' });
    
    // For now, we only have current data
    // As the user uses the app over time, we'll build up historical data
    return [{
      month: currentMonth,
      netWorth: metrics.netWorth
    }];
  }, [metrics.netWorth]);
  
  const getAccountBalance = useCallback((acc: typeof accounts[0]) => accountBalanceMap.get(acc.id) ?? 0, [accountBalanceMap]);

  // Bank-feed facts for the attention card, read from the connections the app
  // has ALREADY loaded (Layout's auto-sync hook owns the fetching). A signed-out
  // or demo session has none, so no feed row can appear there.
  const bankConnections = useBankConnectionSnapshot();
  const bankLinks = useMemo(() => buildAccountBankLinks(bankConnections), [bankConnections]);
  const autoSyncMode = useMemo(
    () => (identityKey ? loadAutoSyncPrefs(identityKey).mode : 'off'),
    [identityKey]
  );

  // Every warning the card shows, each one a sentence saying why. `now` is
  // captured with the rest of the inputs: the staleness verdict changes when
  // the connections do, not on every render.
  const attentionItems = useMemo(
    () => buildAttentionItems({
      accounts,
      balanceOf: (id) => accountBalanceMap.get(id) ?? 0,
      linkOf: (id) => bankLinks.get(id),
      autoSyncMode,
      formatMoney: formatCurrencyWithSymbol,
      now: new Date(),
    }),
    [accounts, accountBalanceMap, bankLinks, autoSyncMode, formatCurrencyWithSymbol]
  );

  // Account distribution — the SAME ranking the full report draws (see
  // utils/accountDistribution). The card shows the slices a donut can carry;
  // the report behind it lists every account.
  const distribution = useMemo(
    // Converted through the same per-account factors the trio and the
    // breakdown modal use (balance reports' conversion, 23 Aug), so a share
    // of "together, your net worth" is a share of ONE currency.
    () => buildAccountDistribution(accounts, id => {
      const native = accountBalanceMap.get(id) ?? 0;
      const factor = rowConversion?.factors.get(id);
      return factor ? toDecimal(native).times(factor).toNumber() : native;
    }),
    [accounts, accountBalanceMap, rowConversion]
  );
  const pieData = distribution.slices;

  // The shared ramp, not a fourth copy of the recharts demo palette that used
  // to live here (and, byte for byte, in two other files).
  const chartRamp = useCategoricalRamp();
  // No tooltip styles declared here any more: the DashboardCharts wrappers
  // default to the house style, which WATCHES the dark class. The block this
  // replaces read it once at render — a chart mounted before dusk kept its
  // light tooltip all evening (the exact read-once trap chartColors warns
  // about, living on this page).

  const persistSelection = useCallback((ids: string[]) => {
    preferences.setItem('dashboardKeyAccounts', JSON.stringify(ids));
    setSelectedAccountIds(ids);
  }, []);

  const toggleAccountSelection = (accountId: string) => {
    setSelectedAccountIds(prev => {
      const newSelection = prev.includes(accountId)
        ? prev.filter(id => id !== accountId)
        : [...prev, accountId];

      preferences.setItem('dashboardKeyAccounts', JSON.stringify(newSelection));
      return newSelection;
    });
  };

  /**
   * THE STORED ORDER IS THE DISPLAY ORDER (owner, 17 Aug: "move it within
   * that box … like moving an app around on an iPhone screen"). This used to
   * filter the ACCOUNTS array, so the tiles sat in load order whatever the
   * user chose — the id list the picker already persists simply becomes the
   * seating plan.
   */
  /**
   * ─ DRAGGING A TILE TO A NEW SEAT ──────────────────────────────────────────
   * Pointer events, one set for mouse, pen and touch. A press is not a drag
   * until it has moved 8px — the tile is also a button that opens the
   * account, and the moved flag is what keeps one gesture from being both.
   *
   * THE SEMANTICS ARE A SWAP, PREVIEWED, COMMITTED ON RELEASE (owner,
   * 18 Aug). The first cut re-seated the stored order live as the pointer
   * crossed each tile, so a drag from top-right to bottom-left displaced
   * every tile it crossed — "it is too easy to move the wrong one". Now:
   * the tile under the pointer previews sliding into the dragged tile's
   * ORIGINAL seat — computed fresh from the pre-drag order on every move,
   * never cumulatively, so a tile merely crossed springs back the moment
   * the pointer moves on — and NOTHING is stored until the button is
   * released. Escape-by-pointercancel reverts to where things were.
   *
   * THE PREVIEW HAS HYSTERESIS (owner, 18 Aug, on the first cut of the swap:
   * "the highlight quickly jumps back and forth between the moved from and
   * the moved to"). The flap was geometric: previewing a swap moves the
   * DRAGGED tile into the seat under the pointer, so the next move finds the
   * dragged tile there, cleared the preview, found the target again, swapped
   * again — every frame. So a preview now only CHANGES when the pointer
   * reaches a genuinely new tile. The dragged tile under the pointer is the
   * swap holding steady; a grid gap keeps the last preview; and the partner
   * tile under the pointer means the pointer is back at the ORIGIN seat —
   * the swap moved the partner there — which is a drag home, and reverts.
   *
   * ON A PHONE, PRESS AND HOLD LIFTS THE TILE (owner, 18 Aug: "if we hold
   * down for a few seconds, like on an iphone app on the iphone screen, can
   * it then 'loosen itself' to be swapped before leaving go of the screen?").
   * Exactly that: `touch-action: pan-y` leaves the page scrollable from a
   * tile, so a touch drag has no way to BE a drag — the browser claims any
   * movement as a scroll and cancels the pointer. A hold that stays within
   * the slop for {@link TOUCH_LIFT_MS} lifts the tile instead: from that
   * moment a non-passive touchmove listener refuses the scroll claim, the
   * finger owns the tile, and the same swap-preview-commit flow runs. Before
   * the lift, movement cancels the hold and the page scrolls as normal.
   * Alt+arrows cover the keyboard.
   */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
  const dragRef = React.useRef<{
    id: string; startX: number; startY: number; moved: boolean;
    /** The seating plan as the drag began — every preview derives from THIS. */
    baseOrder: string[];
    /** The tile currently previewing into the dragged tile's seat. */
    hoverId: string | null;
    /** Touch only: the press-and-hold timer, until it fires or moves away. */
    holdTimer: ReturnType<typeof setTimeout> | null;
    /** Touch only: the hold completed — the tile is loosened and draggable. */
    lifted: boolean;
    pointerType: string;
  } | null>(null);
  /**
   * The scroll refusal, held so it can be removed from wherever the gesture
   * ends. Non-passive deliberately: preventDefault on touchmove is the one
   * thing that stops a browser mid-gesture from claiming the pan, and a
   * passive listener is not allowed to say it.
   */
  const touchBlockRef = React.useRef<((ev: TouchEvent) => void) | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState('');

  const displayedAccounts = useMemo(() => {
    const byId = new Map(accounts.map(a => [a.id, a]));
    return (previewOrder ?? selectedAccountIds)
      .map(id => byId.get(id))
      .filter((a): a is typeof accounts[number] => a !== undefined);
  }, [accounts, selectedAccountIds, previewOrder]);

  const announceSeat = useCallback((accountId: string, order: string[]): void => {
    const name = accounts.find(a => a.id === accountId)?.name ?? 'Account';
    setReorderAnnouncement(`${name} moved to position ${order.indexOf(accountId) + 1} of ${order.length}`);
  }, [accounts]);

  /** How long a touch must hold still before the tile loosens. */
  const TOUCH_LIFT_MS = 450;

  /** Undo the lift's scroll refusal and hold timer, from any ending. */
  const releaseTouchHold = (): void => {
    const drag = dragRef.current;
    if (drag?.holdTimer !== null && drag?.holdTimer !== undefined) {
      clearTimeout(drag.holdTimer);
      drag.holdTimer = null;
    }
    if (touchBlockRef.current) {
      window.removeEventListener('touchmove', touchBlockRef.current);
      touchBlockRef.current = null;
    }
  };

  const handleTilePointerDown = (e: React.PointerEvent, accountId: string): void => {
    if (e.button !== 0) return;
    const drag = {
      id: accountId, startX: e.clientX, startY: e.clientY, moved: false,
      baseOrder: selectedAccountIds, hoverId: null,
      holdTimer: null as ReturnType<typeof setTimeout> | null,
      lifted: false,
      pointerType: e.pointerType,
    };
    dragRef.current = drag;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch') {
      // The hold. It only fires if the finger stayed within the slop — a
      // finger that moved is scrolling, and the move handler cancels this.
      drag.holdTimer = setTimeout(() => {
        if (dragRef.current !== drag) return;
        drag.holdTimer = null;
        drag.lifted = true;
        drag.moved = true;
        setDraggingId(drag.id);
        // From here the finger owns the tile: refuse the browser's claim on
        // the pan. Possible at all because nothing has moved yet — a pan
        // already underway could not be refused.
        const block = (ev: TouchEvent): void => ev.preventDefault();
        touchBlockRef.current = block;
        window.addEventListener('touchmove', block, { passive: false });
      }, TOUCH_LIFT_MS);
    }
  };

  const handleTilePointerMove = (e: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.pointerType === 'touch' && !drag.lifted) {
      // Not loosened yet: a finger that moves is scrolling, not dragging.
      // Cancel the hold and let the browser have the gesture.
      if (drag.holdTimer !== null &&
          Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) >= 8) {
        clearTimeout(drag.holdTimer);
        drag.holdTimer = null;
      }
      return;
    }
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 8) return;
      drag.moved = true;
      setDraggingId(drag.id);
    }
    // The captured element receives every move, so the tile under the pointer
    // is found by position rather than by event target.
    const over = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest<HTMLElement>('[data-account-tile-id]');
    const targetId = over?.dataset.accountTileId ?? null;
    // The anti-judder rule lives in utils/reorderList (previewStep), pure and
    // pinned there — this handler only carries out its answer.
    const step = previewStep(targetId, drag.id, drag.hoverId);
    if (step.kind === 'keep') return;
    if (step.kind === 'revert') {
      drag.hoverId = null;
      setPreviewOrder(null);
      return;
    }
    drag.hoverId = step.targetId;
    // Always from the base order — never cumulative.
    setPreviewOrder(swapPositions(drag.baseOrder, drag.id, step.targetId));
  };

  const endTileDrag = (): void => {
    releaseTouchHold();
    const drag = dragRef.current;
    if (drag?.moved && drag.hoverId && drag.hoverId !== drag.id) {
      // THE COMMIT — the one moment the stored order changes.
      const final = swapPositions(drag.baseOrder, drag.id, drag.hoverId);
      persistSelection(final);
      announceSeat(drag.id, final);
    }
    setPreviewOrder(null);
    setDraggingId(null);
    // The moved flag must outlive pointerup by one tick: the click event the
    // browser fires AFTER a drag's release is the one to swallow.
    setTimeout(() => { dragRef.current = null; }, 0);
  };

  /** A cancelled drag (pointercancel — a scroll won the touch) commits nothing. */
  const cancelTileDrag = (): void => {
    releaseTouchHold();
    setPreviewOrder(null);
    setDraggingId(null);
    setTimeout(() => { dragRef.current = null; }, 0);
  };

  // A component that unmounts mid-lift must not leave the page unscrollable.
  useEffect(() => () => {
    if (touchBlockRef.current) {
      window.removeEventListener('touchmove', touchBlockRef.current);
      touchBlockRef.current = null;
    }
  }, []);

  /** Alt+arrows re-seat from the keyboard; plain keys keep their meanings. */
  const handleTileKeyDown = (e: React.KeyboardEvent, accountId: string): void => {
    if (!e.altKey) return;
    const steps =
      e.key === 'ArrowLeft' ? -1 :
      e.key === 'ArrowRight' ? 1 :
      e.key === 'ArrowUp' ? -2 :
      e.key === 'ArrowDown' ? 2 : 0;
    if (steps === 0) return;
    e.preventDefault();
    const next = moveBySteps(selectedAccountIds, accountId, steps);
    persistSelection(next);
    announceSeat(accountId, next);
  };

  /**
   * "None yet" and "none arrived yet" are different sentences, and the panel
   * below was only able to say the first (DESIGN_PASS §4).
   *
   * A first-run empty state is a welcome; the same words during a cold boot are
   * a false report that the user's accounts are gone. So while the load is
   * running the panel shows the shape of the cards instead — and shows nothing
   * at all until 200ms have passed, because a placeholder that flashes makes a
   * fast dashboard look like a slow one (useDelayedFlag).
   */
  const accountsStillArriving = isLoading && accounts.length === 0;
  const showAccountSkeleton = useDelayedFlag(accountsStillArriving);

  // The "which accounts to show here" picker, banded and alphabetised the way
  // every account list in the app is. It is not a <select>, so it cannot take
  // optgroups — it takes the same grouping in its own idiom instead, because
  // a sixty-account grid in load order is the same wall of names a flat
  // dropdown is.
  const accountSections = useMemo(() => groupAccountsBySection(accounts), [accounts]);

  // "All" means every account the panel below LISTS — taken from the sections
  // themselves rather than the accounts array, so the two can never disagree
  // about what the user just asked for.
  const selectAllAccounts = useCallback(
    () => persistSelection(accountSections.flatMap(section => section.accounts.map(a => a.id))),
    [accountSections, persistSelection]
  );
  const clearAllAccounts = useCallback(() => persistSelection([]), [persistSelection]);

  // Which pinned reports belong to which column: what you are worth on the
  // left, what moved on the right. A layout split, not a period one — both
  // columns read over the page's period.
  const assetsReports = pinnedReports.filter(id => id === 'net-worth');
  const flowsReports = pinnedReports.filter(
    id => id === 'income-expense-trend' || id === 'expense-categories'
  );
  const customPinnedReports = pinnedReports.filter(id => id.startsWith('custom:'));
  // A column with nothing in it is not drawn — an empty half of a two-column
  // grid is a hole, not a layout. Account Distribution is ALWAYS one of its
  // contents now (see the card itself), so this no longer turns on whether
  // there is data to draw.
  const showAssetsColumn = true;
  const showFlowsColumn = flowsReports.length > 0;

  return (
    <div className="space-y-4 max-w-[1400px] mx-auto">
      {/* The one control that says what window this page is being read over.
          Directly under the page heading, so its position states its scope. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PeriodBar picker={period} label="Period for this dashboard" />
        <WholePoundsToggle />
      </div>

      {/* Net worth and the two figures it is made of — one card, three
          columns. The navy slab this replaces put a second heavy horizontal
          under the nav bar and needed a whole white-on-navy text system to
          itself; the figure was already the largest thing on the page without
          it. See components/NetWorthSummary. */}
      <section
        data-testid="dashboard-grid"
        aria-label="Net worth, assets and liabilities"
      >
        {/* The ≈ on the trio itself (Design, 24 Aug §3): the Accounts page
            marks the identical figure on the identical basis, and the note
            under this card already says it converted. provenance is null
            exactly when nothing converted — the same gate. */}
        <NetWorthSummary
          netWorth={`${spansCurrencies && convertedNetWorth.provenance ? '≈ ' : ''}${formatCurrencyWithSymbol(spansCurrencies ? convertedNetWorth.netWorth : metrics.netWorth)}`}
          assets={`${spansCurrencies && convertedNetWorth.provenance ? '≈ ' : ''}${formatCurrencyWithSymbol(spansCurrencies ? convertedNetWorth.assets : metrics.totalAssets)}`}
          liabilities={`${spansCurrencies && convertedNetWorth.provenance ? '≈ ' : ''}${formatCurrencyWithSymbol(spansCurrencies ? convertedNetWorth.liabilities : metrics.totalLiabilities)}`}
          onSelect={figure => setBreakdownView(figure)}
          provenance={spansCurrencies ? convertedNetWorth.provenance : null}
          unconverted={spansCurrencies ? convertedNetWorth.unconverted : []}
          displayCurrency={displayCurrency}
        />

        {/* The walk from nothing to a working ledger — derives its own ticks
            and stands down by itself; see the component header. Superseded
            while the guide below is up: same journey, further along, said
            once (see the gate above). */}
        {!historyPathVisible && <FirstSteps />}
      </section>

      {/* THE ORDER THAT TURNS A YEAR OF IMPORTED ROWS INTO AN AFTERNOON.
          Second on the page, under the headline figures and above everything
          that is read over a period: for the user it appears to — several
          thousand unfiled rows — it IS the point of the dashboard, and a guide
          to the next fortnight of their evenings does not belong under three
          charts. It is not inside the net-worth landmark above, because a
          section named "Net worth, assets and liabilities" is not where a
          seven-step guide lives; it carries its own heading and its own name.
          Everything about when it appears, when it stands down and where its
          state lives is argued in the component. */}
      <HistoryPathCard />

      {/* WHAT CAME IN AND WHAT WENT OUT, over the chosen period.
          Called "Performance" until 2026-08-13, which measured nothing:
          performance is a return against something — a benchmark, a target, a
          previous period — and this card holds two totals and compares them to
          nothing at all. "Money in, money out" is what the two figures are, and
          it cannot be misread as the Income vs Expenses chart it can now be
          locked to, which "Income and expenses" would have been.

          Reads over the page's period like everything else below the bar, until
          it is pinned or locked — and then it says "pinned · …" or "locked · …"
          instead of the bare window name, because the same words in the same
          place would no longer be saying the same thing. */}
      <section
        aria-labelledby="performance-heading"
        className="group/card bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6"
      >
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <h3 id="performance-heading" className="text-lg font-semibold text-gray-900 dark:text-white">
            {INCOME_AND_EXPENSES_TITLE}
          </h3>
          {!performanceCard.pin.isPinned && (
            <span className="text-body text-gray-500 dark:text-gray-400">
              {PERIOD_LABELS[performancePeriod.period]}
            </span>
          )}
          <CardPeriodControl
            cardLabel={INCOME_AND_EXPENSES_TITLE}
            picker={performancePeriod}
            pin={performanceCard.pin}
          />
        </div>

        {/* The Phase 0 disclosure now mounts ONLY while the flows seam is
            degraded (no rate history yet): the figures below convert through
            the same per-date resolver the reports use, and this note
            survived that conversion commit — a converted card telling the
            reader it was unconverted, 200px under a header claiming the
            opposite (Design, 24 Aug §2). Converted figures wear ≈ instead. */}
        {flowConvert === undefined && <MixedCurrencyDisclosure className="mb-3" />}
        {/* ─ NO TINTED GROUND (Claude Design §2, and §2.5 before it) ────────
            These were `bg-green-50` and `bg-red-50` side by side. The figures
            are already green and red; the tint said the same thing a second
            time, in the one place P2 reserves for meaning. The card surface
            and a hairline between them do the separating now.

            ─ THE ARROWS: A DIRECTION, NOT A TREND ───────────────────────────
            Design's §1 asked for these to go on an empty ledger, on the
            grounds that they render from a default rather than from a
            computed change and so claim a trend that does not exist.

            Half applied, deliberately. The owner asked for these two
            explicitly — "keep the up arrow and down arrow in the income and
            expenses boxes" — when the decorative glyphs came off this page,
            and he is right that they are not decoration: up is money coming
            IN and down is money going OUT, which is a direction, and the
            app's own rule permits the hues on directions.

            What Design is right about is the ZERO. £0.00 has no direction to
            point in, so on a fresh ledger the arrow was the only thing on the
            card making a claim. It is hidden at zero and shown otherwise —
            which is the same rule this app already applies to colour on a
            zero, now applied to the arrow beside it.

            NOT made into a change-vs-previous-period indicator, which is what
            §1 literally asks for. That is a different feature (it needs a
            prior period, and a number for the change) and it would silently
            re-point an arrow the owner asked to keep. Raised in the handover
            rather than assumed. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-0 sm:divide-x sm:divide-gray-200 sm:dark:divide-gray-700">
          {/* THE ARROW SITS WITH ITS FIGURE (Design, 17 Aug §2.5). It is a
              modifier on the amount — `justify-between` was parking it at the
              card's far edge, six hundred pixels from the number it modifies,
              with half a card of nothing connecting them. After the amount,
              same baseline. */}
          {/* `flex-col` is LOAD-BEARING, not layout tidiness: index.css sets
              `button { display: inline-flex }` globally, and a grid child
              blockifies that to flex — ROW direction — so without it the
              label and the figure sit side by side and the whole card reads
              shrunken (the owner caught it within a day; the fifth casualty
              of that global rule). */}
          <button
            type="button"
            onClick={() => setBreakdownType('income')}
            className="flex flex-col items-start p-4 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors cursor-pointer text-left"
          >
            <p className="text-sm text-gray-600 dark:text-gray-400">Income</p>
            {/* NEUTRAL AT ZERO (Design §4), on the reasoning that settled
                the arrow beside it: at zero there is no direction, so the
                direction signal must not render. A green £0.00 beside a
                red £0.00 says "money came in" and "money went out" on a
                ledger where neither happened — in the two hues the app
                reserves for exactly that claim. Same condition as the arrow,
                deliberately. */}
            {/* text-2xl: the owner asked twice for these two figures to read
                bigger (19 Aug: "I still think they are a little small"). */}
            <p className={`flex items-center gap-2 text-2xl font-bold ${
              performance.income === 0
                ? 'text-gray-900 dark:text-white'
                : 'text-green-600 dark:text-green-400'
            }`}>
              {performance.holdsForeign ? '≈ ' : ''}{formatCurrencyWithSymbol(performance.income)}
              {/* Through the SHARED zero rule now. This pair got "no direction
                  at zero" right first (16 Aug) — and then Budget's cards were
                  found re-deriving it wrong, the fourth copy in one pass. The
                  rule lives in TrendArrow; this is the reference call site. */}
              <TrendArrow value={performance.income} direction="up" size={20} />
            </p>
          </button>

          <button
            type="button"
            onClick={() => setBreakdownType('expense')}
            className="flex flex-col items-start p-4 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors cursor-pointer text-left"
          >
            <p className="text-sm text-gray-600 dark:text-gray-400">Expenses</p>
            <p className={`flex items-center gap-2 text-2xl font-bold ${
              performance.expenses === 0
                ? 'text-gray-900 dark:text-white'
                : 'text-red-600 dark:text-red-400'
            }`}>
              {performance.holdsForeign ? '≈ ' : ''}{formatCurrencyWithSymbol(performance.expenses)}
              <TrendArrow value={performance.expenses} direction="down" size={20} />
            </p>
          </button>
        </div>
      </section>

      {/* Pinned reports: the user's choice of live reports, at a glance.
          Same shared maths as the full Reports hub — the glance and the full
          view can never disagree.

          NOT A CARD. "Your Reports" is a section heading, and the report cards
          below are cards — wrapping them in one more card put two borders and
          two shadows around every chart (P7, §3.4). It stays a <section> with
          an accessible name, which is what makes it a landmark; only the box
          around it is gone.

          Both columns read over the page's period now. They used to carry a
          picker each, feet apart and identical in style to the one on
          Performance above them. */}
      <section aria-labelledby="pinned-reports-heading">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 id="pinned-reports-heading" className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            Your Reports
          </h3>
          <button
            type="button"
            onClick={() => setShowReportPicker(true)}
            className="p-2 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title="Choose which reports appear here"
            aria-label="Choose reports"
          >
            <SettingsIcon size={18} />
          </button>
        </div>

        {/* One column on a phone (they stack in this order), two from lg —
            and only two when there is something in both. */}
        <div className={`grid grid-cols-1 gap-6 ${showAssetsColumn && showFlowsColumn ? 'lg:grid-cols-2' : ''}`}>
          {showAssetsColumn && (
            <div className="space-y-4">
              {assetsReports.map(id => (
                <NetWorthWidget key={id} picker={netWorthCard.picker} pin={netWorthCard.pin} />
              ))}

              {/* Account distribution: a snapshot of TODAY, sitting under a
                  period control it deliberately ignores — so it says so.
                  There is no "distribution last March" to show: the balances
                  are what the accounts hold now.

                  The title opens the full report (every account, not five);
                  each legend row still opens ITS account's transactions.

                  No period travels with that click, deliberately: the report
                  states none of its own, and sending one would move the window
                  the NEXT report opens on from a control the destination does
                  not even show. The way back travels — see useReportDrill. */}
              {/* ALWAYS RENDERED, empty or not. It used to disappear when
                  there were no balances to draw, which on a fresh ledger left
                  the left column blank beside two cards on the right — the
                  owner read that as a chart that had failed, not as one with
                  nothing to say. His ruling: "It should still be shown, but
                  just with zero data, like the others."

                  What is shown when empty is a SENTENCE, not an empty ring.
                  Claude Design's §3 asks for exactly that and gives the reason:
                  an axis (or a ring) with nothing on it asserts there is
                  something to plot and reads as a failed load. The two rulings
                  agree once separated — the owner is asking for the CARD to be
                  present, Design is asking for the FRAME not to be. */}
              {(
                <DashboardWidgetCard
                  title="Account Distribution"
                  subtitle={
                    <>
                      <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {/* THE LEGEND SUMS TO NET WORTH (owner, 17 Aug). The
                            in-credit fold's legend totalled far more than net
                            worth — gross investments and loans-out counted,
                            liabilities ignored — "otherwise it looks like a
                            useless report". The remainder now nets EVERY other
                            account, and the words say what the shape claims.
                            When that net remainder is below zero the ring
                            cannot draw it (a pie has no negative wedge), so
                            the subtitle says where the rest went instead. */}
                        {pieData.length === 0
                          ? 'Your largest accounts by balance'
                          : distribution.foldedCount > 0
                            ? (pieData[pieData.length - 1].value >= 0
                              ? `Your top ${pieData.length - 1} accounts and the other ${distribution.foldedCount}, net — together, your net worth`
                              : `Your top ${pieData.length - 1} accounts — the other ${distribution.foldedCount} net below zero`)
                            : `Your top ${pieData.length} account${pieData.length === 1 ? '' : 's'} by balance`}
                      </span>
                      <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto whitespace-nowrap">
                        Current balances
                      </span>
                    </>
                  }
                  onOpen={() => openReport('account-distribution')}
                >
                  {distribution.wedges.length === 0 ? (
                    /* THE SAME BOX THE CHART WOULD FILL, which is what makes
                       this card the same height as Expense Categories beside
                       it. Shipped first as a bare `py-8`, and the owner saw it
                       immediately: an empty card that shrinks is a card that
                       does not line up with its neighbour, and on a fresh
                       ledger every card is empty, so they ALL disagree. The
                       height is the shared `WIDGET_CHART_HEIGHT` rather than a
                       number, so the two can never drift apart again. */
                    <div className={`${WIDGET_CHART_HEIGHT} flex items-center justify-center`}>
                      <p className="text-center text-sm text-gray-400">
                        No account balances to compare yet
                      </p>
                    </div>
                  ) : (
                  <>
                  {/* A SQUARE for the ring, ALL remaining width for the names —
                      the same rule the Expense Categories card follows, so the
                      two donuts on this page sit at the same size and start at
                      the same x. The column used to be `sm:w-48 lg:w-56`, which
                      at lg was 224px around a 208px-tall ring: 16px the account
                      names could have had, spent on a margin nobody asked for.
                      Stacked below sm, where neither fits beside the other. */}
                  <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                    <div className={`${WIDGET_CHART_HEIGHT} sm:aspect-square sm:flex-shrink-0`}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart
                          // The ring draws `wedges` and the legend `slices` —
                          // one derivation apart (see accountDistribution): a
                          // below-zero remainder stays in the legend, in its
                          // accounting parentheses, and out of the ring.
                          data={distribution.wedges}
                          innerRadius={true}
                          colors={chartRamp}
                          // Straight into that account's register. It used to
                          // go to the global list filtered to the account,
                          // which is the same answer one page further away —
                          // and that page is retired. The remainder slice has
                          // no single register to open, so it opens the full
                          // report, where every folded account is a row.
                          onClick={(clickedData: AccountDistributionEntry) => {
                            if (clickedData.id === ACCOUNT_DISTRIBUTION_REMAINDER_ID) {
                              openReport('account-distribution');
                            } else {
                              navigate(preserveDemoParam(`/accounts/${clickedData.id}`, location.search));
                            }
                          }}
                          formatter={(value: number) => formatCurrencyWithSymbol(value, displayCurrency)}
                          aria-label="Pie chart showing distribution of account balances"
                        />
                      </ResponsiveContainer>
                    </div>
                    {/* Legend: which slice is which, with values and shares */}
                    <ul className="sm:flex-1 sm:min-w-0 space-y-2" aria-label="Account distribution legend">
                      {pieData.map((d, i) => (
                        <li key={d.id}>
                          <button
                            type="button"
                            // The remainder row has ninety registers behind it,
                            // not one — it opens the report that lists them all.
                            onClick={() => d.id === ACCOUNT_DISTRIBUTION_REMAINDER_ID
                              ? openReport('account-distribution')
                              : navigate(preserveDemoParam(`/accounts/${d.id}`, location.search))}
                            className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left"
                          >
                            {/* 16px swatch (Design §11): neighbouring ramp
                                slates read as one tone at 12px. */}
                            <span
                              className="w-4 h-4 rounded-sm flex-shrink-0"
                              style={{ backgroundColor: categoricalColor(chartRamp, i) }}
                              aria-hidden="true"
                            />
                            <span className="flex-1 min-w-0 truncate text-sm text-gray-700 dark:text-gray-300">{d.name}</span>
                            {/* A negative remainder wears the accounting
                                parentheses and the red every negative figure
                                wears — the legend states the netting the ring
                                cannot draw. */}
                            <span className={`text-sm font-medium tabular-nums whitespace-nowrap ${
                              d.value < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'
                            }`}>
                              {formatCurrencyWithSymbol(d.value, displayCurrency)}
                            </span>
                            <span className="w-12 text-right text-xs tabular-nums text-gray-400 dark:text-gray-500">
                              {d.share
                                ? d.share.lessThan(0)
                                  ? `(${formatDecimal(d.share.abs(), 1)}%)`
                                  : `${formatDecimal(d.share, 1)}%`
                                : ''}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                  </>
                  )}
                </DashboardWidgetCard>
              )}
            </div>
          )}

          {showFlowsColumn && (
            <div className="space-y-4">
              {flowsReports.map(id => (
                id === 'income-expense-trend'
                  ? <IncomeExpenseTrendWidget key={id} picker={trendCard.picker} pin={trendCard.pin} />
                  : <ExpenseCategoriesWidget key={id} picker={categoriesCard.picker} pin={categoriesCard.pin} />
              ))}
            </div>
          )}
        </div>

        {/* Custom reports answer their own question and take no period, so
            they sit below both columns rather than inside either. */}
        {customPinnedReports.length > 0 && (
          <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
            {customPinnedReports.map(id => (
              <CustomReportWidget key={id} reportId={id.slice('custom:'.length)} />
            ))}
          </div>
        )}

        {pinnedReports.length === 0 && (
          <button
            type="button"
            onClick={() => setShowReportPicker(true)}
            className={`w-full justify-center py-8 text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors ${pieData.length > 0 ? 'mt-2' : ''}`}
          >
            No reports pinned — click to choose the reports you want at a glance
          </button>
        )}
      </section>

      {/* Report picker */}
      <Modal
        isOpen={showReportPicker}
        onClose={() => setShowReportPicker(false)}
        title="Choose your dashboard reports"
        size="sm"
      >
        <ModalBody>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
            Pick the reports you want at a glance. They stay live and click through to the full report.
          </p>
          <div className="space-y-1">
            {BUILT_IN_REPORTS.map(({ id, label, icon: Icon }) => (
              <label key={id} className="flex items-center gap-3 py-2 px-2 -mx-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/40 cursor-pointer">
                <input
                  type="checkbox"
                  checked={pinnedReports.includes(id)}
                  onChange={() => togglePinnedReport(id)}
                  className="rounded border-gray-300"
                />
                <Icon size={16} className="text-gray-500" />
                <span className="text-sm text-gray-800 dark:text-gray-200">{label}</span>
              </label>
            ))}
            {customReports.map(report => (
              <label key={report.id} className="flex items-center gap-3 py-2 px-2 -mx-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/40 cursor-pointer">
                <input
                  type="checkbox"
                  checked={pinnedReports.includes(`custom:${report.id}`)}
                  onChange={() => togglePinnedReport(`custom:${report.id}`)}
                  className="rounded border-gray-300"
                />
                <span className="text-sm text-gray-800 dark:text-gray-200 truncate">{report.name}</span>
                <span className="ml-auto text-xs text-gray-400">custom</span>
              </label>
            ))}
          </div>
        </ModalBody>
      </Modal>

      {/* Income/Expense breakdown — the shared component (category sections,
          sortable headings, click-to-edit) also used by the Reports page. */}
      <IncomeExpenseBreakdownModal
        isOpen={breakdownType !== null}
        onClose={() => setBreakdownType(null)}
        title={`${breakdownType === 'income' ? 'Income' : 'Expenses'} — ${PERIOD_LABELS[performancePeriod.period]}`}
        bucket={breakdownType ?? 'income'}
        rows={breakdownType === 'income' ? performance.incomeRows : performance.expenseRows}
        total={breakdownType === 'income' ? performance.income : performance.expenses}
        categories={categories}
        onEditTransaction={setEditingBreakdownTxnId}
      />

      {/* Edit a transaction straight from the breakdown list */}
      {editingBreakdownTxnId && (
        <EditTransactionModal
          isOpen
          onClose={() => setEditingBreakdownTxnId(null)}
          transaction={transactions.find(t => t.id === editingBreakdownTxnId) ?? null}
        />
      )}

      {/* The rows behind a budget's figure. Mounted only while open: the modal
          reads context the Dashboard's own harness does not provide. */}
      {budgetDrill && (
        <ReportDrillModal target={budgetDrill} onClose={() => setBudgetDrill(null)} categories={categories} />
      )}

      {/* Key Budgets — the budgets the owner chose, each over its own period,
          click for the rows; the cog chooses them, as it does for the key
          accounts below (owner, 7 Nov 2026). */}
      {metrics.budgetStatus.length > 0 && (
        <section
          aria-labelledby="budget-status-heading"
          className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6"
          data-testid="budget-status"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 id="budget-status-heading" className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <PieChartIcon size={24} className="text-gray-500" />
              Key Budgets
              <span className="text-sm font-normal text-gray-500 dark:text-gray-400 whitespace-nowrap">
                ({displayedBudgets.length} of {metrics.budgetStatus.length}
                {displayedBudgets.length > 0 && ` · ${formatDecimal(displayedBudgetPercent, 0)}% used`})
              </span>
            </h3>
            <button
              onClick={() => setShowBudgetSettings(!showBudgetSettings)}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              aria-label="Customise displayed budgets"
              aria-expanded={showBudgetSettings}
            >
              <SettingsIcon size={20} className="text-gray-500" />
            </button>
          </div>

          {/* Budget Selection Panel — the key accounts' panel, for budgets.
              Only budgets running today are listed, because only those are
              on the card: a finished or future one has nothing to show. */}
          {showBudgetSettings && (
            <div className="mb-4 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Select budgets to show on the dashboard:
                </p>
                <button
                  onClick={() => setShowBudgetSettings(false)}
                  className="p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
                  aria-label="Close budget settings"
                >
                  <XIcon size={16} className="text-gray-500" />
                </button>
              </div>
              {/* Offered only when some budget HAS months to be read by: with
                  none longer than a month the choice would change nothing. */}
              {metrics.budgetStatus.some(b => b.hasMonths) && (
                <div className="mb-3">
                  <BudgetViewChoice id="dashboard-budget-view" view={budgetView} onChange={setBudgetView} />
                </div>
              )}
              <div className="flex flex-wrap gap-2 mb-3">
                <button
                  type="button"
                  onClick={selectAllBudgets}
                  className="px-4 py-2 min-h-[44px] sm:min-h-0 sm:py-1.5 text-sm font-medium rounded-lg bg-primary-action text-on-primary-action hover:bg-primary-action-hover transition-colors"
                >
                  Select all budgets
                </button>
                <button
                  type="button"
                  onClick={clearAllBudgets}
                  className="px-4 py-2 min-h-[44px] sm:min-h-0 sm:py-1.5 text-sm font-medium rounded-lg bg-primary-action text-on-primary-action hover:bg-primary-action-hover transition-colors"
                >
                  Clear all budgets
                </button>
              </div>
              <div className="space-y-3">
                {budgetSections.map(section => (
                  <div key={section.title}>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      {section.title}
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                      {section.budgets.map(budget => {
                        const isSelected = displayedBudgets.some(b => b.id === budget.id);
                        return (
                          <button
                            key={budget.id}
                            type="button"
                            onClick={() => toggleBudgetSelection(budget.id)}
                            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                              isSelected
                                ? 'bg-primary/10 dark:bg-gray-600 border border-primary'
                                : 'bg-white dark:bg-gray-600 border border-gray-200 dark:border-gray-500 hover:bg-gray-50 dark:hover:bg-gray-550'
                            }`}
                            aria-pressed={isSelected ? 'true' : 'false'}
                          >
                            <div className={`w-4 h-4 rounded flex items-center justify-center shrink-0 ${
                              isSelected
                                ? 'bg-[#1a2332] text-white'
                                : 'border border-gray-300 dark:border-gray-400'
                            }`}>
                              {isSelected && <CheckIcon size={12} />}
                            </div>
                            <span className="text-sm text-gray-700 dark:text-gray-300 truncate">
                              {budget.label}
                            </span>
                            <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto whitespace-nowrap">
                              {formatCurrencyWithSymbol(budget.spent)} / {formatCurrencyWithSymbol(budget.amount)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-3">
            {displayedBudgets.length === 0 && (
              /* A SELECTION IS A FILTER: the budgets exist, none is chosen
                 for this card — say how many are held back and offer the
                 one control that shows them (the accounts' rule, below). */
              <div role="status" aria-live="polite">
                <FilteredEmptyState
                  title="No budgets are selected for the dashboard"
                  hiddenCount={metrics.budgetStatus.length}
                  scope="of your budgets"
                  filters={['the dashboard’s budget selection']}
                  onClear={selectAllBudgets}
                  clearLabel="Show all budgets"
                />
              </div>
            )}
            {displayedBudgets.map(budget => (
              /* The whole row is the button: name, period, figures and bar
                 together are one claim, and the click asks for its evidence.
                 Spans inside, because a button holds phrasing content only. */
              <button
                key={budget.id}
                type="button"
                onClick={() => openBudgetDrill(budget)}
                className="block w-full text-left space-y-2 -mx-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                aria-label={`${budget.categoryName}: ${formatCurrencyWithSymbol(budget.spent)} of ${formatCurrencyWithSymbol(budget.amount)}, ${budget.spokenCaption}. Show the transactions`}
                title="Show the transactions behind this figure"
                data-testid="budget-status-row"
              >
                <span className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-gray-700 dark:text-gray-300">
                      {budget.categoryName}
                    </span>
                    {/* The period, said in full: the budget's own kind of
                        period and the exact days it covers right now. */}
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {budget.caption}
                    </span>
                  </span>
                  <span className={`shrink-0 font-medium ${
                    budget.isOverBudget ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'
                  }`}>
                    {formatCurrencyWithSymbol(budget.spent)} / {formatCurrencyWithSymbol(budget.amount)}
                  </span>
                </span>
                <span
                  className="block w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden"
                  role="progressbar"
                  aria-valuenow={Math.min(budget.percentUsed, 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${budget.categoryName} budget: ${Math.min(budget.percentUsed, 100).toFixed(0)}% used`}
                >
                  <span
                    // The fourth rung is a progress fill, not a severity: at
                    // 60–80% used nothing is wrong yet. So it wears the app's
                    // meter colour (LoadTestDataModal, MsMoneyImportModal,
                    // ImportProgress) rather than a stock blue between the
                    // yellow and the green (ruling, 28 Aug 2026).
                    className={`block h-full transition-all duration-300 ${
                      budget.percentUsed > 100 ? 'bg-red-500' :
                      budget.percentUsed > 80 ? 'bg-yellow-500' :
                      budget.percentUsed > 60 ? 'bg-navy-400 dark:bg-primary-action' :
                      'bg-green-500'
                    }`}
                    style={{ width: `${Math.min(budget.percentUsed, 100)}%` }}
                  />
                </span>
              </button>
            ))}

            {/* Always offered (owner, 7 Nov 2026): the card is a chosen few,
                and the page with all of them is one press away whatever the
                choice. */}
            <button
              onClick={() => navigate(preserveDemoParam('/budget', location.search))}
              // It takes you to another screen, and in-app navigation has had
              // its own answer for months: the brand ink, which index.css
              // gives a dark counterpart (stock-blue ruling, 28 Aug 2026).
              // The hover ground carries the feedback and is a neutral.
              className="w-full justify-center mt-2 py-2 text-primary hover:text-secondary text-sm hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              View All Budgets ({metrics.budgetStatus.length}) →
            </button>
          </div>
        </section>
      )}

      {/* Account Balances Section - Customizable by user */}
      <section 
        aria-labelledby="key-accounts-heading"
        className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 id="key-accounts-heading" className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            Key Account Balances
            {displayedAccounts.length > 0 && (
              <span className="text-sm font-normal text-gray-500 dark:text-gray-400 whitespace-nowrap">
                ({displayedAccounts.length} of {accounts.length})
              </span>
            )}
          </h3>
          <button
            onClick={() => setShowAccountSettings(!showAccountSettings)}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            aria-label="Customise displayed accounts"
            aria-expanded={showAccountSettings}
          >
            <SettingsIcon size={20} className="text-gray-500" />
          </button>
        </div>
        
        {/* Account Selection Panel */}
        {showAccountSettings && (
          <div className="mb-4 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Select accounts to display on dashboard:
              </p>
              <button
                onClick={() => setShowAccountSettings(false)}
                className="p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
                aria-label="Close account settings"
              >
                <XIcon size={16} className="text-gray-500" />
              </button>
            </div>
            {/* Both ends of the choice in one click — sixty accounts is sixty
                clicks to start from nothing, or from everything. */}
            <div className="flex flex-wrap gap-2 mb-3">
              <button
                type="button"
                onClick={selectAllAccounts}
                className="px-4 py-2 min-h-[44px] sm:min-h-0 sm:py-1.5 text-sm font-medium rounded-lg bg-primary-action text-on-primary-action hover:bg-primary-action-hover transition-colors"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={clearAllAccounts}
                className="px-4 py-2 min-h-[44px] sm:min-h-0 sm:py-1.5 text-sm font-medium rounded-lg bg-primary-action text-on-primary-action hover:bg-primary-action-hover transition-colors"
              >
                Clear all
              </button>
            </div>
            <div className="space-y-3">
              {accountSections.map(section => (
                <div key={section.label}>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    {section.title}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                    {section.accounts.map(account => {
                      const isSelected = selectedAccountIds.includes(account.id);
                      return (
                        <button
                          key={account.id}
                          type="button"
                          onClick={() => toggleAccountSelection(account.id)}
                          className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                            isSelected
                              /* The selection's own token: navy at a tenth on
                                 light, and on dark the border index.css remaps
                                 to the house slate. The dark GROUND stays the
                                 tile's own gray-600 — this panel is gray-700
                                 and there is no lift left above the unselected
                                 tile — so the border and the navy tick beside
                                 it are what say "chosen" (ruling, 28 Aug 2026). */
                              ? 'bg-primary/10 dark:bg-gray-600 border border-primary'
                              : 'bg-white dark:bg-gray-600 border border-gray-200 dark:border-gray-500 hover:bg-gray-50 dark:hover:bg-gray-550'
                          }`}
                          aria-pressed={isSelected ? 'true' : 'false'}
                        >
                          <div className={`w-4 h-4 rounded flex items-center justify-center shrink-0 ${
                            isSelected
                              ? 'bg-[#1a2332] text-white'
                              : 'border border-gray-300 dark:border-gray-400'
                          }`}>
                            {isSelected && <CheckIcon size={12} />}
                          </div>
                          <span className="text-sm text-gray-700 dark:text-gray-300 truncate">
                            {account.name}
                          </span>
                          <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto whitespace-nowrap">
                            {formatCurrencyWithSymbol(getAccountBalance(account), account.currency)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              Tip: Select your most important accounts, then drag a card to
              put them in the order you want
            </div>
          </div>
        )}
        
        {/* Where a moved card landed, for anyone who cannot see it land. */}
        <div className="sr-only" aria-live="polite">{reorderAnnouncement}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {displayedAccounts.length > 0 ? (
            displayedAccounts.map(account => (
              <div
                key={account.id}
                className={`flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors cursor-pointer select-none ${
                  draggingId === account.id ? 'ring-2 ring-[#6b86b3] shadow-lg opacity-90' : ''
                }`}
                style={{ touchAction: 'pan-y' }}
                data-testid="account-balance-card"
                data-account-tile-id={account.id}
                // A drag's release fires a click; the moved flag swallows it so
                // one gesture is never both a reorder and a navigation.
                onClick={() => {
                  if (dragRef.current?.moved) return;
                  navigate(preserveDemoParam(`/accounts/${account.id}`, location.search));
                }}
                onPointerDown={(e) => handleTilePointerDown(e, account.id)}
                onPointerMove={handleTilePointerMove}
                onPointerUp={endTileDrag}
                onPointerCancel={cancelTileDrag}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  handleTileKeyDown(e, account.id);
                  if (e.defaultPrevented) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate(preserveDemoParam(`/accounts/${account.id}`, location.search));
                  }
                }}
                aria-label={`View ${account.name} account details. Balance: ${formatCurrencyWithSymbol(getAccountBalance(account), account.currency)}. Hold Alt and press an arrow key to move this card.`}
              >
                <div className="flex-1">
                  <p className="font-medium text-gray-900 dark:text-white">
                    {account.name}
                  </p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {account.institution || account.subtype}
                  </p>
                </div>
                <div className="text-right">
                  {/* NEUTRAL, not green (Claude Design's second look, §3).
                      A balance is a MAGNITUDE — how much is there, not which
                      way it went — so £0.00 rendered in income green said
                      money had come in on a ledger where nothing had.

                      This is §5 of yesterday applied to the panel that was not
                      in its blast radius; their instruction to check the
                      siblings is what found it, twice now. RED SURVIVES: an
                      account in the red is a fact worth marking, and it is the
                      one direction a balance genuinely has. */}
                  <p className={`text-lg font-bold ${
                    (getAccountBalance(account)) < 0
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-gray-900 dark:text-white'
                  }`}>
                    {formatCurrencyWithSymbol(getAccountBalance(account), account.currency)}
                  </p>
                  {account.creditLimit && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Limit: {formatCurrencyWithSymbol(account.creditLimit)}
                    </p>
                  )}
                </div>
              </div>
            ))
          ) : showAccountSkeleton ? (
            /* SHAPE, NOT SPINNER, at the real card geometry — and nothing at
               all for the first 200ms (DESIGN_PASS §4). Without this the
               dashboard asserted "No accounts added yet" at every cold boot,
               for as long as the accounts took to arrive. */
            <div className="col-span-2">
              <TableSkeleton columns={ACCOUNT_CARD_SKELETON_COLUMNS} rowHeight={ACCOUNT_CARD_HEIGHT} />
            </div>
          ) : accountsStillArriving ? null : accounts.length > 0 ? (
            /* A SELECTION IS A FILTER. The accounts exist, the user has simply
               picked none of them to show — so this names how many are being
               held back and offers the one control that shows them, rather
               than sending the user off to find a settings icon. */
            <div className="col-span-2" role="status" aria-live="polite">
              <FilteredEmptyState
                title="No accounts are selected for the dashboard"
                hiddenCount={accounts.length}
                scope="of your accounts"
                filters={['the dashboard’s account selection']}
                onClear={selectAllAccounts}
                // Not "Clear filters": the thing hiding these accounts is a
                // selection, and the remedy should name the control it is.
                clearLabel="Show all accounts"
              />
            </div>
          ) : (
            /* No accounts at all: the first run. Say what this panel will hold
               once there is one, and hand over the control that starts it. */
            <div className="col-span-2">
              <EmptyState
                title="No accounts yet"
                description="This is where each account's balance will sit, and it is what every total, chart and budget on this dashboard is worked out from — so until you add one, the dashboard has nothing to report."
                action={{
                  label: 'Add Account',
                  onClick: () => navigate(preserveDemoParam('/accounts?action=add', location.search))
                }}
              />
            </div>
          )}
        </div>
      </section>

      {/* Needs Your Attention.
          Held back until the transaction load has finished: until then an
          account's balance is its opening balance, so every alert-armed
          account flashes onto this list and off it again — a warning nobody
          asked for about money that was there all along. */}
      {!isLoading && attentionItems.length > 0 && (
        <section
          aria-labelledby="attention-heading"
          className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-xl p-6"
          // A standing list of warnings is a region, not an alert: role="alert"
          // is assertive by definition and interrupts whatever is being read,
          // every time the dashboard renders. aria-live="polite" keeps the
          // announcement — it just waits its turn.
          role="region"
          aria-live="polite"
        >
          <div className="flex items-center gap-3 mb-4">
            <AlertCircleIcon size={24} className="text-yellow-600 dark:text-yellow-400" aria-hidden="true" />
            <h3 id="attention-heading" className="text-lg font-semibold text-gray-900 dark:text-white">
              Needs Your Attention
            </h3>
          </div>

          <div className="space-y-3">
            {attentionItems.map(item => (
              // One real <button> per row rather than a div wearing
              // role="button": it is keyboard-reachable and Enter/Space work
              // because it IS a button, and nesting a second button inside it
              // for the action would be invalid markup for one destination.
              <button
                key={`${item.kind}:${item.account.id}`}
                type="button"
                data-testid="attention-row"
                className="w-full flex items-center justify-between gap-3 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg text-left hover:shadow-md transition-shadow"
                onClick={() => navigate(preserveDemoParam(item.href, location.search))}
                aria-label={`${item.account.name} needs attention: ${item.reason} ${item.actionLabel}`}
              >
                <span className="flex items-start gap-3 min-w-0">
                  <WalletIcon size={20} className="text-gray-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block font-medium text-gray-900 dark:text-white">
                      {item.account.name}
                    </span>
                    <span className="block text-sm text-gray-500 dark:text-gray-400">
                      {item.reason}
                    </span>
                  </span>
                </span>
                {/* The row navigates, and the label is where it says so: the
                    brand ink the app uses for in-app navigation, not the link
                    blue that belongs to a tab this app does not own
                    (stock-blue ruling, 28 Aug 2026). */}
                <span className="flex items-center gap-1 flex-shrink-0 text-sm font-medium text-primary">
                  <span className="hidden sm:inline">{item.actionLabel}</span>
                  <ChevronRightIcon size={20} className="text-gray-400" aria-hidden="true" />
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Net Worth Chart - only show when there's historical data */}
      {netWorthData.length > 1 && (
        <section
          aria-labelledby="net-worth-chart-heading"
          className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6"
        >
          <h3 id="net-worth-chart-heading" className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
            <BarChart3Icon size={24} className="text-gray-500" aria-hidden="true" />
            Net Worth Over Time
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Your wealth progression over time
          </p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={netWorthData}
                dataKey="netWorth"
                label="Net Worth"
                formatter={(value: number) => formatCurrencyWithSymbol(value, displayCurrency)}
                tickFormatter={(value: number) => {
                  if (value >= 1000000) return `${formatDecimal(value / 1000000, 1)}M`;
                  if (value >= 1000) return `${formatDecimal(value / 1000, 0)}K`;
                  return formatDecimal(value, 0);
                }}
                aria-label="Bar chart showing net worth over time"
              />
            </ResponsiveContainer>
          </div>
        </section>
      )}

      {/* No quick-action tiles here.
          Four 140px cards used to close the page — Add Transaction, View
          Accounts, Set Budget, Reports — and every one of them was a second
          door to a room already on screen: the sidebar names all three
          destinations permanently, and adding a transaction belongs in the
          register that will hold it. A dashboard's job is to SHOW, and the
          tiles pushed the figures up a screenful to repeat the navigation.
          The phone keeps its floating "+" (components/MobileBottomNav) — there
          the sidebar is behind a tap, so quick-add is the only door. */}

      {/* The SAME modal the Accounts page drills with, fed from the SAME
          balance map the three tiles sum — so its total and the tile cannot
          disagree, which is the whole precondition for offering the click.
          Each row's figure is in the account's OWN currency (a $100 row used
          to print as £100 here), and a foreign row carries its converted
          value so the modal's totals agree with the converted trio above. */}
      <AccountBreakdownModal
        view={breakdownView}
        onClose={() => setBreakdownView(null)}
        rows={accounts.map(a => {
          const balance = accountBalanceMap.get(a.id) ?? 0;
          const factor = rowConversion?.factors.get(a.id);
          return {
            id: a.id,
            name: a.name,
            institution: a.institution,
            accountType: a.type,
            balance,
            converted: factor ? toDecimal(balance).times(factor).toNumber() : undefined,
            formatted: formatCurrencyWithSymbol(balance, a.currency),
          };
        })}
        formatTotal={(v) => formatCurrencyWithSymbol(v)}
        onOpenAccount={(accountId) => {
          setBreakdownView(null);
          navigate(preserveDemoParam(`/accounts/${accountId}`, location.search));
        }}
      />
    </div>
  );
}
