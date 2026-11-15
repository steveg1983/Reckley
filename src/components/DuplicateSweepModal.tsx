import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Modal, ModalBody, ModalFooter } from './common/Modal';
import { useApp } from '../contexts/AppContextSupabase';
import { useToast } from '../contexts/ToastContext';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import { useAccountNames } from '../hooks/useAccountNames';
import {
  candidatesSharingRows,
  deleteBlockOf,
  deleteRefusalFor,
  findDuplicateCandidates,
  needsConfirmation,
  type DeleteBlock,
  type DuplicateCandidate,
} from '../utils/duplicateSweep';
import {
  dismissedKeys,
  duplicateDismissalKey,
  duplicateDismissalSubjectIds,
} from '../utils/suggestionDismissals';
import { buildTransactionRegisterPath } from '../utils/transactionDeepLink';
import { createCategoryLabeller } from '../utils/categoryLabel';
import { currentPageProvenance, withProvenance } from '../utils/navigationProvenance';
import { ARRIVAL_ROW_CLASS, useArrivalAction, useArrivalRowFocus } from '../hooks/useArrivalFocus';
import {
  DEFAULT_WINDOW_DAYS,
  WINDOW_CHOICES,
  type DuplicateSortKey,
  type DuplicateSweepSession,
  type WindowDays,
} from '../utils/duplicateSweepSession';
import DismissedSuggestionsSection from './sweeps/DismissedSuggestionsSection';
import GroupedAccountOptions from './common/GroupedAccountOptions';
import { AlertTriangleIcon, ArrowUpRightIcon } from './icons';
import type { SuggestionDismissal, Transaction } from '../types';
import { getDateLocale } from '../utils/dateFormatter';
import { formatCount, compareNames } from '../utils/localeFormat';
import { keysOfRowsInView } from '../utils/rowsInView';

/**
 * Find duplicates — the same sweep shape as "Match transfers", for the other
 * commonest mess in real data: one payment recorded twice.
 *
 * It is a DELETE tool, so it is built the other way round from every other
 * sweep in the app: nothing is bulk-applied, nothing is pre-selected, and the
 * user has to say which of the two copies goes. The scan cannot know which one
 * is the real one — one may be reconciled, categorised or carry a note the
 * other does not — so it never guesses.
 *
 * The scan finds in two tiers (see utils/duplicateSweep), and this screen keeps
 * them apart on purpose. Pairs whose WORDING agrees as well as their money are
 * near-certain. Pairs found only because the money and the day agree are
 * evidence: a renamed payee looks exactly like that, and so do two separate
 * payments of the same size. Those carry an extra confirmation that the user
 * has to give pair by pair — and the button is gated by
 * `deleteRefusalFor`, not by this component's opinion, so the rule holds
 * wherever it is asked from.
 *
 * Three shapes of row are refused outright, with the reason said out loud
 * rather than the row being quietly hidden (see utils/duplicateSweep):
 * deleting one would leave something else in the ledger pointing at nothing.
 * The user still needs to know the two rows look identical — they can unpick
 * the transfer or the split themselves and come back.
 *
 * Every row here also has a way OUT to itself — the register, centred on the
 * row, where the neighbours and the running balance are. Two evidence cards
 * cannot settle every case ("is this the standing order or the manual one?"),
 * and the answer is usually in the rows around it. See `openInRegister`.
 */

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Where the user was when they last left this dialog for the register, handed
   * back by Data Management. Null on an ordinary open, which starts fresh.
   *
   * How far apart two copies may be, in days: "within N" means the two dates
   * are at most N days apart, inclusive — so "within 1 day" is the same day or
   * the day either side of it, the tightest a feed-versus-import overlap ever
   * is. 1 is the narrowest choice rather than the default: a bank feed can post
   * a card payment two or three days after an import already carried it, and 3
   * stays the default so the sweep's reach does not silently shrink for
   * everyone. The window is also the yardstick the date score is measured
   * against (see duplicateScan.dateScoreOf), so a NARROWER window is strictly
   * stricter: at 3 days a pair one day apart still scores 83 on date, at 1 day
   * the same pair scores 50 and its wording has to carry more of the case.
   */
  resume?: DuplicateSweepSession | null;
}

const CAP = 300;

/** "1 day", not "1 days" — the singular is the whole reason this exists. */
const windowLabel = (days: WindowDays): string => `${days} day${days === 1 ? '' : 's'}`;

type SortKey = DuplicateSortKey;

/** Case-insensitive, so "TESCO" and "Tesco" sit together, not in two blocks. */
const compareText = (a: string, b: string): number =>
  compareNames(a, b);

const earlier = (candidate: DuplicateCandidate): Transaction =>
  new Date(candidate.a.date).getTime() <= new Date(candidate.b.date).getTime()
    ? candidate.a
    : candidate.b;

function compareCandidates(
  left: DuplicateCandidate,
  right: DuplicateCandidate,
  key: SortKey,
  accountName: (id: string) => string
): number {
  switch (key) {
    case 'account':
      return compareText(accountName(left.a.accountId), accountName(right.a.accountId));
    case 'description':
      return compareText(left.a.description, right.a.description);
    case 'amount':
      return Math.abs(left.a.amount) - Math.abs(right.a.amount);
    case 'date':
      return new Date(earlier(left).date).getTime() - new Date(earlier(right).date).getTime();
  }
}

const shortDate = (date: Date | string): string =>
  new Date(date).toLocaleDateString(getDateLocale(), { day: '2-digit', month: 'short', year: '2-digit' });

const longDate = (date: Date | string): string =>
  new Date(date).toLocaleDateString(getDateLocale(), { day: '2-digit', month: 'long', year: 'numeric' });

const gapPhrase = (daysApart: number): string => {
  const days = Math.round(daysApart);
  return days === 0 ? 'on the same day' : `${days} day${days === 1 ? '' : 's'} apart`;
};

