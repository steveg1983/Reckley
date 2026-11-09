import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, Suspense } from 'react';
import { Link, useLocation, Outlet, useNavigate } from 'react-router-dom';

// THE FRAME'S EDITION-VARYING FURNITURE, through a specifier that names no
// edition. Everything here used to be imported by path — a Clerk button, a bank
// feed's scheduler, a demo banner, and four surfaces that reach the web's state
// layer — and between them they were five of the six cloud roots a walk from
// this file used to find. `editions/chrome.ts` declares what each one is;
// `docs/edition-gating.md` explains why the choice is the build's rather than a
// runtime branch's.
import {
  BackgroundWork,
  DemoBanner,
  GlobalSearch,
  IdentityMenu,
  MobileBreadcrumb,
  NotificationBell,
  QuickAddTransaction,
  RealtimeDot,
  CHROME_HAS_BANK_FEEDS,
  type GlobalSearchHandle,
} from '@chrome';
import { HomeIcon, CreditCardIcon, WalletIcon, TrendingUpIcon, SettingsIcon, MenuIcon, XIcon, ArrowRightLeftIcon, BarChart3Icon, ChevronRightIcon, ClockIcon, DatabaseIcon, TagIcon, Settings2Icon, TargetIcon, HashIcon, SearchIcon, PieChartIcon, ShieldIcon, UploadIcon, DownloadIcon, FolderIcon, BankIcon, CalendarIcon, UsersIcon } from '../components/icons';
import { SidebarLink, TopNavItem, TopNavDropdown } from './layout/NavComponents';
import { PageTransition, NavigationProgress } from './layout/SimplePageTransition';
import { EnhancedSkipLinks, FocusIndicator, RouteAnnouncer } from './layout/AccessibilityImprovements';
import PullToRefreshIndicator from './PullToRefreshIndicator';
import OfflineIndicator from './OfflineIndicator';
import { ReckleyLockup } from './brand/ReckleyLockup';
import BalanceReminderCard from './BalanceReminderCard';
import PWAInstallPrompt from './PWAInstallPrompt';
import KeyboardShortcutsHelp from './KeyboardShortcutsHelp';
import { useKeyboardShortcutsHelp } from '../hooks/useKeyboardShortcutsHelp';
import { useGlobalKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import KeyboardSequenceIndicator from './KeyboardSequenceIndicator';
import MobileBottomNav from './MobileBottomNav';
import ViewportDebugOverlay from './ViewportDebugOverlay';
import { isDemoModeRuntimeAllowed } from '../utils/runtimeMode';
import {
  APP_BAR_HEIGHT_VAR,
  TOP_CHROME_OFFSET,
  BOTTOM_CHROME_OFFSET,
  SIDE_INSET_LEFT,
  SIDE_INSET_RIGHT,
  sidePadding,
} from './layout/chromeOffsets';

/*
 * The top-of-window offsets live in `layout/chromeOffsets.ts` rather than here.
 * A page needs one of them to park its own chrome, and Layout renders the
 * router's Outlet — so importing back from this file closes a cycle that lint
 * and strict TypeScript both accept and the browser does not. See that file.
 */

export default function Layout(): React.JSX.Element {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const [planExpanded, setPlanExpanded] = useState(false);
  const [manageExpanded, setManageExpanded] = useState(false);
  // advancedExpanded removed — Advanced section now uses TopNavDropdown on desktop and direct links on mobile
  // investmentsExpanded removed with /enhanced-investments — Investments has no
  // sub-pages left, so it is a plain link in the drawer.
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [isMobileSearchVisible, setIsMobileSearchVisible] = useState(false);
  const desktopSearchRef = useRef<GlobalSearchHandle | null>(null);
  const desktopNavRef = useRef<HTMLElement | null>(null);
  const mobileHeaderRef = useRef<HTMLElement | null>(null);
  const mobileSearchRef = useRef<GlobalSearchHandle | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = new URLSearchParams(location.search);
  const isDemoModeRoutingEnabled =
    isDemoModeRuntimeAllowed(import.meta.env) && searchParams.get('demo') === 'true';
  const { isOpen: isHelpOpen, openHelp, closeHelp } = useKeyboardShortcutsHelp();
  const [showGlobalAddTransaction, setShowGlobalAddTransaction] = useState(false);

  const openMobileSearch = useCallback(() => {
    setIsMobileSearchVisible(true);
    requestAnimationFrame(() => {
      mobileSearchRef.current?.focusInput();
    });
  }, []);

  const focusSearch = useCallback(() => {
    if (window.innerWidth <= 768) {
      openMobileSearch();
    } else {
      desktopSearchRef.current?.focusInput();
    }
  }, [openMobileSearch]);

  // Publishes APP_BAR_HEIGHT_VAR — see the comment on it in
  // `layout/chromeOffsets`, and on BANNER_HEIGHT_VAR in DemoModeIndicator,
  // which this deliberately mirrors. In a LAYOUT effect, before paint, so a
  // page's parked chrome is in the right place on the first frame rather than
  // dropping into position after it.
  useLayoutEffect((): (() => void) => {
    const root = document.documentElement;
    const publishHeight = (): void => {
      // Whichever bar is hidden at this width measures 0, so the larger of the
      // two is the one on screen — which is how this survives a breakpoint
      // change without knowing where the breakpoint is.
      const height = Math.max(
        desktopNavRef.current?.offsetHeight ?? 0,
        mobileHeaderRef.current?.offsetHeight ?? 0
      );
      root.style.setProperty(APP_BAR_HEIGHT_VAR, `${height}px`);
    };

    publishHeight();

    // WATCHING THE TWO BARS IS NOT ENOUGH, and the failure is silent. A
    // ResizeObserver does not report an element that is not being rendered, so
    // the one moment the answer changes — crossing `md`, one bar going
    // `display: none` as the other appears — fires no callback at all.
    // Measured: after 1280→390 the variable still said 48px, the desktop bar's
    // height, and the accounts toolbar parked 28px UNDER a 76px mobile header.
    //
    // So the document element is observed as well — always rendered, always
    // changing with the viewport — and `resize` and `orientationchange` are
    // listened for on top. That is three subscriptions for one fact, and it is
    // deliberate belt-and-braces rather than indecision: every callback runs
    // the same two `offsetHeight` reads, so a duplicate costs nothing and a
    // missing one costs a toolbar parked behind the header.
    //
    // ⚠️ WHAT IS AND IS NOT PROVEN. Verified by measurement: the published
    // value is correct on load at 1280 (48px) and at 390 (76px), and the
    // handler produces the right answer when invoked. The CROSSING itself
    // could not be tested here — the automated browser changes the viewport
    // without dispatching anything, confirmed by counting hits on all three
    // subscriptions across a 1280→390 change: 0, 0 and 0, while `innerWidth`
    // reported the new value. A real browser fires all three. This is the same
    // family of blind spot as the harness being unable to see CSS transitions.
    const observer = new ResizeObserver(publishHeight);
    observer.observe(document.documentElement);
    if (desktopNavRef.current !== null) observer.observe(desktopNavRef.current);
    if (mobileHeaderRef.current !== null) observer.observe(mobileHeaderRef.current);
    window.addEventListener('resize', publishHeight);
    window.addEventListener('orientationchange', publishHeight);

    return (): void => {
      observer.disconnect();
      window.removeEventListener('resize', publishHeight);
      window.removeEventListener('orientationchange', publishHeight);
      root.style.removeProperty(APP_BAR_HEIGHT_VAR);
    };
  }, []);

  // Initialize global keyboard shortcuts
  const { activeSequence } = useGlobalKeyboardShortcuts(openHelp);

  /*
   * NO SWIPE-BETWEEN-PAGES. A horizontal swipe anywhere in `main` used to walk
   * /dashboard → /accounts → /investments → /reports, and it is gone rather
   * than narrowed.
   *
   * ─ WHY ─────────────────────────────────────────────────────────────────────
   * A page-level horizontal gesture cannot coexist with horizontally scrollable
   * CONTENT, and it loses the argument every time, because the content is what
   * the user is deliberately reaching for. Reported from a phone: the account
   * rows' settings / reconcile / close buttons sat off to the right, and
   * "if I scroll a little to the right to make them visible, the page thinks I
   * am trying to scroll 'forward' a page and takes me to the investment page."
   * The gesture did not merely conflict with the reach — it PUNISHED it, by
   * throwing the page away mid-reach.
   *
   * It is also a second, worse copy of a gesture the platform already owns:
   * iOS Safari's edge swipe is back/forward, so the same flick meant two
   * different things depending on how near the bezel it started.
   *
   * Nothing is lost. The bottom nav is on every phone screen and goes to these
   * pages directly, by name, in one tap — a discoverable control replacing an
   * invisible one whose main effect was accidental navigation. The owner asked
   * for exactly this: "we disable the ability to 'scroll through pages' by
   * scrolling left and right".
   *
   * `useSwipeGestures` itself stays — BottomSheet and SwipeableTransactionRow
   * use it for gestures scoped to one element, which is where a swipe belongs.
   */

  // Close dropdown on route change
  useEffect(() => {
    setOpenDropdown(null);
  }, [location.pathname]);

  useEffect(() => {
    setIsMobileSearchVisible(false);
  }, [location.pathname]);

  /**
   * `?action=add-transaction`, on ANY page: open the app-wide add-transaction
   * modal.
   *
   * The modal is Layout's, so Layout is what honours the parameter — and it
   * consumes it with a replace, so back or refresh cannot re-open it. It used
   * to insist on `/transactions`, which tied the phone's + and the keyboard's
   * "new transaction" to a page that no longer exists; the parameter is now
   * read wherever it lands, and both of those point at /accounts.
   *
   * ─ WHY NOT `?action=add` ───────────────────────────────────────────────────
   * Because that name is taken, on the very page this now lands on: the
   * Accounts page reads `?action=add` as "add an ACCOUNT" (see Accounts.tsx),
   * and a Layout that also claimed it would open two modals at once for the
   * phone's "Add Account". Two different things cannot share one parameter the
   * moment the parameter stops belonging to one page. Old links that say
   * `add` on `/transactions` are translated on their way through the redirect
   * (see components/legacyTransactionsDestination), where the page they came
   * from still says which of the two they meant.
   */
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('action') === 'add-transaction') {
      setShowGlobalAddTransaction(true);
      params.delete('action');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    }
  }, [location.pathname, location.search, navigate]);

  const toggleMobileMenu = useCallback(() => {
    setIsMobileMenuOpen((prev) => !prev);
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + K to open global search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        focusSearch();
      }
      
      // ? to open keyboard shortcuts help
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        openHelp();
      }
      
      // Alt + N to open Add Transaction (global shortcut)
      if (e.altKey && e.key === 'n') {
        e.preventDefault();
        setShowGlobalAddTransaction(true);
      }

      // Alt + M to toggle mobile menu
      if (e.altKey && e.key === 'm') {
        e.preventDefault();
        toggleMobileMenu();
      }
      
      // Alt + S — reserved (sidebar removed)
      
      // Escape to close mobile menu
      if (e.key === 'Escape' && isMobileMenuOpen) {
        e.preventDefault();
        setIsMobileMenuOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMobileMenuOpen, focusSearch, openHelp, toggleMobileMenu]);

  // Removed auto-expand logic - users control collapsible sections manually

  // Handle conflict resolution modal - disabled (state setters not implemented)
  // useEffect(() => {
  //   const handleOpenConflictResolver = (event: Event) => {
  //     const conflict = (event as CustomEvent).detail;
  //     setCurrentConflict(conflict);
  //     setConflictModalOpen(true);
  //   };
  //
  //   window.addEventListener('open-conflict-resolver', handleOpenConflictResolver);
  //   return () => window.removeEventListener('open-conflict-resolver', handleOpenConflictResolver);
  // }, []);

  return (
    // A block, not a flex row. The row layout served a sidebar that no longer
    // exists, and it made <main> share its width with EVERY in-flow sibling.
    // The "invisible 56px sibling" that squeezed main on real iPhones was
    // later identified: a touch-device CSS rule (index.css) was overriding
    // position:fixed on every BUTTON, dropping the w-14 floating + into
    // normal flow beside main. That rule is fixed too — block layout stays
    // because main's width should never be negotiable in the first place.
    <div
      className="min-h-screen bg-[#f8f9fb] dark:bg-gray-900"
      // The page's own content steps in from the iPhone Duo's status-pill
      // column (0px everywhere else); the ground still paints to the glass.
      // Fixed chrome is positioned against the window, not this box, so each
      // fixed piece pays the same insets itself — see chromeOffsets.
      style={{ paddingLeft: SIDE_INSET_LEFT, paddingRight: SIDE_INSET_RIGHT }}
    >
      {/* Whatever this edition starts once and never speaks to again, drawing
          nothing. In a browser it is the scheduled bank-feed refresh (on
          sign-in / daily at a set time — the schedule lives in Settings, and
          signed-out sessions do nothing); on a device there is no feed. */}
      <BackgroundWork />
      {/* Only draws during a pull, and only in an installed app — a browser tab
          has Safari's own. It is here rather than per-page because the gesture
          is about the DOCUMENT, which every page shares. */}
      <PullToRefreshIndicator />
      <DemoBanner />
      <EnhancedSkipLinks />
      <FocusIndicator />
      <RouteAnnouncer />
      
      {/* Skip links for keyboard navigation */}
      <div className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 z-50">
        <a 
          href="#main-content" 
          className="inline-block px-4 py-2 bg-[#1a2332] text-white rounded-md"
        >
          Skip to main content
        </a>
        <a 
          href="#main-navigation" 
          className="inline-block px-4 py-2 ml-2 bg-[#1a2332] text-white rounded-md"
        >
          Skip to navigation
        </a>
      </div>
      {/* Desktop Top Navigation Bar */}
      <nav
        ref={desktopNavRef}
        id="main-navigation"
        className="hidden md:block fixed top-0 left-0 right-0 z-40 bg-[#1a2332] shadow-md"
        // Sits BELOW the demo banner rather than under it. The banner publishes
        // its measured height into this variable while demo mode is on, and
        // removes it otherwise — so outside demo mode this resolves to 0px and
        // is exactly the `top-0` it overrides. The status-bar inset rides with
        // it: on a desktop it is 0px, and this bar is `md:` up anyway, but the
        // two offsets belong together wherever chrome is pinned to the top.
        style={{ top: TOP_CHROME_OFFSET }}
        role="navigation"
        aria-label="Main navigation"
      >
        {/* The desktop twin of the mobile bar's shoulder — 0px tall wherever
            the inset and banner are 0, so a desktop browser never sees it. */}
        <div
          aria-hidden="true"
          className="absolute left-0 right-0 bottom-full bg-[#1a2332]"
          style={{ height: TOP_CHROME_OFFSET }}
        />
        <div className="flex items-center h-12" style={sidePadding('1rem')}>
          {/* Brand — the horizontal lockup, light on the navy bar (identity
              handover §5). 96px is the lockup's minimum width, and at 96 the
              mark itself stands 21px, the size the handover names for here. */}
          <Link
            to={isDemoModeRoutingEnabled ? '/dashboard?demo=true' : '/dashboard'}
            className="text-white mr-8 shrink-0 hover:text-white/90 transition-colors flex items-center h-full"
          >
            <ReckleyLockup layout="horizontal" width={96} />
          </Link>

          {/* Primary Nav — 5 core pages */}
          <div className="flex items-center gap-0.5 flex-1 min-w-0">
            <TopNavItem to="/dashboard" icon={HomeIcon} label="Dashboard" />
            <TopNavDropdown
              label="Accounts"
              icon={WalletIcon}
              homeTo="/accounts"
              // Investments sits here, under Transactions, and no longer under
              // Manage. A holding IS an account — it has a balance, it moves,
              // it counts towards net worth — so it belongs with the things you
              // OWN, next to the transactions that feed it. Manage is data
              // admin: categories, payees, tags, imports. Same page, same icon;
              // only the menu it hangs off changed.
              // Find, where Transactions used to be. The global transactions
              // page is retired: transactions are worked on in the register of
              // the account they belong to, and the one thing that page did
              // that a register cannot — "which account was that in?" — is
              // what Find answers, by taking you to the row in its register.
              items={[
                { to: '/accounts', icon: WalletIcon, label: 'All Accounts' },
                { to: '/find', icon: SearchIcon, label: 'Find Transactions' },
                { to: '/investments', icon: TrendingUpIcon, label: 'Investments' },
                { to: '/reconciliation', icon: ArrowRightLeftIcon, label: 'Reconciliation' },
                { to: '/categorisation', icon: TagIcon, label: 'Categorisation' },
                // A ledger-in-a-file has no server to hold a bank token, so
                // the device edition does not print the menu item at all
                // (owner, 26 Aug — the first desktop install offered a page
                // that could only apologise). @chrome resolves the fact.
                ...(CHROME_HAS_BANK_FEEDS
                  ? [{ to: '/open-banking', icon: BankIcon, label: 'Bank Feeds' }]
                  : []),
              ]}
              // The highlight follows the menu: on /investments it is Accounts
              // that lights up now, not Manage.
              activePaths={['/accounts', '/find', '/investments', '/reconciliation', '/categorisation', '/open-banking']}
              openDropdown={openDropdown}
              setOpenDropdown={setOpenDropdown}
            />
            {/* Plan groups the forward-looking pages the way Money did. Budget
                and Goals were never data admin, which is what Manage is — each
                menu means one thing: what I have, what I plan, what happened,
                my data, the app. */}
            <TopNavDropdown
              label="Plan"
              icon={TargetIcon}
              // The group's namesake page (Claude Design 22 Aug §9,
              // owner-approved): /forecast is now titled Plan — the actuals
              // P&L with the scenario tool beside it — so the LABEL navigates
              // there, exactly as the Accounts label navigates to Accounts.
              // It is no longer a sub-item of itself; the chevron holds the
              // group's other three pages.
              homeTo="/forecast"
              items={[
                { to: '/budget', icon: BarChart3Icon, label: 'Budget' },
                { to: '/calendar', icon: CalendarIcon, label: 'Calendar' },
                // Recurring Payments is Plan's third page, not a report: the
                // verdicts given there are what let a pattern reach the
                // calendar and the forecast (owner's ruling, 18 Aug). The MENU
                // says what the page is; the page's own heading keeps the
                // question it answers — "What I'm committed to".
                { to: '/recurring-payments', icon: ClockIcon, label: 'Recurring Payments' },
              ]}
              activePaths={['/budget', '/calendar', '/recurring-payments', '/forecast']}
              openDropdown={openDropdown}
              setOpenDropdown={setOpenDropdown}
            />

            <TopNavItem to="/reports" icon={PieChartIcon} label="Reports" />

            <TopNavDropdown
              label="Manage"
              icon={SettingsIcon}
              homeTo="/settings/categories"
              // Categories, Payees, Tags — in the order they matter to someone
              // tidying up a statement. Every transaction has a category and a
              // payee; tags are the optional third thing, and were sitting in
              // front of the one people open most.
              items={[
                { to: '/settings/categories', icon: TagIcon, label: 'Categories' },
                { to: '/settings/payees', icon: UsersIcon, label: 'Payees' },
                // Duplicates joins the things you go and MANAGE (owner, 28
                // Aug) — it was a tool under Data Management, beside backups
                // and the danger zone, which is not where a tidying job lives.
                { to: '/settings/duplicates', icon: SearchIcon, label: 'Duplicates' },
                { to: '/settings/tags', icon: HashIcon, label: 'Tags' },
                { to: '/transfer-links', icon: ArrowRightLeftIcon, label: 'Transfer Links' },
                { to: '/enhanced-import', icon: UploadIcon, label: 'Import Data' },
                { to: '/export-manager', icon: DownloadIcon, label: 'Export Data' },
                { to: '/documents', icon: FolderIcon, label: 'Documents' },
              ]}
              activePaths={['/settings/categories', '/settings/tags', '/settings/payees', '/settings/duplicates', '/enhanced-import', '/export-manager', '/documents', '/transfer-links']}
              openDropdown={openDropdown}
              setOpenDropdown={setOpenDropdown}
            />

            <TopNavDropdown
              label="Settings"
              icon={Settings2Icon}
              homeTo="/settings"
              items={[
                { to: '/settings', icon: SettingsIcon, label: 'General' },
                { to: '/settings/app', icon: Settings2Icon, label: 'App Settings' },
                { to: '/settings/data', icon: DatabaseIcon, label: 'Data Management' },
                { to: '/settings/security', icon: ShieldIcon, label: 'Security' },
                { to: '/subscription', icon: CreditCardIcon, label: 'Subscription' },
              ]}
              activePaths={['/settings', '/subscription']}
              // The pages Manage took from under /settings — its own
              // activePaths four lines up names the same four, and the pair
              // is what keeps exactly ONE menu lit over each of them.
              inactivePaths={['/settings/categories', '/settings/tags', '/settings/payees', '/settings/duplicates']}
              openDropdown={openDropdown}
              setOpenDropdown={setOpenDropdown}
            />
          </div>

          {/* Right side: Search + Notifications + User */}
          <div className="flex items-center gap-3 shrink-0 ml-4">
            <div className="w-44 lg:w-72 [&_input]:!py-0.5 [&_input]:!text-sm [&_input]:!h-7 [&_input]:!min-h-0 [&>div>div]:!border-0 [&>div>div]:!shadow-none [&>div>div]:!bg-transparent [&>div>div]:!rounded-none">
              <div className="bg-white/10 rounded-lg border border-white/20 focus-within:bg-white/20 transition-colors overflow-hidden">
                <GlobalSearch
                  ref={desktopSearchRef}
                  placeholder="Search..."
                />
              </div>
            </div>
            <NotificationBell />
            <RealtimeDot />
            <div className="relative">
              <button
                onClick={() => setOpenDropdown(openDropdown === 'help' ? null : 'help')}
                className="p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                title="Help"
                aria-label="Help menu"
                aria-expanded={openDropdown === 'help'}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </button>
              {openDropdown === 'help' && (() => {
                const pageHelp: Record<string, string> = {
                  '/dashboard': 'Your financial overview — net worth, income and expenses for the period you choose, your pinned reports, key account balances and budget progress.',
                  '/accounts': 'Manage bank accounts, credit cards, savings, and investments. Toggle between grouping by type or institution.',
                  '/find': 'Search every account at once by description or amount. Click a result to open that transaction in its own account’s register, where you can change it.',
                  '/budget': 'Set and track budgets by category. Try envelope budgeting or zero-based budgeting.',
                  '/calendar': 'See your income and expenses laid out by day on a monthly calendar.',
                  '/reports': 'A gallery of reports — net worth, account balances, spending by category or payee, period comparisons, and your own custom reports. The period you choose follows you between them.',
                  '/investments': 'Portfolio overview with holdings, performance, and allocation analysis.',
                  '/settings': 'App preferences, data management, security, and account configuration.',
                };
                const currentHelp = Object.entries(pageHelp).find(([path]) => location.pathname.startsWith(path));

                return (
                  <div className="absolute right-0 top-full mt-1 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-2 w-72 z-50">
                    {currentHelp && (
                      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
                        <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1">About this page</p>
                        <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">{currentHelp[1]}</p>
                      </div>
                    )}
                    <button
                      onClick={() => { openHelp(); setOpenDropdown(null); }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 text-left"
                    >
                      <span className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded font-mono">?</span>
                      Keyboard Shortcuts
                    </button>
                    <button
                      onClick={() => { setShowGlobalAddTransaction(true); setOpenDropdown(null); }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 text-left"
                    >
                      <span className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded font-mono">Alt+N</span>
                      Quick Add Transaction
                    </button>
                  </div>
                );
              })()}
            </div>
            <IdentityMenu />
          </div>
        </div>
      </nav>

      {/* Mobile Header — the same navy as the desktop bar, in both colour
          schemes (owner, 9 Nov 2026, from the iPhone Duo: "when in landscape
          view the top header is in our dark blue colour, but when in
          horizontal view the header is white"). One bar colour at every
          width, and the bell — painted for the navy bar and mounted here too
          — becomes visible on the phone, where white/60 on white had hidden
          it. The shell's status bar is set to light content to match
          (Info.plist UIStatusBarStyle). */}
      <header
        ref={mobileHeaderRef}
        className="md:hidden fixed top-0 left-0 right-0 z-40 bg-[#1a2332] shadow-md"
        // The status bar's room as well as the banner's — see TOP_CHROME_OFFSET.
        // This header carries the identity menu, so getting it wrong took the
        // only way to sign out on a phone behind the battery indicator.
        style={{ top: TOP_CHROME_OFFSET }}
        role="banner"
      >
        {/* The bar's OWN surface fills the offset above it (owner, 30 Aug:
            "there is a bit of dead space" — the status-bar inset and the
            demo-banner slot rendered as bare page background over the bar).
            The clock can overlap that zone on an installed app, so content
            cannot move into it — but it should read as the bar's shoulder,
            not as a gap. Same trick the slide-out menu uses: background to
            the physical top, geometry untouched. bottom-full, so it needs
            no arithmetic of its own. */}
        <div
          aria-hidden="true"
          className="absolute left-0 right-0 bottom-full bg-[#1a2332]"
          style={{ height: TOP_CHROME_OFFSET }}
        />
        <div className="flex items-center justify-between py-4" style={sidePadding('1rem')}>
          <button
            onClick={toggleMobileMenu}
            className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
            aria-label={isMobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={isMobileMenuOpen}
            aria-controls="mobile-menu"
            title={isMobileMenuOpen ? 'Close menu (Escape)' : 'Open menu (Alt+M)'}
          >
            {isMobileMenuOpen ? <XIcon size={24} /> : <MenuIcon size={24} />}
          </button>
          
          {/* The lockup has one colour and takes it from here: white, as on
              the desktop bar. */}
          <h1 className="text-white" id="mobile-app-title">
            <ReckleyLockup layout="horizontal" width={96} />
          </h1>
          
          <div className="flex items-center gap-2">
            <NotificationBell />
            <button
              onClick={() => {
                if (isMobileSearchVisible) {
                  setIsMobileSearchVisible(false);
                } else {
                  openMobileSearch();
                }
              }}
              className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
              aria-label="Search"
            >
              <SearchIcon size={20} />
            </button>
            <IdentityMenu />
          </div>
        </div>
      </header>

      {isMobileSearchVisible && (
        <div
          data-testid="mobile-search-container"
          className="md:hidden px-4 pb-3 bg-white dark:bg-gray-800 shadow-sm"
        >
          <GlobalSearch
            ref={mobileSearchRef}
            placeholder="Search transactions, accounts, budgets..."
            autoFocus
            onResultSelect={() => setIsMobileSearchVisible(false)}
          />
        </div>
      )}
      
      {/* Desktop icons now in search bar - section removed to prevent duplication */}

      {/* Mobile Menu */}
      {isMobileMenuOpen && (
        <div 
          className="md:hidden fixed inset-0 z-40 bg-black bg-opacity-50" 
          onClick={toggleMobileMenu}
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-menu-title"
        >
          <nav
            id="mobile-menu"
            className="focus-ring-on-dark w-full max-w-sm h-full bg-[#1a2332] dark:bg-gray-800 shadow-2xl overflow-y-auto rounded-r-2xl"
            // The drawer is `inset-0` so it starts at the WINDOW's top — which
            // on an installed home-screen app is under the status bar (and an
            // arriving notification banner), not below it. Both fixed headers
            // already stand off by this constant; the drawer was the one piece
            // of top chrome that didn't, so its "Reckley" title sat
            // behind the clock. Padding, not `top`, because the panel's
            // background should still reach the physical top of the screen.
            style={{ paddingTop: TOP_CHROME_OFFSET, paddingLeft: SIDE_INSET_LEFT }}
            onClick={e => e.stopPropagation()}
            role="navigation"
            aria-label="Mobile navigation menu"
          >
            {/* pb via the bottom chrome offset, not pb-6: this panel scrolls
                its own content, so the page gutter cannot rescue it — the
                menu's last entries (Subscription, the owner's report) lived
                behind the pill. */}
            <div className="p-4" style={{ paddingBottom: BOTTOM_CHROME_OFFSET }}>
              {/* Mobile header with close button */}
              <header className="flex justify-between items-center mb-8" role="banner">
                <h2 id="mobile-menu-title" className="text-white">
                  <ReckleyLockup layout="horizontal" width={120} />
                </h2>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => {
                      openMobileSearch();
                      toggleMobileMenu();
                    }}
                    className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600"
                    aria-label="Open global search"
                  >
                    <SearchIcon size={24} className="text-white dark:text-gray-300" />
                  </button>
                  <button
                    onClick={toggleMobileMenu}
                    className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600"
                    aria-label="Close navigation menu"
                  >
                    <XIcon size={24} className="text-white dark:text-gray-300" />
                  </button>
                </div>
              </header>
              <div className="space-y-2" role="none">
                {/* No "Home" entry, deliberately. It pointed at "/", the public
                    welcome page, which for a signed-in visitor lazy-loads a
                    marketing chunk only to flash "taking you to your
                    dashboard" and redirect here anyway — a longer road to the
                    same screen, plus a history entry that redirects again on
                    Back. The desktop nav has never had one and the bottom bar's
                    "Home" already points straight at the dashboard. One way to
                    your figures per navigation. */}
                <SidebarLink to="/dashboard" icon={BarChart3Icon} label="Dashboard" isCollapsed={false} onNavigate={toggleMobileMenu} />
                
                {/* Accounts with Sub-navigation (but no "All Accounts" redundancy) */}
                <div>
                  {/* THE ARROW EXPANDS, THE NAME NAVIGATES (owner, 21 Aug:
                      tapping Accounts' arrow went to the page, closed the
                      menu and flipped the flag — so the sub-pages only
                      appeared on the SECOND trip). The chevron is its own
                      button now: preventDefault stops the surrounding Link's
                      navigation, and the menu stays open showing the
                      sub-pages, exactly as the other headings behave.

                      h-12 on ALL FOUR grouped headings, and the number is this
                      row's, measured: the nested chevron button is held to the
                      44px touch minimum (index.css), which after its -m-2
                      stands a 28px flex item in the row — 48px with the
                      py-2.5. The other headings had no inner button, so they
                      sat at 40 (Settings) and 44 (Plan/Manage) beside this
                      one's 48 (owner, 21 Aug: "make the 3 others the same as
                      the accounts").

                      An explicit HEIGHT, not min-h-[48px] — that was tried and
                      measured at 44 on the two <button> rows, because the
                      touch block's `button:not(.toggle-switch)` scores (0,1,1)
                      against a utility's (0,1,0) and pins their min-height at
                      44. The same trap as the `position` line in that block's
                      own header comment. Used height = max(height, min-height)
                      = max(48, 44), so h-12 lands 48 on <a> and <button> rows
                      alike; md:h-auto hands the desktop back its own size. */}
                  <Link
                    to={isDemoModeRoutingEnabled ? '/accounts?demo=true' : '/accounts'}
                    onClick={toggleMobileMenu}
                    className="w-full flex items-center gap-2 px-3 py-2.5 md:py-2 rounded-lg transition-colors h-12 md:h-auto bg-secondary text-white dark:text-gray-300 hover:bg-secondary dark:hover:bg-gray-800/50"
                  >
                    <WalletIcon size={18} />
                    <span className="flex-1 text-sm text-left">Accounts</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setAccountsExpanded(!accountsExpanded);
                      }}
                      aria-expanded={accountsExpanded}
                      aria-label={accountsExpanded ? 'Hide the Accounts pages' : 'Show the Accounts pages'}
                      // The icon must LAND where the other headings' bare
                      // chevrons land: at the row's px-3 content edge. The
                      // touch rule holds this button at 44px wide and the old
                      // `p-2 -m-2` centred the icon in that box, which put it
                      // 7px left of its three siblings (owner, 21 Aug). So the
                      // icon is right-aligned inside the button instead:
                      // -mr-3 walks the border box out to the ROW's edge and
                      // pr-3 walks the icon back in by the same 12px — the
                      // row's own padding, restated, not a tuned offset. The
                      // vertical pair still cancels so the row stays 48px.
                      className="inline-flex items-center justify-end py-2 -my-2 pl-2 pr-3 -mr-3 rounded-lg"
                    >
                      <ChevronRightIcon
                        size={14}
                        className={`text-gray-400 transition-transform duration-200 ${accountsExpanded ? 'rotate-90' : ''}`}
                      />
                    </button>
                  </Link>
                  {/* THE SAME SHAPE AS THE DESKTOP ACCOUNTS MENU (owner,
                      17 Aug: "the drop-down headings … the same layout as the
                      main app"). Investments moved in from a top-level link
                      for the same reason it moved on desktop: a holding IS an
                      account. One layout, learned once. */}
                  {accountsExpanded && (
                    <div className="mt-1 space-y-1">
                      <SidebarLink to="/find" icon={SearchIcon} label="Find Transactions" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      <SidebarLink to="/investments" icon={TrendingUpIcon} label="Investments" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      <SidebarLink to="/reconciliation" icon={ArrowRightLeftIcon} label="Reconciliation" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      <SidebarLink to="/categorisation" icon={TagIcon} label="Categorisation" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      {CHROME_HAS_BANK_FEEDS && (
                        <SidebarLink to="/open-banking" icon={BankIcon} label="Bank Feeds" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      )}
                    </div>
                  )}
                </div>

                {/* Plan — Budget, Calendar and Recurring Payments, mirroring
                    the desktop menu. This group used to be "deliberately
                    absent" as desk work; the owner overruled it (17 Aug), and
                    the Calendar now carries the due-next panel, which is
                    exactly a thing to check from a phone.

                    THE NAME NAVIGATES, THE ARROW EXPANDS — the Accounts row's
                    arrangement exactly, and for the same reason it exists
                    there: since §9 (22 Aug) the group has a namesake page.
                    /forecast is titled Plan now, so tapping Plan opens it and
                    the chevron unfolds the group's other three pages. */}
                <div>
                  <Link
                    to={isDemoModeRoutingEnabled ? '/forecast?demo=true' : '/forecast'}
                    onClick={toggleMobileMenu}
                    className="w-full flex items-center gap-2 px-3 py-2.5 md:py-2 rounded-lg transition-colors h-12 md:h-auto bg-secondary text-white dark:text-gray-300 hover:bg-secondary dark:hover:bg-gray-800/50"
                  >
                    <TargetIcon size={18} />
                    <span className="flex-1 text-sm text-left">Plan</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setPlanExpanded(!planExpanded);
                      }}
                      aria-expanded={planExpanded}
                      aria-label={planExpanded ? 'Hide the Plan pages' : 'Show the Plan pages'}
                      className="inline-flex items-center justify-end py-2 -my-2 pl-2 pr-3 -mr-3 rounded-lg"
                    >
                      <ChevronRightIcon
                        size={14}
                        className={`text-gray-400 transition-transform duration-200 ${planExpanded ? 'rotate-90' : ''}`}
                      />
                    </button>
                  </Link>
                  {planExpanded && (
                    <div className="mt-1 space-y-1">
                      <SidebarLink to="/budget" icon={BarChart3Icon} label="Budget" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      <SidebarLink to="/calendar" icon={CalendarIcon} label="Calendar" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      <SidebarLink to="/recurring-payments" icon={ClockIcon} label="Recurring Payments" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                    </div>
                  )}
                </div>

                <SidebarLink to="/reports" icon={PieChartIcon} label="Reports" isCollapsed={false} onNavigate={toggleMobileMenu} />

                {/* Manage — data admin, exactly the desktop menu's list and
                    order. These lived under Settings here, which taught the
                    phone a different map from the desk (owner, 17 Aug: "on
                    the mobile there is no 'manage' section"). */}
                <div>
                  <button
                    type="button"
                    onClick={() => setManageExpanded(!manageExpanded)}
                    aria-expanded={manageExpanded}
                    className="w-full flex items-center gap-2 px-3 py-2.5 md:py-2 rounded-lg transition-colors h-12 md:h-auto bg-secondary text-white dark:text-gray-300 hover:bg-secondary dark:hover:bg-gray-800/50"
                  >
                    <SettingsIcon size={18} />
                    <span className="flex-1 text-sm text-left">Manage</span>
                    <ChevronRightIcon
                      size={14}
                      className={`text-gray-400 transition-transform duration-200 ${manageExpanded ? 'rotate-90' : ''}`}
                    />
                  </button>
                  {manageExpanded && (
                    <div className="mt-1 space-y-1">
                      <SidebarLink to="/settings/categories" icon={TagIcon} label="Categories" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      <SidebarLink to="/settings/payees" icon={UsersIcon} label="Payees" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      {/* Present since 28 Aug on desktop and missed here —
                          the mobile Manage list is a hand-copied twin of the
                          desktop's, and this is the drift that shape invites
                          (the owner went looking for it on his phone, 30
                          Aug). Same position as the desktop menu: between
                          Payees and Tags. */}
                      <SidebarLink to="/settings/duplicates" icon={SearchIcon} label="Duplicates" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      <SidebarLink to="/settings/tags" icon={HashIcon} label="Tags" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      <SidebarLink to="/transfer-links" icon={ArrowRightLeftIcon} label="Transfer Links" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      {/* "Import Data", as the desktop menu names it — one
                          page, one name, whichever menu found it. */}
                      <SidebarLink to="/enhanced-import" icon={UploadIcon} label="Import Data" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      <SidebarLink to="/export-manager" icon={DownloadIcon} label="Export Data" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      <SidebarLink to="/documents" icon={FolderIcon} label="Documents" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                    </div>
                  )}
                </div>

                {/* Settings — the app itself, exactly the desktop menu's list. */}
                <div>
                  <Link
                    to={isDemoModeRoutingEnabled ? '/settings?demo=true' : '/settings'}
                    onClick={() => setSettingsExpanded(!settingsExpanded)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 md:py-2 rounded-lg transition-colors h-12 md:h-auto bg-secondary text-white dark:text-gray-300 hover:bg-secondary dark:hover:bg-gray-800/50"
                  >
                    <SettingsIcon size={18} />
                    <span className="flex-1 text-sm text-left">Settings</span>
                    <ChevronRightIcon
                      size={14}
                      className={`text-gray-400 transition-transform duration-200 ${settingsExpanded ? 'rotate-90' : ''}`}
                    />
                  </Link>
                  {settingsExpanded && (
                    <div className="mt-1 space-y-1">
                      <SidebarLink to="/settings/app" icon={Settings2Icon} label="App Settings" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      <SidebarLink to="/settings/data" icon={DatabaseIcon} label="Data Management" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      <SidebarLink to="/settings/security" icon={ShieldIcon} label="Security" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                      <SidebarLink to="/subscription" icon={CreditCardIcon} label="Subscription" isCollapsed={false} isSubItem={true} onNavigate={toggleMobileMenu} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </nav>
        </div>
      )}

      {/* Main Content */}
      <main
        id="main-content"
        // A plain block child now — flex-1/min-w-0 died with the parent's
        // flex row. (Their history: min-w-0 once stopped a non-wrapping row
        // from inflating the layout viewport to 1438px; as a block, main is
        // simply the container's width and cannot be squeezed by siblings.)
        className="mt-16 md:mt-12"
        // The headers moved down by the status bar and the banner, so the
        // content below them has to as well — otherwise the first card slides
        // under a header that is now lower than the margin above assumes.
        // Padding rather than margin because the margin is responsive
        // (mt-16/md:mt-12) and this offset has to add to whichever of the two
        // applies, not replace it.
        style={{ paddingTop: TOP_CHROME_OFFSET }}
        role="main"
        aria-label="Main content"
        tabIndex={-1}
      >
        <NavigationProgress />
        
        {/* Desktop search bar moved into top nav */}
        
        <MobileBreadcrumb />
        {/* `page-bottom-gutter` rather than `pb-20`: the old value cleared the
            bottom nav and left the floating quick-add button sitting on top of
            whatever the page ended with. See index.css — the reservation is one
            number, beside the measurements it is made of. */}
        <div className="p-4 md:p-6 lg:p-8 max-w-[1600px] mx-auto page-bottom-gutter md:pb-8">
          <PageTransition>
            <Outlet />
          </PageTransition>
        </div>
      </main>
      
      <ViewportDebugOverlay />

      {/* The balance reminder, on whatever page you are on (owner, 29 Aug) —
          Layout is what makes that sentence true. */}
      <BalanceReminderCard />

      {/* The one offline surface that is true: the browser's own
          online/offline events, and the consequence stated plainly. The
          QUEUE furniture that used to sit beside it (status card, sync
          resolver, pending-count pill, offline quick-add, two conflict
          modals and their banners) listened to a sync layer nothing fed —
          no write path ever queued, nothing ever dispatched a conflict —
          and was retired with it on 1 Sep 2026. If a real offline queue is
          ever built, it arrives with the cloud↔local sync design, whose
          merge policy is reserved in services/conflictResolutionService.ts
          (see port-coverage manifest: preserved, not ported). */}
      <OfflineIndicator />

      {/* No "Update Available" prompt: there is no service worker to hold a
          waiting version, so a reload always has the current build. See the
          note at the foot of main.tsx. */}

      {/* PWA Install Prompt */}
      <PWAInstallPrompt />
      
      
      {/* Keyboard Shortcuts Help */}
      <KeyboardShortcutsHelp isOpen={isHelpOpen} onClose={closeHelp} />

      {/* Global Add Transaction Modal (Alt+N from any page) */}
      {showGlobalAddTransaction && (
        <Suspense fallback={null}>
          <QuickAddTransaction
            isOpen={showGlobalAddTransaction}
            onClose={() => setShowGlobalAddTransaction(false)}
          />
        </Suspense>
      )}
      
      {/* Keyboard Sequence Indicator */}
      <KeyboardSequenceIndicator activeSequence={activeSequence} />
      
      {/* Mobile Bottom Navigation */}
      <MobileBottomNav />

      {/* Floating Action Button removed from dashboard - using action buttons instead */}
    </div>
  );
}
