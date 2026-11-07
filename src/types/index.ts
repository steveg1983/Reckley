import type { AccountType } from './accountType.js';

export type { AccountType };

export interface Holding {
  ticker: string;
  name: string;
  shares: number;
  value: number;
  averageCost?: number;
  currentPrice?: number;
  marketValue?: number;
  gain?: number;
  gainPercent?: number;
  currency?: string;
  costBasis?: number;
  lastUpdated?: Date;
}

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  balance: number;
  currency: string;
  institution?: string;
  lastUpdated: Date;
  openingBalance?: number;
  openingBalanceDate?: Date;
  /**
   * Soft-archive cutoff: transactions on/before this date (that are
   * reconciled) are hidden from the live register. NULL/undefined = nothing
   * archived ("keep all"). Balances are unaffected — see soft_archive.
   */
  archiveThroughDate?: Date | null;
  /**
   * Investment↔cash pairing (the Microsoft Money model): set on a CASH
   * account, pointing at the investment account it belongs to. The Accounts
   * page nests it inside that parent and counts its balance in the parent's
   * section; the cash account itself stays a full, real account (register,
   * transfers, reconciliation). NULL/undefined = a normal top-level account.
   */
  parentAccountId?: string | null;
  /**
   * What this liability is HELD AGAINST — a mortgage against its property, a
   * loan against the portfolios it is drawn on. Set on the LIABILITY, naming
   * the assets. Empty/undefined = an ordinary unsecured liability.
   *
   * SEVERAL, because a loan can be drawn against more than one portfolio. The
   * targets are NOT thereby linked to each other: this is a label each of them
   * carries, not a grouping.
   *
   * DELIBERATELY NOT `parentAccountId`, and the difference is the whole point.
   * A parent means "belongs inside, and counts toward": a cash sleeve moves
   * into its portfolio's card and into its total, because it genuinely is part
   * of it. A secured liability does neither. It stays in Liabilities, where a
   * debt belongs, and it is never added to the asset's total — doing that
   * would silently restate the value of a house as its equity.
   *
   * So this field is read by DISPLAY, and by exactly one opt-in total: the
   * Investments page can show a NET position (portfolio less what is secured
   * against it) when asked. Gross stays the default. Net worth is untouched
   * either way — it already counts the asset and the debt separately, and
   * always did.
   */
  securedAgainstAccountIds?: string[];
  /*
   * `holdings?: Holding[]` WAS here, and it was a phantom: it is not a column
   * of `accounts`, `api/accountMapping` lists it in NOT_ACCOUNT_COLUMNS and
   * strips it from every write, and nothing has ever populated it on a read.
   * Holdings live in their own table and are reached through `@data`'s five
   * investment verbs (see `services/api/investmentService`).
   *
   * A field that cannot hold a value is worse than no field: three surfaces
   * were written against it — an account card's "N positions" line, a "View
   * Portfolio" row button and a whole 267-line PortfolioView modal — and every
   * one of them was unreachable, because the condition guarding it
   * (`account.holdings && account.holdings.length > 0`) can never be true.
   */
  notes?: string;
  isActive?: boolean;
  plaidConnectionId?: string;
  plaidAccountId?: string;
  mask?: string;
  updatedAt?: Date;
  createdAt?: Date;
  sortCode?: string; // UK bank sort code (XX-XX-XX format)
  accountNumber?: string; // Bank account number (typically 8 digits)
  available?: number;
  tags?: string[];
  creditLimit?: number;
  subtype?: string;
  bankBalance?: number | null;
  /**
   * The day `bankBalance` is true for — a calendar day, 'YYYY-MM-DD'.
   *
   * A string rather than a Date on purpose. The column is a Postgres DATE: a
   * day with no time and no zone. Wrapping it in a Date invents a midnight,
   * and a midnight has to belong to some zone — which is how a statement dated
   * the 31st comes to be displayed as the 30th west of Greenwich. Kept as the
   * day itself, storage, comparison and display are all exact, and "is this
   * statement older than what we already hold?" is a string comparison that
   * cannot drift.
   */
  bankBalanceDate?: string | null;
  lastReconciledDate?: Date | null;
  /**
   * The ending balance the last finalized reconciliation was settled against —
   * Microsoft Money's "last statement balance", and therefore the STARTING
   * balance the next reconciliation is offered.
   *
   * Distinct from `bankBalance`, which is what the bank says NOW (a feed or an
   * imported statement writes it, and it moves whenever either does). This one
   * is a record of a decision a person took on a day, and nothing but a
   * finalize may move it.
   *
   * NULL/undefined = no reconciliation has ever been finalized against a
   * confirmed figure, which is the honest state for every account until the
   * first one is. Never zero-as-unknown: £0.00 is a real statement balance (an
   * account swept to zero every night closes on exactly that), so the two
   * cannot share a representation.
   */
  lastReconciledBalance?: number | null;
  lowBalanceThreshold?: number;
  lowBalanceAlertEnabled?: boolean;
}

