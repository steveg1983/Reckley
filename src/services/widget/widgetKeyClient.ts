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
