/**
 * The app speaks one English, and it is the one its dates are in.
 *
 * ── WHY THIS IS A TEST AND NOT A STYLE NOTE ─────────────────────────────────
 *
 * Every date this app prints is dd/mm/yyyy and every amount is in pounds —
 * `utils/dateFormatter` hard-codes `en-GB` and `isUKDateFormat()` returns a
 * literal `true`, so there is no US edition to be consistent WITH. The copy had
 * drifted anyway: "Uncategorised" in the payee reports and the category name
 * lookup, "Uncategorized" in CategoryContext, the category dropdown, the search
 * results and the QIF export — two spellings of one word, both reachable from
 * the same screen, under dates that could only be British.
 *
 * A sweep fixes that once. This fixes it for good, because the failure mode is
 * not ignorance, it is that `Uncategorized` looks completely correct to
 * whoever types it next.
 *
 * ── WHAT IT DOES AND DOES NOT CLAIM ─────────────────────────────────────────
 *
 * It reads the copy — quoted strings and JSX text in the components, pages and
 * contexts — and looks for a short list of words that Britain and America spell
 * differently AND that this app actually says. It is not a dictionary and does
 * not pretend to be: `color`, `center` and `behavior` are absent from the list
 * on purpose, because in a React codebase they are overwhelmingly CSS
 * properties and Tailwind classes, and a guard that cries wolf gets deleted.
 *
 * IDENTIFIERS ARE NOT COPY. `BulkCategorizeModal`, `normalizePayee` and
 * `applyCategoryToUncategorized` are names, and renaming them would be churn
 * with no reader. Only what a person can read on screen is in scope, so import
 * lines, module paths and hyphenated/underscored tokens (`data-testid`s, storage
 * keys) are skipped.
 *
 * ── IF A US EDITION EVER SHIPS ──────────────────────────────────────────────
 *
 * The owner's ask was "if they choose US dates, the spelling should follow".
 * There is nothing to follow today — no such choice exists — and building a
 * branch nobody can reach would be worse than not building it. When that choice
 * arrives, this file is the inventory of every word that has to move, and
 * `UNCATEGORISED_LABEL` is the shape the rest should take: one constant, read
 * everywhere, switched in one place.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** Where a user can read words. Services and utils are swept via their callers. */
const COPY_ROOTS = ['src/components', 'src/pages', 'src/contexts'];

/**
 * The words this app says that the two Englishes spell differently.
 *
 * Each is a stem plus whatever endings we actually use, so `Categorize` and
 * `Categorizing` are both caught by one entry.
 */
