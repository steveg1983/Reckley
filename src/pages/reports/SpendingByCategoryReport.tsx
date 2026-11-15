import React, { useMemo, useRef, useState } from 'react';
import { ResponsiveContainer, PieChart as RechartsPieChart, Pie, Cell, Tooltip, Legend } from 'recharts';
import { useCurrencyDecimal } from '../../hooks/useCurrencyDecimal';
import { useReportDataset } from '../../hooks/useReportDataset';
import { useReportAccountSelection } from '../../hooks/useReportAccountSelection';
import ReportAccountMultiSelect from '../../components/reports/ReportAccountMultiSelect';
import ReportDrillModal, { type ReportDrillTarget } from '../../components/reports/ReportDrillModal';
import ReportExportBar from '../../components/reports/ReportExportBar';
import UncategorisedReviewBand from '../../components/reports/UncategorisedReviewBand';
import { computeExpenseCategoryNetTotals } from '../../utils/categoryNetting';
import { toDecimal } from '../../utils/decimal';
import { formatDecimal } from '../../utils/decimal-format';
import { ARRIVAL_ROW_CLASS, useArrivalRowFocus } from '../../hooks/useArrivalFocus';
import { PERIOD_LABELS } from '../../hooks/usePeriod';
import type { ReportViewProps } from './types';
import { capSeriesWithRemainder, categoricalColor, useCategoricalRamp, useChartTooltipStyle, useChartTooltipItemStyle } from '../../components/charts/chartColors';
import { legendText } from '../../components/charts/ChartLegendText';
import { formatCount } from '../../utils/localeFormat';

/**
 * "Spending by category" — where the money went, ranked.
 *
 * Money's netting semantics throughout (utils/categoryNetting): a row belongs
 * to a category's spend because of the CATEGORY's direction, never the
 * money's, so a refund filed against an expense category reduces that
 * category instead of appearing as income. Every slice and every row clicks
 * through to the transactions behind it.
 */

