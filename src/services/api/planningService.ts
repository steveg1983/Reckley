/**
 * Planning data persistence: budgets, goals, categories, custom reports — THE
 * CLOUD HALF, and only the cloud half.
 *
 * Until 2026-06 these entities lived ONLY in React state — every budget and
 * goal was lost on page refresh, and nothing reached the cloud tables that
 * have existed since the initial schema.
 *
 * Budgets and goals: Supabase, per-user and RLS-scoped.
 *
 * Categories: cloud-synced via the migrate_categories_atomic RPC. The default
 * category set uses non-UUID ids ('type-income', 'transfer-in', …) which the
 * uuid-keyed cloud table cannot store, AND transactions/budgets reference
 * categories by those text ids — so on a user's first cloud load the RPC
 * generates per-user uuids and remaps every reference in ONE database
 * transaction (orphaning is structurally impossible).
 *
 * EVERY OPERATION HERE REQUIRES THE CLOUD CONNECTION AND A RESOLVED OWNER.
 * Until 2026-08 each one carried a second half that wrote encrypted
 * localStorage whenever Supabase was unconfigured OR the caller passed a null
 * user id. That half is gone, and removing it changed no behaviour, because it
 * could not run:
 *
 *  - The only production importer of this class is `dataService.ts` (`grep -rn
 *    PlanningService src api scripts` — every other match is a test; the
 *    unrelated `taxPlanningService` that used to share the suffix was
 *    retired 23 Aug 2026).
 *  - Every one of its call sites there sits inside a branch guarded by
 *    `userId && this.supabaseChecker()`, where `userId` is resolved on the same
 *    tick from `userIdService.getCurrentDatabaseUserId()` and `supabaseChecker`
 *    is `isSupabaseConfigured`. So a call that arrives here has a non-null owner
 *    and a configured client, and one that has neither never leaves DataService.
 *  - `cloudReady` below is `isSupabaseConfigured() && supabase !== null`, and
 *    supabaseClient defines `isSupabaseConfigured()` as exactly
 *    `supabase !== null`. The caller's guard and this class's guard are the same
 *    question, asked twice.
 *
 * So `cloudReady && userId` was always true when any of this ran, and the local
 * branches were dead code holding a live hazard: a null owner did not fail and
 * did not warn — it wrote the browser's copy, showed the user a saved budget,
 * and lost it at the next boot when the cloud read beside it answered instead.
 * Everything that is not a signed-in cloud session now goes through DataService,
 * which owns the browser-storage engine and refuses a write while a session is
 * still connecting. What is left here refuses by name.
 *
 * `getCategories` / `saveCategories` are NOT part of that retired half. They are
 * the cloud branches' own offline cache — refreshed after every category row
 * lands — and they are what a signed-in person's offline boot reads its category
 * names from.
 */

import { supabase, isSupabaseConfigured, handleSupabaseError } from './supabaseClient';
import { storageAdapter, STORAGE_KEYS } from '../storageAdapter';
import { createScopedLogger } from '../../loggers/scopedLogger';
import { getDefaultCategories } from '../../data/defaultCategories';
import { parseReportComponents, parseReportFilters } from '../reports/document';
import type {
  ForecastAdjustment,
  Budget,
  Category,
  CategoryMergeResult,
  CustomReport,
  Goal,
  ReportComponent
} from '../../types';

const logger = createScopedLogger('PlanningService');

type Row = Record<string, unknown>;

/** jsonb counter → number, refusing to invent a figure the database did not send. */
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ── Budget mapping ───────────────────────────────────────────────────────────

const budgetFromDb = (row: Row): Budget => ({
  id: String(row.id),
  // categoryId travels in the text `category` column — frontend category ids
  // are not UUIDs, so the uuid `category_id` column cannot hold them.
  categoryId: str(row.category) ?? '',
  amount: num(row.amount),
  period: (str(row.period) ?? 'monthly') as Budget['period'],
  // The `every` pair; null for every other period, by CHECK.
  repeatCount: typeof row.repeat_count === 'number' ? row.repeat_count : null,
  repeatUnit: row.repeat_unit === 'week' || row.repeat_unit === 'month' ? row.repeat_unit : null,
  isActive: row.is_active !== false,
  createdAt: row.created_at ? new Date(String(row.created_at)) : new Date(),
  updatedAt: row.updated_at ? new Date(String(row.updated_at)) : new Date(),
  name: str(row.name),
  spent: num(row.spent),
  startDate: str(row.start_date),
  endDate: str(row.end_date),
  rollover: row.rollover === true,
  rolloverAmount: num(row.rollover_amount),
  alertThreshold: typeof row.alert_threshold === 'number' ? row.alert_threshold : undefined,
  notes: str(row.notes)
});

