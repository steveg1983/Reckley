import React, { useMemo, useRef, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts';
import { useCurrencyDecimal } from '../../hooks/useCurrencyDecimal';
import { useReportDataset } from '../../hooks/useReportDataset';
import { useReportAccountSelection } from '../../hooks/useReportAccountSelection';
import ReportAccountMultiSelect from '../../components/reports/ReportAccountMultiSelect';
import ReportDrillModal, { type ReportDrillTarget } from '../../components/reports/ReportDrillModal';
import ReportExportBar from '../../components/reports/ReportExportBar';
import UncategorisedReviewBand from '../../components/reports/UncategorisedReviewBand';
import { buildPayeeTotals, payeeKeyOf, NO_PAYEE_KEY, type PayeeTotalRow } from '../../utils/spendingByPayee';
import { formatDecimal } from '../../utils/decimal-format';
import { PERIOD_LABELS } from '../../hooks/usePeriod';
import type { ReportViewProps } from './types';
import { preferences } from '../../services/preferencesService';
import { categoricalColor, useCategoricalRamp, useChartTooltipStyle, useChartTooltipItemStyle } from '../../components/charts/chartColors';
import { getDateLocale } from '../../utils/dateFormatter';
import { formatCount } from '../../utils/localeFormat';

/**
 * "Spending by payee" — who the money actually went to.
 *
 * Payee identity uses the same normalisation as the app's payee memory and
 * the import prefill, so "the same payee" means the same thing here as it
 * does when a bulk categorisation is remembered. The income side answers the
 * other half of the question: who pays you.
 *
 * Rows are already classified by `computeIncomeExpense` — transfers and
 * uncategorised rows never reach either side.
 */

/** Bars beyond this stop being readable; the table still lists every payee. */
const CHART_ROWS = 12;

const SIDE_KEY = 'reportsPayeeSide';

export default function SpendingByPayeeReport({ picker }: ReportViewProps): React.JSX.Element {
  // The shared ramp. CHART_ROWS is twelve, so colours repeat past the fifth
  // bar — readable here because a bar is labelled on its own axis, unlike a
  // pie slice.
  const ramp = useCategoricalRamp();
  const selection = useReportAccountSelection();
  const { accounts, categories, rows, flows, convert } = useReportDataset(picker, selection.scope);
  const { formatCurrency } = useCurrencyDecimal();
  // Recharts' default tooltip is black-on-white whatever the mode.
  const chartTooltipStyle = useChartTooltipStyle();
  const chartTooltipItemStyle = useChartTooltipItemStyle();
  const [drill, setDrill] = useState<ReportDrillTarget | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<'expense' | 'income'>(() =>
    preferences.getItem(SIDE_KEY) === 'income' ? 'income' : 'expense'
  );
  const handleSide = (next: 'expense' | 'income'): void => {
    setSide(next);
    preferences.setItem(SIDE_KEY, next);
  };

  const sideRows = side === 'income' ? flows.incomeRows : flows.expenseRows;
  const totals = useMemo(
    () => buildPayeeTotals(sideRows, side, categories, convert),
    [sideRows, side, categories, convert]
  );

  // The datum fields are `payee`/`name`, never `key`: recharts spreads datum
  // fields onto React elements and a `key` field collides with React's
  // reserved prop, silently breaking rendering.
  const chartData = useMemo(
    () => totals.rows
      .filter(row => row.total > 0)
      .slice(0, CHART_ROWS)
      .map(row => ({ payee: row.payee, name: row.displayName, value: row.total })),
    [totals.rows]
  );

  const drillIntoPayee = (row: PayeeTotalRow): void => {
    setDrill({
      title: `${row.displayName} — ${PERIOD_LABELS[picker.period]}`,
      bucket: side,
      rows: sideRows.filter(t => payeeKeyOf(t.description) === row.payee),
      total: row.total,
    });
  };

  const drillIntoPayeeKey = (payee: string): void => {
    const row = totals.rows.find(candidate => candidate.payee === payee);
    if (row) drillIntoPayee(row);
  };

  const money = (value: number): string =>
    formatCurrency(value);

  const sideLabel = side === 'income' ? 'Received from' : 'Paid to';

  return (
    <div className="max-w-[var(--report-max,1400px)] mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <ReportAccountMultiSelect accounts={accounts} selection={selection} />
          <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-0.5">
            {([['expense', 'Spending'], ['income', 'Income']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => handleSide(value)}
                aria-pressed={side === value}
                className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                  side === value
                    ? 'bg-[#1a2332] dark:bg-[#2d3a4d] text-white'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <ReportExportBar
          title="Spending by payee"
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
            {side === 'income' ? 'Biggest sources' : 'Biggest payees'}
          </h2>
          <span className={`text-card font-bold tabular-nums ${
            side === 'income' ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'
          }`}>
            {flows.holdsForeign ? '\u2248 ' : ''}{money(totals.total)}
          </span>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {PERIOD_LABELS[picker.period]} — click a bar, or any payee below, for the transactions behind it.
        </p>
        {chartData.length === 0 ? (
          <p className="text-center py-16 text-gray-400">
            No categorised {side === 'income' ? 'income' : 'spending'} in this period
          </p>
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
                <Bar
                  dataKey="value"
                  name={sideLabel}
                  radius={[0, 3, 3, 0]}
                  cursor="pointer"
                  isAnimationActive={false}
                  onClick={(entry) => {
                    const datum = ((entry as { payload?: typeof chartData[number] })?.payload ?? entry) as typeof chartData[number];
                    if (datum?.payee) drillIntoPayeeKey(datum.payee);
                  }}
                >
                  {chartData.map((entry, index) => (
                    <Cell key={entry.payee} fill={categoricalColor(ramp, index)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700">
        <div className="p-6 pb-3">
          <h2 className="text-card font-semibold text-theme-heading dark:text-white">Every payee</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Ranked by value, with the category each payee is usually filed under.
          </p>
        </div>
        {totals.rows.length === 0 ? (
          <p className="text-center py-16 text-gray-400">
            No categorised {side === 'income' ? 'income' : 'spending'} in this period
          </p>
        ) : (
          /* The table scrolls inside its own box; the page never scrolls sideways. */
          <div className="overflow-x-auto rounded-b-2xl">
            <table className="min-w-full text-sm">
              <caption className="sr-only">
                {side === 'income' ? 'Income' : 'Spending'} by payee for the selected period
              </caption>
              <thead className="bg-gray-50 dark:bg-gray-700/50">
                <tr>
                  <th scope="col" className="px-6 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 min-w-[200px]">
                    Payee
                  </th>
                  <th scope="col" className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 min-w-[180px]">
                    Usually filed as
                  </th>
                  <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Transactions
                  </th>
                  <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Last seen
                  </th>
                  <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Share
                  </th>
                  <th scope="col" className="px-6 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {totals.rows.map(row => (
                  <tr key={row.payee} className="border-t border-gray-50 dark:border-gray-700/50">
                    <th scope="row" className="px-6 py-2 text-left font-normal">
                      <button
                        type="button"
                        onClick={() => drillIntoPayee(row)}
                        className="text-sm text-gray-900 dark:text-white hover:underline rounded"
                        title={`${row.displayName} — view these transactions`}
                      >
                        {row.displayName}
                      </button>
                    </th>
                    <td className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                      {row.topCategoryName}
                    </td>
                    <td className="px-3 py-2 text-sm text-right tabular-nums text-gray-500 dark:text-gray-400">
                      {formatCount(row.count)}
                    </td>
                    <td className="px-3 py-2 text-sm text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">
                      {row.latest.toLocaleDateString(getDateLocale(), { day: '2-digit', month: 'short', year: '2-digit' })}
                    </td>
                    <td className="px-3 py-2 text-sm text-right tabular-nums text-gray-500 dark:text-gray-400">
                      {formatDecimal(row.share, 1)}%
                    </td>
                    <td className="px-6 py-2 text-sm text-right font-semibold tabular-nums text-gray-900 dark:text-white">
                      {money(row.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-gray-200 dark:border-gray-600">
                <tr>
                  <th scope="row" className="px-6 py-3 text-left text-sm font-semibold text-gray-900 dark:text-white">
                    Total
                  </th>
                  <td colSpan={4} />
                  <td className="px-6 py-3 text-sm text-right font-bold tabular-nums text-gray-900 dark:text-white">
                    {money(totals.total)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {totals.rows.some(row => row.payee === NO_PAYEE_KEY) && (
          <p className="px-6 pb-6 pt-3 text-xs text-gray-500 dark:text-gray-400">
            &ldquo;No payee recorded&rdquo; collects rows whose description is empty or a bank placeholder — they are
            counted, but they cannot be attributed to a merchant.
          </p>
        )}
      </div>

      <ReportDrillModal target={drill} onClose={() => setDrill(null)} categories={categories} />
    </div>
  );
}
