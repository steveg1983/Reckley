/**
 * DuplicateSweepModal — the delete tool, through the UI.
 *
 * What these pin is everything that makes a DELETE safe to hand to a user:
 * nothing is pre-selected, the consequence is on screen before the button
 * works, a row that is holding a transfer or a split together cannot be chosen
 * at all, a refusal can be made to stick — and a pair the scan found only
 * because the money and the day agree cannot reach the delete at all until the
 * user has said, about that one pair, that they are the same payment.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import DuplicateSweepModal from './DuplicateSweepModal';
import { __setAppContextValue, __resetAppContextValue } from '../test/mocks/AppContextSupabase';
import { duplicateDismissalKey } from '../utils/suggestionDismissals';
import type { Account, Category, SuggestionDismissal, Transaction } from '../types';

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn(),
    showSuccess: vi.fn(),
    showError: vi.fn(),
    showWarning: vi.fn(),
    showInfo: vi.fn(),
    dismissToast: vi.fn(),
  }),
}));

vi.mock('../hooks/useCurrencyDecimal', () => ({
  useCurrencyDecimal: () => ({
    formatCurrency: (amount: number) =>
      Number(amount) < 0
        ? `(£${Math.abs(Number(amount)).toFixed(2)})`
        : `£${Number(amount).toFixed(2)}`,
    displayCurrency: 'GBP',
    getCurrencySymbol: () => '£',
    convert: vi.fn(),
    convertAndFormat: vi.fn(),
    convertAndSum: vi.fn(),
  }),
}));

vi.mock('../hooks/useAccountNames', () => ({
  useAccountNames: () => (id: string) => ({
    'acc-current': 'Current account',
    'acc-joint': 'Joint account',
    'acc-zenith': 'Zenith Current',
    'acc-alder': 'Alder Current',
    'acc-plum': 'Plum Card',
  }[id] ?? id),
}));

const txn = (over: Partial<Transaction> & { id: string }): Transaction => ({
  date: new Date('2026-05-01'),
  amount: -49.99,
  description: 'TESCO STORES 3421',
  category: 'cat-food',
  accountId: 'acc-current',
  type: 'expense',
  ...over,
});

const CATEGORIES: Category[] = [
  { id: 'cat-food', name: 'Groceries', type: 'expense', level: 'detail' },
];

/** The commonest real case: a bank feed and an import of the same payment. */
const FEED = txn({ id: 'feed', cleared: true });
const IMPORTED = txn({ id: 'import', isImported: true });

/**
 * The pair the old scoring could never see: the user renamed the payee, so the
 * two rows share not one word. Same account, same day, same money to the penny
 * is all that is left of the evidence.
 */
const RENAMED = txn({ id: 'renamed', amount: -410, description: 'Nadia' });
const AS_IMPORTED = txn({
  id: 'as-imported',
  amount: -410,
  isImported: true,
  description: 'Immediate Faster Payment (Online) to B EXAMPLE 07-FEB-2027',
});

const CONFIRMATION = 'I have read both rows and they are one payment recorded twice.';

/** Invented accounts, deliberately NOT in alphabetical or section order. */
const account = (id: string, name: string, type: Account['type']): Account => ({
  id, name, type, balance: 0, currency: 'GBP', lastUpdated: new Date('2026-05-01'),
});

const onClose = vi.fn();

/** Where the router ended up, so a jump can be read rather than assumed. */
function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

const whereWeAre = (): string => screen.getByTestId('location').textContent ?? '';

const renderModal = (startAt = '/settings/data'): void => {
  render(
    <MemoryRouter initialEntries={[startAt]}>
      <DuplicateSweepModal isOpen onClose={onClose} />
      <LocationProbe />
    </MemoryRouter>
  );
};

const openReview = (): void => {
  fireEvent.click(screen.getByTitle('Look at both copies of this'));
};

afterEach(() => {
  cleanup();
  onClose.mockClear();
  __resetAppContextValue();
});

