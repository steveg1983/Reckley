/**
 * The budget wizard, through the UI.
 *
 * What is pinned here is the owner's design made visible: one question about
 * rhythm that decides which column takes typing, a grid with twelve complete
 * months of evidence beside every box, the fold that names what it is hiding,
 * and a confirm step that states the totals and every removal BY NAME before
 * anything is written.
 *
 * Every name and amount is invented: this repo is public. Dates are computed
 * from `new Date()` rather than spelled out, because the suite fixes its own
 * "now" and a hard-coded month would fall outside the window and read zero.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import BudgetWizard from './BudgetWizard';
import { __setAppContextValue, __resetAppContextValue } from '../test/mocks/AppContextSupabase';
import type { Budget, Category, Transaction } from '../types';

const toast = vi.hoisted(() => ({
  showSuccess: vi.fn(), showError: vi.fn(), showWarning: vi.fn(),
  showInfo: vi.fn(), showToast: vi.fn(), dismissToast: vi.fn(),
}));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => toast }));

vi.mock('../hooks/useCurrencyDecimal', () => ({
  useCurrencyDecimal: () => ({
    formatCurrency: (n: number | { toNumber: () => number }) =>
      `£${(typeof n === 'number' ? n : n.toNumber()).toFixed(2)}`,
    displayCurrency: 'GBP', getCurrencySymbol: () => '£',
    convert: vi.fn(), convertAndFormat: vi.fn(), convertAndSum: vi.fn(),
  }),
}));

const CATEGORIES: Category[] = [
  { id: 'type-expense', name: 'Expenses', type: 'expense', level: 'type' },
  { id: 'grp-food', name: 'Food', type: 'expense', level: 'sub', parentId: 'type-expense' },
  { id: 'det-shop', name: 'Food Shopping', type: 'expense', level: 'detail', parentId: 'grp-food' },
  { id: 'det-dining', name: 'Dining Out', type: 'expense', level: 'detail', parentId: 'grp-food' },
  { id: 'det-quiet', name: 'Never Used', type: 'expense', level: 'detail', parentId: 'grp-food' },
  { id: 'det-still', name: 'Also Never Used', type: 'expense', level: 'detail', parentId: 'grp-food' },
];

/** £100 a month of shopping and £50 of dining, across the twelve complete months. */
const monthlySpend = (prefix: string, category: string, amount: number): Transaction[] => {
  const now = new Date();
  const anchor = new Date(now.getFullYear(), now.getMonth(), 0);
  return Array.from({ length: 12 }, (_, index) => ({
    id: `${prefix}-${index}`,
    accountId: 'acc-1',
    description: 'Synthetic row',
    amount: -amount,
    type: 'expense' as const,
    category,
    date: new Date(anchor.getFullYear(), anchor.getMonth() - index, 10),
  }));
};

const TRANSACTIONS: Transaction[] = [
  ...monthlySpend('shop', 'det-shop', 100),   // £1,200 a year
  ...monthlySpend('dine', 'det-dining', 50),  // £600 a year
];

/** What a test adds to the default world, for the few that need more of one. */
interface World {
  categories?: Category[];
  transactions?: Transaction[];
}

/**
 * A SECOND group, and the world that carries it.
 *
 * Kept out of the default fixture rather than added to it: most of the suite
 * pins row counts and totals that a second group would move, and the tests
 * that need one are exactly the tests about groups being counted APART.
 */
const TWO_GROUPS: World = {
  categories: [
    { id: 'grp-travel', name: 'Travel', type: 'expense', level: 'sub', parentId: 'type-expense' },
    { id: 'det-fares', name: 'Train Fares', type: 'expense', level: 'detail', parentId: 'grp-travel' },
  ],
  transactions: monthlySpend('fare', 'det-fares', 20),  // £240 a year
};

const addBudget = vi.fn(async () => {});
const updateBudget = vi.fn(async () => {});
const deleteBudget = vi.fn(async () => {});

const renderWizard = (budgets: Budget[] = [], world: World = {}): void => {
  __setAppContextValue({
    transactions: [...TRANSACTIONS, ...(world.transactions ?? [])],
    transactionSplits: [],
    categories: [...CATEGORIES, ...(world.categories ?? [])],
    budgets, addBudget, updateBudget, deleteBudget,
  });
  render(<BudgetWizard isOpen onClose={vi.fn()} />);
};

/** Answer step 1 and land on the grid. */
const chooseMonthly = (): void => {
  fireEvent.click(screen.getByRole('button', { name: /Budget monthly/ }));
};
const chooseAnnually = (): void => {
  fireEvent.click(screen.getByRole('button', { name: /Budget annually/ }));
};

/** Change your mind about the rhythm: back to step 1 and out again. */
const turnOver = (choose: () => void): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  choose();
};

/**
 * The fold's own button. Matched on a FRAGMENT of its label because since the
 * 4 Sep 2026 ruling that label also carries a money figure, and a helper that
 * pinned the whole string would have to be rewritten for every test that types
 * into a folded box.
 */
const foldButton = (): HTMLElement =>
  screen.getByRole('button', { name: /with nothing in this window/ });

/** Open the fold, where the categories with nothing in the window are. */
const openFold = (): void => { fireEvent.click(foldButton()); };

/** …and shut it again, which is the state the label's figure exists for. */
const closeFold = (): void => { fireEvent.click(foldButton()); };

const boxFor = (name: string, rhythm: 'Monthly' | 'Yearly' = 'Monthly'): HTMLElement =>
  screen.getByLabelText(`${rhythm} budget for ${name}`);

const rowFor = (name: string): HTMLElement =>
  screen.getByText(name).closest('tr') as HTMLElement;

/** A group's heading row — the shaded band that answers the same columns as its rows. */
const groupRow = (name: string): HTMLElement =>
  screen.getByRole('rowheader', { name }).closest('tr') as HTMLElement;

