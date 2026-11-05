// FIRST import: configures zod before any module-scope schema is built.
// See the file for why (it removes a per-load CSP violation).
import { migrateStorage } from './lib/storageMigration'
import './lib/zodConfig'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import type { Appearance } from '@clerk/types'
import { ClerkErrorBoundary } from './components/auth/ClerkErrorBoundary'
import './styles/borders.css'
import './styles/accessibility-colors.css'
import './index.css'
import App from './App.tsx'
import { initializeSecurity } from './security'
import { checkEnvironmentVariables } from './utils/env-check'
import { captureMessage, initSentry } from './lib/sentry'
import { createScopedLogger } from './loggers/scopedLogger'
import {
  persistRuntimeControlSanitizationSignal,
  sanitizeRuntimeControlSearchWithDetails,
  sanitizeRuntimeControlStorageWithDetails
} from './utils/runtimeMode'

const bootstrapLogger = createScopedLogger('AppBootstrap');

// DEV-ONLY boot profiler: `sessionStorage.bootProfile = '1'` then reload —
// the whole boot is sampled (JS Self-Profiling API, enabled by the dev
// server's Document-Policy header) and the trace parked on
// `window.__bootTrace` for inspection. No-op in production builds.
if (import.meta.env.DEV && sessionStorage.getItem('bootProfile') === '1') {
  try {
    type ProfilerTrace = { samples: unknown[]; stacks: unknown[]; frames: unknown[] };
    type ProfilerLike = { stop(): Promise<ProfilerTrace> };
    type ProfilerCtor = new (opts: { sampleInterval: number; maxBufferSize: number }) => ProfilerLike;
    const ProfilerClass = (globalThis as { Profiler?: ProfilerCtor }).Profiler;
    if (ProfilerClass) {
      const profiler = new ProfilerClass({ sampleInterval: 5, maxBufferSize: 1_000_000 });
      setTimeout(() => {
        void profiler.stop().then(trace => {
          (window as unknown as { __bootTrace?: ProfilerTrace }).__bootTrace = trace;
          bootstrapLogger.info('Boot profile captured on window.__bootTrace');
        });
      }, 20_000);
    }
  } catch {
    // Profiling is best-effort tooling; never let it affect boot.
  }
}

// Reduced motion is handled entirely in CSS, by the
// `@media (prefers-reduced-motion: reduce)` block in index.css that flattens
// every animation and transition. The `.reduce-motion` class this used to put
// on <html> matched no selector anywhere, so it changed nothing.
let runtimeControlSanitizationContext: {
  removedQueryParams: ('demo' | 'testMode')[];
  removedStorageKeys: ('isTestMode' | 'demoMode')[];
  path: string;
} | null = null;

