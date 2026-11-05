/**
 * A ledger in memory, behind the connector's port — what the server specs
 * drive the real MCP client against. Every figure invented (public repo).
 *
 * The write side mirrors the verbs' own refusals and review rules in a few
 * lines each — the sentences the migrations raise, the provenance rule of
 * update_transaction_atomic, the "marking a filed row ends review" rule of
 * set_transactions_cleared — so the tools' wording and sequencing are proved
 * here; the rules themselves are proved against the database by the app's
 * own suites. Every port instance works on its own copy of the rows.
 */

import type { Budget, Category, Transaction, TransactionSplit } from '../../../types';
import { isAwaitingReview, isUnfiled } from '../../../utils/transactionReview';
import {
  PortRefusal,
  type PortAccount,
  type ReckleyPort,
  type TransactionFilter,
} from '../../../../api/_lib/mcp/port';

export const accounts: PortAccount[] = [
  // Each balance is opening + every row below (the register's identity), so
  // the net-worth walk can start from it: the current account's rows sum to
  // 1257.50, hence an opening of −22.94 for a balance of 1234.56.
  { id: 'acc-current', name: 'Current Account', type: 'checking', currency: 'GBP', isActive: true, institution: 'Example Bank', balance: 1234.56, openingBalance: -22.94, openingBalanceDate: '2026-01-01', bankBalance: 1230.00, bankBalanceDate: '2026-10-14', lastReconciledDate: '2026-09-30' },
  { id: 'acc-savings', name: 'Savings', type: 'savings', currency: 'GBP', isActive: true, institution: null, balance: 5000, openingBalance: 5000, openingBalanceDate: null, bankBalance: null, bankBalanceDate: null, lastReconciledDate: null },
  { id: 'acc-old', name: 'Old Card', type: 'credit', currency: 'GBP', isActive: false, institution: null, balance: 0, openingBalance: 0, openingBalanceDate: null, bankBalance: null, bankBalanceDate: null, lastReconciledDate: null },
];

export const categories: Category[] = [
  { id: 'type-expense', name: 'Expenses', type: 'expense', level: 'type' },
  { id: 'sub-bills', name: 'Bills (Household)', type: 'expense', level: 'sub', parentId: 'type-expense' },
  { id: 'det-phone', name: 'Telephone', type: 'expense', level: 'detail', parentId: 'sub-bills' },
  { id: 'sub-food', name: 'Food', type: 'expense', level: 'sub', parentId: 'type-expense' },
  { id: 'det-groceries', name: 'Groceries', type: 'expense', level: 'detail', parentId: 'sub-food' },
  { id: 'det-fuel', name: 'Fuel', type: 'expense', level: 'detail', parentId: 'type-expense' },
  { id: 'type-income', name: 'Income', type: 'income', level: 'type' },
  { id: 'det-salary', name: 'Salary', type: 'income', level: 'detail', parentId: 'type-income' },
  { id: 'type-transfer', name: 'Transfer', type: 'both', level: 'type' },
  { id: 'tofrom-savings', name: 'To/From Savings', type: 'both', level: 'sub', parentId: 'type-transfer', isTransferCategory: true, accountId: 'acc-savings' },
  { id: 'det-retired', name: 'Old Hobby', type: 'expense', level: 'detail', parentId: 'type-expense', isActive: false },
];

const row = (over: Partial<Transaction> & { id: string; date: string; amount: number }): Transaction => ({
  description: 'A row',
  accountId: 'acc-current',
  type: over.amount < 0 ? 'expense' : 'income',
  category: 'det-groceries',
  cleared: false,
  categoryConfirmed: true,
  ...over,
  date: new Date(`${over.date}T00:00:00.000Z`),
} as Transaction);

export const transactions: Transaction[] = [
  row({ id: 't1', date: '2026-10-01', amount: -45, description: 'NORTHGATE MARKET', cleared: true }),
  row({ id: 't2', date: '2026-10-03', amount: -30, description: 'Direct Debit - SKYLINE TELECOM', category: 'det-phone', categoryConfirmed: false, needsReview: true }),
  row({ id: 't3', date: '2026-10-05', amount: 2000, description: 'ACME LTD SALARY', category: 'det-salary' }),
  row({ id: 't4', date: '2026-10-06', amount: -500, description: 'Transfer to Savings', type: 'transfer', category: 'tofrom-savings', transferAccountId: 'acc-savings', linkedTransferId: 't4b' }),
  row({ id: 't5', date: '2026-10-08', amount: 12.5, description: 'NORTHGATE MARKET REFUND', type: 'income' }),
  row({ id: 't6', date: '2026-10-09', amount: -20, description: 'CASH MACHINE', category: '' }),
  row({ id: 't7', date: '2026-09-28', amount: -60, description: 'NORTHGATE MARKET', cleared: true }),
  row({ id: 't8', date: '2026-10-10', amount: -100, description: 'BIG SHOP', category: '', isSplit: true, notes: 'split at the till' }),
];

