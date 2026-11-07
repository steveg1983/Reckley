#!/usr/bin/env node

/**
 * THE DESKTOP RENDERER'S SIZE RATCHET.
 *
 *   npm run bundle:check:desktop     (build first: npm run desktop:ui)
 *
 * `scripts/bundle-size-check.mjs` does this for the web build. This is the same
 * instrument with the same shape — budgets as constants, a measured baseline
 * recorded beside them, an env override for experiments, non-zero exit when a
 * budget is passed — pointed at `apps/desktop/dist` and answering to different
 * numbers, for a different reason.
 *
 * ── WHY RAW BYTES ARE THE GATE HERE, AND GZIP IS NOT THE HEADLINE ───────────
 *
 * The web gate measures gzip because gzip is what a browser downloads: it is
 * the number a person waits for. NOTHING IS DOWNLOADED HERE. `tauri.conf.json`
 * names `apps/desktop/dist` as `frontendDist` and `tauri::generate_context!`
 * embeds those files into the binary at compile time, so the bytes this build
 * emits are bytes on the user's disk and bytes the WebView parses when the
 * window opens. Compression never enters it.
 *
 * So RAW is the number with a consequence and it is the one that fails a build.
 * Gzip is measured and budgeted anyway, two reasons: `apps/desktop/README.md`
 * has been quoting a gzip figure since slice 29 and a quoted number nobody runs
 * is a number that decays, and it is the only figure directly comparable with
 * the web bundle's — the two editions ship the same components eventually, and
 * the day that comparison matters it should not have to be re-derived.
 *
 * ── WHAT THIS IS ACTUALLY GUARDING AGAINST, AND WHAT IT HAS ALREADY SEEN ────
 *
 * One specific future event, and it happened one slice after this file was
 * written. Slice 30's note said:
 *
 * > The renderer is 259 KiB today because it mounts a chooser and a ledger
 * > screen. … When the app's screens are mounted in the window — the next
 * > programme of work — they arrive through that graph, and they arrive all at
 * > once.
 *
 * They did. The mount slice's second half took the renderer from 259.3 KiB to
 * **3,273.1 KiB raw** — 12.6x — in one commit, and every byte of it was
 * intended. That is exactly the event this file exists to make somebody look at
 * rather than discover, and looking at it is what produced the note below.
 *
 * `desktop:greps` catches the part of an arrival which is a broken promise (a
 * Supabase client, browser storage, Clerk). It cannot catch the part which is
 * merely enormous: a renderer that doubled in size while staying perfectly
 * cloud-free passes every other check in this repository.
 *
 * ── IT REFUSES RATHER THAN SKIPS ────────────────────────────────────────────
 *
 * No build, no answer, non-zero exit — the same ruling `desktop:greps` and the
 * local contract suite already carry (R-8). A size gate that passes because it
 * measured an empty directory is a gate that reports green on a failed build.
 *
 * ── THE BINARY IS RECORDED AND NEVER GATED ──────────────────────────────────
 *
 * The 16 MB figure in `apps/desktop/README.md` was measured by hand once. This
 * prints it when there is a binary to read, so it stops being a claim. It is
 * NOT a budget, and must not become one here, because its size is a function of
 * the toolchain, the platform and the profile: CI's Linux binary and a
 * developer's arm64 macOS binary are different artefacts and neither is the
 * other's regression. A binary budget belongs to a release job that builds one
 * target, not to a check that runs wherever it is run.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(REPO, 'apps', 'desktop', 'dist');
const BINARY = path.join(REPO, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'reckley-desktop');

/**
 * BASELINE, re-measured 2026-08-12 at the mount slice's second half, on
 * `npm run desktop:ui`. 101 files; the ten that matter:
 *
 *   xlsx-*.js                     488.0 KiB raw   158.9 KiB gzip
 *   jspdf.es.min-*.js             377.0 KiB       123.1 KiB
 *   MountedLedger-*.js            306.3 KiB        90.9 KiB
 *   CategoricalChart-*.js         274.0 KiB        84.2 KiB   (recharts)
 *   index-*.js                    231.1 KiB        76.1 KiB   (React, the router, the entry)
 *   html2canvas.esm-*.js          196.7 KiB        46.1 KiB
 *   index.es-*.js                 154.9 KiB        51.5 KiB
 *   EditTransactionModal-*.js     120.3 KiB        33.5 KiB
 *   AccountTransactions-*.js       91.0 KiB        27.1 KiB
 *   Categories-*.js                89.1 KiB        27.9 KiB
 *   …and 91 more
 *   ──────────────────────────────────────────────
 *   total                       3,273.1 KiB     1,006.5 KiB
 *
 * THE PREVIOUS BASELINE WAS 259.3 KiB RAW / 86.7 KiB GZIP, and it was a window
 * that mounted a file chooser. This one is the application: 348 modules from the
 * entry, thirty-six routes, every page the web app serves except three that are
 * named and owed. The multiple is 12.6x and it is not a regression — there was
 * nothing here before.
 *
 * ── WHY THE NEW BUDGETS ARE WHERE THEY ARE ──────────────────────────────────
 *
 * ~10% above measured, which is the convention this file already had, and the
 * convention matters more than the number: it is tight enough that the NEXT
 * accidental arrival fails, which is the only job a ratchet has.
 *
 * ── WHAT SHOULD MAKE IT SMALLER, IN ORDER, AND WHY NOT IN THIS SLICE ────────
 *
 * The four biggest chunks are 1,335 KiB — 41% of the renderer — and not one of
 * them is this edition's own code:
 *
 *   xlsx + jspdf + html2canvas   1,062 KiB. Excel and PDF export. All three are
 *                                already lazy, all three are reachable from the
 *                                Export page, and `docs/bundle-optimization-plan
 *                                .md` has had them on the WEB app's list for
 *                                months. Whatever fixes them there fixes them
 *                                here, and doing it here first would be fixing
 *                                the smaller of two identical problems.
 *   recharts                     274 KiB, and the repo's own audit note says the
 *                                web build ships recharts AND chart.js. Picking
 *                                one is a design decision about every chart in
 *                                the product, not a desktop packaging chore.
 *
 * So: measured, recorded, budgeted, and pointed at the slice that should
 * actually do it. Lower these the day one of those lands. Raising them further
 * is allowed and is a decision that belongs in a commit message — not a number
 * quietly nudged until the build goes green.
 *
 * ── RAISED AT SLICE 31, AND WHAT FOR ────────────────────────────────────────
 *
 * 3273.1 → 3924.1 KiB raw, 1006.5 → 1211.2 KiB gzip. That is +651 KiB raw and
 * +205 KiB gzip, and it is THREE WHOLE ROUTES arriving rather than a module
 * turning up by accident — which is the distinction this ratchet exists to draw,
 * so the growth is named here rather than absorbed:
 *
 *   `investments`      the portfolio page and its charts, which the router
 *                      could not mount until holdings went through the seam.
 *   `enhanced-import`  the CSV wizard, and `xlsx` with it — a spreadsheet
 *                      writer this bundle already carried for the Export page,
 *                      now also read by the import side.
 *   `data`             settings ▸ Data, which is where the delete-everything
 *                      button and the restore dialog live.
 *
 * `src/desktop/routes.ts`'s `AWAITING_THE_MOUNT` is now EMPTY, so this is the
 * last increase of this shape there can be: every address the web app serves has
 * a desktop answer, and the next raise would have to be a page that did not
 * exist before.
 *
 * The four biggest chunks are STILL not this edition's own code and the
 * paragraph above still applies unchanged — xlsx, jspdf, html2canvas and
 * recharts are 1,335 KiB of the 3,924, and the slice that fixes them is the
 * web app's.
 *
 * ── RE-RECORDED AFTER THE DESIGN PASS AND THE FX FEATURE ────────────────────
 *
 * 3924.1 → 4070.0 KiB raw, 1211.2 → 1240.6 KiB gzip, measured on a pristine
 * checkout of a2eec741 (#254). +145.9 raw over two merges, and the whole step
 * decomposes with no unexplained remainder — each part was measured by the
 * change that made it, at the time it was made:
 *
 *   #253 (design batches 3–6)   ~125 KiB. The design pass's own components —
 *                               PeriodBar, NetWorthSummary, the skeleton/
 *                               filtered-empty patterns, the register's new
 *                               chrome, the de-carded gallery — plus the token
 *                               sheet's growth in the shared stylesheet.
 *   #254 (cross-currency FX)    ~20 KiB. The rate dialog, the fx arithmetic,
 *                               the cross-currency matchers and the provenance
 *                               line under converted totals.
 *
 * Neither is an accidental arrival; both wear the tokens and both passed the
 * cloud greps on the day. The baseline had simply fallen two merges behind the
 * renderer it describes, which turned the drift figure into a ~146 KiB head
 * start for whatever came next — the exact blindness this file exists to
 * prevent. Budgets unchanged: 4320/1335 now sit ~6–8% above measured, tighter
 * than the ~10% convention, which is the right side to err on.
 *
 * One correction to the standing analysis above: chart.js is GONE — the web
 * bundle work of 2026-08-12 confirmed recharts is the product's only charting
 * library, so "recharts AND chart.js" is history and the recharts 274 KiB is
 * no longer waiting on a consolidation decision, only on a lazy-loading one.
 *
 * ── LOWERED 2026-09-01: THE SPREADSHEET WRITER IS GONE ──────────────────────
 *
 * The first entry here that goes DOWN, and the paragraph above finally has an
 * answer: *"xlsx + jspdf + html2canvas … `docs/bundle-optimization-plan.md` has
 * had them on the WEB app's list for months. Whatever fixes them there fixes
 * them here."* Nothing fixed them there. What happened instead is that the
 * owner ruled the two editions need not offer the same formats —
 *
 *     "Lose excel is fine as long as they can keep csv."   (1 Sep 2026)
 *
 * — so the desktop edition offers CSV and PDF and no .xlsx, and
 * `@spreadsheet` (a build-time alias, `src/editions/spreadsheet.ts`) makes that
 * true of the BUNDLE rather than only of the buttons. A runtime `if` would have
 * removed the button and kept the library: Vite splits `await import('xlsx')`
 * into a chunk whatever surrounds it, and a chunk is not deferred here — it is
 * embedded in the binary by `generate_context!` and sits on the disk of somebody
 * who never presses the button.
 *
 *   measured, 4a95a763 + the eviction, `npm run desktop:ui`:
 *
 *     before   4289.1 KiB raw   1326.2 KiB gzip   (187 + 2 files)
 *     after    3790.5 KiB raw   1163.8 KiB gzip   (187 files)
 *     shed     −498.6 KiB raw   −162.4 KiB gzip   — 11.6% of the renderer
 *
 * Two chunks left: `xlsx-*.js` (488.0 KiB raw / 159.2 gzip, the largest in the
 * bundle by 124 KiB) and `ExcelExport-*.js`, the modal that was its only
 * dedicated caller. `jspdf` is now the largest chunk and it STAYS — PDF is a
 * format this edition keeps.
 *
 * ── AND WHY THE `before` FIGURE IS NOT THE BASELINE ABOVE ───────────────────
 *
 * Because the baseline had fallen behind again. 4070.0 → 4289.1 raw and 1240.6
 * → 1326.2 gzip is +219.1 / +85.6 of ordinary merged work since #254 — which had
 * quietly eaten seven eighths of the headroom, leaving the ratchet 30.9 KiB from
 * failing on whatever landed next. That is the exact blindness the re-record of
 * 2026-08-12 was written to prevent, happening again, which is worth saying out
 * loud: this file's baseline is only useful if it is re-measured on the day the
 * budgets move.
 *
 * ── WHY THE NEW BUDGETS ARE WHERE THEY ARE, AND THAT THEY ARE TIGHT ─────────
 *
 * 3830 / 1176: measured + 39.5 KiB raw (+1.04%) and + 12.2 KiB gzip (+1.05%),
 * which is the headroom that ACTUALLY existed the day before this change (30.9
 * KiB raw, 8.8 KiB gzip), preserved rather than the ~6–10% the paragraphs above
 * quote. The reason is the whole point of a ratchet: shedding 498.6 KiB and
 * leaving the budget at 4320 would have banked the win as 529 KiB of silent
 * permission for the next arrival, and a gate that has to be argued out of
 * permission it never granted is not a gate.
 *
 * The consequence is deliberate and should surprise nobody: the next intended
 * growth of any size FAILS THIS CHECK, and the person who intended it raises
 * these two numbers in the commit that causes it and says what for — exactly as
 * slice 31 did for three routes and as #253/#254 should have. That is the
 * difference between a ratchet and a number that drifts, and it is cheap: it
 * costs one line in a commit that was going to be written anyway.
 *
 * ── RE-RECORDED 2026-10-14: THE OUTLINED IDENTITY ────────────────────────────
 *
 * Two movements, measured separately by building main at ec8b63f on its own:
 *
 *     1 Sep baseline      3790.5 KiB raw   1163.8 KiB gzip
 *     main at ec8b63f     3806.6 KiB raw   1169.8 KiB gzip   +16.1 / +6.0
 *     + the identity      3814.4 KiB raw   1173.4 KiB gzip    +7.8 / +3.6
 *
 * The +16.1 arrived across the PRs since 1 September, every one inside the
 * budget, so none was asked to say what it was — the case this paragraph's
 * predecessor said a ratchet exists to prevent, recorded here so the next
 * reader does not have to rediscover it. The +7.8 is this commit's and is
 * intended: the Reckley lockup as outlined geometry (`design-system/
 * brandIdentity.ts`), drawn by the desktop's two entry screens and by every
 * PDF footer, which is the one place the mark can only exist as paths.
 *
 * Budgets reset to the standing rule, ~1% above measured: 3854 / 1186
 * (+39.6 KiB raw, +1.04%; +12.6 KiB gzip, +1.07%).
 *
 * ── RE-RECORDED 2026-11-05: THE BUDGET CYCLE MODEL ──────────────────────────
 *
 * Three movements, each built on its own with `npm run desktop:ui` and read
 * with `--report`:
 *
 *     14 Oct baseline         3814.4 KiB raw   1173.4 KiB gzip
 *     main at bbae2f4d        3851.9 KiB raw   1185.9 KiB gzip   +37.5 / +12.5
 *     + the cycle model       3855.5 KiB raw   1187.1 KiB gzip    +3.6 /  +1.2
 *
 * The +37.5 arrived across the PRs between 14 Oct and 5 Nov, every one inside
 * the budget, so none was asked to say what it was — the second time this
 * paragraph's predecessor has had to record exactly that, and with 2.1 KiB of
 * raw headroom left it was the next arrival that would fail, whatever it was.
 * The +3.6 is this commit's and is intended: a budget is now an allowance for
 * a cycle anchored on its start (`utils/budgetPeriods`), and the Budget page
 * — which the desktop edition mounts — captions each card with the days it
 * covers, paces it, and totals per rhythm (`utils/budgetPace`).
 *
 * Budgets reset to the standing rule, ~1% above measured: 3894 / 1199
 * (+38.5 KiB raw, +1.00%; +11.9 KiB gzip, +1.00%).
 *
 * ── RE-RECORDED 2026-11-05, SAME DAY: "RUN THESE BUDGETS FROM" ──────────────
 *
 *     + the cycle model       3855.5 KiB raw   1187.1 KiB gzip
 *     + run-from and Starts   3861.3 KiB raw   1188.6 KiB gzip   +5.8 / +1.5
 *
 * Intended: the budget wizard's step 3 asks the day the budgets run from and
 * offers to move the ones it is not changing; the budget editor asks "Starts"
 * and previews the first period. Both are mounted by the desktop edition.
 *
 * Budgets reset to the standing rule, ~1% above measured: 3900 / 1201
 * (+38.7 KiB raw, +1.00%; +12.4 KiB gzip, +1.04%).
 *
 * ── RE-RECORDED 2026-11-05, SAME DAY AGAIN: "MONTHS I CHOOSE" ───────────────
 *
 *     + run-from and Starts   3861.3 KiB raw   1188.6 KiB gzip
 *     + the custom window     3864.1 KiB raw   1189.3 KiB gzip   +2.8 / +0.7
 *
 * Intended: the budget wizard's "Measured over" gains a From and a To month
 * and the summariser learns to clamp a chosen range and state its figures at
 * a rate (`utils/categorySpendSummary`). The wizard is mounted by the desktop
 * edition. Third raise of the day, each the size of the thing it names.
 *
 * Budgets reset to the standing rule, ~1% above measured: 3903 / 1202
 * (+38.9 KiB raw, +1.01%; +12.7 KiB gzip, +1.07%).
 *
 * ── RE-RECORDED 2026-11-05, A FOURTH TIME: "ENDS" AND "ONE-OFF" ─────────────
 *
 *     + the custom window     3864.1 KiB raw   1189.3 KiB gzip
 *     + Ends and One-off      3866.2 KiB raw   1189.8 KiB gzip   +2.1 / +0.5
 *
 * Intended: the budget editor gains "Ends" and the "One-off" period and reads
 * the two days back in a sentence; `utils/budgetPeriods` bounds every period
 * by the end date through one function; the Budget page captions a finished
 * budget and keeps it out of the live total. All desktop surfaces. Fourth
 * raise of the day, each the size of the thing it names.
 *
 * Budgets reset to the standing rule, ~1% above measured: 3905 / 1202
 * (+38.8 KiB raw, +1.00%; +12.2 KiB gzip, +1.03% — the gzip budget holds).
 *
 * ── RE-RECORDED 2026-11-07: THE DASHBOARD'S "KEY BUDGETS" COG ──────────────
 *
 *     + Ends and One-off      3866.2 KiB raw   1189.8 KiB gzip
 *     + Key Budgets           3870.1 KiB raw   1190.2 KiB gzip   +3.9 / +0.4
 *
 * Intended: the Dashboard's budget card gains the cog the key accounts have —
 * a picker grouped by category group, select all / clear all, a filtered
 * empty state, the choice in a portable preference (owner, 7 Nov 2026). The
 * Dashboard is a desktop surface.
 *
 * Budgets reset to the standing rule, ~1% above measured: 3909 / 1202
 * (+38.9 KiB raw, +1.01%; +11.8 KiB gzip, +0.99% — the gzip budget holds).
 *
 * ── RE-RECORDED 2026-11-07, AGAIN: "EVERY…" ─────────────────────────────────
 *
 *     + Key Budgets           3870.1 KiB raw   1190.2 KiB gzip
 *     + Every…                3872.6 KiB raw   1191.0 KiB gzip   +2.5 / +0.8
 *
 * Intended: the budget editor's period list gains "Every…" with a count and a
 * unit, the cycle model an interval of the user's own, the Budget page a
 * rhythm per interval (owner, 7 Nov 2026). All desktop surfaces.
 *
 * Budgets reset to the standing rule, ~1% above measured: 3911 / 1203
 * (+38.4 KiB raw, +0.99%; +12.0 KiB gzip, +1.01%).
 */
