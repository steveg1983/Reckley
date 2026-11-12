import React, { useState, useEffect, useRef, useId } from 'react';
import { parseMoneyInput, toDecimal } from '../../utils/decimal';
import MoneyInput from '../common/MoneyInput';
import { useCurrencyDecimal } from '../../hooks/useCurrencyDecimal';
import { formatDate } from '../../utils/dateFormatter';
import { NEXT_ACTION_YELLOW } from '../../design-system/nextActionYellow';
import { CONFIRM_BALANCE_HINT_ID } from './nextActionYellow';
import { ChevronDownIcon, ChevronUpIcon } from '../icons';
import type { ClearedSummary } from '../../hooks/useReconciliation';

interface ReconciliationBalanceBarProps {
  /**
   * The figure this reconciliation is settled against — the statement's
   * CLOSING balance, in Money's vocabulary, which is what every label on this
   * bar calls it.
   *
   * The prop keeps the account field's name because that is the field
   * `onBankBalanceChange` writes back to. The two are not the same fact: the
   * account's `bankBalance` is what the feed last said, while what arrives
   * here may instead be the balance the last reconciliation ended on (the
   * parent falls back to it), and either way it is only a PROPOSED closing
   * balance until the user confirms it.
   */
  bankBalance: number | null;
  accountBalance: number;
  clearedBalance: number;
  currency?: string;
  clearedSummary?: ClearedSummary;
  /**
   * `null` means "there is no bank balance" — the state the account was in
   * before anyone typed one, and the only honest state when the recorded
   * figure was wrong or was written by an import. Without it a balance could
   * be overwritten but never withdrawn, so an account that has no statement
   * figure to compare against was stuck asserting a stale one forever.
   */
  onBankBalanceChange?: (newBalance: number | null) => void;
  /**
   * What the last finalized reconciliation settled on — Money's two facts at
   * the top of the window. `null` in either field means it has never happened,
   * and nothing is shown rather than a zero pretending to be a statement.
   */
  lastReconciledDate?: Date | null;
  lastReconciledBalance?: number | null;
  /**
   * Has the user AGREED to the figure on screen for this session?
   *
   * A prefilled box is a suggestion — from the bank feed, from the last
   * statement — and a suggestion nobody has looked at is not a statement
   * balance. Finalize is gated on this, and it is deliberately not persisted:
   * next week's reconciliation asks again.
   */
  balanceConfirmed?: boolean;
  /** Agree to the figure currently shown. */
  onConfirmBalance?: (amount: number) => void;
  /** The figure on screen changed under the user's hands: any agreement lapses. */
  onBalanceEdited?: () => void;
}

/**
 * What removing the figure costs, said in full wherever it is offered — and it
 * depends on what is left behind. With a last reconciliation on record the box
 * does not empty, it falls back to the balance that one ended on (Money's
 * starting balance), and a warning that promised N/A would be describing a
 * different screen.
 */
const REMOVE_CONSEQUENCE =
  // "not known" rather than "N/A": the figure it describes is now an em-dash,
  // and an em-dash read aloud is either silence or the words "em dash". A
  // spoken label has to say the thing the symbol means.
  'Remove the closing balance. Difference goes back to not known until you enter another.';
const REMOVE_CONSEQUENCE_WITH_FALLBACK =
  'Remove the closing balance. Difference falls back to the balance your last reconciliation ended on, which you would then have to confirm.';

/**
 * Why Finalize is refusing, said beside the box that is refusing it — the
 * consequence, not a count. A reconciliation is a claim that the ledger agrees
 * with a statement, so the statement's figure has to be one a person actually
 * looked at.
 */
export const CONFIRM_BALANCE_CONSEQUENCE =
  'Confirm the closing balance to finish. Until you do, your marks stay a working list and nothing is reconciled.';

