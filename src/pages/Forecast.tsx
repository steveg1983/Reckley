import React, { useEffect, useMemo, useState } from 'react';
import PageWrapper from '../components/PageWrapper';
import MixedCurrencyDisclosure from '../components/MixedCurrencyDisclosure';
import { useApp } from '../contexts/AppContextSupabase';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import { toDecimal } from '../utils/decimal';
import { getDateLocale } from '../utils/dateFormatter';
import { buildCategoryKindLookup, classifyFlow } from '../utils/incomeExpense';
import { dismissedKeys } from '../utils/suggestionDismissals';
import { buildPlWindow, bucketIndexOf, dayOf } from '../utils/plWindow';
import type { PlWindowKind } from '../utils/plWindow';
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon } from '../components/icons';
import { WholePoundsScope, WholePoundsToggle } from '../contexts/WholePoundsContext';
import { NegativesInRedToggle, useNegativeTone } from '../contexts/NegativesInRedContext';
import { DEPTH_LEVEL_1, DEPTH_LEVEL_2, DEPTH_LEVEL_2_STICKY } from '../styles/depthShading';
import { dataPort } from '@data';
import { useFlowConvert } from '../hooks/useFlowConvert';
import { useNetWorthConversion } from '../hooks/useNetWorthConversion';
import type { ForecastAdjustment, Transaction } from '../types';
import { compareNames } from '../utils/localeFormat';

/**
 * CURRENT AND FORECAST — a P&L of what happened, and the room the scenario
 * tool will move into.
 *
 * Reshaped to the owner's 19 Aug direction, replacing the side-by-side
 * base cards: "more like a 'P&L', with income above, and expenses below
 * and then a 'net income' or a 'net expenditure' figure at the bottom" —
 * with collapsible sections, a months toggle ("the twelve months going
 * across to the right just like looking at a full 12 month P&L", hidden
 * by default), and a choice of windows. "Lets get the basic look of the
 * current 'P&L' right first… Forecast can be blank for the minute until
 * I decide how I would like it built."
 *
 * ── THE SIDES READ AS A HIERARCHY, NOT A HEAP ──────────────────────────────
 *
 * Same owner, same day: "We need to have Expenses > category groupings >
 * categories… Just having them listed in a random list is not how you
 * would set out your 'P&L'. Each group heading can hide or show the
 * categories below." So each side is CATEGORY GROUPS carrying subtotals,
 * each collapsible, with the categories beneath showing their leaf names.
 * The grouping is the category's parentId, resolved ONE hop — exactly the
 * rule the register's Category column uses (utils/categoryLabel), so the
 * P&L groups the way the register labels. A category with no parent
 * stands at group level by itself. Ordering is the user's choice — by
 * name, or by value in either direction (same owner: "give the user the
 * option to have it sorted by 'group' or by 'value' high/low or
 * low/high") — applied at every level, with the unfiled remainder always
 * last: a remainder, not a category.
 *
 * ── THE CURRENT TAB IS ACTUALS, WHOLE ──────────────────────────────────────
 *
 * - Every figure is grouped from the same real rows a category expands to,
 *   so a total is exactly the sum of the rows shown under it. Transfers
 *   and revaluations are not income or spending and are left out BY NAME,
 *   with their counts.
 * - Every window holds only COMPLETE periods — the current part month
 *   would understate every category it touches. The windows themselves
 *   (last twelve months, calendar year, tax year in 6th-to-5th tax months,
 *   custom) live in utils/plWindow, where their boundaries are pinned.
 * - Forecast-exclusion verdicts do NOT thin this tab: a P&L of what
 *   happened shows what happened. The verdicts are kept — they belong to
 *   the forecast's base, and resurface with the redesigned Forecast tab.
 *
 * ── THE FORECAST TAB IS DELIBERATELY EMPTY ─────────────────────────────────
 *
 * The scenario tool (stated deviations over a reviewed base — see
 * docs/forecast-direction.md and the 'forecast_adjustments' seam, which
 * both engines still keep) is being redesigned to the owner's brief. The
 * tab says so, and names what is already stored for it rather than
 * letting stated judgments look lost. Nothing here writes to Budget —
 * that ruling is unchanged.
 */

const UNFILED_LABEL = 'Uncategorised — not yet filed';

interface StatementCategory {
  /** null for the unfiled remainder. */
  categoryId: string | null;
  /** The LEAF name — its group heading carries the rest of the path. */
  label: string;
  total: number;
  perBucket: number[];
  rows: Transaction[];
}

/** One line at group level: a heading with categories, or a category standing alone. */
type SideEntry =
  | { kind: 'group'; key: string; label: string; total: number; perBucket: number[]; categories: StatementCategory[] }
  | { kind: 'single'; key: string; category: StatementCategory };

const entryTotal = (entry: SideEntry): number =>
  entry.kind === 'group' ? entry.total : entry.category.total;

