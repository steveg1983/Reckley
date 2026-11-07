/**
 * THE WINDOW, RENDERED — with a ledger behind it, and the app's own pages in it.
 *
 * Every other check in this edition is about ABSENCE. `desktopEntry.cloudFree`
 * walks the graph and finds no cloud; `desktop:greps` reads the built renderer
 * and finds no cloud; `editionAliases` proves the halves are substitutable;
 * `desktopRouter` proves every web address has a desktop answer. All four would
 * pass with equal enthusiasm on a window that renders a blank page, and until
 * the mount's second half that was very nearly what a window did.
 *
 * This is the one that asserts PRESENCE. It opens a ledger, mounts
 * `MountedLedger`, and reads the money off the screen.
 *
 * ── HOW REAL IT IS, EXACTLY ─────────────────────────────────────────────────
 *
 * Real: `DesktopApp`, `bootDeviceLedger`, `openDeviceDocument`, `LocalDataPort`,
 * the crate's wire protocol, `deviceIdentity`, the preferences service over the
 * ledger's own transport, `AppContextSupabase` (the actual one — see
 * `setup.desktop.ts`), all seven seams resolved at their DEVICE halves by
 * `vitest.desktop.config.ts`, `components/Layout`, the router, and the pages.
 *
 * Not real: the crate. The ledger below is a fixture that answers the wire
 * protocol rather than a `.db` file, because the alternative needs a Rust
 * toolchain and this needs to run in the same two seconds as the renderer build.
 * What the crate does with a file is the subject of 468 Rust tests, a 127-case
 * contract suite and two nightly differential lanes; none of them can tell you
 * whether the dashboard renders.
 *
 * ── WHY jsdom AND NOT THE APP SUITE ─────────────────────────────────────────
 *
 * `vitest.config.ts` maps every seam at its CLOUD half and replaces
 * `AppContextSupabase` with a fixture provider for every test in the run. A
 * version of this file living there would render the shared pages over
 * `DataService`, prove nothing about a window, and pass on the day the desktop
 * build broke. `vitest.desktop.config.ts` exists for that one reason.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesktopApp } from '../DesktopApp';
import { AWAITING_THE_MOUNT, DESKTOP_ROUTES, NEVER_ON_A_DESKTOP } from '../routes';
import type { Invoke } from '../../services/local/coreTransport';

const OWNER = '11111111-1111-1111-1111-111111111111';
const LEDGER = { path: '/Users/somebody/Household.db', owner: OWNER };

const CURRENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const SAVINGS = 'aaaaaaaa-0000-4000-8000-000000000002';
const DEALING = 'aaaaaaaa-0000-4000-8000-000000000003';

/**
 * A ledger with money in it, in the crate's own row shapes.
 *
 * snake_case, money as a fixed two-place STRING (the crate refuses a JSON
 * number — `money.rs`'s `amount_must_be_a_string`), dates as `YYYY-MM-DD`,
 * booleans as booleans. These go through the real `mappers/` on the way in, so
 * a fixture in the app's shapes would be testing nothing.
 */
const ACCOUNTS = [
  {
    id: CURRENT,
    name: 'Everyday Current',
    type: 'current',
    // 1000.00 opening + 2400.00 − 64.30 − 885.45. The app derives every balance
    // from the opening figure and the rows, so a fixture whose stored balance
    // disagreed would be a fixture testing arithmetic nobody performs.
    balance: '2450.25',
    currency: 'GBP',
    institution: 'A Bank',
    is_active: true,
    initial_balance: '1000.00'
  },
  {
    id: SAVINGS,
    name: 'Rainy Day Savings',
    type: 'savings',
    // 8000.00 opening + 300.00.
    balance: '8300.00',
    currency: 'GBP',
    institution: 'A Bank',
    is_active: true,
    initial_balance: '8000.00'
  },
  {
    id: DEALING,
    name: 'Dealing Account',
    type: 'investment',
    // No transactions, so the ledger figure is the opening balance. The MARKET
    // view below is a second opinion about the same money and the page must
    // never add the two — `investmentService.ts` states that rule and
    // `utils/portfolioSummary` keeps it.
    balance: '5000.00',
    currency: 'GBP',
    institution: 'A Broker',
    is_active: true,
    initial_balance: '5000.00'
  }
];

