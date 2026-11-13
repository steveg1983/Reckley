/**
 * THE SHOWCASE LEDGER — ten invented years of a comfortable financial life,
 * generated for landing-page screenshots (owner's spec, 29 Aug 2026).
 *
 * The story, as specified:
 *  - A house bought before the window opens: worth £450k at the start with a
 *    £195k mortgage; the mortgage amortises to ~£50k over the ten years while
 *    the house revalues to ~£690k (the owner's third cut — the first said
 *    £600k → £1m, which helped compound the whole ledger past its target).
 *  - A personal pension opening at £110k: £2,000/month transferred in from
 *    the current account, each followed by a £400 government top-up recorded
 *    as an Account Adjustment, the whole pot growing at ~6.5%/yr TWR.
 *  - A Hargreaves Lansdown Stocks & Shares ISA opening at £83k:
 *    the FULL ISA allowance in each tax year (owner's correction of 29 Aug,
 *    after the first cut fed it £3k/month — £36k/yr against a £20k limit):
 *    £15,240/yr to April 2017, £20,000/yr since, monthly. Deployed in
 *    quarterly purchases — index funds tracking the FTSE 100 and S&P 500
 *    carrying most of it, with smaller single-stock positions (Apple,
 *    Alphabet, Microsoft, Rolls-Royce, Shell, Rio Tinto).
 *  - Instant-access savings from £50k to ~£100k (calibrated below).
 *  - Net salary rising fairly linearly from £144k/yr to £240k/yr (the
 *    owner's second cut; the first said £180k → £300k).
 *  - A leased car whose payment steps every three years: £500 → £850 →
 *    £1,150 → £1,500 a month.
 *  - Two credit cards carrying the day-to-day (fuel, dining, coffee, shops),
 *    paid in full every month, always.
 *  - THE COMMITMENTS A VISITOR RECOGNISES (his note of 29 Aug, after the
 *    recurring report showed car finance and a coffee shop): Netflix, Sky,
 *    Amazon Prime, Disney+, Paramount+, Spotify, iCloud, the council, the
 *    water, the TV licence, the mobile, the gym, two insurers and a monthly
 *    charity donation — each holding its price to the penny and stepping on a
 *    plausible date, because that is both how a subscription behaves and what
 *    the detector reads. See SUBSCRIPTIONS.
 *  - Lifestyle spending is the RESIDUAL: whatever the salary leaves after the
 *    commitments above, spent on running a life — his instruction was to
 *    work it out and see where the total lands.
 *
 * EVERY figure, payee, price and institution below is invented or a public
 * market approximation: this repo is public and this data exists to be
 * photographed.
 *
 * DETERMINISTIC by construction — a seeded PRNG and a fixed "today", so two
 * runs produce byte-identical ledgers and a tweak re-runs in seconds.
 *
 * KEEPING IT CURRENT (owner, 13 Nov 2026, about to show the account to an
 * accountant friend): seeded on 29 Aug, by November every monthly budget read
 * "nothing spent" and the ledger looked abandoned. `TODAY` is now the ONE date
 * to move. The window still opens in September 2016 and runs to the month
 * TODAY falls in; the unfinished edges (uncleared, unreconciled, to review)
 * are placed relative to it; and nothing dated after it is written, so the
 * current month is a month in progress — salary not yet in, half the shopping
 * done — and never a row from the future. Move TODAY, dry-run, reseed.
 *
 * Usage:
 *   npx tsx scripts/seedShowcaseUser.mts --dry-run
 *     → prints the year-by-year story and final balances; touches nothing.
 *   npx tsx scripts/seedShowcaseUser.mts --email demo@example.com --password 'S3cret!' [--env .env.local]
 *     → creates/reuses the Clerk user and seeds the lot. REFUSES to run on a
 *       user that already has categories, accounts or transactions.
 *   … --email demo@example.com --user-id <users.id uuid> [--replace]
 *     → seeds an EXISTING users row directly, no Clerk call at all. This is
 *       the mode for accounts whose Clerk identity lives on a different
 *       instance from the env file's key — the trap that bit on 29 Aug, when
 *       a dev-instance CLERK_SECRET_KEY resolved a production account to a
 *       ghost and nearly minted a second users row. The email must match the
 *       row: an id is easy to mistype, and a wrong one must not seed.
 *       --replace lifts the refuse-to-reseed guard by DELETING the user's
 *       financial data first, table by table with counts — for the
 *       re-photograph loop, where the ledger is regenerated whole.
 *
 * Same safety construction as scripts/seedDemoUser.mts, which this extends in
 * spirit: every write scoped to one user id; re-running cannot duplicate
 * (without --replace, which says exactly what it removed); pointing it at a
 * lived-in account cannot touch the data unless --replace says so twice over
 * (the flag AND a matching email).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { DEFAULT_CATEGORY_TREE } from '../src/data/defaultCategoryTree';

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY_RUN = args.includes('--dry-run');
const fail = (msg: string): never => { console.error(`ABORT: ${msg}`); process.exit(1); };

// ── Deterministic randomness ─────────────────────────────────────────────────
// mulberry32: tiny, seedable, good enough to jitter grocery bills. The seed is
// fixed so the ledger is reproducible; change it only to reroll the texture.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260829);
/** Jitter a base amount by ±pct, to 2dp — zero-mean, so totals stay honest. */
const jitter = (base: number, pct: number): number =>
  Math.round(base * (1 + (rand() * 2 - 1) * pct) * 100) / 100;
/** A day-of-month spread around `base` (±3), clamped to 1..28. */
const dayNear = (base: number): number =>
  Math.min(28, Math.max(1, base + Math.floor(rand() * 7) - 3));

// ── The clock ────────────────────────────────────────────────────────────────

const START = { y: 2016, m: 9 };            // September 2016
const TODAY = '2026-11-13';                  // fixed, for determinism — the ONE date to move
/** September 2016 to the month TODAY falls in, inclusive: ten years and a little. */
const MONTHS = (Number(TODAY.slice(0, 4)) * 12 + Number(TODAY.slice(5, 7)) - 1)
  - (START.y * 12 + (START.m - 1)) + 1;