/**
 * The same, where a parent may have TWO headings: one above with its rows that
 * have spending in the window, one inside the fold with those that have none.
 * In document order, so [0] is the live section and [1] is the fold.
 */
const groupRows = (name: string): HTMLElement[] =>
  screen.getAllByRole('rowheader', { name }).map(heading => heading.closest('tr') as HTMLElement);

/** Its three figure cells, in the grid's own order: what it cost, the total, the twin. */
const groupCells = (name: string): HTMLElement[] => within(groupRow(name)).getAllByRole('cell');

/** Every £ figure in an element, as whole pence, so a test can add them up itself. */
const penceIn = (element: HTMLElement): number[] =>
  [...(element.textContent ?? '').matchAll(/£(\d+)\.(\d\d)/g)].map(
    ([, pounds, pence]) => Number(pounds) * 100 + Number(pence)
  );

/** What ONE heading row claims has been budgeted across it. */
const budgetPenceOf = (row: HTMLElement): number =>
  penceIn(within(row).getAllByRole('cell')[1])[0] ?? 0;

/** What a group heading claims has been budgeted across it, in the rhythm being typed. */
const groupBudgetPence = (name: string): number => budgetPenceOf(groupRow(name));

/** Every heading on the screen, added up — folded sections included. */
const allGroupsPence = (): number =>
  screen
    .getAllByRole('rowheader')
    .reduce((sum, heading) => sum + budgetPenceOf(heading.closest('tr') as HTMLElement), 0);

/** What the scoreboard claims for the whole screen, in the same rhythm. */
const scoreboardPence = (): number => penceIn(screen.getByText(/Budgeted so far/))[0] ?? 0;

/** What the fold's LABEL claims is budgeted behind it. Nothing there reads 0. */
const foldLabelPence = (): number => penceIn(foldButton())[0] ?? 0;

const budgetOf = (over: Partial<Budget> & { id: string; categoryId: string }): Budget => ({
  amount: 100, period: 'monthly', isActive: true, spent: 0,
  createdAt: new Date(), updatedAt: new Date(), ...over,
});

const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** The default "run from": the 1st of the month the suite runs in. */
const firstOfThisMonth = (): string => {
  const now = new Date();
  return isoDay(new Date(now.getFullYear(), now.getMonth(), 1));
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); __resetAppContextValue(); });

describe('step 1 — months or years', () => {
  it('asks one question before showing any grid', () => {
    renderWizard();
    expect(screen.getByText('Do you think in months or years?')).toBeInTheDocument();
    expect(screen.queryByLabelText('Monthly budget for Food Shopping')).not.toBeInTheDocument();
  });

  it('the monthly answer makes the monthly column the one you type in', () => {
    renderWizard();
    chooseMonthly();
    expect(boxFor('Food Shopping', 'Monthly')).toBeInTheDocument();
    expect(screen.queryByLabelText('Yearly budget for Food Shopping')).not.toBeInTheDocument();
  });

  it('the annual answer moves the typing to the year', () => {
    renderWizard();
    chooseAnnually();
    expect(boxFor('Food Shopping', 'Yearly')).toBeInTheDocument();
    expect(screen.queryByLabelText('Monthly budget for Food Shopping')).not.toBeInTheDocument();
  });

  it('lets you change your mind — Back returns to the question', () => {
    renderWizard();
    chooseMonthly();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Do you think in months or years?')).toBeInTheDocument();
  });
});

describe('step 2 — the evidence beside every box', () => {
  it('shows the year AND the month on every row, whichever is being typed', () => {
    renderWizard();
    chooseMonthly();
    const row = rowFor('Food Shopping');
    expect(within(row).getByText('£1200.00 a year')).toBeInTheDocument();
    expect(within(row).getByText('£100.00 a month')).toBeInTheDocument();
  });

  it('gives the grid a column for each of the four things (desktop)', () => {
    renderWizard();
    chooseMonthly();
    expect(screen.getByRole('columnheader', { name: /Category/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /What it cost/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Your budget, per month/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Which is/ })).toBeInTheDocument();
  });

  it('names the window it measured rather than describing it', () => {
    renderWizard();
    chooseMonthly();
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    const start = new Date(end.getFullYear(), end.getMonth() - 11, 1);
    const month = (d: Date): string => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    expect(screen.getByText(`What you spent, ${month(start)} – ${month(end)}`)).toBeInTheDocument();
  });

  it('says the current month is not counted', () => {
    renderWizard();
    chooseMonthly();
    expect(screen.getByText(/this month is still running, so it is not counted/i)).toBeInTheDocument();
  });

  it('starts every box EMPTY — the history is a reference, not a default', () => {
    renderWizard();
    chooseMonthly();
    expect(boxFor('Food Shopping')).toHaveValue('');
  });

  it('files rows under their parent', () => {
    renderWizard();
    chooseMonthly();
    const body = groupRow('Food').closest('tbody') as HTMLElement;
    expect(within(body).getByLabelText('Monthly budget for Food Shopping')).toBeInTheDocument();
    expect(within(body).getByLabelText('Monthly budget for Dining Out')).toBeInTheDocument();
  });

  it('a typed monthly figure states its year', () => {
    renderWizard();
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    expect(within(rowFor('Food Shopping')).getByText('£1080.00 a year')).toBeInTheDocument();
  });

  it('a typed annual figure states its month', () => {
    renderWizard();
    chooseAnnually();
    // £1,800 rather than £1,200 on purpose: the history cell on this row
    // already reads "£100.00 a month", so a twin of £150.00 is the only way to
    // prove the twin is the figure being computed rather than the evidence.
    fireEvent.change(boxFor('Food Shopping', 'Yearly'), { target: { value: '1800' } });
    expect(within(rowFor('Food Shopping')).getByText('£150.00 a month')).toBeInTheDocument();
  });
});

