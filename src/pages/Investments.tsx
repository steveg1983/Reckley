import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { preserveDemoParam } from '../utils/navigation';
import { Modal, ModalBody } from '../components/common/Modal';
import { formatDate } from '../utils/dateFormatter';
import { useApp } from '../contexts/AppContextSupabase';
import { BarChart3Icon, AlertCircleIcon, LineChartIcon, EyeIcon, ChevronDownIcon, ChevronRightIcon } from '../components/icons';
import TrendArrow from '../components/TrendArrow';
import InvestmentMarketView from '../components/InvestmentMarketView';
import PortfolioManager, { type HoldingFormValues, type HoldingTraceOffer, type PurchaseDetails } from '../components/PortfolioManager';
import { allInAverageCost } from '../services/investments/purchaseMath';
import { openingPositionRow } from '../services/investments/openingPosition';
import { holdingTraceRows, openingPositionRowsFor, localDayKey } from '../services/investments/tradeDateCompanions';
import { bumpInvestmentValuation } from '../hooks/useInvestmentValuation';
import { transferCategoryIdFor } from '../utils/transferRepoint';
import StockWatchlist from '../components/StockWatchlist';
// Use optimized lazy-loaded charts to reduce bundle size
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid } from '../components/charts/OptimizedCharts';
// Tooltip comes from recharts ITSELF, not the lazy barrel: recharts identifies
// a chart's Tooltip child by component type, and the lazy stand-in is a type
// it has never met — which is how this page's ring tooltips stayed unthemed
// (16 August). A real Tooltip inside the (equally real) chart type-matches.
import { Tooltip } from 'recharts';
import { lineMarkers, seriesWash, seriesWashFill } from '../components/charts/richLine';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import { toDecimal } from '../utils/decimal';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { CHROME_HAS_PRICE_HISTORY } from '@chrome';
import HoldingRegisterModal, {
  type LiveBuyDetails,
  type LiveSellDetails
} from '../components/HoldingRegisterModal';
import PortfolioTradingHistory from '../components/PortfolioTradingHistory';
import { useInvestmentValuation } from '../hooks/useInvestmentValuation';
import { netWorthPointToken } from '../utils/netWorthSeries';
import { normaliseSecuredIds } from '../utils/accountSecuring';
import type { DecimalInstance } from '../utils/decimal';
import { formatDecimal } from '../utils/decimal-format';
import { describeRate } from '../utils/fx';
import PageWrapper from '../components/PageWrapper';
import { WholePoundsScope, WholePoundsToggle } from '../contexts/WholePoundsContext';
import { NegativesInRedToggle, useNegativeTone } from '../contexts/NegativesInRedContext';
import ToggleSwitch from '../components/ui/ToggleSwitch';
import { buildPortfolioSummary, buildPortfolioHistory } from '../utils/portfolioSummary';
import { useNetWorthConversion } from '../hooks/useNetWorthConversion';
import { useFlowConvert } from '../hooks/useFlowConvert';
import HistoricRatesRestatementNotice from '../components/HistoricRatesRestatementNotice';
import MixedCurrencyDisclosure from '../components/MixedCurrencyDisclosure';
import { useHistoricalAccounts } from '../hooks/useHistoricalAccounts';
import { formatCurrencyCompact } from '../utils/currency-decimal';
import { computePortfolioPerformance, scopeValueAt, scopeOpeningFlows } from '../utils/portfolioPerformance';
import { dayOf } from '../utils/plWindow';
import { buildTopLevelIdByAccountId, groupByTopLevelId } from '../utils/accountNesting';
import { getDateLocale } from '../utils/dateFormatter';
import { preferences } from '../services/preferencesService';
import { PieChart as DashboardPieChart } from '../components/charts/DashboardCharts';
import { buildHoldingAllocation } from '../utils/holdingAllocation';
// THE SEAM, not the service. This page called `InvestmentService` — and, through
// it, a Supabase client — directly until slice 31, with a `userIdService` lookup
// at every one of its five call sites. That is the coupling `src/desktop/routes.ts`
// recorded as the reason this route could not be mounted in a device window, and
// re-routing it through `@data` is what let that entry move to DESKTOP_ROUTES.
//
// Nothing about what the page DOES changed. The cloud half of the port delegates
// to the same service, with the same queries; the identity it used to resolve
// here is resolved inside the implementation, which is seam rule 1 and is the
// rule that stops "which user?" leaking into a component.
import { dataPort } from '@data';
import type { InvestmentHolding } from '@data';
import { fetchQuotes } from '../services/stockPriceService';
import { capSeriesWithRemainder, categoricalColor, categoricalRamp, useIsDarkGround, useChartTooltipStyle, useChartTooltipItemStyle } from '../components/charts/chartColors';
import { resolvePeriod } from '../hooks/usePeriod';
import DatePicker from '../components/common/DatePicker';
import { compareNames, compareText } from '../utils/localeFormat';

/**
 * Names this page's Portfolio Performance wash in the document. Stated once
 * because the id is built from it twice — in the `<defs>` and in the `fill`
 * that references it — and two literals that must agree is how a wash silently
 * becomes no wash. See charts/richLine.
 */
const PERFORMANCE_CHART_KEY = 'investments-performance';

/**
 * ONE BOX FOR EVERY ASSET ALLOCATION LEGEND ROW, named and folded alike.
 *
 * The percentages down the right of that legend are a COLUMN, and a column is
 * only a column while every row's content ends at the same x. Owner, 29
 * August: the fold's "3.84%" sat out of line with the shares above it.
 *
 * WHY IT DID. Both kinds of row bleed their hover background outwards with the
 * app's usual `px-2 -mx-2`. A named row is a <Link>, so its width is auto and
 * the box simply grows by the 1rem the negative margins ask for — the padding
 * lands OUTSIDE the column and the text still ends on the column's edge. The
 * fold row is a <button>, and a button cannot be trusted to fill its parent on
 * `display: flex` alone, so it stated `w-full` — which under the border-box
 * every element in this app inherits took that 1rem out of the ROW instead,
 * pulling its right-hand content 16px inwards. Nothing about the percentage
 * itself was wrong; the box around it was a rem narrower.
 *
 * `box-content` is the fix and the reason it is shared: with it, `w-full` means
 * "the column's width, and the hover bleed sits outside it" — the same box the
 * Link works out for itself. Stated once so the two cannot drift apart again,
 * which is the only way this stays fixed.
 */
const ALLOCATION_LEGEND_ROW =
  'w-full box-content flex items-center justify-between gap-3 text-body rounded px-2 -mx-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-700/50';

/**
 * The windows this chart offers, in the app's own words.
 *
 * `3 months` rather than `3M`: the abbreviation saved eleven characters on a
 * control that has room, at the cost of matching nothing else in the product.
 */
const INVESTMENT_PERIODS = ['1-month', '3-months', '6-months', '12-months', 'tax-year', 'all', 'custom'] as const;
type InvestmentPeriod = (typeof INVESTMENT_PERIODS)[number];

const INVESTMENT_PERIOD_LABELS: Record<InvestmentPeriod, string> = {
  '1-month': '1 month',
  '3-months': '3 months',
  '6-months': '6 months',
  '12-months': '12 months',
  'tax-year': 'Tax year',
  all: 'All time',
  custom: 'Custom',
};

/** Trailing windows only; 'tax-year' and 'all' resolve elsewhere. */
const INVESTMENT_PERIOD_MONTHS: Record<'1-month' | '3-months' | '6-months' | '12-months', number> = {
  '1-month': 1,
  '3-months': 3,
  '6-months': 6,
  '12-months': 12,
};

export default function Investments() {
  // The whole-pounds scope must sit above every useCurrencyDecimal call,
  // including this page's own — hence the thin shell (owner, 19 Aug:
  // page-specific decimal display).
  return (
    <WholePoundsScope page="investments">
      <InvestmentsView />
    </WholePoundsScope>
  );
}

