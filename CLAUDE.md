# Engineering Bible – Reckley Web

**Owner**: Frontend/Platform (ChatGPT)  
**Branch**: `claude-lint-cleanup`  
**Updated**: 2026‑11‑02

---

## 1. Current State

| Check | Command | Status | Notes |
| --- | --- | --- | --- |
| Lint | `npm run lint` | ✅ | Zero warnings/errors |
| Strict types | `npm run typecheck:strict` | ✅ | TS 5.8 strict |
| Smoke tests | `npm run test:smoke` | ✅ | JSdom + Vitest |
| Realtime suite | `npm run test:realtime` | ✅ | Driven by `scripts/realtime-tests.json` |
| Coverage | `npm run test:coverage` | ✅ | Enforced floor ≥75 % statements / ≥80 % branches |
| Threshold | `node scripts/verify-coverage-threshold.mjs …` | ✅ | ≥75 % statements / ≥80 % branches (raised 2026-08-12 from 63/55; measured 77.13/82.48) |
| Supabase smoke | `npm run test:supabase-smoke` | ✅ | Logs saved to `logs/supabase-smoke/` |
| Build parity | `npm run build` | ✅ | Mirrors Vercel’s `vite build` via `scripts/build-web.mjs` |
| Desktop bundle | `npm run desktop:verify` | ✅ | Builds `src/desktop` → `apps/desktop/dist`, then PHASE3-PLAN §5’s two bundle greps **plus the one that is about weight rather than the cloud** (`xlsx`, 1 Sep 2026), then the size ratchet, then the mount run. REFUSES rather than skips when there is no build |
| Desktop size | `npm run bundle:check:desktop` | ✅ | 3,872.6 KiB raw / 1,191.0 KiB gz; budgets 3911 / 1203 KiB. **Raw** is the gate — nothing is downloaded, the bytes are embedded in the binary. Binary size recorded, never gated. Budgets sit ~1 % above measured, which is tight ON PURPOSE: the big move was DOWN (−498.6 KiB raw, the spreadsheet writer, owner's ruling 1 Sep 2026 — "lose excel is fine as long as they can keep csv"), and leaving 4320 would have banked the win as silent permission. The last six moves were UP (5–7 Nov): +3.6 KiB for the budget cycle model, re-recorded with the +37.5 KiB that had drifted in unrecorded since 14 Oct — the second such re-recording, and the drift had left 2 KiB of headroom — then +5.8 KiB for the wizard's "Run these budgets from" and the editor's "Starts", then +2.8 KiB for the wizard's "Months I choose" guide window, then +2.1 KiB for the editor's "Ends" and the One-off period, then +3.9 KiB (7 Nov) for the Dashboard's "Key Budgets" cog, then +2.5 KiB for the editor's "Every…" interval. The next intended growth raises these two numbers in the commit that causes it; the header of `scripts/desktop-bundle-size.mjs` narrates every step. |
| Desktop shell | `npm run desktop:check` | ✅ | clippy `-D warnings` + the shell crate's own 39 tests (`apps/desktop/src-tauri`). Was 12; licensing brought 26 — the offline verifier, the clock's high-water mark, the read allowlist held to the crate's own enum by asking serde to recite it, and a real ledger proving that an expired window is refused a write BY NAME while a read and the export both still answer |
| Desktop build | `npm run desktop:build` | ✅ | `vite` → `apps/desktop/dist`, then `cargo build --release` → ~20 MB arm64 (was 16.1 MB; the 0.1.1 updater brings an HTTP/TLS stack with it). The renderer must be built first: `generate_context!` embeds it. Since 0.1.1 a release build also emits `Reckley.app.tar.gz` + `.sig` — what an INSTALLED copy downloads, which is not the installer |

### The local edition's lanes

Node **22+** (they open ledger files with `node:sqlite`), and a release bridge
binary: `cargo build --manifest-path crates/Cargo.toml --features cli --release`.
Every one of them refuses to run without what it needs rather than skipping.

| Check | Command | Status | Notes |
| --- | --- | --- | --- |
| Ledger core | `cargo test --manifest-path crates/Cargo.toml --all-features` | ✅ | 533 tests, 26 suites. The money lints (`unwrap_used`, `panic`, `float_arithmetic`, …) are `deny` in `Cargo.toml`; clippy is what enforces them |
| Contract | `npm run test:local-contract` | ✅ | 146 checks, 5 files — the real crate against real SQLite files through `DataPort` |
| Admission | `npm run test:local-admission` | ✅ | 109 specs: the shipping TypeScript against the Rust port of it |
| Constraint parity | `npm run test:local-sqlite` | ✅ | 67 specs, 16 declared divergences. **Needs `bash scripts/local-db/up.sh`** |
| Verb parity | `npm run test:local-verbs` | ✅ | 507 specs, 29 declared divergences, 26 single-engine. Same cluster |

**Where they run.** The desktop renderer trio, the Rust core suites, contract
and admission are on **every PR**. The two differential lanes and
`desktop:check`/`desktop:build` are **nightly** — the first pair needs a
PostgreSQL cluster with the migration history applied, the second needs
webkit2gtk and 262 CPU-seconds to link 454 crates. The split is by cost, never
by importance; `docs/edition-gating.md` argues it out, and
`src/desktop/__tests__/desktopIsGated.test.ts` fails if a step is dropped from
either workflow.

⚠️ **A type error in `src/desktop` fails none of the desktop commands.** Vite hands
TypeScript to esbuild, which strips types without reading them — measured,
`desktop:ui` exits 0 on a renderer that does not typecheck. Only
`typecheck:strict` catches it, through the root `tsconfig.json`'s reference to
`tsconfig.desktop.json`.

⚠️ **Vercel type-checks `api/` with `strict: false`, and only reports.** `@vercel/node` reads the
root `tsconfig.json`, which has no `compilerOptions`, so its `fixConfig()` forces NodeNext and
`strict: false`. Errors print red in the build log and the deploy goes ahead anyway, so code that
is sound under `typecheck:strict` can still be flagged there: #605 was `reduce` picking another
overload without `strictFunctionTypes`, red in every production build since 21 Oct. A red line in a
production build log is never "normal" — read it.

Latest Vercel preview: `wealthtracker-l514dsq11` (2025‑10‑29 21:33 UTC). Build chunk warnings (Plotly/XLSX) tracked in `docs/bundle-optimization-plan.md`.

---

## 2. Guardrails & Tooling

### Quality Gates
1. **Lint** → **Strict TS** → **Smoke** → **Realtime Suite** → **Coverage** → **Coverage Threshold** → **Bundle Check** → **Build** (see `.github/workflows/handoff-snapshot.yml`, job `quality-gates`).
   Two more jobs run beside it on every PR: **`desktop-renderer`** (build, cloud greps, size ratchet) and **`local-core`** (clippy, 468 Rust tests, contract, admission). The environment-heavy lanes are nightly in `.github/workflows/local-edition-nightly.yml`.
2. `scripts/realtime-tests.json` enumerates every deterministic/timer-heavy service test. `npm run test:realtime` calls `scripts/run-realtime-suite.mjs` so adding coverage is a manifest edit.
3. Coverage enforcement runs through `scripts/verify-coverage-threshold.mjs` (loads `coverage/coverage-final.json`, merges shards automatically).

### Supabase
- `scripts/run-supabase-smoke.mjs` discovers `supabase` tests, loads `.env.test.local`, and writes timestamped logs to `logs/supabase-smoke/<ISO>_supabase-smoke.log` plus `latest.log`. Nightly GitHub workflow uploads the log artifact for auditing.
- Schema + migrations live under `supabase/`. Use `npm run db:migration:new`, `db:migrate`, `db:diff`, `db:lint`, `db:reset` with `SUPABASE_DB_URL`.
- CI secrets required: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`.
- ⚠️ **Never prefix a service-role key with `VITE_`.** Vite inlines every `VITE_*` var into the
  public browser bundle at build time; a `VITE_SUPABASE_SERVICE_ROLE_KEY` leaked the master key
  into `dist/` in June 2026. The server/CI name is `SUPABASE_SERVICE_ROLE_KEY` (no prefix) — that
  is the GitHub Actions secret and the only name `api/_lib/supabase.ts` accepts.

### Vercel environment
- ⚠️ **`ENCRYPTION_KEY` is never rotated by pasting a new value.** It is the single AES‑256‑GCM
  key the stored bank tokens are encrypted with (`api/_lib/encryption.ts`): no key id, no
  re‑encryption path. A new value leaves every stored token undecryptable and every bank needing
  reconnection — and a decrypt failure is itself a reauth fact, so the first sync after a wrong
  value marks each bank it touches. It has been a Secret (Production and Preview) since 2 Nov, same
  value; **the only readable copy is in the owner's password manager.** Vercel cannot make a
  Secret for Development, so it split off a readable Development copy of the production key;
  that copy was deleted.
- **Readable secrets are flagged "Needs Attention"**, Vercel's prompt since its April 2026 incident
  (readable variables were exposed; the owner received no notice). **All cleared, 29 Oct – 2 Nov:**
  - The eight leftovers of the old Supabase marketplace link (`POSTGRES_*` ×4,
    `SUPABASE_JWT_SECRET`, `SUPABASE_SECRET_KEY`, the two publishable‑key copies) were deleted — no
    code read them. Their values (the database password, the JWT secret) were **not** rotated.
  - `TWELVE_DATA_API_KEY`: same value, now a Secret. Twelve Data's dashboard has one key and no
    regenerate. Proven by its credit counter rising on a US quote — a price on screen proves
    nothing, because quotes and symbol search both fall back to Yahoo.
  - Pre‑production `CLERK_SECRET_KEY`: the value in Vercel was an old `sk_test_` key that Clerk's
    development instance no longer had, so it was already dead; replaced by a new development key,
    "Vercel preview". Production's key was never involved.
  - `TRUELAYER_CLIENT_SECRET`: a genuinely new secret, with no gap. TrueLayer holds up to six at
    once, so: add one, put it in Vercel, redeploy, prove it with a bank re‑consent (the code
    exchange uses the secret), then delete the old ones. Since #608 a wrong or missing secret is a
    reported failed sync, not every bank marked for re‑linking — before it, this rotation had to
    be timed against the :07 hourly sync.
  - `ENCRYPTION_KEY`: same value, Secret (above).
- **Public values stay Config.** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `BANKING_ALLOWED_ORIGINS` and `TRUELAYER_REDIRECT_URI` are in the bundle or on the wire anyway,
  and a Secret cannot be read back to check. `CLERK_AUTHORIZED_PARTIES` is a Secret, which is
  why a 28 Oct reading of it came back "EMPTY": a write‑only value reads blank.

### Editions
- Shared UI imports the data layer as **`@data`**, never by path. The specifier is what
  chooses the engine: `services/port/index.ts` (DataService) in the web build,
  `services/local/deviceDataPort.ts` (the open ledger file) in a desktop window.
  `eslint.config.js` enforces it; `docs/edition-gating.md` explains the whole mechanism.
- A desktop-reachable module may not import Supabase, Clerk, Sentry, Stripe, the banking
  service or the web's choosing line. Checked at three altitudes: lint, two import-graph
  walks, and the bundle greps.
- The renderer also has a **size** ratchet, because growth that is perfectly cloud-free
  passes all three of those. 3,872.6 KiB raw today, budget 3911 — ~1 % of headroom,
  because the last move was a deliberate 498.6 KiB DOWN and that slack was spent
  rather than banked. Intended growth raises the budget in the commit that causes it.
- A seam may also be about **weight** rather than the cloud. `@spreadsheet` is the
  first: the desktop edition writes CSV and PDF and no .xlsx (owner, 1 Sep 2026), and
  the same import that decides what is BUILT decides what is DRAWN, so the button and
  the bundle cannot disagree.
- `src/desktop/routes.ts` must have an answer for every `path=` in `src/App.tsx`. Adding a
  route to the web router without one fails `desktopRouter.test.tsx`.

### Collaboration Rules
- Keep selectors stable for dashboard/import journeys; log multi-file UI refactors in the latest regression audit doc.
- No schema/service contract changes without Supabase smoke updates or feature flags.
- Husky + CI hooks may not be bypassed. If an emergency hotfix requires it, run the full gate locally immediately afterwards.

---

## 3. Focus Forward

| Area | Owner | Description |
| --- | --- | --- |
| **Mobile** | Frontend | The August 13th sweep fixed the status-bar overlap, the floating button's overlap, Settings, onboarding and the count colours — but the phone is where the last three days' bugs came from, and it is still the least-tested surface. Test there first. |
| **Supabase coverage** | BE + Platform | Continue monitoring nightly Supabase smoke logs; add RLS/import edge cases as regressions appear. |
| **PITR — a LAUNCH GATE, not a todo** | Platform | Point‑in‑time recovery is **off by decision** (owner, 2026‑10‑08): it was enabled, costed at ~$100/mo for the 7‑day window, and switched back off because the database today holds the owner's, Danielle's and a test account's money, bank‑feed rows re‑import on the next sync, and launch is months out. Daily backups (Pro, 7 days, included) are the cover until then. **It goes on the day before the first external user's money goes in** — Add‑ons → Point in time recovery → Enable → 7 days. Compute is already Small (the PITR minimum), so it is one click. Nothing in CI can check this; it is a human gate. |
| **Rename — phases 6 and 7** | Platform + owner | Phases 1–4 shipped (see below). **Phase 6 is the domain and identity move, in this order — each step is safe before the next and none is safe after it:** **(a) DONE 14 Oct** — `www.reckley.co.uk` serves the same deployment (GoDaddy A `@` → 216.150.1.1/216.150.16.1, CNAME `www` → Vercel's per‑project host; apex 308 → www; Let's Encrypt via Vercel), both CSPs admit `clerk.reckley.co.uk` beside the old Clerk host (`connectSrcCoversFetchOrigins.test.ts` holds both), `App.entitlements` claims both `www` hosts, and `capacitor.config.ts` `allowNavigation` lists the new host so installed builds survive cutover. **(b) DONE 14 Oct** — Vercel env, Production: `CLERK_AUTHORIZED_PARTIES` and `BANKING_ALLOWED_ORIGINS` each hold both `www` hosts, redeployed (a stale `AUTHORIZED_PARTIES` 401s every API route while Clerk shows green). `BANKING_ALLOWED_ORIGINS` did not exist in Production until that day — see the Stripe section. Measured: a CORS preflight from either host gets 200 and its own origin back, a foreign origin gets 403. **(c) DONE 26–28 Oct** — Clerk production domain → `reckley.co.uk` (five CNAMEs at GoDaddy, Clerk verified + SSL), Supabase trusts `clerk.reckley.co.uk` (it fetches the JWKS live, so the trust could only be added AFTER the DNS resolved — the other order fails), the new `pk_live` in Vercel Production, all three social providers accept the new callback (Google by the owner; Apple's Services ID and its relay‑mail source driven through the Apple Developer console on 28 Oct — no relay source had EVER been registered; **Microsoft REPLACED on 28 Oct**: the account that owned the original Entra registration could not be found, so a new app "Reckley" was registered under `contact@reckley.co.uk` (Microsoft 365 from GoDaddy), Web platform, client ID `0efea7d9-a6c4-4e21-b487-fe4d7c3c880a`, and proven by a sign‑up through it — **its client secret expires 27 Oct 2028**: before then, a new secret in Entra → Clerk → SSO connections → Microsoft, or Microsoft sign‑in stops), the Claude connector re‑consented on the new host (Clerk Logs show it; the OAuth‑applications list does not change for a CIMD client). **(d) Cutover DONE 28 Oct**, two days early because the phone forced it: the iOS shell still loaded the old host, Clerk's session cookie had moved to the new site, and WebKit drops a third‑party cookie — "Authenticating…" forever. `vercel.json` now 308s the old `www` host to the new one (exempting `/.well-known`, which Apple fetches without following redirects), `server.url` is the new host for the next build, and the old Clerk host is out of both CSPs. Build 5 carried `allowNavigation` for the new host, so the installed copy follows the redirect in‑app. **(e) Tidy‑up DONE 28–29 Oct**, each measured: `CLERK_AUTHORIZED_PARTIES` = `https://www.reckley.co.uk` (Production, redeployed; the bank list then loaded and synced through the API — the 28 Oct "EMPTY" reading was the write‑only Secret reading back blank; Vercel showed it last updated 14 Oct, the day (b) set both hosts); `BANKING_ALLOWED_ORIGINS` = the new host alone (preflight: reckley 200, the old host 403, a foreign origin 403); `TRUELAYER_REDIRECT_URI` = `https://www.reckley.co.uk/auth/callback` (all environments), with TrueLayer's Live console holding only that in place of `wealthtracker-web.vercel.app/auth/callback`, proven by a Revolut re‑consent landing back in the app; the old Clerk host out of all three provider consoles (Google answers `redirect_uri_mismatch` and Apple "Invalid web redirect url" for it, both still accept the new one); and the five old Clerk CNAMEs deleted from `wealthtrackerpro.co.uk`'s Vercel DNS on 29 Oct. **The move is now final — there is no revert path**, and nothing on the old domain points at Clerk. **Build 6 uploaded 29 Oct** (from `ad0e2d4`, released Xcode 27.1; the synced `capacitor.config.json` names the new host, and the signed app carries both `webcredentials` hosts), so the phone stops riding the redirect once it is installed from TestFlight; Apple's beta review approved it for Danielle's External Group the same day. Then **Stripe — a go‑live, not a rename; its sequence is its own section below**, and the GitHub repo rename **with the desktop updater's `latest.json` redirect verified against the installed copy on the owner's Mac before anything is announced**. **Phase 7 DONE 4 Nov**: storage generation 2 in `lib/storageMigration.ts` deletes the old `wealthtracker_*` copies — only behind a present copy under the new name, so a copy that never landed keeps its old key; a device that skipped generation 1 copies and deletes in one boot; a delete that fails withholds the watermark like a copy that fails. Never the legacy backup tags — files are not on our release schedule. The old-prefix literals that remain are the migration table itself and the storage adapter's two prefix predicates, which merely find nothing now. |

### The rename: phases 1–4 DONE (2026‑10‑09)

WealthTracker is **Reckley** everywhere a person can see it, and the storage
underneath moved first so the words could follow safely:

- **Phases 1–2 (#580).** Every brand‑carrying browser key moved to the neutral
  `ledger_*` prefix via `lib/storageMigration.ts` — copy‑not‑move, envelopes
  verbatim, awaited before first render — and the backup readers accept every
  tag ever written. (Phase 7, 4 Nov, deleted the old copies: see the table row.) `src/brand.ts` holds the prefix and the reasons it is not
  the brand. `money_management_*` (a wire format in the cloud preferences
  document and in backup files) and `wt_*` (the encryption key lives there)
  stay, on purpose.
- **Phase 3** collapsed to a day: three known users each opened the app once.
- **Phase 4** was one sweep over 144 files plus the backup writer
  (`reckley-backup-v2`). **What stays, by the owner's ruling that an identifier
  nobody sees is not worth its migration:** `com.wealthtracker.desktop` and
  `com.wealthtracker.mobile` (registered with the OS and TestFlight; the mobile
  one is permanent), the PWA manifest `id`, `WealthTrackerDB`, the legacy
  `wealthtracker_*` literals in the migration table, the `wealth-core` crate
  (descriptive, not brand), the owner's on‑disk paths
  (`~/Documents/WealthTracker-signing/`, `WealthTracker-Backups/`) and the
  `WEALTHTRACKER_*` env knobs, and — until phase 6 — every host string and the
  GitHub repo path in the updater endpoint. The sweep protected each of these
  by name; `git log -p` on the phase‑4 commit shows the exact regex.

### Identity: the mark is outlined and placed (2026‑10‑14)

Claude Design's handover (16 Sep, mark **2a**: a capital R in IBM Plex Sans 600
ruled off with a double underline) is built. **`node scripts/brand/build-identity.mjs`
is the only way any logo file changes** — it outlines the glyphs from the
committed font (`scripts/brand/`, OFL) and writes every SVG, PNG and ICO, the
iOS icon and splash (light and dark), the desktop master, the boot splash
inside `index.html`, and `design-system/brandIdentity.ts`. Then
`npm run tauri --prefix apps/desktop -- icon app-icon.png` for the desktop set.
`brandIdentity.test.ts` reruns it with `--check`, so a hand-edited asset fails CI.

- **In the app:** `<ReckleyLockup>` (one colour — `currentColor` — two rules,
  never under 96px, named "Reckley" as text for headings and tests). Top bar,
  mobile bar and menu, landing header: horizontal. Sign-in and the desktop's
  two entry screens: stacked. Every PDF page: horizontal, navy, footer left, as
  vector paths (`utils/pdfBrand.ts`) — no PDF reader has Plex.
- **Decided where the handover was silent, and recorded in the generator's
  header:** ink centred on x=24 (the text anchor put it at 25.26); the word set
  at the mark's own size on its baseline; gaps measured ink to ink with "mark
  height" = the 48 box; lockups cropped to ink + one rule stroke; tiles centre
  the ink; the .ico and favicon.svg snapped to whole pixels.
- **Two deliberate departures.** §5 drew the signed‑out landing header navy on
  white; the landing has been on a dark ground since August, so its lockup is
  light. And §5's "21px" mark in the header is read as the visible mark: at a
  21px *box* the lockup is 74px wide, under §4's own 96px minimum.
- **Not in the repo:** `Reckley Identity.dc.html`, the full spec the handover
  cites. If its lockup proportions differ from the decisions above, they are
  constants at the top of the generator — change, rerun, commit.
- **Reaches people only when shipped:** the iOS icon and splash need a new
  TestFlight build; the desktop icon needs a desktop release.

### Stripe: a go‑live, not a rename (2026‑10‑12)

Stripe has never taken a real payment. The owner has never run a transaction,
and the sandbox he opened on 10 Oct was empty — so the "rename the Stripe
products" step this table carried for three days was a step for products that
do not exist. Vercel holds **no Stripe variable at all**: the Production and
Preview build logs both list all four as unset (measured 14 Oct; until then
this paragraph said Vercel held "test keys only" — those are in the Stripe
dashboard). What was measured, not assumed:

- **The production bundle carries no Stripe publishable key, and needs none.**
  The one `pk_live_…` in the served JS is **Clerk's** (what follows the prefix
  is base64 of `clerk.`; a Stripe key continues `pk_live_51`). All 183 chunks
  were grepped. `services/stripeService.ts` reads `import.meta.env` as a whole
  object and the production build inlines `{}` for it, so
  `VITE_STRIPE_PUBLISHABLE_KEY` could not reach the browser even if it were
  set; and nothing outside the service calls `getStripe()`. Checkout is
  `window.location.href = session.url` to Stripe‑hosted Checkout, and the
  billing portal has the same shape. **The three `VITE_STRIPE_*` variables are
  dead wherever they exist** (`.env.example` and the startup env check stopped asking for one on 29 Oct).
