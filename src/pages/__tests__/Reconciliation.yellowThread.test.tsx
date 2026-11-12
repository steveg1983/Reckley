/**
 * "The yellow is wherever your next action is."
 *
 * ── THE DESIGN, IN ONE LINE ─────────────────────────────────────────────────
 * While the closing balance is unconfirmed the app is ASKING, so the balance
 * bar's closing-balance affordance wears the yellow and Finalize sits dimmed
 * and disabled. Agree to the figure and the bar goes quiet while Finalize
 * lights up in the same yellow, because pressing it is now the only thing left
 * to do. The colour travels from the question to the action.
 *
 * It used to sit on BOTH at once, meaning "blocked". Live testing killed that:
 * two amber controls read as two separate refusals, and the user's actual next
 * step — Confirm, in quiet blue on the bar — was the least visible thing on
 * screen.
 *
 * ── WHY THESE TESTS ARE SHAPED LIKE THIS ────────────────────────────────────
 * They are structural, not cosmetic. They do not check that anything is
 * amber-100; they check WHICH element carries the shared token's exact amber
 * vocabulary, and that the other carries NONE — asserted as one object per
 * state so a failure names both sides at once. Two hand-maintained class lists
 * cannot satisfy that for long: hardcode a near-miss, forget to drop the token
 * on one branch, or paint both at once, and the comparison goes red before the
 * screen has to.
 *
 * Every name and figure here is invented: this repo is public.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PreferencesProvider } from '../../contexts/PreferencesContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { NotificationProvider } from '../../contexts/NotificationContext';
import Reconciliation from '../Reconciliation';
import { NEXT_ACTION_YELLOW } from '../../design-system/nextActionYellow';
import { CONFIRM_BALANCE_HINT_ID } from '../../components/reconciliation/nextActionYellow';
import { __setAppContextValue, __resetAppContextValue } from '../../test/mocks/AppContextSupabase';
import type { Account, Transaction } from '../../types';

const ACCOUNT: Account = {
  id: 'acc-thread',
  name: 'Everyday Invented',
  type: 'current',
  balance: 0,
  currency: 'GBP',
  institution: 'Invented Bank',
  lastUpdated: new Date('2026-05-01'),
  openingBalance: 0,
  isActive: true,
  bankBalance: 40,
  bankBalanceDate: '2026-05-01',
};

const MARKED_ROW: Transaction = {
  id: 'txn-thread-1',
  accountId: ACCOUNT.id,
  date: new Date('2026-05-04'),
  amount: 40,
  description: 'Invented deposit',
  category: 'det-sundries',
  type: 'income',
  cleared: true,
  reconciled: false,
};

const openAccount = (account: Account = ACCOUNT): void => {
  __setAppContextValue({
    accounts: [account],
    transactions: [MARKED_ROW],
    updateAccount: vi.fn(),
    finalizeReconciliation: vi.fn(async () => 1),
    isLoading: false,
  });
  render(
    <MemoryRouter initialEntries={[`/reconciliation?account=${account.id}`]}>
      <PreferencesProvider>
        <ToastProvider>
          {/* The page mounts EditTransactionModal, which reads the notification
              context even while closed. */}
          <NotificationProvider>
            <Reconciliation />
          </NotificationProvider>
        </ToastProvider>
      </PreferencesProvider>
    </MemoryRouter>
  );
};

/** Every amber utility an element carries, order-insensitive. */
const amber = (el: Element): string[] =>
  el.className.split(/\s+/).filter(cls => cls.includes('amber-')).sort();

const TOKEN = NEXT_ACTION_YELLOW.split(/\s+/).filter(Boolean).sort();
const WEARING = TOKEN.join(' ');
const BARE = '';

const finalizeButton = (): HTMLElement =>
  screen.getByRole('button', { name: /Finalise Reconciliation/ });
const figure = (): HTMLElement => screen.getByTitle('Click to change or remove');

/**
 * Whatever the closing-balance cell is currently offering: the figure, the open
 * editor, or the invitation to type one. All three are the same affordance in
 * different states, and the yellow belongs to whichever is on screen.
 */
const closingBalanceAffordance = (): HTMLElement =>
  screen.queryByTitle('Click to change or remove')
  ?? screen.queryByLabelText('Closing balance')
  ?? screen.getByRole('button', { name: 'Enter balance' });

/**
 * Who is wearing the yellow, both sides read at once.
 *
 * Compared as ONE object rather than two assertions so that a failure prints
 * the whole state — "both are yellow" and "neither is" are the two ways this
 * design breaks, and neither is legible from a single-element assertion.
 */
const yellowState = (): Record<string, string> => ({
  'closing balance': amber(closingBalanceAffordance()).join(' '),
  Finalize: amber(finalizeButton()).join(' '),
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  __resetAppContextValue();
});