const budgetToDb = (b: Partial<Budget>, userId?: string): Row => {
  const row: Row = {};
  if (userId) row.user_id = userId;
  if (b.name !== undefined || b.categoryId !== undefined) {
    row.name = b.name ?? b.categoryId ?? 'Budget';
  }
  if (b.categoryId !== undefined) row.category = b.categoryId;
  if (b.amount !== undefined) row.amount = b.amount;
  if (b.period !== undefined) row.period = b.period;
  if (b.repeatCount !== undefined) row.repeat_count = b.repeatCount;
  if (b.repeatUnit !== undefined) row.repeat_unit = b.repeatUnit;
  if (b.isActive !== undefined) row.is_active = b.isActive;
  if (b.spent !== undefined) row.spent = b.spent;
  if (b.startDate !== undefined) row.start_date = b.startDate;
  if (b.endDate !== undefined) row.end_date = b.endDate;
  if (b.rollover !== undefined) row.rollover = b.rollover;
  if (b.rolloverAmount !== undefined) row.rollover_amount = b.rolloverAmount;
  if (b.alertThreshold !== undefined) row.alert_threshold = b.alertThreshold;
  if (b.notes !== undefined) row.notes = b.notes;
  return row;
};

// ── Goal mapping ─────────────────────────────────────────────────────────────

/**
 * Cloud row → Goal.
 *
 * Exported so the mapping itself is testable: it is the whole of the cloud
 * round trip (the wire is covered by the Supabase smoke suite), and until
 * 2026-08 it was the only path with NO test at all — which is how `isActive`
 * came to be silently dropped on the way out.
 */
export const goalFromDb = (row: Row): Goal => {
  const metadata = (row.metadata ?? {}) as Row;
  const currentAmount = num(row.current_amount);
  return {
    id: String(row.id),
    name: str(row.name) ?? '',
    type: (str(metadata.type) ?? 'savings') as Goal['type'],
    targetAmount: num(row.target_amount),
    currentAmount,
    progress: currentAmount,
    targetDate: row.target_date ? new Date(String(row.target_date)) : new Date(),
    description: str(row.description),
    isActive: str(row.status) !== 'paused',
    achieved: str(row.status) === 'completed',
    status: (str(row.status) ?? 'active') as Goal['status'],
    // The achievement itself, not a per-device localStorage flag: a goal
    // reached on the laptop shows as reached on the phone.
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : undefined,
    createdAt: row.created_at ? new Date(String(row.created_at)) : new Date(),
    updatedAt: row.updated_at ? new Date(String(row.updated_at)) : new Date(),
    category: str(row.category),
    priority: str(row.priority) as Goal['priority'],
    accountId: str(row.account_id) ?? undefined,
    autoContribute: row.auto_contribute === true,
    contributionFrequency: str(row.contribution_frequency),
    icon: str(row.icon),
    color: str(row.color),
    linkedAccountIds: Array.isArray(metadata.linkedAccountIds)
      ? (metadata.linkedAccountIds as string[])
      : undefined,
    contributionAmount: typeof metadata.contributionAmount === 'number'
      ? metadata.contributionAmount
      : undefined
  };
};

/**
 * Goal → cloud row.
 *
 * `existingMetadata` is the row's CURRENT metadata, and it matters: metadata
 * carries three unrelated fields (type, linked accounts, contribution amount)
 * in one jsonb column, so rebuilding the object from a partial update — which
 * is what this did until 2026-08 — wiped whichever of the three the update did
 * not happen to mention. Editing a goal's type deleted its linked accounts.
 *
 * Exported for tests alongside goalFromDb.
 */
