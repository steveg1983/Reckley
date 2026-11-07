import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LOCAL_BACKUP_BINDINGS,
  LOCAL_BACKUP_STORAGE_KEYS,
  LOCAL_WIPE_CONFIRMATION,
  LocalRestoreRefusedError,
  collectLocalBackupBundle,
  localFinancialDataIsEmpty,
  restoreLocalBackupBundle,
  wipeLocalFinancialData,
  type LocalBackupStore,
} from './localBackupService';
import {
  BACKUP_ENTITIES,
  BACKUP_FORMAT,
  MAX_EXACT_MONEY,
  validateBackupBundle,
  type BackupBundle,
} from './backupService';
import { storageAdapter, STORAGE_KEYS } from './storageAdapter';
import { canonicalSubjectKey } from '../utils/suggestionDismissals';
import { toDecimal } from '../utils/decimal';
import { PreferencesService } from './preferencesService';

/**
 * These run against the REAL storage stack — storageAdapter → encryptedStorage
 * → IndexedDB (fake-indexeddb) — not a stand-in for it. The bug this feature
 * had to fix was precisely a mismatch between the layer that was written and
 * the layer that is read, so a test that mocked storage would have passed
 * against the broken code too. That is what the deleted wipeLocalData test did.
 */

// ── The dataset ─────────────────────────────────────────────────────────────
//
// Ids are deliberately in the LOCAL shapes, not uuids: a signed-out user's
// categories are seeded with text ids ('type-income'), and demo accounts carry
// hand-written ones. A test built on uuids would agree with the code about
// something that is not true of the data.

const ACCOUNT_CURRENT = 'demo-acc-current';
const ACCOUNT_CASH = 'demo-acc-cash';
const ACCOUNT_SAVINGS = 'demo-acc-savings';
const CAT_TYPE = 'type-expense';
const CAT_SUB = 'sub-food';
const CAT_DETAIL = 'detail-groceries';
const TXN_SHOP = 'txn-shop';
const TXN_OUT = 'txn-transfer-out';
const TXN_IN = 'txn-transfer-in';
const TXN_SPLIT = 'txn-split-parent';
const SPLIT_A = 'split-a';
const SPLIT_B = 'split-b';

const seedAccounts = (): Record<string, unknown>[] => [
  {
    id: ACCOUNT_CURRENT, name: 'Current', type: 'current', balance: 1234.56,
    currency: 'GBP', institution: 'HSBC', isActive: true,
    openingBalance: 1000, openingBalanceDate: '2020-01-01',
    lastUpdated: '2026-08-01T09:00:00.000Z', createdAt: '2020-01-01T00:00:00.000Z',
    parentAccountId: null, sortCode: '11-22-33', accountNumber: '12345678',
    bankBalance: 1200.07, bankBalanceDate: '2026-07-31',
    lowBalanceAlertEnabled: true, lowBalanceThreshold: 100,
    // No column anywhere in the schema — the leftovers hatch is the only thing
    // between these and permanent loss on a device that has no other copy.
    creditLimit: 500, tags: ['everyday'],
  },
  {
    id: ACCOUNT_CASH, name: 'Brokerage cash', type: 'current', balance: 250,
    currency: 'GBP', isActive: true, lastUpdated: '2026-08-01T09:00:00.000Z',
    parentAccountId: ACCOUNT_SAVINGS,
  },
  {
    id: ACCOUNT_SAVINGS, name: 'Savings', type: 'savings', balance: -0.29,
    currency: 'GBP', isActive: true, lastUpdated: '2026-08-01T09:00:00.000Z',
    parentAccountId: null,
  },
];

const seedCategories = (): Record<string, unknown>[] => [
  { id: CAT_TYPE, name: 'Expenses', type: 'expense', level: 'type', parentId: null, isSystem: true, isActive: true },
  { id: CAT_SUB, name: 'Food', type: 'expense', level: 'sub', parentId: CAT_TYPE, isActive: true },
  { id: CAT_DETAIL, name: 'Groceries', type: 'expense', level: 'detail', parentId: CAT_SUB, isActive: true },
  {
    id: 'transfer-current', name: 'To/From Current', type: 'both', level: 'detail',
    parentId: CAT_TYPE, isTransferCategory: true, accountId: ACCOUNT_CURRENT, isActive: true,
  },
];

const seedTransactions = (): Record<string, unknown>[] => [
  {
    id: TXN_SHOP, date: '2026-07-04', amount: -12.34, description: 'Corner shop',
    category: CAT_DETAIL, accountId: ACCOUNT_CURRENT, type: 'expense',
    cleared: true, tags: ['weekly'], notes: 'milk',
    createdAt: '2026-07-04T10:00:00.000Z', updatedAt: '2026-07-04T10:00:00.000Z',
  },
  {
    id: TXN_OUT, date: '2026-07-05', amount: -200, description: 'To Savings',
    category: 'transfer-current', accountId: ACCOUNT_CURRENT, type: 'transfer',
    transferAccountId: ACCOUNT_SAVINGS, linkedTransferId: TXN_IN,
  },
  {
    id: TXN_IN, date: '2026-07-05', amount: 200, description: 'From Current',
    category: 'transfer-current', accountId: ACCOUNT_SAVINGS, type: 'transfer',
    transferAccountId: ACCOUNT_CURRENT, linkedTransferId: TXN_OUT,
  },
  {
    id: TXN_SPLIT, date: '2026-07-06', amount: -100, description: 'Supermarket',
    category: CAT_SUB, accountId: ACCOUNT_CURRENT, type: 'expense', isSplit: true,
  },
];

const seedSplits = (): Record<string, unknown>[] => [
  { id: SPLIT_A, transactionId: TXN_SPLIT, category: CAT_DETAIL, amount: -60.07, sortOrder: 0, memo: 'food' },
  {
    id: SPLIT_B, transactionId: TXN_SPLIT, category: CAT_SUB, amount: -39.93, sortOrder: 1,
    transferAccountId: ACCOUNT_CASH, linkedTransferId: TXN_IN,
  },
];

