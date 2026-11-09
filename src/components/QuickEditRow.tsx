import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useApp } from '../contexts/AppContextSupabase';
import { useToast } from '../contexts/ToastContext';
import { usePayeeMemory } from '../hooks/usePayeeMemory';
import { ArrowRightLeftIcon, XIcon } from './icons';
import CategorySelector from './CategorySelector';
import AccountSelector from './common/AccountSelector';
import DatePicker from './common/DatePicker';
import SuggestedCategoryBadge from './SuggestedCategoryBadge';
import { findTransferCandidates, type TransferCandidate } from '../utils/transferMatch';
import { isConfirmableSuggestion } from '../utils/categoryProvenance';
import { transferEvidenceFor, type TransferEvidence } from '../utils/transferEvidence';
import { formatCount } from '../utils/localeFormat';
// The mark every part of this editor wears (data-quick-edit), and the question
// the register asks of it before claiming a key. Written down there because the
// register needs the same answer and neither should own the other's copy.
import { isInsideQuickEdit } from '../utils/quickEditScope';
// The strip's arrow keys. The rule lives with the rest of the register's
// keyboard so the printed shortcut list and the handler cannot drift apart.
import { nextStripButtonIndex } from '../utils/registerShortcuts';
import CrossCurrencyTransferDialog from './CrossCurrencyTransferDialog';
import { transferCategoryIdFor } from '../utils/transferRepoint';
import {
  crossedCurrencies,
  destinationLegAmount,
  recordConvertedCounterpart,
  type ConfirmedConversion,
  type CrossCurrency,
} from '../utils/crossCurrencyTransfer';
import { amountWithCurrencyCode } from '../utils/crossCurrencyLabel';
import type { Account, Transaction } from '../types';

/**
 * ─ THE ROW IS THE EDITOR ───────────────────────────────────────────────────
 *
 * Highlighting a row in the register turns the row itself into the form: the
 * Date cell becomes a date picker, the Description cell a text box, the
 * Category cell a combobox — each still in its own column, still under its own
 * header, still the width the user dragged it to. Underneath sits a slim strip
 * carrying Save & Next, Save, the × and the hint (and Confirm, when the
 * category is only the app's guess).
 *
 * It used to be a card BELOW the row that repeated Date, Description and
 * Category as a second set of fields — so the same three values appeared twice,
 * one line apart, in different places and at different widths, and the eye had
 * to work out which of the two it was reading. The owner: make the row itself
 * the editor. There is nothing to reconcile now, because there is only one of
 * each value on screen.
 *
 * Payment, Deposit, Balance, R and Tags stay as they read. Amounts belong to
 * the full editor — one editor per thing, and a register you can retype a
 * balance into is a register nobody can trust.
 *
 * ─ THE RHYTHM ─────────────────────────────────────────────────────────────
 * Filing a statement is the same edit made a hundred times, so the keyboard is
 * shaped around REPEATING one field rather than around finishing one row:
 *
 *   type → Enter (accepts what you typed, and hands you Save & Next)
 *        → Enter (saves, moves to the next row, cursor back in the SAME field)
 *
 * which means a run of categories is: type, Enter, Enter, type, Enter, Enter…
 * without the hand ever leaving the keyboard or the eye leaving the line.
 * Save — the other button — ends the run: it saves, closes the editor, and
 * gives the list back the keyboard so the arrows work again. Escape closes
 * without saving. Both leave the row that was being edited still highlighted.
 *
 * ─ WHY A PROVIDER AND TWO CONSUMERS ────────────────────────────────────────
 * The editor is now spread across two places the table renders — cells inside
 * the row, and a strip in the row's detail — and one component cannot render
 * into two disjoint places. So the state, the keys and the writes live in a
 * provider mounted ABOVE the table, and the cells and the strip read them from
 * context.
 *
 * That the provider sits above the table rather than inside it is not
 * incidental. Typing in the description must not re-render eleven thousand
 * rows: the provider re-renders, its children element is the same object, React
 * bails out of the table, and only the three cells and the strip — its
 * consumers — are redrawn. The provider is also mounted ALWAYS, editor or no
 * editor, because a wrapper that comes and goes changes the type of the tree
 * beneath it, and this register has already been through what that does to a
 * virtualised list (see VirtualizedTable's note on component identity).
 */

/** The things in the row that can hold the cursor.
    Notes joined on 17 Aug (owner): tidying a statement is a run down ONE
    field, and notes was the one field on show that still forced the full
    editor open for every row. */
export type QuickEditField = 'date' | 'description' | 'category' | 'notes';

/**
 * Where the cursor should land in an editor that is opening, and how.
 *
 * The editor is opened by two different intentions and they want different
 * things, so the request says which rather than leaving the caller to guess.
 */
export interface QuickEditFocusRequest {
  field: QuickEditField;
  /**
   * Let the date field's calendar unfurl as the cursor arrives.
   *
   * F2 says yes: the user has just asked to edit this row, and the calendar is
   * most of what the date field is for. A Save & Next landing says no — the
   * same field, row after row, with a calendar covering the next three
   * transactions every time would hide the very list being worked down.
   */
  openCalendar?: boolean;
}

/**
 * How tall the row's own line is while it is the editor, in px.
 *
 * ─ THE ARITHMETIC, AND WHY THESE TWO NUMBERS ───────────────────────────────
 * The fields are 36px — between the add dock's 32px and the old card's 42px,
 * and the tallest that fits a register row's own 8px of vertical cell padding
 * without the cells (which clip) cutting the inputs off: 36 + 8 + 8 = 52.
 *
 * A plain row is 44px, so being edited costs a row 8px of extra height, and the
 * strip below it 36 more: 44 more altogether, where the old card below the row
 * was 88. Half, which is what the owner asked for — and the whole expanded row
 * now stands 88px tall, exactly what the card ALONE used to take.
 *
 * Declared here rather than measured because the virtualised list positions
 * rows by adding heights up: a row that quietly grew is a row every row below
 * it is painted over by.
 */
export const QUICK_EDIT_ROW_HEIGHT = 52;

/** How tall the strip beneath the edited row is, in px. See above. */
export const QUICK_EDIT_STRIP_HEIGHT = 36;

/** The YYYY-MM-DD a date input wants, from whatever the row is carrying. */
function toDateInputValue(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().split('T')[0];
}

/**
 * The field a focus request can actually be honoured in.
 *
 * Two things take fields away. A transfer or a split has no category to pick —
 * its category is a system one, or lives in its split lines — and any column
 * can be switched off in the View menu, editor and all. Falling back to the
 * description keeps the old behaviour for the common case (a run of categories
 * meeting a transfer) and keeps the cursor somewhere it can be typed for the
 * rest.
 */
function resolveField(
  wanted: QuickEditField,
  available: readonly QuickEditField[]
): QuickEditField | null {
  if (available.includes(wanted)) return wanted;
  if (available.includes('description')) return 'description';
  return available[0] ?? null;
}

/** Which button's write is in flight, or null when none is. */
type SavingAction = 'save' | 'next' | 'confirm' | null;

/**
 * The strip prompt that stands in for the transfer dialog, and why it is a
 * strip rather than a dialog. See TRANSFER_PROMPT below.
 */
interface QuickEditTransferPrompt {
  targetAccountId: string;
  targetAccountName: string;
  candidates: TransferCandidate[];
}

interface QuickEditRowContextValue {
  transaction: Transaction;
  fields: readonly QuickEditField[];
  date: string;
  setDate: (value: string) => void;
  description: string;
  setDescription: (value: string) => void;
  notes: string;
  setNotes: (value: string) => void;
  category: string;
  chooseCategory: (categoryId: string) => void;
  /** Is the Category cell currently the transfer-to ACCOUNT picker? */
  transferMode: boolean;
  /** Flip it. The category underneath is kept; see toggleTransferMode. */
  toggleTransferMode: () => void;
  /** The account chosen while in transfer mode, or '' when none is yet. */
  transferAccountId: string;
  chooseTransferAccount: (accountId: string) => void;
  /** Every OTHER active account — the row's own is never a transfer target. */
  transferTargets: readonly Account[];
  /**
   * The ledger's own proposal that this row is a transfer, or null. See
   * proposeTransfer: it is what put the toggle on and the account in the box
   * as the row opened, and the strip names it as a suggestion for as long as
   * that account is the one in the box.
   */
  transferSuggestion: TransferEvidence | null;
  /** Is the account in the box still only the proposal? */
  showingTransferSuggestion: boolean;
  dateFocusToken: number;
  categoryOpenToken: number;
  showingSuggestion: boolean;
  savingAction: SavingAction;
  hasNext: boolean;
  /** The match-or-create question, asked in the strip. Null when not asked. */
  transferPrompt: QuickEditTransferPrompt | null;
  linkTransfer: (candidateId: string) => void;
  createTransfer: () => void;
  cancelTransferPrompt: () => void;
  dateFieldRef: React.RefObject<HTMLDivElement>;
  descriptionRef: React.RefObject<HTMLInputElement>;
  notesRef: React.RefObject<HTMLInputElement>;
  saveButtonRef: React.RefObject<HTMLButtonElement>;
  saveAndNextButtonRef: React.RefObject<HTMLButtonElement>;
  /** The strip's Confirm, where a run lands on a row that carries a suggestion. */
  confirmButtonRef: React.RefObject<HTMLButtonElement>;
  handleKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  noteFocus: (field: QuickEditField) => void;
  requestSave: (advance: boolean) => void;
  confirmSuggestion: () => void;
  dismiss: () => void;
}

