import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useApp } from '../contexts/AppContextSupabase';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useCurrencyDecimal } from '../hooks/useCurrencyDecimal';
import { calculateBudgetSpending, calculateBudgetPercentage } from '../utils/calculations-decimal';
import { toDecimal, toStorageNumber } from '../utils/decimal';
import { evaluateBudgets } from '../utils/budgetEvaluation';
import { BUDGET_VIEW_KEY, measureBudget, parseBudgetView } from '../utils/budgetView';
import { preferences } from '../services/preferencesService';
import { toDecimalTransaction } from '../utils/decimal-converters';
import { expandSplitTransactions } from '../utils/transactionSplits';
import { formatDecimal } from '../utils/decimal-format';
import type { DecimalInstance, DecimalBudget } from '../types/decimal-types';
import {
  BellIcon,
  AlertCircleIcon,
  CheckCircleIcon,
  SettingsIcon,
  InfoIcon,
  XIcon,
  FilterIcon,
  BellOffIcon
} from './icons';
import { formatDateTime } from '../utils/dateFormatter';

interface AlertConfig {
  id: string;
  name: string;
  enabled: boolean;
  thresholds: {
    warning: number; // Percentage
    critical: number; // Percentage
  };
  notificationTypes: {
    inApp: boolean;
    email: boolean;
    push: boolean;
  };
  frequency: 'realtime' | 'daily' | 'weekly';
  categories: string[]; // Empty means all categories
  sound: boolean;
  vibrate: boolean;
}

const formatPercentage = (value: DecimalInstance | number, decimals: number = 0): string => {
  return formatDecimal(value, decimals);
};

interface Alert {
  id: string;
  configId: string;
  budgetId: string;
  /** Category ID. The display name is resolved from `categories` at render. */
  categoryId: string;
  type: 'warning' | 'critical';
  percentage: number;
  spent: DecimalInstance;
  budget: DecimalInstance;
  remaining: DecimalInstance;
  message: string;
  timestamp: Date;
  isRead: boolean;
  isDismissed: boolean;
}

/**
 * What actually goes into localStorage.
 *
 * `useLocalStorage` has no reviver, so a Decimal comes back as the string
 * decimal.js serialises to (no `.greaterThan()`) and a Date comes back as a
 * string (no `.getTime()`). Persisting the runtime shape meant this tab crashed
 * the first time it was reopened after any alert had fired. Plain numbers and
 * an ISO string go in; everything is rehydrated on read.
 */
interface StoredAlert {
  id: string;
  configId: string;
  budgetId: string;
  categoryId: string;
  type: 'warning' | 'critical';
  percentage: number;
  spent: number;
  budget: number;
  remaining: number;
  message: string;
  timestamp: string;
  isRead: boolean;
  isDismissed: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readString = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Expected a string');
  return value;
};

const readNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Expected a finite number');
  }
  return value;
};

/** Money, as either a number or the numeric string decimal.js serialises to. */
const readMoney = (value: unknown): number => {
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return readNumber(value);
};

const readAlertType = (value: unknown): Alert['type'] => {
  if (value !== 'warning' && value !== 'critical') throw new Error('Expected an alert type');
  return value;
};

/**
 * Rehydrate one stored alert, or discard it.
 *
 * Alerts written before this fix carry `category` rather than `categoryId`, and
 * their message text names a raw UUID because the category was looked up by
 * name. They are deliberately dropped: an alert is a re-derivable notice, not a
 * financial record, and the next sweep raises a correctly-worded one within the
 * minute if the budget is still over.
 */
const reviveAlert = (raw: unknown): Alert | null => {
  try {
    if (!isRecord(raw)) return null;
    const timestamp = new Date(readString(raw.timestamp));
    if (Number.isNaN(timestamp.getTime())) return null;

    return {
      id: readString(raw.id),
      configId: readString(raw.configId),
      budgetId: readString(raw.budgetId),
      categoryId: readString(raw.categoryId),
      type: readAlertType(raw.type),
      percentage: readMoney(raw.percentage),
      spent: toDecimal(readMoney(raw.spent)),
      budget: toDecimal(readMoney(raw.budget)),
      remaining: toDecimal(readMoney(raw.remaining)),
      message: readString(raw.message),
      timestamp,
      isRead: raw.isRead === true,
      isDismissed: raw.isDismissed === true
    };
  } catch {
    return null;
  }
};

