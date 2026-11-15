/**
 * Holdings — what you hold as at a date, and what it is worth.
 *
 * The owner's ask (28 Aug): "a report of a list of all investment holdings…
 * change the date (as at)… all portfolios or pick which ones… alphabetical
 * or value… then drill in to any holding to see the register."
 *
 * The as-at day is the PERIOD's end, so the report obeys the same period
 * control every other report does — "this month" ends today, a custom
 * window ends where the reader put it, and a past date shows what was held
 * then. buildHoldingsAsAt holds the fold and its rulings.
 *
 * MONEY IS TOTALLED PER CURRENCY, never summed across them: a dollar
 * holding and a sterling one have no common total without a rate, and the
 * rate is not part of this figure (the same stance the Investments page's
 * market view takes). One currency — the common case — shows one total.
 */
import { useEffect, useMemo, useState } from 'react';
import { dataPort } from '@data';
import { useApp } from '../../contexts/AppContextSupabase';
import { useHistoricalAccounts } from '../../hooks/useHistoricalAccounts';
import { buildHoldingsAsAt, type HeldPosition } from '../../services/investments/holdingsAsAt';
import type { InvestmentEvent } from '../../services/investments/events';
import type { InvestmentHolding } from '../../services/investments/holding';
import type { SymbolPricePoint } from '../../services/investments/investmentValuation';
import SecurityHistoryModal from '../../components/SecurityHistoryModal';
import { ChevronDownIcon } from '../../components/icons';
import { formatCurrency, formatUnitPrice } from '../../utils/currency-decimal';
import { toDecimal, type DecimalInstance } from '../../utils/decimal';
import { buildTopLevelIdByAccountId } from '../../utils/accountNesting';
import { getDateLocale } from '../../utils/dateFormatter';
import type { ReportViewProps } from './types';
import { compareText } from '../../utils/localeFormat';

type SortKey = 'name' | 'value';

const dayKeyOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function HoldingsReport({ picker }: ReportViewProps): React.JSX.Element {
  const { accounts: openAccounts } = useApp();
  // Open AND closed: a holdings report as at 2013 is mostly closed
  // portfolios, and omitting them would answer a different question.
  const accounts = useHistoricalAccounts(openAccounts);

  const [events, setEvents] = useState<InvestmentEvent[] | null>(null);
  const [holdings, setHoldings] = useState<InvestmentHolding[]>([]);
  const [prices, setPrices] = useState<SymbolPricePoint[]>([]);
  const [sort, setSort] = useState<SortKey>('value');
  const [chosenAccounts, setChosenAccounts] = useState<ReadonlySet<string>>(new Set());
  const [portfolioMenuOpen, setPortfolioMenuOpen] = useState(false);
  const [openPosition, setOpenPosition] = useState<HeldPosition | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [e, p, h] = await Promise.all([
          dataPort.listAllInvestmentEvents(),
          dataPort.listAllInvestmentPrices(),
          dataPort.listInvestments()
        ]);
        if (cancelled) return;
        setEvents(e);
        setPrices(p);
        setHoldings(h);
      } catch {
        // Degrades to "nothing held" rather than refusing to render — the
        // page still says what it knows, which is nothing.
        if (!cancelled) { setEvents([]); setPrices([]); setHoldings([]); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const asAt = picker.range.to ?? new Date();
  const asAtDay = dayKeyOf(asAt);

  /** Portfolio roots — what the filter offers, in the page's own vocabulary. */
  const portfolios = useMemo(() => {
    const topLevelIdByAccountId = buildTopLevelIdByAccountId(accounts);
    return accounts
      .filter(a => a.type === 'investment' && topLevelIdByAccountId.get(a.id) === a.id)
      .sort((a, b) => compareText(a.name, b.name));
  }, [accounts]);

  const held = useMemo(
    () => (events === null ? null : buildHoldingsAsAt(events, holdings, prices, asAtDay)),
    [events, holdings, prices, asAtDay]
  );

  /** A position belongs to the portfolio its account resolves up to. */
  const rootIdOf = useMemo(() => buildTopLevelIdByAccountId(accounts), [accounts]);
  const nameById = useMemo(() => new Map(accounts.map(a => [a.id, a.name])), [accounts]);

  const rows = useMemo(() => {
    if (held === null) return [];
    const filtered = chosenAccounts.size === 0
      ? held.positions
      : held.positions.filter(p => chosenAccounts.has(rootIdOf.get(p.accountId) ?? p.accountId));
    const sorted = [...filtered];
    if (sort === 'value') {
      sorted.sort((a, b) => {
        // An unvalued position sorts last: it has no place on a value ladder,
        // and putting it at zero would say it is worth nothing.
        if (a.value === null && b.value === null) return compareText(a.securityName, b.securityName);
        if (a.value === null) return 1;
        if (b.value === null) return -1;
        return b.value.comparedTo(a.value);
      });
    }
    return sorted;
  }, [held, chosenAccounts, rootIdOf, sort]);

  /** Totals per currency — never one figure across two moneys. */
  const totals = useMemo(() => {
    const byCurrency = new Map<string, { cost: DecimalInstance; value: DecimalInstance; unvalued: number }>();
    for (const row of rows) {
      const entry = byCurrency.get(row.currency)
        ?? byCurrency.set(row.currency, { cost: toDecimal(0), value: toDecimal(0), unvalued: 0 }).get(row.currency)!;
      entry.cost = entry.cost.plus(row.cost);
      if (row.value === null) entry.unvalued += 1;
      else entry.value = entry.value.plus(row.value);
    }
    return [...byCurrency.entries()].sort((a, b) => compareText(a[0], b[0]));
  }, [rows]);

  /**
   * What the closed control says, which is the whole reason it can be closed.
   *
   * An empty set means every portfolio, and the summary says so in words
   * rather than leaving a blank that reads as "none". Few enough chosen and
   * it names them, because a name is what the owner is checking for; past
   * that a count is the only honest summary — three names and an ellipsis
   * would hide the very one he is looking for.
   */
  const portfolioSummary = useMemo(() => {
    if (chosenAccounts.size === 0 || chosenAccounts.size === portfolios.length) {
      return 'All';
    }
    const chosen = portfolios.filter(a => chosenAccounts.has(a.id));
    if (chosen.length <= 2) {
      return chosen.map(a => a.name).join(', ');
    }
    return `${chosen.length} of ${portfolios.length}`;
  }, [chosenAccounts, portfolios]);

  const toggleAccount = (id: string): void => {
    setChosenAccounts(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const cell = 'px-3 py-2 text-body text-right tabular-nums whitespace-nowrap';
  const headCell = 'px-3 py-2 text-dense font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400';

  return (
    <div className="max-w-[var(--report-max,1400px)] mx-auto space-y-6">
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
        <p className="text-label uppercase tracking-wider font-medium text-gray-500 dark:text-gray-400">
          Holdings
        </p>
        <p className="text-dense text-gray-500 dark:text-gray-400 mt-1">
          As at {asAt.toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'long', year: 'numeric' })} —
          valued at the last recorded price on or before that day.
        </p>
        {held && (held.unpriced > 0 || held.currencyMismatches > 0) && (
          <p className="text-dense text-gray-500 dark:text-gray-400 mt-1">
            {held.unpriced + held.currencyMismatches} position
            {held.unpriced + held.currencyMismatches === 1 ? '' : 's'} with no usable price
            {held.unpriced + held.currencyMismatches === 1 ? ' is' : ' are'} shown at cost.
          </p>
        )}
      </div>

      {portfolios.length > 1 && (
        /*
         * A LIST BEHIND ONE CONTROL, not twenty-three buttons across four rows.
         *
         * The owner has twenty-three investment accounts, and as pills they
         * filled the width four times over: "It looks just like a jumbled
         * list" (29 Aug). They were alphabetical, which is the only reason it
         * was navigable at all, and being alphabetical is not the same as
         * being readable — a wall of equal-weight buttons gives the eye
         * nothing to aim at, and the ones already chosen are lost among the
         * ones that are not.
         *
         * So the summary is the control: it says how many are chosen and
         * names them while there are few enough to name. Opening it gives one
         * column with checkboxes, which is the shape a list of choices is
         * supposed to have — and it can hold twenty-three names or a hundred
         * without changing anything about the page around it.
         */
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-4">
          <div className="relative inline-block w-full sm:w-auto sm:min-w-[22rem]">
            <button
              type="button"
              onClick={() => setPortfolioMenuOpen(open => !open)}
              aria-expanded={portfolioMenuOpen}
              aria-haspopup="listbox"
              className="flex w-full items-center justify-between gap-3 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-body text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              <span className="min-w-0 text-left">
                <span className="text-gray-500 dark:text-gray-400">Portfolios: </span>
                <span className="font-medium">{portfolioSummary}</span>
              </span>
              <ChevronDownIcon size={16} className="shrink-0 text-gray-400" aria-hidden="true" />
            </button>

            {portfolioMenuOpen && (
              <div
                role="listbox"
                aria-label="Portfolios"
                className="absolute z-20 mt-1 w-full max-h-80 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg"
              >
                {/* Both, and always both: "select all" on its own leaves the
                    way back to everything as an unticking chore. */}
                <div className="flex items-center gap-4 px-3 py-2 border-b border-gray-100 dark:border-gray-700">
                  <button
                    type="button"
                    onClick={() => setChosenAccounts(new Set(portfolios.map(a => a.id)))}
                    className="text-body font-medium text-primary hover:text-secondary"
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={() => setChosenAccounts(new Set())}
                    className="text-body font-medium text-primary hover:text-secondary"
                  >
                    Clear
                  </button>
                </div>

                {portfolios.map(account => {
                  const chosen = chosenAccounts.size === 0 || chosenAccounts.has(account.id);
                  return (
                    <label
                      key={account.id}
                      className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      <input
                        type="checkbox"
                        checked={chosen}
                        onChange={() => toggleAccount(account.id)}
                        className="h-4 w-4 rounded border-gray-300 dark:border-gray-600"
                      />
                      <span className="text-body text-gray-700 dark:text-gray-300">{account.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700">
        <div className="p-6 pb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-card font-semibold text-theme-heading dark:text-white">
            {rows.length} holding{rows.length === 1 ? '' : 's'}
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-body text-gray-500 dark:text-gray-400">Sort by</span>
            <button
              type="button"
              onClick={() => setSort('value')}
              aria-pressed={sort === 'value'}
              className={sort === 'value'
                ? 'px-3 py-1 rounded-lg bg-[#1a2332] text-white text-body'
                : 'px-3 py-1 rounded-lg border border-gray-300 dark:border-gray-600 text-body text-gray-700 dark:text-gray-300'}
            >
              Value
            </button>
            <button
              type="button"
              onClick={() => setSort('name')}
              aria-pressed={sort === 'name'}
              className={sort === 'name'
                ? 'px-3 py-1 rounded-lg bg-[#1a2332] text-white text-body'
                : 'px-3 py-1 rounded-lg border border-gray-300 dark:border-gray-600 text-body text-gray-700 dark:text-gray-300'}
            >
              Name
            </button>
          </div>
        </div>

        {events === null ? (
          <p className="text-center py-16 text-gray-400">Reading your holdings…</p>
        ) : rows.length === 0 ? (
          <p className="text-center py-16 text-gray-500 dark:text-gray-400">
            Nothing was held on this date
            {chosenAccounts.size > 0 ? ' in the portfolios you have chosen' : ''}.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-b-2xl">
            <table className="min-w-full text-body">
              <caption className="sr-only">Every holding as at the chosen date, with its cost and value</caption>
              <thead className="bg-gray-50 dark:bg-gray-700/50">
                <tr>
                  <th scope="col" className={`${headCell} text-left min-w-[200px]`}>Holding</th>
                  <th scope="col" className={`${headCell} text-left`}>Portfolio</th>
                  <th scope="col" className={`${headCell} text-right`}>Units</th>
                  <th scope="col" className={`${headCell} text-right`}>Price</th>
                  <th scope="col" className={`${headCell} text-right`}>Cost</th>
                  <th scope="col" className={`${headCell} text-right`}>Value</th>
                  <th scope="col" className={`${headCell} text-right`}>Gain</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.key} className="border-t border-gray-50 dark:border-gray-700/50">
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      <button
                        type="button"
                        onClick={() => setOpenPosition(row)}
                        className="text-body text-gray-900 dark:text-white hover:underline rounded text-left"
                        title={`${row.securityName} — open its register`}
                      >
                        {row.securityName}
                        {row.symbol ? ` (${row.symbol})` : ''}
                      </button>
                    </th>
                    <td className="px-3 py-2 text-body text-gray-500 dark:text-gray-400">
                      {nameById.get(rootIdOf.get(row.accountId) ?? row.accountId) ?? '—'}
                    </td>
                    <td className={`${cell} text-gray-900 dark:text-white`}>{row.quantity.toString()}</td>
                    <td className={`${cell} text-gray-900 dark:text-white`}>
                      {row.price === null ? '—' : formatUnitPrice(row.price, row.currency)}
                    </td>
                    <td className={`${cell} text-gray-900 dark:text-white`}>
                      {formatCurrency(row.cost, row.currency)}
                    </td>
                    <td className={`${cell} font-semibold text-gray-900 dark:text-white`}>
                      {row.value === null ? '—' : formatCurrency(row.value, row.currency)}
                    </td>
                    <td className={`${cell} ${row.gain !== null && row.gain.isNegative() ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'}`}>
                      {row.gain === null ? '—' : formatCurrency(row.gain, row.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-gray-200 dark:border-gray-600">
                {totals.map(([currency, total]) => (
                  <tr key={currency}>
                    <th scope="row" className="px-3 py-3 text-left text-body font-semibold text-gray-900 dark:text-white">
                      Total ({currency})
                      {total.unvalued > 0 && (
                        <span className="block text-xs font-normal text-gray-500 dark:text-gray-400">
                          excludes {total.unvalued} with no price
                        </span>
                      )}
                    </th>
                    <td />
                    <td />
                    <td />
                    <td className={`${cell} font-semibold text-gray-900 dark:text-white`}>
                      {formatCurrency(total.cost, currency)}
                    </td>
                    <td className={`${cell} font-semibold text-gray-900 dark:text-white`}>
                      {formatCurrency(total.value, currency)}
                    </td>
                    <td className={`${cell} font-semibold ${total.value.minus(total.cost).isNegative() ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'}`}>
                      {formatCurrency(total.value.minus(total.cost), currency)}
                    </td>
                  </tr>
                ))}
              </tfoot>
            </table>
            {totals.length > 1 && (
              <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                Totalled per currency. Combining them would need an exchange rate that is not part of
                these figures.
              </p>
            )}
          </div>
        )}
      </div>

      {openPosition && (
        <SecurityHistoryModal
          symbol={openPosition.symbol}
          securityName={openPosition.securityName}
          currency={openPosition.currency}
          events={(events ?? []).filter(
            e => e.accountId === openPosition.accountId &&
              (e.symbol ?? `name:${e.securityName}`) === (openPosition.symbol ?? `name:${openPosition.securityName}`)
          )}
          onClose={() => setOpenPosition(null)}
        />
      )}
    </div>
  );
}
