/**
 * What a home-screen widget is told about the budgets: a small document,
 * already in words.
 *
 * ── THE WIDGET DOES NO ARITHMETIC AND NO FORMATTING ─────────────────────────
 * Every figure arrives as the text to draw — "£377 left", "Over by £155",
 * "62% used" — in the region the person chose in Settings, from the same
 * evaluation the Budget page draws (`api/_lib/budget-status`). The widget is
 * Swift; a second implementation of money formatting and of "what does left
 * mean when it is negative" in a second language is a second answer waiting
 * to happen. The one number it gets, `percent`, is for the length of a bar.
 *
 * ── PERCENTAGES ONLY MEANS NO AMOUNT LEAVES THE SERVER ──────────────────────
 * The owner's concern (9 Nov 2026) is what someone glancing at the phone can
 * read, and his ruling (10 Nov) is that the person chooses in Settings:
 * amounts, the default, or percentages only. Under 'percent' the amount
 * fields are ABSENT from the document, not present and undrawn — a widget
 * cannot leak what it was never sent, whatever a later layout does.
 *
 * ── WHOSE "TODAY" ───────────────────────────────────────────────────────────
 * A budget's window is measured in local days. The server's local day is
 * UTC's, which is the wrong day for an hour each night in a British summer
 * and for longer anywhere else — and midnight on the 1st is exactly when a
 * monthly budget turns over. The widget says where it is (its IANA zone) and
 * `wallClockIn` hands the evaluation that zone's calendar.
 *
 * ── THE WIDGET READS A LONG BUDGET AS THE APP DOES ──────────────────────────
 * The owner's ruling (10 Nov 2026): a yearly budget is read "so far" — spend
 * against the months that have begun — unless the person chooses this month's
 * share or the whole period (`src/utils/budgetView`). One setting, kept with
 * the account, and the same one the Dashboard and the Budget page draw by, so
 * a glance at the phone and the page behind it say the same figure. Under a
 * shorter reading the days left, and what is left per day, run to the end of
 * the month being read, not the end of the year.
 *
 * Nothing here is a TypeScript enum or a parameter property (the API project
 * compiles with `erasableSyntaxOnly`).
 */

import type { Budget, Category } from '../../src/types/index.js';
import type { EvaluatedBudget } from '../../src/utils/budgetEvaluation.js';
import { BUDGET_VIEW_KEY, measureBudget, parseBudgetView, type BudgetView } from '../../src/utils/budgetView.js';
import { toDecimal } from '../../src/utils/decimal.js';
import {
  parseWidgetDisplay,
  parseWidgetHideWhenLocked,
  WIDGET_DISPLAY_KEY,
  WIDGET_HIDE_WHEN_LOCKED_KEY,
  type WidgetDisplay,
} from '../../src/services/widget/prefs.js';
import { budgetLabel, localDay } from './budget-status.js';

export const WIDGET_DOCUMENT_VERSION = 1;

/**
 * The preference keys the widget's document is shaped by (the cloud
 * preferences document). The two the Settings card writes are declared once,
 * in src/services/widget/prefs, with the parsers both sides read them by.
 */
export { WIDGET_DISPLAY_KEY, WIDGET_HIDE_WHEN_LOCKED_KEY, type WidgetDisplay };
export const KEY_BUDGETS_KEY = 'dashboardKeyBudgets';
export { BUDGET_VIEW_KEY };
export const LOCALE_KEY = 'preferredLocale';

export const DEFAULT_LOCALE = 'en-GB';
export const DEFAULT_TIME_ZONE = 'Europe/London';

/** A bar turns to "near" at this share of the allowance unless the budget states its own threshold. */
export const DEFAULT_NEAR_PERCENT = 90;

/** Budgets one document carries: more than any widget draws, few enough to stay a small download. */
export const MAX_WIDGET_BUDGETS = 40;

export type WidgetAttention = 'none' | 'near' | 'over';

export interface WidgetBudget {
  id: string;
  name: string;
  /** One of the Dashboard's Key Budgets — what the first widget draws. */
  key: boolean;
  /** Spend as a share of the allowance, one decimal place. May pass 100. For the bar only. */
  percent: number;
  attention: WidgetAttention;
  /** "£377 left" · "Over by £155" — or, under 'percent', "62% used" · "Over by 12%". */
  status: string;
  /** "Monthly", "Yearly, so far", "Yearly, this month" … what the figures are for. */
  period: string;
  /** Last day the figures cover, YYYY-MM-DD: the window's, or the month's under a shorter reading. */
  until: string;
  /** Days left to that day, today included. Never below 1 for a running budget. */
  daysLeft: number;
  /** Present only under 'amounts'. */
  spent?: string;
  allowance?: string;
  /** What is left spread over the days left — "£18 a day". Absent when over, and under 'percent'. */
  perDay?: string;
}

export interface WidgetBudgetsDocument {
  v: number;
  /** The instant the figures were worked out, ISO 8601. */
  asOf: string;
  display: WidgetDisplay;
  hideWhenLocked: boolean;
  /** False when the person has no active budget at all — a different empty state from "none running". */
  hasBudgets: boolean;
  budgets: WidgetBudget[];
}

export interface WidgetSettings {
  display: WidgetDisplay;
  hideWhenLocked: boolean;
  keyBudgetIds: string[];
  locale: string;
  /** How a long budget is read — see the header. */
  budgetView: BudgetView;
}

