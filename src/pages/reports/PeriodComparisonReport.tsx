import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { useCurrencyDecimal } from '../../hooks/useCurrencyDecimal';
import { useReportDataset } from '../../hooks/useReportDataset';
import { useReportAccountSelection } from '../../hooks/useReportAccountSelection';
import ReportAccountMultiSelect from '../../components/reports/ReportAccountMultiSelect';
import ReportDrillModal, { type ReportDrillTarget } from '../../components/reports/ReportDrillModal';
import ReportExportBar from '../../components/reports/ReportExportBar';
import UncategorisedReviewBand from '../../components/reports/UncategorisedReviewBand';
import { SEMANTIC_SERIES, useChartTooltipStyle, useChartTooltipItemStyle } from '../../components/charts/chartColors';
import { computeIncomeExpense } from '../../utils/incomeExpense';
import {
  buildPeriodComparison,
  resolveComparisonRanges,
  COMPARISON_BASIS_LABELS,
  type ComparisonBasis,
  type ComparisonCategoryRow,
  type ComparisonFigure,
} from '../../utils/periodComparison';
import { formatDecimal } from '../../utils/decimal-format';
import { PERIOD_LABELS } from '../../hooks/usePeriod';
import type { ReportViewProps } from './types';
import { preferences } from '../../services/preferencesService';
import { getDateLocale } from '../../utils/dateFormatter';

/**
 * "This period vs last" — Money's comparison report.
 *
 * Two equal-length windows, classified by the one shared classifier
 * (utils/incomeExpense) and compared by the one shared builder
 * (utils/periodComparison). Both windows are computed from the SAME resolved
 * bounds, so the comparison is never an apples-to-oranges pairing of a full
 * month against a part of one.
 *
 * Every figure — current or comparison — clicks through to the transactions
 * behind it.
 */

const BASIS_KEY = 'reportsComparisonBasis';

/**
 * The app's chart colours for the two sides of the money — as on every other
 * report, and now literally so: these were a local pair of hexes that happened
 * to match four other files, which is how a second definition of income and
 * expense stays in step until the day it doesn't.
 */
const INCOME_FILL = SEMANTIC_SERIES.income;
const EXPENSE_FILL = SEMANTIC_SERIES.expense;
/** The comparison window is deliberately colourless: it is the yardstick, not the news. */
const COMPARISON_FILL = '#94A3B8';

const formatWindow = (window: { from: Date; to: Date }): string => {
  const short = (date: Date): string =>
    date.toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
  return `${short(window.from)} – ${short(window.to)}`;
};

