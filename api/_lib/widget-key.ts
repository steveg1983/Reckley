/**
 * The home-screen widget's key: what it is made of, and how one is checked.
 *
 * A widget is native code beside the app's web view. It has no Clerk session
 * and the owner's ruling (10 Nov 2026) is that it fetches for itself, so it
 * carries a credential of its own. The whole design is to make that
 * credential worth as little as possible to anyone who finds one:
 *
 *   * It opens ONE route — the budget summary — and the route can only read.
 *   * The server keeps a SHA-256 of it, never the key (`widget_keys`). The
 *     key is 32 random bytes, so the hash is not guessable back and needs no
 *     salt or slow hash: there is no dictionary to run against it.
 *   * It is checked by looking its hash up. No comparison of secrets happens
 *     in this process, so there is no timing to leak.
 *   * Revoking is a date on the row. A revoked key and an invented one get
 *     the same answer.
 *
 * The prefix is for the people who find strings in logs: `rkw_` says what it
 * is, and lets a secret scanner be taught the shape.
 */

import { createHash, randomBytes } from 'node:crypto';

export const WIDGET_KEY_PREFIX = 'rkw_';

/** Keys one person may hold at once; the oldest is revoked when another is minted past this. */
export const MAX_ACTIVE_WIDGET_KEYS = 10;

/** `last_used_at` is written at most this often per key: a widget asks many times a day. */
export const LAST_USED_STAMP_INTERVAL_MS = 60 * 60 * 1000;

/** 32 random bytes, base64url: 43 characters after the prefix. */
const KEY_BODY = /^[A-Za-z0-9_-]{43}$/;

export const mintWidgetKey = (): string => `${WIDGET_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;

export const hashWidgetKey = (key: string): string => createHash('sha256').update(key).digest('hex');

/** True for a string shaped like a key this module mints. Says nothing about whether it exists. */
export const isWidgetKeyShaped = (value: string): boolean =>
  value.startsWith(WIDGET_KEY_PREFIX) && KEY_BODY.test(value.slice(WIDGET_KEY_PREFIX.length));

/** The bearer token of a request, or null. */
export const bearerOf = (header: string | string[] | undefined): string | null => {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return null;
  const token = value.slice('Bearer '.length).trim();
  return token === '' ? null : token;
};

/** What the label a phone sent is stored as: one line, trimmed, at most 80 characters, or nothing. */
export const cleanWidgetLabel = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const oneLine = Array.from(raw, char => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char)).join('');
  const label = oneLine.trim().slice(0, 80).trim();
  return label === '' ? null : label;
};

export interface WidgetKeyRow {
  id: string;
  user_id: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface WidgetKeyStore {
  /** The row holding this hash, or null. */
  findByHash(hash: string): Promise<WidgetKeyRow | null>;
  /** Stamp the row as used now. */
  stampUsed(id: string, at: string): Promise<void>;
}

export interface WidgetCaller {
  userId: string;
  keyId: string;
}

/**
 * Whose widget is asking, or null for anything that is not a live key: no
 * bearer, the wrong shape, a hash nobody holds, a revoked row. The caller
 * answers all four alike.
 *
 * A failed stamp does not fail the request — the figure is what was asked
 * for, and "when was this key last used" is housekeeping.
 */
export async function verifyWidgetKey(
  store: WidgetKeyStore,
  authorization: string | string[] | undefined,
  now: Date
): Promise<WidgetCaller | null> {
  const key = bearerOf(authorization);
  if (key === null || !isWidgetKeyShaped(key)) return null;
  const row = await store.findByHash(hashWidgetKey(key));
  if (row === null || row.revoked_at !== null) return null;
  const lastUsed = row.last_used_at === null ? Number.NaN : Date.parse(row.last_used_at);
  if (Number.isNaN(lastUsed) || now.getTime() - lastUsed >= LAST_USED_STAMP_INTERVAL_MS) {
    try {
      await store.stampUsed(row.id, now.toISOString());
    } catch (error) {
      console.warn('[widget] could not stamp last_used_at', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { userId: row.user_id, keyId: row.id };
}