export const splits: TransactionSplit[] = [
  { id: 's1', transactionId: 't8', category: 'det-groceries', amount: -70, sortOrder: 0 },
  { id: 's2', transactionId: 't8', category: 'det-fuel', amount: -30, sortOrder: 1 },
];

export const budgets: Budget[] = [
  { id: 'b-groceries', name: 'Groceries', categoryId: 'det-groceries', amount: 150, period: 'monthly', isActive: true, createdAt: new Date(2026, 0, 1), updatedAt: new Date(2026, 0, 1), spent: 0 },
  { id: 'b-paused', name: 'Paused', categoryId: 'det-fuel', amount: 50, period: 'monthly', isActive: false, createdAt: new Date(2026, 0, 1), updatedAt: new Date(2026, 0, 1), spent: 0 },
  // A one-off that ran in June and is over: active, but not running today.
  { id: 'b-done', name: 'June trip', categoryId: 'det-fuel', amount: 40, period: 'custom', isActive: true, startDate: '2026-06-01', endDate: '2026-06-30', createdAt: new Date(2026, 5, 1), updatedAt: new Date(2026, 5, 1), spent: 0 },
];

const dayOf = (date: Date | string): string => new Date(date).toISOString().slice(0, 10);

/** Newest-first over ISO days and ids: a code-point order, no locale involved. */
const byCodePoint = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

function matches(t: Transaction, filter: TransactionFilter): boolean {
  if (filter.text && !t.description.toLowerCase().includes(filter.text.toLowerCase())) return false;
  if (filter.accountId && t.accountId !== filter.accountId) return false;
  if (filter.categoryId && t.category !== filter.categoryId) return false;
  if (filter.from && dayOf(t.date) < filter.from) return false;
  if (filter.to && dayOf(t.date) > filter.to) return false;
  if (filter.minAmount !== undefined && t.amount < filter.minAmount) return false;
  if (filter.maxAmount !== undefined && t.amount > filter.maxAmount) return false;
  if (filter.cleared !== undefined && (t.cleared === true) !== filter.cleared) return false;
  if (filter.review === 'awaiting' && !isAwaitingReview(t)) return false;
  if (filter.review === 'done' && isAwaitingReview(t)) return false;
  return true;
}

