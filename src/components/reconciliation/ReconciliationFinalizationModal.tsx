import React, { useState, useEffect } from 'react';
import { CheckCircleIcon, XIcon } from '../icons';
import CategorySelector from '../CategorySelector';
import MoneyInput from '../common/MoneyInput';
import DatePicker from '../common/DatePicker';
import { useCurrencyDecimal } from '../../hooks/useCurrencyDecimal';
import { parseMoneyInput, toDecimal } from '../../utils/decimal';
import { deriveAdjustment } from '../../utils/reconciliation';
import { useBackdropDismiss } from '../../hooks/useBackdropDismiss';
import { formatCount } from '../../utils/localeFormat';

interface ReconciliationFinalizationModalProps {
  isOpen: boolean;
  /**
   * The closing balance the user CONFIRMED — never a figure merely proposed by
   * a feed or an import.
   *
   * A number, not `number | null`, and that is the type doing the work: this
   * modal cannot be opened without one (the Finalize button is disabled until
   * the balance bar's Confirm has been pressed), so there is no "no bank
   * balance — finalize anyway" branch to get wrong. That escape hatch is
   * exactly how an account came to be marked reconciled against nothing.
   */
  confirmedBalance: number;
  clearedBalance: number;
  currency?: string;
  /** Rows this finalize would convert from marked to reconciled. */
  awaitingFinalizeCount: number;
  onClose: () => void;
  onFinalize: () => void;
  /**
   * True while the finalize write is in flight. A first-ever finalize can
   * convert thousands of rows and take real seconds server-side; a button
   * that sits silent through that reads as frozen and gets pressed again —
   * the owner pressed it "10-20 times" over 7,000 rows, stacking RPCs
   * behind the first one's locks. The button says what it is doing and
   * refuses seconds.
   */
  finalizing?: boolean;
  /**
   * Create a cleared adjustment transaction. Amount is SIGNED per the app-wide
   * convention (income positive, expense negative). The modal stays open —
   * the parent recomputes clearedBalance and the modal re-renders with the
   * remaining difference, so several partial adjustments can be created until
   * the difference reaches zero (the Microsoft Money model). Must return the
   * write's promise so the modal can hold its in-flight guard until it lands.
   */
  onCreateAdjustment: (data: {
    amount: number;
    type: 'income' | 'expense';
    description: string;
    category: string;
    date: Date;
  }) => Promise<void>;
}

/** "1 transaction" / "12 transactions" — the count and its noun, together. */
const transactionCount = (n: number): string =>
  `${formatCount(n)} transaction${n === 1 ? '' : 's'}`;

