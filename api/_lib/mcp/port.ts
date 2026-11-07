/**
 * The connector's data port — what the tools may ask of a ledger.
 *
 * ── WHY A PORT ──────────────────────────────────────────────────────────────
 * The tools are written against this interface and nothing else, for two
 * reasons. The specs drive the server through a real MCP client with a fake
 * port holding a dozen rows, so every tool's wording, pagination and limits
 * are proved without a database. And the Supabase half below is the ONLY
 * place the service-role client is touched: every query is scoped to the one
 * `userId` the port was built for, because the service role bypasses
 * row-level security and a tool that forgot the scope would read another
 * person's money. A tool cannot forget it — it never sees the client.
 *
 * ── SHAPES ──────────────────────────────────────────────────────────────────
 * Rows come back in the app's own types (`Transaction`, `Category`, …) so the
 * app's own arithmetic can be reused on them: spending by category goes
 * through `computeIncomeExpense`, budgets through `evaluateBudgets`. One
 * semantics for the register and for Claude, or the two would disagree about
 * the same month.
 *
 * ── THE WRITE SIDE CALLS THE REGISTER'S VERBS AND NOTHING ELSE ──────────────
 * Every write is one of the atomic RPCs the app itself uses —
 * `update_transaction_atomic`, `confirm_transaction_categories`,
 * `set_transactions_cleared`, `link_transfer_pair`,
 * `create_transfer_counterpart`, `create_transaction_atomic` — each carrying
 * the audit log, the owner guard (`p_user_id`, never NULL: NULL there means
 * "no owner named", not "me") and the review semantics the migrations argue
 * out. A precondition the database refuses comes back as a `PortRefusal`
 * whose message is the database's own sentence, written for a person; a
 * failure of the transport is a `PortError`, as on the read side.
 *
 * The audit log's actor column is derived from the caller's session token,
 * which the service role does not carry, so a row written here would read as
 * written by nobody. Each write therefore stamps `metadata.mcp` — the OAuth
 * client id and the instant — merged over whatever the row's metadata already
 * held (the feed keeps adoption notes there), so a row can later say Claude
 * filed it, and the audit entry's after_data shows the stamp.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Budget, Category, Transaction, TransactionSplit } from '../../../src/types/index.js';
import { readAllPages } from './paging.js';

/** Which rows a search wants with respect to review. */
export type ReviewFilter = 'awaiting' | 'done' | 'any';

export interface TransactionFilter {
  /** Case-insensitive substring of the description. */
  text?: string;
  accountId?: string;
  /** A category id; rows filed exactly there. */
  categoryId?: string;
  /** Inclusive, YYYY-MM-DD. */
  from?: string;
  /** Inclusive, YYYY-MM-DD. */
  to?: string;
  /** Signed amounts, so -50 .. -10 is "spending between 10 and 50". */
  minAmount?: number;
  maxAmount?: number;
  review?: ReviewFilter;
  cleared?: boolean;
  /** Archived rows are left out unless asked for. */
  includeArchived?: boolean;
}

export interface PageRequest {
  limit: number;
  offset: number;
  /** Oldest first instead of the default newest first — for "the first time" questions. */
  oldestFirst?: boolean;
}

export interface PageOf<T> {
  rows: T[];
  /** Matches in all, not just this page. */
  total: number;
}

/** An account as the connector reports it. Plain, so no app-type mapping of `type` is needed. */
export interface PortAccount {
  id: string;
  name: string;
  /** The stored kind: checking, savings, credit, cash, investment, loan, assets, other. */
  type: string;
  currency: string;
  isActive: boolean;
  institution: string | null;
  /** Opening balance plus every row, as the register computes it. */
  balance: number;
  openingBalance: number;
  /** YYYY-MM-DD when the person or an importer recorded one. */
  openingBalanceDate: string | null;
  /** What the bank last said, when a feed or statement said it. */
  bankBalance: number | null;
  bankBalanceDate: string | null;
  lastReconciledDate: string | null;
}

export interface TransactionDetail {
  transaction: Transaction;
  splits: TransactionSplit[];
}

export interface RowsInRange {
  rows: Transaction[];
  splits: TransactionSplit[];
  /** True when more rows existed than the cap allowed; totals are then partial. */
  capped: boolean;
}

