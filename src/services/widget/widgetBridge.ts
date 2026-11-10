import { createScopedLogger } from '../../loggers/scopedLogger';
import { isNativeShell } from '../push/nativeShell';

/**
 * The page's side of the hand-over to the home-screen widget.
 *
 * ── WHAT CROSSES ────────────────────────────────────────────────────────────
 *
 * A widget is native code beside the web view. It cannot read the page's
 * session and the page cannot reach the widget's storage, so the shell
 * carries one small plugin between them, `ReckleyWidget`, with four methods:
 *
 *   status()                         → { hasKey, keyId }
 *   setKey({ key, keyId, origin })   store the read-only key where the widget
 *                                    can read it, and redraw
 *   clearKey()                       forget it, and redraw
 *   reload()                         redraw — the settings changed
 *
 * `origin` is where the widget fetches from. It is handed over rather than
 * compiled in so that a build pointed at a preview deployment draws that
 * preview's figures, as the shell itself does.
 *
 * ── A SHELL WITHOUT THE PLUGIN IS A SHELL WITHOUT WIDGETS ───────────────────
 *
 * The shell loads this site from the network, so a page newer than the
 * installed app is the ordinary case: every build before the one that ships
 * the widget has no `ReckleyWidget` at all. `widgetBridgeAvailable()` asks
 * the injected bridge whether the plugin is there, and every surface asks it
 * first — an older build draws no card, rather than a switch that would
 * answer `not implemented on ios`.
 *
 * ── THE PLUGIN IS NEVER HANDED TO A PROMISE BARE ────────────────────────────
 *
 * A Capacitor plugin is a Proxy: a promise that resolves to one asks it for
 * `then`, which becomes a native call that never settles. That hung every
 * push registration from 11 Sep to 9 Nov 2026 (services/push/pushRegistration
 * tells it in full). The loader boxes the plugin in a plain object, and the
 * spec fakes the plugin as the same kind of Proxy so a bare hand-over fails
 * the suite.
 */

const logger = createScopedLogger('widgetBridge');

/** The plugin's name on the native side. Changing it strands every installed build. */
export const WIDGET_PLUGIN_NAME = 'ReckleyWidget';

export interface WidgetStatus {
  hasKey: boolean;
  /** The server's id for the key this phone holds — what a revoke names. */
  keyId: string | null;
}

interface ReckleyWidgetPlugin {
  status(): Promise<{ hasKey?: unknown; keyId?: unknown }>;
  setKey(options: { key: string; keyId: string; origin: string }): Promise<void>;
  clearKey(): Promise<void>;
  reload(): Promise<void>;
}

/** Does the installed shell carry the widget plugin? False in a browser, and in every older build. */
export function widgetBridgeAvailable(): boolean {
  if (!isNativeShell()) return false;
  const capacitor = window.Capacitor;
  return typeof capacitor?.isPluginAvailable === 'function' && capacitor.isPluginAvailable(WIDGET_PLUGIN_NAME) === true;
}

/** The plugin, BOXED — see "never handed to a promise bare" above. */
const loadPlugin = async (): Promise<{ plugin: ReckleyWidgetPlugin }> => {
  const { registerPlugin } = await import('@capacitor/core');
  return { plugin: registerPlugin<ReckleyWidgetPlugin>(WIDGET_PLUGIN_NAME) };
};

/** Whether this phone holds a key. A shell that cannot say holds none. */
export async function widgetStatus(): Promise<WidgetStatus> {
  if (!widgetBridgeAvailable()) return { hasKey: false, keyId: null };
  try {
    const { plugin } = await loadPlugin();
    const answer = await plugin.status();
    return {
      hasKey: answer.hasKey === true,
      keyId: typeof answer.keyId === 'string' && answer.keyId !== '' ? answer.keyId : null,
    };
  } catch (error) {
    logger.warn('Could not ask the widget whether it holds a key', error);
    return { hasKey: false, keyId: null };
  }
}

/** Store the key where the widget reads it. Throws when the phone refuses: the caller has a live key to revoke. */
export async function handKeyToWidget(key: string, keyId: string): Promise<void> {
  if (!widgetBridgeAvailable()) throw new Error('This build of the app has no widgets');
  const { plugin } = await loadPlugin();
  await plugin.setKey({ key, keyId, origin: window.location.origin });
}

/** Forget the key on this phone. Throws when the phone refuses, so "off" is never claimed falsely. */
export async function takeKeyFromWidget(): Promise<void> {
  if (!widgetBridgeAvailable()) return;
  const { plugin } = await loadPlugin();
  await plugin.clearKey();
}

/** Ask the widgets to fetch again. Best-effort: they refresh on their own schedule regardless. */
export async function reloadWidgets(): Promise<void> {
  if (!widgetBridgeAvailable()) return;
  try {
    const { plugin } = await loadPlugin();
    await plugin.reload();
  } catch (error) {
    logger.warn('Could not ask the widgets to redraw', error);
  }
}
