# Budgets: what went wrong on 29 October, and the direction — DRAFT for the owner, 5 Nov 2026

Status: analysis and proposal. Nothing here is built. The required change (§5.1–5.3)
is the owner's instruction of 5 Nov; the rest is what the code and the research say
should go with it. Figures from the owner's own ledger are deliberately absent.

---

## 1. What happened, mechanically

The owner set every expense category's budget through the wizard on 29 Oct:
**annually**, measured against **the last 12 full months**, typed his own figures,
reviewed, saved. The Budget page then showed most categories already far into — or
over — their budgets.

The cause is one line in `utils/budgetPeriods.ts`:

```
case 'yearly':  start = 1 Jan of THIS year,  end = 31 Dec of THIS year
```

A yearly budget is measured over the **current calendar year**, whatever day it was
created. A budget written on 29 Oct is therefore compared with ten months of spending
that happened before it existed. The wizard's guide window (Nov 2025 – Oct 2026) and the
page's measuring window (Jan – Dec 2026) are two different stretches of time that overlap
by ten months, which is why the page's "Total Spent" was a different number from the
wizard's "Spent" line — and why the figures looked like the wizard had "applied the
budget to the last 12 months". It did not; the page did, in its own way, and the
wizard never said what window the budget would run over because the wizard does not
know. Nothing asks.