export default function SpendingByCategoryReport({ picker, focus }: ReportViewProps): React.JSX.Element {
  // The shared ramp — five per theme, and the ring draws exactly five slices
  // (capSeriesWithRemainder), so no slice ever repeats a colour. This chart
  // used to draw eight with no remainder: a CLOSED ring showing roughly half
  // the period's total, with three colours repeated (Design, 23 Aug §3).
  const ramp = useCategoricalRamp();
  const selection = useReportAccountSelection();
  // A slice clicked on the Dashboard's Expense Categories card names a
  // category; its row in the ranked table below is highlighted and scrolled to,
  // where the share, the count and the way into its transactions all are.
  const categoryFocus = useArrivalRowFocus(focus);
  const { accounts, categories, rows, flows, convert } = useReportDataset(picker, selection.scope);
  const { formatCurrency } = useCurrencyDecimal();
  // Recharts' default tooltip is black-on-white whatever the mode.
  const chartTooltipStyle = useChartTooltipStyle();
  const chartTooltipItemStyle = useChartTooltipItemStyle();
  const [drill, setDrill] = useState<ReportDrillTarget | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  // Shared implementation — the same totals the Dashboard widget and the PDF
  // export use, so the three can never drift.
  const totals = useMemo(
    () => computeExpenseCategoryNetTotals(rows, categories, convert),
    [rows, categories, convert]
  );

  const counts = useMemo(() => {
    const byCategory = new Map<string, number>();
    for (const row of flows.expenseRows) {
      byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1);
    }
    return byCategory;
  }, [flows.expenseRows]);

  const listedTotal = useMemo(
    () => totals.reduce((sum, entry) => sum.plus(toDecimal(entry.value)), toDecimal(0)),
    [totals]
  );

  // The datum field is `categoryId`, NOT `key`: recharts spreads datum fields
  // onto React elements and a `key` field collides with React's reserved prop,
  // silently breaking sector rendering. The remainder slice has no categoryId
  // — clicking it drills into the folded categories together (see below).
  const pieData = useMemo(
    () =>
      capSeriesWithRemainder(
        totals,
        entry => entry.value,
        entry => entry.name,
        'categories'
      ).map(({ name, value, source }) => ({ categoryId: source?.key, name, value })),
    [totals]
  );

  const drillIntoCategory = (categoryId: string, name: string, value: number): void => {
    setDrill({
      title: `${name} — ${PERIOD_LABELS[picker.period]}`,
      bucket: 'expense',
      rows: flows.expenseRows.filter(t => t.category === categoryId),
      total: value,
    });
  };

  // The remainder is still a slice of real money, so it still answers a click
  // ("click a slice for the transactions behind it" is the card's promise):
  // the drill holds every FOLDED category's rows together — the categories in
  // `totals` beyond the shown four, not every unshown row (a category netted
  // to zero by refunds is listed nowhere and belongs behind no slice).
  const drillIntoRemainder = (name: string, value: number): void => {
    const shown = new Set(pieData.map(d => d.categoryId).filter(Boolean));
    const folded = new Set(totals.map(t => t.key).filter(key => !shown.has(key)));
    setDrill({
      title: `${name} — ${PERIOD_LABELS[picker.period]}`,
      bucket: 'expense',
      rows: flows.expenseRows.filter(t => folded.has(t.category)),
      total: value,
    });
  };

  const shareOf = (value: number): string =>
    listedTotal.isZero() ? '—' : `${formatDecimal(toDecimal(value).dividedBy(listedTotal).times(100), 1)}%`;

  // Categories whose refunds cancelled their spending net to zero or less and
  // cannot be listed — say so rather than let the reader assume the rows add
  // up to the period's total.
  const netted = flows.expenses.greaterThan(0) && !listedTotal.equals(flows.expenses);

  /**
   * When the fold outweighs the largest named slice, the ring is the wrong
   * instrument (Design ruling, 24 Aug §2): the spend simply isn't
   * concentrated, so a top-4-plus-remainder ring is one enormous quiet wedge
   * and four slivers — and quietest-step placement assumes the fold is the
   * TAIL. Say the shape of the data instead and let the table do the work
   * it already does well. Same rule as "one point is not a time series",
   * one dimension over.
   */
  const fold = pieData.find(d => !d.categoryId);
  const largestNamed = pieData.find(d => d.categoryId);
  // >= — ties count as dominance (Design, 24 Aug §4): a fold as big as the
  // biggest category is already not a tail.
  const spreadNote = fold && largestNamed && fold.value >= largestNamed.value
    ? { count: totals.length, name: largestNamed.name, share: shareOf(largestNamed.value) }
    : null;

  return (
    <div className="max-w-[var(--report-max,1400px)] mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ReportAccountMultiSelect accounts={accounts} selection={selection} />
        <ReportExportBar
          title="Spending by category"
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
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
          <h2 className="text-card font-semibold text-theme-heading dark:text-white">
            Where the money went
          </h2>
          <span className="text-card font-bold tabular-nums text-red-600 dark:text-red-400">
            {flows.holdsForeign ? '\u2248 ' : ''}{formatCurrency(flows.expenses)}
          </span>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {PERIOD_LABELS[picker.period]}{spreadNote ? '' : ' — click a slice for the transactions behind it.'}
        </p>
        {pieData.length === 0 ? (
          <p className="text-center py-16 text-gray-400">No categorised spending in this period</p>
        ) : spreadNote ? (
          <p className="text-body text-gray-600 dark:text-gray-300" data-testid="spending-spread-note">
            Spending is spread across {formatCount(spreadNote.count)} categories — the
            largest, {spreadNote.name}, is {spreadNote.share} of the total. Every category
            is ranked in the table below.
          </p>
        ) : (
          <div className="h-80" ref={chartRef}>
            <ResponsiveContainer width="100%" height="100%">
              <RechartsPieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="55%"
                  outerRadius="85%"
                  strokeWidth={0}
                  isAnimationActive={false}
                  cursor="pointer"
                  onClick={(entry) => {
                    const datum = ((entry as { payload?: typeof pieData[number] })?.payload ?? entry) as typeof pieData[number];
                    if (!datum) return;
                    if (datum.categoryId) drillIntoCategory(datum.categoryId, datum.name, datum.value);
                    else drillIntoRemainder(datum.name, datum.value);
                  }}
                >
                  {pieData.map((entry, index) => (
                    // The remainder has no categoryId; its label is unique.
                    <Cell key={entry.categoryId ?? entry.name} fill={categoricalColor(ramp, index)} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={chartTooltipStyle} itemStyle={chartTooltipItemStyle} separator=": "
                  formatter={(value: number | string) =>
                    formatCurrency(typeof value === 'number' ? value : Number(value))
                  }
                />
                {/* itemSorter: recharts' default ('value' — the LABEL, for a
                    pie) alphabetises the legend, which floated "N smaller
                    categories" above the real ones. A constant sorter keeps
                    payload order: rank order, the fold last — the same order
                    the ring is painted in. */}
                {/* iconSize 16: the ramp's neighbours need a swatch big
                    enough to tell apart — at recharts' default the named
                    slates read as two tones (Design §11, landed 24 Aug). */}
                <Legend layout="vertical" align="right" verticalAlign="middle" formatter={legendText} itemSorter={() => 0} iconSize={16} />
              </RechartsPieChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700">
        <div className="p-6 pb-3">
          <h2 className="text-card font-semibold text-theme-heading dark:text-white">Every category</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Ranked by spend. Click any category to see its transactions.
          </p>
        </div>
        {totals.length === 0 ? (
          <p className="text-center py-16 text-gray-400">No categorised spending in this period</p>
        ) : (
          /* The table scrolls inside its own box; the page never scrolls sideways. */
          <div className="overflow-x-auto rounded-b-2xl">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Spending by category for the selected period</caption>
              <thead className="bg-gray-50 dark:bg-gray-700/50">
                <tr>
                  <th scope="col" className="px-6 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 min-w-[220px]">
                    Category
                  </th>
                  <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Transactions
                  </th>
                  <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Share
                  </th>
                  <th scope="col" className="px-6 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Spent
                  </th>
                </tr>
              </thead>
              <tbody>
                {totals.map(entry => (
                  <tr
                    key={entry.key}
                    ref={categoryFocus.isFocused(entry.key) ? categoryFocus.focusRef : undefined}
                    aria-current={categoryFocus.isFocused(entry.key) ? 'true' : undefined}
                    className={`border-t border-gray-50 dark:border-gray-700/50 ${
                      categoryFocus.isFocused(entry.key) ? ARRIVAL_ROW_CLASS : ''
                    }`}
                  >
                    <th scope="row" className="px-6 py-2 text-left font-normal">
                      <button
                        type="button"
                        onClick={() => drillIntoCategory(entry.key, entry.name, entry.value)}
                        className="text-sm text-gray-900 dark:text-white hover:underline rounded"
                        title={`${entry.name} — view these transactions`}
                      >
                        {entry.name}
                      </button>
                    </th>
                    <td className="px-3 py-2 text-sm text-right tabular-nums text-gray-500 dark:text-gray-400">
                      {formatCount(counts.get(entry.key) ?? 0)}
                    </td>
                    <td className="px-3 py-2 text-sm text-right tabular-nums text-gray-500 dark:text-gray-400">
                      {shareOf(entry.value)}
                    </td>
                    <td className="px-6 py-2 text-sm text-right font-semibold tabular-nums text-gray-900 dark:text-white">
                      {formatCurrency(entry.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-gray-200 dark:border-gray-600">
                <tr>
                  <th scope="row" className="px-6 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
                    Total listed
                  </th>
                  <td />
                  <td />
                  <td className="px-6 py-3 text-sm text-right font-bold tabular-nums text-gray-900 dark:text-white">
                    {formatCurrency(listedTotal.toNumber())}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {netted && (
          <p className="px-6 pb-6 pt-3 text-xs text-gray-500 dark:text-gray-400">
            Total spending for the period is {formatCurrency(flows.expenses)}. The difference is categories whose
            refunds cancelled their spending — they net to zero or less, so they are not listed above.
          </p>
        )}
      </div>

      <ReportDrillModal target={drill} onClose={() => setDrill(null)} categories={categories} />
    </div>
  );
}
