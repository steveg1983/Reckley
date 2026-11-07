import { useState, useMemo, useEffect, useCallback, Suspense } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { preserveDemoParam } from '../utils/navigation';
import { OPEN_PARAM, OPEN_BUDGET_WIZARD } from '../utils/pageOpenLink';
import { useApp } from '../contexts/AppContextSupabase';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import { useNotifications } from '../contexts/NotificationContext';
import { useToast } from '../contexts/ToastContext';
import { ArrowRightIcon, BellIcon, ChevronDownIcon, ChevronRightIcon } from '../components/icons';
import TrendArrow from '../components/TrendArrow';
import { EditIcon, DeleteIcon } from '../components/icons';
import { IconButton } from '../components/icons/IconButton';
import BudgetModal from '../components/BudgetModal';
import BudgetRollover from '../components/BudgetRollover';
import SpendingAlerts from '../components/SpendingAlerts';
import type { Budget } from '../types';
import PageWrapper from '../components/PageWrapper';
import { lazyWithRecovery } from '../utils/lazyWithRecovery';
import { WholePoundsScope, WholePoundsToggle } from '../contexts/WholePoundsContext';
import PageTip from '../components/PageTip';
import EmptyState from '../components/EmptyState';
import { foreignCurrencyAccountIds } from '../utils/budgetSpending';
import { evaluateBudgets } from '../utils/budgetEvaluation';
import type { BudgetPeriodName } from '../utils/budgetPeriods';
import { budgetPace, describeBudgetWindow, paceDifference } from '../utils/budgetPace';
import { toDecimal } from '../utils/decimal';
import type { DecimalInstance } from '../utils/decimal';
import { formatDecimal } from '../utils/decimal-format';
import { SkeletonCard, SkeletonText } from '../components/loading/Skeleton';
import { compareText } from '../utils/localeFormat';

/**
 * The bulk setup flow, off the main chunk.
 *
 * It carries a whole grid, twelve months of aggregation and its own confirm
 * step, and most sessions on this page never open it — so it is fetched when
 * somebody asks for it, through the app's chunk-recovery loader (a stale
 * deploy's missing chunk retries rather than white-screening).
 */
const BudgetWizard = lazyWithRecovery(() => import('../components/BudgetWizard'));

export default function Budget() {
  // The whole-pounds scope must sit above every useCurrencyDecimal call,
  // including this page's own — hence the thin shell (owner, 19 Aug:
  // page-specific decimal display).
  return (
    <WholePoundsScope page="budget">
      <BudgetView />
    </WholePoundsScope>
  );
}

