import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../contexts/AppContextSupabase';
import { Modal, ModalBody, ModalFooter } from './common/Modal';
import MoneyInput from './common/MoneyInput';
import { useModalForm } from '../hooks/useModalForm';
import { parseMoneyInput } from '../utils/decimal';
import { getBudgetPeriodWindow, resolveBudgetAnchor, type BudgetRepeat } from '../utils/budgetPeriods';
import { describeBudgetDay, describeBudgetWindow } from '../utils/budgetPace';
import CategorySelector from './CategorySelector';
import type { Budget, BudgetRepeatUnit, Category } from '../types';

const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The day a budget's cycles count from, as this form first shows it.
 *
 * A new budget starts on the 1st of this month (the owner's default, 5 Nov
 * 2026). An existing one shows its anchor — or, for a legacy row that still
 * keeps the calendar, the first day of the calendar period it is being
 * measured over right now, which is the truth of where it runs from and the
 * day a save would make explicit. See utils/budgetPeriods.
 */
function seededStart(budget: Budget | undefined, now: Date): string {
  if (!budget) return isoDay(new Date(now.getFullYear(), now.getMonth(), 1));
  return resolveBudgetAnchor(budget) ?? isoDay(getBudgetPeriodWindow(budget, now).start);
}

interface BudgetModalProps {
  isOpen: boolean;
  onClose: () => void;
  budget?: Budget;
  /**
   * Switch this modal to editing the budget the chosen category ALREADY has.
   * One line per category is Money's model — two budgets on one category
   * double-count in every total — so the duplicate is offered as an edit
   * rather than refused outright.
   */
  onEditExisting?: (existing: Budget) => void;
}

interface FormData {
  categoryId: string;
  amount: string;
  period: Budget['period'];
  /** ISO day the cycles count from. Not asked for a weekly budget, which has no anchor. */
  startDate: string;
  /**
   * ISO day the budget stops, or '' for none. Optional for a repeating period;
   * required for a one-off, which is nothing but its two days.
   */
  endDate: string;
  /** For "Every…": how many, as typed, and of what. Ignored for every other period. */
  repeatCount: string;
  repeatUnit: BudgetRepeatUnit;
  isActive: boolean;
}

/**
 * The periods this modal can create. Each one has a window the app derives on
 * its own (see utils/budgetPeriods). 'custom' is offered as "One-off" — a
 * budget that runs once from Starts to Ends — now that the form collects both
 * days; until it did, offering it would have created budgets whose period was
 * a guess. 'every' is "Every…": N weeks or months of the user's own (owner,
 * 7 Nov 2026), the two fields beside it saying which.
 */
const PERIOD_OPTIONS: ReadonlyArray<{ value: Budget['period']; label: string }> = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'every', label: 'Every…' },
  { value: 'custom', label: 'One-off' }
];

/** The typed count as the interval it names, or null when it is not a whole number of at least one. */
function repeatOf(period: Budget['period'], count: string, unit: BudgetRepeatUnit): BudgetRepeat | null {
  if (period !== 'every') return null;
  if (!/^\d+$/.test(count.trim())) return null;
  const n = Number(count);
  return n >= 1 ? { count: n, unit } : null;
}