export function fakePort(over: Partial<{ accounts: PortAccount[]; transactions: Transaction[]; splits: TransactionSplit[]; budgets: Budget[] }> = {}): ReckleyPort {
  const rows = (over.transactions ?? transactions).map(t => ({ ...t }));
  const lines = over.splits ?? splits;
  const plans = over.budgets ?? budgets;
  const ledgers = over.accounts ?? accounts;
  let created = 0;

  const rowOrRefuse = (id: string): Transaction => {
    const found = rows.find(t => t.id === id);
    if (!found) throw new PortRefusal('That transaction is not in this ledger. Nothing was changed.');
    return found;
  };
  /** The other account's To/From category, as transfer_category_for finds it. */
  const transferCategoryFor = (otherAccountId: string): string =>
    categories.find(c => c.isTransferCategory && c.accountId === otherAccountId)?.id ?? '';

  return {
    async listAccounts() { return ledgers; },
    async searchTransactions(filter, page) {
      const all = rows
        .filter(t => matches(t, filter))
        .sort((a, b) => byCodePoint(dayOf(b.date), dayOf(a.date)) || byCodePoint(b.id, a.id));
      if (page.oldestFirst) all.reverse();
      return { rows: all.slice(page.offset, page.offset + page.limit), total: all.length };
    },
    async getTransaction(id) {
      const transaction = rows.find(t => t.id === id);
      if (!transaction) return null;
      return { transaction, splits: lines.filter(line => line.transactionId === id) };
    },
    async listCategories() { return categories; },
    async listBudgets() { return plans; },
    async firstActivityDates() {
      const first = new Map<string, string>();
      for (const t of rows) {
        const day = dayOf(t.date);
        const known = first.get(t.accountId);
        if (known === undefined || day < known) first.set(t.accountId, day);
      }
      return first;
    },
    async transactionsBetween(from, to, cap) {
      const inRange = rows.filter(t => dayOf(t.date) >= from && dayOf(t.date) <= to);
      const capped = inRange.length > cap;
      const kept = capped ? inRange.slice(0, cap) : inRange;
      const ids = new Set(kept.filter(t => t.isSplit).map(t => t.id));
      return { rows: kept, splits: lines.filter(line => ids.has(line.transactionId)), capped };
    },
    async reviewQueue(cap) {
      const waiting = rows.filter(t => isAwaitingReview(t)).sort((a, b) => byCodePoint(dayOf(a.date), dayOf(b.date)));
      return { rows: waiting.slice(0, cap), capped: waiting.length > cap };
    },

    async transactionsById(ids) {
      const wanted = new Set(ids);
      return rows.filter(t => wanted.has(t.id)).map(t => ({ ...t }));
    },

    async updateTransaction(id, patch) {
      const t = rowOrRefuse(id);
      if (patch.description !== undefined) t.description = patch.description;
      if (patch.notes !== undefined) t.notes = patch.notes === '' ? undefined : patch.notes;
      if (patch.category !== undefined) {
        // update_transaction_atomic's provenance rule: a changed category is
        // a confirmed one unless the caller says otherwise.
        if (patch.categoryConfirmed === undefined && patch.category !== t.category) t.categoryConfirmed = true;
        t.category = patch.category;
      }
      if (patch.categoryConfirmed !== undefined) t.categoryConfirmed = patch.categoryConfirmed;
      if (patch.needsReview !== undefined) t.needsReview = patch.needsReview;
      return { ...t };
    },

    async confirmCategories(ids) {
      let count = 0;
      for (const id of ids) {
        const t = rows.find(r => r.id === id);
        if (!t || t.categoryConfirmed !== false || !t.category || t.category.trim() === '') continue;
        t.categoryConfirmed = true;
        t.needsReview = false;
        count += 1;
      }
      return count;
    },

    async setCleared(ids, cleared) {
      let count = 0;
      for (const id of ids) {
        const t = rows.find(r => r.id === id);
        if (!t || (t.cleared === true) === cleared) continue;
        t.cleared = cleared;
        if (cleared && !isUnfiled(t)) t.needsReview = false;
        count += 1;
      }
      return count;
    },

    async linkTransfer(idA, idB) {
      if (idA === idB) throw new PortRefusal('a transaction cannot be linked to itself. Nothing was changed.');
      const a = rowOrRefuse(idA);
      const b = rowOrRefuse(idB);
      if (a.accountId === b.accountId) throw new PortRefusal('a transfer needs two different accounts. Nothing was changed.');
      if (a.amount === 0 || a.amount !== -b.amount) {
        throw new PortRefusal(`transfer sides must have exactly opposite non-zero amounts (${a.amount} vs ${b.amount}). Nothing was changed.`);
      }
      if (a.isSplit || b.isSplit) throw new PortRefusal('a split transaction cannot become a transfer — remove the split first. Nothing was changed.');
      if (a.linkedTransferId || b.linkedTransferId) throw new PortRefusal('transaction is already part of a linked transfer. Nothing was changed.');
      Object.assign(a, { type: 'transfer', category: transferCategoryFor(b.accountId), transferAccountId: b.accountId, linkedTransferId: b.id });
      Object.assign(b, { type: 'transfer', category: transferCategoryFor(a.accountId), transferAccountId: a.accountId, linkedTransferId: a.id });
      return { a: { ...a }, b: { ...b } };
    },

    async createTransferCounterpart(id, targetAccountId) {
      const src = rowOrRefuse(id);
      if (src.amount === 0) throw new PortRefusal('a zero-amount transaction cannot become a transfer. Nothing was changed.');
      if (src.isSplit) throw new PortRefusal('a split transaction cannot become a transfer — remove the split first. Nothing was changed.');
      if (src.linkedTransferId) throw new PortRefusal('transaction is already part of a linked transfer. Nothing was changed.');
      if (src.accountId === targetAccountId) throw new PortRefusal('a transfer needs two different accounts. Nothing was changed.');
      if (!ledgers.some(l => l.id === targetAccountId)) throw new PortRefusal('That account is not in this ledger. Nothing was changed.');
      const counterpart: Transaction = {
        ...src,
        id: `${src.id}-other-side`,
        accountId: targetAccountId,
        amount: -src.amount,
        type: 'transfer',
        category: transferCategoryFor(src.accountId),
        transferAccountId: src.accountId,
        linkedTransferId: src.id,
        cleared: false,
        needsReview: false,
        categoryConfirmed: true,
      };
      rows.push(counterpart);
      Object.assign(src, { type: 'transfer', category: transferCategoryFor(targetAccountId), transferAccountId: targetAccountId, linkedTransferId: counterpart.id });
      return { source: { ...src }, counterpart: { ...counterpart } };
    },

    async createTransaction(input) {
      if (!ledgers.some(l => l.id === input.accountId)) throw new PortRefusal('That account is not in this ledger. Nothing was changed.');
      created += 1;
      const t = row({
        id: `new-${created}`,
        date: input.date,
        amount: input.amount,
        description: input.description,
        accountId: input.accountId,
        type: input.type,
        category: input.category ?? '',
        notes: input.notes,
        categoryConfirmed: input.categoryConfirmed,
        needsReview: input.needsReview,
      });
      rows.push(t);
      return { ...t };
    },
  };
}
