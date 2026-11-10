import React from 'react';
import { useCurrencyDecimal } from '../../hooks/useCurrencyDecimal';
import { formatDate } from '../../utils/dateFormatter';
import { toDecimal } from '../../utils/decimal';
import type { PendingAtBank } from '../../services/banking/pendingAtBank';

/**
 * What the bank says is pending, drawn after the last real transaction.
 *
 * The owner, 10 Nov 2026: "put them on the transaction list of the account
 * but in a faded font at the bottom with an 'underline' between the last
 * proper transaction and the pending ones to show its a 'theoretical future
 * value'… similar for the reconciliation page. We can show the pending
 * transactions which explains the difference in the closing balances."
 *
 * So: a rule, then the rows, faded. Three things follow from "theoretical":
 *
 *  - They are NOT transactions. Nothing here can be clicked, marked, filed or
 *    edited, and no balance on either screen counts them. A pending row can
 *    change amount, or vanish, before the bank posts it.
 *  - No colour. An amount in the register is red or green because it is money
 *    that moved; these have not, and colour marks what needs attention.
 *  - The caption says what they are and where they came from, because a grey
 *    row with no explanation reads as a row that failed to load.
 *
 * On the reconcile screen it is also handed the bank's balance and the
 * DIFFERENCE, and sets out two figures beneath the rows: what the bank
 * reports now, and where that lands once these post (the owner, 10 Nov: "so
 * the user can see what the card issuer is showing as the current account
 * balance, but also… excluding the pending transactions").
 *
 * WHAT IT NO LONGER SAYS. The first version added "If the bank's balance
 * already includes these, they account for £x of the difference". On the
 * day it shipped the owner's American Express cards showed that issuer's
 * balance is processed charges ONLY — a pending purchase larger than the
 * whole balance sat beside it — so the sentence invited a comparison that
 * was false, and he made it. (The real cause of that difference was a
 * re-link snap, see planLinkBalanceSnap.) Only the exact case is still
 * claimed: pending equal to the difference to the penny, which is what an
 * issuer that DOES count pending produces.
 */
export interface PendingAtBankListProps {
  pending: PendingAtBank;
  currency?: string;
  /**
   * The reconcile screen's difference (the bank's closing balance less the
   * cleared balance), when there is one to explain. Omitted in the register.
   */
  difference?: number | null;
  /**
   * The bank's own reported balance, on the reconcile screen — the figure the
   * two-line statement under the rows starts from. Omitted in the register.
   */
  bankBalance?: number | null;
}

/** A penny's tolerance: both figures are 2dp, compared in Decimal. */
const samePence = (a: number, b: number): boolean => toDecimal(a).minus(toDecimal(b)).abs().lessThan(0.005);

export default function PendingAtBankList({ pending, currency, difference, bankBalance }: PendingAtBankListProps): React.JSX.Element | null {
  const { formatCurrency } = useCurrencyDecimal();
  if (pending.items.length === 0) return null;

  const count = pending.items.length;
  const hasDifference = difference != null && !samePence(difference, 0);
  const explainsAll = hasDifference && samePence(difference, pending.total);

  return (
    <section
      aria-label="Pending at the bank"
      data-testid="pending-at-bank"
      // The "underline": one rule between the ledger and what is not in it yet.
      className="mt-3 pt-3 border-t-2 border-dashed border-gray-300 dark:border-gray-600"
    >
      <p className="px-3 text-xs text-gray-500 dark:text-gray-400">
        <span className="font-semibold text-gray-600 dark:text-gray-300">Pending at the bank</span>
        {' · '}
        {count === 1 ? '1 item' : `${count} items`} the bank has authorised but not yet posted, as of{' '}
        {formatDate(new Date(pending.asOf))}. Not in your ledger and not counted in any balance here. They appear
        as transactions when the bank posts them, and the amounts can change before then.
      </p>

      {/* Every row, no cap. A capped list said "7 items" and drew six, the
          seventh under a scroll nobody could see was there (10 Nov 2026). */}
      <ul className="mt-2 text-sm text-gray-400 dark:text-gray-500 italic">
        {pending.items.map((item, index) => (
          <li
            // Pending rows carry no id of their own; position in one reading is
            // the only identity they have.
            key={`${item.date ?? 'undated'}-${index}`}
            className="flex items-baseline gap-3 px-3 py-1.5"
          >
            <span className="w-24 shrink-0 tabular-nums">{item.date ? formatDate(new Date(`${item.date}T00:00:00`)) : '—'}</span>
            <span className="flex-1 min-w-0 truncate">{item.description}</span>
            <span className="shrink-0 tabular-nums">{formatCurrency(item.amount, currency)}</span>
          </li>
        ))}
      </ul>

      <p className="mt-1 px-3 flex items-baseline justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>Pending total</span>
        <span className="tabular-nums font-semibold">{formatCurrency(pending.total, currency)}</span>
      </p>

      {/* Where the bank's figure is heading. Two facts and no inference:
          whether an issuer's balance counts pending differs by issuer, so the
          first line is only what it reported and the second only arithmetic. */}
      {bankBalance != null && (
        <dl className="mt-2 px-3 text-xs text-gray-500 dark:text-gray-400">
          <div className="flex items-baseline justify-between py-0.5">
            <dt>The bank’s reported balance</dt>
            <dd className="tabular-nums">{formatCurrency(bankBalance, currency)}</dd>
          </div>
          <div className="flex items-baseline justify-between py-0.5">
            <dt>If these post as shown</dt>
            <dd className="tabular-nums">
              {formatCurrency(toDecimal(bankBalance).plus(toDecimal(pending.total)).toNumber(), currency)}
            </dd>
          </div>
        </dl>
      )}

      {explainsAll && (
        <p role="status" className="mt-2 px-3 text-xs text-gray-700 dark:text-gray-300">
          These pending items account for the whole difference. Nothing is missing from your ledger: the
          difference closes when the bank posts them.
        </p>
      )}
    </section>
  );
}