/** What a write tool may change on one row; a field is written only when present. */
export interface TransactionPatch {
  description?: string;
  /** An empty string clears the note, as the editor's own save does. */
  notes?: string;
  /** A category id; the register's `category` column holds the id as text. */
  category?: string;
  categoryConfirmed?: boolean;
  needsReview?: boolean;
}

/** A manual row, as the Add form would submit it: the amount already signed. */
export interface NewTransaction {
  accountId: string;
  /** YYYY-MM-DD. */
  date: string;
  description: string;
  /** Signed: spending negative, income positive (utils/transactionAmount). */
  amount: number;
  type: 'income' | 'expense';
  category?: string;
  notes?: string;
  /** False when the category is Claude's suggestion rather than the person's choice. */
  categoryConfirmed: boolean;
  /** True to leave the row in To Review — what a suggested filing does. */
  needsReview: boolean;
}

/** Who is writing, for the provenance stamp. */
export interface WriteProvenance {
  /** The OAuth client the token was issued to (Claude's registration). */
  clientId: string;
}

/**
 * A write the ledger refused on its own rules — a missing row, a split that
 * cannot become a transfer, amounts that are not opposite. The message is for
 * the person: it names the rule, and nothing was changed.
 */
export class PortRefusal extends Error {}

export interface ReckleyPort {
  listAccounts(): Promise<PortAccount[]>;
  searchTransactions(filter: TransactionFilter, page: PageRequest): Promise<PageOf<Transaction>>;
  getTransaction(id: string): Promise<TransactionDetail | null>;
  listCategories(): Promise<Category[]>;
  listBudgets(): Promise<Budget[]>;
  /**
   * Every row dated in [from, to], with the splits of any split parents, up
   * to `cap` rows. Archived rows are left out unless asked for: the reports
   * leave them out, the net-worth walk needs them.
   */
  transactionsBetween(from: string, to: string, cap: number, options?: { includeArchived?: boolean }): Promise<RowsInRange>;
  /**
   * Each account's earliest transaction day, for the opening-date rule; null
   * when the database cannot answer (the function is not installed yet).
   */
  firstActivityDates(): Promise<Map<string, string> | null>;
  /** Every non-archived row awaiting review (the app's own predicate), oldest first, up to `cap`. */
  reviewQueue(cap: number): Promise<{ rows: Transaction[]; capped: boolean }>;

  // ── Writes: each one register verb, each refusing on the verb's own rules ──

  /** The rows with these ids that belong to this ledger; an unknown id is simply absent. */
  transactionsById(ids: string[]): Promise<Transaction[]>;
  /** `update_transaction_atomic` on one row; the row as written. */
  updateTransaction(id: string, patch: TransactionPatch): Promise<Transaction>;
  /** `confirm_transaction_categories`: how many rows were actually confirmed. */
  confirmCategories(ids: string[]): Promise<number>;
  /** `set_transactions_cleared`: how many rows actually changed. */
  setCleared(ids: string[], cleared: boolean): Promise<number>;
  /** `link_transfer_pair`: both sides as written. */
  linkTransfer(idA: string, idB: string): Promise<{ a: Transaction; b: Transaction }>;
  /** `create_transfer_counterpart`: the source as rewritten and the new other side. */
  createTransferCounterpart(id: string, targetAccountId: string): Promise<{ source: Transaction; counterpart: Transaction }>;
  /** `create_transaction_atomic`: the new row. */
  createTransaction(input: NewTransaction): Promise<Transaction>;
}

// ── The Supabase half ───────────────────────────────────────────────────────

interface TransactionRow {
  id: string;
  account_id: string;
  date: string;
  description: string;
  amount: number | string;
  type: 'income' | 'expense' | 'transfer';
  category: string | null;
  notes: string | null;
  tags: string[] | null;
  is_cleared: boolean | null;
  needs_review: boolean | null;
  category_confirmed: boolean | null;
  is_split: boolean | null;
  transfer_account_id: string | null;
  linked_transfer_id: string | null;
  is_reconciled: boolean | null;
  archived: boolean | null;
  metadata?: Record<string, unknown> | null;
}