/** A BCP 47 tag Intl accepts, or the default. A preference is a string someone else wrote. */
const usableLocale = (raw: string | undefined): string => {
  if (!raw) return DEFAULT_LOCALE;
  try {
    return Intl.NumberFormat.supportedLocalesOf([raw]).length > 0 ? raw : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
};

/** The widget's settings out of a preferences document's values; every absent or odd value is its default. */
export function widgetSettingsFrom(values: Record<string, string> | undefined): WidgetSettings {
  const source = values ?? {};
  let keyBudgetIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(source[KEY_BUDGETS_KEY] ?? 'null');
    if (Array.isArray(parsed)) keyBudgetIds = parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    keyBudgetIds = [];
  }
  return {
    display: parseWidgetDisplay(source[WIDGET_DISPLAY_KEY]),
    hideWhenLocked: parseWidgetHideWhenLocked(source[WIDGET_HIDE_WHEN_LOCKED_KEY]),
    keyBudgetIds,
    locale: usableLocale(source[LOCALE_KEY]),
    budgetView: parseBudgetView(source[BUDGET_VIEW_KEY]),
  };
}

/** An IANA zone Intl knows, or the default. */
export const usableTimeZone = (raw: unknown): string => {
  if (typeof raw !== 'string' || raw === '' || raw.length > 64) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: raw });
    return raw;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
};

/**
 * `instant` as the calendar and clock of `timeZone`, held in a Date whose
 * LOCAL parts are those — which is what the budget windows read. Whatever
 * zone the process runs in, `wallClockIn(…).getDate()` is the day it is for
 * the person.
 */
export function wallClockIn(timeZone: string, instant: Date): Date {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const part = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? '0');
  return new Date(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
}

/** Whole days from one local day to another, by calendar — a clock change in between is not a day. */
const daysBetween = (from: Date, to: Date): number =>
  Math.round(
    (Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) /
      86_400_000
  );

export interface DescribeInput {
  evaluated: ReadonlyArray<EvaluatedBudget<Budget>>;
  activeCount: number;
  currency: string;
  categories: Map<string, Category>;
  settings: WidgetSettings;
  /** The person's wall clock (see wallClockIn) — the same value the evaluation was given. */
  today: Date;
  /** The real instant, for `asOf`. */
  instant: Date;
}

export function describeBudgetsForWidget(input: DescribeInput): WidgetBudgetsDocument {
  const { settings, currency } = input;
  // A glance reads pounds, not pence; the Budget page has the pence.
  const whole = new Intl.NumberFormat(settings.locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  const count = new Intl.NumberFormat(settings.locale, { maximumFractionDigits: 0 });
  const amounts = settings.display === 'amounts';
  const keyOrder = new Map(settings.keyBudgetIds.map((id, index) => [id, index]));

  const described = input.evaluated.map((entry, storedIndex) => {
    const measure = measureBudget(entry, settings.budgetView);
    const over = measure.remaining.isNegative();
    const threshold =
      typeof entry.budget.alertThreshold === 'number' && entry.budget.alertThreshold > 0
        ? entry.budget.alertThreshold
        : DEFAULT_NEAR_PERCENT;
    const attention: WidgetAttention = over ? 'over' : measure.percentage >= threshold ? 'near' : 'none';
    const daysLeft = Math.max(1, daysBetween(input.today, measure.end) + 1);
    const left = measure.remaining.abs();

    let status: string;
    if (amounts) {
      status = over ? `Over by ${whole.format(left.toNumber())}` : `${whole.format(left.toNumber())} left`;
    } else {
      status = over
        ? `Over by ${count.format(Math.max(1, Math.round(measure.percentage - 100)))}%`
        : `${count.format(Math.round(measure.percentage))}% used`;
    }

    const budget: WidgetBudget = {
      id: entry.budget.id,
      // The category's own name, as the app labels the budget — never the
      // stored name first, which can be a category id (see budgetLabel).
      name: budgetLabel(entry.budget, entry.categoryId, input.categories),
      key: keyOrder.has(entry.budget.id),
      percent: Number(measure.percentage.toFixed(1)),
      attention,
      status,
      period:
        measure.view === 'toDate'
          ? `${entry.window.label}, so far`
          : measure.view === 'month'
            ? `${entry.window.label}, this month`
            : entry.window.label,
      until: localDay(measure.end),
      daysLeft,
    };
    if (amounts) {
      budget.spent = whole.format(measure.spent.toNumber());
      budget.allowance = whole.format(measure.allowance.toNumber());
      if (!over && left.greaterThan(0)) {
        budget.perDay = `${whole.format(left.dividedBy(toDecimal(daysLeft)).toNumber())} a day`;
      }
    }
    return { budget, storedIndex };
  });

  // The Key Budgets first, in the order the person put them; the rest as stored.
  described.sort((a, b) => {
    const ka = keyOrder.get(a.budget.id);
    const kb = keyOrder.get(b.budget.id);
    if (ka !== undefined && kb !== undefined) return ka - kb;
    if (ka !== undefined) return -1;
    if (kb !== undefined) return 1;
    return a.storedIndex - b.storedIndex;
  });

  return {
    v: WIDGET_DOCUMENT_VERSION,
    asOf: input.instant.toISOString(),
    display: settings.display,
    hideWhenLocked: settings.hideWhenLocked,
    hasBudgets: input.activeCount > 0,
    budgets: described.slice(0, MAX_WIDGET_BUDGETS).map(entry => entry.budget),
  };
}
