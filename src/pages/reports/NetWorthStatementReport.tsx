import React, { useMemo, useState } from 'react';
import { useApp } from '../../contexts/AppContextSupabase';
import { useNetWorthConversion } from '../../hooks/useNetWorthConversion';
import { useHistoricalAccounts } from '../../hooks/useHistoricalAccounts';
import { useCurrencyDecimal } from '../../hooks/useCurrencyDecimal';
import ReportDrillModal, { type ReportDrillTarget } from '../../components/reports/ReportDrillModal';
import { buildAccountBalanceReport, movedSideLabel, resolveClosingSnapshot, type AccountBalanceRow } from '../../utils/accountBalanceReport';
import BalanceReportCurrencyNote from '../../components/reports/BalanceReportCurrencyNote';
import InvestmentBasisNote from '../../components/InvestmentBasisNote';
import { useInvestmentValuation } from '../../hooks/useInvestmentValuation';
import { PERIOD_LABELS } from '../../hooks/usePeriod';
import NetWorthSummary from '../../components/NetWorthSummary';
import type { ReportViewProps } from './types';
import { getDateLocale } from '../../utils/dateFormatter';
import { compareNames } from '../../utils/localeFormat';

/**
 * "Net worth" — the Microsoft Money statement: everything you own set
 * against everything you owe, at the end of the selected period, with the
 * move since the period opened.
 *
 * Shares its figures with the Account balances report and the net-worth chart
 * (utils/accountBalanceReport): opening balance + every transaction, Decimal
 * throughout, and an account counts as a liability when its BALANCE is
 * negative — an overdrawn current account is money owed, whatever its type
 * says.
 */
