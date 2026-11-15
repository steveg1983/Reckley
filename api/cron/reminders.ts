import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getServiceRoleSupabase } from '../_lib/supabase.js';
import { getRequiredEnv } from '../_lib/env.js';
import { captureServerError, withSentry } from '../_lib/sentry.js';
import { timingSafeStringEqual } from '../_lib/timing-safe.js';
import { pushDueReminders, reminderPushDeps } from '../_lib/reminder-push.js';
import { lowBalancePushDeps, pushLowBalances } from '../_lib/low-balance-push.js';

/**
 * The balance reminder's quarter-hourly look at who is due — the cron's HTTP
 * skin over api/_lib/reminder-push.ts, on the pattern of bank-feeds.ts. A
 * reminder set for 08:30 reaches the lock screen by 08:45 at the latest.
 *
 * The same quarter-hour also asks whether any account has gone past the line
 * its owner set (api/_lib/low-balance-push.ts, 14 Nov 2026). The two run one
 * after the other and fail separately: a reminder failure must not silence a
 * low-balance warning, nor the other way round.
 */
async function handler(req: VercelRequest, res: VercelResponse) {
  const authHeader = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization ?? '';
  const cronSecret = getRequiredEnv('CRON_SECRET');
  if (!timingSafeStringEqual(authHeader, `Bearer ${cronSecret}`)) {
    return res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
  }

  const supabase = getServiceRoleSupabase();
  const deps = reminderPushDeps(supabase);
  const lowBalanceDeps = lowBalancePushDeps(supabase);
  if (!deps || !lowBalanceDeps) {
    // Inert until the APNs key is configured — the same courtesy Sentry and
    // Stripe extend; a green cron with nothing to do beats a red one daily.
    console.warn('[reminders] APNs is not configured — no reminder pushes sent');
    return res.status(200).json({ skipped: 'apns_not_configured' });
  }

  let failed = false;
  let reminders: unknown = null;
  let lowBalances: unknown = null;

  try {
    reminders = await pushDueReminders(deps);
    console.log('[reminders] balance reminders checked', reminders);
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : 'Unexpected error';
    console.error('[reminders] reminder push failed', { message });
    await captureServerError(error, { cron: 'reminders' });
  }

  try {
    lowBalances = await pushLowBalances(lowBalanceDeps);
    console.log('[reminders] low balances checked', lowBalances);
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : 'Unexpected error';
    console.error('[reminders] low-balance push failed', { message });
    await captureServerError(error, { cron: 'reminders', job: 'low-balance' });
  }

  if (failed) {
    return res.status(500).json({ error: 'A push job failed', code: 'internal_error', reminders, lowBalances });
  }
  return res.status(200).json({ reminders, lowBalances });
}

// Safety net: report any unhandled throw to Sentry (no-op without SENTRY_DSN).
export default withSentry(handler);
