import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useNegativeTone } from '../contexts/NegativesInRedContext';

/**
 * The ONE column definition the Accounts list's rows share.
 *
 * ─ WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The list draws two kinds of row: a top-level account card, and — for an
 * investment↔cash pair (the Microsoft Money model) — a nested cash row inside
 * it. They showed the same figures under the same headings, and each laid them
 * out its own way: the card on a nine-column grid, the cash row on a flex line
 * with three hand-matched widths. So the two lines of figures did not line up,
 * and every later change to one of them had to be remembered into the other.
 *
 * Matching the numbers up again would have fixed today's misalignment and left
 * tomorrow's in place. What stops them drifting is that neither row owns a
 * column definition any more: both render <AccountRowColumns>, which is the
 * only place the template lives, and both fill it with the cells below in the
 * same order. A figure can only move for one row by moving for the other.
 *
 * ─ THE COLUMNS, LEFT TO RIGHT ──────────────────────────────────────────────
 *   1 Bank Bal      what the bank last said (empty for a row with no feed)
 *   2 Account Bal   what the ledger says
 *   3 Unreconciled  how many rows have not been agreed with the bank
 *   4 To Review     how many freshly-imported rows nobody has dealt with
 *   5–9             five action slots, always all five, so the buttons in
 *                   them land at the same x on every card whether or not a
 *                   given account has that action (portfolio, bank feed,
 *                   settings, reconcile, close).
 *
 * A row that has nothing for a column renders <AccountRowEmptyCell /> rather
 * than dropping the column: an omitted cell pulls everything to its right one
 * place along, which is precisely the alignment this file exists to keep.
 *
 * ─ PHONES, AND WHY THE GRID STARTS AT `lg` AND NOT AT `sm` ─────────────────
 * Below the breakpoint the grid gives way to a wrapping row: the figures take
 * one line and the buttons the next. The balance is shown beside the account
 * NAME at that width instead (where a banking app puts it), which is why
 * AccountBalanceCell can be asked to keep itself off small screens rather than
 * saying it twice.
 *
 * That breakpoint was `sm` (640px) until 2026-08-14, and it was too low by a
 * whole class of device. The grid's tracks are FIXED — 104 + 120 + 88 + 88 +
 * five 48s, plus gaps — so it cannot be squeezed; it can only overflow. Turn a
 * phone on its side and the viewport is 844px, comfortably past `sm`, so a
 * landscape phone was handed the desktop table: measured at 844x390, the rows
 * wanted 915px and the page scrolled sideways by 95. The owner's report was
 * the plain version of that: "in landscape it should all fit in a page width
 * and I should not have to scroll right to look at anything."
 *
 * `lg` (1024px) is the first width where the whole template genuinely fits, so
 * it is where it now begins. Everything that dresses the grid moves with it —
 * the per-row labels that hide when the column strip takes over, the strip
 * itself, the balance cell's small-screen twin, and the empty spacer cells —
 * because a grid at one breakpoint and its captions at another is how a row
 * ends up with both, or neither.
 */

/**
 * The template itself. Fixed widths, not fractions: a column that sized itself
 * to its content would be a different width on every card, and lining the cards
 * up with each other is the whole point.
 */
export const ACCOUNT_ROW_COLUMNS_CLASS =
  'flex flex-wrap items-center justify-end gap-x-4 gap-y-1 lg:grid ' +
  'lg:grid-cols-[6.5rem_7.5rem_5.5rem_5.5rem_repeat(5,3rem)] ' +
  'lg:justify-items-end lg:items-center lg:gap-x-2 lg:gap-y-0';