describe('DuplicateSweepModal — finding the same payment twice', () => {
  beforeEach(() => {
    __setAppContextValue({ transactions: [FEED, IMPORTED], categories: CATEGORIES });
  });

  it('lists the pair with the evidence that makes it judgeable', () => {
    renderModal();

    const row = screen.getByTitle('Look at both copies of this');
    expect(within(row).getByText('TESCO STORES 3421')).toBeInTheDocument();
    expect(within(row).getByText('Current account')).toBeInTheDocument();
    // Signed now, the house amount idiom — an expense pair says so at a glance.
    expect(within(row).getByText('\u2212£49.99')).toBeInTheDocument();
    expect(within(row).getByText('100% alike')).toBeInTheDocument();
  });

  it('pre-selects nothing, and will not delete until a copy is chosen', () => {
    renderModal();
    openReview();

    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).not.toBeChecked();
    }
    expect(screen.getByRole('button', { name: 'Delete the copy I chose' })).toBeDisabled();
    expect(screen.getByText(/Pick one and this will say exactly what deleting it does/)).toBeInTheDocument();
  });

  it('says what deleting the chosen copy does BEFORE the button works', () => {
    renderModal();
    openReview();

    fireEvent.click(screen.getAllByRole('radio')[0]);

    // The consequence, in the house voice: the balance moving is the point.
    expect(screen.getByText(/deleted for good/)).toBeInTheDocument();
    expect(screen.getByText(/Current account’s balance goes up by £49.99/)).toBeInTheDocument();
    expect(screen.getByText(/The other copy stays exactly as it is/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete the copy I chose' })).toBeEnabled();
  });

  it('deletes only the copy that was chosen', async () => {
    const deleteTransaction = vi.fn(async () => {});
    __setAppContextValue({ deleteTransaction });
    renderModal();
    openReview();

    fireEvent.click(screen.getAllByRole('radio')[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete the copy I chose' }));

    await waitFor(() => expect(deleteTransaction).toHaveBeenCalledTimes(1));
    expect(deleteTransaction).toHaveBeenCalledWith('import');
  });
});

describe('DuplicateSweepModal — the tally of what is left', () => {
  it('names how many suggestions remain, at the top where the work starts', async () => {
    __setAppContextValue({ transactions: [FEED, IMPORTED], categories: CATEGORIES });
    renderModal();
    // The number and its words share one line but not one element.
    expect(
      await screen.findByText(
        (_, element) => element?.tagName === 'P' && element.textContent === '1 suggestion left'
      )
    ).toBeInTheDocument();
  });

  it('says nothing at zero — the empty state already says it in words', async () => {
    __setAppContextValue({ transactions: [FEED], categories: CATEGORIES });
    renderModal();
    expect(await screen.findByText(/Nothing looks like the same payment twice/)).toBeInTheDocument();
    expect(screen.queryByText(/suggestions? left/)).not.toBeInTheDocument();
  });
});

describe('DuplicateSweepModal — the pair whose payee was renamed', () => {
  beforeEach(() => {
    __setAppContextValue({ transactions: [RENAMED, AS_IMPORTED], categories: CATEGORIES });
  });

  it('lists it in its own section, and says what the evidence actually is', () => {
    renderModal();

    expect(screen.getByText('Same money, different wording — your call')).toBeInTheDocument();
    // Not a percentage dressed up as certainty: the wording agreeing is the
    // one thing this pair has NOT got, and the user is told so.
    const row = screen.getByTitle('Look at both copies of this');
    expect(within(row).getByText('Not one word in common')).toBeInTheDocument();
    expect(within(row).getByText('\u2212£410.00')).toBeInTheDocument();
  });

  it('will not delete on a chosen copy alone — the pair has to be confirmed', () => {
    renderModal();
    openReview();

    fireEvent.click(screen.getAllByRole('radio')[0]);

    const deleteButton = screen.getByRole('button', { name: 'Delete the copy I chose' });
    expect(deleteButton).toBeDisabled();
    expect(screen.getByText(/Tick the box above to say these two really are one payment/))
      .toBeInTheDocument();
    // The consequence is not shown yet either: nothing is going to happen.
    expect(screen.queryByText(/deleted for good/)).not.toBeInTheDocument();
  });

  it('enables the delete only once the user has said the two are one payment', () => {
    renderModal();
    openReview();

    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.click(screen.getByLabelText(CONFIRMATION));

    expect(screen.getByText(/deleted for good/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete the copy I chose' })).toBeEnabled();
  });

  it('confirming without choosing a copy still deletes nothing', () => {
    renderModal();
    openReview();

    fireEvent.click(screen.getByLabelText(CONFIRMATION));

    expect(screen.getByRole('button', { name: 'Delete the copy I chose' })).toBeDisabled();
    expect(screen.getByText(/Pick one and this will say exactly what deleting it does/))
      .toBeInTheDocument();
  });

  it('deletes exactly the copy chosen, once both answers are in', async () => {
    const deleteTransaction = vi.fn(async () => {});
    __setAppContextValue({ deleteTransaction });
    renderModal();
    openReview();

    // The imported copy goes and the renamed one — the row carrying the name
    // its owner will recognise — stays. Which of the two the scan happened to
    // call "first" is not the user's business.
    const copies = screen.getByRole('group', { name: 'Choose the copy to delete' });
    const importedCard = within(copies).getByText(AS_IMPORTED.description).closest('label');
    if (!importedCard) throw new Error('the imported copy should be a choosable card');
    fireEvent.click(within(importedCard).getByRole('radio'));
    fireEvent.click(screen.getByLabelText(CONFIRMATION));
    fireEvent.click(screen.getByRole('button', { name: 'Delete the copy I chose' }));

    await waitFor(() => expect(deleteTransaction).toHaveBeenCalledTimes(1));
    expect(deleteTransaction).toHaveBeenCalledWith('as-imported');
  });

  it('starts every pair unconfirmed — an answer about one pair is not an answer about the next', () => {
    __setAppContextValue({
      transactions: [
        RENAMED,
        AS_IMPORTED,
        txn({ id: 'other-renamed', amount: -88.5, description: 'Gym' }),
        txn({ id: 'other-imported', amount: -88.5, description: 'DD FITNESS GROUP 5521' }),
      ],
      categories: CATEGORIES,
    });
    renderModal();

    expect(screen.getAllByTitle('Look at both copies of this')).toHaveLength(2);
    fireEvent.click(screen.getAllByTitle('Look at both copies of this')[0]);
    fireEvent.click(screen.getByLabelText(CONFIRMATION));
    expect(screen.getByLabelText(CONFIRMATION)).toBeChecked();

    // Leave that pair alone and open the next one.
    fireEvent.click(screen.getByRole('button', { name: 'Not a duplicate — leave both' }));
    fireEvent.click(screen.getByTitle('Look at both copies of this'));

    expect(screen.getByLabelText(CONFIRMATION)).not.toBeChecked();
    fireEvent.click(screen.getAllByRole('radio')[0]);
    expect(screen.getByRole('button', { name: 'Delete the copy I chose' })).toBeDisabled();
  });
});

describe('DuplicateSweepModal — the bar has not moved', () => {
  it('a pair whose wording agrees deletes in exactly the steps it always did', async () => {
    // THE SAFETY TEST. Widening what the scan can SEE must not widen what a
    // user can destroy — and it must not put a new hoop in front of the pairs
    // that were always safe either.
    const deleteTransaction = vi.fn(async () => {});
    __setAppContextValue({
      transactions: [FEED, IMPORTED], categories: CATEGORIES, deleteTransaction,
    });
    renderModal();
    openReview();

    expect(screen.queryByLabelText(CONFIRMATION)).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete the copy I chose' }));

    await waitFor(() => expect(deleteTransaction).toHaveBeenCalledWith('feed'));
  });

  it('offers nothing that could DELETE a pair the user has not opened', () => {
    // The invariant this has always guarded, said precisely: no list-level
    // route to a delete. The only way to destroy a row is through one pair's
    // review, radio-chosen, and the wider tier adds a confirmation on top.
    // The list DID gain ticks on 1 Sep 2026 — the owner's bulk "These are
    // not duplicates" over a two-thousand-suggestion backlog — but a refusal
    // deletes nothing, moves no balance, and stays restorable, so the line
    // holds: nothing the ticks reach can lose money.
    __setAppContextValue({
      transactions: [FEED, IMPORTED, RENAMED, AS_IMPORTED], categories: CATEGORIES,
    });
    renderModal();

    expect(screen.getAllByTitle('Look at both copies of this')).toHaveLength(2);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(/delete|remove/i);
    }
  });

  it('"Select all in view" ticks what is on screen, and pressing again after scrolling ADDS the next ones', () => {
    // The owner, 15 Nov 2026. jsdom has no layout, so each row is placed by
    // hand: the first on screen, the second below the fold until "scrolled".
    __setAppContextValue({
      transactions: [FEED, IMPORTED, RENAMED, AS_IMPORTED], categories: CATEGORIES,
    });
    renderModal();
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const place = (row: Element, top: number): void => {
      (row as HTMLElement).getBoundingClientRect = () => ({
        top, bottom: top + 40, height: 40, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}),
      });
    };
    const rows = Array.from(document.querySelectorAll('[data-pair-key]'));
    expect(rows).toHaveLength(2);
    place(rows[0], 200);
    place(rows[1], 2000);

    fireEvent.click(screen.getByRole('button', { name: 'Select all in view' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    place(rows[0], -500);
    place(rows[1], 300);
    fireEvent.click(screen.getByRole('button', { name: 'Select all in view' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('the bulk ticks refuse — they warn first, persist refusals, and can delete nothing', async () => {
    // The owner's nuclear button (1 Sep 2026: "save me going through over
    // 2000!"): select-all, one press, one warning that genuine duplicates
    // among the selection are refused too — and the only writes are
    // dismissals. deleteTransaction staying uncalled IS the safety property.
    const deleteTransaction = vi.fn(async () => {});
    const dismissSuggestion = vi.fn(async () => {});
    __setAppContextValue({
      transactions: [FEED, IMPORTED, RENAMED, AS_IMPORTED], categories: CATEGORIES,
      deleteTransaction, dismissSuggestion,
    });
    renderModal();

    fireEvent.click(screen.getByLabelText(/Select all 2 suggestions/));
    fireEvent.click(screen.getByRole('button', { name: 'These are not duplicates' }));

    // The warning says the whole of it before anything happens.
    expect(screen.getByText(/including any that genuinely are/)).toBeInTheDocument();
    expect(screen.getByText(/individually restorable/)).toBeInTheDocument();

    const confirmButtons = screen.getAllByRole('button', { name: 'These are not duplicates' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => expect(dismissSuggestion).toHaveBeenCalledTimes(2));
    expect(deleteTransaction).not.toHaveBeenCalled();
    // Off the list the moment the judgment was made.
    expect(screen.queryByTitle('Look at both copies of this')).not.toBeInTheDocument();
  });

  it('will not delete a row the wider rule found once its copy is chosen and unconfirmed, however the button is pressed', async () => {
    // The disabled attribute is a hint to a mouse. The handler asks the same
    // gate again, so a click that reaches it anyway still does nothing.
    const deleteTransaction = vi.fn(async () => {});
    __setAppContextValue({
      transactions: [RENAMED, AS_IMPORTED], categories: CATEGORIES, deleteTransaction,
    });
    renderModal();
    openReview();
    fireEvent.click(screen.getAllByRole('radio')[0]);

    const deleteButton = screen.getByRole('button', { name: 'Delete the copy I chose' });
    deleteButton.removeAttribute('disabled');
    fireEvent.click(deleteButton);

    await waitFor(() => expect(screen.getByText(/Tick the box above/)).toBeInTheDocument());
    expect(deleteTransaction).not.toHaveBeenCalled();
  });
});

describe('DuplicateSweepModal — every account in one sweep', () => {
  it('sweeps accounts the user has not visited, and lets them take one at a time', () => {
    __setAppContextValue({
      transactions: [
        FEED,
        IMPORTED,
        txn({ id: 'joint-a', accountId: 'acc-joint', amount: -410, description: 'Nadia' }),
        txn({
          id: 'joint-b',
          accountId: 'acc-joint',
          amount: -410,
          description: 'Immediate Faster Payment (Online) to B EXAMPLE',
        }),
      ],
      categories: CATEGORIES,
    });
    renderModal();

    expect(screen.getAllByTitle('Look at both copies of this')).toHaveLength(2);
    expect(screen.getByText('Current account')).toBeInTheDocument();
    expect(screen.getByText('Joint account')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Account/), { target: { value: 'acc-joint' } });

    const rows = screen.getAllByTitle('Look at both copies of this');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText('Joint account')).toBeInTheDocument();
  });

  it('offers no account chooser when everything found is in one account', () => {
    // Nothing to say, so nothing rendered.
    __setAppContextValue({ transactions: [FEED, IMPORTED], categories: CATEGORIES });
    renderModal();

    expect(screen.queryByLabelText(/Account/)).not.toBeInTheDocument();
  });
});

describe('DuplicateSweepModal — the account chooser is grouped like the rest of the app', () => {
  const GROUPED_ACCOUNTS: Account[] = [
    // Deliberately out of order, and with the credit card in the middle: the
    // dropdown's order must come from the grouping, not from this array.
    account('acc-zenith', 'Zenith Current', 'current'),
    account('acc-plum', 'Plum Card', 'credit'),
    account('acc-alder', 'Alder Current', 'current'),
  ];

  const pairIn = (accountId: string, amount: number): Transaction[] => [
    txn({ id: `${accountId}-a`, accountId, amount }),
    txn({ id: `${accountId}-b`, accountId, amount, isImported: true }),
  ];

  beforeEach(() => {
    __setAppContextValue({
      accounts: GROUPED_ACCOUNTS,
      categories: CATEGORIES,
      transactions: [
        ...pairIn('acc-zenith', -12.5),
        ...pairIn('acc-plum', -33.75),
        ...pairIn('acc-alder', -64.2),
      ],
    });
  });

  const chooser = (): HTMLSelectElement => screen.getByLabelText<HTMLSelectElement>(/Account/);

  const bandLabels = (): string[] =>
    Array.from(chooser().querySelectorAll('optgroup')).map(band => band.label);

  const namesUnder = (label: string): string[] => {
    const band = Array.from(chooser().querySelectorAll('optgroup')).find(g => g.label === label);
    return band ? Array.from(band.querySelectorAll('option')).map(o => o.textContent ?? '') : [];
  };

  it('bands the accounts into the app’s own sections, in the app’s own order', () => {
    renderModal();

    expect(bandLabels()).toEqual(['Current Accounts', 'Credit Cards']);
  });

  it('sorts alphabetically inside a band, whatever order the sweep found them in', () => {
    renderModal();

    // Zenith is first in the data and last on screen. That is the whole point.
    expect(namesUnder('Current Accounts')).toEqual(['Alder Current (1)', 'Zenith Current (1)']);
  });

  it('keeps “All accounts” outside the bands, as the way back to everything', () => {
    renderModal();

    const first = chooser().querySelector('option');
    expect(first?.textContent).toBe('All accounts');
    expect(first?.closest('optgroup')).toBeNull();
  });

  it('still filters to the account chosen out of a band', () => {
    renderModal();

    fireEvent.change(chooser(), { target: { value: 'acc-plum' } });

    const rows = screen.getAllByTitle('Look at both copies of this');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText('Plum Card')).toBeInTheDocument();
  });
});

describe('DuplicateSweepModal — rows that must not be deleted', () => {
  it('refuses half of a linked transfer, and says which account would be stranded', () => {
    __setAppContextValue({
      transactions: [
        txn({ id: 'leg', type: 'transfer', linkedTransferId: 'far-side', transferAccountId: 'acc-joint' }),
        IMPORTED,
      ],
      categories: CATEGORIES,
    });
    renderModal();
    openReview();

    expect(screen.getByText(/one half of a linked transfer with Joint account/)).toBeInTheDocument();
    // The blocked copy cannot be chosen; the other one still can.
    const [blocked, free] = screen.getAllByRole('radio');
    expect(blocked).toBeDisabled();
    expect(free).toBeEnabled();
  });

  it('refuses the counterpart of a split line', () => {
    __setAppContextValue({
      transactions: [
        txn({ id: 'line-side', type: 'transfer', linkedTransferId: 'parent', linkedTransferSplitId: 'line-1' }),
        IMPORTED,
      ],
      categories: CATEGORIES,
    });
    renderModal();
    openReview();

    expect(screen.getByText(/the other side of one LINE inside a split transaction/)).toBeInTheDocument();
    expect(screen.getAllByRole('radio')[0]).toBeDisabled();
  });

  it('refuses a split parent', () => {
    __setAppContextValue({
      transactions: [txn({ id: 'parent', isSplit: true }), IMPORTED],
      categories: CATEGORIES,
    });
    renderModal();
    openReview();

    expect(screen.getByText(/split into lines/)).toBeInTheDocument();
    expect(screen.getAllByRole('radio')[0]).toBeDisabled();
  });

  it('offers no delete at all when both copies are holding something together', () => {
    __setAppContextValue({
      transactions: [
        txn({ id: 'leg-a', type: 'transfer', linkedTransferId: 'far-a', transferAccountId: 'acc-joint' }),
        txn({ id: 'leg-b', type: 'transfer', linkedTransferId: 'far-b', transferAccountId: 'acc-joint' }),
      ],
      categories: CATEGORIES,
    });
    renderModal();
    openReview();

    expect(screen.getByText(/Neither of these can be deleted from here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete the copy I chose' })).toBeDisabled();
  });
});

describe('DuplicateSweepModal — refusing a suggestion', () => {
  beforeEach(() => {
    __setAppContextValue({ transactions: [FEED, IMPORTED], categories: CATEGORIES });
  });

  it('refusing IS the judgment: one press, remembered, against a canonical key', async () => {
    // No follow-up question (owner, 29 Aug: "under what circumstance would
    // you say it's not a duplicate but ask me again?"). Safe as one step
    // because the refusal is restorable from "Dismissed suggestions".
    const dismissSuggestion = vi.fn(async () => {});
    __setAppContextValue({ dismissSuggestion });
    renderModal();
    openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Not a duplicate — leave both' }));

    await waitFor(() => expect(dismissSuggestion).toHaveBeenCalledTimes(1));
    expect(dismissSuggestion).toHaveBeenCalledWith(
      'duplicate',
      // Sorted, so the same two rows produce this key whichever way round a
      // later scan reaches them.
      'feed|import',
      ['feed', 'import']
    );
    // And the pair is gone from the sitting's list in the same breath.
    expect(screen.queryByTitle('Look at both copies of this')).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing looks like the same payment twice/)).toBeInTheDocument();
  });

  it('closing the review without answering decides nothing', async () => {
    // The no-commitment path: the X. Nothing written, nothing dropped.
    const dismissSuggestion = vi.fn(async () => {});
    __setAppContextValue({ dismissSuggestion });
    renderModal();
    openReview();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close modal' })[1]);

    expect(dismissSuggestion).not.toHaveBeenCalled();
    expect(screen.getByTitle('Look at both copies of this')).toBeInTheDocument();
  });
});

describe('DuplicateSweepModal — one judgment covers the repeated payment, not one pairing of it', () => {
  // Three identical taps — the owner's Alicante coffees (29 Aug). The scan
  // seeds a group and emits overlapping pairs of the SAME rows; refusing one
  // pair and being offered the next was the system re-litigating a judgment
  // it had just been given. Every figure is invented: this repo is public.
  const TAP_1 = txn({ id: 'tap-1', amount: -1.29, description: 'Coffee kiosk' });
  const TAP_2 = txn({ id: 'tap-2', amount: -1.29, description: 'Coffee kiosk' });
  const TAP_3 = txn({ id: 'tap-3', amount: -1.29, description: 'Coffee kiosk' });
  // A different repeated payment in the same account: no shared row, so the
  // judgment about the coffees must not touch it.
  const GYM_A = txn({ id: 'gym-a', amount: -32, description: 'DD FITNESS GROUP' });
  const GYM_B = txn({ id: 'gym-b', amount: -32, description: 'DD FITNESS GROUP' });

  beforeEach(() => {
    __setAppContextValue({
      transactions: [TAP_1, TAP_2, TAP_3, GYM_A, GYM_B],
      categories: CATEGORIES,
    });
  });

  it('one refusal drops and remembers every pairing of those rows — the unrelated pair stays', async () => {
    const dismissSuggestion = vi.fn(async () => {});
    __setAppContextValue({ dismissSuggestion });
    renderModal();
    // Two coffee pairings (tap-1/tap-2, tap-1/tap-3) and one gym pairing.
    expect(screen.getAllByTitle('Look at both copies of this')).toHaveLength(3);

    fireEvent.click(screen.getAllByTitle('Look at both copies of this')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Not a duplicate — leave both' }));

    // Both coffee pairings are gone from the sitting at once…
    await waitFor(() =>
      expect(screen.getAllByTitle('Look at both copies of this')).toHaveLength(1)
    );
    expect(screen.getByText('DD FITNESS GROUP')).toBeInTheDocument();
    expect(screen.queryByText('Coffee kiosk')).not.toBeInTheDocument();

    // …and each is its own restorable refusal in the store.
    await waitFor(() => expect(dismissSuggestion).toHaveBeenCalledTimes(2));
    expect(dismissSuggestion).toHaveBeenCalledWith('duplicate', 'tap-1|tap-2', ['tap-1', 'tap-2']);
    expect(dismissSuggestion).toHaveBeenCalledWith('duplicate', 'tap-1|tap-3', ['tap-1', 'tap-3']);
    // The gym pair was never part of the judgment.
    expect(dismissSuggestion).not.toHaveBeenCalledWith(
      'duplicate', 'gym-a|gym-b', expect.anything()
    );
  });
});

describe('DuplicateSweepModal — dismissals that stick', () => {
  const dismissal: SuggestionDismissal = {
    id: 'd1',
    kind: 'duplicate',
    subjectKey: duplicateDismissalKey(FEED, IMPORTED),
    subjectIds: ['feed', 'import'],
    dismissedAt: new Date('2026-06-01'),
  };

  it('never offers a pair the user has dismissed', () => {
    __setAppContextValue({
      transactions: [FEED, IMPORTED], categories: CATEGORIES,
      suggestionDismissals: [dismissal],
    });
    renderModal();

    expect(screen.queryByTitle('Look at both copies of this')).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing looks like the same payment twice/)).toBeInTheDocument();
  });

  it('offers it again the moment the same rows come back the other way round', () => {
    // The scan order flipped (the import is seeded first this time). The
    // dismissal must still match — this is the whole point of the sorted key.
    __setAppContextValue({
      transactions: [IMPORTED, FEED], categories: CATEGORIES,
      suggestionDismissals: [dismissal],
    });
    renderModal();

    expect(screen.queryByTitle('Look at both copies of this')).not.toBeInTheDocument();
  });

  it('lists what was dismissed and puts it back on request', async () => {
    const restoreSuggestion = vi.fn(async () => {});
    __setAppContextValue({
      transactions: [FEED, IMPORTED], categories: CATEGORIES,
      suggestionDismissals: [dismissal], restoreSuggestion,
    });
    renderModal();

    expect(screen.getByText('Dismissed suggestions')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByText('Not a duplicate')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restoreSuggestion).toHaveBeenCalledWith('duplicate', 'feed|import'));
  });

  it('says so plainly when the rows a dismissal named have since been deleted', () => {
    __setAppContextValue({
      transactions: [], categories: CATEGORIES, suggestionDismissals: [dismissal],
    });
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));

    expect(screen.getByText('The transactions this was about are no longer in your register.'))
      .toBeInTheDocument();
  });

  it('holds the list back until the dismissals have been read', () => {
    __setAppContextValue({
      transactions: [FEED, IMPORTED], categories: CATEGORIES,
      suggestionDismissalsStatus: 'loading',
    });
    renderModal();

    // Never show a suggestion and then snatch it away — that IS the complaint.
    expect(screen.queryByTitle('Look at both copies of this')).not.toBeInTheDocument();
    expect(screen.getByText('Checking which of these you have already dealt with…')).toBeInTheDocument();
  });

  it('shows everything, and says the filter did not run, when it could not be read', () => {
    __setAppContextValue({
      transactions: [FEED, IMPORTED], categories: CATEGORIES,
      suggestionDismissalsStatus: 'error',
    });
    renderModal();

    expect(screen.getByTitle('Look at both copies of this')).toBeInTheDocument();
    expect(screen.getByText(/could not be read, so this list may include some of them/)).toBeInTheDocument();
  });
});

describe('DuplicateSweepModal — the way through to the row itself', () => {
  const firstCopyLink = (): HTMLElement =>
    screen.getByRole('button', { name: 'See the first copy in Current account' });

  beforeEach(() => {
    __setAppContextValue({ transactions: [FEED, IMPORTED], categories: CATEGORIES });
  });

  it('lands on the register for that exact row, with the sweep closed behind it', () => {
    renderModal();
    openReview();

    fireEvent.click(firstCopyLink());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(whereWeAre()).toBe('/accounts/acc-current?txn=feed');
  });

  it('gives each copy its own way in, pointing at its own row', () => {
    renderModal();
    openReview();

    fireEvent.click(screen.getByRole('button', { name: 'See the second copy in Current account' }));

    expect(whereWeAre()).toBe('/accounts/acc-current?txn=import');
  });

  it('looking at a copy is not choosing it for deletion', () => {
    // THE DISTINCTNESS TEST. The way in sits outside the label the radio is
    // in, so a click meaning "let me see this" cannot arm the delete.
    renderModal();
    openReview();

    fireEvent.click(firstCopyLink());

    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).not.toBeChecked();
    }
  });

  it('still offers the way in for a copy that may never be deleted', () => {
    // The user whose row is holding a transfer together has to go and unpick
    // it — which means getting to it.
    __setAppContextValue({
      transactions: [
        txn({ id: 'leg', type: 'transfer', linkedTransferId: 'far-side', transferAccountId: 'acc-joint' }),
        IMPORTED,
      ],
      categories: CATEGORIES,
    });
    renderModal();
    openReview();

    expect(screen.getAllByRole('radio')[0]).toBeDisabled();
    fireEvent.click(firstCopyLink());

    expect(whereWeAre()).toBe('/accounts/acc-current?txn=leg');
  });

  it('offers the same way through from the list, without muddling the row click', () => {
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'See these two rows in Current account' }));

    // The register, not the review pane: the row's own click still means
    // "review", and this cell stops it reaching that handler.
    expect(whereWeAre()).toBe('/accounts/acc-current?txn=feed');
    expect(screen.queryByText('The same payment twice?')).not.toBeInTheDocument();
  });

  it('a jump taken in a demo session stays inside it', () => {
    renderModal('/settings/data?demo=true');
    openReview();

    fireEvent.click(firstCopyLink());

    expect(whereWeAre()).toBe('/accounts/acc-current?txn=feed&demo=true');
  });
});

