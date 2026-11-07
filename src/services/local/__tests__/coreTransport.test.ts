/**
 * The envelope, and what the port does with each half of it.
 *
 * The contract suite proves the local edition against a REAL ledger file, which
 * is the right way to prove behaviour and the wrong way to prove this: the read
 * verbs have no refusal in them (an owner with no accounts has an empty list,
 * which is an answer), so the whole `ok:false` half of the wire would go
 * untested there and only be reached the first time a write refused in front of
 * a person.
 *
 * So this file drives the port over a transport of its own — no processes, no
 * files, no Rust — and asks the two questions the wire actually decides:
 *
 *   WHAT A REFUSAL COSTS. The crate wrote a sentence for a person to read. Seam
 *   rule 4 says `.message` is rendered straight into the UI, so it must arrive
 *   verbatim: not prefixed, not wrapped, not re-worded. A transport that
 *   "helpfully" said "Request failed: …" would put its own words in front of
 *   somebody in the ~28 places the app prints an error.
 *
 *   WHAT A FAULT COSTS. A file that will not open is not an answer, and the
 *   three reads the seam says may never reject have to absorb it — because the
 *   boot has ONE outer catch and reaching it replaces the whole app with
 *   "Failed to load data" for somebody whose next launch would have worked.
 *
 * It runs in the ordinary suite, unlike the contract run: there is no ledger
 * crate in it, so there is nothing here a machine without a Rust toolchain
 * cannot answer.
 */

import { describe, it, expect, vi } from 'vitest';
import { createInvokeTransport, readEnvelope, type CoreTransport } from '../coreTransport';
import { LocalDataPort } from '../localDataPort';

const OWNER = '11111111-1111-1111-1111-111111111111';

/** A transport that answers whatever it is told to, and remembers being asked. */
const transportAnswering = (answer: (verb: string) => unknown): CoreTransport & {
  asked: { verb: string; payload: unknown }[];
} => {
  const asked: { verb: string; payload: unknown }[] = [];
  return {
    asked,
    call: async (verb, payload) => {
      asked.push({ verb, payload });
      return readEnvelope(verb, answer(verb));
    }
  };
};

const silent = { error: (): void => {} };

