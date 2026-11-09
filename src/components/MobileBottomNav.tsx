import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { HomeIcon, WalletIcon, BarChart3Icon, CheckCircleIcon, TagIcon, PlusIcon, XIcon, SearchIcon } from './icons';
import { SIDE_INSET_LEFT, SIDE_INSET_RIGHT } from './layout/chromeOffsets';

interface MobileNavItem {
  to: string;
  icon: React.ElementType;
  label: string;
  badge?: number;
}

/**
 * Five slots for the things you do on a phone. Budget and Goals used to hold
 * two of them: both are desk work — you sit down to plan, you don't plan in a
 * queue — and neither is something you reach for while standing in a shop.
 * Reconcile and Review are the opposite: they are the two chores that decide
 * whether the numbers can be trusted, and they are made of small decisions
 * that suit a phone. Budget and Goals keep their places in the menu.
 *
 * Home pointed at "/" until now, which is the public welcome page — a signed-in
 * user tapping Home got the marketing pitch. It points at the dashboard, which
 * is what the desktop nav has always meant by Home.
 *
 * Labels are 11px with no slot padding because that is what measurement said,
 * not taste: at 375px each of five slots gives the text 63px at 12px type, and
 * "Transactions" needed 72px — it rendered as "Transactio…" for as long as it
 * was here. At 11px with the padding removed every label fits whole. The full
 * word "Categorisation" does not fit at any size tried (83px), hence the verb,
 * which also matches "Reconcile".
 *
 * The third slot was Transactions, the global list, which is retired: on a
 * phone you either open the account you are looking at (Accounts) or you are
 * hunting for one row, which is Find. Nothing browses fifty thousand rows on a
 * phone, which is what that slot offered.
 */
const mobileNavItems: MobileNavItem[] = [
  { to: '/dashboard', icon: HomeIcon, label: 'Home' },
  { to: '/accounts', icon: WalletIcon, label: 'Accounts' },
  { to: '/find', icon: SearchIcon, label: 'Find' },
  { to: '/reconciliation', icon: CheckCircleIcon, label: 'Reconcile' },
  // The review ROUND, not Manage → Categorisation: the owner pressed this
  // expecting the To Review flow and landed on category admin (29 Sep 2026).
  // ?focus=review is consumed by the Accounts page, which then walks the
  // accounts that still have rows to review (see Accounts.tsx, ARRIVING BACK).
  { to: '/accounts?focus=review', icon: TagIcon, label: 'Categorise' },
];

/**
 * The widest the floating pill gets. 26rem (416px) holds the five labelled
 * destinations and the + with the air they have on a 390px phone, where the
 * pill is 374px wide; above a 432px window it stops growing and centres.
 * The quick-actions menu's horizontal anchor is derived from this, so the
 * two cannot disagree.
 */
const PILL_MAX_WIDTH = '26rem';