const BASELINE_TOTAL_RAW_KIB = 3872.6;
const BASELINE_TOTAL_GZIP_KIB = 1191.0;

// ~1% above measured — see "WHY THE NEW BUDGETS ARE WHERE THEY ARE" above. The
// convention this file inherited was ~10%; the eviction of 2026-09-01 spent that
// slack deliberately rather than banking it, so this is tight ON PURPOSE and
// intended growth is expected to raise it in the commit that causes it.
const MAX_TOTAL_RAW_KIB = Number(process.env.DESKTOP_MAX_TOTAL_RAW_KIB ?? 3911);
const MAX_TOTAL_GZIP_KIB = Number(process.env.DESKTOP_MAX_TOTAL_GZIP_KIB ?? 1203);

const isReport = process.argv.includes('--report');

const say = message => process.stdout.write(`${message}\n`);
const kib = bytes => `${(bytes / 1024).toFixed(1)} KiB`;

const filesUnder = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) filesUnder(full, out);
    else out.push(full);
  }
  return out;
};

if (!fs.existsSync(DIST)) {
  say('');
  say('desktop bundle size — REFUSED');
  say('');
  say(`  There is no build to measure: ${path.relative(REPO, DIST)} does not exist.`);
  say('  Run `npm run desktop:ui` first. This does not skip, because a size gate');
  say('  that passes when there is nothing to weigh reports green on a failed build.');
  say('');
  process.exit(1);
}

