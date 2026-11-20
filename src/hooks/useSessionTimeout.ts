import { useEffect, useRef } from 'react';
import { securityService } from '../services/securityService';
import { bankConnectionHoldActive } from '../utils/bankConnectionHold';

/**
 * SIGN OUT AFTER A PERIOD OF INACTIVITY — the thing the setting always claimed.
 *
 * `securityService` has had `checkSession()` and `updateLastActivity()` since it
 * was written, and both are correct. Nothing called either, so the Session
 * Timeout dropdown stored a number that decided nothing: a person could set
 * "5 minutes", leave the app open for a week, and come back signed in.
 *
 * That is the dead-toggle problem on the one page where it makes a claim about
 * safety rather than about confetti. This is what winds the clock.
 *
 * ─ WHAT COUNTS AS ACTIVITY ─────────────────────────────────────────────────
 *
 * Pointer, keyboard, scroll and touch, on the window. Deliberately NOT a timer
 * that resets itself: the point is inactivity by the PERSON, not by the app, so
 * a page polling in the background must not keep a session alive.
 *
 * ─ WHY IT CHECKS ON A TIMER AND ON WAKE ────────────────────────────────────
 *
 * A laptop shut for two hours runs no timers. `visibilitychange` is what
 * catches the case the interval cannot — the tab comes back and the elapsed
 * time is read from the clock rather than from how often we were scheduled.
 *
 * ─ NEVER ───────────────────────────────────────────────────────────────────
 *
 * `sessionTimeout === 0` means never, and the hook does nothing at all: no
 * listeners, no interval. The owner asked for the option, and a "never" that
 * quietly kept measuring would be the same kind of lie in the other direction.
 */

/**
 * "WHEN I LEAVE THE APP" — the strictest choice, owner's ask 19 Nov 2026, the
 * day passkeys made signing back in a glance rather than a password and a
 * code. Stored as this sentinel in the same minutes field.
 *
 * Leaving is the page going hidden: another app, the home screen, the app
 * switcher a phone is closed from, a locked screen, another tab. The moment
 * is written down then, and read when the page is seen again — on return, or
 * on the next launch, which is how a phone that killed the app is caught: the
 * page that wrote the mark never came back to read it.
 *
 * A short grace, not zero, so the system's own sheets that can hide the page
 * for a moment (a file picker, Control Centre, a notification pulled down)
 * do not sign somebody out in the middle of what they were doing.
 */
export const SESSION_ENDS_ON_LEAVE = -1;
const LEAVE_GRACE_MS = 30_000;
const LEFT_AT_KEY = 'ledger_session_left_at';

function readLeftAt(): number | null {
  try {
    const raw = window.localStorage.getItem(LEFT_AT_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeLeftAt(value: number | null): void {
  try {
    if (value === null) window.localStorage.removeItem(LEFT_AT_KEY);
    else window.localStorage.setItem(LEFT_AT_KEY, String(value));
  } catch {
    // Storage refused (private mode, quota): the mark is lost and the person
    // stays signed in on return — the lenient failure, said here rather than
    // thrown into the middle of a visibility event.
  }
}
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;

/** How often to compare the clock against the last activity. */
const CHECK_INTERVAL_MS = 30_000;

export function useSessionTimeout(onTimeout: () => void): void {
  // Held in a ref so a caller passing an inline arrow does not re-subscribe
  // every render — which would reset the listeners, not the session, but would
  // churn for no reason.
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  useEffect(() => {
    const settings = securityService.getSecuritySettings();
    if (settings.sessionTimeout === SESSION_ENDS_ON_LEAVE) {
      const endIfAwayTooLong = (): void => {
        const leftAt = readLeftAt();
        writeLeftAt(null);
        // Away at the bank, connecting it: the hold says so, and signing
        // out now would strand the connection (utils/bankConnectionHold).
        if (bankConnectionHoldActive()) return;
        if (leftAt !== null && Date.now() - leftAt > LEAVE_GRACE_MS) {
          onTimeoutRef.current();
        }
      };
      // A launch after the app was closed: the mark is still there.
      endIfAwayTooLong();
      const onVisibility = (): void => {
        if (document.visibilityState === 'hidden') writeLeftAt(Date.now());
        else endIfAwayTooLong();
      };
      document.addEventListener('visibilitychange', onVisibility);
      // `pagehide` too: a tab or window closed outright may never report
      // hidden first.
      const onPageHide = (): void => writeLeftAt(Date.now());
      window.addEventListener('pagehide', onPageHide);
      return () => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
      };
    }
    // Any other choice clears a mark the strict mode left behind, so switching
    // away from it never signs somebody out on the next launch.
    writeLeftAt(null);
    if (settings.sessionTimeout <= 0) return; // Never

    // Starting the clock on mount, not on the last sign-in: a reload is the
    // person being here, and treating it as elapsed time would sign somebody
    // out for refreshing the page.
    securityService.updateLastActivity();

    const markActive = (): void => securityService.updateLastActivity();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, markActive, { passive: true });
    }

    const check = (): void => {
      if (!securityService.checkSession()) onTimeoutRef.current();
    };

    const interval = window.setInterval(check, CHECK_INTERVAL_MS);
    // The case the interval cannot see: a machine asleep runs no timers, so the
    // elapsed time has to be read when the tab comes back rather than counted
    // while it was away.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, markActive);
      }
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // Re-read on every mount. The setting is changed on a page that stays
    // mounted, so the caller re-keys this hook when it changes — see App.
  }, []);
}
