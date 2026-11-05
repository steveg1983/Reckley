import { describe, it, expect } from 'vitest';
import {
  BACKUP_ENTITIES,
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  RESTORE_STEPS,
  backupFileName,
  buildBackupBundle,
  MAX_EXACT_MONEY,
  chunkRows,
  extractAccountParents,
  extractTransactionLinks,
  preferenceCount,
  remapBackupIds,
  remapPreferenceIds,
  rowsForStep,
  transactionDateRange,
  validateBackupBundle,
  type BackupRow,
} from './backupService';
import {
  canonicalSubjectKey,
  payeeHiddenDismissalKey,
  payeeLineDismissalKey,
  payeeMerchantDismissalKey,
} from '../utils/suggestionDismissals';

// Every value below is invented. The shapes mirror the database's own columns
// (snake_case, whole rows) because that is exactly what a real backup carries.

const account = (over: Partial<BackupRow> = {}): BackupRow => ({
  id: 'a-1',
  user_id: 'u-1',
  name: 'Current',
  type: 'checking',
  balance: 1234.56,
  parent_account_id: null,
  ...over,
});

const transaction = (over: Partial<BackupRow> = {}): BackupRow => ({
  id: 't-1',
  user_id: 'u-1',
  account_id: 'a-1',
  date: '2021-06-06',
  amount: -80,
  linked_transfer_id: null,
  linked_transfer_split_id: null,
  ...over,
});

const category = (over: Partial<BackupRow> = {}): BackupRow => ({
  id: 'c-1',
  user_id: 'u-1',
  name: 'Food',
  type: 'expense',
  level: 'sub',
  parent_id: 'c-0',
  ...over,
});

/** A bundle good enough to pass validation, so each test can break one thing. */
const goodBundle = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  JSON.parse(JSON.stringify({
    ...buildBackupBundle({
      sourceUserId: 'u-1',
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: {
        accounts: [account()],
        categories: [category({ level: 'type', parent_id: null })],
        transactions: [transaction()],
      },
    }),
    ...over,
  })) as Record<string, unknown>;

