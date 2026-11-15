import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApp } from '../../contexts/AppContextSupabase';
import { useToast } from '../../contexts/ToastContext';
import { useCurrencyDecimal } from '../../hooks/useCurrencyDecimal';
import { toDecimal, type DecimalInstance } from '../../utils/decimal';
import { getDateLocale } from '../../utils/dateFormatter';
import { preserveDemoParam } from '../../utils/navigation';
import { dismissedKeys, recurringAnswerKey } from '../../utils/suggestionDismissals';
import { SearchIcon } from '../../components/icons';
import type { RecurringAnswerKind } from '../../types';
import {
  detectRecurring,
  MIN_PAYMENTS,
  type RecurringCadence,
  type RecurringDetection,
} from '../../utils/recurringDetection';
import { compareNames, compareText } from '../../utils/localeFormat';

/**
 * "What I'm committed to" — recurring payments, detected from the register.
 *
 * A FINDING, not a dashboard (Claude Design handover, 17 Aug §1): the app
 * noticing something in the ledger the user hasn't. Two audiences in one —
 * the subscription audit ("what am I signed up to?") and the schedule read
 * ("what is due next?") — designed for the first, with the second falling
 * out of it.
 *
 * Lives under PLAN as its own page (owner's ruling, 18 Aug — the nav says
 * "Recurring Payments", the heading keeps the question), not in the Reports
 * gallery: confirming patterns here is what feeds the calendar and the
 * forecast, which makes it a working surface rather than a read-out.
 *
 * The design rules this page lives under, all from the handover:
 *
 * - A detection is an INFERENCE and carries its evidence in its resting
 *   state (§2): the payment count, the span, the most recent date and the
 *   next expected ARE the confidence. No percentages, ever. A stitched
 *   pattern names its former labels; a vouched pattern says the user's
 *   judgment is what admitted it.
 * - The number that lands is the ANNUAL equivalent (§3) — £14.99 a month is
 *   invisible; £179.88 a year is a decision.
 * - Grouped by CADENCE by default (§4); the user can regroup by institution
 *   (the Accounts page's idiom), search, and re-sort — navigation, never a
 *   change to what is claimed.
 * - A price change is a DIRECTION and may wear the hues; the magnitudes
 *   stay neutral (§3.1).
 * - Stopped patterns are a band, never a silent deletion (§3.2).
 * - Read-only over the register: verdicts live beside the detections
 *   (suggestion dismissals), never on the rows they were read from.
 *
 * No period picker: a rhythm needs the whole history to be seen, and a
 * window that hides half the payments would weaken every evidence line on
 * the page. Said on screen.
 */

/**
 * The unit ONE payment is made in — "a month", "a week" — so a price change
 * can be stated in the same terms as the two figures beside it. An irregular
 * pattern has no honest per-payment unit, so it says "a payment" rather than
 * inventing a rhythm the detection has already declined to claim.
 */
function perPaymentUnit(cadence: RecurringCadence): string {
  switch (cadence) {
    case 'weekly': return 'a week';
    case 'monthly': return 'a month';
    case 'annual': return 'a year';
    default: return 'a payment';
  }
}

const CADENCE_BANDS: ReadonlyArray<{ cadence: RecurringCadence; title: string }> = [
  { cadence: 'monthly', title: 'Monthly' },
  { cadence: 'weekly', title: 'Weekly' },
  { cadence: 'annual', title: 'Annual' },
  { cadence: 'irregular', title: 'Irregular' },
];

type SortBy = 'largest' | 'az' | 'payment';
type GroupBy = 'cadence' | 'institution';

const NO_INSTITUTION = 'No institution';

const monthYear = (date: Date): string =>
  date.toLocaleDateString(getDateLocale(), { month: 'short', year: 'numeric' });

const dayMonth = (date: Date): string =>
  date.toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'short' });