/** TODAY moved by whole days, as a date string. Noon UTC, so no zone can turn the day. */
const daysFromToday = (days: number): string => {
  const at = new Date(`${TODAY}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};
/** Month index → { y, m } (m is 1-12). */
const ym = (i: number): { y: number; m: number } => {
  const t = (START.y * 12 + (START.m - 1)) + i;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
};
const dstr = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const monthDate = (i: number, d: number): string => { const { y, m } = ym(i); return dstr(y, m, d); };
/** Linear interpolation across the window. */
const lerp = (from: number, to: number, i: number): number => from + (to - from) * (i / (MONTHS - 1));
const pounds = (n: number): number => Math.round(n * 100) / 100;

/** Month index of a calendar month, from the window's start (Sep 2016 = 0). */
const mi = (y: number, m: number): number => (y - 2016) * 12 + (m - 9);

// ── The market: one path, shared by everything that floats ───────────────────
// Monthly log-returns with the decade's shape — the 2018 wobble, the 2020
// crash and rebound, the 2022 drawdown — then NORMALISED so the whole path
// compounds to exactly the target annual TWR. Instruments ride this path with
// their own beta and drift, so the ISA's trackers, the single stocks and the
// pension funds all breathe together the way real portfolios do.

function marketPath(annualTwr: number): number[] {
  // THE DECADE'S ACTUAL SHAPE, month by month (owner, 30 Aug: the net-worth
  // line "looks too straight a line … I want to see some slight downticks
  // because of market volatility"). The first cut had shocks so shallow that
  // steady contributions ironed them flat.
  //
  // These follow the real sequence of events an equity investor lived
  // through — the Q4 2018 selloff, the Covid crash and its V, the grinding
  // 2022 bear, the August 2024 unwind, a 2025 correction — at roughly their
  // real DEPTHS. What is not real is the average: the S&P returned about
  // 13% a year over this window and the owner set 4.5%, so the whole series
  // is normalised down afterwards. Keeping the drawdowns at full depth and
  // taking the difference out of the good months is the honest way to do
  // that, and it is what a balanced portfolio with bonds in it actually
  // looks like: real falls, gentler recoveries.
  //
  // Month indices are from September 2016 = 0, so `mi` reads them by date.
  const shocks = new Map<number, number>([
    [mi(2018, 10), -0.052], [mi(2018, 11), -0.031], [mi(2018, 12), -0.061], // Q4 2018
    [mi(2019, 1), 0.068],                                                   // and its snap-back
    [mi(2020, 2), -0.085], [mi(2020, 3), -0.152],                           // Covid
    [mi(2020, 4), 0.108], [mi(2020, 5), 0.045], [mi(2020, 6), 0.028],       // the V
    [mi(2022, 1), -0.048], [mi(2022, 2), -0.031],                           // 2022, the long one
    [mi(2022, 4), -0.079], [mi(2022, 6), -0.076], [mi(2022, 9), -0.088],
    [mi(2022, 10), 0.071], [mi(2023, 1), 0.055],
    [mi(2024, 8), -0.049], [mi(2024, 9), 0.038],                            // the August unwind
    [mi(2025, 4), -0.087], [mi(2025, 5), 0.052],                            // a 2025 correction
    [mi(2026, 2), -0.037],                                                  // and a wobble since
  ]);
  const r = mulberry32(65537);
  const raw: number[] = [];
  for (let i = 0; i < MONTHS; i += 1) {
    const noise = (r() * 2 - 1) * 0.02;
    raw.push(0.005 + noise + (shocks.get(i) ?? 0));
  }
  // Normalise: scale additively in log-space so Π(1+r) = (1+twr)^(years).
  const targetLog = Math.log(1 + annualTwr) * (MONTHS / 12);
  const currentLog = raw.reduce((s, x) => s + Math.log(1 + x), 0);
  const adjust = (targetLog - currentLog) / MONTHS;
  return raw.map(x => Math.exp(Math.log(1 + x) + adjust) - 1);
}

// The pension's specified TWR — 4.5% since the owner's tweak of 29 Aug
// (first cut ran at his original 6.5% and compounded the whole ledger to
// nearly twice the aspiration).
const MARKET = marketPath(0.045);

/** An instrument's own monthly path: the market, leveraged by beta, plus its own story. */
function instrumentPath(beta: number, annualAlpha: number, seed: number): number[] {
  const r = mulberry32(seed);
  const alpha = Math.log(1 + annualAlpha) / 12;
  return MARKET.map(m => Math.exp(Math.log(1 + m) * beta + alpha + (r() * 2 - 1) * 0.01) - 1);
}

// ── Instruments ──────────────────────────────────────────────────────────────
// Real tickers carry approximations of their public decade (a demo must rhyme
// with reality to be believable); the funds are invented. All GBP.

interface Instrument {
  symbol: string; name: string; assetType: 'etf' | 'mutual_fund' | 'stock';
  startPrice: number; beta: number; alpha: number; seed: number;
  /** Share of each deployment this instrument takes, per account. */
  weight: number;
}

const ISA_INSTRUMENTS: Instrument[] = [
  { symbol: 'HLUK100', name: 'UK 100 Index Fund Acc', assetType: 'mutual_fund', startPrice: 1.82, beta: 0.85, alpha: -0.005, seed: 11, weight: 0.30 },
  { symbol: 'HLSP500', name: 'US 500 Index Fund Acc', assetType: 'mutual_fund', startPrice: 2.41, beta: 1.15, alpha: 0.045, seed: 12, weight: 0.40 },
  { symbol: 'AAPL', name: 'Apple Inc', assetType: 'stock', startPrice: 21.5, beta: 1.3, alpha: 0.09, seed: 13, weight: 0.06 },
  { symbol: 'GOOGL', name: 'Alphabet Inc', assetType: 'stock', startPrice: 31.0, beta: 1.25, alpha: 0.05, seed: 14, weight: 0.05 },
  { symbol: 'MSFT', name: 'Microsoft Corp', assetType: 'stock', startPrice: 44.0, beta: 1.2, alpha: 0.08, seed: 15, weight: 0.06 },
  { symbol: 'RR.L', name: 'Rolls-Royce Holdings', assetType: 'stock', startPrice: 7.4, beta: 1.6, alpha: 0.0, seed: 16, weight: 0.04 },
  { symbol: 'SHEL.L', name: 'Shell plc', assetType: 'stock', startPrice: 19.2, beta: 0.9, alpha: 0.01, seed: 17, weight: 0.05 },
  { symbol: 'RIO.L', name: 'Rio Tinto plc', assetType: 'stock', startPrice: 24.8, beta: 1.0, alpha: 0.02, seed: 18, weight: 0.04 },
];

const PENSION_INSTRUMENTS: Instrument[] = [
  { symbol: 'PENGEQ', name: 'Global Equity Pension Fund', assetType: 'mutual_fund', startPrice: 3.12, beta: 1.05, alpha: 0.01, seed: 21, weight: 0.60 },
  { symbol: 'PENUKE', name: 'UK Equity Income Pension Fund', assetType: 'mutual_fund', startPrice: 2.05, beta: 0.9, alpha: -0.01, seed: 22, weight: 0.25 },
  { symbol: 'PENBND', name: 'Sterling Bond Pension Fund', assetType: 'mutual_fund', startPrice: 1.48, beta: 0.3, alpha: 0.0, seed: 23, weight: 0.15 },
];

// ── The commitments, and what they cost over ten years ──────────────────────
//
// The owner, 29 Aug: the recurring report showed car finance and a coffee
// shop, where a visitor should recognise their own life — "Netflix, Sky,
// Council Tax, Amazon Prime, Paramount". Two things follow, and both are
// about honesty as much as recognition:
//
//  * A SUBSCRIPTION HOLDS ITS PRICE. The detector qualifies a pattern on runs
//    of identical amounts, because that is what tells a subscription from a
//    supermarket — so a jittered Netflix is invisible to it, and rightly.
//  * A PRICE THAT NEVER MOVES IS ALSO A LIE. Ten years of streaming is a
//    decade of increases, so each carries a schedule, and the report's
//    price-change line — dated, with the annual impact — has something true
//    to say.
//
// Services that did not exist in 2016 START when they launched (Disney+ in
// March 2020, Paramount+ in June 2022), which is why the schedules are keyed
// to absolute months rather than offsets. Every figure is a plausible public
// price, not a bill anybody actually paid.

type PriceStep = readonly [from: number, price: number];

/** The price in force in month `i`, or null before the first step. */
const subscriptionPrice = (steps: readonly PriceStep[], i: number): number | null => {
  let price: number | null = null;
  for (const [from, step] of steps) if (i >= from) price = step;
  return price;
};

interface Subscription {
  day: number;
  payee: string;
  category: string;
  account: string;
  steps: readonly PriceStep[];
}

const SUBSCRIPTIONS: readonly Subscription[] = [
  // Household direct debits — the council, the water, the licence.
  {
    day: 1, payee: 'ELMBRIDGE BOROUGH COUNCIL', category: 'Council Tax', account: 'current',
    // Rises every April, as a council tax bill does.
    steps: [
      [0, 198.42], [mi(2017, 4), 207.33], [mi(2018, 4), 216.65], [mi(2019, 4), 226.40],
      [mi(2020, 4), 236.58], [mi(2021, 4), 247.23], [mi(2022, 4), 258.35], [mi(2023, 4), 269.98],
      [mi(2024, 4), 282.13], [mi(2025, 4), 294.82], [mi(2026, 4), 308.09],
    ],
  },
  {
    day: 5, payee: 'THAMES WATER', category: 'Water & Sewerage', account: 'current',
    steps: [
      [0, 42.16], [mi(2018, 4), 45.30], [mi(2020, 4), 48.75], [mi(2022, 4), 53.10],
      [mi(2024, 4), 61.40], [mi(2025, 4), 74.85],
    ],
  },
  {
    day: 2, payee: 'TV LICENCE MONTHLY', category: 'Telephone/Broadband/Sky/Tv Licence', account: 'current',
    steps: [
      [0, 12.13], [mi(2017, 4), 12.25], [mi(2018, 4), 12.54], [mi(2019, 4), 12.88],
      [mi(2020, 4), 13.13], [mi(2021, 4), 13.25], [mi(2024, 4), 14.13], [mi(2025, 4), 14.54],
    ],
  },
  // Connectivity.
  {
    day: 7, payee: 'SKY Q TV & BROADBAND', category: 'Telephone/Broadband/Sky/Tv Licence', account: 'current',
    steps: [
      [0, 62.00], [mi(2018, 6), 68.00], [mi(2020, 6), 74.00], [mi(2022, 6), 81.00],
      [mi(2024, 6), 89.00], [mi(2026, 6), 96.00],
    ],
  },
  {
    day: 9, payee: 'EE MOBILE', category: 'Mobile Phone', account: 'current',
    steps: [
      [0, 35.00], [mi(2019, 3), 40.00], [mi(2022, 3), 46.00], [mi(2024, 3), 52.00],
      [mi(2026, 3), 58.00],
    ],
  },
  // Streaming — the recognisable heart of the report, each starting when it
  // actually launched in the UK and rising the way it actually rose.
  {
    day: 13, payee: 'NETFLIX.COM', category: 'Subscriptions', account: 'amex',
    steps: [
      [0, 7.49], [mi(2019, 6), 8.99], [mi(2021, 4), 9.99], [mi(2023, 3), 10.99],
      [mi(2025, 2), 12.99],
    ],
  },
  {
    day: 14, payee: 'SPOTIFY UK', category: 'Subscriptions', account: 'amex',
    steps: [[0, 9.99], [mi(2023, 4), 10.99], [mi(2024, 5), 11.99]],
  },
  {
    day: 16, payee: 'AMAZON PRIME MEMBERSHIP', category: 'Subscriptions', account: 'amex',
    steps: [[0, 7.99], [mi(2022, 9), 8.99]],
  },
  {
    day: 17, payee: 'DISNEY PLUS', category: 'Subscriptions', account: 'amex',
    steps: [[mi(2020, 4), 5.99], [mi(2021, 2), 7.99], [mi(2023, 11), 8.99], [mi(2025, 10), 10.99]],
  },
  {
    day: 18, payee: 'PARAMOUNT PLUS', category: 'Subscriptions', account: 'amex',
    steps: [[mi(2022, 7), 6.99], [mi(2024, 8), 7.99]],
  },
  {
    day: 19, payee: 'APPLE.COM/BILL ICLOUD', category: 'Subscriptions', account: 'amex',
    steps: [[0, 2.49], [mi(2021, 5), 6.99], [mi(2023, 11), 8.99]],
  },
  // The rest of a life.
  {
    day: 15, payee: 'DAVID LLOYD CLUBS', category: 'Subscriptions', account: 'current',
    steps: [
      [0, 85.00], [mi(2018, 9), 95.00], [mi(2021, 9), 110.00], [mi(2023, 9), 128.00],
      [mi(2025, 9), 145.00],
    ],
  },
  {
    day: 11, payee: 'AVIVA HOME INSURANCE', category: 'Insurance', account: 'current',
    // Renews each September, as an annual policy paid monthly does.
    steps: [
      [0, 41.20], [mi(2018, 9), 44.60], [mi(2020, 9), 49.80], [mi(2022, 9), 58.40],
      [mi(2024, 9), 68.90], [mi(2025, 9), 74.20],
    ],
  },
  {
    day: 12, payee: 'ADMIRAL MULTICAR', category: 'Insurance-V', account: 'current',
    steps: [
      [0, 88.50], [mi(2018, 3), 94.20], [mi(2020, 3), 102.60], [mi(2022, 3), 121.40],
      [mi(2024, 3), 148.30], [mi(2026, 3), 162.75],
    ],
  },
  {
    day: 22, payee: 'CANCER RESEARCH UK', category: 'Gifts', account: 'current',
    steps: [[0, 20.00], [mi(2021, 1), 25.00], [mi(2024, 1), 30.00]],
  },
];

// ── The ledger being built ───────────────────────────────────────────────────

interface Txn {
  id: string; account: string; date: string; description: string;
  amount: number; type: 'income' | 'expense' | 'transfer'; category: string | null;
  needsReview?: boolean; uncleared?: boolean;
}
const txns: Txn[] = [];
const transferPairs: Array<{ out: Txn; into: Txn }> = [];

const add = (account: string, date: string, description: string, amount: number,
  category: string | null, extra?: Partial<Txn>): Txn => {
  const t: Txn = {
    id: randomUUID(), account, date, description, amount: pounds(amount),
    type: amount >= 0 ? 'income' : 'expense', category, ...extra,
  };
  txns.push(t);
  return t;
};
const addTransfer = (fromA: string, toA: string, date: string, desc: string, amount: number): void => {
  const out = add(fromA, date, desc, -amount, 'CAT:Transfer Out');
  const into = add(toA, date, desc, amount, 'CAT:Transfer In');
  out.type = 'transfer'; into.type = 'transfer';
  transferPairs.push({ out, into });
};

// Category references are by name at build time ('CAT:<name>'), resolved to
// ids at insert time — the dry run never needs a database.

// ── Accounts ─────────────────────────────────────────────────────────────────

interface AccountSeed {
  key: string; name: string; type: string; initial: number; institution: string;
  linked?: boolean;
}
const ACCOUNTS: AccountSeed[] = [
  { key: 'current', name: 'Premier Current Account', type: 'checking', initial: 4200, institution: 'HSBC', linked: true },
  { key: 'saver', name: 'Instant Access Saver', type: 'savings', initial: 50000, institution: 'Marcus by Goldman Sachs' },
  { key: 'amex', name: 'Platinum Cashback Card', type: 'credit', initial: 0, institution: 'American Express', linked: true },
  { key: 'visa', name: 'Rewards Visa', type: 'credit', initial: 0, institution: 'Barclaycard', linked: true },
  { key: 'pension', name: 'Personal Pension — SIPP', type: 'investment', initial: 110000, institution: 'Scottish Widows' },
  { key: 'isa', name: 'Stocks & Shares ISA', type: 'investment', initial: 83000, institution: 'Hargreaves Lansdown' },
  { key: 'house', name: 'Home — 14 Orchard Lane', type: 'asset', initial: 450000, institution: 'Property' },
  { key: 'mortgage', name: 'Mortgage — 14 Orchard Lane', type: 'mortgage', initial: -195000, institution: 'Nationwide' },
];

// ── The engine ───────────────────────────────────────────────────────────────

// Mortgage: £195k at 3%/yr; the payment is solved so ten years of amortisation
// leaves ~£50k outstanding (the owner's spec) — £1,525/mo does it.
const MORTGAGE_RATE_M = 0.03 / 12;
const MORTGAGE_PAYMENT = 1525;

// School fees per TERM, for two children, one school year per entry — the
// window's first entry is 2016/17. Rising about 5.5% a year, which is what
// they have done. Three terms a year: September, January, April.
const SCHOOL_FEES_PER_TERM = [
  8500, 8950, 9450, 9950, 10500, 11100, 11700, 12400, 13150, 13950, 14800,
] as const;

// Car lease eras — every three years, the payment the owner named.
const LEASES = [
  { until: 36, amount: 500, payee: 'BMW FINANCIAL SERVICES' },
  { until: 72, amount: 850, payee: 'AUDI FINANCE' },
  { until: 108, amount: 1150, payee: 'MERCEDES-BENZ FINANCE UK' },
  { until: 999, amount: 1500, payee: 'PORSCHE FINANCIAL SERVICES' },
];

// Saver: opening £50k → ~£100k. Interest follows the decade's UK rates; the
// flat monthly top-up is CALIBRATED below to land the target.
const SAVER_RATE_M = (i: number): number =>
  (i < 48 ? 0.008 : i < 66 ? 0.004 : i < 78 ? 0.025 : 0.042) / 12;

function calibrateSaverTopUp(): number {
  const target = 100000;
  let lo = 0; let hi = 800;
  for (let iter = 0; iter < 40; iter += 1) {
    const t = (lo + hi) / 2;
    let bal = 50000;
    for (let i = 0; i < MONTHS; i += 1) bal = bal * (1 + SAVER_RATE_M(i)) + t;
    if (bal > target) hi = t; else lo = t;
  }
  return Math.round(((lo + hi) / 2) / 5) * 5; // a standing order is a round number
}
const SAVER_TOPUP = calibrateSaverTopUp();

// Holdings state, per investment account.
interface Holding {
  inst: Instrument; qty: number; cost: number; path: number[];
  buys: Array<{ date: string; qty: number; price: number; total: number }>;
}
const mkHoldings = (list: Instrument[]): Holding[] =>
  list.map(inst => ({ inst, qty: 0, cost: 0, path: instrumentPath(inst.beta, inst.alpha, inst.seed), buys: [] }));
const priceAt = (h: Holding, i: number): number => {
  let p = h.inst.startPrice;
  for (let k = 0; k <= i; k += 1) p *= 1 + h.path[k];
  return Math.round(p * 10000) / 10000;
};

const isaHoldings = mkHoldings(ISA_INSTRUMENTS);
const pensionHoldings = mkHoldings(PENSION_INSTRUMENTS);

/** Deploy `cash` across an account's instruments at month i's prices. */
function buy(holdings: Holding[], accountKey: string, i: number, cash: number, day: number): number {
  let spent = 0;
  for (const h of holdings) {
    const slice = pounds(cash * h.inst.weight);
    if (slice < 50) continue;
    const price = priceAt(h, i);
    const qty = Math.round((slice / price) * 10000) / 10000;
    const total = pounds(qty * price);
    h.qty += qty; h.cost += total; spent += total;
    h.buys.push({ date: monthDate(i, day), qty, price, total });
  }
  return pounds(spent);
}

// ── HOW AN INVESTMENT ACCOUNT IS VALUED, AND THE TRAP IT SETS ────────────────
//
// The app splits the job in two (services/investments/investmentValuation):
//
//   what the surfaces show = ledger balance + Σ(units × price − pooled cost)
//                            └ money in/out ┘  └ the unrealised gain ────┘
//
// So an investment account's REGISTER carries contributions AT COST, and the
// holdings plus their price series carry the gain. Writing "Market Value
// Update" rows into such an account as well counts that gain TWICE — measured
// on the first seed of this ledger: the app showed £2,036,616 where the
// balances summed to £1,720,293, and the £316,323.78 difference was exactly
// Σ(market value − cost basis). The app was right; the data was wrong.
//
// Hence: NO revaluation rows for accounts that have holdings. The house keeps
// its own — a property has no holdings, so there the register IS the only
// source of its value, and the same arithmetic reads it correctly.
//
// The trade history goes to investment_events (what the valuation walks to
// know what was held WHEN) as well as investment_transactions (the older
// table the Investments screens read). Without events, a position is treated
// as held in full since its purchase date, which would lift the early years
// of the net-worth curve into a shape nobody lived.
interface InvestState { cash: number; holdings: Holding[]; value: number }
const isaState: InvestState = { cash: 0, holdings: isaHoldings, value: 0 };
const pensionState: InvestState = { cash: 0, holdings: pensionHoldings, value: 0 };

const holdingsValue = (hs: Holding[], i: number): number =>
  pounds(hs.reduce((s, h) => s + h.qty * priceAt(h, i), 0));

// Opening deployment: the opening balances are already-invested portfolios.
{
  // "before the window": buy at month-0 prices, cost basis = opening value.
  buy(isaHoldings, 'isa', 0, 83000 * 0.97, 1);
  isaState.cash = pounds(83000 - isaHoldings.reduce((s, h) => s + h.cost, 0));
  buy(pensionHoldings, 'pension', 0, 110000 * 0.98, 1);
  pensionState.cash = pounds(110000 - pensionHoldings.reduce((s, h) => s + h.cost, 0));
  isaState.value = pounds(isaState.cash + holdingsValue(isaHoldings, 0));
  pensionState.value = pounds(pensionState.cash + holdingsValue(pensionHoldings, 0));
}

// House path: the decade's shape (steady, a 2020 pause, a 2021-22 surge),
// normalised to land £1.0m from £600k.
const HOUSE_PATH = ((): number[] => {
  const raw: number[] = [];
  for (let i = 0; i < MONTHS; i += 1) {
    const yearish = i / 12;
    raw.push(yearish < 3.5 ? 0.004 : yearish < 4.6 ? 0.0 : yearish < 6.2 ? 0.008 : 0.0028);
  }
  const targetLog = Math.log(690000 / 450000);
  const currentLog = raw.reduce((s, x) => s + Math.log(1 + x), 0);
  const adjust = (targetLog - currentLog) / MONTHS;
  return raw.map(x => Math.exp(Math.log(1 + x) + adjust) - 1);
})();

// ── Simulate the ten years ───────────────────────────────────────────────────

let mortgageBal = -195000;
let houseVal = 450000;
let saverBal = 50000;
let currentBal = 4200;
let amexOwed = 0;   // this month's spending, paid next month
let visaOwed = 0;
const yearly: Array<Record<string, number>> = [];
/** Every month's net worth — what the chart actually draws. */
const monthlyNetWorth: Array<{ date: string; value: number }> = [];

// The last weeks stay unfinished on purpose — the Reconciliation and To
// Review screenshots need work to show.
// Three weeks uncleared; reconciled to the end of the month before last
// (day 0 of last month is the last day of the one before it).
const CLEARED_UP_TO = daysFromToday(-22);
const RECONCILED_UP_TO = new Date(Date.UTC(
  Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)) - 2, 0, 12,
)).toISOString().slice(0, 10);

for (let i = 0; i < MONTHS; i += 1) {
  const { y, m } = ym(i);
  const isCurrentMonth = i === MONTHS - 1;

  // Salary: £12,000 → £20,000 net/month, stepping each April.
  const aprils = Math.floor((i + (START.m - 4 + 12) % 12) / 12);
  const salary = pounds(12000 + (20000 - 12000) * (aprils / 10));
  add('current', monthDate(i, 25), 'MERIDIAN CAPITAL LLP — SALARY', salary, 'CAT:Net Pay');
  currentBal += salary;

  // Pension: the £2,000 in, then HMRC's £400 — an Account Adjustment, exactly
  // as the owner records his own (value arrived, nothing was earned or spent).
  addTransfer('current', 'pension', monthDate(i, 1), 'STANDING ORDER — SIPP CONTRIBUTION', 2000);
  currentBal -= 2000; pensionState.cash += 2000;
  add('pension', monthDate(i, 3), 'HMRC TAX RELIEF AT SOURCE', 400, 'CAT:Account Adjustment');
  pensionState.cash += 400;

  // ISA: the tax year's full allowance, monthly — £15,240/yr until April
  // 2017, £20,000/yr since (raised at Budget 2017, frozen ever after).
  const isaAllowance = (y < 2017 || (y === 2017 && m < 4)) ? 15240 : 20000;
  const isaIn = pounds(isaAllowance / 12);
  addTransfer('current', 'isa', monthDate(i, 2), 'STANDING ORDER — HL ISA', isaIn);
  currentBal -= isaIn; isaState.cash += isaIn;

  // Saver top-up (calibrated) and monthly interest.
  addTransfer('current', 'saver', monthDate(i, 4), 'STANDING ORDER — INSTANT SAVER', SAVER_TOPUP);
  currentBal -= SAVER_TOPUP;
  const interest = pounds(saverBal * SAVER_RATE_M(i));
  saverBal = pounds(saverBal * (1 + SAVER_RATE_M(i)) + SAVER_TOPUP);
  if (interest > 0) add('saver', monthDate(i, 28), 'INTEREST PAID', interest, 'CAT:Bank Interest');

  // Mortgage: interest charged inside the account, payment transferred in.
  const mInterest = pounds(-mortgageBal * MORTGAGE_RATE_M);
  add('mortgage', monthDate(i, 5), 'INTEREST CHARGED', -mInterest, 'CAT:Loan Interest Paid');
  addTransfer('current', 'mortgage', monthDate(i, 6), 'MORTGAGE PAYMENT — NATIONWIDE', MORTGAGE_PAYMENT);
  mortgageBal = pounds(mortgageBal - mInterest + MORTGAGE_PAYMENT);
  currentBal -= MORTGAGE_PAYMENT;

  // The car of the era.
  const lease = LEASES.find(l => i < l.until) ?? LEASES[3];
  add('current', monthDate(i, 8), lease.payee, -lease.amount, 'CAT:Financing & Leasing Charges');
  currentBal -= lease.amount;

  // House: quarterly revaluation.
  const growth = pounds(houseVal * HOUSE_PATH[i]);
  houseVal = pounds(houseVal + growth);
  if (m % 3 === 0) {
    const quarter = pounds(houseVal - 450000 - txns
      .filter(t => t.account === 'house')
      .reduce((s, t) => s + t.amount, 0));
    const reval = add('house', monthDate(i, 15), 'PROPERTY VALUE UPDATE — LOCAL SOLD PRICES', quarter, 'CAT:Market Value Change');
    reval.type = quarter >= 0 ? 'income' : 'expense';
  }

  // Investment accounts: quarterly deployment of accumulated cash, monthly
  // valuation row derived from the identity (see InvestState).
  for (const [key, st] of [['isa', isaState], ['pension', pensionState]] as const) {
    if (m % 3 === 1 && i > 0 && st.cash > 5000) {
      const spent = buy(st.holdings, key, i, st.cash - 500, 10);
      st.cash = pounds(st.cash - spent);
    }
    // No revaluation row: the holdings carry the gain — see the note above.
    // st.value is tracked as the VALUED figure (cash + market value), which
    // is what the app will show, so the dry run reports what the screenshots
    // will say rather than the at-cost ledger underneath it.
    st.value = pounds(st.cash + holdingsValue(st.holdings, i));
  }

  // ── Bills and life, era-scaled ─────────────────────────────────────────────
  const scale = lerp(1, 1.9, i);            // prices roughly double over the decade
  const post = (day: number, payee: string, amount: number, catName: string, acct: string): void => {
    const amt = -amount;
    add(acct, monthDate(i, day), payee, amt, `CAT:${catName}`);
    if (acct === 'current') currentBal += amt;
    else if (acct === 'amex') amexOwed -= amt;
    else visaOwed -= amt;
  };
  /** Genuinely variable spending: a shop, a tank of fuel, a restaurant. */
  const bill = (day: number, payee: string, base: number, catName: string, acct = 'current'): void =>
    post(day, payee, jitter(base * scale, 0.06), catName, acct);
  /** A commitment at its exact price — see the note by SUBSCRIPTIONS. */
  const fixedBill = (day: number, payee: string, price: number, catName: string, acct = 'current'): void =>
    post(day, payee, price, catName, acct);

  // ── The commitments everybody recognises ───────────────────────────────────
  // Each holds its price TO THE PENNY and steps on a plausible date, because
  // that is both how a subscription behaves and what the detector reads: it
  // qualifies a pattern on runs of identical amounts, which is how it tells a
  // subscription from a supermarket (utils/recurringDetection). Jittering
  // these — as the first cut did — produced a recurring report showing car
  // finance and nothing else, because Netflix never charged the same figure
  // twice. Stepping prices also feed the detector's most useful output: the
  // price CHANGE, dated, with its annual impact.
  for (const s of SUBSCRIPTIONS) {
    const price = subscriptionPrice(s.steps, i);
    if (price === null) continue;   // the service did not exist yet
    fixedBill(s.day, s.payee, price, s.category, s.account);
  }

  // Energy is the honest exception: it genuinely varies by season, and spiked
  // through 2022. Left variable on purpose — a utility that wanders is what
  // the report's Confirm button exists for.
  {
    const { m: month } = ym(i);
    // Cheapest in July, dearest in January; the 2021-23 crisis on top. Posted
    // through `post` rather than `bill` deliberately: `bill` applies the
    // decade's price scale, and this figure already carries its own drift —
    // stacking the two put a £649 energy bill in the ledger.
    const winter = 1 + 0.42 * Math.cos(((month - 1) / 12) * 2 * Math.PI);
    const crisis = i >= mi(2021, 10) && i <= mi(2023, 6) ? 1.75 : 1;
    post(3, 'OCTOPUS ENERGY', jitter(lerp(120, 185, i) * winter * crisis, 0.05),
      'Gas & Electricity', 'current');
  }

  // School fees, three terms a year — the owner's own suggestion (29 Aug)
  // when he caught £53k of clothing: at this income the money goes on the
  // children, not on coats. Two at a Surrey prep, billed each September,
  // January and April, rising the way school fees actually rise. The window
  // opens in September, so the school year IS the twelve months from each
  // year's month 0, and a term is month 0, 4 or 7 within it.
  {
    const termInYear = i % 12;
    if (termInYear === 0 || termInYear === 4 || termInYear === 7) {
      const fee = SCHOOL_FEES_PER_TERM[Math.min(Math.floor(i / 12), SCHOOL_FEES_PER_TERM.length - 1)];
      post(6, 'OAKFIELD PREP SCHOOL — FEES', fee, 'Nursery / Schooling', 'current');
    }
  }

  // Cards: the day-to-day, always on plastic (owner's spec).
  bill(dayNear(4), 'SHELL WEYBRIDGE', 55, 'Fuel Costs', 'amex');
  bill(dayNear(18), 'BP CONNECT COBHAM', 52, 'Fuel Costs', 'amex');
  for (const day of [3, 8, 13, 19, 24]) {
    bill(dayNear(day), rand() < 0.5 ? 'WAITROSE & PARTNERS' : 'M&S SIMPLY FOOD', 68, 'Food Shopping', 'visa');
  }
  for (const day of [6, 12, 21]) {
    bill(dayNear(day), ['THE IVY COBHAM', 'CÔTE BRASSERIE', 'PIZZA EXPRESS', 'THE WHITE HART'][Math.floor(rand() * 4)], 48, 'Dining Out', 'amex');
  }
  for (const day of [2, 9, 16, 23]) {
    bill(dayNear(day), rand() < 0.6 ? 'CAFFÈ NERO' : 'GAIL\'S BAKERY', 4.4, 'Coffee Shops', 'amex');
  }
  bill(dayNear(17), 'DELIVEROO', 18, 'Takeaways', 'visa');
  bill(dayNear(20), 'AMAZON.CO.UK', 24, 'Other/Misc-H', 'visa');
  bill(dayNear(22), 'JOHN LEWIS & PARTNERS', 45, 'Furnishings', 'visa');

  // Seasonal: December gifts, summer holiday, February ski trip most years.
  if (m === 12) bill(dayNear(10), 'JOHN LEWIS & PARTNERS', 260, 'Gifts', 'visa');
  // The family's year away — raised on the owner's instruction of 29 Aug
  // ("increase the holiday spending"), and rising with everything else,
  // because `bill` carries the decade's price scale. Booked where a family
  // books it: flights in the spring, the hotel in the summer, half-terms in
  // February and October, and a long-haul Christmas every third year.
  if (m === 2) bill(dayNear(12), 'CRYSTAL SKI HOLIDAYS', 3400, 'Family Holidays', 'amex');
  if (m === 5) bill(dayNear(6), 'BRITISH AIRWAYS', 2600, 'Family Holidays', 'amex');
  if (m === 7) {
    bill(dayNear(8), 'MARRIOTT RESORTS', 4200, 'Family Holidays', 'amex');
    bill(dayNear(14), 'HERTZ ITALIA', 620, 'Family Holidays', 'amex');
  }
  if (m === 10) bill(dayNear(20), 'CENTER PARCS LONGLEAT', 1750, 'Family Holidays', 'visa');
  if (m === 12 && y % 3 === 0) bill(dayNear(2), 'EMIRATES', 6800, 'Family Holidays', 'amex');
  // The residual spender: whatever the month's committed flows leave behind
  // beyond a modest cushion goes on living (the owner's instruction) — split
  // across the categories a card statement actually carries.
  {
    // Spend the month's surplus down to a believable cushion — the owner's
    // instruction was to work the lifestyle out as the residual and see
    // where it lands. The categories are what a comfortable card statement
    // actually carries; weights jitter so no two months match.
    const cushion = 6000 + (currentBal - 6000) * 0.06; // drift gently toward ~£6k
    let left = pounds(currentBal - amexOwed - visaOwed - cushion);
    if (left > 400) {
      // Each outlet has a MONTHLY CEILING, because a residual that simply
      // divides what is left produces the figure the owner caught on 29 Aug:
      // £53,494 a year on clothing, which nobody spends. Clothing also
      // appeared TWICE in the old list — two shops, one category, a third of
      // the surplus between them. The ceilings are what a household at this
      // income plausibly spends on each thing, in 2016 money; `scale` carries
      // them through the decade. Anything still left when every ceiling is
      // full simply stays in the current account, which is what actually
      // happens to money nobody has a plan for.
      const chunks: Array<{ payee: string; category: string; account: string; ceiling: number }> = [
        { payee: 'SELFRIDGES & CO', category: 'Clothing', account: 'amex', ceiling: 340 },
        { payee: 'MOLLY MAID SURREY', category: 'Cleaning Costs', account: 'current', ceiling: 320 },
        { payee: 'CENTRE COURT GARDEN CO', category: 'Maintenance, Repairs & Gardening', account: 'visa', ceiling: 400 },
        { payee: 'SECRET ESCAPES', category: 'Family Holidays', account: 'amex', ceiling: 180 },
        { payee: 'PC RICHARDSON INTERIORS', category: 'Furnishings', account: 'visa', ceiling: 300 },
        { payee: 'THE PETERSHAM RICHMOND', category: 'Dining Out', account: 'amex', ceiling: 260 },
        { payee: 'APPLE STORE REGENT ST', category: 'Other/Misc-P', account: 'visa', ceiling: 220 },
        { payee: 'SURREY SPORTS CLUB — KIDS', category: 'Days Out', account: 'current', ceiling: 260 },
        { payee: 'WATCHES OF SWITZERLAND', category: 'Gifts', account: 'amex', ceiling: 190 },
        { payee: 'BUPA DENTAL CARE', category: 'Dental', account: 'current', ceiling: 130 },
        { payee: 'HALFORDS AUTOCENTRE', category: 'Servicing, Maintenance & Repairs', account: 'visa', ceiling: 170 },
      ];
      for (const chunk of chunks) {
        if (left < 120) break;
        const ceiling = chunk.ceiling * scale;
        const amt = pounds(Math.min(left * 0.9, jitter(ceiling, 0.28)));
        if (amt < 40) continue;
        bill(dayNear(15), chunk.payee, amt / scale, chunk.category, chunk.account);
        left = pounds(left - amt);
      }
    }
  }

  // Card statements: last month's balance paid in full, always (the spec).
  if (amexOwed > 0 && !isCurrentMonth) {
    addTransfer('current', 'amex', monthDate(i, 24), 'AMEX PAYMENT RECEIVED — THANK YOU', pounds(amexOwed));
    currentBal -= amexOwed; amexOwed = 0;
  }
  if (visaOwed > 0 && !isCurrentMonth) {
    addTransfer('current', 'visa', monthDate(i, 26), 'BARCLAYCARD PAYMENT — THANK YOU', pounds(visaOwed));
    currentBal -= visaOwed; visaOwed = 0;
  }

  {
    const netWorthNow = houseVal + mortgageBal + pensionState.value
      + isaState.value + saverBal + currentBal - amexOwed - visaOwed;
    monthlyNetWorth.push({ date: monthDate(i, 28), value: pounds(netWorthNow) });
  }

  if (m === 12 || isCurrentMonth) {
    const netWorth = houseVal + mortgageBal + pensionState.value
      + isaState.value + saverBal + currentBal - amexOwed - visaOwed;
    yearly.push({
      year: y,
      house: houseVal, mortgage: mortgageBal, pension: pensionState.value,
      isa: isaState.value, saver: saverBal, current: pounds(currentBal),
      netWorth: pounds(netWorth),
    });
  }
}

// ── The unfinished edges (the whole point of two of the screenshots) ─────────

// Recent card arrivals still awaiting review, feed-style.
const REVIEW_ROWS: Array<[string, number, string, number]> = [
  ['amex', -3, 'PRET A MANGER 441', -6.4],
  ['amex', -2, 'SHELL WEYBRIDGE', -58.2],
  ['visa', -2, 'WAITROSE & PARTNERS 220', -84.15],
  ['current', -1, 'FPS CREDIT R HARRIS', 120.0],
  ['visa', -1, 'AMAZON.CO.UK MKTP', -31.99],
  ['amex', -1, 'TFL TRAVEL CHARGE', -8.4],
];
for (const [acct, daysAgo, desc, amt] of REVIEW_ROWS) {
  add(acct, daysFromToday(daysAgo), desc, amt, null, { needsReview: true, uncleared: true });
}

// ── Nothing from the future ──────────────────────────────────────────────────
// The engine above writes each month whole, the current one included. A ledger
// seeded mid-month would otherwise hold a salary dated the 25th and shopping
// dated next week. Drop what has not happened yet — both legs of a transfer
// together — BEFORE anything is reported or written. Every balance below is
// summed from `txns`, so the registers and their balances still agree to the
// penny. No holding is bought in the dropped stretch unless TODAY falls before
// the 10th of a quarter's first month; the check says so rather than assuming.
{
  const before = txns.length;
  const kept = txns.filter(t => t.date <= TODAY);
  txns.length = 0;
  txns.push(...kept);
  const pairs = transferPairs.filter(pair => pair.out.date <= TODAY && pair.into.date <= TODAY);
  transferPairs.length = 0;
  transferPairs.push(...pairs);
  for (const h of [...isaHoldings, ...pensionHoldings]) {
    if (h.buys.some(b => b.date > TODAY)) {
      fail(`a holding (${h.inst.symbol}) is bought after ${TODAY}: move TODAY past that purchase or before its month`);
    }
  }
  console.log(`\nnot yet happened on ${TODAY}: ${before - txns.length} rows left out of the current month`);
}

// ── Dry-run report ───────────────────────────────────────────────────────────

const fmt = (n: number): string => `£${Math.round(n).toLocaleString('en-GB')}`;
console.log(`\nTHE SHOWCASE LEDGER — ${txns.length.toLocaleString()} transactions over ten years`);
console.log(`saver standing order calibrated to £${SAVER_TOPUP}/mo\n`);
console.log('year   house      mortgage   pension    ISA        saver     current    NET WORTH');
for (const r of yearly) {
  console.log(
    `${r.year}   ${fmt(r.house).padEnd(10)} ${fmt(r.mortgage).padEnd(10)} ${fmt(r.pension).padEnd(10)} ${fmt(r.isa).padEnd(10)} ${fmt(r.saver).padEnd(9)} ${fmt(r.current).padEnd(10)} ${fmt(r.netWorth)}`
  );
}
const last = yearly[yearly.length - 1];
const netWorth = last.house + last.mortgage + last.pension + last.isa + last.saver + last.current;
// The owner's question of 30 Aug, answered in the report rather than by
// squinting at a chart: where does the line actually go DOWN, and how far?
{
  const dips: Array<{ from: string; to: string; drop: number; pct: number }> = [];
  let peak = monthlyNetWorth[0];
  let trough = monthlyNetWorth[0];
  for (const point of monthlyNetWorth) {
    if (point.value >= peak.value) {
      if (trough.value < peak.value) {
        dips.push({
          from: peak.date, to: trough.date,
          drop: pounds(peak.value - trough.value),
          pct: (peak.value - trough.value) / peak.value,
        });
      }
      peak = point; trough = point;
    } else if (point.value < trough.value) {
      trough = point;
    }
  }
  const worst = dips.sort((a, b) => b.drop - a.drop).slice(0, 5);
  console.log('\nthe line goes DOWN here — deepest falls in monthly net worth:');
  for (const d of worst) {
    console.log(`  ${d.from.slice(0, 7)} → ${d.to.slice(0, 7)}   −${fmt(d.drop)}  (${(d.pct * 100).toFixed(1)}%)`);
  }
}

console.log(`\nNET WORTH at the END of the current month, as the engine runs it: ${fmt(netWorth)}`);
console.log("  (the owner's band of 29 Aug was £1.72m–£1.75m for a ledger ending that month; later months sit above it)");
console.log(`\nregister balances on ${TODAY} — what the accounts will show:`);
for (const a of ACCOUNTS) {
  const pence = txns.filter(t => t.account === a.key).reduce((s, t) => s + Math.round(t.amount * 100), 0);
  console.log(`  ${a.name.padEnd(30)} ${fmt((Math.round(a.initial * 100) + pence) / 100)}`);
}
{
  const month = TODAY.slice(0, 7);
  const spent = new Map<string, number>();
  for (const t of txns) {
    if (!t.date.startsWith(month) || t.type !== 'expense' || t.category === null) continue;
    spent.set(t.category, (spent.get(t.category) ?? 0) + Math.round(-t.amount * 100));
  }
  console.log(`\nspent so far in ${month}, the budgeted categories:`);
  for (const name of ['Food Shopping', 'Dining Out', 'Fuel Costs', 'Coffee Shops']) {
    console.log(`  ${name.padEnd(16)} ${fmt((spent.get(`CAT:${name}`) ?? 0) / 100)}`);
  }
}
console.log('\nISA holdings today:');
for (const h of isaHoldings) {
  const price = priceAt(h, MONTHS - 1);
  console.log(`  ${h.inst.symbol.padEnd(8)} ${h.inst.name.padEnd(32)} qty ${h.qty.toFixed(2).padStart(12)}  value ${fmt(h.qty * price)}`);
}
console.log('Pension holdings today:');
for (const h of pensionHoldings) {
  const price = priceAt(h, MONTHS - 1);
  console.log(`  ${h.inst.symbol.padEnd(8)} ${h.inst.name.padEnd(32)} qty ${h.qty.toFixed(2).padStart(12)}  value ${fmt(h.qty * price)}`);
}

if (DRY_RUN) {
  console.log('\nDRY RUN — nothing written.');
  process.exit(0);
}

// ── Insert mode ──────────────────────────────────────────────────────────────

const EMAIL = flag('email') ?? fail('--email is required (or use --dry-run)');
const USER_ID = flag('user-id');
const REPLACE = args.includes('--replace');
const PASSWORD = USER_ID ? undefined : (flag('password') ?? fail('--password is required (unless --user-id)'));
const envPath = flag('env') ?? '.env.local';
if (!existsSync(envPath)) fail(`env file not found: ${envPath}`);
const env = Object.fromEntries(readFileSync(envPath, 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const { createClient } = await import('@supabase/supabase-js');
const url = env.VITE_SUPABASE_URL ?? fail('VITE_SUPABASE_URL missing');
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? fail('SUPABASE_SERVICE_ROLE_KEY missing');
const clerkKey = env.CLERK_SECRET_KEY ?? fail('CLERK_SECRET_KEY missing');
const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

async function clerkFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${clerkKey}`, 'Content-Type': 'application/json', ...init?.headers },
  });
}
async function findOrCreateClerkUser(): Promise<string> {
  const lookup = await clerkFetch(`/users?email_address=${encodeURIComponent(EMAIL)}`);
  if (!lookup.ok) fail(`Clerk lookup failed: HTTP ${lookup.status}`);
  const existing = (await lookup.json()) as Array<{ id: string }>;
  if (existing.length > 0) { console.log(`Clerk user exists (${existing[0].id}) — reusing.`); return existing[0].id; }
  const created = await clerkFetch('/users', {
    method: 'POST',
    body: JSON.stringify({
      email_address: [EMAIL], password: PASSWORD,
      first_name: 'Alex', last_name: 'Showcase', skip_password_checks: true,
    }),
  });
  if (!created.ok) fail(`Clerk create failed: HTTP ${created.status} ${await created.text()}`);
  const user = (await created.json()) as { id: string };
  console.log(`Clerk user created: ${user.id}`);
  return user.id;
}
async function findOrCreateDbUser(clerkId: string): Promise<string> {
  const { data: found, error: readErr } = await sb.from('users').select('id').eq('clerk_id', clerkId).maybeSingle();
  if (readErr) fail(`users read: ${readErr.message}`);
  if (found) { console.log(`users row exists (${found.id}) — reusing.`); return found.id; }
  const { data: inserted, error: insErr } = await sb.from('users').insert({
    clerk_id: clerkId, email: EMAIL, first_name: 'Alex', last_name: 'Showcase',
    subscription_tier: 'pro', subscription_status: 'active',
  }).select('id').single();
  if (insErr || !inserted) fail(`users insert: ${insErr?.message}`);
  console.log(`users row created: ${inserted.id}`);
  return inserted.id;
}