describe('buildBackupBundle', () => {
  it('writes an entry for every table, empty ones included', () => {
    const bundle = buildBackupBundle({
      sourceUserId: 'u-1',
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: { accounts: [account()] },
    });

    expect(Object.keys(bundle.data).sort()).toEqual([...BACKUP_ENTITIES].sort());
    expect(bundle.data.investments).toEqual([]);
    // A reader must not have to tell "no investments" from "forgot investments".
    expect(bundle.counts.investments).toBe(0);
    expect(bundle.counts.accounts).toBe(1);
  });

  it('stamps the format and schema version the restore checks', () => {
    const bundle = buildBackupBundle({
      sourceUserId: 'u-1',
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: {},
    });

    expect(bundle.format).toBe(BACKUP_FORMAT);
    expect(bundle.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(bundle.exportedAt).toBe('2026-08-07T09:30:00.000Z');
    expect(bundle.sourceUserId).toBe('u-1');
  });

  it('keeps whole rows verbatim, including columns this code has never heard of', () => {
    const exotic = account({ some_column_added_next_year: 'kept', balance: 1234.56 });
    const bundle = buildBackupBundle({
      sourceUserId: 'u-1',
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: { accounts: [exotic] },
    });

    expect(bundle.data.accounts[0]).toEqual(exotic);
    expect(bundle.data.accounts[0].some_column_added_next_year).toBe('kept');
  });

  it('counts match the arrays they describe', () => {
    const bundle = buildBackupBundle({
      sourceUserId: 'u-1',
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: { transactions: [transaction({ id: 't-1' }), transaction({ id: 't-2' })] },
    });

    expect(bundle.counts.transactions).toBe(bundle.data.transactions.length);
  });
});

describe('link extraction', () => {
  it('carries only the accounts that actually hang under another one', () => {
    const links = extractAccountParents([
      account({ id: 'a-1', parent_account_id: null }),
      account({ id: 'a-2', parent_account_id: 'a-1' }),
      account({ id: 'a-3' }),
    ]);

    expect(links).toEqual([{ id: 'a-2', parent_account_id: 'a-1' }]);
  });

  it('carries only transactions with at least one link, keeping the null half', () => {
    const links = extractTransactionLinks([
      transaction({ id: 't-1' }),
      transaction({ id: 't-2', linked_transfer_id: 't-3' }),
      transaction({ id: 't-4', linked_transfer_split_id: 's-9' }),
    ]);

    // An unlinked row must not appear: finalize UPDATEs what it is given, and
    // an UPDATE re-dates updated_at on every row it touches.
    expect(links).toEqual([
      { id: 't-2', linked_transfer_id: 't-3', linked_transfer_split_id: null },
      { id: 't-4', linked_transfer_id: null, linked_transfer_split_id: 's-9' },
    ]);
  });

  it('ignores rows with no id rather than emitting a link that points nowhere', () => {
    expect(extractAccountParents([{ parent_account_id: 'a-1' }])).toEqual([]);
    expect(extractTransactionLinks([{ linked_transfer_id: 't-1' }])).toEqual([]);
  });

  it('builds both link lists into the bundle', () => {
    const bundle = buildBackupBundle({
      sourceUserId: 'u-1',
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: {
        accounts: [account({ id: 'a-2', parent_account_id: 'a-1' })],
        transactions: [transaction({ id: 't-2', linked_transfer_id: 't-3' })],
      },
    });

    expect(bundle.links.account_parents).toHaveLength(1);
    expect(bundle.links.transaction_links).toHaveLength(1);
  });
});

describe('validateBackupBundle', () => {
  it('accepts a bundle this module just built', () => {
    const result = validateBackupBundle(goodBundle());
    expect(result.ok).toBe(true);
  });

  it('refuses anything that is not a JSON object', () => {
    const result = validateBackupBundle([1, 2, 3]);
    expect(result).toEqual({ ok: false, problem: expect.stringContaining('an array') });
  });

  it('names the old export format instead of failing vaguely', () => {
    const result = validateBackupBundle({
      format: 'reckley-complete-export-v1',
      data: {},
      counts: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain('reckley-complete-export-v1');
    expect(result.problem).toContain(BACKUP_FORMAT);
  });

  it('refuses a file whose data is not an object', () => {
    const result = validateBackupBundle({ format: BACKUP_FORMAT, data: 'nope', counts: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain('"data"');
  });

  it('refuses a table this version cannot restore, and says which', () => {
    const bundle = goodBundle();
    const data = bundle.data as Record<string, unknown>;
    data.mystery_table = [];

    const result = validateBackupBundle(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain('mystery_table');
  });

  it('refuses an entity that is not an array', () => {
    const bundle = goodBundle();
    (bundle.data as Record<string, unknown>).budgets = { a: 1 };

    const result = validateBackupBundle(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain('"data.budgets"');
  });

  it('refuses an entity holding something that is not a row, pointing at which one', () => {
    const bundle = goodBundle();
    (bundle.data as Record<string, unknown>).goals = [{ id: 'g-1' }, 'oops'];
    (bundle.counts as Record<string, unknown>).goals = 2;

    const result = validateBackupBundle(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain('entry 2');
  });

  it('refuses a file whose counts disagree with its rows', () => {
    const bundle = goodBundle();
    (bundle.counts as Record<string, unknown>).transactions = 99;

    const result = validateBackupBundle(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain('99');
    expect(result.problem).toContain('carries 1');
  });

  it('refuses a category level the level-by-level restore would drop on the floor', () => {
    const bundle = goodBundle();
    (bundle.data as Record<string, BackupRow[]>).categories = [category({ level: 'group' })];

    const result = validateBackupBundle(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain('group');
    expect(result.problem).toContain('type, sub or detail');
  });

  it('accepts a file with no links at all', () => {
    const bundle = goodBundle();
    delete bundle.links;

    const result = validateBackupBundle(bundle);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.links).toEqual({ account_parents: [], transaction_links: [] });
  });

  it('refuses a link entry missing the id it would have to patch', () => {
    const bundle = goodBundle({
      links: { account_parents: [{ parent_account_id: 'a-1' }], transaction_links: [] },
    });

    const result = validateBackupBundle(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain('account_parents');
  });

  it('fills in tables the file leaves out rather than refusing an older export', () => {
    const bundle = goodBundle();
    delete (bundle.data as Record<string, unknown>).widget_preferences;
    delete (bundle.counts as Record<string, unknown>).widget_preferences;

    const result = validateBackupBundle(bundle);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.data.widget_preferences).toEqual([]);
    expect(result.bundle.counts.widget_preferences).toBe(0);
  });

  it('hands back whole rows untouched', () => {
    const bundle = goodBundle();
    (bundle.data as Record<string, BackupRow[]>).accounts = [account({ odd_column: 'kept' })];

    const result = validateBackupBundle(bundle);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.data.accounts[0].odd_column).toBe('kept');
  });
});

describe('restore ordering', () => {
  it('sends accounts first and categories level by level', () => {
    expect(RESTORE_STEPS.map((step) => `${step.entity}${step.level ? `:${step.level}` : ''}`)).toEqual([
      'accounts',
      'categories:type',
      'categories:sub',
      'categories:detail',
      'budgets',
      'goals',
      'investments',
      'investment_transactions',
      'transactions',
      'transaction_splits',
      'goal_contributions',
      'recurring_transactions',
      'notifications',
      'dashboard_layouts',
      'widget_preferences',
      'suggestion_dismissals',
      // Last, and the ONLY step whose position is a choice rather than a
      // constraint: a report names accounts and categories from inside a jsonb
      // column with no foreign key behind it, so the database would take it
      // first. See RESTORE_STEPS for why "last" is nonetheless the right answer.
      'custom_reports',
      // Adjustments reference categories through a REAL foreign key, so this
      // one's position IS a constraint: after the categories exist.
      'forecast_adjustments',
    ]);
  });

  it('splits categories by level and leaves other entities whole', () => {
    const bundle = buildBackupBundle({
      sourceUserId: 'u-1',
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: {
        categories: [
          category({ id: 'c-1', level: 'type' }),
          category({ id: 'c-2', level: 'sub' }),
          category({ id: 'c-3', level: 'detail' }),
        ],
        transactions: [transaction()],
      },
    });

    expect(rowsForStep(bundle, { entity: 'categories', level: 'sub', label: '' })).toHaveLength(1);
    expect(rowsForStep(bundle, { entity: 'transactions', label: '' })).toHaveLength(1);
  });

  it('every entity in the backup has somewhere to go', () => {
    const covered = new Set(RESTORE_STEPS.map((step) => step.entity));
    expect([...covered].sort()).toEqual([...BACKUP_ENTITIES].sort());
  });
});

describe('chunkRows', () => {
  it('returns nothing for an empty list, so no pointless round trip happens', () => {
    expect(chunkRows([])).toEqual([]);
  });

  it('splits at the requested size with the remainder last', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `r-${i}` }));
    expect(chunkRows(rows, 2).map((chunk) => chunk.length)).toEqual([2, 2, 1]);
  });

  it('keeps every row exactly once and in order', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: `r-${i}` }));
    expect(chunkRows(rows, 3).flat()).toEqual(rows);
  });
});

describe('transactionDateRange', () => {
  it('reports the earliest and latest date in the file', () => {
    const bundle = buildBackupBundle({
      sourceUserId: 'u-1',
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: {
        transactions: [
          transaction({ id: 't-1', date: '2021-06-06' }),
          transaction({ id: 't-2', date: '2019-01-31' }),
          transaction({ id: 't-3', date: '2024-12-25' }),
        ],
      },
    });

    expect(transactionDateRange(bundle)).toEqual({ first: '2019-01-31', last: '2024-12-25' });
  });

  it('says nothing rather than guessing when there are no transactions', () => {
    const bundle = buildBackupBundle({ sourceUserId: 'u-1', exportedAt: '2026-08-07T09:30:00.000Z', data: {} });
    expect(transactionDateRange(bundle)).toBeNull();
  });
});

