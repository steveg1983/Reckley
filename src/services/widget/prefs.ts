/**
 * How a person asked their home-screen widgets to look — the preference, as
 * a shape both sides can read.
 *
 * Pure, with no imports, for the reason services/push/prefs.ts is: the SERVER
 * shapes the widget's document from these two values
 * (api/_lib/widget-budgets.ts) by reading the same preferences document the
 * browser writes, and a module that reached the preferences service would
 * drag a Supabase client into the serverless graph. The browser's storage
 * half is utils/widgetSettings.ts.
 *
 * Two choices, both answers to the owner's one concern (9 Nov 2026) — what
 * somebody glancing at the phone can read:
 *
 *   display          'amounts' (the default, his ruling of 10 Nov) or
 *                    'percent'. Under 'percent' the server SENDS no amount,
 *                    so this is not a drawing preference the widget could
 *                    get wrong; it is what leaves the server.
 *   hideWhenLocked   draw placeholders while the phone is locked. The widget
 *                    still holds the document; iOS redacts the drawing.
 *
 * Each is its own key holding a plain string, not one JSON object: the
 * server reads them one at a time and a corrupt value costs one choice.
 */

export type WidgetDisplay = 'amounts' | 'percent';

export interface WidgetPrefs {
  display: WidgetDisplay;
  hideWhenLocked: boolean;
}

/** The entries in the preferences document. */
export const WIDGET_DISPLAY_KEY = 'widgetDisplay';
export const WIDGET_HIDE_WHEN_LOCKED_KEY = 'widgetHideWhenLocked';

export const DEFAULT_WIDGET_PREFS: WidgetPrefs = {
  display: 'amounts',
  hideWhenLocked: false,
};

/** Anything that is not exactly 'percent' is amounts — the default, and the ruling. */
export const parseWidgetDisplay = (raw: string | null | undefined): WidgetDisplay =>
  raw === 'percent' ? 'percent' : 'amounts';

/** Only the exact string 'true' hides; a value nobody recognises shows. */
export const parseWidgetHideWhenLocked = (raw: string | null | undefined): boolean => raw === 'true';

export const serialiseWidgetHideWhenLocked = (hide: boolean): string => (hide ? 'true' : 'false');
