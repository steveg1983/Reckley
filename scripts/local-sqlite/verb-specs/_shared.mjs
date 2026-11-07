// Ids from fixtures/base.*.sql, and the assertions every verb spec repeats.
//
// All data is invented. This repo is public: no real payee, account number or
// figure appears anywhere in it.

import {
  accountBalance,
  balanceIdentity,
  minorToDecimal,
  numericToDecimal,
  scaledNumericToDecimal,
  scaledToDecimal,
} from '../lib/money-sql.mjs';

export const USER = '11111111-1111-1111-1111-111111111111';
export const EVERYDAY = 'a0000000-0000-0000-0000-000000000001';
export const RAINY_DAY = 'a0000000-0000-0000-0000-000000000002';
export const WEEKLY_SHOP = 'c0000000-0000-0000-0000-000000000003';
export const OUTGOINGS = 'c0000000-0000-0000-0000-000000000002';

/** The Everyday account starts at -25.00 with one -25.00 row against it. */
export const OPENING_BALANCE = '-25.00';

/** That row: 'Corner shop', -25.00, filed under Weekly shop. */
export const CORNER_SHOP = '70000000-0000-0000-0000-000000000001';

/** A second login, and an account this one does not own. */
export const STRANGER = '22222222-2222-2222-2222-222222222222';
export const SOMEONE_ELSES_ACCOUNT = 'a0000000-0000-0000-0000-000000000009';

export const secondUser = {
  sqlite: `
    INSERT INTO users (id, email) VALUES ('${STRANGER}', 'stranger@example.test');
    INSERT INTO accounts (id, user_id, name, type, balance_minor, initial_balance_minor)
      VALUES ('${SOMEONE_ELSES_ACCOUNT}', '${STRANGER}', 'Not yours', 'checking', 0, 0);`,
  postgres: `
    INSERT INTO public.users (id, clerk_id, email)
      VALUES ('${STRANGER}', 'clerk_local_sqlite_stranger', 'stranger@example.test');
    INSERT INTO public.accounts (id, user_id, name, type, balance, initial_balance)
      VALUES ('${SOMEONE_ELSES_ACCOUNT}', '${STRANGER}', 'Not yours', 'checking', 0.00, 0.00);`,
};

/**
 * The Corner shop row with every nullable field FILLED IN.
 *
 * The whole point of the update verb's sentinel table is telling "cleared to
 * NULL" from "left alone", and on the bare fixture those two are the same
 * observation — every one of those columns starts NULL. Nothing here moves an
 * amount, so B-1 still holds on both accounts.
 */
export const enriched = {
  sqlite: `
    UPDATE transactions SET
      category_id = '${WEEKLY_SHOP}',
      notes = 'a note',
      merchant_name = 'a merchant',
      transfer_account_id = '${RAINY_DAY}',
      is_cleared = 1,
      is_recurring = 1,
      category_confirmed = 0,
      metadata = '{"k":1}'
     WHERE id = '${CORNER_SHOP}';
    INSERT INTO transaction_tags (transaction_id, tag) VALUES
      ('${CORNER_SHOP}', 'one'), ('${CORNER_SHOP}', 'two');`,
  postgres: `
    UPDATE public.transactions SET
      category_id = '${WEEKLY_SHOP}'::uuid,
      notes = 'a note',
      merchant_name = 'a merchant',
      transfer_account_id = '${RAINY_DAY}'::uuid,
      is_cleared = true,
      is_recurring = true,
      category_confirmed = false,
      metadata = '{"k":1}'::jsonb,
      tags = ARRAY['one','two']
     WHERE id = '${CORNER_SHOP}';`,
};

/** A second transfer row in the Everyday account, so a transfer pair exists. */
export const OTHER_LEG = '70000000-0000-0000-0000-000000000004';
export const THIS_LEG = '70000000-0000-0000-0000-000000000005';

/**
 * A linked transfer pair: -15.00 out of Everyday, +15.00 into Rainy day,
 * mutually linked, with BOTH balances moved so B-1 keeps holding.
 *
 * Everyday ends at -40.00 and Rainy day at 15.00.
 */
export const transferPair = {
  sqlite: `
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              transfer_account_id) VALUES
      ('${OTHER_LEG}', '${USER}', '${EVERYDAY}',  'To savings',    -1500, 'transfer', '2024-04-01', '${RAINY_DAY}'),
      ('${THIS_LEG}',  '${USER}', '${RAINY_DAY}', 'From everyday',  1500, 'transfer', '2024-04-01', '${EVERYDAY}');
    UPDATE transactions SET linked_transfer_id = '${THIS_LEG}'  WHERE id = '${OTHER_LEG}';
    UPDATE transactions SET linked_transfer_id = '${OTHER_LEG}' WHERE id = '${THIS_LEG}';
    UPDATE accounts SET balance_minor = balance_minor - 1500 WHERE id = '${EVERYDAY}';
    UPDATE accounts SET balance_minor = balance_minor + 1500 WHERE id = '${RAINY_DAY}';`,
  postgres: `
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date,
                                     transfer_account_id) VALUES
      ('${OTHER_LEG}', '${USER}', '${EVERYDAY}',  'To savings',    -15.00, 'transfer', '2024-04-01', '${RAINY_DAY}'),
      ('${THIS_LEG}',  '${USER}', '${RAINY_DAY}', 'From everyday',  15.00, 'transfer', '2024-04-01', '${EVERYDAY}');
    UPDATE public.transactions SET linked_transfer_id = '${THIS_LEG}'  WHERE id = '${OTHER_LEG}';
    UPDATE public.transactions SET linked_transfer_id = '${OTHER_LEG}' WHERE id = '${THIS_LEG}';
    UPDATE public.accounts SET balance = balance - 15.00 WHERE id = '${EVERYDAY}';
    UPDATE public.accounts SET balance = balance + 15.00 WHERE id = '${RAINY_DAY}';`,
};

/** The split parent, its two lines, and the transfer counterpart one line links to. */
export const LEG_COUNTERPART = '70000000-0000-0000-0000-000000000009';
export const LEG_LINE = '50000000-0000-0000-0000-000000000001';
export const PLAIN_LINE = '50000000-0000-0000-0000-000000000002';

/**
 * The R-5 shape: Corner shop becomes a split of -15.00 (a transfer leg) and
 * -10.00, and the leg points at a +15.00 counterpart in Rainy day.
 *
 * Adapted from `specs/_setups.mjs`'s fragment of the same name, with ONE
 * addition: the counterpart's balance effect is applied, because every verb spec
 * asserts B-1 and that fragment was written for a harness that does not.
 * Everyday stays at -25.00 (the split lines sum to the parent) and Rainy day
 * ends at 15.00.
 */
export const splitWithTransferLeg = {
  sqlite: `
    INSERT INTO _rpc_guard VALUES ('split');
    UPDATE transactions SET is_split = 1, category = '' WHERE id = '${CORNER_SHOP}';
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              transfer_account_id)
    VALUES ('${LEG_COUNTERPART}', '${USER}', '${RAINY_DAY}', 'Counterpart', 1500, 'transfer',
            '2024-03-01', '${EVERYDAY}');
    UPDATE accounts SET balance_minor = balance_minor + 1500 WHERE id = '${RAINY_DAY}';
    -- The To/From category is minted by a trigger on BOTH engines, so its id is
    -- unknown at authoring time on both: reach it through the account.
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order,
                                    transfer_account_id, linked_transfer_id) VALUES
      ('${LEG_LINE}', '${CORNER_SHOP}', '${USER}',
       (SELECT id FROM categories WHERE account_id = '${RAINY_DAY}' AND is_transfer_category = 1),
       -1500, 0, '${RAINY_DAY}', '${LEG_COUNTERPART}');
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order)
      VALUES ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -1000, 1);
    UPDATE transactions SET linked_transfer_split_id = '${LEG_LINE}' WHERE id = '${LEG_COUNTERPART}';
    DELETE FROM _rpc_guard;`,
  postgres: `
    SELECT set_config('app.split_rpc', '1', true);
    UPDATE public.transactions SET is_split = true, category = '' WHERE id = '${CORNER_SHOP}';
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date,
                                     transfer_account_id)
    VALUES ('${LEG_COUNTERPART}', '${USER}', '${RAINY_DAY}', 'Counterpart', 15.00, 'transfer',
            '2024-03-01', '${EVERYDAY}');
    UPDATE public.accounts SET balance = balance + 15.00 WHERE id = '${RAINY_DAY}';
    INSERT INTO public.transaction_splits (id, transaction_id, user_id, category, amount, sort_order,
                                           transfer_account_id, linked_transfer_id) VALUES
      ('${LEG_LINE}', '${CORNER_SHOP}', '${USER}',
       (SELECT id::text FROM public.categories WHERE account_id = '${RAINY_DAY}' AND is_transfer_category),
       -15.00, 0, '${RAINY_DAY}', '${LEG_COUNTERPART}');
    INSERT INTO public.transaction_splits (id, transaction_id, user_id, category, amount, sort_order)
      VALUES ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -10.00, 1);
    UPDATE public.transactions SET linked_transfer_split_id = '${LEG_LINE}' WHERE id = '${LEG_COUNTERPART}';
    SELECT set_config('app.split_rpc', '0', true);`,
};

/**
 * The same shape, but with the leg filed under an ORDINARY category.
 *
 * This is the MS Money importer's population — 86 of the owner's 364 split lines
 * — and it is not a variation for its own sake: while a leg is filed under a
 * To/From category, `split_leg_not_declared` fires before the pinned-leg checks
 * are ever reached, so `split_leg_target_locked` is UNREACHABLE. MEASURED on the
 * reference cluster; this fixture is the only way to prove that refusal exists.
 */
export const splitWithAnOrdinarilyFiledLeg = {
  sqlite: `
    INSERT INTO _rpc_guard VALUES ('split');
    UPDATE transactions SET is_split = 1, category = '' WHERE id = '${CORNER_SHOP}';
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              transfer_account_id)
    VALUES ('${LEG_COUNTERPART}', '${USER}', '${RAINY_DAY}', 'Counterpart', 1500, 'transfer',
            '2024-03-01', '${EVERYDAY}');
    UPDATE accounts SET balance_minor = balance_minor + 1500 WHERE id = '${RAINY_DAY}';
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order,
                                    transfer_account_id, linked_transfer_id)
      VALUES ('${LEG_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}',
              -1500, 0, '${RAINY_DAY}', '${LEG_COUNTERPART}');
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order)
      VALUES ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -1000, 1);
    UPDATE transactions SET linked_transfer_split_id = '${LEG_LINE}' WHERE id = '${LEG_COUNTERPART}';
    DELETE FROM _rpc_guard;`,
  postgres: `
    SELECT set_config('app.split_rpc', '1', true);
    UPDATE public.transactions SET is_split = true, category = '' WHERE id = '${CORNER_SHOP}';
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date,
                                     transfer_account_id)
    VALUES ('${LEG_COUNTERPART}', '${USER}', '${RAINY_DAY}', 'Counterpart', 15.00, 'transfer',
            '2024-03-01', '${EVERYDAY}');
    UPDATE public.accounts SET balance = balance + 15.00 WHERE id = '${RAINY_DAY}';
    INSERT INTO public.transaction_splits (id, transaction_id, user_id, category, amount, sort_order,
                                           transfer_account_id, linked_transfer_id)
      VALUES ('${LEG_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}',
              -15.00, 0, '${RAINY_DAY}', '${LEG_COUNTERPART}');
    INSERT INTO public.transaction_splits (id, transaction_id, user_id, category, amount, sort_order)
      VALUES ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -10.00, 1);
    UPDATE public.transactions SET linked_transfer_split_id = '${LEG_LINE}' WHERE id = '${LEG_COUNTERPART}';
    SELECT set_config('app.split_rpc', '0', true);`,
};

/**
 * An UNLINKED leg: a line carrying a transfer target whose counterpart is gone.
 *
 * The state the R-5 delete leaves behind, and the one the transfer-matching
 * sweep exists to repair. It matters to the split writer because a re-save must
 * NOT invent a second counterpart for money that already moved once.
 */
export const splitWithAnUnlinkedLeg = {
  sqlite: `
    INSERT INTO _rpc_guard VALUES ('split');
    UPDATE transactions SET is_split = 1, category = '' WHERE id = '${CORNER_SHOP}';
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order,
                                    transfer_account_id)
      VALUES ('${LEG_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -1500, 0, '${RAINY_DAY}');
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order)
      VALUES ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -1000, 1);
    DELETE FROM _rpc_guard;`,
  postgres: `
    SELECT set_config('app.split_rpc', '1', true);
    UPDATE public.transactions SET is_split = true, category = '' WHERE id = '${CORNER_SHOP}';
    INSERT INTO public.transaction_splits (id, transaction_id, user_id, category, amount, sort_order,
                                           transfer_account_id)
      VALUES ('${LEG_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -15.00, 0, '${RAINY_DAY}');
    INSERT INTO public.transaction_splits (id, transaction_id, user_id, category, amount, sort_order)
      VALUES ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -10.00, 1);
    SELECT set_config('app.split_rpc', '0', true);`,
};

/**
 * The two To/From categories, given ids a payload can name.
 *
 * The base fixture's own comment says no spec may ASSUME a transfer category's
 * id, because both engines mint them from a trigger with a generated one. That
 * stands. This does the other thing: it renames them, in the setup, to ids the
 * spec then names on purpose — which is the only way to write a payload that
 * files a line under a To/From category, and therefore the only way to reach
 * `split_leg_not_declared` and `split_leg_category_mismatch` at all.
 *
 * Safe on both engines: nothing references a category id at this point in the
 * fixture (no transaction carries `category_id`, and a To/From category has no
 * children), so the rename cascades to nothing.
 */
export const TO_FROM_RAINY_DAY = 'c0000000-0000-0000-0000-0000000000fa';
export const TO_FROM_EVERYDAY = 'c0000000-0000-0000-0000-0000000000fb';

export const namedTransferCategories = {
  sqlite: `
    UPDATE categories SET id = '${TO_FROM_RAINY_DAY}'
     WHERE account_id = '${RAINY_DAY}' AND is_transfer_category = 1;
    UPDATE categories SET id = '${TO_FROM_EVERYDAY}'
     WHERE account_id = '${EVERYDAY}' AND is_transfer_category = 1;`,
  postgres: `
    UPDATE public.categories SET id = '${TO_FROM_RAINY_DAY}'::uuid
     WHERE account_id = '${RAINY_DAY}' AND is_transfer_category;
    UPDATE public.categories SET id = '${TO_FROM_EVERYDAY}'::uuid
     WHERE account_id = '${EVERYDAY}' AND is_transfer_category;`,
};

/** A third account in the same currency, so a leg has somewhere else to point. */
export const HOLIDAY_FUND = 'a0000000-0000-0000-0000-000000000003';

export const thirdAccount = {
  sqlite: `
    INSERT INTO accounts (id, user_id, name, type, balance_minor, initial_balance_minor)
      VALUES ('${HOLIDAY_FUND}', '${USER}', 'Holiday fund', 'savings', 0, 0);`,
  postgres: `
    INSERT INTO public.accounts (id, user_id, name, type, balance, initial_balance)
      VALUES ('${HOLIDAY_FUND}', '${USER}', 'Holiday fund', 'savings', 0.00, 0.00);`,
};

/** An account in another currency, so T-9 has something to refuse. */
export const DOLLARS = 'a0000000-0000-0000-0000-00000000000d';

export const dollarAccount = {
  sqlite: `
    INSERT INTO accounts (id, user_id, name, type, currency, balance_minor, initial_balance_minor)
      VALUES ('${DOLLARS}', '${USER}', 'Dollars', 'checking', 'USD', 0, 0);`,
  postgres: `
    INSERT INTO public.accounts (id, user_id, name, type, currency, balance, initial_balance)
      VALUES ('${DOLLARS}', '${USER}', 'Dollars', 'checking', 'USD', 0.00, 0.00);`,
};

// ── REMOVED 2026-08-08: `rowAgainstAForeignAccount` / `FOREIGN_ROW` ─────────
//
// It planted "the pairing neither schema forbids": a transaction whose user_id
// was this caller and whose account_id belonged to somebody else. Three specs
// used it, because it was the ONLY way to reach a balance statement that
// matches no row — the account foreign key caught every other route:
//
//     b1-a-delete-that-cannot-reach-its-account-refuses-rather-than-losing-the-money
//     split-a-parent-whose-account-is-not-yours-refuses-rather-than-losing-the-money
//     counterpart-a-row-against-a-foreign-account-skips-the-currency-guard
//
// Both schemas forbid it now — the cloud since
// 20260808170000_rows_cannot_name_a_foreign_account.sql, the local file since
// the amendment that discharged its parity obligation — so the fragment cannot
// be planted on either engine and the three specs cannot be built. That is the
// migration working, not the harness breaking, and the three have successors in
// the CONSTRAINT harness, which is where a rule about what a table will hold
// belongs:
//
//     specs/r12-a-row-cannot-be-filed-against-a-strangers-account.spec.mjs
//     specs/r12-a-row-cannot-be-moved-onto-a-strangers-account.spec.mjs
//     specs/r12-a-transfer-cannot-point-at-a-strangers-account.spec.mjs
//
// Each carries its ancestor's name in its header. `SOMEONE_ELSES_ACCOUNT` and
// `secondUser` above stay: an account this login does not own is still a thing
// verbs are handed, and several specs still refuse it.

// ── The transfer family's fixtures ─────────────────────────────────────────

/** Two UNLINKED rows with exactly opposite amounts, in two accounts. */
export const PAIR_OUT = '70000000-0000-0000-0000-00000000000a';
export const PAIR_IN = '70000000-0000-0000-0000-00000000000b';

/**
 * The shape `link_transfer_pair` exists for: both banks imported their own side
 * of one movement and nobody has told the ledger they are the same movement.
 *
 * −30.00 out of Everyday (filed under Weekly shop, so the re-filing is visible)
 * and +30.00 into Rainy day (filed under nothing). Everyday ends at −55.00 and
 * Rainy day at 30.00, so B-1 holds on both before the verb runs.
 */
export const pairableRows = {
  sqlite: `
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date, category) VALUES
      ('${PAIR_OUT}', '${USER}', '${EVERYDAY}',  'Moved out', -3000, 'expense', '2024-04-02', '${WEEKLY_SHOP}'),
      ('${PAIR_IN}',  '${USER}', '${RAINY_DAY}', 'Moved in',   3000, 'income',  '2024-04-02', NULL);
    UPDATE accounts SET balance_minor = balance_minor - 3000 WHERE id = '${EVERYDAY}';
    UPDATE accounts SET balance_minor = balance_minor + 3000 WHERE id = '${RAINY_DAY}';`,
  postgres: `
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date, category) VALUES
      ('${PAIR_OUT}', '${USER}', '${EVERYDAY}',  'Moved out', -30.00, 'expense', '2024-04-02', '${WEEKLY_SHOP}'),
      ('${PAIR_IN}',  '${USER}', '${RAINY_DAY}', 'Moved in',   30.00, 'income',  '2024-04-02', NULL);
    UPDATE public.accounts SET balance = balance - 30.00 WHERE id = '${EVERYDAY}';
    UPDATE public.accounts SET balance = balance + 30.00 WHERE id = '${RAINY_DAY}';`,
};

/**
 * `pairableRows`' cross-currency twin: −30.00 out of Everyday (GBP) against a
 * DIFFERENT magnitude in Dollars (USD).
 *
 * ── WHY THIS EXISTS SEPARATELY ──────────────────────────────────────────────
 *
 * Until 2026-08-12 the only cross-currency fixture in the suite was
 * `pairableRows` with `PAIR_IN` repointed onto Dollars — which left the two
 * sides at ±30.00, i.e. a rate of exactly 1. That pair passes the strict rule
 * and the loosened one alike, so it could never say which was in force, and
 * for a year it certified as "linked" a shape no conversion produces.
 *
 * Every amount here is stated twice, in minor units and as a decimal, rather
 * than divided by 100 in JavaScript. A fixture generator that does float
 * arithmetic on money is the one place in this suite nobody would think to
 * look for a rounding bug.
 *
 * Requires `dollarAccount`. Everyday lands at −55.00, Dollars at the
 * destination amount, so B-1 holds on both before the verb runs.
 *
 * @param {{minor: number, decimal: string}} destination what arrived in Dollars
 */
export const convertedRows = (destination) => ({
  sqlite: `
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date, category) VALUES
      ('${PAIR_OUT}', '${USER}', '${EVERYDAY}', 'Moved out', -3000, 'expense', '2024-04-02', '${WEEKLY_SHOP}'),
      ('${PAIR_IN}',  '${USER}', '${DOLLARS}',  'Moved in',  ${destination.minor}, 'income', '2024-04-02', NULL);
    UPDATE accounts SET balance_minor = balance_minor - 3000 WHERE id = '${EVERYDAY}';
    UPDATE accounts SET balance_minor = balance_minor + ${destination.minor} WHERE id = '${DOLLARS}';`,
  postgres: `
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date, category) VALUES
      ('${PAIR_OUT}', '${USER}', '${EVERYDAY}', 'Moved out', -30.00, 'expense', '2024-04-02', '${WEEKLY_SHOP}'),
      ('${PAIR_IN}',  '${USER}', '${DOLLARS}',  'Moved in',  ${destination.decimal}, 'income', '2024-04-02', NULL);
    UPDATE public.accounts SET balance = balance - 30.00 WHERE id = '${EVERYDAY}';
    UPDATE public.accounts SET balance = balance + ${destination.decimal} WHERE id = '${DOLLARS}';`,
});

/** The user's own 'Account Adjustment' category — a leaf, active, not To/From. */
export const ADJUSTMENT = 'c0000000-0000-0000-0000-0000000000a1';

export const adjustmentCategory = {
  sqlite: `
    INSERT INTO categories (id, user_id, name, type, level, parent_id)
      VALUES ('${ADJUSTMENT}', '${USER}', 'Account Adjustment', 'both', 'sub',
              'c0000000-0000-0000-0000-000000000001');`,
  postgres: `
    INSERT INTO public.categories (id, user_id, name, type, level, parent_id)
      VALUES ('${ADJUSTMENT}', '${USER}', 'Account Adjustment', 'both', 'sub',
              'c0000000-0000-0000-0000-000000000001');`,
};

/** The row that really matches the counterpart, sitting a day away, unfiled. */
export const STRANDED = '70000000-0000-0000-0000-00000000000e';

/**
 * `repair_claimed_transfer`'s whole world, on top of [`transferPair`].
 *
 * The counterpart (+15.00, Rainy day) is linked to the WRONG partner (−15.00,
 * Everyday), and the row it should be linked to is [`STRANDED`] — same account
 * as the wrong partner, same day, exactly opposite, and uncategorised.
 * Everyday ends at −55.00, Rainy day at 15.00.
 */
export const strandedRow = {
  sqlite: `
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date)
      VALUES ('${STRANDED}', '${USER}', '${EVERYDAY}', 'Really the other side', -1500, 'expense', '2024-04-01');
    UPDATE accounts SET balance_minor = balance_minor - 1500 WHERE id = '${EVERYDAY}';`,
  postgres: `
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date)
      VALUES ('${STRANDED}', '${USER}', '${EVERYDAY}', 'Really the other side', -15.00, 'expense', '2024-04-01');
    UPDATE public.accounts SET balance = balance - 15.00 WHERE id = '${EVERYDAY}';`,
};

/** The row in Rainy day that an unmatched split leg is waiting for. */
export const MATCHING = '70000000-0000-0000-0000-00000000000c';

/**
 * +15.00 in Rainy day: the other side of [`splitWithAnUnlinkedLeg`]'s leg,
 * already imported by its own bank and not yet recognised.
 *
 * Everyday stays at −25.00 (the split lines sum to the parent) and Rainy day
 * ends at 15.00.
 */
export const matchingRow = {
  sqlite: `
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date)
      VALUES ('${MATCHING}', '${USER}', '${RAINY_DAY}', 'From everyday', 1500, 'income', '2024-03-02');
    UPDATE accounts SET balance_minor = balance_minor + 1500 WHERE id = '${RAINY_DAY}';`,
  postgres: `
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date)
      VALUES ('${MATCHING}', '${USER}', '${RAINY_DAY}', 'From everyday', 15.00, 'income', '2024-03-02');
    UPDATE public.accounts SET balance = balance + 15.00 WHERE id = '${RAINY_DAY}';`,
};

// ── The category family's fixtures ─────────────────────────────────────────

/**
 * Two ordinary expense leaves under Outgoings: the commonest mess in imported
 * history, and the pair every merge spec starts from.
 *
 * Both are `detail` level with no children, both `expense`, both active, and
 * neither carries any of the three semantic flags — so every one of the
 * seventeen refusals is reached by changing exactly one thing about this pair,
 * which is what makes each spec's setup readable as "and this is the difference".
 */
export const MERGE_SOURCE = 'c0000000-0000-0000-0000-0000000000e1';
export const MERGE_TARGET = 'c0000000-0000-0000-0000-0000000000e2';

export const mergeablePair = {
  sqlite: `
    INSERT INTO categories (id, user_id, name, type, level, parent_id) VALUES
      ('${MERGE_SOURCE}', '${USER}', 'Food shopping', 'expense', 'detail', '${OUTGOINGS}'),
      ('${MERGE_TARGET}', '${USER}', 'Groceries',     'expense', 'detail', '${OUTGOINGS}');`,
  postgres: `
    INSERT INTO public.categories (id, user_id, name, type, level, parent_id) VALUES
      ('${MERGE_SOURCE}', '${USER}', 'Food shopping', 'expense', 'detail', '${OUTGOINGS}'),
      ('${MERGE_TARGET}', '${USER}', 'Groceries',     'expense', 'detail', '${OUTGOINGS}');`,
};