describe('backupFileName', () => {
  it('dates the file from when it was exported', () => {
    expect(backupFileName('2026-08-07T09:30:00.000Z')).toBe('reckley-backup-2026-08-07.json');
  });

  it('still produces a usable name when the timestamp is unreadable', () => {
    expect(backupFileName('not a date')).toMatch(/^reckley-backup-\d{4}-\d{2}-\d{2}\.json$/);
  });
});

describe('money precision guard', () => {
  it('passes every realistic money value through untouched', () => {
    const bundle = buildBackupBundle({
      exportedAt: '2026-08-07T00:00:00.000Z',
      sourceUserId: 'u1',
      data: {
        accounts: [{ id: 'a1', balance: 1234.56, initial_balance: 0.07 }],
        transactions: [{ id: 't1', amount: -0.29 }, { id: 't2', amount: 99999999999.99 }],
      },
    });
    expect(bundle.data.accounts[0].balance).toBe(1234.56);
    expect(bundle.data.transactions[1].amount).toBe(99999999999.99);
  });

  it('refuses to write a backup that would silently change an amount', () => {
    // Written as an expression, not a literal: the literal itself would lose
    // precision at parse time, which is the very thing being guarded against
    // (and eslint's no-loss-of-precision rightly rejects it).
    const tooBig = MAX_EXACT_MONEY * 10;
    expect(() => buildBackupBundle({
      exportedAt: '2026-08-07T00:00:00.000Z',
      sourceUserId: 'u1',
      data: { transactions: [{ id: 'huge', amount: tooBig }] },
    })).toThrow(/lose precision/);
  });

  it('names the row and field so the offending record can be found', () => {
    expect(() => buildBackupBundle({
      exportedAt: '2026-08-07T00:00:00.000Z',
      sourceUserId: 'u1',
      data: { accounts: [{ id: 'acc-42', balance: 1e15 }] },
    })).toThrow(/acc-42.*balance/);
  });
});

// ── Re-identifying every row on the way in ──────────────────────────────────

/**
 * A backup restored into a SECOND login used to die on
 * `duplicate key value violates unique constraint "accounts_pkey"`, because
 * every id in the set is unique across the whole project rather than per user.
 * The remap gives every row a fresh id — so these tests are about the thing that
 * actually matters afterwards: whether the ROWS STILL POINT AT EACH OTHER.
 *
 * Asserting "the ids changed" would pass just as happily for a remap that
 * detached every relationship in the file, which is the exact failure a backup
 * must never have.
 */

