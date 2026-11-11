import { describe, it, expect, vi, afterEach } from 'vitest';
import { preferences } from '../preferencesService';
import { NotificationService, type NotificationRule } from '../notificationService';
import type { Budget, Category, Transaction } from '../../types';

const createStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    })
  };
};

const fixedNow = Date.UTC(2025, 0, 1);

const createService = (overrides: {
  storage?: ReturnType<typeof createStorage>;
  navigate?: ReturnType<typeof vi.fn>;
} = {}) => {
  const storage = overrides.storage ?? createStorage();
  const navigate = overrides.navigate ?? vi.fn();
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = new NotificationService({
    storage,
    navigate,
    logger,
    now: () => fixedNow
  });
  return { service, storage, navigate, logger };
};

describe('NotificationService (deterministic)', () => {
  it('loads configs from injected storage', () => {
    const storage = createStorage();
    storage.setItem('notificationService_budgetConfig', JSON.stringify({ warningThreshold: 90 }));

    const { service } = createService({ storage });
    expect(service.getRules()).toBeDefined();
    expect(storage.getItem).toHaveBeenCalledWith('notificationService_budgetConfig');
  });

  it('persists config through injected storage', () => {
    const storage = createStorage();
    const { service } = createService({ storage });

    service['saveToStorage']('notificationService_goalConfig', { enableProgressReminders: false } as any);

    expect(storage.setItem).toHaveBeenCalledWith(
      'notificationService_goalConfig',
      JSON.stringify({ enableProgressReminders: false })
    );
  });

  it('converts persisted rule timestamps to Date objects', () => {
    const storage = createStorage();
    storage.setItem('notificationService_rules', JSON.stringify([
      {
        id: 'stored',
        name: 'Stored Rule',
        type: 'budget',
        enabled: true,
        conditions: [],
        actions: [],
        priority: 'low',
        cooldown: 0,
        created: '2024-01-01T00:00:00.000Z',
        lastTriggered: '2024-01-02T00:00:00.000Z'
      }
    ] satisfies Partial<NotificationRule>[]));

    const { service } = createService({ storage });
    const rule = service.getRules()[0];
    expect(rule.created).toBeInstanceOf(Date);
    expect(rule.lastTriggered).toBeInstanceOf(Date);
  });

  it('uses injected navigate handler for rule action buttons', () => {
    const navigate = vi.fn();
    const { service } = createService({ navigate });

    const rule: NotificationRule = {
      id: 'rule-test',
      name: 'Test',
      type: 'budget',
      enabled: true,
      conditions: [],
      actions: [
        {
          type: 'show_notification',
          config: {
            title: 'Check',
            message: 'Please review',
            actionButton: { label: 'Go', action: '/budget' }
          }
        }
      ],
      priority: 'low',
      cooldown: 0,
      created: new Date()
    };

    const notification = (service as any).createNotificationFromRule(rule, {});
    expect(notification?.timestamp.getTime()).toBe(fixedNow);
    notification?.action?.onClick?.();
    expect(navigate).toHaveBeenCalledWith('/budget');
  });

  it('generates deterministic ids and timestamps via injected clock when adding rules', () => {
    const { service } = createService();
    const newRule = service.addRule({
      name: 'Custom',
      type: 'budget',
      enabled: true,
      conditions: [],
      actions: [],
      priority: 'low',
      cooldown: 0
    });

    expect(newRule.id).toBe(`rule-${fixedNow}`);
    expect(newRule.created.getTime()).toBe(fixedNow);
  });
});

/**
 * A silent exclusion fails like a silent conversion (the disclosure ruling,
 * 22 Aug §4): the budget maths correctly leaves out accounts in another
 * currency, and the alert built on it must SAY so — the Budget card's own
 * sentence, on the alert it qualifies.
 * Every figure here is invented; the repo is public.
 */
