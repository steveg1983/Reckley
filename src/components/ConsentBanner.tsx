/**
 * Cookie/tracking consent banner (PECR + GDPR).
 *
 * Shows until the user makes a choice. "Essential only" keeps strictly
 * necessary processing (auth, scrubbed error capture); "Accept all"
 * additionally enables Sentry session replay + performance tracing.
 * Declining is as easy as accepting — both are single buttons.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getConsent, setConsent } from '../utils/consent';
import { enableAnalyticsConsent } from '../lib/sentry';
import { sidePadding } from './layout/chromeOffsets';

export default function ConsentBanner(): React.JSX.Element | null {
  const [choiceMade, setChoiceMade] = useState(() => getConsent() !== null);

  if (choiceMade) return null;

  const choose = (level: 'essential' | 'all') => {
    setConsent(level);
    if (level === 'all') {
      enableAnalyticsConsent();
    }
    setChoiceMade(true);
  };

  return (
    <div
      role="region"
      aria-label="Cookie and privacy choices"
      // Above the mobile bottom navigation, which also sits at bottom-0 with
      // z-50 and — rendering later in the tree — was painting over these
      // buttons on a phone. A tap on "Essential only" landed on the nav link
      // behind it, so declining was impossible on mobile while accepting by
      // scrolling past was not: the exact asymmetry PECR forbids. The banner
      // covers the nav only until a choice is made, and either button is one
      // tap, so nothing is trapped behind it.
      className="fixed bottom-0 inset-x-0 z-[60] bg-[#1a2332] text-white shadow-2xl border-t border-white/10"
    >
      <div className="max-w-5xl mx-auto py-4 flex flex-col sm:flex-row sm:items-center gap-4" style={sidePadding('1rem')}>
        <p className="text-sm flex-1 text-white/90">
          We use strictly necessary cookies to sign you in and keep the app working.
          With your permission we also use session-diagnostics (Sentry) to find and
          fix problems — these are optional.{' '}
          <Link to="/privacy" className="underline hover:text-white">
            Privacy policy
          </Link>
        </p>
        <div className="flex gap-3 shrink-0">
          <button
            onClick={() => choose('essential')}
            className="px-4 py-2 rounded-lg border border-white/40 text-white hover:bg-white/10 transition-colors text-sm font-medium"
          >
            Essential only
          </button>
          <button
            onClick={() => choose('all')}
            className="px-4 py-2 rounded-lg bg-white text-[#1a2332] hover:bg-white/90 transition-colors text-sm font-semibold"
          >
            Accept all
          </button>
        </div>
      </div>
    </div>
  );
}