/**
 * The look of a row the user has picked out, echoing the register's own active
 * row (.selected-transaction-row in index.css): the same blue wash, the same
 * #6B86B3 ring, the same two-layer elevation that lifts the row off the page.
 *
 * Echoed in utilities rather than by wearing that class, because three of its
 * declarations belong to a table row and not to a card: a forced `margin: 4px 0`
 * would fight the list's own spacing (and make a card twitch as it is selected),
 * `border-radius: 12px` would square off the card's 16px corners, and
 * `font-weight: 600` would embolden every word on the card rather than mark it.
 * What is left — colour, ring, lift — is the part that means "this one", and it
 * is what is copied here.
 *
 * ─ WHY `border-transparent` IS IN A LIST OF SELECTION COLOURS ───────────────
 * Because a row wears a 1px `border` at every moment of its life — the width is
 * geometry, held constant so a card cannot jump 1px as it is picked out — and a
 * border with no colour of its own does not stay invisible. Tailwind's preflight
 * gives every element `border-color: #e5e7eb`, so a selected row that named no
 * colour drew that near-white hairline on three sides while the fourth kept the
 * list's divider (#e2e6ed light, gray-700 dark) — a second and third tone packed
 * against the ring, which is the "two colours in the border" the owner saw. It
 * is worst in dark mode, where #e5e7eb is a light-mode grey sitting on a dark
 * card. Naming the colour transparent here leaves the ring as the only stroke
 * the row draws, uniform on all four sides.
 *
 * This is a state's OWN colour rather than a fight with the base class: the row
 * that is NOT selected names `border-transparent border-b-line …` for itself
 * (see Accounts.tsx). Neither state has to outrank the other in a cascade whose
 * order between `border-*`, `border-b-*`, `last:` and `dark:` is Tailwind's to
 * decide and not ours to depend on.
 */
export const ACCOUNT_ROW_SELECTED_CLASS =
  // The wash is the SELECTED state's own token, not a stock blue (stock-blue
  // ruling, 28 Aug 2026): `bg-primary/10` is the brand navy at a tenth, the
  // same tint AddAccountModal's selected tile wears. `--color-primary` does
  // not invert on dark — a tenth of a near-black navy on a gray-800 card is no
  // wash at all — so dark keeps the house counterpart, a lifted grey surface.
  'relative z-10 bg-primary/10 dark:bg-gray-700/50 border-transparent ' +
  // ─ ONE STROKE WHEN THE KEYBOARD IS DRIVING ─────────────────────────────────
  // `focus-visible:ring-0` because otherwise an arrowed-to row wears TWO
  // concentric strokes: this SELECTION ring, and — 2px further out — the
  // app-wide `*:focus-visible { outline: 2px solid var(--focus-ring-color) }`
  // in accessibility-colors.css, which carries `!important` and so cannot be
  // turned off by the row's own `focus:outline-none`. Light mode resolves that
  // variable to the brand navy, which is why it read as "a blue and a black
  // double border". Clicking never showed it, because a click does not match
  // :focus-visible — so the same row looked clean by mouse and doubled by
  // keyboard.
  //
  // The FOCUS outline is the one kept, deliberately: it is the app's single
  // focus indicator, it is what every other control uses, and it is the stroke
  // with a contrast obligation (WCAG 2.4.11). The selection ring stands down
  // while the row holds focus and comes back the moment focus leaves — and the
  // blue wash and the lift never go anywhere, so a selected row still reads as
  // selected either way.
  //
  // THIS ONE SURVIVED THE APP-WIDE SWEEP, and it is the only `ring-0` left.
  // Every component-level `focus-visible:ring-*` came out in
  // RULINGS_ON_CAUSE_2026-08-13 §3, on the grounds that a component declaring
  // its own ring paints a second one over the global outline. The ruling
  // expected this workaround to come out with them as having "nothing left to
  // fight" — but what it suppresses is not a focus ring. It is the `ring-1`
  // selection indicator on the SAME element, three classes to its left, which
  // is §6 law and stays. Delete this and a selected, arrowed-to row wears both
  // strokes again, which is the exact bug that was reported.
  //
  // (The wash this paragraph calls "blue" is the navy tint above since the
  // 28 Aug 2026 stock-blue ruling; the argument about the two strokes is
  // unchanged — a selected row still reads as selected by wash and lift.)
  'ring-1 ring-[#6B86B3]/50 dark:ring-[#6B86B3]/70 focus-visible:ring-0 ' +
  'shadow-[0_4px_6px_-1px_rgba(0,0,0,0.1),0_10px_15px_-3px_rgba(0,0,0,0.1)] ' +
  'dark:shadow-[0_4px_6px_-1px_rgba(0,0,0,0.3),0_10px_15px_-3px_rgba(0,0,0,0.3)]';

