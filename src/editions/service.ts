/**
 * THE PARTS OF A SHARED SURFACE THAT ARE ABOUT THE SERVICE — the contract,
 * named by neither edition.
 *
 * Eight members. Seven of them arrived together, and the neatest fact in this
 * whole phase is where they came from; the eighth arrived on its own and is
 * marked below, because it is the first member that was ADDED to a shared page
 * rather than found already sitting on one.
 *
 * `src/desktop/routes.ts` says a device edition is missing exactly three
 * REGIONS of the product — banking, subscription, auth — each because it needs a
 * server that holds something on your behalf. When the mount slice measured what
 * still stood between the app's pages and a desktop window, after `@session` had
 * taken the state layer's preamble away, what was left was these five, and every
 * one of them is one of those three regions poking through a page that is
 * otherwise entirely about the ledger:
 *
 *     /settings          SubscriptionStatus             subscription
 *     /settings/app      BankFeedRefreshSettings        banking
 *     /settings/security DangerZone                     auth
 *     /accounts          BankingCriticalIncidentBadge   banking
 *     /accounts          useAccountBankSync             banking
 *     /accounts + /settings/data
 *                        BankConnections                banking
 *     /accounts, /dashboard, the register
 *                        useBankConnectionSnapshot      banking
 *     /settings          SignOutPanel                   auth      ← added later
 *     /settings/app      PhoneNotificationSettings      banking   ← added 11 Sep
 *     /settings/app      WidgetSettings                 auth      ← added 10 Nov
 *
 * The tenth is a push notification's switchboard, and it is `banking` rather
 * than a region of its own because every push the server sends is about a
 * feed the server refreshed or a reminder the server kept: a phone registers
 * a token WITH somebody, which is exactly this seam's one idea. The cloud
 * half draws it only inside the iOS shell; a device window is not a phone.
 *
 * The eleventh is the home-screen widget's card, and it is `auth`: a widget
 * has no session of its own, so the card's switch asks the server for a
 * read-only key on the signed-in person's behalf and hands it to the phone.
 * A key is a thing you hold WITH somebody. The cloud half draws it only
 * inside an iOS shell that carries the widget plugin.
 *
 * The eighth is the one that did not come from the measurement, and the way it
 * arrived is worth keeping: the owner could not find any way to sign out on his
 * phone. The only one was `@chrome`'s `IdentityMenu` — an unlabelled avatar in
 * the header — so the action existed and was unfindable. Giving it a plainly
 * labelled home on `/settings` put a piece of the `auth` region on a page this
 * edition mounts, which is precisely the situation this seam exists for. It
 * belongs to the same region as `DangerZone` and sits one page away from it.
 *
 * That it needed no new type, no new argument and no change to either half's
 * shape is the seam working: a region poking through a shared page is a solved
 * problem here, and the eighth took one line on each side.
 *
 * Not a grab-bag, then, and not "the bits we have not done": one idea, which is
 * **whatever a shared surface says about the account you hold WITH somebody,
 * rather than about the ledger in front of you.** A program whose promise is
 * that the file never leaves the machine has no such account, so it has none of
 * these, and saying that once is better than saying it seven times.
 *
 * ── WHY THE MEMBERS ARE OF TWO KINDS, WHEN `@chrome` REFUSED THAT ───────────
 *
 * `editions/chrome.ts` argues that *"an edition seam whose members are of two
 * different KINDS is one a caller has to remember the shape of"*, and makes
 * `BackgroundWork` a component that renders `null` rather than the hook it
 * really is. Four components and three hooks here is the opposite ruling, and the
 * difference between the two cases is real rather than convenient:
 *
 *   * every `@chrome` member is mounted in ONE tree by ONE file, and being
 *     uniform is what keeps that file readable. Nothing reads a value back out
 *     of any of them;
 *   * `useAccountBankSync` is READ FROM. `pages/Accounts.tsx` destructures six
 *     things out of it and one of them, `connectedCount`, is what decides
 *     whether a "Refresh feeds" button exists at all. Wrapping it in a component
 *     to satisfy a uniformity rule would mean inventing a context to get the
 *     six values back out — machinery whose only purpose is to make a list look
 *     tidy.
 *
 * So the rule this seam keeps instead is the one that actually matters: each
 * member is annotated with a type declared HERE, so both halves are checked
 * against the same shape whichever kind they are.
 *
 * ── WHY NOT A RUNTIME CHECK ─────────────────────────────────────────────────
 *
 * `capabilities()` is right there and `{capabilities.backupTarget === 'device'
 * ? null : <SubscriptionStatus/>}` looks like less machinery. It is the mistake
 * `docs/edition-gating.md` opens with: a bundler cannot remove an arm of a
 * branch it cannot evaluate, so the desktop build would carry Clerk, Stripe and
 * the bank-feed client in order to decide at runtime not to draw them. Both
 * bundle greps would fail on the first build. And `dataPort.ts` forbids
 * branching on the descriptor's `edition` field outright, for its own good
 * reasons — the word is COPY, and `editionIsCopyOnly.test.ts` greps the source
 * to keep it that way. (It found this very paragraph, which is the grep being
 * exactly as crude as its own header says it means to be.)
 *
 * ── WHY THE MEMBERS KEEP THEIR NAMES ────────────────────────────────────────
 *
 * `SubscriptionStatus`, not `SubscriptionPanel`. The four pages that use these
 * are shared source and their diff for this slice is one import line each; a
 * rename would have made it four import lines and several JSX edits, for no
 * reader's benefit. The names are the ones somebody grepping the web app will
 * already know.
 */

