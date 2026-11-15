/**
 * What a person asked their phone to tell them — the preference, as a shape
 * both sides can read.
 *
 * Pure on purpose, with no imports: the SERVER decides whether to send a push
 * (api/_lib/cloud-refresh-announce.ts, api/cron/reminders.ts) by reading the
 * same preferences document the browser writes, and a module that reached the
 * preferences service would drag a Supabase client into the serverless graph.
 * The browser's storage half is utils/phoneNotifications.ts; this is the file
 * format, the same split services/preferences/document.ts makes.
 *
 * Four switches, each an answer to "what would you want your phone to
 * interrupt you for?":
 *
 *   feedActivity      new transactions arrived from a bank feed the SERVER
 *                     refreshed (so it needs Bank feed refresh = In the cloud;
 *                     a browser sync shows its own toast and needs no push)
 *   feedAttention     a feed has stopped and needs reconnecting — the quiet
 *                     failure, the one where nothing looks broken and the
 *                     balances simply go stale (useAccountBankSync's header)
 *   balanceReminders  the balance-update reminder the person scheduled in
 *                     Settings, delivered to the lock screen rather than
 *                     waiting for the app to be opened
 *   lowBalances       an account has gone past the line its owner set on it
 *                     (the Dashboard's "Needs your attention" rule,
 *                     utils/warningLine.ts) — once when it crosses, not every
 *                     quarter-hour it stays there (owner, 14 Nov 2026)
 *
 * All four need Bank feed refresh = In the cloud — the owner's ruling (11
 * Sep): phone alerts are what a cloud user opts into, one decision rather
 * than three. The first two need it by nature; the others are held to it by
 * the settings card and by their server halves alike.
 *
 * All off by default: a notification nobody asked for is not a feature.
 */

export interface PhoneNotificationPrefs {
  feedActivity: boolean;
  feedAttention: boolean;
  balanceReminders: boolean;
  lowBalances: boolean;
}

/** The entry in the preferences document. */
export const PHONE_NOTIFICATION_PREFS_KEY = 'phoneNotifications.prefs.v1';

/**
 * The phone's IANA time zone, written beside the switches so the server can
 * turn "remind me at 08:30" into an instant. A DEVICE fact stored in the
 * ACCOUNT's document, deliberately: a person with two phones in two zones is
 * rare, and the last one to register wins, which is also the one they hold.
 */
export const DEVICE_TIME_ZONE_KEY = 'device.timeZone.v1';

export const DEFAULT_PHONE_NOTIFICATION_PREFS: PhoneNotificationPrefs = {
  feedActivity: false,
  feedAttention: false,
  balanceReminders: false,
  lowBalances: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read the stored string (or an already-parsed object) into the shape.
 * Anything unreadable is "nothing asked for": a garbage entry must never
 * turn into a push.
 */
export function parsePhoneNotificationPrefs(raw: unknown): PhoneNotificationPrefs {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_PHONE_NOTIFICATION_PREFS };
    }
  }
  if (!isRecord(value)) return { ...DEFAULT_PHONE_NOTIFICATION_PREFS };
  return {
    feedActivity: value.feedActivity === true,
    feedAttention: value.feedAttention === true,
    balanceReminders: value.balanceReminders === true,
    lowBalances: value.lowBalances === true,
  };
}

export function anyPhoneNotificationOn(prefs: PhoneNotificationPrefs): boolean {
  return prefs.feedActivity || prefs.feedAttention || prefs.balanceReminders || prefs.lowBalances;
}

/** A stored zone is only usable if Intl knows it; anything else is "unknown". */
export function parseDeviceTimeZone(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    // No locale named: the question is whether the ZONE exists, and a locale
    // literal here would trip the app's no-region-in-code rule for nothing.
    new Intl.DateTimeFormat(undefined, { timeZone: raw });
    return raw;
  } catch {
    return null;
  }
}
