import React, { useMemo } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart as RechartsPieChart,
  Pie,
  Cell,
} from 'recharts';
import { useApp } from '../../../contexts/AppContextSupabase';
import { useCurrencyDecimal } from '../../../hooks/useCurrencyDecimal';
import { categoricalColor, categoricalRamp, MAX_CATEGORICAL_SERIES, useCategoricalRamp, useIsDarkGround, SEMANTIC_SERIES, useChartTooltipStyle, useChartTooltipItemStyle } from '../../charts/chartColors';
import { lineMarkers, seriesWash, seriesWashFill } from '../../charts/richLine';
import { buildMonthlyTrend } from '../../../utils/monthlyTrend';
import { buildNetWorthSnapshots, netWorthAxisTicks, netWorthPointToken, netWorthValueAxis } from '../../../utils/netWorthSeries';
import { useInvestmentValuation } from '../../../hooks/useInvestmentValuation';
import { computeExpenseCategoryNetTotals } from '../../../utils/categoryNetting';
import { expandSplitTransactions } from '../../../utils/transactionSplits';
import { formatDecimal } from '../../../utils/decimal-format';
import type { UsePeriodResult } from '../../../hooks/usePeriod';
import type { CardPeriodPin } from '../../../hooks/useCardPeriod';
import DashboardWidgetCard from './DashboardWidgetCard';
import CardPeriodControl from './CardPeriodControl';
import { WIDGET_CHART_HEIGHT } from './widgetChrome';
import { useReportDrill } from './useReportDrill';
import { useHistoricalAccounts } from '../../../hooks/useHistoricalAccounts';
import { useNetWorthConversion } from '../../../hooks/useNetWorthConversion';
import { useFlowConvert } from '../../../hooks/useFlowConvert';
import { useNegativeTone } from '../../../contexts/NegativesInRedContext';

/**
 * Compact, live versions of the Reports-hub reports for the Dashboard's
 * "pinned reports" section. Each widget computes from the SAME shared maths
 * as its full report (utils/monthlyTrend, utils/netWorthSeries,
 * utils/categoryNetting), so the glance and the full view can never
 * disagree.
 *
 * Every card clicks through to ITS report in the gallery — the ids below are
 * the report gallery's stable URL segments (see pages/reports/reportRegistry).
 * The click carries TWO things it used to drop on the floor: the period the
 * card was read over, so the report opens on the same window rather than on
 * whatever it last stored; and where the user came from, so the report's
 * back-link returns to the Dashboard (see useReportDrill).
 *
 * Clicking a point rather than the header carries the point as well, and the
 * report lands on it. What "lands on it" means is the report's own business —
 * the month-by-month table highlights the month, the net-worth line opens that
 * day's balances — which is why the widgets pass a token and nothing else.
 *
 * Every chart area is WIDGET_CHART_HEIGHT and every card wears the same shell,
 * so the four cards in the section are one height rather than four.
 *
 * ── `picker` AND `pin` ARE NOT TWO WINDOWS ──────────────────────────────────
 *
 * `picker` is the window the card is read over, whether that is the page's or
 * one this card was pinned to; the Dashboard resolves which before handing it
 * over (hooks/useCardPeriod). `pin` carries no window at all — only whether
 * this card has one of its own and the two ways to change that — so the card's
 * chart, its click-through and its declaration cannot disagree about the
 * window, because there is only one of them to read.
 *
 * `pin` is optional: a card rendered without it is a card with no period
 * affordance, which is exactly what these three were before the pin existed.
 */

