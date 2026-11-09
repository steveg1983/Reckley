import React, { useEffect } from 'react';
import { SignInButton, SignUpButton, useAuth } from '@clerk/clerk-react';
import { Link, useNavigate } from 'react-router-dom';
import { ReckleyLockup } from '../components/brand/ReckleyLockup';
import { SIDE_INSET_LEFT, SIDE_INSET_RIGHT } from '../components/layout/chromeOffsets';

/**
 * THE LANDING PAGE — Claude Design's 29 Aug 2026 handover, ported section by
 * section from `Reckley Landing.dc.html`. The copy is the design's, not
 * this file's; §7 of the handover forbids softening the editions comparison
 * or the limits section, and the colour/radius/no-shadow rules are §4's.
 *
 * Three sentences differ from the design source, all under the handover's own
 * gate (§5.2: "every claim must be literally true today", verified against
 * the code 30 Aug 2026):
 *
 *  - The Stripe row says what IS kept (brand, last four, expiry — reported
 *    back by Stripe for the billing page) rather than "never held here".
 *  - The backups card says encryption is chosen ("if you choose, lock it"),
 *    because the export is unencrypted unless the passphrase box is ticked.
 *  - Both trial-terms lines say "a preview, not a free-for-life plan" rather
 *    than "a time-limited key": no key mechanism exists in the code today,
 *    and §7 says these lines must match whatever the key actually does. When
 *    a real key ships, put the stronger wording back — in both places.
 *
 * The page paints its own grounds (§4's dark and light bands are the design,
 * not a theme) — deliberately no dark: variants anywhere.
 */

// §4's palette, named once. These are the design's literal values; income and
// expense marks in §07 use the app's own semantic tokens instead.
const DARK_GROUND = 'bg-[#101826]';
const DARK_CARD = 'bg-[#18202e]';
const DARK_HAIRLINE = 'border-[#23304a]';
const MONO = "font-['IBM_Plex_Mono',ui-monospace,monospace]";

/** §4: mono eyebrow labels — the section numbers and column headers. */
function Eyebrow({ children, tone }: { children: React.ReactNode; tone: 'dark' | 'light' }): React.JSX.Element {
  return (
    <span className={`${MONO} text-[11px] tracking-[0.12em] uppercase ${tone === 'dark' ? 'text-[#7c8ba3]' : 'text-[#64748b]'}`}>
      {children}
    </span>
  );
}

const ETHOS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Every report says what it leaves out',
    body: 'Uncategorised rows, excluded currencies, the rate used and when — stated on the page, never buried.',
  },
  {
    title: 'Everything counts, not just what a bank will tell you',
    body: 'The house, the pension, the loan to your brother. An API can only see accounts a bank chose to expose.',
  },
  {
    title: 'You decide what everything is',
    body: 'No machine quietly filing your mortgage under shopping — and no way for that to go unnoticed.',
  },
  {
    title: 'Bring your history with you',
    body: 'Import from Microsoft Money, CSV, QIF and OFX, or connect a bank feed.',
  },
];

const RECONCILE_LEGEND: ReadonlyArray<{ mark: string; text: string }> = [
  { mark: 'C', text: 'Cleared — you have checked it off against your bank, ready to reconcile' },
  { mark: 'R', text: 'Reconciled — settled as part of a statement you have signed off' },
  { mark: '·', text: 'Neither — in your account register, but not yet checked against anything' },
];

const IMPORT_FORMATS: ReadonlyArray<{ format: string; carries: string }> = [
  { format: '.mny', carries: 'Accounts, transactions, splits, categories, payees, C/R marks' },
  { format: '.qif', carries: 'Transactions, categories, splits' },
  { format: '.ofx', carries: 'Transactions with bank identifiers, matched on import' },
  { format: '.csv', carries: 'Transactions, with columns you map yourself' },
];

