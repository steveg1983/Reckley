/**
 * The Reckley MCP server — the tools Claude is given over one person's ledger.
 *
 * Built fresh for every HTTP request by `createMcpHandler` (see route.ts), so
 * nothing here outlives a call: the port it reads through is scoped to the
 * caller, and the tools it registers are chosen by the scopes the caller's
 * token carries. A read-only token is never shown a write tool, not merely
 * refused one.
 *
 * ── WHAT A TOOL PROMISES ────────────────────────────────────────────────────
 * Every tool has a `title`, a description that says when to use it and when
 * to use a sibling instead, and the annotation Anthropic's review reads for
 * its auto-permission: `readOnlyHint` on every read, `destructiveHint` on
 * every write, so Claude asks before any of the writes. Money is a string with its
 * currency, dates are YYYY-MM-DD, lists are paginated with `limit`/`offset`
 * and capped by CHARACTER_LIMIT — fewer rows, never a cut row — with
 * `next_offset` pointing at the first row left out. Descriptions and notes
 * come from banks and files and are returned as data, nothing more.
 *
 * ── THE ARITHMETIC IS THE APP'S ─────────────────────────────────────────────
 * Spending by category goes through `computeIncomeExpense` — the function
 * the reports call — so a figure Claude quotes is the figure the screen
 * shows, and budgets through `evaluateBudgets` — the Budget page's and the
 * Dashboard card's one evaluation. See docs/mcp-connector.md.
 *
 * ── A FILING BY CLAUDE IS A SUGGESTION ──────────────────────────────────────
 * The owner's ruling (22 Oct 2026): a category Claude writes "stays a
 * suggestion and in 'to review'". So `reckley_set_category` without
 * `confirm` writes exactly what the app's own suggestion verb writes —
 * category_confirmed = false, needs_review = true — and the filing tools
 * take `confirm` for the one case the rule cannot see from here: the person
 * said, in the conversation, that this is right. Every write validates the
 * whole request before touching a row, so a refusal means nothing changed.
 *
 * ── NOTHING HERE IS A TYPESCRIPT ENUM OR A PARAMETER PROPERTY ──────────────
 * The API project compiles with `erasableSyntaxOnly`: the runtime is Node
 * stripping types, so the file may use only syntax that strips to nothing.
 */

import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Category, Transaction } from '../../../src/types/index.js';
import { computeIncomeExpense } from '../../../src/utils/incomeExpense.js';
import { evaluateBudgets } from '../../../src/utils/budgetEvaluation.js';
import { getBudgetPeriodWindow } from '../../../src/utils/budgetPeriods.js';
import { bucketByCategoryDirection } from '../../../src/utils/categoryNetting.js';
import { expandSplitTransactions } from '../../../src/utils/transactionSplits.js';
import { FALLBACK_BANK_DESCRIPTION, normalizePayee } from '../../../src/utils/payeeAutoCategorize.js';
import { isAwaitingReview, isUnfiled } from '../../../src/utils/transactionReview.js';
import { signTransactionAmount } from '../../../src/utils/transactionAmount.js';
import { toDecimal } from '../../../src/utils/decimal.js';
import { PortRefusal, type PortAccount, type ReckleyPort, type ReviewFilter, type TransactionPatch } from './port.js';
import { balancesAt, netWorthSeriesByCurrency, type SeriesAccount } from './netWorthSeries.js';

export const READ_SCOPE = 'reckley:read';
export const WRITE_SCOPE = 'reckley:write';

/** Which listing a request arrived through; the read listing never carries the write scope. */
export type Listing = 'read' | 'full';

/** The scopes each listing advertises and asks Claude to request. */
export const LISTING_SCOPES: Record<Listing, readonly string[]> = {
  read: [READ_SCOPE],
  full: [READ_SCOPE, WRITE_SCOPE],
};

export const SERVER_NAME = 'reckley-mcp-server';
export const SERVER_VERSION = '0.1.0';

/** A tool result longer than this is answered with fewer rows (never a cut row). */
export const CHARACTER_LIMIT = 25_000;

/** Rows an aggregate will read before it says the answer is partial. */
const AGGREGATE_ROW_CAP = 20_000;

/** 'YYYY-MM-DD' → local midnight, as the app's own series reads a day. */
const localDate = (day: string): Date => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** The day before, YYYY-MM-DD. */
const dayBefore = (day: string): string => {
  const date = localDate(day);
  date.setDate(date.getDate() - 1);
  return localDay(date);
};

/** A port account as the balance walk wants it. */
const toSeriesAccount = (account: PortAccount): SeriesAccount => ({
  id: account.id,
  name: account.name,
  currency: account.currency,
  openingBalance: account.openingBalance,
  openingBalanceDate: account.openingBalanceDate === null ? undefined : new Date(`${account.openingBalanceDate}T00:00:00.000Z`),
  balance: account.balance,
});

/** Rows the payee history will read before it says the answer is partial. */
const PAYEE_HISTORY_CAP = 2_000;

/** Rows the review queue will read before it says the count is partial. */
const REVIEW_QUEUE_CAP = 5_000;

/** Rows one write may name: enough for a sweep Claude has shown the person, small enough to read back. */
export const MAX_WRITE_IDS = 50;

/** The register's own payee identity: the description upper-cased and trimmed; the feed's placeholder is no payee at all. */
const payeeKey = (description: string): string | null => {
  const key = normalizePayee(description);
  return key === '' || key === FALLBACK_BANK_DESCRIPTION ? null : key;
};

/** A code-point order for strings a model reads; the app's locale comparer sits behind a browser-only seam. */
const byCodePoint = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

export interface ReckleyServerOptions {
  port: ReckleyPort;
  /** The scopes on the caller's token; decides which tools exist. */
  scopes: readonly string[];
  /** The evaluation instant, injectable so a spec can hold the calendar still. */
  now?: () => Date;
}

const ResponseFormat = {
  MARKDOWN: 'markdown',
  JSON: 'json',
} as const;

const responseFormat = z
  .enum([ResponseFormat.MARKDOWN, ResponseFormat.JSON])
  .default(ResponseFormat.MARKDOWN)
  .describe("'markdown' for readable text, 'json' for structured data");

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .describe('A calendar day, YYYY-MM-DD');

const idList = z
  .array(z.string().min(1))
  .min(1)
  .max(MAX_WRITE_IDS)
  .describe(`Transaction ids from reckley_search_transactions, up to ${MAX_WRITE_IDS}`);

const confirmFlag = z
  .boolean()
  .default(false)
  .describe('True only when the person has explicitly agreed to this in the conversation; otherwise the row is left for them to review in the app');

const dayOf = (date: Date | string): string =>
  (typeof date === 'string' ? new Date(date) : date).toISOString().slice(0, 10);

/**
 * A budget window's bounds are LOCAL midnights (utils/budgetPeriods), so they
 * are named by their local calendar parts — through toISOString, 1 October
 * at 00:00 BST would read as 30 September.
 */
const localDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** "-12.34 GBP": a signed magnitude and the currency code, nothing a locale could misread. */
export const money = (amount: number, currency: string): string => {
  const sign = amount < 0 ? '-' : '';
  return `${sign}${Math.abs(amount).toFixed(2)} ${currency}`;
};

/**
 * Stay under CHARACTER_LIMIT by halving the page until the rendered text
 * fits. `next_offset` then names the first row left out, and the JSON text
 * still matches `structuredContent` because both come from the same render.
 */
function fitPage<T, R extends { text: string }>(items: T[], render: (page: T[]) => R): R {
  let page = items;
  let result = render(page);
  while (page.length > 1 && result.text.length > CHARACTER_LIMIT) {
    page = page.slice(0, Math.ceil(page.length / 2));
    result = render(page);
  }
  return result;
}

interface Lookups {
  accounts: Map<string, PortAccount>;
  categories: Map<string, Category>;
}

/** "Bills (Household) > Telephone" — the path a category reads as on screen. */
function categoryPath(id: string | undefined, categories: Map<string, Category>): string | null {
  if (!id) return null;
  const parts: string[] = [];
  let current = categories.get(id);
  let guard = 0;
  while (current && guard++ < 6) {
    if (current.level !== 'type') parts.unshift(current.name);
    current = current.parentId ? categories.get(current.parentId) : undefined;
  }
  return parts.length > 0 ? parts.join(' > ') : (categories.get(id)?.name ?? null);
}