/**
 * The account NAME as a link — one definition, worn by both kinds of row.
 *
 * ─ WHY IT HUGS ITS OWN TEXT ────────────────────────────────────────────────
 * The name opens the register and the rest of the row picks the row out. That
 * division only holds if the link's HIT AREA ends where the letters end. As a
 * plain `block` (what shipped) the anchor filled its whole flex track, so a
 * click in what looks like empty row a hand's width right of a short name still
 * landed on the link and opened the account — the hover underline and the
 * "Open …" tooltip appearing under a cursor nowhere near the text. `w-fit`
 * (width: fit-content) is the cure: the box is as wide as the name and no
 * wider, at whatever length that name happens to be. Everything past the last
 * character is row background, and row background selects.
 *
 * ─ THE OTHER THREE ARE NOT DECORATION ──────────────────────────────────────
 * `block`      an inline <a> cannot be clipped at all (overflow does not apply
 *              to a non-replaced inline box), so a long name could not ellipse.
 * `max-w-full` fit-content of a nowrap line is the FULL text width however long
 *              it runs, so without a cap a long name would sail out over the
 *              figures to its right instead of truncating.
 * `truncate`   the ellipsis itself — which only has an edge to break against
 *              because of the cap above.
 * Drop any one of the four and either the hit area or the truncation goes.
 *
 * ─ WHAT IS DELIBERATELY NOT IN HERE ────────────────────────────────────────
 * The type/wallet icon beside the name stays OUTSIDE the link. Clicking an
 * item's icon to open it is a fair convention, but the rule this page can then
 * state in one line — "the letters open it, anything else on the row picks it
 * out" — is worth more than the extra few pixels, and a decorative type glyph
 * is not the account's name.
 *
 * Resting colour is the caller's (a nested cash row is drawn quieter than the
 * card it sits in); the geometry and the hover are shared, so the hit area
 * cannot come out right for one kind of row and wrong for the other. The link
 * declares NO focus ring: it used to carry `focus:outline-none
 * focus-visible:ring-2 focus-visible:ring-blue-500`, which painted a blue ring
 * INSIDE the app-wide focus outline — the same doubling the selected row above
 * had to work around. The global outline is the app's one focus ring
 * (RULINGS_ON_CAUSE_2026-08-13 §3), and `rounded` is kept because the outline
 * follows the border radius.
 *
 * On touch, index.css floors every anchor at 44×44 — a hit area small enough to
 * miss is its own failure, and 44px beside a four-letter name is still nothing
 * like the full width of the row.
 */
export const ACCOUNT_ROW_NAME_LINK_CLASS =
  // ─ `min-h-0 touch-target-small`: THE NAME SAT HIGHER THAN ITS OWN BALANCE ──
  // The same trap as the count pill, two rows down. `index.css` floors every
  // `a` at 44px tall on a touch device, so this link's box was 44 while the
  // balance beside it was 24 — and the row centres both, which put the two
  // texts 10px apart. Measured at 390px before the fix: link 708→752, balance
  // 718→742. The owner: "the account name sits higher than the amount on the
  // right hand side."
  //
  // `min-h-0` gives the box back its own height so the two line up; the thumb
  // keeps its 44px through `touch-target-small`, the app's own opt-in, which
  // spends no layout to do it. `font-semibold` because he asked for both to be
  // bold — the name and the figure are one statement, and the name was the
  // quieter half at 500 against the balance's 600.
  //
  // ─ THE HOVER IS AN UNDERLINE AND NOTHING ELSE ──────────────────────────────
  // It used to add `hover:text-blue-600 dark:hover:text-blue-400`, the stock
  // blue this app retired on 28 Aug 2026. The ruling's answer for in-app
  // navigation is the PAIR `text-primary hover:text-secondary` — but this link
  // deliberately declines a resting colour (see above: a nested cash row is
  // drawn quieter than the card it sits in, and `.text-primary` carries
  // `!important`, so naming it here would overrule both callers' ink). The
  // hover half alone cannot be taken either: `.dark .text-secondary`'s lift is
  // on the resting class, so `hover:text-secondary` would darken a near-white
  // name to navy on a gray-800 card on hover.
  //
  // So the underline is the whole hover, which is what it was carrying anyway —
  // an underline IS the link (see design-system/linkBlue.ts), and a colour
  // change on top of one is decoration.
  'block w-fit max-w-full truncate rounded transition-colors font-semibold ' +
  'min-h-0 touch-target-small ' +
  'hover:underline';