const seedBudgets = (): Record<string, unknown>[] => [{
  id: 'budget-food', categoryId: CAT_SUB, amount: 400, period: 'monthly', isActive: true,
  name: 'Food', spent: 112.34, startDate: '2026-07-01', rolloverMode: 'surplus',
  createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
}];

const seedGoals = (): Record<string, unknown>[] => [{
  id: 'goal-rainy-day', name: 'Rainy day', type: 'savings', targetAmount: 5000,
  currentAmount: 250.01, progress: 250.01, targetDate: '2027-01-01', isActive: true,
  achieved: false, status: 'active', accountId: ACCOUNT_SAVINGS,
  linkedAccountIds: [ACCOUNT_CURRENT], category: 'Holiday', priority: 'high',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
}];

/**
 * One report, with BOTH kinds of list inside its filters.
 *
 * The account and category lists are ids and must be remapped; the tags are
 * labels somebody typed and must come through character for character. A
 * fixture with only one of the two would pass against a remapper that swept the
 * whole blob.
 */
const seedCustomReports = (): Record<string, unknown>[] => [{
  id: 'report-where-it-went', name: 'Where it went', description: 'last quarter',
  components: [{
    id: 'one', type: 'summary-stats', title: 'Key figures',
    config: { metrics: ['income', 'expenses'] }, width: 'full',
  }],
  filters: {
    dateRange: 'quarter',
    accounts: [ACCOUNT_CURRENT, ACCOUNT_SAVINGS],
    categories: [CAT_SUB],
    tags: ['holiday'],
  },
  createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
}];

const seedDismissals = (): Record<string, unknown>[] => [{
  id: 'dismissal-1', kind: 'duplicate',
  subjectKey: canonicalSubjectKey([TXN_SHOP, TXN_SPLIT]),
  subjectIds: [TXN_SHOP, TXN_SPLIT],
  dismissedAt: '2026-07-10T12:00:00.000Z',
}];

async function seedEverything(): Promise<void> {
  await storageAdapter.set(STORAGE_KEYS.ACCOUNTS, seedAccounts());
  await storageAdapter.set(STORAGE_KEYS.CATEGORIES, seedCategories());
  await storageAdapter.set(STORAGE_KEYS.TRANSACTIONS, seedTransactions());
  await storageAdapter.set(STORAGE_KEYS.TRANSACTION_SPLITS, seedSplits());
  await storageAdapter.set(STORAGE_KEYS.BUDGETS, seedBudgets());
  await storageAdapter.set(STORAGE_KEYS.GOALS, seedGoals());
  await storageAdapter.set(STORAGE_KEYS.SUGGESTION_DISMISSALS, seedDismissals());
  await storageAdapter.set(STORAGE_KEYS.CUSTOM_REPORTS, seedCustomReports());
}

const read = async (key: string): Promise<Record<string, unknown>[]> =>
  (await storageAdapter.get<Record<string, unknown>[]>(key)) ?? [];

/** Counter-based ids, so a remap is legible in a failure message. */
function countingIds(): () => string {
  let next = 0;
  return () => `new-${String(next++).padStart(3, '0')}`;
}

beforeEach(async () => {
  await storageAdapter.clear();
  window.localStorage.clear();
});

// ── The mapping ─────────────────────────────────────────────────────────────

describe('LOCAL_BACKUP_BINDINGS', () => {
  it('records a decision for every table the format carries', () => {
    for (const entity of BACKUP_ENTITIES) {
      expect(LOCAL_BACKUP_BINDINGS[entity]).toBeDefined();
    }
    expect(Object.keys(LOCAL_BACKUP_BINDINGS).sort()).toEqual([...BACKUP_ENTITIES].sort());
  });

  it('points every stored table at a real STORAGE_KEYS entry', () => {
    const known = new Set<string>(Object.values(STORAGE_KEYS));
    for (const entity of BACKUP_ENTITIES) {
      const binding = LOCAL_BACKUP_BINDINGS[entity];
      if (binding.stored) expect(known.has(binding.storageKey)).toBe(true);
    }
  });

  it('gives every table this device cannot hold a reason a person can read', () => {
    for (const entity of BACKUP_ENTITIES) {
      const binding = LOCAL_BACKUP_BINDINGS[entity];
      if (!binding.stored) expect(binding.absence.length).toBeGreaterThan(10);
    }
  });

  it('lists the storage keys a restore replaces', () => {
    expect(LOCAL_BACKUP_STORAGE_KEYS).toEqual([
      STORAGE_KEYS.ACCOUNTS,
      STORAGE_KEYS.CATEGORIES,
      STORAGE_KEYS.TRANSACTIONS,
      STORAGE_KEYS.TRANSACTION_SPLITS,
      STORAGE_KEYS.BUDGETS,
      STORAGE_KEYS.GOALS,
      STORAGE_KEYS.SUGGESTION_DISMISSALS,
      STORAGE_KEYS.CUSTOM_REPORTS,
    ]);
  });
});

// ── Export ──────────────────────────────────────────────────────────────────