describe('Reconciliation — the yellow that travels', () => {
  it('the shared token is a real treatment: border, text and wash, in both themes', () => {
    // Without this guard the comparisons below could be satisfied by emptying
    // the token — two elements agreeing that neither is yellow at all.
    const has = (pattern: RegExp): boolean => TOKEN.some(cls => pattern.test(cls));
    expect(has(/^bg-amber-/)).toBe(true);
    expect(has(/^text-amber-/)).toBe(true);
    expect(has(/^border-amber-/)).toBe(true);
    expect(has(/^dark:bg-amber-/)).toBe(true);
    expect(has(/^dark:text-amber-/)).toBe(true);
    expect(has(/^dark:border-amber-/)).toBe(true);
  });

  it('HEADLINE: unconfirmed, the yellow is on the question — and only there', () => {
    openAccount();

    expect(yellowState()).toEqual({ 'closing balance': WEARING, Finalize: BARE });
    expect(finalizeButton()).toBeDisabled();
  });

  it('HEADLINE: confirmed, the yellow has moved to the action — and only there', () => {
    openAccount();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(yellowState()).toEqual({ 'closing balance': BARE, Finalize: WEARING });
    expect(finalizeButton()).toBeEnabled();
  });

  it('the two are never both yellow, and never both quiet, across the whole transition', () => {
    // The exclusivity said as a sequence rather than as two separate states,
    // because the failure this guards against is a branch that sets the token
    // without the other branch clearing it.
    openAccount();
    const seen = [yellowState()];
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    seen.push(yellowState());
    fireEvent.click(figure());
    fireEvent.change(screen.getByLabelText('Closing balance'), { target: { value: '55' } });
    seen.push(yellowState());

    expect(seen).toEqual([
      { 'closing balance': WEARING, Finalize: BARE },
      { 'closing balance': BARE, Finalize: WEARING },
      { 'closing balance': WEARING, Finalize: BARE },
    ]);
    seen.forEach(state => {
      expect(Object.values(state).filter(worn => worn === WEARING)).toHaveLength(1);
    });
  });

  it('Enter in the box moves the yellow in one keystroke', () => {
    // The commonest path: read the statement, type the figure, press Enter.
    openAccount();
    fireEvent.click(figure());
    const box = screen.getByLabelText('Closing balance');
    fireEvent.change(box, { target: { value: '61.25' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(yellowState()).toEqual({ 'closing balance': BARE, Finalize: WEARING });
    expect(finalizeButton()).toBeEnabled();
  });

  it('editing after confirming hands the yellow back to the box, and fades Finalize again', () => {
    openAccount();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(amber(finalizeButton())).toEqual(TOKEN);

    fireEvent.click(figure());
    fireEvent.change(screen.getByLabelText('Closing balance'), { target: { value: '55' } });

    // The box the user is typing in is the affordance now, and the agreement
    // lapsed with the keystroke: the question is open again, so the yellow is
    // back on it and Finalize has gone quiet and disabled.
    expect(yellowState()).toEqual({ 'closing balance': WEARING, Finalize: BARE });
    expect(finalizeButton()).toBeDisabled();
  });

  it('an account with no figure at all is asked in the same yellow', () => {
    openAccount({ ...ACCOUNT, bankBalance: null, bankBalanceDate: null });

    expect(screen.getByRole('button', { name: 'Enter balance' })).toBeInTheDocument();
    expect(yellowState()).toEqual({ 'closing balance': WEARING, Finalize: BARE });
    expect(finalizeButton()).toBeDisabled();
  });

  it('the quiet Finalize is the app’s ordinary dimmed primary, not a faded yellow', () => {
    // A half-strength amber would still read as yellow, which is exactly the
    // ambiguity this design removed. Dimmed the way every other disabled
    // primary in this codebase is dimmed, and carrying no amber at all.
    openAccount();

    const finalize = finalizeButton();
    expect(amber(finalize)).toEqual([]);
    // The ordinary primary is now the ground-aware TOKEN pair (the canon
    // ruling, 22 Aug) — which is a stronger version of what this spec always
    // meant: the quiet Finalize wears the app's one primary, by name.
    expect(finalize).toHaveClass('bg-primary-action', 'text-on-primary-action');
    expect(finalize).toHaveClass('disabled:opacity-50', 'disabled:cursor-not-allowed');
  });

  it('the yellow is never the only signal: the refusal is spoken and structural', () => {
    openAccount();

    expect(figure()).toHaveAttribute('aria-describedby', CONFIRM_BALANCE_HINT_ID);
    expect(finalizeButton()).toHaveAttribute('aria-describedby', CONFIRM_BALANCE_HINT_ID);
    expect(document.getElementById(CONFIRM_BALANCE_HINT_ID))
      .toHaveTextContent(/Confirm the closing balance to finish/);
    // And the refusal itself is carried by the disabled attribute, not by paint.
    expect(finalizeButton()).toBeDisabled();
  });

  it('drops the description when the reason is gone, rather than dangling', () => {
    openAccount();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(figure()).not.toHaveAttribute('aria-describedby');
    expect(finalizeButton()).not.toHaveAttribute('aria-describedby');
    expect(document.getElementById(CONFIRM_BALANCE_HINT_ID)).toBeNull();
  });

  it('Finalize keeps its border width in both states, so the gate opening cannot resize it', () => {
    openAccount();
    expect(finalizeButton()).toHaveClass('border', 'border-transparent');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(finalizeButton()).toHaveClass('border', 'border-amber-300');
  });
});

describe('Reconciliation — Money’s word for the figure', () => {
  it('the bar labels it Closing Balance, and the reconciling screen never says Bank Balance', () => {
    openAccount();
    expect(screen.getByText('Closing Balance')).toBeInTheDocument();
    expect(screen.queryByText('Bank Balance')).not.toBeInTheDocument();
  });

  it('the finalize dialog uses the same word for the same figure', () => {
    // 40 marked against a closing balance of 100 leaves 60 to explain, which is
    // the branch of the dialog that names both figures.
    openAccount({ ...ACCOUNT, bankBalance: 100 });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    fireEvent.click(screen.getByRole('button', { name: /Finalise Reconciliation/ }));

    expect(screen.getByText(/Difference between closing balance and cleared balance/))
      .toBeInTheDocument();
    expect(screen.getByText(/Closing Balance: £100\.00/)).toBeInTheDocument();
  });
});