The stored rows are consistent with this: all 48 budgets are `period = 'yearly'`,
`start_date = 2026‑10‑29` (the service's default: the day of creation), `end_date NULL`.
The date is stored and **ignored** for every period except fortnightly and custom.

Monthly budgets have the same shape of problem at a smaller scale: a monthly budget
written on the 25th is measured against the whole calendar month. For a month that is
rarely noticed; for a year it is the whole experience.

## 2. The model today

| Period | Window measured | Anchor used | Offered where |
| --- | --- | --- | --- |
| weekly | the current Sunday‑start week | none | single editor |
| biweekly | the fortnight containing now, from `start_date` | `start_date` (or `created_at`) | legacy rows only |
| monthly | the current calendar month | none | wizard, single editor |
| quarterly | the current calendar quarter | none | single editor |
| **yearly** | **the current calendar year (1 Jan – 31 Dec)** | **none** | wizard, single editor |
| custom | `start_date` → `end_date` (or now) | both | nothing creates one |

One derivation (`getBudgetPeriodWindow`) feeds one evaluation (`evaluateBudgets`), and
every surface reads it — Budget page, Dashboard's Budget Status card, spending alerts,
shared budgets. That is good: a change to the window is one change, and every surface
follows.

What the wizard knows and does not know:

- **Knows**: the rhythm (months or years), the guide window (12 full months, last
  calendar year, last tax year), what each category cost, what is typed, what the
  save will do to each row.
- **Does not know, and never asks**: *from when* the budgets run. It writes `period`
  and `amount` only. The service fills `start_date` with today.

The Plan page already has the opposite half: a windowed P&L (last 12, calendar year,
tax year, **custom month range**) with its boundaries pinned in `utils/plWindow`. The
wizard's guide windows are built on the same module. The custom range is the one kind
the wizard does not expose.

## 3. Findings beyond the bug, ranked

1. **A budget has no stated run period.** The card says "Yearly budget" and nothing
   else. A reader cannot tell which year, from when, or how far through it they are.
   The owner's 15 Oct remark about the Dashboard ("I cannot easily see what period
   that is for") was fixed by captioning the period name; the period's *dates* are
   still unsaid.
2. **"Save" never says what period the budgets will be measured over.** Step 3
   ("Before you save") states the totals and the shortfall against history, which is
   the right comparison, but not "these will run 1 Nov 2026 – 31 Oct 2027". The
   first thing the owner saw after saving was a surprise the wizard could have named.
3. **No pacing.** An annual budget read on day 5 of its year and on day 360 shows the
   same bar. The honest reading of "£x of £y, 3 of 12 months gone" is the one figure
   a yearly budgeter actually wants, and every product in §4 that supports annual
   budgets shows it.
4. **The page totals mix rhythms.** "Total Budgeted / Spent / Remaining" sum every
   active budget regardless of period, so a page with monthly and yearly budgets adds a
   month's allowance to a year's. Today the owner's are all yearly so it reads
   correctly by accident.
5. **Rollover assumes monthly.** `BudgetRollover` computes "the previous period" as the
   previous calendar month for every budget, so applied to a yearly budget it carries a
   month's "headroom" out of a year's allowance. It should either scope itself to
   monthly budgets by name or derive the previous window from the same module the
   page uses. It is a collapsed fold nobody has opened against yearly budgets yet.
6. **The single editor (BudgetModal) offers yearly and quarterly with no start.** Same
   gap as the wizard, one row at a time.
7. **A budget cannot start in the future.** There is no notion of "written now, runs
   from April". The fortnight code already handles "before the anchor, the first
   fortnight" — the pattern exists, just not for years.
8. **Guide window: no custom range.** The owner's own example — "use the past 12 months
   as a guide but start from 1 July" — is two independent choices, and the second one
   does not exist. A guide of "the 2025 calendar year" or "Apr–Sep" is also reasonable
   and only the Plan page can show it.

Things that are right and should not move: empty‑is‑not‑zero; write only where the
money changed; the rhythm converts; the refusal to re‑express weekly/quarterly; the
twelve‑complete‑months default for the guide; one evaluation for every surface.

## 4. How others handle it (research, 5 Nov)

- **Quicken Classic** — each budget has a "Start budget on" month chosen at creation
  (defaulting from a global fiscal‑year preference). It **cannot be changed after
  creation**; users have to recreate the budget, and the community threads asking for
  that to be fixed run for years. The lesson is the positive and the negative at once:
  a per‑budget start month is the right unit, and being unable to move it is the
  complaint. [Create a fiscal year budget](https://info.quicken.com/win/create-a-fiscal-year-budget) ·
  [community: custom start date](https://community.quicken.com/discussion/7864415/custom-start-date-for-budget) ·
  [community: change the start month](https://community.quicken.com/discussion/comment/20193103) ·
  [community: May 1 to Apr 30](https://community.quicken.com/discussion/7967036/budgeting-by-fiscal-year-instead-of-calendar-year)
- **PocketSmith** — every budget carries its own start date (default: the first day of
  its period; a budget made from the calendar starts on that day), optional end date,
  and the start can be moved later. A user preference sets the day a week/month starts
  and the month a year starts. Budgets **feed the forecast calendar** — the same
  object drives "how am I doing" and "what will my balance be". That is the owner's
  stated destination. [Creating a new budget](https://learn.pocketsmith.com/article/206-creating-a-new-budget) ·
  [Custom start dates](https://pocketsmith.com/news/2024-11-18-custom-start-dates-for-month-and-year-date-ranges) ·
  [Customising standard date periods](https://learn.pocketsmith.com/article/1449-customising-your-standard-date-periods) ·
  [Budgets and planning](https://www.pocketsmith.com/features/budgets-and-planning)
- **YNAB** — monthly envelopes, with *targets* that have a frequency (weekly, monthly,
  yearly, custom) and a "by" date that fixes when the first cycle ends; the cycle then
  repeats. Yearly spending is modelled as funding toward a date, and their own advice
  is to align the cycle with when the spending actually happens. [Getting started with
  targets](https://support.ynab.com/en_us/getting-started-with-targets-ryAEP08xC) ·
  [How to use targets](https://secure.youneedabudget.com/blog/ynab-targets)
- **Monarch** — monthly is the core; non‑monthly costs are a separate bucket; users
  report that a true annual‑first budget that rolls actuals up is unsupported, and
  have built browser extensions to get a yearly toggle. A warning about what happens
  when "yearly" is a view rather than a period. [Understanding your budget](https://help.monarch.com/hc/en-us/articles/360048883631-Understanding-Your-Budget-in-Monarch) ·
  [Monarch vs YNAB comparison](https://waypointbudget.com/blog/ynab-vs-monarch-money)
- **Microsoft Money** (the product direction) — the Advanced Budget distinguished
  regular from irregular/one‑off expenses, and Money 2005 added "Spending Average",
  a per‑category monthly average shown beside the box as the budget was set — exactly
  the wizard's "What it cost / use my actual". The budget period itself was set up
  with the budget. [Money 2005 press release](https://news.microsoft.com/source/2004/09/21/microsoft-unveils-simplified-approach-to-financial-management-and-helps-people-make-sense-of-their-money/) ·
  [Budget Planner KB 812753](https://ftp.zx.net.nz/pub/archive/ftp.microsoft.com/MISC/KB/en-us/812/753.HTM)

The consensus: **the start is a property of the budget, chosen when it is set, shown
wherever it is read, and changeable later.** Nobody measures a yearly budget against
the calendar year it was created in.

## 5. Proposal

### 5.1 The model: a budget is an allowance for a CYCLE, anchored on its start date

`start_date` (already stored, already NOT NULL, already carried by the local edition's
row) becomes meaningful for every period. The window for "now" is **the cycle that
contains now, counted from the anchor**:

| Period | Cycle k | Example, anchor 1 Nov 2026 |
| --- | --- | --- |
| yearly | anchor + k years → the day before anchor + (k+1) years | 1 Nov 2026 – 31 Oct 2027 |
| quarterly | anchor + 3k months → day before anchor + 3(k+1) months | 1 Nov 2026 – 31 Jan 2027 |
| monthly | anchor + k months → day before anchor + (k+1) months | 1 Nov – 30 Nov 2026 |
| biweekly | unchanged — already works this way | |
| weekly | unchanged (Sunday‑start) | |
| custom | unchanged: start → end | |

- A tax‑year budgeter anchors on 6 April and gets 6 Apr – 5 Apr without a special
  case; the month arithmetic already clamps 31 → 30 the way the fortnight code and
  `plWindow` do.
- **Before the anchor**: the first cycle, and the card says "starts 6 Apr 2027" with
  no bar — a budget written in November for April is not "0% used", it has not begun.
- **`end_date`** set means the budget stops: after it, the last cycle is shown as
  finished, not re‑measured against nothing.
- Monthly budgets anchored on the 1st behave exactly as today, so an existing monthly
  budget whose `start_date` is mid‑month needs the **data fix in 5.5**, not a special
  case in code.

This is one function in one module with one test file, and every surface follows.

### 5.2 The wizard asks the question it was missing: "Run these budgets from"

Not a fourth step. It belongs in **step 3, "Before you save"**, above the totals — the
screen whose whole purpose is to say what will happen:

> **Run these budgets from**
> ○ This month — 1 Nov 2026, so the year ends 31 Oct 2027 *(default)*
> ○ Next month — 1 Dec 2026
> ○ The next calendar year — 1 Jan 2027
> ○ The next tax year — 6 Apr 2027
> ○ Another date — [date]
>
> Each budget runs for a year from that day, then starts again. Nothing you spent
> before it counts against it.

- For **monthly** rhythm the same choice appears, worded "Each budget runs month by
  month from that day". A start in the future is allowed in both.
- The chosen start is written as `start_date` on every row the save touches. A row
  the save does **not** touch (money unchanged) is written **only if its start would
  change** — a new reason for a write, beside "the money changed", and step 3 counts
  them: "12 budgets re‑dated". The never‑clobber rule for unchanged money stays.
- Existing budgets' current start is shown in the grid as a quiet caption under the
  box ("from 1 Nov 2026") so the save's "re‑dated" count is checkable.

### 5.3 The guide window gets "Custom"

"Measured over" gains **Custom: from [month] to [month]**, using the same month
inputs and the same `buildPlWindow` the Plan page already uses, so the two screens
cannot disagree about a range.

- A custom range is whole months, 1 to 36. The history column shows "a month" as
  total ÷ months, and "a year" as that × 12, captioned **"scaled to a year"** when the
  range is not twelve months — the one place the wizard's "both windows are exactly
  twelve months" assumption has to be relaxed, and it is relaxed by saying so.
- The named range ("Jan – Dec 2025", "Apr – Sep 2026") stays the heading, as now.

### 5.4 The Budget page says the dates and the pace

- Card caption: **"Yearly · 1 Nov 2026 – 31 Oct 2027"** (period and window), replacing
  "Yearly budget". Dashboard's card already reads the same window object.
- A second line under the bar for any cycle longer than a month: **"3 of 12 months
  gone · on pace / £x ahead of pace / £x behind"**, with pace = allowance × elapsed
  fraction. Colour by the house rule: red only when behind pace, not for a count.
- "Total Budgeted / Spent / Remaining" sum **per rhythm**, with a line each
  ("Yearly budgets: …", "Monthly budgets: …") and no grand total across them.
- A future‑start card: "Starts 6 Apr 2027", no bar, no percentage.

### 5.5 The 48 existing rows

Their `start_date` is 29 Oct 2026, the day of creation. Under 5.1 that would run them
29 Oct 2026 – 28 Oct 2027, which is nobody's intention. Two ways to fix, the owner's
choice:

- **(a) Re‑run the wizard** once 5.2 ships, choose "This month", save. Every row is
  re‑dated to 1 Nov 2026 by the new "re‑dated" write, the money untouched. One press,
  no SQL.
- **(b) One SQL statement** on his rows, scoped by his user, before 5.1 ships.

(a) is the one the product should be able to do for anyone, so it is the one to build
and use.

### 5.6 The single editor

`BudgetModal` gains "Starts" (a date, default the 1st of this month) for every period
but weekly, and shows the resulting first cycle beside it. Custom stays absent until the
editor also collects an end date.

### 5.7 Rollover

Scope `BudgetRollover` to monthly budgets **by name**, now, with one line saying why
("a yearly budget's previous period is its previous year; carry for that is a later
build"). Deriving the previous window properly from `budgetPeriods` is a follow‑up once
5.1 exists to derive it from.

### 5.8 What this does NOT touch

- **No schema change.** `start_date` and `end_date` exist in both engines
  (`budgets` in Postgres; `crates/wealth-core/src/row/budget.rs` in the local edition).
  The evaluation is TypeScript shared by both editions, so the desktop follows.
- **The forecast bridge** (docs/forecast-direction.md, stage 2: a scenario promoted to
  a forecast and applied as the next twelve months' budgets, wholesale or category by
  category). This proposal is its prerequisite, not its implementation: a forecast
  applied as budgets will write exactly a start date and twelve amounts, which is the
  shape 5.1 gives the row. Building the cycle model now means the bridge later writes
  rows the page already knows how to read.
- Weekly budgets, shared budgets, alerts: they read the same evaluation and change
  only in that a yearly alert now means the right year.

## 6. Build order — five PRs, each shippable alone

1. **The cycle model** (`budgetPeriods.ts` + tests). Yearly/quarterly/monthly windows
   anchored on `start_date`; future start = first cycle; `end_date` honoured.
   Existing yearly rows are affected on the day this ships, so it ships **with** 2
   or after 5.5(b). Smallest, most consequential.
2. **Wizard: "Run these budgets from"** in step 3, the re‑dated write, the start
   caption in the grid (`budgetWizardPlan.ts`, `BudgetWizard.tsx`, tests). Ships with 1.
3. **Budget page: dates, pace, per‑rhythm totals** (`Budget.tsx`, the Dashboard card
   caption if it needs the date).
4. **Guide window: Custom** (`categorySpendSummary.ts`, `budgetWizardPlan.ts`,
   `BudgetWizard.tsx`).
5. **Single editor "Starts" + rollover scoped to monthly** (`BudgetModal.tsx`,
   `BudgetRollover.tsx`).

Then the forecast bridge, on its own track.

## 7. The owner's decisions (5 Nov 2026)

1. **Default start: the 1st of the current month.** Agreed.
2. **The 48 rows: re‑run the wizard once it asks, and test it.** No SQL.
3. **Monthly budgets: calendar months by default, anchored on the chosen day when
   someone chooses one** — "if someone gets paid on the 15th they may want to run
   their budget from the 15th". So the rule is one rule (anchored) with the 1st as the
   default, which is the proposal's recommendation.
4. **Pace line: this batch.**

And a standard: "flexible and the best out there", with PocketSmith named as the
closest competitor for the household‑CFO reader. §4 carries what it does that we do
not; the suggestions drawn from it are in the owner's conversation of 5 Nov and will
move here as they are accepted.

## 8. What shipped, and how the rule for legacy rows works

**PR A1 (read side)** — `utils/budgetPeriods` anchors monthly, quarterly and yearly
windows on `start_date`; `utils/budgetPace` captions and paces; the Budget page shows
dates, pace, future starts and per‑rhythm totals; the Dashboard card and the
connector's `reckley_budget_status` follow.

**Legacy rows.** No screen ever collected a start date, so the service filled it
with the creation day. A row created before `ANCHOR_SINCE` (6 Nov 2026) whose start
is its own creation day is read as having NO anchor and keeps the calendar month,
quarter or year it always had — nothing moves on deploy day. It gains an anchor only
by being re‑dated (the wizard's "Run these budgets from", or the editor's "Starts"),
because a re‑dated start is no longer the creation day. A row created on or after
that day always carries a chosen start. Measured on production before shipping:
every stored row was either start = creation day or start = 1 January (the showcase
seeder), and both read exactly as before. No migration, in any of the three engines.
The one theoretical collision — a legacy row re‑dated to exactly its own creation
day — cannot occur for any row that exists.

**PR A2 (write side)** — the wizard's step 3 asks **"Run these budgets from"**: this
month (the 1st, default), next month, the next calendar year, the next tax year, or
another date. The day goes on every row the save writes. Budgets the save is not
otherwise touching are **offered** a move — "Also move the N budgets I'm not changing
to this start; they run from the calendar year today" — never moved silently, and the
offer taken with nothing typed is itself a save: that is how the 29 Oct budgets get
re‑dated without retyping a figure. `BudgetModal` gains **Starts** (default the 1st of
this month; a legacy row shows the calendar day it is measured from today; weekly has
no field) and previews the first period. `BudgetRollover` is scoped to monthly budgets
by name and says how many of another rhythm it leaves alone.