describe('budget alerts say what they leave out', () => {
  const rule: NotificationRule = {
    id: 'r-90',
    name: 'Half spent',
    type: 'budget',
    enabled: true,
    priority: 'high',
    conditions: [{ field: 'percentage_spent', operator: 'greater_than', value: 50 }],
    actions: [{
      type: 'show_notification',
      config: { title: 'Budget alert', message: '{categoryName} is at {percentage}%.' }
    }]
  };

  const categories: Category[] = [
    { id: 'cat-food', name: 'Food', type: 'expense', level: 'detail' }
  ];
  const budgets: Budget[] = [
    { id: 'b1', categoryId: 'cat-food', amount: 100, period: 'monthly', isActive: true, createdAt: new Date(fixedNow) }
  ];
  const spend = (accountId: string, id: string): Transaction[] => ([
    { id, accountId, amount: -80, category: 'cat-food', date: new Date(fixedNow), type: 'expense', description: 'shop' }
  ]);

  it('appends the exclusion sentence when foreign-account rows were left out', () => {
    const { service } = createService();
    service.addRule(rule);
    const alerts = service.checkBudgetAlerts(budgets, spend('acc-gbp', 't-gbp'), categories, {
      foreignAccountIds: new Set(['acc-usd']),
      // A row on the excluded account, in the same window and category —
      // what the total leaves out and the sentence must own up to.
      transactionSplits: [],
    });
    // The GBP-only pass has nothing excluded: no caveat.
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].message).not.toMatch(/another currency/);

    const withForeign = service.checkBudgetAlerts(
      budgets,
      [...spend('acc-gbp', 't-gbp'), ...spend('acc-usd', 't-usd')],
      categories,
      { foreignAccountIds: new Set(['acc-usd']), transactionSplits: [] }
    );
    expect(withForeign.length).toBeGreaterThan(0);
    expect(withForeign[0].message).toMatch(
      /Spending on accounts in another currency is left out, so you have spent more than this\./
    );
  });

  it('raises nothing for a budget past its end date, however far over its last period ran', () => {
    // Start = creation day and created before the cycle model: a legacy row
    // on calendar months, finished at the end of June 2024. Its last month
    // was 80% spent — over the rule's line — and is history (now is 2025).
    const { service } = createService();
    service.addRule(rule);
    const finished: Budget[] = [
      {
        id: 'b-done', categoryId: 'cat-food', amount: 100, period: 'monthly', isActive: true,
        startDate: '2024-01-01', endDate: '2024-06-30', createdAt: new Date(Date.UTC(2024, 0, 1))
      }
    ];
    const inItsLastMonth: Transaction[] = [
      { id: 't-june', accountId: 'acc-gbp', amount: -80, category: 'cat-food', date: new Date(Date.UTC(2024, 5, 15)), type: 'expense', description: 'shop' }
    ];

    expect(service.checkBudgetAlerts(finished, inItsLastMonth, categories, { transactionSplits: [] })).toEqual([]);
  });
});

/**
 * THE ALERTS FOLLOW THE READING (owner, 11 Nov 2026). A yearly budget read
 * "so far" is measured against the months begun, so a rule on the percentage
 * spent fires on the figure the Budget card shows — in the first month of the
 * year, not the eleventh. Every figure is invented.
 */
describe('a budget alert measures a long budget as the person reads it', () => {
  const rule: NotificationRule = {
    id: 'r-half',
    name: 'Half spent',
    type: 'budget',
    enabled: true,
    priority: 'high',
    conditions: [{ field: 'percentage_spent', operator: 'greater_than', value: 50 }],
    actions: [{
      type: 'show_notification',
      config: { title: 'Budget alert', message: '{categoryName} is at {percentage}% of {budget}.' }
    }]
  };
  const categories: Category[] = [{ id: 'cat-food', name: 'Food', type: 'expense', level: 'detail' }];
  // A year from 1 January 2025, written after the cycle model shipped so the
  // start is its anchor; "now" is its first day — month one of twelve.
  const yearly: Budget[] = [{
    id: 'b-year', categoryId: 'cat-food', amount: 1200, period: 'yearly', isActive: true,
    startDate: '2025-01-01', createdAt: new Date(2026, 10, 7)
  } as Budget];
  const spent80: Transaction[] = [
    { id: 't-1', accountId: 'acc-gbp', amount: -80, category: 'cat-food', date: new Date(fixedNow), type: 'expense', description: 'shop' } as Transaction
  ];

  afterEach(() => {
    preferences.removeItem('budgetView');
  });

  it('so far, by default: 80 of the first month\u2019s 100 is over a 50% line', () => {
    const { service } = createService();
    service.addRule(rule);
    const alerts = service.checkBudgetAlerts(yearly, spent80, categories, { transactionSplits: [] });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toMatch(/Food is at 80% of/);
    expect(alerts[0].message).not.toMatch(/1,?200/);
  });

  it('the whole period, when that is the choice: 80 of 1,200 is nowhere near it', () => {
    preferences.setItem('budgetView', 'period');
    const { service } = createService();
    service.addRule(rule);
    expect(service.checkBudgetAlerts(yearly, spent80, categories, { transactionSplits: [] })).toEqual([]);
  });
});