/** A category of the STRANGER's, so the two owner refusals have a subject. */
export const THEIR_CATEGORY = 'c0000000-0000-0000-0000-0000000000d1';

export const strangersCategory = {
  sqlite: `
    INSERT INTO categories (id, user_id, name, type, level)
      VALUES ('${THEIR_CATEGORY}', '${STRANGER}', 'Theirs', 'expense', 'detail');`,
  postgres: `
    INSERT INTO public.categories (id, user_id, name, type, level)
      VALUES ('${THEIR_CATEGORY}', '${STRANGER}', 'Theirs', 'expense', 'detail');`,
};

/** A child under a category, so `has_children` has something to find. */
export function childOf(parentId, id = 'c0000000-0000-0000-0000-0000000000c1') {
  const columns = "(id, user_id, name, type, level, parent_id)";
  const values = `('${id}', '${USER}', 'Underneath ${parentId.slice(-4)}', 'expense', 'detail', '${parentId}')`;
  return {
    sqlite: `INSERT INTO categories ${columns} VALUES ${values};`,
    postgres: `INSERT INTO public.categories ${columns} VALUES ${values};`,
  };
}

/**
 * Corner shop, filed under the merge source through BOTH reference columns.
 *
 * `category` is TEXT with no foreign key and `category_id` is the uuid twin with
 * one; the merge has to move them together, and the delete-and-reassign dialog
 * that preceded it moved the first and silently nulled the second.
 */
export const filedUnderTheSource = {
  sqlite: `
    UPDATE transactions SET category = '${MERGE_SOURCE}', category_id = '${MERGE_SOURCE}'
     WHERE id = '${CORNER_SHOP}';`,
  postgres: `
    UPDATE public.transactions SET category = '${MERGE_SOURCE}', category_id = '${MERGE_SOURCE}'::uuid
     WHERE id = '${CORNER_SHOP}';`,
};

/** A budget measuring the merge source, through both of ITS reference columns. */
export const BUDGET = 'b0000000-0000-0000-0000-000000000001';

export const budgetOnTheSource = {
  sqlite: `
    INSERT INTO budgets (id, user_id, name, amount_minor, period, category, category_id, start_date)
      VALUES ('${BUDGET}', '${USER}', 'Food', 10000, 'monthly',
              '${MERGE_SOURCE}', '${MERGE_SOURCE}', '2024-01-01');`,
  postgres: `
    INSERT INTO public.budgets (id, user_id, name, amount, period, category, category_id, start_date)
      VALUES ('${BUDGET}', '${USER}', 'Food', 100.00, 'monthly',
              '${MERGE_SOURCE}', '${MERGE_SOURCE}'::uuid, '2024-01-01');`,
};

/**
 * A recurring template filed under the merge source.
 *
 * The two engines disagree about what `recurring_transactions.user_id` IS — the
 * Clerk id in the cloud (text, FK to `user_profiles.clerk_user_id`), a
 * `users(id)` uuid locally — so this is the one fixture whose owner value is
 * genuinely different per engine rather than differently spelled. The cloud side
 * has to mint the profile row its foreign key wants; the base fixture's
 * `clerk_id` is the one it refers to.
 *
 * The verb matches on the category id alone, so neither value is load-bearing:
 * that is the point of the migration's own argument (a category id is a globally
 * unique uuid, so matching on it can only reach this owner's templates).
 */
export const RECURRING = 'd0000000-0000-0000-0000-000000000001';

export const recurringOnTheSource = {
  sqlite: `
    INSERT INTO recurring_transactions
      (id, user_id, account_id, description, amount_minor, type, category, frequency,
       start_date, next_date)
    VALUES ('${RECURRING}', '${USER}', '${EVERYDAY}', 'Weekly food', -2000, 'expense',
            '${MERGE_SOURCE}', 'weekly', '2024-01-01', '2024-01-08');`,
  postgres: `
    INSERT INTO public.user_profiles (clerk_user_id, email)
      VALUES ('clerk_local_sqlite_harness', 'harness@example.test');
    INSERT INTO public.recurring_transactions
      (id, user_id, account_id, description, amount, type, category, frequency,
       start_date, next_date)
    VALUES ('${RECURRING}', 'clerk_local_sqlite_harness', '${EVERYDAY}', 'Weekly food',
            -20.00, 'expense', '${MERGE_SOURCE}', 'weekly', '2024-01-01', '2024-01-08');`,
};

/**
 * A split line THIS user owns, on a parent the STRANGER owns.
 *
 * The only route to `merge_left_references` there is, and it exists because the
 * lines loop walks parents scoped by `transactions.user_id` while the final
 * check scans lines scoped by `transaction_splits.user_id`. Requires
 * [`secondUser`]. Nothing here moves this user's money — the parent and its
 * amount belong to the stranger — so B-1 still holds on Everyday and Rainy day.
 */
export const THEIR_SPLIT_PARENT = '70000000-0000-0000-0000-0000000000aa';

export const myLineOnTheirParent = {
  sqlite: `
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              is_split, category)
      VALUES ('${THEIR_SPLIT_PARENT}', '${STRANGER}', '${SOMEONE_ELSES_ACCOUNT}', 'Theirs',
              -1000, 'expense', '2024-05-01', 1, '');
    UPDATE accounts SET balance_minor = balance_minor - 1000 WHERE id = '${SOMEONE_ELSES_ACCOUNT}';
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order)
      VALUES ('50000000-0000-0000-0000-0000000000aa', '${THEIR_SPLIT_PARENT}', '${USER}',
              '${MERGE_SOURCE}', -1000, 0);`,
  postgres: `
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date,
                                     is_split, category)
      VALUES ('${THEIR_SPLIT_PARENT}', '${STRANGER}', '${SOMEONE_ELSES_ACCOUNT}', 'Theirs',
              -10.00, 'expense', '2024-05-01', true, '');
    UPDATE public.accounts SET balance = balance - 10.00 WHERE id = '${SOMEONE_ELSES_ACCOUNT}';
    INSERT INTO public.transaction_splits (id, transaction_id, user_id, category, amount, sort_order)
      VALUES ('50000000-0000-0000-0000-0000000000aa', '${THEIR_SPLIT_PARENT}', '${USER}',
              '${MERGE_SOURCE}', -10.00, 0);`,
};

/**
 * Corner shop as a split whose FIRST line is filed under the merge source, and
 * whose parent carries the source in the uuid column too.
 *
 * The shape that proves the double count: the transactions loop moves the
 * parent's `category_id` (leaving its blank `category` blank, which is what
 * stops `trg_protect_split_category` firing) and the lines loop moves its line,
 * so one row is counted once in each and audited twice.
 */
export const splitParentUnderTheSource = {
  sqlite: `
    INSERT INTO _rpc_guard VALUES ('split');
    UPDATE transactions SET is_split = 1, category = '', category_id = '${MERGE_SOURCE}'
     WHERE id = '${CORNER_SHOP}';
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order) VALUES
      ('${LEG_LINE}',   '${CORNER_SHOP}', '${USER}', '${MERGE_SOURCE}', -1500, 0),
      ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}',  -1000, 1);
    DELETE FROM _rpc_guard;`,
  postgres: `
    SELECT set_config('app.split_rpc', '1', true);
    UPDATE public.transactions SET is_split = true, category = '', category_id = '${MERGE_SOURCE}'::uuid
     WHERE id = '${CORNER_SHOP}';
    INSERT INTO public.transaction_splits (id, transaction_id, user_id, category, amount, sort_order) VALUES
      ('${LEG_LINE}',   '${CORNER_SHOP}', '${USER}', '${MERGE_SOURCE}', -15.00, 0),
      ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}',  -10.00, 1);
    SELECT set_config('app.split_rpc', '0', true);`,
};

/** The same, with BOTH lines under the source: two lines, one audit entry. */
export const bothLinesUnderTheSource = {
  sqlite: `
    INSERT INTO _rpc_guard VALUES ('split');
    UPDATE transactions SET is_split = 1, category = '' WHERE id = '${CORNER_SHOP}';
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order) VALUES
      ('${LEG_LINE}',   '${CORNER_SHOP}', '${USER}', '${MERGE_SOURCE}', -1500, 0),
      ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${MERGE_SOURCE}', -1000, 1);
    DELETE FROM _rpc_guard;`,
  postgres: `
    SELECT set_config('app.split_rpc', '1', true);
    UPDATE public.transactions SET is_split = true, category = '' WHERE id = '${CORNER_SHOP}';
    INSERT INTO public.transaction_splits (id, transaction_id, user_id, category, amount, sort_order) VALUES
      ('${LEG_LINE}',   '${CORNER_SHOP}', '${USER}', '${MERGE_SOURCE}', -15.00, 0),
      ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${MERGE_SOURCE}', -10.00, 1);
    SELECT set_config('app.split_rpc', '0', true);`,
};

/**
 * A LINKED transfer leg filed under the merge source — the guard case.
 *
 * `splitWithAnOrdinarilyFiledLeg` in the same shape, with the leg's category
 * moved onto the merge source so a merge has to re-file it. This is the MS Money
 * importer's population (86 of the owner's 364 split lines are legs filed under
 * ordinary categories), and it is the fixture that separates a local port with
 * `_rpc_guard('leg')` from one without: without the guard,
 * `trg_protect_linked_leg` raises `split_leg_locked` and the merge is refused
 * locally while the cloud performs it.
 *
 * Everyday stays at −25.00 (the lines sum to the parent) and Rainy day ends at
 * 15.00, so B-1 holds on both before the verb runs.
 */
export const linkedLegUnderTheSource = {
  sqlite: `
    INSERT INTO _rpc_guard VALUES ('split');
    UPDATE transactions SET is_split = 1, category = '' WHERE id = '${CORNER_SHOP}';
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              transfer_account_id)
    VALUES ('${LEG_COUNTERPART}', '${USER}', '${RAINY_DAY}', 'Counterpart', 1500, 'transfer',
            '2024-03-01', '${EVERYDAY}');
    UPDATE accounts SET balance_minor = balance_minor + 1500 WHERE id = '${RAINY_DAY}';
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order,
                                    transfer_account_id, linked_transfer_id)
      VALUES ('${LEG_LINE}', '${CORNER_SHOP}', '${USER}', '${MERGE_SOURCE}',
              -1500, 0, '${RAINY_DAY}', '${LEG_COUNTERPART}');
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order)
      VALUES ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -1000, 1);
    UPDATE transactions SET linked_transfer_split_id = '${LEG_LINE}' WHERE id = '${LEG_COUNTERPART}';
    DELETE FROM _rpc_guard;`,
  postgres: `
    SELECT set_config('app.split_rpc', '1', true);
    UPDATE public.transactions SET is_split = true, category = '' WHERE id = '${CORNER_SHOP}';
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date,
                                     transfer_account_id)
    VALUES ('${LEG_COUNTERPART}', '${USER}', '${RAINY_DAY}', 'Counterpart', 15.00, 'transfer',
            '2024-03-01', '${EVERYDAY}');
    UPDATE public.accounts SET balance = balance + 15.00 WHERE id = '${RAINY_DAY}';
    INSERT INTO public.transaction_splits (id, transaction_id, user_id, category, amount, sort_order,
                                           transfer_account_id, linked_transfer_id)
      VALUES ('${LEG_LINE}', '${CORNER_SHOP}', '${USER}', '${MERGE_SOURCE}',
              -15.00, 0, '${RAINY_DAY}', '${LEG_COUNTERPART}');
    INSERT INTO public.transaction_splits (id, transaction_id, user_id, category, amount, sort_order)
      VALUES ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -10.00, 1);
    UPDATE public.transactions SET linked_transfer_split_id = '${LEG_LINE}' WHERE id = '${LEG_COUNTERPART}';
    SELECT set_config('app.split_rpc', '0', true);`,
};

// ── The provenance verbs' fixtures ─────────────────────────────────────────

/** Five rows in Everyday, one per state the two verbs' WHERE clauses tell apart. */
export const BLANK_ROW = '70000000-0000-0000-0000-000000000021';
export const NULL_ROW = '70000000-0000-0000-0000-000000000022';
export const SPACES_ROW = '70000000-0000-0000-0000-000000000023';
export const FILED_ROW = '70000000-0000-0000-0000-000000000024';
export const GUESSED_ROW = '70000000-0000-0000-0000-000000000025';

/**
 * Three shapes of "not categorised", one row that is filed and vouched for, and
 * one that is filed as a SUGGESTION.
 *
 * The three blanks are not decoration: `category IS NULL OR btrim(category) = ''`
 * is the predicate both verbs turn on, and on a fixture with only one of the
 * three shapes a port that tested `= ''` (or only `IS NULL`) would pass.
 *
 * Each row is −1.00 and Everyday's balance is moved by −5.00, so B-1 holds.
 */
export const everyShapeOfFiling = {
  sqlite: `
    UPDATE accounts SET balance_minor = balance_minor - 500 WHERE id = '${EVERYDAY}';
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              category, category_confirmed) VALUES
      ('${BLANK_ROW}',   '${USER}', '${EVERYDAY}', 'Blank',     -100, 'expense', '2024-05-01', '',              0),
      ('${NULL_ROW}',    '${USER}', '${EVERYDAY}', 'Null',      -100, 'expense', '2024-05-02', NULL,            0),
      ('${SPACES_ROW}',  '${USER}', '${EVERYDAY}', 'Spaces',    -100, 'expense', '2024-05-03', '   ',           0),
      ('${FILED_ROW}',   '${USER}', '${EVERYDAY}', 'Filed',     -100, 'expense', '2024-05-04', '${WEEKLY_SHOP}', 1),
      ('${GUESSED_ROW}', '${USER}', '${EVERYDAY}', 'Guessed',   -100, 'expense', '2024-05-05', '${WEEKLY_SHOP}', 0);`,
  postgres: `
    UPDATE public.accounts SET balance = balance - 5.00 WHERE id = '${EVERYDAY}';
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date,
                                     category, category_confirmed) VALUES
      ('${BLANK_ROW}',   '${USER}', '${EVERYDAY}', 'Blank',   -1.00, 'expense', '2024-05-01', '',              false),
      ('${NULL_ROW}',    '${USER}', '${EVERYDAY}', 'Null',    -1.00, 'expense', '2024-05-02', NULL,            false),
      ('${SPACES_ROW}',  '${USER}', '${EVERYDAY}', 'Spaces',  -1.00, 'expense', '2024-05-03', '   ',           false),
      ('${FILED_ROW}',   '${USER}', '${EVERYDAY}', 'Filed',   -1.00, 'expense', '2024-05-04', '${WEEKLY_SHOP}', true),
      ('${GUESSED_ROW}', '${USER}', '${EVERYDAY}', 'Guessed', -1.00, 'expense', '2024-05-05', '${WEEKLY_SHOP}', false);`,
};

/** A blank, unconfirmed row of the STRANGER's. Requires [`secondUser`]. */
export const THEIR_ROW = '70000000-0000-0000-0000-0000000000ab';

export const strangersRow = {
  sqlite: `
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              category, category_confirmed)
      VALUES ('${THEIR_ROW}', '${STRANGER}', '${SOMEONE_ELSES_ACCOUNT}', 'Theirs', -100, 'expense',
              '2024-05-01', NULL, 0);
    UPDATE accounts SET balance_minor = balance_minor - 100 WHERE id = '${SOMEONE_ELSES_ACCOUNT}';`,
  postgres: `
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date,
                                     category, category_confirmed)
      VALUES ('${THEIR_ROW}', '${STRANGER}', '${SOMEONE_ELSES_ACCOUNT}', 'Theirs', -1.00, 'expense',
              '2024-05-01', NULL, false);
    UPDATE public.accounts SET balance = balance - 1.00 WHERE id = '${SOMEONE_ELSES_ACCOUNT}';`,
};

/** Corner shop as a split parent — blank category, two ordinary lines. */
export const plainSplitParent = {
  sqlite: `
    INSERT INTO _rpc_guard VALUES ('split');
    UPDATE transactions SET is_split = 1, category = '', category_confirmed = 0
     WHERE id = '${CORNER_SHOP}';
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order) VALUES
      ('${LEG_LINE}',   '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -1500, 0),
      ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -1000, 1);
    DELETE FROM _rpc_guard;`,
  postgres: `
    SELECT set_config('app.split_rpc', '1', true);
    UPDATE public.transactions SET is_split = true, category = '', category_confirmed = false
     WHERE id = '${CORNER_SHOP}';
    INSERT INTO public.transaction_splits (id, transaction_id, user_id, category, amount, sort_order) VALUES
      ('${LEG_LINE}',   '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -15.00, 0),
      ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -10.00, 1);
    SELECT set_config('app.split_rpc', '0', true);`,
};

/** Join two setup fragments, keeping them per engine. */
export function setups(...parts) {
  return {
    sqlite: parts.map((part) => part.sqlite).join('\n'),
    postgres: parts.map((part) => part.postgres).join('\n'),
  };
}

/** `accounts.balance` for one account, as a decimal string on either engine. */
export function balanceOf(accountId, expect) {
  return {
    name: `balance_of_${accountId.slice(-4)}`,
    sqlite: accountBalance.sqlite(accountId),
    postgres: accountBalance.postgres(accountId),
    expect,
  };
}

/**
 * B-1: `balance = initial_balance + SUM(amount)`, which must be 0.00 out.
 *
 * Asserted on EVERY verb spec, including the refusals, because B-1 is the
 * invariant the whole application rests on and neither schema enforces it. A
 * verb that refuses must leave it holding just as much as one that accepts.
 *
 * ONE FAMILY IS EXEMPT, and it is the family that proves the rule: the
 * `integrity-*` specs plant violations on purpose, and one of them plants a
 * broken B-1. Asserting B-1 there would be asserting that the fixture failed to
 * do its job. They assert `v_integrity_ok` instead, which is the same question
 * asked by the thing under test.
 */
export function balanceIdentityHolds(accountId) {
  return {
    name: `balance_identity_holds_for_${accountId.slice(-4)}`,
    sqlite: balanceIdentity.sqlite(accountId),
    postgres: balanceIdentity.postgres(accountId),
    expect: '0.00',
  };
}

/**
 * Whether the account NAMED by a refused write is actually there.
 *
 * Written for R-12. Since 20260808170000 widened `transactions.account_id` to
 * (account, owner), "this account does not exist" and "this account is not
 * yours" are refused by the SAME key with the same wording, and the pair of
 * specs that exists to keep those two cases apart can no longer do it by
 * reading the error. It can do it by reading the database: only the ownership
 * half of a composite key can refuse a write that names an account which is
 * demonstrably present.
 */
export function accountExists(accountId, expect) {
  return {
    name: `account_exists_${accountId.slice(-4)}`,
    sqlite: `SELECT COUNT(*) FROM accounts WHERE id = '${accountId}'`,
    postgres: `SELECT COUNT(*) FROM public.accounts WHERE id = '${accountId}'`,
    expect,
  };
}

/** How many rows exist against an account. */
export function rowsInAccount(accountId, expect) {
  return {
    name: `rows_in_account_${accountId.slice(-4)}`,
    sqlite: `SELECT COUNT(*) FROM transactions WHERE account_id = '${accountId}'`,
    postgres: `SELECT COUNT(*) FROM public.transactions WHERE account_id = '${accountId}'`,
    expect,
  };
}

/**
 * U-1 + U-6: exactly one `create` audit row for this transaction, with no
 * `before` and a `after`. The shape assertion is free and catches a port that
 * writes the audit row with the wrong action or fills in `before`.
 *
 * Every per-row assertion in this file carries the row's last four characters in
 * its NAME, and that is load-bearing rather than tidy. Results are collected
 * into a Map keyed by name, so two entries sharing one silently discard the
 * first. It was not tidy before:
 * `repair-the-whole-re-pair-happens-in-one-transaction` asserted
 * `auditRowsForUpdate` on all THREE rows the repair writes — the whole of T-14 —
 * and, all three being called `audit_rows_for_this_update`, only the last was
 * ever checked. `lib/verb-specs.mjs` now refuses a duplicate state name outright,
 * so the class of mistake cannot come back quietly.
 */
export function auditRowsForCreate(transactionId, expect) {
  const predicate = `entity = 'transaction'
      AND entity_id = '${transactionId}'
      AND action = 'create'
      AND before_data IS NULL
      AND after_data IS NOT NULL`;
  return {
    name: `audit_rows_for_create_${transactionId.slice(-4)}`,
    sqlite: `SELECT COUNT(*) FROM financial_audit_log WHERE ${predicate}`,
    postgres: `SELECT COUNT(*) FROM public.financial_audit_log WHERE ${predicate}`,
    expect,
  };
}

/** Every audit row in the file, regardless of subject. */
export function auditRowsInTotal(expect) {
  return {
    name: 'audit_rows_in_total',
    sqlite: 'SELECT COUNT(*) FROM financial_audit_log',
    postgres: 'SELECT COUNT(*) FROM public.financial_audit_log',
    expect,
  };
}

/**
 * U-1 + U-6 for an edit: exactly one `update` audit row, with BOTH a before and
 * an after. The shape assertion catches a port that logs an update as a create,
 * or that forgets the `before` — which is the half that makes the log evidence
 * rather than a list of current values.
 */
export function auditRowsForUpdate(transactionId, expect) {
  const predicate = `entity = 'transaction'
      AND entity_id = '${transactionId}'
      AND action = 'update'
      AND before_data IS NOT NULL
      AND after_data IS NOT NULL`;
  return {
    name: `audit_rows_for_update_${transactionId.slice(-4)}`,
    sqlite: `SELECT COUNT(*) FROM financial_audit_log WHERE ${predicate}`,
    postgres: `SELECT COUNT(*) FROM public.financial_audit_log WHERE ${predicate}`,
    expect,
  };
}

/** U-1 + U-6 for a delete: a `before`, and deliberately no `after`. */
export function auditRowsForDelete(transactionId, expect) {
  const predicate = `entity = 'transaction'
      AND entity_id = '${transactionId}'
      AND action = 'delete'
      AND before_data IS NOT NULL
      AND after_data IS NULL`;
  return {
    name: `audit_rows_for_delete_${transactionId.slice(-4)}`,
    sqlite: `SELECT COUNT(*) FROM financial_audit_log WHERE ${predicate}`,
    postgres: `SELECT COUNT(*) FROM public.financial_audit_log WHERE ${predicate}`,
    expect,
  };
}

/**
 * One TEXT-ish column of one row, read back from the file.
 *
 * Three states have to stay distinguishable and the engines spell none of them
 * alike, so they are normalised HERE, once: a missing row is `ABSENT`, a SQL
 * NULL is `NULL`, and an empty string is `EMPTY`. Without the last one the two
 * behaviours this whole verb turns on — "clears to NULL" and "stores the empty
 * string" — would both read as a blank line.
 */
export function storedText(transactionId, column, expect) {
  const wrap = (cast) => `CASE WHEN ${cast} IS NULL THEN 'NULL'
                              WHEN ${cast} = '' THEN 'EMPTY'
                              ELSE ${cast} END`;
  return {
    name: `stored_${column}_${transactionId.slice(-4)}`,
    sqlite: `SELECT COALESCE((SELECT ${wrap(column)} FROM transactions
        WHERE id = '${transactionId}'), 'ABSENT')`,
    postgres: `SELECT COALESCE((SELECT ${wrap(`${column}::text`)} FROM public.transactions
        WHERE id = '${transactionId}'), 'ABSENT')`,
    expect,
  };
}

/**
 * One boolean column, as `yes`/`no`.
 *
 * SQLite stores 0/1 and Postgres stores t/f; comparing the raw values would
 * report a divergence on every boolean in the schema and hide the one that
 * matters.
 */
export function storedFlag(transactionId, column, expect) {
  return {
    name: `stored_${column}_${transactionId.slice(-4)}`,
    sqlite: `SELECT COALESCE((SELECT CASE WHEN ${column} = 1 THEN 'yes' ELSE 'no' END
        FROM transactions WHERE id = '${transactionId}'), 'ABSENT')`,
    postgres: `SELECT COALESCE((SELECT CASE WHEN ${column} THEN 'yes' ELSE 'no' END
        FROM public.transactions WHERE id = '${transactionId}'), 'ABSENT')`,
    expect,
  };
}

/** Is this row still there? */
export function rowExists(transactionId, expect) {
  return {
    name: `row_exists_${transactionId.slice(-4)}`,
    sqlite: `SELECT COUNT(*) FROM transactions WHERE id = '${transactionId}'`,
    postgres: `SELECT COUNT(*) FROM public.transactions WHERE id = '${transactionId}'`,
    expect,
  };
}

/**
 * The tags on one row, as a comma-separated list in a stable order.
 *
 * `NONE` covers "no tags" on both engines, and it has to be spelled out: a
 * child table with no rows and a NULL `text[]` are the same fact, and both
 * render as an empty line, which the runner would then read as a NULL.
 */
export function storedTags(transactionId, expect) {
  return {
    name: `stored_tags_${transactionId.slice(-4)}`,
    sqlite: `SELECT COALESCE((SELECT group_concat(tag, ',') FROM
        (SELECT tag FROM transaction_tags WHERE transaction_id = '${transactionId}' ORDER BY tag)), 'NONE')`,
    postgres: `SELECT COALESCE(NULLIF((SELECT array_to_string(ARRAY(SELECT unnest(tags) ORDER BY 1), ',')
        FROM public.transactions WHERE id = '${transactionId}'), ''), 'NONE')`,
    expect,
  };
}

// ── The split line set, and the rows a leg mints ───────────────────────────
//
// Comparing splits across engines needs three things a transaction comparison
// did not: money as a decimal string from an integer column on one side and a
// numeric on the other; a category rendered by NAME, because a To/From category
// is minted by a trigger and its id is unknowable on both engines; and a link
// rendered as a FACT rather than an id, because a counterpart minted during the
// call gets a different uuid on each engine and always will.

