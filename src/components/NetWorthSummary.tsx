import React from 'react';
import { useNegativeTone } from '../contexts/NegativesInRedContext';
import ConvertedTotalNote from './ConvertedTotalNote';
import type { RatesProvenance } from '../utils/currency-decimal';

/**
 * Net worth and its two components, as ONE card.
 *
 * ─ WHY IT IS ONE CARD ──────────────────────────────────────────────────────
 * Both surfaces that show these three figures used to draw them as a navy slab
 * plus two white cards — one important thing and two afterthoughts, when what
 * is actually on screen is one figure and the two halves it is made of
 * (DESIGN_PASS_2026-08 §3.3, §3.4). Assets minus liabilities IS net worth, so
 * the three sit in one card, three columns, separated by hairlines rather than
 * by gaps between separate boxes.
 *
 * The dark slab went with it. A full-bleed navy panel under a navy nav bar puts
 * two heavy horizontals at the top of the page, and it forces a second
 * text-colour system (white-on-navy) to exist for one card. The figure is
 * already the largest thing on the page — per P1 it does not need a panel
 * behind it to say so.
 *
 * ─ WHY IT IS SHARED ────────────────────────────────────────────────────────
 * The Accounts list and the Dashboard show the same three numbers. Two copies
 * of this markup is two things to keep in step, and they had already drifted
 * into different colours, sizes and shapes. One definition means the two
 * surfaces cannot disagree about what net worth looks like.
 *
 * ─ CURRENCY ────────────────────────────────────────────────────────────────
 * All three values are formatted by the caller in the DISPLAY currency (the
 * preference), never in any one account's own — a total over accounts that do
 * not share a currency belongs to none of them. Individual account rows keep
 * showing their own currency; that split is deliberate and is what settles the
 * mismatch between the summary and the rows below it.
 */

export type NetWorthFigure = 'net' | 'assets' | 'liabilities';

interface NetWorthSummaryProps {
  /**
   * Net worth as a number, for "Negatives in red". The card is handed
   * formatted strings and cannot read a sign off one. Absent: the headline
   * keeps its colour whatever the setting.
   */
  netWorthAmount?: number | null;
  /** Already formatted, in the display currency. */
  netWorth: string;
  assets: string;
  liabilities: string;
  /**
   * Drill-down, if this surface has one — the Accounts list opens the accounts
   * behind a figure. Omitted, the cells are plain text rather than dead
   * buttons.
   */
  onSelect?: (figure: NetWorthFigure) => void;
  /**
   * Where the rates that produced these three figures came from, or null when
   * no conversion was needed because the whole ledger is in one currency.
   *
   * Null is the common case and it renders NOTHING — see ConvertedTotalNote.
   * The card gains no height, no border and no words for the many people who
   * never touch a second currency.
   */
  provenance?: RatesProvenance | null;
  /**
   * Currencies with no available rate, whose amounts are nevertheless inside
   * these totals. Reported because it makes the figures wrong by that much.
   */
  unconverted?: readonly string[];
  /** The currency the three figures are expressed in. */
  displayCurrency?: string;
  /**
   * What the two components are CALLED.
   *
   * Plain English by default, on a design ruling (13 Aug night §3.3): "What you
   * own" and "What you owe" are the Reports-gallery voice, and that voice is
   * more of this product's identity than any colour in the token sheet. The
   * terser accounting pair is the OVERRIDE, not the reverse — a summary card
   * that cannot take plainer words is a card that enforces jargon.
   *
   * They exist as props at all because the net-worth STATEMENT report had
   * already chosen the plainer words for itself, and converting it to this card
   * would otherwise have silently overwritten somebody's word choice. That is a
   * content decision, and a refactor is not allowed to make it.
   */
  assetsLabel?: string;
  liabilitiesLabel?: string;
}

/** The column heading over each figure. */
const LABEL_CLASS = 'text-label uppercase font-medium text-gray-500 dark:text-gray-400';

