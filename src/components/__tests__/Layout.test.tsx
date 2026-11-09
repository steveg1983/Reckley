/**
 * Layout Tests
 * Component rendering and user interactions
 */

import React from 'react';
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '../../test/testUtils';
import Layout from '../Layout';

vi.mock('@clerk/clerk-react', () => ({
  UserButton: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="user-button">{children}</div>
  ),
  useUser: () => ({ user: null, isLoaded: true }),
  useAuth: () => ({ signOut: vi.fn(), getToken: vi.fn() }),
  useSession: () => ({ session: null }),
}));

vi.mock('../GlobalSearch', () => {
  const MockGlobalSearch = React.forwardRef<
    { focusInput: () => void },
    {
      placeholder?: string;
      autoFocus?: boolean;
      onResultSelect?: () => void;
    }
  >(({ placeholder = 'Search', autoFocus = false, onResultSelect }, ref) => {
    const inputRef = React.useRef<HTMLInputElement>(null);

    React.useImperativeHandle(ref, () => ({
      focusInput: () => {
        inputRef.current?.focus();
      }
    }), []);

    React.useEffect(() => {
      if (autoFocus) {
        inputRef.current?.focus();
      }
    }, [autoFocus]);

    return (
      <div>
        <input
          ref={inputRef}
          placeholder={placeholder}
          data-testid="mock-global-search-input"
        />
        <button
          type="button"
          data-testid="mock-global-search-result"
          onClick={() => onResultSelect?.()}
        >
          Select Result
        </button>
      </div>
    );
  });

  MockGlobalSearch.displayName = 'MockGlobalSearch';

  return {
    default: MockGlobalSearch
  };
});
describe('Layout', () => {
  const originalMatchMedia = window.matchMedia;

  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
  });

  it('renders without crashing', () => {
    renderWithProviders(<Layout />);
    // Layout contains navigation - check for navigation elements (there may be multiple)
    const navElements = screen.getAllByRole('navigation');
    expect(navElements.length).toBeGreaterThan(0);
  });

  it('swaps the desktop bar for the phone header at lg, and at the same edge for both', () => {
    renderWithProviders(<Layout />);
    // The opened iPhone Duo (951px) and an upright iPad (768px) sit between
    // md and lg, and the desktop bar there was a row of icons (owner, 9 Nov
    // 2026). They get the phone header and its slide-out menu instead. The
    // two classes have to name the same breakpoint or both bars (or neither)
    // would show across a band of widths.
    const desktopBar = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(desktopBar.className).toContain('hidden lg:block');
    expect(desktopBar.className).not.toMatch(/\bmd:block\b/);
    const phoneHeader = screen.getByRole('banner');
    expect(phoneHeader.className).toContain('lg:hidden');
    expect(phoneHeader.className).not.toMatch(/\bmd:hidden\b/);
  });

  it('focuses desktop search input when Ctrl+K is pressed', async () => {
    renderWithProviders(<Layout />);

    const searchInput = await screen.findByPlaceholderText('Search...');
    expect(document.activeElement).not.toBe(searchInput);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(searchInput);
    });
  });

  it('opens mobile search when shortcut is used on small screens', async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 500 });

    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      });

    try {
      renderWithProviders(<Layout />);

      expect(screen.queryByTestId('mobile-search-container')).not.toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

      const mobileContainer = await screen.findByTestId('mobile-search-container');
      const mobileInput = within(mobileContainer).getByPlaceholderText('Search transactions, accounts, budgets...');
      expect(document.activeElement).toBe(mobileInput);
    } finally {
      rafSpy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: originalInnerWidth });
    }
  });

  it('closes mobile search after selecting a result', async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 500 });

    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      });

    try {
      renderWithProviders(<Layout />);

      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

      const mobileContainer = await screen.findByTestId('mobile-search-container');
      const resultButton = within(mobileContainer).getByTestId('mock-global-search-result');
      fireEvent.click(resultButton);

      await waitFor(() => {
        expect(screen.queryByTestId('mobile-search-container')).not.toBeInTheDocument();
      });
    } finally {
      rafSpy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: originalInnerWidth });
    }
  });
});

