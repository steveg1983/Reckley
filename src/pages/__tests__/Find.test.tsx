/**
 * FIND — Money's, not a second register.
 *
 * What this file pins down, in the order a user meets it:
 *
 *   nothing asked   the view says what Find is for rather than listing the
 *                   ledger;
 *   matching        a description, and an amount as a statement prints it;
 *   the row         click or Enter, and you are in that account's register on
 *                   that row — never in an editor here;
 *   the keyboard    the register's idiom: arrows walk, Enter opens, one tab
 *                   stop for the whole table;
 *   the cap         two hundred rows and the true total, not a paging
 *                   treadmill;
 *   the range       the Calendar's day, honoured, shown and clearable.
 *
 * Every name, date and figure below is invented: this repo is public.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PreferencesProvider } from '../../contexts/PreferencesContext';
import { __setAppContextValue, __resetAppContextValue } from '../../test/mocks/AppContextSupabase';
import Find, { FIND_ROW_SELECTED_CLASS } from '../Find';
import type { Account, Category, Transaction } from '../../types';

const CURRENT: Account = {
  id: 'acc-current', name: 'Everyday Current', type: 'current', balance: 0,
  currency: 'GBP', lastUpdated: new Date('2026-01-01'), openingBalance: 0, isActive: true,
};

const SAVINGS: Account = {
  id: 'acc-savings', name: 'Rainy Day Savings', type: 'savings', balance: 0,
  currency: 'GBP', lastUpdated: new Date('2026-01-01'), openingBalance: 0, isActive: true,
};

const CATEGORIES: Category[] = [
  { id: 'type-expense', name: 'Expenses', type: 'expense', level: 'type', isSystem: true },
  { id: 'grp-home', name: 'Home', type: 'expense', level: 'sub', parentId: 'type-expense' },
  { id: 'det-repairs', name: 'Repairs', type: 'expense', level: 'detail', parentId: 'grp-home' },
];

const base = {
  type: 'expense' as const,
  category: 'det-repairs',
  accountId: CURRENT.id,
  cleared: false,
};

/** Through a finalized reconciliation: the committed state. */
const RECONCILED_ROW: Transaction = {
  ...base, id: 'txn-reconciled', description: 'Halberd Ironmongers', amount: -141.5,
  date: new Date(Date.UTC(2026, 3, 1)), cleared: true, reconciled: true,
};

/** Ticked off against a statement, but nobody has pressed Finish. */
const MARKED_ROW: Transaction = {
  ...base, id: 'txn-marked', description: 'Pellam Tyres', amount: -87.2,
  date: new Date(Date.UTC(2026, 3, 2)), cleared: true, reconciled: false,
  accountId: SAVINGS.id,
};

/** Neither marked nor reconciled, and freshly imported. */
const NEW_ROW: Transaction = {
  ...base, id: 'txn-new', description: 'Wexford Bakery', amount: -141.5,
  date: new Date(Date.UTC(2026, 3, 3)), needsReview: true,
};

const ROWS = [RECONCILED_ROW, MARKED_ROW, NEW_ROW];

/** Whatever the router settled on, printed so a test can read it back. */
function WhereAmI(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="landed">{`${location.pathname}${location.search}`}</div>;
}

const openFind = (entry = '/find'): void => {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <PreferencesProvider>
        <Routes>
          <Route path="/find" element={<Find />} />
          <Route path="/accounts/:accountId" element={<WhereAmI />} />
        </Routes>
      </PreferencesProvider>
    </MemoryRouter>
  );
};

const box = (): HTMLElement => screen.getByLabelText('Find transactions by description or amount');

const type = (text: string): void => {
  fireEvent.change(box(), { target: { value: text } });
};

const results = (): HTMLElement => screen.getByRole('table', { name: 'Search results' });

/** The result line showing `description`. */
const row = (description: string): HTMLElement => {
  const cell = within(results()).getByText(description);
  const found = cell.closest('tr');
  if (!(found instanceof HTMLElement)) throw new Error(`no result row for "${description}"`);
  return found;
};

/** Is this row wearing the picked-out look? */
const isPickedOut = (line: HTMLElement): boolean =>
  FIND_ROW_SELECTED_CLASS.split(' ').filter(Boolean).every(u => line.classList.contains(u));

beforeEach(() => {
  localStorage.clear();
  __setAppContextValue({
    accounts: [CURRENT, SAVINGS],
    transactions: ROWS,
    categories: CATEGORIES,
    isLoading: false,
  });
});

afterEach(() => {
  __resetAppContextValue();
});

/**
 * Typing is debounced by a quarter of a second, so every assertion about what
 * the box produced is made through `waitFor`. Real timers deliberately: the
 * suite's setup pins the system clock, and a second fake-timer installation on
 * top of that is not something a test should be arguing with.
 */
