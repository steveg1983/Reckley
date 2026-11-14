/**
 * "NEGATIVES IN RED" — the person's choice, off unless ticked, and ONE choice.
 *
 * Owner, 14 Nov 2026, of the Accounts page: a tick box beside "Hide decimals"
 * so "all negative balances show in red if they wish". The same day he asked
 * for it "throughout" and ruled it a single setting: tick it on any page and
 * every page follows. The design pass's rule is that colour marks what needs
 * attention, so the default stays plain; what these hold is that the choice
 * is real, is the same switch wherever it is drawn, and paints only what is
 * actually below zero.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

const { store, listeners } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  listeners: new Set<() => void>(),
}));
vi.mock('../../services/preferencesService', () => ({
  preferences: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  }
}));

import {
  NEGATIVE_FIGURE_CLASS,
  NegativesInRedToggle,
  isBelowZero,
  useNegativeTone,
} from '../NegativesInRedContext';
import { AccountBalanceCell } from '../../components/AccountRowColumns';

const PLAIN = 'text-gray-900 dark:text-white';
const KEY = 'money_management_negatives_in_red';
const FIRST_DAY_KEY = 'money_management_negatives_in_red_accounts';

function Figure({ amount, label }: { amount: number | null; label: string }): React.JSX.Element {
  const tone = useNegativeTone();
  return <span data-testid={label} className={tone(amount, PLAIN)}>{label}</span>;
}

/** Two "pages" at once: each has its own tick box and its own figure. */
const twoPages = (): void => {
  render(
    <>
      <section aria-label="accounts"><NegativesInRedToggle /><Figure amount={-250} label="owed" /></section>
      <section aria-label="dashboard"><NegativesInRedToggle /><Figure amount={-40} label="overdrawn" /></section>
      <Figure amount={250} label="held" />
      <Figure amount={0} label="nothing" />
      <Figure amount={-0.001} label="dust" />
      <Figure amount={null} label="unknown" />
    </>
  );
};

beforeEach(() => { store.clear(); listeners.clear(); });
afterEach(cleanup);

describe('negatives in red', () => {
  it('is off until ticked: a debt is drawn like any other figure', () => {
    twoPages();
    for (const box of screen.getAllByLabelText('Negatives in red')) expect(box).not.toBeChecked();
    expect(screen.getByTestId('owed').className).toBe(PLAIN);
  });

  it('ticked on one page, every page follows: it is one switch', () => {
    twoPages();
    const [onAccounts, onDashboard] = screen.getAllByLabelText('Negatives in red');
    fireEvent.click(onAccounts);

    expect(onDashboard).toBeChecked();
    expect(screen.getByTestId('owed').className).toBe(NEGATIVE_FIGURE_CLASS);
    expect(screen.getByTestId('overdrawn').className).toBe(NEGATIVE_FIGURE_CLASS);
    expect(store.get(KEY)).toBe('true');

    // And off again from the other page.
    fireEvent.click(onDashboard);
    expect(onAccounts).not.toBeChecked();
    expect(screen.getByTestId('owed').className).toBe(PLAIN);
    expect(store.get(KEY)).toBe('false');
  });

  it('paints only what is below zero', () => {
    store.set(KEY, 'true');
    twoPages();
    for (const label of ['held', 'nothing', 'unknown']) {
      expect(screen.getByTestId(label).className).toBe(PLAIN);
    }
    // A float's dust is a balance of nothing, not a debt.
    expect(screen.getByTestId('dust').className).toBe(PLAIN);
    expect(isBelowZero(-0.005)).toBe(true);
    expect(isBelowZero(-0.004)).toBe(false);
    expect(isBelowZero(undefined)).toBe(false);
  });

  it('a change that arrives from elsewhere (another device, the document loading) is followed', () => {
    twoPages();
    expect(screen.getByTestId('owed').className).toBe(PLAIN);
    act(() => {
      store.set(KEY, 'true');
      for (const listener of listeners) listener();
    });
    expect(screen.getByTestId('owed').className).toBe(NEGATIVE_FIGURE_CLASS);
  });
});

describe('the first day\'s choice, made on the Accounts page alone, carries over', () => {
  it('is honoured while the app-wide setting has never been written', () => {
    store.set(FIRST_DAY_KEY, 'true');
    twoPages();
    expect(screen.getAllByLabelText('Negatives in red')[0]).toBeChecked();
    expect(screen.getByTestId('overdrawn').className).toBe(NEGATIVE_FIGURE_CLASS);
  });

  it('and does not undo a later untick', () => {
    store.set(FIRST_DAY_KEY, 'true');
    twoPages();
    fireEvent.click(screen.getAllByLabelText('Negatives in red')[0]);

    expect(store.get(KEY)).toBe('false');
    expect(screen.getByTestId('owed').className).toBe(PLAIN);
    cleanup();

    twoPages();
    expect(screen.getAllByLabelText('Negatives in red')[0]).not.toBeChecked();
  });
});

describe('the Accounts row\'s balance cell follows it', () => {
  const cell = (ticked: boolean, amount: number | null | undefined): HTMLElement => {
    if (ticked) store.set(KEY, 'true');
    render(<AccountBalanceCell label="Account Bal" value="FIGURE" amount={amount} />);
    return screen.getByText('FIGURE');
  };

  it('red for a negative amount when ticked', () => {
    expect(cell(true, -1250.5)).toHaveClass('text-red-600', 'dark:text-red-400');
  });

  it('plain for a negative amount when not ticked', () => {
    expect(cell(false, -1250.5)).toHaveClass('text-gray-900');
  });

  it('plain when the cell is given no number: the string alone never decides', () => {
    expect(cell(true, undefined)).toHaveClass('text-gray-900');
  });
});