describe('step 2 — filling boxes', () => {
  it('"use my actual" fills the box rather than saving behind you', () => {
    renderWizard();
    chooseMonthly();
    fireEvent.click(screen.getByLabelText('Use what Food Shopping actually cost'));
    expect(boxFor('Food Shopping')).toHaveValue('100');
    expect(addBudget).not.toHaveBeenCalled();
  });

  it('fills the ANNUAL figure when annual is the rhythm', () => {
    renderWizard();
    chooseAnnually();
    fireEvent.click(screen.getByLabelText('Use what Food Shopping actually cost'));
    expect(boxFor('Food Shopping', 'Yearly')).toHaveValue('1200');
  });

  it('"Start from history" fills every row with evidence, in one press', () => {
    renderWizard();
    chooseMonthly();
    fireEvent.click(screen.getByRole('button', { name: 'Start from history' }));
    expect(boxFor('Food Shopping')).toHaveValue('100');
    expect(boxFor('Dining Out')).toHaveValue('50');
  });

  it('"Clear all" puts the boxes back — it does not queue a removal of everything', () => {
    renderWizard([budgetOf({ id: 'b-1', categoryId: 'det-shop', amount: 120 })]);
    chooseMonthly();
    fireEvent.click(screen.getByRole('button', { name: 'Start from history' }));
    expect(boxFor('Food Shopping')).toHaveValue('100');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    // Back to what is STORED, not empty — emptying is how a budget is removed.
    expect(boxFor('Food Shopping')).toHaveValue('120');
    expect(boxFor('Dining Out')).toHaveValue('');
  });

  it('offers no "use my actual" on a row with nothing in the window', () => {
    renderWizard();
    chooseMonthly();
    openFold();
    expect(screen.queryByLabelText('Use what Never Used actually cost')).not.toBeInTheDocument();
  });
});

describe('step 2 — the measuring stick and the scoreboard', () => {
  it('the measured-over choice changes the named window and its explainer', () => {
    renderWizard();
    chooseMonthly();
    const lastYear = new Date().getFullYear() - 1;
    fireEvent.change(screen.getByLabelText(/Measured over/), {
      target: { value: 'calendar-year' },
    });
    expect(screen.getByText(`What you spent, Jan – Dec ${lastYear}`)).toBeInTheDocument();
    expect(screen.getByText(/The last complete calendar year/)).toBeInTheDocument();
  });

  it('changing the measuring stick never touches what was typed', () => {
    renderWizard();
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '150' } });
    fireEvent.change(screen.getByLabelText(/Measured over/), {
      target: { value: 'calendar-year' },
    });
    // The evidence changed; the intent did not.
    expect(boxFor('Food Shopping')).toHaveValue('150');
  });

  /** The twelve complete months the suite's fixture spends in, as the screen names them. */
  const lastComplete = (): { start: Date; end: Date } => {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return { start: new Date(end.getFullYear(), end.getMonth() - 11, 1), end };
  };
  const ym = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const month = (d: Date): string => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  const chooseCustom = (): void => {
    fireEvent.change(screen.getByLabelText(/Measured over/), { target: { value: 'custom' } });
  };

  it('"Months I choose" shows From and To, seeded with the months already on screen — nothing moves at the moment of choosing', () => {
    renderWizard();
    chooseMonthly();
    const { start, end } = lastComplete();
    chooseCustom();
    expect(screen.getByLabelText('Measured from month')).toHaveValue(ym(start));
    expect(screen.getByLabelText('Measured to month')).toHaveValue(ym(end));
    expect(screen.getByText(`What you spent, ${month(start)} – ${month(end)}`)).toBeInTheDocument();
    expect(screen.getByText(/Twelve complete months of your choosing/)).toBeInTheDocument();
    expect(within(rowFor('Food Shopping')).getByText('£1200.00 a year')).toBeInTheDocument();
  });

  it('a shorter window names its count, and reads "a year" and "a month" as a RATE over it', () => {
    renderWizard();
    chooseMonthly();
    chooseCustom();
    const { end } = lastComplete();
    const from = new Date(end.getFullYear(), end.getMonth() - 5, 1);
    fireEvent.change(screen.getByLabelText('Measured from month'), { target: { value: ym(from) } });
    expect(screen.getByText(`What you spent, ${month(from)} – ${month(end)}`)).toBeInTheDocument();
    expect(screen.getByText(/6 complete months — "a year" and "a month" here are what you spent over them/)).toBeInTheDocument();
    // £100 in each of the six months: £600 over the window, which is £100 a
    // month and £1,200 a year AT THAT RATE — the figure a budget is set against.
    const row = rowFor('Food Shopping');
    expect(within(row).getByText('£1200.00 a year')).toBeInTheDocument();
    expect(within(row).getByText('£100.00 a month')).toBeInTheDocument();
  });

  it('the month inputs stop at last month — the month still running is never evidence', () => {
    renderWizard();
    chooseMonthly();
    chooseCustom();
    const { end } = lastComplete();
    expect(screen.getByLabelText('Measured from month')).toHaveAttribute('max', ym(end));
    expect(screen.getByLabelText('Measured to month')).toHaveAttribute('max', ym(end));
  });

  it('a range typed into this month is answered on screen rather than obeyed', () => {
    renderWizard();
    chooseMonthly();
    chooseCustom();
    const { start, end } = lastComplete();
    fireEvent.change(screen.getByLabelText('Measured to month'), { target: { value: ym(new Date()) } });
    // The input keeps the ask; the heading says what actually counted.
    expect(screen.getByLabelText('Measured to month')).toHaveValue(ym(new Date()));
    expect(screen.getByText(`What you spent, ${month(start)} – ${month(end)}`)).toBeInTheDocument();
  });

  it('a window of one month has one name', () => {
    renderWizard();
    chooseMonthly();
    chooseCustom();
    const { end } = lastComplete();
    fireEvent.change(screen.getByLabelText('Measured from month'), { target: { value: ym(end) } });
    expect(screen.getByText(`What you spent, ${month(end)}`)).toBeInTheDocument();
    expect(screen.getByText(/One complete month — "a year" and "a month"/)).toBeInTheDocument();
  });

  it('the scoreboard counts a typed box as I go along', () => {
    renderWizard();
    chooseMonthly();
    expect(screen.getByText(/0 of 4 boxes filled/)).toBeInTheDocument();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '150' } });
    expect(screen.getByText(/1 of 4 boxes filled/)).toBeInTheDocument();
    // The budgeted side leads with the chosen rhythm's figure.
    expect(screen.getAllByText('£150.00').length).toBeGreaterThan(0);
  });
});

