import { useState, useMemo, useEffect, useCallback, useRef, useId, Suspense, type ReactNode } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useApp } from '../contexts/AppContextSupabase';
import { useToast } from '../contexts/ToastContext';
import { dataPort } from '@data';
import { preserveDemoParam } from '../utils/navigation';
import { DEPTH_LEVEL_1, DEPTH_LEVEL_2 } from '../styles/depthShading';
import { WholePoundsScope, WholePoundsToggle } from '../contexts/WholePoundsContext';
import { NegativesInRedToggle, useNegativeTone } from '../contexts/NegativesInRedContext';
import { CHROME_HAS_BANK_FEEDS } from '@chrome';
import AddAccountModal from '../components/AddAccountModal';
import AccountSettingsModal from '../components/AccountSettingsModal';
import AccountBreakdownModal, { type AccountBreakdownView } from '../components/AccountBreakdownModal';
import NetWorthSummary from '../components/NetWorthSummary';
import { formatDate, formatDateTime } from '../utils/dateFormatter';
import { accountHasHistory } from '../utils/accountHistory';
// No longer importing from lucide-react - all icons are now custom
import { ArchiveIcon, SettingsIcon, CheckCircleIcon, CheckIcon, BankIcon, RefreshCwIcon, AlertTriangleIcon, ChevronRightIcon, ChevronDownIcon, XCircleIcon, SearchIcon } from '../components/icons';
// Both bank-feed surfaces on this page come through `@service`, the seam for
// what a shared page says about the account you hold WITH somebody. On a
// device the badge draws nothing and the hook answers no connections, which
// this page's own guards already handle — see src/editions/service.ts.
import { BankConnections, BankingCriticalIncidentBadge } from '@service';
import { LoadingState } from '../components/loading/LoadingState';
import { TRUELAYER_JWKS_CIRCUIT_EVENT_PREFIX } from '../constants/bankingOps';
import { preferences } from '../services/preferencesService';

// Bank connection management lives on this page (the natural home for it);
// the Data Management page keeps only its URL-driven deep links for ops alerts.
import type { Account } from '../types';
import {
  groupAccountsForDisplay,
  parseAccountGroupingPreference,
  serializeAccountGroupingPreference,
  ACCOUNT_GROUPING_STORAGE_KEY,
  LEGACY_ACCOUNT_GROUPING_STORAGE_KEY,
  DEFAULT_ACCOUNT_GROUPING,
  type AccountGroupingOptions,
  type AccountGroupKind,
  type AccountDisplayGroup,
} from '../utils/accountGrouping';

type AccountSortMode = 'default' | 'name' | 'name-desc' | 'balance-desc' | 'balance-asc';
import { IconButton } from '../components/icons/IconButton';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import {
  useConvertedNetWorth,
  type AccountBalanceEntry,
} from '../hooks/useConvertedNetWorth';
import { useInvestmentValuation } from '../hooks/useInvestmentValuation';
import { netWorthPointToken } from '../utils/netWorthSeries';
import { useNetWorthConversion } from '../hooks/useNetWorthConversion';
import { useReconciliation } from '../hooks/useReconciliation';
import { countAwaitingReviewByAccount } from '../utils/transactionReview';
import { useAccountBankSync } from '@service';
import { useAttentionLadder } from '../hooks/useAttentionLadder';
import PageWrapper from '../components/PageWrapper';
import PageTip from '../components/PageTip';
import { calculateTotalBalance } from '../utils/calculations-decimal';
import {
  buildChildrenByParent,
  buildTopLevelIdByAccountId,
  selectTopLevelAccounts,
} from '../utils/accountNesting';
import { buildSecuredByTarget, normaliseSecuredIds } from '../utils/accountSecuring';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { toDecimal, type DecimalInstance } from '../utils/decimal';
import EmptyState from '../components/EmptyState';
import FilteredEmptyState from '../components/FilteredEmptyState';
import { TableSkeleton, type TableSkeletonColumn } from '../components/loading/TableSkeleton';
import {
  AccountRowColumns,
  AccountColumnHeader,
  AccountBalanceCell,
  AccountCountCell,
  AccountRowEmptyCell,
  AccountRowActionSlot,
  ACCOUNT_ROW_SELECTED_CLASS,
  ACCOUNT_ROW_NAME_LINK_CLASS,
} from '../components/AccountRowColumns';
import { useArrivalRowFocus } from '../hooks/useArrivalFocus';
// The same predicate the Transactions table asks, kept in one place: a click on
// a row's own button belongs to the button, on both pages.
import { clickedOwnControl } from '../hooks/useRowClickGesture';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import { STICKY_UNDER_APP_BAR } from '../components/layout/chromeOffsets';
import {
  currentPageProvenance,
  readResumeCrumbs,
  withProvenance,
  type ProvenanceState,
} from '../utils/navigationProvenance';
import { compareNames } from '../utils/localeFormat';

/**
 * What an account row is shaped like, for the placeholder that waits in its
 * place (DESIGN_PASS §4).
 *
 * Two tracks, because that is what a row is at a glance: the name taking the
 * flexible track on the left, and the figures right-aligned in the fixed ones
 * ACCOUNT_ROW_COLUMNS_CLASS lays out. The second figure hides below `sm`
 * exactly as AccountBalanceCell's `smOnly` cell does, so the placeholder is one
 * column narrower on a phone in the same place the real row is.
 */
const ACCOUNT_SKELETON_COLUMNS: TableSkeletonColumn[] = [
  { key: 'name', className: 'flex-1' },
  { key: 'balance', width: '6.5rem' },
  { key: 'secondary', width: '7.5rem', className: 'hidden sm:block' },
];

/**
 * What a row measures: `p-3 sm:p-4` around the name, the institution line and
 * the row of figures. MEASURED in the running app at 1280px rather than added
 * up from the classes — the arithmetic said 88 and the DOM says 98, and a
 * placeholder 10px short of the row it stands in for is the layout shift this
 * pattern exists to prevent.
 */
const ACCOUNT_ROW_HEIGHT = 98;

/**
 * The two "Group by" switches as stored. Read through the shared parser, which
 * migrates the pre-toggle single choice — so someone whose page was grouped by
 * institution yesterday still sees institution bands today. localStorage can
 * throw outright (Safari private browsing), which must not stop the page
 * rendering, hence the catch as well as the parser's own.
 */
function readStoredGrouping(): AccountGroupingOptions {
  try {
    return parseAccountGroupingPreference(
      preferences.getItem(ACCOUNT_GROUPING_STORAGE_KEY),
      // The pre-toggle key is read from the BROWSER: it was written before
      // preferences travelled, so this migration has to look where it was left.
      localStorage.getItem(LEGACY_ACCOUNT_GROUPING_STORAGE_KEY)
    );
  } catch {
    return DEFAULT_ACCOUNT_GROUPING;
  }
}

