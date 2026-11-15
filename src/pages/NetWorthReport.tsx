import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { useApp } from '../contexts/AppContextSupabase';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import { Modal, ModalBody } from '../components/common/Modal';
import NetWorthSummary from '../components/NetWorthSummary';
import { singlePointDot } from '../components/charts/singlePointDots';
import { lineMarkers, seriesWash, seriesWashFill } from '../components/charts/richLine';
import { toDecimal } from '../utils/decimal';
import { formatDecimal } from '../utils/decimal-format';
import { preserveDemoParam } from '../utils/navigation';
import { buildNetWorthSnapshots, netWorthAxisTicks, netWorthPointToken, netWorthValueAxis } from '../utils/netWorthSeries';
import { buildReportDrillPath } from '../utils/reportDrillLink';
import { withProvenance } from '../utils/navigationProvenance';
import ConvertedTotalNote from '../components/ConvertedTotalNote';
import HistoricRatesRestatementNotice from '../components/HistoricRatesRestatementNotice';
import { useNetWorthConversion } from '../hooks/useNetWorthConversion';
import { useInvestmentValuation } from '../hooks/useInvestmentValuation';
import InvestmentBasisNote from '../components/InvestmentBasisNote';
import { useArrivalAction } from '../hooks/useArrivalFocus';
import { resolveEffectiveOpeningDates } from '../utils/openingDates';
import { TrendingUpIcon, ChevronRightIcon } from '../components/icons';
import { decompositionSeries, useDecompositionSeries, useIsDarkGround, useChartTooltipStyle, useChartTooltipItemStyle } from '../components/charts/chartColors';
import type { DecompositionSeries } from '../components/charts/chartColors';
import PeriodBar from '../components/PeriodBar';
import ReportPeriodDefaultToggle from '../components/reports/ReportPeriodDefaultToggle';
import { useReportPeriodDefault } from '../hooks/useReportPeriodDefault';
import { sectionTypeForAccount, ACCOUNT_SECTION_DEFINITIONS, OTHER_SECTION_DEFINITION } from '../utils/accountGrouping';
import { DEPTH_LEVEL_1 } from '../styles/depthShading';
import type { ReportViewProps } from './reports/types';
import { preferences } from '../services/preferencesService';
import { useHistoricalAccounts } from '../hooks/useHistoricalAccounts';
import { formatTime, getDateLocale } from '../utils/dateFormatter';
import { compareNames } from '../utils/localeFormat';

/**
 * Net worth over time — the Microsoft Money report, rebuilt on real data.
 *
 * Every point is computed from first principles: per-account running balance
 * (opening balance + cumulative transactions, Decimal throughout) snapshotted
 * at each point in the selected period. Nothing is stored or estimated — the
 * full transaction history IS the time series.
 *
 * Drill-in: click a point to see every account's balance on that date;
 * click an account to open its register.
 */


/**
 * The legend, drawing each series as the LINE IT ACTUALLY IS.
 *
 * The design ruling that separated these three by shape rather than colour came
 * with one condition attached: "the legend must show the actual dash pattern,
 * not a coloured square. A legend that renders three identical navy squares is
 * worse than the bug we started with."
 *
 * Recharts' default legend does not meet that. Measured before writing this:
 * its swatch is a `<path>` carrying `stroke` and no `stroke-dasharray` at all,
 * so Assets and Liabilities — deliberately the same hue — came out as two
 * identical navy lines. The whole point of the ruling is that shape carries
 * identity, and the default legend is the one place shape was being dropped.
 *
 * So the swatch is drawn here from the same `useDecompositionSeries` entry the
 * chart draws from, which is also what stops the two drifting: there is no
 * second copy of the pattern to forget to update.
 */
function DecompositionLegend({ payload }: { payload?: readonly { value?: string }[] }): React.JSX.Element {
  // The ground-aware series — the same hook the chart reads, so the legend
  // can never show a light-ground navy beside a dark-ground line.
  const decomposition = useDecompositionSeries();
  const style = (name: string | undefined): DecompositionSeries[keyof DecompositionSeries] =>
    name === 'Assets' ? decomposition.part
      : name === 'Liabilities' ? decomposition.counterpart
        : decomposition.total;

  return (
    <ul className="flex flex-wrap items-center justify-center gap-4 pt-1">
      {(payload ?? []).map(entry => {
        const series = style(entry.value);
        return (
          <li key={entry.value} className="flex items-center gap-1.5 text-label text-gray-600 dark:text-gray-300">
            {/* 24px of the real line: same colour, same weight, same dash. */}
            <svg width="24" height="10" aria-hidden="true" className="flex-shrink-0">
              <line
                x1="0" y1="5" x2="24" y2="5"
                stroke={series.color}
                strokeWidth={series.width}
                strokeDasharray={series.dash}
              />
            </svg>
            {entry.value}
          </li>
        );
      })}
    </ul>
  );
}

/** Names this report's wash in the document — stated once, used twice. */
const NET_WORTH_CHART_KEY = 'net-worth-report';

