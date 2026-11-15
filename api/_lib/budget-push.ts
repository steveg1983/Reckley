import type { SupabaseClient } from '@supabase/supabase-js';
import { measureBudget, parseBudgetView, BUDGET_VIEW_KEY, type BudgetView } from '../../src/utils/budgetView.js';
import { DEVICE_TIME_ZONE_KEY, parsePhoneNotificationPrefs, PHONE_NOTIFICATION_PREFS_KEY } from '../../src/services/push/prefs.js';
import { budgetLabel, evaluateRunningBudgets, localDay, type RunningBudgets } from './budget-status.js';
import { createSupabasePort } from './mcp/port.js';
import { loadPreferenceValues, notifyUser, pushDeps, usersWithEnabledDevices, type NotifyOutcome, type PushNote } from './push.js';
import { BANK_AUTO_SYNC_PREFS_KEY, isCloudMode } from './reminder-push.js';
import { describeSupabaseFailure } from './supabase-failure.js';
import { usableTimeZone, wallClockIn } from './widget-budgets.js';

/**
 * "A budget is nearly spent / over" — on the lock screen.
 *
 * The owner, 15 Nov 2026, after asking whether budget alerts worked (they did,
 * but only inside the app, and only when the Budget page was opened): "yes add
 * the budgets to the phone notifications".
 *
 * Every quarter-hour (the reminders cron), for each person who switched
 * "Budgets" on in cloud mode, the running budgets are evaluated exactly as the
 * Budget page and the widgets evaluate them (evaluateRunningBudgets, then
 * measureBudget under the person's own reading), against the threshold set in
 * Settings, Budget Alerts (80% unless changed): the same two bands the app's
 * own alerts use, "near" at the threshold and "over" from 100%.
 *
 * ONCE PER BAND PER PERIOD. budget_push_marks remembers the band last
 * announced and the period it was in. A budget is announced when it first
 * reaches a band in a period, again only if it goes from near to over, and
 * the mark goes when it drops back below the threshold or a new period
 * starts, which re-arms it. Written before the push, like the others.
 *
 * Percentages only, never an amount (owner, 11 Nov 2026: the lock screen).
 */

export const ALERT_THRESHOLD_KEY = 'money_management_alert_threshold';
export const DEFAULT_ALERT_THRESHOLD = 80;
const ROW_CAP = 20_000;

export type BudgetBand = 'near' | 'over';

export interface BudgetMark {
  band: BudgetBand;
  /** YYYY-MM-DD: the start of the period the band was announced in. */
  periodStart: string;
}

export interface BudgetPushDeps {
  now: () => Date;
  usersWithDevices: () => Promise<string[]>;
  loadPreferences: (userIds: readonly string[]) => Promise<Map<string, Record<string, string>>>;
  /** One person's running budgets, evaluated on their wall clock. */
  evaluate: (userId: string, today: Date) => Promise<RunningBudgets>;
  loadMarks: (userId: string) => Promise<Map<string, BudgetMark>>;
  mark: (userId: string, budgetId: string, mark: BudgetMark) => Promise<void>;
  unmark: (budgetIds: readonly string[]) => Promise<void>;
  notify: (userId: string, note: PushNote) => Promise<NotifyOutcome>;
}

export interface BudgetPushSummary {
  users: number;
  notCloud: number;
  /** Running budgets at or past the threshold now. */
  flagged: number;
  pushed: number;
  rearmed: number;
  sent: number;
  retired: number;
  failed: number;
}

/** The threshold from Settings, Budget Alerts (the slider runs 50–95%); anything unreadable is the default. */
export function alertThresholdFrom(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 && value <= 100 ? value : DEFAULT_ALERT_THRESHOLD;
}

/**
 * Which band a measured budget is in, or null below the threshold. The Budget
 * page's own rule: 100% and beyond is the danger band, the threshold the warning.
 */
export function bandOf(percentage: number, threshold: number): BudgetBand | null {
  if (percentage >= 100) return 'over';
  if (percentage >= threshold) return 'near';
  return null;
}

/** The lock-screen words. A percentage, never an amount. */
export const budgetNote = (budgetId: string, name: string, band: BudgetBand, percentage: number): PushNote =>
  band === 'over'
    ? {
        title: 'Budget spent',
        body: `${name} has used all of its budget.`,
        url: '/budget',
        collapseId: `budget-${budgetId}`,
        threadId: 'budgets',
      }
    : {
        title: 'Budget nearly spent',
        body: `${name} has used ${Math.floor(percentage)}% of its budget.`,
        url: '/budget',
        collapseId: `budget-${budgetId}`,
        threadId: 'budgets',
      };

