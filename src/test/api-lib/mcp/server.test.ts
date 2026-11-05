/**
 * THE RECKLEY MCP SERVER, DRIVEN BY A REAL MCP CLIENT.
 *
 * No ports, no mocks of the protocol: `createMcpHandler` answers the client's
 * fetch in-process, so what these specs see is what Claude sees — the tool
 * list, the schemas, the wording, the pagination and the limits. The ledger
 * behind it is the in-memory port in fakePort.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { Transaction } from '../../../types';
import {
  CHARACTER_LIMIT,
  READ_SCOPE,
  READ_TOOL_NAMES,
  WRITE_SCOPE,
  WRITE_TOOL_NAMES,
  createReckleyServer,
} from '../../../../api/_lib/mcp/server';
import type { ReckleyPort } from '../../../../api/_lib/mcp/port';
import { accounts, fakePort, transactions } from './fakePort';

const NOW = new Date(2026, 9, 15, 12, 0, 0); // 15 October 2026

let handler: McpHttpHandler;
let client: Client;

async function connect(port: ReckleyPort = fakePort(), scopes: string[] = [READ_SCOPE]): Promise<Client> {
  handler = createMcpHandler(() => createReckleyServer({ port, scopes, now: () => NOW }));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/api/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  client = new Client({ name: 'spec-harness', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return client;
}

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: unknown };

const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

const textOf = (result: ToolResult): string => result.content.map(block => block.text ?? '').join('\n');

type Described = {
  id: string;
  account: string;
  description: string;
  amount: string;
  type: string;
  category: string | null;
  category_id: string | null;
  category_is_suggested: boolean;
  awaiting_review: boolean;
  cleared: boolean;
  notes: string | null;
};
type Written = { changed: number; transactions: Described[] };

/** Reconnect with a token that carries the write scope, over a fresh copy of the ledger. */
async function connectForWriting(port: ReckleyPort = fakePort()): Promise<void> {
  await client.close();
  await handler.close();
  await connect(port, [READ_SCOPE, WRITE_SCOPE]);
}

/** One row as the connector reads it back. */
const rowNow = async (id: string): Promise<Described> =>
  (await call('reckley_get_transaction', { id })).structuredContent as Described;

beforeEach(async () => {
  await connect();
});

afterEach(async () => {
  await client.close();
  await handler.close();
});

describe('the tool list', () => {
  it('is exactly the read tools, each titled and marked read-only', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual([...READ_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.name.length).toBeLessThanOrEqual(64);
    }
  });
});

describe('reckley_list_accounts', () => {
  it('lists open accounts with the register balance, and closed ones only when asked', async () => {
    const open = await call('reckley_list_accounts', { response_format: 'json' });
    const page = open.structuredContent as { count: number; accounts: { name: string; balance: string; closed: boolean }[] };
    expect(page.count).toBe(2);
    expect(page.accounts.map(account => account.name)).toEqual(['Current Account', 'Savings']);
    expect(page.accounts[0].balance).toBe('1234.56 GBP');
    // The JSON text is the same data.
    expect(JSON.parse(textOf(open))).toEqual(page);

    const all = await call('reckley_list_accounts', { include_closed: true, response_format: 'json' });
    expect((all.structuredContent as { count: number }).count).toBe(3);
  });

  it('reads as a list in markdown, with the bank’s figure where there is one', async () => {
    const text = textOf(await call('reckley_list_accounts'));
    expect(text).toContain('# Accounts');
    expect(text).toContain('Current Account (checking) · 1234.56 GBP · bank says 1230.00 GBP as of 2026-10-14');
    expect(text).not.toContain('Old Card');
  });
});

