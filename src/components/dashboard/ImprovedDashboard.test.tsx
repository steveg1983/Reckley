/**
 * The dashboard's four claims about itself:
 *
 *  - every "Needs Your Attention" row says WHY, on screen and to a screen
 *    reader, in the same words (they used to be written by two different rules,
 *    and the on-screen half went blank for any threshold but £500);
 *  - the account picker can start from everything or from nothing;
 *  - the whole page reads over ONE period, declared once under the heading;
 *  - it ends in figures, not in a second copy of the navigation.
 *
 * Every account name, figure and institution here is invented.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ImprovedDashboard } from './ImprovedDashboard';
import { preferences } from '../../services/preferencesService';
import type { Account, Transaction } from '../../types';
import type { BankConnection } from '../../services/bankConnectionService';
import type { PeriodRange, UsePeriodResult } from '../../hooks/usePeriod';

const USER_ID = 'user_testonly_0001';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  app: {
    accounts: [] as Account[],
    transactions: [] as Transaction[],
    transactionSplits: [],
    budgets: [],
    categories: [],
    // The dashboard's report picker lists these inline, so the context has to
    // answer with an array rather than with nothing. They arrive in the boot
    // snapshot now; until slice 32 this surface read localStorage during render,
    // which is what the removed `customReportService` mock stood in for.
    customReports: [],
    serverBalances: new Map<string, { balance: number; txnCount: number }>(),
    isLoading: false,
  },
  connections: [] as BankConnection[],
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ userId: USER_ID, isSignedIn: true, getToken: vi.fn(), signOut: vi.fn() }),
  useUser: () => ({ user: null, isLoaded: true }),
  useSession: () => ({ session: null }),
}));

vi.mock('../../contexts/AppContextSupabase', () => ({ useApp: () => mocks.app }));

vi.mock('../../hooks/useCurrencyDecimal', () => ({
  useCurrencyDecimal: () => ({
    formatCurrency: (amount: number) => `£${Number(amount).toFixed(2)}`,
    displayCurrency: 'GBP',
  }),
}));

vi.mock('../../hooks/useBankConnectionSnapshot', () => ({
  useBankConnectionSnapshot: () => mocks.connections,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    useLocation: () => ({ pathname: '/dashboard', search: '', hash: '', state: null, key: 'test' }),
    // The FirstSteps card (26 Aug) renders real <Link>s, which need router
    // CONTEXT the hook mocks above do not provide. A stub that renders the
    // anchor keeps this harness router-free while the hrefs stay assertable.
    Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
      <a href={to} {...rest}>{children}</a>
    ),
  };
});

// The widgets' own maths is tested where it lives; here they only have to
// report the window they were handed, so the two pickers can be told apart.
const describeRange = (range: PeriodRange): string =>
  `${range.from ? range.from.toISOString().slice(0, 10) : 'none'}..${range.to ? range.to.toISOString().slice(0, 10) : 'none'}`;

// The widgets are handed the whole picker, not just its resolved bounds: the
// window they draw AND the window their click-through carries have to be the
// same one, and two props saying nearly the same thing is how they drift.
vi.mock('./reportWidgets/DashboardReportWidgets', () => ({
  NetWorthWidget: ({ picker }: { picker: UsePeriodResult }) => (
    <div data-testid="net-worth-widget">{describeRange(picker.range)}</div>
  ),
  IncomeExpenseTrendWidget: ({ picker }: { picker: UsePeriodResult }) => (
    <div data-testid="income-expense-widget">{describeRange(picker.range)}</div>
  ),
  ExpenseCategoriesWidget: ({ picker }: { picker: UsePeriodResult }) => (
    <div data-testid="expense-categories-widget">{describeRange(picker.range)}</div>
  ),
  CustomReportWidget: () => <div data-testid="custom-report-widget" />,
}));

vi.mock('../charts/DashboardCharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PieChart: () => <div data-testid="pie-chart" />,
  BarChart: () => <div data-testid="bar-chart" />,
}));

vi.mock('../EditTransactionModal', () => ({ default: () => null }));
vi.mock('../reports/ReportDrillModal', () => ({
  default: ({ target }: { target: { title: string; rows: { id: string }[]; total: number | null } | null }) =>
    target ? (
      <div data-testid="budget-drill">
        <span data-testid="budget-drill-title">{target.title}</span>
        <span data-testid="budget-drill-rows">{target.rows.map(row => row.id).join(',')}</span>
        <span data-testid="budget-drill-total">{String(target.total)}</span>
      </div>
    ) : null,
}));
vi.mock('../IncomeExpenseBreakdownModal', () => ({ default: () => null }));
vi.mock('../common/Modal', () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
  ModalBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const account = (over: Partial<Account> & { id: string; name: string }): Account => ({
  type: 'current',
  balance: 0,
  currency: 'GBP',
  lastUpdated: new Date('2026-05-01T00:00:00.000Z'),
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  mocks.navigate.mockReset();
  mocks.app.accounts = [];
  mocks.app.transactions = [];
  mocks.app.isLoading = false;
  mocks.connections = [];
});

describe('Needs Your Attention', () => {
  const armed = account({
    id: 'acc-a',
    name: 'Feed Account A',
    openingBalance: 12.5,
    lowBalanceAlertEnabled: true,
    // Anything but the £500 the row's old label hard-coded.
    lowBalanceThreshold: 250,
  });

  it('states a reason on every row, and repeats it to a screen reader', () => {
    mocks.app.accounts = [
      armed,
      // A card IN CREDIT: nothing owed, nothing to warn about.
      account({ id: 'card-1', name: 'Sample Card', type: 'credit', creditLimit: 1000, openingBalance: 400 }),
    ];

    render(<ImprovedDashboard />);

    const rows = screen.getAllByTestId('attention-row');
    expect(rows).toHaveLength(1);

    const reason = 'Down to £12.50 — below the £250.00 you asked to be warned at.';
    expect(within(rows[0]).getByText(reason)).toBeInTheDocument();
    expect(rows[0].getAttribute('aria-label')).toContain(reason);
    expect(rows[0].getAttribute('aria-label')).toContain('Feed Account A');
    // The action is named, not left to a bare chevron.
    expect(within(rows[0]).getByText('Open register')).toBeInTheDocument();
  });

  it('sends a low-balance row to that account, and a broken feed to the feeds', () => {
    mocks.app.accounts = [armed, account({ id: 'acc-b', name: 'Feed Account B' })];
    mocks.connections = [{
      id: 'conn-1',
      provider: 'truelayer',
      institutionId: 'inst-1',
      institutionName: 'Sample Bank',
      status: 'reauth_required',
      lastSync: new Date(Date.now() - 72 * 60 * 60 * 1000),
      accounts: [],
      linkedAccountIds: ['acc-b'],
    }];

    render(<ImprovedDashboard />);

    const rows = screen.getAllByTestId('attention-row');
    expect(rows).toHaveLength(2);

    fireEvent.click(rows[0]);
    expect(mocks.navigate).toHaveBeenLastCalledWith('/accounts/acc-a');

    expect(rows[1].getAttribute('aria-label')).toContain('needs you to sign in again');
    fireEvent.click(rows[1]);
    expect(mocks.navigate).toHaveBeenLastCalledWith('/open-banking');
  });

  it('is a region that waits its turn, not an alert that interrupts', () => {
    mocks.app.accounts = [armed];
    render(<ImprovedDashboard />);

    const region = screen.getByRole('region', { name: 'Needs Your Attention' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says nothing while the transactions are still arriving', () => {
    // Until they land every balance is just its opening balance, so an
    // alert-armed account would flash onto the list and off it again.
    mocks.app.accounts = [armed];
    mocks.app.isLoading = true;

    render(<ImprovedDashboard />);

    expect(screen.queryByTestId('attention-row')).not.toBeInTheDocument();
    expect(screen.queryByText('Needs Your Attention')).not.toBeInTheDocument();
  });
});

describe('Key Account Balances — select all / clear all', () => {
  beforeEach(() => {
    mocks.app.accounts = [
      account({ id: 'acc-a', name: 'Feed Account A', openingBalance: 100 }),
      account({ id: 'acc-b', name: 'Feed Account B', type: 'savings', openingBalance: 200 }),
      account({ id: 'acc-c', name: 'Feed Account C', type: 'credit', openingBalance: -50 }),
    ];
  });

  const openPanel = (): void => {
    fireEvent.click(screen.getByLabelText('Customise displayed accounts'));
  };

  it('takes every listed account in one click', () => {
    localStorage.setItem('dashboardKeyAccounts', JSON.stringify([]));
    render(<ImprovedDashboard />);
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));

    expect(screen.getAllByTestId('account-balance-card')).toHaveLength(3);
    expect(JSON.parse(localStorage.getItem('dashboardKeyAccounts') ?? '[]').sort())
      .toEqual(['acc-a', 'acc-b', 'acc-c']);
  });

  it('empties the choice without breaking the widget', () => {
    localStorage.setItem('dashboardKeyAccounts', JSON.stringify(['acc-a', 'acc-b', 'acc-c']));
    render(<ImprovedDashboard />);
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    expect(screen.queryByTestId('account-balance-card')).not.toBeInTheDocument();
    // A SELECTION IS A FILTER, so the panel says what it is hiding and how
    // much of it, rather than pointing at a settings icon (DESIGN_PASS §4).
    expect(
      screen.getByRole('heading', { level: 3, name: 'No accounts are selected for the dashboard' })
    ).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('the dashboard’s account selection')).toBeInTheDocument();
    expect(localStorage.getItem('dashboardKeyAccounts')).toBe('[]');
  });

  it('offers one control that brings every account back, and it does', () => {
    localStorage.setItem('dashboardKeyAccounts', JSON.stringify([]));
    render(<ImprovedDashboard />);

    expect(screen.queryByTestId('account-balance-card')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all accounts' }));

    expect(screen.getAllByTestId('account-balance-card')).toHaveLength(3);
  });

  it('a dashboard with no accounts AT ALL is a different state from one with none selected', () => {
    mocks.app.accounts = [];
    mocks.app.isLoading = false;
    render(<ImprovedDashboard />);

    // The first run: what this panel will hold, and the control that starts it
    // — never the selection sentence, which would send a brand-new user
    // hunting for accounts to tick that do not exist.
    expect(screen.getByRole('heading', { level: 3, name: 'No accounts yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Account' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'No accounts are selected for the dashboard' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show all accounts' })).not.toBeInTheDocument();
  });
});

/**
 * ONE clock for the page.
 *
 * This block used to be called "two columns, two clocks" and pinned the
 * opposite arrangement: a period control per column of the reports box, plus a
 * third on Performance, each governing only what it sat beside. Three
 * identically-styled controls meant none of them declared its scope, so the
 * design pass collapsed them into a single page-level bar under the heading
 * (DESIGN_PASS_2026-08 §3.4, whose stated test exposure is exactly this).
 *
 * What is asserted here is therefore the inverse of what it was, and
 * deliberately so: the page has one period, everything below the bar obeys it,
 * and the storage key it remembers survived the merge.
 */