function InvestmentsView() {
  const {
    accounts, transactions, transactionSplits, categories,
    // The purchase's cash half: the out leg is an ordinary transaction and the
    // far side is minted and linked by the same machinery every transfer uses.
    addTransaction, createTransferCounterpart, deleteTransaction,
    // For the sale's income leg: find-or-create the Realised gains category.
    addCategory,
  } = useApp();
  const { formatCurrency, displayCurrency } = useCurrencyDecimal();
  /**
   * "Negatives in red" (owner, 14 Nov 2026): one setting for the whole app.
   * What follows it here is every VALUE that is otherwise plain — a portfolio,
   * an account, a cash sleeve (which can legitimately sit below zero), a debt
   * secured against the portfolio. Gains and losses already carry green and
   * red and keep them; a movement (a sale's proceeds, a transfer) is not a
   * balance and is left alone.
   */
  const negativeTone = useNegativeTone();
  const valueTone = (value: { toNumber(): number } | number | null | undefined, fallback: string): string =>
    negativeTone(value == null ? null : typeof value === 'number' ? value : value.toNumber(), fallback);
  /**
   * THE APP'S PERIOD VOCABULARY, spoken here too.
   *
   * This picker used to read `1M 3M 6M 1Y ALL` while every other surface in the
   * app said "This month / Tax year / 12 months / All time". Two vocabularies
   * for one idea means the reader has to translate between screens, and the one
   * period a UK user most wants of an investment chart — the tax year — was
   * missing from the only page where gains are realised.
   *
   * The WINDOWS stay trailing rather than becoming the Dashboard's calendar
   * periods: "the last 3 months" is the right question of a performance line,
   * and "this month" is not. What is shared is the wording and the tax-year
   * rule itself, which comes from `resolvePeriod` so that Tax year means 6
   * April here and on the Dashboard, forever, from one definition.
   */
  const [selectedPeriod, setSelectedPeriod] = useState<InvestmentPeriod>('12-months');
  // Bare yyyy-mm-dd, which is what `DatePicker` speaks and what a date input
  // needs. Empty means unbounded on that side, so choosing Custom and setting
  // only a start reads as "from then until today" rather than showing nothing.
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  /**
   * THE ONE ADD-A-HOLDING DOOR.
   *
   * This was `showAddInvestmentModal`, opening `AddInvestmentModal` — a second
   * form that asked for units, price, fees and stamp duty and then wrote ONE
   * EXPENSE TRANSACTION and no holding at all. A buy recorded through it left
   * the portfolio unchanged, which is why it also offered "Cash" as a thing to
   * buy at a price of 1.00: it was never talking to the holdings table.
   *
   * The header's button now leads to the manager that does create a holding
   * (and its funding transfer). Because a holding belongs to an ACCOUNT, the
   * account is chosen first — silently picking one is how a holding lands in
   * the wrong sleeve. With a single investment account there is nothing to ask.
   */
  const [addHoldingMenuOpen, setAddHoldingMenuOpen] = useState(false);
  /** Which account's manager has been asked to open its add form, and when. */
  const [addSignal, setAddSignal] = useState<{ accountId: string; nonce: number } | null>(null);
  /**
   * THE TAB LIVES IN THE URL (owner, 16 August: "when I refresh the page if I
   * am on 'Watchlist' … it refreshes back to the investment page").
   *
   * A query parameter rather than component state, because a refresh rebuilds
   * state from nothing and the URL is the one thing a refresh keeps. It also
   * makes a tab shareable and back-button-friendly for free. `replace`, not
   * push: switching tabs is not a navigation the back button should replay
   * four times.
   */
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  /**
   * THREE TABS since 16 August. "Manage" was the Portfolio tab with a dropdown
   * instead of a scroll — pick an account, then add holdings — while Portfolio
   * was pick an account by scrolling, then a button whose whole job was
   * switching to Manage. Two doors to one room (the owner: "kind of take you
   * to the same place, just a different way"). The manager now opens INLINE on
   * the Portfolio card it concerns; `tab=manage` in an old URL lands on
   * Portfolio rather than nowhere.
   */
  const activeTab: 'overview' | 'watchlist' | 'portfolio' =
    tabParam === 'watchlist' || tabParam === 'portfolio' || tabParam === 'manage'
      ? (tabParam === 'manage' ? 'portfolio' : tabParam)
      : 'overview';
  const setActiveTab = useCallback((tab: 'overview' | 'watchlist' | 'portfolio'): void => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      // Overview is the default, so it carries no parameter — a clean URL for
      // the common case, and 'tab=overview' never has to be kept in step.
      if (tab === 'overview') next.delete('tab');
      else next.set('tab', tab);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const [managingAccountId, setManagingAccountId] = useState<string | null>(null);

  /**
   * Open the add-a-holding form for one account: show the Portfolio tab, expand
   * that account's manager, and signal it. Three steps because the form lives
   * inside the manager, which lives inside the tab — the door has to walk the
   * whole way rather than leave the person somewhere near it.
   */
  const openAddHoldingFor = useCallback((accountId: string): void => {
    setAddHoldingMenuOpen(false);
    setActiveTab('portfolio');
    setManagingAccountId(accountId);
    setAddSignal(previous => ({ accountId, nonce: (previous?.nonce ?? 0) + 1 }));
  }, [setActiveTab]);

  /** The manager has opened its form; the request is spent. */
  const clearAddSignal = useCallback((): void => setAddSignal(null), []);

  /**
   * Which summary tile is opened out into its per-account rows — the owner's
   * drill-down, asked for twice: "even if the figures are then investment
   * account summary level and from there, each account can be clicked on to
   * see the transactions". Clicking the open tile again closes it.
   */
  const [openBreakdown, setOpenBreakdown] = useState<'contributions' | 'return' | null>(null);
  /** Second level: which line's transactions are on screen. Null = the list. */
  const [drillLineId, setDrillLineId] = useState<string | null>(null);

  // ── Holdings: the MARKET view's data, from public.investments ─────────────
  // Kept deliberately apart from `summary` below. Holdings × price is a second
  // opinion about the same money; the ledger figures are the page's truth and
  // the two are never added. See utils/portfolioSummary and
  // components/InvestmentMarketView.
  const [holdings, setHoldings] = useState<InvestmentHolding[]>([]);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);
  const [isUpdatingQuotes, setIsUpdatingQuotes] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [symbolErrors, setSymbolErrors] = useState<Map<string, string>>(new Map());
  // Which account the last (or current) quote update concerns. Without it a
  // spinner and an error raised by one account's button appear on every
  // account's panel, and the reader cannot tell which one failed.
  const [quotedAccountId, setQuotedAccountId] = useState<string | null>(null);

  const reloadHoldings = useCallback(async (): Promise<void> => {
    // Every holdings mutation funnels through here — and every value surface
    // must learn of it at the same moment this page does.
    bumpInvestmentValuation();
    try {
      // An engine with nowhere to keep a holding answers with an empty list
      // rather than rejecting (divergence B-12), which is honest: there are
      // none, because there is nowhere to keep them. The page used to reach
      // that answer by checking for a database id, which meant asking the
      // question "who is signed in?" in order to learn something about a STORE.
      setHoldings(await dataPort.listInvestments());
      setHoldingsError(null);
    } catch (error) {
      setHoldingsError(
        error instanceof Error ? error.message : 'Could not load your holdings.'
      );
    }
  }, []);

  useEffect(() => {
    void reloadHoldings();
  }, [reloadHoldings]);

  /**
   * Fetch prices for the symbols on screen and store them.
   *
   * The write-back is what makes the nightly cron and this button the same
   * feature: both put a price and its as-of date on the row, so a page opened
   * tomorrow morning already shows last night's close without asking anyone.
   */
  const updateQuotes = useCallback(async (
    accountId: string,
    symbols: readonly string[]
  ): Promise<void> => {
    setQuotedAccountId(accountId);
    if (symbols.length === 0) return;

    setIsUpdatingQuotes(true);
    setQuoteError(null);
    setSymbolErrors(new Map());
    try {
      const batch = await fetchQuotes(symbols);
      setSymbolErrors(batch.errors);

      if (batch.quotes.size > 0) {
        // A store with nowhere to keep a price refuses BY NAME, and seam rule 4
        // makes that refusal's own sentence the one on screen — which is why
        // this no longer checks for a session first and no longer words the
        // refusal itself. The engine knows why it cannot; this page does not.
        await dataPort.applyInvestmentPrices(
          [...batch.quotes.values()].map((quote) => ({
            symbol: quote.symbol,
            price: quote.price.toString(),
            asOf: quote.asOf.toISOString()
          }))
        );
        await reloadHoldings();
      }

      if (batch.errors.size > 0) {
        // Names the count, not the symbols — each failing row says its own
        // reason in place, which is where the reader is looking.
        setQuoteError(
          batch.quotes.size === 0
            ? 'No prices could be fetched. Check your connection and try again.'
            : `${batch.errors.size} of ${symbols.length} holdings could not be priced.`
        );
      }
    } catch (error) {
      setQuoteError(
        error instanceof Error ? error.message : 'Prices could not be updated.'
      );
    } finally {
      setIsUpdatingQuotes(false);
    }
  }, [reloadHoldings]);

  const handleAddHolding = useCallback(
    async (accountId: string, values: HoldingFormValues, purchase: PurchaseDetails): Promise<void> => {
      const fundingAccount = purchase.fundingAccountId !== null
        ? accounts.find(a => a.id === purchase.fundingAccountId) ?? null
        : null;

      /**
       * Charges fold into the stored average cost — Money's own definition
       * (total paid ÷ shares, commission included), and the only place they
       * CAN live: costBasis is derived from averageCost so the two can never
       * disagree. The provenance note keeps the fold auditable.
       */
      const averageCost = allInAverageCost(values.quantity, values.averageCost, purchase.charges);
      const provenance: string[] = [];
      if (purchase.charges.greaterThan(0)) {
        provenance.push(`Cost includes ${formatCurrency(purchase.charges, values.currency)} in charges.`);
      }
      if (fundingAccount) {
        provenance.push(`Paid from ${fundingAccount.name}.`);
      }
      /*
       * THE RATE IS PART OF THE RECORD, not a step on the way to a figure.
       * 250 USD at one rate and 250 USD at another are different amounts of
       * sterling; a note that keeps only the sterling cannot say which
       * happened, and neither can anyone reading it a year later. Stated with
       * its provenance — the provider's figure, or the owner's own.
       */
      if (purchase.fx) {
        provenance.push(
          `Converted at ${describeRate(purchase.fx.rate, { from: purchase.fx.from, to: purchase.fx.to })}` +
          `${purchase.fx.source === 'api' ? " (today's rate)" : ' (your rate)'}.`
        );
      }

      await dataPort.createInvestment({
        accountId,
        symbol: values.symbol,
        name: values.name,
        quantity: values.quantity,
        averageCost,
        // The raw dealt price, charges out — the born-priced snapshot.
        currentPrice: values.averageCost,
        currency: values.currency,
        assetType: values.assetType,
        purchaseDate: purchase.date,
        notes: provenance.join(' ')
      });

      /**
       * THE CASH LEG (owner, 17 Aug; Money's measured model — 2015 of 2029
       * real buys carried one, funded from a freely chosen account). Out of
       * the chosen account, into this investment account, linked by the same
       * counterpart machinery every transfer uses.
       *
       * The two ACCOUNTS always agree on currency (the form only offers
       * funding accounts that count in this one), so the counterpart copying
       * this row's digits is correct. Where a currency boundary can appear is
       * between the INSTRUMENT and that money — Apple prices in dollars inside
       * a sterling ISA — and that conversion happens in the form, at a rate
       * the owner sees and can overwrite, before any figure reaches here.
       */
      if (fundingAccount && purchase.totalPaid !== null) {
        try {
          const total = purchase.totalPaid.toNumber();
          const outLeg = await addTransaction({
            accountId: fundingAccount.id,
            amount: -Math.abs(total),
            type: 'transfer',
            date: purchase.date,
            description: `Buy ${formatDecimal(values.quantity, 4)} ${values.symbol}`,
            category: transferCategoryIdFor(categories, accountId, -Math.abs(total)),
            cleared: false,
          });
          await createTransferCounterpart(outLeg.id, accountId);
        } catch (error) {
          // The holding IS saved. Saying so is what stops a retry from
          // doubling the position.
          throw new Error(
            `The holding was saved, but the transfer from ${fundingAccount.name} could not be written` +
            `${error instanceof Error ? ` (${error.message})` : ''}. ` +
            'Close this dialog and add the transfer from the register instead.'
          );
        }
      }

      /**
       * THE BUY EVENT (slice 4): every new holding's register derives from
       * events, so the register's first line is this buy — same lane the
       * imported history lives in, and what Buy more / Sell extend.
       *
       * EVENTS ARE ALWAYS IN THE ACCOUNT'S CURRENCY — the valuation module
       * trusts event.currency as the account's (the import reader guaranteed
       * it), so a foreign-priced holding recorded WITHOUT a funding total in
       * account money writes NO event: it stays on the holding-row valuation
       * path, which handles its currency correctly, and its register derives
       * from the holding as before. A funded buy always has the account
       * figure (totalPaid).
       */
      const portfolioAccount = accounts.find(a => a.id === accountId) ?? null;
      const accountCurrency = portfolioAccount?.currency ?? values.currency;
      const eventAmount = purchase.totalPaid !== null
        ? purchase.totalPaid
        : values.currency === accountCurrency
          ? values.quantity.times(averageCost)
          : null;

      /**
       * THE OPENING-POSITION ROW (owner, 30 Aug: holdings recorded without a
       * cash leg "should hold a value throughout the app"). The valuation is
       * ledger + (market − cost), and its stated assumption is that the
       * ledger carries buys at cost — true for a funded buy through its
       * transfer, false for "no money moves", which left the position
       * contributing only its gain: a whole portfolio recorded
       * retrospectively read £0.00 on Accounts, in net worth and on the
       * Overview while the Portfolio tab priced it at market. The register
       * now receives the cost the way a reconciliation adjustment arrives —
       * dated the purchase, filed under the revaluation kind, so it moves
       * the balance without ever counting as income. openingPositionRow
       * makes the same funded/foreign choice as the event lane above, so
       * the register and the valuation can never disagree about whether a
       * position is ledger-backed.
       */
      const opening = openingPositionRow({
        fundingAccountId: purchase.fundingAccountId,
        costInAccountMoney: purchase.fundingAccountId === null ? eventAmount : null,
        quantity: values.quantity,
        symbol: values.symbol,
        date: purchase.date,
        categories
      });
      if (opening.row !== null) {
        try {
          await addTransaction({
            accountId,
            amount: opening.row.amount.toNumber(),
            type: 'income',
            date: opening.row.date,
            description: opening.row.description,
            category: opening.row.categoryId,
            cleared: false,
          });
        } catch (error) {
          throw new Error(
            'The holding was saved, but its opening position could not be written into the register' +
            `${error instanceof Error ? ` (${error.message})` : ''}. ` +
            'Without that row the account undercounts by the cost — add it from the register: ' +
            `a deposit of the amount paid, filed under Account Adjustment.`
          );
        }
      }
      if (eventAmount !== null) {
        // Charges arrive in the HOLDING's currency; the event's figures are
        // account money — convert at the buy's own rate before any
        // subtraction (the owner's first live FX buy had $100 of charges
        // subtracted from a £ total before this line existed).
        const chargesInAccountMoney = purchase.fx
          ? purchase.charges.times(purchase.fx.rate)
          : purchase.charges;
        try {
          await dataPort.recordInvestmentEvent({
            accountId,
            symbol: values.symbol,
            securityName: values.name,
            // LOCAL day, not toISOString: a summer local-midnight Date is the
            // previous day in UTC, and the event would land a day early.
            date: localDayKey(purchase.date),
            kind: 'buy',
            quantity: values.quantity.toString(),
            // Per-unit in the ACCOUNT's money, fees out — the register
            // re-anchors value from it, exactly as the imported buys do.
            price: eventAmount.minus(chargesInAccountMoney).dividedBy(values.quantity).toString(),
            fees: chargesInAccountMoney.greaterThan(0) ? chargesInAccountMoney.toString() : null,
            amount: eventAmount.toString(),
            currency: accountCurrency
          });
          // The trade implies the day's price, in the INSTRUMENT's currency —
          // never overwriting a quote or a typed figure.
          await dataPort.recordTradePrices([{
            symbol: values.symbol,
            date: localDayKey(purchase.date),
            price: values.averageCost.toString(),
            currency: values.currency
          }]);
        } catch (error) {
          // Holding and transfer are saved; only the register's event line is
          // missing, and the register falls back to the holding itself.
          throw new Error(
            'The holding was saved, but the buy could not be recorded in its register' +
            `${error instanceof Error ? ` (${error.message})` : ''}. ` +
            'The register will show the position from the holding until a trade is recorded.'
          );
        }
      }

      await reloadHoldings();
    },
    [accounts, categories, addTransaction, createTransferCounterpart, formatCurrency, reloadHoldings]
  );

  const handleEditHolding = useCallback(
    async (id: string, values: HoldingFormValues): Promise<void> => {
      await dataPort.updateInvestment(id, {
        symbol: values.symbol,
        name: values.name,
        quantity: values.quantity,
        averageCost: values.averageCost,
        assetType: values.assetType
      });
      await reloadHoldings();
    },
    [reloadHoldings]
  );

  /**
   * What the delete dialog can OFFER to take along: the register rows this
   * holding's own trades wrote — matched by the writers' exact descriptions
   * and dates (holdingTraceRows), so a row the owner has redated or reworded
   * is never on the list. Read BEFORE the delete, because the events the
   * matching needs are erased with the holding.
   */
  const traceRowsForHolding = useCallback(
    async (holding: InvestmentHolding): Promise<HoldingTraceOffer[]> => {
      if (holding.accountId === null) return [];
      const events = await dataPort.listInvestmentEvents(holding.accountId);
      const own = events.filter((e) => e.symbol === holding.symbol);
      const ids = new Set(holdingTraceRows(own, holding.accountId, transactions));
      return transactions
        .filter((t) => ids.has(t.id))
        .map((t) => ({ id: t.id, description: t.description, date: t.date, amount: t.amount }));
    },
    [transactions]
  );

  const handleDeleteHolding = useCallback(
    async (id: string, traceRowIds: readonly string[]): Promise<void> => {
      // A deleted holding is "this record was a mistake" — its events are
      // the same mistake, and left behind they would keep claiming the
      // position is still held under Securities traded. A SALE is the real
      // ending and goes through handleSell, never here.
      const doomed = holdings.find(h => h.id === id);
      await dataPort.deleteInvestment(id);
      if (doomed && doomed.accountId !== null) {
        await dataPort.deleteInvestmentEvents(doomed.accountId, doomed.symbol);
        // The synthetic opening-position rows go with the position — left
        // standing, a deleted-then-re-added holding double-counts its cost
        // (the owner's first backfill hit exactly this). Matched by shape
        // and symbol, not date: a row the owner redated is still this
        // position's cost.
        for (const rowId of openingPositionRowsFor(doomed.accountId, doomed.symbol, transactions)) {
          await deleteTransaction(rowId);
        }
      }
      // The trades' own register rows, when the dialog's tick asked for them
      // (owner, 1 Sep 2026). Each id is the holding-account leg; the server's
      // pair-delete takes a transfer's far side with it. Ticked off AFTER the
      // holding so a failed holding-delete leaves the ledger untouched.
      for (const rowId of traceRowIds) {
        await deleteTransaction(rowId);
      }
      await reloadHoldings();
    },
    [holdings, reloadHoldings, transactions, deleteTransaction]
  );

  /**
   * The sale's income leg needs a home. Find the owner's own category first
   * (any income category whose name says realised gains); create the
   * standard one only when none exists — a person who already files these
   * under their own name keeps their tree.
   */
  const realisedGainsCategoryId = useCallback(async (): Promise<string> => {
    const existing = categories.find(
      (c) => c.type === 'income' && c.isActive !== false && /realised gain/i.test(c.name)
    );
    if (existing) return existing.id;
    const anchor = categories.find((c) => c.level === 'type' && c.type === 'income');
    const created = await addCategory({
      name: 'Realised gains',
      type: 'income',
      level: 'sub',
      parentId: anchor?.id ?? null,
      isSystem: false
    });
    return created.id;
  }, [categories, addCategory]);

  /**
   * BUY MORE (slice 4): extend a live position from its register. Same
   * write order as the add — cash truth first, then the event, then the
   * snapshot — and each failure names what IS saved. The register modal
   * only offers the form when the holding's currency is the account's, so
   * the event-currency invariant holds by construction.
   */
  const handleBuyMore = useCallback(
    async (holding: InvestmentHolding, trade: LiveBuyDetails): Promise<void> => {
      const accountId = holding.accountId;
      if (accountId === null) throw new Error('This holding names no account.');
      const amount = trade.quantity.times(trade.price).plus(trade.charges);
      // LOCAL day — see handleAddHolding's event date.
      const day = localDayKey(trade.date);

      if (trade.fundingAccountId !== null) {
        const outLeg = await addTransaction({
          accountId: trade.fundingAccountId,
          amount: -Math.abs(amount.toNumber()),
          type: 'transfer',
          date: trade.date,
          description: `Buy ${formatDecimal(trade.quantity, 4)} ${holding.symbol}`,
          category: transferCategoryIdFor(categories, accountId, -Math.abs(amount.toNumber())),
          cleared: false,
        });
        await createTransferCounterpart(outLeg.id, accountId);
      } else {
        /**
         * The SAME hole #516 closed on Add a holding, on this path: an
         * unfunded buy-more put its cost in the events and nowhere in the
         * ledger, so the position gained units while the account gained
         * nothing — the owner's second lot read as a LOSS of the whole
         * £6,192.82 minus its market value. Same recipe, same description
         * the companions and the delete cleanup already match.
         */
        const opening = openingPositionRow({
          fundingAccountId: null,
          costInAccountMoney: amount,
          quantity: trade.quantity,
          symbol: holding.symbol,
          date: trade.date,
          categories
        });
        if (opening.row !== null) {
          await addTransaction({
            accountId,
            amount: opening.row.amount.toNumber(),
            type: 'income',
            date: opening.row.date,
            description: opening.row.description,
            category: opening.row.categoryId,
            cleared: false,
          });
        }
      }

      try {
        await dataPort.recordInvestmentEvent({
          accountId,
          symbol: holding.symbol,
          securityName: holding.name,
          date: day,
          kind: 'buy',
          quantity: trade.quantity.toString(),
          price: trade.price.toString(),
          fees: trade.charges.greaterThan(0) ? trade.charges.toString() : null,
          amount: amount.toString(),
          currency: holding.currency
        });
        await dataPort.recordTradePrices([
          { symbol: holding.symbol, date: day, price: trade.price.toString(), currency: holding.currency }
        ]);
      } catch (error) {
        throw new Error(
          'The transfer was written, but the buy could not be recorded in the register' +
          `${error instanceof Error ? ` (${error.message})` : ''}. Try recording it again.`
        );
      }

      // The snapshot row: pooled quantity and average — fees in, as always.
      const newQuantity = holding.quantity.plus(trade.quantity);
      await dataPort.updateInvestment(holding.id, {
        quantity: newQuantity,
        averageCost: holding.costBasis.plus(amount).dividedBy(newQuantity)
      });
      await reloadHoldings();
    },
    [addTransaction, categories, createTransferCounterpart, reloadHoldings]
  );

  /**
   * SELL (slice 4, the owner's spec translated to the cost ledger): the
   * investment account's ledger holds pooled COST, so the sale writes the
   * proceeds OUT by transfer to the paired sleeve and the realised gain IN
   * as income — the account nets exactly the cost of the units sold, cash
   * receives the proceeds, the gain is visible as income, and nothing
   * double-counts. The derived valuation term zeroes as the pool empties,
   * so net worth is exact through the trade.
   *
   * Returns true when the position is fully sold — the row is removed and
   * the caller closes the register.
   */
  const handleSell = useCallback(
    async (holding: InvestmentHolding, trade: LiveSellDetails): Promise<boolean> => {
      const accountId = holding.accountId;
      if (accountId === null) throw new Error('This holding names no account.');
      if (trade.quantity.greaterThan(holding.quantity)) {
        throw new Error(`Only ${holding.quantity.toString()} units are held.`);
      }
      const proceeds = trade.quantity.times(trade.price).minus(trade.fees);
      const costOut = holding.averageCost.times(trade.quantity);
      const realised = proceeds.minus(costOut);
      // LOCAL day — see handleAddHolding's event date.
      const day = localDayKey(trade.date);

      if (trade.destinationAccountId !== null) {
        const outLeg = await addTransaction({
          accountId,
          amount: -Math.abs(proceeds.toNumber()),
          type: 'transfer',
          date: trade.date,
          description: `Sell ${formatDecimal(trade.quantity, 4)} ${holding.symbol}`,
          category: transferCategoryIdFor(categories, trade.destinationAccountId, -Math.abs(proceeds.toNumber())),
          cleared: false,
        });
        await createTransferCounterpart(outLeg.id, trade.destinationAccountId);
      }

      // The realised leg — skipped when zero, a zero row is noise.
      if (!realised.isZero()) {
        await addTransaction({
          accountId,
          amount: realised.toNumber(),
          type: realised.greaterThan(0) ? 'income' : 'expense',
          date: trade.date,
          description: `Realised ${realised.greaterThan(0) ? 'gain' : 'loss'} — ${holding.symbol}`,
          category: await realisedGainsCategoryId(),
          cleared: false,
        });
      }

      try {
        await dataPort.recordInvestmentEvent({
          accountId,
          symbol: holding.symbol,
          securityName: holding.name,
          date: day,
          kind: 'sell',
          quantity: trade.quantity.toString(),
          price: trade.price.toString(),
          fees: trade.fees.greaterThan(0) ? trade.fees.toString() : null,
          amount: proceeds.toString(),
          currency: holding.currency
        });
        await dataPort.recordTradePrices([
          { symbol: holding.symbol, date: day, price: trade.price.toString(), currency: holding.currency }
        ]);
      } catch (error) {
        throw new Error(
          'The cash was written, but the sale could not be recorded in the register' +
          `${error instanceof Error ? ` (${error.message})` : ''}. Try recording it again.`
        );
      }

      const fullySold = trade.quantity.greaterThanOrEqualTo(holding.quantity);
      if (fullySold) {
        await dataPort.deleteInvestment(holding.id);
      } else {
        await dataPort.updateInvestment(holding.id, {
          quantity: holding.quantity.minus(trade.quantity)
        });
      }
      await reloadHoldings();
      return fullySold;
    },
    [addTransaction, categories, createTransferCounterpart, realisedGainsCategoryId, reloadHoldings]
  );

  const holdingsByAccount = useMemo(() => {
    const map = new Map<string, InvestmentHolding[]>();
    for (const holding of holdings) {
      if (holding.accountId === null) continue;
      const list = map.get(holding.accountId) ?? [];
      list.push(holding);
      map.set(holding.accountId, list);
    }
    return map;
  }, [holdings]);

  // Helper function to format percentages
  const formatPercentage = (value: DecimalInstance | number, decimals: number = 2): string => {
    return `${formatDecimal(value, decimals)}%`;
  };

  const openAccounts = useMemo(() => accounts.filter(acc => acc.isActive !== false), [accounts]);

  // The portfolio set that drives the tabs and the empty state: every
  // investment account, including one paired inside another.
  const investmentAccounts = useMemo(
    () => openAccounts.filter(acc => acc.type === 'investment'),
    [openAccounts]
  );

  /**
   * What the PORTFOLIO TAB lists: one card per portfolio, in alphabetical
   * order.
   *
   * TWO THINGS THE FLAT LIST ABOVE GETS WRONG HERE, both reported by the
   * owner.
   *
   * ORDER. `investmentAccounts` is a filter over the accounts as the store
   * returned them, which is `created_at` ascending — for this ledger, the
   * order Microsoft Money happened to be imported in. It reads as random
   * because it is arbitrary, and nothing downstream re-sorted it.
   *
   * PAIRED CASH. A brokerage account and its settlement cash are ONE holding
   * to the person who owns them — the Microsoft Money model this app already
   * implements through `parentAccountId` (see utils/accountNesting and the
   * 20260722090000 migration, whose header says listing the cash side as a
   * free-standing account "is wrong"). The OVERVIEW tab has always honoured
   * it; this tab did not, so a cash sleeve typed 'investment' drew its own
   * card beside the portfolio it belongs to. Keeping only the roots folds it
   * back where it belongs, and needs no schema change — the pairing is
   * already in the data.
   *
   * A cash account that is genuinely unparented still appears on its own, and
   * that is correct: the app cannot invent a pairing nobody has recorded. The
   * remedy for those is Account Settings → "Part of investment account".
   */
  /** The holding whose register is open, or null. Cloud-only door — the
      device edition has no price series yet, so rows there stay plain. */
  const [registerHolding, setRegisterHolding] = useState<InvestmentHolding | null>(null);

  /**
   * Closed portfolios, on request (owner, 27 Aug): his imported price history
   * belongs to securities held in portfolios that are now closed, and "look
   * back at what was in there" is the whole point of importing it. Off by
   * default — the everyday page shows the money that exists today — and
   * remembered, like every other arrangement choice.
   */
  const [showClosedPortfolios, setShowClosedPortfolios] = useLocalStorage<boolean>(
    'wt_portfolio_show_closed',
    false
  );

  // A–Z is a claim about an alphabet, so it asks the same question the dates
  // ask rather than pinning a region of its own. It was 'en-GB' hard-coded,
  // which is the app's DEFAULT answer and not necessarily the reader's.
  const portfolioRootAccounts = useMemo(() => {
    const topLevelIdByAccountId = buildTopLevelIdByAccountId(openAccounts);
    return investmentAccounts
      .filter(acc => topLevelIdByAccountId.get(acc.id) === acc.id)
      .slice()
      .sort((a, b) => compareNames(a.name, b.name));
  }, [investmentAccounts, openAccounts]);

  const accountsById = useMemo(
    () => new Map(openAccounts.map(acc => [acc.id, acc])),
    [openAccounts]
  );

  // Value, contributions and return over the investment↔cash PAIRS — an
  // account's settlement cash is part of what the portfolio is worth, and
  // moving money between the two sides is not a contribution. See
  // utils/portfolioSummary; the nesting rules are the Accounts page's own.
  /**
   * OPEN AND CLOSED, because every figure here walks history. Measured on
   * the owner's ledger (20 Aug): over open accounts alone, all-time money
   * in read at less than half its true figure — a closed sleeve's transfers
   * vanished, and transfers TO it were misread as money leaving the
   * portfolio. The same trap the net-worth report fixed; see
   * useHistoricalAccounts. A fully closed pair keeps its line (usually at
   * £0), which is what makes the contributions attribution sum true.
   */
  const historicalAccounts = useHistoricalAccounts(openAccounts);

  /** Closed investment roots. Derived unconditionally — the toggle's label
      wants the count even while they are hidden, and the render gates the
      cards. */
  const closedPortfolioRootAccounts = useMemo(() => {
    const topLevelIdByAccountId = buildTopLevelIdByAccountId(historicalAccounts);
    return historicalAccounts
      .filter(acc => acc.type === 'investment' && acc.isActive === false)
      .filter(acc => topLevelIdByAccountId.get(acc.id) === acc.id)
      .slice()
      .sort((a, b) => compareNames(a.name, b.name));
  }, [historicalAccounts]);

  /**
   * ONE conversion source for the whole chain (the Investments chain,
   * 23 Aug): balances at today's factors, valuations and flows at their own
   * days' ECB rates, holdings by listing currency — over open AND CLOSED
   * members, because the walks span their history. Null/undefined on an
   * all-sterling ledger, which keeps every figure exactly as it was.
   */
  const {
    seriesConversion: scopeConversion,
    historical: scopeHistorical,
    conversion,
    conversionAt,
    rateFor,
  } = useNetWorthConversion(historicalAccounts, { range: { from: null, to: null } });
  const flowConvert = useFlowConvert(historicalAccounts);
  /**
   * The valuation term (slice 3b): the SAME buildInvestmentValuation every
   * net-worth surface reads, so this page's headline cannot value a position
   * differently from the dashboard one click away.
   */
  const valuation = useInvestmentValuation();
  const valuationDayKey = netWorthPointToken(new Date());
  const summary = useMemo(
    () => buildPortfolioSummary({
      accounts: historicalAccounts, transactions, transactionSplits, categories,
      conversion: conversion ?? undefined, flowConvert,
      investmentDeltaToday: (accountId) => valuation.deltaAt(accountId, valuationDayKey),
    }),
    [historicalAccounts, transactions, transactionSplits, categories, conversion, flowConvert, valuation, valuationDayKey]
  );

  /**
   * GROSS OR NET — the one place a secured liability is allowed near a total.
   *
   * `securedAgainstAccountId` is display-only everywhere else by design: a
   * mortgage does not move section and is never added to the asset it is held
   * against. This is the deliberate exception, and it is opt-in for the reason
   * that makes it safe — GROSS is the default and is what this page has always
   * shown, so nobody's portfolio value changes meaning without them asking.
   *
   * Only liabilities secured against an account that COUNTS toward this
   * portfolio are subtracted, which is the pairs the summary already walks:
   * a loan drawn against a cash sleeve is drawn against the portfolio, because
   * the sleeve's money is in the portfolio's value.
   */
  const [showNetPosition, setShowNetPosition] = useLocalStorage<boolean>(
    'wt_investments_net_position',
    false
  );

  const securedAgainstPortfolio = useMemo(() => {
    // Every account whose money counts toward an investment account.
    const withinPortfolio = new Set<string>();
    for (const account of openAccounts) {
      if (account.type === 'investment') withinPortfolio.add(account.id);
    }
    for (const account of openAccounts) {
      const parentId = account.parentAccountId;
      if (parentId && withinPortfolio.has(parentId)) withinPortfolio.add(account.id);
    }

    let total = toDecimal(0);
    const names: string[] = [];
    for (const account of openAccounts) {
      // ONCE PER LIABILITY, not once per link. A loan drawn against two of
      // these portfolios names both, and subtracting it twice would take
      // millions off a total for a debt that exists once. `some` rather than a
      // loop over the ids is the whole guard.
      const targets = normaliseSecuredIds(account.securedAgainstAccountIds ?? [], account.id);
      if (!targets.some(id => withinPortfolio.has(id))) continue;
      // A debt is carried negative, and this is a magnitude to subtract.
      total = total.plus(toDecimal(Math.abs(account.balance ?? 0)));
      names.push(account.name);
    }
    return { total, names };
  }, [openAccounts]);

  /**
   * The debts secured against ONE portfolio line — the account itself or any
   * cash sleeve counted inside it.
   *
   * The sleeves matter: a loan drawn against "Rathbones – Investment Portfolio
   * (Cash)" is drawn against the Rathbones holding, because that sleeve's money
   * is part of what the holding is worth.
   */
  const securedAgainstLine = useCallback(
    (line: { accountId: string; cash: ReadonlyArray<{ accountId: string }> }) => {
      const within = new Set<string>([line.accountId, ...line.cash.map(c => c.accountId)]);
      return openAccounts.filter(a =>
        normaliseSecuredIds(a.securedAgainstAccountIds ?? [], a.id).some(id => within.has(id))
      );
    },
    [openAccounts]
  );



  // The window the chart covers. 'ALL' is unbounded at both ends, which the
  // history walk reads as "first transaction until today".
  const historyRange = useMemo(() => {
    if (selectedPeriod === 'all') return { from: null, to: null };
    // Borrowed whole, so the two pages cannot disagree about when the tax year
    // starts — including in the days between 1 and 5 April, which is exactly
    // when a second implementation would have been caught.
    if (selectedPeriod === 'tax-year') return resolvePeriod('tax-year', '', '');
    // Straight through the app's own resolver, so "Custom" means here exactly
    // what it means on the Dashboard and on Reports — including how it treats
    // a half-filled range.
    if (selectedPeriod === 'custom') return resolvePeriod('custom', customStart, customEnd);
    const months = INVESTMENT_PERIOD_MONTHS[selectedPeriod];
    const now = new Date();
    return { from: new Date(now.getFullYear(), now.getMonth() - months, now.getDate()), to: now };
  }, [selectedPeriod, customStart, customEnd]);

  /**
   * THE SCOPE — the whole portfolio, or one pair (owner, 20 Aug: "we need
   * to have a similar page viewable for individual investment accounts, so
   * I can see how a singular portfolio is performing"). One selector; the
   * tiles, the return band, the chart and every drill follow it.
   */
  const [performanceScope, setPerformanceScope] = useState<string>('all');
  const pairGroups = useMemo(() => {
    const topLevelIdByAccountId = buildTopLevelIdByAccountId(historicalAccounts);
    return {
      topLevelIdByAccountId,
      membersByTopLevelId: groupByTopLevelId(historicalAccounts, topLevelIdByAccountId),
    };
  }, [historicalAccounts]);
  const scopeMembers = useMemo(
    () => performanceScope === 'all'
      ? summary.memberAccounts
      : (pairGroups.membersByTopLevelId.get(performanceScope) ?? summary.memberAccounts),
    [performanceScope, summary.memberAccounts, pairGroups]
  );

  // Real history: what the SCOPE was worth on each date, never a projection
  // of today's figure backwards. The scope's members convert exactly as the
  // net-worth surfaces do (currency audit, 22 Aug) — a dollar sleeve in a
  // sterling pair used to join this chart as that many pounds — and at each
  // day's own reference rate where the history is loaded (the owner's
  // backdated-rates ask), so a currency's movement stops masquerading as
  // portfolio value. Null for the all-sterling scope, which keeps its
  // arithmetic untouched.
  /** ≈ gates (ruling §6.3): only where a conversion is actually inside. */
  const scopeHoldsForeign = useMemo(
    () => conversion !== null && scopeMembers.some(m => conversion.factors.has(m.id)),
    [conversion, scopeMembers]
  );
  const scopeApprox = scopeHoldsForeign ? '\u2248 ' : '';
  const performanceData = useMemo(
    () => buildPortfolioHistory(scopeMembers, transactions, historyRange, new Date(), scopeConversion ?? undefined, valuation.deltaAt),
    [scopeMembers, transactions, historyRange, scopeConversion, valuation]
  );

  /**
   * THE RETURN, BOTH WAYS (owner, 20 Aug, after researching how the big
   * firms measure it): time-weighted for how the investments performed,
   * money-weighted for the owner's own experience — over the SAME window
   * the chart shows, from the same ledger walk. The maths and the owner's
   * boundary rules live in utils/portfolioPerformance, pinned by test.
   */
  const performance = useMemo(
    () => computePortfolioPerformance({
      memberAccounts: scopeMembers,
      transactions,
      transactionSplits,
      categories,
      range: historyRange,
      conversionAt: conversionAt ?? undefined,
      deltaAt: valuation.deltaAt,
    }),
    [scopeMembers, transactions, transactionSplits, categories, historyRange, conversionAt, valuation]
  );

  /**
   * THE CHART'S PER-DATE DRILL (owner, 20 Aug): click a point and see the
   * pairs and figures that make up that total — the net-worth report's own
   * answer to a point, over this page's scope.
   */
  const [drillDate, setDrillDate] = useState<Date | null>(null);
  const drillRows = useMemo(() => {
    if (!drillDate) return null;
    const rows = historicalAccounts
      .filter(a => a.type === 'investment' && pairGroups.topLevelIdByAccountId.get(a.id) === a.id)
      .filter(a => performanceScope === 'all' || a.id === performanceScope)
      .map(root => ({
        accountId: root.id,
        name: root.name,
        value: scopeValueAt(pairGroups.membersByTopLevelId.get(root.id) ?? [root], transactions, drillDate, conversionAt ?? undefined),
      }))
      .filter(row => !row.value.isZero())
      .sort((a, b) => b.value.minus(a.value).toNumber());
    return {
      rows,
      total: rows.reduce((sum, row) => sum.plus(row.value), toDecimal(0)),
    };
  }, [drillDate, historicalAccounts, pairGroups, performanceScope, transactions, conversionAt]);

  /**
   * Per-pair windowed performance, for the tile drills: the same maths as
   * the headline, one pair at a time, so the breakdown's lines SUM to the
   * tile (pair-to-pair transfers appear on both sides and net away).
   */
  const perPairPerformance = useMemo(() => {
    const byRoot = new Map<string, ReturnType<typeof computePortfolioPerformance>>();
    for (const line of summary.lines) {
      if (performanceScope !== 'all' && line.accountId !== performanceScope) continue;
      byRoot.set(line.accountId, computePortfolioPerformance({
        conversionAt: conversionAt ?? undefined,
        memberAccounts: pairGroups.membersByTopLevelId.get(line.accountId) ?? [],
        transactions,
        transactionSplits,
        categories,
        range: historyRange,
      }));
    }
    return byRoot;
  }, [summary.lines, performanceScope, pairGroups, transactions, transactionSplits, categories, historyRange, conversionAt]);

  const netPortfolioValue = useMemo(
    () => toDecimal(performance.endValue).minus(securedAgainstPortfolio.total),
    [performance.endValue, securedAgainstPortfolio.total]
  );

  /** A window-filter for drill rows, from the same range the figures use. */
  const inWindow = useMemo(() => {
    const from = historyRange.from ? dayOf(historyRange.from) : null;
    const to = dayOf(historyRange.to ?? new Date());
    return (date: Date | string): boolean => {
      const day = dayOf(date);
      return (from === null || day >= from) && day <= to;
    };
  }, [historyRange]);

  /** Which measure leads — the user's choice, remembered (GIPS shows both). */
  const [performanceMeasure, setPerformanceMeasure] = useState<'mwr' | 'twr'>(
    (): 'mwr' | 'twr' => (preferences.getItem('money_management_perf_measure') === 'twr' ? 'twr' : 'mwr')
  );
  const choosePerformanceMeasure = (measure: 'mwr' | 'twr'): void => {
    setPerformanceMeasure(measure);
    preferences.setItem('money_management_perf_measure', measure);
  };

  /** +2.35% / (2.35%) — the app's sign conventions, worn by a percentage. */
  const formatReturn = (value: DecimalInstance | null): string => {
    if (value === null) return '—';
    const percent = value.abs().times(100).toFixed(2);
    if (value.isZero()) return '0.00%';
    return value.greaterThan(0) ? `+${percent}%` : `(${percent}%)`;
  };

  // Numbers for the donut, converted once at the chart boundary.
  /**
   * THE SLICES, capped at what the palette can colour.
   *
   * This drew one slice per account — twelve, against a five-colour ramp — so
   * slices 1 and 6 and 11 were painted identically and the ring read as one
   * grey doughnut. Reported by the owner as "the pie looks all the same colour
   * to the eye vs the legend".
   *
   * The four largest keep their own slice and everything below them becomes a
   * single remainder, which is the honest shape: a 0.01% wedge is not a slice
   * anybody can see or click, and pretending otherwise is what made the legend
   * twelve rows long. The remainder is NAMED with its count so the total is
   * still accounted for — a share that does not add up is the one thing a
   * finance chart may not do.
   *
   * WHICH four are the largest is now `capSeriesWithRemainder`'s job and not
   * this line's: `summary.lines` comes back in ACCOUNT order, so the fold used
   * to take whichever accounts sat last in that list. On the owner's ledger
   * that folded his two biggest into "2 smaller accounts · 78.73%" (29
   * August). The utility ranks before it folds; nothing here has to remember.
   */
  const allocationData = useMemo(
    () => capSeriesWithRemainder(
      summary.lines.filter(line => line.value.greaterThan(0)),
      line => line.value.toNumber(),
      line => line.name,
      'accounts'
    ),
    [summary.lines]
  );

  /**
   * IS THE FOLD OPEN — the honest answer to "what is in it" (owner, 29
   * August: "I cannot click on any of the 5 legends to drill in").
   *
   * A fold summarises; opening it should show what it summarised, not send
   * the reader somewhere else. So the folded accounts list themselves UNDER
   * their own legend row, one step in, each a door to its register — while
   * the RING keeps its five wedges. That last part is deliberate: the ramp
   * has five colours and cycles past them (see chartColors), so a ring that
   * drew every account would paint the sixth like the first, which is the
   * exact defect the cap exists to prevent. The legend can be long; the ring
   * cannot.
   */
  const [allocationFoldOpen, setAllocationFoldOpen] = useState(false);

  /** The register a portfolio line keeps its money in. */
  const registerPathFor = useCallback(
    (accountId: string): string => preserveDemoParam(`/accounts/${accountId}`, location.search),
    [location.search]
  );

  /**
   * A WEDGE ANSWERS THE SAME CLICK ITS LEGEND ROW DOES.
   *
   * A named slice is an account, and an account's detail is its register —
   * the destination every other account-shaped thing on this page already
   * links to. The fold is not a place, so it opens instead: the reader asked
   * what is inside it, and the answer is inside it.
   */
  const openAllocationSlice = useCallback(
    (slice: (typeof allocationData)[number]): void => {
      if (slice.folded) {
        setAllocationFoldOpen(true);
        return;
      }
      if (slice.source) navigate(registerPathFor(slice.source.accountId));
    },
    [navigate, registerPathFor]
  );

  // The LEDGER lines, one per investment account. Named for what they are:
  // `holdings` is now the market-side data from public.investments, and the two
  // must never be confused for each other on this page.
  const portfolioLines = summary.lines;

  /**
   * HOW THE HOLDINGS LIST IS ARRANGED — the Accounts page's controls, brought
   * to the one other long list in the app (owner, 16 August). Persisted for
   * the same reason the actions toggle is: an arrangement chosen once should
   * survive a refresh.
   */
  const [holdingsSort, setHoldingsSort] = useLocalStorage <'default' | 'name' | 'name-desc' | 'value' | 'value-asc'>(
    'wt_holdings_sort',
    'default'
  );
  const [groupHoldingsByInstitution, setGroupHoldingsByInstitution] = useLocalStorage<boolean>(
    'wt_holdings_group',
    false
  );

  const sortedHoldingLines = useMemo(() => {
    if (holdingsSort === 'default') return portfolioLines;
    const lines = [...portfolioLines];
    if (holdingsSort === 'name' || holdingsSort === 'name-desc') {
      lines.sort((a, b) => compareText(a.name, b.name));
      if (holdingsSort === 'name-desc') lines.reverse();
    } else {
      lines.sort((a, b) => b.value.comparedTo(a.value));
      if (holdingsSort === 'value-asc') lines.reverse();
    }
    return lines;
  }, [portfolioLines, holdingsSort]);

  /** institution → its lines, in the sorted order; null when not grouping. */
  const groupedHoldingLines = useMemo(() => {
    if (!groupHoldingsByInstitution) return null;
    const map = new Map<string, typeof portfolioLines>();
    for (const line of sortedHoldingLines) {
      const key = line.institution || 'No institution';
      const list = map.get(key);
      if (list) list.push(line);
      else map.set(key, [line]);
    }
    return [...map.entries()];
  }, [groupHoldingsByInstitution, sortedHoldingLines]);

  /**
   * WHAT the money is in, as opposed to WHERE it is kept.
   *
   * The ring above answers "which account holds it", which tells somebody with
   * one broker and six wrappers nothing. This one crosses accounts: Apple held
   * in an ISA and in a dealing account is one position, and every settlement
   * sleeve in the portfolio is a single Cash category.
   */
  const holdingAllocation = useMemo(
    () => buildHoldingAllocation(holdings, summary.lines, rateFor),
    [holdings, summary.lines, rateFor]
  );

  const holdingSlices = useMemo(
    () => capSeriesWithRemainder(
      holdingAllocation.slices,
      slice => slice.value.toNumber(),
      slice => slice.label,
      'holdings'
    ),
    [holdingAllocation.slices]
  );

  /**
   * The two-section split the cash-only card shows: the investment accounts'
   * own value against the settlement sleeves, sharing out the portfolio
   * (owner, 22 Aug). line.value is the pair and line.cash the nested part,
   * so investments = Σvalue − Σcash and the two rows sum to summary.value by
   * construction. Shares are of that same total, so they read 100% together.
   */
  const cashOnlySplit = useMemo(() => {
    const total = summary.value;
    const cash = summary.lines.reduce(
      (sum, line) => line.cash.reduce((inner, entry) => inner.plus(entry.value), sum),
      toDecimal(0)
    );
    const investments = total.minus(cash);
    const shareOf = (part: DecimalInstance): string =>
      total.greaterThan(0)
        ? `${((part.toNumber() / total.toNumber()) * 100).toFixed(2)}%`
        : '0.00%';
    return [
      { label: 'Investments', value: investments, share: shareOf(investments) },
      { label: 'Cash', value: cash, share: shareOf(cash) },
    ];
  }, [summary]);

  const holdingSlicesTotal = useMemo(
    () => holdingSlices.reduce((sum, slice) => sum + slice.value, 0),
    [holdingSlices]
  );

  const allocationTotal = useMemo(
    () => allocationData.reduce((sum, slice) => sum + slice.value, 0),
    [allocationData]
  );
  const isGain = performance.gain.greaterThanOrEqualTo(0);
  // The shared ramp. The array that stood here claimed to be "consistent
  // colors" while being the only one of the app's palettes to differ from its
  // twin — positions seven and eight had drifted to a cyan and a lime.
  // ONE reading of the ground per render: the ramp picks the performance
  // chart's stroke and the wash picks its strength from the same boolean, so
  // they cannot disagree about the theme (charts/richLine).
  const isDark = useIsDarkGround();
  const ramp = categoricalRamp(isDark);
  const chartTooltipStyle = useChartTooltipStyle();
  const chartTooltipItemStyle = useChartTooltipItemStyle();

  /*
   * NO INVESTMENT ACCOUNTS — but the WATCHLIST still opens.
   *
   * This branch used to return an empty state for the whole page, which took
   * the Watchlist tab with it. The owner found it on a fresh ledger and the
   * objection is exact: a watchlist is a list of things you do NOT own. Making
   * it conditional on already owning an investment account is backwards — it
   * withholds the one feature a person has before they have a portfolio, and
   * withholds it precisely while they are deciding what to buy.
   *
   * So the empty state now stands in for the PORTFOLIO half only, and the tabs
   * stay. Overview, Portfolio and Manage have genuinely nothing to say without
   * an account; Watchlist has everything it ever had, because it never needed
   * one.
   */
  if (investmentAccounts.length === 0 && activeTab !== 'watchlist') {
    return (
      <div>
        {/* The conversion pass reached the populated page and not this branch, because an
            early return is easy to read past. Same hairline card, same ink, as everywhere. */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-4 mb-6">
          <h1 className="text-page font-semibold text-gray-900 dark:text-white">Investments</h1>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-8 text-center">
          <BarChart3Icon className="mx-auto text-gray-400 mb-4" size={64} />
          <h2 className="text-card font-semibold text-theme-heading dark:text-white mb-2">
            No Investment Accounts Yet
          </h2>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            Add an investment account to start tracking your portfolio performance.
          </p>
          <p className="text-body text-gray-500 dark:text-gray-500">
            Go to Accounts → Add Account → Choose &ldquo;Investment&rdquo; as the account type
          </p>
          {/* The way THROUGH, not a description of one. The tab bar lives in
              the populated branch, and duplicating it here to reach one tab
              would be two tab bars to keep in step. One button switches the
              tab; the page then renders in full, real tabs and all. */}
          <button
            type="button"
            onClick={() => setActiveTab('watchlist')}
            className="mt-6 px-4 py-2 rounded-lg bg-[#1a2332] dark:bg-[#2d3a4d] text-white font-medium hover:bg-[#2d3a4d] transition-colors"
          >
            Open the Watchlist
          </button>
          <p className="mt-3 text-body text-gray-500 dark:text-gray-400">
            It works without an investment account — it is for the things you do
            not own yet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <PageWrapper 
      title="Investments"
      rightContent={
        investmentAccounts.length > 0 && (
          <div className="relative">
          <button
            type="button"
            onClick={() => {
              // One account is not a question. Several is, and the answer
              // decides which sleeve the holding lands in.
              if (investmentAccounts.length === 1) openAddHoldingFor(investmentAccounts[0].id);
              else setAddHoldingMenuOpen(open => !open);
            }}
            aria-expanded={investmentAccounts.length > 1 ? addHoldingMenuOpen : undefined}
            className="cursor-pointer rounded-full"
            aria-label="Add a holding"
          >
            <svg
              width="48"
              height="48"
              viewBox="0 0 48 48"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
              focusable="false"
              className="transition-all duration-200 hover:scale-110 drop-shadow-lg hover:drop-shadow-xl"
            >
              <circle
                cx="24"
                cy="24"
                r="24"
                fill="#D9E1F2"
                className="transition-all duration-200"
                onMouseEnter={(e) => e.currentTarget.setAttribute('fill', '#C5D3E8')}
                onMouseLeave={(e) => e.currentTarget.setAttribute('fill', '#D9E1F2')}
              />
              <g transform="translate(12, 12)">
                <path 
                  d="M12 5v14M5 12h14" 
                  stroke="#1F2937" 
                  strokeWidth="2" 
                  strokeLinecap="round" 
                  strokeLinejoin="round"
                />
              </g>
            </svg>
          </button>
          {/* WHICH ACCOUNT? — asked, never guessed. A holding belongs to a
              sleeve, and the wrong sleeve is a mis-filing that only shows up
              later, in a total that does not match a broker's statement. */}
          {addHoldingMenuOpen && investmentAccounts.length > 1 && (
            <div className="absolute right-0 top-full mt-2 z-30 min-w-[240px] bg-white dark:bg-gray-800 border border-line dark:border-gray-700 rounded-lg shadow-lg p-1">
              <p className="px-3 py-2 text-dense text-gray-500 dark:text-gray-400">
                Add a holding to…
              </p>
              {investmentAccounts.map(account => (
                <button
                  key={account.id}
                  type="button"
                  onClick={() => openAddHoldingFor(account.id)}
                  className="w-full text-left px-3 py-2 text-body text-gray-900 dark:text-white rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  {account.name}
                </button>
              ))}
            </div>
          )}
          </div>
        )
      }
    >
      <div className="flex flex-wrap justify-end gap-x-4 gap-y-1 mb-2">
        <NegativesInRedToggle />
        <WholePoundsToggle />
      </div>
      {/* THE PAGE'S ONE RATE-BASIS LINE (ruling §6.2), now that the chain
          converts (23 Aug): two bases, both said — balances are worth what
          they are worth TODAY, flows moved on their own days. While the
          history is absent the flows stay native and the line says that
          instead; with no rates at all the Phase 0 disclosure stands.
          Nothing for a single-currency ledger. */}
      {conversion !== null && (
        conversion.factors.size === 0 ? (
          <MixedCurrencyDisclosure className="mb-3" />
        ) : scopeHistorical ? (
          <p className="mb-3 text-dense text-gray-500 dark:text-gray-400" data-testid="investments-rates-basis">
            ≈ Balances converted at today’s rates; money in and out at each
            day’s ECB reference rate.
          </p>
        ) : (
          <p className="mb-3 text-dense text-gray-500 dark:text-gray-400" data-testid="investments-rates-basis">
            ≈ Balances converted at today’s rates. Money in and out is counted
            unit-for-unit until the rate history loads.
          </p>
        )
      )}
      {/* Navigation Tabs */}
      <div className="flex space-x-1 bg-gray-100 dark:bg-gray-700 p-1 rounded-lg mb-6">
        <button
          onClick={() => setActiveTab('overview')}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 text-body font-medium rounded-md transition-colors ${
            activeTab === 'overview'
              ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          <BarChart3Icon size={16} />
          Overview
        </button>
        <button
          onClick={() => setActiveTab('watchlist')}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 text-body font-medium rounded-md transition-colors ${
            activeTab === 'watchlist'
              ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          <EyeIcon size={16} />
          Watchlist
        </button>
        <button
          onClick={() => setActiveTab('portfolio')}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 text-body font-medium rounded-md transition-colors ${
            activeTab === 'portfolio'
              ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          <LineChartIcon size={16} />
          Portfolio
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="grid gap-6">
        {/* THE FOUR TILES READ OVER THE CHART'S WINDOW AND SCOPE (owner,
            20 Aug: "the 4 boxes with figures in them should represent
            whatever period you pick for the chart below"), through the same
            maths as the return band — one definition, so the tiles and the
            band can never disagree again (they did: the old tiles counted
            transfers only, all time, and openings as return). */}
        {summary.lines.length > 1 && (
          <div className="flex justify-end -mb-2">
            <select
              value={performanceScope}
              onChange={(e) => { setPerformanceScope(e.target.value); setDrillLineId(null); }}
              aria-label="Which portfolio the figures cover"
              className="text-sm border border-line dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white px-2 py-1.5"
            >
              <option value="all">All portfolios</option>
              {summary.lines.map(line => (
                <option key={line.accountId} value={line.accountId}>{line.name}</option>
              ))}
            </select>
          </div>
        )}
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
          <div className="flex items-center justify-between">
            {/* No glyph. A bar chart beside "Portfolio Value" says the word
                again in a picture; the arrows on Total Return and Return %
                below stay, because those carry DIRECTION and a direction is
                not decoration. Same reduction as #281 and #296. */}
            <div className="min-w-0">
              <p className="text-body text-gray-500 dark:text-gray-400">
                {showNetPosition && securedAgainstPortfolio.names.length > 0
                  ? 'Portfolio Value (net)'
                  : 'Portfolio Value'}
              </p>
              <p className={`text-page font-bold ${valueTone(
                showNetPosition && securedAgainstPortfolio.names.length > 0 ? netPortfolioValue : performance.endValue,
                'text-gray-900 dark:text-white'
              )}`}>
                {scopeApprox}{formatCurrency(
                  showNetPosition && securedAgainstPortfolio.names.length > 0
                    ? netPortfolioValue
                    : performance.endValue
                )}
              </p>
              {/* A value from a window that ends in the past says WHEN it is
                  from — a figure wearing today's label for last tax year's
                  money would be the quiet lie this page exists to avoid. */}
              {historyRange.to && dayOf(historyRange.to) !== dayOf(new Date()) && (
                <p className="text-dense text-gray-500 dark:text-gray-400 mt-0.5">
                  on {historyRange.to.toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'short', year: 'numeric' })}
                </p>
              )}
              {/* The control appears ONLY when something is actually secured
                  against this portfolio. A gross/net switch with nothing to
                  net off is a question about a distinction that does not exist
                  here, and answering it changes no number — which teaches the
                  reader that the switch does nothing.

                  When it IS shown, the label says which liabilities, because
                  "net" is not self-explanatory and a total whose composition
                  you cannot see is a total you cannot check. */}
              {securedAgainstPortfolio.names.length > 0 && (
                <div className="mt-3">
                  {/* ToggleSwitch, not a bare checkbox. `index.css` floors every
                      `input` at 44x44 on a touch device, so on a phone this
                      rendered as a large square with its label stranded at the
                      top of it — the owner's report. ToggleSwitch is EXEMPT
                      from that rule by name and carries its own >=44px hit area
                      through padding while the visible track stays slim, which
                      is the whole reason it exists.

                      `items-center` too: the label is one or two lines beside a
                      control of fixed height, so aligning to the top left it
                      high on the phone where it wraps. */}
                  <label className="flex items-center gap-3 cursor-pointer">
                    <ToggleSwitch
                      checked={showNetPosition}
                      onChange={setShowNetPosition}
                      aria-label="Subtract secured liabilities from the portfolio value"
                    />
                    {/* The NAMES moved to the holdings they belong to. This
                        label had become a paragraph listing every liability in
                        the portfolio, which named them all and located none. A
                        count and a total say the same thing in one line, and
                        the detail is now beside the holding it concerns. */}
                    <span className="text-dense text-gray-500 dark:text-gray-400">
                      Subtract {securedAgainstPortfolio.names.length} secured{' '}
                      {securedAgainstPortfolio.names.length === 1 ? 'liability' : 'liabilities'}{' '}
                      ({formatCurrency(securedAgainstPortfolio.total)})
                    </span>
                  </label>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ─ TWO TILES THAT OPEN (owner, 16 August, asked twice) ────────────
            Buttons, with `block` against the global inline-flex rule and
            `text-left` so they keep reading as the tiles they were. The
            breakdown they open renders full-width under the tile row —
            per-account figures from the SAME walk as the totals (see
            portfolioSummary: one classification, two aggregations, so the
            rows always sum to the tile). */}
        <button
          type="button"
          onClick={() => setOpenBreakdown(openBreakdown === 'contributions' ? null : 'contributions')}
          aria-expanded={openBreakdown === 'contributions'}
          className={`block w-full text-left bg-white dark:bg-gray-800 rounded-lg border p-6 transition-colors hover:border-gray-300 dark:hover:border-gray-500 ${
            openBreakdown === 'contributions' ? 'border-[#6b86b3]' : 'border-line dark:border-gray-700'
          }`}
        >
          {/* THE LABEL FLIPS RATHER THAN THE FIGURE (Design's signed-label
              ruling, 24 Aug): a label describing a DIRECTION carrying a
              negative value asks the reader to invert a word, and words do
              not inverse cleanly — "Net Contributions (£19,338)" means money
              came out, which is the opposite of what it says. The app has a
              name for the other direction, so it uses it and prints the
              magnitude positive.

              The ruling's carve-outs hold elsewhere: this is a DERIVED
              SUMMARY figure, so it may be renamed. Transactions, balances
              and column totals keep the parentheses absolutely — a ledger's
              sign is data, not phrasing. */}
          <p className="text-body text-gray-500 dark:text-gray-400">
            {performance.netFlows.isNegative() ? 'Net withdrawals' : 'Net Contributions'}
          </p>
          {/* NEUTRAL, not link blue (Claude Design, 22 Aug §6): the tile IS
              clickable, but the affordance is the button's own hover border —
              permanently recolouring the number claimed link-ness in the one
              place colour already means something else. */}
          <p className="text-page font-bold text-gray-900 dark:text-white">
            {formatCurrency(performance.netFlows.abs())}
          </p>
          <p className="text-dense text-gray-500 dark:text-gray-400 mt-1">
            {performance.netFlows.isNegative()
              ? 'Taken out less put in over this period — click for each account’s share'
              : 'Put in less taken out over this period — click for each account’s share'}
          </p>
        </button>

        <button
          type="button"
          onClick={() => setOpenBreakdown(openBreakdown === 'return' ? null : 'return')}
          aria-expanded={openBreakdown === 'return'}
          className={`block w-full text-left bg-white dark:bg-gray-800 rounded-lg border p-6 transition-colors hover:border-gray-300 dark:hover:border-gray-500 ${
            openBreakdown === 'return' ? 'border-[#6b86b3]' : 'border-line dark:border-gray-700'
          }`}
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-body text-gray-500 dark:text-gray-400">Total Return</p>
              {/* NEUTRAL AT ZERO, like every figure in this app: a £0.00 gain
                  is not good news or bad, and green would claim one. */}
              <p className={`text-page font-bold ${
                performance.gain.isZero()
                  ? 'text-gray-900 dark:text-white'
                  : isGain ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
              }`}>
                {isGain && !performance.gain.isZero() ? '+' : ''}{formatCurrency(performance.gain)}
              </p>
            </div>
            {/* The arrow follows the SIGN of the figure it sits with, through
                the one component that owns that rule — this was a hard-coded
                up glyph, so a losing window would have shown a red arrow
                pointing UP (Claude Design, 22 Aug §1, the mirror of the
                Return % card beside it). */}
            <TrendArrow value={performance.gain} size={24} />
          </div>
        </button>

        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-body text-gray-500 dark:text-gray-400">Return %</p>
              {/* MWR, annualised, whole ledger — gain-over-net-contributions
                  turns absurd the moment withdrawals bring the net near zero
                  (measured on the owner's ledger: a small net under a large
                  gain). The money-weighted rate is the figure
                  a statement would print here. */}
              {performance.mwrAnnualised === null ? (
                <>
                  <p className="text-page font-bold text-gray-500 dark:text-gray-400">—</p>
                  <p className="text-dense text-gray-500 dark:text-gray-400 mt-1">
                    Nothing was invested in this window, so there is no return to measure
                  </p>
                </>
              ) : (
                <>
                  <p className={`text-page font-bold tabular-nums ${
                    performance.mwrAnnualised.isZero()
                      ? 'text-gray-900 dark:text-white'
                      : performance.mwrAnnualised.greaterThan(0)
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-red-600 dark:text-red-400'
                  }`}>
                    {formatReturn(performance.mwrAnnualised)}
                  </p>
                  <p className="text-dense text-gray-500 dark:text-gray-400 mt-1">
                    Money-weighted, annualised
                  </p>
                </>
              )}
            </div>
            {/* This was a hard-coded DOWN glyph recoloured by sign — so a
                +18.25% return wore a falling arrow, and the card disagreed
                with Total Return beside it about the same twelve months
                (Claude Design, 22 Aug §1: "a reader checks the arrow before
                the sign, because that's what an arrow is for"). The shared
                rule now decides: sign picks the direction, zero and
                unmeasurable render no arrow at all. */}
            <TrendArrow value={performance.mwrAnnualised} size={24} />
          </div>
        </div>
        </div>

        {/* The point's answer: each pair's value on that date, summing to
            the point that was clicked. */}
        <Modal
          isOpen={drillDate !== null}
          onClose={() => setDrillDate(null)}
          title={drillDate
            ? `Portfolio on ${drillDate.toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'long', year: 'numeric' })}`
            : ''}
          size="md"
        >
          <ModalBody>
            {drillRows && (
              drillRows.rows.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Nothing in the portfolio on this date.
                </p>
              ) : (
                <ul>
                  {drillRows.rows.map(row => (
                    <li key={row.accountId} className="py-2 flex items-baseline justify-between gap-4 border-t border-gray-50 dark:border-gray-700/50 first:border-0">
                      <span className="text-sm text-gray-900 dark:text-white truncate">{row.name}</span>
                      <span className={`text-sm tabular-nums shrink-0 ${valueTone(row.value, 'text-gray-900 dark:text-white')}`}>
                        {formatCurrency(row.value)}
                      </span>
                    </li>
                  ))}
                  <li className="py-2 flex items-baseline justify-between gap-4 border-t-2 border-gray-200 dark:border-gray-600">
                    <span className="text-sm font-semibold text-gray-900 dark:text-white">Total</span>
                    <span className={`text-sm font-semibold tabular-nums shrink-0 ${valueTone(drillRows.total, 'text-gray-900 dark:text-white')}`}>
                      {formatCurrency(drillRows.total)}
                    </span>
                  </li>
                </ul>
              )
            )}
          </ModalBody>
        </Modal>

        {/* ─ THE BREAKDOWN A TILE OPENS — a MODAL, like the app's other
            drill-downs (owner, 16 August). It shipped as an inline panel and
            pushed the whole page down; a pop-up leaves the tiles where the
            eye was.

            TWO LEVELS. The list is per account, from the SAME walk as the
            tile — one classification, two aggregations — with a Total row
            proving the sum. Clicking a line opens what the figure is MADE OF:
            the external transfers behind it, each on the member account it
            actually sat on. That last part is the lesson of the owner's IG
            Index click: the root's register was empty because the money moved
            through the cash sleeve, so "which account" and "where did this
            figure come from" had different answers. This is the second one. */}
        <Modal
          isOpen={openBreakdown !== null}
          onClose={() => { setOpenBreakdown(null); setDrillLineId(null); }}
          title={openBreakdown === 'contributions'
            ? `${performance.netFlows.isNegative() ? 'Net withdrawals' : 'Net Contributions'} by account`
            : 'Total Return by account'}
          size="lg"
        >
          <ModalBody>
            {(() => {
              const drillLine = drillLineId === null
                ? null
                : portfolioLines.find(l => l.accountId === drillLineId) ?? null;
              if (openBreakdown === null) return null;

              if (drillLine === null) {
                // WINDOWED, like the tiles they explain: each line is the
                // pair's own performance over the chart's period, so the
                // lines sum to the tile (pair-to-pair transfers appear on
                // both sides and net away).
                const scopedLines = portfolioLines.filter(
                  line => performanceScope === 'all' || line.accountId === performanceScope
                );
                return (
                  <div className="space-y-1">
                    {scopedLines.map(line => {
                      const pairPerf = perPairPerformance.get(line.accountId);
                      return (
                        <button
                          key={line.accountId}
                          type="button"
                          onClick={() => setDrillLineId(line.accountId)}
                          className="block w-full text-left py-2 px-2 -mx-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700/60 last:border-0"
                        >
                          <span className="flex justify-between gap-3">
                            <span className="min-w-0 truncate text-body text-gray-700 dark:text-gray-300">{line.name}</span>
                            <span className={`tabular-nums shrink-0 text-body ${valueTone(
                              openBreakdown === 'contributions' ? pairPerf?.netFlows : null,
                              'text-gray-900 dark:text-white'
                            )}`}>
                              {pairPerf
                                ? formatCurrency(openBreakdown === 'contributions' ? pairPerf.netFlows : pairPerf.gain)
                                : '—'}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                    <p className="flex justify-between gap-3 pt-3 font-semibold text-body text-gray-900 dark:text-white">
                      <span>Total</span>
                      <span className={`tabular-nums ${valueTone(openBreakdown === 'contributions' ? performance.netFlows : null, '')}`}>
                        {formatCurrency(openBreakdown === 'contributions' ? performance.netFlows : performance.gain)}
                      </span>
                    </p>
                  </div>
                );
              }

              // The rows behind this pair's contributions, WINDOWED — the
              // transfer legs inside the period plus any opening lump whose
              // effective date falls in it, so the list sums to Put in less
              // Taken out above.
              const drillMembers = pairGroups.membersByTopLevelId.get(drillLine.accountId) ?? [];
              const windowRows = [
                ...drillLine.contributionRows.filter(row => inWindow(row.date)),
                ...scopeOpeningFlows(drillMembers, transactions, conversionAt ?? undefined)
                  .filter(o => inWindow(new Date(`${o.day}T00:00:00Z`)))
                  .map(o => ({
                    transactionId: `opening:${o.accountId}`,
                    accountId: o.accountId,
                    date: new Date(`${o.day}T00:00:00Z`),
                    description: 'Opening balance',
                    amount: o.amount,
                  })),
              ].sort((a, b) => b.date.getTime() - a.date.getTime());

              return (
                <div>
                  <button
                    type="button"
                    onClick={() => setDrillLineId(null)}
                    className="text-body text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 mb-3"
                  >
                    ← All accounts
                  </button>
                  <h4 className="text-card font-semibold text-gray-900 dark:text-white mb-2">{drillLine.name}</h4>

                  {/* The identity first, WINDOWED like everything above it:
                      the same five figures the return band explains, for this
                      one pair over the chart's period. */}
                  {(() => {
                    const pairPerf = perPairPerformance.get(drillLine.accountId);
                    if (!pairPerf) return null;
                    return (
                      <div className="mb-4 space-y-1">
                        <p className="flex justify-between text-body text-gray-600 dark:text-gray-400">
                          <span>Started at</span>
                          <span className={`tabular-nums ${valueTone(pairPerf.startValue, '')}`}>{formatCurrency(pairPerf.startValue)}</span>
                        </p>
                        <p className="flex justify-between text-body text-gray-600 dark:text-gray-400">
                          <span>Put in</span>
                          <span className="tabular-nums">{formatCurrency(pairPerf.moneyIn)}</span>
                        </p>
                        <p className="flex justify-between text-body text-gray-600 dark:text-gray-400">
                          <span>Taken out</span>
                          <span className="tabular-nums">{formatCurrency(pairPerf.moneyOut)}</span>
                        </p>
                        <p className="flex justify-between text-body text-gray-600 dark:text-gray-400">
                          <span>Gain</span>
                          <span className="tabular-nums">{formatCurrency(pairPerf.gain)}</span>
                        </p>
                        <p className="flex justify-between font-semibold text-body text-gray-900 dark:text-white border-t border-gray-200 dark:border-gray-700 pt-1">
                          <span>Ended at</span>
                          <span className={`tabular-nums ${valueTone(pairPerf.endValue, '')}`}>{formatCurrency(pairPerf.endValue)}</span>
                        </p>
                      </div>
                    );
                  })()}

                  <p className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">
                    The movements behind the contributions, this period
                  </p>
                  {windowRows.length === 0 ? (
                    <p className="text-body text-gray-500 dark:text-gray-400 py-2">
                      No external transfers recorded — this account's whole value is return.
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {windowRows.map(row => {
                        const rowAccount = accountsById.get(row.accountId);
                        return (
                          <p key={row.transactionId} className="flex justify-between gap-3 py-1 border-b border-gray-100 dark:border-gray-700/60 last:border-0">
                            <span className="min-w-0 truncate text-body text-gray-700 dark:text-gray-300">
                              {formatDate(row.date)} · {row.description || '(no description)'}
                              {rowAccount && rowAccount.id !== drillLine.accountId && (
                                <span className="text-gray-400 dark:text-gray-500"> — {rowAccount.name}</span>
                              )}
                            </span>
                            <span className="tabular-nums shrink-0 text-body text-gray-900 dark:text-white">
                              {formatCurrency(row.amount)}
                            </span>
                          </p>
                        );
                      })}
                      <p className="flex justify-between gap-3 pt-2 font-semibold text-body text-gray-900 dark:text-white">
                        <span>Net contributions</span>
                        <span className={`tabular-nums ${valueTone(drillLine.netContributions, '')}`}>{formatCurrency(drillLine.netContributions)}</span>
                      </p>
                    </div>
                  )}

                  <Link
                    to={preserveDemoParam(`/accounts/${drillLine.cash[0]?.accountId ?? drillLine.accountId}`, location.search)}
                    className="inline-block mt-4 text-body text-gray-500 dark:text-gray-400 underline decoration-dotted underline-offset-2"
                  >
                    Open the register these sit in
                  </Link>
                </div>
              );
            })()}
          </ModalBody>
        </Modal>

        {/* What the contributions figure rests on. Says what could be WRONG
            with it, not how many rows there are — and renders nothing at all
            when every transfer is accounted for. */}
        {summary.unattributedTransfers.count > 0 && (
          <div className="rounded-lg p-4">
            <p className="text-body text-gray-500 dark:text-gray-400">
              {formatCurrency(summary.unattributedTransfers.amount)} of transfers in and out of
              these accounts have no matching row in another account, so they are counted as
              money from outside. Any that were moves within the portfolio make Net Contributions
              too big and Total Return too small.
            </p>
          </div>
        )}

        {/* Said once, dismissibly, when per-day rates first restate what a
            reader had already seen here (the ruling, 22 Aug §6.4) — this
            chart is one of the affected surfaces. */}
        <HistoricRatesRestatementNotice visible={scopeHistorical} />
        {/* Performance Chart */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
        {/* Wraps: seven pills at ~90px each need ~630px, and a phone offers
            ~340. `items-start` so the heading stays put when they do. */}
        <div className="flex flex-wrap justify-between items-start gap-3 mb-4">
          <h2 className="text-card font-semibold text-theme-heading dark:text-white">Portfolio Performance</h2>
          <div className="flex flex-wrap gap-2">
            {INVESTMENT_PERIODS.map((period) => (
              <button
                key={period}
                onClick={() => setSelectedPeriod(period)}
                className={`px-3 py-1 text-body rounded-lg transition-colors ${
                  selectedPeriod === period
                    ? 'bg-[#1a2332] text-white dark:bg-gray-600 dark:text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {INVESTMENT_PERIOD_LABELS[period]}
              </button>
            ))}
          </div>
        </div>

        {/* The two bounds, in the same shape the Dashboard and Reports use —
            `DatePicker` rather than a bare date input, so the field reads
            dd/mm/yyyy like every other date in the app instead of taking the
            browser's locale. */}
        {selectedPeriod === 'custom' && (
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="w-36">
              <DatePicker
                size="sm"
                value={customStart}
                onChange={setCustomStart}
                aria-label="Custom period start date"
                className="text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
              />
            </div>
            <span className="text-body text-gray-500 dark:text-gray-400">to</span>
            <div className="w-36">
              <DatePicker
                size="sm"
                value={customEnd}
                onChange={setCustomEnd}
                aria-label="Custom period end date"
                className="text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
              />
            </div>
          </div>
        )}
        {/* THE RETURN BAND — the window's performance, both measures, the
            user choosing which leads (owner, 20 Aug). The £ figures are the
            flow-adjusted identity every method agrees on: gain = end − start
            − net flows, so a withdrawal is never mistaken for a loss. */}
        {(() => {
          const chosen = performanceMeasure === 'mwr'
            ? { period: performance.mwrPeriod, annualised: performance.mwrAnnualised }
            : { period: performance.twrPeriod, annualised: performance.twrAnnualised };
          const nearOneYear = performance.days >= 330 && performance.days <= 400;
          return (
            <div className="mb-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-baseline gap-3">
                    <span className={`text-2xl font-bold tabular-nums ${
                      chosen.period === null || chosen.period.isZero()
                        ? 'text-gray-900 dark:text-white'
                        : chosen.period.greaterThan(0)
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-red-600 dark:text-red-400'
                    }`}>
                      {formatReturn(chosen.period)}
                    </span>
                    {chosen.annualised !== null && !nearOneYear && (
                      <span className="text-dense tabular-nums text-gray-500 dark:text-gray-400">
                        {formatReturn(chosen.annualised)} annualised
                      </span>
                    )}
                  </div>
                  <p className="text-dense text-gray-500 dark:text-gray-400 mt-0.5">
                    {chosen.period === null
                      ? 'Nothing was invested in this window, so there is no return to measure.'
                      : performanceMeasure === 'mwr'
                        ? 'Money-weighted — your own return, the timing of your payments included.'
                        : 'Time-weighted — how the investments performed, your payment timing stripped out.'}
                  </p>
                </div>
                <div className="flex items-center rounded-lg bg-gray-100 dark:bg-gray-700 p-0.5" role="group" aria-label="Return measure">
                  {([['mwr', 'MWR'], ['twr', 'TWR']] as const).map(([measure, name]) => (
                    <button
                      key={measure}
                      type="button"
                      onClick={() => choosePerformanceMeasure(measure)}
                      aria-pressed={performanceMeasure === measure}
                      title={measure === 'mwr'
                        ? 'Money-weighted return — your personal return'
                        : 'Time-weighted return — the investments’ performance'}
                      className={`px-2.5 py-0.5 text-xs font-medium rounded-md transition-colors ${
                        performanceMeasure === measure
                          ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm'
                          : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100'
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-3">
                {([
                  ['Started at', `${scopeApprox}${formatCurrency(performance.startValue)}`, valueTone(performance.startValue, '')],
                  ['Put in', `${scopeApprox}${formatCurrency(performance.moneyIn)}`, ''],
                  ['Taken out', `${scopeApprox}${formatCurrency(performance.moneyOut)}`, ''],
                  ['Gain', performance.gain.greaterThan(0)
                    ? `+${formatCurrency(performance.gain)}`
                    : formatCurrency(performance.gain),
                  performance.gain.isZero() ? ''
                    : performance.gain.greaterThan(0)
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-red-600 dark:text-red-400'],
                  ['Ended at', `${scopeApprox}${formatCurrency(performance.endValue)}`, valueTone(performance.endValue, '')],
                ] as const).map(([label, figure, colour]) => (
                  <div key={label}>
                    <p className="text-label uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</p>
                    <p className={`text-sm font-medium tabular-nums ${colour || 'text-gray-900 dark:text-white'}`}>{figure}</p>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={performanceData}
              style={{ cursor: 'pointer' }}
              onClick={(state) => {
                const point = performanceData.find(p => p.label === state?.activeLabel);
                if (point) setDrillDate(point.date);
              }}
            >
              {seriesWash(PERFORMANCE_CHART_KEY, ramp[0], isDark)}
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="label" stroke="#9CA3AF" />
              {/* £8m, not £2000k (owner, 21 Aug) — the house compact
                  formatter, so the notation and the symbol are decided once. */}
              <YAxis
                stroke="#9CA3AF"
                tickFormatter={(value: number) => formatCurrencyCompact(value, displayCurrency)}
              />
              <Tooltip
                formatter={(value) => formatCurrency(toDecimal(Number(value)))}
                contentStyle={chartTooltipStyle} itemStyle={chartTooltipItemStyle} separator=": "
              />
              {/* The shared ramp's first step, not a stock blue (Design,
                  24 Aug §4): this was the last chart in the app still
                  carrying the recharts documentation colour, on a page whose
                  Asset Allocation ring beside it uses the ramp correctly.
                  A single series takes ramp[0], the same rule DashboardCharts'
                  BarChart follows.

                  THE OWNER'S "load of dots" (29 Aug) WAS THIS SERIES: it asked
                  for a filled mark on every point, and a portfolio history runs
                  to hundreds of them, so the marks touched and the line
                  vanished under its own dots. `lineMarkers` is the house answer
                  — bare while you read it, one mark under the pointer — and
                  it keeps `singlePointDot`'s exception for a window holding a
                  single valuation. The wash is the same series colour at
                  WASH_TOP_OPACITY, so it follows the ramp onto a dark ground
                  rather than pinning a light-mode navy. See charts/richLine. */}
              <Area
                type="monotone"
                dataKey="value"
                stroke={ramp[0]}
                strokeWidth={2}
                fill={seriesWashFill(PERFORMANCE_CHART_KEY, ramp[0], isDark)}
                fillOpacity={1}
                {...lineMarkers(performanceData, ramp[0])}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        </div>

        {/* Holdings */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Holdings List */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
          <h2 className="text-card font-semibold mb-2 text-theme-heading dark:text-white">Holdings</h2>
          {/* The Accounts page's controls, on the app's other long list
              (owner, 16 August). Same pills, same navy, same persistence. */}
          {portfolioLines.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-0.5">
                {/* Both directions on both axes — a second press flips, as
                    everywhere (owner, 16 August). */}
                {([
                  ['default', 'Default', 'default'],
                  [holdingsSort === 'name' ? 'name-desc' : 'name', `Name ${holdingsSort === 'name-desc' ? 'Z–A' : 'A–Z'}`, 'name'],
                  [holdingsSort === 'value' ? 'value-asc' : 'value', `Value ${holdingsSort === 'value-asc' ? '↑' : '↓'}`, 'value'],
                ] as const).map(([next, label, axis]) => (
                  <button
                    key={axis}
                    type="button"
                    onClick={() => setHoldingsSort(next)}
                    aria-pressed={holdingsSort === axis || holdingsSort === `${axis}-desc` || holdingsSort === `${axis}-asc`}
                    className={`px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors ${
                      holdingsSort.startsWith(axis)
                        ? 'bg-[#1a2332] dark:bg-[#2d3a4d] text-white'
                        : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setGroupHoldingsByInstitution(!groupHoldingsByInstitution)}
                aria-pressed={groupHoldingsByInstitution}
                className={`px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors border ${
                  groupHoldingsByInstitution
                    ? 'bg-[#1a2332] dark:bg-[#2d3a4d] text-white border-transparent'
                    : 'text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:text-gray-900 dark:hover:text-gray-200'
                }`}
              >
                Group by institution
              </button>
            </div>
          )}
          {portfolioLines.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">
              No holdings to display
            </p>
          ) : (
            <div className="space-y-4">
              {/* ─ ONE ROW, RESTRUCTURED (owner, 16 August) ──────────────────
                  The institution line under each name is gone, by the rule
                  that removed it from the Accounts list: when the list is
                  grouped by institution the heading says it, and when it is
                  not, it was a second line of chrome on every row.

                  Each row now accounts for its own total: "Investments" is
                  the total less the paired cash, "Cash" is the paired cash,
                  and the two sum to the figure on the right — a check the
                  reader can do by eye, which is the owner's spec verbatim.

                  The secured liabilities move BELOW the bar under their own
                  small heading, because they are a different kind of fact:
                  the two lines above are parts of the total, and these are
                  not in it at all.

                  Colour is keyed by the line's place in the UNSORTED list, so
                  a dot keeps its colour when the sort changes — the dots and
                  the allocation slices are derived from the same order, and a
                  sort that recoloured every holding would break that thread. */}
              {(groupedHoldingLines ?? [['', sortedHoldingLines]] as const).map(([institution, lines]) => (
                <div key={institution || 'all'} className="space-y-4">
                  {institution !== '' && (
                    <div className="flex items-baseline justify-between border-b border-gray-200 dark:border-gray-700 pb-1">
                      <h3 className="text-dense uppercase tracking-wide font-semibold text-gray-500 dark:text-gray-400">
                        {institution}
                      </h3>
                      <span className={`text-dense tabular-nums ${valueTone(lines.reduce((t, l) => t.plus(l.value), toDecimal(0)), 'text-gray-500 dark:text-gray-400')}`}>
                        {formatCurrency(lines.reduce((t, l) => t.plus(l.value), toDecimal(0)))}
                      </span>
                    </div>
                  )}
                  {lines.map((line) => {
                    const account = accountsById.get(line.accountId);
                    if (!account) return null;
                    const colourIndex = portfolioLines.indexOf(line);
                    const cashTotal = line.cash.reduce((t, c) => t.plus(c.value), toDecimal(0));
                    const invested = line.value.minus(cashTotal);
                    const secured = securedAgainstLine(line);

                    return (
                      <div
                        key={account.id}
                        className="border-b dark:border-gray-700 pb-4 last:border-0 -mx-2 px-2 py-2 rounded"
                      >
                        <div className="flex justify-between items-start mb-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <div
                              className="w-3 h-3 rounded-full flex-shrink-0"
                              style={{ backgroundColor: categoricalColor(ramp, colourIndex) }}
                            />
                            <h3 className="font-medium text-gray-900 dark:text-white truncate">
                              {line.name}
                            </h3>
                          </div>
                          <p className={`font-semibold shrink-0 ml-3 ${valueTone(line.value, 'text-gray-900 dark:text-white')}`}>{formatCurrency(line.value)}</p>
                        </div>
                        {/* EACH SLEEVE IS A DOOR (owner, 17 August): the word
                            opens that sleeve's own register — Investments is
                            the parent account, Cash its nested account(s).
                            With several cash accounts one word cannot name a
                            register, so each gets its own linked row under its
                            own name, which says more than a summed "Cash"
                            ever did. */}
                        <p className="ml-5 mb-1 flex justify-between text-dense text-gray-500 dark:text-gray-400">
                          <Link
                            to={preserveDemoParam(`/accounts/${line.accountId}`, location.search)}
                            className="hover:underline rounded"
                            title={`${line.name} — open this account's register`}
                          >
                            Investments
                          </Link>
                          <span className={`tabular-nums ${valueTone(invested, '')}`}>{formatCurrency(invested)}</span>
                        </p>
                        {line.cash.length === 1 && (
                          <p className="ml-5 mb-2 flex justify-between text-dense text-gray-500 dark:text-gray-400">
                            <Link
                              to={preserveDemoParam(`/accounts/${line.cash[0].accountId}`, location.search)}
                              className="hover:underline rounded"
                              title={`${accountsById.get(line.cash[0].accountId)?.name ?? 'Cash'} — open this account's register`}
                            >
                              Cash
                            </Link>
                            <span className={`tabular-nums ${valueTone(cashTotal, '')}`}>{formatCurrency(cashTotal)}</span>
                          </p>
                        )}
                        {line.cash.length > 1 && line.cash.map(cashLine => (
                          <p key={cashLine.accountId} className="ml-5 mb-1 last:mb-2 flex justify-between text-dense text-gray-500 dark:text-gray-400">
                            <Link
                              to={preserveDemoParam(`/accounts/${cashLine.accountId}`, location.search)}
                              className="min-w-0 truncate hover:underline rounded"
                              title={`${accountsById.get(cashLine.accountId)?.name ?? 'Cash'} — open this account's register`}
                            >
                              {accountsById.get(cashLine.accountId)?.name ?? 'Cash'}
                            </Link>
                            <span className={`tabular-nums shrink-0 ml-3 ${valueTone(cashLine.value, '')}`}>{formatCurrency(cashLine.value)}</span>
                          </p>
                        ))}
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                            <div
                              className="h-2 rounded-full"
                              style={{
                                // Clamped for layout only: a line can be worth a
                                // negative amount, and a negative width renders
                                // nothing anywhere.
                                width: `${Math.min(100, Math.max(0, line.allocation.toNumber()))}%`,
                                backgroundColor: categoricalColor(ramp, colourIndex)
                              }}
                            />
                          </div>
                          <span className="text-body text-gray-600 dark:text-gray-400 w-12 text-right">
                            {formatPercentage(line.allocation)}
                          </span>
                        </div>
                        {secured.length > 0 && (
                          <div className="ml-5 mt-2">
                            {/* THE SIGNED BALANCE, exactly as the Accounts page
                                prints it (owner, 16 August). This shipped as a
                                magnitude — "the size of the debt is the datum
                                under a heading that already says liabilities" —
                                and the owner caught the cost within the hour:
                                the same loan read (£1,400,000.00) on one page
                                and £1,400,000.00 on this one. Two surfaces
                                disagreeing about one account's figure is the
                                exact failure the pairing rules exist to
                                prevent, and "liabilities stay negative" is the
                                app's own display law.

                                The brackets also do the "not in the total" job
                                BETTER than the magnitude did: a parenthesised
                                figure visibly does not sum with the unbracketed
                                Investments and Cash lines above it. (The
                                net-position arithmetic keeps its own abs — what
                                to SUBTRACT is a magnitude by definition.) */}
                            <p className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">
                              Secured liabilities
                            </p>
                            {secured.map(debt => (
                              <p
                                key={debt.id}
                                className="flex justify-between text-dense text-gray-500 dark:text-gray-400"
                              >
                                {/* To the REGISTER, not the Accounts-page jump
                                    the tags use (owner, 17 Aug: "take you to
                                    that respective account register"). */}
                                <Link
                                  to={preserveDemoParam(`/accounts/${debt.id}`, location.search)}
                                  className="min-w-0 truncate hover:underline rounded"
                                  title={`${debt.name} — open this account's register`}
                                >
                                  {debt.name}
                                </Link>
                                <span className={`tabular-nums shrink-0 ml-3 ${valueTone(debt.balance ?? 0, '')}`}>
                                  {formatCurrency(toDecimal(debt.balance ?? 0), debt.currency)}
                                </span>
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* THE RIGHT-HAND COLUMN, which is now a STACK of two.
            "Asset Allocation" answers where the money is kept; "Allocation by
            holding" beneath it answers what it is in. Both are short — five
            slices each since the cap — and the Holdings list beside them is
            long, so the column had a screen of empty space under one legend
            while the second ring sat below the fold in a full-width card of
            its own. */}
        <div className="space-y-6">
        {/* Allocation Chart */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
          <h2 className="text-card font-semibold mb-1 text-theme-heading dark:text-white">Asset Allocation</h2>
          {portfolioLines.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">
              No data to display
            </p>
          ) : (
            <>
              {/* SAYS THE DOOR IS THERE. The owner could not tell that the
                  ring or its legend led anywhere (29 August: "I cannot click
                  on any of the 5 legends to drill in"), and an affordance
                  nobody finds is not one — the spending donut's card names
                  its own click for the same reason. */}
              <p className="text-body text-gray-500 dark:text-gray-400 mb-4">
                Click an account to open its register.
              </p>
              {/* h-44, not h-64: this ring carried a twelve-row legend when it
                  was sized, and carries five now. The height it was keeping is
                  what "Allocation by holding" moved into. */}
              {/* ─ THE WRAPPER, NOT RAW RECHARTS CHILDREN (owner, 16 August:
                  "the pie chart is all one colour, not the same as the
                  legend", and the hover label was black in dark mode).

                  Recharts identifies Pie, Cell and Tooltip children BY
                  COMPONENT TYPE, and OptimizedCharts hands it lazy stand-ins
                  it does not recognise — so every Cell's fill and the
                  tooltip's themed style were silently ignored: default-grey
                  slices under a correctly coloured legend, and recharts' own
                  black-on-white tooltip. The Dashboard's donuts never had the
                  bug because they go through DashboardCharts' PieChart, where
                  the recharts elements are built inside one module and the
                  types match. Same wrapper here now, both rings. */}
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <DashboardPieChart
                    data={allocationData}
                    innerRadius={true}
                    colors={ramp}
                    onClick={openAllocationSlice}
                    formatter={(value: number) => formatCurrency(toDecimal(value))}
                    aria-label="Ring chart of asset allocation by account"
                  />
                </ResponsiveContainer>
              </div>
              <div className="mt-4 space-y-2">
                {/* Walks THE SLICES, not the accounts. The legend used to walk
                    `portfolioLines` while the ring walked `allocationData`, so
                    the two could differ in length and did — twelve rows beside
                    a five-colour ring. One source now, so a row and a wedge
                    cannot disagree about what exists.

                    EVERY ROW IS AN ELEMENT THAT TAKES A CLICK, not a div that
                    listens for one: an account row is a Link — the same door
                    the Holdings list opens, so a register is reached the same
                    way from both — and the fold is a <button> that opens
                    itself. Both are focusable and both answer the keyboard
                    without this page teaching it how. No focus styles are
                    declared: the app has one ring, `*:focus-visible`. */}
                {allocationData.map((slice, index) => {
                  // The share is of THE RING, so the rows add to 100% — the
                  // same rule the Dashboard's donut states. Taken from the
                  // slice rather than from `line.allocation`, which was a
                  // share of every account including the ones now folded into
                  // the remainder, and so would no longer sum. The folded rows
                  // below use the same denominator, so opening the fold cannot
                  // produce a second arithmetic.
                  const share = allocationTotal > 0
                    ? `${((slice.value / allocationTotal) * 100).toFixed(2)}%`
                    : '0.00%';
                  const swatch = (
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: categoricalColor(ramp, index) }}
                    />
                  );

                  if (slice.folded) {
                    return (
                      <div key={slice.name}>
                        <button
                          type="button"
                          onClick={() => setAllocationFoldOpen(open => !open)}
                          aria-expanded={allocationFoldOpen}
                          className={ALLOCATION_LEGEND_ROW}
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            {swatch}
                            {allocationFoldOpen
                              ? <ChevronDownIcon size={14} className="text-gray-400 dark:text-gray-500 shrink-0" />
                              : <ChevronRightIcon size={14} className="text-gray-400 dark:text-gray-500 shrink-0" />}
                            <span className="text-gray-700 dark:text-gray-300 truncate">{slice.name}</span>
                          </span>
                          <span className="text-gray-900 dark:text-white font-medium tabular-nums shrink-0">{share}</span>
                        </button>
                        {/* WHAT IS ACTUALLY IN IT. One step in, on the same
                            right-hand column as the rows above, so the shares
                            still read down the card as one list. */}
                        {allocationFoldOpen && (
                          <div className="mt-2 ml-5 pl-3 space-y-2 border-l border-line dark:border-gray-700">
                            {slice.folded.map(inner => (
                              <Link
                                key={inner.source.accountId}
                                to={registerPathFor(inner.source.accountId)}
                                title={`${inner.name} — open this account's register`}
                                className="flex items-center justify-between gap-3 text-dense rounded px-2 -mx-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                              >
                                <span className="text-gray-500 dark:text-gray-400 truncate">{inner.name}</span>
                                <span className="text-gray-500 dark:text-gray-400 tabular-nums shrink-0">
                                  {allocationTotal > 0
                                    ? `${((inner.value / allocationTotal) * 100).toFixed(2)}%`
                                    : '0.00%'}
                                </span>
                              </Link>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  }

                  // Only the fold is sourceless, and it returned above; the
                  // guard is what tells the type system so.
                  if (!slice.source) return null;

                  return (
                    <Link
                      key={slice.name}
                      to={registerPathFor(slice.source.accountId)}
                      title={`${slice.name} — open this account's register`}
                      className={ALLOCATION_LEGEND_ROW}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        {swatch}
                        {/* The ACCOUNT, which is what the slice is. This read
                            `line.institution || 'N/A'` — so a portfolio held at
                            one bank showed the same word against four different
                            slices, and every account with no institution on file
                            was labelled "N/A". The legend is the only thing
                            identifying a slice (the ramp is one hue walked, and
                            it cycles), so naming it wrongly leaves the chart
                            unreadable rather than merely untidy. */}
                        <span className="text-gray-700 dark:text-gray-300 truncate">{slice.name}</span>
                      </span>
                      <span className="text-gray-900 dark:text-white font-medium tabular-nums shrink-0">{share}</span>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* ─ WHAT IT IS IN ────────────────────────────────────────────────────
            A second ring, because the first one's card was mostly empty space
            below a twelve-row legend and because it answers a different
            question. Where the money is KEPT and what it is INVESTED IN are
            not the same fact, and only the second one is a decision. */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
          <h2 className="text-card font-semibold mb-1 text-theme-heading dark:text-white">
            Allocation by holding
          </h2>
          <p className="text-body text-gray-500 dark:text-gray-400 mb-4">
            Every account together — one line per security, with all settlement cash as one.
          </p>

          {holdingSlices.length === 0 ? (
            <p className="text-body text-gray-500 dark:text-gray-400">
              {holdingAllocation.unpricedCount > 0
                ? 'None of your holdings has a price yet, so there is nothing to size this by. Use “Update prices” on an account above.'
                : 'No priced holdings and no settlement cash, so there is nothing to divide up yet.'}
            </p>
          ) : holdingAllocation.securityCount === 0 ? (
            /* ONE CATEGORY IS A SENTENCE, NOT A RING (Claude Design, 22 Aug
               §4): a donut divides a whole into parts, and a closed one-colour
               ring reading "Cash · 100.00%" does no work these words don't do
               better. Checked against the ledger before styling anything, as
               the handover asked: the owner's portfolio has investment
               accounts and ZERO holdings rows, so "all cash" is the data's
               honest answer, not a misread. The sentence also owns what the
               ring never said: with no securities recorded, only the
               settlement sleeves can appear here — the rest of the
               portfolio's value lives on the ledger, undividable by security
               until holdings are added. */
            <div>
              {/* THE TWO SECTION TOTALS, reconciling to the portfolio (owner,
                  22 Aug: the cash-only sentence named a figure — the sleeves
                  alone — that the reader could not square with the Portfolio
                  Value above it. With no holdings recorded, the honest split
                  is investment accounts against settlement cash: two totals
                  and two shares that sum to the portfolio, said to be section
                  totals rather than an allocation by holding). Same maths as
                  the page: line.value is the pair, line.cash the nested part,
                  so the two rows always add to the summary's own total. */}
              <p className="text-body text-gray-500 dark:text-gray-400">
                No individual securities are recorded in these accounts, so
                these are the totals of the two sections rather than an
                allocation by holding:
              </p>
              <div className="mt-3 space-y-2">
                {cashOnlySplit.map(row => (
                  <div key={row.label} className="flex items-center justify-between gap-3 text-body">
                    <span className="text-gray-700 dark:text-gray-300">{row.label}</span>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className={`tabular-nums ${valueTone(row.value, 'text-gray-500 dark:text-gray-400')}`}>
                        {formatCurrency(row.value)}
                      </span>
                      <span className="text-gray-900 dark:text-white font-medium tabular-nums w-16 text-right">
                        {row.share}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-dense text-gray-500 dark:text-gray-400">
                Together they are the portfolio&rsquo;s{' '}
                {formatCurrency(summary.value)}. Holdings can be added from
                an account&rsquo;s panel to divide the investment side by security.
              </p>
            </div>
          ) : (
            <div>
              {/* Ring ABOVE the legend, matching "Asset Allocation" directly
                  above it — it was ring-beside-legend, so two cards in one
                  column drew the same shape of data two different ways. Three
                  class changes and no structural edit: the wrapper stops being
                  a row, the ring stops being a fixed-width column, the legend
                  stops being the flex remainder.

                  The comment lives INSIDE the div because the `) : (` slot of
                  a ternary takes exactly one expression, and a JSX comment is
                  one. Third time this has bitten in this session. */}
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  {/* Same wrapper as the ring above, same reason. */}
                  <DashboardPieChart
                    data={holdingSlices}
                    innerRadius={true}
                    colors={ramp}
                    formatter={(value: number) => formatCurrency(toDecimal(value))}
                    aria-label="Ring chart of allocation by holding"
                  />
                </ResponsiveContainer>
              </div>

              {/* RESERVES FIVE ROWS' HEIGHT even holding one (owner, 16
                  August: "that allocation by holding should be the same size
                  card with just the space for the remaining 4 legend spots").
                  The card above caps its legend at five entries, so five rows
                  — 8.5rem at this row height — is the tallest either legend
                  gets, and pinning this one to it keeps the two cards level
                  however many securities are priced. */}
              <div className="mt-4 space-y-2 min-h-[8.5rem]">
                {holdingSlices.map((slice, index) => (
                  <div key={slice.name} className="flex items-center justify-between gap-3 text-body">
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{ backgroundColor: categoricalColor(ramp, index) }}
                      />
                      <span className="text-gray-700 dark:text-gray-300 truncate">{slice.name}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-gray-500 dark:text-gray-400 tabular-nums">
                        {formatCurrency(toDecimal(slice.value))}
                      </span>
                      <span className="text-gray-900 dark:text-white font-medium tabular-nums w-16 text-right">
                        {holdingSlicesTotal > 0
                          ? `${((slice.value / holdingSlicesTotal) * 100).toFixed(2)}%`
                          : '0.00%'}
                      </span>
                    </div>
                  </div>
                ))}

                {/* SAID, not swallowed. A position with no price cannot be
                    sized, so it is not in the ring — and a chart that quietly
                    leaves out part of what you own is the same offence as a
                    filtered list claiming your money is gone. */}
                {holdingAllocation.unpricedCount > 0 && (
                  <p className="pt-2 text-body text-gray-500 dark:text-gray-400">
                    {holdingAllocation.unpricedCount === 1
                      ? '1 holding has no price yet, so it is not counted above.'
                      : `${holdingAllocation.unpricedCount} holdings have no price yet, so they are not counted above.`}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
        </div>
        </div>

        {/* NEUTRAL BODY TEXT, not blue (Claude Design, 22 Aug §5): heading,
            icon and all four bullets rendered in the link colour and none of
            them was a link — the same offence as the 29 blue "All reconciled"
            pills. Blue means link on this page; a reader will try to click a
            paragraph wearing it, and the one clickable-looking phrase in here
            ("Account Settings") genuinely isn't a destination — the pairing
            lives in EACH account's own settings dialog, so the path stays
            words. The content stays exactly as it was: it is the ethos in its
            most literal form. */}
        <div className="bg-white dark:bg-gray-800 border border-line dark:border-gray-700 rounded-lg p-6">
          <div className="flex items-start gap-3">
            <AlertCircleIcon className="text-gray-400 dark:text-gray-500 mt-1" size={20} />
            <div>
              <h3 className="font-semibold text-gray-900 dark:text-white mb-2">How these figures are worked out</h3>
              <ul className="text-body text-gray-600 dark:text-gray-400 space-y-1">
                <li>• A line is worth the investment account plus any cash account paired with it — set the pairing in Account Settings → Part of investment account</li>
                <li>• Money transferred in from elsewhere counts as a contribution; moving money between an investment account and its own cash does not</li>
                <li>• Total Return is what the portfolio is worth today less what was put into it</li>
                <li>• The chart is the balance history of these accounts, not a projection</li>
              </ul>
            </div>
          </div>
        </div>
        </div>
      )}

      {/* Watchlist Tab */}
      {activeTab === 'watchlist' && (
        <StockWatchlist />
      )}

      {/* Portfolio Tab — the MARKET view.

          Deliberately NOT the same number as the Overview's Portfolio Value.
          That tile is the ledger (opening balance plus transactions across the
          investment↔cash pair); this is quantity × last fetched price. Both are
          true, they answer different questions, and adding them would count the
          shares and the cash that bought them twice. */}
      {activeTab === 'portfolio' && (
        <div className="space-y-6">
          {holdingsError && (
            <div role="alert" className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl p-4">
              <p className="text-body text-red-700 dark:text-red-300">{holdingsError}</p>
            </div>
          )}

          {portfolioRootAccounts.map((account) => {
            const accountHoldings = holdingsByAccount.get(account.id) ?? [];
            return (
              <div key={account.id} className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
                <div className="flex flex-wrap justify-between items-center gap-2 mb-4">
                  <h3 className="text-card font-semibold text-gray-900 dark:text-white">{account.name}</h3>
                  <button
                    type="button"
                    onClick={() => setManagingAccountId(managingAccountId === account.id ? null : account.id)}
                    aria-expanded={managingAccountId === account.id}
                    className="text-body text-primary hover:text-secondary transition-colors"
                  >
                    {/* A disclosure, named as one. "Manage holdings" promised a
                        destination and delivered an inline list, and its
                        closing word "Done" is the vocabulary of an action, not
                        of a fold — which is exactly why the pair read oddly.
                        (Design, 27 Aug §3.) */}
                    {managingAccountId === account.id ? 'Hide holdings' : 'Show holdings'}
                  </button>
                </div>
                <InvestmentMarketView
                  holdings={accountHoldings}
                  holdingsPanelOpen={managingAccountId === account.id}
                  onOpenRegister={CHROME_HAS_PRICE_HISTORY ? setRegisterHolding : undefined}
                  onAddHolding={() => openAddHoldingFor(account.id)}
                  fallbackCurrency={account.currency}
                  onUpdateQuotes={() =>
                    void updateQuotes(
                      account.id,
                      accountHoldings.map((holding) => holding.symbol)
                    )
                  }
                  isUpdating={isUpdatingQuotes && quotedAccountId === account.id}
                  updateError={quotedAccountId === account.id ? quoteError : null}
                  symbolErrors={quotedAccountId === account.id ? symbolErrors : undefined}
                />
                {managingAccountId === account.id && (
                  <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                    <PortfolioManager
                      holdings={accountHoldings}
                      currency={account.currency}
                      // The page's "Add a holding" door, arriving at the form
                      // that actually creates one. Only for the account it was
                      // opened for — every other manager on the page ignores it.
                      openAddSignal={
                        addSignal?.accountId === account.id ? addSignal.nonce : undefined
                      }
                      onAddSignalHandled={clearAddSignal}
                      // Where the purchase money may come from: THIS portfolio's
                      // OWN nested cash, and nothing else (owner's ruling, 27
                      // Aug — money reaches a portfolio through its sleeve, by
                      // ordinary transfer, first). Money itself allowed any
                      // funding account (measured: 2015 of 2029 buys did), and
                      // the first draft copied that — which put EVERY
                      // same-currency account in one flat list, while its
                      // `type !== 'investment'` guard hid the one account that
                      // belonged there, because his sleeves are typed
                      // 'investment'. The two mistakes compounded into "all my
                      // accounts except the right one".
                      //
                      // Same-currency still holds: the counterpart write copies
                      // the row's digits, and a converted transfer needs its
                      // confirmed figure.
                      fundingAccounts={openAccounts
                        .filter(a =>
                          a.parentAccountId === account.id &&
                          a.currency === account.currency)
                        .sort((a, b) => compareText(a.name, b.name))}
                      onAdd={(values, purchase) => handleAddHolding(account.id, values, purchase)}
                      onEdit={handleEditHolding}
                      onDelete={handleDeleteHolding}
                      traceRowsFor={traceRowsForHolding}
                    />
                  </div>
                )}
                {/* Imported trading history, when this portfolio has any —
                    renders nothing otherwise, so the everyday card is
                    untouched. (An open portfolio gets history when the owner
                    ticks an open position through the import's confirm.) */}
                {CHROME_HAS_PRICE_HISTORY && (
                  <PortfolioTradingHistory accountId={account.id} hasHoldings />
                )}
              </div>
            );
          })}

          {/* THE ARCHIVE FOLDS (owner, 28 Aug): closed portfolios are looked
              back at, not lived in, and a hundred tall cards of history were
              burying the page. One band, the Accounts page's own closed-band
              shape, collapsed by default — open it and the cards are exactly
              where they were. */}
          {closedPortfolioRootAccounts.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 overflow-hidden">
              <button
                type="button"
                onClick={() => setShowClosedPortfolios(!showClosedPortfolios)}
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-gray-600 dark:text-gray-300">
                  {showClosedPortfolios ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
                  Closed portfolios ({closedPortfolioRootAccounts.length})
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  History preserved — look back any time
                </span>
              </button>
              {showClosedPortfolios && (
                <div className="border-t border-line dark:border-gray-700 p-4 space-y-4">
          {closedPortfolioRootAccounts.map((account) => {
            const accountHoldings = holdingsByAccount.get(account.id) ?? [];
            return (
              <div key={account.id} className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
                <div className="flex flex-wrap justify-between items-center gap-2 mb-4">
                  <h3 className="text-card font-semibold text-gray-900 dark:text-white">
                    {account.name}
                    {/* Sentence-case pill, quiet: a closed portfolio is history,
                        not a warning. */}
                    <span className="ml-2 align-middle text-xs font-normal px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                      Closed
                    </span>
                  </h3>
                </div>
                {accountHoldings.length > 0 && (
                  <InvestmentMarketView
                    holdings={accountHoldings}
                    onOpenRegister={CHROME_HAS_PRICE_HISTORY ? setRegisterHolding : undefined}
                    fallbackCurrency={account.currency}
                    onUpdateQuotes={() =>
                      void updateQuotes(
                        account.id,
                        accountHoldings.map((holding) => holding.symbol)
                      )
                    }
                    isUpdating={isUpdatingQuotes && quotedAccountId === account.id}
                    updateError={quotedAccountId === account.id ? quoteError : null}
                    symbolErrors={quotedAccountId === account.id ? symbolErrors : undefined}
                  />
                )}
                {/* The traded-securities list — and, with it, the empty
                    sentence, because only it knows whether imported history
                    exists. The device edition has no history lane, so it
                    keeps the plain sentence instead of an always-empty door. */}
                {CHROME_HAS_PRICE_HISTORY ? (
                  <PortfolioTradingHistory
                    accountId={account.id}
                    hasHoldings={accountHoldings.length > 0}
                  />
                ) : (
                  accountHoldings.length === 0 && (
                    <p className="text-body text-gray-500 dark:text-gray-400">
                      No holdings were recorded for this portfolio. Its transactions are still in its
                      register, reachable from Closed Accounts on the Accounts page.
                    </p>
                  )
                )}
              </div>
            );
          })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {registerHolding && (() => {
        /* The LIVE row, so a buy-more in this very modal updates the sell
           form's ceiling; the captured object would go stale on reload. */
        const live = holdings.find(h => h.id === registerHolding.id) ?? registerHolding;
        const portfolioAccount = live.accountId === null
          ? undefined
          : historicalAccounts.find(a => a.id === live.accountId);
        return (
          <HoldingRegisterModal
            holding={live}
            onClose={() => setRegisterHolding(null)}
            onPricesChanged={() => void reloadHoldings()}
            accountCurrency={portfolioAccount?.currency}
            // The portfolio's OWN nested cash — the Paid-from ruling, again.
            fundingAccounts={openAccounts
              .filter(a =>
                a.parentAccountId === live.accountId &&
                a.currency === (portfolioAccount?.currency ?? live.currency))
              .sort((a, b) => compareText(a.name, b.name))
              .map(a => ({ id: a.id, name: a.name }))}
            onBuyMore={(trade: LiveBuyDetails) => handleBuyMore(live, trade)}
            onSell={(trade: LiveSellDetails) => handleSell(live, trade)}
          />
        );
      })()}

    </PageWrapper>
  );
}