export const goalToDb = (g: Partial<Goal>, userId?: string, existingMetadata?: Row): Row => {
  const row: Row = {};
  if (userId) row.user_id = userId;
  if (g.name !== undefined) row.name = g.name;
  if (g.description !== undefined) row.description = g.description;
  if (g.targetAmount !== undefined) row.target_amount = g.targetAmount;
  // `progress` is the canonical accumulated amount in the UI layer.
  if (g.progress !== undefined) row.current_amount = g.progress;
  else if (g.currentAmount !== undefined) row.current_amount = g.currentAmount;
  if (g.targetDate !== undefined) {
    row.target_date = g.targetDate instanceof Date
      ? g.targetDate.toISOString().slice(0, 10)
      : g.targetDate;
  }
  if (g.category !== undefined) row.category = g.category;
  if (g.priority !== undefined) row.priority = g.priority;
  // `status` is the column; `isActive` is what the UI calls the same thing.
  // Mapping it here is what makes the modal's "Active Goal" checkbox mean
  // anything at all — before this, pausing a goal wrote nothing.
  if (g.status !== undefined) row.status = g.status;
  else if (g.achieved === true) row.status = 'completed';
  else if (g.isActive !== undefined) row.status = g.isActive ? 'active' : 'paused';
  if (row.status !== undefined) {
    // The achievement date follows the status, always: stamped when a goal
    // completes, cleared if it is ever reopened, so the two can never disagree.
    if (row.status === 'completed') {
      row.completed_at = g.completedAt ?? new Date().toISOString();
    } else {
      row.completed_at = null;
    }
  } else if (g.completedAt !== undefined) {
    row.completed_at = g.completedAt;
  }
  if (g.accountId !== undefined) row.account_id = g.accountId || null;
  if (g.autoContribute !== undefined) row.auto_contribute = g.autoContribute;
  if (g.contributionFrequency !== undefined) row.contribution_frequency = g.contributionFrequency || null;
  if (g.icon !== undefined) row.icon = g.icon;
  if (g.color !== undefined) row.color = g.color;
  // Fields without dedicated columns ride in metadata — merged over whatever
  // is already stored, never rebuilt from scratch.
  if (g.type !== undefined || g.linkedAccountIds !== undefined || g.contributionAmount !== undefined) {
    row.metadata = {
      ...(existingMetadata ?? {}),
      ...(g.type !== undefined ? { type: g.type } : {}),
      ...(g.linkedAccountIds !== undefined ? { linkedAccountIds: g.linkedAccountIds } : {}),
      ...(g.contributionAmount !== undefined ? { contributionAmount: g.contributionAmount } : {})
    };
  }
  return row;
};

// ── Custom report mapping ────────────────────────────────────────────────────

/**
 * Cloud row → CustomReport.
 *
 * `components` and `filters` are `jsonb`, so PostgREST hands them back as real
 * JSON values rather than as strings — which is why nothing here parses. What it
 * does instead is READ them, through `services/reports/document.ts`, and that
 * module is shared with the local engine on purpose: it is the only value in
 * this app stored as free JSON and read back as a closed type, so two
 * independent readers of it would not merely disagree about a field, they would
 * draw different reports from one stored definition.
 *
 * Exported for the reason `goalFromDb` is: the mapping IS the whole of the cloud
 * round trip, and the one path with no test at all is how `isActive` came to be
 * silently dropped from a goal.
 */
export const forecastAdjustmentFromDb = (row: Row): ForecastAdjustment => ({
  id: String(row.id),
  categoryId: String(row.category_id),
  // A bigint of pennies. Number() is exact here: JS integers are exact to
  // 2^53 and a monthly figure in pennies is nowhere near it.
  monthlyMinor: Number(row.monthly_minor),
  createdAt: row.created_at ? new Date(String(row.created_at)) : undefined,
  updatedAt: row.updated_at ? new Date(String(row.updated_at)) : undefined,
});

export const customReportFromDb = (row: Row): CustomReport => ({
  id: String(row.id),
  name: str(row.name) ?? '',
  // NOT `?? undefined`: `CustomReport.description` is a required string that the
  // builder writes as '' when nobody typed one, and the column is nullable.
  description: str(row.description) ?? '',
  components: parseReportComponents(row.components),
  filters: parseReportFilters(row.filters),
  createdAt: row.created_at ? new Date(String(row.created_at)) : new Date(),
  updatedAt: row.updated_at ? new Date(String(row.updated_at)) : new Date()
});

/**
 * CustomReport → cloud row.
 *
 * A WHITELIST, like `budgetToDb` and `categoryToDb` beside it: a key this
 * function has no line for never reaches the table, which is what keeps
 * `Partial<CustomReport>`'s `createdAt`/`updatedAt` from being written by a
 * caller that happened to spread a whole report into an update.
 *
 * ── THE TWO JSON COLUMNS ARE REPLACED, NOT MERGED ───────────────────────────
 *
 * The line that separates this from `goalToDb`, which takes the row's CURRENT
 * metadata and merges into it. That merge exists because three unrelated fields
 * share one jsonb column there, and rebuilding it from a partial update deleted
 * whichever of the three the update did not mention.
 *
 * Nothing shares these two columns, so there is nothing to merge and merging
 * would be a bug rather than a courtesy: `components` is the array the builder
 * just handed over, and a merge would make removing a component impossible — the
 * removed one would survive every save, and no screen would explain why.
 *
 * Values, not strings. Supabase serialises the object it is given into the jsonb
 * column; `JSON.stringify` here would store a jsonb STRING containing JSON, and
 * `parseReportComponents` would read it as "not an array" and answer with an
 * empty report.
 */
const customReportToDb = (report: Partial<CustomReport>, userId?: string): Row => {
  const row: Row = {};
  if (userId) row.user_id = userId;
  if (report.name !== undefined) row.name = report.name;
  if (report.description !== undefined) row.description = report.description;
  if (report.components !== undefined) row.components = componentsToJson(report.components);
  if (report.filters !== undefined) row.filters = { ...report.filters };
  return row;
};

