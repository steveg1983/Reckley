import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useApp } from '../contexts/AppContextSupabase';
import { useToast } from '../contexts/ToastContext';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import MoneyInput from './common/MoneyInput';
import { toDecimal, toStorageNumber, parseMoneyInput } from '../utils/decimal';
import type { DecimalInstance } from '../utils/decimal';
import { getEffectiveBudgetAmount, sumBudgetCarry } from '../utils/budgetAmounts';
import { normaliseBudgetPeriod } from '../utils/budgetPeriods';
import { getDateLocale, formatShortDate } from '../utils/dateFormatter';
import {
  ArrowRightIcon,
  CheckCircleIcon,
  RepeatIcon,
  SettingsIcon
} from './icons';

interface RolloverSettings {
  enabled: boolean;
  mode: 'percentage' | 'fixed' | 'all';
  percentage: number; // If mode is percentage
  maxAmount?: number; // Optional cap
  excludeCategories: string[]; // Stored as category IDs (legacy name values still respected)
  autoApply: boolean;
  carryNegative: boolean; // Whether to carry over overages as debt
}

interface RolloverPeriod {
  month: number;
  year: number;
}

interface RolloverHistory {
  id: string;
  fromPeriod: RolloverPeriod;
  toPeriod: RolloverPeriod;
  rollovers: Array<{
    budgetId: string;
    categoryId: string;
    categoryName: string;
    originalBudget: DecimalInstance;
    spent: DecimalInstance;
    remaining: DecimalInstance;
    rolledOver: DecimalInstance;
  }>;
  totalRolledOver: DecimalInstance;
  appliedAt: Date;
}

/**
 * What actually goes into localStorage.
 *
 * Decimal instances and Dates do not survive `JSON.stringify` → `JSON.parse`,
 * and `useLocalStorage` has no reviver: an earlier build wrote the runtime
 * shape straight through, so on the next page load `totalRolledOver` came back
 * as the STRING decimal.js serialises to, `entry.totalRolledOver.greaterThan(0)`
 * threw, and this tab crashed for good. Everything is persisted as a plain
 * number / ISO string and rehydrated on read instead.
 */
interface StoredRolloverHistory {
  id: string;
  fromPeriod: RolloverPeriod;
  toPeriod: RolloverPeriod;
  rollovers: Array<{
    budgetId: string;
    categoryId: string;
    categoryName: string;
    originalBudget: number;
    spent: number;
    remaining: number;
    rolledOver: number;
  }>;
  totalRolledOver: number;
  appliedAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readString = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Expected a string');
  return value;
};

const readNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Expected a finite number');
  }
  return value;
};

/**
 * Money, as either a number or the numeric string decimal.js serialises to.
 * Accepting the string is what rescues history written by the broken build —
 * the figures themselves were never lost, only their type. Anything that is not
 * a plain signed decimal is rejected rather than coerced.
 */
const readMoney = (value: unknown): number => {
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return readNumber(value);
};

const readPeriod = (value: unknown): RolloverPeriod => {
  if (!isRecord(value)) throw new Error('Expected a period');
  return { month: readNumber(value.month), year: readNumber(value.year) };
};

/**
 * Rehydrate one stored entry, or discard it. Anything that cannot be read back
 * into trustworthy figures is dropped rather than guessed at — this is
 * device-local display history, and a wrong number would be worse than a
 * missing one.
 */
const reviveHistoryEntry = (raw: unknown): RolloverHistory | null => {
  try {
    if (!isRecord(raw)) return null;
    const appliedAt = new Date(readString(raw.appliedAt));
    if (Number.isNaN(appliedAt.getTime())) return null;
    if (!Array.isArray(raw.rollovers)) return null;

    return {
      id: readString(raw.id),
      fromPeriod: readPeriod(raw.fromPeriod),
      toPeriod: readPeriod(raw.toPeriod),
      rollovers: raw.rollovers.map(entry => {
        if (!isRecord(entry)) throw new Error('Expected a rollover row');
        return {
          budgetId: readString(entry.budgetId),
          categoryId: readString(entry.categoryId),
          categoryName: readString(entry.categoryName),
          originalBudget: toDecimal(readMoney(entry.originalBudget)),
          spent: toDecimal(readMoney(entry.spent)),
          remaining: toDecimal(readMoney(entry.remaining)),
          rolledOver: toDecimal(readMoney(entry.rolledOver))
        };
      }),
      totalRolledOver: toDecimal(readMoney(raw.totalRolledOver)),
      appliedAt
    };
  } catch {
    return null;
  }
};