const TRANSACTION_COLUMNS =
  'id, account_id, date, description, amount, type, category, notes, tags, is_cleared, needs_review, ' +
  'category_confirmed, is_split, transfer_account_id, linked_transfer_id, is_reconciled, archived';

interface SplitRow {
  id: string;
  transaction_id: string;
  category: string;
  amount: number | string;
  memo: string | null;
  sort_order: number | null;
  transfer_account_id: string | null;
  linked_transfer_id: string | null;
}

interface AccountRow {
  id: string;
  name: string;
  type: string;
  currency: string | null;
  is_active: boolean | null;
  institution: string | null;
  initial_balance: number | string | null;
  opening_balance_date: string | null;
  bank_balance: number | string | null;
  bank_balance_date: string | null;
  last_reconciled_date: string | null;
}

interface CategoryRow {
  id: string;
  name: string;
  type: 'income' | 'expense' | 'both';
  level: 'type' | 'sub' | 'detail';
  parent_id: string | null;
  is_system: boolean | null;
  is_transfer_category: boolean | null;
  is_revaluation_category: boolean | null;
  is_unassigned_bucket: boolean | null;
  account_id: string | null;
  is_active: boolean | null;
}

interface BudgetRow {
  id: string;
  name: string;
  amount: number | string;
  period: string;
  repeat_count: number | null;
  repeat_unit: string | null;
  category: string | null;
  category_id: string | null;
  start_date: string | null;
  end_date: string | null;
  is_active: boolean | null;
  rollover: boolean | null;
  rollover_amount: number | string | null;
  alert_threshold: number | string | null;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
}

/**
 * The register's "awaiting review" predicate as a PostgREST filter: flagged,
 * OR unfiled and neither a transfer nor a split (utils/transactionReview).
 * Written once, used by the search and by the review queue.
 */
const AWAITING_REVIEW_FILTER =
  "needs_review.eq.true,and(category.is.null,type.neq.transfer,is_split.neq.true),and(category.eq.'',type.neq.transfer,is_split.neq.true)";

/** PostgREST hands numerics back as strings; the app's rows carry numbers. */
const num = (value: number | string | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

/**
 * A date-only column read as the UTC midnight of that day — exactly what the
 * app does with the same string — so `toISOString().slice(0, 10)` gives the
 * day back whatever the function's own timezone.
 */
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

export const toTransaction = (row: TransactionRow): Transaction => ({
  id: row.id,
  accountId: row.account_id,
  date: day(row.date),
  description: row.description,
  amount: num(row.amount),
  type: row.type,
  category: row.category ?? '',
  notes: row.notes ?? undefined,
  tags: row.tags ?? undefined,
  cleared: row.is_cleared === true,
  needsReview: row.needs_review === true,
  // The provenance asymmetry: only an explicit false is a guess.
  categoryConfirmed: row.category_confirmed !== false,
  isSplit: row.is_split === true,
  transferAccountId: row.transfer_account_id ?? undefined,
  linkedTransferId: row.linked_transfer_id ?? undefined,
  reconciled: row.is_reconciled === true,
});

const toSplit = (row: SplitRow): TransactionSplit => ({
  id: row.id,
  transactionId: row.transaction_id,
  category: row.category,
  amount: num(row.amount),
  memo: row.memo ?? undefined,
  sortOrder: row.sort_order ?? 0,
  transferAccountId: row.transfer_account_id ?? undefined,
  linkedTransferId: row.linked_transfer_id ?? undefined,
});

const toCategory = (row: CategoryRow): Category => ({
  id: row.id,
  name: row.name,
  type: row.type,
  level: row.level,
  parentId: row.parent_id,
  isSystem: row.is_system === true,
  isTransferCategory: row.is_transfer_category === true,
  isRevaluationCategory: row.is_revaluation_category === true,
  isUnassignedBucket: row.is_unassigned_bucket === true,
  accountId: row.account_id ?? undefined,
  isActive: row.is_active !== false,
});

const toBudget = (row: BudgetRow): Budget => ({
  id: row.id,
  name: row.name,
  // The id column is the modern key; older rows carry the category under
  // `category`, which the shared evaluation heals by name.
  categoryId: row.category_id ?? row.category ?? '',
  amount: num(row.amount),
  period: row.period as Budget['period'],
  repeatCount: row.repeat_count,
  repeatUnit: row.repeat_unit === 'week' || row.repeat_unit === 'month' ? row.repeat_unit : null,
  isActive: row.is_active !== false,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at ?? row.created_at),
  spent: 0,
  startDate: row.start_date ?? undefined,
  endDate: row.end_date ?? undefined,
  rollover: row.rollover === true,
  rolloverAmount: num(row.rollover_amount),
  alertThreshold: row.alert_threshold === null ? undefined : num(row.alert_threshold),
  notes: row.notes ?? undefined,
});