const QuickEditRowContext = createContext<QuickEditRowContextValue | null>(null);

function useQuickEditRow(): QuickEditRowContextValue {
  const value = useContext(QuickEditRowContext);
  if (!value) {
    throw new Error(
      'A quick-edit cell was rendered outside QuickEditRowProvider — the editor and the row it edits must be in one tree.'
    );
  }
  return value;
}

export interface QuickEditRowProviderProps {
  /**
   * The transaction whose row IS the editor, or null when no row is being
   * edited. Null keeps the provider mounted and renders nothing: see the note
   * at the top on why this wrapper never comes and goes.
   */
  transaction: Transaction | null;
  /**
   * Which of the three fields have a column to sit in, in the order the
   * register draws them. A column switched off in the View menu takes its
   * editor with it — the full editor still reaches every field — and the run
   * lands somewhere that exists (see resolveField).
   */
  fields?: readonly QuickEditField[];
  /**
   * Advance the selection to the next transaction in the visible list, and put
   * the cursor where the run asks for it in the editor that opens there.
   *
   * Absent when this is the LAST row: the strip then shows no Save & Next at
   * all, and a save ends the run instead of wrapping round to the top.
   */
  onNext?: (landOn: QuickEditFocusRequest) => void;
  /**
   * The list DROPS a row the moment it is saved — the "To Review" filter,
   * where filing is what ends review — so there is no row to stay on, and a
   * plain Save or a Confirm moves on to the next row exactly as Save & Next
   * does. Without this, every row cost a click to re-select the next one
   * (the owner, 1 Oct 2026: "this could save a click per line all the way
   * down"). The last row still closes the editor, as it always did.
   */
  moveOnAfterSave?: boolean;
  /**
   * How a run walks the list.
   *
   * 'same-field' (the default, the desktop's): Save & Next lands in the field
   * the user was last in, and a landing on Category opens the list with the
   * cursor in its search — "type, Enter, Enter" down a statement.
   *
   * 'description-first' (the phone card's): Save & Next ALWAYS lands in the
   * description, nothing opened, and Return in the description is what opens
   * the category list. On a phone the on-screen keyboard has already taken
   * half the screen; a category list thrown open on arrival took most of the
   * rest, over the date and the description of a row the person had not yet
   * read (the owner, on the iPhone Duo, 9 Nov 2026: "You may wish to change
   * the description first but you are forced with this big drop down taking
   * up a lot of the screen space"). So the row is shown whole, the cursor sits
   * in the field most likely to want tidying, and the list comes when asked
   * for — by Return, or by a tap on the category box as always.
   */
  run?: 'same-field' | 'description-first';
  /**
   * Stop editing — Escape, the ×, or a finished Save — leaving the row itself
   * highlighted.
   *
   * The register hands the keyboard back to the grid when this fires, so the
   * arrow keys carry on from the row that was being edited rather than
   * scrolling the list from a button nobody can see. Escape and the × also
   * discard: any unsaved keystrokes go with them, and the fields re-read the
   * stored transaction when the row is next opened.
   */
  onDismiss: () => void;
  /**
   * A request from the register — F2, or the landing after a Save & Next — for
   * the cursor to be put in one of the fields.
   *
   * Consumed the instant it is honoured (see onFocusRequestHandled), so a
   * request can never be replayed and steal the cursor from someone who was
   * typing somewhere else entirely.
   */
  focusRequest?: QuickEditFocusRequest | null;
  /** Called once the cursor has landed, so the caller can drop the request. */
  onFocusRequestHandled?: () => void;
  children: React.ReactNode;
}

const ALL_FIELDS: readonly QuickEditField[] = ['date', 'description', 'category', 'notes'];

