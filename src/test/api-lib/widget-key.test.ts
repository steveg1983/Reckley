import { describe, it, expect, vi } from 'vitest';
import {
  bearerOf,
  cleanWidgetLabel,
  hashWidgetKey,
  isWidgetKeyShaped,
  LAST_USED_STAMP_INTERVAL_MS,
  mintWidgetKey,
  verifyWidgetKey,
  type WidgetKeyRow,
  type WidgetKeyStore,
} from '../../../api/_lib/widget-key';

/**
 * THE WIDGET'S KEY — what one is, and that only a live one is let in.
 * Every key here is minted in the test or invented (public repo).
 */

const NOW = new Date('2026-11-10T12:00:00.000Z');

function storeHolding(rows: Record<string, WidgetKeyRow>, stamp: (id: string, at: string) => Promise<void> = async () => undefined) {
  const store: WidgetKeyStore = {
    findByHash: vi.fn(async (hash: string) => rows[hash] ?? null),
    stampUsed: vi.fn(stamp),
  };
  return store;
}

const row = (over: Partial<WidgetKeyRow> = {}): WidgetKeyRow => ({
  id: 'key-1',
  user_id: 'user-1',
  last_used_at: null,
  revoked_at: null,
  ...over,
});

describe('a widget key', () => {
  it('is prefixed, 32 random bytes long, and never the same twice', () => {
    const a = mintWidgetKey();
    const b = mintWidgetKey();
    expect(a).toMatch(/^rkw_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(isWidgetKeyShaped(a)).toBe(true);
  });

  it('is stored as a SHA-256 in lower-case hex — the shape the table checks for', () => {
    expect(hashWidgetKey(mintWidgetKey())).toMatch(/^[0-9a-f]{64}$/);
    expect(hashWidgetKey('rkw_same')).toBe(hashWidgetKey('rkw_same'));
  });

  it('is not anything else that arrives as a bearer', () => {
    expect(isWidgetKeyShaped('eyJhbGciOiJSUzI1NiJ9.a.b')).toBe(false);
    expect(isWidgetKeyShaped('rkw_short')).toBe(false);
    expect(isWidgetKeyShaped(`rkw_${'a'.repeat(44)}`)).toBe(false);
    expect(isWidgetKeyShaped(`rkw_${'a'.repeat(42)}!`)).toBe(false);
  });
});

describe('bearerOf', () => {
  it('reads the token, from a header given once or as a list', () => {
    expect(bearerOf('Bearer abc')).toBe('abc');
    expect(bearerOf(['Bearer abc', 'Bearer def'])).toBe('abc');
  });

  it('is null for no header, another scheme, or an empty token', () => {
    expect(bearerOf(undefined)).toBeNull();
    expect(bearerOf('Basic abc')).toBeNull();
    expect(bearerOf('Bearer   ')).toBeNull();
  });
});

describe('cleanWidgetLabel', () => {
  it('keeps a short name, on one line, and nothing else', () => {
    expect(cleanWidgetLabel('  iPhone  ')).toBe('iPhone');
    expect(cleanWidgetLabel('a\nb\tc')).toBe('a b c');
    expect(cleanWidgetLabel('x'.repeat(200))).toHaveLength(80);
    expect(cleanWidgetLabel('   ')).toBeNull();
    expect(cleanWidgetLabel(42)).toBeNull();
    expect(cleanWidgetLabel(undefined)).toBeNull();
  });
});

describe('verifyWidgetKey', () => {
  it('lets a live key in as its owner, and looks it up by hash — the key never reaches the store', async () => {
    const key = mintWidgetKey();
    const store = storeHolding({ [hashWidgetKey(key)]: row() });
    await expect(verifyWidgetKey(store, `Bearer ${key}`, NOW)).resolves.toEqual({ userId: 'user-1', keyId: 'key-1' });
    expect(store.findByHash).toHaveBeenCalledWith(hashWidgetKey(key));
    expect(JSON.stringify(vi.mocked(store.findByHash).mock.calls)).not.toContain(key);
  });

  it('answers a revoked key, an unknown key, a malformed one and none at all the same way', async () => {
    const revoked = mintWidgetKey();
    const store = storeHolding({ [hashWidgetKey(revoked)]: row({ revoked_at: '2026-11-09T00:00:00.000Z' }) });
    await expect(verifyWidgetKey(store, `Bearer ${revoked}`, NOW)).resolves.toBeNull();
    await expect(verifyWidgetKey(store, `Bearer ${mintWidgetKey()}`, NOW)).resolves.toBeNull();
    await expect(verifyWidgetKey(store, 'Bearer not-a-widget-key', NOW)).resolves.toBeNull();
    await expect(verifyWidgetKey(store, undefined, NOW)).resolves.toBeNull();
  });

  it('does not ask the database about a string that is not shaped like a key', async () => {
    const store = storeHolding({});
    await verifyWidgetKey(store, 'Bearer eyJhbGciOiJSUzI1NiJ9.a.b', NOW);
    expect(store.findByHash).not.toHaveBeenCalled();
  });

  it('stamps a first use, and then at most once an hour', async () => {
    const key = mintWidgetKey();
    const header = `Bearer ${key}`;

    const fresh = storeHolding({ [hashWidgetKey(key)]: row() });
    await verifyWidgetKey(fresh, header, NOW);
    expect(fresh.stampUsed).toHaveBeenCalledWith('key-1', NOW.toISOString());

    const recent = storeHolding({
      [hashWidgetKey(key)]: row({ last_used_at: new Date(NOW.getTime() - LAST_USED_STAMP_INTERVAL_MS + 1000).toISOString() }),
    });
    await verifyWidgetKey(recent, header, NOW);
    expect(recent.stampUsed).not.toHaveBeenCalled();

    const stale = storeHolding({
      [hashWidgetKey(key)]: row({ last_used_at: new Date(NOW.getTime() - LAST_USED_STAMP_INTERVAL_MS).toISOString() }),
    });
    await verifyWidgetKey(stale, header, NOW);
    expect(stale.stampUsed).toHaveBeenCalledTimes(1);
  });

  it('a stamp that fails does not cost the widget its answer', async () => {
    const key = mintWidgetKey();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = storeHolding({ [hashWidgetKey(key)]: row() }, async () => {
      throw new Error('database is having a moment');
    });
    await expect(verifyWidgetKey(store, `Bearer ${key}`, NOW)).resolves.toEqual({ userId: 'user-1', keyId: 'key-1' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
