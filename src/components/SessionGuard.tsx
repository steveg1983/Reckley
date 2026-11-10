import React, { useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useSessionTimeout } from '../hooks/useSessionTimeout';
import { forgetWidgetKeyIfHeld } from '../services/widget/widgetBridge';

/**
 * THE THING THAT MAKES "SESSION TIMEOUT" TRUE.
 *
 * The dropdown on Security Settings has always stored a number, and until now
 * nothing read it: `securityService.checkSession()` and `updateLastActivity()`
 * were both written, both correct, and both never called. A person could set
 * "5 minutes", leave the app open for a week, and come back signed in.
 *
 * ─ WHY IT IS A COMPONENT AND WHY IT IS CLOUD-ONLY ──────────────────────────
 *
 * Signing out is a thing you can only do to somebody who is signed IN, which
 * is the cloud edition's whole business. A device window has no session to
 * end, so the desktop twin of this seam member is `() => null` — the same
 * argument that makes `SignOutPanel` cloud-only, one page up.
 *
 * ─ AND IT TAKES THE WIDGET'S KEY BACK WHEN NOBODY IS SIGNED IN ──────────────
 *
 * The home-screen widget on a phone draws from a key the Settings card handed
 * over (`services/widget/widgetBridge`). Signing out ends the session and,
 * left alone, would leave that key on the phone: the widget would go on
 * drawing the budgets of somebody who has signed out, and the next person to
 * sign in on that phone would find their own Settings saying "on" above it,
 * because "on" is asked of the phone. A session ends in four places — the
 * panel on Settings, the delete in the danger zone, the timeout below, and
 * Clerk's own avatar menu, which calls nothing of ours — so this watches the
 * STATE rather than any one of the calls. It waits for Clerk to have loaded:
 * a phone that starts with no network has not been signed out.
 *
 * The server's copy of the key is not revoked here; a signed-out page has no
 * session to ask with. It opens nothing once the phone has forgotten it.
 *
 * It renders nothing. It exists to be MOUNTED, high enough that the timer
 * outlives any single page: put it beside the router, not inside a route, or
 * it restarts every time somebody navigates.
 */
export default function SessionGuard(): React.JSX.Element | null {
  const { signOut, isLoaded, isSignedIn } = useAuth();

  useEffect(() => {
    if (!isLoaded || isSignedIn) return;
    void forgetWidgetKeyIfHeld();
  }, [isLoaded, isSignedIn]);

  useSessionTimeout(() => {
    // `redirectUrl` rather than leaving them on a page they can no longer
    // load: a timed-out session that stays on /accounts shows an empty ledger,
    // which reads as data loss rather than as a sign-out.
    void signOut({ redirectUrl: '/' });
  });

  return null;
}