const US_SPELLINGS: { pattern: RegExp; uk: string }[] = [
  { pattern: /\b(un)?categoriz(e|es|ed|ing|ation)?\b/i, uk: 'categorise / uncategorised' },
  { pattern: /\banalyz(e|es|ed|ing|er)?\b/i, uk: 'analyse' },
  { pattern: /\bcustomiz(e|es|ed|ing|ation)?\b/i, uk: 'customise' },
  { pattern: /\borganiz(e|es|ed|ing|ation)?\b/i, uk: 'organise' },
  { pattern: /\bpersonaliz(e|es|ed|ing|ation)?\b/i, uk: 'personalise' },
  { pattern: /\boptimiz(e|es|ed|ing|ation)?\b/i, uk: 'optimise' },
  // The owner, 12 Nov 2026, of the reconcile screen's button: "'Finalize' —
  // isn't that the American spelling?" It was, in ten places.
  { pattern: /\bfinaliz(e|es|ed|ing|ation)?\b/i, uk: 'finalise' },
  { pattern: /\bfavorite(s)?\b/i, uk: 'favourite' },
  { pattern: /\bcancel(ed|ing)\b/i, uk: 'cancelled / cancelling' },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Strip what a user never reads: comments (including the multi-line ones this
 * codebase is full of, whose middle lines start with prose rather than a `*`)
 * and diagnostic logging.
 *
 * Returns the file as lines, with non-copy blanked rather than removed, so the
 * line numbers this test reports are the line numbers in the editor.
 */
function readableLines(source: string): string[] {
  let inBlock = false;
  return source.split('\n').map(raw => {
    let line = raw;
    if (inBlock) {
      const close = line.indexOf('*/');
      if (close === -1) return '';
      line = line.slice(close + 2);
      inBlock = false;
    }
    const open = line.indexOf('/*');
    if (open !== -1) {
      const close = line.indexOf('*/', open + 2);
      if (close === -1) {
        inBlock = true;
        line = line.slice(0, open);
      } else {
        line = line.slice(0, open) + line.slice(close + 2);
      }
    }
    const lineComment = line.indexOf('//');
    if (lineComment !== -1) line = line.slice(0, lineComment);
    // A message to a console is a message to us.
    if (/\b(console|logger|log)\.[a-z]+\(/.test(line)) return '';
    // Imports and module paths are addresses, not sentences.
    if (/^\s*import\b/.test(line) || /\bfrom\s+['"]/.test(line)) return '';
    return line;
  });
}

/**
 * The readable words on one line: quoted strings and JSX text.
 *
 * A quoted string counts as COPY only if it is a phrase (has a space) or is
 * capitalised. A bare lowercase token — `'uncategorized'`, `'canceled'` — is an
 * identifier: a union member, a Stripe status, a storage key. Those are names,
 * and this codebase has a settled rule that names are not copy; changing them
 * would be churn with no reader, and `'canceled'` in particular is Stripe's own
 * API value, which we compare against. JSX text has no such ambiguity — if it
 * sits between the tags, someone reads it.
 */
function copyOn(line: string): string[] {
  const found: string[] = [];
  // The last two alternatives are what catch a sentence WRAPPED across lines —
  // `<p>` on one line, the sentence on the next. Missing those is how "new
  // optimization opportunities" survived the first pass of this very test.
  // `(?<!=)` keeps an arrow function from reading as a JSX tag: without it,
  // `row => classifyFlow(row) === 'uncategorized'` is "text after a >".
  for (const match of line.matchAll(/'([^'\\]*)'|"([^"\\]*)"|(?<!=)>([^<>{}]+)<|(?<!=)>([^<>{}=]+)$|^([^<>{}=]+)</g)) {
    const quoted = match[1] ?? match[2];
    const text = (quoted ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
    if (text.length === 0) continue;
    if (quoted !== undefined && !/\s/.test(text) && !/^[A-Z]/.test(text)) continue;
    // A hyphenated or underscored token is a key, a class or a test id.
    if (/^[\w-]*[-_][\w-]*$/.test(text)) continue;
    found.push(text);
  }
  // A line that is nothing but words is JSX text wrapped onto its own line —
  // `<button …>` above, `</button>` below. None of the alternatives above sees
  // it, which is how "Finalize Reconciliation" stood on the reconcile screen's
  // main button, unreported, until the owner read it there (12 Nov 2026). It
  // must be a phrase: one bare word on a line is an import or an enum member.
  const bare = line.trim();
  if (/^[A-Z][A-Za-z]*( [A-Za-z’'.,…-]+)+$/.test(bare)) found.push(bare);
  return found;
}

describe('the app speaks British English, like its dates', () => {
  const files = COPY_ROOTS.flatMap(root => sourceFiles(resolve(process.cwd(), root)));

  it('has copy to read at all (the guard is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('says no American spelling that Britain spells differently', () => {
    const offences: string[] = [];

    for (const file of files) {
      const lines = readableLines(readFileSync(file, 'utf8'));
      lines.forEach((line, index) => {
        for (const text of copyOn(line)) {
          for (const { pattern, uk } of US_SPELLINGS) {
            const hit = text.match(pattern);
            if (hit === null) continue;
            // `-ise` spellings match none of the patterns above; only the `-ize`
            // family and the two irregulars reach here.
            offences.push(
              `${file.replace(process.cwd() + '/', '')}:${index + 1} — "${hit[0]}" (use ${uk})`
            );
          }
        }
      });
    }

    expect(offences).toEqual([]);
  });

  it('declares one spelling of the word for a row with no category', () => {
    // The specific drift that prompted this: two spellings, both on screen.
    const lookup = readFileSync(resolve(process.cwd(), 'src/utils/categoryNames.ts'), 'utf8');
    expect(lookup).toContain("UNCATEGORISED_LABEL = 'Uncategorised'");
  });

  it('tells the browser which English, so its own spellchecker agrees', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    expect(html).toMatch(/<html lang="en-GB"/);
  });
});
