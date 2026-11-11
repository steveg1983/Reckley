/**
 * Widget settings: the browser's half of the preference.
 *
 * The shape and the parsers are services/widget/prefs.ts (pure, shared with
 * the server that shapes the widget's document). This is where the two
 * values are read and written from a page — the split utils/phoneNotifications.ts
 * makes, for the same reason: the choice belongs to the person and travels
 * with the account, so a second phone draws its widgets the same way.
 */

import { preferences } from '../services/preferencesService';
import {
  parseWidgetDisplay,
  parseWidgetHideWhenLocked,
  parseWidgetPercentAs,
  serialiseWidgetHideWhenLocked,
  WIDGET_DISPLAY_KEY,
  WIDGET_HIDE_WHEN_LOCKED_KEY,
  WIDGET_PERCENT_AS_KEY,
  type WidgetPrefs,
} from '../services/widget/prefs';

export function loadWidgetPrefs(): WidgetPrefs {
  return {
    display: parseWidgetDisplay(preferences.getItem(WIDGET_DISPLAY_KEY)),
    hideWhenLocked: parseWidgetHideWhenLocked(preferences.getItem(WIDGET_HIDE_WHEN_LOCKED_KEY)),
    percentAs: parseWidgetPercentAs(preferences.getItem(WIDGET_PERCENT_AS_KEY)),
  };
}

export function saveWidgetPrefs(prefs: WidgetPrefs): void {
  preferences.setItem(WIDGET_DISPLAY_KEY, prefs.display);
  preferences.setItem(WIDGET_HIDE_WHEN_LOCKED_KEY, serialiseWidgetHideWhenLocked(prefs.hideWhenLocked));
  preferences.setItem(WIDGET_PERCENT_AS_KEY, prefs.percentAs);
}