/**
 * THE GROUP HEADING IS A ROW OF THE GRID (owner, 2 Sep 2026).
 *
 * It used to be a banner laid across all four columns, with the group's SPEND
 * on the right where the budget columns are — "that is actually my spend for
 * the period, not my budget". So what is pinned here is that every figure on
 * the heading now sits under the column that describes it, and that the
 * budget total is the sum of that group's own boxes as they are typed: the
 * same arithmetic as the scoreboard, over a subset of the same boxes, which
 * is why the group figures must ADD UP to the scoreboard's exactly.
 */
describe('step 2 — the group heading is a row of the grid', () => {
  it('answers the same four columns its rows do, and takes no typing', () => {
    renderWizard();
    chooseMonthly();
    const row = groupRow('Food');
    // One heading cell and three figure cells — the grid's four columns.
    expect(within(row).getAllByRole('rowheader')).toHaveLength(1);
    expect(within(row).getAllByRole('cell')).toHaveLength(3);
    // Still context, never a box: budgeting a group AND its children double-counts.
    expect(within(row).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('puts what the group cost under "What it cost", both periods', () => {
    renderWizard();
    chooseMonthly();
    const [cost] = groupCells('Food');
    expect(cost).toHaveTextContent('£1800.00 a year');
    expect(cost).toHaveTextContent('£150.00 a month');
  });

  it('shows NO budget figure while every box in the group is empty', () => {
    renderWizard();
    chooseMonthly();
    const [, budget, twin] = groupCells('Food');
    // An empty box is no budget, so an untouched group has no total. £0.00
    // here would claim a budget of nothing across every row beneath it.
    expect(budget).toBeEmptyDOMElement();
    expect(twin).toBeEmptyDOMElement();
  });

  it('adds up its own boxes as they are typed, and says the twin beside it', () => {
    renderWizard();
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    fireEvent.change(boxFor('Dining Out'), { target: { value: '40.50' } });
    const [, budget, twin] = groupCells('Food');
    expect(budget).toHaveTextContent('£130.50');
    expect(twin).toHaveTextContent('£1566.00 a year');
  });

  it('does not move when a box in another group is filled', () => {
    renderWizard([], TWO_GROUPS);
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    fireEvent.change(boxFor('Dining Out'), { target: { value: '40.50' } });
    expect(groupBudgetPence('Food')).toBe(13050);

    fireEvent.change(boxFor('Train Fares'), { target: { value: '15' } });
    expect(groupBudgetPence('Food')).toBe(13050);
    expect(groupBudgetPence('Travel')).toBe(1500);
  });

  it('counts a typed nought, and stops counting a box that is cleared', () => {
    renderWizard();
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '40' } });
    fireEvent.change(boxFor('Dining Out'), { target: { value: '0' } });
    expect(groupBudgetPence('Food')).toBe(4000);

    // A nought is a budget of nothing: it is filled in, so the total remains
    // — as £0.00, which is a different claim from no figure at all.
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '' } });
    expect(groupCells('Food')[1]).toHaveTextContent('£0.00');

    fireEvent.change(boxFor('Dining Out'), { target: { value: '' } });
    expect(groupCells('Food')[1]).toBeEmptyDOMElement();
  });

  it('the group totals add up to the scoreboard, to the penny', () => {
    renderWizard([], TWO_GROUPS);
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    fireEvent.change(boxFor('Dining Out'), { target: { value: '40.50' } });
    fireEvent.change(boxFor('Train Fares'), { target: { value: '15' } });

    expect(scoreboardPence()).toBe(14550);
    expect(groupBudgetPence('Food') + groupBudgetPence('Travel')).toBe(scoreboardPence());
  });

  it('…and still adds up when the year is the rhythm being typed', () => {
    renderWizard([], TWO_GROUPS);
    chooseAnnually();
    fireEvent.change(boxFor('Food Shopping', 'Yearly'), { target: { value: '1080' } });
    fireEvent.change(boxFor('Dining Out', 'Yearly'), { target: { value: '486' } });
    fireEvent.change(boxFor('Train Fares', 'Yearly'), { target: { value: '180' } });

    expect(scoreboardPence()).toBe(174600);
    expect(groupBudgetPence('Food') + groupBudgetPence('Travel')).toBe(scoreboardPence());
    // The twin is the month now, on the heading as on every row.
    expect(groupCells('Food')[2]).toHaveTextContent('£130.50 a month');
  });

  /**
   * REWRITTEN 2 SEP 2026, AND DELIBERATELY.
   *
   * This test used to pin the opposite behaviour: a figure typed as £90 a
   * month was READ as £90 a year after a change of rhythm, and the heading's
   * twin duly said £7.50 a month. It was a faithful test of a wrong thing —
   * a considered monthly decision turned into a twelfth of itself by one press
   * of Back, without a word. The owner ruled on the behaviour rather than on
   * the test ("Yes, it should convert"), so what is pinned now is the same
   * money said the other way round.
   */
  it('converts what was typed when the rhythm changes, scoreboard and all', () => {
    renderWizard();
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    expect(groupCells('Food')[2]).toHaveTextContent('£1080.00 a year');

    turnOver(chooseAnnually);

    // The money carries over, not the digits: £90 a month IS £1,080 a year.
    expect(boxFor('Food Shopping', 'Yearly')).toHaveValue('1080');
    expect(groupCells('Food')[1]).toHaveTextContent('£1080.00');
    expect(groupCells('Food')[2]).toHaveTextContent('£90.00 a month');
    expect(groupBudgetPence('Food')).toBe(scoreboardPence());
  });
});