export default function NetWorthSummary({
  netWorth,
  assets,
  liabilities,
  onSelect,
  provenance = null,
  unconverted = [],
  displayCurrency,
  assetsLabel = 'What you own',
  liabilitiesLabel = 'What you owe',
  netWorthAmount = null,
}: NetWorthSummaryProps): React.JSX.Element {
  const negativeTone = useNegativeTone();
  /**
   * ALL THREE figures are navy. None of them is a direction of travel.
   *
   * This card used to argue the point for one cell and then contradict itself
   * in the next two: net worth was navy because "net worth is the answer, not a
   * direction of travel, and the sign in front of it says which way it went"
   * — and then Assets rendered in `text-income` and Liabilities in
   * `text-expense`. But Assets is a magnitude, exactly as net worth is. So is
   * Liabilities. The reasoning was written down and applied to one cell in
   * three (RULINGS_ON_CAUSE_2026-08-13 §1).
   *
   * What the inconsistency cost is not on this card, it is everywhere else:
   * green and red mean money in and money out, and spending them on two
   * standing magnitudes makes them quieter in the register, where direction is
   * the whole point (P2 — colour is a signal, never a surface).
   *
   * Hierarchy is carried by SIZE, not colour — `display` for the headline,
   * `page` for the two components it is made of. That is the same job the old
   * navy slab was doing with a background, and it still works with every cell
   * the same colour.
   *
   * ─ WHY `text-gray-900` AND NOT `text-primary` ──────────────────────────────
   * index.css locks `.text-primary { color: var(--color-primary) !important }`,
   * and `!important` beats a `dark:` variant whatever its specificity. So
   * `text-primary dark:text-white` — which is what the net worth cell actually
   * shipped — never flipped: MEASURED in the running app, the figure computed
   * to #1a2332 on the #1f2937 dark card, a contrast of 1.08:1. Net worth was
   * invisible in dark mode, and applying that class to the other two cells
   * would have made all three so.
   * The app's documented way out (see SimpleSignIn) is that anything which
   * must flip for dark mode uses the neutral gray tokens, which are not
   * locked. `text-gray-900` is #111827 against the brand's #1a2332 — the same
   * near-black navy to the eye, and the colour the rest of the app's headline
   * figures already use.
   */
  /* `text-display` only from `lg`. The three cells sit abreast from `sm`,
     and at the widths between — the opened iPhone Duo held upright is 669px,
     an iPad held upright 768 — a cell is some 180–240px wide, where an
     eight-digit net worth at 32px wraps onto a second line while its two
     neighbours at 24px do not (owner's screenshot, 9 Nov 2026: "the Net
     worth figure is not in line with the what you own and what you owe
     figures"). Below `lg` all three figures share the 24px size and the
     baseline; from `lg` the net figure is the headline again. */
  // The one exception to "all three are navy", and it is the person's, not
  // the card's: with "Negatives in red" ticked (owner, 14 Nov 2026) a net
  // worth below zero is drawn red like every other balance below zero. The
  // other two cells are magnitudes and are never below zero, so they never
  // change. Unticked, nothing here differs from the argument above.
  const NET_FIGURE_CLASS =
    `text-page lg:text-display font-semibold ${negativeTone(netWorthAmount, 'text-gray-900 dark:text-white')}`;
  const COMPONENT_FIGURE_CLASS = 'text-page font-semibold text-gray-900 dark:text-white';

  const cells: ReadonlyArray<{
    figure: NetWorthFigure;
    label: string;
    value: string;
    figureClass: string;
  }> = [
    {
      figure: 'net',
      label: 'Net worth',
      value: netWorth,
      figureClass: NET_FIGURE_CLASS,
    },
    {
      figure: 'assets',
      label: assetsLabel,
      value: assets,
      figureClass: COMPONENT_FIGURE_CLASS,
    },
    {
      figure: 'liabilities',
      label: liabilitiesLabel,
      value: liabilities,
      figureClass: COMPONENT_FIGURE_CLASS,
    },
  ];

  return (
    <>
    <div className="overflow-hidden rounded-lg border border-line dark:border-gray-700 bg-white dark:bg-gray-800">
      {/* Hairlines between the columns, not gaps between cards: one border for
          the whole thing rather than three. They stack on a phone, where three
          eight-digit figures abreast force the page to scroll sideways. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 divide-y divide-line dark:divide-gray-700 sm:divide-y-0 sm:divide-x sm:divide-line">
        {cells.map(({ figure, label, value, figureClass }) => {
          const content = (
            <>
              <p className={LABEL_CLASS}>{label}</p>
              <p className={`mt-1 ${figureClass}`}>{value}</p>
            </>
          );

          return onSelect ? (
            <button
              key={figure}
              type="button"
              onClick={() => onSelect(figure)}
              className="flex flex-col items-start p-4 text-left transition-colors duration-state hover:bg-surface-secondary dark:hover:bg-gray-700/50 !shadow-none"
              /* aria-label, not title (Design, 25 Aug §3). A native `title`
                 tooltip is positioned by the BROWSER relative to the cursor,
                 not by us — which is why it was caught rendering over the
                 page heading and clipping the word "Accounts". There is no
                 anchor to change: the only choices are to drop the visual
                 tooltip or to build a custom one. The hover state already
                 says the tile is pressable, so the text is kept where it
                 still does work — as the control's accessible name — and
                 stops drawing a box over whatever the cursor happens to be
                 near. */
              aria-label="See the accounts behind this figure"
            >
              {content}
            </button>
          ) : (
            <div key={figure} className="p-4">
              {content}
            </div>
          );
        })}
      </div>
    </div>
    {/* Directly under the figures it is about — the app's standing rule is that
        a warning belongs where the error shows, not in a banner at the top of
        the page. Renders nothing when there was nothing to convert. */}
    <ConvertedTotalNote
      provenance={provenance}
      unconverted={unconverted}
      displayCurrency={displayCurrency}
    />
    </>
  );
}
