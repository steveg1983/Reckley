import React, { useMemo, useState } from 'react';
import { Modal, ModalBody, ModalFooter } from './common/Modal';
import { useApp } from '../contexts/AppContextSupabase';
import { useToast } from '../contexts/ToastContext';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import { ChevronDownIcon, ChevronRightIcon } from './icons';
import {
  boxFigure,
  budgetHistoryWindow,
  buildWizardRows,
  clampCustomWindow,
  describePaidOnce,
  groupWizardRows,
  planBudgetWrites,
  runFromDate,
  runFromOptions,
  summariseForWizard,
  totalBudgeted,
  twinFigure,
  wizardBoxValue,
  type BudgetMode,
  type RunFromKind,
  type SpendWindowCustom,
  type WizardEntry,
  type WizardGroup,
  type WizardRow,
  type WizardWindowKind,
} from '../utils/budgetWizardPlan';
import { parseMoneyInput, toDecimal, type DecimalInstance } from '../utils/decimal';

/**
 * THE BUDGET WIZARD — three questions, one apply.
 *
 * The owner's ruling (31 Aug 2026): a budget is a PROPERTY of a category, not
 * a separate object that shares its name. There is one object and two lenses
 * onto it — Manage → Categories says WHAT IS SET, the Budget page says HOW IT
 * IS GOING — and this is the door that writes them in bulk.
 *
 * Storage is unchanged: the `budgets` table, keyed by category_id, the same
 * rows the Budget page has always read. The unification is in the UI, which is
 * why there is no migration attached to any of this.
 *
 * ── WHY THREE STEPS AND NOT ONE SCREEN ─────────────────────────────────────
 * This replaces a single-screen version of the same job. The steps exist
 * because the three questions are of genuinely different kinds and mixing them
 * is what made the one screen hard to finish:
 *
 *   1. HOW DO YOU THINK? Months or years. Asked once, for the whole screen,
 *      because a page mixing £500-a-month rows with £6,000-a-year rows cannot
 *      be totalled or compared — and totalling is most of what step 3 is for.
 *      It chooses only which column takes TYPING; both figures are always
 *      shown on every row, and changing your mind CONVERTS what you have
 *      already typed rather than re-reading it (owner, 2 Sep 2026: "Yes, it
 *      should convert") — see `chooseMode` and utils/budgetWizardPlan.
 *   2. THE GRID. Evidence beside every box: what that category really cost
 *      over the chosen window — twelve complete months by default, a named
 *      year, or months of the user's choosing — as a year and as a month.
 *   3. WHAT WILL HAPPEN. The totals, the shortfall or headroom in words, and
 *      every removal named — before a single row is written.
 *
 * ── EMPTY IS NOT ZERO, AND THAT SURVIVES TO THE WRITE ──────────────────────
 * Boxes start EMPTY with the historical figure greyed beside them. An empty
 * box means UNBUDGETED; a typed 0 means "I intend to spend nothing here",
 * which is a real budget somebody can be over. Clearing a box that arrived
 * pre-filled REMOVES that budget, and step 3 says which ones by name — the
 * arithmetic for all of it is in `utils/budgetWizardPlan`, tested away from
 * any screen, because a rule this load-bearing should not live in a component
 * that also has to lay out a grid.
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
 * It never saves a figure nobody typed: "use last 12 months" fills the box,
 * visibly and editably, rather than writing behind you. It never invents a
 * budget on a parent group (that would double-count against its children), it
 * never re-expresses a weekly or quarterly budget as a monthly one (that
 * conversion is a guess), and it never touches alert thresholds — new budgets
 * take the app-wide default, edited ones keep whatever they had, because this
 * screen does not ask about them and must not answer for you.
 */

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

type Step = 'rhythm' | 'grid' | 'confirm';

/** `{ startDate }` to spread into a write when a day is chosen, nothing when not. */
const datedWith = (startDate: string | null): { startDate?: string } =>
  startDate === null ? {} : { startDate };

/**
 * "the calendar year (48) and 1 Jan 2026 (3)" — where the budgets a re-date
 * would move run from today, each distinct day with its count, most first.
 */