export default function PeriodComparisonReport({ picker }: ReportViewProps): React.JSX.Element {
  const selection = useReportAccountSelection();
  const { accounts, categories, accountTransactions, transactionSplits, rows, flows, convert } =
    useReportDataset(picker, selection.scope);
  const { formatCurrency } = useCurrencyDecimal();
  // Recharts' default tooltip is black-on-white whatever the mode.
  const chartTooltipStyle = useChartTooltipStyle();
  const chartTooltipItemStyle = useChartTooltipItemStyle();
  const [drill, setDrill] = useState<ReportDrillTarget | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [basis, setBasis] = useState<ComparisonBasis>(() =>
    preferences.getItem(BASIS_KEY) === 'same-period-last-year' ? 'same-period-last-year' : 'previous-period'
  );

  /**
   * A tax year has no "period before" worth reading: the window runs from
   * 6 April to today, so the equal-length window before it is a rump of the
   * PREVIOUS tax year — a few months, ending mid-year, that no one filed
   * anything against. The only honest comparison is the same dates a year
   * earlier, so that is the only one offered, and the only one used, while
   * the tax year is the selected period — whatever the user chose before.
   * Their choice is kept, not overwritten, and applies again the moment they
   * pick another period.
   */
  const taxYearSelected = picker.period === 'tax-year';
  const effectiveBasis: ComparisonBasis = taxYearSelected ? 'same-period-last-year' : basis;

  const handleBasis = (next: ComparisonBasis): void => {
    setBasis(next);
    preferences.setItem(BASIS_KEY, next);
  };

  const ranges = useMemo(
    () => resolveComparisonRanges(picker.range, effectiveBasis),
    [picker.range, effectiveBasis]
  );

  // BOTH windows are measured from the resolved bounds, so the two figures
  // are always like for like.
  const currentFlows = useMemo(
    () => (ranges ? computeIncomeExpense(accountTransactions, transactionSplits, categories, { ...ranges.current, convert }) : null),
    [ranges, accountTransactions, transactionSplits, categories, convert]
  );
  const previousFlows = useMemo(
    () => (ranges ? computeIncomeExpense(accountTransactions, transactionSplits, categories, { ...ranges.previous, convert }) : null),
    [ranges, accountTransactions, transactionSplits, categories, convert]
  );

  const comparison = useMemo(
    () => (currentFlows && previousFlows ? buildPeriodComparison(currentFlows, previousFlows, categories, convert) : null),
    [currentFlows, previousFlows, categories, convert]
  );

  /**
   * Categories that carried money BOTH ways in these two windows. A
   * direction-neutral ('both') category — "Account Adjustments" ships as one —
   * is filed by the money's own direction, so it has a row per side and its
   * name alone no longer says which row you are looking at.
   */
  const twoSidedCategories = useMemo(() => {
    const sideSeen = new Map<string, 'income' | 'expense'>();
    const bothSides = new Set<string>();
    for (const row of comparison?.categories ?? []) {
      const seen = sideSeen.get(row.categoryId);
      if (seen === undefined) sideSeen.set(row.categoryId, row.bucket);
      else if (seen !== row.bucket) bothSides.add(row.categoryId);
    }
    return bothSides;
  }, [comparison]);

  /**
   * The row's name, saying which side it is only where that is ambiguous —
   * the table already prints the side beside every name, but a chart tick and
   * a drill-in title have nothing else to tell two rows of one category apart,
   * and colour alone is not a label.
   */
  const labelOf = useCallback(
    (row: ComparisonCategoryRow): string =>
      twoSidedCategories.has(row.categoryId)
        ? `${row.name} (${row.bucket === 'income' ? 'income' : 'expenses'})`
        : row.name,
    [twoSidedCategories]
  );

  const chartData = useMemo(
    () => (comparison ? comparison.categories.slice(0, 10).map(row => ({
      // `rowId`, never `key`: recharts spreads datum fields onto React
      // elements and a `key` field collides with React's reserved prop.
      rowId: row.rowId,
      name: labelOf(row),
      bucket: row.bucket,
      current: row.current,
      previous: row.previous,
    })) : []),
    [comparison, labelOf]
  );

  // The legend names only the colours actually on the chart: a bar is green
  // because it is income and red because it is spending, so a single swatch
  // for "This period" would be a colour no bar ever has.
  const legendEntries = useMemo(() => {
    const entries: Array<{ label: string; colour: string }> = [];
    if (chartData.some(row => row.bucket === 'income')) {
      entries.push({ label: 'This period — income', colour: INCOME_FILL });
    }
    if (chartData.some(row => row.bucket === 'expense')) {
      entries.push({ label: 'This period — expenses', colour: EXPENSE_FILL });
    }
    entries.push({ label: COMPARISON_BASIS_LABELS[effectiveBasis], colour: COMPARISON_FILL });
    return entries;
  }, [chartData, effectiveBasis]);

  const drillIntoCategory = (row: ComparisonCategoryRow, window: 'current' | 'previous'): void => {
    const source = window === 'current' ? currentFlows : previousFlows;
    if (!source || !ranges) return;
    const sideRows = row.bucket === 'income' ? source.incomeRows : source.expenseRows;
    setDrill({
      title: `${labelOf(row)} — ${formatWindow(window === 'current' ? ranges.current : ranges.previous)}`,
      bucket: row.bucket,
      rows: sideRows.filter(t => t.category === row.categoryId),
      total: window === 'current' ? row.current : row.previous,
    });
  };

  const drillIntoSide = (bucket: 'income' | 'expense', window: 'current' | 'previous', total: number): void => {
    const source = window === 'current' ? currentFlows : previousFlows;
    if (!source || !ranges) return;
    setDrill({
      title: `${bucket === 'income' ? 'Income' : 'Expenses'} — ${formatWindow(window === 'current' ? ranges.current : ranges.previous)}`,
      bucket,
      rows: bucket === 'income' ? source.incomeRows : source.expenseRows,
      total,
    });
  };

  const money = (value: number): string =>
    formatCurrency(value);

  const percent = (figure: ComparisonFigure): string =>
    figure.changePercent === null
      ? figure.current === 0 ? '—' : 'new'
      : `${figure.changePercent > 0 ? '+' : ''}${formatDecimal(figure.changePercent, 1)}%`;

  /**
   * THE DELTA, SAID IN WORDS WHEN A SIGN WOULD LIE (Design's signed-label
   * ruling, 24 Aug).
   *
   * Against a NEGATIVE base — a deficit — the arithmetic is right and the
   * reading is wrong: a deficit shrinking by £23,006.66 printed
   * "+£23,006.66 · +10.0%", and "+10%" of a deficit sounds like more
   * deficit. The percentage is also 10% of what, exactly — a base the reader
   * would have to invert to make sense of.
   *
   * So against a deficit the pair is phrased rather than signed: the
   * magnitude, the direction as a WORD, and the percentage as the
   * improvement or worsening it actually is. The "was (£X)" line beneath
   * still anchors which period it moved from, so this line does not have to
   * name the window and risk naming it wrongly.
   *
   * Positive bases keep signs untouched — nothing reads awkwardly there,
   * and the ruling's carve-out is explicit that this is for DERIVED summary
   * figures only.
   */
  const deltaInWords = (figure: ComparisonFigure): React.JSX.Element => {
    const deficitBase = figure.previous < 0;
    if (!deficitBase || figure.change === 0 || figure.changePercent === null) {
      return (
        <>
          <span className={`font-semibold tabular-nums ${moveClass(figure.change, 'up')}`}>
            {figure.change > 0 ? '+' : ''}{money(figure.change)}
          </span>
          <span className="text-gray-400 dark:text-gray-500"> · {percent(figure)}</span>
        </>
      );
    }
    const improving = figure.change > 0;
    return (
      <>
        <span className={`font-semibold tabular-nums ${improving ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
          {money(Math.abs(figure.change))} {improving ? 'smaller' : 'larger'}
        </span>
        <span className="text-gray-400 dark:text-gray-500">
          {' '}· a {formatDecimal(Math.abs(figure.changePercent), 1)}%{' '}
          {improving ? 'improvement' : 'worsening'}
        </span>
      </>
    );
  };

  /** Green when the move is the good one: more income, or less spending. */
  const moveClass = (change: number, goodWhen: 'up' | 'down'): string => {
    if (change === 0) return 'text-gray-500 dark:text-gray-400';
    const good = goodWhen === 'up' ? change > 0 : change < 0;
    return good ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400';
  };

  // ≈ when a conversion is inside either window's figures (ruling §6.3).
  const approx = (currentFlows?.holdsForeign || previousFlows?.holdsForeign) ? '\u2248 ' : '';

  const summaryCard = (
    label: string,
    figure: ComparisonFigure,
    goodWhen: 'up' | 'down',
    bucket: 'income' | 'expense' | null
  ): React.JSX.Element => (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
      <p className="text-xs text-gray-500 uppercase tracking-wider font-medium">{label}</p>
      {bucket === null ? (
        <p className={`text-page font-bold mt-1 ${figure.current < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'}`}>
          {approx}{money(figure.current)}
        </p>
      ) : (
        <button
          type="button"
          onClick={() => drillIntoSide(bucket, 'current', figure.current)}
          className={`text-page font-bold mt-1 rounded hover:underline ${
            bucket === 'income' ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'
          }`}
          title={`${label} — view these transactions`}
        >
          {approx}{money(figure.current)}
        </button>
      )}
      <p className="text-sm mt-2">
        {figure.previous < 0 ? deltaInWords(figure) : (
          <>
            <span className={`font-semibold tabular-nums ${moveClass(figure.change, goodWhen)}`}>
              {figure.change > 0 ? '+' : ''}{money(figure.change)}
            </span>
            <span className="text-gray-400 dark:text-gray-500"> · {percent(figure)}</span>
          </>
        )}
      </p>
      <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
        {bucket === null ? (
          <>was {money(figure.previous)}</>
        ) : (
          <button
            type="button"
            onClick={() => drillIntoSide(bucket, 'previous', figure.previous)}
            className="rounded hover:underline"
            title="View the comparison period's transactions"
          >
            was {money(figure.previous)}
          </button>
        )}
      </p>
    </div>
  );

  return (
    <div className="max-w-[var(--report-max,1400px)] mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <ReportAccountMultiSelect accounts={accounts} selection={selection} />
          <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-0.5">
            {(Object.keys(COMPARISON_BASIS_LABELS) as ComparisonBasis[]).map(value => {
              // Left focusable rather than `disabled`, so the reason is
              // reachable by keyboard and screen reader instead of being a
              // control that simply stops existing.
              const unavailable = taxYearSelected && value === 'previous-period';
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => { if (!unavailable) handleBasis(value); }}
                  aria-pressed={effectiveBasis === value}
                  aria-disabled={unavailable || undefined}
                  title={unavailable ? 'Tax year compares with the same period last year' : undefined}
                  className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                    unavailable
                      ? 'text-gray-400 dark:text-gray-600 cursor-not-allowed'
                      : effectiveBasis === value
                        ? 'bg-[#1a2332] dark:bg-[#2d3a4d] text-white'
                        : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                  }`}
                >
                  {COMPARISON_BASIS_LABELS[value]}
                </button>
              );
            })}
          </div>
        </div>
        <ReportExportBar
          title="Period comparison"
          dateRange={PERIOD_LABELS[picker.period]}
          rows={rows}
          flows={flows}
          categories={categories}
          accounts={accounts}
          charts={[chartRef]}
        />
      </div>

      {ranges === null || comparison === null ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-10 text-center">
          <p className="text-gray-500 dark:text-gray-400">
            This report needs a period with a start date to compare against.
          </p>
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-2">
            Choose any period other than All time — this month, last month, the tax year, twelve months, or a custom range.
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            <span className="font-medium text-gray-700 dark:text-gray-300">{formatWindow(ranges.current)}</span>
            {' compared with '}
            <span className="font-medium text-gray-700 dark:text-gray-300">{formatWindow(ranges.previous)}</span>
            {taxYearSelected && (
              <span className="block text-xs text-gray-400 dark:text-gray-500 mt-1">
                A tax year is compared with the same period a year earlier — the months before 6 April
                belong to a different tax year, so they are not a period to compare against.
              </span>
            )}
          </p>

          <UncategorisedReviewBand flows={flows} categories={categories} />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {summaryCard('Income', comparison.income, 'up', 'income')}
            {summaryCard('Expenses', comparison.expenses, 'down', 'expense')}
            {summaryCard('Left over', comparison.net, 'up', null)}
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
            <h2 className="text-card font-semibold text-theme-heading dark:text-white mb-1">
              Biggest movers
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              The categories that changed most between the two periods.
            </p>
            {chartData.length === 0 ? (
              <p className="text-center py-16 text-gray-400">Nothing categorised in either period</p>
            ) : (
              <div className="h-96" ref={chartRef}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(107, 114, 128, 0.2)" horizontal={false} />
                    <XAxis
                      type="number"
                      tick={{ fill: '#6B7280', fontSize: 12 }}
                      tickFormatter={(value: number) => formatDecimal(value, 0)}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={170}
                      tick={{ fill: '#6B7280', fontSize: 12 }}
                      interval={0}
                    />
                    <Tooltip
                  contentStyle={chartTooltipStyle} itemStyle={chartTooltipItemStyle} separator=": "
                      formatter={(value: number | string) =>
                        formatCurrency(typeof value === 'number' ? value : Number(value))
                      }
                        />
                    {/* Recharts derives its own legend from each series' single
                        fill, which this chart does not have — so the legend is
                        drawn from what the bars actually are. */}
                    <Legend
                      content={() => (
                        <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 pt-2 text-xs text-gray-600 dark:text-gray-300">
                          {legendEntries.map(entry => (
                            <li key={entry.label} className="flex items-center gap-1.5">
                              <span
                                aria-hidden="true"
                                className="inline-block w-2.5 h-2.5 rounded-sm"
                                style={{ backgroundColor: entry.colour }}
                              />
                              {entry.label}
                            </li>
                          ))}
                        </ul>
                      )}
                    />
                    <Bar dataKey="current" name="This period" radius={[0, 3, 3, 0]} isAnimationActive={false}>
                      {chartData.map(entry => (
                        <Cell
                          key={entry.rowId}
                          fill={entry.bucket === 'income' ? INCOME_FILL : EXPENSE_FILL}
                        />
                      ))}
                    </Bar>
                    <Bar dataKey="previous" name={COMPARISON_BASIS_LABELS[effectiveBasis]} fill={COMPARISON_FILL} radius={[0, 3, 3, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700">
            <div className="p-6 pb-3">
              <h2 className="text-card font-semibold text-theme-heading dark:text-white">Category by category</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Click either figure to see the transactions behind it.
              </p>
            </div>
            {comparison.categories.length === 0 ? (
              <p className="text-center py-16 text-gray-400">Nothing categorised in either period</p>
            ) : (
              /* The table scrolls inside its own box; the page never scrolls sideways. */
              <div className="overflow-x-auto rounded-b-2xl">
                <table className="min-w-full text-sm">
                  <caption className="sr-only">Each category in both periods, with the change between them</caption>
                  <thead className="bg-gray-50 dark:bg-gray-700/50">
                    <tr>
                      <th scope="col" className="px-6 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 min-w-[220px]">
                        Category
                      </th>
                      <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                        This period
                      </th>
                      <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 min-w-[130px]">
                        {COMPARISON_BASIS_LABELS[effectiveBasis]}
                      </th>
                      <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                        Change
                      </th>
                      <th scope="col" className="px-6 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                        %
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.categories.map(row => (
                      /* A category filed BOTH ways has a row per side, so the
                         side is part of what identifies the row. */
                      <tr key={row.rowId} className="border-t border-gray-50 dark:border-gray-700/50">
                        <th scope="row" className="px-6 py-2 text-left font-normal">
                          <span className="text-sm text-gray-900 dark:text-white">{row.name}</span>
                          <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                            {row.bucket === 'income' ? 'income' : 'expense'}
                          </span>
                        </th>
                        <td className="px-3 py-2 text-sm text-right">
                          <button
                            type="button"
                            onClick={() => drillIntoCategory(row, 'current')}
                            className="w-full justify-end text-right rounded px-1 -mx-1 tabular-nums text-gray-900 dark:text-white hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:underline"
                            title={`${labelOf(row)}, this period — view these transactions`}
                          >
                            {money(row.current)}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-sm text-right">
                          <button
                            type="button"
                            onClick={() => drillIntoCategory(row, 'previous')}
                            className="w-full justify-end text-right rounded px-1 -mx-1 tabular-nums text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:underline"
                            title={`${labelOf(row)}, comparison period — view these transactions`}
                          >
                            {money(row.previous)}
                          </button>
                        </td>
                        <td className={`px-3 py-2 text-sm text-right font-medium tabular-nums ${
                          moveClass(row.change, row.bucket === 'income' ? 'up' : 'down')
                        }`}>
                          {row.change > 0 ? '+' : ''}{money(row.change)}
                        </td>
                        <td className="px-6 py-2 text-sm text-right tabular-nums text-gray-500 dark:text-gray-400">
                          {percent(row)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <ReportDrillModal target={drill} onClose={() => setDrill(null)} categories={categories} />
    </div>
  );
}