/** A category id column, rendered as the category's name where there is one. */
const categoryName = {
  sqlite: (expr) => `COALESCE((SELECT c.name FROM categories c WHERE c.id = ${expr}), ${expr})`,
  postgres: (expr) =>
    `COALESCE((SELECT c.name FROM public.categories c WHERE c.id::text = ${expr}), ${expr})`,
};

/**
 * The WHOLE line set of one split, as one canonical string.
 *
 * `sort_order:amount:category:target:link:memo` per line, joined by ` | `, in
 * display order. One assertion covers S-1's inputs, the sort order the writer
 * assigns, which line kept its target and which line is half of a transfer —
 * and it fails loudly if any of them moves, which a per-field assertion would
 * not.
 */
export function splitLines(parentId, expect) {
  const parts = (engine) => {
    const money = engine === 'sqlite'
      ? minorToDecimal('s.amount_minor')
      : numericToDecimal('s.amount');
    const target = engine === 'sqlite'
      ? "COALESCE(substr(s.transfer_account_id, -4), '-')"
      : "COALESCE(right(s.transfer_account_id::text, 4), '-')";
    return `CAST(s.sort_order AS TEXT) || ':' || ${money} || ':'
            || ${categoryName[engine]('s.category')} || ':' || ${target} || ':'
            || CASE WHEN s.linked_transfer_id IS NULL THEN '-' ELSE 'linked' END
            || ':' || COALESCE(s.memo, '-')`;
  };
  return {
    name: `split_lines_${parentId.slice(-4)}`,
    sqlite: `SELECT COALESCE((SELECT group_concat(line, ' | ') FROM (
               SELECT ${parts('sqlite')} AS line
                 FROM transaction_splits s
                WHERE s.transaction_id = '${parentId}'
                ORDER BY s.sort_order)), 'NONE')`,
    postgres: `SELECT COALESCE(string_agg(${parts('postgres')}, ' | ' ORDER BY s.sort_order), 'NONE')
                 FROM public.transaction_splits s
                WHERE s.transaction_id = '${parentId}'`,
    expect,
  };
}

/**
 * Every transaction sitting in one account, as one canonical string.
 *
 * `amount:type:category:description:notes:cleared:leg` per row. This is how a
 * minted counterpart is compared without naming its id: everything about it that
 * the writer decided is here, and the one thing it did not decide — the uuid —
 * is not.
 */
export function rowsIn(accountId, expect) {
  const parts = (engine) => {
    const money = engine === 'sqlite'
      ? minorToDecimal('t.amount_minor')
      : numericToDecimal('t.amount');
    const cleared = engine === 'sqlite'
      ? "CASE WHEN t.is_cleared = 1 THEN 'cleared' ELSE 'uncleared' END"
      : "CASE WHEN t.is_cleared THEN 'cleared' ELSE 'uncleared' END";
    return `${money} || ':' || t.type || ':' || ${categoryName[engine]("COALESCE(t.category, '-')")}
            || ':' || t.description || ':' || COALESCE(t.notes, '-') || ':' || ${cleared}
            || ':' || CASE WHEN t.linked_transfer_split_id IS NOT NULL THEN 'leg-of-a-split'
                           WHEN t.linked_transfer_id IS NOT NULL THEN 'linked'
                           ELSE '-' END`;
  };
  return {
    name: `rows_in_${accountId.slice(-4)}`,
    sqlite: `SELECT COALESCE((SELECT group_concat(row, ' | ') FROM (
               SELECT ${parts('sqlite')} AS row
                 FROM transactions t
                WHERE t.account_id = '${accountId}'
                ORDER BY t.amount_minor, t.description)), 'NONE')`,
    postgres: `SELECT COALESCE(string_agg(${parts('postgres')}, ' | ' ORDER BY t.amount, t.description), 'NONE')
                 FROM public.transactions t
                WHERE t.account_id = '${accountId}'`,
    expect,
  };
}

/**
 * T-11, over the whole file: a counterpart that names a split line is named back
 * by it, and a line that names a counterpart is named back by that.
 *
 * Asserted on every split spec, refusals included. Half a pair is the one-sided
 * transfer this entire feature exists to prevent, and neither schema forbids it.
 */
export function legPairsAreMutual() {
  const check = (transactions, splits) => `SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM ${transactions} t
       WHERE t.linked_transfer_split_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${splits} s
                          WHERE s.id = t.linked_transfer_split_id
                            AND s.linked_transfer_id = t.id))
    AND NOT EXISTS (
      SELECT 1 FROM ${splits} s
       WHERE s.linked_transfer_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${transactions} t
                          WHERE t.id = s.linked_transfer_id
                            AND t.linked_transfer_split_id = s.id))
    THEN 'MUTUAL' ELSE 'BROKEN' END`;
  return {
    name: 'leg_pairs_are_mutual',
    sqlite: check('transactions', 'transaction_splits'),
    postgres: check('public.transactions', 'public.transaction_splits'),
    expect: 'MUTUAL',
  };
}

/**
 * S-1, as an assertion rather than as a hope: the parent's amount minus the sum
 * of its lines, which must be `0.00` whenever the row is split at all.
 *
 * `NOT-SPLIT` is a real answer and not a failure — every refusal spec runs
 * against a fixture that may or may not already be split, and reporting the two
 * cases as one blank line is how a broken sum would hide.
 */
export function splitSumHolds(parentId) {
  const check = (engine) => {
    const table = engine === 'sqlite' ? 'transactions' : 'public.transactions';
    const lines = engine === 'sqlite' ? 'transaction_splits' : 'public.transaction_splits';
    const amount = engine === 'sqlite' ? 't.amount_minor' : 't.amount';
    const lineAmount = engine === 'sqlite' ? 's.amount_minor' : 's.amount';
    const split = engine === 'sqlite' ? 't.is_split = 1' : 't.is_split';
    const difference = `${amount} - COALESCE((SELECT SUM(${lineAmount}) FROM ${lines} s
                          WHERE s.transaction_id = t.id), 0)`;
    const rendered = engine === 'sqlite'
      ? minorToDecimal(difference)
      : numericToDecimal(difference);
    return `SELECT COALESCE((SELECT CASE WHEN ${split} THEN ${rendered} ELSE 'NOT-SPLIT' END
              FROM ${table} t WHERE t.id = '${parentId}'), 'ABSENT')`;
  };
  return {
    name: `split_sum_holds_${parentId.slice(-4)}`,
    sqlite: check('sqlite'),
    postgres: check('postgres'),
    expect: '0.00',
  };
}

/**
 * Every audit row in the file as `entity/action`, sorted.
 *
 * The split writer audits THREE entities and the shape of that set is the
 * assertion: `transaction/create,account/update,transaction/update` is a leg
 * being minted, `transaction/update,account/update` is a total that moved, and a
 * bare `transaction/update` is a re-filing that moved no money. Counting rows
 * would pass on all three.
 */
export function auditShape(expect) {
  return {
    name: 'audit_shape',
    sqlite: `SELECT COALESCE((SELECT group_concat(entry, ',') FROM (
               SELECT entity || '/' || action AS entry
                 FROM financial_audit_log ORDER BY entity, action)), 'NONE')`,
    postgres: `SELECT COALESCE(string_agg(entity || '/' || action, ',' ORDER BY entity, action), 'NONE')
                 FROM public.financial_audit_log`,
    expect,
  };
}

/** Is this split line still there, and does it still name a counterpart? */
export function splitLineState(lineId, expect) {
  return {
    name: `split_line_${lineId.slice(-4)}`,
    sqlite: `SELECT COALESCE((SELECT CASE WHEN linked_transfer_id IS NULL THEN 'unlinked' ELSE 'linked' END
               FROM transaction_splits WHERE id = '${lineId}'), 'GONE')`,
    postgres: `SELECT COALESCE((SELECT CASE WHEN linked_transfer_id IS NULL THEN 'unlinked' ELSE 'linked' END
                 FROM public.transaction_splits WHERE id = '${lineId}'), 'GONE')`,
    expect,
  };
}

/**
 * One row's whole transfer scaffolding, as one canonical string.
 *
 * `type:category:target:link:splitlink`, with the category rendered by NAME
 * (a To/From category's id is minted by a trigger and unknowable on either
 * engine) and every account or row reference by its last four characters.
 *
 * One assertion covers T-6 (which account's To/From category each side landed
 * on), the target, and both halves of the link — and it fails loudly if any of
 * them moves, which four separate assertions would let slide one at a time.
 *
 * `namesIds: false` renders the links as bare `linked` / `leg-of-a-split`
 * instead. That is for the one verb that MINTS the row on the other side:
 * `create_transfer_counterpart` generates a uuid, the two engines generate
 * different ones, and they always will.
 */