describe('Layout — the Plan menu and split triggers', () => {
  const originalMatchMedia = window.matchMedia;

  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
  });

  // The desktop nav's dropdown triggers: the LABEL is a link to the menu's
  // home; the chevron beside it is the button that opens the menu.
  const navLink = (name: string) =>
    within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name });
  const menuButton = (label: string) =>
    within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('button', { name: `${label} menu` });

  it('groups the forward-looking pages under Plan, not as top-level items', () => {
    renderWithProviders(<Layout />);

    // Plan's label navigates to its NAMESAKE page (§9, 22 Aug: /forecast is
    // titled Plan — the actuals P&L with the scenario tool beside it), the
    // same idiom as the Accounts label; its menu holds the other three.
    expect(navLink('Plan')).toHaveAttribute('href', '/forecast');
    fireEvent.click(menuButton('Plan'));
    expect(navLink('Budget')).toHaveAttribute('href', '/budget');
    expect(navLink('Calendar')).toHaveAttribute('href', '/calendar');
    // Recurring Payments joined Plan on 18 Aug, out of the Reports gallery:
    // the verdicts given there are what let a pattern reach the calendar and
    // the forecast, which makes it forward-looking work rather than a report.
    expect(navLink('Recurring Payments')).toHaveAttribute('href', '/recurring-payments');
  });

  it('orders Plan as Budget, Calendar, Recurring Payments — the Plan page itself is the label', () => {
    renderWithProviders(<Layout />);

    // No 'Forecast' item: the page is not a sub-item of itself, exactly as
    // there is no 'Accounts' item inside the Accounts menu.
    expect(openMenuItems('Plan')).toEqual([
      'Budget',
      'Calendar',
      'Recurring Payments',
    ]);
  });

  it('offers Goals nowhere at all — the feature is gone', () => {
    /*
     * This used to assert Goals was under PLAN rather than under Manage, which
     * was a question about where it belonged. The owner has since removed the
     * feature outright — "let's completely do away with 'Goals page' and
     * anything relating to it" — on the way to a budget page and a full
     * cash-flow forecast. So the assertion is no longer about placement: there
     * is no such destination, and a nav that offers one is a nav pointing at a
     * route that does not exist.
     */
    renderWithProviders(<Layout />);

    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    fireEvent.click(menuButton('Plan'));
    expect(within(nav).queryByRole('link', { name: 'Goals' })).not.toBeInTheDocument();
    fireEvent.click(menuButton('Manage'));
    expect(within(nav).getByRole('link', { name: 'Categories' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Goals' })).not.toBeInTheDocument();
  });

  /**
   * The order of a menu is not decoration — it is the answer to "where would I
   * look for this?", and it is the one thing about a menu nobody re-reads once
   * they have learnt it. So both menus are pinned in full, in order: an item
   * that quietly moves, or a new one dropped in the middle, fails here.
   *
   * The links are read off the OPEN menu by their position in the DOM, which is
   * the order they are drawn in.
   */
  const openMenuItems = (label: string): string[] => {
    fireEvent.click(menuButton(label));
    // The chevron, the trigger label and the dropped panel all live in one
    // positioned wrapper; the panel is the only part with more than one link in
    // it, so the wrapper's links are [the trigger] followed by [the menu].
    const wrapper = menuButton(label).closest('div.relative');
    if (!(wrapper instanceof HTMLElement)) throw new Error(`no ${label} menu`);
    const links = within(wrapper).getAllByRole('link').map(a => a.textContent?.trim() ?? '');
    expect(links[0]).toBe(label);
    return links.slice(1);
  };

  it('puts Investments in Accounts, under Find — a holding is a thing you own', () => {
    renderWithProviders(<Layout />);

    // Find sits where Transactions used to. The global list is retired: you
    // work in an account's register, and the one thing that list did which a
    // register cannot — "which account was that in?" — is Find's whole job.
    expect(openMenuItems('Accounts')).toEqual([
      'All Accounts',
      'Find Transactions',
      'Investments',
      'Reconciliation',
      'Categorisation',
      'Bank Feeds',
    ]);
  });

  it('offers no way into the retired global transactions list', () => {
    renderWithProviders(<Layout />);

    // Every menu opened in turn — only one is ever open at a time — and every
    // link in the nav read while it is. A menu entry is the one thing that
    // would make the retirement look like a bug rather than a decision, and
    // /transactions now only answers as a redirect, which no menu should be
    // teaching anyone to use.
    const hrefs: (string | null)[] = [];
    for (const menu of ['Accounts', 'Plan', 'Manage', 'Settings']) {
      fireEvent.click(menuButton(menu));
      const nav = screen.getByRole('navigation', { name: 'Main navigation' });
      hrefs.push(...within(nav).getAllByRole('link').map(a => a.getAttribute('href')));
      fireEvent.click(menuButton(menu));
    }

    expect(hrefs).not.toContain('/transactions');
    expect(hrefs).toContain('/find');
  });

  it('orders Manage as Categories, Payees, Duplicates, Tags — and no longer keeps Investments', () => {
    renderWithProviders(<Layout />);

    // Manage is data admin. Investments is not admin, and Tags was standing in
    // front of Payees, which is the one people open most. Transfer Links
    // joined 20 Aug (owner: "a page under 'Manage' just like Payees") —
    // beside its fellow tidy-up chores, before the data doors. Duplicates
    // joined 28 Aug, in the owner's own order: it was a tool under Data
    // Management, beside backups and the danger zone, which is not where a
    // tidying job lives.
    expect(openMenuItems('Manage')).toEqual([
      'Categories',
      'Payees',
      'Duplicates',
      'Tags',
      'Transfer Links',
      'Import Data',
      'Export Data',
      'Documents',
    ]);
  });

  /**
   * The add-transaction modal is Layout's, and the parameter that opens it is
   * app-wide. It used to be honoured only on /transactions, which is why the
   * phone's + and the keyboard's "new transaction" both pointed at a page whose
   * only remaining job was holding a modal that was never its.
   */
  it('opens the add-transaction modal from ?action=add-transaction on any page', async () => {
    window.history.pushState({}, '', '/accounts?action=add-transaction');

    renderWithProviders(<Layout />);

    /*
     * By its heading: "Add Transaction" is also a word on the modal's own save
     * button, and the query has to name the thing that proves it is open.
     *
     * THE EXPLICIT TIMEOUT IS A MEASUREMENT, NOT A SHRUG. This assertion failed
     * three times inside `npm run test:coverage` on 2026-08-13 and could not be
     * reproduced afterwards in four attempts — three with instrumentation on
     * this file plus its neighbour, one over the whole 396-file suite.
     *
     * What it costs unloaded is 190ms against testing-library's 1000ms default,
     * so the budget is roughly 5x. That is thin rather than generous: this
     * renders the WHOLE frame — nav, search, the modal — and every failure
     * happened during a pre-push run while a Vite dev server and a browser were
     * competing for the same cores. A 5x slowdown under that is ordinary.
     *
     * So the timeout is raised rather than the test rewritten, because there is
     * no race to fix: the assertion is inherently eventual (render → effect →
     * modal) and deterministic. 5s keeps it failing fast if the behaviour ever
     * genuinely breaks, while removing a coin toss that costs a four-minute
     * gate re-run when it lands.
     */
    expect(
      await screen.findByRole('heading', { name: 'Add Transaction' }, { timeout: 5000 })
    ).toBeInTheDocument();
    // And the parameter is spent, so back or refresh cannot re-open it.
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('action')).toBeNull();
    });
  });

  it('leaves ?action=add alone — on /accounts that means a new ACCOUNT', () => {
    window.history.pushState({}, '', '/accounts?action=add');

    renderWithProviders(<Layout />);

    // Two different things may not share one parameter once the parameter
    // stops belonging to one page: the Accounts page reads this one.
    expect(screen.queryByRole('heading', { name: 'Add Transaction' })).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('action')).toBe('add');
  });

  it('clicking a trigger label navigates instead of only toggling a menu', () => {
    renderWithProviders(<Layout />);

    // Each label is a real link to its menu's home page…
    expect(navLink('Accounts')).toHaveAttribute('href', '/accounts');
    expect(navLink('Manage')).toHaveAttribute('href', '/settings/categories');
    expect(navLink('Settings')).toHaveAttribute('href', '/settings');
  });

  it('the chevron opens the menu without navigating, and ArrowDown on the label does too', () => {
    renderWithProviders(<Layout />);

    const chevron = menuButton('Accounts');
    expect(chevron).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chevron);
    expect(chevron).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(chevron);
    expect(chevron).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(navLink('Accounts'), { key: 'ArrowDown' });
    expect(chevron).toHaveAttribute('aria-expanded', 'true');
  });
});