let USER: string;
if (USER_ID) {
  const { data, error } = await sb.from('users').select('id, email').eq('id', USER_ID).maybeSingle();
  if (error) fail(`users read: ${error.message}`);
  if (!data) fail(`no users row with id ${USER_ID}`);
  if ((data.email ?? '').toLowerCase() !== EMAIL.toLowerCase()) {
    fail(`users row ${USER_ID} has email ${data.email}, not ${EMAIL} — refusing (the email is the second key)`);
  }
  console.log(`seeding existing user ${USER_ID} (${data.email}) — Clerk untouched`);
  USER = data.id;
} else {
  const clerkId = await findOrCreateClerkUser();
  USER = await findOrCreateDbUser(clerkId);
}

if (REPLACE) {
  // The re-photograph loop: remove this user's financial data, in
  // FK-dependency order, saying exactly what went. The users row, its
  // preferences and its layouts stay — identity and taste are not ledger.
  const WIPE_ORDER = [
    'deleted_feed_transactions', 'suggestion_dismissals', 'import_rules',
    'recurring_transactions', 'transactions',
    'investment_transactions', 'investment_prices', 'investments',
    'budgets', 'bank_connections', 'accounts', 'categories',
  ] as const;
  for (const table of WIPE_ORDER) {
    const { count, error } = await sb.from(table)
      .delete({ count: 'exact' }).eq('user_id', USER);
    if (error) fail(`--replace wipe of ${table}: ${error.message}`);
    if ((count ?? 0) > 0) console.log(`  wiped ${table}: ${count}`);
  }
}

