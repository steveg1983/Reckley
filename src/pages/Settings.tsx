import PageWrapper from '../components/PageWrapper';
import PageTip from '../components/PageTip';
// Through the seam, not by path: the billing card and the sign-out are both
// about the hosted SERVICE rather than about the ledger, and a device edition
// has neither. See src/editions/service.ts.
import { SubscriptionStatus, SignOutPanel } from '@service';
import { releaseLine } from '../lib/appRelease';

/**
 * Settings — the calmest page in the app, which it was not.
 *
 * This surface had never been through a design pass and carried every habit
 * the rest of the product has spent a batch each getting rid of: a
 * purple→blue gradient tile, `rounded-2xl shadow p-8`, a `text-blue-900`
 * heading, a Technology section, and a sentence of marketing copy. Almost all
 * of the change here is deletion.
 *
 * The gradient went furthest. Two colours that exist in no token, gradient-
 * filled, on the one page whose visitors are disproportionately people for
 * whom something has gone wrong — and in the exact idiom this product's
 * personality is defined against. What replaced it is nothing: the block was a
 * 64px badge reading "WT" directly above a heading reading "Reckley",
 * so removing the tile and keeping the glyph would have kept the redundancy
 * and only quietened it. P1 charges chrome rent, and this was paying none.
 *
 * The Technology section ("Built with React & TypeScript / Tailwind CSS for
 * styling / Recharts for data visualization") is gone for the plainer reason
 * that it was a developer's About page inside a finance product. It told a
 * person nothing they could act on about their own money, and it is not
 * information a consumer of this app has any use for.
 */
export default function Settings() {
  // The Quick Settings panel that used to sit here is gone with its last two
  // cards. Notifications pointed at a push-notification page whose every
  // control depended on a service worker this app does not ship, and
  // Accessibility pointed at a panel of switches wired to nothing. The alert
  // settings that DO work — budget alerts and large-transaction warnings —
  // live on App Settings, and the accessibility features themselves are
  // always on rather than optional.
  const release = releaseLine();
  return (
    <PageWrapper title="Settings">

      {/* The Sync Status card that used to sit beside this said "All changes
          saved" and could say nothing else: it read navigator.onLine, its
          refresh button awaited a 1.5s timer and called no service, and the
          event that would have marked work pending was dispatched by nothing
          in the codebase. A panel that reports a state it does not measure is
          worse than no panel — on the desktop edition it was also announcing
          cloud sync to an edition with no server. The compact copy in the
          header went for the same reason. */}
      <div className="mb-6">
        <SubscriptionStatus />
      </div>

      {/* Above the About card, deliberately. Somebody who opens Settings
          wanting out should not have to read what the app is built for first —
          and an action outranks a description on any page (P1). It renders
          nothing in the device edition, where there is no session to end. */}
      <div className="mb-6">
        <SignOutPanel />
      </div>

      {/* Hairline, radius 8, no shadow — DESIGN_PASS §2.5, the treatment every
          other converted surface already wears. `rounded-2xl shadow p-8` is
          the consumer-fintech tell the pass named. */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6 mb-6">
        {/* The page's own title treatment, which is PageWrapper's h1: navy-on-
            white at semibold. It was `text-blue-900 font-bold` — a blue that
            is in no token and belongs to no other heading in the app, at a
            weight the six-size scale does not have (§2.3 is 400/500/600, no
            700). `text-page` is the same 24px/32px/-0.02em the heading already
            rendered at, so nothing moves; it just stops being a colour of its
            own. */}
        <h2 className="text-page font-semibold text-gray-900 dark:text-white">
          Reckley
        </h2>
        {/* What the build was stamped with: the desktop's own version, the
            web's deployed commit, or no line at all. It said "Version 1.0" in
            both until 7 Nov 2026, which was neither — see lib/appRelease.ts. */}
        {release && (
          <p className="mt-1 text-body text-gray-500 dark:text-gray-400">{release}</p>
        )}

        {/* House voice, per the Reports gallery ("Where you stand, and how you
            got there"), which is the best writing in the product. What was
            here — "A comprehensive personal finance management application
            designed to help you track, manage, and grow your wealth with
            ease" — is the friendly-generic register removed from onboarding
            for the reason it is removed here: it describes any finance app
            ever written, so it tells a reader nothing about the one they have
            open. Plain, specific, no jargon, and no adjective the app awards
            itself. */}
        <p className="mt-4 text-body text-gray-500 dark:text-gray-400">
          A ledger for your own money: what you have, what you owe, and where
          it went. Every figure traces to something you entered or imported —
          nothing is estimated.
        </p>

        <h3 className="mt-6 text-card font-semibold text-gray-900 dark:text-white">
          Features
        </h3>
        {/* Real list markers. The items used to carry a literal "•" inside the
            text, which draws the same glyph and makes a screen reader say
            "bullet" seven times. */}
        <ul className="mt-2 list-disc pl-5 space-y-1 text-body text-gray-500 dark:text-gray-400">
          <li>Account management and tracking</li>
          <li>Transaction recording and categorisation</li>
          <li>Budget planning and monitoring</li>
          <li>Investment portfolio tracking</li>
          <li>Financial goal setting</li>
          <li>Analytics and insights</li>
          <li>Account reconciliation</li>
        </ul>
      </div>

    {/* id bumped again: the copy still promised categories and tags here, and
        those now live under Manage — a tip that names the wrong door is worse
        than no tip. */}
    <PageTip
      id="settings-intro-3"
      title="App settings"
      description="Your name, currency, theme and which pages appear in the sidebar, reached from the Settings menu above. Data Management covers archiving, backups and cleaning up — bringing data in and getting it out lives under Manage, alongside categories and tags."
    />
    </PageWrapper>
  );
}