const toStoredHistory = (entry: RolloverHistory): StoredRolloverHistory => ({
  id: entry.id,
  fromPeriod: entry.fromPeriod,
  toPeriod: entry.toPeriod,
  rollovers: entry.rollovers.map(rollover => ({
    budgetId: rollover.budgetId,
    categoryId: rollover.categoryId,
    categoryName: rollover.categoryName,
    originalBudget: toStorageNumber(rollover.originalBudget),
    spent: toStorageNumber(rollover.spent),
    remaining: toStorageNumber(rollover.remaining),
    rolledOver: toStorageNumber(rollover.rolledOver)
  })),
  totalRolledOver: toStorageNumber(entry.totalRolledOver),
  appliedAt: entry.appliedAt.toISOString()
});

const samePeriod = (a: RolloverPeriod, b: RolloverPeriod): boolean =>
  a.month === b.month && a.year === b.year;

interface BudgetRolloverSummary {
  budgetId: string;
  categoryId: string;
  categoryName: string;
  originalBudget: DecimalInstance;
  spent: DecimalInstance;
  remaining: DecimalInstance;
  rolloverAmount: DecimalInstance;
  isEligible: boolean;
  willRollover: boolean;
}

export default function BudgetRollover() {
  const { categories, transactions, budgets, updateBudget } = useApp();
  /**
   * MONTHLY BUDGETS ONLY (5 Nov 2026). Everything below carries LAST MONTH's
   * headroom into THIS month: the previous period is computed as the previous
   * calendar month and nothing else. Applied to a yearly budget that would
   * carry a month's slice of a year's allowance, which is no figure at all —
   * so a budget of any other rhythm is left alone here, and the fold says
   * how many. A year's carry, derived from the same window module the Budget
   * page reads, is a later build.
   */
  const monthlyBudgets = useMemo(
    () => budgets.filter(budget => normaliseBudgetPeriod(budget.period) === 'monthly'),
    [budgets]
  );
  const otherRhythmCount = budgets.length - monthlyBudgets.length;
  const { showSuccess, showError } = useToast();
  const { formatCurrency } = useCurrencyDecimal();

  const [rolloverSettings, setRolloverSettings] = useLocalStorage<RolloverSettings>('rollover-settings', {
    enabled: false,
    mode: 'all',
    percentage: 100,
    excludeCategories: [],
    autoApply: false,
    carryNegative: false
  });

  // Typed as `unknown` on purpose: whatever is on this device may predate the
  // stored shape below, so it is validated on read rather than trusted.
  const [storedHistory, setStoredHistory] = useLocalStorage<unknown>('rollover-history', []);
  const [showSettings, setShowSettings] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  const currentDate = new Date();
  const currentMonth = currentDate.getMonth();
  const currentYear = currentDate.getFullYear();

  // Calculate previous period
  const previousDate = new Date(currentYear, currentMonth - 1, 1);
  const previousMonth = previousDate.getMonth();
  const previousYear = previousDate.getFullYear();

  const storedHistoryEntries = useMemo<unknown[]>(
    () => (Array.isArray(storedHistory) ? storedHistory : []),
    [storedHistory]
  );

  const rolloverHistory = useMemo<RolloverHistory[]>(
    () => storedHistoryEntries
      .map(reviveHistoryEntry)
      .filter((entry): entry is RolloverHistory => entry !== null),
    [storedHistoryEntries]
  );

  // Migrate the payload in place the first time it is read: legacy entries are
  // rewritten in the plain shape and unreadable ones drop out for good, so the
  // broken payload is not re-parsed on every render of every session.
  // `toStoredHistory(revive(x))` is a fixed point, so this settles in one write.
  useEffect(() => {
    const normalised = rolloverHistory.map(toStoredHistory);
    if (JSON.stringify(normalised) !== JSON.stringify(storedHistoryEntries)) {
      setStoredHistory(normalised);
    }
  }, [rolloverHistory, storedHistoryEntries, setStoredHistory]);

  const exclusionSet = useMemo(() => new Set(rolloverSettings.excludeCategories), [rolloverSettings.excludeCategories]);

  /**
   * A budget's headroom in the PREVIOUS period, i.e. its plan plus whatever was
   * carried into that month. `budget.rolloverAmount` always describes the most
   * recent apply — which may already be the current month — so the previous
   * month's carry is read from history instead of from the budget.
   */
  const previousPeriodCarry = useMemo(() => {
    const carry = new Map<string, DecimalInstance>();
    const entry = rolloverHistory.find(history =>
      samePeriod(history.toPeriod, { month: previousMonth, year: previousYear })
    );
    entry?.rollovers.forEach(rollover => carry.set(rollover.budgetId, rollover.rolledOver));
    return carry;
  }, [rolloverHistory, previousMonth, previousYear]);

  const alreadyAppliedForPeriod = useMemo(
    () => rolloverHistory.some(entry =>
      samePeriod(entry.fromPeriod, { month: previousMonth, year: previousYear }) &&
      samePeriod(entry.toPeriod, { month: currentMonth, year: currentYear })
    ),
    [rolloverHistory, previousMonth, previousYear, currentMonth, currentYear]
  );

  // Calculate rollover amounts for each budget
  const rolloverData = useMemo<BudgetRolloverSummary[]>(() => {
    const startDate = new Date(previousYear, previousMonth, 1);
    const endDate = new Date(previousYear, previousMonth + 1, 0);

    const categoryNameLookup = new Map(categories.map(category => [category.id, category.name]));
    // Money-style netting: a refund filed to the budget's category arrives as
    // an income-typed row and REDUCES spend — so no type filter here, only
    // transfers are skipped.
    const nonTransferTransactions = transactions
      .filter(t => t.type !== 'transfer')
      .map(t => ({
        category: t.category,
        // Cached/imported rows can arrive as ISO strings; a string compared
        // against a Date silently yields false and would empty the period.
        date: t.date instanceof Date ? t.date : new Date(t.date),
        amount: toDecimal(t.amount)
      }));

    return monthlyBudgets.map<BudgetRolloverSummary>(budget => {
      const categoryId = budget.categoryId;
      const categoryName = categoryNameLookup.get(categoryId) ?? categoryId;
      const budgetAmount = toDecimal(budget.amount).plus(previousPeriodCarry.get(budget.id) ?? toDecimal(0));

      const netSpent = nonTransferTransactions
        .filter(t =>
          t.category === categoryId &&
          t.date >= startDate &&
          t.date <= endDate
        )
        // Signed convention: spending is negative, so negate to accumulate
        // spend; refunds net it down. Clamped at zero for the rollover maths.
        .reduce((sum, t) => sum.minus(t.amount), toDecimal(0));
      const spent = netSpent.isNegative() ? toDecimal(0) : netSpent;

      const remaining = budgetAmount.minus(spent);
      const isExcluded = exclusionSet.has(categoryId) || exclusionSet.has(categoryName);
      const isEligible = rolloverSettings.enabled && !isExcluded;

      let rolloverAmount = toDecimal(0);

      if (isEligible && (remaining.greaterThan(0) || (remaining.lessThan(0) && rolloverSettings.carryNegative))) {
        switch (rolloverSettings.mode) {
          case 'all':
            rolloverAmount = remaining;
            break;
          case 'percentage':
            rolloverAmount = remaining.times(rolloverSettings.percentage / 100);
            break;
          case 'fixed':
            rolloverAmount = remaining.greaterThan(0) ? remaining : toDecimal(0);
            break;
        }

        if (rolloverSettings.maxAmount && rolloverAmount.greaterThan(rolloverSettings.maxAmount)) {
          rolloverAmount = toDecimal(rolloverSettings.maxAmount);
        }
      }

      return {
        budgetId: budget.id,
        categoryId,
        categoryName,
        originalBudget: budgetAmount,
        spent,
        remaining,
        rolloverAmount,
        isEligible,
        willRollover: rolloverAmount.abs().greaterThan(0)
      };
    });
  }, [monthlyBudgets, categories, exclusionSet, previousMonth, previousPeriodCarry, previousYear, rolloverSettings, transactions]);

  const totalRollover = rolloverData.reduce((sum, data) => sum.plus(data.rolloverAmount), toDecimal(0));
  const eligibleBudgets = rolloverData.filter(data => data.isEligible).length;
  const budgetsWithSurplus = rolloverData.filter(data => data.remaining.greaterThan(0)).length;
  const budgetsWithDeficit = rolloverData.filter(data => data.remaining.lessThan(0)).length;
  const currentCarry = useMemo(() => sumBudgetCarry(monthlyBudgets), [monthlyBudgets]);

  // `'default'` here meant the RUNTIME's locale, not the reader's choice: a
  // browser set to French printed "janvier" under an app set to English (UK).
  // The setting is the app's one answer to which region it is speaking.
  const getMonthName = useCallback(
    (month: number) => new Date(2000, month).toLocaleString(getDateLocale(), { month: 'long' }),
    []
  );

  /**
   * Write this period's carry to every budget and log it once.
   *
   * The carry lands in `rolloverAmount`, never in `amount`: the plan the user
   * typed stays untouched, and because each apply REPLACES the carry rather
   * than adding to it the figure cannot compound. Budgets that are not rolling
   * over are reset to zero in the same pass, so a carry granted by an earlier
   * apply cannot linger next to a newer one. The history guard then stops the
   * same period being applied twice at all.
   */
  const applyRollover = async () => {
    if (alreadyAppliedForPeriod || isApplying) return;
    setIsApplying(true);

    try {
      await Promise.all(rolloverData.map(async data => {
        const budget = budgets.find(b => b.id === data.budgetId);
        if (!budget) return;

        const carry = data.willRollover ? toStorageNumber(data.rolloverAmount) : 0;
        const rollover = carry !== 0;
        if ((budget.rolloverAmount ?? 0) === carry && (budget.rollover === true) === rollover) return;

        await updateBudget(data.budgetId, { rollover, rolloverAmount: carry });
      }));

      const historyEntry: RolloverHistory = {
        id: Date.now().toString(),
        fromPeriod: { month: previousMonth, year: previousYear },
        toPeriod: { month: currentMonth, year: currentYear },
        rollovers: rolloverData
          .filter(data => data.willRollover)
          .map(data => ({
            budgetId: data.budgetId,
            categoryId: data.categoryId,
            categoryName: data.categoryName,
            originalBudget: data.originalBudget,
            spent: data.spent,
            remaining: data.remaining,
            rolledOver: data.rolloverAmount
          })),
        totalRolledOver: totalRollover,
        appliedAt: new Date()
      };

      setStoredHistory([historyEntry, ...rolloverHistory].map(toStoredHistory));
      setShowPreview(false);
      showSuccess(
        `${formatCurrency(totalRollover)} carried into ${getMonthName(currentMonth)} ${currentYear}`,
        'Rollover applied'
      );
    } catch (error) {
      showError(error);
    } finally {
      setIsApplying(false);
    }
  };

  const alreadyAppliedMessage =
    `${getMonthName(previousMonth)} ${previousYear} has already been rolled into ` +
    `${getMonthName(currentMonth)} ${currentYear}. Applying it again would double the carry.`;
  const canPreview = rolloverSettings.enabled && !totalRollover.equals(0) && !alreadyAppliedForPeriod;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Budget Rollover</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Carry forward unused budget from {getMonthName(previousMonth)} {previousYear}
            </p>
            {otherRhythmCount > 0 && (
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Monthly budgets only: {otherRhythmCount} budget{otherRhythmCount === 1 ? '' : 's'} of another
                rhythm {otherRhythmCount === 1 ? 'is' : 'are'} left alone.
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="flex items-center gap-2 px-4 py-2 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
            >
              <SettingsIcon size={16} />
              Settings
            </button>
            <button
              onClick={() => setShowPreview(true)}
              disabled={!canPreview}
              title={alreadyAppliedForPeriod ? alreadyAppliedMessage : undefined}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg ${
                canPreview
                  ? 'bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary)]/90'
                  : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
            >
              <ArrowRightIcon size={16} />
              Preview Rollover
            </button>
          </div>
        </div>

        {/* Status */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            {/* An ON dot is the same job as a toggle track, so it takes the
                same pair (stock-blue ruling, 28 Aug 2026). Not the selected
                slate: #94a3b8 beside this dot's own OFF grey (#9ca3af) would
                make the two states indistinguishable, which is the one thing
                the dot exists to do. */}
            <div className={`w-2 h-2 rounded-full ${rolloverSettings.enabled ? 'bg-navy-400 dark:bg-primary-action' : 'bg-gray-400'}`} />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Rollover {rolloverSettings.enabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          {rolloverSettings.autoApply && (
            <div className="flex items-center gap-2">
              {/* A setting that is simply on needs no colour; it now reads in
                  the same ink as "Rollover Enabled" beside it. */}
              <RepeatIcon size={14} className="text-gray-600 dark:text-gray-400" />
              <span className="text-sm text-gray-700 dark:text-gray-300">Auto-apply</span>
            </div>
          )}
        </div>

        {alreadyAppliedForPeriod && (
          <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
            {alreadyAppliedMessage}
          </p>
        )}

        {/* Summary Stats */}
        {rolloverSettings.enabled && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mt-4">
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <p className="text-xs text-gray-600 dark:text-gray-400">Total Rollover</p>
              <p className={`text-lg font-semibold ${
                totalRollover.greaterThan(0) 
                  ? 'text-green-600 dark:text-green-400' 
                  : totalRollover.lessThan(0)
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-gray-900 dark:text-white'
              }`}>
                {formatCurrency(totalRollover)}
              </p>
            </div>
            
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <p className="text-xs text-gray-600 dark:text-gray-400">Eligible Budgets</p>
              <p className="text-lg font-semibold text-gray-900 dark:text-white">
                {eligibleBudgets} of {monthlyBudgets.length}
              </p>
            </div>
            
            <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3">
              <p className="text-xs text-green-700 dark:text-green-300">With Surplus</p>
              <p className="text-lg font-semibold text-green-700 dark:text-green-300">
                {budgetsWithSurplus}
              </p>
            </div>
            
            <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
              <p className="text-xs text-red-700 dark:text-red-300">With Deficit</p>
              <p className="text-lg font-semibold text-red-700 dark:text-red-300">
                {budgetsWithDeficit}
              </p>
            </div>

            {/* Green and red beside this tile are the app's surplus and
                deficit. "Carried into …" is neither — it is a figure, not a
                verdict — so it joins the two neutral tiles at the head of this
                row rather than inventing a third meaning in blue (stock-blue
                ruling, 28 Aug 2026). */}
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <p className="text-xs text-gray-600 dark:text-gray-400">
                Carried into {getMonthName(currentMonth)}
              </p>
              <p className="text-lg font-semibold text-gray-900 dark:text-white">
                {formatCurrency(currentCarry)}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Rollover Details */}
      {rolloverSettings.enabled && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {rolloverData
            .filter(data => data.isEligible)
            .map(data => (
              <div
                key={data.budgetId}
                className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-100 dark:border-gray-700 p-4"
              >
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-medium text-gray-900 dark:text-white">{data.categoryName}</h4>
                  {/* "This one will roll over" is a settled fact about a card,
                      not something that needs attention and not an event that
                      just succeeded — so the tick is neutral ink, and it now
                      has the dark counterpart it never had. */}
                  {data.willRollover && (
                    <CheckCircleIcon size={16} className="text-gray-600 dark:text-gray-400" />
                  )}
                </div>
                
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Previous Budget:</span>
                    <span className="text-gray-900 dark:text-white">
                      {formatCurrency(data.originalBudget)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Spent:</span>
                    <span className="text-gray-900 dark:text-white">
                      {formatCurrency(data.spent)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Remaining:</span>
                    <span className={data.remaining.greaterThan(0) ? 'text-green-600' : 'text-red-600'}>
                      {formatCurrency(data.remaining)}
                    </span>
                  </div>
                  {data.willRollover && (
                    <div className="flex justify-between pt-2 border-t border-gray-200 dark:border-gray-700">
                      <span className="text-gray-600 dark:text-gray-400">Will Rollover:</span>
                      <span className="font-medium text-green-600 dark:text-green-400">
                        {formatCurrency(data.rolloverAmount)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}

      {/* History */}
      {rolloverHistory.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Rollover History</h3>
          
          <div className="space-y-3">
            {rolloverHistory.slice(0, 5).map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
              >
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">
                    {getMonthName(entry.fromPeriod.month)} {entry.fromPeriod.year} → {getMonthName(entry.toPeriod.month)} {entry.toPeriod.year}
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {entry.rollovers.length} categories • {formatShortDate(entry.appliedAt)}
                  </p>
                </div>
                <span className={`font-medium ${
                  entry.totalRolledOver.greaterThan(0) 
                    ? 'text-green-600 dark:text-green-400' 
                    : 'text-red-600 dark:text-red-400'
                }`}>
                  {formatCurrency(entry.totalRolledOver)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-2xl w-full max-w-md p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Rollover Settings</h3>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Enable Budget Rollover
                </label>
                <input
                  type="checkbox"
                  checked={rolloverSettings.enabled}
                  onChange={(e) => setRolloverSettings({
                    ...rolloverSettings,
                    enabled: e.target.checked
                  })}
                  className="rounded"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Rollover Mode
                </label>
                <select
                  value={rolloverSettings.mode}
                  onChange={(e) => setRolloverSettings({
                    ...rolloverSettings,
                    mode: e.target.value as RolloverSettings['mode']
                  })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                >
                  <option value="all">Roll over all remaining</option>
                  <option value="percentage">Roll over percentage</option>
                  <option value="fixed">Fixed amount only</option>
                </select>
              </div>

              {rolloverSettings.mode === 'percentage' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Percentage to Roll Over
                  </label>
                  <input
                    type="number"
                    value={rolloverSettings.percentage}
                    onChange={(e) => setRolloverSettings({
                      ...rolloverSettings,
                      percentage: parseInt(e.target.value) || 0
                    })}
                    min="0"
                    max="100"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
              )}

              <div>
                <label htmlFor="rollover-max-amount" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Maximum Rollover Amount (Optional)
                </label>
                <MoneyInput
                  id="rollover-max-amount"
                  value={rolloverSettings.maxAmount ?? ''}
                  onChange={(value) => setRolloverSettings({
                    ...rolloverSettings,
                    maxAmount: value ? parseMoneyInput(value) ?? undefined : undefined
                  })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  placeholder="No limit"
                />
              </div>

              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Auto-apply at month end
                </label>
                <input
                  type="checkbox"
                  checked={rolloverSettings.autoApply}
                  onChange={(e) => setRolloverSettings({
                    ...rolloverSettings,
                    autoApply: e.target.checked
                  })}
                  className="rounded"
                />
              </div>

              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Carry negative balances
                </label>
                <input
                  type="checkbox"
                  checked={rolloverSettings.carryNegative}
                  onChange={(e) => setRolloverSettings({
                    ...rolloverSettings,
                    carryNegative: e.target.checked
                  })}
                  className="rounded"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Exclude Categories
                </label>
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {categories.map(category => (
                    <label key={category.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={exclusionSet.has(category.id) || exclusionSet.has(category.name)}
                        onChange={(e) => {
                          const next = new Set(rolloverSettings.excludeCategories);
                          next.delete(category.name);
                          next.delete(category.id);

                          if (e.target.checked) {
                            next.add(category.id);
                          }

                          setRolloverSettings({
                            ...rolloverSettings,
                            excludeCategories: Array.from(next)
                          });
                        }}
                        className="rounded"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300">{category.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 bg-[var(--color-primary)] text-white rounded-lg hover:bg-[var(--color-primary)]/90"
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {showPreview && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-2xl w-full max-w-2xl p-6 max-h-[80vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
              Rollover Preview
            </h3>
            
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              The following amounts will be carried into your {getMonthName(currentMonth)} budgets.
              Each budget&apos;s planned amount is left untouched — the carry is held separately and
              replaced, never added to, if you roll over again.
            </p>

            <div className="space-y-3 mb-6">
              {rolloverData
                .filter(data => data.willRollover)
                .map((data) => {
                  const currentBudget = budgets.find(b => b.id === data.budgetId);
                  const currentAmount = currentBudget
                    ? getEffectiveBudgetAmount(currentBudget)
                    : toDecimal(0);
                  const projectedAmount = toDecimal(currentBudget?.amount ?? 0).plus(data.rolloverAmount);

                  return (
                    <div
                      key={data.budgetId}
                      className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
                    >
                      <div>
                        <p className="font-medium text-gray-900 dark:text-white">{data.categoryName}</p>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                          {formatCurrency(currentAmount)} → {formatCurrency(projectedAmount)}
                        </p>
                      </div>
                      <span className={`font-medium ${
                        data.rolloverAmount.greaterThan(0)
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}>
                        +{formatCurrency(data.rolloverAmount)}
                      </span>
                    </div>
                  );
                })}
            </div>
            
            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <div className="flex items-center justify-between mb-4">
                <span className="font-medium text-gray-900 dark:text-white">Total Rollover:</span>
                <span className={`text-lg font-bold ${
                  totalRollover.greaterThan(0)
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-red-600 dark:text-red-400'
                }`}>
                  {formatCurrency(totalRollover)}
                </span>
              </div>
              
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setShowPreview(false)}
                  className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
                >
                  Cancel
                </button>
                <button
                  onClick={applyRollover}
                  disabled={isApplying || alreadyAppliedForPeriod}
                  className={`px-4 py-2 rounded-lg ${
                    isApplying || alreadyAppliedForPeriod
                      ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                      : 'bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary)]/90'
                  }`}
                >
                  {isApplying ? 'Applying…' : 'Apply Rollover'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