/**
 * One position, in the crate's own row shape.
 *
 * The three figures that are NOT money are eight-place decimal STRINGS, which is
 * what `numeric(20,8)::text` prints and what `crate::scaled` renders — 100 units
 * at £32.775, which the file stores as `quantity_e8` and `purchase_price_e8` and
 * this fixture writes the way a verb answers. `cost_basis` is money at two
 * places and is DERIVED by whichever engine wrote the row (100 × 32.775 =
 * 3277.50), never stated by a caller.
 *
 * `market_value` is deliberately absent: no engine stores one, because a stored
 * copy of quantity × price goes stale the moment the price does. The screen
 * computes it, through the same `toHolding` the signed-in page uses.
 */
const INVESTMENTS = [
  {
    id: 'inv-1',
    account_id: DEALING,
    symbol: 'AAAA.L',
    name: 'A Listed Company plc',
    asset_type: 'stock',
    currency: 'GBP',
    quantity: '100.00000000',
    cost_basis: '3277.50',
    current_price: '40.00000000',
    purchase_date: '2024-06-01',
    purchase_price: '32.77500000',
    last_updated: '2026-08-11T16:35:00.000Z',
    notes: null
  }
];

const CATEGORIES = [
  { id: 'cat-income', name: 'Income', type: 'income', level: 'type', is_active: true },
  { id: 'cat-expense', name: 'Expense', type: 'expense', level: 'type', is_active: true },
  {
    id: 'cat-groceries',
    name: 'Groceries',
    type: 'expense',
    level: 'sub',
    parent_id: 'cat-expense',
    is_active: true
  },
  {
    id: 'cat-salary',
    name: 'Salary',
    type: 'income',
    level: 'sub',
    parent_id: 'cat-income',
    is_active: true
  }
];

const TRANSACTIONS = [
  {
    id: 'txn-1',
    account_id: CURRENT,
    amount: '2400.00',
    date: '2025-01-05',
    description: 'Monthly Salary',
    category: 'cat-salary',
    type: 'income',
    is_cleared: true
  },
  {
    id: 'txn-2',
    account_id: CURRENT,
    amount: '-64.30',
    date: '2025-01-08',
    description: 'Bramley Market',
    category: 'cat-groceries',
    type: 'expense',
    is_cleared: true
  },
  {
    id: 'txn-3',
    account_id: CURRENT,
    amount: '-885.45',
    date: '2025-01-12',
    description: 'Rent To Landlord',
    category: 'cat-expense',
    type: 'expense',
    is_cleared: false
  },
  {
    id: 'txn-4',
    account_id: SAVINGS,
    amount: '300.00',
    date: '2025-01-15',
    description: 'Standing Order In',
    category: 'cat-income',
    type: 'income',
    is_cleared: true
  }
];

/**
 * The shell and the ledger, as one fake `invoke`.
 *
 * It records the verbs in the order the application asks for them, which is
 * what proves the ordering rule that `bootDeviceLedger` used to hold on its own
 * (see that function's note): the seed must land before the boot reads, and
 * those two calls are now made by two different modules.
 */
const ledgerShell = (): { invoke: Invoke; verbs: string[] } => {
  const verbs: string[] = [];
  const invoke: Invoke = async (command, args) => {
    if (command === 'current_ledger') return null;
    if (command === 'open_ledger' || command === 'create_ledger') return LEDGER;

    const verb = String((args as Record<string, unknown>).verb);
    verbs.push(verb);
    const answer = (payload: Record<string, unknown>): unknown => ({
      ok: true,
      result: { answer: payload }
    });

    switch (verb) {
      case 'seed_categories':
        return answer({ categories: CATEGORIES });
      case 'load_boot':
        return answer({
          accounts: ACCOUNTS,
          categories: CATEGORIES,
          transactions: TRANSACTIONS,
          transaction_splits: [],
          budgets: [],
          goals: []
        });
      case 'list_accounts':
        return answer({ accounts: ACCOUNTS });
      case 'list_transactions':
        return answer({ transactions: TRANSACTIONS });
      case 'list_transaction_splits':
        return answer({ transaction_splits: [] });
      case 'list_investments':
        return answer({ investments: INVESTMENTS });
      case 'user_financial_data_is_empty':
        return answer({ empty: false });
      case 'account_balances':
        return answer({
          account_balances: [
            { account_id: CURRENT, balance: '2450.25', as_of: '2025-01-20' },
            { account_id: SAVINGS, balance: '8300.00', as_of: '2025-01-20' },
            { account_id: DEALING, balance: '5000.00', as_of: '2025-01-20' }
          ]
        });
      case 'read_preferences':
        return answer({ preferences: null });
      default:
        return answer({});
    }
  };
  return { invoke, verbs };
};