/**
 * THE VERDICT CONTROLS ARE BUTTONS, NOT TEXT (owner, 29 Aug: "The 'confirm'
 * or 'non recurring' buttons are hard to see as they are the same colour and
 * size as the text around them. We need to make them more prominent for the
 * user to see at a glance.").
 *
 * They shipped as text-coloured links inside the same 12px grey run as the
 * evidence line and the per-payment figure, divided by a middle dot — which
 * made a row's one decision the least visible thing in the row, and left the
 * whole verdict pipeline looking like more metadata. Chrome is what tells a
 * control apart from a figure at a glance, so the controls get chrome.
 *
 * The split follows what each control IS. Confirm is the row's primary
 * decision — it is what lets a detection feed the calendar and the forecast,
 * where an unanswered one feeds nothing — so it wears the app's
 * primary-action token pair, the same one Accounts' "Add Account" and the
 * sweeps' commit buttons wear. Not recurring, Undo and Restore are the
 * quieter alternatives and wear the bordered secondary that partners it
 * everywhere else in the app.
 *
 * None of them wears amber, red or green. Amber's monopoly on "your next
 * action" still holds and there are twenty of these on a page; more
 * generally, this app reserves the hues for things needing attention, and a
 * routine decision about a correct detection is not a warning.
 *
 * No focus styles are declared: the app has one focus ring, and it is global.
 */