const toStoredAlert = (alert: Alert): StoredAlert => ({
  id: alert.id,
  configId: alert.configId,
  budgetId: alert.budgetId,
  categoryId: alert.categoryId,
  type: alert.type,
  percentage: alert.percentage,
  spent: toStorageNumber(alert.spent),
  budget: toStorageNumber(alert.budget),
  remaining: toStorageNumber(alert.remaining),
  message: alert.message,
  timestamp: alert.timestamp.toISOString(),
  isRead: alert.isRead,
  isDismissed: alert.isDismissed
});

interface AlertStats {
  totalAlerts: number;
  unreadAlerts: number;
  warningAlerts: number;
  criticalAlerts: number;
  mostAlertedCategory: string;
  averageSpendingPercentage: number;
}

const DEFAULT_ALERT_CONFIGS: AlertConfig[] = [
  {
    id: '1',
    name: 'Budget Warning',
    enabled: true,
    thresholds: { warning: 75, critical: 90 },
    notificationTypes: { inApp: true, email: false, push: false },
    frequency: 'realtime',
    categories: [],
    sound: false,
    vibrate: false
  },
  {
    id: '2',
    name: 'Overspending Alert',
    enabled: true,
    thresholds: { warning: 90, critical: 100 },
    notificationTypes: { inApp: true, email: true, push: true },
    frequency: 'realtime',
    categories: [],
    sound: true,
    vibrate: true
  },
  {
    id: '3',
    name: 'Weekly Summary',
    enabled: false,
    thresholds: { warning: 50, critical: 80 },
    notificationTypes: { inApp: true, email: true, push: false },
    frequency: 'weekly',
    categories: [],
    sound: false,
    vibrate: false
  }
];