/**
 * The fields an account update may write.
 *
 * Distinct from `Partial<Account>` because an update can CLEAR a field, which a
 * stored Account never represents: `null` means "remove the stored value".
 * `undefined` cannot express that — mapAccountToDb (services/api/accountService)
 * skips undefined fields, so an undefined sortCode leaves the column untouched
 * rather than emptying it. Any `Partial<Account>` is still a valid update.
 */
export type AccountUpdate = Partial<Omit<Account, 'sortCode'>> & {
  sortCode?: string | null;
};

export interface Transaction {
  id: string;
  date: Date;
  amount: number;
  description: string;
  category: string;
  /**
   * Has a human vouched for `category`?
   *
   * false = the app guessed it (the smart categoriser on a statement file,
   * payee memory on a bank feed) and nobody has agreed yet. The register shows
   * such a category differently and offers a one-click confirm; the figure
   * still counts in every report exactly as before, because a suggestion the
   * user has not got to is still the best answer available.
   *
   * true / undefined = confirmed. `undefined` is what a database without
   * migration 20260808100000 returns, and what the local/demo store holds, so
   * "unmarked" must read as confirmed or the badge appears on everything the
   * user ever typed. See src/utils/categoryProvenance.ts — that asymmetry is
   * written down once and read from there, never re-derived.
   */
  categoryConfirmed?: boolean;
  categoryName?: string;
  /**
   * Did this row arrive from an import that nobody has looked at yet?
   *
   * true = it came in on a statement file or a bank feed and no save has been
   * made against it since. The register prints it in bold, counts it in the
   * "To Review" box beside the View menu and can filter down to it — the
   * Microsoft Money convention, which answers "which of these have I dealt
   * with?" in the register itself rather than in a queue somewhere else.
   *
   * false / undefined = reviewed, or never needed reviewing. `undefined` is
   * what a database without migration 20260810090000 returns, and what the
   * local/demo store holds, so "unmarked" must read as reviewed or the whole of
   * a fifty-thousand row history lights up on the day the flag ships. See
   * src/utils/transactionReview.ts — that asymmetry is written down once and
   * read from there, never re-derived.
   *
   * Distinct from {@link categoryConfirmed}, which is a narrower question about
   * one field: a row can carry a category its own file stated (confirmed) and
   * still be a transaction no human has seen (needs review).
   */
  needsReview?: boolean;
  accountId: string;
  type: 'income' | 'expense' | 'transfer';
  tags?: string[];
  notes?: string;
  /**
   * Marked off against a statement — Microsoft Money's C, a WORKING flag.
   *
   * Set the moment a checkbox is ticked (in the reconciliation screen or the
   * register) and kept if the user walks away, because somebody who has ticked
   * eight hundred rows must not lose them by navigating. It settles nothing on
   * its own: see {@link reconciled}, and src/utils/transactionReconciliation.ts
   * for the one predicate every surface asks.
   */
  cleared?: boolean;
  /**
   * Committed — Microsoft Money's R. Set ONLY by finalizing a reconciliation
   * against a bank balance the user confirmed.
   *
   * `null`/undefined is not "false": it means this row predates the split
   * between marking and committing, and then `cleared` answers for it. That
   * asymmetry is written down once, in src/utils/transactionReconciliation.ts,
   * and read from there — never re-derived, because reading it the other way
   * round would report a whole imported history as unreconciled work.
   *
   * `null` is what a row written before migration 20260810200000 carries (the
   * column is deliberately nullable so that history needed no rewrite);
   * `undefined` is what a database without that migration returns at all, and
   * what the local/demo store holds until something writes the flag.
   */
  reconciled?: boolean | null;
  /** @deprecated Will be removed in reconciliation cleanup */
  reconciledWith?: string;
  /** @deprecated Will be removed in reconciliation cleanup */
  reconciledDate?: Date;
  /** @deprecated Will be removed in reconciliation cleanup */
  reconciledNotes?: string;
  bankReference?: string;
  isRecurring?: boolean;
  isSplit?: boolean;
  isImported?: boolean;
  /**
   * Soft-archived: hidden from the live register but never deleted and still
   * counted in balances and reports. Set by the archive operation and the
   * reconcile-sweep; cleared by unarchive. See the soft_archive migration.
   */
  archived?: boolean;
  pending?: boolean;
  plaidTransactionId?: string;
  merchant?: string;
  paymentChannel?: string;
  location?: {
    city: string | null;
    region: string | null;
    country: string | null;
  };
  goalId?: string;
  accountName?: string;
  /**
   * Position of this row within the statement it was imported from — the
   * BANK's own order among transactions that share a date.
   *
   * `date` is a calendar day, so same-day rows carry no order of their own and
   * the register has to invent one to run a balance down the page. This is the
   * one honest answer: OFX lists <STMTTRN> in statement order, so the file
   * position is the bank's sequence. An ordinal, never a time — a statement
   * states sequence, and a fabricated clock time would be a worse lie.
   *
   * Null/undefined = unknown, which is the truth for every hand-entered row and
   * every row imported before the column existed. See compareChronological for
   * how those interleave with rows that do know their place.
   */
  statementSequence?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
  recurringTransactionId?: string;
  addedBy?: string; // Member ID who added this transaction
  linkedTransferId?: string; // ID of the corresponding transfer transaction in the other account
  transferAccountId?: string; // Account ID of the other side of a transfer
  /**
   * When the linked side is a SPLIT transaction (this leg's opposite is one
   * line inside it, not the whole row): the id of that TransactionSplit line.
   * linkedTransferId then points at the split parent. Absent for ordinary
   * transaction↔transaction pairs.
   */
  linkedTransferSplitId?: string;

