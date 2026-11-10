/**
 * `@service`, on a device: eight absences, and one thing that survives somewhere
 * else.
 *
 * The device half of `editions/service.ts`, and the twin of
 * `editions/cloud/service.ts`. All eight answer with nothing, and all eight are
 * ABSENT BY DECISION rather than owed — each belongs to one of the three regions
 * `src/desktop/routes.ts` rules out for the whole edition.
 *
 * ── SignOutPanel, THE SHORTEST ARGUMENT OF THE EIGHT ────────────────────────
 *
 * A sign-out needs a sign-in to undo, and `NEVER_ON_A_DESKTOP` rules `/login`
 * out of this edition entirely: *"There is no ClerkProvider in this build and
 * therefore nothing for a sign-in screen to talk to."* The identity of a ledger
 * here is the uuid in the file's own users row, minted when the file was
 * created, and the act that answers "who are you" is choosing a file — which is
 * `@chrome`'s `IdentityMenu`, and is the one member of that seam this edition
 * answers for real. You do not sign out of a file; you close it, or you open a
 * different one, and neither of those is a session ending.
 *
 * It renders nothing rather than a disabled button or a line of explanation,
 * for the reason the whole file gives below: a person on a settings page did
 * not come there to be told about a product they did not buy.
 *
 * ── DangerZone, TRACED, BECAUSE THE OBVIOUS READING IS WRONG ────────────────
 *
 * "A danger zone is where you delete things, a device can delete things, so a
 * device keeps a danger zone" is the reasonable guess and it does not survive
 * reading the component. `components/settings/DangerZone.tsx` is one button and
 * it does one thing: `POST /api/account/delete`, which cancels the Stripe
 * subscription, erases the account's rows through the `users` cascade, removes
 * the CLERK identity, and then signs the browser out. Every noun in that
 * sentence is a thing a device edition does not have. There is nothing to keep.
 *
 * **The wipe is not in it, and never was.** `dataPort.wipeAllFinancialData` — the
 * verb a person means when they say "delete everything in this ledger" — is
 * called from `pages/settings/DataManagement.tsx`, which is `/settings/data`.
 * That page is not mounted in this window YET, and for a reason of its own that
 * has nothing to do with this seam (`routes.ts` names it: the restore dialog is
 * bound to the BROWSER's backup store). When it lands, the wipe lands with it,
 * at the address it has always been at, with its typed confirmation and its
 * progress reporting intact — because the verb behind it is the port's, and
 * `LocalDataPort` answers it against the file.
 *
 * That is worth having written down, because the mistake in the other direction
 * would have been quiet and bad: a desktop DangerZone rebuilt around the wipe
 * would have given this edition TWO delete-everything buttons on two settings
 * pages, one of them a copy, and the copy would have shipped first.
 *
 * ── THE OTHER SIX ──────────────────────────────────────────────────────────
 *
 *   SubscriptionStatus            plan, renewal date and a link to Stripe's
 *                                 portal. `NEVER_ON_A_DESKTOP` rules on the
 *                                 whole subscription region: whatever this
 *                                 edition is sold as, it is not sold from inside
 *                                 this router.
 *   BankFeedRefreshSettings       how often a SERVER re-polls the institution.
 *                                 There is no server, so there is no schedule —
 *                                 the same reason `@chrome`'s `BackgroundWork`
 *                                 draws nothing.
 *   PhoneNotificationSettings     what a phone may push. No server to push
 *                                 from, no token to push to — and the cloud
 *                                 half draws it only inside the iOS shell in
 *                                 any case. A desktop window is neither.
 *   WidgetSettings                the home-screen widgets' read-only key.
 *                                 There is no server to mint one and no
 *                                 home screen to draw on.
 *   BankingCriticalIncidentBadge  "the bank feed is having an incident". There
 *                                 is no feed and no service to have one.
 *   BankConnections               the modal that lists a person's bank logins.
 *                                 A consent held by a server, a token refreshed
 *                                 by a cron, and an institution polled on a
 *                                 schedule: the banking region entire. Nothing
 *                                 opens it here — both call sites are behind a
 *                                 button this edition does not draw — and it
 *                                 answers `null` rather than throwing for the
 *                                 same reason the two sync promises resolve.
 *   useBankConnectionSnapshot     the connections already in memory. It never
 *                                 fetched anything even in a browser, but the
 *                                 SERVICE behind it does, and it was reached by
 *                                 the Dashboard and the register — so it is the
 *                                 member the bundle grep found rather than the
 *                                 import walk (`adminClerkId`, a banking-ops
 *                                 query parameter, is a string in that service's
 *                                 URL builder, and no walk of ours calls a string
 *                                 a leak).
 *   useAccountBankSync            per-account feed state and the act of pulling
 *                                 it. The inert result below is what makes the
 *                                 Accounts page's own guards do the work: every
 *                                 account's link is `undefined`, so no feed row
 *                                 draws, and `connectedCount` is 0, so the
 *                                 "Refresh feeds" button is not rendered. NOT
 *                                 ONE LINE of that page changed.
 *
 * ── WHY NOTHING, RATHER THAN AN EXPLANATION ─────────────────────────────────
 *
 * A panel saying "subscriptions are not available in the local edition" would be
 * telling a person about a product they did not buy, on a settings page they
 * opened to change something else. The edition's own terms belong in its About
 * screen and its licence — which is the ruling `NEVER_ON_A_DESKTOP` already made
 * about `/privacy` and `/terms`, applied one level down.
 *
 * ── WHY THE HOOK'S PROMISES REJECT NOTHING AND DO NOTHING ───────────────────
 *
 * `syncAccount` and `syncAllConnections` resolve rather than throwing "not
 * supported". Nothing can call them: both are behind UI that only exists when
 * there is a connection, and there is never a connection. A throw would be a
 * refusal nobody can provoke, and the first person to provoke it would be a test
 * asserting a message no user can see.
 */