const assets = filesUnder(DIST)
  .map(file => {
    const bytes = fs.readFileSync(file);
    return {
      name: path.relative(DIST, file),
      raw: bytes.length,
      gzip: zlib.gzipSync(bytes, { level: 9 }).length
    };
  })
  .sort((a, b) => b.raw - a.raw);

if (assets.length === 0) {
  say('');
  say('desktop bundle size — REFUSED');
  say('');
  say(`  ${path.relative(REPO, DIST)} exists but is empty. The build did not emit anything.`);
  say('');
  process.exit(1);
}

const totalRaw = assets.reduce((sum, asset) => sum + asset.raw, 0);
const totalGzip = assets.reduce((sum, asset) => sum + asset.gzip, 0);
const largest = assets[0];

const drift = (measuredKib, baselineKib) => {
  const delta = measuredKib - baselineKib;
  if (Math.abs(delta) < 0.05) return 'on baseline';
  return `${delta > 0 ? '+' : ''}${delta.toFixed(1)} KiB vs baseline ${baselineKib} KiB`;
};

say('');
say('desktop renderer size — the bytes the binary embeds');
say('');
say(`  bundle            ${path.relative(REPO, DIST)}`);
say(`  files             ${assets.length}`);
say(`  largest           ${kib(largest.raw)} raw  ${largest.name}`);
say('');
say(`  total raw         ${kib(totalRaw).padStart(10)}   budget ${MAX_TOTAL_RAW_KIB} KiB   ${drift(totalRaw / 1024, BASELINE_TOTAL_RAW_KIB)}`);
say(`  total gzip        ${kib(totalGzip).padStart(10)}   budget ${MAX_TOTAL_GZIP_KIB} KiB   ${drift(totalGzip / 1024, BASELINE_TOTAL_GZIP_KIB)}`);

