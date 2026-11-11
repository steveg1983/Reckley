import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { GridIcon } from '../icons';
import { preferences } from '../../services/preferencesService';
import { type WidgetDisplay, type WidgetPrefs } from '../../services/widget/prefs';
import {
  handKeyToWidget,
  reloadWidgets,
  takeKeyFromWidget,
  widgetBridgeAvailable,
  widgetStatus,
} from '../../services/widget/widgetBridge';
import { listWidgetPhones, mintWidgetKey, revokeWidgetKey, type WidgetPhone } from '../../services/widget/widgetKeyClient';
import { formatDate, formatDateTime } from '../../utils/dateFormatter';
import { loadWidgetPrefs, saveWidgetPrefs } from '../../utils/widgetSettings';

/**
 * Home-screen widgets — whether this phone's widgets may read the budget
 * summary, and how much of it they draw.
 *
 * The SWITCH and the two choices are drawn only inside an iOS shell that
 * carries the widget plugin (services/widget/widgetBridge.ts). A browser has
 * no home screen, and an installed build older than the widget has nothing
 * to switch on — the page is newer than the app whenever the app has not
 * been updated, and a switch there would be a claim the app cannot keep.
 *
 * ── A LOST PHONE IS TURNED OFF FROM ANYWHERE (owner, 11 Nov 2026) ───────────
 *
 * The switch is about this phone, and a lost phone is not this phone. So the
 * card also says which phones have widgets on — asked of the server, which
 * knows the keys it gave out — and offers one control that turns every one
 * of them off. Outside the shell that is ALL the card is, and it is drawn
 * only when some phone has them on: with none, there is nothing to say and
 * nothing to turn off, and a browser shows no card at all, as before.
 *
 * It says the consequence it cannot avoid: a phone that is offline goes on
 * showing the last figures it fetched until it is next online. The key is
 * dead at once; what is already drawn on a screen nobody can reach is not.
 *
 * ── THE SWITCH IS ABOUT THIS PHONE ──────────────────────────────────────────
 *
 * On asks the server for a read-only key (it opens the budget summary and
 * nothing else) and hands it to the phone, which keeps it where the widget
 * can read it. The page keeps no copy. Off takes it back from the phone
 * FIRST — that is what stops the drawing, and it needs no network — and then
 * tells the server the key is dead. Whether it is on is asked of the phone,
 * not remembered in a preference: a preference travels with the account, and
 * a second phone that inherited "on" would be claiming a key it never had.
 *
 * A key that is minted but cannot be handed over is revoked at once, so no
 * live key exists that nothing holds.
 *
 * ── THE TWO CHOICES TRAVEL WITH THE ACCOUNT ─────────────────────────────────
 *
 * Amounts or percentages (the owner's ruling, 10 Nov 2026: the person
 * chooses, amounts by default) and hiding while locked are how the person
 * wants their figures seen by whoever glances at a phone — the same answer on
 * every phone they own. They are saved, sent, and only then are the widgets
 * asked to fetch again, so a redraw never reads the old choice.
 */