/** A uuid-shaped id built from one hex tag, so fixtures are readable. */
const uid = (tag: string, n: number): string =>
  `${tag.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const A_CURRENT = uid('a', 1);
const A_SAVINGS = uid('a', 2);
const A_BROKER  = uid('a', 3);
const C_TRANSFER = uid('c', 1);
const C_EXPENSES = uid('c', 2);
const C_FOOD     = uid('c', 3);
const T_OUT   = uid('7', 1);
const T_IN    = uid('7', 2);
const T_SHOP  = uid('7', 3);
const S_ONE = uid('5', 1);
const S_TWO = uid('5', 2);
const GOAL = uid('9', 1);
const CONTRIB = uid('1', 1);
const BUDGET = uid('b', 1);
const INVESTMENT = uid('d', 1);
const INV_TXN = uid('e', 1);
const RECURRING = uid('2', 1);
const DISMISSAL = uid('3', 1);

/** Fresh ids in call order, so a test can say which row got which. */
const sequentialIds = (): (() => string) => {
  let n = 0;
  return () => { n += 1; return uid('f', n); };
};

/**
 * A dataset carrying one of every reference kind in the schema: nesting, a
 * transfer pair, a split parent, both spellings of a transaction's category,
 * and a dismissal keyed by transaction ids.
 */
const linkedBundle = (): ReturnType<typeof buildBackupBundle> => buildBackupBundle({
  sourceUserId: uid('0', 1),
  exportedAt: '2026-08-07T09:30:00.000Z',
  data: {
    accounts: [
      { id: A_CURRENT, name: 'Current', type: 'checking', balance: 1234.56, parent_account_id: null },
      { id: A_SAVINGS, name: 'Savings', type: 'savings', balance: 9876.54, parent_account_id: null },
      { id: A_BROKER, name: 'Broker Cash', type: 'investment', balance: 100, parent_account_id: A_SAVINGS },
    ],
    categories: [
      { id: C_TRANSFER, name: 'Transfer', level: 'type', parent_id: null, account_id: null },
      { id: C_EXPENSES, name: 'Expenses', level: 'type', parent_id: null, account_id: null },
      { id: C_FOOD, name: 'Food', level: 'sub', parent_id: C_EXPENSES, account_id: null },
    ],
    transactions: [
      {
        id: T_OUT, account_id: A_CURRENT, date: '2020-05-05', amount: -500,
        category_id: C_TRANSFER, category: C_TRANSFER,
        transfer_account_id: A_SAVINGS, linked_transfer_id: T_IN, linked_transfer_split_id: null,
      },
      {
        id: T_IN, account_id: A_SAVINGS, date: '2020-05-05', amount: 500,
        category_id: C_TRANSFER, category: C_TRANSFER,
        transfer_account_id: A_CURRENT, linked_transfer_id: T_OUT, linked_transfer_split_id: null,
      },
      {
        id: T_SHOP, account_id: A_CURRENT, date: '2021-06-06', amount: -80,
        category_id: C_FOOD, category: C_FOOD, is_split: true,
        linked_transfer_id: null, linked_transfer_split_id: null,
      },
    ],
    transaction_splits: [
      { id: S_ONE, transaction_id: T_SHOP, category: C_FOOD, amount: -50, sort_order: 0, linked_transfer_id: null },
      { id: S_TWO, transaction_id: T_SHOP, category: C_FOOD, amount: -30, sort_order: 1, linked_transfer_id: null },
    ],
    budgets: [{ id: BUDGET, name: 'Food', amount: 300, category_id: C_FOOD, category: C_FOOD }],
    // `category` here is a label a person typed, not a reference. It must
    // survive untouched and must never be counted as a dangling id.
    goals: [{ id: GOAL, name: 'New roof', account_id: A_SAVINGS, category: 'Home', target_amount: 5000 }],
    goal_contributions: [{ id: CONTRIB, goal_id: GOAL, transaction_id: T_SHOP, amount: 25 }],
    investments: [{ id: INVESTMENT, account_id: A_BROKER, symbol: 'VWRL', name: 'FTSE All-World' }],
    investment_transactions: [{ id: INV_TXN, investment_id: INVESTMENT, transaction_type: 'buy', amount: 100 }],
    recurring_transactions: [{ id: RECURRING, account_id: A_CURRENT, category: C_FOOD, description: 'Groceries', amount: -60 }],
    suggestion_dismissals: [{
      id: DISMISSAL, kind: 'duplicate',
      subject_key: canonicalSubjectKey([T_OUT, T_IN]),
      subject_ids: [T_OUT, T_IN],
    }],
  },
});

/** Look a row up by the fresh id its original was mapped to. */
const findRow = (
  rows: readonly BackupRow[],
  idMap: ReadonlyMap<string, string>,
  originalId: string
): BackupRow => {
  const row = rows.find((candidate) => candidate.id === idMap.get(originalId));
  if (!row) throw new Error(`no row for ${originalId}`);
  return row;
};

describe('remapBackupIds', () => {
  it('gives every row in every table a fresh id', () => {
    const source = linkedBundle();
    const { bundle, idMap } = remapBackupIds(source, sequentialIds());

    const originals = new Set<string>();
    for (const entity of BACKUP_ENTITIES) {
      for (const row of source.data[entity]) originals.add(String(row.id));
    }
    expect(idMap.size).toBe(originals.size);

    for (const entity of BACKUP_ENTITIES) {
      for (const row of bundle.data[entity]) {
        expect(originals.has(String(row.id))).toBe(false);
      }
    }
  });

  it('leaves no trace of any original id anywhere in the file', () => {
    // The collision proof: if a single original id survives in any field, the
    // insert can still hit a primary key that belongs to the other login.
    const source = linkedBundle();
    const { bundle } = remapBackupIds(source, sequentialIds());

    const serialised = JSON.stringify(bundle);
    for (const original of [
      A_CURRENT, A_SAVINGS, A_BROKER, C_TRANSFER, C_EXPENSES, C_FOOD,
      T_OUT, T_IN, T_SHOP, S_ONE, S_TWO, GOAL, CONTRIB, BUDGET,
      INVESTMENT, INV_TXN, RECURRING, DISMISSAL,
    ]) {
      expect(serialised).not.toContain(original);
    }
  });

  it('keeps a transfer pair pointing at each other', () => {
    const { bundle, idMap } = remapBackupIds(linkedBundle(), sequentialIds());
    const out = findRow(bundle.data.transactions, idMap, T_OUT);
    const back = findRow(bundle.data.transactions, idMap, T_IN);

    expect(out.linked_transfer_id).toBe(back.id);
    expect(back.linked_transfer_id).toBe(out.id);
    // …and each still names the OTHER account as the far side.
    expect(out.transfer_account_id).toBe(idMap.get(A_SAVINGS));
    expect(back.transfer_account_id).toBe(idMap.get(A_CURRENT));
  });

  it('keeps the transfer pair connected in the links payload too', () => {
    // The links travel separately to finalize_user_restore, which is what
    // actually re-closes the cycle — the data rows have theirs NULLed on insert.
    const { bundle, idMap } = remapBackupIds(linkedBundle(), sequentialIds());
    const links = bundle.links.transaction_links;
    expect(links).toHaveLength(2);

    const out = links.find((link) => link.id === idMap.get(T_OUT));
    const back = links.find((link) => link.id === idMap.get(T_IN));
    expect(out?.linked_transfer_id).toBe(idMap.get(T_IN));
    expect(back?.linked_transfer_id).toBe(idMap.get(T_OUT));
  });

  it('keeps every split attached to its parent transaction', () => {
    const { bundle, idMap } = remapBackupIds(linkedBundle(), sequentialIds());
    const parent = findRow(bundle.data.transactions, idMap, T_SHOP);

    expect(bundle.data.transaction_splits).toHaveLength(2);
    for (const split of bundle.data.transaction_splits) {
      expect(split.transaction_id).toBe(parent.id);
    }
  });

  it('resolves a transaction to its category by BOTH category_id and the text category', () => {
    // transactions.category is TEXT holding a category id. It is the field most
    // of the app reads, and the one a column-by-column remap forgets.
    const { bundle, idMap } = remapBackupIds(linkedBundle(), sequentialIds());
    const shop = findRow(bundle.data.transactions, idMap, T_SHOP);
    const food = findRow(bundle.data.categories, idMap, C_FOOD);

    expect(shop.category_id).toBe(food.id);
    expect(shop.category).toBe(food.id);
    // And the splits file under the same category, by the same text column.
    for (const split of bundle.data.transaction_splits) {
      expect(split.category).toBe(food.id);
    }
  });

  it('keeps a nested account under its parent, in the row and in the links', () => {
    const { bundle, idMap } = remapBackupIds(linkedBundle(), sequentialIds());
    const broker = findRow(bundle.data.accounts, idMap, A_BROKER);
    const savings = findRow(bundle.data.accounts, idMap, A_SAVINGS);

    expect(broker.parent_account_id).toBe(savings.id);
    expect(bundle.links.account_parents).toEqual([
      { id: broker.id, parent_account_id: savings.id },
    ]);
  });

  it('keeps a category under its parent category', () => {
    const { bundle, idMap } = remapBackupIds(linkedBundle(), sequentialIds());
    const food = findRow(bundle.data.categories, idMap, C_FOOD);
    const expenses = findRow(bundle.data.categories, idMap, C_EXPENSES);
    expect(food.parent_id).toBe(expenses.id);
  });

  it('keeps every remaining parent/child pair connected', () => {
    const { bundle, idMap } = remapBackupIds(linkedBundle(), sequentialIds());

    expect(findRow(bundle.data.budgets, idMap, BUDGET).category_id).toBe(idMap.get(C_FOOD));
    expect(findRow(bundle.data.budgets, idMap, BUDGET).category).toBe(idMap.get(C_FOOD));
    expect(findRow(bundle.data.goals, idMap, GOAL).account_id).toBe(idMap.get(A_SAVINGS));
    expect(findRow(bundle.data.goal_contributions, idMap, CONTRIB).goal_id).toBe(idMap.get(GOAL));
    expect(findRow(bundle.data.goal_contributions, idMap, CONTRIB).transaction_id).toBe(idMap.get(T_SHOP));
    expect(findRow(bundle.data.investments, idMap, INVESTMENT).account_id).toBe(idMap.get(A_BROKER));
    expect(findRow(bundle.data.investment_transactions, idMap, INV_TXN).investment_id).toBe(idMap.get(INVESTMENT));
    expect(findRow(bundle.data.recurring_transactions, idMap, RECURRING).account_id).toBe(idMap.get(A_CURRENT));
    expect(findRow(bundle.data.recurring_transactions, idMap, RECURRING).category).toBe(idMap.get(C_FOOD));
  });

  it('keeps subject_ids naming real transactions', () => {
    const { bundle, idMap } = remapBackupIds(linkedBundle(), sequentialIds());
    const dismissal = findRow(bundle.data.suggestion_dismissals, idMap, DISMISSAL);
    const transactionIds = new Set(bundle.data.transactions.map((row) => row.id));

    expect(dismissal.subject_ids).toEqual([idMap.get(T_OUT), idMap.get(T_IN)]);
    for (const id of dismissal.subject_ids as string[]) {
      expect(transactionIds.has(id)).toBe(true);
    }
  });

  it('rebuilds subject_key so the sweep still recognises what the user dismissed', () => {
    // subject_key is TEXT built out of row ids. Remap subject_ids but not this,
    // and every suggestion the user has already refused comes straight back —
    // the sweep recomputes the key from the new ids and matches nothing.
    const { bundle, idMap } = remapBackupIds(linkedBundle(), sequentialIds());
    const dismissal = findRow(bundle.data.suggestion_dismissals, idMap, DISMISSAL);

    const expected = canonicalSubjectKey([
      String(idMap.get(T_OUT)), String(idMap.get(T_IN)),
    ]);
    expect(dismissal.subject_key).toBe(expected);
  });

  it('re-sorts a dismissal key, because fresh ids do not sort as the originals did', () => {
    // canonicalSubjectKey sorts the ids it joins, so the stored text depends on
    // their order. Here the new ids deliberately sort the opposite way round.
    const source = buildBackupBundle({
      sourceUserId: uid('0', 1),
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: {
        transactions: [
          { id: T_OUT, date: '2020-05-05', amount: -500 },
          { id: T_IN, date: '2020-05-05', amount: 500 },
        ],
        suggestion_dismissals: [{
          id: DISMISSAL, kind: 'duplicate',
          subject_key: canonicalSubjectKey([T_OUT, T_IN]),
          subject_ids: [T_OUT, T_IN],
        }],
      },
    });

    // Ids are handed out in the order the entities are read, so the outgoing
    // leg gets ...009 and the incoming one ...002 — reversing how the pair sorts.
    const issued = [uid('f', 9), uid('f', 2), uid('f', 3)];
    let next = 0;
    const { bundle } = remapBackupIds(source, () => issued[next++]);

    expect(bundle.data.transactions.map((row) => row.id)).toEqual([uid('f', 9), uid('f', 2)]);
    expect(bundle.data.suggestion_dismissals[0].subject_key)
      .toBe(canonicalSubjectKey([uid('f', 9), uid('f', 2)]));
    // Which is to say: the stored order flipped, rather than being carried over.
    expect(bundle.data.suggestion_dismissals[0].subject_key)
      .toBe(`${uid('f', 2)}|${uid('f', 9)}`);
  });

  it('keeps the role tags in a split-leg dismissal key, and does not reorder them', () => {
    // legDismissalKey is deliberately unsorted: its halves live in different
    // tables, so the "split:" and "txn:" tags carry the meaning, not the order.
    const source = buildBackupBundle({
      sourceUserId: uid('0', 1),
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: {
        transactions: [{ id: T_SHOP, date: '2021-06-06', amount: -80 }],
        transaction_splits: [{ id: S_ONE, transaction_id: T_SHOP, amount: -50 }],
        suggestion_dismissals: [{
          id: DISMISSAL, kind: 'transfer-leg',
          subject_key: `split:${S_ONE}|txn:${T_SHOP}`,
          subject_ids: [T_SHOP],
        }],
      },
    });

    const { bundle, idMap } = remapBackupIds(source, sequentialIds());
    expect(bundle.data.suggestion_dismissals[0].subject_key)
      .toBe(`split:${idMap.get(S_ONE)}|txn:${idMap.get(T_SHOP)}`);
  });

  it('keeps the kind tag leading a stranded-finding key', () => {
    const source = buildBackupBundle({
      sourceUserId: uid('0', 1),
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: {
        transactions: [
          { id: T_OUT, date: '2020-05-05', amount: -500 },
          { id: T_IN, date: '2020-05-05', amount: 500 },
        ],
        suggestion_dismissals: [{
          id: DISMISSAL, kind: 'stranded',
          subject_key: `duplicate|${canonicalSubjectKey([T_OUT, T_IN])}`,
          subject_ids: [T_OUT, T_IN],
        }],
      },
    });

    const { bundle, idMap } = remapBackupIds(source, sequentialIds());
    expect(bundle.data.suggestion_dismissals[0].subject_key).toBe(
      `duplicate|${canonicalSubjectKey([String(idMap.get(T_OUT)), String(idMap.get(T_IN))])}`
    );
  });

  it('carries a payee-cleanup key through untouched — it names text, not rows', () => {
    // Payee cleanup's refusals are about payee TEXT, so their key must come out
    // of a restore character for character: rewrite any part of it and every
    // suggestion the owner refused is offered all over again.
    //
    // The adversarial case, deliberately: one payee's text IS one of the file's
    // own transaction ids, and the merchant token is uuid-shaped too. Both would
    // be rewritten if they reached the remapper as bare segments — the role
    // prefix and the tag inside each value are what stop them.
    const uuidShapedMerchant = 'abcdefab-cdef-abcd-efab-cdefabcdefab';
    const groupKey = payeeMerchantDismissalKey(uuidShapedMerchant);
    const lineKey = payeeLineDismissalKey(uuidShapedMerchant, T_SHOP);
    // The hidden kind is the sharpest case of the three: ONE segment, and the
    // payee text inside it is one of the file's own transaction ids. A bare
    // segment there would be looked up, found, and rewritten — and the payee
    // the owner struck off his cleanup screen would be back on it.
    const hiddenKey = payeeHiddenDismissalKey(T_SHOP);

    const source = buildBackupBundle({
      sourceUserId: uid('0', 1),
      exportedAt: '2026-08-08T09:30:00.000Z',
      data: {
        transactions: [{ id: T_SHOP, date: '2021-06-06', amount: -80 }],
        suggestion_dismissals: [
          { id: DISMISSAL, kind: 'payee-merchant', subject_key: groupKey, subject_ids: [] },
          { id: uid('3', 2), kind: 'payee-line', subject_key: lineKey, subject_ids: [] },
          { id: uid('3', 3), kind: 'payee-hidden', subject_key: hiddenKey, subject_ids: [] },
        ],
      },
    });

    const { bundle, idMap, danglingRefs } = remapBackupIds(source, sequentialIds());

    // The transaction really did get a fresh id — so this is not vacuous.
    expect(bundle.data.transactions[0].id).toBe(idMap.get(T_SHOP));
    expect(bundle.data.transactions[0].id).not.toBe(T_SHOP);

    expect(bundle.data.suggestion_dismissals[0].subject_key).toBe(groupKey);
    expect(bundle.data.suggestion_dismissals[1].subject_key).toBe(lineKey);
    expect(bundle.data.suggestion_dismissals[2].subject_key).toBe(hiddenKey);
    // Character for character, including the id-shaped payee text inside it.
    expect(bundle.data.suggestion_dismissals[2].subject_key).toContain(T_SHOP);
    // And nothing in any of the three keys was mistaken for a reference that
    // went nowhere.
    expect(danglingRefs).toEqual([]);
  });

  it('reports nothing dangling for a file whose references all resolve', () => {
    const { danglingRefs } = remapBackupIds(linkedBundle(), sequentialIds());
    expect(danglingRefs).toEqual([]);
  });

  it("rewrites a goal's linked accounts, which live inside the metadata jsonb", () => {
    // goals has no column for them, so planningService.goalToDb parks them in
    // metadata. Left alone, a restored goal still names the accounts of the
    // login the file came from — and nothing constrains a jsonb key, so it
    // fails silently.
    const source = buildBackupBundle({
      sourceUserId: uid('0', 1),
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: {
        accounts: [
          { id: A_CURRENT, name: 'Current', balance: 0 },
          { id: A_SAVINGS, name: 'Savings', balance: 0 },
        ],
        goals: [{
          id: uid('9', 1), name: 'Rainy day', target_amount: 5000,
          metadata: {
            type: 'savings',
            linkedAccountIds: [A_CURRENT, A_SAVINGS],
            // A user's own words, in the same object. They must come through
            // exactly as written.
            note: 'for the roof',
          },
        }],
      },
    });

    const { bundle, idMap } = remapBackupIds(source, sequentialIds());
    expect(bundle.data.goals[0].metadata).toEqual({
      type: 'savings',
      linkedAccountIds: [idMap.get(A_CURRENT), idMap.get(A_SAVINGS)],
      note: 'for the roof',
    });
  });

  it('rewrites the account and category ids inside a report’s filters', () => {
    // The same failure as the goal's metadata above, in the entity that arrived
    // in slice 32 — and the reason `metadataIdArrays` became `jsonbIdArrays`:
    // the old spec could only describe keys inside a column literally named
    // `metadata`, and a report keeps its references in `filters`.
    //
    // Left alone, a restored report is filtered to accounts and categories that
    // belong to the login the FILE came from. It does not error: it draws, and
    // it draws nothing, because no transaction in the new login matches any of
    // them. A report that silently reports on nothing is worse than one that
    // refuses to open.
    const source = buildBackupBundle({
      sourceUserId: uid('0', 1),
      exportedAt: '2026-08-12T09:30:00.000Z',
      data: {
        accounts: [
          { id: A_CURRENT, name: 'Current', balance: 0 },
          { id: A_SAVINGS, name: 'Savings', balance: 0 },
        ],
        categories: [{ id: C_FOOD, name: 'Food', level: 'detail' }],
        custom_reports: [{
          id: uid('c', 1),
          name: 'Where it went',
          components: [{ id: 'one', type: 'summary-stats', title: 'Key figures' }],
          filters: {
            dateRange: 'quarter',
            accounts: [A_CURRENT, A_SAVINGS],
            categories: [C_FOOD],
            // Labels, NOT ids. These must come through character for character:
            // a tag that got remapped would filter to a tag nobody ever typed.
            tags: ['holiday', 'roof'],
          },
        }],
      },
    });

    const { bundle, idMap } = remapBackupIds(source, sequentialIds());
    const report = bundle.data.custom_reports[0];

    expect(report.filters).toEqual({
      dateRange: 'quarter',
      accounts: [idMap.get(A_CURRENT), idMap.get(A_SAVINGS)],
      categories: [idMap.get(C_FOOD)],
      tags: ['holiday', 'roof'],
    });
    // And the report itself got a fresh id, like every other row in the file.
    expect(report.id).toBe(idMap.get(uid('c', 1)));
  });

  it('leaves a report’s components alone, because they name no rows', () => {
    // The other half of the spec: `jsonbIdArrays` names `filters` and NOT
    // `components`, so a component's config travels untouched. A remapper that
    // walked the whole row looking for uuid-shaped strings would rewrite
    // whatever a person had typed into a text block.
    const source = buildBackupBundle({
      sourceUserId: uid('0', 1),
      exportedAt: '2026-08-12T09:30:00.000Z',
      data: {
        accounts: [{ id: A_CURRENT, name: 'Current', balance: 0 }],
        custom_reports: [{
          id: uid('c', 2),
          name: 'Notes',
          components: [{
            id: 'text-1', type: 'text-block', title: 'Why',
            config: { content: `About account ${A_CURRENT}` },
          }],
          filters: { dateRange: 'month' },
        }],
      },
    });

    const { bundle } = remapBackupIds(source, sequentialIds());
    expect(bundle.data.custom_reports[0].components).toEqual([{
      id: 'text-1', type: 'text-block', title: 'Why',
      config: { content: `About account ${A_CURRENT}` },
    }]);
  });

  it('rewrites a text id that is not shaped like a uuid', () => {
    // A signed-out user's categories are seeded with text ids
    // ('type-income', 'transfer-in' — data/defaultCategories), and the cloud
    // only mints uuids for them on first sign-in. Judging a reference by its
    // SHAPE left categories[].id remapped and transactions.category not, so a
    // restore of that dataset came back entirely uncategorised.
    const source = buildBackupBundle({
      sourceUserId: uid('0', 1),
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: {
        accounts: [{ id: A_CURRENT, name: 'Current', balance: 0 }],
        categories: [{ id: 'type-expense', name: 'Expenses', level: 'type' }],
        transactions: [{
          id: T_SHOP, account_id: A_CURRENT, date: '2021-06-06', amount: -80,
          category: 'type-expense',
        }],
      },
    });

    const { bundle, idMap, danglingRefs } = remapBackupIds(source, sequentialIds());
    expect(bundle.data.transactions[0].category).toBe(idMap.get('type-expense'));
    expect(bundle.data.categories[0].id).toBe(idMap.get('type-expense'));
    expect(danglingRefs).toEqual([]);
  });

  it('still leaves a free-text label alone and does not report it', () => {
    // The other half of the same judgement: goals.category holds a word a
    // person typed. It names no row, and there is nothing wrong with that.
    const source = buildBackupBundle({
      sourceUserId: uid('0', 1),
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: { goals: [{ id: uid('9', 1), name: 'Trip', category: 'Holiday' }] },
    });

    const { bundle, danglingRefs } = remapBackupIds(source, sequentialIds());
    expect(bundle.data.goals[0].category).toBe('Holiday');
    expect(danglingRefs).toEqual([]);
  });

  it('leaves an unresolvable reference alone and counts it', () => {
    // A category that never made it into the file. Blanking it would destroy
    // the only record of where the row was filed; the honest move is to leave
    // it and say so.
    const missing = uid('c', 9);
    const source = buildBackupBundle({
      sourceUserId: uid('0', 1),
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: {
        accounts: [{ id: A_CURRENT, name: 'Current', balance: 0 }],
        transactions: [{
          id: T_SHOP, account_id: A_CURRENT, date: '2021-06-06', amount: -80,
          category_id: missing, category: missing,
        }],
      },
    });

    const { bundle, danglingRefs } = remapBackupIds(source, sequentialIds());
    const shop = bundle.data.transactions[0];
    expect(shop.category_id).toBe(missing);
    expect(shop.category).toBe(missing);

    expect(danglingRefs).toHaveLength(2);
    expect(danglingRefs.map((ref) => ref.field).sort()).toEqual(['category', 'category_id']);
    expect(danglingRefs.every((ref) => ref.value === missing)).toBe(true);
    expect(danglingRefs.every((ref) => ref.entity === 'transactions')).toBe(true);
    // Named by the id it will carry AFTER the restore, so it can be looked up.
    expect(danglingRefs.every((ref) => ref.rowId === shop.id)).toBe(true);
  });

  it('does not mistake a free-text label for a broken reference', () => {
    // goals.category holds whatever the user typed. Counting "Home" as a
    // dangling id would bury the real ones under noise.
    const { bundle, idMap, danglingRefs } = remapBackupIds(linkedBundle(), sequentialIds());
    expect(findRow(bundle.data.goals, idMap, GOAL).category).toBe('Home');
    expect(danglingRefs).toEqual([]);
  });

  it('does not touch the bundle it was given', () => {
    // A failed restore has to be retriable from the file exactly as it was read.
    const source = linkedBundle();
    const before = JSON.stringify(source);
    remapBackupIds(source, sequentialIds());
    expect(JSON.stringify(source)).toBe(before);
  });

  it('leaves user_id alone, because the database re-owns every row itself', () => {
    const source = buildBackupBundle({
      sourceUserId: uid('0', 1),
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: { accounts: [{ id: A_CURRENT, user_id: uid('0', 1), name: 'Current', balance: 0 }] },
    });
    const { bundle, danglingRefs } = remapBackupIds(source, sequentialIds());
    expect(bundle.data.accounts[0].user_id).toBe(uid('0', 1));
    expect(danglingRefs).toEqual([]);
  });

  it('does not touch money', () => {
    const { bundle, idMap } = remapBackupIds(linkedBundle(), sequentialIds());
    expect(findRow(bundle.data.accounts, idMap, A_CURRENT).balance).toBe(1234.56);
    expect(findRow(bundle.data.accounts, idMap, A_SAVINGS).balance).toBe(9876.54);
    expect(findRow(bundle.data.transactions, idMap, T_OUT).amount).toBe(-500);
    expect(findRow(bundle.data.transactions, idMap, T_IN).amount).toBe(500);
  });

  it('preserves every non-reference column verbatim', () => {
    // updated_at survival is the whole point of the INSERT-only restore, so the
    // remap must not become the thing that rewrites history instead.
    const source = buildBackupBundle({
      sourceUserId: uid('0', 1),
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: {
        transactions: [{
          id: T_SHOP, account_id: A_CURRENT, date: '2021-06-06', amount: -80,
          description: 'Big Shop', notes: 'weekly', tags: ['food', 'weekly'],
          created_at: '2021-06-06T00:00:00.000Z', updated_at: '2021-06-06T00:00:00.000Z',
        }],
      },
    });
    const { bundle } = remapBackupIds(source, sequentialIds());
    const shop = bundle.data.transactions[0];
    expect(shop.description).toBe('Big Shop');
    expect(shop.notes).toBe('weekly');
    expect(shop.tags).toEqual(['food', 'weekly']);
    expect(shop.created_at).toBe('2021-06-06T00:00:00.000Z');
    expect(shop.updated_at).toBe('2021-06-06T00:00:00.000Z');
  });
});

// ── Preferences, the half a restore used to lose ─────────────────────────────

describe('preferences in a backup', () => {
  it('an old file with no preferences section restores as carrying none', () => {
    // Not as "this user had none" — as "this file does not say". The difference
    // matters, because the restore must not overwrite a real document with an
    // empty one on the strength of an older file's silence.
    const parsed = goodBundle();
    delete parsed.preferences;
    const validation = validateBackupBundle(parsed);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.bundle.preferences).toBeNull();
    expect(preferenceCount(validation.bundle)).toBe(0);
  });

  it('carries a document through the file and back out', () => {
    const parsed = goodBundle({
      preferences: {
        version: 1,
        values: { accountsSortMode: 'balance-desc', 'a.key.from.a.newer.build': 'on' },
      },
    });
    const validation = validateBackupBundle(parsed);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.bundle.preferences?.values.accountsSortMode).toBe('balance-desc');
    // A key this build has never heard of survives the round trip.
    expect(validation.bundle.preferences?.values['a.key.from.a.newer.build']).toBe('on');
    expect(preferenceCount(validation.bundle)).toBe(2);
  });

  it('refuses nothing over a preference it cannot parse', () => {
    // A toggle must never be able to cost someone their transactions.
    const validation = validateBackupBundle(goodBundle({ preferences: 'not a document' }));
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.bundle.preferences?.values).toEqual({});
  });
});

describe('remapPreferenceIds', () => {
  const lookup = (id: string): string | undefined => (id === 'a-1' ? 'a-1-new' : undefined);

  it('rewrites the account ids in a pinned-accounts list', () => {
    // Left as they were, these would name accounts belonging to the login the
    // file came from — and fail silently, because nothing constrains a string
    // inside a jsonb document.
    const next = remapPreferenceIds(
      { version: 1, values: { dashboardKeyAccounts: '["a-1"]' } },
      lookup,
      () => {}
    );
    expect(JSON.parse(next.values.dashboardKeyAccounts)).toEqual(['a-1-new']);
  });

  it('rewrites the budget ids in the dashboard’s key-budgets list — the same map, the same silence otherwise', () => {
    const next = remapPreferenceIds(
      { version: 1, values: { dashboardKeyBudgets: '["a-1"]' } },
      lookup,
      () => {}
    );
    expect(JSON.parse(next.values.dashboardKeyBudgets)).toEqual(['a-1-new']);
  });

  it('rewrites the account ids a per-account archive cutoff is keyed BY', () => {
    const next = remapPreferenceIds(
      { version: 1, values: { 'archiveManager.overrides.v1': '{"a-1":{"date":"2020-01-01","acknowledged":true}}' } },
      lookup,
      () => {}
    );
    expect(JSON.parse(next.values['archiveManager.overrides.v1'])).toEqual({
      'a-1-new': { date: '2020-01-01', acknowledged: true },
    });
  });

  it('leaves a preference it cannot parse exactly as it found it', () => {
    // It may be a newer client's key. A preference we cannot read is still a
    // preference somebody set.
    const next = remapPreferenceIds(
      { version: 1, values: { dashboardKeyAccounts: 'not json at all' } },
      lookup,
      () => {}
    );
    expect(next.values.dashboardKeyAccounts).toBe('not json at all');
  });

  it('leaves preferences that hold no ids completely alone', () => {
    const values = { accountsSortMode: 'name', netWorthChartType: 'bar' };
    expect(remapPreferenceIds({ version: 1, values }, lookup, () => {}).values).toEqual(values);
  });

  it('reports an id that names no row in the file, and leaves it in place', () => {
    const dangling: string[] = [];
    const next = remapPreferenceIds(
      { version: 1, values: { dashboardKeyAccounts: `["${uid('9', 1)}"]` } },
      lookup,
      (_key, value) => dangling.push(value)
    );
    expect(dangling).toEqual([uid('9', 1)]);
    expect(JSON.parse(next.values.dashboardKeyAccounts)).toEqual([uid('9', 1)]);
  });
});

describe('remapBackupIds — preferences', () => {
  it('rewrites the preference ids with the same map every row gets', () => {
    const source = buildBackupBundle({
      sourceUserId: uid('0', 1),
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: { accounts: [account({ id: A_CURRENT })] },
      preferences: { version: 1, values: { dashboardKeyAccounts: `["${A_CURRENT}"]` } },
    });

    const { bundle, idMap } = remapBackupIds(source, sequentialIds());

    const pinned: unknown = JSON.parse(bundle.preferences?.values.dashboardKeyAccounts ?? '[]');
    expect(pinned).toEqual([idMap.get(A_CURRENT)]);
    // …and it is the account actually restored, not a stale id.
    expect(pinned).toEqual([bundle.data.accounts[0].id]);
  });

  it('leaves a file with no preferences with none', () => {
    const source = buildBackupBundle({
      sourceUserId: uid('0', 1),
      exportedAt: '2026-08-07T09:30:00.000Z',
      data: { accounts: [account()] },
    });
    expect(remapBackupIds(source, sequentialIds()).bundle.preferences).toBeNull();
  });
});
