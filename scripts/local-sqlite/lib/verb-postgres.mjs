// Postgres side of the VERB harness: the real cloud RPC, called with the same
// payload the Rust bridge receives.
//
// The payload is not translated. `create_transaction_atomic(p jsonb)` and
// `wealth-core-cli`'s `create_transaction` take the same key names, because the
// Rust command struct was written from the RPC's column list. That is the whole
// bridge: one JSON object, two engines. If a spec ever needed to send different
// payloads, the two things would not be implementations of one verb.
//
// Everything else follows lib/postgres.mjs: the same cluster from
// scripts/local-db/up.sh, the same WT_PGDATA / WT_PGPORT / LC_ALL=C conventions,
// psql driven directly because the shell harness's grep-the-output shape cannot
// report accepted-vs-refused per statement.
//
// NOTHING under scripts/local-db is modified.

import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SETUP_OK = '__SETUP_OK__';
const ROW = '__ROW__';
const ERR = '__ERR__';
const STATE = '__STATE__';

// The canonical projection of a WRITE'S ANSWER. Money as a decimal string
// (numeric(20,2)::text is exact and involves no rounding function), date as
// text, tags as a JSON array. The Rust side produces the same key set from its
// own storage, and the runner compares the two objects field by field.
//
// IT IS THE TWIN OF THE RESULT PROJECTION, NOT OF THE AUDIT ONE, and since slice
// 27 those are two different field sets. `crate::row::WrittenTransaction` is the
// audit row plus `needs_review`; `crate::row::TransactionRow` is what the audit
// chain records and is unchanged. This projects the first, because what these
// specs compare is what a verb ANSWERED — and the audit payload has assertions
// of its own (`auditedRows`, and the crate's own
// `the_audit_payload_is_not_the_answer_and_does_not_carry_the_flag`).
//
// `is_reconciled` is projected as ITSELF and not through a COALESCE, and that is
// the point of it being here: the column is three-valued on both engines — NULL
// means "this row predates the split between marking and committing; ask
// is_cleared" — and the three states are exactly what the two implementations
// have to agree about. A projection that resolved the NULL would pass whether or
// not the port had kept it.
//
// It is in the reference cluster: 20260810200000_marking_is_not_reconciling.sql
// is applied there, verified by reading information_schema before this line was
// written rather than assumed. `needs_review` is now projected too, on the same
// evidence — schema.sql amendment (6) records that 20260810090000 is confirmed
// applied there — and it arrived with the result projection rather than with the
// column, because until a write's answer carried it there was nothing on the
// SQLite side to compare against.
const ROW_JSON = `jsonb_build_object(
  'id', t.id,
  'user_id', t.user_id,
  'account_id', t.account_id,
  'description', t.description,
  'amount', t.amount::text,
  'type', t.type,
  'date', t.date::text,
  'category', t.category,
  'category_id', t.category_id,
  'notes', t.notes,
  'merchant_name', t.merchant_name,
  'location_city', t.location_city,
  'location_country', t.location_country,
  'payment_channel', t.payment_channel,
  'is_recurring', t.is_recurring,
  'is_cleared', t.is_cleared,
  'is_reconciled', t.is_reconciled,
  'is_split', t.is_split,
  'archived', t.archived,
  'statement_sequence', t.statement_sequence,
  'category_confirmed', t.category_confirmed,
  'transfer_account_id', t.transfer_account_id,
  'linked_transfer_id', t.linked_transfer_id,
  'linked_transfer_split_id', t.linked_transfer_split_id,
  'import_source', t.import_source,
  'import_source_id', t.import_source_id,
  'external_transaction_id', t.external_transaction_id,
  'metadata', t.metadata,
  'tags', COALESCE(to_jsonb(t.tags), '[]'::jsonb),
  'needs_review', t.needs_review
)`;

// ── The reads, whose oracle is a QUERY and not a function ────────────────────
//
// Every other verb in this file names a Postgres function. The nine list reads
// cannot: the cloud reads these tables over PostgREST, so the thing being ported
// is the query the client BUILDS — its `.eq()`s and its `.order()` — and the
// oracle has to be that query written out. Each entry in the READS table below
// names the TypeScript it is transcribed from, and the transcription is
// deliberately literal: same filter, same ORDER BY, same column list.
//
// They live in a TABLE rather than one query per verb because `load_boot` asks
// six of them at once. Two copies of the transactions query — one for the read
// and one for the composite — would be two queries that agree until somebody
// edits the one they happened to find.
//
// This is the same hazard `merge_categories` above declares, and it has the same
// answer: a query repeated in the harness can silently agree with a wrong
// implementation, so what makes it safe is that a disagreement is LOUD. The two
// sides are compared element by element and key by key, and the array's ORDER is
// part of what is compared (`stableJson` sorts object keys and never arrays).
//
// THE TIE-BREAK IS DELIBERATELY ABSENT HERE. The Rust side orders by `…, id`
// behind the cloud's key, states in its own module docs that the second key is
// not a port of anything, and is proved by a single-engine spec. Copying it into
// this oracle would make the harness agree with the port about a thing the cloud
// never said. So these queries carry exactly the client's ORDER BY, and every
// spec that compares them uses a fixture whose sort key is distinct.
//
// ONE READ IS AN EXCEPTION AND IT IS WRITTEN IN: `list_transactions` orders by
// `date DESC, id DESC`, and the second key is the CLOUD's — the client states it
// and calls it, in its own comment, a "stable tiebreak for paging". Fifty-two
// pages of an unstably-ordered query hand the same row over twice and lose
// another, so the cloud had to settle what the other reads could leave open.
// Leaving it out here would be the harness pretending the cloud is vaguer than
// it is.
//
// AND ONE VERB IS NOT A QUERY AT ALL: `account_balances` IS a Postgres function,
// so its oracle is that function, called for real — see its entry below for how
// the identity it takes from a JWT is supplied.
//
// AND ONE IS NOT A QUERY EITHER, THE OTHER WAY ROUND: `load_boot`'s cloud side
// is a TypeScript method, `DataServiceImpl.loadBoot`, whose body is six of these
// reads in the order the boot depended on. Its oracle is therefore those same
// six entries, gathered into one object — see its entry for what the cloud's
// snapshot carries that no database can answer with.

/** A numeric(_,2) column as the decimal string both engines must agree on. */
const money = (expr) => `(${expr})::text`;

/**
 * A `numeric(20,8)` column as the eight-place decimal string the crate answers.
 *
 * Identical to {@link money} in body and separate in NAME on purpose: `::text`
 * on a scaled numeric yields the COLUMN's scale, so which spelling you get
 * depends on which column you asked. A quantity rendered with the money helper
 * still comes back with eight places and still compares correctly — until
 * somebody widens or narrows a column, at which point one call site is right and
 * the other is wrong and nothing says which. Naming them apart is what makes the
 * scale a decision at the call site.
 */
const scaled = (expr) => `(${expr})::text`;

/**
 * A timestamptz as the local edition spells a timestamp.
 *
 * Both engines store the same instant; they render it differently (PostgREST
 * would send `+00:00`, SQLite stores `…Z`) and the app parses either through
 * `new Date()`. Rendering the cloud's in the local spelling keeps the comparison
 * about the INSTANT rather than about two spellings of it — the same decision
 * `numeric::text` makes for money.
 */