const PRIMARY_ACTION_BUTTON =
  'px-3 py-1.5 text-sm font-medium rounded-lg bg-primary-action text-on-primary-action ' +
  'hover:bg-primary-action-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const SECONDARY_ACTION_BUTTON =
  'px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 ' +
  'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export default function RecurringCommitmentsReport(): React.JSX.Element {
  const {
    accounts, transactions, isLoading,
    suggestionDismissals, suggestionDismissalsStatus,
    refreshSuggestionDismissals,
    dismissSuggestion, restoreSuggestion,
  } = useApp();
  const { formatCurrency, displayCurrency } = useCurrencyDecimal();
  const { showError } = useToast();
  const location = useLocation();

  /**
   * THE VERDICTS ARE LAZY-LOADED, AND THIS PAGE IS A CONSUMER. The context
   * fetches suggestion dismissals "when a sweep opens, not at boot" — so a
   * surface that reads them must ASK, or it reads an empty list with status
   * 'idle' forever. That is precisely what shipped: the Confirm controls
   * gate on status 'ready', nothing here requested the load, and the whole
   * verdict pipeline was invisible in production (owner, 18 Aug: "Where do I
   * 'approve' the recurring payment?"). The tests mocked the status as
   * already 'ready', which is how it slipped.
   */
  useEffect(() => {
    if (suggestionDismissalsStatus === 'idle') void refreshSuggestionDismissals();
  }, [suggestionDismissalsStatus, refreshSuggestionDismissals]);

  const accountName = useMemo(
    () => new Map(accounts.map(a => [a.id, a.name])),
    [accounts]
  );
  const accountInstitution = useMemo(
    () => new Map(accounts.map(a => [a.id, a.institution?.trim() || null])),
    [accounts]
  );

  /**
   * THE VERDICTS (handover §5). Stored through the same door every other
   * suggestion answer goes through, keyed to the PATTERN rather than to any
   * row of it, so an answer survives the next statement import. Load-bearing
   * beyond this page: only a confirmed detection may ever feed the calendar
   * or the forecast — an unconfirmed one is the app's opinion.
   */
  const confirmedKeys = useMemo(
    () => dismissedKeys(suggestionDismissals, 'recurring-confirmed'),
    [suggestionDismissals]
  );
  const notRecurringKeys = useMemo(
    () => dismissedKeys(suggestionDismissals, 'recurring-not'),
    [suggestionDismissals]
  );

  /**
   * Outgoing only: this page answers "what am I committed to", and a
   * commitment is money out. Recurring income (a salary) is detected too,
   * but belongs to the calendar and the forecast, not the audit.
   *
   * The confirmed verdicts feed BACK into detection: a payee the user has
   * vouched for is read leniently (every payment counts, two are enough),
   * so confirming is also what keeps a variable commitment on the page.
   */
  const detections = useMemo(
    () =>
      detectRecurring(transactions, new Date(), {
        isVouched: (accountId, direction, payeeKey) =>
          confirmedKeys.has(recurringAnswerKey(accountId, direction, payeeKey)),
      }).filter(d => d.direction === 'out'),
    [transactions, confirmedKeys]
  );

  /** Where a NEW verdict is stored: always the current label's key. */
  const answerKeyOf = (d: RecurringDetection): string =>
    recurringAnswerKey(d.accountId, d.direction, d.payeeKey);

  /**
   * Where a STANDING verdict actually lives — possibly under a label the
   * bank has since renamed away. A Confirm given before the rename must
   * still be found, and its Undo must delete the row that exists rather
   * than a row that never did.
   */
  const storedKeyOf = (d: RecurringDetection, keys: Set<string>): string | null => {
    for (const payee of d.payeeKeys) {
      const key = recurringAnswerKey(d.accountId, d.direction, payee);
      if (keys.has(key)) return key;
    }
    return null;
  };

  // Which write is in flight, so a double-click cannot record twice and the
  // pressed control is the one that shows it is busy.
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const giveVerdict = async (d: RecurringDetection, kind: RecurringAnswerKind): Promise<void> => {
    const key = answerKeyOf(d);
    const opposite: RecurringAnswerKind =
      kind === 'recurring-confirmed' ? 'recurring-not' : 'recurring-confirmed';
    setSavingKey(key);
    try {
      // One verdict at a time: giving one answer withdraws the other, so the
      // stored state can never say "confirmed AND a coincidence".
      const standingOpposite = storedKeyOf(
        d, opposite === 'recurring-confirmed' ? confirmedKeys : notRecurringKeys
      );
      if (standingOpposite) {
        await restoreSuggestion(opposite, standingOpposite);
      }
      await dismissSuggestion(kind, key, []);
    } catch (error) {
      showError(error);
    } finally {
      setSavingKey(null);
    }
  };

  const withdrawVerdict = async (d: RecurringDetection, kind: RecurringAnswerKind): Promise<void> => {
    const stored = storedKeyOf(
      d, kind === 'recurring-confirmed' ? confirmedKeys : notRecurringKeys
    ) ?? answerKeyOf(d);
    setSavingKey(answerKeyOf(d));
    try {
      await restoreSuggestion(kind, stored);
    } catch (error) {
      showError(error);
    } finally {
      setSavingKey(null);
    }
  };

  const answersReady = suggestionDismissalsStatus === 'ready';

  // A pattern the user has called a coincidence leaves the audit — but never
  // the page (§5: a mis-tap must be recoverable, and the app must not be
  // seen to hide evidence). It moves to the collapsed band at the foot.
  const dismissed = detections.filter(d => storedKeyOf(d, notRecurringKeys) !== null);
  const considered = detections.filter(d => storedKeyOf(d, notRecurringKeys) === null);
  const active = considered.filter(d => !d.stopped);
  const stopped = considered.filter(d => d.stopped);

  /**
   * NAVIGATION (owner, 18 Aug): search, sort, and the Accounts page's
   * institution grouping. These change how the page is walked, never what
   * it claims — the headline total stays the whole ledger's, and anything
   * a search hides is counted out loud rather than silently gone.
   */
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('largest');
  const [groupBy, setGroupBy] = useState<GroupBy>('cadence');

  const trimmedQuery = query.trim().toLowerCase();
  const matchesQuery = (d: RecurringDetection): boolean => {
    if (!trimmedQuery) return true;
    return (
      d.description.toLowerCase().includes(trimmedQuery) ||
      d.formerLabels.some(label => label.toLowerCase().includes(trimmedQuery)) ||
      (accountName.get(d.accountId) ?? '').toLowerCase().includes(trimmedQuery) ||
      (accountInstitution.get(d.accountId) ?? '').toLowerCase().includes(trimmedQuery)
    );
  };
  const shownActive = active.filter(matchesQuery);
  const shownStopped = stopped.filter(matchesQuery);
  const hiddenBySearch = active.length + stopped.length - shownActive.length - shownStopped.length;

  const compare = (a: RecurringDetection, b: RecurringDetection): number => {
    switch (sortBy) {
      case 'az':
        return compareNames(a.description, b.description);
      case 'payment':
        return b.amount.minus(a.amount).toNumber();
      case 'largest':
        return b.annualEquivalent.minus(a.annualEquivalent).toNumber();
    }
  };

  /** The bands the active patterns sit in, under the chosen grouping. */
  const bands: Array<{ id: string; title: string; rows: RecurringDetection[] }> =
    groupBy === 'cadence'
      ? CADENCE_BANDS
          .map(({ cadence, title }) => ({
            id: cadence,
            title,
            rows: shownActive.filter(d => d.cadence === cadence).sort(compare),
          }))
          .filter(band => band.rows.length > 0)
      : (() => {
          const byInstitution = new Map<string, RecurringDetection[]>();
          for (const d of shownActive) {
            const institution = accountInstitution.get(d.accountId) ?? NO_INSTITUTION;
            const rows = byInstitution.get(institution);
            if (rows) rows.push(d);
            else byInstitution.set(institution, [d]);
          }
          return [...byInstitution.keys()]
            .sort((a, b) =>
              a === NO_INSTITUTION ? 1 : b === NO_INSTITUTION ? -1 : compareText(a, b))
            .map(institution => ({
              id: `institution-${institution}`,
              title: institution,
              rows: (byInstitution.get(institution) ?? []).sort(compare),
            }));
        })();

  // Decimal throughout — these are money sums read against each other.
  const annualTotal = active.reduce(
    (sum, d) => sum.plus(d.annualEquivalent), toDecimal(0)
  );

  const bandTotal = (band: RecurringDetection[]): DecimalInstance =>
    band.reduce((sum, d) => sum.plus(d.annualEquivalent), toDecimal(0));

  /** One detection, with its evidence in its resting state. */
  const DetectionRow = ({ detection }: { detection: RecurringDetection }): React.JSX.Element => {
    const account = accountName.get(detection.accountId);
    return (
      <li className="py-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-gray-50 dark:border-gray-700/50 first:border-0">
        <div className="min-w-0">
          <p className="text-body text-gray-900 dark:text-white truncate">
            {/* Into the account's register, where the payments themselves are —
                the same door every other report row opens. */}
            {/* Into the register FILTERED TO THIS PATTERN — every label it
                has worn, so a stitched pattern shows its whole history
                (owner, 18 Aug: the bare account link "is pretty pointless").
                The register consumes the parameter and names the filter. */}
            <Link
              to={preserveDemoParam(
                `/accounts/${detection.accountId}?recurringPayee=${encodeURIComponent(detection.payeeKeys.join('|'))}`,
                location.search
              )}
              // In-app navigation takes no link blue (that colour is for
              // LEAVING — stock-blue ruling, 28 Aug 2026). It inherits the
              // paragraph's ink and the underline is the whole hover.
              className="hover:underline rounded"
              title={account ? `${account} — this pattern's payments in the register` : 'This pattern’s payments in the register'}
            >
              {detection.description}
            </Link>
          </p>
          {/* THE EVIDENCE LINE (§2) — not a tooltip, not a hover: what the
              claim rests on, where the claim is made. */}
          <p className="text-dense text-gray-500 dark:text-gray-400">
            {detection.count} payments since {monthYear(detection.firstDate)}, most
            recent {dayMonth(detection.lastDate)}
            {detection.nextExpected && <> · next expected {dayMonth(detection.nextExpected)}</>}
            {account && <> · {account}</>}
            {/* A stitched pattern says where its earlier payments lived — the
                claim of continuity across a bank's rename is checkable, so it
                is stated. */}
            {detection.formerLabels.length > 0 && (
              <> · previously labelled {detection.formerLabels.map(label => `‘${label}’`).join(', ')}</>
            )}
            {/* A claim resting on the user's own judgment must not dress as
                one resting on the arithmetic. */}
            {detection.relaxed && <> · every payment counted because you marked this recurring</>}
          </p>
          {detection.priceChange && (
            /* THREE FIGURES, TWO UNITS, AND THE OWNER READING IT TWICE
               (29 Aug 2026). This line said "£294.82 → £308.09 in Apr 2026 ·
               +£159.24 a year", and every number in it was right: the first
               two are what one payment cost before and after, and the third
               is what the rise costs over a year. But nothing SAID that the
               third had changed both its unit and its subject, so it read as
               a total that would not reconcile with either its neighbours or
               the annual figure to its right — "a little confusing to read",
               which for a line whose whole job is a price rise is the only
               verdict that matters.

               So the rise is now stated FIRST in the unit of the figures
               beside it ("£13.27 a month more"), and the annual consequence
               follows in words that name it as a consequence ("£159.24 a
               year"). Same numbers, in an order that explains itself. */
            <p className="text-dense text-gray-500 dark:text-gray-400">
              {formatCurrency(detection.priceChange.from, displayCurrency)} →{' '}
              {formatCurrency(detection.priceChange.to, displayCurrency)} in{' '}
              {monthYear(detection.priceChange.when)} ·{' '}
              {/* The DELTA is a direction and wears the hue — costlier is
                  red, cheaper is green. The magnitudes around it stay
                  neutral (§3.1). */}
              <span className={detection.priceChange.annualDelta.greaterThan(0)
                ? 'text-red-600 dark:text-red-400'
                : 'text-green-600 dark:text-green-400'}>
                {formatCurrency(
                  detection.priceChange.to.minus(detection.priceChange.from).abs(),
                  displayCurrency
                )}{' '}
                {perPaymentUnit(detection.cadence)}{' '}
                {detection.priceChange.annualDelta.greaterThan(0) ? 'more' : 'less'}
              </span>
              {' — '}
              {formatCurrency(detection.priceChange.annualDelta.abs(), displayCurrency)} a year
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          {/* The annual figure lands; the per-payment figure explains it. */}
          <p className="text-body font-semibold tabular-nums text-gray-900 dark:text-white">
            {formatCurrency(detection.annualEquivalent, displayCurrency)} a year
          </p>
          <p className="text-dense tabular-nums text-gray-500 dark:text-gray-400">
            {formatCurrency(detection.amount, displayCurrency)} {detection.cadenceLabel}
          </p>
          {/* THE TWO CONTROLS (§5), now wearing chrome — see the note above
              PRIMARY_ACTION_BUTTON for why, and for why neither is amber. */}
          {answersReady && (
            storedKeyOf(detection, confirmedKeys) !== null ? (
              /* "Confirmed" is a STATE and stays text; only the clickable
                 thing beside it is drawn as a control. */
              <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                <span className="text-dense text-gray-500 dark:text-gray-400">Confirmed</span>
                <button
                  type="button"
                  onClick={() => void withdrawVerdict(detection, 'recurring-confirmed')}
                  disabled={savingKey === answerKeyOf(detection)}
                  className={SECONDARY_ACTION_BUTTON}
                  title="Withdraw the confirmation — the pattern goes back to being the app's opinion"
                >
                  Undo
                </button>
              </div>
            ) : (
              /* The gap is the separator: two buttons hold themselves apart,
                 so the middle dot that used to divide two text links is gone. */
              <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => void giveVerdict(detection, 'recurring-confirmed')}
                  disabled={savingKey === answerKeyOf(detection)}
                  className={PRIMARY_ACTION_BUTTON}
                  title="Yes, this is a real commitment — confirmed items can feed the calendar and the forecast"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => void giveVerdict(detection, 'recurring-not')}
                  disabled={savingKey === answerKeyOf(detection)}
                  className={SECONDARY_ACTION_BUTTON}
                  title="A coincidence, not a commitment — it moves to the band at the foot of the page, where it can be restored"
                >
                  Not recurring
                </button>
              </div>
            )
          )}
        </div>
      </li>
    );
  };

  // Skeleton at the real row height, three rows, no pulse (§6) — detection
  // over a long history is one of the few loads that will actually be seen.
  if (isLoading && transactions.length === 0) {
    return (
      <div className="max-w-[var(--report-max,1400px)] mx-auto space-y-3">
        {[0, 1, 2].map(i => (
          <div key={i} className="h-[72px] bg-gray-100 dark:bg-gray-800 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-[var(--report-max,1400px)] mx-auto space-y-6">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-line dark:border-gray-700">
        <h2 className="text-label uppercase tracking-wider font-medium text-gray-500 dark:text-gray-400">
          Committed each year
        </h2>
        {/* The page's one earned total: "how much of my year is already
            spoken for?" is a question people genuinely ask (§3). */}
        <p className="text-page font-bold mt-1 tabular-nums text-gray-900 dark:text-white">
          {formatCurrency(annualTotal, displayCurrency)}
        </p>
        <p className="text-dense text-gray-500 dark:text-gray-400 mt-1">
          {active.length === 1 ? '1 recurring payment' : `${active.length} recurring payments`}
          {' '}— weekly and monthly items annualised, read from your whole history.
          These are patterns the app has noticed, not entries you made: each one
          shows the payments it rests on.
        </p>
      </div>

      {active.length + stopped.length > 0 && (
        /* The controls change how the page is walked, never what it claims. */
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-4 flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="relative flex-1 min-w-[220px]">
            <SearchIcon
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 pointer-events-none"
            />
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search payee, account or institution"
              aria-label="Search recurring payments"
              className="w-full pl-9 pr-3 py-2 text-body bg-transparent border border-line dark:border-gray-600 rounded-lg text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500"
            />
          </div>
          <label className="flex items-center gap-2 text-dense text-gray-500 dark:text-gray-400">
            Sort
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value as SortBy)}
              className="bg-white dark:bg-gray-800 border border-line dark:border-gray-600 rounded-lg px-2 py-1.5 text-body text-gray-900 dark:text-white"
            >
              <option value="largest">Largest a year</option>
              <option value="az">A to Z</option>
              <option value="payment">Largest payment</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-dense text-gray-500 dark:text-gray-400">
            Group
            <select
              value={groupBy}
              onChange={e => setGroupBy(e.target.value as GroupBy)}
              className="bg-white dark:bg-gray-800 border border-line dark:border-gray-600 rounded-lg px-2 py-1.5 text-body text-gray-900 dark:text-white"
            >
              <option value="cadence">By cadence</option>
              <option value="institution">By institution</option>
            </select>
          </label>
        </div>
      )}

      {detections.length > 0 && dismissed.length === detections.length ? (
        /* Every pattern struck off — a FILTERED empty, not an empty: the
           count and the reason are named, per the batch-7 rule. */
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
          <p className="text-body text-gray-500 dark:text-gray-400">
            {dismissed.length === 1
              ? 'The one pattern the app found is marked not recurring'
              : `All ${dismissed.length} patterns the app found are marked not recurring`}
            {' '}— they are in the band below, where any can be restored.
          </p>
        </div>
      ) : transactions.length === 0 ? (
        /* CONSEQUENCE, THEN REMEDY (§6): a fresh ledger cannot show rhythm. */
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
          <p className="text-body text-gray-500 dark:text-gray-400">
            Recurring payments are found by looking for the same amount arriving
            on the same rhythm, so this needs a few months of history before it
            can tell you anything.{' '}
            <Link
              to={preserveDemoParam('/enhanced-import', location.search)}
              className="text-primary hover:underline"
            >
              Import a statement →
            </Link>
          </p>
        </div>
      ) : detections.length === 0 ? (
        /* History, nothing found — a genuine finding, not a failure (§6),
           said with what it looked for. */
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
          <p className="text-body text-gray-500 dark:text-gray-400">
            Nothing here repeats. The app looked for {MIN_PAYMENTS} or more
            payments of the same amount to the same payee on a steady rhythm,
            and found none — which may be exactly right. You can also open any
            payment in its register and mark it recurring yourself — the app
            then reads that payee's history as a commitment.
          </p>
        </div>
      ) : trimmedQuery && shownActive.length + shownStopped.length === 0 ? (
        /* The search hid everything — a filtered empty, with the count, the
           filter responsible and the way back (batch-7 rule). */
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
          <p className="text-body text-gray-500 dark:text-gray-400">
            No recurring payments match ‘{query.trim()}’ — {hiddenBySearch === 1
              ? '1 is hidden by the search'
              : `${hiddenBySearch} are hidden by the search`}.{' '}
            <button
              type="button"
              onClick={() => setQuery('')}
              className="text-primary hover:underline"
            >
              Clear the search
            </button>
          </p>
        </div>
      ) : (
        <>
          {hiddenBySearch > 0 && (
            <p className="text-dense text-gray-500 dark:text-gray-400">
              Showing {shownActive.length + shownStopped.length} of{' '}
              {active.length + stopped.length} recurring payments —{' '}
              {hiddenBySearch} hidden by the search.
            </p>
          )}

          {bands.map(band => (
            <div key={band.id} className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                <h2 className="text-card font-semibold text-theme-heading dark:text-white">
                  {band.title}
                  <span className="ml-2 text-dense font-normal text-gray-400 dark:text-gray-500">
                    {band.rows.length}
                  </span>
                </h2>
                <span className="text-body font-semibold tabular-nums text-gray-900 dark:text-white">
                  {formatCurrency(bandTotal(band.rows), displayCurrency)} a year
                </span>
              </div>
              <ul>
                {band.rows.map(d => <DetectionRow key={d.key} detection={d} />)}
              </ul>
            </div>
          ))}

          {shownStopped.length > 0 && (
            /* Ran, and then didn't (§3.2) — either cancelled (good to know)
               or failed (good to look at). Never silently deleted. */
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                <h2 className="text-card font-semibold text-theme-heading dark:text-white">
                  Stopped
                  <span className="ml-2 text-dense font-normal text-gray-400 dark:text-gray-500">
                    {shownStopped.length}
                  </span>
                </h2>
                <span className="text-dense text-gray-500 dark:text-gray-400">
                  Ran on a rhythm, then didn't — cancelled, or worth a look
                </span>
              </div>
              <ul>
                {shownStopped.map(d => (
                  <li key={d.key} className="py-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-gray-50 dark:border-gray-700/50 first:border-0">
                    <div className="min-w-0">
                      <p className="text-body text-gray-900 dark:text-white truncate">
                        <Link
                          to={preserveDemoParam(
                            `/accounts/${d.accountId}?recurringPayee=${encodeURIComponent(d.payeeKeys.join('|'))}`,
                            location.search
                          )}
                          className="hover:underline rounded"
                        >
                          {d.description}
                        </Link>
                      </p>
                      <p className="text-dense text-gray-500 dark:text-gray-400">
                        {d.count} payments, {d.cadenceLabel} · last seen {dayMonth(d.lastDate)} {d.lastDate.getFullYear()}
                        {accountName.get(d.accountId) && <> · {accountName.get(d.accountId)}</>}
                      </p>
                    </div>
                    <p className="text-dense tabular-nums text-gray-500 dark:text-gray-400 shrink-0">
                      was {formatCurrency(d.amount, displayCurrency)} {d.cadenceLabel}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {dismissed.length > 0 && (
        /* NOT RECURRING — collapsed, never gone (§5): a mis-tap is one click
           to recover, and the app is not silently hiding evidence. These
           patterns count in no total on this page. */
        <details className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700">
          <summary className="cursor-pointer select-none p-6 text-card font-semibold text-theme-heading dark:text-white">
            Not recurring
            <span className="ml-2 text-dense font-normal text-gray-400 dark:text-gray-500">
              {dismissed.length}
            </span>
            <span className="ml-3 text-dense font-normal text-gray-500 dark:text-gray-400">
              Patterns you said are coincidence — restorable any time
            </span>
          </summary>
          <ul className="px-6 pb-6">
            {dismissed.map(d => (
              <li key={d.key} className="py-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-gray-50 dark:border-gray-700/50 first:border-0">
                <div className="min-w-0">
                  <p className="text-body text-gray-900 dark:text-white truncate">{d.description}</p>
                  <p className="text-dense text-gray-500 dark:text-gray-400">
                    {d.count} payments, {d.cadenceLabel}
                    {accountName.get(d.accountId) && <> · {accountName.get(d.accountId)}</>}
                  </p>
                </div>
                {/* The same bordered secondary the row's own quiet actions
                    wear: this is the way back out of a mis-tap, and it should
                    not be harder to spot than the mistake was to make. */}
                <button
                  type="button"
                  onClick={() => void withdrawVerdict(d, 'recurring-not')}
                  disabled={savingKey === answerKeyOf(d)}
                  className={`${SECONDARY_ACTION_BUTTON} shrink-0`}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