const VENDORS: ReadonlyArray<{ name: string; role: string }> = [
  { name: 'Clerk', role: 'Sign-in and passwords. Reckley never stores a password of yours.' },
  {
    name: 'TrueLayer',
    role: "Bank connections, FCA-regulated. You authorise on your bank's own site — your banking credentials never pass through this app.",
  },
  { name: 'Supabase', role: 'Your ledger, encrypted at rest, isolated per account.' },
  { name: 'Vercel', role: 'Hosting and delivery, over HTTPS only.' },
  {
    name: 'Stripe',
    role: 'Payments, when there are any. Your card is entered on Stripe’s own pages; what stays here is only what Stripe reports back — brand, last four digits, expiry.',
  },
];

const DATA_CARDS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Read-only, always',
    body: 'A bank connection can see transactions and balances. It cannot move money, and there is no code here that could.',
  },
  {
    title: 'Your backups, encrypted by you',
    body: 'Export your whole ledger — and, if you choose, lock it with a passphrase only you hold. Lose it and nobody, including us, can open the file.',
  },
  {
    title: 'Nothing is sold, ever',
    body: 'Your spending is not a product. No data broker, no advertising, no “anonymised insights” sold on.',
  },
];

type EditionRow = { sign: '+' | '−' | '·'; text: React.ReactNode };

const CONNECTED_ROWS: ReadonlyArray<EditionRow> = [
  { sign: '+', text: 'Bank feeds through TrueLayer, read-only' },
  { sign: '+', text: 'Live investment pricing and exchange rates' },
  {
    sign: '+',
    text: (
      <>
        iPhone app alongside the desktop <span className="text-[#64748b]">— in TestFlight now</span>
      </>
    ),
  },
  { sign: '+', text: 'Every new feature as it lands' },
  { sign: '·', text: 'Your ledger lives on servers named in the section above' },
];

const STANDALONE_ROWS: ReadonlyArray<EditionRow> = [
  { sign: '+', text: 'Your data never leaves your machine — there is nowhere for it to go' },
  { sign: '+', text: 'The same register, reconciliation, budgets and reports' },
  { sign: '+', text: 'Money, QIF, OFX and CSV import, all of it manual' },
  { sign: '−', text: 'No bank feeds, and no live prices or exchange rates' },
  { sign: '−', text: 'Updates arrive as versions, not continuously' },
];

const LIMITS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "It won't do the work for you",
    body: 'Categorising and reconciling take your attention. That is the cost of numbers you can stand behind, and there is no version of this that skips it.',
  },
  {
    title: "It won't tell you what to do with your money",
    body: 'No advice, no nudges, no score out of ten. It tells you where you stand and how you got there; the decisions stay yours.',
  },
  {
    title: "It isn't finished",
    body: 'It is built and used daily, and it is still being built. While that is true it is free to use — a preview, not a free-for-life plan — and testers who send useful feedback keep a Standalone key for life. Your ledger exports in full, whenever you want it.',
  },
  {
    title: "It isn't the fastest way to see a balance",
    body: 'If all you want is today’s number, your banking app already has it. This is for the figure underneath — the one that holds up when someone asks.',
  },
];

/** One edition row: the mono +/−/· mark, then the line. Income and expense
 *  tokens mark what an edition gains and gives up — §4 says these are the
 *  only two places the amount colours appear on this page. */
function EditionLine({ row, last }: { row: EditionRow; last: boolean }): React.JSX.Element {
  const markColour =
    row.sign === '+' ? 'text-income' : row.sign === '−' ? 'text-expense' : 'text-[#94a3b8]';
  return (
    <div
      className={`grid grid-cols-[22px_1fr] gap-[11px] px-6 py-[11px] text-[13.5px] leading-5 items-baseline ${last ? '' : 'border-b border-[#f4f6f9]'}`}
    >
      <span className={`${MONO} ${markColour}`}>{row.sign}</span>
      <span className={row.sign === '+' ? 'text-[#1a2332]' : 'text-[#475569]'}>{row.text}</span>
    </div>
  );
}