const compactTick = (value: number): string => {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${formatDecimal(abs / 1_000_000, 1)}M`;
  if (abs >= 1_000) return `${sign}${formatDecimal(abs / 1_000, 0)}K`;
  return formatDecimal(value, 0);
};

const NET_WORTH_TITLE = 'Net Worth Over Time';
/** Names this card's wash in the document — stated once, used twice. */
const NET_WORTH_CHART_KEY = 'dashboard-net-worth';

export function NetWorthWidget({ picker, pin }: {
  picker: UsePeriodResult;
  pin?: CardPeriodPin;
}): React.JSX.Element {
  const { accounts: openAccounts, transactions } = useApp();
  const { formatCurrency } = useCurrencyDecimal();
  const openReport = useReportDrill();
  // Recharts' default tooltip is black-on-white whatever the page's mode —
  // the themed style is the difference between a label and a glare in dark.
  const chartTooltipStyle = useChartTooltipStyle();
  const chartTooltipItemStyle = useChartTooltipItemStyle();

  /*
   * THE LINE HAS TO SURVIVE THE GROUND IT IS DRAWN ON.
   *
   * This stroke was the literal `#1a2332` — navy-900, the DARKEST step of the
   * categorical axis. On the light card it is the right ink; on the dark card
   * it is near-black on #1f2937 and the owner reported the line as simply not
   * there. The donuts on this same page were converted to the ground-aware
   * ramp and looked correct throughout, which is exactly why a single
   * hardcoded series went unnoticed: nothing else on the card was wrong.
   *
   * Index 0 rather than a colour of its own — one series should wear the
   * ramp's most prominent step, and then it moves with the ramp instead of
   * needing its own dark-mode remembering.
   */
  // ONE reading of the ground per render: the stroke comes from it and so does
  // the wash's strength, so the two cannot disagree about the theme.
  const isDark = useIsDarkGround();
  const lineStroke = categoricalColor(categoricalRamp(isDark), 0);

  /**
   * OPEN AND CLOSED. This card draws the same series as the full report and
   * must not disagree with it: the app context holds open accounts only, so
   * both used to omit whatever the owner's closed accounts held at each point
   * in the past. See useHistoricalAccounts.
   */
  const accounts = useHistoricalAccounts(openAccounts);

  /**
   * The SAME conversion the full report applies (ruling C: this card and the
   * report may not disagree about the same money) — foreign-currency accounts
   * convert at each day's ECB reference rate where the history is loaded,
   * today's rates while degraded, EXACTLY as the report does with the same
   * window. The full provenance sentence lives on the report this card
   * opens; the ≈ on the headline is this card's own honest mark.
   */
  const { seriesConversion, displayCurrency } = useNetWorthConversion(accounts, { range: picker.range });
  const holdsForeign = useMemo(
    () => accounts.some(a => (a.currency || displayCurrency) !== displayCurrency),
    [accounts, displayCurrency]
  );

  // The SAME valuation term as the report this card opens (slice 3b) — the
  // two must draw one line. The basis sentence lives on the report, exactly
  // as the rates provenance does.
  const valuation = useInvestmentValuation();
  const snapshots = useMemo(
    () =>
      buildNetWorthSnapshots(
        accounts,
        transactions,
        picker.range,
        new Date(),
        seriesConversion ?? undefined,
        valuation.deltaAt
      ),
    [accounts, transactions, picker.range, seriesConversion, valuation]
  );
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const negativeTone = useNegativeTone();

  const open = (focus?: string): void =>
    openReport('net-worth-over-time', { period: picker, focus });

  return (
    <DashboardWidgetCard
      title={NET_WORTH_TITLE}
      subtitle={
        <>
          <span className={`min-w-0 text-xl font-bold truncate ${negativeTone(latest?.netWorth, 'text-gray-900 dark:text-white')}`}>
            {latest ? `${holdsForeign ? '≈ ' : ''}${formatCurrency(latest.netWorth)}` : '—'}
          </span>
          {pin && <CardPeriodControl cardLabel={NET_WORTH_TITLE} picker={picker} pin={pin} />}
        </>
      }
      onOpen={() => open()}
    >
      {/* AN AXIS WITH NOTHING ON IT IS A CLAIM (Claude Design §3). The frame
          asserts there is something to plot, so an empty one reads as a chart
          that failed to load rather than as a period with no data — and
          Expense Categories, on the same page, already says so in words. Same
          box height either way, so an empty card does not shrink out of line
          with its neighbour. */}
      {snapshots.length < 2 ? (
        <div className={`${WIDGET_CHART_HEIGHT} flex items-center justify-center`}>
          <p className="text-center text-sm text-gray-400">Not enough history yet to draw a line</p>
        </div>
      ) : (
      <div className={WIDGET_CHART_HEIGHT}>
        <ResponsiveContainer width="100%" height="100%">
          {/* Clicking a point opens the report on the same window with THAT
              day's balances already showing — the report's own answer to a
              point, reached from the card. The chart carries the click (not
              each dot) because the line is normally drawn without dots:
              recharts hands back the label under the pointer, which is enough
              to name the snapshot. (A window holding ONE snapshot draws a
              solid mark instead: recharts gives a lone point a white-filled
              3px ring that reads as an empty plot — see
              charts/singlePointDots for the measurement. The click still
              comes from the chart, so that case needs nothing extra here.) */}
          <AreaChart
            data={snapshots}
            style={{ cursor: 'pointer' }}
            onClick={(state) => {
              const snapshot = snapshots.find(s => s.label === state?.activeLabel);
              if (snapshot) open(netWorthPointToken(snapshot.date));
            }}
          >
            {seriesWash(NET_WORTH_CHART_KEY, lineStroke, isDark)}
            {/* Years for a multi-year window, months within one — the tick
                format follows the span (Design, 17 Aug §2.3). */}
            <XAxis dataKey="label" tick={{ fill: '#6B7280', fontSize: 10 }} minTickGap={32} {...netWorthAxisTicks(snapshots)} />
            {/* The domain follows the DATA and dips below zero only when the
                data does (§2.4). The ticks are OURS (netWorthValueAxis): the
                function-form domain alone did not stop recharts' nice-tick
                rounding from answering one shallow early dip with a floor a
                full tick step below zero — a quarter of the plot spent on
                nothing, flattening the curve the chart exists to show
                (owner, 19 Aug, on his real ledger). */}
            <YAxis
              tick={{ fill: '#6B7280', fontSize: 10 }} tickFormatter={compactTick} width={44}
              {...netWorthValueAxis(snapshots.map(s => s.netWorth))}
            />
            <Tooltip contentStyle={chartTooltipStyle} itemStyle={chartTooltipItemStyle} separator=": " formatter={(v: number | string) => formatCurrency(typeof v === 'number' ? v : Number(v))} />
            {/* ONE series, so it may take the wash (charts/richLine): a
                gradient of its own stroke colour fading to nothing gives the
                card the body an investment platform's charts have, without
                spending a second colour on it. `lineStroke` is ground-aware,
                and the wash is derived from it rather than pinned, so the card
                does not keep a light-mode navy after dusk. */}
            <Area
              type="monotone"
              dataKey="netWorth"
              name="Net Worth"
              stroke={lineStroke}
              strokeWidth={2}
              fill={seriesWashFill(NET_WORTH_CHART_KEY, lineStroke, isDark)}
              fillOpacity={1}
              {...lineMarkers(snapshots, lineStroke)}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      )}
    </DashboardWidgetCard>
  );
}

