import React, { useEffect, useState } from 'react';
import { Modal, ModalBody, ModalFooter } from './common/Modal';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import { formatDate } from '../utils/dateFormatter';
import { formatCount } from '../utils/localeFormat';
import type { Transaction } from '../types';

/**
 * "NOT THESE" — the other half of a suggested category (owner, 15 Nov 2026).
 *
 * "We have a button for 'confirm these', but nothing, not to confirm ... a box
 * pops up with the transactions in question and it asks, which transactions
 * do you not confirm. You tick the ones, confirm, then they disappear from
 * the suggested list."
 *
 * A row the person says no to loses the app's guess: its category is cleared,
 * so it leaves the suggested list and joins the rows waiting to be filed at
 * the top of the page, where the right category is chosen. Nothing is
 * deleted and no amount changes. Starts with nothing ticked: saying no is the
 * deliberate act here.
 */
export default function RejectSuggestionsModal({
  label,
  rows,
  accountName,
  onClose,
  onReject,
}: {
  /** The suggested category's name, for the title. */
  label: string;
  rows: readonly Transaction[];
  accountName: (accountId: string) => string;
  onClose: () => void;
  /** Clears the suggestion on these rows; resolves when written. */
  onReject: (ids: string[]) => Promise<void>;
}): React.JSX.Element {
  const { formatCurrency } = useCurrencyDecimal();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // A row confirmed or corrected elsewhere while this is open drops out of the
  // list; its tick must drop with it.
  useEffect(() => {
    setTicked(previous => {
      const present = new Set(rows.map(row => row.id));
      const next = new Set([...previous].filter(id => present.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [rows]);

  const allTicked = rows.length > 0 && ticked.size === rows.length;
  const toggle = (id: string): void => {
    setTicked(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    if (ticked.size === 0) return;
    setSaving(true);
    try {
      await onReject([...ticked]);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={saving ? () => undefined : onClose} title={`Not ${label}`} size="lg">
      <ModalBody>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
          Tick the transactions that are <strong>not</strong> {label}. Their suggested category is
          taken off, so they move to the list to file at the top of the page, where you choose the
          right one. Nothing is deleted.
        </p>
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 mb-2 cursor-pointer">
          <input
            type="checkbox"
            checked={allTicked}
            disabled={saving}
            onChange={() => setTicked(allTicked ? new Set() : new Set(rows.map(row => row.id)))}
          />
          {allTicked ? 'Untick all' : `Tick all ${formatCount(rows.length)}`}
        </label>
        <ul className="divide-y divide-gray-100 dark:divide-gray-700 border-y border-gray-100 dark:border-gray-700">
          {rows.map(row => (
            <li key={row.id}>
              <label className="flex items-center gap-3 py-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ticked.has(row.id)}
                  disabled={saving}
                  onChange={() => toggle(row.id)}
                  aria-label={`${row.description}, ${formatDate(row.date)}`}
                />
                <span className="w-24 shrink-0 text-sm text-gray-500 dark:text-gray-400 tabular-nums">
                  {formatDate(row.date)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-gray-900 dark:text-white truncate">{row.description}</span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400 truncate">{accountName(row.accountId)}</span>
                </span>
                <span className="text-sm tabular-nums text-gray-900 dark:text-white whitespace-nowrap">
                  {formatCurrency(row.amount)}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </ModalBody>
      <ModalFooter>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving || ticked.size === 0}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white dark:bg-white dark:text-gray-900 disabled:opacity-50"
          >
            {saving
              ? 'Taking the suggestion off…'
              : ticked.size === 0
                ? 'Tick the ones that are wrong'
                : `Not ${label}: ${formatCount(ticked.size)}`}
          </button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