describe('collectLocalBackupBundle', () => {
  it('writes a file the shared validator accepts', async () => {
    await seedEverything();
    const bundle = await collectLocalBackupBundle();

    expect(bundle.format).toBe(BACKUP_FORMAT);
    // Round-tripped through JSON exactly as a downloaded file would be.
    const validation = validateBackupBundle(JSON.parse(JSON.stringify(bundle)));
    expect(validation.ok).toBe(true);
  });

  it('writes DATABASE column names, not the app spelling', async () => {
    await seedEverything();
    const bundle = await collectLocalBackupBundle();

    const account = bundle.data.accounts.find((row) => row.id === ACCOUNT_CURRENT);
    expect(account).toMatchObject({
      // 'current' in the UI is 'checking' in the database, on both engines.
      type: 'checking',
      initial_balance: 1000,
      opening_balance_date: '2020-01-01',
      account_number: '12345678',
      bank_balance: 1200.07,
      low_balance_alert_enabled: true,
    });
    expect(account).not.toHaveProperty('openingBalance');

    const transfer = bundle.data.transactions.find((row) => row.id === TXN_OUT);
    expect(transfer).toMatchObject({
      account_id: ACCOUNT_CURRENT,
      transfer_account_id: ACCOUNT_SAVINGS,
      linked_transfer_id: TXN_IN,
    });
  });

  it('parks app fields with no column in metadata rather than dropping them', async () => {
    await seedEverything();
    const bundle = await collectLocalBackupBundle();

    const account = bundle.data.accounts.find((row) => row.id === ACCOUNT_CURRENT);
    expect(account?.metadata).toEqual({ localOnlyFields: { creditLimit: 500, tags: ['everyday'] } });
  });

  it('leaves out an entity this device does not hold, as an empty table', async () => {
    await seedEverything();
    const bundle = await collectLocalBackupBundle();

    expect(bundle.data.investments).toEqual([]);
    expect(bundle.data.recurring_transactions).toEqual([]);
    expect(bundle.counts.investments).toBe(0);
  });

  it('records the links the second pass would need', async () => {
    await seedEverything();
    const bundle = await collectLocalBackupBundle();

    expect(bundle.links.account_parents).toEqual([
      { id: ACCOUNT_CASH, parent_account_id: ACCOUNT_SAVINGS },
    ]);
    expect(bundle.links.transaction_links).toEqual([
      { id: TXN_OUT, linked_transfer_id: TXN_IN, linked_transfer_split_id: null },
      { id: TXN_IN, linked_transfer_id: TXN_OUT, linked_transfer_split_id: null },
    ]);
  });

  it('refuses rather than writing a money value it cannot restore exactly', async () => {
    await seedEverything();
    await storageAdapter.set(STORAGE_KEYS.ACCOUNTS, [
      { ...seedAccounts()[0], balance: MAX_EXACT_MONEY * 10 },
    ]);

    await expect(collectLocalBackupBundle()).rejects.toThrow(/lose precision/);
  });

  it('refuses a money value stored as text that is beyond exact range', async () => {
    // Compared through Decimal — the check itself must not be the thing that
    // loses the penny.
    const tooBig = toDecimal(MAX_EXACT_MONEY).plus(1).toFixed(2);
    await storageAdapter.set(STORAGE_KEYS.ACCOUNTS, [{ ...seedAccounts()[0], balance: tooBig }]);

    await expect(collectLocalBackupBundle()).rejects.toThrow(/lose precision/);
  });

  it('refuses when a collection has been corrupted into something that is not a list', async () => {
    await storageAdapter.set(STORAGE_KEYS.ACCOUNTS, { not: 'a list' });
    await expect(collectLocalBackupBundle()).rejects.toThrow(/other than a list/);
  });

  it('reports progress for every table', async () => {
    await seedEverything();
    const seen: string[] = [];
    await collectLocalBackupBundle({ onProgress: (p) => { seen.push(p.entity); } });
    expect(new Set(seen)).toEqual(new Set(BACKUP_ENTITIES));
  });
});

// ── Emptiness and the wipe ──────────────────────────────────────────────────

describe('wipeLocalFinancialData', () => {
  it('demands the confirmation phrase', async () => {
    await seedEverything();
    await expect(wipeLocalFinancialData('delete')).rejects.toThrow(/wipe_not_confirmed/);
    expect(await read(STORAGE_KEYS.ACCOUNTS)).toHaveLength(3);
  });

  it('actually clears what the app reads', async () => {
    // The whole point. The old wipeLocalData wrote '[]' into localStorage while
    // every read goes through encrypted IndexedDB, so this assertion — made
    // through the same adapter the app uses — is the one it could never pass.
    await seedEverything();
    expect(await localFinancialDataIsEmpty()).toBe(false);

    await wipeLocalFinancialData(LOCAL_WIPE_CONFIRMATION);

    for (const key of LOCAL_BACKUP_STORAGE_KEYS) {
      expect(await read(key)).toEqual([]);
    }
    expect(await localFinancialDataIsEmpty()).toBe(true);
  });

  it('says what it threw away, per table', async () => {
    await seedEverything();
    const counts = await wipeLocalFinancialData(LOCAL_WIPE_CONFIRMATION);
    expect(counts).toMatchObject({ accounts: 3, categories: 4, transactions: 4, transaction_splits: 2 });
  });
});

describe('localFinancialDataIsEmpty', () => {
  it('is true for a device that has never held anything', async () => {
    expect(await localFinancialDataIsEmpty()).toBe(true);
  });

  it('asks about the same three tables the database does', async () => {
    await storageAdapter.set(STORAGE_KEYS.GOALS, seedGoals());
    // Goals alone do not make a device non-empty, exactly as
    // user_financial_data_is_empty looks only at accounts, categories and
    // transactions.
    expect(await localFinancialDataIsEmpty()).toBe(true);

    await storageAdapter.set(STORAGE_KEYS.CATEGORIES, seedCategories());
    expect(await localFinancialDataIsEmpty()).toBe(false);
  });
});

// ── The round trip ──────────────────────────────────────────────────────────