describe('DuplicateSweepModal — how far apart two copies may be', () => {
  /** Same account, same money to the penny, same wording; only the gap moves. */
  const NEXT_DAY = [
    txn({ id: 'bakery-a', amount: -21.4, description: 'Bakery Ltd', date: new Date('2026-05-01') }),
    txn({ id: 'bakery-b', amount: -21.4, description: 'Bakery Ltd', date: new Date('2026-05-02') }),
  ];
  const TWO_DAYS = [
    txn({ id: 'cycles-a', amount: -77.3, description: 'Cycle Hire Ltd', date: new Date('2026-05-01') }),
    txn({ id: 'cycles-b', amount: -77.3, description: 'Cycle Hire Ltd', date: new Date('2026-05-03') }),
  ];

  beforeEach(() => {
    __setAppContextValue({ transactions: [...NEXT_DAY, ...TWO_DAYS], categories: CATEGORIES });
  });

  const windowChooser = (): HTMLSelectElement =>
    screen.getByLabelText<HTMLSelectElement>(/Within/);

  it('offers 1 day, and says “1 day” rather than “1 days”', () => {
    renderModal();

    expect(Array.from(windowChooser().options).map(o => o.textContent))
      .toEqual(['1 day', '3 days', '7 days', '14 days']);
  });

  it('starts at 3 days, where both of these pairs are within reach', () => {
    renderModal();

    expect(windowChooser().value).toBe('3');
    expect(screen.getByText('Bakery Ltd')).toBeInTheDocument();
    expect(screen.getByText('Cycle Hire Ltd')).toBeInTheDocument();
  });

  it('“within 1 day” means the same day or the one next to it — and no further', () => {
    renderModal();

    fireEvent.change(windowChooser(), { target: { value: '1' } });

    // One day apart is still inside the window…
    expect(screen.getByText('Bakery Ltd')).toBeInTheDocument();
    // …two days apart is not, and the label would be a lie if it were.
    expect(screen.queryByText('Cycle Hire Ltd')).not.toBeInTheDocument();
  });
});

