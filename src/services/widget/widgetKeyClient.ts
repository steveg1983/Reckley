/**
 * Asking the server for the widget's key, and giving it up.
 *
 * `POST /api/widget/key` is behind the app's own sign-in, so every call here
 * carries the session token the caller fetched. The key itself is in the
 * answer to `mint` and nowhere else, ever — the server keeps a hash — so
 * the caller's one job is to hand it straight to the phone and keep no copy:
 * nothing in this module, and nothing that calls it, stores or logs it.
 */

export interface MintedWidgetKey {
  id: string;
  key: string;
}

const KEY_ROUTE = '/api/widget/key';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const post = async (sessionToken: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const response = await fetch(KEY_ROUTE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => ({}));
  const answer = isRecord(payload) ? payload : {};
  if (!response.ok) {
    const said = typeof answer.error === 'string' && answer.error !== '' ? answer.error : `the server answered ${response.status}`;
    throw new Error(said);
  }
  return answer;
};

/** A new key for this phone's widgets. */
export async function mintWidgetKey(sessionToken: string, label: string): Promise<MintedWidgetKey> {
  const answer = await post(sessionToken, { action: 'mint', label });
  if (typeof answer.id !== 'string' || typeof answer.key !== 'string' || answer.id === '' || answer.key === '') {
    throw new Error('the server did not return a key');
  }
  return { id: answer.id, key: answer.key };
}

/** Revoke one key by id, or — with no id — every key the person has. Returns how many stopped working. */
export async function revokeWidgetKey(sessionToken: string, id?: string): Promise<number> {
  const answer = await post(sessionToken, id ? { action: 'revoke', id } : { action: 'revoke' });
  return typeof answer.revoked === 'number' ? answer.revoked : 0;
}

/** A phone that holds a live key: what the server will say of it, which is never the key. */
export interface WidgetPhone {
  id: string;
  /** What the phone called itself when it switched widgets on — "iPhone". */
  label: string;
  /** When widgets were switched on there, ISO 8601. */
  createdAt: string;
  /** When its widget last fetched, to the hour, or null if it never has. */
  lastUsedAt: string | null;
}

/** Every phone with widgets switched on. An answer that is not the expected shape is no phones, not a crash. */
export async function listWidgetPhones(sessionToken: string): Promise<WidgetPhone[]> {
  const answer = await post(sessionToken, { action: 'list' });
  if (!Array.isArray(answer.keys)) return [];
  const phones: WidgetPhone[] = [];
  for (const entry of answer.keys as unknown[]) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.createdAt !== 'string') continue;
    phones.push({
      id: entry.id,
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : 'A phone',
      createdAt: entry.createdAt,
      lastUsedAt: typeof entry.lastUsedAt === 'string' ? entry.lastUsedAt : null,
    });
  }
  return phones;
}