/**
 * A CHANGE OF RHYTHM IS A LENS, NOT AN EDIT (owner, 2 Sep 2026).
 *
 * The conversion itself is pinned above and in budgetWizardPlan.test.ts; what
 * these two add is the property that makes it safe to do more than once —
 * every conversion is made from the figure that was actually typed, never from
 * the last conversion of it, so turning the screen over and back leaves the
 * original in the box to the penny.
 */
describe('step 2 — turning the screen over and back', () => {
  it('brings a monthly figure home unchanged', () => {
    renderWizard();
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });

    turnOver(chooseAnnually);
    expect(boxFor('Food Shopping', 'Yearly')).toHaveValue('1080');

    turnOver(chooseMonthly);
    expect(boxFor('Food Shopping')).toHaveValue('90');
  });

  it('…including one the conversion has to round: £100 a year is not £99.96', () => {
    renderWizard();
    chooseAnnually();
    fireEvent.change(boxFor('Food Shopping', 'Yearly'), { target: { value: '100' } });

    turnOver(chooseMonthly);
    // A year of £100 is £8.33 a month — the rounded figure is what the box
    // shows and therefore what a save would write.
    expect(boxFor('Food Shopping')).toHaveValue('8.33');

    turnOver(chooseAnnually);
    // …but £8.33 × 12 is £99.96, so a box rewritten at each switch would lose
    // fourpence for changing your mind twice. Nothing was rewritten.
    expect(boxFor('Food Shopping', 'Yearly')).toHaveValue('100');
  });
});

describe('step 2 — the fold names what it hides', () => {
  it('folds the zero-spend categories away, with their count said out loud', () => {
    renderWizard();
    chooseMonthly();
    expect(screen.queryByText('Never Used')).not.toBeInTheDocument();
    // Still the WHOLE label, exactly — and the exactness is what now carries
    // the other half of the 4 Sep 2026 ruling: zero filled boxes behind the
    // fold means no figure and NO SEPARATOR. A trailing "·" is a figure that
    // failed to load, and "£0.00 budgeted" would claim a budget of nothing
    // across every hidden row.
    expect(
      screen.getByRole('button', { name: '2 categories with nothing in this window' })
    ).toBeInTheDocument();
    expect(foldLabelPence()).toBe(0);
  });

  /**
   * THE LABEL NAMES ITS MONEY (owner, 4 Sep 2026: "name it").
   *
   * Grouping the folded rows (2 Sep) fixed the sum while the fold was OPEN and
   * left the shut case exactly as broken: a budget typed down there counted on
   * the scoreboard, then the fold closed over the only place it was visible.
   * The strip went up by £20 and nothing on screen said where the £20 was —
   * the same failure the count itself was added to prevent, one level down.
   */
  it('names what is budgeted behind the fold, once the fold is shut again', () => {
    renderWizard();
    chooseMonthly();
    openFold();
    fireEvent.change(boxFor('Never Used'), { target: { value: '20' } });
    closeFold();

    expect(screen.queryByText('Never Used')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: '2 categories with nothing in this window · £20.00 budgeted',
      })
    ).toBeInTheDocument();
  });

  it('is the same total the scoreboard and the headings are, never a second one', () => {
    renderWizard([], TWO_GROUPS);
    chooseMonthly();
    openFold();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    fireEvent.change(boxFor('Train Fares'), { target: { value: '15' } });
    fireEvent.change(boxFor('Never Used'), { target: { value: '20' } });

    // Open: every heading, the folded one included, adds up to the strip.
    expect(allGroupsPence()).toBe(scoreboardPence());

    closeFold();
    // Shut: the folded heading is gone from the page, and the label carries
    // precisely what it took with it — so the identity still closes.
    expect(foldLabelPence()).toBe(2000);
    expect(allGroupsPence() + foldLabelPence()).toBe(scoreboardPence());
  });

  it('drops the figure again when the last folded box is emptied', () => {
    renderWizard();
    chooseMonthly();
    openFold();
    fireEvent.change(boxFor('Never Used'), { target: { value: '20' } });
    fireEvent.change(boxFor('Never Used'), { target: { value: '' } });
    closeFold();

    // An empty box is UNBUDGETED, not a budget of nothing, all the way up to
    // the label: the count goes back to standing alone.
    expect(
      screen.getByRole('button', { name: '2 categories with nothing in this window' })
    ).toBeInTheDocument();
  });

  it('opens on a tap', () => {
    renderWizard();
    chooseMonthly();
    openFold();
    expect(screen.getByText('Never Used')).toBeInTheDocument();
    expect(boxFor('Never Used')).toBeInTheDocument();
  });

  /**
   * THE FOLD KEEPS ITS GROUPS (owner, 2 Sep 2026: "It needs to stay honest —
   * group them under their parents").
   *
   * Folded rows used to be listed flat under no heading at all, so a budget
   * typed into one counted on the scoreboard and in no group total — the
   * headings and the strip above them stopped adding up the moment somebody
   * opened the fold and typed. They are the same grid now: same headings, same
   * arithmetic, one heading per parent PER SECTION so the two sections stay a
   * partition of the rows rather than an overlap.
   */
  it('files the folded rows under their parents, as the list above does', () => {
    renderWizard();
    chooseMonthly();
    openFold();

    // 'Food' has two children with spending and two without, so it heads both
    // sections — one heading per parent per section, each totalling its own.
    const [live, folded] = groupRows('Food');
    expect(within(live.closest('tbody') as HTMLElement)
      .getByLabelText('Monthly budget for Food Shopping')).toBeInTheDocument();
    const foldedBody = folded.closest('tbody') as HTMLElement;
    expect(within(foldedBody).getByLabelText('Monthly budget for Never Used')).toBeInTheDocument();
    expect(within(foldedBody).getByLabelText('Monthly budget for Also Never Used')).toBeInTheDocument();
  });

  it('says a folded group cost nothing rather than printing £0.00 at it', () => {
    renderWizard();
    chooseMonthly();
    openFold();

    // A zero renders nothing, on a heading as on its rows: £0.00 under "What
    // it cost" would be a claim about the window rather than a gap in it.
    const [, folded] = groupRows('Food');
    const [cost, budget] = within(folded).getAllByRole('cell');
    expect(cost).toHaveTextContent('Nothing in this window');
    expect(budget).toBeEmptyDOMElement();
  });

  it('counts a budget typed down there in its parent, and on the scoreboard', () => {
    renderWizard();
    chooseMonthly();
    openFold();
    fireEvent.change(boxFor('Never Used'), { target: { value: '20' } });

    const [live, folded] = groupRows('Food');
    expect(budgetPenceOf(folded)).toBe(2000);
    // …and only there: the section above did not move.
    expect(budgetPenceOf(live)).toBe(0);
    expect(scoreboardPence()).toBe(2000);
  });

  it('keeps every heading adding up to the scoreboard with the fold filled in', () => {
    renderWizard([], TWO_GROUPS);
    chooseMonthly();
    openFold();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    fireEvent.change(boxFor('Train Fares'), { target: { value: '15' } });
    fireEvent.change(boxFor('Never Used'), { target: { value: '20' } });

    // Food £90 above, Travel £15, Food £20 inside the fold: three headings,
    // no row counted twice, £125.00 on the strip.
    expect(budgetPenceOf(groupRows('Food')[0])).toBe(9000);
    expect(budgetPenceOf(groupRows('Food')[1])).toBe(2000);
    expect(scoreboardPence()).toBe(12500);
    expect(allGroupsPence()).toBe(scoreboardPence());
  });

  it('never folds a category that already has a budget, however quiet it is', () => {
    renderWizard([budgetOf({ id: 'b-q', categoryId: 'det-quiet', amount: 25 })]);
    chooseMonthly();
    // Visible without expanding anything: a removal you cannot see is not an offer.
    expect(screen.getByText('Never Used')).toBeInTheDocument();
    // One left behind the fold, and nothing budgeted on it — so the label is
    // the bare count, per the 4 Sep 2026 ruling's zero rule.
    expect(
      screen.getByRole('button', { name: '1 category with nothing in this window' })
    ).toBeInTheDocument();
  });
});

