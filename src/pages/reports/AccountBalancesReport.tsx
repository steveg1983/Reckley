import React, { useMemo, useState } from 'react';
import { useApp } from '../../contexts/AppContextSupabase';
import { useNetWorthConversion } from '../../hooks/useNetWorthConversion';
import { useHistoricalAccounts } from '../../hooks/useHistoricalAccounts';
import { useCurrencyDecimal } from '../../hooks/useCurrencyDecimal';
import ReportDrillModal, { type ReportDrillTarget } from '../../components/reports/ReportDrillModal';
import { buildAccountBalanceReport, resolveClosingSnapshot, type AccountBalanceRow } from '../../utils/accountBalanceReport';
import BalanceReportCurrencyNote from '../../components/reports/BalanceReportCurrencyNote';
import InvestmentBasisNote from '../../components/InvestmentBasisNote';
import { useInvestmentValuation } from '../../hooks/useInvestmentValuation';
import { PERIOD_LABELS } from '../../hooks/usePeriod';
import type { ReportViewProps } from './types';
import { getDateLocale } from '../../utils/dateFormatter';
import { formatCount } from '../../utils/localeFormat';

/**
 * "Account balances" — the Microsoft Money statement: what each account was
 * worth when the period opened, what moved through it, and what it is worth
 * now.
 *
 * Balances are computed from first principles (opening balance + every
 * transaction, Decimal throughout — see utils/accountBalanceReport), never
 * from the cached `account.balance`, so the figures reconcile with the
 * net-worth chart line for line.
 */