const stamp = (expr) => `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * One `accounts` row, in the twenty-five keys `crate::row::account::ListedAccount`
 * serialises.
 *
 * TWO CLOUD COLUMNS ARE DELIBERATELY NOT PROJECTED: `plaid_account_id` and
 * `plaid_connection_id`. A local file has no bank feed, so projecting either
 * would report an absence-by-design as a per-spec divergence.
 *
 * THERE WERE THREE. `last_reconciled_balance` was left out because
 * scripts/local-sqlite/schema.sql predated 20260810200000 and had no column for
 * it — a gap rather than a decision, recorded here and in the crate's
 * `row/account.rs`. Slice 20 closed the gap, so the key is projected and the two
 * engines are compared on it like any other figure.
 */
const ACCOUNT_JSON = `jsonb_build_object(
  'id', a.id,
  'user_id', a.user_id,
  'name', a.name,
  'type', a.type,
  'currency', a.currency,
  'balance', ${money('a.balance')},
  'initial_balance', ${money('a.initial_balance')},
  'bank_balance', ${money('a.bank_balance')},
  'bank_balance_date', a.bank_balance_date::text,
  'last_reconciled_date', a.last_reconciled_date::text,
  'last_reconciled_balance', ${money('a.last_reconciled_balance')},
  'low_balance_alert_enabled', a.low_balance_alert_enabled,
  'low_balance_threshold', ${money('a.low_balance_threshold')},
  'opening_balance_date', a.opening_balance_date::text,
  'archive_through_date', a.archive_through_date::text,
  'parent_account_id', a.parent_account_id,
  'institution', a.institution,
  'account_number', a.account_number,
  'sort_code', a.sort_code,
  'icon', a.icon,
  'color', a.color,
  'notes', a.notes,
  'is_active', a.is_active,
  'metadata', a.metadata,
  'created_at', ${stamp('a.created_at')},
  'updated_at', ${stamp('a.updated_at')}
)`;

/** One `categories` row, in the sixteen keys `CategoryRow` serialises. */
const CATEGORY_JSON = `jsonb_build_object(
  'id', c.id,
  'user_id', c.user_id,
  'name', c.name,
  'type', c.type,
  'level', c.level,
  'parent_id', c.parent_id,
  'account_id', c.account_id,
  'color', c.color,
  'icon', c.icon,
  'is_system', c.is_system,
  'is_transfer_category', c.is_transfer_category,
  'is_revaluation_category', c.is_revaluation_category,
  'is_unassigned_bucket', c.is_unassigned_bucket,
  'is_active', c.is_active,
  'created_at', ${stamp('c.created_at')},
  'updated_at', ${stamp('c.updated_at')}
)`;

/**
 * One `budgets` row, in the eighteen keys `ListedBudget` serialises.
 *
 * `alert_threshold` is the interesting one and it is NOT translated here: the
 * cloud stores numeric(5,2) and casts to `"80.00"`, the local file stores 8000
 * basis points of a percent and the crate renders `"80.00"` from it. Comparing
 * the two texts is what proves the encoding round-trips; converting either side
 * would be the harness agreeing with itself.
 */
const BUDGET_JSON = `jsonb_build_object(
  'id', b.id,
  'user_id', b.user_id,
  'name', b.name,
  'amount', ${money('b.amount')},
  'period', b.period,
  'repeat_count', b.repeat_count,
  'repeat_unit', b.repeat_unit,
  'category', b.category,
  'category_id', b.category_id,
  'start_date', b.start_date::text,
  'end_date', b.end_date::text,
  'spent', ${money('b.spent')},
  'rollover', b.rollover,
  'rollover_amount', ${money('b.rollover_amount')},
  'alert_threshold', ${money('b.alert_threshold')},
  'is_active', b.is_active,
  'notes', b.notes,
  'metadata', b.metadata,
  'created_at', ${stamp('b.created_at')},
  'updated_at', ${stamp('b.updated_at')}
)`;

/** One `goals` row, in the nineteen keys `GoalRow` serialises. */
const GOAL_JSON = `jsonb_build_object(
  'id', g.id,
  'user_id', g.user_id,
  'name', g.name,
  'description', g.description,
  'target_amount', ${money('g.target_amount')},
  'current_amount', ${money('g.current_amount')},
  'target_date', g.target_date::text,
  'category', g.category,
  'priority', g.priority,
  'status', g.status,
  'account_id', g.account_id,
  'contribution_frequency', g.contribution_frequency,
  'auto_contribute', g.auto_contribute,
  'icon', g.icon,
  'color', g.color,
  'completed_at', ${stamp('g.completed_at')},
  'metadata', g.metadata,
  'created_at', ${stamp('g.created_at')},
  'updated_at', ${stamp('g.updated_at')}
)`;

/**
 * One `custom_reports` row, in the eight keys the crate's report row serialises.
 *
 * `components` and `filters` are projected AS THEMSELVES — no `::text`, no
 * `jsonb_pretty`. They are jsonb here and parsed JSON on the Rust side, so what
 * the runner compares is two JSON VALUES; rendering either one to text would
 * compare Postgres's key ordering against serde's, which is a difference about
 * neither engine's behaviour.
 *
 * `description` is projected raw rather than through a COALESCE, because the
 * column is nullable on both engines and "the report has no description" and
 * "it has an empty one" are two states a spec is allowed to tell apart.
 */
const CUSTOM_REPORT_JSON = `jsonb_build_object(
  'id', r.id,
  'user_id', r.user_id,
  'name', r.name,
  'description', r.description,
  'components', r.components,
  'filters', r.filters,
  'created_at', ${stamp('r.created_at')},
  'updated_at', ${stamp('r.updated_at')}
)`;

/**
 * One `investments` row, in the fourteen keys `InvestmentRow` serialises.
 *
 * The cloud's own `SELECTED_COLUMNS` (`investmentService.ts`) plus `user_id`,
 * which every row struct under `crate::row` carries so that an audit entry can
 * say whose row it was.
 *
 * THREE SCALES, AND `money()` IS USED FOR ONLY ONE OF THEM. `cost_basis` is
 * `numeric(10,2)` and is an AMOUNT; `quantity`, `current_price` and
 * `purchase_price` are `numeric(20,8)` and are units and rates. `::text` on a
 * scaled numeric prints the column's OWN scale, so the same helper would answer
 * `'3277.50'` for one and `'32.77500000'` for another — which is correct, and is
 * exactly why the two are named apart at the call site rather than left to
 * whoever reads this next.
 *
 * `market_value` and `exchange` are deliberately absent: neither client has ever
 * written or read either, and the crate's projection does not carry them.
 */
const INVESTMENT_JSON = `jsonb_build_object(
  'id', i.id,
  'user_id', i.user_id,
  'account_id', i.account_id,
  'symbol', i.symbol,
  'name', i.name,
  'asset_type', i.asset_type,
  'currency', i.currency,
  'quantity', ${scaled('i.quantity')},
  'cost_basis', ${money('i.cost_basis')},
  'current_price', ${scaled('i.current_price')},
  'purchase_date', i.purchase_date::text,
  'purchase_price', ${scaled('i.purchase_price')},
  'last_updated', ${stamp('i.last_updated')},
  'notes', i.notes
)`;

/**
 * One `suggestion_dismissals` row, in the five keys `DismissalRow` serialises —
 * which are the five `suggestionDismissalService.list` names in its own
 * `.select()`, and `user_id` is not among them.
 *
 * `subject_ids` is a `uuid[]` here and a child table locally, so the array's
 * ORDER is the whole comparison: `to_jsonb` preserves the stored order, and the
 * local side rebuilds it from `role_order`. A port that read the child table as
 * a set would come back in a different order and be caught here.
 */
const DISMISSAL_JSON = `jsonb_build_object(
  'id', d.id,
  'kind', d.kind,
  'subject_key', d.subject_key,
  'subject_ids', COALESCE(to_jsonb(d.subject_ids), '[]'::jsonb),
  'dismissed_at', ${stamp('d.dismissed_at')}
)`;

/**
 * One `transactions` row, in the twenty-two keys
 * `crate::row::ListedTransaction` serialises — which are now
 * `BOOT_TRANSACTION_COLUMNS` exactly, and NOT `select('*')`.
 *
 * The boot's column list is explicit and measured (~38% of the payload was
 * columns nothing reads), so the ten columns it omits are omitted here too:
 * `user_id`, the metadata blob, `merchant_name`, `location_city`,
 * `location_country`, `payment_channel`, `external_transaction_id`,
 * `import_source`, `import_source_id`, and the feed's `plaid_transaction_id`.
 *
 * ONE CLOUD COLUMN USED TO BE IN THE BOOT LIST AND DELIBERATELY NOT PROJECTED:
 * `is_reconciled`, added by `20260810200000_marking_is_not_reconciling.sql` and
 * not then in `scripts/local-sqlite/schema.sql`. The note said that projecting a
 * key the local answer cannot have would report a schema gap as a per-spec
 * divergence, and that the gap was recorded in the crate's `row.rs` together
 * with what it cost — a local file that cannot tell a marked row from a
 * reconciled one. The column is in both schemas now and is projected here, so
 * every read spec compares Money's C and R rather than only C.
 */
const TRANSACTION_JSON = `jsonb_build_object(
  'id', t.id,
  'account_id', t.account_id,
  'amount', ${money('t.amount')},
  'archived', t.archived,
  'category', t.category,
  'category_confirmed', t.category_confirmed,
  'category_id', t.category_id,
  'created_at', ${stamp('t.created_at')},
  'date', t.date::text,
  'description', t.description,
  'is_cleared', t.is_cleared,
  'is_reconciled', t.is_reconciled,
  'is_recurring', t.is_recurring,
  'is_split', t.is_split,
  'linked_transfer_id', t.linked_transfer_id,
  'linked_transfer_split_id', t.linked_transfer_split_id,
  'needs_review', t.needs_review,
  'notes', t.notes,
  'statement_sequence', t.statement_sequence,
  'tags', COALESCE(to_jsonb(t.tags), '[]'::jsonb),
  'type', t.type,
  'updated_at', ${stamp('t.updated_at')},
  'transfer_account_id', t.transfer_account_id
)`;

/**
 * One `transaction_splits` row, in the eleven keys `ListedSplit` serialises —
 * the whole row, because both split reads are `.select('*')`.
 *
 * The app's own mapper reads eight of the eleven and ignores `user_id`,
 * `created_at` and `updated_at`. That is the app's business: what a read
 * projects is what the query projects, and narrowing it here would be the
 * harness deciding on the app's behalf that a column will never be wanted.
 */
const SPLIT_JSON = `jsonb_build_object(
  'id', s.id,
  'transaction_id', s.transaction_id,
  'user_id', s.user_id,
  'category', s.category,
  'amount', ${money('s.amount')},
  'memo', s.memo,
  'sort_order', s.sort_order,
  'transfer_account_id', s.transfer_account_id,
  'linked_transfer_id', s.linked_transfer_id,
  'created_at', ${stamp('s.created_at')},
  'updated_at', ${stamp('s.updated_at')}
)`;

/** The owner every read is scoped to, as the payload spells it. */
const ownerOf = (payloadLiteral) => `(${payloadLiteral}::jsonb->>'user_id')::uuid`;

/**
 * Every list read, as the (projection, source, order) triple the client's own
 * query is transcribed into. Each entry names the TypeScript it comes from.
 *
 * ONE TABLE RATHER THAN ONE ENTRY PER VERB, because the composite below asks
 * six of these at once and a second copy of any of these queries would be a
 * second query that could drift while the single-read spec it was copied from
 * went on passing. It is the harness-side twin of the rule the crate keeps by
 * calling its own row mappers: there is one copy of each read, and both callers
 * use it.
 */
const READS = {
  // accountService.getAccounts:
  //   .from('accounts').select('*')
  //   .eq('user_id', userId).eq('is_active', true)
  //   .order('created_at', { ascending: true })
  accounts: {
    json: ACCOUNT_JSON,
    from: (p) => `public.accounts a WHERE a.user_id = ${ownerOf(p)} AND a.is_active`,
    order: 'a.created_at',
  },

  // accountService.getClosedAccounts — the same query with `.eq('is_active',
  // false)`, which is why the local edition makes it a second VERB rather than a
  // flag: the two questions are asked from two different places in the app.
  closed_accounts: {
    json: ACCOUNT_JSON,
    from: (p) => `public.accounts a WHERE a.user_id = ${ownerOf(p)} AND NOT a.is_active`,
    order: 'a.created_at',
  },

  // planningService.ensureCategories:
  //   .from('categories').select('*').eq('user_id', userId)
  //   .order('level', { ascending: true }).order('name', { ascending: true })
  //
  // NOT `dataService.listCategories`, which reads browser storage and never
  // touches the cloud — the signed-in boot's category list comes from here. No
  // `is_active` filter: a hidden category still has to resolve for the rows
  // already filed under it.
  //
  // `level` is a text column, so ascending means detail, sub, type. Collation
  // could in principle differ from SQLite's BINARY; these three values are
  // lower-case ASCII, where every collation agrees, and the harness prints a
  // warning if the cluster is not UTF8.
  categories: {
    json: CATEGORY_JSON,
    from: (p) => `public.categories c WHERE c.user_id = ${ownerOf(p)}`,
    order: 'c.level, c.name',
  },

  // InvestmentService.list:
  //   .from('investments').select(SELECTED_COLUMNS).eq('user_id', userId)
  //   .order('symbol', { ascending: true })
  //
  // No filter beyond the owner, and no `account_id` narrowing: the page groups
  // by account in memory, which is `dataPort.ts`'s rule for every read here.
  // `id` behind `symbol` is the crate's own tie-break — the cloud states none,
  // and two positions in one security is the ordinary case rather than a
  // curiosity, so leaving it unstated would make the answer an artefact of a
  // query plan.
  investments: {
    json: INVESTMENT_JSON,
    from: (p) => `public.investments i WHERE i.user_id = ${ownerOf(p)}`,
    order: 'i.symbol, i.id',
  },

  // planningService.getBudgets:
  //   .from('budgets').select('*').eq('user_id', userId)
  //   .order('created_at', { ascending: true })
  // Inactive budgets load too — the service says why in its own comment.
  budgets: {
    json: BUDGET_JSON,
    from: (p) => `public.budgets b WHERE b.user_id = ${ownerOf(p)}`,
    order: 'b.created_at',
  },

  // planningService.getGoals — the same shape as budgets, same order, no status
  // filter.
  goals: {
    json: GOAL_JSON,
    from: (p) => `public.goals g WHERE g.user_id = ${ownerOf(p)}`,
    order: 'g.created_at',
  },

  // planningService.getCustomReports:
  //   .from('custom_reports').select('*')
  //   .eq('user_id', userId).order('created_at', { ascending: true })
  //
  // Oldest first, like the budgets and the goals above: the reports page shows
  // the list somebody built in the order they built it, so a new report appears
  // at the bottom rather than jumping to the top of a list they were reading.
  custom_reports: {
    json: CUSTOM_REPORT_JSON,
    from: (p) => `public.custom_reports r WHERE r.user_id = ${ownerOf(p)}`,
    order: 'r.created_at',
  },

  // suggestionDismissalService.list:
  //   .from('suggestion_dismissals')
  //   .select('id, kind, subject_key, subject_ids, dismissed_at')
  //   .eq('user_id', userId).order('dismissed_at', { ascending: false })
  suggestion_dismissals: {
    json: DISMISSAL_JSON,
    from: (p) => `public.suggestion_dismissals d WHERE d.user_id = ${ownerOf(p)}`,
    order: 'd.dismissed_at DESC',
  },

  // transactionService.fetchTransactionPage — the query the signed-in boot
  // actually runs:
  //   .from('transactions').select(BOOT_TRANSACTION_COLUMNS)
  //   .eq('user_id', userId)
  //   .order('date', { ascending: false })
  //   .order('id', { ascending: false })    // stable tiebreak for paging
  //   .range(from, to)
  //
  // NO ARCHIVED FILTER, and that is the query rather than an omission here: the
  // archive is a VIEW flag, the flag rides back as a column, and the register
  // does its hiding in memory. It is the same fact `account_balances` below
  // states from the other end, and R-1 is what happens when one of the two
  // forgets it.
  //
  // The `.range()` is not transcribed because it is not part of the question: it
  // is PostgREST's 1,000-row response cap, which the client walks ~52 times to
  // ask ONE thing. A file answers it once (DESIGN's "one crossing"), and a
  // harness that paged would be comparing the transport rather than the read.
  transactions: {
    json: TRANSACTION_JSON,
    from: (p) => `public.transactions t WHERE t.user_id = ${ownerOf(p)}`,
    order: 't.date DESC, t.id DESC',
  },

  // transactionService.getAllTransactionSplits:
  //   .from('transaction_splits').select('*').eq('user_id', userId)
  //   .order('transaction_id').order('sort_order')
  //
  // `user_id` here is the LINE's owner and not the parent's. The two are usually
  // one person and the schema does not require it — `myLineOnTheirParent` in the
  // shared fixtures exists because `merge_categories` walks parents by one and
  // lines by the other — so filtering on the parent instead would be a different
  // question with the same name.
  transaction_splits: {
    json: SPLIT_JSON,
    from: (p) => `public.transaction_splits s WHERE s.user_id = ${ownerOf(p)}`,
    order: 's.transaction_id, s.sort_order',
  },

  // transactionService.getTransactionSplits(transactionId):
  //   .from('transaction_splits').select('*')
  //   .eq('transaction_id', transactionId).order('sort_order')
  //
  // THE OWNER FILTER BELOW IS TRANSCRIBED FROM THE RLS POLICY, NOT THE CLIENT.
  // That query names no owner at all, because it does not have to: the policy on
  // this table is `user_id = requesting_user_id()` (20260713100000:57-60), so in
  // production every row this returns has already been through it. The harness
  // runs as a superuser with RLS out of the way, so leaving the filter out would
  // make the oracle answer a question production never asks — and would report
  // the local edition's only-gate owner check as a divergence. Both halves of
  // the cloud's real behaviour, written down.
  splits: {
    json: SPLIT_JSON,
    from: (p) => `public.transaction_splits s
        WHERE s.transaction_id = (${p}::jsonb->>'transaction_id')::uuid
          AND s.user_id = ${ownerOf(p)}`,
    order: 's.sort_order',
  },
};

/** One read's rows, aggregated into a JSON array in the order it states. */
const aggregated = (key, payloadLiteral) =>
  `(SELECT COALESCE(jsonb_agg(${READS[key].json} ORDER BY ${READS[key].order}), '[]'::jsonb)
      FROM ${READS[key].from(payloadLiteral)})`;

/** A read's answer: one named key holding the list, or an empty list. */
const listed = (key, payloadLiteral) =>
  `SELECT jsonb_build_object('${key}', ${aggregated(key, payloadLiteral)}) INTO v_row;`;

/**
 * One owner's stored preferences document, or SQL NULL when there is no row.
 *
 * The `.select('prefs').eq('user_id', …).maybeSingle()` half of
 * `supabasePreferencesTransport`, as a scalar subquery — written once because
 * BOTH preferences verbs project it and a second copy is a second answer
 * waiting to disagree with the first. `jsonb_build_object` turns SQL NULL into
 * JSON null, which is exactly what `maybeSingle()`'s `data === null` becomes by
 * the time the transport has finished with it.
 */
const STORED_PREFERENCES = (payloadLiteral) =>
  `(SELECT p.prefs FROM public.user_preferences p
     WHERE p.user_id = NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid)`;

/**
 * The six reads `DataServiceImpl.loadBoot` composes, in the order it makes them.
 *
 * The order is carried here for readability only: this oracle asks them in one
 * statement and the crate asks them in one transaction, so neither side has a
 * "before" inside the composite for anything to observe. That is exactly what
 * the contract suite's BOOT_COMPOSITION table declares — `fansOut: true` for the
 * cloud, where the ordering rules are proved by holding one read and watching
 * whether the next starts, and `fansOut: false` for the local core, where they
 * cannot be broken.
 */
const BOOT_READS = [
  'accounts',
  'categories',
  'transactions',
  'transaction_splits',
  'budgets',
  'goals',
  'custom_reports',
];

