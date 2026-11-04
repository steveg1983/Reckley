/**
 * The storage-generation migration, proven against the REAL storage stack.
 *
 * `fake-indexeddb` stands in for the browser's IndexedDB; everything above it —
 * `indexedDBService`, `encryptedStorage`, the AES key in localStorage — is the
 * shipping code. The test that matters most is the second one: a record
 * written under the OLD key, encrypted with the device key, is readable under
 * the NEW key after migration, and the stored envelope is byte-identical. That
 * is the proof that the copy preserved the ciphertext and that `wt_enc_key`
 * (deliberately not renamed) still decrypts it.
 *
 * Generation 2 (the delete pass) adds the mirror proof: the old copy is gone
 * afterwards, and it is NEVER gone where the copy did not land.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { KEY_PREFIX } from '../../brand';
import { encryptedStorage, STORAGE_KEYS } from '../../services/encryptedStorageService';
import { indexedDBService } from '../../services/indexedDBService';
import { storageAdapter } from '../../services/storageAdapter';
import {
  LOCAL_MOVES,
  LOCAL_ONLY_MOVES,
  RECORD_MOVES,
  STORAGE_GENERATION,
  STORAGE_GENERATION_KEY,
  migrateStorage,
  type MigrationReport,
  type RecordStore,
} from '../storageMigration';

const SECURE_STORE = 'secureData';

type Envelope = { key: string; data: unknown; encrypted?: boolean; timestamp?: number };

const NOTHING_DONE: MigrationReport = {
  skipped: false,
  localCopied: [],
  recordsCopied: [],
  localRemoved: [],
  recordsRemoved: [],
};

beforeEach(async () => {
  await storageAdapter.clear();
  window.localStorage.clear();
});

describe('the move table agrees with STORAGE_KEYS', () => {
  it('every renamed STORAGE_KEYS member has a move, and every move lands on one', () => {
    const renamed = Object.values(STORAGE_KEYS).filter(value => value.startsWith(`${KEY_PREFIX}_`));
    const targets = RECORD_MOVES.map(([, to]) => to);
    expect([...targets].sort()).toEqual([...renamed].sort());
  });

  it('each move keeps the suffix and only swaps the prefix', () => {
    for (const [from, to] of [...RECORD_MOVES, ...LOCAL_ONLY_MOVES]) {
      expect(from.startsWith('wealthtracker_')).toBe(true);
      expect(to).toBe(`${KEY_PREFIX}_${from.slice('wealthtracker_'.length)}`);
    }
  });

  it('the preference generation is left alone', () => {
    const untouched = Object.values(STORAGE_KEYS).filter(value => value.startsWith('money_management_'));
    expect(untouched.length).toBeGreaterThan(0);
    for (const key of untouched) {
      expect(RECORD_MOVES.some(([from]) => from === key)).toBe(false);
    }
  });

  it('this build is generation 2: the delete pass', () => {
    expect(STORAGE_GENERATION).toBe(2);
  });
});

describe('migrateStorage against the real stack', () => {
  it('a record encrypted under the old key reads back under the new one, envelope untouched, old copy gone', async () => {
    const accounts = [{ id: 'acc-1', name: 'Current', balance: '1234.56' }];
    await encryptedStorage.setItem('wealthtracker_accounts', accounts, { encrypted: true });
    const old = await indexedDBService.get<Envelope>(SECURE_STORE, 'wealthtracker_accounts');
    expect(old).toBeDefined();

    const report = await migrateStorage();

    expect(report.skipped).toBe(false);
    expect(report.recordsCopied).toContain(STORAGE_KEYS.ACCOUNTS);
    expect(report.recordsRemoved).toContain('wealthtracker_accounts');
    expect(await encryptedStorage.getItem(STORAGE_KEYS.ACCOUNTS)).toEqual(accounts);

    // The ciphertext was carried verbatim, not re-encrypted …
    const moved = await indexedDBService.get<Envelope>(SECURE_STORE, STORAGE_KEYS.ACCOUNTS);
    expect(moved).toBeDefined();
    expect(moved?.data).toBe(old?.data);
    expect(moved?.encrypted).toBe(old?.encrypted);
    expect(moved?.timestamp).toBe(old?.timestamp);
    expect(moved?.key).toBe(STORAGE_KEYS.ACCOUNTS);
    // … and the old copy is gone.
    expect(await indexedDBService.get<Envelope>(SECURE_STORE, 'wealthtracker_accounts')).toBeUndefined();
  });

  it('a device already at generation 1 loses only the old copies, and the new one still decrypts', async () => {
    // What #580 left behind on every device that booted between the two
    // releases: both copies present, watermark 1.
    const budgets = [{ id: 'b-1', amount: '250.00' }];
    await encryptedStorage.setItem('wealthtracker_budgets', budgets, { encrypted: true });
    const old = await indexedDBService.get<Envelope>(SECURE_STORE, 'wealthtracker_budgets');
    await indexedDBService.put(SECURE_STORE, { ...(old as Envelope), key: STORAGE_KEYS.BUDGETS });
    window.localStorage.setItem('wealthtracker_import_rules', 'rules');
    window.localStorage.setItem(`${KEY_PREFIX}_import_rules`, 'rules');
    window.localStorage.setItem(STORAGE_GENERATION_KEY, '1');

    const report = await migrateStorage();

    expect(report.recordsCopied).toEqual([]);
    expect(report.localCopied).toEqual([]);
    expect(report.recordsRemoved).toEqual(['wealthtracker_budgets']);
    expect(report.localRemoved).toEqual(['wealthtracker_import_rules']);
    expect(await encryptedStorage.getItem(STORAGE_KEYS.BUDGETS)).toEqual(budgets);
    expect(await indexedDBService.get(SECURE_STORE, 'wealthtracker_budgets')).toBeUndefined();
    expect(window.localStorage.getItem('wealthtracker_import_rules')).toBeNull();
    expect(window.localStorage.getItem(`${KEY_PREFIX}_import_rules`)).toBe('rules');
    expect(window.localStorage.getItem(STORAGE_GENERATION_KEY)).toBe('2');
  });

  it('copies every localStorage key in the table, deletes the old ones, and writes the watermark last', async () => {
    for (const [from] of LOCAL_MOVES) {
      window.localStorage.setItem(from, `value-of-${from}`);
    }

    const report = await migrateStorage();

    for (const [from, to] of LOCAL_MOVES) {
      expect(window.localStorage.getItem(to)).toBe(`value-of-${from}`);
      expect(window.localStorage.getItem(from)).toBeNull();
    }
    expect(report.localCopied.length).toBe(LOCAL_MOVES.length);
    expect(report.localRemoved.length).toBe(LOCAL_MOVES.length);
    expect(window.localStorage.getItem(STORAGE_GENERATION_KEY)).toBe(String(STORAGE_GENERATION));
  });

  it('is idempotent: a second run is a no-op and says so', async () => {
    await encryptedStorage.setItem('wealthtracker_budgets', [{ id: 'b-1' }], { encrypted: true });
    const first = await migrateStorage();
    const second = await migrateStorage();
    const third = await migrateStorage();

    expect(first.recordsCopied).toContain(STORAGE_KEYS.BUDGETS);
    expect(second).toEqual({ ...NOTHING_DONE, skipped: true });
    expect(third).toEqual({ ...NOTHING_DONE, skipped: true });
  });

  it('never clobbers a value already under the new name, and still deletes the old one', async () => {
    await encryptedStorage.setItem('wealthtracker_goals', [{ id: 'old' }], { encrypted: true });
    await encryptedStorage.setItem(STORAGE_KEYS.GOALS, [{ id: 'newer' }], { encrypted: true });
    window.localStorage.setItem('wealthtracker_import_rules', 'old-rules');
    window.localStorage.setItem(`${KEY_PREFIX}_import_rules`, 'newer-rules');

    const report = await migrateStorage();

    expect(report.recordsCopied).not.toContain(STORAGE_KEYS.GOALS);
    expect(report.recordsRemoved).toContain('wealthtracker_goals');
    expect(await encryptedStorage.getItem(STORAGE_KEYS.GOALS)).toEqual([{ id: 'newer' }]);
    expect(await indexedDBService.get(SECURE_STORE, 'wealthtracker_goals')).toBeUndefined();
    expect(window.localStorage.getItem(`${KEY_PREFIX}_import_rules`)).toBe('newer-rules');
    expect(window.localStorage.getItem('wealthtracker_import_rules')).toBeNull();
  });

  it('a device with nothing to migrate just records the generation', async () => {
    const report = await migrateStorage();
    expect(report).toEqual(NOTHING_DONE);
    expect(window.localStorage.getItem(STORAGE_GENERATION_KEY)).toBe(String(STORAGE_GENERATION));
  });
});

describe('migrateStorage when a store is missing or failing', () => {
  it('withholds the watermark when the record pass fails, and completes on the next boot', async () => {
    const envelope: Envelope = { key: 'wealthtracker_transactions', data: 'ciphertext', encrypted: true };
    const failing: RecordStore = {
      get: async <T,>(_store: string, key: IDBValidKey) =>
        (key === 'wealthtracker_transactions' ? (envelope as unknown as T) : undefined),
      put: async () => {
        throw new Error('QuotaExceededError');
      },
      delete: async () => {
        throw new Error('must not be reached: nothing was copied');
      },
    };

    const first = await migrateStorage({ local: window.localStorage, records: failing });
    expect(first.recordsFailed).toContain('QuotaExceededError');
    expect(window.localStorage.getItem(STORAGE_GENERATION_KEY)).toBeNull();

    const written = new Map<string, Envelope>([['wealthtracker_transactions', envelope]]);
    const working: RecordStore = {
      get: async <T,>(_store: string, key: IDBValidKey) => written.get(String(key)) as T | undefined,
      put: async (_store, data) => {
        written.set(String((data as Envelope).key), data as unknown as Envelope);
      },
      delete: async (_store, key) => {
        written.delete(String(key));
      },
    };

    const second = await migrateStorage({ local: window.localStorage, records: working });
    expect(second.skipped).toBe(false);
    expect(second.recordsCopied).toEqual([STORAGE_KEYS.TRANSACTIONS]);
    expect(second.recordsRemoved).toEqual(['wealthtracker_transactions']);
    expect(written.get(STORAGE_KEYS.TRANSACTIONS)?.data).toBe('ciphertext');
    expect(written.has('wealthtracker_transactions')).toBe(false);
    expect(window.localStorage.getItem(STORAGE_GENERATION_KEY)).toBe(String(STORAGE_GENERATION));
  });

  it('withholds the watermark when the delete pass fails, keeping both copies for the next boot', async () => {
    const envelope: Envelope = { key: 'wealthtracker_tags', data: 'ciphertext', encrypted: true };
    const written = new Map<string, Envelope>([['wealthtracker_tags', envelope]]);
    const copiesButCannotDelete: RecordStore = {
      get: async <T,>(_store: string, key: IDBValidKey) => written.get(String(key)) as T | undefined,
      put: async (_store, data) => {
        written.set(String((data as Envelope).key), data as unknown as Envelope);
      },
      delete: async () => {
        throw new Error('ReadOnlyError');
      },
    };

    const report = await migrateStorage({ local: window.localStorage, records: copiesButCannotDelete });

    expect(report.recordsCopied).toEqual([STORAGE_KEYS.TAGS]);
    expect(report.recordsRemoved).toEqual([]);
    expect(report.recordsFailed).toContain('ReadOnlyError');
    expect(written.get(STORAGE_KEYS.TAGS)?.data).toBe('ciphertext');
    expect(written.has('wealthtracker_tags')).toBe(true);
    expect(window.localStorage.getItem(STORAGE_GENERATION_KEY)).toBeNull();
  });

  it('runs to completion with no localStorage and no IndexedDB at all', async () => {
    await expect(migrateStorage({ local: null, records: null })).resolves.toEqual(NOTHING_DONE);
  });

  it('a localStorage that throws on write does not stop the other keys, and the uncopied old key is KEPT', async () => {
    const backing = new Map<string, string>([
      ['wealthtracker_import_rules', 'rules'],
      ['wealthtracker_error_log', 'log'],
    ]);
    const flaky = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === `${KEY_PREFIX}_import_rules`) throw new Error('blocked');
        backing.set(key, value);
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
    };

    const report = await migrateStorage({ local: flaky, records: null });

    expect(report.localCopied).toEqual([`${KEY_PREFIX}_error_log`]);
    expect(report.localRemoved).toEqual(['wealthtracker_error_log']);
    expect(backing.get(`${KEY_PREFIX}_error_log`)).toBe('log');
    expect(backing.has('wealthtracker_error_log')).toBe(false);
    // The copy of import_rules never landed, so its old key is the only copy. Kept.
    expect(backing.get('wealthtracker_import_rules')).toBe('rules');
    expect(backing.has(`${KEY_PREFIX}_import_rules`)).toBe(false);
    expect(backing.get(STORAGE_GENERATION_KEY)).toBe(String(STORAGE_GENERATION));
  });
});