const settle = async (description: string): Promise<void> => {
  await waitFor(() => expect(within(results()).getByText(description)).toBeInTheDocument());
};

describe('Find — before anything is asked', () => {
  it('says what it is for instead of listing the ledger', () => {
    openFind();

    // Not "everything": a Find that opened on the first 200 rows of the whole
    // history would be the global list this replaced, wearing a new name.
    expect(screen.getByText(/Find looks through every account at once/)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Search results' })).not.toBeInTheDocument();
  });
});

describe('Find — what it matches', () => {
  it('finds a row by part of its description', async () => {
    openFind();

    type('bakery');

    await settle('Wexford Bakery');
    expect(within(results()).queryByText('Pellam Tyres')).not.toBeInTheDocument();
  });

  it('finds rows by an amount written the way a statement prints it', async () => {
    openFind();

    // The half a substring cannot do: (-141.5).toString() is "-141.5", so
    // "141.50" — how the bank prints it — would find nothing without the
    // numeric rule. Both accounts' rows come back: Find is sign-agnostic and
    // account-agnostic, which is the entire point of it.
    type('141.50');

    await settle('Wexford Bakery');
    expect(within(results()).getByText('Halberd Ironmongers')).toBeInTheDocument();
    expect(within(results()).queryByText('Pellam Tyres')).not.toBeInTheDocument();
  });

  it('says so plainly when nothing matches — and says the rows are still there', async () => {
    openFind();

    type('ironmongers of nowhere');

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 3, name: 'No transactions match these filters' })
      ).toBeInTheDocument();
    });
    // THE COUNT AND THE CULPRIT. "Nothing matches X" told the user what did not
    // happen; on a page that searches every account at once, what they need to
    // know is that all of it is still there and this search is what is over it
    // (DESIGN_PASS §4).
    expect(screen.getByText(/are hidden by/)).toBeInTheDocument();
    expect(screen.getByText('Search: ironmongers of nowhere')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });

  it('shows the row the way the register does — C, R, the account, the bold', async () => {
    openFind();

    type('141.50');
    await settle('Wexford Bakery');

    // R for a reconciliation that finished; nothing at all for a row that is
    // neither. A cross-account list that disagreed with the register about
    // which is which would be worse than either.
    expect(within(row('Halberd Ironmongers')).getByTitle('Reconciled')).toHaveTextContent('R');
    expect(within(row('Wexford Bakery')).queryByTitle('Reconciled')).not.toBeInTheDocument();
    // Which account it was in — the question Find exists to answer.
    expect(within(row('Halberd Ironmongers')).getByText('Everyday Current')).toBeInTheDocument();
    // A row that arrived and has not been reviewed is bold, and says so in
    // words for anyone who cannot see weight.
    expect(within(row('Wexford Bakery')).getByText(/awaiting review/)).toBeInTheDocument();
  });

  it('marks a row that is ticked but not reconciled with C', async () => {
    openFind();

    type('Pellam');
    await settle('Pellam Tyres');

    const marked = within(row('Pellam Tyres'));
    expect(marked.getByTitle(/not reconciled until you finalise/)).toHaveTextContent('C');
    expect(marked.queryByTitle('Reconciled')).not.toBeInTheDocument();
  });
});

