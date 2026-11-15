import React from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  BarChart,
  Bar,
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import { capSeriesWithRemainder, categoricalColor, categoricalRamp, useIsDarkGround, useChartTooltipStyle, useChartTooltipItemStyle } from './charts/chartColors';
import { legendText } from './charts/ChartLegendText';
import { lineMarkers, seriesWash, seriesWashFill } from './charts/richLine';
import { formatDecimal } from '../utils/decimal-format';
import type { CustomReport, ReportComponent } from './CustomReportBuilder';
import { formatShortDate } from '../utils/dateFormatter';
import { formatCount } from '../utils/localeFormat';

/**
 * Renders a generated custom report. Until now "Generate" computed the data
 * and then only showed a toast — there was nothing to look at. Each component
 * type maps to the same chart vocabulary the rest of the app uses (recharts,
 * one library), and every figure comes from customReportService's generators,
 * which classify through the shared category semantics.
 */

export interface GeneratedReport {
  report: CustomReport;
  dateRange: { startDate: Date; endDate: Date };
  data: Record<string, unknown>;
  /** True when the flows seam applied a conversion factor — the ≈ gate. */
  holdsForeign: boolean;
}

interface ChartSeries {
  labels: string[];
  datasets: Array<{ label: string; data: number[]; borderColor?: string; backgroundColor?: string }>;
}

/**
 * Namespaces a custom report's washes, since a generated report renders every
 * component on one page and each wash lands in the same document. The
 * component id completes it; the builder can seed an EMPTY id, which is
 * harmless here — the gradient's identity is its colour, so two components
 * that collide collide on an identical definition (charts/richLine).
 */
const CHART_KEY_PREFIX = 'custom-report-';