function describeRedateFroms(redatable: ReadonlyArray<{ from: string }>): string {
  const counts = new Map<string, number>();
  for (const entry of redatable) counts.set(entry.from, (counts.get(entry.from) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([from, count]) => (counts.size === 1 ? from : `${from} (${count})`));
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The shaded band a group heading is drawn on (owner, 1 Sep 2026: "category
 * group headings … shaded a different colour to show sections"), one class per
 * column. `renderGroupHeading` is the only thing that wears these and carries
 * the reasoning for why the shade is on the cells at all; what is settled here
 * is the PADDING, which is load-bearing in three separate ways.
 *
 * A content-box background stops at the padding, so on every edge INSIDE the
 * row — the three seams between the cells, and the join between the two lines
 * a phone folds them into — the padding has to be nothing, or the band shows a
 * hairline of the modal's ground through it. That is what `px-0`, `pl-0`,
 * `pr-0`, `pb-0` and the `pt-0` on the folding pair are for; measured, not
 * assumed, because a browser gives every table cell 1px of padding that
 * nothing in this stylesheet resets, and 1px of white is perfectly visible
 * across a shaded bar.
 *
 * At the row's two OUTER ends that same 1px is left exactly where the browser
 * put it, because the data cells and the column headers leave theirs too — so
 * the name starts and the twin ends on the same pixel as every figure above
 * and below them. The horizontal insets then come from the inner divs rather
 * than the cells, matching each data cell's own padding, which is what makes
 * the band's figures land in their columns instead of near them.
 *
 * And the top: `pt-4` holds the breathing room open ABOVE each section, unshaded,
 * because that padding is outside a content-box background — the one trick that
 * lets a single band be both full-bleed and preceded by the modal's own ground.
 * Only the leading pair carries it: on a phone the other two fold underneath,
 * where a gap would cut the band in half.
 *
 * A word on the greys inside it. The data rows put their quieter figures in
 * gray-400/500, which is legible on the modal's white but not on this band — so
 * the band's own text is a step or two darker. Contrast is measured against the
 * surface the text sits on, never the page it sits in.
 */
const BAND = 'bg-gray-200/80 dark:bg-gray-700/60 bg-clip-content align-baseline block sm:table-cell pb-0';
const BAND_NAME = `${BAND} pt-4 pr-0 min-w-0 text-left`;
const BAND_COST = `${BAND} pt-4 px-0 text-right tabular-nums`;
const BAND_BUDGET = `${BAND} pt-0 sm:pt-4 px-0 text-right`;
const BAND_TWIN = `${BAND} pt-0 sm:pt-4 pl-0 text-right tabular-nums`;

export default function BudgetWizard({ isOpen, onClose }: Props): React.JSX.Element {
  const {
    transactions, transactionSplits, categories, budgets,
    addBudget, updateBudget, deleteBudget,
  } = useApp();
  const { formatCurrency } = useCurrencyDecimal();
  const { showSuccess, showError, showWarning } = useToast();

  const [step, setStep] = useState<Step>('rhythm');
  const [mode, setMode] = useState<BudgetMode>('monthly');
  /**
   * What is in each box, by category id. ABSENT means untouched — which is a
   * different instruction from '' (emptied), and the difference is the whole
   * empty-versus-zero ruling. See utils/budgetWizardPlan.
   *
   * Each one carries the rhythm it was typed in, because a change of rhythm
   * CONVERTS what is in the boxes (owner, 2 Sep 2026) and converting from the
   * original figure every time is the only way that round-trips: £100 a year
   * shows as £8.33 a month and is £100 a year again on the way back, rather
   * than the £99.96 a converted-in-place figure would have become.
   */
  const [entries, setEntries] = useState<Record<string, WizardEntry | undefined>>({});
  const [showQuiet, setShowQuiet] = useState(false);
  const [applying, setApplying] = useState(false);
  /**
   * WHEN THE BUDGETS RUN FROM (owner, 5 Nov 2026) — the question this screen
   * never asked, and the reason budgets saved in late October read as ten
   * months overspent. The 1st of the current month is the default by his
   * ruling; "Another date" is how someone paid on the 15th gets months that
   * run 15th to 14th. See utils/budgetWizardPlan, "RUN THESE BUDGETS FROM".
   */
  const [runFrom, setRunFrom] = useState<RunFromKind>('this-month');
  const [customStart, setCustomStart] = useState('');
  /**
   * Whether the chosen start also moves the budgets this save is NOT
   * otherwise touching. OFF by default and offered with a count: a start is
   * a decision about the budgets being set, and moving every other one
   * behind it would be exactly the silent inheritance the forecast ruling
   * forbids. Re-running the wizard with this ticked is how the owner
   * re-dates his October budgets without retyping a figure.
   */
  const [redateUntouched, setRedateUntouched] = useState(false);

  // One evaluation instant for the whole wizard: the window named in the
  // header and the figures under it describe the same "now".
  const now = useMemo(() => new Date(), []);
  const runFromChoices = useMemo(() => runFromOptions(now), [now]);
  const startDate = useMemo(() => runFromDate(runFrom, now, customStart), [runFrom, now, customStart]);
  /**
   * Which twelve months the evidence covers (owner, 1 Sep 2026: "Some people
   * may want to work on calendar years"). Changing it changes the EVIDENCE —
   * the history columns, the references, the copy-in buttons — and touches
   * nothing anybody has typed: a figure in a box is the user's intent, not a
   * measurement, and it survives a change of measuring stick.
   */
  const [windowKind, setWindowKind] = useState<WizardWindowKind>('full-months');
  /**
   * The months a 'custom' window runs over, as the user typed them (owner,
   * 5 Nov 2026: "a custom option for the guide period"). The inputs show the
   * ASK; the heading and the figures show the window as clamped by the
   * summariser — never the month still running, at most 36 — so a range
   * typed into the future is answered on screen rather than quietly obeyed.
   */
  const [customWindow, setCustomWindow] = useState<SpendWindowCustom | undefined>(undefined);
  const historyWindow = useMemo(
    () => budgetHistoryWindow(now, windowKind, customWindow),
    [now, windowKind, customWindow]
  );
  /** The latest month a custom window may end in: last month, as YYYY-MM. */
  const lastCompleteMonth = useMemo(() => clampCustomWindow(undefined, now).toMonth, [now]);

  const chooseWindow = (chosen: WizardWindowKind): void => {
    if (chosen === 'custom' && customWindow === undefined) {
      // Start from the months being looked at, when they ARE whole months —
      // the three named years all are. A window seeded from what is on screen
      // changes no figure at the moment of choosing; the user then moves an end.
      setCustomWindow(clampCustomWindow({
        fromMonth: historyWindow.from.slice(0, 7),
        toMonth: historyWindow.to.slice(0, 7),
      }, now));
    }
    setWindowKind(chosen);
  };

  const summary = useMemo(
    () => summariseForWizard(transactions, transactionSplits, categories, now, windowKind, customWindow),
    [transactions, transactionSplits, categories, now, windowKind, customWindow]
  );
  const rows = useMemo(
    () => buildWizardRows(summary, categories, budgets),
    [summary, categories, budgets]
  );

  /**
   * Rows with nothing in the window and no budget on them fold away — but the
   * count is always named (house rule: never hide without saying how much).
   * A category that already carries a budget is never folded: it is part of
   * the world being edited, and a removal you cannot see is not an offer.
   */
  const { active, quiet } = useMemo(() => {
    const isQuiet = (row: WizardRow): boolean => row.annual.isZero() && row.existing === null;
    return {
      active: rows.filter(row => !isQuiet(row)),
      quiet: rows.filter(isQuiet),
    };
  }, [rows]);

  const groups = useMemo(() => groupWizardRows(active), [active]);
  /**
   * THE FOLD KEEPS ITS GROUPS (owner, 2 Sep 2026: "It needs to stay honest —
   * group them under their parents").
   *
   * Folded rows used to be listed flat, under no heading at all, so a budget
   * typed into one counted on the scoreboard and in NO group total: the sum of
   * the headings and the strip above them stopped agreeing the moment somebody
   * opened the fold and typed. Grouped the same way, by the same function, the
   * two sections are a partition of the same rows and the identity holds again.
   *
   * ONE HEADING PER PARENT PER SECTION, and that is the deliberate choice. A
   * parent with some children in the window and some not appears twice — once
   * above with its live rows, once inside the fold with its quiet ones — each
   * heading totalling only the boxes beneath it. The alternative, a single
   * merged heading, would either count boxes that are not under it (the totals
   * would double up across the two sections and stop adding to the scoreboard)
   * or print a total next to rows it does not cover. Two honest headings beat
   * one that has to be explained.
   */
  const quietGroups = useMemo(() => groupWizardRows(quiet), [quiet]);

  /**
   * WHAT IS BUDGETED BEHIND THE FOLD (owner, 4 Sep 2026: "name it").
   *
   * Grouping the folded rows fixed the sum; it did not fix the SHUT case. A
   * budget typed into a folded row counts on the scoreboard, and then the fold
   * closes over the only place it was visible — so the strip goes up by £20 and
   * nothing on screen says where the £20 is. That is the same failure the count
   * itself was added to prevent, one level down: money hidden without a word.
   *
   * `totalBudgeted` over the folded rows, which is the SAME function the
   * scoreboard runs over every row and each heading runs over its own — never a
   * second derivation, so the label cannot drift from the figures it belongs to.
   */
  const quietBudget = useMemo(() => totalBudgeted(quiet, entries, mode), [quiet, entries, mode]);

  const plan = useMemo(
    () => planBudgetWrites(rows, entries, mode, { startDate }),
    [rows, entries, mode, startDate]
  );
  /** The re-dates that WILL be written: the offer, only once it is taken. */
  const redates = redateUntouched ? plan.redatable : [];
  const nothingToSave = plan.upserts.length === 0 && plan.removals.length === 0 && redates.length === 0;

  /**
   * The string a box shows: what was typed, else what is stored, else empty.
   *
   * Delegated rather than decided here, because the totals below are the sum
   * of exactly these strings — see `wizardBoxValue`.
   */
  const valueFor = (row: WizardRow): string => wizardBoxValue(row, entries, mode);

  /** A box takes what was typed AND the rhythm it was typed in — see `entries`. */
  const setValue = (categoryId: string, value: string): void =>
    setEntries(previous => ({ ...previous, [categoryId]: { value, typedAs: mode } }));

  /**
   * THE RUNNING SCOREBOARD — total spent and total budgeted so far, alive as
   * the boxes fill (owner, 1 Sep 2026: "I want to be able to see the totals
   * as I go along", not only on the review page).
   *
   * The budgeted side is `totalBudgeted` over EVERY row, which is the same
   * function each group heading runs over ITS rows — so the strip and the
   * headings under it are the one sum taken over nested sets, and cannot
   * drift apart however either is later changed.
   */
  const totals = useMemo(
    () => ({
      spent: rows.reduce((sum, row) => sum.plus(row.annual), toDecimal(0)),
      budget: totalBudgeted(rows, entries, mode),
    }),
    [rows, entries, mode]
  );

  /** The historical figure for this row in the mode being typed. */
  const historyIn = (row: WizardRow): DecimalInstance => (mode === 'monthly' ? row.monthly : row.annual);

  const fillFromHistory = (row: WizardRow): void => setValue(row.category.id, boxFigure(historyIn(row)));

  /** Fill every box that has evidence behind it. A row with no spending is left alone. */
  const startFromHistory = (): void =>
    setEntries(previous => {
      const next = { ...previous };
      for (const row of rows) {
        if (row.annual.isZero()) continue;
        if (row.existing !== null && row.existing.period === null) continue;
        next[row.category.id] = { value: boxFigure(historyIn(row)), typedAs: mode };
      }
      return next;
    });

  /**
   * Back to as-they-were — NOT every box emptied.
   *
   * Emptying is how a budget is REMOVED, so a "clear" that emptied every box
   * would queue the deletion of every budget the user already has behind one
   * tap. This undoes the typing; a budget is still taken off one box at a time.
   */
  const clearAll = (): void => setEntries({});

  const close = (): void => {
    setStep('rhythm');
    setEntries({});
    setShowQuiet(false);
    setRunFrom('this-month');
    setCustomStart('');
    setRedateUntouched(false);
    onClose();
  };

  /**
   * The rhythm, chosen or changed — and NOTHING ELSE IS TOUCHED, which is what
   * makes the conversion honest (owner, 2 Sep 2026: "Yes, it should convert").
   * Every box converts on the way to the screen, from the figure and rhythm
   * that were actually typed, so £90 a month reads £1,080 a year here and £90
   * a month again on the way back. Rewriting the entries at each switch would
   * round them once per press, and £100 a year would come home as £99.96.
   */
  const chooseMode = (chosen: BudgetMode): void => {
    setMode(chosen);
    setStep('grid');
  };

  /**
   * ONE APPLY PASS, and every write is caught on its own.
   *
   * A batch that stops at its first failure strands the user in a half-written
   * state they cannot see; one that swallows failures reports a success that
   * did not happen. So each row is attempted, the failures are collected BY
   * NAME, and the toast says exactly how many landed and which did not.
   */
  const apply = async (): Promise<void> => {
    setApplying(true);
    const failed: string[] = [];
    let written = 0;

    // The chosen start goes on every row written — the one thing that makes
    // "run from 1 November" true of a budget edited here.
    const dated = datedWith(plan.startDate);

    for (const upsert of plan.upserts) {
      try {
        if (upsert.budgetId !== undefined) {
          await updateBudget(upsert.budgetId, {
            amount: upsert.amount.toNumber(),
            period: upsert.period,
            ...dated,
          });
        } else {
          await addBudget({
            categoryId: upsert.categoryId,
            name: upsert.categoryName,
            amount: upsert.amount.toNumber(),
            period: upsert.period,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...dated,
            // The proposal from the evidence — only ever on a NEW budget.
            ...(upsert.paceShape !== undefined ? { paceShape: upsert.paceShape } : {}),
          });
        }
        written += 1;
      } catch {
        failed.push(upsert.categoryName);
      }
    }

    for (const removal of plan.removals) {
      try {
        await deleteBudget(removal.budgetId);
        written += 1;
      } catch {
        failed.push(removal.categoryName);
      }
    }

    // The re-dates: the money untouched, only the day the cycles count from.
    for (const redate of redates) {
      try {
        await updateBudget(redate.budgetId, { ...dated });
        written += 1;
      } catch {
        failed.push(redate.categoryName);
      }
    }

    setApplying(false);

    if (failed.length > 0) {
      showError(
        `${written} of ${written + failed.length} saved. These were not: ${failed.join(', ')}. Your other budgets are unchanged — try again.`
      );
      return;
    }
    showSuccess(
      `${written} budget${written === 1 ? '' : 's'} saved.`,
      'Budgets updated'
    );
    close();
  };

  const confirm = (): void => {
    if (plan.rejections.length > 0) {
      showWarning(
        `${plan.rejections.length} figure${plan.rejections.length === 1 ? '' : 's'} could not be read as an amount and will be left as ${plan.rejections.length === 1 ? 'it is' : 'they are'}: ${plan.rejections.map(r => r.categoryName).join(', ')}.`
      );
    }
    setStep('confirm');
  };

  const modeNoun = mode === 'monthly' ? 'a month' : 'a year';
  const columnHeading = mode === 'monthly' ? 'Your budget, per month' : 'Your budget, per year';

  // ── Step 2, one row ───────────────────────────────────────────────────────
  const renderRow = (row: WizardRow): React.JSX.Element => {
    const value = valueFor(row);
    const locked = row.existing !== null && row.existing.period === null;
    // Decimal all the way down: the twin is money, so the typed string is read
    // by the app's money parser and never by parseFloat.
    const twin = (() => {
      if (locked || value.trim() === '') return null;
      const parsed = parseMoneyInput(value);
      if (parsed === null || parsed < 0) return null;
      return twinFigure(parsed, mode);
    })();

    return (
      // Four columns on a desktop; below `sm` the same four cells reflow into
      // a two-by-two card — name beside its history, then the box beside the
      // figure it implies. The house responsive-table idiom (see
      // BulkCategorizeModal), so a phone never scrolls sideways to reach the
      // field it is meant to be filling in.
      <tr
        key={row.category.id}
        className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 py-2 sm:py-0 sm:table-row border-t border-line dark:border-gray-700"
      >
        <td className="block sm:table-cell min-w-0 py-1 sm:py-2 sm:pr-3 sm:align-top">
          <span className="text-sm text-gray-900 dark:text-white">{row.category.name}</span>
          {row.rows > 0 && (
            <span className="block text-xs text-gray-400 dark:text-gray-500">
              {row.rows} row{row.rows === 1 ? '' : 's'}
            </span>
          )}
        </td>
        {/* THE EVIDENCE — both figures, on every row, whichever one is being
            typed. Greyed and beside the box, never inside it: it is what the
            category cost, not a value anybody has agreed to. */}
        <td className="block sm:table-cell py-1 sm:py-2 sm:px-2 text-right sm:align-top tabular-nums">
          {row.annual.isZero() ? (
            <span className="text-xs text-gray-400 dark:text-gray-500">Nothing in this window</span>
          ) : (
            <>
              <span className="block text-sm text-gray-700 dark:text-gray-300">
                {formatCurrency(row.annual)} a year
              </span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">
                {formatCurrency(row.monthly)} a month
              </span>
              {/* PAID IN ONE GO (owner, 7 Nov 2026): the window's own
                  evidence that this category is a lump — insurance, car
                  tax — said here, and written as the budget's pace shape
                  when the row becomes a new budget. No flag on a row, no
                  tidy-up screen; the editor can change it. */}
              {row.paidOnce !== null && (
                <span className="block text-xs text-gray-500 dark:text-gray-400" data-testid="paid-once">
                  {describePaidOnce(row.paidOnce)}
                </span>
              )}
            </>
          )}
        </td>
        <td className="block sm:table-cell py-1 sm:py-2 sm:px-2 sm:align-top">
          {locked ? (
            <span className="block text-xs text-gray-500 dark:text-gray-400 text-right max-w-[14rem]">
              {formatCurrency(row.existing?.amount ?? 0)} {row.existing?.storedPeriod} — left as it is.
              Change it on the Budget page.
            </span>
          ) : (
            <div className="flex items-center justify-end gap-2">
              {!row.annual.isZero() && (
                <button
                  type="button"
                  onClick={() => fillFromHistory(row)}
                  aria-label={`Use what ${row.category.name} actually cost`}
                  className="text-xs text-gray-500 dark:text-gray-400 hover:underline rounded whitespace-nowrap min-h-[44px] sm:min-h-0 px-1"
                >
                  use my actual
                </button>
              )}
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                aria-label={`${mode === 'monthly' ? 'Monthly' : 'Yearly'} budget for ${row.category.name}`}
                value={value}
                onChange={event => setValue(row.category.id, event.target.value)}
                placeholder="—"
                className="w-28 px-2 py-2 text-sm text-right tabular-nums rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              />
            </div>
          )}
        </td>
        {/* The twin, live: type the month and the year answers, and back. */}
        <td className="block sm:table-cell py-1 sm:py-2 sm:pl-2 text-right sm:align-top tabular-nums">
          <span className="block text-xs text-gray-400 dark:text-gray-500 min-h-[1rem]">
            {twin !== null &&
              (mode === 'monthly'
                ? `${formatCurrency(twin)} a year`
                : `${formatCurrency(twin)} a month`)}
          </span>
        </td>
      </tr>
    );
  };

  /**
   * A group heading row — a ROW OF THE GRID, not a banner laid across it.
   *
   * THE OWNER, 2 SEP 2026: "After filling in my budget per line for Cars &
   * Bikes I cannot see that total easily. I see below 'your budget for the
   * year = £91,451.42' but that is actually my spend for the period, not my
   * budget. That should be off to the left under 'What it cost', and 'Your
   * budget, per year' should have a running updatable total as you type
   * below. There should be a total for each category grouping."
   *
   * So the heading answers the same four columns its children do: the name,
   * what the group cost, what has been budgeted across it so far, and that
   * total's twin. A figure under a column heading now means what the heading
   * says — which is the whole of the fix. It cost the bar its rounded ends:
   * something with columns to line up with cannot also be inset from them.
   *
   * THE SHADE IS ON THE CELLS, clipped to their content boxes, which is the
   * one arrangement that does both jobs at once: an unbroken band across four
   * cells AND the breathing room above each section left as the modal's own
   * ground. What that costs in padding is settled in BAND_* above. On a phone
   * the four cells fold two-by-two like every other row here, and the band
   * closes over both of its lines.
   *
   * NO "n of m filled" COUNT. It would sit in a desktop cell and crowd a
   * phone's, and the scoreboard above already says it for the whole screen.
   *
   * DISPLAY ONLY, and structurally so — there is still no input in it. A
   * budget on a group AND on its children would double-count, and which of
   * the two the Budget page should measure would be a question with two
   * answers.
   */
  const renderGroupHeading = (group: WizardGroup): React.JSX.Element => {
    const budget = totalBudgeted(group.rows, entries, mode);
    /**
     * Empty is not zero, all the way up to the heading: a group nobody has
     * budgeted yet shows NO figure at all, because £0.00 there would claim a
     * budget of nothing across every row beneath it. A typed nought is a
     * different matter — it is a box that is filled, so it counts, and the
     * total is drawn.
     */
    const totalled = budget.boxes > 0;

    return (
      <tr className="grid grid-cols-[minmax(0,1fr)_auto] sm:table-row">
        <th scope="rowgroup" className={BAND_NAME}>
          <div className="py-2 sm:pr-3">
            <span className="text-sm font-semibold text-gray-900 dark:text-white">
              {group.name || 'Ungrouped'}
            </span>
          </div>
        </th>
        {/* WHAT THE GROUP COST — the roll-up, under the heading that has
            always described it, in the same two-line shape as its rows. */}
        <td className={BAND_COST}>
          <div className="py-2 sm:px-2">
            {group.annual.isZero() ? (
              <span className="text-xs text-gray-600 dark:text-gray-300">Nothing in this window</span>
            ) : (
              <>
                <span className="block text-sm text-gray-700 dark:text-gray-200">
                  {formatCurrency(group.annual)} a year
                </span>
                <span className="block text-xs text-gray-600 dark:text-gray-300">
                  {formatCurrency(group.monthly)} a month
                </span>
              </>
            )}
          </div>
        </td>
        {/* THE RUNNING TOTAL: this group's boxes, added up as they are typed. */}
        <td className={BAND_BUDGET}>
          {totalled && (
            <div className="flex justify-end py-2 sm:px-2">
              {/* The box's own geometry, borrowed — same width, same padding,
                  a border that is there and invisible, laid out by the same
                  flex the row lays its box out with — so the total's digits
                  land on the digits of the boxes it is totalling. */}
              <span className="w-28 px-2 border border-transparent text-sm font-medium text-gray-900 dark:text-white tabular-nums">
                {formatCurrency(budget.typed)}
              </span>
            </div>
          )}
        </td>
        {/* Its twin, said the way every row says its own. */}
        <td className={BAND_TWIN}>
          {totalled && (
            <div className="py-2 sm:pl-2">
              <span className="text-xs text-gray-600 dark:text-gray-300">
                {formatCurrency(budget.twin)} {mode === 'monthly' ? 'a year' : 'a month'}
              </span>
            </div>
          )}
        </td>
      </tr>
    );
  };

  // ── Step 1 ────────────────────────────────────────────────────────────────
  const renderRhythm = (): React.JSX.Element => (
    <div>
      <h3 className="text-base font-medium text-gray-900 dark:text-white mb-1">
        Do you think in months or years?
      </h3>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-5">
        This only chooses which figure you type. Both are shown on every row, and you can change
        your mind on the next screen.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {([
          ['monthly', 'Budget monthly', 'Type what you plan to spend each month.'],
          ['yearly', 'Budget annually', 'Type the year, and see what it is a month.'],
        ] as const).map(([value, title, blurb]) => (
          <button
            key={value}
            type="button"
            onClick={() => chooseMode(value)}
            /* `flex flex-col items-start` is load-bearing, not decoration:
               the stylesheet gives every button `display: inline-flex`, so
               these two block children would lay out SIDE BY SIDE without it
               (src/test/a11y/buttonsStackTheirOwnRows.test.ts guards it). */
            className="flex flex-col items-start text-left p-4 min-h-[44px] rounded-lg border border-line dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            <span className="block text-sm font-medium text-gray-900 dark:text-white">{title}</span>
            <span className="block text-xs text-gray-500 dark:text-gray-400 mt-1">{blurb}</span>
          </button>
        ))}
      </div>
    </div>
  );

  // ── Step 2 ────────────────────────────────────────────────────────────────
  /**
   * A custom window that is not twelve months makes "a year" and "a month" a
   * RATE, and the explainer says so in the same breath as the count — the
   * house rule about naming what a figure is before anyone reads it.
   */
  const customExplainer = (): string => {
    const stillRunning = 'The month still running is never counted.';
    if (historyWindow.months === 12) return `Twelve complete months of your choosing. ${stillRunning}`;
    const count = historyWindow.months === 1 ? 'One complete month' : `${historyWindow.months} complete months`;
    return `${count} — "a year" and "a month" here are what you spent over them, at a yearly and a monthly rate. ${stillRunning}`;
  };
  const windowExplainer =
    windowKind === 'full-months'
      ? 'Twelve complete months — this month is still running, so it is not counted.'
      : windowKind === 'calendar-year'
        ? 'The last complete calendar year.'
        : windowKind === 'tax-year'
          ? 'The last complete tax year — 6 April to 5 April.'
          : customExplainer();
  const atARate = historyWindow.months !== 12;

  const renderGrid = (): React.JSX.Element => (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <p className="text-sm text-gray-700 dark:text-gray-200">
            What you spent, {historyWindow.label}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {windowExplainer} An empty box means no budget; a nought means a budget of nothing.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The measuring stick is a choice (owner, 1 Sep 2026): a
              calendar-year budgeter sets this year's numbers against
              Jan–Dec of last year, part-way through and unbothered. */}
          <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            Measured over
            <select
              value={windowKind}
              onChange={event => {
                const chosen = event.target.value;
                if (chosen === 'full-months' || chosen === 'calendar-year' || chosen === 'tax-year' || chosen === 'custom') {
                  chooseWindow(chosen);
                }
              }}
              className="px-2 py-2 min-h-[44px] text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            >
              <option value="full-months">The last 12 full months</option>
              <option value="calendar-year">Last calendar year</option>
              <option value="tax-year">Last tax year</option>
              <option value="custom">Months I choose</option>
            </select>
          </label>
          {windowKind === 'custom' && (
            // The same month inputs as the Plan page's custom range. `max` is
            // the browser's half of the rule the summariser enforces; a month
            // typed past it is clamped there and the heading says what counted.
            <>
              <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                From
                <input
                  type="month"
                  aria-label="Measured from month"
                  value={customWindow?.fromMonth ?? ''}
                  max={lastCompleteMonth}
                  onChange={event => setCustomWindow({
                    fromMonth: event.target.value,
                    toMonth: customWindow?.toMonth ?? lastCompleteMonth,
                  })}
                  className="px-2 py-2 min-h-[44px] text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                To
                <input
                  type="month"
                  aria-label="Measured to month"
                  value={customWindow?.toMonth ?? ''}
                  max={lastCompleteMonth}
                  onChange={event => setCustomWindow({
                    fromMonth: customWindow?.fromMonth ?? lastCompleteMonth,
                    toMonth: event.target.value,
                  })}
                  className="px-2 py-2 min-h-[44px] text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
              </label>
            </>
          )}
          <button
            type="button"
            onClick={startFromHistory}
            className="px-3 py-2 min-h-[44px] text-sm font-medium border border-line dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Start from history
          </button>
          <button
            type="button"
            onClick={clearAll}
            title="Puts every box back to what is stored"
            className="px-3 py-2 min-h-[44px] text-sm font-medium border border-line dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Clear all
          </button>
        </div>
      </div>

      {/* THE RUNNING SCOREBOARD, pinned above the scroller so it holds still
          while the list moves (owner, 1 Sep 2026: "I want to be able to see
          the totals as I go along"). The chosen rhythm's figure leads; its
          twin follows, exactly as on every row. */}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-lg border border-line dark:border-gray-700 px-3 py-2 mb-3 text-sm tabular-nums">
        <span className="text-gray-600 dark:text-gray-300">
          Spent{' '}
          <span className="font-medium text-gray-900 dark:text-white">
            {formatCurrency(mode === 'monthly' ? twinFigure(totals.spent, 'yearly') : totals.spent)}
          </span>{' '}
          {modeNoun}
          <span className="text-gray-500 dark:text-gray-400">
            {' '}· {formatCurrency(mode === 'monthly' ? totals.spent : twinFigure(totals.spent, 'yearly'))}{' '}
            {mode === 'monthly' ? 'a year' : 'a month'}
          </span>
        </span>
        <span className="text-gray-600 dark:text-gray-300">
          Budgeted so far{' '}
          <span className="font-medium text-gray-900 dark:text-white">
            {formatCurrency(totals.budget.typed)}
          </span>{' '}
          {modeNoun}
          <span className="text-gray-500 dark:text-gray-400">
            {' '}· {formatCurrency(totals.budget.twin)}{' '}
            {mode === 'monthly' ? 'a year' : 'a month'} · {totals.budget.boxes} of {rows.length} boxes filled
          </span>
        </span>
      </div>

      {/* The consequence of unfiled money, named: it is in none of the figures
          below, so every one of them is that much short. */}
      {summary.unfiledRows > 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          {formatCurrency(summary.unfiled)} of spending over {summary.unfiledRows} row
          {summary.unfiledRows === 1 ? '' : 's'} has no category, so it is in none of the figures
          below — categorise those and these totals will rise.
        </p>
      )}

      <div className="max-h-[50vh] overflow-y-auto">
        <table className="block sm:table w-full">
          {/* Sticky on the CELLS, not the row — WebKit ignores position:sticky
              on table rows. The ground is restated so list rows slide under,
              not through. */}
          <thead className="hidden sm:table-header-group">
            <tr className="text-xs text-gray-500 dark:text-gray-400">
              <th className="sticky top-0 z-10 bg-white dark:bg-gray-900 text-left font-medium py-2 pr-3">
                Category
              </th>
              <th className="sticky top-0 z-10 bg-white dark:bg-gray-900 text-right font-medium py-2 px-2">
                What it cost<span className="block font-normal">{historyWindow.label}</span>
              </th>
              <th className="sticky top-0 z-10 bg-white dark:bg-gray-900 text-right font-medium py-2 px-2">
                {columnHeading}
              </th>
              <th className="sticky top-0 z-10 bg-white dark:bg-gray-900 text-right font-medium py-2 pl-2">
                Which is<span className="block font-normal">{mode === 'monthly' ? 'a year' : 'a month'}</span>
              </th>
            </tr>
          </thead>
          {groups.map(group => (
            <tbody key={group.id || 'ungrouped'} className="block sm:table-row-group">
              {renderGroupHeading(group)}
              {group.rows.map(renderRow)}
            </tbody>
          ))}

          {/* THE FOLD. Categories with nothing in the window are collapsed —
              but the COUNT is always on screen, because hiding rows without
              saying how many is how a screen quietly stops being the whole
              list (house data-health rule: name what is hidden). */}
          {quiet.length > 0 && (
            <>
              <tbody className="block sm:table-row-group">
                <tr className="block sm:table-row">
                  <td colSpan={4} className="block sm:table-cell pt-4">
                    <button
                      type="button"
                      onClick={() => setShowQuiet(open => !open)}
                      aria-expanded={showQuiet}
                      className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300 hover:underline rounded min-h-[44px]"
                    >
                      {showQuiet ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
                      {quiet.length} categor{quiet.length === 1 ? 'y' : 'ies'} with nothing in this
                      window
                      {/* …and what is budgeted behind it, in the rhythm being
                          typed — the twin is the row's business, not a folded
                          label's. ZERO FILLED BOXES RENDERS NOTHING AT ALL, not
                          "· £0.00 budgeted": a zero count is not a finding, and
                          £0.00 there would claim a budget of nothing across
                          every hidden row (the same empty-is-not-zero rule the
                          group headings keep). No separator either — a dangling
                          "·" is a figure that failed to load. */}
                      {quietBudget.boxes > 0 && ` · ${formatCurrency(quietBudget.typed)} budgeted`}
                    </button>
                  </td>
                </tr>
              </tbody>
              {/* …and opened, they are the SAME GRID: filed under their parents,
                  with the same heading row the section above draws, so a budget
                  typed down here lands in a group total instead of only on the
                  scoreboard (owner, 2 Sep 2026). A parent whose other children
                  are up there gets a heading in both places — see `quietGroups`
                  for why that is the honest arrangement rather than a merge. */}
              {showQuiet && quietGroups.map(group => (
                <tbody key={`quiet-${group.id || 'ungrouped'}`} className="block sm:table-row-group">
                  {renderGroupHeading(group)}
                  {group.rows.map(renderRow)}
                </tbody>
              ))}
            </>
          )}
        </table>
      </div>
    </div>
  );

  // ── Step 3 ────────────────────────────────────────────────────────────────
  const renderConfirm = (): React.JSX.Element => {
    const short = plan.difference.isNegative();
    const level = plan.difference.isZero()
      ? 'text-gray-700 dark:text-gray-200'
      : short
        ? 'text-red-600 dark:text-red-400'
        : 'text-green-600 dark:text-green-400';

    return (
      <div>
        <h3 className="text-base font-medium text-gray-900 dark:text-white mb-2">
          {plan.budgetedCount === 0
            ? 'No categories will be budgeted'
            : `You're budgeting ${plan.budgetedCount} categor${plan.budgetedCount === 1 ? 'y' : 'ies'}`}
        </h3>
        <p className="text-sm text-gray-700 dark:text-gray-200 tabular-nums">
          {formatCurrency(plan.monthlyTotal)} a month ({formatCurrency(plan.annualTotal)} a year),
          {atARate
            // Over a window that is not a year, the comparison figure is a
            // RATE — what those categories would cost in a year at the pace
            // they ran — and the sentence says so rather than calling it spending.
            ? ` against ${formatCurrency(plan.spentTotal)} a year at the rate those categories ran over ${historyWindow.label} (${historyWindow.months} month${historyWindow.months === 1 ? '' : 's'}).`
            : ` against ${formatCurrency(plan.spentTotal)} actually spent in those categories over ${historyWindow.label}.`}
        </p>
        {plan.budgetedCount > 0 && (
          <p className={`mt-2 text-sm font-medium tabular-nums ${level}`}>
            {plan.difference.isZero()
              ? (atARate ? 'That is exactly that rate.' : 'That is exactly what those categories cost.')
              : short
                ? (atARate
                    ? `That is ${formatCurrency(plan.difference.abs())} a year LESS than that rate — you would have to spend more slowly than you did over ${historyWindow.label} to stay inside it.`
                    : `That is ${formatCurrency(plan.difference.abs())} a year LESS than they really cost — you would have to spend less than last year to stay inside it.`)
                : (atARate
                    ? `That is ${formatCurrency(plan.difference)} a year MORE than that rate, so there is room in it.`
                    : `That is ${formatCurrency(plan.difference)} a year MORE than they really cost, so there is room in it.`)}
          </p>
        )}

        {/* RUN THESE BUDGETS FROM. The day every budget written here counts
            its cycles from, said before the save — a budget saved without it
            read ten months of earlier spending as overspend (5 Nov 2026). */}
        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-gray-900 dark:text-white">Run these budgets from</legend>
          <div className="mt-2 grid gap-1.5">
            {runFromChoices.map(choice => (
              <label key={choice.kind} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 min-h-[32px]">
                <input
                  type="radio"
                  name="run-from"
                  value={choice.kind}
                  checked={runFrom === choice.kind}
                  onChange={() => setRunFrom(choice.kind)}
                  className="border-gray-300 dark:border-gray-600"
                />
                {choice.label}
              </label>
            ))}
            <label className="flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-200 min-h-[32px]">
              <input
                type="radio"
                name="run-from"
                value="custom"
                checked={runFrom === 'custom'}
                onChange={() => setRunFrom('custom')}
                className="border-gray-300 dark:border-gray-600"
              />
              Another date
              {runFrom === 'custom' && (
                <input
                  type="date"
                  aria-label="The day the budgets run from"
                  value={customStart}
                  onChange={event => setCustomStart(event.target.value)}
                  className="px-2 py-1.5 min-h-[36px] text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
              )}
            </label>
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {mode === 'yearly'
              ? 'Each budget runs for a year from that day, then starts again. '
              : 'Each budget runs month by month from that day. '}
            Nothing spent before it counts against it.
          </p>
        </fieldset>

        <dl className="mt-4 grid gap-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-gray-600 dark:text-gray-300">Budgets to set or change</dt>
            <dd className="text-gray-900 dark:text-white tabular-nums">{plan.upserts.length}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-gray-600 dark:text-gray-300">Budgets to remove</dt>
            <dd className="text-gray-900 dark:text-white tabular-nums">{plan.removals.length}</dd>
          </div>
          {plan.redatable.length > 0 && (
            <div className="flex justify-between gap-4">
              <dt className="text-gray-600 dark:text-gray-300">Budgets to re-date</dt>
              <dd className="text-gray-900 dark:text-white tabular-nums">{redates.length}</dd>
            </div>
          )}
        </dl>

        {/* THE RE-DATE OFFER. Budgets this save is not otherwise touching keep
            the start they have unless the reader says otherwise, here, with
            the count and the days they run from today — so the move is a
            decision, never an inheritance. */}
        {plan.redatable.length > 0 && (
          <label className="mt-3 flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
            <input
              type="checkbox"
              checked={redateUntouched}
              onChange={event => setRedateUntouched(event.target.checked)}
              className="mt-1 rounded border-gray-300 dark:border-gray-600"
            />
            <span>
              Also move the {plan.redatable.length} budget{plan.redatable.length === 1 ? '' : 's'} I'm not changing
              to this start. {plan.redatable.length === 1 ? 'It runs' : 'They run'} from {describeRedateFroms(plan.redatable)}{' '}
              today; the amounts stay as they are.
            </span>
          </label>
        )}

        {/* Removals are named, never counted only: taking a budget off is the
            one thing here nobody can undo by retyping a number. */}
        {plan.removals.length > 0 && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">
            {plan.removals.length} budget{plan.removals.length === 1 ? '' : 's'} will be removed:{' '}
            {plan.removals.map(removal => removal.categoryName).join(', ')}.
          </p>
        )}

        {plan.rejections.length > 0 && (
          <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">
            {plan.rejections.length} figure{plan.rejections.length === 1 ? '' : 's'} could not be
            read as an amount and will be left as {plan.rejections.length === 1 ? 'it is' : 'they are'}:{' '}
            {plan.rejections.map(rejection => rejection.categoryName).join(', ')}.
          </p>
        )}

        {nothingToSave && (
          <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">
            Nothing has changed, so there is nothing to save.
          </p>
        )}
        {!nothingToSave && startDate === null && (
          <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">
            Choose the day the budgets run from to save.
          </p>
        )}
      </div>
    );
  };

  const title =
    step === 'rhythm' ? 'Set up budgets' : step === 'grid' ? `Set up budgets — ${modeNoun}` : 'Before you save';

  return (
    <Modal isOpen={isOpen} onClose={close} title={title} size="2xl">
      <ModalBody>
        {step === 'rhythm' && renderRhythm()}
        {step === 'grid' && renderGrid()}
        {step === 'confirm' && renderConfirm()}
      </ModalBody>
      <ModalFooter>
        <div className="flex items-center gap-3 ml-auto">
          {step !== 'rhythm' && (
            <button
              type="button"
              onClick={() => setStep(step === 'confirm' ? 'grid' : 'rhythm')}
              disabled={applying}
              className="px-4 py-2 min-h-[44px] text-sm font-medium border border-line dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={close}
            disabled={applying}
            className="px-4 py-2 min-h-[44px] text-sm font-medium border border-line dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          {step === 'grid' && (
            <button
              type="button"
              onClick={confirm}
              className="px-4 py-2 min-h-[44px] text-sm font-medium bg-primary-action text-on-primary-action rounded-lg transition-colors"
            >
              Review
            </button>
          )}
          {step === 'confirm' && (
            <button
              type="button"
              onClick={() => void apply()}
              disabled={applying || nothingToSave || startDate === null}
              className="px-4 py-2 min-h-[44px] text-sm font-medium bg-primary-action text-on-primary-action rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {applying ? 'Saving…' : 'Save budgets'}
            </button>
          )}
        </div>
      </ModalFooter>
    </Modal>
  );
}