  /**
   * The row's open jsonb blob — `transactions.metadata` in both editions.
   *
   * ── WHAT REPLACED `transferMetadata`, AND WHY ───────────────────────────
   *
   * A `transferMetadata` object used to sit here: about twenty fields, of
   * which `fees`, `exchangeRate`, `originalAmount`, `pricePerUnit`,
   * `marketValue`, `costBasis`, `units`, `expectedAmount`, `actualAmount` and
   * `discrepancy` were declared `number` — that is, money and rates held as
   * floats. Nothing ever read it and nothing ever stored it: `mapToDbFields`
   * in services/api/transactionService.ts skipped the key outright, so every
   * value assigned to it was dropped on the way to the database.
   *
   * It was not merely dead, it was a trap: the obvious place for a future
   * implementer to put an exchange rate, in the one representation this
   * codebase forbids for money. The local edition had already reached the same
   * verdict from the other side — `scripts/local-sqlite/schema.sql` promotes
   * that money into typed integer columns and then BANS all ten keys from the
   * blob by CHECK constraint, naming each one.
   *
   * ── WHAT GOES IN HERE INSTEAD ───────────────────────────────────────────
   *
   * Opaque labels and references — never money, never a float. A cross-currency
   * transfer records its conversion under `fx` as an exact decimal STRING; see
   * `utils/fx.ts` for the shape and for why a string rather than a number.
   *
   * Declaring it is also what makes `DataPortTransactionWrites.updateTransaction`
   * honest: its contract lists `metadata` among the sixteen fields the engines
   * honour, and until this field existed that list named something
   * `Partial<Transaction>` could not carry.
   *
   * Not selected by either edition's BOOT projection, deliberately — see
   * BOOT_TRANSACTION_COLUMNS and the Rust `ListedTransaction`. What is written
   * here is held for the record, not for the register's hot path.
   */
  metadata?: Record<string, unknown>;
}