export default function AccountBalancesReport({ picker }: ReportViewProps): React.JSX.Element {
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

  // The dated seam (balance reports' conversion, 23 Aug): each movement at
  // its own day's rate, openings at the window's start. The CLOSING figures
  // take the snapshot basis (one-net-worth ruling, 24 Aug §1) — the as-at
  // day's own rates — so this page's total agrees with Accounts and the
  // Net worth report to the penny.
  const { conversion, conversionAt } = useNetWorthConversion(accounts, { range: { from: null, to: null } });
  // The valuation term (slice 3b): openings and closings carry each day's
  // derived investment value; the difference is the row's market movement.
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

  const drillIntoAccount = (row: AccountBalanceRow): void => {
    const rows = transactions
      .filter(t => t.accountId === row.accountId && picker.inRange(t.date))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    setDrill({
      title: `${row.name} — ${PERIOD_LABELS[picker.period]}`,
      // The account view: rows keep their own sign and the total is the net
      // movement, because this is not one side of the income/expense report.
      bucket: 'neutral',
      rows,
      total: row.change,
    });
  };

  const money = (value: number, currency?: string): string =>
    formatCurrency(value, currency);

  const signClass = (value: number): string =>
    value < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white';

  const headCell = 'px-3 py-2 text-dense font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400';
  const cell = 'px-3 py-2 text-body text-right tabular-nums whitespace-nowrap';

  return (
    <div className="max-w-[var(--report-max,1400px)] mx-auto space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-line dark:border-gray-700">
          <p className="text-label uppercase tracking-wider font-medium text-gray-500 dark:text-gray-400">
            Total balance
          </p>
          <p className="text-page font-bold mt-1 text-gray-900 dark:text-white">{approx}{money(report.netWorth)}</p>
          <p className="text-dense text-gray-500 dark:text-gray-400 mt-1">
            As at {report.asOf.toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-line dark:border-gray-700">
          <p className="text-dense text-gray-500 uppercase tracking-wider font-medium">In credit</p>
          <p className="text-page font-semibold mt-1 text-primary dark:text-white">
            {approx}{formatCurrency(report.assets)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-line dark:border-gray-700">
          <p className="text-dense text-gray-500 uppercase tracking-wider font-medium">Overdrawn / owed</p>
          <p className="text-page font-semibold mt-1 text-primary dark:text-white">
            {approx}{formatCurrency(report.liabilities)}
          </p>
        </div>
      </div>

      {/* The two bases, said — balances at the as-at day, movements at their
          own days (the one-net-worth ruling). The hub stands down for this
          report; the note is its own. */}
      <BalanceReportCurrencyNote asOf={report.asOf} />
      <InvestmentBasisNote valuation={valuation} />

      <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700">
        <div className="p-6 pb-3">
          <h2 className="text-card font-semibold text-theme-heading dark:text-white">
            Balances by account
          </h2>
          <p className="text-body text-gray-500 dark:text-gray-400 mt-1">
            {PERIOD_LABELS[picker.period]} — click an account to see the transactions behind its movement.
          </p>
        </div>

        {report.rows.length === 0 ? (
          <p className="text-center py-16 text-gray-400">No accounts yet</p>
        ) : (
          /* The table scrolls inside its own box; the page never scrolls sideways. */
          <div className="overflow-x-auto rounded-b-2xl">
            <table className="min-w-full text-body">
              <caption className="sr-only">
                Opening balance, money in and out, and closing balance for every account
              </caption>
              <thead className="bg-gray-50 dark:bg-gray-700/50">
                <tr>
                  <th scope="col" className={`${headCell} text-left min-w-[180px]`}>Account</th>
                  <th scope="col" className={`${headCell} text-right`}>Opening</th>
                  <th scope="col" className={`${headCell} text-right`}>In</th>
                  <th scope="col" className={`${headCell} text-right`}>Out</th>
                  <th scope="col" className={`${headCell} text-right`}>Change</th>
                  <th scope="col" className={`${headCell} text-right`}>Closing</th>
                  <th scope="col" className={`${headCell} text-right`}>Transactions</th>
                </tr>
              </thead>
              {report.groups.map(group => (
                <tbody key={group.key} className="border-t border-gray-100 dark:border-gray-700">
                  <tr className="bg-gray-50 dark:bg-gray-700/50">
                    <th
                      scope="row"
                      className="px-3 py-1.5 text-left text-dense font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300"
                    >
                      {group.label}
                    </th>
                    <td className={`${cell} text-gray-500 dark:text-gray-400`}>{money(group.opening)}</td>
                    <td className={cell} />
                    <td className={cell} />
                    <td className={`${cell} ${signClass(group.change)}`}>{money(group.change)}</td>
                    <td className={`${cell} font-semibold ${signClass(group.closing)}`}>{money(group.closing)}</td>
                    <td className={cell} />
                  </tr>
                  {group.rows.map(row => (
                    <tr key={row.accountId} className="border-t border-gray-50 dark:border-gray-700/50">
                      <th scope="row" className="px-3 py-2 text-left font-normal">
                        {/* The underline is the whole hover (stock-blue ruling,
                            28 Aug 2026, and ACCOUNT_ROW_NAME_LINK_CLASS before
                            it): the row already declares its resting ink, and a
                            colour change on top of an underline is decoration. */}
                        <button
                          type="button"
                          onClick={() => drillIntoAccount(row)}
                          className="text-body text-gray-900 dark:text-white hover:underline rounded"
                          title={`${row.name} — view these transactions`}
                        >
                          {row.name}
                        </button>
                      </th>
                      <td className={`${cell} text-gray-500 dark:text-gray-400`}>
                        {money(row.opening, row.currency)}
                      </td>
                      <td className={`${cell} text-green-700 dark:text-green-400`}>
                        {row.moneyIn === 0 ? '—' : formatCurrency(row.moneyIn, row.currency)}
                      </td>
                      <td className={`${cell} text-red-600 dark:text-red-400`}>
                        {row.moneyOut === 0 ? '—' : formatCurrency(row.moneyOut, row.currency)}
                      </td>
                      <td className={`${cell} ${signClass(row.change)}`}>
                        {money(row.change, row.currency)}
                        {/* The market's movement is not cash — it sits under
                            the cash change, named, only when it exists, so
                            opening + change + this = closing stays legible. */}
                        {row.marketChange !== 0 && (
                          <span className="block text-xs text-gray-500 dark:text-gray-400">
                            {money(row.marketChange, row.currency)} market
                          </span>
                        )}
                      </td>
                      <td className={`${cell} font-semibold ${signClass(row.closing)}`}>
                        {money(row.closing, row.currency)}
                      </td>
                      <td className={`${cell} text-gray-500 dark:text-gray-400`}>
                        {formatCount(row.count)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
              <tfoot className="border-t-2 border-gray-200 dark:border-gray-600">
                <tr>
                  <th scope="row" className="px-3 py-3 text-left text-body font-semibold text-gray-900 dark:text-white">
                    Total
                  </th>
                  <td className={`${cell} font-semibold ${signClass(report.openingNetWorth)}`}>
                    {money(report.openingNetWorth)}
                  </td>
                  <td className={cell} />
                  <td className={cell} />
                  <td className={`${cell} font-semibold ${signClass(report.change)}`}>
                    {money(report.change)}
                  </td>
                  <td className={`${cell} font-bold ${signClass(report.netWorth)}`}>
                    {money(report.netWorth)}
                  </td>
                  <td className={cell} />
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
