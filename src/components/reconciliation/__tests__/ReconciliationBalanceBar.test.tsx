import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../../test/testUtils';
import ReconciliationBalanceBar from '../ReconciliationBalanceBar';
import { NEXT_ACTION_YELLOW } from '../../../design-system/nextActionYellow';
import { CONFIRM_BALANCE_HINT_ID } from '../nextActionYellow';

/**
 * The closing balance — the statement's ending figure — is the only number on
 * this bar a person can type, and until recently it was write-only: once any
 * number existed there was no way back to "no closing balance" and a Difference
 * of N/A. These tests hold the way back open.
 *
 * The symbol itself changed on 15 August, on Claude Design's §4: an em-dash,
 * not "N/A", which is an abbreviation the rest of the app does not use. What
 * these tests pin is unchanged — that "not known" and "zero" stay different
 * statements — so only the character moved.
 *
 * Every figure here is invented: this repo is public.
 */
describe('ReconciliationBalanceBar', () => {
  const onBankBalanceChange = vi.fn();
  const onConfirmBalance = vi.fn();
  const onBalanceEdited = vi.fn();

  const renderBar = (
    bankBalance: number | null,
    extra: Partial<React.ComponentProps<typeof ReconciliationBalanceBar>> = {}
  ) =>
    renderWithProviders(
      <ReconciliationBalanceBar
        bankBalance={bankBalance}
        accountBalance={250}
        clearedBalance={200}
        onBankBalanceChange={onBankBalanceChange}
        onConfirmBalance={onConfirmBalance}
        onBalanceEdited={onBalanceEdited}
        {...extra}
      />
    );

  const openEditor = (): void => {
    fireEvent.click(screen.getByTitle('Click to change or remove'));
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * FOLDED AWAY ON A PHONE (owner, 12 Nov 2026): on the Duo's front screen this
   * sticky bar hid the transactions it is there to reconcile. An arrow folds it
   * to one line and brings it back.
   */
  describe('folds to one line on a phone', () => {
    it('starts whole, with a labelled way to fold it that is not drawn from md up', () => {
      renderBar(220);
      const hide = screen.getByRole('button', { name: /Hide balances/ });
      expect(hide).toHaveAttribute('aria-expanded', 'true');
      expect(hide.parentElement).toHaveClass('md:hidden');
      // ABOVE the figures. Under them, the box's foot sat behind the nav pill
      // on the Duo's front screen and the control could not be reached.
      const closing = screen.getByText('Closing Balance');
      expect(hide.compareDocumentPosition(closing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Show balances/ })).not.toBeInTheDocument();
    });

    it('folded: one line with the Difference and the way back, the figures hidden only below md', () => {
      renderBar(220);
      fireEvent.click(screen.getByRole('button', { name: /Hide balances/ }));

      const show = screen.getByRole('button', { name: /Show balances/ });
      expect(show).toHaveAttribute('aria-expanded', 'false');
      const line = show.parentElement!;
      expect(line).toHaveClass('md:hidden');
      // 220 closing against 200 cleared: a real difference, in the expense tone.
      expect(line).toHaveTextContent(/Difference/);
      expect(line.querySelector('span')).toHaveClass('text-red-600');

      // The figures stay mounted — hidden on a phone, whole from md up, so an
      // opened Duo cannot be left with a folded bar and no arrow.
      const figures = document.getElementById(show.getAttribute('aria-controls')!)!;
      expect(figures).toHaveClass('hidden', 'md:block');
      expect(figures).toContainElement(screen.getByText('Closing Balance'));
    });

    it('unfolds to exactly what it was, the hint Finalise is described by included', () => {
      renderBar(220);
      fireEvent.click(screen.getByRole('button', { name: /Hide balances/ }));
      // Folding unmounts nothing: the described-by target is still there.
      expect(document.getElementById(CONFIRM_BALANCE_HINT_ID)).not.toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /Show balances/ }));
      const figures = screen.getByText('Closing Balance').closest('[id]')!;
      expect(figures).not.toHaveClass('hidden');
      expect(screen.getByRole('button', { name: /Hide balances/ })).toBeInTheDocument();
    });

    it('folded with no closing balance says not known, never zero', () => {
      renderBar(null);
      fireEvent.click(screen.getByRole('button', { name: /Hide balances/ }));
      expect(screen.getByRole('button', { name: /Show balances/ }).parentElement).toHaveTextContent('Difference —');
    });
  });

  it('shows the difference against a recorded bank balance', () => {
    renderBar(220);
    expect(screen.getByText('Difference')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('shows an em-dash and an invitation to type one when there is no bank balance', () => {
    renderBar(null);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Enter balance')).toBeInTheDocument();
  });

  it('reports a removal as null, not as a number', () => {
    renderBar(220);
    openEditor();
    fireEvent.click(screen.getByRole('button', { name: /Remove the closing balance/ }));

    expect(onBankBalanceChange).toHaveBeenCalledTimes(1);
    expect(onBankBalanceChange).toHaveBeenCalledWith(null);
  });

  it('names the consequence of removing rather than counting anything', () => {
    renderBar(220);
    openEditor();
    expect(
      screen.getByRole('button', {
        name: 'Remove the closing balance. Difference goes back to not known until you enter another.'
      })
    ).toBeInTheDocument();
  });

  it('falls straight back to an em-dash on removal, before the write has landed', () => {
    // The prop still says 220 — the parent has not saved yet. The bar must
    // already show the state the user asked for, or the click looks ignored.
    renderBar(220);
    openEditor();
    fireEvent.click(screen.getByRole('button', { name: /Remove the closing balance/ }));

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Enter balance')).toBeInTheDocument();
  });

  it('offers no removal until there is something to remove', () => {
    renderBar(null);
    fireEvent.click(screen.getByText('Enter balance'));
    expect(screen.queryByRole('button', { name: /Remove the closing balance/ })).not.toBeInTheDocument();
  });

  it('keeps the editor open while focus moves onto Remove', () => {
    renderBar(220);
    openEditor();
    const input = screen.getByLabelText('Closing balance');
    const remove = screen.getByRole('button', { name: /Remove the closing balance/ });

    fireEvent.blur(input, { relatedTarget: remove });

    expect(screen.getByRole('button', { name: /Remove the closing balance/ })).toBeInTheDocument();
    expect(onBankBalanceChange).not.toHaveBeenCalled();
  });

  it('leaves the recorded figure alone when the field is emptied and abandoned', () => {
    // Emptying the box is not removing: that is what Remove is for.
    renderBar(220);
    openEditor();
    const input = screen.getByLabelText('Closing balance');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(onBankBalanceChange).not.toHaveBeenCalled();
    expect(screen.getByTitle('Click to change or remove')).toBeInTheDocument();
  });

  it('still writes an ordinary edit as a number', () => {
    renderBar(220);
    openEditor();
    const input = screen.getByLabelText('Closing balance');
    fireEvent.change(input, { target: { value: '180.55' } });
    fireEvent.blur(input);

    expect(onBankBalanceChange).toHaveBeenCalledWith(180.55);
  });

  it('accepts a negative balance for an overdrawn account', () => {
    renderBar(null);
    fireEvent.click(screen.getByText('Enter balance'));
    const input = screen.getByLabelText('Closing balance');
    fireEvent.change(input, { target: { value: '-42.10' } });
    fireEvent.blur(input);

    expect(onBankBalanceChange).toHaveBeenCalledWith(-42.1);
  });

  describe('confirming the figure', () => {
    it('offers Confirm against a figure, and says what is at stake until then', () => {
      renderBar(220);
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
      expect(
        screen.getByText(/Confirm the closing balance to finish\. Until you do, your marks stay a working list/)
      ).toBeInTheDocument();
    });

    it('offers Confirm against £0.00, which is a balance like any other', () => {
      renderBar(0);
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      expect(onConfirmBalance).toHaveBeenCalledWith(0);
    });

    it('says so once confirmed, and stops asking', () => {
      renderBar(220, { balanceConfirmed: true });
      expect(screen.getByText('Confirmed')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
      expect(screen.queryByText(/Confirm the closing balance to finish/)).not.toBeInTheDocument();
    });

    it('reports an edit so the confirmation can lapse', () => {
      renderBar(220, { balanceConfirmed: true });
      openEditor();
      fireEvent.change(screen.getByLabelText('Closing balance'), { target: { value: '221' } });
      expect(onBalanceEdited).toHaveBeenCalled();
    });

    it('Enter records the typed figure AND confirms it', () => {
      renderBar(220);
      openEditor();
      const input = screen.getByLabelText('Closing balance');
      fireEvent.change(input, { target: { value: '199.99' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onBankBalanceChange).toHaveBeenCalledWith(199.99);
      expect(onConfirmBalance).toHaveBeenCalledWith(199.99);
    });

    it('shows last time’s two facts when both are known', () => {
      renderBar(220, {
        lastReconciledDate: new Date('2026-04-30'),
        lastReconciledBalance: 180.4,
      });
      expect(screen.getByText(/Last reconciled: 30\/04\/2026 · ending balance £180\.40/)).toBeInTheDocument();
    });

    it('says nothing about last time when only the date is known', () => {
      // A date with no figure is a claim nobody can check.
      renderBar(220, { lastReconciledDate: new Date('2026-04-30') });
      expect(screen.queryByText(/Last reconciled/)).not.toBeInTheDocument();
    });

    it('names the right consequence for Remove when a last balance would take over', () => {
      renderBar(220, { lastReconciledBalance: 180.4 });
      openEditor();
      expect(
        screen.getByRole('button', {
          name: /Difference falls back to the balance your last reconciliation ended on/
        })
      ).toBeInTheDocument();
    });
  });

  /**
   * Money's own word for the figure. It is the statement's CLOSING balance —
   * what the account ended the period on — and not the account's live "Bank
   * Bal" on the Accounts page, which is whatever the feed last said and which
   * nobody is asked to agree to.
   */
  describe('the name of the figure', () => {
    it('calls it the Closing Balance', () => {
      renderBar(220);
      expect(screen.getByText('Closing Balance')).toBeInTheDocument();
      expect(screen.queryByText('Bank Balance')).not.toBeInTheDocument();
    });

    it('calls the box the same thing when it is open', () => {
      renderBar(220);
      openEditor();
      expect(screen.getByLabelText('Closing balance')).toBeInTheDocument();
    });

    it('says it in the consequences too, so one word is used throughout', () => {
      renderBar(220);
      expect(screen.getByText(/Confirm the closing balance to finish/)).toBeInTheDocument();
      openEditor();
      expect(screen.getByRole('button', { name: /Remove the closing balance/ })).toBeInTheDocument();
    });
  });

  /**
   * The cell is a COLUMN.
   *
   * The figure and Confirm are both inline-level, so the old `text-center`
   * block set them side by side the moment the cell was wide enough for both:
   * the amount slid off-centre, wedged against a button, out of step with the
   * three figures beside it. These tests are structural — they assert the
   * stacking order and that the two states of the Confirm slot occupy the same
   * box, because "the bar must not jump under the cursor" is a claim about
   * geometry that a screenshot cannot keep honest.
   */
  describe('the closing-balance column', () => {
    const cell = (): HTMLElement => {
      const label = screen.getByText('Closing Balance');
      const parent = label.parentElement;
      if (!(parent instanceof HTMLElement)) throw new Error('the label has no cell around it');
      return parent;
    };

    /** The box the Confirm slot occupies, in both of its states. */
    const SLOT_METRICS = ['mt-1', 'px-2', 'py-0.5', 'text-xs', 'font-medium', 'rounded', 'border'];

    it('stacks label, then amount, then Confirm — one per line, centred', () => {
      renderBar(220);
      expect(cell()).toHaveClass('flex', 'flex-col', 'items-center');

      const stacked = Array.from(cell().children);
      expect(stacked).toHaveLength(3);
      expect(stacked[0]).toHaveTextContent('Closing Balance');
      expect(stacked[1]).toBe(screen.getByTitle('Click to change or remove'));
      expect(stacked[2]).toBe(screen.getByRole('button', { name: 'Confirm' }));
    });

    it('keeps the order once the figure is agreed to', () => {
      renderBar(220, { balanceConfirmed: true });
      const stacked = Array.from(cell().children);
      expect(stacked).toHaveLength(3);
      expect(stacked[1]).toBe(screen.getByTitle('Click to change or remove'));
      expect(stacked[2]).toBe(screen.getByText('Confirmed'));
    });

    it('gives Confirm and Confirmed the same box, so agreeing cannot move the bar', () => {
      // A sticky bar that changes height at the moment of the click moves
      // everything under the cursor. Both states carry the same margin,
      // padding, type and border WIDTH — the settled one in transparent.
      const asking = renderBar(220);
      const confirm = screen.getByRole('button', { name: 'Confirm' });
      SLOT_METRICS.forEach(metric => expect(confirm).toHaveClass(metric));
      asking.unmount();

      renderBar(220, { balanceConfirmed: true });
      const confirmed = screen.getByText('Confirmed');
      SLOT_METRICS.forEach(metric => expect(confirmed).toHaveClass(metric));
      expect(confirmed).toHaveClass('border-transparent');
    });

    it('lets the editor span the cell rather than shrinking to its content', () => {
      // A centring flex column sizes its children to their content; without
      // w-full the input would be narrower than the figure it replaced.
      renderBar(220);
      openEditor();
      const form = screen.getByLabelText('Closing balance').parentElement;
      expect(form).toHaveClass('w-full');
    });
  });

  /**
   * The yellow that means "your next action is here", on the bar's side of the
   * thread: the bar wears it while the figure is unconfirmed, and hands it to
   * Finalize the moment it is agreed to. That the two are the SAME yellow, and
   * that only ever one of them wears it, is asserted where both are on screen
   * at once — src/pages/__tests__/Reconciliation.yellowThread.test.tsx.
   */
  describe('the yellow that means "your next action is here"', () => {
    /** Every amber utility an element carries, order-insensitive. */
    const amber = (el: Element): string[] =>
      el.className.split(/\s+/).filter(cls => cls.includes('amber-')).sort();

    const TOKEN = NEXT_ACTION_YELLOW.split(/\s+/).filter(Boolean).sort();

    it('the unconfirmed figure wears the shared token, whole', () => {
      renderBar(220);
      expect(amber(screen.getByTitle('Click to change or remove'))).toEqual(TOKEN);
    });

    it('so does the invitation to type one, because that is unconfirmed too', () => {
      renderBar(null);
      expect(amber(screen.getByRole('button', { name: 'Enter balance' }))).toEqual(TOKEN);
    });

    it('so does the open editor while nothing has been agreed to', () => {
      renderBar(220);
      openEditor();
      expect(amber(screen.getByLabelText('Closing balance'))).toEqual(TOKEN);
    });

    it('leaves the open editor alone while the figure in it still stands agreed', () => {
      // Opening the box is not editing it. The lapse belongs to the first
      // keystroke, and the parent is what reports it back as unconfirmed.
      renderBar(220, { balanceConfirmed: true });
      openEditor();
      expect(amber(screen.getByLabelText('Closing balance'))).toEqual([]);
    });

    it('settles to the bar’s ordinary styling once confirmed', () => {
      renderBar(220, { balanceConfirmed: true });
      const figure = screen.getByTitle('Click to change or remove');
      expect(amber(figure)).toEqual([]);
      expect(figure).toHaveClass('text-gray-900');
    });

    it('carries a border width while it is yellow, so resolving cannot move it', () => {
      renderBar(220);
      expect(screen.getByTitle('Click to change or remove')).toHaveClass('border');
    });

    it('carries the same border width once resolved, in transparent', () => {
      // Without this the figure would jump two pixels the instant it was
      // agreed to, and the whole four-up row would shuffle with it.
      renderBar(220, { balanceConfirmed: true });
      expect(screen.getByTitle('Click to change or remove'))
        .toHaveClass('border', 'border-transparent');
    });

    it('never leaves the colour to carry the message on its own', () => {
      renderBar(220);
      expect(screen.getByTitle('Click to change or remove'))
        .toHaveAttribute('aria-describedby', CONFIRM_BALANCE_HINT_ID);
      expect(document.getElementById(CONFIRM_BALANCE_HINT_ID))
        .toHaveTextContent(/Confirm the closing balance to finish/);
    });

    it('stops describing a reason once there is none to describe', () => {
      // A dangling aria-describedby is worse than none: it promises an
      // explanation the screen reader will not find.
      renderBar(220, { balanceConfirmed: true });
      expect(screen.getByTitle('Click to change or remove')).not.toHaveAttribute('aria-describedby');
      expect(document.getElementById(CONFIRM_BALANCE_HINT_ID)).toBeNull();
    });
  });
});