export function transferShape(transactionId, expect, { namesIds = true } = {}) {
  const build = (engine) => {
    const last4 = (column) => (engine === 'sqlite'
      ? `COALESCE(substr(${column}, -4), '-')`
      : `COALESCE(right(${column}::text, 4), '-')`);
    const link = namesIds
      ? last4('t.linked_transfer_id')
      : "CASE WHEN t.linked_transfer_id IS NULL THEN '-' ELSE 'linked' END";
    const splitLink = namesIds
      ? last4('t.linked_transfer_split_id')
      : "CASE WHEN t.linked_transfer_split_id IS NULL THEN '-' ELSE 'leg-of-a-split' END";
    const table = engine === 'sqlite' ? 'transactions' : 'public.transactions';
    return `SELECT COALESCE((SELECT t.type || ':' || ${categoryName[engine]("COALESCE(t.category, '-')")}
              || ':' || ${last4('t.transfer_account_id')} || ':' || ${link} || ':' || ${splitLink}
              FROM ${table} t WHERE t.id = '${transactionId}'), 'ABSENT')`;
  };
  return {
    name: `transfer_shape_${transactionId.slice(-4)}`,
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

/**
 * T-7, over the whole file: `A.linked = B.id AND B.linked = A.id`.
 *
 * Enforced **nowhere** in the cloud — DESIGN.md §1.3 records that only
 * `repair_claimed_transfer` even checks it, and then only for the one pair it is
 * about to break. So this is asserted on every transfer spec the way B-1 is: as
 * a property nothing in either engine defends, which therefore has to be looked
 * at rather than assumed.
 *
 * Rows whose link lives on a split LINE are excluded — their mutuality runs
 * through the line and is [`legPairsAreMutual`]'s business.
 *
 * `BROKEN` is a legitimate expectation and one spec uses it on purpose:
 * `clear_transfer_links` unlinks only the rows it was given, so naming one side
 * of a pair leaves the other pointing at it. Both engines do that, it is the
 * documented contract, and a spec that expected `MUTUAL` there would be asserting
 * a fix neither engine has.
 */
export function transferLinksAreMutual(expect = 'MUTUAL') {
  const check = (table) => `SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM ${table} a
       WHERE a.linked_transfer_id IS NOT NULL
         AND a.linked_transfer_split_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM ${table} b
                          WHERE b.id = a.linked_transfer_id
                            AND b.linked_transfer_id = a.id))
    THEN 'MUTUAL' ELSE 'BROKEN' END`;
  return {
    name: 'transfer_links_are_mutual',
    sqlite: check('transactions'),
    postgres: check('public.transactions'),
    expect,
  };
}

/** How many rows in the whole file carry a `linked_transfer_id`. */
export function linkedRows(expect) {
  return {
    name: 'linked_rows_in_file',
    sqlite: 'SELECT COUNT(*) FROM transactions WHERE linked_transfer_id IS NOT NULL',
    postgres: 'SELECT COUNT(*) FROM public.transactions WHERE linked_transfer_id IS NOT NULL',
    expect,
  };
}

// ── Category assertions ────────────────────────────────────────────────────

/**
 * One category's whole shape, as one canonical string.
 *
 * `name:type:level:parent:flags:active`, with the parent by its last four
 * characters and the three semantic flags as letters (`t`ransfer,
 * `r`evaluation, `u`nassigned, plus `s`ystem) so a spec can say "and none of
 * them" as `-`.
 *
 * `GONE` is a first-class answer and most merge specs use it on purpose: the
 * whole operation ends by removing the source, and a refusal spec that only
 * counted rows would pass on a merge that deleted the wrong one.
 */
export function categoryShape(categoryId, expect) {
  const build = (engine) => {
    const table = engine === 'sqlite' ? 'categories' : 'public.categories';
    const truthy = (column) => (engine === 'sqlite' ? `c.${column} = 1` : `c.${column}`);
    const last4 = engine === 'sqlite'
      ? "COALESCE(substr(c.parent_id, -4), '-')"
      : "COALESCE(right(c.parent_id::text, 4), '-')";
    const flags = `COALESCE(NULLIF(
        CASE WHEN ${truthy('is_system')} THEN 's' ELSE '' END ||
        CASE WHEN ${truthy('is_transfer_category')} THEN 't' ELSE '' END ||
        CASE WHEN ${truthy('is_revaluation_category')} THEN 'r' ELSE '' END ||
        CASE WHEN ${truthy('is_unassigned_bucket')} THEN 'u' ELSE '' END, ''), '-')`;
    const active = `CASE WHEN ${truthy('is_active')} THEN 'active' ELSE 'hidden' END`;
    return `SELECT COALESCE((SELECT c.name || ':' || c.type || ':' || c.level || ':' || ${last4}
              || ':' || ${flags} || ':' || ${active}
              FROM ${table} c WHERE c.id = '${categoryId}'), 'GONE')`;
  };
  return {
    name: `category_${categoryId.slice(-4)}`,
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

/**
 * How one transaction is filed, through BOTH reference columns.
 *
 * `category/category_id`, each rendered by the category's NAME where it resolves
 * and by its raw value where it does not — because "the text column still points
 * at a category that no longer exists" is a state this family produces on
 * purpose, and rendering it as a name would hide it.
 *
 * `EMPTY` for the empty string and `NULL` for SQL NULL, kept apart for the reason
 * [`storedText`] gives.
 */
export function filedAs(transactionId, expect) {
  const build = (engine) => {
    const table = engine === 'sqlite' ? 'transactions' : 'public.transactions';
    // `trim` in both, not `btrim`: SQLite has no btrim, and Postgres's trim(x)
    // IS btrim(x). One spelling that means the same thing on both engines.
    const show = (expr) => `CASE WHEN ${expr} IS NULL THEN 'NULL'
                                 WHEN trim(${expr}) = '' THEN 'EMPTY'
                                 ELSE ${categoryName[engine](expr)} END`;
    const uuid = engine === 'sqlite' ? 't.category_id' : 't.category_id::text';
    return `SELECT COALESCE((SELECT ${show('t.category')} || '/' || ${show(uuid)}
              FROM ${table} t WHERE t.id = '${transactionId}'), 'ABSENT')`;
  };
  return {
    name: `filed_as_${transactionId.slice(-4)}`,
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

/** A budget's two reference columns, rendered the same way. */
export function budgetFiledAs(budgetId, expect) {
  const build = (engine) => {
    const table = engine === 'sqlite' ? 'budgets' : 'public.budgets';
    const show = (expr) => `CASE WHEN ${expr} IS NULL THEN 'NULL'
                                 ELSE ${categoryName[engine](expr)} END`;
    const uuid = engine === 'sqlite' ? 'b.category_id' : 'b.category_id::text';
    return `SELECT COALESCE((SELECT ${show('b.category')} || '/' || ${show(uuid)}
              FROM ${table} b WHERE b.id = '${budgetId}'), 'ABSENT')`;
  };
  return {
    name: `budget_filed_as_${budgetId.slice(-4)}`,
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

/** A recurring template's single reference column. */
export function recurringFiledAs(recurringId, expect) {
  const build = (engine) => {
    const table = engine === 'sqlite' ? 'recurring_transactions' : 'public.recurring_transactions';
    return `SELECT COALESCE((SELECT ${categoryName[engine]('r.category')}
              FROM ${table} r WHERE r.id = '${recurringId}'), 'ABSENT')`;
  };
  return {
    name: `recurring_filed_as_${recurringId.slice(-4)}`,
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

/**
 * How many rows in the whole file still refer to one category, by ANY route.
 *
 * The five surfaces `merge_left_references` checks, added together, and
 * deliberately NOT scoped by owner — a merge that left somebody else's row
 * pointing at a deleted category is a real outcome of the cloud's design and
 * this is what makes it visible instead of assumed.
 */
export function referencesTo(categoryId, expect) {
  const build = (engine) => {
    const p = engine === 'sqlite' ? '' : 'public.';
    const uuid = engine === 'sqlite' ? `'${categoryId}'` : `'${categoryId}'::uuid`;
    return `SELECT
        (SELECT COUNT(*) FROM ${p}transactions WHERE category = '${categoryId}' OR category_id = ${uuid})
      + (SELECT COUNT(*) FROM ${p}transaction_splits WHERE category = '${categoryId}')
      + (SELECT COUNT(*) FROM ${p}budgets WHERE category = '${categoryId}' OR category_id = ${uuid})
      + (SELECT COUNT(*) FROM ${p}recurring_transactions WHERE category = '${categoryId}')
      + (SELECT COUNT(*) FROM ${p}categories WHERE parent_id = ${uuid})`;
  };
  return {
    name: `references_to_${categoryId.slice(-4)}`,
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

/**
 * Every row of the provenance fixture, as `description=category/vouched|guess`.
 *
 * One assertion covering which rows a bulk verb touched, what it filed them
 * under, and whether it claimed a human agreed — the three things these two
 * verbs decide. Three separate assertions would let one of them slide.
 */
export function filingBoard(expect) {
  const build = (engine) => {
    const table = engine === 'sqlite' ? 'transactions' : 'public.transactions';
    const vouched = engine === 'sqlite'
      ? "CASE WHEN t.category_confirmed = 1 THEN 'vouched' ELSE 'guess' END"
      : "CASE WHEN t.category_confirmed THEN 'vouched' ELSE 'guess' END";
    const filed = `CASE WHEN t.category IS NULL THEN 'NULL'
                        WHEN trim(t.category) = '' THEN 'EMPTY'
                        ELSE ${categoryName[engine]('t.category')} END`;
    const parts = `t.description || '=' || ${filed} || '/' || ${vouched}`;
    return engine === 'sqlite'
      ? `SELECT COALESCE((SELECT group_concat(row, ' | ') FROM (
           SELECT ${parts} AS row FROM ${table} t
            WHERE t.id IN ('${BLANK_ROW}','${NULL_ROW}','${SPACES_ROW}','${FILED_ROW}','${GUESSED_ROW}')
            ORDER BY t.date)), 'NONE')`
      : `SELECT COALESCE(string_agg(${parts}, ' | ' ORDER BY t.date), 'NONE') FROM ${table} t
          WHERE t.id IN ('${BLANK_ROW}','${NULL_ROW}','${SPACES_ROW}','${FILED_ROW}','${GUESSED_ROW}')`;
  };
  return {
    name: 'filing_board',
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

/** The amount stored against one row, read back from the file as a decimal. */
export function storedAmount(transactionId, expect) {
  return {
    name: `stored_amount_${transactionId.slice(-4)}`,
    sqlite: `SELECT COALESCE((SELECT ${'(CASE WHEN amount_minor < 0 THEN \'-\' ELSE \'\' END'
      + " || CAST(abs(amount_minor) / 100 AS TEXT) || '.'"
      + " || substr('0' || CAST(abs(amount_minor) % 100 AS TEXT), -2, 2))"}
        FROM transactions WHERE id = '${transactionId}'), 'ABSENT')`,
    postgres: `SELECT COALESCE((SELECT amount::text FROM public.transactions
        WHERE id = '${transactionId}'), 'ABSENT')`,
    expect,
  };
}

// ── The restore family's fixtures ──────────────────────────────────────────
//
// A restore refuses unless the login is empty (X-1), and the base fixture is
// not, so almost every spec in this family clears it first.

/**
 * The login, emptied — by hand, not by the wipe verb.
 *
 * Deliberately plain DELETEs on both engines rather than a call to
 * `wipe_user_financial_data`, for two reasons. The wipe WRITES AUDIT ROWS, and a
 * restore spec that then counts the audit log would be counting the setup; and
 * the SQLite side has no way to call a Rust verb from a setup string, so the two
 * engines would be cleared by different code doing different amounts of work.
 *
 * Accounts first is X-3 and it is not optional on either engine: deleting the
 * categories while their accounts stand raises `transfer_category_protected`.
 */
export const wiped = {
  sqlite: `
    DELETE FROM accounts     WHERE user_id = '${USER}';
    DELETE FROM transactions WHERE user_id = '${USER}';
    DELETE FROM categories   WHERE user_id = '${USER}';`,
  postgres: `
    DELETE FROM public.accounts     WHERE user_id = '${USER}';
    DELETE FROM public.transactions WHERE user_id = '${USER}';
    DELETE FROM public.categories   WHERE user_id = '${USER}';`,
};

/** Ids for the rows a backup file puts back. Nothing in the fixture uses them. */
export const RESTORED_ACCOUNT = 'a0000000-0000-0000-0000-0000000000f1';
export const RESTORED_SAVINGS = 'a0000000-0000-0000-0000-0000000000f2';
export const RESTORED_ROW = '70000000-0000-0000-0000-0000000000f1';
export const RESTORED_OTHER = '70000000-0000-0000-0000-0000000000f2';
export const RESTORED_TRANSFER_ROOT = 'c0000000-0000-0000-0000-0000000000f8';
export const RESTORED_TO_FROM = 'c0000000-0000-0000-0000-0000000000f9';

/**
 * A whole `accounts` row, as a backup file holds one.
 *
 * "Whole" is the contract, not a courtesy: `jsonb_populate_recordset` does not
 * apply column defaults, so the cloud REFUSES a row missing any NOT NULL key —
 * MEASURED, on `low_balance_alert_enabled`, which has a default and is refused
 * anyway. Every NOT NULL column of `public.accounts` is therefore present here.
 *
 * `user_id` is deliberately the STRANGER's: X-6 says every restored row is
 * re-owned to the caller, and a fixture that already had the right owner could
 * not tell a re-owning from a copy.
 *
 * Money is a STRING. A JSON number is an IEEE-754 double by the time any parser
 * has read it, and a spec for a ledger should not contain one.
 */
export function backupAccount(overrides = {}) {
  return {
    id: RESTORED_ACCOUNT,
    user_id: STRANGER,
    name: 'Everyday',
    type: 'checking',
    currency: 'GBP',
    balance: '-25.00',
    initial_balance: '0.00',
    is_active: true,
    low_balance_alert_enabled: false,
    metadata: {},
    created_at: '2019-01-01T00:00:00+00:00',
    updated_at: '2019-01-01T00:00:00+00:00',
    ...overrides,
  };
}

/** A whole `transactions` row, same contract. */
export function backupTransaction(overrides = {}) {
  return {
    id: RESTORED_ROW,
    user_id: STRANGER,
    account_id: RESTORED_ACCOUNT,
    description: 'Corner shop',
    amount: '-25.00',
    type: 'expense',
    date: '2019-05-04',
    is_cleared: false,
    is_split: false,
    archived: false,
    category_confirmed: true,
    is_recurring: false,
    metadata: {},
    created_at: '2019-05-04T00:00:00+00:00',
    updated_at: '2019-05-04T00:00:00+00:00',
    ...overrides,
  };
}

/** A whole `categories` row, same contract. */
export function backupCategory(overrides = {}) {
  return {
    id: RESTORED_TRANSFER_ROOT,
    user_id: STRANGER,
    name: 'Transfer',
    type: 'both',
    level: 'type',
    is_system: false,
    is_transfer_category: false,
    is_revaluation_category: false,
    is_unassigned_bucket: false,
    is_active: true,
    created_at: '2019-01-01T00:00:00+00:00',
    updated_at: '2019-01-01T00:00:00+00:00',
    ...overrides,
  };
}

/**
 * The same row as an OLDER schema wrote it: the named keys REMOVED.
 *
 * A backup is not a message from the current schema, it is a message from a
 * past one, and the fixtures above are written against today's — so "a file
 * that predates this column" cannot be expressed by leaving a key out of
 * [`backupTransaction`] and hoping nobody adds it later. That hope is exactly
 * how the defect this exists to catch got in: `needs_review` was absent from
 * these fixtures by accident of history, so the specs that would have caught
 * `20260810090000` were testing the omission without saying so, and the day
 * somebody adds it to the fixture they would silently stop.
 *
 * Deleting the key states the intent, and keeps stating it whatever the fixture
 * grows. Deliberately silent when a key is already absent: the point is the
 * shape of the result, not the diff from today.
 */
export function asExportedBefore(row, ...columns) {
  const older = { ...row };
  for (const column of columns) delete older[column];
  return older;
}

/** One chunk of a restore, in the shape both engines are handed. */
export function chunk(entity, rows) {
  return { entity, rows };
}

/** How many rows one table holds for the fixture's login. */
export function rowCount(name, table, expect, where = '') {
  const clause = where ? ` AND ${where}` : '';
  return {
    name,
    sqlite: `SELECT COUNT(*) FROM ${table} WHERE user_id = '${USER}'${clause}`,
    postgres: `SELECT COUNT(*) FROM public.${table} WHERE user_id = '${USER}'${clause}`,
    expect,
  };
}

/** One restored account's stored balance and initial balance, as decimals. */
export function storedBalances(accountId, expect) {
  const decimal = (column) =>
    `(CASE WHEN ${column} < 0 THEN '-' ELSE '' END || CAST(abs(${column}) / 100 AS TEXT)
      || '.' || substr('0' || CAST(abs(${column}) % 100 AS TEXT), -2, 2))`;
  return {
    name: `stored_balances_${accountId.slice(-4)}`,
    sqlite: `SELECT COALESCE((SELECT ${decimal('balance_minor')} || '/' || ${decimal('initial_balance_minor')}
              FROM accounts WHERE id = '${accountId}'), 'ABSENT')`,
    postgres: `SELECT COALESCE((SELECT balance::text || '/' || initial_balance::text
                FROM public.accounts WHERE id = '${accountId}'), 'ABSENT')`,
    expect,
  };
}

/** The day one row's updated_at falls on — X-4's whole subject. */
export function updatedDay(table, id, expect) {
  return {
    name: `updated_day_${id.slice(-4)}`,
    sqlite: `SELECT COALESCE((SELECT substr(updated_at, 1, 10) FROM ${table} WHERE id = '${id}'), 'ABSENT')`,
    postgres: `SELECT COALESCE((SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
                FROM public.${table} WHERE id = '${id}'), 'ABSENT')`,
    expect,
  };
}

/**
 * An emptied login with ONE account back in it, planted directly.
 *
 * The restore verb takes one chunk per differential spec (the cloud RPC takes
 * one entity per call), so a spec about restoring TRANSACTIONS needs their
 * account to be there already. Planted rather than restored, so that the spec
 * asserts one thing.
 *
 * The account is deliberately at −25.00 with no transactions against it, which is
 * the state a real restore reaches between the accounts chunk and the
 * transactions chunk: B-1 does not hold in the middle of a restore and is not
 * expected to.
 */
export const wipedWithOneAccount = {
  sqlite: `${wiped.sqlite}
    INSERT INTO accounts (id, user_id, name, type, balance_minor, initial_balance_minor, updated_at)
      VALUES ('${RESTORED_ACCOUNT}', '${USER}', 'Everyday', 'checking', -2500, 0, '2019-01-01T00:00:00.000Z');`,
  postgres: `${wiped.postgres}
    INSERT INTO public.accounts (id, user_id, name, type, balance, initial_balance, updated_at)
      VALUES ('${RESTORED_ACCOUNT}', '${USER}', 'Everyday', 'checking', -25.00, 0.00, '2019-01-01T00:00:00Z');`,
};

// ── The prune's fixtures ───────────────────────────────────────────────────
//
// `delete_unused_categories` starts from exactly what `merge_categories` starts
// from: an ordinary expense leaf under Outgoings that nothing refers to. Rather
// than mint a second identical pair, the prune specs name the merge pair's ids
// through these aliases, so a reader of either family sees a name that means
// something in it.

/** The leaf a prune is asked to remove. */
export const PRUNABLE = MERGE_SOURCE;
/** A second one, for the batch cases. */
export const SECOND_PRUNABLE = MERGE_TARGET;
/** Both of them. */
export const prunablePair = mergeablePair;

/**
 * Corner shop filed under [`PRUNABLE`] through the UUID column ALONE.
 *
 * The measured hole in the prune's transaction check: it reads
 * `t.category = c.id::text` and nothing else, so a row filed only through
 * `category_id` does not save its category and has the column nulled out from
 * under it by the foreign key (`probe-prune1.sh`,
 * `p-used-by-transaction-uuid-only`). The budget check reads BOTH columns; this
 * one does not, and the asymmetry is the cloud's own.
 */
export const filedUnderThePrunableByUuidAlone = {
  sqlite: `
    UPDATE transactions SET category = NULL, category_id = '${PRUNABLE}'
     WHERE id = '${CORNER_SHOP}';`,
  postgres: `
    UPDATE public.transactions SET category = NULL, category_id = '${PRUNABLE}'::uuid
     WHERE id = '${CORNER_SHOP}';`,
};

/** A budget naming [`PRUNABLE`] through the uuid column alone — which DOES save it. */
export const budgetOnThePrunableByUuidAlone = {
  sqlite: `
    INSERT INTO budgets (id, user_id, name, amount_minor, period, category_id, start_date)
      VALUES ('${BUDGET}', '${USER}', 'Food', 10000, 'monthly', '${PRUNABLE}', '2024-01-01');`,
  postgres: `
    INSERT INTO public.budgets (id, user_id, name, amount, period, category_id, start_date)
      VALUES ('${BUDGET}', '${USER}', 'Food', 100.00, 'monthly', '${PRUNABLE}'::uuid, '2024-01-01');`,
};

/** A leaf under [`PRUNABLE`], so the batch has a parent and a child in it. */
export const PRUNABLE_CHILD = 'c0000000-0000-0000-0000-0000000000c1';
/** And one under THAT, for the three-generation case. */
export const PRUNABLE_GRANDCHILD = 'c0000000-0000-0000-0000-0000000000c2';

export const prunableChild = childOf(PRUNABLE, PRUNABLE_CHILD);
export const prunableGrandchild = childOf(PRUNABLE_CHILD, PRUNABLE_GRANDCHILD);

/**
 * Move an account's To/From category UNDER a prunable one.
 *
 * The only route to the one refusal this verb can produce, and it is a refusal
 * the FILE raises rather than the function: naming both the parent and the
 * To/From child means the child no longer keeps its parent alive, the parent is
 * deleted, and `parent_id ON DELETE CASCADE` walks the protected row into C-5's
 * trigger. The category's id is minted by a trigger on both engines, so it is
 * reached through its ACCOUNT here and named through a sub-SELECT in the payload
 * nowhere — which is why the spec that uses this also needs
 * [`namedTransferCategories`] to give it an id a payload can carry.
 */
export function transferCategoryUnder(parentId, accountId) {
  return {
    sqlite: `UPDATE categories SET parent_id = '${parentId}'
              WHERE account_id = '${accountId}' AND is_transfer_category = 1;`,
    postgres: `UPDATE public.categories SET parent_id = '${parentId}'
                WHERE account_id = '${accountId}' AND is_transfer_category;`,
  };
}

/** Is this category still in the file? `GONE` when the prune took it. */
export function categoryPresent(categoryId, expect) {
  return {
    name: `category_present_${categoryId.slice(-4)}`,
    sqlite: `SELECT CASE WHEN EXISTS (SELECT 1 FROM categories WHERE id = '${categoryId}')
                    THEN 'HERE' ELSE 'GONE' END`,
    postgres: `SELECT CASE WHEN EXISTS (SELECT 1 FROM public.categories WHERE id = '${categoryId}')
                      THEN 'HERE' ELSE 'GONE' END`,
    expect,
  };
}

/** How many To/From categories the file holds, whoever they belong to. */
export function transferCategoryCount(expect) {
  return {
    name: 'transfer_categories',
    sqlite: 'SELECT COUNT(*) FROM categories WHERE is_transfer_category = 1',
    postgres: 'SELECT COUNT(*) FROM public.categories WHERE is_transfer_category',
    expect,
  };
}

// ── verify_integrity's fixtures: seventeen ways to break a file ────────────
//
// Every other fixture in this file builds a state the ledger is happy with.
// These build states it is NOT, because a check nobody can plant is a check
// nobody can prove. They are SQLITE-ONLY — `verify_integrity` has no cloud
// counterpart at all, so there is no second engine to plant anything on, and
// the specs that use them declare `parity: 'not-comparable'`.
//
// Each plant was measured before it was written
// (`scratchpad/local-core/probe-integrity1.mjs`): it must fire the check it is
// for, and every other check it fires is named in the spec that uses it.

/** A card, for the two ingest checks. `credit` is the schema's only card type. */
export const CARD = 'a0000000-0000-0000-0000-0000000000ca';
/** One row against it, provenance set or not depending on the plant. */
export const IMPORTED_ROW = '70000000-0000-0000-0000-0000000000f0';
/** The Transfer type root the base fixture seeds — a second To/From hangs here. */
export const TRANSFER_ROOT = 'c0000000-0000-0000-0000-000000000001';
/** Two audit rows, planted to break the chain between them. */
export const AUDIT_FIRST = 'e0000000-0000-0000-0000-000000000001';
export const AUDIT_SECOND = 'e0000000-0000-0000-0000-000000000002';

/** B-1, broken by one penny — the smallest lie a balance can tell. */
export const aBalanceThatIsOneOut = {
  sqlite: `UPDATE accounts SET balance_minor = balance_minor + 1 WHERE id = '${EVERYDAY}';`,
};

/** S-1: two lines that add up to less than their parent. */
export const aSplitThatDoesNotSum = {
  sqlite: `
    INSERT INTO _rpc_guard VALUES ('split');
    UPDATE transactions SET is_split = 1, category = '' WHERE id = '${CORNER_SHOP}';
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order) VALUES
      ('${LEG_LINE}',   '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -1000, 0),
      ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -1000, 1);
    DELETE FROM _rpc_guard;`,
};

/**
 * S-2: a split with ONE line, and that line summing exactly to the parent — so
 * `split_min_lines` fires alone and `split_sum` has nothing to say.
 */
export const aSplitWithOneLine = {
  sqlite: `
    INSERT INTO _rpc_guard VALUES ('split');
    UPDATE transactions SET is_split = 1, category = '' WHERE id = '${CORNER_SHOP}';
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order)
      VALUES ('${LEG_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -2500, 0);
    DELETE FROM _rpc_guard;`,
};

/** S-3: a line hanging off a row that is not split at all. */
export const linesOnARowThatIsNotSplit = {
  sqlite: `
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order)
      VALUES ('${LEG_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -2500, 0);`,
};

/** T-1: one side names the other and is not named back. Amounts opposite, so T-2 stays quiet. */
export const aLinkNobodyReturns = {
  sqlite: `
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              transfer_account_id) VALUES
      ('${OTHER_LEG}', '${USER}', '${EVERYDAY}',  'To savings',    -1500, 'transfer', '2024-04-01', '${RAINY_DAY}'),
      ('${THIS_LEG}',  '${USER}', '${RAINY_DAY}', 'From everyday',  1500, 'transfer', '2024-04-01', '${EVERYDAY}');
    UPDATE accounts SET balance_minor = balance_minor - 1500 WHERE id = '${EVERYDAY}';
    UPDATE accounts SET balance_minor = balance_minor + 1500 WHERE id = '${RAINY_DAY}';
    UPDATE transactions SET linked_transfer_id = '${THIS_LEG}' WHERE id = '${OTHER_LEG}';`,
};

/**
 * T-2: a mutual pair whose amounts are not opposites.
 *
 * It fires TWICE — once per side — because the check reads every row that names
 * another and compares. That is the honest answer: both rows are wrong about the
 * same movement, and a report naming one of them would leave the other looking
 * innocent.
 */
export const linkedSidesThatAreNotOpposites = {
  sqlite: `
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              transfer_account_id) VALUES
      ('${OTHER_LEG}', '${USER}', '${EVERYDAY}',  'To savings',    -1500, 'transfer', '2024-04-01', '${RAINY_DAY}'),
      ('${THIS_LEG}',  '${USER}', '${RAINY_DAY}', 'From everyday',  2000, 'transfer', '2024-04-01', '${EVERYDAY}');
    UPDATE accounts SET balance_minor = balance_minor - 1500 WHERE id = '${EVERYDAY}';
    UPDATE accounts SET balance_minor = balance_minor + 2000 WHERE id = '${RAINY_DAY}';
    UPDATE transactions SET linked_transfer_id = '${THIS_LEG}'  WHERE id = '${OTHER_LEG}';
    UPDATE transactions SET linked_transfer_id = '${OTHER_LEG}' WHERE id = '${THIS_LEG}';`,
};

/**
 * A LINKED pair straddling a currency boundary, for the T-2 integrity check.
 *
 * The companion to `convertedRows`, one step further on: these two are already
 * joined, which is the state the file is in after a link or after the MS Money
 * importer has written a pair directly. −30.00 GBP out of Everyday against
 * whatever arrived in Dollars.
 *
 * T-2 has to move with the verb or the two contradict: a check that calls
 * every converted pair "money appearing from nowhere" reports the whole of a
 * real ledger as broken, and a violation report nobody can act on is a
 * violation report nobody reads.
 *
 * @param {{minor: number}} destination what arrived in Dollars, in minor units
 */
export const linkedSidesInTwoCurrencies = (destination) => ({
  sqlite: `
    INSERT INTO accounts (id, user_id, name, type, currency, balance_minor, initial_balance_minor)
      VALUES ('${DOLLARS}', '${USER}', 'Dollars', 'checking', 'USD', 0, 0);
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              transfer_account_id) VALUES
      ('${OTHER_LEG}', '${USER}', '${EVERYDAY}', 'To dollars',    -3000, 'transfer', '2024-04-01', '${DOLLARS}'),
      ('${THIS_LEG}',  '${USER}', '${DOLLARS}',  'From everyday', ${destination.minor}, 'transfer', '2024-04-01', '${EVERYDAY}');
    UPDATE accounts SET balance_minor = balance_minor - 3000 WHERE id = '${EVERYDAY}';
    UPDATE accounts SET balance_minor = balance_minor + ${destination.minor} WHERE id = '${DOLLARS}';
    UPDATE transactions SET linked_transfer_id = '${THIS_LEG}'  WHERE id = '${OTHER_LEG}';
    UPDATE transactions SET linked_transfer_id = '${OTHER_LEG}' WHERE id = '${THIS_LEG}';`,
});

/**
 * T-3: both sides of one transfer sitting in the same account.
 *
 * `transactions_transfer_two_accounts` forbids a row pointing at its OWN
 * account, so both rows point at a third one — which is the only shape the
 * schema will hold, and exactly the shape a bad import produces.
 */
export const bothSidesInOneAccount = {
  sqlite: `
    INSERT INTO accounts (id, user_id, name, type, balance_minor, initial_balance_minor)
      VALUES ('${HOLIDAY_FUND}', '${USER}', 'Holiday fund', 'savings', 0, 0);
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              transfer_account_id) VALUES
      ('${OTHER_LEG}', '${USER}', '${EVERYDAY}', 'Out', -1000, 'transfer', '2024-04-01', '${HOLIDAY_FUND}'),
      ('${THIS_LEG}',  '${USER}', '${EVERYDAY}', 'In',   1000, 'transfer', '2024-04-01', '${HOLIDAY_FUND}');
    UPDATE transactions SET linked_transfer_id = '${THIS_LEG}'  WHERE id = '${OTHER_LEG}';
    UPDATE transactions SET linked_transfer_id = '${OTHER_LEG}' WHERE id = '${THIS_LEG}';`,
};

/** T-4: a leg and its counterpart that do not cancel — compared against the LINE. */
export const aLegAndACounterpartThatDisagree = {
  sqlite: `
    INSERT INTO _rpc_guard VALUES ('split');
    UPDATE transactions SET is_split = 1, category = '' WHERE id = '${CORNER_SHOP}';
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              transfer_account_id)
      VALUES ('${LEG_COUNTERPART}', '${USER}', '${RAINY_DAY}', 'Counterpart', 2000, 'transfer',
              '2024-03-01', '${EVERYDAY}');
    UPDATE accounts SET balance_minor = balance_minor + 2000 WHERE id = '${RAINY_DAY}';
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order,
                                    transfer_account_id, linked_transfer_id)
      VALUES ('${LEG_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -1500, 0,
              '${RAINY_DAY}', '${LEG_COUNTERPART}');
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order)
      VALUES ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -1000, 1);
    UPDATE transactions SET linked_transfer_split_id = '${LEG_LINE}' WHERE id = '${LEG_COUNTERPART}';
    DELETE FROM _rpc_guard;`,
};

/** T-5: a counterpart naming a split line that does not name it back. */
export const aCounterpartTheLineIgnores = {
  sqlite: `
    INSERT INTO _rpc_guard VALUES ('split');
    UPDATE transactions SET is_split = 1, category = '' WHERE id = '${CORNER_SHOP}';
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              transfer_account_id)
      VALUES ('${LEG_COUNTERPART}', '${USER}', '${RAINY_DAY}', 'Counterpart', 1500, 'transfer',
              '2024-03-01', '${EVERYDAY}');
    UPDATE accounts SET balance_minor = balance_minor + 1500 WHERE id = '${RAINY_DAY}';
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order) VALUES
      ('${LEG_LINE}',   '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -1500, 0),
      ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}', -1000, 1);
    UPDATE transactions SET linked_transfer_split_id = '${LEG_LINE}' WHERE id = '${LEG_COUNTERPART}';
    DELETE FROM _rpc_guard;`,
};

/** The id no category in this file has. */
export const NO_SUCH_CATEGORY = 'c0000000-0000-0000-0000-0000000000ff';

/** R-3: a transaction filed under a category id nothing answers to. */
export const aTransactionFiledUnderNothing = {
  sqlite: `UPDATE transactions SET category = '${NO_SUCH_CATEGORY}' WHERE id = '${CORNER_SHOP}';`,
};

/** R-3, the legacy sentinel — a legal value, and the control for the check above. */
export const aTransactionFiledUnderTheSentinel = {
  sqlite: `UPDATE transactions SET category = 'transfer-out' WHERE id = '${CORNER_SHOP}';`,
};

/** R-3 for a split LINE, whose category has no sentinel exemption at all. */
export const aSplitLineFiledUnderNothing = {
  sqlite: `
    INSERT INTO _rpc_guard VALUES ('split');
    UPDATE transactions SET is_split = 1, category = '' WHERE id = '${CORNER_SHOP}';
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, sort_order) VALUES
      ('${LEG_LINE}',   '${CORNER_SHOP}', '${USER}', '${NO_SUCH_CATEGORY}', -1500, 0),
      ('${PLAIN_LINE}', '${CORNER_SHOP}', '${USER}', '${WEEKLY_SHOP}',      -1000, 1);
    DELETE FROM _rpc_guard;`,
};

/** C-3, the second one: a second To/From category for an account that has one. */
export const aSecondToFromCategory = {
  sqlite: `
    INSERT INTO categories (id, user_id, name, type, level, parent_id, is_transfer_category, account_id)
      VALUES ('${NO_SUCH_CATEGORY}', '${USER}', 'To/From Everyday (again)', 'both', 'detail',
              '${TRANSFER_ROOT}', 1, '${EVERYDAY}');`,
};

/** A-1: two audit rows where the second does not carry the first's hash. */
export const anAuditChainThatDoesNotChain = {
  sqlite: `
    INSERT INTO financial_audit_log (id, user_id, entity, entity_id, action, after_data, seq, prev_hash, row_hash)
      VALUES ('${AUDIT_FIRST}', '${USER}', 'transaction', '${CORNER_SHOP}', 'create', '{}', 1, NULL, 'aaaa');
    INSERT INTO financial_audit_log (id, user_id, entity, entity_id, action, after_data, seq, prev_hash, row_hash)
      VALUES ('${AUDIT_SECOND}', '${USER}', 'transaction', '${CORNER_SHOP}', 'create', '{}', 2, 'not-aaaa', 'bbbb');`,
};

/** A-1, the other half: a hole where a sequence number should be. */
export const anAuditChainWithAHoleInIt = {
  sqlite: `
    INSERT INTO financial_audit_log (id, user_id, entity, entity_id, action, after_data, seq, prev_hash, row_hash)
      VALUES ('${AUDIT_FIRST}', '${USER}', 'transaction', '${CORNER_SHOP}', 'create', '{}', 1, NULL, 'aaaa');
    INSERT INTO financial_audit_log (id, user_id, entity, entity_id, action, after_data, seq, prev_hash, row_hash)
      VALUES ('${AUDIT_SECOND}', '${USER}', 'transaction', '${CORNER_SHOP}', 'create', '{}', 3, 'aaaa', 'cccc');`,
};

/** I-1: three accounts in a chain, so the middle one is nested AND a parent. */
export const anAccountNestedTwoDeep = {
  sqlite: `
    INSERT INTO accounts (id, user_id, name, type, balance_minor, initial_balance_minor)
      VALUES ('${HOLIDAY_FUND}', '${USER}', 'Holiday fund', 'savings', 0, 0);
    UPDATE accounts SET parent_account_id = '${EVERYDAY}'   WHERE id = '${RAINY_DAY}';
    UPDATE accounts SET parent_account_id = '${RAINY_DAY}'  WHERE id = '${HOLIDAY_FUND}';`,
};

/** INGEST-1: a card in credit whose rows came out of a file. */
export const aCardWhoseSignsWereInverted = {
  sqlite: `
    INSERT INTO accounts (id, user_id, name, type, balance_minor, initial_balance_minor)
      VALUES ('${CARD}', '${USER}', 'Card', 'credit', 5000, 0);
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              import_source, import_source_id)
      VALUES ('${IMPORTED_ROW}', '${USER}', '${CARD}', 'Shop', 5000, 'income', '2024-04-01', 'ofx', 'ofx-1');`,
};

/** INGEST-1's control: the same balance, typed in by a person. */
export const aCardInCreditNobodyImported = {
  sqlite: `
    INSERT INTO accounts (id, user_id, name, type, balance_minor, initial_balance_minor)
      VALUES ('${CARD}', '${USER}', 'Card', 'credit', 5000, 0);
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date)
      VALUES ('${IMPORTED_ROW}', '${USER}', '${CARD}', 'Refund', 5000, 'income', '2024-04-01');`,
};

/** INGEST-2: remaining credit stored where the bank's own figure belongs. */
export const anAvailableBalanceStoredAsABankBalance = {
  sqlite: `
    INSERT INTO accounts (id, user_id, name, type, balance_minor, initial_balance_minor,
                          bank_balance_minor, bank_balance_date)
      VALUES ('${CARD}', '${USER}', 'Card', 'credit', -1000, 0, 400000, '2024-04-01');
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date)
      VALUES ('${IMPORTED_ROW}', '${USER}', '${CARD}', 'Shop', -1000, 'expense', '2024-04-01');`,
};

/** INGEST-2's control: a card and a bank that agree. */
export const aBankBalanceThatAgrees = {
  sqlite: `
    INSERT INTO accounts (id, user_id, name, type, balance_minor, initial_balance_minor,
                          bank_balance_minor, bank_balance_date)
      VALUES ('${CARD}', '${USER}', 'Card', 'credit', -1000, 0, -1000, '2024-04-01');
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date)
      VALUES ('${IMPORTED_ROW}', '${USER}', '${CARD}', 'Shop', -1000, 'expense', '2024-04-01');`,
};

/** The file's own one-line verdict, which must agree with the verb's. */
export function integrityOk(expect) {
  return {
    name: 'v_integrity_ok',
    sqlite: "SELECT CASE WHEN (SELECT ok FROM v_integrity_ok) = 1 THEN 'ok' ELSE 'not-ok' END",
    expect,
  };
}

/** How many rows the view reports, of either severity. */
export function violationRows(expect) {
  return {
    name: 'rows_in_the_view',
    sqlite: 'SELECT COUNT(*) FROM v_integrity_violations',
    expect,
  };
}

// ── The ingest pair's fixtures ─────────────────────────────────────────────
//
// Two verbs, two shapes of starting state, and one rule they share with every
// other fragment in this file: B-1 holds BEFORE the verb runs, so a spec that
// asserts the identity afterwards is asserting the verb rather than the
// fixture.

/** The account a bank feed created. */
export const FED = 'a0000000-0000-0000-0000-0000000000fe';
/** A second account of the same login, for the user-scoped-index specs. */
export const SECOND_ACCOUNT = 'a0000000-0000-0000-0000-00000000000c';
/** A row already imported from a file, under a stated key. */
export const ALREADY_IMPORTED = '70000000-0000-0000-0000-0000000000d1';
/** A row the feed already wrote. */
export const ALREADY_FED = '70000000-0000-0000-0000-0000000000d2';
/** Two ordinary expense leaves, for payee memory to choose between. */
export const GROCERIES = 'c0000000-0000-0000-0000-0000000000e4';
export const FUEL = 'c0000000-0000-0000-0000-0000000000e5';

/** A second account belonging to this login, empty. */
export const secondAccount = {
  sqlite: `
    INSERT INTO accounts (id, user_id, name, type, balance_minor, initial_balance_minor)
      VALUES ('${SECOND_ACCOUNT}', '${USER}', 'Second', 'checking', 0, 0);`,
  postgres: `
    INSERT INTO public.accounts (id, user_id, name, type, balance, initial_balance)
      VALUES ('${SECOND_ACCOUNT}', '${USER}', 'Second', 'checking', 0.00, 0.00);`,
};

/**
 * A −4.25 row already imported under `ofx` / `fitid:1`, with the balance moved.
 *
 * Everyday ends at −29.25. This is what a chunk that has already been POSTed
 * looks like from the database's side, which is the whole subject of
 * 20260808140000: the browser cannot tell a lost response from a lost request.
 */
export const anAlreadyImportedRow = {
  sqlite: `
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              import_source, import_source_id)
      VALUES ('${ALREADY_IMPORTED}', '${USER}', '${EVERYDAY}', 'Coffee', -425, 'expense', '2024-05-01',
              'ofx', 'fitid:1');
    UPDATE accounts SET balance_minor = balance_minor - 425 WHERE id = '${EVERYDAY}';`,
  postgres: `
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date,
                                     import_source, import_source_id)
      VALUES ('${ALREADY_IMPORTED}', '${USER}', '${EVERYDAY}', 'Coffee', -4.25, 'expense', '2024-05-01',
              'ofx', 'fitid:1');
    UPDATE public.accounts SET balance = balance - 4.25 WHERE id = '${EVERYDAY}';`,
};

/**
 * An account seeded the way `api/banking/sync-accounts.ts:255-273` seeds one:
 * `balance = bank_balance = initial_balance = the snapshot`, and no history.
 *
 * That is TS-F7's precondition, and B-1 holds on it (Σ is zero), which is
 * exactly why the shortfall it describes is invisible until you ask what
 * `initial_balance` is supposed to MEAN.
 */
export const aFeedCreatedAccount = {
  sqlite: `
    INSERT INTO accounts (id, user_id, name, type, balance_minor, initial_balance_minor,
                          bank_balance_minor, bank_balance_date)
      VALUES ('${FED}', '${USER}', 'Fed account', 'checking', 10000, 10000, 10000, '2024-05-01');`,
  postgres: `
    INSERT INTO public.accounts (id, user_id, name, type, balance, initial_balance,
                                 bank_balance, bank_balance_date)
      VALUES ('${FED}', '${USER}', 'Fed account', 'checking', 100.00, 100.00, 100.00, '2024-05-01');`,
};

/** The same account, no longer on its first import: one feed row already in it. */
export const aFeedAccountWithHistory = {
  sqlite: `${aFeedCreatedAccount.sqlite}
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              external_transaction_id, external_provider)
      VALUES ('${ALREADY_FED}', '${USER}', '${FED}', 'Old feed row', -1000, 'expense', '2024-01-01',
              'old-1', 'truelayer');
    UPDATE accounts SET initial_balance_minor = initial_balance_minor + 1000 WHERE id = '${FED}';`,
  postgres: `${aFeedCreatedAccount.postgres}
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date,
                                     external_transaction_id, external_provider)
      VALUES ('${ALREADY_FED}', '${USER}', '${FED}', 'Old feed row', -10.00, 'expense', '2024-01-01',
              'old-1', 'truelayer');
    UPDATE public.accounts SET initial_balance = initial_balance + 10.00 WHERE id = '${FED}';`,
};

/** The same account with a FILE-imported row in it, which is not feed history. */
export const aFeedAccountWithAFileImport = {
  sqlite: `${aFeedCreatedAccount.sqlite}
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              import_source, import_source_id)
      VALUES ('${ALREADY_IMPORTED}', '${USER}', '${FED}', 'Filed', -500, 'expense', '2024-01-01',
              'ofx', 'ofx-9');
    UPDATE accounts SET initial_balance_minor = initial_balance_minor + 500 WHERE id = '${FED}';`,
  postgres: `${aFeedCreatedAccount.postgres}
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date,
                                     import_source, import_source_id)
      VALUES ('${ALREADY_IMPORTED}', '${USER}', '${FED}', 'Filed', -5.00, 'expense', '2024-01-01',
              'ofx', 'ofx-9');
    UPDATE public.accounts SET initial_balance = initial_balance + 5.00 WHERE id = '${FED}';`,
};

/** Two expense leaves under Outgoings, for payee memory to choose between. */
export const twoFilingChoices = {
  sqlite: `
    INSERT INTO categories (id, user_id, name, type, level, parent_id) VALUES
      ('${GROCERIES}', '${USER}', 'Groceries', 'expense', 'detail', '${OUTGOINGS}'),
      ('${FUEL}',      '${USER}', 'Fuel',      'expense', 'detail', '${OUTGOINGS}');`,
  postgres: `
    INSERT INTO public.categories (id, user_id, name, type, level, parent_id) VALUES
      ('${GROCERIES}', '${USER}', 'Groceries', 'expense', 'detail', '${OUTGOINGS}'),
      ('${FUEL}',      '${USER}', 'Fuel',      'expense', 'detail', '${OUTGOINGS}');`,
};

/**
 * A payee history in the FED account: two rows filed under Groceries and a
 * LATER one under Fuel.
 *
 * The shape 20260722140000 was written for — "file one Amazon order as
 * Household : Repairs and every subsequent Amazon import inherits Repairs,
 * however many dozens of Consumables rows preceded it". Most-recent picks Fuel;
 * most-common picks Groceries.
 */
export function aPayeeHistory(payee = 'BIG SHOP') {
  const rows = [
    ['70000000-0000-0000-0000-0000000000c1', -1000, '2024-01-01', GROCERIES],
    ['70000000-0000-0000-0000-0000000000c2', -1100, '2024-02-01', GROCERIES],
    ['70000000-0000-0000-0000-0000000000c3', -1200, '2024-03-01', FUEL],
  ];
  const total = rows.reduce((sum, [, minor]) => sum + minor, 0);
  return {
    sqlite: `${twoFilingChoices.sqlite}
      INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date, category) VALUES
        ${rows.map(([id, minor, date, category]) =>
          `('${id}', '${USER}', '${FED}', '${payee}', ${minor}, 'expense', '${date}', '${category}')`).join(',\n        ')};
      UPDATE accounts SET initial_balance_minor = initial_balance_minor - (${total}) WHERE id = '${FED}';`,
    postgres: `${twoFilingChoices.postgres}
      INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date, category) VALUES
        ${rows.map(([id, minor, date, category]) =>
          `('${id}', '${USER}', '${FED}', '${payee}', ${(minor / 100).toFixed(2)}, 'expense', '${date}', '${category}')`).join(',\n        ')};
      UPDATE public.accounts SET initial_balance = initial_balance - (${(total / 100).toFixed(2)}) WHERE id = '${FED}';`,
  };
}

/**
 * One row under each category, SAME count, different dates — the tie the cloud
 * breaks on `MAX(date)`.
 */
export const aPayeeTiedOnCount = {
  sqlite: `${twoFilingChoices.sqlite}
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date, category) VALUES
      ('70000000-0000-0000-0000-0000000000c1', '${USER}', '${FED}', 'BIG SHOP', -1000, 'expense', '2024-01-01', '${GROCERIES}'),
      ('70000000-0000-0000-0000-0000000000c2', '${USER}', '${FED}', 'BIG SHOP', -1100, 'expense', '2024-02-01', '${FUEL}');
    UPDATE accounts SET initial_balance_minor = initial_balance_minor + 2100 WHERE id = '${FED}';`,
  postgres: `${twoFilingChoices.postgres}
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date, category) VALUES
      ('70000000-0000-0000-0000-0000000000c1', '${USER}', '${FED}', 'BIG SHOP', -10.00, 'expense', '2024-01-01', '${GROCERIES}'),
      ('70000000-0000-0000-0000-0000000000c2', '${USER}', '${FED}', 'BIG SHOP', -11.00, 'expense', '2024-02-01', '${FUEL}');
    UPDATE public.accounts SET initial_balance = initial_balance + 21.00 WHERE id = '${FED}';`,
};

/**
 * Same count, same date, DIFFERENT `created_at` — the last tie-break the cloud
 * actually states. Below this there is no rule at all, which is why no spec
 * goes further down; see import_bank_transactions.rs.
 */
export const aPayeeTiedOnDate = {
  sqlite: `${twoFilingChoices.sqlite}
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date, category, created_at) VALUES
      ('70000000-0000-0000-0000-0000000000c1', '${USER}', '${FED}', 'BIG SHOP', -1000, 'expense', '2024-01-01', '${GROCERIES}', '2021-01-01T00:00:00.000Z'),
      ('70000000-0000-0000-0000-0000000000c2', '${USER}', '${FED}', 'BIG SHOP', -1100, 'expense', '2024-01-01', '${FUEL}',      '2020-01-01T00:00:00.000Z');
    UPDATE accounts SET initial_balance_minor = initial_balance_minor + 2100 WHERE id = '${FED}';`,
  postgres: `${twoFilingChoices.postgres}
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date, category, created_at) VALUES
      ('70000000-0000-0000-0000-0000000000c1', '${USER}', '${FED}', 'BIG SHOP', -10.00, 'expense', '2024-01-01', '${GROCERIES}', '2021-01-01T00:00:00Z'),
      ('70000000-0000-0000-0000-0000000000c2', '${USER}', '${FED}', 'BIG SHOP', -11.00, 'expense', '2024-01-01', '${FUEL}',      '2020-01-01T00:00:00Z');
    UPDATE public.accounts SET initial_balance = initial_balance + 21.00 WHERE id = '${FED}';`,
};

/** A stranger's account that already holds the provider id a sync is about to offer. */
export const aStrangersFedAccount = {
  sqlite: `${secondUser.sqlite}
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              external_transaction_id)
      VALUES ('${ALREADY_FED}', '${STRANGER}', '${SOMEONE_ELSES_ACCOUNT}', 'Theirs', -100, 'expense', '2024-01-01', 'n-1');
    UPDATE accounts SET initial_balance_minor = initial_balance_minor + 100 WHERE id = '${SOMEONE_ELSES_ACCOUNT}';`,
  postgres: `${secondUser.postgres}
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date,
                                     external_transaction_id)
      VALUES ('${ALREADY_FED}', '${STRANGER}', '${SOMEONE_ELSES_ACCOUNT}', 'Theirs', -1.00, 'expense', '2024-01-01', 'n-1');
    UPDATE public.accounts SET initial_balance = initial_balance + 1.00 WHERE id = '${SOMEONE_ELSES_ACCOUNT}';`,
};

// ── Assertions the ingest specs share ──────────────────────────────────────

/**
 * How a row that arrived through an import is filed, as one canonical string:
 * `category-name | confirmed=yes/no | cleared=yes/no | seq=<n>`.
 *
 * Found by DESCRIPTION rather than by id, because neither engine's import path
 * lets a caller name the row's id — the RPC mints it — so there is no id a spec
 * could assert on. The category is rendered by NAME for the reason `splitLines`
 * gives: an id says nothing to a reader and a To/From id is unknowable.
 */
export function importedRow(description, expect) {
  const shape = (engine) => {
    const category = engine === 'sqlite'
      ? `COALESCE((SELECT c.name FROM categories c WHERE c.id = t.category), COALESCE(t.category, '-'))`
      : `COALESCE((SELECT c.name FROM public.categories c WHERE c.id::text = t.category), COALESCE(t.category, '-'))`;
    const flag = (column) => (engine === 'sqlite'
      ? `CASE WHEN t.${column} = 1 THEN 'yes' ELSE 'no' END`
      : `CASE WHEN t.${column} THEN 'yes' ELSE 'no' END`);
    return `${category} || ' | confirmed=' || ${flag('category_confirmed')}
              || ' | cleared=' || ${flag('is_cleared')}
              || ' | seq=' || COALESCE(CAST(t.statement_sequence AS TEXT), '-')`;
  };
  const table = (engine) => (engine === 'sqlite' ? 'transactions' : 'public.transactions');
  return {
    name: `imported_row_${description.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
    sqlite: `SELECT COALESCE((SELECT ${shape('sqlite')} FROM ${table('sqlite')} t
               WHERE t.description = '${description}'), 'ABSENT')`,
    postgres: `SELECT COALESCE((SELECT ${shape('postgres')} FROM ${table('postgres')} t
                 WHERE t.description = '${description}'), 'ABSENT')`,
    expect,
  };
}

/** The provenance one imported row carries, as `[source][id]`. */
export function importProvenance(description, expect) {
  const shape = `'[' || COALESCE(import_source, '-') || '][' || COALESCE(import_source_id, '-') || ']'`;
  return {
    name: `import_provenance_${description.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
    sqlite: `SELECT COALESCE((SELECT ${shape} FROM transactions WHERE description = '${description}'), 'ABSENT')`,
    postgres: `SELECT COALESCE((SELECT ${shape} FROM public.transactions WHERE description = '${description}'), 'ABSENT')`,
    expect,
  };
}

/** `category`/`notes` on an imported row, with EMPTY kept apart from NULL. */
export function importedText(description, column, expect) {
  const wrap = (cast) => `CASE WHEN ${cast} IS NULL THEN 'NULL'
                              WHEN ${cast} = '' THEN 'EMPTY' ELSE ${cast} END`;
  return {
    name: `imported_${column}_${description.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
    sqlite: `SELECT COALESCE((SELECT ${wrap(column)} FROM transactions
               WHERE description = '${description}'), 'ABSENT')`,
    postgres: `SELECT COALESCE((SELECT ${wrap(`${column}::text`)} FROM public.transactions
                 WHERE description = '${description}'), 'ABSENT')`,
    expect,
  };
}

/**
 * The audit rows one call wrote, as `entity/action` × count, in the order the
 * writes happened.
 *
 * `auditShape` sorts by `entity, action`, which is right for a verb that writes
 * one of each and wrong here: an import writes N transaction rows and then one
 * account row, and "did the account movement come last" is part of the contract.
 * Ordered by the audit table's own insertion order on both engines — `seq`
 * locally, `ctid` on the cloud, which has no sequence column.
 */
export function auditTrail(expect) {
  return {
    name: 'audit_trail',
    sqlite: `SELECT COALESCE((SELECT group_concat(entry, ',') FROM (
               SELECT entity || '/' || action AS entry
                 FROM financial_audit_log ORDER BY seq)), 'NONE')`,
    postgres: `SELECT COALESCE((SELECT string_agg(entity || '/' || action, ',' ORDER BY ctid)
                 FROM public.financial_audit_log), 'NONE')`,
    expect,
  };
}

/** Which accounts got an `account/update` audit row, in write order. */
export function accountsAudited(expect) {
  return {
    name: 'accounts_audited',
    sqlite: `SELECT COALESCE((SELECT group_concat(tail, ',') FROM (
               SELECT substr(entity_id, -4) AS tail FROM financial_audit_log
                WHERE entity = 'account' ORDER BY seq)), 'NONE')`,
    postgres: `SELECT COALESCE((SELECT string_agg(right(entity_id::text, 4), ',' ORDER BY ctid)
                 FROM public.financial_audit_log WHERE entity = 'account'), 'NONE')`,
    expect,
  };
}

/**
 * How a FEED row was filed, found by the provider's own id.
 *
 * The feed specs cannot use [`importedRow`], which finds a row by description:
 * a payee-memory fixture deliberately gives the incoming row the SAME
 * description as the history that teaches it, so a description lookup would
 * match four rows and the subquery would fail rather than assert. The provider
 * id is the one thing that is unique to the row under test.
 */
export function fedRow(externalId, expect) {
  const shape = (engine) => {
    const category = engine === 'sqlite'
      ? `COALESCE((SELECT c.name FROM categories c WHERE c.id = t.category), COALESCE(t.category, '-'))`
      : `COALESCE((SELECT c.name FROM public.categories c WHERE c.id::text = t.category), COALESCE(t.category, '-'))`;
    const flag = (column) => (engine === 'sqlite'
      ? `CASE WHEN t.${column} = 1 THEN 'yes' ELSE 'no' END`
      : `CASE WHEN t.${column} THEN 'yes' ELSE 'no' END`);
    return `${category} || ' | confirmed=' || ${flag('category_confirmed')} || ' | cleared=' || ${flag('is_cleared')}`;
  };
  return {
    name: `fed_row_${externalId.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
    sqlite: `SELECT COALESCE((SELECT ${shape('sqlite')} FROM transactions t
               WHERE t.external_transaction_id = '${externalId}'), 'ABSENT')`,
    postgres: `SELECT COALESCE((SELECT ${shape('postgres')} FROM public.transactions t
                 WHERE t.external_transaction_id = '${externalId}'), 'ABSENT')`,
    expect,
  };
}

// ── The reads' fixtures ────────────────────────────────────────────────────
//
// A read spec asserts the WHOLE row of everything it gets back, which means two
// things every other family here could ignore:
//
//  1. **Every timestamp has to be pinned.** `created_at` and `updated_at`
//     default to "now" on both engines, and the two nows are two clocks in two
//     processes: left alone, every read spec would compare '…04:43:49.862Z'
//     against '…04:43:50.117Z' and fail on a difference that means nothing. Pin
//     them and the comparison is about the columns that carry meaning.
//  2. **Every sort key has to be DISTINCT.** The Rust side breaks a tie with
//     `id` and the Postgres oracle deliberately does not (a tie-break the cloud
//     never stated must not be transcribed into its own oracle), so a fixture
//     that ties is a fixture whose two answers may legitimately differ. The
//     tie-break has its own proof in `crates/wealth-core/tests/reads.rs`.
//
// A `load_boot` spec has to obey BOTH RULES ON ALL SIX LISTS AT ONCE, and that
// is not a detail of writing one — it is what the composite is for. The runner
// compares every key of the answer, whether or not the spec asserts it, so a
// boot spec that pins only the table it is about fails on the ones it is not:
// unpinned accounts differ by a millisecond, and the two To/From categories are
// minted by a TRIGGER with a generated id on each engine, so they differ always.
// MEASURED, by writing four such specs and watching them go MISDECLARED:
// `namedTransferCategories` and BOTH pinning fragments belong in every one, and
// the fragment order is the usual one — whatever moves a row goes before the pin
// that fixes its timestamp.
//
// This is a feature rather than a tax. A composite that quietly re-ordered the
// accounts nobody's spec was looking at, or lost a login's scoping on the one
// list that spec ignored, is caught by the spec next door.

/** The instant Everyday was opened; Rainy day is a day later. */
export const OPENED_FIRST = '2024-01-01T00:00:00.000Z';
export const OPENED_SECOND = '2024-01-02T00:00:00.000Z';
/** The instant every category in the fixture was named. */
export const NAMED_AT = '2024-01-03T00:00:00.000Z';

/**
 * Fixed `created_at`/`updated_at` on the base fixture's accounts and
 * categories.
 *
 * THE TWO HALVES ARE NOT SYMMETRIC, and the asymmetry is the engines':
 *
 * * locally, `trg_accounts_updated_at` fires only `WHEN NEW.updated_at IS
 *   OLD.updated_at` — naming the column stands the trigger down, which is the
 *   same mechanism every write verb relies on;
 * * in the cloud, `update_updated_at_column` ASSIGNS `NEW.updated_at = NOW()`
 *   unconditionally unless `app.restore_in_progress` is set, so the flag has to
 *   be raised or the pin is silently overwritten by the trigger.
 *
 * Categories are pinned LAST on purpose: an UPDATE of an account fires the
 * cloud's `sync_transfer_category_on_account_update` (no column list there, one
 * `AFTER UPDATE` for the whole row), and anything that touches a category bumps
 * its timestamp again.
 */
export const pinnedReadTimes = {
  sqlite: `
    UPDATE accounts SET created_at = '${OPENED_FIRST}', updated_at = '${OPENED_FIRST}'
     WHERE id = '${EVERYDAY}';
    UPDATE accounts SET created_at = '${OPENED_SECOND}', updated_at = '${OPENED_SECOND}'
     WHERE id = '${RAINY_DAY}';
    UPDATE categories SET created_at = '${NAMED_AT}', updated_at = '${NAMED_AT}'
     WHERE user_id = '${USER}';`,
  postgres: `
    SELECT set_config('app.restore_in_progress', '1', true);
    UPDATE public.accounts SET created_at = '${OPENED_FIRST}', updated_at = '${OPENED_FIRST}'
     WHERE id = '${EVERYDAY}';
    UPDATE public.accounts SET created_at = '${OPENED_SECOND}', updated_at = '${OPENED_SECOND}'
     WHERE id = '${RAINY_DAY}';
    UPDATE public.categories SET created_at = '${NAMED_AT}', updated_at = '${NAMED_AT}'
     WHERE user_id = '${USER}';
    SELECT set_config('app.restore_in_progress', '0', true);`,
};

/**
 * Rainy day, closed — the Microsoft Money model: the account leaves the pickers
 * and every transaction stays exactly where it is.
 *
 * Applied BEFORE [`pinnedReadTimes`], because closing an account is an UPDATE
 * and both engines stamp `updated_at` for one.
 */
export const closedRainyDay = {
  sqlite: `UPDATE accounts SET is_active = 0 WHERE id = '${RAINY_DAY}';`,
  postgres: `UPDATE public.accounts SET is_active = false WHERE id = '${RAINY_DAY}';`,
};

/**
 * Everyday, with every optional figure on an account filled in.
 *
 * Four money columns and four date columns, none of which the base fixture
 * exercises: on a bare account they are all NULL, and NULL is the one value
 * that cannot tell a working conversion from a missing one.
 */
export const accountWithEveryFigure = {
  sqlite: `
    UPDATE accounts SET
      initial_balance_minor = -1000,
      bank_balance_minor = 12345,
      bank_balance_date = '2024-02-29',
      last_reconciled_date = '2024-02-01',
      low_balance_alert_enabled = 1,
      low_balance_threshold_minor = -5000,
      opening_balance_date = '2023-12-31',
      archive_through_date = '2023-06-30',
      institution = 'A Bank',
      account_number = '12345678',
      sort_code = '00-00-00',
      icon = 'wallet',
      color = '#123456',
      notes = 'the everyday one',
      currency = 'GBP',
      metadata = '{"k":1}'
     WHERE id = '${EVERYDAY}';
    UPDATE transactions SET amount_minor = -1500 WHERE id = '${CORNER_SHOP}';`,
  postgres: `
    UPDATE public.accounts SET
      initial_balance = -10.00,
      bank_balance = 123.45,
      bank_balance_date = '2024-02-29',
      last_reconciled_date = '2024-02-01',
      low_balance_alert_enabled = true,
      low_balance_threshold = -50.00,
      opening_balance_date = '2023-12-31',
      archive_through_date = '2023-06-30',
      institution = 'A Bank',
      account_number = '12345678',
      sort_code = '00-00-00',
      icon = 'wallet',
      color = '#123456',
      notes = 'the everyday one',
      currency = 'GBP',
      metadata = '{"k":1}'::jsonb
     WHERE id = '${EVERYDAY}';
    UPDATE public.transactions SET amount = -15.00 WHERE id = '${CORNER_SHOP}';`,
};

/** Two budgets: one paused, one live, a day apart, with different thresholds. */
export const FOOD_BUDGET = 'b0000000-0000-0000-0000-00000000b001';
export const FUEL_BUDGET = 'b0000000-0000-0000-0000-00000000b002';

export const twoBudgets = {
  sqlite: `
    INSERT INTO budgets (id, user_id, name, amount_minor, period, category, start_date,
                         end_date, spent_minor, rollover, rollover_amount_minor,
                         alert_threshold_bp, is_active, notes, created_at, updated_at) VALUES
      ('${FOOD_BUDGET}', '${USER}', 'Food', 12345, 'monthly', '${WEEKLY_SHOP}', '2024-01-01',
       '2024-12-31', 6789, 1, 250, 4250, 1, 'the food one', '${OPENED_FIRST}', '${OPENED_FIRST}'),
      ('${FUEL_BUDGET}', '${USER}', 'Fuel', 5000, 'weekly', NULL, '2024-02-01',
       NULL, 0, 0, 0, 8000, 0, NULL, '${OPENED_SECOND}', '${OPENED_SECOND}');`,
  postgres: `
    SELECT set_config('app.restore_in_progress', '1', true);
    INSERT INTO public.budgets (id, user_id, name, amount, period, category, start_date,
                                end_date, spent, rollover, rollover_amount,
                                alert_threshold, is_active, notes, created_at, updated_at) VALUES
      ('${FOOD_BUDGET}', '${USER}', 'Food', 123.45, 'monthly', '${WEEKLY_SHOP}', '2024-01-01',
       '2024-12-31', 67.89, true, 2.50, 42.50, true, 'the food one', '${OPENED_FIRST}', '${OPENED_FIRST}'),
      ('${FUEL_BUDGET}', '${USER}', 'Fuel', 50.00, 'weekly', NULL, '2024-02-01',
       NULL, 0.00, false, 0.00, 80.00, false, NULL, '${OPENED_SECOND}', '${OPENED_SECOND}');
    SELECT set_config('app.restore_in_progress', '0', true);`,
};

/** Two goals: one running, one finished, a day apart. */
export const HOLIDAY_GOAL = '90000000-0000-0000-0000-000000009001';
export const ROOF_GOAL = '90000000-0000-0000-0000-000000009002';

export const twoGoals = {
  sqlite: `
    INSERT INTO goals (id, user_id, name, description, target_amount_minor,
                       current_amount_minor, target_date, category, priority, status,
                       account_id, contribution_frequency, auto_contribute, icon, color,
                       completed_at, metadata, created_at, updated_at) VALUES
      ('${HOLIDAY_GOAL}', '${USER}', 'Holiday', 'somewhere warm', 250000, 12345, '2025-06-01',
       '${WEEKLY_SHOP}', 'high', 'active', '${RAINY_DAY}', 'monthly', 1, 'sun', '#ffcc00',
       NULL, '{"type":"savings"}', '${OPENED_FIRST}', '${OPENED_FIRST}'),
      ('${ROOF_GOAL}', '${USER}', 'New roof', NULL, 500000, 500000, NULL, NULL, NULL,
       'completed', NULL, NULL, 0, NULL, NULL, '2024-03-04T05:06:07.000Z', '{}',
       '${OPENED_SECOND}', '${OPENED_SECOND}');`,
  postgres: `
    SELECT set_config('app.restore_in_progress', '1', true);
    INSERT INTO public.goals (id, user_id, name, description, target_amount,
                              current_amount, target_date, category, priority, status,
                              account_id, contribution_frequency, auto_contribute, icon, color,
                              completed_at, metadata, created_at, updated_at) VALUES
      ('${HOLIDAY_GOAL}', '${USER}', 'Holiday', 'somewhere warm', 2500.00, 123.45, '2025-06-01',
       '${WEEKLY_SHOP}', 'high', 'active', '${RAINY_DAY}', 'monthly', true, 'sun', '#ffcc00',
       NULL, '{"type":"savings"}'::jsonb, '${OPENED_FIRST}', '${OPENED_FIRST}'),
      ('${ROOF_GOAL}', '${USER}', 'New roof', NULL, 5000.00, 5000.00, NULL, NULL, NULL,
       'completed', NULL, NULL, false, NULL, NULL, '2024-03-04T05:06:07.000Z', '{}'::jsonb,
       '${OPENED_SECOND}', '${OPENED_SECOND}');
    SELECT set_config('app.restore_in_progress', '0', true);`,
};

/**
 * Two dismissals a day apart, and a second transaction for the older one to
 * name.
 *
 * The extra row is zero-amount on purpose: a dismissal's subjects are foreign
 * keys to `transactions` locally, so the fixture has to have rows to point at,
 * and a zero amount adds one without moving a balance B-1 is asserted on.
 *
 * The newer dismissal names TWO rows, in an order that is not their id order —
 * `subject_ids` positions are ROLES (which row was the out and which the in),
 * so a reader that came back with a set would be answering a different
 * question.
 */
export const PAIR_DISMISSAL = 'd0000000-0000-0000-0000-0000000000d1';
export const STRANDED_DISMISSAL = 'd0000000-0000-0000-0000-0000000000d2';
export const SECOND_ROW = '70000000-0000-0000-0000-0000000000d9';
export const DISMISSED_FIRST = '2024-04-01T09:00:00.000Z';
export const DISMISSED_LATER = '2024-04-02T09:00:00.000Z';

export const twoDismissals = {
  sqlite: `
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date)
      VALUES ('${SECOND_ROW}', '${USER}', '${EVERYDAY}', 'Nothing at all', 0, 'expense', '2024-03-02');
    INSERT INTO suggestion_dismissals (id, user_id, kind, subject_key, dismissed_at) VALUES
      ('${STRANDED_DISMISSAL}', '${USER}', 'stranded', 'the stranded one', '${DISMISSED_FIRST}'),
      ('${PAIR_DISMISSAL}', '${USER}', 'transfer-pair', 'the pair', '${DISMISSED_LATER}');
    INSERT INTO suggestion_dismissal_subjects (dismissal_id, transaction_id, role_order) VALUES
      ('${STRANDED_DISMISSAL}', '${CORNER_SHOP}', 0),
      ('${PAIR_DISMISSAL}', '${SECOND_ROW}', 0),
      ('${PAIR_DISMISSAL}', '${CORNER_SHOP}', 1);`,
  postgres: `
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date)
      VALUES ('${SECOND_ROW}', '${USER}', '${EVERYDAY}', 'Nothing at all', 0.00, 'expense', '2024-03-02');
    INSERT INTO public.suggestion_dismissals (id, user_id, kind, subject_key, subject_ids, dismissed_at) VALUES
      ('${STRANDED_DISMISSAL}', '${USER}', 'stranded', 'the stranded one',
       ARRAY['${CORNER_SHOP}']::uuid[], '${DISMISSED_FIRST}'),
      ('${PAIR_DISMISSAL}', '${USER}', 'transfer-pair', 'the pair',
       ARRAY['${SECOND_ROW}','${CORNER_SHOP}']::uuid[], '${DISMISSED_LATER}');`,
};

/**
 * ONE subject key, refused under TWO kinds.
 *
 * Not a contrived pair. `20260806180000:41-46` says the case out loud: the same
 * two rows are a transfer pair to one scan and a duplicate to another, the
 * unique constraint carries `kind` so both can be on record at once, and
 * *"refusing one offer must not silently suppress the other, whose consequence
 * is completely different (linking two rows changes their filing; deleting one
 * destroys it)"*.
 *
 * Both dismissals name the same transaction, which is also the point: undoing
 * one must not take the other's subjects with it.
 */
export const AS_A_PAIR = 'd0000000-0000-0000-0000-0000000000e5';
export const AS_A_DUPLICATE = 'd0000000-0000-0000-0000-0000000000e6';
export const ONE_KEY = 'the same two rows';

export const sameKeyTwoKinds = {
  sqlite: `
    INSERT INTO suggestion_dismissals (id, user_id, kind, subject_key, dismissed_at) VALUES
      ('${AS_A_PAIR}',      '${USER}', 'transfer-pair', '${ONE_KEY}', '2024-04-01T09:00:00.000Z'),
      ('${AS_A_DUPLICATE}', '${USER}', 'duplicate',     '${ONE_KEY}', '2024-04-01T09:00:00.000Z');
    INSERT INTO suggestion_dismissal_subjects (dismissal_id, transaction_id, role_order) VALUES
      ('${AS_A_PAIR}',      '${CORNER_SHOP}', 0),
      ('${AS_A_DUPLICATE}', '${CORNER_SHOP}', 0);`,
  postgres: `
    INSERT INTO public.suggestion_dismissals (id, user_id, kind, subject_key, subject_ids, dismissed_at) VALUES
      ('${AS_A_PAIR}',      '${USER}', 'transfer-pair', '${ONE_KEY}',
       ARRAY['${CORNER_SHOP}']::uuid[], '2024-04-01T09:00:00.000Z'),
      ('${AS_A_DUPLICATE}', '${USER}', 'duplicate',     '${ONE_KEY}',
       ARRAY['${CORNER_SHOP}']::uuid[], '2024-04-01T09:00:00.000Z');`,
};

// ── The rows a read spec expects, with the fixture's defaults filled in ─────
//
// A read returns whole rows, and a spec that spelled all twenty-five keys of
// every account would bury the one field it is about. These builders carry the
// value a bare fixture row actually has — every one of them checked against the
// column defaults in schema.sql — so a spec states its DIFFERENCE and the
// builder states the rest. Nothing here is derived from the crate's answer: the
// defaults are the schema's, and a port that changed one would be caught by
// every spec at once rather than by none.

/** One account, as both engines must answer with it. */
export function listedAccount(fields) {
  return {
    id: EVERYDAY,
    user_id: USER,
    name: 'Everyday',
    type: 'checking',
    currency: 'GBP',
    balance: '0.00',
    initial_balance: '0.00',
    bank_balance: null,
    bank_balance_date: null,
    last_reconciled_date: null,
    // The column slice 20 gave this file, so the read now compares it. NULL is
    // "never reconciled" and is never zero: £0.00 is a real statement balance.
    last_reconciled_balance: null,
    low_balance_alert_enabled: false,
    low_balance_threshold: null,
    opening_balance_date: null,
    archive_through_date: null,
    parent_account_id: null,
    institution: null,
    account_number: null,
    sort_code: null,
    icon: null,
    color: null,
    notes: null,
    is_active: true,
    metadata: {},
    created_at: OPENED_FIRST,
    updated_at: OPENED_FIRST,
    ...fields,
  };
}

/** One category. `level` and `name` together are the sort key. */
export function listedCategory(fields) {
  return {
    id: '',
    user_id: USER,
    name: '',
    type: 'expense',
    level: 'detail',
    parent_id: null,
    account_id: null,
    color: null,
    icon: null,
    is_system: false,
    is_transfer_category: false,
    is_revaluation_category: false,
    is_unassigned_bucket: false,
    is_active: true,
    created_at: NAMED_AT,
    updated_at: NAMED_AT,
    ...fields,
  };
}

/** One budget. `alert_threshold` is a percentage, not money — see the verb. */
export function listedBudget(fields) {
  return {
    id: '',
    user_id: USER,
    name: '',
    amount: '0.00',
    period: 'monthly',
    // The 'every' pair (20261107150000): null on every named rhythm, by CHECK.
    repeat_count: null,
    repeat_unit: null,
    category: null,
    category_id: null,
    start_date: '2024-01-01',
    end_date: null,
    spent: '0.00',
    rollover: false,
    rollover_amount: '0.00',
    alert_threshold: '80.00',
    is_active: true,
    notes: null,
    metadata: {},
    created_at: OPENED_FIRST,
    updated_at: OPENED_FIRST,
    ...fields,
  };
}

/** One goal. */
export function listedGoal(fields) {
  return {
    id: '',
    user_id: USER,
    name: '',
    description: null,
    target_amount: '0.00',
    current_amount: '0.00',
    target_date: null,
    category: null,
    priority: null,
    status: 'active',
    account_id: null,
    contribution_frequency: null,
    auto_contribute: false,
    icon: null,
    color: null,
    completed_at: null,
    metadata: {},
    created_at: OPENED_FIRST,
    updated_at: OPENED_FIRST,
    ...fields,
  };
}

/**
 * One report — the eight keys the crate's report row serialises.
 *
 * `components` and `filters` default to the empty array and the empty object
 * rather than to null: both columns are NOT NULL on both engines, because a
 * report saved halfway through being built is an ordinary thing and a refusal
 * from the database is not the right answer to it.
 */
export function listedCustomReport(fields) {
  return {
    id: '',
    user_id: USER,
    name: '',
    // `''`, never null: the column is NOT NULL with a default of the empty
    // string on both engines, so a report that states no description HAS one —
    // it is empty. A null here would be a shape neither engine can produce.
    description: '',
    components: [],
    filters: {},
    created_at: OPENED_FIRST,
    updated_at: OPENED_FIRST,
    ...fields,
  };
}

/** One dismissal — five keys, because the cloud's own read names five. */
export function listedDismissal(fields) {
  return {
    id: '',
    kind: 'transfer-pair',
    subject_key: '',
    subject_ids: [],
    dismissed_at: DISMISSED_LATER,
    ...fields,
  };
}

// ── The heavy reads' fixtures ──────────────────────────────────────────────
//
// Everything the six light reads needed applies here too — pinned timestamps,
// distinct sort keys — with one addition of their own: these reads answer with
// whole ROWS OF THE LEDGER, so their fixtures move money, and every one of them
// still has B-1 asserted on it. A fixture that archives a row or breaks a
// balance says which of the two it is doing.

/** The instant every transaction and split line in these fixtures was made. */
export const MADE_AT = '2024-01-04T00:00:00.000Z';

/**
 * Fixed `created_at`/`updated_at` on every one of this login's transactions and
 * split lines.
 *
 * COMPOSE IT LAST. Both engines stamp `updated_at` on an UPDATE, so a fragment
 * that touches a transaction after this one has undone it. The asymmetry
 * between the two halves is [`pinnedReadTimes`]'s and has the same cause: naming
 * the column stands the local trigger down, while the cloud's assigns NOW()
 * unconditionally unless `app.restore_in_progress` is raised.
 */
export const pinnedLedgerTimes = {
  sqlite: `
    UPDATE transactions SET created_at = '${MADE_AT}', updated_at = '${MADE_AT}'
     WHERE user_id = '${USER}';
    UPDATE transaction_splits SET created_at = '${MADE_AT}', updated_at = '${MADE_AT}'
     WHERE user_id = '${USER}';`,
  postgres: `
    SELECT set_config('app.restore_in_progress', '1', true);
    UPDATE public.transactions SET created_at = '${MADE_AT}', updated_at = '${MADE_AT}'
     WHERE user_id = '${USER}';
    UPDATE public.transaction_splits SET created_at = '${MADE_AT}', updated_at = '${MADE_AT}'
     WHERE user_id = '${USER}';
    SELECT set_config('app.restore_in_progress', '0', true);`,
};

/** Three more rows in Everyday, two of them sharing the Corner shop's date. */
export const SAME_DAY_EARLIER = '70000000-0000-0000-0000-0000000000f1';
export const SAME_DAY_LATER = '70000000-0000-0000-0000-0000000000f3';
export const A_LATER_DAY = '70000000-0000-0000-0000-0000000000f2';

/**
 * The shape that proves the ORDER: one row on a later date, and two more on the
 * SAME date as the Corner shop row.
 *
 * `date DESC` alone cannot separate three rows on one day, and the cloud's own
 * second key — `id DESC`, which it calls a stable tiebreak for paging — is what
 * settles them. The ids are chosen so that id order and insertion order
 * disagree: `…f3` is written second and must come out first.
 *
 * Each row is −1.00 and Everyday's balance moves by −3.00, so B-1 holds.
 */
export const rowsOnOneDay = {
  sqlite: `
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date) VALUES
      ('${A_LATER_DAY}',     '${USER}', '${EVERYDAY}', 'A later day', -100, 'expense', '2024-03-02'),
      ('${SAME_DAY_LATER}',  '${USER}', '${EVERYDAY}', 'Second in',   -100, 'expense', '2024-03-01'),
      ('${SAME_DAY_EARLIER}','${USER}', '${EVERYDAY}', 'First in',    -100, 'expense', '2024-03-01');
    UPDATE accounts SET balance_minor = balance_minor - 300 WHERE id = '${EVERYDAY}';`,
  postgres: `
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date) VALUES
      ('${A_LATER_DAY}',     '${USER}', '${EVERYDAY}', 'A later day', -1.00, 'expense', '2024-03-02'),
      ('${SAME_DAY_LATER}',  '${USER}', '${EVERYDAY}', 'Second in',   -1.00, 'expense', '2024-03-01'),
      ('${SAME_DAY_EARLIER}','${USER}', '${EVERYDAY}', 'First in',    -1.00, 'expense', '2024-03-01');
    UPDATE public.accounts SET balance = balance - 3.00 WHERE id = '${EVERYDAY}';`,
};

/**
 * The Corner shop row, archived.
 *
 * Balance-neutral by definition — that IS the rule (20260721130000: "archiving
 * is a view flag and never moves a balance") — so B-1 still holds on Everyday at
 * −25.00 afterwards, and `account_balances` must still answer −25.00.
 */
export const anArchivedRow = {
  sqlite: `UPDATE transactions SET archived = 1 WHERE id = '${CORNER_SHOP}';`,
  postgres: `UPDATE public.transactions SET archived = true WHERE id = '${CORNER_SHOP}';`,
};

/**
 * The Everyday account's STORED balance, set to a figure that is not
 * `initial_balance + Σ amounts`, with no transaction touched.
 *
 * The only fixture in the whole harness that plants a B-1 violation outside the
 * `integrity-*` family, and it is planted for the same reason those are: the
 * thing under test is what happens when it is there. R-2 says a port that read
 * `accounts.balance` would report this drift AS MONEY; the answer must be the
 * derived −25.00 and not the stored 999.99, on both engines.
 *
 * Specs using it assert `violationRows`/`integrityOk` instead of
 * `balanceIdentityHolds`, because asserting B-1 here would be asserting that the
 * fixture failed to do its job.
 */
export const aStoredBalanceThatDrifted = {
  sqlite: `UPDATE accounts SET balance_minor = 99999 WHERE id = '${EVERYDAY}';`,
  postgres: `UPDATE public.accounts SET balance = 999.99 WHERE id = '${EVERYDAY}';`,
};

/**
 * Rainy day given an opening balance and left with no transactions.
 *
 * The LEFT JOIN's whole subject. B-1 holds trivially — an account with no rows
 * has `balance = initial_balance` — so both are moved together.
 */
export const anAccountNobodyHasUsed = {
  sqlite: `
    UPDATE accounts SET initial_balance_minor = 4200, balance_minor = 4200
     WHERE id = '${RAINY_DAY}';`,
  postgres: `
    UPDATE public.accounts SET initial_balance = 42.00, balance = 42.00
     WHERE id = '${RAINY_DAY}';`,
};

/**
 * The Corner shop row with every column the boot reads filled in with something
 * that is not its default.
 *
 * [`enriched`] does this for the WRITE verbs and stops short of three columns
 * the boot list carries — `needs_review`, `statement_sequence` and
 * `linked_transfer_split_id` — because no write verb sets them. On a bare
 * fixture each of those is a default, and a default is the one value that cannot
 * tell a working mapping from a missing one.
 *
 * ONE tag, not two, and that is deliberate: a `text[]` is an ordered list and a
 * child table is a set, so two tags is a question about ORDER rather than about
 * carrying them. That question has its own spec, declared as the divergence it
 * is.
 *
 * Nothing here moves an amount, so B-1 still holds on both accounts.
 */
export const everyColumnTheBootReads = {
  sqlite: `
    UPDATE transactions SET
      category_id = '${WEEKLY_SHOP}',
      notes = 'a note',
      is_cleared = 1,
      is_recurring = 1,
      category_confirmed = 0,
      needs_review = 1,
      statement_sequence = 7,
      transfer_account_id = '${RAINY_DAY}'
     WHERE id = '${CORNER_SHOP}';
    INSERT INTO transaction_tags (transaction_id, tag) VALUES ('${CORNER_SHOP}', 'zebra');`,
  postgres: `
    UPDATE public.transactions SET
      category_id = '${WEEKLY_SHOP}'::uuid,
      notes = 'a note',
      is_cleared = true,
      is_recurring = true,
      category_confirmed = false,
      needs_review = true,
      statement_sequence = 7,
      transfer_account_id = '${RAINY_DAY}'::uuid,
      tags = ARRAY['zebra']
     WHERE id = '${CORNER_SHOP}';`,
};

/**
 * A second split parent, so the whole-store split read has more than one to put
 * in order.
 *
 * Sits on [`plainSplitParent`], which makes Corner shop a split of −15.00 and
 * −10.00. This adds a −30.00 row in Everyday with two lines of its own, and its
 * id sorts BEFORE the Corner shop's, so a read that came back in insertion order
 * rather than in `transaction_id` order would be caught.
 */
export const SECOND_PARENT = '60000000-0000-0000-0000-0000000000b1';
export const SECOND_PARENT_FIRST_LINE = '50000000-0000-0000-0000-0000000000b1';
export const SECOND_PARENT_SECOND_LINE = '50000000-0000-0000-0000-0000000000b2';

export const aSecondSplitParent = {
  sqlite: `
    INSERT INTO _rpc_guard VALUES ('split');
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              is_split, category)
      VALUES ('${SECOND_PARENT}', '${USER}', '${EVERYDAY}', 'Big shop', -3000, 'expense',
              '2024-03-05', 1, '');
    UPDATE accounts SET balance_minor = balance_minor - 3000 WHERE id = '${EVERYDAY}';
    INSERT INTO transaction_splits (id, transaction_id, user_id, category, amount_minor, memo,
                                    sort_order) VALUES
      ('${SECOND_PARENT_FIRST_LINE}',  '${SECOND_PARENT}', '${USER}', '${WEEKLY_SHOP}', -2000,
       'the food half', 0),
      ('${SECOND_PARENT_SECOND_LINE}', '${SECOND_PARENT}', '${USER}', '${OUTGOINGS}',  -1000,
       NULL, 1);
    DELETE FROM _rpc_guard;`,
  postgres: `
    SELECT set_config('app.split_rpc', '1', true);
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date,
                                     is_split, category)
      VALUES ('${SECOND_PARENT}', '${USER}', '${EVERYDAY}', 'Big shop', -30.00, 'expense',
              '2024-03-05', true, '');
    UPDATE public.accounts SET balance = balance - 30.00 WHERE id = '${EVERYDAY}';
    INSERT INTO public.transaction_splits (id, transaction_id, user_id, category, amount, memo,
                                           sort_order) VALUES
      ('${SECOND_PARENT_FIRST_LINE}',  '${SECOND_PARENT}', '${USER}', '${WEEKLY_SHOP}', -20.00,
       'the food half', 0),
      ('${SECOND_PARENT_SECOND_LINE}', '${SECOND_PARENT}', '${USER}', '${OUTGOINGS}',  -10.00,
       NULL, 1);
    SELECT set_config('app.split_rpc', '0', true);`,
};

/** Everything of this login's, gone — the empty-file answer, on a real file. */
export const nothingOfMine = {
  sqlite: `
    DELETE FROM transaction_splits WHERE user_id = '${USER}';
    DELETE FROM transactions WHERE user_id = '${USER}';
    UPDATE accounts SET balance_minor = initial_balance_minor WHERE user_id = '${USER}';`,
  postgres: `
    DELETE FROM public.transaction_splits WHERE user_id = '${USER}';
    DELETE FROM public.transactions WHERE user_id = '${USER}';
    UPDATE public.accounts SET balance = initial_balance WHERE user_id = '${USER}';`,
};

// ── The rows the heavy reads expect ────────────────────────────────────────

/**
 * One transaction, as both engines must answer with it.
 *
 * Twenty-three keys, which is `BOOT_TRANSACTION_COLUMNS` exactly. It was
 * twenty-two until the C/R split was ported: `is_reconciled` was the one boot
 * column the cloud had (since 20260810200000) and scripts/local-sqlite/schema.sql
 * had not, and the gap was recorded here, in the crate's `row.rs` and in the
 * harness oracle rather than hidden. Both schemas hold it now, so every read
 * spec in this directory compares Money's R as well as its C.
 *
 * The defaults below are the Corner shop row's, checked against the column
 * defaults in both schemas — `category_confirmed` is true by default in both
 * (a writer that does not know about provenance produces a confirmed row),
 * `needs_review` false in both (one that does not know about review produces a
 * reviewed row), and `is_reconciled` FALSE in both, which is the third of the
 * same shape: a transaction is born uncommitted whether it was typed, imported
 * or downloaded. Not NULL — that value belongs to rows written before the split,
 * and a file created from this schema has none.
 */
export function listedTransaction(fields) {
  return {
    id: CORNER_SHOP,
    account_id: EVERYDAY,
    amount: '-25.00',
    archived: false,
    category: WEEKLY_SHOP,
    category_confirmed: true,
    category_id: null,
    created_at: MADE_AT,
    date: '2024-03-01',
    description: 'Corner shop',
    is_cleared: false,
    is_reconciled: false,
    is_recurring: false,
    is_split: false,
    linked_transfer_id: null,
    linked_transfer_split_id: null,
    needs_review: false,
    notes: null,
    statement_sequence: null,
    tags: [],
    type: 'expense',
    updated_at: MADE_AT,
    transfer_account_id: null,
    ...fields,
  };
}

/** One split line — eleven keys, because both split reads are `select('*')`. */
export function listedSplit(fields) {
  return {
    id: '',
    transaction_id: CORNER_SHOP,
    user_id: USER,
    category: WEEKLY_SHOP,
    amount: '0.00',
    memo: null,
    sort_order: 0,
    transfer_account_id: null,
    linked_transfer_id: null,
    created_at: MADE_AT,
    updated_at: MADE_AT,
    ...fields,
  };
}

/**
 * One account's derived balance — the three keys the RPC returns.
 *
 * Named `derivedBalance` and not `accountBalance` on purpose: `accountBalance`
 * is already imported at the top of this file from `lib/money-sql.mjs`, and it
 * reads `accounts.balance` — the STORED figure. Two helpers one letter apart,
 * one reading the cache and one reading the derivation, is precisely R-2's
 * mistake with a shorter fuse.
 */
export function derivedBalance(fields) {
  return {
    account_id: EVERYDAY,
    balance: '0.00',
    txn_count: 0,
    ...fields,
  };
}

/**
 * Two tags on the Corner shop row, written in an order that is NOT tag order.
 *
 * The one shape where the two engines legitimately answer differently, and the
 * whole point of the fixture is that the difference is visible: `text[]` in the
 * cloud remembers that `zebra` was written first, and a child table keyed
 * `(transaction_id, tag)` has no insertion order to remember. Written in this
 * order so a spec asserting sorted output on both sides would fail on one.
 */
export const twoTagsInTheWrongOrder = {
  sqlite: `
    INSERT INTO transaction_tags (transaction_id, tag) VALUES
      ('${CORNER_SHOP}', 'zebra'), ('${CORNER_SHOP}', 'apple');`,
  postgres: `UPDATE public.transactions SET tags = ARRAY['zebra','apple'] WHERE id = '${CORNER_SHOP}';`,
};

// ── The account family's fixtures and assertions ───────────────────────────

/** The account every write spec in the family makes or edits. */
export const NEW_ACCOUNT = 'a0000000-0000-0000-0000-0000000000a1';

/**
 * The two timestamps a WRITE spec can never compare across engines.
 *
 * Both are `now()` at the moment of the write, on two machines' clocks and in
 * two transactions, so they are different by construction and say nothing when
 * they differ. Declared once here rather than re-argued in each spec, because a
 * per-spec sentence would drift into "and while we are here, this other field
 * too". A READ spec does not need it: those pin the times in their setup
 * (`pinnedReadTimes`) and then really do compare them.
 */
export const writeInstants = {
  created_at: 'the instant of the write, on two clocks and in two transactions',
  updated_at: 'the same instant, and the same two clocks',
};

/**
 * Every To/From category of one account, as `name:active` lines in name order.
 *
 * C-3's subject, read back as one string so the COUNT and the NAME are one
 * assertion: "exactly one, called this, and open" is the whole rule, and three
 * separate assertions would let a spec accidentally check two of them.
 * `NONE` covers "no To/From category", which is a real and legal state on a file
 * whose Transfer anchor does not exist yet.
 */
export function transferCategoriesFor(accountId, expect) {
  const line = (activeExpr) => `c.name || ':' || CASE WHEN ${activeExpr} THEN 'open' ELSE 'hidden' END`;
  return {
    name: `transfer_categories_for_${accountId.slice(-4)}`,
    sqlite: `SELECT COALESCE((SELECT group_concat(line, ' | ') FROM (
               SELECT ${line('c.is_active = 1')} AS line FROM categories c
                WHERE c.account_id = '${accountId}' AND c.is_transfer_category = 1
                ORDER BY c.name)), 'NONE')`,
    postgres: `SELECT COALESCE(string_agg(${line('c.is_active')}, ' | ' ORDER BY c.name), 'NONE')
                 FROM public.categories c
                WHERE c.account_id = '${accountId}' AND c.is_transfer_category`,
    expect,
  };
}

/**
 * One TEXT-ish column of one ACCOUNT, with the three states kept apart the way
 * {@link storedText} keeps them apart for a transaction: `ABSENT`, `NULL`,
 * `EMPTY`. The last one earns its place here — the create collapses an empty
 * account number to NULL and the update does not, and without this those two
 * behaviours would both read as a blank line.
 */
export function accountText(accountId, column, expect) {
  const wrap = (cast) => `CASE WHEN ${cast} IS NULL THEN 'NULL'
                              WHEN ${cast} = '' THEN 'EMPTY'
                              ELSE ${cast} END`;
  return {
    name: `account_${column}_${accountId.slice(-4)}`,
    sqlite: `SELECT COALESCE((SELECT ${wrap(column)} FROM accounts
        WHERE id = '${accountId}'), 'ABSENT')`,
    postgres: `SELECT COALESCE((SELECT ${wrap(`${column}::text`)} FROM public.accounts
        WHERE id = '${accountId}'), 'ABSENT')`,
    expect,
  };
}

/** One boolean column of one account, as `yes`/`no`. */
export function accountFlag(accountId, column, expect) {
  return {
    name: `account_${column}_${accountId.slice(-4)}`,
    sqlite: `SELECT COALESCE((SELECT CASE WHEN ${column} = 1 THEN 'yes' ELSE 'no' END
        FROM accounts WHERE id = '${accountId}'), 'ABSENT')`,
    postgres: `SELECT COALESCE((SELECT CASE WHEN ${column} THEN 'yes' ELSE 'no' END
        FROM public.accounts WHERE id = '${accountId}'), 'ABSENT')`,
    expect,
  };
}

/**
 * THE SIZE OF A B-1 BREACH, signed, for the two specs where one engine has one.
 *
 * The same query {@link balanceIdentityHolds} runs, and deliberately a different
 * function with a different name: that one expects `0.00` and says so in its
 * own documentation, because *"B-1 is the invariant the whole application rests
 * on and neither schema enforces it"*. Giving it an `expect` argument would turn
 * the most load-bearing assertion in this directory into one a spec can excuse
 * itself from in passing.
 *
 * This one has to be asked for by name, and there are exactly two callers: the
 * update specs where the cloud's direct write leaves the identity broken and the
 * verb does not. The figure is the drift, so `0.00` still means "holds".
 */
export function balanceDrift(accountId, expect) {
  return {
    name: `balance_drift_for_${accountId.slice(-4)}`,
    sqlite: balanceIdentity.sqlite(accountId),
    postgres: balanceIdentity.postgres(accountId),
    expect,
  };
}

/** How many accounts this login has, open and closed together. */
export function accountsOwned(expect) {
  return {
    name: 'accounts_owned',
    sqlite: `SELECT COUNT(*) FROM accounts WHERE user_id = '${USER}'`,
    postgres: `SELECT COUNT(*) FROM public.accounts WHERE user_id = '${USER}'`,
    expect,
  };
}

/**
 * Is this string anywhere in the accounts table at all?
 *
 * Written for the card rule, where "the field was truncated" is the weak
 * assertion and "the number is not in the database" is the one that matters —
 * anything stored reaches that person's backups and their JSON export.
 */
export function nowhereInTheAccounts(needle, expect) {
  const predicate = (concat) => `${concat} LIKE '%${needle}%'`;
  return {
    name: `occurrences_of_${needle.slice(-6)}`,
    sqlite: `SELECT COUNT(*) FROM accounts
              WHERE ${predicate("COALESCE(account_number,'') || COALESCE(sort_code,'') || COALESCE(notes,'') || COALESCE(name,'')")}`,
    postgres: `SELECT COUNT(*) FROM public.accounts
                WHERE ${predicate("COALESCE(account_number,'') || COALESCE(sort_code,'') || COALESCE(notes,'') || COALESCE(name,'')")}`,
    expect,
  };
}

// ── The category WRITES' fixtures ──────────────────────────────────────────
//
// The merge and prune families above start from a tree that already exists.
// These five verbs are about making one, so what they need is the opposite: a
// login with NOTHING in it, and a way to compare a tree whose ids the two
// engines deliberately do not agree about.

/**
 * A login with no categories, no accounts and no rows — what `create_file`
 * leaves behind, and the only state `seed_categories` does anything in.
 *
 * It has to be a SECOND login rather than the fixture's own emptied out,
 * because the fixture's accounts hold To/From categories and C-5 refuses to let
 * one go while its account is there. Emptying it would mean deleting the
 * accounts, which is a different fixture with different rows in it.
 */
export const EMPTY_LOGIN = '33333333-3333-3333-3333-333333333333';

export const emptyLogin = {
  sqlite: `
    INSERT INTO users (id, email) VALUES ('${EMPTY_LOGIN}', 'device@localhost');`,
  postgres: `
    INSERT INTO public.users (id, clerk_id, email)
      VALUES ('${EMPTY_LOGIN}', 'clerk_local_sqlite_device', 'device@localhost');`,
};

/**
 * One login's whole category tree, BY NAME, as one canonical string.
 *
 * `name:type:level:parentName:flags:active` per row, ordered by name, joined by
 * ` | `. Nothing in it is an id, and that is the point: `seed_categories` is
 * divergence B-4 — the cloud mints a fresh uuid for every row and the local
 * edition keeps the slug it was given — so the ids are the one thing the two
 * engines are guaranteed to disagree about and every other thing about the tree
 * is guaranteed to match. A spec that compared ids would be comparing the
 * declared divergence; this compares the tree.
 *
 * The parent is rendered by NAME for the same reason, which also makes the
 * assertion say something a person can check: "Transfer In sits under
 * Transfer".
 */
export function categoryTree(userId, expect) {
  const build = (engine) => {
    const table = engine === 'sqlite' ? 'categories' : 'public.categories';
    const truthy = (column) => (engine === 'sqlite' ? `c.${column} = 1` : `c.${column}`);
    const parent = `COALESCE((SELECT p.name FROM ${table} p WHERE p.id = c.parent_id), '-')`;
    const flags = `COALESCE(NULLIF(
        CASE WHEN ${truthy('is_system')} THEN 's' ELSE '' END ||
        CASE WHEN ${truthy('is_transfer_category')} THEN 't' ELSE '' END ||
        CASE WHEN ${truthy('is_revaluation_category')} THEN 'r' ELSE '' END ||
        CASE WHEN ${truthy('is_unassigned_bucket')} THEN 'u' ELSE '' END, ''), '-')`;
    const active = `CASE WHEN ${truthy('is_active')} THEN 'active' ELSE 'hidden' END`;
    const row = `c.name || ':' || c.type || ':' || c.level || ':' || ${parent}
                 || ':' || ${flags} || ':' || ${active}`;
    return engine === 'sqlite'
      ? `SELECT COALESCE((SELECT group_concat(line, ' | ') FROM (
           SELECT ${row} AS line FROM ${table} c
            WHERE c.user_id = '${userId}' ORDER BY c.name)), 'NONE')`
      : `SELECT COALESCE(string_agg(${row}, ' | ' ORDER BY c.name), 'NONE')
           FROM ${table} c WHERE c.user_id = '${userId}'`;
  };
  return {
    name: `category_tree_of_${userId.slice(-4)}`,
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

/** How many categories one login has. Named per login, so two can be asserted. */
export function categoriesOwnedBy(userId, expect) {
  return {
    name: `categories_owned_by_${userId.slice(-4)}`,
    sqlite: `SELECT COUNT(*) FROM categories WHERE user_id = '${userId}'`,
    postgres: `SELECT COUNT(*) FROM public.categories WHERE user_id = '${userId}'`,
    expect,
  };
}

/**
 * A category's parent, BY NAME — `-` when it has none.
 *
 * The half of [`categoryShape`] a create-and-wire spec is actually about, said
 * in a way that survives an engine minting its own ids.
 */
export function parentOf(categoryId, expect) {
  const build = (engine) => {
    const table = engine === 'sqlite' ? 'categories' : 'public.categories';
    return `SELECT COALESCE((SELECT COALESCE(
              (SELECT p.name FROM ${table} p WHERE p.id = c.parent_id), '-')
              FROM ${table} c WHERE c.id = '${categoryId}'), 'GONE')`;
  };
  return {
    name: `parent_of_${categoryId.slice(-4)}`,
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

// ── The planning family's fixtures ──────────────────────────────────────────
//
// Budgets and goals have appeared in this file before, but only as things a
// CATEGORY MERGE has to move (`budgetOnTheSource`). These are the fixtures for
// writing them, and what they mostly need is a row to edit and a second login
// to be kept out of.

/** A monthly budget of 100.00 against Weekly shop, already in the file. */
export const EXISTING_BUDGET = 'b0000000-0000-0000-0000-0000000000f1';

export const existingBudget = {
  sqlite: `
    INSERT INTO budgets (id, user_id, name, amount_minor, period, category, start_date,
                         alert_threshold_bp)
      VALUES ('${EXISTING_BUDGET}', '${USER}', 'Food', 10000, 'monthly',
              '${WEEKLY_SHOP}', '2024-01-01', 8000);`,
  postgres: `
    INSERT INTO public.budgets (id, user_id, name, amount, period, category, start_date,
                                alert_threshold)
      VALUES ('${EXISTING_BUDGET}', '${USER}', 'Food', 100.00, 'monthly',
              '${WEEKLY_SHOP}', '2024-01-01', 80.00);`,
};

/** A goal with 250.05 already put by towards 2000.00, already in the file. */
export const EXISTING_GOAL = 'e0000000-0000-0000-0000-0000000000f1';

export const existingGoal = {
  sqlite: `
    INSERT INTO goals (id, user_id, name, target_amount_minor, current_amount_minor,
                       target_date, status, metadata)
      VALUES ('${EXISTING_GOAL}', '${USER}', 'Holiday', 200000, 25005,
              '2026-01-01', 'active', '{"type":"savings","linkedAccountIds":["keep-me"]}');`,
  postgres: `
    INSERT INTO public.goals (id, user_id, name, target_amount, current_amount,
                              target_date, status, metadata)
      VALUES ('${EXISTING_GOAL}', '${USER}', 'Holiday', 2000.00, 250.05,
              '2026-01-01', 'active', '{"type":"savings","linkedAccountIds":["keep-me"]}');`,
};

/**
 * One report that already exists, with BOTH kinds of list inside its filters.
 *
 * `accounts` and `categories` are row ids; `tags` is a label somebody typed.
 * Both are in the fixture because a spec that only carried one would pass
 * against an engine that treated the whole blob as opaque and against one that
 * rewrote all of it.
 *
 * The two JSON columns are TEXT in the file and `jsonb` in the cloud, so the
 * INSERTs differ in their casts and in nothing else — the same difference every
 * money column in this file already has, one type along.
 */
export const EXISTING_REPORT = 'd0000000-0000-0000-0000-0000000000ff';

const REPORT_COMPONENTS =
  '[{"id":"one","type":"summary-stats","title":"Key figures","config":{"metrics":["income"]},"width":"full"}]';
const REPORT_FILTERS =
  `{"dateRange":"quarter","accounts":["${EVERYDAY}"],"categories":["${WEEKLY_SHOP}"],"tags":["holiday"]}`;

export const existingCustomReport = {
  sqlite: `
    INSERT INTO custom_reports (id, user_id, name, description, components, filters,
                                created_at, updated_at)
      VALUES ('${EXISTING_REPORT}', '${USER}', 'Where it went', 'last quarter',
              '${REPORT_COMPONENTS}', '${REPORT_FILTERS}',
              '2026-03-04T10:00:00.000Z', '2026-03-04T10:00:00.000Z');`,
  postgres: `
    INSERT INTO public.custom_reports (id, user_id, name, description, components, filters,
                                       created_at, updated_at)
      VALUES ('${EXISTING_REPORT}', '${USER}', 'Where it went', 'last quarter',
              '${REPORT_COMPONENTS}'::jsonb, '${REPORT_FILTERS}'::jsonb,
              '2026-03-04T10:00:00.000Z', '2026-03-04T10:00:00.000Z');`,
};

/**
 * Two reports, opened on two different days, so an ordering claim has something
 * to order.
 *
 * The second is the one with the contents: the first is the bare row a person
 * gets by pressing Save on an empty builder, and it is here because that shape
 * is what the two NOT NULL columns' defaults are actually for.
 */
export const OLDER_REPORT = 'd0000000-0000-0000-0000-0000000000a1';
export const NEWER_REPORT = 'd0000000-0000-0000-0000-0000000000a2';

/**
 * Two reports: one bare, one fully filled in.
 *
 * The bare one OMITS `description`, `components` and `filters` rather than
 * stating NULL for them, and the difference is the whole point of it. All three
 * are NOT NULL WITH A DEFAULT on both engines, so an omitted column takes `''`,
 * `'[]'` and `'{}'` — which is what a person pressing Save on an empty builder
 * actually produces. A stated NULL is a different thing entirely: it overrides
 * the default and the row is REFUSED, on both engines, which is correct
 * behaviour and simply not what this fixture is for.
 */
export const twoCustomReports = {
  sqlite: `
    INSERT INTO custom_reports (id, user_id, name, created_at, updated_at) VALUES
      ('${OLDER_REPORT}', '${USER}', 'Nothing in it yet',
       '${OPENED_FIRST}', '${OPENED_FIRST}');
    INSERT INTO custom_reports (id, user_id, name, description, components, filters,
                                created_at, updated_at) VALUES
      ('${NEWER_REPORT}', '${USER}', 'Where it went', 'last quarter',
       '${REPORT_COMPONENTS}', '${REPORT_FILTERS}', '${OPENED_SECOND}', '${OPENED_SECOND}');`,
  postgres: `
    INSERT INTO public.custom_reports (id, user_id, name, created_at, updated_at) VALUES
      ('${OLDER_REPORT}', '${USER}', 'Nothing in it yet',
       '${OPENED_FIRST}', '${OPENED_FIRST}');
    INSERT INTO public.custom_reports (id, user_id, name, description, components, filters,
                                       created_at, updated_at) VALUES
      ('${NEWER_REPORT}', '${USER}', 'Where it went', 'last quarter',
       '${REPORT_COMPONENTS}'::jsonb, '${REPORT_FILTERS}'::jsonb,
       '${OPENED_SECOND}', '${OPENED_SECOND}');`,
};

/** How many reports one login has. */
export function customReportsOwnedBy(userId, expect) {
  return {
    name: `custom_reports_owned_by_${userId.slice(-4)}`,
    sqlite: `SELECT COUNT(*) FROM custom_reports WHERE user_id = '${userId}'`,
    postgres: `SELECT COUNT(*) FROM public.custom_reports WHERE user_id = '${userId}'`,
    expect,
  };
}

/**
 * A report's identifying columns, as one string — name, description, and the
 * COUNT of components rather than the components themselves.
 *
 * The count and not the array, because the array is what the runner's own
 * row comparison already compares field by field; what a `state` assertion is
 * for is the STORE afterwards, and "how many components does the stored row
 * have" is the question a replace-versus-merge bug actually changes.
 */
export function customReportShape(reportId, expect) {
  const build = (engine) => {
    const table = engine === 'sqlite' ? 'custom_reports' : 'public.custom_reports';
    const components = engine === 'sqlite'
      ? '(SELECT COUNT(*) FROM json_each(r.components))'
      : 'jsonb_array_length(r.components)';
    const row = `r.name || ':' || COALESCE(r.description, '-')
                 || ':' || ${components}`;
    return `SELECT COALESCE((SELECT ${row} FROM ${table} r WHERE r.id = '${reportId}'), 'GONE')`;
  };
  return {
    name: `custom_report_shape_${reportId.slice(-4)}`,
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

/**
 * One key of a report's `filters`, rendered as a comma-joined list.
 *
 * Read key by key rather than as the whole blob, for the reason
 * [`goalMetadata`] gives: SQLite stores the document as the TEXT it was handed
 * and Postgres re-orders a `jsonb` by key, so comparing the raw column would
 * report every write as a divergence. The ORDER INSIDE an array is preserved by
 * both and IS compared, which is what makes "the filters replaced" observable.
 */
export function customReportFilter(reportId, key, expect) {
  const build = (engine) => {
    const table = engine === 'sqlite' ? 'custom_reports' : 'public.custom_reports';
    const each = engine === 'sqlite'
      ? `SELECT value AS element FROM ${table} r, json_each(json_extract(r.filters, '$.${key}'))
           WHERE r.id = '${reportId}'`
      : `SELECT element #>> '{}' AS element
           FROM ${table} r, jsonb_array_elements(r.filters->'${key}') AS element
          WHERE r.id = '${reportId}'`;
    return engine === 'sqlite'
      ? `SELECT COALESCE((SELECT group_concat(element, ',') FROM (${each})), 'NONE')`
      : `SELECT COALESCE((SELECT string_agg(element, ',') FROM (${each}) AS f), 'NONE')`;
  };
  return {
    name: `custom_report_filter_${key}_${reportId.slice(-4)}`,
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

/**
 * Two contributions against [`EXISTING_GOAL`], so a delete has something to
 * cascade into.
 *
 * `goal_contributions` has no writer anywhere in the app — nothing but a restore
 * has ever created one — so this fixture is the only way to observe the key that
 * takes them, and observing it is the point: `delete_goal` deliberately does NOT
 * walk them, so "they went" is a claim about `ON DELETE CASCADE` and about
 * `PRAGMA foreign_keys` having taken.
 */
export const CONTRIBUTIONS = ['f0000000-0000-0000-0000-0000000000c1', 'f0000000-0000-0000-0000-0000000000c2'];

export const goalContributions = {
  sqlite: `
    INSERT INTO goal_contributions (id, goal_id, user_id, amount_minor, date) VALUES
      ('${CONTRIBUTIONS[0]}', '${EXISTING_GOAL}', '${USER}', 10000, '2024-02-01'),
      ('${CONTRIBUTIONS[1]}', '${EXISTING_GOAL}', '${USER}', 15005, '2024-03-01');`,
  postgres: `
    INSERT INTO public.goal_contributions (id, goal_id, user_id, amount, date) VALUES
      ('${CONTRIBUTIONS[0]}', '${EXISTING_GOAL}', '${USER}', 100.00, '2024-02-01'),
      ('${CONTRIBUTIONS[1]}', '${EXISTING_GOAL}', '${USER}', 150.05, '2024-03-01');`,
};

/** A budget of the STRANGER's, so the owner clause has something to refuse. */
export const THEIR_BUDGET = 'b0000000-0000-0000-0000-0000000000d1';

export const strangersBudget = {
  sqlite: `
    INSERT INTO budgets (id, user_id, name, amount_minor, period, start_date)
      VALUES ('${THEIR_BUDGET}', '${STRANGER}', 'Theirs', 5000, 'monthly', '2024-01-01');`,
  postgres: `
    INSERT INTO public.budgets (id, user_id, name, amount, period, start_date)
      VALUES ('${THEIR_BUDGET}', '${STRANGER}', 'Theirs', 50.00, 'monthly', '2024-01-01');`,
};

/** A goal of the STRANGER's, likewise. */
export const THEIR_GOAL = 'e0000000-0000-0000-0000-0000000000d1';

export const strangersGoal = {
  sqlite: `
    INSERT INTO goals (id, user_id, name, target_amount_minor)
      VALUES ('${THEIR_GOAL}', '${STRANGER}', 'Theirs', 100000);`,
  postgres: `
    INSERT INTO public.goals (id, user_id, name, target_amount)
      VALUES ('${THEIR_GOAL}', '${STRANGER}', 'Theirs', 1000.00);`,
};

/**
 * One budget as one canonical string: `name:amount:period:category:start:end:
 * spent:rollover:rolloverAmount:threshold:active:notes`.
 *
 * Money and the threshold both render as two-place decimals from an INTEGER
 * column on one engine and a `numeric` on the other, which is the whole reason
 * they are compared as TEXT rather than as numbers. `-` stands for NULL, so
 * "cleared the end date" and "never had one" read alike and a spec that cares
 * asserts the column on its own.
 */
export function budgetShape(budgetId, expect) {
  const build = (engine) => {
    const table = engine === 'sqlite' ? 'budgets' : 'public.budgets';
    const amount = engine === 'sqlite' ? minorToDecimal('b.amount_minor') : numericToDecimal('b.amount');
    const spent = engine === 'sqlite' ? minorToDecimal('b.spent_minor') : numericToDecimal('b.spent');
    const rolled = engine === 'sqlite'
      ? minorToDecimal('b.rollover_amount_minor')
      : numericToDecimal('b.rollover_amount');
    const threshold = engine === 'sqlite'
      ? minorToDecimal('b.alert_threshold_bp')
      : numericToDecimal('b.alert_threshold');
    const flag = (column, yes, no) => (engine === 'sqlite'
      ? `CASE WHEN b.${column} = 1 THEN '${yes}' ELSE '${no}' END`
      : `CASE WHEN b.${column} THEN '${yes}' ELSE '${no}' END`);
    // `::text` is Postgres-only: the local columns are TEXT already, and a cast
    // written for both engines is a syntax error on one of them.
    const asText = (column) => (engine === 'sqlite' ? column : `${column}::text`);
    const row = `b.name || ':' || ${amount} || ':' || b.period
                 || ':' || COALESCE(b.category, '-')
                 || ':' || COALESCE(${asText('b.start_date')}, '-')
                 || ':' || COALESCE(${asText('b.end_date')}, '-')
                 || ':' || ${spent} || ':' || ${flag('rollover', 'carries', 'no')}
                 || ':' || ${rolled} || ':' || ${threshold}
                 || ':' || ${flag('is_active', 'active', 'paused')}
                 || ':' || COALESCE(b.notes, '-')`;
    return `SELECT COALESCE((SELECT ${row} FROM ${table} b WHERE b.id = '${budgetId}'), 'GONE')`;
  };
  return {
    name: `budget_shape_${budgetId.slice(-4)}`,
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

/**
 * One goal as one canonical string: `name:target:current:date:status:completed:
 * priority:account:frequency:auto:category`.
 *
 * `completed` is rendered as `stamped`/`-` rather than as the instant, because
 * the instant is `now()` on two clocks in two transactions — what the rule says
 * is that the date FOLLOWS the status, and that is a yes/no.
 */
export function goalShape(goalId, expect) {
  const build = (engine) => {
    const table = engine === 'sqlite' ? 'goals' : 'public.goals';
    const target = engine === 'sqlite'
      ? minorToDecimal('g.target_amount_minor')
      : numericToDecimal('g.target_amount');
    const current = engine === 'sqlite'
      ? minorToDecimal('g.current_amount_minor')
      : numericToDecimal('g.current_amount');
    const auto = engine === 'sqlite'
      ? "CASE WHEN g.auto_contribute = 1 THEN 'auto' ELSE 'manual' END"
      : "CASE WHEN g.auto_contribute THEN 'auto' ELSE 'manual' END";
    // `::text` is Postgres-only — see [`budgetShape`].
    const asText = (column) => (engine === 'sqlite' ? column : `${column}::text`);
    // THE LAST FOUR CHARACTERS, spelled per engine. SQLite's `substr(x, -4)`
    // counts from the END; Postgres's counts from a position before the start
    // and therefore returns the WHOLE uuid. This read `substr(…, -4)` on both
    // sides until slice 31 and was green only because no goal spec had asserted
    // a shape with a real `account_id` in it — `transferShape` and
    // `accountsAudited` had the right spelling all along.
    const goalAccountTail = engine === 'sqlite'
      ? "COALESCE(substr(g.account_id, -4), '-')"
      : "COALESCE(right(g.account_id::text, 4), '-')";
    const row = `g.name || ':' || ${target} || ':' || ${current}
                 || ':' || COALESCE(${asText('g.target_date')}, '-')
                 || ':' || g.status
                 || ':' || CASE WHEN g.completed_at IS NULL THEN '-' ELSE 'stamped' END
                 || ':' || COALESCE(g.priority, '-')
                 || ':' || ${goalAccountTail}
                 || ':' || COALESCE(g.contribution_frequency, '-')
                 || ':' || ${auto}
                 || ':' || COALESCE(g.category, '-')`;
    return `SELECT COALESCE((SELECT ${row} FROM ${table} g WHERE g.id = '${goalId}'), 'GONE')`;
  };
  return {
    name: `goal_shape_${goalId.slice(-4)}`,
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

/**
 * A goal's `metadata`, with its keys in a stable order.
 *
 * `json_each` on one engine and `jsonb_each` on the other, sorted by key and
 * rejoined, because SQLite stores the blob as the TEXT it was handed and
 * Postgres re-orders a `jsonb` by key length then bytes. Comparing the raw
 * column would report every merge as a divergence.
 */
export function goalMetadata(goalId, expect) {
  const build = (engine) => {
    const table = engine === 'sqlite' ? 'goals' : 'public.goals';
    const each = engine === 'sqlite'
      ? `SELECT key || '=' || COALESCE(value, 'null') AS pair
           FROM ${table} g, json_each(g.metadata) WHERE g.id = '${goalId}' ORDER BY key`
      : `SELECT key || '=' || COALESCE(value #>> '{}', 'null') AS pair
           FROM ${table} g, jsonb_each(g.metadata) WHERE g.id = '${goalId}' ORDER BY key`;
    return engine === 'sqlite'
      ? `SELECT COALESCE((SELECT group_concat(pair, ',') FROM (${each})), 'NONE')`
      : `SELECT COALESCE((SELECT string_agg(pair, ',') FROM (${each}) AS m), 'NONE')`;
  };
  return {
    name: `goal_metadata_${goalId.slice(-4)}`,
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

/** How many budgets one login has. */
export function budgetsOwnedBy(userId, expect) {
  return {
    name: `budgets_owned_by_${userId.slice(-4)}`,
    sqlite: `SELECT COUNT(*) FROM budgets WHERE user_id = '${userId}'`,
    postgres: `SELECT COUNT(*) FROM public.budgets WHERE user_id = '${userId}'`,
    expect,
  };
}

/** How many goals one login has. */
export function goalsOwnedBy(userId, expect) {
  return {
    name: `goals_owned_by_${userId.slice(-4)}`,
    sqlite: `SELECT COUNT(*) FROM goals WHERE user_id = '${userId}'`,
    postgres: `SELECT COUNT(*) FROM public.goals WHERE user_id = '${userId}'`,
    expect,
  };
}

/** How many contributions are filed against one goal. */
export function contributionsOf(goalId, expect) {
  return {
    name: `contributions_of_${goalId.slice(-4)}`,
    sqlite: `SELECT COUNT(*) FROM goal_contributions WHERE goal_id = '${goalId}'`,
    postgres: `SELECT COUNT(*) FROM public.goal_contributions WHERE goal_id = '${goalId}'`,
    expect,
  };
}

/**
 * The audit rows for ONE entity kind, as `action×count` in write order.
 *
 * Written for divergence 10 and named after the entity so a budget spec and a
 * goal spec can both use it in one file. The expectation is stated PER ENGINE by
 * every spec that uses it — that is the divergence — and `parity: 'divergent'`
 * plus a reason is what the runner then requires.
 */
export function auditTrailFor(entity, expect) {
  return {
    name: `audit_trail_for_${entity}`,
    sqlite: `SELECT COALESCE((SELECT group_concat(action, ',') FROM (
               SELECT action FROM financial_audit_log
                WHERE entity = '${entity}' ORDER BY seq)), 'NONE')`,
    postgres: `SELECT COALESCE((SELECT string_agg(action, ',' ORDER BY ctid)
                 FROM public.financial_audit_log WHERE entity = '${entity}'), 'NONE')`,
    expect,
  };
}

// ── Dismissals ──────────────────────────────────────────────────────────────
//
// Every probe below has to bridge the one structural difference between the two
// engines: `subject_ids` is a `uuid[]` ON the dismissal in the cloud and the
// child table `suggestion_dismissal_subjects` here. A probe that read only one
// of them would be a probe that could only run on one engine, and the whole
// point of these specs is that the two shapes hold the SAME fact.

/** A dismissal the specs create, so both engines name one row. */
export const NEW_DISMISSAL = 'd0000000-0000-0000-0000-0000000000e1';
/** A second id, sent by a REPEAT refusal that must not be allowed to win. */
export const SECOND_ATTEMPT = 'd0000000-0000-0000-0000-0000000000e2';

/**
 * One dismissal as one canonical string: `kind:subject_key:<n> subjects`, or
 * `GONE`.
 *
 * Keyed by the NATURAL key, not the id, because that is what both verbs take and
 * because a repeat refusal deliberately sends a different id — a probe that
 * looked the row up by id could not see the row that actually survived.
 *
 * `dismissed_at` is NOT in the string: it is the column's default on two clocks
 * in two transactions. Where a spec needs it, it plants a known value first and
 * asserts THAT with [`dismissalDate`], which is a comparison of a literal rather
 * than of an instant.
 */
export function dismissalShape(kind, subjectKey, expect) {
  const build = (engine) => {
    const table = engine === 'sqlite' ? 'suggestion_dismissals' : 'public.suggestion_dismissals';
    const subjects = engine === 'sqlite'
      ? `(SELECT COUNT(*) FROM suggestion_dismissal_subjects s WHERE s.dismissal_id = d.id)`
      : `COALESCE(array_length(d.subject_ids, 1), 0)`;
    const row = `d.kind || ':' || d.subject_key || ':' || ${subjects}`;
    return `SELECT COALESCE((SELECT ${row} FROM ${table} d
                              WHERE d.kind = '${kind}' AND d.subject_key = '${subjectKey}'), 'GONE')`;
  };
  return {
    name: `dismissal_shape_${kind}_${subjectKey.slice(0, 12)}`,
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

/**
 * A dismissal's subjects, last four characters each, IN ROLE ORDER.
 *
 * The array's own positions on one side and `ORDER BY role_order` on the other,
 * never sorted: the positions are ROLES — for a transfer pair, which row was the
 * out and which the in — so a set would be a different fact. This is the same
 * comparison `read-dismissals-the-subjects-come-back-as-an-array-in-role-order`
 * makes about the READ, asked here about what a WRITE stored.
 */
export function subjectsInRoleOrder(kind, subjectKey, expect) {
  const found = (engine) => (engine === 'sqlite'
    ? `SELECT id FROM suggestion_dismissals WHERE kind = '${kind}' AND subject_key = '${subjectKey}'`
    : `SELECT id FROM public.suggestion_dismissals WHERE kind = '${kind}' AND subject_key = '${subjectKey}'`);
  return {
    name: `subjects_in_role_order_${kind}_${subjectKey.slice(0, 12)}`,
    sqlite: `SELECT COALESCE((SELECT group_concat(t, ',') FROM (
               SELECT substr(transaction_id, -4) AS t
                 FROM suggestion_dismissal_subjects
                WHERE dismissal_id = (${found('sqlite')})
                ORDER BY role_order)), 'NONE')`,
    postgres: `SELECT COALESCE((SELECT string_agg(right(u.id::text, 4), ',' ORDER BY u.position)
                 FROM public.suggestion_dismissals d,
                      unnest(d.subject_ids) WITH ORDINALITY AS u(id, position)
                WHERE d.kind = '${kind}' AND d.subject_key = '${subjectKey}'), 'NONE')`,
    expect,
  };
}

/**
 * The `dismissed_at` a dismissal is holding, as a day.
 *
 * Only ever asked of a PLANTED value. "First wins" means a repeat refusal leaves
 * the original date alone, and the only way to see that is to know what the
 * original was — so the fixture writes one and this compares against it. A day
 * rather than the instant, because that is the resolution a planted literal and
 * two engines' text formats can agree on without a cast that means something
 * different on each.
 */
export function dismissalDate(kind, subjectKey, expect) {
  return {
    name: `dismissal_date_${kind}_${subjectKey.slice(0, 12)}`,
    sqlite: `SELECT COALESCE((SELECT substr(dismissed_at, 1, 10) FROM suggestion_dismissals
                               WHERE kind = '${kind}' AND subject_key = '${subjectKey}'), 'GONE')`,
    postgres: `SELECT COALESCE((SELECT to_char(dismissed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
                                  FROM public.suggestion_dismissals
                                 WHERE kind = '${kind}' AND subject_key = '${subjectKey}'), 'GONE')`,
    expect,
  };
}

/** How many refusals one login has on record. */
export function dismissalsOwnedBy(userId, expect) {
  return {
    name: `dismissals_owned_by_${userId.slice(-4)}`,
    sqlite: `SELECT COUNT(*) FROM suggestion_dismissals WHERE user_id = '${userId}'`,
    postgres: `SELECT COUNT(*) FROM public.suggestion_dismissals WHERE user_id = '${userId}'`,
    expect,
  };
}

/**
 * Every subject row still in the file, across ALL dismissals.
 *
 * The measurement `restore_suggestion` owes: the child rows leave by
 * `ON DELETE CASCADE`, which is a DECLARATION, and `delete_goal` set the
 * precedent that a cascade a verb chose not to walk must be measured actually
 * happening rather than trusted. The cloud has nothing to cascade — the subjects
 * were an array in the deleted row — so on that side this counts the array
 * elements that remain, and the two engines are asserted to reach the same
 * total by different machinery.
 */
export function subjectRowsInTotal(expect) {
  return {
    name: 'subject_rows_in_total',
    sqlite: 'SELECT COUNT(*) FROM suggestion_dismissal_subjects',
    postgres: `SELECT COALESCE((SELECT SUM(COALESCE(array_length(subject_ids, 1), 0))
                                  FROM public.suggestion_dismissals), 0)`,
    expect,
  };
}

// ── The reconciliation and archive family ──────────────────────────────────
//
// Five verbs about two flags and a date, and everything below exists because
// those flags are THREE-valued and a date has to be planted before an archive
// has anything to bite on. All data is invented.

/**
 * One THREE-valued boolean column of one transaction: `yes` / `no` / `NULL`.
 *
 * {@link storedFlag} cannot serve, and the difference is the whole C/R split:
 * it renders anything that is not 1 as `no`, so a pre-split NULL — the row that
 * means "ask is_cleared" — and an explicit "not committed" would read the same.
 * Those two are exactly what `finalize_reconciliation` distinguishes with
 * `IS NOT DISTINCT FROM false` and what `archive_transactions_before`
 * distinguishes with its COALESCE, so a spec that could not tell them apart
 * would pass against a port that had lost the distinction.
 */
export function storedTriFlag(transactionId, column, expect) {
  const wrap = (yes) => `CASE WHEN ${column} IS NULL THEN 'NULL'
                              WHEN ${yes} THEN 'yes' ELSE 'no' END`;
  return {
    name: `stored_${column}_${transactionId.slice(-4)}`,
    sqlite: `SELECT COALESCE((SELECT ${wrap(`${column} = 1`)}
        FROM transactions WHERE id = '${transactionId}'), 'ABSENT')`,
    postgres: `SELECT COALESCE((SELECT ${wrap(column)}
        FROM public.transactions WHERE id = '${transactionId}'), 'ABSENT')`,
    expect,
  };
}

/**
 * One MONEY column of one account, as an exact decimal string, with `NULL` kept
 * apart from zero.
 *
 * Written for `last_reconciled_balance`, where the two are different facts and
 * the column is nullable for that reason alone: £0.00 is a real statement
 * balance — an account swept to zero every night closes on exactly that — and
 * "no reconciliation has ever been finalized" is not a figure. A helper that
 * rendered NULL as `0.00` would make the spec that proves it pass by accident.
 *
 * The column is named ONCE, in the cloud's spelling, and the local `_minor`
 * suffix is added here — the same correspondence `storedBalances` writes out for
 * `balance`/`balance_minor`, and the same one `schema.sql` states as a rule
 * ("scale is per column, and the column NAME says which").
 */
export function accountMoney(accountId, column, expect) {
  const local = `${column}_minor`;
  const wrap = (col, decimal) => `CASE WHEN ${col} IS NULL THEN 'NULL' ELSE ${decimal} END`;
  return {
    name: `account_${column}_${accountId.slice(-4)}`,
    sqlite: `SELECT COALESCE((SELECT ${wrap(local, minorToDecimal(local))} FROM accounts
        WHERE id = '${accountId}'), 'ABSENT')`,
    postgres: `SELECT COALESCE((SELECT ${wrap(column, numericToDecimal(column))}
        FROM public.accounts WHERE id = '${accountId}'), 'ABSENT')`,
    expect,
  };
}

/**
 * How many rows of one account are hidden from the live register.
 *
 * The archive's headline, asked as a count rather than row by row so that a
 * verb which archived MORE than it was asked to cannot pass by having the one
 * row a spec thought to name come out right.
 */
export function archivedRowsIn(accountId, expect) {
  return {
    name: `archived_rows_in_${accountId.slice(-4)}`,
    sqlite: `SELECT COUNT(*) FROM transactions WHERE account_id = '${accountId}' AND archived = 1`,
    postgres: `SELECT COUNT(*) FROM public.transactions
                WHERE account_id = '${accountId}' AND archived`,
    expect,
  };
}

/** The three ids the reconciliation fixtures plant, beside the base row. */
export const MARKED_ROW = '70000000-0000-0000-0000-0000000000c1';
export const COMMITTED_ROW = '70000000-0000-0000-0000-0000000000c2';
export const PRE_SPLIT_ROW = '70000000-0000-0000-0000-0000000000c3';

/**
 * Three rows in Everyday, one per state of the committed flag, and the base
 * fixture's Corner shop left unmarked as the fourth.
 *
 * | row | `is_cleared` | `is_reconciled` | what it is |
 * | --- | --- | --- | --- |
 * | MARKED_ROW | 1 | 0 | ticked this session; the working set a finalize converts |
 * | COMMITTED_ROW | 1 | 1 | already through a finalize |
 * | PRE_SPLIT_ROW | 1 | NULL | written before the split; "ask is_cleared" |
 * | CORNER_SHOP | 0 | 0 | not ticked at all |
 *
 * Dated 2024-01-15, 2024-01-16 and 2024-01-17 — all BEFORE the base row's
 * 2024-03-01 — so one cutoff can separate them from it. Every row is −1.00 and
 * both balances are moved, so B-1 holds before the verb runs.
 *
 * The NULL row is planted as an EXPLICIT NULL rather than by leaving the column
 * out, and that is not belt and braces: the local column carries `DEFAULT 0`, so
 * an INSERT that says nothing gets 0 — the right answer for a row being born and
 * the wrong state for this fixture, which needs the one value only history can
 * hold.
 *
 * `updated_at` is planted at 2019-01-01 ON THE INSERT, and it has to be on the
 * insert: the cloud's `update_transactions_updated_at` is a BEFORE UPDATE
 * trigger, so a fixture that planted the stamp with an UPDATE would have it
 * overwritten with `now()` before the spec ever ran — MEASURED, by writing it
 * that way first and watching Postgres answer today's date. That is what makes
 * "this verb did not touch the row" observable at all.
 */
export const everyStateOfCommitment = {
  sqlite: `
    INSERT INTO transactions (id, user_id, account_id, description, amount_minor, type, date,
                              category, is_cleared, is_reconciled, updated_at) VALUES
      ('${MARKED_ROW}',    '${USER}', '${EVERYDAY}', 'Ticked',    -100, 'expense', '2024-01-15', '${WEEKLY_SHOP}', 1, 0,    '2019-01-01T00:00:00.000Z'),
      ('${COMMITTED_ROW}', '${USER}', '${EVERYDAY}', 'Settled',   -100, 'expense', '2024-01-16', '${WEEKLY_SHOP}', 1, 1,    '2019-01-01T00:00:00.000Z'),
      ('${PRE_SPLIT_ROW}', '${USER}', '${EVERYDAY}', 'Historic',  -100, 'expense', '2024-01-17', '${WEEKLY_SHOP}', 1, NULL, '2019-01-01T00:00:00.000Z');
    UPDATE accounts SET balance_minor = balance_minor - 300 WHERE id = '${EVERYDAY}';`,
  postgres: `
    INSERT INTO public.transactions (id, user_id, account_id, description, amount, type, date,
                                     category, is_cleared, is_reconciled, updated_at) VALUES
      ('${MARKED_ROW}',    '${USER}', '${EVERYDAY}', 'Ticked',   -1.00, 'expense', '2024-01-15', '${WEEKLY_SHOP}', true, false, '2019-01-01T00:00:00Z'),
      ('${COMMITTED_ROW}', '${USER}', '${EVERYDAY}', 'Settled',  -1.00, 'expense', '2024-01-16', '${WEEKLY_SHOP}', true, true,  '2019-01-01T00:00:00Z'),
      ('${PRE_SPLIT_ROW}', '${USER}', '${EVERYDAY}', 'Historic', -1.00, 'expense', '2024-01-17', '${WEEKLY_SHOP}', true, NULL,  '2019-01-01T00:00:00Z');
    UPDATE public.accounts SET balance = balance - 3.00 WHERE id = '${EVERYDAY}';`,
};

/**
 * Everyday archived through 2024-02-28 — after the three planted rows and
 * before the base fixture's Corner shop.
 *
 * A cutoff on its own archives nothing: it is the ACCOUNT saying "everything
 * before this is archived", and A-3's sweep is what fills it in one row at a
 * time as each is committed. That is why this fragment is separate from the
 * rows: several specs need the cutoff without needing anything already hidden.
 */
export const archivedThroughFebruary = {
  sqlite: `UPDATE accounts SET archive_through_date = '2024-02-28' WHERE id = '${EVERYDAY}';`,
  postgres: `UPDATE public.accounts SET archive_through_date = '2024-02-28'
              WHERE id = '${EVERYDAY}';`,
};

/** Everyday, re-typed as an investment account. Nothing else changes. */
export const everydayIsAnInvestment = {
  sqlite: `UPDATE accounts SET type = 'investment' WHERE id = '${EVERYDAY}';`,
  postgres: `UPDATE public.accounts SET type = 'investment' WHERE id = '${EVERYDAY}';`,
};

// ── Preferences ─────────────────────────────────────────────────────────────
//
// The one table in the schema whose contents neither engine reads. Everything
// below therefore asks about the DOCUMENT rather than about a column: how many
// documents this file holds, and what one key inside one of them says.

/** A document already in the file for the base fixture's login. */
export function preferencesAlready(document) {
  const json = JSON.stringify(document);
  return {
    sqlite: `INSERT INTO user_preferences (id, user_id, prefs)
               VALUES ('e0000000-0000-0000-0000-000000000001', '${USER}', '${json}');`,
    postgres: `INSERT INTO public.user_preferences (user_id, prefs)
                 VALUES ('${USER}', '${json}'::jsonb);`,
  };
}

/** A document belonging to the OTHER login. Needs `secondUser` in the setup. */
export function strangerPreferences(document) {
  const json = JSON.stringify(document);
  return {
    sqlite: `INSERT INTO user_preferences (id, user_id, prefs)
               VALUES ('e0000000-0000-0000-0000-000000000002', '${STRANGER}', '${json}');`,
    postgres: `INSERT INTO public.user_preferences (user_id, prefs)
                 VALUES ('${STRANGER}', '${json}'::jsonb);`,
  };
}

/** How many preference documents the whole file holds, across every login. */
export function preferenceDocuments(expect) {
  return {
    name: 'preference_documents',
    sqlite: 'SELECT COUNT(*) FROM user_preferences',
    postgres: 'SELECT COUNT(*) FROM public.user_preferences',
    expect,
  };
}

/**
 * One setting, read out of one login's stored document.
 *
 * `(none)` rather than NULL when the key is absent, so that "this document does
 * not have that key" and "there is no document" stay different observations —
 * the second comes back as the runner's own NULL.
 */
export function settingOf(userId, key, expect) {
  return {
    name: `setting_${key}_of_${userId.slice(-4)}`,
    sqlite: `SELECT COALESCE(json_extract(prefs, '$.values.${key}'), '(none)')
               FROM user_preferences WHERE user_id = '${userId}'`,
    postgres: `SELECT COALESCE(prefs->'values'->>'${key}', '(none)')
                 FROM public.user_preferences WHERE user_id = '${userId}'`,
    expect,
  };
}


// ── Holdings ────────────────────────────────────────────────────────────────
//
// The last family to join this harness, and the only one whose rows carry TWO
// fixed-point scales. `cost_basis` is money at 1e2; `quantity`,
// `current_price` and `purchase_price` are at 1e8 — `crate::scaled` argues why,
// and the short version is that a share price is a RATE rather than an amount,
// and rounding a rate before multiplying it by a quantity is how a portfolio
// comes to disagree with the broker.
//
// Both engines therefore render three columns with the EIGHT-place helper and
// one with the two-place one, and a spec that mixed them up would compare
// '32.775' against '32.77500000' and call the engines divergent.

/** The two positions the read specs list. */
export const LISTED_HOLDING = 'd0000000-0000-0000-0000-00000000d001';
export const SECOND_HOLDING = 'd0000000-0000-0000-0000-00000000d002';
/** A holding a WRITE spec creates, so both engines can name one row. */
export const NEW_HOLDING = 'd0000000-0000-0000-0000-00000000d0f1';

/**
 * Two positions in one investment account, one priced and one never priced.
 *
 * `everydayIsAnInvestment` is NOT applied here: `investments.account_id` has no
 * type constraint in either schema (a holding filed against a savings account
 * is a data error the product prevents upstream, not a rule the store keeps), so
 * a fixture that re-typed the account would be testing a rule that does not
 * exist. What the specs DO exercise is R-12 — the composite key that stops a
 * holding naming a stranger's account — which is a rule both schemas really
 * carry.
 *
 * The unpriced row is the case a UI has to be able to tell from a worthless one:
 * `current_price` NULL means "never priced", and a store that answered 0 there
 * would show a position worth nothing.
 */
export const twoHoldings = {
  sqlite: `
    INSERT INTO investments (id, user_id, account_id, symbol, name, asset_type, currency,
                             quantity_e8, cost_basis_minor, current_price_e8, purchase_date,
                             purchase_price_e8, last_updated, notes, created_at, updated_at) VALUES
      ('${LISTED_HOLDING}', '${USER}', '${EVERYDAY}', 'AAAA.L', 'A Listed Company plc',
       'stock', 'GBP', 10000000000, 327750, 4000000000, '2024-06-01',
       3277500000, '2024-06-30T17:00:00.000Z', 'held in the ISA',
       '${OPENED_FIRST}', '${OPENED_FIRST}'),
      ('${SECOND_HOLDING}', '${USER}', '${EVERYDAY}', 'BBBB.L', 'Another Company plc',
       'etf', 'GBP', 500000000, 25000, NULL, NULL,
       NULL, NULL, NULL, '${OPENED_SECOND}', '${OPENED_SECOND}');`,
  postgres: `
    INSERT INTO public.investments (id, user_id, account_id, symbol, name, asset_type, currency,
                                    quantity, cost_basis, current_price, purchase_date,
                                    purchase_price, last_updated, notes, created_at, updated_at) VALUES
      ('${LISTED_HOLDING}', '${USER}', '${EVERYDAY}', 'AAAA.L', 'A Listed Company plc',
       'stock', 'GBP', 100.00000000, 3277.50, 40.00000000, '2024-06-01',
       32.77500000, '2024-06-30T17:00:00.000Z', 'held in the ISA',
       '${OPENED_FIRST}', '${OPENED_FIRST}'),
      ('${SECOND_HOLDING}', '${USER}', '${EVERYDAY}', 'BBBB.L', 'Another Company plc',
       'etf', 'GBP', 5.00000000, 250.00, NULL, NULL,
       NULL, NULL, NULL, '${OPENED_SECOND}', '${OPENED_SECOND}');`,
};

/** A holding belonging to the SECOND user, so a read can prove it is not listed. */
export const strangersHolding = {
  sqlite: `
    INSERT INTO investments (id, user_id, symbol, name, asset_type, currency,
                             quantity_e8, cost_basis_minor)
      VALUES ('d0000000-0000-0000-0000-00000000d009', '${STRANGER}', 'AAAA.L', 'Theirs',
              'stock', 'GBP', 100000000, 10000);`,
  postgres: `
    INSERT INTO public.investments (id, user_id, symbol, name, asset_type, currency,
                                    quantity, cost_basis)
      VALUES ('d0000000-0000-0000-0000-00000000d009', '${STRANGER}', 'AAAA.L', 'Theirs',
              'stock', 'GBP', 1.00000000, 100.00);`,
};

/** One holding, in the fourteen keys `crate::row::investment::InvestmentRow` serialises. */
export function listedInvestment(fields) {
  return {
    id: '',
    user_id: USER,
    account_id: null,
    symbol: '',
    name: '',
    asset_type: 'stock',
    currency: 'GBP',
    quantity: '0.00000000',
    cost_basis: '0.00',
    current_price: null,
    purchase_date: null,
    purchase_price: null,
    last_updated: null,
    notes: null,
    ...fields,
  };
}

/**
 * One holding as a colon-joined shape, so a whole row is one comparison.
 *
 * `budgetShape` and `goalShape`'s arrangement, with the one addition this family
 * needs: THREE of the six figures are rendered at eight places and one at two,
 * because that is what the columns are. A shape that rendered them all with the
 * money helper would report `32.775` for the cloud and `32.77` for the file and
 * call it a divergence.
 */
export function investmentShape(holdingId, expect) {
  const build = (engine) => {
    const sqlite = engine === 'sqlite';
    const table = sqlite ? 'investments' : 'public.investments';
    const quantity = sqlite ? scaledToDecimal('i.quantity_e8') : scaledNumericToDecimal('i.quantity');
    const cost = sqlite ? minorToDecimal('i.cost_basis_minor') : numericToDecimal('i.cost_basis');
    const price = sqlite
      ? `COALESCE(${scaledToDecimal('i.current_price_e8')}, '-')`
      : `COALESCE(${scaledNumericToDecimal('i.current_price')}, '-')`;
    const unit = sqlite
      ? `COALESCE(${scaledToDecimal('i.purchase_price_e8')}, '-')`
      : `COALESCE(${scaledNumericToDecimal('i.purchase_price')}, '-')`;
    // `::text` is Postgres-only — see [`budgetShape`].
    const asText = (column) => (sqlite ? column : `${column}::text`);
    // THE LAST FOUR CHARACTERS, spelled per engine, and it is not a style
    // choice: SQLite's `substr(x, -4)` counts from the END and Postgres's counts
    // from a position BEFORE the start, so the same expression answers the last
    // four on one engine and the whole uuid on the other. `transferShape` and
    // `accountsAudited` already spell it this way; `goalShape` does not, and it
    // is only green because no goal spec has yet asserted a shape with a real
    // `account_id` in it.
    const last4 = (column) => (sqlite
      ? `COALESCE(substr(${column}, -4), '-')`
      : `COALESCE(right(${column}::text, 4), '-')`);
    const row = `i.symbol || ':' || i.name || ':' || ${quantity} || ':' || ${cost}
                 || ':' || ${price} || ':' || ${unit}
                 || ':' || i.asset_type || ':' || i.currency
                 || ':' || COALESCE(${asText('i.purchase_date')}, '-')
                 || ':' || ${last4('i.account_id')}
                 || ':' || COALESCE(i.notes, '-')`;
    return `SELECT COALESCE((SELECT ${row} FROM ${table} i WHERE i.id = '${holdingId}'), 'GONE')`;
  };
  return {
    name: `investment_shape_${holdingId.slice(-4)}`,
    sqlite: build('sqlite'),
    postgres: build('postgres'),
    expect,
  };
}

/** How many holdings one login has. */
export function holdingsOwnedBy(userId, expect) {
  return {
    name: `holdings_owned_by_${userId.slice(-4)}`,
    sqlite: `SELECT COUNT(*) FROM investments WHERE user_id = '${userId}'`,
    postgres: `SELECT COUNT(*) FROM public.investments WHERE user_id = '${userId}'`,
    expect,
  };
}

/**
 * Whether a holding stores a MARKET VALUE, which neither engine may.
 *
 * The column exists in both schemas and nothing writes it, on purpose: it is
 * quantity × price, and a stored copy of a derived number is a copy that goes
 * stale — so a holding could display a value its own price contradicts. Asserted
 * rather than assumed, because `schema.sql`'s own comment anticipated storing it
 * and a later reader could take that as an instruction.
 */
export function marketValuesStored(expect) {
  return {
    name: 'market_values_stored',
    sqlite: 'SELECT COUNT(*) FROM investments WHERE market_value_minor IS NOT NULL',
    postgres: 'SELECT COUNT(*) FROM public.investments WHERE market_value IS NOT NULL',
    expect,
  };
}