/**
 * The RPC each verb maps onto, and how its result is projected.
 *
 * create takes ONE jsonb argument, so its payload is passed straight through.
 * update and delete take theirs POSITIONALLY — `(p_id, p, p_user_id)` and
 * `(p_id, p_user_id)` — and there is exactly one honest way to keep the "one
 * payload, both engines" rule while calling them: unpack the same object here.
 * The Rust command structs have the same three (and two) fields for the same
 * reason, so neither engine is handed a shape the other never saw.
 *
 * `COALESCE(… ->'patch', '{}')` because an absent patch is an empty patch on
 * both sides; `NULLIF(… ->>'user_id','')` because an absent owner is SQL NULL,
 * which is what makes `p_user_id IS NULL OR user_id = p_user_id` stand down.
 *
 * THE SPLIT WRITER IS PROJECTED, NOT RETURNED
 * -------------------------------------------
 * `set_transaction_splits_with_legs` returns `{is_split, split_count, amount,
 * counterparts}` and no transaction row, so there is nothing for the runner's
 * field-by-field row comparison to bite on. It is therefore PERFORMed and the
 * split PARENT is projected afterwards, through the same `ROW_JSON` every other
 * verb uses. That is not a translation of the result — the parent is a row both
 * engines store, read from storage on both sides after the call — and everything
 * the RPC's own return value carries (the line set, the counterparts, the
 * balances they moved) is asserted through `state` SELECTs written per engine,
 * which is where cross-engine comparisons of *rows* belong.
 *
 * `p_splits` is passed with `->` and NOT coalesced: an absent key must arrive as
 * SQL NULL so that the RPC's first refusal — "p_splits must be a jsonb array" —
 * is reachable from a payload rather than smoothed over by the driver.
 *
 * THE TRANSFER FAMILY IS PROJECTED TOO, AND WHICH ROW IS PART OF THE CONTRACT
 * --------------------------------------------------------------------------
 * All five return jsonb objects (or, for clear_transfer_links, a bare integer),
 * so like the split writer they are PERFORMed and one row is projected
 * afterwards through the same ROW_JSON. The row picked is the one the Rust side
 * returns under its own `transaction` key, so the two engines are compared on
 * the same row rather than on whichever each found convenient:
 *
 *   link_transfer_pair            id_a            (the RPC's `a`)
 *   create_transfer_counterpart   id              (the RPC's `source`)
 *   clear_transfer_links          ids[0]          (the first row NAMED)
 *   repair_claimed_transfer       stranded_id     (the RPC's `stranded`)
 *   link_split_line_transfer      transaction_id  (the RPC's `transaction`)
 *
 * Everything the projection cannot carry — the other side, the minted
 * counterpart, the line set, the balances, the unlink count — is asserted
 * through `state` SELECTs written per engine, which is where cross-engine
 * comparisons of rows belong.
 *
 * `p_ids` is rebuilt as a real uuid[] rather than passed as jsonb: the RPC's
 * signature takes an array and the whole point of its first two guarantees
 * (all-or-nothing, DISTINCT) is array-shaped. A NULL `ids` and an absent one
 * both arrive as the empty array, which the RPC treats identically to NULL
 * (`array_length(…, 1) IS NULL` is true for `{}`), so the distinction the RPC's
 * first line draws is unobservable from here and nothing is lost.
 */
