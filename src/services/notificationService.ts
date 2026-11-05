import type { Transaction, TransactionSplit, Budget, Goal, Category } from '../types';
import type { Notification } from '../contexts/NotificationContext';
import type { JsonValue, UnknownObject } from '../types/common';
import { formatCurrency as formatCurrencyDecimal } from '../utils/currency-decimal';
import { createScopedLogger, type ScopedLogger } from '../loggers/scopedLogger';
import { calculateBudgetSpend, prepareBudgetTransactions } from '../utils/budgetSpending';
import { getEffectiveBudgetAmount } from '../utils/budgetAmounts';
import { calculateBudgetPercentage } from '../utils/calculations-decimal';
import { buildTransactionRegisterPath } from '../utils/transactionDeepLink';

export interface NotificationRule {
  id: string;
  name: string;
  type: 'budget' | 'transaction' | 'goal' | 'account' | 'recurring';
  enabled: boolean;
  conditions: NotificationCondition[];
  actions: NotificationAction[];
  priority: 'low' | 'medium' | 'high' | 'urgent';
  cooldown?: number; // Minutes between similar notifications
  created: Date;
  lastTriggered?: Date;
}

export interface NotificationCondition {
  field: string;
  operator: 'equals' | 'greater_than' | 'less_than' | 'contains' | 'percentage_of' | 'date_range';
  value: JsonValue;
  description: string;
}

export interface NotificationAction {
  type: 'show_notification' | 'send_email' | 'play_sound' | 'mark_urgent';
  config: {
    title: string;
    message: string;
    icon?: string;
    sound?: string;
    actionButton?: {
      label: string;
      action: string;
    };
  };
}

export interface BudgetAlertConfig {
  warningThreshold: number; // Percentage (e.g., 80)
  dangerThreshold: number; // Percentage (e.g., 100)
  enableMonthlyReset: boolean;
  enableProjectedOverspend: boolean;
  enableCategoryComparison: boolean;
}

export interface TransactionAlertConfig {
  largeTransactionThreshold: number;
  unusualSpendingEnabled: boolean;
  duplicateDetectionEnabled: boolean;
  merchantAlertEnabled: boolean;
  foreignTransactionEnabled: boolean;
}

/**
 * What the caller knows about the spending behind a budget alert, beyond the
 * transactions themselves.
 *
 * WHY: alerts used to sum raw expense rows, which meant a split shop counted
 * for nothing, a refund counted for nothing, and euro rows joined a sterling
 * total. Passing the same two facts the Budget page holds keeps the alert and
 * the card describing one figure.
 */
export interface BudgetAlertContext {
  /** Split lines, so a split parent spends against ITS lines' categories. */
  transactionSplits?: TransactionSplit[];
  /** Accounts in another currency — their rows are left out of the spend. */
  foreignAccountIds?: ReadonlySet<string>;
}

export interface GoalCelebrationConfig {
  milestonePercentages: number[]; // e.g., [25, 50, 75, 100]
  enableCompletionCelebration: boolean;
  enableMilestoneNotifications: boolean;
  enableProgressReminders: boolean;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

type NavigateFn = (path: string) => void;

export interface NotificationServiceOptions {
  storage?: StorageLike | null;
  navigate?: NavigateFn | null;
  logger?: ScopedLogger;
  now?: () => number;
}

export class NotificationService {
  private rules: NotificationRule[] = [];
  private budgetAlertConfig: BudgetAlertConfig = {
    warningThreshold: 80,
    dangerThreshold: 100,
    enableMonthlyReset: true,
    enableProjectedOverspend: true,
    enableCategoryComparison: true
  };
  private transactionAlertConfig: TransactionAlertConfig = {
    largeTransactionThreshold: 500,
    unusualSpendingEnabled: true,
    duplicateDetectionEnabled: true,
    merchantAlertEnabled: true,
    foreignTransactionEnabled: true
  };
  private goalCelebrationConfig: GoalCelebrationConfig = {
    milestonePercentages: [25, 50, 75, 100],
    enableCompletionCelebration: true,
    enableMilestoneNotifications: true,
    enableProgressReminders: true
  };
  private storage: StorageLike | null;
  private navigate: NavigateFn | null;
  private logger: ScopedLogger;
  private nowProvider: () => number;