export function QuickEditRowProvider({
  transaction,
  fields = ALL_FIELDS,
  onNext,
  onDismiss,
  focusRequest,
  onFocusRequestHandled,
  moveOnAfterSave = false,
  run = 'same-field',
  children,
}: QuickEditRowProviderProps): React.JSX.Element {
  const {
    transactions,
    accounts,
    categories,
    updateTransaction,
    confirmTransactionCategories,
    linkTransferPair,
    createTransferCounterpart,
    // The cross-currency route: the far side is written explicitly at a
    // confirmed figure rather than minted, and unwound if the link fails.
    addTransaction,
    deleteTransaction,
  } = useApp();
  const { showError, showSuccess } = useToast();
  const { propagateCategory } = usePayeeMemory();

  const [date, setDate] = useState(() => (transaction ? toDateInputValue(transaction.date) : ''));
  const [description, setDescription] = useState(transaction?.description ?? '');
  const [category, setCategory] = useState(transaction?.category ?? '');
  const [notes, setNotes] = useState(transaction?.notes ?? '');
  /**
   * Which button's write is in flight, or null when none is.
   *
   * Not a bare boolean, because the busy word belongs on the button the user
   * actually pressed: Save & Next is the one a run presses a hundred times, and
   * an editor that greys everything out while the OTHER button says "Saving…"
   * is telling the user about a button they did not touch.
   */
  const [savingAction, setSavingAction] = useState<SavingAction>(null);
  const isSaving = savingAction !== null;

  // The Date cell's wrapper — the shared DatePicker owns its own input, and
  // this is how F2 reaches it without the page reaching across into another
  // component's DOM by id.
  const dateFieldRef = useRef<HTMLDivElement>(null);
  const descriptionRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLInputElement>(null);
  // Where the cursor goes when a field's Enter accepts what was typed; see the
  // comment on focusRunButton.
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const saveAndNextButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  // Pulses asking the two pickers for the cursor. They own their own DOM, so a
  // number they watch is how the editor asks without reaching into it.
  const [dateFocusToken, setDateFocusToken] = useState(0);
  const [categoryOpenToken, setCategoryOpenToken] = useState(0);
  /**
   * The field the user was last in — the one a Save & Next lands back in.
   *
   * A run down a statement is one field repeated: a hundred categories, or a
   * hundred tidied descriptions. Remembering which turns "next transaction"
   * into "next transaction, ready to carry on", instead of dropping the cursor
   * somewhere the user has to leave again. A ref, not state: nothing on screen
   * depends on it, and it must not cost a render every time focus moves.
   *
   * It lasts as long as the RUN, which is why it is cleared when the editor
   * closes and not when it merely moves to the next row.
   */
  const lastFieldRef = useRef<QuickEditField | null>(null);
  /**
   * ─ A TRANSFER THE LEDGER PROPOSES ─────────────────────────────────────────
   *
   * The categoriser never suggests a transfer (utils/transferEvidence has the
   * whole story): a "To/From Savings" written as a category is half a
   * transfer with no other side. But a swept account's nightly sweep IS a
   * transfer, two hundred times over, and offering nothing — or worse, the
   * minority category that outvoted the sweeps — made the owner file the
   * same movement by hand every night (2 Oct 2026: "can we make the system a
   * little smarter… if the overwhelming evidence of past transactions is
   * that this is the case?").
   *
   * So the proposal is made HERE, in the editor, and only here: the toggle
   * comes on and the account goes in the box, badged as a suggestion. Saving
   * it runs the same match-or-create question a hand-picked account runs —
   * the pair is written by the user's answer, never by the proposal — and
   * the toggle is one click from a category if the ledger was wrong. Rows
   * already linked, already transfers, already split or already filed under
   * a category the user vouched for are never asked: those have an answer.
   *
   * The target must be an account the picker could offer — open, and not the
   * row's own — or the proposal would sit in a box with no such option.
   */
  const proposeTransfer = useCallback((row: Transaction): TransferEvidence | null => {
    if (row.linkedTransferId) return null;
    const evidence = transferEvidenceFor(transactions, categories, row);
    if (!evidence) return null;
    const target = accounts.find(a => a.id === evidence.targetAccountId);
    if (!target || target.isActive === false || target.id === row.accountId) return null;
    return evidence;
  }, [transactions, categories, accounts]);

  /**
   * ─ TRANSFER MODE ──────────────────────────────────────────────────────────
   *
   * The Category cell answers one of two questions: "what was this spent on?"
   * or "which account did this money move to?". A transfer is not a category,
   * and in Microsoft Money it never was — you said where the money went, and
   * Money made the other side. Filing one through a "To/From <account>"
   * category still works and is what the picker under the toggle writes, but
   * finding those among four hundred categories is not a thing anyone should
   * have to do on a run.
   *
   * So the toggle swaps the combobox for the ACCOUNT list, and swaps it back.
   *
   * ─ WHY THE CATEGORY SURVIVES THE FLIP ─────────────────────────────────────
   * `category` is deliberately NOT cleared when the toggle goes on. A run down
   * a statement is a sequence of guesses being confirmed; toggling to check
   * whether a row is really a transfer, deciding it is not, and finding the
   * suggestion gone would make the toggle something you daren't press. It dies
   * exactly once: when a transfer is actually committed, because the row is
   * then a transfer and its category belongs to the account it faces.
   */
  const [transferSuggestion, setTransferSuggestion] = useState<TransferEvidence | null>(
    () => (transaction ? proposeTransfer(transaction) : null)
  );
  const [transferMode, setTransferMode] = useState(transferSuggestion !== null);
  const [transferAccountId, setTransferAccountId] = useState(transferSuggestion?.targetAccountId ?? '');
  // Money-style transfer flow: committing a transfer asks match-or-create
  // rather than writing blindly — in the strip, not a dialog. See TRANSFER
  // PROMPT on QuickEditActionStrip.
  const [transferPrompt, setTransferPrompt] = useState<QuickEditTransferPrompt | null>(null);
  /**
   * The currency pair being asked about, or null when nothing is.
   *
   * A DIALOG rather than the strip, unlike match-or-create above, and the
   * difference is what is being asked for. The strip asks the user to CHOOSE
   * between two things it can name; this asks them to supply a figure the app
   * does not have, with two linked inputs and a provenance line — which does
   * not fit in a row, and should not, because it is the one moment in the flow
   * where a number nobody has verified is about to enter the ledger.
   */
  const [conversionPrompt, setConversionPrompt] = useState<CrossCurrency | null>(null);
  const [conversionBusy, setConversionBusy] = useState(false);
  const advanceAfterTransferRef = useRef(false);

  const isTransfer = transaction?.type === 'transfer';
  // A split transaction's categorisation lives in its split lines — the DB
  // guard rejects a single-category write, so this editor never sends one.
  const isSplit = transaction?.isSplit === true;

  /**
   * Re-read the fields when the editor moves to a DIFFERENT transaction.
   *
   * Keyed by id, not object identity: context refreshes recreate the object
   * every few seconds and must not clobber what the user is mid-way through
   * typing.
   *
   * This is what carries a Save & Next: the provider outlives the hop (only the
   * cells are rebuilt, on the next row), so without this the next row would be
   * shown the row before's figures — and shown them in fields the user is one
   * keystroke away from saving.
   *
   * Done during the render rather than in an effect — React's own "adjusting
   * state when a prop changes" — because an effect would set the new values one
   * render LATER, and a cursor landing in between would select the outgoing
   * row's text and have it replaced under the caret.
   */
  const targetId = transaction?.id ?? null;
  const [syncedId, setSyncedId] = useState<string | null>(targetId);
  if (syncedId !== targetId) {
    setSyncedId(targetId);
    setDate(transaction ? toDateInputValue(transaction.date) : '');
    setDescription(transaction?.description ?? '');
    setCategory(transaction?.category ?? '');
    setNotes(transaction?.notes ?? '');
    // Transfer mode is about the ROW being edited, so it does not travel to the
    // next one: a Save & Next that landed with the account picker still up
    // would offer to move money the moment the user typed.
    //
    // Unless the ledger's own history makes the case for THIS row — then the
    // toggle is on and the account is in the box as the row opens, as a
    // suggestion. See proposeTransfer for what that takes and why it is safe.
    const proposal = transaction ? proposeTransfer(transaction) : null;
    setTransferSuggestion(proposal);
    setTransferMode(proposal !== null);
    setTransferAccountId(proposal?.targetAccountId ?? '');
    setTransferPrompt(null);
    // The run is over when the editor closes; the next one starts its own
    // memory rather than inheriting where the last one happened to end.
    if (targetId === null) lastFieldRef.current = null;
  }

  /**
   * Where a field's Enter hands the cursor: Save & Next while there is a next
   * row, and Save on the last one.
   *
   * Without it the keyboard is simply LOST — the category box closes by
   * unmounting its search field, and focus falls back to the document body,
   * where neither Enter nor Escape reaches the editor at all. And it is where
   * the user is going anyway: on a run, the very next thing they do is save and
   * move on, so the second Enter does it without a key change.
   */
  const focusRunButton = useCallback((): void => {
    const button = saveAndNextButtonRef.current ?? saveButtonRef.current;
    button?.focus();
  }, []);

  /**
   * Put the cursor where the register asked for it.
   *
   * Each field is reached the way its own component allows: the description is
   * the editor's own input, the date and the category are shared components
   * that own their DOM and watch a number instead.
   */
  const applyFocusRequest = useCallback((request: QuickEditFocusRequest): void => {
    const field = resolveField(request.field, fields);
    if (!field) {
      // Every editable column switched off. There is still a row to save, so
      // the cursor goes where the next Enter is useful rather than nowhere.
      focusRunButton();
      return;
    }
    switch (field) {
      case 'description':
        descriptionRef.current?.focus();
        // Selected, not caret-at-end: Money does the same, and a run of
        // descriptions is nearly always a REPLACEMENT ("ASDA STORES 4021" →
        // "Asda"). Typing overwrites; one press of End or → keeps it instead.
        descriptionRef.current?.select();
        return;
      case 'notes':
        // Same selection rule as the description, for the same reason: a run
        // down the notes column is filing the same kind of remark row after
        // row, and what is already there is usually being replaced.
        notesRef.current?.focus();
        notesRef.current?.select();
        return;
      case 'category':
        // A row that already carries the app's SUGGESTION lands on Confirm,
        // list closed, so the suggestion is read in the box and the next
        // Enter agrees with it and moves on — a one-key run through a
        // statement the app has mostly guessed right. Opening the list here
        // hid the very thing being asked about behind a search box (the
        // owner, 2 Oct 2026). A row with no category, or one the user has
        // already vouched for, opens the list to type into, as before.
        //
        // The same for a row the ledger proposes as a TRANSFER: the account is
        // already in the box, so the cursor lands on Save & Next and Enter
        // asks the match-or-create question. Opening the account list would
        // hide the proposal behind a search box exactly as the category one
        // was hidden.
        if (transferMode && transferAccountId) {
          focusRunButton();
          return;
        }
        if (transaction && isConfirmableSuggestion(transaction) && category === (transaction.category ?? '')) {
          confirmButtonRef.current?.focus();
          return;
        }
        setCategoryOpenToken(token => token + 1);
        return;
      case 'date':
        if (request.openCalendar) {
          const input = dateFieldRef.current?.querySelector('input');
          input?.focus();
          input?.select();
          return;
        }
        setDateFocusToken(token => token + 1);
        return;
    }
  }, [fields, focusRunButton, transaction, category, transferMode, transferAccountId]);

  // The register's request — F2, or the landing after a Save & Next. Honoured
  // once and handed straight back, so nothing about it survives to fire again.
  useEffect(() => {
    if (!focusRequest) return;
    if (transaction) applyFocusRequest(focusRequest);
    onFocusRequestHandled?.();
  }, [focusRequest, transaction, applyFocusRequest, onFocusRequestHandled]);

  /** Remember the field the cursor is in, for the next Save & Next to land in. */
  const noteFocus = useCallback((field: QuickEditField): void => {
    lastFieldRef.current = field;
  }, []);

  /**
   * Give the keyboard back after a write that left the editor open.
   *
   * Every button here disables itself while a write is in flight, and a browser
   * blurs a button the moment it is disabled — so pressing one drops the cursor
   * on the floor. It does not matter when the editor closes on success (the
   * register takes the keyboard back), but it matters twice over when it stays:
   * after a FAILED save, where the user has to fix something and press again,
   * and after Confirm, whose button disappears with the badge it agreed with.
   * Both used to end with the keyboard on nothing at all.
   *
   * Never when the user has since clicked into a field: the cursor is theirs
   * then, and moving it would be the rudest possible answer to an error.
   */
  const restoreFocusRef = useRef(false);
  useEffect(() => {
    if (isSaving || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    if (isInsideQuickEdit(document.activeElement)) return;
    focusRunButton();
  }, [isSaving, focusRunButton]);

  /**
   * What a successful save does next: walk on, or end the run.
   *
   * Save & Next hands the register the field to land in, so the editor that
   * opens on the next row is already where the user was typing. Save — and a
   * Save & Next with nowhere to go — closes the editor instead and gives the
   * list back the keyboard, so the arrow keys carry on from the row just saved
   * rather than scrolling from a button nobody can see.
   */
  const finishSave = useCallback((advance: boolean): void => {
    if ((advance || moveOnAfterSave) && onNext) {
      // The phone's run lands in the description whatever field was last
      // touched — see the `run` prop. resolveField falls through to the next
      // offered field if the description column is switched off.
      const field = run === 'description-first' ? 'description' : lastFieldRef.current ?? 'date';
      onNext({ field, openCalendar: false });
      return;
    }
    onDismiss();
  }, [onNext, onDismiss, moveOnAfterSave, run]);

  /**
   * The row's three fields as the user has them, checked — or null with the
   * reason already shown. Shared by Save and Confirm so the two buttons cannot
   * disagree about what a row needs before anything is written.
   */
  const readFields = useCallback((): { date: Date; description: string; notes: string } | null => {
    if (!description.trim()) {
      showError(new Error('Description is required.'));
      return null;
    }
    const parsedDate = new Date(date);
    if (!date || Number.isNaN(parsedDate.getTime())) {
      showError(new Error('Enter a valid date.'));
      return null;
    }
    return { date: parsedDate, description: description.trim(), notes };
  }, [date, description, notes, showError]);

  const save = useCallback(async (advance: boolean): Promise<void> => {
    if (!transaction || isSaving) return;
    const fields = readFields();
    if (!fields) return;
    const parsedDate = fields.date;
    // "Make this a transfer" arrives two ways and they mean the same thing: the
    // Transfer toggle with an account chosen, or a "To/From <account>" category
    // picked out of the ordinary list (which is still how a filed transfer is
    // recognised everywhere else). Both save the field edits, then hand over to
    // the match-or-create question, which owns the category/type change. Never
    // for rows that already are transfers or splits.
    const chosenCategory = categories.find(c => c.id === category);
    const targetAccountId = transferMode
      ? transferAccountId
      : (chosenCategory?.isTransferCategory ? chosenCategory.accountId ?? '' : '');
    if (!isTransfer && !isSplit && !transaction.linkedTransferId && targetAccountId) {
      if (targetAccountId === transaction.accountId) {
        showError(new Error(
          transferMode
            ? "A transfer needs two different accounts — pick the account the money went to."
            : "That's this account's own transfer category — pick the OTHER account's To/From category."
        ));
        return;
      }
      setSavingAction(advance ? 'next' : 'save');
      restoreFocusRef.current = true;
      try {
        await updateTransaction(transaction.id, {
          date: parsedDate,
          description: description.trim(),
          notes,
          // NOT reviewed yet. This used to write `needsReview: false` here,
          // before the transfer half had happened, and in a "To Review"
          // register that was fatal: the row left the filtered list the moment
          // the flag dropped, the editor's target became null, its reset wiped
          // this very prompt, and the link/create verbs never ran — the row
          // kept its suggested category and the owner found it there a day
          // later (Coutts sweeps, 28 Sep 2026: every audit entry shows one
          // save of notes + needs_review and nothing else). Review ends in
          // completeTransfer, after the other side is written; a cancelled
          // prompt leaves the row in review, because the filing did not happen.
        });
        advanceAfterTransferRef.current = advance;
        setTransferPrompt({
          targetAccountId,
          targetAccountName: accounts.find(a => a.id === targetAccountId)?.name ?? 'the other account',
          candidates: findTransferCandidates(
            transactions,
            { ...transaction, date: parsedDate, description: description.trim() },
            targetAccountId,
            undefined,
            // With the accounts in hand this also finds the other side of a
            // CONVERTED transfer — opposite in sign, any magnitude — which the
            // exact-amount rule could never see. Before this, a real
            // counterpart already sitting in a foreign-currency account was
            // invisible and the only offer was "create the other side", which
            // would have written a second row for money that had already
            // arrived.
            { accounts }
          ),
        });
      } catch (error) {
        showError(error);
      } finally {
        setSavingAction(null);
      }
      return;
    }

    // Transfer mode with no account chosen is an unfinished sentence, not an
    // instruction. Refusing here rather than silently saving the category
    // underneath keeps the toggle honest: what is on screen is what will be
    // written.
    if (transferMode && !transferAccountId) {
      showError(new Error('Pick the account this money moved to, or switch back to categories.'));
      return;
    }

    setSavingAction(advance ? 'next' : 'save');
    restoreFocusRef.current = true;
    try {
      const categoryChanged = category !== (transaction.category ?? '');
      await updateTransaction(transaction.id, {
        date: parsedDate,
        description: description.trim(),
        // As the full editor's update sends it: the string as typed, and an
        // emptied field clears the note.
        notes,
        // A SAVE IS A REVIEW. This is the whole of the Microsoft Money rule the
        // register's bold implements: the row stops being new when a save
        // button commits it, and not a moment before. Opening the editor and
        // pressing Escape leaves this unsent, so the row stays bold and the
        // counter stays where it was — reading a row is not the same as
        // finishing with it.
        //
        // Sent explicitly, and only from here and the three other save buttons,
        // because no server-side rule could tell this write apart from a bulk
        // categorise sweep or a payee rename passing through the same door.
        needsReview: false,
        // Saving from the row is confirmation. The user opened it, the category
        // was in front of them in the cell they are saving, and they either
        // changed it or let it stand — both are answers to "is this right?".
        // Sent explicitly rather than left to the server's "a changed category
        // is a confirmed one" rule, because letting a suggestion stand
        // deliberately is the case that rule cannot see.
        ...(isTransfer || isSplit ? {} : { category, categoryConfirmed: true }),
      });

      // Payee memory — but never for CROSS-TYPE filings (a refund put under an
      // expense category is a one-off correction; teaching it to a mixed-flow
      // payee would stamp expense categories onto all its incoming money).
      const isCrossType =
        chosenCategory !== undefined &&
        (chosenCategory.type === 'income' || chosenCategory.type === 'expense') &&
        chosenCategory.type !== transaction.type;

      if (!isTransfer && !isSplit && categoryChanged && category && !isCrossType &&
          (transaction.type === 'income' || transaction.type === 'expense')) {
        await propagateCategory({
          accountId: transaction.accountId,
          description: description.trim(),
          type: transaction.type,
          categoryId: category,
          excludeId: transaction.id,
        });
      }

      finishSave(advance);
    } catch (error) {
      // Nothing closes and nothing moves on: the row stays exactly as it is,
      // with the edit still in it, so the user can read the message and try
      // again rather than hunt for what they had typed.
      showError(error);
    } finally {
      setSavingAction(null);
    }
  }, [
    transaction, isSaving, readFields, description, notes, category, categories, isTransfer, isSplit,
    transferMode, transferAccountId, accounts,
    transactions, updateTransaction, propagateCategory, finishSave, showError,
  ]);

  const requestSave = useCallback((advance: boolean): void => {
    void save(advance);
  }, [save]);

  /**
   * The two keys the editor answers to.
   *
   * ENTER ACCEPTS, and hands over Save & Next. It does not save by itself —
   * that changed deliberately, because filing a statement is the same edit made
   * a hundred times and the second Enter is what makes it a run: accept this
   * one, save-and-move-on, land in the same field, carry on typing.
   *
   * Two things own Enter before this does —
   *
   *   - an OPEN category list, where Enter chooses the highlighted option. It
   *     prevents the default, and the choice itself hands the cursor over (see
   *     chooseCategory); an Enter that matched nothing is left alone, because
   *     yanking the cursor out of a search that found nothing is the opposite
   *     of helpful;
   *   - a BUTTON, where Enter is the press. Save, Save & Next and Confirm all
   *     do their own thing with it, and running this handler as well would
   *     write the transaction twice in one keystroke.
   *
   * The DATE field is the third, and it is the one exception: it settles a
   * half-typed date and shuts its calendar on its own Enter, marking the key
   * handled — but settling IS the accept, so the cursor moves on from there
   * exactly as it does from the description.
   *
   * ESCAPE closes the editor, one layer at a time. An open menu or calendar
   * answers its own Escape first and stops it here; only an Escape nothing else
   * wanted means "I'm done with this row" — and the register then takes the
   * layer after that (a stretched selection, then the highlight itself).
   *
   * Attached to each of the editor's parts rather than to one wrapper round
   * them all, because there is no such wrapper any more: the fields are cells
   * of the row and the buttons are a strip beneath it.
   */
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Escape' && e.key !== 'Enter') return;
    // The transfer confirmation is a dialog of its own and owns both keys.
    if (transferPrompt) return;

    if (e.key === 'Escape') {
      if (e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
      return;
    }

    if (e.target instanceof Element && e.target.closest('button')) return;

    const inDateField = e.target instanceof Node && dateFieldRef.current?.contains(e.target) === true;
    if (e.defaultPrevented && !inDateField) return;
    if (!e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
    }
    // The phone's run: Return in the description goes ON to the category —
    // the list opens with the cursor in its search, or the cursor lands on
    // Confirm / Save & Next where a suggestion or a proposed transfer is
    // already in the box (applyFocusRequest's own rules, unchanged). The
    // desktop's Enter still hands over Save & Next.
    if (
      run === 'description-first' &&
      e.target === descriptionRef.current &&
      fields.includes('category')
    ) {
      applyFocusRequest({ field: 'category', openCalendar: false });
      return;
    }
    focusRunButton();
  }, [transferPrompt, onDismiss, focusRunButton, run, fields, applyFocusRequest]);

  /**
   * A chosen category hands the cursor to Save & Next.
   *
   * Without it the keyboard is simply LOST: the category box closes by
   * unmounting its search field, and focus falls back to the document body,
   * where neither Enter nor Escape reaches the editor at all. Save & Next is
   * where it belongs anyway — filing categories is the run this editor exists
   * for, so the very next keystroke should be the one that files this row and
   * offers the next.
   */
  const chooseCategory = useCallback((categoryId: string): void => {
    setCategory(categoryId);
    focusRunButton();
  }, [focusRunButton]);

  /**
   * The one-click half of "confirm or edit": agree with the guess exactly as it
   * stands. The confirming verb writes a single boolean — no category, no
   * amount, no balance — and the editor stays open so the row visibly settles
   * before moving on.
   *
   * WHAT IS IN THE ROW IS WHAT IS SAVED. A description tidied or a note typed
   * before the button is pressed goes with the confirm — the owner tidied an
   * import's wording, pressed Confirm, and found the import's wording still
   * there (2 Oct 2026): the button had agreed with the category and silently
   * dropped the rest of what was on screen. The fields are written through the
   * ordinary update path, as a Save writes them, and only when something was
   * actually typed over, so an untouched row still costs one write of one
   * boolean. No category and no review flag travel with them — the verb is
   * what vouches, and the verb is what ends the row's review.
   *
   * Its own button disappears as it succeeds — the badge it agreed with goes,
   * and the button goes with it — so the cursor is handed on to Save & Next,
   * which is what "move on" means from here.
   */
  const confirmSuggestion = useCallback((): void => {
    if (!transaction || isSaving) return;
    const fields = readFields();
    if (!fields) return;
    const id = transaction.id;
    const typedOver =
      fields.description !== transaction.description ||
      fields.notes !== (transaction.notes ?? '') ||
      toDateInputValue(fields.date) !== toDateInputValue(transaction.date);
    setSavingAction('confirm');
    restoreFocusRef.current = true;
    void (async (): Promise<void> => {
      try {
        if (typedOver) {
          await updateTransaction(id, {
            date: fields.date,
            description: fields.description,
            notes: fields.notes,
          });
        }
        const confirmed = await confirmTransactionCategories([id]);
        if (confirmed === 0) {
          // The store did not confirm this row, and saying so is the whole
          // point: the alternative — the message this used to show every time
          // — sent the owner back to a register where the row was still bold
          // and still badged, with nothing to explain the disagreement.
          showError(new Error(
            'That row could not be confirmed — it may have changed since this list was loaded. It has been reloaded; try again.'
          ));
        } else {
          showSuccess('Category confirmed.');
          // In a list that drops the confirmed row, move on to the next one
          // rather than leaving the person to click it (see moveOnAfterSave).
          // The cursor lands on the category, which is the field a confirm
          // was about and the one the next row most likely wants.
          if (moveOnAfterSave) {
            if (onNext) onNext({ field: 'category', openCalendar: false });
            else onDismiss();
          }
        }
      } catch (error) {
        showError(error);
      } finally {
        setSavingAction(null);
      }
    })();
  }, [
    transaction, isSaving, readFields, updateTransaction, confirmTransactionCategories,
    showSuccess, showError, moveOnAfterSave, onNext, onDismiss,
  ]);

  /**
   * Is the category in the cell still only the app's guess?
   *
   * Read from the STORED row, not from `category` state: the moment the user
   * picks something else it is their choice, and the "suggested" marking must
   * come off as they do it rather than after a round trip. So a pending edit
   * takes it off immediately.
   */
  const showingSuggestion =
    // Transfers and splits are excluded inside the predicate, so every surface
    // asks the same question of the same rule.
    transaction !== null &&
    isConfirmableSuggestion(transaction) &&
    category === (transaction.category ?? '') &&
    // And never while the Transfer toggle is on. The category underneath
    // survives the flip (see toggleTransferMode), so the predicate above
    // still held — and Confirm stayed on the strip beside an ACCOUNT picker,
    // where the owner pressed it meaning "confirm the transfer I just chose"
    // and got the guessed category confirmed instead, the account thrown
    // away (2 Oct 2026). With the toggle on there is no suggestion on screen
    // to agree with, so there is no button to agree with it. It comes back
    // with the category when the toggle goes off.
    !transferMode;
  /**
   * The account in the box is still only the ledger's proposal: the toggle is
   * on, a proposal was made for this row, and nobody has picked a different
   * account since. Picking one takes the badge off at once, as choosing a
   * category takes the category badge off.
   */
  const showingTransferSuggestion =
    transferMode &&
    transferSuggestion !== null &&
    transferAccountId === transferSuggestion.targetAccountId;

  /**
   * Flip the Category cell between the category list and the account list.
   *
   * Nothing is written and nothing is cleared — see the note on `transferMode`
   * for why the category underneath has to survive the flip. Turning the toggle
   * OFF also forgets the account picked while it was on, because an account
   * chosen and then abandoned is not an instruction, and leaving it set would
   * make a later flip back arrive pre-loaded with a decision the user walked
   * away from.
   */
  const toggleTransferMode = useCallback((): void => {
    setTransferMode(on => {
      // Off forgets a chosen account; on brings the ledger's proposal back,
      // if it made one — the proposal was never the user's decision to
      // abandon, and a toggle that flipped between "the suggested category"
      // and "an empty account box" would lose the suggested transfer on the
      // way past.
      setTransferAccountId(on ? '' : (transferSuggestion?.targetAccountId ?? ''));
      return !on;
    });
  }, [transferSuggestion]);

  /**
   * An account chosen hands the cursor to Save & Next, exactly as a category
   * does — same reason, written out on chooseCategory: the picker closes by
   * unmounting its search field, and focus would otherwise fall to the document
   * body where neither Enter nor Escape reaches this editor.
   */
  const chooseTransferAccount = useCallback((accountId: string): void => {
    setTransferAccountId(accountId);
    focusRunButton();
  }, [focusRunButton]);

  /**
   * Where the money could have gone: every OTHER active account.
   *
   * The row's own is excluded rather than offered-and-refused, because
   * "Current Account → Current Account" describes nothing, and a picker that
   * lists an option only to reject it is a picker that has wasted a keystroke.
   */
  const transferTargets = useMemo<readonly Account[]>(
    () => (transaction
      ? accounts.filter(a => a.isActive !== false && a.id !== transaction.accountId)
      : []),
    [accounts, transaction]
  );

  // Complete the transfer flow (link or create), then honour a pending
  // Save & Next. Failures keep the prompt up so the user can retry/cancel.
  const completeTransfer = useCallback(async (
    action: () => Promise<unknown>,
    successMessage: string
  ): Promise<void> => {
    setSavingAction(advanceAfterTransferRef.current ? 'next' : 'save');
    try {
      await action();
      // FILING ENDS REVIEW — after the verb, never before it (see save). The
      // transfer verbs write the link and the category and leave the flag
      // alone, exactly as the bulk sweep found on 11 Sep (#569).
      if (transaction) {
        await updateTransaction(transaction.id, { needsReview: false });
      }
      showSuccess(successMessage);
      setTransferPrompt(null);
      // THE CATEGORY DIES HERE, and only here. The row is a transfer now; its
      // category belongs to the account it faces, and the guess that was being
      // kept across toggles has nothing left to be a guess about.
      setTransferMode(false);
      setTransferAccountId('');
      setCategory('');
      const advance = advanceAfterTransferRef.current;
      advanceAfterTransferRef.current = false;
      finishSave(advance);
    } catch (error) {
      showError(error);
    } finally {
      setSavingAction(null);
    }
  }, [transaction, updateTransaction, finishSave, showSuccess, showError]);

  const linkTransfer = useCallback((candidateId: string): void => {
    if (!transaction || !transferPrompt) return;
    void completeTransfer(
      () => linkTransferPair(transaction.id, candidateId),
      `Linked as a transfer with ${transferPrompt.targetAccountName}.`
    );
  }, [transaction, transferPrompt, completeTransfer, linkTransferPair]);

  const createTransfer = useCallback((): void => {
    if (!transaction || !transferPrompt) return;
    /**
     * Across a currency boundary the far side cannot be MINTED — the RPC would
     * copy this row's digits into an account that counts in another currency —
     * so the person is asked what actually arrived, and the confirmed figure is
     * written explicitly. This used to be a flat refusal with nowhere to go.
     */
    const crossed = crossedCurrencies(
      accounts,
      transaction.accountId,
      transferPrompt.targetAccountId
    );
    if (crossed) {
      setConversionPrompt(crossed);
      return;
    }
    void completeTransfer(
      () => createTransferCounterpart(transaction.id, transferPrompt.targetAccountId),
      `Transfer created — the other side was added to ${transferPrompt.targetAccountName}.`
    );
  }, [transaction, transferPrompt, accounts, completeTransfer, createTransferCounterpart]);

  /**
   * The far side, at the rate the person just confirmed, then the link, then
   * the source's own stamp. `completeTransfer` carries the same success/dismiss
   * behaviour every other transfer completion here gets, so a converted
   * transfer leaves the dock exactly as an ordinary one does.
   */
  const confirmConversion = useCallback((conversion: ConfirmedConversion): void => {
    if (!transaction || !transferPrompt) return;
    setConversionBusy(true);
    void completeTransfer(
      () => recordConvertedCounterpart(
        { addTransaction, updateTransaction, linkTransferPair, deleteTransaction },
        transaction,
        {
          accountId: transferPrompt.targetAccountId,
          // Each side files under the OTHER account's To/From category; the
          // link re-files both anyway, and this is what the row names if it
          // somehow cannot.
          category: transferCategoryIdFor(
            categories,
            transaction.accountId,
            destinationLegAmount(transaction.amount, conversion.destinationAmount).toNumber()
          ),
        },
        conversion
      ),
      `Transfer created — ${transferPrompt.targetAccountName} received the converted amount.`
    ).finally(() => {
      setConversionBusy(false);
      setConversionPrompt(null);
    });
  }, [
    transaction, transferPrompt, categories, completeTransfer,
    addTransaction, updateTransaction, linkTransferPair, deleteTransaction,
  ]);

  const cancelConversion = useCallback((): void => {
    // Only the conversion is abandoned. The match-or-create strip stays up, so
    // the same row can still be linked to an existing far side instead.
    setConversionPrompt(null);
  }, []);

  const cancelTransferPrompt = useCallback((): void => {
    setTransferPrompt(null);
    advanceAfterTransferRef.current = false;
    // The field edits were committed by the save that opened this; only the
    // transfer half is abandoned, and with it the review: the row still
    // carries whatever it carried before (a suggestion, or nothing), so it
    // stays in the list until it is actually filed. The toggle stays as the
    // user left it so the account can be corrected and saved again.
    restoreFocusRef.current = true;
    focusRunButton();
  }, [focusRunButton]);

  const value = useMemo<QuickEditRowContextValue | null>(() => {
    if (!transaction) return null;
    return {
      transaction,
      fields,
      date,
      setDate,
      description,
      setDescription,
      notes,
      setNotes,
      category,
      chooseCategory,
      transferMode,
      toggleTransferMode,
      transferAccountId,
      chooseTransferAccount,
      transferTargets,
      transferSuggestion,
      showingTransferSuggestion,
      dateFocusToken,
      categoryOpenToken,
      showingSuggestion,
      savingAction,
      hasNext: onNext !== undefined,
      transferPrompt,
      linkTransfer,
      createTransfer,
      cancelTransferPrompt,
      dateFieldRef,
      descriptionRef,
      notesRef,
      saveButtonRef,
      saveAndNextButtonRef,
      confirmButtonRef,
      handleKeyDown,
      noteFocus,
      requestSave,
      confirmSuggestion,
      dismiss: onDismiss,
    };
  }, [
    transaction, fields, date, description, notes, category, chooseCategory,
    transferMode, toggleTransferMode, transferAccountId, chooseTransferAccount, transferTargets,
    transferSuggestion, showingTransferSuggestion,
    dateFocusToken, categoryOpenToken, showingSuggestion, savingAction, onNext,
    transferPrompt, linkTransfer, createTransfer, cancelTransferPrompt,
    handleKeyDown, noteFocus, requestSave, confirmSuggestion, onDismiss,
  ]);

  return (
    <QuickEditRowContext.Provider value={value}>
      {children}
      {/* Portalled, so it floats over the register rather than inside a table
          row — and rendered here rather than in the strip so it survives the
          strip's own re-renders while a write is in flight. */}
      {conversionPrompt && transaction && transferPrompt && (
        <CrossCurrencyTransferDialog
          isOpen
          sourceAmount={transaction.amount}
          sourceCurrency={conversionPrompt.from}
          sourceAccountName={
            accounts.find(a => a.id === transaction.accountId)?.name ?? 'this account'
          }
          destinationCurrency={conversionPrompt.to}
          destinationAccountName={transferPrompt.targetAccountName}
          busy={conversionBusy}
          onConfirm={confirmConversion}
          onCancel={cancelConversion}
        />
      )}
    </QuickEditRowContext.Provider>
  );
}