describe('the dashboard reads over one period', () => {
  beforeEach(() => {
    mocks.app.accounts = [account({ id: 'acc-a', name: 'Feed Account A', openingBalance: 100 })];
    localStorage.setItem('dashboardPinnedReports', JSON.stringify(['net-worth', 'expense-categories']));
  });

  const periodBar = (): HTMLElement => screen.getByRole('group', { name: 'Period for this dashboard' });

  it('is the only period control on the page', () => {
    render(<ImprovedDashboard />);

    // One control, not one per section. The two the reports box carried were
    // feet apart and identical in style to Performance's.
    expect(screen.getAllByRole('group', { name: /period/i })).toHaveLength(1);
    expect(screen.queryByRole('group', { name: 'Period for net worth reports' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Period for income and spending reports' })).toBeNull();
  });

  it('moves every report on the page together', () => {
    render(<ImprovedDashboard />);

    fireEvent.click(within(periodBar()).getByRole('button', { name: 'All time' }));

    // Both halves of the reports box, on the one window the bar declares.
    expect(screen.getByTestId('net-worth-widget').textContent).toBe('none..none');
    expect(screen.getByTestId('expense-categories-widget').textContent).toBe('none..none');

    fireEvent.click(within(periodBar()).getByRole('button', { name: 'Last month' }));

    const lastMonth = screen.getByTestId('net-worth-widget').textContent;
    expect(lastMonth).not.toBe('none..none');
    expect(screen.getByTestId('expense-categories-widget').textContent).toBe(lastMonth);
    expect(within(periodBar()).getByRole('button', { name: 'Last month' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('remembers the choice under the key the page has always used', () => {
    render(<ImprovedDashboard />);

    fireEvent.click(within(periodBar()).getByRole('button', { name: 'All time' }));

    expect(localStorage.getItem('dashboardReports')).toBe('all');
  });

  it('opens on a choice made before the three controls became one', () => {
    // The merge keeps the original storage key rather than minting a new one,
    // so nobody's stored dashboard moves underneath them.
    localStorage.setItem('dashboardReports', 'all');
    localStorage.setItem('dashboardReportsExplicit', 'true');

    render(<ImprovedDashboard />);

    expect(within(periodBar()).getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('net-worth-widget').textContent).toBe('none..none');
    expect(screen.getByTestId('expense-categories-widget').textContent).toBe('none..none');
  });

  it('keeps the account distribution beside the reports, on today’s figures', () => {
    render(<ImprovedDashboard />);

    const reports = screen.getByRole('region', { name: 'Your Reports' });
    expect(within(reports).getByText('Account Distribution')).toBeInTheDocument();
    // Stated, because the period pills above it do not govern it.
    expect(within(reports).getByText('Current balances')).toBeInTheDocument();
  });

  /**
   * The card used to be the only one of the four with no way into a full
   * report — the other three opened theirs from the title.
   */
  it('opens the full Account Distribution report from its title, saying where it came from', () => {
    render(<ImprovedDashboard />);

    fireEvent.click(screen.getByRole('button', { name: /Account Distribution/ }));

    // No period on the URL: this report states none of its own, and one sent
    // anyway would move the window the NEXT report opens on.
    expect(mocks.navigate).toHaveBeenCalledWith('/reports/account-distribution', {
      state: { from: { path: '/dashboard', label: 'Back to Dashboard' } },
    });
  });

  it('still opens an account’s transactions from its legend row', () => {
    render(<ImprovedDashboard />);

    const legend = screen.getByRole('list', { name: 'Account distribution legend' });
    fireEvent.click(within(legend).getByRole('button', { name: /Feed Account A/ }));

    // Straight into that account's register. It used to open the global list
    // filtered to the account — the same answer one page further away, and
    // that page is retired.
    expect(mocks.navigate).toHaveBeenCalledWith('/accounts/acc-a');
  });
});

/**
 * The page used to close with four 140px tiles — Add Transaction, View
 * Accounts, Set Budget, Reports — each a second door to a room already on
 * screen: the sidebar names all three destinations permanently, and adding a
 * transaction belongs in the register that will hold it. They pushed the
 * figures up a screenful to repeat the navigation, so they are gone.
 *
 * The phone's floating "+" is a different thing and stays; it is pinned in
 * components/__tests__/MobileBottomNav.test.tsx, where it actually lives.
 */
describe('the foot of the dashboard', () => {
  beforeEach(() => {
    mocks.app.accounts = [account({ id: 'acc-a', name: 'Feed Account A', openingBalance: 100 })];
  });

  it('has no quick-action tiles', () => {
    render(<ImprovedDashboard />);

    expect(screen.queryByRole('navigation', { name: 'Quick actions' })).not.toBeInTheDocument();
    for (const label of ['Add a new transaction', 'View all accounts', 'Set up or view budgets', 'View reports']) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('does not carry an add-transaction dialog it can no longer open', () => {
    // The tiles were the only thing that opened it; a modal nobody can reach
    // is dead weight in the dashboard's chunk.
    render(<ImprovedDashboard />);

    expect(screen.queryByText('Add Transaction')).not.toBeInTheDocument();
  });
});

/**
 * THE STORED ORDER IS THE SEATING PLAN (owner, 17 Aug: "move it within that
 * box … like moving an app around on an iPhone screen"). Two things jsdom can
 * prove: the tiles render in the persisted order rather than account-list
 * order, and Alt+arrows re-seat a card and persist the result. The pointer
 * drag itself is geometry (elementFromPoint over a laid-out grid) and is a
 * browser check, named as such.
 */
describe('Key Account Balances — the cards sit where the user put them', () => {
  beforeEach(() => {
    mocks.app.accounts = [
      account({ id: 'acc-a', name: 'Feed Account A', openingBalance: 100 }),
      account({ id: 'acc-b', name: 'Feed Account B', type: 'savings', openingBalance: 200 }),
      account({ id: 'acc-c', name: 'Feed Account C', type: 'credit', openingBalance: -50 }),
    ];
  });

  const cardNames = (): string[] =>
    screen.getAllByTestId('account-balance-card')
      .map(card => within(card).getByText(/Feed Account/).textContent ?? '');

  it('renders the tiles in the STORED order, not the account list order', () => {
    localStorage.setItem('dashboardKeyAccounts', JSON.stringify(['acc-c', 'acc-a', 'acc-b']));
    render(<ImprovedDashboard />);

    expect(cardNames()).toEqual(['Feed Account C', 'Feed Account A', 'Feed Account B']);
  });

  it('Alt+ArrowRight moves a card one seat and persists the new order', () => {
    localStorage.setItem('dashboardKeyAccounts', JSON.stringify(['acc-a', 'acc-b', 'acc-c']));
    render(<ImprovedDashboard />);

    const [first] = screen.getAllByTestId('account-balance-card');
    fireEvent.keyDown(first, { key: 'ArrowRight', altKey: true });

    expect(cardNames()).toEqual(['Feed Account B', 'Feed Account A', 'Feed Account C']);
    expect(JSON.parse(localStorage.getItem('dashboardKeyAccounts') ?? '[]'))
      .toEqual(['acc-b', 'acc-a', 'acc-c']);
  });

  it('a plain arrow key still means what it always meant — only Alt re-seats', () => {
    localStorage.setItem('dashboardKeyAccounts', JSON.stringify(['acc-a', 'acc-b', 'acc-c']));
    render(<ImprovedDashboard />);

    const [first] = screen.getAllByTestId('account-balance-card');
    fireEvent.keyDown(first, { key: 'ArrowRight' });

    expect(cardNames()).toEqual(['Feed Account A', 'Feed Account B', 'Feed Account C']);
  });
});

/**
 * ONE WALK-THROUGH AT A TIME (owner's ruling, 1 Sep 2026).
 *
 * A fresh ledger with a year of statements imported and nothing filed earns BOTH
 * cards: First steps has an unfinished step, and the history guide's hundred-row
 * threshold is met. They then stacked, saying overlapping things in two voices —
 * and the guide's first two steps ARE First steps, with the five that were
 * missing after them. So while the guide is up, First steps stands down.
 *
 * The gate reads the guide's own `useHistoryPath`: ONE definition of "the guide
 * is on screen", consumed by the card that draws it and by the gate that hides
 * its predecessor. What these pin is that supersession, and — just as important
 * — that nothing else about First steps moved.
 *
 * Every figure below is invented; this repo is public.
 */
describe('the history guide supersedes First steps', () => {
  const ENGAGED_PREFERENCE = 'historyPath.engaged.v1';
  const DISMISSED_PREFERENCE = 'historyPath.dismissed.v1';

  /** Rows with no category: unfiled, and so awaiting review. */
  const unfiled = (count: number): Transaction[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `unfiled-${index}`,
      date: new Date('2026-05-02T00:00:00.000Z'),
      description: `Payment ${index}`,
      amount: -12.5,
      type: 'expense' as const,
      accountId: 'acc-a',
      category: '',
    }));

  /** The narrow window: an account, a year of history, nothing filed. */
  const freshImport = (rows: number): void => {
    mocks.app.accounts = [account({ id: 'acc-a', name: 'Feed Account A' })];
    mocks.app.transactions = unfiled(rows);
  };

  beforeEach(() => {
    // Through the service, not the mirror: `localStorage.clear()` above leaves
    // the in-memory document — which is what the card actually reads — alone.
    preferences.removeItem(ENGAGED_PREFERENCE);
    preferences.removeItem(DISMISSED_PREFERENCE);
    preferences.removeItem('firstStepsDismissed');
  });

  afterEach(() => {
    preferences.removeItem(ENGAGED_PREFERENCE);
    preferences.removeItem(DISMISSED_PREFERENCE);
  });

  it('shows the guide and hides First steps when both are earned', () => {
    freshImport(100);
    render(<ImprovedDashboard />);

    expect(screen.getByTestId('history-path')).toBeInTheDocument();
    expect(screen.queryByTestId('first-steps')).not.toBeInTheDocument();
  });

  it('gives First steps back the moment the guide is dismissed mid-journey', () => {
    // The ruling is "while the guide is visible", not "once it has ever been
    // seen": a reader who hides the guide with a step outstanding is back where
    // they were, and the simpler card is what they have.
    freshImport(100);
    preferences.setItem(ENGAGED_PREFERENCE, 'true');
    preferences.setItem(DISMISSED_PREFERENCE, 'true');
    render(<ImprovedDashboard />);

    expect(screen.queryByTestId('history-path')).not.toBeInTheDocument();
    expect(screen.getByTestId('first-steps')).toBeInTheDocument();
  });

  it('leaves First steps alone for a ledger that never met the guide’s threshold', () => {
    freshImport(12);
    render(<ImprovedDashboard />);

    expect(screen.queryByTestId('history-path')).not.toBeInTheDocument();
    expect(screen.getByTestId('first-steps')).toBeInTheDocument();
  });

  it('changes nothing during boot — the guide cannot be up over a ledger it has not read', () => {
    // The gate must not make First steps flicker while the rows are arriving:
    // an unread ledger is not a finished one, so the guide holds its claims
    // back, the gate is open, and this card behaves exactly as it always did.
    mocks.app.accounts = [];
    mocks.app.transactions = [];
    mocks.app.isLoading = true;
    preferences.setItem(ENGAGED_PREFERENCE, 'true');
    render(<ImprovedDashboard />);

    expect(screen.queryByTestId('history-path')).not.toBeInTheDocument();
    expect(screen.getByTestId('first-steps')).toBeInTheDocument();
  });

  it('hides First steps by its own rule too, with no guide in sight', () => {
    // The supersession is an ADDITION: the card's own "every step is derived
    // and done" stand-down is untouched.
    mocks.app.accounts = [account({ id: 'acc-a', name: 'Feed Account A' })];
    mocks.app.transactions = [{
      id: 'filed-1',
      date: new Date('2026-05-02T00:00:00.000Z'),
      description: 'Payment',
      amount: -12.5,
      type: 'expense',
      accountId: 'acc-a',
      category: 'det-food',
      needsReview: false,
    }];
    render(<ImprovedDashboard />);

    expect(screen.queryByTestId('history-path')).not.toBeInTheDocument();
    expect(screen.queryByTestId('first-steps')).not.toBeInTheDocument();
  });
});

/**
 * Budget Status — each budget over its OWN period, and a click for the rows.
 *
 * The card used to sum a rolling thirty days against the base amount, which
 * is no period a budget has: the figure disagreed with the Budget page, could
 * not say what stretch of days it covered, and a click did nothing (the
 * owner, 15 Oct 2026). Now it reads the one evaluation the Budget page reads
 * (utils/budgetEvaluation) and names the window beside the figure, and the
 * row opens the transactions it was summed from.
 */
describe('Budget Status', () => {
  const TODAY = new Date(2026, 9, 15, 12, 0, 0); // 15 October 2026

  const txn = (over: Partial<Transaction> & { id: string; date: Date; amount: number }): Transaction => ({
    description: 'Shop',
    type: over.amount < 0 ? 'expense' : 'income',
    accountId: 'acc-a',
    category: 'cat-food',
    cleared: false,
    ...over,
  } as Transaction);

  beforeEach(() => {
    // An earlier describe may have left Date mocked; start from real time so
    // the clock below is this describe's and nobody else's.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TODAY);
    mocks.app.accounts = [account({ id: 'acc-a', name: 'Current Account', openingBalance: 1000 })];
    mocks.app.categories = [
      { id: 'cat-food', name: 'Food Shopping', type: 'expense', level: 'detail' },
      { id: 'cat-fuel', name: 'Fuel', type: 'expense', level: 'detail' },
    ] as never[];
    mocks.app.budgets = [{
      id: 'b-food',
      categoryId: 'cat-food',
      amount: 500,
      period: 'monthly',
      isActive: true,
      createdAt: new Date(2026, 0, 1),
      updatedAt: new Date(2026, 0, 1),
      spent: 0,
    }] as never[];
    mocks.app.transactions = [
      // 1 October: inside the calendar month, and exactly what the old
      // thirty-day window also caught — so far so equal.
      txn({ id: 'r-first', date: new Date(2026, 9, 1), amount: -400 }),
      // 20 September: within thirty days of the 15th, OUTSIDE the budget's
      // month. The old card counted this; the Budget page never did.
      txn({ id: 'r-sept', date: new Date(2026, 8, 20), amount: -300 }),
      // Another category in the month: not this budget's.
      txn({ id: 'r-fuel', date: new Date(2026, 9, 5), amount: -50, category: 'cat-fuel' }),
      // A refund in the month: nets off, as the Budget page nets it.
      txn({ id: 'r-refund', date: new Date(2026, 9, 9), amount: 20, type: 'income' }),
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
    mocks.app.budgets = [];
    mocks.app.categories = [];
  });

  it('reads the budget’s own calendar month, exactly as the Budget page does', () => {
    render(<ImprovedDashboard />);

    const row = screen.getByTestId('budget-status-row');
    // 400 spent, 20 refunded; the September 300 is not this month's.
    expect(row).toHaveTextContent('£380.00 / £500.00');
    expect(row).not.toHaveTextContent('£680.00');
  });

  it('says what period the figure is for, in words and in days', () => {
    render(<ImprovedDashboard />);

    const row = screen.getByTestId('budget-status-row');
    expect(row).toHaveTextContent(/Monthly · 1\s*[–-]\s*31 Oct 2026/);
    // And to a screen reader, on the one control the row is.
    expect(screen.getByRole('button', { name: /Food Shopping: £380\.00 of £500\.00, monthly, 1\s*[–-]\s*31 Oct 2026/ })).toBeInTheDocument();
  });

  it('opens the transactions behind the figure — the rows it counted, and no others', () => {
    render(<ImprovedDashboard />);
    expect(screen.queryByTestId('budget-drill')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('budget-status-row'));

    expect(screen.getByTestId('budget-drill-title')).toHaveTextContent(/Food Shopping — 1\s*[–-]\s*31 Oct 2026/);
    const rows = screen.getByTestId('budget-drill-rows').textContent!.split(',').sort();
    expect(rows).toEqual(['r-first', 'r-refund']);
    expect(screen.getByTestId('budget-drill-total')).toHaveTextContent('380');
  });

  /**
   * KEY BUDGETS (owner, 7 Nov 2026): the cog the key accounts have. Nothing
   * chosen = the first three, never written; a choice is a filter, in the
   * stored order; "View All Budgets" is always there.
   */
  describe('the cog chooses which budgets the card shows', () => {
    const budgetOn = (id: string, categoryId: string, amount: number): Record<string, unknown> => ({
      id, categoryId, amount, period: 'monthly', isActive: true,
      createdAt: new Date(2026, 0, 1), updatedAt: new Date(2026, 0, 1), spent: 0,
    });

    beforeEach(() => {
      localStorage.removeItem('dashboardKeyBudgets');
      mocks.app.categories = [
        { id: 'grp-home', name: 'Home', type: 'expense', level: 'sub' },
        { id: 'cat-food', name: 'Food Shopping', type: 'expense', level: 'detail', parentId: 'grp-home' },
        { id: 'cat-fuel', name: 'Fuel', type: 'expense', level: 'detail' },
        { id: 'cat-gifts', name: 'Gifts', type: 'expense', level: 'detail' },
        { id: 'cat-phone', name: 'Phone', type: 'expense', level: 'detail' },
      ] as never[];
      mocks.app.budgets = [
        budgetOn('b-food', 'cat-food', 500),
        budgetOn('b-fuel', 'cat-fuel', 100),
        budgetOn('b-gifts', 'cat-gifts', 200),
        budgetOn('b-phone', 'cat-phone', 50),
      ] as never[];
    });

    afterEach(() => {
      localStorage.removeItem('dashboardKeyBudgets');
    });

    const rowNames = (): string[] =>
      screen.getAllByTestId('budget-status-row').map(row => row.querySelector('.truncate')?.textContent ?? '');

    it('shows the first three when nothing was ever chosen, and writes no choice', () => {
      render(<ImprovedDashboard />);
      expect(rowNames()).toEqual(['Home : Food Shopping', 'Fuel', 'Gifts']);
      expect(screen.getByRole('heading', { level: 3, name: /Key Budgets/ })).toHaveTextContent('(3 of 4');
      expect(localStorage.getItem('dashboardKeyBudgets')).toBeNull();
      // The way to the rest is always there, whatever the count.
      expect(screen.getByRole('button', { name: 'View All Budgets (4) →' })).toBeInTheDocument();
    });

    it('shows the chosen budgets in the stored order', () => {
      localStorage.setItem('dashboardKeyBudgets', JSON.stringify(['b-phone', 'b-food']));
      render(<ImprovedDashboard />);
      expect(rowNames()).toEqual(['Phone', 'Home : Food Shopping']);
      expect(screen.getByRole('heading', { level: 3, name: /Key Budgets/ })).toHaveTextContent('(2 of 4');
    });

    it('the cog opens a panel grouped by category group, and a press adds a budget to the card', () => {
      render(<ImprovedDashboard />);
      fireEvent.click(screen.getByLabelText('Customise displayed budgets'));

      expect(screen.getByText('Select budgets to show on the dashboard:')).toBeInTheDocument();
      expect(screen.getByText('Home')).toBeInTheDocument();
      expect(screen.getByText('Other budgets')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /^Phone/, pressed: false }));

      expect(rowNames()).toEqual(['Home : Food Shopping', 'Fuel', 'Gifts', 'Phone']);
      expect(JSON.parse(localStorage.getItem('dashboardKeyBudgets') ?? '[]'))
        .toEqual(['b-food', 'b-fuel', 'b-gifts', 'b-phone']);
    });

    it('clearing the choice says what it hides and offers the way back', () => {
      render(<ImprovedDashboard />);
      fireEvent.click(screen.getByLabelText('Customise displayed budgets'));
      fireEvent.click(screen.getByRole('button', { name: 'Clear all budgets' }));

      expect(screen.queryByTestId('budget-status-row')).not.toBeInTheDocument();
      expect(
        screen.getByRole('heading', { level: 3, name: 'No budgets are selected for the dashboard' })
      ).toBeInTheDocument();
      expect(localStorage.getItem('dashboardKeyBudgets')).toBe('[]');

      fireEvent.click(screen.getByRole('button', { name: 'Show all budgets' }));
      expect(screen.getAllByTestId('budget-status-row')).toHaveLength(4);
    });

    it('a chosen budget that is no longer running is skipped, and comes back if it does', () => {
      localStorage.setItem('dashboardKeyBudgets', JSON.stringify(['b-gone', 'b-fuel']));
      render(<ImprovedDashboard />);
      expect(rowNames()).toEqual(['Fuel']);
      // The choice is kept as stored — nothing is pruned on the owner's behalf.
      expect(localStorage.getItem('dashboardKeyBudgets')).toBe('["b-gone","b-fuel"]');
    });
  });

  it('leaves a finished budget off the card — it has nothing to be doing (5 Nov 2026)', () => {
    mocks.app.budgets = [
      ...(mocks.app.budgets as object[]),
      // A one-off that ran in June and is over: active, with a figure that is history.
      {
        id: 'b-done', categoryId: 'cat-fuel', amount: 100, period: 'custom', isActive: true,
        startDate: '2026-06-01', endDate: '2026-06-30',
        createdAt: new Date(2026, 5, 1), updatedAt: new Date(2026, 5, 1), spent: 0,
      },
    ] as never[];

    render(<ImprovedDashboard />);

    expect(screen.getAllByTestId('budget-status-row')).toHaveLength(1);
    expect(within(screen.getByTestId('budget-status')).queryByText('Fuel')).not.toBeInTheDocument();
  });

  it('marks an overspend against the allowance the Budget page shows — the carry counted in', () => {
    // Carries its surplus, and began in September (a row written before the
    // cycle model keeps the calendar month): September left £100 of £500,
    // so October's allowance is £600 (utils/budgetEvaluation).
    mocks.app.budgets = [{
      ...(mocks.app.budgets[0] as object),
      rolloverMode: 'surplus',
      startDate: '2026-09-01',
      createdAt: new Date(2026, 8, 1),
    }] as never[];
    mocks.app.transactions = [
      txn({ id: 'last-month', date: new Date(2026, 8, 12), amount: -400 }),
      txn({ id: 'big', date: new Date(2026, 9, 2), amount: -655 }),
    ];

    render(<ImprovedDashboard />);

    const row = screen.getByTestId('budget-status-row');
    expect(row).toHaveTextContent('£655.00 / £600.00');
    expect(screen.getByRole('progressbar', { name: /Food Shopping budget: 100% used/ })).toBeInTheDocument();
  });
});