export default function SpendingAlerts() {
  const { categories, transactions, transactionSplits, budgets } = useApp();
  const { formatCurrency } = useCurrencyDecimal();

  const [alertConfigs, setAlertConfigs] = useLocalStorage<AlertConfig[]>('alert-configs', DEFAULT_ALERT_CONFIGS);
  // Typed as `unknown`: whatever is on this device may predate the stored
  // shape, so it is validated on read rather than trusted.
  const [storedAlerts, setStoredAlerts] = useLocalStorage<unknown>('spending-alerts', []);
  const [showSettings, setShowSettings] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread' | 'warning' | 'critical'>('all');
  /** Category IDs, matching `budget.categoryId`. */
  const [mutedCategories, setMutedCategories] = useState<string[]>([]);

  const storedAlertEntries = useMemo<unknown[]>(
    () => (Array.isArray(storedAlerts) ? storedAlerts : []),
    [storedAlerts]
  );

  const alerts = useMemo<Alert[]>(
    () => storedAlertEntries.map(reviveAlert).filter((alert): alert is Alert => alert !== null),
    [storedAlertEntries]
  );

  const setAlerts = useCallback(
    (next: Alert[]) => setStoredAlerts(next.map(toStoredAlert)),
    [setStoredAlerts]
  );

  // Migrate the payload in place the first time it is read, so the broken
  // payload is not re-parsed on every render of every session.
  // `toStoredAlert(revive(x))` is a fixed point, so this settles in one write.
  useEffect(() => {
    if (JSON.stringify(alerts.map(toStoredAlert)) !== JSON.stringify(storedAlertEntries)) {
      setAlerts(alerts);
    }
  }, [alerts, storedAlertEntries, setAlerts]);

  // Budgets key on a category ID; the name is for humans only. Comparing a
  // category NAME against `budget.categoryId` never matched, which is why
  // alerts used to name a raw UUID.
  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    categories.forEach(category => {
      if (category?.id) map.set(category.id, category.name);
      if (category?.name) map.set(category.name, category.name);
    });
    return map;
  }, [categories]);

  const getCategoryLabel = useCallback(
    (categoryId: string) => categoryNameById.get(categoryId) ?? categoryId,
    [categoryNameById]
  );

  // Check for new alerts
  useEffect(() => {
    const checkAlerts = () => {
      const now = new Date();
      // The allowance the Budget page shows — the plan plus whatever carry
      // the budget's mode allows in from the cycles before — so an alert
      // matches the spendable amount (utils/budgetEvaluation).
      // …and read as the person reads a long budget (owner, 11 Nov 2026):
      // so far, this month's share, or whole. utils/budgetView.
      const view = parseBudgetView(preferences.getItem(BUDGET_VIEW_KEY));
      const evaluatedById = new Map(
        evaluateBudgets(budgets, { transactions, transactionSplits, categories, now })
          .map(entry => [entry.budget.id, entry] as const)
      );
      const allowanceById = new Map(
        [...evaluatedById].map(([id, entry]) => [id, entry.effectiveAmount] as const)
      );
      const decimalBudgets: DecimalBudget[] = budgets.map(b => ({
        ...b,
        amount: allowanceById.get(b.id) ?? toDecimal(b.amount)
      }));
      // Split parents expand into per-line rows so split lines alert
      // against THEIR categories' budgets.
      const decimalTransactions = expandSplitTransactions(transactions, transactionSplits)
        .map(toDecimalTransaction);
      const newAlerts: Alert[] = [];

      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();
      const startDate = new Date(currentYear, currentMonth, 1);
      const endDate = new Date(currentYear, currentMonth + 1, 0);
      
      budgets.forEach(budget => {
        if (mutedCategories.includes(budget.categoryId)) return;
        
        const decimalBudget = decimalBudgets.find((db: DecimalBudget) => db.id === budget.id);
        if (!decimalBudget || !budget.isActive) return;
        
        // A budget with months to be read by is measured under the reading:
        // its own spend against its own allowance for the same stretch. This
        // line used to set ONE CALENDAR MONTH's spend against the allowance
        // for the budget's WHOLE window — a yearly budget could spend twelve
        // times its month before it warned. Budgets with no months (monthly,
        // weekly, paid in one go) keep the calendar-month sum they always had.
        const evaluated = evaluatedById.get(budget.id);
        const measure = evaluated?.months ? measureBudget(evaluated, view) : null;
        const allowance = measure ? measure.allowance : decimalBudget.amount;
        const spent = measure
          ? measure.spent
          : calculateBudgetSpending(decimalBudget, decimalTransactions, startDate, endDate);
        const percentage = calculateBudgetPercentage({ amount: allowance }, spent);
        const remaining = allowance.minus(spent);
        
        alertConfigs.forEach(config => {
          if (!config.enabled) return;
          if (config.categories.length > 0 && !config.categories.includes(budget.categoryId)) return;
          
          // Check if we already have this alert
          const existingAlert = alerts.find(a => 
            a.budgetId === budget.id && 
            a.configId === config.id &&
            a.timestamp.getMonth() === currentMonth &&
            a.timestamp.getFullYear() === currentYear
          );
          
          if (existingAlert && existingAlert.isDismissed) return;
          
          let alertType: 'warning' | 'critical' | null = null;
          let message = '';
          const categoryLabel = getCategoryLabel(budget.categoryId);

          if (percentage >= config.thresholds.critical) {
            alertType = 'critical';
            message = `Critical: ${categoryLabel} has reached ${formatPercentage(percentage, 0)}% of budget!`;
          } else if (percentage >= config.thresholds.warning) {
            alertType = 'warning';
            message = `Warning: ${categoryLabel} is at ${formatPercentage(percentage, 0)}% of budget`;
          }

          if (alertType && !existingAlert) {
            const newAlert: Alert = {
              id: Date.now().toString() + Math.random().toString(36).substring(2, 11),
              configId: config.id,
              budgetId: budget.id,
              categoryId: budget.categoryId,
              type: alertType,
              percentage,
              spent,
              budget: allowance,
              remaining,
              message,
              timestamp: now,
              isRead: false,
              isDismissed: false
            };
            
            newAlerts.push(newAlert);
            
            // Play sound if enabled
            if (config.sound && 'Audio' in window) {
              try {
                const audio = new Audio('/notification.mp3');
                audio.play().catch(() => {});
              } catch {
                // Ignore audio play errors - notification sound is optional
              }
            }
            
            // Vibrate if enabled
            if (config.vibrate && 'vibrate' in navigator) {
              navigator.vibrate(200);
            }
          }
        });
      });
      
      if (newAlerts.length > 0) {
        setAlerts([...newAlerts, ...alerts]);
      }
    };
    
    checkAlerts();
    const interval = setInterval(checkAlerts, 60000); // Check every minute
    
    return () => clearInterval(interval);
  }, [budgets, categories, alertConfigs, mutedCategories, transactions, transactionSplits, alerts, setAlerts, getCategoryLabel]);

  // Calculate alert statistics
  const alertStats = useMemo((): AlertStats => {
    const activeAlerts = alerts.filter(a => !a.isDismissed);
    const categoryCount: Record<string, number> = {};

    activeAlerts.forEach(alert => {
      categoryCount[alert.categoryId] = (categoryCount[alert.categoryId] || 0) + 1;
    });

    const mostAlertedCategoryId = Object.entries(categoryCount)
      .sort(([, a], [, b]) => b - a)[0]?.[0];
    const mostAlertedCategory = mostAlertedCategoryId ? getCategoryLabel(mostAlertedCategoryId) : 'None';

    const avgPercentage = activeAlerts.length > 0
      ? activeAlerts.reduce((sum, a) => sum + a.percentage, 0) / activeAlerts.length
      : 0;
    
    return {
      totalAlerts: activeAlerts.length,
      unreadAlerts: activeAlerts.filter(a => !a.isRead).length,
      warningAlerts: activeAlerts.filter(a => a.type === 'warning').length,
      criticalAlerts: activeAlerts.filter(a => a.type === 'critical').length,
      mostAlertedCategory,
      averageSpendingPercentage: avgPercentage
    };
  }, [alerts, getCategoryLabel]);

  // Filter alerts
  const filteredAlerts = useMemo(() => {
    let filtered = alerts.filter(a => !a.isDismissed);
    
    switch (filter) {
      case 'unread':
        filtered = filtered.filter(a => !a.isRead);
        break;
      case 'warning':
        filtered = filtered.filter(a => a.type === 'warning');
        break;
      case 'critical':
        filtered = filtered.filter(a => a.type === 'critical');
        break;
    }
    
    return filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }, [alerts, filter]);

  const markAsRead = (alertId: string) => {
    setAlerts(alerts.map(a => 
      a.id === alertId ? { ...a, isRead: true } : a
    ));
  };

  const dismissAlert = (alertId: string) => {
    setAlerts(alerts.map(a => 
      a.id === alertId ? { ...a, isDismissed: true } : a
    ));
  };

  const markAllAsRead = () => {
    setAlerts(alerts.map(a => ({ ...a, isRead: true })));
  };

  const toggleMuteCategory = (categoryId: string) => {
    if (mutedCategories.includes(categoryId)) {
      setMutedCategories(mutedCategories.filter(c => c !== categoryId));
    } else {
      setMutedCategories([...mutedCategories, categoryId]);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Spending Alerts</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Real-time notifications when approaching budget limits
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowSettings(true)}
              className="flex items-center gap-2 px-4 py-2 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
            >
              <SettingsIcon size={16} />
              Configure
            </button>
            {alertStats.unreadAlerts > 0 && (
              <button
                onClick={markAllAsRead}
                className="flex items-center gap-2 px-4 py-2 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
              >
                <CheckCircleIcon size={16} />
                Mark All Read
              </button>
            )}
          </div>
        </div>

        {/* Stats Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <BellIcon size={16} className="text-gray-500" />
              <span className="text-xs text-gray-600 dark:text-gray-400">Total Alerts</span>
            </div>
            <p className="text-xl font-semibold text-gray-900 dark:text-white">
              {alertStats.totalAlerts}
            </p>
          </div>
          
          {/* The other three tiles are a severity ladder — neutral, warning,
              critical. Unread is a read-state count, not a rung on it, so it
              takes the same neutral treatment "Total Alerts" already has; a
              count needs no colour (stock-blue ruling, 28 Aug 2026). */}
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <InfoIcon size={16} className="text-gray-500" />
              <span className="text-xs text-gray-600 dark:text-gray-400">Unread</span>
            </div>
            <p className="text-xl font-semibold text-gray-900 dark:text-white">
              {alertStats.unreadAlerts}
            </p>
          </div>
          
          <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <AlertCircleIcon size={16} className="text-yellow-500" />
              <span className="text-xs text-yellow-700 dark:text-yellow-300">Warnings</span>
            </div>
            <p className="text-xl font-semibold text-yellow-900 dark:text-yellow-100">
              {alertStats.warningAlerts}
            </p>
          </div>
          
          <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <AlertCircleIcon size={16} className="text-red-500" />
              <span className="text-xs text-red-700 dark:text-red-300">Critical</span>
            </div>
            <p className="text-xl font-semibold text-red-900 dark:text-red-100">
              {alertStats.criticalAlerts}
            </p>
          </div>
        </div>

        {/* Most Alerted Category */}
        {alertStats.totalAlerts > 0 && (
          <div className="mt-4 p-3 bg-orange-50 dark:bg-orange-900/20 rounded-lg">
            <p className="text-sm text-orange-800 dark:text-orange-200">
              Most alerts in <strong>{alertStats.mostAlertedCategory}</strong> • 
              Average spending: <strong>{formatPercentage(alertStats.averageSpendingPercentage, 0)}%</strong>
            </p>
          </div>
        )}
      </div>

      {/* Filter Bar */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <FilterIcon size={16} className="text-gray-500" />
          <span className="text-sm text-gray-700 dark:text-gray-300">Filter:</span>
        </div>
        <div className="flex gap-2">
          {(['all', 'unread', 'warning', 'critical'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-sm rounded-lg transition-colors ${
                filter === f
                  ? 'bg-[var(--color-primary)] text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Alerts List */}
      <div className="space-y-3">
        {filteredAlerts.map((alert) => (
          <div
            key={alert.id}
            className={`bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-100 dark:border-gray-700 p-4 transition-all ${
              /* The unread rail is a marker, so it takes the marker token —
                 navy-400, which needs no dark counterpart because it reads on
                 both grounds, unlike `border-l-primary` (navy on a gray-800
                 card is no rail at all). Stock-blue ruling, 28 Aug 2026. */
              !alert.isRead ? 'border-l-4 border-l-navy-400' : ''
            }`}
            onClick={() => markAsRead(alert.id)}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <div className={`mt-1 ${
                  alert.type === 'critical' ? 'text-red-500' : 'text-yellow-500'
                }`}>
                  <AlertCircleIcon size={20} />
                </div>
                <div className="flex-1">
                  <h4 className={`font-medium text-gray-900 dark:text-white ${
                    !alert.isRead ? 'font-semibold' : ''
                  }`}>
                    {alert.message}
                  </h4>
                  <div className="mt-2 space-y-1 text-sm text-gray-600 dark:text-gray-400">
                    <p>
                      Spent: {formatCurrency(alert.spent)} of {formatCurrency(alert.budget)} 
                      ({formatPercentage(alert.percentage, 0)}%)
                    </p>
                    <p>
                      Remaining: <span className={alert.remaining.greaterThan(0) ? 'text-green-600' : 'text-red-600'}>
                        {formatCurrency(alert.remaining)}
                      </span>
                    </p>
                  </div>
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    {formatDateTime(alert.timestamp)}
                  </p>
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  dismissAlert(alert.id);
                }}
                className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                <XIcon size={16} />
              </button>
            </div>
          </div>
        ))}
        
        {filteredAlerts.length === 0 && (
          <div className="text-center py-12 bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700">
            <BellIcon className="mx-auto text-gray-400 mb-4" size={48} />
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
              No alerts to show
            </h3>
            <p className="text-gray-500 dark:text-gray-400">
              {filter === 'all' 
                ? "You're staying within your budgets! Great job!"
                : `No ${filter} alerts found`}
            </p>
          </div>
        )}
      </div>

      {/* Muted Categories */}
      {mutedCategories.length > 0 && (
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <BellOffIcon size={16} className="text-gray-500" />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Muted Categories
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {mutedCategories.map(categoryId => (
              <span
                key={categoryId}
                className="inline-flex items-center gap-1 px-2 py-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-full text-xs"
              >
                {getCategoryLabel(categoryId)}
                <button
                  onClick={() => toggleMuteCategory(categoryId)}
                  aria-label={`Unmute ${getCategoryLabel(categoryId)}`}
                  className="hover:text-red-500"
                >
                  <XIcon size={12} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-2xl w-full max-w-3xl p-6 max-h-[80vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
              Alert Configuration
            </h3>
            
            <div className="space-y-4">
              {alertConfigs.map((config) => (
                <div
                  key={config.id}
                  className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4"
                >
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-medium text-gray-900 dark:text-white">{config.name}</h4>
                    <input
                      type="checkbox"
                      checked={config.enabled}
                      onChange={(e) => {
                        setAlertConfigs(alertConfigs.map(c => 
                          c.id === config.id ? { ...c, enabled: e.target.checked } : c
                        ));
                      }}
                      className="rounded"
                    />
                  </div>
                  
                  {config.enabled && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                            Warning Threshold (%)
                          </label>
                          <input
                            type="number"
                            value={config.thresholds.warning}
                            onChange={(e) => {
                              setAlertConfigs(alertConfigs.map(c => 
                                c.id === config.id 
                                  ? { ...c, thresholds: { ...c.thresholds, warning: parseInt(e.target.value) || 0 }}
                                  : c
                              ));
                            }}
                            min="0"
                            max="100"
                            className="w-full px-3 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          />
                        </div>
                        <div>
                          <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                            Critical Threshold (%)
                          </label>
                          <input
                            type="number"
                            value={config.thresholds.critical}
                            onChange={(e) => {
                              setAlertConfigs(alertConfigs.map(c => 
                                c.id === config.id 
                                  ? { ...c, thresholds: { ...c.thresholds, critical: parseInt(e.target.value) || 0 }}
                                  : c
                              ));
                            }}
                            min="0"
                            max="100"
                            className="w-full px-3 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          />
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-4">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={config.notificationTypes.inApp}
                            onChange={(e) => {
                              setAlertConfigs(alertConfigs.map(c => 
                                c.id === config.id 
                                  ? { ...c, notificationTypes: { ...c.notificationTypes, inApp: e.target.checked }}
                                  : c
                              ));
                            }}
                            className="rounded"
                          />
                          <span className="text-sm text-gray-700 dark:text-gray-300">In-App</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={config.sound}
                            onChange={(e) => {
                              setAlertConfigs(alertConfigs.map(c => 
                                c.id === config.id ? { ...c, sound: e.target.checked } : c
                              ));
                            }}
                            className="rounded"
                          />
                          <span className="text-sm text-gray-700 dark:text-gray-300">Sound</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={config.vibrate}
                            onChange={(e) => {
                              setAlertConfigs(alertConfigs.map(c => 
                                c.id === config.id ? { ...c, vibrate: e.target.checked } : c
                              ));
                            }}
                            className="rounded"
                          />
                          <span className="text-sm text-gray-700 dark:text-gray-300">Vibrate</span>
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            
            <div className="mt-6">
              <h4 className="font-medium text-gray-900 dark:text-white mb-3">Mute Categories</h4>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {categories.map(category => (
                  <label key={category.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={mutedCategories.includes(category.id)}
                      onChange={() => toggleMuteCategory(category.id)}
                      className="rounded"
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">{category.name}</span>
                  </label>
                ))}
              </div>
            </div>
            
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 bg-[var(--color-primary)] text-white rounded-lg hover:bg-[var(--color-primary)]/90"
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
