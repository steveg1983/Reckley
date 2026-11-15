import { describe, it, expect } from 'vitest';
import { isPastWarningLine } from './warningLine';

/**
 * THE WARNING LINE — one rule for the Dashboard's card and the phone's push.
 */
describe('isPastWarningLine', () => {
  const current = { type: 'current', lowBalanceAlertEnabled: true, lowBalanceThreshold: 500 };
  const card = { type: 'credit', lowBalanceAlertEnabled: true, lowBalanceThreshold: 500 };

  it('an account is past its line when its balance is below the level set', () => {
    expect(isPastWarningLine(current, 499.99)).toBe(true);
    expect(isPastWarningLine(current, 500)).toBe(false);
    expect(isPastWarningLine(current, -20)).toBe(true);
  });

  it('on a card the same number means spending: past the line when more than that is owed', () => {
    expect(isPastWarningLine(card, -500.01)).toBe(true);
    expect(isPastWarningLine(card, -500)).toBe(false);
    expect(isPastWarningLine(card, -20)).toBe(false);
  });

  it('nothing is past a line that was never switched on or never given a level', () => {
    expect(isPastWarningLine({ ...current, lowBalanceAlertEnabled: false }, -1000)).toBe(false);
    expect(isPastWarningLine({ ...current, lowBalanceThreshold: null }, -1000)).toBe(false);
    expect(isPastWarningLine({ ...current, lowBalanceThreshold: undefined }, -1000)).toBe(false);
  });
});