const compactTick = (value: number): string => {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${formatDecimal(abs / 1_000_000, 1)}M`;
  if (abs >= 1_000) return `${sign}${formatDecimal(abs / 1_000, 0)}K`;
  return formatDecimal(value, 0);
};

/** Chart.js-shaped {labels, datasets} → recharts' row-per-label form. */
function toRows(series: ChartSeries): Array<Record<string, string | number>> {
  return series.labels.map((label, i) => {
    const row: Record<string, string | number> = { label };
    series.datasets.forEach(ds => { row[ds.label] = ds.data[i] ?? 0; });
    return row;
  });
}

export default function CustomReportViewer({
  generated,
  onClose,
}: {
  generated: GeneratedReport;
  onClose: () => void;
}): React.JSX.Element {
  const { formatCurrency } = useCurrencyDecimal();
  const { report, dateRange, data } = generated;
  // One ramp for every chart in the app. The eight-colour array that used to
  // sit at the top of this file put an emerald and a red in a CATEGORICAL
  // list, inches from figures where those two hues mean income and expense.
  // ONE reading of the ground per render: the ramp picks the strokes and the
  // wash picks its strength from the same boolean, so they cannot disagree.
  const isDark = useIsDarkGround();
  const ramp = categoricalRamp(isDark);
  // The house tooltip surface — these three charts were the last still
  // showing recharts' bare white box (glaring on a dark card), with item
  // rows in whatever colour each series happened to be.
  const chartTooltipStyle = useChartTooltipStyle();
  const chartTooltipItemStyle = useChartTooltipItemStyle();

  const money = (v: number | string): string =>
    formatCurrency(typeof v === 'number' ? v : Number(v));

  const widthClass = (width: ReportComponent['width']): string =>
    width === 'full' ? 'lg:col-span-3' : width === 'half' ? 'lg:col-span-2' : 'lg:col-span-1';

  const renderComponent = (component: ReportComponent): React.ReactNode => {
    const componentData = data[component.id];
    if (componentData === undefined || componentData === null) {
      return <p className="text-sm text-gray-400">No data</p>;
    }

    switch (component.type) {
      case 'summary-stats': {
        const stats = componentData as Record<string, number>;
        const entries = Object.entries(stats);
        if (entries.length === 0) return <p className="text-sm text-gray-400">No data</p>;
        return (
          <div className="grid grid-cols-2 gap-3">
            {entries.map(([key, value]) => (
              <div key={key}>
                <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim()}
                </p>
                <p className="text-lg font-semibold text-gray-900 dark:text-white tabular-nums">
                  {/count|Count/.test(key)
                    ? formatCount(value)
                    // ≈ on converted money figures — the hub's basis line
                    // states the mechanism; the mark says which figures it
                    // reached. Rates and counts are not money.
                    : `${generated.holdsForeign && !/[Rr]ate/.test(key) ? '≈ ' : ''}${money(value)}`}
                </p>
              </div>
            ))}
          </div>
        );
      }

      case 'line-chart':
      case 'bar-chart': {
        const series = componentData as ChartSeries;
        if (!series.labels?.length) return <p className="text-sm text-gray-400">No data</p>;
        const rows = toRows(series);
        const isLine = component.type === 'line-chart';
        // A dataset may carry its own colour from the builder; otherwise it
        // takes its step of the shared ramp. Read through one function so the
        // stroke and the wash derived from it cannot disagree.
        const seriesColour = (index: number): string =>
          series.datasets[index]?.borderColor ?? categoricalColor(ramp, index);
        const washed = isLine && series.datasets.length === 1;
        return (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              {isLine ? (
                /* ComposedChart rather than LineChart because a report with a
                   SINGLE series draws it washed (charts/richLine), and a wash
                   is an <Area>. Two or more series keep the bare line: stacked
                   washes mix into a colour the ramp never ruled on, and the
                   ramp's own contrast figures are taken against the card. */
                <ComposedChart data={rows}>
                  {washed && seriesWash(`${CHART_KEY_PREFIX}${component.id}`, seriesColour(0), isDark)}
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(107, 114, 128, 0.2)" />
                  <XAxis dataKey="label" tick={{ fill: '#6B7280', fontSize: 11 }} minTickGap={24} />
                  <YAxis tick={{ fill: '#6B7280', fontSize: 11 }} tickFormatter={compactTick} width={56} />
                  <Tooltip formatter={money} contentStyle={chartTooltipStyle} itemStyle={chartTooltipItemStyle} separator=": " />
                  <Legend formatter={legendText} />
                  {series.datasets.map((ds, i) => washed ? (
                    <Area
                      key={ds.label}
                      type="monotone"
                      dataKey={ds.label}
                      stroke={seriesColour(i)}
                      strokeWidth={2}
                      fill={seriesWashFill(`${CHART_KEY_PREFIX}${component.id}`, seriesColour(i), isDark)}
                      fillOpacity={1}
                      {...lineMarkers(rows, seriesColour(i))}
                      isAnimationActive={false}
                    />
                  ) : (
                    <Line
                      key={ds.label}
                      type="monotone"
                      dataKey={ds.label}
                      stroke={seriesColour(i)}
                      strokeWidth={2}
                      {...lineMarkers(rows, seriesColour(i))}
                      isAnimationActive={false}
                    />
                  ))}
                </ComposedChart>
              ) : (
                <BarChart data={rows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(107, 114, 128, 0.2)" />
                  <XAxis dataKey="label" tick={{ fill: '#6B7280', fontSize: 11 }} minTickGap={24} />
                  <YAxis tick={{ fill: '#6B7280', fontSize: 11 }} tickFormatter={compactTick} width={56} />
                  <Tooltip formatter={money} contentStyle={chartTooltipStyle} itemStyle={chartTooltipItemStyle} separator=": " />
                  <Legend formatter={legendText} />
                  {series.datasets.map((ds, i) => (
                    <Bar
                      key={ds.label}
                      dataKey={ds.label}
                      fill={ds.backgroundColor ?? categoricalColor(ramp, i)}
                      radius={[3, 3, 0, 0]}
                      isAnimationActive={false}
                    />
                  ))}
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        );
      }

      case 'pie-chart': {
        const pie = componentData as { labels: string[]; data: number[] };
        if (!pie.labels?.length) return <p className="text-sm text-gray-400">No data</p>;
        // Ring and legend from ONE array, capped at what the ramp can colour.
        // The ring drew every label while the legend showed eight, so the two
        // disagreed about what existed and both repeated colours past the
        // fifth. See capSeriesWithRemainder.
        const rows = capSeriesWithRemainder(
          pie.labels.map((name, i) => ({ name, value: pie.data[i] ?? 0 })),
          (row) => row.value,
          (row) => row.name,
          'slices'
        );
        return (
          <div className="h-64 flex items-center gap-4">
            <div className="h-full flex-1 basis-0 min-w-[140px]">
              <ResponsiveContainer width="100%" height="100%">
                <RechartsPieChart>
                  <Pie data={rows} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="88%" strokeWidth={0} isAnimationActive={false}>
                    {rows.map((row, i) => (
                      <Cell key={row.name} fill={categoricalColor(ramp, i)} />
                    ))}
                  </Pie>
                  <Tooltip formatter={money} contentStyle={chartTooltipStyle} itemStyle={chartTooltipItemStyle} separator=": " />
                </RechartsPieChart>
              </ResponsiveContainer>
            </div>
            <ul className="w-44 space-y-1">
              {rows.map((row, i) => (
                <li key={row.name} className="flex items-center gap-2 text-xs">
                  {/* 16px swatch (Design §11): neighbouring ramp slates read
                      as one tone smaller. */}
                  <span className="w-4 h-4 rounded-sm flex-shrink-0" style={{ backgroundColor: categoricalColor(ramp, i) }} />
                  <span className="flex-1 min-w-0 truncate text-gray-600 dark:text-gray-300">{row.name}</span>
                  <span className="tabular-nums text-gray-900 dark:text-white">{money(row.value)}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      }

      case 'table': {
        const rows = componentData as Array<{
          date: string; description: string; category: string; account: string; amount: number;
        }>;
        if (rows.length === 0) return <p className="text-sm text-gray-400">No transactions</p>;
        return (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
                  <th className="text-left pb-2 font-medium">Date</th>
                  <th className="text-left pb-2 font-medium">Description</th>
                  <th className="text-left pb-2 font-medium">Category</th>
                  <th className="text-left pb-2 font-medium">Account</th>
                  <th className="text-right pb-2 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={`${row.date}-${i}`} className="border-b border-gray-50 dark:border-gray-700/50">
                    <td className="py-2 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{row.date}</td>
                    <td className="py-2 text-sm text-gray-900 dark:text-white">{row.description}</td>
                    <td className="py-2 text-sm text-gray-500 dark:text-gray-400">{row.category}</td>
                    <td className="py-2 text-sm text-gray-500 dark:text-gray-400">{row.account}</td>
                    <td className={`py-2 text-sm font-medium text-right tabular-nums ${
                      row.amount < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                    }`}>
                      {money(row.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }

      case 'text-block': {
        const block = componentData as { content: string };
        return <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{block.content}</p>;
      }

      default: {
        // category-breakdown and any future type: render its rows generically
        // rather than silently showing nothing.
        const rows = Array.isArray(componentData) ? componentData as Array<Record<string, unknown>> : [];
        if (rows.length === 0) return <p className="text-sm text-gray-400">No data</p>;
        return (
          <ul className="space-y-1">
            {/* not-a-charted-series: a plain list of rows, no ramp colour on
                it, so the palette's five-slice ceiling does not apply. */}
            {rows.slice(0, 10).map((row, i) => (
              <li key={i} className="flex items-center justify-between text-sm">
                <span className="text-gray-700 dark:text-gray-300 truncate">
                  {String(row.category ?? row.name ?? row.label ?? '—')}
                </span>
                <span className="tabular-nums text-gray-900 dark:text-white">
                  {typeof row.amount === 'number' ? money(row.amount)
                    : typeof row.spent === 'number' ? money(row.spent)
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        );
      }
    }
  };

  return (
    <div className="max-w-[var(--report-max,1400px)] mx-auto">
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">{report.name}</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {report.description ? `${report.description} · ` : ''}
            {formatShortDate(dateRange.startDate)} – {formatShortDate(dateRange.endDate)}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          Back to reports
        </button>
      </div>

      {report.components.length === 0 ? (
        <p className="text-center py-16 text-gray-400">This report has no components yet.</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {report.components.map(component => (
            <section
              key={component.id}
              className={`bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-6 ${widthClass(component.width)}`}
            >
              <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-4">
                {component.title}
              </h3>
              {renderComponent(component)}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
