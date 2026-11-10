/**
 * `GET /api/widget/budgets?tz=Europe/London` — the one thing a widget key
 * opens: the running budgets, summarised, as text ready to draw.
 *
 * The caller is a home-screen widget, not a browser: there is no Origin, no
 * cookie and no Clerk session, only `Authorization: Bearer rkw_…` (see
 * `_lib/widget-key`). It reads through the same user-scoped port the Claude
 * connector reads through and the same evaluation the Budget page draws
 * (`_lib/budget-status`), and it shapes the answer by the person's own
 * settings — amounts or percentages only, their region, their Key Budgets
 * (`_lib/widget-budgets`).
 *
 * Every failure to recognise the key is the same 401. A widget that gets one
 * shows "Open Reckley to reconnect"; it does not need to know which of
 * missing, malformed, unknown or revoked it was, and neither does a stranger.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { evaluateRunningBudgets } from '../_lib/budget-status.js';
import { createErrorResponse } from '../_lib/http-error.js';
import { createSupabasePort } from '../_lib/mcp/port.js';
import { loadPreferenceValues } from '../_lib/push.js';
import { applyRateLimit, bearerClientKey } from '../_lib/rate-limit.js';
import { withSentry } from '../_lib/sentry.js';
import { getServiceRoleSupabase } from '../_lib/supabase.js';
import { describeSupabaseFailure } from '../_lib/supabase-failure.js';
import { describeBudgetsForWidget, usableTimeZone, wallClockIn, widgetSettingsFrom } from '../_lib/widget-budgets.js';
import { verifyWidgetKey, type WidgetKeyRow, type WidgetKeyStore } from '../_lib/widget-key.js';

/** Rows the evaluation will read. The connector's ceiling; a year of a busy ledger is well under it. */
const ROW_CAP = 20_000;

async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return createErrorResponse(res, 405, 'Method not allowed', 'method_not_allowed');
  }

  // iOS lets a widget refresh a few dozen times a day, and a person may have
  // several on several screens: 30 a minute per key is far above honest use.
  // Counted BEFORE the key is looked at, so guessing keys is rate-limited too.
  if (
    await applyRateLimit(req, res, {
      name: 'widget-budgets',
      limit: 120,
      windowMs: 60_000,
      perClient: { key: bearerClientKey, limit: 30 },
    })
  ) {
    return;
  }

  res.setHeader('Cache-Control', 'private, no-store');

  try {
    const supabase = getServiceRoleSupabase();
    const store: WidgetKeyStore = {
      findByHash: async (hash) => {
        const { data, error, status } = await supabase
          .from('widget_keys')
          .select('id, user_id, last_used_at, revoked_at')
          .eq('key_hash', hash)
          .maybeSingle();
        if (error) throw new Error(`Failed to look up widget key: ${describeSupabaseFailure(error, status)}`);
        return (data as WidgetKeyRow | null) ?? null;
      },
      stampUsed: async (id, at) => {
        const { error, status } = await supabase.from('widget_keys').update({ last_used_at: at }).eq('id', id);
        if (error) throw new Error(`Failed to stamp widget key: ${describeSupabaseFailure(error, status)}`);
      },
    };

    const instant = new Date();
    const caller = await verifyWidgetKey(store, req.headers.authorization, instant);
    if (caller === null) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return createErrorResponse(res, 401, 'Not a valid widget key', 'invalid_widget_key');
    }

    const tz = Array.isArray(req.query.tz) ? req.query.tz[0] : req.query.tz;
    const today = wallClockIn(usableTimeZone(tz), instant);

    // Read-only by construction: this file calls two reads on the port and
    // none of its writes.
    const port = createSupabasePort(supabase, caller.userId, { clientId: 'widget' });
    const [running, preferences] = await Promise.all([
      evaluateRunningBudgets(port, today, ROW_CAP),
      loadPreferenceValues(supabase, [caller.userId]),
    ]);

    const document = describeBudgetsForWidget({
      evaluated: running.evaluated,
      activeCount: running.activeCount,
      currency: running.currency,
      categories: running.categories,
      settings: widgetSettingsFrom(preferences.get(caller.userId)),
      today,
      instant,
    });
    return res.status(200).json(document);
  } catch (error) {
    return createErrorResponse(res, 500, 'Could not work out the budgets', 'internal_error', error);
  }
}

export default withSentry(handler);