export default function ReconciliationBalanceBar({
  bankBalance,
  accountBalance,
  clearedBalance,
  currency,
  clearedSummary,
  onBankBalanceChange,
  lastReconciledDate,
  lastReconciledBalance,
  balanceConfirmed = false,
  onConfirmBalance,
  onBalanceEdited,
}: ReconciliationBalanceBarProps): React.JSX.Element {
  const { formatCurrency } = useCurrencyDecimal();
  const [isEditingBankBalance, setIsEditingBankBalance] = useState(false);
  const [editValue, setEditValue] = useState('');
  // What was just asked for, shown while the write is in flight. Wrapped in an
  // object because the value itself may legitimately be null (removed), so a
  // bare null could not tell "nothing pending" from "pending removal" apart.
  const [pendingBankBalance, setPendingBankBalance] = useState<{ value: number | null } | null>(null);
  const editFormRef = useRef<HTMLFormElement>(null);
  /**
   * FOLDED AWAY, ON A PHONE (owner, 12 Nov 2026, on the iPhone Duo's front
   * screen): this bar is sticky, and at two figures a row with its captions it
   * stood most of a phone screen tall — "the transactions to look at are hidden
   * behind it all and there is no way you can reconcile an account on that
   * screen". His remedy: an arrow that minimises the box, and brings it back to
   * finish.
   *
   * Folded, it is one line: the Difference, which is the figure you watch while
   * ticking rows, and the way back. Everything else is one press away, and
   * nothing is unmounted — the confirmation, the editor and the hint Finalise
   * is described by all keep their state and their ids.
   *
   * A PHONE-ONLY FOLD, by class and not by measuring: from `md` up the four
   * figures sit on one row and there is nothing to win, so the control is not
   * drawn there and a folded bar is shown whole. That also means opening the
   * Duo with the bar folded cannot strand it folded with no arrow to press.
   * Deliberately not remembered: each reconciliation starts with the figures.
   */
  const [folded, setFolded] = useState(false);
  const figuresId = useId();

  const displayBankBalance = pendingBankBalance ? pendingBankBalance.value : bankBalance;
  /**
   * The one fact the yellow moves on: this figure has not been agreed to.
   *
   * Every control on this bar that wears NEXT_ACTION_YELLOW branches on THIS
   * single boolean — and it is the exact negation of the gate Finalize is
   * disabled by, which is why the yellow can only ever be in one of the two
   * places. While this is true the bar is asking, so the bar is yellow; the
   * moment it goes false the asking is over and the yellow belongs to the
   * button that finishes the job.
   */
  const awaitingConfirmation = !balanceConfirmed;
  const removeConsequence = lastReconciledBalance != null
    ? REMOVE_CONSEQUENCE_WITH_FALLBACK
    : REMOVE_CONSEQUENCE;
  const difference = displayBankBalance != null
    ? toDecimal(displayBankBalance).minus(toDecimal(clearedBalance)).toNumber()
    : null;

  // The write landed: the prop is the truth again.
  useEffect(() => {
    setPendingBankBalance(pending => (pending && bankBalance === pending.value ? null : pending));
  }, [bankBalance]);

  const applyBankBalance = (value: number | null): void => {
    setPendingBankBalance({ value });
    onBankBalanceChange?.(value);
    setIsEditingBankBalance(false);
    setEditValue('');
  };

  const handleBankBalanceSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const parsed = parseMoneyInput(editValue);
    if (parsed === null) {
      // Unreadable — leave whatever is recorded alone. Removing is deliberate
      // (the Remove control), never something a mistyped figure does for you.
      setIsEditingBankBalance(false);
      setEditValue('');
      return;
    }
    applyBankBalance(parsed);
    // Typing a figure and pressing Enter IS confirming it: the person put that
    // number there on purpose, having just read it off a statement. The app's
    // save-commits idiom, and it saves a second click on the commonest path.
    onConfirmBalance?.(parsed);
  };

  const differenceTone = difference != null && Math.abs(difference) >= 0.005
    ? 'text-red-600 dark:text-red-400'
    : 'text-gray-900 dark:text-white';

  return (
    <div
      className={`bg-white dark:bg-gray-800 rounded-xl border-2 border-gray-200 dark:border-gray-700 ${
        folded ? 'px-4 py-1 md:p-4' : 'p-4'
      }`}
    >
      {folded && (
        <div className="md:hidden flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm text-gray-500 dark:text-gray-400">
            Difference{' '}
            {difference != null ? (
              <span className={`font-bold ${differenceTone}`}>{formatCurrency(difference, currency)}</span>
            ) : (
              <span className="font-bold text-gray-400">—</span>
            )}
          </p>
          <button
            type="button"
            onClick={() => setFolded(false)}
            aria-expanded={false}
            aria-controls={figuresId}
            className="shrink-0 min-h-[44px] flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Show balances
            <ChevronDownIcon size={18} />
          </button>
        </div>
      )}
      <div id={figuresId} className={folded ? 'hidden md:block' : undefined}>
      {/* Four figures side by side needs ~90px each; a 375px phone has room
          for two. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        {/* Closing Balance — the statement's ending figure, Money's own name
            for it, and the one this reconciliation is settled against. Not the
            account's live "Bank Bal" on the Accounts page: that is whatever the
            feed last said, a different fact that nobody has to agree to.

            A COLUMN, not a paragraph of inline things. The figure and Confirm
            are both inline-level, so in a plain `text-center` block the browser
            set them on ONE line whenever the cell was wide enough for both:
            the amount slid off-centre, wedged against a button, and stopped
            lining up with the three figures beside it. `flex-col items-center`
            gives label → amount → Confirm a line each, centred, sharing the
            other cells' vertical rhythm. */}
        <div className="flex flex-col items-center text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Closing Balance</p>
          {displayBankBalance != null && !isEditingBankBalance ? (
            <button
              type="button"
              onClick={() => {
                setEditValue(String(displayBankBalance));
                setIsEditingBankBalance(true);
              }}
              /* Colour is never the only signal: the reason is spoken here too,
                 and only while the paragraph holding it is actually rendered. */
              aria-describedby={awaitingConfirmation ? CONFIRM_BALANCE_HINT_ID : undefined}
              /* The border width is carried in BOTH branches (transparent once
                 confirmed) so resolving the yellow does not move the figure. */
              className={`text-lg font-bold border rounded-lg px-2 py-0.5 transition-colors cursor-pointer ${
                awaitingConfirmation
                  ? NEXT_ACTION_YELLOW
                  : 'border-transparent text-gray-900 dark:text-white hover:text-primary'
              }`}
              title="Click to change or remove"
            >
              {formatCurrency(displayBankBalance, currency)}
            </button>
          ) : isEditingBankBalance ? (
            /* w-full because the cell is now a centring flex column, which
               would otherwise shrink this form to its content and leave the
               input narrower than the figure it replaces. */
            <form ref={editFormRef} onSubmit={handleBankBalanceSubmit} className="w-full flex flex-col gap-1">
              <MoneyInput
                // An overdrawn account's statement balance is negative.
                allowNegative
                value={editValue}
                onChange={value => {
                  // Editing withdraws the agreement, the instant the figure
                  // stops being the one that was agreed to. Nothing is
                  // confirmed by accident here.
                  setEditValue(value);
                  onBalanceEdited?.();
                }}
                /* The editor is the affordance in its open state, so it wears
                   the same yellow — the first keystroke that withdraws a
                   confirmation turns the box and Finalize together. Swapped,
                   never appended: the dark surface classes below and the
                   token's would otherwise both apply and Tailwind would settle
                   it by CSS source order. */
                className={`w-full px-2 py-1 text-sm border rounded ${
                  awaitingConfirmation
                    ? NEXT_ACTION_YELLOW
                    : 'dark:bg-gray-700 dark:border-gray-600 dark:text-white'
                }`}
                aria-label="Closing balance"
                aria-describedby={awaitingConfirmation ? CONFIRM_BALANCE_HINT_ID : undefined}
                autoFocus
                onKeyDown={event => {
                  // Enter commits AND confirms. Written out rather than left to
                  // the form's implicit submission, which a browser only
                  // performs while this is the single field in the form — a
                  // second one added here would silently take the key away.
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  handleBankBalanceSubmit();
                }}
                onBlur={event => {
                  // Moving onto Remove is still inside the editor. Closing here
                  // would unmount that button before its click ever landed.
                  if (editFormRef.current?.contains(event.relatedTarget)) return;
                  if (editValue.trim()) {
                    handleBankBalanceSubmit();
                  } else {
                    setIsEditingBankBalance(false);
                    setEditValue('');
                  }
                }}
              />
              {/* Only ever offered against a figure that exists — and only from
                  inside the editor, so it takes a deliberate click to reach.
                  preventDefault on mousedown keeps focus in the field: Safari
                  does not focus a button on click, so the blur above would
                  otherwise close the form out from under this one. */}
              {displayBankBalance != null && (
                <button
                  type="button"
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => applyBankBalance(null)}
                  title={removeConsequence}
                  aria-label={removeConsequence}
                  className="text-xs text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:underline"
                >
                  Remove
                </button>
              )}
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setIsEditingBankBalance(true)}
              aria-describedby={awaitingConfirmation ? CONFIRM_BALANCE_HINT_ID : undefined}
              className={`text-sm font-medium border rounded-lg px-2 py-0.5 transition-colors ${
                awaitingConfirmation
                  ? NEXT_ACTION_YELLOW
                  : 'border-transparent text-primary hover:underline'
              }`}
            >
              Enter balance
            </button>
          )}

          {/* Confirm sits under the figure it is about, third in the column. It
              is offered whenever there is a figure to agree to — including
              £0.00, which is a real statement balance for an account swept to
              zero every night, and which the app must never confuse with "no
              balance".

              The two states of this slot carry IDENTICAL box metrics — same
              margin, padding, text size, and a border width in both, the
              second one transparent — so agreeing to the figure cannot change
              the height of the cell, and the whole sticky bar cannot shift
              under the cursor at the exact moment of the click. It is the same
              trick the figure above already plays with its own border, and the
              reason both are spelled out rather than left to chance.

              The other two shape changes here are NOT reserved, deliberately:
              an account with no figure at all has no Confirm to offer, and
              opening the editor adds a Remove link beneath the input. Both are
              mode changes the user asked for by clicking, both are followed by
              their own click target, and reserving a phantom line for a control
              that cannot exist in that mode would be inventing space to hold
              nothing. */}
          {displayBankBalance != null && !isEditingBankBalance && (
            balanceConfirmed ? (
              /* A STATUS WORD, NOT A CONTROL (Design, 28 Aug §7). "Confirmed"
                 sat in link blue one line under where "Confirm" had been a real
                 button, so a past-tense fact invited a press that does nothing —
                 the affordance rule, already ruled on twice. Neutral caption
                 treatment: there is nothing here to do. */
              <p className="mt-1 px-2 py-0.5 text-xs font-medium rounded border border-transparent text-gray-500 dark:text-gray-400">
                Confirmed
              </p>
            ) : (
              <button
                type="button"
                onClick={() => onConfirmBalance?.(displayBankBalance)}
                title={CONFIRM_BALANCE_CONSEQUENCE}
                /* The quiet bordered secondary. This is a real press, but not
                   the page's primary one — Finalize is, and it wears the yellow
                   thread. A blue outline here competed with it for a colour
                   nobody chose. */
                className="mt-1 px-2 py-0.5 text-xs font-medium rounded border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                Confirm
              </button>
            )
          )}
        </div>

        {/* Account Balance */}
        <div className="text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Account Balance</p>
          <p className="text-lg font-bold text-gray-900 dark:text-white">
            {formatCurrency(accountBalance, currency)}
          </p>
        </div>

        {/* Cleared Balance — THE THIRD OF THE TRIO, IN THE TRIO'S COLOUR.
            (Design, 28 Aug §3.) On a finished reconciliation this bar shows
            `Closing £4,887.70 · Account £4,887.70 · Cleared £4,887.70`: the same
            figure three times, and it used to render navy, navy and blue.

            When three figures agree, the design's job is to make the agreement
            VISIBLE — three matching figures in one weight and one colour read as
            "these match" instantly, which is the entire question a reconciliation
            screen answers. Colouring one of them differently actively obstructed
            the only comparison the reader came here to make. */}
        <div className="text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Cleared Balance</p>
          <p className="text-lg font-bold text-gray-900 dark:text-white">
            {formatCurrency(clearedBalance, currency)}
          </p>
        </div>

        {/* Difference — the expense token ONLY when there is a difference.
            (Design, 28 Aug §2.) `Difference £0.00` rendered blue: the loudest
            non-amber thing on a completed reconciliation, for the state that is
            the reconciliation SUCCEEDING. It competed at rung 3 with Finalize,
            which is the one control that ends the condition and correctly wears
            the amber. A real difference is a real condition; zero is not, so
            zero joins the trio and says nothing. */}
        <div className="text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Difference</p>
          {difference != null ? (
            <p className={`text-lg font-bold ${differenceTone}`}>
              {formatCurrency(difference, currency)}
            </p>
          ) : (
            /* Em-dash, not "N/A" — the same replacement the register and the
               Accounts row carry. Not known is not zero. */
            <p className="text-lg font-bold text-gray-400">—</p>
          )}
        </div>
      </div>

      {/* Why Finalize is refusing, beside the box that is refusing it. Said as
          the consequence — what the marks are worth until it is done — rather
          than as an instruction with no reason attached. */}
      {awaitingConfirmation && (
        <p
          id={CONFIRM_BALANCE_HINT_ID}
          className="mt-3 text-xs text-amber-700 dark:text-amber-400 text-center"
        >
          {CONFIRM_BALANCE_CONSEQUENCE}
        </p>
      )}

      {/* Money's two facts about last time: when, and against what. Shown only
          when both are known — a date with no figure is a claim nobody can
          check, and a figure with no date is not a statement. */}
      {lastReconciledDate != null && lastReconciledBalance != null && (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400 text-center">
          Last reconciled: {formatDate(lastReconciledDate)} · ending balance{' '}
          {formatCurrency(lastReconciledBalance, currency)}
        </p>
      )}

      {/* Cleared summary (MS Money-style session totals) */}
      {clearedSummary && clearedSummary.totalCount > 0 && (
        <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          <span>
            <span className="font-semibold text-gray-700 dark:text-gray-300">
              {clearedSummary.clearedCount} of {clearedSummary.totalCount}
            </span>{' '}
            transactions marked
          </span>
          <span>
            Marked deposits:{' '}
            <span className="font-semibold text-green-600 dark:text-green-400">
              {formatCurrency(clearedSummary.depositsTotal, currency)}
            </span>{' '}
            ({clearedSummary.depositsCount})
          </span>
          <span>
            Marked payments:{' '}
            <span className="font-semibold text-red-600 dark:text-red-400">
              {formatCurrency(clearedSummary.paymentsTotal, currency)}
            </span>{' '}
            ({clearedSummary.paymentsCount})
          </span>
        </div>
      )}

      {/* The way to fold it — see `folded`. Words beside the arrow, because an
          arrow alone does not say what it hides. */}
      <div className="md:hidden mt-2 flex justify-center">
        <button
          type="button"
          onClick={() => setFolded(true)}
          aria-expanded
          aria-controls={figuresId}
          className="min-h-[44px] flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Hide balances
          <ChevronUpIcon size={18} />
        </button>
      </div>
      </div>
    </div>
  );
}