/** One row as the tools report it, in both formats. */
function describeRow(row: Transaction, lookups: Lookups) {
  const account = lookups.accounts.get(row.accountId);
  const currency = account?.currency ?? 'GBP';
  const category = lookups.categories.get(row.category);
  return {
    id: row.id,
    date: dayOf(row.date),
    account_id: row.accountId,
    account: account?.name ?? row.accountId,
    description: row.description,
    amount: money(row.amount, currency),
    type: row.type,
    category_id: row.category || null,
    category: row.type === 'transfer'
      ? `Transfer with ${lookups.accounts.get(row.transferAccountId ?? '')?.name ?? 'another account'}`
      : categoryPath(row.category, lookups.categories),
    category_is_suggested: row.type !== 'transfer' && row.isSplit !== true && !!row.category && row.categoryConfirmed === false,
    is_split: row.isSplit === true,
    awaiting_review: isAwaitingReview(row),
    cleared: row.cleared === true,
    notes: row.notes ?? null,
    // The other account of a transfer, from the row itself or from the To/From
    // category it is filed under; null for anything that is not a transfer.
    // (The evaluation's model read "Transfer with X" beside a null id and
    // called it inconsistent — it was.)
    transfer_account_id: row.transferAccountId ?? category?.accountId ?? null,
  };
}

type DescribedRow = ReturnType<typeof describeRow>;

function rowLine(row: DescribedRow): string {
  const flags = [
    row.awaiting_review ? 'awaiting review' : null,
    row.category_is_suggested ? 'category suggested' : null,
    row.cleared ? 'cleared' : null,
    row.is_split ? 'split' : null,
  ].filter((flag): flag is string => flag !== null);
  const filed = row.category ?? 'no category';
  return `- ${row.date} · ${row.account} · ${row.description} · ${row.amount} · ${filed}` +
    (flags.length > 0 ? ` · ${flags.join(', ')}` : '') +
    ` · id ${row.id}`;
}

/**
 * Build the server for one caller. Called once per request by the handler.
 */
