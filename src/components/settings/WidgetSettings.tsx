import React, { useEffect, useState } from 'react';
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
import { mintWidgetKey, revokeWidgetKey } from '../../services/widget/widgetKeyClient';
import { loadWidgetPrefs, saveWidgetPrefs } from '../../utils/widgetSettings';

/**
 * Home-screen widgets — whether this phone's widgets may read the budget
 * summary, and how much of it they draw.
 *
 * Drawn ONLY inside an iOS shell that carries the widget plugin
 * (services/widget/widgetBridge.ts). A browser has no home screen, and an
 * installed build older than the widget has nothing to switch on — the page
 * is newer than the app whenever the app has not been updated, and a card
 * there would be a claim the app cannot keep. So it is absent, the way
 * Phone notifications is absent outside the shell.
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

  const available = widgetBridgeAvailable();

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

  if (!available || !isSignedIn) return null;

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
    </div>
  );
}