describe('a genuine round trip', () => {
  it('seed, export, wipe, restore — same data, new ids, nothing lost', async () => {
    await seedEverything();

    const before = {
      accounts: await read(STORAGE_KEYS.ACCOUNTS),
      categories: await read(STORAGE_KEYS.CATEGORIES),
      transactions: await read(STORAGE_KEYS.TRANSACTIONS),
      splits: await read(STORAGE_KEYS.TRANSACTION_SPLITS),
      budgets: await read(STORAGE_KEYS.BUDGETS),
      goals: await read(STORAGE_KEYS.GOALS),
      dismissals: await read(STORAGE_KEYS.SUGGESTION_DISMISSALS),
      customReports: await read(STORAGE_KEYS.CUSTOM_REPORTS),
    };

    // Exactly what the user gets: a JSON file, read back with the shared parser.
    const exported = await collectLocalBackupBundle();
    const onDisk = JSON.stringify(exported, null, 2);

    await wipeLocalFinancialData(LOCAL_WIPE_CONFIRMATION);
    expect(await localFinancialDataIsEmpty()).toBe(true);

    const validation = validateBackupBundle(JSON.parse(onDisk));
    if (!validation.ok) throw new Error(validation.problem);
    const outcome = await restoreLocalBackupBundle(validation.bundle, { newId: countingIds() });

    const after = {
      accounts: await read(STORAGE_KEYS.ACCOUNTS),
      categories: await read(STORAGE_KEYS.CATEGORIES),
      transactions: await read(STORAGE_KEYS.TRANSACTIONS),
      splits: await read(STORAGE_KEYS.TRANSACTION_SPLITS),
      budgets: await read(STORAGE_KEYS.BUDGETS),
      goals: await read(STORAGE_KEYS.GOALS),
      dismissals: await read(STORAGE_KEYS.SUGGESTION_DISMISSALS),
      customReports: await read(STORAGE_KEYS.CUSTOM_REPORTS),
    };

    // ── Nothing went missing ──
    expect(after.accounts).toHaveLength(before.accounts.length);
    expect(after.categories).toHaveLength(before.categories.length);
    expect(after.transactions).toHaveLength(before.transactions.length);
    expect(after.splits).toHaveLength(before.splits.length);
    expect(after.budgets).toHaveLength(before.budgets.length);
    expect(after.goals).toHaveLength(before.goals.length);
    expect(after.dismissals).toHaveLength(before.dismissals.length);
    expect(after.customReports).toHaveLength(before.customReports.length);
    expect(outcome.danglingRefs).toEqual([]);

    // ── Every id is new, and consistently so ──
    const idOf = (rows: Record<string, unknown>[], index: number): string => String(rows[index].id);
    const oldToNew = new Map<string, string>();
    const pair = (was: Record<string, unknown>[], now: Record<string, unknown>[]): void => {
      was.forEach((row, index) => { oldToNew.set(String(row.id), idOf(now, index)); });
    };
    pair(before.accounts, after.accounts);
    pair(before.categories, after.categories);
    pair(before.transactions, after.transactions);
    pair(before.splits, after.splits);
    pair(before.budgets, after.budgets);
    pair(before.goals, after.goals);
    pair(before.dismissals, after.dismissals);
    pair(before.customReports, after.customReports);

    for (const [was, now] of oldToNew) {
      expect(now).not.toBe(was);
      expect(now).toMatch(/^new-\d{3}$/);
    }
    // No two rows were handed the same new id.
    expect(new Set(oldToNew.values()).size).toBe(oldToNew.size);

    // ── Every field survived, with references pointed at the new ids ──
    const expectSameExceptIds = (
      was: Record<string, unknown>[],
      now: Record<string, unknown>[],
      references: readonly string[]
    ): void => {
      was.forEach((original, index) => {
        const expected: Record<string, unknown> = { ...original, id: oldToNew.get(String(original.id)) };
        for (const field of references) {
          const value = original[field];
          if (typeof value === 'string') expected[field] = oldToNew.get(value) ?? value;
          if (Array.isArray(value)) {
            expected[field] = value.map((entry) =>
              typeof entry === 'string' ? oldToNew.get(entry) ?? entry : entry);
          }
        }
        expect(now[index]).toEqual(expected);
      });
    };

    expectSameExceptIds(before.accounts, after.accounts, ['parentAccountId']);
    expectSameExceptIds(before.categories, after.categories, ['parentId', 'accountId']);
    expectSameExceptIds(before.transactions, after.transactions, [
      // `category` is TEXT holding a category id — the trap. Included here on
      // purpose: without it this assertion passes while every transaction comes
      // back uncategorised.
      'category', 'accountId', 'transferAccountId', 'linkedTransferId', 'linkedTransferSplitId',
    ]);
    expectSameExceptIds(before.splits, after.splits, [
      'transactionId', 'category', 'transferAccountId', 'linkedTransferId',
    ]);
    expectSameExceptIds(before.budgets, after.budgets, ['categoryId']);
    expectSameExceptIds(before.goals, after.goals, ['accountId', 'linkedAccountIds']);

    // ── Money, to the penny ──
    const pennies = (rows: Record<string, unknown>[], field: string): string[] =>
      rows.map((row) => toDecimal(typeof row[field] === 'number' ? Number(row[field]) : 0).toFixed(2));
    expect(pennies(after.accounts, 'balance')).toEqual(pennies(before.accounts, 'balance'));
    expect(pennies(after.transactions, 'amount')).toEqual(pennies(before.transactions, 'amount'));
    expect(pennies(after.splits, 'amount')).toEqual(pennies(before.splits, 'amount'));
    // The split lines still sum to their parent exactly.
    const parent = after.transactions.find((row) => row.description === 'Supermarket');
    const sum = after.splits.reduce(
      (total, row) => total.plus(toDecimal(Number(row.amount))), toDecimal(0));
    expect(sum.toFixed(2)).toBe(toDecimal(Number(parent?.amount)).toFixed(2));

    // ── Relationships ──
    const account = (name: string): Record<string, unknown> =>
      after.accounts.find((row) => row.name === name)!;
    // The cash account still hangs under the investment account it belongs to.
    expect(account('Brokerage cash').parentAccountId).toBe(account('Savings').id);
    // Both halves of the transfer still name each other.
    const out = after.transactions.find((row) => row.description === 'To Savings')!;
    const income = after.transactions.find((row) => row.description === 'From Current')!;
    expect(out.linkedTransferId).toBe(income.id);
    expect(income.linkedTransferId).toBe(out.id);
    expect(out.transferAccountId).toBe(account('Savings').id);
    // Splits still belong to their parent.
    expect(new Set(after.splits.map((row) => row.transactionId))).toEqual(new Set([parent?.id]));
    // The category tree still hangs together.
    const category = (name: string): Record<string, unknown> =>
      after.categories.find((row) => row.name === name)!;
    expect(category('Groceries').parentId).toBe(category('Food').id);
    expect(category('Food').parentId).toBe(category('Expenses').id);
    // And a categorised transaction still points at a category that exists.
    const shop = after.transactions.find((row) => row.description === 'Corner shop')!;
    expect(shop.category).toBe(category('Groceries').id);
    expect(after.categories.some((row) => row.id === shop.category)).toBe(true);

    // ── The dismissal still matches the rows it was about ──
    const dismissal = after.dismissals[0];
    expect(dismissal.subjectIds).toEqual([shop.id, parent?.id]);
    // Rebuilt from the restored rows the way a re-scan would rebuild it: if the
    // key were not remapped AND re-sorted, every refused suggestion would come
    // back on the next sweep.
    expect(dismissal.subjectKey).toBe(canonicalSubjectKey([String(shop.id), String(parent?.id)]));

    // ── The report still asks about the accounts it was asking about ──
    //
    // The failure this catches is silent in the worst way: a report whose
    // filters still name the OLD login's accounts opens, generates, and reports
    // on nothing — because no transaction in the restored login matches any of
    // them. The tags beside them are labels and must NOT have moved.
    const report = after.customReports[0];
    const filters = report.filters as Record<string, unknown>;
    expect(filters.accounts).toEqual([
      oldToNew.get(ACCOUNT_CURRENT), oldToNew.get(ACCOUNT_SAVINGS),
    ]);
    expect(filters.categories).toEqual([oldToNew.get(CAT_SUB)]);
    expect(filters.tags).toEqual(['holiday']);
    // And the definition itself came through whole.
    expect(report.components).toEqual(seedCustomReports()[0].components);

    // ── And the report tells the truth ──
    expect(outcome.restored).toEqual([
      { label: 'Accounts', rows: 3 },
      { label: 'Categories', rows: 4 },
      { label: 'Transactions', rows: 4 },
      { label: 'Transaction splits', rows: 2 },
      { label: 'Budgets', rows: 1 },
      { label: 'Goals', rows: 1 },
      { label: 'Dismissed suggestions', rows: 1 },
      { label: 'Custom reports', rows: 1 },
    ]);
    expect(outcome.accountsRelinked).toBe(1);
    expect(outcome.transactionsRelinked).toBe(2);
    expect(outcome.notStoredLocally).toEqual([]);
  });

  it('survives a second trip — the restored data exports to the same file again', async () => {
    await seedEverything();
    const first = await collectLocalBackupBundle();

    await wipeLocalFinancialData(LOCAL_WIPE_CONFIRMATION);
    await restoreLocalBackupBundle(first, { newId: countingIds() });
    const second = await collectLocalBackupBundle();

    await wipeLocalFinancialData(LOCAL_WIPE_CONFIRMATION);
    await restoreLocalBackupBundle(second, { newId: countingIds() });
    const third = await collectLocalBackupBundle();

    // Same ids (the generator restarts), same rows, same counts. A conversion
    // that lost or invented a field would drift between generations.
    expect(third.data).toEqual(second.data);
    expect(third.counts).toEqual(second.counts);
  });
});

