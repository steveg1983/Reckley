/**
 * The shell's renderer build.
 *
 * A config of its own rather than a mode on the root one: the two builds share
 * no entry and no output, and the WEB build's output is compared byte for byte
 * between slices. Anything that could change the root build's graph is a change
 * to that comparison.
 *
 * `root` is `src/desktop`, where the renderer's `index.html` is — the renderer
 * lives inside this repo's lint, typecheck and test roots on purpose, and
 * `src/services/local/deviceDocument.ts`'s header gives the reason. `outDir` is
 * `apps/desktop/dist`, which is what `src-tauri/tauri.conf.json` names as
 * `frontendDist`, so `tauri::generate_context!` embeds exactly what this writes
 * and `cargo build` needs this to have been run first.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const REPO = path.resolve(__dirname, '..', '..');

/**
 * The version the Settings card says (7 Nov 2026), read from the one field the
 * native About box, the updater's comparison and the release tag all read,
 * rather than from a copy of it. Refuses to build without one: a card that
 * silently dropped its version would look exactly like a build with no stamp.
 * See src/lib/appRelease.ts.
 */
const TAURI_VERSION: unknown = JSON.parse(
  readFileSync(path.join(__dirname, 'src-tauri', 'tauri.conf.json'), 'utf8')
).version;
if (typeof TAURI_VERSION !== 'string' || TAURI_VERSION === '') {
  throw new Error('apps/desktop/vite.config.ts: src-tauri/tauri.conf.json has no "version" to stamp');
}

export default defineConfig({
  root: path.join(REPO, 'src', 'desktop'),
  base: './',
  plugins: [react()],
  define: {
    __RECKLEY_RELEASE__: JSON.stringify({ kind: 'version', value: TAURI_VERSION })
  },
  resolve: {
    alias: {
      // THE EDITION SEAM, pointed at the engine a FILE provides. The web build
      // points the same specifier at `services/port/index.ts` (DataService).
      // Neither bundle contains the other's engine because neither bundle's
      // graph can reach it — which is the only way both greps below can pass.
      // See docs/edition-gating.md.
      '@data': path.join(REPO, 'src', 'services', 'local', 'deviceDataPort'),
      // THE MOUNT SLICE'S FOUR, pointed at what a device answers: the open
      // ledger's name where a browser has a sign-out menu, the file's own owner
      // where it has a signed-in user, nothing where it has a bank feed and a
      // demo banner, the file's own settings where it has a `user_preferences`
      // row, and this machine's console where it has Sentry.
      '@chrome': path.join(REPO, 'src', 'desktop', 'editions', 'chrome'),
      '@identity': path.join(REPO, 'src', 'desktop', 'editions', 'identity'),
      '@prefs-store': path.join(REPO, 'src', 'desktop', 'editions', 'preferencesStore'),
      '@rules-store': path.join(REPO, 'src', 'desktop', 'editions', 'rulesStore'),
      '@telemetry': path.join(REPO, 'src', 'desktop', 'editions', 'telemetry'),
      // THE MOUNT SLICE'S SECOND HALF, pointed at what a device answers: a
      // preamble that already happened when the file was opened, and three
      // absences where a browser has a subscription card, a bank feed's refresh
      // schedule and a delete-my-account button.
      '@session': path.join(REPO, 'src', 'desktop', 'editions', 'session'),
      '@service': path.join(REPO, 'src', 'desktop', 'editions', 'service'),
      // AND THE ONE THAT IS PURELY ABOUT WEIGHT (1 Sep 2026). The web half
      // reaches `xlsx` — 488 KiB raw, the largest chunk this renderer used to
      // build. This half reaches no spreadsheet writer at all, so none is built,
      // which is the only way to shed it: `generate_context!` embeds every file
      // in `dist` into the binary, so a "lazy" chunk is not deferred here, it is
      // simply bytes on a buyer's disk. Owner's ruling: "lose excel is fine as
      // long as they can keep csv".
      '@spreadsheet': path.join(REPO, 'src', 'desktop', 'editions', 'spreadsheet'),
      '@app-types': path.join(REPO, 'src', 'types')
    }
  },
  build: {
    outDir: path.join(__dirname, 'dist'),
    emptyOutDir: true,
    // Safari 15 is the floor for WKWebView on the macOS versions this targets.
    target: 'safari15'
  },
  server: {
    // The dev server the shell points at when it is run with `tauri dev`.
    port: 5174,
    strictPort: true,
    // The renderer's root is `src/desktop`, and it imports the seam from
    // `src/services`. A dev server refuses to serve outside its root unless it
    // is told the repository is one project, which it is.
    fs: { allow: [REPO] }
  }
});
