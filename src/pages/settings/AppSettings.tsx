import { ArrowLeftIcon, MoonIcon, SunIcon, MonitorIcon, ClockIcon } from '../../components/icons';
import { useNavigate } from 'react-router-dom';
import { usePreferences } from '../../contexts/PreferencesContext';
import PageWrapper from '../../components/PageWrapper';
import BudgetAlertSettings from '../../components/BudgetAlertSettings';
import LargeTransactionAlertSettings from '../../components/LargeTransactionAlertSettings';
import LocaleSelector from '../../components/settings/LocaleSelector';
import ShowTipsAgain from '../../components/settings/ShowTipsAgain';
import DisplayDiagnostics from '../../components/DisplayDiagnostics';
// Through the seam: a refresh schedule is a thing a SERVER keeps, and so is
// a push — a phone registers with one. See src/editions/service.ts.
import { BankFeedRefreshSettings, PhoneNotificationSettings, WidgetSettings } from '@service';
// Directly, no seam: a balance reminder is the app talking to its own owner —
// no bank, no server, both editions alike.
import BalanceReminderSettings from '../../components/settings/BalanceReminderSettings';

export default function AppSettings() {
  const navigate = useNavigate();
  const { 
    currency, 
    setCurrency,
    theme,
    setTheme,
    themeSchedule,
    setThemeSchedule,
  } = usePreferences();

  const currencies = [
    { code: 'USD', name: 'US Dollar', symbol: '$' },
    { code: 'EUR', name: 'Euro', symbol: '€' },
    { code: 'GBP', name: 'British Pound', symbol: '£' },
    { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
    { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$' },
    { code: 'AUD', name: 'Australian Dollar', symbol: 'A$' },
    { code: 'CHF', name: 'Swiss Franc', symbol: 'Fr' },
    { code: 'CNY', name: 'Chinese Yuan', symbol: '¥' },
    { code: 'INR', name: 'Indian Rupee', symbol: '₹' },
    { code: 'MXN', name: 'Mexican Peso', symbol: '$' },
  ];

  const themeOptions = [
    { value: 'light', label: 'Light', icon: SunIcon },
    { value: 'dark', label: 'Dark', icon: MoonIcon },
    { value: 'auto', label: 'Auto', icon: MonitorIcon },
    { value: 'scheduled', label: 'Scheduled', icon: ClockIcon },
  ];


  // Every section below is a sibling card inside the wrapper's content
  // container, so the gap between any two of them comes from the one
  // `space-y-6` and nowhere else. Sections must not carry their own top or
  // bottom margins, or the vertical rhythm disagrees with itself again.
  return (
    <PageWrapper
      title="App Settings"
      contentClassName="space-y-6"
      rightContent={
        <button
          onClick={() => navigate('/settings')}
          className="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-gray-700 transition-colors"
          title="Back to Settings"
        >
          <ArrowLeftIcon size={16} />
        </button>
      }
    >
      <BankFeedRefreshSettings />

      <BalanceReminderSettings />

      {/* Third, because it depends on the two above it — its switches say so
          by name. Absent outside the iOS shell. */}
      <PhoneNotificationSettings />

      {/* Beside the other card that is about the phone in the hand. Absent
          outside an iOS shell that carries the widget. */}
      <WidgetSettings />

      {/* Personal Information retired 2026-08-26. The field held a first name
          whose caption made two claims the app could not keep — it named a
          dashboard welcome message that had already been retired, and a "User"
          fallback nothing implemented. Its one remaining reader was a greeting
          in the redirect interstitial that flashes for a single render on the
          way to the dashboard. The cloud edition already learns a name at
          sign-up, and the desktop edition has no person to name: its identity
          is the ledger FILE, and the @identity seam deliberately refuses to
          answer "what is this called". */}

      {/* Region & Date Format — and Base Currency inside it (owner, 28 Aug):
          where you are and what you count in are one decision, and they were
          two cards saying "Choose your preferred…" one after the other. */}
      <LocaleSelector>
        <label htmlFor="base-currency" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Base Currency
        </label>
        {/* No aria-label: the visible <label> IS the name, and an aria-label
            saying something else ("Default currency") makes the accessible
            name disagree with the words on screen — label-in-name. */}
        <select
          id="base-currency"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          className="w-full px-4 py-2 bg-white dark:bg-gray-800 border border-gray-300/50 dark:border-gray-600/50 rounded-xl focus:border-transparent dark:text-white"
        >
          {currencies.map((curr) => (
            <option key={curr.code} value={curr.code}>
              {curr.code} - {curr.name} ({curr.symbol})
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Your net worth and every conversion are stated in this currency.
        </p>
      </LocaleSelector>

      {/* Appearance */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-line dark:border-gray-700 p-6">
        <h2 className="text-card font-semibold text-theme-heading dark:text-white mb-4">Appearance</h2>
        
        {/* Theme Selection */}
        <div className="mb-6">
          <label className="block text-body font-medium text-gray-700 dark:text-gray-300 mb-3">
            Theme
          </label>
          <div className="grid grid-cols-3 gap-3">
            {themeOptions.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                onClick={() => setTheme(value as 'light' | 'dark' | 'auto' | 'scheduled')}
                className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 transition-colors ${
                  /* The selected state used to read, in dark mode,
                     `dark:bg-primary/20 dark:text-primary` — and produced
                     NEITHER. `--color-primary` is the near-black navy, so the
                     label was navy on near-black; and an opacity on a bare
                     `var()` emits no CSS at all, so there was no surface under
                     it either. The theme you were actually using was the one
                     option you could not see. Dark mode now gets a real surface
                     and real ink. See darkModeUtilities.test.ts. */
                  theme === value
                    ? 'border-primary bg-[#1a2332]/10 text-primary dark:border-gray-400 dark:bg-gray-700 dark:text-white'
                    : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500 text-gray-700 dark:text-gray-300'
                }`}
              >
                <Icon size={20} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Theme Scheduling */}
        {theme === 'scheduled' && (
          <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
            <div className="flex items-center gap-2 mb-3">
              <ClockIcon size={20} className="text-primary" />
              <h3 className="text-body font-medium text-gray-700 dark:text-gray-300">
                Schedule Settings
              </h3>
            </div>
            
            <div className="space-y-3">
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={themeSchedule.enabled}
                  onChange={(e) => setThemeSchedule({ ...themeSchedule, enabled: e.target.checked })}
                  className="w-4 h-4 text-primary bg-gray-100 border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600"
                />
                <span className="text-body text-gray-700 dark:text-gray-300">Enable scheduling</span>
              </label>
              
              {themeSchedule.enabled && (
                <div className="grid grid-cols-2 gap-4 ml-7">
                  <div>
                    <label className="block text-dense text-gray-600 dark:text-gray-400 mb-1">
                      Light theme starts at
                    </label>
                    <input
                      type="time"
                      value={themeSchedule.lightStartTime}
                      onChange={(e) => setThemeSchedule({ ...themeSchedule, lightStartTime: e.target.value })}
                      className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300/50 dark:border-gray-600/50 rounded-lg focus:border-transparent dark:text-white text-body"
                    />
                  </div>
                  <div>
                    <label className="block text-dense text-gray-600 dark:text-gray-400 mb-1">
                      Dark theme starts at
                    </label>
                    <input
                      type="time"
                      value={themeSchedule.darkStartTime}
                      onChange={(e) => setThemeSchedule({ ...themeSchedule, darkStartTime: e.target.value })}
                      className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300/50 dark:border-gray-600/50 rounded-lg focus:border-transparent dark:text-white text-body"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Page Visibility retired 2026-08-26, and with it the last toggle in a
          section whose other entries had already gone the same way (see the
          note on the toggles array above). "Investments" gated ONE link in the
          mobile drawer; the desktop top nav's Investments entry was never
          behind it, the route was unconditional in both routers, and the
          keyboard shortcut ignored it — so a control captioned "choose which
          pages appear in the navigation sidebar" did not govern the sidebar it
          was shown beside. */}

      {/* Budget Alerts */}
      <BudgetAlertSettings />

      {/* Large Transaction Alerts */}
      <LargeTransactionAlertSettings />

      {/* Goal Celebrations retired 2026-08-14 with the Goals page. The toggle promised
          "confetti and celebration messages when you achieve your goals" and, once Goals
          went, nothing read the preference and no goal could be achieved. A control that
          changes nothing is worse than a missing one: it is a claim the app can't keep. */}

      {/* Page Tips */}
      <ShowTipsAgain />

      {/* What the device reports about its screen and app mode — the block
          exists because the iOS wrapper's answers cannot be read from a
          screenshot, and the installed app cannot take the debug-overlay's
          URL parameter. See the component's header. */}
      <DisplayDiagnostics />
    </PageWrapper>
  );
}