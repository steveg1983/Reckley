import {
  USER, EVERYDAY, RAINY_DAY, CORNER_SHOP, OUTGOINGS, WEEKLY_SHOP,
  LEG_LINE, PLAIN_LINE, TO_FROM_EVERYDAY, TO_FROM_RAINY_DAY,
  FOOD_BUDGET, FUEL_BUDGET, HOLIDAY_GOAL, ROOF_GOAL, OPENED_SECOND,
  setups, namedTransferCategories, pinnedReadTimes, twoBudgets, twoGoals,
  plainSplitParent, pinnedLedgerTimes,
  listedAccount, listedCategory, listedTransaction, listedSplit, listedBudget, listedGoal,
  balanceIdentityHolds, splitSumHolds, auditRowsInTotal,
} from './_shared.mjs';

const TRANSFER_ROOT = 'c0000000-0000-0000-0000-000000000001';

export default {
  invariant: 'BOOT-2',
  title: 'every one of the six things the app boots with comes back from one call',
  design: 'BootSnapshot { accounts, categories, transactions, splits, budgets, goals } — the six awaits the boot effect used to make, moved behind the seam so the rules between them are the implementation\'s rather than one call site\'s. The cloud answers it with six crossings in that order; a file answers it from one transaction, which is the BOOT_COMPOSITION table\'s local-core row',
  consequence: 'an engine that answered a partial snapshot would leave the app deciding which of its own pages to open empty, and it would do it silently — no page reports "my list was not in the boot", it just draws nothing. Every list here is a page: the accounts sidebar, the register\'s category column, the register, split-aware reporting, the budgets page and the goals page',
  parity: 'match',

  // Everything at once, and the ORDER of these fragments is load-bearing on
  // both engines: renaming a category and re-shaping a transaction both stamp
  // `updated_at`, so the two pinning fragments come after the things they pin.
  setup: setups(
    namedTransferCategories,
    pinnedReadTimes,
    twoBudgets,
    twoGoals,
    plainSplitParent,
    pinnedLedgerTimes,
  ),
  command: { verb: 'load_boot', payload: { user_id: USER } },
  expect: { outcome: 'ok' },
  result: {
    // Oldest first, and the whole row — the boot's account list is the one the
    // sidebar and every picker are built from.
    accounts: [
      listedAccount({ id: EVERYDAY, name: 'Everyday', type: 'checking', balance: '-25.00' }),
      listedAccount({
        id: RAINY_DAY, name: 'Rainy day', type: 'savings', balance: '0.00',
        created_at: OPENED_SECOND, updated_at: OPENED_SECOND,
      }),
    ],
    // By level then name, which is alphabetical rather than hierarchical, and
    // with the two To/From categories C-3's trigger minted.
    categories: [
      listedCategory({
        id: TO_FROM_EVERYDAY, name: 'To/From Everyday', type: 'both',
        parent_id: TRANSFER_ROOT, account_id: EVERYDAY, is_transfer_category: true,
      }),
      listedCategory({
        id: TO_FROM_RAINY_DAY, name: 'To/From Rainy day', type: 'both',
        parent_id: TRANSFER_ROOT, account_id: RAINY_DAY, is_transfer_category: true,
      }),
      listedCategory({ id: WEEKLY_SHOP, name: 'Weekly shop', level: 'sub', parent_id: OUTGOINGS }),
      listedCategory({ id: OUTGOINGS, name: 'Outgoings', level: 'type' }),
      listedCategory({ id: TRANSFER_ROOT, name: 'Transfer', type: 'both', level: 'type' }),
    ],
    // The ledger, whole. A split parent's own category is blank BY DESIGN, and
    // blank means the empty string rather than NULL on both engines.
    transactions: [
      listedTransaction({ is_split: true, category: '', category_confirmed: false }),
    ],
    // Its lines, in display order — the answer split-aware reporting aggregates
    // by category, and the reason the boot carries them at all.
    transaction_splits: [
      listedSplit({ id: LEG_LINE, transaction_id: CORNER_SHOP, amount: '-15.00', sort_order: 0 }),
      listedSplit({ id: PLAIN_LINE, transaction_id: CORNER_SHOP, amount: '-10.00', sort_order: 1 }),
    ],
    // The planning pair, which the cloud fetches in ONE Promise.all and a file
    // reads in the same transaction as everything else. Contract rule 80 is the
    // same fact from the app's side.
    budgets: [
      listedBudget({
        id: FOOD_BUDGET, name: 'Food', amount: '123.45', category: WEEKLY_SHOP,
        end_date: '2024-12-31', spent: '67.89', rollover_mode: 'surplus',
        alert_threshold: '42.50', notes: 'the food one',
      }),
      listedBudget({
        id: FUEL_BUDGET, name: 'Fuel', amount: '50.00', period: 'weekly',
        start_date: '2024-02-01', is_active: false,
        created_at: OPENED_SECOND, updated_at: OPENED_SECOND,
      }),
    ],
    goals: [
      listedGoal({
        id: HOLIDAY_GOAL, name: 'Holiday', description: 'somewhere warm',
        target_amount: '2500.00', current_amount: '123.45', target_date: '2025-06-01',
        category: WEEKLY_SHOP, priority: 'high', account_id: RAINY_DAY,
        contribution_frequency: 'monthly', auto_contribute: true, icon: 'sun', color: '#ffcc00',
        metadata: { type: 'savings' },
      }),
      listedGoal({
        id: ROOF_GOAL, name: 'New roof', target_amount: '5000.00', current_amount: '5000.00',
        status: 'completed', completed_at: '2024-03-04T05:06:07.000Z',
        created_at: OPENED_SECOND, updated_at: OPENED_SECOND,
      }),
    ],
  },
  state: [
    // A read moves nothing and records nothing, however many tables it touches.
    balanceIdentityHolds(EVERYDAY),
    balanceIdentityHolds(RAINY_DAY),
    splitSumHolds(CORNER_SHOP),
    auditRowsInTotal('0'),
  ],
};
