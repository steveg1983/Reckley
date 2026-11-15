import React, { useMemo, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../../contexts/AppContextSupabase';
import { useCurrencyDecimal } from '../../hooks/useCurrencyDecimal';
import { PieChart, ResponsiveContainer } from '../../components/charts/DashboardCharts';
import { categoricalColor, useCategoricalRamp } from '../../components/charts/chartColors';
import { useNetWorthConversion } from '../../hooks/useNetWorthConversion';
import ConvertedTotalNote from '../../components/ConvertedTotalNote';
import { toDecimal } from '../../utils/decimal';
import { computeAccountBalances } from '../../utils/accountBalances';
import {
  ACCOUNT_DISTRIBUTION_REMAINDER_ID,
  buildAccountDistribution,
  type AccountDistributionEntry,
} from '../../utils/accountDistribution';
import { formatDecimal } from '../../utils/decimal-format';
import { preserveDemoParam } from '../../utils/navigation';
import { formatCount } from '../../utils/localeFormat';

/**
 * "Account distribution" — where the money actually sits, account by account.
 *
 * The full page behind the Dashboard's card. Both read one implementation
 * (utils/accountDistribution) over one balance map
 * (utils/accountBalances.computeAccountBalances), so the glance and the page
 * can never disagree about a figure or a ranking. The card shows the five
 * largest; this lists EVERY account.
 *
 * No period picker, deliberately (usesPeriod: false in the registry): these are
 * the balances the accounts hold now, and there is no "distribution last March"
 * to draw. Said on screen rather than left to be inferred.
 *
 * Zero balances are listed — an account holding nothing is part of the answer.
 * Closed accounts are not, because they are never loaded.
 */

export default function AccountDistributionReport(): React.JSX.Element {
  const { accounts, transactions, serverBalances } = useApp();
  const { formatCurrency, displayCurrency } = useCurrencyDecimal();
  const location = useLocation();
  const navigate = useNavigate();
  // Where a click on the remainder slice lands: the table that lists every
  // account the slice folded. It has no single register to open.
  const everyAccountRef = useRef<HTMLDivElement>(null);
  // The shared ramp. This file used to carry its own copy of the recharts demo
  // palette with a comment promising it matched the Dashboard's — a promise
  // nothing checked, and exactly the drift the one-module rule removes.
  const ramp = useCategoricalRamp();

  // A snapshot of NOW, so today's factors (the balance reports' conversion,
  // 23 Aug): each balance converts before the shares are taken, so the
  // footnote's claim — the shares sum to 100% across every account — is
  // finally true of one currency. Native while no rate exists, and the note
  // below says which state is in force.
  const { conversion, provenance: ratesProvenance } = useNetWorthConversion(accounts);
  const distribution = useMemo(() => {
    const balances = computeAccountBalances(accounts, transactions, serverBalances);
    return buildAccountDistribution(accounts, id => {
      const native = balances.get(id) ?? 0;
      const factor = conversion?.factors.get(id);
      return factor ? toDecimal(native).times(factor).toNumber() : native;
    });
  }, [accounts, transactions, serverBalances, conversion]);
  const holdsForeign = useMemo(
    () => conversion !== null && conversion.factors.size > 0,
    [conversion]
  );

  /** Which colour each drawn slice got, so the table's swatches match the donut. */
  const sliceColours = useMemo(
    () => new Map(distribution.slices.map((entry, index) => [entry.id, categoricalColor(ramp, index)])),
    [distribution.slices, ramp]
  );

  // The account's register, not the retired global list filtered to it.
  const transactionsHref = (accountId: string): string =>
    preserveDemoParam(`/accounts/${accountId}`, location.search);

  const money = (value: number): string =>
    formatCurrency(value, displayCurrency);

  // A negative contribution wears the accounting parentheses, exactly as the
  // figure it derives from does — "(0.1%)", never a bare minus.
  const shareOf = (entry: AccountDistributionEntry): string =>
    entry.share
      ? entry.share.lessThan(0)
        ? `(${formatDecimal(entry.share.abs(), 1)}%)`
        : `${formatDecimal(entry.share, 1)}%`
      : '—';

  /**
   * When the fold matches or outweighs the largest named slice, the ring is
   * the wrong instrument (Design ruling, 24 Aug §2 and §4): a ring whose
   * biggest wedge is "the other N accounts" tells the reader less than a
   * sentence would, and quietest-step placement assumes the fold is the
   * tail. Ties count as dominance — a fold as big as the biggest account is
   * already not a tail.
   */
  const remainderWedge = distribution.wedges.find(w => w.id === ACCOUNT_DISTRIBUTION_REMAINDER_ID);
  const largestWedge = distribution.wedges.find(w => w.id !== ACCOUNT_DISTRIBUTION_REMAINDER_ID);
  const spreadNote = remainderWedge && largestWedge && remainderWedge.value >= largestWedge.value
    ? { count: distribution.entries.length, name: largestWedge.name, share: shareOf(largestWedge) }
    : null;

  /**
   * How many accounts the ring draws INDIVIDUALLY — the boundary the table's
   * rule announces below. Zero when nothing was folded (every row is drawn,
   * so there is no boundary to state) or when the ring stood down entirely.
   */
  const namedSliceCount = distribution.foldedCount > 0 && !spreadNote
    ? distribution.wedges.filter(w => w.id !== ACCOUNT_DISTRIBUTION_REMAINDER_ID).length
    : 0;

  const headCell = 'px-4 py-2 text-dense font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400';

  return (
    <div className="max-w-[var(--report-max,1400px)] mx-auto space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-line dark:border-gray-700">
          {/* NET WORTH, not "held in credit" (owner, 17 Aug): the ring now
              reconciles to net worth, so the figure everything is a share OF
              must be the one the Dashboard's headline shows — two totals for
              one page is the disagreement this report exists to prevent. */}
          <p className="text-label uppercase tracking-wider font-medium text-gray-500 dark:text-gray-400">Net worth</p>
          <p className="text-page font-bold mt-1 text-gray-900 dark:text-white">{holdsForeign ? '≈ ' : ''}{money(distribution.netWorth.toNumber())}</p>
          {conversion && (
            <ConvertedTotalNote
              provenance={conversion.factors.size > 0 ? ratesProvenance : null}
              unconverted={conversion.unconverted}
              displayCurrency={displayCurrency}
            />
          )}
          {/* What every share below is a share OF, said once. */}
          <p className="text-dense text-gray-500 dark:text-gray-400 mt-1">Current balances — every share below is a contribution to this total</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-line dark:border-gray-700">
          <p className="text-dense text-gray-500 uppercase tracking-wider font-medium">Accounts</p>
          <p className="text-page font-bold mt-1 text-gray-900 dark:text-white">
            {formatCount(distribution.entries.length)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-line dark:border-gray-700">
          <p className="text-dense text-gray-500 uppercase tracking-wider font-medium">Largest holding</p>
          <p className="text-page font-bold mt-1 text-gray-900 dark:text-white truncate">
            {distribution.wedges.length > 0 ? shareOf(distribution.wedges[0]) : '—'}
          </p>
          <p className="text-dense text-gray-500 dark:text-gray-400 mt-1 truncate">
            {distribution.wedges.length > 0 ? distribution.wedges[0].name : 'Nothing in credit'}
          </p>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
          <h2 className="text-card font-semibold text-theme-heading dark:text-white">
            Where the money sits
          </h2>
          <span className="text-dense text-gray-400 dark:text-gray-500">Current balances</span>
        </div>
        {/* The count comes from the slices themselves, never the cap: with
            three accounts in credit this must not claim five. And when the
            ring folds a remainder, the sentence says what was gathered — and
            that the whole is NET WORTH (owner, 17 Aug: the legend's figures
            must come back to that number, "otherwise it looks like a useless
            report"). */}
        <p className="text-body text-gray-500 dark:text-gray-400 mb-4">
          {spreadNote
            ? 'Current balances, as shares of your net worth.'
            : <>
                {distribution.foldedCount > 0
                  ? `The ${distribution.slices.length - 1} largest accounts in credit, with every other account netted into one slice — together, your net worth`
                  : 'Every account, drawn to its balance — together, your net worth'}
                {' '}— the same slices the Dashboard shows. Every account is listed below.
                Click a slice for its transactions.
              </>}
        </p>
        {distribution.wedges.length === 0 ? (
          <p className="text-center py-16 text-gray-400">No account is in credit</p>
        ) : spreadNote ? (
          <p className="text-body text-gray-600 dark:text-gray-300" data-testid="distribution-spread-note">
            Your money is spread across {formatCount(spreadNote.count)} accounts — the
            largest, {spreadNote.name}, holds {spreadNote.share} of your net worth. Every
            account is listed below.
          </p>
        ) : (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart
                // The ring draws `wedges`, the table lists everything — one
                // derivation apart (see accountDistribution): a below-zero
                // remainder is parenthesised in the legend, never a wedge.
                data={distribution.wedges}
                innerRadius={true}
                colors={ramp}
                onClick={(entry: AccountDistributionEntry) => {
                  if (entry.id === ACCOUNT_DISTRIBUTION_REMAINDER_ID) {
                    everyAccountRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  } else {
                    navigate(transactionsHref(entry.id));
                  }
                }}
                formatter={(value: number) => money(value)}
                aria-label="Pie chart showing distribution of account balances"
              />
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div ref={everyAccountRef} className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700">
        <div className="p-6 pb-3">
          <h2 className="text-card font-semibold text-theme-heading dark:text-white">Every account</h2>
          <p className="text-body text-gray-500 dark:text-gray-400 mt-1">
            Ranked by what it holds now. Click an account to see its transactions.
          </p>
        </div>

        {distribution.entries.length === 0 ? (
          <p className="text-center py-16 text-gray-400">No accounts yet</p>
        ) : (
          /* The table scrolls inside its own box; the page never scrolls sideways. */
          <div className="overflow-x-auto rounded-b-2xl">
            <table className="min-w-full text-body">
              <caption className="sr-only">
                Every account ranked by its current balance, with each account&apos;s share of the total held in credit
              </caption>
              <thead className="bg-gray-50 dark:bg-gray-700/50">
                <tr>
                  <th scope="col" className={`${headCell} text-left min-w-[220px]`}>Account</th>
                  <th scope="col" className={`${headCell} text-right`}>Balance</th>
                  <th scope="col" className={`${headCell} text-right`}>Share</th>
                </tr>
              </thead>
              <tbody>
                {distribution.entries.map((entry, index) => (
                  <React.Fragment key={entry.id}>
                  {/* WHERE THE CHART ENDS, said (Design, 24 Aug §2): four
                      coloured rows followed by twenty-eight bare ones read
                      as rows that failed to render, rather than rows the
                      ring gathered into its remainder. The rule states the
                      boundary once, in place, rather than leaving the
                      colour to stop unexplained. */}
                  {namedSliceCount > 0 && index === namedSliceCount && (
                    <tr>
                      <td colSpan={3} className="px-4 pt-4 pb-1 text-dense text-gray-500 dark:text-gray-400 border-t border-line dark:border-gray-700">
                        Below here, the ring draws these accounts together as
                        one slice — {formatCount(distribution.foldedCount)} of them.
                      </td>
                    </tr>
                  )}
                  <tr className="border-t border-gray-50 dark:border-gray-700/50">
                    <th scope="row" className="px-4 py-2 text-left font-normal">
                      <span className="flex items-center gap-2">
                        {/* Only the NAMED slices carry a colour. The folded
                            accounts are in the ring collectively, but ninety
                            rows all wearing the remainder's colour would claim
                            each was drawn individually — so they stay bare. */}
                        <span
                          className="w-3 h-3 rounded-sm flex-shrink-0"
                          style={{ backgroundColor: sliceColours.get(entry.id) ?? 'transparent' }}
                          aria-hidden="true"
                        />
                        {/* In-app navigation, so NOT link blue (that is for
                            leaving) — and not `text-primary
                            hover:text-secondary` either: `.text-primary` is
                            `!important` and would overrule the row's declared
                            ink, while `hover:text-secondary` escapes index.css's
                            `.dark .text-secondary` lift and would go navy on a
                            gray-800 card. The underline is the whole hover, as
                            on the Accounts rows. */}
                        <Link
                          to={transactionsHref(entry.id)}
                          className="text-body text-gray-900 dark:text-white hover:underline rounded"
                          title={`${entry.name} — view these transactions`}
                        >
                          {entry.name}
                        </Link>
                      </span>
                    </th>
                    <td
                      className={`px-4 py-2 text-body text-right font-semibold tabular-nums whitespace-nowrap ${
                        entry.value < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'
                      }`}
                    >
                      {money(entry.value)}
                    </td>
                    <td className="px-4 py-2 text-body text-right tabular-nums text-gray-500 dark:text-gray-400">
                      {shareOf(entry)}
                    </td>
                  </tr>
                  </React.Fragment>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-gray-200 dark:border-gray-600">
                <tr>
                  {/* The Balance column's own sum IS net worth — the footer
                      states what the rows already add to, so the table and
                      the ring above reconcile by inspection. */}
                  <th scope="row" className="px-4 py-3 text-left text-body font-semibold text-gray-900 dark:text-white">
                    Net worth
                  </th>
                  <td className={`px-4 py-3 text-body text-right font-bold tabular-nums ${
                    distribution.netWorth.lessThan(0) ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'
                  }`}>
                    {holdsForeign ? '≈ ' : ''}{money(distribution.netWorth.toNumber())}
                  </td>
                  <td className="px-4 py-3" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* The shares are CONTRIBUTIONS to net worth now, so a liability's is
            honestly negative — in the same parentheses every negative figure
            wears. Zero balances still show none: nothing contributes nothing. */}
        {distribution.entries.some(entry => entry.value < 0) && (
          <p className="px-6 pb-6 pt-3 text-dense text-gray-500 dark:text-gray-400">
            A parenthesised share is a liability&rsquo;s contribution to your net worth —
            what it takes away. The shares sum to 100% across every account, which is
            what makes the total above the same net worth the Dashboard shows.
          </p>
        )}
      </div>
    </div>
  );
}