describe('step 2 — existing budgets arrive pre-filled', () => {
  it('shows a stored monthly budget in the monthly box', () => {
    renderWizard([budgetOf({ id: 'b-1', categoryId: 'det-shop', amount: 120 })]);
    chooseMonthly();
    expect(boxFor('Food Shopping')).toHaveValue('120');
  });

  it('converts a stored yearly budget for display when months are being typed', () => {
    renderWizard([budgetOf({ id: 'b-1', categoryId: 'det-shop', amount: 1500, period: 'yearly' })]);
    chooseMonthly();
    expect(boxFor('Food Shopping')).toHaveValue('125');
  });

  it('leaves a weekly budget alone and says where to change it', () => {
    renderWizard([budgetOf({ id: 'b-wk', categoryId: 'det-shop', amount: 30, period: 'weekly' })]);
    chooseMonthly();
    expect(screen.queryByLabelText('Monthly budget for Food Shopping')).not.toBeInTheDocument();
    expect(screen.getByText(/left as it is\. Change it on the Budget page/)).toBeInTheDocument();
  });
});

describe('step 3 — what will happen, before it happens', () => {
  const review = (): void => fireEvent.click(screen.getByRole('button', { name: 'Review' }));

  it('states the count, the month, the year and what was really spent', () => {
    renderWizard();
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    fireEvent.change(boxFor('Dining Out'), { target: { value: '40' } });
    review();
    expect(screen.getByText("You're budgeting 2 categories")).toBeInTheDocument();
    expect(
      screen.getByText(/£130\.00 a month \(£1560\.00 a year\), against £1800\.00 actually spent/)
    ).toBeInTheDocument();
  });

  it('names a shortfall in words rather than leaving it to be worked out', () => {
    renderWizard();
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    review();
    expect(screen.getByText(/£120\.00 a year LESS than they really cost/)).toBeInTheDocument();
  });

  it('names headroom when the budgets allow more than the year cost', () => {
    renderWizard();
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '150' } });
    review();
    expect(screen.getByText(/£600\.00 a year MORE than they really cost/)).toBeInTheDocument();
  });

  it('over a window that is not a year, the comparison is called a RATE, not spending', () => {
    renderWizard();
    chooseMonthly();
    fireEvent.change(screen.getByLabelText(/Measured over/), { target: { value: 'custom' } });
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    const from = new Date(end.getFullYear(), end.getMonth() - 5, 1);
    const ym = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    fireEvent.change(screen.getByLabelText('Measured from month'), { target: { value: ym(from) } });
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    review();
    // £600 over six months is £1,200 a year at that rate; £90 a month is £120 a year under it.
    expect(
      screen.getByText(/£90\.00 a month \(£1080\.00 a year\), against £1200\.00 a year at the rate those categories ran over .* \(6 months\)\./)
    ).toBeInTheDocument();
    expect(screen.getByText(/£120\.00 a year LESS than that rate — you would have to spend more slowly/)).toBeInTheDocument();
    expect(screen.queryByText(/actually spent/)).not.toBeInTheDocument();
  });

  it('lists every removal BY NAME', () => {
    renderWizard([budgetOf({ id: 'b-1', categoryId: 'det-shop', amount: 120 })]);
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '' } });
    review();
    expect(screen.getByText('1 budget will be removed: Food Shopping.')).toBeInTheDocument();
  });

  it('says plainly when nothing has changed, and will not save', () => {
    renderWizard();
    chooseMonthly();
    review();
    expect(screen.getByText('Nothing has changed, so there is nothing to save.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save budgets' })).toBeDisabled();
  });
});