  constructor(options: NotificationServiceOptions = {}) {
    this.storage = options.storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    this.navigate = options.navigate ?? ((path: string) => {
      if (typeof window !== 'undefined' && window?.location) {
        window.location.href = path;
      }
    });
    this.logger = options.logger ?? createScopedLogger('NotificationService');
    this.nowProvider = options.now ?? (() => Date.now());
    this.loadConfig();
    this.loadRules();
  }

  private loadConfig() {
    // Load budget alert configuration
    this.budgetAlertConfig = {
      warningThreshold: 80,
      dangerThreshold: 100,
      enableMonthlyReset: true,
      enableProjectedOverspend: true,
      enableCategoryComparison: true,
      ...this.readConfig<BudgetAlertConfig>('notificationService_budgetConfig')
    };

    // Load transaction alert configuration
    this.transactionAlertConfig = {
      largeTransactionThreshold: 500,
      unusualSpendingEnabled: true,
      duplicateDetectionEnabled: true,
      merchantAlertEnabled: false,
      foreignTransactionEnabled: true,
      ...this.readConfig<TransactionAlertConfig>('notificationService_transactionConfig')
    };

    // Load goal celebration configuration
    this.goalCelebrationConfig = {
      milestonePercentages: [25, 50, 75, 100],
      enableCompletionCelebration: true,
      enableMilestoneNotifications: true,
      enableProgressReminders: true,
      ...this.readConfig<GoalCelebrationConfig>('notificationService_goalConfig')
    };
  }

  private loadRules() {
    const storedRules = this.loadFromStorage('notificationService_rules');
    if (Array.isArray(storedRules)) {
      this.rules = storedRules.map(rule => ({
        ...rule,
        created: rule.created ? new Date(rule.created) : new Date(this.nowProvider()),
        lastTriggered: rule.lastTriggered ? new Date(rule.lastTriggered) : undefined
      }));
    } else {
      this.rules = this.getDefaultRules();
    }
  }

  private readConfig<T>(key: string): Partial<T> {
    const value = this.loadFromStorage(key);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Partial<T>;
    }
    return {};
  }

  private loadFromStorage<T = Record<string, unknown>>(key: string): T | Record<string, unknown> {
    if (!this.storage) return {};
    try {
      const stored = this.storage.getItem(key);
      if (!stored) return {};
      const parsed = JSON.parse(stored);
      return parsed;
    } catch (error) {
      this.logger.warn(`Failed to load configuration from storage`, { key, error });
      return {};
    }
  }

  private saveToStorage(key: string, data: JsonValue) {
    if (!this.storage) return;
    try {
      this.storage.setItem(key, JSON.stringify(data));
    } catch (error) {
      this.logger.warn('Failed to save configuration to storage', { key, error });
    }
  }