export default function DuplicateSweepModal({ isOpen, onClose, resume = null }: Props): React.JSX.Element {
  const {
    accounts, transactions, categories, deleteTransaction,
    suggestionDismissals, suggestionDismissalsStatus, refreshSuggestionDismissals,
    dismissSuggestion, restoreSuggestion,
  } = useApp();
  const { formatCurrency } = useCurrencyDecimal();
  const { showSuccess, showError } = useToast();
  const accountName = useAccountNames();
  const navigate = useNavigate();
  const location = useLocation();

  // Every control the user had set when they left starts back where they left
  // it. Read once, in the initialiser: this dialog is mounted only while open
  // (Data Management gates it), so "once" is once per sitting.
  const [windowDays, setWindowDays] = useState<WindowDays>(resume?.windowDays ?? DEFAULT_WINDOW_DAYS);
  const [accountFilter, setAccountFilter] = useState(resume?.accountFilter ?? '');
  const [reviewing, setReviewing] = useState<DuplicateCandidate | null>(null);
  /** Which copy the user has chosen to delete, inside the review. */
  const [chosenId, setChosenId] = useState<string | null>(null);
  /** The answer to "these two are one payment" — for the weaker tier only. */
  const [confirmedSame, setConfirmedSame] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Which dismissed suggestion is being brought back, if any. */
  const [restoringKey, setRestoringKey] = useState<string | null>(null);
  // Refused pairs, keyed the canonical way — the bridge between the click and
  // the persisted refusal arriving back through suggestionDismissals.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  /**
   * THE BULK REFUSAL — rows ticked for "These are not duplicates" (owner,
   * 1 Sep 2026: a ledger with years of imports surfaced two thousand
   * suggestions, every one already settled by the account adjustments that
   * make his balances reconcile — "save me going through over 2000!").
   * Selection is by pair key; the press routes through the SAME judgment as
   * the review dialog's refusal, cluster-wide per the 29 Aug ruling, and
   * every refusal stays individually restorable from Dismissed suggestions.
   */
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkSaving, setBulkSaving] = useState<{ done: number; total: number } | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>(resume?.sortKey ?? 'date');
  const [sortDir, setSortDir] = useState<1 | -1>(resume?.sortDir ?? -1);
  // The row they jumped from: highlighted and scrolled back into view, the same
  // way the register lands on a ?txn= row.
  const pairFocus = useArrivalRowFocus(resume?.pairKey ?? null);

  useEffect(() => {
    if (isOpen) void refreshSuggestionDismissals();
  }, [isOpen, refreshSuggestionDismissals]);

  const candidates = useMemo(() => {
    if (!isOpen) return [] as DuplicateCandidate[];
    return findDuplicateCandidates(transactions, { windowDays });
  }, [isOpen, transactions, windowDays]);

  /**
   * Whether the dismissal filter has run. The list is held back until it has —
   * showing a suggestion for a second and then snatching it away is precisely
   * what the persistent dismissals exist to end.
   */
  const dismissalsChecked =
    suggestionDismissalsStatus === 'ready' || suggestionDismissalsStatus === 'error';
  const dismissedDuplicateKeys = useMemo(
    () => dismissedKeys(suggestionDismissals, 'duplicate'),
    [suggestionDismissals]
  );
  const duplicateDismissals = useMemo(
    () => suggestionDismissals.filter(d => d.kind === 'duplicate'),
    [suggestionDismissals]
  );
  const transactionsById = useMemo(
    () => new Map(transactions.map(t => [t.id, t])),
    [transactions]
  );
  /**
   * What a copy is filed as — through the register's own resolver.
   *
   * It was `categories.find(c => c.id === id)?.name`, which is the leaf name
   * alone and NOTHING for a transfer, whose category is the literal
   * 'transfer-out'. So a duplicated transfer — a pair this dialog invites you
   * to delete half of — described itself as "Not categorised" while the
   * register two taps away read "Transfer > Savings". The phone register told
   * the same lie for the same reason, and was reported on 1 Sep 2026; one
   * resolver everywhere is what stops it being told a third time.
   */
  const categoryLabel = useMemo(
    () => createCategoryLabeller(categories, accounts),
    [categories, accounts]
  );

  // Memoised because the return trip's "reopen the review I was in" reads it:
  // a fresh array every render would re-fire that lookup on every render until
  // the scan resolves. It is also the list every count and both tables come
  // from, so recomputing it for nothing was never free.
  const live = useMemo(
    () => (!dismissalsChecked ? [] : candidates.filter(candidate => {
      const key = duplicateDismissalKey(candidate.a, candidate.b);
      return !dismissed.has(key) && !dismissedDuplicateKeys.has(key);
    })),
    [dismissalsChecked, candidates, dismissed, dismissedDuplicateKeys]
  );

  /**
   * They left from inside the review of one pair, so that is where they come
   * back to — the two evidence cards they were comparing, not the list.
   *
   * Retries until the scan has run and the dismissal filter has been applied,
   * because on the first render neither has. Nothing is pre-selected on the way
   * back in: which copy to delete is a decision, and a decision does not
   * survive a trip to another page (see `review`).
   */
  const reopenReview = useCallback((pairKey: string): boolean => {
    if (!dismissalsChecked) return false;
    const candidate = live.find(c => duplicateDismissalKey(c.a, c.b) === pairKey);
    if (!candidate) return false;
    setReviewing(candidate);
    setChosenId(null);
    setConfirmedSame(false);
    return true;
  }, [dismissalsChecked, live]);
  useArrivalAction(resume?.reviewing === true ? resume.pairKey : null, reopenReview);

  /** Account id → type, for the filter's banding. Closed accounts are not in
      the context list, so theirs is unknown and files under the catch-all —
      the honest answer, and their name already reads "… (closed)". */
  const accountTypeById = useMemo(
    () => new Map(accounts.map(account => [account.id, account.type])),
    [accounts]
  );

  /**
   * Every account the sweep found something in. The scan already covers the
   * whole history in one run; this is so a user who has cleaned one account can
   * see at a glance which of the others still have work in them, and take one
   * at a time without leaving the screen.
   *
   * Unsorted here on purpose: the dropdown bands these into the app's account
   * sections and alphabetises inside each one (GroupedAccountOptions), and a
   * second ordering applied first would be thrown away.
   */
  const accountsWithWork = (() => {
    const counts = new Map<string, number>();
    for (const candidate of live) {
      counts.set(candidate.a.accountId, (counts.get(candidate.a.accountId) ?? 0) + 1);
    }
    return [...counts.entries()].map(([id, count]) => ({
      id,
      name: accountName(id),
      type: accountTypeById.get(id) ?? '',
      count,
    }));
  })();
  // A filter whose account has since been emptied would hide everything with no
  // way back, so a stale choice falls back to showing all of them.
  const scopedAccount = accountsWithWork.some(a => a.id === accountFilter) ? accountFilter : '';
  const inScope = scopedAccount ? live.filter(c => c.a.accountId === scopedAccount) : live;

  // Sort BEFORE the cap: sorting the first 300 of an arbitrary order just
  // reshuffles the same 300, which is no use to someone working through a long
  // list looking for the oldest or the largest.
  const sorted = [...inScope].sort((a, b) => sortDir * compareCandidates(a, b, sortKey, accountName));
  const wordingAgrees = sorted.filter(c => !needsConfirmation(c));
  const needsYourEye = sorted.filter(c => needsConfirmation(c));

  const sortBy = (key: SortKey): void => {
    if (sortKey === key) {
      setSortDir(d => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(key === 'date' || key === 'amount' ? -1 : 1);
    }
  };
  const arrow = (key: SortKey): string => (sortKey === key ? (sortDir === 1 ? ' ↑' : ' ↓') : '');

  /**
   * Leave the sweep and land on the row itself, centred in its account's
   * register with the surrounding rows and the running balance around it —
   * the one thing an evidence card cannot show. Same mechanic as the
   * transaction editor's "See this transaction in …" (buildTransactionRegisterPath),
   * not a second one.
   *
   * The modal is closed FIRST so it is not left hanging over the register it
   * just opened. It used to be a one-way trip: Data Management unmounts the
   * dialog on close, so the sitting's window, account filter, sort order and
   * place in a three-hundred-row list all went with it, and the browser's back
   * button returned to a settings page with no dialog on it. Now the trip
   * carries its own way home — the register shows "Back to Find duplicates",
   * and these crumbs come back with the user (see utils/duplicateSweepSession).
   *
   * `reviewing` is asked of the CALLER, not of state: both entry points fire
   * this, and the one in the list must not bring the reader back into a review
   * they never opened.
   */
  const openInRegister = useCallback((transaction: Transaction, pair: DuplicateCandidate, fromReview: boolean): void => {
    const session: DuplicateSweepSession = {
      tool: 'find-duplicates',
      windowDays,
      accountFilter,
      sortKey,
      sortDir,
      pairKey: duplicateDismissalKey(pair.a, pair.b),
      reviewing: fromReview,
    };
    onClose();
    navigate(
      buildTransactionRegisterPath(transaction.accountId, transaction.id, location.search),
      { state: withProvenance(currentPageProvenance(location, 'Back to Find duplicates', session)) }
    );
  }, [navigate, location, onClose, windowDays, accountFilter, sortKey, sortDir]);

  const review = (candidate: DuplicateCandidate): void => {
    setReviewing(candidate);
    // Nothing is pre-selected, deliberately: the scan cannot tell which copy is
    // the real one, and a pre-ticked delete is how the wrong row goes.
    setChosenId(null);
    setConfirmedSame(false);
  };

  /** The row the user has picked, when it is genuinely deletable. */
  const chosen = reviewing && chosenId
    ? [reviewing.a, reviewing.b].find(t => t.id === chosenId) ?? null
    : null;

  /**
   * The single source of truth for whether this delete may happen. Asked here
   * to draw the button, and asked again before the delete actually runs.
   */
  const refusal = reviewing && chosen
    ? deleteRefusalFor(reviewing, chosen, confirmedSame)
    : null;

  /**
   * What deleting the chosen copy does to the account — said before it happens.
   * The balance MOVING is the point of the whole exercise: money counted twice
   * has to stop being counted twice.
   */
  const deleteConsequence = (transaction: Transaction): string => {
    const money = formatCurrency(Math.abs(transaction.amount));
    const where = accountName(transaction.accountId);
    const direction = transaction.amount < 0
      ? `${where}’s balance goes up by ${money}, because that ${money} was taken off twice.`
      : `${where}’s balance goes down by ${money}, because that ${money} was added twice.`;
    return `This row is deleted for good — it is not archived, and it cannot be brought back. ${direction} The other copy stays exactly as it is.`;
  };

  const BLOCK_REASONS: Record<DeleteBlock, (t: Transaction) => string> = {
    'linked-transfer': t =>
      `This row is one half of a linked transfer with ${accountName(t.transferAccountId ?? '')}. Deleting it would leave the row over there pointing at nothing — a transfer with one side, which misstates both accounts. Unlink the pair first, then come back.`,
    'split-line-counterpart': () =>
      'This row is the other side of one LINE inside a split transaction. Deleting it would leave that line pointing at nothing. Edit the split to unpick the transfer first, then come back.',
    'split-parent': () =>
      'This row is split into lines. Deleting it takes the whole breakdown with it — including any line that is one half of a transfer, whose other side would be stranded. Remove the split first if you really do mean to delete it.',
  };

  const handleDelete = async (): Promise<void> => {
    if (!reviewing || !chosen) return;
    // Asked again, not inherited from the disabled button: a disabled attribute
    // is a hint to a mouse, and this is the last point before a row is gone.
    if (deleteRefusalFor(reviewing, chosen, confirmedSame) !== null) return;
    setDeleting(true);
    try {
      const money = formatCurrency(Math.abs(chosen.amount));
      const where = accountName(chosen.accountId);
      await deleteTransaction(chosen.id);
      showSuccess(
        `The copy is gone and ${where} has been corrected by ${money}. The other copy is untouched.`,
        'Duplicate deleted'
      );
      setReviewing(null);
      setChosenId(null);
      setConfirmedSame(false);
    } catch (error) {
      // Verbatim: the database's own refusal names the precondition that
      // failed, and a silent failure on a delete is the worst outcome here.
      showError(error);
    } finally {
      setDeleting(false);
    }
  };

  /**
   * "Not a duplicate" IS the judgment, so it is remembered the moment it is
   * made — no follow-up question (owner, 29 Aug: "under what circumstance
   * would you say it's not a duplicate but yes, ask me again?"; there is
   * none, and the no-commitment path is closing the dialog without
   * answering). Safe as one step because it is reversible: every refusal is
   * its own row in "Dismissed suggestions" at the foot of the list.
   *
   * One stored refusal PER PAIR of the cluster, so each is individually
   * restorable — the cluster is one judgment but not one row. A failed write
   * says so with its consequence: the pairs are out for THIS sitting either
   * way, so the screen looks decided whether the decision saved or not.
   */
  const persistRefusal = async (cluster: DuplicateCandidate[]): Promise<void> => {
    try {
      for (const pair of cluster) {
        await dismissSuggestion(
          'duplicate',
          duplicateDismissalKey(pair.a, pair.b),
          duplicateDismissalSubjectIds(pair.a, pair.b)
        );
      }
      showSuccess(
        cluster.length === 1
          ? 'These two will not be offered again. Bring them back any time from “Dismissed suggestions” at the foot of this list.'
          : `That repeated payment will not be offered again — all ${cluster.length} suggestions made of its rows are remembered as refused. Bring any of them back from “Dismissed suggestions” at the foot of this list.`,
        'Not a duplicate — remembered'
      );
    } catch (error) {
      showError(error);
      showError(
        new Error(
          'That refusal was NOT saved — the rows stay out of this sitting, but they will be offered again the next time you run this.'
        )
      );
    }
  };

  /**
   * The bulk refusal's true extent: every selected row's judgment, expanded
   * to the cluster of live pairs sharing its rows — the review dialog's own
   * rule (owner, 29 Aug: a refusal is about the repeated payment, not one
   * pairing of it). Deduped by key so overlapping clusters refuse once.
   * Computed on the button press, not per render — with everything selected
   * this walks selected × live.
   */
  const bulkRefusalPairs = (): DuplicateCandidate[] => {
    const byKey = new Map<string, DuplicateCandidate>();
    for (const candidate of inScope) {
      if (!selectedKeys.has(duplicateDismissalKey(candidate.a, candidate.b))) continue;
      for (const pair of candidatesSharingRows(live, candidate)) {
        byKey.set(duplicateDismissalKey(pair.a, pair.b), pair);
      }
    }
    return [...byKey.values()];
  };

  /** What "These are not duplicates" will actually refuse — set when pressed. */
  const [bulkPending, setBulkPending] = useState<DuplicateCandidate[]>([]);

  const confirmBulkRefusal = async (): Promise<void> => {
    const pairs = bulkPending;
    setBulkConfirm(false);
    setBulkPending([]);
    if (pairs.length === 0) return;
    // Off the list the moment the judgment is made — the single refusal's own
    // order of operations. Persistence follows, one row per pair so each
    // stays individually restorable, and failure is reported with its
    // consequence rather than swallowed.
    setDismissed(previous => {
      const next = new Set(previous);
      for (const pair of pairs) next.add(duplicateDismissalKey(pair.a, pair.b));
      return next;
    });
    setSelectedKeys(new Set());
    setBulkSaving({ done: 0, total: pairs.length });
    let failed = 0;
    for (const [index, pair] of pairs.entries()) {
      try {
        await dismissSuggestion(
          'duplicate',
          duplicateDismissalKey(pair.a, pair.b),
          duplicateDismissalSubjectIds(pair.a, pair.b)
        );
      } catch {
        failed += 1;
      }
      setBulkSaving({ done: index + 1, total: pairs.length });
    }
    setBulkSaving(null);
    if (failed === 0) {
      showSuccess(
        `${formatCount(pairs.length)} suggestion${pairs.length === 1 ? '' : 's'} will not be offered again. Bring any back from “Dismissed suggestions” at the foot of this list.`,
        'Not duplicates — remembered'
      );
    } else {
      showError(
        new Error(
          `${formatCount(failed)} of ${formatCount(pairs.length)} refusals did NOT save — those are out of this sitting, but they will be offered again the next time this runs.`
        )
      );
    }
  };

  const selectedInScope = useMemo(() => {
    let count = 0;
    for (const candidate of inScope) {
      if (selectedKeys.has(duplicateDismissalKey(candidate.a, candidate.b))) count += 1;
    }
    return count;
  }, [inScope, selectedKeys]);
  // "All" means the whole SCOPE — the account filter is respected, the
  // display cap is not: the button exists precisely for a list too long to
  // page through three hundred at a time.
  const allInScopeSelected = inScope.length > 0 && selectedInScope === inScope.length;
  const toggleSelectAll = (): void => {
    setSelectedKeys(
      allInScopeSelected
        ? new Set()
        : new Set(inScope.map(candidate => duplicateDismissalKey(candidate.a, candidate.b)))
    );
  };
  /*
   * SELECT ALL IN VIEW (owner, 15 Nov 2026): tick what is on screen, scroll,
   * press again to ADD the next screenful. It only ever adds; the bar is
   * pinned so the button is still there after scrolling, and a row hidden
   * under the bar does not count as seen.
   */
  const bulkBarRef = useRef<HTMLDivElement>(null);
  const selectAllInView = (): void => {
    const bar = bulkBarRef.current;
    const root = bar?.parentElement;
    if (!bar || !root) return;
    const visible = keysOfRowsInView(root, 'data-pair-key', bar.getBoundingClientRect().bottom);
    if (visible.length === 0) return;
    setSelectedKeys(previous => {
      const next = new Set(previous);
      for (const key of visible) next.add(key);
      return next;
    });
  };
  const toggleSelected = (key: string): void => {
    setSelectedKeys(previous => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleRestore = async (dismissal: SuggestionDismissal): Promise<void> => {
    setRestoringKey(dismissal.subjectKey);
    try {
      await restoreSuggestion(dismissal.kind, dismissal.subjectKey);
      showSuccess('It is back in the list below.', 'Restored');
    } catch (error) {
      showError(error);
    } finally {
      setRestoringKey(null);
    }
  };

  /**
   * One copy as an evidence card: the radio that chooses it for DELETION, and
   * a separate way in to LOOK at it. Those two are not allowed to be mistaken
   * for one another, so they are built differently on purpose:
   *
   *  - the radio and the whole body of the card are one `<label>`, so clicking
   *    the evidence selects the copy — a genuine either/or, with the native
   *    control's keyboard behaviour and grouping;
   *  - the way in sits OUTSIDE that label, below the rule, as a plain text
   *    button in the app's "leaving for context" idiom (arrow glyph, primary
   *    text, no card chrome). Outside the label is the load-bearing part: a
   *    click on it cannot fall through to the radio, so "let me look at this
   *    one" can never come out as "delete this one". It is its own tab stop.
   *
   * A real `input type="radio"`, not a styled div. An undeletable copy is
   * disabled, with the reason underneath — visible, because "why can't I
   * delete this one?" is the question that would otherwise send the user round
   * in circles — and its way in stays live, since going and unpicking the
   * transfer or the split is exactly what that user has to do next.
   */
  const renderCopy = (pair: DuplicateCandidate, transaction: Transaction, label: string): React.JSX.Element => {
    const block = deleteBlockOf(transaction);
    // Empty is the labeller's answer for "this id resolves to nothing", and
    // the line below already has a sentence for that.
    const category = categoryLabel(transaction);
    const isChosen = chosenId === transaction.id;
    return (
      <div
        key={transaction.id}
        className={`rounded-xl border p-4 transition-all ${
          block
            ? 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40'
            : isChosen
              ? 'border-red-400 dark:border-red-500 bg-red-50/60 dark:bg-red-900/20'
              : 'border-gray-200 dark:border-gray-700 hover:border-primary'
        }`}
      >
        <label className={`flex items-start gap-3 ${block ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
          <input
            type="radio"
            name="duplicate-copy"
            value={transaction.id}
            checked={isChosen}
            disabled={block !== null || deleting}
            onChange={() => setChosenId(transaction.id)}
            className="mt-1 rounded-full border-gray-300"
          />
          <span className="min-w-0">
            <span className="block text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
              {label}
            </span>
            {/* SIGN AS WELL AS HUE (owner, 30 Aug: "I can't tell which
                duplicate is an income transaction or an expense"). The colour
                was already here; the sign is what the house amount idiom
                demands beside it — +£100.00 / −£100.00 — because a hue alone
                is unreadable to some eyes and unspoken by a screen reader. */}
            <span className={`block text-lg font-bold tabular-nums ${transaction.amount < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
              {transaction.amount < 0 ? '\u2212' : '+'}{formatCurrency(Math.abs(transaction.amount))}
            </span>
            <span className="mt-1 block text-sm text-gray-900 dark:text-white break-words">
              {transaction.description}
            </span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              {longDate(transaction.date)}
            </span>
            <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
              {category ? `Filed as ${category}` : 'Not categorised'}
              {transaction.cleared === true && ' · reconciled'}
              {transaction.isImported === true && ' · imported'}
            </span>
            {transaction.notes && (
              <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400 break-words">
                {transaction.notes}
              </span>
            )}
            {block && (
              <span className="mt-2 flex items-start gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                <AlertTriangleIcon size={12} className="mt-0.5 flex-shrink-0" />
                <span>{BLOCK_REASONS[block](transaction)}</span>
              </span>
            )}
          </span>
        </label>
        {/* Named for the ACCESSIBLE name, because both copies are in the same
            account and two buttons reading the same words tell a screen-reader
            user nothing about which row they are about to open. */}
        <button
          type="button"
          onClick={() => openInRegister(transaction, pair, true)}
          aria-label={`See the ${label.toLowerCase()} in ${accountName(transaction.accountId)}`}
          className="mt-3 inline-flex items-center gap-1.5 border-t border-gray-100 dark:border-gray-700 pt-3 w-full text-sm font-medium text-primary hover:text-secondary"
        >
          <ArrowUpRightIcon size={14} />
          See this row in the register
        </button>
      </div>
    );
  };

  /** The likeness evidence, said in the terms of the tier the pair is in. */
  const likeness = (candidate: DuplicateCandidate): string => {
    if (!needsConfirmation(candidate)) return `${Math.round(candidate.score)}% alike`;
    return candidate.descriptionOverlap === 0
      ? 'Not one word in common'
      : `${Math.round(candidate.descriptionOverlap * 100)}% of the words in common`;
  };

  const renderTable = (rows: DuplicateCandidate[], total: number): React.JSX.Element => (
    <div className="overflow-x-auto">
      {/* A table on a desktop, cards on a phone — the house reflow (see
          BulkCategorizeModal, BudgetWizard). At 375pt the five columns
          crushed the Review button half off the glass (owner's screenshot,
          1 Sep 2026); below `sm` each row is now a two-column card placed by
          explicit grid coordinates, since the source order is the desktop's
          column order. The thead hides with the columns; the phone-only
          "Sort by" control above the sections replaces its buttons. */}
      <table className="block sm:table w-full">
        <thead className="hidden sm:table-header-group">
          <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
            <th className="pb-2 w-8" aria-label="Select" />
            {([
              ['date', 'Date', 'Sort by date'],
              ['account', 'Account', 'Sort by account name'],
              ['description', 'Description', 'Sort by description'],
              ['amount', 'Amount', 'Sort by amount size'],
            ] as const).map(([key, label, hint]) => (
              <th key={key} className="text-center pb-2 font-medium">
                <button
                  type="button"
                  onClick={() => sortBy(key)}
                  className="hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
                  title={hint}
                >
                  {label}{arrow(key)}
                </button>
              </th>
            ))}
            <th className="pb-2 w-28"></th>
          </tr>
        </thead>
        <tbody className="block sm:table-row-group">
          {rows.map(candidate => {
            const first = earlier(candidate);
            const sameWording = candidate.a.description === candidate.b.description;
            const pairKey = duplicateDismissalKey(candidate.a, candidate.b);
            const landedHere = pairFocus.isFocused(pairKey);
            return (
              <tr
                key={pairKey}
                data-pair-key={pairKey}
                ref={landedHere ? pairFocus.focusRef : undefined}
                aria-current={landedHere ? 'true' : undefined}
                onClick={() => review(candidate)}
                className={`grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 py-2 sm:py-0 sm:table-row border-b border-gray-50 dark:border-gray-700/50 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors align-top ${
                  landedHere ? ARRIVAL_ROW_CLASS : ''
                }`}
                title="Look at both copies of this"
              >
                {/* The tick, before everything — its cell stops the row's own
                    click so ticking never opens the review. */}
                <td
                  className="block sm:table-cell col-start-1 row-start-1 sm:py-2 sm:pr-1 sm:align-top"
                  onClick={e => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={selectedKeys.has(pairKey)}
                    onChange={() => toggleSelected(pairKey)}
                    disabled={bulkSaving !== null}
                    aria-label={`Select the ${candidate.a.description} pair`}
                    className="mt-0.5"
                  />
                </td>
                <td className="block sm:table-cell col-start-2 row-start-2 sm:py-2 text-xs sm:text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                  {shortDate(first.date)}
                  {candidate.daysApart > 0 && (
                    <span className="ml-1 text-xs text-gray-400">
                      +{Math.round(candidate.daysApart)}d
                    </span>
                  )}
                </td>
                <td className="block sm:table-cell col-start-2 row-start-1 min-w-0 sm:py-2 text-sm text-gray-700 dark:text-gray-300">
                  <span className="block truncate sm:max-w-[140px]">
                    {accountName(candidate.a.accountId)}
                  </span>
                </td>
                <td className="block sm:table-cell col-span-2 col-start-2 row-start-3 min-w-0 mt-1 sm:mt-0 sm:py-2 text-sm text-gray-600 dark:text-gray-400">
                  <span className="block truncate sm:max-w-[260px] text-gray-900 dark:text-white">
                    {candidate.a.description}
                  </span>
                  {!sameWording && (
                    <span className="block truncate sm:max-w-[260px] text-xs">
                      and “{candidate.b.description}”
                    </span>
                  )}
                  <span className="block text-xs mt-0.5">{likeness(candidate)}</span>
                </td>
                {/* The pair's direction, said the house way — the list said
                    nothing at all, so an income twice and an expense twice
                    read identically until the review opened. Both rows of a
                    candidate share a sign by construction: the scan matches
                    on the SIGNED amount. */}
                <td className={`block sm:table-cell col-start-3 row-start-1 sm:py-2 text-sm font-medium text-right tabular-nums whitespace-nowrap ${candidate.a.amount < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                  {candidate.a.amount < 0 ? '\u2212' : '+'}{formatCurrency(Math.abs(candidate.a.amount))}
                </td>
                {/* The row itself opens the review — one meaning per click.
                    The second way out lives in this cell, which already stops
                    the row's own handler, so it cannot make a row click
                    ambiguous. It lands on the EARLIER copy: both are in one
                    account within the window, so the other is a few rows away
                    on the same screen, in date order with the running balance. */}
                <td className="block sm:table-cell col-span-3 col-start-1 row-start-4 mt-2 sm:mt-0 sm:py-2 text-right" onClick={e => e.stopPropagation()}>
                  {/* One row of actions on a phone (both 44pt), the stacked
                      pair on a desktop — order flips so Review keeps its
                      desktop place while sitting rightmost under a thumb. */}
                  <div className="flex flex-row items-center justify-end gap-4 sm:flex-col sm:items-end sm:gap-1">
                    <button
                      type="button"
                      onClick={() => openInRegister(first, candidate, false)}
                      aria-label={`See these two rows in ${accountName(candidate.a.accountId)}`}
                      className="inline-flex items-center gap-1 px-1 min-h-[44px] sm:min-h-0 text-xs font-medium text-primary hover:text-secondary sm:order-2"
                    >
                      <ArrowUpRightIcon size={12} />
                      In the register
                    </button>
                    <button
                      type="button"
                      onClick={() => review(candidate)}
                      className="px-3 py-1.5 min-h-[44px] sm:min-h-0 text-xs font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors sm:order-1"
                    >
                      Review
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
          {total > CAP && (
            <tr className="block sm:table-row">
              <td colSpan={6} className="block sm:table-cell py-3 text-center text-xs text-gray-400 dark:text-gray-500">
                Showing the first {formatCount(CAP)} of {formatCount(total)} —
                settle these, then run this again for the rest.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  const bothBlocked = reviewing !== null
    && deleteBlockOf(reviewing.a) !== null
    && deleteBlockOf(reviewing.b) !== null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Find duplicates" size="xl">
      <ModalBody>
        {suggestionDismissalsStatus === 'error' && (
          <p className="mb-3 text-sm rounded-lg px-3 py-2 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300">
            The list of suggestions you asked to leave out could not be read, so this list may
            include some of them. Nothing has changed — close this and try again in a moment.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 mb-3">
          <p className="text-sm text-gray-600 dark:text-gray-400 flex-1 min-w-[16rem]">
            Every account is swept at once. Rows in the <strong>same account</strong> for the same
            amount, to the penny, a few days apart — what a bank feed and an import of the same
            payment look like. Two matching rows in <em>different</em> accounts are not here: that
            is a transfer, and “Match transfers” is where it belongs.
          </p>
          <label className="text-sm text-gray-600 dark:text-gray-400">
            Within{' '}
            <select
              value={windowDays}
              onChange={e => setWindowDays(Number(e.target.value) as WindowDays)}
              className="ml-1 px-2 py-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            >
              {WINDOW_CHOICES.map(days => (
                <option key={days} value={days}>{windowLabel(days)}</option>
              ))}
            </select>
          </label>
        </div>

        {/* THE TALLY — how much is left, said where the work starts (owner,
            1 Sep 2026: "a tally of how many you have left"). It counts what
            the list below actually shows: the scoped account when one is
            chosen, with the all-accounts figure beside it so narrowing never
            hides the size of the job. At zero it says nothing — the empty
            state below already says it in words, and a zero count renders
            nothing (house rule). */}
        {dismissalsChecked && inScope.length > 0 && (
          <p className="mb-3 text-sm text-right text-gray-600 dark:text-gray-400 tabular-nums">
            <span className="font-medium text-gray-900 dark:text-white">
              {formatCount(inScope.length)}
            </span>{' '}
            suggestion{inScope.length === 1 ? '' : 's'} left
            {scopedAccount !== '' && live.length !== inScope.length && (
              <span> in this account · {formatCount(live.length)} across all accounts</span>
            )}
          </p>
        )}

        {/* Only worth a control when there is more than one account to choose
            between — otherwise it is a menu with one thing on it. */}
        {accountsWithWork.length > 1 && (
          <label className="block mb-3 text-sm text-gray-600 dark:text-gray-400">
            Account{' '}
            <select
              value={scopedAccount}
              onChange={e => setAccountFilter(e.target.value)}
              className="ml-1 px-2 py-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white max-w-full"
            >
              <option value="">All accounts</option>
              {/* Banded and alphabetised exactly as every other account
                  dropdown in the app: with sixty accounts a flat list is a
                  wall of names. The count each one still carries is the point
                  of the control — which accounts still have work in them. */}
              <GroupedAccountOptions
                accounts={accountsWithWork}
                formatLabel={account => `${account.name} (${formatCount(account.count)})`}
              />
            </select>
          </label>
        )}

        {!dismissalsChecked ? (
          <p className="text-center py-10 text-gray-500 dark:text-gray-400">
            Checking which of these you have already dealt with…
          </p>
        ) : live.length === 0 ? (
          <p className="text-center py-10 text-gray-500 dark:text-gray-400">
            Nothing looks like the same payment twice. Every row in every account is either
            unique, far enough apart to be a real repeat
            {duplicateDismissals.length > 0 ? ', or left out at your request below' : ''}.
          </p>
        ) : (
          <>
            {/* The thead's sort buttons hide with the columns below `sm`;
                this is their phone replacement — one control, because the
                sort state is shared by both sections. The arrow button
                re-sorts by the same key, which is exactly what clicking a
                heading twice does on a desktop. */}
            <div className="sm:hidden flex items-center gap-1 mb-2 text-sm text-gray-600 dark:text-gray-400">
              <label>
                Sort by{' '}
                <select
                  value={sortKey}
                  onChange={e => {
                    const chosen = e.target.value;
                    if (chosen === 'date' || chosen === 'account' || chosen === 'description' || chosen === 'amount') {
                      sortBy(chosen);
                    }
                  }}
                  className="ml-1 px-2 py-1 min-h-[44px] rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                >
                  <option value="date">Date</option>
                  <option value="account">Account</option>
                  <option value="description">Description</option>
                  <option value="amount">Amount</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() => sortBy(sortKey)}
                aria-label="Reverse the sort"
                title="Reverse the sort"
                className="min-h-[44px] min-w-[44px] rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                {sortDir === 1 ? '↑' : '↓'}
              </button>
            </div>
            {/* THE BULK REFUSAL BAR (owner, 1 Sep 2026: "save me going
                through over 2000!"). Select-all covers the whole scope, not
                the displayed cap — that is the point of it. The action only
                appears once something is selected, and the press asks first:
                see the confirmation dialog at the foot of this file. */}
            <div
              ref={bulkBarRef}
              className="sticky top-0 z-10 -mx-1 px-1 py-2 bg-white dark:bg-gray-900 flex flex-wrap items-center gap-3 mb-3"
            >
              <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 min-h-[44px] sm:min-h-0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allInScopeSelected}
                  onChange={toggleSelectAll}
                  disabled={bulkSaving !== null}
                  aria-label={allInScopeSelected ? 'Unselect all suggestions' : `Select all ${formatCount(inScope.length)} suggestions`}
                />
                {allInScopeSelected ? 'Unselect all' : `Select all ${formatCount(inScope.length)}`}
              </label>
              <button
                type="button"
                onClick={selectAllInView}
                disabled={bulkSaving !== null || allInScopeSelected}
                title="Tick every pair on screen now. Scroll and press again to add the next ones."
                className="px-3 py-2 min-h-[44px] sm:min-h-0 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                Select all in view
              </button>
              {selectedInScope > 0 && (
                <>
                  <span className="text-sm text-gray-600 dark:text-gray-400 tabular-nums">
                    {formatCount(selectedInScope)} selected
                  </span>
                  <button
                    type="button"
                    disabled={bulkSaving !== null}
                    onClick={() => {
                      setBulkPending(bulkRefusalPairs());
                      setBulkConfirm(true);
                    }}
                    className="px-3 py-2 min-h-[44px] sm:min-h-0 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                  >
                    These are not duplicates
                  </button>
                </>
              )}
              {bulkSaving !== null && (
                <span className="text-sm text-gray-500 dark:text-gray-400 tabular-nums">
                  Remembering {formatCount(bulkSaving.done)} of {formatCount(bulkSaving.total)}…
                </span>
              )}
            </div>
            {wordingAgrees.length > 0 && (
              // Named regions, because the two tables carry the same column
              // headings: without this a screen reader meets "Sort by date"
              // twice with nothing to say which list it sorts.
              <section className="mb-6" aria-labelledby="duplicates-wording-agrees">
                <h3
                  id="duplicates-wording-agrees"
                  className="text-sm font-semibold text-gray-900 dark:text-white"
                >
                  Same money, same wording
                </h3>
                <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                  Same account, the same amount to the penny, and the two rows read as the same
                  payee. Until one copy goes, that payment is counted twice in the balance.
                </p>
                {renderTable(wordingAgrees.slice(0, CAP), wordingAgrees.length)}
              </section>
            )}

            {needsYourEye.length > 0 && (
              <section aria-labelledby="duplicates-needs-your-eye">
                <h3
                  id="duplicates-needs-your-eye"
                  className="text-sm font-semibold text-gray-900 dark:text-white"
                >
                  Same money, different wording — your call
                </h3>
                <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                  Same account and the same amount to the penny, but the two rows are worded
                  differently. That is what a payee you renamed looks like — and it is also what
                  two separate payments of the same size look like. Nothing here can tell them
                  apart, so each pair has to be confirmed by you before either copy can be
                  deleted.
                </p>
                {renderTable(needsYourEye.slice(0, CAP), needsYourEye.length)}
              </section>
            )}
          </>
        )}

        <DismissedSuggestionsSection
          dismissals={duplicateDismissals}
          transactionsById={transactionsById}
          accountName={accountName}
          formatCurrency={formatCurrency}
          onRestore={dismissal => void handleRestore(dismissal)}
          restoringKey={restoringKey}
          className="mt-6 pt-5 border-t border-gray-200 dark:border-gray-700"
        />
      </ModalBody>
      <ModalFooter>
        <div className="flex items-center gap-3">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {!dismissalsChecked
              ? 'Checking…'
              : live.length === 0
                ? 'Nothing to sort out here.'
                : 'Each one is decided on its own — nothing is deleted until you choose a copy.'}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            Close
          </button>
        </div>
      </ModalFooter>

      {/* One candidate, both copies in full, and the consequence of deleting
          the chosen one spelled out before it happens. */}
      {reviewing && (
        <Modal
          isOpen
          onClose={() => (deleting ? undefined : setReviewing(null))}
          closeOnBackdrop={!deleting}
          title="The same payment twice?"
          size="lg"
        >
          <ModalBody>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              These two rows are in <strong>{accountName(reviewing.a.accountId)}</strong> for the
              same amount, {gapPhrase(reviewing.daysApart)}
              {needsConfirmation(reviewing) ? (
                <>
                  , but they are worded differently. That is what a payee you renamed looks like —
                  and also what two separate payments of the same size look like.{' '}
                  <strong>Nothing here can tell which</strong>, so say so yourself before choosing
                  a copy to delete.
                </>
              ) : (
                <>
                  , and read as the same payee. That is what an import landing on top of a bank
                  feed looks like — but it is also what a genuine repeat payment looks like, so{' '}
                  <strong>nothing here can tell which</strong>. Choose the copy to delete, or leave
                  them both alone.
                </>
              )}
            </p>

            <fieldset>
              <legend className="sr-only">Choose the copy to delete</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {renderCopy(reviewing, reviewing.a, 'First copy')}
                {renderCopy(reviewing, reviewing.b, 'Second copy')}
              </div>
            </fieldset>

            {/* The extra step the weaker tier costs. It is the user's own
                statement about this one pair, which is exactly what no bulk
                action could ever provide on their behalf. */}
            {needsConfirmation(reviewing) && !bothBlocked && (
              <label className="mt-4 flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={confirmedSame}
                  disabled={deleting}
                  onChange={e => setConfirmedSame(e.target.checked)}
                  className="mt-0.5 rounded border-gray-300"
                />
                <span>I have read both rows and they are one payment recorded twice.</span>
              </label>
            )}

            {bothBlocked ? (
              <div className="mt-4 flex items-start gap-2 rounded-lg px-3 py-2 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300">
                <AlertTriangleIcon size={16} className="mt-0.5 flex-shrink-0" />
                <p className="text-sm">
                  Neither of these can be deleted from here — each one is holding something else
                  together, as explained above. Unpick that first, then run this again.
                </p>
              </div>
            ) : refusal === 'not-confirmed' ? (
              <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
                Tick the box above to say these two really are one payment. Nothing is deleted
                until you do.
              </p>
            ) : chosen ? (
              <div className="mt-4 flex items-start gap-2 rounded-lg px-3 py-2 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300">
                <AlertTriangleIcon size={16} className="mt-0.5 flex-shrink-0" />
                <p className="text-sm">{deleteConsequence(chosen)}</p>
              </div>
            ) : (
              <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
                Pick one and this will say exactly what deleting it does before anything happens.
              </p>
            )}
          </ModalBody>
          <ModalFooter>
            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                disabled={deleting}
                onClick={() => {
                  // "Leave both" is a judgment about a repeated payment, not
                  // about one pairing of it — so the WHOLE cluster of live
                  // pairs chained to this one by shared rows goes with it
                  // (owner, 29 Aug). Pairs sharing no row are untouched: a
                  // different repeated payment is a different question. The
                  // judgment persists immediately — see persistRefusal.
                  const cluster = candidatesSharingRows(live, reviewing);
                  setDismissed(prev => {
                    const next = new Set(prev);
                    for (const pair of cluster) {
                      next.add(duplicateDismissalKey(pair.a, pair.b));
                    }
                    return next;
                  });
                  setReviewing(null);
                  setChosenId(null);
                  setConfirmedSame(false);
                  void persistRefusal(cluster);
                }}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                Not a duplicate — leave both
              </button>
              <button
                type="button"
                disabled={deleting || chosen === null || refusal !== null}
                onClick={() => void handleDelete()}
                className="justify-center px-4 py-2 text-sm font-medium rounded-lg bg-red-700 text-white hover:bg-red-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? 'Deleting…' : 'Delete the copy I chose'}
              </button>
            </div>
          </ModalFooter>
        </Modal>
      )}

      {/* THE NUCLEAR BUTTON'S WARNING (owner, 1 Sep 2026). The press is a
          judgment about every ticked row at once, so the dialog says the
          whole of it before anything happens: genuine duplicates among the
          selection are refused too, they leave this list, and they are not
          offered again — with the one honest comfort that every refusal is
          its own restorable row in Dismissed suggestions. When clusters
          widen the count beyond the ticks, the widening is named, not
          slipped in. */}
      {bulkConfirm && (
        <Modal
          isOpen
          onClose={() => {
            setBulkConfirm(false);
            setBulkPending([]);
          }}
          title={`Treat ${formatCount(bulkPending.length)} as not duplicates?`}
          size="md"
        >
          <ModalBody>
            <p className="text-sm text-gray-700 dark:text-gray-200">
              Everything selected will be treated as <strong>not a duplicate</strong> — including
              any that genuinely are. They come off this list now and will not be offered again
              the next time this runs.
            </p>
            {bulkPending.length > selectedInScope && (
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                Your {formatCount(selectedInScope)} ticked row
                {selectedInScope === 1 ? '' : 's'} share rows with other suggestions of the same
                repeated payments, so {formatCount(bulkPending.length)} suggestions are
                refused together — one judgment per payment, the same rule as the review dialog.
              </p>
            )}
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
              Nothing is deleted and no balance moves. Every refusal stays individually
              restorable from “Dismissed suggestions” at the foot of the list.
            </p>
          </ModalBody>
          <ModalFooter>
            <div className="flex items-center justify-end gap-2 w-full">
              <button
                type="button"
                onClick={() => {
                  setBulkConfirm(false);
                  setBulkPending([]);
                }}
                className="px-4 py-2 min-h-[44px] text-sm font-medium border border-line dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmBulkRefusal()}
                className="px-4 py-2 min-h-[44px] text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100 transition-colors"
              >
                These are not duplicates
              </button>
            </div>
          </ModalFooter>
        </Modal>
      )}

    </Modal>
  );
}