/**
 * One category line of a split transaction. A split transaction stays a
 * single ledger row (one date, one payee, one signed amount, one balance
 * effect); its categorisation moves into lines that MUST sum exactly to the
 * transaction amount — enforced by the set_transaction_splits RPC and its
 * guard trigger. Amounts are signed with the same convention as
 * Transaction.amount; a negative-relative line (e.g. cashback inside a shop)
 * is legal, exactly like Microsoft Money.
 */
export interface TransactionSplit {
  id: string;
  transactionId: string;
  /** Category id as text — same convention as Transaction.category. */
  category: string;
  amount: number;
  memo?: string;
  sortOrder: number;
  /**
   * Set when this LINE is one leg of a transfer (the Microsoft Money model —
   * a transfer recorded inside a split): the account on the other side, and
   * the counterpart transaction over there. The counterpart's
   * linkedTransferId points back at this line's parent transaction, and its
   * linkedTransferSplitId at this line.
   */
  transferAccountId?: string;
  linkedTransferId?: string;
}

/** Input for creating/replacing a transaction's splits (ids are server-assigned). */
export interface TransactionSplitInput {
  category: string;
  amount: number;
  memo?: string;
  /**
   * The line this input replaces, when it came from an existing split. Sending
   * it is what lets the writer tell "this line was edited" from "this line was
   * removed and another arrived" — the distinction a split containing a
   * transfer leg depends on, because a removed leg strands its counterpart.
   * Omitted for brand-new lines (the id is then server-assigned).
   */
  id?: string;
  /**
   * Set to make this LINE one leg of a transfer: the account on the other
   * side. A line that gains a target has its counterpart created and linked in
   * the same write; a line that already carries this target keeps whatever
   * link it has (never a second counterpart).
   */
  transferAccountId?: string;
}

/**
 * What a split write actually did. `counterparts` holds the transactions
 * created for lines that BECAME transfer legs in this write — real rows in
 * other accounts, so the caller updates its state and those accounts'
 * balances from them rather than guessing. Empty for every ordinary split.
 */
export interface SplitWriteResult {
  isSplit: boolean;
  splitCount: number;
  amount: number;
  counterparts: Transaction[];
}

/**
 * What to do with the counterpart a re-point displaces.
 *
 * `move` is the whole point of the feature and the answer in the ordinary case:
 * the counterpart is scaffolding the app created ("create the other side"), so
 * it simply changes address. The other two exist for the counterpart that is a
 * REAL transaction — a row off a statement that happens to have been matched to
 * this transfer — where moving it would drag evidence of one bank's activity
 * into another bank's register. See src/utils/transferCounterpartOrigin.ts for
 * how the two are told apart, and how conservatively.
 *
 *   release — leave it exactly where it is, as a plain unlinked, uncategorised
 *             transaction, and make a fresh counterpart in the new account.
 *             Balance-neutral for the released row: nothing about its amount or
 *             its account changes, only what it claims to be.
 *   delete  — remove it (reversing its account's balance) and make a fresh
 *             counterpart in the new account.
 */
export type TransferDisplacedDisposition = 'move' | 'release' | 'delete';

/**
 * What happened to the counterpart a re-point displaced, so a caller can
 * update the accounts it moved rather than re-deriving them.
 *
 * `moved` names no row because the row is `TransferRepointResult.counterpart` —
 * the same id, at a new address.
 */
export type TransferDisplacedOutcome =
  | { kind: 'moved'; fromAccountId: string }
  | { kind: 'released'; transaction: Transaction }
  | { kind: 'deleted'; id: string; accountId: string; amount: number };