describe('Find — a result is a way into a register', () => {
  it('opens the row in its own account on a click', async () => {
    openFind();

    type('Pellam');
    await settle('Pellam Tyres');

    fireEvent.click(row('Pellam Tyres'));

    // The register's own deep link: it selects the row, centres it and docks
    // it in quick edit on arrival. Nothing is edited here.
    expect(screen.getByTestId('landed')).toHaveTextContent('/accounts/acc-savings?txn=txn-marked');
  });

  it('offers no way to edit anything from the list', async () => {
    openFind();

    type('141.50');
    await settle('Wexford Bakery');

    // No edit, no delete, no checkbox. Two lists that both edit must both grow
    // every feature forever, and one of them is always the poor relation —
    // which is exactly what the retired page was.
    expect(within(results()).queryByRole('button')).not.toBeInTheDocument();
    expect(within(results()).queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('Find — the keyboard', () => {
  const openThree = async (): Promise<void> => {
    openFind();
    type('e');
    await settle('Wexford Bakery');
  };

  it('lands on the row under the hand before it starts walking', async () => {
    await openThree();

    // With nothing highlighted, the first arrow is an ARRIVAL: it picks out
    // the row the key was pressed on. Jumping to a neighbour of nowhere would
    // move the user somewhere they had not looked. (The register and the
    // Accounts list both answer the empty selection the same way.)
    fireEvent.keyDown(row('Wexford Bakery'), { key: 'ArrowDown' });

    expect(isPickedOut(row('Wexford Bakery'))).toBe(true);
  });

  it('walks the results with the arrows', async () => {
    await openThree();

    // Newest first: Wexford (3 Apr), Pellam (2 Apr), Halberd (1 Apr).
    fireEvent.keyDown(row('Wexford Bakery'), { key: 'ArrowDown' });
    fireEvent.keyDown(row('Wexford Bakery'), { key: 'ArrowDown' });

    expect(isPickedOut(row('Pellam Tyres'))).toBe(true);
    expect(isPickedOut(row('Wexford Bakery'))).toBe(false);

    fireEvent.keyDown(row('Pellam Tyres'), { key: 'ArrowUp' });
    expect(isPickedOut(row('Wexford Bakery'))).toBe(true);
  });

  it('stops at the ends rather than wrapping', async () => {
    await openThree();

    const first = row('Wexford Bakery');
    fireEvent.keyDown(first, { key: 'ArrowUp' });

    expect(isPickedOut(row('Wexford Bakery'))).toBe(true);
  });

  it('opens the highlighted row on Enter', async () => {
    await openThree();

    const line = row('Pellam Tyres');
    fireEvent.keyDown(line, { key: 'Enter' });

    expect(screen.getByTestId('landed')).toHaveTextContent('/accounts/acc-savings?txn=txn-marked');
  });

  it('lets go of the row on Escape', async () => {
    await openThree();

    fireEvent.keyDown(row('Wexford Bakery'), { key: 'ArrowDown' });
    expect(isPickedOut(row('Wexford Bakery'))).toBe(true);

    fireEvent.keyDown(row('Wexford Bakery'), { key: 'Escape' });

    expect(isPickedOut(row('Wexford Bakery'))).toBe(false);
    expect(row('Wexford Bakery')).not.toHaveAttribute('aria-current');
  });

  it('offers the keyboard exactly one way in, however many results there are', async () => {
    await openThree();

    // Roving tabindex: one tab stop for the whole table, the rest reached with
    // the arrows. A table of two hundred tab stops would take two hundred
    // presses to get past.
    const stops = within(results()).getAllByRole('row').filter(r => r.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
  });
});

describe('Find — the cap', () => {
  it('draws the first two hundred and states the true total', async () => {
    const many: Transaction[] = Array.from({ length: 212 }, (_, index) => ({
      ...base,
      id: `txn-many-${index}`,
      description: `Calder Street Market ${index}`,
      amount: -5 - index / 100,
      date: new Date(Date.UTC(2026, 2, 1)),
    }));
    __setAppContextValue({
      accounts: [CURRENT, SAVINGS], transactions: many, categories: CATEGORIES, isLoading: false,
    });
    openFind();

    type('Calder');

    await waitFor(() => expect(screen.getByText(/Showing the first 200 of 212 matches/)).toBeInTheDocument());
    // The list is the cap, not the total: a browser drawing four thousand rows
    // is the problem this whole change exists to remove.
    expect(within(results()).getAllByRole('row')).toHaveLength(201); // 200 results + the header
  });

  it('states the count plainly when nothing was capped', async () => {
    openFind();

    type('Pellam');

    await waitFor(() => expect(screen.getByText('1 match')).toBeInTheDocument());
  });
});

describe('Find — a date range, as the Calendar sends it', () => {
  it('honours the range and shows it', async () => {
    openFind('/find?dateFrom=2026-04-02&dateTo=2026-04-02');

    await waitFor(() => expect(within(results()).getByText('Pellam Tyres')).toBeInTheDocument());
    // Only that day's rows.
    expect(within(results()).queryByText('Wexford Bakery')).not.toBeInTheDocument();
    expect(within(results()).queryByText('Halberd Ironmongers')).not.toBeInTheDocument();
    // And it says which day it is showing, rather than silently filtering.
    expect(screen.getByText(/Dated 2 Apr 2026/)).toBeInTheDocument();
  });

  it('can be cleared, and says so when the range holds nothing', async () => {
    openFind('/find?dateFrom=2026-04-02&dateTo=2026-04-02');
    await waitFor(() => expect(within(results()).getByText('Pellam Tyres')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Clear the date range' }));

    // Back to nothing asked — not to the whole ledger.
    await waitFor(() => {
      expect(screen.getByText(/Find looks through every account at once/)).toBeInTheDocument();
    });
  });

  it('narrows within the range when text is typed as well', async () => {
    openFind('/find?dateFrom=2026-04-01&dateTo=2026-04-03');
    await waitFor(() => expect(within(results()).getByText('Pellam Tyres')).toBeInTheDocument());

    type('bakery');

    await waitFor(() => {
      expect(within(results()).queryByText('Pellam Tyres')).not.toBeInTheDocument();
    });
    expect(within(results()).getByText('Wexford Bakery')).toBeInTheDocument();
  });
});