const VERBS = {
  create_transaction: (payloadLiteral) =>
    `SELECT ${ROW_JSON} INTO v_row
       FROM public.create_transaction_atomic(${payloadLiteral}::jsonb) t;`,

  update_transaction: (payloadLiteral) =>
    `SELECT ${ROW_JSON} INTO v_row
       FROM public.update_transaction_atomic(
              (${payloadLiteral}::jsonb->>'id')::uuid,
              COALESCE(${payloadLiteral}::jsonb->'patch', '{}'::jsonb),
              NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid
            ) t;`,

  delete_transaction: (payloadLiteral) =>
    `SELECT ${ROW_JSON} INTO v_row
       FROM public.delete_transaction_atomic(
              (${payloadLiteral}::jsonb->>'id')::uuid,
              NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid
            ) t;`,

  set_transaction_splits_with_legs: (payloadLiteral) =>
    `PERFORM public.set_transaction_splits_with_legs(
               (${payloadLiteral}::jsonb->>'id')::uuid,
               ${payloadLiteral}::jsonb->'splits',
               NULLIF(${payloadLiteral}::jsonb->>'expected_amount', '')::numeric,
               NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid
             );
     SELECT ${ROW_JSON} INTO v_row
       FROM public.transactions t
      WHERE t.id = (${payloadLiteral}::jsonb->>'id')::uuid;`,

  link_transfer_pair: (payloadLiteral) =>
    `PERFORM public.link_transfer_pair(
               (${payloadLiteral}::jsonb->>'id_a')::uuid,
               (${payloadLiteral}::jsonb->>'id_b')::uuid,
               NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid
             );
     SELECT ${ROW_JSON} INTO v_row
       FROM public.transactions t
      WHERE t.id = (${payloadLiteral}::jsonb->>'id_a')::uuid;`,

  create_transfer_counterpart: (payloadLiteral) =>
    `PERFORM public.create_transfer_counterpart(
               (${payloadLiteral}::jsonb->>'id')::uuid,
               (${payloadLiteral}::jsonb->>'target_account_id')::uuid,
               NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid
             );
     SELECT ${ROW_JSON} INTO v_row
       FROM public.transactions t
      WHERE t.id = (${payloadLiteral}::jsonb->>'id')::uuid;`,

  // The family's sixth, and the newest function in the schema. The third
  // argument has a DEFAULT in SQL and the local verb defaults it in serde, so
  // the COALESCE here is what keeps a payload that omits it meaning the same
  // thing on both sides rather than passing SQL NULL into a text parameter.
  repoint_transfer: (payloadLiteral) =>
    `PERFORM public.repoint_transfer(
               (${payloadLiteral}::jsonb->>'id')::uuid,
               (${payloadLiteral}::jsonb->>'target_account_id')::uuid,
               COALESCE(${payloadLiteral}::jsonb->>'disposition', 'move'),
               NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid
             );
     SELECT ${ROW_JSON} INTO v_row
       FROM public.transactions t
      WHERE t.id = (${payloadLiteral}::jsonb->>'id')::uuid;`,

  clear_transfer_links: (payloadLiteral) =>
    `PERFORM public.clear_transfer_links(
               ARRAY(SELECT x::uuid
                       FROM jsonb_array_elements_text(
                              COALESCE(${payloadLiteral}::jsonb->'ids', '[]'::jsonb)) AS x),
               NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid
             );
     SELECT ${ROW_JSON} INTO v_row
       FROM public.transactions t
      WHERE t.id = (${payloadLiteral}::jsonb->'ids'->>0)::uuid;`,

  // ── THE RECONCILIATION AND ARCHIVE FAMILY ──────────────────────────────────
  //
  // Five RPCs, and they split two ways in how they are compared:
  //
  //   * the two `set_transactions_*` return a bare integer and DO change a
  //     transaction, so they are PERFORMed and the row the caller named first is
  //     projected — the clear_transfer_links shape, and the projected row is
  //     `ids[0]` for the same reason: it is the row the Rust side answers with
  //     under its own `transaction` key;
  //   * the other three return jsonb objects of their own, so like the restore
  //     family they are compared on that object and everything it cannot carry
  //     (which rows moved, what the account now records, the audit trail) is
  //     asserted through `state` SELECTs.
  //
  // `finalize_reconciliation` is the one whose ANSWER is not passed through
  // verbatim: its `ending_balance` comes back as a jsonb number from
  // `jsonb_build_object('ending_balance', p_ending_balance)`, and money crosses
  // this boundary as a decimal STRING on the Rust side. `::text` on the numeric
  // is exact and involves no rounding function, so the two agree without either
  // going through a float — the same rule ROW_JSON follows for `amount`.
  //
  // THE RE-RENDER IS A SECOND STATEMENT, AND IT HAS TO BE. The first draft
  // wrapped the call — `jsonb_set(finalize_reconciliation(…), '{ending_balance}',
  // to_jsonb(<the payload's figure>::text))` — and the spec for an absent ending
  // balance came back `ok` from a function whose first act is to raise. MEASURED
  // in psql: `jsonb_set` is STRICT, so when one of its arguments is NULL
  // Postgres skips evaluating the others and NEVER CALLS the RPC at all. A
  // wrapper that can stop the function under test from running is a driver that
  // reports on a call that did not happen, which is the worst thing this harness
  // could do. So the RPC is called on its own line, and the figure is re-rendered
  // out of ITS OWN answer afterwards.
  //
  // `p_ending_balance` is passed with `->>` and NULLIF'd, deliberately: an
  // absent key must arrive as SQL NULL so the RPC's first refusal —
  // `ending_balance_required` — stays reachable from a payload.
  set_transactions_cleared: (payloadLiteral) =>
    `PERFORM public.set_transactions_cleared(
               ARRAY(SELECT x::uuid
                       FROM jsonb_array_elements_text(
                              COALESCE(${payloadLiteral}::jsonb->'ids', '[]'::jsonb)) AS x),
               (${payloadLiteral}::jsonb->>'cleared')::boolean,
               NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid
             );
     SELECT ${ROW_JSON} INTO v_row
       FROM public.transactions t
      WHERE t.id = (${payloadLiteral}::jsonb->'ids'->>0)::uuid;`,

  set_transactions_archived: (payloadLiteral) =>
    `PERFORM public.set_transactions_archived(
               ARRAY(SELECT x::uuid
                       FROM jsonb_array_elements_text(
                              COALESCE(${payloadLiteral}::jsonb->'ids', '[]'::jsonb)) AS x),
               (${payloadLiteral}::jsonb->>'archived')::boolean,
               NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid
             );
     SELECT ${ROW_JSON} INTO v_row
       FROM public.transactions t
      WHERE t.id = (${payloadLiteral}::jsonb->'ids'->>0)::uuid;`,

  finalize_reconciliation: (payloadLiteral) =>
    `SELECT public.finalize_reconciliation(
              NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid,
              (${payloadLiteral}::jsonb->>'account_id')::uuid,
              NULLIF(${payloadLiteral}::jsonb->>'ending_balance', '')::numeric,
              NULLIF(${payloadLiteral}::jsonb->>'reconciled_on', '')::date)
       INTO v_row;
     v_row := jsonb_set(v_row, '{ending_balance}',
                        to_jsonb((v_row->>'ending_balance')::numeric::text));`,

  archive_transactions_before: (payloadLiteral) =>
    `SELECT public.archive_transactions_before(
              NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid,
              (${payloadLiteral}::jsonb->>'account_id')::uuid,
              NULLIF(${payloadLiteral}::jsonb->>'cutoff', '')::date)
       INTO v_row;`,

  unarchive_account: (payloadLiteral) =>
    `SELECT public.unarchive_account(
              NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid,
              (${payloadLiteral}::jsonb->>'account_id')::uuid)
       INTO v_row;`,

  repair_claimed_transfer: (payloadLiteral) =>
    `PERFORM public.repair_claimed_transfer(
               (${payloadLiteral}::jsonb->>'stranded_id')::uuid,
               (${payloadLiteral}::jsonb->>'counterpart_id')::uuid,
               (${payloadLiteral}::jsonb->>'partner_id')::uuid,
               ${payloadLiteral}::jsonb->>'adjustment_category_id',
               NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid
             );
     SELECT ${ROW_JSON} INTO v_row
       FROM public.transactions t
      WHERE t.id = (${payloadLiteral}::jsonb->>'stranded_id')::uuid;`,

  link_split_line_transfer: (payloadLiteral) =>
    `PERFORM public.link_split_line_transfer(
               (${payloadLiteral}::jsonb->>'split_id')::uuid,
               (${payloadLiteral}::jsonb->>'transaction_id')::uuid,
               NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid
             );
     SELECT ${ROW_JSON} INTO v_row
       FROM public.transactions t
      WHERE t.id = (${payloadLiteral}::jsonb->>'transaction_id')::uuid;`,

  // THE CATEGORY FAMILY, AND THE ROW EACH ONE IS COMPARED ON
  // -------------------------------------------------------
  // merge_categories has no transaction id in its payload, so there is nothing
  // to name the way clear_transfer_links names `ids[0]`. The row picked is the
  // one the Rust side returns under its own `transaction` key — the FIRST whole
  // transaction the merge moves, in id order — and it is captured HERE by the
  // same predicate the RPC's own first loop uses, BEFORE the call, because
  // afterwards those rows point at the target and are indistinguishable from
  // rows that always did.
  //
  // Repeating the loop's WHERE clause in the harness is exactly the sort of
  // thing that can silently agree with a wrong implementation, so it is worth
  // saying why it is safe: if the two sides pick different rows, `row.id`
  // differs and the runner reports a divergence. A mismatch is loud, not
  // absorbed. Everything the projection cannot carry — the five counts, the
  // split lines, the budgets, the recurring templates, the audit shape and the
  // fact the source category is gone — is asserted through `state` SELECTs.
  //
  // `p_source_id` is read with `->>` and cast WITHOUT NULLIF, deliberately: a
  // JSON null must arrive as SQL NULL so the RPC's first refusal
  // (merge_needs_two_categories) is reachable from a payload.
  merge_categories: (payloadLiteral) =>
    `SELECT t.id INTO v_first
       FROM public.transactions t
      WHERE t.user_id = (SELECT c.user_id FROM public.categories c
                          WHERE c.id = (${payloadLiteral}::jsonb->>'source_id')::uuid)
        AND (t.category = ${payloadLiteral}::jsonb->>'source_id'
          OR t.category_id = (${payloadLiteral}::jsonb->>'source_id')::uuid)
      ORDER BY t.id
      LIMIT 1;
     PERFORM public.merge_categories(
               (${payloadLiteral}::jsonb->>'source_id')::uuid,
               (${payloadLiteral}::jsonb->>'target_id')::uuid,
               NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid
             );
     SELECT ${ROW_JSON} INTO v_row
       FROM public.transactions t
      WHERE t.id = v_first;`,

  // The two provenance verbs take `p_ids uuid[]`, so they follow
  // clear_transfer_links exactly: the array is rebuilt as a real uuid[] and the
  // row projected is `ids[0]`, the first row the CALLER named. A NULL `ids` and
  // an absent one both arrive as the empty array, which `id = ANY('{}')` matches
  // nothing for — the same zero the RPC returns either way.
  //
  // `p_category` is passed with `->>` and NOT coalesced: this function stores
  // whatever it is given, SQL NULL included, and smoothing that over in the
  // driver would hide a measured behaviour.
  apply_category_to_uncategorized: (payloadLiteral) =>
    `PERFORM public.apply_category_to_uncategorized(
               ARRAY(SELECT x::uuid
                       FROM jsonb_array_elements_text(
                              COALESCE(${payloadLiteral}::jsonb->'ids', '[]'::jsonb)) AS x),
               ${payloadLiteral}::jsonb->>'category',
               NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid
             );
     SELECT ${ROW_JSON} INTO v_row
       FROM public.transactions t
      WHERE t.id = (${payloadLiteral}::jsonb->'ids'->>0)::uuid;`,

  // The fan-out's suggesting twin (20260911100000): identical wiring, and the
  // same non-coalescing of `p_category`, for the same reason.
  suggest_category_to_uncategorized: (payloadLiteral) =>
    `PERFORM public.suggest_category_to_uncategorized(
               ARRAY(SELECT x::uuid
                       FROM jsonb_array_elements_text(
                              COALESCE(${payloadLiteral}::jsonb->'ids', '[]'::jsonb)) AS x),
               ${payloadLiteral}::jsonb->>'category',
               NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid
             );
     SELECT ${ROW_JSON} INTO v_row
       FROM public.transactions t
      WHERE t.id = (${payloadLiteral}::jsonb->'ids'->>0)::uuid;`,

  // The prune returns a bare integer and touches no transaction, so — like the
  // restore family — it is compared on its OWN answer, wrapped in an object so
  // the shape matches the Rust side's `answer`. Everything the count cannot
  // carry (which categories survived, which references were left dangling by the
  // cascade, that nothing was audited) is asserted through `state` SELECTs.
  //
  // `p_ids` is rebuilt as a real uuid[] for the reason clear_transfer_links
  // gives: the signature takes an array. A NULL `ids` and an absent one both
  // arrive as the empty array, and MEASURED (`probe-prune1.sh` `p-null-array`,
  // `p-empty-array`) the RPC answers 0 to both and to NULL, so nothing is lost.
  delete_unused_categories: (payloadLiteral) =>
    `SELECT jsonb_build_object(
              'deleted',
              public.delete_unused_categories(
                ARRAY(SELECT x::uuid
                        FROM jsonb_array_elements_text(
                               COALESCE(${payloadLiteral}::jsonb->'ids', '[]'::jsonb)) AS x),
                NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid))
       INTO v_row;`,

  confirm_transaction_categories: (payloadLiteral) =>
    `PERFORM public.confirm_transaction_categories(
               ARRAY(SELECT x::uuid
                       FROM jsonb_array_elements_text(
                              COALESCE(${payloadLiteral}::jsonb->'ids', '[]'::jsonb)) AS x),
               NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid
             );
     SELECT ${ROW_JSON} INTO v_row
       FROM public.transactions t
      WHERE t.id = (${payloadLiteral}::jsonb->'ids'->>0)::uuid;`,

  // THE INGEST PAIR IS COMPARED ON ITS OWN ANSWER TOO
  // -------------------------------------------------
  // Both RPCs return jsonb — `{inserted, skipped, idempotent}` and
  // `{inserted, skipped}` — and neither returns a transaction, so like the
  // restore family they are compared on that object and everything it cannot
  // carry (the rows, the balances, the audit trail, which category a guess
  // picked) is asserted through `state` SELECTs.
  //
  // `->'rows'` is NOT coalesced in either, deliberately: an absent key must
  // arrive as SQL NULL so the first refusal — "p_rows must be a jsonb array" —
  // stays reachable from a payload rather than being smoothed over by the
  // driver. The split writer's `p_splits` is passed the same way for the same
  // reason.
  import_transactions: (payloadLiteral) =>
    `SELECT public.import_transactions_atomic(
              (${payloadLiteral}::jsonb->>'user_id')::uuid,
              (${payloadLiteral}::jsonb->>'account_id')::uuid,
              ${payloadLiteral}::jsonb->'rows')
       INTO v_row;`,

  import_bank_transactions: (payloadLiteral) =>
    `SELECT public.import_bank_transactions_atomic(
              (${payloadLiteral}::jsonb->>'user_id')::uuid,
              ${payloadLiteral}::jsonb->'rows')
       INTO v_row;`,

  // THE RESTORE FAMILY IS COMPARED ON ITS OWN ANSWER
  // ------------------------------------------------
  // None of these four returns a transaction, so there is no row for the
  // runner's field-by-field comparison to bite on and nothing to project out of
  // storage either — a wipe's whole subject is rows that no longer exist. What
  // IS comparable is the value each function returns, so that is what `v_row`
  // carries: `user_financial_data_is_empty`'s boolean and `restore_user_chunk`'s
  // bigint are wrapped in an object so the shape matches the Rust side's
  // `answer`, and the other two already return jsonb and are passed through
  // key for key.
  //
  // Everything a return value cannot carry — the rows that survived, the
  // balances, the audit trail, the dates that did or did not move — is asserted
  // through `state` SELECTs written per engine, which is where cross-engine
  // comparisons of rows belong.
  user_financial_data_is_empty: (payloadLiteral) =>
    `SELECT jsonb_build_object(
              'empty',
              public.user_financial_data_is_empty(
                NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid))
       INTO v_row;`,

  // `p_confirm` is read with `->>` and NOT coalesced: a missing key must arrive
  // as SQL NULL so the RPC's `IS DISTINCT FROM` refusal is reachable from a
  // payload rather than smoothed over by the driver.
  wipe_user_financial_data: (payloadLiteral) =>
    `SELECT public.wipe_user_financial_data(
              ${payloadLiteral}::jsonb->>'confirm',
              NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid)
       INTO v_row;`,

  // THE CHUNK LIST, UNPACKED
  // ------------------------
  // The local verb takes a LIST of chunks and applies them in one transaction,
  // because DESIGN.md §5 divergence 6 says a local restore has no request-size
  // cliff to chunk around and R-11 says the deferred keys let it be atomic. The
  // cloud RPC takes exactly one. So a spec that wants the two compared sends ONE
  // chunk and this unpacks it — the same honest unpacking the update and delete
  // verbs already do for their positional arguments.
  //
  // A spec sending more than one chunk is asserting the local atomicity, which
  // has no cloud counterpart; those live in the crate's own integration tests.
  //
  // `->'rows'` is NOT coalesced, so an absent key arrives as SQL NULL and the
  // measured hole in `rows_not_an_array` stays reachable from a payload.
  restore_user_chunk: (payloadLiteral) =>
    `SELECT jsonb_build_object(
              'inserted',
              public.restore_user_chunk(
                ${payloadLiteral}::jsonb->'chunks'->0->>'entity',
                ${payloadLiteral}::jsonb->'chunks'->0->'rows',
                NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid))
       INTO v_row;`,

  finalize_user_restore: (payloadLiteral) =>
    `SELECT public.finalize_user_restore(
              COALESCE(${payloadLiteral}::jsonb->'links', '{}'::jsonb),
              NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid)
       INTO v_row;`,

  // ── THE PREFERENCES PAIR, WHOSE ORACLE IS A TYPESCRIPT TRANSPORT ───────────
  //
  // No function to port: `user_preferences` is written directly over PostgREST
  // (PHASE3-PLAN D-2, a fifth time). The oracle is the two calls in
  // `supabasePreferencesTransport()`, transcribed the way the account family's
  // writer is — literally, including the habits:
  //
  //   read   .select('prefs').eq('user_id', …).maybeSingle()
  //   write  .upsert({ user_id, prefs }, { onConflict: 'user_id' })
  //
  // `maybeSingle()` on no row answers `data = null` and the transport then
  // answers `null`, so the read's shape is a jsonb object whose one key is
  // JSON null — which is what `jsonb_build_object` makes of a scalar subquery
  // that found nothing. That is the same sentence the local verb says with
  // `preferences: None`, and it is a sentence with a caller: a null document is
  // what makes `PreferencesService.attach` lift this machine's settings in.
  //
  // The upsert is spelled with the columns the CLIENT supplies and no others.
  // `id` is left to `gen_random_uuid()` (the local column has no default and
  // the verb mints — B-5, declared in the crate) and `updated_at` is left to
  // `update_user_preferences_updated_at`, the BEFORE UPDATE trigger this
  // schema has and `schema.sql` does not.
  //
  // Both then project the STORED document rather than the one that was sent, so
  // the two engines are compared on what each file now holds. Key order is not
  // compared: `serde_json` keeps insertion order and `jsonb` sorts by key length
  // then bytes, which is why the runner canonicalises with `stableJson`.
  read_preferences: (payloadLiteral) =>
    `SELECT jsonb_build_object('preferences', ${STORED_PREFERENCES(payloadLiteral)})
       INTO v_row;`,

  write_preferences: (payloadLiteral) =>
    `INSERT INTO public.user_preferences (user_id, prefs)
          VALUES (NULLIF(${payloadLiteral}::jsonb->>'user_id', '')::uuid,
                  ${payloadLiteral}::jsonb->'preferences')
     ON CONFLICT (user_id) DO UPDATE
        SET user_id = excluded.user_id, prefs = excluded.prefs;
     SELECT jsonb_build_object('preferences', ${STORED_PREFERENCES(payloadLiteral)})
       INTO v_row;`,

  // ── THE READS ──────────────────────────────────────────────────────────────
  // Each one is an entry in the READS table above, which is where the client
  // query it transcribes is written down. One line apiece here, because a verb
  // that has to repeat its own query in two places is a verb whose two copies
  // will one day disagree — the same rule the crate keeps by calling its row
  // mappers rather than re-writing their SQL.

  list_accounts: (payloadLiteral) => listed('accounts', payloadLiteral),

  list_closed_accounts: (payloadLiteral) => listed('closed_accounts', payloadLiteral),

  list_categories: (payloadLiteral) => listed('categories', payloadLiteral),

  list_budgets: (payloadLiteral) => listed('budgets', payloadLiteral),

  list_goals: (payloadLiteral) => listed('goals', payloadLiteral),

  list_custom_reports: (payloadLiteral) => listed('custom_reports', payloadLiteral),

  list_investments: (payloadLiteral) => listed('investments', payloadLiteral),

  list_suggestion_dismissals: (payloadLiteral) =>
    listed('suggestion_dismissals', payloadLiteral),

  // ── The heavy four ─────────────────────────────────────────────────────────

  list_transactions: (payloadLiteral) => listed('transactions', payloadLiteral),

  list_transaction_splits: (payloadLiteral) => listed('transaction_splits', payloadLiteral),

  splits_for: (payloadLiteral) => listed('splits', payloadLiteral),

  // ── THE COMPOSITE, WHOSE ORACLE IS A TYPESCRIPT METHOD ─────────────────────
  //
  // `load_boot` is the first verb here whose cloud side is neither a function
  // nor a single query: it is `DataServiceImpl.loadBoot`, whose body is six of
  // the reads above made one after another. So the oracle is those six queries,
  // gathered into one object — the same transcription rule the reads follow,
  // applied to a method instead of to a `.select()`.
  //
  // WHAT THE CLOUD'S SNAPSHOT CARRIES THAT THIS DOES NOT, and why neither is a
  // divergence to declare: `BootSnapshot` also has `transactionStats` and
  // `phases`. The first describes a FETCH — how many rows came from the local
  // cache, how many from a delta, and in words why no snapshot was served — and
  // the second is a duration per phase. Neither is a fact about a database, so
  // neither engine's verb answers with one: the cloud's come from the client's
  // paging layer and the local edition's from `LocalDataPort`, which times the
  // one crossing it makes and says `'local mode'` for the same reason browser
  // storage does (divergence B-1). An oracle that invented them here would be
  // comparing the harness against itself.
  //
  // WHAT IS COMPARED IS THE SIX LISTS, and comparing them is the point: the
  // composite is where a port can quietly re-order a ledger, drop the archived
  // rows, lose a login's scoping on one read out of six, or answer with five
  // lists and an empty sixth. Every one of those is a difference in this object.
  load_boot: (payloadLiteral) =>
    `SELECT jsonb_build_object(
              ${BOOT_READS.map((key) => `'${key}', ${aggregated(key, payloadLiteral)}`).join(',\n              ')})
       INTO v_row;`,

  // account_balances() — 20260722160000:26-42, and the only read in this table
  // whose oracle is a FUNCTION rather than a transcribed query.
  //
  // It takes no argument: it is SECURITY DEFINER and reads its identity from the
  // verified JWT through requesting_user_id(), "so there is no parameter to
  // spoof". The harness therefore supplies the identity the way production does
  // — by setting the claim — rather than by rewriting the function's body with a
  // parameter in it. `request.jwt.claims` is transaction-local, and the whole
  // spec already runs inside a transaction that is rolled back.
  //
  // An owner the file does not know produces a claim of JSON null, which
  // requesting_clerk_id() turns into SQL NULL and requesting_user_id() matches
  // nothing with: no rows, which is the same answer an unauthenticated caller
  // gets in production.
  //
  // THE ORDER IS THE HARNESS'S, AND HAS TO BE. The RPC states none at all —
  // GROUP BY and nothing after it — so its answer is a SET, and two sets cannot
  // be compared element by element without one. This is NOT the tie-break
  // exception the block above forbids: there the cloud states a key and the
  // crate adds one behind it, and copying that would make the oracle agree about
  // something unsaid. Here there is no key to leave alone, and the crate's own
  // `ORDER BY a.id` is proved separately in crates/wealth-core/tests/reads.rs.
  account_balances: (payloadLiteral) =>
    `PERFORM set_config('request.jwt.claims',
               json_build_object('sub',
                 (SELECT u.clerk_id FROM public.users u
                   WHERE u.id = (${payloadLiteral}::jsonb->>'user_id')::uuid))::text,
               true);
     SELECT jsonb_build_object(
              'account_balances',
              COALESCE(jsonb_agg(jsonb_build_object(
                'account_id', b.account_id,
                'balance', ${money('b.balance')},
                'txn_count', b.txn_count) ORDER BY b.account_id), '[]'::jsonb))
       INTO v_row
       FROM public.account_balances() b;`,

  // ── THE ACCOUNT FAMILY, WHOSE ORACLE IS A TYPESCRIPT WRITER ────────────────
  //
  // Three verbs that port no function, because `accounts` is one of the tables
  // the cloud writes DIRECTLY over PostgREST (PHASE3-PLAN D-2). So the oracle is
  // the WRITE the client builds, transcribed here key for key and default for
  // default — the same rule the READS table follows for a `.select()`, applied
  // to an `.insert()` and an `.update()`.
  //
  // Each is PERFORMed and the row projected afterwards through ACCOUNT_JSON, the
  // same twenty-six keys `crate::row::account::ListedAccount` serialises, so the
  // two engines are compared on the whole stored account rather than on whatever
  // each writer happened to return.
  //
  // WHAT IS TRANSCRIBED IS THE WRITER, NOT A TIDIED VERSION OF IT. Three of its
  // habits look like omissions and are reproduced anyway, because a spec that
  // finds one is finding a real difference between the editions:
  //
  //   * the create does NOT send `low_balance_alert_enabled` or
  //     `low_balance_threshold` — the columns exist in both engines and the
  //     CLIENT leaves them out, so an account created in the cloud with an alert
  //     configured arrives with the alert off;
  //   * the create sends `icon` and `color` as explicit NULLs, which is what
  //     `accountService.ts:260-261` does and is indistinguishable from the
  //     column default;
  //   * the update will happily send `balance`, which makes it an absolute
  //     balance setter. The verb refuses that by name; this does not.
  //
  // THE ONE THING THAT IS NOT LITERAL, and why. The writer's two money lines are
  // `balance: account.balance || 0` and
  // `initial_balance: account.openingBalance || account.balance || 0`, so it
  // takes TWO figures where the verb takes one. The payload a spec sends is a
  // WIRE payload with one money key, and it is mapped to both — which is exactly
  // what the writer is handed in production, because
  // `AppContextSupabase.addAccount:894-897` sets `balance = initialBalance ||
  // balance || 0` before the seam is called. Transcribing the writer means
  // transcribing what it is actually given. The case where a CALLER contradicts
  // itself is a seam-level difference and is declared where the seam can see
  // it — contract.ts's ACCOUNT_BALANCE_AT_BIRTH — rather than smuggled in here.
  //
  // `id` is supplied by the payload where the client leaves the column default
  // to answer, for the reason every write spec needs: two engines cannot be
  // compared on a row neither can name.
  create_account: (payloadLiteral) =>
    `INSERT INTO public.accounts (
       id, user_id, name, type, currency, balance, initial_balance, is_active,
       institution, sort_code, account_number, opening_balance_date, notes, icon, color
     ) VALUES (
       COALESCE(NULLIF(${payloadLiteral}::jsonb->>'id','')::uuid, uuid_generate_v4()),
       (${payloadLiteral}::jsonb->>'user_id')::uuid,
       ${payloadLiteral}::jsonb->>'name',
       COALESCE(NULLIF(${payloadLiteral}::jsonb->>'type',''), 'checking'),
       COALESCE(NULLIF(${payloadLiteral}::jsonb->>'currency',''), 'GBP'),
       COALESCE((${payloadLiteral}::jsonb->>'initial_balance')::numeric, 0),
       COALESCE((${payloadLiteral}::jsonb->>'initial_balance')::numeric, 0),
       COALESCE((${payloadLiteral}::jsonb->>'is_active')::boolean, true),
       NULLIF(${payloadLiteral}::jsonb->>'institution',''),
       NULLIF(${payloadLiteral}::jsonb->>'sort_code',''),
       -- accountNumberForStorage(value, isCardAccountType(type)): a card keeps
       -- its last four digits and nothing else, a bank number is trimmed and
       -- kept whole, and an empty result is NULL rather than ''.
       CASE WHEN COALESCE(NULLIF(${payloadLiteral}::jsonb->>'type',''), 'checking') = 'credit'
            THEN NULLIF(right(regexp_replace(
                   COALESCE(${payloadLiteral}::jsonb->>'account_number',''), '\\D', '', 'g'), 4), '')
            ELSE NULLIF(btrim(COALESCE(${payloadLiteral}::jsonb->>'account_number','')), '')
       END,
       NULLIF(${payloadLiteral}::jsonb->>'opening_balance_date','')::date,
       NULLIF(${payloadLiteral}::jsonb->>'notes',''),
       NULL, NULL
     );
     SELECT ${ACCOUNT_JSON} INTO v_row
       FROM public.accounts a
      WHERE a.id = (${payloadLiteral}::jsonb->>'id')::uuid;`,

  // mapAccountToDb, transcribed. Its whole rule is "undefined is dropped, null
  // is kept", which over a jsonb patch is `patch ? 'k'` — the key being present
  // is the whole test — so every column below is one `CASE WHEN … THEN … ELSE
  // <column> END` and there is no second class. The patch's keys are already the
  // COLUMN names, so the field→column map itself has nothing to translate.
  //
  // `cardSafeUpdates` rides in front of it: an account number is cut to its last
  // four iff the row will be a card once this lands — the payload's type when it
  // states one, the stored type otherwise. `keepLastFour` and NOT
  // `accountNumberForStorage`, so `''` stores an empty string rather than NULL;
  // the two helpers really do differ there.
  update_account: (payloadLiteral) => {
    const patch = `COALESCE(${payloadLiteral}::jsonb->'patch', '{}'::jsonb)`;
    const has = (key) => `${patch} ? '${key}'`;
    const text = (key) => `${patch}->>'${key}'`;
    const set = (column, value, key = column) =>
      `${column} = CASE WHEN ${has(key)} THEN ${value} ELSE ${column} END`;
    return `UPDATE public.accounts a SET
       ${set('name', text('name'))},
       ${set('type', text('type'))},
       ${set('currency', text('currency'))},
       ${set('balance', `(${text('balance')})::numeric`)},
       ${set('initial_balance', `(${text('initial_balance')})::numeric`)},
       ${set('is_active', `(${text('is_active')})::boolean`)},
       ${set('institution', text('institution'))},
       ${set('sort_code', text('sort_code'))},
       ${set(
         'account_number',
         `CASE WHEN COALESCE(NULLIF(${text('type')},''), a.type) = 'credit'
               THEN right(regexp_replace(COALESCE(${text('account_number')},''), '\\D', '', 'g'), 4)
               ELSE ${text('account_number')} END`
       )},
       ${set('opening_balance_date', `(${text('opening_balance_date')})::date`)},
       ${set('archive_through_date', `(${text('archive_through_date')})::date`)},
       ${set('notes', text('notes'))},
       ${set('low_balance_alert_enabled', `(${text('low_balance_alert_enabled')})::boolean`)},
       ${set('low_balance_threshold', `(${text('low_balance_threshold')})::numeric`)},
       ${set('bank_balance', `(${text('bank_balance')})::numeric`)},
       ${set('bank_balance_date', `(${text('bank_balance_date')})::date`)},
       ${set('last_reconciled_date', `(${text('last_reconciled_date')})::date`)},
       ${set('last_reconciled_balance', `(${text('last_reconciled_balance')})::numeric`)},
       ${set('parent_account_id', `(${text('parent_account_id')})::uuid`)}
     WHERE a.id = (${payloadLiteral}::jsonb->>'id')::uuid
       AND (NULLIF(${payloadLiteral}::jsonb->>'user_id','') IS NULL
            OR a.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid);
     SELECT ${ACCOUNT_JSON} INTO v_row
       FROM public.accounts a
      WHERE a.id = (${payloadLiteral}::jsonb->>'id')::uuid;`;
  },

  // accountService.deleteAccount, whose whole body is one column. The name is
  // the seam's, because nothing here deletes anything.
  close_account: (payloadLiteral) =>
    `UPDATE public.accounts a
        SET is_active = false
      WHERE a.id = (${payloadLiteral}::jsonb->>'id')::uuid
        AND (NULLIF(${payloadLiteral}::jsonb->>'user_id','') IS NULL
             OR a.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid);
     SELECT ${ACCOUNT_JSON} INTO v_row
       FROM public.accounts a
      WHERE a.id = (${payloadLiteral}::jsonb->>'id')::uuid;`,

  // ── THE CATEGORY FAMILY, WHOSE ORACLE IS ALSO A TYPESCRIPT WRITER ─────────
  //
  // Five verbs, no function behind four of them: `categories` is written
  // directly over PostgREST too (PHASE3-PLAN D-2). So the oracle is again the
  // WRITE the client builds — `categoryToDb` plus the query it is sent through —
  // transcribed key for key.
  //
  // `categoryToDb` is a WHITELIST of eleven `if (c.k !== undefined)` lines, so a
  // key it has no line for never reaches the table. That is why the local verbs
  // FILTER a create and a patch rather than passing them through whole (the
  // account pair does the opposite, because `mapAccountToDb` sends an unknown
  // field under its own name and lets PostgREST refuse it). `mappers/writes.ts`
  // carries the same distinction on the TypeScript side.
  //
  // TWO OF ITS ELEVEN LINES ARE FALSY RATHER THAN NULLISH —
  // `row.parent_id = c.parentId || null` and the same for `account_id` — so an
  // EMPTY STRING clears the column instead of being stored. Transcribed with
  // NULLIF below, on both the insert and the update, because a category whose
  // parent is `''` is a category under a parent that cannot exist.
  //
  // Every unstated column falls to its own DEFAULT, and the two engines' defaults
  // are the same five values (`is_system` false, the three semantic flags false,
  // `is_active` true), so the COALESCEs below are the column defaults written out
  // rather than a decision this oracle is taking.
  create_category: (payloadLiteral) =>
    `INSERT INTO public.categories (
       id, user_id, name, type, level, parent_id, account_id, color, icon,
       is_system, is_transfer_category, is_revaluation_category,
       is_unassigned_bucket, is_active
     ) VALUES (
       COALESCE(NULLIF(${payloadLiteral}::jsonb->>'id','')::uuid, gen_random_uuid()),
       (${payloadLiteral}::jsonb->>'user_id')::uuid,
       ${payloadLiteral}::jsonb->>'name',
       ${payloadLiteral}::jsonb->>'type',
       ${payloadLiteral}::jsonb->>'level',
       NULLIF(${payloadLiteral}::jsonb->>'parent_id','')::uuid,
       NULLIF(${payloadLiteral}::jsonb->>'account_id','')::uuid,
       ${payloadLiteral}::jsonb->>'color',
       ${payloadLiteral}::jsonb->>'icon',
       COALESCE((${payloadLiteral}::jsonb->>'is_system')::boolean, false),
       COALESCE((${payloadLiteral}::jsonb->>'is_transfer_category')::boolean, false),
       COALESCE((${payloadLiteral}::jsonb->>'is_revaluation_category')::boolean, false),
       COALESCE((${payloadLiteral}::jsonb->>'is_unassigned_bucket')::boolean, false),
       COALESCE((${payloadLiteral}::jsonb->>'is_active')::boolean, true)
     );
     SELECT ${CATEGORY_JSON} INTO v_row
       FROM public.categories c
      WHERE c.id = (${payloadLiteral}::jsonb->>'id')::uuid;`,

  // The same insert with a list in front of it — literally `.insert(rows)`, one
  // statement, which is why a row the table refuses loses the whole call on both
  // engines.
  //
  // TWO PASSES, and the second is the local port's shape rather than the cloud's:
  // `parent_id` is nullable here and IMMEDIATE there, so a child listed before
  // its parent needs the link deferred locally. Writing the same two passes in
  // this oracle keeps the comparison about what LANDED rather than about which
  // engine can insert a list in one go.
  //
  // The answer is ordered by id on both sides. Insertion order is not something
  // PostgREST promises and the seam says callers match answers to requests BY
  // NAME, so an order had to be chosen for the comparison and this is the one the
  // verb states too.
  create_categories: (payloadLiteral) => {
    const rows = `jsonb_array_elements(COALESCE(${payloadLiteral}::jsonb->'categories','[]'::jsonb))`;
    return `INSERT INTO public.categories (
       id, user_id, name, type, level, parent_id, account_id, color, icon,
       is_system, is_transfer_category, is_revaluation_category,
       is_unassigned_bucket, is_active
     )
     SELECT
       COALESCE(NULLIF(r->>'id','')::uuid, gen_random_uuid()),
       (${payloadLiteral}::jsonb->>'user_id')::uuid,
       r->>'name', r->>'type', r->>'level',
       NULL,
       NULLIF(r->>'account_id','')::uuid,
       r->>'color', r->>'icon',
       COALESCE((r->>'is_system')::boolean, false),
       COALESCE((r->>'is_transfer_category')::boolean, false),
       COALESCE((r->>'is_revaluation_category')::boolean, false),
       COALESCE((r->>'is_unassigned_bucket')::boolean, false),
       COALESCE((r->>'is_active')::boolean, true)
     FROM ${rows} AS r;
     UPDATE public.categories c
        SET parent_id = NULLIF(r->>'parent_id','')::uuid
       FROM ${rows} AS r
      WHERE c.id = NULLIF(r->>'id','')::uuid
        AND NULLIF(r->>'parent_id','') IS NOT NULL;
     SELECT jsonb_build_object('categories',
              COALESCE(jsonb_agg(${CATEGORY_JSON} ORDER BY c.id), '[]'::jsonb))
       INTO v_row
       FROM public.categories c
      WHERE c.id IN (SELECT NULLIF(r->>'id','')::uuid FROM ${rows} AS r);`;
  },

  // `categoryToDb(updates)` sent as `.update(…).eq('id',…).eq('user_id',…)
  // .select().single()`. Its whole presence rule is `patch ? 'k'` — the key being
  // there is the whole test — so every column is one CASE and there is no second
  // class, exactly as `update_account` above.
  //
  // THE `.single()` IS TRANSCRIBED, and it is the only part of any entry in this
  // table that comes from PostgREST rather than from Postgres. It is still the
  // query the client sends: `.single()` makes a request that matched no row into
  // an ERROR (PGRST116, *"JSON object requested, multiple (or no) rows
  // returned"*), which `handleSupabaseError` puts on screen — so an oracle
  // without it would answer "fine, nothing happened" for a case the cloud
  // refuses, and the local verb's own `category_not_found` would read as a
  // divergence it is not. The DELETE below deliberately has no such clause,
  // because that query has no `.single()` either, and the difference between the
  // two verbs is exactly that one word.
  update_category: (payloadLiteral) => {
    const patch = `COALESCE(${payloadLiteral}::jsonb->'patch', '{}'::jsonb)`;
    const has = (key) => `${patch} ? '${key}'`;
    const text = (key) => `${patch}->>'${key}'`;
    const set = (column, value, key = column) =>
      `${column} = CASE WHEN ${has(key)} THEN ${value} ELSE ${column} END`;
    const flag = (column) => set(column, `(${text(column)})::boolean`);
    return `UPDATE public.categories c SET
       ${set('name', text('name'))},
       ${set('type', text('type'))},
       ${set('level', text('level'))},
       ${set('parent_id', `NULLIF(${text('parent_id')},'')::uuid`)},
       ${set('account_id', `NULLIF(${text('account_id')},'')::uuid`)},
       ${set('color', text('color'))},
       ${set('icon', text('icon'))},
       ${flag('is_system')},
       ${flag('is_transfer_category')},
       ${flag('is_revaluation_category')},
       ${flag('is_unassigned_bucket')},
       ${flag('is_active')}
     WHERE c.id = (${payloadLiteral}::jsonb->>'id')::uuid
       AND (NULLIF(${payloadLiteral}::jsonb->>'user_id','') IS NULL
            OR c.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid);
     IF NOT FOUND THEN
       RAISE EXCEPTION 'PGRST116: JSON object requested, multiple (or no) rows returned';
     END IF;
     SELECT ${CATEGORY_JSON} INTO v_row
       FROM public.categories c
      WHERE c.id = (${payloadLiteral}::jsonb->>'id')::uuid;`;
  },

  // `.delete().eq('id',…).eq('user_id',…)`, and the cascade the client's own
  // comment names: "parent_id FK is ON DELETE CASCADE — children go with the
  // parent". No `.single()`, so an id naming nothing is a successful nothing.
  //
  // The count is built to match the LOCAL verb's, which walks the subtree and
  // counts every row it removed rather than only the one named. Postgres's
  // ROW_COUNT here would say 1 for a group of three, so the subtree is counted
  // FIRST — a recursive CTE, bounded, because `parent_id` has no constraint
  // against a loop on either engine.
  delete_category: (payloadLiteral) =>
    `WITH RECURSIVE doomed(id, depth) AS (
       SELECT c.id, 0
         FROM public.categories c
        WHERE c.id = (${payloadLiteral}::jsonb->>'id')::uuid
          AND (NULLIF(${payloadLiteral}::jsonb->>'user_id','') IS NULL
               OR c.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid)
       UNION
       SELECT ch.id, d.depth + 1
         FROM public.categories ch JOIN doomed d ON ch.parent_id = d.id
        WHERE d.depth < 32
     )
     SELECT COUNT(*) INTO v_count FROM doomed;
     DELETE FROM public.categories c
      WHERE c.id = (${payloadLiteral}::jsonb->>'id')::uuid
        AND (NULLIF(${payloadLiteral}::jsonb->>'user_id','') IS NULL
             OR c.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid);
     SELECT jsonb_build_object('deleted', v_count) INTO v_row;`,

  // ── seed_categories: ensureCategories' WHOLE BODY, not just the RPC ────────
  //
  // `planningService.ensureCategories:426-487` is three steps and this is the
  // same three: read the login's categories; if there are any, answer with them
  // and write nothing; otherwise run `migrate_categories_atomic` with the list
  // the client is holding and answer with what it returned.
  //
  // Transcribing the METHOD rather than the RPC is what makes the comparison
  // honest. The verb is one crossing where the client makes two — a device has no
  // second session to race, and a port may not branch on a refusal code
  // (PHASE3-PLAN D-3) — so an oracle that only ran the RPC would report
  // `categories_already_migrated` for a case the cloud's caller never reaches.
  //
  // What it does NOT transcribe is `ensureCategories`' offline fallback (a failed
  // read serves the browser's cached copy). That is a decision about a NETWORK,
  // and a local file has none.
  //
  // THE IDS DIVERGE BY DESIGN. Pass 1 of the RPC mints a fresh uuid for every
  // incoming id and pass 4 remaps `transactions.category` and `budgets.category`
  // through the map; the local verb keeps the ids it was given and has nothing to
  // remap, because there is one id space in a file (B-4, PHASE3-PLAN D-5). The
  // specs declare `categories` as a row divergence for exactly that reason and
  // compare the TREE — names, levels, parents by name — through `state` instead.
  //
  // ONE MORE TRANSLATION, AND IT IS THE CLIENT'S OWN. The RPC's items are the
  // FRONTEND's shape — `parentId`, `isSystem`, `isTransferCategory` — because
  // `categoryToRpcPayload` hands it `Category` objects, while every other write
  // in this family sends COLUMN names. The wire payload a spec writes is
  // snake_case like the rest of the crate, so the camelCase item is rebuilt here,
  // which is the same thing the account family's entry does when it maps one
  // money key onto the writer's two figures: transcribe what the client actually
  // sends.
  seed_categories: (payloadLiteral) => {
    const rows = `jsonb_array_elements(COALESCE(${payloadLiteral}::jsonb->'categories','[]'::jsonb))`;
    const asFrontendShape = `(SELECT jsonb_agg(jsonb_build_object(
         'id', r->>'id',
         'name', r->>'name',
         'type', r->>'type',
         'level', r->>'level',
         'parentId', r->>'parent_id',
         'color', r->>'color',
         'icon', r->>'icon',
         'isSystem', r->>'is_system',
         'isTransferCategory', r->>'is_transfer_category',
         'isRevaluationCategory', r->>'is_revaluation_category',
         'isUnassignedBucket', r->>'is_unassigned_bucket',
         'accountId', r->>'account_id',
         'isActive', r->>'is_active'))
       FROM ${rows} AS r)`;
    return `IF NOT EXISTS (SELECT 1 FROM public.categories
                     WHERE user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid) THEN
       PERFORM public.migrate_categories_atomic(
                 (${payloadLiteral}::jsonb->>'user_id')::uuid,
                 ${asFrontendShape});
     END IF;
     SELECT jsonb_build_object('categories',
              COALESCE(jsonb_agg(${CATEGORY_JSON} ORDER BY c.level, c.name, c.id), '[]'::jsonb))
       INTO v_row
       FROM public.categories c
      WHERE c.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid;`;
  },

  // ── THE PLANNING FAMILY, WHOSE ORACLE IS A TYPESCRIPT WRITER TOO ──────────
  //
  // Six verbs, no function behind any of them: `budgets` and `goals` are written
  // straight over PostgREST (PHASE3-PLAN D-2), so the oracle is again the WRITE
  // the client builds — `budgetToDb` / `goalToDb` plus the query they are sent
  // through — transcribed key for key.
  //
  // Both mappers are WHITELISTS, like `categoryToDb` and unlike `mapAccountToDb`,
  // so the local verbs FILTER a create and a patch rather than passing them
  // through whole. `mappers/writes.ts` carries the same distinction.
  //
  // THREE THINGS ARE TRANSCRIBED THAT LOOK LIKE THE HARNESS BEING CLEVER, and
  // every one of them is a line of the writer:
  //
  //   * `createBudget` fills in `start_date` and `name` AFTER the mapper,
  //     because both columns are NOT NULL and the mapper can produce a row with
  //     neither. `now()::date` and `COALESCE(NULLIF(category,''), 'Budget')`
  //     below are those two lines.
  //   * `budgetToDb`'s name line is `b.name ?? b.categoryId ?? 'Budget'` guarded
  //     by "either key was present", so an update that moves a budget to another
  //     category RENAMES it. Transcribed as one CASE with the same three-way
  //     fallthrough, and `??` means the fallthrough is on NULL rather than on
  //     falsy — a stated empty name stays empty.
  //   * `goalToDb` makes `completed_at` follow `status`: stamped when a goal
  //     completes, cleared when it is anything else, and only honoured on its own
  //     when no status was stated.
  //
  // THE THRESHOLD IS NOT MONEY. `alert_threshold` is `numeric(5,2)` here and an
  // INTEGER count of hundredths of a percent locally; both sides therefore send
  // and answer the same two-place decimal STRING, and `${money(...)}` below is
  // reused for its exactness rather than for its meaning.
  //
  // `id` is supplied by the payload where the client leaves the column default to
  // answer, for the reason every write spec needs: two engines cannot be compared
  // on a row neither can name.
  create_budget: (payloadLiteral) => {
    const text = (key) => `${payloadLiteral}::jsonb->>'${key}'`;
    return `INSERT INTO public.budgets (
       id, user_id, name, amount, period, repeat_count, repeat_unit, category, start_date, end_date,
       spent, rollover, rollover_amount, alert_threshold, is_active, notes
     ) VALUES (
       COALESCE(NULLIF(${text('id')},'')::uuid, uuid_generate_v4()),
       (${text('user_id')})::uuid,
       -- budgetToDb's name ?? categoryId ?? 'Budget', and then createBudget's
       -- own "if (!row.name) row.name = categoryId || 'Budget'". The two
       -- collapse to this on a create, because the mapper only writes the
       -- column at all when one of the two keys is present.
       COALESCE(NULLIF(${text('name')},''), NULLIF(${text('category')},''), 'Budget'),
       (${text('amount')})::numeric,
       ${text('period')},
       -- The 'every' pair: integer and text, NULL when absent; the table's
       -- CHECK (20261107150000) holds the pair to that period on both engines.
       NULLIF(${text('repeat_count')},'')::integer,
       NULLIF(${text('repeat_unit')},''),
       NULLIF(${text('category')},''),
       -- "if (!row.start_date) row.start_date = new Date().toISOString()
       -- .slice(0,10)" — the UTC day, which is what the local verb takes off
       -- the file's own clock.
       COALESCE(NULLIF(${text('start_date')},'')::date, (now() AT TIME ZONE 'UTC')::date),
       NULLIF(${text('end_date')},'')::date,
       -- { ...budget, spent: 0 }: the writer's zero, not the caller's.
       0,
       COALESCE((${text('rollover')})::boolean, false),
       COALESCE((${text('rollover_amount')})::numeric, 0),
       COALESCE(NULLIF(${text('alert_threshold')},'')::numeric, 80),
       COALESCE((${text('is_active')})::boolean, true),
       ${text('notes')}
     );
     SELECT ${BUDGET_JSON} INTO v_row
       FROM public.budgets b
      WHERE b.id = (${text('id')})::uuid;`;
  },

  // `budgetToDb(updates)` sent as `.update(…).eq('id',…).eq('user_id',…)
  // .select().single()`. The `.single()` is transcribed for the reason
  // `update_category`'s entry gives at length: without it the oracle would answer
  // "fine, nothing happened" for a case the cloud refuses.
  update_budget: (payloadLiteral) => {
    const patch = `COALESCE(${payloadLiteral}::jsonb->'patch', '{}'::jsonb)`;
    const has = (key) => `${patch} ? '${key}'`;
    const text = (key) => `${patch}->>'${key}'`;
    const set = (column, value, key = column) =>
      `${column} = CASE WHEN ${has(key)} THEN ${value} ELSE ${column} END`;
    return `UPDATE public.budgets b SET
       -- The one column two keys decide. Nullish, not falsy: NULL falls
       -- through to the category and an empty name does not.
       name = CASE WHEN ${has('name')} OR ${has('category')}
                   THEN COALESCE(${text('name')}, ${text('category')}, 'Budget')
                   ELSE b.name END,
       ${set('amount', `(${text('amount')})::numeric`)},
       ${set('period', text('period'))},
       ${set('repeat_count', `(${text('repeat_count')})::integer`)},
       ${set('repeat_unit', text('repeat_unit'))},
       ${set('category', text('category'))},
       ${set('start_date', `(${text('start_date')})::date`)},
       ${set('end_date', `(${text('end_date')})::date`)},
       ${set('spent', `(${text('spent')})::numeric`)},
       ${set('rollover', `(${text('rollover')})::boolean`)},
       ${set('rollover_amount', `(${text('rollover_amount')})::numeric`)},
       ${set('alert_threshold', `(${text('alert_threshold')})::numeric`)},
       ${set('is_active', `(${text('is_active')})::boolean`)},
       ${set('notes', text('notes'))}
     WHERE b.id = (${payloadLiteral}::jsonb->>'id')::uuid
       AND (NULLIF(${payloadLiteral}::jsonb->>'user_id','') IS NULL
            OR b.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid);
     IF NOT FOUND THEN
       RAISE EXCEPTION 'PGRST116: JSON object requested, multiple (or no) rows returned';
     END IF;
     SELECT ${BUDGET_JSON} INTO v_row
       FROM public.budgets b
      WHERE b.id = (${payloadLiteral}::jsonb->>'id')::uuid;`;
  },

  // `.delete().eq('id',…).eq('user_id',…)`. No `.single()`, so an id naming
  // nothing is a successful nothing and the count is 0. ROW_COUNT is the whole
  // answer here — unlike `delete_category`, nothing cascades.
  delete_budget: (payloadLiteral) =>
    `DELETE FROM public.budgets b
      WHERE b.id = (${payloadLiteral}::jsonb->>'id')::uuid
        AND (NULLIF(${payloadLiteral}::jsonb->>'user_id','') IS NULL
             OR b.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid);
     GET DIAGNOSTICS v_count = ROW_COUNT;
     SELECT jsonb_build_object('deleted', v_count) INTO v_row;`,

  // `goalToDb({ ...goal, progress: goal.currentAmount ?? 0 }, userId)` — and by
  // the time a row exists, that precedence has already collapsed into ONE key.
  // The payload carries `current_amount`; both engines default it to the column's
  // zero when it is absent, which is rule 49's "a goal not yet saved for begins
  // at zero" and is a DEFAULT rather than a literal either side writes.
  create_goal: (payloadLiteral) => {
    const text = (key) => `${payloadLiteral}::jsonb->>'${key}'`;
    // PARENTHESISED, and it is not decoration: every non-built-in operator in
    // Postgres shares one precedence and associates LEFT, so `a || b->'k'`
    // parses as `(a || b)->'k'`. MEASURED in the update below, where the
    // unparenthesised version merged the WHOLE patch over the stored blob and
    // then read one key out of the result — which silently dropped every key
    // the merge was supposed to keep.
    const json = (key) => `(${payloadLiteral}::jsonb->'${key}')`;
    const status = `COALESCE(NULLIF(${text('status')},''), 'active')`;
    return `INSERT INTO public.goals (
       id, user_id, name, description, target_amount, current_amount,
       target_date, category, priority, status, account_id,
       contribution_frequency, auto_contribute, icon, color, completed_at, metadata
     ) VALUES (
       COALESCE(NULLIF(${text('id')},'')::uuid, uuid_generate_v4()),
       (${text('user_id')})::uuid,
       ${text('name')},
       ${text('description')},
       (${text('target_amount')})::numeric,
       COALESCE((${text('current_amount')})::numeric, 0),
       NULLIF(${text('target_date')},'')::date,
       ${text('category')},
       ${text('priority')},
       ${status},
       -- "|| null": falsy, so an empty string is not an account.
       NULLIF(${text('account_id')},'')::uuid,
       NULLIF(${text('contribution_frequency')},''),
       COALESCE((${text('auto_contribute')})::boolean, false),
       ${text('icon')},
       ${text('color')},
       -- The achievement date follows the status, always.
       CASE WHEN ${status} = 'completed'
            THEN COALESCE(NULLIF(${text('completed_at')},'')::timestamptz, now())
            ELSE NULL END,
       COALESCE(${json('metadata')}, '{}'::jsonb)
     );
     SELECT ${GOAL_JSON} INTO v_row
       FROM public.goals g
      WHERE g.id = (${text('id')})::uuid;`;
  },

  // `goalToDb(updates, undefined, existingMetadata)` behind the same
  // `.eq().eq().select().single()`, with the metadata read the cloud does first.
  //
  // THE MERGE IS THE TRANSCRIPTION THAT MATTERS: `{...existingMetadata,
  // ...stated}`, which is `||` on jsonb — a SHALLOW right-biased merge, the same
  // one the local verb does over a serde_json::Map. `jsonb_strip_nulls` is
  // deliberately NOT used: the spread stores a null rather than dropping the key.
  update_goal: (payloadLiteral) => {
    const patch = `COALESCE(${payloadLiteral}::jsonb->'patch', '{}'::jsonb)`;
    const has = (key) => `${patch} ? '${key}'`;
    const text = (key) => `${patch}->>'${key}'`;
    const json = (key) => `(${patch}->'${key}')`;  // parenthesised — see create_goal
    const set = (column, value, key = column) =>
      `${column} = CASE WHEN ${has(key)} THEN ${value} ELSE ${column} END`;
    // The status this row WILL hold: the stated one, or the stored one when the
    // patch says nothing. `completed_at` is decided against it.
    const nextStatus = `CASE WHEN ${has('status')} THEN ${text('status')} ELSE g.status END`;
    return `UPDATE public.goals g SET
       ${set('name', text('name'))},
       ${set('description', text('description'))},
       ${set('target_amount', `(${text('target_amount')})::numeric`)},
       -- SET, never a plus: the caller has already added up and capped this.
       ${set('current_amount', `(${text('current_amount')})::numeric`)},
       ${set('target_date', `NULLIF(${text('target_date')},'')::date`)},
       ${set('category', text('category'))},
       ${set('priority', text('priority'))},
       ${set('status', text('status'))},
       completed_at = CASE
         WHEN ${has('status')} THEN
           CASE WHEN ${nextStatus} = 'completed'
                THEN COALESCE(NULLIF(${text('completed_at')},'')::timestamptz, now())
                ELSE NULL END
         WHEN ${has('completed_at')} THEN (${text('completed_at')})::timestamptz
         ELSE g.completed_at END,
       ${set('account_id', `NULLIF(${text('account_id')},'')::uuid`)},
       ${set('contribution_frequency', `NULLIF(${text('contribution_frequency')},'')`)},
       ${set('auto_contribute', `(${text('auto_contribute')})::boolean`)},
       ${set('icon', text('icon'))},
       ${set('color', text('color'))},
       metadata = CASE WHEN ${has('metadata')}
                       THEN COALESCE(g.metadata, '{}'::jsonb) || ${json('metadata')}
                       ELSE g.metadata END
     WHERE g.id = (${payloadLiteral}::jsonb->>'id')::uuid
       AND (NULLIF(${payloadLiteral}::jsonb->>'user_id','') IS NULL
            OR g.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid);
     IF NOT FOUND THEN
       RAISE EXCEPTION 'PGRST116: JSON object requested, multiple (or no) rows returned';
     END IF;
     SELECT ${GOAL_JSON} INTO v_row
       FROM public.goals g
      WHERE g.id = (${payloadLiteral}::jsonb->>'id')::uuid;`;
  },

  // `.delete().eq('id',…).eq('user_id',…)`, and the cascade the schema declares:
  // `goal_contributions.goal_id` is ON DELETE CASCADE on BOTH engines. The count
  // is ROW_COUNT — the goals removed, never the contributions, which is the
  // decision `delete_goal`'s module docs argue against `delete_category`'s.
  delete_goal: (payloadLiteral) =>
    `DELETE FROM public.goals g
      WHERE g.id = (${payloadLiteral}::jsonb->>'id')::uuid
        AND (NULLIF(${payloadLiteral}::jsonb->>'user_id','') IS NULL
             OR g.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid);
     GET DIAGNOSTICS v_count = ROW_COUNT;
     SELECT jsonb_build_object('deleted', v_count) INTO v_row;`,


  // ── THE REPORT FAMILY, WHOSE ORACLE IS A TYPESCRIPT WRITER TOO ────────────
  //
  // Four verbs, no function behind any of them: `custom_reports` is written
  // straight over PostgREST (PHASE3-PLAN D-2 again), so the oracle is the WRITE
  // the client builds — `planningService.createCustomReport`, `.update…`,
  // `.delete…` — transcribed line for line.
  //
  // THE TWO JSONB COLUMNS ARE SET, NEVER MERGED, and that is the one line of
  // this family that is not inherited from the goals above. `update_goal`'s
  // `metadata` is `stored || stated` because three unrelated app fields share
  // that column; nothing shares these two, so `||` here would make removing a
  // component impossible on one engine and possible on the other.
  //
  // The two timestamps are NOT arguments, on either engine. `CustomReportDraft`
  // has five fields and none of them is a clock, and `customReportToDb` is a
  // whitelist with no line for either column — so both sides take the column's
  // own default, which is what makes the adoption's reports arrive dated the day
  // they were carried across on BOTH engines rather than on one.
  create_custom_report: (payloadLiteral) => {
    const text = (key) => `${payloadLiteral}::jsonb->>'${key}'`;
    // Parenthesised for the reason `create_goal` above states at length: every
    // non-built-in operator in Postgres shares one precedence and associates
    // LEFT, so `a || b->'k'` parses as `(a || b)->'k'`.
    const json = (key) => `(${payloadLiteral}::jsonb->'${key}')`;
    return `INSERT INTO public.custom_reports (
       id, user_id, name, description, components, filters
     ) VALUES (
       COALESCE(NULLIF(${text('id')},'')::uuid, uuid_generate_v4()),
       (${text('user_id')})::uuid,
       ${text('name')},
       ${text('description')},
       COALESCE(${json('components')}, '[]'::jsonb),
       COALESCE(${json('filters')}, '{}'::jsonb)
     );
     SELECT ${CUSTOM_REPORT_JSON} INTO v_row
       FROM public.custom_reports r
      WHERE r.id = (${text('id')})::uuid;`;
  },

  // `.update(customReportToDb(updates)).eq().eq().select().single()`, with the
  // `updated_at` the writer stamps itself.
  update_custom_report: (payloadLiteral) => {
    const patch = `COALESCE(${payloadLiteral}::jsonb->'patch', '{}'::jsonb)`;
    const has = (key) => `${patch} ? '${key}'`;
    const text = (key) => `${patch}->>'${key}'`;
    const json = (key) => `(${patch}->'${key}')`;  // parenthesised — see create_goal
    const set = (column, value, key = column) =>
      `${column} = CASE WHEN ${has(key)} THEN ${value} ELSE ${column} END`;
    return `UPDATE public.custom_reports r SET
       ${set('name', text('name'))},
       ${set('description', text('description'))},
       -- SET, never a jsonb concatenation: these columns are replaced whole.
       -- See the note above. (Spelled in words rather than in the operator,
       -- because this is inside a JS template literal and a backtick here ends
       -- the string — silently, since what follows still parses as JavaScript.)
       ${set('components', json('components'))},
       ${set('filters', json('filters'))},
       updated_at = now()
     WHERE r.id = (${payloadLiteral}::jsonb->>'id')::uuid
       AND (NULLIF(${payloadLiteral}::jsonb->>'user_id','') IS NULL
            OR r.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid);
     IF NOT FOUND THEN
       RAISE EXCEPTION 'PGRST116: JSON object requested, multiple (or no) rows returned';
     END IF;
     SELECT ${CUSTOM_REPORT_JSON} INTO v_row
       FROM public.custom_reports r
      WHERE r.id = (${payloadLiteral}::jsonb->>'id')::uuid;`;
  },

  // `.delete().eq('id',…).eq('user_id',…)`. No `.single()`, so an id naming
  // nothing is a successful nothing and the count is 0. Nothing cascades: a
  // report is not filed against by anything.
  delete_custom_report: (payloadLiteral) =>
    `DELETE FROM public.custom_reports r
      WHERE r.id = (${payloadLiteral}::jsonb->>'id')::uuid
        AND (NULLIF(${payloadLiteral}::jsonb->>'user_id','') IS NULL
             OR r.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid);
     GET DIAGNOSTICS v_count = ROW_COUNT;
     SELECT jsonb_build_object('deleted', v_count) INTO v_row;`,


  // ── THE INVESTMENT FAMILY, WHOSE ORACLE IS A TYPESCRIPT WRITER TOO ────────
  //
  // Four verbs, no function behind any of them: `investments` is written
  // straight over PostgREST (PHASE3-PLAN D-2, a sixth time), so the oracle is
  // again the WRITE the client builds — `InvestmentService.create`, `.update`,
  // `.remove` and `.applyQuotes` — transcribed line for line.
  //
  // FOUR THINGS ARE TRANSCRIBED THAT LOOK LIKE THE HARNESS BEING CLEVER, and
  // every one of them is a line of the writer:
  //
  //   * `cost_basis` is `quantity.times(averageCost)` — DERIVED, never taken
  //     from the payload, because *"two numbers that must agree are two numbers
  //     that will not"*. It is `numeric(10,2)` here, so Postgres rounds the
  //     product half-away-from-zero on the way in; the crate does the same in
  //     i128 and `crate::scaled::market_value_minor` says why the rounding mode
  //     is that one and not half-up.
  //   * `name` is `draft.name.trim() || symbol` — FALSY, so an empty name is the
  //     ticker rather than a blank.
  //   * an update recomputes `cost_basis` whenever EITHER figure moves, taking
  //     the half it was not given from the stored row. `COALESCE` on the patch
  //     is that read.
  //   * `applyQuotes` is a LOOP in the client — one update per quote, matched by
  //     `(user_id, symbol)` — and its answer is the number of ROWS the loop
  //     touched, not the number of quotes it was given.
  //
  // `id` is supplied by the payload where the client leaves the column default
  // to answer, for the reason every write spec needs: two engines cannot be
  // compared on a row neither can name.
  create_investment: (payloadLiteral) => {
    const text = (key) => `${payloadLiteral}::jsonb->>'${key}'`;
    const symbol = `NULLIF(${text('symbol')}, '')`;
    return `IF ${symbol} IS NULL THEN
       RAISE EXCEPTION 'investment_symbol_required: A holding needs a symbol — there is nothing to price it under.';
     END IF;
     INSERT INTO public.investments (
       id, user_id, account_id, symbol, name, asset_type, currency,
       quantity, cost_basis, current_price, purchase_date, purchase_price,
       last_updated, notes
     ) VALUES (
       COALESCE(NULLIF(${text('id')},'')::uuid, uuid_generate_v4()),
       (${text('user_id')})::uuid,
       -- "|| null": falsy, so an empty string is not an account.
       NULLIF(${text('account_id')},'')::uuid,
       ${symbol},
       -- draft.name.trim() || symbol.
       COALESCE(NULLIF(${text('name')},''), ${symbol}),
       COALESCE(NULLIF(${text('asset_type')},''), 'stock'),
       COALESCE(NULLIF(${text('currency')},''), 'GBP'),
       COALESCE((${text('quantity')})::numeric, 0),
       -- THE DERIVED FIGURE. numeric(10,2) rounds the product on the way in.
       COALESCE((${text('quantity')})::numeric, 0)
         * COALESCE((${text('purchase_price')})::numeric, 0),
       -- A price comes from an exchange, never from a create.
       NULL,
       NULLIF(${text('purchase_date')},'')::date,
       (${text('purchase_price')})::numeric,
       NULL,
       ${text('notes')}
     );
     SELECT ${INVESTMENT_JSON} INTO v_row
       FROM public.investments i
      WHERE i.id = (${text('id')})::uuid;`;
  },

  // The writer's `columns` object behind `.eq().eq().select().single()`. The
  // `.single()` is transcribed for the reason `update_category`'s entry gives at
  // length: without it the oracle would answer "fine, nothing happened" for a
  // case the cloud refuses.
  update_investment: (payloadLiteral) => {
    const patch = `COALESCE(${payloadLiteral}::jsonb->'patch', '{}'::jsonb)`;
    const has = (key) => `${patch} ? '${key}'`;
    const text = (key) => `${patch}->>'${key}'`;
    const set = (column, value, key = column) =>
      `${column} = CASE WHEN ${has(key)} THEN ${value} ELSE ${column} END`;
    // The two figures that move `cost_basis` together or not at all, as they
    // WILL be — the stated one, or the stored one when the patch says nothing.
    const nextQuantity = `CASE WHEN ${has('quantity')}
                               THEN (${text('quantity')})::numeric ELSE i.quantity END`;
    const nextPrice = `CASE WHEN ${has('purchase_price')}
                            THEN (${text('purchase_price')})::numeric
                            ELSE i.purchase_price END`;
    return `UPDATE public.investments i SET
       ${set('symbol', text('symbol'))},
       ${set('name', text('name'))},
       ${set('quantity', `(${text('quantity')})::numeric`)},
       ${set('purchase_price', `(${text('purchase_price')})::numeric`)},
       ${set('currency', text('currency'))},
       ${set('asset_type', text('asset_type'))},
       ${set('notes', text('notes'))},
       -- Recomputed whenever EITHER figure is named, and left alone otherwise.
       cost_basis = CASE WHEN ${has('quantity')} OR ${has('purchase_price')}
                         THEN ${nextQuantity} * COALESCE(${nextPrice}, 0)
                         ELSE i.cost_basis END,
       updated_at = now()
     WHERE i.id = (${payloadLiteral}::jsonb->>'id')::uuid
       AND (NULLIF(${payloadLiteral}::jsonb->>'user_id','') IS NULL
            OR i.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid);
     IF NOT FOUND THEN
       RAISE EXCEPTION 'PGRST116: JSON object requested, multiple (or no) rows returned';
     END IF;
     SELECT ${INVESTMENT_JSON} INTO v_row
       FROM public.investments i
      WHERE i.id = (${payloadLiteral}::jsonb->>'id')::uuid;`;
  },

  // `.delete().eq('id',…).eq('user_id',…)`. No `.single()`, so an id naming
  // nothing is a successful nothing and the count is 0. The
  // `investment_transactions` cascade is the DATABASE's on both engines and is
  // deliberately not counted here — a buy is a different entity from the thing
  // being deleted, so counting it would make one number mean two things.
  delete_investment: (payloadLiteral) =>
    `DELETE FROM public.investments i
      WHERE i.id = (${payloadLiteral}::jsonb->>'id')::uuid
        AND (NULLIF(${payloadLiteral}::jsonb->>'user_id','') IS NULL
             OR i.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid);
     GET DIAGNOSTICS v_count = ROW_COUNT;
     SELECT jsonb_build_object('deleted', v_count) INTO v_row;`,

  // The one verb of this family whose SHAPE differs from the writer's, and the
  // difference is declared rather than hidden: `applyQuotes` makes N round trips
  // and the crate makes one transaction. What is compared is what the writer
  // PROMISES — the rows carry the prices, and the count is rows repriced.
  //
  // Written as one statement over the whole list rather than a PL/pgSQL loop,
  // which is the same set of rows the loop touches: each quote matches on
  // `(user_id, symbol)`, and a symbol nobody holds matches nothing and
  // contributes zero.
  apply_investment_prices: (payloadLiteral) => {
    const quotes = `jsonb_array_elements(
       COALESCE(${payloadLiteral}::jsonb->'quotes', '[]'::jsonb))`;
    return `WITH quotes AS (SELECT q FROM ${quotes} AS q),
          moved AS (
       UPDATE public.investments i SET
         current_price = (q.q->>'price')::numeric,
         last_updated  = (q.q->>'as_of')::timestamptz,
         updated_at    = now()
         FROM quotes q
        WHERE i.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid
          AND i.symbol  = q.q->>'symbol'
       RETURNING i.id)
     SELECT jsonb_build_object('repriced', COUNT(*)) INTO v_row FROM moved;`;
  },
  // ── The dismissal pair ─────────────────────────────────────────────────────
  //
  // `SuggestionDismissalService.dismiss:88-118`, transcribed including its
  // CONTROL FLOW, which is the part that matters:
  //
  //   .insert({ user_id, kind, subject_key, subject_ids }).select(…).single()
  //   if (error && error.code === '23505') return (await find(…)) ?? throw
  //
  // `23505` is `unique_violation`, and the constraint it can only be is
  // `suggestion_dismissals_unique_subject UNIQUE (user_id, kind, subject_key)`.
  // The client does NOT update on conflict — it answers with the row already
  // there — so `dismissed_at` goes on meaning "when you first said no" and the
  // subjects stay the FIRST caller's. An `ON CONFLICT DO UPDATE` written here
  // would be a different feature quietly passing as a transcription.
  //
  // The sub-block's implicit savepoint is what makes the catch possible at all:
  // without it the failed INSERT would poison the surrounding transaction and
  // the SELECT after it could not run.
  //
  // `id` IS accepted, where the real client sends none and lets
  // `DEFAULT gen_random_uuid()` fire. Same arrangement as `create_goal` above
  // and for the same reason: the harness has to name one row on two engines.
  dismiss_suggestion: (payloadLiteral) => {
    const text = (key) => `${payloadLiteral}::jsonb->>'${key}'`;
    const owner = `(${text('user_id')})::uuid`;
    return `BEGIN
       INSERT INTO public.suggestion_dismissals (id, user_id, kind, subject_key, subject_ids)
       VALUES (
         COALESCE(NULLIF(${text('id')},'')::uuid, uuid_generate_v4()),
         ${owner},
         ${text('kind')},
         ${text('subject_key')},
         -- '{}' when the key is absent, which is what the three payee kinds
         -- send: their subject_key holds payee text and they name no rows.
         COALESCE(
           (SELECT array_agg(value::uuid ORDER BY ordinality)
              FROM jsonb_array_elements_text(
                     COALESCE(${payloadLiteral}::jsonb->'subject_ids', '[]'::jsonb)
                   ) WITH ORDINALITY AS s(value, ordinality)),
           ARRAY[]::uuid[]));
     EXCEPTION WHEN unique_violation THEN
       NULL;
     END;
     SELECT ${DISMISSAL_JSON} INTO v_row
       FROM public.suggestion_dismissals d
      WHERE d.user_id = ${owner}
        AND d.kind = ${text('kind')}
        AND d.subject_key = ${text('subject_key')};`;
  },

  // `.delete().eq('user_id',…).eq('kind',…).eq('subject_key',…)` and nothing
  // else. No `.single()`, no count reported to the caller, no flag anywhere: the
  // ROW GOES. The count is ROW_COUNT for the harness's benefit — the seam
  // discards it, but "nothing happened" and "one row went" are the two outcomes
  // a spec has to be able to tell apart.
  //
  // There is no cascade to state here: the subjects were an array IN the row, so
  // they leave with it. The local engine reaches the same state through
  // `suggestion_dismissal_subjects.dismissal_id ON DELETE CASCADE`, and that
  // difference of machinery is exactly what a spec measuring the child rows is
  // for.
  restore_suggestion: (payloadLiteral) =>
    `DELETE FROM public.suggestion_dismissals d
      WHERE (NULLIF(${payloadLiteral}::jsonb->>'user_id','') IS NULL
             OR d.user_id = (${payloadLiteral}::jsonb->>'user_id')::uuid)
        AND d.kind = ${payloadLiteral}::jsonb->>'kind'
        AND d.subject_key = ${payloadLiteral}::jsonb->>'subject_key';
     GET DIAGNOSTICS v_count = ROW_COUNT;
     SELECT jsonb_build_object('deleted', v_count) INTO v_row;`,

  // The snap returns the whole accounts row. Projected into the same eight
  // fields crate::row::account::AccountRow serialises, money as a decimal string
  // on both sides — numeric::text is exact and involves no rounding function.
  link_bank_account_snap: (payloadLiteral) =>
    `SELECT jsonb_build_object(
              'id', a.id,
              'user_id', a.user_id,
              'name', a.name,
              'type', a.type,
              'currency', a.currency,
              'balance', a.balance::text,
              'initial_balance', a.initial_balance::text,
              'is_active', a.is_active)
       INTO v_row
       FROM public.link_bank_account_snap(
              (${payloadLiteral}::jsonb->>'account_id')::uuid,
              (${payloadLiteral}::jsonb->>'user_id')::uuid,
              (${payloadLiteral}::jsonb->>'bank_balance')::numeric) a;`,
};