if (typeof window !== 'undefined') {
  const searchSanitization = sanitizeRuntimeControlSearchWithDetails(window.location.search, import.meta.env);
  if (searchSanitization.sanitizedSearch !== window.location.search) {
    const sanitizedUrl = `${window.location.pathname}${searchSanitization.sanitizedSearch}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', sanitizedUrl);
  }
  const storageSanitization = sanitizeRuntimeControlStorageWithDetails(import.meta.env, window.localStorage);

  if (searchSanitization.removedParams.length > 0 || storageSanitization.removedKeys.length > 0) {
    runtimeControlSanitizationContext = {
      removedQueryParams: searchSanitization.removedParams,
      removedStorageKeys: storageSanitization.removedKeys,
      path: window.location.pathname
    };

    persistRuntimeControlSanitizationSignal(
      runtimeControlSanitizationContext,
      window.sessionStorage
    );
  }
}

// Check environment variables in development
if (import.meta.env.DEV) {
  checkEnvironmentVariables();
}

// Get Clerk publishable key
const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!PUBLISHABLE_KEY) {
  bootstrapLogger.error('Missing VITE_CLERK_PUBLISHABLE_KEY in environment variables');
  bootstrapLogger.info('Available env vars', { keys: Object.keys(import.meta.env) });
}

// Initialize all security features
initializeSecurity();

// THE INSTALLED-APP CLASS, because the iOS wrapper lies three times over.
// index.css zeroes the safe-area insets for installed apps (since iOS 26.1
// the system draws its own bars there and still reports the full env()
// values — see --wt-status-bar-inset). Three keys, each added when the one
// before it was measured dead on the owner's iPhone (iOS 27, 1 Sep 2026):
//
//   1. `display-mode: standalone` — the standard signal. The wrapper does
//      not match it (screenshot, 15:56).
//   2. `navigator.standalone` — the iOS-specific flag usePullToRefresh
//      trusts. Not true there either (screenshot, 16:19, post-deploy).
//   3. THE LIE ITSELF: the device pays a top safe-area inset while the
//      window provably does not reach the screen's top edge. No honest
//      surface reports that pair at boot — Safari's chrome is expanded at
//      load so env-top is 0; a healthy full-bleed installed app has
//      innerHeight equal to the screen; desktop pays no env at all. Only a
//      wrapper that insets the webview AND still reports the notch answers
//      yes to both.
//
// Measured at boot AND retried as the viewport settles, because a single
// boot-time sample missed on the very phone this exists for: the owner's
// Display diagnostics (1 Sep, 16:53) showed the lie pair plainly true at
// Settings-render — env top 62px paid, window 894 of a 956 screen — while
// the class sat false, so in the first instants of the process iOS had not
// yet reported the pair this code sampled once and believed. Re-evaluating
// later is safe on every honest surface: portrait Safari never pays a TOP
// inset at any scroll state (pages slide under the BOTTOM bar, never the
// clock), landscape pays left/right only, and a healthy full-bleed app
// keeps innerHeight equal to its screen. The class is only ever ADDED —
// a detection that flickered off mid-session would snap the chrome around.
{
  const navigatorWithFlag = window.navigator as Navigator & { standalone?: boolean };
  const startedAt = performance.now();
  const trace: string[] = (window.__wtInstalledAppTrace = []);
  const readEnvTop = (): number => {
    try {
      const probe = document.createElement('div');
      probe.style.cssText =
        'position:fixed;top:0;left:0;height:0;width:0;visibility:hidden;pointer-events:none;' +
        'padding-top:env(safe-area-inset-top,0px)';
      document.body.appendChild(probe);
      const envTop = Number.parseFloat(getComputedStyle(probe).paddingTop) || 0;
      probe.remove();
      return envTop;
    } catch {
      return 0;
    }
  };
  const detectInstalledApp = (reason: string): void => {
    const doc = document.documentElement;
    if (doc.classList.contains('wt-installed-app')) return;
    const declaredInstalled =
      navigatorWithFlag.standalone === true ||
      window.matchMedia?.('(display-mode: standalone)').matches === true;
    const envTop = readEnvTop();
    const lied = envTop > 0 && window.innerHeight < window.screen.height;
    // The evidence trail Display diagnostics prints — a wrapper regression
    // should cost one screenshot, and the 1 Sep hunt cost four deploys
    // because nobody could see what this code saw. Bounded so a resize
    // storm cannot grow it without limit.
    if (trace.length < 20) {
      trace.push(
        `${Math.round(performance.now() - startedAt)}ms ${reason}: env ${envTop} inner ${window.innerHeight} screen ${window.screen.height} declared ${declaredInstalled} → ${declaredInstalled || lied ? 'INSTALLED' : 'no'}`
      );
    }
    if (declaredInstalled || lied) {
      doc.classList.add('wt-installed-app');
    }
  };
  // Fixed samples AND event-driven ones: the owner's wrapper (iOS 27) showed
  // the lie pair true at Settings-render while every fixed sample had
  // missed it, and the sim's first cold standalone launch has been seen to
  // take twenty seconds — so the moment the wrapper finally insets the
  // webview, a resize fires, and THAT is the sample that lands.
  detectInstalledApp('boot');
  window.addEventListener('load', () => detectInstalledApp('load'), { once: true });
  window.setTimeout(() => detectInstalledApp('t+700'), 700);
  window.setTimeout(() => detectInstalledApp('t+2500'), 2500);
  window.setTimeout(() => detectInstalledApp('t+8000'), 8000);
  window.addEventListener('resize', () => detectInstalledApp('resize'));
  window.addEventListener('orientationchange', () => detectInstalledApp('orientation'));
  window.visualViewport?.addEventListener('resize', () => detectInstalledApp('vv-resize'));
}

// Initialize Sentry error tracking
try {
  initSentry();
} catch (error) {
  bootstrapLogger.error('Error initializing Sentry', error);
}

if (runtimeControlSanitizationContext) {
  bootstrapLogger.warn('Sanitized runtime control inputs at bootstrap', runtimeControlSanitizationContext);
  captureMessage(
    'Sanitized runtime control inputs at bootstrap',
    'warning',
    runtimeControlSanitizationContext
  );
}

// Add error logging
window.addEventListener('error', (event): void => {
  // Filter benign errors
  if (event.message?.includes('ResizeObserver')) {
    event.preventDefault();
    return;
  }

  // bootstrapLogger.error() already suppresses console in production via LoggingService
  // (src/services/loggingService.ts line 151: if (this.outputToConsole))
  bootstrapLogger.error('Global error captured', event.error);

  // Prevent browser's default console logging in production
  if (!import.meta.env.DEV) {
    event.preventDefault();
  }
});

window.addEventListener('unhandledrejection', (event): void => {
  bootstrapLogger.error('Unhandled promise rejection', event.reason);

  // Prevent browser's default console logging in production
  if (!import.meta.env.DEV) {
    event.preventDefault();
  }
});

// Clerk's sign-in / sign-up modals and the UserButton menu render on top of the
// app but in a portal outside its Tailwind scope, so they don't inherit the
// app's palette on their own — left alone they wear Clerk's default bright blue.
// This appearance derives every Clerk surface from the app's own slate
// (#1a2332, with the lighter #2d3a4d for hover) so the modal that opens from the
// landing page reads as the same product, not a bolted-on third party.
//
// No dark-mode variant on purpose: the `baseTheme: dark` swap needs the
// @clerk/themes package, which is NOT a dependency here and which we don't add.
// Clerk modals float on their own backdrop, so a light modal over a dark app is
// legible and is Clerk's own common default — acceptable until a theme package
// is ever introduced.
//
// The "Development mode" strip at the modal's foot is Clerk's *development
// instance* badge. It cannot be removed by styling — it disappears on its own
// once the app runs on Clerk production keys. Don't chase it here.
const clerkAppearance: Appearance = {
  variables: {
    // Everything (buttons, links, focus rings) derives from the app slate.
    colorPrimary: '#1a2332',
    // White label on #1a2332 is ~15:1 contrast — passes WCAG AA/AAA.
    colorPrimaryForeground: '#ffffff',
    // `colorText` is deprecated in this Clerk version; `colorForeground` is its
    // replacement. Near-black body/heading text, matching the app's gray-900.
    colorForeground: '#111827',
    // Muted subtitle grey, matching the app's gray-500.
    colorMutedForeground: '#6b7280',
    // Inherit the app's Inter stack (set on <body> in index.html); the modal
    // renders in a portal on document.body so 'inherit' reaches it.
    fontFamily: 'inherit',
    fontFamilyButtons: 'inherit',
    // rounded-xl (0.75rem), matching the app's own buttons.
    borderRadius: '0.75rem'
  },
  elements: {
    // Slate primary button whose hover goes *lighter* (#2d3a4d). Clerk would
    // otherwise darken an already-dark primary toward black; the app's own
    // hover token is the lighter secondary slate, so we mirror it.
    formButtonPrimary: {
      backgroundColor: '#1a2332',
      color: '#ffffff',
      '&:hover': { backgroundColor: '#2d3a4d' },
      '&:focus': { backgroundColor: '#2d3a4d' },
      '&:active': { backgroundColor: '#1a2332' }
    },
    // Match the app's rounded-2xl card surfaces (~1rem).
    card: { borderRadius: '1rem' },
    headerTitle: { color: '#111827' },
    headerSubtitle: { color: '#6b7280' },
    // Social / secondary buttons stay neutral (near-black label, never blue).
    socialButtonsBlockButton: { color: '#111827' },
    /*
     * THE AVATAR — no rule, deliberately, after two attempts that made it worse.
     *
     * The design review's "single most-seen element in the product and the only
     * gradient in it" is Clerk's GENERATED default avatar, not ours. Two things
     * were learned the hard way and are recorded so a third attempt starts from
     * them:
     *
     * 1. A background here is invisible. Measured in the owner's console: this
     *    object DID apply `background-color: rgb(26, 35, 50)` and
     *    `background-image: none` to `span.cl-avatarBox` — and the gradient
     *    stayed, because Clerk renders an `<img>` from img.clerk.com inside the
     *    span. A background sits behind a picture.
     *
     * 2. Hiding that image leaves an EMPTY disc. Clerk's span holds the image
     *    and nothing else; the generated picture IS how it draws the initial,
     *    so there is no text underneath to fall back to. Worse, slate is the
     *    nav bar's own colour, so the disc vanished entirely — "you cant see
     *    notifications now or the user avatar icon".
     *
     * The answer is our own avatar — an initial rendered by us on #f1f3f7,
     * which is the review's second option and the only one that does not depend
     * on what Clerk puts inside its box. A component, not an appearance key.
     */
  }
};

// Remove any pre-existing dark class on app start
document.documentElement.classList.remove('dark');

const renderApp = (): void => {
  try {
    const root = document.getElementById('root');
    if (!root) {
      bootstrapLogger.error('Root element not found');
    } else {
      bootstrapLogger.info('Starting React app');
      createRoot(root).render(
        <StrictMode>
          <ClerkErrorBoundary>
            <ClerkProvider
              publishableKey={PUBLISHABLE_KEY}
              afterSignOutUrl="/"
              appearance={clerkAppearance}
              allowedRedirectOrigins={[window.location.origin]}
              // Clerk's usage telemetry posts to clerk-telemetry.com, which the
              // CSP's connect-src deliberately does not list — so every page load
              // logged a CSP violation for a request we do not need. Widening the
              // policy to admit an analytics host would be the wrong trade: a
              // console full of expected errors is where a real one goes unseen.
              telemetry={{ disabled: true }}
            >
              <App />
            </ClerkProvider>
          </ClerkErrorBoundary>
        </StrictMode>,
      );
      bootstrapLogger.info('React app rendered');
    }
  } catch (error) {
    bootstrapLogger.error('Error rendering app', error);
  }
};

// The storage-generation migration runs to completion BEFORE the first render,
// because the first thing the app does after mounting is read storage, and the
// migration is what puts the data under the names it will read. It copies
// first and deletes an old copy only behind a present new one, and it never
// blocks boot: a failure is logged and the app renders against whatever is
// there. See lib/storageMigration.
void migrateStorage()
  .catch(error => {
    bootstrapLogger.error('Storage migration failed; rendering anyway', error);
  })
  .then(renderApp);

/*
 * THERE IS NO SERVICE WORKER, ON PURPOSE (31 Aug 2026).
 *
 * A `register('/sw.js')` call used to sit here. It never once succeeded in
 * production: no `sw.js` was ever built or deployed, and the host answers
 * `/sw.js` with the SPA's index.html — so the browser rejected the script on
 * its MIME type every single load. Everything hung off that call's success
 * callback (push notifications, the update prompt, the `app-offline` /
 * `app-online` events, `window.swRegistration`), and none of it ever ran.
 * Nothing was lost by deleting it because nothing was working.
 *
 * It is not coming back, and the reasons are worth more than the code was:
 *
 * 1. A cloud ledger's offline story is the LOCAL EDITION and the native iOS
 *    shell, not a browser cache. Serving a stale balance from a cache is worse
 *    than saying "you're offline" — see `components/OfflineIndicator`.
 * 2. No service worker means every deploy reaches every phone on the next
 *    load, with no waiting worker and no "Update Available" prompt to press.
 *    The project relies on that when iterating against the owner's device.
 *
 * The manifest stays: a PWA is installable without a service worker, and the
 * home-screen app is used daily. If a worker is ever genuinely wanted, it
 * needs a build step that EMITS one (there wasn't one) and a host rule that
 * serves it — start there, not with a `register()` call.
 */