if (isReport) {
  say('');
  say('  per file (raw / gzip)');
  for (const asset of assets) {
    say(`    ${kib(asset.raw).padStart(10)}  ${kib(asset.gzip).padStart(10)}  ${asset.name}`);
  }
}

say('');
if (fs.existsSync(BINARY)) {
  const bytes = fs.statSync(BINARY).size;
  // MiB, to match the KiB above. The README's "16 MB" was the same bytes in
  // decimal units; both are printed so neither reading looks like a regression.
  say(
    `  binary            ${(bytes / 1024 / 1024).toFixed(1)} MiB ` +
      `(${(bytes / 1e6).toFixed(1)} MB)  ${path.relative(REPO, BINARY)}`
  );
  say('                    recorded, never gated — its size is a function of the');
  say('                    toolchain and the platform, so two machines disagree');
  say('                    without either of them having regressed.');
} else {
  say('  binary            not built here (npm run desktop:build) — nothing to record.');
  say('                    This is not a failure: the renderer is what this gate weighs.');
}

const failures = [];
if (totalRaw > MAX_TOTAL_RAW_KIB * 1024) {
  failures.push(
    `total raw ${kib(totalRaw)} exceeds budget ${MAX_TOTAL_RAW_KIB} KiB.\n` +
      '    Raw is the gate here because nothing is downloaded: these bytes are\n' +
      '    embedded in the binary and parsed when the window opens.'
  );
}
if (totalGzip > MAX_TOTAL_GZIP_KIB * 1024) {
  failures.push(`total gzip ${kib(totalGzip)} exceeds budget ${MAX_TOTAL_GZIP_KIB} KiB.`);
}

say('');
if (failures.length > 0) {
  say('FAIL  the desktop renderer grew past its ratchet');
  say('');
  for (const failure of failures) say(`  - ${failure}`);
  say('');
  say('  If a module arrived by accident, `npm run desktop:ui` names it: build with');
  say('  the renderer config and read what the 59-module graph turned into.');
  say('  If the growth is intended, raise the budget in this file deliberately and');
  say('  say why in the commit — that is the whole difference between a ratchet and');
  say('  a number that drifts.');
  say('');
  process.exit(1);
}
say('PASS  the desktop renderer is within its ratchet');
say('');