// ── Restore behaviour ───────────────────────────────────────────────────────

const bundleFrom = async (): Promise<BackupBundle> => {
  const bundle = await collectLocalBackupBundle();
  const validation = validateBackupBundle(JSON.parse(JSON.stringify(bundle)));
  if (!validation.ok) throw new Error(validation.problem);
  return validation.bundle;
};

describe('restoreLocalBackupBundle', () => {
  it('refuses a device that still holds data, and changes nothing', async () => {
    await seedEverything();
    const bundle = await bundleFrom();

    await expect(restoreLocalBackupBundle(bundle)).rejects.toBeInstanceOf(LocalRestoreRefusedError);
    // The refusal is not a half-measure: storage is exactly as it was.
    expect(await read(STORAGE_KEYS.ACCOUNTS)).toHaveLength(3);
    expect(await read(STORAGE_KEYS.TRANSACTIONS)).toHaveLength(4);
  });

  it('empties a table the file has no rows for rather than leaving what was there', async () => {
    await seedEverything();
    const bundle = await bundleFrom();
    await wipeLocalFinancialData(LOCAL_WIPE_CONFIRMATION);

    // Something landed in goals between the wipe and the restore. A restore
    // REPLACES; leaving it would silently merge two datasets.
    await storageAdapter.set(STORAGE_KEYS.GOALS, seedGoals());
    const stripped: BackupBundle = { ...bundle, data: { ...bundle.data, goals: [] } };
    await restoreLocalBackupBundle(stripped, { newId: countingIds() });

    expect(await read(STORAGE_KEYS.GOALS)).toEqual([]);
  });

  it('names what this device cannot keep instead of dropping it in silence', async () => {
    const bundle = await bundleFrom();
    const withInvestments: BackupBundle = {
      ...bundle,
      data: {
        ...bundle.data,
        investments: [{ id: 'inv-1', account_id: 'a-1', symbol: 'VWRL' }],
        recurring_transactions: [{ id: 'rec-1', account_id: 'a-1', amount: -9.99 }],
      },
    };

    const outcome = await restoreLocalBackupBundle(withInvestments, { newId: countingIds() });
    expect(outcome.notStoredLocally).toEqual([
      { label: 'Investments', rows: 1, absence: 'holdings are only tracked when you are signed in' },
      {
        label: 'Recurring transactions', rows: 1,
        absence: 'repeating templates are only kept when you are signed in',
      },
    ]);
  });

  it('says nothing about tables the file is empty for', async () => {
    const outcome = await restoreLocalBackupBundle(await bundleFrom(), { newId: countingIds() });
    expect(outcome.notStoredLocally).toEqual([]);
  });

  it('reports a reference the file does not contain rather than blanking it', async () => {
    await seedEverything();
    const bundle = await bundleFrom();
    await wipeLocalFinancialData(LOCAL_WIPE_CONFIRMATION);

    const orphaned: BackupBundle = {
      ...bundle,
      data: {
        ...bundle.data,
        transactions: bundle.data.transactions.map((row) =>
          row.id === TXN_SHOP ? { ...row, category: '11111111-2222-3333-4444-555555555555' } : row),
      },
    };
    const outcome = await restoreLocalBackupBundle(orphaned, { newId: countingIds() });

    expect(outcome.danglingRefs).toEqual([
      expect.objectContaining({
        entity: 'transactions', field: 'category',
        value: '11111111-2222-3333-4444-555555555555',
      }),
    ]);
    // Left as it was, not blanked — a value we cannot explain is not the same
    // as one we know to be absent.
    const restored = await read(STORAGE_KEYS.TRANSACTIONS);
    expect(restored.some((row) => row.category === '11111111-2222-3333-4444-555555555555')).toBe(true);
  });

  it('leaves the previous data untouched when the write fails', async () => {
    // Atomicity from the caller's side: everything is converted first and
    // written last, in one go, so a failing write cannot leave half a dataset.
    await seedEverything();
    const bundle = await bundleFrom();
    await wipeLocalFinancialData(LOCAL_WIPE_CONFIRMATION);
    await storageAdapter.set(STORAGE_KEYS.ACCOUNTS, []);

    const setMany = vi.fn().mockRejectedValue(new Error('QuotaExceededError'));
    const store: LocalBackupStore = { get: (key) => storageAdapter.get(key), setMany };

    await expect(restoreLocalBackupBundle(bundle, { store })).rejects.toThrow(/QuotaExceededError/);
    expect(setMany).toHaveBeenCalledTimes(1);
    for (const key of LOCAL_BACKUP_STORAGE_KEYS) {
      expect(await read(key)).toEqual([]);
    }
  });

  it('writes every table in ONE call, which is what makes it all-or-nothing', async () => {
    const bundle = await bundleFrom();
    const setMany = vi.fn().mockResolvedValue(undefined);
    const store: LocalBackupStore = { get: (key) => storageAdapter.get(key), setMany };

    await restoreLocalBackupBundle(bundle, { store, newId: countingIds() });

    expect(setMany).toHaveBeenCalledTimes(1);
    const written: Array<{ key: string }> = setMany.mock.calls[0][0];
    expect(written.map((entry) => entry.key)).toEqual([...LOCAL_BACKUP_STORAGE_KEYS]);
  });
});

