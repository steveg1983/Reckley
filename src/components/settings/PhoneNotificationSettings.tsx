import React, { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { PhoneIcon } from '../icons';
import { useUserId } from '../../hooks/useUserId';
import { isNativeShell } from '../../services/push/nativeShell';
import { notificationPermission, registerThisPhone } from '../../services/push/pushRegistration';
import { type PhoneNotificationPrefs } from '../../services/push/prefs';
import { loadPhoneNotificationPrefs, recordDeviceTimeZone, savePhoneNotificationPrefs } from '../../utils/phoneNotifications';
import { loadAutoSyncPrefs } from '../../utils/bankAutoSync';
import { loadReminderPrefs } from '../../utils/balanceReminders';

/**
 * Phone notifications — what this phone may interrupt its owner for.
 *
 * Drawn ONLY inside the iOS shell (services/push/nativeShell.ts): a browser
 * has no APNs token and no way to get one, so a switch there would be a
 * claim the app cannot keep. On the web the card is simply absent, the way
 * the desktop edition's absent panels are absent — a person on a settings
 * page did not come there to read about a device they are not holding.
 *
 * Four switches, each honest about what it needs:
 *
 *   New transactions      needs Bank feed refresh = In the cloud, because
 *   A feed stopped        only a SERVER-side sync can notice something while
 *                         the app is closed — a browser sync shows its own
 *                         toast and has nobody to push to.
 *   Balance reminders     needs In the cloud TOO (the owner's ruling, 11
 *                         Sep: phone alerts are what a cloud user opts
 *                         into, one decision rather than three), and a
 *                         schedule in the card above — a reminder with no
 *                         moment has nothing to say. The server keeps the
 *                         same rule (api/_lib/reminder-push.ts), so a
 *                         switch left on by a user who later leaves cloud
 *                         mode goes quiet rather than lingering.
 *   Low balances          needs In the cloud, by the same ruling. Fires once
 *                         when an account crosses the line set on it in the
 *                         account's settings — the Dashboard's "Needs your
 *                         attention" rule (api/_lib/low-balance-push.ts,
 *                         owner, 14 Nov 2026).
 *
 * A disabled switch says why in a line beneath it rather than vanishing:
 * the remedy is one card up, and naming it is what makes the pair one
 * setting rather than two that happen to agree.
 *
 * Switching anything on is what asks iOS for permission — Apple's own
 * prompt, shown once. A refusal is remembered by the system, and the only
 * way back is iOS Settings, so that is what the card says when it finds
 * notifications off: the words, not a button that would do nothing.
 */

type Permission = 'granted' | 'denied' | 'prompt' | 'unknown';

export default function PhoneNotificationSettings(): React.JSX.Element | null {
  const { userId: clerkId, isSignedIn } = useAuth();
  const { databaseId } = useUserId();
  const [prefs, setPrefs] = useState<PhoneNotificationPrefs>(loadPhoneNotificationPrefs);
  const [permission, setPermission] = useState<Permission>('unknown');
  const [registering, setRegistering] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const onPhone = isNativeShell();

  useEffect(() => {
    if (!onPhone) return;
    let cancelled = false;
    void notificationPermission().then((answer) => {
      if (!cancelled) setPermission(answer);
    });
    return () => {
      cancelled = true;
    };
  }, [onPhone]);

  if (!onPhone || !isSignedIn || !clerkId) return null;

  const cloudMode = loadAutoSyncPrefs(clerkId).mode === 'cloud';
  const reminderScheduled = loadReminderPrefs().schedule !== 'off';

  const update = async (next: PhoneNotificationPrefs): Promise<void> => {
    setPrefs(next);
    savePhoneNotificationPrefs(next);
    setNotice(null);
    const turnedSomethingOn = next.feedActivity || next.feedAttention || next.balanceReminders || next.lowBalances;
    if (!turnedSomethingOn || !databaseId) return;

    setRegistering(true);
    try {
      recordDeviceTimeZone();
      const outcome = await registerThisPhone(databaseId);
      if (outcome.kind === 'registered') {
        setPermission('granted');
        setNotice('This phone is registered. Notifications arrive even when the app is closed.');
      } else if (outcome.kind === 'denied') {
        setPermission('denied');
      } else if (outcome.kind === 'failed') {
        setNotice(`This phone could not be registered: ${outcome.message}`);
      }
    } finally {
      setRegistering(false);
    }
  };

  const switches: Array<{
    key: keyof PhoneNotificationPrefs;
    label: string;
    detail: string;
    enabled: boolean;
    needs: string;
  }> = [
    {
      key: 'feedActivity',
      label: 'New transactions',
      detail: 'When a cloud refresh brings in new transactions from your banks — how many, and from where.',
      enabled: cloudMode,
      needs: 'Needs Bank feed refresh set to In the cloud, above.',
    },
    {
      key: 'feedAttention',
      label: 'A feed needs reconnecting',
      detail: 'When a bank connection stops and nothing new will arrive until you reconnect it.',
      enabled: cloudMode,
      needs: 'Needs Bank feed refresh set to In the cloud, above.',
    },
    {
      key: 'balanceReminders',
      label: 'Balance reminders',
      detail: 'Your scheduled reminder to update balances, on the lock screen rather than waiting for you to open the app.',
      enabled: cloudMode && reminderScheduled,
      // The first unmet need is the one named: cloud mode is the door to the
      // whole card, so it is asked for before the schedule.
      needs: cloudMode
        ? 'Needs a reminder schedule in Balance reminders, above.'
        : 'Needs Bank feed refresh set to In the cloud, above.',
    },
    {
      key: 'lowBalances',
      label: 'Low balances',
      detail: 'When an account goes past the warning level you set on it. Once each time it crosses, and never the amount.',
      enabled: cloudMode,
      needs: 'Needs Bank feed refresh set to In the cloud, above.',
    },
  ];

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700 p-6">
      <h2 className="text-xl font-semibold text-theme-heading dark:text-white mb-1 flex items-center gap-2">
        <PhoneIcon size={20} className="text-gray-500" />
        Phone notifications
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        What this phone may tell you about, even when the app is closed. Never an amount — a lock
        screen is read by whoever is holding the phone.
      </p>

      {permission === 'denied' && (
        <p role="status" className="mb-4 text-sm text-gray-700 dark:text-gray-300">
          Notifications are turned off for Reckley in iOS Settings. Turn them on there
          (Settings → Notifications → Reckley), then come back and switch these on.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {switches.map(({ key, label, detail, enabled, needs }) => (
          <label
            key={key}
            className={`flex items-start gap-3 rounded-xl border p-3 transition-colors ${
              enabled
                ? 'cursor-pointer border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                : 'border-gray-100 dark:border-gray-700/60'
            }`}
          >
            {/* Never disabled by an in-flight registration: the choice is
                saved the moment it is made, and the phone's token is a
                separate matter that the notice below reports on. Locking the
                other two switches while iOS answered the first (up to fifteen
                seconds) read as "the app is broken" — 11 Sep, first build. */}
            <input
              type="checkbox"
              checked={prefs[key] && enabled}
              disabled={!enabled}
              onChange={(e) => void update({ ...prefs, [key]: e.target.checked })}
              className="mt-1"
            />
            <span className="min-w-0">
              <span className={`block text-sm font-medium ${enabled ? 'text-gray-900 dark:text-white' : 'text-gray-400 dark:text-gray-500'}`}>
                {label}
              </span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">{detail}</span>
              {!enabled && (
                <span className="block text-xs text-gray-400 dark:text-gray-500 mt-0.5">{needs}</span>
              )}
            </span>
          </label>
        ))}
      </div>

      {registering && (
        <p role="status" className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          Registering this phone…
        </p>
      )}
      {!registering && notice && (
        <p role="status" className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          {notice}
        </p>
      )}
    </div>
  );
}
