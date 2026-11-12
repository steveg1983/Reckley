import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { useApp } from '../contexts/AppContextSupabase';
import { useToast } from '../contexts/ToastContext';
import { ArrowLeftIcon, CheckCircleIcon, CheckIcon } from '../components/icons';
import { useReconciliation, type ReconciliationSummary } from '../hooks/useReconciliation';
import { usePendingAtBank } from '../hooks/usePendingAtBank';
import PendingAtBankList from '../components/banking/PendingAtBankList';
import ReconciliationAccountList from '../components/reconciliation/ReconciliationAccountList';
import {
  groupReconciliationSummaries,
  readStoredReconciliationGrouping,
  writeReconciliationGrouping,
  type ReconciliationGrouping,
} from '../components/reconciliation/reconciliationGrouping';
import type { AccountGroupingOptions } from '../utils/accountGrouping';
import ReconciliationBalanceBar, { CONFIRM_BALANCE_CONSEQUENCE } from '../components/reconciliation/ReconciliationBalanceBar';
import { NEXT_ACTION_YELLOW } from '../design-system/nextActionYellow';
import { CONFIRM_BALANCE_HINT_ID } from '../components/reconciliation/nextActionYellow';
import ReconciliationTransactionList from '../components/reconciliation/ReconciliationTransactionList';
import ReconciliationFinalizationModal from '../components/reconciliation/ReconciliationFinalizationModal';
import EditTransactionModal from '../components/EditTransactionModal';
import { preserveRuntimeControlParams } from '../utils/runtimeMode';
import { todayIsoDay } from '../utils/statementBankBalance';
import { toDecimal } from '../utils/decimal';
import type { Transaction } from '../types';
import { preferences } from '../services/preferencesService';
import { readProvenance, returnState } from '../utils/navigationProvenance';
import { STICKY_UNDER_APP_BAR } from '../components/layout/chromeOffsets';
import { formatCount, compareText } from '../utils/localeFormat';

/**
 * Does this account still want work?
 *
 * ONE definition, because two numbers on this page are derived from it and
 * they must be the same number: the count in the `Needs attention only (N)`
 * control, and — since the filter runs before the banding — the counts in the
 * band headings once it is on. They were two identical copies of this
 * expression, which agreed today and would have drifted the first time
 * somebody edited one of them (design ruling, 2026-08-13, which asked for the
 * heading and the control to show the same number).
 */
const needsAttention = (s: ReconciliationSummary): boolean =>
  s.unreconciledCount > 0 || (s.difference != null && s.difference !== 0);