export default function MobileBottomNav(): React.JSX.Element {
  const location = useLocation();
  const [showQuickActions, setShowQuickActions] = useState(false);

  // WHICH SLOT IS CURRENT. A destination may carry a query ("/accounts
  // ?focus=review" is the review round, a mode of the Accounts page), and
  // then it is current only while that query is in the address — and it
  // outranks the plain Accounts slot, so one tab lights, not two. Once the
  // Accounts page has consumed the param the address is plain /accounts and
  // Accounts is the current slot again, which is what the screen then is.
  const matches = (to: string): boolean => {
    const [pathname, search = ''] = to.split('?');
    if (pathname === '/') return location.pathname === '/';
    if (!location.pathname.startsWith(pathname)) return false;
    return search === '' || location.search.includes(search);
  };
  const currentTo =
    mobileNavItems.find(item => item.to.includes('?') && matches(item.to))?.to ??
    mobileNavItems.find(item => matches(item.to))?.to ?? null;
  const isActive = (to: string): boolean => to === currentTo;

  return (
    <>
      {/* Quick Actions Menu */}
      {showQuickActions && (
        <div 
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setShowQuickActions(false)}
        >
          {/* Anchored to the pill it now belongs to, by the same inline style
              and for the same reason. `bottom-20` was measured against a bar
              that ran to the physical edge; the pill floats clear of it, so the
              menu has to rise from the pill's top rather than from a number
              that used to describe one. Which makes it one of the trio the
              pill's own `bottom` names below: when the pill drops a notch
              this drops by exactly the same amount, or the panel floats away
              from the thing it belongs to. */}
          {/* THE ITEMS NAME THEIR OWN INK. Neither link set a text colour, so
              both inherited — and what they inherited was the document
              default, near-black. On the light panel that is correct by
              accident; on `dark:bg-gray-800` it is near-black on dark grey,
              which is what the owner reported as "hard to read" the first time
              he opened this menu on a phone in dark mode.

              Inheriting is the trap: it looks deliberate, and it is right in
              exactly one of the two modes this panel has. */}
          <div
            className="absolute bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-2 min-w-[200px]"
            // Horizontally it sits 0.25rem inside the pill's right edge. When
            // the pill is capped at PILL_MAX_WIDTH and centred, that edge is
            // no longer the window's: it moves in by half of whatever the
            // window has to spare, so the menu moves with it or floats away
            // from the + it belongs to. 0px to spare on a phone, where the
            // max() is the old number exactly.
            style={{
              right: `calc(0.75rem + ${SIDE_INSET_RIGHT} + max(0px, (100% - ${PILL_MAX_WIDTH} - 1rem - ${SIDE_INSET_LEFT} - ${SIDE_INSET_RIGHT}) / 2))`,
              bottom: 'calc(4.875rem + var(--wt-home-indicator-inset, 0px))'
            }}
          >
            {/* The add-transaction modal is Layout's and is opened by an
                app-wide parameter, so this points at a page that still exists
                rather than at the retired list. `add-transaction`, not `add`:
                on /accounts the shorter word already means "add an account". */}
            <Link
              to="/accounts?action=add-transaction"
              className="flex items-center gap-3 px-4 py-3 text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
              onClick={() => setShowQuickActions(false)}
            >
              <BarChart3Icon size={20} />
              <span>Add Transaction</span>
            </Link>
            <Link
              to="/accounts?action=add"
              className="flex items-center gap-3 px-4 py-3 text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
              onClick={() => setShowQuickActions(false)}
            >
              <WalletIcon size={20} />
              <span>Add Account</span>
            </Link>
          </div>
        </div>
      )}

      {/*
        A FLOATING PILL, not a bar welded to the bottom edge — the owner sent
        Instagram's and asked for "our icons in a floating toolbar". It is the
        same five destinations and the same labels; what changed is that the
        chrome stops pretending to be part of the device.

        ─ THE QUICK-ADD IS INSIDE IT NOW ──────────────────────────────────────
        It used to be a 3.5rem navy circle floating ABOVE the bar, and two
        stacked round things in one corner is exactly what the pill shape stops
        looking calm about. Folding it in also pays for itself twice over: the
        page's bottom reservation was `5 (nav) + 3.5 (button) + 1 (air)`, and
        the button's share of that is now given back to every mobile page.

        ─ POSITIONED BY INLINE STYLE, DELIBERATELY ────────────────────────────
        The button this replaces carried a hard-won comment: on the owner's
        actual device its positioning UTILITIES were not applied — it rendered
        against the left edge while every desktop browser put it bottom-right —
        and an inline style was what fixed it. Whatever ate those classes, a
        floating pill depends on exactly the same four properties, so it takes
        the same precaution rather than rediscovering the bug on his phone.
      */}
      <nav
        className="md:hidden fixed z-50 rounded-full bg-white/95 dark:bg-gray-800/95 backdrop-blur-md shadow-[0_4px_24px_rgba(0,0,0,0.18)] border border-black/5 dark:border-white/10"
        style={{
          // …plus the iPhone Duo's status-pill column, 0px everywhere else.
          left: `calc(0.5rem + ${SIDE_INSET_LEFT})`,
          right: `calc(0.5rem + ${SIDE_INSET_RIGHT})`,
          // A WIDTH OF ITS OWN above phone width. On the iPhone Duo opened and
          // held upright (669px) the pill ran edge to edge and read as a bar
          // again (owner, 9 Nov 2026: "it can be made smaller and hover over
          // the page behind"). Capped here and centred by the auto margins
          // inside the left/right box, so the side insets still count. At or
          // below PILL_MAX_WIDTH plus the two 0.5rem gaps — every phone — this
          // changes nothing. Inline, like its neighbours, for the reason the
          // header comment gives.
          maxWidth: PILL_MAX_WIDTH,
          marginLeft: 'auto',
          marginRight: 'auto',
          // 0.125rem: halved from 0.75 on 30 Aug ("moving the pill down a
          // bit"), and halved again 31 Aug when the owner asked for the same
          // thing once more — "the pill can also sit lower". Still floating,
          // by 2px plus whatever the home indicator's inset adds, which on
          // every phone that has one is most of the visible gap.
          //
          // THREE NUMBERS, ONE NOTCH. This is the low one of a trio that only
          // ever moves together, each by the same amount (0.25rem on 31 Aug):
          // this, the quick-actions menu that is anchored above the pill
          // (4.875rem, up the file), and --wt-bottom-nav-clearance in
          // index.css (5.625rem), which is what stops the last register row
          // hiding behind it. Change one, change all three, or the panel
          // detaches from the pill or the page gives back the air.
          bottom: 'calc(0.125rem + var(--wt-home-indicator-inset, 0px))'
        }}
        role="navigation"
        aria-label="Mobile navigation"
      >
        <div className="flex justify-around items-center py-1.5 px-1">
        {mobileNavItems.map((item) => {
          const active = isActive(item.to);
          const Icon = item.icon;
          
          return (
            <Link
              key={item.to}
              to={item.to}
              /*
               * `flex-auto`, NOT `flex-1`, and it is the difference between
               * five whole words and three truncated ones.
               *
               * `flex-1` is `flex: 1 1 0%` — every slot starts from zero and
               * they end up identical, so at 320px each got 45px whether its
               * word was "Find" (22) or "Categorise" (57), and three of the
               * five clipped the moment the quick-add joined the row. Measured,
               * before assuming it could not fit: the five labels want 211px
               * between them and the button wants 44, against 296 available.
               * It fits — equal division was the only thing stopping it.
               *
               * `flex-auto` is `flex: 1 1 auto`: each slot starts at its own
               * content width and the SPARE room is what gets shared out. Short
               * words stop hoarding what long words need, and the tap targets
               * stay comfortable because the leftover is still distributed.
               */
              className={`flex flex-col items-center justify-center min-w-[44px] min-h-[48px] flex-auto shrink-0 py-1.5 px-0.5 rounded-full transition-colors ${
                active
                  // `bg-nav-bg/10`, not `bg-primary/10`, and the difference is
                  // not cosmetic: `primary` is `var(--color-primary, #1a2332)`,
                  // and Tailwind 3 cannot apply an opacity modifier to a bare
                  // `var()` — it fails to parse it as a colour and emits NO
                  // RULE AT ALL. Compiled both to check: `bg-primary/10` is
                  // absent from the stylesheet, so it would have silently
                  // deleted the active state rather than tokenising it.
                  // `nav.bg` is the navigation family's own token and holds
                  // this exact navy as a literal, so `/10` compiles to the
                  // `rgb(26 35 50 / 0.1)` the hardcoded class was already
                  // producing — same pixels, named.
                  // The dark half is new, and the pill is why. `bg-nav-bg/10` is
                  // a NAVY wash — it reads as a lozenge on a white pill and all
                  // but disappears on a dark one, where the surface underneath
                  // is already near that navy. Seen in a dark-mode screenshot:
                  // the current page was distinguishable only by its ink. A
                  // light wash is the same idea with the polarity the surface
                  // asks for, and `dark:text-white` gives the ink somewhere to
                  // go once the tint stops carrying the state on its own.
                  ? 'text-primary bg-nav-bg/10 dark:text-white dark:bg-white/10'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
            >
              <div className="relative">
                <Icon size={22} />
                {/* Neutral, for `ActivityBadge`'s reason and in its palette:
                    this is a count of things not yet looked at, and expense
                    red on a count is the inversion corrected on Accounts and
                    on the reconciliation list. Nothing sets `badge` today, so
                    this is the shape the first caller will inherit — which is
                    exactly why it is worth being right now rather than later.

                    `> 0` rather than a bare `&&`: `{0 && …}` renders the
                    number, so a slot that genuinely had nothing waiting would
                    have printed a naked "0" beside its icon with no badge
                    around it. Zero counts render nothing. */}
                {item.badge !== undefined && item.badge > 0 && (
                  <span className="absolute -top-2 -right-2 bg-surface-tertiary text-slate-600 dark:bg-gray-700 dark:text-gray-300 text-xs rounded-full h-5 w-5 flex items-center justify-center">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
              </div>
              <span className={`text-[10px] min-[360px]:text-[11px] mt-1 truncate max-w-full ${
                active ? 'font-medium' : 'font-normal'
              }`}>
                {item.label}
              </span>
            </Link>
          );
        })}

        {/*
          THE QUICK-ADD, LAST RATHER THAN CENTRED. A centre slot is the more
          fashionable arrangement and it is wrong here: it would split
          "Home / Accounts" from "Find / Reconcile / Categorise", and those five
          are one list of places — putting a verb in the middle of them breaks
          the run the thumb learns. At the end it reads as what it is, an action
          sitting beside the places rather than among them.

          A FIXED WIDTH, not `flex-1`, and no label. Every pixel it does not
          take is a pixel the five labels keep, and "Categorise" is the longest
          word in the app's navigation — the whole reason those labels are 11px.
          `+` needs no caption; it is the one glyph in the set that does not.
        */}
        <button
          onClick={() => setShowQuickActions(!showQuickActions)}
          // `w-11 h-11` = 44px, stated rather than inherited. `w-10` renders at
          // 44 anyway — index.css puts a 44px floor under every button — but a
          // 40 in the source that measures 44 on screen is a trap for whoever
          // next does this arithmetic, and this row's widths are arithmetic.
          className={`shrink-0 w-11 h-11 ml-0.5 rounded-full bg-primary dark:bg-[#2d3a4d] text-white flex items-center justify-center transition-transform ${
            showQuickActions ? 'rotate-45' : ''
          }`}
          aria-label="Quick actions"
          aria-expanded={showQuickActions}
        >
          {showQuickActions ? <XIcon size={22} /> : <PlusIcon size={22} />}
        </button>
      </div>
    </nav>
    </>
  );
}