/**
 * `@service`, in a browser: the eight, as they have always been — bar one.
 *
 * The cloud half of the seam `editions/service.ts` declares, and the twin of
 * `desktop/editions/service.ts`. Eight typed re-bindings and nothing else, for
 * `services/port/index.ts`'s reason: the CHOICE is the file, and a choosing file
 * that also does work is a file whose work only one edition gets.
 *
 * `SignOutPanel` is the one that is not "as it has always been": it is new, and
 * it is here rather than on the page because `/settings` is mounted by both
 * editions and only one of them has anybody to sign out. See the component.
 *
 * The annotations are the check. Each `const X: SomeContractType = Y` is the
 * compiler being asked whether the shipped component or hook still answers what
 * the pages are written to give it — which for three of these is nothing, and
 * for the other two is a props object and an options object. A member that grew
 * a required prop would stop compiling here rather than in whichever edition
 * happened to be built next.
 */

import SubscriptionStatusComponent from '../../components/SubscriptionStatus';
import BankFeedRefreshSettingsComponent from '../../components/settings/BankFeedRefreshSettings';
import PhoneNotificationSettingsComponent from '../../components/settings/PhoneNotificationSettings';
import WidgetSettingsComponent from '../../components/settings/WidgetSettings';
import DangerZoneComponent from '../../components/settings/DangerZone';
import SignOutPanelComponent from '../../components/settings/SignOutPanel';
import SessionGuardComponent from '../../components/SessionGuard';
import BankingCriticalIncidentBadgeComponent from '../../components/BankingCriticalIncidentBadge';
import { useAccountBankSync as useAccountBankSyncHook } from '../../hooks/useAccountBankSync';
import { useBankConnectionSnapshot as useBankConnectionSnapshotHook } from '../../hooks/useBankConnectionSnapshot';
import { lazyWithRecovery } from '../../utils/lazyWithRecovery';
import type {
  ServiceBankConnections,
  ServiceSessionGuard,
  ServiceIncidentBadge,
  ServicePanel,
  UseServiceBankConnections,
  UseServiceBankSync
} from '../service';

/** One specifier, values and types together. See `services/port/index.ts`. */
export type {
  BankingIncidentBadgeMode,
  BankingIncidentBadgeProps,
  ServiceBankConnections,
  ServiceBankConnectionsProps,
  ServiceIncidentBadge,
  ServicePanel,
  UseServiceBankConnections,
  UseServiceBankSync
} from '../service';

/** The billing card at the top of /settings: plan, renewal, manage. */
export const SubscriptionStatus: ServicePanel = SubscriptionStatusComponent;

/** How often the server re-polls the bank, on /settings/app. */
export const BankFeedRefreshSettings: ServicePanel = BankFeedRefreshSettingsComponent;

/** What the phone may push, on /settings/app — drawn only inside the iOS shell. */
export const PhoneNotificationSettings: ServicePanel = PhoneNotificationSettingsComponent;

/** The home-screen widgets' key and how they draw, on /settings/app — only in a shell that has them. */
export const WidgetSettings: ServicePanel = WidgetSettingsComponent;

/** Delete the whole account — Stripe, rows, and the Clerk identity. */
export const DangerZone: ServicePanel = DangerZoneComponent;

/** End the session, from the page people look on for it. */
export const SignOutPanel: ServicePanel = SignOutPanelComponent;
export const SessionGuard: ServiceSessionGuard = SessionGuardComponent;

/** "The bank feed is having an incident", on /accounts. */
export const BankingCriticalIncidentBadge: ServiceIncidentBadge =
  BankingCriticalIncidentBadgeComponent;

/** Which accounts a bank connection backs, and the button that refreshes them. */
export const useAccountBankSync: UseServiceBankSync = useAccountBankSyncHook;

/**
 * The bank-connections modal, still its own chunk.
 *
 * The declaration moved here verbatim from `pages/Accounts.tsx` and
 * `pages/settings/DataManagement.tsx`, which each had one — so this is also one
 * chunk where there were two identical ones.
 */
export const BankConnections: ServiceBankConnections = lazyWithRecovery(
  () => import('../../components/BankConnections')
);

/** The connections already in memory, read without provoking a fetch. */
export const useBankConnectionSnapshot: UseServiceBankConnections =
  useBankConnectionSnapshotHook;