/** The column heading over a figure — small, quiet, and the same for every row. */
const CELL_LABEL_CLASS = 'text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500';

/**
 * The same label ON A ROW: drawn on a phone, spoken everywhere.
 *
 * From `sm` up the band's header strip says these four words once, so repeating
 * them on every row is ink for something already answered — but `sr-only`
 * rather than `hidden`, because a screen reader reads a row as a row and would
 * otherwise hear four bare figures. The strip is `aria-hidden` for the mirror
 * image of the same reason.
 */
const ROW_LABEL_CLASS = `${CELL_LABEL_CLASS} lg:sr-only`;

/** The figures themselves: tabular so the digits line up down the column. */
const CELL_FIGURE_CLASS = 'text-sm font-semibold tabular-nums';

/**
 * THE LINE A FIGURE SITS ON, held at one height for every cell in the row.
 *
 * ─ WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Reported from a phone: "the highlighted number looks oval and not round, and
 * you can see the 'Unreconciled' word above has risen and sits higher than
 * 'Bank Bal' and 'To Review'."
 *
 * Both halves were one cause. A count with work in it became a LINK when the
 * counts turned into doors, and `index.css` gives every `a` on a touch device
 * `min-width: 44px; min-height: 44px` — a floor meant for thumbs, applied to a
 * 20px figure. Measured at 390px: the pill came out 31 wide by 44 tall (the
 * oval), which made its cell 24px taller than its neighbours, which lifted its
 * label 12px above theirs. Nothing was wrong with the pill's own styling; it
 * was being inflated from outside, by a rule that never matches a desktop
 * browser — the same media block that once put the floating + button at the
 * left edge of the screen.
 *
 * The fix is the owner's own second option — "increase the default height of
 * everything else on the same row" — because it is the one that cannot come
 * undone. Levelling the pill alone would hold only until the next cell learns
 * a state with a different height. A shared line height means a figure may be
 * text, money, or a filled disc and the labels above them still agree.
 *
 * 24px because that is the disc's diameter; plain text at `text-sm` is 20 and
 * centres inside it without moving.
 */
const CELL_FIGURE_LINE_CLASS = 'flex items-center justify-end min-h-[24px]';

/**
 * The columns of one row.
 *
 * Its children ARE the nine slots, in order — there is no way to render this
 * grid without going through here, which is what keeps the two row types in
 * step.
 */
export function AccountRowColumns({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div data-account-columns className={ACCOUNT_ROW_COLUMNS_CLASS}>
      {children}
    </div>
  );
}

/**
 * The BOX a row's grid sits in — the padding and border of the account card,
 * with none of its colour. The header strip wears it so its labels land at the
 * same x as the figures below them, and keeps landing there if the card's
 * padding is ever changed.
 *
 * Kept beside the column template deliberately: these two together are what
 * "a column of this list" means, and splitting them across files is how the
 * strip and the rows would come to disagree.
 */
export const ACCOUNT_ROW_COLUMN_HEADER_BOX_CLASS = 'p-3 sm:p-4 border border-transparent';