/**
 * The components as plain JSON objects.
 *
 * Spread one level rather than handed over as-is, so what lands in the column is
 * a value this function chose rather than whatever object the builder's state
 * happens to be holding. `config` is spread too: it is the one nested object,
 * and a caller that kept a reference to it could otherwise change a row after it
 * was written.
 */
const componentsToJson = (components: readonly ReportComponent[]): Row[] =>
  components.map(component => ({
    id: component.id,
    type: component.type,
    title: component.title,
    config: { ...component.config },
    width: component.width
  }));

// ── Service ──────────────────────────────────────────────────────────────────

export class PlanningService {
  private static get cloudReady(): boolean {
    return isSupabaseConfigured() && supabase !== null;
  }

  // ----- Budgets -----

  static async getBudgets(userId: string | null): Promise<Budget[]> {
    if (!this.cloudReady || !userId) {
      throw new Error('getBudgets requires the cloud connection (local mode goes through DataService)');
    }

    // Inactive budgets load too: pausing a budget greys it out on the page
    // (which filters on isActive where it matters), it must not make the
    // budget vanish with no way to reactivate it.
    const { data, error } = await supabase!
      .from('budgets')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) {
      // A FAILED CLOUD READ IS NO BUDGETS, NOT SOMEBODY ELSE'S. This used to
      // fall back to browser storage, and for a signed-in session that is a
      // store the cloud path never writes: demo data, or an old signed-out
      // session's budgets, served as this account's with nothing on screen to
      // say so — and editing one of those rows then fails against a cloud id
      // that does not exist. Empty is the honest answer; the boot survives it
      // (the whole load shares one catch, and a rejection here would replace
      // the app with "Failed to load data" over a budget list); and the line
      // below is where the failure is visible.
      logger.error('getBudgets cloud read failed — returning no budgets', error);
      return [];
    }
    return ((data ?? []) as Row[]).map(budgetFromDb);
  }

  static async createBudget(userId: string | null, budget: Omit<Budget, 'id' | 'spent'>): Promise<Budget> {
    if (!this.cloudReady || !userId) {
      throw new Error('createBudget requires the cloud connection (local mode goes through DataService)');
    }

    const row = budgetToDb({ ...budget, spent: 0 }, userId);
    if (!row.start_date) row.start_date = new Date().toISOString().slice(0, 10);
    if (!row.name) row.name = budget.categoryId || 'Budget';
    const { data, error } = await supabase!
      .from('budgets')
      .insert(row as never)
      .select()
      .single();
    if (error) throw new Error(handleSupabaseError(error));
    return budgetFromDb(data as Row);
  }

  static async updateBudget(userId: string | null, id: string, updates: Partial<Budget>): Promise<Budget> {
    if (!this.cloudReady || !userId) {
      throw new Error('updateBudget requires the cloud connection (local mode goes through DataService)');
    }

    const { data, error } = await supabase!
      .from('budgets')
      .update(budgetToDb(updates) as never)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw new Error(handleSupabaseError(error));
    return budgetFromDb(data as Row);
  }

  static async deleteBudget(userId: string | null, id: string): Promise<void> {
    if (!this.cloudReady || !userId) {
      throw new Error('deleteBudget requires the cloud connection (local mode goes through DataService)');
    }

    const { error } = await supabase!
      .from('budgets')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw new Error(handleSupabaseError(error));
  }

  // ----- Goals -----

  static async getGoals(userId: string | null): Promise<Goal[]> {
    if (!this.cloudReady || !userId) {
      throw new Error('getGoals requires the cloud connection (local mode goes through DataService)');
    }

    const { data, error } = await supabase!
      .from('goals')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) {
      // No goals rather than another store's goals — the reasoning is on
      // `getBudgets` above, and it applies here word for word.
      logger.error('getGoals cloud read failed — returning no goals', error);
      return [];
    }
    return ((data ?? []) as Row[]).map(goalFromDb);
  }

  static async createGoal(userId: string | null, goal: Omit<Goal, 'id' | 'progress'>): Promise<Goal> {
    if (!this.cloudReady || !userId) {
      throw new Error('createGoal requires the cloud connection (local mode goes through DataService)');
    }

    // `progress` IS the accumulated amount, so a goal created with money
    // already put by starts at that figure — hard-coding 0 here threw the
    // user's opening amount away.
    const startingAmount = goal.currentAmount ?? 0;
    const row = goalToDb({ ...goal, progress: startingAmount }, userId);
    const { data, error } = await supabase!
      .from('goals')
      .insert(row as never)
      .select()
      .single();
    if (error) throw new Error(handleSupabaseError(error));
    return goalFromDb(data as Row);
  }

  static async updateGoal(userId: string | null, id: string, updates: Partial<Goal>): Promise<Goal> {
    if (!this.cloudReady || !userId) {
      throw new Error('updateGoal requires the cloud connection (local mode goes through DataService)');
    }

    // A metadata-backed field (type / linked accounts / contribution amount)
    // shares one jsonb column with the other two, and PostgREST cannot merge
    // server-side — so read the stored object and merge into it. Only the
    // updates that actually touch metadata pay for the extra round trip.
    let existingMetadata: Row | undefined;
    const touchesMetadata =
      updates.type !== undefined ||
      updates.linkedAccountIds !== undefined ||
      updates.contributionAmount !== undefined;
    if (touchesMetadata) {
      const { data: current, error: readError } = await supabase!
        .from('goals')
        .select('metadata')
        .eq('id', id)
        .eq('user_id', userId)
        .single();
      if (readError) throw new Error(handleSupabaseError(readError));
      const stored = (current as Row | null)?.metadata;
      existingMetadata = stored && typeof stored === 'object' ? (stored as Row) : undefined;
    }

    const { data, error } = await supabase!
      .from('goals')
      .update(goalToDb(updates, undefined, existingMetadata) as never)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw new Error(handleSupabaseError(error));
    return goalFromDb(data as Row);
  }

  static async deleteGoal(userId: string | null, id: string): Promise<void> {
    if (!this.cloudReady || !userId) {
      throw new Error('deleteGoal requires the cloud connection (local mode goes through DataService)');
    }

    const { error } = await supabase!
      .from('goals')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw new Error(handleSupabaseError(error));
  }

  // ----- Custom reports -----
  //
  // The newest family here, and the first one whose table exists because a
  // FEATURE was losing data rather than because a screen was being written.
  // Until migration 20260812140000 a custom report lived in
  // `localStorage['money_management_custom_reports']` and nowhere else: not on
  // the user's other device, not in a backup, and — on a desktop — not in the
  // ledger file they chose, but in the WebView's storage beside it.

  /**
   * The owner's reports, oldest first.
   *
   * `created_at ASC` is the order the budgets and the goals above are read in,
   * and it is what the reports page shows: the list somebody built, in the order
   * they built it, so a new report appears at the bottom where they left it
   * rather than jumping to the top of a list they were reading.
   *
   * A FAILED CLOUD READ IS NO REPORTS, not another store's. The argument is on
   * `getBudgets` above and applies word for word — with one thing extra to lose
   * here, because the browser store this used to fall back to is exactly the one
   * the migration in `customReportService` is reading OUT of. Serving it back as
   * the account's would offer the user a report they had already migrated, under
   * an id the cloud has never heard of, and the first edit to it would fail.
   */
  static async getCustomReports(userId: string | null): Promise<CustomReport[]> {
    if (!this.cloudReady || !userId) {
      throw new Error('getCustomReports requires the cloud connection (local mode goes through DataService)');
    }

    const { data, error } = await supabase!
      .from('custom_reports')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) {
      logger.error('getCustomReports cloud read failed — returning no reports', error);
      return [];
    }
    return ((data ?? []) as Row[]).map(customReportFromDb);
  }

  static async createCustomReport(
    userId: string | null,
    report: Omit<CustomReport, 'id'>
  ): Promise<CustomReport> {
    if (!this.cloudReady || !userId) {
      throw new Error('createCustomReport requires the cloud connection (local mode goes through DataService)');
    }

    // `components` and `filters` are stated even when the caller left them
    // empty, because the columns are NOT NULL: an empty report is a perfectly
    // ordinary thing to save halfway through building one, and the alternative
    // is a refusal from the database in place of a blank page.
    const row = customReportToDb({
      ...report,
      components: report.components ?? [],
      filters: report.filters
    }, userId);
    const { data, error } = await supabase!
      .from('custom_reports')
      .insert(row as never)
      .select()
      .single();
    if (error) throw new Error(handleSupabaseError(error));
    return customReportFromDb(data as Row);
  }

  static async updateCustomReport(
    userId: string | null,
    id: string,
    updates: Partial<CustomReport>
  ): Promise<CustomReport> {
    if (!this.cloudReady || !userId) {
      throw new Error('updateCustomReport requires the cloud connection (local mode goes through DataService)');
    }

    // No metadata read first, unlike `updateGoal`: there is nothing to merge
    // into. Both jsonb columns are replaced whole, which is the rule the seam
    // states and the reason removing a component works at all.
    const { data, error } = await supabase!
      .from('custom_reports')
      .update({ ...customReportToDb(updates), updated_at: new Date().toISOString() } as never)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw new Error(handleSupabaseError(error));
    return customReportFromDb(data as Row);
  }

  static async deleteCustomReport(userId: string | null, id: string): Promise<void> {
    if (!this.cloudReady || !userId) {
      throw new Error('deleteCustomReport requires the cloud connection (local mode goes through DataService)');
    }

    // No `.single()`, so an id naming nothing is a successful nothing — the rule
    // `deleteBudget` and `deleteGoal` keep, and the case a second device that
    // got there first actually produces.
    const { error } = await supabase!
      .from('custom_reports')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw new Error(handleSupabaseError(error));
  }

  // ----- Forecast adjustments -----
  //
  // The scenario's stated deviations from the base (20260819150000). The
  // dismissal family's shape rather than the report family's: a judgment
  // about how the ledger is READ, one row per (owner, category), upserted
  // because the scenario is a single stated figure per category rather than
  // a history of edits.

  /**
   * Every adjustment the owner has stated, oldest first — the order every
   * list here is read in. A FAILED CLOUD READ IS NO ADJUSTMENTS, `getBudgets`'
   * argument: the scenario quietly follows the base rather than inventing
   * deviations from another store.
   */
  static async getForecastAdjustments(userId: string | null): Promise<ForecastAdjustment[]> {
    if (!this.cloudReady || !userId) {
      throw new Error('getForecastAdjustments requires the cloud connection (local mode goes through DataService)');
    }

    const { data, error } = await supabase!
      .from('forecast_adjustments')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) {
      logger.error('getForecastAdjustments cloud read failed — returning none', error);
      return [];
    }
    return ((data ?? []) as Row[]).map(forecastAdjustmentFromDb);
  }

  /**
   * State, or restate, one category's scenario figure. An UPSERT on the
   * (owner, category) unique pair: the row keeps its identity and its
   * created_at, and only the figure and updated_at move.
   */
  static async setForecastAdjustment(
    userId: string | null,
    categoryId: string,
    monthlyMinor: number
  ): Promise<ForecastAdjustment> {
    if (!this.cloudReady || !userId) {
      throw new Error('setForecastAdjustment requires the cloud connection (local mode goes through DataService)');
    }

    const { data, error } = await supabase!
      .from('forecast_adjustments')
      .upsert(
        { user_id: userId, category_id: categoryId, monthly_minor: monthlyMinor } as never,
        { onConflict: 'user_id,category_id' }
      )
      .select()
      .single();
    if (error) throw new Error(handleSupabaseError(error));
    return forecastAdjustmentFromDb(data as Row);
  }

  /**
   * The category goes back to following the base. No `.single()`: clearing a
   * category that holds no adjustment is a successful nothing — the caller
   * asked for a state, and the state is already so.
   */
  static async clearForecastAdjustment(userId: string | null, categoryId: string): Promise<void> {
    if (!this.cloudReady || !userId) {
      throw new Error('clearForecastAdjustment requires the cloud connection (local mode goes through DataService)');
    }

    const { error } = await supabase!
      .from('forecast_adjustments')
      .delete()
      .eq('category_id', categoryId)
      .eq('user_id', userId);
    if (error) throw new Error(handleSupabaseError(error));
  }

  // ----- Categories -----

  /**
   * The browser's copy of the cloud category list.
   *
   * THE CACHE, NOT A LOCAL MODE — which is why these two survived the retirement
   * of everything else that touched browser storage here. Every category write
   * below refreshes this copy after its row lands, and it is what a signed-in
   * person's offline boot reads its category names from (through
   * `ensureCategories`' error path, and through DataService's own read of the
   * same key). Nothing about it answers "what are this account's categories" on
   * its own: it only ever holds what the cloud last said.
   */
  static async getCategories(): Promise<Category[]> {
    const stored = await storageAdapter.get<Category[]>(STORAGE_KEYS.CATEGORIES);
    return stored || [];
  }

  /** Refresh the cache above. Called after every category row that lands. */
  static async saveCategories(categories: Category[]): Promise<void> {
    await storageAdapter.set(STORAGE_KEYS.CATEGORIES, categories);
  }

  /**
   * Cloud category load with first-run migration/seeding.
   *
   * - Cloud has rows → return them (and refresh the cache).
   * - Cloud empty → run migrate_categories_atomic with the browser's cached
   *   categories (or the default set for brand-new users). The RPC inserts
   *   uuid-keyed copies AND remaps every transaction/budget category reference
   *   in one database transaction.
   * - Cloud read fails → the cached copy, which is this account's own list as of
   *   the last successful load.
   */
  static async ensureCategories(userId: string | null): Promise<Category[]> {
    if (!this.cloudReady || !userId) {
      throw new Error('ensureCategories requires the cloud connection (local mode goes through DataService)');
    }

    const { data, error } = await supabase!
      .from('categories')
      .select('*')
      .eq('user_id', userId)
      .order('level', { ascending: true })
      .order('name', { ascending: true });

    if (error) {
      // THE CACHE, and it is the reason this branch is not the refusal above:
      // these are this account's own cloud categories as of the last successful
      // load, not another store's. Withholding them would blank the register's
      // category column and the category filter for a person whose ledger is
      // perfectly fine — offline, or through one failed request.
      logger.error('ensureCategories cloud read failed, using the cached copy', error);
      const local = await this.getCategories();
      return local.length > 0 ? local : getDefaultCategories();
    }

    const rows = (data ?? []) as Row[];
    if (rows.length > 0) {
      const categories = rows.map(categoryFromDb);
      await this.saveCategories(categories); // refresh cache
      return categories;
    }

    // First cloud load: migrate localStorage categories (or seed defaults).
    const local = await this.getCategories();
    const source = local.length > 0 ? local : getDefaultCategories();

    const { data: migrated, error: rpcError } = await supabase!.rpc('migrate_categories_atomic', {
      p_user_id: userId,
      p_categories: source.map(categoryToRpcPayload)
    });

    if (rpcError) {
      // 'categories_already_migrated' = a concurrent session won the race —
      // re-read instead of failing.
      if (rpcError.message?.includes('categories_already_migrated')) {
        const retry = await supabase!
          .from('categories')
          .select('*')
          .eq('user_id', userId);
        const retryRows = ((retry.data ?? []) as Row[]).map(categoryFromDb);
        if (retryRows.length > 0) {
          await this.saveCategories(retryRows);
          return retryRows;
        }
      }
      logger.error('Category migration failed, staying on local set', rpcError);
      return source;
    }

    const categories = ((migrated ?? []) as Row[]).map(categoryFromDb);
    await this.saveCategories(categories);
    logger.info(`Categories migrated to cloud: ${categories.length} (from ${local.length > 0 ? 'localStorage' : 'defaults'})`);
    return categories;
  }

  static async createCategory(userId: string | null, category: Omit<Category, 'id'>): Promise<Category> {
    if (!this.cloudReady || !userId) {
      throw new Error('createCategory requires the cloud connection (local mode goes through DataService)');
    }

    const row = categoryToDb(category, userId);
    const { data, error } = await supabase!
      .from('categories')
      .insert(row as never)
      .select()
      .single();
    if (error) throw new Error(handleSupabaseError(error));
    const created = categoryFromDb(data as Row);
    const cache = await this.getCategories();
    await this.saveCategories([...cache, created]);
    return created;
  }

  /**
   * Bulk delete of UNUSED categories (the Money-set "replace" import). Cloud
   * mode goes through the delete_unused_categories RPC, which re-verifies
   * EVERY row server-side (no transaction/budget/recurring references, no
   * children outside the batch, never type/transfer categories) — a stale
   * client snapshot can therefore never destroy referenced data. Returns the
   * number of rows actually deleted.
   */
  static async deleteUnusedCategories(userId: string | null, ids: string[]): Promise<number> {
    // Nothing to prune is not a refusal: an import that plans no deletions asks
    // anyway, and answering "there is no cloud connection" to a request that
    // would send no rows would be an error message about a write nobody made.
    if (ids.length === 0) {
      return 0;
    }

    if (!this.cloudReady || !userId) {
      throw new Error('deleteUnusedCategories requires the cloud connection (local mode goes through DataService)');
    }

    const { data, error } = await supabase!.rpc('delete_unused_categories', {
      p_ids: ids,
      p_user_id: userId
    });
    if (error) throw new Error(handleSupabaseError(error));
    const deleted = typeof data === 'number' ? data : 0;
    // The RPC may have skipped rows; refresh the cache from the cloud so
    // the local view matches what actually survived.
    const { data: rows, error: readError } = await supabase!
      .from('categories')
      .select('*')
      .eq('user_id', userId);
    if (!readError && rows) {
      await this.saveCategories((rows as Row[]).map(categoryFromDb));
    }
    return deleted;
  }

  /** Bulk create — one insert round trip instead of N (used by tree imports). */
  static async createCategories(userId: string | null, newCategories: Array<Omit<Category, 'id'>>): Promise<Category[]> {
    // Empty first, for the reason `deleteUnusedCategories` above gives.
    if (newCategories.length === 0) {
      return [];
    }

    if (!this.cloudReady || !userId) {
      throw new Error('createCategories requires the cloud connection (local mode goes through DataService)');
    }

    const rows = newCategories.map(category => categoryToDb(category, userId));
    const { data, error } = await supabase!
      .from('categories')
      .insert(rows as never)
      .select();
    if (error) throw new Error(handleSupabaseError(error));
    const created = ((data ?? []) as Row[]).map(categoryFromDb);
    const cache = await this.getCategories();
    await this.saveCategories([...cache, ...created]);
    return created;
  }

  static async updateCategory(userId: string | null, id: string, updates: Partial<Category>): Promise<Category> {
    if (!this.cloudReady || !userId) {
      throw new Error('updateCategory requires the cloud connection (local mode goes through DataService)');
    }

    const { data, error } = await supabase!
      .from('categories')
      .update(categoryToDb(updates) as never)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw new Error(handleSupabaseError(error));
    const updated = categoryFromDb(data as Row);
    const cache = await this.getCategories();
    await this.saveCategories(cache.map(c => c.id === id ? updated : c));
    return updated;
  }

  /**
   * Join two categories: every reference moves from source to target and the
   * source is removed — in ONE database transaction (merge_categories,
   * migration 20260805214322).
   *
   * The RPC validates every precondition against the rows as they are NOW
   * (ownership, direction, groups, transfer/system/unassigned categories) and
   * surfaces its errors verbatim, because each one names the exact rule that
   * stopped it. There is no half-applied state for the caller to explain away.
   *
   * Cloud only: local/demo mode goes through DataService, which mirrors these
   * rules against browser storage.
   */
  static async mergeCategories(
    userId: string | null,
    sourceId: string,
    targetId: string
  ): Promise<CategoryMergeResult> {
    if (!this.cloudReady || !userId) {
      throw new Error('mergeCategories requires the cloud connection (local mode goes through DataService)');
    }

    const { data, error } = await supabase!.rpc('merge_categories', {
      p_source_id: sourceId,
      p_target_id: targetId,
      p_user_id: userId
    });
    if (error) throw new Error(handleSupabaseError(error));

    const result = (data ?? {}) as Row;
    // The source is gone server-side; drop it from the cache rather than
    // leaving a category the database no longer has in the offline snapshot.
    const cache = await this.getCategories();
    await this.saveCategories(cache.filter(c => c.id !== sourceId));

    return {
      sourceId,
      targetId,
      transactions: count(result.transactions),
      splitLines: count(result.split_lines),
      splitTransactions: count(result.split_transactions),
      budgets: count(result.budgets),
      recurring: count(result.recurring)
    };
  }

  static async deleteCategory(userId: string | null, id: string): Promise<void> {
    if (!this.cloudReady || !userId) {
      throw new Error('deleteCategory requires the cloud connection (local mode goes through DataService)');
    }

    // parent_id FK is ON DELETE CASCADE — children go with the parent, and the
    // cache below is dropped the same way so the browser's copy cannot keep a
    // group of orphans whose parent the database has already removed.
    const { error } = await supabase!
      .from('categories')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw new Error(handleSupabaseError(error));
    const cache = await this.getCategories();
    await this.saveCategories(cache.filter(c => c.id !== id && c.parentId !== id));
  }
}