// ── Do the two engines' files interchange? ──────────────────────────────────

describe('cloud and local files', () => {
  /** A file as the CLOUD export writes it: whole rows, user_id and all. */
  const cloudTakenBundle = (): unknown => ({
    format: BACKUP_FORMAT,
    schemaVersion: '20260807083000',
    exportedAt: '2026-08-07T09:30:00.000Z',
    sourceUserId: '7d1f6e2a-0000-4000-8000-000000000001',
    counts: {
      accounts: 1, categories: 1, transactions: 1, transaction_splits: 0, budgets: 0,
      goals: 0, goal_contributions: 0, investments: 0, investment_transactions: 0,
      recurring_transactions: 0, notifications: 0, dashboard_layouts: 0,
      widget_preferences: 0, suggestion_dismissals: 0,
    },
    data: {
      accounts: [{
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        user_id: '7d1f6e2a-0000-4000-8000-000000000001',
        name: 'Current', type: 'checking', currency: 'GBP', balance: 1234.56,
        initial_balance: 1000, is_active: true, institution: 'HSBC',
        parent_account_id: null, created_at: '2020-01-01T00:00:00.000Z',
        updated_at: '2026-08-01T09:00:00.000Z', metadata: {},
      }],
      categories: [{
        id: 'cccccccc-0000-4000-8000-000000000001',
        user_id: '7d1f6e2a-0000-4000-8000-000000000001',
        name: 'Groceries', type: 'expense', level: 'detail', parent_id: null,
        is_system: false, is_active: true, created_at: '2020-01-01T00:00:00.000Z',
      }],
      transactions: [{
        id: 'tttttttt-0000-4000-8000-000000000001'.replace(/t/g, 'b'),
        user_id: '7d1f6e2a-0000-4000-8000-000000000001',
        account_id: 'aaaaaaaa-0000-4000-8000-000000000001',
        category: 'cccccccc-0000-4000-8000-000000000001',
        category_id: 'cccccccc-0000-4000-8000-000000000001',
        date: '2026-07-04', amount: -12.34, description: 'Corner shop', type: 'expense',
        is_cleared: true, tags: ['weekly'], notes: 'milk',
        created_at: '2026-07-04T10:00:00.000Z', updated_at: '2026-07-04T10:00:00.000Z',
      }],
    },
    links: { account_parents: [], transaction_links: [] },
  });

  it('restores a cloud-taken file onto this device', async () => {
    const validation = validateBackupBundle(cloudTakenBundle());
    if (!validation.ok) throw new Error(validation.problem);

    const outcome = await restoreLocalBackupBundle(validation.bundle, { newId: countingIds() });
    expect(outcome.danglingRefs).toEqual([]);

    const accounts = await read(STORAGE_KEYS.ACCOUNTS);
    const categories = await read(STORAGE_KEYS.CATEGORIES);
    const transactions = await read(STORAGE_KEYS.TRANSACTIONS);

    // Read back in the app's own spelling, ready for the app to use.
    expect(accounts[0]).toMatchObject({
      name: 'Current', type: 'current', balance: 1234.56, openingBalance: 1000,
      isActive: true, institution: 'HSBC',
    });
    expect(transactions[0]).toMatchObject({
      description: 'Corner shop', amount: -12.34, cleared: true, tags: ['weekly'],
    });
    // Still filed under a category that exists here.
    expect(transactions[0].category).toBe(categories[0].id);
    expect(transactions[0].accountId).toBe(accounts[0].id);
  });

  it('does not carry the server-only columns back out again', async () => {
    // Honest about the one-way loss: user_id, created_at on a category and the
    // uuid category_id have no home in local storage, so a cloud file that goes
    // local and comes back out has lost them. Everything the app reads survives.
    const validation = validateBackupBundle(cloudTakenBundle());
    if (!validation.ok) throw new Error(validation.problem);
    await restoreLocalBackupBundle(validation.bundle, { newId: countingIds() });

    const reExported = await collectLocalBackupBundle();
    expect(reExported.data.categories[0]).not.toHaveProperty('created_at');
    expect(reExported.data.transactions[0]).not.toHaveProperty('category_id');
    expect(reExported.data.transactions[0]).not.toHaveProperty('user_id');
    // But the money, the description and the category link did survive.
    expect(reExported.data.transactions[0]).toMatchObject({
      amount: -12.34, description: 'Corner shop',
      category: reExported.data.categories[0].id,
    });
  });

  it('writes a locally-taken file the cloud restore can consume', async () => {
    await seedEverything();
    const bundle = await collectLocalBackupBundle();

    // restore_user_chunk hands rows to jsonb_populate_recordset, so a missing
    // key arrives as SQL NULL and a NOT NULL column rejects it. These are the
    // columns that would stop a cloud restore halfway through.
    for (const row of bundle.data.accounts) {
      expect(typeof row.name).toBe('string');
      expect(typeof row.type).toBe('string');
    }
    for (const row of bundle.data.transactions) {
      expect(typeof row.description).toBe('string');
      expect(typeof row.account_id).toBe('string');
      expect(typeof row.amount).toBe('number');
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const row of bundle.data.transaction_splits) {
      expect(typeof row.category).toBe('string');
      expect(typeof row.sort_order).toBe('number');
    }
    for (const row of bundle.data.budgets) {
      expect(typeof row.name).toBe('string');
      expect(typeof row.start_date).toBe('string');
    }
    for (const row of bundle.data.categories) {
      expect(['type', 'sub', 'detail']).toContain(row.level);
    }
    // And no globally-unique provider id that would collide on the way in.
    const columns = new Set(bundle.data.accounts.flatMap((row) => Object.keys(row)));
    expect(columns.has('plaid_account_id')).toBe(false);
    expect(columns.has('plaid_connection_id')).toBe(false);
  });
});

