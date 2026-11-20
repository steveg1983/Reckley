import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { securityService } from '../../services/securityService';
import {
  useSessionTimeout,
  forgetSessionSeen,
  SESSION_ENDS_ON_LEAVE,
  SESSION_TIMEOUT_CHANGED_EVENT
} from '../useSessionTimeout';
import { holdSignOutForBankConnection, releaseBankConnectionHold } from '../../utils/bankConnectionHold';

/**
 * "When I leave the app" (owner's ask, 19 Nov 2026): signed out whenever the
 * app is left for longer than a short grace — on return, or on the next
 * launch after it was closed. Measured by a heartbeat written while the app
 * is in front, because a phone suspends the app before a write made at the
 * moment of leaving reaches the disk (20 Nov 2026).
 */
const SEEN_KEY = 'ledger_session_seen_at';
const START = Date.parse('2026-11-19T12:00:00Z');

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
    vi.setSystemTime(START);
    window.localStorage.removeItem(SEEN_KEY);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.localStorage.removeItem(SEEN_KEY);
    releaseBankConnectionHold();
  });

  it('writes a heartbeat while the app is in front, which is what a later launch reads', () => {
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    renderHook(() => useSessionTimeout(vi.fn()));

    expect(window.localStorage.getItem(SEEN_KEY)).toBe(String(START));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(window.localStorage.getItem(SEEN_KEY)).toBe(String(START + 5_000));
  });

  it('signs out on return after the app was left for more than the grace', () => {
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    const onTimeout = vi.fn();
    renderHook(() => useSessionTimeout(onTimeout));

    setVisibility('hidden');
    vi.setSystemTime(START + 5 * 60_000);
    setVisibility('visible');

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('catches a suspended app with no event at all: the next tick finds the gap', () => {
    // The phone case: WebKit suspends the page without a usable hidden event.
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    const onTimeout = vi.fn();
    renderHook(() => useSessionTimeout(onTimeout));

    vi.setSystemTime(START + 2 * 60_000);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not sign out for a glance away inside the grace', () => {
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    const onTimeout = vi.fn();
    renderHook(() => useSessionTimeout(onTimeout));

    setVisibility('hidden');
    vi.setSystemTime(START + 10_000);
    setVisibility('visible');

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('a hidden tab writes no heartbeat, so it cannot keep itself signed in', () => {
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    renderHook(() => useSessionTimeout(vi.fn()));

    setVisibility('hidden');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(window.localStorage.getItem(SEEN_KEY)).toBe(String(START));
  });

  it('signs out at launch when the app was closed long ago, and clears the heartbeat', () => {
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    window.localStorage.setItem(SEEN_KEY, String(START - 3 * 3_600_000));
    const onTimeout = vi.fn();
    renderHook(() => useSessionTimeout(onTimeout));

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(SEEN_KEY)).toBeNull();
  });

  it('a reload inside the grace stays signed in', () => {
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    window.localStorage.setItem(SEEN_KEY, String(START - 4_000));
    const onTimeout = vi.fn();
    renderHook(() => useSessionTimeout(onTimeout));

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('at launch, waits for a session to exist before reading the heartbeat', () => {
    // The page mounts before Clerk has loaded, and a sign-out asked for then
    // does nothing.
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    window.localStorage.setItem(SEEN_KEY, String(START - 3 * 3_600_000));
    const onTimeout = vi.fn();
    const { rerender } = renderHook(({ active }) => useSessionTimeout(onTimeout, active), {
      initialProps: { active: false }
    });

    expect(onTimeout).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(SEEN_KEY)).not.toBeNull();

    rerender({ active: true });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('once signed out, the next sign-in is not signed straight back out', () => {
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    window.localStorage.setItem(SEEN_KEY, String(START - 3 * 3_600_000));
    forgetSessionSeen();
    const onTimeout = vi.fn();
    renderHook(() => useSessionTimeout(onTimeout));

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('a bank connection in progress holds off the sign-out', () => {
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    const onTimeout = vi.fn();
    renderHook(() => useSessionTimeout(onTimeout));

    holdSignOutForBankConnection();
    setVisibility('hidden');
    vi.setSystemTime(START + 4 * 60_000);
    setVisibility('visible');

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('a hold abandoned at the bank lapses, and leaving signs out again', () => {
    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    const onTimeout = vi.fn();
    renderHook(() => useSessionTimeout(onTimeout));

    holdSignOutForBankConnection();
    setVisibility('hidden');
    vi.setSystemTime(START + 20 * 60_000);
    setVisibility('visible');

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('choosing it takes effect at once, not at the next launch', () => {
    chooseTimeout(30);
    renderHook(() => useSessionTimeout(vi.fn()));
    expect(window.localStorage.getItem(SEEN_KEY)).toBeNull();

    chooseTimeout(SESSION_ENDS_ON_LEAVE);
    act(() => {
      window.dispatchEvent(new Event(SESSION_TIMEOUT_CHANGED_EVENT));
    });

    expect(window.localStorage.getItem(SEEN_KEY)).toBe(String(START));
  });

  it('any other choice clears the heartbeat, so switching away never signs out at the next launch', () => {
    chooseTimeout(30);
    window.localStorage.setItem(SEEN_KEY, String(START - 3 * 3_600_000));
    const onTimeout = vi.fn();
    renderHook(() => useSessionTimeout(onTimeout));

    expect(onTimeout).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(SEEN_KEY)).toBeNull();
  });
});