describe('the ledger crate’s envelope', () => {
  it('hands back what the verb answered', () => {
    const result = readEnvelope('list_accounts', {
      ok: true,
      result: { answer: { accounts: [] } }
    });

    expect(result).toEqual({ answer: { accounts: [] } });
  });

  it('throws the ledger’s own words, unchanged, when the ledger refused', () => {
    // The exact sentence matters: it is what the user reads. A transport that
    // added a syllable to it would be writing UI copy from the wire layer.
    const message = 'That account is not yours, so nothing was changed.';

    let thrown: unknown;
    try {
      readEnvelope('delete_transaction', {
        ok: false,
        error: { code: 'account_not_found_or_not_owned', message, hint: 'Pick another account.' }
      });
    } catch (error) {
      thrown = error;
    }

    // EQUALS, not contains. `toThrow(text)` is a substring match, and a
    // substring match is satisfied by every wrapping this rule exists to
    // forbid — "Request failed: That account is not yours…" would pass it.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(message);
  });

  it('carries the code and the hint where a debugger can see them and a log cannot', () => {
    // The seam permits a machine code beside the prose and forbids branching on
    // it. Non-enumerable is how that becomes a property rather than a request:
    // it survives into a debugger and disappears from every spread, every
    // JSON.stringify and every logged payload — including the places somebody
    // would first notice it and reach for `if (error.code === …)`.
    let thrown: unknown;
    try {
      readEnvelope('create_transaction', {
        ok: false,
        error: { code: 'amount_below_a_penny', message: 'That amount is smaller than a penny.', hint: 'Round it.' }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(Object.keys(error)).toEqual([]);
    expect(JSON.stringify(error)).toBe('{}');
    expect({ ...error }).toEqual({});
    // Still there for whoever is actually debugging.
    expect(Object.getOwnPropertyDescriptor(error, 'code')?.value).toBe('amount_below_a_penny');
    expect(Object.getOwnPropertyDescriptor(error, 'hint')?.value).toBe('Round it.');
  });

  it('treats an answer that is not an envelope as a fault, and names the verb', () => {
    // Not a refusal: the ledger did not say no, something between here and the
    // ledger said nothing intelligible. Naming the verb is the difference
    // between a message somebody can act on and an afternoon.
    expect(() => readEnvelope('load_boot', { rows: [] })).toThrow(/load_boot/);
    expect(() => readEnvelope('load_boot', 'not json at all')).toThrow(/envelope/);
    expect(() => readEnvelope('load_boot', { ok: false, error: { code: 'x' } })).toThrow(/load_boot/);
  });
});

describe('the port over a transport', () => {
  const anAccount = {
    id: 'acct-a',
    user_id: OWNER,
    name: 'Everyday',
    // `type` on the wire, as the crate really spells it. This fixture said
    // `kind` until slice 19 — the crate's RUST field is called that, because
    // `type` is a reserved word there, and every row struct renames it back for
    // serde. A hand-written fixture is the port's own idea of what an answer
    // looks like, so it agreed with the mapper's mistake and both were wrong
    // together; the suite that runs against the real binary is what found it.
    type: 'checking',
    currency: 'GBP',
    balance: '-70.10',
    initial_balance: '0.00',
    bank_balance: null,
    bank_balance_date: null,
    last_reconciled_date: null,
    low_balance_alert_enabled: true,
    low_balance_threshold: '25.00',
    opening_balance_date: null,
    archive_through_date: null,
    parent_account_id: null,
    institution: 'Made Up Bank',
    account_number: '12345678',
    sort_code: '00-00-00',
    icon: null,
    color: null,
    notes: null,
    is_active: true,
    metadata: {},
    created_at: '2025-01-01T09:00:00.000Z',
    updated_at: '2025-01-02T09:00:00.000Z'
  };

  it('sends the owner with every question, and takes one from nobody', async () => {
    // Seam rule 1, asserted at runtime because it cannot be asserted in the
    // type: `listAccounts()` takes no arguments in EVERY implementation, so the
    // only way an owner can be wrong is if the port resolved the wrong one —
    // which is the mistake the rule exists to make unrepresentable.
    // Each read is answered under the key its own verb uses, which is the
    // other half of what this checks: the port asks the right verb and reads
    // the right list out of it.
    const listFor: Record<string, string> = {
      list_accounts: 'accounts',
      list_categories: 'categories',
      splits_for: 'splits'
    };
    const transport = transportAnswering(verb => ({
      ok: true,
      result: { answer: { [listFor[verb]]: [] } }
    }));
    const port = new LocalDataPort({ owner: OWNER, transport, logger: silent });

    await port.listAccounts();
    await port.listCategories();
    await port.listTransactionSplitsFor('txn-1');

    expect(port.listAccounts.length).toBe(0);
    expect(transport.asked.map(call => call.verb)).toEqual([
      'list_accounts',
      'list_categories',
      'splits_for'
    ]);
    transport.asked.forEach(call => {
      expect(call.payload).toMatchObject({ user_id: OWNER });
    });
    // …and the one read that names something narrower still names only that.
    expect(transport.asked[2].payload).toEqual({ user_id: OWNER, transaction_id: 'txn-1' });
  });

  it('refuses an owner the file’s own schema would refuse', () => {
    // R-3. `schema.sql` puts `CHECK (id = lower(id) AND length(id) = 36)` on
    // users, so 'local-device' — the browser bundle's provenance string — can
    // never be a file's owner. Refused here, where the sentence can still
    // explain itself; left to the file, every READ would answer with an empty
    // ledger instead, which reads exactly like a new one.
    expect(
      () =>
        new LocalDataPort({
          owner: 'local-device',
          transport: transportAnswering(() => ({ ok: true, result: { answer: { accounts: [] } } })),
          logger: silent
        })
    ).toThrow(/36 lowercase characters/);
  });

  it('reads a crate answer into the app’s own shapes', async () => {
    // Money as a fixed decimal STRING becomes a number exactly once; a
    // timestamp becomes a Date; 'checking' becomes the app's 'current'. The
    // figure is the one IEEE-754 gets wrong when anything re-adds it.
    const transport = transportAnswering(() => ({
      ok: true,
      result: { answer: { accounts: [anAccount] } }
    }));
    const port = new LocalDataPort({ owner: OWNER, transport, logger: silent });

    const [account] = await port.listAccounts();

    expect(account).toMatchObject({
      id: 'acct-a',
      name: 'Everyday',
      type: 'current',
      balance: -70.1,
      currency: 'GBP',
      institution: 'Made Up Bank',
      accountNumber: '12345678',
      sortCode: '00-00-00',
      lowBalanceAlertEnabled: true,
      lowBalanceThreshold: 25,
      isActive: true
    });
    expect(account.lastUpdated).toBeInstanceOf(Date);
    expect(account.lastUpdated.toISOString()).toBe('2025-01-02T09:00:00.000Z');
  });

  it('lets a refusal through, in the ledger’s words, on a read that may reject', async () => {
    const message = 'This ledger holds no such transaction.';
    const transport = transportAnswering(() => ({
      ok: false,
      error: { code: 'transaction_not_found', message }
    }));
    const port = new LocalDataPort({ owner: OWNER, transport, logger: silent });

    await expect(port.listTransactionSplitsFor('txn-nowhere')).rejects.toThrow(message);
  });

  it('absorbs a fault on the three reads the boot cannot survive losing', async () => {
    // THE floor. The boot has one outer catch; reaching it replaces the app.
    // A store that will not open costs whatever could not be read, said out
    // loud in the words the boot-timing line prints, and never a rejection.
    const failing: CoreTransport = {
      call: async () => Promise.reject(new Error('The ledger file could not be opened.'))
    };
    const complained = vi.fn();
    const port = new LocalDataPort({ owner: OWNER, transport: failing, logger: { error: complained } });

    const boot = await port.loadBoot();
    expect(boot.accounts).toEqual([]);
    expect(boot.transactions).toEqual([]);
    expect(boot.categories).toEqual([]);
    expect(boot.transactionStats).toMatchObject({ total: 0, fullFetchReason: 'load failed' });
    // Diagnostic, and required to exist: the console line a production slowness
    // report is read off is built from it, and a boot that failed is exactly
    // when somebody looks.
    expect(typeof boot.phases.load_boot).toBe('number');

    const rows = await port.loadBootTransactions();
    expect(rows.transactions).toEqual([]);
    expect(rows.stats.fullFetchReason).toBe('load failed');

    const balances = await port.getAccountBalances();
    // Empty means "I don't know" and the app sums the rows itself. A map of
    // zeros would paint every account at £0.00 and call it real money.
    expect(balances.size).toBe(0);

    // Silence is not an option: three reads swallowed a failure, and something
    // has to be able to say so afterwards.
    expect(complained).toHaveBeenCalledTimes(3);
  });

  it('reads a whole boot into the app’s shapes, entity by entity', async () => {
    // Seven translations in one answer, and the reason to do it here rather
    // than leave it all to the contract run: this file needs no Rust, so it is
    // what a machine WITHOUT a built crate still proves about the money
    // boundary. Every figure below is a decimal string on the wire and a number
    // in the app, converted once.
    const transport = transportAnswering(() => ({
      ok: true,
      result: {
        answer: {
          accounts: [anAccount],
          categories: [
            {
              id: 'cat-everyday',
              user_id: OWNER,
              name: 'Everyday',
              type: 'expense',
              level: 'detail',
              parent_id: null,
              account_id: null,
              color: null,
              icon: null,
              is_system: false,
              is_transfer_category: false,
              is_revaluation_category: false,
              is_unassigned_bucket: false,
              is_active: true,
              created_at: '2025-01-01T09:00:00.000Z',
              updated_at: '2025-01-01T09:00:00.000Z'
            }
          ],
          transactions: [
            {
              id: 'txn-1',
              account_id: 'acct-a',
              amount: '-70.10',
              archived: false,
              category: 'cat-everyday',
              category_confirmed: true,
              category_id: null,
              created_at: '2025-01-10T09:00:00.000Z',
              date: '2025-01-10',
              description: 'Corner shop',
              is_cleared: true,
              is_recurring: false,
              is_split: false,
              linked_transfer_id: null,
              linked_transfer_split_id: null,
              needs_review: true,
              notes: 'Paid in cash',
              statement_sequence: 3,
              tags: ['weekly', 'food'],
              type: 'expense',
              updated_at: '2025-01-10T09:00:00.000Z',
              transfer_account_id: null
            }
          ],
          transaction_splits: [
            {
              id: 'line-1',
              transaction_id: 'txn-1',
              user_id: OWNER,
              category: 'cat-everyday',
              amount: '-10.10',
              memo: 'Half of it',
              sort_order: 2,
              transfer_account_id: 'acct-b',
              linked_transfer_id: 'txn-2',
              created_at: '2025-01-10T09:00:00.000Z',
              updated_at: '2025-01-10T09:00:00.000Z'
            }
          ],
          budgets: [
            {
              id: 'budget-1',
              user_id: OWNER,
              name: 'Everyday',
              amount: '200.00',
              period: 'biweekly',
              category: 'cat-everyday',
              category_id: null,
              start_date: '2025-01-01',
              end_date: null,
              spent: '0.00',
              rollover_mode: 'none',
              pace_shape: 'even',
              rollover_to: null,
              alert_threshold: '80.00',
              is_active: true,
              notes: null,
              metadata: {},
              created_at: '2025-01-01T09:00:00.000Z',
              updated_at: '2025-01-01T09:00:00.000Z'
            }
          ],
          goals: [
            {
              id: 'goal-1',
              user_id: OWNER,
              name: 'New boiler',
              description: null,
              target_amount: '1500.00',
              current_amount: '250.05',
              target_date: '2026-01-01',
              category: null,
              priority: 'high',
              status: 'paused',
              account_id: null,
              contribution_frequency: 'monthly',
              auto_contribute: false,
              icon: null,
              color: null,
              completed_at: null,
              metadata: { type: 'debt-payoff' },
              created_at: '2025-01-01T09:00:00.000Z',
              updated_at: '2025-01-01T09:00:00.000Z'
            }
          ],
          // The boot's seventh list. `components` and `filters` arrive as real
          // JSON — an array and an object, never strings — because that is what
          // `row/custom_report.rs` serialises after parsing the stored TEXT.
          custom_reports: [
            {
              id: 'report-1',
              user_id: OWNER,
              name: 'Where it went',
              description: 'last quarter',
              components: [
                { id: 'one', type: 'summary-stats', title: 'Key figures', config: {}, width: 'full' }
              ],
              filters: { dateRange: 'quarter', accounts: ['account-1'] },
              created_at: '2025-01-01T09:00:00.000Z',
              updated_at: '2025-01-01T09:00:00.000Z'
            }
          ]
        }
      }
    }));
    const port = new LocalDataPort({ owner: OWNER, transport, logger: silent });

    const boot = await port.loadBoot();

    expect(boot.accounts).toHaveLength(1);
    expect(boot.categories[0]).toMatchObject({
      id: 'cat-everyday',
      type: 'expense',
      level: 'detail',
      parentId: null,
      isActive: true
    });
    expect(boot.transactions[0]).toMatchObject({
      id: 'txn-1',
      amount: -70.1,
      description: 'Corner shop',
      type: 'expense',
      cleared: true,
      needsReview: true,
      categoryConfirmed: true,
      statementSequence: 3,
      tags: ['weekly', 'food'],
      notes: 'Paid in cash'
    });
    // A day crosses as a Date naming THE SAME DAY in every zone the app is used
    // in — midnight UTC would be the 9th for anybody west of Greenwich.
    expect(boot.transactions[0].date.toISOString()).toBe('2025-01-10T12:00:00.000Z');
    expect(boot.splits[0]).toMatchObject({
      id: 'line-1',
      transactionId: 'txn-1',
      amount: -10.1,
      memo: 'Half of it',
      sortOrder: 2,
      transferAccountId: 'acct-b',
      linkedTransferId: 'txn-2'
    });
    expect(boot.budgets[0]).toMatchObject({
      id: 'budget-1',
      // The categoryId travels in the TEXT column, exactly as it does in the
      // cloud: frontend category ids are not uuids.
      categoryId: 'cat-everyday',
      amount: 200,
      spent: 0,
      // 'biweekly' is a period the schema allows and the app has no member for,
      // so it reads as the app's own name for a cadence none of the standard
      // ones describe rather than as a value the budgets page cannot draw.
      period: 'custom',
      // Hundredths of a PERCENT on the wire (8000), rendered by the crate as
      // '80.00', and NOT divided by anything on this side of the boundary.
      alertThreshold: 80
    });
    expect(boot.goals[0]).toMatchObject({
      id: 'goal-1',
      // Out of the metadata blob, which is where both engines keep it.
      type: 'debt-payoff',
      targetAmount: 1500,
      currentAmount: 250.05,
      // Rule 49: progress IS the money already put by, never zero.
      progress: 250.05,
      priority: 'high',
      status: 'paused',
      // One column answers both questions.
      isActive: false,
      achieved: false,
      contributionFrequency: 'monthly'
    });
    // The seventh list, through the same mapper the dashboard reads. It rides
    // the boot because two of its readers resolve a report DURING render and
    // have no await to put a fetch in.
    expect(boot.customReports[0]).toMatchObject({
      id: 'report-1',
      name: 'Where it went',
      description: 'last quarter'
    });
    // The two blobs arrive as structures, not as strings. A report whose
    // components came back as a string containing JSON would render as an empty
    // report and say nothing about why.
    expect(boot.customReports[0].components).toHaveLength(1);
    expect(boot.customReports[0].filters.accounts).toEqual(['account-1']);
  });

  it('folds a dismissal’s subjects back into the array the app holds', async () => {
    // The child table (`suggestion_dismissal_subjects`, ordered by role_order)
    // is joined by the verb, so what arrives is the array either engine's
    // caller expects — in role order, which is what makes a dismissal about a
    // PAIR survive a re-scan that reaches the two rows from the other end.
    const transport = transportAnswering(() => ({
      ok: true,
      result: {
        answer: {
          suggestion_dismissals: [
            {
              id: 'dismissal-1',
              kind: 'transfer-pair',
              subject_key: 'corner-shop-10-10',
              subject_ids: ['txn-1', 'txn-2'],
              dismissed_at: '2025-01-05T09:00:00.000Z'
            }
          ]
        }
      }
    }));
    const port = new LocalDataPort({ owner: OWNER, transport, logger: silent });

    const [dismissal] = await port.listSuggestionDismissals();

    expect(dismissal).toEqual({
      id: 'dismissal-1',
      kind: 'transfer-pair',
      subjectKey: 'corner-shop-10-10',
      subjectIds: ['txn-1', 'txn-2'],
      dismissedAt: new Date('2025-01-05T09:00:00.000Z')
    });
  });

  it('answers the balances as a map of derived figures, keyed by account', async () => {
    // B-2's 'answers'. The figure is the file's own aggregate — never
    // `accounts.balance` — and the count is COUNT(t.id) under a LEFT JOIN, so
    // an account with no rows says 0 rather than 1.
    const transport = transportAnswering(() => ({
      ok: true,
      result: {
        answer: {
          account_balances: [
            { account_id: 'acct-a', balance: '0.30', txn_count: 1 },
            { account_id: 'acct-b', balance: '0.00', txn_count: 0 }
          ]
        }
      }
    }));
    const port = new LocalDataPort({ owner: OWNER, transport, logger: silent });

    const balances = await port.getAccountBalances();

    expect(balances.get('acct-a')).toEqual({ balance: 0.3, txnCount: 1 });
    expect(balances.get('acct-b')).toEqual({ balance: 0, txnCount: 0 });
  });

  it('says where a boot’s rows came from, in the two words this engine has', async () => {
    // B-1. There is no snapshot layer, because the rows are already on the
    // device — so 'local mode', never null, which would claim a cache stood.
    const transport = transportAnswering(() => ({
      ok: true,
      result: {
        answer: {
          accounts: [anAccount],
          categories: [],
          transactions: [],
          transaction_splits: [],
          budgets: [],
          goals: [],
          custom_reports: []
        }
      }
    }));
    const port = new LocalDataPort({ owner: OWNER, transport, logger: silent });

    const boot = await port.loadBoot();

    expect(transport.asked.map(call => call.verb)).toEqual(['load_boot']);
    expect(boot.transactionStats).toEqual({
      cached: 0,
      fetched: 0,
      total: 0,
      fullFetchReason: 'local mode'
    });
  });

  it('treats a verb that answered the wrong shape as a fault, not as an empty ledger', async () => {
    // The one wrong answer nobody would question. The crate's dispatch is
    // exhaustive and its structs are serialised by serde, so a missing
    // `accounts` key means the transport is talking to something else — and
    // reporting that as "you have no accounts" is how a person concludes their
    // data is gone.
    const transport = transportAnswering(() => ({ ok: true, result: { answer: {} } }));
    const port = new LocalDataPort({ owner: OWNER, transport, logger: silent });

    await expect(port.listAccounts()).rejects.toThrow(/without a accounts list/);
  });

  it('hands back a subscription handle that is safe to call twice and hears nothing', async () => {
    // B-8 for this engine: one file on one machine, so there is nothing to hear
    // from. The caller stores this in a React cleanup, and a handle that is not
    // a function takes the whole provider down on unmount.
    const port = new LocalDataPort({
      owner: OWNER,
      transport: transportAnswering(() => ({ ok: true, result: { answer: { accounts: [] } } })),
      logger: silent
    });

    const stop = port.subscribeToUpdates();
    expect(typeof stop).toBe('function');
    expect(() => {
      stop();
      stop();
    }).not.toThrow();

    await expect(port.initialize()).resolves.toBeUndefined();
  });

  it('describes a device, and answers synchronously', async () => {
    const port = new LocalDataPort({
      owner: OWNER,
      transport: transportAnswering(() => ({ ok: true, result: { answer: { accounts: [] } } })),
      logger: silent
    });

    const capabilities = port.capabilities();

    expect(capabilities).not.toBeInstanceOf(Promise);
    expect(capabilities).toEqual({
      edition: 'device',
      session: 'anonymous',
      realtime: false,
      // One connection behind a mutex is a QUEUE, not concurrency.
      maxConcurrentWrites: 1,
      // The file is the only copy, which is what the backup screens say.
      backupTarget: 'device',
      // NOTHING, and that is a statement rather than a stub: `schema.sql` holds
      // all fifteen tables a backup file carries, so a file restored from a
      // login loses none of it. The browser's store answers seven names here.
      cannotKeep: []
    });
    // A snapshot, not a live view: a caller that mutated what it was handed
    // must not be able to change what the next caller is told.
    port.capabilities().realtime = true;
    expect(port.capabilities().realtime).toBe(false);
  });
});

describe('the desktop transport — one Tauri command, in the ledger’s own process', () => {
  /** The shell's `invoke`, with the answer a test wants and a record of the ask. */
  const shellAnswering = (
    answer: (verb: string, payload: unknown) => unknown
  ): { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>; asked: unknown[] } => {
    const asked: unknown[] = [];
    return {
      asked,
      invoke: async (command, args) => {
        asked.push({ command, args });
        return answer(String(args.verb), args.payload);
      }
    };
  };

  it('sends one command, named once, with the verb and the payload beside it', async () => {
    const shell = shellAnswering(() => ({ ok: true, result: { answer: { accounts: [] } } }));

    const answer = await createInvokeTransport(shell.invoke).call('list_accounts', {
      user_id: OWNER
    });

    // D-3's whole point: ONE command, over the crate's own dispatch. A shell
    // with a command per verb would be a second verb set.
    expect(shell.asked).toEqual([
      {
        command: 'wealth_core_invoke',
        args: { verb: 'list_accounts', payload: { user_id: OWNER } }
      }
    ]);
    expect(answer).toEqual({ answer: { accounts: [] } });
  });

  it('gives back the ledger’s refusal WORD FOR WORD', async () => {
    // Seam rule 4. The crate wrote this sentence for a person and the app
    // renders `.message` straight into the UI in ~28 places, so a transport
    // that prefixed or wrapped it would be speaking over the ledger.
    const prose =
      'This transfer is already linked to another transaction. Unlink it first, then try again.';
    const shell = shellAnswering(() => ({
      ok: false,
      error: { code: 'transfer_already_linked', message: prose, hint: 'Unlink the other side.' }
    }));

    await expect(
      createInvokeTransport(shell.invoke).call('link_transfer_pair', {})
    ).rejects.toThrow(prose);

    const error = await createInvokeTransport(shell.invoke)
      .call('link_transfer_pair', {})
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(prose);
    // Not enumerable, so it cannot reach a log, a spread or an `if` on a code.
    expect(Object.keys(error as object)).toEqual([]);
    expect(JSON.stringify(error)).toBe('{}');
  });

  it('turns a REJECTED invoke into a fault, because the crate never answered', async () => {
    // `main.rs` resolves with the envelope and rejects only when the ledger was
    // not asked at all — no document open, storage failed. The crate had no
    // chance to write a sentence, so this module writes one, with the verb in
    // it.
    const shell = {
      invoke: async (): Promise<unknown> => {
        throw 'no ledger is open in this window, so there was nothing to ask';
      }
    };

    await expect(createInvokeTransport(shell.invoke).call('load_boot', {})).rejects.toThrow(
      /The ledger file could not answer load_boot: no ledger is open/
    );
  });

  it('does not describe a refusal as a transport failure', async () => {
    // The `try` holds the invoke and nothing else. If it held `readEnvelope`
    // too, every refusal in the product would reach the user wearing this
    // module's words instead of the ledger's.
    const shell = shellAnswering(() => ({
      ok: false,
      error: { code: 'wipe_not_confirmed', message: 'Type DELETE EVERYTHING to confirm.' }
    }));

    await expect(
      createInvokeTransport(shell.invoke).call('wipe_user_financial_data', {})
    ).rejects.toThrow('Type DELETE EVERYTHING to confirm.');
    await expect(
      createInvokeTransport(shell.invoke).call('wipe_user_financial_data', {})
    ).rejects.not.toThrow(/could not answer/);
  });

  it('reports an answer that is not an envelope as a broken transport', async () => {
    // An unparseable answer is not a no. Both transports read the envelope with
    // the same function, so both say this the same way.
    const shell = shellAnswering(() => ({ rows: [] }));

    await expect(createInvokeTransport(shell.invoke).call('list_budgets', {})).rejects.toThrow(
      /was not in the \{ok,…\} envelope/
    );
  });

  it('drives a real port end to end, so the two halves are known to fit', async () => {
    const shell = shellAnswering(() => ({
      ok: true,
      result: { answer: { accounts: [] } }
    }));

    const port = new LocalDataPort({
      owner: OWNER,
      transport: createInvokeTransport(shell.invoke),
      logger: silent
    });

    await expect(port.listAccounts()).resolves.toEqual([]);
  });
});