/** "month", "quarter", "year", "2 months", "6 weeks" — the unit a repeating period's cycle is named by. */
function cycleUnit(period: Budget['period'], repeat: BudgetRepeat | null): string {
  switch (period) {
    case 'monthly': return 'month';
    case 'quarterly': return 'quarter';
    case 'yearly': return 'year';
    case 'every':
      if (!repeat) return 'period';
      return repeat.count === 1 ? repeat.unit : `${repeat.count} ${repeat.unit}s`;
    default: return 'period';
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A typed ISO day as a local Date, or null for anything else. */
function localDay(iso: string): Date | null {
  if (!ISO_DAY.test(iso)) return null;
  const [year, month1, day] = iso.split('-').map(Number);
  return new Date(year, month1 - 1, day);
}

/**
 * What the form's dates add up to, in one sentence, so the reader sees the
 * consequence before saving: "First month: 1 Nov – 30 Nov 2026. Last month:
 * 1 Jun – 30 Jun 2027." for a repeating budget, "Runs until 30 Jun 2027." for
 * a weekly one (no anchor, so no first cycle to name), "Runs once, 1 Dec 2026
 * – 31 Jan 2027, and is then finished." for a one-off. No creation stamp is
 * passed: a day typed here is chosen by definition. An end before the start
 * is left to the validation message rather than described.
 */
function describeChoice(
  period: Budget['period'],
  startDate: string,
  endDate: string,
  repeat: BudgetRepeat | null
): string {
  const start = localDay(startDate);
  const end = localDay(endDate);
  if (end && start && end < start) return '';

  if (period === 'weekly') return end ? `Runs until ${describeBudgetDay(end)}.` : '';
  if (!start) return '';

  if (period === 'custom') {
    if (!end) return '';
    const once = getBudgetPeriodWindow({ period, startDate, endDate, createdAt: null }, start);
    return `Runs once, ${describeBudgetWindow(once)}, and is then finished.`;
  }
  // "Every…" with no sound count has no first period to name yet.
  if (period === 'every' && !repeat) return '';

  const source = {
    period,
    startDate,
    createdAt: null,
    repeatCount: repeat?.count ?? null,
    repeatUnit: repeat?.unit ?? null,
  };
  const unit = cycleUnit(period, repeat);
  const first = getBudgetPeriodWindow({ ...source, endDate: endDate || null }, start);
  const sentences = [`First ${unit}: ${describeBudgetWindow(first)}.`];
  if (end) {
    // Read the day after the end: the window is then the LAST cycle, cut there.
    const dayAfter = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
    const last = getBudgetPeriodWindow({ ...source, endDate }, dayAfter);
    sentences.push(`Last ${unit}: ${describeBudgetWindow(last)}.`);
  }
  return sentences.join(' ');
}

/** A <select> value narrowed to a real period — no cast, no unlisted value. */
function toBudgetPeriod(value: string): Budget['period'] {
  return PERIOD_OPTIONS.find(option => option.value === value)?.value ?? 'monthly';
}

export default function BudgetModal({ isOpen, onClose, budget, onEditExisting }: BudgetModalProps): React.JSX.Element {
  const { addBudget, updateBudget, categories, budgets } = useApp();

  /**
   * Budgets key on a category ID: that is what `calculateBudgetSpending`
   * matches against `transaction.category`, and what the recommendation
   * service writes. This modal's old flat <select> stored the category NAME
   * instead, so a budget added here matched nothing. Resolve such a legacy
   * value back to its id, so editing an old budget both shows the right
   * category and heals the stored value on save.
   *
   * Group budgets are resolvable the same way: a group ("Food") is a real
   * category with an id, so nothing here needs to know which level it is.
   */
  const resolveCategoryId = useCallback((stored: string | undefined): string => {
    if (!stored) return '';
    if (categories.some((c: Category) => c.id === stored)) return stored;
    const byName = categories.find(
      (c: Category) => (c.level === 'detail' || c.level === 'sub') && c.name === stored
    );
    return byName?.id ?? '';
  }, [categories]);

  const seededCategoryId = useMemo(
    (): string => resolveCategoryId(budget?.categoryId),
    [budget?.categoryId, resolveCategoryId]
  );
  const openedAt = useMemo(() => new Date(), []);
  const seededStartDate = useMemo(() => seededStart(budget, openedAt), [budget, openedAt]);

  const { formData, updateField, handleSubmit, setFormData, errors, isSubmitting } = useModalForm<FormData>(
    {
      categoryId: seededCategoryId,
      amount: budget?.amount?.toString() || '',
      period: budget?.period || 'monthly',
      startDate: seededStartDate,
      endDate: budget?.endDate ?? '',
      repeatCount: budget?.repeatCount ? String(budget.repeatCount) : '',
      repeatUnit: budget?.repeatUnit ?? 'month',
      isActive: budget?.isActive !== false
    },
    {
      onSubmit: async (data) => {
        const now = new Date();
        const repeat = repeatOf(data.period, data.repeatCount, data.repeatUnit);
        const budgetData = {
          categoryId: data.categoryId,
          amount: parseMoneyInput(data.amount) ?? 0,
          period: data.period,
          // The pair belongs to "Every…" alone; both engines refuse it on any
          // other period, and null clears a stored one when the period moves.
          repeatCount: repeat?.count ?? null,
          repeatUnit: repeat?.unit ?? null,
          isActive: data.isActive,
          createdAt: budget?.createdAt || now,
          updatedAt: now,
          // A weekly budget has no anchor to write; every other period's
          // cycles count from this day.
          ...(data.period === 'weekly' ? {} : { startDate: data.startDate }),
          // The day it stops, or null: an end date cleared here must clear the
          // stored one, and `undefined` would leave it in place.
          endDate: data.endDate || null
        };

        // Awaited: a limit that failed to save must keep the modal open with
        // the reason on screen. Unawaited, the save was assumed to have worked
        // — the modal shut on a refusal that nobody saw, and the budget the
        // user had just set simply was not there.
        if (budget) {
          await updateBudget(budget.id, budgetData);
        } else {
          await addBudget(budgetData);
        }
      },
      onClose
    }
  );

  // The combobox has no native `required`, so the form guards the field itself.
  const [categoryError, setCategoryError] = useState('');
  // The two days against each other — a native `min` on Ends helps a mouse,
  // not a typed value, and a one-off needs both days before it is anything.
  const [datesError, setDatesError] = useState('');

  /**
   * The budget this category already has, if any.
   *
   * Nothing stopped a second budget on one category, and once there were two
   * every total counted the category twice while each card showed the same
   * spending against a different limit. One line per category, as Money has
   * it: the duplicate is blocked and the existing line is offered instead.
   */
  const existingBudget = useMemo((): Budget | null => {
    if (!formData.categoryId) return null;
    return (
      budgets.find(
        (candidate: Budget) =>
          candidate.id !== budget?.id &&
          resolveCategoryId(candidate.categoryId) === formData.categoryId
      ) ?? null
    );
  }, [budgets, budget?.id, formData.categoryId, resolveCategoryId]);

  const existingBudgetName = existingBudget
    ? categories.find((c: Category) => c.id === formData.categoryId)?.name ?? 'That category'
    : '';

  const onFormSubmit = (e: React.FormEvent): void => {
    if (!formData.categoryId) {
      e.preventDefault();
      setCategoryError('Choose a category to budget against.');
      return;
    }
    if (existingBudget) {
      e.preventDefault();
      return;
    }
    if (formData.period === 'every' && !repeatOf('every', formData.repeatCount, formData.repeatUnit)) {
      e.preventDefault();
      setDatesError('Every how many? A whole number, one or more.');
      return;
    }
    if (formData.period === 'custom' && (!localDay(formData.startDate) || !localDay(formData.endDate))) {
      e.preventDefault();
      setDatesError('A one-off budget needs the day it starts and the day it ends.');
      return;
    }
    if (formData.period !== 'weekly' && formData.endDate && formData.endDate < formData.startDate) {
      e.preventDefault();
      setDatesError('Ends is before Starts.');
      return;
    }
    handleSubmit(e);
  };

  // Re-seeds on the RESOLVED id, not on `categories`: an unrelated category
  // refresh while the modal is open must not wipe what the user has typed.
  useEffect(() => {
    if (budget) {
      setFormData({
        categoryId: seededCategoryId,
        amount: budget.amount?.toString() || '',
        period: budget.period || 'monthly',
        startDate: seededStartDate,
        endDate: budget.endDate ?? '',
        repeatCount: budget.repeatCount ? String(budget.repeatCount) : '',
        repeatUnit: budget.repeatUnit ?? 'month',
        isActive: budget.isActive !== false
      });
    }
  }, [budget, setFormData, seededCategoryId, seededStartDate]);

  const choice = useMemo(
    () => describeChoice(
      formData.period,
      formData.startDate,
      formData.endDate,
      repeatOf(formData.period, formData.repeatCount, formData.repeatUnit)
    ),
    [formData.period, formData.startDate, formData.endDate, formData.repeatCount, formData.repeatUnit]
  );


  return (
    <Modal isOpen={isOpen} onClose={onClose} title={budget ? 'Edit Budget' : 'Add Budget'} size="md">
      <form onSubmit={onFormSubmit}>
        <ModalBody className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Category <span className="text-red-500" aria-label="required">*</span>
            </label>
            {/* The shared searchable picker every categorisation surface uses:
                grouped under its parent group, alphabetical inside. Budgets are
                spending limits, so it lists the expense tree. Groups are
                selectable here (and only here): budgeting "Food" as a whole is
                how most people plan, and the spending rolls its detail
                categories up. usePortal escapes the modal body's
                overflow-y-auto clipping. */}
            <CategorySelector
              selectedCategory={formData.categoryId}
              onCategoryChange={(categoryId) => {
                setCategoryError('');
                updateField('categoryId', categoryId);
              }}
              transactionType="expense"
              placeholder="Search or select category…"
              allowCreate={false}
              showHelperText={false}
              allowGroupSelection
              usePortal
            />
            {categoryError && (
              <p className="mt-1 text-sm text-red-600 dark:text-red-400" role="alert">
                {categoryError}
              </p>
            )}
            {existingBudget && (
              <div
                className="mt-1 text-sm text-red-600 dark:text-red-400 flex flex-wrap items-center gap-x-1"
                role="alert"
              >
                <span>{existingBudgetName} already has a budget.</span>
                {onEditExisting && (
                  <button
                    type="button"
                    onClick={() => onEditExisting(existingBudget)}
                    className="underline font-medium hover:no-underline"
                  >
                    Edit that budget instead
                  </button>
                )}
              </div>
            )}
          </div>

          <div>
            <label htmlFor="budget-amount" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Amount
            </label>
            <MoneyInput
              id="budget-amount"
              required
              value={formData.amount}
              onChange={(value) => updateField('amount', value)}
              className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300/50 dark:border-gray-600/50 rounded-xl focus:border-transparent dark:text-white"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Period
            </label>
            <select
              value={formData.period}
              onChange={(e) => {
                setDatesError('');
                updateField('period', toBudgetPeriod(e.target.value));
              }}
              className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300/50 dark:border-gray-600/50 rounded-xl focus:border-transparent dark:text-white"
            >
              {PERIOD_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            {/* EVERY… — the interval is the user's own (owner, 7 Nov 2026):
                "every 2 months", "every 6 weeks". A whole number and a unit;
                the cycles count from Starts. */}
            {formData.period === 'every' && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm text-gray-700 dark:text-gray-300">Every</span>
                {/* No native `min`: the browser's bubble would speak before the
                    form's own sentence, as with Ends. onFormSubmit is the guard. */}
                <input
                  id="budget-repeat-count"
                  type="number"
                  inputMode="numeric"
                  aria-label="Every how many"
                  value={formData.repeatCount}
                  onChange={(e) => {
                    setDatesError('');
                    updateField('repeatCount', e.target.value);
                  }}
                  className="w-20 px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300/50 dark:border-gray-600/50 rounded-xl focus:border-transparent dark:text-white"
                />
                <select
                  id="budget-repeat-unit"
                  aria-label="Weeks or months"
                  value={formData.repeatUnit}
                  onChange={(e) => updateField('repeatUnit', e.target.value === 'week' ? 'week' : 'month')}
                  className="px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300/50 dark:border-gray-600/50 rounded-xl focus:border-transparent dark:text-white"
                >
                  <option value="week">weeks</option>
                  <option value="month">months</option>
                </select>
              </div>
            )}
          </div>

          {/* STARTS — the day the cycles count from (owner, 5 Nov 2026). A
              yearly budget from 6 April is a tax year; a monthly one from the
              15th runs 15th to 14th. Weekly has no anchor, so no field. A
              one-off's Starts is simply its first day. */}
          {formData.period !== 'weekly' && (
            <div>
              <label htmlFor="budget-start" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Starts
              </label>
              <input
                id="budget-start"
                type="date"
                required
                value={formData.startDate}
                onChange={(e) => {
                  setDatesError('');
                  updateField('startDate', e.target.value);
                }}
                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300/50 dark:border-gray-600/50 rounded-xl focus:border-transparent dark:text-white"
              />
              {formData.period !== 'custom' && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {formData.period === 'monthly'
                    ? 'A budget from the 15th runs 15th to 14th.'
                    : formData.period === 'every'
                      ? 'The intervals count from this day.'
                      : 'A budget from 6 April runs with the tax year.'}
                </p>
              )}
            </div>
          )}

          {/* ENDS — the day the budget stops (owner, 5 Nov 2026: end dates and
              one-off budgets). Optional for a repeating period: blank means it
              keeps running, and every period honours a stated one (see
              utils/budgetPeriods). Required for a one-off, which is nothing
              but its two days. */}
          <div>
            <label htmlFor="budget-end" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Ends
            </label>
            {/* No native `required` or `min`: the browser's bubble would say
                "fill out this field" where the form can say what a one-off
                needs, and "must be on or after" where it can name the two
                fields. The checks in onFormSubmit are the whole guard. */}
            <input
              id="budget-end"
              type="date"
              value={formData.endDate}
              onChange={(e) => {
                setDatesError('');
                updateField('endDate', e.target.value);
              }}
              className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300/50 dark:border-gray-600/50 rounded-xl focus:border-transparent dark:text-white"
            />
            {datesError ? (
              <p className="mt-1 text-sm text-red-600 dark:text-red-400" role="alert">
                {datesError}
              </p>
            ) : (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {formData.period === 'custom'
                  ? 'A one-off budget runs once, from Starts to Ends, and is then finished.'
                  : 'Optional — leave blank to keep the budget running.'}
              </p>
            )}
          </div>

          {/* What the days add up to, said once the form can say it. */}
          {choice && (
            <p className="text-xs text-gray-700 dark:text-gray-200" data-testid="budget-choice">
              {choice}
            </p>
          )}

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="isActive"
              checked={formData.isActive}
              onChange={(e) => updateField('isActive', e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600"
            />
            <label htmlFor="isActive" className="text-sm text-gray-700 dark:text-gray-300">
              Budget is active
            </label>
          </div>
        </ModalBody>
        <ModalFooter>
          {errors?.submit && (
            <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-sm text-red-700 dark:text-red-300">{errors.submit}</p>
            </div>
          )}
          <div className="flex gap-3 w-full">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 justify-center px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            {/* Disabled while the chosen category already has a budget: a
                button that swallows the click and does nothing tells the user
                less than one that visibly cannot be pressed, with the reason
                sitting under the field. Disabled again while a save is in
                flight, so a second press on a slow connection cannot ask for
                the same budget twice. */}
            <button
              type="submit"
              disabled={existingBudget !== null || isSubmitting}
              title={existingBudget ? `${existingBudgetName} already has a budget` : undefined}
              className="flex-1 justify-center px-4 py-2 bg-[#1a2332] text-white rounded-lg hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {budget ? 'Save Changes' : 'Add Budget'}
            </button>
          </div>
        </ModalFooter>
      </form>
    </Modal>
  );
}