/**
 * Run the RPC inside a plpgsql block that CATCHES its exception.
 *
 * Without this, `ON_ERROR_STOP=1` aborts the script the moment the RPC refuses
 * and the state assertions never run — so a refusal could only ever be checked
 * on the SQLite side, and "the refusal rolled everything back" would be
 * asserted on one engine and assumed on the other. The block's implicit
 * savepoint undoes the RPC's partial effects exactly as a rolled-back request
 * would, so what the assertions then see is the same state a refused call leaves
 * behind in production.
 *
 * `WHEN assert_failure OR OTHERS` rather than `WHEN OTHERS`, and it took a
 * harness error to find out why. **`WHEN OTHERS` does not catch
 * `assert_failure`** — one of the two conditions Postgres documents as outside
 * it (the other is `query_canceled`) — and `assert_failure` IS `ERRCODE P0004`,
 * which is what `migrate_categories_atomic` raises BOTH of its named refusals
 * with (`20260724100000:69`, `:76`): `categories_payload_empty` and
 * `category_missing_id`. MEASURED here, 2026-08-11: the exception walked
 * straight past a `WHEN OTHERS` handler and aborted the script.
 *
 * That is a fact about the live RPC and not about this harness. Nothing in the
 * app wraps it in a handler today, so the app is unaffected — PostgREST reports
 * an error either way — but any Postgres function that ever calls it and expects
 * to be able to recover would abort instead, silently, on the two cases most
 * worth recovering from. Recorded here because this is the file that found it.
 */
