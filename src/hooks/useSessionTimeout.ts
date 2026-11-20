import { useEffect, useRef, useState } from 'react';
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
 * The app says "still here" every few seconds while it is on screen, and a
 * launch or a return reads how long ago that last was. NOT a mark written at
 * the moment of leaving: on the owner's phone (20 Nov 2026) that write never
 * reached the disk — the storage copied off the device after Reckley was sent
 * to the background held no mark, while Clerk's own write from the launch a
 * moment earlier was there. WebKit suspends the app before it saves, so the
 * only time a write is safe is while the app is in front. The heartbeat
 * needs no event at all: a suspended app runs no timers, so on return the
 * next tick finds the gap by itself, and a killed app leaves its last
 * heartbeat for the next launch.
 *
 * A short grace, not zero, so the system's own sheets that can hide the page
 * for a moment (a file picker, Control Centre, a notification pulled down)
 * do not sign somebody out in the middle of what they were doing.
 */
export const SESSION_ENDS_ON_LEAVE = -1;
const LEAVE_GRACE_MS = 30_000;
const HEARTBEAT_MS = 5_000;
const SEEN_KEY = 'ledger_session_seen_at';

function readSeenAt(): number | null {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeSeenAt(value: number | null): void {
  try {
    if (value === null) window.localStorage.removeItem(SEEN_KEY);
    else window.localStorage.setItem(SEEN_KEY, String(value));
  } catch {
    // Storage refused (private mode, quota): no heartbeat, and the person
    // stays signed in on return — the lenient failure, said here rather than
    // thrown out of a timer.
  }
}

/**
 * Forgets the heartbeat. SessionGuard calls it whenever nobody is signed in,
 * however the session ended: a heartbeat left over from a session Clerk's own
 * menu ended would otherwise sign the next sign-in straight back out.
 */
export function forgetSessionSeen(): void {
  writeSeenAt(null);
}

/**
 * Announced by Security Settings when the choice changes, so the hook starts
 * the new mode at once. Without it the old mode ran until the next launch:
 * choosing "When I leave the app" and closing the app left no mark, because
 * the session that was closed was still timing by minutes (19 Nov 2026).
 */
export const SESSION_TIMEOUT_CHANGED_EVENT = 'ledger:session-timeout-changed';

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;

/** How often to compare the clock against the last activity. */
const CHECK_INTERVAL_MS = 30_000;

/**
 * `active` is whether there is a session to end yet. The caller passes
 * Clerk's "loaded and signed in": at launch the page mounts before Clerk has
 * loaded, and a sign-out asked for then does nothing — while the check that
 * asked had already used up the mark. So nothing is read, cleared or started
 * until there is somebody to sign out.
 */
export function useSessionTimeout(onTimeout: () => void, active = true): void {
  // Held in a ref so a caller passing an inline arrow does not re-subscribe
  // every render — which would reset the listeners, not the session, but would
  // churn for no reason.
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;
  const [settingsVersion, setSettingsVersion] = useState(0);

  useEffect(() => {
    const onChanged = (): void => setSettingsVersion((v) => v + 1);
    window.addEventListener(SESSION_TIMEOUT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SESSION_TIMEOUT_CHANGED_EVENT, onChanged);
  }, []);

  useEffect(() => {
    if (!active) return;
    const settings = securityService.getSecuritySettings();
    if (settings.sessionTimeout === SESSION_ENDS_ON_LEAVE) {
      let lastSeen = readSeenAt();
      let interval = 0;
      let ended = false;
      const stop = (): void => {
        window.clearInterval(interval);
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('focus', beat);
        window.removeEventListener('pageshow', beat);
      };
      // One step: compare the clock with the last heartbeat, then beat.
      const beat = (): void => {
        // Off screen is away: no heartbeat, or a tab left hidden would keep
        // itself signed in. The gap is read when it is shown again.
        if (document.visibilityState === 'hidden') return;
        const now = Date.now();
        const away = lastSeen !== null && now - lastSeen > LEAVE_GRACE_MS;
        // Away at the bank, connecting it: the hold says so, and signing
        // out now would strand the connection (utils/bankConnectionHold).
        if (away && !bankConnectionHoldActive()) {
          writeSeenAt(null);
          ended = true;
          stop();
          onTimeoutRef.current();
          return;
        }
        lastSeen = now;
        writeSeenAt(now);
      };
      const onVisibility = (): void => beat();
      // A launch after the app was closed: the last heartbeat is still there.
      beat();
      if (ended) return;
      interval = window.setInterval(beat, HEARTBEAT_MS);
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('focus', beat);
      window.addEventListener('pageshow', beat);
      return stop;
    }
    // Any other choice clears a mark the strict mode left behind, so switching
    // away from it never signs somebody out on the next launch.
    writeSeenAt(null);
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
    // Re-read when a session appears and whenever the choice changes.
  }, [active, settingsVersion]);
}