- **The live integration is four server variables**:
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PREMIUM_MONTHLY`,
  `STRIPE_PRICE_PRO_MONTHLY`. The code is mode‑agnostic. Going live is
  configuration, not a change to the repo.
- **The build judges them as a set (14 Oct), with the allow‑list below.**
  `scripts/verify-server-env.mjs`: no `STRIPE_SECRET_KEY` builds anywhere with
  one warning — that is today. A `STRIPE_SECRET_KEY` in a **production** build
  fails it unless the webhook secret (`whsec_`), both price ids (`price_` — a
  pasted `prod_` is the mistake this catches) and a well‑formed allow‑list are
  all there, test key or live. Elsewhere the same findings only warn, plus one
  for a live key in a preview. Values are never printed. It also refuses any
  `VITE_` variable holding a Stripe secret, under any name.
  `src/test/serverEnvPreflight.test.ts` runs the script as Vercel does. (From
  12 to 14 Oct this line said the build already "refused" without the four; it
  only ever warned.)
- **A fifth variable it cannot go live without.** `BANKING_ALLOWED_ORIGINS`
  is the allow‑list `isRedirectUrlAllowed` holds Checkout's and the portal's
  return URLs to, and it was **absent in
  Production** until 14 Oct — the only origin trusted was `VERCEL_URL`, the
  deployment's own hash host, so the first live Checkout would have answered
  `400 Invalid redirect URLs` (`api/subscriptions/create-checkout.ts`).
  Created that day with both `www` hosts. `cors.ts` compares each entry to the
  browser's `Origin` header exactly, so the guard requires each to be a bare
  `https` origin — a trailing slash, a path or a capital never matches.
- **A sandbox is a copy, not a view.** Settings are snapshotted into it at
  creation and nothing edited inside it reaches the live account — the business
  name changed on 10 Oct renamed the sandbox. Leave it (account picker, top
  left) before touching anything that matters.

**The sequence**, after `www.reckley.co.uk` is live — the webhook URL and the
redirect‑origin allow‑list in `api/_lib/cors.ts` both depend on the host:

1. **Live account, outside the sandbox.** Business name Reckley, support email
   and URL at the new domain, statement descriptor `RECKLEY` (Settings →
   Business details; 5–22 Latin characters, shortened prefix 2–10, must reflect
   the trading name). Activation complete — payout bank account, identity —
   which takes days, so it starts first.
2. **Live product catalogue.** Two products with recurring GBP monthly prices
   matching the catalogue in `services/stripeService.ts`: **Reckley Premium
   £7.99**, **Reckley Pro £15.99**. The app's plan names and prices come from
   that file; Stripe's product name appears only on hosted Checkout, receipts
   and invoices, and the Customer Portal. Copy the two `price_…` IDs.
3. **Live Customer Portal configuration** (Settings → Billing → Customer
   portal), saved once. `api/billing/portal.ts` creates portal sessions with no
   explicit configuration, which fails until a live default exists.
4. **Live webhook** at `https://www.reckley.co.uk/api/stripe/webhook`, with
   exactly the five events `api/stripe/webhook.ts` handles:
   `checkout.session.completed`, `customer.subscription.created`, `.updated`,
   `.deleted`, `invoice.payment_failed`. Copy the signing secret.