/** What the four figure columns are called, in the template's own order. */
const COLUMN_LABELS = ['Bank Bal', 'Account Bal', 'Unreconciled', 'To Review'] as const;

/**
 * The four column names, said ONCE for a band instead of once per row.
 *
 * ─ WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Every row carried its own labels — twenty-odd repetitions of the same four
 * words down a list, which is the cost of a card that has to explain itself in
 * isolation. The reconciliation list was given one strip per group in the
 * August design pass; this page never was, and the omission surfaced when a
 * design objection was drafted on the assumption that a header strip existed
 * here to be made sticky. It did not. This is that strip.
 *
 * ─ IT WEARS THE ROW'S OWN TEMPLATE ─────────────────────────────────────────
 * `ACCOUNT_ROW_COLUMNS_CLASS`, unchanged — the same fixed widths and the same
 * nine slots, four named and five empty. A strip that declared its own columns
 * would be a second definition of the grid and would drift from the rows on the
 * first edit, which is the exact failure this module was created to stop.
 *
 * ─ FROM `sm` ONLY, BECAUSE THAT IS WHERE THE GRID IS ───────────────────────
 * Below `sm` the template gives way to a wrapping row and a card is read on its
 * own rather than as part of a table, so the per-cell labels stay there and this
 * does not render. The labels and the strip are the same information at two
 * widths; neither surface ever shows both.
 */
export function AccountColumnHeader(): React.JSX.Element {
  return (
    <div
      data-account-column-header
      // `aria-hidden`: each cell keeps its own visually-hidden label, so a
      // screen reader already hears "Bank Bal £6,378.06" per row and does not
      // need the strip read to it as four loose words.
      aria-hidden="true"
      /*
       * `justify-end` and the row card's own right inset, because the grid is
       * CONTENT-SIZED inside each row and pushed to the right by the account
       * name beside it. Measured before this was written: as a plain block grid
       * the strip filled the container and packed its fixed columns at the LEFT,
       * putting "Bank Bal" 471px away from the figures it names. The row's card
       * carries `p-4` and a 1px border inside the band's own `px-4 sm:px-6`, so
       * the strip repeats both to land on the same right edge.
       */
      className="hidden lg:flex justify-end pb-1"
    >
      {/* AN INVISIBLE ROW CARD around the labels, rather than a hand-tuned
          right margin. A row's grid is inset from the band by the card's own
          `p-3 sm:p-4` and its 1px border — 17px at this width — and a strip
          that hard-coded 17 would drift the moment that padding changed, which
          is exactly how the page shell's `calc(100vh-13rem)` came to be 40px
          wrong. Wearing the same box means the labels move when the rows move. */}
      <div className={`${ACCOUNT_ROW_COLUMN_HEADER_BOX_CLASS}`}>
      <div className={ACCOUNT_ROW_COLUMNS_CLASS}>
        {COLUMN_LABELS.map(label => (
          <p key={label} className={CELL_LABEL_CLASS}>{label}</p>
        ))}
        {/* The five action slots, empty — the grid has nine columns, and a strip
            that stopped after four would right-align its labels against the
            wrong edge. */}
        {[0, 1, 2, 3, 4].map(slot => <span key={slot} aria-hidden="true" />)}
      </div>
      </div>
    </div>
  );
}

/**
 * A money figure in its column.
 *
 * `smOnly` keeps the cell off phones, where the same figure is shown beside the
 * account name; the cell still exists in the grid at every other width.
 */