  private getDefaultRules(): NotificationRule[] {
    const timestamp = this.getCurrentDate();
    return [
      {
        id: 'budget-warning',
        name: 'Budget Warning Alert',
        type: 'budget',
        enabled: true,
        conditions: [
          {
            field: 'percentage_spent',
            operator: 'greater_than',
            value: this.budgetAlertConfig.warningThreshold,
            description: `Spent more than ${this.budgetAlertConfig.warningThreshold}% of budget`
          }
        ],
        actions: [
          {
            type: 'show_notification',
            config: {
              title: 'Budget Warning',
              message: 'You\'re approaching your budget limit',
              actionButton: {
                label: 'View Budget',
                action: '/budget'
              }
            }
          }
        ],
        priority: 'medium',
        cooldown: 60, // 1 hour
        created: timestamp
      },
      {
        id: 'budget-exceeded',
        name: 'Budget Exceeded Alert',
        type: 'budget',
        enabled: true,
        conditions: [
          {
            field: 'percentage_spent',
            operator: 'greater_than',
            value: this.budgetAlertConfig.dangerThreshold,
            description: `Exceeded budget limit`
          }
        ],
        actions: [
          {
            type: 'show_notification',
            config: {
              title: 'Budget Exceeded!',
              message: 'You\'ve exceeded your budget for this category',
              actionButton: {
                label: 'Review Spending',
                action: '/budget'
              }
            }
          }
        ],
        priority: 'high',
        cooldown: 30, // 30 minutes
        created: timestamp
      },
      {
        id: 'large-transaction',
        name: 'Large Transaction Alert',
        type: 'transaction',
        enabled: true,
        conditions: [
          {
            field: 'amount',
            operator: 'greater_than',
            value: this.transactionAlertConfig.largeTransactionThreshold,
            description: `Transaction amount exceeds ${formatCurrencyDecimal(this.transactionAlertConfig.largeTransactionThreshold)}`
          }
        ],
        actions: [
          {
            type: 'show_notification',
            config: {
              title: 'Large Transaction Detected',
              message: 'A large transaction was recorded',
              actionButton: {
                // A rule template, with no particular row in hand: the
                // accounts, where the registers are.
                label: 'Review accounts',
                action: '/accounts'
              }
            }
          }
        ],
        priority: 'medium',
        cooldown: 5, // 5 minutes
        created: timestamp
      },
      {
        id: 'goal-milestone',
        name: 'Goal Milestone Celebration',
        type: 'goal',
        enabled: true,
        conditions: [
          {
            field: 'percentage_complete',
            operator: 'percentage_of',
            value: this.goalCelebrationConfig.milestonePercentages,
            description: 'Goal milestone reached'
          }
        ],
        actions: [
          {
            type: 'show_notification',
            config: {
              title: '🎉 Goal Milestone Reached!',
              message: 'Congratulations on your progress!',
              actionButton: {
                label: 'View Goals',
                action: '/goals'
              }
            }
          }
        ],
        priority: 'medium',
        cooldown: 60, // 1 hour
        created: timestamp
      },
      {
        id: 'goal-completed',
        name: 'Goal Completion Celebration',
        type: 'goal',
        enabled: true,
        conditions: [
          {
            field: 'percentage_complete',
            operator: 'greater_than',
            value: 100,
            description: 'Goal completed'
          }
        ],
        actions: [
          {
            type: 'show_notification',
            config: {
              title: '🏆 Goal Completed!',
              message: 'Amazing! You\'ve reached your goal!',
              actionButton: {
                label: 'Celebrate',
                action: '/goals'
              }
            }
          }
        ],
        priority: 'high',
        cooldown: 0, // No cooldown for celebrations
        created: timestamp
      }
    ];
  }