for (const table of ['categories', 'accounts', 'transactions'] as const) {
  const { count, error } = await sb.from(table).select('id', { count: 'exact', head: true }).eq('user_id', USER);
  if (error) fail(`${table} count: ${error.message}`);
  if ((count ?? 0) > 0) fail(`user ${USER} already has ${count} ${table} — refusing to seed twice (--replace overrides)`);
}

// Categories: the SHIPPING starter tree (so screenshots match what a new user
// gets) plus the system set, plus the handful of extra leaves this life needs.
interface CatRow { id: string; name: string; type: string; level: string; parent?: string; isSystem?: boolean; isTransfer?: boolean; isRevaluation?: boolean }
const catRows: CatRow[] = [
  { id: randomUUID(), name: 'Income', type: 'income', level: 'type', isSystem: true },
  { id: randomUUID(), name: 'Expense', type: 'expense', level: 'type', isSystem: true },
  { id: randomUUID(), name: 'Transfer', type: 'both', level: 'type', isSystem: true, isTransfer: true },
  { id: randomUUID(), name: 'Transfer In', type: 'both', level: 'detail', parent: 'Transfer', isSystem: true, isTransfer: true },
  { id: randomUUID(), name: 'Transfer Out', type: 'both', level: 'detail', parent: 'Transfer', isSystem: true, isTransfer: true },
  { id: randomUUID(), name: 'Revaluation', type: 'both', level: 'type', isSystem: true, isRevaluation: true },
  { id: randomUUID(), name: 'Market Value Change', type: 'both', level: 'detail', parent: 'Revaluation', isSystem: true, isRevaluation: true },
  { id: randomUUID(), name: 'Account Adjustment', type: 'both', level: 'detail', parent: 'Revaluation', isSystem: true, isRevaluation: true },
];
for (const group of DEFAULT_CATEGORY_TREE) {
  const parentType = group.type === 'income' ? 'Income' : 'Expense';
  catRows.push({ id: randomUUID(), name: group.name, type: group.type, level: 'sub', parent: parentType });
  const leaves = group.children.length > 0 ? group.children : [group.name];
  for (const leaf of leaves) {
    catRows.push({ id: randomUUID(), name: leaf, type: group.type, level: 'detail', parent: group.name });
  }
}

