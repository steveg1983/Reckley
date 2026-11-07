/**
 * Which build this is, in the words the About card on /settings uses.
 *
 * Until 7 Nov 2026 that card said "Version 1.0" in both editions, as literal
 * text: written once in August and true of neither. The desktop window showing
 * it was 0.1.6 (the native About box said so beside it), and the web app has no
 * version number at all, because it deploys on every merge.
 *
 * So each build stamps in what it actually is, and nothing here guesses:
 *
 *   desktop  `{ kind: 'version' }`: `tauri.conf.json`'s version, the field the
 *            native About box, the updater's comparison and the release tag all
 *            read. Stamped by `apps/desktop/vite.config.ts`.
 *   web      `{ kind: 'build' }`: the deployed commit, short form, from Vercel's
 *            VERCEL_GIT_COMMIT_SHA at build time. Stamped by `vite.config.ts`.
 *            A commit is the web's one honest identity: there is no release to
 *            number, and a number nobody bumps is the bug being fixed.
 *   neither  `null`: a local build or a test run, where nothing stamped it. The
 *            card then says nothing, rather than a number nobody chose.
 *
 * A Vite `define` rather than an edition seam, because this is a fact about the
 * BUILD rather than a behaviour that differs by edition, and each build already
 * knows it. Seams choose what code runs; this chooses one string.
 */

/** Replaced by Vite's `define` at build time; absent wherever nothing defined it. */
declare const __RECKLEY_RELEASE__: AppRelease | undefined;

export type AppRelease =
  | { readonly kind: 'version'; readonly value: string }
  | { readonly kind: 'build'; readonly value: string }
  | null;

/** What this build was stamped with, or null when it was not stamped. */
export function currentRelease(): AppRelease {
  // `typeof` first: a test run, or any tool that loads this module without the
  // `define`, has no such global, and a bare read of one throws.
  return typeof __RECKLEY_RELEASE__ === 'undefined' ? null : __RECKLEY_RELEASE__;
}

/** The line under the product name, or null for no line at all. */
export function releaseLine(release: AppRelease = currentRelease()): string | null {
  if (!release?.value) return null;
  return release.kind === 'version' ? `Version ${release.value}` : `Build ${release.value}`;
}
