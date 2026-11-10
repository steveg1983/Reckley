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
 * On the reconcile screen it is also handed the DIFFERENCE, and says how much
 * of it these rows would account for — the sentence the screen was missing
 * when a card's balance ran ahead of its posted transactions.
 */
export interface PendingAtBankListProps {
  pending: PendingAtBank;
  currency?: string;
  /**
   * The reconcile screen's difference (the bank's closing balance less the
   * cleared balance), when there is one to explain. Omitted in the register.
   */
  difference?: number | null;
}

/** A penny's tolerance: both figures are 2dp, compared in Decimal. */
const samePence = (a: number, b: number): boolean => toDecimal(a).minus(toDecimal(b)).abs().lessThan(0.005);

export default function PendingAtBankList({ pending, currency, difference }: PendingAtBankListProps): React.JSX.Element | null {
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

      {/* Capped and scrolling: a card with thirty authorisations outstanding
          must not push the register's own rows off the screen. */}
      <ul className="mt-2 max-h-48 overflow-y-auto text-sm text-gray-400 dark:text-gray-500 italic">
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

      {hasDifference && (
        <p role="status" className="mt-2 px-3 text-xs text-gray-700 dark:text-gray-300">
          {explainsAll
            ? 'These pending items account for the whole difference. Nothing is missing from your ledger: the difference closes when the bank posts them.'
            : `If the bank’s balance already includes these, they account for ${formatCurrency(pending.total, currency)} of the difference.`}
        </p>
      )}
    </section>
  );
}