export const pushBudgetAlerts = async (deps: BudgetPushDeps): Promise<BudgetPushSummary> => {
  const summary: BudgetPushSummary = { users: 0, notCloud: 0, flagged: 0, pushed: 0, rearmed: 0, sent: 0, retired: 0, failed: 0 };
  const withDevices = await deps.usersWithDevices();
  if (withDevices.length === 0) return summary;
  const preferences = await deps.loadPreferences(withDevices);
  const instant = deps.now();

  for (const userId of withDevices) {
    const values = preferences.get(userId);
    if (!values || !parsePhoneNotificationPrefs(values[PHONE_NOTIFICATION_PREFS_KEY]).budgets) continue;
    if (!isCloudMode(values[BANK_AUTO_SYNC_PREFS_KEY])) {
      summary.notCloud += 1;
      continue;
    }
    summary.users += 1;

    const today = wallClockIn(usableTimeZone(values[DEVICE_TIME_ZONE_KEY]), instant);
    const threshold = alertThresholdFrom(values[ALERT_THRESHOLD_KEY]);
    const view: BudgetView = parseBudgetView(values[BUDGET_VIEW_KEY]);
    const [running, marks] = await Promise.all([deps.evaluate(userId, today), deps.loadMarks(userId)]);

    const stillFlagged = new Set<string>();
    for (const entry of running.evaluated) {
      const measure = measureBudget(entry, view);
      const band = bandOf(measure.percentage, threshold);
      if (band === null) continue;
      const periodStart = localDay(measure.start);
      stillFlagged.add(entry.budget.id);
      summary.flagged += 1;

      const previous = marks.get(entry.budget.id);
      const samePeriod = previous !== undefined && previous.periodStart === periodStart;
      const alreadySaid = samePeriod && (previous.band === band || previous.band === 'over');
      if (alreadySaid) continue;

      await deps.mark(userId, entry.budget.id, { band, periodStart });
      const name = budgetLabel(entry.budget, entry.categoryId, running.categories);
      const outcome = await deps.notify(userId, budgetNote(entry.budget.id, name, band, measure.percentage));
      summary.pushed += 1;
      summary.sent += outcome.sent;
      summary.retired += outcome.retired;
      summary.failed += outcome.failed;
    }

    // Below the threshold again, finished, or deleted: re-arm.
    const rearm = [...marks.keys()].filter(id => !stillFlagged.has(id));
    if (rearm.length > 0) {
      await deps.unmark(rearm);
      summary.rearmed += rearm.length;
    }
  }
  return summary;
};

/** The verbs bound to Supabase and Apple, or null when APNs is not configured. */
export const budgetPushDeps = (supabase: SupabaseClient): BudgetPushDeps | null => {
  const push = pushDeps(supabase);
  if (!push) return null;
  return {
    now: () => new Date(),
    usersWithDevices: () => usersWithEnabledDevices(supabase),
    loadPreferences: (userIds) => loadPreferenceValues(supabase, userIds),
    evaluate: (userId, today) =>
      evaluateRunningBudgets(createSupabasePort(supabase, userId, { clientId: 'budget-push' }), today, ROW_CAP),
    loadMarks: async (userId) => {
      const { data, error, status } = await supabase
        .from('budget_push_marks')
        .select('budget_id, band, period_start')
        .eq('user_id', userId);
      if (error) throw new Error(`Failed to load budget push marks: ${describeSupabaseFailure(error, status)}`);
      const marks = new Map<string, BudgetMark>();
      for (const row of (data ?? []) as Array<{ budget_id: string; band: string; period_start: string }>) {
        if (row.band === 'near' || row.band === 'over') {
          marks.set(row.budget_id, { band: row.band, periodStart: row.period_start });
        }
      }
      return marks;
    },
    mark: async (userId, budgetId, mark) => {
      const { error, status } = await supabase
        .from('budget_push_marks')
        .upsert(
          { budget_id: budgetId, user_id: userId, band: mark.band, period_start: mark.periodStart, notified_at: new Date().toISOString() },
          { onConflict: 'budget_id' }
        );
      if (error) throw new Error(`Failed to record the budget push: ${describeSupabaseFailure(error, status)}`);
    },
    unmark: async (budgetIds) => {
      const { error, status } = await supabase.from('budget_push_marks').delete().in('budget_id', [...budgetIds]);
      if (error) throw new Error(`Failed to re-arm budget pushes: ${describeSupabaseFailure(error, status)}`);
    },
    notify: (userId, note) => notifyUser(push, userId, note),
  };
};