/**
 * How long a PAGE is allowed to take to appear.
 *
 * Generous, and not a flake-hiding number: each of these renders a whole lazy
 * page graph — the Dashboard's is 131 modules — through Vite's on-the-fly
 * transform, with no cache on a first run. The default second is a measurement
 * of the toolchain, not of the product.
 */
const PAGE = { timeout: 20_000 };

/**
 * ONE shell for the whole file, and that is a property of the edition rather
 * than a convenience.
 *
 * `services/local/deviceDataPort.ts` resolves `export const dataPort =
 * requireDeviceDocument().port` at MODULE SCOPE, and it says why at length: the
 * app's consumers import a singleton, which is not a shape that can wait, so the
 * ordering rule is stated instead — *"the application's module graph is loaded
 * after the ledger is open"*. One consequence is that the FIRST document a
 * process opens is the one every `@data` consumer holds for the life of that
 * process, and a test file is a process.
 *
 * A second shell per case would therefore give the state layer case one's
 * ledger and the boot case two's, which is not a thing a window can do — a
 * window that opens a second file reloads. So: one shell, one fixture, one
 * accumulating list of verbs.
 */
const SHELL = ledgerShell();

/** Open the fixture ledger and wait for the app to be up. */
const openTheLedger = async (at = '#/'): Promise<void> => {
  window.location.hash = at;
  render(<DesktopApp invoke={SHELL.invoke} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Open a ledger…' }));
};

describe('the desktop window, with a ledger open', () => {
  it('opens a file from the chooser and mounts the application over it', async () => {
    await openTheLedger();

    // The frame. Its nav is the same `components/Layout` the web app draws, and
    // it is the thing slice 29 could not mount at all.
    expect(await screen.findByRole('navigation', { name: /main/i }, PAGE)).toBeInTheDocument();
    // The index screen: the ledger's own counts, read out of `useApp()` rather
    // than out of a boot snapshot fetched specially for it.
    expect(await screen.findByText(/3 accounts, 4 transactions, 4 categories/, {}, PAGE)).toBeInTheDocument();
    // …and the sentence that is only true of a device.
    expect(screen.getByText(/This file is the only copy/)).toBeInTheDocument();

    // AND THE ORDERING RULE, in the same case because it is about the same
    // first boot. `localDataPort.ts` states it — *"must `await
    // port.prepareCategories()` before `port.loadBoot()`"* — and until the mount
    // it was two lines of `bootDeviceLedger` with a unit test on them. It is now
    // split between the window's open (`seed_categories`) and the state layer's
    // boot (`load_boot`), so this is the only place the real sequence exists.
    //
    // Not `verbs[0]`: the settings attach is STARTED first so its crossing
    // overlaps the seed rather than delaying it (`bootDeviceLedger` argues that
    // at length), so `read_preferences` is legitimately in front of both.
    expect(SHELL.verbs).toContain('seed_categories');
    expect(SHELL.verbs.indexOf('seed_categories')).toBeLessThan(
      SHELL.verbs.indexOf('load_boot')
    );
  });

  it('renders the DASHBOARD against the file’s own money', async () => {
    await openTheLedger('#/dashboard');
    // £1,450.25 + £8,300.00. Formatted by the shared `formatCurrency`, from
    // rows the real LocalDataPort parsed out of the crate's money strings.
    // £2,450.25 + £8,300.00 + £5,000.00, each derived from an opening balance
    // and the rows, every figure of which came out of the crate's money STRINGS
    // through the real mappers. Formatted by the shared `formatCurrency`.
    expect((await screen.findAllByText('£15,750.25', {}, PAGE)).length).toBeGreaterThan(0);
    expect(screen.getAllByText('£2,450.25').length).toBeGreaterThan(0);
    expect(screen.getAllByText('£8,300.00').length).toBeGreaterThan(0);
  });

  it('renders ACCOUNTS, with both of the file’s accounts', async () => {
    await openTheLedger('#/accounts');

    expect(await screen.findByText('Everyday Current', {}, PAGE)).toBeInTheDocument();
    expect(screen.getByText('Rainy Day Savings')).toBeInTheDocument();
    // The bank feed is absent, not broken: `@service`'s device half answers no
    // connections, so the page's own `connectedCount > 0` guard hides the
    // button. Not one line of `pages/Accounts.tsx` knows which edition it is in.
    expect(screen.queryByRole('button', { name: /refresh feeds/i })).toBeNull();
  });

  it('renders the REGISTER for one account, with its rows', async () => {
    await openTheLedger(`#/accounts/${CURRENT}`);

    // `getAllBy…`: the register draws a row for a wide viewport and a card for
    // a narrow one, and jsdom has both in the document at once.
    expect((await screen.findAllByText('Monthly Salary', {}, PAGE)).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Bramley Market').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Rent To Landlord').length).toBeGreaterThan(0);
    // The other account's row is not in this register.
    expect(screen.queryByText('Standing Order In')).toBeNull();
  });

  it('renders INVESTMENTS, with the file’s own holding priced', async () => {
    await openTheLedger('#/investments');

    // The Portfolio tab is where the MARKET view lives — holdings × price, which
    // the page keeps deliberately apart from the ledger figures on Overview.
    // `investmentService.ts` states the rule the separation exists for: the two
    // are a second opinion about the same money and adding them counts it twice.
    await userEvent.click(await screen.findByRole('button', { name: /portfolio/i }, PAGE));

    // The holding reaches the screen through `dataPort.listInvestments()` — the
    // route slice 30 could not mount, because this page called
    // `services/api/investmentService`, and a Supabase client with it, directly.
    expect(await screen.findAllByText(/A Listed Company plc/, {}, PAGE)).not.toHaveLength(0);
    // 100 units × £40.00. NOT a stored figure: no engine keeps a market value,
    // and this one was computed by the same `toHolding` the signed-in page uses,
    // out of two EIGHT-PLACE decimal strings the crate answered with. A holding
    // whose quantity had gone through a `number` on the way here would not
    // arrive at this figure by accident.
    expect(screen.getAllByText('£4,000.00').length).toBeGreaterThan(0);
  });

  it('renders ENHANCED IMPORT, whose restore dialog no longer describes a browser', async () => {
    await openTheLedger('#/enhanced-import');

    expect(await screen.findAllByRole('heading', { name: /import/i }, PAGE)).not.toHaveLength(0);
  });

  it('renders SETTINGS ▸ DATA, which is where the delete-everything button lives', async () => {
    await openTheLedger('#/settings/data');

    // The page `routes.ts` named as the thing that came WITH the restore
    // dialog: *"this is where `dataPort.wipeAllFinancialData` is called from, so
    // until the restore dialog is answered, a desktop window has no
    // delete-everything button."* It has one now.
    expect(await screen.findAllByText(/clear all data/i, {}, PAGE)).not.toHaveLength(0);
  });

  it('tells a device the truth about what its own file can keep', async () => {
    // THE BUG THIS SLICE FIXED, asserted from the window rather than from a
    // unit test. The restore preview used to read `LOCAL_BACKUP_BINDINGS` — a
    // description of the BROWSER's store — whenever `backupTarget !== 'login'`,
    // which a device matches. It now asks `capabilities().cannotKeep`, and a
    // file keeps all fourteen tables, so there is nothing to warn about.
    //
    // Asserted as an ABSENCE with the specific words, because the false warning
    // named the tables it was wrong about.
    await openTheLedger('#/settings/data');
    await screen.findAllByText(/clear all data/i, {}, PAGE);

    expect(screen.queryByText(/cannot be restored/i)).toBeNull();
    expect(screen.queryByText(/only tracked when you are signed in/i)).toBeNull();
  });

  it('renders REPORTS', async () => {
    await openTheLedger('#/reports');
    expect((await screen.findAllByRole('heading', { name: /reports/i }, PAGE)).length)
      .toBeGreaterThan(0);
  });

  it('renders CUSTOM REPORTS, at its own address, with nothing sold on it', async () => {
    // The route that moved out of `NEVER_ON_A_DESKTOP` — `routes.ts` carries the
    // argument. Asserted from the window because the old exclusion was never
    // enforced in one: the hub's registry imports this page directly, so it was
    // reachable at `#/reports/custom-reports` the whole time it was listed as
    // never coming. This is the address it now answers at honestly.
    await openTheLedger('#/custom-reports');

    expect(await screen.findByRole('heading', { name: /custom reports/i }, PAGE))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create report/i })).toBeInTheDocument();

    // The web route is wrapped in a `ProtectedSuspense requirePremium`. There is
    // no such wrapper here and nothing for one to talk to, so the page arrives
    // without an upgrade prompt attached — the local edition's buyer is on the
    // only tier this build has.
    expect(screen.queryByText(/upgrade/i)).toBeNull();
    expect(screen.queryByText(/premium/i)).toBeNull();
  });

  it('names the window after Custom reports, not after the hub', async () => {
    // `DesktopRoute.title` is load-bearing: a window has no tab strip, so this
    // is the only place it can say which screen is showing. The hub's own routes
    // are titled 'Reports', and a title of 'Reports' here would mean the manifest
    // entry had been copied rather than written.
    await openTheLedger('#/custom-reports');
    await screen.findByRole('heading', { name: /custom reports/i }, PAGE);

    await waitFor(() => expect(document.title).toBe('Custom reports'));
  });

  it('renders SETTINGS with no billing card and no sign-out in it', async () => {
    await openTheLedger('#/settings');

    // The page is the same `pages/Settings.tsx` the web app serves.
    expect(await screen.findByRole('heading', { name: /^settings$/i }, PAGE)).toBeInTheDocument();
    // And `@service`'s device half is why there is no subscription on it. The
    // web version renders a plan, a renewal date and a link to Stripe's portal
    // in a card at the top of exactly this page.
    expect(screen.queryByText(/subscription/i)).toBeNull();
    expect(screen.queryByText(/upgrade/i)).toBeNull();
    // Same seam, same page, second member: the web build grew a plainly
    // labelled "Sign out" here because the only other one was an unlabelled
    // avatar nobody could find. This edition has no sign-in to undo — there is
    // no ClerkProvider in this build — so the panel renders nothing at all
    // rather than a disabled button or an apology.
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
    expect(screen.queryByText(/Signed in/i)).toBeNull();
  });

  it('says on SETTINGS the version tauri.conf.json names — the number the About box shows', async () => {
    // It said "Version 1.0" until 7 Nov 2026, as literal text, beside a native
    // About box saying 0.1.6. This run borrows the renderer build's own
    // `define` (vitest.desktop.config.ts), so the number asserted is the one the
    // shipped window is stamped with, not one this test restated.
    const { version } = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')
    ) as { version: string };
    await openTheLedger('#/settings');

    expect(await screen.findByText(`Version ${version}`, {}, PAGE)).toBeInTheDocument();
    expect(screen.queryByText('Version 1.0')).toBeNull();
  });

  it('renders EXPORT with CSV and PDF, and no Excel anywhere on it', async () => {
    // THE OWNER'S RULING OF 1 SEP 2026, from the window rather than from a
    // bundle: *"Lose excel is fine as long as they can keep csv."*
    //
    // Everything else about the eviction is an absence measured in bytes — a
    // grep over the built renderer, a walk over the import graph, a size
    // ratchet. All three pass on a page that renders nothing at all, and none of
    // them can say whether a person who came here for a spreadsheet leaves with
    // one. This is that question.
    await openTheLedger('#/export-manager');

    // PDF and CSV are both still offered, by their own labels in the format
    // dropdown — an assertion that comes FIRST, because "no Excel" is satisfied
    // by an export page with no formats on it at all.
    expect(await screen.findByRole('option', { name: /PDF document/i }, PAGE)).toBeInTheDocument();
    const csv = screen.getByRole('option', { name: /CSV spreadsheet/i });
    // …and the CSV option carries the sentence that replaces the button: nothing
    // was taken away, the same file opens in the same program.
    expect(csv).toHaveTextContent(/opens in Excel/i);

    // ABSENT, not disabled. The Excel Export button and the Advanced Export
    // modal's Excel tile are both drawn behind `CAN_EXPORT_SPREADSHEETS`, which
    // is the same import that decides whether SheetJS is in this build — so the
    // button and the bundle cannot disagree.
    expect(screen.queryByRole('button', { name: /excel export/i })).toBeNull();
    // Nor the page's own headline copy, which used to promise "export to Excel".
    expect(screen.queryByText(/export to Excel/i)).toBeNull();

    // The report builder is on this page too, and it keeps PDF and CSV.
    await userEvent.click(screen.getByRole('button', { name: /advanced export/i }));
    expect(await screen.findByText('CSV', {}, PAGE)).toBeInTheDocument();
    expect(screen.getByText('PDF')).toBeInTheDocument();
    expect(screen.queryByText('Excel')).toBeNull();
    expect(screen.getByText('Opens in Excel')).toBeInTheDocument();
  });

  it('names the window after the screen, because a window has no tab strip', async () => {
    await openTheLedger('#/accounts');
    await screen.findByText('Everyday Current', {}, PAGE);

    await waitFor(() => expect(document.title).toBe('Accounts'));
  });

  it('sends an address it does not serve home rather than nowhere', async () => {
    // `open-banking` is `NEVER_ON_A_DESKTOP`. In a browser it is a page; here
    // the router has no such route, so the catch-all takes it.
    await openTheLedger('#/open-banking');

    expect(await screen.findByText(/3 accounts, 4 transactions/, {}, PAGE)).toBeInTheDocument();
    expect(screen.queryByText(/connect your bank/i)).toBeNull();
  });

  it('would notice — a window with no ledger renders no application at all', async () => {
    // The complement of every assertion above, and the guard on the ordering
    // rule `deviceDataPort.ts` states: the app's module graph is imported after
    // the ledger is open. A chooser that had already pulled `MountedLedger` in
    // would have thrown on `requireDeviceDocument()` before this rendered.
    const pending: Invoke = () => new Promise(() => {});
    render(<DesktopApp invoke={pending} />);

    expect(await screen.findByRole('button', { name: 'Open a ledger…' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /main/i })).toBeNull();
  });
});