function guarded(call) {
  return `
CREATE TEMP TABLE _wt_verb_out(row_json jsonb, err text) ON COMMIT DROP;
DO $wtblock$
DECLARE v_row jsonb;
        -- merge_categories has to remember which row it is going to be compared
        -- on BEFORE it runs; see the VERBS entry. Declared for every verb
        -- because a per-verb DECLARE list would be a second place to keep in
        -- step with the first.
        v_first uuid;
        -- delete_category has to count the subtree BEFORE the cascade removes
        -- it, for the reason its own entry gives: ROW_COUNT here would say 1 for
        -- a group of three, and the local verb counts every row that went.
        v_count bigint;
BEGIN
  ${call}
  INSERT INTO _wt_verb_out VALUES (v_row, NULL);
EXCEPTION WHEN assert_failure OR OTHERS THEN
  INSERT INTO _wt_verb_out VALUES (NULL, SQLERRM);
END
$wtblock$;`;
}

/** `WT_PGBIN` first — see lib/postgres.mjs's copy for why. */
function psqlEnv() {
  const prefix = [process.env.WT_PGBIN, '/opt/homebrew/opt/postgresql@17/bin'].filter(Boolean);
  return {
    ...process.env,
    PATH: [...prefix, process.env.PATH ?? ''].join(':'),
    LC_ALL: 'C',
  };
}

