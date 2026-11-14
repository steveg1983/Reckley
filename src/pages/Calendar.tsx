import { useCallback, useEffect, useState, useMemo } from 'react';
import { Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useApp } from '../contexts/AppContextSupabase';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import { preserveDemoParam } from '../utils/navigation';
import { ChevronLeftIcon, ChevronRightIcon } from '../components/icons';
import PageWrapper from '../components/PageWrapper';
import MixedCurrencyDisclosure from '../components/MixedCurrencyDisclosure';
import PageTip from '../components/PageTip';
import { toDecimal } from '../utils/decimal';
import { getDateLocale } from '../utils/dateFormatter';
import { detectRecurring } from '../utils/recurringDetection';
import { projectRecurringSchedule } from '../utils/recurringSchedule';
import { dismissedKeys, recurringAnswerKey } from '../utils/suggestionDismissals';
import { computeIncomeExpense, buildCategoryKindLookup, classifyFlow } from '../utils/incomeExpense';
import { useFlowConvert } from '../hooks/useFlowConvert';
import { useNetWorthConversion } from '../hooks/useNetWorthConversion';
import { dailyFactorLookup } from '../utils/netWorthSeries';
import { Modal, ModalBody } from '../components/common/Modal';
import EditTransactionModal from '../components/EditTransactionModal';
import type { Transaction } from '../types';
import type { SplitExpandedTransaction } from '../utils/transactionSplits';
import { createCategoryLabeller } from '../utils/categoryLabel';
import { WholePoundsScope, WholePoundsToggle } from '../contexts/WholePoundsContext';
import { NegativesInRedToggle, useNegativeTone } from '../contexts/NegativesInRedContext';

interface DayData {
  date: Date;
  day: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  income: number;
  expense: number;
  transactionCount: number;
  runningBalance: number;
}

export default function Calendar() {
  // The whole-pounds scope must sit above every useCurrencyDecimal call,
  // including this page's own — hence the thin shell (owner, 19 Aug:
  // page-specific decimal display).
  return (
    <WholePoundsScope page="calendar">
      <CalendarView />
    </WholePoundsScope>
  );
}