  // Budget Alert Methods
  checkBudgetAlerts(
    budgets: Budget[],
    transactions: Transaction[],
    categories: Category[],
    context: BudgetAlertContext = {}
  ): Notification[] {
    const notifications: Notification[] = [];
    const now = this.getCurrentDate();
    // Expanded and decimalised ONCE for every budget in this pass.
    const prepared = prepareBudgetTransactions(transactions, context.transactionSplits ?? []);

    // Budgets key on a category ID; matching on the NAME never hit, so every
    // budget notification named a raw UUID. Keyed both ways so budgets written
    // before the categoryId column still resolve.
    const categoryByKey = new Map<string, Category>();
    categories.forEach(category => {
      if (category?.id) categoryByKey.set(category.id, category);
      if (category?.name && !categoryByKey.has(category.name)) categoryByKey.set(category.name, category);
    });

    budgets.forEach(budget => {
      // The Budget page's calculation, not a second one: the budget's OWN
      // period window, split lines expanded, refunds netted, Decimal throughout.
      const amount = getEffectiveBudgetAmount(budget);
      const { spent: spentDecimal, excludedForeignCount, window } = calculateBudgetSpend(budget, prepared, {
        now,
        foreignAccountIds: context.foreignAccountIds
      });
      // A budget past its end date, or not yet started, is nothing to be
      // warned about: the finished one's figure is history and the future
      // one's is nothing. The Budget page's own alert pass makes the same cut.
      if (window.ended || window.notStarted) return;
      const spent = spentDecimal.toNumber();
      const percentage = calculateBudgetPercentage({ amount }, spentDecimal);

      // Check budget rules
      const applicableRules = this.rules.filter(rule => 
        rule.type === 'budget' && 
        rule.enabled &&
        this.shouldTriggerRule(rule, now)
      );

      applicableRules.forEach(rule => {
        if (this.evaluateConditions(rule.conditions, {
          percentage_spent: percentage,
          amount_spent: spent,
          budget_amount: amount.toNumber(),
          category: budget.categoryId,
          period: budget.period
        })) {
          const category = categoryByKey.get(budget.categoryId);
          const notification = this.createNotificationFromRule(rule, {
            categoryName: category?.name ?? budget.categoryId,
            categoryColor: category?.color || '#6B7280',
            percentage: Math.round(percentage),
            spent,
            // The limit the Budget card shows: the plan plus any carry.
            budget: amount.toNumber(),
            period: budget.period
          });

          if (notification) {
            // A silent exclusion fails like a silent conversion (the
            // disclosure ruling, 22 Aug §4): the exclusion was already
            // correct — the Budget card's own rule — but an alert built on
            // it could not say so, and the reader could not audit what they
            // weren't told. The card's sentence, on the alert it qualifies.
            if (excludedForeignCount > 0) {
              notification.message = `${notification.message} Spending on accounts in another currency is left out, so you have spent more than this.`;
            }
            notifications.push(notification);
            this.updateRuleLastTriggered(rule.id, now);
          }
        }
      });
    });

    return notifications;
  }

  // Transaction Alert Methods
  checkTransactionAlerts(transaction: Transaction, transactions: Transaction[]): Notification[] {
    const notifications: Notification[] = [];
    const now = this.getCurrentDate();

    const applicableRules = this.rules.filter(rule => 
      rule.type === 'transaction' && 
      rule.enabled &&
      this.shouldTriggerRule(rule, now)
    );

    applicableRules.forEach(rule => {
      if (this.evaluateConditions(rule.conditions, {
        amount: transaction.amount,
        description: transaction.description,
        category: transaction.category,
        type: transaction.type,
        date: transaction.date
      })) {
        const notification = this.createNotificationFromRule(rule, {
          amount: transaction.amount,
          description: transaction.description,
          category: transaction.category
        });

        if (notification) {
          notifications.push(notification);
          this.updateRuleLastTriggered(rule.id, now);
        }
      }
    });

    // Check for duplicate transactions
    if (this.transactionAlertConfig.duplicateDetectionEnabled) {
      const duplicateNotification = this.checkDuplicateTransaction(transaction, transactions);
      if (duplicateNotification) {
        notifications.push(duplicateNotification);
      }
    }

    return notifications;
  }

  // Goal Celebration Methods
  checkGoalProgress(goals: Goal[], previousGoals?: Goal[]): Notification[] {
    const notifications: Notification[] = [];
    const _now = this.getCurrentDate();

    goals.forEach(goal => {
      const currentProgress = this.calculateGoalProgress(goal);
      const previousGoal = previousGoals?.find(g => g.id === goal.id);
      const previousProgress = previousGoal ? this.calculateGoalProgress(previousGoal) : 0;

      // Check for milestone achievements
      if (this.goalCelebrationConfig.enableMilestoneNotifications) {
        const milestoneNotification = this.checkGoalMilestone(goal, currentProgress, previousProgress);
        if (milestoneNotification) {
          notifications.push(milestoneNotification);
        }
      }

      // Check for goal completion
      if (this.goalCelebrationConfig.enableCompletionCelebration && currentProgress >= 100 && previousProgress < 100) {
        const completionNotification = this.createGoalCompletionNotification(goal);
        if (completionNotification) {
          notifications.push(completionNotification);
        }
      }
    });

    return notifications;
  }