describe('what it writes', () => {
  const reviewAndSave = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save budgets' }));
  };

  it('writes a budget on a category paid in one go with that shape, and says so on the row (7 Nov 2026)', async () => {
    // One premium in the last complete month and nothing else: the window's
    // evidence that Insurance is a lump. The grid says so, and the NEW budget
    // is written paid in one go; the spread category beside it is not.
    const now = new Date();
    const anchor = new Date(now.getFullYear(), now.getMonth(), 0);
    renderWizard([], {
      categories: [{ id: 'det-insurance', name: 'Insurance', type: 'expense', level: 'detail', parentId: 'grp-food' }],
      transactions: [{
        id: 'premium', accountId: 'acc-1', description: 'Synthetic premium', amount: -480,
        type: 'expense', category: 'det-insurance', date: new Date(anchor.getFullYear(), anchor.getMonth(), 10),
      }],
    });
    chooseMonthly();
    expect(screen.getByTestId('paid-once')).toHaveTextContent(/^paid once, in \w+ \d{4}$/);
    fireEvent.change(boxFor('Insurance'), { target: { value: '40' } });
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    reviewAndSave();

    await waitFor(() => expect(addBudget).toHaveBeenCalledTimes(2));
    expect(addBudget).toHaveBeenCalledWith(expect.objectContaining({ categoryId: 'det-insurance', paceShape: 'once' }));
    const shop = addBudget.mock.calls.map(call => call[0] as { categoryId: string; paceShape?: string }).find(b => b.categoryId === 'det-shop');
    expect(shop?.paceShape).toBeUndefined();
  });

  it('creates a budget on the category, in the chosen rhythm', async () => {
    renderWizard();
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    reviewAndSave();

    await waitFor(() => expect(addBudget).toHaveBeenCalledTimes(1));
    expect(addBudget).toHaveBeenCalledWith(expect.objectContaining({
      categoryId: 'det-shop', amount: 90, period: 'monthly', isActive: true,
      // The default "run from": the 1st of this month (owner, 5 Nov 2026).
      startDate: firstOfThisMonth(),
    }));
  });

  it('writes the ANNUAL period when annual was the rhythm', async () => {
    renderWizard();
    chooseAnnually();
    fireEvent.change(boxFor('Food Shopping', 'Yearly'), { target: { value: '1500' } });
    reviewAndSave();

    await waitFor(() => expect(addBudget).toHaveBeenCalledTimes(1));
    expect(addBudget).toHaveBeenCalledWith(expect.objectContaining({
      amount: 1500, period: 'yearly',
    }));
  });

  it('writes the CONVERTED figure after a change of rhythm, not the digits typed', async () => {
    // £90 typed as a month, saved on a screen switched to years. The box says
    // £1,080 by then and the write has to agree with it: storing 90 as a YEAR
    // would be a twelvefold error nobody could see coming (owner, 2 Sep 2026).
    renderWizard();
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    turnOver(chooseAnnually);
    reviewAndSave();

    await waitFor(() => expect(addBudget).toHaveBeenCalledTimes(1));
    expect(addBudget).toHaveBeenCalledWith(expect.objectContaining({
      amount: 1080, period: 'yearly',
    }));
  });

  it('writes a typed ZERO — a budget of nothing is a budget', async () => {
    renderWizard();
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '0' } });
    reviewAndSave();

    await waitFor(() => expect(addBudget).toHaveBeenCalledTimes(1));
    expect(addBudget).toHaveBeenCalledWith(expect.objectContaining({ amount: 0 }));
  });

  it('writes NOTHING for a box left empty', async () => {
    renderWizard();
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    reviewAndSave();

    await waitFor(() => expect(addBudget).toHaveBeenCalledTimes(1));
    expect(addBudget).not.toHaveBeenCalledWith(expect.objectContaining({ categoryId: 'det-dining' }));
  });

  it('edits the budget that is there rather than adding a second', async () => {
    renderWizard([budgetOf({ id: 'b-1', categoryId: 'det-shop', amount: 120 })]);
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '95' } });
    reviewAndSave();

    await waitFor(() => expect(updateBudget).toHaveBeenCalledTimes(1));
    expect(updateBudget).toHaveBeenCalledWith('b-1', { amount: 95, period: 'monthly', startDate: firstOfThisMonth(), endDate: null });
    expect(addBudget).not.toHaveBeenCalled();
  });

  it('removes the budget behind a box that was emptied', async () => {
    renderWizard([budgetOf({ id: 'b-1', categoryId: 'det-shop', amount: 120 })]);
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '' } });
    reviewAndSave();

    await waitFor(() => expect(deleteBudget).toHaveBeenCalledWith('b-1'));
    expect(updateBudget).not.toHaveBeenCalled();
  });

  it('never touches alert thresholds — it does not ask, so it does not answer', async () => {
    renderWizard([budgetOf({ id: 'b-1', categoryId: 'det-shop', amount: 120, alertThreshold: 0.9 })]);
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '95' } });
    reviewAndSave();

    await waitFor(() => expect(updateBudget).toHaveBeenCalledTimes(1));
    expect(updateBudget).toHaveBeenCalledWith('b-1', expect.not.objectContaining({ alertThreshold: expect.anything() }));
  });

  it('reports which rows failed instead of claiming a clean save', async () => {
    updateBudget.mockRejectedValueOnce(new Error('offline'));
    renderWizard([
      budgetOf({ id: 'b-1', categoryId: 'det-shop', amount: 120 }),
      budgetOf({ id: 'b-2', categoryId: 'det-dining', amount: 60 }),
    ]);
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '95' } });
    fireEvent.change(boxFor('Dining Out'), { target: { value: '65' } });
    reviewAndSave();

    // The second row still ran: one failure does not strand the batch.
    await waitFor(() => expect(updateBudget).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(toast.showError).toHaveBeenCalledWith(expect.stringContaining('Food Shopping'))
    );
    expect(toast.showSuccess).not.toHaveBeenCalled();
  });
});

