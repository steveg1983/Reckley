import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../contexts/AppContextSupabase';
import { Modal, ModalBody, ModalFooter } from './common/Modal';
import MoneyInput from './common/MoneyInput';
import { useModalForm } from '../hooks/useModalForm';
import { parseMoneyInput } from '../utils/decimal';
import { getBudgetPeriodWindow, resolveBudgetAnchor } from '../utils/budgetPeriods';
import { describeBudgetWindow } from '../utils/budgetPace';
import CategorySelector from './CategorySelector';
import type { Budget, Category } from '../types';

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
  isActive: boolean;
}

/**
 * The periods this modal can create. Each one has a window the app derives on
 * its own (see utils/budgetPeriods); 'custom' is deliberately absent because
 * it needs start and end dates this form does not collect — offering it would
 * create budgets whose period is a guess.
 */
const PERIOD_OPTIONS: ReadonlyArray<{ value: Budget['period']; label: string }> = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' }
];

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
      isActive: budget?.isActive !== false
    },
    {
      onSubmit: async (data) => {
        const now = new Date();
        const budgetData = {
          categoryId: data.categoryId,
          amount: parseMoneyInput(data.amount) ?? 0,
          period: data.period,
          isActive: data.isActive,
          createdAt: budget?.createdAt || now,
          updatedAt: now,
          // A weekly budget has no anchor to write; every other period's
          // cycles count from this day.
          ...(data.period === 'weekly' ? {} : { startDate: data.startDate })
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
        isActive: budget.isActive !== false
      });
    }
  }, [budget, setFormData, seededCategoryId, seededStartDate]);

  /**
   * The first period the form's choices add up to — "1 Nov 2026 – 31 Oct
   * 2027" — so the reader sees the consequence of the start before saving.
   * No creation stamp is passed: the day typed here is chosen by definition.
   */
  const firstPeriod = useMemo((): string | null => {
    if (formData.period === 'weekly' || !/^\d{4}-\d{2}-\d{2}$/.test(formData.startDate)) return null;
    const [year, month1, day] = formData.startDate.split('-').map(Number);
    const window = getBudgetPeriodWindow(
      { period: formData.period, startDate: formData.startDate, createdAt: null },
      new Date(year, month1 - 1, day)
    );
    return describeBudgetWindow(window);
  }, [formData.period, formData.startDate]);


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
              onChange={(e) => updateField('period', toBudgetPeriod(e.target.value))}
              className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300/50 dark:border-gray-600/50 rounded-xl focus:border-transparent dark:text-white"
            >
              {PERIOD_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>

          {/* STARTS — the day the cycles count from (owner, 5 Nov 2026). A
              yearly budget from 6 April is a tax year; a monthly one from the
              15th runs 15th to 14th. Weekly has no anchor, so no field. */}
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
                onChange={(e) => updateField('startDate', e.target.value)}
                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300/50 dark:border-gray-600/50 rounded-xl focus:border-transparent dark:text-white"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {firstPeriod ? `First period: ${firstPeriod}. ` : ''}
                {formData.period === 'monthly'
                  ? 'A budget from the 15th runs 15th to 14th.'
                  : 'A budget from 6 April runs with the tax year.'}
              </p>
            </div>
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