export default function Reconciliation() {
  const {
    transactions, accounts, categories, addTransaction, updateAccount,
    setTransactionsCleared, finalizeReconciliation
  } = useApp();
  const { showSuccess, showError } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    searchParams.get('account') || null
  );
  const navigate = useNavigate();
  const location = useLocation();
  /*
   * THE WAY BACK, AND THE ROW TO LAND ON.
   *
   * The Accounts page sends its own crumbs (`{ accountId }`) when it opens this
   * page, exactly as it does for a register. Handing them back is what puts the
   * user on the account they left rather than at the top of a long list —
   * "each time it drops me back to the top of the page, and not to the account
   * that I clicked from ... if I have a long list of accounts and I am
   * reconciling a few accounts at the bottom, each time I have to re-scroll".
   *
   * `returnState` is undefined when there are no crumbs (a direct arrival, or a
   * link from an older build), which leaves a clean history entry and the old
   * behaviour — this page never looks inside the crumbs, so the Accounts page
   * goes on owning their shape.
   */
  const backProvenance = readProvenance(location.state);
  const backState = backProvenance ? returnState(backProvenance) : undefined;
  // Where the user CAME FROM, captured once — later in-page query rewrites
  // (selecting an account re-writes the whole search string) would drop it.
  // Arriving via an Accounts-page reconcile button means "done" and "Back"
  // both return THERE, not to this page's own account list.
  const [cameFromAccounts] = useState<boolean>(() => searchParams.get('from') === 'accounts');
  /**
   * Sent by the FOCUSED accounts list ("Reconcile N instead"): this visit is
   * one stop on a reconcile round, so leaving — finished or not — returns to
   * that list, still focused, to pick the next account (owner, 19 Aug; the
   * same round the review flow walks).
   */
  const [cameFromFocusedRound] = useState<boolean>(() => searchParams.get('back') === 'accounts-reconcile');
  // Group + sort for the account list — the same controls, the same module
  // behind them and the same persistence shape as the Accounts page, so the two
  // pages always feel the same. Two INDEPENDENT switches, never an either/or:
  // this page held its own `'type' | 'institution'` state behind two buttons
  // that looked exactly like the Accounts page's pair, and the owner found the
  // difference by trying to turn both on.
  const [grouping, setGrouping] = useState<AccountGroupingOptions>(readStoredReconciliationGrouping);
  const [sortMode, setSortMode] = useState<'default' | 'name' | 'balance-desc' | 'balance-asc'>(() => {
    const stored = preferences.getItem('reconciliationSortMode');
    return stored === 'name' || stored === 'balance-desc' || stored === 'balance-asc' ? stored : 'default';
  });
  const handleGroupingChange = useCallback((next: AccountGroupingOptions) => {
    setGrouping(next);
    writeReconciliationGrouping(next);
  }, []);
  const handleSortChange = useCallback((value: 'default' | 'name' | 'balance-desc' | 'balance-asc') => {
    setSortMode(value);
    try { preferences.setItem('reconciliationSortMode', value); } catch { /* storage unavailable */ }
  }, []);
  // Hide the accounts that are already done — everything cleared AND no bank
  // balance difference — so the list is only the work. Grouping still applies:
  // the filter drops accounts within each section, never the sections shape.
  const [onlyAttention, setOnlyAttention] = useState<boolean>(() =>
    preferences.getItem('reconciliationOnlyAttention') === 'true'
  );
  // One writer for the switch, because there are now two ways to move it: the
  // control itself, and the "Show all accounts" remedy the filtered-empty state
  // offers. A remedy that set the state without persisting it would put the
  // list back and then take it away again on the next visit.
  const setOnlyAttentionPersisted = useCallback((next: boolean) => {
    setOnlyAttention(next);
    try { preferences.setItem('reconciliationOnlyAttention', String(next)); } catch { /* storage unavailable */ }
  }, []);
  const handleOnlyAttentionToggle = useCallback(() => {
    setOnlyAttentionPersisted(!onlyAttention);
  }, [onlyAttention, setOnlyAttentionPersisted]);
  const handleShowAllAccounts = useCallback(() => {
    setOnlyAttentionPersisted(false);
  }, [setOnlyAttentionPersisted]);
  const [showFinalizationModal, setShowFinalizationModal] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  // Visible transaction order (sorted + filtered) as shown in the list, reported
  // by ReconciliationTransactionList. Drives "Save & Next" so it walks the same
  // order the user sees rather than the raw account order.
  const [visibleOrderIds, setVisibleOrderIds] = useState<string[]>([]);
  // Optimistic cleared-state overlay: the checkbox flips instantly while the
  // write is in flight, and reverts (with an error toast) if it fails.
  const [pendingCleared, setPendingCleared] = useState<Map<string, boolean>>(new Map());
  /**
   * The closing balance the user has AGREED to, for this account, in this
   * session.
   *
   * Deliberately in memory and deliberately per account. The owner asked to be
   * made to confirm a figure "each time", so next week's reconciliation must
   * ask again — persisting it would turn a decision into a default. The
   * account id rides along so switching accounts cannot carry an agreement
   * about one statement onto another.
   *
   * The amount is kept as well as the id because the figure can change under
   * the user (a feed sync, a statement import): an agreement is about a
   * NUMBER, so when the number moves the agreement lapses.
   */
  const [confirmedBalance, setConfirmedBalance] =
    useState<{ accountId: string; amount: number } | null>(null);

  const overlaidTransactions = useMemo(() => {
    if (pendingCleared.size === 0) return transactions;
    return transactions.map(t => {
      const pending = pendingCleared.get(t.id);
      return pending === undefined ? t : { ...t, cleared: pending };
    });
  }, [transactions, pendingCleared]);

  const {
    reconciliationDetails,
    totalUnreconciledCount,
    computeAccountBalance,
    computeClearedBalance,
    computeClearedSummary,
  } = useReconciliation(accounts, overlaidTransactions);

  // An account needs attention when transactions are still unreconciled, or a
  // stated bank balance disagrees with the cleared balance. difference is
  // Decimal-computed, so a balanced account is exactly 0.
  const attentionCount = useMemo(
    () => reconciliationDetails.filter(needsAttention).length,
    [reconciliationDetails]
  );

  // Build the banded, sorted account list. The banding is the Accounts page's,
  // decided by the one shared module, so a 'mortgage' account reconciles under
  // Loans here exactly as it files under Loans there — and both switches nest
  // here exactly as they nest there.
  //
  // The `Needs attention only` filter runs FIRST and on the rows alone: it
  // drops accounts, never sections, and a band left with nothing in it drops
  // out on its own because the grouper omits empty bands.
  const accountGrouping = useMemo<ReconciliationGrouping>(() => {
    const visibleDetails = onlyAttention
      ? reconciliationDetails.filter(needsAttention)
      : reconciliationDetails;

    const sortSummaries = (list: typeof reconciliationDetails) => {
      const sorted = [...list];
      if (sortMode === 'name') sorted.sort((a, b) => compareText(a.account.name, b.account.name));
      else if (sortMode === 'balance-desc') sorted.sort((a, b) => b.accountBalance - a.accountBalance);
      else if (sortMode === 'balance-asc') sorted.sort((a, b) => a.accountBalance - b.accountBalance);
      return sorted;
    };

    return groupReconciliationSummaries(visibleDetails, grouping, sortSummaries);
  }, [reconciliationDetails, grouping, sortMode, onlyAttention]);

  // Selected account data
  const selectedAccount = useMemo(
    () => accounts.find(a => a.id === selectedAccountId) ?? null,
    [accounts, selectedAccountId]
  );

  const accountTransactions = useMemo(
    () =>
      selectedAccountId
        ? overlaidTransactions.filter(t => t.accountId === selectedAccountId)
        : [],
    [overlaidTransactions, selectedAccountId]
  );

  const accountBalance = selectedAccountId ? computeAccountBalance(selectedAccountId) : 0;
  const clearedBalance = selectedAccountId ? computeClearedBalance(selectedAccountId) : 0;
  const clearedSummary = selectedAccountId ? computeClearedSummary(selectedAccountId) : undefined;
  /**
   * The closing balance the balance bar PROPOSES, and the order it is looked
   * for in. Note that none of these sources is itself a closing balance: they
   * are the best guesses at one, which is why the user has to agree before any
   * of them can settle a reconciliation.
   *
   *  1. what the bank most recently said (a feed sync or an imported statement
   *     writes `bankBalance`) — the closest thing to the statement in hand;
   *  2. failing that, the balance the last reconciliation was settled against,
   *     which is Money's "starting balance" for this one;
   *  3. failing both, nothing. An empty box, not a zero: a zero here would be a
   *     figure the app invented and the user could confirm by accident.
   *
   * Whichever it is, it is a SUGGESTION until confirmed.
   */
  const bankBalance = selectedAccount?.bankBalance ?? selectedAccount?.lastReconciledBalance ?? null;
  const balanceConfirmed =
    confirmedBalance != null && confirmedBalance.accountId === selectedAccountId;
  /**
   * What the bank says is pending on this account. The proposed closing
   * balance is the bank's own figure, and a card issuer's figure can already
   * include items it has not posted — which leaves a difference no marked
   * transaction can close. The list under the transactions names them and
   * says how much of the difference they would account for.
   */
  const pendingAtBank = usePendingAtBank(selectedAccountId);
  const differenceToExplain = bankBalance != null
    ? toDecimal(bankBalance).minus(toDecimal(clearedBalance)).toNumber()
    : null;

  /**
   * The figure moved under the agreement — so the agreement lapses.
   *
   * Watches for a CHANGE rather than comparing on every render, and the
   * difference is load-bearing: confirming a figure the user has just typed
   * happens BEFORE the account update carrying it comes back, so a
   * compare-every-render rule would cancel every confirmation the instant it
   * was made. A change TO the confirmed figure (that same update landing) is
   * not a change to disagree with; a change to anything else — a feed sync, a
   * statement import — is, because what was agreed to is no longer on screen.
   */
  const lastSeenBankBalance = useRef<number | null>(bankBalance);
  const lastSeenAccountId = useRef<string | null>(selectedAccountId);
  useEffect(() => {
    if (lastSeenAccountId.current !== selectedAccountId) {
      // A different account's figure is not a change to this one's.
      lastSeenAccountId.current = selectedAccountId;
      lastSeenBankBalance.current = bankBalance;
      return;
    }
    if (lastSeenBankBalance.current === bankBalance) return;
    lastSeenBankBalance.current = bankBalance;
    setConfirmedBalance(prev => {
      if (prev === null) return prev;
      if (bankBalance !== null && toDecimal(prev.amount).equals(toDecimal(bankBalance))) return prev;
      return null;
    });
  }, [bankBalance, selectedAccountId]);

  // Handlers
  const handleSelectAccount = useCallback((accountId: string) => {
    setSelectedAccountId(accountId);
    // Preserve demo/testMode so an in-page navigation doesn't drop the flag that
    // keeps a demo/test session alive (which would bounce us to the landing page).
    setSearchParams(prev => preserveRuntimeControlParams(prev, { account: accountId }));
    // Same route, so the router restores nothing: without this, a scrolled
    // account list hands its scroll position to the detail view and the page
    // opens with the header off-screen.
    window.scrollTo(0, 0);
  }, [setSearchParams]);

  const handleBack = useCallback(() => {
    if (cameFromFocusedRound) {
      // Mid-round: back to the FOCUSED list to pick the next account. The
      // accounts page consumes ?focus and drops it by itself once nothing is
      // left to reconcile anywhere, so a finished round ends on the ordinary
      // page without this side knowing the round's state.
      const params = new URLSearchParams(preserveRuntimeControlParams(searchParams));
      params.set('focus', 'reconcile');
      navigate({ pathname: '/accounts', search: params.toString() }, { state: backState });
      return;
    }
    if (cameFromAccounts) {
      // Return whence the user came: the Accounts page sent them here for ONE
      // account, so leaving that account means leaving this page too.
      const params = new URLSearchParams(preserveRuntimeControlParams(searchParams));
      navigate({ pathname: '/accounts', search: params.toString() }, { state: backState });
      return;
    }
    setSelectedAccountId(null);
    setSearchParams(prev => preserveRuntimeControlParams(prev));
    window.scrollTo(0, 0);
  }, [cameFromFocusedRound, cameFromAccounts, searchParams, navigate, setSearchParams, backState]);

  /**
   * The remedy on the genuinely-empty state: there is nowhere on THIS page to
   * make an account, so the empty state hands over to the page where there is
   * one rather than describing the trip.
   */
  const handleGoToAccounts = useCallback(() => {
    const params = new URLSearchParams(preserveRuntimeControlParams(searchParams));
    navigate({ pathname: '/accounts', search: params.toString() });
  }, [searchParams, navigate]);

  const applyCleared = useCallback(async (requestedIds: string[], cleared: boolean) => {
    // Drop ids that already have a write in flight — the checkbox is disabled
    // while pending, and skipping here closes the race for bulk overlaps too
    // (two in-flight writes for one id could otherwise resolve out of order).
    const ids = requestedIds.filter(id => !pendingCleared.has(id));
    if (ids.length === 0) {
      return;
    }

    // Optimistic: flip immediately, revert on failure.
    setPendingCleared(prev => {
      const next = new Map(prev);
      ids.forEach(id => next.set(id, cleared));
      return next;
    });

    try {
      await setTransactionsCleared(ids, cleared);
    } catch (error) {
      showError(error);
    } finally {
      setPendingCleared(prev => {
        const next = new Map(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });
    }
  }, [pendingCleared, setTransactionsCleared, showError]);

  const handleToggleCleared = useCallback((transactionId: string, cleared: boolean) => {
    void applyCleared([transactionId], cleared);
  }, [applyCleared]);

  const handleBulkSetCleared = useCallback((transactionIds: string[], cleared: boolean) => {
    void applyCleared(transactionIds, cleared);
  }, [applyCleared]);

  const handleBankBalanceChange = useCallback((newBalance: number | null) => {
    if (!selectedAccountId) {
      return;
    }
    if (newBalance === null) {
      // The date goes with the figure it dated. A bank_balance_date describing
      // no balance is a claim about nothing — and worse than nothing, because
      // statementBankBalance judges an incoming statement stale against it, so
      // a leftover date would go on refusing statements after the balance it
      // belonged to was withdrawn.
      updateAccount(selectedAccountId, {
        bankBalance: null,
        bankBalanceDate: null
      });
      return;
    }
    // Dated as well as set. A figure typed here is what the bank says TODAY,
    // and recording that keeps bank_balance_date describing the balance it
    // sits beside — otherwise a hand-typed correction would inherit the date
    // of whatever statement was imported last, and a later import of that
    // statement's successor could be judged stale against it.
    updateAccount(selectedAccountId, {
      bankBalance: newBalance,
      bankBalanceDate: todayIsoDay()
    });
  }, [selectedAccountId, updateAccount]);

  /** Agree to the figure on screen. Nothing is written: this is a decision. */
  const handleConfirmBalance = useCallback((amount: number) => {
    if (!selectedAccountId) {
      return;
    }
    setConfirmedBalance({ accountId: selectedAccountId, amount });
  }, [selectedAccountId]);

  /** The user started changing the figure — whatever was agreed no longer is. */
  const handleBalanceEdited = useCallback(() => {
    setConfirmedBalance(null);
  }, []);

  /**
   * The one committing step. Everything before this was a working list.
   *
   * Gated on a confirmed balance twice over: the button that opens the modal is
   * disabled without one, and this refuses without one — because it is the
   * ending balance being written down, and a reconciliation settled against a
   * figure nobody read is the thing this whole change exists to prevent.
   */
  /**
   * True while the finalize write is in flight — held in state so the modal's
   * button can say "Completing…" and refuse seconds. A first-ever finalize
   * converts an account's whole marked history (the owner's ran to 7,199
   * rows) and takes real seconds server-side; without this, every extra
   * press fired ANOTHER finalize RPC, each queueing behind the first one's
   * account lock, and the screen read as frozen the whole time.
   */
  const [finalizing, setFinalizing] = useState(false);

  const handleFinalize = useCallback(async () => {
    if (!selectedAccountId || !balanceConfirmed || confirmedBalance == null || finalizing) {
      return;
    }
    setFinalizing(true);
    try {
      // Await the write — success feedback must not fire on a failed save.
      const reconciled = await finalizeReconciliation(
        selectedAccountId,
        confirmedBalance.amount,
        new Date()
      );
      setShowFinalizationModal(false);
      setConfirmedBalance(null);
      showSuccess(
        reconciled > 0
          ? `${formatCount(reconciled)} transaction${reconciled === 1 ? '' : 's'} reconciled.`
          : 'Nothing was left to reconcile; the statement balance is recorded.',
        'Account reconciled'
      );
      handleBack();
    } catch (error) {
      showError(error);
    } finally {
      setFinalizing(false);
    }
  }, [
    selectedAccountId, balanceConfirmed, confirmedBalance, finalizing, finalizeReconciliation,
    handleBack, showSuccess, showError
  ]);

  const handleCreateAdjustment = useCallback(async (data: {
    amount: number;
    type: 'income' | 'expense';
    description: string;
    category: string;
    date: Date;
  }) => {
    if (!selectedAccountId) return;

    const adjustmentTxn: Omit<Transaction, 'id'> = {
      date: data.date,
      description: data.description,
      amount: data.amount,
      type: data.type,
      category: data.category,
      accountId: selectedAccountId,
      // Marked, not reconciled: it has to count in the cleared balance for the
      // difference to close, and it becomes reconciled the same way every other
      // row does — when the user finalizes.
      cleared: true,
      reconciled: false,
    };

    try {
      // The modal stays open: the cleared adjustment shrinks the difference and
      // the modal re-renders with the remainder (zero → balanced state), so the
      // user can create several adjustments — the Microsoft Money model.
      await addTransaction(adjustmentTxn);
      showSuccess('Adjustment transaction created.', 'Adjustment added');
    } catch (error) {
      showError(error);
    }
  }, [selectedAccountId, addTransaction, showSuccess, showError]);

  const handleRowClick = useCallback((transaction: Transaction) => {
    setEditingTransaction(transaction);
    setIsEditModalOpen(true);
  }, []);

  const handleAddTransaction = useCallback(() => {
    setEditingTransaction(null);
    setIsEditModalOpen(true);
  }, []);

  const handleCloseEditModal = useCallback(() => {
    setIsEditModalOpen(false);
    setEditingTransaction(null);
  }, []);

  const handleVisibleOrderChange = useCallback((orderedIds: string[]) => {
    setVisibleOrderIds(orderedIds);
  }, []);

  // "Save & Next" navigation: find the transaction shown immediately after the
  // current one, and swap it into the still-open modal. Mirrors AccountTransactions.
  const getNextTransactionId = useCallback((currentId: string): string | null => {
    const index = visibleOrderIds.indexOf(currentId);
    if (index === -1) return null;
    return visibleOrderIds[index + 1] ?? null;
  }, [visibleOrderIds]);

  const advanceToNextTransaction = useCallback((currentId: string): boolean => {
    const nextId = getNextTransactionId(currentId);
    if (!nextId) return false;
    const nextTransaction = accountTransactions.find(t => t.id === nextId) ?? null;
    if (!nextTransaction) return false;
    setEditingTransaction(nextTransaction);
    return true;
  }, [getNextTransactionId, accountTransactions]);

  const getPreviousTransactionId = useCallback((currentId: string): string | null => {
    const index = visibleOrderIds.indexOf(currentId);
    if (index <= 0) return null;
    return visibleOrderIds[index - 1] ?? null;
  }, [visibleOrderIds]);

  const advanceToPreviousTransaction = useCallback((currentId: string): boolean => {
    const previousId = getPreviousTransactionId(currentId);
    if (!previousId) return false;
    const previousTransaction = accountTransactions.find(t => t.id === previousId) ?? null;
    if (!previousTransaction) return false;
    setEditingTransaction(previousTransaction);
    return true;
  }, [getPreviousTransactionId, accountTransactions]);

  // Step 1: Account Selection
  if (!selectedAccountId) {
    return (
      <div className="flex flex-col h-full">
        {/* Heading → figure → content, the page anatomy the design pass settled
            on (P7). What this page is FOR is the count of work outstanding, and
            it was set in 14px grey under the title — smaller than the account
            names below it, and the only number on the screen that describes the
            whole screen. It reads at `display` now, with the words that explain
            it demoted to a subhead: the figure first, then what it counts. */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Reconciliation
          </h1>
          {/* WHY THIS SCREEN EXISTS (Design, 17 Aug §6): the one page no
              competitor has an equivalent of, finally saying so. This is the
              ethos as a sentence — agreement, not estimation. */}
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Agree each account against the statement you hold. This is what makes
            every other number in the app defensible.
          </p>
          {totalUnreconciledCount > 0 ? (
            <>
              <p className="mt-1 text-display font-semibold text-primary dark:text-white tabular-nums">
                {formatCount(totalUnreconciledCount)}
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                unreconciled {totalUnreconciledCount === 1 ? 'transaction' : 'transactions'} across all accounts
              </p>
            </>
          ) : (
            // No headline figure when the figure is zero. A 32px "0" would be
            // the loudest thing on a page with nothing to do on it — the app's
            // rule is that a count of nothing renders as nothing, and what is
            // worth saying here is the reassurance, not the number.
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              All accounts are up to date
            </p>
          )}
        </div>

        {/* Group + sort controls — the Accounts page's, down to the class
            names, because they ARE the same controls: same words, same
            behaviour, same shared module underneath.

            gap-x-8 rather than 6 for the reason the Accounts page carries the
            same number: with the Group by pills borderless, 24px would leave
            the Institution pill closer to the words "Sort:" than that label is
            to its own buttons, and it would read as Institution's caption. */}
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2 mb-4">
          <div className="w-full sm:w-auto flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-600 dark:text-gray-300 w-20 sm:w-auto shrink-0">Group by:</span>
            {/* TWO SWITCHES, NOT A CHOICE. Each is a toggle in its own right —
                aria-pressed, not a radio — so "Account Type on, Institution
                on" is a state the page can be in: institution sub-bands nested
                inside the type sections. Off and off is one flat list. The
                owner's report was precisely that this page refused the
                combination its twin allows.

                AND NOW THEY LOOK LIKE IT. Both-on is a real state, but wearing
                the same navy fill as Sort's segmented single-choice beside it,
                two filled pills read as a broken radio group rather than as two
                things ticked — a design pass filed it as a bug on exactly that
                reading. The control has to say which KIND it is before it can
                be believed about which state it is in, so a pressed toggle now
                carries a tick: the one glyph that means "this one too" rather
                than "this one instead". The slot is held open while a switch is
                off, so ticking one does not shove its own label sideways. */}
            <div className="grid grid-flow-col auto-cols-fr flex-1 sm:flex-none sm:inline-flex gap-2 p-0.5">
              <button
                type="button"
                onClick={() => handleGroupingChange({ ...grouping, byType: !grouping.byType })}
                aria-pressed={grouping.byType}
                title="Band the list into account-type sections"
                className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                  grouping.byType
                    ? 'bg-[#1a2332] dark:bg-[#2d3a4d] border-[#1a2332] dark:border-[#2d3a4d] text-white'
                    : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                }`}
              >
                {/* aria-hidden: `aria-pressed` already says this to a screen
                    reader, and the tick would announce it a second time. */}
                <span aria-hidden="true" className="w-3.5 flex-shrink-0">
                  {grouping.byType && <CheckIcon size={14} />}
                </span>
                Account Type
              </button>
              <button
                type="button"
                onClick={() => handleGroupingChange({ ...grouping, byInstitution: !grouping.byInstitution })}
                aria-pressed={grouping.byInstitution}
                title="Band the list by institution"
                className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                  grouping.byInstitution
                    ? 'bg-[#1a2332] dark:bg-[#2d3a4d] border-[#1a2332] dark:border-[#2d3a4d] text-white'
                    : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                }`}
              >
                <span aria-hidden="true" className="w-3.5 flex-shrink-0">
                  {grouping.byInstitution && <CheckIcon size={14} />}
                </span>
                Institution
              </button>
            </div>
          </div>
          <div className="w-full sm:w-auto flex items-center gap-2">
            {/* Same weight as "Group by:" beside it. It was the quieter of the
                two only because the Group by label had not been through the
                design pass yet; leaving it grey now would make one row of
                controls carry two different captions for the same job. */}
            <span className="text-sm font-semibold text-gray-600 dark:text-gray-300 w-20 sm:w-auto shrink-0">Sort:</span>
            <div className="grid grid-flow-col auto-cols-fr flex-1 sm:flex-none sm:inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-0.5">
              <button onClick={() => handleSortChange('default')}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  sortMode === 'default' ? 'bg-[#1a2332] dark:bg-[#2d3a4d] text-white' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900'
                }`}>
                Default
              </button>
              <button onClick={() => handleSortChange('name')}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  sortMode === 'name' ? 'bg-[#1a2332] dark:bg-[#2d3a4d] text-white' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900'
                }`}>
                Name A–Z
              </button>
              <button onClick={() => handleSortChange(sortMode === 'balance-desc' ? 'balance-asc' : 'balance-desc')}
                title={sortMode === 'balance-desc'
                  ? 'Sorted highest value first — click for lowest first'
                  : sortMode === 'balance-asc'
                    ? 'Sorted lowest value first — click for highest first'
                    : 'Sort by account value'}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  sortMode === 'balance-desc' || sortMode === 'balance-asc'
                    ? 'bg-[#1a2332] dark:bg-[#2d3a4d] text-white'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900'
                }`}>
                Value {sortMode === 'balance-asc' ? '↑' : '↓'}
              </button>
            </div>
          </div>
          <div className="w-full sm:w-auto flex items-center">
            <button
              type="button"
              onClick={handleOnlyAttentionToggle}
              aria-pressed={onlyAttention}
              title="Hide accounts that are fully reconciled with no balance difference"
              className={`w-full sm:w-auto px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                onlyAttention
                  ? 'bg-[#1a2332] dark:bg-[#2d3a4d] border-[#1a2332] dark:border-[#2d3a4d] text-white'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
              }`}
            >
              Needs attention only{attentionCount > 0 ? ` (${attentionCount})` : ''}
            </button>
          </div>
        </div>

        <ReconciliationAccountList
          grouping={accountGrouping}
          onSelectAccount={handleSelectAccount}
          /* Only when the switch is actually on AND there is something behind
             it. With no accounts at all, "Needs attention only" is hiding
             nothing and the honest state is the empty one — the filter is not
             to blame for a list that would be empty without it. */
          filter={onlyAttention && reconciliationDetails.length > 0
            ? {
                label: 'Needs attention only',
                // Written as the difference rather than as the total, so it
                // stays the count of accounts the filter is REMOVING even if
                // this state is ever reached with some rows still showing.
                hiddenCount: reconciliationDetails.length - attentionCount,
                onClear: handleShowAllAccounts,
              }
            : undefined}
          onGoToAccounts={handleGoToAccounts}
        />
      </div>
    );
  }

  // Step 2: Transaction Review
  return (
    <div className="flex flex-col h-full gap-4">
      {/* The header and balance bar stay pinned below the app nav while the
          transaction list scrolls: reconciliation is done by watching the
          cleared balance approach the bank's figure, so the numbers — and the
          way out, Finalize — must never scroll away. The negative margins
          bleed the strip across the page gutters so passing rows (and their
          shadows) never peek out at the sides.

          ─ THE OFFSET IS A CONSTANT, NOT TWO NUMBERS ────────────────────────
          This read `top-16 md:top-12` until 2026-08-14, and those literals are
          the bar HEIGHTS with everything above them left out. Measured while
          building the equivalent on the accounts page (#276), all three ways
          they are wrong:

            · the demo banner is not counted, so in demo mode this strip parked
              BEHIND the fixed app nav — the nav is itself pushed down by
              `var(--wt-demo-banner-height)` and this was not;
            · `env(safe-area-inset-top)` is not counted, which is non-zero on an
              installed home-screen app — where the owner actually runs this;
            · and `top-16` is 64px for a mobile header that measures 76, because
              that header is `p-4` around its content rather than a fixed height.

          `STICKY_UNDER_APP_BAR` adds up whatever those three are at the moment
          it is read. Imported from `layout/chromeOffsets`, which is a LEAF
          module — importing the same constant from `Layout` closes a cycle
          (Layout renders the router's Outlet) and throws `ReferenceError` at
          runtime, with lint and strict TypeScript both passing on it. */}
      <div
        className="sticky z-30 bg-[#f8f9fb] dark:bg-gray-900 -mx-4 px-4 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8 pb-2 flex flex-col gap-4"
        style={{ top: STICKY_UNDER_APP_BAR }}
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={handleBack}
              className="flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
            >
              <ArrowLeftIcon size={20} />
              Back
            </button>
            <h1 className="text-xl md:text-2xl font-bold text-gray-900 dark:text-white truncate">
              {selectedAccount?.name ?? 'Account'}
            </h1>
          </div>

          {/* The far end of the travelling yellow.
              While the closing balance is unconfirmed the next action is on the
              balance bar — go and agree to that figure — so the BAR is yellow
              and this is quiet: the app's ordinary primary, dimmed by the same
              disabled:opacity-50 / not-allowed pair that every other disabled
              primary in this codebase uses. Confirm the figure and the bar
              settles while the yellow arrives HERE, because pressing this is
              now the only thing left to do.
              It wore the yellow in the OTHER state until the owner tested it:
              two amber controls at once read as two refusals, and left the
              user's actual next step — Confirm, a quiet outline on the bar — the
              least visible thing on the screen. One yellow, one meaning, and it
              points at the step you are on.
              The refusal is still never carried by colour: the disabled
              attribute, the not-allowed cursor, the title and the described-by
              hint printed under the box all say it, and none of them are
              visual. */}
          <button
            type="button"
            onClick={() => setShowFinalizationModal(true)}
            disabled={!balanceConfirmed}
            aria-describedby={balanceConfirmed ? undefined : CONFIRM_BALANCE_HINT_ID}
            title={balanceConfirmed ? undefined : CONFIRM_BALANCE_CONSEQUENCE}
            /* Border width in both branches (transparent while quiet) so the
               button does not resize as the gate opens. */
            className={`flex items-center gap-2 px-4 py-2 border rounded-lg transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed ${
              balanceConfirmed
                ? NEXT_ACTION_YELLOW
                : 'border-transparent bg-primary-action text-on-primary-action'
            }`}
          >
            <CheckCircleIcon size={18} />
            Finalise Reconciliation
          </button>
        </div>

        {/* Balance Bar */}
        <ReconciliationBalanceBar
          bankBalance={bankBalance}
          accountBalance={accountBalance}
          clearedBalance={clearedBalance}
          currency={selectedAccount?.currency}
          clearedSummary={clearedSummary}
          onBankBalanceChange={handleBankBalanceChange}
          lastReconciledDate={selectedAccount?.lastReconciledDate ?? null}
          lastReconciledBalance={selectedAccount?.lastReconciledBalance ?? null}
          balanceConfirmed={balanceConfirmed}
          onConfirmBalance={handleConfirmBalance}
          onBalanceEdited={handleBalanceEdited}
        />
      </div>

      {/* Transaction List */}
      <ReconciliationTransactionList
        transactions={accountTransactions}
        categories={categories}
        currency={selectedAccount?.currency}
        openingBalance={selectedAccount?.openingBalance ?? 0}
        pendingClearedIds={pendingCleared}
        onToggleCleared={handleToggleCleared}
        onBulkSetCleared={handleBulkSetCleared}
        onRowClick={handleRowClick}
        onAddTransaction={handleAddTransaction}
        onVisibleOrderChange={handleVisibleOrderChange}
      />

      {/* Pending at the bank — the rows that explain a difference the posted
          transactions cannot. Under the list, beneath a rule, faded. */}
      {pendingAtBank && (
        <PendingAtBankList
          pending={pendingAtBank}
          currency={selectedAccount?.currency}
          difference={differenceToExplain}
          bankBalance={selectedAccount?.bankBalance ?? null}
        />
      )}

      {/* Edit / add transaction (new transactions default to this account) */}
      <EditTransactionModal
        isOpen={isEditModalOpen}
        onClose={handleCloseEditModal}
        transaction={editingTransaction}
        defaultAccountId={selectedAccountId}
        onSaveAndNext={
          editingTransaction && getNextTransactionId(editingTransaction.id)
            ? () => {
                if (!advanceToNextTransaction(editingTransaction.id)) {
                  handleCloseEditModal();
                }
              }
            : undefined
        }
        onSaveAndPrevious={
          editingTransaction && getPreviousTransactionId(editingTransaction.id)
            ? () => { advanceToPreviousTransaction(editingTransaction.id); }
            : undefined
        }
      />

      {/* Finalization Modal. Rendered only against a CONFIRMED figure — there
          is no "finalize anyway" path any more, so the modal never has to
          reason about a balance that is not there. */}
      {confirmedBalance != null && balanceConfirmed && (
        <ReconciliationFinalizationModal
          isOpen={showFinalizationModal}
          confirmedBalance={confirmedBalance.amount}
          clearedBalance={clearedBalance}
          currency={selectedAccount?.currency}
          awaitingFinalizeCount={clearedSummary?.awaitingFinalizeCount ?? 0}
          onClose={() => setShowFinalizationModal(false)}
          onFinalize={handleFinalize}
          finalizing={finalizing}
          onCreateAdjustment={handleCreateAdjustment}
        />
      )}
    </div>
  );
}
