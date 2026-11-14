/**
 * "NEGATIVES IN RED" — the person's choice, off unless ticked.
 *
 * Owner, 14 Nov 2026, of the Accounts page: a tick box beside "Hide decimals"
 * so "all negative balances show in red if they wish". The design pass's rule
 * is that colour marks what needs attention, so the default stays plain; what
 * these hold is that the choice is real, remembered per page, and paints only
 * what is actually below zero.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const store = new Map<string, string>();
vi.mock('../../services/preferencesService', () => ({
  preferences: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  }
}));

import {
  NEGATIVE_FIGURE_CLASS,
  NegativesInRedScope,
  NegativesInRedToggle,
  useNegativeTone,
} from '../NegativesInRedContext';
import { AccountBalanceCell } from '../../components/AccountRowColumns';

const PLAIN = 'text-gray-900 dark:text-white';

function Figure({ amount, label }: { amount: number | null; label: string }): React.JSX.Element {
  const tone = useNegativeTone();
  return <span data-testid={label} className={tone(amount, PLAIN)}>{label}</span>;
}

const page = (name = 'accounts'): void => {
  render(
    <NegativesInRedScope page={name}>
      <NegativesInRedToggle />
      <Figure amount={-250} label="owed" />
      <Figure amount={250} label="held" />
      <Figure amount={0} label="nothing" />
      <Figure amount={-0.001} label="dust" />
      <Figure amount={null} label="unknown" />
    </NegativesInRedScope>
  );
};

beforeEach(() => store.clear());
afterEach(cleanup);

describe('negatives in red', () => {
  it('is off until ticked: a debt is drawn like any other figure', () => {
    page();
    expect(screen.getByLabelText('Negatives in red')).not.toBeChecked();
    expect(screen.getByTestId('owed')).toHaveClass('text-gray-900');
    expect(screen.getByTestId('owed')).not.toHaveClass('text-red-600');
  });

  it('ticked: what is below zero turns red, and nothing else does', () => {
    page();
    fireEvent.click(screen.getByLabelText('Negatives in red'));

    expect(screen.getByTestId('owed').className).toBe(NEGATIVE_FIGURE_CLASS);
    for (const label of ['held', 'nothing', 'unknown']) {
      expect(screen.getByTestId(label).className).toBe(PLAIN);
    }
    // A float's dust is a balance of nothing, not a debt.
    expect(screen.getByTestId('dust').className).toBe(PLAIN);
  });

  it('is remembered, under the page\'s own key', () => {
    page();
    fireEvent.click(screen.getByLabelText('Negatives in red'));
    expect(store.get('money_management_negatives_in_red_accounts')).toBe('true');
    cleanup();

    page();
    expect(screen.getByLabelText('Negatives in red')).toBeChecked();
    expect(screen.getByTestId('owed')).toHaveClass('text-red-600');
    cleanup();

    // Another page has its own answer.
    page('dashboard');
    expect(screen.getByLabelText('Negatives in red')).not.toBeChecked();
  });

  it('unticking puts the plain colour back', () => {
    page();
    const box = screen.getByLabelText('Negatives in red');
    fireEvent.click(box);
    fireEvent.click(box);
    expect(screen.getByTestId('owed').className).toBe(PLAIN);
    expect(store.get('money_management_negatives_in_red_accounts')).toBe('false');
  });

  it('outside any scope nothing is tinted', () => {
    render(<Figure amount={-250} label="owed" />);
    expect(screen.getByTestId('owed').className).toBe(PLAIN);
  });
});

describe('the Accounts row\'s balance cell follows it', () => {
  const cell = (ticked: boolean, amount: number | null | undefined): HTMLElement => {
    if (ticked) store.set('money_management_negatives_in_red_accounts', 'true');
    render(
      <NegativesInRedScope page="accounts">
        <AccountBalanceCell label="Account Bal" value="FIGURE" amount={amount} />
      </NegativesInRedScope>
    );
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