describe('reckley_search_transactions', () => {
  it('lists newest first with the total, in both formats', async () => {
    const json = await call('reckley_search_transactions', { response_format: 'json' });
    const page = json.structuredContent as { total: number; count: number; has_more: boolean; transactions: { id: string; date: string; amount: string; category: string | null }[] };
    expect(page.total).toBe(transactions.length);
    expect(page.has_more).toBe(false);
    expect(page.transactions[0]).toMatchObject({ id: 't8', date: '2026-10-10', amount: '-100.00 GBP' });
    expect(JSON.parse(textOf(json))).toEqual(page);

    const text = textOf(await call('reckley_search_transactions'));
    expect(text).toContain(`Showing ${transactions.length} of ${transactions.length}.`);
    expect(text).toContain('- 2026-10-03 · Current Account · Direct Debit - SKYLINE TELECOM · -30.00 GBP · Bills (Household) > Telephone · awaiting review, category suggested · id t2');
  });

  it('says which rows are awaiting review, and finds only those on request', async () => {
    const result = await call('reckley_search_transactions', { review: 'awaiting', response_format: 'json' });
    const page = result.structuredContent as { transactions: { id: string; awaiting_review: boolean }[] };
    // t2 is flagged; t6 has no category; a split parent and a transfer never count.
    expect(page.transactions.map(row => row.id).sort()).toEqual(['t2', 't6']);
    expect(page.transactions.every(row => row.awaiting_review)).toBe(true);
  });

  it('names a transfer by the account it moves money to', async () => {
    const result = await call('reckley_search_transactions', { text: 'transfer', response_format: 'json' });
    const page = result.structuredContent as { transactions: { id: string; category: string }[] };
    expect(page.transactions[0]).toMatchObject({ id: 't4', category: 'Transfer with Savings' });
  });

  it('paginates, and says where the next page starts', async () => {
    const first = await call('reckley_search_transactions', { limit: 3, response_format: 'json' });
    const page = first.structuredContent as { count: number; has_more: boolean; next_offset?: number };
    expect(page.count).toBe(3);
    expect(page.has_more).toBe(true);
    expect(page.next_offset).toBe(3);
    expect(textOf(await call('reckley_search_transactions', { limit: 3 }))).toContain('More results: call again with offset=3.');

    const last = await call('reckley_search_transactions', { limit: 3, offset: 6, response_format: 'json' });
    expect((last.structuredContent as { has_more: boolean }).has_more).toBe(false);
  });

  it('filters by amount range the signed way, and by dates', async () => {
    const spending = await call('reckley_search_transactions', { min_amount: -50, max_amount: -10, response_format: 'json' });
    const ids = (spending.structuredContent as { transactions: { id: string }[] }).transactions.map(row => row.id).sort();
    expect(ids).toEqual(['t1', 't2', 't6']);

    const october = await call('reckley_search_transactions', { from: '2026-10-01', to: '2026-10-31', text: 'northgate', response_format: 'json' });
    expect((october.structuredContent as { transactions: { id: string }[] }).transactions.map(row => row.id).sort()).toEqual(['t1', 't5']);
  });

  it('refuses a backwards date range, and an impossible page size, in words', async () => {
    const backwards = await call('reckley_search_transactions', { from: '2026-10-31', to: '2026-10-01' });
    expect(backwards.isError).toBe(true);
    expect(textOf(backwards)).toContain('swap them');

    const zero = await call('reckley_search_transactions', { limit: 0 });
    expect(zero.isError).toBe(true);
  });

  it('says so when nothing matches', async () => {
    expect(textOf(await call('reckley_search_transactions', { text: 'nothing like this' }))).toContain('No transactions match');
  });

  it('answers a long page with fewer rows, never a cut row', async () => {
    await client.close();
    await handler.close();
    const many: Transaction[] = Array.from({ length: 400 }, (_, i) => ({
      ...transactions[0],
      id: `big-${i}`,
      description: `A deliberately long description to fill the page ${'x'.repeat(120)} ${i}`,
    }));
    await connect(fakePort({ transactions: many }));

    const result = await call('reckley_search_transactions', { limit: 100, response_format: 'json' });
    const page = result.structuredContent as { count: number; total: number; has_more: boolean; next_offset?: number };
    expect(textOf(result).length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(page.count).toBeLessThan(100);
    expect(page.has_more).toBe(true);
    expect(page.next_offset).toBe(page.count);
    expect(page.total).toBe(400);
  });
});

describe('reckley_get_transaction', () => {
  it('returns the row with its split lines, each named by its own category', async () => {
    const result = await call('reckley_get_transaction', { id: 't8' });
    const body = result.structuredContent as { id: string; is_split: boolean; notes: string; splits: { category: string; amount: string }[] };
    expect(body).toMatchObject({ id: 't8', is_split: true, notes: 'split at the till' });
    expect(body.splits).toEqual([
      { id: 's1', category_id: 'det-groceries', category: 'Food > Groceries', amount: '-70.00 GBP', memo: null },
      { id: 's2', category_id: 'det-fuel', category: 'Fuel', amount: '-30.00 GBP', memo: null },
    ]);
  });

  it('says when no row has that id', async () => {
    const result = await call('reckley_get_transaction', { id: 'nope' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No transaction has id nope');
  });
});

describe('reckley_list_categories', () => {
  it('gives every live category its path, and leaves retired ones out unless asked', async () => {
    const result = await call('reckley_list_categories', { response_format: 'json' });
    const body = result.structuredContent as { categories: { id: string; path: string; transfer_account_id: string | null }[] };
    const phone = body.categories.find(category => category.id === 'det-phone');
    expect(phone?.path).toBe('Bills (Household) > Telephone');
    expect(body.categories.find(category => category.id === 'tofrom-savings')?.transfer_account_id).toBe('acc-savings');
    expect(body.categories.some(category => category.id === 'det-retired')).toBe(false);

    const all = await call('reckley_list_categories', { include_inactive: true, response_format: 'json' });
    expect((all.structuredContent as { categories: { id: string }[] }).categories.some(category => category.id === 'det-retired')).toBe(true);
  });
});

describe('reckley_spending_by_category', () => {
  it('totals October the way the app’s reports do: refunds net, transfers out, blanks counted apart', async () => {
    const result = await call('reckley_spending_by_category', { from: '2026-10-01', to: '2026-10-31', response_format: 'json' });
    const body = result.structuredContent as {
      income: string; expenses: string; net: string; uncategorised_rows: number;
      categories: { category: string; spent: string; share: number }[];
    };
    // Groceries: 45 shop + 70 split line − 12.50 refund = 102.50. September's 60 is outside.
    expect(body.categories[0]).toMatchObject({ category: 'Food > Groceries', spent: '102.50 GBP' });
    expect(body.categories.map(entry => entry.category)).toEqual(['Food > Groceries', 'Bills (Household) > Telephone', 'Fuel']);
    expect(body.expenses).toBe('162.50 GBP');
    expect(body.income).toBe('2000.00 GBP');
    expect(body.net).toBe('1837.50 GBP');
    // The £20 cash row has no category and is not in any total; the £500 transfer is nowhere.
    expect(body.uncategorised_rows).toBe(1);
    expect(body.categories.reduce((sum, entry) => sum + entry.share, 0)).toBeCloseTo(100, 0);
  });

  it('reads as a list, with the uncategorised count said beside the totals', async () => {
    const text = textOf(await call('reckley_spending_by_category', { from: '2026-10-01', to: '2026-10-31' }));
    expect(text).toContain('Income 2000.00 GBP · Spending 162.50 GBP · Net 1837.50 GBP · 1 rows with no category are not in these totals');
    expect(text).toContain('- Food > Groceries: 102.50 GBP (63.1%)');
  });

  it('refuses a backwards range', async () => {
    const result = await call('reckley_spending_by_category', { from: '2026-10-31', to: '2026-10-01' });
    expect(result.isError).toBe(true);
  });
});

describe('reckley_income_vs_expenses', () => {
  it('buckets by calendar month with the chart’s own rule, and totals the range', async () => {
    const result = await call('reckley_income_vs_expenses', { from: '2026-09-01', to: '2026-10-31', response_format: 'json' });
    const body = result.structuredContent as {
      months: { month: string; income: string; expenses: string; net: string }[];
      income: string; expenses: string; net: string; uncategorised_rows: number;
    };
    expect(body.months).toEqual([
      { month: '2026-09', income: '0.00 GBP', expenses: '60.00 GBP', net: '-60.00 GBP' },
      // October: 45 + 30 + 70 + 30 spent, 12.50 refunded; the transfer and the cash row are not counted.
      { month: '2026-10', income: '2000.00 GBP', expenses: '162.50 GBP', net: '1837.50 GBP' },
    ]);
    expect(body.expenses).toBe('222.50 GBP');
    expect(body.net).toBe('1777.50 GBP');
    expect(body.uncategorised_rows).toBe(1);
  });

  it('reads as one line per month', async () => {
    const text = textOf(await call('reckley_income_vs_expenses', { from: '2026-10-01', to: '2026-10-31' }));
    expect(text).toContain('- 2026-10: income 2000.00 GBP, spending 162.50 GBP, net 1837.50 GBP');
  });
});

describe('reckley_spending_by_payee', () => {
  it('names each payee as the bank wrote it, biggest first, with the refund as its own negative line', async () => {
    const result = await call('reckley_spending_by_payee', { from: '2026-10-01', to: '2026-10-31', response_format: 'json' });
    const body = result.structuredContent as { expenses: string; payees: { payee: string; spent: string; rows: number; share: number; usual_category: string | null }[] };
    expect(body.expenses).toBe('162.50 GBP');
    expect(body.payees.map(p => [p.payee, p.spent, p.rows])).toEqual([
      ['BIG SHOP', '100.00 GBP', 2],
      ['NORTHGATE MARKET', '45.00 GBP', 1],
      ['Direct Debit - SKYLINE TELECOM', '30.00 GBP', 1],
      ['NORTHGATE MARKET REFUND', '-12.50 GBP', 1],
    ]);
    expect(body.payees[0].usual_category).toBe('Food > Groceries');
    expect(body.payees[0].share).toBeCloseTo(61.5, 1);
  });

  it('honours the limit and reads as a list', async () => {
    const text = textOf(await call('reckley_spending_by_payee', { from: '2026-10-01', to: '2026-10-31', limit: 2 }));
    expect(text).toContain('- BIG SHOP: 100.00 GBP over 2 rows (61.5%), usually Food > Groceries');
    expect(text).not.toContain('SKYLINE');
  });
});

describe('reckley_net_worth', () => {
  it('sums positive balances as assets and negative ones as liabilities, per currency, open accounts only', async () => {
    await client.close();
    await handler.close();
    await connect(fakePort({
      accounts: [
        ...accounts,
        { id: 'acc-card', name: 'Credit Card', type: 'credit', currency: 'GBP', isActive: true, institution: null, balance: -500, bankBalance: null, bankBalanceDate: null, lastReconciledDate: null },
        { id: 'acc-eur', name: 'Euro Account', type: 'checking', currency: 'EUR', isActive: true, institution: null, balance: 250, bankBalance: null, bankBalanceDate: null, lastReconciledDate: null },
        { id: 'acc-zero', name: 'Empty', type: 'cash', currency: 'GBP', isActive: true, institution: null, balance: 0, bankBalance: null, bankBalanceDate: null, lastReconciledDate: null },
      ],
    }));

    const result = await call('reckley_net_worth', { response_format: 'json' });
    const body = result.structuredContent as { open_accounts: number; currencies: Record<string, unknown>[] };
    // The closed Old Card is not counted; the zero-balance account is neither side.
    expect(body.open_accounts).toBe(5);
    expect(body.currencies).toEqual([
      { currency: 'EUR', assets: '250.00 EUR', liabilities: '0.00 EUR', net_worth: '250.00 EUR', accounts_counted: 1 },
      { currency: 'GBP', assets: '6234.56 GBP', liabilities: '500.00 GBP', net_worth: '5734.56 GBP', accounts_counted: 3 },
    ]);
  });

  it('says what the figures are and are not', async () => {
    const text = textOf(await call('reckley_net_worth'));
    expect(text).toContain('- GBP: own 6234.56 GBP, owe 0.00 GBP, net 6234.56 GBP (2 accounts)');
    expect(text).toContain('investments at their ledger value, no currency conversion, closed accounts excluded');
  });
});

describe('reckley_review_queue', () => {
  it('counts the To Review rows by account, the suggested and the unfiled apart', async () => {
    const result = await call('reckley_review_queue', { response_format: 'json' });
    const body = result.structuredContent as { total: number; accounts: Record<string, unknown>[] };
    expect(body.total).toBe(2);
    expect(body.accounts).toEqual([
      { account_id: 'acc-current', account: 'Current Account', count: 2, suggested: 1, unfiled: 1, oldest: '2026-10-03', newest: '2026-10-09' },
    ]);
  });

  it('says so when nothing is waiting', async () => {
    await client.close();
    await handler.close();
    await connect(fakePort({ transactions: [transactions[0]] }));
    expect(textOf(await call('reckley_review_queue'))).toBe('Nothing is waiting for review.');
  });
});

describe('reckley_budget_status', () => {
  it('measures each active budget over its own period, as the Budget page does', async () => {
    const result = await call('reckley_budget_status', { response_format: 'json' });
    const body = result.structuredContent as { count: number; budgets: Record<string, unknown>[] };
    expect(body.count).toBe(1);
    expect(body.budgets[0]).toMatchObject({
      id: 'b-groceries',
      name: 'Groceries',
      period: 'Monthly',
      from: '2026-10-01',
      to: '2026-10-31',
      allowance: '150.00 GBP',
      // 45 + 70 (split line) − 12.50 refund; September's 60 is another month.
      spent: '102.50 GBP',
      remaining: '47.50 GBP',
      over_budget: false,
    });
  });

  it('leaves out a budget past its end date — the fixture’s June one-off is active, and over', async () => {
    const result = await call('reckley_budget_status', { response_format: 'json' });
    const body = result.structuredContent as { count: number; budgets: { id: string }[] };
    expect(body.budgets.map(entry => entry.id)).toEqual(['b-groceries']);
  });

  it('says so when there are none', async () => {
    await client.close();
    await handler.close();
    await connect(fakePort({ budgets: [] }));
    expect(textOf(await call('reckley_budget_status'))).toBe('No active budgets.');
  });

  it('says so, differently, when the active budgets have all finished or not started', async () => {
    await client.close();
    await handler.close();
    await connect(fakePort({
      budgets: [
        { id: 'b-done', name: 'June trip', categoryId: 'det-fuel', amount: 40, period: 'custom', isActive: true, startDate: '2026-06-01', endDate: '2026-06-30', createdAt: new Date(2026, 5, 1), updatedAt: new Date(2026, 5, 1), spent: 0 },
        { id: 'b-soon', name: 'Next year', categoryId: 'det-groceries', amount: 1200, period: 'yearly', isActive: true, startDate: '2027-01-01', createdAt: new Date(2026, 9, 1), updatedAt: new Date(2026, 9, 1), spent: 0 },
      ],
    }));
    expect(textOf(await call('reckley_budget_status'))).toBe(
      'No budgets running today: the active ones have finished or have not started yet.'
    );
  });
});

describe('what the evaluation asked for (22 Oct 2026)', () => {
  it('search can run oldest first, for "the first time" questions', async () => {
    const result = await call('reckley_search_transactions', { sort: 'oldest', limit: 2, response_format: 'json' });
    const page = result.structuredContent as { transactions: { id: string; date: string }[]; total: number };
    expect(page.transactions.map(row => row.date)).toEqual(['2026-09-28', '2026-10-01']);
    expect(page.total).toBe(8);
  });

  it('a transfer row names the other account whatever category it carries', async () => {
    await client.close();
    await handler.close();
    const filedUnderTransferRoot: Transaction = { ...transactions[3], id: 't4-root', category: 'type-transfer' };
    await connect(fakePort({ transactions: [...transactions, filedUnderTransferRoot] }));
    const byCategory = (await call('reckley_get_transaction', { id: 't4' })).structuredContent as { transfer_account_id: string | null };
    const byRow = (await call('reckley_get_transaction', { id: 't4-root' })).structuredContent as { transfer_account_id: string | null };
    const plain = (await call('reckley_get_transaction', { id: 't1' })).structuredContent as { transfer_account_id: string | null };
    expect(byCategory.transfer_account_id).toBe('acc-savings');
    expect(byRow.transfer_account_id).toBe('acc-savings');
    expect(plain.transfer_account_id).toBeNull();
  });

  it('spending by payee can be held to one category, with the total to match', async () => {
    const result = await call('reckley_spending_by_payee', { from: '2026-10-01', to: '2026-10-31', category_id: 'det-phone', response_format: 'json' });
    const body = result.structuredContent as { category: string; expenses: string; payees: { payee: string; spent: string }[] };
    expect(body.category).toBe('Bills (Household) > Telephone');
    expect(body.payees).toEqual([{ payee: 'Direct Debit - SKYLINE TELECOM', spent: '30.00 GBP', rows: 1, first: '2026-10-03', last: '2026-10-03', share: 100, usual_category: 'Bills (Household) > Telephone' }]);
    expect(body.expenses).toBe('30.00 GBP');
  });
});

describe('the three the evaluation asked for and deferred', () => {
  it('list_accounts with as_of gives each balance at the end of that day, closed accounts with money included', async () => {
    const result = await call('reckley_list_accounts', { as_of: '2026-10-05', response_format: 'json' });
    const body = result.structuredContent as { as_of: string; count: number; accounts: { name: string; balance: string; closed: boolean }[] };
    expect(body.as_of).toBe('2026-10-05');
    // −22.94 opening (1 Jan) − 60 − 45 − 30 + 2000 = 1842.06; the closed card held nothing.
    expect(body.accounts.map(a => [a.name, a.balance])).toEqual([['Current Account', '1842.06 GBP'], ['Savings', '5000.00 GBP']]);
    const before = await call('reckley_list_accounts', { as_of: '2025-12-31', response_format: 'json' });
    expect((before.structuredContent as { accounts: { name: string; balance: string }[] }).accounts.map(a => a.balance)).toEqual(['0.00 GBP', '5000.00 GBP']);
  });

  it('account_activity splits a month into income, spending, transfers by counterpart and the balances either side', async () => {
    const result = await call('reckley_account_activity', { account_id: 'acc-current', from: '2026-10-01', to: '2026-10-31', response_format: 'json' });
    const body = result.structuredContent as Record<string, unknown> & { transfers: { account: string; in: string; out: string; rows: number }[] };
    expect(body).toMatchObject({
      account: 'Current Account',
      opening_balance: '-82.94 GBP',
      closing_balance: '1234.56 GBP',
      change: '1317.50 GBP',
      income: '2000.00 GBP',
      // 45 + 30 + 70 + 30 − 12.50 refund
      spending: '162.50 GBP',
      uncategorised_out: '20.00 GBP',
      transfers_in: '0.00 GBP',
      transfers_out: '500.00 GBP',
      rows_counted: 7,
    });
    expect(body.transfers).toEqual([{ account_id: 'acc-savings', account: 'Savings', in: '0.00 GBP', out: '500.00 GBP', rows: 1 }]);
    const unknown = await call('reckley_account_activity', { account_id: 'nope', from: '2026-10-01', to: '2026-10-31' });
    expect(unknown.isError).toBe(true);
  });

  it('payee_history collapses a payee into runs of the same amount, oldest first, one payee per distinct description', async () => {
    const result = await call('reckley_payee_history', { text: 'northgate', response_format: 'json' });
    const body = result.structuredContent as { matched_rows: number; payees: { payee: string; rows: number; runs: { amount: string; times: number; first: string; last: string }[] }[] };
    expect(body.matched_rows).toBe(3);
    expect(body.payees.map(p => p.payee)).toEqual(['NORTHGATE MARKET', 'NORTHGATE MARKET REFUND']);
    expect(body.payees[0].runs).toEqual([
      { amount: '-60.00 GBP', times: 1, first: '2026-09-28', last: '2026-09-28' },
      { amount: '-45.00 GBP', times: 1, first: '2026-10-01', last: '2026-10-01' },
    ]);
    const text = textOf(await call('reckley_payee_history', { text: 'northgate' }));
    expect(text).toMatch(/## NORTHGATE MARKET — 2 rows, 2026-09-28 to 2026-10-01, net -105\.00 GBP/);
    expect(textOf(await call('reckley_payee_history', { text: 'zzz' }))).toMatch(/No transaction description contains "zzz"/);
  });
});

describe('reckley_net_worth_series', () => {
  it('defaults to the twelve whole months to today, month-end points, one line per currency, from the register', async () => {
    const result = await call('reckley_net_worth_series', { response_format: 'json' });
    const body = result.structuredContent as {
      from: string; to: string; cadence: string; notes: string[];
      currencies: { currency: string; accounts_counted: number; points: { date: string; net_worth: string; assets: string; liabilities: string }[] }[];
    };
    expect(body.from).toBe('2025-11-01');
    expect(body.to).toBe('2026-10-15');
    expect(body.cadence).toBe('month-end');
    expect(body.currencies.map(line => line.currency)).toEqual(['GBP']);
    const gbp = body.currencies[0];
    expect(gbp.accounts_counted).toBe(3);
    expect(gbp.points.map(point => point.date)).toEqual([
      '2025-11-30', '2025-12-31', '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30',
      '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-15',
    ]);
    // Savings (undated opening) counts throughout; the current account's
    // opening lands on 1 Jan; its rows then fall where they are dated.
    expect(gbp.points[0].net_worth).toBe('5000.00 GBP');
    expect(gbp.points[2].net_worth).toBe('4977.06 GBP');
    expect(gbp.points[10].net_worth).toBe('4917.06 GBP');
    expect(gbp.points[11].net_worth).toBe('6234.56 GBP');
    expect(body.notes[0]).toMatch(/no currency conversion, closed accounts included/);
    expect(body.notes[1]).toMatch(/1 account has an opening balance with no date/);
  });

  it('gives daily points for a short window and refuses an inverted one', async () => {
    const result = await call('reckley_net_worth_series', { from: '2026-10-01', to: '2026-10-10', response_format: 'json' });
    const body = result.structuredContent as { cadence: string; currencies: { points: { date: string; net_worth: string }[] }[] };
    expect(body.cadence).toBe('daily');
    expect(body.currencies[0].points.length).toBe(10);
    expect(body.currencies[0].points[0]).toMatchObject({ date: '2026-10-01', net_worth: '4872.06 GBP' });
    expect(body.currencies[0].points[9]).toMatchObject({ date: '2026-10-10', net_worth: '6234.56 GBP' });

    const inverted = await call('reckley_net_worth_series', { from: '2026-10-10', to: '2026-10-01' });
    expect(inverted.isError).toBe(true);
  });

  it('reads as a list in words', async () => {
    const text = textOf(await call('reckley_net_worth_series', { from: '2026-10-14', to: '2026-10-15' }));
    expect(text).toMatch(/^# Net worth 2026-10-14 to 2026-10-15 \(daily points\)/);
    expect(text).toMatch(/## GBP \(3 accounts\)/);
    expect(text).toMatch(/- 2026-10-15: net 6234\.56 GBP \(own 6234\.56 GBP, owe 0\.00 GBP\)/);
  });
});

// ── The write side ──────────────────────────────────────────────────────────

describe('the tool list with the write scope', () => {
  it('adds the write tools, each titled and marked destructive, and nothing a read token sees changes', async () => {
    await connectForWriting();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual([...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES].sort());
    for (const tool of tools.filter(tool => (WRITE_TOOL_NAMES as readonly string[]).includes(tool.name))) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(true);
      expect(tool.name.length).toBeLessThanOrEqual(64);
    }
  });

  it('is withheld from a read-only token even on the server that could register it', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual([...READ_TOOL_NAMES].sort());
    await expect(client.callTool({ name: 'reckley_set_category', arguments: { transaction_ids: ['t6'], category_id: 'det-phone' } }))
      .rejects.toThrow(/not found/);
  });
});

describe('reckley_set_category', () => {
  beforeEach(() => connectForWriting());

  it('files as a suggestion by default — unconfirmed and flagged for review, as the app’s own categoriser does', async () => {
    const result = await call('reckley_set_category', { transaction_ids: ['t6'], category_id: 'det-phone' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toMatch(/^Suggested Bills \(Household\) > Telephone for 1; left in To Review/);
    const body = result.structuredContent as Written;
    expect(body.changed).toBe(1);
    expect(body.transactions[0]).toMatchObject({ id: 't6', category_id: 'det-phone', category_is_suggested: true, awaiting_review: true });
    expect(await rowNow('t6')).toMatchObject({ category_is_suggested: true, awaiting_review: true });
  });

  it('records the person’s own choice when told to confirm, and the rows leave review', async () => {
    const result = await call('reckley_set_category', { transaction_ids: ['t2', 't6'], category_id: 'det-groceries', confirm: true });
    expect(textOf(result)).toMatch(/^Filed 2 under Food > Groceries as the person's own choice; review ended\./);
    for (const id of ['t2', 't6']) {
      expect(await rowNow(id)).toMatchObject({ category_id: 'det-groceries', category_is_suggested: false, awaiting_review: false });
    }
  });

  it('refuses the whole request, changing nothing, for an unknown id, a transfer, a split, a To/From category, a group or a retired category', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ transaction_ids: ['t6', 'nope'], category_id: 'det-phone' }, /No transaction has id nope/],
      [{ transaction_ids: ['t4'], category_id: 'det-phone' }, /a transfer is filed by being one/],
      [{ transaction_ids: ['t8'], category_id: 'det-phone' }, /a split files through its lines/],
      [{ transaction_ids: ['t6'], category_id: 'tofrom-savings' }, /To\/From category/],
      [{ transaction_ids: ['t6'], category_id: 'type-expense' }, /top-level group/],
      [{ transaction_ids: ['t6'], category_id: 'det-retired' }, /retired/],
      [{ transaction_ids: ['t6'], category_id: 'missing' }, /No category has id missing/],
    ];
    for (const [args, expected] of cases) {
      const result = await call('reckley_set_category', args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(result)).toMatch(expected);
      expect(textOf(result)).toMatch(/Nothing was changed/);
    }
    expect(await rowNow('t6')).toMatchObject({ category_id: null, awaiting_review: true });
  });

  it('will not take more ids than the cap', async () => {
    const result = await call('reckley_set_category', { transaction_ids: Array.from({ length: 51 }, (_, i) => `t${i}`), category_id: 'det-phone' });
    expect(result.isError).toBe(true);
  });
});

describe('reckley_confirm_categories', () => {
  beforeEach(() => connectForWriting());

  it('confirms only rows whose category is a suggestion, ends their review, and counts those alone', async () => {
    const result = await call('reckley_confirm_categories', { transaction_ids: ['t2', 't1', 't6'] });
    expect(textOf(result)).toMatch(/^Confirmed 1 of 3/);
    expect(await rowNow('t2')).toMatchObject({ category_id: 'det-phone', category_is_suggested: false, awaiting_review: false });
    expect(await rowNow('t6')).toMatchObject({ category_id: null, awaiting_review: true });
  });

  it('refuses an unknown id', async () => {
    const result = await call('reckley_confirm_categories', { transaction_ids: ['t2', 'nope'] });
    expect(result.isError).toBe(true);
    expect(await rowNow('t2')).toMatchObject({ category_is_suggested: true });
  });
});

describe('reckley_update_transaction_text', () => {
  beforeEach(() => connectForWriting());

  it('changes the description and the note and nothing else', async () => {
    const before = await rowNow('t2');
    const result = await call('reckley_update_transaction_text', { transaction_id: 't2', description: 'Skyline Telecom', notes: 'Monthly broadband' });
    expect(textOf(result)).toMatch(/^Updated\./);
    const after = await rowNow('t2');
    expect(after).toMatchObject({ description: 'Skyline Telecom', notes: 'Monthly broadband' });
    expect(after).toMatchObject({ amount: before.amount, category_id: before.category_id, category_is_suggested: true, awaiting_review: true, cleared: before.cleared });
  });

  it('clears a note with an empty string, and refuses a call that changes nothing', async () => {
    await call('reckley_update_transaction_text', { transaction_id: 't8', notes: '' });
    expect((await rowNow('t8')).notes).toBeNull();
    const nothing = await call('reckley_update_transaction_text', { transaction_id: 't8' });
    expect(nothing.isError).toBe(true);
    expect(textOf(nothing)).toMatch(/Give a description, a note, or both/);
  });
});

describe('reckley_mark_reviewed', () => {
  beforeEach(() => connectForWriting());

  it('ends review on filed rows and leaves their category and confirmation alone', async () => {
    const result = await call('reckley_mark_reviewed', { transaction_ids: ['t2'] });
    expect(textOf(result)).toMatch(/^Marked 1 reviewed\./);
    expect(await rowNow('t2')).toMatchObject({ awaiting_review: false, category_id: 'det-phone', category_is_suggested: true });
  });

  it('refuses an unfiled row, which would stay in To Review whatever its flag', async () => {
    const result = await call('reckley_mark_reviewed', { transaction_ids: ['t2', 't6'] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no category and would stay in To Review \(t6\)/);
    expect(await rowNow('t2')).toMatchObject({ awaiting_review: true });
  });
});

describe('reckley_mark_cleared', () => {
  beforeEach(() => connectForWriting());

  it('marks, counts only rows that changed, and ends review on a filed row as the app does', async () => {
    const result = await call('reckley_mark_cleared', { transaction_ids: ['t1', 't2', 't6'], cleared: true });
    expect(textOf(result)).toMatch(/^Marked 2 of 3; the rest were already cleared\./);
    expect(await rowNow('t2')).toMatchObject({ cleared: true, awaiting_review: false });
    // Unfiled: ticked, but still waiting to be filed.
    expect(await rowNow('t6')).toMatchObject({ cleared: true, awaiting_review: true });
  });

  it('unmarks without saying anything about review', async () => {
    await call('reckley_mark_cleared', { transaction_ids: ['t2'], cleared: true });
    const result = await call('reckley_mark_cleared', { transaction_ids: ['t2'], cleared: false });
    expect(textOf(result)).toMatch(/^Unmarked 1 of 1/);
    expect(await rowNow('t2')).toMatchObject({ cleared: false, awaiting_review: false });
  });
});

const savingsSide: Transaction = {
  ...transactions[0],
  id: 's-in',
  accountId: 'acc-savings',
  amount: 45,
  type: 'income',
  category: '',
  description: 'FROM CURRENT',
  needsReview: true,
};

describe('reckley_link_transfer', () => {
  it('joins two rows as one transfer, each filed under the other account’s To/From, and leaves both in review by default', async () => {
    await connectForWriting(fakePort({ transactions: [...transactions, savingsSide] }));
    const result = await call('reckley_link_transfer', { transaction_id: 't1', counterpart_id: 's-in' });
    expect(textOf(result)).toMatch(/^Linked as a transfer; both sides left for the person to review\./);
    const body = result.structuredContent as Written;
    expect(body.transactions.map(row => [row.id, row.type, row.amount, row.category])).toEqual([
      ['t1', 'transfer', '-45.00 GBP', 'Transfer with Savings'],
      ['s-in', 'transfer', '45.00 GBP', 'Transfer with Current Account'],
    ]);
    expect((await rowNow('s-in')).awaiting_review).toBe(true);
  });

  it('ends review on both sides when told to confirm', async () => {
    await connectForWriting(fakePort({ transactions: [...transactions, { ...savingsSide }] }));
    const result = await call('reckley_link_transfer', { transaction_id: 't1', counterpart_id: 's-in', confirm: true });
    expect(textOf(result)).toMatch(/review ended on both sides/);
    expect((await rowNow('s-in')).awaiting_review).toBe(false);
  });

  it('passes the ledger’s refusal on in its own words, having changed nothing', async () => {
    await connectForWriting();
    const result = await call('reckley_link_transfer', { transaction_id: 't1', counterpart_id: 't7' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/a transfer needs two different accounts\. Nothing was changed\./);
    expect((await rowNow('t1')).type).toBe('expense');
  });
});

describe('reckley_create_transfer_counterpart', () => {
  beforeEach(() => connectForWriting());

  it('writes the other side into the named account and links the two', async () => {
    const result = await call('reckley_create_transfer_counterpart', { transaction_id: 't1', target_account_id: 'acc-savings' });
    expect(textOf(result)).toMatch(/^Created the other side and linked the two; the original left for the person to review\./);
    const body = result.structuredContent as Written;
    expect(body.transactions.map(row => [row.account, row.type, row.amount])).toEqual([
      ['Current Account', 'transfer', '-45.00 GBP'],
      ['Savings', 'transfer', '45.00 GBP'],
    ]);
  });

  it('refuses the same account, in the ledger’s words', async () => {
    const result = await call('reckley_create_transfer_counterpart', { transaction_id: 't1', target_account_id: 'acc-current' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/a transfer needs two different accounts/);
  });
});

describe('reckley_add_transaction', () => {
  beforeEach(() => connectForWriting());

  it('records spending as a negative amount with the category suggested and the row in To Review', async () => {
    const result = await call('reckley_add_transaction', {
      account_id: 'acc-current', date: '2026-10-12', description: 'Window cleaner', amount: 12.5, kind: 'expense', category_id: 'det-phone',
    });
    expect(textOf(result)).toMatch(/^Added with Bills \(Household\) > Telephone suggested; it waits in To Review\./);
    const body = result.structuredContent as Written;
    expect(body.transactions[0]).toMatchObject({ account: 'Current Account', amount: '-12.50 GBP', type: 'expense', category_is_suggested: true, awaiting_review: true });
  });

  it('records income as positive, as the person’s own filing when confirmed, and unfiled when no category is given', async () => {
    const filed = await call('reckley_add_transaction', {
      account_id: 'acc-savings', date: '2026-10-12', description: 'Interest', amount: 3, kind: 'income', category_id: 'det-salary', confirm: true,
    });
    expect((filed.structuredContent as Written).transactions[0]).toMatchObject({ amount: '3.00 GBP', category_is_suggested: false, awaiting_review: false });
    const blank = await call('reckley_add_transaction', {
      account_id: 'acc-savings', date: '2026-10-12', description: 'Unknown credit', amount: 3, kind: 'income',
    });
    expect(textOf(blank)).toMatch(/^Added, with no category; it waits in To Review\./);
    expect((blank.structuredContent as Written).transactions[0]).toMatchObject({ category_id: null, awaiting_review: true });
  });

  it('refuses a closed account, an unknown account and a To/From category, writing nothing', async () => {
    const closed = await call('reckley_add_transaction', { account_id: 'acc-old', date: '2026-10-12', description: 'x', amount: 1, kind: 'expense' });
    expect(textOf(closed)).toMatch(/Old Card is closed/);
    const unknown = await call('reckley_add_transaction', { account_id: 'acc-none', date: '2026-10-12', description: 'x', amount: 1, kind: 'expense' });
    expect(textOf(unknown)).toMatch(/No account has id acc-none/);
    const transfer = await call('reckley_add_transaction', { account_id: 'acc-current', date: '2026-10-12', description: 'x', amount: 1, kind: 'expense', category_id: 'tofrom-savings' });
    expect(textOf(transfer)).toMatch(/To\/From category/);
    for (const result of [closed, unknown, transfer]) expect(result.isError).toBe(true);
    const search = await call('reckley_search_transactions', { text: 'x', response_format: 'json' });
    expect((search.structuredContent as { total: number }).total).toBe(0);
  });
});