const INCOME_EXPENSE_TITLE = 'Income vs Expenses';

export function IncomeExpenseTrendWidget({ picker, pin }: {
  picker: UsePeriodResult;
  pin?: CardPeriodPin;
}): React.JSX.Element {
  const { transactions, transactionSplits, categories, accounts } = useApp();
  const { formatCurrency } = useCurrencyDecimal();
  const openReport = useReportDrill();
  // The flows seam (ruling C): the same per-date resolver the report this
  // card opens uses, so the two cannot sum on different bases.
  const convert = useFlowConvert(accounts);
  // Recharts' default tooltip is black-on-white whatever the page's mode —
  // the themed style is the difference between a label and a glare in dark.
  const chartTooltipStyle = useChartTooltipStyle();
  const chartTooltipItemStyle = useChartTooltipItemStyle();
  const { range } = picker;

  const data = useMemo(() => {
    const rows = expandSplitTransactions(transactions, transactionSplits).filter(t => {
      const time = new Date(t.date).getTime();
      if (range.from && time < range.from.getTime()) return false;
      if (range.to && time > range.to.getTime()) return false;
      return true;
    });
    return buildMonthlyTrend(rows, categories, convert);
  }, [transactions, transactionSplits, categories, range, convert]);

  const open = (focus?: string): void =>
    openReport('income-and-spending-over-time', { period: picker, focus });

  return (
    <DashboardWidgetCard
      title={INCOME_EXPENSE_TITLE}
      subtitle={
        <>
          <span className="min-w-0 text-xs text-gray-500 dark:text-gray-400 truncate">
            Month by month, what came in against what went out
          </span>
          {pin && <CardPeriodControl cardLabel={INCOME_EXPENSE_TITLE} picker={picker} pin={pin} />}
        </>
      }
      onOpen={() => open()}
    >
      {/* WORDS, NOT A DASHED BOX (Design's second look, §2). With no series
          this drew a bare rectangle — no axes, no message — under a subtitle
          promising "month by month, what came in against what went out", so
          the reader was told what it would show and nothing about why it did
          not. That was a THIRD empty treatment on one screen.

          The dashed rectangle was recharts drawing its own placeholder for an
          empty series, which is worth knowing: it would appear anywhere the
          library is handed no data, so the guard belongs at the call site
          rather than in a style. */}
      {data.length === 0 ? (
        <div className={`${WIDGET_CHART_HEIGHT} flex items-center justify-center`}>
          <p className="text-center text-sm text-gray-400">Nothing came in or went out in this period</p>
        </div>
      ) : (
      <div className={WIDGET_CHART_HEIGHT}>
        <ResponsiveContainer width="100%" height="100%">
          {/* A click lands on the report's row for THAT month, highlighted,
              with both figures on it one click from the transactions behind
              them. Deliberately not straight into one of those two lists: the
              tooltip covers income and expenses together, so a click near the
              crossing point cannot say which was meant, and guessing would open
              the wrong one half the time. */}
          <LineChart
            data={data}
            style={{ cursor: 'pointer' }}
            onClick={(state) => {
              const point = data.find(d => d.month === state?.activeLabel);
              if (point) open(point.monthKey);
            }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(107, 114, 128, 0.2)" />
            <XAxis dataKey="month" tick={{ fill: '#6B7280', fontSize: 10 }} minTickGap={32} />
            <YAxis tick={{ fill: '#6B7280', fontSize: 10 }} tickFormatter={compactTick} width={44} />
            <Tooltip contentStyle={chartTooltipStyle} itemStyle={chartTooltipItemStyle} separator=": " formatter={(v: number | string) => formatCurrency(typeof v === 'number' ? v : Number(v))} />
            {/* No wash on these two (charts/richLine): income and expenses
                cross, and two translucent fills over each other make a third
                colour — on the one pair a colour-blind reader already cannot
                separate. They take the marks half of the idiom and stop. */}
            <Line type="monotone" dataKey="income" name="Income" stroke={SEMANTIC_SERIES.income} strokeWidth={2} {...lineMarkers(data, SEMANTIC_SERIES.income)} isAnimationActive={false} />
            <Line type="monotone" dataKey="expenses" name="Expenses" stroke={SEMANTIC_SERIES.expense} strokeWidth={2} {...lineMarkers(data, SEMANTIC_SERIES.expense)} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      )}
    </DashboardWidgetCard>
  );
}

const EXPENSE_CATEGORIES_TITLE = 'Expense Categories';

export function ExpenseCategoriesWidget({ picker, pin }: {
  picker: UsePeriodResult;
  pin?: CardPeriodPin;
}): React.JSX.Element {
  const { transactions, transactionSplits, categories, accounts } = useApp();
  const { formatCurrency } = useCurrencyDecimal();
  const openReport = useReportDrill();
  // The flows seam (ruling C): the same per-date resolver the report this
  // card opens uses, so the two cannot sum on different bases.
  const convert = useFlowConvert(accounts);
  // Recharts' default tooltip is black-on-white whatever the page's mode —
  // the themed style is the difference between a label and a glare in dark.
  const chartTooltipStyle = useChartTooltipStyle();
  const chartTooltipItemStyle = useChartTooltipItemStyle();
  const { range } = picker;
  // The shared ramp — see charts/chartColors. The copy that used to live in
  // this file was byte-identical to three others and drifted from a fourth.
  const ramp = useCategoricalRamp();

  const data = useMemo(() => {
    const rows = expandSplitTransactions(transactions, transactionSplits).filter(t => {
      const time = new Date(t.date).getTime();
      if (range.from && time < range.from.getTime()) return false;
      if (range.to && time > range.to.getTime()) return false;
      return true;
    });
    // FIVE, from the palette, not six. Six slices against a five-colour ramp
    // meant the sixth was painted like the first — reported by the owner as
    // "the pie is split into 5 sections and the legend lists 6".
    const top = computeExpenseCategoryNetTotals(rows, categories, convert).slice(0, MAX_CATEGORICAL_SERIES);
    /*
     * The share is of THE SLICES SHOWN, not of all spending — the ring is the
     * top six and the percentages have to add up to the ring the reader is
     * looking at. A share of the whole would leave the visible slices summing
     * to some number under 100 with nothing on screen to explain the rest.
     */
    const shown = top.reduce((sum, row) => sum + row.value, 0);
    return top.map(({ key, name, value }) => ({
      categoryId: key,
      name,
      value,
      share: shown > 0 ? (value / shown) * 100 : 0,
    }));
  }, [transactions, transactionSplits, categories, range, convert]);

  const open = (focus?: string): void =>
    openReport('spending-by-category', { period: picker, focus });

  return (
    <DashboardWidgetCard
      title={EXPENSE_CATEGORIES_TITLE}
      subtitle={
        <>
          <span className="min-w-0 text-xs text-gray-500 dark:text-gray-400 truncate">
            Where the money went, biggest first
          </span>
          {pin && <CardPeriodControl cardLabel={EXPENSE_CATEGORIES_TITLE} picker={picker} pin={pin} />}
        </>
      }
      onOpen={() => open()}
    >
      {/* The empty state fills the SAME box the chart would, so a period with
          nothing in it does not shrink the card out of line with its neighbour. */}
      {data.length === 0 ? (
        <div className={`${WIDGET_CHART_HEIGHT} flex items-center justify-center`}>
          <p className="text-center text-sm text-gray-400">No categorised spending in this period</p>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          {/* STACKS ON A PHONE, exactly as the Account Distribution card does.
              This was a plain `flex` with the height pinned to the WRAPPER, so
              below sm the ring and a five-row legend fought over ~340px and the
              legend stayed jammed to the right of the donut. Account
              Distribution has always been `flex-col sm:flex-row` with the
              height on the CHART — two cards drawing the same shape of data,
              behaving differently on the device where it matters most. */}
          {/* A SQUARE FOR THE DONUT, EVERY REMAINING PIXEL FOR THE NAMES.
              The chart box used to be `flex-1` and the legend a fixed `w-36`,
              which is backwards: a donut is circular, so a box wider than it is
              tall just centres the ring and wastes the difference on both
              sides, while the words beside it — real category names, which are
              long — were rationed to 144px and truncated to "Servicing,
              Mainten…". The card was spending its width on emptiness and
              charging the text for it. Now the ring takes a square of the
              card's height and the list takes the rest, which both moves the
              chart left and buys the names roughly 60px each. `min-w-0` is
              what lets `truncate` keep working in a flex child. */}
          <div className={`${WIDGET_CHART_HEIGHT} sm:aspect-square sm:flex-shrink-0`}>
            <ResponsiveContainer width="100%" height="100%">
              <RechartsPieChart>
                {/* A slice opens the report with that category's row
                    highlighted — the ranked table around it is the context a
                    single slice cannot give. */}
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  /* 60/90, which is what the Account Distribution card's
                     shared PieChart draws. It was 55/88 — a ring a shade
                     thicker and visibly smaller inside an identical box, so
                     two cards side by side looked like two different chart
                     styles rather than one. */
                  innerRadius="60%"
                  outerRadius="90%"
                  strokeWidth={0}
                  isAnimationActive={false}
                  cursor="pointer"
                  onClick={(entry) => {
                    const datum = ((entry as { payload?: typeof data[number] })?.payload ?? entry) as typeof data[number];
                    if (datum?.categoryId) open(datum.categoryId);
                  }}
                >
                  {data.map((entry, index) => (
                    <Cell key={entry.name} fill={categoricalColor(ramp, index)} />
                  ))}
                </Pie>
                <Tooltip contentStyle={chartTooltipStyle} itemStyle={chartTooltipItemStyle} separator=": " formatter={(v: number | string) => formatCurrency(typeof v === 'number' ? v : Number(v))} />
              </RechartsPieChart>
            </ResponsiveContainer>
          </div>
          {/* The legend does the same as the slice beside it, and is the only
              one of the two a keyboard can reach: an SVG sector is not a
              control. Same idiom as the Account Distribution card's legend. */}
          {/* NAME, FIGURE, SHARE — the same three the Account Distribution card
              beside it gives, and for the same reason: a ring says which slice
              is biggest and refuses to say by how much. The owner asked for
              them here after using that card. Each row still opens the full
              report on its category, as it always did. */}
          {/* EVERY slice the ring draws, not five of its six. With the shares
              computed over the shown slices, a legend one row short made them
              sum to 84.6% — a number nothing on screen accounted for. Six rows
              fit the card's height, so the list and the ring say the same
              thing and the percentages close at 100. */}
          {/* SAME RHYTHM AS THE CARD BESIDE IT. This was space-y-1 with
              px-1 py-0.5 rows at text-xs and 8px swatches, against the
              distribution card's space-y-2, px-2 py-1.5, text-sm and 12px —
              so one legend read as a dense table and the other as a list, on
              two cards that draw the same picture of the same shape of data.
              The owner asked for the roomier of the two, both. Five rows at
              this rhythm are ~192px inside the 208px the card allows. */}
          <ul className="sm:flex-1 sm:min-w-0 space-y-2">
            {data.map((d, i) => (
              <li key={d.categoryId}>
                <button
                  type="button"
                  onClick={() => open(d.categoryId)}
                  title={`${d.name} — open the full report on this category`}
                  className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                >
                  {/* 16px swatch (Design §11): the ramp's neighbouring slates
                      read as one tone at 12px. */}
                  <span className="w-4 h-4 rounded-sm flex-shrink-0" style={{ backgroundColor: categoricalColor(ramp, i) }} aria-hidden="true" />
                  <span className="flex-1 min-w-0 truncate text-sm text-gray-700 dark:text-gray-300">{d.name}</span>
                  {/* The figure takes what it needs and the name yields — a
                      truncated CATEGORY is still readable, a truncated amount
                      is a wrong number. */}
                  <span className="text-sm font-medium tabular-nums text-gray-900 dark:text-white whitespace-nowrap">
                    {formatCurrency(d.value)}
                  </span>
                  {/* The share is context rather than the answer, so it recedes
                      — same weight and width as the distribution card's. */}
                  <span className="w-12 shrink-0 text-right text-xs tabular-nums text-gray-400 dark:text-gray-500">
                    {formatDecimal(d.share, 1)}%
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </DashboardWidgetCard>
  );
}

/**
 * A pinned custom report: name + description, click-through to the hub.
 *
 * No period travels with this one and no point can be clicked on it — a custom
 * report carries its own date and account filters (usesPeriod: false in the
 * registry) and this card draws no chart. The way back still knows where it
 * came from.
 */
export function CustomReportWidget({ reportId }: { reportId: string }): React.JSX.Element | null {
  const openReport = useReportDrill();
  // The list comes from the context, which holds what the boot snapshot
  // answered with. That is what makes this `useMemo` possible at all: reports
  // used to be read from `localStorage` synchronously here, and a store that is
  // a network away has no synchronous read to replace it with — so they ride the
  // boot instead and this resolves against state. See `BootSnapshot`.
  const { customReports } = useApp();
  const report = useMemo(
    () => customReports.find(r => r.id === reportId) ?? null,
    [customReports, reportId]
  );
  if (!report) return null;

  return (
    <DashboardWidgetCard
      title={report.name}
      onOpen={() => openReport('custom-reports')}
    >
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {report.description || 'Custom report'}
      </p>
      <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
        {report.components.length} component{report.components.length === 1 ? '' : 's'} — open to generate
      </p>
    </DashboardWidgetCard>
  );
}