/**
 * The round trip.
 *
 * The jump out to the register was one-way: Data Management unmounts this
 * dialog when it closes, so the sitting's window, account filter, sort order
 * and place in a three-hundred-row list went with it — and the browser's back
 * button returned to a settings page with no dialog on it at all. These cover
 * the two halves of the fix: what the trip out CARRIES, and what a trip back
 * RESTORES.
 */
describe('DuplicateSweepModal — leaving and coming back', () => {
  /** What the router was handed, so the crumbs can be read rather than assumed. */
  function StateProbe(): React.JSX.Element {
    const location = useLocation();
    return <div data-testid="state">{JSON.stringify(location.state)}</div>;
  }

  const carriedState = (): unknown => JSON.parse(screen.getByTestId('state').textContent || 'null');

  const renderWithProbe = (resume?: Parameters<typeof DuplicateSweepModal>[0]['resume']): void => {
    render(
      <MemoryRouter initialEntries={['/settings/data']}>
        <DuplicateSweepModal isOpen onClose={onClose} resume={resume} />
        <LocationProbe />
        <StateProbe />
      </MemoryRouter>
    );
  };

  beforeEach(() => {
    __setAppContextValue({ transactions: [FEED, IMPORTED], categories: CATEGORIES });
  });

  it('carries the way home, and where in the list the user was', () => {
    renderWithProbe();

    fireEvent.click(screen.getByRole('button', { name: 'See these two rows in Current account' }));

    expect(carriedState()).toEqual({
      from: {
        path: '/settings/data',
        label: 'Back to Find duplicates',
        resume: {
          tool: 'find-duplicates',
          windowDays: 3,
          accountFilter: '',
          sortKey: 'date',
          sortDir: -1,
          pairKey: duplicateDismissalKey(FEED, IMPORTED),
          reviewing: false,
        },
      },
    });
  });

  it('remembers the controls the user had set before they left', () => {
    renderWithProbe();

    // Named, because the phone's "Sort by" select is a second combobox.
    fireEvent.change(screen.getByRole('combobox', { name: /Within/ }), { target: { value: '7' } });
    fireEvent.click(screen.getByTitle('Sort by amount size'));
    fireEvent.click(screen.getByRole('button', { name: 'See these two rows in Current account' }));

    const state = carriedState();
    expect(state).toMatchObject({ from: { resume: { windowDays: 7, sortKey: 'amount' } } });
  });

  it('knows they left from inside the review, not from the list', () => {
    renderWithProbe();
    openReview();

    fireEvent.click(screen.getByRole('button', { name: 'See the first copy in Current account' }));

    expect(carriedState()).toMatchObject({ from: { resume: { reviewing: true } } });
  });

  it('comes back to the pair they jumped from, marked in the list', () => {
    renderWithProbe({
      tool: 'find-duplicates',
      windowDays: 3,
      accountFilter: '',
      sortKey: 'date',
      sortDir: -1,
      pairKey: duplicateDismissalKey(FEED, IMPORTED),
      reviewing: false,
    });

    const marked = screen.getByRole('row', { current: true });
    expect(marked).toHaveTextContent('TESCO STORES 3421');
    // The list, not the review: they left from the list.
    expect(screen.queryByText('The same payment twice?')).not.toBeInTheDocument();
  });

  it('comes back into the review when that is where they left from', async () => {
    renderWithProbe({
      tool: 'find-duplicates',
      windowDays: 3,
      accountFilter: '',
      sortKey: 'date',
      sortDir: -1,
      pairKey: duplicateDismissalKey(FEED, IMPORTED),
      reviewing: true,
    });

    expect(await screen.findByText('The same payment twice?')).toBeInTheDocument();
    // Nothing pre-selected: which copy to delete is a decision, and a decision
    // does not survive a trip to another page.
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).not.toBeChecked();
    }
  });

  it('comes back with the controls where they were', () => {
    renderWithProbe({
      tool: 'find-duplicates',
      windowDays: 7,
      accountFilter: '',
      sortKey: 'amount',
      sortDir: 1,
      pairKey: duplicateDismissalKey(FEED, IMPORTED),
      reviewing: false,
    });

    expect(screen.getByRole('combobox', { name: /Within/ })).toHaveValue('7');
    expect(screen.getByTitle('Sort by amount size')).toHaveTextContent('Amount ↑');
  });

  it('marks nothing when the dialog was opened the ordinary way', () => {
    renderWithProbe();

    expect(screen.queryAllByRole('row', { current: true })).toHaveLength(0);
  });
});