import type { BankConnection } from '../../services/bankConnectionService';
import type {
  ServiceBankConnections,
  ServiceIncidentBadge,
  ServicePanel,
  ServiceSessionGuard,
  UseServiceBankConnections,
  UseServiceBankSync
} from '../../editions/service';

/** The same list the cloud half re-exports. */
export type {
  BankingIncidentBadgeMode,
  BankingIncidentBadgeProps,
  ServiceBankConnections,
  ServiceBankConnectionsProps,
  ServiceIncidentBadge,
  ServicePanel,
  UseServiceBankConnections,
  UseServiceBankSync
} from '../../editions/service';

/** Nothing is sold from inside this router. */
export const SubscriptionStatus: ServicePanel = () => null;

/** No server polls anything, so there is no schedule to set. */
export const BankFeedRefreshSettings: ServicePanel = () => null;

/**
 * No phone to push to, and no server to push from. The cloud half draws
 * this only inside the iOS shell in any case; a desktop window is neither.
 */
export const PhoneNotificationSettings: ServicePanel = () => null;

/** No server to mint a widget's key, and no home screen to draw one on. */
export const WidgetSettings: ServicePanel = () => null;

/** No account with anybody to close. See the header for where the wipe lives. */
export const DangerZone: ServicePanel = () => null;

/** Nobody is signed in, so there is no session to end. See the header. */
export const SignOutPanel: ServicePanel = () => null;

/** …and therefore no session to time out either. */
export const SessionGuard: ServiceSessionGuard = () => null;

/** No feed, so no incident. */
export const BankingCriticalIncidentBadge: ServiceIncidentBadge = () => null;

/**
 * No connections, and the shape that says so.
 *
 * Rebuilt on every call rather than frozen at module scope, and deliberately: it
 * is destructured immediately by its one caller and never compared, so a shared
 * object would buy nothing and would be a shared mutable in a module that has
 * no other state. Six fields is cheaper than the argument.
 */
export const useAccountBankSync: UseServiceBankSync = () => ({
  getAccountLink: () => undefined,
  isAccountSyncing: () => false,
  syncAccount: () => Promise.resolve(),
  syncAllConnections: () => Promise.resolve(),
  connectedCount: 0,
  // No connections at all, so none of them can be broken — the Accounts page's
  // own guard reads this as "nothing to warn about" and the button stays quiet.
  feedsNeedingAttention: 0,
  isSyncingAny: false,
  reloadConnections: () => Promise.resolve()
});

/** No bank logins to list, and nothing that could open the list anyway. */
export const BankConnections: ServiceBankConnections = () => null;

/**
 * No connections, ever.
 *
 * A module-level constant, unlike the sync result above, and for a reason that
 * is React's rather than taste: this feeds `useSyncExternalStore` in the cloud
 * and is compared by IDENTITY by every consumer's `useMemo`. A fresh `[]` per
 * render would re-run the dashboard's attention-item build on every paint.
 */
const NO_CONNECTIONS: BankConnection[] = [];

export const useBankConnectionSnapshot: UseServiceBankConnections = () => NO_CONNECTIONS;