export function AccountBalanceCell({
  label,
  value,
  amount,
  smOnly = false,
  secondary,
}: {
  label: string;
  /**
   * The number behind `value`, for "Negatives in red" (owner, 14 Nov 2026).
   * The cell is handed a formatted string and cannot tell a debt from a
   * credit by reading it — brackets or a minus sign are a locale's choice.
   * Absent or null: the figure keeps its ordinary colour.
   */
  amount?: number | null;
  /**
   * The figure, already formatted — or `null` for NOT KNOWN, which renders an
   * em-dash.
   *
   * The same contract StatPill states, and for the same reason: an account
   * with no bank feed has no bank balance, which is not the same as a bank
   * balance of nothing. This cell used to be handed the string 'N/A' by its
   * caller — an abbreviation the rest of the app does not use, and one the
   * register and the reconciliation bar had already been moved off.
   */
  value: string | null;
  smOnly?: boolean;
  /**
   * A second, smaller line UNDER the figure — for the one account whose
   * worth and register differ, so both can be said WITHOUT a tenth cell.
   * The valued-rows change first rendered the register figure as its own
   * AccountBalanceCell, which is exactly the sin this file's header warns
   * against: the template is nine tracks, a surplus cell wraps the grid,
   * and the owner watched the delete button fall onto the next line while
   * every column slid one place right. A cell may say more; a row may not
   * grow columns.
   */
  secondary?: string;
}): React.JSX.Element {
  const negativeTone = useNegativeTone();
  return (
    <div className={smOnly ? 'relative hidden lg:block text-right' : 'relative text-right'}>
      <p className={ROW_LABEL_CLASS}>{label}</p>
      <p className={`${CELL_FIGURE_LINE_CLASS} ${CELL_FIGURE_CLASS} ${negativeTone(amount, 'text-gray-900 dark:text-white')}`}>
        {value ?? '—'}
      </p>
      {secondary !== undefined && (
        /* ABSOLUTE, so the line costs the cell no height. In flow it made
           this cell two lines tall inside an items-center grid, which sank
           every single-line neighbour below this cell's first line — the
           owner watched the Bank Bal figure sit lower than the worth beside
           it. Hanging the line into the card's own padding keeps every
           figure on one level and the register note exactly where it read
           best. */
        <p className="absolute top-full right-0 m-0 text-[11px] leading-tight text-gray-500 dark:text-gray-400 whitespace-nowrap">
          {secondary}
        </p>
      )}
    </div>
  );
}

/**
 * A count of outstanding work: readable while there is some, quieter when
 * there is none. Neither is a colour with a meaning.
 *
 * It wore amber until DESIGN_RULINGS_2026-08-12 (ruling A): amber marks the
 * CONTROL you should touch next — a single, clickable next action — and this
 * is a count, which reports a quantity and does nothing when clicked. Two
 * ambers on one screen where one is actionable and one is not teaches the eye
 * that amber means "look here-ish", eroding the one signal the yellow thread
 * depends on. If the row should invite the work, the invitation belongs on
 * the row's reconcile control, which already exists.
 *
 * ─ AND THE ZERO STOPPED BEING THE LOUDEST THING ON THE ROW ─────────────────
 * That de-ambering left an inversion behind, which is worth naming because it
 * was introduced by fixing something else: the count WITH work went quiet
 * slate while the ZERO kept the app's link blue, so a row with nothing to do
 * shouted across the page and a row with thirty outstanding rows murmured.
 * Colour marks what needs attention — ruling A's own argument — and a zero
 * needs nothing. Neither state is coloured now; the one with work is simply
 * legible and the one without recedes. (The same correction shipped on the
 * reconciliation list as finding §1.4, where a settled row wore a link-blue
 * pill for the ABSENCE of work.)
 *
 * A QUIET 0 RATHER THAN A BLANK, unlike the register's own counters, and the
 * difference is the surface rather than an inconsistency: this is a COLUMN, and
 * a column of figures with a hole in it reads as "not known" — the eye has to
 * stop and work out which. The register's counters are chrome, and there it is
 * absence that means "nothing to do".
 */
