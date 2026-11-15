import React, { useMemo, useState } from 'react';
import { useReportDataset } from '../hooks/useReportDataset';
import { useReportAccountSelection } from '../hooks/useReportAccountSelection';
import ReportAccountMultiSelect from '../components/reports/ReportAccountMultiSelect';
import ReportDrillModal, { type ReportDrillTarget } from '../components/reports/ReportDrillModal';
import ReportExportBar from '../components/reports/ReportExportBar';
import ReportCumulativeToggle from '../components/reports/ReportCumulativeToggle';
import IncomeExpenseSummaryCards from '../components/reports/IncomeExpenseSummaryCards';
import UncategorisedReviewBand from '../components/reports/UncategorisedReviewBand';
import TopTransactionsTable from '../components/reports/TopTransactionsTable';
import MonthlyIncomeExpenseMatrix, { type MatrixDrillTarget } from '../components/MonthlyIncomeExpenseMatrix';
import EditTransactionModal from '../components/EditTransactionModal';
import { buildMonthlyCategoryMatrix, monthKeyOf } from '../utils/monthlyCategoryMatrix';
import { toCumulativeMatrix } from '../utils/cumulativeSeries';
import { useCumulativeReport } from '../hooks/useCumulativeReport';
import { PERIOD_LABELS } from '../hooks/usePeriod';
import type { ReportViewProps } from './reports/types';
import { preferences } from '../services/preferencesService';

/**
 * "Monthly income and expenses" — the Microsoft Money report, and the
 * gallery's detailed read: every category down the side, the months of the
 * selected period across the top, with the four headline figures above it.
 *
 * The summary cards, the matrix and the review band are all built from ONE
 * classification pass (utils/incomeExpense via useReportDataset), so they
 * cannot disagree with each other or with any other report in the gallery.
 *
 * The trend chart and the category pie that used to share this page are now
 * reports of their own in the gallery ("Income and spending over time",
 * "Spending by category").
 */

const CUMULATIVE_KEY = 'reports.monthlyIncomeExpenses.cumulative.v1';

export default function Reports({ picker }: ReportViewProps): React.JSX.Element {
  const selection = useReportAccountSelection();
  const { accounts, categories, rows, flows, allTransactions, convert } = useReportDataset(picker, selection.scope);
  const [drill, setDrill] = useState<ReportDrillTarget | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Gains, losses & adjustments are net-worth movements, not day-to-day income
  // or spending — and a paper "gain" is not money received — so on this income &
  // expenditure report the revaluation line is opt-in and starts hidden. This
  // controls VISIBILITY only: the classifier keeps revaluations out of the
  // income/expense/net totals unconditionally, toggle or not.
  const [showRevaluations, setShowRevaluations] = useState<boolean>(
    () => preferences.getItem('reportsShowRevaluations') === '1'
  );
  const toggleRevaluations = (): void => {
    setShowRevaluations(prev => {
      preferences.setItem('reportsShowRevaluations', prev ? '0' : '1');
      return !prev;
    });
  };
  // Running totals across the period instead of month on its own — the matrix
  // only; the summary cards above it are whole-period figures either way.
  const cumulativeToggle = useCumulativeReport(CUMULATIVE_KEY);
  const { cumulative } = cumulativeToggle;

  // The Money-style category × month matrix, built from the SAME classified
  // rows as the summary cards so the two can never disagree.
  const matrix = useMemo(() => {
    const monthly = buildMonthlyCategoryMatrix(flows.incomeRows, flows.expenseRows, categories, picker.range, { convert });
    return cumulative ? toCumulativeMatrix(monthly) : monthly;
  }, [flows, categories, picker.range, cumulative, convert]);

  const firstColumnKey = matrix.months[0]?.key ?? null;

  const handleMatrixDrill = (target: MatrixDrillTarget): void => {
    const source = target.bucket === 'income' ? flows.incomeRows : flows.expenseRows;
    const ids = target.categoryIds ? new Set(target.categoryIds) : null;
    // A cumulative cell is the period up to that month, so its drill-in must
    // carry every month from the first column shown — the rows have to add up
    // to the figure that opened them.
    const inColumn = (date: Date | string): boolean => {
      if (target.monthKey === null) return true;
      const key = monthKeyOf(date);
      if (!cumulative) return key === target.monthKey;
      return key <= target.monthKey && (firstColumnKey === null || key >= firstColumnKey);
    };
    setDrill({
      title: target.label,
      bucket: target.bucket,
      rows: source.filter(t => (ids === null || ids.has(t.category)) && inColumn(t.date)),
      total: target.total,
    });
  };

  return (
    <div className="max-w-[var(--report-max,1400px)] mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <ReportAccountMultiSelect accounts={accounts} selection={selection} />
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={showRevaluations}
              onChange={toggleRevaluations}
              className="rounded border-gray-300 dark:border-gray-600"
            />
            Show gains, losses &amp; adjustments
          </label>
          <ReportCumulativeToggle toggle={cumulativeToggle} />
        </div>
        <ReportExportBar
          title="Monthly income and expenses"
          dateRange={PERIOD_LABELS[picker.period]}
          rows={rows}
          flows={flows}
          categories={categories}
          accounts={accounts}
        />
      </div>

      <IncomeExpenseSummaryCards flows={flows} categories={categories} showRevaluations={showRevaluations} />

      {/* Rows with no category are EXCLUDED from every figure above — said out
          loud, with the three ways to clear them. */}
      <UncategorisedReviewBand flows={flows} categories={categories} />

      {/* The detailed read. */}
      <MonthlyIncomeExpenseMatrix matrix={matrix} onDrill={handleMatrixDrill} cumulative={cumulative} />

      {/* The biggest REAL movements of the period — transfers and
          revaluations are neither income nor spending, so they never appear. */}
      <TopTransactionsTable rows={rows} categories={categories} onOpenTransaction={setEditingId} />

      <ReportDrillModal target={drill} onClose={() => setDrill(null)} categories={categories} />

      {/* A top transaction opens straight in the editor — a split line opens
          its PARENT, which is the real record. */}
      {editingId !== null && (
        <EditTransactionModal
          isOpen
          onClose={() => setEditingId(null)}
          transaction={allTransactions.find(t => t.id === editingId) ?? null}
        />
      )}
    </div>
  );
}