/**
 * What a re-point actually did. Both rows are returned as the store wrote them
 * — a caller that guesses at the categories a re-file produced is a caller that
 * will one day show a register disagreeing with the ledger.
 */
export interface TransferRepointResult {
  /** The edited row, re-filed to face its new counterpart. */
  source: Transaction;
  /** The row now sitting in the target account and linked to the source. */
  counterpart: Transaction;
  /** What became of the counterpart this displaced. */
  displaced: TransferDisplacedOutcome;
}

/**
 * Which sweep made the offer the user refused. Part of a dismissal's identity,
 * because the same two rows can be a transfer pair to one scan and a duplicate
 * to another, and those two offers have opposite consequences — refusing one
 * must never silently suppress the other.
 *
 * The payee kinds are the odd ones out: they are refusals about payee TEXT,
 * not about rows. Payee cleanup guesses which payee texts are one merchant, and
 * that guess is recomputed from the register every time the screen opens — so a
 * refusal of it has to outlive the transactions it happened to be drawn from
 * (re-import a statement and the same wording arrives on brand new rows). They
 * therefore carry no subjectIds, and their subjectKey holds text rather than
 * ids. See utils/suggestionDismissals for the key format that keeps that safe.
 */

/**
 * The three granularities Payee cleanup can be told to stop offering, from
 * narrowest to widest. They are separate kinds rather than one, because they
 * have three different consequences and a user who invoked one must never have
 * another applied for them:
 *
 *   payee-line      one payee kept out of ONE suggested merchant. The payee
 *                   stays in the list and in every other suggestion.
 *   payee-merchant  a whole suggested grouping refused. Every payee under it
 *                   stays in the list, and each may still be renamed by hand.
 *   payee-hidden    a payee taken off the screen altogether: out of the list,
 *                   out of every suggestion, and out of every count on it.
 */
export type PayeeDismissalKind =
  /** A whole suggested merchant on Payee cleanup: "these are not one shop". */
  | 'payee-merchant'
  /** One payee text kept out of a suggested merchant it otherwise matches. */
  | 'payee-line'
  /** One payee text the screen must stop listing and stop counting entirely. */
  | 'payee-hidden';

/**
 * The two ANSWERS a recurring detection can be given (Design handover,
 * 17 Aug §5). Not both refusals: `recurring-confirmed` is the user vouching
 * for a pattern — the statement that lets it feed the calendar and the
 * forecast, which an unconfirmed detection never may. Neither holds financial
 * data and neither changes a figure; confirming can only ALLOW a derived
 * surface to read what the register already says.
 */
export type RecurringAnswerKind =
  /** "Yes, this is a real commitment" — the gate to every derived surface. */
  | 'recurring-confirmed'
  /** "A coincidence" — hidden into a recoverable band, never deleted. */
  | 'recurring-not';

export type DismissalKind =
  | 'transfer-pair'
  | 'transfer-leg'
  | 'stranded'
  | 'duplicate'
  | PayeeDismissalKind
  | RecurringAnswerKind
  /**
   * "Not part of my typical month" — one transaction struck from the
   * forecast BASE (20260819130000). A judgment about a single row, so its
   * key is the row's bare uuid (remapped on restore like any id) and its
   * subject_ids carry the same id, so deleting the row cascades the
   * exclusion away. The row itself is untouched; only the forecast base
   * stops counting it — and states that it has.
   */
  | 'forecast-excluded';

/**
 * A suggestion the user has told a sweep to stop offering. Holds no financial
 * data and changes no figure: it can only hide an offer.
 *
 * See utils/suggestionDismissals for how `subjectKey` is built — canonical and
 * order-independent, so a dismissal survives a re-scan that reaches the same
 * rows from the other end.
 */
export interface SuggestionDismissal {
  id: string;
  kind: DismissalKind;
  subjectKey: string;
  /** The transactions the suggestion was about, in role order. */
  subjectIds: string[];
  dismissedAt: Date;
}

/** The unit of a budget that repeats "every N …" (period 'every'). */
export type BudgetRepeatUnit = 'week' | 'month';