/**
 * "RUN THESE BUDGETS FROM" (owner, 5 Nov 2026). The day every budget written
 * here counts its cycles from, asked on the save screen; and the offer — never
 * the assumption — to move the budgets the save is not otherwise touching.
 */
describe('step 3 — run these budgets from', () => {
  const review = (): void => fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  const save = (): void => fireEvent.click(screen.getByRole('button', { name: 'Save budgets' }));

  it('offers the four dated choices with this month chosen, and says what the choice means', () => {
    renderWizard();
    chooseAnnually();
    fireEvent.change(boxFor('Food Shopping', 'Yearly'), { target: { value: '1500' } });
    review();

    expect(screen.getByRole('radio', { name: /^This month — / })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Next month — / })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /^The next calendar year — / })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^The next tax year — / })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Another date/ })).toBeInTheDocument();
    expect(screen.getByText(/Each budget runs for a year from that day/)).toBeInTheDocument();
  });

  it('writes the chosen day on the budget', async () => {
    renderWizard();
    chooseAnnually();
    fireEvent.change(boxFor('Food Shopping', 'Yearly'), { target: { value: '1500' } });
    review();
    fireEvent.click(screen.getByRole('radio', { name: /^The next tax year — / }));
    save();

    await waitFor(() => expect(addBudget).toHaveBeenCalledTimes(1));
    const now = new Date();
    const pastApril6 = now.getMonth() > 3 || (now.getMonth() === 3 && now.getDate() >= 6);
    expect(addBudget).toHaveBeenCalledWith(expect.objectContaining({
      startDate: `${now.getFullYear() + (pastApril6 ? 1 : 0)}-04-06`,
    }));
  });

  it('"another date" takes a typed day, and will not save without one', async () => {
    renderWizard();
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    review();
    fireEvent.click(screen.getByRole('radio', { name: /Another date/ }));

    expect(screen.getByRole('button', { name: 'Save budgets' })).toBeDisabled();
    expect(screen.getByText('Choose the day the budgets run from to save.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('The day the budgets run from'), { target: { value: '2027-07-15' } });
    expect(screen.getByRole('button', { name: 'Save budgets' })).toBeEnabled();
    save();

    await waitFor(() => expect(addBudget).toHaveBeenCalledTimes(1));
    expect(addBudget).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2027-07-15' }));
  });

  /**
   * ONE FROM DATE AND ONE TO DATE (owner, 7 Nov 2026 evening): the dates
   * belong to the set. The budgets this save is not changing MOVE to them —
   * said with a count and where they run from today, never offered — and
   * an "until" goes on every row.
   */
  it('moves the budgets it is not changing to the chosen start, amounts untouched, and says so', async () => {
    renderWizard([budgetOf({ id: 'b-1', categoryId: 'det-dining', amount: 60 })]);
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    review();

    expect(screen.queryByRole('checkbox', { name: /Also move/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('redate-notice')).toHaveTextContent(
      'The 1 budget not being changed moves to these dates too — it runs from the calendar month today; the amounts stay as they are.'
    );
    const row = screen.getByText('Budgets to re-date').closest('div') as HTMLElement;
    expect(within(row).getByText('1')).toBeInTheDocument();
    save();

    await waitFor(() => expect(updateBudget).toHaveBeenCalledWith('b-1', { startDate: firstOfThisMonth(), endDate: null }));
    expect(addBudget).toHaveBeenCalledWith(expect.objectContaining({ startDate: firstOfThisMonth(), endDate: null }));
    expect(toast.showSuccess).toHaveBeenCalledWith('2 budgets saved.', 'Budgets updated');
  });

  it('re-dating alone is a save: nothing typed, a budget that runs from another day', async () => {
    renderWizard([budgetOf({ id: 'b-1', categoryId: 'det-dining', amount: 60 })]);
    chooseMonthly();
    review();

    expect(screen.getByRole('button', { name: 'Save budgets' })).toBeEnabled();
    save();

    await waitFor(() => expect(updateBudget).toHaveBeenCalledWith('b-1', { startDate: firstOfThisMonth(), endDate: null }));
    expect(addBudget).not.toHaveBeenCalled();
  });

  it('an until goes on every row, and one before the start will not save', async () => {
    renderWizard([budgetOf({ id: 'b-1', categoryId: 'det-dining', amount: 60, startDate: firstOfThisMonth(), createdAt: new Date() })]);
    chooseMonthly();
    fireEvent.change(boxFor('Food Shopping'), { target: { value: '90' } });
    review();

    fireEvent.change(screen.getByLabelText('The day the budgets stop'), { target: { value: '2020-01-01' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Until is before the day the budgets run from.');
    expect(screen.getByRole('button', { name: 'Save budgets' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('The day the budgets stop'), { target: { value: '2099-12-31' } });
    expect(screen.getByRole('button', { name: 'Save budgets' })).toBeEnabled();
    save();

    await waitFor(() => expect(addBudget).toHaveBeenCalledWith(expect.objectContaining({ startDate: firstOfThisMonth(), endDate: '2099-12-31' })));
    // The dining budget already ran from the chosen day; the new end alone moves it.
    expect(updateBudget).toHaveBeenCalledWith('b-1', { startDate: firstOfThisMonth(), endDate: '2099-12-31' });
  });
});