export default function Forecast(): React.JSX.Element {
  // The scope must sit ABOVE every useCurrencyDecimal call, including this
  // page's own — hence the thin shell around the statement.
  return (
    <WholePoundsScope page="forecast">
      <ForecastStatement />
    </WholePoundsScope>
  );
}

function ForecastStatement(): React.JSX.Element {
  const {
    accounts, categories, transactions,
    suggestionDismissals, suggestionDismissalsStatus, refreshSuggestionDismissals,
  } = useApp();
  const { formatCurrency } = useCurrencyDecimal();
  // "Negatives in red" (owner, 14 Nov 2026). The NET figures follow it: a
  // month that ran at a loss is a figure below zero. Expenditure lines are
  // printed in brackets by this statement's convention and are spending,
  // not a balance; they keep their ink.
  const negativeTone = useNegativeTone();
  // The flows seam: per-row factors at each row's own date, undefined while
  // the ECB history is absent (the totals then stay native, disclosed).
  const convert = useFlowConvert(accounts);
  const { historical: flowsHistorical } = useNetWorthConversion(accounts, { range: { from: null, to: null } });

  const [tab, setTab] = useState<'current' | 'forecast'>('current');

  /** Which "twelve months" the P&L reads over. */
  const [windowKind, setWindowKind] = useState<PlWindowKind>('last-12');
  const defaultCustom = useMemo(() => {
    const lastTwelve = buildPlWindow('last-12', new Date());
    return {
      from: lastTwelve.buckets[0].key,
      to: lastTwelve.buckets[lastTwelve.buckets.length - 1].key,
    };
  }, []);
  const [customFrom, setCustomFrom] = useState(defaultCustom.from);
  const [customTo, setCustomTo] = useState(defaultCustom.to);

  const plWindow = useMemo(
    () => buildPlWindow(windowKind, new Date(), { fromMonth: customFrom, toMonth: customTo }),
    [windowKind, customFrom, customTo]
  );

  const [sectionOpen, setSectionOpen] = useState<{ in: boolean; out: boolean }>({ in: true, out: true });
  /**
   * The user's ordering: by name or by value, each button carrying its own
   * direction (owner, 19 Aug: "A-Z should be clickable to change to Z-A…
   * just have one button called 'Value' and then an arrow up or an arrow
   * down"). Clicking the inactive button activates it; clicking the active
   * one turns its direction around.
   */
  const [sort, setSort] = useState<{ mode: 'name' | 'value'; nameAsc: boolean; valueDesc: boolean }>({
    mode: 'value', nameAsc: true, valueDesc: true,
  });
  const chooseSort = (mode: 'name' | 'value'): void =>
    setSort(previous => previous.mode === mode
      ? mode === 'name'
        ? { ...previous, nameAsc: !previous.nameAsc }
        : { ...previous, valueDesc: !previous.valueDesc }
      : { ...previous, mode });
  /** Group headings the user has folded shut — everything is open until asked. */
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
  const [showMonths, setShowMonths] = useState(false);
  /** Which category's rows are open, as `${side}:${entryKey}:${categoryId}`. */
  const [openCategory, setOpenCategory] = useState<string | null>(null);

  // The exclusion verdicts are lazy-loaded and this page ASKS (the #353
  // lesson) — the Forecast tab names how many are kept for the redesign.
  useEffect(() => {
    if (suggestionDismissalsStatus === 'idle') void refreshSuggestionDismissals();
  }, [suggestionDismissalsStatus, refreshSuggestionDismissals]);

  const excludedCount = useMemo(
    () => dismissedKeys(suggestionDismissals, 'forecast-excluded').size,
    [suggestionDismissals]
  );

  /**
   * The scenario's stored deviations — read only to COUNT them on the
   * Forecast tab while the tool is being redesigned. A failed read is said,
   * never guessed at.
   */
  const [adjustments, setAdjustments] = useState<ForecastAdjustment[]>([]);
  const [adjustmentsStatus, setAdjustmentsStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const rows = await dataPort.listForecastAdjustments();
        if (!live) return;
        setAdjustments(rows);
        setAdjustmentsStatus('ready');
      } catch {
        if (!live) return;
        setAdjustmentsStatus('error');
      }
    })();
    return () => { live = false; };
  }, []);

  const categoryKinds = useMemo(() => buildCategoryKindLookup(categories), [categories]);
  const categoryById = useMemo(
    () => new Map(categories.map(category => [category.id, category])),
    [categories]
  );

  const statement = useMemo(() => {
    const bucketCount = plWindow.buckets.length;

    interface BuildEntry {
      key: string;
      label: string;
      grouped: boolean;
      categories: Map<string, StatementCategory>;
    }
    const sides: Record<'in' | 'out', Map<string, BuildEntry>> = { in: new Map(), out: new Map() };
    let transfers = 0;
    let revaluations = 0;
    let holdsForeign = false;

    // Keyed by IDS, never wordings — two groups or categories that happened
    // to share a name must not share a figure.
    const put = (
      side: 'in' | 'out',
      entryKey: string,
      entryLabel: string,
      grouped: boolean,
      categoryId: string | null,
      leafLabel: string,
      row: Transaction,
      bucket: number
    ): void => {
      const entries = sides[side];
      const entry = entries.get(entryKey)
        ?? { key: entryKey, label: entryLabel, grouped, categories: new Map<string, StatementCategory>() };
      const categoryKey = categoryId ?? UNFILED_LABEL;
      const category = entry.categories.get(categoryKey)
        ?? { categoryId, label: leafLabel, total: 0, perBucket: Array.from({ length: bucketCount }, () => 0), rows: [] };
      // The flows seam (the long tail's conversion, 23 Aug): each row at
      // its own day's rate, through the same resolver every other flows
      // surface sums with. Native while the history is absent — the page's
      // disclosure then stands.
      const factor = convert?.(row) ?? null;
      if (factor !== null) holdsForeign = true;
      const magnitude = (factor !== null ? toDecimal(row.amount).times(factor) : toDecimal(row.amount)).abs();
      category.total = toDecimal(category.total).plus(magnitude).toNumber();
      category.perBucket[bucket] = toDecimal(category.perBucket[bucket]).plus(magnitude).toNumber();
      category.rows.push(row);
      entry.categories.set(categoryKey, category);
      entries.set(entryKey, entry);
    };

    for (const row of transactions) {
      const bucket = bucketIndexOf(dayOf(row.date), plWindow.buckets);
      if (bucket === -1) continue;
      const kind = classifyFlow(row, categoryKinds);
      if (kind === 'transfer') { transfers++; continue; }
      if (kind === 'revaluation') { revaluations++; continue; }
      const side: 'in' | 'out' =
        kind === 'income' ? 'in' : kind === 'expense' ? 'out' : row.amount >= 0 ? 'in' : 'out';
      const category = kind === 'uncategorized' ? undefined : categoryById.get(row.category);
      if (!category) {
        put(side, UNFILED_LABEL, UNFILED_LABEL, false, null, UNFILED_LABEL, row, bucket);
        continue;
      }
      // The group is the parent, ONE hop — the register's own labelling rule.
      const parent = category.parentId ? categoryById.get(category.parentId) : undefined;
      if (parent) {
        put(side, `grp:${parent.id}`, parent.name, true, category.id, category.name, row, bucket);
      } else {
        put(side, `cat:${category.id}`, category.name, false, category.id, category.name, row, bucket);
      }
    }

    // The user's ordering, applied at every level. The unfiled line is
    // always last, whatever its size — a remainder, not a category.
    const compare = (aLabel: string, aTotal: number, bLabel: string, bTotal: number): number =>
      sort.mode === 'name'
        ? (sort.nameAsc ? 1 : -1) * compareNames(aLabel, bLabel)
        : sort.valueDesc ? bTotal - aTotal : aTotal - bTotal;

    const finishSide = (entries: Map<string, BuildEntry>): SideEntry[] =>
      [...entries.values()]
        .map((entry): SideEntry => {
          const finished = [...entry.categories.values()]
            .map(category => ({
              ...category,
              rows: [...category.rows].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
            }))
            .sort((a, b) => compare(a.label, a.total, b.label, b.total));
          if (!entry.grouped) {
            return { kind: 'single', key: entry.key, category: finished[0] };
          }
          const total = finished.reduce(
            (sum, category) => toDecimal(sum).plus(toDecimal(category.total)).toNumber(), 0
          );
          const perBucket = Array.from({ length: bucketCount }, (_, i) =>
            finished.reduce((sum, category) => toDecimal(sum).plus(toDecimal(category.perBucket[i])).toNumber(), 0)
          );
          return { kind: 'group', key: entry.key, label: entry.label, total, perBucket, categories: finished };
        })
        .sort((a, b) => {
          const aUnfiled = a.kind === 'single' && a.category.categoryId === null;
          const bUnfiled = b.kind === 'single' && b.category.categoryId === null;
          if (aUnfiled !== bUnfiled) return aUnfiled ? 1 : -1;
          const aLabel = a.kind === 'group' ? a.label : a.category.label;
          const bLabel = b.kind === 'group' ? b.label : b.category.label;
          return compare(aLabel, entryTotal(a), bLabel, entryTotal(b));
        });

    const sumTotals = (entries: SideEntry[]): number =>
      entries.reduce((sum, entry) => toDecimal(sum).plus(toDecimal(entryTotal(entry))).toNumber(), 0);
    const sumBuckets = (entries: SideEntry[]): number[] =>
      Array.from({ length: bucketCount }, (_, i) =>
        entries.reduce((sum, entry) => {
          const value = entry.kind === 'group' ? entry.perBucket[i] : entry.category.perBucket[i];
          return toDecimal(sum).plus(toDecimal(value)).toNumber();
        }, 0)
      );

    const income = finishSide(sides.in);
    const expense = finishSide(sides.out);
    const incomeTotal = sumTotals(income);
    const expenseTotal = sumTotals(expense);
    const incomePerBucket = sumBuckets(income);
    const expensePerBucket = sumBuckets(expense);

    return {
      income,
      expense,
      incomeTotal,
      expenseTotal,
      incomePerBucket,
      expensePerBucket,
      net: toDecimal(incomeTotal).minus(toDecimal(expenseTotal)).toNumber(),
      netPerBucket: incomePerBucket.map((value, i) =>
        toDecimal(value).minus(toDecimal(expensePerBucket[i])).toNumber()
      ),
      transfers,
      revaluations,
      holdsForeign,
    };
  }, [transactions, plWindow, categoryKinds, categoryById, sort, convert]);

  const average = (total: number): number =>
    toDecimal(total).dividedBy(plWindow.buckets.length).toNumber();

  const accountNameById = useMemo(
    () => new Map(accounts.map(a => [a.id, a.name])),
    [accounts]
  );

  /** A flow figure worn the app's way: income +£X, expenditure (£X) — and a
   * zero wears neither sign nor colour, because it needs no attention. */
  const flowText = (side: 'in' | 'out', value: number): string =>
    value === 0 ? formatCurrency(0)
      : side === 'in' ? `+${formatCurrency(value)}` : formatCurrency(-value);

  const sideColour = (side: 'in' | 'out', value: number): string =>
    value === 0 ? 'text-gray-900 dark:text-white'
      : side === 'in' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';

  /** A month cell — a quiet dash where nothing happened, never £0.00 noise. */
  const cellText = (side: 'in' | 'out', value: number): string =>
    value === 0 ? '—' : flowText(side, value);

  // ≈ when a conversion is actually inside (ruling §6.3) — the same gate the
  // basis line renders under, so mark and line always agree.
  const approx = statement.holdsForeign ? '≈ ' : '';
  const netText = (value: number): string =>
    approx + (value === 0 ? formatCurrency(0)
      : value > 0 ? `+${formatCurrency(value)}` : formatCurrency(value));

  const netLabel = statement.net >= 0 ? 'Net income' : 'Net expenditure';
  const netColour = statement.net === 0 ? 'text-gray-900 dark:text-white'
    : statement.net > 0
      ? 'text-green-600 dark:text-green-400'
      : 'text-red-600 dark:text-red-400';

  const windowSentence: Record<PlWindowKind, string> = {
    'last-12': 'the last twelve complete months — the current part month is left out, it would understate every category it touches',
    'calendar-year': 'the last full calendar year',
    'tax-year': 'the last complete tax year; months run 6th to 5th, as tax months do',
    'custom': 'whole months, chosen by you',
  };

  const toggleSection = (side: 'in' | 'out'): void =>
    setSectionOpen(previous => ({ ...previous, [side]: !previous[side] }));

  const toggleGroup = (key: string): void =>
    setClosedGroups(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** The rows a category's figure is the sum of — shared by both layouts. */
  const TransactionRows = ({ rows }: { rows: Transaction[] }): React.JSX.Element => (
    <ul className="pb-2 pl-2">
      {rows.map(row => (
        <li key={row.id} className="py-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-t border-gray-50 dark:border-gray-700/50 first:border-0">
          <span className="min-w-0 flex items-baseline gap-2">
            <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400 w-16 shrink-0">
              {new Date(row.date).toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'short', year: '2-digit' })}
            </span>
            <span className="text-sm text-gray-900 dark:text-white truncate">{row.description}</span>
            {accountNameById.get(row.accountId) && (
              <span className="text-xs text-gray-400 dark:text-gray-500 truncate">
                {accountNameById.get(row.accountId)}
              </span>
            )}
          </span>
          <span className={`text-sm tabular-nums shrink-0 ${
            row.amount >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
          }`}>
            {row.amount >= 0 ? `+${formatCurrency(row.amount)}` : formatCurrency(row.amount)}
          </span>
        </li>
      ))}
    </ul>
  );

  /** One category line in the list layout — drillable to its rows. */
  const CategoryLine = ({ side, category, drillKey }: {
    side: 'in' | 'out'; category: StatementCategory; drillKey: string;
  }): React.JSX.Element => {
    const rowsOpen = openCategory === drillKey;
    return (
      <li className="border-t border-gray-50 dark:border-gray-700/50 first:border-0">
        <button
          type="button"
          onClick={() => setOpenCategory(rowsOpen ? null : drillKey)}
          aria-expanded={rowsOpen}
          className="w-full py-2 flex items-baseline justify-between gap-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40 rounded"
        >
          <span className={`text-sm truncate ${
            category.categoryId === null
              ? 'text-gray-500 dark:text-gray-400'
              : 'text-gray-900 dark:text-white'
          }`}>
            {category.label}
            <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">{category.rows.length}</span>
          </span>
          <span className="text-right shrink-0">
            <span className="block text-sm tabular-nums text-gray-900 dark:text-white">
              {flowText(side, category.total)}
            </span>
            <span className="block text-xs tabular-nums text-gray-500 dark:text-gray-400">
              {formatCurrency(average(category.total))} a month
            </span>
          </span>
        </button>
        {rowsOpen && <TransactionRows rows={category.rows} />}
      </li>
    );
  };

  /** One P&L section in the list layout — heading, group headings, categories. */
  const SectionList = ({ side, title, entries, total }: {
    side: 'in' | 'out'; title: string; entries: SideEntry[]; total: number;
  }): React.JSX.Element => {
    const open = sectionOpen[side];
    return (
      <div className="border-t border-gray-100 dark:border-gray-700/60 first:border-0">
        {/* A row that FOLDS wears a quiet band (owner, 19 Aug: "anything…
            that has a drop down arrow should have its row highlighted
            slightly") — the same band its table-mode twin wears. */}
        <div className={`flex items-baseline justify-between gap-4 py-2 px-2 -mx-2 rounded ${DEPTH_LEVEL_1}`}>
          <button
            type="button"
            onClick={() => toggleSection(side)}
            aria-expanded={open}
            className="flex items-center gap-1.5 text-card font-bold text-theme-heading dark:text-white"
          >
            {open
              ? <ChevronDownIcon size={16} className="text-gray-400 shrink-0" />
              : <ChevronRightIcon size={16} className="text-gray-400 shrink-0" />}
            {title}
          </button>
          <span className="text-right shrink-0">
            <span className={`block text-body font-semibold tabular-nums ${sideColour(side, total)}`}>
              {flowText(side, total)}
            </span>
            <span className="block text-dense tabular-nums text-gray-500 dark:text-gray-400">
              {formatCurrency(average(total))} a month
            </span>
          </span>
        </div>
        {open && (
          entries.length === 0 ? (
            <p className="pb-2 pl-6 text-body text-gray-500 dark:text-gray-400">
              Nothing on this side of the ledger in this window.
            </p>
          ) : (
            <ul className="pb-1 pl-4">
              {entries.map(entry => {
                if (entry.kind === 'single') {
                  return (
                    <CategoryLine
                      key={entry.key}
                      side={side}
                      category={entry.category}
                      drillKey={`${side}:${entry.key}`}
                    />
                  );
                }
                const groupKey = `${side}:${entry.key}`;
                const groupOpen = !closedGroups.has(groupKey);
                return (
                  <li key={entry.key} className="border-t border-gray-50 dark:border-gray-700/50 first:border-0">
                    <div className={`flex items-baseline justify-between gap-4 px-2 -mx-2 rounded ${DEPTH_LEVEL_2}`}>
                      <button
                        type="button"
                        onClick={() => toggleGroup(groupKey)}
                        aria-expanded={groupOpen}
                        className="flex items-center gap-1.5 py-2 text-sm font-bold text-gray-900 dark:text-white"
                      >
                        {groupOpen
                          ? <ChevronDownIcon size={14} className="text-gray-400 shrink-0" />
                          : <ChevronRightIcon size={14} className="text-gray-400 shrink-0" />}
                        {entry.label}
                      </button>
                      <span className="text-right shrink-0">
                        <span className="block text-sm tabular-nums font-medium text-gray-900 dark:text-white">
                          {flowText(side, entry.total)}
                        </span>
                        <span className="block text-xs tabular-nums text-gray-500 dark:text-gray-400">
                          {formatCurrency(average(entry.total))} a month
                        </span>
                      </span>
                    </div>
                    {groupOpen && (
                      <ul className="pl-5">
                        {entry.categories.map(category => (
                          <CategoryLine
                            key={category.categoryId ?? category.label}
                            side={side}
                            category={category}
                            drillKey={`${side}:${entry.key}:${category.categoryId ?? category.label}`}
                          />
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        )}
      </div>
    );
  };

  const columnCount = plWindow.buckets.length + 3;

  /** A category's cells in the table layout. */
  const categoryTableRow = (
    side: 'in' | 'out',
    category: StatementCategory,
    drillKey: string,
    indent: string
  ): React.JSX.Element => {
    const rowsOpen = openCategory === drillKey;
    return (
      <React.Fragment key={drillKey}>
        <tr className="border-t border-gray-50 dark:border-gray-700/50">
          <td className={`sticky left-0 bg-white dark:bg-gray-800 py-1.5 pr-4 ${indent}`}>
            <button
              type="button"
              onClick={() => setOpenCategory(rowsOpen ? null : drillKey)}
              aria-expanded={rowsOpen}
              className={`text-left text-sm truncate max-w-[16rem] ${
                category.categoryId === null
                  ? 'text-gray-500 dark:text-gray-400'
                  : 'text-gray-900 dark:text-white'
              }`}
            >
              {category.label}
              <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">{category.rows.length}</span>
            </button>
          </td>
          {category.perBucket.map((value, i) => (
            <td key={plWindow.buckets[i].key} className="py-1.5 px-2 text-right text-sm tabular-nums text-gray-700 dark:text-gray-300 whitespace-nowrap">
              {cellText(side, value)}
            </td>
          ))}
          <td className="py-1.5 pl-3 text-right text-sm tabular-nums text-gray-900 dark:text-white whitespace-nowrap">
            {flowText(side, category.total)}
          </td>
          <td className="py-1.5 pl-3 text-right text-sm tabular-nums text-gray-500 dark:text-gray-400 whitespace-nowrap">
            {formatCurrency(average(category.total))}
          </td>
        </tr>
        {rowsOpen && (
          <tr>
            <td colSpan={columnCount} className="pl-4">
              <TransactionRows rows={category.rows} />
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  };

  /** One P&L section in the months-across table layout. */
  const sectionTableRows = (
    side: 'in' | 'out',
    title: string,
    entries: SideEntry[],
    total: number,
    perBucket: number[]
  ): React.JSX.Element => {
    const open = sectionOpen[side];
    return (
      <>
        {/* A folding row wears the band; its sticky cell paints the SAME
            colour, opaque, or the first column would break the band while
            the months scroll beneath it. */}
        <tr className={`border-t border-gray-100 dark:border-gray-700/60 ${DEPTH_LEVEL_1}`}>
          <td className={`sticky left-0 ${DEPTH_LEVEL_1} py-2 pr-4`}>
            <button
              type="button"
              onClick={() => toggleSection(side)}
              aria-expanded={open}
              className="flex items-center gap-1.5 text-card font-bold text-theme-heading dark:text-white"
            >
              {open
                ? <ChevronDownIcon size={16} className="text-gray-400 shrink-0" />
                : <ChevronRightIcon size={16} className="text-gray-400 shrink-0" />}
              {title}
            </button>
          </td>
          {perBucket.map((value, i) => (
            <td key={plWindow.buckets[i].key} className="py-2 px-2 text-right text-sm tabular-nums font-medium text-gray-900 dark:text-white whitespace-nowrap">
              {cellText(side, value)}
            </td>
          ))}
          <td className={`py-2 pl-3 text-right text-sm tabular-nums font-semibold whitespace-nowrap ${sideColour(side, total)}`}>
            {flowText(side, total)}
          </td>
          <td className="py-2 pl-3 text-right text-sm tabular-nums text-gray-500 dark:text-gray-400 whitespace-nowrap">
            {formatCurrency(average(total))}
          </td>
        </tr>
        {open && entries.map(entry => {
          if (entry.kind === 'single') {
            return categoryTableRow(side, entry.category, `${side}:${entry.key}`, 'pl-4');
          }
          const groupKey = `${side}:${entry.key}`;
          const groupOpen = !closedGroups.has(groupKey);
          return (
            <React.Fragment key={entry.key}>
              <tr className={`border-t border-gray-50 dark:border-gray-700/50 ${DEPTH_LEVEL_2}`}>
                <td className={`sticky left-0 ${DEPTH_LEVEL_2_STICKY} py-1.5 pl-4 pr-4`}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(groupKey)}
                    aria-expanded={groupOpen}
                    className="flex items-center gap-1.5 text-left text-sm font-bold text-gray-900 dark:text-white truncate max-w-[16rem]"
                  >
                    {groupOpen
                      ? <ChevronDownIcon size={14} className="text-gray-400 shrink-0" />
                      : <ChevronRightIcon size={14} className="text-gray-400 shrink-0" />}
                    {entry.label}
                  </button>
                </td>
                {entry.perBucket.map((value, i) => (
                  <td key={plWindow.buckets[i].key} className="py-1.5 px-2 text-right text-sm tabular-nums font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">
                    {cellText(side, value)}
                  </td>
                ))}
                <td className="py-1.5 pl-3 text-right text-sm tabular-nums font-medium text-gray-900 dark:text-white whitespace-nowrap">
                  {flowText(side, entry.total)}
                </td>
                <td className="py-1.5 pl-3 text-right text-sm tabular-nums text-gray-500 dark:text-gray-400 whitespace-nowrap">
                  {formatCurrency(average(entry.total))}
                </td>
              </tr>
              {groupOpen && entry.categories.map(category =>
                categoryTableRow(
                  side,
                  category,
                  `${side}:${entry.key}:${category.categoryId ?? category.label}`,
                  'pl-8'
                )
              )}
            </React.Fragment>
          );
        })}
      </>
    );
  };

  /** What is already stored for the redesigned Forecast tab, in words. */
  const keptParts = [
    adjustmentsStatus === 'ready' && adjustments.length > 0
      ? (adjustments.length === 1 ? '1 adjusted category' : `${adjustments.length} adjusted categories`)
      : null,
    suggestionDismissalsStatus === 'ready' && excludedCount > 0
      ? (excludedCount === 1 ? '1 excluded one-off' : `${excludedCount} excluded one-offs`)
      : null,
  ].filter((part): part is string => part !== null);

  return (
    /* PLAN, not Forecast (Claude Design 22 Aug §9, owner-approved): the page
       is two things — a twelve-month actuals P&L and a projection from it —
       and "Forecast" was both where you were and one of two tabs, with the
       selected tab the one that ISN'T the page name. "Plan" covers both and
       matches the nav group; the tabs say what each side holds. "Current"
       also went — what that side shows is history, so it says Actuals. */
    <PageWrapper title="Plan">
      <div className="max-w-[1400px] mx-auto space-y-6">
        {/* The ladder (the long tail's conversion, 23 Aug): with the ECB
            history in force every figure converts at its row's own day and
            the basis is said; while it is absent the totals stay native and
            the Phase 0 disclosure stands. Nothing for a single-currency
            ledger. */}
        {flowsHistorical && statement.holdsForeign ? (
          <p className="text-dense text-gray-500 dark:text-gray-400" data-testid="forecast-rates-basis">
            ≈ Converted at each day’s ECB reference rate. Weekends and holidays carry
            the previous business day’s rate.
          </p>
        ) : (
          !flowsHistorical && <MixedCurrencyDisclosure />
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* The tab, chosen the way the calendar chooses its view — a
              segmented control (owner, 19 Aug: "Lets have two tabs for now",
              renamed 22 Aug with the page). */}
          <div className="flex items-center rounded-lg bg-gray-100 dark:bg-gray-700 p-0.5" role="group" aria-label="Plan view">
            {(['current', 'forecast'] as const).map(option => (
              <button
                key={option}
                type="button"
                onClick={() => setTab(option)}
                aria-pressed={tab === option}
                className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                  tab === option
                    ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100'
                }`}
              >
                {option === 'current' ? 'Actuals' : 'Forecast'}
              </button>
            ))}
          </div>

          {tab === 'current' && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center rounded-lg bg-gray-100 dark:bg-gray-700 p-0.5" role="group" aria-label="Which months the figures read over">
                {([
                  ['last-12', 'Last 12 months'],
                  ['calendar-year', 'Calendar year'],
                  ['tax-year', 'Tax year'],
                  ['custom', 'Custom'],
                ] as const).map(([kind, name]) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setWindowKind(kind)}
                    aria-pressed={windowKind === kind}
                    className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                      windowKind === kind
                        ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm'
                        : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100'
                    }`}
                  >
                    {name}
                  </button>
                ))}
              </div>
              {windowKind === 'custom' && (
                <span className="flex items-center gap-2 text-dense text-gray-500 dark:text-gray-400">
                  <label className="flex items-center gap-1.5">
                    From
                    <input
                      type="month"
                      value={customFrom}
                      onChange={event => setCustomFrom(event.target.value)}
                      className="px-2 py-1 text-sm border border-line dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                    />
                  </label>
                  <label className="flex items-center gap-1.5">
                    To
                    <input
                      type="month"
                      value={customTo}
                      onChange={event => setCustomTo(event.target.value)}
                      className="px-2 py-1 text-sm border border-line dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                    />
                  </label>
                </span>
              )}
            </div>
          )}
        </div>

        {tab === 'current' ? (
          <>
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-line dark:border-gray-700">
              <h2 className="text-label uppercase tracking-wider font-medium text-gray-500 dark:text-gray-400">
                Your profit and loss
              </h2>
              {/* TWO SHORT LINES, not four dense ones (Claude Design, 22 Aug
                  §10): every sentence was worth keeping, which was the
                  problem — good writing at a density that makes it skippable.
                  The period statement and the exclusions stay here, where the
                  numbers are; the Budget-relationship sentence moved to the
                  Forecast tab, beside the place a scenario would actually be
                  promoted — a reassurance at the point of action, not a
                  disclaimer at the top of a page of history. */}
              <p className="text-dense text-gray-500 dark:text-gray-400 mt-1">
                {plWindow.label} — {windowSentence[windowKind]}. Category by
                category, exactly as the register holds them.
              </p>
              <p className="text-dense text-gray-500 dark:text-gray-400 mt-2">
                Transfers between your accounts are not income or spending and are
                left out{statement.transfers > 0 && <> ({statement.transfers} in this stretch)</>}
                {statement.revaluations > 0 && <>; {statement.revaluations} revaluations — ledger arithmetic — likewise</>}.
              </p>
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-4 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                <div className="flex items-center rounded-lg bg-gray-100 dark:bg-gray-700 p-0.5" role="group" aria-label="Sort order">
                  <button
                    type="button"
                    onClick={() => chooseSort('name')}
                    aria-pressed={sort.mode === 'name'}
                    title={sort.mode === 'name' ? 'Turn the alphabet around' : 'Sort by name'}
                    className={`px-2.5 py-0.5 text-xs font-medium rounded-md transition-colors ${
                      sort.mode === 'name'
                        ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm'
                        : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100'
                    }`}
                  >
                    {sort.nameAsc ? 'A to Z' : 'Z to A'}
                  </button>
                  <button
                    type="button"
                    onClick={() => chooseSort('value')}
                    aria-pressed={sort.mode === 'value'}
                    aria-label={sort.valueDesc ? 'Value, largest first' : 'Value, smallest first'}
                    title={sort.mode === 'value' ? 'Turn the order around' : 'Sort by value'}
                    className={`flex items-center gap-1 px-2.5 py-0.5 text-xs font-medium rounded-md transition-colors ${
                      sort.mode === 'value'
                        ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm'
                        : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100'
                    }`}
                  >
                    Value
                    {sort.valueDesc
                      ? <ArrowDownIcon size={12} className="shrink-0" />
                      : <ArrowUpIcon size={12} className="shrink-0" />}
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <NegativesInRedToggle />
                  <WholePoundsToggle />
                  <button
                    type="button"
                    onClick={() => setShowMonths(previous => !previous)}
                    aria-pressed={showMonths}
                    className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:underline"
                  >
                    {showMonths
                      ? <ChevronDownIcon size={14} className="shrink-0" />
                      : <ChevronRightIcon size={14} className="shrink-0" />}
                    {showMonths ? 'Hide the months' : 'Show the months'}
                  </button>
                </div>
              </div>

              {showMonths ? (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-xs text-gray-500 dark:text-gray-400">
                        <th scope="col" className="sticky left-0 bg-white dark:bg-gray-800 py-1 pr-4 text-left font-normal" aria-label="Category" />
                        {plWindow.buckets.map(bucket => (
                          <th key={bucket.key} scope="col" className="py-1 px-2 text-right font-normal whitespace-nowrap">
                            {bucket.label}
                          </th>
                        ))}
                        <th scope="col" className="py-1 pl-3 text-right font-medium whitespace-nowrap">Total</th>
                        <th scope="col" className="py-1 pl-3 text-right font-normal whitespace-nowrap">A month</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sectionTableRows('in', 'Income', statement.income, statement.incomeTotal, statement.incomePerBucket)}
                      {sectionTableRows('out', 'Expenditure', statement.expense, statement.expenseTotal, statement.expensePerBucket)}
                      <tr className="border-t-2 border-gray-200 dark:border-gray-600">
                        <td className="sticky left-0 bg-white dark:bg-gray-800 py-2 pr-4 text-card font-semibold text-theme-heading dark:text-white whitespace-nowrap">
                          {netLabel}
                        </td>
                        {statement.netPerBucket.map((value, i) => (
                          <td key={plWindow.buckets[i].key} className={`py-2 px-2 text-right text-sm tabular-nums font-medium whitespace-nowrap ${negativeTone(value, 'text-gray-900 dark:text-white')}`}>
                            {value === 0 ? '—' : netText(value)}
                          </td>
                        ))}
                        <td className={`py-2 pl-3 text-right text-sm tabular-nums font-semibold whitespace-nowrap ${netColour}`}>
                          {netText(statement.net)}
                        </td>
                        <td className={`py-2 pl-3 text-right text-sm tabular-nums whitespace-nowrap ${negativeTone(average(statement.net), 'text-gray-500 dark:text-gray-400')}`}>
                          {formatCurrency(average(statement.net))}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <div>
                  <SectionList side="in" title="Income" entries={statement.income} total={statement.incomeTotal} />
                  <SectionList side="out" title="Expenditure" entries={statement.expense} total={statement.expenseTotal} />
                  <div className="mt-1 pt-3 border-t-2 border-gray-200 dark:border-gray-600 flex items-baseline justify-between gap-4">
                    <span className="text-card font-semibold text-theme-heading dark:text-white">{netLabel}</span>
                    <span className="text-right shrink-0">
                      <span className={`block text-body font-semibold tabular-nums ${netColour}`}>
                        {netText(statement.net)}
                      </span>
                      <span className={`block text-dense tabular-nums ${negativeTone(average(statement.net), 'text-gray-500 dark:text-gray-400')}`}>
                        {formatCurrency(average(statement.net))} a month
                      </span>
                    </span>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
            <h2 className="text-card font-semibold text-theme-heading dark:text-white">The forecast</h2>
            <p className="text-body text-gray-500 dark:text-gray-400 mt-1">
              The scenario tool will live here — it is being designed.
            </p>
            {/* Moved here from the Actuals preamble (§10): this is where a
                scenario would be written to Budget, so this is where the
                promise belongs. When the promote control lands, the sentence
                stands beside it. */}
            <p className="text-dense text-gray-500 dark:text-gray-400 mt-2">
              <span className="text-gray-700 dark:text-gray-300">Nothing here will write to your Budget</span>
              {' '}— a scenario only ever becomes budgets by your explicit, per-category say-so.
            </p>
            {keptParts.length > 0 && (
              <p className="text-dense text-gray-700 dark:text-gray-300 mt-2">
                Kept for it: {keptParts.join(' and ')} — they will reappear when it lands.
              </p>
            )}
            {adjustmentsStatus === 'error' && (
              <p className="text-dense text-gray-500 dark:text-gray-400 mt-2">
                Your stated adjustments could not be read just now; they are kept
                in your ledger regardless.
              </p>
            )}
          </div>
        )}
      </div>
    </PageWrapper>
  );
}