/** Dollar-quote the payload so no amount of JSON punctuation can escape it. */
function quote(json) {
  let tag = 'wtpayload';
  let suffix = 0;
  while (json.includes(`$${tag}$`)) {
    suffix += 1;
    tag = `wtpayload${suffix}`;
  }
  return `$${tag}$${json}$${tag}$`;
}

export class PostgresVerbEngine {
  #fixtureSql;
  #host;
  #port;
  #tmp;

  constructor({ fixturePath }) {
    this.#fixtureSql = readFileSync(fixturePath, 'utf8');
    this.#host = process.env.WT_PGDATA ?? '/tmp/wtpg';
    this.#port = process.env.WT_PGPORT ?? '55432';
    this.#tmp = path.join(tmpdir(), `wt-verb-pg-${process.pid}.sql`);
  }

  get name() { return 'postgres'; }

  /** @returns {{ ok: true, version: string, encoding: string } | { ok: false, why: string }} */
  probe() {
    const result = this.#psql(['-c', "SELECT version() || '|' || current_setting('server_encoding')"]);
    if (result.status !== 0) {
      return {
        ok: false,
        why: (result.stderr || result.error?.message || 'psql failed').trim().split('\n')[0],
      };
    }
    const line = result.stdout.trim().split('\n')[0] ?? '';
    const [version, encoding] = line.split('|');
    return { ok: true, version: (version ?? '').split(' on ')[0], encoding: encoding ?? 'unknown' };
  }