/** A query failure, with the Supabase message kept server-side and a plain one for the tool. */
export class PortError extends Error {
  readonly detail: string;

  constructor(what: string, detail: string) {
    super(`${what} could not be read from the ledger. Try again; if it keeps failing, check the app itself.`);
    this.detail = detail;
  }
}

const fail = (what: string, error: { message: string }): never => {
  console.error(`[mcp] ${what} failed: ${error.message}`);
  throw new PortError(what, error.message);
};

/**
 * A verb's RAISE EXCEPTION, as PostgREST relays it. The migrations write
 * their refusals for a person ("a split transaction cannot become a transfer
 * — remove the split first"), so those sentences are passed on as they are;
 * the two bare identifiers are given words here. Anything else is the
 * transport's problem, not the ledger's answer.
 */
const refuseOrFail = (what: string, error: { message: string; code?: string }): never => {
  const code = error.code ?? '';
  if (code === 'P0002' || /transaction_not_found/.test(error.message)) {
    throw new PortRefusal('That transaction is not in this ledger. Nothing was changed.');
  }
  if (/account_not_found_or_not_owned/.test(error.message)) {
    throw new PortRefusal('That account is not in this ledger. Nothing was changed.');
  }
  if (code === 'P0001' || code === '22023' || code === '28000') {
    throw new PortRefusal(`${error.message}. Nothing was changed.`);
  }
  return fail(what, error);
};

/** `metadata.mcp` over what the row already held: the feed keeps its own notes there. */
const stamp = (existing: Record<string, unknown> | null | undefined, who: WriteProvenance, at: Date): Record<string, unknown> => ({
  ...(existing ?? {}),
  mcp: { client_id: who.clientId, at: at.toISOString() },
});

/** The row a verb hands back (`RETURNS public.transactions`, or a jsonb of one), in the app's shape. */
const rowFromVerb = (what: string, value: unknown): Transaction => {
  if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') {
    throw new PortError(what, 'the verb returned no row');
  }
  return toTransaction(value as TransactionRow);
};

/** `RETURNS integer`, and never "all of them" when it is not (transactionService's rule). */
const countFromVerb = (what: string, value: unknown): number => {
  if (typeof value !== 'number') throw new PortError(what, 'the verb returned no count');
  return value;
};

/**
 * The port over the service-role client, scoped to one ledger user.
 *
 * `userId` is the `users.id` the Clerk token resolved to — never a value a
 * tool argument could supply.
 */