// The generator speaks a few names the tree holds twice (Insurance,
// Other/Misc) — disambiguated here by group. 'Insurance-V' means Vehicles'.
const DISAMBIG: Record<string, [string, string]> = {
  'Insurance': ['Household', 'Insurance'],
  'Insurance-V': ['Vehicles', 'Insurance'],
  'Other/Misc-H': ['Household', 'Other/Misc'],
  'Other/Misc-P': ['Personal', 'Other/Misc'],
};
const catIdByName = new Map<string, string>();
const catIdByPair = new Map<string, string>();
for (const c of catRows) {
  if (!catIdByName.has(c.name)) catIdByName.set(c.name, c.id);
  if (c.parent) catIdByPair.set(`${c.parent}:${c.name}`, c.id);
}
function resolveCat(ref: string | null): string | null {
  if (ref === null) return null;
  const name = ref.replace(/^CAT:/, '');
  const dis = DISAMBIG[name];
  if (dis) return catIdByPair.get(`${dis[0]}:${dis[1]}`) ?? fail(`unknown category pair ${dis.join(':')}`);
  return catIdByName.get(name) ?? fail(`unknown category ${name}`);
}

{
  const rows = catRows.map(c => ({
    id: c.id, user_id: USER, name: c.name, type: c.type, level: c.level,
    parent_id: c.parent ? (catIdByName.get(c.parent) ?? fail(`unknown parent ${c.parent}`)) : null,
    is_system: c.isSystem ?? false,
    is_transfer_category: c.isTransfer ?? false,
    is_revaluation_category: c.isRevaluation ?? false,
    is_active: true,
  }));
  const { error } = await sb.from('categories').insert(rows);
  if (error) fail(`categories insert: ${error.message}`);
  console.log(`categories: ${rows.length}`);
}