/** A row's element id, so the arrow keys can hand it the focus by name. */
const rowDomId = (accountId: string): string => `account-row-${accountId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The way back FROM a register, as this page reads it.
 *
 * The mechanism is navigationProvenance's, unchanged: on the way into a
 * register this page writes its own crumbs (`{ accountId }`) into the
 * provenance it sends, and the register's back button hands exactly those
 * crumbs back — it never looks inside them, which is why each origin gets to
 * own its own shape. Parsed rather than trusted, because a history entry can
 * have been written by last week's build; anything unreadable reads as "an
 * ordinary arrival", which is the safe answer (no row is singled out).
 */
const readArrivalAccountId = (state: unknown): string | null => {
  const crumbs = readResumeCrumbs(state);
  if (!isRecord(crumbs)) return null;
  const accountId: unknown = crumbs.accountId;
  return typeof accountId === 'string' && accountId !== '' ? accountId : null;
};

/**
 * The list as it is DRAWN, once the search and the folds have had their say.
 *
 * Computed once and read twice — by the renderer, and by the arrow keys that
 * walk it — so "the rows on screen" cannot mean two different things. A model
 * built separately for the keyboard would skip a folded band on one of the two
 * and strand the highlight on a row nobody can see.
 */
interface DisplayedSubBand {
  label: string;
  title: string;
  /** The whole sub-band: its count and total describe this, not the filtered rows. */
  accounts: readonly Account[];
  /** What actually renders, sorted and filtered. */
  displayed: Account[];
  /**
   * Whether this institution is unfolded. Folded, it leaves its name, its count
   * and its total — which is what makes folding worth doing rather than merely
   * possible. Always true while searching; see where this is computed.
   */
  isExpanded: boolean;
}

interface DisplayedBand {
  group: AccountDisplayGroup<Account>;
  displayed: Account[];
  subBands: DisplayedSubBand[] | null;
  isExpanded: boolean;
}

/**
 * Where a band's converted total is filed.
 *
 * Module-level so the pass that BUILDS the totals and the pass that draws them
 * cannot drift into two different spellings of the same band. It happens to
 * read like `collapseKeyFor`; that is a coincidence of format, not a shared
 * meaning, and the two are deliberately not the same function.
 */
const bandTotalKey = (kind: AccountGroupKind, label: string): string => `${kind}:${label}`;
const subBandTotalKey = (kind: AccountGroupKind, label: string, subLabel: string): string =>
  `${kind}:${label}::${subLabel}`;

/** Stable identity for the single-currency case: no groups, so no conversion. */
const NO_GROUP_ENTRIES: ReadonlyMap<string, readonly AccountBalanceEntry[]> = new Map();

/**
 * A group total, ready to print, and the same thing said out loud.
 *
 * The two differ in exactly one place: `≈` is a glyph screen readers do not
 * reliably announce, so the spoken form says "approximately" and the visible
 * form keeps the mark the design pass asked for.
 */
interface BandTotalFigure {
  text: string;
  spoken: string;
  /**
   * The total as a number, for "Negatives in red" — or null where there is no
   * one number: a band whose currencies could not be converted is printed as
   * a pair of figures, and a pair has no sign.
   */
  amount: number | null;
}

type DisplayedList =
  | { mode: 'flat'; accounts: Account[] }
  | { mode: 'grouped'; bands: DisplayedBand[] };

export default function Accounts() {
  // The whole-pounds scope must sit above every useCurrencyDecimal call,
  // including this page's own — hence the thin shell (owner, 19 Aug:
  // page-specific decimal display).
  return (
    <WholePoundsScope page="accounts">
      <AccountsList />
    </WholePoundsScope>
  );
}

function AccountsList() {
  const { accounts, transactions, serverBalances, updateAccount, closeAccount, refreshAccountsAndTransactions, refreshCategories } = useApp();
  const { showError } = useToast();
  const { formatCurrency: formatDisplayCurrency, displayCurrency } = useCurrencyDecimal();
  // "Negatives in red" — the person's choice, off unless ticked. Every balance
  // this page draws asks this for its colour; see NegativesInRedContext.
  const negativeTone = useNegativeTone();
  const navigate = useNavigate();
  const location = useLocation();
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  // null = closed; 'critical'/'jwks' preset the ops filters the incident
  // badges deep-link to (mirrors the Data Management handlers).
  const [bankConnectionsView, setBankConnectionsView] = useState<null | 'plain' | 'critical' | 'jwks'>(null);
  const [settingsAccountId, setSettingsAccountId] = useState<string | null>(null);
  const [breakdownView, setBreakdownView] = useState<AccountBreakdownView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Two INDEPENDENT switches, not a choice of one: Account Type and Institution
  // each on or off. Both on nests institutions inside the type sections; both
  // off is a single flat list.
  const [grouping, setGrouping] = useState<AccountGroupingOptions>(readStoredGrouping);
  const [sortMode, setSortMode] = useState<AccountSortMode>(() => {
    const stored = preferences.getItem('accountsSortMode');
    return stored === 'name' || stored === 'name-desc' || stored === 'balance-desc' || stored === 'balance-asc'
      ? stored
      : 'default';
  });

  // Which group sections the user has folded away. With ~200 accounts the list
  // is unmanageable fully expanded, so a heading can be collapsed down to just
  // its name, count and running total (that total is the whole point of
  // collapsing — you still see what a section is worth without its rows).
  // Keyed by "<kind>:<label>" — the dimension the band groups BY, not the whole
  // view — so collapsing "Natwest" under Institution can never also collapse a
  // same-named section under Account Type, and a folded type section stays
  // folded when the Institution switch is flipped alongside it.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const stored = preferences.getItem('accountsCollapsedGroups');
      const parsed: unknown = stored ? JSON.parse(stored) : null;
      return Array.isArray(parsed)
        ? new Set(parsed.filter((key): key is string => typeof key === 'string'))
        : new Set<string>();
    } catch {
      // A corrupt value must never wedge the page — start with nothing collapsed.
      return new Set<string>();
    }
  });

  // Free-text filter over account (and institution) names. Kept out of
  // localStorage: it's a transient lens, not a saved preference — clearing it
  // returns the full grouped view. No debounce: the list is in memory and this
  // is a substring test over a couple of hundred rows.
  const [accountSearch, setAccountSearch] = useState('');

  /**
   * FOUR ROWS OF CONTROLS BEFORE ANY DATA — on the page whose content is a list.
   *
   * On a phone the toolbar stacks: search, Group by, Sort, then the feed
   * actions, each full width, together about 40% of the viewport above the
   * first account. P1 charges chrome rent, and four rows of it is more than
   * this page can pay before it has shown a single balance.
   *
   * Search and Sort stay: one finds an account among two hundred, the other
   * decides what the top of the list means, and both are wanted BEFORE
   * looking. Grouping and the two bank-feed actions go behind one switch —
   * grouping is a preference you set once and it persists, and the feeds are
   * an errand rather than a way of reading the list.
   *
   * A DISCLOSURE, NOT A MENU, AND NOT A HOOK.
   * The register's toolbar already solves this exact problem this exact way
   * (a button that reveals the rest of its controls), and the disclosure —
   * `aria-expanded` + `aria-controls` on a button that shows a block — is the
   * most-repeated control idiom in the app. A popover would be a fifth
   * hand-rolled anchored panel with its own focus management, which P7 calls a
   * bug report. And the reveal is a STYLE swap over one DOM, so it is Tailwind
   * classes rather than `useIsMobileViewport`, exactly as `useMediaQuery`'s own
   * doc comment instructs: the hook is for a component swap, and everything
   * else in this app is an `sm:` class.
   *
   * WHICH IS WHY THE DESKTOP CANNOT NOTICE. Every hidden thing is `sm:flex`
   * and the switch itself is `sm:hidden`, so from 640px up the browser
   * computes precisely what it computed before — same elements, same order,
   * same gaps — and this state is not consulted at all.
   *
   * No "active" dot on the switch, though the register has one. Grouping is ON
   * by default (`DEFAULT_ACCOUNT_GROUPING` is byType), so a dot meaning "a
   * control in here is set" would be lit for nearly every user nearly always,
   * and a light that is always on is not a signal. The banded list behind it
   * already says the list is banded.
   */
  /**
   * NULL UNTIL THE USER TOUCHES THE SWITCH — the default is decided by the
   * page, not stored here. Folded away is the right default only while there
   * is nothing behind the fold that demands attention; the moment there is (a
   * broken feed, rows to review, accounts to reconcile), a drawer that opens
   * shut is a drawer hiding an alarm, and the owner's report says what that
   * costs: "unless the user does it manually, they could easily miss that
   * there are things that need their attention" (21 Aug). So the resolved
   * value lives below the three signals it reads, and this state records only
   * an explicit choice — which then wins in both directions, because a person
   * who folded the drawer over a live warning has seen the warning.
   */
  const [moreControlsChoice, setMoreControlsChoice] = useState<boolean | null>(null);
  const controlsId = useId();
  const groupPanelId = `${controlsId}-group`;
  const feedPanelId = `${controlsId}-feeds`;

  // The mobile +'s "Add Account" deep-links /accounts?action=add — open the
  // modal and consume the param (replace), so back/refresh cannot re-open it.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('action') === 'add') {
      setIsAddModalOpen(true);
      params.delete('action');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    }
  }, [location.pathname, location.search, navigate]);

  const { getUnreconciledCount, computeAccountBalance: computeLedgerBalance } = useReconciliation(accounts, transactions);

  // This page's dialog dismisses only when the press AND the release are on
  // the backdrop — a selection that ends outside is not a dismissal.
  const closeBankConnections = useCallback(() => setBankConnectionsView(null), []);
  const bankConnectionsDismiss = useBackdropDismiss(closeBankConnections);

  /**
   * How much freshly-imported work is waiting in each account.
   *
   * The same mechanism the Unreconciled column beside it uses (useReconciliation
   * builds one per-account map from the transaction list and answers in
   * constant time): filtering the whole ledger inside each card would be
   * quadratic in the number of accounts, over a fifty-thousand row list, on a
   * page that re-renders on every sync.
   *
   * Not folded into useReconciliation, because it is not reconciliation. "Does
   * this account agree with the bank?" and "has anybody looked at what arrived?"
   * are two questions that happen to be counted the same way, and a hook that
   * answers both would be a hook named for one of them.
   */
  const toReviewByAccount = useMemo(
    () => countAwaitingReviewByAccount(transactions),
    [transactions]
  );

  // The transaction pages take seconds to arrive on a long history, and until
  // the first one lands every ledger sum is just the opening balance. The
  // server's one-round-trip figures (same invariant, summed in Postgres) stand
  // in for that window only — the ledger computation is the source of truth
  // and takes over the moment any transaction is present.
  const seededBalances = transactions.length === 0 ? serverBalances : null;
  const computeAccountBalance = useCallback(
    (accountId: string): number => seededBalances?.get(accountId)?.balance ?? computeLedgerBalance(accountId),
    [seededBalances, computeLedgerBalance]
  );
  // Per-account bank connection metadata + one-click "pull fresh bank data".
  const { getAccountLink, isAccountSyncing, syncAccount, syncAllConnections, connectedCount, feedsNeedingAttention, isSyncingAny } = useAccountBankSync({ onSynced: refreshAccountsAndTransactions });
  // WHAT THE APP IS POINTING AT — one rule, read by every amber-bearing
  // surface (Design's per-app ruling, 24 Aug). See utils/attentionLadder.
  const ladder = useAttentionLadder();

  // Only OPEN accounts appear in the main list and totals; closed ones live in
  // the Closed Accounts section below (the Microsoft Money model — closing
  // hides an account without touching its history, and it can be reopened).
  const openAccounts = useMemo(() => accounts.filter(a => a.isActive !== false), [accounts]);

  // Investment↔cash pairing (the Microsoft Money model): a cash account whose
  // parentAccountId points at another OPEN account renders nested inside that
  // parent's card instead of as a top-level card, and its balance counts
  // toward the parent's group total. It stays a full account — own register,
  // transfers, reconciliation — only its placement here changes. The rules
  // live in utils/accountNesting, shared with the Investments page so the two
  // can never disagree about what a paired account is worth.
  const nestedByParent = useMemo(() => buildChildrenByParent(openAccounts), [openAccounts]);

  /**
   * Secured liabilities, keyed by the account they are held AGAINST — a
   * mortgage under its property, a loan under the portfolio it is drawn on.
   *
   * Deliberately NOT built with `buildChildrenByParent`, even though the shape
   * is identical. That helper answers "where does this account's money belong",
   * and the answer for a secured liability is "exactly where it already is".
   * Everything downstream of the nesting utilities — the band totals, the
   * top-level walk, the portfolio summary — is right to count what it groups,
   * so this must not travel through any of it. A separate map that only the
   * renderer reads is the difference between showing a relationship and
   * asserting one.
   *
   * The target must be OPEN and must not be the liability itself, for the same
   * reason nesting checks it: a row keyed under a card that is not on the page
   * is a row nobody ever sees.
   */
  /**
   * WHETHER THE PER-ACCOUNT ACTION BUTTONS SHOW, on phones.
   *
   * ONE preference for the page, not one per account — the owner's ruling,
   * after weighing the per-account version: with 130 accounts that is 130
   * decisions, and the thing actually wanted is a shorter scroll. Default ON,
   * also his ruling: hiding Reconcile behind a tap on every account is only
   * worth it to somebody who chose it.
   *
   * Only meaningful below `lg`. The desktop grid keeps its buttons regardless,
   * so the control that flips this renders only where it does something —
   * a switch that visibly changes nothing teaches that switches do nothing.
   */
  const [showRowActions, setShowRowActions] = useLocalStorage<boolean>(
    'wt_accounts_row_actions',
    true
  );

  const securedByTarget = useMemo(() => buildSecuredByTarget(openAccounts), [openAccounts]);

  /**
   * The other end of the same link: what THIS account is secured against.
   *
   * `securedByTarget` answers "what is held against this asset"; this answers
   * "what is this debt held against". One relationship, two readings, and the
   * page needs both — a mortgage that says nothing about its house is only
   * half a label.
   *
   * Resolved against the accounts in view for the reason the other direction
   * is: the column carries no foreign key, so an id may name something closed,
   * filtered out, or deleted. All three want the same answer — print nothing
   * rather than a dangling reference.
   */
  const accountsById = useMemo(
    () => new Map(openAccounts.map(a => [a.id, a])),
    [openAccounts]
  );
  const securedTargets = useCallback(
    (account: Account): Account[] =>
      normaliseSecuredIds(account.securedAgainstAccountIds ?? [], account.id)
        .map(id => accountsById.get(id))
        .filter((a): a is Account => a !== undefined),
    [accountsById]
  );

  const topLevelAccounts = useMemo(() => selectTopLevelAccounts(openAccounts), [openAccounts]);
  const [closedAccounts, setClosedAccounts] = useState<Account[]>([]);
  const [showClosedAccounts, setShowClosedAccounts] = useState(false);
  const [reopeningId, setReopeningId] = useState<string | null>(null);

  /**
   * Still on screen? The closed list is fetched, and the fetch outlives the
   * page whenever somebody leaves before it lands — a state write after that is
   * a write to a component that no longer exists (and, under a test runner
   * tearing the DOM down, an intermittent failure in whatever suite happens to
   * be running next). Guarded here rather than only in the mount effect,
   * because every caller below is equally able to be the last one out.
   */
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const loadClosedAccounts = useCallback(async () => {
    try {
      const closed = await dataPort.listClosedAccounts();
      if (isMountedRef.current) setClosedAccounts(closed);
    } catch {
      // Non-fatal: the section simply shows empty; a retry happens on next open.
      if (isMountedRef.current) setClosedAccounts([]);
    }
  }, []);

  useEffect(() => {
    void loadClosedAccounts();
  }, [loadClosedAccounts]);

  const handleReopenAccount = useCallback(async (accountId: string) => {
    if (reopeningId) return;
    setReopeningId(accountId);
    try {
      await updateAccount(accountId, { isActive: true });
      // The reopened account isn't in context state (closed ones are filtered
      // out at load), so re-pull actives and refresh the closed list. The DB
      // trigger also re-activated its transfer category — refresh categories
      // so it reappears in dropdowns without a reload.
      await refreshAccountsAndTransactions();
      await refreshCategories();
      await loadClosedAccounts();
    } catch (error) {
      showError(error);
    } finally {
      setReopeningId(null);
    }
  }, [reopeningId, updateAccount, refreshAccountsAndTransactions, refreshCategories, loadClosedAccounts, showError]);

  // Convert accounts to decimal for calculations
  const decimalAccounts = useMemo(() => openAccounts.map(a => ({
    ...a,
    balance: toDecimal(a.balance),
    openingBalance: a.openingBalance ? toDecimal(a.openingBalance) : undefined,
  })), [openAccounts]);

  /**
   * Every open account's balance beside the currency it is HELD in.
   *
   * The input to the net-worth card's three figures. Until this existed the
   * card added balances across currencies one-for-one and printed the answer in
   * the display currency — a dollar counted as a pound. The app had already
   * written the rule down for budgets ("a number that is true in no currency at
   * all"); the summary above the account list was the surface still breaking it.
   */
  /**
   * The valuation term (slice 3b) joined the CARD's figures only, so that
   * the three headline numbers matched the dashboard trio and the reports —
   * while the rows kept their ledger balances, on the reasoning that an
   * account row states its register and the register's bottom line must be
   * findable on the page that links to it.
   *
   * ── THE OWNER'S CORRECTION, 29 AUGUST 2026 ────────────────────────────────
   * That left a page whose rows do not sum to its own headline. On a ledger
   * with a real portfolio the gap is enormous — measured on the showcase
   * data, rows summing to £1,409,684.92 under a net worth of £1,726,008.70,
   * the whole £316,323.78 being unrealised gain — and his verdict was the
   * one that matters: "the account balances do not add up to anywhere near
   * that … users looking at this will think the figures are wrong". He is
   * right, and a total nobody can reconstruct from what is on screen is worse
   * than either figure alone.
   *
   * Both halves of the old reasoning were sound, so the fix keeps both rather
   * than choosing: the ROW NOW STATES WHAT THE ACCOUNT IS WORTH — which is
   * what its group and the headline sum, so the arithmetic closes — and an
   * account whose worth differs from its register says so underneath, naming
   * the register figure and the unrealised gain that separates them. Two
   * numbers that differ are not a problem to hide; the problem was showing
   * one and totalling the other.
   *
   * What does NOT move: reconciliation and the register's running balance
   * stay ledger, always. You reconcile against a statement, and a statement
   * knows nothing of unrealised gains.
   */
  const valuation = useInvestmentValuation();
  const valuationDayKey = netWorthPointToken(new Date());
  /**
   * What an account is WORTH today: its register, plus the market's opinion
   * of the holdings inside it. Zero delta for every account without holdings,
   * so this is the ledger balance for all but investment accounts.
   */
  const computeValuedBalance = useCallback(
    (accountId: string): number =>
      toDecimal(computeAccountBalance(accountId))
        .plus(valuation.deltaAt(accountId, valuationDayKey))
        .toNumber(),
    [computeAccountBalance, valuation, valuationDayKey]
  );
  /** The unrealised gain alone — what separates the two figures, when it does. */
  const unrealisedGain = useCallback(
    (accountId: string): number => valuation.deltaAt(accountId, valuationDayKey).toNumber(),
    [valuation, valuationDayKey]
  );
  const netWorthEntries = useMemo(
    () => openAccounts.map(a => ({
      balance: toDecimal(computeAccountBalance(a.id)).plus(valuation.deltaAt(a.id, valuationDayKey)),
      currency: a.currency || displayCurrency,
    })),
    [openAccounts, computeAccountBalance, displayCurrency, valuation, valuationDayKey]
  );

  /**
   * Whether any account is held in something other than the display currency.
   *
   * The switch that keeps this change free for the people it does not concern.
   * False — the overwhelmingly common case — and the three figures below are
   * computed exactly as they have always been, by exactly the same functions,
   * to exactly the same number. No conversion, no request, no disclosure.
   */
  const spansCurrencies = useMemo(
    () => netWorthEntries.some(entry => entry.currency !== displayCurrency),
    [netWorthEntries, displayCurrency]
  );

  // The conversion itself is set up below, once the band decomposition it also
  // feeds (`groupCurrencyEntries`) exists — one pass converts the card and every
  // group header together. See `totalForBand`.

  // The open list's bands, straight from the two switches — type sections,
  // institution bands, type sections with institution sub-bands, or one flat
  // list. Nested cash accounts ride inside their parent's card, so only
  // top-level accounts band here. Bucketing by SECTION type (not the raw type
  // string) is what stops an "Other Assets" or 'mortgage' account vanishing
  // under a key no section ever looked up — see `sectionTypeForAccount`.
  const accountBands = useMemo(
    () => groupAccountsForDisplay(topLevelAccounts, grouping),
    [topLevelAccounts, grouping]
  );

  // Set loading to false when accounts are loaded
  useEffect(() => {
    if (accounts !== undefined) {
      setIsLoading(false);
    }
  }, [accounts]);
  
  // Convert transactions to decimal for balance calculations
  const decimalTransactions = useMemo(() => transactions.map(t => ({
    ...t,
    amount: toDecimal(t.amount),
  })), [transactions]);

  // Which top-level card an account's money counts toward: itself, or the
  // nearest ancestor that IS a top-level card. A nested cash account belongs to
  // the band its PARENT sits in (Investments), not the one its own type or
  // institution would suggest.
  const topLevelIdByAccountId = useMemo(
    () => buildTopLevelIdByAccountId(openAccounts),
    [openAccounts]
  );

  // A band's running total: every open account whose money counts toward one of
  // the band's cards, summed as Decimal (opening balance + its transactions) —
  // the same figure the net-worth bar shows, never floating-point arithmetic.
  const totalForBand = useCallback((bandAccounts: readonly Account[]): DecimalInstance => {
    const ids = new Set(bandAccounts.map(a => a.id));
    const counted = decimalAccounts.filter(a => ids.has(topLevelIdByAccountId.get(a.id) ?? a.id));
    // The ledger sum, plus what the market says the holdings inside it are
    // worth — so a band total equals the rows under it, and the bands equal
    // the headline above them (the owner's correction, 29 Aug — see the note
    // by `computeValuedBalance`).
    return counted.reduce(
      (sum, a) => sum.plus(valuation.deltaAt(a.id, valuationDayKey)),
      calculateTotalBalance(counted, decimalTransactions)
    );
  }, [decimalAccounts, decimalTransactions, topLevelIdByAccountId, valuation, valuationDayKey]);

  /**
   * The same band total as above, split into one line per currency HELD.
   *
   * Deliberately the same decomposition: identical account expansion, identical
   * `calculateTotalBalance`, merely partitioned by currency first. Because that
   * partition is a plain sum, these lines add back up to exactly the figure
   * `totalForBand` returns — so a converted band total is the band total this
   * page has always shown, converted, and never a second opinion about what the
   * band is worth.
   *
   * A nested account contributes its OWN currency, not its parent's: a dollar
   * cash sleeve inside a sterling investment account is still dollars.
   */
  const currencySubtotalsForBand = useCallback(
    (bandAccounts: readonly Account[]): AccountBalanceEntry[] => {
      const ids = new Set(bandAccounts.map(a => a.id));
      const inBand = decimalAccounts.filter(a => ids.has(topLevelIdByAccountId.get(a.id) ?? a.id));
      const buckets = new Map<string, typeof inBand>();
      for (const account of inBand) {
        const currency = account.currency || displayCurrency;
        const bucket = buckets.get(currency);
        if (bucket) bucket.push(account);
        else buckets.set(currency, [account]);
      }
      return [...buckets].map(([currency, bucket]) => ({
        balance: calculateTotalBalance(bucket, decimalTransactions),
        currency,
      }));
    },
    [decimalAccounts, decimalTransactions, topLevelIdByAccountId, displayCurrency]
  );

  /**
   * Every band and sub-band on the page, decomposed for the one conversion pass.
   *
   * Empty — and therefore free — whenever the ledger reads in one currency,
   * which is the common case: no decomposition, no map, no conversion, and the
   * headers below fall through to the untouched `totalForBand` path.
   */
  const groupCurrencyEntries = useMemo<ReadonlyMap<string, readonly AccountBalanceEntry[]>>(() => {
    if (!spansCurrencies || accountBands.mode !== 'grouped') return NO_GROUP_ENTRIES;
    const entries = new Map<string, readonly AccountBalanceEntry[]>();
    for (const group of accountBands.groups) {
      entries.set(bandTotalKey(group.kind, group.label), currencySubtotalsForBand(group.accounts));
      for (const sub of group.subGroups ?? []) {
        entries.set(
          subBandTotalKey(group.kind, group.label, sub.label),
          currencySubtotalsForBand(sub.accounts)
        );
      }
    }
    return entries;
  }, [spansCurrencies, accountBands, currencySubtotalsForBand]);

  /**
   * ONE conversion for the whole page: the net-worth card's three figures and
   * every group header's total, off one rate table, resolved in one state
   * update.
   *
   * That single call is what makes the ruling's coherence requirement
   * structural rather than aspirational. A group total cannot look confident
   * while the card above it reads degraded, because neither figure has a
   * provenance of its own to disagree with — there is one, and the `≈` on a
   * group total is a pointer to it (`ConvertedTotalNote`, under the card).
   */
  const convertedNetWorth = useConvertedNetWorth(
    netWorthEntries,
    displayCurrency,
    groupCurrencyEntries
  );

  /**
   * Per-ACCOUNT factors for the breakdown modal's rows (currency audit,
   * 22 Aug): the card above converts its three figures, and the drill behind
   * it summed native — the two disagreed the moment a second currency was
   * held. Same module-level rates cache as the card's own conversion, so the
   * factors cannot quote a different rate. Null on a single-currency ledger.
   */
  const { conversion: breakdownConversion } = useNetWorthConversion(openAccounts);

  // Each switch flips on its own: both on nests, both off flattens.
  const handleGroupingChange = (next: AccountGroupingOptions) => {
    setGrouping(next);
    try {
      preferences.setItem(ACCOUNT_GROUPING_STORAGE_KEY, serializeAccountGroupingPreference(next));
    } catch {
      // Storage unavailable — the choice still applies for this session.
    }
  };

  const handleSortChange = (value: AccountSortMode) => {
    setSortMode(value);
    preferences.setItem('accountsSortMode', value);
  };

  // Fold a group open/closed and persist the whole collapsed set, so the choice
  // survives a reload. Takes the fully-qualified "<kind>:<label>" key.
  const toggleGroupCollapsed = useCallback((key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      preferences.setItem('accountsCollapsedGroups', JSON.stringify([...next]));
      return next;
    });
  }, []);

  // Order accounts WITHIN each group. 'default' keeps insertion order (as
  // loaded); balance sorts use Decimal comparison on the computed ledger
  // balance — ordering only, never arithmetic.
  const sortAccounts = useCallback((list: Account[]): Account[] => {
    if (sortMode === 'default') {
      return list;
    }
    const sorted = [...list];
    if (sortMode === 'name' || sortMode === 'name-desc') {
      sorted.sort((a, b) => compareNames(a.name, b.name));
      if (sortMode === 'name-desc') sorted.reverse();
    } else {
      sorted.sort((a, b) => {
        // Ranked by what the ROW shows, which since 29 Aug is what the
        // account is worth — sorting by a figure the page does not print
        // would look like a broken sort.
        const comparison = toDecimal(computeValuedBalance(a.id))
          .comparedTo(toDecimal(computeValuedBalance(b.id)));
        return sortMode === 'balance-desc' ? -comparison : comparison;
      });
    }
    return sorted;
  }, [sortMode, computeValuedBalance]);

  const handleClose = (accountId: string) => {
    if (window.confirm('Close this account? It moves to the Closed Accounts section — every transaction is preserved and you can reopen it at any time. Its transfer category is hidden from transaction dropdowns while closed.')) {
      void (async () => {
        try {
          await closeAccount(accountId);
          // The DB trigger deactivated the account's transfer category —
          // refresh categories so it leaves dropdowns without a reload.
          await refreshCategories();
          await loadClosedAccounts();
        } catch (error) {
          showError(error);
        }
      })();
    }
  };

  // ── Which rows are on screen ───────────────────────────────────────────────

  // Search matching. An empty query matches nothing here on purpose — the
  // caller only filters while `isSearching`, so the full grouped view is what
  // shows when the box is clear.
  const normalizedSearch = accountSearch.trim().toLowerCase();
  const isSearching = normalizedSearch.length > 0;
  const accountMatchesSearch = useCallback(
    (account: Account): boolean =>
      account.name.toLowerCase().includes(normalizedSearch) ||
      (account.institution?.toLowerCase().includes(normalizedSearch) ?? false),
    [normalizedSearch]
  );
  // A nested cash account rides inside its parent's card, never as a card of its
  // own, so a hit on the child keeps the parent in the results (the child still
  // shows nested inside it) rather than vanishing with nowhere to appear.
  const accountOrChildMatches = useCallback(
    (account: Account): boolean =>
      accountMatchesSearch(account) ||
      (nestedByParent.get(account.id) ?? []).some(accountMatchesSearch),
    [accountMatchesSearch, nestedByParent]
  );
  /*
   * ─ THE TRAVELLING AMBER, AND THE VIEW IT OPENS ─────────────────────────────
   *
   * With institutions and sections foldable, a page in summary form can hide
   * every account that has work waiting in it: "if I do have everything hidden
   * ... if I have anything to review or to reconcile, it could be very hard to
   * know that unless I periodically opened everything up and scrolled down them
   * all to check."
   *
   * The answer is ONE control that names the next job and carries its count,
   * and a view that shows only the accounts that job belongs to.
   *
   * ─ WHY ONE CONTROL AND NOT TWO ────────────────────────────────────────────
   * Ruling A gives amber to the ONE control you should touch next, so two amber
   * controls side by side would be the erosion it exists to prevent — and the
   * owner's first sketch, an amber column HEADING, would also have made a label
   * into a control. Instead this borrows the reconciliation page's travelling
   * yellow: the colour sits on the step you are on and MOVES as you finish it.
   * Review comes before reconcile because you file what arrived before you
   * agree the balance it lands in, so "next" has an order and the control can
   * simply follow it.
   *
   * A BROKEN FEED OUTRANKS BOTH, which is what keeps the count at exactly one
   * amber on the page: money that is not arriving makes the figures wrong,
   * where unfiled money only makes them untidy. Bank connections keeps the
   * colour while a feed is down and this control waits its turn.
   */
  const reviewTotal = useMemo(
    () => topLevelAccounts.reduce(
      (sum, a) => sum + (toReviewByAccount.get(a.id) ?? 0)
        + (nestedByParent.get(a.id) ?? []).reduce((n, c) => n + (toReviewByAccount.get(c.id) ?? 0), 0),
      0
    ),
    [topLevelAccounts, nestedByParent, toReviewByAccount]
  );

  const reconcileAccountCount = useMemo(
    () => topLevelAccounts.filter(
      a => getUnreconciledCount(a.id) > 0
        || (nestedByParent.get(a.id) ?? []).some(c => getUnreconciledCount(c.id) > 0)
    ).length,
    [topLevelAccounts, nestedByParent, getUnreconciledCount]
  );

  // The phone's "More" drawer opens ITSELF while anything behind it needs
  // attention — the same three signals the buttons inside it wear amber for.
  // Derived, not effect-set: the signals arrive as data loads, and a default
  // written into state once at mount would be computed from an empty ledger.
  const showMoreControls = moreControlsChoice
    ?? (feedsNeedingAttention > 0 || reviewTotal > 0 || reconcileAccountCount > 0);

  /** Which job the page is focused on, or null for the ordinary list. */
  const [focusMode, setFocusMode] = useState<'review' | 'reconcile' | null>(null);

  /**
   * The folds to put back when focus ends. Null means "there were none to
   * restore", which is the owner's stated fallback: come back to everything
   * folded to institution level rather than to a wall of rows.
   */
  const foldsBeforeFocusRef = useRef<Set<string> | null>(null);

  /** Does this account (or a cash account nested in it) carry the focused work? */
  const accountHasFocusedWork = useCallback(
    (account: Account): boolean => {
      const has = (id: string): boolean =>
        focusMode === 'review'
          ? (toReviewByAccount.get(id) ?? 0) > 0
          : getUnreconciledCount(id) > 0;
      return has(account.id) || (nestedByParent.get(account.id) ?? []).some(c => has(c.id));
    },
    [focusMode, toReviewByAccount, getUnreconciledCount, nestedByParent]
  );

  const isFocused = focusMode !== null;

  /**
   * Enter a focus view, remembering the folds so leaving can put them back.
   * Switching straight from one job to the other keeps the ORIGINAL folds:
   * the snapshot is taken on the way in and not overwritten on the way across.
   */
  const enterFocus = useCallback((mode: 'review' | 'reconcile'): void => {
    setFocusMode(prev => {
      if (prev === null) {
        foldsBeforeFocusRef.current = new Set(collapsedGroups);
      }
      return mode;
    });
  }, [collapsedGroups]);

  /**
   * Leave, and put the page back the way it was found — the owner's choice
   * between the two endings he offered. The fallback is his other one: when
   * there was nothing folded to restore, everything folds to institution level
   * rather than dropping the reader into a wall of rows.
   */
  const exitFocus = useCallback((): void => {
    const restored = foldsBeforeFocusRef.current;
    foldsBeforeFocusRef.current = null;
    setFocusMode(null);
    if (restored !== null && restored.size > 0) {
      setCollapsedGroups(restored);
      return;
    }
    // Built from the SOURCE bands rather than the displayed ones: the displayed
    // list is still narrowed to the focused work at this moment, so folding
    // "everything on screen" would fold only the handful just dealt with.
    const everyInstitution = new Set<string>();
    if (accountBands.mode === 'grouped') {
      for (const group of accountBands.groups) {
        for (const sub of group.subGroups ?? []) {
          everyInstitution.add(subBandCollapseKeyFor(group.label, sub.label));
        }
      }
    }
    setCollapsedGroups(everyInstitution);
  }, [accountBands]);


  /**
   * ARRIVING BACK MID-ROUND: a register whose review queue just emptied — or
   * a reconciliation just finished — sends the user here with ?focus=<mode>,
   * consumed and deleted like the register's own deep-link params. Focus
   * resumes only while that mode still has work — with nothing left anywhere,
   * the round is over and this is the ordinary Accounts page (owner, 19 Aug:
   * "until there is no more accounts to review after which you get taken
   * back to the Accounts Page overall", and the same round for reconciling).
   */
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const focus = params.get('focus');
    if (focus !== 'review' && focus !== 'reconcile') return;
    params.delete('focus');
    const hasWork = focus === 'review' ? reviewTotal > 0 : reconcileAccountCount > 0;
    if (hasWork) enterFocus(focus);
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }, [location.pathname, location.search, reviewTotal, reconcileAccountCount, enterFocus, navigate]);

  const matchedTopLevelCount = isSearching
    ? topLevelAccounts.filter(accountOrChildMatches).length
    : topLevelAccounts.length;

  /**
   * THE CLOSED BAND OBEYS THE SEARCH, LIKE EVERYTHING ELSE ON THE PAGE.
   *
   * It did not, and a phone capture caught what that costs: "87 of your
   * accounts are hidden by Search: …" printed directly above a live
   * **Closed Accounts (110)** band. The page was simultaneously reporting that
   * nothing matched and showing a group larger than the count it had just
   * quoted. Either half could be defended alone; together they say the search
   * cannot be trusted, on the page where trusting it is the whole point.
   *
   * The filter is the same predicate the open list uses — `accountMatchesSearch`
   * rather than `accountOrChildMatches`, because nesting is an OPEN-list idea:
   * `nestedByParent` is built from open accounts and closed rows are always
   * drawn flat, so a closed account has no child that could keep it on screen.
   *
   * Three consequences follow, and they are all just "the count means what is
   * on screen":
   *   · a search that matches no closed account renders no band at all;
   *   · a search that matches one still shows it — the user asked for it by
   *     name, and an archive that hides a name you typed is worse than no
   *     archive;
   *   · the heading counts the rows in the band, not the rows in the database.
   */
  const matchedClosedAccounts = useMemo(
    () => (isSearching ? closedAccounts.filter(accountMatchesSearch) : closedAccounts),
    [isSearching, closedAccounts, accountMatchesSearch]
  );

  // Closed accounts get the SAME grouping as the open list, in all four switch
  // combinations, so the archive reads the way the live list does. Rows within
  // a group are alphabetical by name; that was the whole point of this change
  // (they used to arrive in no order at all). The grouping preserves input
  // order, so sorting once up front sorts every band. Empty bands don't render.
  // Kept independent of `sortMode`: the live list's Value/Default sorts are for
  // triage, but an archive you're scanning for one name always wants A–Z.
  const closedAccountBands = useMemo(
    () => groupAccountsForDisplay(
      [...matchedClosedAccounts].sort((a, b) => compareNames(a.name, b.name)),
      grouping
    ),
    [matchedClosedAccounts, grouping]
  );

  // The archive's fold is the user's while they are browsing, and the search's
  // while they are searching — same rule, and the same words, as the open
  // bands above.
  const closedBandExpanded = showClosedAccounts || isSearching;

  // The collapsed-set key and the region id both key off the band's dimension
  // and label — see `collapsedGroups` for why the dimension is part of the key.
  const collapseKeyFor = (kind: AccountGroupKind, label: string) => `${kind}:${label}`;

  /*
   * A SUB-BAND'S FOLD BELONGS TO ITS SECTION, not to the institution alone.
   *
   * This keyed on `institution:<label>` when institutions first learned to fold,
   * and I wrote the consequence down as though stating it made it acceptable:
   * folding "Coutts" folded it in every type section at once. The owner hit
   * exactly that — "if all my Coutts accounts are showing and I 'hide' my Coutts
   * credit card account, all of my Coutts accounts hide, including the current
   * accounts and the investment account. I would want it that if I want to hide
   * my Coutts current accounts but keep in view my Coutts investment account I
   * would want to."
   *
   * He is right and the original reasoning was wrong. The argument for keying by
   * dimension is that a fold should survive the grouping switches being flipped
   * — but a fold the user cannot aim is worth less than one that does not
   * survive a switch, and "hide this bank's credit cards" is a thing a person
   * actually wants where "hide this bank everywhere at once" is not.
   *
   * The section is part of the key; the `institution:` prefix stays so a
   * sub-band can never collide with a top-level band of the same name.
   */
  const subBandCollapseKeyFor = (sectionLabel: string, institutionLabel: string) =>
    `institution:${sectionLabel}:${institutionLabel}`;
  const groupRegionId = (kind: AccountGroupKind, label: string) =>
    `account-group-${kind}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

  /**
   * The whole list, decided once: which bands survive the search, which are
   * folded away, and the accounts inside each — sorted as the Sort switch says.
   *
   * The renderer walks this, and so does the keyboard. That is the point: the
   * arrows must move through exactly the rows a person can see, and a second
   * model built for them would eventually disagree with the first about a
   * folded band or a filtered row.
   */
  const displayedList = useMemo<DisplayedList>(() => {
    /*
     * SEARCH AND FOCUS NARROW THE LIST THE SAME WAY, through one predicate, so
     * the two can never disagree about which rows are on screen. Focus is
     * simply a different question asked of the same machinery: search asks
     * "does this match what I typed", focus asks "does this carry the work I
     * am doing". Both then force every surviving band open, because a fold
     * that swallowed a hit would defeat either of them.
     */
    const narrowing = isSearching || isFocused;
    const survives = (account: Account): boolean =>
      (!isSearching || accountOrChildMatches(account)) &&
      (!isFocused || accountHasFocusedWork(account));

    if (accountBands.mode === 'flat') {
      return {
        mode: 'flat',
        accounts: sortAccounts(
          narrowing ? accountBands.accounts.filter(survives) : accountBands.accounts
        ),
      };
    }
    const bands: DisplayedBand[] = [];
    for (const group of accountBands.groups) {
      const displayed = narrowing ? group.accounts.filter(survives) : group.accounts;
      // A search that hides its own hits would be worse than no search, so a
      // band with no match drops out entirely instead of showing an empty card.
      // Focus behaves identically: a section with nothing to review is not a
      // section with an empty list, it is a section that is finished.
      if (narrowing && displayed.length === 0) continue;
      // Sub-bands are filtered the same way, and an all-miss sub-band drops out
      // while its siblings keep their headings.
      const subBands = group.subGroups
        ?.map(sub => ({
          label: sub.label,
          title: sub.title,
          accounts: sub.accounts,
          displayed: sortAccounts(narrowing ? sub.accounts.filter(survives) : sub.accounts),
          /*
           * AN INSTITUTION FOLDS TOO, on the same terms as the section above it.
           * "It means that if I just want to see an institutions summary — name
           * and total amount I can … it may help make the scrolling less if you
           * want to hide some accounts on view."
           *
           * The same key shape as a top-level band, `institution:<label>`, and
           * that has a consequence worth stating rather than discovering:
           * folding "Coutts" folds it in EVERY type section it appears in, and
           * a Coutts folded here stays folded if the Account Type switch is
           * turned off and Coutts becomes a top-level band. That is the design
           * `collapsedGroups` already committed to — the key names the
           * DIMENSION and the label, never the path — and the alternative
           * (keying by "which section is it under") would lose the fold every
           * time the grouping switches flip, which is exactly what that comment
           * says it set out to avoid.
           *
           * Search ignores the fold for the same reason it does above: a folded
           * institution must not swallow a row the user is hunting for.
           */
          isExpanded: narrowing || !collapsedGroups.has(subBandCollapseKeyFor(group.label, sub.label)),
        }))
        .filter(sub => sub.displayed.length > 0) ?? null;
      bands.push({
        group,
        displayed: sortAccounts(displayed),
        subBands,
        // While searching, collapse is deliberately ignored: a folded section
        // must not swallow a result the user is actively looking for.
        isExpanded: narrowing || !collapsedGroups.has(collapseKeyFor(group.kind, group.label)),
      });
    }
    return { mode: 'grouped', bands };
  }, [accountBands, isSearching, isFocused, accountHasFocusedWork, accountOrChildMatches, sortAccounts, collapsedGroups]);

  /**
   * Every row on screen, top to bottom.
   *
   * A nested cash account follows its parent, because that is where it is
   * drawn: it is a row like any other — its own register, its own figures — and
   * arrowing down a card only to jump over the cash sitting inside it would be
   * the list disagreeing with itself.
   */
  const navigableRowIds = useMemo<string[]>(() => {
    const withNested = (list: readonly Account[]): string[] =>
      list.flatMap(account => [
        account.id,
        ...(nestedByParent.get(account.id) ?? []).map(child => child.id),
      ]);
    if (displayedList.mode === 'flat') return withNested(displayedList.accounts);
    const ids: string[] = [];
    for (const band of displayedList.bands) {
      if (!band.isExpanded) continue;
      if (band.subBands) {
        for (const sub of band.subBands) ids.push(...withNested(sub.displayed));
      } else {
        ids.push(...withNested(band.displayed));
      }
    }
    return ids;
  }, [displayedList, nestedByParent]);

  // ── The register's selection idiom, brought to the list ────────────────────

  /**
   * The row the user has picked out, if any.
   *
   * The same three gestures the register answers to: click a row's plain
   * background to select it (the NAME is a link, and opens the account —
   * selecting is what the rest of the row means), walk the selection with the
   * arrows, Enter to open, Escape to let go. Nothing here writes anything: a
   * selection is a place to be, not a change to the ledger.
   */
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  /**
   * Where the user is coming back FROM, when it is a register they opened here.
   *
   * The crumb is read straight off the live location rather than kept in state:
   * it belongs to the history entry, so the browser's own Back button restores
   * it too, and a re-render cannot lose it.
   */
  const arrivalAccountId = readArrivalAccountId(location.state);
  const { isFocused: isArrivalRow, focusRef: scrollArrivalRowIntoView } =
    useArrivalRowFocus(arrivalAccountId);

  // Arriving from a register selects the row you left, so the way back lands
  // you exactly where you were — highlighted, floating, and with the arrows
  // live from that row.
  useEffect(() => {
    if (arrivalAccountId !== null) setSelectedAccountId(arrivalAccountId);
  }, [arrivalAccountId]);

  /**
   * The arrival row itself: focused, then scrolled into the middle of the view.
   *
   * Focus first and WITHOUT its own scrolling, so the hook's centring is the
   * one that decides where the row lands. Focus rather than highlight alone
   * because the point of coming back is to carry on from there — the arrows
   * have to be live without hunting for the list with the Tab key.
   */
  const arrivalRowRef = useCallback((node: HTMLDivElement | null): void => {
    node?.focus({ preventScroll: true });
    scrollArrivalRowIntoView(node);
  }, [scrollArrivalRowIntoView]);

  /** The path into an account's register, demo session and all. */
  const registerPath = useCallback(
    (accountId: string): string => preserveDemoParam(`/accounts/${accountId}`, location.search),
    [location.search]
  );

  /**
   * What this page hands the register on the way in.
   *
   * `path` and `label` are what the register's back button becomes — the same
   * words it has always shown, because this IS the accounts list. `resume` is
   * this page's own note to itself, handed back untouched when the user
   * returns (see readArrivalAccountId).
   */
  const registerLinkState = useCallback(
    (accountId: string): ProvenanceState =>
      withProvenance(currentPageProvenance(location, 'Back to Accounts', { accountId })),
    [location]
  );

  const openAccount = useCallback((accountId: string): void => {
    navigate(registerPath(accountId), { state: registerLinkState(accountId) });
  }, [navigate, registerPath, registerLinkState]);

  /**
   * Pick a row out, and give it the keyboard.
   *
   * The focus is what makes the arrows live on the row just clicked, without a
   * second click to "focus the list" — the same courtesy the register does for
   * its grid. preventScroll because the click proves the row is already on
   * screen.
   */
  const selectRow = useCallback((accountId: string, node: HTMLElement | null): void => {
    setSelectedAccountId(accountId);
    node?.focus({ preventScroll: true });
  }, []);

  /**
   * Jump to another account ON THIS PAGE — pick it out and bring it to the
   * middle.
   *
   * A BUTTON, not a Link, and that is the whole design. The secured-liability
   * labels point at accounts that are already on this page, so routing to
   * `/accounts` to arrive back where you started would remount the list,
   * collapse nothing usefully, and lose the scroll position on the way. This
   * is an in-page jump and is built as one.
   *
   * `center` for the same reason the arrow keys use it: the owner asked that a
   * picked-out row sit in the middle rather than wherever the least possible
   * scroll happened to leave it. Clamping at the ends needs no code — a
   * container cannot scroll past its own extent.
   *
   * If the target is inside a folded band it is unfolded first, or the scroll
   * would target an element that is not rendered and silently do nothing.
   */
  const jumpToAccount = useCallback((accountId: string): void => {
    setCollapsedGroups(prev => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      next.clear();
      return next;
    });
    // After the unfold has painted, or getElementById finds nothing.
    requestAnimationFrame(() => {
      const node = document.getElementById(rowDomId(accountId));
      setSelectedAccountId(accountId);
      node?.focus({ preventScroll: true });
      node?.scrollIntoView?.({ block: 'center' });
    });
  }, []);

  /**
   * Walk the selection by `delta` rows, across sections and into the cash rows
   * nested in a card.
   *
   * With nothing selected yet the key selects the row it was pressed on — the
   * list is being entered, and jumping to a neighbour of nowhere would be a
   * surprise. The ends stop rather than wrap, which is what every list the user
   * already knows does.
   */
  const moveSelection = useCallback((fromRowId: string, delta: number): void => {
    if (navigableRowIds.length === 0) return;
    // -1 covers both "nothing selected" and "the selected row is filtered away"
    // — in either case this key is an arrival on the row it was pressed on.
    const currentIndex = selectedAccountId === null ? -1 : navigableRowIds.indexOf(selectedAccountId);
    const nextId = currentIndex === -1
      ? fromRowId
      : navigableRowIds[Math.min(navigableRowIds.length - 1, Math.max(0, currentIndex + delta))];
    if (nextId === undefined) return;
    setSelectedAccountId(nextId);
    const node = document.getElementById(rowDomId(nextId));
    // The row is already rendered — only its tabindex changes — so it can be
    // handed the focus directly.
    //
    // `center`, NOT `nearest`. `nearest` is defined as "scroll the least that
    // makes it visible", which means it does nothing at all while the row is
    // on screen and then jumps when it reaches an edge — the owner's report:
    // "the page doesn't move until the highlighted account is out of sight,
    // then the page starts scrolling". It reads as a stall followed by a lurch.
    //
    // `center` keeps the selection in the middle and the list moving under it,
    // which is what the register already does (useArrivalFocus) and is the
    // behaviour he asked this page to match. The clamping he described at the
    // ends — "unless you are that near the bottom or the top that the page
    // cannot move any more" — needs no code: a scroll container cannot scroll
    // past its own extent, so the row simply walks up or down the screen there.
    node?.focus({ preventScroll: true });
    node?.scrollIntoView?.({ block: 'center' });
  }, [navigableRowIds, selectedAccountId]);

  /**
   * The keys, on the row that has the focus.
   *
   * On the ROW rather than on the page, which is what keeps them out of the way
   * of everything else here: a search box, a sort button or a group heading has
   * the focus while it is being used, so the arrows never reach this at all.
   * There is no window-level listener to fight with.
   */
  const handleRowKeyDown = useCallback((
    event: React.KeyboardEvent<HTMLDivElement>,
    accountId: string
  ): void => {
    // A key pressed inside one of the row's own controls belongs to that
    // control: Enter on the Reconcile button must reconcile, not re-open the
    // account underneath it.
    if (event.target !== event.currentTarget) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        // Claimed outright: the page must not also scroll, and the app-wide
        // shortcut listener must not see a key the list has answered.
        event.preventDefault();
        event.stopPropagation();
        moveSelection(accountId, event.key === 'ArrowDown' ? 1 : -1);
        break;
      case 'Enter':
        event.preventDefault();
        event.stopPropagation();
        openAccount(accountId);
        break;
      case 'Escape':
        // Claimed ONLY when there is something to let go of. Escape belongs to
        // whatever layer is outermost, and a list holding nothing is not a
        // layer — the register keeps the same rule.
        if (selectedAccountId === null) return;
        event.preventDefault();
        event.stopPropagation();
        // Let go of the row, and leave the focus where it is: the user is still
        // standing here, they have simply stopped pointing at anything.
        setSelectedAccountId(null);
        break;
      default:
        break;
    }
  }, [moveSelection, openAccount, selectedAccountId]);

  /**
   * The row Tab lands on: the selected one, or the first if the selection is
   * nowhere to be seen.
   *
   * That second case is real — search for something the selected row does not
   * match and it stops being drawn. Without the fallback the list would have no
   * tab stop at all, and the whole thing would be unreachable from the keyboard
   * until the box was cleared.
   */
  const tabStopRowId = selectedAccountId !== null && navigableRowIds.includes(selectedAccountId)
    ? selectedAccountId
    : navigableRowIds[0];

  /**
   * Everything that makes a div one of this list's rows.
   *
   * Shared by both kinds of row — the account card and the cash row nested in
   * it — because they are the same thing to a keyboard: a place the selection
   * can be.
   *
   * ─ ONE TAB STOP FOR THE WHOLE LIST ─────────────────────────────────────────
   * Roving tabindex: one row (see tabStopRowId) is the tab stop, and every
   * other row is reached from it with the arrows. With two hundred accounts a
   * page that made each row its own tab stop would take two hundred presses to
   * get past.
   *
   * ─ WHY aria-current AND NOT aria-selected ──────────────────────────────────
   * aria-selected belongs to an option, a row or a tab — it says nothing on a
   * plain card, and giving the list grid semantics to earn it would have to
   * demote the account names from headings, which is how a screen-reader user
   * navigates this page. aria-current is the marker the app's other "this is
   * the one you came for" surfaces already use (see useArrivalFocus), and the
   * row itself takes the focus as the selection moves, so the reader announces
   * the row rather than relying on the marker alone.
   */
  const rowProps = (accountId: string) => {
    const isSelected = selectedAccountId === accountId;
    return {
      id: rowDomId(accountId),
      tabIndex: accountId === tabStopRowId ? 0 : -1,
      'aria-current': isSelected ? ('true' as const) : undefined,
      onClick: (event: React.MouseEvent<HTMLDivElement>): void => {
        // A nested cash row sits INSIDE its parent's card: whatever this click
        // means, it means it for one row only.
        event.stopPropagation();
        // A click on the name, or on any of the row's buttons, is that
        // control's — the row keeps out of it.
        //
        // No useRowClickGesture here, and the reason is worth stating: that
        // hook exists for a gesture that BEGINS in an editing control and ends
        // on the row, which the browser then reports as a click on the row. A
        // row on this page has no editing controls at all — a link and some
        // buttons, whose clicks are caught by the test above — and its text is
        // drawn `select-none` (the same answer VirtualizedTable gives its
        // clickable rows), so there is no drag for it to be the tail of.
        if (clickedOwnControl(event.target, event.currentTarget)) return;
        selectRow(accountId, event.currentTarget);
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>): void => handleRowKeyDown(event, accountId),
    };
  };

  /**
   * The look of a row that is selected, or the one it has when it is not.
   *
   * ─ NEITHER SKIN DECLARES A FOCUS RING ──────────────────────────────────────
   * Both used to carry `focus:outline-none focus-visible:ring-2
   * focus-visible:ring-blue-500`, and that was a duplicate: every focusable
   * element in the app already gets `outline: 2px solid var(--focus-ring-color)`
   * from accessibility-colors.css, with `!important`, so the `outline-none`
   * never took and the row drew ITS ring INSIDE that outline. Arrowing down a
   * selected row therefore showed three strokes' worth of intent in two
   * colours — the owner reported it as "a blue and a black double border" —
   * while clicking the same row looked clean, because a click does not match
   * :focus-visible. One focus indicator, app-wide, is the rule; a row does not
   * get a private one.
   */
  const rowSkin = (accountId: string, unselected: string): string =>
    selectedAccountId === accountId ? ACCOUNT_ROW_SELECTED_CLASS : unselected;

  /**
   * A row's routine actions — VISIBLE AT REST, on every row.
   *
   * ─ WHY THIS DEPARTS FROM THE DESIGN PASS, DELIBERATELY ─────────────────────
   * DESIGN_PASS_2026-08 §3.3 asked for two things about these buttons, and they
   * are separable. The objection was "twelve outlined boxes on a four-account
   * screen, and the destructive one is as loud as the routine ones" — a wall of
   * chrome in front of the figures the page exists to show. The remedy had two
   * halves: take the BOXES off, and reveal what is left on hover.
   *
   * The boxes are gone and stay gone: borderless glyphs in a neutral grey, the
   * delete no louder than the rest until it is hovered. That is where nearly
   * all of the noise was, and it is the half the owner liked on sight.
   *
   * The hover reveal is the half that came back off (owner's call, 2026-08-13,
   * after living with it). A control nobody can see is a control most people
   * never learn they have: hovering to discover what a row can do is a cost
   * paid on every row by everyone who does not already know, and the
   * touch-screen case had to be special-cased out of it precisely because the
   * interaction does not exist there. Quiet and always present beats loud, but
   * it also beats invisible — and P1's complaint was that the chrome was
   * SHOUTING, not that it existed. Told to the design author as a notice, in
   * the same spirit as the period-pin amendment.
   *
   * If this ever goes back the other way, the thing to keep is what the old
   * implementation got right: never `display: none`. A hidden button is not
   * reachable by Tab, so these were kept in the DOM and in the tab order at
   * zero opacity, and the touch case was gated on `hover: hover` because a
   * phone can never satisfy the reveal.
   */
  const ROW_ACTION_REVEAL_CLASS = 'transition-opacity duration-state';

  /**
   * "Agree this account with the bank" — the same control for every row.
   *
   * One function rather than one per row type, because a nested cash account
   * reconciles exactly as its parent does: same screen, same `from=accounts` so
   * the way back is right, and scoped to ITS id. It used to have no reconcile
   * button at all, which meant the only paired accounts in the book — the
   * Money-imported investment sleeves, the ones whose cash actually moves —
   * were the ones you could not reconcile from the list.
   *
   * Named for the account it belongs to: a card now shows two of these, and
   * "Reconcile" twice over is a control nobody can tell apart by ear.
   */
  /*
   * WHERE A COUNT'S WORK IS DONE. Two doors, one per column, and neither is a
   * new destination — Unreconciled goes exactly where the row's own Reconcile
   * button goes, and To Review goes to the register the account name already
   * opens, arriving with the register's existing To Review filter switched on.
   * The feature is the shortcut, not a new screen.
   */
  const reconcileHref = (accountId: string): string =>
    preserveDemoParam(
      `/reconciliation?account=${accountId}&from=accounts${
        focusMode === 'reconcile' ? '&back=accounts-reconcile' : ''}`,
      location.search
    );

  /*
   * From the FOCUSED list the link carries a way back: reviewing an account's
   * arrivals is one stop on a round, so finishing returns to this page still
   * focused, to pick the next account — not to the register just cleared
   * (owner, 19 Aug). From the ordinary list the register keeps you, as ever.
   */
  const reviewHref = (accountId: string): string =>
    preserveDemoParam(
      `/accounts/${accountId}?review=1${focusMode === 'review' ? '&back=accounts-review' : ''}`,
      location.search
    );

  const renderReconcileButton = (account: Account): ReactNode => (
    <button
      type="button"
      onClick={() => navigate(
        reconcileHref(account.id),
        // The SAME crumbs the register is sent, so the trip back lands on this
        // row rather than at the top of the list — see `registerLinkState`.
        { state: registerLinkState(account.id) }
      )}
      /* A routine row action, so it wears the routine row action's ink — the
         same neutral pair the Settings glyph beside it carries. The amber
         reconnect and the red delete keep their hues because those two are the
         ones that mean something; a stock blue on Reconcile meant only that a
         colour was going spare (stock-blue ruling, 28 Aug). */
      className={`p-3 min-w-[48px] min-h-[48px] flex items-center justify-center text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-lg relative group ${ROW_ACTION_REVEAL_CLASS}`}
      title={`Reconcile ${account.name}`}
      aria-label={`Reconcile ${account.name}`}
    >
      <CheckCircleIcon size={20} />
      <span className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1.5 text-xs text-white bg-gray-900/90 dark:bg-gray-700/90 backdrop-blur-sm rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-200 whitespace-nowrap pointer-events-none shadow-lg border border-white/10">
        Reconcile
      </span>
    </button>
  );

  // ONE card for every grouping view — identical layout, stats and actions
  // (settings / sync / reconcile / close) regardless of how the list is
  // grouped (Steve: 'similar looking format across all our views').
  const renderAccountCard = (account: Account) => {
    const bankLink = getAccountLink(account.id);
    const syncing = isAccountSyncing(account.id);
    // No TypeIcon/typeColor here any more — the row stopped drawing a per-account
    // type glyph (see the name row below). The two helpers that fed them went
    // with it: the BAND headings have always drawn their own icon through
    // `bandHeadingIcon`, so nothing else was reading them. Lint is what caught
    // the first version of this comment claiming otherwise.
    // '' when the date is absent or unparseable — formatDate answers that way
    // rather than throwing or handing back "Invalid Date".
    const lastUpdated = formatDate(account.lastUpdated);
                  return (
                  <div
                    key={account.id}
                    ref={isArrivalRow(account.id) ? arrivalRowRef : undefined}
                    {...rowProps(account.id)}
                    // `group/row` is what reveals the row's action buttons on
                    // hover and on focus — named, because each button already
                    // owns an unnamed `group` for its tooltip.
                    //
                    // A ROW, NOT A CARD, when it is not selected: no shadow and
                    // no visible border, so the ONLY lifted thing on the page is
                    // the selected row, which is what makes that lift read
                    // (§3.3). The rounding stays and is simply invisible while
                    // the row is white on white — it is there for the selected
                    // state, whose wash and ring do show it.
                    //
                    // THE BASE OWNS THE BORDER'S WIDTH, EACH STATE ITS COLOUR.
                    // 1px on all four sides at all times is geometry: take it
                    // away for one state and the card moves 1px as it is picked
                    // out. The COLOUR is a different question with a different
                    // answer per state, so the divider hairline travels with the
                    // unselected skin below and the selected skin names its own
                    // (transparent — the ring is its only stroke). It used to
                    // live here, on both states at once, which meant a selected
                    // row drew the divider AND Tailwind's default #e5e7eb on the
                    // other three sides underneath the ring: the two-tone border
                    // this comment exists to keep from coming back.
                    className={`group/row p-3 sm:p-4 rounded-2xl border transition-all duration-300 cursor-pointer select-none ${rowSkin(
                      account.id,
                      // `dark:last:` as well as `last:`, and it is not
                      // belt-and-braces. Both `dark:border-b-gray-700` and
                      // `last:border-b-transparent` set border-bottom-color at
                      // equal specificity, so the winner is decided by the order
                      // Tailwind happens to emit them in — and `dark:` is
                      // emitted last, so in DARK MODE the band's final row drew
                      // a divider under it while light mode correctly drew
                      // none. Stacking the two variants raises the suppression
                      // above the plain `dark:` rule instead of hoping the
                      // generator keeps its current order.
                      'bg-white dark:bg-gray-800 border-transparent border-b-line dark:border-b-gray-700 last:border-b-transparent dark:last:border-b-transparent hover:bg-surface-secondary dark:hover:bg-gray-700/40'
                    )}`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        {/* NO TYPE ICON ON THE ROW. Every account carried a
                            16px glyph saying what KIND it is — and it sat
                            inside a band already headed "Current Accounts",
                            with its own icon, above rows that are all that
                            kind. It repeated the heading once per row and
                            bought nothing: the owner, "do we need the icons
                            next to every account name? I think we dont, and it
                            is just used up space especially with the limited
                            real estate we have on mobile."

                            The band headings keep theirs, which is where the
                            distinction is actually being drawn — one icon per
                            KIND rather than one per row. Worth ~24px of a
                            phone's width back on every line, on the page whose
                            names were overflowing it. */}
                        <div className="flex items-center gap-2">
                          {/* The name is the way IN — a real link, so it can be
                              opened in a new tab, followed from the keyboard,
                              or copied as an address. The rest of the row means
                              "pick this one out", which is why the two are not
                              the same gesture any more.

                              The heading still takes the whole track (the
                              phone-width balance to its right is pushed there by
                              this flex-1, and the link's max-width is measured
                              against it) — but the LINK inside it hugs its own
                              letters, so the empty part of the track belongs to
                              the row. See ACCOUNT_ROW_NAME_LINK_CLASS.

                              The heading no longer clips: with the link capped
                              at the heading's width there is nothing left to
                              overflow, and `truncate` here used to hide the
                              link's own focus ring — an ancestor's overflow
                              clips a descendant's outline, so the account name
                              showed no keyboard focus at all. */}
                          <h3 className="text-base md:text-lg font-medium min-w-0 flex-1">
                            <Link
                              to={registerPath(account.id)}
                              state={registerLinkState(account.id)}
                              className={`${ACCOUNT_ROW_NAME_LINK_CLASS} text-gray-900 dark:text-white`}
                              title={`Open ${account.name}`}
                            >
                              {account.name}
                            </Link>
                          </h3>
                          {/* The figure the card exists to show, where a
                              banking list puts it: right of the name. The
                              stats row's copy hides below sm to avoid saying
                              it twice. */}
                          <span className={`sm:hidden shrink-0 text-base font-semibold tabular-nums ${negativeTone(computeValuedBalance(account.id), 'text-gray-900 dark:text-white')}`}>
                            {formatDisplayCurrency(computeValuedBalance(account.id), account.currency)}
                          </span>
                        </div>
                        {/* THE INSTITUTION LINE IS GONE (owner, 16 August).
                            Under Group by: Institution the account already sits
                            inside a band headed COUTTS or HSBC, so printing it
                            again under every name says the same word twice
                            within an inch — clutter on a desktop and a whole
                            line of it on a phone.

                            Removed rather than made conditional on the
                            grouping: a row that gains and loses a line
                            depending on a toggle elsewhere is harder to read
                            than one that never had it, and the band heading
                            answers the question in both groupings. */}
                        {/* This line read "Last updated: Invalid Date" for any
                            account whose date was absent — a raw
                            `new Date(x).toLocaleDateString()` printing the
                            parser's failure straight onto a page about money
                            (§3.3). Two things were wrong with it, and both are
                            fixed here: it never went through formatDate(), the
                            app's own formatter, which is null-safe AND pins the
                            UK dd/mm/yyyy this app formats every other date in
                            (a bare toLocaleDateString takes the BROWSER's
                            locale); and an absent date has a plain-English
                            answer, so it gets one instead of a parser artefact.

                            `Account.lastUpdated` is typed as a required Date but
                            is not one at runtime on every path — see the note in
                            utils/demoData, where the field was simply missing. */}
                        {/* DESKTOP ONLY, from `sm` up (owner, 16 August). Two
                            timestamp lines under every account is three lines
                            of chrome per row on a phone, where vertical space
                            is the scarce thing and neither answers a question
                            somebody is asking while scanning a list. They stay
                            where there is room for them. */}
                        <p className="hidden sm:block text-xs text-gray-500 dark:text-gray-300">
                          {lastUpdated ? `Last updated: ${lastUpdated}` : 'Not yet synced'}
                        </p>
                        {/* ─ THE LINK, READ FROM THE DEBT'S END ──────────────
                            The asset already prints "Linked liabilities: …".
                            Without this the relationship was only legible from
                            one side, so a mortgage told you nothing about the
                            house it is held against unless you happened to
                            scroll to the house.

                            Same rule as the other end and for the same reason:
                            NO FIGURE. A balance printed beside the name of an
                            asset invites the subtraction, and this link is a
                            label rather than a sum. A name cannot be added up.

                            Resolved against the accounts in view, so a target
                            that is closed, filtered out or deleted prints
                            nothing rather than a dangling id — the column has
                            no foreign key, and all three cases look the same
                            from here. */}
                        {securedTargets(account).length > 0 && (
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            <span className="font-medium">Secured against:</span>{' '}
                            {securedTargets(account).map((target, i) => (
                              <span key={target.id}>
                                {i > 0 && ', '}
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); jumpToAccount(target.id); }}
                                  /* `inline`, deliberately: `index.css` makes every button
                                     inline-FLEX, and a flex box will not break a long
                                     account name across lines — it would sit on one
                                     line and push the row sideways, which is the
                                     overflow this page was fixed for once already.
                                     `inline` beats the element rule on specificity and
                                     lets these read as what they are: words in a
                                     sentence. `min-h-0` for the same reason the row's
                                     name link carries it — the touch block floors every
                                     button at 44px, which would space these out.

                                     THE DOTTED UNDERLINE IS THE LINK. These
                                     navigate, and the ruling's answer for in-app
                                     navigation is the pair `text-primary
                                     hover:text-secondary` — but this one
                                     deliberately declines a resting colour (it
                                     is a word inside a grey caption, and
                                     `.text-primary` carries `!important`), and
                                     the hover half cannot be taken alone because
                                     `.dark .text-secondary`'s lift lives on the
                                     resting class. Exactly the case
                                     AccountRowColumns' name link already ruled
                                     on. So the hover is the same neutral
                                     emphasis this page's row glyphs use, and the
                                     stock blue is gone (28 Aug). */
                                  className="inline text-left underline decoration-dotted underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200 min-h-0"
                                  title={`Go to ${target.name}`}
                                >
                                  {target.name}
                                </button>
                              </span>
                            ))}
                          </p>
                        )}
                        {bankLink && (
                          <p className="hidden sm:block text-xs text-gray-500 dark:text-gray-300">
                            Last bank sync:{' '}
                            {bankLink.lastSync
                              ? formatDateTime(new Date(bankLink.lastSync))
                              : 'Never'}
                            {bankLink.status === 'reauth_required' && (
                              <span className="ml-1 text-amber-600 dark:text-amber-400">
                                · reconnect needed
                              </span>
                            )}
                          </p>
                        )}

                      </div>
                      
                      {/* The columns. Their definition — and the reason the
                          nested cash row below reads down the same lines — is
                          in components/AccountRowColumns. */}
                      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
                            <AccountRowColumns>
                              {/* AN EM-DASH, NOT "N/A" (Claude Design §4). The
                                  register and the reconciliation bar were both
                                  moved off "N/A" and this, their sibling
                                  surface, was missed — the third time a fix has
                                  landed on one screen and not the one beside it.

                                  The distinction it draws is load-bearing: an
                                  account with no bank feed has no bank balance,
                                  which is not the same as a bank balance of
                                  nothing. "N/A" is also an abbreviation the rest
                                  of the app does not use anywhere. */}
                              <AccountBalanceCell
                                label="Bank Bal"
                                value={account.bankBalance != null
                                  ? formatDisplayCurrency(account.bankBalance, account.currency)
                                  : null}
                                amount={account.bankBalance ?? null}
                              />
                              {/* WHERE THE TWO FIGURES DIFFER, BOTH ARE SAID —
                                  INSIDE one cell. An investment account is
                                  worth its market value, which is what the row
                                  and every total above it show; its register's
                                  own bottom line rides beneath as a second
                                  smaller line, for whoever is reconciling.
                                  It was briefly a TENTH AccountBalanceCell,
                                  which wrapped the nine-track grid: the owner
                                  watched the delete button fall onto the next
                                  line while every column slid one place
                                  right — the exact failure the template's
                                  header warns about. A cell may say more; a
                                  row may not grow columns. */}
                              <AccountBalanceCell
                                label="Account Bal"
                                value={formatDisplayCurrency(computeValuedBalance(account.id), account.currency)}
                                amount={computeValuedBalance(account.id)}
                                secondary={Math.abs(unrealisedGain(account.id)) >= 0.01
                                  ? `${formatDisplayCurrency(computeAccountBalance(account.id), account.currency)} in the register`
                                  : undefined}
                                smOnly
                              />
                              <AccountCountCell
                                label="Unreconciled"
                                count={getUnreconciledCount(account.id)}
                                to={reconcileHref(account.id)}
                                toState={registerLinkState(account.id)}
                                openLabel={`Reconcile ${account.name}`}
                              />
                              {/* To Review — freshly imported rows nobody has
                                  dealt with, so the size of the job is visible
                                  from the list rather than only from inside the
                                  register. It sits after Unreconciled because
                                  the two are the same shape of question — how
                                  much is outstanding — and reading them as a
                                  pair is the point. */}
                              <AccountCountCell
                                label="To Review"
                                count={toReviewByAccount.get(account.id) ?? 0}
                                to={reviewHref(account.id)}
                                openLabel={`Review transactions in ${account.name}`}
                              />
                              {/* ─ FIVE FIXED SLOTS, ON THEIR OWN LINE ─────
                                  MEASURED at 375px: the four stat cells and
                                  the five action slots were siblings of one
                                  `flex flex-wrap`, so the wrap point moved with
                                  the BUTTON COUNT — a three-button account put
                                  settings at (302, 0) and reconcile at
                                  (242, 48), a four-button one shifted them all.

                                  Five 44px slots is 220px and the stats need
                                  ~254px, so the two cannot share a line at this
                                  width. `w-full` gives the actions their own,
                                  which is what makes the slots FIXED: every
                                  account draws the same five columns whether it
                                  has three buttons or four, and an absent one
                                  leaves its column empty rather than pulling
                                  the others along.

                                  It also settles the labels riding high. Flex
                                  centres within each LINE — the stats used to
                                  share theirs with whichever button fitted, so
                                  39px cells sat at the top of a 92px row. On a
                                  line of their own there is nothing to be high
                                  against.

                                  `lg:contents` leaves the desktop grid exactly
                                  as it was: the wrapper dissolves and the five
                                  slots become direct children of the nine-column
                                  grid again. */}
                              <div className={`${showRowActions ? 'grid' : 'hidden'} w-full grid-cols-5 justify-items-end gap-1 lg:contents`}>
                              {/* The "View Portfolio" slot, kept EMPTY rather
                                  than removed: the five slots are what hold the
                                  other four buttons in the same column on every
                                  row, and dropping one would move them all.

                                  What used to be here read `account.holdings`,
                                  a field that has not existed in the database
                                  since holdings moved to their own table —
                                  `api/accountMapping` lists it in
                                  NOT_ACCOUNT_COLUMNS and strips it from every
                                  write, so nothing ever populated it and the
                                  button never appeared. Holdings are opened from
                                  the Investments page, which reads the table
                                  they actually live in. */}
                              <AccountRowActionSlot />

                              {/* Feed slot — rendered for every account so
                                  the three buttons to its right never move. */}
                              <AccountRowActionSlot>
                                {bankLink && (bankLink.status === 'reauth_required' ? (
                                  <div className="relative group">
                                    <IconButton
                                      onClick={() => navigate(preserveDemoParam('/open-banking', location.search))}
                                      icon={<AlertTriangleIcon size={20} />}
                                      variant="ghost"
                                      size="md"
                                      className="text-amber-500 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 hover:bg-amber-100/50 dark:hover:bg-amber-900/30 min-w-[48px] min-h-[48px]"
                                      title="Reconnect bank"
                                    />
                                    <span className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1.5 text-xs text-white bg-gray-900/90 dark:bg-gray-700/90 backdrop-blur-sm rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-200 whitespace-nowrap pointer-events-none shadow-lg border border-white/10">
                                      Reconnect bank
                                    </span>
                                  </div>
                                ) : (
                                  // Routine, so it fades with the rest. A sync
                                  // in flight is not routine — it is something
                                  // happening to this account right now, so a
                                  // spinning icon stays visible.
                                  <div className={`relative group ${syncing ? '' : ROW_ACTION_REVEAL_CLASS}`}>
                                    <IconButton
                                      onClick={() => void syncAccount(account.id)}
                                      icon={<RefreshCwIcon size={20} className={syncing ? 'animate-spin' : ''} />}
                                      variant="ghost"
                                      size="md"
                                      disabled={syncing}
                                      /* Routine ink, as Settings and Reconcile
                                         wear it (stock-blue ruling, 28 Aug). */
                                      className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 min-w-[48px] min-h-[48px]"
                                      title="Sync bank data"
                                    />
                                    <span className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1.5 text-xs text-white bg-gray-900/90 dark:bg-gray-700/90 backdrop-blur-sm rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-200 whitespace-nowrap pointer-events-none shadow-lg border border-white/10">
                                      {syncing ? 'Syncing…' : 'Sync bank data'}
                                    </span>
                                  </div>
                                ))}
                              </AccountRowActionSlot>
                              <AccountRowActionSlot>
                                <div className={`relative group ${ROW_ACTION_REVEAL_CLASS}`}>
                                  <IconButton
                                    onClick={() => setSettingsAccountId(account.id)}
                                    icon={<SettingsIcon size={20} />}
                                    variant="ghost"
                                    size="md"
                                    className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 min-w-[48px] min-h-[48px]"
                                    title={`Account settings for ${account.name}`}
                                  />
                                  <span className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1.5 text-xs text-white bg-gray-900/90 dark:bg-gray-700/90 backdrop-blur-sm rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-200 whitespace-nowrap pointer-events-none shadow-lg border border-white/10">
                                    Settings
                                  </span>
                                </div>
                              </AccountRowActionSlot>
                              <AccountRowActionSlot>{renderReconcileButton(account)}</AccountRowActionSlot>
                              <AccountRowActionSlot>
                                {/* Neutral until it is hovered. It is the
                                    destructive one, and drawing it permanently
                                    red made it the loudest thing on a row of
                                    routine controls — the colour belongs to
                                    the moment the pointer is actually on it. */}
                                <div className={`relative group ${ROW_ACTION_REVEAL_CLASS}`}>
                                  <IconButton
                                    onClick={() => handleClose(account.id)}
                                    icon={<ArchiveIcon size={20} />}
                                    variant="ghost"
                                    size="md"
                                    className="text-gray-500 hover:text-expense dark:text-gray-400 dark:hover:text-red-300 hover:bg-red-100/50 dark:hover:bg-red-900/30 min-w-[48px] min-h-[48px]"
                                    title={`Close ${account.name}`}
                                  />
                                  <span className="absolute bottom-full right-0 mb-2 px-3 py-1.5 text-xs text-white bg-gray-900/90 dark:bg-gray-700/90 backdrop-blur-sm rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-200 whitespace-nowrap pointer-events-none shadow-lg border border-white/10">
                                    Close
                                  </span>
                                </div>
                              </AccountRowActionSlot>
                              </div>
                            </AccountRowColumns>
                      </div>
                    </div>

                    {/* Nested cash accounts (investment↔cash pairing): the
                        Money model shows the pair as one account, cash inside.

                        A ROW LIKE ANY OTHER, from here down. It is inset on the
                        LEFT — the dashes, the indent, the wallet mark and the
                        word Cash are what say it belongs to the card above it —
                        and from the figures rightwards it is its parent's twin:
                        the same columns, in the same places, so Account Bal sits
                        under Account Bal and its Reconcile button under its
                        parent's. It has always been a full account (its own
                        register, its own transfers, its own reconciliation);
                        this is the list finally saying so.

                        `sm:pr-0` is what puts its right-hand edge where the
                        card's is: the pill sits INSIDE the card's padding, so
                        any padding of its own would hold the columns short of
                        the parent's by that much. What is left is the pill's
                        own 1px border — a hairline, and its own outline, which
                        is a better thing to leave alone than to cancel with a
                        negative margin somebody would later have to explain. */}
                    {(nestedByParent.get(account.id) ?? []).map(child => {
                      const childName = child.name === `${account.name} (Cash)` ? 'Cash' : child.name;
                      return (
                        <div
                          key={child.id}
                          ref={isArrivalRow(child.id) ? arrivalRowRef : undefined}
                          {...rowProps(child.id)}
                          className={`group/row mt-3 ml-6 sm:ml-9 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 rounded-xl border border-dashed pl-3 pr-3 sm:pr-0 py-2.5 cursor-pointer select-none transition-colors ${rowSkin(
                            child.id,
                            'border-gray-300 dark:border-gray-500 bg-gray-100 dark:bg-gray-700/60 hover:border-gray-400 dark:hover:border-gray-400'
                          )}`}
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            {/* The wallet glyph went 16 August, by the rule
                                that has taken every other per-row icon on this
                                page: the row already says "Cash" and "Cash
                                account" in words, so a wallet beside them named
                                the thing a third time in a picture — and in a
                                teal that appears nowhere else on the page. The
                                owner: "everywhere else we have taken them away
                                has looked better." */}
                            <div className="flex-1 min-w-0">
                              {/* The same link as the card's, and the same
                                  reason for hugging: this one reads plain
                                  "Cash", four letters against a row as wide as
                                  its parent's, so a stretched anchor here left
                                  the largest dead zone on the page. */}
                              <p className="text-sm font-medium">
                                <Link
                                  to={registerPath(child.id)}
                                  state={registerLinkState(child.id)}
                                  className={`${ACCOUNT_ROW_NAME_LINK_CLASS} text-gray-800 dark:text-gray-200`}
                                  title={`Open ${child.name}`}
                                >
                                  {childName}
                                </Link>
                              </p>
                              <p className="text-[11px] text-gray-500 dark:text-gray-400">Cash account</p>
                            </div>
                            {/* Phones: the balance beside the name, exactly as
                                the parent card does it, because the Account Bal
                                column is off at that width. */}
                            <span className={`sm:hidden shrink-0 text-sm font-semibold tabular-nums ${negativeTone(computeValuedBalance(child.id), 'text-gray-900 dark:text-white')}`}>
                              {formatDisplayCurrency(computeValuedBalance(child.id), child.currency)}
                            </span>
                          </div>
                          <AccountRowColumns>
                            {/* Bank Bal: an EMPTY slot, not a missing column. A
                                cash sleeve has no feed of its own — the money
                                arrives through the investment account it belongs
                                to — so there is no bank figure to show and
                                "N/A" would only invite the question. Dropping
                                the column instead would pull every figure after
                                it one place left, which is the misalignment this
                                whole row was rebuilt to end. */}
                            <AccountRowEmptyCell />
                            <AccountBalanceCell
                              label="Account Bal"
                              value={formatDisplayCurrency(computeValuedBalance(child.id), child.currency)}
                              amount={computeValuedBalance(child.id)}
                              secondary={Math.abs(unrealisedGain(child.id)) >= 0.01
                                ? `${formatDisplayCurrency(computeAccountBalance(child.id), child.currency)} in the register`
                                : undefined}
                              smOnly
                            />
                            <AccountCountCell
                              label="Unreconciled"
                              count={getUnreconciledCount(child.id)}
                              to={reconcileHref(child.id)}
                              toState={registerLinkState(child.id)}
                              openLabel={`Reconcile ${child.name}`}
                            />
                            {/* Its own register means its own arrivals to deal
                                with, so it gets this column too. */}
                            <AccountCountCell
                              label="To Review"
                              count={toReviewByAccount.get(child.id) ?? 0}
                              to={reviewHref(child.id)}
                              openLabel={`Review transactions in ${child.name}`}
                            />
                            {/* Portfolio, feed and settings: not this row's to
                                offer. The slots stay so the Reconcile button
                                lands under its parent's — and the WRAPPER stays
                                too, for the same reason one line up: below `lg`
                                the parent's five actions are their own
                                five-column line, so a cash row that let them
                                flex-wrap instead would put its chevron and its
                                reconcile somewhere else entirely. Identical
                                structure is the whole guarantee. */}
                            <div className={`${showRowActions ? 'grid' : 'hidden'} w-full grid-cols-5 justify-items-end gap-1 lg:contents`}>
                            <AccountRowEmptyCell />
                            <AccountRowEmptyCell />
                            <AccountRowEmptyCell />
                            <AccountRowActionSlot>{renderReconcileButton(child)}</AccountRowActionSlot>
                            {/* The chevron says "this row leads somewhere",
                                which it does — through the name beside it.
                                Decoration, so it is hidden from a screen
                                reader, which has the link itself. */}
                            <AccountRowActionSlot>
                              <span aria-hidden="true" className="flex items-center">
                                <ChevronRightIcon size={16} className="text-gray-400 flex-shrink-0" />
                              </span>
                            </AccountRowActionSlot>
                            </div>
                          </AccountRowColumns>
                        </div>
                      );
                    })}

                    {/* ─ WHAT IS HELD AGAINST THIS ACCOUNT ────────────────────
                        A mortgage under its property, a loan under the
                        portfolio it is drawn on. These rows are NOT the same
                        kind of thing as the cash sleeves above them, and the
                        design has to say so before the reader assumes they are:

                          · the cash sleeve is part of this account and its
                            money is already in the figure above. A secured
                            liability is somebody else's claim, counted in
                            Liabilities, and adding it here would restate the
                            value of a house as its equity.
                          · so this row prints no columns. AccountRowColumns is
                            the grammar of "a row that participates"; borrowing
                            it would put a debt in the Account Bal column and
                            invite exactly the arithmetic this must not imply.

                        NO FIGURE, on the owner's ruling, and it is the sharper
                        version of the same argument: "we are just highlighting
                        that this account is linked with a liability —
                        fundamentally it does not change the workings of the
                        accounts page." A balance printed here would sit inches
                        under the account's own and invite the subtraction, no
                        matter what the caption said. A name cannot be added up.
                        The figure lives where the debt lives, in Liabilities,
                        and on the Investments page where a net position can be
                        asked for deliberately.

                        No colour and no icon of alarm. A mortgage against a
                        house needs no attention — it is the ordinary shape of
                        owning one — and colour marks what needs attention. */}
                    {(securedByTarget.get(account.id) ?? []).length > 0 && (
                      <p className="mt-2 ml-6 sm:ml-9 text-[11px] text-gray-500 dark:text-gray-400">
                        <span className="font-medium">Linked liabilities:</span>{' '}
                        {(securedByTarget.get(account.id) ?? []).map((liability, i) => (
                          <span key={liability.id}>
                            {i > 0 && ', '}
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); jumpToAccount(liability.id); }}
                              /* `inline`, deliberately: `index.css` makes every button
                                     inline-FLEX, and a flex box will not break a long
                                     account name across lines — it would sit on one
                                     line and push the row sideways, which is the
                                     overflow this page was fixed for once already.
                                     `inline` beats the element rule on specificity and
                                     lets these read as what they are: words in a
                                     sentence. `min-h-0` for the same reason the row's
                                     name link carries it — the touch block floors every
                                     button at 44px, which would space these out.
                                     Dotted underline is the link and the hover is
                                     colourless — see the "Secured against" twin
                                     above for the whole argument. */
                                  className="inline text-left underline decoration-dotted underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200 min-h-0"
                              title={`Go to ${liability.name}`}
                            >
                              {liability.name}
                            </button>
                          </span>
                        ))}
                        {' — '}shown for information; counted under Liabilities,
                        not here.
                      </p>
                    )}
                  </div>
    );
  };

  // The band heading's glyph went on 15 August, with the rest of the app's
  // per-row icons (#296, #302, and the Accounts row's own in #281). The
  // argument is the one that has held every time: a wallet beside "CURRENT
  // ACCOUNTS", above rows that are all current accounts, names the band a
  // second time in a picture. The owner: "everywhere else we have taken them
  // away has looked better."
  //
  // It also cost the alignment. With the glyph gone, a section heading and the
  // institution heading below it now begin at the same x — chevron, name,
  // count — and their totals land in the same column as the account figures,
  // which is what he asked for and what the icon was quietly preventing.

  // ONE renderer for every banded view: a heading that folds the band away,
  // and — when open — either the account cards or, with both switches on, the
  // institution sub-bands holding them. The heading always shows the full
  // band's name, count and total, so a collapsed band still tells you what it
  // is worth.
  //
  // What is IN the band was decided by `displayedList` — the same answer the
  // arrow keys walk, so the two can never differ about which rows exist.
  /**
   * A group header's total, and how it declares that a rate was applied.
   *
   * Three outcomes, in the order they are checked:
   *
   *  1. **Whole in the display currency** — the plain figure this page has
   *     always printed, from the untouched `totalForBand` path, with no mark.
   *     Nothing was converted, so there is nothing to disclose and no reason for
   *     a single-currency ledger to grow a symbol it cannot explain.
   *  2. **A currency in the band has no rate at all** — the FAILURE state. There
   *     is no honest single figure, so the band reports the unsummed pair
   *     ("£X + $Y"). Never the default: it only appears where a rate is
   *     genuinely unresolvable, and the card above it is saying so at the same
   *     moment, out of the same `unconverted` list.
   *  3. **Converted** — the figure, marked `≈`. The mark is the whole
   *     disclosure: WHICH rate and WHEN is stated once per page, by
   *     `ConvertedTotalNote` under the net-worth card, and repeating it per
   *     group would make the scanning aid the widest thing on the row.
   */
  const bandTotalFigure = (key: string, bandAccounts: readonly Account[]): BandTotalFigure => {
    const converted = convertedNetWorth.groupTotals.get(key);

    if (!converted?.isConverted) {
      const total = totalForBand(bandAccounts);
      const plain = formatDisplayCurrency(total);
      return { text: plain, spoken: plain, amount: total.toNumber() };
    }

    if (converted.unconverted.length > 0) {
      const pair = converted.byCurrency
        .map(line => formatDisplayCurrency(line.amount, line.currency))
        .join(' + ');
      return { text: pair, spoken: pair, amount: null };
    }

    const figure = formatDisplayCurrency(converted.total);
    return { text: `≈ ${figure}`, spoken: `approximately ${figure}`, amount: Number(converted.total) };
  };

  /**
   * The figure as a node. An unmarked total renders as the bare string it
   * always was — same DOM, same textContent — and only a marked one splits into
   * a seen glyph and a spoken word, because `≈` is not reliably announced.
   */
  const bandTotalNode = (figure: BandTotalFigure): ReactNode =>
    figure.text === figure.spoken ? (
      figure.text
    ) : (
      <>
        <span aria-hidden="true">{figure.text}</span>
        <span className="sr-only">{figure.spoken}</span>
      </>
    );

  const renderAccountBand = ({ group, displayed, subBands, isExpanded }: DisplayedBand): ReactNode => {
    const regionId = groupRegionId(group.kind, group.label);
    const bandTotal = bandTotalFigure(bandTotalKey(group.kind, group.label), group.accounts);

    return (
      // NOT A CARD. This used to be a white bordered, shadowed box containing a
      // grey band containing white rows — three nested containers to say one
      // thing (DESIGN_PASS_2026-08 §3.3). Per P4 a group is separated by WEIGHT
      // and SPACE before it is separated by a box: the heading is a quiet caps
      // label on #f8f9fb with the band's total opposite it, the rows sit
      // directly on white below, and the 24px between one band and the next is
      // the `gap-6` of the grid this returns into. One border and one shadow
      // fewer per group.
      //
      // ─ `min-w-0`: WITHOUT IT A LONG ACCOUNT NAME DRAGS THE PAGE SIDEWAYS ──
      // A band is an item of the `grid gap-6` that lists them, and a grid item
      // defaults to `min-width: auto` — it may not shrink below its own
      // MIN-CONTENT. The name link already says `max-w-full truncate` and every
      // box between it and here already says `min-w-0`, so the truncation was
      // specified correctly the whole way down and simply never got the chance:
      // the band refused to be narrower than its widest descendant, so there
      // was nothing for the name to truncate against.
      //
      // Measured at 390px with a name the length of the owner's real ones
      // ("Mortgage - Corporation Avenue, Llanelli"): the grid track was 358px,
      // the band took 426, and the document scrolled sideways by 54 — which is
      // why his row actions sat off the right edge with only the settings cog
      // reachable. Demo data never showed it, because "Main Checking" fits.
      //
      // The odd empty strips he saw at the top and bottom are the same defect
      // from the other side: once the document is wider than the window,
      // scrolling right reveals background beside chrome that was only ever as
      // wide as the viewport.
      <div key={`${group.kind}:${group.label}`} className="min-w-0">
        <button
          type="button"
          onClick={() => toggleGroupCollapsed(collapseKeyFor(group.kind, group.label))}
          aria-expanded={isExpanded}
          aria-controls={regionId}
          className={`w-full ${DEPTH_LEVEL_1} border-b border-line dark:border-gray-700 px-4 sm:px-6 py-2.5 text-left transition-colors duration-state hover:bg-gray-200 dark:hover:bg-gray-600`}
        >
          {/* ONE ROW AT EVERY WIDTH, so the total is on the right on a
              phone too. It was `flex-col sm:flex-row`, which below sm stacked
              the total UNDER the name and hard against the left edge — while
              the institution headings one rung down are a plain
              `flex justify-between` and stayed right. The owner, on his phone:
              "the group totals are still showing to the left and not on the
              right as we should have changed."

              Removing the band glyph (#308) lined the two up on DESKTOP; this
              is the half of it that only shows on a narrow screen, which is
              why the earlier fix looked complete and was not. The name
              truncates rather than wrapping, so a long band title cannot push
              the figure off. */}
          {/* ─ `min-w-0`, AND WHY THE TOTALS DID NOT LINE UP ─────────────────
              This row is a flex ITEM of the header button, and `src/index.css`
              declares `button { display: inline-flex }` app-wide. A flex item
              defaults to `min-width: auto`, so it REFUSES to shrink below its
              own min-content — the name, the count and the figure all on one
              line. The button honoured `w-full` (343px at a 375px viewport)
              while this row stayed 370px and simply drew past it.

              That is both of the things reported. The figure sat wherever its
              row happened to end, so bands with shorter names ended further
              left and read as "inset"; and the widest band dragged the whole
              document to 402px, which is why the fixed header and the demo
              banner were 27px wider than the screen.

              `min-w-0` is what lets the truncation that was specified all the
              way down actually happen. The name has said `truncate` since it
              was written and never once got the chance.

              `w-full` is the OTHER half, and measuring is the only reason it
              is here: with `min-w-0` alone the overflow stopped but the totals
              still did not line up, because a flex item does not grow to fill
              its container unless told to (`flex-grow: 0` is the default).
              Each row shrank to its own content — 311px, 306px, 255px, 253px —
              so `justify-between` pushed each total to the end of a DIFFERENT
              box. Flush right within a row nobody can see the edge of is not
              flush right. */}
          <div className="flex w-full items-center justify-between gap-3 min-w-0">
            <div className="flex items-center gap-2 md:gap-3 min-w-0">
              <ChevronRightIcon
                size={16}
                className={`flex-shrink-0 text-gray-400 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
              />
              {/* THE COUNT DROPS UNDER THE NAME (owner's ruling). Three things
                  were competing for one line — the band's name, "(17
                  accounts)" and a figure that may run to eleven characters —
                  and the count is the one with no claim to that space: it
                  qualifies the name, it is not read across to the total. Above
                  `sm` there is room for all three, but the stack costs nothing
                  there and one arrangement is easier to trust than two.

                  It also removes the wrapping the owner saw first, where
                  "(17\naccounts)" broke across two lines INSIDE the row and
                  pushed the heading's own baseline around. */}
              <div className="flex flex-col min-w-0">
              {/* THE NAME OUTRANKS THE FIGURE HERE, and it took two goes to
                  believe it. P1 said a band's name is a label for its total,
                  so the label was set one step under the money — 14px word,
                  16px figure. The owner read the result back: "the words like
                  'Current Accounts' and 'Credit Cards' are now smaller than the
                  figures next to them."

                  He is right, and P1 is not wrong — it is answering a different
                  question. On a card you have already found, the total is what
                  you came for. This is a 130-row list being SCROLLED, and the
                  heading's job there is to tell you where you have got to; a
                  band total nobody navigates by was winning that contest on
                  size alone. So the name goes to `text-card`, level with the
                  figure it introduces, and the institution line below it to
                  `text-body`, keeping the one-step drop BETWEEN the two tiers
                  rather than between a heading and its own number.

                  Still an h2 — the outline, and the way a screen-reader user
                  walks this page, are unchanged. */}
              <h2 className="text-card uppercase font-bold tracking-wide text-gray-900 dark:text-white truncate">{group.title}</h2>
                {/* Brackets kept. They are redundant on their own line, but the
                    sub-bands below still print "(1 account)" inline and one
                    spelling across the page beats a defensible inconsistency.
                    The ask was where the count sits, not how it is written. */}
                <span className="text-dense text-gray-400 dark:text-gray-500 whitespace-nowrap">
                  ({group.accounts.length} {group.accounts.length === 1 ? 'account' : 'accounts'})
                </span>
              </div>
            </div>
            <p className={`text-card font-semibold whitespace-nowrap shrink-0 ${negativeTone(bandTotal.amount, 'text-primary dark:text-white')}`}>
              {bandTotalNode(bandTotal)}
            </p>
          </div>
        </button>

        {isExpanded && (
          <div id={regionId} className="bg-white dark:bg-gray-800">
            {/* The strip that used to be here is now parked at the top of the
                page with the controls, so it heads every band instead of
                scrolling away with this one. Phones never had it and still do
                not — below `sm` there is no grid to head, and the per-row
                labels in AccountRowColumns do that job. */}
            {subBands
              ? subBands.map(sub => {
                  // Count and total describe the WHOLE sub-band, as the section
                  // header does — a search narrows the rows, not the figures.
                  const countLabel = `${sub.accounts.length} ${sub.accounts.length === 1 ? 'account' : 'accounts'}`;
                  const subTotal = bandTotalFigure(
                    subBandTotalKey(group.kind, group.label, sub.label),
                    sub.accounts
                  );
                  // Scoped to the SECTION as well as the institution: the same
                  // bank appears under Current Accounts and under Credit Cards,
                  // and two elements may not share a DOM id even when they fold
                  // together.
                  const subRegionId = `${groupRegionId(group.kind, group.label)}-${groupRegionId('institution', sub.label)}`;
                  return (
                    // A sub-band is a group, not a heading: the outline stays
                    // section (h2) → account name (h3), and screen readers get
                    // the institution, its count and its total from the label.
                    <div
                      key={sub.label}
                      role="group"
                      aria-label={`${sub.title}, ${countLabel}, total ${subTotal.spoken}`}
                    >
                      {/* ONE INSTITUTION HAS TO END BEFORE THE NEXT BEGINS.
                          This was a single hairline UNDER the name with a 60%
                          wash behind it — enough to head a list, not enough to
                          close one. Scrolling nine Coutts accounts into seven
                          AMEX ones, the join read as another row: "the
                          separation between institutions needs to be more
                          visible, both on desktop but certainly on mobile."

                          Three changes, all of them separation rather than
                          decoration: a rule ABOVE as well as below (the one
                          that actually ends the previous institution), space
                          before it so the gap does the first half of the work,
                          and a solid wash instead of 60% so the strip reads as
                          a band rather than a tinted row.

                          `first:` resets all three: the opening institution in
                          a band sits directly under that band's own heading and
                          has nothing above it to be separated from. */}
                      {/* A BUTTON NOW, not a caption — see `isExpanded` on the
                          sub-band. It is the section heading's control one rung
                          down and is spelt identically: same chevron, same
                          rotation, same `aria-expanded`/`aria-controls` pair,
                          so the two folds are one idiom rather than two.

                          The count and the total stay in the heading precisely
                          BECAUSE it folds: what a collapsed institution leaves
                          on screen is its name, how many accounts are inside
                          and what they come to, which is the whole point of
                          folding it — "if I just want to see an institutions
                          summary — name and total amount I can". */}
                      <button
                        type="button"
                        onClick={() => toggleGroupCollapsed(subBandCollapseKeyFor(group.label, sub.label))}
                        aria-expanded={sub.isExpanded}
                        aria-controls={subRegionId}
                        /* INDENTED ONE STEP under its type band (Claude
                           Design, 22 Aug §7): shade and size alone left the
                           two headings reading as siblings with identical
                           totals, not a type CONTAINING an institution. The
                           indent is on the HEADING only — the rows beneath
                           stay at the page's content edges, because they are
                           measured against the shared column strip and an
                           indented row would drift every figure off its
                           column. */
                        className={`w-full text-left flex items-center justify-between gap-2 mt-4 first:mt-0 border-t-2 first:border-t-0 border-b border-line dark:border-gray-700 ${DEPTH_LEVEL_2} hover:bg-surface-tertiary dark:hover:bg-gray-700 transition-colors duration-state pl-8 sm:pl-12 pr-4 sm:pr-6 py-2`}
                      >
                        <p className="flex items-center gap-2 min-w-0 text-body uppercase font-bold tracking-wide text-gray-900 dark:text-white truncate">
                          <ChevronRightIcon
                            size={14}
                            className={`flex-shrink-0 text-gray-400 transition-transform duration-200 ${sub.isExpanded ? 'rotate-90' : ''}`}
                          />
                          <span className="truncate">{sub.title}</span>
                          <span className="shrink-0 font-normal normal-case tracking-normal text-gray-400 dark:text-gray-500">
                            ({countLabel})
                          </span>
                        </p>
                        <p className={`shrink-0 text-body font-semibold ${negativeTone(subTotal.amount, 'text-gray-700 dark:text-gray-300')}`}>
                          {/* The container already carries the spoken form in
                              its group label, so the mark is decoration here. */}
                          <span aria-hidden="true">{subTotal.text}</span>
                        </p>
                      </button>
                      <div id={subRegionId}>
                        {sub.isExpanded && sub.displayed.length > 0 && <AccountColumnHeader />}
                        {sub.isExpanded && sub.displayed.map(renderAccountCard)}
                      </div>
                    </div>
                  );
                })
              : (
                <>
                  {displayed.length > 0 && <AccountColumnHeader />}
                  {displayed.map(renderAccountCard)}
                </>
              )}
          </div>
        )}
      </div>
    );
  };

  // ONE quiet row for a closed account: name, institution, balance, a settings
  // button and a Reopen button. Deliberately not the full open-account card —
  // the archive stays subdued (muted text, no sync/reconcile/close actions).
  const renderClosedAccountRow = (account: Account): ReactNode => {
    // Settings without reopening: checking (or correcting) a closed account's
    // name or opening date used to cost a reopen–edit–close round trip for one
    // fact. Deliberately NOT a route into the register — the archive stays an
    // archive, so seeing its transactions still means reopening the account.
    const settingsLabel = `Account settings for ${account.name}`;
    return (
      <div key={account.id} className="flex items-center justify-between px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
            {account.name}
          </p>
          {/* Only when the list is NOT banded by institution — under an
              institution sub-band the heading already says it, and the open
              list dropped the same duplicate (owner, 20 Aug). */}
          {account.institution && !grouping.byInstitution && (
            <p className="text-xs text-gray-400 dark:text-gray-500 truncate">
              {account.institution}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          <p className={`text-sm tabular-nums ${negativeTone(account.balance, 'text-gray-900 dark:text-white')}`}>
            {formatDisplayCurrency(account.balance, account.currency)}
          </p>
          <IconButton
            onClick={() => setSettingsAccountId(account.id)}
            icon={<SettingsIcon size={16} />}
            variant="ghost"
            size="sm"
            className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
            title={settingsLabel}
            aria-label={settingsLabel}
          />
          <button
            onClick={() => void handleReopenAccount(account.id)}
            disabled={reopeningId !== null}
            className="px-3 py-1.5 text-xs font-medium border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {reopeningId === account.id ? 'Reopening…' : 'Reopen'}
          </button>
        </div>
      </div>
    );
  };

  return (
    <PageWrapper
      title="Accounts"
      rightContent={
        <button
          onClick={() => setIsAddModalOpen(true)}
          /* THE DARK-PRIMARY PILOT (Claude Design's canon ruling, 22 Aug 2026).
             The raw navy had no dark: variant at all — a light-mode value that
             all but vanished against the dark page. The token pair paints it
             navy-on-white in light and INVERTED — near-white fill, navy label —
             on dark: the ramp rule, walking from whichever end contrasts with
             the ground. This page goes first because it holds a primary, a
             secondary and a destructive together; the owner reads the captures
             before the other nineteen files move. Chrome deliberately
             unchanged — same radius, same type scale — so the only variable
             in the capture is the colour. */
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary-action text-on-primary-action text-sm font-medium rounded-lg hover:bg-primary-action-hover transition-colors shadow-sm"
          title="Add Account"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add Account
        </button>
      }
    >


      {/* ONE SCROLLER. This page used to pin the summary and controls and give
          the list a scrolling region of its own, sized
          `lg:h-[calc(100vh-13rem)]` — the viewport minus a HAND-COUNTED 208px
          for the chrome above it.

          That number is a measurement of other people's markup, so it was only
          ever right on the day it was written. Measured 2026-08-13 at 1440×900:
          the chrome above is 168px, not 208 — the region was 40px short of the
          fold before anything changed, and restructuring the control block that
          same day moved it again. Both errors show as the same defect the owner
          reported: the list's own scrollbar ends part-way up the window, the
          page keeps scrolling past it into dead space, and the bottom of the
          list appears to rise as you scroll because the two scrollers are
          consuming the same gesture.

          A phone never had this — the classes were all `lg:`, so the small
          screen has always scrolled as one document, like every other page in
          the app. The desktop now matches it. Nothing here can drift again,
          because there is no longer a number to be wrong.

          If pinned chrome is wanted back, the way to do it is `position:
          sticky` on the chrome itself, which needs no arithmetic about anything
          below it — but 168px of permanently-parked header is rent (P1), and
          that is a design call, not a layout repair. */}
      <div>
      <div>
      {/* Net Worth Summary Bar */}
      {!isLoading && accounts.length > 0 && (() => {
        // Ledger balance plus today's valuation term (slice 3b) — the same
        // figure the converted path sums, so the two paths cannot disagree,
        // and the same term the dashboard trio and the reports carry.
        const valuedBalance = (id: string): number =>
          toDecimal(computeAccountBalance(id)).plus(valuation.deltaAt(id, valuationDayKey)).toNumber();
        const totalBalance = decimalAccounts
          .reduce((sum, a) => sum.plus(toDecimal(valuedBalance(a.id))), toDecimal(0))
          .toNumber();
        const totalAssets = decimalAccounts
          .filter(a => valuedBalance(a.id) > 0)
          .reduce((sum, a) => sum.plus(toDecimal(valuedBalance(a.id))), toDecimal(0))
          .toNumber();
        const totalLiabilities = decimalAccounts
          .filter(a => valuedBalance(a.id) < 0)
          .reduce((sum, a) => sum.plus(toDecimal(valuedBalance(a.id)).abs()), toDecimal(0))
          .toNumber();

        // ONE card, three columns, hairline dividers — not a navy slab and two
        // white cards, which read as one important thing and two afterthoughts
        // when it is one figure and the two halves it is made of
        // (DESIGN_PASS_2026-08 §3.3). The same component draws the Dashboard's,
        // so the two surfaces cannot disagree about what net worth looks like.
        //
        // All three are formatted WITHOUT an account currency, i.e. in the
        // display currency: a total over accounts that need not share a
        // currency belongs to none of them in particular. The rows below keep
        // showing each account's own — which is what settles the mismatch the
        // two rows of cards used to have between them.
        //
        // Each figure still drills into the accounts behind it.
        return (
          <div className="mb-6">
            <NetWorthSummary
              // Converted figures ONLY when a second currency is actually in
              // play. A single-currency ledger keeps the exact arithmetic it
              // had — same functions, same number — so this change is invisible
              // to everyone it does not concern.
              // The ≈ on the trio itself (Design, 24 Aug §1): the group
              // totals below already wear it for the same conversion, and a
              // converted figure marked on one surface and not the other
              // reads as two different kinds of number. provenance is null
              // exactly when nothing converted.
              netWorth={`${spansCurrencies && convertedNetWorth.provenance ? '≈ ' : ''}${formatDisplayCurrency(spansCurrencies ? convertedNetWorth.netWorth : totalBalance)}`}
              netWorthAmount={Number(spansCurrencies ? convertedNetWorth.netWorth : totalBalance)}
              assets={`${spansCurrencies && convertedNetWorth.provenance ? '≈ ' : ''}${formatDisplayCurrency(spansCurrencies ? convertedNetWorth.assets : totalAssets)}`}
              liabilities={`${spansCurrencies && convertedNetWorth.provenance ? '≈ ' : ''}${formatDisplayCurrency(spansCurrencies ? convertedNetWorth.liabilities : totalLiabilities)}`}
              onSelect={figure => setBreakdownView(figure)}
              provenance={spansCurrencies ? convertedNetWorth.provenance : null}
              unconverted={spansCurrencies ? convertedNetWorth.unconverted : []}
              displayCurrency={displayCurrency}
            />
          </div>
        );
      })()}

      {/* On the RIGHT, between the summary boxes and the controls — the same
          side every page keeps this choice on (owner, 20 Aug: "the location
          on each page should be similar, as in on the right hand side").

          Only while there are figures to hide: with no accounts the summary
          above does not render, the -mt-4 that tucks this under it grabbed
          the Add Account button instead (owner, 26 Aug, on the desktop
          build), and a decimals toggle over an empty page governs nothing. */}
      {accounts.length > 0 && (
        <div className="-mt-4 mb-2 flex flex-wrap justify-end gap-x-4 gap-y-1">
          {/* Beside "Hide decimals", as asked (owner, 14 Nov 2026): the two
              choices about how this page's figures are drawn, as a pair. */}
          <NegativesInRedToggle />
          <WholePoundsToggle />
        </div>
      )}

      {/* Group + sort controls, with bank connections on the right.
          ─ WHICH LABEL GOES WITH WHICH CONTROL ────────────────────────────
          The gap BEFORE a label has to beat the gap AFTER it, or the eye files
          the label with the group it has just finished reading. "Sort:" used to
          fail that test: its label box was a fixed w-20 while the word is about
          half that, so 50-odd pixels of nothing sat between "Sort:" and its own
          Default button while only 24 separated it from the Institution button
          before it — and it read as Institution's caption.
          The fixed width now applies ONLY below sm, where the two rows stack
          and it is what lines the pill groups up under each other; side by side
          each label is its own width, 8px from its controls and 32 from the
          group before. */}
      </div>

      {/* THE CHROME PARKS, AND THE LIST SCROLLS UNDER IT.
          ────────────────────────────────────────────────────────────────────
          The owner's ask, verbatim: "we fix the information at the top of the
          page to the top of the page, and just scroll the accounts below … as
          when you start to scroll down you loose the ability to see column
          headings and also loose the ability to change the view or refresh
          feeds because you can no longer see anything at the top."

          Note what is and is NOT in this box, because the difference is the
          whole design argument. Parked: the controls, and the column strip.
          Scrolling away as before: the page title, and the net-worth summary
          card. A summary is read once on arrival and then it is rent — the
          same P1 objection that kept this page unpinned until now. Controls
          and column labels are read CONTINUOUSLY while scrolling a 130-row
          list, which is the case for pinning them and the reason the earlier
          ruling allowed sticky on a strip and refused it for the header block.

          THE STRIP RIDES INSIDE THIS BOX rather than under it. That is not
          tidiness — it is what makes the whole thing arithmetic-free. A second
          sticky layer would need to know this one's height, and this one wraps
          from one row to two at narrow widths and grows again when the "More"
          drawer opens, so any `top` written for the strip would be a
          measurement of other people's markup: exactly the mistake that made
          `calc(100vh-13rem)` 40px wrong. One box, one offset, nothing to drift.
          It also lands the strip above the "Current Accounts" heading, which is
          where the owner asked for it.

          The offset is `STICKY_UNDER_APP_BAR`, not a number. The reconciliation
          page's `top-16 md:top-12` was the obvious thing to copy and it is
          wrong three ways, all measured here: it omits the demo banner (36px,
          so the controls park BEHIND the nav in demo mode — seen in a
          screenshot before it was believed), it omits the status-bar inset that
          an installed home-screen app has, and its mobile figure is 64px for a
          header that measures 76. The app bar now publishes its own height the
          way the demo banner already published its own, and the constant adds
          up whatever those three are right now. The negative margins let the
          parked background span the page gutter so rows do not show at its
          edges as they pass beneath.

          `md:sticky` — IT DOES NOT PARK ON A PHONE, and that is a refusal of
          part of the ask rather than an oversight. Built at every width first
          and screenshotted at 390: the block is two rows there, the search box
          on one and the sort pills on the next, and it took 190px of a 760px
          screen while clipping the card beneath it mid-figure. A quarter of the
          phone held permanently by a search field is the "parked header is
          rent" objection at its worst. Nothing is lost by letting it scroll:
          the strip is `hidden sm:flex` so a phone has no column headings to
          lose, and the bottom nav is already the fixed furniture there. The two
          things the owner named — column headings, and reaching the view
          controls and Refresh feeds — are desktop problems, and this is where
          they are solved.

          IT IS A SIBLING OF THE BANDS ON PURPOSE, and this is the one thing
          here that will look like pointless nesting and is not. A sticky box
          travels only within its OWN PARENT: written one level in, sharing a
          wrapper with the summary card, everything above was correct — the
          computed style really said `position: sticky, top: 48px` — and it
          still scrolled away, because that wrapper is 253px tall and ends
          before the first band. Measured at 1280×700: parked top should be 48,
          was 18 at scrollY 400 and −111 at the bottom. Nothing in the CSS was
          wrong; the box was in the wrong box. Keep it a direct sibling of the
          list it heads, or it silently stops sticking again. */}
      <div
        className="md:sticky z-30 -mx-4 px-4 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8 pt-2 bg-[#f8f9fb] dark:bg-gray-900"
        style={{ top: STICKY_UNDER_APP_BAR }}
      >
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 mb-4">
        {/* w-full below sm: each control needs to OWN its row for the pill
            group inside to stretch — as content-sized flex items the two
            rows ended at different x and the pills could not line up.

            Group by is two INDEPENDENT switches rather than an either/or pair:
            on their own they band the list one way, together they nest
            institutions inside the type sections, and off they leave one flat
            list. The p-0.5 is not decoration — it matches the height the Sort
            group gets from its own border and padding, so the two rows line up.

            AND THEY HAVE TO LOOK LIKE IT. Both-on is a real state, but wearing
            the same navy fill as Sort's segmented single-choice directly
            beneath, two filled pills read as a broken radio group rather than
            as two things ticked — a phone capture of THIS page is what filed
            it, twice. The control has to say which KIND it is before it can be
            believed about which state it is in, so a pressed toggle carries a
            tick: the one glyph that means "this one too" rather than "this one
            instead". The slot is held open while a switch is off, so ticking
            one does not shove its own label sideways.

            Identical to the reconciliation page's, deliberately — same glyph,
            same size, same held-open slot. Two pages, one idiom; a tick that
            meant something subtly different on each would be worse than no
            tick at all. */}
        <div
          id={groupPanelId}
          className={`w-full sm:w-auto ${showMoreControls ? 'flex' : 'hidden'} sm:flex items-center gap-2`}
        >
          {/* Semibold, and a grade darker: these two words are the only thing
              telling anyone what the row of pills beside them does, and at
              gray-500/normal they read as a footnote to the buttons rather than
              as their name. */}
          <span className="text-sm font-semibold text-gray-600 dark:text-gray-300 w-20 sm:w-auto shrink-0">Group by:</span>
          <div className="grid grid-flow-col auto-cols-fr flex-1 sm:flex-none sm:inline-flex gap-2 p-0.5">
            <button
              type="button"
              onClick={() => handleGroupingChange({ ...grouping, byType: !grouping.byType })}
              aria-pressed={grouping.byType}
              title="Band the list into account-type sections"
              className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                grouping.byType
                  ? 'bg-[#1a2332] dark:bg-[#2d3a4d] border-[#1a2332] dark:border-[#2d3a4d] text-white'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
              }`}
            >
              {/* aria-hidden: `aria-pressed` already says this to a screen
                  reader, and the tick would announce it a second time. */}
              <span aria-hidden="true" className="w-3.5 flex-shrink-0">
                {grouping.byType && <CheckIcon size={14} />}
              </span>
              Account Type
            </button>
            <button
              type="button"
              onClick={() => handleGroupingChange({ ...grouping, byInstitution: !grouping.byInstitution })}
              aria-pressed={grouping.byInstitution}
              title="Band the list by institution"
              className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                grouping.byInstitution
                  ? 'bg-[#1a2332] dark:bg-[#2d3a4d] border-[#1a2332] dark:border-[#2d3a4d] text-white'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
              }`}
            >
              <span aria-hidden="true" className="w-3.5 flex-shrink-0">
                {grouping.byInstitution && <CheckIcon size={14} />}
              </span>
              Institution
            </button>
          </div>
        </div>
        {/* `flex-wrap` and `shrink-0` on the pill group (owner, 16 August).
            Adding "Hide account buttons" to this row squeezed the pills to
            their 44px touch minimum — measured at 375px: three pills at
            x107/x129/x152, overlapping, text wrapped to three lines. A flex
            child gives way before it wraps, so the toggle has to be ALLOWED
            to drop to its own line and the pills to refuse to shrink. */}
        <div className="w-full sm:w-auto flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-gray-600 dark:text-gray-300 w-20 sm:w-auto shrink-0">Sort:</span>
          {/* `grow shrink-0`, NOT `flex-1`. flex-1 is basis 0% — the group
              starts from nothing and takes only what is left over, and with
              the toggle on the row that leftover crushed all three pills to
              their 44px touch minimum, overlapping. Basis auto starts from the
              labels' own width; shrink-0 holds it; the toggle then WRAPS to
              its own line on a phone instead of squeezing this one. */}
          <div className="grid grid-flow-col auto-cols-fr grow shrink-0 sm:flex-none sm:inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-0.5">
            <button
              onClick={() => handleSortChange('default')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors ${
                sortMode === 'default'
                  ? 'bg-[#1a2332] dark:bg-[#2d3a4d] text-white'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900'
              }`}
            >
              Default
            </button>
            <button
              // Pressing it again flips the direction, exactly as Value does
              // one pill along (owner, 16 August: "you cannot flip to Z–A").
              onClick={() => handleSortChange(sortMode === 'name' ? 'name-desc' : 'name')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors ${
                sortMode === 'name' || sortMode === 'name-desc'
                  ? 'bg-[#1a2332] dark:bg-[#2d3a4d] text-white'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900'
              }`}
            >
              Name {sortMode === 'name-desc' ? 'Z–A' : 'A–Z'}
            </button>
            <button
              onClick={() => handleSortChange(sortMode === 'balance-desc' ? 'balance-asc' : 'balance-desc')}
              title={sortMode === 'balance-desc'
                ? 'Sorted highest value first — click for lowest first'
                : sortMode === 'balance-asc'
                  ? 'Sorted lowest value first — click for highest first'
                  : 'Sort by account value'}
              className={`px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors ${
                sortMode === 'balance-desc' || sortMode === 'balance-asc'
                  ? 'bg-[#1a2332] dark:bg-[#2d3a4d] text-white'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900'
              }`}
            >
              Value {sortMode === 'balance-asc' ? '↑' : '↓'}
            </button>
          </div>
          {/* ─ THE ONE SWITCH FOR THE ACTION BUTTONS (owner, 16 August) ──────
              Hiding them takes ~44px off every row, which across a hundred
              accounts is a screen and a half of scrolling. Reconcile and the
              review count stay reachable while hidden — the Unreconciled and
              To Review cells are links — so nothing is stranded; Settings
              waits behind one tap on this switch.

              `lg:hidden`, because above lg the buttons render regardless and
              a switch that visibly changes nothing teaches that switches do
              nothing. Placed with Sort rather than in the feeds toolbar: that
              toolbar is itself folded away on a phone, and a control for the
              phone cannot live inside something the phone hides. */}
          <button
            type="button"
            onClick={() => setShowRowActions(!showRowActions)}
            aria-pressed={showRowActions}
            className="lg:hidden ml-auto px-3 py-1.5 text-sm font-medium rounded-md text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 transition-colors"
          >
            {showRowActions ? 'Hide account buttons' : 'Show account buttons'}
          </button>
        </div>
        {/* Search — the way to find one account among two hundred. On a
            phone it takes the first row, full width; the pills follow.

            GROWS into whatever the toolbar has spare, rather than sitting at a
            fixed 224px with a corridor of nothing between it and Refresh feeds.
            basis-56 is the size it falls back to, so when the window is too
            narrow to hold everything the row WRAPS at the old width instead of
            squeezing the box down to a slot too small to read a bank's name
            in. */}
        <div className="order-first basis-full sm:order-none sm:basis-56 sm:grow flex items-center gap-2">
          <label htmlFor="account-search" className="sr-only">Search accounts by name or institution</label>
          {/* min-w-0 so the growing/shrinking happens to the box rather than
              being refused by the input's own intrinsic width. */}
          <div className="relative flex-1 min-w-0">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={16} />
            {/* A SEARCH TERM IS NOT PROSE. A phone capture caught the browser
                underlining a search term in red, which is the platform telling
                somebody their bank is misspelled. Institution names, sort codes
                and account nicknames are in no dictionary, so the squiggle is
                at best noise and at worst a suggestion that the reason nothing
                matched is that they typed it wrong.
                Autocapitalise is the same argument on a phone keyboard: the
                match is a case-insensitive substring test, so capitalising the
                first letter changes nothing except what the user watches
                themselves type. */}
            <input
              id="account-search"
              type="search"
              value={accountSearch}
              onChange={(e) => setAccountSearch(e.target.value)}
              placeholder="Search accounts…"
              spellCheck={false}
              autoCapitalize="none"
              className="w-full pl-9 pr-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:border-transparent"
            />
          </div>
          {isSearching && (
            <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap" aria-live="polite">
              {matchedTopLevelCount + matchedClosedAccounts.length} of {topLevelAccounts.length + closedAccounts.length} accounts
            </span>
          )}
          {/* THE SWITCH RIDES THE SEARCH ROW rather than taking one of its own,
              which would spend a row to save two. Phone only — `sm:hidden` —
              so at every width the toolbar was designed for, this button does
              not exist.

              The visible word is the accessible name's first word, not a
              shorter alias for it: a control whose spoken name has nothing to
              do with its printed one is unusable by voice, and "More" alone
              would be unusable by everyone else. The `sr-only` half is how
              this app already says the part that does not fit (see the report
              filter's own hidden label). */}
          <button
            type="button"
            onClick={() => setMoreControlsChoice(!showMoreControls)}
            aria-expanded={showMoreControls}
            aria-controls={`${groupPanelId} ${feedPanelId}`}
            className="sm:hidden shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 transition-colors"
          >
            More
            <span className="sr-only"> controls: grouping and bank connections</span>
            {/* SWAPPED, NOT ROTATED — the fold idiom the CLOSED ACCOUNTS band
                below already uses, so the two disclosures on this page open the
                same way.

                A correction is recorded here because the wrong reason was
                written down first: this comment used to claim `rotate-90`
                computes to no rotation in this app, on the strength of a
                console reading of the identity matrix. It does rotate.
                Re-measured 2026-08-13 — `.rotate-90` compiles correctly, the
                base layer initialises all six sibling `--tw-*` variables on
                `*, ::before, ::after`, and with `transition: none` an element
                toggles cleanly between `matrix(0, 1, -1, 0, 0, 0)` and `none`.

                The identity matrix was an artefact of WHERE it was measured: an
                automated browser tab reports `document.visibilityState ===
                'hidden'`, and a hidden tab does not advance CSS transitions —
                a 100ms `transition-transform` had not finished after 1991ms,
                and mid-flight it reads as its own start value. Every chevron on
                this page carries `transition-transform`, so all of them look
                frozen there and none of them is.
                See design-system/__tests__/transformUtilities.test.ts. */}
            {showMoreControls ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
          </button>
        </div>
        {/* THE BADGES DO NOT GO IN THE DRAWER. Both render `null` unless a
            banking incident is actually live, which makes them alarms rather
            than controls, and an alarm behind a switch labelled "More" is an
            alarm nobody hears. They stay in the always-visible half; only the
            two errands fold away. */}
        {/* `contents` while the drawer is shut, and it is load-bearing rather
            than clever: measured at 375px, a container holding two null badges
            and one hidden wrapper still claimed a whole wrap line, so the
            toolbar stood at three rows when the point of the exercise was two.
            `display: contents` makes the box itself stop existing while its
            children go on being laid out by the toolbar — so a live incident
            badge still appears (as a flex item of the row above), and nothing
            appears when there is no badge and no open drawer.
            The register's toolbar already dissolves a wrapper this way at
            phone widths; `sm:flex` takes the box back at every width the
            desktop uses. */}
        <div className={`${showMoreControls ? 'basis-full flex' : 'contents'} sm:basis-auto sm:ml-auto sm:flex items-center gap-2`}>
          <BankingCriticalIncidentBadge onClick={() => setBankConnectionsView('critical')} />
          <BankingCriticalIncidentBadge mode="truelayer_jwks" onClick={() => setBankConnectionsView('jwks')} />
          {/* The inner wrapper is what the switch actually hides, and it is
              built so the desktop cannot tell it arrived: `gap-2` inside
              matching `gap-2` outside leaves every button exactly 8px from its
              neighbour, which is where they were. */}
          <div
            id={feedPanelId}
            /* `items-stretch`, not `items-center` (owner, 16 August). Each
               button sized to its own text, so the moment one of the three
               wrapped to two lines — "Bank connections — 1 needs attention"
               does at phone widths — it grew taller than its neighbours and
               the row read as unfinished. Stretch makes the tallest set the
               height and the other two follow, whatever the copy does. */
            className={`w-full sm:w-auto ${showMoreControls ? 'flex' : 'hidden'} sm:flex items-stretch gap-2`}
          >
            {/* One hit for every feed — the per-account buttons remain for a
                single stubborn connection. Rendered whenever any connection
                exists so the toolbar's shape stays put. */}
            {connectedCount > 0 && (
              <button
                onClick={() => void syncAllConnections()}
                disabled={isSyncingAny}
                className="w-full sm:w-auto justify-center px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2 disabled:opacity-60 disabled:cursor-wait"
                title="Pull fresh data from every connected bank"
              >
                <RefreshCwIcon size={16} className={isSyncingAny ? 'animate-spin' : ''} />
                {isSyncingAny ? 'Refreshing…' : 'Refresh feeds'}
              </button>
            )}
            {/* SECONDARY, AND SPELT LIKE ITS NEIGHBOUR.
                It wore the navy fill — primary weight — for going to a screen,
                while the page's actual primary action (Add Account) sits in the
                header wearing the same navy. Two navy buttons on one page teach
                that navy means "a button", which spends the one signal that
                says "this is the thing to do here". P7 allows four roles and
                this is the second: quiet outline, identical to Refresh feeds
                beside it, because they are peers.
                And "Bank Connections" was Title Case standing next to "Refresh
                feeds" in sentence case — two spellings of one convention, 8px
                apart. */}
            {/* ─ AND IT TURNS AMBER WHEN A FEED HAS STOPPED ──────────────────
                "Would it be possible to change the colour of the 'Bank
                Connections' button on the accounts page if any of my account
                links have an error?"

                Yes — and this is the yellow thread's own case rather than an
                exception to it. Ruling A gives amber to the ONE control you
                should touch next, which is why a COUNT was taken off it: a
                count is not clickable and there can be eight of them. A broken
                feed is the opposite on both counts. There is a single control
                that fixes it, this is that control, and until it is pressed the
                balances on this page are quietly going stale — the page cannot
                say so anywhere else, because a stopped feed looks exactly like
                an account nobody has spent from.

                Colour is not the only carrier: the label changes too, so the
                reason survives for anyone who cannot see the difference, and
                the button says how many rather than merely that something is
                wrong. `reauth_required` counts as broken — see
                `feedsNeedingAttention` — because an expired consent is the
                failure that looks like nothing at all.

                The amber is `accessible-colors.ts`'s warning pair, not a hand
                mixed one: amber-700 on amber-100 measures 5.5:1, amber-300 on
                amber-900 10.7:1. Its neighbour Refresh feeds keeps the quiet
                outline, so there is still exactly one loud control here. */}
            {/* The COLOUR now comes from the app-wide ladder (Design,
                24 Aug), not from this page's own count — feed is the top
                rung, so in practice it wins whenever it has work, but it
                asks rather than assumes. The LABEL and the count are
                unchanged either way: standing down surrenders the colour,
                never the facts. */}
            {CHROME_HAS_BANK_FEEDS && (
            <button
              onClick={() => setBankConnectionsView('plain')}
              className={`w-full sm:w-auto justify-center px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors flex items-center gap-2 ${
                ladder.wearsAmber('feed')
                  ? 'border-amber-400 bg-amber-100 text-amber-700 hover:bg-amber-200 dark:border-amber-500 dark:bg-amber-900 dark:text-amber-300 dark:hover:bg-amber-800'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              <BankIcon size={16} />
              {feedsNeedingAttention > 0
                ? `Bank connections — ${feedsNeedingAttention} need${feedsNeedingAttention === 1 ? 's' : ''} attention`
                : 'Bank connections'}
            </button>
            )}
            {/* ─ THE TRAVELLING AMBER ─────────────────────────────────────────
                See `focusMode` for the whole argument. In short: one control
                naming the next job, which MOVES to the next one as each is
                finished, rather than two controls competing for the same
                colour or a column heading pretending to be a button.

                It goes quiet — outline, not amber — while a bank feed is down,
                because its neighbour is then the thing to touch next and there
                is only ever one amber on this page. It still works; it just
                stops shouting over something more urgent.

                While a view is focused this becomes the way OUT, and the other
                job (if it has any work) is offered beside it in the quiet
                style — the reconciliation page's arrangement exactly: yellow on
                the step you are on, the alternative in a plain control. */}
            {(reviewTotal > 0 || reconcileAccountCount > 0) && (() => {
              const nextJob: 'review' | 'reconcile' = reviewTotal > 0 ? 'review' : 'reconcile';
              // "NEW" was the word here from 24 Aug, when this count was only
              // arrivals and had to be told apart from Categorisation's
              // (owner — he compared 29 here with 30 there and reasonably
              // expected them to agree). His ruling of 29 Aug widened review
              // to include unfiled rows however they arrived, so the count is
              // no longer only new things and the word came off. The two
              // counts still differ — Categorisation adds guessed categories,
              // split lines and closed accounts — but "review" now names this
              // job exactly: rows that still want somebody's eyes.
              const label = nextJob === 'review'
                ? `Review ${reviewTotal} transaction${reviewTotal === 1 ? '' : 's'}`
                : `Reconcile ${reconcileAccountCount} account${reconcileAccountCount === 1 ? '' : 's'}`;
              // Was "no feed trouble and not focused" — this page reasoning
              // about one other page's rung. It asks the ladder for its own
              // rung now, so a Categorisation backlog or a dead feed
              // anywhere in the app is accounted for by one rule rather than
              // by each surface guessing about its neighbours.
              const wearsAmber = ladder.wearsAmber(nextJob) && !isFocused;
              const other: 'review' | 'reconcile' = focusMode === 'review' ? 'reconcile' : 'review';
              const otherHasWork = other === 'review' ? reviewTotal > 0 : reconcileAccountCount > 0;
              return (
                <>
                  <button
                    onClick={() => (isFocused ? exitFocus() : enterFocus(nextJob))}
                    aria-pressed={isFocused}
                    className={`w-full sm:w-auto justify-center px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors flex items-center gap-2 ${
                      wearsAmber
                        ? 'border-amber-400 bg-amber-100 text-amber-700 hover:bg-amber-200 dark:border-amber-500 dark:bg-amber-900 dark:text-amber-300 dark:hover:bg-amber-800'
                        : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                    }`}
                  >
                    <CheckCircleIcon size={16} />
                    {isFocused
                      ? `Showing ${focusMode === 'review' ? 'to review' : 'to reconcile'} — show all`
                      : label}
                  </button>
                  {isFocused && otherHasWork && (
                    <button
                      onClick={() => enterFocus(other)}
                      className="w-full sm:w-auto justify-center px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2"
                    >
                      {other === 'review'
                        ? `Review ${reviewTotal} instead`
                        : `Reconcile ${reconcileAccountCount} instead`}
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      </div>
      {/* ONE STRIP FOR THE PAGE, not one per band and not four labels per row.
          It used to sit inside each band's expanded region — already an
          improvement on twenty-odd repetitions, but it scrolled away with the
          band, which is the half of the owner's report about column headings.
          Parked here it heads every band at once, which it can do because all
          nine bands share one grid.

          Alignment survives the move for a structural reason rather than a
          lucky one: a band is a plain `<div>` with no inset of its own and the
          rows sit directly on it, so a band's content edges ARE the page's
          content edges — the same ones this sticky box is measured to. The
          strip goes on wearing the row card's box (see AccountRowColumns) to
          match the inset the CARD adds, which is the part that would drift. */}
      {/* HIDDEN WHEN THERE IS NOTHING BELOW IT (Claude Design §6). When there
          are no rows there are no columns: the labels have nothing to sit over,
          and on an otherwise empty page the strip is the heaviest thing on it,
          heading a table that is not there.

          Both empty cases, not just the ledger-is-empty one — a search that
          matches nothing leaves exactly the same strip over exactly the same
          nothing, and the filtered empty state below already explains itself
          without a column header helping. */}
      {/* ONLY FOR THE FLAT LIST (Design, 25 Aug §1). With bands on, the rows
          this strip names are several levels down and BAND HEADINGS sit in
          between — each showing a single right-aligned total under none of
          the four column names. Four headings over a one-column layout, and
          a reader scanning down from "TO REVIEW" landing on a band total.

          The reconciliation list solved this in the August pass and this
          page never got the same treatment: there, a run of rows and the
          strip that heads it are ONE unit, always drawn together, because
          the strip belongs to the row group rather than to the section.
          Banded views below now do the same. */}
      {!isLoading && matchedTopLevelCount > 0 && displayedList.mode === 'flat' && <AccountColumnHeader />}
      </div>

      {/* The `-ml-1 pl-1 pr-1` that used to be here went with the scroll
          region, and had to: `overflow-y: auto` cannot be had on one axis
          alone — CSS promotes the other from `visible` to `auto` — so the box
          clipped sideways too, and cut the left stroke off the selected row's
          focus ring, which is a box-shadow drawn 1px outside the border box.
          The padding bought that stroke 4px to land in.

          With no clipping box there is nothing to escape, so the compensation
          goes rather than being carried as cargo. Re-verified after the change:
          the selected row's ring is whole on all four sides. */}
      <div>
      {/* Accounts grid */}
      <div className="grid gap-6">
        {isLoading ? (
          /* SHAPE, NOT SPINNER (DESIGN_PASS §4). Three rows at the height an
             account row actually is, in the two tracks it actually has — the
             name on the left, the balance right-aligned — so the list does not
             jump when the accounts arrive. It replaced three 192px cards that
             matched no row on this page and breathed while they waited. */
          <div className="bg-white dark:bg-gray-800">
            <TableSkeleton columns={ACCOUNT_SKELETON_COLUMNS} rowHeight={ACCOUNT_ROW_HEIGHT} />
          </div>
        ) : displayedList.mode === 'flat' ? (
          /* Both switches off: one list, no band chrome at all — the rows on
             white, separated by the same hairline the banded views use. */
          <div className="bg-white dark:bg-gray-800">
            {displayedList.accounts.map(renderAccountCard)}
          </div>
        ) : (
          displayedList.bands.map(renderAccountBand)
        )}
      </div>

      {/* A SEARCH THAT HIDES EVERY ACCOUNT IS NOT AN EMPTY ACCOUNT LIST
          (DESIGN_PASS §4). On a finance app the two look identical and one of
          them is terrifying, so this one names how many accounts are still
          there, what is hiding them, and the control that gives them back.
          Search is the only thing on this page that hides a row: the group and
          sort switches rearrange the list.

          "NOTHING MATCHED" HAS TO MEAN NOTHING MATCHED. The closed band is
          searched now too, so a hit down there is a hit — printing this card
          above it would be the page contradicting itself in the other
          direction, which is how the contradiction was found in the first
          place. Hence the closed-match gate.

          And the count covers both populations, for the reason the count
          exists: it is the promise that Clear filters gives them back, so it
          has to count everything this search is holding — the top-level cards
          in the list and the closed rows in the band beneath it. The figure and
          the remedy describe the same set or neither is worth printing. */}
      {!isLoading && isSearching && matchedTopLevelCount === 0 && matchedClosedAccounts.length === 0 && openAccounts.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700">
          <FilteredEmptyState
            title="No accounts match your search"
            hiddenCount={topLevelAccounts.length + closedAccounts.length}
            scope="of your accounts"
            filters={[`Search: ${accountSearch.trim()}`]}
            onClear={() => setAccountSearch('')}
          />
        </div>
      )}

      {/* Gated on !isLoading, which it was not. The window is small — this
          page's isLoading is local and drops on the first effect pass — but
          for that first paint "No accounts yet" rendered directly beneath the
          loading placeholder, which is the page contradicting itself about
          whether the user has any accounts. The two are now mutually exclusive
          by construction rather than by how fast an effect runs. */}
      {!isLoading && openAccounts.length === 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700">
          <EmptyState
            title="No accounts yet"
            description="Every balance, report and budget in Reckley is built up from accounts, so until there is one here the rest of the app has nothing to show. Nothing here is estimated, so nothing appears until you add it."
            action={{ label: 'Add Account', onClick: () => setIsAddModalOpen(true) }}
          />
        </div>
      )}

      {/* Closed Accounts (Microsoft Money model: hidden, never deleted)

          Gated on the SEARCHED list, and counted from it. With the box clear
          the two are the same list and this section is exactly what it always
          was; with a search running, the band is a band of results like every
          other band on the page, and a search that matches nothing in the
          archive leaves no archive on screen to contradict it.

          Forced open while searching, for the reason the open bands ignore
          their collapsed state while searching (see `displayedList`): a folded
          section must not swallow a result somebody is actively looking for.
          Here it would be worse than a fold — the band would be a closed door
          with a count on it, and the count would be the only evidence the
          search had found anything at all. */}
      {matchedClosedAccounts.length > 0 && (
        <div className="mt-6 bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700 overflow-hidden">
          <button
            onClick={() => setShowClosedAccounts(prev => !prev)}
            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-gray-600 dark:text-gray-300">
              {closedBandExpanded ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
              Closed Accounts ({matchedClosedAccounts.length})
            </span>
            <span className="text-xs text-gray-400 dark:text-gray-500">
              History preserved — reopen any time
            </span>
          </button>

          {closedBandExpanded && (
            <div data-testid="closed-accounts" className="border-t border-gray-100 dark:border-gray-700">
              {/* Grouped exactly like the open list — both switches included,
                  so an institution sub-band nests here too — but kept quiet: a
                  small grey subheading per group, rows alphabetical within. A
                  subheading is not a semantic <h2> here; it sits below the open
                  sections' weight on purpose, an archive rather than the main
                  event. With both switches off there is no subheading at all. */}
              {closedAccountBands.mode === 'flat' ? (
                <div className="divide-y divide-gray-100 dark:divide-gray-700">
                  {closedAccountBands.accounts.map(renderClosedAccountRow)}
                </div>
              ) : (
                closedAccountBands.groups.map(group => (
                  <div key={`${group.kind}:${group.label}`}>
                    {/* The SAME voice as the open bands (owner, 21 Aug: "the
                        closed accounts should look the same to read as the
                        open accounts, in all aspects"). */}
                    <p className={`px-4 sm:px-6 py-2.5 text-card uppercase font-bold tracking-wide text-gray-900 dark:text-white ${DEPTH_LEVEL_1}`}>
                      {group.title}
                    </p>
                    {group.subGroups ? (
                      group.subGroups.map(sub => (
                        <div key={sub.label}>
                          <p className={`px-4 sm:px-6 py-2 text-body uppercase font-bold tracking-wide text-gray-900 dark:text-white ${DEPTH_LEVEL_2}`}>
                            {sub.title}
                          </p>
                          <div className="divide-y divide-gray-100 dark:divide-gray-700">
                            {sub.accounts.map(renderClosedAccountRow)}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="divide-y divide-gray-100 dark:divide-gray-700">
                        {group.accounts.map(renderClosedAccountRow)}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      </div>{/* end scroll region */}
      </div>{/* end desktop flex column */}

      <AddAccountModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
      />

      {/* Bank Connections Modal (badge clicks preset the ops filters) */}
      {bankConnectionsView !== null && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          {...bankConnectionsDismiss}
        >
          <div className="bg-white dark:bg-gray-800 rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
            <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Bank Connections</h2>
              <button
                onClick={() => setBankConnectionsView(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                aria-label="Close bank connections"
              >
                <XCircleIcon size={24} />
              </button>
            </div>
            <div className="p-6 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 100px)' }}>
              <Suspense fallback={<LoadingState />}>
                <BankConnections
                  onAccountsLinked={() => { void refreshAccountsAndTransactions(); }}
                  defaultOpsOnlyAboveThreshold={bankConnectionsView !== 'plain'}
                  defaultOpsEventTypePrefix={bankConnectionsView === 'jwks' ? TRUELAYER_JWKS_CIRCUIT_EVENT_PREFIX : undefined}
                  defaultOpenOpsAuditLog={bankConnectionsView === 'critical'}
                  defaultOpsAuditStatus={bankConnectionsView === 'critical' ? 'failed' : undefined}
                />
              </Suspense>
            </div>
          </div>
        </div>
      )}

      {/* Account Settings Modal — serves the open cards AND the closed rows, so
          the account can come from either list. A closed account is not in
          context state (it is loaded separately), hence the second lookup. */}
            <AccountBreakdownModal
        view={breakdownView}
        onClose={() => setBreakdownView(null)}
        rows={decimalAccounts.map(a => {
          const balance = computeAccountBalance(a.id);
          const factor = breakdownConversion?.factors.get(a.id);
          return {
            id: a.id,
            name: a.name,
            institution: a.institution,
            accountType: a.type,
            balance,
            converted: factor ? toDecimal(balance).times(factor).toNumber() : undefined,
            formatted: formatDisplayCurrency(balance, a.currency),
          };
        })}
        formatTotal={(v) => formatDisplayCurrency(v)}
        // Through the same door as a click on an account's name, provenance and
        // all: coming back from a register opened here lands on that account's
        // row rather than at the top of the list.
        onOpenAccount={(accountId) => {
          setBreakdownView(null);
          openAccount(accountId);
        }}
      />

      <AccountSettingsModal
        isOpen={!!settingsAccountId}
        onClose={() => setSettingsAccountId(null)}
        account={
          accounts.find(a => a.id === settingsAccountId)
          ?? closedAccounts.find(a => a.id === settingsAccountId)
          ?? null
        }
        // The open accounts, which is what the pairing field pairs with: a
        // closed investment account is not somewhere money can be filed.
        accounts={openAccounts}
        // Whether the CURRENCY field is still editable. Asked of the whole
        // transaction list rather than this page's balance views, because
        // archived rows count as history and those views hide them.
        hasTransactions={settingsAccountId ? accountHasHistory(transactions, settingsAccountId) : undefined}
        onSave={async (accountId, updates) => {
          // A closed account isn't in context state, so the context's in-place
          // patch lands on nothing — reopening one from here only reaches the
          // live list after a re-pull.
          const wasClosed = closedAccounts.some(a => a.id === accountId);
          await updateAccount(accountId, updates);
          if (wasClosed && updates.isActive === true) {
            await refreshAccountsAndTransactions();
          }
          // Closing/reopening (or renaming) via settings also updates the
          // account's transfer category via the DB trigger — keep the Closed
          // Accounts section and category dropdowns in sync without a reload.
          if (updates.isActive !== undefined) {
            await loadClosedAccounts();
          }
          if (updates.isActive !== undefined || updates.name !== undefined) {
            await refreshCategories();
          }
        }}
      />

      {/* NOT over an empty page (Claude Design, 22 Aug §8): with no accounts
          the empty state above is already the page's first sentence, and a
          five-line dark panel floating over it was the heaviest thing on a
          page with nothing on it — two pieces of guidance competing to be
          read first. The copy is also cut to the two things the page cannot
          say for itself; "add accounts" is what the header button and the
          empty state both already teach. Same id: a shortening is a cosmetic
          edit, and re-showing a tip nobody needs re-read is noise. */}
      {!isLoading && openAccounts.length > 0 && (
        <PageTip
          id="accounts-intro"
          title="Manage your accounts"
          description="Click an account's name to open its transactions; the settings icon on each row configures alerts and reconciliation."
        />
      )}
    </PageWrapper>
  );}
  