  private checkGoalMilestone(goal: Goal, currentProgress: number, previousProgress: number): Notification | null {
    const milestones = this.goalCelebrationConfig.milestonePercentages;
    
    for (const milestone of milestones) {
      if (currentProgress >= milestone && previousProgress < milestone && milestone < 100) {
        return {
          id: `goal-milestone-${goal.id}-${milestone}`,
          type: 'success',
          title: `🎯 ${milestone}% Goal Progress!`,
          message: `You're ${milestone}% of the way to "${goal.name}"! Keep it up!`,
          timestamp: this.getCurrentDate(),
          read: false,
          action: {
            label: 'View Goal',
            onClick: () => {
              this.navigate?.('/goals');
            }
          }
        };
      }
    }

    return null;
  }

  private createGoalCompletionNotification(goal: Goal): Notification {
    return {
      id: `goal-completed-${goal.id}`,
      type: 'success',
      title: '🏆 Goal Achieved!',
      message: `Congratulations! You've completed "${goal.name}"! Time to celebrate! 🎉`,
      timestamp: this.getCurrentDate(),
      read: false,
      action: {
        label: 'View Achievement',
        onClick: () => {
          this.navigate?.('/goals');
        }
      }
    };
  }

  private checkDuplicateTransaction(transaction: Transaction, existingTransactions: Transaction[]): Notification | null {
    const potentialDuplicates = existingTransactions.filter(t => 
      t.id !== transaction.id &&
      Math.abs(t.amount - transaction.amount) < 0.01 &&
      t.description === transaction.description &&
      Math.abs(new Date(t.date).getTime() - new Date(transaction.date).getTime()) < 24 * 60 * 60 * 1000 // Within 24 hours
    );

    if (potentialDuplicates.length > 0) {
      return {
        id: `duplicate-transaction-${transaction.id}`,
        type: 'warning',
        title: 'Possible Duplicate Transaction',
        // Through the house formatter, not `£${raw}`: the raw number printed a
        // minus INSIDE punctuation parentheses — "(£-31.15)" — colliding with
        // the accounting convention where parentheses ARE the sign.
        message: `Similar transaction detected: ${transaction.description} at ${formatCurrencyDecimal(transaction.amount)}`,
        timestamp: new Date(),
        read: false,
        action: {
          // Onto the suspected row itself, in its own account's register —
          // which is both where the duplicate can be judged (its neighbours
          // are right there) and where it can be deleted. "Review
          // Transactions" used to open the whole global list with nothing
          // pointed at, which on a real history is not an answer. A row with
          // no account is the only thing that cannot be pointed at.
          label: 'Review transaction',
          onClick: () => {
            this.navigate?.(
              transaction.accountId
                ? buildTransactionRegisterPath(transaction.accountId, transaction.id, '')
                : '/accounts'
            );
          }
        }
      };
    }

    return null;
  }

  private calculateGoalProgress(goal: Goal): number {
    if (goal.targetAmount <= 0) return 0;
    return Math.min((goal.currentAmount / goal.targetAmount) * 100, 100);
  }

  private shouldTriggerRule(rule: NotificationRule, now: Date): boolean {
    if (!rule.cooldown || !rule.lastTriggered) return true;
    
    const timeSinceLastTrigger = now.getTime() - rule.lastTriggered.getTime();
    const cooldownMs = rule.cooldown * 60 * 1000; // Convert minutes to milliseconds
    
    return timeSinceLastTrigger >= cooldownMs;
  }

  private evaluateConditions(conditions: NotificationCondition[], data: UnknownObject): boolean {
    return conditions.every(condition => {
      const value = data[condition.field];
      
      switch (condition.operator) {
        case 'equals':
          return value === condition.value;
        case 'greater_than':
          return typeof value === 'number' && typeof condition.value === 'number' && value > condition.value;
        case 'less_than':
          return typeof value === 'number' && typeof condition.value === 'number' && value < condition.value;
        case 'contains':
          return String(value).toLowerCase().includes(String(condition.value).toLowerCase());
        case 'percentage_of':
          if (Array.isArray(condition.value) && typeof value === 'number') {
            return condition.value.some(threshold => typeof threshold === 'number' && Math.abs(value - threshold) < 1);
          }
          return typeof value === 'number' && typeof condition.value === 'number' && Math.abs(value - condition.value) < 1;
        default:
          return false;
      }
    });
  }