export function createReckleyServer(options: ReckleyServerOptions): McpServer {
  const { port } = options;
  const now = options.now ?? (() => new Date());
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const lookups = async (): Promise<Lookups> => {
    const [accounts, categories] = await Promise.all([port.listAccounts(), port.listCategories()]);
    return {
      accounts: new Map(accounts.map(account => [account.id, account])),
      categories: new Map(categories.map(category => [category.id, category])),
    };
  };

  // ── Read tools: every listing ────────────────────────────────────────────

  server.registerTool(
    'reckley_list_accounts',
    {
      title: 'List accounts',
      description: `List the person's accounts with today's balance, or with the balance at the end of a past day.

Returns each account's id, name, kind (checking, savings, credit, cash, investment, loan, assets, other), currency, the balance the register shows (opening balance plus every transaction), and what the bank last reported where a feed or statement said. Closed accounts are left out unless include_closed is true.

With as_of (YYYY-MM-DD), every balance is what the register held at the end of that day — the same figures the net-worth series is built from — and a closed account that still held money then is listed too; the bank's figures are omitted, since they are today's.

Use this first to learn account ids for reckley_search_transactions.`,
      inputSchema: z.strictObject({
        include_closed: z.boolean().default(false).describe('Also list accounts that have been closed'),
        as_of: isoDay.optional().describe('Balances at the end of this past day instead of today'),
        response_format: responseFormat,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ include_closed, as_of, response_format }) => {
      const all = await port.listAccounts();
      if (as_of !== undefined) {
        const [firstActivity, range] = await Promise.all([
          port.firstActivityDates(),
          port.transactionsBetween(as_of, '9999-12-31', AGGREGATE_ROW_CAP, { includeArchived: true }),
        ]);
        if (range.capped) {
          return { content: [{ type: 'text', text: `More than ${AGGREGATE_ROW_CAP.toLocaleString('en-GB')} transactions fall after ${as_of}; ask for a later day.` }], isError: true };
        }
        const walk = balancesAt(
          {
            accounts: all.map(toSeriesAccount),
            firstActivity: firstActivity === null ? null : new Map(Array.from(firstActivity, ([id, day]) => [id, new Date(`${day}T00:00:00.000Z`).getTime()])),
            rows: range.rows.map(row => ({ accountId: row.accountId, date: row.date, amount: row.amount })),
          },
          localDate(as_of)
        );
        const then = all
          .map(account => ({ account, balance: walk.balances.get(account.id)?.toNumber() ?? account.openingBalance }))
          .filter(({ account, balance }) => include_closed || account.isActive || balance !== 0)
          .map(({ account, balance }) => ({
            id: account.id,
            name: account.name,
            type: account.type,
            currency: account.currency,
            balance: money(balance, account.currency),
            institution: account.institution,
            closed: !account.isActive,
          }));
        const body = { as_of, count: then.length, accounts: then };
        if (response_format === ResponseFormat.JSON) {
          return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
        }
        const lines = [`# Accounts at the end of ${as_of}`, ''];
        lines.push(...then.map(account => `- ${account.name} (${account.type}${account.closed ? ', closed' : ''}) · ${account.balance} · id ${account.id}`));
        if (then.length === 0) lines.push('No accounts held money on that day.');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      const accounts = all.filter(account => include_closed || account.isActive);
      const described = accounts.map(account => ({
        id: account.id,
        name: account.name,
        type: account.type,
        currency: account.currency,
        balance: money(account.balance, account.currency),
        bank_balance: account.bankBalance === null ? null : money(account.bankBalance, account.currency),
        bank_balance_date: account.bankBalanceDate,
        last_reconciled: account.lastReconciledDate,
        institution: account.institution,
        closed: !account.isActive,
      }));
      const page = { count: described.length, accounts: described };
      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: 'text', text: JSON.stringify(page, null, 2) }], structuredContent: page };
      }
      if (described.length === 0) {
        return { content: [{ type: 'text', text: 'No accounts yet.' }] };
      }
      const lines = ['# Accounts', ''];
      for (const account of described) {
        lines.push(
          `- ${account.name} (${account.type}${account.closed ? ', closed' : ''}) · ${account.balance}` +
            (account.bank_balance ? ` · bank says ${account.bank_balance} as of ${account.bank_balance_date ?? 'an unknown date'}` : '') +
            ` · id ${account.id}`
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'reckley_search_transactions',
    {
      title: 'Search transactions',
      description: `Search the person's transactions, newest first (or oldest first with sort='oldest'), one page at a time.

Filter by words in the description (text matches the description only, not the category, account or notes), account, category, a date range, an amount range (signed: spending is negative, so min_amount=-50 and max_amount=-10 finds spending between 10 and 50), whether the row is awaiting review, and whether it is cleared. Every bound is inclusive. Every filter is optional; with none, this lists recent transactions.

Each row carries its id, date, account, description, signed amount with currency, category (or "no category"), whether the category is only the app's suggestion, whether it is awaiting review, cleared, split, any note, and for a transfer the other account's id. A page may hold fewer rows than limit when the rows are long; has_more and next_offset always say whether and where to continue, and total is the number of matches in all.

Use reckley_get_transaction for one row's full detail, and reckley_spending_by_category for totals rather than rows.`,
      inputSchema: z.strictObject({
        text: z.string().max(200).optional().describe('Words to find in the description, any case'),
        account_id: z.string().optional().describe('Only this account (an id from reckley_list_accounts)'),
        category_id: z.string().optional().describe('Only rows filed under this category id (from reckley_list_categories)'),
        from: isoDay.optional().describe('Earliest date, inclusive, YYYY-MM-DD'),
        to: isoDay.optional().describe('Latest date, inclusive, YYYY-MM-DD'),
        min_amount: z.number().optional().describe('Lowest signed amount to include; spending is negative'),
        max_amount: z.number().optional().describe('Highest signed amount to include'),
        review: z.enum(['awaiting', 'done', 'any']).default('any')
          .describe("'awaiting' for rows still to be reviewed (flagged, or with no category), 'done' for the rest"),
        cleared: z.boolean().optional().describe('Only cleared rows (true) or only uncleared rows (false)'),
        include_archived: z.boolean().default(false).describe('Also search rows the person has archived'),
        sort: z.enum(['newest', 'oldest']).default('newest').describe("'oldest' to start from the earliest match — for 'the first time' questions"),
        limit: z.number().int().min(1).max(100).default(25).describe('Rows per page'),
        offset: z.number().int().min(0).default(0).describe('Rows to skip, for the next page'),
        response_format: responseFormat,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      if (args.from && args.to && args.from > args.to) {
        return { content: [{ type: 'text', text: `from (${args.from}) is after to (${args.to}); swap them.` }], isError: true };
      }
      const [{ rows, total }, look] = await Promise.all([
        port.searchTransactions(
          {
            text: args.text,
            accountId: args.account_id,
            categoryId: args.category_id,
            from: args.from,
            to: args.to,
            minAmount: args.min_amount,
            maxAmount: args.max_amount,
            review: args.review as ReviewFilter,
            cleared: args.cleared,
            includeArchived: args.include_archived,
          },
          { limit: args.limit, offset: args.offset, oldestFirst: args.sort === 'oldest' }
        ),
        lookups(),
      ]);
      const described = rows.map(row => describeRow(row, look));

      const render = (page: DescribedRow[]) => {
        const nextOffset = args.offset + page.length;
        const hasMore = total > nextOffset;
        const body = {
          total,
          count: page.length,
          offset: args.offset,
          transactions: page,
          has_more: hasMore,
          ...(hasMore ? { next_offset: nextOffset } : {}),
        };
        if (args.response_format === ResponseFormat.JSON) {
          return { body, text: JSON.stringify(body, null, 2) };
        }
        const lines = [`# Transactions`, `Showing ${page.length} of ${total}.`, ''];
        lines.push(...page.map(rowLine));
        if (hasMore) lines.push('', `More results: call again with offset=${nextOffset}.`);
        return { body, text: lines.join('\n') };
      };

      const result = fitPage(described, render);
      if (args.response_format === ResponseFormat.JSON) {
        return { content: [{ type: 'text', text: result.text }], structuredContent: result.body };
      }
      if (described.length === 0) {
        return { content: [{ type: 'text', text: 'No transactions match. Loosen a filter, or widen the dates.' }] };
      }
      return { content: [{ type: 'text', text: result.text }] };
    }
  );

  server.registerTool(
    'reckley_get_transaction',
    {
      title: 'Get a transaction',
      description: `One transaction in full, by id: every field reckley_search_transactions shows, plus its split lines (each with its own category and amount) and, for a transfer, the other account.`,
      inputSchema: z.strictObject({
        id: z.string().min(1).describe('The transaction id, from reckley_search_transactions'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const [detail, look] = await Promise.all([port.getTransaction(id), lookups()]);
      if (!detail) {
        return { content: [{ type: 'text', text: `No transaction has id ${id}. Find ids with reckley_search_transactions.` }], isError: true };
      }
      const currency = look.accounts.get(detail.transaction.accountId)?.currency ?? 'GBP';
      const body = {
        ...describeRow(detail.transaction, look),
        splits: detail.splits.map(line => ({
          id: line.id,
          category_id: line.category,
          category: categoryPath(line.category, look.categories),
          amount: money(line.amount, currency),
          memo: line.memo ?? null,
        })),
        linked_transfer_id: detail.transaction.linkedTransferId ?? null,
      };
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
    }
  );

  server.registerTool(
    'reckley_list_categories',
    {
      title: 'List categories',
      description: `The person's category tree: every category with its id, name, full path ("Bills (Household) > Telephone"), kind (income, expense, or both), level, and whether it is a transfer category that stands for an account. Use the ids to filter reckley_search_transactions or to name a category exactly.`,
      inputSchema: z.strictObject({
        include_inactive: z.boolean().default(false).describe('Also list categories that have been retired'),
        response_format: responseFormat,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ include_inactive, response_format }) => {
      const all = await port.listCategories();
      const byId = new Map(all.map(category => [category.id, category]));
      const categories = all
        .filter(category => include_inactive || category.isActive !== false)
        .map(category => ({
          id: category.id,
          name: category.name,
          path: categoryPath(category.id, byId) ?? category.name,
          kind: category.type,
          level: category.level,
          parent_id: category.parentId ?? null,
          transfer_account_id: category.isTransferCategory ? (category.accountId ?? null) : null,
          revaluation: category.isRevaluationCategory === true,
        }))
        // A code-point order: the list is read by a model, and the app's
        // locale-aware comparer lives behind a browser-only seam.
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const body = { count: categories.length, categories };
      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
      }
      const lines = ['# Categories', ''];
      lines.push(...categories.map(category =>
        `- ${category.path} (${category.kind}${category.transfer_account_id ? ', transfer' : ''}) · id ${category.id}`
      ));
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'reckley_spending_by_category',
    {
      title: 'Spending by category',
      description: `Total spending per category over a date range, biggest first, with income and the net for the same days.

Uses the same arithmetic as the app's reports: refunds filed to a category reduce its spend, transfers between the person's own accounts are not spending, and rows with no category are counted separately and reported as such.

Give from and to as YYYY-MM-DD, inclusive. For individual rows use reckley_search_transactions.`,
      inputSchema: z.strictObject({
        from: isoDay,
        to: isoDay,
        account_id: z.string().optional().describe('Only this account'),
        limit: z.number().int().min(1).max(200).default(30).describe('Categories to list'),
        response_format: responseFormat,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ from, to, account_id, limit, response_format }) => {
      if (from > to) {
        return { content: [{ type: 'text', text: `from (${from}) is after to (${to}); swap them.` }], isError: true };
      }
      const [range, look, categories] = await Promise.all([
        port.transactionsBetween(from, to, AGGREGATE_ROW_CAP),
        lookups(),
        port.listCategories(),
      ]);
      const rows = account_id ? range.rows.filter(row => row.accountId === account_id) : range.rows;
      const flows = computeIncomeExpense(rows, range.splits, categories);
      const currency = account_id
        ? (look.accounts.get(account_id)?.currency ?? 'GBP')
        : (look.accounts.values().next().value?.currency ?? 'GBP');

      const totals = new Map<string, ReturnType<typeof toDecimal>>();
      for (const row of flows.expenseRows) {
        totals.set(row.category, (totals.get(row.category) ?? toDecimal(0)).minus(toDecimal(row.amount)));
      }
      const listed = Array.from(totals, ([categoryId, spent]) => ({
        category_id: categoryId,
        category: categoryPath(categoryId, look.categories) ?? categoryId,
        spent,
      }))
        .filter(entry => !entry.spent.isZero())
        .sort((a, b) => b.spent.comparedTo(a.spent))
        .slice(0, limit);
      const expenses = flows.expenses;
      const body = {
        from,
        to,
        currency,
        income: money(flows.income.toNumber(), currency),
        expenses: money(expenses.toNumber(), currency),
        net: money(flows.income.minus(expenses).toNumber(), currency),
        uncategorised_rows: flows.uncategorizedRows.length,
        categories: listed.map(entry => ({
          category_id: entry.category_id,
          category: entry.category,
          spent: money(entry.spent.toNumber(), currency),
          share: expenses.isZero() ? 0 : Number(entry.spent.dividedBy(expenses).times(100).toFixed(1)),
        })),
        ...(range.capped ? { partial: `Only the first ${AGGREGATE_ROW_CAP} rows in the range were read; narrow the dates for exact totals.` } : {}),
      };
      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
      }
      const lines = [
        `# Spending ${from} to ${to}`,
        `Income ${body.income} · Spending ${body.expenses} · Net ${body.net}` +
          (body.uncategorised_rows > 0 ? ` · ${body.uncategorised_rows} rows with no category are not in these totals` : ''),
        '',
      ];
      lines.push(...body.categories.map(entry => `- ${entry.category}: ${entry.spent} (${entry.share}%)`));
      if (body.categories.length === 0) lines.push('No spending in this range.');
      if (body.partial) lines.push('', body.partial);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'reckley_income_vs_expenses',
    {
      title: 'Income vs expenses by month',
      description: `Income, spending and the net for each calendar month in a date range, plus the totals.

The same rule as the app's Income vs Expenses chart: a row counts by its category's direction, so a refund filed to a spending category reduces that month's spending; transfers between the person's own accounts and revaluations are not counted; rows with no category are left out of the totals and counted separately.

Give from and to as YYYY-MM-DD, inclusive. For the categories behind a month use reckley_spending_by_category; for the rows use reckley_search_transactions.`,
      inputSchema: z.strictObject({
        from: isoDay,
        to: isoDay,
        account_id: z.string().optional().describe('Only this account'),
        response_format: responseFormat,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ from, to, account_id, response_format }) => {
      if (from > to) {
        return { content: [{ type: 'text', text: `from (${from}) is after to (${to}); swap them.` }], isError: true };
      }
      const [range, look] = await Promise.all([
        port.transactionsBetween(from, to, AGGREGATE_ROW_CAP),
        lookups(),
      ]);
      const rows = expandSplitTransactions(
        account_id ? range.rows.filter(row => row.accountId === account_id) : range.rows,
        range.splits
      );
      const currency = account_id
        ? (look.accounts.get(account_id)?.currency ?? 'GBP')
        : (look.accounts.values().next().value?.currency ?? 'GBP');
      const byMonth = new Map<string, { income: ReturnType<typeof toDecimal>; expenses: ReturnType<typeof toDecimal> }>();
      let uncategorised = 0;
      for (const row of rows) {
        const bucket = bucketByCategoryDirection(row, look.categories);
        if (bucket === 'uncategorized') { uncategorised += 1; continue; }
        if (bucket !== 'income' && bucket !== 'expense') continue;
        const key = dayOf(row.date).slice(0, 7);
        const month = byMonth.get(key) ?? { income: toDecimal(0), expenses: toDecimal(0) };
        if (bucket === 'income') month.income = month.income.plus(toDecimal(row.amount));
        else month.expenses = month.expenses.minus(toDecimal(row.amount));
        byMonth.set(key, month);
      }
      const months = Array.from(byMonth.entries()).sort(([a], [b]) => byCodePoint(a, b)).map(([key, month]) => ({
        month: key,
        income: money(month.income.toNumber(), currency),
        expenses: money(month.expenses.toNumber(), currency),
        net: money(month.income.minus(month.expenses).toNumber(), currency),
      }));
      const totalIncome = Array.from(byMonth.values()).reduce((sum, m) => sum.plus(m.income), toDecimal(0));
      const totalExpenses = Array.from(byMonth.values()).reduce((sum, m) => sum.plus(m.expenses), toDecimal(0));
      const body = {
        from,
        to,
        currency,
        months,
        income: money(totalIncome.toNumber(), currency),
        expenses: money(totalExpenses.toNumber(), currency),
        net: money(totalIncome.minus(totalExpenses).toNumber(), currency),
        uncategorised_rows: uncategorised,
        ...(range.capped ? { partial: `Only the first ${AGGREGATE_ROW_CAP} rows in the range were read; narrow the dates for exact totals.` } : {}),
      };
      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
      }
      const lines = [
        `# Income vs expenses ${from} to ${to}`,
        `Income ${body.income} · Spending ${body.expenses} · Net ${body.net}` +
          (uncategorised > 0 ? ` · ${uncategorised} rows with no category are not in these totals` : ''),
        '',
      ];
      lines.push(...months.map(m => `- ${m.month}: income ${m.income}, spending ${m.expenses}, net ${m.net}`));
      if (months.length === 0) lines.push('Nothing in this range.');
      if (body.partial) lines.push('', body.partial);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'reckley_spending_by_payee',
    {
      title: 'Spending by payee',
      description: `Who the person paid over a date range, biggest first: each payee's net spend, how many rows, the first and last dates, and the category most of its rows carry.

A payee is the description as the bank wrote it, so "NORTHGATE MARKET" and "NORTHGATE MARKET REFUND" are two payees — the refund appears as a negative spend of its own, exactly as the app's Spending by Payee report shows it. Transfers and rows with no category are not spending and are left out. With category_id, only rows filed there are counted, so "who took the holiday money" is one call.

Give from and to as YYYY-MM-DD, inclusive.`,
      inputSchema: z.strictObject({
        from: isoDay,
        to: isoDay,
        account_id: z.string().optional().describe('Only this account'),
        category_id: z.string().optional().describe('Only rows filed under this category id (from reckley_list_categories)'),
        limit: z.number().int().min(1).max(200).default(30).describe('Payees to list'),
        response_format: responseFormat,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ from, to, account_id, category_id, limit, response_format }) => {
      if (from > to) {
        return { content: [{ type: 'text', text: `from (${from}) is after to (${to}); swap them.` }], isError: true };
      }
      const [range, look, categories] = await Promise.all([
        port.transactionsBetween(from, to, AGGREGATE_ROW_CAP),
        lookups(),
        port.listCategories(),
      ]);
      const rows = account_id ? range.rows.filter(row => row.accountId === account_id) : range.rows;
      const flows = computeIncomeExpense(rows, range.splits, categories);
      // Within one category the total is the sum of what is counted, so a
      // split line filed elsewhere does not swell it.
      const counted = category_id ? flows.expenseRows.filter(row => row.category === category_id) : flows.expenseRows;
      const currency = account_id
        ? (look.accounts.get(account_id)?.currency ?? 'GBP')
        : (look.accounts.values().next().value?.currency ?? 'GBP');
      interface PayeeGroup { name: string; spent: ReturnType<typeof toDecimal>; count: number; earliest: string; latest: string; categories: Map<string, number> }
      const groups = new Map<string, PayeeGroup>();
      for (const row of counted) {
        const key = payeeKey(row.description) ?? '(no payee)';
        const day = dayOf(row.date);
        const group = groups.get(key) ?? {
          name: key === '(no payee)' ? 'No payee recorded' : row.description.trim(),
          spent: toDecimal(0), count: 0, earliest: day, latest: day, categories: new Map(),
        };
        group.spent = group.spent.minus(toDecimal(row.amount));
        group.count += 1;
        if (day < group.earliest) group.earliest = day;
        if (day > group.latest) group.latest = day;
        if (row.category) group.categories.set(row.category, (group.categories.get(row.category) ?? 0) + 1);
        groups.set(key, group);
      }
      const total = category_id
        ? Array.from(groups.values()).reduce((sum, group) => sum.plus(group.spent), toDecimal(0))
        : flows.expenses;
      const listed = Array.from(groups.values())
        .sort((a, b) => b.spent.comparedTo(a.spent) || byCodePoint(a.name, b.name))
        .slice(0, limit)
        .map(group => {
          const top = Array.from(group.categories.entries()).sort((a, b) => b[1] - a[1])[0];
          return {
            payee: group.name,
            spent: money(group.spent.toNumber(), currency),
            rows: group.count,
            first: group.earliest,
            last: group.latest,
            share: total.isZero() ? 0 : Number(group.spent.dividedBy(total).times(100).toFixed(1)),
            usual_category: top ? categoryPath(top[0], look.categories) : null,
          };
        });
      const body = {
        from,
        to,
        currency,
        ...(category_id ? { category: categoryPath(category_id, look.categories) ?? category_id } : {}),
        expenses: money(total.toNumber(), currency),
        payees: listed,
        ...(range.capped ? { partial: `Only the first ${AGGREGATE_ROW_CAP} rows in the range were read; narrow the dates for exact totals.` } : {}),
      };
      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
      }
      const lines = [`# Spending by payee ${from} to ${to}`, `Spending ${body.expenses}`, ''];
      lines.push(...listed.map(p => `- ${p.payee}: ${p.spent} over ${p.rows} rows (${p.share}%)${p.usual_category ? `, usually ${p.usual_category}` : ''}`));
      if (listed.length === 0) lines.push('No spending in this range.');
      if (body.partial) lines.push('', body.partial);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'reckley_net_worth',
    {
      title: 'Net worth today',
      description: `What the person owns and owes today, from the register: assets are the accounts with a positive balance, liabilities the size of the negative ones, net worth the difference — the Dashboard's rule — reported per currency, since this tool converts nothing.

Ledger figures only: an investment account counts at the value its register carries, not at today's prices, and closed accounts are left out. For the balances behind these totals use reckley_list_accounts; for how it has changed, reckley_net_worth_series.`,
      inputSchema: z.strictObject({
        response_format: responseFormat,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ response_format }) => {
      const accounts = (await port.listAccounts()).filter(account => account.isActive);
      interface Side { assets: ReturnType<typeof toDecimal>; liabilities: ReturnType<typeof toDecimal>; counted: number }
      const byCurrency = new Map<string, Side>();
      for (const account of accounts) {
        const amount = toDecimal(account.balance);
        if (amount.isZero()) continue;
        const side = byCurrency.get(account.currency) ?? { assets: toDecimal(0), liabilities: toDecimal(0), counted: 0 };
        if (amount.isNegative()) side.liabilities = side.liabilities.plus(amount.abs());
        else side.assets = side.assets.plus(amount);
        side.counted += 1;
        byCurrency.set(account.currency, side);
      }
      const currencies = Array.from(byCurrency.entries()).sort(([a], [b]) => byCodePoint(a, b)).map(([currency, side]) => ({
        currency,
        assets: money(side.assets.toNumber(), currency),
        liabilities: money(side.liabilities.toNumber(), currency),
        net_worth: money(side.assets.minus(side.liabilities).toNumber(), currency),
        accounts_counted: side.counted,
      }));
      const body = { as_of: dayOf(new Date()), open_accounts: accounts.length, currencies };
      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
      }
      const lines = [`# Net worth as of ${body.as_of}`, ''];
      lines.push(...currencies.map(c => `- ${c.currency}: own ${c.assets}, owe ${c.liabilities}, net ${c.net_worth} (${c.accounts_counted} accounts)`));
      if (currencies.length === 0) lines.push('No open accounts with a balance.');
      lines.push('', 'Register figures: investments at their ledger value, no currency conversion, closed accounts excluded.');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'reckley_net_worth_series',
    {
      title: 'Net worth over time',
      description: `What the person was worth on each day or month-end across a period, from the register: the same points and the same figures as the app's Net Worth report, one line per currency. Daily points for a window of about three months or less, month-end points beyond that, always ending on the last day asked for.

Every account that has ever held money is counted, closed ones included, so a point in the past carries what was open then. An opening balance counts from the day the account opened, as the report dates it. Ledger figures only: investments at their register value, no currency conversion. Defaults to the twelve whole months ending today.

For today's figure alone use reckley_net_worth; for the balances behind a point use reckley_list_accounts.`,
      inputSchema: z.strictObject({
        from: isoDay.optional().describe('First day of the period; defaults to the first day of the month eleven months ago'),
        to: isoDay.optional().describe('Last day of the period; defaults to today'),
        response_format: responseFormat,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const today = now();
      const to = args.to ?? localDay(today);
      const from = args.from ?? localDay(new Date(today.getFullYear(), today.getMonth() - 11, 1));
      if (from > to) {
        return { content: [{ type: 'text', text: `from (${from}) is after to (${to}); swap them.` }], isError: true };
      }
      const [accounts, firstActivity, range] = await Promise.all([
        port.listAccounts(),
        port.firstActivityDates(),
        // Everything dated after the first day, however far ahead: the walk
        // starts from today's balances, which include every row there is.
        port.transactionsBetween(from, '9999-12-31', AGGREGATE_ROW_CAP, { includeArchived: true }),
      ]);
      if (range.capped) {
        return {
          content: [{ type: 'text', text: `More than ${AGGREGATE_ROW_CAP.toLocaleString('en-GB')} transactions fall after ${from}; ask for a later start.` }],
          isError: true,
        };
      }
      const activity = firstActivity === null
        ? null
        : new Map(Array.from(firstActivity, ([id, day]) => [id, new Date(`${day}T00:00:00.000Z`).getTime()]));
      const result = netWorthSeriesByCurrency({
        accounts: accounts.map(account => ({
          id: account.id,
          name: account.name,
          currency: account.currency,
          openingBalance: account.openingBalance,
          openingBalanceDate: account.openingBalanceDate === null ? undefined : new Date(`${account.openingBalanceDate}T00:00:00.000Z`),
          balance: account.balance,
        })),
        firstActivity: activity,
        rows: range.rows.map(row => ({ accountId: row.accountId, date: row.date, amount: row.amount })),
        from: localDate(from),
        to: localDate(to),
      });
      const notes = [
        'Register figures: investments at their ledger value, no currency conversion, closed accounts included for the days they held money.',
        ...(result.undatedOpenings > 0
          ? [`${result.undatedOpenings} ${result.undatedOpenings === 1 ? 'account has' : 'accounts have'} an opening balance with no date, counted from the start of the period.`]
          : []),
        ...(firstActivity === null ? ['Opening balances could not be dated by first activity on this ledger; explicit opening dates still apply.'] : []),
      ];
      const body = {
        from,
        to,
        cadence: result.monthly ? 'month-end' : 'daily',
        currencies: result.series.map(line => ({
          currency: line.currency,
          accounts_counted: line.accounts,
          points: line.points.map(point => ({
            date: localDay(point.date),
            assets: money(point.assets, line.currency),
            liabilities: money(point.liabilities, line.currency),
            net_worth: money(point.netWorth, line.currency),
          })),
        })),
        notes,
      };
      const json = JSON.stringify(body, null, 2);
      if (json.length > CHARACTER_LIMIT) {
        return { content: [{ type: 'text', text: `That period has too many points to return at once; ask for fewer years.` }], isError: true };
      }
      if (args.response_format === ResponseFormat.JSON) {
        return { content: [{ type: 'text', text: json }], structuredContent: body };
      }
      const lines = [`# Net worth ${from} to ${to} (${body.cadence} points)`, ''];
      if (body.currencies.length === 0) lines.push('No accounts.');
      for (const line of body.currencies) {
        lines.push(`## ${line.currency} (${line.accounts_counted} accounts)`, '');
        lines.push(...line.points.map(point => `- ${point.date}: net ${point.net_worth} (own ${point.assets}, owe ${point.liabilities})`));
        lines.push('');
      }
      lines.push(...notes);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'reckley_account_activity',
    {
      title: 'One account over a period',
      description: `What happened in one account between two dates: the balance at the start and the end, and the movement between them split into income, spending, transfers in and out (by the other account), revaluations, and money with no category.

Income and spending follow the app's own rule (a refund to a spending category nets spending down; revaluations are neither). Transfers are bookkeeping between the person's own accounts and are totalled by counterpart, so "how much went into the ISA this tax year" is one call with the ISA's id. Dates are YYYY-MM-DD, inclusive.`,
      inputSchema: z.strictObject({
        account_id: z.string().min(1).describe('The account, from reckley_list_accounts'),
        from: isoDay,
        to: isoDay,
        response_format: responseFormat,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account_id, from, to, response_format }) => {
      if (from > to) {
        return { content: [{ type: 'text', text: `from (${from}) is after to (${to}); swap them.` }], isError: true };
      }
      const [all, look, categories, firstActivity, inRange, after] = await Promise.all([
        port.listAccounts(),
        lookups(),
        port.listCategories(),
        port.firstActivityDates(),
        port.transactionsBetween(from, to, AGGREGATE_ROW_CAP),
        port.transactionsBetween(from, '9999-12-31', AGGREGATE_ROW_CAP, { includeArchived: true }),
      ]);
      const account = all.find(entry => entry.id === account_id);
      if (!account) {
        return { content: [{ type: 'text', text: `No account has id ${account_id}. Find ids with reckley_list_accounts.` }], isError: true };
      }
      const rows = inRange.rows.filter(row => row.accountId === account_id);
      const flows = computeIncomeExpense(rows, inRange.splits, categories);
      interface Counterpart { name: string; inward: ReturnType<typeof toDecimal>; outward: ReturnType<typeof toDecimal>; rows: number }
      const counterparts = new Map<string, Counterpart>();
      let transfersIn = toDecimal(0);
      let transfersOut = toDecimal(0);
      for (const row of rows) {
        if (row.type !== 'transfer') continue;
        const otherId = row.transferAccountId ?? look.categories.get(row.category)?.accountId ?? 'unknown';
        const entry = counterparts.get(otherId) ?? { name: look.accounts.get(otherId)?.name ?? 'another account', inward: toDecimal(0), outward: toDecimal(0), rows: 0 };
        const amount = toDecimal(row.amount);
        if (amount.isNegative()) { entry.outward = entry.outward.plus(amount.abs()); transfersOut = transfersOut.plus(amount.abs()); }
        else { entry.inward = entry.inward.plus(amount); transfersIn = transfersIn.plus(amount); }
        entry.rows += 1;
        counterparts.set(otherId, entry);
      }
      const walkInput = {
        accounts: all.map(toSeriesAccount),
        firstActivity: firstActivity === null ? null : new Map(Array.from(firstActivity, ([id, day]) => [id, new Date(`${day}T00:00:00.000Z`).getTime()])),
        rows: after.rows.map(row => ({ accountId: row.accountId, date: row.date, amount: row.amount })),
      };
      const opening = after.capped ? null : (balancesAt(walkInput, localDate(dayBefore(from))).balances.get(account_id)?.toNumber() ?? account.openingBalance);
      const closing = after.capped ? null : (balancesAt(walkInput, localDate(to)).balances.get(account_id)?.toNumber() ?? account.openingBalance);
      const currency = account.currency;
      const body = {
        account: account.name,
        account_id,
        currency,
        from,
        to,
        opening_balance: opening === null ? null : money(opening, currency),
        closing_balance: closing === null ? null : money(closing, currency),
        change: opening === null || closing === null ? null : money(closing - opening, currency),
        income: money(flows.income.toNumber(), currency),
        spending: money(flows.expenses.toNumber(), currency),
        revaluation: money(flows.revaluation.toNumber(), currency),
        uncategorised_in: money(flows.uncategorizedIn.toNumber(), currency),
        uncategorised_out: money(flows.uncategorizedOut.abs().toNumber(), currency),
        transfers_in: money(transfersIn.toNumber(), currency),
        transfers_out: money(transfersOut.toNumber(), currency),
        transfers: Array.from(counterparts.entries())
          .sort(([, a], [, b]) => b.inward.plus(b.outward).comparedTo(a.inward.plus(a.outward)) || byCodePoint(a.name, b.name))
          .map(([id, entry]) => ({ account_id: id, account: entry.name, in: money(entry.inward.toNumber(), currency), out: money(entry.outward.toNumber(), currency), rows: entry.rows })),
        rows_counted: rows.length,
        ...(inRange.capped || after.capped ? { partial: `More than ${AGGREGATE_ROW_CAP.toLocaleString('en-GB')} transactions were in play; narrow the dates for exact figures${after.capped ? ' (balances could not be walked)' : ''}.` } : {}),
      };
      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
      }
      const lines = [
        `# ${body.account} ${from} to ${to}`,
        `Balance ${body.opening_balance ?? 'unknown'} → ${body.closing_balance ?? 'unknown'}${body.change ? ` (${body.change})` : ''}`,
        '',
        `- Income ${body.income} · spending ${body.spending} · revaluation ${body.revaluation}`,
        `- Transfers in ${body.transfers_in} · out ${body.transfers_out}`,
        ...(flows.uncategorizedRows.length > 0 ? [`- No category: in ${body.uncategorised_in}, out ${body.uncategorised_out}`] : []),
      ];
      if (body.transfers.length > 0) {
        lines.push('', 'Transfers by counterpart:');
        lines.push(...body.transfers.map(t => `- ${t.account}: in ${t.in}, out ${t.out} over ${t.rows} rows · id ${t.account_id}`));
      }
      if (body.partial) lines.push('', body.partial);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'reckley_payee_history',
    {
      title: 'A payee over time',
      description: `Every payment to or from one payee in date order, collapsed into runs of the same amount — so a subscription's price steps, a termly fee's rises, or a salary's increases read as a short list: amount, how many times, first and last date.

text is matched against the description as the bank wrote it (any case); each distinct description that matches is its own payee. Optionally within one account or a date range (YYYY-MM-DD, inclusive). For the rows themselves use reckley_search_transactions.`,
      inputSchema: z.strictObject({
        text: z.string().min(1).max(200).describe('Words in the payee description, any case'),
        account_id: z.string().optional().describe('Only this account'),
        from: isoDay.optional(),
        to: isoDay.optional(),
        response_format: responseFormat,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ text, account_id, from, to, response_format }) => {
      if (from && to && from > to) {
        return { content: [{ type: 'text', text: `from (${from}) is after to (${to}); swap them.` }], isError: true };
      }
      const look = await lookups();
      const rows: Transaction[] = [];
      let offset = 0;
      let total = 0;
      do {
        const page = await port.searchTransactions({ text, accountId: account_id, from, to }, { limit: 100, offset, oldestFirst: true });
        rows.push(...page.rows);
        total = page.total;
        offset += page.rows.length;
        if (page.rows.length === 0) break;
      } while (offset < total && rows.length < PAYEE_HISTORY_CAP);
      interface Run { amount: number; count: number; first: string; last: string }
      interface History { payee: string; currency: string; rows: number; first: string; last: string; total: ReturnType<typeof toDecimal>; runs: Run[] }
      const byPayee = new Map<string, History>();
      for (const row of rows) {
        const key = payeeKey(row.description) ?? '(no payee)';
        const day = dayOf(row.date);
        const currency = look.accounts.get(row.accountId)?.currency ?? 'GBP';
        const history = byPayee.get(key) ?? { payee: row.description.trim(), currency, rows: 0, first: day, last: day, total: toDecimal(0), runs: [] };
        history.rows += 1;
        history.last = day;
        history.total = history.total.plus(toDecimal(row.amount));
        const current = history.runs[history.runs.length - 1];
        if (current && current.amount === row.amount) { current.count += 1; current.last = day; }
        else history.runs.push({ amount: row.amount, count: 1, first: day, last: day });
        byPayee.set(key, history);
      }
      const payees = Array.from(byPayee.values())
        .sort((a, b) => b.rows - a.rows || byCodePoint(a.payee, b.payee))
        .map(history => ({
          payee: history.payee,
          rows: history.rows,
          first: history.first,
          last: history.last,
          net: money(history.total.toNumber(), history.currency),
          runs: history.runs.map(run => ({ amount: money(run.amount, history.currency), times: run.count, first: run.first, last: run.last })),
        }));
      const body = {
        text,
        matched_rows: rows.length,
        payees,
        ...(rows.length < total ? { partial: `Only the first ${rows.length} of ${total} matching rows were read; narrow the dates.` } : {}),
      };
      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
      }
      if (payees.length === 0) {
        return { content: [{ type: 'text', text: `No transaction description contains "${text}".` }] };
      }
      const lines = [`# Payees matching "${text}"`, ''];
      for (const payee of payees) {
        lines.push(`## ${payee.payee} — ${payee.rows} rows, ${payee.first} to ${payee.last}, net ${payee.net}`);
        lines.push(...payee.runs.map(run => `- ${run.amount} × ${run.times}, ${run.first}${run.last !== run.first ? ` to ${run.last}` : ''}`));
        lines.push('');
      }
      if (body.partial) lines.push(body.partial);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'reckley_review_queue',
    {
      title: 'What is waiting for review',
      description: `The rows the app's To Review list holds, counted by account: how many, how many carry only the app's suggested category, how many have no category at all, and the oldest and newest dates. The same rule as the register: a row is awaiting review when it is flagged, or when it has no category and is neither a transfer nor a split.

Use reckley_search_transactions with review='awaiting' and an account_id for the rows themselves.`,
      inputSchema: z.strictObject({
        response_format: responseFormat,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ response_format }) => {
      const [queue, look] = await Promise.all([port.reviewQueue(REVIEW_QUEUE_CAP), lookups()]);
      interface Tally { count: number; suggested: number; unfiled: number; oldest: string; newest: string }
      const byAccount = new Map<string, Tally>();
      for (const row of queue.rows) {
        const day = dayOf(row.date);
        const tally = byAccount.get(row.accountId) ?? { count: 0, suggested: 0, unfiled: 0, oldest: day, newest: day };
        tally.count += 1;
        if (row.category && row.categoryConfirmed === false) tally.suggested += 1;
        if (isUnfiled(row)) tally.unfiled += 1;
        if (day < tally.oldest) tally.oldest = day;
        if (day > tally.newest) tally.newest = day;
        byAccount.set(row.accountId, tally);
      }
      const accounts = Array.from(byAccount.entries())
        .map(([accountId, tally]) => ({ account_id: accountId, account: look.accounts.get(accountId)?.name ?? accountId, ...tally }))
        .sort((a, b) => b.count - a.count || byCodePoint(a.account, b.account));
      const body = {
        total: queue.rows.length,
        accounts,
        ...(queue.capped ? { partial: `Only the first ${REVIEW_QUEUE_CAP} rows were counted.` } : {}),
      };
      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
      }
      if (accounts.length === 0) {
        return { content: [{ type: 'text', text: 'Nothing is waiting for review.' }] };
      }
      const lines = [`# To review: ${body.total} rows`, ''];
      lines.push(...accounts.map(a =>
        `- ${a.account}: ${a.count} rows (${a.suggested} with a suggested category, ${a.unfiled} with none), ${a.oldest} to ${a.newest} · account id ${a.account_id}`
      ));
      if (body.partial) lines.push('', body.partial);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'reckley_budget_status',
    {
      title: 'Budget status',
      description: `Every active budget measured over its own period — the cycle counted from the budget's own start date (a monthly budget from the 1st is the calendar month; a yearly one runs twelve months from its start), the week for a weekly one — exactly as the app's Budget page shows it: the allowance (with any rollover carried in), what has been spent, what is left or by how much it is over, and the days the period covers.`,
      inputSchema: z.strictObject({
        response_format: responseFormat,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ response_format }) => {
      const [budgets, categories, look] = await Promise.all([port.listBudgets(), port.listCategories(), lookups()]);
      const active = budgets.filter(budget => budget.isActive);
      if (active.length === 0) {
        const body = { count: 0, budgets: [] as never[] };
        return response_format === ResponseFormat.JSON
          ? { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body }
          : { content: [{ type: 'text', text: 'No active budgets.' }] };
      }
      // Budgets are measured over their own windows — since 5 Nov 2026 a
      // repeating budget runs its cycle from its OWN start, so a yearly one
      // can straddle two calendar years. The read covers the earliest start
      // to the latest end among them, nothing wider and nothing narrower.
      const today = now();
      const windows = active.map(budget => getBudgetPeriodWindow(budget, today));
      const earliest = windows.reduce((soFar, w) => (w.start < soFar ? w.start : soFar), windows[0].start);
      const latest = windows.reduce((soFar, w) => (w.end > soFar ? w.end : soFar), windows[0].end);
      const range = await port.transactionsBetween(localDay(earliest), localDay(latest), AGGREGATE_ROW_CAP);
      const currency = look.accounts.values().next().value?.currency ?? 'GBP';
      const evaluated = evaluateBudgets(active, {
        transactions: range.rows,
        transactionSplits: range.splits,
        categories,
        now: today,
      });
      const described = evaluated.map(entry => ({
        id: entry.budget.id,
        name: entry.budget.name || (categoryPath(entry.categoryId, look.categories) ?? entry.categoryId),
        category: categoryPath(entry.categoryId, look.categories),
        period: entry.window.label,
        from: localDay(entry.window.start),
        to: localDay(entry.window.end),
        allowance: money(entry.effectiveAmount.toNumber(), currency),
        spent: money(entry.spent.toNumber(), currency),
        remaining: money(entry.remaining.toNumber(), currency),
        percent_used: Number(entry.percentage.toFixed(1)),
        over_budget: entry.remaining.isNegative(),
      }));
      const body = { count: described.length, budgets: described };
      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
      }
      const lines = ['# Budgets', ''];
      lines.push(...described.map(entry =>
        `- ${entry.name}: ${entry.spent} of ${entry.allowance} (${entry.percent_used}%), ${entry.period} ${entry.from} to ${entry.to}` +
          (entry.over_budget ? ` · OVER by ${entry.remaining.replace('-', '')}` : ` · ${entry.remaining} left`) +
          ` · id ${entry.id}`
      ));
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );


  // ── Write tools: only a token carrying the write scope is shown them ─────
  if (options.scopes.includes(WRITE_SCOPE)) {
    registerWriteTools(server, port, lookups);
  }

  return server;
}

/** A write refused on the ledger's rules: a tool error, in the ledger's words, and nothing changed. */
const refusal = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true as const });

/** Run a write; a PortRefusal is an answer, anything else is a failure. */
async function attempt<R>(run: () => Promise<R>): Promise<R | ReturnType<typeof refusal>> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PortRefusal) return refusal(error.message);
    throw error;
  }
}

const rowIds = (rows: Transaction[]): string => rows.map(row => row.id).join(', ');

/**
 * The write tools. Each is one register verb; each validates the whole
 * request against the rows as they are NOW before touching any of them, so a
 * refusal means nothing was changed — the same stance as the row editor and
 * the sweep, which refuse a stale list rather than act on it.
 */
function registerWriteTools(server: McpServer, port: ReckleyPort, lookups: () => Promise<Lookups>): void {
  /** The named rows, every one of them; an unknown id refuses the call. */
  const rowsFor = async (ids: string[]): Promise<Transaction[]> => {
    const unique = [...new Set(ids)];
    const rows = await port.transactionsById(unique);
    const found = new Set(rows.map(row => row.id));
    const missing = unique.filter(id => !found.has(id));
    if (missing.length > 0) {
      throw new PortRefusal(`No transaction has id ${missing.join(', ')}. Nothing was changed; find ids with reckley_search_transactions.`);
    }
    // In the order they were asked for.
    const byId = new Map(rows.map(row => [row.id, row]));
    return unique.map(id => byId.get(id)!);
  };

  /** A transfer is filed by being one and a split files through its lines: neither takes a category. */
  const mustTakeCategory = (rows: Transaction[]): void => {
    const blocked = rows.filter(row => row.type === 'transfer' || row.isSplit === true);
    if (blocked.length > 0) {
      throw new PortRefusal(
        `${blocked.length === 1 ? 'One of these rows' : `${blocked.length} of these rows`} cannot take a category: a transfer is filed by being one and a split files through its lines (${rowIds(blocked)}). Nothing was changed.`
      );
    }
  };

  /** A category a row may be filed under, as the editor's own list offers them. */
  const categoryToFile = (id: string, look: Lookups): Category => {
    const category = look.categories.get(id);
    if (!category) throw new PortRefusal(`No category has id ${id}. Nothing was changed; find ids with reckley_list_categories.`);
    if (category.isTransferCategory) {
      throw new PortRefusal(`${category.name} is an account's To/From category: filing there makes a row a transfer, which is reckley_link_transfer or reckley_create_transfer_counterpart. Nothing was changed.`);
    }
    if (category.level === 'type') throw new PortRefusal(`${category.name} is a top-level group; file under one of the categories beneath it. Nothing was changed.`);
    if (category.isActive === false) throw new PortRefusal(`${category.name} has been retired; pick a category still in use. Nothing was changed.`);
    return category;
  };

  /** One update per row, in order; a refusal part-way says how far it got rather than "nothing". */
  const eachRow = async (rows: Transaction[], patch: TransactionPatch): Promise<Transaction[]> => {
    const after: Transaction[] = [];
    for (const row of rows) {
      try {
        after.push(await port.updateTransaction(row.id, patch));
      } catch (error) {
        if (error instanceof PortRefusal && after.length > 0) {
          throw new PortRefusal(`${after.length} of ${rows.length} were written (${rowIds(after)}) before the ledger refused: ${error.message}`);
        }
        throw error;
      }
    }
    return after;
  };

  const written = (headline: string, rows: Transaction[], look: Lookups) => {
    const described = rows.map(row => describeRow(row, look));
    const body = { changed: described.length, transactions: described };
    return {
      content: [{ type: 'text' as const, text: [headline, '', ...described.map(rowLine)].join('\n') }],
      structuredContent: body,
    };
  };

  server.registerTool(
    'reckley_set_category',
    {
      title: 'File transactions under a category',
      description: `File one or more transactions (up to ${MAX_WRITE_IDS}) under a category, by id.

By default the filing is a SUGGESTION: the category is written, marked as not yet confirmed, and the rows are put in To Review for the person to agree or change in the app — exactly what the app's own categoriser does. Pass confirm=true only when the person has explicitly agreed to this exact filing in the conversation; the category is then recorded as their choice and the rows leave review.

Refuses, changing nothing, if any id is unknown, any row is a transfer or a split (those take no category), or the category is a To/From transfer category, a top-level group, or retired. Writes a category only; moves no money.`,
      inputSchema: z.strictObject({
        transaction_ids: idList,
        category_id: z.string().min(1).describe('The category id, from reckley_list_categories'),
        confirm: confirmFlag,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ transaction_ids, category_id, confirm }) => attempt(async () => {
      const [rows, look] = await Promise.all([rowsFor(transaction_ids), lookups()]);
      mustTakeCategory(rows);
      const category = categoryToFile(category_id, look);
      const patch: TransactionPatch = confirm
        ? { category: category.id, categoryConfirmed: true, needsReview: false }
        : { category: category.id, categoryConfirmed: false, needsReview: true };
      const after = await eachRow(rows, patch);
      const path = categoryPath(category.id, look.categories) ?? category.name;
      return written(
        confirm
          ? `Filed ${after.length} under ${path} as the person's own choice; review ended.`
          : `Suggested ${path} for ${after.length}; left in To Review for the person to confirm in the app.`,
        after,
        look
      );
    })
  );

  server.registerTool(
    'reckley_confirm_categories',
    {
      title: 'Confirm suggested categories',
      description: `Record that the person agrees with the suggested category already on these transactions (up to ${MAX_WRITE_IDS}), by id. Use only when they have said so.

Flips each category from suggested to confirmed and ends the row's review. Writes no category and no amount: rows whose category is already confirmed, or blank, are left as they are and not counted. To change a category, use reckley_set_category.`,
      inputSchema: z.strictObject({ transaction_ids: idList }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ transaction_ids }) => attempt(async () => {
      const rows = await rowsFor(transaction_ids);
      const count = await port.confirmCategories(rows.map(row => row.id));
      const [after, look] = await Promise.all([rowsFor(rows.map(row => row.id)), lookups()]);
      return written(`Confirmed ${count} of ${rows.length}; the rest were already confirmed or had no category.`, after, look);
    })
  );

  server.registerTool(
    'reckley_update_transaction_text',
    {
      title: 'Edit a description or note',
      description: `Change the description and/or the note on one transaction, by id. Touches nothing else: not the amount, date, account, category, review state or cleared mark. An empty note clears it. The previous wording stays in the ledger's audit log.`,
      inputSchema: z.strictObject({
        transaction_id: z.string().min(1).describe('The transaction id'),
        description: z.string().trim().min(1).max(500).optional().describe('The new description'),
        notes: z.string().max(2000).optional().describe('The new note; an empty string clears it'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ transaction_id, description, notes }) => attempt(async () => {
      if (description === undefined && notes === undefined) {
        return refusal('Give a description, a note, or both. Nothing was changed.');
      }
      await rowsFor([transaction_id]);
      const patch: TransactionPatch = {};
      if (description !== undefined) patch.description = description;
      if (notes !== undefined) patch.notes = notes;
      const [after, look] = await Promise.all([port.updateTransaction(transaction_id, patch), lookups()]);
      return written('Updated.', [after], look);
    })
  );

  server.registerTool(
    'reckley_mark_reviewed',
    {
      title: 'Mark transactions reviewed',
      description: `End the review flag on transactions (up to ${MAX_WRITE_IDS}) the person has looked at and is happy with, by id. Use only when they have said so. Leaves category, confirmation and cleared state alone.

Refuses, changing nothing, if any row has no category: an unfiled row stays in To Review whatever its flag, so file it with reckley_set_category or make it a transfer first.`,
      inputSchema: z.strictObject({ transaction_ids: idList }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ transaction_ids }) => attempt(async () => {
      const [rows, look] = await Promise.all([rowsFor(transaction_ids), lookups()]);
      const unfiled = rows.filter(isUnfiled);
      if (unfiled.length > 0) {
        throw new PortRefusal(`${unfiled.length === 1 ? 'One of these rows has' : `${unfiled.length} of these rows have`} no category and would stay in To Review (${rowIds(unfiled)}). File them first. Nothing was changed.`);
      }
      const after = await eachRow(rows, { needsReview: false });
      return written(`Marked ${after.length} reviewed.`, after, look);
    })
  );

  server.registerTool(
    'reckley_mark_cleared',
    {
      title: 'Mark transactions cleared',
      description: `Tick transactions (up to ${MAX_WRITE_IDS}) off against a bank statement, or take the tick back, by id.

The mark is a working flag: it settles nothing by itself and never changes a balance. Marking a row that is filed (it has a category, or is a transfer) also ends its review, as the app does; unmarking says nothing about review. Rows already in the asked-for state are not rewritten and not counted.`,
      inputSchema: z.strictObject({
        transaction_ids: idList,
        cleared: z.boolean().describe('True to mark cleared, false to unmark'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ transaction_ids, cleared }) => attempt(async () => {
      const rows = await rowsFor(transaction_ids);
      const count = await port.setCleared(rows.map(row => row.id), cleared);
      const [after, look] = await Promise.all([rowsFor(rows.map(row => row.id)), lookups()]);
      return written(`${cleared ? 'Marked' : 'Unmarked'} ${count} of ${rows.length}; the rest were already ${cleared ? 'cleared' : 'uncleared'}.`, after, look);
    })
  );

  server.registerTool(
    'reckley_link_transfer',
    {
      title: 'Link two rows as a transfer',
      description: `Join two existing transactions in two different accounts as the two halves of one transfer between the person's own accounts. Bookkeeping only: no money moves anywhere. Both rows become transfers, each filed under the other account's To/From category, with their amounts untouched.

The ledger refuses, changing nothing, unless the amounts are exactly opposite (or, across currencies, opposite in sign), neither row is split or already linked, and the accounts differ. By default the rows keep their review flags for the person to confirm in the app; pass confirm=true only when they have agreed to this specific pairing, and review ends on both.`,
      inputSchema: z.strictObject({
        transaction_id: z.string().min(1).describe('One side'),
        counterpart_id: z.string().min(1).describe('The other side, in a different account'),
        confirm: confirmFlag,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ transaction_id, counterpart_id, confirm }) => attempt(async () => {
      const pair = await port.linkTransfer(transaction_id, counterpart_id);
      let rows = [pair.a, pair.b];
      if (confirm) rows = await eachRow(rows, { needsReview: false });
      const look = await lookups();
      return written(confirm ? 'Linked as a transfer; review ended on both sides.' : 'Linked as a transfer; both sides left for the person to review.', rows, look);
    })
  );

  server.registerTool(
    'reckley_create_transfer_counterpart',
    {
      title: 'Create the other side of a transfer',
      description: `Turn one existing transaction into a transfer by writing its other side into another of the person's accounts: a new row for the opposite amount on the same date, both rows linked and filed under each other's To/From category. Bookkeeping only: no money moves anywhere.

Use when the other account has no row for this movement. When it already has one, use reckley_link_transfer instead, or a duplicate will be created. The ledger refuses, changing nothing, for a zero amount, a split, a row already linked, the same account, or accounts in different currencies. By default the source row keeps its review flag; pass confirm=true only when the person has agreed to this, and its review ends.`,
      inputSchema: z.strictObject({
        transaction_id: z.string().min(1).describe('The existing row'),
        target_account_id: z.string().min(1).describe('The account the other side belongs in, from reckley_list_accounts'),
        confirm: confirmFlag,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ transaction_id, target_account_id, confirm }) => attempt(async () => {
      const made = await port.createTransferCounterpart(transaction_id, target_account_id);
      let source = made.source;
      if (confirm) [source] = await eachRow([source], { needsReview: false });
      const look = await lookups();
      return written(
        confirm ? 'Created the other side and linked the two; review ended.' : 'Created the other side and linked the two; the original left for the person to review.',
        [source, made.counterpart],
        look
      );
    })
  );

  server.registerTool(
    'reckley_add_transaction',
    {
      title: 'Add a transaction',
      description: `Record one manual transaction the person has described: money in or out of one of their accounts on a date, with a description and optionally a category and a note. Writes a row in the ledger; moves no money anywhere. NOT idempotent: calling twice records it twice.

Give the amount as a positive number; kind decides the sign ('expense' for money out, 'income' for money in). A transfer between the person's own accounts is not added here: record one side and use reckley_create_transfer_counterpart.

A category given without confirm=true is a suggestion and the row waits in To Review; with no category the row is unfiled and also waits. Pass confirm=true only when the person chose the category themselves. Refuses, changing nothing, for an unknown or closed account or an unusable category.`,
      inputSchema: z.strictObject({
        account_id: z.string().min(1).describe('The account, from reckley_list_accounts'),
        date: isoDay,
        description: z.string().trim().min(1).max(500).describe('Who was paid or who paid, as the person would write it'),
        amount: z.number().positive().describe('The amount as a positive number; kind gives the sign'),
        kind: z.enum(['income', 'expense']).describe("'expense' for money out, 'income' for money in"),
        category_id: z.string().min(1).optional().describe('A category id from reckley_list_categories; omit to leave the row unfiled'),
        notes: z.string().max(2000).optional().describe('A note on the row'),
        confirm: confirmFlag,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ account_id, date, description, amount, kind, category_id, notes, confirm }) => attempt(async () => {
      const look = await lookups();
      const account = look.accounts.get(account_id);
      if (!account) throw new PortRefusal(`No account has id ${account_id}. Nothing was changed; find ids with reckley_list_accounts.`);
      if (!account.isActive) throw new PortRefusal(`${account.name} is closed; reopen it in the app or pick another account. Nothing was changed.`);
      const category = category_id === undefined ? undefined : categoryToFile(category_id, look);
      const created = await port.createTransaction({
        accountId: account.id,
        date,
        description,
        amount: signTransactionAmount(amount, kind),
        type: kind,
        category: category?.id,
        notes,
        categoryConfirmed: category === undefined ? true : confirm,
        // An unfiled row is held in To Review by being unfiled; a suggested
        // one is flagged, as the app's own suggestion verb flags it.
        needsReview: category !== undefined && !confirm,
      });
      const headline = category === undefined
        ? 'Added, with no category; it waits in To Review.'
        : confirm
          ? `Added and filed under ${categoryPath(category.id, look.categories) ?? category.name}.`
          : `Added with ${categoryPath(category.id, look.categories) ?? category.name} suggested; it waits in To Review.`;
      return written(headline, [created], look);
    })
  );
}

/** The names the read listing registers, for the specs and the listing page. */
export const READ_TOOL_NAMES = [
  'reckley_list_accounts',
  'reckley_search_transactions',
  'reckley_get_transaction',
  'reckley_list_categories',
  'reckley_spending_by_category',
  'reckley_income_vs_expenses',
  'reckley_spending_by_payee',
  'reckley_net_worth',
  'reckley_net_worth_series',
  'reckley_account_activity',
  'reckley_payee_history',
  'reckley_review_queue',
  'reckley_budget_status',
] as const;

/** The names only the Complete Access listing registers, and only for a token with the write scope. */
export const WRITE_TOOL_NAMES = [
  'reckley_set_category',
  'reckley_confirm_categories',
  'reckley_update_transaction_text',
  'reckley_mark_reviewed',
  'reckley_mark_cleared',
  'reckley_link_transfer',
  'reckley_create_transfer_counterpart',
  'reckley_add_transaction',
] as const;