5. **Vercel, Production scope only.** The four variables above → live values,
   then redeploy. A production build holding the key without the rest now
   fails, naming each gap, so a half‑finished step 5 stops at the build and
   the deployment already live keeps serving. Never a `VITE_` prefix on any of
   them (the build refuses that too).
6. **First transaction — sandbox before live.** Preview holds no Stripe
   variable today, so this starts by putting the sandbox's test key, webhook
   secret and price ids into the **Preview** scope. Preview has no
   `BANKING_ALLOWED_ORIGINS` either, so open the preview at its own deployment
   URL (the host `VERCEL_URL` names), not the branch alias — only that host is
   a trusted return URL there. No deployment protection is on, so the
   sandbox's webhook can reach it. One full loop
   with a test card: Checkout → webhook received (every delivery is
   a `subscription_logs` row, inserted before handling and marked `processed`
   after, so there is a row to look at, not a feeling) → the subscription row →
   the app shows Premium. Then the first live charge is the owner's own card,
   refunded straight after.

### Supabase org transfer: DONE (2026‑10‑08)

Production (`nqbacrjjgdjabygqtcah`, eu‑west‑2 London) now lives in the
Supabase‑managed **Reckley** org (Pro), transferred out of the
Vercel‑Marketplace‑managed org — ref, URL, keys, data and migration history all
unchanged, no downtime. `wealthtracker-scratch` (a July rehearsal copy in
Frankfurt, idle since 23 Jul, no migration history, nothing referenced it) was
deleted rather than moved; the old Vercel org is empty. Compute went Nano → Small
at the same time (+$5.15/mo net of the Pro credit; Nano was billed at Micro's
rate, so the "upgrade" was mostly paying for what we already had). Two things
that follow from the move:

