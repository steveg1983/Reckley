// Runs inside Vercel's node ESM runtime as well as the browser: every relative
// import here must carry .js (see bankBalanceSnapshot.ts).
import Decimal from 'decimal.js';

/**
 * What a bank says is PENDING on an account — authorised, not yet posted.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The feed imports POSTED transactions only. A card issuer's balance can run
 * ahead of them: a refund the issuer has already taken off what is owed, a
 * purchase authorised this morning. The reconcile screen proposes the bank's
 * balance as the closing balance, so on such a card "mark all" leaves a
 * difference nobody can find a transaction for — the owner, 10 Nov 2026, on
 * two American Express cards: "the 'manual' closing balance has a random
 * difference figure in there". It was the bank's own figure, and the
 * difference on one card was, to the penny, a purchase that had been returned.
 *
 * The pending items are the missing half of that sentence, so the sync reads
 * them and the register and the reconcile screen SHOW them — faded, beneath a
 * rule, after the last real transaction (the owner, the same day: "a
 * theoretical future value"). They are NEVER imported as transactions: a
 * pending row can change amount, or vanish, before it posts, and nothing in
 * the ledger, a balance or a report may count one.
 *
 * Same invariant as a balance snapshot: a figure the bank did not give is
 * 'unavailable', never a zero. "No pending items" and "this issuer does not
 * say" are different facts and only the first may be shown as one.
 */
export interface PendingItem {
  /** The day the bank dates it, YYYY-MM-DD, or null when it gave none. */
  date: string | null;
  description: string;
  /** In the APP's sign: a purchase is negative, a refund positive. */
  amount: number;
}

export type PendingAtBankSnapshot =
  | { readonly status: 'reported'; readonly items: readonly PendingItem[] }
  | { readonly status: 'unavailable' };

export const PENDING_UNAVAILABLE: PendingAtBankSnapshot = { status: 'unavailable' };

/**
 * More than this and the list is cut. A card with hundreds of authorisations
 * outstanding is not one a person reads row by row, and the column is one
 * JSON document per account.
 */
export const MAX_PENDING_ITEMS = 200;

const DESCRIPTION_MAX = 140;

const isoDay = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : null;
};

const describe = (row: { description?: unknown; merchant_name?: unknown }): string => {
  const text = [row.description, row.merchant_name].find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== ''
  );
  return (text ?? 'Pending transaction').trim().slice(0, DESCRIPTION_MAX);
};

/**
 * A feed's pending rows → the items to keep, in the APP's sign.
 *
 * A card feed states amounts the other way round (positive = money out of the
 * card), which is what `cardSigned` says of the rows handed in. A row whose
 * amount is not a finite number is dropped: it is not a figure, and guessing
 * one would put an invented number beside real money.
 */
export const pendingFromFeed = (
  rows: ReadonlyArray<{ amount?: unknown; description?: unknown; merchant_name?: unknown; timestamp?: unknown }>,
  options: { cardSigned: boolean }
): PendingAtBankSnapshot => {
  const items: PendingItem[] = [];
  for (const row of rows) {
    if (typeof row.amount !== 'number' || !Number.isFinite(row.amount)) continue;
    const signed = options.cardSigned ? new Decimal(row.amount).negated() : new Decimal(row.amount);
    items.push({
      date: isoDay(row.timestamp),
      description: describe(row),
      // plus(0) normalises a negative zero, as cardAmountToAppSigned does.
      amount: signed.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).plus(0).toNumber(),
    });
    if (items.length >= MAX_PENDING_ITEMS) break;
  }
  return { status: 'reported', items };
};

/** The sum of the items, in Decimal — never a float fold over money. */
export const pendingTotal = (items: ReadonlyArray<Pick<PendingItem, 'amount'>>): number =>
  items
    .reduce((sum, item) => sum.plus(item.amount), new Decimal(0))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .plus(0)
    .toNumber();

/** What the link row stores: two columns that are both set or both null. */
export interface PendingAtBankColumns {
  pending_items: PendingItem[] | null;
  pending_as_of: string | null;
}

/**
 * The columns to write for this reading. An unavailable reading CLEARS them:
 * yesterday's pending items beside today's balance would explain a difference
 * with rows that no longer describe it.
 */
export const pendingColumns = (snapshot: PendingAtBankSnapshot, asOfIso: string): PendingAtBankColumns =>
  snapshot.status === 'reported'
    ? { pending_items: [...snapshot.items], pending_as_of: asOfIso }
    : { pending_items: null, pending_as_of: null };

/** What the client is told about one account, read back from those columns. */
export interface PendingAtBank {
  items: PendingItem[];
  /** The items' sum, app-signed. */
  total: number;
  /** ISO timestamp of the sync that read them. */
  asOf: string;
}

const asItem = (value: unknown): PendingItem | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { date, description, amount } = value as { date?: unknown; description?: unknown; amount?: unknown };
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  if (typeof description !== 'string') return null;
  return { date: isoDay(date), description, amount };
};

/**
 * A stored row → what the client may be told, or null. Nothing is told unless
 * the reading is dated and holds at least one well-formed item: "nothing
 * pending" is a true statement but not one that explains anything, and a
 * document this code did not write is not shown as money.
 */
export const pendingFromColumns = (row: { pending_items?: unknown; pending_as_of?: unknown }): PendingAtBank | null => {
  if (typeof row.pending_as_of !== 'string' || row.pending_as_of === '') return null;
  if (!Array.isArray(row.pending_items)) return null;
  const items = row.pending_items.map(asItem).filter((item): item is PendingItem => item !== null);
  if (items.length === 0) return null;
  return { items, total: pendingTotal(items), asOf: row.pending_as_of };
};
