# The forecast's relationship to Budget — decided

**Owner's ruling, 17 August 2026**, answering the question Claude Design's
recurring-and-forecast handover (§7.2) required settled in writing before any
forecast layout. Their three coherent options were: the forecast produces the
budget; different horizons; or a scenario that never writes to Budget.

The decision, in the owner's own words:

> "I see the forecast more as a 'scenario tool' for the user to 'play with' —
> but by play I don't mean a basic or mediocre offering, I want it to be
> really robust. A stage 2 that you should keep in mind is that the user
> *can*, if they want, turn a scenario into a 'forecast' and have a toggle to
> say they want to apply the forecast figures as their 'budgets' for the next
> 12-month period — or even to select which categories they would like to
> apply as a budget, in case the user does not want to budget every category;
> they may just want to target a few."

## What this means, operationally

1. **The forecast is a scenario tool first.** It never writes to Budget on
   its own, and the page says so — Design's option 3, with its honesty rule.
2. **Stage 2 is a deliberate, user-driven bridge to Budget**: a scenario can
   be *promoted* to a forecast, and its figures applied as the next twelve
   months' budgets — wholesale via a toggle, or **category by category**,
   because a user may want to target a few categories rather than budget all
   of them. Applying is an explicit act with an explicit scope; nothing
   inherits silently.
3. **Robustness is part of the ruling**, not an aspiration: the inspectable
   base-period table (§7.1 — twelve months of category actuals, one-offs
   excludable with the exclusions stated) is the foundation, and it ships
   before any projection exists, as Design's build order already argues.

This composes the strengths of Design's options 1 and 3: the interrogability
of stated adjustments over a visible base, with Budget only ever changed by a
user's explicit, scoped instruction.

## The budget side, 5 November 2026

Budgets now carry their own start and cycle (`docs/budget-direction.md`), which
raised the question from the other direction: should a budget drive the forecast?
The owner's answer keeps the ruling above and sharpens the horizon:

- **The forecast is a project of its own, planned before it is built.** A budget
  is twelve months; a forecast runs for years and needs rules of growth a budget
  has no place for — "salary £X for the next twelve months, then 5% more each
  year for five years", and the same for a given expense.
- **The join is one explicit button**, *"Use my budgets as the basis for the
  forecast"*: the budgets become year one, the forecast owns every year after.
  Stage 2 above (forecast → budgets) and this (budgets → forecast) are the two
  directions of the same bridge, both user‑driven, neither silent.
- **Income belongs here, not to Budget.** "Budgets concentrate on people
  spending. The forecast is their Personal P&L." So the forecast's base table
  carries income and growth; the budget wizard stays expense‑only.

## Build order (unchanged from the handover's §8)

1. ✅ Detection, read-only ("What I'm committed to", shipped 17 Aug).
2. Confirm / Not-recurring verdicts (this change) — only confirmed patterns
   may ever feed the calendar or a forecast.
3. Confirmed items feed the forward calendar.
4. The base-period review table — useful alone as a 12-month category P&L.
5. The scenario tool, then its stage-2 promotion into budgets.
