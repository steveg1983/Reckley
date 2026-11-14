import { formatDate } from './dateFormatter';
import { formatCount } from './localeFormat';

/**
 * What a bank re-read did, in a sentence.
 *
 * The owner, 13 Nov 2026, asked for a re-read from a date he chooses. A
 * re-read that brings nothing new has still answered his question — "is
 * anything missing from there?" — so it says "nothing new" and does not fall
 * silent. The counts are the sync's own and add up to what the bank offered;
 * a part that is zero is left out.
 */
export interface RereadCounts {
  transactionsImported: number;
  /** Rows the bank offered that the ledger already held under a bank id. */
  alreadyHeld?: number;
  /** Rows the owner had entered or imported himself, now recognised as the bank's. */
  matchedToOwnRows?: number;
}

export function describeReread(fromDay: string, counts: RereadCounts): string {
  const parts: string[] = [];
  const added = counts.transactionsImported;
  parts.push(added === 0
    ? 'nothing new'
    : `${formatCount(added)} new ${added === 1 ? 'transaction' : 'transactions'} added`);
  const held = counts.alreadyHeld ?? 0;
  if (held > 0) parts.push(`${formatCount(held)} already in your ledger`);
  const own = counts.matchedToOwnRows ?? 0;
  if (own > 0) {
    parts.push(`${formatCount(own)} matched to ${own === 1 ? 'a row' : 'rows'} you had entered yourself`);
  }
  return `Re-read from ${formatDate(fromDay)}: ${parts.join(', ')}.`;
}