function BudgetView() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [isModalOpen, setIsModalOpen] = useState(false);
  /**
   * The evidence-first setup screen (owner's spec, 29 Aug), which since 1 Sep
   * 2026 has an ADDRESS: `/budget?open=wizard`, so a surface that recommends
   * setting budgets up can land on the thing rather than on a sentence about a
   * button. Read once here and only here — the parameter says how the page was
   * opened, not what it must keep doing, so closing the wizard closes it. Any
   * other value opens nothing (see utils/pageOpenLink).
   */
  const [isSetupOpen, setIsSetupOpen] = useState(
    () => searchParams.get(OPEN_PARAM) === OPEN_BUDGET_WIZARD
  );
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null);
  /**
   * §12 (owner, 23 Aug): ONE budgeting approach — the traditional page IS
   * Budget. Envelope and Zero-Based are retired; Templates, Rollover and
   * Alerts fold in as features below the budgets, each a collapsed section
   * that mounts only when opened. No tab strip: a first-time user is never
   * asked to choose between budgeting philosophies before they have a
   * single budget.
   */
  const [openFeatures, setOpenFeatures] = useState<Set<'rollover' | 'alerts'>>(new Set());
  const toggleFeature = (key: 'rollover' | 'alerts'): void =>
    setOpenFeatures(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const [isLoading, setIsLoading] = useState(true);
  const { formatCurrency, displayCurrency } = useCurrencyDecimal();
  const formatPercentage = (value: number | DecimalInstance, decimals: number = 0) => {
    return formatDecimal(value, decimals);
  };

  // Get data from context
  const { budgets, updateBudget, deleteBudget, transactions, transactionSplits, categories, accounts } = useApp();
  const { checkEnhancedBudgetAlerts, checkBudgetAlerts, alertThreshold } = useNotifications();
  const { showError } = useToast();

  // One evaluation instant for the whole page: every card, caption and total
  // describes the same "now".
  const evaluatedAt = useMemo(() => new Date(), []);

  // Rows on accounts held in another currency cannot join this total without a
  // rate; they are left out and the card says so.
  const foreignAccountIds = useMemo(
    () => foreignCurrencyAccountIds(accounts, displayCurrency),
    [accounts, displayCurrency]
  );

  // ONE evaluation per budget — window, group roll-up, legacy category
  // healing, rollover, netting — from utils/budgetEvaluation, which the
  // Dashboard's Budget Status card reads too, so the two can never show the
  // same budget as two different figures again. `remaining` is UNCLAMPED: an
  // overspent budget must read "over budget by £30.00" rather than "£0.00
  // remaining" while the page total says something else.
  const budgetsWithSpent = useMemo(() => {
    return evaluateBudgets(
      budgets.filter((budget): budget is Budget => budget !== null && budget !== undefined),
      { transactions, transactionSplits, categories, foreignAccountIds, now: evaluatedAt }
    ).map(({ budget, effectiveAmount, spent, percentage, remaining, window, excludedForeignCount }) => {
      // How far through its window the budget is, and spending against that
      // pace (owner, 5 Nov 2026): a year read on day five and on day 360 used
      // to show the same bar. See utils/budgetPace.
      const pace = budgetPace(window, evaluatedAt);
      return {
        ...budget,
        effectiveAmount,
        spent: spent.toNumber(),
        percentage,
        remaining: remaining.toNumber(),
        periodLabel: window.label,
        window,
        pace,
        paceDifference: paceDifference(effectiveAmount, spent, pace),
        excludedForeignCount
      };
    });
  }, [budgets, transactions, transactionSplits, categories, foreignAccountIds, evaluatedAt]);

  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    categories.forEach(category => {
      if (category?.id) {
        map.set(category.id, category.name);
      }
      if (category?.name) {
        map.set(category.name, category.name);
      }
    });
    return map;
  }, [categories]);

  /**
   * WHAT ORDER THE CARDS COME IN (owner, 29 Aug: "They just look like a
   * jumbled mess. Either they have to be alphabetically as a minimum, or the
   * option to sort by category group?").
   *
   * They were in creation order, which is the order the rows happened to be
   * written and no order at all to read — on a page of twenty cards it makes
   * finding one a scan of the whole grid.
   *
   * Grouped is the DEFAULT because it is how the rest of the app arranges
   * categories, and because a budget is a property of its category: Food
   * Related Costs' budgets sit together, the way they do in the tree and on
   * the setup screen. Within a group, and everywhere else, A–Z. The other
   * two orders answer questions the grid cannot otherwise: which am I
   * closest to blowing, and which is the biggest commitment.
   */
  const [budgetOrder, setBudgetOrder] = useState<'group' | 'az' | 'used' | 'largest'>('group');

  /** A leaf's group name, for ordering — '' for anything with no parent. */
  const groupNameOfCategory = useCallback((categoryId: string): string => {
    const category = categories.find(c => c.id === categoryId);
    if (!category?.parentId) return '';
    return categories.find(c => c.id === category.parentId)?.name ?? '';
  }, [categories]);

  type BudgetWithLegacyCategory = Budget & { category?: string };
  const getBudgetCategoryLabel = useCallback((budget: Budget) => {
    const legacyCategory = (budget as BudgetWithLegacyCategory).category;
    const categoryKey = budget.categoryId ?? legacyCategory ?? '';
    return categoryNameById.get(categoryKey) ?? budget.name ?? (categoryKey || 'Budget');
  }, [categoryNameById]);

  /**
   * The cards in the chosen order — see `budgetOrder`. Sorted on a COPY, so
   * the memo above stays the single computation of what each budget has
   * spent and this only ever rearranges it.
   */
  const orderedBudgets = useMemo(() => {
    const label = (b: Budget): string => getBudgetCategoryLabel(b).toLocaleLowerCase();
    const byName = (a: Budget, b: Budget): number => compareText(label(a), label(b));
    const rows = [...budgetsWithSpent];
    switch (budgetOrder) {
      case 'az':
        return rows.sort(byName);
      case 'used':
        // Most-spent first: the one about to overflow is the one to see.
        return rows.sort((a, b) => (b.percentage - a.percentage) || byName(a, b));
      case 'largest':
        return rows.sort((a, b) =>
          b.effectiveAmount.comparedTo(a.effectiveAmount) || byName(a, b));
      default: {
        // Group A–Z, then leaf A–Z inside it. A budget whose category has no
        // group sorts last rather than first: an unplaceable row belongs at
        // the end of a list, not at the head of it.
        const group = (b: Budget): string => {
          const legacy = (b as BudgetWithLegacyCategory).category;
          const name = groupNameOfCategory(b.categoryId ?? legacy ?? '');
          return name === '' ? '\uffff' : name.toLocaleLowerCase();
        };
        return rows.sort((a, b) => compareText(group(a), group(b)) || byName(a, b));
      }
    }
  }, [budgetsWithSpent, budgetOrder, getBudgetCategoryLabel, groupNameOfCategory]);

  // Set loading to false when data is loaded
  useEffect(() => {
    if (budgets !== undefined && transactions !== undefined && categories !== undefined) {
      setIsLoading(false);
    }
  }, [budgets, transactions, categories]);

  // Check for budget alerts. A budget that has finished, or has not begun, is
  // not something to be warned about: its figure is history or nothing.
  useEffect(() => {
    const alerts = budgetsWithSpent
      .filter(budget => budget.isActive && !budget.window.ended && !budget.window.notStarted)
      .map(budget => {
        const categoryLabel = getBudgetCategoryLabel(budget);
        if (budget.percentage >= 100) {
          return {
            budgetId: budget.id,
            categoryName: categoryLabel || 'Unknown',
            percentage: Math.round(budget.percentage),
            spent: budget.spent,
            // The figure the card shows — the plan plus any carry — so an
            // alert can never quote a limit the page does not display.
            budget: budget.effectiveAmount.toNumber(),
            period: budget.period,
            type: 'danger' as const
          };
        } else if (budget.percentage >= alertThreshold) {
          return {
            budgetId: budget.id,
            categoryName: categoryLabel || 'Unknown',
            percentage: Math.round(budget.percentage),
            spent: budget.spent,
            budget: budget.effectiveAmount.toNumber(),
            period: budget.period,
            type: 'warning' as const
          };
        }
        return null;
      })
      .filter(alert => alert !== null);

    if (alerts.length > 0) {
      checkBudgetAlerts(alerts);
    }
  }, [budgetsWithSpent, categoryNameById, alertThreshold, checkBudgetAlerts, getBudgetCategoryLabel]);

  const handleEdit = (budget: Budget) => {
    setEditingBudget(budget);
    setIsModalOpen(true);
  };

  const handleModalClose = () => {
    setIsModalOpen(false);
    setEditingBudget(null);
  };

  /**
   * Awaited, with the failure shown.
   *
   * These two are page actions rather than a form, so there is no modal to
   * hold open — but the silence was the same: the write was launched and
   * forgotten, and a refusal left the row looking exactly as it had before,
   * with nothing said. The context leaves its own state alone when the write
   * throws, so the card still shows the truth; the toast supplies the reason
   * it did not change.
   */
  const handleToggleActive = async (budgetId: string, currentStatus: boolean | undefined): Promise<void> => {
    try {
      await updateBudget(budgetId, { isActive: !currentStatus });
    } catch (error) {
      showError(error);
    }
  };

  const handleDelete = async (budgetId: string): Promise<void> => {
    try {
      await deleteBudget(budgetId);
    } catch (error) {
      showError(error);
    }
  };

  const getProgressColor = (percentage: number) => {
    if (percentage >= 100) return 'bg-red-500';
    if (percentage >= 80) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  /**
   * THE TOTALS, ONE SET PER RHYTHM (owner, 5 Nov 2026).
   *
   * Summed from exactly what the cards show — the effective amount (plan plus
   * carry) and the same spend — so the header can never contradict them. But
   * never ACROSS rhythms: a month's allowance added to a year's is a figure
   * that is nobody's budget, and a page holding both used to print exactly
   * that as "Total Budgeted". A page with one rhythm reads as it always did,
   * captioned with the rhythm; a page with two lists each on its own line.
   *
   * A FINISHED budget is left out: its allowance was for days that are over,
   * and adding it to this period's total would print a figure that is nobody's
   * budget today. One that has not started stays in — it is a commitment made,
   * and the card beside it says when it begins.
   */
  const rhythmTotals = useMemo(() => {
    const active = budgetsWithSpent.filter(b => b && b.isActive !== false && !b.window.ended);
    const order: BudgetPeriodName[] = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly', 'custom', 'every'];
    return order.flatMap(period => {
      const rows = active.filter(b => b.window.period === period);
      if (rows.length === 0) return [];
      // A rhythm is a WINDOW LABEL, not a period name: "every 2 months" and
      // "every 6 weeks" are both 'every' and are two rhythms, each its own
      // line, in the order the labels read.
      const labels = [...new Set(rows.map(b => b.window.label))].sort(compareText);
      return labels.map(label => {
        const ofLabel = rows.filter(b => b.window.label === label);
        const budgeted = ofLabel.reduce((sum, b) => sum.plus(b.effectiveAmount), toDecimal(0));
        const spent = ofLabel.reduce((sum, b) => sum.plus(toDecimal(b.spent || 0)), toDecimal(0));
        return { period, label, budgeted, spent, remaining: budgeted.minus(spent) };
      });
    });
  }, [budgetsWithSpent]);

  /**
   * One of the three summary cards' figures: the single rhythm's total, big,
   * or one line per rhythm when the page holds more than one. `tone` colours
   * a figure by its sign where the card asks for it (Remaining), neutral at
   * zero — £0.00 in green reads as good news on a page with nothing set up.
   */
  const renderTotal = (
    pick: (total: (typeof rhythmTotals)[number]) => DecimalInstance,
    tone: 'plain' | 'signed' = 'plain'
  ): React.JSX.Element => {
    const colour = (value: DecimalInstance): string =>
      tone === 'plain' || value.isZero()
        ? 'text-gray-900 dark:text-white'
        : value.greaterThan(0) ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
    if (rhythmTotals.length === 1) {
      const value = pick(rhythmTotals[0]);
      return (
        <>
          <p className={`text-page font-bold ${colour(value)}`}>{formatCurrency(value)}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">{rhythmTotals[0].label} budgets</p>
        </>
      );
    }
    return (
      <dl className="grid gap-0.5">
        {rhythmTotals.map(total => {
          const value = pick(total);
          return (
            <div key={total.label} className="flex items-baseline justify-between gap-3">
              <dt className="text-xs text-gray-500 dark:text-gray-400">{total.label}</dt>
              <dd className={`text-card font-bold tabular-nums ${colour(value)}`}>{formatCurrency(value)}</dd>
            </div>
          );
        })}
      </dl>
    );
  };

  // The arrows beside Spent and Remaining answer to the whole page's sign.
  const totalSpentValue = rhythmTotals.reduce((sum, t) => sum.plus(t.spent), toDecimal(0)).toNumber();
  const totalRemainingValue = rhythmTotals.reduce((sum, t) => sum.plus(t.remaining), toDecimal(0)).toNumber();

  // Check for enhanced budget alerts whenever budgets change
  useEffect(() => {
    if (budgets.length > 0 && transactions.length > 0) {
      // Same inputs the cards use: split lines count, and rows in another
      // currency do not — an alert that disagrees with the card behind it is
      // worse than no alert.
      checkEnhancedBudgetAlerts(budgets, transactions, categories, {
        transactionSplits,
        foreignAccountIds
      });
    }
  }, [budgets, transactions, categories, transactionSplits, foreignAccountIds, checkEnhancedBudgetAlerts]);

  // The feature folds are furniture for content that doesn't exist until a
  // budget does (Claude Design 22 Aug §7) — the summary trio stands down
  // over the empty page, and the folds answer to the same rule.
  const featuresEarned = !isLoading && budgets.length > 0;

  return (
    <PageWrapper
      title="Budget"
      rightContent={
        <div className="flex items-center gap-2">
        {/* The evidence-first way in (owner, 29 Aug): a budget set against
            what you actually spent beats one guessed at a blank box. Offered
            BESIDE the single-budget button rather than instead of it — the
            two answer different questions, "set them all up" and "add this
            one". */}
        <button
          onClick={() => setIsSetupOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 border border-line dark:border-gray-600 text-gray-700 dark:text-gray-200 text-body font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          title="Set budgets against what you actually spent"
        >
          Set up budgets
        </button>
        <button
          onClick={() => setIsModalOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[#1a2332] text-white text-body font-medium rounded-lg hover:bg-[#2d3a4d] transition-colors shadow-sm"
          title="Create a budget"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {/* The empty state's words (Claude Design 22 Aug §7): two labels for
              one action — "+ Add Budget" here, "+ Create a budget" there —
              were two primaries in two cases on one page. */}
          Create a budget
        </button>
        </div>
      }
    >

      <div className="flex flex-wrap items-center justify-end gap-3 mb-2">
        {/* Only worth offering once there is a grid to arrange. One card in
            an order is not an order. */}
        {budgetsWithSpent.length > 1 && (
          <div className="flex items-center gap-2 mr-auto">
            <label htmlFor="budget-order" className="text-dense text-gray-500 dark:text-gray-400">
              Order
            </label>
            <select
              id="budget-order"
              value={budgetOrder}
              onChange={e => setBudgetOrder(e.target.value as typeof budgetOrder)}
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            >
              <option value="group">By category group</option>
              <option value="az">A–Z</option>
              <option value="used">Most used first</option>
              <option value="largest">Largest budget first</option>
            </select>
          </div>
        )}
        <WholePoundsToggle />
      </div>
      {/* The budgets — the page itself. */}
      {(
        <div className="grid gap-6">
        {/* Summary Cards — HIDDEN WHILE THERE ARE NO BUDGETS (Claude Design,
            22 Aug §3). Three £0.00 cards above "no budgets yet" are furniture
            for data that isn't there — the same finding as the column strip
            over an empty table, and the empty state below should be the first
            thing the page says. Skeletons still show while loading, because a
            loading page doesn't yet know it is empty. */}
        {(isLoading || budgets.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
          <div className="flex items-center justify-between">
            <div>
              {/* No banknote. See the Investments summary cards — a picture of
                  money beside a money figure is the label twice. */}
              <p className="text-gray-600 dark:text-gray-400 text-body">Total Budgeted</p>
              {isLoading ? <SkeletonText className="w-32 h-8" /> : renderTotal(total => total.budgeted)}
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-gray-600 dark:text-gray-400 text-body">Total Spent</p>
              {isLoading ? <SkeletonText className="w-32 h-8" /> : renderTotal(total => total.spent)}
            </div>
            {/* Through the shared rule, not a copy of it: this was an
                unconditional red falling arrow, so £0.00 spent wore a claim
                of money going out — the dashboard's 16 Aug zero-arrow fix
                landing on one surface and not its sibling (Claude Design,
                22 Aug §2). Flow direction: spending points down. */}
            <TrendArrow value={totalSpentValue} direction="down" size={24} />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-gray-600 dark:text-gray-400 text-body">Total Remaining</p>
              {/* Neutral at zero: £0.00 remaining in green "reads as good news
                  on a page where nothing has been set up" (§2). */}
              {isLoading ? <SkeletonText className="w-32 h-8" /> : renderTotal(total => total.remaining, 'signed')}
            </div>
            {/* Sign-driven: headroom points up, overspend points down. */}
            <TrendArrow value={totalRemainingValue} size={24} />
          </div>
        </div>
        </div>
        )}

        {/* Budgets List */}
        <div className="pt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {isLoading ? (
          <>
            <SkeletonCard className="h-48" />
            <SkeletonCard className="h-48" />
            <SkeletonCard className="h-48" />
            <SkeletonCard className="h-48" />
          </>
        ) : orderedBudgets.map(budget => budget && (
          <div
            key={budget.id}
            className={`bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6 ${
              budget.isActive === false ? 'opacity-60' : ''
            }`}
          >
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-card font-semibold text-gray-900 dark:text-white">
                  {getBudgetCategoryLabel(budget)}
                </h3>
                <p className="text-body text-gray-600 dark:text-gray-400">
                  {/* The budget's ACTUAL period — a weekly or quarterly budget
                      used to be captioned "Yearly" because anything that was
                      not monthly fell through to the same branch — AND the
                      exact days it covers right now (owner, 5 Nov 2026: a card
                      that said "Yearly" never said which year, or from when). */}
                  {budget.periodLabel} · {describeBudgetWindow(budget.window)}
                  {/* Past its end date the card still shows what the last
                      period came to, and says in the caption that it is over —
                      a finished one-off among live cards must not read as this
                      month's. Neutral: finished needs no colour. */}
                  {budget.window.ended && ' · finished'}
                  {budget.isActive === false && ' (Inactive)'}
                </p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => void handleToggleActive(budget.id, budget.isActive)}
                  /* Two neutral grounds one step apart, the pair the C/R chips
                     already use — not a hue against a grey. Active is the
                     resting default of every budget on this page and a mark
                     worn by nearly all of them marks nothing; the word in the
                     chip is what says which state it is, and the ground only
                     has to stop the two reading as one control (stock-blue
                     ruling, 28 Aug §4). */
                  className={`px-3 py-1 text-body rounded ${
                    budget.isActive !== false
                      ? 'bg-[#e2e6ed] text-[#475569] dark:bg-gray-600 dark:text-gray-100'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                  }`}
                >
                  {budget.isActive !== false ? 'Active' : 'Inactive'}
                </button>
                <IconButton
                  onClick={() => handleEdit(budget)}
                  icon={<EditIcon size={20} />}
                  variant="ghost"
                  size="md"
                  className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 min-w-[44px] min-h-[44px]"
                  title="Edit Budget"
                />
                <IconButton
                  onClick={() => {
                    if (confirm('Delete this budget?')) {
                      void handleDelete(budget.id);
                    }
                  }}
                  icon={<DeleteIcon size={20} />}
                  variant="ghost"
                  size="md"
                  className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 min-w-[44px] min-h-[44px]"
                  title="Delete Budget"
                />
              </div>
            </div>

            <div className="space-y-3">
              {/* A budget whose first day is still to come has no spend to
                  draw and no percentage to claim: "0% used" would read as a
                  budget nobody has touched, when it is one that has not begun.
                  It says when it starts, and what it will allow. */}
              {budget.window.notStarted ? (
                <p className="text-body text-gray-700 dark:text-gray-200">
                  {budget.pace.text} · {formatCurrency(budget.effectiveAmount)} for the{' '}
                  {budget.periodLabel.toLowerCase() === 'yearly' ? 'year' : 'period'}
                </p>
              ) : (
              <>
              <div className="flex justify-between text-body">
                <span className="text-gray-600 dark:text-gray-400">Spent</span>
                <span className="font-medium text-gray-900 dark:text-white">
                  {formatCurrency(budget.spent)} of {formatCurrency(budget.effectiveAmount)}
                </span>
              </div>

              {/* The BAR stops at full — there is no more room to draw — while
                  the figures below it keep telling the truth past 100%. */}
              <div
                className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(Math.min(budget.percentage, 100))}
                aria-valuetext={`${formatPercentage(budget.percentage, 0)}% of ${getBudgetCategoryLabel(budget)} budget used`}
              >
                <div
                  className={`h-2 rounded-full transition-all ${getProgressColor(budget.percentage)}`}
                  style={{ width: `${Math.min(budget.percentage, 100)}%` }}
                />
              </div>

              <div className="flex justify-between text-body">
                <span className="text-gray-600 dark:text-gray-400">
                  {`${formatPercentage(budget.percentage, 0)}% used`}
                </span>
                <span className={`font-medium ${
                  budget.remaining >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                }`}>
                  {budget.remaining >= 0
                    ? `${formatCurrency(budget.remaining)} remaining`
                    : `over budget by ${formatCurrency(Math.abs(budget.remaining))}`}
                </span>
              </div>

              {/* PACE: how much of the window has gone beside how much of the
                  money has. Red only when spending runs AHEAD of the time —
                  the one reading that needs attention; behind pace and on
                  pace are findings, not alarms (the colour rule). A budget of
                  nothing paces nothing, so it carries only the time gone. */}
              <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>{budget.pace.text}</span>
                {budget.effectiveAmount.greaterThan(0) && (
                  <span className={budget.paceDifference.greaterThan(0) ? 'text-red-600 dark:text-red-400' : ''}>
                    {budget.paceDifference.abs().lessThan(1)
                      ? 'on pace'
                      : budget.paceDifference.greaterThan(0)
                        ? `${formatCurrency(budget.paceDifference)} over the pace`
                        : `${formatCurrency(budget.paceDifference.abs())} under the pace`}
                  </span>
                )}
              </div>
              </>
              )}

              {/* Named where the wrong figure is read, and by its consequence:
                  no rate is applied to another currency in this wave, so the
                  spend shown is short of what was actually spent. */}
              {/* Neutral, permanent, no tint and no icon — the ruling on
                  caveats. "Spending on accounts in another currency is left
                  out" is a standing truth about what this figure can cover, the
                  same species as the uncategorised note on the Reports gallery.
                  Amber made it look like a transient problem with the data,
                  which is the opposite of what it is. */}
              {budget.excludedForeignCount > 0 && (
                <p className="text-dense text-gray-500 dark:text-gray-400">
                  Spending on accounts in another currency is left out, so you have spent more than this.
                </p>
              )}
            </div>
          </div>
        ))}
          </div>

          {/* The house empty-state pattern (Claude Design, 22 Aug §3): what is
              absent, what follows from it, and remedies as REAL CONTROLS —
              this was centred text with "Create your first budget" rendered as
              a plain link, predating batch 7. The second way in goes to the
              Forecast's twelve-month category P&L, which is precisely the
              reading a first budget wants (turning it INTO budgets stays an
              explicit act on that page, per the promotion rule). */}
          {budgets.length === 0 && !isLoading && (
            <div className="md:col-span-2">
              <EmptyState
                title="No budgets yet"
                description="Budgets are what turn your categories into a plan — until there's one here, nothing on this page has anything to measure against."
                action={{ label: 'Create a budget', onClick: () => setIsModalOpen(true) }}
                secondaryAction={{
                  label: 'See last year’s spending',
                  onClick: () => navigate(preserveDemoParam('/forecast', location.search)),
                }}
              />
            </div>
          )}
        </div>
        </div>
      )}

      {/* The features that used to be tabs (§12): each a collapsed fold,
          content mounted only when opened — a heading is cheap, five hundred
          lines of hidden component are not. Earned by a budget existing,
          per the same rule as the summary trio. */}
      {featuresEarned && (
        <div className="mt-8 space-y-3">
          {/* Templates left this list on 1 Sep 2026 (owner: "DELETE THE
              TEMPLATES"): applying a budget set in one go is the wizard's
              job now, and the named-sets remainder lived in localStorage —
              sets that would not follow a person between devices. Rollover
              stays: carrying unspent budget forward is a capability nothing
              else has. */}
          {([
            ['rollover', ArrowRightIcon, 'Rollover', 'Carry what is left of a budget into the next period.'],
            ['alerts', BellIcon, 'Spending alerts', 'Warnings as a budget fills, before it overflows.'],
          ] as const).map(([key, Icon, title, blurb]) => (
            <div key={key} className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700">
              <button
                type="button"
                onClick={() => toggleFeature(key)}
                aria-expanded={openFeatures.has(key)}
                className="w-full flex items-center gap-3 p-5 text-left"
              >
                <Icon size={18} className="text-gray-500 dark:text-gray-400 shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-body font-semibold text-gray-900 dark:text-white">{title}</span>
                  <span className="block text-sm text-gray-500 dark:text-gray-400">{blurb}</span>
                </span>
                {openFeatures.has(key)
                  ? <ChevronDownIcon size={18} className="text-gray-400 shrink-0" />
                  : <ChevronRightIcon size={18} className="text-gray-400 shrink-0" />}
              </button>
              {openFeatures.has(key) && (
                <div className="px-5 pb-5">
                  {key === 'rollover' && <BudgetRollover />}
                  {key === 'alerts' && <SpendingAlerts />}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Mounted only once asked for: the wizard is a lazy chunk, and mounting
          it unconditionally would fetch it for every visit to this page. */}
      {isSetupOpen && (
        <Suspense fallback={null}>
          <BudgetWizard isOpen onClose={() => setIsSetupOpen(false)} />
        </Suspense>
      )}

      <BudgetModal
        isOpen={isModalOpen}
        onClose={handleModalClose}
        budget={editingBudget || undefined}
        // One line per category (Money's model): when the chosen category
        // already has a budget, the modal offers to edit THAT one instead of
        // adding a second that would double-count.
        onEditExisting={setEditingBudget}
      />

      {/* id bumped from `budget-intro`: the old copy recommended envelope
          and zero-based budgeting, both retired in #393 — a tip pointing at
          deleted features is wrong, not stale, so past dismissers see the
          correction once. */}
      <PageTip
        id="budget-intro-2"
        title="Track your spending with budgets"
        description="Give a category a limit for its period — weekly, monthly or yearly — and the bar shows what you've spent against it. Rollover and alerts are in the folds below the list."
      />
    </PageWrapper>
  );
}