  #psql(extra) {
    return spawnSync(
      'psql',
      ['-X', '-q', '-A', '-t', '-h', this.#host, '-p', this.#port, '-U', 'postgres', '-d', 'postgres',
        '-v', 'ON_ERROR_STOP=1', ...extra],
      { env: psqlEnv(), encoding: 'utf8' },
    );
  }

  run(spec) {
    const build = VERBS[spec.command.verb];
    if (!build) throw new Error(`no Postgres RPC is mapped for verb "${spec.command.verb}"`);

    // The local restore takes a LIST of chunks and the cloud RPC takes one, so
    // the driver above unpacks chunks[0]. A spec sending more than one is
    // asserting the LOCAL atomicity, which has no cloud counterpart — and if the
    // driver quietly ran the first chunk anyway, that spec would compare two
    // different operations and report whichever answer it happened to get. Say
    // so instead. Those assertions belong in crates/wealth-core/tests.
    if (spec.command.verb === 'restore_user_chunk' && (spec.command.payload.chunks?.length ?? 0) > 1) {
      throw new Error(
        'a restore spec sending more than one chunk has no Postgres counterpart: the RPC takes ' +
        'one entity per call. Assert the one-transaction property in the crate\'s own tests.',
      );
    }

    const payload = quote(JSON.stringify(spec.command.payload));
    const lines = [
      // Everything inside one transaction that is always rolled back, exactly
      // as the constraint harness does. The RPC's own atomicity is a property of
      // the RPC; this outer transaction is only fixture isolation.
      'BEGIN;',
      this.#fixtureSql,
      spec.setup?.postgres ?? '',
      `\\echo ${SETUP_OK}`,
      guarded(build(payload)),
      `\\echo ${ROW}`,
      "SELECT COALESCE(row_json::text, '') FROM _wt_verb_out;",
      `\\echo ${ERR}`,
      "SELECT COALESCE(err, '') FROM _wt_verb_out;",
    ];
    for (const entry of spec.state ?? []) {
      lines.push(`\\echo ${STATE}${entry.name}`);
      lines.push(entry.postgres.trim().endsWith(';') ? entry.postgres : `${entry.postgres};`);
    }
    lines.push('ROLLBACK;');

    writeFileSync(this.#tmp, `${lines.join('\n')}\n`, 'utf8');
    let result;
    try {
      result = this.#psql(['-f', this.#tmp]);
    } finally {
      try { unlinkSync(this.#tmp); } catch { /* already gone */ }
    }

    const stdout = result.stdout ?? '';
    const stderr = (result.stderr ?? '').trim();

    if (!stdout.includes(SETUP_OK)) {
      throw new Error(`setup failed: ${stderr.split('\n').slice(0, 3).join(' / ') || 'no output'}`);
    }
    if (!stdout.includes(ROW)) {
      // The guard block itself did not run. That is a harness fault, never a
      // refusal — a refusal arrives in the `err` column, not on stderr.
      throw new Error(`the guarded call did not run: ${stderr.split('\n')[0] || 'no output'}`);
    }

    const value = (marker) => {
      const at = stdout.indexOf(marker);
      if (at < 0) return '';
      return (stdout.slice(at + marker.length).split('\n')[1] ?? '').trim();
    };
    const rowText = value(ROW);
    const errText = value(ERR);

    const state = new Map();
    const afterErr = stdout.slice(stdout.indexOf(ERR) + ERR.length).split('\n');
    for (let i = 0; i < afterErr.length; i += 1) {
      const line = afterErr[i].trim();
      if (!line.startsWith(STATE)) continue;
      const name = line.slice(STATE.length);
      const next = (afterErr[i + 1] ?? '').trim();
      state.set(name, next === '' ? 'NULL' : next);
    }

    if (errText !== '') {
      return { outcome: 'refused', code: refusalCode(errText), message: errText, row: null, state };
    }
    // An accepted call with NO row to project is a real outcome, not a fault:
    // `clear_transfer_links([])` returns 0 and there is nothing to compare. The
    // SQLite side reports the same absence as `transaction: null`, so the two
    // still agree — about there being no row.
    return { outcome: 'ok', code: '', message: '', row: rowText === '' ? null : JSON.parse(rowText), state };
  }
}

/**
 * The name of the rule that refused. `RAISE EXCEPTION 'x'` gives SQLERRM `x`;
 * a constraint gives `... violates ... constraint "name"`.
 */
function refusalCode(message) {
  const named = message.match(/constraint "([^"]+)"/);
  if (named) return named[1];
  return message.split('\n')[0].trim();
}
