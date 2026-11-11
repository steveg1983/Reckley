/**
 * `POST /api/widget/key` — a signed-in app asks for, or gives up, the key its
 * home-screen widget reads the budget summary with.
 *
 *   { "action": "mint", "label": "iPhone" }   → 201 { id, key }
 *   { "action": "revoke", "id": "<key id>" }  → 200 { revoked: n }   that one
 *   { "action": "revoke" }                    → 200 { revoked: n }   every one of theirs
 *   { "action": "list" }                      → 200 { keys: [{ id, label, createdAt, lastUsedAt }] }
 *
 * `list` is for the person who has lost a phone (owner, 11 Nov 2026): it says
 * which phones hold a live key, so the app can offer to turn them all off
 * from a browser. It answers with ids, labels and two dates — never a key,
 * which the table could not give back if it wanted to.
 *
 * This route is behind the app's own sign-in (Clerk), like every other; only
 * `GET /api/widget/budgets` accepts the key it hands out. The key is in the
 * 201 and nowhere else, ever: the table keeps its SHA-256 (see
 * `_lib/widget-key`), so it cannot be shown a second time and a lost one is
 * replaced, not recovered.
 *
 * Both verbs are POST because the shared CORS answer allows GET and POST.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { AuthError, requireAuth } from '../_lib/auth.js';
import { setCorsHeaders } from '../_lib/cors.js';
import { createErrorResponse } from '../_lib/http-error.js';
import { applyRateLimit } from '../_lib/rate-limit.js';
import { withSentry } from '../_lib/sentry.js';
import { getServiceRoleSupabase } from '../_lib/supabase.js';
import { describeSupabaseFailure } from '../_lib/supabase-failure.js';
import { cleanWidgetLabel, hashWidgetKey, MAX_ACTIVE_WIDGET_KEYS, mintWidgetKey } from '../_lib/widget-key.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: VercelRequest, res: VercelResponse) {
  if (setCorsHeaders(req, res)) {
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return createErrorResponse(res, 405, 'Method not allowed', 'method_not_allowed');
  }

  // A phone mints one key when widgets are switched on. Ten a minute is a
  // person changing their mind repeatedly; more is a loop.
  if (await applyRateLimit(req, res, { name: 'widget-key', limit: 10, windowMs: 60_000 })) {
    return;
  }

  try {
    const auth = await requireAuth(req);
    const body: Record<string, unknown> =
      req.body !== null && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const supabase = getServiceRoleSupabase();
    const now = new Date().toISOString();

    if (body.action === 'mint') {
      const key = mintWidgetKey();
      const inserted = await supabase
        .from('widget_keys')
        .insert({ user_id: auth.userId, key_hash: hashWidgetKey(key), label: cleanWidgetLabel(body.label) })
        .select('id')
        .single();
      if (inserted.error || !inserted.data) {
        return createErrorResponse(
          res,
          500,
          'Failed to create the widget key',
          'internal_error',
          inserted.error ? describeSupabaseFailure(inserted.error, inserted.status) : 'no row returned'
        );
      }

      // Keep the newest few. A phone that mints on every launch by mistake
      // must not leave a thousand live keys behind it. Allowed to fail: the
      // key just made is good either way.
      const live = await supabase
        .from('widget_keys')
        .select('id')
        .eq('user_id', auth.userId)
        .is('revoked_at', null)
        .order('created_at', { ascending: false })
        .range(MAX_ACTIVE_WIDGET_KEYS, MAX_ACTIVE_WIDGET_KEYS + 99);
      if (live.error) {
        console.error('[widget] could not list keys to trim', { message: live.error.message });
      } else if ((live.data ?? []).length > 0) {
        const trimmed = await supabase
          .from('widget_keys')
          .update({ revoked_at: now })
          .in('id', (live.data ?? []).map((row) => row.id as string))
          .eq('user_id', auth.userId);
        if (trimmed.error) {
          console.error('[widget] could not trim old keys', { message: trimmed.error.message });
        }
      }

      res.setHeader('Cache-Control', 'no-store');
      return res.status(201).json({ id: inserted.data.id as string, key });
    }

    if (body.action === 'revoke') {
      if (body.id !== undefined && (typeof body.id !== 'string' || !UUID.test(body.id))) {
        return createErrorResponse(res, 400, 'id must be a key id', 'invalid_request');
      }
      let revoke = supabase
        .from('widget_keys')
        .update({ revoked_at: now })
        .eq('user_id', auth.userId)
        .is('revoked_at', null);
      if (typeof body.id === 'string') {
        revoke = revoke.eq('id', body.id);
      }
      const revoked = await revoke.select('id');
      if (revoked.error) {
        return createErrorResponse(
          res,
          500,
          'Failed to revoke the widget key',
          'internal_error',
          describeSupabaseFailure(revoked.error, revoked.status)
        );
      }
      return res.status(200).json({ revoked: (revoked.data ?? []).length });
    }

    if (body.action === 'list') {
      const live = await supabase
        .from('widget_keys')
        .select('id, label, created_at, last_used_at')
        .eq('user_id', auth.userId)
        .is('revoked_at', null)
        .order('created_at', { ascending: false })
        .limit(MAX_ACTIVE_WIDGET_KEYS);
      if (live.error) {
        return createErrorResponse(
          res,
          500,
          'Failed to list the widget keys',
          'internal_error',
          describeSupabaseFailure(live.error, live.status)
        );
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        keys: ((live.data ?? []) as Array<{ id: string; label: string | null; created_at: string; last_used_at: string | null }>).map(
          (row) => ({ id: row.id, label: row.label ?? '', createdAt: row.created_at, lastUsedAt: row.last_used_at })
        ),
      });
    }

    return createErrorResponse(res, 400, "action must be 'mint', 'revoke' or 'list'", 'invalid_request');
  } catch (error) {
    if (error instanceof AuthError) {
      return createErrorResponse(res, error.status, error.message, error.code);
    }
    return createErrorResponse(res, 500, 'Unexpected error', 'internal_error', error);
  }
}

export default withSentry(handler);