export function createSupabasePort(
  supabase: SupabaseClient,
  userId: string,
  provenance: WriteProvenance = { clientId: 'unknown' },
  now: () => Date = () => new Date()
): ReckleyPort {
  /**
   * Opening balance plus every row the account holds — the figure the
   * register shows — by account id.
   *
   * The database does the sum (`account_balances_for_user`, the server-side
   * twin of the app's `account_balances()`): one round trip, exact numeric
   * arithmetic, every row. The first version of this summed through
   * PostgREST, which caps a select at 1,000 rows and says nothing, so an
   * account with 1,859 rows read −438,191.80 where the app shows 0.00 (the
   * owner's first question to the connector, 21 Oct 2026). Until the
   * migration that adds the function has been applied, the paged read below
   * gives the same answer more slowly, in pence so the float never drifts.
   */
  const accountBalances = async (accounts: AccountRow[]): Promise<Map<string, number>> => {
    const viaRpc = await supabase.rpc('account_balances_for_user', { p_user_id: userId });
    if (!viaRpc.error) {
      const rows = (viaRpc.data ?? []) as { account_id: string; balance: number | string }[];
      return new Map(rows.map(row => [row.account_id, num(row.balance)]));
    }
    const missing = viaRpc.error.code === '42883' || /does not exist|not find the function/i.test(viaRpc.error.message);
    if (!missing) return fail('account balances', viaRpc.error);
    console.warn('[mcp] account_balances_for_user is not installed yet; summing by pages (apply migration 20261022090000)');

    const paged = await readAllPages<{ account_id: string; amount: number | string }>(async (from, to) => {
      const { data, error } = await supabase
        .from('transactions')
        .select('account_id, amount')
        .eq('user_id', userId)
        .order('id')
        .range(from, to);
      if (error) return fail('account balances', error);
      return (data ?? []) as { account_id: string; amount: number | string }[];
    }, 500_000);
    const pence = new Map<string, bigint>();
    for (const account of accounts) {
      pence.set(account.id, BigInt(Math.round(num(account.initial_balance) * 100)));
    }
    for (const row of paged.rows) {
      const value = BigInt(Math.round(num(row.amount) * 100));
      pence.set(row.account_id, (pence.get(row.account_id) ?? 0n) + value);
    }
    return new Map(Array.from(pence, ([id, total]) => [id, Number(total) / 100]));
  };

  return {
    async listAccounts() {
      const { data, error } = await supabase
        .from('accounts')
        .select('id, name, type, currency, is_active, institution, initial_balance, opening_balance_date, bank_balance, bank_balance_date, last_reconciled_date')
        .eq('user_id', userId)
        .order('name');
      if (error) return fail('accounts', error);
      const rows = (data ?? []) as AccountRow[];
      const balances = await accountBalances(rows);
      return rows.map(row => ({
        id: row.id,
        name: row.name,
        type: row.type,
        currency: row.currency ?? 'GBP',
        isActive: row.is_active !== false,
        institution: row.institution,
        // An account the balance function did not list has no rows: its
        // balance is its opening balance.
        balance: balances.get(row.id) ?? num(row.initial_balance),
        openingBalance: num(row.initial_balance),
        openingBalanceDate: row.opening_balance_date,
        bankBalance: row.bank_balance === null ? null : num(row.bank_balance),
        bankBalanceDate: row.bank_balance_date,
        lastReconciledDate: row.last_reconciled_date,
      }));
    },

    async searchTransactions(filter, page) {
      let query = supabase
        .from('transactions')
        .select<string, TransactionRow>(TRANSACTION_COLUMNS, { count: 'exact' })
        .eq('user_id', userId);
      if (!filter.includeArchived) query = query.or('archived.is.null,archived.eq.false');
      if (filter.accountId) query = query.eq('account_id', filter.accountId);
      if (filter.categoryId) query = query.eq('category', filter.categoryId);
      if (filter.from) query = query.gte('date', filter.from);
      if (filter.to) query = query.lte('date', filter.to);
      if (filter.minAmount !== undefined) query = query.gte('amount', filter.minAmount);
      if (filter.maxAmount !== undefined) query = query.lte('amount', filter.maxAmount);
      if (filter.cleared !== undefined) query = query.eq('is_cleared', filter.cleared);
      if (filter.text) {
        // PostgREST's pattern syntax: commas and parentheses would be read as
        // filter grammar, so they are matched as single characters instead.
        const needle = filter.text.replace(/[%_]/g, '\\$&').replace(/[,()]/g, '_');
        query = query.ilike('description', `%${needle}%`);
      }
      // "Awaiting review" is the app's own predicate: flagged, OR unfiled and
      // neither a transfer nor a split (utils/transactionReview).
      if (filter.review === 'awaiting') {
        query = query.or(AWAITING_REVIEW_FILTER);
      } else if (filter.review === 'done') {
        query = query
          .or('needs_review.is.null,needs_review.eq.false')
          .or("category.not.is.null,type.eq.transfer,is_split.eq.true")
          .neq('category', '');
      }
      const ascending = page.oldestFirst === true;
      const { data, error, count } = await query
        .order('date', { ascending })
        .order('id', { ascending })
        .range(page.offset, page.offset + page.limit - 1);
      if (error) return fail('transactions', error);
      return { rows: (data ?? []).map(toTransaction), total: count ?? 0 };
    },

    async getTransaction(id) {
      const { data, error } = await supabase
        .from('transactions')
        .select<string, TransactionRow>(TRANSACTION_COLUMNS)
        .eq('user_id', userId)
        .eq('id', id)
        .maybeSingle();
      if (error) return fail('the transaction', error);
      if (!data) return null;
      const transaction = toTransaction(data);
      let splits: TransactionSplit[] = [];
      if (transaction.isSplit) {
        const lines = await supabase
          .from('transaction_splits')
          .select('id, transaction_id, category, amount, memo, sort_order, transfer_account_id, linked_transfer_id')
          .eq('user_id', userId)
          .eq('transaction_id', id)
          .order('sort_order');
        if (lines.error) return fail('the transaction’s split lines', lines.error);
        splits = ((lines.data ?? []) as SplitRow[]).map(toSplit);
      }
      return { transaction, splits };
    },

    async listCategories() {
      const { data, error } = await supabase
        .from('categories')
        .select('id, name, type, level, parent_id, is_system, is_transfer_category, is_revaluation_category, is_unassigned_bucket, account_id, is_active')
        .eq('user_id', userId)
        .order('name');
      if (error) return fail('categories', error);
      return ((data ?? []) as CategoryRow[]).map(toCategory);
    },

    async listBudgets() {
      const { data, error } = await supabase
        .from('budgets')
        .select('id, name, amount, period, repeat_count, repeat_unit, category, category_id, start_date, end_date, is_active, rollover, rollover_amount, alert_threshold, notes, created_at, updated_at')
        .eq('user_id', userId)
        .order('name');
      if (error) return fail('budgets', error);
      return ((data ?? []) as BudgetRow[]).map(toBudget);
    },

    async transactionsBetween(from, to, cap, options = {}) {
      // Paged, because the transport clamps a select at 1,000 rows however
      // wide the range asked for (see paging.ts).
      const paged = await readAllPages<TransactionRow>(async (pageFrom, pageTo) => {
        let query = supabase
          .from('transactions')
          .select<string, TransactionRow>(TRANSACTION_COLUMNS)
          .eq('user_id', userId);
        if (!options.includeArchived) query = query.or('archived.is.null,archived.eq.false');
        const { data, error } = await query
          .gte('date', from)
          .lte('date', to)
          .order('date', { ascending: true })
          .order('id', { ascending: true })
          .range(pageFrom, pageTo);
        if (error) return fail('transactions', error);
        return data ?? [];
      }, cap);
      const rows = paged.rows.map(toTransaction);
      const capped = paged.capped;
      const parentIds = rows.filter(row => row.isSplit).map(row => row.id);
      let splits: TransactionSplit[] = [];
      if (parentIds.length > 0) {
        const lines = await supabase
          .from('transaction_splits')
          .select('id, transaction_id, category, amount, memo, sort_order, transfer_account_id, linked_transfer_id')
          .eq('user_id', userId)
          .in('transaction_id', parentIds)
          .order('sort_order');
        if (lines.error) return fail('split lines', lines.error);
        splits = ((lines.data ?? []) as SplitRow[]).map(toSplit);
      }
      return { rows, splits, capped };
    },

    async firstActivityDates() {
      const { data, error } = await supabase.rpc('account_first_activity_for_user', { p_user_id: userId });
      if (error) {
        const missing = error.code === '42883' || /does not exist|not find the function/i.test(error.message);
        if (!missing) return fail('first activity', error);
        console.warn('[mcp] account_first_activity_for_user is not installed yet; opening balances are undated (apply migration 20261022180000)');
        return null;
      }
      const rows = (data ?? []) as { account_id: string; first_date: string }[];
      return new Map(rows.map(row => [row.account_id, row.first_date]));
    },

    async reviewQueue(cap) {
      const paged = await readAllPages<TransactionRow>(async (pageFrom, pageTo) => {
        const { data, error } = await supabase
          .from('transactions')
          .select<string, TransactionRow>(TRANSACTION_COLUMNS)
          .eq('user_id', userId)
          .or('archived.is.null,archived.eq.false')
          .or(AWAITING_REVIEW_FILTER)
          .order('date', { ascending: true })
          .order('id', { ascending: true })
          .range(pageFrom, pageTo);
        if (error) return fail('the review queue', error);
        return data ?? [];
      }, cap);
      return { rows: paged.rows.map(toTransaction), capped: paged.capped };
    },

    async transactionsById(ids) {
      if (ids.length === 0) return [];
      const { data, error } = await supabase
        .from('transactions')
        .select<string, TransactionRow>(TRANSACTION_COLUMNS)
        .eq('user_id', userId)
        .in('id', ids);
      if (error) return fail('transactions', error);
      return (data ?? []).map(toTransaction);
    },

    async updateTransaction(id, patch) {
      // The verb replaces `metadata` whole, so the stamp is merged over what
      // the row holds now rather than written on its own.
      const current = await supabase
        .from('transactions')
        .select<string, Pick<TransactionRow, 'metadata'>>('metadata')
        .eq('user_id', userId)
        .eq('id', id)
        .maybeSingle();
      if (current.error) return fail('the transaction', current.error);
      if (!current.data) throw new PortRefusal('That transaction is not in this ledger. Nothing was changed.');
      const p: Record<string, unknown> = { metadata: stamp(current.data.metadata, provenance, now()) };
      if (patch.description !== undefined) p.description = patch.description;
      // A cleared note is NULL in the column, not an empty string: the verb
      // reads a JSON null as NULL, and the row then reads as having no note.
      if (patch.notes !== undefined) p.notes = patch.notes === '' ? null : patch.notes;
      if (patch.category !== undefined) p.category = patch.category;
      if (patch.categoryConfirmed !== undefined) p.category_confirmed = patch.categoryConfirmed;
      if (patch.needsReview !== undefined) p.needs_review = patch.needsReview;
      const { data, error } = await supabase.rpc('update_transaction_atomic', { p_id: id, p, p_user_id: userId });
      if (error) return refuseOrFail('the update', error);
      return rowFromVerb('the update', data);
    },

    async confirmCategories(ids) {
      const { data, error } = await supabase.rpc('confirm_transaction_categories', { p_ids: ids, p_user_id: userId });
      if (error) return refuseOrFail('the confirmation', error);
      return countFromVerb('the confirmation', data);
    },

    async setCleared(ids, cleared) {
      const { data, error } = await supabase.rpc('set_transactions_cleared', { p_ids: ids, p_cleared: cleared, p_user_id: userId });
      if (error) return refuseOrFail('the marking', error);
      return countFromVerb('the marking', data);
    },

    async linkTransfer(idA, idB) {
      const { data, error } = await supabase.rpc('link_transfer_pair', { p_id_a: idA, p_id_b: idB, p_user_id: userId });
      if (error) return refuseOrFail('the link', error);
      const pair = (data ?? {}) as { a?: unknown; b?: unknown };
      return { a: rowFromVerb('the link', pair.a), b: rowFromVerb('the link', pair.b) };
    },

    async createTransferCounterpart(id, targetAccountId) {
      const { data, error } = await supabase.rpc('create_transfer_counterpart', {
        p_id: id,
        p_target_account_id: targetAccountId,
        p_user_id: userId,
      });
      if (error) return refuseOrFail('the counterpart', error);
      const pair = (data ?? {}) as { source?: unknown; counterpart?: unknown };
      return { source: rowFromVerb('the counterpart', pair.source), counterpart: rowFromVerb('the counterpart', pair.counterpart) };
    },

    async createTransaction(input) {
      const p: Record<string, unknown> = {
        user_id: userId,
        account_id: input.accountId,
        description: input.description,
        amount: input.amount,
        type: input.type,
        date: input.date,
        category: input.category ?? null,
        notes: input.notes ?? null,
        category_confirmed: input.categoryConfirmed,
        metadata: stamp(null, provenance, now()),
      };
      const { data, error } = await supabase.rpc('create_transaction_atomic', { p });
      if (error) return refuseOrFail('the new transaction', error);
      const created = rowFromVerb('the new transaction', data);
      if (!input.needsReview) return created;
      // The create verb takes no review flag (a row from the Add form is the
      // person's own, so it never needed one); a suggested filing is put in
      // To Review by the same update the editor would make.
      const { data: flagged, error: flagError } = await supabase.rpc('update_transaction_atomic', {
        p_id: created.id,
        p: { needs_review: true },
        p_user_id: userId,
      });
      if (flagError) return refuseOrFail('the new transaction', flagError);
      return rowFromVerb('the new transaction', flagged);
    },
  };
}