// Accounts.
const acctId = new Map<string, string>(ACCOUNTS.map(a => [a.key, randomUUID()]));
const acct = (key: string): string => acctId.get(key) ?? fail(`unknown account ${key}`);
{
  const { error } = await sb.from('accounts').insert(ACCOUNTS.map(a => ({
    id: acct(a.key), user_id: USER, name: a.name, type: a.type, currency: 'GBP',
    balance: a.initial, initial_balance: a.initial, institution: a.institution, is_active: true,
  })));
  if (error) fail(`accounts insert: ${error.message}`);
  console.log(`accounts: ${ACCOUNTS.length}`);
}

// Transactions.
{
  const rows = txns.map(t => ({
    id: t.id, user_id: USER, account_id: acct(t.account), date: t.date,
    description: t.description, amount: t.amount, type: t.type,
    category: resolveCat(t.category),
    is_cleared: !t.uncleared && t.date <= CLEARED_UP_TO,
    is_reconciled: !t.uncleared && t.date <= RECONCILED_UP_TO,
    needs_review: t.needsReview ?? false,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from('transactions').insert(rows.slice(i, i + 200));
    if (error) fail(`transactions insert (batch ${i}): ${error.message}`);
  }
  console.log(`transactions: ${rows.length}`);
}
for (const { out, into } of transferPairs) {
  for (const [leg, other] of [[out, into], [into, out]] as const) {
    const { error } = await sb.from('transactions')
      .update({ transfer_account_id: acct(other.account), linked_transfer_id: other.id })
      .eq('id', leg.id).eq('user_id', USER);
    if (error) fail(`transfer link (${leg.description} ${leg.date}): ${error.message}`);
  }
}
console.log(`transfers: ${transferPairs.length} pairs linked`);

// Balances from the register — the identity, not a guess.
for (const a of ACCOUNTS) {
  const sum = txns.filter(t => t.account === a.key).reduce((s, t) => s + Math.round(t.amount * 100), 0);
  const balance = (Math.round(a.initial * 100) + sum) / 100;
  const linked = a.linked
    ? { bank_balance: balance, bank_balance_date: TODAY }
    : {};
  const { error } = await sb.from('accounts').update({ balance, ...linked }).eq('id', acct(a.key)).eq('user_id', USER);
  if (error) fail(`balance (${a.name}): ${error.message}`);
  console.log(`  ${a.name}: £${balance.toFixed(2)}`);
}

// Holdings + trade history + quarterly price series.
{
  const invRows: object[] = [];
  const tradeRows: object[] = [];
  const eventRows: object[] = [];
  const priceRows: object[] = [];
  for (const [key, holdings] of [['isa', isaHoldings], ['pension', pensionHoldings]] as const) {
    for (const h of holdings) {
      const invId = randomUUID();
      const price = priceAt(h, MONTHS - 1);
      invRows.push({
        id: invId, user_id: USER, account_id: acct(key),
        symbol: h.inst.symbol, name: h.inst.name,
        quantity: h.qty, cost_basis: pounds(h.cost),
        current_price: price, market_value: pounds(h.qty * price),
        asset_type: h.inst.assetType, currency: 'GBP',
        purchase_date: h.buys[0]?.date ?? monthDate(0, 1),
        purchase_price: h.buys[0]?.price ?? h.inst.startPrice,
        last_updated: new Date(`${TODAY}T08:00:00Z`).toISOString(),
      });
      for (const b of h.buys) {
        tradeRows.push({
          id: randomUUID(), investment_id: invId, user_id: USER,
          transaction_type: 'buy', quantity: b.qty, price: b.price,
          total_amount: b.total, date: b.date,
        });
        // The same purchase as an EVENT — what the valuation walks to know
        // what was held when. Without these the early years of the net-worth
        // curve would value today's whole position from its first purchase.
        eventRows.push({
          id: randomUUID(), user_id: USER, account_id: acct(key),
          symbol: h.inst.symbol, security_name: h.inst.name,
          event_date: b.date, kind: 'buy',
          quantity: b.qty, price: b.price, fees: 0, amount: b.total,
          currency: 'GBP', source: 'import',
        });
      }
      for (let q = 0; q < MONTHS; q += 3) {
        priceRows.push({
          user_id: USER, symbol: h.inst.symbol, price_date: monthDate(q, 27),
          price: priceAt(h, q), currency: 'GBP', source: 'manual',
        });
      }
      priceRows.push({
        user_id: USER, symbol: h.inst.symbol, price_date: TODAY,
        price, currency: 'GBP', source: 'manual',
      });
    }
  }
  for (const [table, rows] of [['investments', invRows], ['investment_transactions', tradeRows], ['investment_events', eventRows], ['investment_prices', priceRows]] as const) {
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb.from(table).insert(rows.slice(i, i + 200));
      if (error) fail(`${table} insert: ${error.message}`);
    }
    console.log(`${table}: ${rows.length}`);
  }
}

// Budgets — the screenshot's subjects, sized to the ledger's own spending.
{
  const budgets: Array<[string, string, number, string]> = [
    ['Food shopping', 'Food Shopping', 1600, 'monthly'],
    ['Dining out', 'Dining Out', 900, 'monthly'],
    ['Fuel', 'Fuel Costs', 260, 'monthly'],
    ['Coffee', 'Coffee Shops', 90, 'monthly'],
    ['Holidays', 'Family Holidays', 15000, 'yearly'],
    ['Gifts', 'Gifts', 1200, 'yearly'],
  ];
  const rows = budgets.map(([name, catName, amount, period]) => ({
    user_id: USER, name, amount, period,
    category: resolveCat(`CAT:${catName}`),
    category_id: resolveCat(`CAT:${catName}`),
    start_date: '2026-01-01', is_active: true, alert_threshold: 80,
  }));
  const { error } = await sb.from('budgets').insert(rows);
  if (error) fail(`budgets insert: ${error.message}`);
  console.log(`budgets: ${rows.length}`);
}

// Bank feeds: three healthy connections, their linked accounts and a recent
// sync trail — enough for the Bank Feeds page to photograph. The tokens are
// the string below; nothing here can call a bank.
{
  const connections = [
    { key: 'current', institution_id: 'demo-hsbc', name: 'HSBC' },
    { key: 'amex', institution_id: 'demo-amex', name: 'American Express' },
    { key: 'visa', institution_id: 'demo-barclaycard', name: 'Barclaycard' },
  ];
  for (const c of connections) {
    const connId = randomUUID();
    const { error } = await sb.from('bank_connections').insert({
      id: connId, user_id: USER, provider: 'truelayer',
      institution_id: c.institution_id, institution_name: c.name,
      access_token_encrypted: 'demo-showcase-not-a-token',
      status: 'connected',
      last_sync: new Date(`${TODAY}T06:30:00Z`).toISOString(),
      expires_at: new Date(`${daysFromToday(83)}T00:00:00Z`).toISOString(),
    });
    if (error) fail(`bank_connections (${c.name}): ${error.message}`);
    const { error: linkErr } = await sb.from('linked_accounts').insert({
      connection_id: connId, account_id: acct(c.key),
      external_account_id: `demo-${c.key}`, external_account_mask: '4471',
      external_account_name: ACCOUNTS.find(a => a.key === c.key)?.name,
    });
    if (linkErr) fail(`linked_accounts (${c.name}): ${linkErr.message}`);
    for (let d = 6; d >= 0; d -= 1) {
      const when = new Date(`${TODAY}T06:30:00Z`);
      when.setDate(when.getDate() - d);
      const { error: shErr } = await sb.from('sync_history').insert({
        connection_id: connId, sync_type: 'transactions', status: 'success',
        records_synced: d === 0 ? 6 : Math.floor(rand() * 4),
        created_at: when.toISOString(),
      });
      if (shErr) fail(`sync_history (${c.name}): ${shErr.message}`);
    }
  }
  console.log('bank feeds: 3 connections, linked, 7 days of sync history each');
}

console.log('\nDONE — sign in and photograph.');
