import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The iOS shell: a native window around the CLOUD edition.
 *
 * `server.url` points the WebView at the deployed app, so the phone always
 * runs what production runs — a deploy IS the mobile release, exactly the
 * property the owner's daily use depends on. The `www` directory this config
 * names exists only because Capacitor requires one; a single offline page
 * lives there for the no-network case.
 *
 * KNOWN AND ACCEPTED for the TestFlight phase: a remote-URL shell needs the
 * network, and App Store REVIEW (much later) will want bundled assets and
 * some native surface. TestFlight does not. Revisit when a public App Store
 * submission is actually in front of us — not before, because bundling the
 * assets means CORS work on the API and a second deploy pipeline, none of
 * which TestFlight requires.
 *
 * Points at the PRODUCTION domain, because that is where the Clerk
 * production instance lives — the runbook completed 26 Aug 2026, and Google
 * sign-in was verified on a real iPhone the same night. The vercel.app host
 * would sign nobody in: the pk_live instance answers only on the first-party
 * domain.
 */
const config: CapacitorConfig = {
  appId: 'com.wealthtracker.mobile',
  appName: 'Reckley',
  webDir: 'www',
  server: {
    // The app's home since the rename's domain move (phase 6, cut over
    // 28 Oct 2026). It moved the day Clerk's production domain did, and not a
    // day earlier: Clerk's session cookie lives on the Clerk domain's site,
    // and a WebView on any OTHER site sees it as third-party and drops it —
    // measured as "Authenticating…" forever on the phone the morning after
    // the Clerk move, while the old host still served the app. A build made
    // before this line changed is carried across by the old host's redirect
    // (vercel.json) and by `allowNavigation` having named this host since
    // build 5, so no install is stranded on the old address.
    url: 'https://www.reckley.co.uk',
  },
  ios: {
    // 'never', which is Capacitor's own default. 'automatic' (set when the
    // shell was born, #438, with no reason recorded) becomes
    // scrollView.contentInsetAdjustmentBehavior = .automatic, and UIKit then
    // adds the status bar's height to the web view's content inset the first
    // time the page is pulled past its top — the WHOLE layout viewport,
    // fixed and sticky chrome included, drops by that height and the shell's
    // background shows above it. Measured 9 Nov 2026 on the owner's Duo
    // (open, upright: 66pt) and on the iPhone 17 simulator (59pt), on the
    // production build; a white header on a light ground had hidden it, the
    // navy one made it plain. The app pays the status bar itself through
    // env(safe-area-inset-top) (--wt-status-bar-inset), which is unaffected
    // by this setting, so nothing else has to change.
    contentInset: 'never',
  },
  plugins: {
    // A push that arrives while the app is OPEN is still shown as a banner
    // (with its sound) rather than swallowed: the person may be on another
    // page, and the words were chosen to be read.
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