export default function Welcome(): React.JSX.Element {
  const { isSignedIn } = useAuth();
  const navigate = useNavigate();

  // Signed-in visitors have no business on the landing page — send them home.
  useEffect(() => {
    if (isSignedIn) {
      navigate('/dashboard');
    }
  }, [isSignedIn, navigate]);

  // Brief interstitial while the redirect above runs. Full-page: this route
  // renders outside Layout, so there is no chrome behind it to fill in.
  if (isSignedIn) {
    return (
      <div className={`min-h-screen ${DARK_GROUND} flex flex-col items-center justify-center text-center`}>
        <h1 className="text-2xl font-bold text-[#f1f3f7]">Welcome back</h1>
        <p className="mt-2 text-[#93a1b6]">Taking you to your dashboard…</p>
      </div>
    );
  }

  const year = new Date().getFullYear();

  return (
    <div
      className={`min-h-screen ${DARK_GROUND} text-[#f1f3f7] antialiased`}
      /* This page is mounted outside Layout, so it pays the side insets itself
         — the iPhone Duo bills its camera pill as a safe-area inset down the
         whole right edge when closed (84px, 9 Nov 2026), and the header's
         Sign in sat under it. The ground pads, as Layout's does; the dark
         ground shows in the column beside the lighter sections, which is the
         convention Apple's own Settings follows. 0px everywhere else. */
      style={{ paddingLeft: SIDE_INSET_LEFT, paddingRight: SIDE_INSET_RIGHT }}
    >
      {/* Signed-out header — wordmark and the two account actions, nothing
          else (handover §5.1). Create an account yields to the hero CTA below
          640px rather than crowding the bar (§6). */}
      <header className={`flex items-center justify-between px-6 sm:px-12 py-[18px] border-b border-[#1e2838] sticky top-0 ${DARK_GROUND} z-10`}>
        {/* The horizontal lockup at its 96px minimum. The identity handover
            drew this header navy-on-white; the landing has been on its dark
            ground since August, and a one-colour mark takes the header's
            light text colour here rather than asking for a white bar. */}
        <ReckleyLockup layout="horizontal" width={96} />
        <div className="flex items-center gap-2.5">
          <SignInButton mode="modal">
            <button
              type="button"
              className="px-3.5 py-2 text-sm font-medium text-[#cbd5e1] rounded-md hover:bg-[#1a2332] hover:text-[#f1f3f7] transition-colors"
            >
              Sign in
            </button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button
              type="button"
              className="hidden sm:inline-flex px-4 py-2 text-sm font-medium text-[#101826] bg-[#f1f3f7] rounded-md hover:bg-white transition-colors"
            >
              Create an account
            </button>
          </SignUpButton>
        </div>
      </header>

      {/* Hero */}
      <section className="px-6 sm:px-12 pt-16 sm:pt-24 pb-16 sm:pb-[72px] flex flex-col items-center text-center gap-[26px]">
        <Eyebrow tone="dark">Personal finance, kept properly</Eyebrow>
        <h1 className="m-0 max-w-[900px] text-[clamp(32px,6vw,58px)] leading-[1.07] font-semibold tracking-[-0.035em] text-balance">
          Other apps show you a number.
          {/* §6: the two-line break is a <br> and goes on narrow screens. */}
          <br className="hidden md:inline" /> Reckley lets you prove it.
        </h1>
        <p className="m-0 max-w-[620px] text-lg leading-7 text-[#a9b6c9] text-pretty">
          Every figure traces back to a line you entered, categorised and reconciled against your
          own statements. Nothing is guessed. Import twenty-plus years of Microsoft Money and carry
          on.
        </p>
        <div className="mt-1.5">
          <SignUpButton mode="modal">
            <button
              type="button"
              className="px-[26px] py-[13px] text-[15px] font-medium text-[#101826] bg-[#f1f3f7] rounded-md hover:bg-white transition-colors"
            >
              Create a free account
            </button>
          </SignUpButton>
        </div>
        <span className="text-[13px] text-[#7c8ba3]">
          Free to try while it is in development — a preview, not a free-for-life plan · no card ·
          your ledger exports in full whenever you want it
        </span>
      </section>

      {/* The four ethos cards — existing copy, kept (handover §1.3). */}
      <section aria-label="What Reckley stands for" className="px-6 sm:px-12 pb-[88px] max-w-[1240px] mx-auto">
        <div className={`grid sm:grid-cols-2 lg:grid-cols-4 gap-px ${DARK_HAIRLINE} bg-[#23304a] border rounded-[10px] overflow-hidden`}>
          {ETHOS.map(({ title, body }) => (
            <div key={title} className={`${DARK_CARD} p-[22px] pt-6 flex flex-col gap-[9px]`}>
              <h3 className="m-0 text-[15px] font-semibold">{title}</h3>
              <p className="m-0 text-[13.5px] leading-[21px] text-[#93a1b6]">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* §01 Reconciliation — white band. */}
      <section className="bg-white text-[#1a2332] px-6 sm:px-12 py-[88px]">
        <div className="max-w-[1160px] mx-auto grid lg:grid-cols-[420px_1fr] gap-10 lg:gap-14 items-start">
          <div className="flex flex-col gap-3.5 order-2 lg:order-1">
            <Eyebrow tone="light">01 · Reconciliation</Eyebrow>
            <h2 className="m-0 text-[34px] leading-10 font-semibold tracking-[-0.028em]">
              Agree with your statement, line by line
            </h2>
            <p className="m-0 text-[15.5px] leading-6 text-[#475569] text-pretty">
              Mark each transaction cleared, then reconciled, against the paper your bank sent you.
              When the difference reads zero, the balance on your screen is not an estimate — it is
              a figure two records agree on.
            </p>
            <p className="m-0 text-[15.5px] leading-6 text-[#475569] text-pretty">
              This is the part every modern app dropped. It is also the only reason to trust the
              number at the top of the page.
            </p>
            <div className="flex flex-col gap-[9px] mt-2 pt-[18px] border-t border-[#e2e6ed]">
              {RECONCILE_LEGEND.map(({ mark, text }) => (
                <div key={mark} className="flex gap-2.5 text-sm leading-[21px]">
                  <span className={`${MONO} text-[#94a3b8]`}>{mark}</span>
                  <span>{text}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2.5 order-1 lg:order-2">
            <div className="relative w-full aspect-[16/10] border border-[#e2e6ed] rounded-lg overflow-hidden bg-[#f8f9fb]">
              <img
                src="/landing/reconciliation.webp"
                alt="Reconciliation in light mode — a completed account with Difference £0.00"
                width={1562}
                height={967}
                loading="lazy"
                className="absolute inset-0 w-full h-full object-cover"
              />
            </div>
            <span className="text-[12.5px] text-[#64748b]">
              Reconciliation · the difference reads zero, so the account agrees
            </span>
          </div>
        </div>
      </section>

      {/* §02 The whole balance sheet — dark band, two captures. */}
      <section className={`px-6 sm:px-12 py-[88px] ${DARK_GROUND}`}>
        <div className="max-w-[1160px] mx-auto flex flex-col gap-11">
          <div className="flex flex-col gap-3 max-w-[640px]">
            <Eyebrow tone="dark">02 · The whole balance sheet</Eyebrow>
            <h2 className="m-0 text-[34px] leading-10 font-semibold tracking-[-0.028em]">
              Accounts a bank feed will never see
            </h2>
            <p className="m-0 text-[15.5px] leading-6 text-[#a9b6c9] text-pretty">
              Your net worth is not the sum of what an API can reach. Add the house, the pension,
              the car, the money a friend owes you — and hold investments at live prices beside
              them.
            </p>
          </div>
          <div className="grid lg:grid-cols-2 gap-7">
            <div className="flex flex-col gap-3.5">
              <div className={`relative w-full aspect-[16/11] border ${DARK_HAIRLINE} rounded-lg overflow-hidden ${DARK_CARD}`}>
                <img
                  src="/landing/accounts.webp"
                  alt="The Accounts page in dark mode — a banded list with group totals"
                  width={1561}
                  height={1040}
                  loading="lazy"
                  className="absolute inset-0 w-full h-full object-cover"
                />
              </div>
              <h3 className="m-0 text-[17px] font-semibold">Manual accounts, treated as first-class</h3>
              <p className="m-0 text-[14.5px] leading-[22px] text-[#93a1b6]">
                Grouped by what they are, totalled by what they mean. An account you type in
                yourself counts exactly as much as one that syncs.
              </p>
            </div>
            <div className="flex flex-col gap-3.5">
              <div className={`relative w-full aspect-[16/11] border ${DARK_HAIRLINE} rounded-lg overflow-hidden ${DARK_CARD}`}>
                {/* object-top: the 30 Aug re-captures include their page
                    headers, and a centred cover-crop in this 16:11 frame
                    took ~100px off the top — the portfolio's own title. The
                    crop now spends its 195px on the bottom rows instead. */}
                <img
                  src="/landing/investments.webp"
                  alt="Investments in dark mode — holdings with cost, value and the gain between them"
                  width={1563}
                  height={1268}
                  loading="lazy"
                  className="absolute inset-0 w-full h-full object-cover object-top"
                />
              </div>
              <h3 className="m-0 text-[17px] font-semibold">Investments held at cost and at value</h3>
              <p className="m-0 text-[14.5px] leading-[22px] text-[#93a1b6]">
                What you paid, what it is worth, and the gain between them — with the rate and the
                date it was priced at stated on the page.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* §03 Budgets — light band, image leads (§6: image first when stacked). */}
      <section className="bg-[#f8f9fb] text-[#1a2332] px-6 sm:px-12 py-[88px]">
        <div className="max-w-[1160px] mx-auto grid lg:grid-cols-[1fr_420px] gap-10 lg:gap-14 items-start">
          <div className="flex flex-col gap-2.5">
            <div className="relative w-full aspect-[16/10] border border-[#e2e6ed] rounded-lg overflow-hidden bg-white">
              <img
                src="/landing/budgets.webp"
                alt="Budgets in light mode — actual spending set against the plan"
                width={1179}
                height={1338}
                loading="lazy"
                className="absolute inset-0 w-full h-full object-cover object-top"
              />
            </div>
            <span className="text-[12.5px] text-[#64748b]">
              Budgets · plan, actual and the difference, on your own categories
            </span>
          </div>
          <div className="flex flex-col gap-3.5">
            <Eyebrow tone="light">03 · Budgets</Eyebrow>
            <h2 className="m-0 text-[34px] leading-10 font-semibold tracking-[-0.028em]">
              A budget built from what you actually spent
            </h2>
            <p className="m-0 text-[15.5px] leading-6 text-[#475569] text-pretty">
              Your own categories, your own last twelve months, and a plan set against them. Not a
              bank&rsquo;s guess at what &ldquo;groceries&rdquo; means in your life.
            </p>
            <p className="m-0 text-[15.5px] leading-6 text-[#475569] text-pretty">
              Where a figure excludes something — an uncategorised row, spending in another
              currency — the page says so rather than quietly rounding it away.
            </p>
          </div>
        </div>
      </section>

      {/* §04 Patterns and feeds — dark band. */}
      <section className={`px-6 sm:px-12 py-[88px] ${DARK_GROUND}`}>
        <div className="max-w-[1160px] mx-auto flex flex-col gap-11">
          <div className="flex flex-col gap-3 max-w-[640px]">
            <Eyebrow tone="dark">04 · Patterns and feeds</Eyebrow>
            <h2 className="m-0 text-[34px] leading-10 font-semibold tracking-[-0.028em]">
              What repeats, and what arrives on its own
            </h2>
          </div>
          <div className="grid lg:grid-cols-[1.4fr_1fr] gap-9 items-center">
            <div className={`relative w-full aspect-[16/10] border ${DARK_HAIRLINE} rounded-lg overflow-hidden ${DARK_CARD}`}>
              <img
                src="/landing/recurring.webp"
                alt="Recurring spend — what I'm committed to, with the monthly total"
                width={1513}
                height={1702}
                loading="lazy"
                className="absolute inset-0 w-full h-full object-cover object-top"
              />
            </div>
            <div className="flex flex-col gap-3">
              <h3 className="m-0 text-[21px] font-semibold tracking-[-0.02em]">
                Recurring spend, found and then confirmed by you
              </h3>
              <p className="m-0 text-[15px] leading-[23px] text-[#93a1b6]">
                Subscriptions and standing costs are detected from your history and proposed —
                never filed silently. Nothing joins your commitments until you say it belongs
                there.
              </p>
              <p className="m-0 text-[15px] leading-[23px] text-[#93a1b6]">
                Then it is a number you can look at once a year and act on.
              </p>
            </div>
          </div>

          {/* §7: this heading is the fallback the current capture can prove.
              When a stale-connection state is captured, the stronger one —
              "Bank feeds that tell you when they stop" — comes back. */}
          <div className="flex flex-col gap-5 pt-3">
            <div className="grid lg:grid-cols-2 gap-4 lg:gap-9 items-baseline">
              <h3 className="m-0 text-[21px] font-semibold tracking-[-0.02em]">
                Bank feeds, read-only and removable
              </h3>
              <p className="m-0 text-[15px] leading-[23px] text-[#93a1b6]">
                Connect a bank and its transactions arrive on their own, through an FCA-regulated
                provider that can only ever read. Remove a connection whenever you like — the
                transactions it brought in stay yours.
              </p>
            </div>
            <div className={`relative w-full aspect-[233/100] border ${DARK_HAIRLINE} rounded-lg overflow-hidden ${DARK_CARD}`}>
              <img
                src="/landing/open-banking.webp"
                alt="The Open Banking page — connected banks, sync status and controls"
                width={1588}
                height={682}
                loading="lazy"
                className="absolute inset-0 w-full h-full object-cover"
              />
            </div>
          </div>
        </div>
      </section>

      {/* §05 Import — white band with the format table. */}
      <section className="bg-white text-[#1a2332] px-6 sm:px-12 py-[76px] border-t border-[#e2e6ed]">
        <div className="max-w-[1160px] mx-auto grid lg:grid-cols-2 gap-10 lg:gap-14 items-center">
          <div className="flex flex-col gap-3.5">
            <Eyebrow tone="light">05 · Coming from somewhere else</Eyebrow>
            <h2 className="m-0 text-[34px] leading-10 font-semibold tracking-[-0.028em]">
              All your years of Microsoft Money, opened and kept
            </h2>
            <p className="m-0 text-[15.5px] leading-6 text-[#475569] text-pretty">
              Not a summary, not the last two years, not a CSV of what survived. Accounts,
              categories, splits, payees and reconciliation marks — the ledger you kept, still
              yours to keep.
            </p>
          </div>
          <div className="border border-[#e2e6ed] rounded-lg overflow-hidden">
            <div className="hidden md:grid grid-cols-[92px_1fr] px-[18px] py-3 bg-[#f1f3f7] text-[10.5px] tracking-[0.07em] uppercase text-[#64748b] border-b border-[#e2e6ed]">
              <span>Format</span>
              <span>What comes across</span>
            </div>
            {IMPORT_FORMATS.map(({ format, carries }, i) => (
              <div
                key={format}
                className={`grid md:grid-cols-[92px_1fr] gap-1 md:gap-0 px-[18px] py-[13px] text-[13.5px] items-baseline ${i < IMPORT_FORMATS.length - 1 ? 'border-b border-[#eef1f6]' : ''}`}
              >
                <span className={`${MONO} font-medium`}>{format}</span>
                <span className="text-[#475569]">{carries}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* §06 Your data — the audited section. Every sentence here was checked
          against the code on 30 Aug 2026; see the header comment for the two
          that changed under that check. */}
      <section className="bg-[#f8f9fb] text-[#1a2332] px-6 sm:px-12 py-[84px] border-t border-[#e2e6ed]">
        <div className="max-w-[1000px] mx-auto flex flex-col gap-7">
          <div className="flex flex-col gap-3 max-w-[660px]">
            <Eyebrow tone="light">06 · Your data</Eyebrow>
            <h2 className="m-0 text-[34px] leading-10 font-semibold tracking-[-0.028em]">
              Named parts, so you can check them yourself
            </h2>
            <p className="m-0 text-[15.5px] leading-6 text-[#475569] text-pretty">
              &ldquo;Bank-level security&rdquo; is a phrase, not a fact. Here is what actually
              handles what — every one of them a company you can look up, with a security page of
              its own.
            </p>
          </div>

          <div className="border border-[#e2e6ed] rounded-lg overflow-hidden bg-white">
            <div className="hidden md:grid grid-cols-[170px_1fr] px-5 py-[11px] bg-[#f1f3f7] border-b border-[#e2e6ed] text-[10.5px] tracking-[0.07em] uppercase text-[#64748b]">
              <span>Handled by</span>
              <span>What it does</span>
            </div>
            {VENDORS.map(({ name, role }, i) => (
              <div
                key={name}
                className={`grid md:grid-cols-[170px_1fr] gap-1 md:gap-0 px-5 py-3.5 text-sm items-baseline ${i < VENDORS.length - 1 ? 'border-b border-[#eef1f6]' : ''}`}
              >
                <span className="font-medium">{name}</span>
                <span className="text-[#475569]">{role}</span>
              </div>
            ))}
          </div>

          <div className="grid sm:grid-cols-3 gap-px bg-[#e2e6ed] border border-[#e2e6ed] rounded-lg overflow-hidden">
            {DATA_CARDS.map(({ title, body }) => (
              <div key={title} className="bg-white px-[22px] py-5 flex flex-col gap-[7px]">
                <h3 className="m-0 text-[14.5px] font-semibold">{title}</h3>
                <p className="m-0 text-[13.5px] leading-[21px] text-[#475569]">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* §07 Two ways to run it — do not soften (§7): every column admits a
          cost, Connected's included. */}
      <section className="bg-white text-[#1a2332] px-6 sm:px-12 py-[84px] border-t border-[#e2e6ed]">
        <div className="max-w-[1060px] mx-auto flex flex-col gap-[30px]">
          <div className="flex flex-col gap-3 max-w-[660px]">
            <Eyebrow tone="light">07 · Two ways to run it</Eyebrow>
            <h2 className="m-0 text-[34px] leading-10 font-semibold tracking-[-0.028em]">
              Connected, or entirely on your own machine
            </h2>
            <p className="m-0 text-[15.5px] leading-6 text-[#475569] text-pretty">
              Some people want their bank feeding straight in. Some want their finances on a hard
              drive they own, connected to nothing. Both are real products here, and the offline
              one is not a stripped demo.
            </p>
          </div>

          <div className="grid lg:grid-cols-2 gap-5">
            <div className="border border-[#e2e6ed] rounded-[10px] overflow-hidden flex flex-col">
              <div className="px-6 pt-[22px] pb-5 border-b border-[#eef1f6] flex flex-col gap-[7px]">
                <span className={`${MONO} text-[10.5px] tracking-[0.09em] uppercase text-[#64748b]`}>
                  Subscription
                </span>
                <h3 className="m-0 text-[21px] font-semibold tracking-[-0.02em]">Connected</h3>
                <p className="m-0 text-sm leading-[21px] text-[#475569]">
                  Desktop-first in the browser, with your ledger everywhere you sign in.
                </p>
              </div>
              <div className="flex flex-col">
                {CONNECTED_ROWS.map((row, i) => (
                  <EditionLine key={i} row={row} last={i === CONNECTED_ROWS.length - 1} />
                ))}
              </div>
            </div>

            <div className="border border-[#e2e6ed] rounded-[10px] overflow-hidden flex flex-col">
              <div className="px-6 pt-[22px] pb-5 border-b border-[#eef1f6] flex flex-col gap-[7px]">
                <span className={`${MONO} text-[10.5px] tracking-[0.09em] uppercase text-[#64748b]`}>
                  One-off fee · bought once, yours
                </span>
                <h3 className="m-0 text-[21px] font-semibold tracking-[-0.02em]">Standalone</h3>
                <p className="m-0 text-sm leading-[21px] text-[#475569]">
                  Downloaded, installed, and connected to nothing. The way you bought software
                  before software started renting itself to you.
                </p>
              </div>
              <div className="flex flex-col">
                {STANDALONE_ROWS.map((row, i) => (
                  <EditionLine key={i} row={row} last={i === STANDALONE_ROWS.length - 1} />
                ))}
              </div>
            </div>
          </div>

          <p className="m-0 text-sm leading-[22px] text-[#475569] max-w-[720px]">
            Neither edition is the lesser one. Standalone gives up automation to give you custody;
            Connected gives up custody to save you typing. Pick the trade you actually want.
          </p>
        </div>
      </section>

      {/* What this doesn't do — dark band; disqualifies the wrong visitor on
          purpose (§7: do not soften). */}
      <section className={`${DARK_GROUND} px-6 sm:px-12 py-[84px] border-t border-[#1e2838]`}>
        <div className="max-w-[900px] mx-auto flex flex-col gap-[26px]">
          <div className="flex flex-col gap-3">
            <Eyebrow tone="dark">Before you sign up</Eyebrow>
            <h2 className="m-0 text-[32px] leading-[38px] font-semibold tracking-[-0.028em]">
              What this doesn&rsquo;t do
            </h2>
            <p className="m-0 text-[15.5px] leading-6 text-[#a9b6c9] max-w-[640px] text-pretty">
              A product that insists every report states what it leaves out should be willing to do
              the same about itself.
            </p>
          </div>
          <div className={`grid sm:grid-cols-2 gap-px bg-[#23304a] border ${DARK_HAIRLINE} rounded-[10px] overflow-hidden`}>
            {LIMITS.map(({ title, body }) => (
              <div key={title} className={`${DARK_CARD} p-[22px] flex flex-col gap-[7px]`}>
                <h3 className="m-0 text-[15px] font-semibold">{title}</h3>
                <p className="m-0 text-[13.5px] leading-[21px] text-[#93a1b6]">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="bg-white text-[#1a2332] px-6 sm:px-12 py-[84px] text-center">
        <div className="max-w-[620px] mx-auto flex flex-col items-center gap-[18px]">
          <h2 className="m-0 text-[34px] leading-10 font-semibold tracking-[-0.028em] text-balance">
            Start with one account, or a Money file going back decades
          </h2>
          <p className="m-0 text-[15.5px] leading-6 text-[#475569] text-pretty">
            Add an account by hand in under a minute, or import your old ledger and carry on where
            you left off.
          </p>
          <div className="mt-1.5">
            <SignUpButton mode="modal">
              <button
                type="button"
                className="px-[26px] py-[13px] text-[15px] font-medium text-white bg-[#1a2332] rounded-md hover:bg-[#2d3a4d] transition-colors"
              >
                Create a free account
              </button>
            </SignUpButton>
          </div>
        </div>
      </section>

      <footer className={`${DARK_GROUND} px-6 sm:px-12 py-[30px] border-t border-[#1e2838]`}>
        <div className="max-w-[1160px] mx-auto flex items-center justify-between gap-6">
          <span className="text-[13px] text-[#7c8ba3]">© {year} Reckley</span>
          <nav aria-label="Legal" className="flex gap-5">
            <Link to="/privacy" className="text-[13px] text-[#93a1b6] hover:text-[#f1f3f7]">
              Privacy
            </Link>
            <Link to="/terms" className="text-[13px] text-[#93a1b6] hover:text-[#f1f3f7]">
              Terms
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