export interface Budget {
  id: string;
  categoryId: string;  // Changed from 'category' to match service implementation
  amount: number;
  /**
   * 'every' is a budget that repeats every N weeks or months (owner, 7 Nov
   * 2026 — "any repeat interval"); `repeatCount` and `repeatUnit` say which,
   * and are null for every other period. See utils/budgetPeriods.
   */
  period: 'monthly' | 'weekly' | 'yearly' | 'custom' | 'quarterly' | 'every';
  repeatCount?: number | null;
  repeatUnit?: BudgetRepeatUnit | null;
  isActive: boolean;
  createdAt: Date;
  name?: string;
  color?: string;
  spent: number;  // Made required to match service
  budgeted?: number;
  limit?: number;
  updatedAt: Date;  // Made required to match service
  startDate?: string;
  /**
   * The last day the budget runs, or null to CLEAR one on an update (`undefined`
   * means "not stated", which an update leaves alone). See utils/budgetPeriods.
   */
  endDate?: string | null;
  rollover?: boolean;
  rolloverAmount?: number;
  alertThreshold?: number;
  notes?: string;
}

export interface Goal {
  id: string;
  name: string;
  type: 'savings' | 'debt-payoff' | 'investment' | 'custom';
  targetAmount: number;
  currentAmount: number;
  targetDate: Date;
  description?: string;
  linkedAccountIds?: string[];
  isActive: boolean;
  createdAt: Date;
  achieved?: boolean;
  progress: number;  // Made required to match service
  updatedAt: Date;  // Made required to match service
  category?: string;
  priority?: 'low' | 'medium' | 'high';
  status?: 'active' | 'completed' | 'paused';
  accountId?: string;
  autoContribute?: boolean;
  contributionAmount?: number;
  contributionFrequency?: string;
  icon?: string;
  color?: string;
  completedAt?: string;
}

/**
 * A report somebody built for themselves — the components they chose, arranged
 * how they chose them, over the rows they chose.
 *
 * ── WHY IT IS HERE AND NOT IN THE COMPONENT THAT DRAWS IT ───────────────────
 *
 * It was declared in `components/CustomReportBuilder.tsx` for as long as its
 * only home was `localStorage['money_management_custom_reports']` — a shape one
 * screen wrote and one screen read, so the screen was a reasonable place to keep
 * it. Since slice 32 a report is a row in the store like a budget or a goal, and
 * the data seam has to name it: `BootSnapshot` carries a list of them and
 * `DataPortReportWrites` takes one. A seam that imported its own vocabulary from
 * a `.tsx` file would pull React, the app context and every icon in that module
 * into the type graph of a layer whose whole promise is that it reaches none of
 * them.
 *
 * So it sits beside `Budget` and `Goal`, which is what it now is, and the
 * builder re-exports it so no existing importer changed.
 *
 * IT CONTAINS NO MONEY. Every figure a report shows is computed from the ledger
 * at the moment it is generated (see `services/customReportService.ts`), which
 * is why nothing here is a `MoneyNumber` and why the seam's rule 2 has nothing
 * to say about this entity.
 */
export type ReportComponentType =
  | 'summary-stats'
  | 'line-chart'
  | 'bar-chart'
  | 'pie-chart'
  | 'table'
  | 'text-block'
  | 'date-comparison'
  | 'category-breakdown'
  | 'account-summary'
  | 'transaction-list'
  | 'budget-progress'
  | 'goal-tracker';

type ConfigPrimitive = string | number | boolean | null;
/**
 * What one config key may hold — exported because the builder's editing
 * handlers have to name it to take a new value from an input, and
 * `ReportComponentConfig[string]` at each call site says the same thing less
 * legibly.
 */
export type ConfigValue = ConfigPrimitive | ConfigPrimitive[];

/**
 * One component's settings — which metrics, how many rows, what to sort by.
 *
 * Deliberately open: each component type reads the handful of keys it
 * understands and ignores the rest, so adding a knob to one generator is not a
 * change to this type. It is stored as JSON, so the value union is what JSON can
 * hold and nothing else — a `Date` in here would come back as a string and no
 * reader would notice.
 */
