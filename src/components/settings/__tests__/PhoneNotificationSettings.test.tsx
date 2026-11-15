import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import PhoneNotificationSettings from '../PhoneNotificationSettings';
import { preferences } from '../../../services/preferencesService';

/**
 * PHONE NOTIFICATIONS — the card that exists only where a push can.
 *
 * Two facts worth holding still. Outside the iOS shell the card is ABSENT,
 * not disabled: a browser has no APNs token and a switch there would be a
 * claim the app cannot keep. Inside it, a switch whose precondition is unmet
 * says which card above supplies it, rather than vanishing.
 *
 * Clerk is answered signed-in here (the suite-wide stub in test/setup.ts
 * answers signed-out, which would hide the card for the wrong reason); the
 * database id and the native plugin are stubbed because both are bridges to
 * things a test runner does not have — a Postgres row and iOS. No service is
 * mocked.
 */

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isSignedIn: true, userId: 'user_invented' }),
}));

vi.mock('../../../hooks/useUserId', () => ({
  useUserId: () => ({ databaseId: 'db-user-invented', clerkId: 'user_invented', isLoading: false, error: null, refresh: async () => undefined }),
}));

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: async () => ({ receive: 'prompt' }),
    requestPermissions: async () => ({ receive: 'granted' }),
    register: async () => undefined,
    addListener: async () => ({ remove: async () => undefined }),
  },
}));

const pretendToBeTheShell = (): void => {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
};

describe('PhoneNotificationSettings', () => {
  beforeEach(() => {
    preferences.detach();
    localStorage.clear();
  });

  afterEach(() => {
    delete window.Capacitor;
  });

  it('draws nothing at all in a browser — a switch a page cannot honour is not offered', () => {
    const { container } = render(<PhoneNotificationSettings />);
    expect(container).toBeEmptyDOMElement();
  });

  it('inside the shell, offers the five switches and names what each one needs', () => {
    pretendToBeTheShell();
    render(<PhoneNotificationSettings />);

    expect(screen.getByRole('heading', { name: 'Phone notifications' })).toBeInTheDocument();
    const feedActivity = screen.getByRole('checkbox', { name: /New transactions/ });
    const feedAttention = screen.getByRole('checkbox', { name: /A feed needs reconnecting/ });
    const reminders = screen.getByRole('checkbox', { name: /Balance reminders/ });
    const lowBalances = screen.getByRole('checkbox', { name: /Low balances/ });
    const budgets = screen.getByRole('checkbox', { name: /^Budgets/ });

    // Bank feed refresh is not 'cloud', so every switch is disabled — cloud
    // mode is the door to the whole card (the owner's ruling, 11 Sep), and
    // each switch names it before anything else it might also need.
    expect(feedActivity).toBeDisabled();
    expect(feedAttention).toBeDisabled();
    expect(reminders).toBeDisabled();
    expect(lowBalances).toBeDisabled();
    expect(budgets).toBeDisabled();
    expect(screen.getAllByText('Needs Bank feed refresh set to In the cloud, above.')).toHaveLength(5);
    expect(screen.queryByText(/Needs a reminder schedule/)).not.toBeInTheDocument();
  });

  it('in cloud mode with no schedule, only the reminder switch stays off — and says why', () => {
    pretendToBeTheShell();
    preferences.setItem('bankAutoSync.prefs.v1', '{"mode":"cloud","dailyTime":"08:00"}');
    render(<PhoneNotificationSettings />);

    expect(screen.getByRole('checkbox', { name: /New transactions/ })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /Low balances/ })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /^Budgets/ })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /Balance reminders/ })).toBeDisabled();
    expect(screen.getByText('Needs a reminder schedule in Balance reminders, above.')).toBeInTheDocument();
  });

  it('the feed switches come alive with cloud mode, the reminder switch with a schedule', () => {
    pretendToBeTheShell();
    preferences.setItem('bankAutoSync.prefs.v1', '{"mode":"cloud","dailyTime":"08:00"}');
    preferences.setItem('balanceReminders.prefs.v1', '{"schedule":"daily","time":"08:30","weekday":1,"monthDay":1}');
    render(<PhoneNotificationSettings />);

    expect(screen.getByRole('checkbox', { name: /New transactions/ })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /A feed needs reconnecting/ })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /Balance reminders/ })).toBeEnabled();
    expect(screen.queryByText(/Needs Bank feed refresh/)).not.toBeInTheDocument();
  });

  it('says out loud that no push ever carries an amount', () => {
    pretendToBeTheShell();
    render(<PhoneNotificationSettings />);
    expect(screen.getByText(/Never an amount/)).toBeInTheDocument();
  });
});