  private createNotificationFromRule(rule: NotificationRule, context: UnknownObject): Notification | null {
    const action = rule.actions.find(a => a.type === 'show_notification');
    if (!action) return null;

    const title = this.interpolateString(action.config.title, context);
    const message = this.interpolateString(action.config.message, context);

    return {
      id: `rule-${rule.id}-${this.nowProvider()}`,
      type: this.mapPriorityToType(rule.priority),
      title,
      message,
      timestamp: this.getCurrentDate(),
      read: false,
      action: action.config.actionButton ? {
        label: action.config.actionButton.label,
        onClick: () => {
          if (action.config.actionButton) {
            this.navigate?.(action.config.actionButton.action);
          }
        }
      } : undefined
    };
  }

  private interpolateString(template: string, context: UnknownObject): string {
    return template.replace(/\{(\w+)\}/g, (match, key) => {
      const value = context[key];
      if (typeof value === 'number' && key.includes('amount')) {
        return formatCurrencyDecimal(value, 'GBP');
      }
      return String(value || match);
    });
  }

  private mapPriorityToType(priority: string): 'info' | 'success' | 'warning' | 'error' {
    switch (priority) {
      case 'urgent': return 'error';
      case 'high': return 'error';
      case 'medium': return 'warning';
      case 'low': return 'info';
      default: return 'info';
    }
  }

  private updateRuleLastTriggered(ruleId: string, timestamp: Date) {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) {
      rule.lastTriggered = timestamp;
      this.saveRules();
    }
  }

  private saveRules() {
    this.saveToStorage('notificationService_rules', JSON.parse(JSON.stringify(this.rules)));
  }

  // Configuration Methods
  updateBudgetConfig(config: Partial<BudgetAlertConfig>) {
    this.budgetAlertConfig = { ...this.budgetAlertConfig, ...config };
    this.saveToStorage('notificationService_budgetConfig', JSON.parse(JSON.stringify(this.budgetAlertConfig)));
  }

  updateTransactionConfig(config: Partial<TransactionAlertConfig>) {
    this.transactionAlertConfig = { ...this.transactionAlertConfig, ...config };
    this.saveToStorage('notificationService_transactionConfig', JSON.parse(JSON.stringify(this.transactionAlertConfig)));
  }

  updateGoalConfig(config: Partial<GoalCelebrationConfig>) {
    this.goalCelebrationConfig = { ...this.goalCelebrationConfig, ...config };
    this.saveToStorage('notificationService_goalConfig', JSON.parse(JSON.stringify(this.goalCelebrationConfig)));
  }

  // Rule Management
  getRules(): NotificationRule[] {
    return [...this.rules];
  }

  private getCurrentDate(): Date {
    return new Date(this.nowProvider());
  }

  addRule(rule: Omit<NotificationRule, 'id' | 'created'>): NotificationRule {
    const newRule: NotificationRule = {
      ...rule,
      id: `rule-${this.nowProvider()}`,
      created: this.getCurrentDate()
    };
    
    this.rules.push(newRule);
    this.saveRules();
    return newRule;
  }

  updateRule(ruleId: string, updates: Partial<NotificationRule>): boolean {
    const ruleIndex = this.rules.findIndex(r => r.id === ruleId);
    if (ruleIndex === -1) return false;

    this.rules[ruleIndex] = { ...this.rules[ruleIndex], ...updates };
    this.saveRules();
    return true;
  }

  deleteRule(ruleId: string): boolean {
    const ruleIndex = this.rules.findIndex(r => r.id === ruleId);
    if (ruleIndex === -1) return false;

    this.rules.splice(ruleIndex, 1);
    this.saveRules();
    return true;
  }

  // Getters for configurations
  getBudgetConfig(): BudgetAlertConfig {
    return { ...this.budgetAlertConfig };
  }

  getTransactionConfig(): TransactionAlertConfig {
    return { ...this.transactionAlertConfig };
  }

  getGoalConfig(): GoalCelebrationConfig {
    return { ...this.goalCelebrationConfig };
  }
}

export const notificationService = new NotificationService();