/**
 * One cell of the row, while the row is the editor.
 *
 * Everything the three have in common lives here: the mark that tells the
 * register these keys are not its own, the Enter/Escape handler, the note of
 * which field the cursor is in (for the next Save & Next to land back in), and
 * the click that must NOT reach the row underneath — a click on the row while
 * its editor is open means "give me the full editor", and typing into the
 * description is not that.
 *
 * ─ WHY EACH SHELL EATS ITS CELL'S PADDING ──────────────────────────────────
 * `-mx-3 -my-2` cancels the padding the table puts on every cell, and each
 * shell then puts back whatever inset it wants. Two things come of that. The
 * shell covers the WHOLE cell, so aiming at the description box and missing it
 * by three pixels types rather than opening the full editor over what you were
 * about to type. And a column too narrow for its field — the 100px Date one —
 * can hand the field the pixels the padding was holding.
 *
 * Nothing is clipped by it: overflow is clipped at the padding box, which is
 * exactly where a shell that has cancelled its cell's padding ends.
 */
function QuickEditCellShell({
  field,
  cellRef,
  className = '',
  children,
}: {
  field: QuickEditField;
  cellRef?: React.RefObject<HTMLDivElement>;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const { handleKeyDown, noteFocus } = useQuickEditRow();
  return (
    <div
      ref={cellRef}
      data-quick-edit={field}
      onKeyDown={handleKeyDown}
      // Capture, so it is heard wherever inside the field focus actually goes —
      // a picker's search box, a date input, the description itself.
      onFocusCapture={() => noteFocus(field)}
      onClick={(e) => e.stopPropagation()}
      // The vertical inset is put straight back (the field is 36px in a 52px
      // row); the horizontal is each field's own, because the Date column has
      // none to spare. No flex: a block child fills the width on its own, and
      // both pickers are blocks that size their own input to it.
      className={`-mx-3 -my-2 py-2 ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * The Date, Description or Category cell of the row being edited — the control
 * in the place the value was being read, under its own column header.
 */
/**
 * Every field the provider offers, in its order, each handed to `children` to
 * draw. For a layout that is not the register's row — the phone card stacks
 * them under captions — without exporting the context hook itself (a hook
 * export would break fast refresh for the whole file).
 */
export function QuickEditFieldList({
  children,
}: {
  children: (field: QuickEditField) => React.ReactNode;
}): React.JSX.Element {
  const { fields } = useQuickEditRow();
  return <>{fields.map((field) => <React.Fragment key={field}>{children(field)}</React.Fragment>)}</>;
}

export function QuickEditFieldCell({ field }: { field: QuickEditField }): React.JSX.Element {
  const {
    transaction, date, setDate, description, setDescription, notes, setNotes,
    category, chooseCategory,
    transferMode, toggleTransferMode, transferAccountId, chooseTransferAccount, transferTargets,
    dateFocusToken, categoryOpenToken, dateFieldRef, descriptionRef, notesRef,
  } = useQuickEditRow();

  if (field === 'date') {
    return (
      // The register's narrowest column, and a dd/mm/yyyy date is a fixed ten
      // characters of it. So this field keeps four pixels of inset (px-1) where
      // its neighbours keep twelve, and the calendar glyph is dropped (see
      // DatePicker's showIcon) because the 32px it reserves is worth more here
      // as date.
      //
      // Those four pixels are a TERM in the column's width sum — see
      // registerDateColumn, which owns the arithmetic and is held to it by a
      // test that reads this very class name back off the DOM. Widening this
      // inset narrows the date.
      <QuickEditCellShell field="date" cellRef={dateFieldRef} className="px-1">
        {/* The shared dd/mm/yyyy picker, NOT a native date input: natives
            render in the browser's locale, which showed American dates to a
            register displaying UK ones. */}
        <DatePicker
          value={date}
          onChange={setDate}
          size="sm"
          showIcon={false}
          className="h-[36px] text-sm font-normal bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg dark:text-white"
          aria-label="Transaction date"
          // The cell sits INSIDE the transaction list, which clips what
          // overflows it: an in-flow calendar would be cut off at the edge of
          // the table, and worst of all near the foot — where the register
          // opens, and where most of this work is done.
          usePortal
          // A Save & Next run landing here wants the field, not the calendar —
          // see the prop's own note. F2 still opens it, because F2 goes through
          // focus() and means "I want to edit this row".
          focusWithoutCalendarToken={dateFocusToken}
        />
      </QuickEditCellShell>
    );
  }

  if (field === 'description') {
    return (
      <QuickEditCellShell field="description" className="px-3 min-w-0">
        {/* Named rather than labelled: the column header IS the label here, and
            a screen reader reading a grid cell says the column with it — but
            the name has to be unambiguous on its own, because the add bar at
            the foot of the page has a Description too. */}
        <input
          ref={descriptionRef}
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-label="Transaction description"
          className="w-full px-2 h-[36px] text-sm font-normal bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg dark:text-white"
        />
      </QuickEditCellShell>
    );
  }

  if (field === 'notes') {
    return (
      // The Notes cell behaves EXACTLY as the description does — type, Enter
      // (accepts, hands over Save & Next), Enter (saves, moves on, cursor back
      // here) — because the owner's use of it IS the description's use: the
      // same annotation filed down a hundred rows. A single-line input, not
      // the full editor's markdown box: what fits in a register cell is what
      // can be edited in one; anything longer is the full editor's job, the
      // same division Amounts already live under.
      <QuickEditCellShell field="notes" className="px-3 min-w-0">
        <input
          ref={notesRef}
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          aria-label="Transaction notes"
          className="w-full px-2 h-[36px] text-sm font-normal bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg dark:text-white"
        />
      </QuickEditCellShell>
    );
  }

  return (
    // Searchable combobox: click to type-filter, or use the chevron to browse
    // the full list. Both directions are offered (Money-style cross-type filing
    // — a refund can file under the expense it refunds).
    //
    // Transfers and splits never reach here: the register leaves their Category
    // cell exactly as it reads, because a transfer's category follows the
    // account it faces and a split's lives in its lines.
    <QuickEditCellShell field="category" className="px-3 min-w-0">
      {/* The picker and its toggle share the cell, and the picker takes every
          pixel the toggle does not: a 28px square is what a chevron already
          costs, and the Category column is the widest of the three. */}
      <div className="flex items-center gap-1.5">
        <div className="flex-1 min-w-0">
          {transferMode ? (
            /* WHERE DID THE MONEY GO? — the same box, the same height, the same
               search, a different list. Money asked this question directly
               rather than hiding it among four hundred categories, and the
               account chosen here becomes that account's "To/From" category on
               save, so nothing downstream has to learn a second shape. */
            <AccountSelector
              accounts={transferTargets}
              selectedAccountId={transferAccountId}
              onAccountChange={chooseTransferAccount}
              placeholder="Search or select account…"
              ariaLabel="Transfer to account"
              usePortal
              size="row"
              openSearchToken={categoryOpenToken}
            />
          ) : (
            /* Searchable combobox: click to type-filter, or use the chevron to
               browse the full list. Both directions are offered (Money-style
               cross-type filing — a refund can file under the expense it
               refunds).

               Transfers and splits never reach here: the register leaves their
               Category cell exactly as it reads, because a transfer's category
               follows the account it faces and a split's lives in its lines. */
            <CategorySelector
              selectedCategory={category}
              onCategoryChange={chooseCategory}
              transactionType={transaction.type}
              includeAllTypes
              // "Make this a transfer" arrives two ways in this editor and they
              // mean the same thing (see save): the toggle beside this box with
              // an account chosen, or a "To/From <account>" category picked out
              // of the list. BOTH end in the match-or-create question, which
              // writes the pair — so the category route is offered deliberately
              // here, under its own heading, with this row's own account left
              // out (a transfer to itself moves nothing).
              //
              // Stated as a prop rather than left to the tree's shape. It used
              // to be neither: the To/From categories hang directly off the
              // Transfer type root, one rung shallower than a leaf, so the
              // sub→detail walk simply never reached them — and the documented
              // category route was unreachable in the real app for any row that
              // did not already carry one.
              //
              // The BULK filing pickers deliberately do not set this: converting
              // many rows at once would mean creating many counterparts nobody
              // recorded. See utils/transferCoherence.
              includeTransferTargets
              transferSourceAccountId={transaction.accountId}
              showHelperText={false}
              placeholder="Search or select category…"
              allowClear
              // Same reason as the calendar above: the list would be clipped by
              // the table it is drawn inside.
              usePortal
              // Matches the 36px the row grows to while it is being edited.
              size="row"
              // A category run lands here: the list opens with an empty search
              // and the cursor in it, so the next payee is typed straight away.
              openSearchToken={categoryOpenToken}
            />
          )}
        </div>
        {/* THE TOGGLE. In the cell rather than the strip, because it changes
            what THIS cell is asking, and a control that changes a field belongs
            beside the field it changes.

            A button, so Tab reaches it straight after the picker and Enter
            presses it — the ordinary semantics, and the editor's own Enter
            handler stands aside for anything inside a <button> (see
            handleKeyDown), so the run's "Enter accepts, Enter saves" rhythm is
            untouched by its presence. aria-pressed rather than a checkbox: it
            is a mode, not a value, and it has no label of its own to tick. */}
        <button
          type="button"
          onClick={toggleTransferMode}
          aria-pressed={transferMode}
          aria-label="Transfer"
          title={transferMode
            ? 'Back to categories — the category you had is still there'
            : 'This row is a transfer: choose the account the money moved to instead of a category'}
          /* aria-pressed is an ON state, and the app rules one colour for that:
             the selected border, which index.css remaps to #94a3b8 on dark so
             the ring is what reads there, the wash what reads on light
             (stock-blue ruling, 28 Aug 2026). */
          className={`shrink-0 h-[28px] w-[28px] inline-flex items-center justify-center rounded-lg border transition-colors ${
            transferMode
              ? 'border-primary bg-primary/10 text-gray-900 dark:text-gray-100'
              : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-400 dark:hover:border-gray-500'
          }`}
        >
          <ArrowRightLeftIcon size={14} />
        </button>
      </div>
    </QuickEditCellShell>
  );
}

/**
 * The strip under the row being edited: what you can do, and the two-Enter
 * rhythm that does it.
 *
 * Everything that is not a field lives here, and nothing that IS one — no
 * repeated Date, no second Description. That is the whole change: the strip is
 * 36px where the card it replaced was 88, and the row it belongs to has grown
 * 8px to hold its own fields.
 *
 * Enter in a field lands the cursor on Save & Next; the arrows then walk along
 * the rest of the strip, so ending a run on one row is Enter, →, Enter. See
 * moveAlongStrip.
 */
/**
 * @param layout — 'row' (default) is the strip as the register draws it, the
 *   bottom half of the highlighted row's card. 'card' is the same strip inside
 *   MobileQuickEditCard: its own rounded border, buttons free to wrap on a
 *   375px screen, and no keyboard rhythm to explain because a phone has no
 *   Enter key to explain it to.
 */
export function QuickEditActionStrip({ layout = 'row' }: { layout?: 'row' | 'card' } = {}): React.JSX.Element {
  const {
    showingSuggestion, savingAction, hasNext, saveButtonRef, saveAndNextButtonRef, confirmButtonRef,
    handleKeyDown, requestSave, confirmSuggestion, dismiss,
    transferPrompt, linkTransfer, createTransfer, cancelTransferPrompt,
    // The ledger's transfer proposal, named here beside the save that acts on
    // it, with the account it names for the sentence.
    showingTransferSuggestion, transferSuggestion, transferTargets,
    // The row itself, for the one sentence that has to name BOTH figures: a
    // converted pair's two amounts differ, and the strip is where the user
    // agrees to that.
    transaction,
  } = useQuickEditRow();
  const isSaving = savingAction !== null;
  const stripRef = useRef<HTMLDivElement>(null);
  const promptDefaultRef = useRef<HTMLButtonElement>(null);

  /**
   * ─ THE TRANSFER PROMPT, AND WHY IT IS A STRIP AND NOT A DIALOG ────────────
   *
   * Committing a transfer from the row editor has to ask one question: is the
   * other side already in that account, or should we make it? The full editor
   * asks it in a modal, which is right there — that flow is one transaction at
   * a time and the modal is already the thing on screen.
   *
   * Here it would be wrong, and the reason is the run. This editor exists so a
   * statement can be filed at "type, Enter, Enter" without the hand leaving the
   * keyboard or the eye leaving the line. A modal takes the screen, takes the
   * focus out of the strip, and puts the row being worked on behind an overlay
   * — after which the next Enter goes somewhere the user has to look for. So
   * the question is asked in the 36px that is already there, in the place the
   * cursor already is, and the cursor lands on the answer that is nearly always
   * right.
   *
   * ─ WHY NOT AUTO-CREATE, WHICH WOULD BE FASTER STILL ───────────────────────
   * Because both silent answers are wrong in a way the user cannot see.
   * Creating the other side writes a real row into another account and moves
   * that account's balance; doing it without a word, in the one flow whose
   * whole point is speed, is how a register acquires a row nobody remembers.
   * Auto-LINKING is worse: findTransferCandidates treats the description as a
   * TIE-BREAKER only — the two banks never word it the same — so its top
   * candidate is "the nearest date with an exactly opposite amount", and on a
   * swept account that is a coin toss between several real transactions.
   *
   * One keypress is the honest price, and it is one keypress: Enter.
   */
  useEffect(() => {
    if (transferPrompt) promptDefaultRef.current?.focus();
  }, [transferPrompt]);

  /**
   * The arrows, while the cursor is on one of these buttons: step along the
   * strip. See nextStripButtonIndex for the rule and why it cannot disturb the
   * fields above or the list behind.
   *
   * Read off the DOM rather than from a list of refs, because which buttons
   * exist changes with the row — Confirm only on a guessed category, Save &
   * Next only when there is a next row — and a hand-kept list is one that will
   * one day be missing the button someone just added. Disabled buttons (a save
   * in flight) are skipped: the browser will not focus them anyway.
   *
   * Tab still reaches every button exactly as it did. These arrows are a
   * shorter way round for anyone who knows them, not the only way in.
   */
  const moveAlongStrip = useCallback((e: React.KeyboardEvent<HTMLDivElement>): boolean => {
    const container = stripRef.current;
    if (!container || !(e.target instanceof Element)) return false;
    const from = e.target.closest('button');
    if (!from || !container.contains(from)) return false;
    const buttons = Array.from(container.querySelectorAll('button')).filter(b => !b.disabled);
    const to = nextStripButtonIndex(buttons.indexOf(from), buttons.length, e.key);
    if (to === null) return false;
    // Claimed, not merely acted on: an unclaimed ArrowRight scrolls the table
    // sideways under the editor the user is looking at.
    e.preventDefault();
    e.stopPropagation();
    buttons[to].focus();
    return true;
  }, []);

  return (
    // data-quick-edit: the register's own keyboard stands down for anything
    // inside the editor (see isInsideQuickEdit) — Space on Save must press the
    // button, not reconcile the row.
    //
    // Drawn as the bottom half of the highlighted row's card: the same #6B86B3
    // border the register wears, square at the top and rounded at the foot, and
    // pulled up by the 4px vertical margin the selected row carries
    // (.selected-transaction-row) so the two meet rather than float apart.
    //
    // The wash and .selected-transaction-row's are ONE colour — one card, across
    // the join and across the width. Change one and change the other.
    //
    // It is navy-400 now, not the stock blue (Claude Design, 28 Aug 2026). Which
    // token: `bg-primary/10` is the ruled selected wash, but #1a2332 at 10% over
    // white composites to #E8E9EA — a grey step the eye reads as a seam against
    // the row above. navy-400 is #6B86B3, and it is already THIS card's
    // selection colour twice over: the strip's own border-[#6B86B3]/60 below,
    // and .selected-transaction-row's rgba(107,134,179,·) ring. At 10% it
    // composites to #F0F3F7 against the row's #F2F8FF, which is no seam at all.
    //
    // The other half moved with it: `.selected-transaction-row` in index.css now
    // carries `rgba(107,134,179,.1)` / `rgba(107,134,179,.25)`, the same two
    // navy-400 alphas. It was the last live blue in the app and the hardest to
    // find — raw rgba in a stylesheet, which the `no-restricted-syntax` ban
    // cannot see (it reads TypeScript string literals) and no class-name grep
    // matches. If this wash ever changes, that rule is the other half of it.
    <div
      ref={stripRef}
      data-quick-edit="actions"
      onKeyDown={(e) => {
        // The arrows first, and only if they were the strip's: everything else
        // — Enter, Escape — is the editor's own, unchanged.
        if (moveAlongStrip(e)) return;
        handleKeyDown(e);
      }}
      className={layout === 'card'
        ? 'relative z-20 flex flex-wrap items-center justify-end gap-2 px-3 py-2 rounded-xl border border-[#6B86B3]/60 bg-white/70 dark:bg-gray-800/70'
        : 'relative z-20 -mt-1 h-full flex items-center justify-between gap-3 px-3 rounded-b-xl border-x border-b border-[#6B86B3]/60 bg-navy-400/10 dark:bg-navy-400/25 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.12)]'}
    >
      {transferPrompt ? (
        /* The whole strip becomes the question, so nothing is competing with
           it and nothing has moved: the same 36px, the same place, the same
           arrow keys along the same buttons. `role="group"` with a name, and
           aria-live, because the strip changed under a keyboard user without
           anything on screen having moved. */
        <>
          <span
            className={layout === 'card'
              ? 'basis-full text-xs font-normal text-gray-700 dark:text-gray-300'
              : 'min-w-0 truncate text-[11px] font-normal text-gray-700 dark:text-gray-300'}
            aria-live="polite"
          >
            {transferPrompt.candidates.length === 0
              ? `Nothing matching in ${transferPrompt.targetAccountName} — create the other side there?`
              : transferPrompt.candidates[0].crossCurrency
                /* A converted pair: the two figures WILL NOT match, and the
                   strip has to say why before the user presses Link. Both
                   currencies are named beside their own amount — see
                   utils/crossCurrencyLabel. */
                ? `${amountWithCurrencyCode(transaction.amount, transferPrompt.candidates[0].crossCurrency.from)} here against ${amountWithCurrencyCode(transferPrompt.candidates[0].transaction.amount, transferPrompt.candidates[0].crossCurrency.to)} in ${transferPrompt.targetAccountName} — different currencies; link the two sides?`
                : `Found the matching transaction in ${transferPrompt.targetAccountName} — link the two sides?`}
          </span>
          <div
            className="flex shrink-0 items-center gap-2"
            role="group"
            aria-label={`Make this a transfer with ${transferPrompt.targetAccountName}`}
          >
            {transferPrompt.candidates.length > 0 && (
              <button
                type="button"
                ref={promptDefaultRef}
                onClick={() => linkTransfer(transferPrompt.candidates[0].transaction.id)}
                disabled={isSaving}
                className="px-3 h-[28px] inline-flex items-center justify-center text-xs font-medium bg-[#1a2332] text-white rounded-lg hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                title={`Join this row to "${transferPrompt.candidates[0].transaction.description}" in ${transferPrompt.targetAccountName}. Nothing is created and no balance moves — both rows already exist.`}
              >
                {isSaving ? 'Linking…' : 'Link'}
              </button>
            )}
            <button
              type="button"
              // The default answer when there is nothing to link to. Only one of
              // the two ever holds this ref, so the cursor always lands on the
              // action that is right for what was found.
              ref={transferPrompt.candidates.length > 0 ? undefined : promptDefaultRef}
              onClick={createTransfer}
              disabled={isSaving}
              className={`px-3 h-[28px] inline-flex items-center justify-center text-xs font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap ${
                transferPrompt.candidates.length > 0
                  ? 'bg-[#2d3a4d] text-white hover:bg-[#3a4a5f]'
                  : 'bg-[#1a2332] text-white hover:bg-secondary'
              }`}
              title={`Add a new transaction in ${transferPrompt.targetAccountName} for the other half. This moves that account's balance.`}
            >
              {isSaving ? 'Creating…' : 'Create the other side'}
            </button>
            <button
              type="button"
              onClick={cancelTransferPrompt}
              disabled={isSaving}
              className="px-3 h-[28px] inline-flex items-center justify-center text-xs font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-white/60 dark:hover:bg-gray-700/60 disabled:opacity-50"
              title="Leave it as it was — the date and description you just saved are kept, and nothing becomes a transfer"
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
      <>
      {/* The rhythm nobody would guess, said where it is used, and said as
          consequences rather than key names. One line: the strip is as wide as
          the register, so what used to wrap in a narrow column now reads
          straight across. The printed list (? or View ▸ Keyboard shortcuts)
          carries the rest.

          It changes on the last row because there is nothing to move on to
          there, and a hint that promises a move that cannot happen is worse
          than no hint at all. */}
      {layout === 'row' && (
        <span className="min-w-0 truncate text-[11px] font-normal text-gray-500 dark:text-gray-400">
          {hasNext
            ? 'Enter accepts · Enter again saves & moves on · Esc closes'
            : 'Enter accepts · Enter again saves · Esc closes'}
        </span>
      )}

      <div className="flex shrink-0 items-center gap-2">
        {/* The guess, and the one click that agrees with it. The badge says in
            words what the amber says in colour — the register's own Category
            column carries the identical one on rows that are not being edited,
            so nothing changes meaning as an editor opens. */}
        {/* The ledger's proposal that this row is a transfer, worn as the same
            badge the guessed category wears, because to the user it is the
            same kind of thing: the app's reading of what they filed before.
            No Confirm beside it — a transfer is committed by the save that
            asks match-or-create, and a second button that skipped the
            question would write a pair nobody answered for. */}
        {showingTransferSuggestion && transferSuggestion && (
          <SuggestedCategoryBadge
            size="field"
            title={`The app proposes a transfer from what you have filed before: ${formatCount(transferSuggestion.transfers)} of ${formatCount(transferSuggestion.transfers + transferSuggestion.otherwise)} rows worded like this in this account were transfers to ${transferTargets.find(a => a.id === transferSuggestion.targetAccountId)?.name ?? 'that account'}. Save to match or create the other side, or switch the toggle off to file it under a category instead.`}
          />
        )}
        {showingSuggestion && (
          <>
            <SuggestedCategoryBadge
              size="field"
              title="The app filled this in from what you have filed before. Confirm it, or pick a different category — either way it stops being a guess. Left alone it stays as it is and still counts in your reports."
            />
            <button
              type="button"
              ref={confirmButtonRef}
              onClick={confirmSuggestion}
              disabled={isSaving}
              className="px-3 h-[28px] inline-flex items-center justify-center text-xs font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              title="Agree with the suggested category. The description and notes as you have them are saved with it; the category and the amount do not change"
            >
              Confirm
            </button>
          </>
        )}
        {/* Save & Next FIRST, and in the darker primary, because it is the
            button this editor is really for: a statement is filed by making the
            same edit a hundred times, and this is the one the cursor lands on
            and the second Enter presses. Save sits beside it as the way to STOP
            — one row, done, back to the list. */}
        {hasNext && (
          <button
            type="button"
            ref={saveAndNextButtonRef}
            onClick={() => requestSave(true)}
            disabled={isSaving}
            className="px-3 h-[28px] inline-flex items-center justify-center text-xs font-medium bg-[#1a2332] text-white rounded-lg hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            title="Save and move to the next transaction, with the cursor back in the field you were last in (Enter)"
          >
            {savingAction === 'next' ? 'Saving…' : 'Save & Next'}
          </button>
        )}
        <button
          type="button"
          ref={saveButtonRef}
          onClick={() => requestSave(false)}
          disabled={isSaving}
          className="px-3 h-[28px] inline-flex items-center justify-center text-xs font-medium bg-[#2d3a4d] text-white rounded-lg hover:bg-[#3a4a5f] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          title="Save this transaction and stop editing — the list gets the keyboard back, on this row. From Save & Next, the right arrow reaches this button."
        >
          {savingAction === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="h-[28px] w-[28px] inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-white/60 dark:hover:bg-gray-700/60"
          aria-label="Stop editing this row"
          title="Stop editing this row (Esc) — it stays highlighted"
        >
          <XIcon size={14} />
        </button>
      </div>
      </>
      )}
    </div>
  );
}