describe('the manifest, against what is actually mounted', () => {
  it('mounts every route it says it mounts, and nothing it says it does not', () => {
    // `desktopRouter.test.tsx` holds the manifest against `src/App.tsx`. This
    // holds it against the ROUTER, which is the other half: a path can only be
    // served here by being in DESKTOP_ROUTES, because `MountedLedger` maps over
    // it and the compiler requires a screen for each entry.
    const mounted = new Set(DESKTOP_ROUTES.map(route => route.path));
    for (const gate of NEVER_ON_A_DESKTOP) expect(mounted.has(gate.path)).toBe(false);
    for (const owed of AWAITING_THE_MOUNT) expect(mounted.has(owed.path)).toBe(false);
  });

  it('was measured with a real fixture, not an empty one', () => {
    // The assertions above are all satisfied by a ledger of nothing rendering
    // nothing. This is the arm that says the fixture has money in it.
    expect(ACCOUNTS).toHaveLength(3);
    expect(TRANSACTIONS).toHaveLength(4);
    expect(TRANSACTIONS.every(row => typeof row.amount === 'string')).toBe(true);
    // And the holding's three non-money figures are eight-place decimal
    // STRINGS, which is what the crate answers and what makes the market view
    // below a test of the real mapper rather than of a convenient object.
    expect(INVESTMENTS).toHaveLength(1);
    expect(INVESTMENTS[0].quantity).toBe('100.00000000');
    expect(INVESTMENTS[0].current_price).toBe('40.00000000');
  });
});

// A window is not a browser tab: nothing here should be reaching for one.
vi.mock('@clerk/clerk-react', () => {
  throw new Error(
    'A desktop mount test resolved @clerk/clerk-react. Nothing in this build may import it — ' +
      'see src/desktop/__tests__/editionWalk.ts.'
  );
});
