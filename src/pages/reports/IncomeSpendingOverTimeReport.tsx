import React, { useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { useCurrencyDecimal } from '../../hooks/useCurrencyDecimal';
import { useReportDataset } from '../../hooks/useReportDataset';
import { useReportAccountSelection } from '../../hooks/useReportAccountSelection';
import ReportAccountMultiSelect from '../../components/reports/ReportAccountMultiSelect';
import ReportDrillModal, { type ReportDrillTarget } from '../../components/reports/ReportDrillModal';
import ReportExportBar from '../../components/reports/ReportExportBar';
import ReportCumulativeToggle from '../../components/reports/ReportCumulativeToggle';
import UncategorisedReviewBand from '../../components/reports/UncategorisedReviewBand';
import { buildMonthlyTrend } from '../../utils/monthlyTrend';
import { toCumulativeTrend } from '../../utils/cumulativeSeries';
import { SEMANTIC_SERIES, useChartTooltipStyle, useChartTooltipItemStyle } from '../../components/charts/chartColors';
import { legendText } from '../../components/charts/ChartLegendText';
import { singlePointDot } from '../../components/charts/singlePointDots';
import { toDecimal } from '../../utils/decimal';
import { formatDecimal } from '../../utils/decimal-format';
import { useCumulativeReport } from '../../hooks/useCumulativeReport';
import { ARRIVAL_ROW_CLASS, useArrivalRowFocus } from '../../hooks/useArrivalFocus';
import { PERIOD_LABELS } from '../../hooks/usePeriod';
import type { ReportViewProps } from './types';
import type { SplitExpandedTransaction } from '../../utils/transactionSplits';
import { preferences } from '../../services/preferencesService';

/**
 * "Income and spending over time" — month by month, what came in against what
 * went out, and what was left.
 *
 * The series comes from the shared builder (utils/monthlyTrend), which is the
 * same one behind the Dashboard's pinned trend widget — the glance and the
 * full report cannot disagree. Points on the chart and figures in the table
 * both open the transactions behind them.
 */

const CUMULATIVE_KEY = 'reports.incomeSpendingOverTime.cumulative.v1';

const compactTick = (value: number): string => {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${formatDecimal(abs / 1_000_000, 1)}M`;
  if (abs >= 1_000) return `${sign}${formatDecimal(abs / 1_000, 0)}K`;
  return formatDecimal(value, 0);
};

export default function IncomeSpendingOverTimeReport({ picker, focus }: ReportViewProps): React.JSX.Element {
  const selection = useReportAccountSelection();
  // A drill-down from the Dashboard's trend card names a month (YYYY-MM); its
  // row below is highlighted and scrolled into view, with both figures on it a
  // click from the transactions behind them.
  const monthFocus = useArrivalRowFocus(focus);
  const { accounts, categories, rows, flows, convert } = useReportDataset(picker, selection.scope);
  const { formatCurrency } = useCurrencyDecimal();
  // Recharts' default tooltip is black-on-white whatever the mode.
  const chartTooltipStyle = useChartTooltipStyle();
  const chartTooltipItemStyle = useChartTooltipItemStyle();
  const [drill, setDrill] = useState<ReportDrillTarget | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  // Lines or bars — same data, same drill-in; the choice is persisted.
  const [chartType, setChartType] = useState<'line' | 'bar'>(() =>
    preferences.getItem('reportsTrendChartType') === 'bar' ? 'bar' : 'line'
  );
  const handleChartType = (type: 'line' | 'bar'): void => {
    setChartType(type);
    preferences.setItem('reportsTrendChartType', type);
  };
  // Month on its own, or the period to date — the chart and the table below it
  // always agree, because both read the same series.
  const cumulativeToggle = useCumulativeReport(CUMULATIVE_KEY);
  const { cumulative } = cumulativeToggle;

  const trend = useMemo(() => buildMonthlyTrend(rows, categories, convert), [rows, categories, convert]);
  const series = useMemo(
    () => (cumulative ? toCumulativeTrend(trend) : trend),
    [trend, cumulative]
  );

  // The period's own totals — the same figures whichever way the months are
  // read, so they come from the month-by-month series either way.
  const totals = useMemo(() => {
    const income = trend.reduce((sum, point) => sum.plus(toDecimal(point.income)), toDecimal(0));
    const expenses = trend.reduce((sum, point) => sum.plus(toDecimal(point.expenses)), toDecimal(0));
    return { income: income.toNumber(), expenses: expenses.toNumber(), net: income.minus(expenses).toNumber() };
  }, [trend]);

  const netOf = (point: { income: number; expenses: number }): number =>
    toDecimal(point.income).minus(toDecimal(point.expenses)).toNumber();

  const firstMonthKey = trend[0]?.monthKey ?? null;

  // A cumulative figure is the period up to that month, so its drill-in must
  // carry every month behind it — the rows have to add up to the figure that
  // opened them. Month keys are UTC YYYY-MM, as the series builder makes them,
  // so comparing them as strings compares them as months.
  const rowsBehindFigure = (source: SplitExpandedTransaction[], monthKey: string): SplitExpandedTransaction[] =>
    source.filter(t => {
      const key = new Date(t.date).toISOString().slice(0, 7);
      if (!cumulative) return key === monthKey;
      return key <= monthKey && (firstMonthKey === null || key >= firstMonthKey);
    });

  const drillIntoMonth = (
    monthKey: string,
    label: string,
    bucket: 'income' | 'expense',
    total: number
  ): void => {
    setDrill({
      title: `${bucket === 'income' ? 'Income' : 'Expenses'} — ${cumulative ? `to ${label}` : label}`,
      bucket,
      rows: rowsBehindFigure(bucket === 'income' ? flows.incomeRows : flows.expenseRows, monthKey),
      total,
    });
  };

  // recharts calls activeDot onClick with (props, event) — but the argument
  // order has differed across versions, so scan for whichever carries the
  // datum payload.
  const handlePointClick = (series: 'income' | 'expenses') =>
    (...args: unknown[]): void => {
      for (const arg of args) {
        const payload = (arg as { payload?: { monthKey?: string; month?: string; income?: number; expenses?: number } } | null)?.payload;
        if (payload?.monthKey && payload.month) {
          drillIntoMonth(
            payload.monthKey,
            payload.month,
            series === 'income' ? 'income' : 'expense',
            payload[series] ?? 0
          );
          return;
        }
      }
    };

  // The legend and every tooltip read these names, so a running total can
  // never be presented as a month's own figure.
  const incomeSeriesName = cumulative ? 'Income (running total)' : 'Income';
  const expenseSeriesName = cumulative ? 'Expenses (running total)' : 'Expenses';

  const figureButton = (
    label: string,
    value: number,
    onClick: () => void,
    colour: string
  ): React.JSX.Element => (
    <button
      type="button"
      onClick={onClick}
      // The hover wash is the house neutral, not a stock blue (ruling of
      // 28 Aug 2026): a figure you can open is not a link, and the underline
      // beside it is already saying the row is live.
      className={`w-full justify-end text-right rounded px-1 -mx-1 tabular-nums hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:underline ${colour}`}
      title={`${label} — view these transactions`}
    >
      {formatCurrency(value)}
    </button>
  );

  return (
    <div className="max-w-[var(--report-max,1400px)] mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <ReportAccountMultiSelect accounts={accounts} selection={selection} />
          <ReportCumulativeToggle toggle={cumulativeToggle} />
        </div>
        <ReportExportBar
          title="Income and spending over time"
          dateRange={PERIOD_LABELS[picker.period]}
          rows={rows}
          flows={flows}
          categories={categories}
          accounts={accounts}
          charts={[chartRef]}
        />
      </div>

      <UncategorisedReviewBand flows={flows} categories={categories} />

      <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
        <div className="flex flex-wrap items-start justify-between gap-2 mb-1">
          <h2 className="text-card font-semibold text-theme-heading dark:text-white">
            {cumulative ? 'Income against spending, running totals' : 'Income against spending'}
          </h2>
          <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-0.5">
            {(['line', 'bar'] as const).map(type => (
              <button
                key={type}
                type="button"
                onClick={() => handleChartType(type)}
                aria-pressed={chartType === type}
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
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {PERIOD_LABELS[picker.period]}
          {cumulative && ' — each point is the period so far, not the month on its own'}
          {' '}— click a point, or any figure in the table, for the transactions behind it.
        </p>
        {series.length === 0 ? (
          <p className="text-center py-16 text-gray-400">No categorised transactions in this period</p>
        ) : (
          <div className="h-80" ref={chartRef}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={series}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(107, 114, 128, 0.2)" />
                <XAxis dataKey="month" tick={{ fill: '#6B7280', fontSize: 12 }} minTickGap={24} />
                <YAxis tick={{ fill: '#6B7280', fontSize: 12 }} tickFormatter={compactTick} width={70} />
                <Tooltip
                  contentStyle={chartTooltipStyle} itemStyle={chartTooltipItemStyle} separator=": "
                  formatter={(value: number | string) =>
                    formatCurrency(typeof value === 'number' ? value : Number(value))
                  }
                />
                <Legend formatter={legendText} />
                {/* ─ WHY THIS CHART IS NOT ROUTED THROUGH richLine ─────────
                    It reached the same idiom first and is where the shared one
                    was generalised FROM: no mark per point, one mark on hover.
                    Two things keep it spelled out here. Its hover mark is a
                    CLICK TARGET (it opens the transactions behind the point),
                    so r:6 is a size decision richLine's reading mark does not
                    make; and its two series cross, so neither may take a wash —
                    stacked washes mix into a third colour, on the one pair a
                    colour-blind reader already cannot separate. */}
                {chartType === 'bar' ? (
                  <Bar dataKey="income" name={incomeSeriesName} fill={SEMANTIC_SERIES.income} radius={[3, 3, 0, 0]} cursor="pointer" isAnimationActive={false} onClick={handlePointClick('income')} />
                ) : (
                  <Line
                    type="monotone"
                    dataKey="income"
                    name={incomeSeriesName}
                    stroke={SEMANTIC_SERIES.income}
                    strokeWidth={2}
                    dot={singlePointDot(series, SEMANTIC_SERIES.income)}
                    isAnimationActive={false}
                    activeDot={{ r: 6, cursor: 'pointer', onClick: handlePointClick('income') }}
                  />
                )}
                {chartType === 'bar' ? (
                  <Bar dataKey="expenses" name={expenseSeriesName} fill={SEMANTIC_SERIES.expense} radius={[3, 3, 0, 0]} cursor="pointer" isAnimationActive={false} onClick={handlePointClick('expenses')} />
                ) : (
                  <Line
                    type="monotone"
                    dataKey="expenses"
                    name={expenseSeriesName}
                    stroke={SEMANTIC_SERIES.expense}
                    strokeWidth={2}
                    dot={singlePointDot(series, SEMANTIC_SERIES.expense)}
                    isAnimationActive={false}
                    activeDot={{ r: 6, cursor: 'pointer', onClick: handlePointClick('expenses') }}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700">
        <div className="p-6 pb-3">
          <h2 className="text-card font-semibold text-theme-heading dark:text-white">Month by month</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {cumulative
              ? 'Running totals: every row is the period up to the end of that month.'
              : 'Every month on its own.'}
          </p>
        </div>
        {series.length === 0 ? (
          <p className="text-center py-16 text-gray-400">No categorised transactions in this period</p>
        ) : (
          /* The table scrolls inside its own box; the page never scrolls sideways. */
          <div className="overflow-x-auto rounded-b-2xl">
            <table className="min-w-full text-sm">
              <caption className="sr-only">
                {cumulative
                  ? 'Income, expenses and the balance for the period up to the end of each month'
                  : 'Income, expenses and the balance for each month of the period'}
              </caption>
              <thead className="bg-gray-50 dark:bg-gray-700/50">
                <tr>
                  <th scope="col" className="px-6 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 min-w-[140px]">
                    {cumulative ? 'Up to' : 'Month'}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    {cumulative ? 'Income to date' : 'Income'}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    {cumulative ? 'Expenses to date' : 'Expenses'}
                  </th>
                  <th scope="col" className="px-6 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    {cumulative ? 'Left over to date' : 'Left over'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {series.map(point => {
                  const net = netOf(point);
                  const landedHere = monthFocus.isFocused(point.monthKey);
                  return (
                    <tr
                      key={point.monthKey}
                      ref={landedHere ? monthFocus.focusRef : undefined}
                      aria-current={landedHere ? 'true' : undefined}
                      className={`border-t border-gray-50 dark:border-gray-700/50 ${landedHere ? ARRIVAL_ROW_CLASS : ''}`}
                    >
                      <th scope="row" className="px-6 py-2 text-left text-sm font-normal text-gray-900 dark:text-white">
                        {point.month}
                      </th>
                      <td className="px-3 py-2 text-sm text-right">
                        {figureButton(
                          cumulative ? `Income to ${point.month}` : `Income, ${point.month}`,
                          point.income,
                          () => drillIntoMonth(point.monthKey, point.month, 'income', point.income),
                          'text-green-700 dark:text-green-400'
                        )}
                      </td>
                      <td className="px-3 py-2 text-sm text-right">
                        {figureButton(
                          cumulative ? `Expenses to ${point.month}` : `Expenses, ${point.month}`,
                          point.expenses,
                          () => drillIntoMonth(point.monthKey, point.month, 'expense', point.expenses),
                          'text-red-600 dark:text-red-400'
                        )}
                      </td>
                      <td className={`px-6 py-2 text-sm text-right font-semibold tabular-nums ${
                        net < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'
                      }`}>
                        {formatCurrency(net)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t-2 border-gray-200 dark:border-gray-600">
                <tr>
                  <th scope="row" className="px-6 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
                    Total
                  </th>
                  <td className="px-3 py-3 text-sm text-right font-bold tabular-nums text-green-700 dark:text-green-400">
                    {formatCurrency(totals.income)}
                  </td>
                  <td className="px-3 py-3 text-sm text-right font-bold tabular-nums text-red-600 dark:text-red-400">
                    {formatCurrency(totals.expenses)}
                  </td>
                  <td className={`px-6 py-3 text-sm text-right font-bold tabular-nums ${
                    totals.net < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'
                  }`}>
                    {formatCurrency(totals.net)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <ReportDrillModal target={drill} onClose={() => setDrill(null)} categories={categories} />
    </div>
  );
}