export default function ReconciliationFinalizationModal({
  isOpen,
  confirmedBalance,
  clearedBalance,
  currency,
  awaitingFinalizeCount,
  onClose,
  onFinalize,
  finalizing = false,
  onCreateAdjustment,
}: ReconciliationFinalizationModalProps): React.JSX.Element | null {
  // Press AND release must both be on the backdrop — see useBackdropDismiss.
  const backdropDismiss = useBackdropDismiss(onClose);


  const { formatCurrency } = useCurrencyDecimal();

  const difference = toDecimal(confirmedBalance).minus(toDecimal(clearedBalance)).toNumber();
  const isBalanced = Math.abs(difference) < 0.005;

  const [adjustmentAmount, setAdjustmentAmount] = useState('');
  // "Account Adjustment" is the exact payee Microsoft Money used for these.
  const [adjustmentDescription, setAdjustmentDescription] = useState('Account Adjustment');
  const [adjustmentCategory, setAdjustmentCategory] = useState('');
  const [adjustmentDate, setAdjustmentDate] = useState(
    new Date().toISOString().split('T')[0]
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  // While the user is editing the amount, a background clearedBalance change
  // (e.g. a toggle RPC resolving) must not clobber what they typed.
  const [amountDirty, setAmountDirty] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setAmountDirty(false);
    }
  }, [isOpen]);

  // Pre-fill (and re-sync after each created adjustment) with the remaining
  // difference, so the default action always zeroes the account in one step.
  useEffect(() => {
    if (isOpen && !amountDirty) {
      setAdjustmentAmount(Math.abs(difference).toFixed(2));
    }
  }, [isOpen, difference, amountDirty]);

  if (!isOpen) return null;

  const parsedAmount = parseMoneyInput(adjustmentAmount);
  const { type: adjustmentType, signedAmount } = deriveAdjustment(difference, parsedAmount ?? null);
  const amountValid = signedAmount != null && Math.abs(signedAmount) > 0;

  const handleCreateAdjustment = async () => {
    if (isSubmitting || !amountValid || signedAmount == null || !adjustmentCategory || !adjustmentDescription.trim()) {
      return;
    }

    // In-flight guard: without it a double-click would write two identical
    // adjustment transactions before the first RPC resolves.
    setIsSubmitting(true);
    try {
      await onCreateAdjustment({
        amount: signedAmount,
        type: adjustmentType,
        description: adjustmentDescription.trim(),
        category: adjustmentCategory,
        date: new Date(adjustmentDate),
      });
      // Success: let the amount field re-sync to the new remaining difference.
      setAmountDirty(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          {...backdropDismiss}>
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-md w-full p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">
            Finalise Reconciliation
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label="Close"
          >
            <XIcon size={20} />
          </button>
        </div>

        {isBalanced ? (
          /* Balanced — success */
          <div className="text-center py-6">
            {/* The tick keeps a colour, the heading does not (Design, 28 Aug §5,
                third pile). A success tick is the app's settled answer for "this
                worked" — the green the OFX import already uses — while a heading
                in link blue was a stock hue standing in for emphasis the weight
                already supplies. */}
            <CheckCircleIcon size={48} className="mx-auto text-green-700 dark:text-green-400 mb-3" />
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
              Account Balanced!
            </h3>
            {/* Says what pressing this DOES, in rows, because that is the part
                the old flow left invisible: the marks become reconciled, and
                the statement they were checked against is written down. */}
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              {awaitingFinalizeCount > 0
                ? `Reconciles ${transactionCount(awaitingFinalizeCount)} against ${formatCurrency(confirmedBalance, currency)}.`
                : `Nothing is left to reconcile. This records ${formatCurrency(confirmedBalance, currency)} as the balance the account was last reconciled to.`}
            </p>
            <button
              onClick={onFinalize}
              disabled={finalizing}
              aria-busy={finalizing}
              className="px-6 py-2 bg-primary-action text-on-primary-action rounded-lg hover:bg-primary-action-hover transition-colors font-medium disabled:opacity-60 disabled:cursor-wait"
            >
              {finalizing ? 'Completing…' : 'Complete Reconciliation'}
            </button>
          </div>
        ) : (
          /* Unbalanced — create adjustment(s) until the difference is zero */
          <div>
            <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4 mb-4">
              {/* Named exactly as the balance bar names it — the figure the
                  user confirmed there is the figure being subtracted here. */}
              <p className="text-sm text-red-600 dark:text-red-400 mb-1">
                Difference between closing balance and cleared balance:
              </p>
              <p className="text-2xl font-bold text-red-600 dark:text-red-400">
                {formatCurrency(difference, currency)}
              </p>
              <div className="mt-2 text-xs text-red-500 dark:text-red-400 space-y-1">
                <p>Closing Balance: {formatCurrency(confirmedBalance, currency)}</p>
                <p>Cleared Balance: {formatCurrency(clearedBalance, currency)}</p>
              </div>
            </div>

            <div className="space-y-3 mb-6">
              <div>
                <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                  Create Adjustment Transaction
                </h4>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  Creates a marked {adjustmentType} that reduces the difference. You can
                  create more than one adjustment until the difference reaches zero.
                </p>
              </div>

              {/* Amount (editable, pre-filled with remaining difference) */}
              <div>
                <label htmlFor="adjustment-amount" className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
                  Amount ({adjustmentType === 'income' ? 'Income' : 'Expense'})
                </label>
                <MoneyInput
                  id="adjustment-amount"
                  value={adjustmentAmount}
                  onChange={(value) => {
                    setAmountDirty(true);
                    setAdjustmentAmount(value);
                  }}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 dark:text-white"
                />
                {!amountValid && adjustmentAmount.trim() !== '' && (
                  <p className="text-xs text-red-500 mt-1">Enter an amount greater than zero.</p>
                )}
              </div>

              {/* Description */}
              <div>
                <label htmlFor="adjustment-description" className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
                  Description
                </label>
                <input
                  id="adjustment-description"
                  type="text"
                  value={adjustmentDescription}
                  onChange={(e) => setAdjustmentDescription(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 dark:text-white"
                />
              </div>

              {/* Category */}
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
                  Category
                </label>
                <CategorySelector
                  selectedCategory={adjustmentCategory}
                  onCategoryChange={setAdjustmentCategory}
                  transactionType={adjustmentType}
                  placeholder="Select category..."
                  allowCreate={false}
                />
              </div>

              {/* Date */}
              <div>
                <label htmlFor="adjustment-date" className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
                  Date
                </label>
                {/* dd/mm/yyyy everywhere — a native date input renders in the
                    browser's locale, not the app's. */}
                <DatePicker
                  id="adjustment-date"
                  value={adjustmentDate}
                  onChange={setAdjustmentDate}
                  className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 dark:text-white"
                />
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 justify-center px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Go Back
              </button>
              <button
                onClick={() => void handleCreateAdjustment()}
                disabled={isSubmitting || !amountValid || !adjustmentCategory || !adjustmentDescription.trim()}
                className="flex-1 justify-center px-4 py-2 bg-[#1a2332] text-white rounded-lg hover:bg-secondary transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? 'Creating…' : 'Create Adjustment'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