// ── The one deliberate lossy conversion ─────────────────────────────────────

describe('a transaction date is a calendar day', () => {
  it('truncates a time of day, because the column is a DATE on both engines', async () => {
    await storageAdapter.set(STORAGE_KEYS.ACCOUNTS, seedAccounts());
    await storageAdapter.set(STORAGE_KEYS.TRANSACTIONS, [{
      id: TXN_SHOP, date: '2026-07-04T14:30:00.000Z', amount: -1, description: 'Late',
      accountId: ACCOUNT_CURRENT, type: 'expense',
    }]);

    const bundle = await collectLocalBackupBundle();
    expect(bundle.data.transactions[0].date).toBe('2026-07-04');
  });

  it('leaves a day that is already a day exactly alone', async () => {
    // Never through `new Date('2026-07-04')`, which invents a UTC midnight and
    // can move the day west of Greenwich.
    await storageAdapter.set(STORAGE_KEYS.ACCOUNTS, seedAccounts());
    await storageAdapter.set(STORAGE_KEYS.TRANSACTIONS, [{
      id: TXN_SHOP, date: '2026-07-04', amount: -1, description: 'Shop',
      accountId: ACCOUNT_CURRENT, type: 'expense',
    }]);

    const bundle = await collectLocalBackupBundle();
    expect(bundle.data.transactions[0].date).toBe('2026-07-04');
  });
});

// ── The trap the cloud remapper had ─────────────────────────────────────────

describe('text ids that are not uuids', () => {
  it('remaps a category id the app seeded as plain text', async () => {
    // A signed-out user's categories are 'type-income', 'transfer-in' and so
    // on. remapBackupIds used to skip any TEXT reference that did not LOOK like
    // a uuid, so categories[].id changed and transactions.category did not.
    await storageAdapter.set(STORAGE_KEYS.CATEGORIES, [
      { id: 'type-expense', name: 'Expenses', type: 'expense', level: 'type', parentId: null },
    ]);
    await storageAdapter.set(STORAGE_KEYS.ACCOUNTS, [seedAccounts()[0]]);
    await storageAdapter.set(STORAGE_KEYS.TRANSACTIONS, [{
      id: TXN_SHOP, date: '2026-07-04', amount: -1, description: 'Shop',
      category: 'type-expense', accountId: ACCOUNT_CURRENT, type: 'expense',
    }]);

    const bundle = await bundleFrom();
    await wipeLocalFinancialData(LOCAL_WIPE_CONFIRMATION);
    await restoreLocalBackupBundle(bundle, { newId: countingIds() });

    const categories = await read(STORAGE_KEYS.CATEGORIES);
    const transactions = await read(STORAGE_KEYS.TRANSACTIONS);
    expect(categories[0].id).not.toBe('type-expense');
    expect(transactions[0].category).toBe(categories[0].id);
  });

  it('leaves a free-text label alone and does not call it dangling', async () => {
    // goals.category holds a word a person typed, not a reference.
    await storageAdapter.set(STORAGE_KEYS.GOALS, [{
      ...seedGoals()[0], accountId: undefined, linkedAccountIds: undefined, category: 'Holiday',
    }]);

    const bundle = await bundleFrom();
    const outcome = await restoreLocalBackupBundle(bundle, { newId: countingIds() });

    expect(outcome.danglingRefs).toEqual([]);
    expect((await read(STORAGE_KEYS.GOALS))[0].category).toBe('Holiday');
  });
});