export default function NetWorthStatementReport({ picker }: ReportViewProps): React.JSX.Element {
  const { accounts: openAccounts, transactions, categories } = useApp();
  /**
   * Open AND closed (the owner's find, 27 Aug): he closed an account and its
   * whole 2006–2012 story vanished from this report while the net-worth
   * chart still counted it. This is a surface that walks HISTORY, so it
   * takes the same historical set as the chart; the builder drops closed
   * accounts the window never touched, so a today-window stays clean.
   */
  const accounts = useHistoricalAccounts(openAccounts);
  const closedAccountIds = useMemo(
    () => new Set(accounts.filter(a => a.isActive === false).map(a => a.id)),
    [accounts]
  );
  const { formatCurrency } = useCurrencyDecimal();
  const [drill, setDrill] = useState<ReportDrillTarget | null>(null);

  // The dated seam (balance reports' conversion, 23 Aug) — same terms as
  // the Account Balances report, from the same util. The CLOSING figures
  // take the snapshot basis (one-net-worth ruling, 24 Aug §1): the as-at
  // day's own rates, which as at today are the Accounts page's exact
  // factors — one answer to "what am I worth" on both surfaces.
  const { conversion, conversionAt } = useNetWorthConversion(accounts, { range: { from: null, to: null } });
  // The valuation term (slice 3b) — the same build every value surface takes.
  const valuation = useInvestmentValuation();
  const report = useMemo(
    () => buildAccountBalanceReport(
      accounts, transactions, picker.range, new Date(),
      conversionAt ?? undefined,
      resolveClosingSnapshot(picker.range, new Date(), conversion, conversionAt),
      valuation.deltaAt,
      closedAccountIds
    ),
    [accounts, transactions, picker.range, conversion, conversionAt, valuation, closedAccountIds]
  );
  const approx = report.holdsForeign ? '≈ ' : '';

  /** Which statement section each account sits under, e.g. "Savings". */
  const groupLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const group of report.groups) {
      for (const row of group.rows) labels.set(row.accountId, group.label);
    }
    return labels;
  }, [report.groups]);

  const sides = useMemo(() => {
    const byMagnitude = (a: AccountBalanceRow, b: AccountBalanceRow): number =>
      Math.abs(b.closing) - Math.abs(a.closing) ||
      compareNames(a.name, b.name);
    return {
      owned: report.rows.filter(row => row.closing > 0).sort(byMagnitude),
      owed: report.rows.filter(row => row.closing < 0).sort(byMagnitude),
    };
  }, [report.rows]);

  const drillIntoAccount = (row: AccountBalanceRow): void => {
    const rows = transactions
      .filter(t => t.accountId === row.accountId && picker.inRange(t.date))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    setDrill({
      title: `${row.name} — ${PERIOD_LABELS[picker.period]}`,
      bucket: 'neutral',
      rows,
      total: row.change,
    });
  };

  const money = (value: number, currency?: string): string =>
    formatCurrency(value, currency);

  const section = (
    title: string,
    rows: AccountBalanceRow[],
    total: number,
    emptyText: string
  ): React.JSX.Element => (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700">
      <div className="flex items-baseline justify-between gap-3 p-6 pb-3">
        <h2 className="text-card font-semibold text-theme-heading dark:text-white">{title}</h2>
        <span className="text-card font-bold tabular-nums text-gray-900 dark:text-white">
          {formatCurrency(total)}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="px-6 pb-6 text-sm text-gray-400">{emptyText}</p>
      ) : (
        <div className="overflow-x-auto rounded-b-2xl">
          <table className="min-w-full text-sm">
            <caption className="sr-only">{title} by account</caption>
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th scope="col" className="px-6 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 min-w-[200px]">
                  Account
                </th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Change this period
                </th>
                <th scope="col" className="px-6 py-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Balance
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.accountId} className="border-t border-gray-50 dark:border-gray-700/50">
                  <th scope="row" className="px-6 py-2.5 text-left font-normal">
                    {/* flex-col items-start: index.css sets `button { display:
                        inline-flex; align-items: center }` globally, which
                        turns the two block spans below into flex items laid
                        side by side — the name and its label ran together on
                        one line ("Credit CardCredit cards"), silently, for as
                        long as this table has existed. An element selector
                        loses to a utility class, so stating the direction here
                        is the fix; `block` on the children cannot win, because
                        a flex item's display is blocked out either way. */}
                    <button
                      type="button"
                      onClick={() => drillIntoAccount(row)}
                      className="flex flex-col items-start text-left rounded"
                      title={`${row.name} — view these transactions`}
                    >
                      {/* The underline is the whole hover (stock-blue ruling,
                          28 Aug 2026): the name already has its resting ink. */}
                      <span className="block text-sm text-gray-900 dark:text-white hover:underline">
                        {row.name}
                      </span>
                      {/* mt-0.5: a long name wraps to the line above this
                          label, and with no gap the two read as one string
                          (Design, 23 Aug §4).

                          WHY A ROW MOVED (Design §1.1, 25 Aug). Sections split
                          by SIGN, bands name a TYPE, and the two disagree
                          whenever an account is overdrawn or a card is
                          overpaid. A reader looking for their current account
                          under what you own, and not finding it, needs the row
                          to say why it is on the other side. Only the moved
                          rows carry the word: on every other row it would be
                          restating the section heading. */}
                      <span className="block mt-0.5 text-xs text-gray-400 dark:text-gray-500">
                        {groupLabels.get(row.accountId) ?? 'Other'}
                        {movedSideLabel(row.type, row.closing) !== null && (
                          <> · {movedSideLabel(row.type, row.closing)}</>
                        )}
                      </span>
                    </button>
                  </th>
                  <td className={`px-3 py-2.5 text-sm text-right tabular-nums whitespace-nowrap ${
                    row.change < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'
                  }`}>
                    {row.change === 0 ? '—' : `${row.change > 0 ? '+' : ''}${money(row.change, row.currency)}`}
                  </td>
                  <td className="px-6 py-2.5 text-sm text-right font-semibold tabular-nums whitespace-nowrap text-gray-900 dark:text-white">
                    {money(Math.abs(row.closing), row.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <div className="max-w-[var(--report-max,1400px)] mx-auto space-y-6">
      {/* THE SHARED CARD, and the plainer words kept.

          This page drew its own navy slab plus three white cards — the exact
          arrangement NetWorthSummary was written to abolish, and the third copy
          of it in the app. Opting out is not free: the dark-mode fault that
          card's comment documents was found and fixed once and reached every
          surface using it, while each copy went on carrying its own version of
          the same class of bug.

          Its LABELS survive the conversion, and are now the shared card's
          defaults everywhere (design ruling, 13 Aug night §3.3): "What you own"
          and "What you owe" are better than the accounting pair, so the terser
          words became the override rather than the rule. Converting a surface
          is not permission to overwrite the words somebody chose for it. */}
      <NetWorthSummary
        netWorth={`${approx}${money(report.netWorth)}`}
        assets={`${approx}${formatCurrency(report.assets)}`}
        liabilities={`${approx}${formatCurrency(report.liabilities)}`}
      />

      {/* As-at and change, in the caption voice the net-worth report uses for
          the same two facts — so the two reports say them the same way.

          The CHANGE keeps the semantic colours while the three figures above it
          do not, and that is the rule rather than an exception to it: a delta is
          nothing but a direction of travel, which is the one thing green and red
          are for. */}
      <p className="text-body text-gray-500 dark:text-gray-400">
        As at{' '}
        <span className="font-medium text-gray-900 dark:text-gray-100">
          {report.asOf.toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'long', year: 'numeric' })}
        </span>
        . Change over {PERIOD_LABELS[picker.period].toLowerCase()}{' '}
        <span className={report.change < 0 ? 'text-expense font-medium' : 'text-income font-medium'}>
          {report.change > 0 ? '+' : ''}{approx}{money(report.change)}
        </span>
        , from {approx}{money(report.openingNetWorth)}.
      </p>

      {/* The two bases, said — balances at the as-at day, movements at their
          own days (the one-net-worth ruling). The hub stands down for this
          report; the note is its own. */}
      <BalanceReportCurrencyNote asOf={report.asOf} />
      <InvestmentBasisNote valuation={valuation} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {section('What you own', sides.owned, report.assets, 'No account is in credit in this period')}
        {section('What you owe', sides.owed, report.liabilities, 'Nothing owed — no account is overdrawn')}
      </div>

      <ReportDrillModal target={drill} onClose={() => setDrill(null)} categories={categories} />
    </div>
  );
}