// ── Category mapping ─────────────────────────────────────────────────────────

const categoryFromDb = (row: Row): Category => ({
  id: String(row.id),
  name: str(row.name) ?? '',
  type: (str(row.type) ?? 'expense') as Category['type'],
  level: (str(row.level) ?? 'detail') as Category['level'],
  parentId: str(row.parent_id) ?? null,
  color: str(row.color),
  icon: str(row.icon),
  isSystem: row.is_system === true,
  isTransferCategory: row.is_transfer_category === true,
  isRevaluationCategory: row.is_revaluation_category === true,
  isUnassignedBucket: row.is_unassigned_bucket === true,
  accountId: str(row.account_id) ?? undefined,
  isActive: row.is_active !== false
});

const categoryToDb = (c: Partial<Category>, userId?: string): Row => {
  const row: Row = {};
  if (userId) row.user_id = userId;
  if (c.name !== undefined) row.name = c.name;
  if (c.type !== undefined) row.type = c.type;
  if (c.level !== undefined) row.level = c.level;
  if (c.parentId !== undefined) row.parent_id = c.parentId || null;
  if (c.color !== undefined) row.color = c.color;
  if (c.icon !== undefined) row.icon = c.icon;
  if (c.isSystem !== undefined) row.is_system = c.isSystem;
  if (c.isTransferCategory !== undefined) row.is_transfer_category = c.isTransferCategory;
  if (c.isRevaluationCategory !== undefined) row.is_revaluation_category = c.isRevaluationCategory;
  if (c.isUnassignedBucket !== undefined) row.is_unassigned_bucket = c.isUnassignedBucket;
  if (c.accountId !== undefined) row.account_id = c.accountId || null;
  if (c.isActive !== undefined) row.is_active = c.isActive;
  return row;
};

/** Shape the RPC expects: camelCase keys matching the frontend Category. */
const categoryToRpcPayload = (c: Category): Record<string, unknown> => ({
  id: c.id,
  name: c.name,
  type: c.type,
  level: c.level,
  parentId: c.parentId ?? null,
  color: c.color ?? null,
  icon: c.icon ?? null,
  isSystem: c.isSystem ?? false,
  isTransferCategory: c.isTransferCategory ?? false,
  isRevaluationCategory: c.isRevaluationCategory ?? false,
  isUnassignedBucket: c.isUnassignedBucket ?? false,
  accountId: c.accountId ?? null,
  isActive: c.isActive ?? true
});