export type ReportComponentConfig = Record<string, ConfigValue>;

export interface ReportComponent {
  id: string;
  type: ReportComponentType;
  title: string;
  config: ReportComponentConfig;
  width: 'full' | 'half' | 'third';
}

/**
 * One stated deviation from the forecast BASE: the monthly figure the
 * scenario uses for one category in place of the twelve-month average
 * (docs/forecast-direction.md — the scenario tool, whose Budget writes only
 * ever happen by the explicit stage-2 promotion).
 *
 * `monthlyMinor` is PENNIES, an integer — the one representation of money
 * both engines hold exactly, crossing the seam without a scale conversion.
 * A magnitude: the category's own income/expense type says which side it
 * lands on. Relational (one row per category, `categoryId` a real column)
 * rather than a document keyed by ids, because the restore remapper rewrites
 * uuid COLUMNS and deliberately never the keys of a jsonb object.
 */
export interface ForecastAdjustment {
  id: string;
  categoryId: string;
  monthlyMinor: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CustomReport {
  id: string;
  name: string;
  description: string;
  components: ReportComponent[];
  /**
   * Which rows the report is about.
   *
   * `accounts` and `categories` hold ROW IDS; `tags` holds the labels somebody
   * typed. That distinction is not cosmetic — it is what
   * `backup/format.ts`'s `jsonbIdArrays` spec remaps on a restore and what it
   * deliberately leaves alone, and getting it the wrong way round would either
   * strand a report against accounts that no longer exist or rewrite a person's
   * own words into a uuid.
   */
  filters: {
    dateRange: 'month' | 'quarter' | 'year' | 'custom';
    customStartDate?: string;
    customEndDate?: string;
    accounts?: string[];
    categories?: string[];
    tags?: string[];
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface Category {
  id: string;
  name: string;
  type: 'income' | 'expense' | 'both';
  level: 'type' | 'sub' | 'detail';
  parentId?: string | null;
  color?: string;
  icon?: string;
  isSystem?: boolean;
  description?: string;
  isTransferCategory?: boolean; // Indicates this is an account-specific transfer category
  isRevaluationCategory?: boolean; // Indicates a change in VALUE (portfolio revaluation) — not income, expense or transfer
  isUnassignedBucket?: boolean; // Rows here are NOT classified — they carry a category id only because the splits schema forbids blank; treated as uncategorised (the MS Money importer's "Unassigned" bucket)
  accountId?: string; // The account this transfer category is associated with
  isActive?: boolean; // Used for soft-deleting categories (e.g., when account is deleted)
}

/**
 * What a category merge actually moved — the database's own counts, not the
 * client's prediction, so the confirmation toast reports what happened rather
 * than what was expected. `splitTransactions` is the number of split PARENTS
 * touched; `splitLines` the number of individual lines inside them.
 */
export interface CategoryMergeResult {
  sourceId: string;
  targetId: string;
  transactions: number;
  splitLines: number;
  splitTransactions: number;
  budgets: number;
  recurring: number;
}

export interface Investment {
  id: string;
  accountId: string;
  symbol: string;
  name: string;
  quantity: number;
  purchasePrice: number;
  purchaseDate: Date;
  currentPrice?: number;
  lastUpdated?: Date;
  notes?: string;
  costBasis?: number;
  currentValue: number;
  averageCost: number;
  createdAt: Date;
}

// Export AppState
export type { AppState, Tag } from './app-state.js';

// User type for authentication
export interface User {
  id: string;
  email: string;
  name?: string;
  profileImageUrl?: string;
  createdAt: Date;
}

export interface RecurringTransaction {
  id: string;
  description: string;
  amount: number;
  type: 'income' | 'expense';
  category: string;
  accountId: string;
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  startDate: Date;
  endDate?: Date;
  nextDate: Date;
  lastProcessed?: Date;
  isActive: boolean;
  tags?: string[];
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Re-export widget types
export * from './widget-types.js';

// Re-export subscription types
export * from '@app-types/subscription';