export function AccountCountCell({
  label,
  count,
  to,
  openLabel,
  toState,
}: {
  label: string;
  count: number;
  /**
   * Where this count's work is done. Given only when there IS somewhere: a
   * count of zero is never a door, because there is nothing behind it.
   */
  to?: string;
  /** Spoken form of the destination, e.g. "Reconcile Main Checking". */
  openLabel?: string;
  /**
   * Router state for the jump — the origin's provenance crumbs, so the trip
   * BACK lands on this row instead of the top of the list. Optional: a caller
   * with nowhere to return to simply omits it.
   */
  toState?: unknown;
}): React.JSX.Element {
  /*
   * THE PILL BECAME A DOOR — the owner's ask: "if we click on a highlighted
   * 'Unreconciled' figure or a 'To Review' figure, that has something to
   * reconcile, or review, it takes you to that specific reconciliation page,
   * or that specific view in the account register".
   *
   * It reads as one because it already looks like one: a filled navy shape is
   * what this app's primary controls wear, and the figure was ALREADY the
   * thing the eye lands on when scanning for work. The only thing it was
   * missing was the ability to act on what it found.
   *
   * ─ AND IT IS STILL NOT AMBER ────────────────────────────────────────────
   * The comment above says navy partly "because this is not clickable", and
   * that half of the argument has just expired — so here is the half that has
   * not. Ruling A gives amber to the ONE control you should touch next. A
   * count is now clickable but it is not singular: a list can show eight of
   * them at once, and eight ambers is precisely the erosion the ruling exists
   * to prevent. Amber's monopoly is on "this one, next" — not on "clickable".
   */
  /*
   * A CIRCLE UNTIL THE NUMBER OUTGROWS ONE. "The highlighted number looks oval
   * and not round" — and it stayed faintly oval even after the 44px floor was
   * lifted, because a width of `min-w + padding` lands wherever the digits put
   * it: 31 across against 24 down for two digits.
   *
   * So one and two digits get a FIXED 24x24 — a real disc, the shape that was
   * asked for and the shape a count badge is everywhere else. Three digits and
   * up keep the padded form and become a lozenge, which is the honest answer:
   * 130 does not fit in a 24px circle, and squeezing it would either shrink the
   * type or clip it. The break is at 100 because that is where the width has to
   * give, not because of anything about the number.
   */
  /* THE PILL FLIPS IN DARK (owner, 16 August). `bg-primary` is the near-black
     navy: the right "attend to this" mark on a white row, and a circle you can
     barely see on a gray-800 one — the count read as white digits floating on
     nothing. Dark inverts it: the light ground with navy digits, the same
     relationship the other way up, and the same reason the band totals swap
     ink rather than keep it.

     `bg-[#1a2332]`, NOT `bg-primary`: index.css gives `.bg-primary` an
     `!important`, which beats any `dark:` variant however specific — the same
     mechanism that blanked the grey text app-wide this morning. The literal
     hex is the same colour without the landmine. */
  const pillClass = `tabular-nums ${
    count > 0
      ? `inline-flex items-center justify-center h-6 rounded-full bg-[#1a2332] text-white dark:bg-gray-200 dark:text-[#1a2332] text-sm font-bold ${
          count < 100 ? 'w-6' : 'min-w-[24px] px-1.5'
        }`
      : 'text-sm font-normal text-gray-400 dark:text-gray-500'
  }`;

  if (count > 0 && to !== undefined) {
    return (
      <div className="text-right">
        <p className={ROW_LABEL_CLASS}>{label}</p>
        <div className={CELL_FIGURE_LINE_CLASS}>
        <Link
          to={to}
          state={toState}
          aria-label={openLabel}
          onClick={event => { event.stopPropagation(); }}
          /*
           * `touch-target-small` and `min-h-0` are BOTH required, and neither
           * is decoration.
           *
           * `min-h-0 min-w-0` is the pair that undoes the damage, and it took
           * two passes to learn it needs BOTH. On a touch device `index.css`
           * floors every `a` at 44x44 — sound for a control, wrong for a 20px
           * figure — and it inflated this disc to 31x44, lifting its label 12px
           * above its neighbours'. Undoing only the height fixed the label and
           * left a 44x24 lozenge: `min-width` had simply taken over from
           * `min-height` as the thing overriding the disc's own size, and
           * `w-6` cannot win against a min-width whatever it says. A utility
           * outranks that element rule, so this is where the disc gets its size
           * back — on both axes, or not at all.
           *
           * `touch-target-small` is what gives the thumb its 44px back, and it
           * is the app's OWN opt-in for exactly this problem — a centred 44x44
           * pseudo-element over a small visible control, taking no layout. It
           * replaces a hand-rolled `after:-inset-[10px]` written here before I
           * noticed index.css already had the idiom; one mechanism, in one
           * place, is worth more than a slightly tidier inset.
           *
           * `stopPropagation` because the row itself is clickable (it selects
           * the account): without it, opening the reconciliation view would
           * also pick out the row behind it, and coming back would land on a
           * selection the user never made.
           */
          className={`${pillClass} min-h-0 min-w-0 touch-target-small hover:brightness-125 transition-[filter] duration-state`}
        >
          {count}
        </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="text-right">
      <p className={ROW_LABEL_CLASS}>{label}</p>
      <div className={CELL_FIGURE_LINE_CLASS}>
      <p
        /*
         * A FILLED SHAPE, NOT LOUDER TEXT.
         *
         * Three attempts at this column, and the first two were the same idea
         * at different volumes. It began as colour alone — slate-600 against
         * gray-400, both `font-semibold` — and the owner could not find the
         * rows that mattered: "I miss them because when there are these things
         * to do, they dont stand out vs all the other accounts with zero's."
         * Near-black, bold and a step larger was better and still not enough:
         * "BETTER BUT IT NEEDS TO STAND OUT MORE."
         *
         * It was never going to be enough, because every one of those is text
         * competing with text down a column of 130 rows. A filled pill breaks
         * the rhythm instead of raising its voice within it — the eye finds a
         * SHAPE among words without reading any of them.
         *
         * ─ WHY NAVY, AND WHY THAT IS NOT THE THING RULING A BANNED ──────────
         * Amber belongs to the one CONTROL you should touch next and this is
         * not clickable; green and red mean money in and money out, and a count
         * is neither. Navy is the brand's own ink, already the fill of every
         * primary control, and it says "here" without claiming to be a
         * direction or an alarm. It is also the shape ActivityBadge already
         * uses for a count that carries a figure, so the app has one idiom for
         * this rather than two.
         *
         * The ZERO is untouched by all of it: still plain, still light, still
         * receding. Ruling A's correction — that nothing is not something to
         * attend to — is exactly why the contrast between the two can be this
         * strong without the zero shouting.
         */
        className={`tabular-nums ${
          count > 0
            // Flipped in dark for the reason the linked pill above states.
            ? 'inline-flex items-center justify-center min-w-[24px] px-1.5 py-0.5 rounded-full bg-[#1a2332] text-white dark:bg-gray-200 dark:text-[#1a2332] text-sm font-bold'
            : 'text-sm font-normal text-gray-400 dark:text-gray-500'
        }`}
      >
        {count}
      </p>
      </div>
    </div>
  );
}

/**
 * A column this row has nothing for.
 *
 * Rendered from sm up only: that is where the grid is, and where a missing cell
 * would shunt everything after it out of line. Below sm the columns are a
 * wrapping flex row, and an invisible item there would only add a gap.
 */
export function AccountRowEmptyCell(): React.JSX.Element {
  return <div className="hidden lg:block" aria-hidden="true" />;
}

/**
 * One of the five action slots.
 *
 * Rendered whether or not this row has that action — an account with no bank
 * feed keeps an empty feed slot rather than letting the buttons after it
 * shuffle left, because muscle memory is the point. A row that has no such
 * action AT ALL (a cash sleeve has no portfolio and no feed) uses
 * AccountRowEmptyCell instead, which costs nothing on a phone.
 */
export function AccountRowActionSlot({ children }: { children?: ReactNode }): React.JSX.Element {
  return <div className="flex items-center justify-end">{children}</div>;
}