- **Any tool authorised against the old org is now blind.** The Supabase
  connector/MCP was granted on "Steven Green's projects" and sees nothing;
  re‑authorise it against Reckley before the next database task.
- **The marketplace link to Vercel is gone, and that is intended.** Do NOT
  install the Vercel integration on Reckley: the three env vars the app reads
  (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`)
  are set by hand in Vercel and the project URL did not change.

### Clerk production instance: DONE (2026‑08‑26), and the doc trap it left

This table listed Clerk production as "the highest‑value unblocking task in the
repo" for a month after it shipped, and the stale row cost a planning day on
29 Aug and misled again on 16 Sep. It is **live**: `pk_live_…` in the served
production bundle (re‑verified 2026‑09‑16), all three social providers on our
own credentials, the Supabase JWT bridge on the production instance.
`docs/clerk-production-runbook.md` is now the record of what exists — read its
"traps that remain true" (dev keys still in `.env.local` on the Mac; dev→prod
users need a `clerk_id` repoint; `AUTHORIZED_PARTIES`) before touching auth.

### The design pass is closed

Six batches plus batch 7, three rulings on cause, and the mobile audit all
shipped between 2026‑08‑12 and 08‑13, in conversation with an external design
reviewer. The rulings themselves are recorded where the code they govern lives,
not in a document — grep a component's header comment before re-litigating its
colour, its chrome or its focus ring. Four principles carry the rest:

- **A total is earned by a question**, not by the availability of numbers.
- **Colour marks what needs attention.** A zero, a count and a settled row need
  none. Motion is the same demand as colour and answers to the same rule.
- **One focus ring, app-wide.** Components declare none; the global
  `*:focus-visible` outline is it. Overriding `--focus-ring-color` in scope is
  how a control asks for a different colour.
- **Say the consequence, then the remedy** — and a filtered-empty state is not
  an empty one. Naming the hidden count and the filter responsible is what stops
  an app faking "your money is gone".

Guards exist for the things that failed silently: `semantic-contrast.test.ts`
(measures, never remembers), `tokenOpacity.test.ts` (a token that stops emitting
CSS), `oneFocusRing.test.tsx`. All three were proven non-vacuous by breaking
what they watch.

Everything else (lint/type safety/tests/build) is green.

---

## 4. Reference Commands

```bash
# Quality gates
npm run lint
npm run typecheck:strict
npm run test:smoke
npm run test:realtime
npm run test:coverage
node scripts/verify-coverage-threshold.mjs coverage/coverage-final.json --statements=75 --branches=80

# Supabase smoke (requires real creds)
RUN_SUPABASE_REAL_TESTS=true npm run test:supabase-smoke

# Deploy parity
npm run build

# The local edition (Node 22+)
cargo build --manifest-path crates/Cargo.toml --features cli --release
cargo test  --manifest-path crates/Cargo.toml --all-features
npm run test:local-contract
npm run test:local-admission
npm run desktop:verify

# …and the two that need the throwaway Postgres
bash scripts/local-db/up.sh
npm run test:local-sqlite
npm run test:local-verbs
bash scripts/local-db/down.sh
```

---

## 5. Useful Paths

- `scripts/realtime-tests.json` – manifest for deterministic suites.
- `scripts/run-realtime-suite.mjs` – Vitest runner (reads manifest).
- `logs/supabase-smoke/` – timestamped nightly smoke logs.
- `docs/development-workflow.md` – environment setup & guardrails.
- `docs/regression-audit-*.md` – latest dashboard/import regression runs.
- `docs/edition-gating.md` – how one source tree makes two editions, and which gate runs where.
- `scripts/local-db/` – the throwaway Postgres the differential lanes need (`up`/`test`/`down`, `pgbin.sh`).
- `scripts/local-sqlite/README.md` – the three differential lanes and every declared divergence.
- `apps/desktop/README.md` – the shell, what is verified in it and what needs a GUI session.

Update this file whenever guardrails, workflows, or focus areas change.
