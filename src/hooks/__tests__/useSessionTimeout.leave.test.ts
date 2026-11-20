import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { securityService } from '../../services/securityService';
import { useSessionTimeout, SESSION_ENDS_ON_LEAVE } from '../useSessionTimeout';
import { holdSignOutForBankConnection, releaseBankConnectionHold } from '../../utils/bankConnectionHold';

/**
 * "When I leave the app" (owner's ask, 19 Nov 2026): signed out whenever the
 * page is left for longer than a short grace — on return, or on the next
 * launch after the app was closed.
 */
const LEFT_AT_KEY = 'ledger_session_left_at';

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

function chooseTimeout(minutes: number): void {
  vi.spyOn(securityService, 'getSecuritySettings').mockReturnValue({
    sessionTimeout: minutes,
    failedAttempts: 0
  });
}

describe('useSessionTimeout — when I leave the app', () => {
  beforeEach(() => {
    // The suite's own setup may already have mocked the date; start clean.
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
    window.localStorage.removeItem(LEFT_AT_KEY);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.localStorage.removeItem(LEFT_AT_KEY);
  });

  it('signs out on return after the app was left for more than the grace', () => {
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    const onTimeout = vi.fn();
    renderHook(() => useSessionTimeout(onTimeout));

    setVisibility('hidden');
    vi.setSystemTime(new Date('2026-11-19T12:05:00Z'));
    setVisibility('visible');

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not sign out for a glance away inside the grace', () => {
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    const onTimeout = vi.fn();
    renderHook(() => useSessionTimeout(onTimeout));

    setVisibility('hidden');
    vi.setSystemTime(new Date('2026-11-19T12:00:10Z'));
    setVisibility('visible');

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('signs out at launch when the app was closed while left', () => {
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    window.localStorage.setItem(LEFT_AT_KEY, String(Date.parse('2026-11-19T09:00:00Z')));
    const onTimeout = vi.fn();
    renderHook(() => useSessionTimeout(onTimeout));

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(LEFT_AT_KEY)).toBeNull();
  });

  it('a bank connection in progress holds off the sign-out', () => {
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    const onTimeout = vi.fn();
    renderHook(() => useSessionTimeout(onTimeout));

    holdSignOutForBankConnection();
    setVisibility('hidden');
    vi.setSystemTime(new Date('2026-11-19T12:04:00Z'));
    setVisibility('visible');

    expect(onTimeout).not.toHaveBeenCalled();
    releaseBankConnectionHold();
  });

  it('a hold abandoned at the bank lapses, and leaving signs out again', () => {
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    const onTimeout = vi.fn();
    renderHook(() => useSessionTimeout(onTimeout));

    holdSignOutForBankConnection();
    setVisibility('hidden');
    vi.setSystemTime(new Date('2026-11-19T12:20:00Z'));
    setVisibility('visible');

    expect(onTimeout).toHaveBeenCalledTimes(1);
    releaseBankConnectionHold();
  });

  it('any other choice clears the mark, so switching away never signs out at the next launch', () => {
    chooseTimeout(30);
    window.localStorage.setItem(LEFT_AT_KEY, String(Date.parse('2026-11-19T09:00:00Z')));
    const onTimeout = vi.fn();
    renderHook(() => useSessionTimeout(onTimeout));

    expect(onTimeout).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LEFT_AT_KEY)).toBeNull();
  });
});