const DISPLAY_CHOICES: Array<{ value: WidgetDisplay; label: string; detail: string }> = [
  {
    value: 'amounts',
    label: 'Amounts',
    detail: 'What is left of each budget, in money.',
  },
  {
    value: 'percent',
    label: 'Percentages only',
    detail: 'How much of each budget is used. No amount is sent to the widget at all.',
  },
];

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export default function WidgetSettings(): React.JSX.Element | null {
  const { isSignedIn, getToken } = useAuth();
  const [prefs, setPrefs] = useState<WidgetPrefs>(loadWidgetPrefs);
  const [on, setOn] = useState(false);
  const [keyId, setKeyId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [phones, setPhones] = useState<WidgetPhone[]>([]);

  const available = widgetBridgeAvailable();

  // Clerk hands back a new `getToken` whenever it likes; the asking below
  // should follow the session and this phone's key, not that.
  const tokenSource = useRef(getToken);
  tokenSource.current = getToken;

  // Which phones have widgets on, asked once the card is up and again after
  // anything here changes it. A failure to ask is no list, not an error on a
  // settings page: the switch below still works without it.
  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    void (async () => {
      try {
        const token = await tokenSource.current();
        if (!token) return;
        const found = await listWidgetPhones(token);
        if (!cancelled) setPhones(found);
      } catch {
        if (!cancelled) setPhones([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `keyId` changes when this phone is switched on or off.
  }, [isSignedIn, keyId]);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    void widgetStatus().then((status) => {
      if (cancelled) return;
      setOn(status.hasKey);
      setKeyId(status.keyId);
    });
    return () => {
      cancelled = true;
    };
  }, [available]);

  if (!isSignedIn) return null;
  // The phones that are not this one — every phone, outside the shell.
  const otherPhones = phones.filter((phone) => phone.id !== keyId);
  if (!available && otherPhones.length === 0 && notice === null) return null;

  const switchOn = async (): Promise<void> => {
    const token = await getToken();
    if (!token) {
      setNotice('Your session has expired. Sign in again, then switch this on.');
      return;
    }
    const minted = await mintWidgetKey(token, 'iPhone');
    try {
      await handKeyToWidget(minted.key, minted.id);
    } catch (error) {
      // Nothing holds this key now; do not leave it live.
      await revokeWidgetKey(token, minted.id).catch(() => undefined);
      throw error;
    }
    setOn(true);
    setKeyId(minted.id);
    setNotice('Widgets are on. Add one from the home screen: touch and hold an empty area, tap Edit, then Add Widget, and choose Reckley.');
  };

  const switchOff = async (): Promise<void> => {
    await takeKeyFromWidget();
    setOn(false);
    const held = keyId;
    setKeyId(null);
    setNotice('Widgets are off on this phone.');
    // The phone no longer holds the key, so nothing can use it from here. The
    // server is told as well; if it cannot be reached the key is simply one
    // nobody has, and it ages out with the next ones made.
    if (!held) return;
    const token = await getToken();
    if (token) await revokeWidgetKey(token, held).catch(() => undefined);
  };

  const toggle = async (next: boolean): Promise<void> => {
    if (working) return;
    setWorking(true);
    setNotice(null);
    try {
      if (next) await switchOn();
      else await switchOff();
    } catch (error) {
      setNotice(`Widgets could not be switched ${next ? 'on' : 'off'}: ${describe(error)}`);
    } finally {
      setWorking(false);
    }
  };

  /** Every key the person has, dead at once; this phone's own emptied first, as the switch does. */
  const turnOffEverywhere = async (): Promise<void> => {
    if (working) return;
    setWorking(true);
    setNotice(null);
    try {
      if (available) {
        await takeKeyFromWidget();
        setOn(false);
      }
      const token = await getToken();
      if (!token) {
        setNotice('Your session has expired. Sign in again, then turn them off.');
        return;
      }
      await revokeWidgetKey(token);
      setPhones([]);
      setKeyId(null);
      setNotice(
        'Budget widgets are off on every phone. A widget stops showing your budgets the next time it refreshes, within about half an hour. A phone that is offline keeps showing the last figures it fetched until it is next online.'
      );
    } catch (error) {
      setNotice(`The widgets could not be turned off: ${describe(error)}`);
    } finally {
      setWorking(false);
    }
  };

  const phonesSection = otherPhones.length > 0 && (
    <div className={available ? 'mt-4 border-t border-gray-200 dark:border-gray-700 pt-4' : ''} data-testid="widget-phones">
      <p className="text-sm font-medium text-gray-900 dark:text-white">
        {available
          ? otherPhones.length === 1
            ? 'Budget widgets are also on for another phone'
            : `Budget widgets are also on for ${otherPhones.length} other phones`
          : otherPhones.length === 1
            ? 'Budget widgets are on for one phone'
            : `Budget widgets are on for ${otherPhones.length} phones`}
      </p>
      <ul className="mt-2 space-y-1 text-xs text-gray-500 dark:text-gray-400">
        {otherPhones.map((phone) => (
          <li key={phone.id}>
            {phone.label} · switched on {formatDate(phone.createdAt)} ·{' '}
            {phone.lastUsedAt ? `last fetched ${formatDateTime(phone.lastUsedAt)}` : 'has not fetched yet'}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => void turnOffEverywhere()}
        disabled={working}
        className="mt-3 inline-flex items-center min-h-[44px] px-4 py-2 border border-line dark:border-gray-600 text-gray-700 dark:text-gray-200 text-sm font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-60"
      >
        Turn off on every phone
      </button>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        For a phone you have lost or sold. Widgets are switched on again from the Reckley app on each phone.
      </p>
    </div>
  );

  const status = (
    <>
      {working && (
        <p role="status" className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          One moment…
        </p>
      )}
      {!working && notice && (
        <p role="status" className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          {notice}
        </p>
      )}
    </>
  );

  // Outside the shell the card is the list and its one control, and nothing else.
  if (!available) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
        <h2 className="text-card font-semibold text-theme-heading dark:text-white mb-1 flex items-center gap-2">
          <GridIcon size={20} className="text-gray-500" />
          Home-screen widgets
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Your budgets on a phone’s home screen. Budgets only — never your net worth or a balance.
        </p>
        {phonesSection}
        {status}
      </div>
    );
  }

  const choose = async (next: WidgetPrefs): Promise<void> => {
    setPrefs(next);
    setNotice(null);
    try {
      saveWidgetPrefs(next);
      // Sent before the widgets are asked to fetch, or they draw the old choice.
      await preferences.flush();
      await reloadWidgets();
    } catch (error) {
      setNotice(`That choice was not saved: ${describe(error)}`);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
      <h2 className="text-card font-semibold text-theme-heading dark:text-white mb-1 flex items-center gap-2">
        <GridIcon size={20} className="text-gray-500" />
        Home-screen widgets
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Your budgets on this phone’s home screen, kept up to date while the app is closed. Budgets
        only — never your net worth or a balance.
      </p>

      <label className="flex items-start gap-3 rounded-xl border border-gray-200 dark:border-gray-700 p-3 cursor-pointer hover:border-gray-300 dark:hover:border-gray-600 transition-colors">
        <input
          type="checkbox"
          checked={on}
          disabled={working}
          onChange={(e) => void toggle(e.target.checked)}
          className="mt-1"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-gray-900 dark:text-white">Budget widgets on this phone</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            Lets the widgets on this phone read your budget summary, and nothing else. They cannot
            change anything.
          </span>
        </span>
      </label>

      <fieldset className="mt-4">
        <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Show</legend>
        <div className="flex flex-col gap-2">
          {DISPLAY_CHOICES.map(({ value, label, detail }) => (
            <label
              key={value}
              className="flex items-start gap-3 rounded-xl border border-gray-200 dark:border-gray-700 p-3 cursor-pointer hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
            >
              <input
                type="radio"
                name="widget-display"
                value={value}
                checked={prefs.display === value}
                onChange={() => void choose({ ...prefs, display: value })}
                className="mt-1"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-gray-900 dark:text-white">{label}</span>
                <span className="block text-xs text-gray-500 dark:text-gray-400">{detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="mt-4 flex items-start gap-3 rounded-xl border border-gray-200 dark:border-gray-700 p-3 cursor-pointer hover:border-gray-300 dark:hover:border-gray-600 transition-colors">
        <input
          type="checkbox"
          checked={prefs.hideWhenLocked}
          onChange={(e) => void choose({ ...prefs, hideWhenLocked: e.target.checked })}
          className="mt-1"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-gray-900 dark:text-white">Hide figures while the phone is locked</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            The widgets draw blank until the phone is unlocked.
          </span>
        </span>
      </label>

      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        These two choices apply to the widgets on every phone you use.
      </p>

      {phonesSection}
      {status}
    </div>
  );
}