// ── Rows the format cannot carry ────────────────────────────────────────────

describe('a corrupted collection', () => {
  it('refuses an entry that is not a record instead of quietly skipping it', async () => {
    const rows: unknown[] = [...seedAccounts(), 'not a record'];
    await storageAdapter.set(STORAGE_KEYS.ACCOUNTS, rows);
    await expect(collectLocalBackupBundle()).rejects.toThrow(/not a record/);
  });
});

// ── Preferences travel with a local file too ─────────────────────────────────

/**
 * A local device has no account to store preferences against, so the file IS
 * the only copy of them there will ever be — which makes carrying them more
 * important here than in the cloud, not less.
 */
describe('preferences in a local backup', () => {
  /** A service with its own in-memory browser, so no suite leaks into another. */
  const isolated = (initial: Record<string, string> = {}): PreferencesService => {
    const values = { ...initial };
    return new PreferencesService({
      mirror: {
        getItem: (key) => (key in values ? values[key] : null),
        setItem: (key, value) => { values[key] = value; },
        removeItem: (key) => { delete values[key]; },
      },
      transport: null,
      debounceMs: 0,
    });
  };

  const port = (service: PreferencesService) => ({
    read: () => service.getDocument(),
    write: (document: Parameters<PreferencesService['replaceAll']>[0]) => service.replaceAll(document),
  });

  it('exports what the device holds and restores it onto a device that has none', async () => {
    await seedEverything();
    const source = isolated();
    source.setItem('accountsSortMode', 'balance-desc');
    source.setItem('netWorthChartType', 'bar');

    const exported = await collectLocalBackupBundle({ preferences: port(source) });
    const onDisk = JSON.stringify(exported, null, 2);

    await wipeLocalFinancialData(LOCAL_WIPE_CONFIRMATION);
    const validation = validateBackupBundle(JSON.parse(onDisk));
    if (!validation.ok) throw new Error(validation.problem);

    const target = isolated();
    const outcome = await restoreLocalBackupBundle(validation.bundle, {
      newId: countingIds(),
      preferences: port(target),
    });

    expect(outcome.preferencesRestored).toBe(2);
    expect(outcome.preferencesFailure).toBeNull();
    expect(target.getItem('accountsSortMode')).toBe('balance-desc');
    expect(target.getItem('netWorthChartType')).toBe('bar');
  });

  it('brings the pinned accounts back pointing at the accounts that were restored', async () => {
    // The silent failure this guards: ids inside a preference are not
    // constrained by anything, so a verbatim restore leaves the dashboard
    // pinning accounts belonging to the login the file came from.
    await seedEverything();
    const accountsBefore = await read(STORAGE_KEYS.ACCOUNTS);
    const pinned = accountsBefore.slice(0, 2).map((account) => String(account.id));

    const source = isolated();
    source.setItem('dashboardKeyAccounts', JSON.stringify(pinned));

    const onDisk = JSON.stringify(await collectLocalBackupBundle({ preferences: port(source) }), null, 2);
    await wipeLocalFinancialData(LOCAL_WIPE_CONFIRMATION);
    const validation = validateBackupBundle(JSON.parse(onDisk));
    if (!validation.ok) throw new Error(validation.problem);

    const target = isolated();
    await restoreLocalBackupBundle(validation.bundle, { newId: countingIds(), preferences: port(target) });

    const accountsAfter = await read(STORAGE_KEYS.ACCOUNTS);
    const restoredPins: unknown = JSON.parse(target.getItem('dashboardKeyAccounts') ?? '[]');
    const liveIds = new Set(accountsAfter.map((account) => String(account.id)));

    expect(restoredPins).toHaveLength(2);
    expect((restoredPins as string[]).every((id) => liveIds.has(id))).toBe(true);
    // …and specifically NOT the ids the file carried.
    expect(restoredPins).not.toEqual(pinned);
  });

  it('does not fail the restore when the settings cannot be saved', async () => {
    // Preferences go in after every financial row. A complete ledger with
    // default toggles is a good outcome that happens to be missing something.
    await seedEverything();
    const source = isolated();
    source.setItem('accountsSortMode', 'name');
    const onDisk = JSON.stringify(await collectLocalBackupBundle({ preferences: port(source) }), null, 2);

    await wipeLocalFinancialData(LOCAL_WIPE_CONFIRMATION);
    const validation = validateBackupBundle(JSON.parse(onDisk));
    if (!validation.ok) throw new Error(validation.problem);

    const outcome = await restoreLocalBackupBundle(validation.bundle, {
      newId: countingIds(),
      preferences: {
        read: () => ({ version: 1, values: {} }),
        write: () => Promise.reject(new Error('storage is full')),
      },
    });

    expect(outcome.preferencesRestored).toBe(0);
    expect(outcome.preferencesFailure).toBe('storage is full');
    // The rows are all there regardless.
    expect(await read(STORAGE_KEYS.TRANSACTIONS)).not.toHaveLength(0);
  });

  it('is not emptied by a wipe — deleting your data is not forgetting how you read it', async () => {
    await seedEverything();
    const service = isolated();
    service.setItem('accountsSortMode', 'name');

    await wipeLocalFinancialData(LOCAL_WIPE_CONFIRMATION);

    expect(service.getItem('accountsSortMode')).toBe('name');
  });
});