function CalendarView() {
  const {
    transactions, transactionSplits, categories, accounts,
    suggestionDismissals, suggestionDismissalsStatus, refreshSuggestionDismissals,
  } = useApp();

  // The verdicts are lazy-loaded; a reader must ask (see the note in
  // RecurringCommitmentsReport). Without this the due-next panel's confirmed
  // set was empty in production whatever the user had confirmed.
  useEffect(() => {
    if (suggestionDismissalsStatus === 'idle') void refreshSuggestionDismissals();
  }, [suggestionDismissalsStatus, refreshSuggestionDismissals]);
  const { formatCurrency } = useCurrencyDecimal();
  // "Negatives in red" (owner, 14 Nov 2026). This page colours money in
  // and money out already; what the setting adds is the day view's
  // transfers and unfiled rows, which are deliberately neutral.
  const negativeTone = useNegativeTone();
  // The seams (the long tail's conversion, 23 Aug): day tiles convert each
  // movement at its own day's rate; the running balance values each day's
  // per-account natives at that day's rate. Native while the history is
  // absent — the page's disclosure then stands.
  const convert = useFlowConvert(accounts);
  const { conversionAt, historical: flowsHistorical } = useNetWorthConversion(accounts, { range: { from: null, to: null } });
  const navigate = useNavigate();
  const location = useLocation();
  const [currentDate, setCurrentDate] = useState(new Date());

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();


  // Build calendar grid data
  const calendarData = useMemo(() => {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDay = firstDay.getDay(); // 0 = Sunday
    const daysInMonth = lastDay.getDate();
    const today = new Date();

    // Helper to get YYYY-MM-DD from a Date
    const toDateKey = (d: Date) => {
      const dt = d instanceof Date ? d : new Date(d);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    };

    // Group transactions by date string. The calendar is a CASH-MOVEMENT day
    // ledger (a bank-statement view): buckets are money in / money out by
    // direction, transfers included — it is deliberately NOT an income
    // statement, and its labels must say so (income semantics live in
    // utils/incomeExpense for the reporting surfaces).
    const txByDate = new Map<string, { income: number; expense: number; count: number }>();
    transactions.forEach(t => {
      const dateKey = toDateKey(t.date);
      const existing = txByDate.get(dateKey) || { income: 0, expense: 0, count: 0 };
      existing.count++;
      // Each movement at its own day's rate (native when no factor).
      const factor = convert?.(t) ?? null;
      const amount = factor !== null ? toDecimal(t.amount).times(factor) : toDecimal(t.amount);
      if (t.amount >= 0) {
        existing.income = toDecimal(existing.income).plus(amount).toNumber();
      } else {
        existing.expense = toDecimal(existing.expense).plus(amount.abs()).toNumber();
      }
      txByDate.set(dateKey, existing);
    });

    // The running balance, per-account and Decimal (float `+` retired with
    // the native summing): natives accumulate chronologically, and each
    // rendered day values every account's native at THAT day's own rate —
    // a held foreign balance changes its sterling value with no transaction,
    // and only day-of valuation sees it.
    const allSorted = [...transactions].sort((a, b) =>
      new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    const factorFor = dailyFactorLookup(conversionAt ?? undefined);
    const natives = new Map<string, ReturnType<typeof toDecimal>>();
    accounts.forEach(acc => natives.set(acc.id, toDecimal(acc.openingBalance ?? 0)));
    const valueOn = (dateKey: string): number => {
      let total = toDecimal(0);
      for (const [accountId, native] of natives) {
        const factor = factorFor(accountId, dateKey);
        total = total.plus(factor ? native.times(factor) : native);
      }
      return total.toNumber();
    };
    const startOfMonth = new Date(year, month, 1);
    let cursor = 0;
    // Everything before the month advances the natives silently.
    while (cursor < allSorted.length && new Date(allSorted[cursor].date) < startOfMonth) {
      const t = allSorted[cursor];
      natives.set(t.accountId, (natives.get(t.accountId) ?? toDecimal(0)).plus(toDecimal(t.amount)));
      cursor++;
    }

    // Build grid: fill previous month days, current month, next month
    const days: DayData[] = [];

    // Previous month padding
    for (let i = 0; i < startDay; i++) {
      const prevDate = new Date(year, month, -startDay + i + 1);
      days.push({
        date: prevDate,
        day: prevDate.getDate(),
        isCurrentMonth: false,
        isToday: false,
        income: 0,
        expense: 0,
        transactionCount: 0,
        runningBalance: 0,
      });
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayTx = txByDate.get(dateKey);

      // Advance natives through this day, then value AT this day.
      const endOfDay = new Date(year, month, d, 23, 59, 59, 999);
      while (cursor < allSorted.length && new Date(allSorted[cursor].date) <= endOfDay) {
        const t = allSorted[cursor];
        natives.set(t.accountId, (natives.get(t.accountId) ?? toDecimal(0)).plus(toDecimal(t.amount)));
        cursor++;
      }
      const currentBalance = valueOn(dateKey);

      days.push({
        date,
        day: d,
        isCurrentMonth: true,
        isToday: date.toDateString() === today.toDateString(),
        income: dayTx?.income ?? 0,
        expense: dayTx?.expense ?? 0,
        transactionCount: dayTx?.count ?? 0,
        runningBalance: currentBalance,
      });
    }

    // Next month padding to fill 6 rows
    const remaining = 42 - days.length;
    for (let i = 1; i <= remaining; i++) {
      const nextDate = new Date(year, month + 1, i);
      days.push({
        date: nextDate,
        day: nextDate.getDate(),
        isCurrentMonth: false,
        isToday: false,
        income: 0,
        expense: 0,
        transactionCount: 0,
        runningBalance: 0,
      });
    }

    return days;
  }, [transactions, year, month, accounts, convert, conversionAt]);

  /**
   * THE FORWARD HALF (Design handover 17 Aug, §1 and §8 step 3): what is
   * DUE, projected from the recurring patterns the user has CONFIRMED on
   * "What I'm committed to" — and only those. An unconfirmed detection is
   * the app's opinion, and an opinion must never sit on a calendar looking
   * like a payment that is going to happen (§5). Everything here is an
   * inference and is dressed as one: the word is "due", the styling is
   * quiet, and nothing joins the actual-money figures around it.
   */
  const confirmedPatterns = useMemo(() => {
    const confirmed = dismissedKeys(suggestionDismissals, 'recurring-confirmed');
    const isVouched = (accountId: string, direction: 'in' | 'out', payeeKey: string): boolean =>
      confirmed.has(recurringAnswerKey(accountId, direction, payeeKey));
    // The verdicts are handed to detection as well as applied after it: a
    // vouched payee is read leniently (its amounts need not repeat), which is
    // the whole point of marking a variable commitment recurring. Matched
    // across every label the pattern has worn, so a Confirm given before the
    // bank renamed the payee still reaches this calendar.
    return detectRecurring(transactions, new Date(), { isVouched }).filter(
      d => !d.stopped && d.payeeKeys.some(payee => isVouched(d.accountId, d.direction, payee))
    );
  }, [transactions, suggestionDismissals]);

  /** The panel's window: the next 30 days, from today wherever the grid is. */
  const dueNext = useMemo(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const until = new Date(from.getTime() + 30 * 86_400_000);
    return projectRecurringSchedule(confirmedPatterns, from, until);
  }, [confirmedPatterns]);

  /** Expected items per day of the VISIBLE month, for the quiet cell marks. */
  const dueByDay = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthStart = new Date(year, month, 1);
    const from = monthStart > today ? monthStart : today;
    const until = new Date(year, month + 1, 0, 23, 59, 59);
    const byDay = new Map<number, number>();
    for (const occurrence of projectRecurringSchedule(confirmedPatterns, from, until)) {
      if (occurrence.date.getMonth() !== month || occurrence.date.getFullYear() !== year) continue;
      const day = occurrence.date.getDate();
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    return byDay;
  }, [confirmedPatterns, year, month]);

  const accountNameById = useMemo(
    () => new Map(accounts.map(a => [a.id, a.name])),
    [accounts]
  );

  /* The due-next panel shows EVERYTHING in its window. It capped at eight
     nearest-by-date with a "show all" door — which buried anything large
     falling later in the month behind a link, in a panel whose one job is
     "what's coming" (Design, 23 Aug §6). The rows are one line each; the
     honest cost of a heavy month is a longer list. */

  /**
   * WEEK / MONTH / YEAR (owner, 19 Aug: "apple style buttons for week /
   * Month / Year on the left hand side of the 'Today' button… If the user
   * clicks on 'week' then the calendar goes to week view and the income and
   * expenses figures above change… If the user presses the back arrow to go
   * to the previous week, then that is what is viewed").
   *
   * The view lives in the URL, the Investments tabs' idiom: a refresh
   * rebuilds state from nothing and the URL is the one thing a refresh
   * keeps — which matters doubly here, where the home-screen app resumes
   * rather than reloads. Month is the default and carries no parameter.
   * `replace`, not push: switching views is not a navigation the back
   * button should replay.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const viewParam = searchParams.get('view');
  const view: 'day' | 'week' | 'month' | 'year' =
    viewParam === 'day' || viewParam === 'week' || viewParam === 'year' ? viewParam : 'month';
  const setView = useCallback((next: 'day' | 'week' | 'month' | 'year'): void => {
    setSearchParams(prev => {
      const params = new URLSearchParams(prev);
      if (next === 'month') params.delete('view');
      else params.set('view', next);
      return params;
    }, { replace: true });
  }, [setSearchParams]);

  /**
   * The stretch of time the page is LOOKING AT — one definition, so the
   * tiles, the title and each view's content can never disagree about it.
   * The week runs Sunday to Saturday, matching the grid's own columns.
   */
  const visibleWindow = useMemo(() => {
    if (view === 'day') {
      const dayStart = new Date(year, month, currentDate.getDate());
      return {
        from: dayStart,
        to: new Date(year, month, currentDate.getDate(), 23, 59, 59, 999),
      };
    }
    if (view === 'week') {
      const start = new Date(year, month, currentDate.getDate() - currentDate.getDay());
      return {
        from: start,
        to: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59, 999),
      };
    }
    if (view === 'year') {
      return { from: new Date(year, 0, 1), to: new Date(year, 11, 31, 23, 59, 59, 999) };
    }
    return { from: new Date(year, month, 1), to: new Date(year, month + 1, 0, 23, 59, 59, 999) };
  }, [view, year, month, currentDate]);

  /**
   * THE TILES SPEAK INCOME AND EXPENDITURE, NOT CASH MOVEMENT (owner,
   * 18 Aug, reading a month whose "Money in" included a six-figure transfer
   * between his own accounts: "These figures are not the figures for one
   * month. It is misleading… they have to at least be correct and match up
   * to what has actually been the user's 'income' and 'expenditure'").
   *
   * They go through the same computeIncomeExpense the dashboard's cards use
   * (transfers and revaluations excluded, splits expanded) — and since the
   * views arrived they cover the VISIBLE WINDOW, whichever it is: step back
   * a week and the figures are that week's (owner, 19 Aug). The day cells
   * stay the honest movement ledger they were; the transaction count stays
   * a movement count over the same window.
   */
  const windowSummary = useMemo(() => {
    const flows = computeIncomeExpense(transactions, transactionSplits, categories, { ...visibleWindow, convert });
    const count = transactions.filter(t => {
      const time = new Date(t.date).getTime();
      return time >= visibleWindow.from.getTime() && time <= visibleWindow.to.getTime();
    }).length;
    return {
      totalIncome: flows.income.toNumber(),
      totalExpense: flows.expenses.toNumber(),
      totalTransactions: count,
    };
  }, [transactions, transactionSplits, categories, visibleWindow, convert]);

  /**
   * THE WEEK, BY CATEGORY, split income from expenditure (owner, 18 Aug:
   * "in weekly, it should show by category, separated by income and
   * expenditure"). Labels come from the register's own labeller, so a
   * category reads here exactly as its column reads there — and the
   * uncategorised remainder is NAMED, never folded silently into a figure
   * that would then claim to be complete.
   */
  /** One labeller and one kind-lookup, shared by every breakdown below. */
  const labeller = useMemo(() => createCategoryLabeller(categories, accounts), [categories, accounts]);
  const categoryKinds = useMemo(() => buildCategoryKindLookup(categories), [categories]);

  const weekBreakdown = useMemo(() => {
    if (view !== 'week') return null;
    const flows = computeIncomeExpense(transactions, transactionSplits, categories, { ...visibleWindow, convert });
    const label = labeller;
    const grouped = (rows: typeof flows.incomeRows): Array<{ label: string; total: number }> => {
      const totals = new Map<string, ReturnType<typeof toDecimal>>();
      for (const row of rows) {
        const key = label(row) || 'Uncategorised';
        totals.set(key, (totals.get(key) ?? toDecimal(0)).plus(toDecimal(row.amount).abs()));
      }
      return [...totals.entries()]
        .map(([name, total]) => ({ label: name, total: total.toNumber() }))
        .sort((a, b) => b.total - a.total);
    };
    return {
      income: grouped(flows.incomeRows),
      expense: grouped(flows.expenseRows),
      uncategorizedIn: flows.uncategorizedIn.toNumber(),
      uncategorizedOut: flows.uncategorizedOut.toNumber(),
    };
  }, [view, transactions, transactionSplits, categories, labeller, visibleWindow, convert]);

  /**
   * THE YEAR AS TWELVE MONTHS, each with its own income and expenditure,
   * each a door into that month's view. Computed only while the year is on
   * screen — twelve passes over the ledger is a cost the other views never
   * pay.
   */
  const yearMonths = useMemo(() => {
    if (view !== 'year') return null;
    return Array.from({ length: 12 }, (_, m) => {
      const flows = computeIncomeExpense(transactions, transactionSplits, categories, {
        convert,
        from: new Date(year, m, 1),
        to: new Date(year, m + 1, 0, 23, 59, 59, 999),
      });
      return { month: m, income: flows.income.toNumber(), expense: flows.expenses.toNumber() };
    });
  }, [view, transactions, transactionSplits, categories, year, convert]);

  /**
   * THE DAY, TRANSACTION BY TRANSACTION (owner, 18 Aug: "in daily view…
   * each transaction for that day, again, separated by income and
   * expenditure"). Real rows, not split expansions — a click opens the real
   * editor, and only a real transaction can be edited. The rows that are
   * NEITHER income nor expenditure are shown under their own named headings
   * rather than dropped: a day the cell counted at 38 movements must show
   * 38, or say which are transfers and which are unfiled.
   */
  const dayRows = useMemo(() => {
    if (view !== 'day') return null;
    const rows = transactions
      .filter(t => {
        const time = new Date(t.date).getTime();
        return time >= visibleWindow.from.getTime() && time <= visibleWindow.to.getTime();
      })
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const groups = { income: [] as Transaction[], expense: [] as Transaction[], transfer: [] as Transaction[], uncategorized: [] as Transaction[] };
    for (const row of rows) {
      const kind = classifyFlow(row, categoryKinds);
      if (kind === 'income') groups.income.push(row);
      else if (kind === 'expense') groups.expense.push(row);
      else if (kind === 'transfer') groups.transfer.push(row);
      // Revaluations are ledger arithmetic, not spending; they sit with the
      // unfiled so the day still accounts for every movement it counted.
      else groups.uncategorized.push(row);
    }
    return groups;
  }, [view, transactions, visibleWindow, categoryKinds]);

  /**
   * THE DRILL (owner, 18 Aug: "Month view, income and expenditure, click
   * either and get a pop up with a list of the categories and their
   * respective totals that make up the totals… and then click in to a
   * category and get the individual transactions").
   *
   * The scope is a WINDOW plus a DIRECTION — a day's money in, a week's
   * money out — and the first level decomposes the cell's own movement
   * figure exactly: categories, then transfers and the unfiled as NAMED
   * lines, so the list sums to the figure that was clicked rather than to
   * some quietly different one.
   */
  const [drill, setDrill] = useState<{
    from: Date; to: Date; label: string;
    bucket: 'in' | 'out' | 'net';
    /**
     * 'movement' decomposes a day cell's cash-movement figure (transfers and
     * the unfiled as named lines). 'flows' decomposes an Income/Expenditure/
     * Net TILE — the computeIncomeExpense figure, where transfers,
     * revaluations and the unfiled are not part of the number, so they are
     * not part of the list either; totals are SIGNED so a refund-heavy
     * category reads honestly and the list still sums to the tile.
     */
    scope: 'movement' | 'flows';
  } | null>(null);
  const [drillCategory, setDrillCategory] = useState<string | null>(null);
  const closeDrill = (): void => { setDrill(null); setDrillCategory(null); };

  const TRANSFERS_LABEL = 'Transfers between your accounts';
  const UNFILED_LABEL = 'Uncategorised — not yet filed';

  const drillData = useMemo(() => {
    if (!drill) return null;

    if (drill.scope === 'flows') {
      // The tiles' own arithmetic, re-run over the drill's window — the one
      // way the list can sum to the figure that was clicked (splits expanded,
      // refunds netting, exactly as the tile counted them).
      const flows = computeIncomeExpense(transactions, transactionSplits, categories, {
        convert,
        from: drill.from, to: drill.to,
      });
      const rows =
        drill.bucket === 'in' ? flows.incomeRows
        : drill.bucket === 'out' ? flows.expenseRows
        : [...flows.incomeRows, ...flows.expenseRows];
      const groups = new Map<string, { total: number; rows: SplitExpandedTransaction[] }>();
      for (const row of rows) {
        const key = labeller(row) || UNFILED_LABEL;
        const group = groups.get(key) ?? { total: 0, rows: [] };
        group.total = toDecimal(group.total).plus(toDecimal(row.amount)).toNumber();
        group.rows.push(row);
        groups.set(key, group);
      }
      return [...groups.entries()]
        .map(([label, group]) => ({ label, ...group }))
        .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    }

    const rows = transactions.filter(t => {
      const time = new Date(t.date).getTime();
      if (time < drill.from.getTime() || time > drill.to.getTime()) return false;
      return drill.bucket === 'in' ? t.amount > 0 : t.amount < 0;
    });
    const groups = new Map<string, { total: number; rows: SplitExpandedTransaction[] }>();
    for (const row of rows) {
      const kind = classifyFlow(row, categoryKinds);
      const key =
        kind === 'transfer' ? TRANSFERS_LABEL
        : kind === 'uncategorized' ? UNFILED_LABEL
        : kind === 'revaluation' ? 'Revaluation'
        : (labeller(row) || UNFILED_LABEL);
      const group = groups.get(key) ?? { total: 0, rows: [] };
      group.total = toDecimal(group.total).plus(toDecimal(row.amount).abs()).toNumber();
      group.rows.push(row);
      groups.set(key, group);
    }
    // Categories by size; the named remainders always last, in a fixed order.
    const remainders = [TRANSFERS_LABEL, UNFILED_LABEL, 'Revaluation'];
    return [...groups.entries()]
      .map(([label, group]) => ({ label, ...group }))
      .sort((a, b) => {
        const ra = remainders.indexOf(a.label);
        const rb = remainders.indexOf(b.label);
        if (ra !== -1 || rb !== -1) return (ra === -1 ? -1 : ra + 1) - (rb === -1 ? -1 : rb + 1);
        return b.total - a.total;
      });
  }, [drill, transactions, transactionSplits, categories, categoryKinds, labeller, convert]);

  /** The real editor, over whichever row was clicked in a day or a drill. */
  const [editing, setEditing] = useState<Transaction | null>(null);

  /**
   * The daily net-worth line, OFF by default (owner, 18 Aug: "I dont think
   * we need to see daily net worth as a default but happy for it to be a
   * toggle"). A display preference, so it lives where the period picker's
   * does — localStorage — and survives the session without touching the
   * ledger.
   */
  const [showNetWorth, setShowNetWorth] = useState<boolean>(
    () => localStorage.getItem('calendar-show-net-worth') === 'true'
  );
  const toggleNetWorth = (): void => {
    setShowNetWorth(previous => {
      localStorage.setItem('calendar-show-net-worth', String(!previous));
      return !previous;
    });
  };

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const goToToday = () => setCurrentDate(new Date());
  /** One step of whatever the view counts in: a week, a month, a year. */
  const step = (direction: 1 | -1): void => {
    if (view === 'day') setCurrentDate(new Date(year, month, currentDate.getDate() + direction));
    else if (view === 'week') setCurrentDate(new Date(year, month, currentDate.getDate() + 7 * direction));
    else if (view === 'year') setCurrentDate(new Date(year + direction, month, 1));
    else setCurrentDate(new Date(year, month + direction, 1));
  };

  /** "10–16 August 2026", crossing a month or a year honestly when it does. */
  const weekTitle = (): string => {
    const { from, to } = visibleWindow;
    const locale = getDateLocale();
    if (from.getMonth() === to.getMonth()) {
      return `${from.getDate()}–${to.getDate()} ${from.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}`;
    }
    const fromText = from.toLocaleDateString(locale, {
      day: 'numeric', month: 'short',
      ...(from.getFullYear() !== to.getFullYear() ? { year: 'numeric' } : {}),
    });
    return `${fromText} – ${to.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  };

  /**
   * "What was that day made of?" — answered in Find, dated to the day.
   *
   * It used to point at `/transactions?dateFrom=…&dateTo=…`, and that link had
   * never worked: the global list read one parameter, `?account=`, so the day
   * you clicked was thrown away and you arrived at the whole ledger. Find reads
   * the range, shows it, and offers a way to clear it — so the same click now
   * does what it always said it did.
   */
  const handleDayClick = (day: DayData) => {
    if (day.transactionCount > 0) {
      const dateStr = `${day.date.getFullYear()}-${String(day.date.getMonth() + 1).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
      navigate(preserveDemoParam(`/find?dateFrom=${dateStr}&dateTo=${dateStr}`, location.search));
    }
  };

  /** The visible window's name — the header's title, and the drills' label. */
  const windowTitle =
    view === 'year' ? String(year)
      : view === 'week' ? weekTitle()
      : view === 'day' ? currentDate.toLocaleDateString(getDateLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : `${monthNames[month]} ${year}`;

  /** A summary tile opens the drill on its own figure (owner, 19 Aug). */
  const openFlowDrill = (bucket: 'in' | 'out' | 'net'): void =>
    setDrill({ from: visibleWindow.from, to: visibleWindow.to, label: windowTitle, bucket, scope: 'flows' });

  return (
    <PageWrapper title="Calendar">
      {/* The ladder (the long tail's conversion, 23 Aug): with the history
          in force each movement converts at its own day and the running
          balance values each day at that day's rate — the line says so;
          while it is absent the totals stay native and the Phase 0
          disclosure stands. Nothing for a single-currency ledger. */}
      {flowsHistorical ? (
        <p className="mb-3 text-dense text-gray-500 dark:text-gray-400" data-testid="calendar-rates-basis">
          ≈ Converted at each day’s ECB reference rate. Weekends and holidays carry
          the previous business day’s rate.
        </p>
      ) : (
        <MixedCurrencyDisclosure className="mb-3" />
      )}
      {/* Month summary bar — each figure tile is a DRILL into what made it
          up, the same popup the day cells open (owner, 19 Aug: "the
          'Income' / 'Expenditure' / 'Net' should be clickable"). */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <button
          type="button"
          onClick={() => openFlowDrill('in')}
          className="block w-full bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700 px-4 py-2 text-left hover:border-gray-300 dark:hover:border-gray-500 transition-colors"
        >
          <span className="text-sm text-gray-500 dark:text-gray-400">Income</span>
          <p className="text-lg font-semibold text-green-600 dark:text-green-400">{formatCurrency(windowSummary.totalIncome)}</p>
        </button>
        <button
          type="button"
          onClick={() => openFlowDrill('out')}
          className="block w-full bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700 px-4 py-2 text-left hover:border-gray-300 dark:hover:border-gray-500 transition-colors"
        >
          <span className="text-sm text-gray-500 dark:text-gray-400">Expenditure</span>
          {/* `dark:text-red-400` is not decoration — without it this figure is
              unreadable at night. `styles/accessibility-colors.css` remaps
              `.text-red-600` to the brand expense red (#c9304a) with
              `!important` and publishes NO dark-mode counterpart; the dark
              handling lives entirely in `.dark .dark\:text-red-400`, which only
              applies to elements that carry that class. So a bare
              `text-red-600` paints #c9304a on a gray-800 card in dark mode —
              measured 2.8:1, against the 4.5:1 text needs. The income figure
              four lines up has carried the pair all along, which is why only
              the expense went dark. */}
          {/* Through formatCurrency as a NEGATIVE, so it wears the app-wide
              (£X) — a red figure without its brackets was the drift the
              owner caught on this very tile. */}
          <p className="text-lg font-semibold text-red-600 dark:text-red-400">{formatCurrency(-windowSummary.totalExpense)}</p>
        </button>
        <button
          type="button"
          onClick={() => openFlowDrill('net')}
          className="block w-full bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700 px-4 py-2 text-left hover:border-gray-300 dark:hover:border-gray-500 transition-colors"
        >
          <span className="text-sm text-gray-500 dark:text-gray-400">Net</span>
          <p className={`text-lg font-semibold ${toDecimal(windowSummary.totalIncome).minus(toDecimal(windowSummary.totalExpense)).greaterThanOrEqualTo(0) ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {formatCurrency(toDecimal(windowSummary.totalIncome).minus(toDecimal(windowSummary.totalExpense)).toNumber())}
          </p>
        </button>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700 px-4 py-2">
          <span className="text-sm text-gray-500 dark:text-gray-400">Transactions</span>
          <p className="text-lg font-semibold text-gray-900 dark:text-white">{windowSummary.totalTransactions}</p>
        </div>
      </div>

      {/* ─ DUE NEXT — the forward panel (Design handover §1, §8 step 3) ────
          Confirmed patterns only, and it says so: an unconfirmed detection
          is an opinion and never sits here looking like a payment that will
          happen. Every figure is an EXPECTATION — neutral, worded "due",
          never joining the actual-money hues around it (P8: an inference is
          not a figure the user entered). */}
      <section
        aria-labelledby="due-next-heading"
        className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700 px-4 py-3 mb-4"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="due-next-heading" className="text-sm font-semibold text-gray-900 dark:text-white">
            Due in the next 30 days
            {dueNext.length > 0 && (
              <span className="ml-2 text-xs font-normal text-gray-400 dark:text-gray-500">
                {dueNext.length}
              </span>
            )}
          </h2>
          <span className="text-xs text-gray-400 dark:text-gray-500">
            Only patterns you have confirmed on{' '}
            <Link
              to={preserveDemoParam('/recurring-payments', location.search)}
              className="text-primary hover:underline"
            >
              What I&rsquo;m committed to
            </Link>
          </span>
        </div>
        {dueNext.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Nothing confirmed yet — open{' '}
            <Link
              to={preserveDemoParam('/recurring-payments', location.search)}
              className="text-primary hover:underline"
            >
              Recurring Payments
            </Link>
            {' '}under Plan and confirm a pattern: it appears here before it
            falls due. You can also mark any payment in a register as
            recurring.
          </p>
        ) : (
          <>
            <ul className="mt-2 divide-y divide-gray-50 dark:divide-gray-700/50">
              {dueNext.map((occurrence) => (
                <li
                  key={`${occurrence.detection.key}-${occurrence.date.getTime()}`}
                  className="py-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5"
                >
                  <span className="min-w-0 flex items-baseline gap-2">
                    <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400 w-14 shrink-0">
                      {occurrence.date.toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'short' })}
                    </span>
                    <span className="text-sm text-gray-900 dark:text-white truncate">
                      {occurrence.detection.description}
                    </span>
                    {accountNameById.get(occurrence.detection.accountId) && (
                      <span className="text-xs text-gray-400 dark:text-gray-500 truncate">
                        {accountNameById.get(occurrence.detection.accountId)}
                      </span>
                    )}
                  </span>
                  {/* An expected OUTGOING wears the expense convention —
                      red, (£X) — like every other expense figure in the app
                      (owner, 18 Aug). Expected income is green with its +. */}
                  <span className={`text-sm tabular-nums shrink-0 ${
                    occurrence.detection.direction === 'out'
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-green-600 dark:text-green-400'
                  }`}>
                    {occurrence.detection.direction === 'out'
                      ? formatCurrency(-occurrence.amount.toNumber())
                      : `+${formatCurrency(occurrence.amount.toNumber())}`}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* Calendar header with navigation */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        {/* WRAPS, AND THE ARROWS TRAVEL WITH THE TITLE.

            On a 375px phone this row measured 524px wide inside a card that
            is `overflow-hidden`, so it was CLIPPED rather than wrapped or
            scrolled: Today and both navigation arrows were simply
            unreachable, and a calendar you cannot page is not a calendar.
            (Found by measurement in the mobile sweep, 24 Aug — the row looks
            fine at every desktop width, which is why it survived.)

            Two changes, and the second is the one that makes it fit: the row
            wraps, and the arrows move to flank the title they move — the
            pattern every calendar app uses on a phone, and the pair that
            actually belongs together. The owner's 19 Aug ruling governs the
            OTHER pair ("apple style buttons for week / Month / Year on the
            left hand side of the 'Today' button") and is untouched: those
            two stay adjacent, in that order, and now wrap as one unit. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 sm:px-6 py-4 border-b border-gray-100 dark:border-gray-700">
          <div className="flex items-center gap-1 min-w-0">
            <button
              onClick={() => step(-1)}
              className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex-shrink-0"
              aria-label={`Previous ${view}`}
            >
              <ChevronLeftIcon size={20} className="text-gray-600 dark:text-gray-400" />
            </button>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white truncate">
              {windowTitle}
            </h2>
            <button
              onClick={() => step(1)}
              className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex-shrink-0"
              aria-label={`Next ${view}`}
            >
              <ChevronRightIcon size={20} className="text-gray-600 dark:text-gray-400" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            {/* The view, chosen the way Apple Calendar chooses it — a
                segmented control beside Today (owner, 19 Aug). The chosen
                segment presses in; the URL carries it (see setView). */}
            <div className="flex items-center rounded-lg bg-gray-100 dark:bg-gray-700 p-0.5" role="group" aria-label="Calendar view">
              {(['day', 'week', 'month', 'year'] as const).map(option => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setView(option)}
                  aria-pressed={view === option}
                  className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                    view === option
                      ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100'
                  }`}
                >
                  {option === 'day' ? 'Day' : option === 'week' ? 'Week' : option === 'month' ? 'Month' : 'Year'}
                </button>
              ))}
            </div>
            <button
              onClick={goToToday}
              className="px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              Today
            </button>
          </div>
        </div>

        {/* Display choices, every view: whole pounds always; the daily
            net-worth line is month-view's own (owner: not a default). */}
        <div className="flex justify-end items-center gap-4 px-4 py-1.5 border-b border-gray-100 dark:border-gray-700">
          <NegativesInRedToggle />
          <WholePoundsToggle />
          {view === 'month' && (
            <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={showNetWorth}
                onChange={toggleNetWorth}
                className="rounded border-gray-300 dark:border-gray-600"
              />
              Daily net worth
            </label>
          )}
        </div>
        {view === 'month' && (<>
        {/* Day headers */}
        <div className="grid grid-cols-7 border-b border-gray-100 dark:border-gray-700">
          {dayNames.map(day => (
            <div key={day} className="px-2 py-2 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              {day}
            </div>
          ))}
        </div>

        {/* Calendar grid. Plain CSS grid — no ARIA grid role (that requires a
            strict grid>row>gridcell tree and arrow-key navigation; days with
            transactions are real buttons instead, so keyboard users can open
            them with Tab + Enter). */}
        <div className="grid grid-cols-7" aria-label="Financial calendar">
          {calendarData.map((day, i) => (
            <div
              key={i}
              onClick={day.transactionCount > 0 ? () => handleDayClick(day) : undefined}
              role={day.transactionCount > 0 ? 'button' : undefined}
              tabIndex={day.transactionCount > 0 ? 0 : undefined}
              aria-label={day.transactionCount > 0
                ? `Day ${day.day}, ${day.transactionCount} transaction${day.transactionCount === 1 ? '' : 's'}`
                : undefined}
              onKeyDown={day.transactionCount > 0 ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleDayClick(day);
                }
              } : undefined}
              /* THE CELL'S OWN TODAY-RING. The 24 Aug ruling moved the day
                 NUMBER below to the primary-action pair and this stroke was
                 missed beside it, so a stock blue outlived "the last blue fill
                 outside links" by one selector. `ring-primary` is the house
                 answer for a ring that marks a state, and index.css remaps it
                 to the focus family's slate on dark, where the navy would be
                 no ring at all. */
              className={`
                min-h-[60px] sm:min-h-[100px] p-1 sm:p-2 border-b border-r border-gray-50 dark:border-gray-700/50
                ${!day.isCurrentMonth ? 'bg-gray-50 dark:bg-gray-800/50 opacity-40' : 'bg-white dark:bg-gray-800'}
                ${day.isToday ? 'ring-2 ring-inset ring-primary' : ''}
                ${day.transactionCount > 0 ?'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50':''}
                transition-colors
              `}
            >
              {/* Day number. The transaction COUNT used to share this row,
                  competing with the date for the corner at nearly its size —
                  but the count is how many, not how much, the least useful
                  figure in the cell. It sits at the bottom in caption size
                  now; the amounts are the day's story (Design, 23 Aug §5). */}
              <div className="mb-1">
                <span className={`text-sm font-medium ${
                  day.isToday
                    // TODAY wears the primary-action pair, not a stock blue —
                    // the last blue fill outside links (Design, 24 Aug §4):
                    // navy circle in light, the near-white inversion in dark.
                    ? 'bg-primary-action text-on-primary-action w-6 h-6 rounded-full flex items-center justify-center text-xs'
                    : day.isCurrentMonth
                      ? 'text-gray-900 dark:text-gray-200'
                      : 'text-gray-400 dark:text-gray-600'
                }`}>
                  {day.day}
                </span>
              </div>

              {/* Movement figures — each a door into what composed it
                  (owner: "click either and get a pop up with a list of the
                  categories"). stopPropagation keeps the figure's click from
                  also being the cell's open-in-Find click. */}
              {day.isCurrentMonth && day.income > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDrill({
                      from: new Date(day.date.getFullYear(), day.date.getMonth(), day.day),
                      to: new Date(day.date.getFullYear(), day.date.getMonth(), day.day, 23, 59, 59, 999),
                      label: day.date.toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'long' }),
                      bucket: 'in',
                      scope: 'movement',
                    });
                  }}
                  aria-label={`Money in, day ${day.day} — what made it up`}
                  className="block w-full text-left text-xs text-green-600 dark:text-green-400 font-medium truncate hover:underline"
                >
                  +{formatCurrency(day.income)}
                </button>
              )}
              {day.isCurrentMonth && day.expense > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDrill({
                      from: new Date(day.date.getFullYear(), day.date.getMonth(), day.day),
                      to: new Date(day.date.getFullYear(), day.date.getMonth(), day.day, 23, 59, 59, 999),
                      label: day.date.toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'long' }),
                      bucket: 'out',
                      scope: 'movement',
                    });
                  }}
                  aria-label={`Money out, day ${day.day} — what made it up`}
                  className="block w-full text-left text-xs text-red-500 dark:text-red-400 font-medium truncate hover:underline"
                >
                  ({formatCurrency(day.expense)})
                </button>
              )}

              {/* The count, demoted to a bottom caption (Design, 23 Aug §5):
                  a cell too narrow for the word keeps the bare figure, so the
                  full phrase rides on title and the accessible name. */}
              {day.isCurrentMonth && day.transactionCount > 0 && (
                <span
                  className="mt-auto pt-0.5 text-[10px] leading-tight text-gray-400 dark:text-gray-500"
                  title={`${day.transactionCount} transaction${day.transactionCount === 1 ? '' : 's'}`}
                  aria-label={`${day.transactionCount} transaction${day.transactionCount === 1 ? '' : 's'}`}
                >
                  {day.transactionCount}
                </span>
              )}

              {/* Running balance at bottom — only when asked for. */}
              {showNetWorth && day.isCurrentMonth && day.transactionCount > 0 && (
                <div className={`text-xs pt-1 font-medium truncate ${
                  day.runningBalance < 0 ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'
                }`}>
                  {formatCurrency(day.runningBalance)}
                </div>
              )}

              {/* EXPECTED, not happened: confirmed patterns falling due on
                  this day. Neutral and worded, deliberately nothing like the
                  actual-money figures above — an inference on a calendar must
                  never read as a transaction (P8). The panel above the grid
                  carries the detail. */}
              {day.isCurrentMonth && (dueByDay.get(day.day) ?? 0) > 0 && (
                <div className="text-[10px] text-gray-400 dark:text-gray-500 truncate">
                  {dueByDay.get(day.day)} due
                </div>
              )}
            </div>
          ))}
        </div>
        </>)}

        {/* THE WEEK, BY CATEGORY — income one side, expenditure the other
            (owner, 18 Aug). Every category figure is a sum of that week's
            rows; the uncategorised remainder is named rather than folded in. */}
        {view === 'week' && weekBreakdown && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-gray-100 dark:bg-gray-700" aria-label="Week by category">
            <div className="bg-white dark:bg-gray-800 p-4 sm:p-6">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Income</h3>
              {weekBreakdown.income.length === 0 && weekBreakdown.uncategorizedIn === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">No income recorded this week.</p>
              ) : (
                <ul>
                  {weekBreakdown.income.map(row => (
                    <li key={row.label} className="border-t border-gray-50 dark:border-gray-700/50 first:border-0">
                      <button
                        type="button"
                        onClick={() => {
                          setDrill({ ...visibleWindow, label: weekTitle(), bucket: 'in', scope: 'movement' });
                          setDrillCategory(row.label);
                        }}
                        className="w-full py-1.5 flex items-baseline justify-between gap-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40 rounded"
                      >
                        <span className="text-sm text-gray-900 dark:text-white truncate">{row.label}</span>
                        <span className="text-sm tabular-nums text-green-600 dark:text-green-400 shrink-0">
                          +{formatCurrency(row.total)}
                        </span>
                      </button>
                    </li>
                  ))}
                  {weekBreakdown.uncategorizedIn > 0 && (
                    <li className="py-1.5 flex items-baseline justify-between gap-4 border-t border-gray-50 dark:border-gray-700/50">
                      <span className="text-sm text-gray-500 dark:text-gray-400">Uncategorised — not yet filed</span>
                      <span className="text-sm tabular-nums text-gray-500 dark:text-gray-400 shrink-0">
                        +{formatCurrency(weekBreakdown.uncategorizedIn)}
                      </span>
                    </li>
                  )}
                </ul>
              )}
            </div>
            <div className="bg-white dark:bg-gray-800 p-4 sm:p-6">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Expenditure</h3>
              {weekBreakdown.expense.length === 0 && weekBreakdown.uncategorizedOut === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">No expenditure recorded this week.</p>
              ) : (
                <ul>
                  {weekBreakdown.expense.map(row => (
                    <li key={row.label} className="border-t border-gray-50 dark:border-gray-700/50 first:border-0">
                      <button
                        type="button"
                        onClick={() => {
                          setDrill({ ...visibleWindow, label: weekTitle(), bucket: 'out', scope: 'movement' });
                          setDrillCategory(row.label);
                        }}
                        className="w-full py-1.5 flex items-baseline justify-between gap-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40 rounded"
                      >
                        <span className="text-sm text-gray-900 dark:text-white truncate">{row.label}</span>
                        <span className="text-sm tabular-nums text-red-600 dark:text-red-400 shrink-0">
                          {formatCurrency(-row.total)}
                        </span>
                      </button>
                    </li>
                  ))}
                  {weekBreakdown.uncategorizedOut > 0 && (
                    <li className="py-1.5 flex items-baseline justify-between gap-4 border-t border-gray-50 dark:border-gray-700/50">
                      <span className="text-sm text-gray-500 dark:text-gray-400">Uncategorised — not yet filed</span>
                      <span className="text-sm tabular-nums text-gray-500 dark:text-gray-400 shrink-0">
                        {formatCurrency(-weekBreakdown.uncategorizedOut)}
                      </span>
                    </li>
                  )}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* THE DAY, TRANSACTION BY TRANSACTION — each row opens the real
            editor. What is neither income nor spending sits under its own
            named heading rather than vanishing. */}
        {view === 'day' && dayRows && (
          <div className="p-4 sm:p-6 space-y-6" aria-label="Day by transaction">
            {([
              { key: 'income', title: 'Income', rows: dayRows.income },
              { key: 'expense', title: 'Expenditure', rows: dayRows.expense },
              { key: 'transfer', title: TRANSFERS_LABEL, rows: dayRows.transfer },
              { key: 'uncategorized', title: UNFILED_LABEL, rows: dayRows.uncategorized },
            ] as const).map(section => (
              (section.key === 'income' || section.key === 'expense' || section.rows.length > 0) && (
                <div key={section.key}>
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">
                    {section.title}
                    {section.rows.length > 0 && (
                      <span className="ml-2 text-xs font-normal text-gray-400 dark:text-gray-500">{section.rows.length}</span>
                    )}
                  </h3>
                  {section.rows.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {section.key === 'income' ? 'No income recorded this day.' : 'No expenditure recorded this day.'}
                    </p>
                  ) : (
                    <ul>
                      {section.rows.map(row => (
                        <li key={row.id} className="border-t border-gray-50 dark:border-gray-700/50 first:border-0">
                          <button
                            type="button"
                            onClick={() => setEditing(row)}
                            className="w-full py-2 flex items-baseline justify-between gap-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40 rounded"
                          >
                            <span className="min-w-0">
                              <span className="block text-sm text-gray-900 dark:text-white truncate">{row.description}</span>
                              <span className="block text-xs text-gray-500 dark:text-gray-400 truncate">
                                {labeller(row) || 'Uncategorised'}
                                {accountNameById.get(row.accountId) && <> · {accountNameById.get(row.accountId)}</>}
                              </span>
                            </span>
                            <span className={`text-sm tabular-nums shrink-0 ${
                              section.key === 'transfer' || section.key === 'uncategorized'
                                ? negativeTone(row.amount, 'text-gray-600 dark:text-gray-300')
                                : row.amount >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                            }`}>
                              {row.amount >= 0 ? `+${formatCurrency(row.amount)}` : formatCurrency(row.amount)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            ))}
          </div>
        )}

        {/* THE YEAR AS TWELVE MONTHS, each a door into its month view. */}
        {view === 'year' && yearMonths && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-px bg-gray-100 dark:bg-gray-700" aria-label="Year by month">
            {/* Each cell's `flex flex-col items-start` is LOAD-BEARING:
                index.css sets `button { display: inline-flex }` globally —
                ROW direction — so without it the month name and both figures
                sat crammed on one line (the owner caught it on this very
                grid; the sixth casualty of that global rule). NEUTRAL AT
                ZERO like the dashboard cards: an empty month claims no
                direction, so it wears neither hue nor sign. */}
            {yearMonths.map(({ month: m, income, expense }) => (
              <button
                key={m}
                type="button"
                onClick={() => { setCurrentDate(new Date(year, m, 1)); setView('month'); }}
                className="flex flex-col items-start bg-white dark:bg-gray-800 p-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/60 transition-colors"
                aria-label={`Open ${monthNames[m]} ${year}`}
              >
                <p className="text-sm font-semibold text-gray-900 dark:text-white">{monthNames[m]}</p>
                <p className={`text-sm tabular-nums mt-1 ${
                  income === 0 ? 'text-gray-500 dark:text-gray-400' : 'text-green-600 dark:text-green-400'
                }`}>
                  {income === 0 ? formatCurrency(0) : `+${formatCurrency(income)}`}
                </p>
                <p className={`text-sm tabular-nums ${
                  expense === 0 ? 'text-gray-500 dark:text-gray-400' : 'text-red-600 dark:text-red-400'
                }`}>
                  {formatCurrency(-expense)}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* THE DRILL — level one is the categories that composed the clicked
          figure (transfers and the unfiled as named lines, so the list sums
          to the figure that was clicked); level two is one category's own
          rows, each openable in the real editor. */}
      <Modal
        isOpen={drill !== null}
        onClose={closeDrill}
        title={drill
          ? `${
            drill.scope === 'flows'
              ? drill.bucket === 'in' ? 'Income' : drill.bucket === 'out' ? 'Expenditure' : 'Net'
              : drill.bucket === 'in' ? 'Money in' : 'Money out'
          } — ${drill.label}${drillCategory ? ` — ${drillCategory}` : ''}`
          : ''}
        size="md"
      >
        <ModalBody>
          {drill && drillData && drillCategory === null && (
            drillData.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">Nothing recorded in this stretch.</p>
            ) : (
              <ul>
                {drillData.map(group => (
                  <li key={group.label} className="border-t border-gray-50 dark:border-gray-700/50 first:border-0">
                    <button
                      type="button"
                      onClick={() => setDrillCategory(group.label)}
                      className="w-full py-2 flex items-baseline justify-between gap-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40 rounded"
                    >
                      <span className="text-sm text-gray-900 dark:text-white truncate">
                        {group.label}
                        <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">{group.rows.length}</span>
                      </span>
                      {/* Movement totals are magnitudes worn by the bucket;
                          a flows drill's are SIGNED, so a refund-heavy
                          category shows its real direction. */}
                      {drill.scope === 'flows' ? (
                        <span className={`text-sm tabular-nums shrink-0 ${
                          group.total >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                        }`}>
                          {group.total >= 0 ? `+${formatCurrency(group.total)}` : formatCurrency(group.total)}
                        </span>
                      ) : (
                        <span className={`text-sm tabular-nums shrink-0 ${
                          drill.bucket === 'in' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                        }`}>
                          {drill.bucket === 'in' ? `+${formatCurrency(group.total)}` : formatCurrency(-group.total)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}
          {drill && drillData && drillCategory !== null && (() => {
            const group = drillData.find(candidate => candidate.label === drillCategory);
            return (
              <>
                <button
                  type="button"
                  onClick={() => setDrillCategory(null)}
                  className="mb-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:underline"
                >
                  ← All categories
                </button>
                {!group || group.rows.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Nothing under this category in this stretch.
                  </p>
                ) : (
                  <ul>
                    {group.rows.map(row => (
                      <li key={row.id} className="border-t border-gray-50 dark:border-gray-700/50 first:border-0">
                        <button
                          type="button"
                          onClick={() => {
                            // A flows drill can list a VIRTUAL split line;
                            // the editor opens the real transaction it
                            // belongs to, never the projection.
                            setEditing(
                              row.splitParentId
                                ? transactions.find(t => t.id === row.splitParentId) ?? row
                                : row
                            );
                          }}
                          className="w-full py-2 flex items-baseline justify-between gap-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40 rounded"
                        >
                          <span className="min-w-0">
                            <span className="block text-sm text-gray-900 dark:text-white truncate">{row.description}</span>
                            <span className="block text-xs text-gray-500 dark:text-gray-400">
                              {new Date(row.date).toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'short' })}
                              {accountNameById.get(row.accountId) && <> · {accountNameById.get(row.accountId)}</>}
                            </span>
                          </span>
                          <span className={`text-sm tabular-nums shrink-0 ${
                            row.amount >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                          }`}>
                            {row.amount >= 0 ? `+${formatCurrency(row.amount)}` : formatCurrency(row.amount)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            );
          })()}
        </ModalBody>
      </Modal>

      {/* The REAL editor, over whichever row was clicked — the same one the
          register opens, so a calendar edit is a register edit. */}
      {editing && (
        <EditTransactionModal
          isOpen
          onClose={() => setEditing(null)}
          transaction={editing}
        />
      )}

      <PageTip
        id="calendar-intro"
        title="Your financial calendar"
        description="See money moving in and out laid out by day, like a bank statement — transfers included. Click any day with transactions to view the details. Green amounts are money in, amounts in parentheses are money out."
      />
    </PageWrapper>
  );
}