const compactTick = (value: number): string => {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${formatDecimal(abs / 1_000_000, 1)}M`;
  if (abs >= 1_000) return `${sign}${formatDecimal(abs / 1_000, 0)}K`;
  return formatDecimal(value, 0);
};

export default function NetWorthReport({ picker, focus }: ReportViewProps): React.JSX.Element {
  const { accounts: openAccounts, transactions } = useApp();
  // The id is this report's registry key; the hub applies whatever is saved
  // under it when the report opens.
  const periodDefault = useReportPeriodDefault('net-worth-over-time', picker);
  /**
   * OPEN AND CLOSED, because this page walks history.
   *
   * The app context holds open accounts only (`getAccounts` filters on
   * `is_active`), so every point on this chart used to omit whatever the
   * owner's 110 closed accounts held at the time — understating the past, and
   * understating it more the further back you look. See useHistoricalAccounts.
   *
   * Everything on this page reads from it: the series, the effective opening
   * dates, the per-date drill and the caveat note. They must agree, and the
   * headline above the chart is the LAST POINT of the series rather than a
   * separately-computed figure, so it moves with them.
   */
  const accounts = useHistoricalAccounts(openAccounts);
  const { formatCurrency, displayCurrency } = useCurrencyDecimal();
  // Watches the dark class rather than reading it once — the theme scheduler
  // can flip the ground under a mounted chart. The series does the same, and
  // for the same measured reason: the light navies are 1.08:1 on a dark card.
  const chartTooltipStyle = useChartTooltipStyle();
  const chartTooltipItemStyle = useChartTooltipItemStyle();
  // ONE reading of the ground per render: the series colours come from it and
  // so does the wash's strength, so the two cannot disagree about the theme.
  const isDark = useIsDarkGround();
  const decomposition = decompositionSeries(isDark);
  const navigate = useNavigate();
  const location = useLocation();
  const [drillDate, setDrillDate] = useState<Date | null>(null);
  // Line or bar presentation — same data, same drill-in; persisted.
  const [chartType, setChartType] = useState<'line' | 'bar'>(() =>
    preferences.getItem('netWorthChartType') === 'bar' ? 'bar' : 'line'
  );
  const handleChartType = (type: 'line' | 'bar'): void => {
    setChartType(type);
    preferences.setItem('netWorthChartType', type);
  };
  // Assets/liabilities context series are OFF by default — the chart is the
  // net worth line; the detail is an opt-in (persisted).
  const [showDetail, setShowDetail] = useState<boolean>(() =>
    preferences.getItem('netWorthShowDetail') === '1'
  );
  const toggleDetail = (): void => {
    setShowDetail(prev => {
      preferences.setItem('netWorthShowDetail', prev ? '0' : '1');
      return !prev;
    });
  };

  // Transactions sorted once; the series walk and the drill both consume it.
  const sortedTransactions = useMemo(
    () => [...transactions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()),
    [transactions]
  );

  /**
   * The currency conversion for this series — the ONE hook the dashboard's
   * net-worth card also calls, so the two surfaces cannot disagree about the
   * same money (ruling C). See useNetWorthConversion for the whole account.
   */
  const {
    conversion,
    seriesConversion,
    conversionAt,
    historical,
    provenance: ratesProvenance,
  } = useNetWorthConversion(accounts, { range: picker.range });

  /**
   * The valuation term (slice 3b): the series values each account's open
   * positions at the last price on or before each point, on top of the
   * ledger. Empty — zero everywhere — until the reads land, and always on
   * the device edition, so the chart never waits on it.
   */
  const valuation = useInvestmentValuation();

  const snapshots = useMemo(
    () =>
      buildNetWorthSnapshots(
        accounts,
        sortedTransactions,
        picker.range,
        new Date(),
        seriesConversion ?? undefined,
        valuation.deltaAt
      ),
    [accounts, sortedTransactions, picker.range, seriesConversion, valuation]
  );

  /**
   * A point clicked on the Dashboard's net-worth card, landed on here.
   *
   * This report answers "that point" with the day's balances and nothing else —
   * there is no row to highlight — so arriving on a point does exactly what
   * clicking the same point on the chart below does, and closing the dialog
   * leaves the reader on the report over the window they came from.
   *
   * It retries until the snapshot exists: the report renders once before the
   * arriving period has been applied, and the series it is asked about is not
   * built yet at that moment. A token no snapshot matches (a date outside the
   * window) simply never fires.
   */
  const openArrivalPoint = useCallback((token: string): boolean => {
    const snapshot = snapshots.find(s => netWorthPointToken(s.date) === token);
    if (!snapshot) return false;
    setDrillDate(snapshot.date);
    return true;
  }, [snapshots]);
  useArrivalAction(focus, openArrivalPoint);

  // One resolver drives both the drill and the warning note, so the "balances
  // on a date" figures and the caveat about them can never disagree.
  const openingDates = useMemo(
    () => resolveEffectiveOpeningDates(accounts, sortedTransactions),
    [accounts, sortedTransactions]
  );

  // Per-account balances at the drilled date (same cumulative rule as the
  // series walk: an opening balance counts only once its effective date has
  // arrived; a dateless lump behaves as today).
  const drillBalances = useMemo(() => {
    if (!drillDate) return [];
    const cutoff = new Date(drillDate);
    cutoff.setHours(23, 59, 59, 999);
    const cutoffTime = cutoff.getTime();
    const balances = new Map(accounts.map(a => {
      const opening = toDecimal(a.openingBalance ?? 0);
      const eff = openingDates.get(a.id);
      if (eff === undefined) return [a.id, opening] as const;
      return [a.id, eff.getTime() <= cutoffTime ? opening : toDecimal(0)] as const;
    }));
    for (const t of sortedTransactions) {
      if (new Date(t.date) > cutoff) break;
      const bal = balances.get(t.accountId);
      if (bal !== undefined) balances.set(t.accountId, bal.plus(toDecimal(t.amount)));
    }
    // A zero balance with no activity yet (opening date not reached) drops out,
    // exactly as an empty account always has.
    return accounts
      .map(a => ({ account: a, balance: balances.get(a.id) ?? toDecimal(0) }))
      .filter(e => !e.balance.isZero())
      .sort((a, b) => b.balance.comparedTo(a.balance));
  }, [drillDate, accounts, sortedTransactions, openingDates]);

  // Opening balances whose date the chart cannot trust: undated lumps count
  // from the beginning of time (net worth before their real opening date is
  // overstated), and inferred dates are a guess from first activity. Only
  // NONZERO opening balances matter — a zero opening contributes nothing to
  // overstate. Both lists are empty in the common case, so the note renders
  // nothing at all.
  const openingDateWarnings = useMemo(() => {
    const undated: string[] = [];
    const inferred: string[] = [];
    for (const a of accounts) {
      if (toDecimal(a.openingBalance ?? 0).isZero()) continue;
      const eff = openingDates.get(a.id);
      if (eff === undefined) undated.push(a.name);
      else if (!a.openingBalanceDate) inferred.push(a.name);
    }
    return { undated, inferred };
  }, [accounts, openingDates]);

  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const earliest = snapshots.length > 0 ? snapshots[0] : null;
  const change = latest && earliest
    ? toDecimal(latest.netWorth).minus(toDecimal(earliest.netWorth))
    : toDecimal(0);

  /**
   * The growth band (owner, 22 Aug: "my investments may be growing by say 5%
   * average but are my overall net assets growing in line with that, or more
   * or less") — the Investments page's Started/Ended/Change strip, for the
   * whole balance sheet, with an annualised rate to stand beside the
   * portfolio's.
   *
   * ONE HONESTY LINE IS NOT OPTIONAL: net worth growth counts money you SAVED
   * as growth, where the portfolio's TWR/MWR strip payments out. The two
   * rates answer different questions and the band says so, or the comparison
   * the owner wants to make would be a comparison of unlike things without
   * either of them admitting it.
   *
   * Unmeasurable is null with a reason, never 0% (the portfolio maths'
   * standing rule): a start at or below zero has no base to grow from, and a
   * single-point window has no growth to measure. Decimal throughout,
   * fractional power via toPower — the same arithmetic portfolioPerformance
   * annualises with.
   */
  const growth = useMemo(() => {
    if (!latest || !earliest || snapshots.length < 2) {
      return { periodPct: null as null, annualisedPct: null as null, reason: 'This window holds a single point, so there is no growth to measure' };
    }
    const start = toDecimal(earliest.netWorth);
    const end = toDecimal(latest.netWorth);
    if (start.lessThanOrEqualTo(0)) {
      return { periodPct: null, annualisedPct: null, reason: 'Net worth started at or below zero in this window, so a growth rate has no base to measure from' };
    }
    const days = Math.max(1, Math.round((latest.date.getTime() - earliest.date.getTime()) / 86_400_000));
    const ratio = end.dividedBy(start);
    const periodPct = ratio.minus(1).times(100);
    // end ≤ 0 from a positive start: the ratio has no real fractional power,
    // so the annualised figure is honestly absent while the period one stands.
    const annualisedPct = end.greaterThan(0)
      ? ratio.toPower(toDecimal(365.25).dividedBy(days)).minus(1).times(100)
      : null;
    return { periodPct, annualisedPct, reason: null };
  }, [latest, earliest, snapshots.length]);

  const formatGrowth = (value: ReturnType<typeof toDecimal>): string =>
    `${value.greaterThan(0) ? '+' : ''}${formatDecimal(value, 2)}%`;

  /**
   * The drill's three views and two sorts (owner, 22 Aug): the DEFAULT answer
   * to "what was net worth made of that day" is the section totals — Current
   * Accounts, Credit Cards, Investments, Assets, Liabilities — with the
   * accounts themselves one step further in ("By account") or flat ("All").
   * Sorts follow the Accounts page's idiom: press the active pill again to
   * flip its direction. Groups always sit in the section ladder's own order;
   * the sort orders accounts within them.
   */
  const [drillView, setDrillView] = useState<'groups' | 'grouped' | 'all'>('groups');
  const [drillSort, setDrillSort] = useState<'value-desc' | 'value-asc' | 'name' | 'name-desc'>('value-desc');

  /**
   * The factors in force for the drilled DAY: that day's own reference rates
   * when the history is loaded (the owner's backdated-rates ask, 22 Aug),
   * today's rates while degraded — never a mixture.
   */
  const drillConversion = useMemo(
    () => (drillDate && conversionAt ? conversionAt(drillDate) : conversion),
    [drillDate, conversionAt, conversion]
  );

  const drillGroups = useMemo(() => {
    const sorted = [...drillBalances].sort((a, b) => {
      switch (drillSort) {
        case 'name': return compareNames(a.account.name, b.account.name);
        case 'name-desc': return compareNames(b.account.name, a.account.name);
        case 'value-asc': return a.balance.comparedTo(b.balance);
        default: return b.balance.comparedTo(a.balance);
      }
    });
    const bySection = new Map<string, typeof sorted>();
    for (const entry of sorted) {
      const key = sectionTypeForAccount(entry.account.type);
      const bucket = bySection.get(key);
      if (bucket) bucket.push(entry);
      else bySection.set(key, [entry]);
    }
    return [...ACCOUNT_SECTION_DEFINITIONS, OTHER_SECTION_DEFINITION]
      .filter(section => bySection.has(section.type))
      .map(section => {
        const entries = bySection.get(section.type) ?? [];
        return {
          section,
          entries,
          // CONVERTED into the display currency where a factor exists (Claude
          // Design, 22 Aug §1): the rows print their own currency, but a band
          // total mixing dollars into a pounds figure unit-for-unit was a
          // number nobody quoted. Wears ≈ and the sheet's provenance line
          // when any conversion (or unconverted residue) is in it.
          subtotal: entries.reduce((sum, e) => {
            const factor = drillConversion?.factors.get(e.account.id);
            return sum.plus(factor ? e.balance.times(factor) : e.balance);
          }, toDecimal(0)),
          holdsForeign: entries.some(e => (e.account.currency || displayCurrency) !== displayCurrency),
        };
      });
  }, [drillBalances, drillSort, drillConversion, displayCurrency]);

  const drillAll = useMemo(
    () => drillGroups.flatMap(group => group.entries),
    [drillGroups]
  );

  /** Any foreign money in the drilled day at all — gates the ≈ and its line. */
  const drillHoldsForeign = useMemo(
    () => drillBalances.some(e => (e.account.currency || displayCurrency) !== displayCurrency),
    [drillBalances, displayCurrency]
  );

  /**
   * Open an account's register FROM the drill, with the way back stated
   * (owner, 22 Aug): the register's back button — and the closed-account
   * page's — reads this provenance and returns HERE, to this report with the
   * drill reopened on the same date, via the same focus token the Dashboard's
   * card already lands on. Without it, "Back to Accounts" dumped the reader
   * on the Accounts page mid-analysis.
   */
  const openRegisterFromDrill = useCallback((accountId: string): void => {
    const state = drillDate
      ? withProvenance({
          path: buildReportDrillPath('net-worth-over-time', {
            focus: netWorthPointToken(drillDate),
            currentSearch: location.search,
          }),
          label: 'Back to report',
        })
      : undefined;
    navigate(preserveDemoParam(`/accounts/${accountId}`, location.search), { state });
  }, [drillDate, navigate, location.search]);

  return (
    <div className="max-w-[var(--report-max,1400px)] mx-auto">
      {/* The period comes from the hub, so it persists between reports. */}
      {/*
        THE SAME THREE FIGURES AS THE DASHBOARD AND THE ACCOUNTS LIST, SO THE
        SAME CARD (PHONE_CAPTURES_REVIEW_2026-08-13 §4).

        What used to be here was the navy slab plus two white cards that
        NetWorthSummary was written to abolish — and opting out of the shared
        card is not free. The dark-mode fault that card's comment documents was
        found and fixed ONCE and reached all three surfaces that use it; this
        page, which had copied the markup instead, was still carrying its own
        version of the same class of bug: `text-red-600` with NO `dark:`
        variant, so Liabilities rendered #dc2626 on the #1f2937 dark card. That
        is the whole argument for sharing, and it is why the copy is gone.

        The three magnitudes are navy in the shared card because none of them is
        a direction of travel (RULINGS_ON_CAUSE_2026-08-13 §1). The CHANGE below
        them is the exception that proves it: a delta is nothing BUT a direction
        of travel, so it is the one figure on this page that keeps the semantic
        colours — which is also what stops green and red here from being
        decoration.
      */}
      {/* Said once, dismissibly, when per-day rates first restate what a
          reader had already seen (the ruling, 22 Aug §6.4). */}
      <HistoricRatesRestatementNotice visible={historical && conversion !== null} />
      <div className="mb-6 space-y-2">
        {/* ≈ when a conversion is in force (Design, 24 Aug §1): this page's
            own basis line says the figures converted, and the dashboard's
            card for the same series already wears the mark — a converted
            figure marked on one surface and plain on the other reads as two
            different kinds of number. */}
        <NetWorthSummary
          netWorth={latest ? `${conversion ? '≈ ' : ''}${formatCurrency(latest.netWorth)}` : '—'}
          assets={latest ? `${conversion ? '≈ ' : ''}${formatCurrency(latest.assets)}` : '—'}
          liabilities={latest ? `${conversion ? '≈ ' : ''}${formatCurrency(latest.liabilities)}` : '—'}
        />
        {/* The date alone. The change figure lived here too, and again as the
            band's CHANGE tile two hundred pixels down — the same money said
            twice (Claude Design 22 Aug §5). The band keeps it: it stands with
            Started/Ended and the period %, which is where a change figure can
            actually be read against something. */}
        {latest && (
          <p className="text-body text-gray-600 dark:text-gray-400">
            As at <span className="font-medium text-gray-900 dark:text-gray-100">{latest.label}</span>.
          </p>
        )}
        {/* THE PAGE'S ONE RATE-BASIS LINE (the ruling, 22 Aug §6.2): with the
            ECB history in force, one sentence carries every qualification —
            the daily basis, the weekend carry-forward, and (only when the
            window actually reaches back that far) the pre-1999 substitution.
            Degraded, the SAME ConvertedTotalNote as every other summary card:
            today's-rates basis, honestly stated. Rendered nothing for the
            single-currency majority, per the data-health rule. */}
        {historical && conversion && (
          <p className="text-dense text-gray-500 dark:text-gray-400" data-testid="historic-rates-basis">
            ≈ Converted at each day&rsquo;s ECB reference rate. Weekends and holidays
            carry the previous business day&rsquo;s rate.
            {earliest && earliest.date < new Date(1999, 0, 4)
              ? <> Balances before 4 Jan 1999 use the earliest rate available.</>
              : null}
          </p>
        )}
        <InvestmentBasisNote valuation={valuation} />
        {historical && seriesConversion && seriesConversion.unconverted.length > 0 && (
          // A currency with NO series at all is still counted native — the
          // wrong-total warning outranks any basis line, exactly as it does
          // on the live path below.
          <ConvertedTotalNote
            provenance={null}
            unconverted={seriesConversion.unconverted}
            displayCurrency={displayCurrency}
          />
        )}
        {!historical && conversion && (
          <ConvertedTotalNote
            provenance={conversion.factors.size > 0 ? ratesProvenance : null}
            unconverted={conversion.unconverted}
            displayCurrency={displayCurrency}
          />
        )}
      </div>

      {/* Opening-date caveat — shown right above the chart it qualifies, and
          only when there is something to qualify. */}
      {(openingDateWarnings.undated.length > 0 || openingDateWarnings.inferred.length > 0) && (
        <div className="rounded-2xl border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 px-5 py-3 mb-6 space-y-1.5">
          {openingDateWarnings.undated.length > 0 && (
            <p className="text-sm text-amber-800 dark:text-amber-300">
              <span className="font-semibold">
                {openingDateWarnings.undated.length} account{openingDateWarnings.undated.length === 1 ? "'s" : "s'"} opening balance{openingDateWarnings.undated.length === 1 ? ' counts' : 's count'} from the beginning of time — net worth before {openingDateWarnings.undated.length === 1 ? 'its' : 'their'} real opening date is overstated. Set the date in Account Settings.
              </span>{' '}
              <span className="text-amber-700 dark:text-amber-400">{openingDateWarnings.undated.join(', ')}</span>
            </p>
          )}
          {openingDateWarnings.inferred.length > 0 && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              {openingDateWarnings.inferred.length} account{openingDateWarnings.inferred.length === 1 ? "'s" : "s'"} opening date{openingDateWarnings.inferred.length === 1 ? ' is' : 's are'} inferred from {openingDateWarnings.inferred.length === 1 ? 'its' : 'their'} first activity — set the real date to be exact.{' '}
              <span className="text-amber-600 dark:text-amber-500">{openingDateWarnings.inferred.join(', ')}</span>
            </p>
          )}
        </div>
      )}

      {/* Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700 p-6">
        <div className="flex flex-wrap items-start justify-between gap-2 mb-1">
          <h2 className="text-lg font-semibold flex items-center gap-2 text-gray-900 dark:text-white">
            <TrendingUpIcon size={20} className="text-gray-500" />
            Net Worth Over Time
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {/* The window, IN the card it governs (owner, 22 Aug: "have the
                timescale selector in the chart, on the left of the Assets &
                Liabilities button") — the Investments card's arrangement. It
                is still the hub's shared picker, so the period chosen here
                follows the reader to every other report exactly as before;
                only where it stands changed. The hub knows not to render its
                own copy for this report (ownsPeriodBar in the registry). */}
            <PeriodBar picker={picker} label="Reporting period" />
            <button
              type="button"
              onClick={toggleDetail}
              aria-pressed={showDetail}
              title={showDetail ? 'Hide the assets and liabilities series' : 'Also show assets and liabilities'}
              className={`px-3 py-1 text-sm font-medium rounded-lg border transition-colors ${
                showDetail
                  /* The selected fill is the slate the period picker's ruling
                     blessed (`dark:bg-[#2d3a4d]`), because this button stands
                     in the SAME row as that picker — a stock dark:bg-blue-600
                     here was a second selected-state identity six pixels from
                     the first, on one ground only (Claude Design 22 Aug §3). */
                  ? 'border-[#1a2332] dark:border-[#2d3a4d] bg-[#1a2332] dark:bg-[#2d3a4d] text-white'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
              }`}
            >
              Assets &amp; Liabilities
            </button>
            <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-0.5">
              {(['line', 'bar'] as const).map(type => (
                <button
                  key={type}
                  type="button"
                  onClick={() => handleChartType(type)}
                  className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                    chartType === type
                      ? 'bg-[#1a2332] dark:bg-[#2d3a4d] text-white'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                  }`}
                >
                  {type === 'line' ? 'Line' : 'Bar'}
                </button>
              ))}
            </div>
            {/* This report draws its own period bar (ownsPeriodBar), so the
                hub does not render the save-as-default control above it —
                it belongs beside the picker it modifies, which is this row. Same
                hook as the hub's, so the two cannot disagree about whether
                what is on screen is the saved window. */}
            <ReportPeriodDefaultToggle
              isDefault={periodDefault.isDefault}
              periodLabel={periodDefault.periodLabel}
              onSave={periodDefault.save}
              onClear={periodDefault.clear}
            />
          </div>
        </div>
        {/* The card's subtitle used to restate the page header's ("computed
            from your full history… click any point") two hundred pixels apart
            (Claude Design 22 Aug §5). It now says the one thing the header
            can't: what "growth" means on this card — the honesty line that
            was below the band, in the slot a reader actually passes on the
            way to the figures it qualifies. */}
        {latest && earliest && snapshots.length > 1 && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Growth of everything you own less what you owe — money you saved counts
            as growth here, unlike the portfolio&rsquo;s return figures, which strip
            your payments in and out.
          </p>
        )}
        {/* ─ THE GROWTH BAND ─────────────────────────────────────────────────
            The Investments strip's shape, for the whole balance sheet, so the
            two rates can stand side by side — which is the owner's stated
            use: "my investments may be growing by say 5% average but are my
            overall net assets growing in line with that". The provenance line
            is the difference between the two rates said out loud. */}
        {latest && earliest && snapshots.length > 1 && (
          <div className="mb-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
              <div>
                <p className="text-label uppercase tracking-wider text-gray-500 dark:text-gray-400">Started at</p>
                <p className="text-body font-semibold tabular-nums text-gray-900 dark:text-white">
                  {formatCurrency(earliest.netWorth)}
                </p>
                <p className="text-dense text-gray-500 dark:text-gray-400">{earliest.label}</p>
              </div>
              <div>
                <p className="text-label uppercase tracking-wider text-gray-500 dark:text-gray-400">Ended at</p>
                <p className="text-body font-semibold tabular-nums text-gray-900 dark:text-white">
                  {formatCurrency(latest.netWorth)}
                </p>
                <p className="text-dense text-gray-500 dark:text-gray-400">{latest.label}</p>
              </div>
              <div>
                <p className="text-label uppercase tracking-wider text-gray-500 dark:text-gray-400">Change</p>
                <p className={`text-body font-semibold tabular-nums ${
                  change.isZero()
                    ? 'text-gray-900 dark:text-white'
                    : change.greaterThan(0) ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                }`}>
                  {change.greaterThan(0) ? '+' : ''}{formatCurrency(change.toNumber())}
                </p>
                {growth.periodPct !== null && (
                  <p className="text-dense text-gray-500 dark:text-gray-400 tabular-nums">
                    {formatGrowth(growth.periodPct)} over the period
                  </p>
                )}
              </div>
              <div>
                <p className="text-label uppercase tracking-wider text-gray-500 dark:text-gray-400">Growth, annualised</p>
                {growth.annualisedPct !== null ? (
                  <p className={`text-body font-semibold tabular-nums ${
                    growth.annualisedPct.isZero()
                      ? 'text-gray-900 dark:text-white'
                      : growth.annualisedPct.greaterThan(0) ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                  }`}>
                    {formatGrowth(growth.annualisedPct)}
                  </p>
                ) : (
                  <>
                    <p className="text-body font-semibold text-gray-500 dark:text-gray-400">—</p>
                    {growth.reason && (
                      <p className="text-dense text-gray-500 dark:text-gray-400">{growth.reason}</p>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
        {snapshots.length === 0 ? (
          <p className="text-center py-16 text-gray-400">No data in this period</p>
        ) : (
          <div className="h-96">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={snapshots}
                onClick={(state) => {
                  const label = state?.activeLabel;
                  const snap = snapshots.find(s => s.label === label);
                  if (snap) setDrillDate(snap.date);
                }}
                style={{ cursor: 'pointer' }}
              >
                {!showDetail && chartType !== 'bar' && seriesWash(NET_WORTH_CHART_KEY, decomposition.total.color, isDark)}
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(107, 114, 128, 0.2)" />
                {/* Years for a multi-year window (§2.3) — same helper as the
                    Dashboard widget, so card and report tick identically. */}
                <XAxis dataKey="label" tick={{ fill: '#6B7280', fontSize: 12 }} minTickGap={24} {...netWorthAxisTicks(snapshots)} />
                {/* Below zero only when the data goes there (§2.4) — with
                    OUR ticks (netWorthValueAxis), because recharts' own
                    rounding answered a shallow early dip with a floor a
                    full tick step down. All three plotted series feed the
                    scale. */}
                <YAxis
                  tick={{ fill: '#6B7280', fontSize: 12 }} tickFormatter={compactTick} width={70}
                  {...netWorthValueAxis(
                    // The scale covers what is DRAWN: the context series join
                    // it only when their lines are on, or the net line would
                    // float in the bottom half of an axis sized for assets.
                    showDetail
                      ? snapshots.flatMap(s => [s.netWorth, s.assets, s.liabilities])
                      : snapshots.map(s => s.netWorth)
                  )}
                />
                {/* The radius-only contentStyle LOOKED themed and set no
                    colour — the same survivor pattern the 16 Aug sweep found
                    on three other report pages. */}
                <Tooltip
                  formatter={(value: number | string) => formatCurrency(typeof value === 'number' ? value : Number(value))}
                  contentStyle={chartTooltipStyle} itemStyle={chartTooltipItemStyle} separator=": "
                />
                {/* A legend distinguishes series; with one line there is
                    nothing to distinguish and the card title already names it
                    (Claude Design 22 Aug §6). Three series is when it earns
                    its row. */}
                {showDetail && <Legend content={<DecompositionLegend />} />}
                {chartType === 'bar' ? (
                  // Money-style bar view: net worth as bars, assets/liabilities
                  // as context lines. Same data, same click-to-drill.
                  <Bar dataKey="netWorth" name="Net Worth" fill={decomposition.total.color} radius={[3, 3, 0, 0]} cursor="pointer" />
                ) : showDetail ? (
                  <Line
                    type="monotone"
                    dataKey="netWorth"
                    name="Net Worth"
                    stroke={decomposition.total.color}
                    strokeWidth={decomposition.total.width}
                    dot={singlePointDot(snapshots, decomposition.total.color)}
                    activeDot={{ r: 5 }}
                    isAnimationActive={false}
                  />
                ) : (
                  /* ─ THE WASH, AND WHY ONLY HERE (charts/richLine, 29 Aug) ──
                     The parts are off by default, so this is the chart most
                     readers see: one line, and nothing else drawn in the plot.
                     A wash of its own colour is safe in exactly that state.

                     It stands down the moment Assets and Liabilities come on,
                     and the ruling above `decompositionSeries` is why. That
                     ruling separates three series by SHAPE in one hue, on the
                     strength of contrast figures measured against the CARD
                     (#f8f9fb / #1f2937). A fill under the total would put the
                     two dashed parts on a different ground than the one those
                     figures describe — the measurement would stop being true
                     without anything failing. With one series there is nothing
                     to separate and no other line's ground to change, so the
                     ruling has no quarrel with it. `richLine.test.tsx` measures
                     this line over its own wash on both grounds. */
                  <Area
                    type="monotone"
                    dataKey="netWorth"
                    name="Net Worth"
                    stroke={decomposition.total.color}
                    strokeWidth={decomposition.total.width}
                    fill={seriesWashFill(NET_WORTH_CHART_KEY, decomposition.total.color, isDark)}
                    fillOpacity={1}
                    {...lineMarkers(snapshots, decomposition.total.color)}
                    isAnimationActive={false}
                  />
                )}
                {showDetail && (
                  <Line
                    type="monotone"
                    dataKey="assets"
                    name="Assets"
                    stroke={decomposition.part.color}
                    strokeWidth={decomposition.part.width}
                    strokeDasharray={decomposition.part.dash}
                    dot={singlePointDot(snapshots, decomposition.part.color)}
                    isAnimationActive={false}
                  />
                )}
                {showDetail && (
                  <Line
                    type="monotone"
                    dataKey="liabilities"
                    name="Liabilities"
                    stroke={decomposition.counterpart.color}
                    strokeWidth={decomposition.counterpart.width}
                    strokeDasharray={decomposition.counterpart.dash}
                    dot={singlePointDot(snapshots, decomposition.counterpart.color)}
                    isAnimationActive={false}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Drill-in: balances by account on the clicked date */}
      <Modal
        isOpen={drillDate !== null}
        onClose={() => setDrillDate(null)}
        title={drillDate ? `Balances on ${drillDate.toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}
        size="md"
      >
        <ModalBody>
          {drillBalances.length === 0 ? (
            <p className="text-center py-8 text-gray-400">No account balances on this date</p>
          ) : (
            <div>
              {/* ─ WHAT NET WORTH WAS MADE OF (owner, 22 Aug) ────────────────
                  The default answer is the SECTION totals — the same bands
                  the Accounts page files under — because "net worth made up
                  of Current Accounts / Investments / Assets…" is the summary
                  a day's flat list buried. "By account" opens each section's
                  accounts beneath its heading; "All" is the old flat list.
                  Sorts follow the Accounts page's idiom — press the active
                  pill again to flip it — and order accounts, never the
                  sections, which keep the ladder's own order. */}
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-0.5">
                  {([['groups', 'Groups'], ['grouped', 'By account'], ['all', 'All']] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setDrillView(mode)}
                      aria-pressed={drillView === mode}
                      className={`px-2.5 py-1 text-sm font-medium rounded-md whitespace-nowrap transition-colors ${
                        drillView === mode
                          ? 'bg-[#1a2332] dark:bg-[#2d3a4d] text-white'
                          : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {drillView !== 'groups' && (
                  <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-0.5">
                    <button
                      type="button"
                      onClick={() => setDrillSort(drillSort === 'name' ? 'name-desc' : 'name')}
                      className={`px-2.5 py-1 text-sm font-medium rounded-md whitespace-nowrap transition-colors ${
                        drillSort === 'name' || drillSort === 'name-desc'
                          ? 'bg-[#1a2332] dark:bg-[#2d3a4d] text-white'
                          : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                      }`}
                    >
                      Name {drillSort === 'name-desc' ? 'Z–A' : 'A–Z'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDrillSort(drillSort === 'value-desc' ? 'value-asc' : 'value-desc')}
                      className={`px-2.5 py-1 text-sm font-medium rounded-md whitespace-nowrap transition-colors ${
                        drillSort === 'value-desc' || drillSort === 'value-asc'
                          ? 'bg-[#1a2332] dark:bg-[#2d3a4d] text-white'
                          : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                      }`}
                    >
                      Value {drillSort === 'value-asc' ? '↑' : '↓'}
                    </button>
                  </div>
                )}
              </div>

              {drillView === 'all' ? (
                <div className="divide-y divide-gray-100 dark:divide-gray-700">
                  {drillAll.map(({ account, balance }) => (
                    <button
                      key={account.id}
                      type="button"
                      onClick={() => openRegisterFromDrill(account.id)}
                      className="w-full flex items-center gap-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors rounded-lg px-2 -mx-2"
                      title="Open this account's register"
                    >
                      <span className="flex-1 min-w-0 text-sm text-gray-800 dark:text-gray-200 break-words line-clamp-2">{account.name}</span>
                      <span className={`text-sm font-semibold tabular-nums ${
                        balance.greaterThanOrEqualTo(0) ? 'text-gray-900 dark:text-white' : 'text-red-600 dark:text-red-400'
                      }`}>
                        {formatCurrency(balance.toNumber(), account.currency)}
                      </span>
                      <ChevronRightIcon size={16} className="text-gray-400 flex-shrink-0" />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-1">
                  {drillGroups.map(group => (
                    <div key={group.section.type}>
                      {/* The depth ladder's top step, as everywhere a section
                          heads its rows. */}
                      <div className={`flex items-center justify-between gap-3 rounded px-2 py-2 ${DEPTH_LEVEL_1}`}>
                        <span className="text-sm font-bold uppercase tracking-wide text-gray-900 dark:text-white">
                          {group.section.title}
                        </span>
                        <span className={`text-sm font-semibold tabular-nums ${
                          group.subtotal.greaterThanOrEqualTo(0) ? 'text-gray-900 dark:text-white' : 'text-red-600 dark:text-red-400'
                        }`}>
                          {/* ≈ when the band holds converted money — the mark
                              the summary cards already use for the same fact. */}
                          {group.holdsForeign ? '≈ ' : ''}{formatCurrency(group.subtotal.toNumber())}
                        </span>
                      </div>
                      {drillView === 'grouped' && (
                        <div className="divide-y divide-gray-100 dark:divide-gray-700">
                          {group.entries.map(({ account, balance }) => (
                            <button
                              key={account.id}
                              type="button"
                              onClick={() => openRegisterFromDrill(account.id)}
                              className="w-full flex items-center gap-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors rounded-lg px-2"
                              title="Open this account's register"
                            >
                              <span className="flex-1 min-w-0 text-sm text-gray-800 dark:text-gray-200 break-words line-clamp-2">{account.name}</span>
                              <span className={`text-sm font-semibold tabular-nums ${
                                balance.greaterThanOrEqualTo(0) ? 'text-gray-900 dark:text-white' : 'text-red-600 dark:text-red-400'
                              }`}>
                                {formatCurrency(balance.toNumber(), account.currency)}
                              </span>
                              <ChevronRightIcon size={16} className="text-gray-400 flex-shrink-0" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between pt-3 mt-1 border-t border-gray-200 dark:border-gray-700">
                <span className="text-sm font-semibold text-gray-900 dark:text-white">Net worth</span>
                <span className="text-sm font-bold tabular-nums text-gray-900 dark:text-white">
                  {drillHoldsForeign ? '≈ ' : ''}
                  {formatCurrency(
                    drillBalances.reduce((sum, e) => {
                      const factor = drillConversion?.factors.get(e.account.id);
                      return sum.plus(factor ? e.balance.times(factor) : e.balance);
                    }, toDecimal(0)).toNumber()
                  )}
                </span>
              </div>
              {/* THE RATE BASIS, SAID (Claude Design, 22 Aug §1 and the
                  ruling §6.2/§6.3): a historic drill converts at SOME date's
                  rate, and which one is a real decision the reader cannot
                  infer. With the ECB history loaded the answer is the day's
                  own reference rate; degraded, it is today's — defensible
                  only if stated, so each basis states itself. The ≈ stays
                  either way: a converted figure is a valuation, not a
                  recorded amount. Rendered nothing when nothing converted. */}
              {drillHoldsForeign && (
                <p className="pt-2 text-dense text-gray-500 dark:text-gray-400">
                  {historical
                    ? <>≈ marks totals holding another currency, converted at this
                      day&rsquo;s ECB reference rate. Weekends and holidays carry the
                      previous business day&rsquo;s rate. Each account&rsquo;s own
                      figure is shown in its own currency.</>
                    : <>≈ marks totals holding another currency, converted at{' '}
                      {ratesProvenance
                        ? <>today&rsquo;s rates (as of {formatTime(ratesProvenance.asOf)})</>
                        : 'no available rate — those amounts are counted unconverted'}
                      {' '}applied to that day&rsquo;s balances. Each account&rsquo;s own
                      figure is shown in its own currency.</>}
                </p>
              )}
            </div>
          )}
        </ModalBody>
      </Modal>
    </div>
  );
}