import type { ComponentType } from 'react';
import type { UseAccountBankSyncResult } from '../hooks/accountBankLinks';
import type { BankConnection } from '../services/bankConnectionService';
import type {
  BankingAuditDateRangePreset,
  BankingAuditScope
} from '../utils/bankingOpsUrlState';

/**
 * A settings panel with nothing to configure — including the ones that draw
 * nothing at all.
 *
 * All four take no props today and there is no reason to think a fifth would.
 * A panel that needed one would be a panel that the PAGE knows something about,
 * and a page that knows something about a subscription is a page that has an
 * edition in it.
 */
export type ServicePanel = ComponentType;

/**
 * Mounted beside the router and renders nothing: it signs a session out after
 * a period of inactivity. Cloud-only for the reason `SignOutPanel` is — a
 * device window has nobody signed in to sign out.
 */
export type ServiceSessionGuard = ComponentType;

/**
 * Which of the two banking circuit breakers a badge is reporting on.
 *
 * `'all'` and not `'critical'`, which is what the Accounts page's own state
 * calls the same view. The component's default is every incident and the other
 * value narrows to TrueLayer's JWKS breaker; the compiler caught the guess when
 * this contract was first written with the page's word in it, which is the
 * annotation on the cloud half doing exactly what it is there for.
 */
export type BankingIncidentBadgeMode = 'all' | 'truelayer_jwks';

/** What the Accounts page can tell the incident badge. */
export interface BankingIncidentBadgeProps {
  onClick?: () => void;
  mode?: BankingIncidentBadgeMode;
}

/**
 * The red badge on /accounts that appears when the bank-feed service is having
 * an incident.
 *
 * Declared with its props here rather than imported from the component, for the
 * reason `editions/chrome.ts` gives at length: the device half would otherwise
 * NAME a module that opens with a Clerk hook, and the next person widening this
 * seam would read that as permission.
 */
export type ServiceIncidentBadge = ComponentType<BankingIncidentBadgeProps>;

/**
 * The one hook: per-account bank-feed state and the act of pulling it.
 *
 * The RESULT type is `hooks/accountBankLinks.ts`'s, which is a pure module —
 * shapes and a `forEach`, no Clerk, no connection service — so naming it here
 * costs a desktop bundle nothing and it stays the single declaration of what an
 * account's bank link looks like. That module exists because of this seam: the
 * shapes and the mapping used to sit in `useAccountBankSync.ts` itself, which is
 * how the Dashboard and the register came to reach a sign-in provider for the
 * sake of a `Map`.
 */
export type UseServiceBankSync = (options?: {
  onSynced?: () => void | Promise<void>;
}) => UseAccountBankSyncResult;

/**
 * What the two pages that open the bank-connections modal can tell it.
 *
 * The deep-link state (`bankingOpsUrlState`) is imported for its two union
 * types and nothing else, and that module is one file with no imports of its
 * own — so naming it here is free in both editions, and re-declaring two unions
 * would have been a second place for them to drift.
 */
export interface ServiceBankConnectionsProps {
  onAccountsLinked?: () => void;
  defaultOpsOnlyAboveThreshold?: boolean;
  defaultOpsEventType?: string;
  defaultOpsEventTypePrefix?: string;
  defaultOpenOpsAuditLog?: boolean;
  defaultOpsAuditStatus?: 'pending' | 'completed' | 'failed';
  defaultOpsAuditScope?: BankingAuditScope;
  defaultOpsAuditDateRangePreset?: BankingAuditDateRangePreset;
}

/**
 * The modal that lists a person's bank logins and lets them add one.
 *
 * Typed as a plain component even though the web's is lazy, for the reason
 * `editions/chrome.ts` gives about `ChromeQuickAddTransaction`: both call sites
 * already wrap it in a `<Suspense>`, and an edition whose answer is NOT worth a
 * chunk of its own should not have to pretend otherwise.
 *
 * The LAZY DECLARATION moved out of the two pages and into the cloud half, and
 * that is the whole point rather than tidiness: a dynamic import is an import,
 * so `const X = lazy(() => import('./BankConnections'))` sitting in
 * `pages/Accounts.tsx` left Clerk reachable from the Accounts page in the one
 * way that looks like it is not there. Same trap, same fix, second time.
 */
export type ServiceBankConnections = ComponentType<ServiceBankConnectionsProps>;

/**
 * READ the bank connections the app already loaded — never a fetch.
 *
 * The passive twin of {@link UseServiceBankSync}, and a separate member rather
 * than a field on that result for the reason its own module states: a surface
 * that only wants to read must not mount the syncing hook, because each mount of
 * that one re-fetches `/api/banking/connections`. Three shared surfaces read it
 * — the dashboard's attention card, the register's banner, the Accounts page.
 *
 * The RESULT type comes from `services/bankConnectionService`, which does reach
 * a network, and that is safe here for the reason `editions/chrome.ts` gives:
 * `import type` is erased before a bundler sees it. Re-declaring `BankConnection`
 * (eleven fields, three unions) to avoid naming that module would be a second
 * copy of a shape whose whole job is to describe one service's answer.
 *
 * A device answers with an empty list, which is what a signed-out browser
 * already answers, so every consumer's handling of it is code that has always
 * run.
 */
export type UseServiceBankConnections = () => BankConnection[];
